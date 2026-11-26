"use strict";
import * as THREE from '../build/three.module.js';
import { getRawBlockId, getRawLocalState } from '../blockstate.js';
import { buildChestPartGeometries } from './models/geometry_builders.js';

/* ======================================================
   【チェスト蓋開閉 3D アニメーションエンジン】(blocks/chest_animator.js)
   - 閉じている間は静的チャンクメッシュへ完全統合（Draw call ゼロ）
   - 開閉中のみ静的座標を隠蔽し、背面ヒンジ軸で 0° <-> 90° を滑らかに補間
   ====================================================== */

const ROT_Y_TABLE = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
const OPEN_SPEED = 3.2; // 約 0.31 秒で全開/全閉（Java Edition ChestLidController 準拠）
const MAX_OPEN_RAD = Math.PI * 0.5;

function encodeCoordKey(wx, wy, wz) {
    const ox = (wx + 524288) & 0xFFFFF;
    const oz = (wz + 524288) & 0xFFFFF;
    const oy = wy & 0xFF;
    return ox * 268435456 + (((oz << 8) | oy) >>> 0);
}

export function createChestAnimator(deps) {
    const {
        scene,
        getWorldRawLoaded,
        getBlockMaterialsFast,
        getTransformMeta,
        getWorldLightCell,
        lightLevelFactors,
        requestBlockSectionUpdate,
        blockTypes
    } = deps;

    const animGroup = new THREE.Group();
    animGroup.name = "ChestAnimations";
    animGroup.frustumCulled = false;
    scene.add(animGroup);

    const activeChests = new Map(); // Map<coordKey, ChestAnimRecord>
    let sharedParts = null;

    function getSharedParts() {
        if (!sharedParts) {
            sharedParts = buildChestPartGeometries();
        }
        return sharedParts;
    }

    function createColoredPartMesh(srcGeom, wx, wy, wz, rotIdx, mat) {
        const geom = srcGeom.clone();
        const normAttr = geom.getAttribute('normal');
        const vertCount = geom.getAttribute('position').count;
        const colArr = new Uint8Array(vertCount * 3);

        const cell = getWorldLightCell(wx, wy, wz);
        const light = cell >= 0 ? cell : 0xF0;
        const sBase = lightLevelFactors[(light >> 4) & 15];
        const bBase = lightLevelFactors[light & 15];

        const rotY = ROT_Y_TABLE[rotIdx & 3];
        const cosY = Math.cos(rotY);
        const sinY = Math.sin(rotY);

        for (let i = 0; i < vertCount; i++) {
            const nx = normAttr.getX(i);
            const ny = normAttr.getY(i);
            const nz = normAttr.getZ(i);
            const wnx = nx * cosY + nz * sinY;
            const wnz = -nx * sinY + nz * cosY;

            let fw = 0.8;
            if (ny > 0.5) fw = 1.0;
            else if (ny < -0.5) fw = 0.5;
            else if (Math.abs(wnz) > Math.abs(wnx)) fw = 0.65;

            const fw255 = fw * 255.0;
            let sByte = (sBase * fw255 + 0.5) | 0;
            let bByte = (bBase * fw255 + 0.5) | 0;
            if (sByte > 255) sByte = 255;
            if (bByte > 255) bByte = 255;

            const p3 = i * 3;
            colArr[p3] = sByte;
            colArr[p3 + 1] = bByte;
            colArr[p3 + 2] = 0;
        }
        geom.setAttribute('color', new THREE.BufferAttribute(colArr, 3, true));

        const mesh = new THREE.Mesh(geom, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 2;
        return mesh;
    }

    function disposeRecord(rec, rebuildSection = true) {
        animGroup.remove(rec.root);
        if (rec.baseMesh.geometry) rec.baseMesh.geometry.dispose();
        if (rec.lidMesh.geometry) rec.lidMesh.geometry.dispose();
        rec.baseMesh.geometry = null;
        rec.lidMesh.geometry = null;
        rec.baseMesh.material = null;
        rec.lidMesh.material = null;

        activeChests.delete(rec.key);
        if (rebuildSection && typeof requestBlockSectionUpdate === "function") {
            requestBlockSectionUpdate(rec.x, rec.y, rec.z);
        }
    }

    function setOpen(wx, wy, wz, shouldOpen) {
        const x = wx | 0, y = wy | 0, z = wz | 0;
        const key = encodeCoordKey(x, y, z);
        const existing = activeChests.get(key);

        if (existing) {
            existing.targetOpen = shouldOpen ? 1.0 : 0.0;
            return;
        }
        if (!shouldOpen) return;

        const raw = getWorldRawLoaded(x, y, z);
        if (raw <= 0 || getRawBlockId(raw) !== blockTypes.CHEST) return;

        const meta = getRawLocalState(raw);
        const rotIdx = getTransformMeta(blockTypes.CHEST, meta) & 3;
        const mats = getBlockMaterialsFast(blockTypes.CHEST, meta);
        const mat = Array.isArray(mats) ? mats[0] : mats;
        if (!mat) return;

        const { baseGeom, lidGeom } = getSharedParts();
        const root = new THREE.Group();
        root.position.set(x + 0.5, y, z + 0.5);
        root.rotation.y = ROT_Y_TABLE[rotIdx];

        const baseMesh = createColoredPartMesh(baseGeom, x, y, z, rotIdx, mat);
        const lidPivot = new THREE.Group();
        lidPivot.position.set(7 / 16, 9 / 16, 0);
        const lidMesh = createColoredPartMesh(lidGeom, x, y, z, rotIdx, mat);
        lidPivot.add(lidMesh);

        root.add(baseMesh);
        root.add(lidPivot);
        animGroup.add(root);

        activeChests.set(key, {
            key, x, y, z,
            root, baseMesh, lidPivot, lidMesh,
            openness: 0.0,
            targetOpen: 1.0
        });

        // 静的チャンク側のチェストを一時隠蔽してアニメーションモデルへ切り替え
        if (typeof requestBlockSectionUpdate === "function") {
            requestBlockSectionUpdate(x, y, z);
        }
    }

    function update(deltaSec) {
        if (activeChests.size === 0) return;

        const step = deltaSec * OPEN_SPEED;
        for (const rec of activeChests.values()) {
            if (rec.openness < rec.targetOpen) {
                rec.openness = Math.min(rec.targetOpen, rec.openness + step);
            } else if (rec.openness > rec.targetOpen) {
                rec.openness = Math.max(rec.targetOpen, rec.openness - step);
            }

            // Minecraft 準拠の滑らかなイージング（1 - (1 - t)^3）
            const inv = 1.0 - rec.openness;
            const eased = 1.0 - inv * inv * inv;
            rec.lidPivot.rotation.z = -eased * MAX_OPEN_RAD;

            if (rec.targetOpen === 0.0 && rec.openness <= 0.0) {
                disposeRecord(rec, true);
            }
        }
    }

    function cancelAt(wx, wy, wz) {
        const key = encodeCoordKey(wx | 0, wy | 0, wz | 0);
        const rec = activeChests.get(key);
        if (rec) disposeRecord(rec, true);
    }

    function clear() {
        for (const rec of activeChests.values()) {
            disposeRecord(rec, false);
        }
        activeChests.clear();
    }

    return {
        setOpen,
        update,
        cancelAt,
        clear,
        hasActiveAnimations: () => activeChests.size > 0,
        isCoordHidden: (wx, wy, wz) => activeChests.has(encodeCoordKey(wx, wy, wz))
    };
}