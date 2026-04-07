"use strict";
import * as THREE from "./build/three.module.js";
import { BufferGeometryUtils } from './jsm/utils/BufferGeometryUtils.js';

// ================================================
// ② ブロック定義 (BLOCK_CONFIG) の拡張
// ================================================

// --- Box3作成ヘルパー ---

function createBox(x1, y1, z1, x2, y2, z2) {
    const b = new THREE.Box3();
    b.min.set(x1, y1, z1);
    b.max.set(x2, y2, z2);
    return b;
}

// --- カスタム衝突判定キャッシュ ---
const CUSTOM_COLLISION_CACHE = {
    stairs: [createBox(0, 0, 0, 1, 0.5, 1), createBox(0.5, 0.5, 0, 1, 1, 1)],
    slab: [createBox(0, 0, 0, 1, 0.5, 1)],
    cross: [createBox(0.25, 0, 0.25, 0.75, 1, 0.75)],
    carpet: [createBox(0, 0, 0, 1, 0.0625, 1)]
};

// --- カスタム衝突判定取得関数 ---
function getCustomCollision(type) {
    const base = CUSTOM_COLLISION_CACHE[type] || [];
    // 変換をかけるため、必ず新しいインスタンスを生成して返す
    return base.map(box => box.clone());
}

export function getLogRotationMatrix(metadata) {
    const matrix = new THREE.Matrix4();
    const axis = metadata & 3; // 0:Y, 1:X, 2:Z
    const center = 0.5;

    // 1. 中心へ移動
    matrix.makeTranslation(-center, -center, -center);

    // 2. 軸に応じて回転
    if (axis === 1) { // X軸向き（横）
        matrix.premultiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
    } else if (axis === 2) { // Z軸向き（奥行）
        matrix.premultiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    }

    // 3. 元の位置に戻す
    matrix.premultiply(new THREE.Matrix4().makeTranslation(center, center, center));
    return matrix;
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
    customCollision: null,  // ← 追加
    hardness: 1.0,
    Gamma: 1.0,
    lightLevel: 0,
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
    return { ...defaultBlockConfig, ...customConfig }; // ← 元コードは Object.assign だった可能性
}

