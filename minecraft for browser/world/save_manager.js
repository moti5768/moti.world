"use strict";
import { getRawBlockId, getRawLocalState, packRawBlock } from '../blockstate.js';
import { idToKey, keyToId } from '../blocks.js';

/* ======================================================
   【保存システム】IndexedDB Manager (world/save_manager.js)
   - パレット＋RLE バイナリ圧縮（blocks.js の ID 順変更耐性あり）
   - 編集チャンク限定・差分セーブ・アトミック置換
   - 旧セーブ形式 (v1 文字列/配列/Uint16) からの自動マイグレーション読込対応
   ====================================================== */

const DB_CONFIG = { name: "MinecraftJS_Save", version: 1 };
const SAVE_FORMAT_VERSION = 2;
const TOTAL_CELLS = 16 * 256 * 16; // 65536

let _cachedDBPromise = null;

// --- ゼロGC パレット＋RLE バイナリエンコーダ用再利用バッファ ---
const _rleValToPal = new Int32Array(65536).fill(-1);
const _rleUsedVals = new Uint16Array(4096);
const _rleScratch = new Uint16Array(TOTAL_CELLS * 2);

export function generateWorldUid() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * DB接続をキャッシュ付きで取得する（接続リーク防止＆バージョン変更時の自動再接続）
 */
async function getDB() {
    if (_cachedDBPromise) return _cachedDBPromise;

    _cachedDBPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("world_meta")) {
                db.createObjectStore("world_meta");
            }
            if (!db.objectStoreNames.contains("chunks")) {
                db.createObjectStore("chunks");
            }
        };

        request.onsuccess = (e) => {
            const db = e.target.result;
            db.onversionchange = () => {
                db.close();
                _cachedDBPromise = null;
            };
            db.onclose = () => {
                _cachedDBPromise = null;
            };
            resolve(db);
        };

        request.onerror = () => {
            _cachedDBPromise = null;
            reject(request.error || new Error("IndexedDBのオープンに失敗しました"));
        };
    });

    return _cachedDBPromise;
}

/**
 * チャンク Uint16Array(65536) を「文字列キーパレット配列 + Uint16Array RLE」へ高速圧縮する
 */
function encodeChunkPaletteRLE(dataArray) {
    const len = dataArray.length;
    const palette = [];
    let palCount = 0;
    let rlePtr = 0;

    let i = 0;
    while (i < len) {
        const val = dataArray[i];
        let palIdx = _rleValToPal[val];
        if (palIdx === -1) {
            palIdx = palCount++;
            _rleValToPal[val] = palIdx;
            if (palIdx < _rleUsedVals.length) {
                _rleUsedVals[palIdx] = val;
            }
            const id = getRawBlockId(val);
            const meta = getRawLocalState(val);
            palette.push(idToKey(id) + ":" + meta);
        }

        // Uint16 上限(65535)を超えない範囲で同一ブロック状態の連続長を集約
        let runLen = 1;
        while (i + runLen < len && runLen < 65535 && dataArray[i + runLen] === val) {
            runLen++;
        }

        _rleScratch[rlePtr++] = palIdx;
        _rleScratch[rlePtr++] = runLen;
        i += runLen;
    }

    // 使用済みインデックスのみ -1 に戻す（O(ユニークブロック状態数)）
    if (palCount <= _rleUsedVals.length) {
        for (let k = 0; k < palCount; k++) {
            _rleValToPal[_rleUsedVals[k]] = -1;
        }
    } else {
        _rleValToPal.fill(-1);
    }

    return {
        v: SAVE_FORMAT_VERSION,
        len,
        palette,
        rle: _rleScratch.slice(0, rlePtr)
    };
}

/**
 * DB上の現在の world_uid を読み取り、全量クリア置換か差分更新かを安全に判定する
 */
async function readStoredWorldUid(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["world_meta"], "readonly");
        const req = tx.objectStore("world_meta").get("world_uid");
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * ワールドデータの保存（パレット＋RLEバイナリ圧縮・編集チャンク限定・差分セーブ・アトミック置換）
 */
