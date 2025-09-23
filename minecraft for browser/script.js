// github上のパス
// import * as THREE from 'https://moti5768.github.io/moti.world/minecraft%20for%20browser/build/three.module.js';

import * as THREE from './build/three.module.js';
"use strict";

const touchpad_controls = {
    leftcontrols: document.getElementById("left-controls"),
    rightcontrols: document.getElementById("right-controls")
};

const ua = navigator.userAgent.toLowerCase();
if (ua.includes("mobile")) {
    // Mobile (iPhone、iPad「Chrome、Edge」、Android)
    alert("この端末は対応していません!")
} else if (ua.indexOf("ipad") > -1 || (ua.indexOf("macintosh") > -1 && "ontouchend" in document)) {
    // Mobile (iPad「Safari」)
    alert("この端末は対応していません!")
} else {
    //PC
    touchpad_controls.leftcontrols.style.display = "none";
    touchpad_controls.rightcontrols.style.display = "none";
}

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

function hashXY(x, y) {
    return ((x & 0xffff) << 16) | (y & 0xffff);
}

const pseudoRandom = (x, y) => {
    if (typeof x !== "number" || typeof y !== "number") {
        throw new TypeError("x と y は数値でなければなりません");
    }
    const ix = Math.floor(x), iy = Math.floor(y);
    const key = hashXY(ix, iy);
    if (pseudoRandomCache.has(key)) return pseudoRandomCache.get(key);
    const n = ix + iy * PRIME_MULTIPLIER;
    const s = Math.sin(n) * SIN_MULTIPLIER;
    const result = (s % 1) * SCALE + OFFSET; // s - floor(s) を s % 1 に変更
    pseudoRandomCache.set(key, result);
    return result;
};

const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + t * (b - a);

const smoothNoise2D = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const u = fade(x - x0), v = fade(y - y0);
    const n00 = pseudoRandom(x0, y0), n10 = pseudoRandom(x0 + 1, y0);
    const n01 = pseudoRandom(x0, y0 + 1), n11 = pseudoRandom(x0 + 1, y0 + 1);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
};

const fractalNoiseCache = new Map();
function fractalNoise2D(x, y, octaves = 4, persistence = 0.5) {
    const cacheKey = `${x},${y},${octaves},${persistence}`;
    if (fractalNoiseCache.has(cacheKey)) return fractalNoiseCache.get(cacheKey);
    let total = 0, amplitude = 1, maxValue = 0;
    let fx = x, fy = y;
    for (let i = 0; i < octaves; i++) {
        total += smoothNoise2D(fx, fy) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        fx *= 2;
        fy *= 2;
    }
    const result = total / maxValue;
    fractalNoiseCache.set(cacheKey, result);
    return result;
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

let CHUNK_VISIBLE_DISTANCE = 6;

const COLLISION_MARGIN = 0.005;
const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 1.8;    // 通常時のプレイヤーの身長を1.8ブロックに変更
const SNEAK_HEIGHT = 1.65;    // スニーク時のプレイヤー身長を1.65ブロックに変更

const JUMP_INITIAL_SPEED = 0.199;
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

// ======================================================
// Vector3 / Box3 Object Pool (改良版)
// ======================================================
const _vecPool = [];
const _boxPool = [];
const POOL_MAX = 1024; // プール上限。環境に応じて調整可

// Vector3 プール
function allocVec() {
    return _vecPool.length ? _vecPool.pop() : new THREE.Vector3();
}

function freeVec(v) {
    if (!v) return;
    v.set(0, 0, 0); // 再利用時の初期状態
    if (_vecPool.length < POOL_MAX) _vecPool.push(v);
}

// Box3 プール
function allocBox() {
    const b = _boxPool.length ? _boxPool.pop() : new THREE.Box3();
    b.makeEmpty(); // 常に「空の Box3」として返す
    return b;
}

function freeBox(b) {
    if (!b) return;
    b.makeEmpty();
    if (_boxPool.length < POOL_MAX) _boxPool.push(b);
}

// sweptAABB 用の一時オブジェクト（再利用）
const _sweptTmpEntry = new THREE.Vector3();
const _sweptTmpExit = new THREE.Vector3();

// チャンク更新のバッチ制御（チューニング可）
const CHUNK_UPDATE_BATCH = 4;
const CHUNK_UPDATE_DELAY_MS = 60;

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
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.85);
directionalLight.position.set(10, 20, 10);
scene.add(directionalLight);

/* ======================================================
   【プレイヤーAABB・衝突判定関連】
   ====================================================== */
const half = PLAYER_RADIUS - COLLISION_MARGIN;

function createAABB(pos) {
    const height = getCurrentPlayerHeight();
    let feetPos = pos.clone();

    if (player.positionIsCenter) {
        feetPos.y -= height / 2;
    }

    return new THREE.Box3(
        new THREE.Vector3(feetPos.x - half, feetPos.y, feetPos.z - half),
        new THREE.Vector3(feetPos.x + half, feetPos.y + height, feetPos.z + half)
    );
}

function getPlayerAABB(pos = player.position) {
    return createAABB(pos);
}

function getPlayerAABBAt(pos) {
    return createAABB(pos);
}

function checkAABBCollision(aabb, velocity, dt) {
    // aabb が Box3 でない場合はコピーして Box3 化（参照を壊さない）
    if (!(aabb instanceof THREE.Box3)) {
        aabb = new THREE.Box3(aabb.min.clone(), aabb.max.clone());
    }

    const isDynamic = velocity !== undefined && dt !== undefined;
    const result = isDynamic
        ? { collision: false, time: dt, normal: new THREE.Vector3() }
        : false;

    // 浮動小数点誤差用のマージン
    const startX = Math.floor(aabb.min.x - COLLISION_MARGIN - 1e-5);
    const endX = Math.ceil(aabb.max.x + COLLISION_MARGIN + 1e-5);
    const startY = Math.floor(aabb.min.y - COLLISION_MARGIN - 1e-5);
    const endY = Math.ceil(aabb.max.y + COLLISION_MARGIN + 1e-5);
    const startZ = Math.floor(aabb.min.z - COLLISION_MARGIN - 1e-5);
    const endZ = Math.ceil(aabb.max.z + COLLISION_MARGIN + 1e-5);

    // ローカルキャッシュ（同じ voxelId の block config を繰り返さない）
    const configCache = new Map();

    for (let x = startX; x < endX; x++) {
        for (let y = startY; y < endY; y++) {
            for (let z = startZ; z < endZ; z++) {
                const voxelId = getVoxelAtWorld(x, y, z);
                if (voxelId === BLOCK_TYPES.SKY) continue;

                // config をキャッシュから取得
                let config;
                if (configCache.has(voxelId)) {
                    config = configCache.get(voxelId);
                } else {
                    config = getBlockConfiguration(voxelId);
                    configCache.set(voxelId, config);
                }

                if (!config || config.collision === false) continue;

                // --- ブロック単位で使う Box3 配列（スコープ内で生成） ---
                const boxes = [];

                // カスタムコリジョンがある場合は相対 Box を取得して pooled Box にコピー
                if (typeof config.customCollision === "function") {
                    // tmpVec を渡す（customCollision が引数を取る実装に対応）
                    const tmpVec = allocVec();
                    let relBoxes;
                    try {
                        relBoxes = config.customCollision(tmpVec) || [];
                    } catch (e) {
                        // 万が一エラーなら引数無しで再試行（互換性確保）
                        try { relBoxes = config.customCollision() || []; }
                        catch (ee) { relBoxes = []; }
                    }
                    freeVec(tmpVec);

                    for (let rb of relBoxes) {
                        const pb = allocBox();
                        // rb が THREE.Box3 の場合は copy、オブジェクトの場合は min/max をコピー
                        if (rb instanceof THREE.Box3) {
                            pb.copy(rb);
                        } else if (rb && rb.min && rb.max) {
                            pb.min.copy(rb.min);
                            pb.max.copy(rb.max);
                        } else {
                            // 想定外の形なら 1x1x1 として扱う（保険）
                            pb.min.set(0, 0, 0);
                            pb.max.set(1, 1, 1);
                        }
                        // ワールド座標へオフセット
                        const off = allocVec();
                        off.set(x, y, z);
                        pb.min.add(off);
                        pb.max.add(off);
                        freeVec(off);

                        boxes.push(pb);
                    }
                } else {
                    // 単純な 1x1x1 ブロック
                    const pb = allocBox();
                    const min = allocVec();
                    const max = allocVec();
                    min.set(x, y, z);
                    max.set(x + 1, y + 1, z + 1);
                    pb.min.copy(min);
                    pb.max.copy(max);
                    boxes.push(pb);
                    freeVec(min);
                    freeVec(max);
                }

                // --- boxes を使って判定（early return する場合も先に解放する） ---
                let earlyReturn = false;
                let earlyResult = null;

                for (const box of boxes) {
                    if (isDynamic) {
                        const r = sweptAABB(aabb, velocity, dt, box);
                        if (r.collision && r.time < result.time) {
                            Object.assign(result, r);
                            if (r.time < 1e-5) {
                                earlyResult = { type: 'dynamic', value: result };
                                earlyReturn = true;
                                break;
                            }
                        }
                    } else {
                        if (aabb.intersectsBox(box)) {
                            earlyResult = { type: 'static', value: true };
                            earlyReturn = true;
                            break;
                        }
                    }
                }

                // --- 必ず解放する ---
                for (const box of boxes) freeBox(box);

                // --- earlyReturn の振る舞い（元実装と互換） ---
                if (earlyReturn) {
                    if (earlyResult.type === 'dynamic') return earlyResult.value;
                    return true;
                }

            } // z
        } // y
    } // x

    return result;
}

/* ======================================================
   【地形生成】（フラクタルノイズ＋ユーザー変更反映）
   ====================================================== */
const MAX_SEARCH_DEPTH = 32;

function getTerrainHeight(worldX, worldZ, startY) {
    const xInt = Math.floor(worldX);
    const zInt = Math.floor(worldZ);

    if (startY !== undefined) {
        let y = Math.floor(startY);
        const minY = Math.max(0, y - MAX_SEARCH_DEPTH);
        for (; y >= minY; y--) {
            if (getVoxelAtWorld(xInt, y, zInt) !== BLOCK_TYPES.SKY) return y + 1;
        }
        return -Infinity;
    }

    const key = `${xInt}_${zInt}`;
    if (terrainHeightCache.has(key)) return terrainHeightCache.get(key);

    const baseNoise = fractalNoise2D(worldX * BASE_SCALE, worldZ * BASE_SCALE, 4, 0.5);
    const detailNoise = fractalNoise2D(worldX * DETAIL_SCALE, worldZ * DETAIL_SCALE, 2, 0.5);

    const height = BASE_HEIGHT + baseNoise * MOUNTAIN_AMPLITUDE + detailNoise * DETAIL_AMPLITUDE;
    const result = Math.floor(height);

    if (terrainHeightCache.size >= MAX_CACHE_SIZE) {
        const firstKey = terrainHeightCache.keys().next().value;
        terrainHeightCache.delete(firstKey);
    }
    terrainHeightCache.set(key, result);

    return result;
}

const globalTerrainCache = new Map();
const blockCollisionCache = new Map();
const voxelKeyFor = (x, y, z) => `${x}_${y}_${z}`;
const terrainKeyHash = (x, z) => ((x & 0xFFFF) << 16) | (z & 0xFFFF);
const BEDROCK_LEVEL = 0;
const BLOCK_CONFIG_BY_ID = new Map(Object.values(BLOCK_CONFIG).map(c => [c.id, c]));

function getBlockConfigById(id) {
    return BLOCK_CONFIG_BY_ID.get(id) || null;
}

const { SKY, WATER, GRASS, DIRT, STONE, BEDROCK } = BLOCK_TYPES;

