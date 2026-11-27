"use strict";
import * as THREE from '../build/three.module.js';
import {
    getRawBlockId,
    getRawLocalState,
    getTransformMeta
} from '../blockstate.js';
import {
    getCollisionBoxesReadOnly,
    getSelectionBoxesReadOnly,
    applyRotationToCollisionBox
} from '../blocks.js';

/* ======================================================
   【プレイヤー物理・衝突解決・統一ボクセルレイキャスト】(core/physics_engine.js)
   - 解析的軸別スイープ衝突解決（段差登り・スニーク落下防止・めり込み脱出）
   - 通常 / 飛行 / 水中 / ハシゴ物理（真上・真下向き耐性 yaw 直接計算）
   - ゼロGC 3D DDA ＋ 実形状 Slab法レイキャスト
   ====================================================== */

export const COLLISION_MARGIN = 0.005;
export const PLAYER_RADIUS = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const SNEAK_HEIGHT = 1.65;

const JUMP_INITIAL_SPEED = 0.2;
const UP_DECEL = 0.018;
const DOWN_ACCEL = 0.007;
const MAX_FALL_SPEED = -1;

const FLIGHT_SPEED = 0.225;
const NORMAL_DASH_MULTIPLIER = 0.130;
const FLIGHT_DASH_MULTIPLIER = 0.350;
const WALK_SPEED = 0.08;

const MAX_STEP_HEIGHT = 0.6;
const SNEAK_BACKOFF_STEP = 0.05;
const COLL_OVERLAP_EPS = 1e-6;
const COLL_SNAP_EPS = 1e-4;
const MAX_COLL_BOXES = 512;
const PHYSICS_STEP_DT = 1;

const COLLISION_DIRECTIONS = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, -1, 0)
];

