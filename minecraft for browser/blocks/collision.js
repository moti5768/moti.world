"use strict";
import * as THREE from '../build/three.module.js';

/* ======================================================
   【ブロック衝突判定・選択枠・回転変換モジュール】(blocks/collision.js)
   - 全ボックスを事前計算・フリーズしてランタイムゼロGCを維持
   - registerCollisionPreset / registerSelectionPreset で新形状を後から拡張可能
   ====================================================== */

export function createBox(x1, y1, z1, x2, y2, z2) {
    const box = new THREE.Box3();
    // 引数の中で小さい方を min に、大きい方を max にセットする
    box.min.set(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2));
    box.max.set(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));
    return box;
}

// --- カスタム衝突判定キャッシュ ---
const CUSTOM_COLLISION_CACHE = {
    stairs: Object.freeze([createBox(0, 0, 0, 1, 0.5, 1), createBox(0.5, 0.5, 0, 1, 1, 1)]),
    slab: Object.freeze([createBox(0, 0, 0, 1, 0.5, 1)]),
    cross: Object.freeze([createBox(0.25, 0, 0.25, 0.75, 1, 0.75)]),
    carpet: Object.freeze([createBox(0, 0, 0, 1, 0.0625, 1)]),
    ladder: Object.freeze([createBox(0, 0, 0, 1, 1, 0.125)]),
    wire: Object.freeze([createBox(0, 0, 0, 1, 0.0625, 1)]),
    torch: Object.freeze([createBox(0.375, 0, 0.375, 0.625, 0.625, 0.625)]),
    redstone_torch: Object.freeze([createBox(0.375, 0, 0.375, 0.625, 0.625, 0.625)]),
    lever: Object.freeze([createBox(0.25, 0, 0.25, 0.75, 0.5, 0.75)]),
    repeater: Object.freeze([createBox(0, 0, 0, 1, 0.125, 1)])
};

// meta別(長さ16配列)衝突判定キャッシュ（Java JSONモデル自動導出・ボタン/ドア等用）
const CUSTOM_COLLISION_BY_META = {};

// カスタム選択枠リゾルバ（長さ16のmeta別配列・固定配列・関数のすべてに対応）
const CUSTOM_SELECTION_PRESETS = {};

// デフォルトボックスを定数化して再利用
export const DEFAULT_BOX_ARRAY = Object.freeze([createBox(0, 0, 0, 1, 1, 1)]);

export function registerCollisionPreset(type, boxesOrByMeta) {
    if (!type || !Array.isArray(boxesOrByMeta)) return;
    if (boxesOrByMeta.length > 0 && Array.isArray(boxesOrByMeta[0])) {
        CUSTOM_COLLISION_BY_META[type] = Object.freeze(boxesOrByMeta);
    } else {
        CUSTOM_COLLISION_CACHE[type] = Object.freeze(boxesOrByMeta);
    }
}

export function registerSelectionPreset(name, resolverOrBoxes) {
    if (!name || !resolverOrBoxes) return;
    CUSTOM_SELECTION_PRESETS[name] = resolverOrBoxes;
}

function cloneCollisionArray(baseBoxes) {
    const len = baseBoxes.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = new THREE.Box3().copy(baseBoxes[i]);
    }
    return result;
}

export function getCustomCollision(type) {
    const boxes = CUSTOM_COLLISION_CACHE[type] || DEFAULT_BOX_ARRAY;
    return cloneCollisionArray(boxes);
}

export const getSideConnections = (meta) => ({
    n: (meta >> 3) & 1,
    s: (meta >> 2) & 1,
    e: (meta >> 1) & 1,
    w: meta & 1
});

const FENCE_BOXES_PRECOMPUTED = Array.from({ length: 16 }, (_, meta) => {
    const boxes = [];
    boxes.push(createBox(0.25, 0, 0.25, 0.75, 1.5, 0.75));
    const n = (meta >> 3) & 1, s = (meta >> 2) & 1, e = (meta >> 1) & 1, w = meta & 1;
    if (n) boxes.push(createBox(0.375, 0, 0, 0.625, 1.5, 0.375));
    if (s) boxes.push(createBox(0.375, 0, 0.625, 0.625, 1.5, 1.0));
    if (e) boxes.push(createBox(0.625, 0, 0.375, 1.0, 1.5, 0.625));
    if (w) boxes.push(createBox(0, 0, 0.375, 0.375, 1.5, 0.625));
    return Object.freeze(boxes);
});

export function getFenceCollisionBoxes(meta) {
    const baseBoxes = FENCE_BOXES_PRECOMPUTED[meta & 15];
    const len = baseBoxes.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = new THREE.Box3().copy(baseBoxes[i]);
    }
    return result;
}