function getVoxelAtWorld(x, y, z, terrainCache = globalTerrainCache, { raw = false } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new TypeError("worldX, y, worldZ must be valid numbers.");
    }
    if (y < 0) return SKY;

    const modKey = voxelKeyFor(x, y, z);
    const hasMod = Object.prototype.hasOwnProperty.call(voxelModifications, modKey);

    if (hasMod) {
        const id = voxelModifications[modKey];
        if (!raw) {
            if (!raw) {
                if (!blockCollisionCache.has(id)) {
                    blockCollisionCache.set(id, !!getBlockConfigById(id)?.collision);
                }
                if (!blockCollisionCache.get(id)) return SKY;
            }
        }
        return id;
    }

    const tKey = terrainKeyHash(x, z);
    let h = terrainCache.get(tKey);
    if (h === undefined) {
        h = getTerrainHeight(x, z);
        terrainCache.set(tKey, h);
    }

    if (y > h) {
        return (y >= 20 && y <= 45) ? WATER : SKY;
    } else if (y >= h - 2) {
        return y === h && h > 44 ? GRASS : DIRT;
    } else {
        return y > BEDROCK_LEVEL ? STONE : BEDROCK;
    }
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
        [0, 0, 0], [0.2, 0, 0], [-0.2, 0, 0],
        [0, 0, 0.2], [0, 0, -0.2], [0, 0.1, 0], [0, -0.1, 0]
    ];
    const counts = {};
    for (let i = 0; i < offsets.length; i++) {
        const o = offsets[i];
        const bx = Math.floor(headPos.x + o[0]);
        const by = Math.floor(headPos.y + o[1]);
        const bz = Math.floor(headPos.z + o[2]);
        const id = getVoxelAtWorld(bx, by, bz, globalTerrainCache, { raw: true });
        counts[id] = (counts[id] || 0) + 1;
    }
    let chosenID = BLOCK_TYPES.SKY, maxCount = 0;
    for (const id in counts) {
        const c = counts[id];
        if (c > maxCount) {
            maxCount = c;
            chosenID = +id;
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
    const headY = player.position.y + getCurrentPlayerHeight() * 0.85;
    const headPos = new THREE.Vector3(player.position.x, headY, player.position.z);
    const voxelID = getPreciseHeadBlockType(headPos);
    const config = getBlockConfiguration(voxelID);
    const el = document.getElementById("screenOverlayHtml");
    const texturePath = config?.screenFill && (config.textures.top || config.textures.all);
    if (!texturePath) {
        el.style.display = "none";
        return;
    }
    el.style.opacity = voxelID === BLOCK_TYPES.WATER ? "0.8" : "1";
    el.style.backgroundImage = `url(${texturePath})`;
    el.style.display = "block";
}

/* ======================================================
   【Swept AABB 衝突検出】
   ====================================================== */
function sweptAABB(movingBox, velocity, dt, staticBox) {
    // entry/exit を再利用（new を避ける）
    const entry = _sweptTmpEntry; entry.set(0, 0, 0);
    const exit = _sweptTmpExit; exit.set(0, 0, 0);

    // X
    if (velocity.x > 0) {
        entry.x = (staticBox.min.x - movingBox.max.x) / velocity.x;
        exit.x = (staticBox.max.x - movingBox.min.x) / velocity.x;
    } else if (velocity.x < 0) {
        entry.x = (staticBox.max.x - movingBox.min.x) / velocity.x;
        exit.x = (staticBox.min.x - movingBox.max.x) / velocity.x;
    } else {
        entry.x = -Infinity; exit.x = Infinity;
    }

    // Y
    if (velocity.y > 0) {
        entry.y = (staticBox.min.y - movingBox.max.y) / velocity.y;
        exit.y = (staticBox.max.y - movingBox.min.y) / velocity.y;
    } else if (velocity.y < 0) {
        entry.y = (staticBox.max.y - movingBox.min.y) / velocity.y;
        exit.y = (staticBox.min.y - movingBox.max.y) / velocity.y;
    } else {
        entry.y = -Infinity; exit.y = Infinity;
    }

    // Z
    if (velocity.z > 0) {
        entry.z = (staticBox.min.z - movingBox.max.z) / velocity.z;
        exit.z = (staticBox.max.z - movingBox.min.z) / velocity.z;
    } else if (velocity.z < 0) {
        entry.z = (staticBox.max.z - movingBox.min.z) / velocity.z;
        exit.z = (staticBox.min.z - movingBox.max.z) / velocity.z;
    } else {
        entry.z = -Infinity; exit.z = Infinity;
    }

    const entryTime = Math.max(entry.x, entry.y, entry.z);
    const exitTime = Math.min(exit.x, exit.y, exit.z);

    if (entryTime > exitTime || (entry.x < 0 && entry.y < 0 && entry.z < 0) || entry.x > dt || entry.y > dt || entry.z > dt) {
        return { collision: false };
    }

    // 法線は従来どおり new する（呼び出し側で多用されている場合はさらに再利用化可能）
    let normal = new THREE.Vector3();
    if (entryTime === entry.x) normal.set((velocity.x > 0) ? -1 : 1, 0, 0);
    else if (entryTime === entry.y) normal.set(0, (velocity.y > 0) ? -1 : 1, 0);
    else normal.set(0, 0, (velocity.z > 0) ? -1 : 1);

    return { collision: true, time: Math.max(0, entryTime), normal };
}


/* ======================================================
【衝突解消（軸別：水平・垂直）】（安全移動調整）
※ Y 軸の衝突解決部分をバイナリサーチで補正するよう変更
====================================================== */

// 新しい垂直方向の衝突解決関数（バイナリサーチによる安全位置算出）
function resolveVerticalCollision(origY, candidateY, newX, newZ) {
    let safeY = origY;
    const testPos = allocVec(); // ← Vector3 をプールから取得
    for (let i = 0; i < 10; i++) {
        const mid = (origY + candidateY) / 2;
        testPos.set(newX, mid, newZ);
        if (checkAABBCollision(getPlayerAABBAt(testPos))) {
            candidateY = mid;
        } else {
            safeY = mid;
            origY = mid;
        }
    }
    freeVec(testPos); // ← 使用後に返却
    return safeY;
}

/**
 * プレイヤーの脱出処理（アンストック処理）
 * 通常の軸別衝突解決後に、依然としてプレイヤーのAABBが衝突している場合、
 * 複数の方向を試して最小の移動量でプレイヤーを重なり状態から解放します。
 */
function resolvePlayerCollision() {
    axisSeparatedCollisionResolve(dt);

    const aabb = getPlayerAABB();
    if (!checkAABBCollision(aabb)) return;

    const directions = [];
    for (let i = 0; i < 16; i++) {
        const angle = i * Math.PI / 8;
        directions.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
    }
    directions.push(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0));

    let bestDir = null;
    let bestDist = Infinity;
    const tempVec = new THREE.Vector3();

    for (const dir of directions) {
        let low = 0, high = 1.0;
        let foundDist = null;
        for (let i = 0; i < 10; i++) {
            const mid = (low + high) / 2;
            tempVec.copy(player.position).addScaledVector(dir, mid);
            if (checkAABBCollision(getPlayerAABBAt(tempVec))) {
                low = mid;
            } else {
                foundDist = mid;
                high = mid;
            }
        }
        if (foundDist !== null && foundDist < bestDist) {
            bestDist = foundDist;
            bestDir = dir;
        }
    }

    if (bestDir) {
        player.position.addScaledVector(bestDir, bestDist);
    } else {
        player.position.y += 0.1;
    }
}

function axisSeparatedCollisionResolve(dt) {
    const orig = player.position;
    const vel = player.velocity;
    const newPos = orig.clone();

    const halfWidth = PLAYER_RADIUS - COLLISION_MARGIN;
    const margin = 0.02;
    const isOnGround = player.onGround;

    // --- X軸移動 ---
    const x = orig.x + vel.x * dt;
    if (!checkAABBCollision(getPlayerAABBAt(new THREE.Vector3(x, orig.y, orig.z)))) {
        const canDescendX = !canDescendFromSupport(x, orig.z, halfWidth, margin);
        // 空中では移動制限しない
        if (!sneakActive || !isOnGround || !canDescendX) {
            newPos.x = x;
        }
    }

    // --- Z軸移動 ---
    const z = orig.z + vel.z * dt;
    if (!checkAABBCollision(getPlayerAABBAt(new THREE.Vector3(newPos.x, orig.y, z)))) {
        const canDescendZ = !canDescendFromSupport(newPos.x, z, halfWidth, margin);
        if (!sneakActive || !isOnGround || !canDescendZ) {
            newPos.z = z;
        }
    }

    // --- Y軸移動 ---
    let y = orig.y + vel.y * dt;
    const posY = new THREE.Vector3(newPos.x, y, newPos.z);

    if (sneakActive && !flightMode && vel.y < 0) {
        const canDescendY = !canDescendFromSupport(newPos.x, newPos.z, halfWidth, margin);
        if (isOnGround && !canDescendY) {
            y = orig.y;
            vel.y = 0;
        }
    } else if (checkAABBCollision(getPlayerAABBAt(posY))) {
        y = resolveVerticalCollision(orig.y, y, newPos.x, newPos.z);
        vel.y = 0;
    }

    newPos.y = y;
    player.position.copy(newPos);
}

/**
 * 足元4隅に支えがあるか判定。
 * 高さ差が小さい場合は支えとみなし、降りられない。
 * 高さ差が十分あれば降りられる（ジャンプ後や段差中央でも動ける）。
 */
function canDescendFromSupport(centerX, centerZ, halfWidth, margin) {
    const footY = player.position.y;
    const offsets = [
        [halfWidth - margin, halfWidth - margin],
        [-halfWidth + margin, halfWidth - margin],
        [halfWidth - margin, -halfWidth + margin],
        [-halfWidth + margin, -halfWidth + margin],
    ];

    for (const [ox, oz] of offsets) {
        const checkX = centerX + ox;
        const checkZ = centerZ + oz;
        const blockX = Math.floor(checkX);
        const blockZ = Math.floor(checkZ);

        // 足元ブロックのみをチェック
        const blockY = Math.floor(footY - 0.01);

        const voxel = getVoxelAtWorld(blockX, blockY, blockZ, globalTerrainCache, { raw: true });
        if (voxel === 0) continue;

        const config = getBlockConfiguration(voxel);
        if (!config) continue;

        // 支え判定は collision:true のブロックのみ
        if (config.collision === true) {
            const blockHeight = getBlockHeight(voxel);
            const blockTopY = blockY + blockHeight;

            // 足元ギリギリでも支えありとする
            if (blockTopY - footY > -0.01) {
                return true; // 支えあり → スニークで停止
            }
        }
    }

    return false; // 支えなし → 降りられる
}

/**
 * ブロックIDから高さを返す（フルブロック、ハーフブロック、階段対応）
 */
function getBlockHeight(id) {
    const config = getBlockConfiguration(id);
    if (!config) return 1.0;         // 設定なしならデフォルト 1.0
    // height が定義されていればそれを返す
    // 未定義なら標準 1.0
    return (typeof config.height === "number") ? config.height : 1.0;
}

/* ======================================================
   【物理更新：通常モード用】（重力・ジャンプ・水平慣性）
   ====================================================== */
function getDesiredHorizontalVelocity(multiplier = 1) {
    const forward = allocVec();
    camera.getWorldDirection(forward);
    forward.y = 0; forward.normalize();

    const right = allocVec();
    right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    const desired = allocVec();
    if (keys["w"] || keys["arrowup"]) desired.add(forward);
    if (keys["s"] || keys["arrowdown"]) desired.add(forward.clone().negate());
    if (keys["a"] || keys["arrowleft"]) desired.add(right.clone().negate());
    if (keys["d"] || keys["arrowright"]) desired.add(right);

    if (desired.length() > 0) desired.normalize().multiplyScalar(multiplier);

    freeVec(forward); freeVec(right);
    return desired;
}

function updateNormalPhysics() {
    // 歩行モードの速度計算
    let speed = dashActive ? normalDashMultiplier : playerSpeed();

    // スニーク時は歩行速度を低下させる
    if (sneakActive) {
        speed *= 0.3;
    }

    const desiredVel = getDesiredHorizontalVelocity(speed);

    player.velocity.x = THREE.MathUtils.lerp(player.velocity.x, desiredVel.x, 0.1);
    player.velocity.z = THREE.MathUtils.lerp(player.velocity.z, desiredVel.z, 0.1);

    freeVec(desiredVel);

    // 垂直方向は元のコードそのまま
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
    // 飛行モードはスニークで速度変更しない
    const speed = dashActive ? flightDashMultiplier : playerSpeed();

    const desiredVel = getDesiredHorizontalVelocity(speed);

    player.velocity.x = THREE.MathUtils.lerp(player.velocity.x, desiredVel.x, 0.1);
    player.velocity.z = THREE.MathUtils.lerp(player.velocity.z, desiredVel.z, 0.1);

    let targetVertical = 0;
    if (keys[" "] || keys["spacebar"]) {
        targetVertical = flightSpeed;
    } else if (keys["shift"] && flightMode) {
        targetVertical = -flightSpeed;
    }
    player.velocity.y = THREE.MathUtils.lerp(player.velocity.y, targetVertical, 0.1);

    freeVec(desiredVel);
}

/* ======================================================
   【onGround 判定】
   ====================================================== */
function updateOnGround() {
    const testPos = allocVec();
    try {
        testPos.set(player.position.x, player.position.y - 0.05, player.position.z);
        const testAABB = getPlayerAABBAt(testPos);
        player.onGround = checkAABBCollision(testAABB);
    } finally {
        freeVec(testPos);
    }
}

// 各面の定義：法線と面を構成する 4 つの頂点を定義
/* ======================================================
   【チャンク生成】
   ====================================================== */

