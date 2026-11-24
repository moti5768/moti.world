"use strict";
import { MOB_TYPES, getMobDefinition, createMobMesh, disposeMobMesh } from './mob_registry.js';

/* ======================================================
   【エンティティ・モブ管理エンジン】(entities/entity_manager.js)
   - Java Edition Entity / Mob 準拠（UUID・Pos・Motion・Rotation・Health・AI）
   - 20TPS の重力・ブロック衝突・1マス段差ジャンプ・徘徊/追跡 AI
   - 描画は毎フレーム 20TPS アルファ線形補間＋周囲ライトレベル反映
   - 感圧板等の踏み判定 (isAnyEntityInBox / forEachEntity) をゼロGCで提供
   ====================================================== */

const ENTITY_GRAVITY = 0.08;
const ENTITY_DRAG_XZ = 0.72;
const ENTITY_DRAG_Y = 0.98;
const MAX_ENTITIES = 64;

function makeEntityUuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `ent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createEntityManager(deps) {
    const {
        scene,
        chunkHeight = 256,
        isChunkLoaded,
        getWorldBlockIdLoaded,
        blockConfigFastArray,
        getLightBrightnessAt = () => 1.0,
        getPlayerPosition = () => null
    } = deps;

    const entities = [];

    function isSolidBlockAt(bx, by, bz) {
        if (by < 0) return true;
        if (by >= chunkHeight) return false;
        const id = getWorldBlockIdLoaded(bx, by, bz);
        if (id <= 0) return false;
        const cfg = blockConfigFastArray[id];
        return !!(cfg && cfg.collision !== false);
    }

    function collidesSolid(cx, feetY, cz, halfW, height) {
        const minX = Math.floor(cx - halfW);
        const maxX = Math.floor(cx + halfW);
        const minY = Math.floor(feetY);
        const maxY = Math.floor(feetY + height - 0.001);
        const minZ = Math.floor(cz - halfW);
        const maxZ = Math.floor(cz + halfW);

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                for (let z = minZ; z <= maxZ; z++) {
                    if (isSolidBlockAt(x, y, z)) return true;
                }
            }
        }
        return false;
    }

    function createEntityRecord(typeId, x, y, z, saved = null) {
        const def = getMobDefinition(typeId);
        if (!def) return null;

        const mesh = createMobMesh(def);
        mesh.position.set(x, y, z);
        scene.add(mesh);

        const yaw = saved && Number.isFinite(saved.yaw) ? saved.yaw : (Math.random() * Math.PI * 2);
        const ent = {
            uuid: (saved && typeof saved.uuid === "string") ? saved.uuid : makeEntityUuid(),
            type: typeId,
            def,
            x, y, z,
            prevX: x, prevY: y, prevZ: z,
            vx: (saved && Number.isFinite(saved.vx)) ? saved.vx : 0,
            vy: (saved && Number.isFinite(saved.vy)) ? saved.vy : 0,
            vz: (saved && Number.isFinite(saved.vz)) ? saved.vz : 0,
            yaw,
            prevYaw: yaw,
            onGround: false,
            health: (saved && Number.isFinite(saved.health)) ? saved.health : def.maxHealth,
            maxHealth: def.maxHealth,
            age: (saved && Number.isFinite(saved.age)) ? (saved.age | 0) : 0,
            walkPhase: 0,
            aiTimer: ((Math.random() * 40) | 0) + 10,
            aiMoving: false,
            aiTargetYaw: yaw,
            customName: (saved && typeof saved.customName === "string") ? saved.customName : "",
            mesh
        };

        entities.push(ent);
        return ent;
    }

    function spawn(typeId, x, y, z, saved = null) {
        if (entities.length >= MAX_ENTITIES) {
            // 上限超過時は最も古い個体を整理
            removeAtIndex(0);
        }
        return createEntityRecord(typeId, x, y, z, saved);
    }

    function removeAtIndex(idx) {
        if (idx < 0 || idx >= entities.length) return;
        const ent = entities[idx];
        disposeMobMesh(ent.mesh);
        entities.splice(idx, 1);
    }

    function removeByUuid(uuid) {
        for (let i = entities.length - 1; i >= 0; i--) {
            if (entities[i].uuid === uuid) {
                removeAtIndex(i);
                return true;
            }
        }
        return false;
    }

    function clear() {
        for (let i = entities.length - 1; i >= 0; i--) {
            disposeMobMesh(entities[i].mesh);
        }
        entities.length = 0;
    }

    function updateMobAI(ent, playerPos) {
        const def = ent.def;
        let moveDirX = 0;
        let moveDirZ = 0;
        let wantsMove = false;

        if (def.aiType === "chase_player" && playerPos) {
            const dx = playerPos.x - ent.x;
            const dz = playerPos.z - ent.z;
            const distSq = dx * dx + dz * dz;
            const rangeSq = def.chaseRange * def.chaseRange;
            if (distSq > 1.2 && distSq < rangeSq) {
                ent.aiTargetYaw = Math.atan2(dx, dz);
                wantsMove = true;
            }
        }

        if (!wantsMove) {
            ent.aiTimer--;
            if (ent.aiTimer <= 0) {
                ent.aiMoving = !ent.aiMoving;
                if (ent.aiMoving) {
                    ent.aiTargetYaw = Math.random() * Math.PI * 2;
                    ent.aiTimer = 25 + ((Math.random() * 45) | 0);
                } else {
                    ent.aiTimer = 20 + ((Math.random() * 50) | 0);
                }
            }
            wantsMove = ent.aiMoving;
        }

        // 旋回補間
        let diff = ent.aiTargetYaw - ent.yaw;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        ent.yaw += diff * 0.25;

        if (wantsMove) {
            moveDirX = Math.sin(ent.yaw);
            moveDirZ = Math.cos(ent.yaw);
            ent.vx += moveDirX * def.moveSpeed * 0.45;
            ent.vz += moveDirZ * def.moveSpeed * 0.45;

            // 前方1マスが壁でその上が空いていれば自動ジャンプ（Java Edition JumpControl 準拠）
            if (ent.onGround) {
                const probeDist = def.width * 0.5 + 0.35;
                const fx = Math.floor(ent.x + moveDirX * probeDist);
                const fy = Math.floor(ent.y);
                const fz = Math.floor(ent.z + moveDirZ * probeDist);
                if (isSolidBlockAt(fx, fy, fz) && !isSolidBlockAt(fx, fy + 1, fz)) {
                    ent.vy = def.jumpSpeed;
                    ent.onGround = false;
                }
            }
        }
    }

    function stepEntityPhysics(ent) {
        const halfW = ent.def.width * 0.5;
        const height = ent.def.height;

        // 重力
        ent.vy = (ent.vy - ENTITY_GRAVITY) * ENTITY_DRAG_Y;
        if (ent.vy < -1.2) ent.vy = -1.2;

        // Y軸移動・着地解決
        const nextY = ent.y + ent.vy;
        if (!collidesSolid(ent.x, nextY, ent.z, halfW, height)) {
            ent.y = nextY;
            ent.onGround = false;
        } else {
            if (ent.vy < 0) {
                ent.y = Math.floor(ent.y);
                ent.onGround = true;
            }
            ent.vy = 0;
        }

        // X軸移動
        const nextX = ent.x + ent.vx;
        if (!collidesSolid(nextX, ent.y + 0.01, ent.z, halfW, height)) {
            ent.x = nextX;
        } else {
            ent.vx = 0;
        }

        // Z軸移動
        const nextZ = ent.z + ent.vz;
        if (!collidesSolid(ent.x, ent.y + 0.01, nextZ, halfW, height)) {
            ent.z = nextZ;
        } else {
            ent.vz = 0;
        }

        ent.vx *= ENTITY_DRAG_XZ;
        ent.vz *= ENTITY_DRAG_XZ;
        if (Math.abs(ent.vx) < 0.001) ent.vx = 0;
        if (Math.abs(ent.vz) < 0.001) ent.vz = 0;
    }

    /**
     * 固定 20 TPS エンティティ更新
     */
    function tick() {
        const playerPos = getPlayerPosition();

        for (let i = entities.length - 1; i >= 0; i--) {
            const ent = entities[i];
            ent.prevX = ent.x;
            ent.prevY = ent.y;
            ent.prevZ = ent.z;
            ent.prevYaw = ent.yaw;

            const cx = Math.floor(ent.x) >> 4;
            const cz = Math.floor(ent.z) >> 4;
            if (!isChunkLoaded(cx, cz)) {
                ent.mesh.visible = false;
                continue;
            }
            ent.mesh.visible = true;
            ent.age++;

            updateMobAI(ent, playerPos);
            stepEntityPhysics(ent);

            // 奈落落下整理
            if (ent.y < -32) {
                removeAtIndex(i);
                continue;
            }

            const horizSpeed = Math.hypot(ent.x - ent.prevX, ent.z - ent.prevZ);
            if (horizSpeed > 0.005) {
                ent.walkPhase += horizSpeed * 5.0;
            }

            // 周囲の天空光＋ブロック光に合わせて個体カラーを明暗調整
            const lit = getLightBrightnessAt(Math.floor(ent.x), Math.floor(ent.y + ent.def.height * 0.5), Math.floor(ent.z));
            const mats = ent.mesh.userData.partMaterials;
            if (mats) {
                for (let m = 0; m < mats.length; m++) {
                    const bc = mats[m].userData.baseColor;
                    mats[m].color.setRGB(bc.r * lit, bc.g * lit, bc.b * lit);
                }
            }
        }
    }

    /**
     * 毎フレームの高 FPS 補間描画（20TPS -> 60/144fps 滑らか移動＆脚振りアニメーション）
     */
    function updateRenderInterpolation(alpha) {
        const t = alpha < 0 ? 0 : (alpha > 1 ? 1 : alpha);
        for (let i = 0; i < entities.length; i++) {
            const ent = entities[i];
            if (!ent.mesh.visible) continue;

            const rx = ent.prevX + (ent.x - ent.prevX) * t;
            const ry = ent.prevY + (ent.y - ent.prevY) * t;
            const rz = ent.prevZ + (ent.z - ent.prevZ) * t;
            ent.mesh.position.set(rx, ry, rz);

            let dyaw = ent.yaw - ent.prevYaw;
            while (dyaw > Math.PI) dyaw -= Math.PI * 2;
            while (dyaw < -Math.PI) dyaw += Math.PI * 2;
            ent.mesh.rotation.y = ent.prevYaw + dyaw * t;

            const limbs = ent.mesh.userData.limbMeshes;
            if (limbs && limbs.length > 0) {
                const swing = Math.sin(ent.walkPhase) * 0.5;
                for (let l = 0; l < limbs.length; l++) {
                    limbs[l].rotation.x = (l % 2 === 0) ? swing : -swing;
                }
            }
        }
    }

    /**
     * 指定ワールド AABB に重なるモブが存在するか判定（感圧板・トリップワイヤー連携用）
     */
    function isAnyEntityInBox(minX, minY, minZ, maxX, maxY, maxZ) {
        for (let i = 0; i < entities.length; i++) {
            const ent = entities[i];
            const hw = ent.def.width * 0.5;
            if (
                ent.x + hw > minX && ent.x - hw < maxX &&
                ent.y + ent.def.height > minY && ent.y < maxY &&
                ent.z + hw > minZ && ent.z - hw < maxZ
            ) {
                return true;
            }
        }
        return false;
    }

    function exportState() {
        const out = [];
        for (let i = 0; i < entities.length; i++) {
            const e = entities[i];
            out.push({
                uuid: e.uuid,
                id: e.type,
                Pos: [e.x, e.y, e.z],
                Motion: [e.vx, e.vy, e.vz],
                Rotation: [e.yaw, 0],
                Health: e.health,
                Age: e.age,
                CustomName: e.customName
            });
        }
        return out;
    }

    function importState(savedList) {
        clear();
        if (!Array.isArray(savedList)) return;
        for (let i = 0; i < savedList.length; i++) {
            const s = savedList[i];
            if (!s || typeof s.id !== "string" || !Array.isArray(s.Pos) || s.Pos.length < 3) continue;
            spawn(s.id, s.Pos[0], s.Pos[1], s.Pos[2], {
                uuid: s.uuid,
                vx: Array.isArray(s.Motion) ? s.Motion[0] : 0,
                vy: Array.isArray(s.Motion) ? s.Motion[1] : 0,
                vz: Array.isArray(s.Motion) ? s.Motion[2] : 0,
                yaw: Array.isArray(s.Rotation) ? s.Rotation[0] : 0,
                health: s.Health,
                age: s.Age,
                customName: s.CustomName
            });
        }
    }

    return {
        MOB_TYPES,
        get entities() { return entities; },
        get count() { return entities.length; },
        spawn,
        removeByUuid,
        clear,
        tick,
        updateRenderInterpolation,
        isAnyEntityInBox,
        exportState,
        importState
    };
}