const PANE_BOXES_PRECOMPUTED = Array.from({ length: 16 }, (_, meta) => {
    const boxes = [];
    const thick = 0.125; // 厚み（2/16ブロック）
    const center = 0.5;
    const half = thick / 2;

    boxes.push(createBox(center - half, 0, center - half, center + half, 1, center + half));

    const n = (meta >> 3) & 1;
    const s = (meta >> 2) & 1;
    const e = (meta >> 1) & 1;
    const w = meta & 1;

    if (n) boxes.push(createBox(center - half, 0, 0, center + half, 1, center - half));
    if (s) boxes.push(createBox(center - half, 0, center + half, center + half, 1, 1));
    if (e) boxes.push(createBox(center + half, 0, center - half, 1, 1, center + half));
    if (w) boxes.push(createBox(0, 0, center - half, center - half, 1, center + half));

    return Object.freeze(boxes);
});

export function getPaneCollisionBoxes(meta) {
    const baseBoxes = PANE_BOXES_PRECOMPUTED[meta & 15];
    const len = baseBoxes.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = new THREE.Box3().copy(baseBoxes[i]);
    }
    return result;
}

// フェンスの選択・視線判定用ボックス（物理衝突用の高さ1.5と分離し、見た目の高さ1.0に一致させる）
const FENCE_SELECTION_BOXES_PRECOMPUTED = Array.from({ length: 16 }, (_, meta) => {
    const boxes = [];
    boxes.push(createBox(0.375, 0, 0.375, 0.625, 1.0, 0.625));
    const n = (meta >> 3) & 1, s = (meta >> 2) & 1, e = (meta >> 1) & 1, w = meta & 1;
    if (n) boxes.push(createBox(0.4375, 0.375, 0, 0.5625, 0.9375, 0.375));
    if (s) boxes.push(createBox(0.4375, 0.375, 0.625, 0.5625, 0.9375, 1.0));
    if (e) boxes.push(createBox(0.625, 0.375, 0.4375, 1.0, 0.9375, 0.5625));
    if (w) boxes.push(createBox(0, 0.375, 0.4375, 0.375, 0.9375, 0.5625));
    return Object.freeze(boxes);
});

const WATER_SELECTION_BOXES_BY_LEVEL = Object.freeze(
    Array.from({ length: 16 }, (_, meta) => {
        const isFalling = ((meta >> 3) & 1) !== 0;
        const h = isFalling ? 1.0 : Math.max(0.12, ((8 - (meta & 7)) / 8) * 0.88);
        return Object.freeze([createBox(0, 0, 0, 1, h, 1)]);
    })
);

// 床(0)＋壁4方向(1..4)の精密選択枠ボックス（事前計算・ゼロGC）
const TORCH_SELECTION_BOXES = Object.freeze([
    Object.freeze([createBox(0.375, 0.0, 0.375, 0.625, 0.625, 0.625)]),       // 0: floor
    Object.freeze([createBox(0.0, 0.1875, 0.34375, 0.3125, 0.8125, 0.65625)]), // 1: east (西壁付き)
    Object.freeze([createBox(0.6875, 0.1875, 0.34375, 1.0, 0.8125, 0.65625)]), // 2: west (東壁付き)
    Object.freeze([createBox(0.34375, 0.1875, 0.0, 0.65625, 0.8125, 0.3125)]), // 3: south (北壁付き)
    Object.freeze([createBox(0.34375, 0.1875, 0.6875, 0.65625, 0.8125, 1.0)])  // 4: north (南壁付き)
]);

const LEVER_SELECTION_BOXES = Object.freeze([
    Object.freeze([createBox(0.25, 0.0, 0.25, 0.75, 0.625, 0.75)]),    // 0: floor
    Object.freeze([createBox(0.0, 0.1875, 0.25, 0.4375, 0.8125, 0.75)]), // 1: east (西壁付き)
    Object.freeze([createBox(0.5625, 0.1875, 0.25, 1.0, 0.8125, 0.75)]), // 2: west (東壁付き)
    Object.freeze([createBox(0.25, 0.1875, 0.0, 0.75, 0.8125, 0.4375)]), // 3: south (北壁付き)
    Object.freeze([createBox(0.25, 0.1875, 0.5625, 0.75, 0.8125, 1.0)])  // 4: north (南壁付き)
]);

