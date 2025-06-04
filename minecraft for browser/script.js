// github上のパス
// import * as THREE from 'https://moti5768.github.io/moti.world/minecraft%20for%20browser/build/three.module.js';

import * as THREE from './build/three.module.js';
"use strict";

/* ======================================================
   【ノイズ関数群】（地形生成用）
   改善点:
   - 最新のES6構文（const/let, アロー関数）への移行
   - マジックナンバーの定数化
   - 入力検証（TypeErrorのスロー）
   - 同一座標に対する計算結果キャッシュの実装
   - JSDoc形式のコメントによるドキュメンテーション
   ====================================================== */

// 定数はそのまま
const PRIME_MULTIPLIER = 57;
const SIN_MULTIPLIER = 43758.5453;
const SCALE = 1;
const OFFSET = -1;

// pseudoRandom の結果キャッシュ（Map）
const pseudoRandomCache = new Map();
let cloudTiles = new Map(); // "gridX,gridZ" キーごとに各雲タイルを保持
/**
 * 数値ハッシュを生成する関数（x,y整数用）
 * 文字列キーより高速でメモリ効率良い
 */
function hashXY(x, y) {
    // 32bit符号付き整数の範囲内でハッシュ生成
    return ((x & 0xffff) << 16) | (y & 0xffff);
}

/**
 * 2D座標に基づく擬似乱数を返す関数
 * 結果は -1 ～ 1 の範囲
 */
const pseudoRandom = (x, y) => {
    if (typeof x !== "number" || typeof y !== "number") {
        throw new TypeError("x と y は数値でなければなりません");
    }
    // 座標を整数化（floor）
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const key = hashXY(ix, iy);
    if (pseudoRandomCache.has(key)) {
        return pseudoRandomCache.get(key);
    }
    // 元の計算式を維持
    const n = ix + iy * PRIME_MULTIPLIER;
    const s = Math.sin(n) * SIN_MULTIPLIER;
    const result = (s - Math.floor(s)) * SCALE + OFFSET;
    pseudoRandomCache.set(key, result);
    return result;
};

// クインティック補間関数
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);

// 線形補間
const lerp = (a, b, t) => a + t * (b - a);

// スムーズな2Dノイズ
const smoothNoise2D = (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = x0 + 1;
    const y1 = y0 + 1;

    const n00 = pseudoRandom(x0, y0);
    const n10 = pseudoRandom(x1, y0);
    const n01 = pseudoRandom(x0, y1);
    const n11 = pseudoRandom(x1, y1);

    const u = fade(x - x0);
    const v = fade(y - y0);

    const nx0 = lerp(n00, n10, u);
    const nx1 = lerp(n01, n11, u);

    return lerp(nx0, nx1, v);
};

/**
 * フラクタルノイズ
 *
 * @param {number} x 入力X
 * @param {number} y 入力Y
 * @param {number} octaves オクターブ数（デフォルト4）
 * @param {number} persistence 振幅減衰（デフォルト0.5）
 * @returns {number} ノイズ値 (-1〜1)
 */
function fractalNoise2D(x, y, octaves = 4, persistence = 0.5) {
    let total = 0,
        frequency = 1,
        amplitude = 1,
        maxValue = 0;
    for (let i = 0; i < octaves; i++) {
        total += smoothNoise2D(x * frequency, y * frequency) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        frequency *= 2;
    }
    return total / maxValue;
}

// 使用例
const noiseValue = fractalNoise2D(12.34, 56.78);
console.log("Fractal Noise Value:", noiseValue);



/* ======================================================
   【定数・グローバル変数】
   ====================================================== */


// ユーザーによるブロック変更情報（実装依存）
let voxelModifications = {};  // 例: { "5_10_3": 1, … }

// まずキャッシュ変数を宣言・初期化する

const MAX_CACHE_SIZE = 15000; // おすすめのキャッシュサイズ
const terrainHeightCache = new Map();
// 定数も同様にグローバル領域に外だししておきます
const BASE_SCALE = 0.005;
const DETAIL_SCALE = 0.05;
const BASE_HEIGHT = 64;           // 海面レベル、または標準的な地表の高さ
const MOUNTAIN_AMPLITUDE = 20;      // 大域起伏の振幅
const DETAIL_AMPLITUDE = 3;         // 細部起伏の振幅

const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 256;

const CHUNK_VISIBLE_DISTANCE = 6;

const COLLISION_MARGIN = 0.005;
const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 1.8;    // 通常時のプレイヤーの身長を1.8ブロックに変更
const SNEAK_HEIGHT = 1.65;    // スニーク時のプレイヤー身長を1.65ブロックに変更

const JUMP_INITIAL_SPEED = 0.21;
const UP_DECEL = 0.018;
const DOWN_ACCEL = 0.007;
const MAX_FALL_SPEED = -1;

const flightSpeed = 0.225;             // 飛行モード時の上下移動速度
const doubleTapThreshold = 300;       // ダブルタップ判定時間（ms）
let flightMode = false;
let lastSpaceTime = 0;

let lastFpsTime = performance.now();
let frameCount = 0;
const fpsCounter = document.getElementById("fpsCounter");


// ───────────────────────────────────────────────────────────────
// 【グローバル・テンポラリオブジェクトの宣言】
// ───────────────────────────────────────────────────────────────
const globalTempVec3 = new THREE.Vector3();
const globalTempVec3b = new THREE.Vector3();
const globalTempVec3c = new THREE.Vector3();
const globalCenterVec = new THREE.Vector2(0, 0);

// グローバルな Raycaster（新規生成せず再利用）
const globalRaycaster = new THREE.Raycaster();
globalRaycaster.near = 0.01;

// グローバル変数の宣言部分
const globalSamplePoints = [];
for (let i = 0; i < 9; i++) {
    globalSamplePoints.push(new THREE.Vector3());
}

// ----- スポーン位置の動的設定 -----
// ここで、プレイヤーのスポーン位置を地形表面に合わせて決定します。
// 例として、spawnX, spawnZ を好きな値に設定し、その地点の地形表面の高さを取得します。
const spawnX = 0;          // スポーンX座標（適宜設定してください）
const spawnZ = 0;          // スポーンZ座標（適宜設定してください）
const spawnY = getTerrainHeight(spawnX, spawnZ) + 1;  // 表面ブロックの上に1ブロック分浮かせる
console.log("Spawn Position:", spawnX, spawnY, spawnZ);


function setupTouchControls() {
    // --- 前進ボタン用（dpad-up）のダブルタップによるダッシュ機能 ---
    let lastForwardTapTime = 0;
    const FORWARD_DOUBLE_TAP_THRESHOLD = 300; // ミリ秒
    function handleForwardTap() {
        const now = performance.now();
        if (now - lastForwardTapTime < FORWARD_DOUBLE_TAP_THRESHOLD) {
            dashActive = true;
            console.log("Dash activated (forward double tap)!");
        }
        keys["w"] = true;
        lastForwardTapTime = now;
    }

    // dpad-up (前進ボタン)
    const btnUp = document.getElementById("dpad-up");
    btnUp.addEventListener("touchstart", function (e) {
        handleForwardTap();
        e.preventDefault();
    });
    btnUp.addEventListener("touchend", function (e) {
        keys["w"] = false;
        dashActive = false;  // ボタン離し時にダッシュ解除
        e.preventDefault();
    });
    btnUp.addEventListener("mousedown", function (e) {
        handleForwardTap();
    });
    btnUp.addEventListener("mouseup", function (e) {
        keys["w"] = false;
        dashActive = false;  // ボタン離し時にダッシュ解除
    });

    // dpad-down
    const btnDown = document.getElementById("dpad-down");
    btnDown.addEventListener("touchstart", function (e) {
        keys["s"] = true;
        e.preventDefault();
    });
    btnDown.addEventListener("touchend", function (e) {
        keys["s"] = false;
        e.preventDefault();
    });
    btnDown.addEventListener("mousedown", function (e) {
        keys["s"] = true;
    });
    btnDown.addEventListener("mouseup", function (e) {
        keys["s"] = false;
    });

    // dpad-left
    const btnLeft = document.getElementById("dpad-left");
    btnLeft.addEventListener("touchstart", function (e) {
        keys["a"] = true;
        e.preventDefault();
    });
    btnLeft.addEventListener("touchend", function (e) {
        keys["a"] = false;
        e.preventDefault();
    });
    btnLeft.addEventListener("mousedown", function (e) {
        keys["a"] = true;
    });
    btnLeft.addEventListener("mouseup", function (e) {
        keys["a"] = false;
    });

    // dpad-right
    const btnRight = document.getElementById("dpad-right");
    btnRight.addEventListener("touchstart", function (e) {
        keys["d"] = true;
        e.preventDefault();
    });
    btnRight.addEventListener("touchend", function (e) {
        keys["d"] = false;
        e.preventDefault();
    });
    btnRight.addEventListener("mousedown", function (e) {
        keys["d"] = true;
    });
    btnRight.addEventListener("mouseup", function (e) {
        keys["d"] = false;
    });

    // Jump ボタン：シングルタップでジャンプ/上昇、ダブルタップで飛行モードの切替
    const btnJump = document.getElementById("btn-jump");
    let lastJumpTime = 0;
    const DOUBLE_TAP_THRESHOLD = 300; // ms
    function handleJumpTap() {
        const now = performance.now();
        if (now - lastJumpTime < DOUBLE_TAP_THRESHOLD) {
            flightMode = !flightMode;
            jumpRequest = false;
            console.log("Flight Mode Toggled:", flightMode ? "ON" : "OFF");
        } else {
            if (flightMode) {
                // 飛行モード時は上昇入力をシミュレート
                keys[" "] = true;
            } else {
                jumpRequest = true;
            }
        }
        lastJumpTime = now;
    }
    btnJump.addEventListener("touchstart", function (e) {
        handleJumpTap();
        e.preventDefault();
    });
    btnJump.addEventListener("mousedown", function (e) {
        handleJumpTap();
    });
    btnJump.addEventListener("touchend", function (e) {
        if (flightMode) { keys[" "] = false; }
        e.preventDefault();
    });
    btnJump.addEventListener("mouseup", function (e) {
        if (flightMode) { keys[" "] = false; }
    });

    // Sneak ボタン：シングルタップで一時的な降下（またはしゃがみ）、ダブルタップで持続的な下降入力をトグル
    const btnSneak = document.getElementById("btn-sneak");
    let lastSneakTime = 0;
    const SNEAK_DOUBLE_TAP_THRESHOLD = 300; // ms
    let sneakToggled = false; // 持続的スニーク状態のフラグ
    function handleSneakTap() {
        const now = performance.now();
        if (now - lastSneakTime < SNEAK_DOUBLE_TAP_THRESHOLD) {
            sneakToggled = !sneakToggled;
            keys["shift"] = sneakToggled;
            sneakActive = sneakToggled;
            console.log("Sneak mode toggled:", sneakActive ? "ON" : "OFF");
        } else {
            if (flightMode) {
                // 飛行モード時は下降入力をシミュレート
                keys["shift"] = true;
            } else {
                keys["shift"] = true;
                sneakActive = true;
            }
        }
        lastSneakTime = now;
    }
    btnSneak.addEventListener("touchstart", function (e) {
        handleSneakTap();
        e.preventDefault();
    });
    btnSneak.addEventListener("mousedown", function (e) {
        handleSneakTap();
    });
    btnSneak.addEventListener("touchend", function (e) {
        if (!sneakToggled) {
            keys["shift"] = false;
            sneakActive = false;
        }
        e.preventDefault();
    });
    btnSneak.addEventListener("mouseup", function (e) {
        if (!sneakToggled) {
            keys["shift"] = false;
            sneakActive = false;
        }
    });
}
// 初期化処理の末尾で呼び出す
setupTouchControls();


// プレイヤーデータ
const player = {
    position: new THREE.Vector3(spawnX, spawnY, spawnZ),
    velocity: new THREE.Vector3(0, 0, 0),
    onGround: false
};

let jumpRequest = false;
let dashActive = false;
let lastWPressTime = 0;

const normalDashMultiplier = 0.130;
const flightDashMultiplier = 0.350;

let yaw = 0, pitch = 0;
const mouseSensitivity = 0.002;

const dt = 1;
const fixedCamY = player.position.y + PLAYER_HEIGHT;

let sneakActive = false;
function getCurrentPlayerHeight() {
    return sneakActive ? SNEAK_HEIGHT : PLAYER_HEIGHT;
}

/* ======================================================
   【シーン・カメラ・レンダラー設定】
   ====================================================== */
// フォグの色を定義（背景色とも合わせます）
const fogColor = 0xbfd1e5;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(fogColor, 1000, 5000);
setMinecraftSky(scene);

loadCloudTexture(() => {
    updateCloudGrid(scene, camera.position);
});

const camera = new THREE.PerspectiveCamera(
    80,                                 // 視野角
    window.innerWidth / window.innerHeight, // アスペクト比
    0.1,                                // near
    10000                               // far
);
camera.rotation.order = "YXZ";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setClearColor(fogColor); // 背景色と fog の色を合わせる
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

let targetCamPos = player.position.clone().add(new THREE.Vector3(0, getCurrentPlayerHeight(), 0));
camera.position.copy(targetCamPos);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(10, 20, 10);
scene.add(directionalLight);

