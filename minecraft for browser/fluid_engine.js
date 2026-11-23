"use strict";

import { BLOCK_TYPES } from './blocks.js';

/* ======================================================
   【流体シミュレーションエンジン】(fluid_engine.js)
   - Minecraft Java Edition FlowingFluid 準拠
   - BlockState: level (0=源流, 1..7=減衰段階), falling (bit3=落下中フル高さ)
   - 水(5 ticks / 拡散7 / 無限水源あり) ・ 溶岩(30 ticks / 拡散3)
   - 水×溶岩の接触反応（丸石生成）＆ 拡張API registerFluid / registerReaction
   ====================================================== */

const HORIZ_DX = new Int8Array([1, -1, 0, 0]);
const HORIZ_DZ = new Int8Array([0, 0, 1, -1]);
const DIR6_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const DIR6_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const DIR6_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);

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
            maxLevel: options.maxLevel ?? 7,
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
    // 水: 5 ticks / level 0..7 (最大7マス) / 段差探索4マス / 無限水源あり
    registerFluid(BLOCK_TYPES.WATER, {
        tickDelay: 5,
        maxLevel: 7,
        levelDrop: 1,
        slopeFindDistance: 4,
        infiniteSource: true
    });

    // 溶岩: 30 ticks / level 0,2,4,6 (最大3マス) / 段差探索2マス / 無限水源なし
    registerFluid(BLOCK_TYPES.LAVA, {
        tickDelay: 30,
        maxLevel: 6,
        levelDrop: 2,
        slopeFindDistance: 2,
        infiniteSource: false
    });

    // 標準接触反応：水 × 溶岩 -> 丸石（または黒曜石）
    registerReaction(BLOCK_TYPES.WATER, BLOCK_TYPES.LAVA, ({ tx, ty, tz, targetRaw }) => {
        const targetMeta = (targetRaw >> 12) & 0xF;
        const targetLevel = targetMeta & 7;
        const isTargetSource = (targetLevel === 0) && (((targetMeta >> 3) & 1) === 0);
        const resultId = (isTargetSource && BLOCK_TYPES.OBSIDIAN)
            ? BLOCK_TYPES.OBSIDIAN
            : BLOCK_TYPES.COBBLE_STONE;
        setBlockFromWorldTick(tx, ty, tz, resultId);
        return true;
    });

    registerReaction(BLOCK_TYPES.LAVA, BLOCK_TYPES.WATER, ({ tx, ty, tz }) => {
        setBlockFromWorldTick(tx, ty, tz, BLOCK_TYPES.COBBLE_STONE);
        return true;
    });

    function getRaw(wx, wy, wz) {
        if (wy < 0 || wy >= chunkHeight) return -1;
        return getWorldRawLoaded(wx, wy, wz);
    }

    function isSameFluidSource(raw, fluidId) {
        return raw >= 0 && (raw & 0xFFF) === fluidId && ((raw >> 12) & 0xF) === 0;
    }

    /**
     * 指定座標へ液体が流入（上書き）できるか判定する
     */
    function canFluidReplace(wx, wy, wz, fluidId) {
        if (wy < 0 || wy >= chunkHeight) return false;
        const raw = getRaw(wx, wy, wz);
        if (raw < 0) return false; // 未ロードチャンクには流さない

        const id = raw & 0xFFF;
        if (id === BLOCK_TYPES.SKY) return true;
        if (id === fluidId) return true;

        // 他種液体との接触反応対象なら流入処理側で反応させる
        if (fluidConfigs.has(id)) return true;

        const cfg = blockConfigFastArray[id];
        if (!cfg) return false;
        if (cfg.fluidPassable === false) return false;
        if (isOpaqueBlock[id] === 1) return false;

        // 草・花・レッドストーン配線・松明など当たり判定のない透過ブロックは押し流せる
        return cfg.overwrite === true || cfg.collision === false;
    }

    /**
     * 真下へ落下・段差落ちできるか判定する（同種源流の上は穴とみなさない）
     */
    function canFluidFallInto(wx, wy, wz, fluidId) {
        if (wy < 0 || wy >= chunkHeight) return false;
        const raw = getRaw(wx, wy, wz);
        if (raw < 0) return false;
        if (isSameFluidSource(raw, fluidId)) return false;
        return canFluidReplace(wx, wy, wz, fluidId);
    }

    /**
     * 液体が指定ブロックを押し流す際の事前処理（パーティクル・回路連動など）
     */
    function clearPassableBlockIfNeeded(wx, wy, wz, raw, fluidId) {
        const id = raw & 0xFFF;
        if (id === BLOCK_TYPES.SKY || id === fluidId || fluidConfigs.has(id)) return;
        if (typeof onFluidReplacedBlock === "function") {
            onFluidReplacedBlock(wx, wy, wz, raw);
        }
    }

    /**
     * 他種液体との接触反応を実行（反応が起きたら true）
     */
    function tryFluidReaction(sourceId, sx, sy, sz, tx, ty, tz, targetRaw) {
        const targetId = targetRaw & 0xFFF;
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
      * 穴（段差）に向かって優先的に流れるための最短距離探索（水:4マス / 溶岩:2マス）
      */
    function getSlopeDistance(wx, wy, wz, fluidId, fromDirIdx, depth, maxDepth) {
        if (depth > maxDepth) return 1000;
        let minDist = 1000;

        for (let d = 0; d < 4; d++) {
            if (d === fromDirIdx) continue;
            const nx = wx + HORIZ_DX[d];
            const nz = wz + HORIZ_DZ[d];
            const nRaw = getRaw(nx, wy, nz);
            if (nRaw < 0) continue;

            const nId = nRaw & 0xFFF;
            if (nId !== fluidId && !canFluidReplace(nx, wy, nz, fluidId)) continue;
            if (isSameFluidSource(nRaw, fluidId)) continue;

            // 1歩先で真下に落ちられるなら最優先ルート
            if (canFluidFallInto(nx, wy - 1, nz, fluidId)) {
                return depth;
            }

            if (depth < maxDepth) {
                const opp = d ^ 1;
                const dist = getSlopeDistance(nx, wy, nz, fluidId, opp, depth + 1, maxDepth);
                if (dist < minDist) minDist = dist;
            }
        }
        return minDist;
    }

    /**
     * 周囲6近傍の液体ブロックに更新Tickを予約する
     */
    function scheduleFluidAround(wx, wy, wz) {
        for (let i = 0; i < 6; i++) {
            const nx = wx + DIR6_DX[i];
            const ny = wy + DIR6_DY[i];
            const nz = wz + DIR6_DZ[i];
            const raw = getRaw(nx, ny, nz);
            if (raw < 0) continue;
            const fCfg = fluidConfigs.get(raw & 0xFFF);
            if (fCfg) {
                tickScheduler.schedule(nx, ny, nz, fCfg.tickDelay, "fluid_flow", 1, fCfg.id);
            }
        }
        const selfRaw = getRaw(wx, wy, wz);
        if (selfRaw >= 0) {
            const selfCfg = fluidConfigs.get(selfRaw & 0xFFF);
            if (selfCfg) {
                tickScheduler.schedule(wx, wy, wz, selfCfg.tickDelay, "fluid_flow", 1, selfCfg.id);
            }
        }
    }

    /**
     * 液体セル1マスのTick更新処理
     */
    function processFluidTick(task) {
        const { x, y, z } = task;
        const raw = getRaw(x, y, z);
        if (raw < 0) return;

        const id = raw & 0xFFF;
        const fCfg = fluidConfigs.get(id);
        if (!fCfg) return;

        const meta = (raw >> 12) & 0xF;
        let level = meta & 7;
        let falling = ((meta >> 3) & 1) !== 0;
        const isSource = (level === 0 && !falling);

        // 1. 源流以外は周囲の供給状況から自分の最新レベルを再計算（供給が絶たれたら減衰・消滅）
        if (!isSource) {
            const aboveRaw = getRaw(x, y + 1, z);
            const hasFluidAbove = (aboveRaw >= 0 && (aboveRaw & 0xFFF) === id);

            let minNeighborLevel = 99;
            let adjacentSources = 0;

            for (let d = 0; d < 4; d++) {
                const nx = x + HORIZ_DX[d];
                const nz = z + HORIZ_DZ[d];
                const nRaw = getRaw(nx, y, nz);
                if (nRaw < 0 || (nRaw & 0xFFF) !== id) continue;

                const nMeta = (nRaw >> 12) & 0xF;
                const nLevel = nMeta & 7;
                const nFalling = ((nMeta >> 3) & 1) !== 0;

                if (nLevel === 0 && !nFalling) {
                    adjacentSources++;
                }
                const effectiveLevel = nFalling ? 0 : nLevel;
                if (effectiveLevel < minNeighborLevel) {
                    minNeighborLevel = effectiveLevel;
                }
            }

            // 無限水源判定（水のみ：隣接2方向以上が水源＋真下が固体または水源）
            if (fCfg.infiniteSource && adjacentSources >= 2) {
                const belowRaw = getRaw(x, y - 1, z);
                const belowId = belowRaw >= 0 ? (belowRaw & 0xFFF) : 0;
                const belowSolidOrSource =
                    isOpaqueBlock[belowId] === 1 ||
                    (belowId === id && ((belowRaw >> 12) & 0xF) === 0);

                if (belowSolidOrSource) {
                    setBlockFromWorldTick(x, y, z, id);
                    scheduleFluidAround(x, y, z);
                    return;
                }
            }

            let targetLevel = minNeighborLevel + fCfg.levelDrop;
            let targetFalling = false;

            if (hasFluidAbove) {
                targetLevel = fCfg.levelDrop & 7;
                targetFalling = true;
            }

            // 最大拡散距離を超えたら減衰・消滅
            if (!targetFalling && targetLevel > fCfg.maxLevel) {
                if (level + fCfg.levelDrop <= fCfg.maxLevel) {
                    const decayedMeta = (level + fCfg.levelDrop) & 7;
                    setBlockFromWorldTick(x, y, z, id | (decayedMeta << 12));
                    scheduleFluidAround(x, y, z);
                } else {
                    setBlockFromWorldTick(x, y, z, BLOCK_TYPES.SKY);
                    scheduleFluidAround(x, y, z);
                }
                return;
            }

            const newMeta = (targetLevel & 7) | (targetFalling ? 8 : 0);
            if (newMeta !== meta) {
                setBlockFromWorldTick(x, y, z, id | (newMeta << 12));
                scheduleFluidAround(x, y, z);
                level = targetLevel;
                falling = targetFalling;
            }
        }

        // 2. 下方向への落下処理
        if (y > 0) {
            const belowRaw = getRaw(x, y - 1, z);
            if (belowRaw >= 0) {
                const belowId = belowRaw & 0xFFF;

                // 他種液体との接触反応（例：水が下の溶岩へ落ちた）
                if (belowId !== id && fluidConfigs.has(belowId)) {
                    if (tryFluidReaction(id, x, y, z, x, y - 1, z, belowRaw)) {
                        scheduleFluidAround(x, y - 1, z);
                    }
                    return;
                }

                // 同種源流の上では下を落下水で上書きしない（海・川・溶岩溜まりの源流保護）
                if (!isSameFluidSource(belowRaw, id) && canFluidReplace(x, y - 1, z, id)) {
                    const fallMeta = (fCfg.levelDrop & 7) | 8; // 落下中フル高さ (水:9 / 溶岩:10)
                    const nextBelowRaw = id | (fallMeta << 12);
                    if (belowRaw !== nextBelowRaw) {
                        clearPassableBlockIfNeeded(x, y - 1, z, belowRaw, id);
                        setBlockFromWorldTick(x, y - 1, z, nextBelowRaw);
                        tickScheduler.schedule(x, y - 1, z, fCfg.tickDelay, "fluid_flow", 1, id);
                    }
                    // 源流以外は落下中なら横へ広げず、着地してから横へ広がる（本家準拠）
                    if (!isSource) return;
                }
            }
        }

        // 3. 水平4方向への拡散処理
        const baseSpreadLevel = falling ? 0 : level;
        const nextLevel = baseSpreadLevel + fCfg.levelDrop;
        if (nextLevel > fCfg.maxLevel) return;

        // 流入可能な方向だけで段差距離を計算し、海や川の源流が minSlope=0 を奪うバグを防ぐ
        let minSlope = 1000;
        const slopes = [1001, 1001, 1001, 1001];
        for (let d = 0; d < 4; d++) {
            const nx = x + HORIZ_DX[d];
            const nz = z + HORIZ_DZ[d];
            const nRaw = getRaw(nx, y, nz);
            if (nRaw < 0) continue;

            const nId = nRaw & 0xFFF;
            if (nId === id) {
                const nMeta = (nRaw >> 12) & 0xF;
                const nFalling = ((nMeta >> 3) & 1) !== 0;
                const nLevel = nMeta & 7;
                // 既に同種源流や同等以上の水位がある方向は流入対象から除外
                if (!nFalling && nLevel <= nextLevel) continue;
            } else if (!canFluidReplace(nx, y, nz, id)) {
                continue;
            }

            const s = canFluidFallInto(nx, y - 1, nz, id)
                ? 0
                : getSlopeDistance(nx, y, nz, id, d ^ 1, 1, fCfg.slopeFindDistance);
            slopes[d] = s;
            if (s < minSlope) minSlope = s;
        }

        for (let d = 0; d < 4; d++) {
            if (slopes[d] > minSlope) continue;

            const nx = x + HORIZ_DX[d];
            const nz = z + HORIZ_DZ[d];
            const nRaw = getRaw(nx, y, nz);
            if (nRaw < 0) continue;

            const nId = nRaw & 0xFFF;

            // 他種液体との接触反応（例：水が横の溶岩へ接触した）
            if (nId !== id && fluidConfigs.has(nId)) {
                if (tryFluidReaction(id, x, y, z, nx, y, nz, nRaw)) {
                    scheduleFluidAround(nx, y, nz);
                }
                continue;
            }

            if (!canFluidReplace(nx, y, nz, id)) continue;

            if (nId === id) {
                const nMeta = (nRaw >> 12) & 0xF;
                const nFalling = ((nMeta >> 3) & 1) !== 0;
                const nLevel = nMeta & 7;
                if (!nFalling && nLevel <= nextLevel) continue;
            }

            clearPassableBlockIfNeeded(nx, y, nz, nRaw, id);
            const nextRaw = id | ((nextLevel & 7) << 12);
            setBlockFromWorldTick(nx, y, nz, nextRaw);
            tickScheduler.schedule(nx, y, nz, fCfg.tickDelay, "fluid_flow", 1, id);
        }
    }

    /**
     * 1セルの流体が「今すぐ流れ出せる露出状態か」を高速判定し、該当すればTick予約する
     */
    function scheduleIfFluidExposed(wx, wy, wz, raw) {
        const id = raw & 0xFFF;
        if (id >= fluidFastMask.length || fluidFastMask[id] === 0) return;

        const fCfg = fluidConfigs.get(id);
        if (!fCfg) return;

        const meta = (raw >> 12) & 0xF;
        const level = meta & 7;
        const falling = ((meta >> 3) & 1) !== 0;

        // 1. 真下に落下可能または異種流体がある
        if (wy > 0) {
            const belowRaw = getRaw(wx, wy - 1, wz);
            if (belowRaw >= 0) {
                const belowId = belowRaw & 0xFFF;
                if (
                    (belowId !== id && fluidConfigs.has(belowId)) ||
                    (!isSameFluidSource(belowRaw, id) && canFluidReplace(wx, wy - 1, wz, id))
                ) {
                    tickScheduler.schedule(wx, wy, wz, fCfg.tickDelay, "fluid_flow", 1, id);
                    return;
                }
            }
        }

        // 2. 水平4方向に拡散可能（水位余力あり＋空気・草・異種流体・低水位同種流体に隣接）
        const nextLevel = (falling ? 0 : level) + fCfg.levelDrop;
        if (nextLevel > fCfg.maxLevel) return;

        for (let d = 0; d < 4; d++) {
            const nx = wx + HORIZ_DX[d];
            const nz = wz + HORIZ_DZ[d];
            const nRaw = getRaw(nx, wy, nz);
            if (nRaw < 0) continue;

            const nId = nRaw & 0xFFF;
            if (nId === id) {
                const nMeta = (nRaw >> 12) & 0xF;
                const nFalling = ((nMeta >> 3) & 1) !== 0;
                const nLevel = nMeta & 7;
                if (!nFalling && nLevel <= nextLevel) continue;
                tickScheduler.schedule(wx, wy, wz, fCfg.tickDelay, "fluid_flow", 1, id);
                return;
            }
            if (canFluidReplace(nx, wy, nz, id)) {
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

        // 1. 自チャンク内の露出流体スキャン
        for (let lx = 0; lx < 16; lx++) {
            const xOff = lx << 12;
            const wx = baseX + lx;
            for (let lz = 0; lz < 16; lz++) {
                const colBase = xOff | (lz << 8);
                const wz = baseZ + lz;
                for (let y = 1; y < chunkHeight; y++) {
                    const raw = voxelData[colBase | y];
                    if (raw === 0) continue;
                    const id = raw & 0xFFF;
                    if (id < fluidFastMask.length && fluidFastMask[id] === 1) {
                        scheduleIfFluidExposed(wx, y, wz, raw);
                    }
                }
            }
        }

        // 2. 先にロードされていた隣接4チャンク境界の流体が、新チャンクの空洞へ流れ込めるよう起動
        for (let s = 0; s < 16; s++) {
            for (let y = 1; y < chunkHeight; y++) {
                const rE = getRaw(baseX + 16, y, baseZ + s);
                if (rE > 0 && fluidFastMask[rE & 0xFFF] === 1) scheduleIfFluidExposed(baseX + 16, y, baseZ + s, rE);

                const rW = getRaw(baseX - 1, y, baseZ + s);
                if (rW > 0 && fluidFastMask[rW & 0xFFF] === 1) scheduleIfFluidExposed(baseX - 1, y, baseZ + s, rW);

                const rS = getRaw(baseX + s, y, baseZ + 16);
                if (rS > 0 && fluidFastMask[rS & 0xFFF] === 1) scheduleIfFluidExposed(baseX + s, y, baseZ + 16, rS);

                const rN = getRaw(baseX + s, y, baseZ - 1);
                if (rN > 0 && fluidFastMask[rN & 0xFFF] === 1) scheduleIfFluidExposed(baseX + s, y, baseZ - 1, rN);
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