export async function saveWorldData({
    seed,
    playerPos,
    chunkManager,
    gameTime,
    worldUid = null,
    isAlreadySaved = false,
    playerState = null,
    simulationState = null,
    worldEntitiesState = null
}) {
    const startTime = performance.now();
    const db = await getDB();
    const activeWorldUid = worldUid || generateWorldUid();

    // 1. DB上のワールドIDと照合し、新規ワールド（別ID）なら旧チャンクをクリアして全量保存、同一IDなら差分のみ保存
    const storedUid = await readStoredWorldUid(db);
    const isFullReplace = !isAlreadySaved || (storedUid !== activeWorldUid);

    const targetKeys = isFullReplace
        ? chunkManager.playerModifiedKeys
        : chunkManager.dirtySaveKeys;

    // 2. IndexedDB トランザクション開始前に CPU エンコードを全件完了（ロック時間を最小化）
    const encodedEntries = [];
    let totalBytes = 0;

    if (chunkManager && targetKeys && targetKeys.size > 0) {
        for (const key of targetKeys) {
            const dataArray = chunkManager.modifiedChunks.get(key);
            if (!dataArray) continue;

            const payload = encodeChunkPaletteRLE(dataArray);
            encodedEntries.push({ keyStr: key.toString(), payload });
            totalBytes += payload.rle.byteLength + payload.palette.length * 16;
        }
    }

    // 3. 単一 readwrite トランザクション内でメタ＋チャンクをアトミック保存
    await new Promise((resolve, reject) => {
        const tx = db.transaction(["world_meta", "chunks"], "readwrite");
        const metaStore = tx.objectStore("world_meta");
        const chunkStore = tx.objectStore("chunks");

        if (isFullReplace) {
            // 新規ワールド保存時は前ワールドの古いチャンクを同一トランザクション内で一掃
            chunkStore.clear();
        }

        metaStore.put(SAVE_FORMAT_VERSION, "save_version");
        metaStore.put(activeWorldUid, "world_uid");
        metaStore.put(seed, "last_seed");
        metaStore.put(playerPos, "player_pos");
        metaStore.put(gameTime, "game_time");
        metaStore.put(Date.now(), "saved_at");
        if (playerState) {
            metaStore.put(playerState, "player_state");
        }
        if (simulationState) {
            metaStore.put(simulationState, "simulation_state");
        }
        if (worldEntitiesState) {
            metaStore.put(worldEntitiesState, "world_entities_state");
        }

        for (let i = 0; i < encodedEntries.length; i++) {
            const entry = encodedEntries[i];
            chunkStore.put(entry.payload, entry.keyStr);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IndexedDBトランザクションエラー"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDBトランザクションが中断されました"));
    });

    // 4. コミット成功確定後に差分セットをクリア
    if (chunkManager && chunkManager.dirtySaveKeys) {
        chunkManager.dirtySaveKeys.clear();
    }

    return {
        worldUid: activeWorldUid,
        mode: isFullReplace ? "FullReplace/v2-RLE" : "IncrementalDiff/v2-RLE",
        savedChunks: encodedEntries.length,
        totalBytes,
        elapsedMs: performance.now() - startTime
    };
}

/**
 * ワールドデータの読み込み（保存時の文字列キーを現在の最新IDにマッピングし直す）
 */
