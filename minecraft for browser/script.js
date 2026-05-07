"use strict";
import * as THREE from './build/three.module.js';
import { BLOCK_CONFIG, BLOCK_TYPES, createBlockMesh, getBlockMaterials, getBlockConfiguration, getBlockGeometry, calculatePlacementMeta, applyMetadataTransform, getLogRotationMatrix, applyRotationToCollisionBox, getCustomGeometryMatrix, idToKey, keyToId } from './blocks.js';
import { createMinecraftBreakParticles, updateBlockParticles } from './particles.js';
import { setMinecraftSky, loadCloudTexture, updateCloudGrid, updateCloudTiles, updateCloudOpacity, adjustCloudLayerDepth } from './cloudsky.js';
import { determineBiome, BIOME_CONFIG, BIOME_ID_TO_NAME } from './biomes/biomes.js';
import { Features } from './features.js';
import { FeatureRules } from './feature_rules.js';

// 各ブロックIDが「面を完全に隠す（不透明な立方体か）」を保持する高速参照用配列
const _isOpaqueBlock = new Uint8Array(1024); // IDの最大数に合わせて調整

Object.values(BLOCK_CONFIG).forEach(cfg => {
    // 以下の条件のいずれかに当てはまるなら「透過（不透明ではない）」とみなす
    // 1. 透明設定(transparent)が true
    // 2. 形状が cube ではない（階段、ハーフブロック、草など）
    // 3. 空(SKY)である
    const isTransparent = cfg.transparent === true;
    const isFullCube = cfg.geometryType === "cube" || cfg.isLog === true;
    const isSky = cfg.id === BLOCK_CONFIG.SKY.id;

    if (!isSky && !isTransparent && isFullCube) {
        _isOpaqueBlock[cfg.id] = 1; // 石、土、原木などは 1
    } else {
        _isOpaqueBlock[cfg.id] = 0; // ガラス、階段、水などは 0
    }
});

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
        const str = (seedInput ?? Math.random()).toString();
        const len = str.length; // 長さをキャッシュ
        for (let i = 0; i < len; i++) {
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

const fade = t => {
    const t3 = t * t * t;
    return t3 * (t * (t * 6 - 15) + 10);
};
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
/* ======================================================
   【極限最適化】フラクタルノイズ生成 (JIT・浮動小数点最適化済)
   ====================================================== */

function fractalNoise2D(x, z, octaves = 4, persistence = 0.5) {
    const nOct = octaves | 0;
    let total = 0.0;
    let amp = 1.0;
    let f = 1.0;
    let maxA = 0.0;

    for (let i = 0; i < nOct; i++) {
        // インライン展開に近い形で記述し、JIT最適化を助ける
        total += perlinNoise2D(x * f, z * f) * amp;
        maxA += amp;
        amp *= persistence;
        f *= 2.0;
    }
    return total / maxA;
}

// 3D用の勾配関数
const grad3D = (hash, x, y, z) => {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
};

// 3Dパーリンノイズ
const perlinNoise3D = (x, y, z) => {
    // 負の数に対応しつつ高速化
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);

    // 0-255の範囲に収める
    const X = xi & 255;
    const Y = yi & 255;
    const Z = zi & 255;

    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    // 勾配計算用の差分
    const xf1 = xf - 1;
    const yf1 = yf - 1;
    const zf1 = zf - 1;

    // ハッシュ値の取得（境界外アクセスを確実に防ぐ）
    const A = (p[X] + Y) & 255;
    const AA = (p[A] + Z) & 255;
    const AB = (p[A + 1] + Z) & 255;
    const B = (p[X + 1] + Y) & 255;
    const BA = (p[B] + Z) & 255;
    const BB = (p[B + 1] + Z) & 255;

    // 補間（lerp）
    // grad3D(p[idx], ...) をそのまま呼ぶより、
    // ここで p[AA] などの値を直接渡すと関数の再帰的なルックアップが減ります
    return lerp(
        lerp(
            lerp(grad3D(p[AA], xf, yf, zf), grad3D(p[BA], xf1, yf, zf), u),
            lerp(grad3D(p[AB], xf, yf1, zf), grad3D(p[BB], xf1, yf1, zf), u),
            v
        ),
        lerp(
            lerp(grad3D(p[AA + 1], xf, yf, zf1), grad3D(p[BA + 1], xf1, yf, zf1), u),
            lerp(grad3D(p[AB + 1], xf, yf1, zf1), grad3D(p[BB + 1], xf1, yf1, zf1), u),
            v
        ),
        w
    );
};


/* ======================================================
   【定数・グローバル変数】
   ====================================================== */
let cloudTiles = new Map();
let globalBrightnessMultiplier = 1.0;
let gameTime = 0;
const TICKS_PER_DAY = 24000;
const TIME_SPEED = 1.0;

/* ======================================================
   【新・昼夜サイクルシステム】
   ====================================================== */
let sunMesh, moonMesh;
const CELESTIAL_ORBIT_RADIUS = 1500; // 描画距離(2500)より内側、雲より外側に配置

/* ======================================================
   textures/environment/ 内の素材を読み込む初期化関数
   ====================================================== */
function initSunMoon() {
    const loader = new THREE.TextureLoader();

    // --- 太陽の設定 ---
    const sunTex = loader.load('textures/environment/sun.png');
    sunTex.magFilter = THREE.NearestFilter; // ドットをクッキリさせる
    sunTex.minFilter = THREE.NearestFilter;

    const sunMat = new THREE.MeshBasicMaterial({
        map: sunTex,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending, // 背景の黒を透過させる
        // 💡 0xffffff(真っ白)だと昼間に白飛びするので、少しグレーにする
        color: new THREE.Color(0xbbbbbb),
        fog: false
    });
    sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(450, 450), sunMat);
    scene.add(sunMesh);

    // --- 月の設定 ---
    const moonTex = loader.load('textures/environment/moon_phases.png');
    moonTex.magFilter = THREE.NearestFilter;
    moonTex.minFilter = THREE.NearestFilter;

    // 💡 moon_phases.png から「満月」の区画だけを表示
    moonTex.repeat.set(0.25, 0.5);
    moonTex.offset.set(0, 0.5);

    const moonMat = new THREE.MeshBasicMaterial({
        map: moonTex,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: new THREE.Color(0xffffff), // 月は夜に映えるので白でOK
        fog: false
    });
    moonMesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), moonMat);
    scene.add(moonMesh);
}

let starGroup;

function initStars() {
    starGroup = new THREE.Group();

    // 1. 星の密度を下げ、2種類のサイズと明るさを定義
    const starConfigs = [
        { count: 100, size: 3.0, alpha: 1.0 }, // 大きい星 (少なく、明るい)
        { count: 700, size: 1.5, alpha: 0.6 }  // 小さい星 (多く、少し暗い)
    ];

    starConfigs.forEach(config => {
        const positions = new Float32Array(config.count * 3);

        for (let i = 0; i < config.count; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos((Math.random() * 2) - 1);
            const r = CELESTIAL_ORBIT_RADIUS * 0.9;

            positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.cos(phi);
            positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

        const mat = new THREE.PointsMaterial({
            color: 0xffffff,
            size: config.size,       // 大小のサイズを適用
            sizeAttenuation: false,
            transparent: true,
            opacity: 0,
            depthTest: true,
            depthWrite: false,
            fog: false
        });

        // 種類ごとのアルファ値(明るさ)を保存しておく
        mat.userData = { baseAlpha: config.alpha };

        const mesh = new THREE.Points(geo, mat);
        starGroup.add(mesh);
    });

    scene.add(starGroup);
}

function updateStars() {
    if (!starGroup || !player) return;

    const nightFactor = 1.0 - getSkyLightFactor(gameTime);
    const twinkle = 0.9 + Math.sin(performance.now() * 0.001) * 0.1;
    const globalAlpha = 0.65;

    // 子要素(大・小の星)ごとに透明度を計算して適用
    starGroup.children.forEach(mesh => {
        const typeAlpha = mesh.material.userData.baseAlpha || 1.0;
        mesh.material.opacity = nightFactor * twinkle * globalAlpha * typeAlpha;
    });

    const angle = (gameTime / TICKS_PER_DAY) * Math.PI * 2;
    starGroup.rotation.z = angle;
    starGroup.position.copy(player.position);

    // 最初のグループのopacityを見て全体を表示/非表示
    starGroup.visible = starGroup.children[0].material.opacity > 0.001;
}

function updateSunMoonPosition() {
    if (!sunMesh || !moonMesh || !player) return;

    // 1. 角度と向きベクトルを計算
    const angle = (gameTime / TICKS_PER_DAY) * Math.PI * 2;
    // Zは0で固定（縦回転の平面を定義）
    _tmpSunDir.set(Math.cos(angle), Math.sin(angle), 0).normalize();

    // 2. プレイヤー位置を基準とした配置
    const sunX = _tmpSunDir.x * CELESTIAL_ORBIT_RADIUS;
    const sunY = _tmpSunDir.y * CELESTIAL_ORBIT_RADIUS;

    // 太陽の配置
    sunMesh.position.set(player.position.x + sunX, player.position.y + sunY, player.position.z);
    sunMesh.lookAt(player.position);

    // 月の配置（太陽の反対側）
    moonMesh.position.set(player.position.x - sunX, player.position.y - sunY, player.position.z);
    moonMesh.lookAt(player.position);

    // 3. 表示判定（地平線の下に隠れる余裕を持たせる）
    sunMesh.visible = (sunY > -150);
    moonMesh.visible = (sunY < 150);

    // 💡 星の追従と表示フラグは updateStars 側で一括管理するため、ここでは行いません。

    // 4. 空の色の更新
    updateSkyAndFogColor(gameTime, sunY, _tmpSunDir);
}

// Minecraft準拠の明るさ係数
function getSkyLightFactor(time) {
    // 0: 日の出, 6000: 正午, 12000: 日没, 18000: 真夜中

    // --- 昼間 ---
    if (time >= 0 && time < 11000) return 1.0;

    // --- 日没（夕焼け） ---
    if (time >= 11000 && time < 13000) {
        const t = (time - 11000) / 2000;
        return THREE.MathUtils.lerp(1.0, 0.1, t);
    }

    // --- 深夜（ここを22800まで延長） ---
    if (time >= 13000 && time < 22800) return 0.1;

    // --- 朝焼け（22800から日の出の24000にかけて一気に明るくする） ---
    if (time >= 22800 && time < 24000) {
        const t = (time - 22800) / 1200; // 期間を短くして変化を急にする
        return THREE.MathUtils.lerp(0.1, 1.0, t);
    }

    return 1.0;
}

/* ======================================================
   【最新・完全版】空とフォグの色更新システム
   ====================================================== */
// --- 関数の外で定義して使い回す（メモリ確保を1回のみにする） ---
const SKY_COLORS = {
    DAY: { r: 120, g: 167, b: 255 },
    SUNSET: { r: 240, g: 160, b: 80 },
    NIGHT: { r: 10, g: 10, b: 20 },
    DAWN: { r: 255, g: 180, b: 100 }
};

const _tmpCamDir = new THREE.Vector3();
const _tmpSunDir = new THREE.Vector3();
const _skyColorObj = new THREE.Color();

/**
 * 空と霧の色を更新する（最適化版）
 */
function updateSkyAndFogColor(time, sunY, sunDir) {
    let baseR, baseG, baseB;

    // --- A. ベースカラーの決定 (変更なし) ---
    if (time >= 22000 || time < 2000) {
        let t;
        if (time >= 22000) {
            t = (time - 22000) / 2000;
            baseR = THREE.MathUtils.lerp(SKY_COLORS.NIGHT.r, SKY_COLORS.DAWN.r, t);
            baseG = THREE.MathUtils.lerp(SKY_COLORS.NIGHT.g, SKY_COLORS.DAWN.g, t);
            baseB = THREE.MathUtils.lerp(SKY_COLORS.NIGHT.b, SKY_COLORS.DAWN.b, t);
        } else {
            t = time / 2000;
            baseR = THREE.MathUtils.lerp(SKY_COLORS.DAWN.r, SKY_COLORS.DAY.r, t);
            baseG = THREE.MathUtils.lerp(SKY_COLORS.DAWN.g, SKY_COLORS.DAY.g, t);
            baseB = THREE.MathUtils.lerp(SKY_COLORS.DAWN.b, SKY_COLORS.DAY.b, t);
        }
    } else if (time >= 2000 && time < 10000) {
        baseR = SKY_COLORS.DAY.r; baseG = SKY_COLORS.DAY.g; baseB = SKY_COLORS.DAY.b;
    } else if (time >= 10000 && time < 13000) {
        let t;
        if (time < 12000) {
            t = (time - 10000) / 2000;
            baseR = THREE.MathUtils.lerp(SKY_COLORS.DAY.r, SKY_COLORS.SUNSET.r, t);
            baseG = THREE.MathUtils.lerp(SKY_COLORS.DAY.g, SKY_COLORS.SUNSET.g, t);
            baseB = THREE.MathUtils.lerp(SKY_COLORS.DAY.b, SKY_COLORS.SUNSET.b, t);
        } else {
            t = (time - 12000) / 1000;
            baseR = THREE.MathUtils.lerp(SKY_COLORS.SUNSET.r, SKY_COLORS.NIGHT.r, t);
            baseG = THREE.MathUtils.lerp(SKY_COLORS.SUNSET.g, SKY_COLORS.NIGHT.g, t);
            baseB = THREE.MathUtils.lerp(SKY_COLORS.SUNSET.b, SKY_COLORS.NIGHT.b, t);
        }
    } else {
        baseR = SKY_COLORS.NIGHT.r; baseG = SKY_COLORS.NIGHT.g; baseB = SKY_COLORS.NIGHT.b;
    }

    let r = baseR, g = baseG, b = baseB;

    // --- B. 視線による方向別カラー補正 ---
    camera.getWorldDirection(_tmpCamDir);

    // ★修正点: 内部での角度再計算(angle = ... normalize())を削除し、引数の sunDir を使う
    const isSunrise = (time >= 21000 || time < 3000);
    const isSunset = (time >= 9000 && time < 14000);

    if (isSunrise || isSunset) {
        const dotSun = _tmpCamDir.dot(sunDir);
        if (dotSun > 0) {
            const heightFactor = Math.max(0, 1 - Math.abs(sunDir.y) * 1.5);
            const glow = Math.pow(dotSun, 3) * 0.8 * heightFactor;
            const target = isSunrise ? SKY_COLORS.DAWN : SKY_COLORS.SUNSET;

            r = THREE.MathUtils.lerp(r, target.r, glow);
            g = THREE.MathUtils.lerp(g, target.g, glow);
            b = THREE.MathUtils.lerp(b, target.b, glow);
        }
    }

    // --- C. 太陽直視時の眩しさ ---
    if (sunY > 0) {
        const lookAtSunFactor = _tmpCamDir.dot(sunDir);
        if (lookAtSunFactor > 0.92) {
            const intensity = Math.pow(lookAtSunFactor, 25) * 35 * Math.max(0, sunDir.y);
            r += intensity; g += intensity * 0.9; b += intensity * 0.7;
        }
    }

    // --- D. 最終適用 ---
    const m = globalBrightnessMultiplier / 255;
    _skyColorObj.setRGB(
        Math.max(0, Math.min(1, r * m)),
        Math.max(0, Math.min(1, g * m)),
        Math.max(0, Math.min(1, b * m))
    );

    renderer.setClearColor(_skyColorObj);
    if (scene.fog) {
        scene.fog.color.copy(_skyColorObj);
    }
    updateGlobalSkyLight(time);
}
/* ======================================================
   【新・チャンク保存管理システム (クラスなし版) - 極限最適化版】
   ====================================================== */

// --- クラス外定数・キャッシュの事前定義 (GC対策) ---
const _heightCache = new Map();
const _externalCache = new Map();

// バイオームブレンディング用の重み係数を事前に計算 (1.0 / (1.0 + 距離の2乗))
const BLEND_RADIUS = 3;
const BLEND_WEIGHTS = new Float32Array((BLEND_RADIUS * 2 + 1) * (BLEND_RADIUS * 2 + 1));
for (let dx = -BLEND_RADIUS; dx <= BLEND_RADIUS; dx++) {
    for (let dz = -BLEND_RADIUS; dz <= BLEND_RADIUS; dz++) {
        const idx = (dx + BLEND_RADIUS) * (BLEND_RADIUS * 2 + 1) + (dz + BLEND_RADIUS);
        BLEND_WEIGHTS[idx] = 1.0 / (1.0 + (dx * dx + dz * dz));
    }
}

const _internalSetLocal = (data, lx, ly, lz, blockId, allowOverwrite, skyId, leavesId) => {
    lx = lx | 0; ly = ly | 0; lz = lz | 0;
    if (((lx | lz) & ~15) !== 0 || (ly >>> 8) !== 0) return;

    const idx = (ly | (lz << 8) | (lx << 12)) | 0;
    const currentId = data[idx] & 0xFFF;

    if (currentId === skyId || currentId === leavesId || allowOverwrite) {
        data[idx] = blockId;
    }
};

export const ChunkSaveManager = {
    modifiedChunks: new Map(),
    chunkUpdateInfo: new Map(),

    // 共有バッファ (メモリ再確保を防止)
    _sharedSurfaceHeights: new Int32Array(256),
    _sharedHeightMap: new Int32Array(256),
    _sharedBiomeMap: new Uint8Array(256), // オブジェクトではなくIDを格納
    _sharedPaddedBiomeMap: new Uint8Array(484),      // バイオームオブジェクト用
    _sharedPaddedHeightNoiseMap: new Float32Array(484), // 事前計算済み高さノイズ用

    getBlockIndex: function (lx, ly, lz) {
        return ((ly | 0) + ((lz | 0) << 8) + ((lx | 0) << 12)) >>> 0;
    },

    setBlock: function (cx, cz, lx, ly, lz, blockType) {
        if (ly < 0 || ly >= CHUNK_HEIGHT) return;

        const key = encodeChunkKey(cx, cz);
        let dataArray = this.modifiedChunks.get(key);

        if (!dataArray) {
            dataArray = this.captureBaseChunkData(cx, cz);
            this.modifiedChunks.set(key, dataArray);
        }

        const idx = ((ly | 0) + ((lz | 0) << 8) + ((lx | 0) << 12)) >>> 0;
        dataArray[idx] = blockType;

        this._markByKey(key, ly);

        if (lx === 0) {
            this._markByKey(((cx - 1) & 0xFFFF) << 16 | (cz & 0xFFFF), ly);
        } else if (lx === 15) {
            this._markByKey(((cx + 1) & 0xFFFF) << 16 | (cz & 0xFFFF), ly);
        }

        if (lz === 0) {
            this._markByKey((cx & 0xFFFF) << 16 | ((cz - 1) & 0xFFFF), ly);
        } else if (lz === 15) {
            this._markByKey((cx & 0xFFFF) << 16 | ((cz + 1) & 0xFFFF), ly);
        }
    },

    _markByKey: function (key, ly) {
        let info = this.chunkUpdateInfo.get(key);
        if (info === undefined) {
            this.chunkUpdateInfo.set(key, {
                maxModifiedY: ly,
                minModifiedY: ly,
                needsRebuild: true
            });
        } else {
            if (ly > info.maxModifiedY) info.maxModifiedY = ly;
            else if (ly < info.minModifiedY) info.minModifiedY = ly;
            info.needsRebuild = true;
        }
    },

    _markChunkForUpdate: function (cx, cz, ly) {
        this._markByKey(encodeChunkKey(cx, cz), ly);
    },

    getBlock: function (cx, cz, lx, ly, lz) {
        if (ly < 0 || ly >= CHUNK_HEIGHT) return null;
        const dataArray = this.modifiedChunks.get(encodeChunkKey(cx, cz));
        if (!dataArray) return null;

        const idx = ((ly | 0) + ((lz | 0) << 8) + ((lx | 0) << 12)) >>> 0;
        return dataArray[idx];
    },

    captureBaseChunkData: function (cx, cz) {
        const data = new Uint16Array(65536);
        const baseX = (cx << 4) | 0;
        const baseZ = (cz << 4) | 0;

        const { SKY, STONE, DIRT, GRASS, WATER, LAVA, BEDROCK } = BLOCK_TYPES;
        const seaLevel = SEA_LEVEL | 0;

        const heightMap = this._sharedHeightMap;
        const biomeMap = this._sharedBiomeMap;
        const paddedBiomeMap = this._sharedPaddedBiomeMap;
        const paddedHMap = this._sharedPaddedHeightNoiseMap; // 最適化用

        const blendRadius = BLEND_RADIUS | 0;
        const paddedSize = 22 | 0;

        // ------------------------------------------------------
        // 3. バイオーム割当 & 高さ事前計算 (ここが最大の最適化ポイント)
        // ------------------------------------------------------
        for (let x = -blendRadius; x < 16 + blendRadius; x++) {
            const worldX = (baseX + x) | 0;
            const xOffset = ((x + blendRadius) * paddedSize) | 0;

            for (let z = -blendRadius; z < 16 + blendRadius; z++) {
                const worldZ = (baseZ + z) | 0;
                const localIdx = (xOffset + (z + blendRadius)) | 0;

                const temp = fractalNoise2D(worldX * 0.0005, worldZ * 0.0005, 3) + 0.5;
                const humidity = fractalNoise2D(worldX * 0.0005 + 500, worldZ * 0.0005 + 500, 3) + 0.5;
                const riverValue = fractalNoise2D(worldX * 0.005, worldZ * 0.005, 2) + 0.5;

                const b = determineBiome(temp, humidity, 64, riverValue);
                // オブジェクトのプロパティをローカルにキャッシュ
                const nScale = b.noiseScale;
                const bHeight = b.baseHeight;
                const hVar = b.heightVariation;

                paddedBiomeMap[localIdx] = b.id;
                const nNoise = fractalNoise2D(worldX * nScale, worldZ * nScale, 5);
                paddedHMap[localIdx] = bHeight + (nNoise * hVar);
            }
        }

        // ------------------------------------------------------
        // 4&5&6. 地形・洞窟・表土の一括生成 (極限最適化版)
        // ------------------------------------------------------
        // 🌟 3回に分かれていたループと「石を土で上書きする」処理を1回に統合しました。
        const surfaceHeights = this._sharedSurfaceHeights;
        surfaceHeights.fill(0);

        const scaleXZ = CAVE_SCALE_XZ;
        const scaleY = CAVE_SCALE_Y;
        const LAVA_ID = BLOCK_TYPES.LAVA | 0;
        const SKY_ID = BLOCK_TYPES.SKY | 0;
        const STONE_ID = BLOCK_TYPES.STONE | 0;

        for (let x = 0; x < 16; x = (x + 1) | 0) {
            const worldX = (baseX + x) | 0;
            const nx = worldX * scaleXZ;
            const xOff = (x << 12) | 0;
            const xMapIdx = (x << 4) | 0;

            for (let z = 0; z < 16; z = (z + 1) | 0) {
                const worldZ = (baseZ + z) | 0;
                const nz = worldZ * scaleXZ;
                const xzOff = (xOff | (z << 8)) | 0;
                const mapIdx = (xMapIdx | z) | 0;

                const currentBiomeId = paddedBiomeMap[(x + blendRadius) * paddedSize + (z + blendRadius)];
                biomeMap[mapIdx] = currentBiomeId;
                const biome = BIOME_CONFIG[currentBiomeId];

                // ブレンディングによる高さ計算
                let totalHeight = 0.0;
                let totalWeight = 0.0;
                let weightIdx = 0;
                for (let dx = -blendRadius; dx <= blendRadius; dx = (dx + 1) | 0) {
                    const xShift = ((x + dx + blendRadius) * paddedSize) | 0;
                    for (let dz = -blendRadius; dz <= blendRadius; dz = (dz + 1) | 0) {
                        const h = paddedHMap[xShift + (z + dz + blendRadius) | 0];
                        const weight = BLEND_WEIGHTS[weightIdx++];
                        totalHeight += h * weight;
                        totalWeight += weight;
                    }
                }

                const sHeight = (totalHeight / totalWeight) | 0;
                heightMap[mapIdx] = sHeight;
                surfaceHeights[mapIdx] = sHeight;

                // 表土レイヤーの計算
                const filler = biome.fillerBlock | 0;
                const top = biome.topBlock | 0;
                const dirtEnd = (sHeight - 1) | 0;
                let stoneEnd = (sHeight - 4) | 0;
                if (stoneEnd < 1) stoneEnd = 1;

                // Y=0 は岩盤
                data[xzOff] = BEDROCK;

                // Y=1 から Y=seaLevel または sHeight の高い方まで一気に積み上げる
                const maxY = sHeight > seaLevel ? sHeight : seaLevel;

                for (let y = 1; y <= maxY; y = (y + 1) | 0) {
                    const idx = (xzOff + y) | 0;

                    if (y < sHeight) {
                        // 地形内部の処理（石・土・洞窟）
                        let blockToPlace = STONE_ID;

                        // 洞窟判定 (Y=5以上)
                        if (y >= 5 && isCave(worldX, y, worldZ, sHeight, nx, y * scaleY, nz)) {
                            data[idx] = (y <= 11) ? LAVA_ID : SKY_ID;
                            continue; // 洞窟なら表土化の処理をスキップ
                        }

                        // 表土判定 (洞窟で空気にされなかった部分のみ)
                        if (y >= stoneEnd) {
                            if (y === dirtEnd) {
                                blockToPlace = (dirtEnd < seaLevel) ? filler : top;
                            } else {
                                blockToPlace = filler;
                            }
                        }
                        data[idx] = blockToPlace;

                    } else if (y >= sHeight && y <= seaLevel) {
                        // 地形より上で、海面以下の場合は海
                        data[idx] = WATER;
                    }
                }
            }
        }

        // ------------------------------------------------------
        // 7. デコレーション - バイオーム別試行回数 & 早期リターン最適化版
        // ------------------------------------------------------
        const decorationMargin = 6 | 0;
        const LEAVES_ID = BLOCK_TYPES.LEAVES_OAK | 0;
        const SKY_ID_VAL = BLOCK_TYPES.SKY | 0;

        const getBlockBound = (lx, ly, lz) => {
            lx = lx | 0; ly = ly | 0; lz = lz | 0;
            if (((lx | lz) & ~15) !== 0 || (ly >>> 8) !== 0) return null;
            return data[(ly | (lz << 8) | (lx << 12)) | 0] & 0xFFF;
        };

        const setBlockBound = (lx, ly, lz, bid, ow) =>
            _internalSetLocal(data, lx, ly, lz, bid, ow, SKY_ID_VAL, LEAVES_ID);

        // 3x3のチャンク範囲を走査（自チャンクに影響を与える可能性のある範囲）
        for (let dcx = -1; dcx <= 1; dcx = (dcx + 1) | 0) {
            for (let dcz = -1; dcz <= 1; dcz = (dcz + 1) | 0) {
                const targetBaseX = (baseX + (dcx << 4)) | 0;
                const targetBaseZ = (baseZ + (dcz << 4)) | 0;

                // 🌟 最適化: ループの最初にバイオームを判定し、そのバイオームの試行回数を取得
                // 300固定からバイオーム可変（砂漠なら20回など）にするだけで劇的に速くなります
                const sampleWorldX = (targetBaseX + 8) | 0;
                const sampleWorldZ = (targetBaseZ + 8) | 0;

                // サンプル地点のバイオームIDを取得（高速化のため簡易判定）
                const sTemp = fractalNoise2D(sampleWorldX * 0.0005, sampleWorldZ * 0.0005, 3) + 0.5;
                const sHum = fractalNoise2D(sampleWorldX * 0.0005 + 500, sampleWorldZ * 0.0005 + 500, 3) + 0.5;
                const sRiv = fractalNoise2D(sampleWorldX * 0.005, sampleWorldZ * 0.005, 2) + 0.5;
                const sampleBiome = determineBiome(sTemp, sHum, 64, sRiv);

                const biomeRuleConfig = FeatureRules[sampleBiome.id] || FeatureRules['Default'];
                const attemptsPerChunk = biomeRuleConfig.attempts;
                const rules = biomeRuleConfig.rules;

                for (let i = 0; i < attemptsPerChunk; i = (i + 1) | 0) {
                    let h = Math.imul(targetBaseX ^ (targetBaseZ << 16), 16777619);
                    h = Math.imul(h ^ (currentSeed + i), 16777619);
                    h = (h ^ (h >>> 16)) >>> 0;

                    const relLx = ((h & 0xFFFF) / 65536) * 16;
                    const relLz = (((h >>> 16) & 0xFFFF) / 65536) * 16;
                    const lx = (relLx + (dcx << 4));
                    const lz = (relLz + (dcz << 4));

                    // チャンク範囲外すぎる場合はスキップ
                    if (lx < -decorationMargin || lx > 15 + decorationMargin ||
                        lz < -decorationMargin || lz > 15 + decorationMargin) continue;

                    const worldX = (targetBaseX + relLx) | 0;
                    const worldZ = (targetBaseZ + relLz) | 0;
                    let rnd = ((Math.imul(h, 31) >>> 0) / 4294967296);

                    let surfaceY = 0;
                    let bId = -1;

                    // 自チャンク内なら事前計算済みのマップを使用 (超高速)
                    if (dcx === 0 && dcz === 0) {
                        const mapIdx = (relLx | 0) << 4 | (relLz | 0);
                        surfaceY = surfaceHeights[mapIdx] | 0;
                        bId = biomeMap[mapIdx];
                    } else {
                        // 他チャンクの場合はキャッシュを参照
                        const cacheKey = (worldX * 4294967296) + (worldZ >>> 0);
                        let cv = _externalCache.get(cacheKey);

                        if (cv === undefined) {
                            // キャッシュがない場合のみ重い計算を実行
                            const y = calculateSurfaceHeight(worldX, worldZ); // 高さを計算する関数を外部定義推奨
                            if (y <= seaLevel) {
                                cv = -1;
                            } else {
                                const b = determineBiome(
                                    fractalNoise2D(worldX * 0.0005, worldZ * 0.0005, 3) + 0.5,
                                    fractalNoise2D(worldX * 0.0005 + 500, worldZ * 0.0005 + 500, 3) + 0.5,
                                    64,
                                    fractalNoise2D(worldX * 0.005, worldZ * 0.005, 2) + 0.5
                                );
                                cv = { y: y, id: b.id };
                            }
                            _externalCache.set(cacheKey, cv);
                            if (_externalCache.size > 2000) _externalCache.delete(_externalCache.keys().next().value);
                        }

                        if (cv === -1 || !cv) continue;
                        surfaceY = cv.y;
                        bId = cv.id;
                    }

                    if (surfaceY <= seaLevel) continue;

                    for (let j = 0; j < rules.length; j = (j + 1) | 0) {
                        const rule = rules[j];

                        // 🌟 劇的最適化：
                        // 自チャンク以外（dcx/dcz != 0）の計算時は、
                        // 「構造物（木など）」以外のルール（草・花）を完全にスキップする。
                        if ((dcx !== 0 || dcz !== 0) && !rule.isStructure) {
                            rnd -= rule.chance;
                            continue;
                        }

                        if (rnd < rule.chance) {
                            const featureFunc = Features[rule.feature];
                            if (featureFunc) {
                                featureFunc(lx, surfaceY, lz, setBlockBound, rnd / rule.chance, getBlockBound, worldX, worldZ);
                            }
                            break;
                        }
                        rnd -= rule.chance;
                        if (rnd < 0) break;
                    }
                }
            }
        }

        return data;
    },

    clearUpdateFlag: function (cx, cz) {
        const key = encodeChunkKey(cx, cz);
        const info = this.chunkUpdateInfo.get(key);
        if (info) info.needsRebuild = false;
    }
};

/**
 * 特定のワールド座標(x, z)における地形の最終的な高さを計算する
 * (デコレーションの境界判定用)
 */
function calculateSurfaceHeight(worldX, worldZ) {
    const blendRadius = BLEND_RADIUS | 0;
    let totalHeight = 0.0;
    let totalWeight = 0.0;
    let weightIdx = 0;

    // ブレンディング計算
    for (let dx = -blendRadius; dx <= blendRadius; dx++) {
        for (let dz = -blendRadius; dz <= blendRadius; dz++) {
            const bX = (worldX + dx) | 0;
            const bZ = (worldZ + dz) | 0;

            // バイオーム判定
            const bTemp = fractalNoise2D(bX * 0.0005, bZ * 0.0005, 3) + 0.5;
            const bHum = fractalNoise2D(bX * 0.0005 + 500, bZ * 0.0005 + 500, 3) + 0.5;
            const bRiv = fractalNoise2D(bX * 0.005, bZ * 0.005, 2) + 0.5;
            const b = determineBiome(bTemp, bHum, 64, bRiv);

            // その地点のベースノイズ
            const nNoise = fractalNoise2D(bX * b.noiseScale, bZ * b.noiseScale, 5);
            const hVal = b.baseHeight + (nNoise * b.heightVariation);

            const weight = BLEND_WEIGHTS[weightIdx++];
            totalHeight += hVal * weight;
            totalWeight += weight;
        }
    }

    return (totalHeight / totalWeight) | 0;
}







//ブロックの状態

/**
 * パネル系・フェンス系ブロックの接続マスクを取得する共通関数
 */
function getConnectionMask(x, y, z, targetGeometryType) {
    let mask = 0;
    const neighbors = [
        { dx: 0, dz: -1, bit: 3 }, // 北
        { dx: 0, dz: 1, bit: 2 }, // 南
        { dx: 1, dz: 0, bit: 1 }, // 東
        { dx: -1, dz: 0, bit: 0 }  // 西
    ];

    for (let i = 0; i < neighbors.length; i++) {
        const { dx, dz, bit } = neighbors[i];
        const neighborRaw = getVoxelAtWorld(x + dx, y, z + dz, true);
        const neighborId = neighborRaw & 0xFFF;

        const cfg = getBlockConfiguration(neighborId);
        if (cfg) {
            const isTarget = cfg.geometryType === targetGeometryType;
            const isOpaque = _isOpaqueBlock[neighborId] === 1;

            if (isTarget || isOpaque) {
                mask |= (1 << bit);
            }
        }
    }
    return mask;
}

// 呼び出し用関数をスッキリさせる
function getFenceConnectionMask(x, y, z) {
    return getConnectionMask(x, y, z, "fence");
}

function getPaneConnectionMask(x, y, z) {
    return getConnectionMask(x, y, z, "pane");
}
















const MAX_CACHE_SIZE = 15000;
const terrainHeightCache = new Map();

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

const JUMP_INITIAL_SPEED = 0.2;
const UP_DECEL = 0.018;
const DOWN_ACCEL = 0.007;
const MAX_FALL_SPEED = -1;

const flightSpeed = 0.225;
const doubleTapThreshold = 300;
let flightMode = false;
let lastSpaceTime = 0;
let wasUnderwater = false;

let lastFpsTime = performance.now();
let frameCount = 0;
const fpsCounter = document.getElementById("fpsCounter");

// ======================================================
// Vector3 / Box3 Object Pool (改良版)
// ======================================================
const _vecPool = [];
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

const BEDROCK_LEVEL = 0;

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
const spawnY = Math.max(getTerrainHeight(spawnX, spawnZ), SEA_LEVEL + 5) + 2;

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
export const scene = new THREE.Scene();
// 💡 32マス先から霧が始まり、128マス（8チャンク程度）先で完全に霧で見えなくする
scene.fog = new THREE.FogExp2(fogColor, 0.008);
setMinecraftSky(scene);

loadCloudTexture(() => {
    updateCloudGrid(scene, camera.position);
});

export const camera = new THREE.PerspectiveCamera(
    80,                                 // 視野角
    window.innerWidth / window.innerHeight, // アスペクト比
    0.1,                                // near
    2500                               // far
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

// 初期化部分 (script.js の上の方)
const selectionGroup = new THREE.Group();
scene.add(selectionGroup);


/* ======================================================
   【プレイヤーAABB・衝突判定関連】最新最適化版
   ====================================================== */

// --- 外部変数の定義（GC防止用の再利用オブジェクト） ---
const _tempAABB = new THREE.Box3();
const _SHARED_AABB_RESULT = {
    collision: false,
    time: 0,
    normal: new THREE.Vector3()
};

function getPlayerAABB(pos = player.position, size = null) {
    // 1. nullとの厳密比較（JIT最適化ヒント）
    const h = (size !== null) ? size.h : (sneakActive ? SNEAK_HEIGHT : PLAYER_HEIGHT);
    const r = (size !== null) ? size.r : (PLAYER_RADIUS - COLLISION_MARGIN);

    let feetY = pos.y;
    // 2. Booleanの厳密比較（分岐予測の助け）
    if (player.positionIsCenter === true) {
        feetY -= (h * 0.5);
    }

    // 3. プロパティキャッシュと直接代入（これは修正版でも完璧にできています！）
    const min = _tempAABB.min;
    const max = _tempAABB.max;

    min.x = pos.x - r;
    min.y = feetY;
    min.z = pos.z - r;

    max.x = pos.x + r;
    max.y = feetY + h;
    max.z = pos.z + r;

    return _tempAABB;
}

const getPlayerAABBAt = getPlayerAABB;
/* ======================================================
   【衝突判定キャッシュ＆プールシステム】
   ====================================================== */

export const blockCollisionBoxCache = new Map();
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

/**
 * ボクセルの衝突判定用ボックスを取得（キャッシュ利用）
 */
function getCachedCollisionBoxes(voxelId) {
    if (blockCollisionBoxCache.has(voxelId)) {
        return blockCollisionBoxCache.get(voxelId);
    }

    const cfg = getBlockConfiguration(voxelId);
    const rel = [];

    if (cfg && typeof cfg.customCollision === "function") {
        try {
            rel.push(...cfg.customCollision());
        } catch (e) {
            console.error("Collision config error:", e);
        }
    }

    // デフォルトは 1x1x1 のフルブロック
    if (rel.length === 0) {
        rel.push(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)));
    }

    blockCollisionBoxCache.set(voxelId, rel);
    blockCollisionFlagCache.set(voxelId, !!cfg?.collision);
    return rel;
}

