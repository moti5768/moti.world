"use strict";
import * as THREE from "./build/three.module.js";
import { BufferGeometryUtils } from './jsm/utils/BufferGeometryUtils.js';

const ERROR_TEXTURE = (() => {
    const data = new Uint8Array([
        255, 0, 255, 255, 0, 0, 0, 255,
        0, 0, 0, 255, 255, 0, 255, 255
    ]); // 2x2 マゼンタ/ブラック
    const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
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
    ladder: [createBox(0, 0, 0, 1, 1, 0.125)]
};

// --- カスタム衝突判定取得関数 ---
// デフォルトボックスを定数化して再利用
const DEFAULT_BOX_ARRAY = Object.freeze([createBox(0, 0, 0, 1, 1, 1)]);

function getCustomCollision(type) {
    const boxes = CUSTOM_COLLISION_CACHE[type] || DEFAULT_BOX_ARRAY;
    const len = boxes.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
        // clone() のプロトタイプチェーンを避け、直接 Box3 をインスタンス化して値をコピー (軽量化)
        const src = boxes[i];
        result[i] = new THREE.Box3(
            new THREE.Vector3(src.min.x, src.min.y, src.min.z),
            new THREE.Vector3(src.max.x, src.max.y, src.max.z)
        );
    }
    return result;
}


/**
 * フェンスの接続状態(meta)に基づいた動的な当たり判定ボックスを生成する
 * プレイヤーがすり抜けないよう、判定を肉付けしたバージョン
 */
function getFenceCollisionBoxes(meta) {
    const boxes = [];

    // 1. 中央の柱を太くする (幅 0.25 -> 0.5)
    // 0.25 から 0.75 まで広げることで、中心付近の判定が安定します
    boxes.push(createBox(0.25, 0, 0.25, 0.75, 1.5, 0.75));

    // metaから各方向への接続を確認
    const n = (meta >> 3) & 1;
    const s = (meta >> 2) & 1;
    const e = (meta >> 1) & 1;
    const w = meta & 1;

    // 2. 接続棒の判定も太くする (幅 0.125 -> 0.25)
    // 北 (N)
    if (n) boxes.push(createBox(0.375, 0, 0, 0.625, 1.5, 0.375));
    // 南 (S)
    if (s) boxes.push(createBox(0.375, 0, 0.625, 0.625, 1.5, 1.0));
    // 東 (E)
    if (e) boxes.push(createBox(0.625, 0, 0.375, 1.0, 1.5, 0.625));
    // 西 (W)
    if (w) boxes.push(createBox(0, 0, 0.375, 0.375, 1.5, 0.625));

    return boxes;
}

/**
 * 拡張されたカスタム衝突判定取得関数
 */
export function getCollisionBoxes(type, meta = 0) {
    // 1. フェンスは meta に基づいて動的に生成
    if (type === "fence") {
        return getFenceCollisionBoxes(meta);
    }

    // 2. それ以外は既存のキャッシュから取得 (階段、スラブ、カーペット等)
    const baseBoxes = CUSTOM_COLLISION_CACHE[type] || DEFAULT_BOX_ARRAY;

    // 軽量にコピーして返す
    return baseBoxes.map(src => new THREE.Box3().copy(src));
}

/**
 * 板ガラスの接続状態に基づいた当たり判定
 */
