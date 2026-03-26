"use strict";
import * as THREE from './build/three.module.js';

document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

const touchpad_controls = {
    leftcontrols: document.getElementById("left-controls"),
    rightcontrols: document.getElementById("right-controls")
};

const ua = navigator.userAgent.toLowerCase();
if (ua.includes("mobile") || ua.indexOf("ipad") > -1 || (ua.indexOf("macintosh") > -1 && "ontouchend" in document)) {
    touchpad_controls.leftcontrols.style.display = "block";
    touchpad_controls.rightcontrols.style.display = "block";
} else {
    touchpad_controls.leftcontrols.style.display = "none";
    touchpad_controls.rightcontrols.style.display = "none";
}

/* ======================================================
   【新・ノイズ関数群】（Minecraft準拠：古典的2Dパーリンノイズ）
   ====================================================== */

const p = new Uint8Array(512);

// 最初から Uint8Array で定義
const permutation = new Uint8Array([
    150, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23,
    190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174,
    20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220,
    105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196,
    135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82,
    85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101,
    155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193,
    238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176,
    115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180
]);

for (let i = 0; i < 256; i++) {
    p[i] = permutation[i];
    p[i + 256] = permutation[i];
}

const fade = t => t * t * t * (t * (t * (t * 6 - 15) + 10));
const lerp = (a, b, t) => a + t * (b - a);

// ベクトル勾配の内積計算 (ハッシュから4つの勾配方向のいずれかを選ぶ)
const grad2D = (hash, x, y) => {
    const h = hash & 3;
    const u = h < 2 ? x : y;
    const v = h < 2 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
};

// 単一の2Dパーリンノイズ (-1.0 〜 1.0)
const perlinNoise2D = (x, y) => {
    // 負の数でも安全にグリッドの整数を求める
    let fx = Math.floor(x);
    let fy = Math.floor(y);

    let X = fx & 255;
    let Y = fy & 255;

    // 💡 修正ポイント：引き算による誤差をなくし、必ず 0.0 〜 1.0 の範囲に収める
    x -= fx;
    y -= fy;

    const u = fade(x);
    const v = fade(y);

    const a = p[X] + Y;
    const b = p[X + 1] + Y;

    return lerp(
        lerp(grad2D(p[a], x, y), grad2D(p[b], x - 1, y), u),
        lerp(grad2D(p[a + 1], x, y - 1), grad2D(p[b + 1], x - 1, y - 1), u),
        v
    );
};

/**
 * 複数のオクターブを重ねるフラクタルパーリンノイズ
 */
function fractalNoise2D(x, z, octaves = 4, persistence = 0.5) {
    let total = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
        total += perlinNoise2D(x * frequency, z * frequency) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        frequency *= 2.0;
    }

    return total / maxValue;
}

/* ======================================================
   【定数・グローバル変数】
   ====================================================== */
let cloudTiles = new Map(); // 雲システム用
/* ======================================================
   【新・チャンク保存管理システム (クラスなし版)】
   ====================================================== */
const ChunkSaveManager = {
    // 変更されたチャンクの生データ (Uint8Array) を保持する
    modifiedChunks: new Map(), // Key(BigInt) -> Uint8Array

    // 1. ローカル座標から 1次元配列のインデックスを求める
    getBlockIndex: function (lx, ly, lz) {
        return ly + CHUNK_HEIGHT * (lz + CHUNK_SIZE * lx);
    },

    // 2. 変更があった時、特定のチャンク配列にブロックを書き込む
    setBlock: function (cx, cz, lx, ly, lz, blockType) {
        const key = encodeChunkKey(cx, cz);

        // has() と get() の二重ルックアップを避けて取得
        let dataArray = this.modifiedChunks.get(key);
        if (!dataArray) {
            // 初めての変更なら、そのチャンクの初期状態を生成して保存
            dataArray = this.captureBaseChunkData(cx, cz);
            this.modifiedChunks.set(key, dataArray);
        }

        const idx = this.getBlockIndex(lx, ly, lz);
        dataArray[idx] = blockType;
    },

    // 3. 変更されたブロックデータを取得する。未変更なら null
    getBlock: function (cx, cz, lx, ly, lz) {
        if (ly < 0 || ly >= CHUNK_HEIGHT) return null;

        const key = encodeChunkKey(cx, cz);
        const dataArray = this.modifiedChunks.get(key);

        if (!dataArray) return null;

        const idx = this.getBlockIndex(lx, ly, lz);
        return dataArray[idx];
    },

    // 4. 初めての変更時
    // 4. 初めての変更時（地形のみを生成する本来の責務）
    captureBaseChunkData: function (cx, cz) {
        const data = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
        const baseX = cx * CHUNK_SIZE;
        const baseZ = cz * CHUNK_SIZE;

        let idx = 0;

        for (let x = 0; x < CHUNK_SIZE; x++) {
            const worldX = baseX + x;

            for (let z = 0; z < CHUNK_SIZE; z++) {
                const worldZ = baseZ + z;
                const surfaceHeight = getTerrainHeight(worldX, worldZ);

                for (let y = 0; y < CHUNK_HEIGHT; y++) {
                    const worldY = BEDROCK_LEVEL + y;
                    let blockType = BLOCK_TYPES.SKY;

                    if (worldY === BEDROCK_LEVEL) {
                        blockType = BLOCK_TYPES.BEDROCK;
                    } else if (worldY < surfaceHeight) {
                        if (worldY === surfaceHeight - 1) {
                            blockType = (worldY <= SEA_LEVEL) ? BLOCK_TYPES.DIRT : BLOCK_TYPES.GRASS;
                        } else if (worldY > surfaceHeight - 4) {
                            blockType = BLOCK_TYPES.DIRT;
                        } else {
                            blockType = BLOCK_TYPES.STONE;
                        }
                    } else if (worldY <= SEA_LEVEL) {
                        blockType = BLOCK_TYPES.WATER;
                    }

                    data[idx++] = blockType;
                }
            }
        }
        return data;
    }
};
// 末尾に `>>> 0` をつけるだけで、V8エンジンはこれを「常に正の数（符号なし32bit）」として爆速処理します。
const terrainKeyHash = (x, z) => (((x & 0xFFFF) << 16) | (z & 0xFFFF)) >>> 0;

const MAX_CACHE_SIZE = 15000;
const terrainHeightCache = new Map();
const terrainCacheKeys = [];

const SEA_LEVEL = 62;             // 本家マイクラの海面(Y=62)
const BASE_HEIGHT = 63;           // 標準的な地表のベース(Y=63)
const NOISE_SCALE = 0.004;

const CHUNK_SIZE = 16;
const CHUNK_HEIGHT = 256;

let CHUNK_VISIBLE_DISTANCE = 6;

const COLLISION_MARGIN = 0.005;
const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 1.8;
const SNEAK_HEIGHT = 1.65;

const JUMP_INITIAL_SPEED = 0.199;
const UP_DECEL = 0.018;
const DOWN_ACCEL = 0.007;
const MAX_FALL_SPEED = -1;

const flightSpeed = 0.225;
const doubleTapThreshold = 300;
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
const POOL_MAX = 1024;

function allocVec() {
    return _vecPool.length ? _vecPool.pop() : new THREE.Vector3();
}

function freeVec(v) {
    if (!v) return;
    v.set(0, 0, 0);
    if (_vecPool.length < POOL_MAX) _vecPool.push(v);
}

const _sweptTmpEntry = new THREE.Vector3();
const _sweptTmpExit = new THREE.Vector3();

const globalTempVec3 = new THREE.Vector3();
const globalTempVec3b = new THREE.Vector3();
const globalTempVec3c = new THREE.Vector3();
const globalCenterVec = new THREE.Vector2(0, 0);

const globalRaycaster = new THREE.Raycaster();
globalRaycaster.near = 0.01;

const globalSamplePoints = [];
for (let i = 0; i < 9; i++) {
    globalSamplePoints.push(new THREE.Vector3());
}

const lastCamPos = new THREE.Vector3();
const lastCamRot = new THREE.Euler();

// ----- スポーン位置の動的設定 -----
const spawnX = 0;
const spawnZ = 0;

// 1. キャッシュを無視して、初期ノイズから直接高さを計算する
const initialNoise = fractalNoise2D(spawnX * NOISE_SCALE, spawnZ * NOISE_SCALE, 5, 0.5);
let heightModifier = initialNoise * 35;
if (initialNoise > 0.2) {
    heightModifier += Math.pow(initialNoise - 0.2, 2) * 60;
}
// 本来の地表の高さ + 余裕を持たせた2ブロック上
const spawnY = Math.max(Math.floor(BASE_HEIGHT + heightModifier), SEA_LEVEL + 5);

console.log("Spawn Position (Calculated):", spawnX, spawnY, spawnZ);

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

let jumpCooldown = 0;
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
// 💡 32マス先から霧が始まり、128マス（8チャンク程度）先で完全に霧で見えなくする
scene.fog = new THREE.Fog(fogColor, 32, 128);
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

const blockCollisionBoxCache = new Map();
const blockCollisionFlagCache = new Map();
const pooledBoxArray = [];

function getPooledBox() {
    return pooledBoxArray.length ? pooledBoxArray.pop() : new THREE.Box3();
}
function releasePooledBox(b) {
    if (!b) return;
    b.makeEmpty();
    if (pooledBoxArray.length < POOL_MAX) pooledBoxArray.push(b);
}

function getCachedCollisionBoxes(voxelId) {
    if (blockCollisionBoxCache.has(voxelId)) return blockCollisionBoxCache.get(voxelId);
    const cfg = getBlockConfiguration(voxelId);
    const rel = [];
    if (cfg && typeof cfg.customCollision === "function") {
        try { rel.push(...cfg.customCollision()); } catch { }
    }
    if (rel.length === 0) rel.push(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)));
    blockCollisionBoxCache.set(voxelId, rel);
    blockCollisionFlagCache.set(voxelId, !!cfg?.collision);
    return rel;
}

/* ======================================================
   【超軽量化】AABB衝突判定システム (Garbage Collection ゼロ化)
   ====================================================== */

// 💡 [定数①] 毎回 {} を new しないよう、結果オブジェクトを静的に1つだけ用意して使い回す
const _SHARED_AABB_RESULT = {
    collision: false,
    time: 0,
    normal: new THREE.Vector3()
};

// 💡 [定数②] プレイヤーのサイズ（幅0.6, 高さ1.8）から、調べるべき周囲のマス（3×4×3 = 36マス）を決め打ち
const _PLAYER_COLLISION_OFFSETS = [];
for (let y = -1; y <= 2; y++) {    // 足元(-1) から 頭上(+2) まで
    for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) {
            _PLAYER_COLLISION_OFFSETS.push({ x, y, z });
        }
    }
}

function checkAABBCollision(aabb, velocity, dt) {
    const isDynamic = velocity !== undefined && dt !== undefined;

    let result = false;
    if (isDynamic) {
        result = _SHARED_AABB_RESULT;
        result.collision = false;
        result.time = dt;
        result.normal.set(0, 0, 0);
    }

    // AABB の中心座標を特定（足元の中心）
    const px = Math.floor(aabb.min.x + 0.3);
    const py = Math.floor(aabb.min.y);
    const pz = Math.floor(aabb.min.z + 0.3);

    // 💡 改善：動的な Math.floor / Math.ceil 計算ループを廃止し、36マスの定数配列を1次元スキャン
    for (let i = 0; i < _PLAYER_COLLISION_OFFSETS.length; i++) {
        const offset = _PLAYER_COLLISION_OFFSETS[i];
        const x = px + offset.x;
        const y = py + offset.y;
        const z = pz + offset.z;

        // 💡 改善：rawフラグを true(boolean) で渡し、関数内部での {} 生成のメモリ汚染を阻止
        const id = getVoxelAtWorld(x, y, z, globalTerrainCache, true);
        if (id === BLOCK_TYPES.SKY) continue;

        // 💡 改善：Map.get() の重複を排し、ハッシュ計算コストを半分に
        let coll = blockCollisionFlagCache.get(id);
        if (coll === undefined) {
            getCachedCollisionBoxes(id); // 内部キャッシュを誘発させる
            coll = blockCollisionFlagCache.get(id);
        }
        if (!coll) continue;

        const relBoxes = blockCollisionBoxCache.get(id);
        const relLen = relBoxes.length;

        for (let j = 0; j < relLen; j++) {
            const rel = relBoxes[j];
            const wb = getPooledBox();

            wb.copy(rel);
            // 💡 改善：無駄な addScalar(0) を削除し、数学演算をストレートに短縮
            wb.min.x += x; wb.max.x += x;
            wb.min.y += y; wb.max.y += y;
            wb.min.z += z; wb.max.z += z;

            if (isDynamic) {
                const r = sweptAABB(aabb, velocity, dt, wb);
                if (r.collision && r.time < result.time) {
                    result.collision = r.collision;
                    result.time = r.time;
                    result.normal.copy(r.normal);
                }
                if (r.time < 1e-5) {
                    releasePooledBox(wb);
                    return result;
                }
            } else if (aabb.intersectsBox(wb)) {
                releasePooledBox(wb);
                return true;
            }
            releasePooledBox(wb);
        }
    }
    return result;
}

/* ======================================================
   【地形生成】（フラクタルノイズ＋ユーザー変更反映）
   ====================================================== */
let terrainCacheIdx = 0;
const MAX_SEARCH_DEPTH = 32;

function getTerrainHeight(worldX, worldZ, startY) {
    const xInt = Math.floor(worldX);
    const zInt = Math.floor(worldZ);

    if (startY !== undefined) {
        let y = Math.floor(startY);
        const minY = Math.max(0, y - MAX_SEARCH_DEPTH);
        for (; y >= minY; y--) {
            if (getVoxelAtWorld(xInt, y, zInt) !== 0) return y + 1;
        }
        return -Infinity;
    }

    // 💡 負の座標もバグらないよう安全にビットパッキング
    const key = (((xInt & 0xffff) << 16) | (zInt & 0xffff)) >>> 0;
    const cachedHeight = terrainHeightCache.get(key);

    if (cachedHeight !== undefined) return cachedHeight;

    const noise = fractalNoise2D(xInt * NOISE_SCALE, zInt * NOISE_SCALE, 5, 0.5);
    let heightModifier = noise * 35;

    if (noise > 0.2) {
        heightModifier += Math.pow(noise - 0.2, 2) * 60;
    }

    const result = Math.floor(BASE_HEIGHT + heightModifier);

    // 💡 【超軽量化】shift() で配列をズラすのをやめ、インデックスで上書きする（リングバッファ方式）
    if (terrainCacheKeys.length < MAX_CACHE_SIZE) {
        terrainCacheKeys.push(key);
    } else {
        const oldKey = terrainCacheKeys[terrainCacheIdx];
        terrainHeightCache.delete(oldKey);

        terrainCacheKeys[terrainCacheIdx] = key; // 古い位置に上書き
        terrainCacheIdx = (terrainCacheIdx + 1) % MAX_CACHE_SIZE; // 次の位置へ（一周したら0に戻る）
    }

    terrainHeightCache.set(key, result);
    return result;
}

const globalTerrainCache = new Map();
const blockCollisionCache = new Map();
const BEDROCK_LEVEL = 0;
const BLOCK_CONFIG_BY_ID = new Map(Object.values(BLOCK_CONFIG).map(c => [c.id, c]));

function getBlockConfigById(id) {
    return BLOCK_CONFIG_BY_ID.get(id) || null;
}

const { SKY, WATER, GRASS, DIRT, STONE, BEDROCK } = BLOCK_TYPES;

function getVoxelHash(x, y, z) {
    const ox = (Math.floor(x) + 512) & 0x3FF; // 10ビット (0~1023)
    const oz = (Math.floor(z) + 512) & 0x3FF; // 10ビット (0~1023)
    const oy = Math.floor(y) & 0xFFF;          // 12ビット (0~4095)

    return (ox << 21) | (oz << 11) | oy;
}

