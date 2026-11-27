"use strict";
import { getRawBlockId, getRawLocalState, packRawBlock } from '../blockstate.js';
import { idToKey, keyToId } from '../blocks.js';

/* ======================================================
   【保存システム】複数ワールド対応 IndexedDB Manager (world/save_manager.js)
   - 複数ワールド管理（一覧取得・作成・読込・名前変更・削除）
   - パレット＋RLE バイナリ圧縮（blocks.js の ID 順変更耐性あり）
   - 編集チャンク限定・ワールド単位の差分セーブ・ディメンション分離対応
   - 旧単一セーブ形式 (v1: world_meta / chunks) からの自動マイグレーション対応
   ====================================================== */

const DB_CONFIG = { name: "MinecraftJS_Save", version: 2 };
const SAVE_FORMAT_VERSION = 2;
const TOTAL_CELLS = 16 * 256 * 16; // 65536
const DEFAULT_DIMENSION = "overworld";

let _cachedDBPromise = null;
let _legacyMigratePromise = null;

// --- ゼロGC パレット＋RLE バイナリエンコーダ用再利用バッファ ---
const _rleValToPal = new Int32Array(65536).fill(-1);
const _rleUsedVals = new Uint16Array(4096);
const _rleScratch = new Uint16Array(TOTAL_CELLS * 2);

export function generateWorldUid() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeWorldChunkId(worldUid, dimension, chunkKey) {
    return `${worldUid}|${dimension || DEFAULT_DIMENSION}|${chunkKey}`;
}

/**
 * DB接続をキャッシュ付きで取得する（接続リーク防止＆バージョン変更時の自動再接続）
 */
async function openRawDB() {
    if (_cachedDBPromise) return _cachedDBPromise;

    _cachedDBPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("worlds")) {
                db.createObjectStore("worlds", { keyPath: "worldUid" });
            }
            if (!db.objectStoreNames.contains("world_chunks")) {
                const chunkStore = db.createObjectStore("world_chunks", { keyPath: "id" });
                chunkStore.createIndex("by_world", "worldUid", { unique: false });
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
 * 旧バージョン(v1)の単一セーブデータが存在する場合、自動的に v2 複数ワールドストアへ移行する
 */
async function ensureLegacyMigrated(db) {
    if (_legacyMigratePromise) return _legacyMigratePromise;

    _legacyMigratePromise = (async () => {
        if (!db.objectStoreNames.contains("world_meta") || !db.objectStoreNames.contains("chunks")) {
            return;
        }

        const legacy = await new Promise((resolve, reject) => {
            const tx = db.transaction(["world_meta", "chunks"], "readonly");
            const metaStore = tx.objectStore("world_meta");
            const chunkStore = tx.objectStore("chunks");

            const reqMigrated = metaStore.get("migrated_v2");
            const reqSeed = metaStore.get("last_seed");
            const reqPos = metaStore.get("player_pos");
            const reqTime = metaStore.get("game_time");
            const reqWorldUid = metaStore.get("world_uid");
            const reqSavedAt = metaStore.get("saved_at");
            const reqPlayerState = metaStore.get("player_state");
            const reqSimState = metaStore.get("simulation_state");
            const reqWorldEntitiesState = metaStore.get("world_entities_state");
            const reqKeys = chunkStore.getAllKeys();
            const reqValues = chunkStore.getAll();

            tx.oncomplete = () => {
                if (reqMigrated.result === true || reqSeed.result === undefined) {
                    resolve(null);
                    return;
                }
                resolve({
                    seed: reqSeed.result,
                    pos: reqPos.result ?? null,
                    gameTime: reqTime.result ?? 6000,
                    worldUid: reqWorldUid.result || generateWorldUid(),
                    savedAt: reqSavedAt.result || Date.now(),
                    playerState: reqPlayerState.result ?? null,
                    simulationState: reqSimState.result ?? null,
                    worldEntitiesState: reqWorldEntitiesState.result ?? null,
                    keys: reqKeys.result || [],
                    values: reqValues.result || []
                });
            };
            tx.onerror = () => reject(tx.error);
        });

        if (!legacy) return;

        await new Promise((resolve, reject) => {
            const tx = db.transaction(["world_meta", "chunks", "worlds", "world_chunks"], "readwrite");
            const metaStore = tx.objectStore("world_meta");
            const oldChunkStore = tx.objectStore("chunks");
            const worldsStore = tx.objectStore("worlds");
            const newChunkStore = tx.objectStore("world_chunks");

            let chunkCount = 0;
            for (let i = 0; i < legacy.keys.length; i++) {
                const cKey = Number(legacy.keys[i]);
                const payload = legacy.values[i];
                if (!Number.isFinite(cKey) || !payload) continue;
                newChunkStore.put({
                    id: makeWorldChunkId(legacy.worldUid, DEFAULT_DIMENSION, cKey),
                    worldUid: legacy.worldUid,
                    dimension: DEFAULT_DIMENSION,
                    chunkKey: cKey,
                    payload
                });
                chunkCount++;
            }

            const restoredGameMode = legacy.worldEntitiesState?.playerData?.gameMode || "creative";
            worldsStore.put({
                worldUid: legacy.worldUid,
                name: "保存済みの世界",
                seed: legacy.seed,
                gameMode: restoredGameMode,
                dimension: DEFAULT_DIMENSION,
                pos: legacy.pos,
                gameTime: legacy.gameTime,
                playerState: legacy.playerState,
                simulationState: legacy.simulationState,
                worldEntitiesState: legacy.worldEntitiesState,
                createdAt: legacy.savedAt,
                savedAt: legacy.savedAt,
                chunkCount,
                saveVersion: SAVE_FORMAT_VERSION
            });

            metaStore.put(true, "migrated_v2");
            oldChunkStore.clear();

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("旧セーブ移行に失敗しました"));
            tx.onabort = () => reject(tx.error || new Error("旧セーブ移行が中断されました"));
        });
    })();

    try {
        await _legacyMigratePromise;
    } catch (err) {
        _legacyMigratePromise = null;
        throw err;
    }
}