/* ======================================================
   【極限最適化版】AABB衝突判定システム
   ====================================================== */
const _tempWorldBox = new THREE.Box3();

function checkAABBCollision(aabb, velocity, dt) {
    const isDynamic = velocity !== undefined && dt !== undefined;

    let result = false;
    if (isDynamic) {
        result = _SHARED_AABB_RESULT;
        result.collision = false;
        result.time = dt;
        result.normal.set(0, 0, 0);
    }

    // 1. 小数点計算と floor をビット演算で高速化 (正数前提なら | 0 が最速)
    // ただし座標が負になる可能性がある場合は Math.floor を維持
    const minX = Math.floor(aabb.min.x - 0.1) | 0;
    const maxX = Math.floor(aabb.max.x + 0.1) | 0;
    const minY = Math.floor(aabb.min.y - 1.1) | 0;
    const maxY = Math.floor(aabb.max.y + 0.1) | 0;
    const minZ = Math.floor(aabb.min.z - 0.1) | 0;
    const maxZ = Math.floor(aabb.max.z + 0.1) | 0;

    const rotatedRelBox = getPooledBox();
    const wb = _tempWorldBox;
    const wbMin = wb.min; // プロパティアクセスのキャッシュ
    const wbMax = wb.max;

    // キャッシュへの参照をローカル変数に保持
    const flagCache = blockCollisionFlagCache;
    const boxCache = blockCollisionBoxCache;

    for (let y = minY; y <= maxY; y = (y + 1) | 0) {
        for (let x = minX; x <= maxX; x = (x + 1) | 0) {
            for (let z = minZ; z <= maxZ; z = (z + 1) | 0) {

                // 2. getVoxelAtWorld 内部での計算を想定し、引数を整数化して渡す
                const rawVoxel = getVoxelAtWorld(x | 0, y | 0, z | 0, true) | 0;

                // 3. ゼロ判定（空気）を最優先。0xFFFマスク前に弾く
                if (rawVoxel <= 0) continue;

                const id = rawVoxel & 0xFFF;
                if (id === BLOCK_TYPES.SKY || id === BLOCK_TYPES.WATER) continue;

                // 4. Map.get の回数を最小化
                let coll = flagCache.get(id);
                if (coll === undefined) {
                    getCachedCollisionBoxes(id);
                    coll = flagCache.get(id) ?? false;
                }
                if (!coll) continue;

                const relBoxes = boxCache.get(id);
                if (!relBoxes) continue;

                const metadata = (rawVoxel >> 12) & 0xF;

                // relBoxes.length のプロパティアクセスもループ外でキャッシュ可能だが、
                // 通常はJITが最適化するためそのまま
                for (let j = 0, len = relBoxes.length; j < len; j = (j + 1) | 0) {
                    applyRotationToCollisionBox(relBoxes[j], metadata, rotatedRelBox);

                    // 5. オブジェクトの深い階層へのアクセスを避ける
                    const rMin = rotatedRelBox.min;
                    const rMax = rotatedRelBox.max;

                    wbMin.x = rMin.x + x;
                    wbMin.y = rMin.y + y;
                    wbMin.z = rMin.z + z;
                    wbMax.x = rMax.x + x;
                    wbMax.y = rMax.y + y;
                    wbMax.z = rMax.z + z;

                    if (isDynamic) {
                        const r = sweptAABB(aabb, velocity, dt, wb);
                        if (r.collision) {
                            if (r.time < result.time) {
                                result.collision = true;
                                result.time = r.time;
                                const rn = r.normal;
                                result.normal.x = rn.x;
                                result.normal.y = rn.y;
                                result.normal.z = rn.z;
                            }
                            if (r.time < 1e-5) {
                                releasePooledBox(rotatedRelBox);
                                return result;
                            }
                        }
                    } else if (aabb.intersectsBox(wb)) {
                        releasePooledBox(rotatedRelBox);
                        return true;
                    }
                }
            }
        }
    }

    releasePooledBox(rotatedRelBox);
    return result;
}

function getTerrainHeight(worldX, worldZ) {
    const xInt = worldX | 0;
    const zInt = worldZ | 0;

    // --- 1. 高速キャッシュルックアップ ---
    // 文字列連結を避け、32bit整数にパッキングしてメモリと速度を最適化
    const key = ((xInt & 0xFFFF) << 16) | (zInt & 0xFFFF);
    const cached = terrainHeightCache.get(key);
    if (cached !== undefined) return cached;

    // --- 2. バイオーム決定 ---
    // 地形高さを決める前にバイオームが必要だが、バイオーム決定に高さが必要な矛盾を 
    // 第3引数に SEA_LEVEL (通常64) を渡すことで解決
    const temp = fractalNoise2D(xInt * 0.0005, zInt * 0.0005, 3) + 0.5;
    const humidity = fractalNoise2D(xInt * 0.0005 + 500, zInt * 0.0005 + 500, 3) + 0.5;
    const riverValue = fractalNoise2D(xInt * 0.005, zInt * 0.005, 2) + 0.5;

    // 暫定の高さ(64)を基準にバイオームを決定
    const biome = determineBiome(temp, humidity, 64, riverValue);

    // --- 3. 地形高さ計算 ---
    // バイオーム固有のノイズスケールと変動幅を適用
    const hNoise = fractalNoise2D(
        xInt * biome.noiseScale,
        zInt * biome.noiseScale,
        5
    );

    let result = (biome.baseHeight + hNoise * biome.heightVariation) | 0;

    // --- 4. 特殊バイオーム補正 ---
    // 川バイオームの場合は水面下になるよう調整
    if (biome.name === 'River') {
        // 元の地形が SEA_LEVEL-2 より高い場合のみ強制的に下げる
        const riverBed = (SEA_LEVEL - 2) | 0;
        if (result > riverBed) result = riverBed;
    }

    // --- 5. キャッシュ管理とGCスパイク対策 ---
    if (terrainHeightCache.size >= MAX_CACHE_SIZE) {
        // 一気に全部消すと処理が止まる（スパイク）ため、一部(500件)のみを削除
        const iter = terrainHeightCache.keys();
        for (let i = 0; i < 500; i = (i + 1) | 0) {
            const firstKey = iter.next().value;
            if (firstKey !== undefined) terrainHeightCache.delete(firstKey);
            else break;
        }
    }

    terrainHeightCache.set(key, result);
    return result;
}

function getVoxelHash(x, y, z) {
    const ox = (Math.floor(x) + 512) & 0x3FF; // 10ビット (0~1023)
    const oz = (Math.floor(z) + 512) & 0x3FF; // 10ビット (0~1023)
    const oy = Math.floor(y) & 0xFFF;          // 12ビット (0~4095)

    return (ox << 21) | (oz << 11) | oy;
}

// --- 関数の外側に配置 (キャッシュ用) ---
const chunkReadOnlyCache = new Map();
let _vC0_key = null, _vC0_data = null;
let _vC1_key = null, _vC1_data = null;