// 各面の定義：法線と面を構成する 4 つの頂点を定義
const faceData = {
    px: { normal: [1, 0, 0], bit: 0, vertices: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
    nx: { normal: [-1, 0, 0], bit: 1, vertices: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
    py: { normal: [0, 1, 0], bit: 2, vertices: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    ny: { normal: [0, -1, 0], bit: 3, vertices: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    pz: { normal: [0, 0, 1], bit: 4, vertices: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    nz: { normal: [0, 0, -1], bit: 5, vertices: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }
};

// neighbors 配列の順番は faceData bit 順に対応
const neighbors = [
    { dx: 1, dy: 0, dz: 0 },  // px
    { dx: -1, dy: 0, dz: 0 }, // nx
    { dx: 0, dy: 1, dz: 0 },  // py
    { dx: 0, dy: -1, dz: 0 }, // ny
    { dx: 0, dy: 0, dz: 1 },  // pz
    { dx: 0, dy: 0, dz: -1 }  // nz
];

const faceToMaterialIndex = {
    "px": 0,  // 右面（BoxGeometry の順番：右, 左, 上, 下, 前, 後）
    "nx": 1,  // 左面
    "py": 2,  // 上面
    "ny": 3,  // 下面
    "pz": 4,  // 前面
    "nz": 5   // 後面
};

// ========= ヘルパー関数 =========

// (voxelModifications はユーザーによるブロック変更情報のオブジェクト)
// ※ 既存の getVoxelAtWorld, getTerrainHeight, voxelModifications, faceData, addFace などはそのまま利用する前提です。

// ユーザー変更があった列をマークする（ブロックの設置／破壊時に適切に呼ぶ）
const columnModifications = {}; // キー: "wx_wz", 値: { maxModifiedY, blocks: [] }

function markColumnModified(wx, wz, modY) {
    const key = `${wx}_${wz}`;
    const col = columnModifications[key] ??= { maxModifiedY: modY, blocks: [] };
    col.maxModifiedY = Math.max(col.maxModifiedY, modY);
}

function disposeMesh(mesh) {
    mesh.traverse(obj => {
        if (obj.isMesh) {
            obj.geometry?.dispose();
            (Array.isArray(obj.material) ? obj.material : [obj.material])
                .forEach(mat => mat?.dispose());
        }
    });
}

function refreshChunkAt(cx, cz) {
    const key = `${cx}_${cz}`;
    const oldChunk = loadedChunks[key];
    if (!oldChunk) return;
    console.info("チャンク再生成（全更新）:", key);
    disposeMesh(oldChunk);
    scene.remove(oldChunk);
    const newChunk = generateChunkMeshMultiTexture(cx, cz);
    newChunk.userData.fadedIn = true;
    setOpacityRecursive(newChunk, 1);
    scene.add(newChunk);
    loadedChunks[key] = newChunk;
    clearCaches();
}

const BIGINT_OFFSET = 2_000_000n; // ±1,875,000 + 安全マージン

function encodeChunkKey(cx, cz) {
    return (BigInt(cx) + BIGINT_OFFSET) << 32n | ((BigInt(cz) + BIGINT_OFFSET) & 0xffffffffn);
}

function decodeChunkKey(key) {
    return [
        Number((key >> 32n) - BIGINT_OFFSET),
        Number((key & 0xffffffffn) - BIGINT_OFFSET)
    ];
}

// ───────────────────────────────
// 更新要求用のバッチセットと処理
// ───────────────────────────────

// pendingChunkUpdates は BigInt 値を保持する Set
let pendingChunkUpdates = new Set();
let chunkUpdateTimer = null;

/**
 * 指定チャンク (cx, cz) の更新要求を pendingChunkUpdates に追加する関数
 * @param {number} cx - チャンク X 座標
 * @param {number} cz - チャンク Z 座標
 */
let chunkUpdateQueue = [];

// 更新要求: キューに追加
function requestChunkUpdate(cx, cz) {
    const key = `${cx}_${cz}`;
    if (!chunkUpdateQueue.find(([x, z]) => x === cx && z === cz)) {
        chunkUpdateQueue.push([cx, cz]);
    }
}

/**
 * 保留中のチャンク更新要求を処理する関数
 * 集められたキーをデコードして、各チャンクに対して refreshChunkAt を呼び出す
 */
// バッチ処理（batchSize = 2 がデフォルト）
function processPendingChunkUpdates(batchSize = 2) {
    if (pendingChunkUpdates.size === 0) return;

    let processed = 0;
    while (pendingChunkUpdates.size > 0 && processed < batchSize) {
        // Set.values().next() で安全に取り出す
        const key = pendingChunkUpdates.values().next().value;
        if (!key) break;

        const [cx, cz] = decodeChunkKey(key);

        // 実際のチャンク更新呼び出し
        if (typeof refreshChunkAt === "function") {
            refreshChunkAt(cx, cz);
        } else if (typeof requestChunkUpdate === "function") {
            requestChunkUpdate(cx, cz);
        } else {
            console.warn("チャンク更新関数が見つかりません:", cx, cz);
        }

        pendingChunkUpdates.delete(key);
        processed++;
    }

    // 残っている場合は再スケジュール
    if (pendingChunkUpdates.size > 0) {
        scheduleChunkUpdate();
    }
}

// タイマー予約
function scheduleChunkUpdate() {
    // 既にタイマーがある場合はスキップ
    if (chunkUpdateTimer) return;

    chunkUpdateTimer = setTimeout(() => {
        // デフォルトバッチサイズで処理
        processPendingChunkUpdates();
        chunkUpdateTimer = null;
    }, CHUNK_UPDATE_DELAY_MS);
}

/* ======================================================
   【チャンクの管理】
   ====================================================== */
// グローバル変数
const loadedChunks = {}; // 現在シーンに配置中のチャンク（キーは "cx_cz"）
const chunkPool = [];    // 使い回し可能なチャンクメッシュのプール
let chunkQueue = [];   // 新規チャンク生成用のキュー

/**
 * フェードインアニメーションを Mesh に適用する関数
 * @param {THREE.Mesh} object - 対象メッシュ
 * @param {number} duration - フェードインにかける時間（ミリ秒）
 * @param {Function} onComplete - アニメーション完了時コールバック
 */
function fadeInMesh(object, duration = 500, onComplete) {
    if (object.userData.fadedIn) return onComplete?.();

    const materials = [];
    object.traverse(o => {
        if (!o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(mat => {
            if (!mat) return;
            materials.push({
                mat,
                originalTransparent: mat.transparent,
                originalDepthWrite: mat.depthWrite
            });
            mat.opacity = 0;
            mat.transparent = true;
            mat.depthWrite = true; // ←奥行きを正しくする
            mat.needsUpdate = true;
        });
    });

    const start = performance.now();

    (function animate() {
        const t = Math.min((performance.now() - start) / duration, 1);
        materials.forEach(({ mat }) => {
            mat.opacity = t; // opacityだけ変更
        });

        if (t < 1) {
            requestAnimationFrame(animate);
        } else {
            materials.forEach(({ mat, originalTransparent, originalDepthWrite }) => {
                mat.opacity = 1;
                mat.transparent = originalTransparent;
                mat.depthWrite = originalDepthWrite;
                mat.needsUpdate = true;
            });
            object.userData.fadedIn = true;
            onComplete?.();
        }
    })();
}


/**
 * 透明度を再帰的に設定する関数
 * @param {THREE.Object3D} root - 対象オブジェクトのルート
 * @param {number} opacity - 透明度 (0〜1)
 */
const setOpacityRecursive = (root, opacity) => {
    const clamped = Math.min(Math.max(opacity, 0), 1);
    const isTransparent = clamped < 1;
    root.traverse(child => {
        const matList = child.material
            ? (Array.isArray(child.material) ? child.material : [child.material])
            : null;
        if (!matList || (isTransparent && !child.userData?.transparentBlock)) return;

        matList.forEach(mat => {
            if (!mat) return;
            const needUpdate =
                mat.opacity !== clamped ||
                mat.transparent !== (isTransparent || mat.transparent) ||
                mat.depthWrite !== !isTransparent;
            if (!needUpdate) return;

            mat.opacity = clamped;
            mat.transparent = isTransparent || mat.transparent;
            mat.depthWrite = !isTransparent;
            mat.needsUpdate = true;
        });
    });
};

/**
 * チャンクメッシュをプールに返して再利用する関数
 * @param {THREE.Mesh} mesh 
 */
function releaseChunkMesh(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);

    // 中身だけ破棄
    mesh.traverse(obj => {
        if (!obj.isMesh) return;
        if (obj.geometry) {
            obj.geometry.dispose();
            obj.geometry = null;
        }
        if (Array.isArray(obj.material)) {
            for (const m of obj.material) if (m) m.dispose();
        } else if (obj.material) {
            obj.material.dispose();
        }
        obj.material = null;
    });

    // メッシュの Transform 等は残したままプールに返す
    chunkPool.push(mesh);
}

/**
 * 1件のチャンクを生成する関数
 */
function generateNextChunk() {
    const chunkInfo = chunkQueue[0];
    if (!chunkInfo) return false;
    const { cx, cz } = chunkInfo;
    const key = `${cx}_${cz}`;
    if (loadedChunks[key]) {
        chunkQueue.shift(); // 存在する場合は削除だけ
        return true;
    }

    chunkQueue.shift(); // 実際に生成する場合のみ削除
    const mesh = generateChunkMeshMultiTexture(cx, cz);
    mesh.userData.fadedIn = false;
    setOpacityRecursive(mesh, 0);
    scene.add(mesh);
    loadedChunks[key] = mesh;
    fadeInMesh(mesh, 500, () => mesh.userData.fadedIn = true);
    return true;
}

// ---------------------------------------------------------------------------
// mergeBufferGeometries: 複数の BufferGeometry を統合する関数（vertex color属性もマージ）
// ---------------------------------------------------------------------------
/**
 * 複数の BufferGeometry をマージして１つのジオメトリを生成する（マテリアルグループ対応）
 * パフォーマンス重視、属性構成は最初のジオメトリに準拠
 * @param {THREE.BufferGeometry[]} geometries 
 * @param {object} options - 例: { computeNormals: true }
 * @returns {THREE.BufferGeometry | null}
 */
function mergeBufferGeometries(geometries, { computeNormals = true } = {}) {
    if (!geometries || geometries.length === 0) return null;
    if (geometries.length === 1) return geometries[0];

    const first = geometries[0];
    const hasNormal = first.hasAttribute && first.hasAttribute('normal');
    const hasUV = first.hasAttribute && first.hasAttribute('uv');
    const hasColor = first.hasAttribute && first.hasAttribute('color');

    // 合計頂点数／インデックス数を算出
    let vertexCount = 0, indexCount = 0;
    for (const g of geometries) {
        const p = g.getAttribute && g.getAttribute('position');
        if (!p) continue; // position がないジオメトリは無視（元実装に合わせる）
        vertexCount += p.count;
        indexCount += g.index ? g.index.count : p.count;
    }

    if (vertexCount === 0) return null;

    // インデックス配列型は総頂点数／総インデックス数に基づいて選択
    const needUint32 = (vertexCount > 65535) || (indexCount > 65535);
    const IndexArray = needUint32 ? Uint32Array : Uint16Array;

    // 結果バッファ（必要分だけ確保）
    const posArray = new Float32Array(vertexCount * 3);
    const normArray = hasNormal ? new Float32Array(vertexCount * 3) : null;
    const uvArray = hasUV ? new Float32Array(vertexCount * 2) : null;
    const colorArray = hasColor ? new Float32Array(vertexCount * 3) : null;
    const indexArray = new IndexArray(indexCount);

    // ゼロ配列はループ内で new しないよう一つだけ作って使い回す
    const zeroNormal = hasNormal ? new Float32Array([0, 0, 0]) : null;
    const zeroUV = hasUV ? new Float32Array([0, 0]) : null;
    const zeroColor = hasColor ? new Float32Array([0, 0, 0]) : null;

    // オフセット変数
    let posOff = 0, normOff = 0, uvOff = 0, colorOff = 0, idxOff = 0, vertOff = 0;
    const groups = [];

    // helper: srcAttr があれば srcAttr.array をコピー、なければ zeroArr を count 回コピーする
    const fillArray = (dest, srcAttr, offset, count, stride, zeroArr) => {
        if (!dest) return offset;
        if (srcAttr && srcAttr.array) {
            dest.set(srcAttr.array, offset);
            return offset + srcAttr.array.length;
        }
        // zeroArr をまとめてコピー
        const totalLen = count * stride;
        for (let i = 0; i < totalLen; i += stride) {
            dest.set(zeroArr, offset + i);
        }
        return offset + totalLen;
    };

    for (const g of geometries) {
        const p = g.getAttribute('position');
        if (!p) continue; // safety
        const n = hasNormal ? g.getAttribute('normal') : null;
        const uv = hasUV ? g.getAttribute('uv') : null;
        const c = hasColor ? g.getAttribute('color') : null;
        const count = p.count;

        // positions は必ず存在すると仮定して一括コピー
        posArray.set(p.array, posOff);
        posOff += p.array.length; // p.array.length === count * 3

        // 他属性は存在しなければ zero を埋める
        if (hasNormal) normOff = fillArray(normArray, n, normOff, count, 3, zeroNormal);
        if (hasUV) uvOff = fillArray(uvArray, uv, uvOff, count, 2, zeroUV);
        if (hasColor) colorOff = fillArray(colorArray, c, colorOff, count, 3, zeroColor);

        // indices: src に index があれば加算してコピー、無ければ連番
        const idx = g.index ? g.index.array : null;
        if (idx) {
            for (let j = 0; j < idx.length; j++) {
                indexArray[idxOff++] = idx[j] + vertOff;
            }
        } else {
            for (let j = 0; j < count; j++) {
                indexArray[idxOff++] = vertOff + j;
            }
        }

        // groups の構成（start は indexArray 上の位置）
        const base = idxOff - (g.index ? g.index.count : count);
        if (g.groups && g.groups.length) {
            for (const gr of g.groups) {
                groups.push({ start: base + gr.start, count: gr.count, materialIndex: gr.materialIndex });
            }
        } else {
            groups.push({ start: base, count: (g.index ? g.index.count : count), materialIndex: 0 });
        }

        vertOff += count;
    }

    // 結果ジオメトリを構築
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    if (hasNormal) merged.setAttribute('normal', new THREE.BufferAttribute(normArray, 3));
    if (hasUV) merged.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
    if (hasColor) merged.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    merged.setIndex(new THREE.BufferAttribute(indexArray, 1));

    // groups を追加
    for (const gr of groups) merged.addGroup(gr.start, gr.count, gr.materialIndex);

    // 必要なら法線計算（元の挙動に合わせる）
    if (computeNormals && !hasNormal) merged.computeVertexNormals();
    return merged;
}

// ---------------------------------------------------------------------------
// getCachedFaceGeometry: faceKey に対応するクワッドジオメトリをキャッシュして返す
// ---------------------------------------------------------------------------
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

const geometryCache = new Map();
function getCachedGeometry(key, createFunc) {
    if (!geometryCache.has(key)) {
        geometryCache.set(key, createFunc());
    }
    return geometryCache.get(key);
}
function getCachedFaceGeometry(faceKey) {
    if (!faceData[faceKey]) {
        console.warn(`Invalid faceKey: ${faceKey}`);
        return null;
    }
    return getCachedGeometry(`face_${faceKey}`, () => createFaceGeometry(faceData[faceKey]));
}

// 追加
function detectFaceDirection(geometry, group) {
    const normals = geometry.getAttribute('normal').array;
    const idx0 = geometry.index.array[group.start] * 3;
    const nx = normals[idx0], ny = normals[idx0 + 1], nz = normals[idx0 + 2];
    const abs = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
    const max = Math.max(...abs);
    if (max === abs[0]) return nx > 0 ? 0 : 1;
    if (max === abs[1]) return ny > 0 ? 2 : 3;
    return nz > 0 ? 4 : 5;
}// 追加
function extractGroupGeometry(src, group, dst) {
    const oldIdxArr = src.index.array.slice(group.start, group.start + group.count);
    const indexMap = new Map(), newIdxArr = [], attrNames = ['position', 'normal', 'uv'];
    let nextIdx = 0;
    // インデックス再マッピング
    for (const oldIdx of oldIdxArr) {
        if (!indexMap.has(oldIdx)) indexMap.set(oldIdx, nextIdx++);
        newIdxArr.push(indexMap.get(oldIdx));
    }
    dst.setIndex(newIdxArr);
    // 属性コピー
    for (const name of attrNames) {
        const srcAttr = src.getAttribute(name);
        if (!srcAttr) continue;
        const itemSize = srcAttr.itemSize;
        const array = new Float32Array(nextIdx * itemSize);
        for (const [oldIdx, newIdx] of indexMap.entries()) {
            const offOld = oldIdx * itemSize, offNew = newIdx * itemSize;
            for (let k = 0; k < itemSize; k++) {
                array[offNew + k] = srcAttr.array[offOld + k];
            }
        }
        dst.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
    }
}

// ビットマスクによる可視判定
const neighborsLen = neighbors.length;
function computeVisibilityMask(getN, curType, curTransp, curCustom) {
    let mask = 0;
    for (let i = 0; i < neighborsLen; i++) {
        const t = getN(i);
        if (!t || t === BLOCK_TYPES.SKY) {
            mask |= 1 << i;
            continue;
        }
        const c = getBlockConfiguration(t);
        if (c && ((c.transparent && (!curTransp || t !== curType)) || (c.customGeometry && !curCustom)))
            mask |= 1 << i;
    }
    return mask;
}

// --- キャッシュ ---
const blockConfigCache = new Map();
const configCache = new Map();
const subterraneanAreaCache = new Map();
const topShadowCache = new Map();
const sideShadowCache = new Map();

// --- キャッシュクリア関数 ---
const clearCaches = () => {
    blockConfigCache.clear();
    configCache.clear();
    subterraneanAreaCache.clear();
    clearShadowCaches();
};

function clearShadowCaches() {
    ceilingCache.clear();
    topShadowCache.clear();
    sideShadowCache.clear();
}
// --- ブロック設定キャッシュ ---
const getConfig = id => {
    if (!blockConfigCache.has(id)) blockConfigCache.set(id, getBlockConfiguration(id));
    return blockConfigCache.get(id);
};

const getConfigCached = id => {
    if (!configCache.has(id)) configCache.set(id, getConfig(id));
    return configCache.get(id);
};
// --- 地下判定 ---
const subterraneanKeyHash = (wx, wy, wz) => `${wx}_${wy}_${wz}`;

function isInSubterraneanArea(wx, wy, wz) {
    const key = subterraneanKeyHash(wx, wy, wz);
    if (subterraneanAreaCache.has(key)) return subterraneanAreaCache.get(key);

    const maxY = BEDROCK_LEVEL + CHUNK_HEIGHT;
    for (let y = wy + 1; y < maxY; y++) {
        const id = getVoxelAtWorld(wx, y, wz);
        if (id && id !== BLOCK_TYPES.SKY) {
            const cfg = getConfigCached(id);
            if (cfg && !cfg.transparent) {
                subterraneanAreaCache.set(key, true);
                return true;
            }
        }
    }
    subterraneanAreaCache.set(key, false);
    return false;
}
// --- 不透明判定（カスタム形状対応） ---
function isFaceOpaque(id, worldPos = null) {
    if (!id || id === BLOCK_TYPES.SKY) return false;
    const cfg = getConfigCached(id);
    if (!cfg || cfg.transparent) return false;

    if (typeof cfg.customCollision === "function" && worldPos) {
        const boxes = cfg.customCollision(worldPos);
        return boxes && boxes.some(box => box.max.y - box.min.y > 0.01);
    }

    return true; // 通常ブロックは不透明
}
// --- 下の影 ---
// 共通の天井チェック関数
const ceilingCache = new Map();

// 天井チェック（キャッシュ付き）
function hasCeilingAbove(wx, wy, wz) {
    const key = `${wx}_${wz}`;
    if (ceilingCache.has(key)) return ceilingCache.get(key);

    const maxY = BEDROCK_LEVEL + CHUNK_HEIGHT;
    for (let y = wy + 1; y < maxY; y++) {
        const id = getVoxelAtWorld(wx, y, wz);
        if (id && id !== BLOCK_TYPES.SKY) {
            const cfg = getConfigCached(id);
            if (cfg && !cfg.transparent) {
                ceilingCache.set(key, true);
                return true;
            }
        }
    }

    ceilingCache.set(key, false);
    return false;
}

// キャッシュ付き computeBottomShadowFactor
function computeBottomShadowFactor(wx, wy, wz) {
    const id = getVoxelAtWorld(wx, wy, wz);
    const cfg = getConfigCached(id);

    if (cfg && cfg.transparent) {
        return hasCeilingAbove(wx, wy, wz) ? 0.4 : 1.0;
    }

    if (isInSubterraneanArea(wx, wy, wz)) return 0.4;

    const belowId = getVoxelAtWorld(wx, wy - 1, wz);
    return isFaceOpaque(belowId, [wx, wy - 1, wz]) ? 0.55 : 0.45;
}

// --- 側面の影 ---
const CEILING_CHECK_OFFSETS = {
    px: [1, 1, 0],
    nx: [-1, 1, 0],
    pz: [0, 1, 1],
    nz: [0, 1, -1]
};

function computeSideShadowFactor(wx, wy, wz, face, baseX, baseZ) {
    const key = `${baseX + wx}_${wy}_${baseZ + wz}_${face}`;
    if (sideShadowCache.has(key)) return sideShadowCache.get(key);

    const o = CEILING_CHECK_OFFSETS[face];
    if (!o) return 1;

    let checkX = baseX + wx + o[0];
    let checkY = wy + o[1]; // ここはワールド座標
    let checkZ = baseZ + wz + o[2];
    const maxY = BEDROCK_LEVEL + CHUNK_HEIGHT;

    const cacheKey = `${checkX}_${checkY}_${checkZ}`;
    if (ceilingCache.has(cacheKey)) {
        const factor = ceilingCache.get(cacheKey) ? 0.4 : 1;
        sideShadowCache.set(key, factor);
        return factor;
    }

    while (checkY < maxY) {
        const id = getVoxelAtWorld(checkX, checkY, checkZ);
        if (isFaceOpaque(id, [checkX, checkY, checkZ])) {
            ceilingCache.set(cacheKey, true);
            sideShadowCache.set(key, 0.4);
            return 0.4;
        }
        checkY++;
    }

    ceilingCache.set(cacheKey, false);
    sideShadowCache.set(key, 1);
    return 1;
}

// --- 上面の影（角ごと） ---
const TOP_SHADOW_OFFSETS = { LL: [-1, 1], LR: [1, 1], UR: [1, -1], UL: [-1, -1] };

function computeTopShadowFactorForCorner(wx, wy, wz, corner, blockId) {
    const key = `${wx}_${wy}_${wz}_${corner}_${blockId}`;
    if (topShadowCache.has(key)) return topShadowCache.get(key);
    const offset = TOP_SHADOW_OFFSETS[corner];
    if (!offset) return 1;
    const heights = getBlockHeights(blockId);
    const [dx, dz] = offset;
    let minShade = 1.0;
    const config = getBlockConfiguration(blockId);
    // Gamma プロパティで初期明るさを決定（指定がなければ 1.0）
    const baseShade = (config && typeof config.Gamma === "number") ? config.Gamma : 1.0;
    for (const h of heights) {
        const y = wy + h;
        const id1 = getVoxelAtWorld(wx + dx, y, wz);
        const id2 = getVoxelAtWorld(wx, y, wz + dz);
        const cfg1 = id1 && id1 !== BLOCK_TYPES.SKY ? getConfigCached(id1) : null;
        const cfg2 = id2 && id2 !== BLOCK_TYPES.SKY ? getConfigCached(id2) : null;
        let shade = baseShade;
        if (isInSubterraneanArea(wx, wy, wz)) {
            shade = 0.4;
        } else if ((cfg1 && !cfg1.transparent) && (cfg2 && !cfg2.transparent)) {
            shade = 0.4;
        } else if ((cfg1 && !cfg1.transparent) || (cfg2 && !cfg2.transparent)) {
            shade = 0.7;
        }
        if (shade < minShade) minShade = shade;
    }
    topShadowCache.set(key, minShade);
    return minShade;
}

// メイン関数
function getBlockHeights(id) {
    const cfg = getConfigCached(id);
    if (!cfg) return [1.0];
    switch (cfg.geometryType) {
        case "slab":
            return [0.5];             // スラブは下半分
        case "stairs":
            return [0.5, 1.0];        // 階段は下段と上段
        case "cross":
            return [1.0];             // 植物等
        case "water":
            return [0.88];            // 水は高さ0.88
        case "carpet":
            return [0.0625];          // カーペットは薄い
        default:
            return [1.0];             // 標準ブロック
    }
}

// ---------------------------------------
// CHUNK MESH GENERATION (軽量化版)
// ---------------------------------------
function generateChunkMeshMultiTexture(cx, cz, useInstancing = false) {
    const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
    const idx = (x, y, z) => x + CHUNK_SIZE * (y + CHUNK_HEIGHT * z);
    const modMap = voxelModifications instanceof Map ? voxelModifications : new Map(Object.entries(voxelModifications || {}));
    const voxelData = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
    const container = new THREE.Object3D();
    const tmpMat = new THREE.Matrix4();

    clearCaches(); // キャッシュ初期化

    // --- voxelData構築 ---
    for (let z = 0; z < CHUNK_SIZE; z++)
        for (let y = 0; y < CHUNK_HEIGHT; y++)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
                voxelData[idx(x, y, z)] = modMap.get(`${wx}_${wy}_${wz}`) ?? getVoxelAtWorld(wx, wy, wz);
            }

    const get = (x, y, z) => (x >= 0 && x < CHUNK_SIZE && y >= 0 && y < CHUNK_HEIGHT && z >= 0 && z < CHUNK_SIZE)
        ? voxelData[idx(x, y, z)]
        : modMap.get(`${baseX + x}_${BEDROCK_LEVEL + y}_${baseZ + z}`) ?? getVoxelAtWorld(baseX + x, BEDROCK_LEVEL + y, baseZ + z);

    const visCache = new Map();
    const getVisMask = (x, y, z, type, cfg) => {
        const key = `${x},${y},${z}`;
        if (!visCache.has(key)) {
            visCache.set(key, computeVisibilityMask(
                i => get(x + neighbors[i].dx, y + neighbors[i].dy, z + neighbors[i].dz),
                type, cfg.transparent ?? false, cfg.customGeometry
            ));
        }
        return visCache.get(key);
    };

    // --- ジオメトリキャッシュ ---
    const customGeomCache = new Map();
    const customGeomBatches = new Map();
    const faceGeoms = new Map();

    // --- メインループ ---
    for (let z = 0; z < CHUNK_SIZE; z++)
        for (let y = 0; y < CHUNK_HEIGHT; y++)
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const type = voxelData[idx(x, y, z)];
                if (!type || type === BLOCK_TYPES.SKY) continue;

                const cfg = getConfigCached(type);
                if (!cfg) continue;

                const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
                const visMask = getVisMask(x, y, z, type, cfg);

                // --- カスタムジオメトリ ---
                if (cfg.customGeometry || cfg.geometryType !== 'cube') {
                    if (!customGeomCache.has(type)) {
                        const mesh = createCustomBlockMesh(type, new THREE.Vector3(), null);
                        if (mesh) customGeomCache.set(type, mesh.geometry.clone());
                    }
                    const template = customGeomCache.get(type);
                    if (!template) continue;
                    if (!visMask && cfg.cullAdjacentFaces !== false) continue;

                    const filtered = template.groups.flatMap(group => {
                        const dir = detectFaceDirection(template, group);
                        if (cfg.cullAdjacentFaces !== false && ((visMask >> dir) & 1) === 0) return [];
                        const subGeo = new THREE.BufferGeometry();
                        extractGroupGeometry(template, group, subGeo);
                        subGeo.applyMatrix4(tmpMat.makeTranslation(wx, wy, wz));
                        return subGeo;
                    });

                    if (filtered.length) {
                        if (!customGeomBatches.has(type)) customGeomBatches.set(type, []);
                        const merged = mergeBufferGeometries(filtered, true);

                        const posAttr = merged.getAttribute('position');
                        const normalAttr = merged.getAttribute('normal');
                        const colors = new Float32Array(posAttr.count * 3);

                        if (cfg.geometryType === "cross") {
                            const centerX = Math.floor((posAttr.getX(0) + posAttr.getX(posAttr.count - 1)) / 2) - baseX;
                            const centerZ = Math.floor((posAttr.getZ(0) + posAttr.getZ(posAttr.count - 1)) / 2) - baseZ;
                            let yMin = Infinity;
                            for (let i = 0; i < posAttr.count; i++) yMin = Math.min(yMin, posAttr.getY(i));
                            yMin = Math.floor(yMin) - BEDROCK_LEVEL;

                            let shade = 1.0;
                            for (let yCheck = yMin + 1; yCheck < CHUNK_HEIGHT; yCheck++) {
                                const aboveType = get(centerX, yCheck, centerZ);
                                const aboveCfg = getConfigCached(aboveType);
                                if (aboveType && aboveCfg && aboveCfg.transparent !== true) { shade = 0.2; break; }
                            }
                            colors.fill(shade);
                        } else {
                            const faceShadeCache = {};
                            for (let i = 0; i < posAttr.count; i++) {
                                const ny = normalAttr.getY(i), nx = normalAttr.getX(i), nz = normalAttr.getZ(i);
                                let shade = 1.0;
                                if (ny > 0.9) shade = computeTopShadowFactorForCorner(wx, wy, wz, ["LL", "LR", "UR", "UL"][i % 4], type);
                                else if (ny < -0.9) shade = computeBottomShadowFactor(wx, wy, wz);
                                else {
                                    const face = nx > 0.9 ? "px" : nx < -0.9 ? "nx" : nz > 0.9 ? "pz" : nz < -0.9 ? "nz" : null;
                                    if (face) {
                                        if (!faceShadeCache[face]) faceShadeCache[face] = computeSideShadowFactor(x, y, z, face, baseX, baseZ);
                                        shade = faceShadeCache[face];
                                    }
                                }
                                colors.set([shade, shade, shade], i * 3);
                            }
                        }

                        merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
                        customGeomBatches.get(type).push(merged);
                    }
                    continue;
                }

                // --- 通常立方体 ---
                if (!visMask) continue;

                if (useInstancing) {
                    if (!faceGeoms.has(type)) faceGeoms.set(type, new Map());
                    const matMap = faceGeoms.get(type);

                    for (const [face, data] of Object.entries(faceData)) {
                        if (!((visMask >> data.bit) & 1)) continue;
                        if (!matMap.has(face)) matMap.set(face, []);
                        matMap.get(face).push([wx, wy, wz]);
                    }
                    continue;
                }

                for (const [face, data] of Object.entries(faceData)) {
                    if (!((visMask >> data.bit) & 1)) continue;
                    const geom = getCachedFaceGeometry(face);
                    if (!geom) continue;
                    const geomClone = geom.clone().applyMatrix4(tmpMat.makeTranslation(wx, wy, wz));

                    const posAttr = geomClone.getAttribute('position');
                    const normalAttr = geomClone.getAttribute('normal');
                    const colors = new Float32Array(posAttr.count * 3);

                    for (let i = 0; i < posAttr.count; i++) {
                        const nx = normalAttr.getX(i), ny = normalAttr.getY(i), nz = normalAttr.getZ(i);
                        let shade = 1.0;
                        if (ny > 0.9) shade = computeTopShadowFactorForCorner(wx, wy, wz, ["LL", "LR", "UR", "UL"][i % 4], type);
                        else if (ny < -0.9) shade = computeBottomShadowFactor(wx, wy, wz);
                        else {
                            const faceDir = nx > 0.9 ? "px" : nx < -0.9 ? "nx" : nz > 0.9 ? "pz" : nz < -0.9 ? "nz" : null;
                            if (faceDir) shade = computeSideShadowFactor(x, y, z, faceDir, baseX, baseZ);
                        }
                        colors.set([shade, shade, shade], i * 3);
                    }

                    geomClone.setAttribute("color", new THREE.BufferAttribute(colors, 3));

                    if (!faceGeoms.has(type)) faceGeoms.set(type, new Map());
                    const matMap = faceGeoms.get(type);
                    if (!matMap.has(faceToMaterialIndex[face])) matMap.set(faceToMaterialIndex[face], []);
                    matMap.get(faceToMaterialIndex[face]).push(geomClone);
                }
            }

    // --- 通常立方体マージ ---
    for (const [type, group] of faceGeoms.entries()) {
        if (useInstancing) {
            for (const [face, positions] of group.entries()) {
                if (!positions.length) continue;
                const geom = getCachedFaceGeometry(face).clone();
                const mats = getBlockMaterials(type);
                const mat = mats?.[0] ? Object.assign(mats[0].clone(), { vertexColors: true }) : new THREE.MeshBasicMaterial({ color: 0xffffff });
                const mesh = new THREE.InstancedMesh(geom, mat, positions.length);
                const dummy = new THREE.Object3D();
                positions.forEach((pos, i) => { dummy.position.set(...pos); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); });
                container.add(mesh);
            }
        } else {
            const subGeoms = [...group.values()].map(mergeBufferGeometries);
            const finalGeom = mergeBufferGeometries(subGeoms);
            finalGeom.clearGroups();
            let offset = 0;
            [...group.keys()].forEach((matIdx, i) => { finalGeom.addGroup(offset, subGeoms[i].index.count, +matIdx); offset += subGeoms[i].index.count; });
            finalGeom.computeBoundingSphere();
            const mats = getBlockMaterials(+type)?.map(m => Object.assign(m.clone(), { vertexColors: true, side: THREE.FrontSide }));
            const mesh = new THREE.Mesh(finalGeom, mats);
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.frustumCulled = true;
            container.add(mesh);
        }
    }

    // --- カスタムジオメトリマージ ---
    for (const [type, geoms] of customGeomBatches.entries()) {
        const merged = mergeBufferGeometries(geoms, true);
        merged.computeBoundingSphere();
        const cfg = getConfigCached(type);
        const isCross = cfg?.geometryType === "cross", isTransparent = cfg?.transparent === true;
        const mats = (getBlockMaterials(+type) || []).map(m => {
            const mat = m.clone();
            mat.side = isCross ? THREE.DoubleSide : THREE.FrontSide;
            mat.transparent = isCross || isTransparent;
            mat.depthWrite = !(isCross || isTransparent);
            mat.vertexColors = true;
            return mat;
        });
        const mesh = new THREE.Mesh(merged, mats[0]);
        if (isCross) mesh.renderOrder = 1000;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        container.add(mesh);
    }

    return container;
}

// ------------------------------
// CUSTOM BLOCK MESH (軽量化版)
// ------------------------------
const materialCache = new Map();
const collisionCache = new Map();

function createCustomBlockMesh(type, position, rotation) {
    const config = getBlockConfiguration(type);
    if (!config) { console.error("Unknown block type:", type); return null; }

    let geometry;
    if (config.geometryType) {
        if (!geometryCache.has(type)) geometryCache.set(type, getBlockGeometry(config.geometryType, config));
        geometry = geometryCache.get(type);
    } else if (config.customGeometry) {
        geometry = config.customGeometry.clone?.() ?? config.customGeometry;
    } else {
        console.warn(`No geometry for block type: ${type}`);
        return null;
    }

    let materials = materialCache.get(type);
    if (!materials) { materials = getBlockMaterials(type); materialCache.set(type, materials); }

    const useMultiMaterial = Array.isArray(materials) && materials.length > 1 && geometry.groups?.length > 0;
    const meshGeometry = config.geometryType ? geometry : geometry.clone();
    const meshMaterial = useMultiMaterial ? materials : materials[0];

    const mesh = new THREE.Mesh(meshGeometry, meshMaterial);
    mesh.position.copy(position);
    if (rotation) mesh.rotation.copy(rotation);
    mesh.castShadow = mesh.receiveShadow = mesh.frustumCulled = true;

    if (!collisionCache.has(type)) {
        const boxes = typeof config.customCollision === "function"
            ? config.customCollision(new THREE.Vector3())
            : (config.collision ? [new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, config.geometryType === "slab" ? 0.5 : 1, 1))] : []);
        collisionCache.set(type, boxes);
    }

    mesh.userData = {
        isCustomBlock: !!config.customGeometry,
        blockType: type,
        collisionBoxes: collisionCache.get(type).map(box => box.clone().translate(position))
    };

    mesh.updateMatrixWorld();
    return mesh;
}

