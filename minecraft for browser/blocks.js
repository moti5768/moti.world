"use strict";
import * as THREE from "./build/three.module.js";
import { BufferGeometryUtils } from './jsm/utils/BufferGeometryUtils.js';
import {
    MOUNT_SUPPORT_DX, MOUNT_SUPPORT_DY, MOUNT_SUPPORT_DZ,
    STATE_SCHEMAS, registerStateSchema, buildStateSchemaFromProperties, getSchemaDefaultState,
    resolveStateSchema, computeTransformMask, normalizeStateValue, compileAndRegisterBlockState,
    getBlockStateRawProp, getBlockStateProp, setBlockStateProp, cycleBlockStateProp,
    hasBlockStateProp, packBlockState, unpackBlockState, formatBlockStateString,
    getTransformMeta, getBlockLightEmissionForState, getCompiledStateVariant
} from './blockstate.js';

export {
    MOUNT_SUPPORT_DX, MOUNT_SUPPORT_DY, MOUNT_SUPPORT_DZ,
    STATE_SCHEMAS, registerStateSchema, buildStateSchemaFromProperties, getSchemaDefaultState,
    getBlockStateRawProp, getBlockStateProp, setBlockStateProp, cycleBlockStateProp,
    hasBlockStateProp, packBlockState, unpackBlockState, formatBlockStateString,
    getTransformMeta, getBlockLightEmissionForState, getCompiledStateVariant
};

const ERROR_TEXTURE = (() => {
    const data = new Uint8Array([
        255, 0, 255, 255, 0, 0, 0, 255,
        0, 0, 0, 255, 255, 0, 255, 255
    ]); // 2x2 マゼンタ/ブラック
    const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
})();

// ================================================
// ② ブロック定義 (BLOCK_CONFIG) の拡張
// ================================================

function createBox(x1, y1, z1, x2, y2, z2) {
    const box = new THREE.Box3();
    // 引数の中で小さい方を min に、大きい方を max にセットする
    box.min.set(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2));
    box.max.set(Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2));
    return box;
}

// --- カスタム衝突判定キャッシュ ---
const CUSTOM_COLLISION_CACHE = {
    stairs: [createBox(0, 0, 0, 1, 0.5, 1), createBox(0.5, 0.5, 0, 1, 1, 1)],
    slab: [createBox(0, 0, 0, 1, 0.5, 1)],
    cross: [createBox(0.25, 0, 0.25, 0.75, 1, 0.75)],
    carpet: [createBox(0, 0, 0, 1, 0.0625, 1)],
    ladder: [createBox(0, 0, 0, 1, 1, 0.125)],
    wire: [createBox(0, 0, 0, 1, 0.0625, 1)],
    torch: [createBox(0.375, 0, 0.375, 0.625, 0.625, 0.625)],
    redstone_torch: [createBox(0.375, 0, 0.375, 0.625, 0.625, 0.625)],
    lever: [createBox(0.25, 0, 0.25, 0.75, 0.5, 0.75)],
    repeater: [createBox(0, 0, 0, 1, 0.125, 1)]
};

// --- カスタム衝突判定取得関数 ---
// デフォルトボックスを定数化して再利用
const DEFAULT_BOX_ARRAY = Object.freeze([createBox(0, 0, 0, 1, 1, 1)]);

function cloneCollisionArray(baseBoxes) {
    const len = baseBoxes.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = new THREE.Box3().copy(baseBoxes[i]);
    }
    return result;
}

function getCustomCollision(type) {
    const boxes = CUSTOM_COLLISION_CACHE[type] || DEFAULT_BOX_ARRAY;
    return cloneCollisionArray(boxes);
}

const getSideConnections = (meta) => ({
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
    return Object.freeze(boxes); // 誤変形防止のためにフリーズ
});

function getFenceCollisionBoxes(meta) {
    // 事前生成された配列から引く (インデックスを0〜15の範囲に安全に限定)
    const baseBoxes = FENCE_BOXES_PRECOMPUTED[meta & 15];
    const len = baseBoxes.length;
    const result = new Array(len);

    // 既存のBox3コピーのみを行う（条件分岐やMath.min/max計算のコストを完全排除）
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

    // 中央の芯
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

/**
 * 板ガラスの接続状態に基づいた当たり判定（事前計算キャッシュ参照）
 */
function getPaneCollisionBoxes(meta) {
    const baseBoxes = PANE_BOXES_PRECOMPUTED[meta & 15];
    const len = baseBoxes.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = new THREE.Box3().copy(baseBoxes[i]);
    }
    return result;
}

/* ================================================
   ① ブロック登録ルックアップ＆基本属性照会 API
   （BlockState スキーマ・操作ロジック本体は blockstate.js へ一元化）
   ================================================ */
// 登録済みブロックの高速ルックアップテーブル（動的追加 registerCustomBlock にも対応）
const blockConfigLookup = {};
const _blockRegisterListeners = [];

export function onBlockRegistered(listener) {
    if (typeof listener === "function") _blockRegisterListeners.push(listener);
}

/**
 * 接続ビットマスク自動同期対象かどうか（宣言的 autoSyncConnection フラグを参照）
 */
export function usesConnectionMeta(blockId) {
    const cfg = blockConfigLookup[blockId & 0xFFF];
    return !!(cfg && cfg.autoSyncConnection === true);
}

/**
 * レッドストーン関連ブロックかどうかを返す
 */
export function isRedstoneComponent(blockId) {
    const cfg = blockConfigLookup[blockId & 0xFFF];
    return !!(cfg && cfg.redstoneConnectsWire !== false);
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

/**
 * 読み取り専用の衝突判定ボックス配列を返す（配列・Box3の新規生成なし・ゼロGC）
 * ※返却されたBox3を変更してはならない
 */
export function getCollisionBoxesReadOnly(type, meta = 0) {
    if (type === "fence") {
        return FENCE_BOXES_PRECOMPUTED[meta & 15];
    }
    if (type === "pane") {
        return PANE_BOXES_PRECOMPUTED[meta & 15];
    }
    return CUSTOM_COLLISION_CACHE[type] || DEFAULT_BOX_ARRAY;
}

// 床(0)＋壁4方向(1..4)の精密選択枠ボックス（事前計算・ゼロGC）
const TORCH_SELECTION_BOXES = Object.freeze([
    Object.freeze([createBox(0.375, 0.0, 0.375, 0.625, 0.625, 0.625)]), // 0: floor
    Object.freeze([createBox(0.0, 0.1875, 0.34375, 0.3125, 0.8125, 0.65625)]), // 1: east (西壁付き)
    Object.freeze([createBox(0.6875, 0.1875, 0.34375, 1.0, 0.8125, 0.65625)]), // 2: west (東壁付き)
    Object.freeze([createBox(0.34375, 0.1875, 0.0, 0.65625, 0.8125, 0.3125)]), // 3: south (北壁付き)
    Object.freeze([createBox(0.34375, 0.1875, 0.6875, 0.65625, 0.8125, 1.0)])  // 4: north (南壁付き)
]);

const LEVER_SELECTION_BOXES = Object.freeze([
    Object.freeze([createBox(0.25, 0.0, 0.25, 0.75, 0.625, 0.75)]), // 0: floor
    Object.freeze([createBox(0.0, 0.1875, 0.25, 0.4375, 0.8125, 0.75)]), // 1: east (西壁付き)
    Object.freeze([createBox(0.5625, 0.1875, 0.25, 1.0, 0.8125, 0.75)]), // 2: west (東壁付き)
    Object.freeze([createBox(0.25, 0.1875, 0.0, 0.75, 0.8125, 0.4375)]), // 3: south (北壁付き)
    Object.freeze([createBox(0.25, 0.1875, 0.5625, 0.75, 0.8125, 1.0)])  // 4: north (南壁付き)
]);

export function getSelectionBoxesReadOnly(blockId, meta = 0) {
    const cfg = blockConfigLookup[blockId];
    if (!cfg) return DEFAULT_BOX_ARRAY;

    const preset = cfg.selectionPreset || cfg.geometryType;
    if (preset === "fence") return FENCE_SELECTION_BOXES_PRECOMPUTED[meta & 15];
    if (preset === "pane") return PANE_BOXES_PRECOMPUTED[meta & 15];
    if (preset === "torch" || preset === "redstone_torch") return TORCH_SELECTION_BOXES[Math.min(meta & 7, 4)];
    if (preset === "lever") return LEVER_SELECTION_BOXES[Math.min(meta & 7, 4)];
    if (preset === "stairs") return CUSTOM_COLLISION_CACHE.stairs;
    if (preset === "water") return WATER_SELECTION_BOXES_BY_LEVEL[meta & 15];
    if (cfg._selectionBoxes) return cfg._selectionBoxes;

    return DEFAULT_BOX_ARRAY;
}

export function getCollisionBoxes(type, meta = 0) {
    // 1. フェンス・板ガラスは接続マスク(meta)の事前計算キャッシュから取得
    if (type === "fence") {
        return getFenceCollisionBoxes(meta);
    }
    if (type === "pane") {
        return getPaneCollisionBoxes(meta);
    }

    // 2. それ以外は既存のキャッシュから取得 (階段、スラブ、カーペット、ハシゴ等)
    const baseBoxes = CUSTOM_COLLISION_CACHE[type] || DEFAULT_BOX_ARRAY;
    const len = baseBoxes.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
        result[i] = new THREE.Box3().copy(baseBoxes[i]);
    }
    return result;
}

/**
 * メタデータ（回転・上下反転）を考慮して衝突判定箱を変換する
 */
// 🟢 関数外で1回だけ生成して使い回す (オブジェクトプール)
const _v = Array.from({ length: 8 }, () => new THREE.Vector3());
// 🟢 0, 90, 180, 270度の値をあらかじめ持っておく
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

    // 🟢 既存のインスタンスに値をセット (new しない)
    const min = targetBox.min, max = targetBox.max;
    _v[0].set(min.x, min.y, min.z);
    _v[1].set(min.x, min.y, max.z);
    _v[2].set(min.x, max.y, min.z);
    _v[3].set(min.x, max.y, max.z);
    _v[4].set(max.x, min.y, min.z);
    _v[5].set(max.x, min.y, max.z);
    _v[6].set(max.x, max.y, min.z);
    _v[7].set(max.x, max.y, max.z);

    // 🟢 テーブルから値を引く (計算しない)
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

    // 上下反転（meta第3ビット）
    if ((meta >> 2) & 1) {
        outRotationMat.makeRotationX(Math.PI);
    }

    // 回転（meta下位2ビット）
    const angle = ROT_Y_TABLE[meta & 3]; // インデックス参照のみ
    if (angle > 0) {
        tempMat.makeRotationY(angle);
        outRotationMat.premultiply(tempMat);
    }

    outTransformMat.premultiply(outRotationMat);
}

const LOG_MATRICES = [
    new THREE.Matrix4(), // Axis 0: Y (Identity / 回転なし)
    new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5)
        .premultiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2))
        .premultiply(new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5)), // Axis 1: X
    new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5)
        .premultiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
        .premultiply(new THREE.Matrix4().makeTranslation(0.5, 0.5, 0.5)), // Axis 2: Z
];
/**
 * 読み取り専用の原木回転行列を返す（cloneなし・ゼロGC）
 * ※返却された Matrix4 を直接書き換えないこと
 */
export function getLogRotationMatrixReadOnly(metadata) {
    let axis = (metadata & 3) % 3;
    if (axis < 0 || axis > 2) axis = 0;
    return LOG_MATRICES[axis] || LOG_MATRICES[0];
}

export function getLogRotationMatrix(metadata) {
    return getLogRotationMatrixReadOnly(metadata).clone();
}

/**
 * 設置時の状況からメタデータ（回転・上下）を計算する
 * @param {number} blockId - 設置しようとしているブロックのID
 * @param {THREE.Vector3} camDir - カメラの方向ベクトル
 * @param {THREE.Vector3} rawNormal - クリックした面の法線ベクトル
 * @param {THREE.Vector3} intersectPoint - クリックした位置の精密な座標
 * @returns {number} metaData (4ビット分: 0-15)
 */
// ハシゴのメタデータ(0..3)に対応する支持壁への相対オフセット [dx, dz]
const LADDER_SUPPORT_DX = [0, -1, 0, 1];
const LADDER_SUPPORT_DZ = [-1, 0, 1, 0];

