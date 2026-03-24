"use strict";
import * as THREE from './build/three.module.js';

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
    captureBaseChunkData: function (cx, cz) {
        const data = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
        const baseX = cx * CHUNK_SIZE;
        const baseZ = cz * CHUNK_SIZE;

        let idx = 0; // ループ順(X->Z->Y)に合わせて 0 から連番で書き込み

        for (let x = 0; x < CHUNK_SIZE; x++) {
            const worldX = baseX + x;

            for (let z = 0; z < CHUNK_SIZE; z++) {
                const worldZ = baseZ + z;

                // 地表の高さを取得
                const surfaceHeight = getTerrainHeight(worldX, worldZ);

                for (let y = 0; y < CHUNK_HEIGHT; y++) {
                    const worldY = BEDROCK_LEVEL + y;
                    let blockType = BLOCK_TYPES.SKY;

                    // --- 純粋な地形生成ロジック ---
                    if (worldY === BEDROCK_LEVEL) {
                        blockType = BLOCK_TYPES.BEDROCK;
                    } else if (worldY < surfaceHeight) {
                        // 通常の地層計算
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

                    // 1次元配列へ書き込み
                    data[idx++] = blockType;
                }
            }
        }
        return data;
    }
};
const terrainKeyHash = (x, z) => ((x & 0xFFFF) << 16) | (z & 0xFFFF);

/**
 * 生成されたベース地形配列に対して、洞窟の空洞を上書き(カーブ)する関数
 */
function carveCavesInChunkData(cx, cz, data) {
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    let idx = 0;

    for (let x = 0; x < CHUNK_SIZE; x++) {
        const worldX = baseX + x;

        for (let z = 0; z < CHUNK_SIZE; z++) {
            const worldZ = baseZ + z;

            const surfaceHeight = getTerrainHeight(worldX, worldZ);
            const caveY = getCaveCenterY(worldX, worldZ);
            const caveR = getCaveRadius(worldX, worldZ);

            for (let y = 0; y < CHUNK_HEIGHT; y++) {
                const worldY = BEDROCK_LEVEL + y;

                // 岩盤より上、地表より下
                if (worldY > 3 && worldY < surfaceHeight) {
                    const dy = worldY - caveY;

                    // 洞窟の範囲内であればSKYにする
                    if ((dy * dy) < caveR * caveR) {
                        data[idx] = BLOCK_TYPES.SKY;
                    }
                }
                idx++; // 配列のインデックスを進める
            }
        }
    }
}

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