/**
 * idle 時間内またはタイムアウト時にキューからチャンク生成する関数
 * @param {IdleDeadline} [deadline] -
 */
// チャンク更新キュー（chunkQueue は既存のグローバル変数）
let chunkQueueScheduled = false;

function processChunkQueue(deadline = { timeRemaining: () => 0, didTimeout: true }) {
    let tasksProcessed = 0;
    const MAX_CHUNKS_PER_FRAME = 2;

    while (
        chunkQueue.length &&
        (deadline.timeRemaining?.() > 1 || deadline.didTimeout) &&
        tasksProcessed < MAX_CHUNKS_PER_FRAME
    ) {
        const t0 = performance.now();
        if (!generateNextChunk()) break; // falseなら処理中断
        if (performance.now() - t0 > 8 && !deadline.didTimeout) break;
        tasksProcessed++;
    }

    if (chunkQueue.length) {
        if (!chunkQueueScheduled) {
            chunkQueueScheduled = true;
            (window.requestIdleCallback || window.requestAnimationFrame)((dl) => {
                chunkQueueScheduled = false;
                processChunkQueue(dl);
            });
        }
    }
}

let lastChunk = { x: null, z: null }, offsets;

const precomputeOffsets = () => {
    const s = CHUNK_VISIBLE_DISTANCE * 2 + 1, o = [];
    for (let i = 0; i < s * s; i++) {
        const dx = i % s - CHUNK_VISIBLE_DISTANCE;
        const dz = Math.floor(i / s) - CHUNK_VISIBLE_DISTANCE;
        o.push({ dx, dz, d: dx * dx + dz * dz });
    }
    return o.sort((a, b) => a.d - b.d);
};

