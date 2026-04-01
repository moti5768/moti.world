"use strict";
import * as THREE from './build/three.module.js';

/* ======================================================
   【修正版・高精度ノイズ関数群】
   ====================================================== */

const p = new Uint8Array(512);
let currentSeed = 0;

function applySeed(seedInput) {
    if (typeof seedInput === 'number') {
        // すでに数値（セーブデータからのロードなど）なら、そのままシードとして使う
        currentSeed = seedInput >>> 0;
    } else {
        // 文字列（新規入力）なら、ハッシュ化して数値に変換する
        let h = 2166136261 >>> 0;
        const str = String(seedInput || Math.random());
        for (let i = 0; i < str.length; i++) {
            h = Math.imul(h ^ str.charCodeAt(i), 16777619);
        }
        currentSeed = h >>> 0;
    }

    // --- 以降（乱数生成とシャッフル）は変更なし ---
    let s = currentSeed;
    const nextRand = () => {
        s |= 0; s = s + 0x6D2B79F5 | 0;
        let t = Math.imul(s ^ s >>> 15, 1 | s);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };

    const base = new Uint8Array(256);
    for (let i = 0; i < 256; i++) base[i] = i;
    for (let i = 255; i > 0; i--) {
        const j = (nextRand() * (i + 1)) | 0;
        [base[i], base[j]] = [base[j], base[i]];
    }
    for (let i = 0; i < 256; i++) {
        p[i] = p[i + 256] = base[i];
    }

    return currentSeed;
}

/* --- パーリンノイズ計算用ヘルパー --- */

const fade = t => t * t * t * (t * (t * (t * 6 - 15) + 10));
const lerp = (a, b, t) => a + t * (b - a);

// 2D勾配：ビット演算を整理して方向の偏りを防ぐ
const grad2D = (hash, x, y) => {
    const v = (hash & 1) === 0 ? x : y;
    const u = (hash & 2) === 0 ? y : x;
    return (((hash & 4) === 0 ? -v : v) + ((hash & 8) === 0 ? -2.0 * u : 2.0 * u));
};

const perlinNoise2D = (x, y) => {
    // 負の数でも正しく動作する座標取得
    let X = Math.floor(x) & 255;
    let Y = Math.floor(y) & 255;

    let xf = x - Math.floor(x);
    let yf = y - Math.floor(y);

    const u = fade(xf);
    const v = fade(yf);

    // ハッシュの参照を安定させる
    const aa = p[p[X] + Y];
    const ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y];
    const bb = p[p[X + 1] + Y + 1];

    return lerp(
        lerp(grad2D(aa, xf, yf), grad2D(ba, xf - 1, yf), u),
        lerp(grad2D(ab, xf, yf - 1), grad2D(bb, xf - 1, yf - 1), u),
        v
    );
};

/**
 * 複数のオクターブを重ねるフラクタルパーリンノイズ
 */
function fractalNoise2D(x, z, octaves = 4, persistence = 0.5) {
    let total = 0;
    let amplitude = 1;
    let freq = 1;
    let maxValue = 0;

    for (let i = 0; i < octaves; i = (i + 1) | 0) {
        total += perlinNoise2D(x * freq, z * freq) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        freq *= 2;
    }

    return maxValue === 0 ? 0 : total / maxValue;
}

/* ======================================================
   【定数・グローバル変数】
   ====================================================== */
let cloudTiles = new Map(); // 雲システム用
let globalBrightnessMultiplier = 1.0;　//世界全体の明るさ　デフォルトで50%

/* ======================================================
   【新・昼夜サイクルシステム】
   ====================================================== */
let gameTime = 0;                  // 0 ～ 24000 tick
const TICKS_PER_DAY = 24000;
const TIME_SPEED = 1.0;            // Tick速度倍率 (1.0 = 20分で1日)

// 24000tick の時間帯における「太陽の明るさ(0.0 ～ 1.0)」の早見表
function getSkyLightFactor(time) {
    if (time >= 0 && time < 12000) {
        return 1.0; // 昼 (10分間)
    } else if (time >= 12000 && time < 13000) {
        const t = (time - 12000) / 1000;
        return THREE.MathUtils.lerp(1.0, 0.1, t); // 夕焼け (1.5分)
    } else if (time >= 13000 && time < 23000) {
        return 0.1; // 夜 (7分間、月明かり程度の 10%)
    } else {
        const t = (time - 23000) / 1000;
        return THREE.MathUtils.lerp(0.1, 1.0, t); // 朝焼け (1.5分)
    }
}

/* ======================================================
   【改善後】Minecraft完全準拠：空とフォグの色更新
   ====================================================== */
function updateSkyAndFogColor(time) {
    let r, g, b;

    // Minecraftのカラー定義（RGB）
    const day = { r: 120, g: 167, b: 255 };    // #78A7FF (鮮やかな昼)
    const sunset = { r: 255, g: 141, b: 93 }; // #FF8D5D (夕焼けオレンジ)
    const night = { r: 12, g: 12, b: 20 };     // #0C0C14 (深い夜)

    if (time >= 0 && time < 12000) {
        // --- 昼 ---
        ({ r, g, b } = day);

    } else if (time >= 12000 && time < 13500) {
        // --- 夕方 (1.5時間分でじわじわ変化) ---
        const t = (time - 12000) / 1500;
        r = THREE.MathUtils.lerp(day.r, sunset.r, t);
        g = THREE.MathUtils.lerp(day.g, sunset.g, t);
        b = THREE.MathUtils.lerp(day.b, sunset.b, t);

    } else if (time >= 13500 && time < 15000) {
        // --- 日没から夜へ ---
        const t = (time - 13500) / 1500;
        r = THREE.MathUtils.lerp(sunset.r, night.r, t);
        g = THREE.MathUtils.lerp(sunset.g, night.g, t);
        b = THREE.MathUtils.lerp(sunset.b, night.b, t);

    } else if (time >= 15000 && time < 22500) {
        // --- 夜 ---
        ({ r, g, b } = night);

    } else {
        // --- 夜明け (22500〜24000) ---
        const t = (time - 22500) / 1500;
        r = THREE.MathUtils.lerp(night.r, day.r, t);
        g = THREE.MathUtils.lerp(night.g, day.g, t);
        b = THREE.MathUtils.lerp(night.b, day.b, t);
    }

    // 整数化してHEXカラーに変換
    const hexColor = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

    // レンダラーの背景とフォグに適用
    renderer.setClearColor(hexColor);
    if (scene.fog) {
        scene.fog.color.setHex(hexColor);
    }
}
/* ======================================================
   【新・チャンク保存管理システム (クラスなし版)】
   ====================================================== */