async function getDB() {
    const db = await openRawDB();
    await ensureLegacyMigrated(db);
    return db;
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
 * 保存済みチャンクペイロード（v2 RLE / 旧v1各種形式）を Uint16Array(65536) へ復号する
 */
function decodeChunkPayload(chunkData) {
    if (!chunkData) return null;

    const numericBlocks = new Uint16Array(TOTAL_CELLS);
    const _keyToId = keyToId;

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
        const rLen = rle.length & ~1;
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
        return numericBlocks;
    }

    // 1. 旧・文字列パレット形式 ({ s: "stone:0,..." })
    if (typeof chunkData.s === "string") {
        const blockStrings = chunkData.s.split(",");
        const bLen = Math.min(blockStrings.length, TOTAL_CELLS);
        for (let j = 0; j < bLen; j++) {
            const parts = blockStrings[j].split(":");
            const id = _keyToId(parts[0]);
            const meta = parseInt(parts[1], 10) || 0;
            numericBlocks[j] = packRawBlock(id, meta);
        }
        return numericBlocks;
    }

    // 2. 旧・オブジェクト配列形式 ({ blocks: [{k,m}, ...] })
    if (Array.isArray(chunkData.blocks)) {
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
        return numericBlocks;
    }

    // 3. 旧・直接Uint16Array形式
    if (chunkData instanceof Uint16Array) {
        const bLen = Math.min(chunkData.length, TOTAL_CELLS);
        for (let j = 0; j < bLen; j++) {
            const oldVal = chunkData[j];
            numericBlocks[j] = packRawBlock(oldVal & 0xFFF, (oldVal >> 12) & 0xF);
        }
        return numericBlocks;
    }

    return null;
}

async function readWorldRecord(db, worldUid) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["worlds"], "readonly");
        const req = tx.objectStore("worlds").get(worldUid);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * 保存済みワールド一覧を最終更新日時が新しい順で取得する
 */