// ── 個別ブロック設定 ──
export const BLOCK_CONFIG = {
    SKY: createBlockConfig({
        id: 0,
        itemdisplay: false,
        collision: false,
        geometryType: "none", // 描画しない
        transparent: false,
        opacity: 1,
        overwrite: true,
        screenFill: false,
        textures: {}
    }),
    GRASS: createBlockConfig({
        id: 1,
        textures: {
            top: "textures/blocks/grass_top.png",
            side: "textures/blocks/grass_side.png",
            bottom: "textures/blocks/dirt.png"
        }
    }),
    DIRT: createBlockConfig({
        id: 2,
        textures: { all: "textures/blocks/dirt.png" }
    }),
    STONE: createBlockConfig({
        id: 3,
        textures: { all: "textures/blocks/stone.png" }
    }),
    COBBLE_STONE: createBlockConfig({
        id: 4,
        textures: { all: "textures/blocks/cobblestone.png" }
    }),
    COBBLE_STONE_MOSSY: createBlockConfig({
        id: 5,
        textures: { all: "textures/blocks/cobblestone_mossy.png" }
    }),
    COAL_ORE: createBlockConfig({
        id: 6,
        textures: { all: "textures/blocks/coal_ore.png" }
    }),
    PLANKS_OAK: createBlockConfig({
        id: 7,
        textures: { all: "textures/blocks/planks_oak.png" }
    }),
    BRICK: createBlockConfig({
        id: 8,
        textures: { all: "textures/blocks/brick.png" }
    }),
    BEDROCK: createBlockConfig({
        id: 9,
        textures: { all: "textures/blocks/bedrock.png" }
    }),
    STONE_STAIRS: createBlockConfig({
        id: 10,
        textures: {
            top: "textures/blocks/stone.png",
            bottom: "textures/blocks/stone.png",
            side: "textures/blocks/stone.png"
        },
        geometryType: "stairs",
        transparent: true,
        directional: true,
        customCollision: () => getCustomCollision("stairs"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 2.0
    }),
    STONE_SLAB: createBlockConfig({
        id: 11,
        textures: { all: "textures/blocks/stone.png" },
        geometryType: "slab",
        transparent: true,
        isSlab: true,
        customCollision: () => getCustomCollision("slab"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,
        selectionSize: { x: 1, y: 0.5, z: 1 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 }
    }),
    GLASS: createBlockConfig({
        id: 12,
        textures: { all: "textures/blocks/glass.png" },
        transparent: true,
        geometryType: "cube",
        screenFill: false
    }),
    FLOWER: createBlockConfig({
        id: 13,
        textures: { all: "textures/blocks/flower.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.4, y: 0.6, z: 0.4 },
        selectionOffset: { x: 0.5, y: 0.3, z: 0.5 }
    }),
    FLOWER_ROSE: createBlockConfig({
        id: 14,
        textures: { all: "textures/blocks/flower_rose.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.4, y: 0.6, z: 0.4 },
        selectionOffset: { x: 0.5, y: 0.3, z: 0.5 }
    }),
    TALLGRASS: createBlockConfig({
        id: 15,
        textures: { all: "textures/blocks/tallgrass.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.8, y: 0.8, z: 0.8 },
        selectionOffset: { x: 0.5, y: 0.4, z: 0.5 }
    }),
    LEAVES: createBlockConfig({
        id: 16,
        textures: { all: "textures/blocks/leaves.png" },
        geometryType: "leaves",
        transparent: true,
        cullAdjacentFaces: false,
        screenFill: false
    }),
    WOOL_CARPET: createBlockConfig({
        id: 17,
        textures: { all: "textures/blocks/wool_colored_white.png" },
        geometryType: "carpet",
        transparent: true,
        customCollision: () => getCustomCollision("carpet"),
        Gamma: 0.8,
        cullAdjacentFaces: false,
        screenFill: false,
        selectionSize: { x: 1, y: 0.0625, z: 1 },
        selectionOffset: { x: 0.5, y: 0.03125, z: 0.5 }
    }),
    WATER: createBlockConfig({
        id: 18,
        textures: { all: "textures/blocks/water.png" },
        collision: false,
        transparent: true,
        opacity: 0.8,
        targetblock: false,
        overwrite: true,
        geometryType: "water",
        previewType: "2D"
    }),
    LAVA: createBlockConfig({
        id: 19,
        textures: { all: "textures/blocks/lava.png" },
        collision: false,
        transparent: true,
        opacity: 1,
        targetblock: false,
        overwrite: true,
        geometryType: "water",
        lightLevel: 15,
        previewType: "2D"
    }),
    GLOWSTONE: createBlockConfig({
        id: 20, // 重複しない新しいID
        textures: { all: "textures/blocks/glowstone.png" }, // 使用するテクスチャパス
        geometryType: "cube",
        lightLevel: 15,
        hardness: 1.0
    }),
    LOG_OAK: createBlockConfig({
        id: 21,
        isLog: true,
        textures: {
            top: "textures/blocks/log_oak_top.png",
            bottom: "textures/blocks/log_oak_top.png",
            side: "textures/blocks/log_oak.png"
        }
    }),
    SAPLING_OAK: createBlockConfig({
        id: 22,
        textures: { all: "textures/blocks/sapling_oak.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.8, y: 0.8, z: 0.8 },
        selectionOffset: { x: 0.5, y: 0.4, z: 0.5 }
    }),
    DEADBUSH: createBlockConfig({
        id: 23,
        textures: { all: "textures/blocks/deadbush.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: 0.8, y: 0.8, z: 0.8 },
        selectionOffset: { x: 0.5, y: 0.4, z: 0.5 }
    }),
};

export const BLOCK_TYPES = Object.fromEntries(
    Object.entries(BLOCK_CONFIG).map(([key, cfg]) => [key, cfg.id])
);
for (const cfg of Object.values(BLOCK_CONFIG)) {
    if (typeof cfg.customCollision === "function") {
        cfg._cachedCollision = cfg.customCollision();
    }
}

const loadingManager = new THREE.LoadingManager();
loadingManager.maxConnections = 16; // 同時ロード数を増やす（デフォルト6）

const textureLoader = new THREE.TextureLoader(loadingManager);
const textureCache = new Map();
let sharedEmptyTexture = null; // フォールバック無し時に共有する空テクスチャ

// ロード中の Promise を管理するキャッシュ（重複ロードを完全に防ぐ）
const loadingPromises = new Map();

function cachedLoadTexture(path, fallback = null) {
    // 1. パスがない場合はフォールバックへ
    if (!path) {
        if (fallback) return cachedLoadTexture(fallback, null);
        return getSharedEmptyTexture();
    }

    // 2. すでに完了したキャッシュがあれば即座に返す
    if (textureCache.has(path)) return textureCache.get(path);

    // 3. ロード中の場合は、その処理を待機している placeholder を返す
    // これにより、同じパスに対して同時に1回しか textureLoader.load が走らない
    if (loadingPromises.has(path)) return textureCache.get(path);

    // 4. 新規ロード開始
    const placeholder = new THREE.Texture();
    textureCache.set(path, placeholder);

    const loadPromise = new Promise((resolve) => {
        textureLoader.load(
            path,
            (tex) => {
                // 成功時：ピクセルパーフェクトな設定
                tex.magFilter = THREE.NearestFilter;
                tex.minFilter = THREE.NearestMipmapNearestFilter;
                tex.generateMipmaps = true;

                // placeholder の中身を書き換え
                placeholder.image = tex.image;
                placeholder.magFilter = tex.magFilter;
                placeholder.minFilter = tex.minFilter;
                placeholder.needsUpdate = true;

                resolve(placeholder);
            },
            undefined,
            (err) => {
                console.warn(`Texture load failed: ${path}`);
                if (fallback && fallback !== path) {
                    const fbTex = cachedLoadTexture(fallback, null);
                    // フォールバック画像がすでにロード済みなら中身をコピー
                    if (fbTex.image) {
                        placeholder.image = fbTex.image;
                        placeholder.needsUpdate = true;
                    }
                } else {
                    // 最終防衛ライン：マゼンタのチェック柄などを適用（既存のロジック）
                    applyErrorTexture(placeholder);
                }
                resolve(placeholder);
            }
        );
    });

    loadingPromises.set(path, loadPromise);
    return placeholder;
}

// ヘルパー：エラー時にマゼンタ色を塗る
function applyErrorTexture(tex) {
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 1, 1); ctx.fillRect(1, 1, 1, 1);
    ctx.fillStyle = '#000000'; ctx.fillRect(1, 0, 1, 1); ctx.fillRect(0, 1, 1, 1);
    tex.image = canvas;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
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
// 2. メイン関数
// ========================================================
const materialCache = new Map(); // ブロック構成ごとのキャッシュ

export function createMaterialsFromBlockConfig(blockConfig) {
    const cacheKey = blockConfig.id;
    if (materialCache.has(cacheKey)) return materialCache.get(cacheKey);

    const { geometryType, transparent, textures, id, lightLevel, opacity = 1.0 } = blockConfig;

    // --- 判定ロジックの整理 ---
    const isWater = (id === 18);
    const isLightSource = (lightLevel !== undefined && lightLevel > 0);

    // 半透明ブレンドは「水」のみ適用（描画順バグ防止）
    const isBlendTransparent = isWater;

    // ガラス・草などは AlphaCutout (alphaTest) で処理
    const isAlphaCutout = transparent === true && !isBlendTransparent;

    // 表示面の決定
    const isCrossOrLeaves = (geometryType === "cross" || geometryType === "leaves");
    const side = (isCrossOrLeaves || isWater) ? THREE.DoubleSide : THREE.FrontSide;

    // 頂点カラー（ライティング）を使用するか
    const isStairsOrSlab = (geometryType === "stairs" || geometryType === "slab");
    const useVertexColors = (!isStairsOrSlab && !isCrossOrLeaves && !isWater);

    // 同一ブロック内でテクスチャが重複する場合、マテリアルを再利用するためのローカルキャッシュ
    const localMatCache = new Map();

    /**
     * 個別の面マテリアルを生成・取得する
     */
    function getMat(face) {
        const texPath = resolveTexturePath(face);

        // すでに同じテクスチャのマテリアルを作っていればそれを返す（ドローコール削減）
        if (localMatCache.has(texPath)) return localMatCache.get(texPath);

        const materialOptions = {
            color: blockConfig.defaultColor ?? 0xffffff,
            transparent: isBlendTransparent,
            opacity: opacity,
            vertexColors: useVertexColors,
            side: side,
            depthWrite: !isBlendTransparent, // 水以外は深度を書き込む（透けないように）
            alphaTest: isAlphaCutout ? 0.5 : 0,
        };

        if (texPath && texPath !== "none") {
            materialOptions.map = cachedLoadTexture(texPath, blockConfig.fallbackTexture);
        }

        const mat = new THREE.MeshBasicMaterial(materialOptions);

        // シェーダーで使用する変数を保持
        mat.userData.shaderUniforms = {
            u_skyFactor: { value: 1.0 },
            u_isLightSource: { value: isLightSource ? 1.0 : 0.0 }
        };

        // シェーダーコンパイル時にロジックを注入
        mat.onBeforeCompile = (shader) => onBeforeCompileBlock(shader, mat);

        localMatCache.set(texPath, mat);
        return mat;
    }

    /**
     * 面の名前に応じて適切なテクスチャパスを返す
     */
    function resolveTexturePath(face) {
        if (textures) {
            if (textures.all) return textures.all;
            if (textures[face]) return textures[face];
            if (textures.side && face !== "top" && face !== "bottom") return textures.side;
            if (textures.top && face === "top") return textures.top;
            if (textures.bottom && face === "bottom") return textures.bottom;
        }
        return blockConfig.fallbackTexture || null;
    }

    // --- マテリアル配列の構築 ---
    const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];
    let resultMaterials;

    if (textures && textures.all) {
        // 全面同じ場合は1つのインスタンスで埋める
        const singleMat = getMat("all");
        resultMaterials = [singleMat, singleMat, singleMat, singleMat, singleMat, singleMat];
    } else {
        // 面ごとに取得（同じテクスチャなら getMat 内でキャッシュが効く）
        resultMaterials = FACE_ORDER.map(face => getMat(face));
    }

    materialCache.set(cacheKey, resultMaterials);
    return resultMaterials;
}


// マテリアルのキャッシュ（ブロックIDごと）
const BLOCK_MATERIALS_CACHE = new Map();
// BLOCK_CONFIG から各ブロック設定を高速に取得するためのルックアップテーブル
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
    // 1. 下位12ビット(0xFFF)でマスクし、純粋なブロックIDのみを抽出する
    // これにより、回転しているブロック(例: ID 4106)も元のID(例: 10)として扱える
    const bId = Number(blockType) & 0xFFF;

    // 2. IDベースのキャッシュを確認（向きが違ってもマテリアルは共通なため）
    if (BLOCK_MATERIALS_CACHE.has(bId)) {
        return BLOCK_MATERIALS_CACHE.get(bId);
    }

    // 3. ルックアップテーブルから設定を取得
    const config = blockConfigLookup[bId];
    if (!config) {
        // IDが0(SKY)の場合は警告を出さずにnullを返す（描画不要なため）
        if (bId !== 0) {
            console.warn(`Unknown block type ID: ${bId} (Original value: ${blockType})`);
        }
        return null;
    }

    // 4. マテリアル生成
    const materials = createMaterialsFromBlockConfig(config);

    // 5. 純粋なIDをキーとしてキャッシュに保存
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
export function getBlockGeometry(type, config) {
    // カスタムジオメトリがあればキャッシュ
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

    // 標準ジオメトリをキャッシュから取得
    if (cachedBlockGeometries[type]) return cachedBlockGeometries[type];

    let geom;

    switch (type) {
        case "cube":
            geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            break;

        case "slab":
            geom = new THREE.BoxGeometry(1, 0.5, 1);
            geom.translate(0.5, 0.25, 0.5);
            adjustSideUVs(geom);
            break;

        case "stairs": {
            const lower = new THREE.BoxGeometry(1, 0.5, 1);
            lower.translate(0.5, 0.25, 0.5);
            // adjustSideUVs(lower) は不要になるので削除します

            const upper = new THREE.BoxGeometry(0.5, 0.5, 1);
            upper.translate(0.75, 0.75, 0.5);
            // adjustSideUVs(upper) は不要になるので削除します

            const merged = BufferGeometryUtils.mergeBufferGeometries([lower, upper], true);

            const posAttr = merged.getAttribute('position'); // 頂点座標を取得
            const normAttr = merged.getAttribute('normal'); // 法線（向き）を取得
            const uvAttr = merged.getAttribute('uv');       // UV座標を取得
            const indexAttr = merged.index;

            merged.clearGroups(); // 一旦古い12個のグループをリセット

            for (let i = 0; i < indexAttr.count; i += 6) {
                const vertexIndex = indexAttr.array[i] * 3;
                const nx = normAttr.array[vertexIndex];
                const ny = normAttr.array[vertexIndex + 1];
                const nz = normAttr.array[vertexIndex + 2];

                let matIdx = 0;
                if (nx > 0.5) matIdx = 0;      // 右面 (+X)
                else if (nx < -0.5) matIdx = 1; // 左面 (-X)
                else if (ny > 0.5) matIdx = 2; // 上面 (+Y)
                else if (ny < -0.5) matIdx = 3; // 下面 (-Y)
                else if (nz > 0.5) matIdx = 4; // 正面 (+Z)
                else if (nz < -0.5) matIdx = 5; // 背面 (-Z)

                merged.addGroup(i, 6, matIdx);

                // 💡 【修正】各面を構成する6つのインデックスのUVを、頂点座標(xyz)から再計算する
                for (let f = 0; f < 6; f++) {
                    const idx = indexAttr.array[i + f];
                    const vx = posAttr.array[idx * 3];     // ブロック内の X 座標 (0.0 ～ 1.0)
                    const vy = posAttr.array[idx * 3 + 1]; // ブロック内の Y 座標 (0.0 ～ 1.0)
                    const vz = posAttr.array[idx * 3 + 2]; // ブロック内の Z 座標 (0.0 ～ 1.0)

                    let u = 0, v = 0;

                    switch (matIdx) {
                        case 0: // 右面 (+X) 
                        case 1: // 左面 (-X)
                            u = vz; // Zを横軸に
                            v = vy; // Yを縦軸に
                            break;
                        case 2: // 上面 (+Y)
                        case 3: // 下面 (-Y)
                            u = vx; // Xを横軸に
                            v = vz; // Zを縦軸に
                            break;
                        case 4: // 正面 (+Z)
                        case 5: // 背面 (-Z)
                            u = vx; // Xを横軸に
                            v = vy; // Yを縦軸に
                            break;
                    }

                    // 頂点の座標（0.0〜1.0）をそのままUVとして焼き付ける
                    uvAttr.array[idx * 2] = u;
                    uvAttr.array[idx * 2 + 1] = v;
                }
            }

            uvAttr.needsUpdate = true; // UV情報を更新
            geom = merged;
            break;
        }

        case "cross": {
            const p1 = SHARED_PLANE.clone();
            p1.rotateY(THREE.MathUtils.degToRad(45));

            const p2 = SHARED_PLANE.clone();
            p2.rotateY(THREE.MathUtils.degToRad(-45));

            geom = BufferGeometryUtils.mergeBufferGeometries([p1, p2], true);
            geom.computeBoundingBox();
            const center = new THREE.Vector3();
            geom.boundingBox.getCenter(center);
            geom.translate(-center.x, -center.y, -center.z);
            geom.translate(0.5, 0.5, 0.5);
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
            geom = new THREE.BoxGeometry(1, 0.0625, 1); // 高さ 1/16
            geom.translate(0.5, 0.03125, 0.5);          // 中心調整
            adjustSideUVsForCarpet(geom, 0.0625);       // 横面 UV 高さに合わせる
            break;

        default:
            geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            break;
    }

    geom.computeBoundingBox();
    geom.computeVertexNormals();
    // キャッシュ保存
    cachedBlockGeometries[type] = geom;
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

    // 行列の初期化
    _tmpMat.identity();
    _rotMat.identity();

    if (cfg.isLog) {
        const logMat = getLogRotationMatrix(metadata);
        _tmpMat.copy(logMat);
        _rotMat.extractRotation(_tmpMat);
    } else {
        const rotation = metadata & 3;
        const isUpsideDown = (metadata >> 2) & 1;

        // 回転行列 R の構築
        if (isUpsideDown) {
            _rotMat.makeRotationX(Math.PI);
        }
        if (rotation !== 0) {
            _transMat.makeRotationY(rotation * (Math.PI / 2));
            _rotMat.multiply(_transMat);
        }

        // 行列合成: T(0.5) * R * T(-0.5)
        // 1. 中心から原点へ
        _tmpMat.makeTranslation(-_center.x, -_center.y, -_center.z);
        // 2. 回転適用 ( R * T )
        _tmpMat.premultiply(_rotMat);
        // 3. 原点から中心へ ( T_inv * R * T )
        _transMat.makeTranslation(_center.x, _center.y, _center.z);
        _tmpMat.premultiply(_transMat);
    }

    if (target instanceof THREE.Box3) {
        // 頂点座標のセット
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
            _boxPoints[i].applyMatrix4(_tmpMat);
            target.expandByPoint(_boxPoints[i]);
        }

        // スラブの上付き補正（当たり判定用）
        if (!cfg.isLog && cfg.isSlab && !cfg.directional && ((metadata >> 2) & 1)) {
            _vec3.set(0, 0.5, 0);
            target.translate(_vec3);
        }
    } else if (target instanceof THREE.Object3D) {
        // 回転の適用
        target.quaternion.setFromRotationMatrix(_rotMat);

        // Y座標の絶対補正 (再計算に強いロジック)
        if (!cfg.isLog) {
            const isUpsideDown = (metadata >> 2) & 1;
            const baseY = Math.floor(target.position.y);
            // スラブかつ方向性なし(通常ハーフ)の場合は 0.5、階段などのフルブロック回転は 1.0
            const offset = isUpsideDown ? ((cfg.isSlab && !cfg.directional) ? 0.5 : 1.0) : 0;
            target.position.y = baseY + offset;
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
    // 1. 純粋なブロックIDの抽出
    const blockId = Number(rawBlockType) & 0xFFF;
    const finalMetadata = metadata !== 0 ? metadata : (Number(rawBlockType) >> 12);

    // 2. 設定の取得
    const config = getBlockConfiguration(blockId);
    if (!config) {
        console.error("Unknown block type ID:", blockId, "(raw:", rawBlockType, ")");
        return null;
    }

    // 3. ジオメトリとマテリアルの取得
    const geometry = getBlockGeometry(config.geometryType, config);
    const materials = getBlockMaterials(blockId);
    if (!materials) return null;

    // 4. Mesh作成
    let mesh = new THREE.Mesh(geometry, materials);

    // 5. 位置と回転の適用
    // 💡 改善点: applyMetadataTransform 内で加算ではなく絶対座標をセットするように修正
    // (※前述の applyMetadataTransform の修正とセットで運用してください)
    mesh.position.copy(pos);
    applyMetadataTransform(mesh, finalMetadata, blockId);

    mesh.castShadow = false;
    mesh.receiveShadow = false;

    // 6. 当たり判定の構築 (GC対策版)
    let boxes = [];
    if (typeof config.customCollision === "function") {
        boxes = config.customCollision();
    } else if (config.collision) {
        // 💡 改善点: getCustomCollision ヘルパーを使い、定数からクローンするように統一
        // getCustomCollision("cube") は [Box3(0,0,0 to 1,1,1)] を返す想定
        const typeKey = config.geometryType === "slab" ? "slab" : "cube";
        boxes = getCustomCollision(typeKey);
    }

    // 7. 当たり判定の座標変換
    mesh.userData.collisionBoxes = boxes.map(box => {
        applyMetadataTransform(box, finalMetadata, blockId);
        box.translate(pos);
        return box;
    });

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