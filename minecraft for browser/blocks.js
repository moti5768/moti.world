import * as THREE from "./build/three.module.js";
import { BufferGeometryUtils } from './jsm/utils/BufferGeometryUtils.js';

"use strict";

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
    drop: null,
    cullAdjacentFaces: true,
    overwrite: false,
    previewType: "3D",
    previewOptions: {
        rotation: { x: 0, y: 0, z: 0 },
        scale: 2.2
    },
    // ここから追加：
    // ブロックごとのフォールバック画像パス（例: "textures/fallback_stone.png"）
    // 指定しない場合は「map を持たないマテリアル（defaultColor 表示）」になります
    fallbackTexture: "textures/missing_texture.png",
    // map を持たない場合に表示したい色（0xffffff など）。未指定なら白
    defaultColor: 0xffffff
};

// ── ユーティリティ：深いマージ（必要なら） ──
function createBlockConfig(customConfig) {
    return { ...defaultBlockConfig, ...customConfig }; // ← 元コードは Object.assign だった可能性
}

// ── 個別ブロック設定 ──
const BLOCK_CONFIG = {
    SKY: createBlockConfig({
        id: 0,
        itemdisplay: false,
        collision: false,
        geometryType: "none", // 描画しない
        transparent: false,
        overwrite: true,
        screenFill: false,
        textures: {}
    }),
    GRASS: createBlockConfig({
        id: 1,
        textures: {
            top: "textures/grass_top.png",
            side: "textures/grass_side.png",
            bottom: "textures/dirt.png"
        }
    }),
    DIRT: createBlockConfig({
        id: 2,
        textures: { all: "textures/dirt.png" }
    }),
    STONE: createBlockConfig({
        id: 3,
        textures: { all: "textures/stone.png" }
    }),
    COBBLE_STONE: createBlockConfig({
        id: 4,
        textures: { all: "textures/cobblestone.png" }
    }),
    COBBLE_STONE_MOSSY: createBlockConfig({
        id: 5,
        textures: { all: "textures/cobblestone_mossy.png" }
    }),
    COAL_ORE: createBlockConfig({
        id: 6,
        textures: { all: "textures/coal_ore.png" }
    }),
    PLANKS: createBlockConfig({
        id: 7,
        textures: { all: "textures/planks.png" }
    }),
    BRICK: createBlockConfig({
        id: 8,
        textures: { all: "textures/brick.png" }
    }),
    BEDROCK: createBlockConfig({
        id: 9,
        textures: { all: "textures/bedrock.png" }
    }),
    STONE_STAIRS: createBlockConfig({
        id: 10,
        textures: {
            top: "textures/stone.png",
            bottom: "textures/stone.png",
            side: "textures/stone.png"
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
        textures: { all: "textures/stone.png" },
        geometryType: "slab",
        transparent: true,
        customCollision: () => getCustomCollision("slab"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5
    }),
    GLASS: createBlockConfig({
        id: 12,
        textures: { all: "textures/glass.png" },
        transparent: true,
        screenFill: false
    }),
    FLOWER: createBlockConfig({
        id: 13,
        textures: { all: "textures/flower.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D"
    }),
    FLOWER_ROSE: createBlockConfig({
        id: 14,
        textures: { all: "textures/flower_rose.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D"
    }),
    TALLGRASS: createBlockConfig({
        id: 15,
        textures: { all: "textures/tallgrass.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D"
    }),
    LEAVES: createBlockConfig({
        id: 16,
        textures: { all: "textures/leaves.png" },
        geometryType: "leaves",
        transparent: true,
        cullAdjacentFaces: false,
        screenFill: false
    }),
    WOOL_CARPET: createBlockConfig({
        id: 17,
        textures: { all: "textures/wool_colored_white.png" },
        geometryType: "carpet",
        transparent: true,
        customCollision: () => getCustomCollision("carpet"),
        Gamma: 0.8,
        cullAdjacentFaces: false,
        screenFill: false
    }),
    WATER: createBlockConfig({
        id: 18,
        textures: { all: "textures/water.png" },
        collision: false,
        transparent: true,
        targetblock: false,
        overwrite: true,
        geometryType: "water",
        previewType: "2D"
    })
};

// ── 後方互換用エイリアスの自動生成 ──
// Object.entries と Object.fromEntries でシンプルに
const BLOCK_TYPES = Object.fromEntries(
    Object.entries(BLOCK_CONFIG).map(([key, cfg]) => [key, cfg.id])
);

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
let sharedEmptyTexture = null; // フォールバック無し時に共有する空テクスチャ

function cachedLoadTexture(path, fallback = null) {
    // path がない場合は fallback を試し、なければ共有の空テクスチャを返す
    if (!path) {
        if (fallback) return cachedLoadTexture(fallback, null);
        if (!sharedEmptyTexture) {
            sharedEmptyTexture = new THREE.Texture(); // image 未設定の空テクスチャ
            // 注意: needsUpdate は不要（空のまま）
        }
        return sharedEmptyTexture;
    }

    // キャッシュがあればそれを返す
    if (textureCache.has(path)) return textureCache.get(path);

    // placeholder をまず登録して返す（既存描画が壊れないようにする）
    const placeholder = new THREE.Texture();
    textureCache.set(path, placeholder);

    textureLoader.load(
        path,
        (tex) => {
            // 正常読み込み：placeholder を実画像で埋める
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestMipmapNearestFilter;

            placeholder.image = tex.image;
            placeholder.magFilter = tex.magFilter;
            placeholder.minFilter = tex.minFilter;
            placeholder.needsUpdate = true;

            // textureCache の値は placeholder のまま（参照が更新される）
        },
        undefined,
        (err) => {
            console.warn(`Texture load failed for "${path}".`, err);
            // フォールバックがあればそれを取得してキャッシュを差し替える
            if (fallback && fallback !== path) {
                const fbTex = cachedLoadTexture(fallback, null);
                textureCache.set(path, fbTex);

                // placeholder を使用している既存メッシュ向けに fbTex の内容をコピー（fbTex が画像を持っていれば）
                if (fbTex && fbTex.image) {
                    placeholder.image = fbTex.image;
                    placeholder.magFilter = fbTex.magFilter || THREE.NearestFilter;
                    placeholder.minFilter = fbTex.minFilter || THREE.NearestFilter;
                    placeholder.needsUpdate = true;
                }
            } else {
                // フォールバック無し：placeholder は空のままにしておく（map無し扱いに近い）
                // 既に返した placeholder を空のままにすることで、描画はマテリアルの color 等で代替される
            }
        }
    );

    return placeholder;
}

// グローバルキャッシュ
const materialCache = new Map();      // ブロック構成ごとのキャッシュ
const textureMaterialCache = new Map(); // テクスチャ単位のキャッシュ

function createMaterialsFromBlockConfig(blockConfig) {
    const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];
    const { geometryType, transparent, textures } = blockConfig;

    const cacheKey = blockConfig;
    if (materialCache.has(cacheKey)) return materialCache.get(cacheKey);

    const isStairsOrSlab = geometryType === "stairs" || geometryType === "slab";
    const isCross = geometryType === "cross" || geometryType === "leaves";
    const isWater = geometryType === "water";

    const opacity = (isStairsOrSlab || isCross) ? 1 : (transparent ? 0.7 : 1);
    const isTransparent = isStairsOrSlab ? false : (isCross ? true : transparent);
    const side = isCross ? THREE.DoubleSide : THREE.FrontSide;
    const vertexColors = (!isStairsOrSlab && !isCross && !isWater) ? THREE.VertexColors : false;

    // 面ごとの優先順位：textures.all -> textures[face] -> textures.side -> blockConfig.fallbackTexture -> null（空）
    function resolveTexturePath(face) {
        if (textures && textures.all) return textures.all;
        if (textures && textures[face]) return textures[face];
        if (textures && textures.side) return textures.side;
        // ここで返るのは文字列か null。null の場合は cachedLoadTexture が共有空テクスチャを返す。
        return blockConfig.fallbackTexture || null;
    }

    function getMat(texPathOrNone) {
        // texPathOrNone が falsy の場合は map を持たないマテリアルを返す（色で表示）
        if (!texPathOrNone || texPathOrNone === "none") {
            // 警告は出すが、派手な色は使わない（ユーザー要望に合わせる）
            if (!getMat.warned) {
                console.warn("Texture not set or invalid path detected for a face; using material without map.");
                getMat.warned = true;
            }
            return new THREE.MeshLambertMaterial({
                color: (blockConfig.defaultColor !== undefined) ? blockConfig.defaultColor : 0xffffff,
                transparent: isTransparent,
                opacity,
                vertexColors,
                side,
                alphaTest: isCross ? 0.5 : 0,
            });
        }

        // ブロック個別の fallbackTexture を渡す（なければ null）
        const map = cachedLoadTexture(texPathOrNone, blockConfig.fallbackTexture || null);

        return new THREE.MeshLambertMaterial({
            map,
            transparent: isTransparent,
            opacity,
            vertexColors,
            side,
            alphaTest: isCross ? 0.5 : 0,
        });
    }

    const materials = (textures && textures.all)
        ? Array(6).fill(getMat(textures.all))
        : FACE_ORDER.map(f => getMat(resolveTexturePath(f)));

    materialCache.set(cacheKey, materials);
    return materials;
}


// マテリアルのキャッシュ（ブロックIDごと）
const BLOCK_MATERIALS_CACHE = {};

/**
 * 指定ブロックタイプのマテリアル配列を返す。  
 * キャッシュがあれば再利用し、無駄な再生成を防ぐ。
 * @param {number} blockType - ブロック種識別子
 * @returns {THREE.Material[] | null} - マテリアルの配列（複数マテリアル対応）
 */
function getBlockMaterials(blockType) {
    const bType = Number(blockType);

    // キャッシュがあれば即返す
    if (BLOCK_MATERIALS_CACHE[bType]) {
        return BLOCK_MATERIALS_CACHE[bType];
    }

    // O(1) で設定取得
    const config = blockConfigLookup[bType];
    if (!config) {
        console.warn(`Unknown block type: ${bType}`);
        return null;
    }

    // マテリアル生成＆キャッシュ保存
    const materials = createMaterialsFromBlockConfig(config);
    BLOCK_MATERIALS_CACHE[bType] = materials;
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
for (const key in BLOCK_CONFIG) {
    const cfg = BLOCK_CONFIG[key];
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
            adjustSideUVs(lower);

            const upper = new THREE.BoxGeometry(0.5, 0.5, 1);
            upper.translate(0.75, 0.75, 0.5);
            adjustSideUVs(upper);

            geom = BufferGeometryUtils.mergeBufferGeometries([lower, upper], true);
            geom.clearGroups();
            geom.addGroup(0, geom.index.count, 0);
            break;
        }

        case "cross": {
            const p1 = new THREE.PlaneGeometry(1, 1);
            p1.rotateY(THREE.MathUtils.degToRad(45));
            const p2 = new THREE.PlaneGeometry(1, 1);
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
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (rotation) {
        mesh.rotation.copy(rotation);
    }

    // カスタム衝突判定のBox3をキャッシュから取得・clone＆座標調整
    if (typeof config.customCollision === "function") {
        if (!mesh.userData.localCollisionBoxes) {
            mesh.userData.localCollisionBoxes = config.customCollision() || [];
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
function getBlockCollisionBoxes(blockType, pos) {
    const config = getBlockConfiguration(blockType);
    if (!config || !config.collision) return [];
    if (typeof config.customCollision === "function") {
        return config.customCollision(pos).map(localBox => {
            const worldBox = localBox.clone();
            worldBox.min.add(pos);
            worldBox.max.add(pos);
            return worldBox;
        });
    }
    const height = (config.geometryType === "slab") ? 0.5 : 1;
    return [new THREE.Box3(pos.clone(), new THREE.Vector3(pos.x + 1, pos.y + height, pos.z + 1))];
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