/* ======================================================
   【プレイヤーAABB・衝突判定関連】
   ====================================================== */
function getPlayerAABB() {
    const half = PLAYER_RADIUS - COLLISION_MARGIN;
    const height = getCurrentPlayerHeight();
    return {
        min: new THREE.Vector3(player.position.x - half, player.position.y, player.position.z - half),
        max: new THREE.Vector3(player.position.x + half, player.position.y + height, player.position.z + half)
    };
}

function getPlayerAABBAt(pos) {
    const half = PLAYER_RADIUS - COLLISION_MARGIN;
    const height = getCurrentPlayerHeight();
    return {
        min: new THREE.Vector3(pos.x - half, pos.y, pos.z - half),
        max: new THREE.Vector3(pos.x + half, pos.y + height, pos.z + half)
    };
}

function checkAABBCollision(aabb, velocity, dt) {
    // aabb が THREE.Box3 でない場合は変換
    if (!(aabb instanceof THREE.Box3)) {
        aabb = new THREE.Box3(aabb.min, aabb.max);
    }

    // --- 静的判定（velocity, dt が未指定の場合） ---
    if (velocity === undefined || dt === undefined) {
        const startX = Math.floor(aabb.min.x + COLLISION_MARGIN);
        const endX = Math.ceil(aabb.max.x - COLLISION_MARGIN);
        const startY = Math.floor(aabb.min.y + COLLISION_MARGIN);
        const endY = Math.ceil(aabb.max.y - COLLISION_MARGIN);
        const startZ = Math.floor(aabb.min.z + COLLISION_MARGIN);
        const endZ = Math.ceil(aabb.max.z - COLLISION_MARGIN);

        for (let x = startX; x < endX; x++) {
            for (let y = startY; y < endY; y++) {
                for (let z = startZ; z < endZ; z++) {
                    const voxelVal = getVoxelAtWorld(x, y, z);
                    const config = getBlockConfiguration(voxelVal);
                    // 衝突対象外ならスキップ
                    if (config && config.collision === false) { continue; }

                    if (voxelVal !== BLOCK_TYPES.SKY) {
                        let staticBoxes = [];
                        if (config && typeof config.customCollision === 'function') {
                            // customCollision は局所座標（0～1）でボックスを返すと仮定
                            let localBoxes = config.customCollision(new THREE.Vector3(0, 0, 0));
                            // セルの位置 (x,y,z) をオフセットとして加算
                            staticBoxes = localBoxes.map(box => {
                                const boxWorld = box.clone();
                                boxWorld.min.add(new THREE.Vector3(x, y, z));
                                boxWorld.max.add(new THREE.Vector3(x, y, z));
                                return boxWorld;
                            });
                        } else {
                            // 普通の 1x1x1 の AABB
                            staticBoxes.push(new THREE.Box3(
                                new THREE.Vector3(x, y, z),
                                new THREE.Vector3(x + 1, y + 1, z + 1)
                            ));
                        }

                        // 各衝突ボックスとの交差判定
                        for (const box of staticBoxes) {
                            if (aabb.intersectsBox(box)) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
        return false;
    }

    // --- 動的な連続衝突判定の場合 ---
    let movingBox = aabb;  // aabb を動く Box と見なす
    let earliestCollision = { collision: false, time: dt, normal: new THREE.Vector3(0, 0, 0) };

    const startX = Math.floor(aabb.min.x + COLLISION_MARGIN);
    const endX = Math.ceil(aabb.max.x - COLLISION_MARGIN);
    const startY = Math.floor(aabb.min.y + COLLISION_MARGIN);
    const endY = Math.ceil(aabb.max.y - COLLISION_MARGIN);
    const startZ = Math.floor(aabb.min.z + COLLISION_MARGIN);
    const endZ = Math.ceil(aabb.max.z - COLLISION_MARGIN);

    for (let x = startX; x < endX; x++) {
        for (let y = startY; y < endY; y++) {
            for (let z = startZ; z < endZ; z++) {
                const voxelVal = getVoxelAtWorld(x, y, z);
                const config = getBlockConfiguration(voxelVal);
                if (config && config.collision === false) continue;

                if (voxelVal !== BLOCK_TYPES.SKY) {
                    let staticBoxes = [];
                    if (config && typeof config.customCollision === 'function') {
                        let localBoxes = config.customCollision(new THREE.Vector3(0, 0, 0));
                        staticBoxes = localBoxes.map(box => {
                            const boxWorld = box.clone();
                            boxWorld.min.add(new THREE.Vector3(x, y, z));
                            boxWorld.max.add(new THREE.Vector3(x, y, z));
                            return boxWorld;
                        });
                    } else {
                        staticBoxes.push(new THREE.Box3(
                            new THREE.Vector3(x, y, z),
                            new THREE.Vector3(x + 1, y + 1, z + 1)
                        ));
                    }

                    // 各ボックスとの連続衝突判定（sweptAABB を利用）
                    for (const staticBox of staticBoxes) {
                        const result = sweptAABB(movingBox, velocity, dt, staticBox);
                        if (result.collision && result.time < earliestCollision.time) {
                            earliestCollision = result;
                            if (earliestCollision.time < 1e-6) {
                                return earliestCollision;
                            }
                        }
                    }
                }
            }
        }
    }
    return earliestCollision;
}



/* ======================================================
   【地形生成】（フラクタルノイズ＋ユーザー変更反映）
   ====================================================== */
const MAX_SEARCH_DEPTH = 32;  // startY指定時の最大下方向探索深さ

function getTerrainHeight(worldX, worldZ, startY) {
    if (startY !== undefined) {
        let y = Math.floor(startY);
        const floorX = Math.floor(worldX);
        const floorZ = Math.floor(worldZ);

        // 探索範囲の下限設定（最低0）
        const minY = Math.max(0, y - MAX_SEARCH_DEPTH);

        // y=startY から minY まで下方向に走査し、
        // 空気でない最初のブロックを探す
        for (; y >= minY; y--) {
            if (getVoxelAtWorld(floorX, y, floorZ) !== 0) {
                return y + 1;
            }
        }

        // 見つからなければ最低値として -Infinity を返す
        return -Infinity;
    }

    // startY指定なし（通常のキャッシュ利用）

    const key = `${Math.floor(worldX)}_${Math.floor(worldZ)}`;

    if (terrainHeightCache.has(key)) {
        // LRU更新なしで高速化
        return terrainHeightCache.get(key);
    }

    // ノイズ計算
    const bx = worldX * BASE_SCALE;
    const bz = worldZ * BASE_SCALE;
    const baseNoise = fractalNoise2D(bx, bz, 4, 0.5);

    const dx = worldX * DETAIL_SCALE;
    const dz = worldZ * DETAIL_SCALE;
    const detailNoise = fractalNoise2D(dx, dz, 2, 0.5);

    const height = BASE_HEIGHT + baseNoise * MOUNTAIN_AMPLITUDE + detailNoise * DETAIL_AMPLITUDE;
    const result = Math.floor(height);

    // キャッシュサイズ制御
    if (terrainHeightCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = terrainHeightCache.keys().next().value;
        terrainHeightCache.delete(oldestKey);
    }

    terrainHeightCache.set(key, result);
    return result;
}

// =======================
// グローバル変数などの定義
// =======================
const globalTerrainCache = new Map();
const BEDROCK_LEVEL = 0; // これを 0 にすると、y = 0 を最低地点とする
// キャッシュ：ブロックIDごとの collision 結果
const blockCollisionCache = new Map();
// 簡易数値ハッシュ：32bit 整数キーの代替（低衝突なハッシュ）
function voxelKeyHash(x, y, z) {
    return ((x & 0x3FF) << 20) | ((y & 0x3FF) << 10) | (z & 0x3FF);
}
function terrainKeyHash(x, z) {
    return ((x & 0xFFFF) << 16) | (z & 0xFFFF);
}
// voxelModifications は従来通り string キーである必要があるので fallback
const voxelKeyFor = (x, y, z) => `${x}_${y}_${z}`;
/**
 * 指定座標のブロック種（ブロックID）を返す関数
 * @param {number} x - ワールドの X 座標
 * @param {number} y - ワールドの Y 座標
 * @param {number} z - ワールドの Z 座標
 * @param {Map} terrainCache - 地形キャッシュ（省略時は globalTerrainCache）
 * @param {object} [options] - オプションオブジェクト。例: { raw: true }
 * @returns {number} ブロック種 (ブロックID)
 */
function getVoxelAtWorld(x, y, z, terrainCache = globalTerrainCache, { raw = false } = {}) {
    if (![x, y, z].every(Number.isFinite)) throw new TypeError("worldX, y, worldZ must be valid numbers.");
    if (y < 0) return BLOCK_TYPES.SKY;
    const { SKY, WATER, GRASS, DIRT, STONE, BEDROCK } = BLOCK_TYPES;
    const modKey = voxelKeyFor(x, y, z);
    if (Object.prototype.hasOwnProperty.call(voxelModifications, modKey)) {
        const id = voxelModifications[modKey];
        if (!raw) {
            let cached = blockCollisionCache.get(id);
            if (cached === undefined) {
                cached = !!getBlockConfigById(id)?.collision;
                blockCollisionCache.set(id, cached);
            }
            if (!cached) return SKY;
        }
        return id;
    }
    const tKey = terrainKeyHash(x, z);
    let h = terrainCache.get(tKey);
    if (h === undefined) terrainCache.set(tKey, h = getTerrainHeight(x, z));
    let block;
    if (y > h) block = SKY;
    else if (y === h) block = GRASS;
    else if (y >= h - 2) block = DIRT;
    else if (y > BEDROCK_LEVEL) block = STONE;
    else block = BEDROCK;
    return (block === SKY && y >= 30 && y <= 45) ? WATER : block;
}

/**
 * 補助関数: ブロックIDから BLOCK_CONFIG を取得する
 */
const BLOCK_CONFIG_BY_ID = new Map();
for (const key in BLOCK_CONFIG) {
    const conf = BLOCK_CONFIG[key];
    BLOCK_CONFIG_BY_ID.set(conf.id, conf);
}

function getBlockConfigById(id) {
    return BLOCK_CONFIG_BY_ID.get(id) ?? null;
}

/**
 * getPreciseHeadBlockType
 * プレイヤーの頭部領域を表すベース位置 headPos（THREE.Vector3）から、
 * 複数のサンプル点を取得し、多数決により頭部のブロックIDを決定する関数です。
 *
 * ここでは、中心点と水平方向・垂直方向に少しずらした座標（合計6～7点）をサンプルし、
 * 各サンプルについて getVoxelAtWorld(x, y, z, globalTerrainCache, true) を呼び出します。
 *
 * @param {THREE.Vector3} headPos - プレイヤーの頭部中心の座標
 * @returns {number} - サンプル点の結果から多数決で決まったブロックID
 */
function getPreciseHeadBlockType(headPos) {
    const offsets = [
        new THREE.Vector3(0, 0, 0),    // 中心
        new THREE.Vector3(0.2, 0, 0),  // 右
        new THREE.Vector3(-0.2, 0, 0), // 左
        new THREE.Vector3(0, 0, 0.2),  // 前
        new THREE.Vector3(0, 0, -0.2), // 後ろ
        new THREE.Vector3(0, 0.1, 0),  // わずかに上
        new THREE.Vector3(0, -0.1, 0)  // わずかに下
    ];

    const counts = {};
    offsets.forEach(offset => {
        const samplePos = headPos.clone().add(offset);
        const bx = Math.floor(samplePos.x);
        const by = Math.floor(samplePos.y);
        const bz = Math.floor(samplePos.z);
        const sampleID = getVoxelAtWorld(bx, by, bz, globalTerrainCache, true);
        counts[sampleID] = (counts[sampleID] || 0) + 1;
    });

    let chosenID = BLOCK_TYPES.SKY;
    let maxCount = 0;
    for (const id in counts) {
        if (counts[id] > maxCount) {
            maxCount = counts[id];
            chosenID = parseInt(id);
        }
    }
    return chosenID;
}

/**
 * updateScreenOverlay
 * プレイヤーの頭部領域に基づいて、オーバーレイ表示用のテクスチャを更新する処理です。
 * ここでは、getPreciseHeadBlockType() を利用してサンプル点から頭部ブロックIDを決定します。
 */
function updateScreenOverlay() {
    const currentHeight = getCurrentPlayerHeight();
    const headY = player.position.y + currentHeight * 0.85;
    const headPos = new THREE.Vector3(player.position.x, headY, player.position.z);

    const voxelID = getPreciseHeadBlockType(headPos);
    const config = getBlockConfiguration(voxelID);
    const el = document.getElementById("screenOverlayHtml");

    // テクスチャ優先度：top → all
    const texturePath = config?.screenFill
        ? (config.textures.top || config.textures.all)
        : "";

    if (texturePath) {
        // ここで「本当に水か」をチェック
        const isWater = voxelID === BLOCK_TYPES.WATER;
        el.style.opacity = isWater ? "0.8" : "1";
        el.style.backgroundImage = `url(${texturePath})`;
        el.style.display = "block";
    } else {
        el.style.display = "none";
    }
}

/* ======================================================
   【Swept AABB 衝突検出】
   ====================================================== */
function sweptAABB(movingBox, velocity, dt, staticBox) {
    let entry = new THREE.Vector3();
    let exit = new THREE.Vector3();

    if (velocity.x > 0) {
        entry.x = (staticBox.min.x - movingBox.max.x) / velocity.x;
        exit.x = (staticBox.max.x - movingBox.min.x) / velocity.x;
    } else if (velocity.x < 0) {
        entry.x = (staticBox.max.x - movingBox.min.x) / velocity.x;
        exit.x = (staticBox.min.x - movingBox.max.x) / velocity.x;
    } else {
        entry.x = -Infinity;
        exit.x = Infinity;
    }
    if (velocity.y > 0) {
        entry.y = (staticBox.min.y - movingBox.max.y) / velocity.y;
        exit.y = (staticBox.max.y - movingBox.min.y) / velocity.y;
    } else if (velocity.y < 0) {
        entry.y = (staticBox.max.y - movingBox.min.y) / velocity.y;
        exit.y = (staticBox.min.y - movingBox.max.y) / velocity.y;
    } else {
        entry.y = -Infinity;
        exit.y = Infinity;
    }
    if (velocity.z > 0) {
        entry.z = (staticBox.min.z - movingBox.max.z) / velocity.z;
        exit.z = (staticBox.max.z - movingBox.min.z) / velocity.z;
    } else if (velocity.z < 0) {
        entry.z = (staticBox.max.z - movingBox.min.z) / velocity.z;
        exit.z = (staticBox.min.z - movingBox.max.z) / velocity.z;
    } else {
        entry.z = -Infinity;
        exit.z = Infinity;
    }
    const entryTime = Math.max(entry.x, entry.y, entry.z);
    const exitTime = Math.min(exit.x, exit.y, exit.z);
    if (entryTime > exitTime || entryTime < 0 || entryTime > dt) {
        return { collision: false, time: dt, normal: new THREE.Vector3(0, 0, 0) };
    } else {
        let normal = new THREE.Vector3(0, 0, 0);
        if (entryTime === entry.x) { normal.x = velocity.x > 0 ? -1 : 1; }
        else if (entryTime === entry.y) { normal.y = velocity.y > 0 ? -1 : 1; }
        else if (entryTime === entry.z) { normal.z = velocity.z > 0 ? -1 : 1; }
        return { collision: true, time: entryTime, normal: normal };
    }
}

/* ======================================================
【衝突解消（軸別：水平・垂直）】（安全移動調整）
※ Y 軸の衝突解決部分をバイナリサーチで補正するよう変更
====================================================== */

// 新しい垂直方向の衝突解決関数（バイナリサーチによる安全位置算出）
function resolveVerticalCollision(origY, candidateY, newX, newZ) {
    let low, high;
    let safeY = origY;
    // 上昇か下降かで探索区間を設定
    if (candidateY > origY) {
        low = origY;
        high = candidateY;
    } else {
        low = candidateY;
        high = origY;
    }
    // 10回の反復で安全な Y 座標を求める
    for (let i = 0; i < 10; i++) {
        const mid = (low + high) / 2;
        const testPos = new THREE.Vector3(newX, mid, newZ);
        if (checkAABBCollision(getPlayerAABBAt(testPos))) {
            // 衝突しているので、移動幅を狭める
            if (candidateY > origY) {
                high = mid;
            } else {
                low = mid;
            }
        } else {
            // 衝突していなければ安全とみなし、さらに踏み込めるか探索
            safeY = mid;
            if (candidateY > origY) {
                low = mid;
            } else {
                high = mid;
            }
        }
    }
    return safeY;
}







/**
 * プレイヤーの脱出処理（アンストック処理）
 * 通常の軸別衝突解決後に、依然としてプレイヤーのAABBが衝突している場合、
 * 複数の方向を試して最小の移動量でプレイヤーを重なり状態から解放します。
 */
function resolvePlayerCollision() {
    // まず通常の軸別衝突解決を実施
    axisSeparatedCollisionResolve(dt);
    // 更新後のプレイヤーAABBを取得
    const aabb = getPlayerAABB();
    if (!checkAABBCollision(aabb)) {
        // 衝突が解決されていれば終了
        return;
    }
    // プレイヤーがまだブロック内に埋まっている状態
    // 複数方向（水平360度＋上下）に対して最小の移動量を見つける
    let bestDisplacement = null;
    let minMagnitude = Infinity;

    // 水平方向は円周上で試す（ここでは16方向）
    const directions = [];
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
        directions.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
    }
    // 加えて垂直方向も追加する
    directions.push(new THREE.Vector3(0, 1, 0));
    directions.push(new THREE.Vector3(0, -1, 0));

    // 各方向について、バイナリサーチを行い最小の逃げ量を求める
    for (const dir of directions) {
        // 探索区間（0～1.0程度の移動量）
        let low = 0, high = 1.0;
        let foundDisplacement = null;
        // 最大10回のループで近似
        for (let i = 0; i < 10; i++) {
            const mid = (low + high) / 2;
            const testPos = player.position.clone().addScaledVector(dir, mid);
            const testAABB = getPlayerAABBAt(testPos);
            if (checkAABBCollision(testAABB)) {
                // まだ衝突している → より大きな移動が必要
                low = mid;
            } else {
                // 衝突が解消するなら、高さを下げて最小値を探す
                foundDisplacement = mid;
                high = mid;
            }
        }
        // 更新した移動量が小さなほうが理想
        if (foundDisplacement !== null && foundDisplacement < minMagnitude) {
            minMagnitude = foundDisplacement;
            bestDisplacement = dir.clone().multiplyScalar(foundDisplacement);
        }
    }

    // 脱出できる方向が見つかった場合、その分だけプレイヤーを移動する
    if (bestDisplacement !== null) {
        player.position.add(bestDisplacement);
    } else {
        // 万が一方向が見つからなければ、念のため上方に少し移動（フォールバック）
        player.position.y += 0.1;
    }
}

function axisSeparatedCollisionResolve(dt) {
    const origPos = player.position.clone();
    let newPos = origPos.clone();

    // X 軸移動
    let candidateX = origPos.x + player.velocity.x * dt;
    let posCandidateX = new THREE.Vector3(candidateX, origPos.y, origPos.z);
    if (!checkAABBCollision(getPlayerAABBAt(posCandidateX))) {
        newPos.x = candidateX;
    }
    // Z 軸移動
    let candidateZ = origPos.z + player.velocity.z * dt;
    let posCandidateZ = new THREE.Vector3(newPos.x, origPos.y, candidateZ);
    if (!checkAABBCollision(getPlayerAABBAt(posCandidateZ))) {
        newPos.z = candidateZ;
    }

    // スニーク中の場合、境界近くの支持（足元のブロック）のチェック
    if (sneakActive && player.onGround) {
        const currentCellX = Math.floor(origPos.x);
        const currentCellZ = Math.floor(origPos.z);
        let safeX = (getVoxelAtWorld(Math.floor(newPos.x), Math.floor(origPos.y - 0.1), currentCellZ) !== 0);
        let safeZ = (getVoxelAtWorld(currentCellX, Math.floor(origPos.y - 0.1), Math.floor(newPos.z)) !== 0);
        if (!safeX && Math.floor(newPos.x) !== currentCellX) {
            if (player.velocity.x > 0) { newPos.x = currentCellX + 0.999; }
            else if (player.velocity.x < 0) { newPos.x = currentCellX + 0.001; }
        }
        if (!safeZ && Math.floor(newPos.z) !== currentCellZ) {
            if (player.velocity.z > 0) { newPos.z = currentCellZ + 0.999; }
            else if (player.velocity.z < 0) { newPos.z = currentCellZ + 0.001; }
        }
    }

    // Y 軸移動（改善部分：バイナリサーチで安全な位置を算出）
    let candidateY = origPos.y + player.velocity.y * dt;
    let posCandidateY = new THREE.Vector3(newPos.x, candidateY, newPos.z);
    if (sneakActive && !flightMode && player.onGround && player.velocity.y < 0) {
        candidateY = origPos.y;
        player.velocity.y = 0;
    } else {
        if (checkAABBCollision(getPlayerAABBAt(posCandidateY))) {
            // 衝突が発生している場合、バイナリサーチで安全な Y 座標に補正
            candidateY = resolveVerticalCollision(origPos.y, candidateY, newPos.x, newPos.z);
            player.velocity.y = 0;
        }
    }
    newPos.y = candidateY;
    player.position.copy(newPos);
}


/* ======================================================
   【物理更新：通常モード用】（重力・ジャンプ・水平慣性）
   ====================================================== */
function updateNormalPhysics() {
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0; forward.normalize();
    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    let desiredVel = new THREE.Vector3(0, 0, 0);
    if (keys["w"] || keys["arrowup"]) desiredVel.add(forward);
    if (keys["s"] || keys["arrowdown"]) desiredVel.add(forward.clone().negate());
    if (keys["a"] || keys["arrowleft"]) desiredVel.add(right.clone().negate());
    if (keys["d"] || keys["arrowright"]) desiredVel.add(right);
    if (desiredVel.length() > 0) desiredVel.normalize();

    if (sneakActive && !flightMode) {
        desiredVel.multiplyScalar(playerSpeed() * 0.3);
    } else {
        if (dashActive) {
            desiredVel.multiplyScalar(normalDashMultiplier);
        } else {
            desiredVel.multiplyScalar(playerSpeed());
        }
    }
    player.velocity.x = THREE.MathUtils.lerp(player.velocity.x, desiredVel.x, 0.1);
    player.velocity.z = THREE.MathUtils.lerp(player.velocity.z, desiredVel.z, 0.1);
    if (!flightMode) {
        if (player.velocity.y >= 0) {
            player.velocity.y -= UP_DECEL;
        } else {
            player.velocity.y -= DOWN_ACCEL;
            if (player.velocity.y < MAX_FALL_SPEED) {
                player.velocity.y = MAX_FALL_SPEED;
            }
        }
    }
    if (jumpRequest && player.onGround && !flightMode) {
        player.velocity.y = JUMP_INITIAL_SPEED;
        player.onGround = false;
        jumpRequest = false;
    }
}

function playerSpeed() {
    return 0.08;
}

/* ======================================================
   【物理更新：飛行モード用】（重力無視・一定速度移動）
   ====================================================== */
function updateFlightPhysics() {
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0; forward.normalize();
    const right = new THREE.Vector3();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    let desiredVel = new THREE.Vector3(0, 0, 0);
    if (keys["w"] || keys["arrowup"]) desiredVel.add(forward);
    if (keys["s"] || keys["arrowdown"]) desiredVel.add(forward.clone().negate());
    if (keys["a"] || keys["arrowleft"]) desiredVel.add(right.clone().negate());
    if (keys["d"] || keys["arrowright"]) desiredVel.add(right);
    if (desiredVel.length() > 0) desiredVel.normalize();
    if (dashActive) {
        desiredVel.multiplyScalar(flightDashMultiplier);
    } else {
        desiredVel.multiplyScalar(playerSpeed());
    }
    player.velocity.x = THREE.MathUtils.lerp(player.velocity.x, desiredVel.x, 0.1);
    player.velocity.z = THREE.MathUtils.lerp(player.velocity.z, desiredVel.z, 0.1);
    let targetVertical = 0;
    if (keys[" "] || keys["spacebar"]) {
        targetVertical = flightSpeed;
    } else if (keys["shift"] && flightMode) {
        // 飛行モード中の下降時、dashActive はそのまま維持する
        targetVertical = -flightSpeed;
    }
    player.velocity.y = THREE.MathUtils.lerp(player.velocity.y, targetVertical, 0.1);
}

/* ======================================================
   【onGround 判定】
   ====================================================== */
function updateOnGround() {
    const testPos = new THREE.Vector3(player.position.x, player.position.y - 0.05, player.position.z);
    const testAABB = getPlayerAABBAt(testPos);
    player.onGround = checkAABBCollision(testAABB);
}

/* ======================================================
   【チャンク生成】
   ====================================================== */

// 各面の定義：法線と面を構成する 4 つの頂点を定義
/* ======================================================
   【チャンク生成】
   ====================================================== */

// 各面の定義：法線と面を構成する 4 つの頂点を定義
const faceData = {
    pz: {
        normal: [0, 0, 1],
        vertices: [
            [0, 0, 1],
            [1, 0, 1],
            [1, 1, 1],
            [0, 1, 1]
        ]
    },
    nz: {
        normal: [0, 0, -1],
        vertices: [
            [1, 0, 0],
            [0, 0, 0],
            [0, 1, 0],
            [1, 1, 0]
        ]
    },
    px: {
        normal: [1, 0, 0],
        vertices: [
            [1, 0, 1],
            [1, 0, 0],
            [1, 1, 0],
            [1, 1, 1]
        ]
    },
    nx: {
        normal: [-1, 0, 0],
        vertices: [
            [0, 0, 0],
            [0, 0, 1],
            [0, 1, 1],
            [0, 1, 0]
        ]
    },
    py: {
        normal: [0, 1, 0],
        vertices: [
            [0, 1, 1],
            [1, 1, 1],
            [1, 1, 0],
            [0, 1, 0]
        ]
    },
    ny: {
        normal: [0, -1, 0],
        vertices: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 0, 1],
            [0, 0, 1]
        ]
    }
};

const faceToMaterialIndex = {
    "px": 0,  // 右面（BoxGeometry の順番：右, 左, 上, 下, 前, 後）
    "nx": 1,  // 左面
    "py": 2,  // 上面
    "ny": 3,  // 下面
    "pz": 4,  // 前面
    "nz": 5   // 後面
};

/**
 * computeTopShadowFactorForCorner
 * 
 * 対象ブロックの上段 (wy+1) にある隣接ブロックの有無により、
 * 影の濃さ（0.0～1.0; 値が低いほど暗い）を返します。
 *
 * @param {number} wx - 対象ブロックのワールドX座標
 * @param {number} wy - 対象ブロックのワールドY座標
 * @param {number} wz - 対象ブロックのワールドZ座標
 * @param {string} corner - "LL", "LR", "UR", "UL"
 * @returns {number} 影の濃さ (0.0～1.0)
 */
function computeTopShadowFactorForCorner(wx, wy, wz, corner) {
    const offsets = {
        LL: [-1, 0, 1],  // 西 + 南
        LR: [1, 0, 1],   // 東 + 南
        UR: [1, 0, -1],  // 東 + 北
        UL: [-1, 0, -1]  // 西 + 北
    };

    const d = offsets[corner];
    if (!d) return 1.0;

    const y = wy + 1;
    let count = 0;

    const blockIds = [
        getVoxelAtWorld(wx + d[0], y, wz),
        getVoxelAtWorld(wx, y, wz + d[2])
    ];

    for (let i = 0; i < 2; i++) {
        const blockId = blockIds[i];
        if (typeof blockId === "number" && blockId !== BLOCK_TYPES.SKY) {
            const config = getBlockConfiguration(blockId);
            if (!(config && config.transparent)) {
                count++;
                if (count === 2) return 0.4; // 早期 return
            }
        }
    }

    return count === 1 ? 0.7 : 1.0;
}

// ========= ヘルパー関数 =========

// (voxelModifications はユーザーによるブロック変更情報のオブジェクト)
// ※ 既存の getVoxelAtWorld, getTerrainHeight, voxelModifications, faceData, addFace などはそのまま利用する前提です。

// ユーザー変更があった列をマークする（ブロックの設置／破壊時に適切に呼ぶ）
const columnModifications = {}; // キー： "wx_wz"、値： { maxModifiedY, blocks: [...] }

function markColumnModified(chunkKey, wx, wz, modY) {
    // chunkKey はここでは利用しない（グローバルな columnModifications で管理）
    const colKey = wx + "_" + wz;
    if (!columnModifications[colKey]) {
        columnModifications[colKey] = { maxModifiedY: modY, blocks: [] };
    } else {
        if (modY > columnModifications[colKey].maxModifiedY) {
            columnModifications[colKey].maxModifiedY = modY;
        }
        // 必要に応じて blocks リストにも追加
    }
}

function disposeMesh(mesh) {
    mesh.traverse(child => {
        if (child.isMesh) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(mat => mat.dispose());
                } else {
                    child.material.dispose();
                }
            }
        }
    });
}