function checkAABBCollision(aabb, velocity, dt) {
    if (!(aabb instanceof THREE.Box3)) aabb = new THREE.Box3(aabb.min.clone(), aabb.max.clone());
    const isDynamic = velocity !== undefined && dt !== undefined;
    const result = isDynamic ? { collision: false, time: dt, normal: new THREE.Vector3() } : false;

    const startX = Math.floor(aabb.min.x - 0.01);
    const endX = Math.ceil(aabb.max.x + 0.01);
    const startY = Math.floor(aabb.min.y - 0.01);
    const endY = Math.ceil(aabb.max.y + 0.01);
    const startZ = Math.floor(aabb.min.z - 0.01);
    const endZ = Math.ceil(aabb.max.z + 0.01);

    for (let x = startX; x < endX; x++)
        for (let y = startY; y < endY; y++)
            for (let z = startZ; z < endZ; z++) {
                const id = getVoxelAtWorld(x, y, z);
                if (id === BLOCK_TYPES.SKY) continue;

                let coll = blockCollisionFlagCache.get(id);
                if (coll === undefined) { getCachedCollisionBoxes(id); coll = blockCollisionFlagCache.get(id); }
                if (!coll) continue;

                const relBoxes = blockCollisionBoxCache.get(id);
                for (const rel of relBoxes) {
                    const wb = getPooledBox();
                    wb.copy(rel);
                    wb.min.addScalar(0); wb.max.addScalar(0);
                    wb.min.x += x; wb.max.x += x;
                    wb.min.y += y; wb.max.y += y;
                    wb.min.z += z; wb.max.z += z;

                    if (isDynamic) {
                        const r = sweptAABB(aabb, velocity, dt, wb);
                        if (r.collision && r.time < result.time) Object.assign(result, r);
                        if (r.time < 1e-5) { releasePooledBox(wb); return result; }
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
const MAX_SEARCH_DEPTH = 32;

function getTerrainHeight(worldX, worldZ, startY) {
    const xInt = Math.floor(worldX);
    const zInt = Math.floor(worldZ);

    if (startY !== undefined) {
        let y = Math.floor(startY);
        const minY = Math.max(0, y - MAX_SEARCH_DEPTH);
        for (; y >= minY; y--) {
            // SKYはBLOCK_TYPES.SKYのダミー（0）
            if (getVoxelAtWorld(xInt, y, zInt) !== 0) return y + 1;
        }
        return -Infinity;
    }

    const key = ((xInt & 0xffff) << 16) | (zInt & 0xffff);
    if (terrainHeightCache.has(key)) return terrainHeightCache.get(key);

    // 💡 修正ポイント: 古い getMinecraftFractalNoise を、新設した fractalNoise2D に差し替え
    const noise = fractalNoise2D(xInt * NOISE_SCALE, zInt * NOISE_SCALE, 5, 0.5);
    let heightModifier = noise * 35;

    if (noise > 0.2) {
        heightModifier += Math.pow(noise - 0.2, 2) * 60;
    }

    const result = Math.floor(BASE_HEIGHT + heightModifier);

    if (terrainCacheKeys.length >= MAX_CACHE_SIZE) {
        const oldKey = terrainCacheKeys.shift();
        terrainHeightCache.delete(oldKey);
    }

    terrainCacheKeys.push(key);
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

// 💡 引数の { raw: false } = {} を raw = false に変更してメモリを節約
function getVoxelAtWorld(x, y, z, terrainCache = globalTerrainCache, raw = false) {
    if (y < 0 || y >= CHUNK_HEIGHT) return SKY;

    const fx = Math.floor(x);
    const fz = Math.floor(z);

    const cx = Math.floor(fx / CHUNK_SIZE);
    const cz = Math.floor(fz / CHUNK_SIZE);

    let lx = fx % CHUNK_SIZE;
    if (lx < 0) lx += CHUNK_SIZE;

    let lz = fz % CHUNK_SIZE;
    if (lz < 0) lz += CHUNK_SIZE;

    // --- 1. ChunkSaveManager からブロックを取得 (初期生成時の洞窟SKYもここから返る) ---
    const modValue = ChunkSaveManager.getBlock(cx, cz, lx, y, lz);

    if (modValue !== null) {
        if (raw) return modValue;

        let isSolid = blockCollisionCache.get(modValue);
        if (isSolid === undefined) {
            isSolid = !!getBlockConfigById(modValue)?.collision;
            blockCollisionCache.set(modValue, isSolid);
        }
        return isSolid ? modValue : SKY;
    }

    // --- 2. まだメモリに生成されていないチャンクのフォールバック (未踏の地) ---
    if (y === BEDROCK_LEVEL) return BEDROCK;

    const surfaceHeight = getTerrainHeight(fx, fz);

    if (y >= surfaceHeight && y > SEA_LEVEL) return SKY;

    // 💡 【ここを追加！】フォールバック時も、その座標が洞窟（Tube）の内部なら SKY（空気）を返す
    if (y > 3 && y < surfaceHeight) {
        const caveY = getCaveCenterY(fx, fz);
        const caveR = getCaveRadius(fx, fz);
        const dy = y - caveY;

        if ((dy * dy) < caveR * caveR) {
            return SKY; // 洞窟の中なので、衝突判定でも空気として扱う
        }
    }

    if (y < surfaceHeight) {
        if (y === surfaceHeight - 1) {
            return (y <= SEA_LEVEL) ? BLOCK_TYPES.DIRT : BLOCK_TYPES.GRASS;
        } else if (y > surfaceHeight - 4) {
            return BLOCK_TYPES.DIRT;
        }
        return BLOCK_TYPES.STONE;
    } else if (y <= SEA_LEVEL) {
        return BLOCK_TYPES.WATER;
    }

    return SKY;
}


/* ======================================================
   【最新・3Dノイズ自然接続型チューブ洞窟システム】
   ====================================================== */

const CAVE_SCALE_XZ = 0.02; // 横方向の蛇行の細かさ
const CAVE_SCALE_Y = 0.04;  // 縦方向の蛇行の細かさ

/**
 * 💡 洞窟の中心Y座標（高さのうねり）
 * 地下のうねり自体に「地表へ突き抜ける（這い上がる）波」を混ぜ込みます。
 */
/**
 * 💡 修正最新版：周囲の地表の高さに引っ張られる自然な横穴・斜め穴システム
 */
function getCaveCenterY(worldX, worldZ) {
    const x = Math.abs(worldX);
    const z = Math.abs(worldZ);

    // 1. 通常の地下の深さ (Y = 15 〜 40)
    const baseNoise = fractalNoise2D(x * 0.006, z * 0.006, 2, 0.5);
    const baseY = 15 + baseNoise * 25;

    // 2. その座標の「実際の地表の高さ（山の高さ）」を取得
    const surfaceHeight = getTerrainHeight(worldX, worldZ);

    // 3. 大きなサイン波（これによって等間隔ではなく、うねりながら地上に近づく）
    const wave = Math.sin(worldX * 0.015) * Math.cos(worldZ * 0.015);

    let finalY = baseY;

    // 💡 修正ポイント：
    // サイン波がポジティブ（波の山）のとき、地表の高さ（surfaceHeight）に向かって斜めに引っ張り上げる。
    // これにより、山の斜面や地面に「横穴・斜め穴」としてチューブが突き抜けます。
    if (wave > 0) {
        // wave（0.0〜1.0）の強さに応じて、地下から地表へなだらかにブレンド
        const t = Math.pow(wave, 1.5); // 緩やかなスロープにする
        const targetY = surfaceHeight - 2; // 地表のすぐ下を削る
        finalY = baseY * (1 - t) + targetY * t;
    }

    if (finalY < 5) finalY = 5; // 岩盤突き抜け防止

    return finalY;
}

/**
 * 💡 洞窟の半径
 * 地下で繋がっているチューブが、そのままの太さで地上へ露出するようにします。
 */
function getCaveRadius(worldX, worldZ) {
    // 💡 完全に地下のチューブ構造ノイズ（n1 と n2 の差分）だけで形を決定する。
    const n1 = fractalNoise2D(worldX * CAVE_SCALE_XZ, worldZ * CAVE_SCALE_XZ, 2, 0.5);
    const n2 = fractalNoise2D((worldX + 2000) * CAVE_SCALE_XZ, (worldZ + 2000) * CAVE_SCALE_XZ, 2, 0.5);

    const diff = Math.abs(n1 - n2);
    const threshold = 0.07; // 閾値を少し狭めて、引き締まった綺麗なチューブ（パイプ）にする

    if (diff < threshold) {
        const thicknessFactor = (threshold - diff) / threshold;

        // 基本半径 2.5 〜 4.0。これによって地下から地上まで一貫した太さのチューブになる
        let radius = 2.5 + thicknessFactor * 1.5;

        // 大空洞（部屋）
        const roomNoise = perlinNoise2D(worldX * 0.03, worldZ * 0.03);
        if (roomNoise > 0.45) {
            radius += (roomNoise - 0.45) * 10;
        }

        return radius;
    }

    return 0;
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
        // 💡 修正ポイント: 進んだ先(nextX)で支えが無くなるなら、移動自体をキャンセルする（元のX座標に戻す）
        if (sneakActive && isOnGround) {
            const canDescendX = canDescendFromSupport(nextX, orig.z, halfWidth, margin);
            if (!canDescendX) {
                nextX = orig.x; // 崖っぷちで停止
                vel.x = 0;
            }
        }
        newPos.x = nextX;
    } else if (canStep) {
        tryStepClimb(nextX, orig.z);
    }
    freeVec(xPosNormal);

    // --- Z軸移動 ---
    let nextZ = orig.z + vel.z * dt;
    let zPosNormal = allocVec();
    zPosNormal.set(newPos.x, newPos.y, nextZ); // X反映後

    if (!checkAABBCollision(getPlayerAABBAt(zPosNormal))) {
        // 💡 修正ポイント: 進んだ先(nextZ)で支えが無くなるなら、移動自体をキャンセルする（元のZ座標に戻す）
        if (sneakActive && isOnGround) {
            const canDescendZ = canDescendFromSupport(newPos.x, nextZ, halfWidth, margin);
            if (!canDescendZ) {
                nextZ = orig.z; // 崖っぷちで停止
                vel.z = 0;
            }
        }
        newPos.z = nextZ;
    } else if (canStep) {
        tryStepClimb(newPos.x, nextZ);
    }
    freeVec(zPosNormal);

    // --- Y軸移動 (重力・着地判定) ---
    let y = newPos.y + vel.y * dt;
    const posY = allocVec();
    posY.set(newPos.x, y, newPos.z);

    // 元のY軸のスニーク落下防止ロジック（そのまま維持）
    if (sneakActive && !flightMode && vel.y < 0) {
        const canDescendY = !canDescendFromSupport(newPos.x, newPos.z, halfWidth, margin);
        if (isOnGround && !canDescendY) {
            y = newPos.y;
            vel.y = 0;
        }
    } else if (checkAABBCollision(getPlayerAABBAt(posY))) {
        y = resolveVerticalCollision(newPos.y, y, newPos.x, newPos.z);
        vel.y = 0;
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
            const voxel = getVoxelAtWorld(blockX, blockY, blockZ, globalTerrainCache, { raw: true });

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

    // ✅ 戻り値を変数(desiredVel)に受け取らず、呼び出すだけにする。
    // （内部で _vDesired が計算される）
    getDesiredHorizontalVelocity(speed);

    // ✅ グローバル計算済みの _vDesired から直接安全にコピーする
    _tmpDesiredVel.copy(_vDesired);

    player.velocity.x += (_tmpDesiredVel.x - player.velocity.x) * 0.1;
    player.velocity.z += (_tmpDesiredVel.z - player.velocity.z) * 0.1;

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
    const MAX_CHUNKS_PER_FRAME = 1; // 欲張らず1つずつ

    // deadlineが未定義、または timeRemaining がないブラウザ用のフォールバック
    const hasTime = () => {
        if (deadline && typeof deadline.timeRemaining === 'function') {
            return deadline.timeRemaining() > 1;
        }
        return true; // requestAnimationFrame等にフォールバックした時は時間判定を無視
    };

    while (chunkQueue.length > 0 && tasksProcessed < MAX_CHUNKS_PER_FRAME && hasTime()) {
        const t0 = performance.now();
        const chunkInfo = chunkQueue.shift();

        if (chunkInfo) {
            const { cx, cz } = chunkInfo;
            const key = encodeChunkKey(cx, cz);

            if (!loadedChunks.has(key)) {
                const mesh = generateChunkMeshMultiTexture(cx, cz);
                mesh.userData.fadedIn = false;
                setOpacityRecursive(mesh, 0);
                scene.add(mesh);
                loadedChunks.set(key, mesh);

                fadeInMesh(mesh, 500, () => {
                    mesh.userData.fadedIn = true;
                });
            }
        }

        if (performance.now() - t0 > 10) { // 10ms超えたら次のフレームへ譲る
            break;
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
 * 集められたキーをデコードして、各チャンクに対して refreshChunkAt を呼び出す
 */
// バッチ処理（batchSize = 2 がデフォルト）
function processPendingChunkUpdates(batchSize = 1) {
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

            // 💡 ガラスや草などの「くり抜き透過」かどうかを判定
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

            // 💡 修正ポイント: ガラス（切り抜き透過）なら、フェード中も最初から深度を書く！
            if (isGlass || isAlphaCutout) {
                mat.depthWrite = true;
            } else {
                mat.depthWrite = false; // 水などは従来通り false
            }

            mat.needsUpdate = true;
        });
    });

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

                // 💡 完全に元に戻す
                mat.transparent = realTransparent;
                mat.depthWrite = realDepthWrite;

                // カットアウト透過は alphaTest を復活させる
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
const ceilingCache = new Map();

const clearCaches = () => {
    blockConfigCache.clear();
    configCache.clear();
    subterraneanAreaCache.clear();
    topShadowCache.clear();
    sideShadowCache.clear();
    ceilingCache.clear();
};

// --- コンフィグ取得（キャッシュ統合） ---
const getConfigCached = id => {
    if (!configCache.has(id)) {
        if (!blockConfigCache.has(id)) blockConfigCache.set(id, getBlockConfiguration(id));
        configCache.set(id, blockConfigCache.get(id));
    }
    return configCache.get(id);
};

// --- 地下判定 ---
function getFaceHash(wx, wy, wz, faceIndex = 0) {
    const ox = Math.floor(wx) + 30000;
    const oz = Math.floor(wz) + 30000;
    const oy = Math.floor(wy);
    // 正確に53ビット以内に収まる数値ハッシュ
    return (ox * 100000000) + (oz * 10000) + (oy * 10) + faceIndex;
}

// --- 地下判定のキャッシュ差し替え ---
const isInSubterraneanArea = (wx, wy, wz) => {
    const key = getVoxelHash(wx, wy, wz); // 文字列廃止
    if (subterraneanAreaCache.has(key)) return subterraneanAreaCache.get(key);

    const maxY = BEDROCK_LEVEL + CHUNK_HEIGHT;
    for (let y = wy + 1; y < maxY; y++) {
        const id = getVoxelAtWorld(wx, y, wz);
        if (id && id !== BLOCK_TYPES.SKY && !(getConfigCached(id)?.transparent)) {
            subterraneanAreaCache.set(key, true);
            return true;
        }
    }
    subterraneanAreaCache.set(key, false);
    return false;
};

// --- 不透明判定 ---
const isFaceOpaque = (id, worldPos) => {
    if (!id || id === BLOCK_TYPES.SKY) return false;
    const cfg = getConfigCached(id);
    if (!cfg || cfg.transparent) return false;

    // 💡【修正】形状が立方体（cube）以外（stairsやslabなど）なら、不透明とみなさず隣の面を消さない！
    if (cfg.geometryType !== "cube") return false;

    if (cfg.customGeometry && worldPos) {
        const boxes = cfg.customCollision(worldPos);
        return boxes?.some(b => b.max.y - b.min.y > 0.01) || false;
    }
    return true;
};

// --- 天井チェック ---
const hasCeilingAbove = (wx, wy, wz) => {
    const key = getVoxelHash(wx, 0, wz); // 平面のキーとして Y=0 で統一
    if (ceilingCache.has(key)) return ceilingCache.get(key);

    const maxY = BEDROCK_LEVEL + CHUNK_HEIGHT;
    for (let y = wy + 1; y < maxY; y++) {
        const id = getVoxelAtWorld(wx, y, wz);
        if (id && id !== BLOCK_TYPES.SKY && !(getConfigCached(id)?.transparent)) {
            ceilingCache.set(key, true);
            return true;
        }
    }
    ceilingCache.set(key, false);
    return false;
};

// --- 下影 ---
const computeBottomShadowFactor = (wx, wy, wz) => {
    const id = getVoxelAtWorld(wx, wy, wz);
    const cfg = getConfigCached(id);

    if (cfg?.transparent) return hasCeilingAbove(wx, wy, wz) ? 0.4 : 1.0;
    if (isInSubterraneanArea(wx, wy, wz)) return 0.4;

    const belowId = getVoxelAtWorld(wx, wy - 1, wz);
    return isFaceOpaque(belowId, [wx, wy - 1, wz]) ? 0.55 : 0.45;
};

// --- 側面影 ---
const CEILING_CHECK_OFFSETS = { px: [1, 1, 0], nx: [-1, 1, 0], pz: [0, 1, 1], nz: [0, 1, -1] };
const computeSideShadowFactor = (wx, wy, wz, face, baseX, baseZ) => {
    const faceIndices = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 };
    const faceIdx = faceIndices[face] ?? 0;
    const key = getFaceHash(baseX + wx, wy, baseZ + wz, faceIdx); // 文字列廃止
    if (sideShadowCache.has(key)) return sideShadowCache.get(key);

    const o = CEILING_CHECK_OFFSETS[face];
    if (!o) return 1;

    let [checkX, checkY, checkZ] = [baseX + wx + o[0], wy + o[1], baseZ + wz + o[2]];
    const cacheKey = getVoxelHash(checkX, checkY, checkZ); // 文字列廃止
    if (ceilingCache.has(cacheKey)) {
        const factor = ceilingCache.get(cacheKey) ? 0.4 : 1;
        sideShadowCache.set(key, factor);
        return factor;
    }

    while (checkY < BEDROCK_LEVEL + CHUNK_HEIGHT) {
        if (isFaceOpaque(getVoxelAtWorld(checkX, checkY, checkZ), [checkX, checkY, checkZ])) {
            ceilingCache.set(cacheKey, true);
            return sideShadowCache.set(key, 0.4).get(key);
        }
        checkY++;
    }

    ceilingCache.set(cacheKey, false);
    return sideShadowCache.set(key, 1).get(key);
};

// --- 上面影 ---
const TOP_SHADOW_OFFSETS = { LL: [-1, 1], LR: [1, 1], UR: [1, -1], UL: [-1, -1] };
const getBlockHeights = id => {
    const type = getConfigCached(id)?.geometryType;
    return { slab: [0.5], stairs: [0.5, 1], cross: [1], water: [0.88], carpet: [0.0625] }[type] || [1];
};
const computeTopShadowFactorForCorner = (wx, wy, wz, corner, blockId) => {
    const cornerIndices = { LL: 0, LR: 1, UR: 2, UL: 3 };
    const cornerIdx = cornerIndices[corner] ?? 0;
    // ブロックID(1~255)を組み込んだハッシュ
    const key = (getVoxelHash(wx, wy, wz) * 1000) + (blockId * 10) + cornerIdx;

    if (topShadowCache.has(key)) return topShadowCache.get(key);

    const offset = TOP_SHADOW_OFFSETS[corner];
    if (!offset) return 1;

    let minShade = getConfigCached(blockId)?.Gamma ?? 1;
    for (const h of getBlockHeights(blockId)) {
        const [dx, dz] = offset;
        const id1 = getVoxelAtWorld(wx + dx, wy + h, wz);
        const id2 = getVoxelAtWorld(wx, wy + h, wz + dz);
        const cfg1 = id1 && id1 !== BLOCK_TYPES.SKY ? getConfigCached(id1) : null;
        const cfg2 = id2 && id2 !== BLOCK_TYPES.SKY ? getConfigCached(id2) : null;
        let shade = isInSubterraneanArea(wx, wy, wz) ? 0.4 :
            (cfg1 && !cfg1.transparent && cfg2 && !cfg2.transparent ? 0.4 :
                (cfg1 && !cfg1.transparent || cfg2 && !cfg2.transparent ? 0.7 : 1));
        if (shade < minShade) minShade = shade;
    }

    topShadowCache.set(key, minShade);
    return minShade;
};

// ---------------------------------------
// CHUNK MESH GENERATION (軽量化版)
// ---------------------------------------

// 【追加】ファイル上部のどこかに配置
const customFadeMaterialCache = new Map();

function getOrCreateCustomFadeMaterial(baseMat, isCross, isWater, isTransparent) {
    const mapUuid = baseMat?.map ? baseMat.map.uuid : 'no_map';

    // ✅ 改善1: booleanをビットフラグ(数値)に集約
    // 0b000 〜 0b111 (0〜7) の数値に変換され、文字列結合のメモリ消費を完全にゼロに。
    const flags = (isCross ? 1 : 0) | (isWater ? 2 : 0) | (isTransparent ? 4 : 0);

    // ✅ 改善2: 二階層のMapにすることでキーを高速判定
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
        opacity: 0,
        vertexColors: true,
        side: (isCross || isWater) ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: !(isCross || isTransparent || isWater),
        alphaTest: isCross ? 0.5 : 0
    });

    subMap.set(flags, mat);
    return mat;
}

function generateChunkMeshMultiTexture(cx, cz, useInstancing = false) {
    const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
    const idx = (x, y, z) => ChunkSaveManager.getBlockIndex(x, y, z);

    const container = new THREE.Object3D();
    const tmpMat = new THREE.Matrix4();

    clearCaches();

    // =======================================================
    // ✅ 1. ChunkSaveManager から直接生配列を取得 ＆ 洞窟の彫刻
    // =======================================================
    const chunkKey = encodeChunkKey(cx, cz);

    let voxelData = ChunkSaveManager.modifiedChunks.get(chunkKey);
    let isNewChunk = false;

    if (!voxelData) {
        // まだデータがない（新チャンク）なら、ベースの山（地形）を生成
        voxelData = ChunkSaveManager.captureBaseChunkData(cx, cz);
        isNewChunk = true;

        // 💡 ここで新設した洞窟彫刻関数を呼び出し、配列(voxelData)をくり抜く！
        carveCavesInChunkData(cx, cz, voxelData);
    }

    if (isNewChunk) {
        // くり抜いた後の完成データを modifiedChunks に保存する（以降、破壊・設置のベースになる）
        ChunkSaveManager.modifiedChunks.set(chunkKey, voxelData);
    }

    // =======================================================
    // ✅ 2. ブロックが存在する最高高度を配列の後ろから逆引きして特定
    // =======================================================
    let maxModifiedHeight = 0;
    for (let i = voxelData.length - 1; i >= 0; i--) {
        if (voxelData[i] !== BLOCK_TYPES.SKY) {
            maxModifiedHeight = Math.floor(i / (CHUNK_SIZE * CHUNK_SIZE)) + 1;
            break;
        }
    }

    const activeHeight = CHUNK_HEIGHT;

    const get = (x, y, z) => {
        if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK_TYPES.SKY;

        if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
            return voxelData[idx(x, y, z)];
        }

        const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
        return getVoxelAtWorld(wx, wy, wz, globalTerrainCache, { raw: true });
    };

    const visCache = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);

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

    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let y = 0; y < activeHeight; y++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const type = voxelData[idx(x, y, z)];
                if (type === BLOCK_TYPES.SKY) continue;

                const cfg = getConfigCached(type);
                if (!cfg) continue;

                const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
                const visMask = getVisMask(x, y, z, type, cfg);

                // -------------------------------------------------------
                // 🌿 A. カスタムジオメトリ (苗木、草、階段、半ブロックなど)
                // -------------------------------------------------------
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

                // -------------------------------------------------------
                // 📦 B. 通常立方体 (フルブロック)
                // -------------------------------------------------------
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
        }
    }

    // =======================================================
    // 🧱 通常立方体マージ & 描画反映 (透明化のバグ修正を適用！)
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
            const subGeoms = [...group.values()].map(mergeBufferGeometries);
            const finalGeom = mergeBufferGeometries(subGeoms);
            finalGeom.clearGroups();
            let offset = 0;
            [...group.keys()].forEach((matIdx, i) => {
                finalGeom.addGroup(offset, subGeoms[i].index.count, +matIdx);
                offset += subGeoms[i].index.count;
            });
            finalGeom.computeBoundingSphere();

            const fadeReadyMats = mats.map(m => {
                // ✅ userData の退避領域から、本来の透明度・アルファ設定を復元
                const targetOpacity = m.userData && m.userData.realOpacity !== undefined
                    ? m.userData.realOpacity
                    : 1.0;

                const realTransparent = m.userData && m.userData.realTransparent !== undefined
                    ? m.userData.realTransparent
                    : m.transparent;

                const mat = new THREE.MeshLambertMaterial({
                    map: m.map,
                    transparent: realTransparent,
                    opacity: targetOpacity, // 👈 0固定を廃止し、不透明化を保証
                    vertexColors: m.vertexColors,
                    side: m.side,
                    alphaTest: m.alphaTest
                });

                mat.userData = {
                    realTransparent: realTransparent,
                    realDepthWrite: !realTransparent,
                    realOpacity: targetOpacity
                };
                return mat;
            });

            const mesh = new THREE.Mesh(finalGeom, fadeReadyMats);
            mesh.castShadow = mesh.receiveShadow = true;
            mesh.frustumCulled = true;
            container.add(mesh);
        }
    }

    // =======================================================
    // 🌿 カスタムジオメトリマージ & 描画反映
    // =======================================================
    for (const [type, geoms] of customGeomBatches.entries()) {
        const merged = mergeBufferGeometries(geoms, true);
        merged.computeBoundingSphere();
        const cfg = getConfigCached(type);

        const originalMats = getBlockMaterials(+type) || [];
        const baseMat = originalMats[0];

        const targetOpacity = baseMat?.userData?.realOpacity ?? 1.0;
        const isWater = type === BLOCK_TYPES.WATER || baseMat?.userData?.isWater === true;

        const isGlass = type === BLOCK_TYPES.GLASS || (cfg && cfg.id === 12);
        const isCutout = cfg?.geometryType === "cross" || cfg?.geometryType === "leaves" || isGlass;

        const fadeReadyMat = new THREE.MeshLambertMaterial({
            map: baseMat?.map || null,
            transparent: isWater,
            opacity: isWater ? targetOpacity : 0, // ※ カスタムの方はフェードインが効くので 0 スタートでOK
            vertexColors: true,
            side: (isWater || isCutout) ? THREE.DoubleSide : THREE.FrontSide,
            depthWrite: !isWater,
            alphaTest: isCutout ? 0.5 : 0
        });

        fadeReadyMat.userData = {
            isWater: isWater,
            isGlass: isGlass,
            realTransparent: isWater,
            realDepthWrite: !isWater,
            realOpacity: targetOpacity,
            isAlphaCutout: isCutout
        };

        const mesh = new THREE.Mesh(merged, fadeReadyMat);
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

    // 💡 【修正点1】シビアな「req」による削除をやめ、物理的に遠すぎない限りキューを残す
    chunkQueue = chunkQueue.filter(e => {
        const dx = Math.abs(e.cx - pCx);
        const dz = Math.abs(e.cz - pCz);
        return dx <= CHUNK_VISIBLE_DISTANCE + 2 && dz <= CHUNK_VISIBLE_DISTANCE + 2;
    });

    if (isMoved && chunkQueue.length > 1) {
        const scoredQueue = new Array(chunkQueue.length);
        for (let i = 0; i < chunkQueue.length; i++) {
            const item = chunkQueue[i];
            const dist = (item.cx - pCx) ** 2 + (item.cz - pCz) ** 2;
            scoredQueue[i] = { item, dist };
        }

        scoredQueue.sort((a, b) => a.dist - b.dist);

        for (let i = 0; i < scoredQueue.length; i++) {
            chunkQueue[i] = scoredQueue[i].item;
        }
    }

    for (const [hashKey, mesh] of loadedChunks.entries()) {
        const [cx, cz] = decodeChunkKey(hashKey);

        const dx = cx - pCx;
        const dz = cz - pCz;

        // 💡 【修正点2】アンロードにも「+1」のバッファ（ゆとり）を設けてチラつき・歯抜けを防止
        if (Math.abs(dx) > CHUNK_VISIBLE_DISTANCE + 1 || Math.abs(dz) > CHUNK_VISIBLE_DISTANCE + 1) {
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

// 3Dプレビュー作成（レンダラーは共有、戻り値は描画結果をコピーした2D canvas）
const create3DPreview = async ({ id, previewOptions = {}, geometryType }, size) => {
    const hashKey = getPreviewHash(id, size, 1); // 1 = 3D

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

    // 不要な子要素の処分
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

/* ======================================================
   【超軽量・ボクセル視線判定（DDAアルゴリズム ＋ 精密メッシュ判定）】
   ====================================================== */
function getTargetBlockByDDA(maxDistance) {
    const pos = camera.position;
    const dir = allocVec();
    camera.getWorldDirection(dir);

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

    let hitNormal = allocVec();
    let distance = 0;
    let found = false;

    // 精密レイキャスト用のオブジェクトをプール等から安全に確保
    const tempRaycaster = new THREE.Raycaster(pos, dir, 0.01, maxDistance);
    const intersects = [];

    while (distance < maxDistance) {
        if (tMaxX < tMaxY) {
            if (tMaxX < tMaxZ) {
                x += stepX;
                distance = tMaxX;
                tMaxX += tDeltaX;
                hitNormal.set(-stepX, 0, 0);
            } else {
                z += stepZ;
                distance = tMaxZ;
                tMaxZ += tDeltaZ;
                hitNormal.set(0, 0, -stepZ);
            }
        } else {
            if (tMaxY < tMaxZ) {
                y += stepY;
                distance = tMaxY;
                tMaxY += tDeltaY;
                hitNormal.set(0, -stepY, 0);
            } else {
                z += stepZ;
                distance = tMaxZ;
                tMaxZ += tDeltaZ;
                hitNormal.set(0, 0, -stepZ);
            }
        }

        if (y >= 0 && y < CHUNK_HEIGHT) {
            const cx = getChunkCoord(x);
            const cz = getChunkCoord(z);

            // 💡 負の座標でも安全に 0 ～ 15 を算出する数学的剰余
            let lx = x % CHUNK_SIZE;
            if (lx < 0) lx += CHUNK_SIZE;
            let lz = z % CHUNK_SIZE;
            if (lz < 0) lz += CHUNK_SIZE;

            const voxel = ChunkSaveManager.getBlock(cx, cz, lx, y, lz)
                ?? getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });

            if (voxel !== BLOCK_TYPES.SKY) {
                const conf = getBlockConfiguration(voxel);
                if (conf?.targetblock !== false) {

                    // 💡 立方体（cube）以外の薄いブロックや階段なら、Three.js の実ポリゴンレイキャストで詳細を精査
                    if (conf.geometryType && conf.geometryType !== "cube") {
                        intersects.length = 0;
                        const chunkKey = encodeChunkKey(cx, cz);
                        const chunkMesh = loadedChunks.get(chunkKey);

                        if (chunkMesh) {
                            tempRaycaster.intersectObject(chunkMesh, true, intersects);
                        }

                        // ヒットしたポリゴンの三次元座標が、今調べているグリッド（x, y, z）の内部にあるかをチェック
                        const hasHitInGrid = intersects.some(hit => {
                            const hx = Math.floor(hit.point.x - (hit.face ? hit.face.normal.x : 0) * 1e-5);
                            const hy = Math.floor(hit.point.y - (hit.face ? hit.face.normal.y : 0) * 1e-5);
                            const hz = Math.floor(hit.point.z - (hit.face ? hit.face.normal.z : 0) * 1e-5);
                            return hx === x && hy === y && hz === z;
                        });

                        if (hasHitInGrid) {
                            found = true;
                            break;
                        }
                    } else {
                        found = true;
                        break;
                    }
                }
            }
        }
    }

    freeVec(dir);
    if (found) {
        return { x, y, z, normal: hitNormal, distance };
    } else {
        freeVec(hitNormal);
        return null;
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
/**
 * プレイヤーの AABB（当たり判定）の複数サンプルによる水中判定
 */
const waterSamplePointsPool = Array.from({ length: 9 }, () => new THREE.Vector3());
const _waterCellCache = new Map();

function isPlayerEntireBodyInWater() {
    const { min, max } = getPlayerAABB();

    let idx = 0;
    for (let x of [min.x, max.x]) {
        for (let y of [min.y, max.y]) {
            for (let z of [min.z, max.z]) {
                waterSamplePointsPool[idx++].set(x, y, z);
            }
        }
    }
    waterSamplePointsPool[8].set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);

    let waterCount = 0;
    _waterCellCache.clear();

    for (let i = 0; i < 9; i++) {
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

            // 💡 改善ポイント: 壊れた voxelModifications を呼ばず、チャンク生配列マネージャーから直接取得する
            blockValue = ChunkSaveManager.getBlock(cx, cz, x & 15, y, z & 15)
                ?? getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });

            _waterCellCache.set(numericKey, blockValue);
        }
        if (blockValue === BLOCK_TYPES.WATER) waterCount++;
    }

    return waterCount / 9 >= 0.1;
}
// 関数の外（直上など）に1度だけ定義
const _VEC_UP = new THREE.Vector3(0, 1, 0); // ✅ 上方向の定数

