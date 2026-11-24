"use strict";

import { BLOCK_TYPES } from './blocks.js';
import { getRawBlockId, getRawLocalState, packRawBlock } from './blockstate.js';

/* ======================================================
   【流体シミュレーションエンジン】(fluid_engine.js)
   - Minecraft Java Edition FlowingFluid / WaterFluid / LavaFluid 完全準拠
   - 4bit BlockState 互換維持:
       meta = 0          : 源流 (Source, amount = 8)
       meta = 1..7       : 通常流水 (Flowing, amount = 8 - meta = 7..1)
       meta = 8 (bit3=1) : 落下流体 (Falling, amount = 8)
   - 水  : 5 ticks / levelDrop=1 (最大7マス) / 段差探索4 / 無限水源あり
   - 溶岩: 30 ticks / levelDrop=2 (最大3マス) / 段差探索2 / 無限水源なし
   ====================================================== */

const HORIZ_DX = new Int8Array([1, -1, 0, 0]);
const HORIZ_DZ = new Int8Array([0, 0, 1, -1]);
const DIR6_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const DIR6_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const DIR6_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);

// --- 4bit BlockState <-> 本家準拠 amount(1..8) 変換ヘルパー ---
function isMetaSource(meta) {
    return (meta & 0xF) === 0;
}

function isMetaFalling(meta) {
    return ((meta >> 3) & 1) !== 0;
}

function decodeFluidAmount(meta) {
    const m = meta & 0xF;
    if ((m & 8) !== 0) return 8; // 落下流体 (meta=8..15 後方互換含む)
    return 8 - (m & 7);          // 源流(0)->8, level1->7, ..., level7->1
}

function encodeFluidMeta(amount, falling) {
    if (falling) return 8;           // bit3=1, level=0 (落下流体)
    if (amount >= 8) return 0;       // 源流
    const lvl = 8 - amount;
    return lvl < 1 ? 1 : (lvl > 7 ? 7 : lvl);
}