// --- データ駆動・配置メタ計算ストラテジーレジストリ（外部から新ルール登録可能） ---
function _calcUpperHalfBit(rawNormal, intersectPoint) {
    if (rawNormal.y < -0.5) return 1;
    if (Math.abs(rawNormal.y) < 0.5) {
        let fractionY = intersectPoint.y - Math.floor(intersectPoint.y);
        if (fractionY < 0) fractionY += 1;
        if (fractionY > 0.49999) return 1;
    }
    return 0;
}

const PLACEMENT_STRATEGIES = {
    default_state: (cfg) => (cfg.defaultState ?? 0) & 0xF,
    wall_ladder: (cfg, camDir, rawNormal) => {
        if (Math.abs(rawNormal.y) > 0.5) return -1;
        if (rawNormal.z > 0.5) return 0;
        if (rawNormal.z < -0.5) return 2;
        if (rawNormal.x > 0.5) return 1;
        if (rawNormal.x < -0.5) return 3;
        return -1;
    },
    mount_floor_or_wall: (cfg, camDir, rawNormal) => {
        // 天井クリックは無効(-1)、床クリック=0、4壁クリック=1..4（defaultStateの上位bit3=lit/poweredを保持）
        if (rawNormal.y < -0.5) return -1;
        const baseFlags = (cfg.defaultState ?? 0) & 8;
        if (rawNormal.y > 0.5) return baseFlags | 0; // floor
        if (rawNormal.x > 0.5) return baseFlags | 1; // east (+X向き・西壁付き)
        if (rawNormal.x < -0.5) return baseFlags | 2; // west (-X向き・東壁付き)
        if (rawNormal.z > 0.5) return baseFlags | 3; // south (+Z向き・北壁付き)
        if (rawNormal.z < -0.5) return baseFlags | 4; // north (-Z向き・南壁付き)
        return baseFlags | 0;
    },
    axis_log: (cfg, camDir, rawNormal) => {
        const ax = Math.abs(rawNormal.x);
        const ay = Math.abs(rawNormal.y);
        const az = Math.abs(rawNormal.z);
        if (ax > ay && ax > az) return 1;
        if (az > ay && az > ax) return 2;
        return 0;
    },
    facing_horizontal: (cfg, camDir) => {
        // プレイヤー視線の水平方向を向く (0:+X, 1:-Z, 2:-X, 3:+Z)
        const base = (cfg.defaultState ?? 0) & ~3;
        if (Math.abs(camDir.x) > Math.abs(camDir.z)) {
            return base | (camDir.x > 0 ? 0 : 2);
        }
        return base | (camDir.z < 0 ? 1 : 3);
    },
    half_slab: (cfg, camDir, rawNormal, intersectPoint) => {
        return (_calcUpperHalfBit(rawNormal, intersectPoint) << 2);
    },
    directional_half: (cfg, camDir, rawNormal, intersectPoint) => {
        const lookX = -camDir.x;
        const lookZ = -camDir.z;
        let direction = 0;
        if (Math.abs(lookX) > Math.abs(lookZ)) {
            direction = (lookX > 0) ? 2 : 0;
        } else {
            direction = (lookZ > 0) ? 1 : 3;
        }
        return direction | (_calcUpperHalfBit(rawNormal, intersectPoint) << 2);
    }
};

export function registerPlacementRule(name, fn) {
    if (name && typeof fn === "function") PLACEMENT_STRATEGIES[name] = fn;
}

export function calculatePlacementMeta(blockId, camDir, rawNormal, intersectPoint) {
    const cfg = blockConfigLookup[blockId & 0xFFF];
    if (!cfg) return 0;

    if (typeof cfg.calculatePlacementMeta === "function") {
        return cfg.calculatePlacementMeta(cfg, camDir, rawNormal, intersectPoint);
    }
    const strategy = PLACEMENT_STRATEGIES[cfg.placementRule] || PLACEMENT_STRATEGIES.default_state;
    return strategy(cfg, camDir, rawNormal, intersectPoint);
}

// --- データ駆動・支持条件バリデータレジストリ（外部から新支持ルール登録可能） ---
const SUPPORT_VALIDATORS = {
    none: () => true,
    wall_opaque: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        const dir = meta & 3;
        if (meta < 0 || dir > 3) return false;
        const supportId = getBlockIdFn(wx + LADDER_SUPPORT_DX[dir], wy, wz + LADDER_SUPPORT_DZ[dir]) & 0xFFF;
        const supportCfg = blockConfigLookup[supportId];
        return !!(supportCfg && supportCfg.isOpaqueCube === true);
    },
    mount_opaque: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        const mount = meta & 7;
        if (meta < 0 || mount > 4) return false;
        const sy = wy + MOUNT_SUPPORT_DY[mount];
        if (sy < 0 || sy >= 256) return false;
        const supportId = getBlockIdFn(wx + MOUNT_SUPPORT_DX[mount], sy, wz + MOUNT_SUPPORT_DZ[mount]) & 0xFFF;
        const supportCfg = blockConfigLookup[supportId];
        return !!(supportCfg && supportCfg.isOpaqueCube === true);
    },
    floor_opaque: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        if (wy <= 0) return false;
        const belowCfg = blockConfigLookup[getBlockIdFn(wx, wy - 1, wz) & 0xFFF];
        return !!(belowCfg && belowCfg.isOpaqueCube === true);
    },
    floor_non_liquid: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        if (wy <= 0) return false;
        const belowId = getBlockIdFn(wx, wy - 1, wz) & 0xFFF;
        if (belowId === BLOCK_TYPES.SKY) return false;
        const belowCfg = blockConfigLookup[belowId];
        return !!(belowCfg && belowCfg.geometryType !== "water");
    },
    soil_grass: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        if (wy <= 0) return false;
        const belowId = getBlockIdFn(wx, wy - 1, wz) & 0xFFF;
        return belowId === BLOCK_TYPES.GRASS || belowId === BLOCK_TYPES.DIRT;
    },
    soil_desert: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        if (wy <= 0) return false;
        const belowId = getBlockIdFn(wx, wy - 1, wz) & 0xFFF;
        return belowId === BLOCK_TYPES.SAND || belowId === BLOCK_TYPES.DIRT;
    }
};

export function registerSupportRule(name, fn) {
    if (name && typeof fn === "function") SUPPORT_VALIDATORS[name] = fn;
}

/**
 * 隣接・下部ブロックの支持を必要とするブロックかどうかを宣言的 supportRule で判定
 */
export function isSupportDependentBlock(blockId) {
    const cfg = blockConfigLookup[blockId & 0xFFF];
    if (!cfg) return false;
    return !!(cfg.supportRule && cfg.supportRule !== "none") || typeof cfg.canSurvive === "function";
}

/**
 * 指定座標・メタデータでブロックを設置・維持できるか（支持条件）をデータ駆動で判定
 */
export function canPlaceBlockAt(blockId, meta, wx, wy, wz, getBlockIdFn) {
    if (wy < 0 || wy >= 256) return false;
    const cfg = blockConfigLookup[blockId & 0xFFF];
    if (!cfg || blockId === BLOCK_TYPES.SKY) return false;

    if (typeof cfg.canSurvive === "function") {
        return !!cfg.canSurvive(cfg, meta, wx, wy, wz, getBlockIdFn);
    }
    const validator = SUPPORT_VALIDATORS[cfg.supportRule || "none"];
    return validator ? validator(cfg, meta, wx, wy, wz, getBlockIdFn) : true;
}

// ── 共通のデフォルト設定 ──
const defaultBlockConfig = {
    isOpaqueCube: true,
    itemdisplay: true,
    collision: true,
    geometryType: "cube",
    transparent: false,
    targetblock: true,
    screenFill: true,
    textures: {},
    customCollision: null,
    hardness: 1.0,
    Gamma: 1.0,
    lightLevel: 0,
    lightOpacity: 1,
    drop: null,
    cullAdjacentFaces: true,
    overwrite: false,
    previewType: "3D",
    previewOptions: {
        rotation: { x: 0, y: 0, z: 0 },
        scale: 2.2
    },
    fallbackTexture: "textures/blocks/missing_texture.png",
    defaultColor: 0xffffff,
    selectionSize: { x: 1, y: 1, z: 1 },
    selectionOffset: { x: 0.5, y: 0.5, z: 0.5 },

    // 宣言的 BlockState・描画管理フィールド（properties を書くだけで自動コンパイル）
    properties: null,
    interactCycle: null,
    stateSchema: STATE_SCHEMAS.NONE,
    defaultState: null,
    previewState: null,
    previewTexture: null,
    selectionPreset: null,
    alphaCutout: null,
    stateVariants: null,
    resolveStateVisual: null,
    transformMask: null,
    placementRule: null,
    supportRule: null,
    shapeMode: null,
    autoSyncConnection: false,
    hasStateMaterials: false,

    // レッドストーン統一管理属性（通電する/しない・ワイヤー接続・常時出力・デバイス評価）
    redstoneConductive: null,    // true: 通電する導体 / false: 通電しない（未指定時は isOpaqueCube）
    redstoneConnectsWire: false, // "all": 全4方向接続 / "axis": 前後2方向のみ / false: 非接続
    redstonePowerOutput: 0,      // ブロック自身の常時強出力 (0..15, REDSTONE_BLOCK = 15)
    redstoneDevice: false,       // 信号変化で再評価するデバイスか (LAMP, REDSTONE_TORCH, REPEATER)
    redstoneRole: "none",        // "none" | "wire" | "block" | "lever" | "torch" | "repeater" | "lamp"

    // ブロック共通ライフサイクルフック（ブロック追加時にここへ書くだけでエンジンが自動実行）
    onPlace: null,               // ({ x, y, z, blockId, state, getBlockId, getRaw }) => nextState | null
    onNeighborChange: null,      // ({ x, y, z, blockId, state, getBlockId, getRaw, getLightOpacity }) => nextState | { id, state } | null
    onRandomTick: null,          // ({ x, y, z, blockId, state, getBlockId, getRaw, getLightOpacity, getLightLevel, setBlock, nextRng, chunkHeight }) => void
    onRedstoneUpdate: null       // ({ x, y, z, id, meta, cfg, power, setBlock, scheduleTick, engine }) => void
};

function createBlockConfig(customConfig) {
    return { ...defaultBlockConfig, ...customConfig };
}

// 自動採番用のカウンタ
let nextId = 0;

/**
 * ブロック定義ヘルパー：ID採番＋BlockStateポリシーを blockstate.js へ一元委譲して事前コンパイル
 */
function registerBlock(config) {
    const id = (config.id !== undefined) ? config.id : nextId++;
    if (id >= nextId) nextId = id + 1;

    const gType = config.geometryType ?? "cube";
    const isTransparent = config.transparent === true;
    const isFullCube = (gType === "cube") || config.isLog === true;
    const isSky = (id === 0 && config.geometryType === "none");
    const isOpaqueCube = (!isSky && !isTransparent && isFullCube);

    // 1. properties / stateSchema・transformMask・defaultState / previewState を blockstate.js で統一解決
    const stateSchema = resolveStateSchema(config);
    const transformMask = computeTransformMask(stateSchema, config.transformMask);
    const schemaDefault = getSchemaDefaultState(stateSchema);
    const defaultState = normalizeStateValue(stateSchema, config.defaultState, schemaDefault);
    const previewState = (config.previewState !== undefined && config.previewState !== null)
        ? normalizeStateValue(stateSchema, config.previewState, defaultState)
        : null;

    // interactCycle: "powered" のような1行宣言から onInteract を自動生成
    let onInteract = config.onInteract ?? null;
    if (!onInteract && typeof config.interactCycle === "string") {
        const cycleProp = config.interactCycle;
        onInteract = ({ blockId, state }) => cycleBlockStateProp(blockId, state, cycleProp);
    }

    // 2. placementRule / supportRule / shapeMode の自動推論
    let placementRule = config.placementRule;
    if (!placementRule) {
        if (config.isLadder) placementRule = "wall_ladder";
        else if (config.isLog) placementRule = "axis_log";
        else if (config.directional) placementRule = "directional_half";
        else if (config.isSlab) placementRule = "half_slab";
        else placementRule = "default_state";
    }

    let supportRule = config.supportRule;
    if (!supportRule) {
        if (config.isLadder) supportRule = "wall_opaque";
        else if (gType === "carpet") supportRule = "floor_non_liquid";
        else if (gType === "cross") {
            if (config.name === "mushroom_red" || config.name === "mushroom_brown") supportRule = "floor_opaque";
            else if (config.name === "deadbush") supportRule = "soil_desert";
            else supportRule = "soil_grass";
        } else {
            supportRule = "none";
        }
    }

    let shapeMode = config.shapeMode;
    if (!shapeMode) {
        if (gType === "fence") shapeMode = "connect_fence";
        else if (gType === "pane") shapeMode = "connect_pane";
        else if (gType === "wire") shapeMode = "connect_wire";
        else if (gType === "water") shapeMode = "liquid";
        else shapeMode = "static";
    }

    const autoSyncConnection = config.autoSyncConnection ?? (shapeMode === "connect_fence" || shapeMode === "connect_pane");
    const hasStateMaterials = config.hasStateMaterials ?? !!(config.stateVariants || config.resolveStateVisual);
    // 通電する/しないの自動統一（明示指定がなければ不透明な立方体のみ通電する導体として扱う）
    const redstoneConductive = (config.redstoneConductive !== undefined && config.redstoneConductive !== null)
        ? !!config.redstoneConductive
        : isOpaqueCube;

    const cfg = createBlockConfig({
        ...config,
        id,
        isOpaqueCube,
        stateSchema,
        transformMask,
        defaultState,
        previewState,
        onInteract,
        placementRule,
        supportRule,
        shapeMode,
        autoSyncConnection,
        hasStateMaterials,
        redstoneConductive
    });

    // 3. 16通りの BlockState (0..15) バリアント・発光量・F3文字列を blockstate.js で一括コンパイル＆登録
    compileAndRegisterBlockState(cfg);

    // 4. 選択ボックスの事前キャッシュ
    if (cfg.selectionSize && gType !== "cube" && gType !== "stairs" && gType !== "fence" && gType !== "pane") {
        const s = cfg.selectionSize;
        const o = cfg.selectionOffset || { x: 0.5, y: 0.5, z: 0.5 };
        cfg._selectionBoxes = Object.freeze([
            createBox(
                o.x - s.x * 0.5, o.y - s.y * 0.5, o.z - s.z * 0.5,
                o.x + s.x * 0.5, o.y + s.y * 0.5, o.z + s.z * 0.5
            )
        ]);
    }

    blockConfigLookup[id] = cfg;
    return cfg;
}