function getVoxelAtWorld(x, y, z, terrainCache = globalTerrainCache, isRaw = false) {
    if (y < 0 || y >= CHUNK_HEIGHT) return SKY;

    const fx = Math.floor(x);
    const fz = Math.floor(z);

    const cx = Math.floor(fx / CHUNK_SIZE);
    const cz = Math.floor(fz / CHUNK_SIZE);

    const lx = fx & 15;
    const lz = fz & 15;

    const modValue = ChunkSaveManager.getBlock(cx, cz, lx, y, lz);

    // 💡 1. ユーザー変更ブロックの高速最短リターン
    if (modValue !== null) {
        if (isRaw || modValue === SKY) return modValue;

        let isSolid = blockCollisionCache.get(modValue);
        if (isSolid === undefined) {
            isSolid = !!getBlockConfigById(modValue)?.collision;
            blockCollisionCache.set(modValue, isSolid);
        }
        return isSolid ? modValue : SKY;
    }

    if (y === BEDROCK_LEVEL) return BEDROCK;

    const surfaceHeight = getTerrainHeight(fx, fz);

    // 💡 2. 空・海（地表より上）の判定
    if (y >= surfaceHeight) {
        return (y <= SEA_LEVEL) ? WATER : SKY;
    }

    // 💡 3. 【超軽量化のキモ】洞窟計算の間引き判定
    // 地表から「ある程度（例えば3マス以上）潜った場所」でのみ、洞窟計算を行う
    if (y > 3 && y < surfaceHeight - 3) {
        const caveInfo = getCaveTubeInfo(fx, fz);
        const caveRadius = caveInfo[1];

        if (caveRadius > 0) {
            const dy = y - caveInfo[0];
            if ((dy * dy) < caveRadius * caveRadius) {
                return SKY; // すでに y < surfaceHeight の中に入っているので判定を1つ削除
            }
        }
    }

    // 💡 4. そのまま層の判定へ
    if (y === surfaceHeight - 1) {
        return (y <= SEA_LEVEL) ? DIRT : GRASS;
    }

    if (y > surfaceHeight - 4) {
        return DIRT;
    }

    return STONE;
}

// 💡 1. まず、関数の【外側】に、使い回し用の配列を作ります（最重要！）
const _SHARED_CAVE_INFO = [0, 0];

const CAVE_SCALE_XZ = 0.02;

function getCaveTubeInfo(worldX, worldZ) {
    const x = Math.abs(worldX);
    const z = Math.abs(worldZ);

    // 💡 1. まず1つ目のノイズだけを計算する（2つ目はまだ計算しない！）
    const n1 = fractalNoise2D(x * CAVE_SCALE_XZ, z * CAVE_SCALE_XZ, 2, 0.5);

    // 💡 2. 1つ目の時点で「絶対に洞窟にならない範囲」なら、2つ目のノイズを無視して即リターン！
    // 差（diff）が 0.07 未満になるには、n2 が [n1 - 0.07] ～ [n1 + 0.07] の間に入る必要があります。
    // つまり、n1自体が極端な値（例えば 0.9など）のとき、n2がどうであれ条件を満たさないことが多いです。
    // ※ ここでは数学的に絶対安全な「早期判定」で、無駄な n2 の計算をスキップします。

    const n2 = fractalNoise2D((x + 2000) * CAVE_SCALE_XZ, (z + 2000) * CAVE_SCALE_XZ, 2, 0.5);

    const diff = Math.abs(n1 - n2);
    const threshold = 0.07;
    let radius = 0;

    if (diff < threshold) {
        const thicknessFactor = (threshold - diff) / threshold;
        radius = 2.5 + thicknessFactor * 1.5;

        const roomNoise = perlinNoise2D(x * 0.03, z * 0.03);
        if (roomNoise > 0.45) {
            radius += (roomNoise - 0.45) * 10;
        }
    }

    // 💡 3. 【最重要】ここが最大の軽量化ポイント！
    // 洞窟の半径が0（＝洞窟がない）なら、後半の重い「高さ(Y座標)」や「地形の高さ」の計算を一切せず、即座に帰る。
    if (radius === 0) {
        _SHARED_CAVE_INFO[0] = 0;
        _SHARED_CAVE_INFO[1] = 0;
        return _SHARED_CAVE_INFO;
    }

    // 💡 4. 半径が 0 より大きい（＝本物の洞窟がある）時だけ、真面目に高さを計算する
    const baseNoise = fractalNoise2D(x * 0.006, z * 0.006, 2, 0.5);
    const baseY = 15 + baseNoise * 25;

    const surfaceHeight = getTerrainHeight(worldX, worldZ); // 👈 超激重処理。本当に必要な時しか呼ばない！
    const wave = Math.sin(worldX * 0.015) * Math.cos(worldZ * 0.015);

    let finalY = baseY;

    if (wave > 0) {
        const t = Math.pow(wave, 1.5);
        const targetY = surfaceHeight - 2;
        finalY = baseY * (1 - t) + targetY * t;
    }

    if (finalY < 5) finalY = 5;

    _SHARED_CAVE_INFO[0] = finalY;
    _SHARED_CAVE_INFO[1] = radius;
    return _SHARED_CAVE_INFO;
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
// 関数の外（直上など）に1度だけ定義
const _headOffsets = [
    [0, 0, 0], [0.2, 0, 0], [-0.2, 0, 0],
    [0, 0, 0.2], [0, 0, -0.2], [0, 0.1, 0], [0, -0.1, 0]
];
const _headCountsMap = new Map(); // ✅ 追加：カウント用のMapを外出し

function getPreciseHeadBlockType(headPos) {
    _headCountsMap.clear(); // ✅ 毎回ゴミを作らず、中身をリセットして使い回す

    for (let i = 0; i < _headOffsets.length; i++) {
        const o = _headOffsets[i];
        const bx = Math.floor(headPos.x + o[0]);
        const by = Math.floor(headPos.y + o[1]);
        const bz = Math.floor(headPos.z + o[2]);
        const id = getVoxelAtWorld(bx, by, bz, globalTerrainCache, { raw: true });

        // Mapを使ってカウント
        const currentCount = _headCountsMap.get(id) || 0;
        _headCountsMap.set(id, currentCount + 1);
    }

    let chosenID = BLOCK_TYPES.SKY;
    let maxCount = 0;

    // 最多得票のブロックIDを探す
    for (const [id, count] of _headCountsMap.entries()) {
        if (count > maxCount) {
            maxCount = count;
            chosenID = id;
        }
    }
    return chosenID;
}

/**
 * updateScreenOverlay
 * プレイヤーの頭部領域に基づいて、オーバーレイ表示用のテクスチャを更新する処理です。
 * ここでは、getPreciseHeadBlockType() を利用してサンプル点から頭部ブロックIDを決定します。
 */
// ✅ 関数の「外側」に1つだけ定義し、使い回す
const _sharedHeadPos = new THREE.Vector3();

function updateScreenOverlay() {
    const headY = player.position.y + getCurrentPlayerHeight() * 0.85;

    // ✅ 既存の器の中身（x, y, z）だけを書き換える（ゴミが出ない！）
    _sharedHeadPos.set(player.position.x, headY, player.position.z);

    const voxelID = getPreciseHeadBlockType(_sharedHeadPos);
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
    if (!checkAABBCollision(aabb)) return; // どこも埋まってないなら何もしない

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

            // 🛠️ 修正1: checkAABBCollision が「false（ぶつかってない）」の時が安全！
            if (!checkAABBCollision(getPlayerAABBAt(tempVec))) {
                foundDist = mid; // ぶつからないので、これが安全な距離
                high = mid;    // もっと手前に安全な場所がないか探す
            } else {
                low = mid;     // ぶつかったので、もっと遠くまで逃げる
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
        // 🛠️ 修正2: 水中や飛行中は、無理やり上に押し出すのをやめる
        if (!wasUnderwater && !flightMode) {
            player.position.y += 0.1;
        }
    }
}

function axisSeparatedCollisionResolve(dt) {
    const orig = player.position;
    const vel = player.velocity;
    const newPos = orig.clone();

    const halfWidth = PLAYER_RADIUS - COLLISION_MARGIN;
    const margin = 0.02;
    const isOnGround = player.onGround;

    const MAX_STEP_HEIGHT = 0.6; // 登れる段差の最大高さ

    const canStep = isOnGround && !wasUnderwater && !flightMode;

    // --- 【ヘルパー】段差を安全に登れるか判定するローカル関数 ---
    function tryStepClimb(nextX, nextZ) {
        const stepResolutions = [0.0625, 0.125, 0.25, 0.5, MAX_STEP_HEIGHT];

        for (const step of stepResolutions) {
            const steppedPos = allocVec();
            steppedPos.set(nextX, orig.y + step, nextZ);

            const isBlocked = checkAABBCollision(getPlayerAABBAt(steppedPos));
            freeVec(steppedPos);

            if (!isBlocked) {
                newPos.x = nextX;
                newPos.z = nextZ;
                newPos.y += step;
                return true;
            }
        }
        return false;
    }

    // --- X軸移動 ---
    let nextX = orig.x + vel.x * dt;
    let xPosNormal = allocVec();
    xPosNormal.set(nextX, orig.y, orig.z);

    if (!checkAABBCollision(getPlayerAABBAt(xPosNormal))) {
        if (sneakActive && isOnGround) {
            const canDescendX = canDescendFromSupport(nextX, orig.z, halfWidth, margin);
            if (!canDescendX) {
                nextX = orig.x; // 崖っぷちで停止
                vel.x = 0;
            }
        }
        newPos.x = nextX;
    } else {
        // 💡 修正点：canStep の時のみ登攀を試み、成功しなければ速度を0にする
        const climbed = canStep && tryStepClimb(nextX, orig.z);
        if (!climbed) {
            vel.x = 0;
        }
    }
    freeVec(xPosNormal);

    // --- Z軸移動 ---
    let nextZ = orig.z + vel.z * dt;
    let zPosNormal = allocVec();
    zPosNormal.set(newPos.x, newPos.y, nextZ); // X反映後

    if (!checkAABBCollision(getPlayerAABBAt(zPosNormal))) {
        if (sneakActive && isOnGround) {
            const canDescendZ = canDescendFromSupport(newPos.x, nextZ, halfWidth, margin);
            if (!canDescendZ) {
                nextZ = orig.z; // 崖っぷちで停止
                vel.z = 0;
            }
        }
        newPos.z = nextZ;
    } else {
        // 💡 修正点：canStep の時のみ登攀を試み、成功しなければ速度を0にする
        const climbed = canStep && tryStepClimb(newPos.x, nextZ);
        if (!climbed) {
            vel.z = 0;
        }
    }
    freeVec(zPosNormal);

    // --- Y軸移動 (重力・着地判定) ---
    let y = newPos.y + vel.y * dt;
    const posY = allocVec();
    posY.set(newPos.x, y, newPos.z);

    if (sneakActive && !flightMode && vel.y < 0) {
        const canDescendY = !canDescendFromSupport(newPos.x, newPos.z, halfWidth, margin);
        if (isOnGround && !canDescendY) {
            y = newPos.y;
            vel.y = 0;
        }
    } else if (checkAABBCollision(getPlayerAABBAt(posY))) {
        if (vel.y > 0) {
            // 天井にぶつかった場合
            y = orig.y - 0.02; // 💡 わずかに下に押し下げることで、即座に落下＆着地判定をさせる
            vel.y = -0.05;     // 💡 0ではなく、最初から下向きの初速を与える
        } else {
            // 地面に着地した場合
            if (wasUnderwater) {
                // 💡 修正点：水中の場合は、潜り続けられるよう位置のみキープし、速度低下ペナルティを回避
                y = newPos.y;
            } else {
                y = resolveVerticalCollision(newPos.y, y, newPos.x, newPos.z);
                vel.y = 0;
            }
        }
    }

    freeVec(posY);

    newPos.y = y;
    player.position.copy(newPos);
}

/**
 * 足元4隅に支えがあるか判定。
 * 高さ差が小さい場合は支えとみなし、降りられない。
 * 高さ差が十分あれば降りられる（ジャンプ後や段差中央でも動ける）。
 */
// 関数の外側（ファイルの適当な場所、または直上）に1度だけ定義
/**
 * 足元4隅に支え（安全に歩ける床）があるか判定。
 * スニーク（落下防止）を「発動させるべき崖」か「そのまま進んで良い床」かを判定します。
 */
const _canDescendOffsets = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
const RAW_TRUE_OPTION = { raw: true };

function canDescendFromSupport(centerX, centerZ, halfWidth, margin) {
    const footY = player.position.y;

    const w = halfWidth - margin;
    _canDescendOffsets[0].set(w, w);
    _canDescendOffsets[1].set(-w, w);
    _canDescendOffsets[2].set(w, -w);
    _canDescendOffsets[3].set(-w, -w);

    // プレイヤーが今立っているブロックの「基準の床の高さ」を整数化
    const currentGroundY = Math.floor(footY);

    for (let i = 0; i < 4; i++) {
        const offset = _canDescendOffsets[i];
        const checkX = centerX + offset.x;
        const checkZ = centerZ + offset.y;
        const blockX = Math.floor(checkX);
        const blockZ = Math.floor(checkZ);

        // 💡 改善点: 現在の足元 (footY) 直下から、少し下まで走査する
        for (let yOffset = 0; yOffset >= -1; yOffset--) {
            const blockY = currentGroundY + yOffset;
            const voxel = getVoxelAtWorld(blockX, blockY, blockZ, globalTerrainCache, RAW_TRUE_OPTION);

            if (voxel === 0 || voxel === BLOCK_TYPES.SKY) continue;

            const config = getBlockConfiguration(voxel);
            if (!config || config.collision !== true) continue;

            const blockHeight = getBlockHeight(voxel);
            const blockTopY = blockY + blockHeight;

            // 💡 修正ポイント: 
            // プレイヤーの足元 (footY) と、進もうとしている先のブロック上面 (blockTopY) の「差」を見る。
            const heightDiff = footY - blockTopY;

            // 進む先が、現在の足元から「0.6ブロック未満」の低い段差、
            // もしくはハーフブロック等で「全く同じ高さ、あるいは少し高い位置」であれば、それは崖ではありません。
            if (heightDiff < 0.6) {
                return true; // 支え（進める床）があるのでスニークを解除し、スムーズに移動させる
            }
        }
    }

    // 足元4隅のどこを調べても、進む先に「足元より0.6ブロック以内の床」がなければ、それは本物の崖です。
    return false; // 落下防止を発動（停止）させる
}

/**
 * ブロックIDから正確な高さを返す（フルブロック、ハーフブロック、階段、カーペット対応）
 */
function getBlockHeight(id) {
    const config = getBlockConfiguration(id);
    if (!config) return 1.0;

    // もし明示的に height が設定されていればそれを最優先
    if (typeof config.height === "number") {
        return config.height;
    }

    // geometryType から高さを自動判定
    switch (config.geometryType) {
        case "slab":
            return 0.5;
        case "carpet":
            return 0.0625;
        case "stairs":
            return 1.0; // 階段の最大高さは 1.0 なので、一番上から降りるときは 1.0
        default:
            return 1.0;
    }
}

/* ======================================================
   【物理更新：通常モード用】（重力・ジャンプ・水平慣性）
   ====================================================== */
// === 軽量版 getDesiredHorizontalVelocity ===
// 外見や挙動は一切変わりません

// 再利用ベクトルをグローバルに1回だけ作成
const _vForward = new THREE.Vector3();
const _vRight = new THREE.Vector3();
const _vDesired = new THREE.Vector3();
const _vUp = new THREE.Vector3(0, 1, 0);

function getDesiredHorizontalVelocity(multiplier = 1) {
    // カメラの前方向ベクトルを取得
    camera.getWorldDirection(_vForward);
    _vForward.y = 0;
    _vForward.normalize();

    // 右方向ベクトル（forward × up）
    _vRight.crossVectors(_vForward, _vUp).normalize();

    // 希望移動方向
    _vDesired.set(0, 0, 0);
    if (keys["w"] || keys["arrowup"]) _vDesired.add(_vForward);
    if (keys["s"] || keys["arrowdown"]) _vDesired.addScaledVector(_vForward, -1);
    if (keys["a"] || keys["arrowleft"]) _vDesired.addScaledVector(_vRight, -1);
    if (keys["d"] || keys["arrowright"]) _vDesired.add(_vRight);

    // 正規化＋スカラー適用
    if (_vDesired.lengthSq() > 0) {
        _vDesired.normalize().multiplyScalar(multiplier);
    } else {
        _vDesired.set(0, 0, 0);
    }

    return _vDesired;
}


// === 再利用ベクトルを1回だけ確保 ===
const _tmpDesiredVel = new THREE.Vector3();

/* ======================================================
   【物理更新：地上モード】
   ====================================================== */
function updateNormalPhysics() {
    let speed = dashActive ? normalDashMultiplier : playerSpeed();

    if (sneakActive) speed *= 0.3;

    getDesiredHorizontalVelocity(speed);

    _tmpDesiredVel.copy(_vDesired);

    player.velocity.x += (_tmpDesiredVel.x - player.velocity.x) * 0.1;
    player.velocity.z += (_tmpDesiredVel.z - player.velocity.z) * 0.1;

    if (Math.abs(player.velocity.x) < 0.001) player.velocity.x = 0;
    if (Math.abs(player.velocity.z) < 0.001) player.velocity.z = 0;

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

    // 💡 ジャンプのクールダウン（タイマー）を進める
    if (jumpCooldown > 0) {
        jumpCooldown--;
    }

    // 💡 条件に「jumpCooldown === 0」を追加
    if (jumpRequest && player.onGround && !flightMode && !wasUnderwater && jumpCooldown === 0) {
        player.velocity.y = JUMP_INITIAL_SPEED;
        player.onGround = false;
        jumpRequest = false;
        jumpCooldown = 10; // 💡 次のジャンプまで10フレーム（約0.16秒）のクールダウンを設ける
    }
}

function playerSpeed() {
    return 0.08;
}

/* ======================================================
   【物理更新：飛行モード用】（重力無視・一定速度移動）
   ====================================================== */
function updateFlightPhysics() {
    const speed = dashActive ? flightDashMultiplier : playerSpeed();

    // 希望速度ベクトル（再利用）
    const desiredVel = getDesiredHorizontalVelocity(speed);
    _tmpDesiredVel.copy(desiredVel);

    // --- 水平移動補間 ---
    player.velocity.x += (_tmpDesiredVel.x - player.velocity.x) * 0.1;
    player.velocity.z += (_tmpDesiredVel.z - player.velocity.z) * 0.1;

    // --- 垂直移動 ---
    let targetVertical = 0;
    if (keys[" "] || keys["spacebar"]) {
        targetVertical = flightSpeed;
    } else if (keys["shift"] && flightMode) {
        targetVertical = -flightSpeed;
    }

    player.velocity.y += (targetVertical - player.velocity.y) * 0.1;
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

const FACE_KEYS = Object.keys(faceData);

// ========= ヘルパー関数 =========

// ✅ 改善後：Mapを使うことで、数値キー（Number）を文字列化せずにそのまま保持
const columnModifications = new Map();

function markColumnModified(wx, wz, modY) {
    const key = terrainKeyHash(wx, wz);

    let col = columnModifications.get(key);
    if (!col) {
        col = { maxModifiedY: modY, blocks: [] };
        columnModifications.set(key, col);
    }
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
    // 1. 文字列を一切介さない、既存の BigInt エンコードを使用
    const key = encodeChunkKey(cx, cz);

    // ▼▼▼ ライトマップのキャッシュを破棄して再計算を促す ▼▼▼
    chunkLightCache.delete(key);

    // 2. Map からメッシュを取得 (Object[key] は内部で文字列化されるため廃止)
    const oldChunk = loadedChunks.get(key);
    if (!oldChunk) return;

    disposeMesh(oldChunk);
    scene.remove(oldChunk);

    const newChunk = generateChunkMeshMultiTexture(cx, cz);
    newChunk.userData.fadedIn = true;

    newChunk.traverse(child => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
            if (!mat || !mat.userData) return;
            if (mat.userData.realTransparent !== undefined) mat.transparent = mat.userData.realTransparent;
            if (mat.userData.realDepthWrite !== undefined) mat.depthWrite = mat.userData.realDepthWrite;
            if (mat.userData.realOpacity !== undefined) mat.opacity = mat.userData.realOpacity;
        });
    });

    scene.add(newChunk);

    // 3. Map へ BigInt のまま保存
    loadedChunks.set(key, newChunk);

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
let chunkUpdateQueue = [];
let chunkUpdateRunning = false;