function refreshChunkAt(cx, cz) {
    const key = `${cx}_${cz}`;
    if (!(key in loadedChunks)) return;
    console.info("チャンク再生成（フル更新）:", key);
    const oldChunk = loadedChunks[key];
    disposeMesh(oldChunk);
    scene.remove(oldChunk);
    // もしオブジェクトプールが利用できるなら、再利用可能なチャンクを探す
    // ここでは直接生成する例
    const newChunk = generateChunkMeshMultiTexture(cx, cz);
    newChunk.userData.fadedIn = true; // 即座に表示
    setOpacityRecursive(newChunk, 1);
    scene.add(newChunk);
    loadedChunks[key] = newChunk;
}

// ここでは、チャンク座標 (cx, cz) を (cx + OFFSET) と (cz + OFFSET) で正数化し、
// それらを 32bit 分ずつシフトして 64bit (BigInt) にエンコードします。
// ※ ビッグワールド向けに、OFFSET を 2^31 (約21億) に設定（必要なら調整）
const BIGINT_OFFSET = 2n ** 31n;  // 2^31

/**
 * チャンクキーを BigInt にエンコードする関数
 * @param {number} cx - チャンク X 座標
 * @param {number} cz - チャンク Z 座標
 * @returns {bigint} エンコード済みのキー
 */