// ── 個別ブロック設定 ──
export const BLOCK_CONFIG = {
    SKY: registerBlock({
        itemdisplay: false,
        collision: false,
        geometryType: "none", // 描画しない
        transparent: true,
        opacity: 1,
        overwrite: true,
        screenFill: false,
        textures: {},
    }),

    GRASS: registerBlock({
        name: "grass_block",
        stateSchema: STATE_SCHEMAS.SNOWY,
        defaultState: { snowy: false },
        textures: {
            top: "textures/blocks/grass_top.png",
            side: "textures/blocks/grass_side.png",
            bottom: "textures/blocks/dirt.png",
        },
        stateVariants: {
            "snowy=false": {
                textures: {
                    top: "textures/blocks/grass_top.png",
                    side: "textures/blocks/grass_side.png",
                    bottom: "textures/blocks/dirt.png",
                }
            },
            "snowy=true": {
                textures: {
                    top: "textures/blocks/snow.png",
                    side: "textures/blocks/grass_side_snowed.png",
                    bottom: "textures/blocks/dirt.png",
                }
            }
        },
        onPlace: ({ x, y, z, blockId, state, getBlockId }) => {
            const aboveId = getBlockId(x, y + 1, z);
            const shouldBeSnowy = (aboveId === BLOCK_TYPES.SNOW);
            return setBlockStateProp(blockId, state, "snowy", shouldBeSnowy);
        },
        onNeighborChange: ({ x, y, z, blockId, state, getBlockId }) => {
            const aboveId = getBlockId(x, y + 1, z);
            const shouldBeSnowy = (aboveId === BLOCK_TYPES.SNOW);
            if (getBlockStateProp(blockId, state, "snowy") !== shouldBeSnowy) {
                return setBlockStateProp(blockId, state, "snowy", shouldBeSnowy);
            }
            return null;
        },
        onRandomTick: ({ x, y, z, blockId, state, getBlockId, getLightOpacity, getLightLevel, setBlock, nextRng, chunkHeight }) => {
            const aboveId = getBlockId(x, y + 1, z);
            if (aboveId < 0) return;

            // 1. 真上が雪ブロックなら snowy=true ステートを維持（土へ枯死させない）
            if (aboveId === BLOCK_TYPES.SNOW) {
                if (!getBlockStateProp(blockId, state, "snowy")) {
                    const nextMeta = setBlockStateProp(blockId, state, "snowy", true);
                    setBlock(x, y, z, (blockId & 0xFFF) | (nextMeta << 12));
                }
                return;
            }

            // 2. 雪以外の不透明ブロック・水・溶岩が真上にあると土(DIRT)へ変化
            if (getLightOpacity(aboveId) >= 15 || aboveId === BLOCK_TYPES.WATER || aboveId === BLOCK_TYPES.LAVA) {
                setBlock(x, y, z, BLOCK_TYPES.DIRT);
                return;
            }

            // 3. 雪が無くなったのに snowy=true のままなら通常草へ戻す
            if (getBlockStateProp(blockId, state, "snowy")) {
                const nextMeta = setBlockStateProp(blockId, state, "snowy", false);
                setBlock(x, y, z, (blockId & 0xFFF) | (nextMeta << 12));
            }

            // 4. 光量 >= 9 の草ブロックは周囲 3x3（高さ -1..+2）の露出した土へ伝播
            const aboveLight = getLightLevel(x, y + 1, z);
            if (aboveLight < 0) return;
            const sky = (aboveLight >> 4) & 15;
            const blk = aboveLight & 15;
            if ((sky > blk ? sky : blk) < 9) return;

            const r = nextRng();
            const tx = x + ((r % 3) - 1);
            const tz = z + ((((r >>> 4) | 0) % 3) - 1);
            const ty = y + ((((r >>> 8) | 0) % 4) - 1);
            if (ty <= 0 || ty >= chunkHeight - 1) return;

            const targetId = getBlockId(tx, ty, tz);
            if (targetId !== BLOCK_TYPES.DIRT) return;

            const targetAboveId = getBlockId(tx, ty + 1, tz);
            if (targetAboveId < 0) return;
            if (targetAboveId !== BLOCK_TYPES.SNOW && getLightOpacity(targetAboveId) >= 2) return;

            const targetAboveLight = getLightLevel(tx, ty + 1, tz);
            if (targetAboveLight < 0) return;
            const tSky = (targetAboveLight >> 4) & 15;
            const tBlk = targetAboveLight & 15;
            if ((tSky > tBlk ? tSky : tBlk) < 4) return;

            const spreadMeta = setBlockStateProp(
                BLOCK_TYPES.GRASS,
                0,
                "snowy",
                targetAboveId === BLOCK_TYPES.SNOW
            );
            setBlock(tx, ty, tz, (BLOCK_TYPES.GRASS & 0xFFF) | (spreadMeta << 12));
        }
    }),

    DIRT: registerBlock({
        name: "dirt",
        textures: { all: "textures/blocks/dirt.png" },
    }),

    SAND: registerBlock({
        name: "sand",
        textures: { all: "textures/blocks/sand.png" },
    }),

    SANDSTONE: registerBlock({
        name: "sandstone",
        textures: {
            top: "textures/blocks/sandstone_top.png",
            side: "textures/blocks/sandstone_normal.png",
            bottom: "textures/blocks/sandstone_bottom.png",
        },
    }),

    SNOW: registerBlock({
        name: "snow",
        textures: { all: "textures/blocks/snow.png" },
    }),

    STONE: registerBlock({
        name: "stone",
        textures: { all: "textures/blocks/stone.png" },
    }),

    GRAVEL: registerBlock({
        name: "gravel",
        textures: { all: "textures/blocks/gravel.png" },
    }),


    COBBLE_STONE: registerBlock({
        name: "cobblestone",
        textures: { all: "textures/blocks/cobblestone.png" },
    }),

    COBBLE_STONE_MOSSY: registerBlock({
        name: "cobblestone_mossy",
        textures: { all: "textures/blocks/cobblestone_mossy.png" },
    }),

    COAL_ORE: registerBlock({
        name: "coal_ore",
        textures: { all: "textures/blocks/coal_ore.png" },
    }),

    IRON_ORE: registerBlock({
        name: "iron_ore",
        textures: { all: "textures/blocks/iron_ore.png" },
    }),

    GOLD_ORE: registerBlock({
        name: "gold_ore",
        textures: { all: "textures/blocks/gold_ore.png" },
    }),

    REDSTONE_ORE: registerBlock({
        name: "redstone_ore",
        textures: { all: "textures/blocks/redstone_ore.png" },
    }),

    LAPIS_ORE: registerBlock({
        name: "lapis_ore",
        textures: { all: "textures/blocks/lapis_ore.png" },
    }),

    EMERALD_ORE: registerBlock({
        name: "emerald_ore",
        textures: { all: "textures/blocks/emerald_ore.png" },
    }),

    PLANKS_OAK: registerBlock({
        name: "planks_oak",
        textures: { all: "textures/blocks/planks_oak.png" },
    }),

    BRICK: registerBlock({
        name: "brick",
        textures: { all: "textures/blocks/brick.png" },
    }),

    BEDROCK: registerBlock({
        name: "bedrock",
        textures: { all: "textures/blocks/bedrock.png" },
    }),

    STONE_STAIRS: registerBlock({
        name: "stone_stairs",
        textures: { all: "textures/blocks/stone.png" },
        geometryType: "stairs",
        transparent: true,
        lightOpacity: 0,
        directional: true,
        customCollision: () => getCustomCollision("stairs"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 2.0,
    }),

    COBBLESTONE_STAIRS: registerBlock({
        name: "cobblestone_stairs",
        textures: { all: "textures/blocks/cobblestone.png" },
        geometryType: "stairs",
        transparent: true,
        lightOpacity: 0,
        directional: true,
        customCollision: () => getCustomCollision("stairs"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 2.0,
    }),

    PLANKS_OAK_STAIRS: registerBlock({
        name: "planks_oak_stairs",
        textures: { all: "textures/blocks/planks_oak.png" },
        geometryType: "stairs",
        transparent: true,
        lightOpacity: 0,
        directional: true,
        customCollision: () => getCustomCollision("stairs"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 2.0,
    }),

    STONE_SLAB: registerBlock({
        name: "stone_slab",
        textures: { all: "textures/blocks/stone.png" },
        geometryType: "slab",
        transparent: true,
        lightOpacity: 0,
        isSlab: true,
        customCollision: () => getCustomCollision("slab"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,
        selectionSize: { x: 1, y: 0.5, z: 1 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 },
    }),

    COBBLESTONE_SLAB: registerBlock({
        name: "cobblestone_slab",
        textures: { all: "textures/blocks/cobblestone.png" },
        geometryType: "slab",
        transparent: true,
        lightOpacity: 0,
        isSlab: true,
        customCollision: () => getCustomCollision("slab"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,
        selectionSize: { x: 1, y: 0.5, z: 1 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 },
    }),

    SMOOTHSTONE_SLAB: registerBlock({
        name: "smoothstone_slab",
        textures: {
            top: "textures/blocks/stone_slab_top.png",
            bottom: "textures/blocks/stone_slab_top.png",
            side: "textures/blocks/stone_slab_side.png",
        },
        geometryType: "slab",
        transparent: true,
        lightOpacity: 0,
        isSlab: true,
        customCollision: () => getCustomCollision("slab"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,
        selectionSize: { x: 1, y: 0.5, z: 1 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 },
    }),

    BRICK_SLAB: registerBlock({
        name: "brick_slab",
        textures: { all: "textures/blocks/brick.png" },
        geometryType: "slab",
        transparent: true,
        lightOpacity: 0,
        isSlab: true,
        customCollision: () => getCustomCollision("slab"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,
        selectionSize: { x: 1, y: 0.5, z: 1 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 },
    }),

    PLANKS_OAK_SLAB: registerBlock({
        name: "planks_oak_slab",
        textures: { all: "textures/blocks/planks_oak.png" },
        geometryType: "slab",
        transparent: true,
        lightOpacity: 0,
        isSlab: true,
        customCollision: () => getCustomCollision("slab"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,
        selectionSize: { x: 1, y: 0.5, z: 1 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 },
    }),

    GLASS: registerBlock({
        name: "glass",
        textures: { all: "textures/blocks/glass.png" },
        transparent: true,
        lightOpacity: 0,
        geometryType: "cube",
        screenFill: false,
    }),

    FLOWER: registerBlock({
        name: "flower",
        textures: { all: "textures/blocks/flower.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.4, y: 0.6, z: 0.4 },
        selectionOffset: { x: 0.5, y: 0.3, z: 0.5 },
    }),

    FLOWER_ROSE: registerBlock({
        name: "flower_rose",
        textures: { all: "textures/blocks/flower_rose.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.4, y: 0.6, z: 0.4 },
        selectionOffset: { x: 0.5, y: 0.3, z: 0.5 },
    }),

    TALLGRASS: registerBlock({
        name: "tallgrass",
        textures: { all: "textures/blocks/tallgrass.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        lightOpacity: 0,
        overwrite: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.8, y: 0.8, z: 0.8 },
        selectionOffset: { x: 0.5, y: 0.4, z: 0.5 },
    }),

    MUSHROOM_RED: registerBlock({
        name: "mushroom_red",
        textures: { all: "textures/blocks/mushroom_red.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        lightOpacity: 0,
        overwrite: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.5, y: 0.5, z: 0.5 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 },
    }),

    MUSHROOM_BROWN: registerBlock({
        name: "mushroom_brown",
        textures: { all: "textures/blocks/mushroom_brown.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        lightOpacity: 0,
        overwrite: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.5, y: 0.5, z: 0.5 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 },
    }),

    LEAVES_OAK: registerBlock({
        name: "leaves_oak",
        textures: { all: "textures/blocks/leaves_oak.png" },
        geometryType: "leaves",
        transparent: true,
        cullAdjacentFaces: false,
        lightOpacity: 1,
        screenFill: false,
    }),

    WHITE_WOOL_CARPET: registerBlock({
        name: "white_wool_carpet",
        textures: { all: "textures/blocks/wool_colored_white.png" },
        geometryType: "carpet",
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("carpet"),
        Gamma: 0.8,
        cullAdjacentFaces: false,
        screenFill: false,
        selectionSize: { x: 1, y: 0.0625, z: 1 },
        selectionOffset: { x: 0.5, y: 0.03125, z: 0.5 },
    }),

    WHITE_WOOL: registerBlock({
        name: "white_wool",
        textures: { all: "textures/blocks/wool_colored_white.png" }
    }),

    WATER: registerBlock({
        name: "water",
        stateSchema: STATE_SCHEMAS.LIQUID_LEVEL,
        defaultState: 0,
        textures: { all: "textures/blocks/water.png" },
        collision: false,
        transparent: true,
        opacity: 0.8,
        targetblock: false,
        lightOpacity: 2,
        overwrite: true,
        cullAdjacentFaces: true,
        screenFill: {
            enabled: true,
            opacity: 0.5
        },
        geometryType: "water",
        previewType: "3D",
    }),

    LAVA: registerBlock({
        name: "lava",
        stateSchema: STATE_SCHEMAS.LIQUID_LEVEL,
        defaultState: 0,
        textures: { all: "textures/blocks/lava.png" },
        collision: false,
        transparent: true,
        opacity: 1,
        targetblock: false,
        overwrite: true,
        cullAdjacentFaces: true,
        geometryType: "water",
        lightLevel: 15,
        previewType: "3D",
    }),

    GLOWSTONE: registerBlock({
        name: "glowstone",
        textures: { all: "textures/blocks/glowstone.png" },
        geometryType: "cube",
        lightLevel: 15,
        hardness: 1.0,
    }),

    LOG_OAK: registerBlock({
        name: "log_oak",
        isLog: true,
        textures: {
            top: "textures/blocks/log_oak_top.png",
            bottom: "textures/blocks/log_oak_top.png",
            side: "textures/blocks/log_oak.png",
        },
    }),

    SAPLING_OAK: registerBlock({
        name: "sapling_oak",
        textures: { all: "textures/blocks/sapling_oak.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.8, y: 0.8, z: 0.8 },
        selectionOffset: { x: 0.5, y: 0.4, z: 0.5 },
    }),

    DEADBUSH: registerBlock({
        name: "deadbush",
        textures: { all: "textures/blocks/deadbush.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.8, y: 0.8, z: 0.8 },
        selectionOffset: { x: 0.5, y: 0.4, z: 0.5 },
    }),

    LADDER: registerBlock({
        name: "ladder",
        textures: { all: "textures/blocks/ladder.png" },
        geometryType: "ladder",
        transparent: true,
        collision: true,
        isLadder: true,
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        lightOpacity: 0,
        customCollision: () => getCustomCollision("ladder"),
        selectionSize: { x: 1, y: 1, z: 0.125 },
        selectionOffset: { x: 0.5, y: 0.5, z: 0.0625 },
    }),

    PLANKS_OAK_FENCE: registerBlock({
        name: "planks_oak_fence",
        textures: { all: "textures/blocks/planks_oak.png" },
        geometryType: "fence",
        transparent: true,
        lightOpacity: 0,
        customCollision: (meta) => getFenceCollisionBoxes(meta),
        cullAdjacentFaces: false, // 形状が複雑なため常に描画
        screenFill: false,
        hardness: 2.0
    }),

    GLASS_PANE: registerBlock({
        name: "glass_pane",
        textures: {
            top: "textures/blocks/glass_pane_top.png",
            bottom: "textures/blocks/glass_pane_top.png",
            side: "textures/blocks/glass.png",
        },
        geometryType: "pane",
        transparent: true,
        lightOpacity: 0,
        customCollision: (meta) => getPaneCollisionBoxes(meta),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        hardness: 0.3
    }),

    // ================================================
    // ③ レッドストーン対応基盤ブロック群（通電する/しない統一管理＋宣言的 BlockState）
    // ================================================
    REDSTONE_WIRE: registerBlock({
        name: "redstone_wire",
        redstoneRole: "wire",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        stateSchema: STATE_SCHEMAS.POWER_16,
        defaultState: 0,
        previewState: 15,
        previewTexture: "textures/blocks/redstone_dust_dot.png",
        placementRule: "default_state",
        supportRule: "floor_opaque",
        shapeMode: "connect_wire",
        geometryType: "wire",
        alphaCutout: true,
        textures: {
            top: "textures/blocks/redstone_dust_dot.png",
            side: "textures/blocks/redstone_dust_line0.png"
        },
        resolveStateVisual: (meta) => {
            const p = meta & 15;
            if (p === 0) {
                return { defaultColor: 0x4d0000, isLightSource: false };
            }
            // 本家 Minecraft Java Edition RedStoneWireBlock.COLORS 準拠の緩やかな15段階減衰
            const f = p / 15;
            const r = Math.round((0.40 + 0.60 * f) * 255);
            const g = Math.round(Math.max(0, f * f * 0.70 - 0.50) * 255);
            const b = Math.round(Math.max(0, f * f * 0.60 - 0.70) * 255);
            return { defaultColor: (r << 16) | (g << 8) | b, isLightSource: false };
        },
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        hardness: 0.0,
        selectionSize: { x: 1, y: 0.0625, z: 1 },
        selectionOffset: { x: 0.5, y: 0.03125, z: 0.5 }
    }),

    REDSTONE_BLOCK: registerBlock({
        name: "redstone_block",
        redstoneRole: "block",
        redstoneConductive: false,    // 外部信号は中継せず、自身が常時15を出力する独立電源ブロック
        redstoneConnectsWire: "all",
        redstonePowerOutput: 15,
        textures: { all: "textures/blocks/redstone_block.png" },
        geometryType: "cube",
        hardness: 5.0
    }),

    REDSTONE_LAMP: registerBlock({
        name: "redstone_lamp",
        redstoneRole: "lamp",
        redstoneConductive: true,     // 通電する不透明導体ブロックかつ点灯デバイス
        redstoneConnectsWire: false,
        redstoneDevice: true,
        properties: { lit: false },
        geometryType: "cube",
        textures: { all: "textures/blocks/redstone_lamp_off.png" },
        stateVariants: {
            "lit=false": {
                textures: { all: "textures/blocks/redstone_lamp_off.png" },
                lightLevel: 0,
                isLightSource: false
            },
            "lit=true": {
                textures: { all: "textures/blocks/redstone_lamp_on.png" },
                lightLevel: 15,
                isLightSource: true
            }
        },
        hardness: 0.3
    }),

    LEVER: registerBlock({
        name: "lever",
        redstoneRole: "lever",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        properties: {
            mount: ['floor', 'east', 'west', 'south', 'north'],
            powered: false
        },
        interactCycle: "powered",
        placementRule: "mount_floor_or_wall",
        supportRule: "mount_opaque",
        shapeMode: "raw",
        selectionPreset: "lever",
        geometryType: "lever",
        alphaCutout: true,
        textures: {
            side: "textures/blocks/cobblestone.png",
            top: "textures/blocks/lever.png"
        },
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 0.5,
        selectionSize: { x: 0.5, y: 0.5, z: 0.5 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 }
    }),

    REDSTONE_TORCH: registerBlock({
        name: "redstone_torch",
        redstoneRole: "torch",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        redstoneDevice: true,
        properties: {
            mount: ['floor', 'east', 'west', 'south', 'north'],
            lit: true
        },
        previewState: { mount: 'floor', lit: true },
        placementRule: "mount_floor_or_wall",
        supportRule: "mount_opaque",
        shapeMode: "propRaw:mount",
        selectionPreset: "torch",
        geometryType: "redstone_torch",
        alphaCutout: true,
        textures: { all: "textures/blocks/redstone_torch_on.png" },
        stateVariants: {
            "lit=false": {
                textures: { all: "textures/blocks/redstone_torch_off.png" },
                lightLevel: 0,
                isLightSource: false
            },
            "lit=true": {
                textures: { all: "textures/blocks/redstone_torch_on.png" },
                lightLevel: 7,
                isLightSource: true
            }
        },
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        hardness: 0.0,
        selectionSize: { x: 0.25, y: 0.625, z: 0.25 },
        selectionOffset: { x: 0.5, y: 0.3125, z: 0.5 }
    }),

    REDSTONE_REPEATER: registerBlock({
        name: "redstone_repeater",
        redstoneRole: "repeater",
        redstoneConductive: false,
        redstoneConnectsWire: "axis",
        redstoneDevice: true,
        repeaterPowered: false,
        properties: {
            facing: ['east', 'north', 'west', 'south'],
            delay: [2, 4, 6, 8]
        },
        interactCycle: "delay",
        placementRule: "facing_horizontal",
        supportRule: "floor_opaque",
        shapeMode: "propRaw:delay",
        geometryType: "repeater",
        alphaCutout: true,
        textures: {
            top: "textures/blocks/repeater_off.png",
            side: "textures/blocks/stone_slab_side.png",
            bottom: "textures/blocks/stone_slab_top.png",
            south: "textures/blocks/redstone_torch_off.png"
        },
        collision: true,
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("repeater"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 0.0,
        selectionSize: { x: 1, y: 0.125, z: 1 },
        selectionOffset: { x: 0.5, y: 0.0625, z: 0.5 }
    }),

    // 通電中リピーター（4方向 x 4段階遅延 x ON/OFF の完全32状態、インベントリ非表示）
    REDSTONE_REPEATER_ON: registerBlock({
        name: "redstone_repeater_on",
        itemdisplay: false,
        redstoneRole: "repeater",
        redstoneConductive: false,
        redstoneConnectsWire: "axis",
        redstoneDevice: true,
        repeaterPowered: true,
        properties: {
            facing: ['east', 'north', 'west', 'south'],
            delay: [2, 4, 6, 8]
        },
        interactCycle: "delay",
        placementRule: "facing_horizontal",
        supportRule: "floor_opaque",
        shapeMode: "propRaw:delay",
        geometryType: "repeater",
        alphaCutout: true,
        textures: {
            top: "textures/blocks/repeater_on.png",
            side: "textures/blocks/stone_slab_side.png",
            bottom: "textures/blocks/stone_slab_top.png",
            south: "textures/blocks/redstone_torch_on.png"
        },
        lightLevel: 7,
        collision: true,
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("repeater"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 0.0,
        selectionSize: { x: 1, y: 0.125, z: 1 },
        selectionOffset: { x: 0.5, y: 0.0625, z: 0.5 }
    }),

    // 通常の松明（床/壁5方向対応・松明標準ジオメトリ geometryType: "torch" を使用・非レッドストーン）
    TORCH: registerBlock({
        name: "torch",
        redstoneConductive: false,
        stateSchema: STATE_SCHEMAS.MOUNT_5,
        defaultState: 0,
        placementRule: "mount_floor_or_wall",
        supportRule: "mount_opaque",
        shapeMode: "propRaw:mount",
        selectionPreset: "torch",
        geometryType: "torch",
        alphaCutout: true,
        textures: { all: "textures/blocks/torch_on.png" },
        lightLevel: 14,
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        hardness: 0.0,
        selectionSize: { x: 0.25, y: 0.625, z: 0.25 },
        selectionOffset: { x: 0.5, y: 0.3125, z: 0.5 }
    }),
};

// 文字列キー（"GRASS"）から数値IDを引くマップ
export const BLOCK_TYPES = Object.fromEntries(
    Object.entries(BLOCK_CONFIG).map(([key, cfg]) => [key, cfg.id])
);

// 数値IDから文字列キーを引く逆引きマップ（保存用）
const ID_TO_KEY = Object.fromEntries(
    Object.entries(BLOCK_CONFIG).map(([key, cfg]) => [cfg.id, key])
);

/**
 * 数値IDを文字列キーに変換する（セーブ時に使用）
 */
export function idToKey(id) {
    return ID_TO_KEY[id] || "SKY";
}

/**
 * 文字列キーを現在の数値IDに変換する（ロード時に使用）
 */
export function keyToId(key) {
    return BLOCK_TYPES[key] ?? 0;
}

/**
 * 外部モジュール・拡張定義から実行時に新ブロックを安全に追加できるプラグイン登録API
 */
export function registerCustomBlock(key, config) {
    if (!key || BLOCK_CONFIG[key]) return BLOCK_CONFIG[key] || null;
    const cfg = registerBlock(config);
    BLOCK_CONFIG[key] = cfg;
    BLOCK_TYPES[key] = cfg.id;
    ID_TO_KEY[cfg.id] = key;
    for (let i = 0; i < _blockRegisterListeners.length; i++) {
        _blockRegisterListeners[i](key, cfg);
    }
    return cfg;
}

const loadingManager = new THREE.LoadingManager();
loadingManager.maxConnections = 16; // 同時ロード数を増やす（デフォルト6）

const textureLoader = new THREE.TextureLoader(loadingManager);
const textureCache = new Map();

// 読み込みに失敗したパスを記録し、再試行による無駄な通信を防止する
const failedTextureCache = new Set();

function cachedLoadTexture(path, fallback = null) {
    if (!path || path === "" || path === "none" || failedTextureCache.has(path)) {
        if (fallback && fallback !== path && !failedTextureCache.has(fallback)) {
            return cachedLoadTexture(fallback, null);
        }
        return ERROR_TEXTURE;
    }

    if (textureCache.has(path)) return textureCache.get(path);

    const placeholder = new THREE.Texture();
    placeholder.image = ERROR_TEXTURE.image;
    placeholder.magFilter = ERROR_TEXTURE.magFilter;
    placeholder.wrapS = THREE.RepeatWrapping;
    placeholder.wrapT = THREE.RepeatWrapping;
    placeholder.needsUpdate = true;

    // ロード開始前にキャッシュ登録して重複ロードを防止
    textureCache.set(path, placeholder);

    textureLoader.load(
        path,
        (tex) => {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestMipmapNearestFilter;
            tex.generateMipmaps = true;
            placeholder.image = tex.image;
            placeholder.magFilter = tex.magFilter;
            placeholder.minFilter = tex.minFilter;
            placeholder.wrapS = THREE.RepeatWrapping;
            placeholder.wrapT = THREE.RepeatWrapping;
            placeholder.needsUpdate = true;
        },
        undefined,
        () => {
            console.error(`[Texture] Failed to load: ${path}`);
            failedTextureCache.add(path);

            if (fallback && fallback !== path && !failedTextureCache.has(fallback)) {
                textureLoader.load(fallback, (fbTex) => {
                    placeholder.image = fbTex.image;
                    placeholder.magFilter = THREE.NearestFilter;
                    placeholder.needsUpdate = true;
                }, undefined, () => {
                    failedTextureCache.add(fallback);
                });
            }
        }
    );

    return placeholder;
}

// グローバルキャッシュ
// ========================================================
// 1. シェーダー書き換えロジックの共通化 (メモリ・コンパイル最適化)
// ========================================================
// 全ブロックマテリアルで共有する単一 Uniform（昼夜・明るさ変更を O(1) で全チャンクへ即時反映）
export const SHARED_SKY_UNIFORM = { value: 1.0 };
export const SHARED_BRIGHTNESS_UNIFORM = { value: 1.0 };

function onBeforeCompileBlock(shader, mat) {
    const u = mat.userData && mat.userData.shaderUniforms;
    shader.uniforms.u_skyFactor = SHARED_SKY_UNIFORM;
    shader.uniforms.u_brightness = SHARED_BRIGHTNESS_UNIFORM;
    shader.uniforms.u_isLightSource = (u && u.u_isLightSource) ? u.u_isLightSource : { value: 0.0 };

    const vertexInjection = `
        #include <color_vertex>
        // vColor.r に空の明るさ(0..1)、vColor.g にブロックの明るさ(0..1)が Uint8 正規化で格納されている
        float skyLight = vColor.r;
        float blockLight = vColor.g;

        if (u_isLightSource > 0.5) {
            vColor.rgb = vec3(1.0);
        } else {
            // 明るい方の光を採用し、明るさ設定を O(1) Uniform で適用
            float lit = max(skyLight * u_skyFactor, blockLight) * u_brightness;
            vColor.rgb = vec3(clamp(lit, 0.04, 1.0));
        }
    `;

    shader.vertexShader = `
        uniform float u_skyFactor;
        uniform float u_brightness;
        uniform float u_isLightSource;
        ${shader.vertexShader}
    `.replace('#include <color_vertex>', vertexInjection);
}

// ========================================================
// 2. メイン関数 (跨ブロック共有マテリアルプール・非アトラス最適化版)
// ========================================================

const BLOCK_MATERIALS_CACHE = new Map();
// 同一テクスチャ・同一描画ステートのマテリアルをブロック間で共有（非アトラス最適化）
const GLOBAL_BLOCK_MATERIAL_POOL = new Map();
const STATE_MATERIALS_CACHE = new Map();
const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];
const _blockShaderCacheKey = () => 'mc_block_light_v2';

function _getOrCreateSharedBlockMaterial(texPath, config, props, override = null) {
    const opacity = (override && override.opacity !== undefined) ? override.opacity : (config.opacity ?? 1.0);
    const defaultColor = (override && override.defaultColor !== undefined) ? override.defaultColor : (config.defaultColor ?? 0xffffff);
    const alphaTest = props.isAlphaCutout ? 0.5 : 0;
    const depthWrite = props.isBlendTransparent ? false : true;
    const isLightSource = (override && override.isLightSource !== undefined)
        ? (override.isLightSource ? 1 : 0)
        : ((override && typeof override.lightLevel === "number")
            ? (override.lightLevel > 0 ? 1 : 0)
            : (config.lightLevel > 0 ? 1 : 0));
    const keyPath = (texPath && texPath !== "none") ? texPath : "__none__";

    const poolKey = `${keyPath}|${props.isBlendTransparent ? 1 : 0}|${opacity}|${alphaTest}|${props.side}|${depthWrite ? 1 : 0}|${isLightSource}|${defaultColor}`;
    const existing = GLOBAL_BLOCK_MATERIAL_POOL.get(poolKey);
    if (existing !== undefined) return existing;

    const mat = new THREE.MeshBasicMaterial({
        color: defaultColor,
        transparent: props.isBlendTransparent,
        opacity,
        vertexColors: true,
        side: props.side,
        depthWrite,
        alphaTest,
        map: (texPath && texPath !== "none") ? cachedLoadTexture(texPath, config.fallbackTexture) : null
    });

    mat.userData.shaderUniforms = {
        u_skyFactor: SHARED_SKY_UNIFORM,
        u_brightness: SHARED_BRIGHTNESS_UNIFORM,
        u_isLightSource: { value: isLightSource ? 1.0 : 0.0 }
    };
    mat.userData.isShared = true;
    mat.customProgramCacheKey = _blockShaderCacheKey;
    mat.onBeforeCompile = (shader) => onBeforeCompileBlock(shader, mat);

    GLOBAL_BLOCK_MATERIAL_POOL.set(poolKey, mat);
    return mat;
}

/**
 * ブロック設定＋事前コンパイル済み BlockState バリアントから6面マテリアル配列を汎用生成する
 */
export function createMaterialsFromBlockConfig(config, stateOverride = null) {
    const gType = config.geometryType;
    const isWater = (gType === "water") || !!config.isWater;
    const effOpacity = (stateOverride && stateOverride.opacity !== undefined) ? stateOverride.opacity : (config.opacity ?? 1.0);
    const isBlendTransparent = isWater && (effOpacity < 1.0);
    const isDoubleSide = (gType === "cross" || gType === "leaves" || gType === "ladder" || gType === "wire");

    // 宣言的 alphaCutout 指定または透過PNG形状のみ alphaTest: 0.5 を付与（Early-Z 最大化）
    const isAlphaCutout = !isWater && (
        config.alphaCutout === true ||
        gType === "cross" ||
        gType === "leaves" ||
        gType === "ladder" ||
        gType === "pane" ||
        (gType === "cube" && config.transparent === true)
    );

    const props = {
        isBlendTransparent,
        isAlphaCutout,
        side: (isDoubleSide || isWater) ? THREE.DoubleSide : THREE.FrontSide
    };

    const textures = (stateOverride && stateOverride.textures)
        ? { ...config.textures, ...stateOverride.textures }
        : config.textures;

    const result = new Array(6);

    for (let i = 0; i < 6; i++) {
        const face = FACE_ORDER[i];
        const texPath = textures?.[face] || textures?.all ||
            ((face !== "top" && face !== "bottom") ? textures?.side : null) ||
            textures?.top || textures?.bottom || config.fallbackTexture;

        result[i] = _getOrCreateSharedBlockMaterial(texPath, config, props, stateOverride);
    }
    return result;
}

export function getBlockMaterials(blockType) {
    const bId = (typeof blockType === "string") ? keyToId(blockType) : (Number(blockType) & 0xFFF);

    if (BLOCK_MATERIALS_CACHE.has(bId)) return BLOCK_MATERIALS_CACHE.get(bId);

    const config = blockConfigLookup[bId];
    if (!config) return null;

    // プレビュー・デフォルト表示用の状態（例: ワイヤーは明るい15、トーチは点灯1）で初期マテリアルを生成
    const defaultMeta = (config.previewState !== null && config.previewState !== undefined)
        ? config.previewState
        : (config.defaultState ?? 0);
    const override = config._compiledVariants ? config._compiledVariants[defaultMeta & 15] : null;
    const materials = createMaterialsFromBlockConfig(config, override);
    BLOCK_MATERIALS_CACHE.set(bId, materials);
    return materials;
}

/**
 * BlockState(meta) に応じた共有マテリアル配列を返す（宣言的 stateVariants / resolveStateVisual 汎用解決）
 */
export function getBlockMaterialsForState(blockId, meta = 0) {
    const bId = blockId & 0xFFF;
    const config = blockConfigLookup[bId];
    if (!config) return null;
    if (!config.hasStateMaterials) return getBlockMaterials(bId);

    const m = meta & 0xF;
    const stateKey = (bId << 4) | m;
    const cached = STATE_MATERIALS_CACHE.get(stateKey);
    if (cached !== undefined) return cached;

    const override = config._compiledVariants ? config._compiledVariants[m] : null;
    const mats = createMaterialsFromBlockConfig(config, override);
    STATE_MATERIALS_CACHE.set(stateKey, mats);
    return mats;
}

/* -------------------------------------------------------------------------
   2. ブロック Mesh の生成
   -------------------------------------------------------------------------
*/
// 標準ジオメトリとカスタムジオメトリのキャッシュ
const cachedBlockGeometries = {};
const cachedCustomGeometries = {};
/**
 * 横面のライティング用 UV 座標を最適化する関数  
 * 対象は、法線の Y 成分が 0 に近い（＝横向き）の頂点
 * @param {THREE.BufferGeometry} geom - 対象ジオメトリ
 */
function adjustSideUVs(geom, scaleY = 0.5) {
    const normals = geom.attributes.normal.array;
    const uvs = geom.attributes.uv.array;
    const count = uvs.length >> 1; // uvs.length / 2
    for (let i = 0, j = 0; i < normals.length; i += 3, j++) {
        if (Math.abs(normals[i + 1]) < 0.1) uvs[j * 2 + 1] *= scaleY;
    }
    geom.attributes.uv.needsUpdate = true;
}

/**
 * カーペット専用 横面UV調整
 * @param {THREE.BufferGeometry} geom 
 * @param {number} scaleY 
 */
function adjustSideUVsForCarpet(geom, scaleY = 0.0625) {
    const normals = geom.attributes.normal.array;
    const uvs = geom.attributes.uv.array;
    const count = uvs.length >> 1;
    for (let i = 0; i < count; i++) {
        const ny = normals[i * 3 + 1];
        if (Math.abs(ny) < 0.9) { // 横面だけ縮小
            uvs[i * 2 + 1] *= scaleY;
        }
    }
    geom.attributes.uv.needsUpdate = true;
}
const SHARED_PLANE = new THREE.PlaneGeometry(1, 1);

/**
 * three.js r128 の mergeBufferGeometries(..., true) が group.materialIndex を配列添字(0,1,2...)で
 * 強制上書きする仕様を回避し、各パーツが指定した materialIndex を 100% 保持して結合するヘルパー
 */
function mergeGeometriesPreservingGroups(geometries) {
    if (!geometries || geometries.length === 0) return null;
    if (geometries.length === 1) return geometries[0];

    const preservedGroups = [];
    let indexOffset = 0;

    for (let i = 0; i < geometries.length; i++) {
        const g = geometries[i];
        const count = g.index ? g.index.count : g.attributes.position.count;
        if (g.groups && g.groups.length > 0) {
            for (let j = 0; j < g.groups.length; j++) {
                const gr = g.groups[j];
                const gCount = Number.isFinite(gr.count) ? Math.min(gr.count, count - gr.start) : (count - gr.start);
                if (gCount > 0) {
                    preservedGroups.push({
                        start: indexOffset + gr.start,
                        count: gCount,
                        materialIndex: gr.materialIndex
                    });
                }
            }
        } else if (count > 0) {
            preservedGroups.push({ start: indexOffset, count, materialIndex: 0 });
        }
        indexOffset += count;
    }

    const merged = BufferGeometryUtils.mergeBufferGeometries(geometries, false);
    if (!merged) return null;

    merged.clearGroups();
    for (let i = 0; i < preservedGroups.length; i++) {
        const gr = preservedGroups[i];
        merged.addGroup(gr.start, gr.count, gr.materialIndex);
    }
    return merged;
}

// 形状ごとのビルダー関数マップ（ストラテジーパターンによる拡張性の向上）
const GEOMETRY_BUILDERS = {
    cube: () => {
        const geom = new THREE.BoxGeometry(1, 1, 1);
        geom.translate(0.5, 0.5, 0.5);
        return geom;
    },
    slab: () => {
        const slabGeom = new THREE.BoxGeometry(1, 0.5, 1);
        slabGeom.translate(0.5, 0.25, 0.5);
        const posAttr = slabGeom.getAttribute('position');
        const normAttr = slabGeom.getAttribute('normal');
        const uvAttr = slabGeom.getAttribute('uv');
        const indexAttr = slabGeom.index;

        slabGeom.clearGroups();
        for (let i = 0; i < indexAttr.count; i += 6) {
            const vertexIndex = indexAttr.array[i] * 3;
            const nx = normAttr.array[vertexIndex];
            const ny = normAttr.array[vertexIndex + 1];
            const nz = normAttr.array[vertexIndex + 2];

            let matIdx = 0;
            if (nx > 0.5) matIdx = 0;
            else if (nx < -0.5) matIdx = 1;
            else if (ny > 0.5) matIdx = 2;
            else if (ny < -0.5) matIdx = 3;
            else if (nz > 0.5) matIdx = 4;
            else if (nz < -0.5) matIdx = 5;

            slabGeom.addGroup(i, 6, matIdx);

            for (let f = 0; f < 6; f++) {
                const idx = indexAttr.array[i + f];
                const vx = posAttr.array[idx * 3];
                const vy = posAttr.array[idx * 3 + 1];
                const vz = posAttr.array[idx * 3 + 2];
                let u = 0, v = 0;
                switch (matIdx) {
                    case 0: u = 1.0 - vz; v = vy; break;
                    case 1: u = vz; v = vy; break;
                    case 2: u = vx; v = 1.0 - vz; break;
                    case 3: u = vx; v = vz; break;
                    case 4: u = vx; v = vy; break;
                    case 5: u = 1.0 - vx; v = vy; break;
                }
                uvAttr.array[idx * 2] = u;
                uvAttr.array[idx * 2 + 1] = v;
            }
        }
        uvAttr.needsUpdate = true;
        return slabGeom;
    },
    stairs: () => {
        const lower = new THREE.BoxGeometry(1, 0.5, 1);
        lower.translate(0.5, 0.25, 0.5);
        const upper = new THREE.BoxGeometry(0.5, 0.5, 1);
        upper.translate(0.75, 0.75, 0.5);

        const merged = BufferGeometryUtils.mergeBufferGeometries([lower, upper], true);
        const posAttr = merged.getAttribute('position');
        const normAttr = merged.getAttribute('normal');
        const uvAttr = merged.getAttribute('uv');
        const indexAttr = merged.index;

        merged.clearGroups();
        for (let i = 0; i < indexAttr.count; i += 6) {
            const vertexIndex = indexAttr.array[i] * 3;
            const nx = normAttr.array[vertexIndex];
            const ny = normAttr.array[vertexIndex + 1];
            const nz = normAttr.array[vertexIndex + 2];

            let matIdx = 0;
            if (nx > 0.5) matIdx = 0;
            else if (nx < -0.5) matIdx = 1;
            else if (ny > 0.5) matIdx = 2;
            else if (ny < -0.5) matIdx = 3;
            else if (nz > 0.5) matIdx = 4;
            else if (nz < -0.5) matIdx = 5;

            merged.addGroup(i, 6, matIdx);

            for (let f = 0; f < 6; f++) {
                const idx = indexAttr.array[i + f];
                const vx = posAttr.array[idx * 3];
                const vy = posAttr.array[idx * 3 + 1];
                const vz = posAttr.array[idx * 3 + 2];
                let u = 0, v = 0;
                switch (matIdx) {
                    case 0: u = 1.0 - vz; v = vy; break;
                    case 1: u = vz; v = vy; break;
                    case 2: case 3: u = vx; v = vz; break;
                    case 4: u = vx; v = vy; break;
                    case 5: u = 1.0 - vx; v = vy; break;
                }
                uvAttr.array[idx * 2] = u;
                uvAttr.array[idx * 2 + 1] = v;
            }
        }
        uvAttr.needsUpdate = true;
        return merged;
    },
    cross: () => {
        const p1 = SHARED_PLANE.clone();
        p1.rotateY(THREE.MathUtils.degToRad(45));
        const p2 = SHARED_PLANE.clone();
        p2.rotateY(THREE.MathUtils.degToRad(-45));
        const geom = BufferGeometryUtils.mergeBufferGeometries([p1, p2], false);
        p1.dispose();
        p2.dispose();
        geom.translate(0.5, 0.5, 0.5);
        geom.clearGroups();
        geom.addGroup(0, geom.index.count, 0);
        return geom;
    },
    fence: (config, meta) => {
        const { n, s, e, w } = getSideConnections(meta);
        const geometries = [];

        const post = new THREE.BoxGeometry(0.25, 1, 0.25);
        post.translate(0.5, 0.5, 0.5);
        geometries.push(post);

        const barWidth = 0.125;
        const barHeight = 0.1875;

        const createBar = (x, z, bw, bd) => {
            const b1 = new THREE.BoxGeometry(bw, barHeight, bd);
            const b2 = b1.clone();
            b1.translate(x, 0.375 + (barHeight / 2), z);
            b2.translate(x, 0.75 + (barHeight / 2), z);
            return [b1, b2];
        };

        if (n) geometries.push(...createBar(0.5, 0.25, barWidth, 0.5)); // 北 (-Z)
        if (s) geometries.push(...createBar(0.5, 0.75, barWidth, 0.5)); // 南 (+Z)
        if (e) geometries.push(...createBar(0.75, 0.5, 0.5, barWidth)); // 東 (+X)
        if (w) geometries.push(...createBar(0.25, 0.5, 0.5, barWidth)); // 西 (-X)

        // 単一マテリアルグループへ統合（最大9グループ -> 1グループ）し、一時パーツを即解放
        const geom = BufferGeometryUtils.mergeBufferGeometries(geometries, false);
        for (let i = 0; i < geometries.length; i++) geometries[i].dispose();
        geom.clearGroups();
        geom.addGroup(0, geom.index.count, 0);
        const posAttr = geom.getAttribute('position');
        const normAttr = geom.getAttribute('normal');
        const uvAttr = geom.getAttribute('uv');

        for (let i = 0; i < posAttr.count; i++) {
            const nx = Math.abs(normAttr.getX(i));
            const ny = Math.abs(normAttr.getY(i));
            const nz = Math.abs(normAttr.getZ(i));

            let u, v;
            if (ny > 0.5) {
                u = posAttr.getX(i);
                v = posAttr.getZ(i);
            } else if (nx > 0.5) {
                u = posAttr.getZ(i);
                v = posAttr.getY(i);
            } else {
                u = posAttr.getX(i);
                v = posAttr.getY(i);
            }
            uvAttr.setXY(i, u, v);
        }
        uvAttr.needsUpdate = true;
        return geom;
    },
    pane: (config, meta) => {
        const { n, s, e, w } = getSideConnections(meta);
        const geometries = [];
        const thick = 0.125;
        const halfThick = thick / 2;
        const MAT_GLASS = 0; // side -> glass.png
        const MAT_FRAME = 2; // top  -> glass_pane_top.png

        const addFlatPart = (x, y, z, w_size, h_size, d_size, axis) => {
            const g = new THREE.BoxGeometry(w_size, h_size, d_size);
            g.translate(x + w_size / 2, y + h_size / 2, z + d_size / 2);
            g.clearGroups();

            const pos = g.getAttribute('position');
            const norm = g.getAttribute('normal');
            const uv = g.getAttribute('uv');

            for (let i = 0; i < 6; i++) {
                let idx = MAT_FRAME;
                if (axis === 'z' && (i === 0 || i === 1)) idx = MAT_GLASS;
                if (axis === 'x' && (i === 4 || i === 5)) idx = MAT_GLASS;
                g.addGroup(i * 6, 6, idx);
            }

            // 法線方向に応じてガラス面・上下面・細い端面のUVを1px精度で割り当て（glass_pane_top.png 中央2px縁に一致）
            for (let i = 0; i < pos.count; i++) {
                const wx = pos.getX(i);
                const wy = pos.getY(i);
                const wz = pos.getZ(i);
                const ny = Math.abs(norm.getY(i));
                const nx = Math.abs(norm.getX(i));

                let u, v;
                if (ny > 0.5) {
                    // 上面・底面: 狭い厚み軸(7/16..9/16)をu、長い伸長軸をvへマッピング
                    u = (axis === 'z') ? wx : wz;
                    v = (axis === 'z') ? wz : wx;
                } else if (axis === 'z') {
                    // 南北板: ガラス面(±X)は(wz, wy)、細い端面(±Z)は(wx: 7/16..9/16, wy)
                    u = (nx > 0.5) ? wz : wx;
                    v = wy;
                } else {
                    // 東西板: ガラス面(±Z)は(wx, wy)、細い端面(±X)は(wz: 7/16..9/16, wy)
                    u = (nx > 0.5) ? wz : wx;
                    v = wy;
                }
                uv.setXY(i, u, v);
            }
            uv.needsUpdate = true;
            geometries.push(g);
        };

        const hasNS = (n || s);
        const hasEW = (e || w);
        const hasAnyConn = (hasNS || hasEW);

        if (hasNS || !hasAnyConn) {
            const zStart = n ? 0 : 0.5 - halfThick;
            const zEnd = s ? 1 : 0.5 + halfThick;
            addFlatPart(0.5 - halfThick, 0, zStart, thick, 1, zEnd - zStart, 'z');
        }

        if (hasEW) {
            if (hasNS) {
                // 十字・T字・L字交差時は中央芯をz板へ任せ、東西アームを分割してZファイティングを完全排除
                if (w) addFlatPart(0, 0, 0.5 - halfThick, 0.5 - halfThick, 1, thick, 'x');
                if (e) addFlatPart(0.5 + halfThick, 0, 0.5 - halfThick, 0.5 - halfThick, 1, thick, 'x');
            } else {
                const xStart = w ? 0 : 0.5 - halfThick;
                const xEnd = e ? 1 : 0.5 + halfThick;
                addFlatPart(xStart, 0, 0.5 - halfThick, xEnd - xStart, 1, thick, 'x');
            }
        }

        return mergeGeometriesPreservingGroups(geometries);
    },
    water: (config, meta = 0) => {
        // bit3(8) = 落下中または上に同種液体があるフル高さブロック (1.0)
        const isFalling = ((meta >> 3) & 1) !== 0;
        if (isFalling) {
            const geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            return geom;
        }
        // level 0..7 に応じて 0.88 から段階的に水面を下げる
        const level = meta & 7;
        const height = Math.max(0.12, ((8 - level) / 8) * 0.88);
        const geom = new THREE.BoxGeometry(1, height, 1);
        geom.translate(0.5, height * 0.5, 0.5);
        adjustSideUVs(geom, height);
        return geom;
    },
    leaves: () => {
        const geom = new THREE.BoxGeometry(1, 1, 1);
        geom.translate(0.5, 0.5, 0.5);
        return geom;
    },
    carpet: () => {
        const geom = new THREE.BoxGeometry(1, 0.0625, 1);
        geom.translate(0.5, 0.03125, 0.5);
        adjustSideUVsForCarpet(geom, 0.0625);
        return geom;
    },
    ladder: () => {
        const geom = new THREE.PlaneGeometry(1, 1);
        geom.translate(0.5, 0.5, 0.05);
        geom.addGroup(0, 6, 0);
        return geom;
    },
    wire: (config, meta = 0) => {
        // meta(8bit): 下位4bit=水平接続(N:8,S:4,E:2,W:1) / 上位4bit=1段上へ壁を登る接続(N:128,S:64,E:32,W:16)
        const n = (meta >> 3) & 1;
        const s = (meta >> 2) & 1;
        const e = (meta >> 1) & 1;
        const w = meta & 1;
        const upN = (meta >> 7) & 1;
        const upS = (meta >> 6) & 1;
        const upE = (meta >> 5) & 1;
        const upW = (meta >> 4) & 1;

        const geoms = [];
        const hasEW = (e || w);
        const hasNS = (n || s);

        const makeHorizQuad = (x0, z0, x1, z1, yPos, matIdx, uvFn) => {
            const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
            g.rotateX(-Math.PI / 2);
            g.translate((x0 + x1) * 0.5, yPos, (z0 + z1) * 0.5);
            const pos = g.attributes.position;
            const uv = g.attributes.uv;
            for (let i = 0; i < pos.count; i++) {
                uvFn(uv, i, pos.getX(i), pos.getZ(i));
            }
            uv.needsUpdate = true;
            g.clearGroups();
            g.addGroup(0, g.index.count, matIdx);
            return g;
        };

        if (!hasEW && !hasNS) {
            // 1. 完全孤立: redstone_dust_dot.png (matIdx=2) を1枚だけ描画
            geoms.push(makeHorizQuad(0.0, 0.0, 1.0, 1.0, 0.015, 2, (uv, i, px, pz) => {
                uv.setXY(i, px, 1.0 - pz);
            }));
        } else if (hasEW && !hasNS) {
            // 2. 東西の直線・端点: redstone_dust_line0.png (matIdx=0) を1枚だけ描画
            geoms.push(makeHorizQuad(0.0, 0.0, 1.0, 1.0, 0.015, 0, (uv, i, px, pz) => {
                uv.setXY(i, px, 1.0 - pz);
            }));
        } else if (!hasEW && hasNS) {
            // 3. 南北の直線・端点: redstone_dust_line0.png (matIdx=0) を90度回転して1枚だけ描画
            geoms.push(makeHorizQuad(0.0, 0.0, 1.0, 1.0, 0.015, 0, (uv, i, px, pz) => {
                uv.setXY(i, pz, px);
            }));
        } else {
            // 4. 角(L字)・T字・十字: dot.png (matIdx=2) の未接続方向だけ端 3/16(3px) をクリップして単一クワッド描画
            const x0 = w ? 0.0 : (3 / 16);
            const x1 = e ? 1.0 : (13 / 16);
            const z0 = n ? 0.0 : (3 / 16);
            const z1 = s ? 1.0 : (13 / 16);
            geoms.push(makeHorizQuad(x0, z0, x1, z1, 0.015, 2, (uv, i, px, pz) => {
                uv.setXY(i, px, 1.0 - pz);
            }));
        }

        // 5. 1ブロック上の段差へ壁面を登る垂直立ち上がりワイヤー (matIdx=0: redstone_dust_line0.png)
        const makeUpQuad = (rotY, tx, tz) => {
            const g = new THREE.PlaneGeometry(1.0, 1.0);
            if (rotY !== 0) g.rotateY(rotY);
            g.translate(tx, 0.5, tz);
            const uv = g.attributes.uv;
            for (let i = 0; i < uv.count; i++) {
                const u = uv.getX(i), v = uv.getY(i);
                uv.setXY(i, v, u);
            }
            uv.needsUpdate = true;
            g.clearGroups();
            g.addGroup(0, g.index.count, 0);
            return g;
        };

        if (upE) geoms.push(makeUpQuad(-Math.PI / 2, 0.984, 0.5));
        if (upW) geoms.push(makeUpQuad(Math.PI / 2, 0.016, 0.5));
        if (upS) geoms.push(makeUpQuad(Math.PI, 0.5, 0.984));
        if (upN) geoms.push(makeUpQuad(0, 0.5, 0.016));

        return mergeGeometriesPreservingGroups(geoms);
    },
    // 通常の松明 (TORCH) 用ジオメトリ（2x10x2 ストレートトーチ形状）
    torch: (config, meta = 0) => {
        const mount = Math.min(meta & 7, 4);
        const geom = new THREE.BoxGeometry(0.125, 0.625, 0.125);
        const uv = geom.attributes.uv;
        const norm = geom.attributes.normal;
        const u0 = 7 / 16, u1 = 9 / 16;
        for (let i = 0; i < uv.count; i++) {
            const ny = norm.getY(i);
            const su = uv.getX(i), sv = uv.getY(i);
            if (ny > 0.5) uv.setXY(i, u0 + su * (u1 - u0), (8 / 16) + sv * (2 / 16));
            else if (ny < -0.5) uv.setXY(i, u0 + su * (u1 - u0), sv * (2 / 16));
            else uv.setXY(i, u0 + su * (u1 - u0), sv * (10 / 16));
        }
        uv.needsUpdate = true;

        geom.translate(0, 0.3125, 0);
        if (mount === 0) geom.translate(0.5, 0.0, 0.5);
        else if (mount === 1) { geom.rotateZ(-0.40); geom.translate(0.0625, 0.20, 0.5); }
        else if (mount === 2) { geom.rotateZ(0.40); geom.translate(0.9375, 0.20, 0.5); }
        else if (mount === 3) { geom.rotateX(0.40); geom.translate(0.5, 0.20, 0.0625); }
        else if (mount === 4) { geom.rotateX(-0.40); geom.translate(0.5, 0.20, 0.9375); }

        geom.clearGroups();
        geom.addGroup(0, geom.index.count, 0);
        return geom;
    },
    // レッドストーントーチ (REDSTONE_TORCH) 専用ジオメトリ（バニラ準拠: 2x10x2芯＋4側面1:1光彩プレート）
    redstone_torch: (config, meta = 0) => {
        const mount = Math.min(meta & 7, 4);
        const u0 = 7 / 16, u1 = 9 / 16;

        const makeCap = (rotX, ty, vMin, vSpan) => {
            const g = new THREE.PlaneGeometry(0.125, 0.125);
            g.rotateX(rotX);
            g.translate(0, ty, 0);
            const uv = g.attributes.uv;
            for (let i = 0; i < uv.count; i++) {
                uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), vMin + uv.getY(i) * vSpan);
            }
            uv.needsUpdate = true;
            g.clearGroups();
            g.addGroup(0, g.index.count, 0);
            return g;
        };

        // 側面プレート: 中央8x12px (u: 4/16..12/16, v: 0..12/16) を1:1比率で描画し、棒の外側の赤い発光オーラも再現
        const makeSidePlate = (rotY, tx, tz) => {
            const g = new THREE.PlaneGeometry(0.5, 0.75);
            if (rotY !== 0) g.rotateY(rotY);
            g.translate(tx, 0.375, tz);
            const uv = g.attributes.uv;
            for (let i = 0; i < uv.count; i++) {
                uv.setXY(i, (4 / 16) + uv.getX(i) * (8 / 16), uv.getY(i) * (12 / 16));
            }
            uv.needsUpdate = true;
            g.clearGroups();
            g.addGroup(0, g.index.count, 0);
            return g;
        };

        const parts = [
            makeCap(-Math.PI / 2, 0.625, 8 / 16, 2 / 16), // +Y 上面 (2x2px)
            makeCap(Math.PI / 2, 0.0, 0, 2 / 16),         // -Y 底面 (2x2px)
            makeSidePlate(0, 0, 0.0625),                  // +Z 側面
            makeSidePlate(Math.PI, 0, -0.0625),           // -Z 側面
            makeSidePlate(Math.PI / 2, 0.0625, 0),        // +X 側面
            makeSidePlate(-Math.PI / 2, -0.0625, 0)       // -X 側面
        ];

        const geom = mergeGeometriesPreservingGroups(parts);
        for (let i = 0; i < parts.length; i++) parts[i].dispose();

        if (mount === 0) geom.translate(0.5, 0.0, 0.5);
        else if (mount === 1) { geom.rotateZ(-0.40); geom.translate(0.0625, 0.20, 0.5); }
        else if (mount === 2) { geom.rotateZ(0.40); geom.translate(0.9375, 0.20, 0.5); }
        else if (mount === 3) { geom.rotateX(0.40); geom.translate(0.5, 0.20, 0.0625); }
        else if (mount === 4) { geom.rotateX(-0.40); geom.translate(0.5, 0.20, 0.9375); }

        return geom;
    },
    lever: (config, meta = 0) => {
        // meta: 下位3bit=mount(0..4), bit3=powered(0/1)
        const mount = Math.min(meta & 7, 4);
        const isOn = ((meta >> 3) & 1) !== 0;

        // 1. 土台: cobblestone.png (matIdx=0) の1:1ピクセル比率UV
        const base = new THREE.BoxGeometry(0.375, 0.1875, 0.50);
        const bNorm = base.attributes.normal;
        const bUv = base.attributes.uv;
        for (let i = 0; i < bUv.count; i++) {
            const nx = Math.abs(bNorm.getX(i));
            const ny = Math.abs(bNorm.getY(i));
            const su = bUv.getX(i), sv = bUv.getY(i);
            if (ny > 0.5) bUv.setXY(i, (5 / 16) + su * (6 / 16), (4 / 16) + sv * (8 / 16));
            else if (nx > 0.5) bUv.setXY(i, (4 / 16) + su * (8 / 16), sv * (3 / 16));
            else bUv.setXY(i, (5 / 16) + su * (6 / 16), sv * (3 / 16));
        }
        bUv.needsUpdate = true;
        base.translate(0, 0.09375, 0);
        base.clearGroups();
        base.addGroup(0, base.index.count, 0);

        // 2. レバー棒: lever.png (matIdx=2) の中央2x10px領域をUVマッピング
        const handle = new THREE.BoxGeometry(0.125, 0.625, 0.125);
        const uv = handle.attributes.uv;
        const norm = handle.attributes.normal;
        const u0 = 7 / 16, u1 = 9 / 16;
        for (let i = 0; i < uv.count; i++) {
            const ny = norm.getY(i);
            const su = uv.getX(i), sv = uv.getY(i);
            if (ny > 0.5) {
                uv.setXY(i, u0 + su * (u1 - u0), (8 / 16) + sv * (2 / 16));
            } else if (ny < -0.5) {
                uv.setXY(i, u0 + su * (u1 - u0), sv * (2 / 16));
            } else {
                uv.setXY(i, u0 + su * (u1 - u0), sv * (10 / 16));
            }
        }
        uv.needsUpdate = true;
        handle.translate(0, 0.3125, 0);
        handle.rotateX(isOn ? 0.65 : -0.65);
        handle.translate(0, 0.125, 0);
        handle.clearGroups();
        handle.addGroup(0, handle.index.count, 2);

        const merged = mergeGeometriesPreservingGroups([base, handle]);

        if (mount === 0) {
            merged.translate(0.5, 0.0, 0.5);
        } else if (mount === 1) {
            merged.rotateX(Math.PI / 2);
            merged.rotateY(Math.PI / 2);
            merged.translate(0.0, 0.5, 0.5);
        } else if (mount === 2) {
            merged.rotateX(Math.PI / 2);
            merged.rotateY(-Math.PI / 2);
            merged.translate(1.0, 0.5, 0.5);
        } else if (mount === 3) {
            merged.rotateX(Math.PI / 2);
            merged.translate(0.5, 0.5, 0.0);
        } else if (mount === 4) {
            merged.rotateX(Math.PI / 2);
            merged.rotateY(Math.PI);
            merged.translate(0.5, 0.5, 1.0);
        }

        return merged;
    },
    repeater: (config, meta = 0) => {
        // デフォルト向き(rot=0): 入力(-X側) -> 出力(+X側)、meta = delayIdx (0..3 -> 2,4,6,8 ticks)
        const delayIdx = meta & 3;
        const base = new THREE.BoxGeometry(1.0, 0.125, 1.0);
        base.translate(0.5, 0.0625, 0.5);

        const bNorm = base.attributes.normal;
        const bUv = base.attributes.uv;
        const bIdx = base.index;
        base.clearGroups();
        for (let i = 0; i < bIdx.count; i += 6) {
            const vi = bIdx.array[i] * 3;
            const ny = bNorm.array[vi + 1];
            const matIdx = ny > 0.5 ? 2 : (ny < -0.5 ? 3 : 0);
            base.addGroup(i, 6, matIdx);
        }
        for (let vIdx = 0; vIdx < bUv.count; vIdx++) {
            const ny = bNorm.getY(vIdx);
            const u = bUv.getX(vIdx), v = bUv.getY(vIdx);
            if (ny > 0.5) {
                // 左右鏡像なしで時計回り90度回転: 矢印先端(v=1)が+X出力側(u=1)を指す
                bUv.setXY(vIdx, 1.0 - v, u);
            } else if (ny > -0.5) {
                bUv.setXY(vIdx, u, v * 0.125);
            }
        }
        bUv.needsUpdate = true;

        // トーチピン (matIdx=4: textures.south = redstone_torch_off/on.png)
        // 単体 redstone_torch と同一の「2x2px上面キャップ＋4側面1:1光彩プレート」構造（土台上面 y=2/16 から 7px分を投影）
        const parts = [base];
        const addTorchPin = (px, halfThick) => {
            const cap = new THREE.PlaneGeometry(0.125, 0.125);
            cap.rotateX(-Math.PI / 2);
            cap.translate(px, 7 / 16, 0.5);
            const cUv = cap.attributes.uv;
            for (let i = 0; i < cUv.count; i++) {
                cUv.setXY(i, (7 / 16) + cUv.getX(i) * (2 / 16), (8 / 16) + cUv.getY(i) * (2 / 16));
            }
            cUv.needsUpdate = true;
            cap.clearGroups();
            cap.addGroup(0, cap.index.count, 4);
            parts.push(cap);

            // 幅 6/16 (u: 5/16..11/16) x 高さ 7/16 (v: 5/16..12/16) の 1:1 比率プレート（ブロック範囲 [0,1] 内に完全収容）
            const makeSide = (rotY, ox, oz) => {
                const g = new THREE.PlaneGeometry(6 / 16, 7 / 16);
                if (rotY !== 0) g.rotateY(rotY);
                g.translate(px + ox, (2 / 16) + (7 / 32), 0.5 + oz);
                const uv = g.attributes.uv;
                for (let i = 0; i < uv.count; i++) {
                    uv.setXY(i, (5 / 16) + uv.getX(i) * (6 / 16), (5 / 16) + uv.getY(i) * (7 / 16));
                }
                uv.needsUpdate = true;
                g.clearGroups();
                g.addGroup(0, g.index.count, 4);
                return g;
            };

            parts.push(
                makeSide(0, 0, halfThick),            // +Z
                makeSide(Math.PI, 0, -halfThick),     // -Z
                makeSide(Math.PI / 2, halfThick, 0),  // +X
                makeSide(-Math.PI / 2, -halfThick, 0) // -X
            );
        };

        // バニラ repeater_off/on.png 上の4段階溝中心(上から7,9,11,13px)に1px精度で一致
        const delayPinX = [0.5625, 0.4375, 0.3125, 0.1875][delayIdx];
        addTorchPin(0.8125, 0.0625);
        // 最小遅延(delayIdx=0)での同一平面重なりによる Zファイティングを防ぐため微小オフセット(0.0003)を付与
        addTorchPin(delayPinX, 0.0628);

        const merged = mergeGeometriesPreservingGroups(parts);
        for (let i = 0; i < parts.length; i++) parts[i].dispose();
        return merged;
    }
};

/**
 * 外部モジュールから新しいカスタムジオメトリ形状ビルダーを登録する拡張API
 */
export function registerGeometryBuilder(type, builderFn) {
    if (type && typeof builderFn === "function") {
        GEOMETRY_BUILDERS[type] = builderFn;
    }
}

/**
 * 指定タイプのブロックジオメトリを取得する（完全版・リファクタリング済み）
 * @param {string|number} type - ブロックタイプID
 * @param {Object} [config] - ブロック設定オブジェクト
 * @param {number} [meta=0] - 接続状態や回転などの追加情報 (0-15)
 * @returns {THREE.BufferGeometry}
 */
export function getBlockGeometry(type, config, meta = 0) {
    // 1. カスタムジオメトリ（外部モデルなど）の処理
    if (config?.customGeometry) {
        if (!cachedCustomGeometries[config.id]) {
            const customGeom = typeof config.customGeometry === "function"
                ? config.customGeometry()
                : config.customGeometry;
            customGeom.computeBoundingBox();
            customGeom.computeVertexNormals();
            cachedCustomGeometries[config.id] = customGeom;
        }
        return cachedCustomGeometries[config.id];
    }

    // 2. キャッシュキーの生成 (type + meta を組み合わせる)
    const cacheKey = typeof type === 'number' ? (type << 4) | (meta & 0xF) : `${type}_${meta}`;
    if (cachedBlockGeometries[cacheKey]) return cachedBlockGeometries[cacheKey];

    // 3. 辞書から対応するビルダーを取得して実行（存在しない場合はcubeへフォールバック）
    const builder = GEOMETRY_BUILDERS[type] || GEOMETRY_BUILDERS["cube"];
    const geom = builder(config, meta);

    geom.computeBoundingBox();
    geom.computeVertexNormals();

    // 4. 生成されたジオメトリを cacheKey で保存
    cachedBlockGeometries[cacheKey] = geom;
    return geom;
}

// --- 1. ファイルスコープで作業用変数を固定 (GC対策) ---
const _tmpMat = new THREE.Matrix4();
const _rotMat = new THREE.Matrix4();
const _transMat = new THREE.Matrix4();
const _vec3 = new THREE.Vector3(); // Box3の計算などに使い回す
const _center = new THREE.Vector3(0.5, 0.5, 0.5);

// Box3の8頂点計算用の固定配列（毎回生成しない）
const _boxPoints = Array.from({ length: 8 }, () => new THREE.Vector3());

/**
 * ブロックの中心を軸に、メタデータに応じた回転と反転を適用する
 */
export function applyMetadataTransform(target, metadata, blockId) {
    if (metadata === undefined || metadata === null) return;

    const cfg = getBlockConfiguration(blockId);
    if (!cfg) return;

    const transformMeta = getTransformMeta(blockId, metadata);
    if (transformMeta === 0 && !cfg.isLog) return;

    // 行列の初期化
    _tmpMat.identity();
    _rotMat.identity();

    if (cfg.isLog) {
        const logMat = getLogRotationMatrix(transformMeta);
        _tmpMat.copy(logMat);
        _rotMat.extractRotation(_tmpMat);
    } else {
        const rotation = transformMeta & 3; // 下位2ビット：水平回転
        const isUpsideDown = (transformMeta >> 2) & 1; // 3ビット目：上下反転

        // 1. 回転行列 R の構築
        if (isUpsideDown && !cfg.isLadder) {
            // ハシゴに上下反転が必要ない場合は !cfg.isLadder を追加
            _rotMat.makeRotationX(Math.PI);
        }

        if (rotation !== 0) {
            _transMat.makeRotationY(rotation * (Math.PI / 2));
            _rotMat.premultiply(_transMat);
        }

        // 2. 行列合成: 中心(0.5, 0.5, 0.5)を軸に回転させる
        // T(0.5) * R * T(-0.5)
        _tmpMat.makeTranslation(-_center.x, -_center.y, -_center.z); // 原点へ
        _tmpMat.premultiply(_rotMat);                               // 回転
        _transMat.makeTranslation(_center.x, _center.y, _center.z);  // 中心へ戻す
        _tmpMat.premultiply(_transMat);
    }

    // --- A. 当たり判定 (Box3) への適用 ---
    if (target instanceof THREE.Box3) {
        // 1. 【変更】ハシゴなどの「回転」が必要なブロックは、まず中心を原点(0,0,0)に持ってくる
        _vec3.set(-_center.x, -_center.y, -_center.z);
        target.translate(_vec3);

        // 2. 8頂点に対して「純粋な回転行列(_rotMat)」だけを適用する
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
            _boxPoints[i].applyMatrix4(_rotMat); // _tmpMat ではなく _rotMat を使用
            target.expandByPoint(_boxPoints[i]);
        }

        // 3. 中心に戻す
        _vec3.set(_center.x, _center.y, _center.z);
        target.translate(_vec3);

        // スラブの上付き補正（既存ロジック）
        if (!cfg.isLog && cfg.isSlab && !cfg.directional && ((metadata >> 2) & 1)) {
            _vec3.set(0, 0.5, 0);
            target.translate(_vec3);
        }
    }
    // --- B. 見た目 (Mesh/Object3D) への適用 ---
    else if (target instanceof THREE.Object3D) {
        // 回転の適用
        target.quaternion.setFromRotationMatrix(_rotMat);

        // Y座標の補正
        if (!cfg.isLog && !cfg.isLadder) { // 💡 ハシゴは絶対補正の対象外にする
            const isUpsideDown = (metadata >> 2) & 1;
            const baseY = Math.floor(target.position.y);
            // スラブなら0.5、階段などのフルブロックなら1.0浮かせる
            const offset = isUpsideDown ? ((cfg.isSlab && !cfg.directional) ? 0.5 : 1.0) : 0;
            target.position.y = baseY + offset;

            // 💡 【追加】上下反転時に側面のテクスチャ(UV)が逆さまになるのを補正
            if (isUpsideDown && target.geometry) {
                // 共有ジオメトリを汚染しないようクローン
                target.geometry = target.geometry.clone();
                const uvs = target.geometry.attributes.uv.array;
                const normals = target.geometry.attributes.normal.array;
                for (let i = 0; i < uvs.length; i += 2) {
                    const ny = normals[(i / 2) * 3 + 1];
                    // 側面（法線のY成分がほぼ0）の場合にV座標を反転
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

/**
 * マルチマテリアル対応ブロックメッシュ生成 (最適化版)
 * @param {number} rawBlockType - ブロック種識別子
 * @param {THREE.Vector3} pos - 配置座標
 * @param {number} metadata - メタデータ
 * @returns {THREE.Mesh|null}
 */
export function createBlockMesh(rawBlockType, pos, metadata = 0) {
    const raw = Number(rawBlockType);
    const blockId = raw & 0xFFF;
    const finalMetadata = metadata !== 0 ? metadata : (raw >> 12);

    const config = getBlockConfiguration(blockId);
    if (!config) return null;

    const materials = getBlockMaterialsForState(blockId, finalMetadata);
    const geometry = getBlockGeometry(config.geometryType, config, finalMetadata);
    if (!materials || !geometry) return null;

    const mesh = new THREE.Mesh(geometry, materials);
    mesh.position.copy(pos);
    applyMetadataTransform(mesh, finalMetadata, blockId);

    // --- 当たり判定の動的構築 ---
    let boxes = null;

    if (config.geometryType === "fence") {
        // ★ ここで meta を使った動的判定を生成
        boxes = getFenceCollisionBoxes(finalMetadata);
    } else if (typeof config.customCollision === "function") {
        boxes = config.customCollision();
    } else if (config.collision) {
        boxes = getCustomCollision(config.geometryType || "cube");
    }

    if (boxes && boxes.length > 0) {
        for (let i = 0, len = boxes.length; i < len; i++) {
            const box = boxes[i];
            // 階段やハシゴの向き・反転を Box3 に反映
            applyMetadataTransform(box, finalMetadata, blockId);
            // ワールド座標へ移動
            box.translate(pos);
        }
        mesh.userData.collisionBoxes = boxes;
    } else {
        mesh.userData.collisionBoxes = [];
    }

    mesh.updateMatrixWorld();
    return mesh;
}

/**
 * ブロック設定を取得するための関数（ルックアップテーブル利用）
 * @param {number} blockID - ブロック種識別子
 * @returns {object|null} - 該当する設定があれば返し、なければ null
 */
export function getBlockConfiguration(blockID) {
    return blockConfigLookup[blockID] || null;
}