/**
 * ワールド座標からブロックデータを取得する (超高速・データ完全保持版)
 * @param {number} x, y, z - ワールド座標
 * @param {boolean} isRaw - true: メタデータ込み(16bit), false: IDのみ(12bit)
 */
export function getVoxelAtWorld(x, y, z, isRaw = false) {
    // 1. 高さの高速バリデーション
    // y < 0 || y >= 256 を 1つの演算でチェック (yが0-255以外なら真)
    const fy = y | 0;
    if (fy & ~255) return 0;

    const fx = x | 0;
    const fz = z | 0;

    // 2. チャンクキーの生成 (ビット演算を最小化)
    // cx, cz を経由せず直接計算
    const chunkKey = ((fx >> 4) << 16) | ((fz >> 4) & 0xFFFF);

    let data = null;

    // 3. キャッシュヒットパターンの最速化 (L0 -> L1)
    if (chunkKey === _vC0_key) {
        data = _vC0_data;
    } else if (chunkKey === _vC1_key) {
        data = _vC1_data;
        // ヒットした L1 を L0 に昇格 (MRU戦略)
        _vC1_key = _vC0_key; _vC1_data = _vC0_data;
        _vC0_key = chunkKey; _vC0_data = data;
    } else {
        // キャッシュミス時の重い処理
        data = ChunkSaveManager.modifiedChunks.get(chunkKey) || chunkReadOnlyCache.get(chunkKey);

        if (!data) {
            data = ChunkSaveManager.captureBaseChunkData(fx >> 4, fz >> 4);
            if (!data) return 0;

            chunkReadOnlyCache.set(chunkKey, data);
            if (chunkReadOnlyCache.size > MAX_CACHE_SIZE) {
                const firstKey = chunkReadOnlyCache.keys().next().value;
                chunkReadOnlyCache.delete(firstKey);
            }
        }

        // キャッシュ更新
        _vC1_key = _vC0_key; _vC1_data = _vC0_data;
        _vC0_key = chunkKey; _vC0_data = data;
    }

    // 4. インデックス計算の最適化
    const idx = (fy | ((fz & 0xF) << 8) | ((fx & 0xF) << 12)) | 0;
    const val = data[idx] | 0;
    return isRaw ? val : (val & 0xFFF);
}

// 定数は関数外で完全に固定（JITによるインライン化を促進）
const CAVE_SCALE_XZ = 0.02;
const CAVE_SCALE_Y = 0.025;
const CAVE_THRESHOLD = 0.08;

// オフセットも事前に「加算済み」の状態で保持
const OFF_X = 1234 * CAVE_SCALE_XZ;
const OFF_Y = 5678 * CAVE_SCALE_Y;
const OFF_Z = 9101 * CAVE_SCALE_XZ;

/**
 * 最適化された洞窟判定
 */
function isCave(x, y, z, surfaceHeight, nx, ny, nz) {
    // 1. 最速の足切り：地表以上なら即終了 (|0 は整数化による高速化)
    const depth = (surfaceHeight - y) | 0;
    if (depth <= 0) return false;

    // 2. 閾値計算の分岐最適化
    // 深さ5以上（大半のケース）では計算をスキップして定数を使用
    let currentThreshold = CAVE_THRESHOLD;
    if (depth < 5) {
        // 深さ 0〜4 の場合のみ計算を行う
        currentThreshold *= (depth * 0.16 + 0.6);
    }

    // 3. 1つ目のノイズ計算
    const n1 = perlinNoise3D(nx, ny, nz);

    // Math.abs を使うより、範囲比較の方がJIT最適化で有利な場合がある
    // abs(n1) < currentThreshold と同義
    if (n1 >= currentThreshold || n1 <= -currentThreshold) {
        return false;
    }

    // 4. 2つ目のノイズ計算
    // abs(n1) を再利用して、n2が満たすべき「残り余力」を算出
    const absN1 = n1 < 0 ? -n1 : n1;
    const remaining = currentThreshold - absN1;

    const n2 = perlinNoise3D(nx + OFF_X, ny + OFF_Y, nz + OFF_Z);

    // 最終判定：abs(n2) < remaining
    return n2 < remaining && n2 > -remaining;
}

const _headOffsets = [
    [0, 0, 0], [0.2, 0, 0], [-0.2, 0, 0],
    [0, 0, 0.2], [0, 0, -0.2], [0, 0.1, 0], [0, -0.1, 0]
];

// 💡 改善：ブロックIDは0〜4095に収まるため、Mapではなく固定長配列で管理。GC発生をゼロにする
const _headCounts = new Int8Array(4096);
const _usedIds = []; // リセット用にアクセスしたIDだけを記録

function getPreciseHeadBlockType(headPos) {
    let maxCount = 0;
    let chosenID = BLOCK_TYPES.SKY;

    for (let i = 0; i < _headOffsets.length; i++) {
        const o = _headOffsets[i];
        const bx = Math.floor(headPos.x + o[0]);
        const by = Math.floor(headPos.y + o[1]);
        const bz = Math.floor(headPos.z + o[2]);
        // 💡 isRaw を false にして ID のみ (12bit) を取得する
        const id = getVoxelAtWorld(bx, by, bz, false);

        if (_headCounts[id] === 0) {
            _usedIds.push(id);
        }
        _headCounts[id]++;

        if (_headCounts[id] > maxCount) {
            maxCount = _headCounts[id];
            chosenID = id;
        }
    }

    // 💡 Map.clear() の代わりに、変更した箇所だけを 0 に戻す（超高速）
    for (let i = 0; i < _usedIds.length; i++) {
        _headCounts[_usedIds[i]] = 0;
    }
    _usedIds.length = 0;

    return chosenID;
}

// 関数の外で一度だけ取得（キャッシュ）
const _sharedHeadPos = new THREE.Vector3();
const _screenOverlayEl = document.getElementById("screenOverlayHtml");

function updateScreenOverlay() {
    const headY = player.position.y + getCurrentPlayerHeight() * 0.85;
    _sharedHeadPos.set(player.position.x, headY, player.position.z);

    const voxelID = getPreciseHeadBlockType(_sharedHeadPos);
    const config = getBlockConfiguration(voxelID);
    const el = _screenOverlayEl; // キャッシュを使用

    // --- 🟢 判定ロジック ---
    const sf = config?.screenFill;
    const isEnabled = typeof sf === 'object' ? sf.enabled !== false : !!sf;
    const texturePath = config?.textures ? (config.textures.top || config.textures.all || config.textures.side) : null;

    if (!isEnabled || !texturePath) {
        if (el.style.display !== "none") {
            el.style.display = "none";
        }
        return;
    }

    // --- 🟢 透明度の決定 ---
    let finalOpacity = "1.0";
    if (typeof sf === 'object' && sf.opacity !== undefined) {
        finalOpacity = sf.opacity.toString();
    } else if (voxelID === BLOCK_TYPES.WATER) {
        finalOpacity = "0.5";
    }

    // --- 🟢 反映（Dirty Checking） ---
    // 1. 透明度
    if (el._lastOpacity !== finalOpacity) {
        el.style.opacity = finalOpacity;
        el._lastOpacity = finalOpacity;
    }

    // 2. 背景画像（パスが変わったときだけ結合してセット）
    if (el._lastPath !== texturePath) {
        el.style.backgroundImage = `url(${texturePath})`;
        el._lastPath = texturePath;
    }

    // 3. 表示状態
    if (el.style.display !== "block") {
        el.style.display = "block";
    }
}

/* ======================================================
   【Swept AABB 衝突検出】
   ====================================================== */
const _sweptNormal = new THREE.Vector3();

// スコープ外で再利用オブジェクトを定義
const _sweptResult = { collision: false, time: 0, normal: _sweptNormal };

function sweptAABB(movingBox, velocity, dt, staticBox) {
    _sweptResult.collision = false;

    const vx = velocity.x, vy = velocity.y, vz = velocity.z;
    const mMin = movingBox.min, mMax = movingBox.max;
    const sMin = staticBox.min, sMax = staticBox.max;

    const entry = _sweptTmpEntry;
    const exit = _sweptTmpExit;

    // X axis: 割り算を1回にして掛け算に変換
    if (vx !== 0) {
        const invVx = 1.0 / vx;
        if (vx > 0) {
            entry.x = (sMin.x - mMax.x) * invVx;
            exit.x = (sMax.x - mMin.x) * invVx;
        } else {
            entry.x = (sMax.x - mMin.x) * invVx;
            exit.x = (sMin.x - mMax.x) * invVx;
        }
    } else {
        entry.x = -1e9; exit.x = 1e9; // Infinityの代わりに大きな数
    }

    // Y axis
    if (vy !== 0) {
        const invVy = 1.0 / vy;
        if (vy > 0) {
            entry.y = (sMin.y - mMax.y) * invVy;
            exit.y = (sMax.y - mMin.y) * invVy;
        } else {
            entry.y = (sMax.y - mMin.y) * invVy;
            exit.y = (sMin.y - mMax.y) * invVy;
        }
    } else {
        entry.y = -1e9; exit.y = 1e9;
    }

    // Z axis
    if (vz !== 0) {
        const invVz = 1.0 / vz;
        if (vz > 0) {
            entry.z = (sMin.z - mMax.z) * invVz;
            exit.z = (sMax.z - mMin.z) * invVz;
        } else {
            entry.z = (sMax.z - mMin.z) * invVz;
            exit.z = (sMin.z - mMax.z) * invVz;
        }
    } else {
        entry.z = -1e9; exit.z = 1e9;
    }

    const entryTime = Math.max(entry.x, entry.y, entry.z);
    const exitTime = Math.min(exit.x, exit.y, exit.z);

    // 早期リターン
    if (entryTime > exitTime || (entry.x < 0 && entry.y < 0 && entry.z < 0) || entry.x > dt || entry.y > dt || entry.z > dt) {
        return _sweptResult;
    }

    // 法線の計算
    const normal = _sweptNormal;
    if (entryTime === entry.x) {
        normal.set((vx > 0) ? -1 : 1, 0, 0);
    } else if (entryTime === entry.y) {
        normal.set(0, (vy > 0) ? -1 : 1, 0);
    } else {
        normal.set(0, 0, (vz > 0) ? -1 : 1);
    }

    _sweptResult.collision = true;
    _sweptResult.time = entryTime < 0 ? 0 : entryTime;
    return _sweptResult;
}