export async function listWorlds() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["worlds"], "readonly");
        const req = tx.objectStore("worlds").getAll();
        req.onsuccess = () => {
            const rawList = Array.isArray(req.result) ? req.result : [];
            const list = rawList.map((w) => ({
                worldUid: w.worldUid,
                name: (typeof w.name === "string" && w.name.trim()) ? w.name.trim() : "新しい世界",
                seed: w.seed ?? 0,
                gameMode: w.gameMode || w.worldEntitiesState?.playerData?.gameMode || "creative",
                dimension: w.dimension || DEFAULT_DIMENSION,
                gameTime: w.gameTime ?? 0,
                chunkCount: w.chunkCount ?? 0,
                createdAt: w.createdAt || w.savedAt || 0,
                savedAt: w.savedAt || w.createdAt || 0
            }));
            list.sort((a, b) => b.savedAt - a.savedAt);
            resolve(list);
        };
        req.onerror = () => reject(req.error || new Error("ワールド一覧の読み込みに失敗しました"));
    });
}

/**
 * 指定ワールドの名前を変更する
 */
export async function renameWorld(worldUid, newName) {
    const trimmed = String(newName ?? "").trim().slice(0, 40);
    if (!worldUid || !trimmed) return null;

    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["worlds"], "readwrite");
        const store = tx.objectStore("worlds");
        const req = store.get(worldUid);

        req.onsuccess = () => {
            const record = req.result;
            if (!record) {
                resolve(null);
                return;
            }
            record.name = trimmed;
            store.put(record);
            tx.oncomplete = () => resolve(record);
        };
        req.onerror = () => reject(req.error);
        tx.onerror = () => reject(tx.error || new Error("ワールド名の変更に失敗しました"));
    });
}

/**
 * 指定ワールドとその全チャンクデータを完全削除する
 */
export async function deleteWorld(worldUid) {
    if (!worldUid) return false;
    const db = await getDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(["worlds", "world_chunks"], "readwrite");
        const worldsStore = tx.objectStore("worlds");
        const chunkStore = tx.objectStore("world_chunks");

        worldsStore.delete(worldUid);

        const idx = chunkStore.index("by_world");
        const cursorReq = idx.openKeyCursor(IDBKeyRange.only(worldUid));
        cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                chunkStore.delete(cursor.primaryKey);
                cursor.continue();
            }
        };

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error("ワールドの削除に失敗しました"));
        tx.onabort = () => reject(tx.error || new Error("ワールドの削除が中断されました"));
    });
}

/**
 * 指定ワールドデータの保存（複数ワールド対応・編集チャンク限定・差分セーブ）
 */