export function getCollisionBoxesReadOnly(type, meta = 0) {
    if (type === "fence") return FENCE_BOXES_PRECOMPUTED[meta & 15];
    if (type === "pane") return PANE_BOXES_PRECOMPUTED[meta & 15];
    const byMeta = CUSTOM_COLLISION_BY_META[type];
    if (byMeta) {
        const idx = (meta >= 0 && meta < byMeta.length) ? meta : 0;
        return byMeta[idx] || DEFAULT_BOX_ARRAY;
    }
    return CUSTOM_COLLISION_CACHE[type] || DEFAULT_BOX_ARRAY;
}

/**
 * ブロック設定オブジェクトと状態値(meta)から読み取り専用の選択枠ボックス配列を返す（ゼロGC）
 */
export function getSelectionBoxesForConfig(cfg, meta = 0) {
    if (!cfg) return DEFAULT_BOX_ARRAY;

    const preset = cfg.selectionPreset || cfg.geometryType;
    if (preset === "fence") return FENCE_SELECTION_BOXES_PRECOMPUTED[meta & 15];
    if (preset === "pane") return PANE_BOXES_PRECOMPUTED[meta & 15];
    if (preset === "torch" || preset === "redstone_torch") return TORCH_SELECTION_BOXES[Math.min(meta & 7, 4)];
    if (preset === "lever") return LEVER_SELECTION_BOXES[Math.min(meta & 7, 4)];
    if (preset === "stairs") return CUSTOM_COLLISION_CACHE.stairs;
    if (preset === "water") return WATER_SELECTION_BOXES_BY_LEVEL[meta & 15];

    const customPreset = CUSTOM_SELECTION_PRESETS[preset];
    if (customPreset) {
        if (typeof customPreset === "function") return customPreset(meta, cfg);
        if (customPreset.length > 0 && Array.isArray(customPreset[0])) {
            const idx = (meta >= 0 && meta < customPreset.length) ? meta : 0;
            return customPreset[idx] || DEFAULT_BOX_ARRAY;
        }
        return customPreset;
    }
    if (cfg._selectionBoxes) return cfg._selectionBoxes;

    return DEFAULT_BOX_ARRAY;
}

export function getCollisionBoxes(type, meta = 0) {
    if (type === "fence") return getFenceCollisionBoxes(meta);
    if (type === "pane") return getPaneCollisionBoxes(meta);

    const byMeta = CUSTOM_COLLISION_BY_META[type];
    const byMetaBoxes = byMeta
        ? (byMeta[(meta >= 0 && meta < byMeta.length) ? meta : 0] || null)
        : null;
    const baseBoxes = byMetaBoxes || CUSTOM_COLLISION_CACHE[type] || DEFAULT_BOX_ARRAY;
    const len = baseBoxes.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = new THREE.Box3().copy(baseBoxes[i]);
    }
    return result;
}

// --- 回転・反転変換（オブジェクトプールでゼロGC） ---
const _v = Array.from({ length: 8 }, () => new THREE.Vector3());
const _SIN = [0, 1, 0, -1];
const _COS = [1, 0, -1, 0];

export function applyRotationToCollisionBox(relBox, metaData, targetBox) {
    const rotation = metaData & 3;
    const isUpsideDown = (metaData & 4) !== 0;

    targetBox.copy(relBox);

    if (isUpsideDown) {
        const minY = targetBox.min.y;
        const maxY = targetBox.max.y;
        targetBox.min.y = 1.0 - maxY;
        targetBox.max.y = 1.0 - minY;
    }

    if (rotation === 0) return;

    const min = targetBox.min, max = targetBox.max;
    _v[0].set(min.x, min.y, min.z);
    _v[1].set(min.x, min.y, max.z);
    _v[2].set(min.x, max.y, min.z);
    _v[3].set(min.x, max.y, max.z);
    _v[4].set(max.x, min.y, min.z);
    _v[5].set(max.x, min.y, max.z);
    _v[6].set(max.x, max.y, min.z);
    _v[7].set(max.x, max.y, max.z);

    const s = _SIN[rotation];
    const c = _COS[rotation];

    targetBox.makeEmpty();
    for (let i = 0; i < 8; i++) {
        const p = _v[i];
        const px = p.x - 0.5;
        const pz = p.z - 0.5;

        p.x = (px * c + pz * s) + 0.5;
        p.z = (-px * s + pz * c) + 0.5;

        targetBox.expandByPoint(p);
    }
}

const ROT_Y_TABLE = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
export function getCustomGeometryMatrix(meta, outTransformMat, outRotationMat, tempMat) {
    outTransformMat.makeTranslation(-0.5, -0.5, -0.5);
    outRotationMat.identity();

    if ((meta >> 2) & 1) {
        outRotationMat.makeRotationX(Math.PI);
    }

    const angle = ROT_Y_TABLE[meta & 3];
    if (angle > 0) {
        tempMat.makeRotationY(angle);
        outRotationMat.premultiply(tempMat);
    }

    outTransformMat.premultiply(outRotationMat);
}