/* ======================================================
【衝突解消（軸別：水平・垂直）】（安全移動調整）
※ Y 軸の衝突解決部分をバイナリサーチで補正するよう変更
====================================================== */

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
const COLLISION_DIRECTIONS = [
    new THREE.Vector3(0, 1, 0),  // 上（脱出優先度高）
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, -1, 0)  // 下
];
const _moveTempVec = new THREE.Vector3();
function resolvePlayerCollision() {
    axisSeparatedCollisionResolve(dt);

    // 💡 改善：現在のサイズを一度だけキャッシュ
    const size = {
        h: getCurrentPlayerHeight(),
        r: PLAYER_RADIUS - COLLISION_MARGIN
    };

    if (!checkAABBCollision(getPlayerAABB(player.position, size))) return;

    let bestDir = null;
    let bestDist = Infinity;

    for (let i = 0; i < COLLISION_DIRECTIONS.length; i++) {
        const dir = COLLISION_DIRECTIONS[i];
        let low = 0, high = 1.0;
        let foundDist = null;

        // 💡 改善：回数を 8回に絞っても精度（1/256）は十分
        for (let j = 0; j < 8; j++) {
            const mid = (low + high) * 0.5;
            _moveTempVec.copy(player.position).addScaledVector(dir, mid);

            if (!checkAABBCollision(getPlayerAABB(_moveTempVec, size))) {
                foundDist = mid;
                high = mid;
            } else {
                low = mid;
            }
        }

        if (foundDist !== null && foundDist < bestDist) {
            bestDist = foundDist;
            bestDir = dir;
            // 💡 改善：わずかな移動で済むなら、他の方向は調べず終了（早期リターン）
            if (bestDist < 0.01) break;
        }
    }

    if (bestDir) {
        player.position.addScaledVector(bestDir, bestDist);
    } else if (!wasUnderwater && !flightMode) {
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

    const MAX_STEP_HEIGHT = 0.6;
    const canStep = isOnGround && !flightMode;
    const SAFE_Y_OFFSET = 0.05;

    // --- 【ヘルパー】段差登り判定 ---
    function tryStepClimb(targetX, currentY, targetZ) {
        const stepResolutions = [0.0625, 0.125, 0.25, 0.5, MAX_STEP_HEIGHT];
        for (const step of stepResolutions) {
            const steppedPos = allocVec();
            steppedPos.set(targetX, currentY + step, targetZ);
            const isBlocked = checkAABBCollision(getPlayerAABBAt(steppedPos));
            freeVec(steppedPos);

            if (!isBlocked) return currentY + step;
        }
        return null;
    }

    let nextX = orig.x + vel.x * dt;
    let nextZ = orig.z + vel.z * dt;

    // --- 0. 斜め移動時の先行ステップ判定 (角対策) ---
    // XとZ両方に速度がある場合、個別に判定する前に「斜め上」をチェック
    let diagonalStepped = false;
    if (canStep && Math.abs(vel.x) > 0 && Math.abs(vel.z) > 0) {
        const diagPosNormal = allocVec().set(nextX, orig.y + SAFE_Y_OFFSET, nextZ);

        // 斜め移動先が詰まっている場合のみステップを試行
        if (checkAABBCollision(getPlayerAABBAt(diagPosNormal))) {
            const climbedY = tryStepClimb(nextX, orig.y, nextZ);
            if (climbedY !== null) {
                newPos.x = nextX;
                newPos.z = nextZ;
                newPos.y = climbedY;
                diagonalStepped = true;
            }
        }
        freeVec(diagPosNormal);
    }

    // --- 1. X軸移動 (斜めで解決済みの場合はスキップ) ---
    if (!diagonalStepped && Math.abs(vel.x) > 0) {
        const xPosNormal = allocVec().set(nextX, newPos.y + SAFE_Y_OFFSET, orig.z);
        let canMoveX = !checkAABBCollision(getPlayerAABBAt(xPosNormal));

        // 💡 改善：天井摩擦対策（オフセット付きで天井にぶつかる場合は、オフセットなしの本来の高さで再判定）
        if (!canMoveX) {
            xPosNormal.y = newPos.y;
            canMoveX = !checkAABBCollision(getPlayerAABBAt(xPosNormal));
            xPosNormal.y = newPos.y + SAFE_Y_OFFSET; // 元の高さに戻す
        }

        if (canMoveX) {
            if (sneakActive && isOnGround && !canDescendFromSupport(nextX, orig.z, halfWidth, margin)) {
                nextX = orig.x;
                vel.x = 0;
            }
            newPos.x = nextX;
        } else if (canStep) {
            const climbedY = tryStepClimb(nextX, newPos.y, orig.z);
            if (climbedY !== null) {
                newPos.x = nextX;
                newPos.y = climbedY;
            } else {
                newPos.x = orig.x;
                vel.x = 0;
            }
        } else {
            newPos.x = orig.x;
            vel.x = 0;
        }
        freeVec(xPosNormal);
    }

    // --- 2. Z軸移動 (斜めで解決済みの場合はスキップ) ---
    if (!diagonalStepped && Math.abs(vel.z) > 0) {
        const zPosNormal = allocVec().set(newPos.x, newPos.y + SAFE_Y_OFFSET, nextZ);
        let canMoveZ = !checkAABBCollision(getPlayerAABBAt(zPosNormal));

        // 💡 改善：天井摩擦対策（オフセット付きで天井にぶつかる場合は、オフセットなしの本来の高さで再判定）
        if (!canMoveZ) {
            zPosNormal.y = newPos.y;
            canMoveZ = !checkAABBCollision(getPlayerAABBAt(zPosNormal));
            zPosNormal.y = newPos.y + SAFE_Y_OFFSET; // 元の高さに戻す
        }

        if (canMoveZ) {
            if (sneakActive && isOnGround && !canDescendFromSupport(newPos.x, nextZ, halfWidth, margin)) {
                nextZ = orig.z;
                vel.z = 0;
            }
            newPos.z = nextZ;
        } else if (canStep) {
            const climbedY = tryStepClimb(newPos.x, newPos.y, nextZ);
            if (climbedY !== null) {
                newPos.z = nextZ;
                newPos.y = climbedY;
            } else {
                newPos.z = orig.z;
                vel.z = 0;
            }
        } else {
            newPos.z = orig.z;
            vel.z = 0;
        }
        freeVec(zPosNormal);
    }

    // --- 3. Y軸移動 (重力・垂直衝突) ---
    let finalY = newPos.y + vel.y * dt;
    const posY = allocVec().set(newPos.x, finalY, newPos.z);
    const isCollidingY = checkAABBCollision(getPlayerAABBAt(posY));

    if (sneakActive && !flightMode && vel.y <= 0) {
        const cannotFall = !canDescendFromSupport(newPos.x, newPos.z, halfWidth, margin);
        if (isOnGround && cannotFall) {
            finalY = newPos.y;
            vel.y = 0;
        } else if (isCollidingY) {
            finalY = resolveVerticalCollision(newPos.y, finalY, newPos.x, newPos.z);
            vel.y = 0;
        }
    } else if (isCollidingY) {
        if (vel.y > 0) {
            // 💡 改善：天井衝突時もバイナリサーチを使用し、頭が引っかからないギリギリ限界まで滑らかに上昇させる
            finalY = resolveVerticalCollision(newPos.y, finalY, newPos.x, newPos.z);
            vel.y = 0;
        } else {
            // 地面衝突
            if (typeof wasUnderwater !== 'undefined' && wasUnderwater) {
                finalY = newPos.y;
            } else {
                finalY = resolveVerticalCollision(newPos.y, finalY, newPos.x, newPos.z);
                vel.y = 0;
            }
        }
    }

    freeVec(posY);

    // 最終的な結果をプレイヤーに反映
    newPos.y = finalY;
    player.position.copy(newPos);
}

/**
 * 足元4隅に支え（安全に歩ける床）があるか判定。
 * 回転・反転ブロック（逆さ階段やハーフブロック等）の物理形状に対応。
 */
// 1. 関数の外で定義（メモリ確保を1回のみにする）
const SUPPORT_SIGNS = [1, 1, -1, 1, 1, -1, -1, -1];

function canDescendFromSupport(centerX, centerZ, halfWidth, margin) {
    const footY = player.position.y;
    const w = halfWidth - margin;
    const checkAABB = getPooledBox();

    try {
        // 2. ループを通常のforにし、オブジェクト生成を完全に排除
        for (let i = 0; i < 8; i += 2) {
            const checkX = centerX + (w * SUPPORT_SIGNS[i]);
            const checkZ = centerZ + (w * SUPPORT_SIGNS[i + 1]);

            // 3. 境界値計算
            checkAABB.min.set(checkX - 0.01, footY - 0.6, checkZ - 0.01);
            checkAABB.max.set(checkX + 0.01, footY + 0.05, checkZ + 0.01);

            if (checkAABBCollision(checkAABB)) {
                return true;
            }
        }
    } finally {
        releasePooledBox(checkAABB);
    }
    return false;
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


function isOnLadder() {
    const size = { h: getCurrentPlayerHeight(), r: PLAYER_RADIUS };
    const aabb = getPlayerAABB(player.position, size);
    aabb.expandByScalar(0.25);

    const minX = Math.floor(aabb.min.x);
    const maxX = Math.floor(aabb.max.x);
    const minY = Math.floor(aabb.min.y);
    const maxY = Math.floor(aabb.max.y);
    const minZ = Math.floor(aabb.min.z);
    const maxZ = Math.floor(aabb.max.z);

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {
                const voxel = getVoxelAtWorld(x, y, z, true);
                if ((voxel & 0xFFF) === BLOCK_TYPES.LADDER) {
                    // --- ここから追加：詳細な当たり判定チェック ---
                    const meta = (voxel >> 12) & 0xF;
                    const config = getBlockConfiguration(BLOCK_TYPES.LADDER);

                    // blocks.js で定義されている薄い Box (0, 0, 0 to 1, 1, 0.125) を取得
                    let boxes = config.customCollision ? config.customCollision() : [];

                    for (let box of boxes) {
                        // メタデータに基づいてハシゴの向き（北・南・東・西）を回転させる
                        // ※script.js内にある回転適用関数を利用
                        const rotatedBox = box.clone();
                        applyMetadataTransform(rotatedBox, meta, BLOCK_TYPES.LADDER);

                        // ワールド座標に変換
                        rotatedBox.min.add({ x, y, z });
                        rotatedBox.max.add({ x, y, z });

                        // プレイヤーが「実際にその薄い板」に触れているか判定
                        if (aabb.intersectsBox(rotatedBox)) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    return false;
}


// === 再利用ベクトル（スコープ外で1回だけ確保） ===
const _tmpDesiredVel = new THREE.Vector3();

/* ======================================================
   【物理更新：updateNormalPhysics】
   ====================================================== */
function updateNormalPhysics() {
    // 1. 基本スピードの決定
    let speed = dashActive ? normalDashMultiplier : playerSpeed();
    if (sneakActive) speed *= 0.3;

    // 2. 視点方向に基づいた「目標速度」を取得
    getDesiredHorizontalVelocity(speed);
    _tmpDesiredVel.copy(_vDesired);

    // 3. 加速感と方向転換のバランス調整
    // 地上ではレスポンスを重視（0.2）、空中ではダッシュの慣性を維持（0.05）
    let lerpFactor = player.onGround ? 0.2 : 0.05;

    // 4. 水平速度の更新（線形補間アルゴリズム）
    // 古い慣性を残しつつ、視点移動による新しい入力方向へスムーズに切り替える
    player.velocity.x += (_tmpDesiredVel.x - player.velocity.x) * lerpFactor;
    player.velocity.z += (_tmpDesiredVel.z - player.velocity.z) * lerpFactor;

    // 5. 停止・微小速度の処理
    const isMovingInput = _tmpDesiredVel.lengthSq() > 0.00001;
    if (!isMovingInput && player.onGround) {
        // 入力がない時は地上で素早く停止させる（慣性の引きずりを防止）
        player.velocity.x *= 1.0;
        player.velocity.z *= 1.0;
    }

    if (Math.abs(player.velocity.x) < 0.001) player.velocity.x = 0;
    if (Math.abs(player.velocity.z) < 0.001) player.velocity.z = 0;

    // 6. ハシゴの判定
    const onLadder = isOnLadder();

    if (onLadder) {
        player.velocity.y = 0; // 重力を相殺
        if (keys["w"] || keys["arrowup"] || keys[" "]) {
            player.velocity.y = 0.05;  // 上る
        } else if (keys["s"] || keys["arrowdown"]) {
            player.velocity.y = -0.05; // 下る
        } else if (sneakActive) {
            player.velocity.y = 0;    // スニーク停止
        } else {
            player.velocity.y = -0.05; // 緩やかな滑り落ち
        }
        jumpRequest = false; // ハシゴ中はジャンプ無効

    } else if (!flightMode) {
        // 7. 通常時の重力計算
        if (player.velocity.y >= 0) {
            player.velocity.y -= UP_DECEL;
        } else {
            player.velocity.y -= DOWN_ACCEL;
            if (player.velocity.y < MAX_FALL_SPEED) {
                player.velocity.y = MAX_FALL_SPEED;
            }
        }
    }

    // 8. ジャンプのクールダウンと実行
    if (jumpCooldown > 0) jumpCooldown--;

    if (jumpRequest && player.onGround && !flightMode && !wasUnderwater && jumpCooldown === 0 && !onLadder) {
        // 🌟 ダッシュジャンプの瞬間：
        // 水平速度に微量のボーナスを乗せ、空中の lerpFactor (0.05) でその勢いを維持
        if (dashActive) {
            player.velocity.x *= 1.1;
            player.velocity.z *= 1.1;
        }

        player.velocity.y = JUMP_INITIAL_SPEED;
        player.onGround = false;
        jumpRequest = false;
        jumpCooldown = 10;
    }
}

function playerSpeed() {
    return 0.08;
}

/* ======================================================
   【物理更新：飛行モード用】（重力無視・一定速度移動）
   ====================================================== */
function updateFlightPhysics() {
    // 1. 基本速度の設定
    let baseSpeed = playerSpeed();
    if (flightMode && !dashActive) {
        baseSpeed = 0.15; // 飛行中の巡航速度
    }
    const speed = dashActive ? flightDashMultiplier : baseSpeed;

    // 2. 水平方向の移動（初期版の 0.05 を維持して「ヌルッ」とさせる）
    const accel = flightMode ? 0.05 : 0.5;

    const desiredVel = getDesiredHorizontalVelocity(speed);
    _tmpDesiredVel.copy(desiredVel);

    player.velocity.x += (_tmpDesiredVel.x - player.velocity.x) * accel;
    player.velocity.z += (_tmpDesiredVel.z - player.velocity.z) * accel;

    // --- 3. 垂直移動（上下の速さを抑え、滑らかな余韻を出す） ---
    let targetVertical = 0;
    if (keys[" "] || keys["spacebar"]) {
        // flightSpeedに0.75を掛けて、上昇・下降の最高速度を少し制限
        targetVertical = flightSpeed * 0.75;
    } else if (keys["shift"] && flightMode) {
        targetVertical = -flightSpeed * 0.75;
    }

    // 加速度（Lerp係数）の動的切り替え
    // 停止時 (0.06): 水平移動(0.05)に近い、心地よい余韻で止まる
    // 入力時 (0.3): 出だしが速すぎず、かつモタつかないバランス
    const verticalAccel = (targetVertical === 0) ? 0.06 : 0.3;

    player.velocity.y += (targetVertical - player.velocity.y) * verticalAccel;
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

/**
 * チャンク（Mesh）とそのリソースを完全に破棄する
 * @param {THREE.Object3D|THREE.Mesh} mesh 破棄対象のオブジェクト
 */
function disposeMesh(mesh) {
    if (!mesh) return;

    // 1. 階層下の全オブジェクトを走査してリソースを解放
    mesh.traverse((obj) => {
        // メッシュ以外（Groupなど）はジオメトリを持たないためスキップ
        if (!obj.isMesh) return;

        // --- ジオメトリの破棄 ---
        // チャンクごとに生成される BufferGeometry はVRAM解放のため dispose が必須
        if (obj.geometry) {
            obj.geometry.dispose();
        }

        // --- マテリアルの破棄 ---
        if (obj.material) {
            // 🌟 一時的な配列 [obj.material] の生成を回避
            if (Array.isArray(obj.material)) {
                for (let i = 0; i < obj.material.length; i++) {
                    const mat = obj.material[i];
                    if (!mat) continue;
                    globalSkyUniforms.delete(mat);
                    if (mat.userData && mat.userData.originMat) {
                        mat.dispose();
                    }
                }
            } else {
                const mat = obj.material;
                globalSkyUniforms.delete(mat);
                if (mat.userData && mat.userData.originMat) {
                    mat.dispose();
                }
            }
        }
    });

    // 2. シーングラフからの完全な取り除き
    // 子要素を一つずつ安全に切り離す
    while (mesh.children.length > 0) {
        const child = mesh.children[0];
        // 再帰的に子要素の dispose を呼ぶ必要がある場合はここで検討
        mesh.remove(child);
    }

    // 3. 親要素からの切り離し
    if (mesh.parent) {
        mesh.parent.remove(mesh);
    }
}

/**
 * 指定された座標のチャンクを更新・リフレッシュする
 * @param {number} cx チャンクX座標
 * @param {number} cz チャンクZ座標
 */
function refreshChunkAt(cx, cz) {
    const key = encodeChunkKey(cx, cz); // 🌟 負の座標時のビット計算不整合を防ぎ、確実にキャッシュヒットさせる
    const oldChunk = loadedChunks.get(key);

    // 1. プレイヤーからの距離チェック
    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);
    const isOutOfRange = Math.abs(cx - pCx) > CHUNK_VISIBLE_DISTANCE ||
        Math.abs(cz - pCz) > CHUNK_VISIBLE_DISTANCE;

    if (isOutOfRange) {
        if (oldChunk) {
            // シーンからの削除とリソース解放を同時に行う
            disposeMesh(oldChunk);
            loadedChunks.delete(key);
        }
        return;
    }

    // 2. 新しいメッシュの生成
    const newChunk = generateChunkMeshMultiTexture(cx, cz);

    if (!newChunk) {
        // 空気チャンク、または生成に失敗した場合は古いチャンクを破棄
        if (oldChunk) {
            disposeMesh(oldChunk);
            loadedChunks.delete(key);
        }
        return;
    }

    // 3. 属性のセットアップ
    newChunk.userData.fadedIn = true;
    // スカイライトの同期（ここで globalSkyUniforms に登録される）
    syncSingleChunkSkyLight(newChunk);

    // 4. 入れ替え処理（チラつき防止のため「追加」してから「削除」）
    scene.add(newChunk);
    loadedChunks.set(key, newChunk);

    if (oldChunk) {
        // 古いチャンクをシーンから消し、GPUメモリと管理リスト(globalSkyUniforms)から解放
        disposeMesh(oldChunk);
    }
}

function encodeChunkKey(cx, cz) {
    return ((cx & 0xFFFF) << 16) | (cz & 0xFFFF);
}

const _sharedChunkCoord = { cx: 0, cz: 0 };

function decodeChunkKey(key, out = _sharedChunkCoord) {
    out.cx = (key >> 16);
    out.cz = (key << 16) >> 16;
    return out;
}

// ───────────────────────────────
// 更新要求用のバッチセットと処理（最適化完全版）
// ───────────────────────────────

// 内部管理用：Setを併用してキュー内の重複チェックを O(1) にする
let pendingChunkUpdates = new Set();
let chunkUpdateQueue = [];
let chunkUpdateLookup = new Set();
let chunkUpdateRunning = false;

// 静的定数・キャッシュ
const CHUNK_MAX_FRAME_TIME = 8;
const NEIGHBOR_OFFSETS = [
    [1, 0], [-1, 0], [0, 1], [0, -1]
];

/**
 * チャンク更新要求
 */
function requestChunkUpdate(cx, cz) {
    const key = encodeChunkKey(cx, cz);

    if (!chunkUpdateLookup.has(key)) {
        chunkUpdateLookup.add(key);
        chunkUpdateQueue.push(key); // 🌟 配列ではなく整数キーをそのまま保存しGC発生を回避
    }
    scheduleChunkUpdate();
}

/**
 * requestAnimationFrameから呼ばれるステップ実行
 * 既存の(function step(){...})()による毎回の関数生成を回避
 */
let chunkUpdateIdx = 0; // 外部スコープに保持

function stepChunkUpdate() {
    const start = performance.now();

    while (chunkUpdateIdx < chunkUpdateQueue.length) {
        const key = chunkUpdateQueue[chunkUpdateIdx];
        chunkUpdateIdx++; // ポインタを進めるだけ（超高速）

        chunkUpdateLookup.delete(key);
        const cx = key >> 16;
        const cz = (key << 16) >> 16;
        refreshChunkAt(cx, cz);

        if (performance.now() - start > CHUNK_MAX_FRAME_TIME) break;
    }

    // 終わったらリセット、残っていたら次回へ
    if (chunkUpdateIdx >= chunkUpdateQueue.length) {
        chunkUpdateQueue.length = 0;
        chunkUpdateIdx = 0;
        chunkUpdateRunning = false;
    } else {
        requestAnimationFrame(stepChunkUpdate);
    }
}

function scheduleChunkUpdate() {
    if (chunkUpdateRunning) return;
    chunkUpdateRunning = true;
    requestAnimationFrame(stepChunkUpdate);
}

// ==========================================
// 周辺の自動チャンク生成キュー (最適化完全版)
// ==========================================
let chunkQueueScheduled = false;

/**
 * チャンク生成メインループ
 * アルゴリズム：1フレームあたりの個数と時間を制限しつつ、距離チェックを行いながら生成
 */
function processChunkQueue(deadline) {
    const MAX_CHUNKS_PER_FRAME = 1;
    const FRAME_TIME_BUDGET = 10;
    const startTime = performance.now();
    let tasksProcessed = 0;

    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);

    // 💡 判定をループ外へ
    const isNoFade = (typeof CHUNK_VISIBLE_DISTANCE !== "undefined" && CHUNK_VISIBLE_DISTANCE === 0);

    while (
        chunkQueue.length > 0 &&
        tasksProcessed < MAX_CHUNKS_PER_FRAME &&
        (performance.now() - startTime) < FRAME_TIME_BUDGET
    ) {
        // 🌟 改善：オブジェクトではなく整数をpop
        const key = chunkQueue.pop();
        if (key === undefined) continue;

        // 🌟 改善：共有オブジェクトでデコード（GC発生ゼロ）
        decodeChunkKey(key, _sharedChunkCoord);
        const cx = _sharedChunkCoord.cx;
        const cz = _sharedChunkCoord.cz;

        const dx = Math.abs(cx - pCx);
        const dz = Math.abs(cz - pCz);
        if (dx > CHUNK_VISIBLE_DISTANCE || dz > CHUNK_VISIBLE_DISTANCE) continue;

        if (!loadedChunks.has(key)) {
            const mesh = generateChunkMeshMultiTexture(cx, cz);
            if (!mesh) {
                tasksProcessed++;
                continue;
            }

            syncSingleChunkSkyLight(mesh);

            if (isNoFade) {
                mesh.userData.fadedIn = true;
            } else {
                mesh.userData.fadedIn = false;
                setOpacityRecursive(mesh, 0);
            }

            scene.add(mesh);
            loadedChunks.set(key, mesh);

            // 🌟 改善：関数呼び出しを介さず、インラインで隣接チェック（配列アクセス回避）
            checkNeighborUpdate(cx + 1, cz);
            checkNeighborUpdate(cx - 1, cz);
            checkNeighborUpdate(cx, cz + 1);
            checkNeighborUpdate(cx, cz - 1);

            // フェード処理（ここでの匿名関数生成は、生成頻度が低いため許容範囲）
            fadeInMesh(mesh, 500, () => {
                mesh.userData.fadedIn = true;
                mesh.traverse(onMeshChildFinalize);
            });
        }
        tasksProcessed++;
    }

    if (chunkQueue.length > 0 && !chunkQueueScheduled) {
        chunkQueueScheduled = true;
        if (window.requestIdleCallback) {
            window.requestIdleCallback(onIdleCallbackHandle, { timeout: 1000 });
        } else {
            requestAnimationFrame(onAnimationFrameHandle);
        }
    }
}
function checkNeighborUpdate(ncx, ncz) {
    const nKey = ((ncx & 0xFFFF) << 16) | (ncz & 0xFFFF);
    if (loadedChunks.has(nKey)) {
        requestChunkUpdate(ncx, ncz);
    }
}

/**
 * 以下、コールバック用再利用関数（クロージャ生成防止）
 */
function onMeshChildFinalize(child) {
    if (child.isMesh && typeof child.userData.finalizeFade === "function") {
        child.userData.finalizeFade();
    }
}

function onIdleCallbackHandle() {
    chunkQueueScheduled = false;
    processChunkQueue();
}

function onAnimationFrameHandle() {
    chunkQueueScheduled = false;
    processChunkQueue();
}

// 💡 シェーダー変数の参照を一括管理して、毎フレームの重いメッシュ走査をゼロにする
const globalSkyUniforms = new Set();

function syncSingleChunkSkyLight(mesh) {
    if (!mesh) return;
    const currentSkyFactor = getSkyLightFactor(gameTime);

    mesh.traverse(child => {
        if (!child.isMesh || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];

        for (const m of mats) {
            if (!m) continue;

            // 💡 修正：Uniformの中身ではなく「マテリアル自体」を記録
            globalSkyUniforms.add(m);

            // 初回適用
            const uniforms = m.shaderUniforms || (m.userData && m.userData.shaderUniforms);
            if (uniforms && uniforms.u_skyFactor) {
                uniforms.u_skyFactor.value = currentSkyFactor;
            }
        }
    });
}

function updateGlobalSkyLight() {
    const currentSkyFactor = getSkyLightFactor(gameTime);

    // globalSkyUniforms は Set<Material> になっている前提
    for (const mat of globalSkyUniforms) {
        // 常に現在のマテリアルが保持している最新の参照を取得
        const uniforms = mat.shaderUniforms || (mat.userData && mat.userData.shaderUniforms);

        if (uniforms && uniforms.u_skyFactor) {
            uniforms.u_skyFactor.value = currentSkyFactor;
        }
    }
}

/* ======================================================
   【修正版】ライトの再計算 ＋ チャンクメッシュ構築
   ====================================================== */
function processPendingChunkUpdates() {
    if (pendingChunkUpdates.size === 0) return;

    const startTime = performance.now();
    const FRAME_BUDGET = 4.0; // 予算 4.0ms

    // 💡 values().next() を使い、Set の先頭から1つずつ確実に「取り出して」処理する
    for (const key of pendingChunkUpdates) {
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
function fadeInMesh(object, duration = 500, onComplete) {
    if (object.userData.fadedIn) return onComplete?.();

    let materials = [];
    object.traverse(o => {
        if (!o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (let i = 0; i < mats.length; i++) {
            const mat = mats[i];
            if (!mat) continue;

            const uData = mat.userData || {};
            const targetOpacity = uData.realOpacity !== undefined ? uData.realOpacity : 1.0;

            materials.push({
                mat: mat,
                targetOpacity: targetOpacity,
                isWater: !!uData.isWater,
                isAlphaCutout: !!uData.isAlphaCutout,
                finalTransparent: uData.realTransparent !== undefined ? uData.realTransparent : mat.transparent,
                finalDepthWrite: uData.realDepthWrite !== undefined ? uData.realDepthWrite : mat.depthWrite
            });

            // 初期状態：透明にして描画順序を調整
            mat.opacity = 0;
            mat.transparent = true;
            mat.depthWrite = false;
            mat.needsUpdate = true;
        }
    });

    // 💡 完了・中止時のクリーンアップ処理
    const cleanup = () => {
        materials = []; // 配列を空にして参照を切り離す
        onComplete = null; // コールバックの参照を消す
    };

    const finalize = () => {
        for (let i = 0; i < materials.length; i++) {
            const m = materials[i];
            if (!m.mat) continue;
            m.mat.opacity = m.targetOpacity;
            m.mat.transparent = m.finalTransparent;
            m.mat.depthWrite = m.finalDepthWrite;
            if (m.isAlphaCutout) m.mat.alphaTest = 0.5;
            m.mat.needsUpdate = true;
        }
        object.userData.fadedIn = true;
        onComplete?.();
        cleanup();
    };

    // マテリアルがない、または設定でアニメーション不要な場合
    if (materials.length === 0 || (typeof CHUNK_VISIBLE_DISTANCE !== "undefined" && CHUNK_VISIBLE_DISTANCE === 0)) {
        finalize();
        return;
    }

    const start = performance.now();
    const invDuration = 1 / duration;

    let requestID;
    const animate = (now) => {
        // ★重要：オブジェクトがシーンから消えた、または破棄されたらループ停止
        if (!object.parent) {
            cancelAnimationFrame(requestID);
            cleanup();
            return;
        }

        const elapsed = now - start;
        const t = Math.min(elapsed * invDuration, 1); // 1を超えないようガード

        for (let i = 0, len = materials.length; i < len; i++) {
            const m = materials[i];
            if (!m.mat) continue;
            // 水の場合はターゲット不透明度を考慮してブレンド
            m.mat.opacity = m.isWater ? (t * m.targetOpacity) : t;
        }

        if (t < 1) {
            requestID = requestAnimationFrame(animate);
        } else {
            finalize();
        }
    };

    requestID = requestAnimationFrame(animate);
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

        // 1. ジオメトリは常に破棄
        if (obj.geometry) {
            obj.geometry.dispose();
            obj.geometry = null;
        }

        // 2. マテリアルの処理
        if (obj.material) {
            // 配列（マルチマテリアル）の場合も考慮
            const materials = Array.isArray(obj.material) ? obj.material : [obj.material];

            for (const mat of materials) {
                // userData等に「これは共有マテリアルか？」のフラグを持たせておくと安全
                // もしくは、生成時に clone() したものはここで必ず dispose() する
                if (mat.userData && mat.userData.isShared) {
                    // 共有マテリアルなら何もしない
                } else {
                    mat.dispose(); // クローンされたマテリアルは破棄！
                }
            }
            obj.material = null;
        }
    });

    chunkPool.push(mesh);
}

// ---------------------------------------------------------------------------
// mergeBufferGeometries: 複数の BufferGeometry を統合する関数（vertex color属性もマージ）
// ---------------------------------------------------------------------------
// 💡 ファイルスコープで1度だけ作成して使い回す（GCを発生させない）
const _SHARED_ZERO_NORMAL = new Float32Array([0, 0, 0]);
const _SHARED_ZERO_UV = new Float32Array([0, 0]);
const _SHARED_ZERO_COLOR = new Float32Array([1, 1, 1]);

function mergeBufferGeometries(geometries, { computeNormals = true } = {}) {
    if (!geometries || geometries.length === 0) return null;
    if (geometries.length === 1) return geometries[0];

    const first = geometries[0];
    // .attributes を直接参照することでメソッド呼び出しを減らす
    const hasNormal = first.attributes['normal'] !== undefined;
    const hasUV = first.attributes['uv'] !== undefined;
    const hasColor = first.attributes['color'] !== undefined;

    // 1. 合計頂点数／インデックス数を一括算出
    let vertexCount = 0;
    let indexCount = 0;
    for (let i = 0, l = geometries.length; i < l; i++) {
        const g = geometries[i];
        const p = g.attributes['position'];
        if (!p) continue;
        vertexCount += p.count;
        indexCount += g.index ? g.index.count : p.count;
    }

    if (vertexCount === 0) return null;

    // 2. バッファの確保
    const IndexArray = (vertexCount > 65535 || indexCount > 65535) ? Uint32Array : Uint16Array;

    const posArray = new Float32Array(vertexCount * 3);
    const normArray = hasNormal ? new Float32Array(vertexCount * 3) : null;
    const uvArray = hasUV ? new Float32Array(vertexCount * 2) : null;
    const colorArray = hasColor ? new Float32Array(vertexCount * 3) : null;
    const indexArray = new IndexArray(indexCount);

    let posOff = 0, normOff = 0, uvOff = 0, colorOff = 0, idxOff = 0, vertOff = 0;
    const groups = [];

    // 3. データの流し込み
    for (let i = 0, l = geometries.length; i < l; i++) {
        const g = geometries[i];
        const attr = g.attributes;
        const p = attr['position'];
        if (!p) continue;

        const count = p.count;

        // --- Position コピー ---
        posArray.set(p.array, posOff);
        posOff += p.array.length;

        // --- Normal 補完コピー ---
        if (hasNormal) {
            const n = attr['normal'];
            if (n && n.array) {
                normArray.set(n.array, normOff);
                normOff += n.array.length;
            } else {
                const len = count * 3;
                // JSのループを使わず、C++レベルで高速にゼロ埋め
                normArray.fill(0, normOff, normOff + len);
                normOff += len;
            }
        }

        // --- UV 補完コピー ---
        if (hasUV) {
            const uv = attr['uv'];
            if (uv && uv.array) {
                uvArray.set(uv.array, uvOff);
                uvOff += uv.array.length;
            } else {
                const len = count * 2;
                uvArray.fill(0, uvOff, uvOff + len);
                uvOff += len;
            }
        }

        // --- Color 補完コピー ---
        if (hasColor) {
            const c = attr['color'];
            if (c && c.array) {
                colorArray.set(c.array, colorOff);
                colorOff += c.array.length;
            } else {
                const len = count * 3;
                // 色がない場合は白(1.0)で埋める
                colorArray.fill(1, colorOff, colorOff + len);
                colorOff += len;
            }
        }

        // --- Index の計算 (ここはオフセット加算が必要なためループが必要) ---
        const idx = g.index ? g.index.array : null;
        const startIdxOff = idxOff;
        if (idx) {
            for (let j = 0, len = idx.length; j < len; j++) {
                indexArray[idxOff++] = idx[j] + vertOff;
            }
        } else {
            for (let j = 0; j < count; j++) {
                indexArray[idxOff++] = vertOff + j;
            }
        }

        // --- マテリアルグループの継承 ---
        const gIdxCount = idx ? idx.length : count;
        if (g.groups && g.groups.length > 0) {
            for (let j = 0, gl = g.groups.length; j < gl; j++) {
                const gr = g.groups[j];
                groups.push({
                    start: startIdxOff + gr.start,
                    count: gr.count,
                    materialIndex: gr.materialIndex
                });
            }
        } else {
            groups.push({
                start: startIdxOff,
                count: gIdxCount,
                materialIndex: 0
            });
        }

        vertOff += count;
    }

    // 4. 最終的なジオメトリの構築
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    if (hasNormal) merged.setAttribute('normal', new THREE.BufferAttribute(normArray, 3));
    if (hasUV) merged.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
    if (hasColor) merged.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    merged.setIndex(new THREE.BufferAttribute(indexArray, 1));

    // まとめてグループを追加
    for (let i = 0, l = groups.length; i < l; i++) {
        merged.addGroup(groups[i].start, groups[i].count, groups[i].materialIndex);
    }

    if (computeNormals && !hasNormal) merged.computeVertexNormals();

    return merged;
}
// ---------------------------------------------------------------------------
// getCachedFaceGeometry: faceKey に対応するクワッドジオメトリをキャッシュして返す
// ---------------------------------------------------------------------------
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
const CS = CHUNK_SIZE;
const CH = CHUNK_HEIGHT;
const CS_CH = CS * CH; // 4096
const TOTAL_CELLS = CS * CH * CS; // 65536
const _localLightCoord = { cx: 0, cz: 0 };
// 1次元配列上のオフセット [+X, -X, +Y, -Y, +Z, -Z]
const MOVE_OFFSETS = new Int32Array([CS_CH, -CS_CH, 1, -1, CH, -CH]);

const _sharedQueue = new Int32Array(TOTAL_CELLS);
/* ======================================================
   【新・2系統ライトマップ用のビット演算ユーティリティ】
   ====================================================== */
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
                const type = voxelData[idx] & 0xFFF;

                // 🌟 空気(0)以外のブロックを通るときの光の減衰
                if (currentSky > 0 && type !== 0) {
                    const cfg = _blockConfigFastArray[type];
                    if (!cfg || !cfg.transparent) {
                        currentSky = 0; // 不透明ブロックは光を完全に遮断
                    } else {
                        // 透過ブロックの場合は固有の減衰量を引く
                        currentSky -= (cfg.lightOpacity !== undefined ? cfg.lightOpacity : 1);
                        if (currentSky < 0) currentSky = 0;
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

                if (nSky > 1) {
                    const type = voxelData[idx] & 0xFFF;
                    const cfg = _blockConfigFastArray[type];

                    if (type === 0 || (cfg && cfg.transparent)) {
                        // 🌟 流入時の減衰計算
                        const opacity = type === 0 ? 0 : (cfg.lightOpacity !== undefined ? cfg.lightOpacity : 1);
                        const nextSky = nSky - 1 - opacity;

                        if (nextSky > mySky) {
                            lightData[idx] = ((nextSky << 4) | (lightData[idx] & 15)) | 0;
                            queue[tail++] = idx;
                        }
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

                    const nt = nv[nIdx] & 0xFFF;
                    const nCfg = _blockConfigFastArray[nt];

                    if (nt === 0 || (nCfg && nCfg.transparent)) {
                        // 🌟 隣接チャンクへの伝播時の減衰計算
                        const opacity = nt === 0 ? 0 : (nCfg.lightOpacity !== undefined ? nCfg.lightOpacity : 1);
                        const nextSky = skyLight - 1 - opacity;

                        if (nextSky > ((nm[nIdx] >> 4) & 15)) {
                            nm[nIdx] = ((nextSky << 4) | (nm[nIdx] & 15)) | 0;
                            pendingChunkUpdates.add(nKeys[i]);
                        }
                    }
                }
                continue;
            }

            const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
            const nt = voxelData[nIdx] & 0xFFF;
            const nCfg = _blockConfigFastArray[nt];

            if (nt === 0 || (nCfg && nCfg.transparent)) {
                // 🌟 同一チャンク内への伝播時の減衰計算
                const opacity = nt === 0 ? 0 : (nCfg.lightOpacity !== undefined ? nCfg.lightOpacity : 1);
                const nextSky = skyLight - 1 - opacity;

                if (nextSky > ((lightData[nIdx] >> 4) & 15)) {
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
        const type = voxelData[i] & 0xFFF;
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

                if (nBlock > 1) {
                    const type = voxelData[idx] & 0xFFF;
                    const cfg = _blockConfigFastArray[type];

                    if (type === 0 || (cfg && cfg.transparent)) {
                        // 🌟 ブロック光流入時の減衰計算
                        const opacity = type === 0 ? 0 : (cfg.lightOpacity !== undefined ? cfg.lightOpacity : 1);
                        const nextBlock = nBlock - 1 - opacity;

                        if (nextBlock > myBlock) {
                            lightData[idx] = ((lightData[idx] & 240) | nextBlock) | 0;
                            queue[tail++] = idx;
                        }
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

                    const nt = nv[nIdx] & 0xFFF;
                    const nCfg = _blockConfigFastArray[nt];

                    if (nt === 0 || (nCfg && nCfg.transparent)) {
                        // 🌟 隣接チャンクへのブロック光伝播時の減衰計算
                        const opacity = nt === 0 ? 0 : (nCfg.lightOpacity !== undefined ? nCfg.lightOpacity : 1);
                        const nextBlock = blockLight - 1 - opacity;

                        if (nextBlock > (nm[nIdx] & 15)) {
                            nm[nIdx] = ((nm[nIdx] & 240) | nextBlock) | 0;
                            pendingChunkUpdates.add(nKeys[i]);
                        }
                    }
                }
                continue;
            }

            const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
            const nt = voxelData[nIdx] & 0xFFF;
            const nCfg = _blockConfigFastArray[nt];

            if (nt === 0 || (nCfg && nCfg.transparent)) {
                // 🌟 同一チャンク内へのブロック光伝播時の減衰計算
                const opacity = nt === 0 ? 0 : (nCfg.lightOpacity !== undefined ? nCfg.lightOpacity : 1);
                const nextBlock = blockLight - 1 - opacity;

                if (nextBlock > (lightData[nIdx] & 15)) {
                    lightData[nIdx] = ((lightData[nIdx] & 240) | nextBlock) | 0;
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
        transparent: true, // フェードインさせるため、常にtrueにするか、アニメーション中だけtrueにする
        opacity: baseMat ? baseMat.opacity : 1.0,
        vertexColors: true,
        side: (isCross || isWater) ? THREE.DoubleSide : THREE.FrontSide,

        // 💡 修正: 常に奥行きを書き込むように変更
        depthWrite: true,

        // 植物やガラスなどの抜きを維持
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
// 💡 立方体の基本頂点データ（クローンを廃止して直書きするための定数）
// =======================================================
const FACE_FW = new Float32Array([0.8, 0.8, 1.0, 0.5, 0.65, 0.65]);

// 💡 配列の配列を廃止し、1本の平坦な Int8Array に統合（変数名は維持）
// アクセス時は faceIndex * 12 をオフセットとして使用します
const CUBE_VERTICES = new Int8Array([
    1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, // 0: px
    0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, // 1: nx
    0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, // 2: py
    0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, // 3: ny
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // 4: pz
    1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0  // 5: nz
]);

const CUBE_NORMALS = new Int8Array([
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,   // 0: px
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, // 1: nx
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,   // 2: py
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, // 3: ny
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,   // 4: pz
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1  // 5: nz
]);

const CUBE_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const _globalVisCache = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);

// blocks.js の lookup テーブルから、ID を添字とした平坦な配列を事前に作っておく
const _blockConfigFastArray = new Array(256).fill(null);
for (let i = 0; i < 256; i++) {
    _blockConfigFastArray[i] = getBlockConfiguration(i);
}

const _sharedVec3Zero = new THREE.Vector3(0, 0, 0);

// 💡 2つの配列をビット演算で1つに統合してメモリ参照を半減させる
// 変数名と役割を維持するために内部でビットフラグ化
const _isTransparentBlock = new Uint8Array(256);
const _isCustomGeometryBlock = new Uint8Array(256);

for (let id = 0; id < 256; id++) {
    const cfg = _blockConfigFastArray[id];
    if (cfg) {
        _isTransparentBlock[id] = cfg.transparent ? 1 : 0;
        _isCustomGeometryBlock[id] = (cfg.customGeometry || cfg.geometryType !== 'cube') ? 1 : 0;
    }
}

// --- [最適化用] 関数の外で再利用する一時オブジェクト ---
const _v1 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _r1 = new THREE.Matrix4();
const _dirVectors = [
    new THREE.Vector3(1, 0, 0),  // 0: px
    new THREE.Vector3(-1, 0, 0), // 1: nx
    new THREE.Vector3(0, 1, 0),  // 2: py
    new THREE.Vector3(0, -1, 0), // 3: ny
    new THREE.Vector3(0, 0, 1),  // 4: pz
    new THREE.Vector3(0, 0, -1)  // 5: nz
];
const CH_H = CHUNK_HEIGHT;
const CH_S = CHUNK_SIZE;
const STRIDE_Z = CH_H;
const STRIDE_X = CH_H * CH_S;
const SKY = BLOCK_TYPES.SKY;
// 計算用の一時変数（GC対策：これらを再利用する）
const _mTemp = new THREE.Matrix4();

function generateChunkMeshMultiTexture(cx, cz, useInstancing = false) {

    const createBatch = () => ({
        pos: new Float32Array(12000),
        col: new Float32Array(12000),
        norm: new Float32Array(12000),
        uv: new Float32Array(8000),
        ptr: 0,   // pos, col, norm 用の書き込み位置
        uvPtr: 0, // uv 用の書き込み位置

        // 容量が足りない場合に動的に拡張するメソッド
        ensureCapacity(neededPos, neededUv) {
            if (this.ptr + neededPos > this.pos.length || this.uvPtr + neededUv > this.uv.length) {
                // 現在のサイズの2倍、または必要なサイズ分を確保
                const newSize = Math.max(this.pos.length * 2, this.ptr + neededPos + 1200);
                const newUvSize = Math.max(this.uv.length * 2, this.uvPtr + neededUv + 800);

                const newPos = new Float32Array(newSize);
                const newCol = new Float32Array(newSize);
                const newNorm = new Float32Array(newSize);
                const newUv = new Float32Array(newUvSize);

                // 既存データのコピー
                newPos.set(this.pos);
                newCol.set(this.col);
                newNorm.set(this.norm);
                newUv.set(this.uv);

                this.pos = newPos;
                this.col = newCol;
                this.norm = newNorm;
                this.uv = newUv;
            }
        }
    });

    const currentSkyLight = (typeof getSkyLightFactor === "function" && typeof gameTime !== "undefined")
        ? (Math.floor(15 * getSkyLightFactor(gameTime)) << 4) : 15;

    const baseX = cx * CH_S, baseZ = cz * CH_S;
    const container = new THREE.Object3D();

    const chunkKey = encodeChunkKey(cx, cz);
    let voxelData = ChunkSaveManager.modifiedChunks.get(chunkKey);
    let isNewChunk = false;

    if (!voxelData) {
        voxelData = ChunkSaveManager.captureBaseChunkData(cx, cz);
        isNewChunk = true;
    }

    // --- 隣接チャンクデータを関数内で取得 ---
    const neighborData = {
        px: ChunkSaveManager.modifiedChunks.get(encodeChunkKey(cx + 1, cz)),
        nx: ChunkSaveManager.modifiedChunks.get(encodeChunkKey(cx - 1, cz)),
        pz: ChunkSaveManager.modifiedChunks.get(encodeChunkKey(cx, cz + 1)),
        nz: ChunkSaveManager.modifiedChunks.get(encodeChunkKey(cx, cz - 1))
    };

    // --- データアクセス・ヘルパー ---
    // 関数冒頭で参照をローカル変数に固定（プロパティアクセスのコスト削減）
    const vpx = neighborData.px, vnx = neighborData.nx, vpz = neighborData.pz, vnz = neighborData.nz;

    function get(x, y, z) {
        if (y < 0 || y >= CH_H) return 0; // SKYは0と仮定

        // 1. チャンク内 (ビット演算で範囲チェック)
        // (x | z) & ~15 が 0 でなければ、xかzが 0〜15 の範囲外
        if (((x | z) & ~15) === 0) {
            return voxelData[y + (z << 8) + (x << 12)] & 0xFFF;
        }

        // 2. 隣接チャンク (直接変数から取得)
        let nData = null;
        let lx = x, lz = z;

        if (x >= 16) { nData = vpx; lx = 0; }
        else if (x < 0) { nData = vnx; lx = 15; }
        else if (z >= 16) { nData = vpz; lz = 0; }
        else if (z < 0) { nData = vnz; lz = 15; }

        if (nData) return nData[y + (lz << 8) + (lx << 12)] & 0xFFF;

        // 3. 最終手段
        return getVoxelAtWorld(baseX + x, BEDROCK_LEVEL + y, baseZ + z, true) & 0xFFF;
    }

    let lightMap = chunkLightCache.get(chunkKey);
    if (!lightMap || isNewChunk) {
        lightMap = generateChunkLightMap(chunkKey, voxelData);
    }

    const lmPX = chunkLightCache.get(encodeChunkKey(cx + 1, cz));
    const lmNX = chunkLightCache.get(encodeChunkKey(cx - 1, cz));
    const lmPZ = chunkLightCache.get(encodeChunkKey(cx, cz + 1));
    const lmNZ = chunkLightCache.get(encodeChunkKey(cx, cz - 1));
    const CH_H_L = CH_H;

    function getLightLevel(lx, ly, lz) {
        // Y方向の境界チェック（最も頻繁にヒットする可能性が高いものを先に）
        if (ly < 0) return 0;
        if (ly >= CH_H_L) return 15;

        // 2. チャンク内 (0-15) かどうかの高速判定
        // (lx | lz) & ~15 は、lx か lz が 0-15 の範囲外（負数を含む）なら 0 以外を返す
        if (((lx | lz) & ~15) === 0) {
            return lightMap[ly + CH_H_L * (lz + (lx << 4))];
        }

        // 3. チャンク外（隣接チャンク）の判定
        // 三項演算子の連鎖は、if-else 文よりも JIT コンパイラが最適化しやすい傾向にある
        const nlMap = (lx < 0) ? lmNX :
            (lx > 15) ? lmPX :
                (lz < 0) ? lmNZ :
                    (lz > 15) ? lmPZ : null;

        if (nlMap) {
            // ビット演算 & 15 を使い、lx, lz を 0-15 に正規化してインデックスを計算
            return nlMap[ly + CH_H_L * ((lz & 15) + ((lx & 15) << 4))];
        }

        // 隣接データがない場合は現在の空の明るさを返す
        return currentSkyLight;
    }

    function getVisMask(x, y, z, type, index) {
        // 1. キャッシュチェック（最優先）
        const cached = _globalVisCache[index];
        if (cached !== 0) return cached;

        // 自分の属性を事前に一度だけ取得（ここが軽量化のポイント）
        const myIsOpaque = _isOpaqueBlock[type] === 1;
        const myCfg = _blockConfigFastArray[type];
        const cullSame = (myCfg !== undefined && myCfg.cullAdjacentFaces === true);

        // 境界判定用の定数を計算
        const S_MAX = CH_S - 1;
        const H_MAX = CH_H - 1;

        let mask = 0;
        const check = (nRaw) => {
            const nType = nRaw & 0xFFF;

            // [1] 隣が空気なら必ず表示
            if (nType === 0) return 1;

            // [2] 隣が不透明フルブロックなら絶対に隠れる
            if (_isOpaqueBlock[nType] === 1) return 0;

            // [3] 自分が不透明なら、隣が透過（確定）なので表示
            if (myIsOpaque) return 1;

            // [4] 透過ブロック同士の特殊判定（ガラスなど）
            if (cullSame) {
                return (nType !== type) ? 1 : 0;
            }

            // 階段、草などは表示
            return 1;
        };

        // --- 各方向の判定（三項演算子とビット演算で高速化） ---
        // PX (+X: 1)
        if (check((x < S_MAX) ? voxelData[index + STRIDE_X] : get(x + 1, y, z))) mask |= 1;

        // NX (-X: 2)
        if (check((x > 0) ? voxelData[index - STRIDE_X] : get(x - 1, y, z))) mask |= 2;

        // PY (+Y: 4)
        if (check((y < H_MAX) ? voxelData[index + 1] : get(x, y + 1, z))) mask |= 4;

        // NY (-Y: 8)
        if (check((y > 0) ? voxelData[index - 1] : get(x, y - 1, z))) mask |= 8;

        // PZ (+Z: 16)
        if (check((z < S_MAX) ? voxelData[index + STRIDE_Z] : get(x, y, z + 1))) mask |= 16;

        // NZ (-Z: 32)
        if (check((z > 0) ? voxelData[index - STRIDE_Z] : get(x, y, z - 1))) mask |= 32;

        // 結果をキャッシュして返す
        return (_globalVisCache[index] = mask);
    }

    let hasAnySolidBlock = false;
    let effectiveMaxY = voxelData.maxY !== undefined ? voxelData.maxY : CHUNK_HEIGHT - 1;
    const maxIndex = (effectiveMaxY + 2) * STRIDE_Z * STRIDE_X;
    _globalVisCache.fill(0, 0, Math.min(maxIndex, _globalVisCache.length));
    const customGeomCache = new Map(), customGeomBatches = new Map(), materialBatches = new Map();

    // --- 走査ループ (最適化版) ---
    for (let x = 0; x < CHUNK_SIZE; x++) {
        const wx = baseX + x; // ループ外へ
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const wz = baseZ + z; // ループ外へ
            const columnIndex = CHUNK_HEIGHT * (z + CHUNK_SIZE * x);

            for (let y = effectiveMaxY; y >= 0; y--) {
                const currentIdx = columnIndex + y;
                const rawData = voxelData[currentIdx];
                const type = rawData & 0xFFF;
                if (type === BLOCK_TYPES.SKY) continue;

                hasAnySolidBlock = true;
                const cfg = _blockConfigFastArray[type];
                if (!cfg) continue;

                const meta = (rawData >> 12) & 0xF;
                const wy = BEDROCK_LEVEL + y;
                const visMask = getVisMask(x, y, z, type, currentIdx);

                // --- A. カスタムジオメトリ ---
                if (_isCustomGeometryBlock[type]) {

                    // 1. フェンスの場合、動的に接続マスクを計算する
                    let currentMeta = meta;
                    if (cfg.geometryType === "fence") {
                        currentMeta = getFenceConnectionMask(wx, wy, wz);
                    }
                    if (cfg.geometryType === "pane") {
                        currentMeta = getPaneConnectionMask(wx, wy, wz);
                    }

                    // 2. キーを生成 (文字列を使わず、typeとmetaを合体させる)
                    // typeが12bitなら、4bit分ずらしてmeta(0-15)を格納
                    const cacheKey = (type << 4) | (currentMeta & 0xF);

                    // ★修正: cacheKey を使ってチェック
                    if (!customGeomCache.has(cacheKey)) {
                        // ★修正: 第3引数に null ではなく currentMeta を渡す
                        const m = createCustomBlockMesh(type, _sharedVec3Zero, currentMeta);
                        if (m) {
                            customGeomCache.set(cacheKey, m.geometry);
                        }
                    }

                    // ★修正: cacheKey を使って取得
                    const template = customGeomCache.get(cacheKey);

                    if (!template || (!visMask && cfg.cullAdjacentFaces !== false)) continue;

                    // --- 以降、マテリアル取得などの処理 ---
                    const allMats = getBlockMaterials(+type) || [];

                    for (let g = 0; g < template.groups.length; g++) {
                        const group = template.groups[g];
                        const dir = detectFaceDirection(template, group);
                        const isLadder = cfg.isLadder;

                        if (!isLadder && cfg.cullAdjacentFaces !== false && ((visMask >> dir) & 1) === 0) continue;

                        // ★最重要: 面(group)ごとに正しいマテリアルを取得する
                        const targetMat = allMats[group.materialIndex] || allMats[0];
                        if (!targetMat) continue;

                        // 【新機能】セクション5で水かどうかを判定できるよう情報を付与
                        targetMat.userData.isWater = (type === BLOCK_TYPES.WATER || cfg.isWater === true);
                        targetMat.userData.isGlass = (type === BLOCK_TYPES.GLASS);

                        // ★修正: 数値(type)ではなく、マテリアル(targetMat)をキーにしてバッチング
                        let batchArray = customGeomBatches.get(targetMat);
                        if (batchArray === undefined) {
                            batchArray = [];
                            customGeomBatches.set(targetMat, batchArray);
                        }

                        const subGeo = new THREE.BufferGeometry();
                        extractGroupGeometry(template, group, subGeo);

                        // 💡 【追加】上下反転時に側面のテクスチャ(UV)が逆さまになるのを補正
                        const isUpsideDown = (meta >> 2) & 1;
                        if (isUpsideDown) {
                            const uvs = subGeo.attributes.uv.array;
                            const normals = subGeo.attributes.normal.array;
                            for (let i = 0; i < uvs.length; i += 2) {
                                const ny = normals[(i / 2) * 3 + 1];
                                // 側面（法線のY成分がほぼ0）の場合にV座標を反転
                                if (Math.abs(ny) < 0.1) {
                                    uvs[i] = 1.0 - uvs[i];
                                    uvs[i + 1] = 1.0 - uvs[i + 1];
                                }
                            }
                        }

                        // --- 座標変換・ライティング処理 (既存のまま) ---
                        getCustomGeometryMatrix(meta, _m1, _r1, _mTemp);
                        _v1.copy(_dirVectors[dir]).applyMatrix4(_r1);
                        const wdx = Math.round(_v1.x), wdy = Math.round(_v1.y), wdz = Math.round(_v1.z);

                        let fw = 1.0;
                        if (cfg.geometryType !== "cross") {
                            if (wdy > 0.5) fw = 1.0;
                            else if (wdy < -0.5) fw = 0.5;
                            else if (Math.abs(wdz) > 0.5) fw = 0.65;
                            else fw = 0.8;
                        }

                        const light = (cfg.geometryType === "cross" || isLadder)
                            ? getLightLevel(x, y, z)
                            : getLightLevel(x + wdx, y + wdy, z + wdz);

                        _mTemp.makeTranslation(wx + 0.5, wy + 0.5, wz + 0.5);
                        _m1.premultiply(_mTemp);
                        subGeo.applyMatrix4(_m1);

                        const count = subGeo.getAttribute('position').count;
                        const colors = new Float32Array(count * 3);
                        const sS = Math.max(0.04, LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw * globalBrightnessMultiplier);
                        const bS = Math.max(0.04, LIGHT_LEVEL_FACTORS[light & 15] * fw * globalBrightnessMultiplier);

                        for (let v = 0; v < count; v++) {
                            colors[v * 3] = sS; colors[v * 3 + 1] = bS; colors[v * 3 + 2] = 0;
                        }
                        subGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
                        // ------------------------------------------

                        batchArray.push(subGeo);
                    }
                    continue;
                }

                // --- [ループ内] B. 通常の不透明ブロック ---
                if (visMask && !useInstancing) {
                    const isRotated = !!cfg.isLog;
                    if (isRotated) {
                        _m1.copy(getLogRotationMatrix(meta));
                        _r1.extractRotation(_m1);
                    }

                    const baseMats = SharedMaterials.blocks.get(type) || getBlockMaterials(+type);

                    for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
                        let wBit = faceIdx, wNX, wNY, wNZ, fw;
                        const offset = faceIdx * 12;

                        // --- 1. 面の可視性判定と法線計算 ---
                        if (isRotated) {
                            _n1.set(CUBE_NORMALS[offset], CUBE_NORMALS[offset + 1], CUBE_NORMALS[offset + 2]).applyMatrix4(_r1);
                            wNX = Math.round(_n1.x); wNY = Math.round(_n1.y); wNZ = Math.round(_n1.z);
                            wBit = (wNX > 0) ? 0 : (wNX < 0) ? 1 : (wNY > 0) ? 2 : (wNY < 0) ? 3 : (wNZ > 0) ? 4 : 5;
                            if (!((visMask >> wBit) & 1)) continue;
                            fw = (wNY > 0) ? 1.0 : (wNY < 0) ? 0.5 : (Math.abs(wNX) > 0) ? 0.8 : 0.65;
                        } else {
                            if (!((visMask >> faceIdx) & 1)) continue;
                            wNX = CUBE_NORMALS[offset]; wNY = CUBE_NORMALS[offset + 1]; wNZ = CUBE_NORMALS[offset + 2];
                            fw = FACE_FW[faceIdx];
                        }

                        // --- 2. バッチの取得と容量確保 ---
                        const targetMat = baseMats[faceIdx] || baseMats[0];
                        let batch = materialBatches.get(targetMat);
                        if (!batch) {
                            batch = createBatch();
                            materialBatches.set(targetMat, batch);
                        }

                        // 書き込み前に一括で容量チェック（1面分：位置12要素、UV8要素）
                        batch.ensureCapacity(12, 8);

                        let p = batch.ptr;
                        let up = batch.uvPtr;

                        // --- 3. 頂点座標と法線の代入 ---
                        for (let j = 0; j < 12; j += 3) {
                            const oj = offset + j;
                            if (isRotated) {
                                _v1.set(CUBE_VERTICES[oj], CUBE_VERTICES[oj + 1], CUBE_VERTICES[oj + 2]).applyMatrix4(_m1);
                                batch.pos[p] = _v1.x + wx; batch.pos[p + 1] = _v1.y + wy; batch.pos[p + 2] = _v1.z + wz;
                                _n1.set(CUBE_NORMALS[oj], CUBE_NORMALS[oj + 1], CUBE_NORMALS[oj + 2]).applyMatrix4(_r1);
                                batch.norm[p] = _n1.x; batch.norm[p + 1] = _n1.y; batch.norm[p + 2] = _n1.z;
                            } else {
                                batch.pos[p] = CUBE_VERTICES[oj] + wx; batch.pos[p + 1] = CUBE_VERTICES[oj + 1] + wy; batch.pos[p + 2] = CUBE_VERTICES[oj + 2] + wz;
                                batch.norm[p] = CUBE_NORMALS[oj]; batch.norm[p + 1] = CUBE_NORMALS[oj + 1]; batch.norm[p + 2] = CUBE_NORMALS[oj + 2];
                            }
                            p += 3;
                        }

                        // --- 4. UVの代入 ---
                        for (let j = 0; j < 8; j++) {
                            batch.uv[up++] = CUBE_UVS[j];
                        }

                        // --- 5. ライトとカラーの書き込み ---
                        const light = getLightLevel(x + wNX, y + wNY, z + wNZ);
                        const brightness = fw * globalBrightnessMultiplier;
                        const sS = Math.max(0.04, LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * brightness);
                        const bS = Math.max(0.04, LIGHT_LEVEL_FACTORS[light & 15] * brightness);

                        let cp = batch.ptr; // カラー書き込み開始位置
                        for (let v = 0; v < 4; v++) {
                            batch.col[cp++] = sS;
                            batch.col[cp++] = bS;
                            batch.col[cp++] = 0;
                        }

                        // ポインタを最終更新
                        batch.ptr = p;
                        batch.uvPtr = up;
                    }
                }
            }
        }
    }

    if (!hasAnySolidBlock) return container;

    // --- 4. バッチング (不透明) [集約最適化版] ---
    for (const [originMat, batch] of materialBatches.entries()) {
        // 【修正】data.positions.length ではなく、書き込みポインタ batch.ptr をチェック
        if (!batch || batch.ptr === 0) continue;

        const geom = new THREE.BufferGeometry();

        // 【修正】型付き配列の「実際にデータを入れた部分」だけを抜き出して属性にセット
        // subarray(開始, 終了) を使うことで、余計なメモリ確保なしで部分参照できます
        geom.setAttribute('position', new THREE.Float32BufferAttribute(batch.pos.subarray(0, batch.ptr), 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(batch.col.subarray(0, batch.ptr), 3));
        geom.setAttribute('normal', new THREE.Float32BufferAttribute(batch.norm.subarray(0, batch.ptr), 3));
        geom.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uv.subarray(0, batch.uvPtr), 2));

        // 【修正】頂点数は座標配列の要素数 / 3
        const totalV = batch.ptr / 3;
        const indices = new Uint32Array((totalV / 4) * 6);
        for (let i = 0, v = 0; i < indices.length; i += 6, v += 4) {
            indices[i] = v; indices[i + 1] = v + 1; indices[i + 2] = v + 2;
            indices[i + 3] = v; indices[i + 4] = v + 2; indices[i + 5] = v + 3;
        }
        geom.setIndex(new THREE.BufferAttribute(indices, 1));

        // マテリアルのクローンと設定
        const finalMat = originMat.clone();
        finalMat.vertexColors = true;
        if (finalMat.color) finalMat.color.set(0xffffff);

        // userData の継承（オプショナルチェイニングで安全に）
        finalMat.userData = {
            originMat,
            shaderUniforms: originMat.userData ? originMat.userData.shaderUniforms : null
        };
        if (originMat.onBeforeCompile) finalMat.onBeforeCompile = originMat.onBeforeCompile;

        const mesh = new THREE.Mesh(geom, finalMat);
        mesh.frustumCulled = true;

        // フェード（透明度変化など）終了時の後処理
        mesh.userData.finalizeFade = function () {
            if (!this.material) return;
            const o = this.material.userData?.originMat;
            if (o) {
                this.material.dispose();
                this.material = o;
            }
        };

        container.add(mesh);
    }

    // --- 5. カスタムメッシュ結合 (メモリリーク対策 & 描画順序正常化) ---
    const opaqueGeometries = [], opaqueMaterials = [], opaqueMatMap = new Map();
    const waterGeometries = [], waterMaterials = [], waterMatMap = new Map();

    // ★ 追跡用：この関数内で生成された、最終メッシュ以外の全ジオメトリを保持
    const disposables = [];

    for (const [baseMat, geoms] of customGeomBatches.entries()) {
        if (!geoms || geoms.length === 0) continue;

        // 1. ジオメトリの結合
        const mergedGeom = mergeBufferGeometries(geoms, true);

        // ★ geoms (subGeoの配列) を disposables に追加
        for (let i = 0; i < geoms.length; i++) disposables.push(geoms[i]);

        if (!baseMat) {
            disposables.push(mergedGeom); // 使わない場合も破棄リストへ
            continue;
        }

        const isWater = baseMat.userData?.isWater === true;
        const isGlass = baseMat.userData?.isGlass === true;
        const isCutout = !isWater;

        // 3. 表示用フェードマテリアルの生成
        const fadeMat = getOrCreateCustomFadeMaterial(baseMat, isCutout, isWater, isGlass).clone();

        if (baseMat.map) fadeMat.map = baseMat.map;
        fadeMat.vertexColors = true;
        if (fadeMat.color) fadeMat.color.set(0xffffff);

        fadeMat.userData = {
            originMat: baseMat,
            shaderUniforms: baseMat.userData?.shaderUniforms
        };
        if (baseMat.onBeforeCompile) fadeMat.onBeforeCompile = baseMat.onBeforeCompile;

        // 4. 分類先の決定
        const targetGeoms = isWater ? waterGeometries : opaqueGeometries;
        const targetMats = isWater ? waterMaterials : opaqueMaterials;
        const targetMap = isWater ? waterMatMap : opaqueMatMap;

        let mIdx = targetMap.get(baseMat);
        if (mIdx === undefined) {
            mIdx = targetMats.length;
            targetMats.push(fadeMat);
            targetMap.set(baseMat, mIdx);
        }

        mergedGeom.clearGroups();
        mergedGeom.addGroup(0, mergedGeom.index ? mergedGeom.index.count : mergedGeom.attributes.position.count, mIdx);

        targetGeoms.push(mergedGeom);
        // ★ 結合用の材料になった mergedGeom も後で破棄するためリストへ
        disposables.push(mergedGeom);
    }

    // A. 不透明/Cutout
    if (opaqueGeometries.length > 0) {
        const combinedGeom = mergeBufferGeometries(opaqueGeometries, true);
        const mesh = new THREE.Mesh(combinedGeom, opaqueMaterials);
        mesh.renderOrder = 0;
        mesh.frustumCulled = true;
        container.add(mesh);
    }

    // B. 透過 (水)
    if (waterGeometries.length > 0) {
        const combinedGeom = mergeBufferGeometries(waterGeometries, true);
        const mesh = new THREE.Mesh(combinedGeom, waterMaterials);
        mesh.renderOrder = 10;
        mesh.frustumCulled = true;
        container.add(mesh);
    }

    // ★★★ 仕上げ: 中間ジオメトリを一括破棄 ★★★
    // これにより、GPUメモリ上の不要な BufferAttribute が解放されます
    for (let i = 0; i < disposables.length; i++) {
        disposables[i].dispose();
    }
    // 配列を空にして参照を切る
    disposables.length = 0;

    return container;
}
// ------------------------------
// CUSTOM BLOCK MESH (完全決定版)
// ------------------------------
const materialCache = new Map();
const collisionCache = new Map();
const geometryCache = new Map();

/**
 * カスタムブロックのメッシュを生成する
 * @param {string} type - ブロックの種類 (configから参照)
 * @param {THREE.Vector3} position - 配置座標
 * @param {number} meta - 接続状態や特殊状態 (0-15など)
 * @param {THREE.Euler} rotation - 追加の回転（必要に応じて）
 */
function createCustomBlockMesh(type, position, meta = 0, rotation = null) {
    const config = getBlockConfiguration(type);
    if (!config) {
        console.error("Unknown block type:", type);
        return null;
    }

    // --- 1. キャッシュキーの生成 ---
    // type(種別) と meta(形状) を組み合わせた数値キーを作成
    // ※ rotationを頻繁に変える場合は key に含めるか検討
    const geoKey = (type << 8) | (meta & 0xFF);

    // --- 2. ジオメトリの取得 ---
    let geometry;
    if (config.geometryType) {
        if (!geometryCache.has(geoKey)) {
            // getBlockGeometry側で meta に基づいた形状生成（フェンス等）を行う
            geometryCache.set(geoKey, getBlockGeometry(config.geometryType, config, meta));
        }
        geometry = geometryCache.get(geoKey);
    } else if (config.customGeometry) {
        // 外部モデルなどの場合はそのまま、またはクローン
        geometry = config.customGeometry.clone?.() ?? config.customGeometry;
    } else {
        console.warn(`No geometry for block type: ${type}`);
        return null;
    }

    // --- 3. マテリアルの取得 ---
    let materials = materialCache.get(type);
    if (!materials) {
        materials = getBlockMaterials(type);
        materialCache.set(type, materials);
    }

    // --- 4. メッシュの構築 ---
    const useMultiMaterial = Array.isArray(materials) && materials.length > 1 && geometry.groups?.length > 0;
    const meshGeometry = geometry; // 共有ジオメトリを使用
    const meshMaterial = useMultiMaterial ? materials : (Array.isArray(materials) ? materials[0] : materials);

    const mesh = new THREE.Mesh(meshGeometry, meshMaterial);
    mesh.position.copy(position);

    // rotation引数がある場合は適用（metaによる形状変化とは別の自由回転用）
    if (rotation) {
        mesh.rotation.copy(rotation);
    }

    // 視界外カリングを有効化（パフォーマンス向上）
    mesh.frustumCulled = true;

    // --- 5. 衝突判定の計算 ---
    if (!collisionCache.has(geoKey)) {
        const boxes = typeof config.customCollision === "function"
            ? config.customCollision(new THREE.Vector3(), meta) // metaを渡して形状に合わせる
            : (config.collision
                ? [new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, config.geometryType === "slab" ? 0.5 : 1, 1))]
                : []);
        collisionCache.set(geoKey, boxes);
    }

    // --- 6. メタデータの付与 ---
    mesh.userData = {
        isCustomBlock: !!config.customGeometry || !!config.geometryType,
        blockType: type,
        blockMeta: meta,
        // 配置座標に合わせて衝突ボックスをずらして格納
        collisionBoxes: collisionCache.get(geoKey).map(box => box.clone().translate(position))
    };

    mesh.updateMatrixWorld();
    return mesh;
}

/* ======================================================
   【最適化版】事前計算ロジック
   ====================================================== */
let lastChunk = { x: null, z: null };
let offsets = null;

/**
 * 視界範囲内の全オフセットを距離順に計算し、キャッシュする
 */
const precomputeOffsets = () => {
    const dist = CHUNK_VISIBLE_DISTANCE;
    const size = dist * 2 + 1;
    const o = [];

    for (let x = -dist; x <= dist; x++) {
        for (let z = -dist; z <= dist; z++) {
            // 距離（二乗）を計算
            const d2 = x * x + z * z;

            // 円形の視界制限をかけたい場合は、ここでフィルタリング可能
            // if (d2 > dist * dist) continue; 

            o.push({ dx: x, dz: z, d: d2 });
        }
    }

    // 距離が近い順にソート（重要：pop()で使うなら逆順、shift()なら正順）
    // 前回の processChunkQueue で pop() を使っているため、
    // 「遠い順」に並べておくと pop() した時に「近い順」に取り出せます。
    return o.sort((a, b) => b.d - a.d);
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

    // 1. 現在のキューの中身を把握（整数キーのまま扱う）
    _chunkKeysInQueue.clear();
    for (let i = 0; i < chunkQueue.length; i++) {
        _chunkKeysInQueue.add(chunkQueue[i]); // 🌟 すでに整数キーが入っている想定
    }

    const cands = offsets;

    // 2. 未ロード＆未キューイングのものを追加
    for (let i = 0; i < cands.length; i++) {
        const offset = cands[i];
        const cx = pCx + offset.dx;
        const cz = pCz + offset.dz;
        const hashKey = ((cx & 0xFFFF) << 16) | (cz & 0xFFFF); // 直接エンコード（高速）

        if (!loadedChunks.has(hashKey) && !_chunkKeysInQueue.has(hashKey)) {
            chunkQueue.push(hashKey); // 🌟 オブジェクトではなく整数をPush！
            _chunkKeysInQueue.add(hashKey);
        }
    }

    // 3. キューの肥大化対策（整数キーをデコードして距離判定）
    if (chunkQueue.length > 500) {
        let writeIdx = 0;
        for (let i = 0; i < chunkQueue.length; i++) {
            const key = chunkQueue[i];
            // ビット演算で座標を即時復元
            const qCx = key >> 16;
            const qCz = (key << 16) >> 16;

            const dx = Math.abs(qCx - pCx);
            const dz = Math.abs(qCz - pCz);
            if (dx <= CHUNK_VISIBLE_DISTANCE && dz <= CHUNK_VISIBLE_DISTANCE) {
                chunkQueue[writeIdx++] = key;
            }
        }
        chunkQueue.length = writeIdx;
    }

    // 4. プレイヤー移動時のみソート（整数キーをデコードしながら比較）
    if (isMoved && chunkQueue.length > 1) {
        chunkQueue.sort((a, b) => {
            // a の距離
            const aCx = a >> 16;
            const aCz = (a << 16) >> 16;
            const dAx = aCx - pCx;
            const dAz = aCz - pCz;

            // b の距離
            const bCx = b >> 16;
            const bCz = (b << 16) >> 16;
            const dBx = bCx - pCx;
            const dBz = bCz - pCz;

            return (dBx * dBx + dBz * dBz) - (dAx * dAx + dAz * dAz);
        });
    }

    // 5. 範囲外のチャンクをアンロード
    for (const [hashKey, mesh] of loadedChunks.entries()) {
        const cCx = hashKey >> 16;
        const cCz = (hashKey << 16) >> 16;
        const dx = Math.abs(cCx - pCx);
        const dz = Math.abs(cCz - pCz);

        if (dx > CHUNK_VISIBLE_DISTANCE || dz > CHUNK_VISIBLE_DISTANCE) {
            // 変更保持判定
            if (!ChunkSaveManager.modifiedChunks.has(hashKey)) {
                // 必要なら保存処理
            }

            releaseChunkMesh(mesh); // disposeMeshのことかな？適宜読み替えてください
            loadedChunks.delete(hashKey);
        }
    }

    if (chunkQueue.length > 0) {
        // processChunkQueue を呼び出し
        processChunkQueue();
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

// --- ループの外側で定義（使い回すためのメモリ空間を固定） ---
const _neighbors_key = new Int32Array(9);
const _neighbors_cx = new Int32Array(9);
const _neighbors_cz = new Int32Array(9);
const _neighbors_dx = new Int8Array(9);
const _neighbors_dz = new Int8Array(9);
let _neighborsCount = 0;

function updateAffectedChunks(blockPos, forceImmediate = false) {
    const cx = getChunkCoord(blockPos.x);
    const cz = getChunkCoord(blockPos.z);
    const lx = blockPos.x & 15;
    const lz = blockPos.z & 15;

    _neighborsCount = 0; // カウントをリセット

    // 1. ライトリセット ＋ 情報収集（オブジェクトを作らず、配列に直に書き込む）
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const nCx = cx + dx;
            const nCz = cz + dz;
            const nKey = encodeChunkKey(nCx, nCz);

            if (!loadedChunks.has(nKey)) continue;

            const lData = chunkLightCache.get(nKey);
            if (lData) lData.fill(0);

            // 外部の配列に値を格納（新しいオブジェクト {} は作らない！）
            _neighbors_key[_neighborsCount] = nKey;
            _neighbors_cx[_neighborsCount] = nCx;
            _neighbors_cz[_neighborsCount] = nCz;
            _neighbors_dx[_neighborsCount] = dx;
            _neighbors_dz[_neighborsCount] = dz;
            _neighborsCount++;
        }
    }

    // 2. ライトマップ計算
    for (let i = 0; i < _neighborsCount; i++) {
        const nKey = _neighbors_key[i];
        const vData = ChunkSaveManager.modifiedChunks.get(nKey) ||
            ChunkSaveManager.captureBaseChunkData(_neighbors_cx[i], _neighbors_cz[i]);

        if (vData) {
            generateChunkLightMap(nKey, vData);
        }
    }

    // 3. 自分のチャンクを更新
    refreshChunkAt(cx, cz);

    // 4. 隣接チャンクの更新判定
    for (let i = 0; i < _neighborsCount; i++) {
        const dx = _neighbors_dx[i];
        const dz = _neighbors_dz[i];
        if (dx === 0 && dz === 0) continue;

        let isBoundary = false;
        if (lx === 0 && dx === -1) isBoundary = true;
        if (lx === 15 && dx === 1) isBoundary = true;
        if (lz === 0 && dz === -1) isBoundary = true;
        if (lz === 15 && dz === 1) isBoundary = true;

        if (forceImmediate || isBoundary) {
            refreshChunkAt(_neighbors_cx[i], _neighbors_cz[i]);
        } else {
            pendingChunkUpdates.add(_neighbors_key[i]);
        }
    }

    if (!forceImmediate) scheduleChunkUpdate();
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
                ?? getVoxelAtWorld(bx, by, bz, true);

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
/**
 * 破壊/設置メインシステム（ChunkSaveManager v2 準拠版）
 */
function interactWithBlock(action) {
    if (action !== "place" && action !== "destroy") {
        console.warn("未知のアクション:", action);
        return;
    }

    const EPS = 1e-6;
    const TOP_FACE_THRESHOLD = 0.9;

    // レイキャスターの設定
    raycaster.near = 0.01;
    raycaster.far = BLOCK_INTERACT_RANGE;
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

    // 1. 周辺チャンクの収集（Math.floorによる負の座標対応）
    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);

    const objects = [];
    for (let x = -1; x <= 1; x++) {
        for (let z = -1; z <= 1; z++) {
            const chunkKey = encodeChunkKey(pCx + x, pCz + z);
            const chunkMesh = loadedChunks.get(chunkKey);
            if (chunkMesh) objects.push(chunkMesh);
        }
    }
    objects.push(...Object.values(placedCustomBlocks));

    const intersect = pickFirstValidHit(raycaster, objects, action);
    if (!intersect) return;

    const { base, dir, target, rawNormal } = computeHitBlockAndTarget(intersect, action);

    // 2. 座標の固定
    const rawPos = (action === "place") ? target : base;
    const b = {
        x: Math.floor(rawPos.x),
        y: Math.floor(rawPos.y),
        z: Math.floor(rawPos.z)
    };

    // 3. チャンク座標とローカル座標の計算（ビット演算による高速化）
    const candCx = b.x >> 4;
    const candCz = b.z >> 4;
    const candLx = b.x & 15;
    const candLz = b.z & 15;

    const candidateHash = getVoxelHash(b.x, b.y, b.z);

    // ブロックデータの取得
    let voxel = ChunkSaveManager.getBlock(candCx, candCz, candLx, b.y, candLz)
        ?? getVoxelAtWorld(b.x, b.y, b.z, true);

    const voxelIdOnly = voxel & 0xFFF;
    let cfg = getBlockConfiguration(voxelIdOnly);

    // 距離チェック
    const candidateCenter = new THREE.Vector3(b.x + 0.5, b.y + 0.5, b.z + 0.5);
    const cameraPos = camera.position;
    if (cameraPos.distanceTo(candidateCenter) > BLOCK_INTERACT_RANGE + 0.6) return;

    let playerBox = null;
    try { playerBox = getPlayerAABB(); } catch (e) { }

    // ====================
    // 破壊セクション
    // ====================
    if (action === "destroy") {
        if (voxelIdOnly === BLOCK_TYPES.SKY) return;
        if (cfg?.targetblock === false) return;

        createMinecraftBreakParticles(candidateCenter, voxelIdOnly, 1.0);

        if (placedCustomBlocks.has(candidateHash)) {
            scene.remove(placedCustomBlocks.get(candidateHash));
            placedCustomBlocks.delete(candidateHash);
        }

        // ✅ ChunkSaveManager 内で更新フラグと Y 範囲の記録が自動で行われるため
        // markColumnModified(b.x, b.z, b.y) は削除しました。
        ChunkSaveManager.setBlock(candCx, candCz, candLx, b.y, candLz, BLOCK_TYPES.SKY);

        updateAffectedChunks(b, false);
        updateBlockSelection();
        updateBlockInfo();
        return;
    }

    // ====================
    // 設置セクション
    // ====================
    if (action === "place") {
        if (activeBlockType === BLOCK_TYPES.SKY) return;

        // 高度制限
        if (b.y <= -1 || b.y >= 256) {
            if (typeof addChatMessage === 'function') addChatMessage("設置制限高度外です。", "#ff5555");
            return;
        }

        // 上書き可能判定
        if (voxelIdOnly !== BLOCK_TYPES.SKY) {
            const currentCfg = getBlockConfiguration(voxelIdOnly);
            if (currentCfg?.geometryType === "water" || currentCfg?.overwrite === true) {
                if (placedCustomBlocks.has(candidateHash)) {
                    scene.remove(placedCustomBlocks.get(candidateHash));
                    placedCustomBlocks.delete(candidateHash);
                }
            } else {
                return;
            }
        }

        // 衝突判定
        const newBlockCfg = getBlockConfiguration(activeBlockType);
        if (newBlockCfg?.collision !== false && playerBox) {
            if (blockIntersectsPlayer(b, playerBox, 0.0)) return;
        }

        // 特殊設置制限（スニーク等）
        if (playerBox) {
            const isActuallyTopAttempt = (rawNormal.y > TOP_FACE_THRESHOLD) || (dir.y > 0);
            const overlapsBelow = playerBox.intersectsBox(new THREE.Box3(
                new THREE.Vector3(b.x + EPS, b.y - 1 + EPS, b.z + EPS),
                new THREE.Vector3(b.x + 1 - EPS, b.y - EPS, b.z + 1 - EPS)
            ));
            if (sneakActive && overlapsBelow && isActuallyTopAttempt) return;
        }

        // メタデータの計算
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        const metaData = calculatePlacementMeta(activeBlockType, camDir, rawNormal, intersect.point);
        const blockDataToSave = (activeBlockType & 0xFFF) | (metaData << 12);

        // ✅ 設置実行：メタ情報（更新フラグ）も内部で一括処理
        ChunkSaveManager.setBlock(candCx, candCz, candLx, b.y, candLz, blockDataToSave);
        lastPlacedKey = candidateHash;

        updateAffectedChunks(b, false);
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

    // --- 💡 共通のエラー描画処理 ---
    const drawErrorPattern = (context, s) => {
        const half = s / 2;
        context.fillStyle = "#FF00FF"; // マゼンタ
        context.fillRect(0, 0, half, half);
        context.fillRect(half, half, half, half);
        context.fillStyle = "#000000"; // ブラック
        context.fillRect(half, 0, half, half);
        context.fillRect(0, half, half, half);
    };

    const src = textures.all || textures.side || textures.top;

    // 1. テクスチャ指定自体がない場合
    if (!src) {
        console.warn(`テクスチャ定義なし block: ${id}`);
        drawErrorPattern(ctx, size);
        // エラー状態もキャッシュに保存（毎フレームの警告を防ぐ）
        const cacheCanvas = createCanvas(size);
        cacheCanvas.getContext("2d").drawImage(canvas, 0, 0);
        previewCache.set(hashKey, cacheCanvas);
        return canvas;
    }

    // 2. テクスチャがある場合（非同期読み込み）
    loadImage(src).then(img => {
        const { x = 0, y = 0 } = previewOptions.offset || {};
        ctx.clearRect(0, 0, size, size); // 万が一の重なり防止
        ctx.drawImage(img, x, y, size, size);

        // キャッシュ保存
        const cacheCanvas = createCanvas(size);
        cacheCanvas.getContext("2d").drawImage(canvas, 0, 0);
        previewCache.set(hashKey, cacheCanvas);
    }).catch(e => {
        console.error(`画像読み込み失敗 block: ${id}`, e);
        // 読み込み失敗時もエラーパターンを描画してキャッシュ
        drawErrorPattern(ctx, size);
        const cacheCanvas = createCanvas(size);
        cacheCanvas.getContext("2d").drawImage(canvas, 0, 0);
        previewCache.set(hashKey, cacheCanvas);
    });

    // 読み込み中も「透明」ではなく「エラー柄」を仮に返しておくと
    // ユーザーにロード中または異常であることが伝わりやすくなります
    drawErrorPattern(ctx, size);

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
            alphaTest: m.alphaTest || 0,
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

async function itemspreview() {
    const inventoryEl = document.getElementById("inventory");

    const promises = Object.values(BLOCK_CONFIG).map(async blockConfig => {
        if (!blockConfig.itemdisplay) return null;
        const item = document.createElement("div");
        item.className = "inventory-item";
        const blockId = Number(blockConfig.id); // ← 明示的に数値化
        item.dataset.blocktype = blockId;

        attachTooltip(item, blockId);

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
}

// --- グローバル変数 ---
let tooltip;
let lastMouseX = 0; // マウスの現在位置を常に記録
let lastMouseY = 0;

/**
 * マウス座標にある要素を判定してツールチップを更新する共通関数
 */
function updateTooltipInstant() {
    if (!tooltip || !isInventoryOpen) return;

    // 現在のマウス座標にあるDOM要素を取得
    const targetEl = document.elementFromPoint(lastMouseX, lastMouseY);
    // その要素自体、または親要素に .inventory-item があるか探す
    const itemEl = targetEl?.closest(".inventory-item");

    if (itemEl) {
        const blockId = itemEl.dataset.blocktype;
        const cfg = getBlockConfiguration(blockId);
        tooltip.textContent = cfg?.name || "Unknown";
        tooltip.style.display = "block";

        // 座標も即座に更新
        updateTooltipPosition(lastMouseX, lastMouseY);
    } else {
        tooltip.style.display = "none";
    }
}

/**
 * ツールチップの位置を計算・表示する補助関数
 */
function updateTooltipPosition(clientX, clientY) {
    if (!tooltip) return;
    const gap = 12;
    let x = clientX + gap;
    let y = clientY + gap;

    // 画面右端での折り返し
    const tooltipWidth = tooltip.offsetWidth;
    if (x + tooltipWidth > window.innerWidth) {
        x = clientX - tooltipWidth - gap;
    }

    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
}

/**
 * アイテム要素にイベントを登録
 */
function attachTooltip(element, blockId) {
    element.addEventListener("mouseenter", () => {
        if (!tooltip) return;
        const cfg = getBlockConfiguration(blockId);
        tooltip.textContent = cfg?.name || "Unknown";
        tooltip.style.display = "block";
    });

    element.addEventListener("mouseleave", () => {
        if (!tooltip) return;
        tooltip.style.display = "none";
    });
}

/**
 * ツールチップの初期化
 */
async function initTooltip() {
    tooltip = document.createElement("div");
    tooltip.style.position = "fixed";
    tooltip.style.pointerEvents = "none";
    tooltip.style.padding = "4px 8px";
    tooltip.style.background = "rgba(0,0,0,0.85)"; // 少し不透明度を調整
    tooltip.style.color = "#fff";
    tooltip.style.fontSize = "12px";
    tooltip.style.borderRadius = "4px";
    tooltip.style.whiteSpace = "nowrap";
    tooltip.style.zIndex = "9999";
    tooltip.style.display = "none";
    tooltip.style.border = "1px solid #555"; // 縁取りを追加（Minecraft風）
    document.body.appendChild(tooltip);

    document.addEventListener("mousemove", (e) => {
        // マウス位置を常に保存
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;

        if (tooltip.style.display === "none") return;
        updateTooltipPosition(e.clientX, e.clientY);
    });
}

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

// ----- グローバル：ブロック情報表示用 DOM や、Raycaster 用オブジェクト -----
const BLOCK_NAMES = Object.keys(BLOCK_TYPES).reduce((names, key) => {
    names[BLOCK_TYPES[key]] = key.charAt(0) + key.slice(1).toLowerCase();
    return names;
}, {});

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
                    ?? getVoxelAtWorld(x, y, z, true);

                // 💡 空（SKY）でない場合の判定
                if (voxel !== BLOCK_TYPES.SKY) {
                    // 💡 重要：メタデータ(上位bit)を分離し、純粋なブロックID(下位12bit)を取得
                    const blockId = voxel & 0xFFF;
                    const conf = getBlockConfiguration(blockId);

                    // 💡 conf が存在することを確認（null安全）
                    if (conf && conf.targetblock !== false) {
                        // 透過や特殊形状（階段・ハーフ・クロス等）の精密判定
                        if (conf.geometryType && conf.geometryType !== "cube") {
                            intersects.length = 0;
                            const chunkKey = encodeChunkKey(cx, cz);
                            const chunkMesh = loadedChunks.get(chunkKey);

                            if (chunkMesh) {
                                tempRaycaster.intersectObject(chunkMesh, true, intersects);
                            }

                            const hasHitInGrid = intersects.some(hit => {
                                // 浮動小数点の誤差を考慮して少しだけ内側にオフセットして座標判定
                                const hx = Math.floor(hit.point.x - (hit.face ? hit.face.normal.x : 0) * 1e-5);
                                const hy = Math.floor(hit.point.y - (hit.face ? hit.face.normal.y : 0) * 1e-5);
                                const hz = Math.floor(hit.point.z - (hit.face ? hit.face.normal.z : 0) * 1e-5);
                                return hx === x && hy === y && hz === z;
                            });

                            if (hasHitInGrid) { found = true; break; }
                        } else {
                            // 通常のフルブロック（cube）なら即座にヒット確定
                            found = true;
                            break;
                        }
                    }
                }
            }
        }

        if (found) {
            return { x, y, z, normal: hitNormal, distance };
        } else {
            freeVec(hitNormal);
            return null;
        }
    } finally {
        freeVec(dir);
    }
}

/* ======================================================
    【最新・完全版】ブロック情報の更新
    （独自サイズ優先 ＋ 回転・状態対応 ＋ 斜め線なし）
   ====================================================== */
function updateBlockSelection() {
    const hit = getTargetBlockByDDA(BLOCK_INTERACT_RANGE);
    if (!hit) {
        if (selectionGroup.visible) {
            selectionGroup.visible = false;
            // メモリ解放
            selectionGroup.children.forEach(child => {
                if (child.geometry) child.geometry.dispose();
            });
            selectionGroup.clear();
        }
        return;
    }

    const { x, y, z } = hit;
    const cx = getChunkCoord(x);
    const cz = getChunkCoord(z);

    let lx = x % CHUNK_SIZE;
    if (lx < 0) lx += CHUNK_SIZE;
    let lz = z % CHUNK_SIZE;
    if (lz < 0) lz += CHUNK_SIZE;

    const rawVoxel = ChunkSaveManager.getBlock(cx, cz, lx, y, lz)
        ?? getVoxelAtWorld(x, y, z, true);

    if (!rawVoxel) {
        selectionGroup.visible = false;
        return;
    }

    const blockId = rawVoxel & 0xFFF;
    const metadata = (rawVoxel >> 12) & 0xF;
    const config = getBlockConfiguration(blockId);

    // 1. 古い枠線の破棄とクリア
    selectionGroup.children.forEach(child => {
        if (child.geometry) child.geometry.dispose();
    });
    selectionGroup.clear();

    const rotatedBox = getPooledBox();

    // 2. 表示すべきボックス情報の抽出
    let baseBoxes = [];

    if (config?.selectionSize) {
        // --- 独自サイズ設定がある場合 ---
        const s = config.selectionSize;
        const o = config.selectionOffset || { x: 0.5, y: 0.5, z: 0.5 };

        // Offsetを中心座標として、min/maxを計算してBox3を作成
        // これにより、回転ロジック(applyRotationToCollisionBox)に渡せるようになる
        const customBox = new THREE.Box3(
            new THREE.Vector3(o.x - s.x / 2, o.y - s.y / 2, o.z - s.z / 2),
            new THREE.Vector3(o.x + s.x / 2, o.y + s.y / 2, o.z + s.z / 2)
        );
        baseBoxes = [customBox];
    } else if (config?._cachedCollision) {
        // --- 通常の衝突判定用ボックスを使う場合 ---
        baseBoxes = config._cachedCollision;
    } else {
        // --- デフォルト(1x1x1) ---
        staticDefaultBox = staticDefaultBox || [new THREE.Box3(
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(1, 1, 1)
        )];
        baseBoxes = staticDefaultBox;
    }

    // 3. 各ボックスに対して回転を適用し、枠線を生成
    for (let i = 0; i < baseBoxes.length; i++) {
        // 💡 ここでmetadataに基づいた回転・反転を適用（階段やハーフブロック等に対応）
        applyRotationToCollisionBox(baseBoxes[i], metadata, rotatedBox);

        createSelectionLine(x, y, z, rotatedBox);
    }

    releasePooledBox(rotatedBox);
    selectionGroup.visible = true;

    if (hit.normal) freeVec(hit.normal);
}

/**
 * 枠線（LineSegments）を生成してGroupに追加するヘルパー
 */
function createSelectionLine(worldX, worldY, worldZ, box3) {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box3.getSize(size);
    box3.getCenter(center);

    const geom = new THREE.BoxGeometry(size.x + 0.001, size.y + 0.001, size.z + 0.001);

    const edges = new THREE.EdgesGeometry(geom);

    const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
            color: 0x000000,
            linewidth: 1,
            // 【修正点2】手前に描画する設定を追加（Z-fighting対策）
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1
        })
    );

    // ワールド座標 + ボックスのローカル中心座標
    line.position.set(worldX + center.x, worldY + center.y, worldZ + center.z);

    selectionGroup.add(line);

    // 中間のジオメトリは即座に破棄
    geom.dispose();
}

let staticDefaultBox = null;

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

    const rawVoxel = ChunkSaveManager.getBlock(cx, cz, lx, y, lz)
        ?? getVoxelAtWorld(x, y, z, true);

    // ✅ 回転値とIDを分離
    const blockId = rawVoxel & 0xFFF;
    const rotation = (rawVoxel >> 12) & 0x3;

    if (blockId === BLOCK_TYPES.SKY || rawVoxel === undefined) {
        currentTargetBlockText = "None";
        if (hit.normal) freeVec(hit.normal);
        return;
    }

    const blockName = BLOCK_NAMES[blockId] || "Unknown";
    const config = getBlockConfiguration(blockId);

    // ✅ 回転状態 (Rot) をテキストに追加
    currentTargetBlockText = `${blockName} (ID: ${blockId}, Rot: ${rotation}) [${x}, ${y}, ${z}]` +
        (config ? `<br>Type: ${config.geometryType}` : "");

    if (hit.normal) freeVec(hit.normal);
}

const elem = document.getElementById("headBlockInfo");
function updateHeadBlockInfo() {
    const currentHeight = getCurrentPlayerHeight();
    const headY = player.position.y + currentHeight * 0.85;

    const hX = Math.floor(player.position.x);
    const hY = Math.floor(headY);
    const hZ = Math.floor(player.position.z);

    const cx = getChunkCoord(hX);
    const cz = getChunkCoord(hZ);

    let hLx = hX % CHUNK_SIZE;
    if (hLx < 0) hLx += CHUNK_SIZE;
    let hLz = hZ % CHUNK_SIZE;
    if (hLz < 0) hLz += CHUNK_SIZE;

    const rawValue = ChunkSaveManager.getBlock(cx, cz, hLx, hY, hLz)
        ?? getVoxelAtWorld(hX, hY, hZ, true);

    // ✅ IDと回転値を分離して表示
    const blockId = rawValue & 0xFFF;
    const rotation = (rawValue >> 12) & 0x3;
    const blockName = BLOCK_NAMES[blockId] || "Unknown";

    if (elem) {
        const newText = `Head Block: ${blockName} (ID: ${blockId}, Rot: ${rotation})`;
        if (elem.textContent !== newText) {
            elem.textContent = newText;
        }
        if (elem.style.display !== "block") {
            elem.style.display = "block";
        }
    }
}

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
                ?? getVoxelAtWorld(x, y, z, true);

            _waterCellCache.set(numericKey, blockValue);
        }

        // 💡 ここを修正：上位ビットのメタデータを切り落として純粋なIDにする
        const blockId = blockValue & 0xFFF;
        const isWater = (blockId === BLOCK_TYPES.WATER || blockId === BLOCK_TYPES.LAVA);

        if (i < 5) {
            // インデックス 0〜4 は下半身の判定用
            if (isWater) waterCount++;
        } else {
            // インデックス 5 は頭の判定用
            isHeadInWater = isWater;
        }
    }

    // 💡 ここを修正：角から入った場合（1点でも触れた場合）も水没とするように「> 0」に変更
    return (waterCount > 0) || isHeadInWater;
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