function encodeChunkKey(cx, cz) {
    return ((BigInt(cx) + BIGINT_OFFSET) << 32n) | ((BigInt(cz) + BIGINT_OFFSET) & 0xffffffffn);
}

/**
 * BigInt でエンコードされたキーからチャンク座標をデコードする関数
 * @param {bigint} key - エンコード済みのチャンクキー
 * @returns {[number, number]} [cx, cz] の配列
 */
function decodeChunkKey(key) {
    const cx = Number((key >> 32n) - BIGINT_OFFSET);
    const cz = Number((key & 0xffffffffn) - BIGINT_OFFSET);
    return [cx, cz];
}

// ───────────────────────────────
// 更新要求用のバッチセットと処理
// ───────────────────────────────

// pendingChunkUpdates は BigInt 値を保持する Set
let pendingChunkUpdates = new Set();

/**
 * 指定チャンク (cx, cz) の更新要求を pendingChunkUpdates に追加する関数
 * @param {number} cx - チャンク X 座標
 * @param {number} cz - チャンク Z 座標
 */
function requestChunkUpdate(cx, cz) {
    // エンコードされた数値キーをセットに追加（同じキーは自動的に無視される）
    pendingChunkUpdates.add(encodeChunkKey(cx, cz));
}

/**
 * 保留中のチャンク更新要求を処理する関数
 * 集められたキーをデコードして、各チャンクに対して refreshChunkAt を呼び出す
 */
function processPendingChunkUpdates() {
    for (const key of pendingChunkUpdates) {
        const [cx, cz] = decodeChunkKey(key);
        refreshChunkAt(cx, cz);  // ← ここはチャンクの再更新処理（各自実装）
    }
    pendingChunkUpdates.clear();
}

const scheduleChunkUpdate = (() => {
    let timeoutId = null;
    return function () {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            processPendingChunkUpdates();
            timeoutId = null;
        }, 200);
    };
})();

/* ======================================================
   【チャンクの管理】
   ====================================================== */
// グローバル変数
const loadedChunks = {}; // 現在シーンに配置中のチャンク（キーは "cx_cz"）
const chunkPool = [];    // 使い回し可能なチャンクメッシュのプール
const chunkQueue = [];   // 新規チャンク生成用のキュー

// 共有用の基本マテリアル。MeshLambertMaterial は影も正しく扱える
const sharedMaterial = new THREE.MeshLambertMaterial({
    color: 0x00aa00,
    transparent: true,
    opacity: 0  // 初期は見えない状態
});

/**
 * フェードインアニメーション（opacity 0→1）を Mesh に適用する関数
 * @param {THREE.Mesh} mesh - 対象メッシュ
 * @param {number} duration - フェードインにかける時間（ミリ秒）
 */
function fadeInMesh(object, duration = 500, onComplete) {
    // すでにフェードイン済みなら何もしない
    if (object.userData.fadedIn) {
        if (onComplete) onComplete();
        return;
    }
    const startTime = performance.now();
    function animate() {
        const elapsed = performance.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        setOpacityRecursive(object, progress);
        if (progress < 1) {
            requestAnimationFrame(animate);
        } else {
            if (onComplete) onComplete();
        }
    }
    requestAnimationFrame(animate);
}

const setOpacityRecursive = (root, opacity) => {
    const clampedOpacity = Math.min(Math.max(opacity, 0), 1);
    root.traverse(child => {
        if (!child.userData?.transparentBlock && clampedOpacity < 1) return;
        let materials = child.material;
        if (!materials) return;
        if (!Array.isArray(materials)) {
            materials = [materials];
        }
        for (const mat of materials) {
            if (!mat) continue;
            // 変更が必要か判定
            const needUpdate =
                mat.opacity !== clampedOpacity ||
                mat.transparent !== (clampedOpacity < 1 || mat.transparent) ||
                mat.depthWrite !== (clampedOpacity < 1 ? false : true);
            if (!needUpdate) continue;
            mat.opacity = clampedOpacity;
            mat.transparent = clampedOpacity < 1 || mat.transparent;
            mat.depthWrite = clampedOpacity < 1 ? false : true;
            mat.needsUpdate = true;
        }
    });
};

/**
 * チャンクメッシュをプールに返して再利用する関数
 * @param {THREE.Mesh} mesh 
 */
function releaseChunkMesh(mesh) {
    scene.remove(mesh);
    // dispose せずに保持することで、再利用可能になる
    chunkPool.push(mesh);
}

/**
 * 1件のチャンクを生成する関数
 */
function generateNextChunk() {
    const chunkInfo = chunkQueue.shift();
    if (!chunkInfo) return;
    const { cx, cz } = chunkInfo;
    const key = `${cx}_${cz}`;
    if (key in loadedChunks) {
        // 既に生成済みの場合は何もしない
        return;
    }
    // 新規チャンクの生成
    const chunkMesh = generateChunkMeshMultiTexture(cx, cz);
    // 追加: 生成直後にすべてのマテリアルの透明度を 0 に設定
    setOpacityRecursive(chunkMesh, 0);
    // 新規生成したチャンクは初期状態で透明（フェードイン前）とする
    chunkMesh.userData.fadedIn = false;
    scene.add(chunkMesh);
    loadedChunks[key] = chunkMesh;
    // フェードインを実行して 0→1 にアニメーションさせる
    fadeInMesh(chunkMesh, 500, () => {
        chunkMesh.userData.fadedIn = true;
    });
}

// ---------------------------------------------------------------------------
// mergeBufferGeometries: 複数の BufferGeometry を統合する関数（vertex color属性もマージ）
// ---------------------------------------------------------------------------
/**
 * 複数の BufferGeometry をマージして１つのジオメトリを生成する（マテリアルグループ対応）
 * @param {THREE.BufferGeometry[]} geometries 
 * @param {object} options - 例: { computeNormals: true }
 * @returns {THREE.BufferGeometry | null}
 */
function mergeBufferGeometries(geometries, options = { computeNormals: true }) {
    if (!geometries || geometries.length === 0) return null;
    if (geometries.length === 1) return geometries[0];

    let totalVertexCount = 0;
    let totalAttributes = {
        position: 0,
        normal: 0,
        uv: 0,
        color: 0,
        index: 0
    };
    let useUint32 = false;

    for (const g of geometries) {
        const posAttr = g.getAttribute("position");
        const count = posAttr.count;
        totalVertexCount += count;

        totalAttributes.position += posAttr.array.length;
        totalAttributes.normal += g.getAttribute("normal")?.array.length || 0;
        totalAttributes.uv += g.getAttribute("uv")?.array.length || 0;
        totalAttributes.color += g.getAttribute("color")?.array.length || 0;
        totalAttributes.index += g.index ? g.index.count : count;

        if (totalVertexCount > 65535) useUint32 = true;
    }

    const IndexArrayType = useUint32 ? Uint32Array : Uint16Array;

    const arrays = {
        position: new Float32Array(totalAttributes.position),
        normal: totalAttributes.normal ? new Float32Array(totalAttributes.normal) : null,
        uv: totalAttributes.uv ? new Float32Array(totalAttributes.uv) : null,
        color: totalAttributes.color ? new Float32Array(totalAttributes.color) : null,
        index: new IndexArrayType(totalAttributes.index)
    };

    let offset = {
        position: 0, normal: 0, uv: 0, color: 0, index: 0, vertex: 0
    };

    const mergedGroups = [];

    for (const g of geometries) {
        const posAttr = g.getAttribute("position");
        const count = posAttr.count;
        arrays.position.set(posAttr.array, offset.position);
        offset.position += posAttr.array.length;

        const normAttr = g.getAttribute("normal");
        if (arrays.normal && normAttr) {
            arrays.normal.set(normAttr.array, offset.normal);
            offset.normal += normAttr.array.length;
        }

        const uvAttr = g.getAttribute("uv");
        if (arrays.uv && uvAttr) {
            arrays.uv.set(uvAttr.array, offset.uv);
            offset.uv += uvAttr.array.length;
        }

        const colAttr = g.getAttribute("color");
        if (arrays.color && colAttr) {
            arrays.color.set(colAttr.array, offset.color);
            offset.color += colAttr.array.length;
        }

        if (g.index) {
            const ia = g.index.array;
            for (let j = 0; j < ia.length; j++) {
                arrays.index[offset.index++] = ia[j] + offset.vertex;
            }
        } else {
            for (let j = 0; j < count; j++) {
                arrays.index[offset.index++] = j + offset.vertex;
            }
        }

        if (g.groups && g.groups.length > 0) {
            for (const group of g.groups) {
                mergedGroups.push({
                    start: group.start + offset.index - (g.index?.count || count),
                    count: group.count,
                    materialIndex: group.materialIndex
                });
            }
        } else {
            // デフォルトグループ追加（全体をカバー）
            mergedGroups.push({
                start: offset.index - (g.index?.count || count),
                count: g.index?.count || count,
                materialIndex: 0
            });
        }

        offset.vertex += count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute("position", new THREE.BufferAttribute(arrays.position, 3));
    if (arrays.normal) merged.setAttribute("normal", new THREE.BufferAttribute(arrays.normal, 3));
    if (arrays.uv) merged.setAttribute("uv", new THREE.BufferAttribute(arrays.uv, 2));
    if (arrays.color) merged.setAttribute("color", new THREE.BufferAttribute(arrays.color, 3));
    merged.setIndex(new THREE.BufferAttribute(arrays.index, 1));

    for (const group of mergedGroups) {
        merged.addGroup(group.start, group.count, group.materialIndex);
    }

    if (options.computeNormals && !arrays.normal) {
        merged.computeVertexNormals();
    }

    return merged;
}


// ---------------------------------------------------------------------------
// getCachedFaceGeometry: faceKey に対応するクワッドジオメトリをキャッシュして返す
// ---------------------------------------------------------------------------
const faceGeomCache = {};
const defaultUVs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const defaultIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

function createFaceGeometry(data) {
    const positions = new Float32Array(data.vertices.flat());
    const normals = new Float32Array(12);
    for (let i = 0; i < 4; i++) normals.set(data.normal, i * 3);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(defaultUVs, 2));
    geom.setIndex(new THREE.BufferAttribute(defaultIndices, 1));
    return geom;
}