export async function saveWorldData({
    seed,
    worldName = null,
    gameMode = "creative",
    dimension = DEFAULT_DIMENSION,
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

    // 1. 該当ワールドが既存か確認し、初回なら編集チャンク全量、2回目以降は差分のみ保存
    const existingRecord = await readWorldRecord(db, activeWorldUid);
    const isFullSave = !isAlreadySaved || !existingRecord;

    const targetKeys = isFullSave
        ? chunkManager.playerModifiedKeys
        : chunkManager.dirtySaveKeys;

    // 2. トランザクション開始前に CPU エンコードを完了（DBロック時間を最小化）
    const encodedEntries = [];
    let totalBytes = 0;

    if (chunkManager && targetKeys && targetKeys.size > 0) {
        for (const key of targetKeys) {
            const dataArray = chunkManager.modifiedChunks.get(key);
            if (!dataArray) continue;

            const payload = encodeChunkPaletteRLE(dataArray);
            encodedEntries.push({ chunkKey: key, payload });
            totalBytes += payload.rle.byteLength + payload.palette.length * 16;
        }
    }

    const now = Date.now();
    const finalName = (typeof worldName === "string" && worldName.trim())
        ? worldName.trim().slice(0, 40)
        : (existingRecord?.name || "新しい世界");

    const worldRecord = {
        worldUid: activeWorldUid,
        name: finalName,
        seed,
        gameMode: gameMode || worldEntitiesState?.playerData?.gameMode || existingRecord?.gameMode || "creative",
        dimension: dimension || DEFAULT_DIMENSION,
        pos: playerPos,
        gameTime,
        playerState: playerState ?? existingRecord?.playerState ?? null,
        simulationState: simulationState ?? existingRecord?.simulationState ?? null,
        worldEntitiesState: worldEntitiesState ?? existingRecord?.worldEntitiesState ?? null,
        createdAt: existingRecord?.createdAt || now,
        savedAt: now,
        chunkCount: chunkManager?.playerModifiedKeys ? chunkManager.playerModifiedKeys.size : (existingRecord?.chunkCount || 0),
        saveVersion: SAVE_FORMAT_VERSION
    };

    // 3. 単一 readwrite トランザクション内でメタ＋対象チャンクをアトミック保存（他ワールドへ一切影響なし）
    await new Promise((resolve, reject) => {
        const tx = db.transaction(["worlds", "world_chunks"], "readwrite");
        const worldsStore = tx.objectStore("worlds");
        const chunkStore = tx.objectStore("world_chunks");

        worldsStore.put(worldRecord);

        for (let i = 0; i < encodedEntries.length; i++) {
            const entry = encodedEntries[i];
            chunkStore.put({
                id: makeWorldChunkId(activeWorldUid, dimension, entry.chunkKey),
                worldUid: activeWorldUid,
                dimension: dimension || DEFAULT_DIMENSION,
                chunkKey: entry.chunkKey,
                payload: entry.payload
            });
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
        worldName: finalName,
        mode: isFullSave ? "FullWorldSave/v2-RLE" : "IncrementalDiff/v2-RLE",
        savedChunks: encodedEntries.length,
        totalBytes,
        elapsedMs: performance.now() - startTime
    };
}

/**
 * 指定 worldUid のワールドデータとチャンク群を読み込む
 */
export async function loadWorldData(worldUid, dimension = DEFAULT_DIMENSION) {
    if (!worldUid) return null;
    const db = await getDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(["worlds", "world_chunks"], "readonly");
        const worldsStore = tx.objectStore("worlds");
        const chunkStore = tx.objectStore("world_chunks");

        const reqWorld = worldsStore.get(worldUid);
        const reqChunks = chunkStore.index("by_world").getAll(IDBKeyRange.only(worldUid));

        tx.oncomplete = () => {
            const world = reqWorld.result;
            if (!world) {
                resolve(null);
                return;
            }

            const chunks = new Map();
            const records = reqChunks.result || [];
            const targetDim = dimension || DEFAULT_DIMENSION;

            for (let i = 0; i < records.length; i++) {
                const rec = records[i];
                if (!rec || (rec.dimension || DEFAULT_DIMENSION) !== targetDim) continue;
                const chunkKey = Number(rec.chunkKey);
                if (!Number.isFinite(chunkKey)) continue;

                const decoded = decodeChunkPayload(rec.payload);
                if (decoded) {
                    chunks.set(chunkKey, decoded);
                }
            }

            resolve({
                worldUid: world.worldUid,
                worldName: world.name || "新しい世界",
                seed: world.seed,
                gameMode: world.gameMode || world.worldEntitiesState?.playerData?.gameMode || "creative",
                dimension: world.dimension || DEFAULT_DIMENSION,
                pos: world.pos ?? null,
                gameTime: world.gameTime ?? 6000,
                playerState: world.playerState ?? null,
                simulationState: world.simulationState ?? null,
                worldEntitiesState: world.worldEntitiesState ?? null,
                chunks
            });
        };

        tx.onerror = () => reject(tx.error || new Error("ワールドの読み込みに失敗しました"));
        tx.onabort = () => reject(tx.error || new Error("ワールドの読み込みが中断されました"));
    });
}

/**
 * 後方互換ヘルパー：最後に遊んだワールドを読み込む
 */
export async function loadFullSaveData() {
    const worlds = await listWorlds();
    if (worlds.length === 0) return null;
    return loadWorldData(worlds[0].worldUid, worlds[0].dimension);
}