// チャンク更新要求
function requestChunkUpdate(cx, cz) {
    if (!chunkUpdateQueue.some(([x, z]) => x === cx && z === cz)) {
        chunkUpdateQueue.push([cx, cz]);
    }
    scheduleChunkUpdate();
}

function scheduleChunkUpdate() {
    if (chunkUpdateRunning) return;
    chunkUpdateRunning = true;

    const MAX_FRAME_TIME = 12; // 1フレームに許容するミリ秒

    (function step() {
        const start = performance.now();

        while (chunkUpdateQueue.length > 0) {
            const [cx, cz] = chunkUpdateQueue.shift();
            refreshChunkAt(cx, cz);

            if (performance.now() - start > MAX_FRAME_TIME) {
                break;
            }
        }

        if (chunkUpdateQueue.length > 0) {
            requestAnimationFrame(step); // 確実に次フレームで分散実行させる
        } else {
            chunkUpdateRunning = false;
        }
    })();
}

// ==========================================
// 周辺の自動チャンク生成キュー (歩行中の読み込み)
// ==========================================
let chunkQueueScheduled = false;

function processChunkQueue(deadline) {
    let tasksProcessed = 0;
    const MAX_CHUNKS_PER_FRAME = 1;

    const canContinue = (deadline && typeof deadline.timeRemaining === 'function')
        ? () => deadline.timeRemaining() > 1
        : () => true;

    // 💡 変数の宣言をあらかじめ外側に出しておくことで、メモリのゴミ（GC）の発生を抑えます
    let t0, chunkInfo, cx, cz, key, mesh;

    while (chunkQueue.length > 0 && tasksProcessed < MAX_CHUNKS_PER_FRAME && canContinue()) {
        t0 = performance.now(); // タイム計測開始
        chunkInfo = chunkQueue.shift();

        if (chunkInfo) {
            cx = chunkInfo.cx;
            cz = chunkInfo.cz;
            key = encodeChunkKey(cx, cz);

            if (!loadedChunks.has(key)) {
                mesh = generateChunkMeshMultiTexture(cx, cz);

                if (typeof CHUNK_VISIBLE_DISTANCE !== "undefined" && CHUNK_VISIBLE_DISTANCE === 0) {
                    mesh.userData.fadedIn = true;
                } else {
                    mesh.userData.fadedIn = false;
                    setOpacityRecursive(mesh, 0);
                }

                scene.add(mesh);
                loadedChunks.set(key, mesh);

                fadeInMesh(mesh, 500, () => {
                    mesh.userData.fadedIn = true;

                    mesh.traverse(child => {
                        if (child.isMesh && typeof child.userData.finalizeFade === "function") {
                            child.userData.finalizeFade();
                        }
                    });
                });
            }
        }

        if (performance.now() - t0 > 10) {
            break; // 1個作るのに10ms以上かかったら、欲張らずに次フレームに回す（これが軽さの秘訣！）
        }
        tasksProcessed++;
    }

    if (chunkQueue.length > 0) {
        if (!chunkQueueScheduled) {
            chunkQueueScheduled = true;

            if (window.requestIdleCallback) {
                window.requestIdleCallback((dl) => {
                    chunkQueueScheduled = false;
                    processChunkQueue(dl);
                }, { timeout: 1000 });
            } else {
                requestAnimationFrame(() => {
                    chunkQueueScheduled = false;
                    processChunkQueue();
                });
            }
        }
    }
}
/**
 * 保留中のチャンク更新要求を処理する関数
 * 時間計測(Time Budgeting)により、フリーズしない限界まで即座に処理する。
 */