function getCachedFaceGeometry(faceKey) {
    if (!faceData[faceKey]) {
        console.warn(`Invalid faceKey: ${faceKey}`);
        return null;
    }
    return faceGeomCache[faceKey] ||= createFaceGeometry(faceData[faceKey]);
}

/*
 * instancing 用、かつ隣接ブロック判定時に「自分と隣接ブロックが両方透明なら内部面は描画しない」
 * という条件も入れるため、currentBlock（現在のブロックタイプ）を渡します。
 */
// 軽量・簡潔化した generateChunkMeshMultiTexture
function generateChunkMeshMultiTexture(cx, cz, useInstancing = false) {
    const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
    const idx = (x, y, z) => x + CHUNK_SIZE * (y + CHUNK_HEIGHT * z);
    const voxelData = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);

    const modMap = voxelModifications instanceof Map ? voxelModifications : new Map(Object.entries(voxelModifications || {}));
    for (let z = 0; z < CHUNK_SIZE; z++)
        for (let y = 0; y < CHUNK_HEIGHT; y++)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
                const key = `${wx}_${wy}_${wz}`;
                voxelData[idx(x, y, z)] = modMap.get(key) ?? getVoxelAtWorld(wx, wy, wz);
            }

    const container = new THREE.Object3D();
    const get = (x, y, z) => {
        const inChunk = x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_HEIGHT && z >= 0 && z < CHUNK_SIZE;
        if (inChunk) return voxelData[idx(x, y, z)];
        const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
        const key = `${wx}_${wy}_${wz}`;
        return modMap.get(key) ?? getVoxelAtWorld(wx, wy, wz);
    };

    if (useInstancing) {
        const instMap = {}, dummy = new THREE.Object3D();
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let y = 0; y < CHUNK_HEIGHT; y++)
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const type = voxelData[idx(x, y, z)];
                    if (!type || type === BLOCK_TYPES.SKY) continue;
                    const cfg = getBlockConfiguration(type);
                    if (!cfg || cfg.customGeometry || ["stairs", "slab", "cross", "water"].includes(cfg.geometryType)) continue;

                    const isTransparent = cfg.transparent ?? false;
                    let visible = false;
                    for (const { normal: [dx, dy, dz] } of Object.values(faceData)) {
                        const neighbor = get(x + dx, y + dy, z + dz);
                        const nCfg = getBlockConfiguration(neighbor);
                        const nTransparent = nCfg?.transparent ?? false;
                        const nCustom = !!nCfg?.customGeometry;
                        if (!neighbor || neighbor === BLOCK_TYPES.SKY ||
                            (nTransparent && (!isTransparent || neighbor !== type)) ||
                            (nCustom && !cfg.customGeometry)) {
                            visible = true; break;
                        }
                    }
                    if (!visible) continue;
                    (instMap[type] ??= []).push([baseX + x + 0.5, BEDROCK_LEVEL + y + 0.5, baseZ + z + 0.5]);
                }
        for (const [type, list] of Object.entries(instMap)) {
            const mats = getBlockMaterials(+type);
            if (!mats?.length) continue;
            const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mats[0].clone(), list.length);
            list.forEach(([x, y, z], i) => {
                dummy.position.set(x, y, z); dummy.updateMatrix(); inst.setMatrixAt(i, dummy.matrix);
            });
            Object.assign(inst, { castShadow: true, receiveShadow: true, frustumCulled: true });
            container.add(inst);
        }
    } else {
        const faceGeoms = {};
        for (let z = 0; z < CHUNK_SIZE; z++)
            for (let y = 0; y < CHUNK_HEIGHT; y++)
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const type = voxelData[idx(x, y, z)];
                    if (!type || type === BLOCK_TYPES.SKY) continue;
                    const cfg = getBlockConfiguration(type);
                    if (!cfg) continue;
                    const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
                    if (cfg.customGeometry) {
                        const mesh = createCustomBlockMesh(type, new THREE.Vector3(wx, wy, wz));
                        if (mesh) container.add(mesh);
                        continue;
                    }
                    if (["stairs", "slab", "cross"].includes(cfg.geometryType)) continue;
                    for (const [face, { normal: [dx, dy, dz] }] of Object.entries(faceData)) {
                        const neighbor = get(x + dx, y + dy, z + dz);
                        const nCfg = getBlockConfiguration(neighbor);
                        const visible = !neighbor || neighbor === BLOCK_TYPES.SKY ||
                            ((nCfg?.transparent ?? false) && (!(cfg.transparent ?? false) || neighbor !== type)) ||
                            (!!nCfg?.customGeometry && !cfg.customGeometry);
                        if (!visible) continue;

                        const geom = getCachedFaceGeometry(face).clone().applyMatrix4(new THREE.Matrix4().makeTranslation(wx, wy, wz));
                        const colors = face === "py"
                            ? ["LL", "LR", "UR", "UL"].flatMap(c => Array(3).fill(computeTopShadowFactorForCorner(wx, wy, wz, c)))
                            : Array(12).fill(1);
                        geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
                        const matIdx = faceToMaterialIndex[face];
                        (faceGeoms[type] ??= {})[matIdx] ??= []; faceGeoms[type][matIdx].push(geom);
                    }
                }
        for (const [type, group] of Object.entries(faceGeoms)) {
            const subGeoms = Object.values(group).map(mergeBufferGeometries);
            const finalGeom = mergeBufferGeometries(subGeoms);
            finalGeom.clearGroups();
            let offset = 0;
            Object.keys(group).forEach((matIdx, i) => {
                const count = subGeoms[i].index.count;
                finalGeom.addGroup(offset, count, +matIdx);
                offset += count;
            });
            finalGeom.computeBoundingSphere();
            const mats = getBlockMaterials(+type)?.map(m => Object.assign(m.clone(), { vertexColors: THREE.VertexColors, side: THREE.FrontSide }));
            const mesh = new THREE.Mesh(finalGeom, mats);
            Object.assign(mesh, { castShadow: true, receiveShadow: true, frustumCulled: true });
            container.add(mesh);
        }
    }
    return container;
}

// カスタムジオメトリ生成専用関数（例）
const materialCache = new Map();
const collisionCache = new Map();
function createCustomBlockMesh(type, position, rotation) {
    const config = getBlockConfiguration(type);
    if (!config) {
        console.error("Unknown block type:", type);
        return null;
    }
    // geometry取得
    let geometry;
    if (config.geometryType) {
        if (!geometryCache.has(type)) {
            geometryCache.set(type, getBlockGeometry(config.geometryType, config));
        }
        geometry = geometryCache.get(type);
    } else if (config.customGeometry) {
        geometry = typeof config.customGeometry.clone === 'function'
            ? config.customGeometry.clone()
            : config.customGeometry;
    } else {
        console.warn(`No geometry for block type: ${type}`);
        return null;
    }
    // material取得
    let materials = materialCache.get(type);
    if (!materials) {
        materials = getBlockMaterials(type);
        materialCache.set(type, materials);
    }
    const useMultiMaterial = Array.isArray(materials) && materials.length > 1 && geometry.groups?.length > 0;
    const meshGeometry = config.geometryType ? geometry : geometry.clone();
    const meshMaterial = useMultiMaterial ? materials : materials[0];
    const mesh = new THREE.Mesh(meshGeometry, meshMaterial);
    mesh.position.copy(position);
    if (rotation) mesh.rotation.copy(rotation);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    // 衝突キャッシュ取得
    let collisionBoxes = collisionCache.get(type);
    if (!collisionBoxes) {
        if (typeof config.customCollision === "function") {
            collisionBoxes = config.customCollision(new THREE.Vector3(0, 0, 0));
        } else if (config.collision) {
            const height = config.geometryType === "slab" ? 0.5 : 1;
            collisionBoxes = [
                new THREE.Box3(
                    new THREE.Vector3(0, 0, 0),
                    new THREE.Vector3(1, height, 1)
                )
            ];
        } else {
            collisionBoxes = [];
        }
        collisionCache.set(type, collisionBoxes);
    }
    const worldCollisionBoxes = collisionBoxes.map(box => {
        const translated = box.clone();
        translated.min.add(position);
        translated.max.add(position);
        return translated;
    });
    mesh.userData = {
        isCustomBlock: !!config.customGeometry,
        blockType: type,
        collisionBoxes: worldCollisionBoxes
    };
    mesh.updateMatrixWorld();
    return mesh;
}

/**
 * idle 時間内またはタイムアウト時にキューからチャンク生成する関数
 * @param {IdleDeadline} [deadline] -
 */
// チャンク更新キュー（chunkQueue は既存のグローバル変数）
function processChunkQueue(deadline) {
    const fallbackDeadline = {
        timeRemaining: () => 0,
        didTimeout: true
    };
    deadline = deadline && typeof deadline.timeRemaining === 'function' ? deadline : fallbackDeadline;

    const maxTasksPerFrame = 4; // タスク数を調整してスループット向上
    let tasksProcessed = 0;

    while (
        chunkQueue.length > 0 &&
        (deadline.timeRemaining() > 1 || deadline.didTimeout) &&
        tasksProcessed < maxTasksPerFrame
    ) {
        const start = performance.now();
        generateNextChunk();
        const elapsed = performance.now() - start;

        // 時間を使いすぎたら強制中断して次フレームへ回す
        if (elapsed > 8 && !deadline.didTimeout) break;

        tasksProcessed++;
    }

    if (chunkQueue.length > 0) {
        const schedule = window.requestIdleCallback || (cb =>
            setTimeout(() => cb(fallbackDeadline), 16));
        schedule(processChunkQueue);
    }
}


// グローバル状態（chunkQueue は const として宣言されている前提）
let lastChunk = { x: null, z: null },
    offsets = null;
function precomputeOffsets() {
    const off = [];
    for (let dx = -CHUNK_VISIBLE_DISTANCE; dx <= CHUNK_VISIBLE_DISTANCE; dx++) {
        for (let dz = -CHUNK_VISIBLE_DISTANCE; dz <= CHUNK_VISIBLE_DISTANCE; dz++) {
            off.push({ dx, dz, d: dx * dx + dz * dz });
        }
    }
    return off.sort((a, b) => a.d - b.d);
}
function updateChunks() {
    const pCx = Math.floor(player.position.x / CHUNK_SIZE),
        pCz = Math.floor(player.position.z / CHUNK_SIZE);
    if (lastChunk.x === pCx && lastChunk.z === pCz) return;
    lastChunk = { x: pCx, z: pCz };
    if (!offsets) offsets = precomputeOffsets();
    const req = new Set(),
        queued = new Set(chunkQueue.map(e => `${e.cx}_${e.cz}`)),
        candidates = [];
    for (const { dx, dz, d } of offsets) {
        const cx = pCx + dx,
            cz = pCz + dz,
            key = `${cx}_${cz}`;
        req.add(key);
        if (!loadedChunks[key] && !queued.has(key)) {
            candidates.push({ cx, cz, d });
            queued.add(key);
        }
    }
    candidates.forEach(c => chunkQueue.push({ cx: c.cx, cz: c.cz }));
    // chunkQueue の内容をインプレースで更新（const への再代入はしない）
    const filteredQueue = chunkQueue.filter(e => req.has(`${e.cx}_${e.cz}`));
    chunkQueue.splice(0, chunkQueue.length, ...filteredQueue);
    chunkQueue.sort((a, b) => {
        const da = (a.cx - pCx) ** 2 + (a.cz - pCz) ** 2,
            db = (b.cx - pCx) ** 2 + (b.cz - pCz) ** 2;
        return da - db;
    });
    for (const key in loadedChunks) {
        if (!req.has(key)) {
            releaseChunkMesh(loadedChunks[key]);
            delete loadedChunks[key];
        }
    }
    (window.requestIdleCallback || ((cb) => setTimeout(cb, 16)))(
        () => processChunkQueue({ timeRemaining: () => 16, didTimeout: true })
    );
}


/* ======================================================
   【ブロックの破壊・設置機能】（長押し、範囲指定、プレイヤー領域禁止）
   ====================================================== */
const BLOCK_INTERACT_RANGE = 6;
let interactIntervalId = null;
/**
 * 座標からチャンク座標を求めるユーティリティ関数
 * 非負の場合はビット演算で高速に、負の場合は Math.floor を利用
 */
