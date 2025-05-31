import * as THREE from "./build/three.module.js";
import { BufferGeometryUtils } from './jsm/utils/BufferGeometryUtils.js';

"use strict";

// ================================================
// ② ブロック定義 (BLOCK_CONFIG) の拡張
// ================================================

// まずは、Box3 を作成するためのヘルパー関数
function createBox(x1, y1, z1, x2, y2, z2) {
    return new THREE.Box3(
        new THREE.Vector3(x1, y1, z1),
        new THREE.Vector3(x2, y2, z2)
    );
}

// 次に、ブロックの種類ごとに当たり判定（カスタム衝突領域）を返す関数を用意
function getCustomCollision(type) {
    switch (type) {
        case 'stairs':
            // 階段の場合は、下段と上段の当たり判定を返す
            return [
                createBox(0, 0, 0, 1, 0.5, 1),
                createBox(0.5, 0.5, 0, 1, 1, 1),
            ];
        case 'slab':
            // 半ブロックの場合の当たり判定
            return [
                createBox(0, 0, 0, 1, 0.5, 1),
            ];
        case 'cross':
            // crossジオメトリ用：花や植物は実際の見た目よりも小さめの衝突領域を用意するのが一般的です。
            // ここでは、ブロックの中央(0.25～0.75)をカバーする当たり判定として定義しています。
            return [
                createBox(0.25, 0, 0.25, 0.75, 1, 0.75)
            ];
        default:
            return [];
    }
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
// ※ここでは単純な Object.assign で十分な場合が多いですが、複雑な構造の場合は deep merge を検討します。
function createBlockConfig(customConfig) {
    return Object.assign({}, defaultBlockConfig, customConfig);
}

// ── 個別ブロック設定 ──
const BLOCK_CONFIG = {
    SKY: createBlockConfig({
        id: 0,
        collision: false,
        geometryType: "none",    // 描画しない
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
    PLANKS: createBlockConfig({
        id: 4,
        textures: { all: "textures/planks.png" }
    }),
    BEDROCK: createBlockConfig({
        id: 5,
        textures: { all: "textures/bedrock.png" }
    }),
    STONE_STAIRS: createBlockConfig({
        id: 6,
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
        id: 7,
        textures: { all: "textures/stone.png" },
        geometryType: "slab",
        transparent: true,
        customCollision: pos => getCustomCollision("slab"),
        screenFill: false,
        hardness: 1.5
    }),
    GLASS: createBlockConfig({
        id: 8,
        textures: { all: "textures/glass.png" },
        transparent: true,
        screenFill: false
    }),
    FLOWER: createBlockConfig({
        id: 9,
        textures: { all: "textures/flower.png" },
        collision: false,
        geometryType: "cross",
        transparent: true,
        customCollision: pos => getCustomCollision("cross"),
        screenFill: false,
        previewType: "2D"
    }),
    WATER: createBlockConfig({
        id: 10,
        textures: { all: "textures/water.png" },
        collision: false,
        transparent: true,
        targetblock: false,
        geometryType: "water",
        previewType: "2D"
    }),
};

// ── 後方互換用エイリアスの自動生成 ──
// 各ブロックのキーをループして BLOCK_TYPES オブジェクトを生成します
const BLOCK_TYPES = {};
for (const key in BLOCK_CONFIG) {
    BLOCK_TYPES[key] = BLOCK_CONFIG[key].id;
}

// ----- 利点 -----
// ・各ブロック設定は createBlockConfig() を通すことで、共通のプロパティが自動挿入されるため、
//   細かい設定が必要な場合には、個々のカスタム設定だけを書けばよくなります。
// ・たとえば、「硬さ」や「ドロップ」などもデフォルト項目に含めているので、後から詳細に拡張可能です。
// ・さらに、geometryType による条件分岐をメイン処理側で行うと、今後新しいジオメトリを追加する際も、
//   BLOCK_CONFIG 側で geometryType や customCollision を定義するだけで済むため、コードの保守性が向上します。


// テクスチャローダーとキャッシュ
const textureLoader = new THREE.TextureLoader();
const textureCache = {};

// キャッシュ付きでテクスチャをロードする関数
function loadTexture(path) {
    if (!textureCache[path]) {
        const tex = textureLoader.load(
            path,
            () => {
                tex.needsUpdate = true; // ロード完了時に更新
            },
            undefined,
            err => { console.error("Texture load error: ", err); }
        );
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestMipmapNearestFilter;
        textureCache[path] = tex;
    }
    return textureCache[path];
}

// BLOCK_CONFIG の設定情報から、テクスチャ付きマテリアル群を生成する関数
function createMaterialsFromBlockConfig(blockConfig) {
    const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];

    // stairs と slab は不透明にしたいのでそれらはまとめる
    const isStairsOrSlab = blockConfig.geometryType === "stairs" || blockConfig.geometryType === "slab";
    // cross は独自に設定する
    const isCross = blockConfig.geometryType === "cross";
    // water は独自に設定する
    const isWater = blockConfig.geometryType === "water";

    // stairs/slab, cross は opacity を 1 にする
    const finalOpacity = (isStairsOrSlab || isCross) ? 1.0 : (blockConfig.transparent ? 0.7 : 1.0);

    // stairs/slab は不透明に、cross は透明にしたい場合は true
    const finalTransparent = isStairsOrSlab ? false : (isCross ? true : blockConfig.transparent);

    // cross の場合だけは両面描画、その他は FrontSide（ガラスブロックなどは FrontSide を維持）
    const sideSetting = isCross ? THREE.DoubleSide : THREE.FrontSide;

    // 特殊ジオメトリ（stairs/slab, cross, water）の場合は頂点カラーを無効にする
    const useVertexColors = !isStairsOrSlab && !isCross && !isWater;

    // 「all」キーで一括指定されていれば、全面同じテクスチャを適用
    if (blockConfig.textures.all) {
        const tex = loadTexture(blockConfig.textures.all);
        return FACE_ORDER.map(() => new THREE.MeshLambertMaterial({
            map: tex,
            transparent: finalTransparent,
            opacity: finalOpacity,
            vertexColors: useVertexColors ? THREE.VertexColors : false,
            side: sideSetting
        }));
    } else {
        return FACE_ORDER.map(face => {
            let texPath = blockConfig.textures[face];
            if (!texPath && blockConfig.textures.side) {
                texPath = blockConfig.textures.side;
            }
            if (!texPath) {
                console.warn(`Texture not set for face "${face}".`);
                return new THREE.MeshLambertMaterial({ color: 0xff00ff });
            }
            return new THREE.MeshLambertMaterial({
                map: loadTexture(texPath),
                transparent: finalTransparent,
                opacity: finalOpacity,
                vertexColors: useVertexColors ? THREE.VertexColors : false,
                side: sideSetting
            });
        });
    }
}


// マテリアルのキャッシュ（ブロックIDごと）
const BLOCK_MATERIALS_CACHE = {};
function getBlockMaterials(blockType) {
    const bType = Number(blockType);
    for (let key in BLOCK_CONFIG) {
        if (Number(BLOCK_CONFIG[key].id) === bType) {
            if (!BLOCK_MATERIALS_CACHE[bType]) {
                BLOCK_MATERIALS_CACHE[bType] = createMaterialsFromBlockConfig(BLOCK_CONFIG[key]);
            }
            return BLOCK_MATERIALS_CACHE[bType];
        }
    }
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
 * ・config.customGeometry が定義されていれば、そちらを利用（キャッシュも有効）  
 * ・それ以外は既存の type ("cube", "slab", など) に応じた生成処理を行う  
 * @param {string} type - "cube", "stairs", "slab", "cross" 等
 * @param {object} [config] - ブロック設定。カスタムジオメトリ用の customGeometry プロパティ等を含む
 * @returns {THREE.BufferGeometry}
 */
function getBlockGeometry(type, config) {
    // カスタムジオメトリが指定されている場合はそちらを優先
    if (config && config.customGeometry) {
        if (cachedCustomGeometries[config.id]) {
            return cachedCustomGeometries[config.id].clone();
        }
        let customGeom =
            typeof config.customGeometry === "function"
                ? config.customGeometry()
                : config.customGeometry;
        customGeom.computeBoundingBox();
        customGeom.computeVertexNormals();
        cachedCustomGeometries[config.id] = customGeom;
        return customGeom.clone();
    }

    // 標準ジオメトリのキャッシュを確認
    if (cachedBlockGeometries[type]) {
        return cachedBlockGeometries[type].clone();
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
            // センタリング：バウンディングボックスの中心を原点に移動
            geom.computeBoundingBox();
            const center = new THREE.Vector3();
            geom.boundingBox.getCenter(center);
            geom.translate(-center.x, -center.y, -center.z);
            // ユニットセルの中心に合わせる
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
    return geom.clone();
}

/**
 * マルチマテリアルに対応したブロックメッシュを生成する関数  
 * @param {number} blockType - ブロック種識別子
 * @param {THREE.Vector3} pos - ブロック設置位置（セルの左下隅）
 * @param {THREE.Euler} [rotation] - 任意の回転
 * @returns {THREE.Mesh|null} - 生成されたブロックメッシュ。設定が見つからない場合は null
 */
function createBlockMesh(blockType, pos, rotation) {
    const config = getBlockConfiguration(blockType);
    if (!config) {
        console.error("Unknown block type:", blockType);
        return null;
    }
    // config を第二引数として渡すことで、カスタムジオメトリにも対応
    const geometry = getBlockGeometry(config.geometryType, config);
    const materials = getBlockMaterials(blockType); // 複数素材の場合は配列が返る前提
    let mesh;
    if (materials.length > 1 && geometry.groups && geometry.groups.length > 0) {
        mesh = new THREE.Mesh(geometry, materials);
    } else {
        mesh = new THREE.Mesh(geometry, materials[0]);
    }
    mesh.position.copy(pos);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (rotation) {
        mesh.rotation.copy(rotation);
    }
    // カスタム衝突判定が定義されている場合はローカル座標ボックスをワールド座標に変換
    if (typeof config.customCollision === "function") {
        const localBoxes = config.customCollision(new THREE.Vector3(0, 0, 0));
        mesh.userData.collisionBoxes = localBoxes.map(box => {
            const worldBox = box.clone();
            worldBox.min.add(pos);
            worldBox.max.add(pos);
            return worldBox;
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
        getBlockGeometry,
        loadTexture
    };
} else {
    window.BLOCK_CONFIG = BLOCK_CONFIG;
    window.createBlockMesh = createBlockMesh;
    window.getBlockCollisionBoxes = getBlockCollisionBoxes;
    window.getBlockMaterials = getBlockMaterials;
    window.createMaterialsFromBlockConfig = createMaterialsFromBlockConfig;
    window.getBlockConfiguration = getBlockConfiguration;
    window.getBlockGeometry = getBlockGeometry;
    window.loadTexture = loadTexture;
    // 後方互換用
    window.BLOCK_TYPES = BLOCK_TYPES;
}