const ChunkSaveManager = {
    modifiedChunks: new Map(),

    // インデックス計算（>>> 0 で符号なし32bit整数を保証）
    getBlockIndex: function (lx, ly, lz) {
        return ((ly | 0) + ((lz | 0) << 8) + ((lx | 0) << 12)) >>> 0;
    },

    // setBlock / getBlock は変更なし（完成度が高いため）
    setBlock: function (cx, cz, lx, ly, lz, blockType) {
        if (ly < 0 || ly >= CHUNK_HEIGHT) return;
        const key = encodeChunkKey(cx, cz);
        let dataArray = this.modifiedChunks.get(key);
        if (!dataArray) {
            dataArray = this.captureBaseChunkData(cx, cz);
            dataArray[this.getBlockIndex(lx, ly, lz)] = blockType;
            this.modifiedChunks.set(key, dataArray);
        } else {
            dataArray[this.getBlockIndex(lx, ly, lz)] = blockType;
        }
    },

    getBlock: function (cx, cz, lx, ly, lz) {
        if (ly < 0 || ly >= CHUNK_HEIGHT) return null;
        const key = encodeChunkKey(cx, cz);
        const dataArray = this.modifiedChunks.get(key);
        return dataArray ? dataArray[this.getBlockIndex(lx, ly, lz)] : null;
    },

    /**
     * 地形生成のコアロジック（最適化版）
     */
    captureBaseChunkData: function (cx, cz) {
        const data = new Uint8Array(65536); // デフォルト 0 (SKY)
        const baseX = (cx << 4) | 0;
        const baseZ = (cz << 4) | 0;
        const SEA_LEVEL_VAL = SEA_LEVEL | 0;
        const LAVA_LEVEL = 11;

        for (let x = 0; x < 16; x++) {
            const xOff = (x << 12) | 0;
            const worldX = (baseX + x) | 0;
            for (let z = 0; z < 16; z++) {
                const zOff = (z << 8) | 0;
                const worldZ = (baseZ + z) | 0;
                const columnIdx = (xOff + zOff) | 0; // 加算に変更

                // 1. 先に高さを取得
                const sHeight = getTerrainHeight(worldX, worldZ) | 0;

                // 2. 引数に sHeight を渡して洞窟情報を取得（再計算を防止）
                const [caveY, radius] = getCaveTubeInfo(worldX, worldZ, sHeight);

                // 3. 洞窟の有効な高さ範囲を事前に算出（重要！）
                const caveMinY = radius > 0 ? (caveY - radius) | 0 : -1;
                const caveMaxY = radius > 0 ? (caveY + radius) | 0 : -1;
                const caveRadiusSq = radius * radius;

                // 岩盤
                data[columnIdx] = BLOCK_TYPES.BEDROCK;

                // 地層生成（ループを分割して if 判定を減らす）
                const dirtLayerStart = (sHeight - 4) | 0;

                for (let y = 1; y < sHeight; y++) {
                    const idx = (columnIdx + y) | 0;

                    // 💡 洞窟判定（範囲外なら dy の計算すらしない）
                    if (y >= caveMinY && y <= caveMaxY) {
                        const dy = y - caveY;
                        if ((dy * dy) < caveRadiusSq) {
                            data[idx] = (y <= LAVA_LEVEL) ? BLOCK_TYPES.LAVA : BLOCK_TYPES.SKY;
                            continue;
                        }
                    }

                    // 💡 地層の塗り分け
                    if (y < dirtLayerStart) {
                        data[idx] = BLOCK_TYPES.STONE;
                    } else if (y === sHeight - 1) {
                        data[idx] = (y < SEA_LEVEL_VAL) ? BLOCK_TYPES.DIRT : BLOCK_TYPES.GRASS;
                    } else {
                        data[idx] = BLOCK_TYPES.DIRT;
                    }
                }

                // 水（y軸が連続しているため、高速に処理可能）
                if (sHeight <= SEA_LEVEL_VAL) {
                    for (let y = sHeight; y <= SEA_LEVEL_VAL; y++) {
                        const idx = (columnIdx + y) | 0;
                        if (y > 0 && data[idx] === BLOCK_TYPES.SKY) {
                            data[idx] = BLOCK_TYPES.WATER;
                        }
                    }
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

const globalRaycaster = new THREE.Raycaster();
globalRaycaster.near = 0.01;

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

let jumpCooldown = 0;
// プレイヤーデータ
const player = {
    position: new THREE.Vector3(spawnX, spawnY, spawnZ),
    velocity: new THREE.Vector3(0, 0, 0),
    onGround: false,
    positionIsCenter: false,
    spawnFixed: false
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
const fogColor = 0x78A7FF;
const scene = new THREE.Scene();
// 💡 32マス先から霧が始まり、128マス（8チャンク程度）先で完全に霧で見えなくする
scene.fog = new THREE.FogExp2(fogColor, 0.008);
setMinecraftSky(scene);

loadCloudTexture(() => {
    updateCloudGrid(scene, camera.position);
});

const camera = new THREE.PerspectiveCamera(
    80,                                 // 視野角
    window.innerWidth / window.innerHeight, // アスペクト比
    0.1,                                // near
    5000                               // far
);
camera.rotation.order = "YXZ";

let renderer;
function initCanvas() {
    // 1. レンダラーの生成（ここで初めて Canvas が作られる）
    renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setClearColor(fogColor);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // 2. HTMLのbodyに Canvas を追加
    document.body.appendChild(renderer.domElement);

    // 3. 各種イベントの紐付け（生成直後に行う）

    // --- A. マウス・クリック系 ---
    renderer.domElement.addEventListener("mousedown", onCanvasMouseDown, false);

    renderer.domElement.addEventListener("click", (e) => {
        if (isInventoryOpen || pointerLocked || (inventoryContainer && inventoryContainer.contains(e.target))) return;
        if (e.target === renderer.domElement && !("ontouchstart" in window)) {
            renderer.domElement.requestPointerLock();
        }
    });

    renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault(), false);

    // --- B. タッチ操作 (スマホ用) ---
    // 先ほど定義した関数 (onCanvasTouchStart など) を紐付けます
    // passive: false にすることでブラウザのデフォルト挙動を抑制できるようにします
    renderer.domElement.addEventListener("touchstart", onCanvasTouchStart, { passive: false });
    renderer.domElement.addEventListener("touchmove", onCanvasTouchMove, { passive: false });
    renderer.domElement.addEventListener("touchend", onCanvasTouchEnd, { passive: false });

    // --- C. ズーム・ピンチ防止 ---
    // ゲーム画面(Canvas)上での Ctrl+ホイール によるズームを防止
    renderer.domElement.addEventListener('wheel', e => {
        if (e.ctrlKey) e.preventDefault();
    }, { passive: false });

    // 2本指以上の操作（ピンチズーム）を防止
    renderer.domElement.addEventListener('touchmove', e => {
        if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });
}
let targetCamPos = player.position.clone().add(new THREE.Vector3(0, getCurrentPlayerHeight(), 0));
camera.position.copy(targetCamPos);
// 環境光を抑えめにし、ブロックのライトレベルを際立たせる
scene.add(new THREE.AmbientLight(0xffffff, 0.2));
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

    // --- 根本修正：AABBがカバーする全範囲を正確に計算 ---
    // マージン（0.1など）を含めて、チェックすべきブロックの範囲を特定する
    const minX = Math.floor(aabb.min.x - 0.1);
    const maxX = Math.floor(aabb.max.x + 0.1);
    const minY = Math.floor(aabb.min.y - 0.1);
    const maxY = Math.floor(aabb.max.y + 0.1);
    const minZ = Math.floor(aabb.min.z - 0.1);
    const maxZ = Math.floor(aabb.max.z + 0.1);

    // 💡 固定オフセットではなく、実際の範囲をループする（これが最も確実）
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {

                // ブロックIDの取得
                const id = getVoxelAtWorld(x, y, z, globalTerrainCache, true);

                // 空気、水、または未ロード(null/undefined)はスキップ
                if (!id || id === BLOCK_TYPES.SKY || id === BLOCK_TYPES.WATER) continue;

                // 衝突フラグのキャッシュ確認
                let coll = blockCollisionFlagCache.get(id);
                if (coll === undefined) {
                    getCachedCollisionBoxes(id);
                    coll = blockCollisionFlagCache.get(id) ?? false;
                }
                if (!coll) continue;

                const relBoxes = blockCollisionBoxCache.get(id);
                if (!relBoxes) continue;

                for (let j = 0; j < relBoxes.length; j++) {
                    const rel = relBoxes[j];
                    const wb = getPooledBox();

                    // ワールド座標のAABBを作成
                    wb.min.set(rel.min.x + x, rel.min.y + y, rel.min.z + z);
                    wb.max.set(rel.max.x + x, rel.max.y + y, rel.max.z + z);

                    if (isDynamic) {
                        const r = sweptAABB(aabb, velocity, dt, wb);
                        if (r.collision && r.time < result.time) {
                            result.collision = true;
                            result.time = r.time;
                            result.normal.copy(r.normal);
                        }
                        // 非常に近い場合は即座に衝突として返す（床抜け防止）
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
        }
    }
    return result;
}

/* ======================================================
   【地形生成】（フラクタルノイズ＋ユーザー変更反映・最適化・強化版）
   ====================================================== */
const MAX_SEARCH_DEPTH = 32;
/**
 * 指定座標の地形の高さを取得する。
 */
function getTerrainHeight(worldX, worldZ, startY) {
    const xInt = worldX | 0;
    const zInt = worldZ | 0;

    if (startY !== undefined) {
        let y = startY | 0;
        const lowLimit = Math.max(0, (y - MAX_SEARCH_DEPTH) | 0);
        for (; y >= lowLimit; y--) {
            if (getVoxelAtWorld(xInt, y, zInt) !== 0) return (y + 1) | 0;
        }
        return -Infinity;
    }

    const key = (xInt << 16) ^ zInt;
    const cachedHeight = terrainHeightCache.get(key);
    if (cachedHeight !== undefined) return cachedHeight;

    // 💡 最適化：オクターブを 5 -> 4 に削減
    const noise = fractalNoise2D(xInt * NOISE_SCALE, zInt * NOISE_SCALE, 4, 0.5);

    let heightModifier = noise * 35;
    if (noise > 0.2) {
        const diff = noise - 0.2;
        heightModifier += (diff * diff) * 60;
    }

    const result = (BASE_HEIGHT + heightModifier) | 0;

    if (terrainHeightCache.size >= MAX_CACHE_SIZE) {
        terrainHeightCache.clear();
    }

    terrainHeightCache.set(key, result);
    return result;
}

const globalTerrainCache = new Map();
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

/**
 * 指定した世界座標のボクセルを取得する。
 * 物理判定（衝突）と描画判定の両方で使用される最重要関数。
 */
function getVoxelAtWorld(x, y, z, terrainCache = globalTerrainCache, isRaw = false) {
    // 1. 垂直方向の境界チェック
    const fy = y | 0;
    if (fy < 0 || fy >= CHUNK_HEIGHT) return 0; // SKY

    const fx = x | 0;
    const fz = z | 0;

    // 2. チャンク座標とローカル座標の算出
    const cx = fx >> 4;
    const cz = fz >> 4;
    const lx = fx & 15;
    const lz = fz & 15;

    // 3. 保存された変更データのチェック (Map検索)
    const chunkKey = encodeChunkKey(cx, cz);
    const modifiedData = ChunkSaveManager.modifiedChunks.get(chunkKey);

    if (modifiedData !== undefined) {
        // ChunkSaveManager.getBlockIndex と完全に一致させる: (y) + (z*256) + (x*4096)
        const idx = (fy) + (lz << 8) + (lx << 12);
        const modValue = modifiedData[idx];

        if (modValue !== undefined) {
            if (isRaw) return modValue; // 描画用ならそのまま（花や草も返す）

            // 物理判定用：当たり判定設定があるものだけ返す
            const cfg = _blockConfigFastArray[modValue];
            return (cfg && cfg.collision !== false) ? modValue : 0;
        }
    }

    // 4. 自然地形の判定（保存データがない場合）
    if (fy === 0) return BLOCK_TYPES.BEDROCK;

    const surfaceHeight = getTerrainHeight(fx, fz) | 0;

    // A. 地表より上の場合（空か水）
    if (fy >= surfaceHeight) {
        return (fy <= SEA_LEVEL) ? BLOCK_TYPES.WATER : 0; // SKY
    }

    // B. 地中の場合（洞窟判定を入れる）
    // 💡 ここが重要：描画システム（captureBaseChunkData）と同じルールで洞窟を彫る
    const [caveY, radius] = getCaveTubeInfo(fx, fz);
    if (radius > 0 && fy > 3) {
        const dy = fy - caveY;
        if ((dy * dy) < (radius * radius)) {
            // 溶岩層（y=11以下）なら溶岩、それ以外は空気(0)
            return (fy <= 11) ? BLOCK_TYPES.LAVA : 0;
        }
    }

    // C. 洞窟でなければ、通常の地層を返す
    // 既存の determineNaturalBlockLayer を呼ぶか、ここで直接判定
    if (fy === surfaceHeight - 1) {
        return (fy < SEA_LEVEL) ? BLOCK_TYPES.DIRT : BLOCK_TYPES.GRASS;
    }
    if (fy >= surfaceHeight - 4) return BLOCK_TYPES.DIRT;
    return BLOCK_TYPES.STONE;
}

// 💡 整理：地表より下のブロック種別を決めるロジックを外出し
function determineNaturalBlockLayer(y, surfaceHeight, fx, fz) {
    // 洞窟計算の間引き判定
    if (y > 3 && y < surfaceHeight - 3) {
        const caveInfo = getCaveTubeInfo(fx, fz);
        const caveRadius = caveInfo[1];

        if (caveRadius > 0) {
            const dy = y - caveInfo[0];
            if ((dy * dy) < caveRadius * caveRadius) {
                return SKY;
            }
        }
    }

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

function getCaveTubeInfo(worldX, worldZ, surfaceHeight) {
    const x = Math.abs(worldX);
    const z = Math.abs(worldZ);

    // 💡 1. 1つ目のノイズ（洞窟は詳細度不要のためオクターブ1で十分）
    const n1 = perlinNoise2D(x * CAVE_SCALE_XZ, z * CAVE_SCALE_XZ);

    // 💡 【新規最適化】早期リターン
    // diff < 0.07 になるには n1 がこの範囲内にいないと n2 での逆転がほぼ不可能
    if (n1 < 0.02 || n1 > 0.98) {
        _SHARED_CAVE_INFO[0] = 0;
        _SHARED_CAVE_INFO[1] = 0;
        return _SHARED_CAVE_INFO;
    }

    // 💡 2. 2つ目のノイズ
    const n2 = perlinNoise2D((x + 2000) * CAVE_SCALE_XZ, (z + 2000) * CAVE_SCALE_XZ);

    const diff = Math.abs(n1 - n2);
    const threshold = 0.07;
    let radius = 0;

    if (diff < threshold) {
        const thicknessFactor = (threshold - diff) / threshold;
        radius = 2.5 + thicknessFactor * 1.5;

        // 💡 部屋のノイズ
        const roomNoise = perlinNoise2D(x * 0.03, z * 0.03);
        if (roomNoise > 0.45) {
            radius += (roomNoise - 0.45) * 10;
        }
    }

    if (radius === 0) {
        _SHARED_CAVE_INFO[0] = 0;
        _SHARED_CAVE_INFO[1] = 0;
        return _SHARED_CAVE_INFO;
    }

    // 💡 4. 半径がある場合のみ計算
    const baseNoise = perlinNoise2D(x * 0.006, z * 0.006);
    const baseY = 15 + baseNoise * 25;

    const wave = Math.sin(worldX * 0.015) * Math.cos(worldZ * 0.015);
    let finalY = baseY;

    if (wave > 0) {
        // 💡 修正：引数があればそれを使う（Map検索と再計算を回避）
        const sHeight = (surfaceHeight !== undefined) ? surfaceHeight : getTerrainHeight(worldX, worldZ);

        // Math.pow(wave, 1.5) を wave * Math.sqrt(wave) で代用（高速）
        const t = wave * Math.sqrt(wave);
        const targetY = sHeight - 2;
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
    const texturePath = config?.screenFill && (config.textures.top || config.textures.all || config.textures.side);

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

    // 💡 16方向はやりすぎ（処理落ちの原因）なので、前後左右＋上下の6方向に限定して負荷を1/3にカット
    const directions = [
        new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
        new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)
    ];

    let bestDir = null;
    let bestDist = Infinity;
    const tempVec = new THREE.Vector3();

    for (const dir of directions) {
        let low = 0, high = 1.0;
        let foundDist = null;

        for (let i = 0; i < 10; i++) {
            const mid = (low + high) / 2;
            tempVec.copy(player.position).addScaledVector(dir, mid);

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
    if (!config || config.collision === false) return 0.0;

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
// 再利用ベクトルをグローバルに1回だけ作成
const _vForward = new THREE.Vector3();
const _vRight = new THREE.Vector3();
const _vDesired = new THREE.Vector3();
const _vUp = new THREE.Vector3(0, 1, 0);

function getDesiredHorizontalVelocity(multiplier = 1) {
    camera.getWorldDirection(_vForward);
    _vForward.y = 0;
    _vForward.normalize();

    _vRight.crossVectors(_vForward, _vUp).normalize();

    _vDesired.set(0, 0, 0);
    if (keys["w"] || keys["arrowup"]) _vDesired.add(_vForward);
    if (keys["s"] || keys["arrowdown"]) _vDesired.addScaledVector(_vForward, -1);
    if (keys["a"] || keys["arrowleft"]) _vDesired.addScaledVector(_vRight, -1);
    if (keys["d"] || keys["arrowright"]) _vDesired.add(_vRight);

    if (_vDesired.lengthSq() > 0) {
        // 💡 lengthSq()の判定は残しつつ、無駄な再計算を避けてスマートに
        _vDesired.normalize().multiplyScalar(multiplier);
    }
    // else で .set(0,0,0) を呼ぶ必要はありません（すでに set(0,0,0) から始まっているため）

    return _vDesired; // 常に同じ参照を使い回す
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
    // 修正：飛行モード(flightMode)かつ非ダッシュ時のベース速度を上げる
    let baseSpeed = playerSpeed(); // デフォルト 0.08
    if (flightMode && !dashActive) {
        baseSpeed = 0.15; // 飛行時の巡航速度（お好みの数値に調整してください）
    }

    const speed = dashActive ? flightDashMultiplier : baseSpeed;

    // 加速度も少し上げるとキビキビ動きます（任意）
    const accel = flightMode ? 0.05 : 0.5;

    const desiredVel = getDesiredHorizontalVelocity(speed);
    _tmpDesiredVel.copy(desiredVel);

    player.velocity.x += (_tmpDesiredVel.x - player.velocity.x) * accel;
    player.velocity.z += (_tmpDesiredVel.z - player.velocity.z) * accel

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
    col.maxModifiedY = col.maxModifiedY > modY ? col.maxModifiedY : modY; // Math.max 呼び出しコストを排除
}

// 🪚 改善①: traverseを使わず再帰呼び出しと一時配列生成を排除
function disposeMesh(mesh) {
    if (!mesh) return;

    const children = mesh.children;
    for (let i = children.length - 1; i >= 0; i--) {
        const obj = children[i];

        // Mesh, Line, Points など、ジオメトリを持つものを対象にする
        if (obj.geometry) {
            obj.geometry.dispose();
        }

        // マテリアルの処理
        if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (let j = 0; j < mats.length; j++) {
                // 【重要】共有マテリアルを誤って消さないためのチェック
                // チャンク専用のマテリアルである確証がある場合のみ dispose する
                if (mats[j] && typeof mats[j].dispose === 'function') {
                    mats[j].dispose();
                }
            }
        }

        // 🪚 改善ポイント: シーンから完全に取り除く
        // これをしないと、空の Object3D がメモリ上に残り続けます
        mesh.remove(obj);
    }
}

function refreshChunkAt(cx, cz) {
    const key = encodeChunkKey(cx, cz);
    const oldChunk = loadedChunks.get(key);

    // ------------------------------------------------------------
    // 💡【根本修正2】更新時も距離チェック
    // 遠ざかったチャンクの更新依頼が来た場合、再生成せず消去のみ行う
    // ------------------------------------------------------------
    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);
    const dx = Math.abs(cx - pCx);
    const dz = Math.abs(cz - pCz);

    if (dx > CHUNK_VISIBLE_DISTANCE || dz > CHUNK_VISIBLE_DISTANCE) {
        if (oldChunk) {
            scene.remove(oldChunk);
            disposeMesh(oldChunk); // メモリ解放
            loadedChunks.delete(key);
        }
        return;
    }

    // 1. 新しいメッシュを生成
    const newChunk = generateChunkMeshMultiTexture(cx, cz);
    if (!newChunk) return;

    newChunk.userData.fadedIn = true;
    syncSingleChunkSkyLight(newChunk);

    // マテリアル設定の復元
    newChunk.traverse(child => {
        if (child.isMesh && child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(m => {
                const ud = m.userData;
                if (ud) {
                    if (ud.realTransparent !== undefined) m.transparent = ud.realTransparent;
                    if (ud.realDepthWrite !== undefined) m.depthWrite = ud.realDepthWrite;
                    if (ud.realOpacity !== undefined) m.opacity = ud.realOpacity;
                }
            });
        }
    });

    // 2. シーン入れ替え
    scene.add(newChunk);
    loadedChunks.set(key, newChunk);

    // 3. 古いチャンクを完全に破棄
    if (oldChunk) {
        scene.remove(oldChunk);
        disposeMesh(oldChunk); // 💡 disposeMesh関数を呼んでGPUメモリを解放
    }

    clearCaches();
}

const BIGINT_OFFSET = 2_000_000n;

function encodeChunkKey(cx, cz) {
    return (BigInt(cx) + BIGINT_OFFSET) << 32n | ((BigInt(cz) + BIGINT_OFFSET) & 0xffffffffn);
}

const _sharedChunkCoord = { cx: 0, cz: 0 };

function decodeChunkKey(key, out = _sharedChunkCoord) {
    out.cx = Number((key >> 32n) - BIGINT_OFFSET);
    out.cz = Number((key & 0xffffffffn) - BIGINT_OFFSET);
    return out;
}

// ───────────────────────────────
// 更新要求用のバッチセットと処理
// ───────────────────────────────

// pendingChunkUpdates は BigInt 値を保持する Set
let pendingChunkUpdates = new Set();
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
let processStartTime = 0;

function processChunkQueue(deadline) {
    let tasksProcessed = 0;
    const MAX_CHUNKS_PER_FRAME = 1; // 1フレームに生成を許す最大チャンク数
    const FRAME_TIME_BUDGET = 10;   // 1フレームに許容する最大ミリ秒 (10ms)

    let chunkInfo, cx, cz, key, mesh;

    processStartTime = performance.now();

    // 💡 判定用に現在のプレイヤーのチャンク座標を取得
    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);

    while (
        chunkQueue.length > 0 &&
        tasksProcessed < MAX_CHUNKS_PER_FRAME &&
        (performance.now() - processStartTime) < FRAME_TIME_BUDGET
    ) {
        // 💡 pop() で末尾から高速に取得
        chunkInfo = chunkQueue.pop();

        if (chunkInfo) {
            cx = chunkInfo.cx;
            cz = chunkInfo.cz;
            key = encodeChunkKey(cx, cz);

            // ------------------------------------------------------------
            // 💡【根本修正1】リアルタイム距離チェック
            // キューに積まれている間にプレイヤーが移動した場合、ここで弾く
            // ------------------------------------------------------------
            const dx = Math.abs(cx - pCx);
            const dz = Math.abs(cz - pCz);
            if (dx > CHUNK_VISIBLE_DISTANCE || dz > CHUNK_VISIBLE_DISTANCE) {
                continue; // 描画距離外ならこのチャンクの生成は無視して次へ
            }

            // まだ読み込まれていない場合のみ生成
            if (!loadedChunks.has(key)) {
                mesh = generateChunkMeshMultiTexture(cx, cz);
                if (!mesh) continue;

                syncSingleChunkSkyLight(mesh);

                if (typeof CHUNK_VISIBLE_DISTANCE !== "undefined" && CHUNK_VISIBLE_DISTANCE === 0) {
                    mesh.userData.fadedIn = true;
                } else {
                    mesh.userData.fadedIn = false;
                    setOpacityRecursive(mesh, 0);
                }

                scene.add(mesh);
                loadedChunks.set(key, mesh);

                // 隣接チャンクの更新予約
                const neighborOffsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];
                for (let i = 0; i < neighborOffsets.length; i++) {
                    const nx = cx + neighborOffsets[i][0];
                    const nz = cz + neighborOffsets[i][1];
                    const nKey = encodeChunkKey(nx, nz);
                    if (loadedChunks.has(nKey)) {
                        if (typeof pendingChunkUpdates !== "undefined") {
                            pendingChunkUpdates.add(nKey);
                        }
                    }
                }

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
        tasksProcessed++;
    }

    if (chunkQueue.length > 0) {
        if (!chunkQueueScheduled) {
            chunkQueueScheduled = true;
            if (window.requestIdleCallback) {
                window.requestIdleCallback(() => {
                    chunkQueueScheduled = false;
                    processChunkQueue();
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

// 💡 シェーダー変数の参照を一括管理して、毎フレームの重いメッシュ走査をゼロにする
const globalSkyUniforms = new Set();

// ✅ 新規追加：特定のメッシュ(チャンク)に、現在の昼夜の明るさを即座に同期させる関数
function syncSingleChunkSkyLight(mesh) {
    if (!mesh) return;

    const currentSkyFactor = getSkyLightFactor(gameTime);

    mesh.traverse(child => {
        if (!child.isMesh || !child.material) return;

        const mats = Array.isArray(child.material) ? child.material : [child.material];

        for (let i = 0; i < mats.length; i++) {
            const m = mats[i];
            if (!m) continue;

            const uniforms = m.shaderUniforms || (m.userData && m.userData.shaderUniforms);

            if (uniforms && uniforms.u_skyFactor) {
                uniforms.u_skyFactor.value = currentSkyFactor;
                // 💡 ここでUniformオブジェクトの参照を記録しておく
                globalSkyUniforms.add(uniforms.u_skyFactor);
            }
        }
    });
}
/* ======================================================
   【修正版】ライトの再計算 ＋ チャンクメッシュ構築
   ====================================================== */
function processPendingChunkUpdates() {
    if (pendingChunkUpdates.size === 0) return;

    const startTime = performance.now();
    const FRAME_BUDGET = 4.0; // 予算 4.0ms

    // 💡 values().next() を使い、Set の先頭から1つずつ確実に「取り出して」処理する
    while (pendingChunkUpdates.size > 0) {
        // 先頭のキーを取得
        const key = pendingChunkUpdates.values().next().value;

        // 💡 取得したら【真っ先に】削除。これで break してもデータがロスト・重複しない
        pendingChunkUpdates.delete(key);

        const coord = decodeChunkKey(key);
        const voxelData = ChunkSaveManager.modifiedChunks.get(key);

        if (voxelData) {
            generateChunkLightMap(key, voxelData);
        }

        if (typeof refreshChunkAt === "function") {
            refreshChunkAt(coord.cx, coord.cz);
        } else if (typeof requestChunkUpdate === "function") {
            requestChunkUpdate(coord.cx, coord.cz);
        }

        // 時間チェック
        const elapsed = performance.now() - startTime;
        if (elapsed > FRAME_BUDGET) {
            break; // 安全に次のフレームへ処理を回せます
        }
    }

    // 🔄 残りがあれば次フレームへ
    if (pendingChunkUpdates.size > 0) {
        if (typeof scheduleChunkUpdate === "function") {
            scheduleChunkUpdate();
        } else {
            requestAnimationFrame(processPendingChunkUpdates);
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

// ==========================================
// 1. キャッシュ管理
// ==========================================
const blockConfigCache = new Map();

const clearCaches = () => {
    blockConfigCache.clear();
};

const getConfigCached = id => {
    // 1. まずMapからデータを取得する
    let config = blockConfigCache.get(id);

    // 2. なければ重い getBlockConfiguration(id) を1回だけ呼んで保存
    if (config === undefined) {
        config = getBlockConfiguration(id);
        blockConfigCache.set(id, config);
    }

    return config;
};

/* ======================================================
   【新・15段階 マイクラ準拠 ライティングエンジン (SkyLight)】
   ====================================================== */
const LIGHT_LEVEL_FACTORS = new Float32Array(16);
const brightness = 0.5; // マイクラの設定「明るさ: 50%」に相当。0.0(暗い)〜1.0(明るい)で調整可能

for (let i = 0; i <= 15; i++) {
    // 1. マイクラの基本減衰カーブ (指数関数)
    const f = Math.pow(0.8, 15 - i);

    // 2. マイクラ特有の非線形補正（低いレベルを底上げし、高いレベルを維持する）
    // 計算式: f / (f * (1 - brightness) + brightness)
    const level = f / (f * (1.0 - brightness) + brightness);

    // 最低輝度を 0.03 程度に設定（完全な漆黒を防ぐ）
    LIGHT_LEVEL_FACTORS[i] = Math.max(0.03, level);
}

const chunkLightCache = new Map();
const neighborUnlightRequests = [];
const neighborLightRequests = [];

/* ======================================================
   【超限界軽量化】スリム・スカイライト伝播エンジン
   ====================================================== */

const CS = CHUNK_SIZE;
const CH = CHUNK_HEIGHT;
const CS_CH = CS * CH; // 4096
const TOTAL_CELLS = CS * CH * CS; // 65536

const _localLightCoord = { cx: 0, cz: 0 };

// 1次元配列上のオフセット [+X, -X, +Y, -Y, +Z, -Z]
const MOVE_OFFSETS = new Int32Array([CS_CH, -CS_CH, 1, -1, CH, -CH]);

// 🔥 【超限界軽量化】関数の外側でキュー配列を一度だけ確保。
// 毎フレームの new Int32Array によるGC（カクつき）を完全にゼロにします。
const _sharedQueue = new Int32Array(TOTAL_CELLS);
const _sharedUnlightQueue = new Int32Array(TOTAL_CELLS * 2);
/* ======================================================
   【新・2系統ライトマップ用のビット演算ユーティリティ】
   ====================================================== */
const _getSkyLight = (val) => (val >> 4) & 0x0F; // 上位4ビット（天空光）を取得
const _getBlockLight = (val) => val & 0x0F;      // 下位4ビット（ブロック光）を取得
const _packLight = (sky, block) => (sky << 4) | (block & 0x0F); // 1バイトに合体
function generateChunkLightMap(chunkKey, voxelData) {
    if (!voxelData || voxelData.length < TOTAL_CELLS) {
        console.warn("generateChunkLightMap: voxelData is invalid or too small.");
        return null;
    }

    // 1. メモリ確保の最適化
    let lightData = chunkLightCache.get(chunkKey);
    if (!lightData) {
        lightData = new Uint8Array(TOTAL_CELLS);
    } else {
        lightData.fill(0); // 💡 メモリを再利用。GC(カクつき)を防止
    }

    const queue = _sharedQueue;
    let head = 0, tail = 0;

    // 座標のデコード
    decodeChunkKey(chunkKey, _localLightCoord);
    const cx = _localLightCoord.cx | 0;
    const cz = _localLightCoord.cz | 0;

    // 2. 近隣データの事前キャッシュ（ループ内の Map.get を排除）
    const nMaps = new Array(6);
    const nVoxels = new Array(6);
    const nKeys = new Array(6);
    const dxs = [1, -1, 0, 0, 0, 0];
    const dzs = [0, 0, 0, 0, 1, -1];

    for (let i = 0; i < 6; i++) {
        if (i === 2 || i === 3) continue; // Y軸方向はチャンクを跨がない
        const nk = encodeChunkKey((cx + dxs[i]) | 0, (cz + dzs[i]) | 0);
        nKeys[i] = nk;
        nMaps[i] = chunkLightCache.get(nk);
        nVoxels[i] = ChunkSaveManager.modifiedChunks.get(nk);
    }

    // ======================================================
    // 🌞 PHASE 1: 天空光 (SkyLight)
    // ======================================================

    // 1-A: 直射日光の垂直降下計算
    for (let x = 0; x < 16; x = (x + 1) | 0) {
        const xBase = (x << 12) | 0;
        for (let z = 0; z < 16; z = (z + 1) | 0) {
            const xzBase = (xBase | (z << 8)) | 0;
            let currentSky = 15;

            for (let y = 255; y >= 0; y = (y - 1) | 0) {
                const idx = (xzBase | y) | 0;
                const type = voxelData[idx] | 0;

                if (currentSky === 15 && type !== 0) { // BLOCK_TYPES.SKY = 0 と仮定
                    const cfg = _blockConfigFastArray[type];
                    if (cfg && !cfg.transparent) {
                        currentSky = 0;
                    }
                }

                if (currentSky > 0) {
                    lightData[idx] = (currentSky << 4);
                    queue[tail++] = idx;
                }
            }
        }
    }

    // 1-B: 隣接チャンクの境界から流入する光をキューに注入
    for (let i = 0; i < 6; i = (i + 1) | 0) {
        const nm = nMaps[i];
        if (!nm) continue;

        for (let y = 0; y < 256; y = (y + 1) | 0) {
            for (let s = 0; s < 16; s = (s + 1) | 0) {
                let x = 0, z = 0, nLx = 0, nLz = 0;
                if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
                else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
                else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
                else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

                const idx = (y | (z << 8) | (x << 12)) | 0;
                const nIdx = (y | (nLz << 8) | (nLx << 12)) | 0;

                const nSky = (nm[nIdx] >> 4) & 15;
                const mySky = (lightData[idx] >> 4) & 15;

                if (nSky > 1 && (nSky - 1) > mySky) {
                    const type = voxelData[idx] | 0;
                    if (type === 0 || (_blockConfigFastArray[type] && _blockConfigFastArray[type].transparent)) {
                        lightData[idx] = (((nSky - 1) << 4) | (lightData[idx] & 15)) | 0;
                        queue[tail++] = idx;
                    }
                }
            }
        }
    }

    // 1-C: 天空光のBFS伝播 (3D Flood Fill)
    while (head < tail) {
        const idx = queue[head++] | 0;
        const skyLight = (lightData[idx] >> 4) & 15;
        if (skyLight <= 1) continue;

        const nextSky = (skyLight - 1) | 0;
        const y = idx & 255;
        const z = (idx >> 8) & 15;
        const x = idx >> 12;

        for (let i = 0; i < 6; i = (i + 1) | 0) {
            if ((i === 2 && y === 255) || (i === 3 && y === 0)) continue;

            const isBorder = (i === 0 && x === 15) || (i === 1 && x === 0) || (i === 4 && z === 15) || (i === 5 && z === 0);

            if (isBorder) {
                const nm = nMaps[i];
                const nv = nVoxels[i];
                if (nm && nv) {
                    const nx = (i === 0) ? 0 : (i === 1) ? 15 : x;
                    const nz = (i === 4) ? 0 : (i === 5) ? 15 : z;
                    const nIdx = (y | (nz << 8) | (nx << 12)) | 0;

                    if (((nm[nIdx] >> 4) & 15) < nextSky) {
                        const nt = nv[nIdx] | 0;
                        if (nt === 0 || (_blockConfigFastArray[nt] && _blockConfigFastArray[nt].transparent)) {
                            nm[nIdx] = ((nextSky << 4) | (nm[nIdx] & 15)) | 0;
                            pendingChunkUpdates.add(nKeys[i]);
                        }
                    }
                }
                continue;
            }

            const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
            if (((lightData[nIdx] >> 4) & 15) < nextSky) {
                const type = voxelData[nIdx] | 0;
                if (type === 0 || (_blockConfigFastArray[type] && _blockConfigFastArray[type].transparent)) {
                    lightData[nIdx] = ((nextSky << 4) | (lightData[nIdx] & 15)) | 0;
                    queue[tail++] = nIdx;
                }
            }
        }
    }

    // ======================================================
    // 🕯️ PHASE 2: ブロック光 (BlockLight)
    // ======================================================
    head = 0;
    tail = 0;

    // 2-A: 発光ブロック（松明など）の走査
    for (let i = 0; i < TOTAL_CELLS; i = (i + 1) | 0) {
        const type = voxelData[i] | 0;
        const cfg = _blockConfigFastArray[type];
        if (cfg && cfg.lightLevel > 0) {
            lightData[i] = ((lightData[i] & 240) | (cfg.lightLevel & 15)) | 0;
            queue[tail++] = i;
        }
    }

    // 2-B: 隣接チャンクからのブロック光流入
    for (let i = 0; i < 6; i = (i + 1) | 0) {
        const nm = nMaps[i];
        if (!nm) continue;

        for (let y = 0; y < 256; y = (y + 1) | 0) {
            for (let s = 0; s < 16; s = (s + 1) | 0) {
                let x = 0, z = 0, nLx = 0, nLz = 0;
                if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
                else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
                else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
                else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

                const idx = (y | (z << 8) | (x << 12)) | 0;
                const nIdx = (y | (nLz << 8) | (nLx << 12)) | 0;

                const nBlock = nm[nIdx] & 15;
                const myBlock = lightData[idx] & 15;

                if (nBlock > 1 && (nBlock - 1) > myBlock) {
                    const type = voxelData[idx] | 0;
                    if (type === 0 || (_blockConfigFastArray[type] && _blockConfigFastArray[type].transparent)) {
                        lightData[idx] = ((lightData[idx] & 240) | ((nBlock - 1) & 15)) | 0;
                        queue[tail++] = idx;
                    }
                }
            }
        }
    }

    // 2-C: ブロック光のBFS伝播
    while (head < tail) {
        const idx = queue[head++] | 0;
        const blockLight = lightData[idx] & 15;
        if (blockLight <= 1) continue;

        const nextBlock = (blockLight - 1) | 0;
        const y = idx & 255;
        const z = (idx >> 8) & 15;
        const x = idx >> 12;

        for (let i = 0; i < 6; i = (i + 1) | 0) {
            if ((i === 2 && y === 255) || (i === 3 && y === 0)) continue;

            const isBorder = (i === 0 && x === 15) || (i === 1 && x === 0) || (i === 4 && z === 15) || (i === 5 && z === 0);

            if (isBorder) {
                const nm = nMaps[i];
                const nv = nVoxels[i];
                if (nm && nv) {
                    const nx = (i === 0) ? 0 : (i === 1) ? 15 : x;
                    const nz = (i === 4) ? 0 : (i === 5) ? 15 : z;
                    const nIdx = (y | (nz << 8) | (nx << 12)) | 0;

                    if ((nm[nIdx] & 15) < nextBlock) {
                        const nt = nv[nIdx] | 0;
                        if (nt === 0 || (_blockConfigFastArray[nt] && _blockConfigFastArray[nt].transparent)) {
                            nm[nIdx] = ((nm[nIdx] & 240) | (nextBlock & 15)) | 0;
                            pendingChunkUpdates.add(nKeys[i]);
                        }
                    }
                }
                continue;
            }

            const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
            if ((lightData[nIdx] & 15) < nextBlock) {
                const type = voxelData[nIdx] | 0;
                if (type === 0 || (_blockConfigFastArray[type] && _blockConfigFastArray[type].transparent)) {
                    lightData[nIdx] = ((lightData[nIdx] & 240) | (nextBlock & 15)) | 0;
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

    const mat = new THREE.MeshBasicMaterial({
        map: baseMat?.map || null,
        // 水、透過指定、または元のマテリアルが透過なら transparent を有効化
        transparent: isWater || isTransparent || (baseMat ? baseMat.transparent : false),
        opacity: baseMat ? baseMat.opacity : 1.0,
        vertexColors: true,
        side: (isCross || isWater) ? THREE.DoubleSide : THREE.FrontSide,

        // 💡 修正箇所: isCrossの場合は強制的にtrueにし、それ以外(水やガラス)はfalseにする
        depthWrite: isCross ? true : !(isTransparent || isWater),

        // 植物、または透過指定がある場合はアルファテスト（しきい値0.5）を有効化
        alphaTest: (isCross || isTransparent) ? 0.5 : (baseMat ? baseMat.alphaTest : 0)
    });

    subMap.set(flags, mat);
    return mat;
}


const SharedMaterials = {
    opaque: new THREE.MeshBasicMaterial({ vertexColors: true }),
    water: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, vertexColors: true }),
    cutout: new THREE.MeshBasicMaterial({ alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true }),
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
const _sharedVec3Zero = new THREE.Vector3(0, 0, 0);

const MAX_CH_VERTICES = 65536;
const _globalPosBuffer = new Float32Array(MAX_CH_VERTICES * 3);
const _globalColorBuffer = new Float32Array(MAX_CH_VERTICES * 3);
const _globalUvBuffer = new Float32Array(MAX_CH_VERTICES * 2);
const _globalIndexBuffer = new Uint32Array(MAX_CH_VERTICES * 1.5);

const _isTransparentBlock = new Uint8Array(256);
const _isCustomGeometryBlock = new Uint8Array(256);

for (let id = 0; id < 256; id++) {
    const cfg = _blockConfigFastArray[id];
    if (cfg) {
        _isTransparentBlock[id] = cfg.transparent ? 1 : 0;
        _isCustomGeometryBlock[id] = (cfg.customGeometry || cfg.geometryType !== 'cube') ? 1 : 0;
    }
}

/**
 * 完全に統合・最適化された Chunk Mesh 生成関数
 * - 法線 (CUBE_NORMALS) の明示的指定による正確なライティング
 * - 型付き配列 (Float32Array) を活用したメモリ効率の向上
 * - カスタムジオメトリと通常ブロックの描画ロジックの統一
 */

// --- 定数定義 (関数の外で一度だけ定義) ---
const CUBE_NORMALS = {
    px: [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0],
    nx: [-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0],
    py: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    ny: [0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0],
    pz: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    nz: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]
};

function generateChunkMeshMultiTexture(cx, cz, useInstancing = false) {
    const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
    const container = new THREE.Object3D();

    clearCaches();

    const chunkKey = encodeChunkKey(cx, cz);
    let voxelData = ChunkSaveManager.modifiedChunks.get(chunkKey);
    let isNewChunk = false;

    // --- 1. 地形・洞窟生成 ---
    if (!voxelData) {
        // captureBaseChunkDataを呼ぶだけで、洞窟も地形もすべて含まれたデータが手に入ります。
        voxelData = ChunkSaveManager.captureBaseChunkData(cx, cz);
        isNewChunk = true;
        // ここで modifiedChunks.set はせず、軽量な状態を維持します。
    }

    // --- 2. データアクセス・ヘルパー ---
    function get(x, y, z) {
        if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK_TYPES.SKY;
        if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
            return voxelData[y + CHUNK_HEIGHT * (z + CHUNK_SIZE * x)];
        }
        const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
        return getVoxelAtWorld(wx, wy, wz, globalTerrainCache, { raw: true });
    }

    let lightMap = chunkLightCache.get(chunkKey);
    if (!lightMap || isNewChunk) {
        lightMap = generateChunkLightMap(chunkKey, voxelData);
    }

    function getLightLevel(lx, ly, lz) {
        if (ly < 0) return 0;
        if (ly >= CHUNK_HEIGHT) return 15;
        if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
            return lightMap[ly + CHUNK_HEIGHT * (lz + CHUNK_SIZE * lx)];
        }
        const wx = baseX + lx, wz = baseZ + lz;
        const nCx = Math.floor(wx / CHUNK_SIZE), nCz = Math.floor(wz / CHUNK_SIZE);
        const nKey = encodeChunkKey(nCx, nCz);
        const neighborLightMap = chunkLightCache.get(nKey);
        if (neighborLightMap) {
            const nLx = wx & 15, nLz = wz & 15;
            return neighborLightMap[ly + CHUNK_HEIGHT * (nLz + CHUNK_SIZE * nLx)];
        }
        if (typeof getSkyLightFactor === "function" && typeof gameTime !== "undefined") {
            return (Math.floor(15 * getSkyLightFactor(gameTime)) << 4);
        }
        return 15;
    }

    function getVisMask(x, y, z, type, index) {
        const cached = _globalVisCache[index];
        if (cached !== 0) return cached;
        const myTrans = _isTransparentBlock[type], myCustom = _isCustomGeometryBlock[type];
        let mask = 0, t = 0;

        t = get(x + 1, y, z);
        if (t === 0 || t === BLOCK_TYPES.SKY || (_isTransparentBlock[t] && (!myTrans || t !== type)) || (_isCustomGeometryBlock[t] && !myCustom)) mask |= 1;
        t = get(x - 1, y, z);
        if (t === 0 || t === BLOCK_TYPES.SKY || (_isTransparentBlock[t] && (!myTrans || t !== type)) || (_isCustomGeometryBlock[t] && !myCustom)) mask |= 2;
        t = get(x, y + 1, z);
        if (t === 0 || t === BLOCK_TYPES.SKY || (_isTransparentBlock[t] && (!myTrans || t !== type)) || (_isCustomGeometryBlock[t] && !myCustom)) mask |= 4;
        t = get(x, y - 1, z);
        if (t === 0 || t === BLOCK_TYPES.SKY || (_isTransparentBlock[t] && (!myTrans || t !== type)) || (_isCustomGeometryBlock[t] && !myCustom)) mask |= 8;
        t = get(x, y, z + 1);
        if (t === 0 || t === BLOCK_TYPES.SKY || (_isTransparentBlock[t] && (!myTrans || t !== type)) || (_isCustomGeometryBlock[t] && !myCustom)) mask |= 16;
        t = get(x, y, z - 1);
        if (t === 0 || t === BLOCK_TYPES.SKY || (_isTransparentBlock[t] && (!myTrans || t !== type)) || (_isCustomGeometryBlock[t] && !myCustom)) mask |= 32;

        _globalVisCache[index] = mask;
        return mask;
    }

    // --- 3. 走査ループ ---
    _globalVisCache.fill(0);
    const customGeomCache = new Map(), customGeomBatches = new Map(), faceGeoms = new Map();
    let hasAnySolidBlock = false;

    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const columnIndex = CHUNK_HEIGHT * (z + CHUNK_SIZE * x);
            for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
                const currentIdx = columnIndex + y;
                const type = voxelData[currentIdx];
                if (type === BLOCK_TYPES.SKY) continue;

                hasAnySolidBlock = true;
                const cfg = _blockConfigFastArray[type];
                if (!cfg) continue;

                const wx = baseX + x, wy = BEDROCK_LEVEL + y, wz = baseZ + z;
                const visMask = getVisMask(x, y, z, type, currentIdx);

                // A. カスタムジオメトリ (花、草、クロスモデルなど)
                if (_isCustomGeometryBlock[type]) {
                    if (!customGeomCache.has(type)) {
                        const m = createCustomBlockMesh(type, _sharedVec3Zero, null);
                        if (m) customGeomCache.set(type, m.geometry.clone());
                    }
                    const template = customGeomCache.get(type);
                    if (!template || (!visMask && cfg.cullAdjacentFaces !== false)) continue;

                    if (!customGeomBatches.has(type)) customGeomBatches.set(type, []);
                    const batchArray = customGeomBatches.get(type);

                    for (let g = 0; g < template.groups.length; g++) {
                        const group = template.groups[g];
                        const dir = detectFaceDirection(template, group);
                        if (cfg.cullAdjacentFaces !== false && ((visMask >> dir) & 1) === 0) continue;

                        const subGeo = new THREE.BufferGeometry();
                        extractGroupGeometry(template, group, subGeo);
                        subGeo.applyMatrix4(_tmpMat.makeTranslation(wx, wy, wz));

                        const count = subGeo.getAttribute('position').count;
                        const colors = new Float32Array(count * 3);
                        const light = (cfg.geometryType === "cross") ? getLightLevel(x, y, z) : getLightLevel(x + (dir === 0 ? 1 : dir === 1 ? -1 : 0), y + (dir === 2 ? 1 : dir === 3 ? -1 : 0), z + (dir === 4 ? 1 : dir === 5 ? -1 : 0));

                        const sL = (light >> 4) & 15, bL = light & 15;
                        let fw = 1.0;
                        if (cfg.geometryType !== "cross") {
                            if (dir !== 2 && dir !== 3) fw = 0.8; else if (dir === 3) fw = 0.6;
                        }
                        const sS = Math.max(0.04, LIGHT_LEVEL_FACTORS[sL] * fw * globalBrightnessMultiplier);
                        const bS = Math.max(0.04, LIGHT_LEVEL_FACTORS[bL] * fw * globalBrightnessMultiplier);

                        for (let v = 0; v < count; v++) {
                            colors[v * 3] = sS; colors[v * 3 + 1] = bS; colors[v * 3 + 2] = 0;
                        }
                        subGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
                        batchArray.push(subGeo);
                    }
                    continue;
                }

                // B. 通常の立方体ブロック
                if (visMask && !useInstancing) {
                    for (let i = 0; i < FACE_KEYS.length; i++) {
                        const face = FACE_KEYS[i];
                        if (!((visMask >> faceData[face].bit) & 1)) continue;

                        if (!faceGeoms.has(type)) faceGeoms.set(type, new Map());
                        const matMap = faceGeoms.get(type);
                        const matIdx = faceToMaterialIndex[face];
                        if (!matMap.has(matIdx)) matMap.set(matIdx, { positions: [], colors: [], normals: [] });

                        const batch = matMap.get(matIdx);
                        const v = CUBE_VERTICES[face], n = CUBE_NORMALS[face];
                        for (let j = 0; j < 12; j += 3) {
                            batch.positions.push(v[j] + wx, v[j + 1] + wy, v[j + 2] + wz);
                            batch.normals.push(n[j], n[j + 1], n[j + 2]);
                        }
                        const light = getLightLevel(x + (face === "px" ? 1 : face === "nx" ? -1 : 0), y + (face === "py" ? 1 : face === "ny" ? -1 : 0), z + (face === "pz" ? 1 : face === "nz" ? -1 : 0));
                        const fw = (face === "py") ? 1.0 : (face === "ny") ? 0.6 : 0.8;
                        const sS = Math.max(0.04, LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw * globalBrightnessMultiplier);
                        const bS = Math.max(0.04, LIGHT_LEVEL_FACTORS[light & 15] * fw * globalBrightnessMultiplier);
                        for (let j = 0; j < 4; j++) batch.colors.push(sS, bS, 0);
                    }
                }
            }
        }
    }

    if (!hasAnySolidBlock) return container;

    // --- 4. 通常メッシュの結合とマテリアル適用 ---
    for (const [type, group] of faceGeoms.entries()) {
        const finalGeom = new THREE.BufferGeometry();
        let totalV = 0;
        for (const m of group.values()) totalV += m.positions.length / 3;

        const pos = new Float32Array(totalV * 3), col = new Float32Array(totalV * 3),
            norm = new Float32Array(totalV * 3), uv = new Float32Array(totalV * 2),
            idx = new Uint32Array((totalV / 4) * 6);

        let vO = 0, iO = 0, uvO = 0, gO = 0;

        for (const [mIdx, mData] of group.entries()) {
            const len = mData.positions.length;
            pos.set(mData.positions, vO); col.set(mData.colors, vO); norm.set(mData.normals, vO);
            const fC = len / 12;
            for (let f = 0; f < fC; f++) {
                uv.set(CUBE_UVS, uvO); uvO += 8;
                const bV = (vO / 3) + (f * 4);
                idx[iO] = bV; idx[iO + 1] = bV + 1; idx[iO + 2] = bV + 2;
                idx[iO + 3] = bV; idx[iO + 4] = bV + 2; idx[iO + 5] = bV + 3;
                iO += 6;
            }
            finalGeom.addGroup(gO, fC * 6, mIdx);
            gO += fC * 6; vO += len;
        }

        finalGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        finalGeom.setAttribute('color', new THREE.BufferAttribute(col, 3));
        finalGeom.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
        finalGeom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        finalGeom.setIndex(new THREE.BufferAttribute(idx, 1));
        finalGeom.computeBoundingSphere();

        const baseMats = SharedMaterials.blocks.get(type) || getBlockMaterials(+type);
        const fadeReady = baseMats.map(m => {
            const b = new THREE.MeshBasicMaterial({
                map: m.map, transparent: m.transparent, opacity: m.opacity,
                vertexColors: true, depthWrite: m.depthWrite, side: m.side, alphaTest: m.alphaTest
            });
            b.userData = { originMat: m, shaderUniforms: m.userData?.shaderUniforms };
            if (m.onBeforeCompile) b.onBeforeCompile = m.onBeforeCompile;
            return b;
        });

        const mesh = new THREE.Mesh(finalGeom, fadeReady);
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.finalizeFade = function () {
            if (Array.isArray(mesh.material)) {
                mesh.material = mesh.material.map(c => {
                    const o = c.userData.originMat;
                    if (o) { c.dispose(); return o; }
                    return c;
                });
            }
            mesh.userData.finalizeFade = null;
        };
        container.add(mesh);
    }

    // --- 5. カスタムメッシュの結合 ---
    for (const [type, geoms] of customGeomBatches.entries()) {
        const merged = mergeBufferGeometries(geoms, true);
        merged.computeBoundingSphere();
        const baseMat = (getBlockMaterials(+type) || [])[0];
        const isWater = type === BLOCK_TYPES.WATER || baseMat?.userData?.isWater === true;
        const isGlass = type === BLOCK_TYPES.GLASS || type === 12;
        const isCutout = _blockConfigFastArray[type]?.geometryType === "cross" || isGlass;

        const fadeMat = getOrCreateCustomFadeMaterial(baseMat, isCutout, isWater, isGlass).clone();
        fadeMat.vertexColors = true;
        fadeMat.userData = { originMat: baseMat, shaderUniforms: baseMat?.userData?.shaderUniforms };
        if (baseMat?.onBeforeCompile) fadeMat.onBeforeCompile = baseMat.onBeforeCompile;

        const mesh = new THREE.Mesh(merged, fadeMat);
        mesh.renderOrder = isWater ? 10 : (isGlass || isCutout ? 1 : 0);
        mesh.userData.finalizeFade = null;
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

/* ======================================================
   【最適化版】updateChunks (変更保持ロジック統合)
   ====================================================== */
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

// GC対策：関数の外で再利用
const _chunkKeysInQueue = new Set();

function updateChunks() {
    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);

    if (lastChunk.x === pCx && lastChunk.z === pCz && offsets) return;

    const isMoved = lastChunk.x !== pCx || lastChunk.z !== pCz;

    lastChunk.x = pCx;
    lastChunk.z = pCz;
    offsets ||= precomputeOffsets();

    _chunkKeysInQueue.clear();
    for (let i = 0; i < chunkQueue.length; i++) {
        const q = chunkQueue[i];
        _chunkKeysInQueue.add(encodeChunkKey(q.cx, q.cz));
    }

    const cands = offsets;

    // 1. 未ロード＆未キューイングのものを追加
    for (let i = 0; i < cands.length; i++) {
        const offset = cands[i];
        const cx = pCx + offset.dx;
        const cz = pCz + offset.dz;
        const hashKey = encodeChunkKey(cx, cz);

        if (!loadedChunks.has(hashKey) && !_chunkKeysInQueue.has(hashKey)) {
            chunkQueue.push({ cx, cz });
            _chunkKeysInQueue.add(hashKey);
        }
    }

    // キューの肥大化対策
    if (chunkQueue.length > 500) {
        let writeIdx = 0;
        for (let i = 0; i < chunkQueue.length; i++) {
            const q = chunkQueue[i];
            const dx = Math.abs(q.cx - pCx);
            const dz = Math.abs(q.cz - pCz);
            if (dx <= CHUNK_VISIBLE_DISTANCE && dz <= CHUNK_VISIBLE_DISTANCE) {
                chunkQueue[writeIdx++] = q;
            }
        }
        chunkQueue.length = writeIdx;
    }

    // プレイヤー移動時のみソート（pop()で近い順に処理するため）
    if (isMoved && chunkQueue.length > 1) {
        chunkQueue.sort((a, b) => {
            const dAx = a.cx - pCx;
            const dAz = a.cz - pCz;
            const dBx = b.cx - pCx;
            const dBz = b.cz - pCz;
            return (dBx * dBx + dBz * dBz) - (dAx * dAx + dAz * dAz);
        });
    }

    // 2. 範囲外のチャンクをアンロード
    // 💡 重要：ここに変更保持ロジックを適用
    for (const [hashKey, mesh] of loadedChunks.entries()) {
        const coord = decodeChunkKey(hashKey);
        const dx = Math.abs(coord.cx - pCx);
        const dz = Math.abs(coord.cz - pCz);

        if (dx > CHUNK_VISIBLE_DISTANCE || dz > CHUNK_VISIBLE_DISTANCE) {

            // --- 変更保持判定 ---
            // ChunkSaveManager.modifiedChunks にこのチャンクがある場合、
            // そのまま Map に残しておく（deleteしない）。
            // これにより、再度接近した際に「変更された地形」として読み込まれます。

            if (!ChunkSaveManager.modifiedChunks.has(hashKey)) {
                // 変更がないチャンクの場合は、特に何もしなくても
                // 再接近時にノイズから再生成されるので、メモリ管理上は「何もない」状態でOK
            }

            // 共通：GPUリソースを解放（見た目のメッシュは必ず消す）
            releaseChunkMesh(mesh);
            loadedChunks.delete(hashKey);
        }
    }

    if (chunkQueue.length > 0) {
        processChunkQueue({ timeRemaining: () => 16, didTimeout: true });
    }
}

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

let updateTimeout = null;

// ループの外で使い回すことで、ブロック設置・破壊時のGC（カクつき）を完全に阻止する
let _nCx = 0, _nCz = 0, _nKey = 0n, _nMesh = null, _nVoxelData = null;

function updateAffectedChunks(blockPos, forceImmediate = false) {
    const cx = getChunkCoord(blockPos.x);
    const cz = getChunkCoord(blockPos.z);

    // チャンク内のローカル座標（境界判定用）
    // 16はチャンクサイズを想定。もし異なる場合は定数に変えてください。
    const lx = (blockPos.x % 16 + 16) % 16;
    const lz = (blockPos.z % 16 + 16) % 16;

    // ==========================================
    // 1. ライトデータリセット（既存のまま）
    // ==========================================
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const nCx = cx + dx;
            const nCz = cz + dz;
            const nKey = encodeChunkKey(nCx, nCz);

            if (!loadedChunks.has(nKey)) continue;

            const lData = chunkLightCache.get(nKey);
            if (lData) lData.fill(0);

            let nVoxelData = ChunkSaveManager.modifiedChunks.get(nKey);
            if (!nVoxelData) {
                nVoxelData = ChunkSaveManager.captureBaseChunkData(nCx, nCz);
                ChunkSaveManager.modifiedChunks.set(nKey, nVoxelData);
            }
        }
    }

    // ==========================================
    // 2. ライトマップ計算（既存のまま）
    // ==========================================
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const nCx = cx + dx;
            const nCz = cz + dz;
            const nKey = encodeChunkKey(nCx, nCz);
            if (!loadedChunks.has(nKey)) continue;

            const vData = ChunkSaveManager.modifiedChunks.get(nKey);
            if (vData) {
                generateChunkLightMap(nKey, vData);
            }
        }
    }

    // ==========================================
    // 3. 自分のチャンクを即時更新
    // ==========================================
    refreshChunkAt(cx, cz);

    // ==========================================
    // 4. お隣のチャンク更新（境界なら即時、それ以外は非同期）
    // ==========================================
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;

            const nCx = cx + dx;
            const nCz = cz + dz;
            const nKey = encodeChunkKey(nCx, nCz);
            if (!loadedChunks.has(nKey)) continue;

            // --- 境界判定ロジック ---
            // ブロックが端にある場合、その隣接チャンクは「即時」更新しないと面が欠けて見える
            let isBoundary = false;
            if (lx === 0 && dx === -1) isBoundary = true; // 西端
            if (lx === 15 && dx === 1) isBoundary = true; // 東端
            if (lz === 0 && dz === -1) isBoundary = true; // 北端
            if (lz === 15 && dz === 1) isBoundary = true; // 南端

            if (forceImmediate || isBoundary) {
                refreshChunkAt(nCx, nCz); // 境界は待たせない
            } else {
                pendingChunkUpdates.add(nKey); // 境界でない斜めなどは後回しでOK
            }
        }
    }

    if (!forceImmediate) {
        scheduleChunkUpdate();
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
        updateAffectedChunks(base, false);
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
        updateAffectedChunks(candidate, false);
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
        return new THREE.MeshBasicMaterial({
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

// --- インベントリ表示制御 ---
const inventoryContainer = document.getElementById("inventory-container");
inventoryContainer.style.display = "none";

/* ======================================================
   【ウィンドウのリサイズ対応】
   ====================================================== */
window.addEventListener('resize', () => {
    // 1. カメラのアスペクト比を現在の画面サイズに更新
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    if (!renderer) return;
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
    chunkBorderMesh.renderOrder = 200;

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
   【超軽量・チラつき防止版】アウトラインの選択更新
   ====================================================== */
function updateBlockSelection() {
    const hit = getTargetBlockByDDA(BLOCK_INTERACT_RANGE);

    if (!hit) {
        selectionOutlineMesh.visible = false;
        return; // DDA側でhitがnullの場合、内部で適切にfreeVecされている前提
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

    // プールされたベクトルを安全に使い回す
    let center = globalTempVec3b;
    let size = globalTempVec3c;

    if (config && config.selectionSize && config.selectionOffset) {
        center.set(x + config.selectionOffset.x, y + config.selectionOffset.y, z + config.selectionOffset.z);
        size.set(config.selectionSize.x, config.selectionSize.y, config.selectionSize.z);
    } else {
        center.set(x + 0.5, y + 0.5, z + 0.5);
        size.set(1.01, 1.01, 1.01); // 💡 1.00 から 1.01 にして描画のチラつきを防止
    }

    selectionOutlineMesh.position.copy(center);
    selectionOutlineMesh.scale.copy(size);
    selectionOutlineMesh.visible = true;

    // 💡 確実にプールへ返却
    if (hit.normal) freeVec(hit.normal);
}

// スクリプトの上の方（関数の外）で宣言
let currentTargetBlockText = "None";

function updateBlockInfo() {
    const hit = getTargetBlockByDDA(BLOCK_INTERACT_RANGE);

    if (!hit) {
        currentTargetBlockText = "None";
        return;
    }

    const { x, y, z } = hit;
    const cx = getChunkCoord(x);
    const cz = getChunkCoord(z);

    let lx = x % CHUNK_SIZE;
    if (lx < 0) lx += CHUNK_SIZE;
    let lz = z % CHUNK_SIZE;
    if (lz < 0) lz += CHUNK_SIZE;

    const voxel = ChunkSaveManager.getBlock(cx, cz, lx, y, lz)
        ?? getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });

    if (voxel === BLOCK_TYPES.SKY || voxel === undefined) {
        currentTargetBlockText = "None";
        if (hit.normal) freeVec(hit.normal);
        return;
    }

    const blockName = BLOCK_NAMES[voxel] || "Unknown";
    const config = getBlockConfiguration(voxel);

    // ✅ ポイント：HTMLとして表示するので \n ではなく <br> を使います
    currentTargetBlockText = `${blockName} (ID: ${voxel}) [${x}, ${y}, ${z}]` +
        (config ? `<br>Type: ${config.geometryType}` : "");

    if (hit.normal) freeVec(hit.normal);
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

        const isWater = (blockValue === BLOCK_TYPES.WATER || blockValue === BLOCK_TYPES.LAVA);

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
    if (delta > 0.1) delta = 0.1; // スパイク対策
    const now = performance.now();

    // 0. -------- ロード・スポーン待機ガード --------
    if (!player.spawnFixed) {
        const pCx = Math.floor(player.position.x / CHUNK_SIZE);
        const pCz = Math.floor(player.position.z / CHUNK_SIZE);

        if (loadedChunks.has(encodeChunkKey(pCx, pCz))) {
            // 地形ロード完了
            const groundY = Math.floor(BASE_HEIGHT + heightModifier);
            player.position.y = (player.position.y === 40) ? groundY + 0.1 : player.position.y;
            player.spawnFixed = true;

            // ロード直後の描画状態を、復元された gameTime に即座に合わせる
            updateSkyAndFogColor(gameTime);
        } else {
            // チャンクがロードされるまで物理演算と時間進行を停止
            player.velocity.y = 0;
            updateChunks();
            return;
        }
    }
    frameCount++;

    // 1. -------- 昼夜サイクルの進行と「空・霧」の色更新 --------
    // ★重要: player.spawnFixed が true の時のみ時間を進める。
    // これにより、ロード完了前に 0 からカウントアップされるのを防ぎます。
    if (player.spawnFixed) {
        gameTime = (gameTime + delta * 20 * TIME_SPEED) % TICKS_PER_DAY;
    }
    updateSkyAndFogColor(gameTime);

    // 2. -------- ブロックの明るさ（シェーダー）への反映 --------
    const currentSkyFactor = getSkyLightFactor(gameTime);
    globalSkyUniforms.forEach(uniform => {
        uniform.value = currentSkyFactor;
    });

    // 3. -------- HUD（デバッグ情報）の更新（1秒ごと） --------
    if (now - lastFpsTime > 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        const activeUpdates = pendingChunkUpdates.size + chunkQueue.length;
        const modifiedChunkCount = ChunkSaveManager.modifiedChunks.size;
        const pCx = Math.floor(player.position.x / CHUNK_SIZE);
        const pCz = Math.floor(player.position.z / CHUNK_SIZE);
        const targetText = (typeof currentTargetBlockText !== 'undefined') ? currentTargetBlockText : "None";

        fpsCounter.innerHTML =
            `<span>Minecraft classic 0.0.1</span><br>` +
            `<span>Seed: ${currentSeed}</span><br>` +
            `<span>Time: ${getGameClock(gameTime)} (${Math.floor(gameTime)} ticks)</span><br>` +
            `<span>${fps} fps, ${activeUpdates} chunks update</span><br>` +
            `<span>${modifiedChunkCount} modified chunks (Saved)</span><br>` +
            `<span>C: ${loadedChunks.size} loaded. (Quality: ${CHUNK_VISIBLE_DISTANCE} chunks)</span><br>` +
            `<span>Dimension: Overworld</span><br>` +
            `<span>x: ${Math.round(player.position.x)} (C: ${pCx})</span><br>` +
            `<span>y: ${Math.round(player.position.y)} (feet)</span><br>` +
            `<span>z: ${Math.round(player.position.z)} (C: ${pCz})</span><br>` +
            `<span>Mode: ${flightMode ? "Flight" : wasUnderwater ? "Swimming" : "Walking"} / Dash: ${dashActive ? "ON" : "OFF"}</span><br>` +
            `<span>--------------------------</span><br>` +
            `<span>TargetBlock: ${targetText}</span>`;
        frameCount = 0;
        lastFpsTime = now;
    }

    // 4. -------- プレイヤー操作 & 物理更新 --------
    updateBlockParticles(delta);
    camera.rotation.set(pitch, yaw, 0);

    underwaterTimer += delta;
    if (underwaterTimer > 0.1) {
        wasUnderwater = isPlayerEntireBodyInWater();
        underwaterTimer = 0;
    }

    if (!flightMode && keys[" "] && player.onGround && !wasUnderwater) {
        jumpRequest = true;
    }

    if (flightMode) {
        updateFlightPhysics(delta);
    } else if (wasUnderwater) {
        updateUnderwaterPhysics(delta);
        jumpRequest = false;
    } else {
        updateNormalPhysics(delta);
    }

    resolvePlayerCollision();
    updateOnGround();

    // 5. -------- チャンク生成 & メッシュ再構築 --------
    updateChunks();

    chunkUpdateFrameTimer += delta;
    if (chunkUpdateFrameTimer > 0.016) {
        if (pendingChunkUpdates.size > 0) {
            processPendingChunkUpdates(4);
        }
        chunkUpdateFrameTimer = 0;
    }

    if (showChunkBorders) {
        const pCx = Math.floor(player.position.x / CHUNK_SIZE);
        const pCz = Math.floor(player.position.z / CHUNK_SIZE);
        chunkBorderMesh.position.set(pCx * CHUNK_SIZE, 0, pCz * CHUNK_SIZE);
    }

    // 6. -------- カメラ位置の更新 --------
    const targetCamPos = globalTempVec3;
    _camOffset.set(0, getCurrentPlayerHeight() - (flightMode ? 0.15 : 0), 0);
    targetCamPos.copy(player.position).add(_camOffset);

    camera.position.x = targetCamPos.x;
    camera.position.z = targetCamPos.z;
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, targetCamPos.y, 0.5);

    // 7. -------- ブロック選択・情報の更新 --------
    blockInfoTimer += delta;
    if (blockInfoTimer > 0.05) {
        const moved = camera.position.distanceToSquared(lastCamPos) > 0.00001 ||
            camera.rotation.y !== lastCamRot.y || camera.rotation.x !== lastCamRot.x;
        if (moved) {
            updateBlockSelection();
            updateBlockInfo();
            updateHeadBlockInfo();
            lastCamPos.copy(camera.position);
            lastCamRot.copy(camera.rotation);
        }
        blockInfoTimer = 0;
    }

    // 8. -------- クラウド（雲）の描画更新 --------
    cloudUpdateTimer += delta;
    cloudGridTimer += delta;

    if (cloudUpdateTimer > 0.05) {
        updateCloudTiles(delta);
        updateCloudOpacity(camera.position, getSkyLightFactor(gameTime));
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

    // 9. -------- 最終処理 & レンダリング --------
    updateScreenOverlay();
    resetLastPlacedIfOnGround();

    renderer.render(scene, camera);
}
function getGameClock(ticks) {
    // 0 ticks を 朝6:00 と仮定した場合の計算
    let totalHours = (ticks / 1000 + 6) % 24;
    let hours = Math.floor(totalHours);
    let minutes = Math.floor((totalHours % 1) * 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/* ======================================================
   【UIイベント】タイトル画面からの起動
   ====================================================== */
const ui = {
    menu: document.getElementById('main-menu'),
    config: document.getElementById('world-config'),
    loading: document.getElementById('loading-screen'),
    seedInput: document.getElementById('world-seed')
};

// 1. 新しい世界へ
document.getElementById('btn-to-world-config').onclick = () => {
    ui.menu.style.display = 'none';
    ui.config.style.display = 'flex';
};

// 2. 戻る
document.getElementById('btn-back-to-menu').onclick = () => {
    ui.config.style.display = 'none';
    ui.menu.style.display = 'flex';
};

// 3. 生成開始
document.getElementById('btn-start-game').onclick = async () => {
    const seed = applySeed(ui.seedInput.value);
    startGame(seed);
};

// 保存データから再開（最新修正版）
document.getElementById('btn-load-saved').onclick = async () => {
    try {
        const saveData = await loadFullSaveData();

        // saveData 自体が存在し、かつ seed があるか確認
        if (saveData && saveData.seed !== undefined) {

            // 1. シード値を適用（数値・文字列両対応）
            if (typeof applySeed === 'function') {
                applySeed(saveData.seed);
            }

            // 2. 設置情報をマネージャーに復元
            if (typeof ChunkSaveManager !== 'undefined') {
                // saveData.chunks が Map 形式であることを期待
                ChunkSaveManager.modifiedChunks = (saveData.chunks instanceof Map)
                    ? saveData.chunks
                    : new Map();
            }

            // 3. ゲーム時間を取得
            // loadFullSaveData が gameTime というキーで返していることを確実に利用
            // 取得失敗時や異常値の場合は 6000 (朝) をデフォルトにする
            const restoredTime = (typeof saveData.gameTime === 'number' && !isNaN(saveData.gameTime))
                ? saveData.gameTime
                : 6000;

            console.log(`[Load] 復元データ確認 - Seed: ${saveData.seed}, Time: ${restoredTime}, Chunks: ${saveData.chunks?.size || 0}件`);

            // 4. ゲーム開始
            // 引数の順番：(seed, pos, chunks, gameTime)
            startGame(
                saveData.seed,
                saveData.pos || { x: 0, y: 40, z: 0 }, // 座標がない場合のフォールバック
                saveData.chunks,
                restoredTime // 確定させた時間を渡す
            );

            // 念のためチャット欄などがあれば通知（任意）
            if (typeof addChatMessage === 'function') {
                addChatMessage("セーブデータをロードしました", "#ffff00");
            }

        } else {
            alert("セーブデータが見つかりませんでした。");
        }
    } catch (error) {
        console.error("ロード中にエラーが発生しました:", error);
        alert("データの読み込みに失敗しました。");
    }
};

// 引数に savedTime = 0 を追加
function startGame(seed, savedPos = null, savedChunks = null, savedTime = 0) {
    ui.config.style.display = 'none';
    ui.menu.style.display = 'none';
    ui.loading.style.display = 'flex';
    initCanvas();

    // --- ★最重要: setTimeout の外で即座に時間をセット ---
    // これにより、500msの待機中に初期値(0)で動くのを防ぎます
    if (typeof gameTime !== 'undefined') {
        gameTime = savedTime;
    }

    setTimeout(() => {
        if (typeof applySeed === 'function') {
            applySeed(seed);
        }

        // --- 1. データの復元 ---
        if (savedChunks instanceof Map && savedChunks.size > 0) {
            ChunkSaveManager.modifiedChunks = savedChunks;
        } else {
            ChunkSaveManager.modifiedChunks = ChunkSaveManager.modifiedChunks || new Map();
        }

        // --- 2. プレイヤー位置の反映 ---
        const startPos = savedPos ? savedPos : { x: 0, y: 40, z: 0 };
        if (typeof player !== 'undefined') {
            player.position.set(startPos.x, startPos.y, startPos.z);
            player.spawnFixed = !!savedPos;
        }

        // --- 3. 描画の反映 ---
        if (typeof updateSkyAndFogColor === 'function') {
            updateSkyAndFogColor(gameTime);
        }
        console.log("時間を復元しました:", gameTime);

        ui.loading.style.display = 'none';

        // --- ★重要: ロード直後のセーブ(上書き)をコメントアウト ---
        // ロードが完了した瞬間にセーブすると、万が一ロードに失敗していた場合に
        // 保存データを「壊れたデータ」で上書きしてしまうリスクがあるためです。
        // saveWorldData(seed, startPos, ChunkSaveManager.modifiedChunks, gameTime);

        addChatMessage(savedPos ? "データをロードしました" : `世界を新しく生成しました`, "#ffff00");

        animate(); // ループ開始
    }, 500);
}


/* ======================================================
   【中断・ポーズシステム】修正版
   ====================================================== */
let isPaused = false;
const pauseMenu = document.getElementById("pause-menu");
const mainMenu = document.getElementById("main-menu");

// ポーズ状態を画面に反映させる関数
function updatePauseUI() {
    if (isPaused) {
        pauseMenu.style.display = "flex";
    } else {
        pauseMenu.style.display = "none";
    }
}

/* ======================================================
   【修正版】保存してタイトルへ戻る
   ====================================================== */
const btnSaveAndQuit = document.getElementById("btn-save-quit");

if (btnSaveAndQuit) {
    btnSaveAndQuit.onclick = async () => {
        try {
            // シード値
            const s = (typeof currentSeed !== 'undefined') ? currentSeed : 0;

            // プレイヤー座標
            const pPos = (typeof player !== 'undefined' && player.position)
                ? { x: player.position.x, y: player.position.y, z: player.position.z }
                : { x: 0, y: 20, z: 0 };

            // 【重要】設置情報 (Mapオブジェクトをそのまま渡す)
            const modified = (typeof ChunkSaveManager !== 'undefined')
                ? ChunkSaveManager.modifiedChunks
                : null;

            // 保存処理を実行（modifiedChunksも渡すように後述のsaveWorldDataを修正します）
            await saveWorldData(s, pPos, modified, gameTime);
            console.log("World saved with chunks.");

        } catch (error) {
            console.error("保存失敗:", error);
        } finally {
            window.location.reload();
        }
    };
}



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
addChatMessage("Minecraft classic 0.0.1", "#ffff55");





















// ==========================================
// 1. グローバル変数の定義と初期設定
// ==========================================
const keys = {};
let f3Pressed = false;
let isInventoryOpen = false;
let pointerLocked = false;

// インターバルID管理（連続破壊・設置用）
const interactIntervalIds = {
    left: null,
    right: null,
    touch: null,
};

// モバイル判定
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

// ==========================================
// 2. ユーティリティ関数
// ==========================================
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
// 3. キーボード入力 (keydown / keyup)
// ==========================================
window.addEventListener('keydown', (e) => {
    if (!renderer) return;
    const key = e.key.toLowerCase();

    // --- A. F3キー関連 (デバッグ表示) ---
    if (e.key === "F3") {
        e.preventDefault();
        f3Pressed = true;
        return;
    }
    if (f3Pressed && key === "g") {
        e.preventDefault();
        showChunkBorders = !showChunkBorders;
        if (chunkBorderMesh) chunkBorderMesh.visible = showChunkBorders;
        if (typeof addChatMessage === "function") {
            addChatMessage(
                showChunkBorders ? "チャンク境界を表示しました" : "チャンク境界を非表示にしました",
                "#55ff55"
            );
        }
        return;
    }

    // --- B. Eキー (インベントリ開閉) - 最優先 ---
    if (e.code === 'KeyE') {
        if (isPaused) return
        e.preventDefault();
        e.stopImmediatePropagation();

        if (isInventoryOpen) {
            isInventoryOpen = false;
            inventoryContainer.style.display = "none";
            if (!isPaused) renderer.domElement.requestPointerLock();
        } else {
            isInventoryOpen = true;
            inventoryContainer.style.display = "block";
            document.exitPointerLock();
        }
        return;
    }

    // --- C. ESCキー (メニュー/キャンセル) ---
    if (e.code === 'Escape') {
        if (isInventoryOpen) {
            isInventoryOpen = false;
            inventoryContainer.style.display = "none";
            return;
        }
        if (mainMenu.style.display === "none") {
            isPaused = true;
            if (typeof updatePauseUI === "function") updatePauseUI();
        }
        return;
    }

    // --- D. 以降、インベントリ表示中は無視する操作 ---
    if (isInventoryOpen) return;

    // 数字キー (1-9)
    if (/^[1-9]$/.test(e.key)) {
        selectedHotbarIndex = Number(e.key) - 1;
        updateHotbarSelection();
        const hotbarItems = document.querySelectorAll(".hotbar-item");
        hotbarItems.forEach(item => item.classList.remove("active"));
        if (hotbarItems[selectedHotbarIndex]) {
            hotbarItems[selectedHotbarIndex].classList.add("active");
            activeBlockType = Number(hotbarItems[selectedHotbarIndex].getAttribute("data-blocktype"));
        }
        return;
    }

    // スペースキー (ジャンプ / 飛行)
    if (e.key === " " || e.key === "Spacebar") {
        if (e.repeat) return;
        let now = performance.now();
        if (now - lastSpaceTime < 300) {
            flightMode = !flightMode;
            jumpRequest = false;
        }
        lastSpaceTime = now;
        keys[" "] = true;
    }

    // Wキー (ダッシュ判定)
    if (key === "w") {
        if (!e.repeat) {
            let now = performance.now();
            if (now - lastWPressTime < doubleTapThreshold) dashActive = true;
            lastWPressTime = now;
        }
    }

    // Shiftキー (スニーク)
    if (key === "shift") {
        sneakActive = true;
        if (!flightMode) dashActive = false;
    }

    keys[key] = true;
});

document.addEventListener("keyup", (e) => {
    const key = e.key.toLowerCase();
    keys[key] = false;
    if (key === "f3") f3Pressed = false;
    if (key === "w") dashActive = false;
    if (key === "shift") sneakActive = false;
});

// ==========================================
// 4. マウス・ホイール操作
// ==========================================
window.addEventListener("wheel", (e) => {
    if (!renderer) return;
    selectedHotbarIndex = (selectedHotbarIndex + (e.deltaY > 0 ? 1 : 8)) % 9;
    updateHotbarSelection();
}, { passive: true });

// マウスダウン時の処理を関数化
function onCanvasMouseDown(event) {
    // ガード：rendererがない、またはインベントリ中、またはロックされていない場合は無視
    if (!renderer || isInventoryOpen || document.pointerLockElement !== renderer.domElement) return;

    let action = null;
    let buttonKey = null;
    if (event.button === 0) { action = "destroy"; buttonKey = "left"; }
    else if (event.button === 2) { action = "place"; buttonKey = "right"; }

    if (action && buttonKey) startInteraction(action, buttonKey);
}

document.addEventListener("mouseup", (event) => {
    if (event.button === 0) stopInteraction("left");
    else if (event.button === 2) stopInteraction("right");
}, false);

// ==========================================
// 5. ポインターロック管理
// ==========================================
function onMouseMove(e) {
    if (!pointerLocked || isInventoryOpen) return;
    yaw -= e.movementX * mouseSensitivity;
    pitch = Math.min(Math.max(pitch - e.movementY * mouseSensitivity, -Math.PI / 2), Math.PI / 2);
}

window.addEventListener("mousemove", onMouseMove);

document.addEventListener('pointerlockchange', () => {
    pointerLocked = (document.pointerLockElement === renderer.domElement);

    if (pointerLocked) {
        // ロックされたらポーズ解除
        isPaused = false;
        if (typeof updatePauseUI === "function") updatePauseUI();
    } else {
        // ロックが外れた時、インベントリを開いている最中でなければポーズにする
        if (!isInventoryOpen) {
            isPaused = true;
            if (typeof updatePauseUI === "function") updatePauseUI();
        }
    }
});

const btnResume = document.getElementById("btn-resume");
if (btnResume) {
    btnResume.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 1. 先にフォーカスを外す（超重要）
        btnResume.blur();

        // 2. 状態を更新
        isPaused = false;
        if (typeof updatePauseUI === "function") updatePauseUI();

        // 3. ブラウザの「解除フラグ」が消えるのを待つために
        // 少し長めの待ち時間を設定（100ms程度が安定します）
        await new Promise(resolve => setTimeout(resolve, 100));

        if (renderer && renderer.domElement) {
            renderer.domElement.requestPointerLock();
        }
    });
}

document.getElementById('btn-quit').addEventListener('click', () => {
    window.close();

    // window.closeが効かなかった場合のみ、0.5秒後に実行される
    setTimeout(() => {
        if (!window.closed) {
            alert("ブラウザのセキュリティ制限により自動で閉じられませんでした。タブを直接閉じてください。");
            // あるいはタイトル画面へ戻す処理
            // location.href = 'index.html'; 
        }
    }, 500);
});

// --- タッチ操作用の変数と関数 ---
let lastTouchX = null, lastTouchY = null;
let touchHoldTimeout = null;
let isLongPress = false;
let isTouchMoving = false;

function onCanvasTouchStart(e) {
    if (!renderer || isInventoryOpen || e.touches.length !== 1) return;
    isLongPress = false;
    isTouchMoving = false;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
    touchHoldTimeout = setTimeout(() => {
        isLongPress = true;
        startInteraction("destroy", "touch");
    }, 500);
}

function onCanvasTouchMove(e) {
    if (!renderer || isInventoryOpen || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - lastTouchX;
    const deltaY = touch.clientY - lastTouchY;

    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) isTouchMoving = true;

    lastTouchX = touch.clientX;
    lastTouchY = touch.clientY;

    const touchSensitivity = 0.005;
    yaw -= deltaX * touchSensitivity;
    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch - deltaY * touchSensitivity));

    if (e.cancelable) e.preventDefault();
}

function onCanvasTouchEnd(e) {
    clearTimeout(touchHoldTimeout);
    if (!renderer || isInventoryOpen) return;

    if (!isTouchMoving) {
        if (isLongPress) stopInteraction("touch");
        else interactWithBlock("place");
    } else if (isLongPress) {
        stopInteraction("touch");
    }
    lastTouchX = lastTouchY = null;
}

// ==========================================
// 7. タッチUIボタン設定 (D-Pad / Jump / Sneak)
// ==========================================
function setupTouchControls() {
    let lastForwardTapTime = 0;
    let lastJumpTime = 0;
    let lastSneakTime = 0;
    let sneakToggled = false;
    const TAP_THRESHOLD = 300;

    const bindButton = (id, key, onStart, onEnd) => {
        const btn = document.getElementById(id);
        const start = (e) => { if (onStart) onStart(); keys[key] = true; e.preventDefault(); };
        const end = (e) => { if (onEnd) onEnd(); keys[key] = false; e.preventDefault(); };
        btn.addEventListener("touchstart", start);
        btn.addEventListener("mousedown", start);
        btn.addEventListener("touchend", end);
        btn.addEventListener("mouseup", end);
    };

    // 前進 (ダブルタップでダッシュ)
    bindButton("dpad-up", "w", () => {
        const now = performance.now();
        if (now - lastForwardTapTime < TAP_THRESHOLD) dashActive = true;
        lastForwardTapTime = now;
    }, () => { dashActive = false; });

    bindButton("dpad-down", "s");
    bindButton("dpad-left", "a");
    bindButton("dpad-right", "d");

    // ジャンプ (ダブルタップで飛行)
    const btnJump = document.getElementById("btn-jump");
    const jumpHandler = (e) => {
        const now = performance.now();
        if (now - lastJumpTime < TAP_THRESHOLD) {
            flightMode = !flightMode;
            jumpRequest = false;
        } else {
            if (flightMode) keys[" "] = true;
            else jumpRequest = true;
        }
        lastJumpTime = now;
        e.preventDefault();
    };
    btnJump.addEventListener("touchstart", jumpHandler);
    btnJump.addEventListener("mousedown", jumpHandler);
    btnJump.addEventListener("touchend", () => { if (flightMode) keys[" "] = false; });

    // スニーク (ダブルタップでトグル)
    const btnSneak = document.getElementById("btn-sneak");
    const sneakHandler = (e) => {
        const now = performance.now();
        if (now - lastSneakTime < TAP_THRESHOLD) {
            sneakToggled = !sneakToggled;
            keys["shift"] = sneakToggled;
            sneakActive = sneakToggled;
        } else {
            keys["shift"] = true;
            sneakActive = true;
        }
        lastSneakTime = now;
        e.preventDefault();
    };
    btnSneak.addEventListener("touchstart", sneakHandler);
    btnSneak.addEventListener("mousedown", sneakHandler);
    btnSneak.addEventListener("touchend", () => {
        if (!sneakToggled) { keys["shift"] = false; sneakActive = false; }
    });
}

setupTouchControls();



/* ======================================================
   【1. 設定関連のグローバル変数・DOM取得】
   ====================================================== */

const settingsMenu = document.getElementById('settings-menu');
const btnOpenSettings = document.getElementById('btn-open-settings');
const btnOpenSettingsPause = document.getElementById('btn-open-settings-pause');
const btnSettingsBack = document.getElementById('btn-settings-back');
const btnSettingsReset = document.getElementById('btn-settings-reset');

const rangeRenderDist = document.getElementById('range-render-dist');
const renderDistValLabel = document.getElementById('renderDistVal');
const brightnessSlider = document.getElementById('brightnessSlider');
const brightnessValLabel = document.getElementById('brightnessVal');
const debugChunkInput = document.getElementById('chunkDistance');

let isOpenedFromPause = false;

// 遅延実行用のタイマー変数
let renderDistanceTimeout = null;

/* ======================================================
   【2. 画面遷移の制御】
   ====================================================== */
const toggleMenu = (showSettings, fromPause = false) => {
    settingsMenu.style.display = showSettings ? 'flex' : 'none';
    if (showSettings) {
        if (typeof mainMenu !== 'undefined') mainMenu.style.display = 'none';
        if (typeof pauseMenu !== 'undefined') pauseMenu.style.display = 'none';
        isOpenedFromPause = fromPause;
    } else {
        if (isOpenedFromPause) {
            if (typeof pauseMenu !== 'undefined') pauseMenu.style.display = 'flex';
        } else {
            if (typeof mainMenu !== 'undefined') mainMenu.style.display = 'flex';
        }
    }
};

if (btnOpenSettings) btnOpenSettings.addEventListener('click', () => toggleMenu(true, false));
if (btnOpenSettingsPause) btnOpenSettingsPause.addEventListener('click', () => toggleMenu(true, true));
if (btnSettingsBack) btnSettingsBack.addEventListener('click', () => toggleMenu(false));

/* ======================================================
   【3. コアロジック：描画距離 (Render Distance) の更新】
   ====================================================== */
function applyRenderDistance(val) {
    if (isNaN(val) || val < 0 || val > 32) return;

    CHUNK_VISIBLE_DISTANCE = val;

    // UIの同期
    if (rangeRenderDist) rangeRenderDist.value = val;
    if (renderDistValLabel) renderDistValLabel.innerText = val;
    if (debugChunkInput) debugChunkInput.value = val;

    // 内部システムのリセット（重い処理）
    offsets = null;
    chunkQueue = [];
    lastChunk.x = null;
    lastChunk.z = null;

    // フォグとカメラの調整
    if (typeof scene !== 'undefined' && scene.fog) {
        if (scene.fog.isFogExp2) {
            scene.fog.density = 0.05 / (val || 1);
        } else {
            scene.fog.near = (val - 1) * 16;
            scene.fog.far = val * 16;
        }
    }
    if (typeof camera !== 'undefined') {
        camera.far = Math.max(val * 32, 200); // 描画距離に合わせて遠方を調整
        camera.updateProjectionMatrix();
    }

    // チャンク更新をリクエスト
    if (typeof updateChunks === 'function') {
        updateChunks();
    }
}

/* ======================================================
   【4. コアロジック：明るさ (Brightness) の更新】
   ====================================================== */
window.updateGlobalBrightnessFromUI = function () {
    const slider = document.getElementById("brightnessSlider");
    if (!slider) return;

    const val = parseInt(slider.value, 10);
    if (brightnessValLabel) brightnessValLabel.innerText = val;

    globalBrightnessMultiplier = val / 50;

    // 1. ライトの強度を更新
    if (window.sceneObjects && window.sceneObjects.ambientLight) {
        window.sceneObjects.ambientLight.intensity = globalBrightnessMultiplier;
    }

    // 2. 全チャンクの「マテリアル」だけを更新 (ジオメトリ再生成はしない)
    if (typeof loadedChunks !== 'undefined') {
        for (const [key, mesh] of loadedChunks.entries()) {
            // もしカスタムシェーダーを使用しているなら、uniformを更新するだけで済む
            if (mesh.material && mesh.material.uniforms && mesh.material.uniforms.uBrightness) {
                mesh.material.uniforms.uBrightness.value = globalBrightnessMultiplier;
            } else {
                // 標準マテリアルの場合：再生成せずに色味だけ変えるのは難しいため、
                // 負荷が高い場合は「スライダーを離した時だけ」再生成するように制限する
                // ここではパフォーマンスを優先し、動かしている間はライト変更のみとする
            }
        }
    }
};

// 明るさ：スライダーを「離した時」だけ重いリフレッシュを行う
function refreshAllChunks() {
    if (typeof loadedChunks !== 'undefined' && typeof refreshChunkAt === 'function') {
        for (const [key, mesh] of loadedChunks.entries()) {
            const coord = decodeChunkKey(key);
            refreshChunkAt(coord.cx, coord.cz);
        }
    }
}

/* ======================================================
   【5. UIイベントリスナーの設定（最適化版）】
   ====================================================== */

// 描画距離スライダー：デバウンス処理
if (rangeRenderDist) {
    rangeRenderDist.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (renderDistValLabel) renderDistValLabel.innerText = val;

        // 前の予約をキャンセルして、止まってから300ms後に実行
        clearTimeout(renderDistanceTimeout);
        renderDistanceTimeout = setTimeout(() => {
            applyRenderDistance(val);
        }, 300);
    });
}

// 明るさスライダー
if (brightnessSlider) {
    // 動かしている間はライトの強度（軽い処理）だけ変える
    brightnessSlider.addEventListener('input', () => {
        const val = parseInt(brightnessSlider.value, 10);
        if (brightnessValLabel) brightnessValLabel.innerText = val;
        globalBrightnessMultiplier = val / 50;
        if (window.sceneObjects && window.sceneObjects.ambientLight) {
            window.sceneObjects.ambientLight.intensity = globalBrightnessMultiplier;
        }
    });

    // 指を離した時だけ、全体をリフレッシュする（重い処理を1回だけ）
    brightnessSlider.addEventListener('change', refreshAllChunks);
}

/* ======================================================
   【6. 設定のリセット機能】
   ====================================================== */
const resetSettings = () => {
    // デフォルト値の定義
    const DEFAULTS = {
        renderDist: 6,
        brightness: 50
    };

    // 1. 描画距離のリセット
    if (rangeRenderDist) {
        rangeRenderDist.value = DEFAULTS.renderDist;
        // 即時反映関数を呼び出す
        applyRenderDistance(DEFAULTS.renderDist);
    }

    // 2. 明るさのリセット
    if (brightnessSlider) {
        brightnessSlider.value = DEFAULTS.brightness;
        if (brightnessValLabel) brightnessValLabel.innerText = DEFAULTS.brightness;

        // 変数更新とライト強度反映
        globalBrightnessMultiplier = DEFAULTS.brightness / 50;
        if (window.sceneObjects && window.sceneObjects.ambientLight) {
            window.sceneObjects.ambientLight.intensity = globalBrightnessMultiplier;
        }
        // 重いチャンクリフレッシュを実行
        refreshAllChunks();
    }

    console.log("Settings have been reset to default.");
};

// リセットボタンにイベントを登録
if (btnSettingsReset) {
    btnSettingsReset.addEventListener('click', resetSettings);
}

















/* ======================================================
   【保存システム】IndexedDB Manager
   ====================================================== */
const DB_CONFIG = { name: "MinecraftJS_Save", version: 1 };

async function getDB() {
    return new Promise((resolve) => {
        const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            db.createObjectStore("world_meta"); // シード値、プレイヤー座標
            db.createObjectStore("chunks");     // 変更されたブロックデータ
        };
        request.onsuccess = (e) => resolve(e.target.result);
    });
}

// 保存関数の修正（最新版：gameTimeの追加）
async function saveWorldData(seed, playerPos, modifiedChunks, gameTime) { // 引数にgameTimeを追加
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["world_meta", "chunks"], "readwrite");

        // 1. シード、座標、時間を保存
        const metaStore = tx.objectStore("world_meta");
        metaStore.put(seed, "last_seed");
        metaStore.put(playerPos, "player_pos");
        metaStore.put(gameTime, "game_time"); // ✅ ゲーム時間を追加保存

        // 2. チャンクデータ(設置情報)をすべて保存
        if (modifiedChunks) {
            const chunkStore = tx.objectStore("chunks");
            modifiedChunks.forEach((data, key) => {
                chunkStore.put(data, key.toString());
            });
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// 読込関数の修正（最新版：gameTimeの復元対応）
async function loadFullSaveData() {
    const db = await getDB();
    return new Promise((resolve) => {
        const tx = db.transaction(["world_meta", "chunks"], "readonly");
        const metaStore = tx.objectStore("world_meta");

        const reqSeed = metaStore.get("last_seed");
        const reqPos = metaStore.get("player_pos");
        const reqTime = metaStore.get("game_time"); // ✅ ゲーム時間を取得

        const chunks = new Map();

        // チャンクデータをすべてMapに復元
        tx.objectStore("chunks").openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                chunks.set(BigInt(cursor.key), cursor.value);
                cursor.continue();
            }
        };

        tx.oncomplete = () => {
            resolve({
                seed: reqSeed.result,
                pos: reqPos.result,
                gameTime: reqTime.result ?? 0, // ✅ 取得。データがない場合は0（朝）を返す
                chunks: chunks
            });
        };
    });
}