function getChunkCoord(val) {
    return val >= 0 ? (val >> 4) : Math.floor(val / CHUNK_SIZE);
}

// 更新要求を蓄積するための Set とデバウンス用タイマー
let updateTimeout = null;

/**
 * デバウンスしてチャンク更新要求を一括処理する関数
 * 同一チャンクへの重複要求を防ぎ、約16ms（1フレーム分）後にまとめて実行します。
 *
 * @param {number} cx - チャンクのX座標
 * @param {number} cz - チャンクのZ座標
 */
function requestDebouncedChunkUpdate(cx, cz) {
    // BigInt 型のキーを作成
    const key = encodeChunkKey(cx, cz);
    pendingChunkUpdates.add(key);

    // 既にタイマーが動作中なら再スケジュールは不要
    if (updateTimeout !== null) {
        return;
    }

    // 約16ms後（1フレーム分）に蓄積された全ての更新要求を一括処理
    updateTimeout = setTimeout(() => {
        pendingChunkUpdates.forEach(chunkKey => {
            // BigInt キーをデコードしてチャンク座標を取得
            const [x, z] = decodeChunkKey(chunkKey);
            requestChunkUpdate(x, z);
        });
        pendingChunkUpdates.clear();
        scheduleChunkUpdate();
        updateTimeout = null;
    }, 16);
}

/**
 * updateAffectedChunks は、ブロック操作によって影響を受けるチャンク（自分自身や隣接チャンク）を
 * 計算し、更新要求を発行します。チャンク座標の算出や、ローカル座標から隣接チャンクを知る方法は、
 * CHUNK_SIZE が 2の冪である前提でビット演算を使用しています。
 *
 * @param {{x: number, y: number, z: number}} blockPos - 操作対象のブロックワールド座標
 */
function updateAffectedChunks(blockPos) {
    // ブロック座標からチャンク座標を算出する
    const cx = getChunkCoord(blockPos.x);
    const cz = getChunkCoord(blockPos.z);

    // 自分のチャンクは必ず更新要求
    requestDebouncedChunkUpdate(cx, cz);

    // ローカルなセル座標（チャンク内の位置）を算出
    // CHUNK_SIZE が 2 の冪である前提で、ビットAND を使います
    const localX = blockPos.x & (CHUNK_SIZE - 1);
    const localZ = blockPos.z & (CHUNK_SIZE - 1);

    // 境界に達している場合は、隣接チャンクへの更新要求を出す
    if (localX === 0) {
        requestDebouncedChunkUpdate(cx - 1, cz);
    }
    if (localX === CHUNK_SIZE - 1) {
        requestDebouncedChunkUpdate(cx + 1, cz);
    }
    if (localZ === 0) {
        requestDebouncedChunkUpdate(cx, cz - 1);
    }
    if (localZ === CHUNK_SIZE - 1) {
        requestDebouncedChunkUpdate(cx, cz + 1);
    }

    // 斜め（対角）の場合も更新要求を追加
    if (localX === 0 && localZ === 0) {
        requestDebouncedChunkUpdate(cx - 1, cz - 1);
    }
    if (localX === 0 && localZ === CHUNK_SIZE - 1) {
        requestDebouncedChunkUpdate(cx - 1, cz + 1);
    }
    if (localX === CHUNK_SIZE - 1 && localZ === 0) {
        requestDebouncedChunkUpdate(cx + 1, cz - 1);
    }
    if (localX === CHUNK_SIZE - 1 && localZ === CHUNK_SIZE - 1) {
        requestDebouncedChunkUpdate(cx + 1, cz + 1);
    }
}

/**
 * ブロックの AABB とプレイヤーの AABB が交差しているかを判定する
 * ※ tolerance は数値の余裕（例えば 0.001 や 0.05 など）を与え、
 *    境界だけの接触を「交差」と判定しないようにするためのものです。
 *
 * @param {THREE.Vector3} blockPos ブロックの左下前（最低座標）
 * @param {Object} playerAABB プレイヤーの AABB。 { min: THREE.Vector3, max: THREE.Vector3 }
 * @param {number} tolerance 余裕の値（デフォルト 0.001）
 * @returns {boolean} 交差している場合 true、そうでなければ false
 */
function blockIntersectsPlayer(blockPos, playerAABB, tolerance = 0.001) {
    const min = blockPos, max = blockPos.clone().addScalar(1);
    return !(
        max.x <= playerAABB.min.x + tolerance || min.x >= playerAABB.max.x - tolerance ||
        max.y <= playerAABB.min.y + tolerance || min.y >= playerAABB.max.y - tolerance ||
        max.z <= playerAABB.min.z + tolerance || min.z >= playerAABB.max.z - tolerance
    );
}

// --- interactWithBlock 関数 ---
// ブロックの設置／破壊操作を行い voxelModifications を更新し、必要なチャンク（領域）再生成を指示する
// ※ この例では、レイキャストを用いて対象セル（ワールド座標）を取得し、プレイヤーの範囲チェックも実施します。
// グローバル管理用（カスタムブロック Mesh の管理）
const placedCustomBlocks = {};
const raycaster = new THREE.Raycaster();

function interactWithBlock(action) {
    raycaster.near = 0.01;
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    const objects = [...Object.values(loadedChunks), ...Object.values(placedCustomBlocks)];
    let intersects = [];
    for (const obj of objects) {
        obj.isInstancedMesh ? obj.raycast(raycaster, intersects) : intersects.push(...raycaster.intersectObject(obj, true));
    }
    intersects.sort((a, b) => a.distance - b.distance);

    let intersect = intersects[0];
    if (!intersect && action === "destroy") {
        const headY = player.position.y + getCurrentPlayerHeight() * 0.85;
        intersect = { point: new THREE.Vector3(Math.floor(player.position.x), Math.floor(headY), Math.floor(player.position.z)), face: { normal: new THREE.Vector3() } };
    }
    if (!intersect) return console.warn("設置対象のブロックが取得できませんでした。");

    const factor = action === "destroy" ? -0.5 : 0.5;
    const epsilon = 0.01;
    const p = intersect.point, n = intersect.face.normal;
    const candidateA = new THREE.Vector3(Math.floor(p.x + n.x * factor), Math.floor(p.y + n.y * factor), Math.floor(p.z + n.z * factor));
    const candidateB = new THREE.Vector3(Math.floor(p.x - n.x * epsilon), Math.floor(p.y - n.y * epsilon), Math.floor(p.z - n.z * epsilon));

    const rawKey = `${candidateB.x}_${candidateB.y}_${candidateB.z}`;
    let rawVoxel = voxelModifications[rawKey] ?? getVoxelAtWorld(candidateB.x, candidateB.y, candidateB.z, globalTerrainCache, true);
    let rawConfig = getBlockConfiguration(rawVoxel);

    let candidateBlockPos = rawConfig?.geometryType === "water" ? candidateB : candidateA;
    const key = `${candidateBlockPos.x}_${candidateBlockPos.y}_${candidateBlockPos.z}`;
    let finalVoxel = voxelModifications[key] ?? getVoxelAtWorld(candidateBlockPos.x, candidateBlockPos.y, candidateBlockPos.z, globalTerrainCache, true);
    const config = action === "place" ? getBlockConfiguration(activeBlockType) : getBlockConfiguration(finalVoxel);

    if (action === "destroy") {
        if (finalVoxel === BLOCK_TYPES.SKY) return console.warn("該当セルは空気のため破壊できません。");
    } else if (action === "place") {
        if (finalVoxel !== BLOCK_TYPES.SKY) {
            const currentConfig = getBlockConfiguration(finalVoxel);
            if (currentConfig?.geometryType === "water") {
                if (placedCustomBlocks[key]) { scene.remove(placedCustomBlocks[key]); delete placedCustomBlocks[key]; }
                voxelModifications[key] = BLOCK_TYPES.SKY;
                finalVoxel = BLOCK_TYPES.SKY;
            } else return console.warn("このセルには既にブロックが配置されています。");
        }
    }

    const blockCenter = config?.geometryType === "slab"
        ? new THREE.Vector3(candidateBlockPos.x + 0.5, candidateBlockPos.y + 0.25, candidateBlockPos.z + 0.5)
        : new THREE.Vector3(candidateBlockPos.x + 0.5, candidateBlockPos.y + 0.5, candidateBlockPos.z + 0.5);

    if (player.position.distanceTo(blockCenter) > BLOCK_INTERACT_RANGE) return console.warn(`${action === "destroy" ? "破壊" : "設置"}対象が範囲外です。`);

    if (action === "destroy") {
        createMinecraftBreakParticles(blockCenter, finalVoxel, 1.0);
        if (config && ["slab", "stairs", "cross", "water"].includes(config.geometryType)) {
            if (placedCustomBlocks[key]) { scene.remove(placedCustomBlocks[key]); delete placedCustomBlocks[key]; }
        }
        voxelModifications[key] = BLOCK_TYPES.SKY;
        console.log("破壊完了：", candidateBlockPos);
    } else {
        if (config?.collision) {
            if (blockIntersectsPlayer(candidateBlockPos, getPlayerAABB(), 0.05)) return console.warn("プレイヤーの領域に近すぎるため、設置できません。");
        }
        if (candidateBlockPos.y >= BEDROCK_LEVEL + CHUNK_HEIGHT) return console.warn("高さ制限により、設置できません。");
        voxelModifications[key] = activeBlockType;
        console.log("設置完了：", candidateBlockPos, "タイプ：", activeBlockType);
        if (config && ["stairs", "slab", "cross", "water"].includes(config.geometryType)) {
            const placedMesh = createBlockMesh(activeBlockType, candidateBlockPos);
            placedMesh.updateMatrixWorld(true);
            if (config.customCollision) {
                placedMesh.userData.collisionBoxes = config.customCollision(new THREE.Vector3())
                    .map(lb => lb.clone().min.add(candidateBlockPos) && lb.clone().max.add(candidateBlockPos));
            }
            scene.add(placedMesh);
            placedCustomBlocks[key] = placedMesh;
        }
    }

    const chunkX = Math.floor(candidateBlockPos.x / CHUNK_SIZE);
    const chunkZ = Math.floor(candidateBlockPos.z / CHUNK_SIZE);
    markColumnModified(`${chunkX}_${chunkZ}`, candidateBlockPos.x, candidateBlockPos.z, candidateBlockPos.y);
    updateAffectedChunks(candidateBlockPos);
    console.log("操作完了 (" + action + ") at: ", candidateBlockPos);
}

// 例: 一度に処理する更新チャンク数を制限する
function processPendingChunkUpdatesBatch(batchSize = 2) {
    let processed = 0;
    // while ループで、Set から直接値を１件ずつ取り出す
    while (pendingChunkUpdates.size > 0 && processed < batchSize) {
        const iterator = pendingChunkUpdates.values();
        const key = iterator.next().value;
        if (!key) break;
        const [x, z] = decodeChunkKey(key);
        requestChunkUpdate(x, z);
        pendingChunkUpdates.delete(key);
        processed++;
    }
    // まだ処理するキーが残っていれば、次のフレームで継続
    if (pendingChunkUpdates.size > 0) {
        requestAnimationFrame(() => processPendingChunkUpdatesBatch(batchSize));
    } else {
        scheduleChunkUpdate();
    }
}

// それぞれのボタン用のインターバルIDを保持するオブジェクトを定義
const interactIntervalIds = {
    left: null,
    right: null,
    touch: null,
};

function startInteraction(action, key) {
    if (interactIntervalIds[key] !== null) {
        clearInterval(interactIntervalIds[key]);
    }
    interactWithBlock(action);
    interactIntervalIds[key] = setInterval(() => {
        interactWithBlock(action);
    }, 150);
}

function stopInteraction(key) {
    if (interactIntervalIds[key] !== null) {
        clearInterval(interactIntervalIds[key]);
        interactIntervalIds[key] = null;
    }
}

// ----- マウス操作 -----
renderer.domElement.addEventListener("mousedown", (event) => {
    if (document.pointerLockElement !== renderer.domElement) return;

    let action = null;
    let buttonKey = null;
    if (event.button === 0) {        // 左クリック：破壊
        action = "destroy";
        buttonKey = "left";
    } else if (event.button === 2) { // 右クリック：設置
        action = "place";
        buttonKey = "right";
    }

    if (action && buttonKey) {
        startInteraction(action, buttonKey);
    }
}, false);

document.addEventListener("mouseup", (event) => {
    if (event.button === 0) {
        stopInteraction("left");
    } else if (event.button === 2) {
        stopInteraction("right");
    }
}, false);

renderer.domElement.addEventListener("contextmenu", (e) => {
    e.preventDefault();
}, false);

// ----- ポインタロック -----
renderer.domElement.addEventListener("click", () => {
    // タッチ環境ではポインタロックしない
    if (!("ontouchstart" in window)) {
        renderer.domElement.requestPointerLock();
    }
});

document.addEventListener("pointerlockchange", () => {
    console.log(document.pointerLockElement === renderer.domElement ? "Pointer Locked" : "Pointer Unlocked");
});

// ----- マウス移動による視点操作 -----
document.addEventListener("mousemove", (event) => {
    if (document.pointerLockElement === renderer.domElement) {
        yaw -= event.movementX * mouseSensitivity;
        pitch -= event.movementY * mouseSensitivity;
        pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    }
});