function updateChunks() {
    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);

    // 移動がなければ offsets キャッシュを使い回す
    if (lastChunk.x === pCx && lastChunk.z === pCz && offsets) return;
    lastChunk = { x: pCx, z: pCz };
    offsets ||= precomputeOffsets();

    // 必要チャンクのセットと、既にキューにあるチャンクのセット
    const req = new Set();
    const queued = new Set(chunkQueue.map(e => `${e.cx}_${e.cz}`));

    // offsets をもとに候補チャンクを計算
    const cands = offsets.map(({ dx, dz }) => ({ cx: pCx + dx, cz: pCz + dz }));

    for (const { cx, cz } of cands) {
        const key = `${cx}_${cz}`;
        req.add(key);
        if (!loadedChunks[key] && !queued.has(key)) {
            chunkQueue.push({ cx, cz });
        }
    }

    // キュー内で不要になったチャンクを削除
    chunkQueue = chunkQueue.filter(e => req.has(`${e.cx}_${e.cz}`));

    // プレイヤーが移動した場合のみソート（優先度: 中心に近い順）
    if (lastChunk.x !== pCx || lastChunk.z !== pCz) {
        chunkQueue.sort((a, b) =>
            (a.cx - pCx) ** 2 + (a.cz - pCz) ** 2 - ((b.cx - pCx) ** 2 + (b.cz - pCz) ** 2)
        );
    }

    // 正方形範囲外のチャンクを破棄
    for (const key in loadedChunks) {
        const [cx, cz] = key.split("_").map(Number);
        const dx = cx - pCx, dz = cz - pCz;

        if (Math.abs(dx) > CHUNK_VISIBLE_DISTANCE || Math.abs(dz) > CHUNK_VISIBLE_DISTANCE) {
            releaseChunkMesh(loadedChunks[key]);
            delete loadedChunks[key];
        }
    }

    // Idle/非同期でチャンク生成を処理
    (window.requestIdleCallback || ((cb) => setTimeout(cb, 16)))(
        () => processChunkQueue({ timeRemaining: () => 16, didTimeout: true })
    );
}