// タイマー管理用
let cloudUpdateTimer = 0;
let cloudGridTimer = 0;
let underwaterTimer = 0;
let chunkUpdateFrameTimer = 0;  // 自然チャンク更新用
let blockInfoTimer = 0;

// 最適化：再利用するベクトル群（GC対策）
const _camOffset = new THREE.Vector3();
const _tempVec3 = new THREE.Vector3();

function animate() {
    requestAnimationFrame(animate);

    let delta = clock.getDelta();
    if (delta > 0.1) delta = 0.1; // スパイク対策
    const now = performance.now();

    // プレイヤーの現在チャンク座標を計算（共通利用）
    const pCx = Math.floor(player.position.x / CHUNK_SIZE);
    const pCz = Math.floor(player.position.z / CHUNK_SIZE);

    // 0. -------- ロード・スポーン待機ガード --------
    if (!player.spawnFixed) {
        if (loadedChunks.has(encodeChunkKey(pCx, pCz))) {
            const groundY = Math.floor(BASE_HEIGHT + heightModifier);
            player.position.y = (player.position.y === 40) ? groundY + 0.1 : player.position.y;
            player.spawnFixed = true;
            updateSunMoonPosition();
            updateStars();
        } else {
            player.velocity.y = 0;
            updateChunks();
            return;
        }
    }
    frameCount++;

    // 1. -------- 昼夜サイクルの進行 --------
    if (player.spawnFixed) {
        gameTime = (gameTime + delta * 20 * TIME_SPEED) % TICKS_PER_DAY;
        updateSunMoonPosition();
        updateStars();
    }

    // 2. -------- ブロックの明るさ（シェーダー）への反映 --------
    const currentSkyFactor = getSkyLightFactor(gameTime);
    globalSkyUniforms.forEach(uniform => {
        uniform.value = currentSkyFactor;
    });

    // 3. -------- HUD（デバッグ情報）の更新（1秒ごと） --------
    if (now - lastFpsTime > 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        const activeUpdates = pendingChunkUpdates.size + chunkQueue.length;
        const modifiedCount = ChunkSaveManager.modifiedChunks.size;

        const drawCalls = renderer.info.render.calls;
        const triangles = renderer.info.render.triangles;

        const targetText = (typeof currentTargetBlockText !== 'undefined') ? currentTargetBlockText : "None";
        const moveMode = flightMode ? "Flight" : (wasUnderwater ? "Swimming" : "Walking");

        // --- バイオーム判定ロジック（地形生成同期版） ---
        // 1. まず座標を取得して整数化する（ここで pxInt, pzInt を定義）
        const pxInt = Math.floor(player.position.x);
        const pzInt = Math.floor(player.position.z);
        const py = player.position.y;

        // 2. 定義した pxInt, pzInt を使ってノイズを計算
        const tVal = fractalNoise2D(pxInt * 0.0005, pzInt * 0.0005, 3) + 0.5;
        const hVal = fractalNoise2D(pxInt * 0.0005 + 500, pzInt * 0.0005 + 500, 3) + 0.5;
        const rVal = fractalNoise2D(pxInt * 0.005, pzInt * 0.005, 2) + 0.5;

        // 3. バイオームを決定
        const biomeConfig = determineBiome(tVal, hVal, 64, rVal);
        const biomeName = (biomeConfig && biomeConfig.name) ? biomeConfig.name : "Unknown";

        // HTMLを更新
        fpsCounter.innerHTML = `
        <b>Minecraft test 0.0.1</b><br>
        Seed: ${currentSeed}<br>
        Time: ${getGameClock(gameTime)} (${Math.floor(gameTime)} ticks)<br>
        ${fps} fps, ${activeUpdates} chunks update<br>
        <b>Draw calls: ${drawCalls}</b> (Tri: ${triangles.toLocaleString()})<br>
        ${modifiedCount} modified chunks (Saved)<br>
        C: ${loadedChunks.size} loaded. (Quality: ${CHUNK_VISIBLE_DISTANCE})<br>
        Dimension: Overworld<br>
        <b>Biome: ${biomeName}</b><br>
        x: ${Math.round(pxInt)} (C: ${pCx})<br>
        y: ${Math.round(py)} (feet)<br>
        z: ${Math.round(pzInt)} (C: ${pCz})<br>
        Mode: ${moveMode} / Dash: ${dashActive ? "ON" : "OFF"}<br>
        --------------------------<br>
        TargetBlock: ${targetText}
    `;

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
        if (pendingChunkUpdates.size > 0) processPendingChunkUpdates(4);
        chunkUpdateFrameTimer = 0;
    }

    if (showChunkBorders) {
        chunkBorderMesh.position.set(pCx * CHUNK_SIZE, 0, pCz * CHUNK_SIZE);
    }

    // 6. -------- カメラ位置の更新 --------
    const playerHeight = getCurrentPlayerHeight() - (flightMode ? 0.15 : 0);
    _camOffset.set(0, playerHeight, 0);
    _tempVec3.copy(player.position).add(_camOffset);
    camera.position.x = _tempVec3.x;
    camera.position.z = _tempVec3.z;
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, _tempVec3.y, 0.5);

    // 7. -------- ブロック選択・情報の更新 --------
    blockInfoTimer += delta;
    if (blockInfoTimer > 0.05) {
        const hasMoved = camera.position.distanceToSquared(lastCamPos) > 0.0001 ||
            Math.abs(camera.rotation.y - lastCamRot.y) > 0.0001 ||
            Math.abs(camera.rotation.x - lastCamRot.x) > 0.0001;

        if (hasMoved) {
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
        updateCloudOpacity(camera.position, currentSkyFactor);
        cloudUpdateTimer = 0;
    }
    if (cloudGridTimer > 0.1) {
        const camPos = camera.position;
        cloudTiles.forEach(tile => {
            if (tile.position.distanceToSquared(camPos) < 256) adjustCloudLayerDepth(tile, camera);
        });
        updateCloudGrid(scene, camPos);
        cloudGridTimer = 0;
    }

    // ループ外で保持する変数
    let lastCullingState = null; // 'down' | 'normal'
    const CULL_DIST_SQ = 2 * 2;

    // 9. -------- ドローコール最適化 --------
    const isLookingDown = camera.rotation.x < -1.2;
    const currentState = isLookingDown ? 'down' : 'normal';

    // 状態が変わった、またはプレイヤーが別のチャンクに移動した時のみ可視性を更新
    if (lastCullingState !== currentState || chunkChanged) {
        for (const chunk of loadedChunks.values()) {
            if (!chunk.mesh && !chunk.waterMesh) continue;

            let isVisible = true;
            if (isLookingDown) {
                const dx = chunk.x - pCx;
                const dz = chunk.z - pCz;
                // 平方根を計算しない二乗比較（高速）
                isVisible = (dx * dx + dz * dz) <= CULL_DIST_SQ;
            }

            if (chunk.mesh) chunk.mesh.visible = isVisible;
            if (chunk.waterMesh) chunk.waterMesh.visible = isVisible;
        }
        lastCullingState = currentState;
    }

    // 10. -------- 最終処理 & レンダリング --------
    updateScreenOverlay();
    resetLastPlacedIfOnGround();
    renderer.render(scene, camera);
}