function updateUnderwaterPhysics(delta) {
    const TARGET_SWIM_SPEED = 0.03,
        DASH_MULTIPLIER = 1.0,
        ACCELERATION = 0.1,
        WATER_DRAG = 0.05,
        WATER_GRAVITY = 0.02;

    const effectiveSpeed = dashActive ? TARGET_SWIM_SPEED * DASH_MULTIPLIER : TARGET_SWIM_SPEED;

    const forward = globalTempVec3;
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();

    const right = globalTempVec3b;
    right.crossVectors(forward, _VEC_UP).normalize(); // ✅ newを排除

    const horiz = globalTempVec3c;
    horiz.set(0, 0, 0);

    if (keys["w"] || keys["arrowup"]) horiz.add(forward);
    if (keys["s"] || keys["arrowdown"]) horiz.sub(forward);
    if (keys["d"] || keys["arrowright"]) horiz.add(right);
    if (keys["a"] || keys["arrowleft"]) horiz.sub(right);

    if (horiz.lengthSq() > 0) horiz.normalize().multiplyScalar(effectiveSpeed);

    let vTarget = player.velocity.y;
    if (keys[" "]) {
        vTarget = effectiveSpeed;
    } else if (keys["shift"]) {
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
const _camOffset = new THREE.Vector3();

function animate() {
    requestAnimationFrame(animate);

    let delta = clock.getDelta();
    if (delta > 0.1) delta = 0.1;
    const now = performance.now();
    frameCount++;

    // -------- HUD更新（1秒ごと） --------
    // -------- HUD更新（1秒ごと） --------
    if (now - lastFpsTime > 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));

        // 💡 修正：設置/破壊のキュー(pendingChunkUpdates) と、地形生成のキュー(chunkQueue) の合計を見る
        const activeUpdates = pendingChunkUpdates.size + chunkQueue.length;

        const pCx = Math.floor(player.position.x / CHUNK_SIZE);
        const pCz = Math.floor(player.position.z / CHUNK_SIZE);

        fpsCounter.innerHTML = `
            <span>Minecraft Alpha v0.0.1a</span><br>
            <span>${fps} fps, ${activeUpdates} chunk updates</span><br>
            <span>C: ${loadedChunks.size} loaded. (Quality: ${CHUNK_VISIBLE_DISTANCE} chunks)</span><br>
            <span>Dimension: Overworld</span><br>
            <span>x: ${player.position.x.toFixed(3)} (C: ${pCx})</span><br>
            <span>y: ${player.position.y.toFixed(5)} (feet)</span><br>
            <span>z: ${player.position.z.toFixed(3)} (C: ${pCz})</span><br>
            <span>Mode: ${flightMode ? "Flight" : wasUnderwater ? "Swimming" : "Walking"} / Dash: ${dashActive ? "ON" : "OFF"} / Sneak: ${sneakActive ? "ON" : "OFF"}</span>
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
    // 自然チャンク更新
    chunkUpdateFrameTimer += delta;
    if (chunkUpdateFrameTimer > 0.016) {

        // 溜まっているブロック設置・破壊の更新だけを安全に1件ずつ処理
        processPendingChunkUpdates(1);

        chunkUpdateFrameTimer = 0;
    }

    // -------- カメラ更新 --------
    const targetCamPos = globalTempVec3;
    _camOffset.set(0, getCurrentPlayerHeight() - (flightMode ? 0.15 : 0), 0); // 既存のインスタンスを使い回す
    targetCamPos.copy(player.position).add(_camOffset);

    // 💡 X, Z（前後左右）は遅延なしでキビキビ追従させる！
    camera.position.x = targetCamPos.x;
    camera.position.z = targetCamPos.z;

    // 💡 Y（上下）だけ、少し速めの Lerp (0.3 = 30%) で追従させて気持ち悪さを無くす
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, targetCamPos.y, 0.5);

    // -------- ブロック情報更新（間引き） -----------
    blockInfoTimer += delta;
    if (blockInfoTimer > 0.05) { // 20fpsに落とす

        // カメラが前回から位置、または角度が変わったか
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