export async function loadFullSaveData() {
    const db = await getDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(["world_meta", "chunks"], "readonly");
        const metaStore = tx.objectStore("world_meta");
        const chunkStore = tx.objectStore("chunks");

        const reqSeed = metaStore.get("last_seed");
        const reqPos = metaStore.get("player_pos");
        const reqTime = metaStore.get("game_time");
        const reqWorldUid = metaStore.get("world_uid");
        const reqPlayerState = metaStore.get("player_state");
        const reqSimState = metaStore.get("simulation_state");
        const reqWorldEntitiesState = metaStore.get("world_entities_state");
        const reqKeys = chunkStore.getAllKeys();
        const reqValues = chunkStore.getAll();

        tx.oncomplete = () => {
            if (reqSeed.result === undefined) {
                resolve(null);
                return;
            }

            const chunks = new Map();
            const keys = reqKeys.result || [];
            const values = reqValues.result || [];
            const _keyToId = keyToId;

            for (let i = 0, len = keys.length; i < len; i++) {
                const chunkKey = Number(keys[i]);
                if (!Number.isFinite(chunkKey)) continue;

                const chunkData = values[i];
                if (!chunkData) continue;

                // 常に TOTAL_CELLS (65536) 要素の Uint16Array に正規化し、不完全チャンクによる描画異常を防ぐ
                const numericBlocks = new Uint16Array(TOTAL_CELLS);
                let hasValidData = false;

                // 0. v2 パレット＋RLEバイナリ圧縮形式 ({ v: 2, len, palette, rle })
                if (chunkData.v === 2 && Array.isArray(chunkData.palette) && chunkData.rle) {
                    const pal = chunkData.palette;
                    const palLen = pal.length;
                    const palPacked = new Uint16Array(palLen);
                    for (let p = 0; p < palLen; p++) {
                        const entry = String(pal[p] || "");
                        const parts = entry.split(":");
                        const id = _keyToId(parts[0]);
                        const meta = parseInt(parts[1], 10) || 0;
                        palPacked[p] = packRawBlock(id, meta);
                    }

                    const rle = chunkData.rle;
                    const rLen = rle.length & ~1; // 偶数ペア長に安全丸め
                    let dst = 0;
                    for (let r = 0; r < rLen && dst < TOTAL_CELLS; r += 2) {
                        const palIdx = rle[r];
                        const count = rle[r + 1];
                        if (count <= 0) continue;
                        const packedVal = (palIdx >= 0 && palIdx < palLen) ? palPacked[palIdx] : 0;
                        const end = (dst + count <= TOTAL_CELLS) ? (dst + count) : TOTAL_CELLS;
                        numericBlocks.fill(packedVal, dst, end);
                        dst = end;
                    }
                    hasValidData = true;
                }
                // 1. 旧・文字列パレット形式 ({ s: "stone:0,..." })
                else if (typeof chunkData.s === "string") {
                    const blockStrings = chunkData.s.split(",");
                    const bLen = Math.min(blockStrings.length, TOTAL_CELLS);

                    for (let j = 0; j < bLen; j++) {
                        const parts = blockStrings[j].split(":");
                        const id = _keyToId(parts[0]);
                        const meta = parseInt(parts[1], 10) || 0;
                        numericBlocks[j] = packRawBlock(id, meta);
                    }
                    hasValidData = true;
                }
                // 2. 旧・オブジェクト配列形式 ({ blocks: [{k,m}, ...] })
                else if (Array.isArray(chunkData.blocks)) {
                    const blocks = chunkData.blocks;
                    const bLen = Math.min(blocks.length, TOTAL_CELLS);

                    if (bLen > 0) {
                        const firstItem = blocks[0];
                        const isObjMode = (firstItem !== null && typeof firstItem === 'object');

                        for (let j = 0; j < bLen; j++) {
                            const item = blocks[j];
                            if (isObjMode && item) {
                                const id = _keyToId(item.k);
                                const meta = item.m ?? 0;
                                numericBlocks[j] = packRawBlock(id, meta);
                            } else {
                                numericBlocks[j] = packRawBlock(_keyToId(item), 0);
                            }
                        }
                    }
                    hasValidData = true;
                }
                // 3. 旧・直接Uint16Array形式（旧4bit形式から16bitグローバル状態へ自動変換）
                else if (chunkData instanceof Uint16Array) {
                    const bLen = Math.min(chunkData.length, TOTAL_CELLS);
                    for (let j = 0; j < bLen; j++) {
                        const oldVal = chunkData[j];
                        numericBlocks[j] = packRawBlock(oldVal & 0xFFF, (oldVal >> 12) & 0xF);
                    }
                    hasValidData = true;
                }

                if (hasValidData) {
                    chunks.set(chunkKey, numericBlocks);
                }
            }

            resolve({
                seed: reqSeed.result,
                pos: reqPos.result ?? null,
                gameTime: reqTime.result ?? 6000,
                worldUid: reqWorldUid.result ?? null,
                playerState: reqPlayerState.result ?? null,
                simulationState: reqSimState.result ?? null,
                worldEntitiesState: reqWorldEntitiesState.result ?? null,
                chunks: chunks
            });
        };

        tx.onerror = () => reject(tx.error || new Error("セーブデータの読み込みに失敗しました"));
        tx.onabort = () => reject(tx.error || new Error("セーブデータの読み込みが中断されました"));
    });
}