/**
 * ゲーム内時間を HH:mm 形式に変換
 */
function getGameClock(ticks) {
    // 1000 ticks = 1時間, 0 ticks = 6:00
    const totalHours = (ticks / 1000 + 6) % 24;
    const hours = Math.floor(totalHours);
    const minutes = Math.floor((totalHours % 1) * 60);
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
    ui.menu.style.display = 'none';
    ui.config.style.display = 'none';
    ui.loading.style.display = 'flex';
    const seed = applySeed(ui.seedInput.value);
    await startGame(seed);
};

// 保存データから再開（最新修正版）
document.getElementById('btn-load-saved').onclick = async () => {
    try {
        // 1. データの読み込みを待機
        const saveData = await loadFullSaveData();

        // 2. データの存在チェック
        // loadFullSaveDataがデータなしの時にnullを返すようになったため、シンプルに判定可能
        if (saveData) {
            ui.config.style.display = 'none';
            ui.menu.style.display = 'none';
            ui.loading.style.display = 'flex';
            // --- A. シード値の適用 ---
            // 数値として保存されているシードを適用
            if (typeof applySeed === 'function') {
                applySeed(saveData.seed);
            }

            // --- B. 設置・破壊情報の復元 ---
            if (typeof ChunkSaveManager !== 'undefined') {
                // saveData.chunks は Map 形式で返ってくるため、そのまま代入
                ChunkSaveManager.modifiedChunks = saveData.chunks || new Map();
            }

            // --- C. ゲーム時間の確定 ---
            // 保存された時間があれば使い、なければ朝(6000)をデフォルトにする
            const restoredTime = (typeof saveData.gameTime === 'number' && !isNaN(saveData.gameTime))
                ? saveData.gameTime
                : 6000;

            // --- D. プレイヤー座標の確定 ---
            // 保存された座標があれば使い、なければ初期スポーン地点(y=40)
            const startPos = saveData.pos || { x: 0, y: 40, z: 0 };

            console.log(`[Load] ロード成功: Seed=${saveData.seed}, Time=${restoredTime}, Chunks=${saveData.chunks?.size || 0}件`);

            // --- E. ゲーム開始 ---
            // 引数の順番：(seed, position, modifiedChunks, gameTime)
            if (typeof startGame === 'function') {
                await startGame(
                    saveData.seed,
                    startPos,
                    saveData.chunks,
                    restoredTime
                );
            }

            // チャット欄への通知
            if (typeof addChatMessage === 'function') {
                addChatMessage("セーブデータをロードしました", "#ffff00");
            }

        } else {
            // saveData が null（DBに last_seed がない）場合はここに来る
            alert("セーブデータが見つかりませんでした。");
        }
    } catch (error) {
        console.error("ロード中にエラーが発生しました:", error);
        alert("データの読み込みに失敗しました。IndexedDBの状態を確認してください。");
    }
};