window.updateChunksFromUI = () => {
    const d = parseInt(document.getElementById("chunkDistance").value, 10);
    if (isNaN(d) || d < 0 || d > 32) return alert("0～32の範囲で入力してください。");
    CHUNK_VISIBLE_DISTANCE = d;
    offsets = null;
    updateChunks();
    console.log("距離更新:", d);
};


/* ======================================================
   【ブロックの破壊・設置機能】（長押し、範囲指定、プレイヤー領域禁止）
   ====================================================== */
const BLOCK_INTERACT_RANGE = 9;
/**
 * 座標からチャンク座標を求めるユーティリティ関数
 * 非負の場合はビット演算で高速に、負の場合は Math.floor を利用
 */
function getChunkCoord(val) {
    return Math.floor(val / CHUNK_SIZE);  // 負の値も正しく処理
}

/**
 * チャンク更新要求をまとめて処理
 */
function processChunkUpdates() {
    for (const key of pendingChunkUpdates) {
        const [x, z] = decodeChunkKey(key);
        requestChunkUpdate(x, z);
    }
    pendingChunkUpdates.clear();
    scheduleChunkUpdate();
    updateTimeout = null;
}

/**
 * updateAffectedChunks は、ブロック操作によって影響を受けるチャンク（自分自身や隣接チャンク）を
 * 計算し、更新要求を発行します。チャンク座標の算出や、ローカル座標から隣接チャンクを知る方法は、
 * CHUNK_SIZE が 2の冪である前提でビット演算を使用しています。
 *
 * @param {{x: number, y: number, z: number}} blockPos - 操作対象のブロックワールド座標
 */
function updateAffectedChunks(blockPos, forceImmediate = true) {
    const cx = getChunkCoord(blockPos.x);
    const cz = getChunkCoord(blockPos.z);

    // 自分のチャンクキー
    const keys = [encodeChunkKey(cx, cz)];

    const localX = blockPos.x & (CHUNK_SIZE - 1);
    const localZ = blockPos.z & (CHUNK_SIZE - 1);

    // 隣接チャンクのキーをまとめて作成
    const neighbors = [];
    if (localX === 0) neighbors.push([cx - 1, cz]);
    else if (localX === CHUNK_SIZE - 1) neighbors.push([cx + 1, cz]);

    if (localZ === 0) neighbors.push([cx, cz - 1]);
    else if (localZ === CHUNK_SIZE - 1) neighbors.push([cx, cz + 1]);

    // pendingChunkUpdates に追加（重複は追加しない）
    for (const [nx, nz] of neighbors) {
        const k = encodeChunkKey(nx, nz);
        if (!pendingChunkUpdates.has(k)) keys.push(k);
    }

    for (const k of keys) pendingChunkUpdates.add(k);

    if (forceImmediate) {
        // 即時処理：処理済みキーを除きつつバッチ
        const batchSize = Math.min(pendingChunkUpdates.size, 4);
        processPendingChunkUpdates(batchSize);
        // Set は残すので同フレームで追加更新可能
    } else {
        // デバウンス：タイマーセット
        if (!updateTimeout) {
            updateTimeout = setTimeout(() => {
                processChunkUpdates();
                updateTimeout = null;
            }, 16);
        }
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
    return !['x', 'y', 'z'].some(axis =>
        blockPos[axis] + 1 <= playerAABB.min[axis] + tolerance ||
        blockPos[axis] >= playerAABB.max[axis] - tolerance
    );
}

// --- interactWithBlock 関数 ---
// ブロックの設置／破壊操作を行い voxelModifications を更新し、必要なチャンク（領域）再生成を指示する
const placedCustomBlocks = {};
const raycaster = new THREE.Raycaster();

// ============================================================
// クリック→6方向スナップで隣接セル一意決定版（フル書き直し）
// ============================================================

// ジャンプ中の縦連続設置防止用
let lastPlacedKey = null;

// ----------------------------------------
// 6方向へ量子化
// ----------------------------------------
function axisSnapDir(n) {
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    if (ax >= ay && ax >= az) return { x: Math.sign(n.x) || 1, y: 0, z: 0 };
    if (ay >= ax && ay >= az) return { x: 0, y: Math.sign(n.y) || 1, z: 0 };
    return { x: 0, y: 0, z: Math.sign(n.z) || 1 };
}

// ----------------------------------------
// ヒットブロック(base)と設置/破壊対象(target)を決定
// ----------------------------------------
function computeHitBlockAndTarget(hit, action) {
    const EPS = 1e-5;
    // raw normal は既存の hit.face.normal を使う（割当最小化）
    const n = (hit.face && hit.face.normal) ? hit.face.normal : new THREE.Vector3(0, 1, 0);

    const baseX = Math.floor(hit.point.x - n.x * EPS);
    const baseY = Math.floor(hit.point.y - n.y * EPS);
    const baseZ = Math.floor(hit.point.z - n.z * EPS);

    const base = new THREE.Vector3(baseX, baseY, baseZ);

    const dir = axisSnapDir(n); // now an object {x,y,z}, no new Vector3 allocation

    const target = (action === "destroy")
        ? base
        : new THREE.Vector3(base.x + dir.x, base.y + dir.y, base.z + dir.z);

    return { base, dir, target, rawNormal: n };
}

// ----------------------------------------
// 最初の有効ヒットを取得（距離順）
// - 水は破壊かつアクティブが水のときのみ許可（元の仕様踏襲）
// ----------------------------------------
// グローバルに追加（ファイル先頭など）
const _intersectPool = [];
function allocIntersects() {
    return _intersectPool.pop() || [];
}
function freeIntersects(arr) {
    if (!arr) return;
    arr.length = 0;
    if (_intersectPool.length < 32) _intersectPool.push(arr);
}

// pickFirstValidHit（挙動そのまま軽量化）
function pickFirstValidHit(raycaster, objects, action) {
    const EPS = 1e-6;
    const intersects = allocIntersects();
    const tempNormal = allocVec(); // ← Vector3プールから借りる

    try {
        // ---- レイキャスト結果収集 ----
        for (const obj of objects) {
            if (!obj) continue;
            try {
                if (obj.isInstancedMesh && typeof obj.raycast === "function") {
                    obj.raycast(raycaster, intersects);
                } else {
                    raycaster.intersectObject(obj, true, intersects);
                }
            } catch (e) {
                console.warn("raycast error:", e);
            }
        }

        if (intersects.length === 0) return null;
        intersects.sort((a, b) => a.distance - b.distance);

        // ---- 最初の有効ヒットを探す ----
        for (const hit of intersects) {
            if (hit.distance > BLOCK_INTERACT_RANGE + EPS) continue;

            // 法線をプールVector3にコピー
            if (hit.face?.normal) {
                tempNormal.copy(hit.face.normal);
            } else {
                tempNormal.set(0, 1, 0);
            }

            const base = allocVec();
            base.set(
                Math.floor(hit.point.x - tempNormal.x * EPS),
                Math.floor(hit.point.y - tempNormal.y * EPS),
                Math.floor(hit.point.z - tempNormal.z * EPS)
            );

            const voxelId =
                voxelModifications[`${base.x}_${base.y}_${base.z}`] ??
                getVoxelAtWorld(base.x, base.y, base.z, globalTerrainCache, true);

            const cfg = getBlockConfiguration(voxelId);

            // 水ブロックの処理は元のまま
            if (cfg?.geometryType === "water") {
                if (action === "destroy" && activeBlockType === BLOCK_TYPES.WATER) {
                    freeVec(base);
                    return hit; // 水を破壊したいケースだけは通す
                }
                freeVec(base);
                continue;
            }

            freeVec(base);
            return hit; // 非水ブロック
        }

        return null;
    } finally {
        freeIntersects(intersects);
        freeVec(tempNormal);
    }
}

// ----------------------------------------
// メイン：破壊/設置
// ----------------------------------------
function interactWithBlock(action) {
    if (action !== "place" && action !== "destroy") {
        console.warn("未知のアクション:", action);
        return;
    }

    const EPS = 1e-6;
    const TOP_FACE_THRESHOLD = 0.9; // 既存の上面判定互換用
    const TOP_Y_EPS = 1e-3;

    // セットアップ：中心照準でレイキャスト
    raycaster.near = 0.01;
    raycaster.far = BLOCK_INTERACT_RANGE;
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    const objects = [...Object.values(loadedChunks), ...Object.values(placedCustomBlocks)];
    const intersect = pickFirstValidHit(raycaster, objects, action);

    if (!intersect) {
        console.warn("破壊/設置対象が見つかりません");
        return;
    }

    // base/dir/target を一意に決定
    const { base, dir, target, rawNormal } = computeHitBlockAndTarget(intersect, action);

    // candidate は target に一本化
    const candidate = target;
    const key = `${candidate.x}_${candidate.y}_${candidate.z}`;

    // 現在の candidate の中身
    let voxel = voxelModifications[key]
        ?? getVoxelAtWorld(candidate.x, candidate.y, candidate.z, globalTerrainCache, true);
    let cfg = getBlockConfiguration(voxel);

    // 射程チェック（candidate の中心で判定）
    const candidateCenter = new THREE.Vector3(candidate.x + 0.5, candidate.y + 0.5, candidate.z + 0.5);
    const cameraPos = camera.position ? camera.position : new THREE.Vector3(0, 0, 0);
    const distToCandidate = cameraPos.distanceTo(candidateCenter);
    if (distToCandidate > BLOCK_INTERACT_RANGE + 0.6) {
        console.warn("ターゲットは射程外です:", distToCandidate.toFixed(2));
        return;
    }

    // --- プレイヤーAABBと安全判定 ---
    const belowBlockBox = new THREE.Box3(
        new THREE.Vector3(candidate.x + EPS, candidate.y - 1 + EPS, candidate.z + EPS),
        new THREE.Vector3(candidate.x + 1 - EPS, candidate.y - EPS, candidate.z + 1 - EPS)
    );

    let playerBox = null;
    try {
        playerBox = getPlayerAABB();
    } catch (e) {
        playerBox = null;
    }

    // 旧ロジック互換の上面判定（必要なら dir.y > 0 も使える）
    const topPlaneY = candidate.y + 1;
    const isTopFaceByNormal = rawNormal.y > TOP_FACE_THRESHOLD;
    const hitPointIsAtTop = (Math.abs(intersect.point.y - topPlaneY) <= TOP_Y_EPS) || (intersect.point.y > topPlaneY - TOP_Y_EPS);
    const isActuallyTopAttempt = isTopFaceByNormal || hitPointIsAtTop || (dir.y > 0);

    if (action === "place" && playerBox) {
        const playerFeetY = playerBox.min.y;
        const isAboveFeet = candidate.y >= Math.floor(playerFeetY + EPS);
        const overlaps = playerBox.intersectsBox(belowBlockBox);

        // スニーク中の自分足元ブロック上面禁止（安全）
        if (sneakActive && overlaps && isActuallyTopAttempt) {
            console.warn("自分の立っているブロックの上面には設置できません（安全判定）");
            return;
        }

        // 真上条件付きジャンプ中縦連続設置禁止
        if (isAboveFeet && isActuallyTopAttempt) {
            if (lastPlacedKey) {
                const [lx, ly, lz] = lastPlacedKey.split("_").map(Number);
                const sameColumn = (candidate.x === lx && candidate.z === lz);
                const higherThanLast = candidate.y > ly;

                const playerCenterX = (playerBox.min.x + playerBox.max.x) / 2;
                const playerCenterZ = (playerBox.min.z + playerBox.max.z) / 2;
                const dx = Math.abs(playerCenterX - (candidate.x + 0.5));
                const dz = Math.abs(playerCenterZ - (candidate.z + 0.5));
                const isDirectlyAbove = dx < 0.4 && dz < 0.4;

                if (sameColumn && higherThanLast && isDirectlyAbove) {
                    console.warn("真上でのジャンプ中縦連続設置は禁止");
                    return;
                }
            }
        }
    }

    // ====================
    // 破壊
    // ====================
    if (action === "destroy") {
        // 破壊対象は base（＝現に当たっているブロック）
        const destroyKey = `${base.x}_${base.y}_${base.z}`;
        let destroyVoxel = voxelModifications[destroyKey]
            ?? getVoxelAtWorld(base.x, base.y, base.z, globalTerrainCache, true);
        const destroyCfg = getBlockConfiguration(destroyVoxel);

        if (destroyCfg?.targetblock === false) {
            console.warn("破壊不可ブロックです");
            return;
        }
        if (destroyVoxel === BLOCK_TYPES.SKY) {
            console.warn("空気は破壊できません");
            return;
        }

        const blockCenter = new THREE.Vector3(base.x + 0.5, base.y + 0.5, base.z + 0.5);
        createMinecraftBreakParticles(blockCenter, destroyVoxel, 1.0);

        if (placedCustomBlocks[destroyKey]) {
            scene.remove(placedCustomBlocks[destroyKey]);
            delete placedCustomBlocks[destroyKey];
        }
        voxelModifications[destroyKey] = BLOCK_TYPES.SKY;
        console.log("破壊完了:", base);

        // チャンク更新
        const chunkX = Math.floor(base.x / CHUNK_SIZE);
        const chunkZ = Math.floor(base.z / CHUNK_SIZE);
        markColumnModified(`${chunkX}_${chunkZ}`, base.x, base.z, base.y);
        updateAffectedChunks(base, true); // 即時更新
        return;
    }

    // ====================
    // 設置
    // ====================
    if (action === "place") {
        if (candidate.y <= -1) {
            console.warn("y座標が0以下のため、設置できません。");
            return;
        }
        if (candidate.y >= BEDROCK_LEVEL + CHUNK_HEIGHT) {
            console.warn("高さ制限により、設置できません。");
            return;
        }
        const newBlockCfg = getBlockConfiguration(activeBlockType);
        // プレイヤーと衝突しすぎる場合は拒否
        if (newBlockCfg?.collision !== false && blockIntersectsPlayer(candidate, playerBox ?? getPlayerAABB(), 0.2)) {
            console.warn("プレイヤーの領域に近すぎるため、設置できません。");
            return;
        }

        // 既存ブロックとの競合処理
        if (voxel !== BLOCK_TYPES.SKY) {
            const currentCfg = getBlockConfiguration(voxel);
            if (currentCfg?.geometryType === "water" || currentCfg?.overwrite === true) {
                if (placedCustomBlocks[key]) {
                    scene.remove(placedCustomBlocks[key]);
                    delete placedCustomBlocks[key];
                }
                voxelModifications[key] = BLOCK_TYPES.SKY; // 上書き許可ケースは先に空気化
            } else {
                console.warn("設置不可: ブロックが存在します");
                return;
            }
        }

        // 設置確定
        voxelModifications[key] = activeBlockType;
        lastPlacedKey = key;
        console.log("設置完了:", candidate);

        // チャンク更新
        const chunkX = Math.floor(candidate.x / CHUNK_SIZE);
        const chunkZ = Math.floor(candidate.z / CHUNK_SIZE);
        markColumnModified(`${chunkX}_${chunkZ}`, candidate.x, candidate.z, candidate.y);
        updateAffectedChunks(candidate, true); // 即時更新
        return;
    }
}

// ----------------------------------------
// 地面に着いたら連続設置ガードをリセット
// ----------------------------------------
function resetLastPlacedIfOnGround() {
    if (player?.isOnGround) {
        lastPlacedKey = null;
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
    if (!("ontouchstart" in window)) {
        renderer.domElement.requestPointerLock();
    }
});

document.addEventListener("pointerlockchange", () => {
    console.log(document.pointerLockElement === renderer.domElement ? "Pointer Locked" : "Pointer Unlocked");
});

// ----- タッチ操作で視点回転＋短タップ設置・長押し破壊 -----
let lastTouchX = null, lastTouchY = null;
let touchHoldTimeout = null;
let isLongPress = false;
let isTouchMoving = false;

renderer.domElement.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;

    isLongPress = false;
    isTouchMoving = false;

    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;

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

    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        isTouchMoving = true;
    }

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

    if (!isTouchMoving) {
        if (isLongPress) {
            stopInteraction("touch");
        } else {
            interactWithBlock("place");
        }
    } else {
        // 視点移動中なら破壊繰り返しも停止
        if (isLongPress) {
            stopInteraction("touch");
        }
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

// --- 選択管理 ---
let activeBlockType = 0;
let selectedHotbarIndex = 0;

// --- 画像キャッシュ＆読み込み ---
const imageCache = new Map();
const loadImage = src => imageCache.has(src)
    ? Promise.resolve(imageCache.get(src))
    : new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => (imageCache.set(src, img), res(img));
        img.onerror = rej;
        img.src = src;
    });

