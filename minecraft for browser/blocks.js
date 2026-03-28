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
    return CUSTOM_COLLISION_CACHE[type] || [];
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
    PLANKS: createBlockConfig({
        id: 7,
        textures: { all: "textures/blocks/planks.png" }
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
    SAPLING_OAK: createBlockConfig({
        id: 21,
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
};

const BLOCK_TYPES = Object.fromEntries(
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
const materialCache = new Map();      // ブロック構成ごとのキャッシュ
function createMaterialsFromBlockConfig(blockConfig) {
    const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];
    const { geometryType, transparent, textures } = blockConfig;

    const cacheKey = blockConfig.id;
    if (materialCache.has(cacheKey)) return materialCache.get(cacheKey);

    const opacity = (blockConfig.opacity !== undefined) ? blockConfig.opacity : 1.0;

    const isStairsOrSlab = geometryType === "stairs" || geometryType === "slab";
    const isCross = geometryType === "cross" || geometryType === "leaves";
    const isWater = geometryType === "water";
    const isGlass = blockConfig.id === 12;

    // 💡 【修正】真偽値（true/false）ではなく、数値の lightLevel を見て光源かどうかを判定する
    const isLightSource = (blockConfig.lightLevel !== undefined && blockConfig.lightLevel > 0);

    // 💡 透過ブレンド（半透明）にするのは、純粋な「水（ID: 18）」の時だけにする！
    const isBlendTransparent = (blockConfig.id === 18);

    // 💡 光源や、透過ブレンドする水以外の「透明フラグ付きブロック」をカットアウト対象にする
    const isAlphaCutout = transparent === true && !isBlendTransparent && !isLightSource;

    // 水と溶岩（geometryType === "water"）は両面描画(DoubleSide)にしておく
    const side = (isCross || isWater) ? THREE.DoubleSide : THREE.FrontSide;
    const useVertexColors = (!isStairsOrSlab && !isCross && !isWater);

    function resolveTexturePath(face) {
        if (textures && textures.all) return textures.all;
        if (textures && textures[face]) return textures[face];
        if (textures && textures.side) return textures.side;
        return blockConfig.fallbackTexture || null;
    }

    // --- 改善後：マテリアル設定部分の抜粋 ---

    function getMat(texPathOrNone) {
        const isWater = (blockConfig.id === 18);
        const isLava = (blockConfig.id === 19);

        const materialOptions = {
            color: blockConfig.defaultColor ?? 0xffffff,
            transparent: isBlendTransparent,
            opacity: opacity,
            vertexColors: useVertexColors,
            side: side,
            depthWrite: !isBlendTransparent,
            alphaTest: isAlphaCutout ? 0.5 : 0,
        };

        if (texPathOrNone && texPathOrNone !== "none") {
            materialOptions.map = cachedLoadTexture(texPathOrNone, blockConfig.fallbackTexture);
        }

        const mat = new THREE.MeshBasicMaterial(materialOptions);

        // ユニフォームの初期化を確実に
        mat.userData.shaderUniforms = {
            u_skyFactor: { value: 1.0 },
            u_isLightSource: { value: isLightSource ? 1.0 : 0.0 }
        };

        mat.onBeforeCompile = (shader) => {
            shader.uniforms.u_skyFactor = mat.userData.shaderUniforms.u_skyFactor;
            shader.uniforms.u_isLightSource = mat.userData.shaderUniforms.u_isLightSource;

            // 頂点シェーダーの注入（改善前より整理）
            shader.vertexShader = `
            uniform float u_skyFactor;
            uniform float u_isLightSource;
            ${shader.vertexShader}
        `.replace(
                '#include <color_vertex>',
                `
            #include <color_vertex>
            float skyLight = vColor.r; 
            float blockLight = vColor.g; 
            
            if (u_isLightSource > 0.5) {
                vColor.rgb = vec3(1.0);
            } else {
                vColor.rgb = vec4(max(skyLight * u_skyFactor, blockLight)).rgb;
            }
            `
            );
        };
        return mat;
    }

    if (textures && textures.all) {
        const mat = getMat(textures.all);
        const arr = [mat, mat, mat, mat, mat, mat];
        materialCache.set(cacheKey, arr);
        return arr;
    }

    const materials = FACE_ORDER.map(f => getMat(resolveTexturePath(f)));
    materialCache.set(cacheKey, materials);
    return materials;
}


// マテリアルのキャッシュ（ブロックIDごと）
const BLOCK_MATERIALS_CACHE = new Map();

/**
 * 指定ブロックタイプのマテリアル配列を返す。  
 * キャッシュがあれば再利用し、無駄な再生成を防ぐ。
 * @param {number} blockType - ブロック種識別子
 * @returns {THREE.Material[] | null} - マテリアルの配列（複数マテリアル対応）
 */
function getBlockMaterials(blockType) {
    const bType = Number(blockType);

    // キャッシュがあれば即返す
    if (BLOCK_MATERIALS_CACHE.has(bType)) {
        return BLOCK_MATERIALS_CACHE.get(bType);
    }

    // O(1) で設定取得
    const config = blockConfigLookup[bType];
    if (!config) {
        console.warn(`Unknown block type: ${bType}`);
        return null;
    }

    // マテリアル生成＆キャッシュ保存
    const materials = createMaterialsFromBlockConfig(config);
    BLOCK_MATERIALS_CACHE.set(bType, materials);
    return materials;
}

/* -------------------------------------------------------------------------
   2. ブロック Mesh の生成
   -------------------------------------------------------------------------
*/
// 標準ジオメトリとカスタムジオメトリのキャッシュ
const cachedBlockGeometries = {};
const cachedCustomGeometries = {};

// BLOCK_CONFIG から各ブロック設定を高速に取得するためのルックアップテーブル
const blockConfigLookup = {};
for (const cfg of Object.values(BLOCK_CONFIG)) {
    blockConfigLookup[cfg.id] = cfg;
}

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
function getBlockGeometry(type, config) {
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

/**
 * マルチマテリアル対応ブロックメッシュ生成
 * @param {number} blockType
 * @param {THREE.Vector3} pos
 * @param {THREE.Euler} [rotation]
 * @returns {THREE.Mesh|null}
 */
function createBlockMesh(blockType, pos, rotation) {
    const config = getBlockConfiguration(blockType);
    if (!config) {
        console.error("Unknown block type:", blockType);
        return null;
    }

    // ジオメトリとマテリアル取得
    const geometry = getBlockGeometry(config.geometryType, config);
    const materials = getBlockMaterials(blockType);
    if (!materials) {
        console.error("No materials found for block type:", blockType);
        return null;
    }

    // Mesh作成（マルチマテリアル対応）
    let mesh;
    if (Array.isArray(materials) && materials.length > 1 && geometry.groups && geometry.groups.length > 0) {
        mesh = new THREE.Mesh(geometry, materials);
    } else {
        mesh = new THREE.Mesh(geometry, Array.isArray(materials) ? materials[0] : materials);
    }

    // 位置・影設定
    mesh.position.copy(pos);
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    if (rotation) {
        mesh.rotation.copy(rotation);
    }

    // カスタム衝突判定のBox3をキャッシュから取得・clone＆座標調整
    if (typeof config.customCollision === "function") {
        if (!mesh.userData.localCollisionBoxes) {
            mesh.userData.localCollisionBoxes = config._cachedCollision || [];
            mesh.userData.collisionBoxes = config._cachedCollision.map(box => box.clone());
        }
        if (!mesh.userData.collisionBoxes) {
            mesh.userData.collisionBoxes = mesh.userData.localCollisionBoxes.map(box => box.clone());
        }
        if (mesh.userData.collisionBoxes.length > 0) {
            mesh.userData.collisionBoxes.forEach(box => box.translate(pos));
        }
    } else {
        if (config.collision) {
            const height = config.geometryType === "slab" ? 0.5 : 1;
            mesh.userData.collisionBoxes = [
                new THREE.Box3(pos.clone(), new THREE.Vector3(pos.x + 1, pos.y + height, pos.z + 1))
            ];
        } else {
            mesh.userData.collisionBoxes = [];
        }
    }
    mesh.updateMatrixWorld();
    return mesh;
}

/**
 * 指定ブロックの当たり判定用 Box3 配列を返す関数  
 * customCollision プロパティがなければ、デフォルトでセル全体（もしくは slab なら高さ 0.5）の Box3 を返す
 * @param {number} blockType - ブロック種識別子
 * @param {THREE.Vector3} pos - ブロック設置位置（セルの左下隅）
 * @returns {THREE.Box3[]} - 当たり判定ボックスの配列
 */
// 関数の外側に1つだけ置いておく
const _sharedCollisionBox = new THREE.Box3();
const _sharedCollisionMax = new THREE.Vector3();

function getBlockCollisionBoxes(blockType, pos) {
    const config = getBlockConfiguration(blockType);
    if (!config || !config.collision) return [];

    if (typeof config.customCollision === "function") {
        return config.customCollision().map(localBox => {
            const worldBox = localBox.clone(); // 既存の仕様を維持
            worldBox.min.add(pos);
            worldBox.max.add(pos);
            return worldBox;
        });
    }

    const height = (config.geometryType === "slab") ? 0.5 : 1;

    // 💡 既存の Box3 の器の中身だけを書き換えて、配列に入れて返す
    _sharedCollisionMax.set(pos.x + 1, pos.y + height, pos.z + 1);
    _sharedCollisionBox.set(pos, _sharedCollisionMax);

    return [_sharedCollisionBox]; // 👈 毎回 new しない！
}

/**
 * ブロック設定を取得するための関数（ルックアップテーブル利用）
 * @param {number} blockID - ブロック種識別子
 * @returns {object|null} - 該当する設定があれば返し、なければ null
 */
function getBlockConfiguration(blockID) {
    return blockConfigLookup[blockID] || null;
}

/* -------------------------------------------------------------------------
   4. エクスポート／グローバル設定
   ------------------------------------------------------------------------- */
if (typeof module !== "undefined" && typeof module.exports !== "undefined") {
    module.exports = {
        BLOCK_CONFIG,
        createBlockMesh,
        getBlockCollisionBoxes,
        getBlockMaterials,
        createMaterialsFromBlockConfig,
        getBlockConfiguration,
        getBlockGeometry
    };
} else {
    window.BLOCK_CONFIG = BLOCK_CONFIG;
    window.BLOCK_TYPES = BLOCK_TYPES;
    window.createBlockMesh = createBlockMesh;
    window.getBlockCollisionBoxes = getBlockCollisionBoxes;
    window.getBlockMaterials = getBlockMaterials;
    window.createMaterialsFromBlockConfig = createMaterialsFromBlockConfig;
    window.getBlockConfiguration = getBlockConfiguration;
    window.getBlockGeometry = getBlockGeometry;
}