// 引数に savedTime = 0 を追加
async function startGame(seed, savedPos = null, savedChunks = null, savedTime = 0) {
    const fill = document.getElementById('loading-fill');

    // プログレスバー更新用の補助関数
    const updateProgress = async (percent) => {
        if (fill) fill.style.width = `${percent}%`;
        // 重要：ブラウザに描画を強制させるための「一休み」
        await new Promise(resolve => requestAnimationFrame(resolve));
    };

    // 0%：開始
    ui.loading.style.display = 'flex';
    await updateProgress(0);

    initCanvas();
    initSunMoon();
    initStars();

    if (typeof gameTime !== 'undefined') {
        gameTime = savedTime;
    }

    // 20%：基本システム初期化完了
    await updateProgress(20);

    // --- 1. シード値とデータの適用 ---
    if (typeof applySeed === 'function') {
        applySeed(seed);
    }

    if (savedChunks instanceof Map && savedChunks.size > 0) {
        ChunkSaveManager.modifiedChunks = savedChunks;
    } else {
        ChunkSaveManager.modifiedChunks = ChunkSaveManager.modifiedChunks || new Map();
    }
    // 40%：データ構造の準備完了
    await updateProgress(40);

    // --- 2. プレイヤー位置・視点の反映 ---
    const startPos = savedPos ? savedPos : { x: 0, y: 40, z: 0, yaw: 0, pitch: 0 };
    if (typeof player !== 'undefined') {
        player.position.set(startPos.x, startPos.y, startPos.z);
        player.spawnFixed = !!savedPos;
    }
    if (typeof yaw !== 'undefined' && typeof pitch !== 'undefined') {
        yaw = startPos.yaw || 0;
        pitch = startPos.pitch || 0;
    }
    // 60%：座標・視点確定
    await updateProgress(60);

    // --- 3. 描画・システム反映 ---
    if (typeof updateSunMoonPosition === 'function') {
        updateSunMoonPosition();
        updateStars();
    }
    // 80%：環境設定完了
    await updateProgress(80);

    // --- 4. アイテムプレビュー生成（ここが一番重い想定） ---
    if (typeof itemspreview === 'function') {
        await itemspreview();
        await initTooltip();
    }

    // 100%：すべてのロードが完了
    await updateProgress(100);

    // 完了を視認させるため、一瞬だけ待ってから閉じる
    setTimeout(() => {
        ui.loading.style.display = 'none';
        addChatMessage(savedPos ? "データをロードしました" : "世界を新しく生成しました", "#ffff00");
        animate(); // ループ開始
        ui.config.style.display = 'none';
        ui.menu.style.display = 'none';
        ui.loading.style.display = 'none';
    }, 150);
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
   保存してタイトルへ戻る
   ====================================================== */
const btnSaveAndQuit = document.getElementById("btn-save-quit");

if (btnSaveAndQuit) {
    btnSaveAndQuit.onclick = async () => {
        try {
            // シード値
            const s = (typeof currentSeed !== 'undefined') ? currentSeed : 0;

            // プレイヤー座標と視点の角度 (yaw, pitch) を一緒に保存
            const pPos = (typeof player !== 'undefined' && player.position)
                ? { x: player.position.x, y: player.position.y, z: player.position.z, yaw: yaw, pitch: pitch }
                : { x: 0, y: 20, z: 0, yaw: 0, pitch: 0 };

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
   保存せずにタイトルへ戻る
   ====================================================== */
const btn_noSaveAndQuit = document.getElementById("btn-nosave-quit");

if (btn_noSaveAndQuit) {
    btn_noSaveAndQuit.onclick = () => {
        window.location.reload();
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
addChatMessage("Minecraft test 0.0.1", "#ffff55");



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
const INTERACT_SPEED = 150;
function startInteraction(action, key) {
    if (interactIntervalIds[key] !== null) {
        clearInterval(interactIntervalIds[key]);
    }
    interactWithBlock(action);
    interactIntervalIds[key] = setInterval(() => {
        interactWithBlock(action);
    }, INTERACT_SPEED);
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
        if (isPaused) return;
        e.preventDefault();
        e.stopImmediatePropagation();

        if (isInventoryOpen) {
            // --- インベントリを閉じる処理 ---
            isInventoryOpen = false;
            inventoryContainer.style.display = "none";

            // ツールチップを確実に隠す[cite: 1]
            if (tooltip) {
                tooltip.style.display = "none";
            }

            if (!isPaused) renderer.domElement.requestPointerLock();
        } else {
            // --- インベントリを開く処理 ---
            isInventoryOpen = true;
            inventoryContainer.style.display = "block";
            document.exitPointerLock();

            // 【追加】開いた瞬間にマウスの下にあるアイテムをチェック[cite: 1]
            // 10msの遅延を入れることで、DOMの表示確定後に判定を走らせます
            setTimeout(() => {
                if (typeof updateTooltipInstant === "function") {
                    updateTooltipInstant();
                }
            }, 10);
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
// 7. タッチUI・マルチタッチ完全対応版 (閉じるボタン・干渉防止済)
// ==========================================
function setupTouchControls() {
    if (typeof renderer === 'undefined' || !renderer.domElement) {
        setTimeout(setupTouchControls, 100);
        return;
    }

    const canvas = renderer.domElement;

    // --- 状態管理変数 ---
    let lastForwardTapTime = 0;
    let lastJumpTime = 0;
    let lastSneakTime = 0;
    let sneakToggled = false;
    const TAP_THRESHOLD = 300;

    let lookTouchId = null;
    let lastTouchX = 0, lastTouchY = 0;
    let touchStartTime = 0;
    let isLongPress = false;
    let longPressTimer = null;
    const TOUCH_SENSITIVITY = 0.005;

    // --- 補助関数: ボタン紐付け ---
    const bindButton = (id, key, onStart, onEnd) => {
        const btn = document.getElementById(id);
        if (!btn) return;

        const start = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onStart) onStart();
            keys[key] = true;
        };
        const end = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onEnd) onEnd();
            keys[key] = false;
        };

        btn.addEventListener("touchstart", start, { passive: false });
        btn.addEventListener("touchend", end, { passive: false });
        btn.addEventListener("mousedown", start);
        btn.addEventListener("mouseup", end);
    };

    // --- 1. 移動・ジャンプ・スニーク ---
    bindButton("dpad-up", "w", () => {
        const now = performance.now();
        if (now - lastForwardTapTime < TAP_THRESHOLD) dashActive = true;
        lastForwardTapTime = now;
    }, () => { dashActive = false; });
    bindButton("dpad-down", "s");
    bindButton("dpad-left", "a");
    bindButton("dpad-right", "d");

    const btnJump = document.getElementById("btn-jump");
    if (btnJump) {
        btnJump.addEventListener("touchstart", (e) => {
            e.preventDefault(); e.stopPropagation();
            const now = performance.now();
            if (now - lastJumpTime < TAP_THRESHOLD) { flightMode = !flightMode; jumpRequest = false; }
            else { if (flightMode) keys[" "] = true; else jumpRequest = true; }
            lastJumpTime = now;
        }, { passive: false });
        btnJump.addEventListener("touchend", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (flightMode) keys[" "] = false;
        }, { passive: false });
    }

    const btnSneak = document.getElementById("btn-sneak");
    if (btnSneak) {
        btnSneak.addEventListener("touchstart", (e) => {
            e.preventDefault(); e.stopPropagation();
            const now = performance.now();
            if (now - lastSneakTime < TAP_THRESHOLD) {
                sneakToggled = !sneakToggled; keys["shift"] = sneakToggled; sneakActive = sneakToggled;
            } else { keys["shift"] = true; sneakActive = true; }
            lastSneakTime = now;
        }, { passive: false });
        btnSneak.addEventListener("touchend", (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!sneakToggled) { keys["shift"] = false; sneakActive = false; }
        }, { passive: false });
    }

    // --- 2. インベントリの開閉制御 ---
    const updateInvUI = () => {
        const container = document.getElementById("inventory-container");
        if (container) container.style.display = isInventoryOpen ? "block" : "none";
        // インベントリが開いている時は視点操作のIDをリセット
        if (isInventoryOpen) {
            lookTouchId = null;
            clearTimeout(longPressTimer);
        }
    };

    // 開くボタン
    const btnInvOpen = document.getElementById("btn-inventory");
    if (btnInvOpen) {
        const openInv = (e) => {
            e.preventDefault(); e.stopPropagation();
            isInventoryOpen = true;
            updateInvUI();
        };
        btnInvOpen.addEventListener("touchstart", openInv, { passive: false });
        btnInvOpen.addEventListener("mousedown", openInv);
    }

    // 閉じるボタン
    const btnInvClose = document.getElementById("btn-inventory-close");
    if (btnInvClose) {
        const closeInv = (e) => {
            e.preventDefault(); e.stopPropagation();
            isInventoryOpen = false;
            updateInvUI();
        };
        btnInvClose.addEventListener("touchstart", closeInv, { passive: false });
        btnInvClose.addEventListener("mousedown", closeInv);
    }

    // --- 2.5 ポーズメニュー(ESC)の制御 ---
    const btnPause = document.getElementById("btn-pause");
    if (btnPause) {
        const togglePause = (e) => {
            // インベントリが開いている時はポーズボタンを無効化（誤操作防止）
            if (isInventoryOpen) return;

            e.preventDefault();
            e.stopPropagation();

            // 状態の反転とUI更新
            isPaused = !isPaused;
            if (typeof updatePauseUI === "function") {
                updatePauseUI();
            }

            // ポーズ画面を開く際、視点操作のIDをリセットして画面が回るのを防ぐ
            if (isPaused) {
                lookTouchId = null;
                if (longPressTimer) clearTimeout(longPressTimer);
                // マウス操作用のロックも解除
                if (document.exitPointerLock) document.exitPointerLock();
            }
        };

        btnPause.addEventListener("touchstart", togglePause, { passive: false });
        btnPause.addEventListener("mousedown", togglePause);
    }

    // --- 3. 視点移動 ＆ ブロック操作 ---
    canvas.addEventListener('touchstart', (e) => {
        if (isInventoryOpen) return; // インベントリ中は背景を動かさない

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (lookTouchId === null) {
                lookTouchId = touch.identifier;
                lastTouchX = touch.clientX;
                lastTouchY = touch.clientY;
                touchStartTime = performance.now();
                isLongPress = false;

                longPressTimer = setTimeout(() => {
                    isLongPress = true;
                    if (typeof startInteraction === "function") startInteraction("destroy");
                }, 500);
            }
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        if (isInventoryOpen) return;

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (touch.identifier === lookTouchId) {
                const dx = touch.clientX - lastTouchX;
                const dy = touch.clientY - lastTouchY;

                if (typeof yaw !== 'undefined' && typeof pitch !== 'undefined') {
                    yaw -= dx * TOUCH_SENSITIVITY;
                    pitch -= dy * TOUCH_SENSITIVITY;
                    pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
                }

                lastTouchX = touch.clientX;
                lastTouchY = touch.clientY;

                if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearTimeout(longPressTimer);
            }
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (touch.identifier === lookTouchId) {
                lookTouchId = null;
                clearTimeout(longPressTimer);

                const duration = performance.now() - touchStartTime;
                if (!isLongPress && duration < 300) {
                    if (typeof interactWithBlock === "function") interactWithBlock("place");
                }
                if (typeof stopInteraction === "function") stopInteraction();
            }
        }
    }, { passive: false });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupTouchControls);
} else {
    setupTouchControls();
}

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

    // 1. チャンクの描画距離変数のみを更新
    CHUNK_VISIBLE_DISTANCE = val;

    // UIの同期
    if (rangeRenderDist) rangeRenderDist.value = val;
    if (renderDistValLabel) renderDistValLabel.innerText = val;
    if (debugChunkInput) debugChunkInput.value = val;

    // 内部システムのリセット（チャンク再生成用）
    offsets = null;
    chunkQueue = [];
    lastChunk.x = null;
    lastChunk.z = null;

    if (typeof scene !== 'undefined' && scene.fog) {
        // 1. 最低でも16マス(1チャンク)分の視界を計算上の最小値として確保する
        const safeLimit = Math.max(16, val * 16);

        if (scene.fog.isFogExp2) {
            // 指数フォグ: 密度が濃くなりすぎないよう safeLimit で割る
            scene.fog.density = 0.8 / safeLimit;
        } else {
            // 線形フォグ: nearがfar(safeLimit)を超えないように調整
            // valが小さい時は足元(0)から霧を始め、遠くはsafeLimitに固定
            scene.fog.near = Math.max(0, (val - 2) * 16);
            scene.fog.far = Math.max(safeLimit, scene.fog.near + 16);
        }
    }

    // 3. 【重要】カメラと雲の設定には一切触れない
    // camera.far を変更してしまうと、cloudsky.js で描画している遠くの雲が切れてしまうため、
    // ここでは camera.far の更新（短縮）を行いません。
    // ※初期化時に camera.far = 2000〜3000 程度に設定されている前提を維持します。

    // 4. チャンク更新をリクエスト
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
   【保存システム】IndexedDB Manager (高速パレット結合版)
   ====================================================== */