const LOG_MATRICES = [
    new THREE.Matrix4(), // Axis 0: Y
    new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5)
        .premultiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
        .premultiply(new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5)), // Axis 1: X
    new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5)
        .premultiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
        .premultiply(new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5)), // Axis 2: Z
];

export function getLogRotationMatrixReadOnly(metadata) {
    let axis = (metadata & 3) % 3;
    if (axis < 0 || axis > 2) axis = 0;
    return LOG_MATRICES[axis] || LOG_MATRICES[0];
}

export function getLogRotationMatrix(metadata) {
    return getLogRotationMatrixReadOnly(metadata).clone();
}

const _tmpMat = new THREE.Matrix4();
const _rotMat = new THREE.Matrix4();
const _transMat = new THREE.Matrix4();
const _vec3 = new THREE.Vector3();
const _center = new THREE.Vector3(0.5, 0.5, 0.5);
const _boxPoints = Array.from({ length: 8 }, () => new THREE.Vector3());

/**
 * ブロックの中心を軸に、メタデータに応じた回転と反転を適用する
 */
export function applyMetadataTransformForConfig(target, metadata, cfg, transformMeta) {
    if (!cfg || (transformMeta === 0 && !cfg.isLog)) return;

    _tmpMat.identity();
    _rotMat.identity();

    if (cfg.isLog) {
        const logMat = getLogRotationMatrix(transformMeta);
        _tmpMat.copy(logMat);
        _rotMat.extractRotation(_tmpMat);
    } else {
        const rotation = transformMeta & 3;
        const isUpsideDown = (transformMeta >> 2) & 1;

        if (isUpsideDown && !cfg.isLadder) {
            _rotMat.makeRotationX(Math.PI);
        }

        if (rotation !== 0) {
            _transMat.makeRotationY(rotation * (Math.PI / 2));
            _rotMat.premultiply(_transMat);
        }

        _tmpMat.makeTranslation(-_center.x, -_center.y, -_center.z);
        _tmpMat.premultiply(_rotMat);
        _transMat.makeTranslation(_center.x, _center.y, _center.z);
        _tmpMat.premultiply(_transMat);
    }

    if (target instanceof THREE.Box3) {
        _vec3.set(-_center.x, -_center.y, -_center.z);
        target.translate(_vec3);

        _boxPoints[0].set(target.min.x, target.min.y, target.min.z);
        _boxPoints[1].set(target.min.x, target.min.y, target.max.z);
        _boxPoints[2].set(target.min.x, target.max.y, target.min.z);
        _boxPoints[3].set(target.min.x, target.max.y, target.max.z);
        _boxPoints[4].set(target.max.x, target.min.y, target.min.z);
        _boxPoints[5].set(target.max.x, target.min.y, target.max.z);
        _boxPoints[6].set(target.max.x, target.max.y, target.min.z);
        _boxPoints[7].set(target.max.x, target.max.y, target.max.z);

        target.makeEmpty();
        for (let i = 0; i < 8; i++) {
            _boxPoints[i].applyMatrix4(_rotMat);
            target.expandByPoint(_boxPoints[i]);
        }

        _vec3.set(_center.x, _center.y, _center.z);
        target.translate(_vec3);

        if (!cfg.isLog && cfg.isSlab && !cfg.directional && ((metadata >> 2) & 1)) {
            _vec3.set(0, 0.5, 0);
            target.translate(_vec3);
        }
    } else if (target instanceof THREE.Object3D) {
        target.quaternion.setFromRotationMatrix(_rotMat);

        if (!cfg.isLog && !cfg.isLadder) {
            const isUpsideDown = (metadata >> 2) & 1;
            const baseY = Math.floor(target.position.y);
            const offset = isUpsideDown ? ((cfg.isSlab && !cfg.directional) ? 0.5 : 1.0) : 0;
            target.position.y = baseY + offset;

            if (isUpsideDown && target.geometry) {
                target.geometry = target.geometry.clone();
                const uvs = target.geometry.attributes.uv.array;
                const normals = target.geometry.attributes.normal.array;
                for (let i = 0; i < uvs.length; i += 2) {
                    const ny = normals[(i / 2) * 3 + 1];
                    if (Math.abs(ny) < 0.1) {
                        uvs[i] = 1.0 - uvs[i];
                        uvs[i + 1] = 1.0 - uvs[i + 1];
                    }
                }
                target.geometry.attributes.uv.needsUpdate = true;
            }
        }
    }
}