export function createFluidEngine(deps) {
    const {
        chunkHeight = 256,
        isOpaqueBlock,
        blockConfigFastArray,
        getWorldRawLoaded,
        setBlockFromWorldTick,
        tickScheduler,
        onFluidReplacedBlock = null
    } = deps;

    const fluidConfigs = new Map();
    const fluidFastMask = new Uint8Array(1024);
    const activatedChunks = new Set();
    const reactions = [];

    function registerFluid(blockId, options) {
        const id = blockId & 0xFFF;
        if (id < fluidFastMask.length) fluidFastMask[id] = 1;
        fluidConfigs.set(id, {
            id,
            tickDelay: options.tickDelay ?? 5,
            levelDrop: options.levelDrop ?? 1,
            slopeFindDistance: options.slopeFindDistance ?? 4,
            infiniteSource: options.infiniteSource === true
        });
    }

    function registerReaction(sourceId, targetId, handler) {
        reactions.push({
            sourceId: sourceId & 0xFFF,
            targetId: targetId & 0xFFF,
            handler
        });
    }

    // 標準流体登録（Minecraft Java Edition オーバーワールド準拠）
    registerFluid(BLOCK_TYPES.WATER, {
        tickDelay: 5,
        levelDrop: 1,
        slopeFindDistance: 4,
        infiniteSource: true
    });

    registerFluid(BLOCK_TYPES.LAVA, {
        tickDelay: 30,
        levelDrop: 2,
        slopeFindDistance: 2,
        infiniteSource: false
    });

    // 標準接触反応（Minecraft Java Edition 準拠）
    // 水 -> 溶岩源流: 黒曜石(未定義時は丸石) / 溶岩流水: 丸石
    registerReaction(BLOCK_TYPES.WATER, BLOCK_TYPES.LAVA, ({ sx, sz, tx, ty, tz, targetRaw }) => {
        const targetMeta = getRawLocalState(targetRaw);
        const resultId = (isMetaSource(targetMeta) && BLOCK_TYPES.OBSIDIAN)
            ? BLOCK_TYPES.OBSIDIAN
            : BLOCK_TYPES.COBBLE_STONE;
        setBlockFromWorldTick(tx, ty, tz, resultId, sx, sz);
        return true;
    });

    // 溶岩 -> 下の水: 石 / 横の水: 丸石
    registerReaction(BLOCK_TYPES.LAVA, BLOCK_TYPES.WATER, ({ sx, sy, sz, tx, ty, tz }) => {
        const isVerticalDrop = (ty === sy - 1);
        const resultId = (isVerticalDrop && BLOCK_TYPES.STONE)
            ? BLOCK_TYPES.STONE
            : BLOCK_TYPES.COBBLE_STONE;
        setBlockFromWorldTick(tx, ty, tz, resultId, sx, sz);
        return true;
    });

    function getRaw(wx, wy, wz) {
        if (wy < 0 || wy >= chunkHeight) return -1;
        return getWorldRawLoaded(wx, wy, wz);
    }

    function isSameFluidSource(raw, fluidId) {
        return raw >= 0 && getRawBlockId(raw) === fluidId && isMetaSource(getRawLocalState(raw));
    }

    /**
     * 指定座標に液体が進入・置換できるか判定（本家 FlowingFluid.canHoldFluid 準拠）
     */
    function canHoldFluid(wx, wy, wz, fluidId) {
        if (wy < 0 || wy >= chunkHeight) return false;
        const raw = getRaw(wx, wy, wz);
        if (raw < 0) return false; // 未ロードチャンクへは流さない

        const id = getRawBlockId(raw);
        if (id === BLOCK_TYPES.SKY) return true;
        if (id === fluidId) return true;
        if (fluidConfigs.has(id)) return true; // 他種流体は接触反応側で処理

        const cfg = blockConfigFastArray[id];
        if (!cfg) return false;
        if (cfg.fluidPassable === true) return true;
        if (cfg.fluidPassable === false) return false;
        if (isOpaqueBlock[id] === 1) return false;

        return cfg.overwrite === true || cfg.collision === false;
    }

    /**
     * 指定座標の真下へ落下（段差落ち）できるか判定（本家 FlowingFluid.isWaterHole 準拠）
     * ※同種源流の上は穴とみなさない（海・川・溶岩湖の表面保護）
     */
    function isFluidHole(wx, wy, wz, fluidId) {
        if (wy < 0 || wy >= chunkHeight) return false;
        const raw = getRaw(wx, wy, wz);
        if (raw < 0) return false;
        if (isSameFluidSource(raw, fluidId)) return false;
        return canHoldFluid(wx, wy, wz, fluidId);
    }

    function clearPassableBlockIfNeeded(wx, wy, wz, raw, fluidId) {
        const id = getRawBlockId(raw);
        if (id === BLOCK_TYPES.SKY || id === fluidId || fluidConfigs.has(id)) return;
        if (typeof onFluidReplacedBlock === "function") {
            onFluidReplacedBlock(wx, wy, wz, raw);
        }
    }

    function tryFluidReaction(sourceId, sx, sy, sz, tx, ty, tz, targetRaw) {
        const targetId = getRawBlockId(targetRaw);
        if (targetId === sourceId || !fluidConfigs.has(targetId)) return false;

        for (let i = 0; i < reactions.length; i++) {
            const r = reactions[i];
            if (r.sourceId === sourceId && r.targetId === targetId) {
                return !!r.handler({ sourceId, sx, sy, sz, tx, ty, tz, targetId, targetRaw });
            }
        }
        return false;
    }

    /**
     * 周囲6近傍および自セルの液体に更新Tickを予約する
     */
    function scheduleFluidAround(wx, wy, wz) {
        for (let i = 0; i < 6; i++) {
            const nx = wx + DIR6_DX[i];
            const ny = wy + DIR6_DY[i];
            const nz = wz + DIR6_DZ[i];
            const raw = getRaw(nx, ny, nz);
            if (raw < 0) continue;
            const fCfg = fluidConfigs.get(getRawBlockId(raw));
            if (fCfg) {
                tickScheduler.schedule(nx, ny, nz, fCfg.tickDelay, "fluid_flow", 1, fCfg.id);
            }
        }
        const selfRaw = getRaw(wx, wy, wz);
        if (selfRaw >= 0) {
            const selfCfg = fluidConfigs.get(getRawBlockId(selfRaw));
            if (selfCfg) {
                tickScheduler.schedule(wx, wy, wz, selfCfg.tickDelay, "fluid_flow", 1, selfCfg.id);
            }
        }
    }

    /**
     * 本家 Java Edition FlowingFluid.getNewLiquid() 準拠：
     * 非源流セル (x, y, z) の本来あるべき最新状態 (packed 16bit, 空なら SKY) を算出する
     */
    function computeUpdatedLiquidRaw(x, y, z, id, fCfg) {
        let highestNeighborAmount = 0;
        let adjacentSources = 0;

        for (let d = 0; d < 4; d++) {
            const nx = x + HORIZ_DX[d];
            const nz = z + HORIZ_DZ[d];
            const nRaw = getRaw(nx, y, nz);
            if (nRaw < 0 || getRawBlockId(nRaw) !== id) continue;

            const nMeta = getRawLocalState(nRaw);
            if (isMetaSource(nMeta)) {
                adjacentSources++;
            }
            const nAmount = decodeFluidAmount(nMeta);
            if (nAmount > highestNeighborAmount) {
                highestNeighborAmount = nAmount;
            }
        }

        // 1. 無限水源判定（水のみ：水平隣接に真の源流が2つ以上 ＋ 真下が不透明固体または同種源流）
        // ※溶岩は infiniteSource=false のため絶対に源流にならない
        if (fCfg.infiniteSource && adjacentSources >= 2) {
            const belowRaw = getRaw(x, y - 1, z);
            if (belowRaw >= 0) {
                const belowId = getRawBlockId(belowRaw);
                const belowSupportsSource =
                    isOpaqueBlock[belowId] === 1 ||
                    isSameFluidSource(belowRaw, id);
                if (belowSupportsSource) {
                    return packRawBlock(id, 0); // 源流 (meta = 0)
                }
            }
        }

        // 2. 真上が同種流体（源流・流水・落下流問わず）なら落下流体 (meta = 8)
        const aboveRaw = getRaw(x, y + 1, z);
        if (aboveRaw >= 0 && getRawBlockId(aboveRaw) === id) {
            return packRawBlock(id, 8);
        }

        // 3. 水平隣接の最大水位から levelDrop 分だけ減衰した水位を算出
        const nextAmount = highestNeighborAmount - fCfg.levelDrop;
        if (nextAmount <= 0) {
            return BLOCK_TYPES.SKY;
        }
        return packRawBlock(id, encodeFluidMeta(nextAmount, false));
    }

    /**
     * 本家 Java Edition FlowingFluid.getSlopeDistance() 準拠：
     * (wx, wy, wz) から穴（段差落ち）までの最短歩数 (1..maxDepth) を探索する
     */
    function getSlopeDistance(wx, wy, wz, fluidId, fromDirIdx, depth, maxDepth) {
        let minDist = 1000;

        for (let d = 0; d < 4; d++) {
            if (d === fromDirIdx) continue;
            const nx = wx + HORIZ_DX[d];
            const nz = wz + HORIZ_DZ[d];
            const nRaw = getRaw(nx, wy, nz);
            if (nRaw < 0) continue;

            // 同種源流や進入不可ブロックは経路として通らない
            if (isSameFluidSource(nRaw, fluidId)) continue;
            if (!canHoldFluid(nx, wy, nz, fluidId)) continue;

            if (isFluidHole(nx, wy - 1, nz, fluidId)) {
                return depth;
            }

            if (depth < maxDepth) {
                const dist = getSlopeDistance(nx, wy, nz, fluidId, d ^ 1, depth + 1, maxDepth);
                if (dist < minDist) minDist = dist;
            }
        }
        return minDist;
    }

    /**
     * 1方向へ水平拡散を適用する（既存の高水位流水・源流・落下流は絶対に上書きしない）
     */
    function spreadToSide(sx, sy, sz, nx, nz, id, fCfg, spreadAmount) {
        const nRaw = getRaw(nx, sy, nz);
        if (nRaw < 0) return;

        const nId = getRawBlockId(nRaw);

        // 他種流体との接触反応
        if (nId !== id && fluidConfigs.has(nId)) {
            if (tryFluidReaction(id, sx, sy, sz, nx, sy, nz, nRaw)) {
                scheduleFluidAround(nx, sy, nz);
            }
            return;
        }

        if (!canHoldFluid(nx, sy, nz, id)) return;

        // 同種流体が既にある場合: 源流・落下流・同等以上の水位なら上書き禁止
        if (nId === id) {
            const nMeta = getRawLocalState(nRaw);
            if (isMetaSource(nMeta) || isMetaFalling(nMeta)) return;
            if (decodeFluidAmount(nMeta) >= spreadAmount) return;
        }

        clearPassableBlockIfNeeded(nx, sy, nz, nRaw, id);
        const nextRaw = packRawBlock(id, encodeFluidMeta(spreadAmount, false));
        if (nRaw !== nextRaw) {
            setBlockFromWorldTick(nx, sy, nz, nextRaw, sx, sz);
            tickScheduler.schedule(nx, sy, nz, fCfg.tickDelay, "fluid_flow", 1, id);
        }
    }

    /**
     * 液体セル1マスのTick更新処理（本家 FlowingFluid.tick + spread 完全準拠）
     */
    function processFluidTick(task) {
        const { x, y, z } = task;
        const raw = getRaw(x, y, z);
        if (raw < 0) return;

        const id = getRawBlockId(raw);
        const fCfg = fluidConfigs.get(id);
        if (!fCfg) return;

        let meta = getRawLocalState(raw);
        let isSource = isMetaSource(meta);
        let falling = isMetaFalling(meta);
        let amount = decodeFluidAmount(meta);

        // ======================================================
        // PHASE 1: 非源流セルの最新水位再計算（供給が絶たれたら拡散せず減衰・消滅）
        // ======================================================
        if (!isSource) {
            const updatedRaw = computeUpdatedLiquidRaw(x, y, z, id, fCfg);

            if (updatedRaw === BLOCK_TYPES.SKY) {
                setBlockFromWorldTick(x, y, z, BLOCK_TYPES.SKY);
                scheduleFluidAround(x, y, z);
                return;
            }

            if (updatedRaw !== raw) {
                const newMeta = getRawLocalState(updatedRaw);
                const newSource = isMetaSource(newMeta);
                const newFalling = isMetaFalling(newMeta);
                const newAmount = decodeFluidAmount(newMeta);
                const isWeakened = (newAmount < amount) || (falling && !newFalling && !newSource);

                setBlockFromWorldTick(x, y, z, updatedRaw);
                scheduleFluidAround(x, y, z);

                // 水位が下がった・落下が途切れた場合はこのTickで周囲へ拡散しない（引き波暴走防止）
                if (isWeakened) {
                    return;
                }

                meta = newMeta;
                isSource = newSource;
                falling = newFalling;
                amount = newAmount;
            }
        }

        // ======================================================
        // PHASE 2: 下方向への落下処理
        // ======================================================
        if (y > 0) {
            const belowRaw = getRaw(x, y - 1, z);
            if (belowRaw >= 0) {
                const belowId = getRawBlockId(belowRaw);

                // 他種流体との接触反応（水->下の溶岩=黒曜石/丸石、溶岩->下の水=石）
                if (belowId !== id && fluidConfigs.has(belowId)) {
                    if (tryFluidReaction(id, x, y, z, x, y - 1, z, belowRaw)) {
                        scheduleFluidAround(x, y - 1, z);
                    }
                    return;
                }

                // 真下へ落下可能（同種源流の上は上書きしない）
                if (isFluidHole(x, y - 1, z, id)) {
                    const nextBelowRaw = packRawBlock(id, 8); // falling = true
                    if (belowRaw !== nextBelowRaw) {
                        clearPassableBlockIfNeeded(x, y - 1, z, belowRaw, id);
                        setBlockFromWorldTick(x, y - 1, z, nextBelowRaw, x, z);
                        tickScheduler.schedule(x, y - 1, z, fCfg.tickDelay, "fluid_flow", 1, id);
                    }
                    // 本家準拠: 源流以外は落下中（真下に落ちられる間）は横へ広がらない
                    if (!isSource) return;
                }
            }
        }

        // ======================================================
        // PHASE 3: 水平4方向への拡散処理（全有効方向で段差距離を比較）
        // ======================================================
        const spreadAmount = (isSource || falling)
            ? (8 - fCfg.levelDrop)
            : (amount - fCfg.levelDrop);
        if (spreadAmount <= 0) return;

        let minSlope = 1000;
        const slopes = [1001, 1001, 1001, 1001];

        for (let d = 0; d < 4; d++) {
            const nx = x + HORIZ_DX[d];
            const nz = z + HORIZ_DZ[d];
            const nRaw = getRaw(nx, y, nz);
            if (nRaw < 0) continue;

            // 同種源流の方向は段差ルートから除外し、海・川の源流が minSlope=0 を奪うのを防ぐ
            if (isSameFluidSource(nRaw, id)) continue;
            if (!canHoldFluid(nx, y, nz, id)) continue;

            // 既存の同種流水方向も必ず距離計算に含める（2回目Tickでの全方向溢れ出しを防止）
            const s = isFluidHole(nx, y - 1, nz, id)
                ? 0
                : getSlopeDistance(nx, y, nz, id, d ^ 1, 1, fCfg.slopeFindDistance);
            slopes[d] = s;
            if (s < minSlope) minSlope = s;
        }

        for (let d = 0; d < 4; d++) {
            if (slopes[d] > minSlope) continue;
            spreadToSide(x, y, z, x + HORIZ_DX[d], z + HORIZ_DZ[d], id, fCfg, spreadAmount);
        }
    }

    /**
     * 1セルの流体が「今すぐ流れ出せる露出状態か」を高速判定し、該当すればTick予約する
     */
    function scheduleIfFluidExposed(wx, wy, wz, raw) {
        const id = getRawBlockId(raw);
        if (id >= fluidFastMask.length || fluidFastMask[id] === 0) return;

        const fCfg = fluidConfigs.get(id);
        if (!fCfg) return;

        const meta = getRawLocalState(raw);
        const isSource = isMetaSource(meta);
        const falling = isMetaFalling(meta);
        const amount = decodeFluidAmount(meta);

        // 1. 真下に落下可能または異種流体がある
        if (wy > 0) {
            const belowRaw = getRaw(wx, wy - 1, wz);
            if (belowRaw >= 0) {
                const belowId = getRawBlockId(belowRaw);
                if (
                    (belowId !== id && fluidConfigs.has(belowId)) ||
                    (isFluidHole(wx, wy - 1, wz, id) && belowRaw !== packRawBlock(id, 8))
                ) {
                    tickScheduler.schedule(wx, wy, wz, fCfg.tickDelay, "fluid_flow", 1, id);
                    return;
                }
            }
        }

        // 2. 水平4方向に拡散可能
        const spreadAmount = (isSource || falling)
            ? (8 - fCfg.levelDrop)
            : (amount - fCfg.levelDrop);
        if (spreadAmount <= 0) return;

        for (let d = 0; d < 4; d++) {
            const nx = wx + HORIZ_DX[d];
            const nz = wz + HORIZ_DZ[d];
            const nRaw = getRaw(nx, wy, nz);
            if (nRaw < 0) continue;

            const nId = getRawBlockId(nRaw);
            if (nId === id) {
                const nMeta = getRawLocalState(nRaw);
                if (isMetaSource(nMeta) || isMetaFalling(nMeta)) continue;
                if (decodeFluidAmount(nMeta) >= spreadAmount) continue;
                tickScheduler.schedule(wx, wy, wz, fCfg.tickDelay, "fluid_flow", 1, id);
                return;
            }
            if (canHoldFluid(nx, wy, nz, id)) {
                tickScheduler.schedule(wx, wy, wz, fCfg.tickDelay, "fluid_flow", 1, id);
                return;
            }
        }
    }

    /**
     * チャンク読み込み完了時に自然生成された露出水・溶岩（＋隣接チャンク境界の露出流体）を自動流動させる
     */
    function onChunkLoaded(cx, cz, voxelData) {
        if (!voxelData) return;
        const chunkKey = ((cx & 0xFFFF) << 16) | (cz & 0xFFFF);
        if (activatedChunks.has(chunkKey)) return;
        activatedChunks.add(chunkKey);

        const baseX = (cx << 4) | 0;
        const baseZ = (cz << 4) | 0;

        for (let lx = 0; lx < 16; lx++) {
            const xOff = lx << 12;
            const wx = baseX + lx;
            for (let lz = 0; lz < 16; lz++) {
                const colBase = xOff | (lz << 8);
                const wz = baseZ + lz;
                for (let y = 1; y < chunkHeight; y++) {
                    const raw = voxelData[colBase | y];
                    if (raw === 0) continue;
                    const id = getRawBlockId(raw);
                    if (id < fluidFastMask.length && fluidFastMask[id] === 1) {
                        scheduleIfFluidExposed(wx, y, wz, raw);
                    }
                }
            }
        }

        // 先にロードされていた隣接4チャンク境界の流体も起動
        for (let s = 0; s < 16; s++) {
            for (let y = 1; y < chunkHeight; y++) {
                const rE = getRaw(baseX + 16, y, baseZ + s);
                if (rE > 0 && fluidFastMask[getRawBlockId(rE)] === 1) scheduleIfFluidExposed(baseX + 16, y, baseZ + s, rE);

                const rW = getRaw(baseX - 1, y, baseZ + s);
                if (rW > 0 && fluidFastMask[getRawBlockId(rW)] === 1) scheduleIfFluidExposed(baseX - 1, y, baseZ + s, rW);

                const rS = getRaw(baseX + s, y, baseZ + 16);
                if (rS > 0 && fluidFastMask[getRawBlockId(rS)] === 1) scheduleIfFluidExposed(baseX + s, y, baseZ + 16, rS);

                const rN = getRaw(baseX + s, y, baseZ - 1);
                if (rN > 0 && fluidFastMask[getRawBlockId(rN)] === 1) scheduleIfFluidExposed(baseX + s, y, baseZ - 1, rN);
            }
        }
    }

    if (tickScheduler && typeof tickScheduler.registerHandler === "function") {
        tickScheduler.registerHandler("fluid_flow", (task) => {
            processFluidTick(task);
        });
    }

    return {
        onBlockChanged(wx, wy, wz) {
            scheduleFluidAround(wx | 0, wy | 0, wz | 0);
        },
        onChunkLoaded,
        onChunkEvicted(chunkKey) {
            activatedChunks.delete(chunkKey);
        },
        resetActivatedChunks() {
            activatedChunks.clear();
        },
        isFluid(blockId) {
            return fluidConfigs.has(blockId & 0xFFF);
        },
        registerFluid,
        registerReaction
    };
}