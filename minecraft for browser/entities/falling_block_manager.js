"use strict";
import * as THREE from '../build/three.module.js';
import { getRawBlockId, getRawLocalState } from '../blockstate.js';

/* ======================================================
   【落下ブロックエンティティ管理】(entities/falling_block_manager.js)
   - Minecraft Java Edition FallingBlockEntity 準拠
   - 重力加速度 -0.04 block/tick^2、空気抵抗 0.98
   - トンネリング防止（1tick複数マス落下時の途中の床検出）
   - 松明・スラブ・回路等の非置換ブロック上へ着地時はパーティクル化して破壊
   - BoxGeometry プールによるゼロリーク ＆ 60Hz+ スムーズ補間描画
   ====================================================== */

const FALL_GRAVITY = 0.04;
const FALL_DRAG = 0.98;
const MAX_FALL_AGE_TICKS = 600;
const MAX_GEOM_POOL = 64;

export function createFallingBlockManager(deps) {
    const {
        scene,
        chunkHeight,
        blockTypes,
        blockConfigFastArray,
        getWorldRawLoaded,
        setWorldBlock,
        getBlockMaterialsFast,
        getWorldLightCell,
        lightLevelFactors,
        createBreakParticles,
        tickScheduler,
        isChunkLoaded
    } = deps;

    const entities = [];
    const geomPool = [];
    const _particlePos = new THREE.Vector3();

    function acquireBoxGeometry() {
        if (geomPool.length > 0) return geomPool.pop();
        const geom = new THREE.BoxGeometry(1, 1, 1);
        const vertCount = geom.attributes.position.count;
        const colors = new Float32Array(vertCount * 3);
        colors.fill(1.0);
        geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return geom;
    }

    function releaseBoxGeometry(geom) {
        if (!geom) return;
        if (geomPool.length < MAX_GEOM_POOL) {
            geomPool.push(geom);
        } else {
            geom.dispose();
        }
    }

    function applyLightToGeometry(geom, wx, wy, wz, lastLightCell) {
        const cell = getWorldLightCell(wx, wy, wz);
        const resolvedCell = (cell >= 0) ? cell : 0xF0;
        if (resolvedCell === lastLightCell) return lastLightCell;

        const sky = lightLevelFactors[(resolvedCell >> 4) & 15];
        const blk = lightLevelFactors[resolvedCell & 15];
        const colorAttr = geom.attributes.color;
        const arr = colorAttr.array;

        for (let i = 0; i < arr.length; i += 3) {
            arr[i] = sky;
            arr[i + 1] = blk;
            arr[i + 2] = 0;
        }
        colorAttr.needsUpdate = true;
        return resolvedCell;
    }

    /**
     * 下のブロックが落下通過可能か判定（Java Edition FallingBlock.isFree 準拠）
     */
    function canFallThrough(blockId) {
        if (blockId === blockTypes.SKY) return true;
        const cfg = blockConfigFastArray[blockId];
        if (!cfg) return true;
        if (cfg.geometryType === "water") return true;
        if (cfg.overwrite === true) return true;
        if (cfg.collision === false) return true;
        return false;
    }

    /**
     * 着地先のマスをブロックとして置き換え可能か判定（空気・水・草花など overwrite 対象のみ）
     */
    function canReplaceOnLand(blockId) {
        if (blockId === blockTypes.SKY) return true;
        const cfg = blockConfigFastArray[blockId];
        if (!cfg) return true;
        if (cfg.geometryType === "water") return true;
        if (cfg.overwrite === true) return true;
        return false;
    }

    /**
     * 指定座標に落下対象ブロックがあり下が空いていれば 2gt 後に落下を予約する
     */
    function scheduleCheck(wx, wy, wz) {
        const x = wx | 0;
        const y = wy | 0;
        const z = wz | 0;
        if (y <= 0 || y >= chunkHeight) return false;

        const raw = getWorldRawLoaded(x, y, z);
        if (raw <= 0) return false;
        const id = getRawBlockId(raw);
        const cfg = blockConfigFastArray[id];
        if (!cfg || cfg.isFallingBlock !== true) return false;

        const belowRaw = getWorldRawLoaded(x, y - 1, z);
        if (belowRaw < 0) return false;
        if (!canFallThrough(getRawBlockId(belowRaw))) return false;

        tickScheduler.schedule(x, y, z, 2, "falling_block", 0, 0);
        return true;
    }

    /**
     * 落下エンティティを1体スポーンさせる
     */
    function spawn(wx, wy, wz, rawVoxel) {
        const blockId = getRawBlockId(rawVoxel);
        const meta = getRawLocalState(rawVoxel);
        const mats = getBlockMaterialsFast(blockId, meta);
        if (!mats) return null;

        const geom = acquireBoxGeometry();
        const lightCell = applyLightToGeometry(geom, wx, wy, wz, -1);

        const mesh = new THREE.Mesh(geom, mats);
        mesh.position.set(wx + 0.5, wy + 0.5, wz + 0.5);
        mesh.frustumCulled = true;
        scene.add(mesh);

        const ent = {
            x: wx + 0.5,
            y: wy,
            prevY: wy,
            z: wz + 0.5,
            vy: 0,
            age: 0,
            rawVoxel: rawVoxel & 0xFFFF,
            blockId,
            lastLightCell: lightCell,
            mesh
        };
        entities.push(ent);
        return ent;
    }

    function removeEntityAt(index) {
        const ent = entities[index];
        if (!ent) return;
        if (ent.mesh) {
            scene.remove(ent.mesh);
            releaseBoxGeometry(ent.mesh.geometry);
            ent.mesh.geometry = null;
            ent.mesh.material = null;
            ent.mesh = null;
        }
        entities.splice(index, 1);
    }

    function landEntity(index, bx, landY, bz) {
        const ent = entities[index];
        if (landY >= 0 && landY < chunkHeight) {
            const existingRaw = getWorldRawLoaded(bx, landY, bz);
            if (existingRaw >= 0) {
                const existingId = getRawBlockId(existingRaw);
                if (canReplaceOnLand(existingId)) {
                    setWorldBlock(bx, landY, bz, ent.rawVoxel);
                } else {
                    // 松明・スラブ・感圧板等の上へ着地した場合は本家同様に砕ける
                    _particlePos.set(bx + 0.5, landY + 0.5, bz + 0.5);
                    createBreakParticles(_particlePos, ent.blockId, 0.9);
                }
            }
        }
        removeEntityAt(index);
    }

    // TickScheduler へ "falling_block" ハンドラを登録
    tickScheduler.registerHandler("falling_block", (task) => {
        const x = task.x | 0;
        const y = task.y | 0;
        const z = task.z | 0;
        if (y <= 0 || y >= chunkHeight) return;

        const raw = getWorldRawLoaded(x, y, z);
        if (raw <= 0) return;

        const id = getRawBlockId(raw);
        const cfg = blockConfigFastArray[id];
        if (!cfg || cfg.isFallingBlock !== true) return;

        const belowRaw = getWorldRawLoaded(x, y - 1, z);
        if (belowRaw < 0) return;
        if (!canFallThrough(getRawBlockId(belowRaw))) return;

        // 元の位置を空気に変える（これで上に積まれた砂へ NC 更新が連鎖する）
        if (!setWorldBlock(x, y, z, blockTypes.SKY)) return;
        spawn(x, y, z, raw);
    });

    function tick() {
        for (let i = entities.length - 1; i >= 0; i--) {
            const ent = entities[i];
            const bx = Math.floor(ent.x) | 0;
            const bz = Math.floor(ent.z) | 0;

            if (!isChunkLoaded(bx >> 4, bz >> 4)) continue;

            ent.prevY = ent.y;
            ent.age++;
            ent.vy -= FALL_GRAVITY;
            ent.y += ent.vy;
            ent.vy *= FALL_DRAG;

            // 奈落または上限時間超過で消滅
            if (ent.y < -16 || ent.age > MAX_FALL_AGE_TICKS) {
                removeEntityAt(i);
                continue;
            }

            // 1Tickで複数マス落ちた場合でも薄い1マス床をすり抜けないよう上から順に走査
            const topCheckY = Math.floor(ent.prevY) | 0;
            const botCheckY = Math.floor(ent.y) | 0;
            let landed = false;

            for (let cy = topCheckY; cy >= botCheckY; cy--) {
                if (cy < 0) break;
                if (cy >= chunkHeight) continue;

                const cellRaw = getWorldRawLoaded(bx, cy, bz);
                if (cellRaw < 0) continue;

                const cellId = getRawBlockId(cellRaw);
                if (!canFallThrough(cellId)) {
                    landEntity(i, bx, cy + 1, bz);
                    landed = true;
                    break;
                }
            }

            if (landed) continue;

            const lightY = Math.max(0, Math.min(chunkHeight - 1, Math.floor(ent.y + 0.5)));
            ent.lastLightCell = applyLightToGeometry(ent.mesh.geometry, bx, lightY, bz, ent.lastLightCell);
        }
    }

    function updateRenderInterpolation(alpha) {
        for (let i = 0; i < entities.length; i++) {
            const ent = entities[i];
            if (!ent.mesh) continue;
            const renderY = ent.prevY + (ent.y - ent.prevY) * alpha;
            ent.mesh.position.set(ent.x, renderY + 0.5, ent.z);
        }
    }

    function clear() {
        for (let i = entities.length - 1; i >= 0; i--) {
            removeEntityAt(i);
        }
    }

    return {
        get count() { return entities.length; },
        canFallThrough,
        scheduleCheck,
        spawn,
        tick,
        updateRenderInterpolation,
        clear
    };
}