// ----- タッチ操作で視点回転と破壊・設置 -----
let lastTouchX = null, lastTouchY = null;
let touchHoldTimeout = null;
let isLongPress = false;

renderer.domElement.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return; // 1本指のみ対応

    isLongPress = false;

    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;

    // 500ms経過したら長押しと判定して破壊の繰り返し開始
    touchHoldTimeout = setTimeout(() => {
        isLongPress = true;
        startInteraction("destroy", "touch");
    }, 500);
}, false);

renderer.domElement.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    const deltaX = touch.clientX - lastTouchX;
    const deltaY = touch.clientY - lastTouchY;
    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;

    const touchSensitivity = 0.005;
    yaw -= deltaX * touchSensitivity;
    pitch -= deltaY * touchSensitivity;
    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));

    e.preventDefault();
}, false);

renderer.domElement.addEventListener("touchend", (e) => {
    clearTimeout(touchHoldTimeout);

    if (isLongPress) {
        // 長押し中断なので破壊の繰り返しを停止
        stopInteraction("touch");
    } else {
        // 短いタップなので設置を1回だけ実行
        interactWithBlock("place");
    }

    lastTouchX = lastTouchY = null;
}, false);

const keys = {};
document.addEventListener("keydown", (e) => {
    if ((e.key === " " || e.key === "Spacebar") && e.repeat) return;
    keys[e.key.toLowerCase()] = true;
    if (e.key >= "1" && e.key <= "9") {
        const hotbarItems = document.querySelectorAll(".hotbar-item");
        hotbarItems.forEach(item => item.classList.remove("active"));

        const index = parseInt(e.key, 10) - 1;
        if (hotbarItems[index]) {
            hotbarItems[index].classList.add("active");
            // グローバルなホットバーインデックスの更新（もし利用している場合）
            activeHotbarIndex = index;
            // 数値キー選択時もデータ属性からブロック種別を正しく取得して更新する
            activeBlockType = Number(hotbarItems[index].getAttribute("data-blocktype"));
            console.log("Active block type switched to:", activeBlockType);
        }
    }
    if (e.key === " " || e.key === "Spacebar") {
        let now = performance.now();
        if (now - lastSpaceTime < 300) {
            flightMode = !flightMode;
            jumpRequest = false;
            console.log("Flight Mode:", flightMode);
        }
        lastSpaceTime = now;
    }
    if (e.key.toLowerCase() === "w") {
        if (!e.repeat) {
            let now = performance.now();
            if (now - lastWPressTime < doubleTapThreshold) {
                dashActive = true;
                console.log("Dash activated!");
            }
            lastWPressTime = now;
        }
    }
    if (e.key.toLowerCase() === "shift") {
        sneakActive = true;
        // 歩行モードでのみダッシュを解除する
        if (!flightMode) {
            dashActive = false;
        }
    }
});


const createCanvas = size => {
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    return c;
};

const loadImage = src =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = err => reject(err);
        img.src = src;
    });

const createHotbarItemPreview = (blockConfig, size = 64) => {
    const config = getBlockConfiguration(blockConfig.id);
    return config.previewType === "2D" ? create2DPreview(config, size) : create3DPreview(config, size);
};

const create2DPreview = ({ id, textures = {}, previewOptions = {} }, size) => {
    const canvas = createCanvas(size);
    canvas.style.imageRendering = "pixelated";
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const src = textures.all || textures.side || textures.top;
    if (!src) {
        console.warn(`テクスチャがありません block: ${id}`);
        return canvas;
    }
    loadImage(src)
        .then(img => {
            const { x: offsetX = 0, y: offsetY = 0 } = previewOptions.offset || {};
            ctx.save(); ctx.translate(offsetX, offsetY);
            ctx.drawImage(img, 0, 0, size, size);
            ctx.restore();
        })
        .catch(err => console.error(`画像読み込み失敗 block: ${id}`, err));
    return canvas;
};

const create3DPreview = ({ id, previewOptions = {}, geometryType }, size) => {
    const canvas = createCanvas(size),
        aspect = 1, d = 2;
    const camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 0.1, 100);
    camera.position.set(2, 2, 2); camera.lookAt(0, 0, 0);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(size, size); renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const light = new THREE.DirectionalLight(0xffffff, 0.8);
    light.position.set(5, 5, 5); scene.add(light);
    const mesh = createBlockMesh(id, new THREE.Vector3(0, 0, 0));
    if (!mesh) { console.error(`メッシュ生成失敗 id: ${id}`); return canvas; }
    scene.add(mesh);
    const center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    mesh.position.sub(center);
    if (previewOptions.offset) {
        const { x = 0, y = 0, z = 0 } = previewOptions.offset;
        mesh.position.add(new THREE.Vector3(x, y, z));
    }
    const { rotation = { x: 30, y: 45, z: 0 }, scale = 0 } = previewOptions;
    mesh.rotation.set(
        THREE.MathUtils.degToRad(rotation.x),
        THREE.MathUtils.degToRad(rotation.y),
        THREE.MathUtils.degToRad(rotation.z)
    );
    mesh.scale.setScalar(scale);
    if (geometryType === "stairs") {
        mesh.scale.x *= -1;
        const newCenter = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
        mesh.position.sub(newCenter);
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (geometryType === "cube")
        mats.forEach(mat => { if (mat.vertexColors) { mat.vertexColors = false; mat.needsUpdate = true; } });
    mats.forEach(mat => {
        if (mat.map) {
            Object.assign(mat.map, {
                magFilter: THREE.NearestFilter,
                minFilter: THREE.NearestMipmapNearestFilter,
                needsUpdate: true
            });
            if (!mat.map.image)
                mat.map.addEventListener("update", () => renderer.render(scene, camera));
        }
    });
    renderer.render(scene, camera);
    if (mats.some(mat => mat.map && !mat.map.image)) {
        const start = performance.now();
        const animate = () => {
            renderer.render(scene, camera);
            if (performance.now() - start < 1000) requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }
    return canvas;
};

// 例として、ホットバーに表示するブロックの順序や種類の配列を定義します。
// 必要に応じて、この配列の内容を変更してください。
// ホットバーに表示するブロック順序（ブロック名は BLOCK_CONFIG のキーと揃える）
const blockOrder = [
    "GRASS", "DIRT", "STONE", "PLANKS", "BEDROCK",
    "GLASS", "STONE_STAIRS", "STONE_SLAB", "WATER"
];
const slotCount = 9;  // 固定スロット数
const hotbarEl = document.getElementById("hotbar");
hotbarEl.innerHTML = "";
for (let i = 0; i < slotCount; i++) {
    const item = document.createElement("div");
    item.classList.add("hotbar-item");
    // 例として最初のスロットに active クラスを追加
    if (i === 0) item.classList.add("active");
    const blockName = blockOrder[i];
    // BLOCK_CONFIG から情報を取得。blockName が undefined または BLOCK_CONFIG に無ければ blockConfig は undefined。
    const blockConfig = blockName ? BLOCK_CONFIG[blockName] : undefined;
    // データ属性にブロックIDを設定。該当する項目がなければ空文字
    item.setAttribute("data-blocktype", blockConfig ? blockConfig.id : "");
    if (blockConfig) {
        const previewCanvas = createHotbarItemPreview(blockConfig, 64);
        previewCanvas.style.width = "64px";
        previewCanvas.style.height = "64px";
        item.appendChild(previewCanvas);
    } else {
        item.style.background = "rgba(0, 0, 0, 0.5";
    }
    hotbarEl.appendChild(item);
}


// グローバルスコープにホットバー選択用のインデックスを定義（初期値は 0）
let activeBlockType = 1;
let activeHotbarIndex = 0;

// ホットバーアイテムクリック時
document.querySelectorAll("#hotbar .hotbar-item").forEach((item, index) => {
    item.addEventListener("click", () => {
        document.querySelectorAll("#hotbar .hotbar-item").forEach(el => el.classList.remove("active"));
        item.classList.add("active");
        activeHotbarIndex = index;
        activeBlockType = Number(item.getAttribute("data-blocktype"));
        console.log("Active block type set to:", activeBlockType);
    });
});

// マウスホイールイベントリスナーを追加
const hotbarItems = document.querySelectorAll(".hotbar-item");
document.addEventListener("wheel", (event) => {
    if (!hotbarItems.length) return;
    if (event.deltaY > 0) {
        activeHotbarIndex = (activeHotbarIndex + 1) % hotbarItems.length;
    } else if (event.deltaY < 0) {
        activeHotbarIndex = (activeHotbarIndex - 1 + hotbarItems.length) % hotbarItems.length;
    }
    hotbarItems.forEach(item => item.classList.remove("active"));
    hotbarItems[activeHotbarIndex].classList.add("active");
    activeBlockType = Number(hotbarItems[activeHotbarIndex].getAttribute("data-blocktype"));
    console.log("Active block type switched to:", activeBlockType);
});


document.addEventListener("keyup", (e) => {
    keys[e.key.toLowerCase()] = false;
    if (e.key.toLowerCase() === "w") {
        dashActive = false;
    }
    if (e.key.toLowerCase() === "shift") {
        sneakActive = false;
    }
});


// ----- 選択アウトライン用オブジェクト -----
// （1×1×1 の BoxGeometry に基づいた単純なエッジ表示）
const selectionOutlineGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const selectionOutlineMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
const selectionOutlineMesh = new THREE.LineSegments(selectionOutlineGeometry, selectionOutlineMaterial);
selectionOutlineMesh.visible = false;
scene.add(selectionOutlineMesh);

// ----- グローバル：ブロック情報表示用 DOM や、Raycaster 用オブジェクト -----
const BLOCK_NAMES = Object.keys(BLOCK_TYPES).reduce((names, key) => {
    names[BLOCK_TYPES[key]] = key.charAt(0) + key.slice(1).toLowerCase();
    return names;
}, {});

const blockInfoElem = document.getElementById("blockInfo");

// ----- 改善版: updateBlockSelection -----
// Raycaster で全てのチャンク Mesh（通常 Mesh および InstancedMesh）を検出し、
// 交差結果から対象ブロックのセル座標・中心位置を計算し、アウトラインの位置・スケールを更新します。
function updateBlockSelection() {
    if (document.pointerLockElement !== renderer.domElement) {
        selectionOutlineMesh.visible = false;
        return;
    }

    // グローバル Raycaster を再利用（画面中央から）
    globalRaycaster.setFromCamera(globalCenterVec, camera);

    // loadedChunks と placedCustomBlocks のすべての Mesh で交差判定
    const objectsToTest = [
        ...Object.values(loadedChunks),
        ...Object.values(placedCustomBlocks)
    ];
    const intersections = [];
    for (const obj of objectsToTest) {
        if (obj.isInstancedMesh) {
            obj.raycast(globalRaycaster, intersections);
        } else {
            intersections.push(...globalRaycaster.intersectObject(obj, true));
        }
    }
    intersections.sort((a, b) => a.distance - b.distance);

    const epsilon = 0.001;
    // globalTempVec3 を候補セル位置として再利用
    let cellCandidate = globalTempVec3;
    let found = false;
    for (const inter of intersections) {
        cellCandidate.set(
            Math.floor(inter.point.x - inter.face.normal.x * epsilon),
            Math.floor(inter.point.y - inter.face.normal.y * epsilon),
            Math.floor(inter.point.z - inter.face.normal.z * epsilon)
        );
        const key = `${cellCandidate.x}_${cellCandidate.y}_${cellCandidate.z}`;
        const voxel = voxelModifications.hasOwnProperty(key)
            ? voxelModifications[key]
            : getVoxelAtWorld(cellCandidate.x, cellCandidate.y, cellCandidate.z, globalTerrainCache, true);
        const conf = getBlockConfiguration(voxel);
        if (voxel !== BLOCK_TYPES.SKY && conf.targetblock !== false) {
            found = true;
            break;
        }
    }
    if (!found) {
        const currentHeight = getCurrentPlayerHeight();
        const headY = player.position.y + currentHeight * 0.85;
        cellCandidate.set(
            Math.floor(player.position.x),
            Math.floor(headY),
            Math.floor(player.position.z)
        );
    }

    const key = `${cellCandidate.x}_${cellCandidate.y}_${cellCandidate.z}`;
    const finalVoxel = voxelModifications.hasOwnProperty(key)
        ? voxelModifications[key]
        : getVoxelAtWorld(cellCandidate.x, cellCandidate.y, cellCandidate.z, globalTerrainCache, true);
    const config = getBlockConfiguration(finalVoxel);

    if (finalVoxel === BLOCK_TYPES.SKY) {
        selectionOutlineMesh.visible = false;
        return;
    }

    // globalTempVec3b, globalTempVec3c をそれぞれ中心位置とサイズの計算に再利用
    let center = globalTempVec3b;
    let size = globalTempVec3c;

    if (config) {
        switch (config.geometryType) {
            case "slab":
                center.set(cellCandidate.x + 0.5, cellCandidate.y + 0.25, cellCandidate.z + 0.5);
                size.set(1, 0.5, 1);
                break;
            case "stairs":
                center.set(cellCandidate.x + 0.5, cellCandidate.y + 0.5, cellCandidate.z + 0.5);
                size.set(1, 1, 1);
                break;
            case "cross":
                center.set(cellCandidate.x + 0.5, cellCandidate.y + 0.4, cellCandidate.z + 0.5);
                size.set(0.8, 0.8, 0.8);
                break;
            default:
                center.set(cellCandidate.x + 0.5, cellCandidate.y + 0.5, cellCandidate.z + 0.5);
                size.set(1, 1, 1);
        }
    } else {
        center.set(cellCandidate.x + 0.5, cellCandidate.y + 0.5, cellCandidate.z + 0.5);
        size.set(1, 1, 1);
    }

    if (player.position.distanceTo(center) > BLOCK_INTERACT_RANGE) {
        selectionOutlineMesh.visible = false;
        return;
    }

    selectionOutlineMesh.position.copy(center);
    selectionOutlineMesh.scale.copy(size);
    selectionOutlineMesh.visible = true;
}

/**
 * カーソル（画面中央）で照準している、ブロックとのインタラクト範囲内の情報を
 * 更新し、表示する関数
 */
function updateBlockInfo() {
    globalRaycaster.far = BLOCK_INTERACT_RANGE;
    globalRaycaster.setFromCamera(globalCenterVec, camera);

    const chunkMeshes = Object.values(loadedChunks);
    const intersects = [];
    for (const mesh of chunkMeshes) {
        if (mesh.isInstancedMesh) {
            mesh.raycast(globalRaycaster, intersects);
        } else {
            intersects.push(...globalRaycaster.intersectObject(mesh, true));
        }
    }

    if (intersects.length > 0) {
        const intersect = intersects[0];
        const faceNormal = intersect.face.normal;
        const point = intersect.point;
        // globalTempVec3 を使ってセル座標を計算
        globalTempVec3.set(
            Math.floor(point.x - faceNormal.x * 0.5),
            Math.floor(point.y - faceNormal.y * 0.5),
            Math.floor(point.z - faceNormal.z * 0.5)
        );
        const key = `${globalTempVec3.x}_${globalTempVec3.y}_${globalTempVec3.z}`;
        let blockValue = voxelModifications[key];
        if (blockValue === undefined) {
            blockValue = getVoxelAtWorld(globalTempVec3.x, globalTempVec3.y, globalTempVec3.z);
        }
        const blockName = BLOCK_NAMES[blockValue] || "Unknown";
        const config = getBlockConfiguration(blockValue);
        const additionalInfo = config ? `Type: ${config.geometryType}` : "";
        blockInfoElem.innerHTML = `Block: ${blockName} (Value: ${blockValue})<br>${additionalInfo}`;
        blockInfoElem.style.display = "block";
    } else {
        blockInfoElem.style.display = "none";
    }
}

function updateHeadBlockInfo() {
    // 現在のプレイヤーの高さ取得
    const currentHeight = getCurrentPlayerHeight();
    // 足元から 85% の高さを頭部とする（この割合は必要に応じて調整）
    const headY = player.position.y + currentHeight * 0.85;
    const headPos = new THREE.Vector3(
        player.position.x,
        headY,
        player.position.z
    );

    // ブロック座標を整数化して作成 (例："x_y_z")
    const blockX = Math.floor(headPos.x);
    const blockY = Math.floor(headPos.y);
    const blockZ = Math.floor(headPos.z);
    const headBlockKey = `${blockX}_${blockY}_${blockZ}`;

    // voxelModifications を優先し、なければ getVoxelAtWorld() でブロック値取得
    // ここで ignoreTerrain を true にすることで、地形判定を無視して頭部ブロックを判定します。
    let blockValue = voxelModifications[headBlockKey];
    if (blockValue === undefined) {
        blockValue = getVoxelAtWorld(blockX, blockY, blockZ, globalTerrainCache, true);
    }

    // BLOCK_NAMES からブロック名取得。なければ "Unknown"
    const blockName = BLOCK_NAMES[blockValue] || "Unknown";

    // DOM 要素 (id="headBlockInfo") に結果表示
    const headBlockInfoElem = document.getElementById("headBlockInfo");
    if (headBlockInfoElem) {
        headBlockInfoElem.innerHTML = `Head Block: ${blockName} (Value: ${blockValue})`;
        headBlockInfoElem.style.display = "block";
    }
}


// グローバルなパーティクルプールとアクティブグループの管理
const particlePool = [];
const activeParticleGroups = [];
const geometryCache = new Map();
const GRAVITY = 9.8 * 0.8;

const getCachedParticleGeometry = (i, j, grid, particleSize) => {
    const key = `${grid}_${i}_${j}_${particleSize}`;
    if (geometryCache.has(key)) return geometryCache.get(key);

    const geo = new THREE.PlaneGeometry(particleSize, particleSize);
    geo.center();
    const [uMin, vMin] = [i / grid, j / grid];
    const [uMax, vMax] = [(i + 1) / grid, (j + 1) / grid];
    geo.attributes.uv.array.set([uMin, vMin, uMax, vMin, uMax, vMax, uMin, vMax]);
    geo.attributes.uv.needsUpdate = true;
    geo.__cached = true;
    geometryCache.set(key, geo);
    return geo;
};

const getPooledParticle = () => {
    if (particlePool.length) {
        const p = particlePool.pop();
        p.visible = true;
        return p;
    }
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.__cached = false;
    return new THREE.Mesh(
        geo,
        new THREE.MeshLambertMaterial({
            transparent: true,
            opacity: 1,
            side: THREE.DoubleSide,
        })
    );
};

const releasePooledParticle = p => {
    p.userData = {};
    p.visible = false;
    if (p.parent) p.parent.remove(p);
    if (p.geometry && !p.geometry.__cached) p.geometry.dispose();
    particlePool.push(p);
};

const createMinecraftBreakParticles = (pos, blockType, lifetime = 3.0) => {
    const grid = 4,
        base = 1 / grid,
        particleSize = base * 0.5;
    const group = new THREE.Group();
    activeParticleGroups.push(group);
    const texture = getBlockMaterials(blockType)?.[0]?.map || null;
    const tempOffset = new THREE.Vector3(); // 再利用用 temporary vector
    for (let i = 0; i < grid; i++) {
        for (let j = 0; j < grid; j++) {
            for (let k = 0; k < grid; k++) {
                const particle = getPooledParticle();
                particle.material.map = texture;
                particle.material.needsUpdate = true;
                particle.geometry = getCachedParticleGeometry(i, j, grid, particleSize);
                tempOffset.set(
                    (i + 0.5) / grid - 0.5 + (Math.random() - 0.5) * 0.05,
                    (j + 0.5) / grid - 0.5 + (Math.random() - 0.5) * 0.05,
                    (k + 0.5) / grid - 0.5 + (Math.random() - 0.5) * 0.05
                );
                // particle.position は、座標 pos (clone する必要がある場合のみ)
                particle.position.copy(pos).add(tempOffset);
                particle.userData = {
                    origin: pos.clone(), // 位置は一度 clone して保持
                    velocity: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5),
                    lifetime: 0.2 + Math.random() * (lifetime - 0.2),
                    elapsed: 0
                };
                particle.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
                group.add(particle);
            }
        }
    }
    scene.add(group);
    console.log(`Created particles: ${group.children.length}`);
    return group;
};