function getPaneCollisionBoxes(meta) {
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

    return boxes;
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
export function getLogRotationMatrix(metadata) {
    const axis = (metadata & 3) % 3; // 0, 1, 2に限定
    // 🟢 既存の行列をコピーして返すだけ（計算なし、newは1回のみ）
    return LOG_MATRICES[axis].clone();
}

/**
 * 設置時の状況からメタデータ（回転・上下）を計算する
 * @param {number} blockId - 設置しようとしているブロックのID
 * @param {THREE.Vector3} camDir - カメラの方向ベクトル
 * @param {THREE.Vector3} rawNormal - クリックした面の法線ベクトル
 * @param {THREE.Vector3} intersectPoint - クリックした位置の精密な座標
 * @returns {number} metaData (4ビット分: 0-15)
 */
export function calculatePlacementMeta(blockId, camDir, rawNormal, intersectPoint) {
    const cfg = getBlockConfiguration(blockId);
    if (!cfg) return 0;

    if (cfg.isLadder) {
        // クリックした壁の面にピッタリ吸着する方向を返す
        if (rawNormal.z > 0.5) return 0; // 南面をクリック -> 南向き
        if (rawNormal.z < -0.5) return 2; // 北面をクリック -> 北向き
        if (rawNormal.x > 0.5) return 1; // 東面をクリック -> 東向き
        if (rawNormal.x < -0.5) return 3; // 西面をクリック -> 西向き
        return 0;
    }

    // --- 1. 原木 (isLog) 専用ロジック ---
    if (cfg.isLog) {
        // 法線の絶対値が一番大きい軸に倒す
        const ax = Math.abs(rawNormal.x);
        const ay = Math.abs(rawNormal.y);
        const az = Math.abs(rawNormal.z);

        if (ax > ay && ax > az) return 1; // X軸
        if (az > ay && az > ax) return 2; // Z軸
        return 0; // Y軸(上下面)
    }

    // --- 2. 既存の向き(Directional/Slab)計算 ---
    // ... (既存のコードをそのまま維持) ...
    let direction = 0;
    if (cfg.directional) {
        const lookX = -camDir.x;
        const lookZ = -camDir.z;
        if (Math.abs(lookX) > Math.abs(lookZ)) {
            direction = (lookX > 0) ? 2 : 0;
        } else {
            direction = (lookZ > 0) ? 1 : 3;
        }
    }

    let isUpsideDown = 0;
    if (cfg.directional || cfg.isSlab) {
        if (rawNormal.y < -0.5) {
            isUpsideDown = 1;
        } else if (Math.abs(rawNormal.y) < 0.5) {
            const hitY = intersectPoint.y - Math.floor(intersectPoint.y + 0.00001);
            if (hitY > 0.5) isUpsideDown = 1;
        }
    }
    return direction | (isUpsideDown << 2);
}

// ── 共通のデフォルト設定 ──
const defaultBlockConfig = {
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
    lightOpacity: 1, // デフォルトの光の減衰量（透過ブロックを通る時に追加で引かれる値）
    drop: null,
    cullAdjacentFaces: true,
    overwrite: false,
    previewType: "3D",
    previewOptions: {
        rotation: { x: 0, y: 0, z: 0 },
        scale: 2.2
    },
    // ここから追加：
    // ブロックごとのフォールバック画像パス（例: "textures/blocks/fallback_stone.png"）
    // 指定しない場合は「map を持たないマテリアル（defaultColor 表示）」になります
    fallbackTexture: "textures/blocks/missing_texture.png",
    // map を持たない場合に表示したい色（0xffffff など）。未指定なら白
    defaultColor: 0xffffff,

    // 👇 【追加】アウトライン（黒枠）用のデフォルト設定（1x1x1 のブロックの標準位置）
    selectionSize: { x: 1, y: 1, z: 1 },
    selectionOffset: { x: 0.5, y: 0.5, z: 0.5 }
};

// ── ユーティリティ：深いマージ（必要なら） ──
function createBlockConfig(customConfig) {
    return { ...defaultBlockConfig, ...customConfig };
}

// 自動採番用のカウンタ
let nextId = 0;

// 定義用ヘルパー：IDを自動付与して config を作成する
function registerBlock(config) {
    // もし config 内に id が明示されていればそれを使い、なければ自動採番
    const id = (config.id !== undefined) ? config.id : nextId++;
    // 自動採番が手動IDを追い越さないように調整
    if (id >= nextId) nextId = id + 1;

    return createBlockConfig({ ...config, id });
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
        textures: {
            top: "textures/blocks/grass_top.png",
            side: "textures/blocks/grass_side.png",
            bottom: "textures/blocks/dirt.png",
        },
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
        hardness: 0.3
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
for (const cfg of Object.values(BLOCK_CONFIG)) {
    if (typeof cfg.customCollision === "function") {
        cfg._cachedCollision = cfg.customCollision();
    }
}

const loadingManager = new THREE.LoadingManager();
loadingManager.maxConnections = 16; // 同時ロード数を増やす（デフォルト6）

const textureLoader = new THREE.TextureLoader(loadingManager);
const textureCache = new Map();

// ロード中の Promise を管理するキャッシュ（重複ロードを完全に防ぐ）
const loadingPromises = new Map();

// 読み込みに失敗したパスを完全に記録する
const failedTextureCache = new Set();

function cachedLoadTexture(path, fallback = null) {
    // パスがない、または既に失敗している場合は即「ピンク黒」
    if (!path || path === "" || path === "none" || failedTextureCache.has(path)) {
        if (fallback && fallback !== path && !failedTextureCache.has(fallback)) {
            return cachedLoadTexture(fallback, null);
        }
        return ERROR_TEXTURE;
    }

    if (textureCache.has(path)) return textureCache.get(path);
    if (loadingPromises.has(path)) return textureCache.get(path);

    const placeholder = new THREE.Texture();
    // 初期状態（ロード中・失敗時）をピンク黒にしておく
    placeholder.image = ERROR_TEXTURE.image;
    placeholder.magFilter = ERROR_TEXTURE.magFilter;
    placeholder.needsUpdate = true;

    textureCache.set(path, placeholder);

    const loadPromise = new Promise((resolve) => {
        textureLoader.load(
            path,
            (tex) => {
                tex.magFilter = THREE.NearestFilter;
                tex.minFilter = THREE.NearestMipmapNearestFilter;
                tex.generateMipmaps = true;
                placeholder.image = tex.image;
                placeholder.magFilter = tex.magFilter;
                placeholder.minFilter = tex.minFilter;
                placeholder.needsUpdate = true;
                resolve(placeholder);
            },
            undefined,
            () => {
                console.error(`[Texture] Failed to load: ${path}`);
                failedTextureCache.add(path);

                // fallback 処理
                if (fallback && fallback !== path && !failedTextureCache.has(fallback)) {
                    textureLoader.load(fallback, (fbTex) => {
                        placeholder.image = fbTex.image;
                        placeholder.magFilter = THREE.NearestFilter;
                        placeholder.needsUpdate = true;
                    }, undefined, () => {
                        failedTextureCache.add(fallback);
                        // fallbackも失敗なら初期値のピンク黒のまま
                    });
                }
                resolve(placeholder);
            }
        );
    }).finally(() => {
        loadingPromises.delete(path);
    });

    loadingPromises.set(path, loadPromise);
    return placeholder;
}

// グローバルキャッシュ
// ========================================================
// 1. シェーダー書き換えロジックの共通化 (メモリ・コンパイル最適化)
// ========================================================
/**
 * 全ブロック共通の頂点シェーダー注入ロジック
 */
function onBeforeCompileBlock(shader, mat) {
    // ユニフォームの参照をシェーダーに渡す
    shader.uniforms.u_skyFactor = mat.userData.shaderUniforms.u_skyFactor;
    shader.uniforms.u_isLightSource = mat.userData.shaderUniforms.u_isLightSource;

    const vertexInjection = `
        #include <color_vertex>
        // vColor.r に空の明るさ、vColor.g にブロックの明るさが格納されている前提
        float skyLight = vColor.r; 
        float blockLight = vColor.g; 
        
        if (u_isLightSource > 0.5) {
            vColor.rgb = vec3(1.0);
        } else {
            // 明るい方の光を採用し、空の光には時間帯係数をかける
            vColor.rgb = vec3(max(skyLight * u_skyFactor, blockLight));
        }
    `;

    shader.vertexShader = `
        uniform float u_skyFactor;
        uniform float u_isLightSource;
        ${shader.vertexShader}
    `.replace('#include <color_vertex>', vertexInjection);
}

// ========================================================
// 2. メイン関数 (最適化済み完全版)
// ========================================================

const materialCache = new Map(); // ブロック構成ごとのキャッシュ
// 静的データを外に出すことで、関数呼び出しごとの配列生成を回避
const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];

/**
 * ブロックの設定からマテリアル配列を生成・取得する
 */
export function createMaterialsFromBlockConfig(blockConfig) {
    const cacheKey = blockConfig.id;

    // 1. キャッシュヒット時は即座にリターン
    const cached = materialCache.get(cacheKey);
    if (cached) return cached;

    const {
        geometryType,
        transparent,
        textures = {},
        lightLevel,
        opacity = 1.0,
        fallbackTexture: fb,
        defaultColor = 0xffffff
    } = blockConfig;

    // --- 🟢 アルゴリズム維持: screenFill の解析のみ追加 ---
    let sfEnabled = false;
    let sfOpacity = 1.0;
    if (typeof blockConfig.screenFill === 'object' && blockConfig.screenFill !== null) {
        sfEnabled = blockConfig.screenFill.enabled !== false;
        sfOpacity = blockConfig.screenFill.opacity ?? 1.0;
    } else {
        sfEnabled = !!blockConfig.screenFill;
    }

    // 判定ロジックを一度だけ計算 (元コードのまま)
    const isWater = (blockConfig.isWater === true);
    const isGlass = (transparent === true && geometryType !== "cross" && geometryType !== "leaves" && geometryType !== "ladder" && !isWater);
    const isLightSource = (lightLevel > 0);
    const isBlendTransparent = isWater;
    const isAlphaCutout = (transparent === true && !isBlendTransparent);
    const isDoubleSideGeom = (geometryType === "cross" || geometryType === "leaves" || geometryType === "ladder");
    const side = (isDoubleSideGeom || isWater) ? THREE.DoubleSide : THREE.FrontSide;
    const isStairsOrSlab = (geometryType === "stairs" || geometryType === "slab");
    const useVertexColors = (!isStairsOrSlab && !isDoubleSideGeom && !isWater);

    // 同一ブロック内でのテクスチャ重複用キャッシュ
    const localMatCache = new Map();

    // マテリアル配列の構築
    const resultMaterials = new Array(6);

    // textures.all がある場合は最短ルートを通る
    if (textures.all) {
        const texPath = textures.all;
        const mat = _generateMaterial(texPath);
        resultMaterials.fill(mat);
    } else {
        for (let i = 0; i < 6; i++) {
            const face = FACE_ORDER[i];
            const texPath = textures[face] ||
                ((face !== "top" && face !== "bottom") ? textures.side : null) ||
                textures.top || textures.bottom || fb;

            let mat = localMatCache.get(texPath);
            if (!mat) {
                mat = _generateMaterial(texPath);
                localMatCache.set(texPath, mat);
            }
            resultMaterials[i] = mat;
        }
    }

    // 内部的なマテリアル生成ロジック
    function _generateMaterial(path) {
        const options = {
            color: defaultColor,
            transparent: isBlendTransparent,
            opacity: opacity, // ブロック自体の見た目は維持
            vertexColors: useVertexColors,
            side: side,
            depthWrite: isGlass ? true : !isBlendTransparent,
            alphaTest: isAlphaCutout ? 0.5 : 0,
        };

        if (path && path !== "none") {
            options.map = cachedLoadTexture(path, fb);
        }

        const mat = new THREE.MeshBasicMaterial(options);

        // 🟢 ここで screenFill の設定値を保持しておく (重要)
        mat.userData.screenFill = {
            enabled: sfEnabled,
            opacity: sfOpacity
        };

        mat.userData.shaderUniforms = {
            u_skyFactor: { value: 1.0 },
            u_isLightSource: { value: isLightSource ? 1.0 : 0.0 }
        };
        mat.onBeforeCompile = (shader) => onBeforeCompileBlock(shader, mat);
        return mat;
    }

    materialCache.set(cacheKey, resultMaterials);
    return resultMaterials;
}

// マテリアルのキャッシュ（ブロックIDごと）
const BLOCK_MATERIALS_CACHE = new Map();

// BLOCK_CONFIG から各ブロック設定を高速に取得するためのルックアップテーブル
// （初期化時に一度だけ実行されるため、このままで問題ありません）
const blockConfigLookup = {};
for (const cfg of Object.values(BLOCK_CONFIG)) {
    blockConfigLookup[cfg.id] = cfg;
}

/**
 * 指定ブロックタイプのマテリアル配列を返す。  
 * 回転データ（メタデータ）が含まれている場合でも、純粋なIDを抽出して設定を参照します。
 * キャッシュがあれば再利用し、無駄な再生成を防ぎます。
 * * @param {number|string} blockType - ブロック種識別子（回転データを含む場合がある）
 * @returns {THREE.Material[] | null} - マテリアルの配列
 */
export function getBlockMaterials(blockType) {
    let bId;

    // --- 🟢 追加：文字列キーへの対応 ---
    if (typeof blockType === "string") {
        // 文字列（例: "GRASS"）なら、今の実行環境での数値IDを取得する
        bId = keyToId(blockType);
    } else {
        // 数値なら従来通りメタデータをマスクしてIDを抽出
        bId = Number(blockType) & 0xFFF;
    }

    // --- 🔵 以降は共通処理 ---
    // 2. キャッシュ確認
    if (BLOCK_MATERIALS_CACHE.has(bId)) {
        return BLOCK_MATERIALS_CACHE.get(bId);
    }

    // 3. ルックアップテーブルから設定を取得
    const config = blockConfigLookup[bId];
    if (!config) {
        if (bId !== 0) {
            console.warn(`Unknown block type: ${blockType} (resolved ID: ${bId})`);
        }
        return null;
    }

    // 4. マテリアル生成
    const materials = createMaterialsFromBlockConfig(config);

    // 5. キャッシュに保存
    BLOCK_MATERIALS_CACHE.set(bId, materials);

    return materials;
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
/**
 * 指定タイプのブロックジオメトリを取得する。
 * ・カスタムジオメトリは一度だけ生成してキャッシュし、再利用
 * ・標準ジオメトリは一度だけ生成してキャッシュし、再利用
 * @param {string} type - "cube", "stairs", "slab", "cross" 等
 * @param {object} [config] - ブロック設定。カスタムジオメトリ用の customGeometry プロパティ等を含む
 * @returns {THREE.BufferGeometry}
 */
const SHARED_PLANE = new THREE.PlaneGeometry(1, 1);
/**
 * ブロックのジオメトリを取得（完全版）
 * @param {string|number} type - ブロックタイプID
 * @param {Object} config - ブロック設定オブジェクト
 * @param {number} meta - 接続状態や回転などの追加情報 (0-15)
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

    // 2. ★ キャッシュキーの生成 (type + meta を組み合わせる)
    // これにより、接続パターンごとのフェンスが別々にキャッシュされます
    const cacheKey = typeof type === 'number' ? (type << 4) | (meta & 0xF) : `${type}_${meta}`;
    if (cachedBlockGeometries[cacheKey]) return cachedBlockGeometries[cacheKey];

    let geom;

    switch (type) {
        case "cube":
            geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            break;

        case "slab": {
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
                if (nx > 0.5) matIdx = 0;      // East
                else if (nx < -0.5) matIdx = 1; // West
                else if (ny > 0.5) matIdx = 2; // Top
                else if (ny < -0.5) matIdx = 3; // Bottom
                else if (nz > 0.5) matIdx = 4; // South
                else if (nz < -0.5) matIdx = 5; // North

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
            geom = slabGeom;
            break;
        }

        case "stairs": {
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
            geom = merged;
            break;
        }

        case "cross": {
            const p1 = SHARED_PLANE.clone();
            p1.rotateY(THREE.MathUtils.degToRad(45));
            const p2 = SHARED_PLANE.clone();
            p2.rotateY(THREE.MathUtils.degToRad(-45));
            geom = BufferGeometryUtils.mergeBufferGeometries([p1, p2], true);
            geom.translate(0.5, 0.5, 0.5);
            break;
        }

        case "fence": {
            // metaから接続状態を判定（12ビットシフト済みの生IDから渡される想定）
            const n = (meta >> 3) & 1;
            const s = (meta >> 2) & 1;
            const e = (meta >> 1) & 1;
            const w = meta & 1;

            const geometries = [];
            const applyGroup = (g) => {
                g.clearGroups();
                g.addGroup(0, Infinity, 0); // フェンスは単一テクスチャ[cite: 1]
                return g;
            };

            // 1. 中央の柱 (常に表示 / 幅0.25)[cite: 1]
            const post = new THREE.BoxGeometry(0.25, 1, 0.25);
            post.translate(0.5, 0.5, 0.5);
            geometries.push(applyGroup(post));

            const barWidth = 0.125;  // 横幅: 4/16 (0.25)
            const barHeight = 0.1875; // 高さ: 3/16 (0.1875)

            // 2. 接続用の棒を生成するヘルパーの修正
            const createBar = (x, z, bw, bd) => {
                // 常に barHeight(0.1875) を高さとして使用するように固定
                const b1 = new THREE.BoxGeometry(bw, barHeight, bd);
                const b2 = b1.clone();

                // 配置の高さ（Y座標）も本家の位置へ微調整
                // 下の棒: 地面から 6/16 (0.375)
                // 上の棒: 地面から 12/16 (0.75)
                b1.translate(x, 0.375 + (barHeight / 2), z);
                b2.translate(x, 0.75 + (barHeight / 2), z);

                return [applyGroup(b1), applyGroup(b2)];
            };

            // 各方向への接続[cite: 1]
            if (n) geometries.push(...createBar(0.5, 0.25, barWidth, 0.5)); // 北 (-Z)
            if (s) geometries.push(...createBar(0.5, 0.75, barWidth, 0.5)); // 南 (+Z)
            if (e) geometries.push(...createBar(0.75, 0.5, 0.5, barWidth)); // 東 (+X)
            if (w) geometries.push(...createBar(0.25, 0.5, 0.5, barWidth)); // 西 (-X)

            // 全てのパーツを1つのジオメトリに統合[cite: 1]
            geom = BufferGeometryUtils.mergeBufferGeometries(geometries, true);

            // --- 🟢 テクスチャUVの再計算処理 (崩れ防止) ---
            const posAttr = geom.getAttribute('position');
            const normAttr = geom.getAttribute('normal');
            const uvAttr = geom.getAttribute('uv');

            for (let i = 0; i < posAttr.count; i++) {
                const nx = Math.abs(normAttr.getX(i));
                const ny = Math.abs(normAttr.getY(i));
                const nz = Math.abs(normAttr.getZ(i));

                let u, v;
                // 面の向き（法線）に応じて、座標値をUVに投影する
                if (ny > 0.5) {
                    // 上下面: XZ平面を投影
                    u = posAttr.getX(i);
                    v = posAttr.getZ(i);
                } else if (nx > 0.5) {
                    // 側面 (X向き): ZY平面を投影
                    u = posAttr.getZ(i);
                    v = posAttr.getY(i);
                } else {
                    // 側面 (Z向き): XY平面を投影
                    u = posAttr.getX(i);
                    v = posAttr.getY(i);
                }
                uvAttr.setXY(i, u, v);
            }
            uvAttr.needsUpdate = true;
            break;
        }

        case "pane": {
            const n = (meta >> 3) & 1;
            const s = (meta >> 2) & 1;
            const e = (meta >> 1) & 1;
            const w = meta & 1;

            const geometries = [];
            // 厚みを 0.0625 (1/16) から 0.125 (2/16) に変更
            const thick = 0.125;
            const halfThick = thick / 2;

            const MAT_GLASS = 0; // glass.png
            const MAT_FRAME = 2; // glass_pane_top.png

            /**
             * 一定の厚みでパーツを生成し、UVを投影する
             */
            const addFlatPart = (x, y, z, w_size, h_size, d_size, axis) => {
                const g = new THREE.BoxGeometry(w_size, h_size, d_size);
                g.translate(x + w_size / 2, y + h_size / 2, z + d_size / 2);
                g.clearGroups();

                const pos = g.getAttribute('position');
                const uv = g.getAttribute('uv');

                // 1. マテリアル割り当て
                for (let i = 0; i < 6; i++) {
                    let idx = MAT_FRAME;
                    if (axis === 'z' && (i === 0 || i === 1)) idx = MAT_GLASS; // E/W面
                    if (axis === 'x' && (i === 4 || i === 5)) idx = MAT_GLASS; // N/S面
                    g.addGroup(i * 6, 6, idx);
                }

                // 2. UVの再計算：ワールド座標投影で繋ぎ目を消す
                for (let i = 0; i < pos.count; i++) {
                    const worldX = pos.getX(i);
                    const worldY = pos.getY(i);
                    const worldZ = pos.getZ(i);

                    let u = (axis === 'x') ? worldX : worldZ;
                    let v = worldY;

                    uv.setXY(i, u, v);
                }
                uv.needsUpdate = true;
                geometries.push(g);
            };

            const hasAnyConn = (n || s || e || w);

            // 南北方向：中心からの厚みを増やしてフラットに生成[cite: 1]
            if (n || s || !hasAnyConn) {
                const zStart = n ? 0 : 0.5 - halfThick;
                const zEnd = s ? 1 : 0.5 + halfThick;
                const depth = zEnd - zStart;

                addFlatPart(0.5 - halfThick, 0, zStart, thick, 1, depth, 'z');
            }

            // 東西方向：南北パーツと同じ厚みで交差させる[cite: 1]
            if (e || w) {
                const xStart = w ? 0 : 0.5 - halfThick;
                const xEnd = e ? 1 : 0.5 + halfThick;
                const width = xEnd - xStart;

                addFlatPart(xStart, 0, 0.5 - halfThick, width, 1, thick, 'x');
            }

            geom = BufferGeometryUtils.mergeBufferGeometries(geometries, true);
            break;
        }

        case "water":
            geom = new THREE.BoxGeometry(1, 0.88, 1);
            geom.translate(0.5, 0.44, 0.5);
            adjustSideUVs(geom, 0.88);
            break;

        case "leaves":
            geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            break;

        case "carpet":
            geom = new THREE.BoxGeometry(1, 0.0625, 1);
            geom.translate(0.5, 0.03125, 0.5);
            adjustSideUVsForCarpet(geom, 0.0625);
            break;

        case "ladder":
            geom = new THREE.PlaneGeometry(1, 1);
            geom.translate(0.5, 0.5, 0.05);
            geom.addGroup(0, 6, 0);
            break;

        default:
            geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            break;
    }

    geom.computeBoundingBox();
    geom.computeVertexNormals();

    // ★ 生成されたジオメトリを cacheKey で保存
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

    // 行列の初期化 (_tmpMat, _rotMat, _transMat, _center は事前に定義されている前提)
    _tmpMat.identity();
    _rotMat.identity();

    if (cfg.isLog) {
        const logMat = getLogRotationMatrix(metadata);
        _tmpMat.copy(logMat);
        _rotMat.extractRotation(_tmpMat);
    } else {
        const rotation = metadata & 3; // 下位2ビット：回転(0=北, 1=東, 2=南, 3=西)
        const isUpsideDown = (metadata >> 2) & 1; // 3ビット目：上下反転

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

    const materials = getBlockMaterials(blockId);
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