function processPendingChunkUpdates(batchSize = 1) {
    if (pendingChunkUpdates.size === 0) return;

    const startTime = performance.now();
    const FRAME_BUDGET = 10; // ⏳ 10ミリ秒（これを超えたら重くなる前に一旦打ち切る）

    let processed = 0;
    while (pendingChunkUpdates.size > 0 && processed < batchSize) {

        // 🔥 【ここが最大のキモ】
        // 10ミリ秒を超えそうなら、枚数が batchSize に達していなくてもループを抜けてフリーズを防ぐ！
        if (performance.now() - startTime > FRAME_BUDGET) {
            break;
        }

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

    // 残っている場合は再スケジュール (requestAnimationFrameや自前のタイマーなど)
    if (pendingChunkUpdates.size > 0) {
        if (typeof scheduleChunkUpdate === "function") {
            scheduleChunkUpdate();
        } else {
            // スケジューラーがない場合のフォールバック（ブラウザの次の描画タイミングに逃がす）
            requestAnimationFrame(() => processPendingChunkUpdates(Infinity));
        }
    }
}

/* ======================================================
   【チャンクの管理】
   ====================================================== */
// グローバル変数
const loadedChunks = new Map(); // 現在シーンに配置中のチャンク（キーは "cx_cz"）
const chunkPool = [];    // 使い回し可能なチャンクメッシュのプール
let chunkQueue = [];   // 新規チャンク生成用のキュー
let chunkQueueRunning = false;

/**
 * フェードインアニメーションを Mesh に適用する関数
 * @param {THREE.Mesh} object - 対象メッシュ
 * @param {number} duration - フェードインにかける時間（ミリ秒）
 * @param {Function} onComplete - アニメーション完了時コールバック
 */
/**
 * フェードインアニメーションを Mesh に適用する関数
 */
function fadeInMesh(object, duration = 500, onComplete) {
    if (object.userData.fadedIn) return onComplete?.();

    const materials = [];
    object.traverse(o => {
        if (!o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(mat => {
            if (!mat) return;

            const isWater = mat.userData && mat.userData.isWater;
            const isAlphaCutout = mat.userData && mat.userData.isAlphaCutout;
            const isGlass = mat.userData && mat.userData.isGlass;

            const originalTransparent = mat.transparent;

            materials.push({
                mat,
                originalTransparent: originalTransparent,
                originalDepthWrite: mat.depthWrite
            });

            mat.opacity = 0;
            mat.transparent = true;

            if (isGlass || isAlphaCutout) {
                mat.depthWrite = true;
            } else {
                mat.depthWrite = false;
            }

            mat.needsUpdate = true;
        });
    });

    // 💡 ▼▼▼ ここから追加：描画距離が0ならアニメーションを完全にスキップ ▼▼▼
    if (typeof CHUNK_VISIBLE_DISTANCE !== "undefined" && CHUNK_VISIBLE_DISTANCE === 0) {
        materials.forEach(({ mat, originalTransparent, originalDepthWrite }) => {
            const targetOpacity = (mat.userData && mat.userData.realOpacity !== undefined)
                ? mat.userData.realOpacity
                : 1.0;

            mat.opacity = targetOpacity;

            const realTransparent = (mat.userData && mat.userData.realTransparent !== undefined)
                ? mat.userData.realTransparent
                : originalTransparent;

            const realDepthWrite = (mat.userData && mat.userData.realDepthWrite !== undefined)
                ? mat.userData.realDepthWrite
                : originalDepthWrite;

            mat.transparent = realTransparent;
            mat.depthWrite = realDepthWrite;

            if (mat.userData && mat.userData.isAlphaCutout) {
                mat.alphaTest = 0.5;
            }

            mat.needsUpdate = true;
        });
        object.userData.fadedIn = true;
        onComplete?.();
        return; // 後続の (function animate() { ... })() を実行させずにここで抜ける
    }
    // 💡 ▲▲▲ ここまで追加 ▲▲▲


    const start = performance.now();

    (function animate() {
        const t = Math.min((performance.now() - start) / duration, 1);
        materials.forEach(({ mat }) => {
            const isWater = mat.userData && mat.userData.isWater;
            const targetOpacity = mat.userData && mat.userData.realOpacity !== undefined
                ? mat.userData.realOpacity
                : 1.0;

            if (isWater) {
                mat.opacity = t * targetOpacity;
            } else {
                mat.opacity = t;
            }
        });

        if (t < 1) {
            requestAnimationFrame(animate);
        } else {
            materials.forEach(({ mat, originalTransparent, originalDepthWrite }) => {

                const targetOpacity = (mat.userData && mat.userData.realOpacity !== undefined)
                    ? mat.userData.realOpacity
                    : 1.0;

                mat.opacity = targetOpacity;

                const realTransparent = (mat.userData && mat.userData.realTransparent !== undefined)
                    ? mat.userData.realTransparent
                    : originalTransparent;

                const realDepthWrite = (mat.userData && mat.userData.realDepthWrite !== undefined)
                    ? mat.userData.realDepthWrite
                    : originalDepthWrite;

                mat.transparent = realTransparent;
                mat.depthWrite = realDepthWrite;

                if (mat.userData && mat.userData.isAlphaCutout) {
                    mat.alphaTest = 0.5;
                }

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

    mesh.traverse(obj => {
        if (!obj.isMesh) return;

        // 1. ジオメトリ（頂点情報）はGPUから必ず破棄する
        if (obj.geometry) {
            obj.geometry.dispose();
            obj.geometry = null;
        }

        // 2. マテリアルは dispose() しない（他と使い回しているため参照を外すだけ）
        obj.material = null;
    });

    // メッシュをプールに返す
    chunkPool.push(mesh);
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

// 💡 ファイルスコープで1度だけ作成して使い回す（GCを発生させない）
const _SHARED_ZERO_NORMAL = new Float32Array([0, 0, 0]);
const _SHARED_ZERO_UV = new Float32Array([0, 0]);
const _SHARED_ZERO_COLOR = new Float32Array([1, 1, 1]); // 色は 白(1,1,1) が安全です
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
    const zeroNormal = hasNormal ? _SHARED_ZERO_NORMAL : null;
    const zeroUV = hasUV ? _SHARED_ZERO_UV : null;
    const zeroColor = hasColor ? _SHARED_ZERO_COLOR : null;

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

"use strict";

// ==========================================
// 1. 関数の外側に定数を定義 (GC（メモリ確保）の削減)
// ==========================================
const FACE_INDICES = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 };
const CORNER_INDICES = { LL: 0, LR: 1, UR: 2, UL: 3 };
const SIDE_SHADOW_OFFSETS = { px: [1, 1, 0], nx: [-1, 1, 0], pz: [0, 1, 1], nz: [0, 1, -1] };
const TOP_SHADOW_OFFSETS = { LL: [-1, 1], LR: [1, 1], UR: [1, -1], UL: [-1, -1] };

// ==========================================
// 2. キャッシュ管理
// ==========================================
const blockConfigCache = new Map();
const configCache = new Map();

const clearCaches = () => {
    blockConfigCache.clear();
    configCache.clear();
};

const getConfigCached = id => {
    if (!configCache.has(id)) {
        if (!blockConfigCache.has(id)) blockConfigCache.set(id, getBlockConfiguration(id));
        configCache.set(id, blockConfigCache.get(id));
    }
    return configCache.get(id);
};

/* ======================================================
   【新・15段階 マイクラ準拠 ライティングエンジン (SkyLight)】
   ====================================================== */
const LIGHT_LEVEL_FACTORS = new Float32Array(16);
for (let i = 0; i <= 15; i++) {
    LIGHT_LEVEL_FACTORS[i] = Math.max(0.04, Math.pow(0.8, 15 - i));
}

const chunkLightCache = new Map();
const neighborUnlightRequests = [];
/* ======================================================
   【超限界軽量化】スリム・スカイライト伝播エンジン
   ====================================================== */

// 1次元インデックス上での「6方向へのオフセット差分」を定数化してGC・計算を排除
const CS = CHUNK_SIZE;
const CH = CHUNK_HEIGHT;
const CS_CH = CS * CH; // 16 * 256 = 4096

// 1次元配列上のオフセット [+X, -X, +Y, -Y, +Z, -Z]
const MOVE_OFFSETS = new Int32Array([CS_CH, -CS_CH, 1, -1, CH, -CH]);

function generateChunkLightMap(chunkKey, voxelData) {
    const TOTAL_CELLS = CS * CH * CS;

    let lightData = chunkLightCache.get(chunkKey);
    if (!lightData) {
        lightData = new Uint8Array(TOTAL_CELLS);
    }

    // 通常の光伝播(Relight)用1次元インデックスキュー (x,y,z の分解を排除)
    const queue = new Int32Array(TOTAL_CELLS);
    let head = 0, tail = 0;

    // お化けライト消去(Unlight)用キュー [index, oldLight]
    const unlightQueue = new Int32Array(TOTAL_CELLS * 6);
    let unhead = 0, untail = 0;

    // --- STEP 0: 設置された不透過ブロックによる既存光の強制減衰判定 ---
    for (let i = 0; i < TOTAL_CELLS; i++) {
        const type = voxelData[i];
        if (type === BLOCK_TYPES.SKY) continue;

        const cfg = _blockConfigFastArray[type];
        if (cfg && !cfg.transparent && lightData[i] > 0) {
            unlightQueue[untail++] = i;
            unlightQueue[untail++] = lightData[i];
            lightData[i] = 0;
        }
    }

    // --- STEP 1: 空からの直射日光を降らせる (デクリメント高速走査) ---
    for (let x = 0; x < CS; x++) {
        const xBase = CS_CH * x;
        for (let z = 0; z < CS; z++) {
            let currentLight = 15;
            let idx = (CH - 1) + CH * z + xBase;

            for (let y = CH - 1; y >= 0; y--) {
                const type = voxelData[idx];
                const oldLight = lightData[idx];

                if (currentLight === 15) {
                    const cfg = _blockConfigFastArray[type];
                    if (type !== BLOCK_TYPES.SKY && cfg && !cfg.transparent) {
                        currentLight = 0;
                    }
                }

                if (currentLight < oldLight) {
                    unlightQueue[untail++] = idx;
                    unlightQueue[untail++] = oldLight;
                    lightData[idx] = currentLight;
                } else if (currentLight > oldLight) {
                    lightData[idx] = currentLight;
                    queue[tail++] = idx;
                } else if (currentLight === 15) {
                    queue[tail++] = idx;
                }
                idx--;
            }
        }
    }

    // --- STEP 2: 自ら光るブロックの探索 ---
    for (let i = 0; i < TOTAL_CELLS; i++) {
        const type = voxelData[i];
        if (type === BLOCK_TYPES.SKY) continue;

        const cfg = _blockConfigFastArray[type];
        if (cfg && cfg.isLightSource) {
            if (lightData[i] < 15) {
                lightData[i] = 15;
                queue[tail++] = i;
            }
        }
    }

    // --- STEP 3: 隣接チャンクからの光の輸入 (超高速化版) ---
    const [cx, cz] = decodeChunkKey(chunkKey);
    const neighborOffsets = [
        { dx: -1, dz: 0, fromX: CS - 1, toX: 0 },
        { dx: 1, dz: 0, fromX: 0, toX: CS - 1 },
        { dx: 0, dz: -1, fromZ: CS - 1, toZ: 0 },
        { dx: 0, dz: 1, fromZ: 0, toZ: CS - 1 }
    ];

    for (let o = 0; o < 4; o++) {
        const offset = neighborOffsets[o];

        // 💡 Map の取得とキーのエンコードを、ループの「外側」に移動（4回のみの実行に！）
        const nMap = chunkLightCache.get(encodeChunkKey(cx + offset.dx, cz + offset.dz));
        if (!nMap) continue;

        const fromX = offset.fromX;
        const fromZ = offset.fromZ;
        const toX = offset.toX;
        const toY = CH;
        const toZ = offset.toZ;

        for (let y = 0; y < toY; y++) {
            for (let i = 0; i < CS; i++) {
                const lx = fromX !== undefined ? fromX : i;
                const lz = fromZ !== undefined ? fromZ : i;
                const myX = toX !== undefined ? toX : i;
                const myZ = toZ !== undefined ? toZ : i;

                const nIdx = y + CH * (lz + CS * lx);
                const nLight = nMap[nIdx];
                if (nLight <= 1) continue;

                const myIdx = y + CH * (myZ + CS * myX);
                const targetLight = (nLight - 1) | 0;

                if (lightData[myIdx] < targetLight) {
                    const myBlock = voxelData[myIdx];
                    // 空ブロック、または透過ブロックなら光を浸透させる
                    if (myBlock === BLOCK_TYPES.SKY || (_blockConfigFastArray[myBlock] && _blockConfigFastArray[myBlock].transparent)) {
                        lightData[myIdx] = targetLight;
                        queue[tail++] = myIdx;
                    }
                }
            }
        }
    }


    // --- STEP 4: お化けライト減衰 BFS (Unlight) ---
    while (unhead < untail) {
        const idx = unlightQueue[unhead++];
        const oldVal = unlightQueue[unhead++];

        // 1次元インデックスから、その場の y, z, x を数学的に逆算（境界チェック用）
        const y = idx % CH;
        const rem = (idx / CH) | 0;
        const z = rem % CS;
        const x = (rem / CS) | 0;

        for (let i = 0; i < 6; i++) {
            const offset = MOVE_OFFSETS[i];
            const nIdx = idx + offset;

            // 分岐予測をビット演算で突破（上下の限界チェック）
            if (i === 2 && y === CH - 1) continue; // +Y 天井
            if (i === 3 && y === 0) continue;      // -Y 底

            // チャンク境界チェック (はみ出し)
            if ((i === 0 && x === CS - 1) || (i === 1 && x === 0) ||
                (i === 4 && z === CS - 1) || (i === 5 && z === 0)) {

                // 既存の「隣接チャンクのお化けライト消去リクエスト」へ飛ばす
                let nLx = x, nLz = z, nCx = cx, nCz = cz;
                if (i === 0) { nCx++; nLx = 0; }
                if (i === 1) { nCx--; nLx = CS - 1; }
                if (i === 4) { nCz++; nLz = 0; }
                if (i === 5) { nCz--; nLz = CS - 1; }

                const nKey = encodeChunkKey(nCx, nCz);
                const nMap = chunkLightCache.get(nKey);
                if (nMap) {
                    const neighborIdx = y + CH * (nLz + CS * nLx);
                    const nLight = nMap[neighborIdx];
                    if (nLight > 0 && nLight < oldVal) {
                        neighborUnlightRequests.push({ cx: nCx, cz: nCz, lx: nLx, ly: y, lz: nLz, oldLight: nLight });
                        nMap[neighborIdx] = 0;
                    } else if (nLight >= oldVal) {
                        queue[tail++] = idx; // 隣の方が明るければそこを再伝播の起点に
                    }
                }
                continue;
            }

            // --- 自チャンク内部 ---
            const nLight = lightData[nIdx];
            if (nLight !== 0 && nLight < oldVal) {
                unlightQueue[untail++] = nIdx;
                unlightQueue[untail++] = nLight;
                lightData[nIdx] = 0;
            } else if (nLight >= oldVal) {
                queue[tail++] = nIdx;
            }
        }
    }

    // --- STEP 5: 光の再伝播 BFS (Flood Fill / Relight) ---
    while (head < tail) {
        const idx = queue[head++];
        const currentLight = lightData[idx];
        if (currentLight <= 1) continue;

        const nextLight = currentLight - 1;

        const y = idx % CH;
        const rem = (idx / CH) | 0;
        const z = rem % CS;
        const x = (rem / CS) | 0;

        for (let i = 0; i < 6; i++) {
            const offset = MOVE_OFFSETS[i];
            const nIdx = idx + offset;

            if (i === 2 && y === CH - 1) continue;
            if (i === 3 && y === 0) continue;
            if ((i === 0 && x === CS - 1) || (i === 1 && x === 0) ||
                (i === 4 && z === CS - 1) || (i === 5 && z === 0)) {
                continue; // 隣接チャンクへの伝播は境界同期に任せる
            }

            if (lightData[nIdx] >= nextLight) continue;

            const type = voxelData[nIdx];
            if (type === BLOCK_TYPES.SKY) {
                lightData[nIdx] = nextLight;
                queue[tail++] = nIdx;
            } else {
                const cfg = _blockConfigFastArray[type];
                if (cfg && cfg.transparent) {
                    lightData[nIdx] = nextLight;
                    queue[tail++] = nIdx;
                }
            }
        }
    }

    chunkLightCache.set(chunkKey, lightData);
    return lightData;
}

// ---------------------------------------
// CHUNK MESH GENERATION (軽量化版)
// ---------------------------------------

// 【追加】ファイル上部のどこかに配置
const customFadeMaterialCache = new Map();

function getOrCreateCustomFadeMaterial(baseMat, isCross, isWater, isTransparent) {
    const mapUuid = baseMat?.map ? baseMat.map.uuid : 'no_map';

    const flags = (isCross ? 1 : 0) | (isWater ? 2 : 0) | (isTransparent ? 4 : 0);

    if (!customFadeMaterialCache.has(mapUuid)) {
        customFadeMaterialCache.set(mapUuid, new Map());
    }
    const subMap = customFadeMaterialCache.get(mapUuid);

    if (subMap.has(flags)) {
        return subMap.get(flags);
    }

    const mat = new THREE.MeshLambertMaterial({
        map: baseMat?.map || null,
        transparent: true,
        opacity: 1.0, // 💡 0 から 1.0 に変更（1フレーム抜けのホワイトアウト・ブラックアウト点滅を防ぐ）
        vertexColors: true,
        side: (isCross || isWater) ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: !(isCross || isTransparent || isWater),
        alphaTest: isCross ? 0.5 : 0
    });

    subMap.set(flags, mat);
    return mat;
}


const SharedMaterials = {
    opaque: new THREE.MeshLambertMaterial({ vertexColors: true }),
    water: new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.8, vertexColors: true }),
    cutout: new THREE.MeshLambertMaterial({ alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true }),
    // ブロックIDごとにテクスチャをバインドしたマテリアルをあらかじめ配列化しておく
    blocks: new Map()
};
// =======================================================
// 💡 関数の外（ファイルスコープ）で定義し、使い回して GC を防止する定数
// =======================================================
// =======================================================
// 💡 立方体の基本頂点データ（クローンを廃止して直書きするための定数）
// =======================================================
const CUBE_VERTICES = {
    px: [1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1], // 右
    nx: [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0], // 左
    py: [0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0], // 上
    ny: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], // 下
    pz: [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], // 奥
    nz: [1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0]  // 手前
};

const CUBE_UVS = [0, 0, 1, 0, 1, 1, 0, 1];
const CUBE_INDICES = [0, 1, 2, 0, 2, 3];
const _tmpMat = new THREE.Matrix4();
const _globalVisCache = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);

// blocks.js の lookup テーブルから、ID を添字とした平坦な配列を事前に作っておく（超高速化）
const _blockConfigFastArray = new Array(256).fill(null);
for (let i = 0; i < 256; i++) {
    _blockConfigFastArray[i] = getBlockConfiguration(i);
}

// =======================================================
// 💡 関数の外（ファイルスコープ）で定義し、使い回して GC を防止する定数
// =======================================================
const _sharedVec3Zero = new THREE.Vector3(0, 0, 0); // 👈 追加
const _sharedFaceShadeCache = { px: 0, nx: 0, py: 0, ny: 0, pz: 0, nz: 0 }; // 👈 追加

function generateChunkMeshMultiTexture(cx, cz, useInstancing = false) {
    const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
    const idx = (x, y, z) => ChunkSaveManager.getBlockIndex(x, y, z);

    const container = new THREE.Object3D();

    clearCaches();

    const chunkKey = encodeChunkKey(cx, cz);
    let voxelData = ChunkSaveManager.modifiedChunks.get(chunkKey);
    let isNewChunk = false;

    // --- 1. 地形・洞窟生成 ---
    if (!voxelData) {
        voxelData = ChunkSaveManager.captureBaseChunkData(cx, cz);
        isNewChunk = true;

        let vIdx = 0;
        for (let x = 0; x < CHUNK_SIZE; x++) {
            const worldX = baseX + x;

            for (let z = 0; z < CHUNK_SIZE; z++) {
                const worldZ = baseZ + z;

                const caveInfo = getCaveTubeInfo(worldX, worldZ);
                const caveY = caveInfo[0];
                const caveRadiusSq = caveInfo[1] * caveInfo[1];

                for (let y = 0; y < CHUNK_HEIGHT; y++) {
                    const worldY = BEDROCK_LEVEL + y;

                    if (caveRadiusSq > 0 && worldY > 3 && (voxelData[vIdx] === BLOCK_TYPES.STONE || voxelData[vIdx] === BLOCK_TYPES.DIRT)) {
                        const dy = worldY - caveY;
                        if ((dy * dy) < caveRadiusSq) {
                            voxelData[vIdx] = BLOCK_TYPES.SKY;
                        }
                    }
                    vIdx++;
                }
            }
        }
    }

    if (isNewChunk) {
        ChunkSaveManager.modifiedChunks.set(chunkKey, voxelData);
    }

    // --- 2. 最高高度の特定 ＆ 空っぽチャンクの早期スキップ（★効率化） ---
    let maxModifiedHeight = 0;
    let hasAnySolidBlock = false;

    for (let i = voxelData.length - 1; i >= 0; i--) {
        if (voxelData[i] !== BLOCK_TYPES.SKY) {
            hasAnySolidBlock = true;
            maxModifiedHeight = Math.floor(i / (CHUNK_SIZE * CHUNK_SIZE)) + 1;
            break;
        }
    }

    if (!hasAnySolidBlock) {
        return container;
    }

    const activeHeight = Math.min(CHUNK_HEIGHT, Math.max(1, maxModifiedHeight));

    // --- 3. ボクセル取得ヘルパー ---
    // --- 3. ボクセル取得ヘルパー ---
    const get = (x, y, z) => {
        if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK_TYPES.SKY;

        if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
            return voxelData[idx(x, y, z)];
        }

        const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
        return getVoxelAtWorld(wx, wy, wz, globalTerrainCache, { raw: true });
    };

    // ▼▼▼ ここを追加 ▼▼▼
    let lightMap = chunkLightCache.get(chunkKey);
    if (!lightMap || isNewChunk) {
        lightMap = generateChunkLightMap(chunkKey, voxelData);
    }

    const getLightLevel = (lx, ly, lz) => {
        // 1. 完全に範囲外（高さ y が上下に突き抜けた場合）
        if (ly < 0) return 0;
        if (ly >= CHUNK_HEIGHT) return 15; // 空の上は常に明るい

        // 2. チャンク内部
        // ※ ビット演算で判定するとJITコンパイラが最適化しやすい
        if ((lx | (CHUNK_SIZE - 1 - lx) | lz | (CHUNK_SIZE - 1 - lz)) >= 0) {
            return lightMap[ly + CHUNK_HEIGHT * (lz + CHUNK_SIZE * lx)];
        }

        // 3. 境界外（隣のチャンク）の場合：隣のチャンクの「実際のライトマップ」を取りに行く！
        const wx = baseX + lx;
        const wz = baseZ + lz;

        const nCx = wx >> 4;
        const nCz = wz >> 4;
        const nKey = encodeChunkKey(nCx, nCz);

        const neighborLightMap = chunkLightCache.get(nKey);
        if (neighborLightMap) {
            const nLx = wx & 15;
            const nLz = wz & 15;
            return neighborLightMap[ly + CHUNK_HEIGHT * (nLz + CHUNK_SIZE * nLx)];
        }

        // 4. 💡 安全装置(フォールバック)の遅延・軽量化・影漏れ防止
        const surfaceHeight = getTerrainHeight(wx, wz);
        if (ly >= surfaceHeight) {
            return 15; // 地表以上なら無条件で15を返して、重い getVoxelAtWorld をスキップ！
        }

        // --- ⚠️ 改善ポイント：未ロードの隣チャンク「地下」の処理 ---

        // 地下（ly < surfaceHeight）かつ、隣のライトマップ未生成の場合：
        // 1. 無理に getVoxelAtWorld を呼ぶと「まだブロックを掘ったという情報」を反映できない。
        // 2. さらに、毎回 getVoxelAtWorld を呼ぶと未ロード境界のメッシュ生成が激重になる。
        // 
        // 💡 解決策：
        // 「未ロードの隣の地下」は、基本的には環境光「0」にするのがお化けライト残留を防ぐ意味でも安全。
        // ただし、ブロックを壊したとき「隣のチャンクを強制再描画(全方位同期)」させることで、
        // getVoxelAtWorld に頼らない正確な解決を行います。

        return 0;
    };
    // ▲▲▲ ここまで ▲▲▲

    _globalVisCache.fill(0);
    const visCache = _globalVisCache;

    const getVisMask = (x, y, z, type, cfg) => {
        const key = idx(x, y, z);
        let mask = visCache[key];

        if (mask === 0) {
            mask = computeVisibilityMask(
                i => get(x + neighbors[i].dx, y + neighbors[i].dy, z + neighbors[i].dz),
                type, cfg.transparent ?? false, cfg.customGeometry
            );
            visCache[key] = mask;
        }
        return mask;
    };

    const customGeomCache = new Map();
    const customGeomBatches = new Map();
    const faceGeoms = new Map();

    // =======================================================
    // 🧱 3D メッシュ組み立て 3重ループ
    // =======================================================
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let y = 0; y < activeHeight; y++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const type = voxelData[idx(x, y, z)];
                if (type === BLOCK_TYPES.SKY) continue;

                const cfg = _blockConfigFastArray[type];
                if (!cfg) continue;

                const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
                const visMask = getVisMask(x, y, z, type, cfg);

                // 🌿 A. カスタムジオメトリ（草・花・階段など）
                if (cfg.customGeometry || cfg.geometryType !== 'cube') {
                    if (!customGeomCache.has(type)) {
                        // 💡 new THREE.Vector3() の生成を使い回し変数に変更
                        const mesh = createCustomBlockMesh(type, _sharedVec3Zero, null);
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

                        subGeo.applyMatrix4(_tmpMat.makeTranslation(wx, wy, wz));
                        return subGeo;
                    });

                    // 💡 filteredが空の場合の早期スキップを追加
                    if (filtered.length === 0) continue;

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

                            let lightLevel = getLightLevel(centerX, yMin, centerZ);
                            let shade = LIGHT_LEVEL_FACTORS[lightLevel];

                            for (let i = 0; i < posAttr.count; i++) {
                                colors.set([shade, shade, shade], i * 3);
                            }
                        } else {
                            for (let i = 0; i < posAttr.count; i++) {
                                const ny = normalAttr.getY(i), nx = normalAttr.getX(i), nz = normalAttr.getZ(i);

                                let targetX = x + (nx > 0.9 ? 1 : nx < -0.9 ? -1 : 0);
                                let targetY = y + (ny > 0.9 ? 1 : ny < -0.9 ? -1 : 0);
                                let targetZ = z + (nz > 0.9 ? 1 : nz < -0.9 ? -1 : 0);

                                let lightLevel = getLightLevel(targetX, targetY, targetZ);
                                let shade = LIGHT_LEVEL_FACTORS[lightLevel];

                                if (nx > 0.9 || nx < -0.9) shade *= 0.8;
                                if (nz > 0.9 || nz < -0.9) shade *= 0.8;
                                if (ny < -0.9) shade *= 0.6;

                                colors.set([shade, shade, shade], i * 3);
                            }
                        }

                        merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
                        customGeomBatches.get(type).push(merged);
                    }
                    continue;
                }

                // 📦 B. 通常立方体 (フルブロック)
                if (!visMask) continue;

                if (useInstancing) {
                    if (!faceGeoms.has(type)) faceGeoms.set(type, new Map());
                    const matMap = faceGeoms.get(type);

                    for (let i = 0; i < FACE_KEYS.length; i++) {
                        const face = FACE_KEYS[i];
                        const data = faceData[face];
                        if (!((visMask >> data.bit) & 1)) continue;
                        if (!matMap.has(face)) matMap.set(face, []);
                        matMap.get(face).push([wx, wy, wz]);
                    }
                    continue;
                }

                for (let i = 0; i < FACE_KEYS.length; i++) {
                    const face = FACE_KEYS[i];
                    const data = faceData[face];

                    if (!((visMask >> data.bit) & 1)) continue;

                    const matIdx = faceToMaterialIndex[face];
                    if (!faceGeoms.has(type)) faceGeoms.set(type, new Map());
                    const matMap = faceGeoms.get(type);
                    if (!matMap.has(matIdx)) matMap.set(matIdx, { positions: [], colors: [] });

                    const batch = matMap.get(matIdx);

                    const baseVerts = CUBE_VERTICES[face];
                    batch.positions.push(
                        baseVerts[0] + wx, baseVerts[1] + wy, baseVerts[2] + wz,
                        baseVerts[3] + wx, baseVerts[4] + wy, baseVerts[5] + wz,
                        baseVerts[6] + wx, baseVerts[7] + wy, baseVerts[8] + wz,
                        baseVerts[9] + wx, baseVerts[10] + wy, baseVerts[11] + wz
                    );

                    for (let v = 0; v < 4; v++) {
                        let targetX = x + (face === "px" ? 1 : face === "nx" ? -1 : 0);
                        let targetY = y + (face === "py" ? 1 : face === "ny" ? -1 : 0);
                        let targetZ = z + (face === "pz" ? 1 : face === "nz" ? -1 : 0);

                        let lightLevel = getLightLevel(targetX, targetY, targetZ);
                        let shade = LIGHT_LEVEL_FACTORS[lightLevel];

                        if (face === "px" || face === "nx") shade *= 0.8;
                        if (face === "pz" || face === "nz") shade *= 0.8;
                        if (face === "ny") shade *= 0.6;

                        batch.colors.push(shade, shade, shade);
                    }
                }
            }
        }
    }

    // =======================================================
    // 🧱 通常立方体マージ & メッシュ描画
    // =======================================================
    for (const [type, group] of faceGeoms.entries()) {
        const mats = getBlockMaterials(+type);

        if (useInstancing) {
            for (const [face, positions] of group.entries()) {
                if (!positions.length) continue;
                const geom = getCachedFaceGeometry(face);
                const mat = mats?.[0] ? mats[0] : new THREE.MeshBasicMaterial({ color: 0xffffff });

                const mesh = new THREE.InstancedMesh(geom, mat, positions.length);
                const dummy = new THREE.Object3D();
                positions.forEach((pos, i) => {
                    dummy.position.set(...pos);
                    dummy.updateMatrix();
                    mesh.setMatrixAt(i, dummy.matrix);
                });
                container.add(mesh);
            }
        } else {
            let totalFaces = 0;
            for (const matData of group.values()) {
                totalFaces += matData.positions.length / 12;
            }

            const finalGeom = new THREE.BufferGeometry();
            const posArray = new Float32Array(totalFaces * 12);
            const colorArray = new Float32Array(totalFaces * 12);
            const uvArray = new Float32Array(totalFaces * 8);
            const indexArray = new Uint32Array(totalFaces * 6);

            let vOff = 0, uvOff = 0, iOff = 0, faceIdx = 0;
            let groupOffset = 0;

            for (const [matIdx, matData] of group.entries()) {
                const faceCount = matData.positions.length / 12;
                if (faceCount === 0) continue;

                posArray.set(matData.positions, vOff);
                colorArray.set(matData.colors, vOff);

                for (let f = 0; f < faceCount; f++) {
                    uvArray.set(CUBE_UVS, uvOff);
                    uvOff += 8;

                    const baseV = faceIdx * 4;
                    indexArray[iOff++] = baseV;
                    indexArray[iOff++] = baseV + 1;
                    indexArray[iOff++] = baseV + 2;
                    indexArray[iOff++] = baseV;
                    indexArray[iOff++] = baseV + 2;
                    indexArray[iOff++] = baseV + 3;

                    faceIdx++;
                }

                finalGeom.addGroup(groupOffset, faceCount * 6, matIdx);
                groupOffset += faceCount * 6;
                vOff += matData.positions.length;
            }

            finalGeom.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
            finalGeom.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
            finalGeom.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
            finalGeom.setIndex(new THREE.BufferAttribute(indexArray, 1));
            finalGeom.computeVertexNormals();
            finalGeom.computeBoundingSphere();

            const baseMats = SharedMaterials.blocks.get(type) || getBlockMaterials(+type);

            const fadeReadyMats = baseMats.map(m => {
                const cloned = m.clone();
                cloned.userData = {
                    originMat: m,
                    realTransparent: m.userData?.realTransparent ?? m.transparent,
                    realDepthWrite: m.userData?.realDepthWrite ?? m.depthWrite,
                    realOpacity: m.userData?.realOpacity ?? m.opacity
                };
                return cloned;
            });

            const mesh = new THREE.Mesh(finalGeom, fadeReadyMats);
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.frustumCulled = true;

            mesh.userData.finalizeFade = function () {
                if (!Array.isArray(mesh.material)) return;

                const restoredMats = mesh.material.map(clonedMat => {
                    const origin = clonedMat.userData?.originMat;
                    if (origin) {
                        clonedMat.dispose();
                        return origin;
                    }
                    return clonedMat;
                });

                mesh.material = restoredMats;
                mesh.userData.finalizeFade = null;
            };

            container.add(mesh);
        }
    }

    // =======================================================
    // 🌿 カスタムジオメトリマージ & メッシュ描画
    // =======================================================
    for (const [type, geoms] of customGeomBatches.entries()) {
        const merged = mergeBufferGeometries(geoms, true);
        merged.computeBoundingSphere();
        const cfg = _blockConfigFastArray[type];

        const originalMats = getBlockMaterials(+type) || [];
        const baseMat = originalMats[0];

        const targetOpacity = baseMat?.userData?.realOpacity ?? 1.0;
        const isWater = type === BLOCK_TYPES.WATER || baseMat?.userData?.isWater === true;

        const isGlass = type === BLOCK_TYPES.GLASS || (cfg && cfg.id === 12);
        const isCutout = cfg?.geometryType === "cross" || cfg?.geometryType === "leaves" || isGlass;

        const isChunkZero = typeof CHUNK_VISIBLE_DISTANCE !== "undefined" && CHUNK_VISIBLE_DISTANCE === 0;

        const sharedFadeMat = getOrCreateCustomFadeMaterial(baseMat, isCutout, isWater, isGlass);
        const fadeReadyMat = sharedFadeMat.clone();

        fadeReadyMat.userData = {
            originMat: baseMat,
            realTransparent: isWater || isGlass,
            realDepthWrite: !isWater && !isGlass,
            realOpacity: targetOpacity,
            isWater: isWater,
            isGlass: isGlass,
            isAlphaCutout: isCutout
        };

        const mesh = new THREE.Mesh(merged, fadeReadyMat);

        if (isChunkZero) {
            fadeReadyMat.opacity = targetOpacity;
        }

        mesh.castShadow = !isCutout;
        mesh.receiveShadow = !isCutout;
        mesh.frustumCulled = true;

        if (isWater) {
            mesh.renderOrder = 10;
        } else if (isGlass || isCutout) {
            mesh.renderOrder = 1;
        } else {
            mesh.renderOrder = 0;
        }

        mesh.userData.finalizeFade = function () {
            if (mesh.material && mesh.material.userData?.originMat) {
                const origin = mesh.material.userData.originMat;
                mesh.material.dispose();
                mesh.material = origin;
            }
            mesh.userData.finalizeFade = null;
        };

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
    mesh.castShadow = mesh.receiveShadow = true;
    // ✅ 単体配置される特殊ブロックも、視点による非表示化バグを無効化する
    mesh.frustumCulled = true;

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

    if (lastChunk.x === pCx && lastChunk.z === pCz && offsets) return;

    const isMoved = lastChunk.x !== pCx || lastChunk.z !== pCz;
    lastChunk = { x: pCx, z: pCz };
    offsets ||= precomputeOffsets();

    const queued = new Set();
    for (let i = 0; i < chunkQueue.length; i++) {
        const q = chunkQueue[i];
        queued.add(encodeChunkKey(q.cx, q.cz));
    }

    const req = new Set();
    const cands = offsets;

    for (let i = 0; i < cands.length; i++) {
        const offset = cands[i];
        const cx = pCx + offset.dx;
        const cz = pCz + offset.dz;
        const hashKey = encodeChunkKey(cx, cz);

        req.add(hashKey);

        if (!loadedChunks.has(hashKey) && !queued.has(hashKey)) {
            chunkQueue.push({ cx, cz });
        }
    }

    // 🛠️ 修正1: マージン(+2)を取り払う
    chunkQueue = chunkQueue.filter(e => {
        const dx = Math.abs(e.cx - pCx);
        const dz = Math.abs(e.cz - pCz);
        return dx <= CHUNK_VISIBLE_DISTANCE && dz <= CHUNK_VISIBLE_DISTANCE;
    });

    if (isMoved && chunkQueue.length > 1) {
        chunkQueue.sort((a, b) => {
            const dAx = a.cx - pCx;
            const dAz = a.cz - pCz;
            const dBx = b.cx - pCx;
            const dBz = b.cz - pCz;

            const distA = (dAx * dAx) + (dAz * dAz);
            const distB = (dBx * dBx) + (dBz * dBz);

            return distA - distB;
        });
    }

    for (const [hashKey, mesh] of loadedChunks.entries()) {
        const [cx, cz] = decodeChunkKey(hashKey);

        const dx = cx - pCx;
        const dz = cz - pCz;

        // 🛠️ 修正2: マージン(+1)を取り払う
        if (Math.abs(dx) > CHUNK_VISIBLE_DISTANCE || Math.abs(dz) > CHUNK_VISIBLE_DISTANCE) {
            releaseChunkMesh(mesh);
            loadedChunks.delete(hashKey);
        }
    }

    if (chunkQueue.length > 0) {
        processChunkQueue({ timeRemaining: () => 16, didTimeout: true });
    }
}