// --- Canvas作成 ---
const createCanvas = size => Object.assign(document.createElement("canvas"), { width: size, height: size });

// --- 2Dプレビュー ---
const create2DPreview = ({ id, textures = {}, previewOptions = {} }, size) => {
    const cacheKey = `${id}_${size}_2D`;
    if (previewCache.has(cacheKey)) {
        const cached = previewCache.get(cacheKey);
        const clone = createCanvas(size);
        clone.getContext("2d").drawImage(cached, 0, 0);
        return clone;
    }

    const canvas = createCanvas(size);
    canvas.style.imageRendering = "pixelated";
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const src = textures.all || textures.side || textures.top;
    if (!src) return (console.warn(`テクスチャなし block: ${id}`), canvas);

    loadImage(src).then(img => {
        const { x = 0, y = 0 } = previewOptions.offset || {};
        ctx.drawImage(img, x, y, size, size);

        // キャッシュ保存
        const cacheCanvas = createCanvas(size);
        cacheCanvas.getContext("2d").drawImage(canvas, 0, 0);
        previewCache.set(cacheKey, cacheCanvas);
    }).catch(e => console.error(`画像読み込み失敗 block: ${id}`, e));

    return canvas;
};

// --- 3Dプレビュー ---
// 1つだけ用意する共有の3Dレンダラー＆シーン＆カメラ（非表示canvas）
// サイズは適宜調整可。描画時にセットするので問題なし。
const shared3DCanvas = createCanvas(64);
shared3DCanvas.style.display = "none";
document.body.appendChild(shared3DCanvas);

const sharedRenderer = new THREE.WebGLRenderer({ canvas: shared3DCanvas, alpha: true, antialias: true });
sharedRenderer.setSize(64, 64);
sharedRenderer.setClearColor(0x000000, 0);

const sharedScene = new THREE.Scene();
sharedScene.add(new THREE.AmbientLight(0xffffff, 0.6));
const light = new THREE.DirectionalLight(0xffffff, 0.8);
light.position.set(5, 5, 5);
sharedScene.add(light);

const sharedCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
sharedCamera.position.set(2, 2, 2);
sharedCamera.lookAt(0, 0, 0);

// 3Dプレビュー作成（レンダラーは共有、戻り値は描画結果をコピーした2D canvas）
// 対象箇所: create3DPreview関数
// 変更点: テクスチャが完全に読み込まれてから描画を行うようにする
// --- プレビューキャッシュ ---
const previewCache = new Map();

// create3DPreview関数内の改善案
const create3DPreview = async ({ id, previewOptions = {}, geometryType }, size) => {
    const cacheKey = `${id}_${size}_3D`;
    if (previewCache.has(cacheKey)) {
        const cached = previewCache.get(cacheKey);
        const clone = createCanvas(size);
        clone.getContext("2d").drawImage(cached, 0, 0);
        return clone;
    }

    const previewCanvas = createCanvas(size);
    previewCanvas.style.imageRendering = "pixelated";

    // サイズ変更時のみリサイズ
    if (sharedRenderer.domElement.width !== size || sharedRenderer.domElement.height !== size) {
        sharedRenderer.setSize(size, size);
    }

    const mesh = createBlockMesh(id, new THREE.Vector3());
    if (!mesh) {
        console.error(`メッシュ生成失敗 id: ${id}`);
        return previewCanvas;
    }

    if (mesh.geometry && typeof mesh.geometry.computeVertexNormals === "function") {
        mesh.geometry.computeVertexNormals();
    }

    const originalMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const newMaterials = originalMaterials.map(m => {
        return new THREE.MeshLambertMaterial({
            map: m.map || null,
            side: THREE.FrontSide,
            transparent: m.transparent || false,
            opacity: m.opacity !== undefined ? m.opacity : 1,
        });
    });
    mesh.material = Array.isArray(mesh.material) ? newMaterials : newMaterials[0];

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const loadPromises = materials
        .map(m => m.map)
        .filter(map => map && !(map.image && map.image.complete))
        .map(map => new Promise(resolve => {
            const checkLoaded = () => {
                if (map.image && map.image.complete) resolve();
                else setTimeout(checkLoaded, 10);
            };
            checkLoaded();
        }));
    await Promise.all(loadPromises);

    materials.forEach(m => {
        if (m.map) {
            m.map.magFilter = THREE.NearestFilter;
            m.map.minFilter = THREE.NearestMipmapNearestFilter;
            m.map.generateMipmaps = true;
            m.map.needsUpdate = true;
        }
    });

    light.position.set(10, 10, 10);
    light.intensity = 0.8;
    sharedCamera.position.set(2, 2, 2);
    sharedCamera.lookAt(0, 0, 0);
    sharedCamera.updateProjectionMatrix();

    while (sharedScene.children.length > 2) {
        const old = sharedScene.children[2];
        sharedScene.remove(old);
        if (old.geometry) old.geometry.dispose();
        if (old.material) {
            const disposeMaterial = m => {
                if (m.map) m.map.dispose();
                m.dispose();
            };
            Array.isArray(old.material) ? old.material.forEach(disposeMaterial) : disposeMaterial(old.material);
        }
    }

    sharedScene.add(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    mesh.position.sub(center);
    if (previewOptions.offset) {
        mesh.position.add(new THREE.Vector3(
            previewOptions.offset.x || 0,
            previewOptions.offset.y || 0,
            previewOptions.offset.z || 0
        ));
    }

    const rot = previewOptions.rotation || { x: 30, y: 45, z: 0 };
    mesh.rotation.set(
        THREE.MathUtils.degToRad(rot.x),
        THREE.MathUtils.degToRad(rot.y),
        THREE.MathUtils.degToRad(rot.z)
    );

    mesh.scale.setScalar(previewOptions.scale || 1);
    if (geometryType === "stairs") {
        mesh.scale.x *= -1;
        mesh.position.sub(new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()));
    }

    sharedRenderer.render(sharedScene, sharedCamera);

    // キャッシュ用Canvasに保存
    const cacheCanvas = createCanvas(size);
    cacheCanvas.getContext("2d").drawImage(shared3DCanvas, 0, 0, size, size);
    previewCache.set(cacheKey, cacheCanvas);

    // 呼び出し元には複製を返す
    const resultCanvas = createCanvas(size);
    resultCanvas.getContext("2d").drawImage(cacheCanvas, 0, 0);
    return resultCanvas;
};

// --- プレビュー選択 ---
const createInventoryItemPreview = async blockConfig => {
    const config = getBlockConfiguration(blockConfig.id);
    return config.previewType === "2D"
        ? create2DPreview(config, 40)
        : await create3DPreview(config, 40);
};
const createHotbarItemPreview = async blockConfig => {
    const config = getBlockConfiguration(blockConfig.id);
    return config.previewType === "2D"
        ? create2DPreview(config, 64)
        : await create3DPreview(config, 64);
};

window.addEventListener("DOMContentLoaded", async () => {
    const inventoryEl = document.getElementById("inventory");
    inventoryEl.innerHTML = `<span>select block</span>
    <p style="position: absolute; z-index: 999; margin-top: 80px;" class="center bold border"><span class="button">&nbsp;E&nbsp;</span>&emsp;キーでインベントリを閉じる</p>`;

    const promises = Object.values(BLOCK_CONFIG).map(async blockConfig => {
        if (!blockConfig.itemdisplay) return null;
        const item = document.createElement("div");
        item.className = "inventory-item";
        item.dataset.blocktype = blockConfig?.id || "";

        const preview = await createInventoryItemPreview(blockConfig);
        preview.style.width = preview.style.height = "40px";
        item.appendChild(preview);

        item.addEventListener("click", async () => {
            document.querySelectorAll(".inventory-item.active").forEach(el => el.classList.remove("active"));
            item.classList.add("active");

            activeBlockType = Number(blockConfig.id);

            const hotbarItems = document.querySelectorAll(".hotbar-item");
            const hotbarSlot = hotbarItems[selectedHotbarIndex];
            hotbarSlot.innerHTML = "";
            hotbarSlot.dataset.blocktype = blockConfig.id;

            const hotbarPreview = await createHotbarItemPreview(blockConfig);
            hotbarPreview.style.width = hotbarPreview.style.height = "55px";
            hotbarSlot.appendChild(hotbarPreview);

            console.log("Inventory block set to hotbar slot", selectedHotbarIndex, activeBlockType);
        });

        return item;
    });

    const items = await Promise.all(promises);
    items.filter(Boolean).forEach(item => inventoryEl.appendChild(item));
});


// --- ホットバー初期化 ---
const hotbarEl = document.getElementById("hotbar");
hotbarEl.innerHTML = "";
for (let i = 0; i < 9; i++) {
    const item = document.createElement("div");
    item.className = "hotbar-item";
    if (i === 0) item.classList.add("active");
    item.dataset.blocktype = "";

    item.addEventListener("click", () => {
        document.querySelectorAll(".hotbar-item.active").forEach(el => el.classList.remove("active"));
        item.classList.add("active");

        selectedHotbarIndex = i;
        activeBlockType = Number(item.dataset.blocktype || 0);
        console.log("Hotbar slot selected:", selectedHotbarIndex, activeBlockType);
    });

    hotbarEl.appendChild(item);
}

