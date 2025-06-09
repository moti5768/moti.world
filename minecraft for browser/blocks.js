import * as THREE from "./build/three.module.js";
import { BufferGeometryUtils } from './jsm/utils/BufferGeometryUtils.js';

"use strict";

// ================================================
// ② ブロック定義 (BLOCK_CONFIG) の拡張
// ================================================

// --- Box3作成ヘルパー ---
function createBox(x1, y1, z1, x2, y2, z2) {
    return new THREE.Box3(
        new THREE.Vector3(x1, y1, z1),
        new THREE.Vector3(x2, y2, z2)
    );
}

// --- カスタム衝突判定キャッシュ ---
const CUSTOM_COLLISION_CACHE = {
    stairs: [
        createBox(0, 0, 0, 1, 0.5, 1),
        createBox(0.5, 0.5, 0, 1, 1, 1),
    ],
    slab: [
        createBox(0, 0, 0, 1, 0.5, 1),
    ],
    cross: [
        createBox(0.25, 0, 0.25, 0.75, 1, 0.75),
    ],
};

// --- カスタム衝突判定取得関数 ---
function getCustomCollision(type) {
    return CUSTOM_COLLISION_CACHE[type] || [];
}

// ── 共通のデフォルト設定 ──
const defaultBlockConfig = {
    collision: true,         // 衝突判定は基本有効
    geometryType: "cube",    // デフォルトは立方体
    transparent: false,      // デフォルトは不透過
    targetblock: true,       // ブロックカーソル　設置　破壊対象
    screenFill: true,        // オーバーレイ表示対象
    textures: {},            // テクスチャ情報（各面またはallを指定）
    customCollision: null,   // カスタム衝突判定は基本なし
    hardness: 1.0,           // ブロックの硬さや耐久性（任意）
    drop: null,              // ブロック破壊時に落とすアイテム（任意）
    previewType: "3D",      // 3D プレビュー表示の場合
    previewOptions: {
        // ひし型（ダイヤモンド型）に近づけるため、
        rotation: { x: 0, y: 0, z: 0 },
        // インベントリいっぱいに表示したい場合は scale を大きめに
        scale: 2.2
    }
};

// ── ユーティリティ：深いマージ（必要なら） ──
// ※複雑なネストがなければスプレッド構文で十分です。
function createBlockConfig(customConfig) {
    return { ...defaultBlockConfig, ...customConfig };
}