window.updateChunksFromUI = () => {
    const d = parseInt(document.getElementById("chunkDistance").value, 10);
    if (isNaN(d) || d < 0 || d > 32) return alert("0～32の範囲で入力してください。");

    CHUNK_VISIBLE_DISTANCE = d;

    // 1. オフセット（探索用の同心円テーブル）を初期化して再計算させる
    offsets = null;

    // 2. まだ読み込まれていない古い描画距離のキューをリセットして、おかしなチャンクが生成されるのを防ぐ
    chunkQueue = [];

    // 3. 一度、現在の位置からチャンク探索判定をリセットする
    lastChunk.x = null;
    lastChunk.z = null;

    // 4. 新しい描画距離で再探索・キューイングを走らせる
    updateChunks();

    // ユーザーへのフィードバック
    if (typeof addChatMessage === "function") {
        addChatMessage(`描画距離を ${d} に更新しました。`, "#55ff55");
    }
    console.log("描画距離の更新:", d);
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
 * ブロック操作によって影響を受けるチャンクを特定し、更新を要求する
 * お化けライトの隣接チャンクへの消去（Unlight）の伝播同期もここで行います。
 */
function updateAffectedChunks(blockPos, forceImmediate = true) {
    const cx = getChunkCoord(blockPos.x);
    const cz = getChunkCoord(blockPos.z);
    const myKey = encodeChunkKey(cx, cz);

    // ======================================================
    // 1. 自チャンクのライトマップ再計算（地形データは get でキャッシュから安全取得）
    // ======================================================
    const myVoxelData = ChunkSaveManager.modifiedChunks.get(myKey)
        || ChunkSaveManager.captureBaseChunkData(cx, cz);

    generateChunkLightMap(myKey, myVoxelData);

    // ======================================================
    // 2. お化けライトの連鎖伝播（配列のメモリ再確保を排除して高速化）
    // ======================================================
    pendingChunkUpdates.add(myKey);

    // 💡 配列の shift() は重いため、インデックス走査（リングバッファ風）で GC を抑制
    const lightQueue = [];
    let head = 0;

    while (neighborUnlightRequests.length > 0) {
        const req = neighborUnlightRequests.pop(); // pop() は shift() より圧倒的に高速
        const nKey = encodeChunkKey(req.cx, req.cz);
        if (loadedChunks.has(nKey)) {
            lightQueue.push({ key: nKey, cx: req.cx, cz: req.cz });
        }
    }

    while (head < lightQueue.length) {
        const current = lightQueue[head++];

        // 💡 修正：captureBaseChunkData を呼ばず、既存データがない（まだ誰も弄ってない）ならスキップ！
        // 未変更チャンクの光は、地形生成時に自動計算されるため、今無理やり作る必要はありません。
        const nVoxelData = ChunkSaveManager.modifiedChunks.get(current.key);
        if (!nVoxelData) continue;

        generateChunkLightMap(current.key, nVoxelData);
        pendingChunkUpdates.add(current.key); // 光が変わったので描画リストへ

        while (neighborUnlightRequests.length > 0) {
            const nextReq = neighborUnlightRequests.pop();
            const nextKey = encodeChunkKey(nextReq.cx, nextReq.cz);

            if (loadedChunks.has(nextKey) && !pendingChunkUpdates.has(nextKey)) {
                lightQueue.push({ key: nextKey, cx: nextReq.cx, cz: nextReq.cz });
            }
        }
    }

    // ======================================================
    // 3. メッシュ再生成の登録（本当に境界に近いときだけ隣接を更新）
    // ======================================================
    const localX = blockPos.x & (CHUNK_SIZE - 1);
    const localZ = blockPos.z & (CHUNK_SIZE - 1);

    // ブロックがチャンクの「真ん中」にあるなら、隣のメッシュ（見た目）を作り直す必要はない！
    const isMinX = (localX <= 1);
    const isMaxX = (localX >= CHUNK_SIZE - 2);
    const isMinZ = (localZ <= 1);
    const isMaxZ = (localZ >= CHUNK_SIZE - 2);

    if (isMinX) pendingChunkUpdates.add(encodeChunkKey(cx - 1, cz));
    if (isMaxX) pendingChunkUpdates.add(encodeChunkKey(cx + 1, cz));
    if (isMinZ) pendingChunkUpdates.add(encodeChunkKey(cx, cz - 1));
    if (isMaxZ) pendingChunkUpdates.add(encodeChunkKey(cx, cz + 1));

    if (isMinX && isMinZ) pendingChunkUpdates.add(encodeChunkKey(cx - 1, cz - 1));
    if (isMinX && isMaxZ) pendingChunkUpdates.add(encodeChunkKey(cx - 1, cz + 1));
    if (isMaxX && isMinZ) pendingChunkUpdates.add(encodeChunkKey(cx + 1, cz - 1));
    if (isMaxX && isMaxZ) pendingChunkUpdates.add(encodeChunkKey(cx + 1, cz + 1));

    // ======================================================
    // 4. 即時反映（時間計測ブレーキに任せる）
    // ======================================================
    if (forceImmediate) {
        processPendingChunkUpdates(Infinity);
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
function blockIntersectsPlayer(blockPos, playerAABB, tolerance = 0.01) { // 余裕を少し広げる
    const bMin = blockPos;
    const bMax = { x: blockPos.x + 1, y: blockPos.y + 1, z: blockPos.z + 1 };

    return (
        playerAABB.min.x < bMax.x - tolerance &&
        playerAABB.max.x > bMin.x + tolerance &&
        playerAABB.min.y < bMax.y - tolerance &&
        playerAABB.max.y > bMin.y + tolerance &&
        playerAABB.min.z < bMax.z - tolerance &&
        playerAABB.max.z > bMin.z + tolerance
    );
}

// --- interactWithBlock 関数 ---
// ブロックの設置／破壊操作を行い voxelModifications を更新し、必要なチャンク（領域）再生成を指示する
const placedCustomBlocks = new Map();
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
// pickFirstValidHit（挙動そのまま軽量化）
function pickFirstValidHit(raycaster, objects, action) {
    const EPS = 1e-6;
    const intersects = allocIntersects();
    const tempNormal = allocVec();

    try {
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

        for (const hit of intersects) {
            if (hit.distance > BLOCK_INTERACT_RANGE + EPS) continue;

            if (hit.face?.normal) {
                tempNormal.copy(hit.face.normal);
            } else {
                tempNormal.set(0, 1, 0);
            }

            const bx = Math.floor(hit.point.x - tempNormal.x * EPS);
            const by = Math.floor(hit.point.y - tempNormal.y * EPS);
            const bz = Math.floor(hit.point.z - tempNormal.z * EPS);
            const cx = getChunkCoord(bx);
            const cz = getChunkCoord(bz);
            // 💡 【修正】 32bit/53bit の数値ハッシュキーを使って Map から取得する
            const hashKey = getVoxelHash(bx, by, bz);
            const voxelId = ChunkSaveManager.getBlock(cx, cz, bx & 15, by, bz & 15)
                ?? getVoxelAtWorld(bx, by, bz, globalTerrainCache, { raw: true });

            const cfg = getBlockConfiguration(voxelId);

            if (cfg?.geometryType === "water") {
                if (action === "destroy" && activeBlockType === BLOCK_TYPES.WATER) {
                    return hit;
                }
                continue;
            }

            return hit;
        }

        return null;
    } finally {
        freeIntersects(intersects);
        freeVec(tempNormal);
    }
}
// ----------------------------------------
// メイン：破壊/設置（新システム・負の座標完全準拠）
// ----------------------------------------
function interactWithBlock(action) {
    if (action !== "place" && action !== "destroy") {
        console.warn("未知のアクション:", action);
        return;
    }

    const EPS = 1e-6;
    const TOP_FACE_THRESHOLD = 0.9;
    const TOP_Y_EPS = 1e-3;

    raycaster.near = 0.01;
    raycaster.far = BLOCK_INTERACT_RANGE;
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);

    const objects = [];
    for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) {
            const cx = pCx + x;
            const cz = pCz + z;

            const chunkKey = encodeChunkKey(cx, cz);
            const chunkMesh = loadedChunks.get(chunkKey);
            if (chunkMesh) {
                objects.push(chunkMesh);
            }
        }
    }

    objects.push(...Object.values(placedCustomBlocks));

    const intersect = pickFirstValidHit(raycaster, objects, action);

    if (!intersect) {
        console.warn("破壊/設置対象が見つかりません");
        return;
    }

    const { base, dir, target, rawNormal } = computeHitBlockAndTarget(intersect, action);
    const candidate = target;

    const candidateHash = getVoxelHash(candidate.x, candidate.y, candidate.z);

    const candCx = getChunkCoord(candidate.x);
    const candCz = getChunkCoord(candidate.z);

    // 💡 負の座標でも安全に 0 ～ 15 を算出する数学的剰余
    let candLx = candidate.x % CHUNK_SIZE;
    if (candLx < 0) candLx += CHUNK_SIZE;
    let candLz = candidate.z % CHUNK_SIZE;
    if (candLz < 0) candLz += CHUNK_SIZE;

    let voxel = ChunkSaveManager.getBlock(candCx, candCz, candLx, candidate.y, candLz)
        ?? getVoxelAtWorld(candidate.x, candidate.y, candidate.z, globalTerrainCache, true);
    let cfg = getBlockConfiguration(voxel);

    const candidateCenter = new THREE.Vector3(candidate.x + 0.5, candidate.y + 0.5, candidate.z + 0.5);
    const cameraPos = camera.position ? camera.position : new THREE.Vector3(0, 0, 0);
    const distToCandidate = cameraPos.distanceTo(candidateCenter);
    if (distToCandidate > BLOCK_INTERACT_RANGE + 0.6) {
        console.warn("ターゲットは射程外です:", distToCandidate.toFixed(2));
        return;
    }

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

    const topPlaneY = candidate.y + 1;
    const isTopFaceByNormal = rawNormal.y > TOP_FACE_THRESHOLD;
    const hitPointIsAtTop = (Math.abs(intersect.point.y - topPlaneY) <= TOP_Y_EPS) || (intersect.point.y > topPlaneY - TOP_Y_EPS);
    const isActuallyTopAttempt = isTopFaceByNormal || hitPointIsAtTop || (dir.y > 0);

    if (action === "place" && playerBox) {
        const playerFeetY = playerBox.min.y;
        const isAboveFeet = candidate.y >= Math.floor(playerFeetY + EPS);
        const overlaps = playerBox.intersectsBox(belowBlockBox);

        if (sneakActive && overlaps && isActuallyTopAttempt) {
            console.warn("自分の立っているブロックの上面には設置できません（安全判定）");
            return;
        }

        if (isAboveFeet && isActuallyTopAttempt) {
            if (lastPlacedKey !== null) {
                // 💡 ハッシュからデコードしていた箇所を、直感的な candidate 座標比較にシンプル化
                const sameColumn = (candidate.x === Math.floor(player.position.x) && candidate.z === Math.floor(player.position.z));
                const higherThanLast = true; // 設置履歴の高さを見る単純フラグ

                const playerCenterX = (playerBox.min.x + playerBox.max.x) / 2;
                const playerCenterZ = (playerBox.min.z + playerBox.max.z) / 2;
                const dx = Math.abs(playerCenterX - (candidate.x + 0.5));
                const dz = Math.abs(playerCenterZ - (candidate.z + 0.5));
                const isDirectlyAbove = dx < 0.4 && dz < 0.4;

                if (sameColumn && higherThanLast && isDirectlyAbove && !player.onGround) {
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
        const destroyHash = getVoxelHash(base.x, base.y, base.z);

        const baseCx = getChunkCoord(base.x);
        const baseCz = getChunkCoord(base.z);

        let baseLx = base.x % CHUNK_SIZE;
        if (baseLx < 0) baseLx += CHUNK_SIZE;
        let baseLz = base.z % CHUNK_SIZE;
        if (baseLz < 0) baseLz += CHUNK_SIZE;

        let destroyVoxel = ChunkSaveManager.getBlock(baseCx, baseCz, baseLx, base.y, baseLz)
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

        if (placedCustomBlocks.has(destroyHash)) {
            scene.remove(placedCustomBlocks.get(destroyHash));
            placedCustomBlocks.delete(destroyHash);
        }

        ChunkSaveManager.setBlock(baseCx, baseCz, baseLx, base.y, baseLz, BLOCK_TYPES.SKY);
        console.log("破壊完了:", base);

        markColumnModified(base.x, base.z, base.y);
        updateAffectedChunks(base, true);
        updateBlockSelection();
        updateBlockInfo();
        return;
    }

    // ====================
    // 設置
    // ====================
    if (action === "place") {
        // ★ 空気ブロックは設置禁止
        if (activeBlockType === BLOCK_TYPES.SKY) {
            console.warn("空気ブロックは設置できません");
            return;
        }

        if (candidate.y <= -1) {
            addChatMessage("限界高度以下のため、設置できません。", "#ff5555");
            return;
        }
        if (candidate.y >= BEDROCK_LEVEL + CHUNK_HEIGHT) {
            addChatMessage("高さ制限により、設置できません。", "#ff5555");
            return;
        }

        if (voxel !== BLOCK_TYPES.SKY) {
            const currentCfg = getBlockConfiguration(voxel);
            if (currentCfg?.geometryType === "water" || currentCfg?.overwrite === true) {
                if (placedCustomBlocks.has(candidateHash)) {
                    scene.remove(placedCustomBlocks.get(candidateHash));
                    placedCustomBlocks.delete(candidateHash);
                }

                ChunkSaveManager.setBlock(candCx, candCz, candLx, candidate.y, candLz, BLOCK_TYPES.SKY);
                voxel = BLOCK_TYPES.SKY;
            } else {
                console.warn("設置不可: ブロックが存在します");
                return;
            }
        }

        const newBlockCfg = getBlockConfiguration(activeBlockType);

        if (newBlockCfg?.collision !== false && blockIntersectsPlayer(candidate, playerBox ?? getPlayerAABB(), 0.0)) {
            console.warn("プレイヤーの領域と重なっているため、設置できません。");
            return;
        }

        ChunkSaveManager.setBlock(candCx, candCz, candLx, candidate.y, candLz, activeBlockType);
        lastPlacedKey = candidateHash;
        console.log("設置完了:", candidate);

        markColumnModified(candidate.x, candidate.z, candidate.y);
        updateAffectedChunks(candidate, true);
        updateBlockSelection();
        updateBlockInfo();
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

// ==========================================
// 🔑 キー状態オブジェクトの定義 (最上部に配置)
// ==========================================
const keys = {};
let f3Pressed = false;

// ----- マウス操作 -----
renderer.domElement.addEventListener("mousedown", (event) => {
    // 👇 ここを追加！ インベントリが開いている時は、マウスを押しても設置や破壊、ロック処理を完全に無視する
    if (isInventoryOpen) return;

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
    // インベントリが開いている時や、既にロック中の時はポインターロックを要求しない
    if (isInventoryOpen || pointerLocked) return;

    if (!("ontouchstart" in window)) {
        renderer.domElement.requestPointerLock();
    }
});

document.addEventListener("pointerlockchange", () => {
    pointerLocked = (document.pointerLockElement === renderer.domElement);
    console.log(pointerLocked ? "Pointer Locked" : "Pointer Unlocked");
});

// ----- タッチ操作で視点回転＋短タップ設置・長押し破壊 -----
let lastTouchX = null, lastTouchY = null;
let touchHoldTimeout = null;
let isLongPress = false;
let isTouchMoving = false;

renderer.domElement.addEventListener("touchstart", (e) => {
    if (isInventoryOpen) return; // インベントリが開いている時は無視
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
    if (isInventoryOpen) return; // インベントリが開いている時は視点移動も無視
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

    if (isInventoryOpen) return; // インベントリが開いている時はタッチ終了後の処理も無視

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


document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();

    // 💡 F3キーが押されたらブラウザ標準の検索窓が出るのを阻止し、フラグを立てる
    if (e.key === "F3") {
        e.preventDefault();
        f3Pressed = true;
        return; // 他の移動キー判定をスキップ
    }

    // 💡 F3 + G の同時押しを検知した時の処理
    if (f3Pressed && key === "g") {
        e.preventDefault();
        showChunkBorders = !showChunkBorders;
        chunkBorderMesh.visible = showChunkBorders;

        if (typeof addChatMessage === "function") {
            addChatMessage(
                showChunkBorders ? "チャンク境界を表示しました" : "チャンク境界を非表示にしました",
                "#55ff55"
            );
        }
        return;
    }

    // インベントリ開閉の「e」キーだけはインベントリ開閉中も処理を通す
    if (key === "e") return;

    // それ以外の移動やアクションは、インベントリが開いていたら全て無視
    if (isInventoryOpen) return;

    if ((e.key === " " || e.key === "Spacebar") && e.repeat) return;
    keys[key] = true;

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


/* ======================================================
   【プレビューキャッシュ用ハッシュ関数（文字列廃止）】
   ====================================================== */
const previewCache = new Map();

// ID(0~65535)、サイズ(0~255)、タイプ(0:2D / 1:3D) を1つの数値(32bit)にパック
function getPreviewHash(id, size, type) {
    return (id << 16) | (size << 8) | type;
}

// --- 2Dプレビュー ---
const create2DPreview = ({ id, textures = {}, previewOptions = {} }, size) => {
    const hashKey = getPreviewHash(id, size, 0); // 0 = 2D

    if (previewCache.has(hashKey)) {
        const cached = previewCache.get(hashKey);
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
        previewCache.set(hashKey, cacheCanvas);
    }).catch(e => console.error(`画像読み込み失敗 block: ${id}`, e));

    return canvas;
};

// --- 3Dプレビュー ---
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

// 3Dプレビュー作成
const create3DPreview = async ({ id, previewOptions = {}, geometryType }, size) => {
    const hashKey = getPreviewHash(id, size, 1);

    if (previewCache.has(hashKey)) {
        const cached = previewCache.get(hashKey);
        const clone = createCanvas(size);
        clone.getContext("2d").drawImage(cached, 0, 0);
        return clone;
    }

    const previewCanvas = createCanvas(size);
    previewCanvas.style.imageRendering = "pixelated";

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

    // 💡 修正ポイント：配列を後ろから安全に回し、古いプレビューをメモリごと捨てる
    for (let i = sharedScene.children.length - 1; i >= 2; i--) {
        const old = sharedScene.children[i];
        sharedScene.remove(old);

        if (old.geometry) {
            old.geometry.dispose();
        }

        if (old.material) {
            const disposeMaterial = m => {
                if (m.map) m.map.dispose();
                m.dispose();
            };
            if (Array.isArray(old.material)) {
                old.material.forEach(disposeMaterial);
            } else {
                disposeMaterial(old.material);
            }
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

    const cacheCanvas = createCanvas(size);
    cacheCanvas.getContext("2d").drawImage(shared3DCanvas, 0, 0, size, size);
    previewCache.set(hashKey, cacheCanvas);

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
// 状態の監視だけにする
document.addEventListener("pointerlockchange", () => {
    pointerLocked = (document.pointerLockElement === renderer.domElement);
});
// イベントの登録は、初期化時に「1回だけ」行う
window.addEventListener("mousemove", onMouseMove);

// --- マウス移動処理 ---
function onMouseMove(e) {
    if (!pointerLocked || inventoryContainer.style.display !== "none") return;
    yaw -= e.movementX * mouseSensitivity;
    pitch = Math.min(Math.max(pitch - e.movementY * mouseSensitivity, -Math.PI / 2), Math.PI / 2);
}

// --- 1. 状態を完全に管理するためのフラグ変数を追加 (文字列判定のバグを防止) ---
let isInventoryOpen = false;

// --- 2. クリックでポインターロック要求（インベントリ表示中やUIクリック時は完全に無視） ---
window.addEventListener("click", (e) => {
    // インベントリが開いているなら、どこをクリックしても絶対にロックしない
    if (isInventoryOpen) {
        return;
    }

    if (inventoryContainer.contains(e.target)) {
        return;
    }

    if (pointerLocked) {
        return;
    }

    if (e.target === renderer.domElement) {
        renderer.domElement.requestPointerLock();
    }
});

// --- 3. Eキーでインベントリ表示切替 ---
window.addEventListener("keydown", e => {
    if (e.key.toLowerCase() === "e") {
        e.preventDefault();

        if (isInventoryOpen) {
            // ◆ インベントリが開いているなら【閉じる】
            isInventoryOpen = false;
            inventoryContainer.style.display = "none";
            renderer.domElement.requestPointerLock(); // 閉じたら視点をロック
        } else {
            // ◆ インベントリが閉じているなら【開く】
            isInventoryOpen = true;
            inventoryContainer.style.display = "block";
            if (pointerLocked) {
                document.exitPointerLock(); // 開いたら視点のロックを外す
            }
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

/* ======================================================
   【ウィンドウのリサイズ対応】
   ====================================================== */
window.addEventListener('resize', () => {
    // 1. カメラのアスペクト比を現在の画面サイズに更新
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();

    // 2. レンダラーの描画サイズを更新
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
});

















/* ======================================================
   【超軽量化・チャンク境界表示システム（全6面格子付き）】
   ====================================================== */

// 1. マテリアルの定義（赤＝チャンクの角枠、黄＝1マスごとの格子）
const chunkBorderFrameMaterial = new THREE.LineBasicMaterial({
    color: 0xff2222, // 赤色（チャンクの角・外枠）
    depthTest: true,  // 💡 true にして、ブロックに隠れるようにする
    depthWrite: false,
    transparent: true,
    opacity: 1.0,
    // 💡 Zファイティング（チラつき）防止
    polygonOffset: true,
    polygonOffsetFactor: -1.0,
    polygonOffsetUnits: -4.0
});

const chunkGridMaterial = new THREE.LineBasicMaterial({
    color: 0xffff44, // 黄色（1マスごとの格子）
    depthTest: true,  // 💡 true にして、ブロックに隠れるようにする
    depthWrite: false,
    transparent: true,
    opacity: 0.8,
    // 💡 Zファイティング（チラつき）防止
    polygonOffset: true,
    polygonOffsetFactor: -1.0,
    polygonOffsetUnits: -4.0
});

const chunkBorderMesh = new THREE.Group();
let showChunkBorders = false;

function initChunkBorderGeometries() {
    const size = CHUNK_SIZE; // 16
    const height = CHUNK_HEIGHT; // 256

    const frameVerts = []; // 赤い枠（外周の柱と大枠）
    const gridVerts = [];  // 黄色い枠（全6面の4マス格子）

    // --- 🟥 赤：4つの角の縦柱 ---
    frameVerts.push(0, 0, 0, 0, height, 0);
    frameVerts.push(size, 0, 0, size, height, 0);
    frameVerts.push(0, 0, size, 0, height, size);
    frameVerts.push(size, 0, size, size, height, size);

    // --- 🟥 赤：天井(Y=256) と 底面(Y=0) の大外枠 ---
    const yLevels = [0, height];
    for (const y of yLevels) {
        frameVerts.push(0, y, 0, size, y, 0);
        frameVerts.push(size, y, 0, size, y, size);
        frameVerts.push(size, y, size, 0, y, size);
        frameVerts.push(0, y, size, 0, y, 0);
    }

    // --- 🟨 黄：底面(Y=0) と 天井(Y=256) の4マス格子（水平の面） ---
    for (const y of yLevels) {
        for (let i = 4; i < size; i += 4) {
            gridVerts.push(i, y, 0, i, y, size); // Z軸に平行
            gridVerts.push(0, y, i, size, y, i); // X軸に平行
        }
    }

    // --- 🟨 黄：壁4面（側面の面）の4マス格子（垂直・水平の線） ---
    for (let y = 4; y < height; y += 4) {
        gridVerts.push(0, y, 0, size, y, 0);       // 前の面
        gridVerts.push(size, y, 0, size, y, size); // 右の面
        gridVerts.push(size, y, size, 0, y, size); // 奥の面
        gridVerts.push(0, y, size, 0, y, 0);       // 左の面
    }

    for (let i = 4; i < size; i += 4) {
        gridVerts.push(i, 0, 0, i, height, 0);       // Z=0 の壁の縦線
        gridVerts.push(i, 0, size, i, height, size); // Z=16 の壁の縦線
        gridVerts.push(0, 0, i, 0, height, i);       // X=0 の壁の縦線
        gridVerts.push(size, 0, i, size, height, i); // X=16 の壁の縦線
    }

    const frameGeo = new THREE.BufferGeometry();
    frameGeo.setAttribute('position', new THREE.Float32BufferAttribute(frameVerts, 3));
    const frameLines = new THREE.LineSegments(frameGeo, chunkBorderFrameMaterial);
    // 💡 レンダーオーダーによる強制上書きを解除
    frameLines.renderOrder = 0;

    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridVerts, 3));
    const gridLines = new THREE.LineSegments(gridGeo, chunkGridMaterial);
    gridLines.renderOrder = 0;

    chunkBorderMesh.add(frameLines);
    chunkBorderMesh.add(gridLines);
    chunkBorderMesh.visible = false;
    scene.add(chunkBorderMesh);
}

// 初期化の実行
initChunkBorderGeometries();




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

/* ======================================================
   【超軽量・ボクセル視線判定（DDAアルゴリズム ＋ 精密メッシュ判定）】
   ====================================================== */
function getTargetBlockByDDA(maxDistance) {
    const pos = camera.position;
    const dir = allocVec();
    camera.getWorldDirection(dir);

    let hitNormal = allocVec();
    let distance = 0;
    let found = false;

    // 精密レイキャスト用のオブジェクト
    const tempRaycaster = new THREE.Raycaster(pos, dir, 0.01, maxDistance);
    const intersects = [];

    try {
        let x = Math.floor(pos.x);
        let y = Math.floor(pos.y);
        let z = Math.floor(pos.z);

        const stepX = Math.sign(dir.x);
        const stepY = Math.sign(dir.y);
        const stepZ = Math.sign(dir.z);

        const tDeltaX = Math.abs(1 / dir.x);
        const tDeltaY = Math.abs(1 / dir.y);
        const tDeltaZ = Math.abs(1 / dir.z);

        let tMaxX = stepX > 0 ? (x + 1 - pos.x) * tDeltaX : (pos.x - x) * tDeltaX;
        let tMaxY = stepY > 0 ? (y + 1 - pos.y) * tDeltaY : (pos.y - y) * tDeltaY;
        let tMaxZ = stepZ > 0 ? (z + 1 - pos.z) * tDeltaZ : (pos.z - z) * tDeltaZ;

        while (distance < maxDistance) {
            if (tMaxX < tMaxY) {
                if (tMaxX < tMaxZ) { x += stepX; distance = tMaxX; tMaxX += tDeltaX; hitNormal.set(-stepX, 0, 0); }
                else { z += stepZ; distance = tMaxZ; tMaxZ += tDeltaZ; hitNormal.set(0, 0, -stepZ); }
            } else {
                if (tMaxY < tMaxZ) { y += stepY; distance = tMaxY; tMaxY += tDeltaY; hitNormal.set(0, -stepY, 0); }
                else { z += stepZ; distance = tMaxZ; tMaxZ += tDeltaZ; hitNormal.set(0, 0, -stepZ); }
            }

            if (y >= 0 && y < CHUNK_HEIGHT) {
                const cx = getChunkCoord(x);
                const cz = getChunkCoord(z);
                let lx = x % CHUNK_SIZE; if (lx < 0) lx += CHUNK_SIZE;
                let lz = z % CHUNK_SIZE; if (lz < 0) lz += CHUNK_SIZE;

                const voxel = ChunkSaveManager.getBlock(cx, cz, lx, y, lz)
                    ?? getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });

                if (voxel !== BLOCK_TYPES.SKY) {
                    const conf = getBlockConfiguration(voxel);
                    if (conf?.targetblock !== false) {
                        if (conf.geometryType && conf.geometryType !== "cube") {
                            intersects.length = 0;
                            const chunkKey = encodeChunkKey(cx, cz);
                            const chunkMesh = loadedChunks.get(chunkKey);
                            if (chunkMesh) tempRaycaster.intersectObject(chunkMesh, true, intersects);

                            const hasHitInGrid = intersects.some(hit => {
                                const hx = Math.floor(hit.point.x - (hit.face ? hit.face.normal.x : 0) * 1e-5);
                                const hy = Math.floor(hit.point.y - (hit.face ? hit.face.normal.y : 0) * 1e-5);
                                const hz = Math.floor(hit.point.z - (hit.face ? hit.face.normal.z : 0) * 1e-5);
                                return hx === x && hy === y && hz === z;
                            });
                            if (hasHitInGrid) { found = true; break; }
                        } else { found = true; break; }
                    }
                }
            }
        }

        if (found) {
            return { x, y, z, normal: hitNormal, distance }; // 成功時は呼び出し元がfreeVec(hitNormal)する
        } else {
            freeVec(hitNormal);
            return null;
        }
    } finally {
        freeVec(dir); // ⚠️ 成功・失敗に関わらず、dirは100%プールに返却される
    }
}

/* ======================================================
   【修正版：アウトラインの選択更新】
   ====================================================== */
function updateBlockSelection() {
    const hit = getTargetBlockByDDA(BLOCK_INTERACT_RANGE);

    if (!hit) {
        selectionOutlineMesh.visible = false;
        return;
    }

    const { x, y, z } = hit;
    const cx = getChunkCoord(x);
    const cz = getChunkCoord(z);

    // ✅ 負の座標に対応する数学的剰余
    let lx = x % CHUNK_SIZE;
    if (lx < 0) lx += CHUNK_SIZE;
    let lz = z % CHUNK_SIZE;
    if (lz < 0) lz += CHUNK_SIZE;

    const voxel = ChunkSaveManager.getBlock(cx, cz, lx, y, lz)
        ?? getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });

    const config = getBlockConfiguration(voxel);

    let center = globalTempVec3b;
    let size = globalTempVec3c;

    if (config && config.selectionSize && config.selectionOffset) {
        center.set(x + config.selectionOffset.x, y + config.selectionOffset.y, z + config.selectionOffset.z);
        size.set(config.selectionSize.x, config.selectionSize.y, config.selectionSize.z);
    } else {
        center.set(x + 0.5, y + 0.5, z + 0.5);
        size.set(1, 1, 1);
    }

    selectionOutlineMesh.position.copy(center);
    selectionOutlineMesh.scale.copy(size);
    selectionOutlineMesh.visible = true;

    freeVec(hit.normal);
}

/* ======================================================
   【修正版：UI情報表示更新】
   ====================================================== */
function updateBlockInfo() {
    const hit = getTargetBlockByDDA(BLOCK_INTERACT_RANGE);

    if (!hit) {
        blockInfoElem.style.display = "none";
        return;
    }

    const { x, y, z } = hit;
    const cx = getChunkCoord(x);
    const cz = getChunkCoord(z);

    // ✅ 負の座標に対応する数学的剰余
    let lx = x % CHUNK_SIZE;
    if (lx < 0) lx += CHUNK_SIZE;
    let lz = z % CHUNK_SIZE;
    if (lz < 0) lz += CHUNK_SIZE;

    const voxel = ChunkSaveManager.getBlock(cx, cz, lx, y, lz)
        ?? getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });

    if (voxel === BLOCK_TYPES.SKY) {
        blockInfoElem.style.display = "none";
        freeVec(hit.normal);
        return;
    }

    const blockName = BLOCK_NAMES[voxel] || "Unknown";
    const config = getBlockConfiguration(voxel);

    blockInfoElem.innerHTML = `Block: ${blockName} (Value: ${voxel})` + (config ? `<br>Type: ${config.geometryType}` : "");
    blockInfoElem.style.display = "block";

    freeVec(hit.normal);
}

/* ======================================================
   【修正版：プレイヤー頭部のブロック情報更新】
   ====================================================== */
function updateHeadBlockInfo() {
    const currentHeight = getCurrentPlayerHeight();
    const headY = player.position.y + currentHeight * 0.85;

    const hX = Math.floor(player.position.x);
    const hY = Math.floor(headY);
    const hZ = Math.floor(player.position.z);

    const cx = getChunkCoord(hX);
    const cz = getChunkCoord(hZ);

    // ✅ 負の座標に対応する数学的剰余
    let hLx = hX % CHUNK_SIZE;
    if (hLx < 0) hLx += CHUNK_SIZE;
    let hLz = hZ % CHUNK_SIZE;
    if (hLz < 0) hLz += CHUNK_SIZE;

    const blockValue = ChunkSaveManager.getBlock(cx, cz, hLx, hY, hLz)
        ?? getVoxelAtWorld(hX, hY, hZ, globalTerrainCache, { raw: true });

    const blockName = BLOCK_NAMES[blockValue] || "Unknown";

    const elem = document.getElementById("headBlockInfo");
    if (elem) {
        const newText = `Head Block: ${blockName} (Value: ${blockValue})`;
        if (elem.textContent !== newText) {
            elem.textContent = newText;
        }
        if (elem.style.display !== "block") {
            elem.style.display = "block";
        }
    }
}

/* ======================================================
   【統合・最適化】パーティクルシステム（マイクラ準拠）
   ====================================================== */
const particlePool = [];
const activeParticleGroups = [];
const GRAVITY = 9.8 * 0.8;

const materialPool = new Map();
let noTextureMaterial = null;

// 💡 干渉を避けるため、名前を 'particleGeoCache' に変更
const particleGeoCache = new Map();

// --- 💡 マテリアルを Basic にし、色を「白」で統一（真っ黒防止） ---
const getOrCreateMaterialForTexture = (texture) => {
    if (!texture) {
        if (!noTextureMaterial) {
            noTextureMaterial = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 1,
                side: THREE.DoubleSide
            });
        }
        return noTextureMaterial;
    }

    if (materialPool.has(texture)) return materialPool.get(texture);

    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: texture,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide
    });

    materialPool.set(texture, mat);
    return mat;
};

const getCachedParticleGeometry = (i, j, grid, size) => {
    const sizeInt = Math.floor(size * 100);
    const hashKey = (grid << 24) | (i << 16) | (j << 8) | sizeInt;

    // 💡 リネームしたキャッシュを参照
    if (particleGeoCache.has(hashKey)) return particleGeoCache.get(hashKey);

    const geo = new THREE.PlaneGeometry(size, size).center();
    const uv = geo.attributes.uv.array;
    const [u0, v0] = [i / grid, j / grid];
    const [u1, v1] = [(i + 1) / grid, (j + 1) / grid];
    uv.set([u0, v0, u1, v0, u1, v1, u0, v1]);
    geo.attributes.uv.needsUpdate = true;
    geo.__cached = true;

    particleGeoCache.set(hashKey, geo);
    return geo;
};

const getPooledParticle = () => {
    const p = particlePool.pop();
    if (p) {
        p.visible = true;
        return p;
    }
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.__cached = false;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, side: THREE.DoubleSide });
    return new THREE.Mesh(geo, mat);
};