// --- ホットバー選択更新 ---
function updateHotbarSelection() {
    const hotbarItems = document.querySelectorAll(".hotbar-item");
    hotbarItems.forEach(el => el.classList.remove("active"));
    const selected = hotbarItems[selectedHotbarIndex];
    if (!selected) return;
    selected.classList.add("active");
    activeBlockType = Number(selected.dataset.blocktype || 0);
    console.log("Hotbar slot selected (updated):", selectedHotbarIndex, activeBlockType);
}

// --- ホイール・数字キーでホットバー切替 ---
window.addEventListener("wheel", e => {
    selectedHotbarIndex = (selectedHotbarIndex + (e.deltaY > 0 ? 1 : 8)) % 9;
    updateHotbarSelection();
});
window.addEventListener("keydown", e => {
    if (/^[1-9]$/.test(e.key)) {
        selectedHotbarIndex = Number(e.key) - 1;
        updateHotbarSelection();
    }
});

// --- インベントリ表示制御 ---
const inventoryContainer = document.getElementById("inventory-container");
inventoryContainer.style.display = "none";

// --- ポインターロック管理 ---
let pointerLocked = false;
document.addEventListener("pointerlockchange", () => {
    pointerLocked = (document.pointerLockElement === renderer.domElement);
    pointerLocked
        ? window.addEventListener("mousemove", onMouseMove)
        : window.removeEventListener("mousemove", onMouseMove);
});

// --- マウス移動処理 ---
function onMouseMove(e) {
    if (!pointerLocked || inventoryContainer.style.display !== "none") return;
    yaw -= e.movementX * mouseSensitivity;
    pitch = Math.min(Math.max(pitch - e.movementY * mouseSensitivity, -Math.PI / 2), Math.PI / 2);
}

// --- クリックでポインターロック要求 ---
renderer.domElement.addEventListener("click", () => {
    if (!pointerLocked && inventoryContainer.style.display === "none") {
        renderer.domElement.requestPointerLock();
    }
});

// --- Eキーでインベントリ表示切替 ---
window.addEventListener("keydown", e => {
    if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        if (inventoryContainer.style.display === "block") {
            inventoryContainer.style.display = "none";
            renderer.domElement.requestPointerLock();
        } else {
            inventoryContainer.style.display = "block";
            if (pointerLocked) document.exitPointerLock();
        }
    }
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
            case "carpet":
                const carpetHeight = 0.0625; // CUSTOM_COLLISION_CACHE と一致
                center.set(cellCandidate.x + 0.5, cellCandidate.y + carpetHeight / 2, cellCandidate.z + 0.5);
                size.set(1, carpetHeight, 1);
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

    const intersects = [];
    for (const mesh of Object.values(loadedChunks)) {
        if (mesh.isInstancedMesh) {
            mesh.raycast(globalRaycaster, intersects);
        } else {
            const hits = globalRaycaster.intersectObject(mesh, true);
            for (let i = 0; i < hits.length; i++) intersects.push(hits[i]);
        }
    }

    if (!intersects.length) {
        blockInfoElem.style.display = "none";
        return;
    }

    const { face, point } = intersects[0];
    globalTempVec3.set(
        Math.floor(point.x - face.normal.x * 0.5),
        Math.floor(point.y - face.normal.y * 0.5),
        Math.floor(point.z - face.normal.z * 0.5)
    );

    const key = `${globalTempVec3.x}_${globalTempVec3.y}_${globalTempVec3.z}`;
    let blockValue = voxelModifications[key];
    if (blockValue === undefined) {
        blockValue = getVoxelAtWorld(globalTempVec3.x, globalTempVec3.y, globalTempVec3.z);
    }

    const blockName = BLOCK_NAMES[blockValue] || "Unknown";
    const config = getBlockConfiguration(blockValue);
    blockInfoElem.innerHTML = `Block: ${blockName} (Value: ${blockValue})` + (config ? `<br>Type: ${config.geometryType}` : "");
    blockInfoElem.style.display = "block";
}

function updateHeadBlockInfo() {
    const currentHeight = getCurrentPlayerHeight();
    const headY = player.position.y + currentHeight * 0.85;
    const blockPos = [
        Math.floor(player.position.x),
        Math.floor(headY),
        Math.floor(player.position.z),
    ];
    const headBlockKey = blockPos.join('_');

    let blockValue = voxelModifications[headBlockKey];
    if (blockValue === undefined) {
        blockValue = getVoxelAtWorld(...blockPos, globalTerrainCache, true);
    }

    const blockName = BLOCK_NAMES[blockValue] || "Unknown";

    const elem = document.getElementById("headBlockInfo");
    if (elem) {
        elem.textContent = `Head Block: ${blockName} (Value: ${blockValue})`;
        elem.style.display = "block";
    }
}

// --- グローバル改善点 ---
const particlePool = [];
const activeParticleGroups = [];
const GRAVITY = 9.8 * 0.8;

const materialPool = new Map();
let noTextureMaterial = null;

const getOrCreateMaterialForTexture = (texture) => {
    if (!texture) {
        if (!noTextureMaterial) noTextureMaterial = new THREE.MeshLambertMaterial({
            transparent: true, opacity: 1, side: THREE.DoubleSide
        });
        return noTextureMaterial;
    }
    if (materialPool.has(texture)) return materialPool.get(texture);
    const mat = new THREE.MeshLambertMaterial({
        map: texture, transparent: true, opacity: 1, side: THREE.DoubleSide
    });
    materialPool.set(texture, mat);
    return mat;
};

const getCachedParticleGeometry = (i, j, grid, size) => {
    const key = `${grid}_${i}_${j}_${size}`;
    if (geometryCache.has(key)) return geometryCache.get(key);
    const geo = new THREE.PlaneGeometry(size, size).center();
    const uv = geo.attributes.uv.array;
    const [u0, v0] = [i / grid, j / grid];
    const [u1, v1] = [(i + 1) / grid, (j + 1) / grid];
    uv.set([u0, v0, u1, v0, u1, v1, u0, v1]);
    geo.attributes.uv.needsUpdate = true;
    geo.__cached = true;
    geometryCache.set(key, geo);
    return geo;
};

const getPooledParticle = () => {
    const p = particlePool.pop();
    if (p) { p.visible = true; return p; }
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.__cached = false;
    const mat = new THREE.MeshLambertMaterial({ transparent: true, opacity: 1, side: THREE.DoubleSide });
    return new THREE.Mesh(geo, mat);
};

const releasePooledParticle = p => {
    p.userData = {};
    p.visible = false;
    if (p.parent) p.parent.remove(p);
    if (p.geometry && !p.geometry.__cached) { p.geometry.dispose(); p.geometry = null; }
    particlePool.push(p);
};

const createMinecraftBreakParticles = (pos, blockType, lifetime = 3.0) => {
    const grid = 4;
    const size = 0.5 / grid;
    const group = new THREE.Group();
    const texture = getBlockMaterials(blockType)?.[0]?.map || null;
    const sharedMat = getOrCreateMaterialForTexture(texture);

    const offset = new THREE.Vector3();
    const rndVec = new THREE.Vector3();
    const basePos = pos.clone();

    for (let i = 0; i < grid; i++) {
        for (let j = 0; j < grid; j++) {
            for (let k = 0; k < grid; k++) {
                const p = getPooledParticle();
                p.material = sharedMat;
                p.geometry = getCachedParticleGeometry(i, j, grid, size);
                offset.set(
                    (i + 0.5) / grid - 0.5 + (Math.random() - 0.5) * 0.05,
                    (j + 0.5) / grid - 0.5 + (Math.random() - 0.5) * 0.05,
                    (k + 0.5) / grid - 0.5 + (Math.random() - 0.5) * 0.05
                );
                p.position.copy(basePos).add(offset);
                p.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
                rndVec.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
                p.userData = {
                    origin: basePos.clone(),
                    velocity: rndVec.clone(),
                    lifetime: 0.2 + Math.random() * (lifetime - 0.2),
                    elapsed: 0
                };
                group.add(p);
            }
        }
    }

    scene.add(group);
    activeParticleGroups.push(group);
    return group;
};

const updateBlockParticles = delta => {
    const ag = activeParticleGroups;
    for (let gi = ag.length - 1; gi >= 0; gi--) {
        const group = ag[gi];
        const children = group.children;
        for (let pi = children.length - 1; pi >= 0; pi--) {
            const p = children[pi];
            const ud = p.userData;
            ud.elapsed += delta;
            p.position.x += ud.velocity.x * delta;
            p.position.y += ud.velocity.y * delta;
            p.position.z += ud.velocity.z * delta;
            ud.velocity.y -= GRAVITY * delta;

            const landY = getTerrainHeight(ud.origin.x, ud.origin.z, p.position.y);
            if (landY !== -Infinity && p.position.y < landY) {
                p.position.y = landY;
                ud.velocity.y = 0;
                ud.velocity.x *= 0.9;
                ud.velocity.z *= 0.9;
            }

            p.quaternion.copy(camera.quaternion);

            if (ud.elapsed >= ud.lifetime) {
                releasePooledParticle(p);
                group.remove(p);
            }
        }
        if (group.children.length === 0) {
            scene.remove(group);
            ag.splice(gi, 1);
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
const camOffsetVec = new THREE.Vector3();

// タイマー管理用
let cloudUpdateTimer = 0;
let cloudGridTimer = 0;
let underwaterTimer = 0;
let chunkUpdateFrameTimer = 0;  // 自然チャンク更新用
let blockInfoTimer = 0;
let lastBatchSize = 2; // 前フレームのbatchSizeを保持

function getDynamicBatchSize() {
    const elapsed = performance.now() - lastFpsTime;
    if (elapsed === 0) return lastBatchSize;
    const fps = (frameCount * 1000) / elapsed;

    let newBatchSize = lastBatchSize;
    if (fps > 55) newBatchSize = Math.min(lastBatchSize + 1, 6);
    else if (fps > 45) newBatchSize = Math.min(lastBatchSize, 4);
    else newBatchSize = Math.max(lastBatchSize - 1, 1);

    lastBatchSize = newBatchSize;
    return newBatchSize;
}

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();
    const now = performance.now();
    frameCount++;

    // -------- HUD更新（1秒ごと） --------
    if (now - lastFpsTime > 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        fpsCounter.innerHTML = `
            <span>FPS: ${fps}</span><br>
            <span>v0.0.1a (alpha)</span><br>
            <span>Flight: ${flightMode ? "ON" : "OFF"}</span><br>
            <span>Dash: ${dashActive ? "ON" : "OFF"}</span><br>
            <span>Sneak: ${sneakActive ? "ON" : "OFF"}</span><br>
            <span>Pos: (${player.position.x.toFixed(2)},${player.position.y.toFixed(2)},${player.position.z.toFixed(2)})</span>
        `;
        frameCount = 0;
        lastFpsTime = now;
    }

    // -------- プレイヤー操作 & 物理更新 --------
    updateBlockParticles(delta);

    if (!flightMode && keys[" "] && player.onGround && !wasUnderwater) jumpRequest = true;
    camera.rotation.set(pitch, yaw, 0);

    // 水中判定（0.1秒ごと）
    underwaterTimer += delta;
    if (underwaterTimer > 0.1) {
        wasUnderwater = isPlayerEntireBodyInWater();
        underwaterTimer = 0;
    }

    flightMode
        ? updateFlightPhysics(delta)
        : wasUnderwater
            ? updateUnderwaterPhysics(delta)
            : updateNormalPhysics(delta);

    resolvePlayerCollision();
    updateOnGround();

    // -------- チャンク更新 --------
    updateChunks();

    // 自然チャンク更新（周囲生成用）を分散
    chunkUpdateFrameTimer += delta;
    if (chunkUpdateFrameTimer > 0.016) { // 60fps相当
        const batchSize = getDynamicBatchSize();
        processPendingChunkUpdates(batchSize);
        chunkUpdateFrameTimer = 0;
    }

    // -------- カメラ更新 --------
    camOffsetVec.set(0, getCurrentPlayerHeight() - (flightMode ? 0.15 : 0), 0);
    camera.position.copy(player.position).add(camOffsetVec);

    // -------- ブロック情報更新（間引き） --------
    blockInfoTimer += delta;
    if (blockInfoTimer > 0.033) { // 30fps
        updateBlockSelection();
        updateBlockInfo();
        updateHeadBlockInfo();
        blockInfoTimer = 0;
    }

    // -------- クラウド更新 --------
    cloudUpdateTimer += delta;
    cloudGridTimer += delta;

    if (cloudUpdateTimer > 0.05) { // 20fps
        updateCloudTiles(delta);
        updateCloudOpacity(camera.position);
        cloudUpdateTimer = 0;
    }

    if (cloudGridTimer > 0.1) { // 10fps
        cloudTiles.forEach(tile => {
            const distSq = tile.position.distanceToSquared(camera.position);
            if (distSq > 256) return;
            adjustCloudLayerDepth(tile, camera);
        });
        updateCloudGrid(scene, camera.position);
        cloudGridTimer = 0;
    }

    // -------- スクリーンオーバーレイ --------
    updateScreenOverlay();
    resetLastPlacedIfOnGround();

    // -------- 描画 --------
    renderer.render(scene, camera);
}
animate();