const updateBlockParticles = delta => {
    for (let gi = activeParticleGroups.length - 1; gi >= 0; gi--) {
        const group = activeParticleGroups[gi];
        group.updateMatrixWorld();
        for (let pi = group.children.length - 1; pi >= 0; pi--) {
            const particle = group.children[pi],
                ud = particle.userData;
            ud.elapsed += delta;
            particle.position.addScaledVector(ud.velocity, delta);
            ud.velocity.y -= GRAVITY * delta;
            const landY = getTerrainHeight(ud.origin.x, ud.origin.z, particle.position.y);
            if (landY !== -Infinity && particle.position.y < landY) {
                particle.position.y = landY;
                ud.velocity.y = 0;
                ud.velocity.x *= 0.9;
                ud.velocity.z *= 0.9;
            }
            particle.lookAt(camera.position);
            if (ud.elapsed >= ud.lifetime) {
                releasePooledParticle(particle);
                group.remove(particle);
            }
        }
        if (group.children.length === 0) {
            scene.remove(group);
            activeParticleGroups.splice(gi, 1);
        }
    }
};

/**
 * プレイヤーの AABB（当たり判定）の下半身サンプルによる水中判定
 * 下半身の下部5点（中央＋四隅）をサンプリングし、3点以上が水ブロックなら水中と判断する。
 */
function isPlayerEntireBodyInWater() {
    const { min, max } = getPlayerAABB();
    const samplePoints = [];

    // ネストループで8個の隅を生成
    for (let x of [min.x, max.x]) {
        for (let y of [min.y, max.y]) {
            for (let z of [min.z, max.z]) {
                samplePoints.push(new THREE.Vector3(x, y, z));
            }
        }
    }
    // センター点を追加
    samplePoints.push(new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2));

    let waterCount = 0;
    const cellCache = {};

    // 各サンプル点でセル座標を算出し、水ブロックならカウント
    for (const point of samplePoints) {
        const x = Math.floor(point.x),
            y = Math.floor(point.y),
            z = Math.floor(point.z);
        const key = `${x}_${y}_${z}`;

        let blockValue = cellCache[key];
        if (blockValue === undefined) {
            blockValue = voxelModifications[key] || getVoxelAtWorld(x, y, z, globalTerrainCache, true);
            cellCache[key] = blockValue;
        }
        if (blockValue === BLOCK_TYPES.WATER) waterCount++;
    }

    // 全体の10%以上が水なら true を返す
    return waterCount / samplePoints.length >= 0.1;
}
function updateUnderwaterPhysics(delta) {
    const TARGET_SWIM_SPEED = 0.03,
        DASH_MULTIPLIER = 1.0,
        ACCELERATION = 0.1,
        WATER_DRAG = 0.05,
        WATER_GRAVITY = 0.02;

    const effectiveSpeed = dashActive ? TARGET_SWIM_SPEED * DASH_MULTIPLIER : TARGET_SWIM_SPEED;
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const horiz = new THREE.Vector3();
    if (keys["w"] || keys["arrowup"]) horiz.add(forward);
    if (keys["s"] || keys["arrowdown"]) horiz.sub(forward);
    if (keys["d"] || keys["arrowright"]) horiz.add(right);
    if (keys["a"] || keys["arrowleft"]) horiz.sub(right);
    if (horiz.lengthSq() > 0) horiz.normalize().multiplyScalar(effectiveSpeed);
    let vTarget = player.velocity.y;
    if (keys[" "]) {
        vTarget = effectiveSpeed;
    } else if (keys["Shift"]) {
        vTarget = -effectiveSpeed;
    } else {
        vTarget = player.velocity.y - WATER_GRAVITY;
        vTarget = Math.max(vTarget, -effectiveSpeed);
    }
    player.velocity.x = THREE.MathUtils.lerp(player.velocity.x, horiz.x, ACCELERATION);
    player.velocity.z = THREE.MathUtils.lerp(player.velocity.z, horiz.z, ACCELERATION);
    player.velocity.y = THREE.MathUtils.lerp(player.velocity.y, vTarget, ACCELERATION);
    player.velocity.multiplyScalar(1 - WATER_DRAG);
    player.position.addScaledVector(player.velocity, delta);
    resolvePlayerCollision();
}

const clock = new THREE.Clock();
let wasUnderwater = false;

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    updateBlockParticles(delta);

    // FPS更新（1秒毎）
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime > 1000) {
        fpsCounter.innerHTML = `<span>FPS: ${Math.round((frameCount * 1000) / (now - lastFpsTime))}</span><br>
                                <span>version: 0.0.1a</span><br>
                                <span>version name: alpha</span><br>
                                <span>Flight: ${flightMode ? "ON" : "OFF"}</span><br>
                                <span>Dash: ${dashActive ? "ON" : "OFF"}</span><br>
                                <span>Sneak: ${sneakActive ? "ON" : "OFF"}</span><br>
                                <span>Pos: (${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(2)})</span>`;
        frameCount = 0;
        lastFpsTime = now;
    }

    if (!flightMode && keys[" "] && player.onGround && !wasUnderwater) jumpRequest = true;

    camera.rotation.set(pitch, yaw, 0);

    const underwater = isPlayerEntireBodyInWater();
    if (flightMode) updateFlightPhysics(delta);
    else if (underwater) updateUnderwaterPhysics(delta);
    else updateNormalPhysics(delta);
    wasUnderwater = underwater;

    resolvePlayerCollision();
    updateOnGround();
    updateChunks();
    processPendingChunkUpdates();

    const camOffset = flightMode ? getCurrentPlayerHeight() - 0.15 : getCurrentPlayerHeight();
    camera.position.copy(player.position).add(new THREE.Vector3(0, camOffset, 0));

    updateBlockSelection();
    updateBlockInfo();
    updateHeadBlockInfo();

    updateCloudGrid(scene, camera.position);
    updateCloudTiles(delta);
    updateCloudOpacity(camera.position);
    updateScreenOverlay();
    cloudTiles.forEach(tile => adjustCloudLayerDepth(tile, camera));

    if (pendingChunkUpdates.size) processPendingChunkUpdatesBatch(2);

    renderer.render(scene, camera);
}

animate();