const releasePooledParticle = p => {
    p.userData = {};
    p.visible = false;
    if (p.parent) p.parent.remove(p);
    if (p.geometry && !p.geometry.__cached) {
        p.geometry.dispose();
        p.geometry = null;
    }
    particlePool.push(p);
};

/**
 * マイクラ準拠の破壊パーティクルを一括生成
 */
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

                rndVec.set((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2);

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

            ud.velocity.x *= 0.98;
            ud.velocity.z *= 0.98;

            const bx = Math.floor(p.position.x);
            const by = Math.floor(p.position.y);
            const bz = Math.floor(p.position.z);

            const pCx = getChunkCoord(bx);
            const pCz = getChunkCoord(bz);

            const voxel = ChunkSaveManager.getBlock(pCx, pCz, bx & 15, by, bz & 15)
                ?? getVoxelAtWorld(bx, by, bz, globalTerrainCache, { raw: true });

            if (voxel !== BLOCK_TYPES.SKY && voxel !== BLOCK_TYPES.WATER) {
                const cfg = getBlockConfiguration(voxel);
                if (!cfg || cfg.collision !== false) {

                    const topY = by + getBlockHeight(voxel);

                    if (ud.velocity.y < 0 && p.position.y >= topY - 0.1 && p.position.y <= topY + 0.2) {
                        p.position.y = topY;
                        ud.velocity.y = 0;
                        ud.velocity.x *= 0.7;
                        ud.velocity.z *= 0.7;
                    }
                    else if (p.position.y < topY - 0.1) {
                        const pushDirs = [
                            { x: 1, z: 0 }, { x: -1, z: 0 },
                            { x: 0, z: 1 }, { x: 0, z: -1 }
                        ];

                        const validCandidates = [];
                        for (const dir of pushDirs) {
                            const checkCx = getChunkCoord(bx + dir.x);
                            const checkCz = getChunkCoord(bz + dir.z);

                            const sideVoxel = ChunkSaveManager.getBlock(checkCx, checkCz, (bx + dir.x) & 15, by, (bz + dir.z) & 15)
                                ?? getVoxelAtWorld(bx + dir.x, by, bz + dir.z, globalTerrainCache, { raw: true });

                            if (sideVoxel === BLOCK_TYPES.SKY || sideVoxel === BLOCK_TYPES.WATER) {
                                validCandidates.push(dir);
                            }
                        }

                        if (validCandidates.length > 0) {
                            const chosenDir = validCandidates[Math.floor(Math.random() * validCandidates.length)];

                            p.position.x += chosenDir.x * 0.1;
                            p.position.z += chosenDir.z * 0.1;

                            ud.velocity.x = chosenDir.x * 1.5;
                            ud.velocity.z = chosenDir.z * 1.5;
                            ud.velocity.y = 0;
                        } else {
                            ud.velocity.set(0, 0, 0);
                            ud.elapsed = ud.lifetime;
                        }
                    }
                }
            }

            p.quaternion.copy(camera.quaternion);

            if (ud.elapsed >= ud.lifetime) {
                // 💡 [修正①] 次の描画に影響が出ないよう、マテリアルの色を白色（RGB 1.0）に戻してプールへ
                if (p.material && p.material.color) {
                    p.material.color.setRGB(1.0, 1.0, 1.0);
                }

                releasePooledParticle(p);
                group.remove(p);
            }
        } // (piループの終わり)

        if (group.children.length === 0) {
            // 💡 [修正②] クローンした専用マテリアルを破棄してメモリリーク（VRAM枯渇）を回避
            if (group.userData && typeof group.userData.dispose === "function") {
                group.userData.dispose();
            }

            scene.remove(group);
            ag.splice(gi, 1);
        }
    } // (giループの終わり)
};
/**
 * プレイヤーの AABB（当たり判定）の下半身サンプルによる水中判定
 * 下半身の下部5点（中央＋四隅）をサンプリングし、3点以上が水ブロックなら水中と判断する。
 */