export function createPhysicsEngine(deps) {
    const {
        CHUNK_HEIGHT,
        BLOCK_TYPES,
        player,
        camera,
        keys,
        blockConfigFastArray,
        getVoxelAtWorld,
        getChunkBlock,
        getChunkCoord,
        getYaw,
        getSneakActive,
        getDashActive,
        getFlightMode,
        getWasUnderwater,
        getJumpRequest,
        setJumpRequest
    } = deps;

    let jumpCooldown = 0;

    // --- GC防止用 再利用オブジェクト・バッファ群 ---
    const _tempAABB = new THREE.Box3();
    const _collBoxes = new Float64Array(MAX_COLL_BOXES * 6);
    const _collRotBox = new THREE.Box3();
    const _moveTempVec = new THREE.Vector3();
    const _playerSizeTmp = { h: PLAYER_HEIGHT, r: PLAYER_RADIUS - COLLISION_MARGIN };
    const _backoffOut = { dx: 0, dz: 0 };

    const _vForward = new THREE.Vector3();
    const _vRight = new THREE.Vector3();
    const _vDesired = new THREE.Vector3();
    const _tmpDesiredVel = new THREE.Vector3();
    const _ladderSizeTmp = { h: PLAYER_HEIGHT, r: PLAYER_RADIUS };
    const _ladderRotBox = new THREE.Box3();
    const _groundProbeBox = new THREE.Box3();

    const _swimForward = new THREE.Vector3();
    const _swimRight = new THREE.Vector3();
    const _swimVel = new THREE.Vector3();
    const _swimLookDir = new THREE.Vector3();
    const _waterSamplePoints = Array.from({ length: 6 }, () => new THREE.Vector3());
    const _waterCellCache = new Map();

    const _rayDirTmp = new THREE.Vector3();
    const _rayRotatedBoxTmp = new THREE.Box3();
    const _sharedRaycastHit = {
        hit: false,
        x: 0,
        y: 0,
        z: 0,
        normal: new THREE.Vector3(),
        point: new THREE.Vector3(),
        distance: 0,
        rawVoxel: 0,
        blockId: 0,
        metadata: 0
    };

    function getCurrentPlayerHeight() {
        return getSneakActive() ? SNEAK_HEIGHT : PLAYER_HEIGHT;
    }

    function getPlayerAABB(pos = player.position, size = null) {
        const h = (size !== null) ? size.h : getCurrentPlayerHeight();
        const r = (size !== null) ? size.r : (PLAYER_RADIUS - COLLISION_MARGIN);

        let feetY = pos.y;
        if (player.positionIsCenter === true) {
            feetY -= (h * 0.5);
        }

        const min = _tempAABB.min;
        const max = _tempAABB.max;

        min.x = pos.x - r;
        min.y = feetY;
        min.z = pos.z - r;

        max.x = pos.x + r;
        max.y = feetY + h;
        max.z = pos.z + r;

        return _tempAABB;
    }

    // ======================================================
    // 1. 衝突ボックス収集・解析的軸別クリップ
    // ======================================================
    function collectCollisionBoxes(sMinX, sMinY, sMinZ, sMaxX, sMaxY, sMaxZ) {
        const ix0 = Math.floor(sMinX) | 0;
        const ix1 = Math.floor(sMaxX) | 0;
        const iy0 = Math.floor(sMinY - 0.55) | 0;
        const iy1 = Math.floor(sMaxY) | 0;
        const iz0 = Math.floor(sMinZ) | 0;
        const iz1 = Math.floor(sMaxZ) | 0;

        let count = 0;
        let ptr = 0;

        for (let y = iy0; y <= iy1; y = (y + 1) | 0) {
            if (y < 0 || y >= CHUNK_HEIGHT) continue;
            for (let x = ix0; x <= ix1; x = (x + 1) | 0) {
                for (let z = iz0; z <= iz1; z = (z + 1) | 0) {
                    const rawVoxel = getVoxelAtWorld(x, y, z, true) | 0;
                    if (rawVoxel <= 0) continue;

                    const id = getRawBlockId(rawVoxel);
                    const cfg = blockConfigFastArray[id];
                    if (!cfg || cfg.collision === false) continue;

                    const gType = cfg.geometryType;
                    if (!gType || gType === "cube" || gType === "leaves") {
                        if (count >= MAX_COLL_BOXES) return count;
                        _collBoxes[ptr] = x;
                        _collBoxes[ptr + 1] = y;
                        _collBoxes[ptr + 2] = z;
                        _collBoxes[ptr + 3] = x + 1;
                        _collBoxes[ptr + 4] = y + 1;
                        _collBoxes[ptr + 5] = z + 1;
                        ptr += 6;
                        count++;
                        continue;
                    }

                    const meta = getRawLocalState(rawVoxel);
                    const relBoxes = getCollisionBoxesReadOnly(gType, meta);
                    const tMeta = getTransformMeta(id, meta);

                    for (let j = 0, len = relBoxes.length; j < len; j++) {
                        if (count >= MAX_COLL_BOXES) return count;
                        let src = relBoxes[j];
                        if (tMeta !== 0) {
                            applyRotationToCollisionBox(src, tMeta, _collRotBox);
                            src = _collRotBox;
                        }
                        _collBoxes[ptr] = x + src.min.x;
                        _collBoxes[ptr + 1] = y + src.min.y;
                        _collBoxes[ptr + 2] = z + src.min.z;
                        _collBoxes[ptr + 3] = x + src.max.x;
                        _collBoxes[ptr + 4] = y + src.max.y;
                        _collBoxes[ptr + 5] = z + src.max.z;
                        ptr += 6;
                        count++;
                    }
                }
            }
        }

        return count;
    }

    function clipAxisY(aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ, dy, boxCount) {
        if (dy === 0 || boxCount === 0) return dy;

        for (let i = 0, ptr = 0; i < boxCount; i++, ptr += 6) {
            if (
                aMaxX <= _collBoxes[ptr] + COLL_OVERLAP_EPS ||
                aMinX >= _collBoxes[ptr + 3] - COLL_OVERLAP_EPS ||
                aMaxZ <= _collBoxes[ptr + 2] + COLL_OVERLAP_EPS ||
                aMinZ >= _collBoxes[ptr + 5] - COLL_OVERLAP_EPS
            ) continue;

            if (dy > 0) {
                const bMinY = _collBoxes[ptr + 1];
                if (bMinY >= aMaxY - COLL_SNAP_EPS) {
                    const diff = bMinY - aMaxY;
                    if (diff < dy) dy = diff > 0 ? diff : 0;
                }
            } else {
                const bMaxY = _collBoxes[ptr + 4];
                if (bMaxY <= aMinY + COLL_SNAP_EPS) {
                    const diff = bMaxY - aMinY;
                    if (diff > dy) dy = diff < 0 ? diff : 0;
                }
            }
        }
        return dy;
    }

    function clipAxisX(aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ, dx, boxCount) {
        if (dx === 0 || boxCount === 0) return dx;

        for (let i = 0, ptr = 0; i < boxCount; i++, ptr += 6) {
            if (
                aMaxY <= _collBoxes[ptr + 1] + COLL_OVERLAP_EPS ||
                aMinY >= _collBoxes[ptr + 4] - COLL_OVERLAP_EPS ||
                aMaxZ <= _collBoxes[ptr + 2] + COLL_OVERLAP_EPS ||
                aMinZ >= _collBoxes[ptr + 5] - COLL_OVERLAP_EPS
            ) continue;

            if (dx > 0) {
                const bMinX = _collBoxes[ptr];
                if (bMinX >= aMaxX - COLL_SNAP_EPS) {
                    const diff = bMinX - aMaxX;
                    if (diff < dx) dx = diff > 0 ? diff : 0;
                }
            } else {
                const bMaxX = _collBoxes[ptr + 3];
                if (bMaxX <= aMinX + COLL_SNAP_EPS) {
                    const diff = bMaxX - aMinX;
                    if (diff > dx) dx = diff < 0 ? diff : 0;
                }
            }
        }
        return dx;
    }

    function clipAxisZ(aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ, dz, boxCount) {
        if (dz === 0 || boxCount === 0) return dz;

        for (let i = 0, ptr = 0; i < boxCount; i++, ptr += 6) {
            if (
                aMaxX <= _collBoxes[ptr] + COLL_OVERLAP_EPS ||
                aMinX >= _collBoxes[ptr + 3] - COLL_OVERLAP_EPS ||
                aMaxY <= _collBoxes[ptr + 1] + COLL_OVERLAP_EPS ||
                aMinY >= _collBoxes[ptr + 4] - COLL_OVERLAP_EPS
            ) continue;

            if (dz > 0) {
                const bMinZ = _collBoxes[ptr + 2];
                if (bMinZ >= aMaxZ - COLL_SNAP_EPS) {
                    const diff = bMinZ - aMaxZ;
                    if (diff < dz) dz = diff > 0 ? diff : 0;
                }
            } else {
                const bMaxZ = _collBoxes[ptr + 5];
                if (bMaxZ <= aMinZ + COLL_SNAP_EPS) {
                    const diff = bMaxZ - aMinZ;
                    if (diff > dz) dz = diff < 0 ? diff : 0;
                }
            }
        }
        return dz;
    }

    function hasOverlapInBuffer(minX, minY, minZ, maxX, maxY, maxZ, boxCount) {
        for (let i = 0, ptr = 0; i < boxCount; i++, ptr += 6) {
            if (
                maxX > _collBoxes[ptr] + COLL_OVERLAP_EPS &&
                minX < _collBoxes[ptr + 3] - COLL_OVERLAP_EPS &&
                maxY > _collBoxes[ptr + 1] + COLL_OVERLAP_EPS &&
                minY < _collBoxes[ptr + 4] - COLL_OVERLAP_EPS &&
                maxZ > _collBoxes[ptr + 2] + COLL_OVERLAP_EPS &&
                minZ < _collBoxes[ptr + 5] - COLL_OVERLAP_EPS
            ) {
                return true;
            }
        }
        return false;
    }

    function checkAABBCollision(aabb) {
        const aMinX = aabb.min.x, aMinY = aabb.min.y, aMinZ = aabb.min.z;
        const aMaxX = aabb.max.x, aMaxY = aabb.max.y, aMaxZ = aabb.max.z;

        const ix0 = Math.floor(aMinX) | 0;
        const ix1 = Math.floor(aMaxX) | 0;
        const iy0 = Math.floor(aMinY - 0.55) | 0;
        const iy1 = Math.floor(aMaxY) | 0;
        const iz0 = Math.floor(aMinZ) | 0;
        const iz1 = Math.floor(aMaxZ) | 0;

        for (let y = iy0; y <= iy1; y = (y + 1) | 0) {
            if (y < 0 || y >= CHUNK_HEIGHT) continue;
            for (let x = ix0; x <= ix1; x = (x + 1) | 0) {
                for (let z = iz0; z <= iz1; z = (z + 1) | 0) {
                    const rawVoxel = getVoxelAtWorld(x, y, z, true) | 0;
                    if (rawVoxel <= 0) continue;

                    const id = getRawBlockId(rawVoxel);
                    const cfg = blockConfigFastArray[id];
                    if (!cfg || cfg.collision === false) continue;

                    const gType = cfg.geometryType;
                    if (!gType || gType === "cube" || gType === "leaves") {
                        if (
                            aMaxX > x + COLL_OVERLAP_EPS && aMinX < x + 1 - COLL_OVERLAP_EPS &&
                            aMaxY > y + COLL_OVERLAP_EPS && aMinY < y + 1 - COLL_OVERLAP_EPS &&
                            aMaxZ > z + COLL_OVERLAP_EPS && aMinZ < z + 1 - COLL_OVERLAP_EPS
                        ) {
                            return true;
                        }
                        continue;
                    }

                    const meta = getRawLocalState(rawVoxel);
                    const relBoxes = getCollisionBoxesReadOnly(gType, meta);
                    const tMeta = getTransformMeta(id, meta);

                    for (let j = 0, len = relBoxes.length; j < len; j++) {
                        let src = relBoxes[j];
                        if (tMeta !== 0) {
                            applyRotationToCollisionBox(src, tMeta, _collRotBox);
                            src = _collRotBox;
                        }
                        if (
                            aMaxX > x + src.min.x + COLL_OVERLAP_EPS && aMinX < x + src.max.x - COLL_OVERLAP_EPS &&
                            aMaxY > y + src.min.y + COLL_OVERLAP_EPS && aMinY < y + src.max.y - COLL_OVERLAP_EPS &&
                            aMaxZ > z + src.min.z + COLL_OVERLAP_EPS && aMinZ < z + src.max.z - COLL_OVERLAP_EPS
                        ) {
                            return true;
                        }
                    }
                }
            }
        }

        return false;
    }

    function backOffFromEdge(aMinX, aMinY, aMinZ, aMaxX, aMaxZ, dx, dz, boxCount) {
        const checkMinY = aMinY - MAX_STEP_HEIGHT;
        const checkMaxY = aMinY - 1e-4;

        while (dx !== 0 && !hasOverlapInBuffer(aMinX + dx, checkMinY, aMinZ, aMaxX + dx, checkMaxY, aMaxZ, boxCount)) {
            if (dx < SNEAK_BACKOFF_STEP && dx >= -SNEAK_BACKOFF_STEP) dx = 0;
            else if (dx > 0) dx -= SNEAK_BACKOFF_STEP;
            else dx += SNEAK_BACKOFF_STEP;
        }

        while (dz !== 0 && !hasOverlapInBuffer(aMinX, checkMinY, aMinZ + dz, aMaxX, checkMaxY, aMaxZ + dz, boxCount)) {
            if (dz < SNEAK_BACKOFF_STEP && dz >= -SNEAK_BACKOFF_STEP) dz = 0;
            else if (dz > 0) dz -= SNEAK_BACKOFF_STEP;
            else dz += SNEAK_BACKOFF_STEP;
        }

        while (dx !== 0 && dz !== 0 && !hasOverlapInBuffer(aMinX + dx, checkMinY, aMinZ + dz, aMaxX + dx, checkMaxY, aMaxZ + dz, boxCount)) {
            if (dx < SNEAK_BACKOFF_STEP && dx >= -SNEAK_BACKOFF_STEP) dx = 0;
            else if (dx > 0) dx -= SNEAK_BACKOFF_STEP;
            else dx += SNEAK_BACKOFF_STEP;

            if (dz < SNEAK_BACKOFF_STEP && dz >= -SNEAK_BACKOFF_STEP) dz = 0;
            else if (dz > 0) dz -= SNEAK_BACKOFF_STEP;
            else dz += SNEAK_BACKOFF_STEP;
        }

        _backoffOut.dx = dx;
        _backoffOut.dz = dz;
        return _backoffOut;
    }

    function axisSeparatedCollisionResolve(dt) {
        const pos = player.position;
        const vel = player.velocity;

        let dx = vel.x * dt;
        let dy = vel.y * dt;
        let dz = vel.z * dt;

        if (dx === 0 && dy === 0 && dz === 0) return;

        const aabb = getPlayerAABB(pos);
        const oMinX = aabb.min.x, oMinY = aabb.min.y, oMinZ = aabb.min.z;
        const oMaxX = aabb.max.x, oMaxY = aabb.max.y, oMaxZ = aabb.max.z;

        const flightMode = getFlightMode();
        const sneakActive = getSneakActive();
        const wasUnderwater = getWasUnderwater();
        const allowStep = !flightMode;
        const allowSneakGuard = sneakActive && !flightMode && player.onGround;

        const sMinX = (dx < 0 ? oMinX + dx : oMinX) - 0.05;
        const sMaxX = (dx > 0 ? oMaxX + dx : oMaxX) + 0.05;
        const sMinY = (dy < 0 ? oMinY + dy : oMinY) - (allowSneakGuard ? MAX_STEP_HEIGHT : 0) - 0.05;
        const sMaxY = (dy > 0 ? oMaxY + dy : oMaxY) + (allowStep ? MAX_STEP_HEIGHT : 0) + 0.05;
        const sMinZ = (dz < 0 ? oMinZ + dz : oMinZ) - 0.05;
        const sMaxZ = (dz > 0 ? oMaxZ + dz : oMaxZ) + 0.05;

        const boxCount = collectCollisionBoxes(sMinX, sMinY, sMinZ, sMaxX, sMaxY, sMaxZ);

        if (allowSneakGuard && (dx !== 0 || dz !== 0)) {
            const backed = backOffFromEdge(oMinX, oMinY, oMinZ, oMaxX, oMaxZ, dx, dz, boxCount);
            if (backed.dx !== dx) { dx = backed.dx; vel.x = 0; }
            if (backed.dz !== dz) { dz = backed.dz; vel.z = 0; }
        }

        let resY = clipAxisY(oMinX, oMinY, oMinZ, oMaxX, oMaxY, oMaxZ, dy, boxCount);
        const yMinY = oMinY + resY;
        const yMaxY = oMaxY + resY;

        const zFirst = Math.abs(dz) > Math.abs(dx);
        let resX, resZ;

        if (zFirst) {
            resZ = clipAxisZ(oMinX, yMinY, oMinZ, oMaxX, yMaxY, oMaxZ, dz, boxCount);
            resX = clipAxisX(oMinX, yMinY, oMinZ + resZ, oMaxX, yMaxY, oMaxZ + resZ, dx, boxCount);
        } else {
            resX = clipAxisX(oMinX, yMinY, oMinZ, oMaxX, yMaxY, oMaxZ, dx, boxCount);
            resZ = clipAxisZ(oMinX + resX, yMinY, oMinZ, oMaxX + resX, yMaxY, oMaxZ, dz, boxCount);
        }

        const hitGround = (dy < 0 && Math.abs(dy - resY) > 1e-6);
        const hitCeiling = (dy > 0 && Math.abs(dy - resY) > 1e-6);
        let hitX = Math.abs(dx - resX) > 1e-6;
        let hitZ = Math.abs(dz - resZ) > 1e-6;

        let steppedUp = false;
        if (allowStep && (player.onGround || hitGround || wasUnderwater) && (hitX || hitZ)) {
            const upY = clipAxisY(oMinX, oMinY, oMinZ, oMaxX, oMaxY, oMaxZ, MAX_STEP_HEIGHT, boxCount);
            if (upY > 1e-4) {
                const upMinY = oMinY + upY;
                const upMaxY = oMaxY + upY;

                let stepX, stepZ;
                if (zFirst) {
                    stepZ = clipAxisZ(oMinX, upMinY, oMinZ, oMaxX, upMaxY, oMaxZ, dz, boxCount);
                    stepX = clipAxisX(oMinX, upMinY, oMinZ + stepZ, oMaxX, upMaxY, oMaxZ + stepZ, dx, boxCount);
                } else {
                    stepX = clipAxisX(oMinX, upMinY, oMinZ, oMaxX, upMaxY, oMaxZ, dx, boxCount);
                    stepZ = clipAxisZ(oMinX + stepX, upMinY, oMinZ, oMaxX + stepX, upMaxY, oMaxZ, dz, boxCount);
                }

                if ((stepX * stepX + stepZ * stepZ) > (resX * resX + resZ * resZ) + 1e-8) {
                    const downTarget = (dy < 0 ? dy : 0) - upY;
                    const downY = clipAxisY(
                        oMinX + stepX, upMinY, oMinZ + stepZ,
                        oMaxX + stepX, upMaxY, oMaxZ + stepZ,
                        downTarget, boxCount
                    );
                    resX = stepX;
                    resZ = stepZ;
                    resY = upY + downY;
                    hitX = Math.abs(dx - resX) > 1e-6;
                    hitZ = Math.abs(dz - resZ) > 1e-6;
                    steppedUp = true;
                }
            }
        }

        pos.x += resX;
        pos.y += resY;
        pos.z += resZ;

        if (hitX) vel.x = 0;
        if (hitZ) vel.z = 0;
        if (hitGround || hitCeiling || (steppedUp && !wasUnderwater)) vel.y = 0;
        else if (steppedUp && wasUnderwater && vel.y < 0) vel.y = 0;
        if (hitGround || steppedUp) player.onGround = true;
    }

    function resolvePlayerCollision() {
        axisSeparatedCollisionResolve(PHYSICS_STEP_DT);

        _playerSizeTmp.h = getCurrentPlayerHeight();
        _playerSizeTmp.r = PLAYER_RADIUS - COLLISION_MARGIN;

        if (!checkAABBCollision(getPlayerAABB(player.position, _playerSizeTmp))) return;

        let bestDir = null;
        let bestDist = Infinity;

        for (let i = 0; i < COLLISION_DIRECTIONS.length; i++) {
            const dir = COLLISION_DIRECTIONS[i];
            let low = 0, high = 1.0;
            let foundDist = null;

            for (let j = 0; j < 8; j++) {
                const mid = (low + high) * 0.5;
                _moveTempVec.copy(player.position).addScaledVector(dir, mid);

                if (!checkAABBCollision(getPlayerAABB(_moveTempVec, _playerSizeTmp))) {
                    foundDist = mid;
                    high = mid;
                } else {
                    low = mid;
                }
            }

            if (foundDist !== null && foundDist < bestDist) {
                bestDist = foundDist;
                bestDir = dir;
                if (bestDist < 0.01) break;
            }
        }

        if (bestDir) {
            player.position.addScaledVector(bestDir, bestDist);
        } else if (!getWasUnderwater() && !getFlightMode()) {
            player.position.y += 0.1;
        }
    }

    // ======================================================
    // 2. 移動・重力・ハシゴ・飛行・水中物理
    // ======================================================
    function getDesiredHorizontalVelocity(multiplier = 1) {
        const yaw = getYaw();
        const sinY = Math.sin(yaw);
        const cosY = Math.cos(yaw);
        _vForward.set(-sinY, 0, -cosY);
        _vRight.set(cosY, 0, -sinY);

        _vDesired.set(0, 0, 0);
        if (keys["w"] || keys["arrowup"]) _vDesired.add(_vForward);
        if (keys["s"] || keys["arrowdown"]) _vDesired.addScaledVector(_vForward, -1);
        if (keys["a"] || keys["arrowleft"]) _vDesired.addScaledVector(_vRight, -1);
        if (keys["d"] || keys["arrowright"]) _vDesired.add(_vRight);

        if (_vDesired.lengthSq() > 0) {
            _vDesired.normalize().multiplyScalar(multiplier);
        }
        return _vDesired;
    }

    function isOnLadder() {
        _ladderSizeTmp.h = getCurrentPlayerHeight();
        _ladderSizeTmp.r = PLAYER_RADIUS;

        const aabb = getPlayerAABB(player.position, _ladderSizeTmp);
        const pMinX = aabb.min.x - 0.05, pMaxX = aabb.max.x + 0.05;
        const pMinY = aabb.min.y, pMaxY = aabb.max.y;
        const pMinZ = aabb.min.z - 0.05, pMaxZ = aabb.max.z + 0.05;

        const minX = Math.floor(pMinX) | 0;
        const maxX = Math.floor(pMaxX) | 0;
        const minY = Math.floor(pMinY) | 0;
        const maxY = Math.floor(pMaxY) | 0;
        const minZ = Math.floor(pMinZ) | 0;
        const maxZ = Math.floor(pMaxZ) | 0;

        const ladderId = BLOCK_TYPES.LADDER;
        const ladderBoxes = getCollisionBoxesReadOnly("ladder", 0);

        for (let y = minY; y <= maxY; y = (y + 1) | 0) {
            if (y < 0 || y >= CHUNK_HEIGHT) continue;
            for (let x = minX; x <= maxX; x = (x + 1) | 0) {
                for (let z = minZ; z <= maxZ; z = (z + 1) | 0) {
                    const voxel = getVoxelAtWorld(x, y, z, true) | 0;
                    if (getRawBlockId(voxel) !== ladderId) continue;

                    const meta = getRawLocalState(voxel);
                    const tMeta = getTransformMeta(ladderId, meta);
                    for (let i = 0; i < ladderBoxes.length; i++) {
                        let box = ladderBoxes[i];
                        if (tMeta !== 0) {
                            applyRotationToCollisionBox(box, tMeta, _ladderRotBox);
                            box = _ladderRotBox;
                        }
                        if (
                            pMaxX > x + box.min.x && pMinX < x + box.max.x &&
                            pMaxY > y + box.min.y && pMinY < y + box.max.y &&
                            pMaxZ > z + box.min.z && pMinZ < z + box.max.z
                        ) {
                            return true;
                        }
                    }
                }
            }
        }
        return false;
    }

    function updateNormalPhysics() {
        const dashActive = getDashActive();
        const sneakActive = getSneakActive();
        const flightMode = getFlightMode();
        const wasUnderwater = getWasUnderwater();

        let speed = dashActive ? NORMAL_DASH_MULTIPLIER : WALK_SPEED;
        if (sneakActive) speed *= 0.3;

        getDesiredHorizontalVelocity(speed);
        _tmpDesiredVel.copy(_vDesired);

        const lerpFactor = player.onGround ? 0.2 : 0.05;
        player.velocity.x += (_tmpDesiredVel.x - player.velocity.x) * lerpFactor;
        player.velocity.z += (_tmpDesiredVel.z - player.velocity.z) * lerpFactor;

        if (Math.abs(player.velocity.x) < 0.001) player.velocity.x = 0;
        if (Math.abs(player.velocity.z) < 0.001) player.velocity.z = 0;

        const onLadder = isOnLadder();
        if (onLadder) {
            player.velocity.y = 0;
            if (keys["w"] || keys["arrowup"] || keys[" "]) {
                player.velocity.y = 0.05;
            } else if (keys["s"] || keys["arrowdown"]) {
                player.velocity.y = -0.05;
            } else if (sneakActive) {
                player.velocity.y = 0;
            } else {
                player.velocity.y = -0.05;
            }
            setJumpRequest(false);
        } else if (!flightMode) {
            if (player.velocity.y >= 0) {
                player.velocity.y -= UP_DECEL;
            } else {
                player.velocity.y -= DOWN_ACCEL;
                if (player.velocity.y < MAX_FALL_SPEED) {
                    player.velocity.y = MAX_FALL_SPEED;
                }
            }
        }

        if (jumpCooldown > 0) jumpCooldown--;

        if (getJumpRequest() && player.onGround && !flightMode && !wasUnderwater && jumpCooldown === 0 && !onLadder) {
            if (dashActive) {
                player.velocity.x *= 1.1;
                player.velocity.z *= 1.1;
            }
            player.velocity.y = JUMP_INITIAL_SPEED;
            player.onGround = false;
            setJumpRequest(false);
            jumpCooldown = 10;
        }
    }

    function updateFlightPhysics() {
        const flightMode = getFlightMode();
        const dashActive = getDashActive();

        let baseSpeed = WALK_SPEED;
        if (flightMode && !dashActive) baseSpeed = 0.15;
        const speed = dashActive ? FLIGHT_DASH_MULTIPLIER : baseSpeed;
        const accel = flightMode ? 0.05 : 0.5;

        const desiredVel = getDesiredHorizontalVelocity(speed);
        _tmpDesiredVel.copy(desiredVel);

        player.velocity.x += (_tmpDesiredVel.x - player.velocity.x) * accel;
        player.velocity.z += (_tmpDesiredVel.z - player.velocity.z) * accel;

        let targetVertical = 0;
        if (keys[" "] || keys["spacebar"]) {
            targetVertical = FLIGHT_SPEED * 0.75;
        } else if (keys["shift"] && flightMode) {
            targetVertical = -FLIGHT_SPEED * 0.75;
        }

        const verticalAccel = (targetVertical === 0) ? 0.06 : 0.3;
        player.velocity.y += (targetVertical - player.velocity.y) * verticalAccel;
    }

    function updateOnGround() {
        const aabb = getPlayerAABB(player.position);
        _groundProbeBox.min.set(aabb.min.x, aabb.min.y - 0.002, aabb.min.z);
        _groundProbeBox.max.set(aabb.max.x, aabb.min.y + 0.001, aabb.max.z);
        player.onGround = checkAABBCollision(_groundProbeBox);
    }

    function isPlayerEntireBodyInWater() {
        const { min, max } = getPlayerAABB();
        const midY = (min.y + max.y) / 2;
        const topY = max.y - 0.1;

        _waterSamplePoints[0].set(min.x, min.y, min.z);
        _waterSamplePoints[1].set(max.x, min.y, min.z);
        _waterSamplePoints[2].set(min.x, min.y, max.z);
        _waterSamplePoints[3].set(max.x, min.y, max.z);
        _waterSamplePoints[4].set((min.x + max.x) / 2, midY, (min.z + max.z) / 2);
        _waterSamplePoints[5].set((min.x + max.x) / 2, topY, (min.z + max.z) / 2);

        let waterCount = 0;
        let isHeadInWater = false;
        _waterCellCache.clear();

        for (let i = 0; i < 6; i++) {
            const point = _waterSamplePoints[i];
            const x = Math.floor(point.x);
            const y = Math.floor(point.y);
            const z = Math.floor(point.z);

            const ox = x + 30000;
            const oz = z + 30000;
            const numericKey = ox + oz * 100000 + (y + 100) * 10000000000;

            let blockValue = _waterCellCache.get(numericKey);
            if (blockValue === undefined) {
                const cx = getChunkCoord(x);
                const cz = getChunkCoord(z);
                blockValue = getChunkBlock(cx, cz, x & 15, y, z & 15) ?? getVoxelAtWorld(x, y, z, true);
                _waterCellCache.set(numericKey, blockValue);
            }

            const blockId = getRawBlockId(blockValue);
            const isWater = (blockId === BLOCK_TYPES.WATER || blockId === BLOCK_TYPES.LAVA);

            if (i < 5) {
                if (isWater) waterCount++;
            } else {
                isHeadInWater = isWater;
            }
        }

        return (waterCount > 0) || isHeadInWater;
    }

    function updateUnderwaterPhysics() {
        const TARGET_SWIM_SPEED = 0.08;
        const DASH_MULTIPLIER = 1.6;
        const ACCELERATION = 0.15;
        const WATER_DRAG = 0.08;
        const NATURAL_SINK_SPEED = -0.10;

        const effectiveSpeed = getDashActive() ? TARGET_SWIM_SPEED * DASH_MULTIPLIER : TARGET_SWIM_SPEED;

        const yaw = getYaw();
        const sinY = Math.sin(yaw);
        const cosY = Math.cos(yaw);
        _swimForward.set(-sinY, 0, -cosY);
        _swimRight.set(cosY, 0, -sinY);
        _swimVel.set(0, 0, 0);

        if (keys["w"] || keys["arrowup"]) _swimVel.add(_swimForward);
        if (keys["s"] || keys["arrowdown"]) _swimVel.sub(_swimForward);
        if (keys["d"] || keys["arrowright"]) _swimVel.add(_swimRight);
        if (keys["a"] || keys["arrowleft"]) _swimVel.sub(_swimRight);

        if (_swimVel.lengthSq() > 0) {
            _swimVel.normalize().multiplyScalar(effectiveSpeed);
        }

        camera.getWorldDirection(_swimLookDir);
        if (keys["w"] || keys["arrowup"]) {
            _swimVel.y += _swimLookDir.y * effectiveSpeed;
        }

        if (keys[" "]) {
            _swimVel.y = effectiveSpeed;
        } else if (keys["shift"]) {
            _swimVel.y = -effectiveSpeed;
        } else if (!keys["w"] && !keys["arrowup"]) {
            _swimVel.y = NATURAL_SINK_SPEED;
        }

        player.velocity.x = THREE.MathUtils.lerp(player.velocity.x, _swimVel.x, ACCELERATION);
        player.velocity.z = THREE.MathUtils.lerp(player.velocity.z, _swimVel.z, ACCELERATION);
        player.velocity.y = THREE.MathUtils.lerp(player.velocity.y, _swimVel.y, 0.04);
        player.velocity.multiplyScalar(1 - WATER_DRAG);
    }

    // ======================================================
    // 3. 統一ゼロGC ボクセルレイキャスト (3D DDA ＋ Slab法)
    // ======================================================
    function rayIntersectVoxelBoxes(ox, oy, oz, dx, dy, dz, bx, by, bz, blockId, metadata, maxDistance, stepNx, stepNy, stepNz, outResult) {
        const boxes = getSelectionBoxesReadOnly(blockId, metadata);
        const len = boxes.length;
        const tMeta = getTransformMeta(blockId, metadata);

        const EPS_DIR = 1e-8;
        let bestT = maxDistance + 1.0;
        let bestNx = 0, bestNy = 0, bestNz = 0;
        let found = false;

        for (let i = 0; i < len; i++) {
            let box = boxes[i];
            if (tMeta !== 0) {
                applyRotationToCollisionBox(box, tMeta, _rayRotatedBoxTmp);
                box = _rayRotatedBoxTmp;
            }

            const minX = bx + box.min.x, maxX = bx + box.max.x;
            const minY = by + box.min.y, maxY = by + box.max.y;
            const minZ = bz + box.min.z, maxZ = bz + box.max.z;

            let tMinX, tMaxX, nxX;
            if (dx > EPS_DIR || dx < -EPS_DIR) {
                const invX = 1.0 / dx;
                const t1 = (minX - ox) * invX;
                const t2 = (maxX - ox) * invX;
                if (t1 <= t2) { tMinX = t1; tMaxX = t2; nxX = -1; }
                else { tMinX = t2; tMaxX = t1; nxX = 1; }
            } else {
                if (ox < minX || ox > maxX) continue;
                tMinX = -Infinity; tMaxX = Infinity; nxX = 0;
            }

            let tMinY, tMaxY, nyY;
            if (dy > EPS_DIR || dy < -EPS_DIR) {
                const invY = 1.0 / dy;
                const t1 = (minY - oy) * invY;
                const t2 = (maxY - oy) * invY;
                if (t1 <= t2) { tMinY = t1; tMaxY = t2; nyY = -1; }
                else { tMinY = t2; tMaxY = t1; nyY = 1; }
            } else {
                if (oy < minY || oy > maxY) continue;
                tMinY = -Infinity; tMaxY = Infinity; nyY = 0;
            }

            let tMinZ, tMaxZ, nzZ;
            if (dz > EPS_DIR || dz < -EPS_DIR) {
                const invZ = 1.0 / dz;
                const t1 = (minZ - oz) * invZ;
                const t2 = (maxZ - oz) * invZ;
                if (t1 <= t2) { tMinZ = t1; tMaxZ = t2; nzZ = -1; }
                else { tMinZ = t2; tMaxZ = t1; nzZ = 1; }
            } else {
                if (oz < minZ || oz > maxZ) continue;
                tMinZ = -Infinity; tMaxZ = Infinity; nzZ = 0;
            }

            let tEnter = tMinX;
            let hitNx = nxX, hitNy = 0, hitNz = 0;
            if (tMinY > tEnter) {
                tEnter = tMinY;
                hitNx = 0; hitNy = nyY; hitNz = 0;
            }
            if (tMinZ > tEnter) {
                tEnter = tMinZ;
                hitNx = 0; hitNy = 0; hitNz = nzZ;
            }

            const tExit = tMaxX < tMaxY ? (tMaxX < tMaxZ ? tMaxX : tMaxZ) : (tMaxY < tMaxZ ? tMaxY : tMaxZ);
            if (tExit < 0.0 || tEnter > tExit || tEnter > maxDistance) continue;

            let tHit = tEnter;
            if (tHit < 0.0) {
                tHit = 0.0;
                if (stepNx !== 0 || stepNy !== 0 || stepNz !== 0) {
                    hitNx = stepNx; hitNy = stepNy; hitNz = stepNz;
                } else {
                    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
                    if (ax >= ay && ax >= az) { hitNx = dx > 0 ? -1 : 1; hitNy = 0; hitNz = 0; }
                    else if (ay >= ax && ay >= az) { hitNx = 0; hitNy = dy > 0 ? -1 : 1; hitNz = 0; }
                    else { hitNx = 0; hitNy = 0; hitNz = dz > 0 ? -1 : 1; }
                }
            }

            if (tHit < bestT) {
                bestT = tHit;
                bestNx = hitNx;
                bestNy = hitNy;
                bestNz = hitNz;
                found = true;
            }
        }

        if (!found || bestT > maxDistance) return false;

        outResult.distance = bestT;
        outResult.normal.set(bestNx, bestNy, bestNz);
        outResult.point.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
        return true;
    }

    function raycastVoxel(origin, dir, maxDistance, includeWater = false, outResult = _sharedRaycastHit) {
        outResult.hit = false;

        const ox = origin.x, oy = origin.y, oz = origin.z;
        const dx = dir.x, dy = dir.y, dz = dir.z;
        if ((dx * dx + dy * dy + dz * dz) < 1e-12) return null;

        let x = Math.floor(ox);
        let y = Math.floor(oy);
        let z = Math.floor(oz);

        const EPS_DIR = 1e-8;
        let stepX = 0, tDeltaX = Infinity, tMaxX = Infinity;
        if (dx > EPS_DIR) {
            stepX = 1;
            tDeltaX = 1.0 / dx;
            tMaxX = (x + 1.0 - ox) * tDeltaX;
        } else if (dx < -EPS_DIR) {
            stepX = -1;
            tDeltaX = -1.0 / dx;
            tMaxX = (ox - x) * tDeltaX;
        }

        let stepY = 0, tDeltaY = Infinity, tMaxY = Infinity;
        if (dy > EPS_DIR) {
            stepY = 1;
            tDeltaY = 1.0 / dy;
            tMaxY = (y + 1.0 - oy) * tDeltaY;
        } else if (dy < -EPS_DIR) {
            stepY = -1;
            tDeltaY = -1.0 / dy;
            tMaxY = (oy - y) * tDeltaY;
        }

        let stepZ = 0, tDeltaZ = Infinity, tMaxZ = Infinity;
        if (dz > EPS_DIR) {
            stepZ = 1;
            tDeltaZ = 1.0 / dz;
            tMaxZ = (z + 1.0 - oz) * tDeltaZ;
        } else if (dz < -EPS_DIR) {
            stepZ = -1;
            tDeltaZ = -1.0 / dz;
            tMaxZ = (oz - z) * tDeltaZ;
        }

        let tCurrent = 0.0;
        let stepNx = 0, stepNy = 0, stepNz = 0;
        const maxSteps = Math.ceil(maxDistance * 3) + 4;

        for (let step = 0; step < maxSteps; step++) {
            if (tCurrent > maxDistance) break;

            if (y >= 0 && y < CHUNK_HEIGHT) {
                const rawVoxel = getVoxelAtWorld(x, y, z, true);
                const blockId = getRawBlockId(rawVoxel);

                if (blockId !== BLOCK_TYPES.SKY) {
                    const conf = blockConfigFastArray[blockId];
                    const isWaterTarget = includeWater && conf && conf.geometryType === "water";

                    if (conf && (conf.targetblock !== false || isWaterTarget)) {
                        const meta = getRawLocalState(rawVoxel);
                        if (rayIntersectVoxelBoxes(
                            ox, oy, oz, dx, dy, dz,
                            x, y, z, blockId, meta,
                            maxDistance, stepNx, stepNy, stepNz, outResult
                        )) {
                            outResult.hit = true;
                            outResult.x = x;
                            outResult.y = y;
                            outResult.z = z;
                            outResult.rawVoxel = rawVoxel;
                            outResult.blockId = blockId;
                            outResult.metadata = meta;
                            return outResult;
                        }
                    }
                }
            }

            if (tMaxX < tMaxY) {
                if (tMaxX < tMaxZ) {
                    tCurrent = tMaxX;
                    x += stepX;
                    tMaxX += tDeltaX;
                    stepNx = -stepX; stepNy = 0; stepNz = 0;
                } else {
                    tCurrent = tMaxZ;
                    z += stepZ;
                    tMaxZ += tDeltaZ;
                    stepNx = 0; stepNy = 0; stepNz = -stepZ;
                }
            } else {
                if (tMaxY < tMaxZ) {
                    tCurrent = tMaxY;
                    y += stepY;
                    tMaxY += tDeltaY;
                    stepNx = 0; stepNy = -stepY; stepNz = 0;
                } else {
                    tCurrent = tMaxZ;
                    z += stepZ;
                    tMaxZ += tDeltaZ;
                    stepNx = 0; stepNy = 0; stepNz = -stepZ;
                }
            }
        }

        return null;
    }

    function getTargetBlockByDDA(maxDistance, includeWater = false) {
        camera.getWorldDirection(_rayDirTmp);
        return raycastVoxel(camera.position, _rayDirTmp, maxDistance, includeWater);
    }

    return {
        getCurrentPlayerHeight,
        getPlayerAABB,
        checkAABBCollision,
        resolvePlayerCollision,
        updateNormalPhysics,
        updateFlightPhysics,
        updateOnGround,
        isPlayerEntireBodyInWater,
        updateUnderwaterPhysics,
        raycastVoxel,
        getTargetBlockByDDA,
        reset() {
            jumpCooldown = 0;
        }
    };
}