// ── 個別ブロック設定 ──
const BLOCK_CONFIG = {
    SKY: createBlockConfig({
        id: 0,
        collision: false,
        geometryType: "none", // 描画しない
        transparent: false,
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
    PLANKS: createBlockConfig({
        id: 5,
        textures: { all: "textures/planks.png" }
    }),
    BRICK: createBlockConfig({
        id: 6,
        textures: { all: "textures/brick.png" }
    }),
    BEDROCK: createBlockConfig({
        id: 7,
        textures: { all: "textures/bedrock.png" }
    }),
    STONE_STAIRS: createBlockConfig({
        id: 8,
        textures: {
            top: "textures/stone.png",
            bottom: "textures/stone.png",
            side: "textures/stone.png"
        },
        geometryType: "stairs",
        transparent: true,
        customCollision: pos => getCustomCollision("stairs"),
        screenFill: false,
        hardness: 2.0
    }),
    STONE_SLAB: createBlockConfig({
        id: 9,
        textures: { all: "textures/stone.png" },
        geometryType: "slab",
        transparent: true,
        customCollision: pos => getCustomCollision("slab"),
        screenFill: false,
        hardness: 1.5
    }),
    GLASS: createBlockConfig({
        id: 10,
        textures: { all: "textures/glass.png" },
        transparent: true,
        screenFill: false
    }),
    FLOWER: createBlockConfig({
        id: 11,
        textures: { all: "textures/flower.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: pos => getCustomCollision("cross"),
        screenFill: false,
        previewType: "2D"
    }),
    TALLGRASS: createBlockConfig({
        id: 12,
        textures: { all: "textures/tallgrass.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: pos => getCustomCollision("cross"),
        screenFill: false,
        previewType: "2D"
    }),
    WATER: createBlockConfig({
        id: 13,
        textures: { all: "textures/water.png" },
        collision: false,
        transparent: true,
        targetblock: false,
        geometryType: "water",
        previewType: "2D"
    }),
};

// ── 後方互換用エイリアスの自動生成 ──
// Object.entries と Object.fromEntries でシンプルに
const BLOCK_TYPES = Object.fromEntries(
    Object.entries(BLOCK_CONFIG).map(([key, cfg]) => [key, cfg.id])
);

const textureLoader = new THREE.TextureLoader();
const textureCache = Object.create(null);

function cachedLoadTexture(path) {
    if (!path) return null;
    if (textureCache[path]) return textureCache[path];

    const tex = textureLoader.load(
        path,
        () => { tex.needsUpdate = true; },
        undefined,
        err => console.error("Texture load error:", err)
    );
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapNearestFilter;
    textureCache[path] = tex;
    return tex;
}

const materialCache = new Map();

function createMaterialsFromBlockConfig(blockConfig) {
    const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];
    const { geometryType, transparent, textures } = blockConfig;

    const textureKey = textures.all
        ? `all:${textures.all}`
        : FACE_ORDER.map(f => textures[f] || textures.side || "none").join(",");

    const cacheKey = `${geometryType}|${transparent}|${textureKey}`;
    if (materialCache.has(cacheKey)) return materialCache.get(cacheKey);

    const isStairsOrSlab = geometryType === "stairs" || geometryType === "slab";
    const isCross = geometryType === "cross";
    const isWater = geometryType === "water";

    const opacity = (isStairsOrSlab || isCross) ? 1 : (transparent ? 0.7 : 1);
    const isTransparent = isStairsOrSlab ? false : (isCross ? true : transparent);
    const side = isCross ? THREE.DoubleSide : THREE.FrontSide;
    const vertexColors = (!isStairsOrSlab && !isCross && !isWater) ? THREE.VertexColors : false;

    const matCache = {};

    function getMat(tex) {
        if (!tex || tex === "none") {
            if (!getMat.warned) {
                console.warn("Texture not set or invalid path detected.");
                getMat.warned = true;
            }
            return new THREE.MeshLambertMaterial({ color: 0xff00ff });
        }
        if (matCache[tex]) return matCache[tex];

        const map = cachedLoadTexture(tex);
        const mat = new THREE.MeshLambertMaterial({
            map,
            transparent: isTransparent,
            opacity,
            vertexColors,
            side,
        });
        matCache[tex] = mat;
        return mat;
    }

    const materials = textures.all
        ? Array(6).fill(getMat(textures.all))
        : FACE_ORDER.map(f => getMat(textures[f] || textures.side));

    materialCache.set(cacheKey, materials);
    return materials;
}

// マテリアルのキャッシュ（ブロックIDごと）
const BLOCK_MATERIALS_CACHE = {};
/**
 * 指定ブロックタイプのマテリアル配列を返す。  
 * 生成済みならキャッシュから取得し、無駄な再生成を防ぐ。  
 * @param {number} blockType - ブロック種識別子
 * @returns {THREE.Material[]} - マテリアルの配列（複数マテリアル対応）
 */
function getBlockMaterials(blockType) {
    const bType = Number(blockType);
    if (BLOCK_MATERIALS_CACHE[bType]) {
        return BLOCK_MATERIALS_CACHE[bType];
    }

    // BLOCK_CONFIG は事前定義されているブロック設定の辞書
    for (let key in BLOCK_CONFIG) {
        if (Number(BLOCK_CONFIG[key].id) === bType) {
            const materials = createMaterialsFromBlockConfig(BLOCK_CONFIG[key]);
            BLOCK_MATERIALS_CACHE[bType] = materials;
            return materials;
        }
    }
    // 対応なしの場合は null またはデフォルトマテリアルを返す
    return null;
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
    if (Object.prototype.hasOwnProperty.call(BLOCK_CONFIG, key)) {
        const config = BLOCK_CONFIG[key];
        blockConfigLookup[config.id] = config;
    }
}
/**
 * 横面のライティング用 UV 座標を最適化する関数  
 * 対象は、法線の Y 成分が 0 に近い（＝横向き）の頂点
 * @param {THREE.BufferGeometry} geom - 対象ジオメトリ
 */
function adjustSideUVs(geom) {
    const normals = geom.attributes.normal.array;
    const uvs = geom.attributes.uv.array;
    const count = uvs.length >> 1; // uvs.length / 2
    for (let i = 0; i < count; i++) {
        const ny = normals[i * 3 + 1];
        if (Math.abs(ny) < 0.1) {
            uvs[i * 2 + 1] *= 0.5;
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
    // カスタムジオメトリ優先
    if (config && config.customGeometry) {
        if (!cachedCustomGeometries[config.id]) {
            let customGeom =
                typeof config.customGeometry === "function"
                    ? config.customGeometry()
                    : config.customGeometry;
            customGeom.computeBoundingBox();
            customGeom.computeVertexNormals();
            cachedCustomGeometries[config.id] = customGeom;
        }
        return cachedCustomGeometries[config.id];
    }

    // 標準ジオメトリをキャッシュ済みならそのまま返す
    if (cachedBlockGeometries[type]) {
        return cachedBlockGeometries[type];
    }

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
            geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            adjustSideUVs(geom);
            break;
        default:
            geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            break;
    }
    geom.computeBoundingBox();
    geom.computeVertexNormals();

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
    const geometry = getBlockGeometry(config.geometryType, config);
    const materials = getBlockMaterials(blockType);
    if (!materials) {
        console.error("No materials found for block type:", blockType);
        return null;
    }

    let mesh;
    if (Array.isArray(materials) && materials.length > 1 && geometry.groups && geometry.groups.length > 0) {
        mesh = new THREE.Mesh(geometry, materials);
    } else {
        mesh = new THREE.Mesh(geometry, Array.isArray(materials) ? materials[0] : materials);
    }

    mesh.position.copy(pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (rotation) {
        mesh.rotation.copy(rotation);
    }

    // カスタム衝突判定のBox3をキャッシュから取得・clone＆座標調整
    if (typeof config.customCollision === "function") {
        if (!mesh.userData.localCollisionBoxes) {
            mesh.userData.localCollisionBoxes = config.customCollision();
        }
        if (!mesh.userData.collisionBoxes) {
            mesh.userData.collisionBoxes = mesh.userData.localCollisionBoxes.map(box => box.clone());
        }
        mesh.userData.collisionBoxes.forEach((box, i) => {
            box.min.copy(mesh.userData.localCollisionBoxes[i].min).add(pos);
            box.max.copy(mesh.userData.localCollisionBoxes[i].max).add(pos);
        });
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
    window.createBlockMesh = createBlockMesh;
    window.getBlockCollisionBoxes = getBlockCollisionBoxes;
    window.getBlockMaterials = getBlockMaterials;
    window.createMaterialsFromBlockConfig = createMaterialsFromBlockConfig;
    window.getBlockConfiguration = getBlockConfiguration;
    window.getBlockGeometry = getBlockGeometry;
    // 後方互換用
    window.BLOCK_TYPES = BLOCK_TYPES;
}