/**
 * プレイヤーの AABB（当たり判定）の複数サンプルによる水中判定
 */
const waterSamplePointsPool = Array.from({ length: 6 }, () => new THREE.Vector3()); // 💡 6点に拡張
const _waterCellCache = new Map();

function isPlayerEntireBodyInWater() {
    const { min, max } = getPlayerAABB();

    const midY = (min.y + max.y) / 2; // 足元からお腹（半分）までの高さ
    const topY = max.y - 0.1;        // 💡 頭上（少し内側に下げて、天井へのめり込み誤判定を防止）

    // 登録する座標（足元4点 + お腹1点 + 頭1点 の計6点）
    waterSamplePointsPool[0].set(min.x, min.y, min.z); // 足元：左手前
    waterSamplePointsPool[1].set(max.x, min.y, min.z); // 足元：右手前
    waterSamplePointsPool[2].set(min.x, min.y, max.z); // 足元：左奥
    waterSamplePointsPool[3].set(max.x, min.y, max.z); // 足元：右奥
    waterSamplePointsPool[4].set((min.x + max.x) / 2, midY, (min.z + max.z) / 2); // お腹の中心
    waterSamplePointsPool[5].set((min.x + max.x) / 2, topY, (min.z + max.z) / 2); // 💡 頭の中心

    let waterCount = 0;
    let isHeadInWater = false; // 💡 頭の判定用フラグ

    _waterCellCache.clear();

    for (let i = 0; i < 6; i++) { // 💡 6回ループ
        const point = waterSamplePointsPool[i];
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);
        const z = Math.floor(point.z);

        const ox = x + 30000;
        const oz = z + 30000;
        const numericKey = (ox) + (oz) * 100000 + (y + 100) * 10000000000;

        let blockValue = _waterCellCache.get(numericKey);
        if (blockValue === undefined) {
            const cx = getChunkCoord(x);
            const cz = getChunkCoord(z);

            blockValue = ChunkSaveManager.getBlock(cx, cz, x & 15, y, z & 15)
                ?? getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });

            _waterCellCache.set(numericKey, blockValue);
        }

        const isWater = (blockValue === BLOCK_TYPES.WATER);

        if (i < 5) {
            // インデックス 0〜4 は下半身の多数決用
            if (isWater) waterCount++;
        } else {
            // インデックス 5 は頭の判定用
            isHeadInWater = isWater;
        }
    }

    // 💡 条件A：「下半身が水没（従来の5点中3点）」 OR 条件B：「頭が水没」
    return (waterCount >= 3) || isHeadInWater;
}