const DB_CONFIG = { name: "MinecraftJS_Save", version: 1 };

/**
 * DB接続を取得する
 */
async function getDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("world_meta")) {
                db.createObjectStore("world_meta");
            }
            if (!db.objectStoreNames.contains("chunks")) {
                db.createObjectStore("chunks");
            }
        };

        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(new Error("IndexedDBのオープンに失敗しました"));
    });
}

/**
 * ワールドデータの保存
 * Uint16Arrayを文字列パレット形式に変換して一括保存
 */
async function saveWorldData(seed, playerPos, modifiedChunks, gameTime) {
    const db = await getDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(["world_meta", "chunks"], "readwrite");
        const metaStore = tx.objectStore("world_meta");
        const chunkStore = tx.objectStore("chunks");

        metaStore.put(seed, "last_seed");
        metaStore.put(playerPos, "player_pos");
        metaStore.put(gameTime, "game_time");

        if (modifiedChunks && modifiedChunks.size > 0) {
            const _idToKey = idToKey; // blocks.jsの関数

            for (const [key, dataArray] of modifiedChunks) {
                if (!dataArray) continue;

                const len = dataArray.length;
                let chunkString = "";

                // 高速な文字列結合 (オブジェクトを生成しない)
                for (let j = 0; j < len; j++) {
                    const val = dataArray[j];
                    const id = val & 0xFFF;
                    const meta = (val >> 12) & 0xF;

                    // 「キー:メタ」の形式で結合。最後以外にカンマを付ける
                    chunkString += _idToKey(id) + ":" + meta + (j === len - 1 ? "" : ",");
                }

                // 文字列として保存することで、blocks.jsの順番変更に耐性を持たせる
                chunkStore.put({ s: chunkString }, key.toString());
            }
        }

        tx.oncomplete = () => {
            console.log(`[Save] 保存完了: ${modifiedChunks ? modifiedChunks.size : 0} チャンク (CompactString)`);
            resolve();
        };
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * ワールドデータの読み込み
 * 保存時の文字列キーを現在の最新IDにマッピングし直す
 */
async function loadFullSaveData() {
    const db = await getDB();

    return new Promise((resolve, reject) => {
        const tx = db.transaction(["world_meta", "chunks"], "readonly");
        const metaStore = tx.objectStore("world_meta");
        const chunkStore = tx.objectStore("chunks");

        const reqSeed = metaStore.get("last_seed");
        const reqPos = metaStore.get("player_pos");
        const reqTime = metaStore.get("game_time");
        const reqKeys = chunkStore.getAllKeys();
        const reqValues = chunkStore.getAll();

        tx.oncomplete = () => {
            if (reqSeed.result === undefined) {
                resolve(null);
                return;
            }

            const chunks = new Map();
            const keys = reqKeys.result || [];
            const values = reqValues.result || [];
            const _keyToId = keyToId;

            for (let i = 0, len = keys.length; i < len; i++) {
                const chunkKey = Number(keys[i]);
                const chunkData = values[i];
                if (!chunkData) continue;

                let numericBlocks = null;

                // 1. 最新の文字列パレット形式 ({ s: "stone:0,..." })
                if (chunkData.s) {
                    const blockStrings = chunkData.s.split(",");
                    const bLen = blockStrings.length;
                    numericBlocks = new Uint16Array(bLen);

                    for (let j = 0; j < bLen; j++) {
                        const parts = blockStrings[j].split(":");
                        const id = _keyToId(parts[0]);
                        const meta = parseInt(parts[1]) || 0;
                        numericBlocks[j] = (id & 0xFFF) | ((meta & 0xF) << 12);
                    }
                }
                // 2. 以前のオブジェクト配列形式 ({ blocks: [{k,m}, ...] })
                else if (chunkData.blocks) {
                    const blocks = chunkData.blocks;
                    const bLen = blocks.length;
                    numericBlocks = new Uint16Array(bLen);

                    if (bLen > 0) {
                        const firstItem = blocks[0];
                        const isObjMode = (firstItem !== null && typeof firstItem === 'object');

                        for (let j = 0; j < bLen; j++) {
                            const item = blocks[j];
                            if (isObjMode) {
                                const id = _keyToId(item.k);
                                const meta = item.m ?? 0;
                                numericBlocks[j] = (id & 0xFFF) | ((meta & 0xF) << 12);
                            } else {
                                numericBlocks[j] = _keyToId(item) & 0xFFF;
                            }
                        }
                    }
                }
                // 3. 直接Uint16Arrayが保存されていた場合 (※ID不整合リスクあり)
                else if (chunkData instanceof Uint16Array) {
                    numericBlocks = new Uint16Array(chunkData);
                }

                if (numericBlocks) {
                    chunks.set(chunkKey, numericBlocks);
                }
            }

            resolve({
                seed: reqSeed.result,
                pos: reqPos.result ?? null,
                gameTime: reqTime.result ?? 6000,
                chunks: chunks
            });
        };

        tx.onerror = () => reject(tx.error);
    });
}