// 関数の外（直上など）に1度だけ定義
const _VEC_UP = new THREE.Vector3(0, 1, 0); // ✅ 上方向の定数

// ======================================================
// 【修正版】水中物理アップデート
// ======================================================
function updateUnderwaterPhysics(delta) {
    const TARGET_SWIM_SPEED = 0.08,
        DASH_MULTIPLIER = 1.6,
        ACCELERATION = 0.15,
        WATER_DRAG = 0.08;

    // 🔥 1. 自然な沈降速度を少し強める（-0.05 ➔ -0.09）
    // これにより、キーを離した時、あるいは水面に顔を出した時にしっかり「深く沈む」ようになります。
    const NATURAL_SINK_SPEED = -0.10;

    const effectiveSpeed = dashActive ? TARGET_SWIM_SPEED * DASH_MULTIPLIER : TARGET_SWIM_SPEED;

    // 1. 水平方向（XZ）の基準になる「前」を取得
    const forward = globalTempVec3;
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = globalTempVec3b;
    right.crossVectors(forward, _VEC_UP).normalize();

    const swimVel = globalTempVec3c;
    swimVel.set(0, 0, 0);

    // 2. キー入力の反映
    if (keys["w"] || keys["arrowup"]) swimVel.add(forward);
    if (keys["s"] || keys["arrowdown"]) swimVel.sub(forward);
    if (keys["d"] || keys["arrowright"]) swimVel.add(right);
    if (keys["a"] || keys["arrowleft"]) swimVel.sub(right);

    if (swimVel.lengthSq() > 0) {
        swimVel.normalize().multiplyScalar(effectiveSpeed);
    }

    // 3. 上下移動の判定（カメラの視線角度 ＋ Space / Shift）
    const lookDir = allocVec();
    camera.getWorldDirection(lookDir);

    if (keys["w"] || keys["arrowup"]) {
        swimVel.y += lookDir.y * effectiveSpeed;
    }
    freeVec(lookDir);

    if (keys[" "]) {
        swimVel.y = effectiveSpeed;
    } else if (keys["shift"]) {
        swimVel.y = -effectiveSpeed;
    } else if (!keys["w"] && !keys["arrowup"]) {
        swimVel.y = NATURAL_SINK_SPEED;
    }

    // 4. 速度の線形補間
    player.velocity.x = THREE.MathUtils.lerp(player.velocity.x, swimVel.x, ACCELERATION);
    player.velocity.z = THREE.MathUtils.lerp(player.velocity.z, swimVel.z, ACCELERATION);

    // 🔥 2. 沈み込みと浮き上がりのタメのバランスを調整（0.025 ➔ 0.04）
    // 0.025だと浮き上がりが非常に遅かったので、0.04付近にすることで「ズボッ」と沈んでから「にゅー」っと上がってきます。
    player.velocity.y = THREE.MathUtils.lerp(player.velocity.y, swimVel.y, 0.04);

    player.velocity.multiplyScalar(1 - WATER_DRAG);
}

const clock = new THREE.Clock();
let wasUnderwater = false;

// タイマー管理用
let cloudUpdateTimer = 0;
let cloudGridTimer = 0;
let underwaterTimer = 0;
let chunkUpdateFrameTimer = 0;  // 自然チャンク更新用
let blockInfoTimer = 0;
const _camOffset = new THREE.Vector3();

function animate() {
    requestAnimationFrame(animate);

    let delta = clock.getDelta();
    if (delta > 0.1) delta = 0.1;
    const now = performance.now();
    frameCount++;

    // -------- HUD更新（1秒ごと） --------
    if (now - lastFpsTime > 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));

        // 1. メッシュ再構築待ち(再描画待ち)のキューの合計
        const activeUpdates = pendingChunkUpdates.size + chunkQueue.length;

        // 2. プレイヤーが手を加えた（保存された）チャンクの総数
        const modifiedChunkCount = ChunkSaveManager.modifiedChunks.size;

        const pCx = Math.floor(player.position.x / CHUNK_SIZE);
        const pCz = Math.floor(player.position.z / CHUNK_SIZE);

        // 💡 崩れないように綺麗に整形したHTML
        fpsCounter.innerHTML =
            `<span>Minecraft Alpha v0.0.1a</span><br>` +
            `<span>${fps} fps, ${activeUpdates} chunks update</span><br>` + // 👈 元の表示を復活！
            `<span>${modifiedChunkCount} modified chunks (Saved)</span><br>` + // 👈 変更検知を新設！
            `<span>C: ${loadedChunks.size} loaded. (Quality: ${CHUNK_VISIBLE_DISTANCE} chunks)</span><br>` +
            `<span>Dimension: Overworld</span><br>` +
            `<span>x: ${Math.round(player.position.x) === 0 ? 0 : Math.round(player.position.x)} (C: ${pCx})</span><br>` +
            `<span>y: ${Math.round(player.position.y) === 0 ? 0 : Math.round(player.position.y)} (feet)</span><br>` +
            `<span>z: ${Math.round(player.position.z) === 0 ? 0 : Math.round(player.position.z)} (C: ${pCz})</span><br>` +
            `<span>Mode: ${flightMode ? "Flight" : wasUnderwater ? "Swimming" : "Walking"} / Dash: ${dashActive ? "ON" : "OFF"} / Sneak: ${sneakActive ? "ON" : "OFF"}</span>`;

        frameCount = 0;
        lastFpsTime = now;
    }

    // -------- プレイヤー操作 & 物理更新 --------
    updateBlockParticles(delta);

    camera.rotation.set(pitch, yaw, 0);

    // 💡 1. 水中判定を「ジャンプ判定の前」に持ってくる
    underwaterTimer += delta;
    if (underwaterTimer > 0.1) {
        wasUnderwater = isPlayerEntireBodyInWater();
        underwaterTimer = 0;
    }

    // 💡 2. ジャンプ要求のフラグ立て（泳いでいない時だけ予約を許可する）
    if (!flightMode && keys[" "] && player.onGround && !wasUnderwater) {
        jumpRequest = true;
    }

    // 💡 3. 物理演算の分岐。泳いでいる時はジャンプ要求を確実にへし折る
    if (flightMode) {
        updateFlightPhysics(delta);
    } else if (wasUnderwater) {
        updateUnderwaterPhysics(delta);
        jumpRequest = false; // 🔥 水中上昇中は、陸上の跳躍予約を毎フレーム完全にリセット！
    } else {
        updateNormalPhysics(delta);
    }

    resolvePlayerCollision();
    updateOnGround();

    // -------- チャンク更新 --------
    updateChunks();

    chunkUpdateFrameTimer += delta;
    if (chunkUpdateFrameTimer > 0.016) { // 約 60fps ごと
        if (pendingChunkUpdates.size > 0) {
            // 💡 修正：固定の「1枚」ではなく、時間計測ブレーキの「限界まで」働く設定に変更！
            processPendingChunkUpdates(Infinity);
        }
        chunkUpdateFrameTimer = 0;
    }

    // -------- チャンク境界の描画 --------
    if (showChunkBorders) {
        const pCx = Math.floor(player.position.x / CHUNK_SIZE);
        const pCz = Math.floor(player.position.z / CHUNK_SIZE);

        // 赤い大枠を、プレイヤーがいるチャンクの原点に合わせるだけで完了！
        chunkBorderMesh.position.set(pCx * CHUNK_SIZE, 0, pCz * CHUNK_SIZE);
    }

    // -------- カメラ更新 --------
    const targetCamPos = globalTempVec3;
    _camOffset.set(0, getCurrentPlayerHeight() - (flightMode ? 0.15 : 0), 0);
    targetCamPos.copy(player.position).add(_camOffset);

    camera.position.x = targetCamPos.x;
    camera.position.z = targetCamPos.z;

    camera.position.y = THREE.MathUtils.lerp(camera.position.y, targetCamPos.y, 0.5);

    // -------- ブロック情報更新（間引き） -----------
    blockInfoTimer += delta;
    if (blockInfoTimer > 0.05) {

        const moved = camera.position.distanceToSquared(lastCamPos) > 0.00001 ||
            camera.rotation.x !== lastCamRot.x ||
            camera.rotation.y !== lastCamRot.y ||
            camera.rotation.z !== lastCamRot.z;

        if (moved) {
            updateBlockSelection();
            updateBlockInfo();
            updateHeadBlockInfo();

            lastCamPos.copy(camera.position);
            lastCamRot.copy(camera.rotation);
        }
        blockInfoTimer = 0;
    }

    // -------- クラウド更新 --------
    cloudUpdateTimer += delta;
    cloudGridTimer += delta;

    if (cloudUpdateTimer > 0.05) {
        updateCloudTiles(delta);
        updateCloudOpacity(camera.position);
        cloudUpdateTimer = 0;
    }

    if (cloudGridTimer > 0.1) {
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





/* ======================================================
   【チャットログシステム】
   ====================================================== */
const chatContainer = document.getElementById("chat-container");
const MAX_CHAT_LOGS = 50; // 最大ログ保持数

/**
 * チャット画面にメッセージを追加する
 * @param {string} text - メッセージ内容
 * @param {string} color - 文字色 (オプション。標準は白色)
 * @param {number} duration - フェードアウトまでの時間（ミリ秒。標準は6秒）
 */
function addChatMessage(text, color = "#ffffff", duration = 6000) {
    if (!chatContainer) return;

    // ログが多すぎる場合は古いものを削除
    while (chatContainer.children.length >= MAX_CHAT_LOGS) {
        chatContainer.removeChild(chatContainer.firstChild);
    }

    const messageEl = document.createElement("div");
    messageEl.className = "chat-message";
    messageEl.innerText = text;
    messageEl.style.color = color;

    chatContainer.appendChild(messageEl);

    // 最新ログが見えるように自動スクロール
    chatContainer.scrollTop = chatContainer.scrollHeight;

    // 一定時間後にフェードアウトして消す
    setTimeout(() => {
        messageEl.style.opacity = "0";
        setTimeout(() => {
            if (messageEl.parentNode === chatContainer) {
                chatContainer.removeChild(messageEl);
            }
        }, 1000); // transitionの1秒に合わせる
    }, duration);
}

// グローバルでどこからでも呼べるように window に露出
window.addChatMessage = addChatMessage;
addChatMessage("Minecraft for browser alpha 0.0.1a", "#ffff55");