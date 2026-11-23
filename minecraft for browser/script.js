"use strict";
import * as THREE from './build/three.module.js';
import {
    BLOCK_CONFIG, BLOCK_TYPES, SHARED_SKY_UNIFORM, SHARED_BRIGHTNESS_UNIFORM,
    STATE_SCHEMAS, MOUNT_SUPPORT_DX, MOUNT_SUPPORT_DY, MOUNT_SUPPORT_DZ,
    onBlockRegistered, registerCustomBlock, registerGeometryBuilder, registerPlacementRule, registerSupportRule,
    getBlockStateProp, getBlockStateRawProp, setBlockStateProp, formatBlockStateString,
    getBlockMaterials, getBlockMaterialsForState, getBlockConfiguration, getBlockGeometry,
    getCollisionBoxes, getCollisionBoxesReadOnly, getSelectionBoxesReadOnly,
    getTransformMeta, isRedstoneComponent, getBlockLightEmissionForState,
    calculatePlacementMeta, canPlaceBlockAt, isSupportDependentBlock,
    getLogRotationMatrixReadOnly, applyRotationToCollisionBox, getCustomGeometryMatrix,
    idToKey, keyToId
} from './blocks.js';
import { createMinecraftBreakParticles, updateBlockParticles } from './particles.js';
import { setMinecraftSky, loadCloudTexture, updateCloudGrid, updateCloudTiles, updateCloudOpacity, adjustCloudLayerDepth } from './cloudsky.js';
import { determineBiome, BIOME_CONFIG } from './biomes/biomes.js';
import { Features } from './features.js';
import { FeatureRules } from './feature_rules.js';

// ======================================================
// 【ブロック属性 高速ルックアップテーブル一元管理】(MAX_BLOCK_IDS = 1024)
// ======================================================
const MAX_BLOCK_IDS = 1024;
const _isOpaqueBlock = new Uint8Array(MAX_BLOCK_IDS);
const _isRedstoneConductive = new Uint8Array(MAX_BLOCK_IDS);
const _blockConfigFastArray = new Array(MAX_BLOCK_IDS).fill(null);
const _blockMaterialsFastArray = new Array(MAX_BLOCK_IDS).fill(null);
const _isTransparentBlock = new Uint8Array(MAX_BLOCK_IDS);
const _isCustomGeometryBlock = new Uint8Array(MAX_BLOCK_IDS);
const _isGreedyCubeBlock = new Uint8Array(MAX_BLOCK_IDS);
const _cullSameBlock = new Uint8Array(MAX_BLOCK_IDS);
const _isLogBlock = new Uint8Array(MAX_BLOCK_IDS);

function _syncBlockFastEntry(id, cfg) {
    if (id < 0 || id >= MAX_BLOCK_IDS) return;
    _blockConfigFastArray[id] = cfg;
    _blockMaterialsFastArray[id] = null;
    if (!cfg) return;

    _isOpaqueBlock[id] = cfg.isOpaqueCube ? 1 : 0;
    _isRedstoneConductive[id] = cfg.redstoneConductive ? 1 : 0;
    _isTransparentBlock[id] = cfg.transparent ? 1 : 0;
    _cullSameBlock[id] = cfg.cullAdjacentFaces === true ? 1 : 0;
    _isLogBlock[id] = cfg.isLog === true ? 1 : 0;
    const isCubeLike = !cfg.customGeometry && (cfg.geometryType === 'cube' || cfg.geometryType === 'leaves');
    _isGreedyCubeBlock[id] = (id !== BLOCK_TYPES.SKY && isCubeLike) ? 1 : 0;
    _isCustomGeometryBlock[id] = (id !== BLOCK_TYPES.SKY && !isCubeLike && cfg.geometryType !== 'none') ? 1 : 0;
}

for (let id = 0; id < MAX_BLOCK_IDS; id++) {
    const cfg = getBlockConfiguration(id);
    if (cfg) _syncBlockFastEntry(id, cfg);
}

/* ======================================================
   【修正版・高精度ノイズ関数群】
   ====================================================== */

const p = new Uint8Array(512);
let currentSeed = 0;
// シードごとに導出する独立ノイズ空間オフセット（周期256衝突による気候相関を防止）
const _seedNoiseOffsets = {
    tempX: 13.7, tempZ: 47.3,
    humX: 91.1, humZ: 157.9,
    contX: 211.3, contZ: 73.9,
    rivX: 181.7, rivZ: 29.3
};

function applySeed(seedInput) {
    if (typeof seedInput === 'number') {
        // すでに数値（セーブデータからのロードなど）なら、そのままシードとして使う
        currentSeed = seedInput >>> 0;
    } else {
        // 文字列（新規入力）なら、ハッシュ化して数値に変換する
        let h = 2166136261 >>> 0;
        const str = (seedInput ?? Math.random()).toString();
        const len = str.length;
        for (let i = 0; i < len; i++) {
            h = Math.imul(h ^ str.charCodeAt(i), 16777619);
        }
        currentSeed = h >>> 0;
    }

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

    // 気候・大陸度・河川それぞれの独立サンプリング座標オフセットをシードから生成
    _seedNoiseOffsets.tempX = nextRand() * 256;
    _seedNoiseOffsets.tempZ = nextRand() * 256;
    _seedNoiseOffsets.humX = nextRand() * 256;
    _seedNoiseOffsets.humZ = nextRand() * 256;
    _seedNoiseOffsets.contX = nextRand() * 256;
    _seedNoiseOffsets.contZ = nextRand() * 256;
    _seedNoiseOffsets.rivX = nextRand() * 256;
    _seedNoiseOffsets.rivZ = nextRand() * 256;

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
    // 負の数でも正しく動作する高速な座標取得 (Math.floorを排除)[cite: 4]
    const xi = x > 0 ? x | 0 : (x | 0) - 1;
    const yi = y > 0 ? y | 0 : (y | 0) - 1;

    let X = xi & 255;
    let Y = yi & 255;

    let xf = x - xi;
    let yf = y - yi;

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
    // Math.floorを排除し、負の数に対応しつつ超高速化
    // (値が丁度整数の場合の境界バグも防ぐ安全な実装)
    const xi = x >= 0 ? x | 0 : (x === (x | 0) ? x | 0 : (x | 0) - 1);
    const yi = y >= 0 ? y | 0 : (y === (y | 0) ? y | 0 : (y | 0) - 1);
    const zi = z >= 0 ? z | 0 : (z === (z | 0) ? z | 0 : (z | 0) - 1);

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
    sunMesh.renderOrder = -20;
    sunMesh.frustumCulled = false;
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
    moonMesh.renderOrder = -20;
    moonMesh.frustumCulled = false;
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
        mesh.renderOrder = -25;
        mesh.frustumCulled = false;
        starGroup.add(mesh);
    });

    starGroup.renderOrder = -25;
    scene.add(starGroup);
}

function updateStars(renderTime = gameTime) {
    if (!starGroup || !player) return;

    const nightFactor = 1.0 - getSkyLightFactor(renderTime);
    const twinkle = 0.9 + Math.sin(performance.now() * 0.001) * 0.1;
    const globalAlpha = 0.65;

    for (let i = 0; i < starGroup.children.length; i++) {
        const mesh = starGroup.children[i];
        const typeAlpha = mesh.material.userData.baseAlpha || 1.0;
        mesh.material.opacity = nightFactor * twinkle * globalAlpha * typeAlpha;
    }

    const angle = (renderTime / TICKS_PER_DAY) * Math.PI * 2;
    starGroup.rotation.z = angle;
    starGroup.position.copy(player.position);

    starGroup.visible = starGroup.children[0].material.opacity > 0.001;
}

function updateSunMoonPosition(renderTime = gameTime) {
    if (!sunMesh || !moonMesh || !player) return;

    // 1. 補間済みゲーム時間から角度と向きベクトルを計算（20TPS離散管理＋高FPS滑らか移動）
    const angle = (renderTime / TICKS_PER_DAY) * Math.PI * 2;
    _tmpSunDir.set(Math.cos(angle), Math.sin(angle), 0).normalize();

    // 2. プレイヤー位置を基準とした配置
    const sunX = _tmpSunDir.x * CELESTIAL_ORBIT_RADIUS;
    const sunY = _tmpSunDir.y * CELESTIAL_ORBIT_RADIUS;

    sunMesh.position.set(player.position.x + sunX, player.position.y + sunY, player.position.z);
    sunMesh.lookAt(player.position);

    moonMesh.position.set(player.position.x - sunX, player.position.y - sunY, player.position.z);
    moonMesh.lookAt(player.position);

    // 3. 表示判定
    sunMesh.visible = (sunY > -150);
    moonMesh.visible = (sunY < 150);

    // 4. 空の色の更新
    updateSkyAndFogColor(renderTime, sunY, _tmpSunDir);
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
// --- バイオームブレンディング用定数（事前計算） ---
const BLEND_RADIUS = 4; // 9x9 広域スムージングでバイオーム境界の断崖を解消
const BLEND_SPAN = BLEND_RADIUS * 2 + 1;
const BLEND_WEIGHTS = new Float32Array(BLEND_SPAN * BLEND_SPAN);
for (let dx = -BLEND_RADIUS; dx <= BLEND_RADIUS; dx++) {
    for (let dz = -BLEND_RADIUS; dz <= BLEND_RADIUS; dz++) {
        const idx = (dx + BLEND_RADIUS) * BLEND_SPAN + (dz + BLEND_RADIUS);
        // 滑らかなガウス風減衰重み
        BLEND_WEIGHTS[idx] = 1.0 / (1.0 + 0.35 * (dx * dx + dz * dz));
    }
}

const TOTAL_WEIGHT = BLEND_WEIGHTS.reduce((a, b) => a + b, 0);
const INV_TOTAL_WEIGHT = 1.0 / TOTAL_WEIGHT;

function _clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function _smoothstep(edge0, edge1, x) {
    const t = _clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

/**
 * 統一されたバイオーム・地形パラメータ計算（循環依存を排除し全6バイオームを自然に分布）
 */
const _biomeSampleOut = { biome: null, continentalness: 0.5, riverValue: 0.5 };

function _sampleBiomeAndParams(wx, wz, out = _biomeSampleOut) {
    // フラクタルノイズの実効振幅を 1.35 倍に伸張し、雪原・砂漠・森林・平原をバランス良く分布させる
    const nTemp = fractalNoise2D(wx * 0.0006 + _seedNoiseOffsets.tempX, wz * 0.0006 + _seedNoiseOffsets.tempZ, 3);
    const nHum = fractalNoise2D(wx * 0.0006 + _seedNoiseOffsets.humX, wz * 0.0006 + _seedNoiseOffsets.humZ, 3);
    const nCont = fractalNoise2D(wx * 0.0008 + _seedNoiseOffsets.contX, wz * 0.0008 + _seedNoiseOffsets.contZ, 3);
    const nRiv = fractalNoise2D(wx * 0.0035 + _seedNoiseOffsets.rivX, wz * 0.0035 + _seedNoiseOffsets.rivZ, 2);

    const temp = _clamp01(0.5 + nTemp * 1.35);
    const humidity = _clamp01(0.5 + nHum * 1.35);
    const continentalness = _clamp01(0.5 + nCont * 1.35);
    const riverValue = _clamp01(0.5 + nRiv * 1.25);

    out.biome = determineBiome(temp, humidity, continentalness, riverValue);
    out.continentalness = continentalness;
    out.riverValue = riverValue;
    return out;
}

const _getBiomeAt = (wx, wz) => {
    return _sampleBiomeAndParams(wx, wz).biome;
};

/**
 * バイオーム基準高度＋山岳隆起カーブ＋U字型河川カービングを含む連続生高度の算出
 */
function _computeRawHeightFromSample(wx, wz, biome, continentalness, riverValue) {
    const nNoise = fractalNoise2D(wx * biome.noiseScale, wz * biome.noiseScale, 5);
    let h = biome.baseHeight + (nNoise * biome.heightVariation);

    // 1. 山岳エリア（continentalness > 0.62）の滑らかな隆起ブースター
    if (continentalness > 0.62) {
        const mFactor = _smoothstep(0.62, 0.92, continentalness);
        h += mFactor * 26.0;
    }

    // 2. 河川のU字型連続カービング（川岸の垂直段差を防ぎ、浅瀬から川底へ滑らかに彫り込む）
    if (continentalness < 0.72) {
        const riverDist = Math.abs(riverValue - 0.5);
        if (riverDist < 0.085) {
            // 中心(0.0)で 0.0、川岸外側(0.085)で 1.0 になる滑らか曲線
            const bankBlend = _smoothstep(0.018, 0.085, riverDist);
            const riverBedY = 55.5 + nNoise * 1.5;
            h = riverBedY + (h - riverBedY) * bankBlend;
        }
    }

    return h;
}

const _getRawHeightAt = (wx, wz) => {
    const s = _sampleBiomeAndParams(wx, wz);
    return _computeRawHeightFromSample(wx, wz, s.biome, s.continentalness, s.riverValue);
};

export const ChunkSaveManager = {
    modifiedChunks: new Map(),
    playerModifiedKeys: new Set(), // プレイヤー編集済み・セーブ読込済みチャンク（自動回収から保護・永続保存対象）
    dirtySaveKeys: new Set(),      // 前回セーブ以降に新たに編集されたチャンク（高速差分セーブ対象）
    decoratedChunks: new Set(),    // applyDecorations 完了済みチャンク
    chunkUpdateInfo: new Map(),

    // 共有バッファ (メモリ再確保を防止)
    _sharedSurfaceHeights: new Int32Array(256),
    _sharedHeightMap: new Int32Array(256),
    _sharedBiomeMap: new Uint8Array(256), // オブジェクトではなくIDを格納
    _sharedPaddedBiomeMap: new Uint8Array(484),      // バイオームオブジェクト用
    _sharedPaddedHeightNoiseMap: new Float32Array(484), // 事前計算済み高さノイズ用
    _sharedDataBuffer: new Uint16Array(65536),

    getBlockIndex: function (lx, ly, lz) {
        return (ly | (lz << 8) | (lx << 12)) >>> 0;
    },

    setBlock: function (cx, cz, lx, ly, lz, blockType) {
        // 1. 垂直方向の境界チェック
        const yInt = ly | 0;
        if (yInt < 0 || yInt >= CHUNK_HEIGHT) return;

        // 2. ローカル座標が 0〜15 の範囲外で渡されても対象チャンクへ正規化
        const xRaw = lx | 0;
        const zRaw = lz | 0;
        const normCx = (cx | 0) + (xRaw >> 4);
        const normCz = (cz | 0) + (zRaw >> 4);
        const lxInt = xRaw & 15;
        const lzInt = zRaw & 15;

        // 3. キーの生成とデータ取得
        const key = encodeChunkKey(normCx, normCz);
        let dataArray = this.modifiedChunks.get(key);

        // 4. データの初期化（必要な場合のみ）＋読み取りキャッシュ無効化
        if (dataArray === undefined || !this.decoratedChunks.has(key)) {
            dataArray = this.captureBaseChunkData(normCx, normCz);
            this.modifiedChunks.set(key, dataArray);
            invalidateVoxelReadCache(key);
        }

        // 5. ブロック配置 ＋ プレイヤー編集チャンクおよび未保存差分として登録
        dataArray[this.getBlockIndex(lxInt, yInt, lzInt)] = blockType & 0xFFFF;
        this.playerModifiedKeys.add(key);
        this.dirtySaveKeys.add(key);

        // 6. 更新フラグを立てる（自チャンク）
        this._markByKey(key, yInt);

        // 7. チャンク境界の隣接更新（辺・角を厳密にマーク）
        const touchNegX = (lxInt === 0);
        const touchPosX = (lxInt === 15);
        const touchNegZ = (lzInt === 0);
        const touchPosZ = (lzInt === 15);

        if (touchNegX) {
            this._markByKey(encodeChunkKey(normCx - 1, normCz), yInt);
        } else if (touchPosX) {
            this._markByKey(encodeChunkKey(normCx + 1, normCz), yInt);
        }

        if (touchNegZ) {
            this._markByKey(encodeChunkKey(normCx, normCz - 1), yInt);
        } else if (touchPosZ) {
            this._markByKey(encodeChunkKey(normCx, normCz + 1), yInt);
        }

        // X・Z両端に同時接触している場合のみ斜め角チャンクをマーク
        if (touchNegX && touchNegZ) {
            this._markByKey(encodeChunkKey(normCx - 1, normCz - 1), yInt);
        } else if (touchNegX && touchPosZ) {
            this._markByKey(encodeChunkKey(normCx - 1, normCz + 1), yInt);
        } else if (touchPosX && touchNegZ) {
            this._markByKey(encodeChunkKey(normCx + 1, normCz - 1), yInt);
        } else if (touchPosX && touchPosZ) {
            this._markByKey(encodeChunkKey(normCx + 1, normCz + 1), yInt);
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

    // 1. 純粋な基本地形の生成（石・土・砂・雪・水・洞窟・岩盤凹凸・7種鉱石/砂利ポケット）
    generateBaseTerrain: function (cx, cz) {
        const data = this._sharedDataBuffer;
        data.fill(0);
        const baseX = (cx << 4) | 0;
        const baseZ = (cz << 4) | 0;

        const {
            SKY, STONE, DIRT, WATER, LAVA, BEDROCK, GRAVEL,
            COAL_ORE, IRON_ORE, GOLD_ORE, REDSTONE_ORE, LAPIS_ORE, EMERALD_ORE
        } = BLOCK_TYPES;
        const MOUNTAINS_ID = 4;
        const seaLevel = SEA_LEVEL | 0;

        const heightMap = this._sharedHeightMap;
        const biomeMap = this._sharedBiomeMap;
        // BLEND_RADIUS = 4 -> 24 x 24 = 576 セル（従来の484以上へ拡張）
        if (this._sharedPaddedBiomeMap.length < 576) {
            this._sharedPaddedBiomeMap = new Uint8Array(576);
            this._sharedPaddedHeightNoiseMap = new Float32Array(576);
        }
        const paddedBiomeMap = this._sharedPaddedBiomeMap;
        const paddedHMap = this._sharedPaddedHeightNoiseMap;

        const blendRadius = BLEND_RADIUS | 0; // 4
        const paddedSize = 24 | 0;

        // バイオーム割当 & 生高度事前計算
        const start = -blendRadius;
        const end = 16 + blendRadius;
        const zBaseOffset = blendRadius;

        for (let x = start, xOff = 0; x < end; x++, xOff += paddedSize) {
            const worldX = (baseX + x) | 0;

            for (let z = start; z < end; z++) {
                const worldZ = (baseZ + z) | 0;
                const localIdx = (xOff + (z + zBaseOffset)) | 0;

                const s = _sampleBiomeAndParams(worldX, worldZ);
                paddedBiomeMap[localIdx] = s.biome.id;
                paddedHMap[localIdx] = _computeRawHeightFromSample(
                    worldX, worldZ, s.biome, s.continentalness, s.riverValue
                );
            }
        }

        // 地形・洞窟・岩盤凹凸・鉱石・表土の一括生成
        const surfaceHeights = this._sharedSurfaceHeights;
        surfaceHeights.fill(0);

        const scaleXZ = CAVE_SCALE_XZ;
        const scaleY = CAVE_SCALE_Y;
        const seedMix = currentSeed | 0;

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
                const isMountainBiome = (currentBiomeId === MOUNTAINS_ID);

                // 9x9 広域ガウス風ブレンディングによる滑らかな地表高度計算
                let totalHeight = 0.0;
                let weightIdx = 0;
                for (let dx = -blendRadius; dx <= blendRadius; dx = (dx + 1) | 0) {
                    const xShift = ((x + dx + blendRadius) * paddedSize) | 0;
                    for (let dz = -blendRadius; dz <= blendRadius; dz = (dz + 1) | 0) {
                        totalHeight += paddedHMap[xShift + (z + dz + blendRadius) | 0] * BLEND_WEIGHTS[weightIdx++];
                    }
                }
                const sHeight = (totalHeight * INV_TOTAL_WEIGHT) | 0;
                heightMap[mapIdx] = sHeight;
                surfaceHeights[mapIdx] = sHeight;

                // 表土レイヤーの計算
                const filler = biome.fillerBlock | 0;
                const top = biome.topBlock | 0;
                const dirtEnd = (sHeight - 1) | 0;
                let stoneEnd = (sHeight - 4) | 0;
                if (stoneEnd < 1) stoneEnd = 1;

                // Y=0 は必ず岩盤（破壊不能最下層）
                data[xzOff] = BEDROCK;

                // 列固有ハッシュ（岩盤凹凸Y=1..4と鉱石サンプリングの高速化）
                let colHash = (Math.imul(worldX, 374761393) ^ Math.imul(worldZ, 668265263) ^ seedMix) | 0;
                colHash = (Math.imul(colHash ^ (colHash >>> 13), 1274126177)) >>> 0;
                const bedrockTopY = 1 + (colHash & 3); // Y=1〜4 まで本家準拠のランダム岩盤層

                const maxY = sHeight > seaLevel ? sHeight : seaLevel;

                for (let y = 1; y <= maxY; y = (y + 1) | 0) {
                    const idx = (xzOff + y) | 0;

                    if (y < sHeight) {
                        // 岩盤層 (Y=1..4)
                        if (y <= bedrockTopY) {
                            data[idx] = BEDROCK;
                            continue;
                        }

                        // 洞窟判定 (Y=5以上。川底・海底では水面下の遮水層3マスを保護し水底の穴あき黒ずみを防止)
                        const caveMaxY = (sHeight <= seaLevel) ? (sHeight - 3) : sHeight;
                        if (y >= 5 && y < caveMaxY && isCave(worldX, y, worldZ, sHeight, nx, y * scaleY, nz)) {
                            data[idx] = (y <= 11) ? LAVA : SKY;
                            continue;
                        }

                        // 表土レイヤー判定（水面下では top を filler へ置換）
                        if (y >= stoneEnd) {
                            data[idx] = (y === dirtEnd && dirtEnd >= seaLevel) ? top : filler;
                            continue;
                        }

                        // 地下石層の鉱石・砂利ポケット生成（3D空間決定論ハッシュ＋塊連続判定）
                        let h3 = (colHash ^ Math.imul(y, 2246822519)) | 0;
                        h3 = (Math.imul(h3 ^ (h3 >>> 16), 3266489917)) >>> 0;
                        const roll = h3 & 1023; // 0..1023 の高速一様乱数

                        let blockToPlace = STONE;
                        if (y <= 16 && roll < 10) {
                            blockToPlace = REDSTONE_ORE;
                        } else if (y <= 32 && roll >= 10 && roll < 16) {
                            blockToPlace = GOLD_ORE;
                        } else if (y >= 10 && y <= 32 && roll >= 16 && roll < 21) {
                            blockToPlace = LAPIS_ORE;
                        } else if (isMountainBiome && y <= 32 && roll >= 21 && roll < 25) {
                            blockToPlace = EMERALD_ORE;
                        } else if (y <= 64 && roll >= 25 && roll < 43) {
                            blockToPlace = IRON_ORE;
                        } else if (y <= 128 && roll >= 43 && roll < 67) {
                            blockToPlace = COAL_ORE;
                        } else if (y <= 60 && roll >= 67 && roll < 83) {
                            blockToPlace = GRAVEL;
                        }

                        data[idx] = blockToPlace;

                    } else if (y >= sHeight && y <= seaLevel) {
                        data[idx] = WATER;
                    }
                }
            }
        }

        return data;
    },

    // 1. ベース地形（デコレーション無し）のみを安全に確保・取得する
    getOrCreateBaseTerrain: function (cx, cz) {
        const key = encodeChunkKey(cx, cz);
        let dataArray = this.modifiedChunks.get(key);
        if (dataArray === undefined) {
            const data = this.generateBaseTerrain(cx, cz);
            dataArray = new Uint16Array(data);
            this.modifiedChunks.set(key, dataArray);
        }
        return dataArray;
    },

    // 2. ワールド座標系でブロックを配置（木・構造物と草花の上書き権限を分離しロード順非依存を実現）
    setBlockWorldDecoration: function (wx, wy, wz, blockId, allowOverwrite, allowLeafOverwrite = true) {
        if (wy < 0 || wy >= CHUNK_HEIGHT) return;
        const cx = wx >> 4;
        const cz = wz >> 4;
        const lx = wx & 15;
        const lz = wz & 15;

        const dataArray = this.getOrCreateBaseTerrain(cx, cz);
        const idx = (wy | (lz << 8) | (lx << 12)) | 0;
        const currentId = dataArray[idx] & 0xFFF;

        const SKY = BLOCK_TYPES.SKY;
        const LEAVES = BLOCK_TYPES.LEAVES_OAK;

        if (
            currentId === SKY ||
            (allowLeafOverwrite && currentId === LEAVES) ||
            allowOverwrite
        ) {
            dataArray[idx] = blockId;
            this._markChunkForUpdate(cx, cz, wy);
        }
    },

    // 3. ワールド座標系で正確なブロックを取得（空中生成の防止）
    getBlockWorldDecoration: function (wx, wy, wz) {
        if (wy < 0 || wy >= CHUNK_HEIGHT) return BLOCK_TYPES.SKY;
        const cx = wx >> 4;
        const cz = wz >> 4;
        const lx = wx & 15;
        const lz = wz & 15;

        const dataArray = this.getOrCreateBaseTerrain(cx, cz);
        const idx = (wy | (lz << 8) | (lx << 12)) | 0;
        return dataArray[idx] & 0xFFF;
    },

    // 4. デコレーション適用処理（高速地表探索・葉保護・決定論的乱数）
    applyDecorations: function (cx, cz) {
        const baseX = (cx << 4) | 0;
        const baseZ = (cz << 4) | 0;
        const seaLevel = SEA_LEVEL | 0;

        const centerData = this.getOrCreateBaseTerrain(cx, cz);

        const sampleBiome = _getBiomeAt(baseX + 8, baseZ + 8);
        const biomeRuleConfig = FeatureRules[sampleBiome.id] ?? FeatureRules[sampleBiome.name] ?? FeatureRules['Default'];

        const attempts = biomeRuleConfig.attempts;
        const rules = biomeRuleConfig.rules;
        if (attempts === 0 || rules.length === 0) return;

        const getBlockWorld = (wx, wy, wz) => this.getBlockWorldDecoration(wx, wy, wz);
        // 木・構造物は葉っぱの上書きを許可、草花はSKYのみ配置（隣接チャンクの葉を突き破る非決定性を防止）
        const setBlockStructure = (wx, wy, wz, bid, ow) => this.setBlockWorldDecoration(wx, wy, wz, bid, ow, true);
        const setBlockPlant = (wx, wy, wz, bid, ow) => this.setBlockWorldDecoration(wx, wy, wz, bid, ow, false);

        const {
            SKY, WATER, LAVA, LEAVES_OAK, LOG_OAK,
            TALLGRASS, FLOWER, FLOWER_ROSE, MUSHROOM_RED, MUSHROOM_BROWN, DEADBUSH
        } = BLOCK_TYPES;

        for (let i = 0; i < attempts; i = (i + 1) | 0) {
            let h = Math.imul(baseX ^ (baseZ << 16), 16777619);
            h = Math.imul(h ^ (currentSeed + i), 16777619);
            h = (h ^ (h >>> 16)) >>> 0;

            const lx = ((h & 0xFFFF) * 16) >> 16;
            const lz = (((h >>> 16) & 0xFFFF) * 16) >> 16;
            const worldX = baseX + lx;
            const worldZ = baseZ + lz;

            let rnd = ((Math.imul(h, 31) >>> 0) / 4294967296);

            // 自チャンク配列を直接走査して真の地面Yを高速特定（木の葉・幹・既存植物・水は除外）
            const colBase = (lz << 8) | (lx << 12);
            let surfaceY = -1;
            for (let y = CHUNK_HEIGHT - 1; y > seaLevel; y--) {
                const block = centerData[colBase | y] & 0xFFF;
                if (block === SKY) continue;
                if (
                    block !== LEAVES_OAK &&
                    block !== LOG_OAK &&
                    block !== TALLGRASS &&
                    block !== FLOWER &&
                    block !== FLOWER_ROSE &&
                    block !== MUSHROOM_RED &&
                    block !== MUSHROOM_BROWN &&
                    block !== DEADBUSH &&
                    block !== WATER &&
                    block !== LAVA
                ) {
                    surfaceY = y + 1;
                    break;
                }
            }

            if (surfaceY <= seaLevel || surfaceY >= CHUNK_HEIGHT) continue;

            for (let j = 0; j < rules.length; j = (j + 1) | 0) {
                const rule = rules[j];
                const chance = rule.chance;

                if (rnd < chance) {
                    const featureFunc = Features[rule.feature];
                    if (featureFunc) {
                        const setter = rule.isStructure ? setBlockStructure : setBlockPlant;
                        featureFunc(worldX, surfaceY, worldZ, setter, rnd / chance, getBlockWorld, worldX, worldZ);
                    }
                    break;
                }
                rnd -= chance;
                if (rnd < 0) break;
            }
        }
    },

    // 5. チャンクデータ取得の入り口を整理（デコレーション完了フラグで二重適用を防止）
    captureBaseChunkData: function (cx, cz) {
        const key = encodeChunkKey(cx, cz);
        const dataArray = this.getOrCreateBaseTerrain(cx, cz);

        if (!this.decoratedChunks.has(key)) {
            this.decoratedChunks.add(key);
            this.applyDecorations(cx, cz);
        }

        return dataArray;
    },

    clearUpdateFlag: function (cx, cz) {
        const key = encodeChunkKey(cx, cz);
        const info = this.chunkUpdateInfo.get(key);
        if (info) info.needsRebuild = false;
    }
};

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


const MAX_CACHE_SIZE = 15000;
const terrainHeightCache = new Map();

const SEA_LEVEL = 62;             // 本家マイクラの海面(Y=62)

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

const globalTempVec3 = new THREE.Vector3();
const globalTempVec3b = new THREE.Vector3();
const globalTempVec3c = new THREE.Vector3();

const lastCamPos = new THREE.Vector3();
const lastCamRot = new THREE.Euler();

const BEDROCK_LEVEL = 0;

// ----- スポーン位置の動的設定 -----
const spawnX = 0;
const spawnZ = 0;

// 本来の地表の高さ + 余裕を持たせた2ブロック上
const spawnY = Math.max(getTerrainHeight(spawnX, spawnZ), SEA_LEVEL + 5) + 2;

let jumpCooldown = 0;
// プレイヤーデータ
const player = {
    position: new THREE.Vector3(spawnX, spawnY, spawnZ),
    prevPosition: new THREE.Vector3(spawnX, spawnY, spawnZ),
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
const MAX_RENDER_PIXEL_RATIO = 2;

function initCanvas() {
    // 1. レンダラーの生成（logarithmicDepthBuffer 廃止で GPU Early-Z 有効化 ＋ r128 シェーダー同期検査オフ）
    renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
        stencil: false
    });
    // three.js r128 最適化: 初回シェーダーコンパイル時の同期 gl.getProgramParameter ストールを回避
    renderer.debug.checkShaderErrors = false;
    renderer.setClearColor(fogColor);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO));

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

    // --- C. ズーム・ピンチ防止 ---
    renderer.domElement.addEventListener('wheel', e => {
        if (e.ctrlKey) e.preventDefault();
    }, { passive: false });

    renderer.domElement.addEventListener('touchmove', e => {
        if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });
}
let targetCamPos = player.position.clone().add(new THREE.Vector3(0, getCurrentPlayerHeight(), 0));
camera.position.copy(targetCamPos);
// （全ブロック・雲・天体・パーティクルは自前ライトマップ＋MeshBasicMaterialで描画するため、未使用の Three.js ライトを撤去）

// 初期化部分 (script.js の上の方)
const selectionGroup = new THREE.Group();
scene.add(selectionGroup);


/* ======================================================
   【プレイヤーAABB・衝突判定関連】最新最適化版
   ====================================================== */

// --- 外部変数の定義（GC防止用の再利用オブジェクト） ---
const _tempAABB = new THREE.Box3();

function getPlayerAABB(pos = player.position, size = null) {
    const h = (size !== null) ? size.h : (sneakActive ? SNEAK_HEIGHT : PLAYER_HEIGHT);
    const r = (size !== null) ? size.r : (PLAYER_RADIUS - COLLISION_MARGIN);

    let feetY = pos.y;
    if (player.positionIsCenter === true) {
        feetY -= (h * 0.5);
    }

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
   【衝突判定キャッシュ＆ゼロGCブロードフェーズ収集バッファ】
   ====================================================== */

export const blockCollisionBoxCache = new Map();
const pooledBoxArray = [];

// particles.js 互換のため初期化時にカスタム形状ボックスを事前登録
for (const cfg of Object.values(BLOCK_CONFIG)) {
    if (cfg.collision !== false && cfg.geometryType && cfg.geometryType !== "cube" && cfg.geometryType !== "none") {
        blockCollisionBoxCache.set(cfg.id, getCollisionBoxesReadOnly(cfg.geometryType, 0));
    }
}

function getPooledBox() {
    return pooledBoxArray.length ? pooledBoxArray.pop() : new THREE.Box3();
}

function releasePooledBox(b) {
    if (!b) return;
    b.makeEmpty();
    if (pooledBoxArray.length < POOL_MAX) pooledBoxArray.push(b);
}

// 1フレームの移動領域内にある衝突ボックスを連続メモリへ格納する再利用バッファ [minX,minY,minZ,maxX,maxY,maxZ]
const MAX_COLL_BOXES = 512;
const _collBoxes = new Float64Array(MAX_COLL_BOXES * 6);
const _collRotBox = new THREE.Box3();

const COLL_OVERLAP_EPS = 1e-6;
const COLL_SNAP_EPS = 1e-4;

/**
 * 指定ワールド範囲と交差し得る全衝突ボックスを _collBoxes へ一括収集する（ゼロGC）
 * @returns {number} 収集したボックス数
 */
function collectCollisionBoxes(sMinX, sMinY, sMinZ, sMaxX, sMaxY, sMaxZ) {
    const ix0 = Math.floor(sMinX) | 0;
    const ix1 = Math.floor(sMaxX) | 0;
    // 下段にある高さ1.5ブロック（フェンス）を取りこぼさないよう -0.55 下から走査
    const iy0 = Math.floor(sMinY - 0.55) | 0;
    const iy1 = Math.floor(sMaxY) | 0;
    const iz0 = Math.floor(sMinZ) | 0;
    const iz1 = Math.floor(sMaxZ) | 0;

    let count = 0;
    let ptr = 0;

    for (let y = iy0; y <= iy1; y = (y + 1) | 0) {
        if (y < 0 || y >= CHUNK_HEIGHT) continue;
        for (let x = ix0; x <= ix1; x = (x + 1) | 0) {
            for (let z = iz0; z <= iz1; z = (z + 1) | 0) {
                const rawVoxel = getVoxelAtWorld(x, y, z, true) | 0;
                if (rawVoxel <= 0) continue;

                const id = rawVoxel & 0xFFF;
                const cfg = _blockConfigFastArray[id];
                if (!cfg || cfg.collision === false) continue;

                const gType = cfg.geometryType;

                // 高速パス: フルキューブ（世界の大部分）は回転・キャッシュ参照なしで直書き
                if (!gType || gType === "cube" || gType === "leaves") {
                    if (count >= MAX_COLL_BOXES) return count;
                    _collBoxes[ptr] = x;
                    _collBoxes[ptr + 1] = y;
                    _collBoxes[ptr + 2] = z;
                    _collBoxes[ptr + 3] = x + 1;
                    _collBoxes[ptr + 4] = y + 1;
                    _collBoxes[ptr + 5] = z + 1;
                    ptr += 6;
                    count++;
                    continue;
                }

                const meta = (rawVoxel >> 12) & 0xF;
                const relBoxes = getCollisionBoxesReadOnly(gType, meta);
                const tMeta = getTransformMeta(id, meta);

                for (let j = 0, len = relBoxes.length; j < len; j++) {
                    if (count >= MAX_COLL_BOXES) return count;
                    let src = relBoxes[j];
                    if (tMeta !== 0) {
                        applyRotationToCollisionBox(src, tMeta, _collRotBox);
                        src = _collRotBox;
                    }
                    _collBoxes[ptr] = x + src.min.x;
                    _collBoxes[ptr + 1] = y + src.min.y;
                    _collBoxes[ptr + 2] = z + src.min.z;
                    _collBoxes[ptr + 3] = x + src.max.x;
                    _collBoxes[ptr + 4] = y + src.max.y;
                    _collBoxes[ptr + 5] = z + src.max.z;
                    ptr += 6;
                    count++;
                }
            }
        }
    }

    return count;
}

/**
 * 解析的Y軸オフセット解決（Minecraft Java Edition VoxelShape.collide 準拠）
 */
function clipAxisY(aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ, dy, boxCount) {
    if (dy === 0 || boxCount === 0) return dy;

    for (let i = 0, ptr = 0; i < boxCount; i++, ptr += 6) {
        if (
            aMaxX <= _collBoxes[ptr] + COLL_OVERLAP_EPS ||
            aMinX >= _collBoxes[ptr + 3] - COLL_OVERLAP_EPS ||
            aMaxZ <= _collBoxes[ptr + 2] + COLL_OVERLAP_EPS ||
            aMinZ >= _collBoxes[ptr + 5] - COLL_OVERLAP_EPS
        ) continue;

        if (dy > 0) {
            const bMinY = _collBoxes[ptr + 1];
            if (bMinY >= aMaxY - COLL_SNAP_EPS) {
                const diff = bMinY - aMaxY;
                if (diff < dy) dy = diff > 0 ? diff : 0;
            }
        } else {
            const bMaxY = _collBoxes[ptr + 4];
            if (bMaxY <= aMinY + COLL_SNAP_EPS) {
                const diff = bMaxY - aMinY;
                if (diff > dy) dy = diff < 0 ? diff : 0;
            }
        }
    }
    return dy;
}

/**
 * 解析的X軸オフセット解決（Minecraft Java Edition VoxelShape.collide 準拠）
 */
function clipAxisX(aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ, dx, boxCount) {
    if (dx === 0 || boxCount === 0) return dx;

    for (let i = 0, ptr = 0; i < boxCount; i++, ptr += 6) {
        if (
            aMaxY <= _collBoxes[ptr + 1] + COLL_OVERLAP_EPS ||
            aMinY >= _collBoxes[ptr + 4] - COLL_OVERLAP_EPS ||
            aMaxZ <= _collBoxes[ptr + 2] + COLL_OVERLAP_EPS ||
            aMinZ >= _collBoxes[ptr + 5] - COLL_OVERLAP_EPS
        ) continue;

        if (dx > 0) {
            const bMinX = _collBoxes[ptr];
            if (bMinX >= aMaxX - COLL_SNAP_EPS) {
                const diff = bMinX - aMaxX;
                if (diff < dx) dx = diff > 0 ? diff : 0;
            }
        } else {
            const bMaxX = _collBoxes[ptr + 3];
            if (bMaxX <= aMinX + COLL_SNAP_EPS) {
                const diff = bMaxX - aMinX;
                if (diff > dx) dx = diff < 0 ? diff : 0;
            }
        }
    }
    return dx;
}

/**
 * 解析的Z軸オフセット解決（Minecraft Java Edition VoxelShape.collide 準拠）
 */
function clipAxisZ(aMinX, aMinY, aMinZ, aMaxX, aMaxY, aMaxZ, dz, boxCount) {
    if (dz === 0 || boxCount === 0) return dz;

    for (let i = 0, ptr = 0; i < boxCount; i++, ptr += 6) {
        if (
            aMaxX <= _collBoxes[ptr] + COLL_OVERLAP_EPS ||
            aMinX >= _collBoxes[ptr + 3] - COLL_OVERLAP_EPS ||
            aMaxY <= _collBoxes[ptr + 1] + COLL_OVERLAP_EPS ||
            aMinY >= _collBoxes[ptr + 4] - COLL_OVERLAP_EPS
        ) continue;

        if (dz > 0) {
            const bMinZ = _collBoxes[ptr + 2];
            if (bMinZ >= aMaxZ - COLL_SNAP_EPS) {
                const diff = bMinZ - aMaxZ;
                if (diff < dz) dz = diff > 0 ? diff : 0;
            }
        } else {
            const bMaxZ = _collBoxes[ptr + 5];
            if (bMaxZ <= aMinZ + COLL_SNAP_EPS) {
                const diff = bMaxZ - aMinZ;
                if (diff > dz) dz = diff < 0 ? diff : 0;
            }
        }
    }
    return dz;
}

/**
 * 収集済み _collBoxes 内に指定AABBと重なるボックスが存在するか高速判定（スニークエッジ判定用）
 */
function hasOverlapInBuffer(minX, minY, minZ, maxX, maxY, maxZ, boxCount) {
    for (let i = 0, ptr = 0; i < boxCount; i++, ptr += 6) {
        if (
            maxX > _collBoxes[ptr] + COLL_OVERLAP_EPS &&
            minX < _collBoxes[ptr + 3] - COLL_OVERLAP_EPS &&
            maxY > _collBoxes[ptr + 1] + COLL_OVERLAP_EPS &&
            minY < _collBoxes[ptr + 4] - COLL_OVERLAP_EPS &&
            maxZ > _collBoxes[ptr + 2] + COLL_OVERLAP_EPS &&
            minZ < _collBoxes[ptr + 5] - COLL_OVERLAP_EPS
        ) {
            return true;
        }
    }
    return false;
}

/* ======================================================
   【極限最適化版】静的AABB交差判定（ゼロGC・フルキューブ高速パス）
   ====================================================== */
function checkAABBCollision(aabb) {
    const aMinX = aabb.min.x, aMinY = aabb.min.y, aMinZ = aabb.min.z;
    const aMaxX = aabb.max.x, aMaxY = aabb.max.y, aMaxZ = aabb.max.z;

    const ix0 = Math.floor(aMinX) | 0;
    const ix1 = Math.floor(aMaxX) | 0;
    const iy0 = Math.floor(aMinY - 0.55) | 0;
    const iy1 = Math.floor(aMaxY) | 0;
    const iz0 = Math.floor(aMinZ) | 0;
    const iz1 = Math.floor(aMaxZ) | 0;

    for (let y = iy0; y <= iy1; y = (y + 1) | 0) {
        if (y < 0 || y >= CHUNK_HEIGHT) continue;
        for (let x = ix0; x <= ix1; x = (x + 1) | 0) {
            for (let z = iz0; z <= iz1; z = (z + 1) | 0) {
                const rawVoxel = getVoxelAtWorld(x, y, z, true) | 0;
                if (rawVoxel <= 0) continue;

                const id = rawVoxel & 0xFFF;
                const cfg = _blockConfigFastArray[id];
                if (!cfg || cfg.collision === false) continue;

                const gType = cfg.geometryType;
                if (!gType || gType === "cube" || gType === "leaves") {
                    if (
                        aMaxX > x + COLL_OVERLAP_EPS && aMinX < x + 1 - COLL_OVERLAP_EPS &&
                        aMaxY > y + COLL_OVERLAP_EPS && aMinY < y + 1 - COLL_OVERLAP_EPS &&
                        aMaxZ > z + COLL_OVERLAP_EPS && aMinZ < z + 1 - COLL_OVERLAP_EPS
                    ) {
                        return true;
                    }
                    continue;
                }

                const meta = (rawVoxel >> 12) & 0xF;
                const relBoxes = getCollisionBoxesReadOnly(gType, meta);
                const tMeta = getTransformMeta(id, meta);

                for (let j = 0, len = relBoxes.length; j < len; j++) {
                    let src = relBoxes[j];
                    if (tMeta !== 0) {
                        applyRotationToCollisionBox(src, tMeta, _collRotBox);
                        src = _collRotBox;
                    }
                    if (
                        aMaxX > x + src.min.x + COLL_OVERLAP_EPS && aMinX < x + src.max.x - COLL_OVERLAP_EPS &&
                        aMaxY > y + src.min.y + COLL_OVERLAP_EPS && aMinY < y + src.max.y - COLL_OVERLAP_EPS &&
                        aMaxZ > z + src.min.z + COLL_OVERLAP_EPS && aMinZ < z + src.max.z - COLL_OVERLAP_EPS
                    ) {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}

function getTerrainHeight(worldX, worldZ) {
    const xInt = worldX | 0;
    const zInt = worldZ | 0;

    // --- 1. 高速キャッシュルックアップ ---
    // 0xFFFFパッキングは±32767の範囲で有効。広大な世界なら `${xInt},${zInt}` 等を検討。
    const key = ((xInt & 0xFFFF) << 16) | (zInt & 0xFFFF);
    const cached = terrainHeightCache.get(key);
    if (cached !== undefined) return cached;

    // --- 2. 統一ロジックによる計算 (重要) ---
    const result = _getRawHeightAt(xInt, zInt) | 0;

    // --- 3. キャッシュ管理 (GCスパイク対策維持) ---
    if (terrainHeightCache.size >= MAX_CACHE_SIZE) {
        const iter = terrainHeightCache.keys();
        for (let i = 0; i < 500; i = (i + 1) | 0) {
            const k = iter.next().value;
            if (k === undefined) break;
            terrainHeightCache.delete(k);
        }
    }

    terrainHeightCache.set(key, result);
    return result;
}

function getVoxelHash(x, y, z) {
    const ox = (x + 512 | 0) & 0x3FF;
    const oz = (z + 512 | 0) & 0x3FF;
    const oy = (y | 0) & 0xFFF;
    return (ox << 21) | (oz << 11) | oy;
}

// --- 関数の外側に配置 (読み取りキャッシュ用：1チャンク128KBのため上限64件=最大8MBに厳格制限) ---
const MAX_READONLY_CHUNK_CACHE = 64;
const chunkReadOnlyCache = new Map();
let _vC0_key = null, _vC0_data = null;
let _vC1_key = null, _vC1_data = null;

function invalidateVoxelReadCache(chunkKey) {
    if (_vC0_key === chunkKey) {
        _vC0_key = null;
        _vC0_data = null;
    }
    if (_vC1_key === chunkKey) {
        _vC1_key = null;
        _vC1_data = null;
    }
    chunkReadOnlyCache.delete(chunkKey);
}

/**
 * ワールド座標からブロックデータを取得する (超高速・データ完全保持・二重キャッシュ防止版)
 * @param {number} x, y, z - ワールド座標
 * @param {boolean} isRaw - true: メタデータ込み(16bit), false: IDのみ(12bit)
 */
export function getVoxelAtWorld(x, y, z, isRaw = false) {
    const fy = y | 0;
    if (fy & ~255) return 0;

    const fx = x | 0;
    const fz = z | 0;
    const chunkKey = encodeChunkKey(fx >> 4, fz >> 4);

    let data = null;

    if (chunkKey === _vC0_key) {
        data = _vC0_data;
    } else if (chunkKey === _vC1_key) {
        data = _vC1_data;
        _vC1_key = _vC0_key; _vC1_data = _vC0_data;
        _vC0_key = chunkKey; _vC0_data = data;
    } else {
        data = ChunkSaveManager.modifiedChunks.get(chunkKey) || chunkReadOnlyCache.get(chunkKey);

        if (!data) {
            data = ChunkSaveManager.captureBaseChunkData(fx >> 4, fz >> 4);
            if (!data) return 0;

            // modifiedChunks に未登録の配列のみ読み取りキャッシュへ格納し二重保持を防止
            if (!ChunkSaveManager.modifiedChunks.has(chunkKey)) {
                chunkReadOnlyCache.set(chunkKey, data);
                if (chunkReadOnlyCache.size > MAX_READONLY_CHUNK_CACHE) {
                    const firstKey = chunkReadOnlyCache.keys().next().value;
                    chunkReadOnlyCache.delete(firstKey);
                }
            }
        }

        _vC1_key = _vC0_key; _vC1_data = _vC0_data;
        _vC0_key = chunkKey; _vC0_data = data;
    }

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
    const depth = (surfaceHeight - y) | 0;
    if (depth <= 0) return false;

    // 深度に応じた閾値を先に算出（depth = 3, 4 で CAVE_THRESHOLD を超えるケースに対応）
    let currentThreshold = CAVE_THRESHOLD;
    if (depth < 5) {
        currentThreshold *= (depth * 0.16 + 0.6);
    }

    const n1 = perlinNoise3D(nx, ny, nz);
    // 正しい currentThreshold をベースに先行して高速に弾く
    if (n1 >= currentThreshold || n1 <= -currentThreshold) {
        return false;
    }

    // 2つ目のノイズ計算
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
/* ======================================================
   【解析的軸別スイープ衝突解決】（Minecraft Java Edition Entity.collide 準拠）
   ====================================================== */

const MAX_STEP_HEIGHT = 0.6;
const SNEAK_BACKOFF_STEP = 0.05;

const COLLISION_DIRECTIONS = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, -1, 0)
];
const _moveTempVec = new THREE.Vector3();
const _playerSizeTmp = { h: PLAYER_HEIGHT, r: PLAYER_RADIUS - COLLISION_MARGIN };

/**
 * プレイヤーの移動衝突解決 ＋ 異常めり込み時の安全脱出（ゼロGC）
 */
function resolvePlayerCollision() {
    axisSeparatedCollisionResolve(dt);

    _playerSizeTmp.h = getCurrentPlayerHeight();
    _playerSizeTmp.r = PLAYER_RADIUS - COLLISION_MARGIN;

    if (!checkAABBCollision(getPlayerAABB(player.position, _playerSizeTmp))) return;

    let bestDir = null;
    let bestDist = Infinity;

    for (let i = 0; i < COLLISION_DIRECTIONS.length; i++) {
        const dir = COLLISION_DIRECTIONS[i];
        let low = 0, high = 1.0;
        let foundDist = null;

        for (let j = 0; j < 8; j++) {
            const mid = (low + high) * 0.5;
            _moveTempVec.copy(player.position).addScaledVector(dir, mid);

            if (!checkAABBCollision(getPlayerAABB(_moveTempVec, _playerSizeTmp))) {
                foundDist = mid;
                high = mid;
            } else {
                low = mid;
            }
        }

        if (foundDist !== null && foundDist < bestDist) {
            bestDist = foundDist;
            bestDir = dir;
            if (bestDist < 0.01) break;
        }
    }

    if (bestDir) {
        player.position.addScaledVector(bestDir, bestDist);
    } else if (!wasUnderwater && !flightMode) {
        player.position.y += 0.1;
    }
}

/**
 * スニーク中の足場エッジ落下防止（Minecraft Java Edition Player.maybeBackOffFromEdge 準拠）
 * 収集済み _collBoxes を再利用するため追加のボクセル取得ゼロ
 */
const _backoffOut = { dx: 0, dz: 0 };

function backOffFromEdge(aMinX, aMinY, aMinZ, aMaxX, aMaxZ, dx, dz, boxCount) {
    const checkMinY = aMinY - MAX_STEP_HEIGHT;
    const checkMaxY = aMinY - 1e-4;

    // 1. X軸方向の落下防止
    while (dx !== 0 && !hasOverlapInBuffer(aMinX + dx, checkMinY, aMinZ, aMaxX + dx, checkMaxY, aMaxZ, boxCount)) {
        if (dx < SNEAK_BACKOFF_STEP && dx >= -SNEAK_BACKOFF_STEP) dx = 0;
        else if (dx > 0) dx -= SNEAK_BACKOFF_STEP;
        else dx += SNEAK_BACKOFF_STEP;
    }

    // 2. Z軸方向の落下防止
    while (dz !== 0 && !hasOverlapInBuffer(aMinX, checkMinY, aMinZ + dz, aMaxX, checkMaxY, aMaxZ + dz, boxCount)) {
        if (dz < SNEAK_BACKOFF_STEP && dz >= -SNEAK_BACKOFF_STEP) dz = 0;
        else if (dz > 0) dz -= SNEAK_BACKOFF_STEP;
        else dz += SNEAK_BACKOFF_STEP;
    }

    // 3. 斜め角方向の落下防止
    while (dx !== 0 && dz !== 0 && !hasOverlapInBuffer(aMinX + dx, checkMinY, aMinZ + dz, aMaxX + dx, checkMaxY, aMaxZ + dz, boxCount)) {
        if (dx < SNEAK_BACKOFF_STEP && dx >= -SNEAK_BACKOFF_STEP) dx = 0;
        else if (dx > 0) dx -= SNEAK_BACKOFF_STEP;
        else dx += SNEAK_BACKOFF_STEP;

        if (dz < SNEAK_BACKOFF_STEP && dz >= -SNEAK_BACKOFF_STEP) dz = 0;
        else if (dz > 0) dz -= SNEAK_BACKOFF_STEP;
        else dz += SNEAK_BACKOFF_STEP;
    }

    _backoffOut.dx = dx;
    _backoffOut.dz = dz;
    return _backoffOut;
}

function axisSeparatedCollisionResolve(dt) {
    const pos = player.position;
    const vel = player.velocity;

    let dx = vel.x * dt;
    let dy = vel.y * dt;
    let dz = vel.z * dt;

    if (dx === 0 && dy === 0 && dz === 0) return;

    const aabb = getPlayerAABB(pos);
    const oMinX = aabb.min.x, oMinY = aabb.min.y, oMinZ = aabb.min.z;
    const oMaxX = aabb.max.x, oMaxY = aabb.max.y, oMaxZ = aabb.max.z;

    const allowStep = !flightMode && !wasUnderwater;
    const allowSneakGuard = sneakActive && !flightMode && player.onGround;

    // 1. 移動領域全体（段差登り上側＋スニーク下側余裕込み）の衝突ボックスを1回だけ収集
    const sMinX = (dx < 0 ? oMinX + dx : oMinX) - 0.05;
    const sMaxX = (dx > 0 ? oMaxX + dx : oMaxX) + 0.05;
    const sMinY = (dy < 0 ? oMinY + dy : oMinY) - (allowSneakGuard ? MAX_STEP_HEIGHT : 0) - 0.05;
    const sMaxY = (dy > 0 ? oMaxY + dy : oMaxY) + (allowStep ? MAX_STEP_HEIGHT : 0) + 0.05;
    const sMinZ = (dz < 0 ? oMinZ + dz : oMinZ) - 0.05;
    const sMaxZ = (dz > 0 ? oMaxZ + dz : oMaxZ) + 0.05;

    const boxCount = collectCollisionBoxes(sMinX, sMinY, sMinZ, sMaxX, sMaxY, sMaxZ);

    // 2. スニーク中の足場エッジ落下防止（エッジぎりぎりまで滑らかに詰める）
    if (allowSneakGuard && (dx !== 0 || dz !== 0)) {
        const backed = backOffFromEdge(oMinX, oMinY, oMinZ, oMaxX, oMaxZ, dx, dz, boxCount);
        if (backed.dx !== dx) { dx = backed.dx; vel.x = 0; }
        if (backed.dz !== dz) { dz = backed.dz; vel.z = 0; }
    }

    // 3. 通常スイープ解決（Y -> 大きい水平軸 -> 小さい水平軸 の順で解析的クリップ）
    let resY = clipAxisY(oMinX, oMinY, oMinZ, oMaxX, oMaxY, oMaxZ, dy, boxCount);
    const yMinY = oMinY + resY;
    const yMaxY = oMaxY + resY;

    const zFirst = Math.abs(dz) > Math.abs(dx);
    let resX, resZ;

    if (zFirst) {
        resZ = clipAxisZ(oMinX, yMinY, oMinZ, oMaxX, yMaxY, oMaxZ, dz, boxCount);
        resX = clipAxisX(oMinX, yMinY, oMinZ + resZ, oMaxX, yMaxY, oMaxZ + resZ, dx, boxCount);
    } else {
        resX = clipAxisX(oMinX, yMinY, oMinZ, oMaxX, yMaxY, oMaxZ, dx, boxCount);
        resZ = clipAxisZ(oMinX + resX, yMinY, oMinZ, oMaxX + resX, yMaxY, oMaxZ, dz, boxCount);
    }

    const hitGround = (dy < 0 && Math.abs(dy - resY) > 1e-6);
    const hitCeiling = (dy > 0 && Math.abs(dy - resY) > 1e-6);
    let hitX = Math.abs(dx - resX) > 1e-6;
    let hitZ = Math.abs(dz - resZ) > 1e-6;

    // 4. 解析的段差登り（Minecraft Java Edition Entity.collide 準拠・天井干渉自動尊重）
    let steppedUp = false;
    if (allowStep && (player.onGround || hitGround) && (hitX || hitZ)) {
        // 4-A. 元の位置から最大 MAX_STEP_HEIGHT(0.6) まで上昇（低い天井があれば自動で手前停止）
        const upY = clipAxisY(oMinX, oMinY, oMinZ, oMaxX, oMaxY, oMaxZ, MAX_STEP_HEIGHT, boxCount);
        if (upY > 1e-4) {
            const upMinY = oMinY + upY;
            const upMaxY = oMaxY + upY;

            // 4-B. 上げた高さで元の水平移動 (dx, dz) を試行
            let stepX, stepZ;
            if (zFirst) {
                stepZ = clipAxisZ(oMinX, upMinY, oMinZ, oMaxX, upMaxY, oMaxZ, dz, boxCount);
                stepX = clipAxisX(oMinX, upMinY, oMinZ + stepZ, oMaxX, upMaxY, oMaxZ + stepZ, dx, boxCount);
            } else {
                stepX = clipAxisX(oMinX, upMinY, oMinZ, oMaxX, upMaxY, oMaxZ, dx, boxCount);
                stepZ = clipAxisZ(oMinX + stepX, upMinY, oMinZ, oMaxX + stepX, upMaxY, oMaxZ, dz, boxCount);
            }

            // 4-C. 通常移動より遠くへ進める場合のみ段差登りを採用し、段差上面へピッタリ降ろす
            if ((stepX * stepX + stepZ * stepZ) > (resX * resX + resZ * resZ) + 1e-8) {
                const downTarget = (dy < 0 ? dy : 0) - upY;
                const downY = clipAxisY(
                    oMinX + stepX, upMinY, oMinZ + stepZ,
                    oMaxX + stepX, upMaxY, oMaxZ + stepZ,
                    downTarget, boxCount
                );
                resX = stepX;
                resZ = stepZ;
                resY = upY + downY;
                hitX = Math.abs(dx - resX) > 1e-6;
                hitZ = Math.abs(dz - resZ) > 1e-6;
                steppedUp = true;
            }
        }
    }

    // 5. 位置・速度・接地状態の一括反映
    pos.x += resX;
    pos.y += resY;
    pos.z += resZ;

    if (hitX) vel.x = 0;
    if (hitZ) vel.z = 0;
    if (hitGround || hitCeiling || steppedUp) vel.y = 0;
    if (hitGround || steppedUp) player.onGround = true;
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


const _ladderSizeTmp = { h: PLAYER_HEIGHT, r: PLAYER_RADIUS };
const _ladderRotBox = new THREE.Box3();

function isOnLadder() {
    _ladderSizeTmp.h = getCurrentPlayerHeight();
    _ladderSizeTmp.r = PLAYER_RADIUS;

    const aabb = getPlayerAABB(player.position, _ladderSizeTmp);
    // 壁越し掴まりを防ぐため拡張幅を 0.05 ブロックに抑制
    const pMinX = aabb.min.x - 0.05, pMaxX = aabb.max.x + 0.05;
    const pMinY = aabb.min.y, pMaxY = aabb.max.y;
    const pMinZ = aabb.min.z - 0.05, pMaxZ = aabb.max.z + 0.05;

    const minX = Math.floor(pMinX) | 0;
    const maxX = Math.floor(pMaxX) | 0;
    const minY = Math.floor(pMinY) | 0;
    const maxY = Math.floor(pMaxY) | 0;
    const minZ = Math.floor(pMinZ) | 0;
    const maxZ = Math.floor(pMaxZ) | 0;

    const ladderId = BLOCK_TYPES.LADDER;
    const ladderBoxes = getCollisionBoxesReadOnly("ladder", 0);

    for (let y = minY; y <= maxY; y = (y + 1) | 0) {
        if (y < 0 || y >= CHUNK_HEIGHT) continue;
        for (let x = minX; x <= maxX; x = (x + 1) | 0) {
            for (let z = minZ; z <= maxZ; z = (z + 1) | 0) {
                const voxel = getVoxelAtWorld(x, y, z, true) | 0;
                if ((voxel & 0xFFF) !== ladderId) continue;

                const meta = (voxel >> 12) & 0xF;
                for (let i = 0; i < ladderBoxes.length; i++) {
                    let box = ladderBoxes[i];
                    if (meta !== 0) {
                        applyRotationToCollisionBox(box, meta, _ladderRotBox);
                        box = _ladderRotBox;
                    }
                    if (
                        pMaxX > x + box.min.x && pMinX < x + box.max.x &&
                        pMaxY > y + box.min.y && pMinY < y + box.max.y &&
                        pMaxZ > z + box.min.z && pMinZ < z + box.max.z
                    ) {
                        return true;
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

    // 5. 微小速度のゼロクランプ
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
const _groundProbeBox = new THREE.Box3();

function updateOnGround() {
    const aabb = getPlayerAABB(player.position);
    // 足元直下 0.002 ブロック（2mm）の薄いスライスのみを検査し、空中での誤接地を防止
    _groundProbeBox.min.set(aabb.min.x, aabb.min.y - 0.002, aabb.min.z);
    _groundProbeBox.max.set(aabb.max.x, aabb.min.y + 0.001, aabb.max.z);
    player.onGround = checkAABBCollision(_groundProbeBox);
}

function disposeMesh(mesh) {
    if (!mesh) return;

    // 1. 階層下の全オブジェクトを走査して VRAM リソースとクロージャ参照を完全解放
    mesh.traverse((obj) => {
        if (!obj.isMesh) return;

        if (obj.geometry) {
            obj.geometry.dispose();
            obj.geometry = null;
        }

        if (obj.material) {
            if (Array.isArray(obj.material)) {
                for (let i = 0; i < obj.material.length; i++) {
                    const mat = obj.material[i];
                    // 共有マテリアル(isShared: true)は絶対に破棄せず、一時クローン等のみ破棄
                    if (mat && !(mat.userData && mat.userData.isShared)) {
                        mat.dispose();
                    }
                }
            } else {
                const mat = obj.material;
                if (mat && !(mat.userData && mat.userData.isShared)) {
                    mat.dispose();
                }
            }
            obj.material = null;
        }

        if (obj.userData) {
            obj.userData.finalizeFade = null;
        }
    });

    // 2. シーングラフからの完全な取り除き
    while (mesh.children.length > 0) {
        mesh.remove(mesh.children[0]);
    }

    // 3. 親要素からの切り離し
    if (mesh.parent) {
        mesh.parent.remove(mesh);
    }
}

/**
 * チャンクの3段階距離判定（ロード半径 < 描画アンロード半径 < CPUデータ保持半径）
 */
function isChunkWithinRenderDistance(cx, cz, pCx, pCz) {
    const dist = CHUNK_VISIBLE_DISTANCE;
    if (dist <= 0) return cx === pCx && cz === pCz;
    const dx = cx - pCx;
    const dz = cz - pCz;
    const maxR = dist + 0.5;
    return (dx * dx + dz * dz) <= (maxR * maxR);
}

function isChunkWithinUnloadDistance(cx, cz, pCx, pCz) {
    const dist = CHUNK_VISIBLE_DISTANCE;
    if (dist <= 0) return cx === pCx && cz === pCz;
    const dx = cx - pCx;
    const dz = cz - pCz;
    // ヒステリシス(+1チャンク)により境界1歩往復での破棄・再生成スラッシングを根絶
    const maxR = dist + 1.5;
    return (dx * dx + dz * dz) <= (maxR * maxR);
}

function isChunkWithinDataRetainDistance(cx, cz, pCx, pCz) {
    const dist = CHUNK_VISIBLE_DISTANCE;
    const dx = cx - pCx;
    const dz = cz - pCz;
    // 描画アンロード範囲よりさらに外側にデータ保持マージンを確保（3x3境界参照を保証）
    const maxR = Math.max(dist + 3.0, 8.0);
    return (dx * dx + dz * dz) <= (maxR * maxR);
}

function refreshChunkAt(cx, cz) {
    const key = encodeChunkKey(cx, cz);
    const oldChunk = loadedChunks.get(key);

    // 1. プレイヤーからの距離チェック（ヒステリシスを含むアンロード半径で判定）
    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);

    if (!isChunkWithinUnloadDistance(cx, cz, pCx, pCz)) {
        if (oldChunk) {
            unloadChunkByKey(key);
        }
        return;
    }

    // 2. 新しいメッシュの生成（通常リビルドはフェード不要のため共有マテリアル直結）
    const newChunk = generateChunkMeshMultiTexture(cx, cz, false, false);

    if (!newChunk) {
        if (oldChunk) {
            unloadChunkByKey(key);
        }
        return;
    }

    // 3. 属性のセットアップ
    newChunk.userData.fadedIn = true;
    syncSingleChunkSkyLight(newChunk);

    // 4. 入れ替え処理（チラつき防止のため「追加」してから「削除」）
    scene.add(newChunk);
    loadedChunks.set(key, newChunk);

    if (oldChunk) {
        // 旧メッシュがフェード中だった場合はタスクからも即除去
        for (let i = activeFadeTasks.length - 1; i >= 0; i--) {
            if (activeFadeTasks[i].object === oldChunk) {
                activeFadeTasks.splice(i, 1);
                break;
            }
        }
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
        chunkUpdateIdx++;

        // アンロード済み等でキャンセルされたキーは O(1) でスキップ
        if (!chunkUpdateLookup.has(key)) continue;
        chunkUpdateLookup.delete(key);
        if (!loadedChunks.has(key)) continue;

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
// 周辺の自動チャンク生成キュー (メインループ定時バジェット駆動)
// ==========================================

/**
 * チャンク生成メインループ（animate() から毎フレーム1回だけ呼ばれる）
 * @param {boolean} isInitialBoost - 初期スポーン待機中は高バジェットで最速ロード
 */
function processChunkQueue(isInitialBoost = false) {
    if (chunkQueue.length === 0) return;

    const MAX_CHUNKS_PER_FRAME = isInitialBoost ? 4 : 2;
    const FRAME_TIME_BUDGET = isInitialBoost ? 12.0 : 6.0;
    const startTime = performance.now();
    let tasksProcessed = 0;

    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);

    // 描画距離0または初期スポーン待機中はフェードなしで即表示
    const useFade = !isInitialBoost && CHUNK_VISIBLE_DISTANCE > 0;

    while (
        chunkQueue.length > 0 &&
        tasksProcessed < MAX_CHUNKS_PER_FRAME &&
        (performance.now() - startTime) < FRAME_TIME_BUDGET
    ) {
        const key = chunkQueue.pop();
        if (key === undefined) continue;

        decodeChunkKey(key, _sharedChunkCoord);
        const cx = _sharedChunkCoord.cx;
        const cz = _sharedChunkCoord.cz;

        if (!isChunkWithinRenderDistance(cx, cz, pCx, pCz)) continue;
        if (loadedChunks.has(key)) continue;

        const mesh = generateChunkMeshMultiTexture(cx, cz, false, useFade);
        if (!mesh) {
            tasksProcessed++;
            continue;
        }

        syncSingleChunkSkyLight(mesh);
        mesh.userData.fadedIn = !useFade;

        scene.add(mesh);
        loadedChunks.set(key, mesh);

        // 対向する欠損ビットを持つ隣接チャンクのみライト＋メッシュ再構築キューへ登録
        checkNeighborUpdate(cx + 1, cz, NEIGHBOR_BIT_NX);
        checkNeighborUpdate(cx - 1, cz, NEIGHBOR_BIT_PX);
        checkNeighborUpdate(cx, cz + 1, NEIGHBOR_BIT_NZ);
        checkNeighborUpdate(cx, cz - 1, NEIGHBOR_BIT_PZ);

        if (useFade) {
            startChunkFadeIn(mesh, 350);
        }

        tasksProcessed++;
    }
}

function checkNeighborUpdate(ncx, ncz, oppositeBit) {
    const nKey = encodeChunkKey(ncx, ncz);
    const neighborMesh = loadedChunks.get(nKey);
    if (!neighborMesh) return;

    const mask = neighborMesh.userData.missingNeighborMask | 0;
    if ((mask & oppositeBit) !== 0) {
        neighborMesh.userData.missingNeighborMask = mask & ~oppositeBit;
        pendingChunkUpdates.add(nKey);
    }
}

function onMeshChildFinalize(child) {
    if (child.isMesh && typeof child.userData.finalizeFade === "function") {
        // メソッド呼び出しだと this が child.userData になるため、必ずメッシュ本体(child)を this に束縛する
        child.userData.finalizeFade.call(child);
    }
}

// 全ブロックマテリアルが SHARED_SKY_UNIFORM を共有するため、昼夜更新は O(1) で完結する
function syncSingleChunkSkyLight(mesh) {
    if (!mesh) return;
    SHARED_SKY_UNIFORM.value = getSkyLightFactor(gameTime);
}

function updateGlobalSkyLight(time = gameTime) {
    SHARED_SKY_UNIFORM.value = getSkyLightFactor(time);
}

/* ======================================================
   【最適化版】境界ライト差分同期 ＋ チャンクメッシュ構築
   ====================================================== */
const _pendingCoordTmp = { cx: 0, cz: 0 };

function processPendingChunkUpdates(budgetMs = 4.0) {
    if (pendingChunkUpdates.size === 0) return;

    const startTime = performance.now();
    const FRAME_BUDGET = budgetMs;

    for (const key of pendingChunkUpdates) {
        pendingChunkUpdates.delete(key);

        decodeChunkKey(key, _pendingCoordTmp);
        const cx = _pendingCoordTmp.cx;
        const cz = _pendingCoordTmp.cz;

        if (!loadedChunks.has(key)) continue;

        const voxelData = ChunkSaveManager.modifiedChunks.get(key) || chunkReadOnlyCache.get(key);
        if (voxelData) {
            if (!chunkLightCache.has(key)) {
                generateChunkLightMap(key, voxelData);
            } else {
                // 既にライトマップが存在するチャンクは 65536 セル全再計算せず境界からの差分光のみ取り込む
                syncBorderLightFromNeighbors(key, voxelData);
            }
        }

        refreshChunkAt(cx, cz);

        if ((performance.now() - startTime) > FRAME_BUDGET) {
            break;
        }
    }
}

/* ======================================================
   【チャンクの管理】
   ====================================================== */
// グローバル変数
const loadedChunks = new Map();       // 現在シーンに配置中のチャンク（キーは32bit整数）
let chunkQueue = [];                  // 新規チャンク生成用のキュー
const chunkUnloadQueue = [];          // フレーム予算分散アンロード用キュー
const chunkUnloadLookup = new Set();  // アンロードキュー重複防止Set
const _unloadCoordTmp = { cx: 0, cz: 0 };
const _evictCoordTmp = { cx: 0, cz: 0 };

function _markNeighborMissingOnUnload(ncx, ncz, oppositeBit) {
    const nMesh = loadedChunks.get(encodeChunkKey(ncx, ncz));
    if (nMesh) {
        nMesh.userData.missingNeighborMask = (nMesh.userData.missingNeighborMask | 0) | oppositeBit;
    }
}

/**
 * チャンク1件をシーン・各種キュー・フェードタスク・VRAMから完全かつ安全にアンロードする
 */
function unloadChunkByKey(hashKey) {
    const mesh = loadedChunks.get(hashKey);
    if (!mesh) return;

    loadedChunks.delete(hashKey);
    pendingChunkUpdates.delete(hashKey);
    chunkUpdateLookup.delete(hashKey);
    chunkUnloadLookup.delete(hashKey);

    // 進行中のフェードインタスクがあれば即座に解除
    for (let i = activeFadeTasks.length - 1; i >= 0; i--) {
        if (activeFadeTasks[i].object === mesh) {
            activeFadeTasks.splice(i, 1);
            break;
        }
    }

    // 残存する隣接4チャンクへ「この方向が欠損した」ビットを立て、再ロード時の境界再同期を保証
    decodeChunkKey(hashKey, _unloadCoordTmp);
    const cx = _unloadCoordTmp.cx;
    const cz = _unloadCoordTmp.cz;
    _markNeighborMissingOnUnload(cx + 1, cz, NEIGHBOR_BIT_NX);
    _markNeighborMissingOnUnload(cx - 1, cz, NEIGHBOR_BIT_PX);
    _markNeighborMissingOnUnload(cx, cz + 1, NEIGHBOR_BIT_NZ);
    _markNeighborMissingOnUnload(cx, cz - 1, NEIGHBOR_BIT_PZ);

    disposeMesh(mesh);
}

/**
 * フレーム時間予算内で範囲外チャンクを滑らかにアンロードする（描画距離縮小・高速飛行スパイク防止）
 */
function processChunkUnloadQueue() {
    if (chunkUnloadQueue.length === 0) return;

    const MAX_UNLOADS_PER_FRAME = 6;
    const UNLOAD_TIME_BUDGET = 3.0;
    const startTime = performance.now();
    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);

    let processed = 0;
    while (
        chunkUnloadQueue.length > 0 &&
        processed < MAX_UNLOADS_PER_FRAME &&
        (performance.now() - startTime) < UNLOAD_TIME_BUDGET
    ) {
        const key = chunkUnloadQueue.pop();
        chunkUnloadLookup.delete(key);

        if (!loadedChunks.has(key)) continue;

        // キュー待機中にプレイヤーが引き返して範囲内へ戻った場合はアンロードを自動キャンセル
        decodeChunkKey(key, _unloadCoordTmp);
        if (isChunkWithinUnloadDistance(_unloadCoordTmp.cx, _unloadCoordTmp.cz, pCx, pCz)) continue;

        unloadChunkByKey(key);
        processed++;
    }
}

/**
 * 遠方のCPUキャッシュ（ライトマップ・未編集チャンクデータ・読み取りキャッシュ）を予算内で定期回収する
 * ※プレイヤー編集済み・セーブ読込済みチャンク(playerModifiedKeys)のボクセルデータは絶対に消さない
 */
function evictDistantChunkCaches(pCx, pCz) {
    const MAX_EVICT_PER_MAP = 16;

    // 1. 遠方ライトマップ(64KB/チャンク)の回収（再訪問時にオンデマンド再構築可能）
    let evictedLight = 0;
    for (const key of chunkLightCache.keys()) {
        if (loadedChunks.has(key)) continue;
        decodeChunkKey(key, _evictCoordTmp);
        if (!isChunkWithinDataRetainDistance(_evictCoordTmp.cx, _evictCoordTmp.cz, pCx, pCz)) {
            chunkLightCache.delete(key);
            if (++evictedLight >= MAX_EVICT_PER_MAP) break;
        }
    }

    // 2. 遠方の「未編集」生成済みチャンク(128KB/チャンク)を回収しRAM無限増大を防止
    let evictedVoxels = 0;
    for (const key of ChunkSaveManager.modifiedChunks.keys()) {
        if (ChunkSaveManager.playerModifiedKeys.has(key)) continue;
        if (loadedChunks.has(key)) continue;
        decodeChunkKey(key, _evictCoordTmp);
        if (!isChunkWithinDataRetainDistance(_evictCoordTmp.cx, _evictCoordTmp.cz, pCx, pCz)) {
            ChunkSaveManager.modifiedChunks.delete(key);
            ChunkSaveManager.decoratedChunks.delete(key);
            ChunkSaveManager.chunkUpdateInfo.delete(key);
            invalidateVoxelReadCache(key);
            if (++evictedVoxels >= MAX_EVICT_PER_MAP) break;
        }
    }

    // 3. 遠方の読み取り専用キャッシュを回収
    let evictedReadOnly = 0;
    for (const key of chunkReadOnlyCache.keys()) {
        if (loadedChunks.has(key)) continue;
        decodeChunkKey(key, _evictCoordTmp);
        if (!isChunkWithinDataRetainDistance(_evictCoordTmp.cx, _evictCoordTmp.cz, pCx, pCz)) {
            invalidateVoxelReadCache(key);
            if (++evictedReadOnly >= MAX_EVICT_PER_MAP) break;
        }
    }
}

// 全フェードイン中チャンクを1つの配列で統合管理（チャンクごとの rAF 乱立をゼロ化）
const activeFadeTasks = [];

/**
 * チャンクのフェードインを登録する（各一時マテリアルの realOpacity へ正確に補間し、完了時に共有 originMat へ復帰）
 */
function startChunkFadeIn(object, duration = 350) {
    if (!object || object.userData.fadedIn) return;

    const mats = [];
    const targetOpacities = [];

    object.traverse(o => {
        if (!o.isMesh || !o.material) return;
        if (Array.isArray(o.material)) {
            for (let i = 0; i < o.material.length; i++) {
                const m = o.material[i];
                if (!m || !m.userData || !m.userData.originMat) continue;
                mats.push(m);
                targetOpacities.push(m.userData.realOpacity !== undefined ? m.userData.realOpacity : m.userData.originMat.opacity);
            }
        } else {
            const m = o.material;
            if (m && m.userData && m.userData.originMat) {
                mats.push(m);
                targetOpacities.push(m.userData.realOpacity !== undefined ? m.userData.realOpacity : m.userData.originMat.opacity);
            }
        }
    });

    if (mats.length === 0 || CHUNK_VISIBLE_DISTANCE === 0) {
        object.userData.fadedIn = true;
        object.traverse(onMeshChildFinalize);
        return;
    }

    activeFadeTasks.push({
        object,
        mats,
        targetOpacities,
        startTime: performance.now(),
        invDuration: 1.0 / duration
    });
}

/**
 * メインループ(animate)から毎フレーム1回呼ばれるフェードイン一括更新
 */
function updateChunkFadeIns(now) {
    for (let i = activeFadeTasks.length - 1; i >= 0; i--) {
        const task = activeFadeTasks[i];
        const obj = task.object;

        // チャンクが途中でアンロード・差し替え済みなら即座にタスク破棄
        if (!obj || !obj.parent) {
            activeFadeTasks.splice(i, 1);
            continue;
        }

        const t = (now - task.startTime) * task.invDuration;
        if (t >= 1.0) {
            // フェード完了: 不透明・水・カスタムすべてを一括で共有 originMat へ差し替えてクローンを即 dispose()
            obj.userData.fadedIn = true;
            obj.traverse(onMeshChildFinalize);
            activeFadeTasks.splice(i, 1);
        } else {
            const clamped = t > 0 ? t : 0;
            const mats = task.mats;
            const targets = task.targetOpacities;
            for (let j = 0, len = mats.length; j < len; j++) {
                // 水なら 0 -> 0.8、不透明なら 0 -> 1.0 へ正確に補間
                mats[j].opacity = clamped * targets[j];
            }
        }
    }
}

/* ======================================================
   【新・15段階 マイクラ準拠 ライティングエンジン (SkyLight)】
   ====================================================== */
const LIGHT_LEVEL_FACTORS = new Float32Array(16);
const brightness = 0.5; // マイクラの設定「明るさ: 50%」に相当
for (let i = 0; i <= 15; i++) {
    const f = Math.pow(0.8, 15 - i);
    const level = f / (f * (1.0 - brightness) + brightness);
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
const LIGHT_DIR_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const LIGHT_DIR_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const LIGHT_DIR_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);

// オーバーフローを構造的に防ぐリングバッファ（初期ライト構築用: 131072）
const LIGHT_RING_SIZE = 131072;
const LIGHT_RING_MASK = LIGHT_RING_SIZE - 1;
const _sharedQueue = new Int32Array(LIGHT_RING_SIZE);
// Phase 1-A 走査中に同時に拾う発光ブロック一時リスト（Phase 2-A の 65536 全走査を廃止）
const _blockSeedIndices = new Int32Array(4096);
const _blockSeedLevels = new Uint8Array(4096);

// 2フェーズ インクリメンタル光源エンジン用リングバッファ（ワールド座標ベース: 32768）
const INC_RING_SIZE = 32768;
const INC_RING_MASK = INC_RING_SIZE - 1;
const _incRemX = new Int32Array(INC_RING_SIZE);
const _incRemY = new Int32Array(INC_RING_SIZE);
const _incRemZ = new Int32Array(INC_RING_SIZE);
const _incRemV = new Uint8Array(INC_RING_SIZE);
const _incAddX = new Int32Array(INC_RING_SIZE);
const _incAddY = new Int32Array(INC_RING_SIZE);
const _incAddZ = new Int32Array(INC_RING_SIZE);

// ブロック編集1回あたりに影響を受けたチャンクキーを集約する再利用Set
const _lightDirtySet = new Set();

// ブロックIDごとの遮光度(0..15, 不透明=15)および発光量(0..15)の高速取得
function getBlockLightOpacity(blockId) {
    if (blockId === 0) return 0;
    const cfg = _blockConfigFastArray[blockId];
    if (!cfg || !cfg.transparent) return 15;
    return cfg.lightOpacity !== undefined ? cfg.lightOpacity : 1;
}

function getBlockLightEmission(blockId, meta = 0) {
    if (blockId === 0) return 0;
    return getBlockLightEmissionForState(blockId, meta);
}

// 読み込み済みチャンクからのみ参照（未ロードチャンクの同期生成を厳禁）
function _getLoadedVoxelData(cx, cz) {
    const key = encodeChunkKey(cx, cz);
    return ChunkSaveManager.modifiedChunks.get(key) || chunkReadOnlyCache.get(key) || null;
}

function _getWorldLightCell(wx, wy, wz) {
    if (wy < 0) return 0;
    if (wy >= CH) return 0xF0;
    const lMap = chunkLightCache.get(encodeChunkKey(wx >> 4, wz >> 4));
    if (!lMap) return -1;
    return lMap[wy | ((wz & 15) << 8) | ((wx & 15) << 12)];
}

function _getWorldRawLoaded(wx, wy, wz) {
    if (wy < 0 || wy >= CH) return 0;
    const vData = _getLoadedVoxelData(wx >> 4, wz >> 4);
    if (!vData) return -1;
    return vData[wy | ((wz & 15) << 8) | ((wx & 15) << 12)];
}

function _getWorldBlockIdLoaded(wx, wy, wz) {
    const raw = _getWorldRawLoaded(wx, wy, wz);
    return raw < 0 ? -1 : (raw & 0xFFF);
}

function _setWorldSkyLight(wx, wy, wz, val, outDirtyChunks) {
    if (wy < 0 || wy >= CH) return;
    const key = encodeChunkKey(wx >> 4, wz >> 4);
    const lMap = chunkLightCache.get(key);
    if (!lMap) return;
    const idx = wy | ((wz & 15) << 8) | ((wx & 15) << 12);
    const prev = lMap[idx];
    const next = ((val & 15) << 4) | (prev & 15);
    if (prev !== next) {
        lMap[idx] = next;
        if (outDirtyChunks) outDirtyChunks.add(key);
    }
}

function _setWorldBlockLight(wx, wy, wz, val, outDirtyChunks) {
    if (wy < 0 || wy >= CH) return;
    const key = encodeChunkKey(wx >> 4, wz >> 4);
    const lMap = chunkLightCache.get(key);
    if (!lMap) return;
    const idx = wy | ((wz & 15) << 8) | ((wx & 15) << 12);
    const prev = lMap[idx];
    const next = (prev & 0xF0) | (val & 15);
    if (prev !== next) {
        lMap[idx] = next;
        if (outDirtyChunks) outDirtyChunks.add(key);
    }
}

/**
 * ワールド座標ベース 加算BFS（ブロック光・チャンク跨ぎ対応）
 */
function _runBlockLightAddBFS(addHead, addTail, outDirtyChunks) {
    while (addHead !== addTail) {
        const x = _incAddX[addHead];
        const y = _incAddY[addHead];
        const z = _incAddZ[addHead];
        addHead = (addHead + 1) & INC_RING_MASK;

        const cell = _getWorldLightCell(x, y, z);
        if (cell < 0) continue;
        const val = cell & 15;
        if (val <= 1) continue;

        for (let i = 0; i < 6; i++) {
            const nx = x + LIGHT_DIR_DX[i];
            const ny = y + LIGHT_DIR_DY[i];
            const nz = z + LIGHT_DIR_DZ[i];
            if (ny < 0 || ny >= CH) continue;

            const nBlockId = _getWorldBlockIdLoaded(nx, ny, nz);
            if (nBlockId < 0) continue;
            const nOpacity = getBlockLightOpacity(nBlockId);
            if (nOpacity >= 15) continue;

            const decay = nOpacity > 1 ? nOpacity : 1;
            const nextVal = val - decay;
            if (nextVal <= 0) continue;

            const nCell = _getWorldLightCell(nx, ny, nz);
            if (nCell < 0) continue;
            if (nextVal > (nCell & 15)) {
                _setWorldBlockLight(nx, ny, nz, nextVal, outDirtyChunks);
                const nextTail = (addTail + 1) & INC_RING_MASK;
                if (nextTail !== addHead) {
                    _incAddX[addTail] = nx;
                    _incAddY[addTail] = ny;
                    _incAddZ[addTail] = nz;
                    addTail = nextTail;
                }
            }
        }
    }
}

/**
 * ワールド座標ベース 加算BFS（天空光・直射15減衰0ルール＋チャンク跨ぎ対応）
 */
function _runSkyLightAddBFS(addHead, addTail, outDirtyChunks) {
    while (addHead !== addTail) {
        const x = _incAddX[addHead];
        const y = _incAddY[addHead];
        const z = _incAddZ[addHead];
        addHead = (addHead + 1) & INC_RING_MASK;

        const cell = _getWorldLightCell(x, y, z);
        if (cell < 0) continue;
        const val = (cell >> 4) & 15;
        if (val <= 1) continue;

        for (let i = 0; i < 6; i++) {
            const nx = x + LIGHT_DIR_DX[i];
            const ny = y + LIGHT_DIR_DY[i];
            const nz = z + LIGHT_DIR_DZ[i];
            if (ny < 0 || ny >= CH) continue;

            const nBlockId = _getWorldBlockIdLoaded(nx, ny, nz);
            if (nBlockId < 0) continue;
            const nOpacity = getBlockLightOpacity(nBlockId);
            if (nOpacity >= 15) continue;

            // Minecraft Java Edition準拠: 直射日光15の真下(-Y)かつ遮光0のときのみ減衰0
            let nextVal;
            if (i === 3 && val === 15) {
                nextVal = 15 - nOpacity;
            } else {
                const decay = nOpacity > 1 ? nOpacity : 1;
                nextVal = val - decay;
            }
            if (nextVal <= 0) continue;

            const nCell = _getWorldLightCell(nx, ny, nz);
            if (nCell < 0) continue;
            if (nextVal > ((nCell >> 4) & 15)) {
                _setWorldSkyLight(nx, ny, nz, nextVal, outDirtyChunks);
                const nextTail = (addTail + 1) & INC_RING_MASK;
                if (nextTail !== addHead) {
                    _incAddX[addTail] = nx;
                    _incAddY[addTail] = ny;
                    _incAddZ[addTail] = nz;
                    addTail = nextTail;
                }
            }
        }
    }
}

/**
 * 【2フェーズ インクリメンタル光源更新エンジン】
 * ブロック1個の変更に対して「削除BFS -> 加算BFS」をチャンク境界越しに実行し、
 * ゴーストライトを完全防止しつつ影響チャンクのみを outDirtyChunks へ収集する。
 */
function updateLightAtBlockChange(wx, wy, wz, oldRaw, newRaw, outDirtyChunks) {
    if (wy < 0 || wy >= CH) return;

    const oldId = oldRaw & 0xFFF;
    const newId = newRaw & 0xFFF;
    const oldOpacity = getBlockLightOpacity(oldId);
    const newOpacity = getBlockLightOpacity(newId);
    const oldEmit = getBlockLightEmission(oldId, (oldRaw >> 12) & 0xF);
    const newEmit = getBlockLightEmission(newId, (newRaw >> 12) & 0xF);

    // 光学特性が完全に同一ならライト再計算不要（石->土、階段回転変更など）
    if (oldOpacity === newOpacity && oldEmit === newEmit) return;

    const centerKey = encodeChunkKey(wx >> 4, wz >> 4);
    const centerMap = chunkLightCache.get(centerKey);
    if (!centerMap) return;

    const centerIdx = wy | ((wz & 15) << 8) | ((wx & 15) << 12);
    const currentCell = centerMap[centerIdx];
    const currentSky = (currentCell >> 4) & 15;
    const currentBlock = currentCell & 15;

    // ======================================================
    // 1. ブロック光 (BlockLight): 削除BFS -> 加算BFS
    // ======================================================
    {
        let remHead = 0, remTail = 0;
        let addHead = 0, addTail = 0;

        const pushRem = (x, y, z, v) => {
            const nt = (remTail + 1) & INC_RING_MASK;
            if (nt === remHead) return;
            _incRemX[remTail] = x; _incRemY[remTail] = y; _incRemZ[remTail] = z; _incRemV[remTail] = v;
            remTail = nt;
        };
        const pushAdd = (x, y, z) => {
            const nt = (addTail + 1) & INC_RING_MASK;
            if (nt === addHead) return;
            _incAddX[addTail] = x; _incAddY[addTail] = y; _incAddZ[addTail] = z;
            addTail = nt;
        };

        // 1-A. 光源破壊または遮蔽でブロック光が減少するケース -> 削除BFS開始
        if (currentBlock > newEmit && (oldEmit > newEmit || newOpacity > oldOpacity)) {
            _setWorldBlockLight(wx, wy, wz, 0, outDirtyChunks);
            pushRem(wx, wy, wz, currentBlock);

            while (remHead !== remTail) {
                const x = _incRemX[remHead], y = _incRemY[remHead], z = _incRemZ[remHead], oldVal = _incRemV[remHead];
                remHead = (remHead + 1) & INC_RING_MASK;

                for (let i = 0; i < 6; i++) {
                    const nx = x + LIGHT_DIR_DX[i], ny = y + LIGHT_DIR_DY[i], nz = z + LIGHT_DIR_DZ[i];
                    if (ny < 0 || ny >= CH) continue;

                    const nCell = _getWorldLightCell(nx, ny, nz);
                    if (nCell < 0) continue;
                    const nVal = nCell & 15;
                    if (nVal === 0) continue;

                    const nRaw = _getWorldRawLoaded(nx, ny, nz);
                    const nEmit = nRaw >= 0 ? getBlockLightEmission(nRaw & 0xFFF, (nRaw >> 12) & 0xF) : 0;

                    if (nVal < oldVal) {
                        if (nEmit > 0) {
                            // 別光源自体は消さず再充填シードへ戻す
                            pushAdd(nx, ny, nz);
                        } else {
                            _setWorldBlockLight(nx, ny, nz, 0, outDirtyChunks);
                            pushRem(nx, ny, nz, nVal);
                        }
                    } else if (nVal >= oldVal) {
                        // 別光源から供給されている強い光を境界シードとして再充填
                        pushAdd(nx, ny, nz);
                    }
                }
            }
        }

        // 1-B. 新規発光・または壁破壊による周囲からの光流入 -> 加算BFS
        if (newEmit > 0) {
            _setWorldBlockLight(wx, wy, wz, newEmit, outDirtyChunks);
            pushAdd(wx, wy, wz);
        } else if (newOpacity < 15) {
            for (let i = 0; i < 6; i++) {
                const nx = wx + LIGHT_DIR_DX[i], ny = wy + LIGHT_DIR_DY[i], nz = wz + LIGHT_DIR_DZ[i];
                const nCell = _getWorldLightCell(nx, ny, nz);
                if (nCell >= 0 && (nCell & 15) > 1) {
                    pushAdd(nx, ny, nz);
                }
            }
        }

        _runBlockLightAddBFS(addHead, addTail, outDirtyChunks);
    }

    // ======================================================
    // 2. 天空光 (SkyLight): 垂直直射処理 -> 削除BFS -> 加算BFS
    // ======================================================
    {
        let remHead = 0, remTail = 0;
        let addHead = 0, addTail = 0;

        const pushRem = (x, y, z, v) => {
            const nt = (remTail + 1) & INC_RING_MASK;
            if (nt === remHead) return;
            _incRemX[remTail] = x; _incRemY[remTail] = y; _incRemZ[remTail] = z; _incRemV[remTail] = v;
            remTail = nt;
        };
        const pushAdd = (x, y, z) => {
            const nt = (addTail + 1) & INC_RING_MASK;
            if (nt === addHead) return;
            _incAddX[addTail] = x; _incAddY[addTail] = y; _incAddZ[addTail] = z;
            addTail = nt;
        };

        const aboveCell = (wy < CH - 1) ? _getWorldLightCell(wx, wy + 1, wz) : 0xF0;
        const aboveSky = aboveCell >= 0 ? ((aboveCell >> 4) & 15) : 15;
        const expectedDirectSky = (newOpacity >= 15) ? 0 : (aboveSky === 15 ? (15 - newOpacity) : 0);

        // 2-A. 遮光が増えた（蓋をした・葉/水を置いた）-> 垂直柱と周囲を削除BFS
        if (newOpacity > oldOpacity && currentSky > 0) {
            _setWorldSkyLight(wx, wy, wz, 0, outDirtyChunks);
            pushRem(wx, wy, wz, currentSky);

            // 直射日光15の柱を塞いだ場合、真下の直射柱(sky===15)を一括で削除キューへ積む
            if (currentSky === 15 && expectedDirectSky < 15) {
                for (let y = wy - 1; y >= 0; y--) {
                    const c = _getWorldLightCell(wx, y, wz);
                    if (c < 0) break;
                    const s = (c >> 4) & 15;
                    if (s === 15) {
                        _setWorldSkyLight(wx, y, wz, 0, outDirtyChunks);
                        pushRem(wx, y, wz, 15);
                    } else {
                        break;
                    }
                }
            }

            while (remHead !== remTail) {
                const x = _incRemX[remHead], y = _incRemY[remHead], z = _incRemZ[remHead], oldVal = _incRemV[remHead];
                remHead = (remHead + 1) & INC_RING_MASK;

                for (let i = 0; i < 6; i++) {
                    const nx = x + LIGHT_DIR_DX[i], ny = y + LIGHT_DIR_DY[i], nz = z + LIGHT_DIR_DZ[i];
                    if (ny < 0 || ny >= CH) continue;

                    const nCell = _getWorldLightCell(nx, ny, nz);
                    if (nCell < 0) continue;
                    const nVal = (nCell >> 4) & 15;
                    if (nVal === 0) continue;

                    // 真下への直射15連鎖、または自分より暗い従属光を消去
                    if ((i === 3 && oldVal === 15 && nVal === 15) || nVal < oldVal) {
                        _setWorldSkyLight(nx, ny, nz, 0, outDirtyChunks);
                        pushRem(nx, ny, nz, nVal);
                    } else if (nVal >= oldVal) {
                        pushAdd(nx, ny, nz);
                    }
                }
            }
        }

        // 2-B. 透過が増えた（天井・横壁を壊した）-> 直射柱の貫通＆周囲からの再流入
        if (newOpacity < 15) {
            if (expectedDirectSky === 15) {
                // 真下へ遮光0が続く限り15を貫通させて加算キューへ
                for (let y = wy; y >= 0; y--) {
                    const bid = _getWorldBlockIdLoaded(wx, y, wz);
                    if (bid < 0) break;
                    const op = getBlockLightOpacity(bid);
                    if (op >= 15) break;
                    if (op === 0) {
                        _setWorldSkyLight(wx, y, wz, 15, outDirtyChunks);
                        pushAdd(wx, y, wz);
                    } else {
                        const atten = 15 - op;
                        const c = _getWorldLightCell(wx, y, wz);
                        if (c >= 0 && atten > ((c >> 4) & 15)) {
                            _setWorldSkyLight(wx, y, wz, atten, outDirtyChunks);
                            pushAdd(wx, y, wz);
                        }
                        break;
                    }
                }
            } else if (expectedDirectSky > 0) {
                const c = _getWorldLightCell(wx, wy, wz);
                if (c >= 0 && expectedDirectSky > ((c >> 4) & 15)) {
                    _setWorldSkyLight(wx, wy, wz, expectedDirectSky, outDirtyChunks);
                    pushAdd(wx, wy, wz);
                }
            }

            // 6近傍に明るいセルがあれば流入種として追加
            for (let i = 0; i < 6; i++) {
                const nx = wx + LIGHT_DIR_DX[i], ny = wy + LIGHT_DIR_DY[i], nz = wz + LIGHT_DIR_DZ[i];
                const nCell = _getWorldLightCell(nx, ny, nz);
                if (nCell >= 0 && ((nCell >> 4) & 15) > 1) {
                    pushAdd(nx, ny, nz);
                }
            }
        }

        _runSkyLightAddBFS(addHead, addTail, outDirtyChunks);
    }
}

/**
 * 新規隣接チャンク到着時に、境界16x256面のみから差分光を取り込んで内部へ伝播する（全再計算ゼロ）
 */
function syncBorderLightFromNeighbors(chunkKey, voxelData) {
    const lightData = chunkLightCache.get(chunkKey);
    if (!lightData || !voxelData) return;

    decodeChunkKey(chunkKey, _localLightCoord);
    const cx = _localLightCoord.cx | 0;
    const cz = _localLightCoord.cz | 0;
    const baseX = cx << 4;
    const baseZ = cz << 4;

    const nMaps = [
        chunkLightCache.get(encodeChunkKey(cx + 1, cz)) || null,
        chunkLightCache.get(encodeChunkKey(cx - 1, cz)) || null,
        null, null,
        chunkLightCache.get(encodeChunkKey(cx, cz + 1)) || null,
        chunkLightCache.get(encodeChunkKey(cx, cz - 1)) || null
    ];

    let skyTail = 0;
    let blkTail = 0;

    // 1. 境界4面から自チャンクへ流入する天空光・ブロック光を検出
    for (let i = 0; i < 6; i++) {
        const nm = nMaps[i];
        if (!nm) continue;

        for (let s = 0; s < 16; s++) {
            let x = 0, z = 0, nLx = 0, nLz = 0;
            if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
            else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
            else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
            else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

            const myCol = (z << 8) | (x << 12);
            const nCol = (nLz << 8) | (nLx << 12);

            for (let y = 0; y < CH; y++) {
                const idx = myCol | y;
                const nVal = nm[nCol | y];
                if (nVal === 0) continue;

                const myType = voxelData[idx] & 0xFFF;
                const opacity = getBlockLightOpacity(myType);
                if (opacity >= 15) continue;

                const decay = opacity > 1 ? opacity : 1;
                const cur = lightData[idx];

                const nSky = (nVal >> 4) & 15;
                if (nSky > 1) {
                    const nextSky = nSky - decay;
                    if (nextSky > ((cur >> 4) & 15)) {
                        lightData[idx] = (nextSky << 4) | (cur & 15);
                        if (skyTail < INC_RING_MASK) {
                            _incAddX[skyTail] = baseX + x;
                            _incAddY[skyTail] = y;
                            _incAddZ[skyTail] = baseZ + z;
                            skyTail++;
                        }
                    }
                }
            }
        }
    }

    if (skyTail > 0) {
        _runSkyLightAddBFS(0, skyTail, null);
    }

    for (let i = 0; i < 6; i++) {
        const nm = nMaps[i];
        if (!nm) continue;

        for (let s = 0; s < 16; s++) {
            let x = 0, z = 0, nLx = 0, nLz = 0;
            if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
            else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
            else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
            else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

            const myCol = (z << 8) | (x << 12);
            const nCol = (nLz << 8) | (nLx << 12);

            for (let y = 0; y < CH; y++) {
                const idx = myCol | y;
                const nBlk = nm[nCol | y] & 15;
                if (nBlk <= 1) continue;

                const myType = voxelData[idx] & 0xFFF;
                const opacity = getBlockLightOpacity(myType);
                if (opacity >= 15) continue;

                const decay = opacity > 1 ? opacity : 1;
                const nextBlk = nBlk - decay;
                if (nextBlk > (lightData[idx] & 15)) {
                    lightData[idx] = (lightData[idx] & 0xF0) | nextBlk;
                    if (blkTail < INC_RING_MASK) {
                        _incAddX[blkTail] = baseX + x;
                        _incAddY[blkTail] = y;
                        _incAddZ[blkTail] = baseZ + z;
                        blkTail++;
                    }
                }
            }
        }
    }

    if (blkTail > 0) {
        _runBlockLightAddBFS(0, blkTail, null);
    }
}

/* ======================================================
   【最適化・初期チャンクライト生成】(リングバッファ＋ハイトマップ境界シード＋Minecraft準拠減衰)
   ====================================================== */
function generateChunkLightMap(chunkKey, voxelData) {
    if (!voxelData || voxelData.length < TOTAL_CELLS) {
        console.warn("generateChunkLightMap: voxelData is invalid or too small.");
        return null;
    }

    let lightData = chunkLightCache.get(chunkKey);
    if (!lightData) {
        lightData = new Uint8Array(TOTAL_CELLS);
        chunkLightCache.set(chunkKey, lightData);
    } else {
        lightData.fill(0);
    }

    const queue = _sharedQueue;
    let head = 0, tail = 0;
    const pushLocal = (idx) => {
        if ((tail - head) < LIGHT_RING_MASK) {
            queue[tail & LIGHT_RING_MASK] = idx;
            tail++;
        }
    };

    decodeChunkKey(chunkKey, _localLightCoord);
    const cx = _localLightCoord.cx | 0;
    const cz = _localLightCoord.cz | 0;
    const baseX = cx << 4;
    const baseZ = cz << 4;

    const nMaps = new Array(6);
    const nVoxels = new Array(6);
    const nKeys = new Array(6);
    for (let i = 0; i < 6; i++) {
        if (i === 2 || i === 3) continue;
        const ncx = (cx + LIGHT_DIR_DX[i]) | 0;
        const ncz = (cz + LIGHT_DIR_DZ[i]) | 0;
        const nk = encodeChunkKey(ncx, ncz);
        nKeys[i] = nk;
        nMaps[i] = chunkLightCache.get(nk) || null;
        nVoxels[i] = _getLoadedVoxelData(ncx, ncz);
    }

    // ======================================================
    // 🌞 PHASE 1: 天空光 (SkyLight) ＋ 発光ブロック同時収集
    // ======================================================
    let chunkMaxAttenY = -1;
    let bSeedCount = 0;

    // 1-A: 直射日光15の垂直降下（遮光ブロックに当たった時点で直射を止め、以下はBFSに任せる）
    for (let x = 0; x < 16; x = (x + 1) | 0) {
        const xBase = (x << 12) | 0;
        for (let z = 0; z < 16; z = (z + 1) | 0) {
            const xzBase = (xBase | (z << 8)) | 0;
            let directSun = true;

            for (let y = 255; y >= 0; y = (y - 1) | 0) {
                const idx = (xzBase | y) | 0;
                const type = voxelData[idx] & 0xFFF;

                if (type !== 0) {
                    const emit = getBlockLightEmission(type, (voxelData[idx] >> 12) & 0xF);
                    if (emit > 0 && bSeedCount < 4096) {
                        _blockSeedIndices[bSeedCount] = idx;
                        _blockSeedLevels[bSeedCount] = emit;
                        bSeedCount++;
                    }
                }

                if (directSun) {
                    const opacity = getBlockLightOpacity(type);
                    if (opacity === 0) {
                        lightData[idx] = 0xF0; // 天空光15
                    } else {
                        if (y > chunkMaxAttenY) chunkMaxAttenY = y;
                        directSun = false;
                        if (opacity < 15) {
                            const atten = 15 - opacity;
                            if (atten > 0) {
                                lightData[idx] = (atten << 4);
                                pushLocal(idx);
                            }
                        }
                    }
                }
            }
        }
    }

    // 1-A2: ハイトマップ境界シード抽出（空中の完全直射層を除外し、隣接に暗い透過セルがあるセルのみ投入）
    const scanMaxY = chunkMaxAttenY < 255 ? (chunkMaxAttenY + 1) : 255;
    if (scanMaxY >= 0) {
        for (let x = 0; x < 16; x = (x + 1) | 0) {
            const xBase = (x << 12) | 0;
            for (let z = 0; z < 16; z = (z + 1) | 0) {
                const xzBase = (xBase | (z << 8)) | 0;
                for (let y = 0; y <= scanMaxY; y = (y + 1) | 0) {
                    const idx = (xzBase | y) | 0;
                    const sky = (lightData[idx] >> 4) & 15;
                    if (sky <= 1) continue;

                    let needSpread = false;
                    if (x < 15 && ((lightData[idx + CS_CH] >> 4) & 15) < sky - 1 && getBlockLightOpacity(voxelData[idx + CS_CH] & 0xFFF) < 15) needSpread = true;
                    else if (x > 0 && ((lightData[idx - CS_CH] >> 4) & 15) < sky - 1 && getBlockLightOpacity(voxelData[idx - CS_CH] & 0xFFF) < 15) needSpread = true;
                    else if (z < 15 && ((lightData[idx + CH] >> 4) & 15) < sky - 1 && getBlockLightOpacity(voxelData[idx + CH] & 0xFFF) < 15) needSpread = true;
                    else if (z > 0 && ((lightData[idx - CH] >> 4) & 15) < sky - 1 && getBlockLightOpacity(voxelData[idx - CH] & 0xFFF) < 15) needSpread = true;
                    else if (y > 0 && ((lightData[idx - 1] >> 4) & 15) < sky - 1 && getBlockLightOpacity(voxelData[idx - 1] & 0xFFF) < 15) needSpread = true;
                    else if (y < 255 && ((lightData[idx + 1] >> 4) & 15) < sky - 1 && getBlockLightOpacity(voxelData[idx + 1] & 0xFFF) < 15) needSpread = true;

                    if (needSpread) pushLocal(idx);
                }
            }
        }
    }

    // 1-B: 隣接4チャンクとの双方向境界シード（流入->自チャンクBFS / 流出->隣接インクリメンタルBFS）
    let crossSkyTail = 0;
    for (let i = 0; i < 6; i = (i + 1) | 0) {
        const nm = nMaps[i];
        const nv = nVoxels[i];
        if (!nm) continue;

        for (let s = 0; s < 16; s = (s + 1) | 0) {
            let x = 0, z = 0, nLx = 0, nLz = 0;
            if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
            else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
            else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
            else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

            const myCol = (z << 8) | (x << 12);
            const nCol = (nLz << 8) | (nLx << 12);
            const nWx = baseX + x + LIGHT_DIR_DX[i];
            const nWz = baseZ + z + LIGHT_DIR_DZ[i];

            for (let y = 0; y < 256; y = (y + 1) | 0) {
                const idx = myCol | y;
                const nIdx = nCol | y;
                const nSky = (nm[nIdx] >> 4) & 15;
                const mySky = (lightData[idx] >> 4) & 15;

                if (nSky > mySky + 1) {
                    const myOp = getBlockLightOpacity(voxelData[idx] & 0xFFF);
                    if (myOp < 15) {
                        const nextSky = nSky - (myOp > 1 ? myOp : 1);
                        if (nextSky > mySky) {
                            lightData[idx] = (nextSky << 4) | (lightData[idx] & 15);
                            pushLocal(idx);
                        }
                    }
                } else if (nv && mySky > nSky + 1) {
                    const nOp = getBlockLightOpacity(nv[nIdx] & 0xFFF);
                    if (nOp < 15) {
                        const nextSky = mySky - (nOp > 1 ? nOp : 1);
                        if (nextSky > nSky) {
                            nm[nIdx] = (nextSky << 4) | (nm[nIdx] & 15);
                            if (crossSkyTail < INC_RING_MASK) {
                                _incAddX[crossSkyTail] = nWx;
                                _incAddY[crossSkyTail] = y;
                                _incAddZ[crossSkyTail] = nWz;
                                crossSkyTail++;
                            }
                            pendingChunkUpdates.add(nKeys[i]);
                        }
                    }
                }
            }
        }
    }

    // 1-C: 天空光BFS（リングバッファ・縦横一貫減衰）
    while (head < tail) {
        const idx = queue[head & LIGHT_RING_MASK] | 0;
        head++;
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
                    const nOp = getBlockLightOpacity(nv[nIdx] & 0xFFF);
                    if (nOp < 15) {
                        const nextSky = skyLight - (nOp > 1 ? nOp : 1);
                        if (nextSky > ((nm[nIdx] >> 4) & 15)) {
                            nm[nIdx] = (nextSky << 4) | (nm[nIdx] & 15);
                            if (crossSkyTail < INC_RING_MASK) {
                                _incAddX[crossSkyTail] = baseX + x + LIGHT_DIR_DX[i];
                                _incAddY[crossSkyTail] = y;
                                _incAddZ[crossSkyTail] = baseZ + z + LIGHT_DIR_DZ[i];
                                crossSkyTail++;
                            }
                            pendingChunkUpdates.add(nKeys[i]);
                        }
                    }
                }
                continue;
            }

            const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
            const nOp = getBlockLightOpacity(voxelData[nIdx] & 0xFFF);
            if (nOp < 15) {
                const nextSky = (i === 3 && skyLight === 15) ? (15 - nOp) : (skyLight - (nOp > 1 ? nOp : 1));
                if (nextSky > ((lightData[nIdx] >> 4) & 15)) {
                    lightData[nIdx] = (nextSky << 4) | (lightData[nIdx] & 15);
                    pushLocal(nIdx);
                }
            }
        }
    }

    // 隣接チャンクへ漏れ出した天空光を奥まで一括伝播
    if (crossSkyTail > 0) {
        _runSkyLightAddBFS(0, crossSkyTail, pendingChunkUpdates);
    }

    // ======================================================
    // 🕯️ PHASE 2: ブロック光 (BlockLight)
    // ======================================================
    head = 0;
    tail = 0;

    // 2-A: Phase 1-A で同時収集済みの発光ブロックを直接投入（65536全走査ゼロ）
    for (let i = 0; i < bSeedCount; i = (i + 1) | 0) {
        const idx = _blockSeedIndices[i];
        const lvl = _blockSeedLevels[i];
        lightData[idx] = (lightData[idx] & 0xF0) | lvl;
        pushLocal(idx);
    }

    // 2-B: 隣接4チャンクからのブロック光流入
    let crossBlkTail = 0;
    for (let i = 0; i < 6; i = (i + 1) | 0) {
        const nm = nMaps[i];
        if (!nm) continue;

        for (let s = 0; s < 16; s = (s + 1) | 0) {
            let x = 0, z = 0, nLx = 0, nLz = 0;
            if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
            else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
            else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
            else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

            const myCol = (z << 8) | (x << 12);
            const nCol = (nLz << 8) | (nLx << 12);

            for (let y = 0; y < 256; y = (y + 1) | 0) {
                const nBlk = nm[nCol | y] & 15;
                if (nBlk <= 1) continue;

                const idx = myCol | y;
                const myOp = getBlockLightOpacity(voxelData[idx] & 0xFFF);
                if (myOp >= 15) continue;

                const nextBlk = nBlk - (myOp > 1 ? myOp : 1);
                if (nextBlk > (lightData[idx] & 15)) {
                    lightData[idx] = (lightData[idx] & 0xF0) | nextBlk;
                    pushLocal(idx);
                }
            }
        }
    }

    // 2-C: ブロック光BFS（リングバッファ）
    while (head < tail) {
        const idx = queue[head & LIGHT_RING_MASK] | 0;
        head++;
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
                    const nOp = getBlockLightOpacity(nv[nIdx] & 0xFFF);
                    if (nOp < 15) {
                        const nextBlk = blockLight - (nOp > 1 ? nOp : 1);
                        if (nextBlk > (nm[nIdx] & 15)) {
                            nm[nIdx] = (nm[nIdx] & 0xF0) | nextBlk;
                            if (crossBlkTail < INC_RING_MASK) {
                                _incAddX[crossBlkTail] = baseX + x + LIGHT_DIR_DX[i];
                                _incAddY[crossBlkTail] = y;
                                _incAddZ[crossBlkTail] = baseZ + z + LIGHT_DIR_DZ[i];
                                crossBlkTail++;
                            }
                            pendingChunkUpdates.add(nKeys[i]);
                        }
                    }
                }
                continue;
            }

            const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
            const nOp = getBlockLightOpacity(voxelData[nIdx] & 0xFFF);
            if (nOp < 15) {
                const nextBlk = blockLight - (nOp > 1 ? nOp : 1);
                if (nextBlk > (lightData[nIdx] & 15)) {
                    lightData[nIdx] = (lightData[nIdx] & 0xF0) | nextBlk;
                    pushLocal(nIdx);
                }
            }
        }
    }

    if (crossBlkTail > 0) {
        _runBlockLightAddBFS(0, crossBlkTail, pendingChunkUpdates);
    }

    return lightData;
}

// =======================================================
// 【チャンクメッシュ生成用 高速定数・属性ルックアップ・スクラッチプール】
// =======================================================
const FACE_FW = new Float32Array([0.8, 0.8, 1.0, 0.5, 0.65, 0.65]);

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

// 実行時に registerCustomBlock で追加された新ブロックを先頭定義の全高速配列＆名称表へ自動同期
onBlockRegistered((key, cfg) => {
    _syncBlockFastEntry(cfg.id, cfg);
    BLOCK_NAMES[cfg.id] = key.charAt(0) + key.slice(1).toLowerCase();
});

/**
 * 宣言的 shapeMode からカスタムジオメトリ生成用 shapeMeta(0..15) を統一解決する（ハードコード分岐排除）
 */
function resolveDynamicShapeMeta(type, cfg, meta, x, y, z, aboveType, getFn, getRawFn) {
    const mode = cfg.shapeMode;
    if (!mode || mode === "static") return 0;
    if (mode === "raw") return meta;
    if (mode === "connect_fence") return getConnectionMaskLocal(x, y, z, "fence", getFn);
    if (mode === "connect_pane") return getConnectionMaskLocal(x, y, z, "pane", getFn);
    if (mode === "connect_wire") return getRedstoneWireConnectionMaskLocal(x, y, z, getRawFn);
    if (mode === "liquid") return (aboveType === type) ? 1 : 0;
    if (mode.startsWith("propRaw:")) {
        return getBlockStateRawProp(type, meta, mode.slice(8));
    }
    return meta;
}

function getBlockMaterialsFast(type, meta = 0) {
    const cfg = _blockConfigFastArray[type];
    if (cfg && cfg.hasStateMaterials) {
        return getBlockMaterialsForState(type, meta);
    }
    let mats = _blockMaterialsFastArray[type];
    if (mats === null) {
        mats = getBlockMaterials(type);
        _blockMaterialsFastArray[type] = mats;
    }
    return mats;
}

/**
 * ワイヤーから方向 (dx, dz) にある隣接ブロックへ接続すべきか判定する（リピーターは入出力2方向のみ接続）
 */
function canWireConnectToBlock(nRaw, dx, dz) {
    const nId = nRaw & 0xFFF;
    const nCfg = _blockConfigFastArray[nId];
    const mode = nCfg && nCfg.redstoneConnectsWire;
    if (!mode) return false;
    if (mode === "axis") {
        const rot = (nRaw >> 12) & 3;
        const rdx = REPEATER_OUT_DX[rot];
        const rdz = REPEATER_OUT_DZ[rot];
        // 前後(入出力)2方向のみ接続し、側面には接続しない
        return (dx === rdx && dz === rdz) || (dx === -rdx && dz === -rdz);
    }
    return true;
}

/**
 * 8bit ワイヤー接続マスクを返す（下位4bit=水平NSEW、上位4bit=1段上へ壁を登るNSEW）
 */
function getRedstoneWireConnectionMaskLocal(lx, ly, lz, getRawFn) {
    let mask = 0;
    const aboveId = (ly < CH_H - 1) ? (getRawFn(lx, ly + 1, lz) & 0xFFF) : 0;
    const canClimbUp = (_isOpaqueBlock[aboveId] === 0);

    for (let i = 0; i < 4; i++) {
        const dx = _CONN_OFFSETS_DX[i];
        const dz = _CONN_OFFSETS_DZ[i];
        const nx = lx + dx;
        const nz = lz + dz;
        const bit = _CONN_BITS[i];

        const sameRaw = getRawFn(nx, ly, nz);
        const sameId = sameRaw & 0xFFF;

        if (canWireConnectToBlock(sameRaw, dx, dz)) {
            mask |= (1 << bit);
            continue;
        }

        // 1ブロック上へ登るワイヤー（自直上が不透明でなく、隣が壁/段差）
        if (canClimbUp && ly < CH_H - 1 && (getRawFn(nx, ly + 1, nz) & 0xFFF) === BLOCK_TYPES.REDSTONE_WIRE) {
            mask |= (1 << bit);
            if (_isOpaqueBlock[sameId] === 1) {
                mask |= (1 << (bit + 4)); // 壁を垂直に登る立ち上がり面を有効化
            }
            continue;
        }

        // 1ブロック下へ降りるワイヤー（隣の同高度が不透明でなければ接続）
        if (ly > 0 && _isOpaqueBlock[sameId] === 0 && (getRawFn(nx, ly - 1, nz) & 0xFFF) === BLOCK_TYPES.REDSTONE_WIRE) {
            mask |= (1 << bit);
        }
    }
    return mask;
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
const _mTemp = new THREE.Matrix4();

// --- 再利用スクラッチバッチプール（毎チャンク176KB使い捨て割り当てを完全ゼロ化） ---
const _meshBatchPool = [];
const _opaqueBatchMap = new Map();
const _waterBatchMap = new Map();

// MeshBasicMaterial は normal 属性を参照しないため撤去し、color は 8bit 正規化(Uint8Array)で 44B -> 23B/頂点へ圧縮
function acquireMeshBatch() {
    if (_meshBatchPool.length > 0) {
        const b = _meshBatchPool.pop();
        b.vCount = 0;
        b.iCount = 0;
        return b;
    }
    const initV = 256;
    const initI = 384;
    return {
        pos: new Float32Array(initV * 3),
        col: new Uint8Array(initV * 3),
        uv: new Float32Array(initV * 2),
        idx: new Uint32Array(initI),
        vCap: initV,
        iCap: initI,
        vCount: 0,
        iCount: 0
    };
}

function ensureBatchCapacity(batch, addVerts, addIndices) {
    const needV = batch.vCount + addVerts;
    if (needV > batch.vCap) {
        let nextV = batch.vCap;
        while (nextV < needV) nextV <<= 1;
        const nPos = new Float32Array(nextV * 3);
        const nCol = new Uint8Array(nextV * 3);
        const nUv = new Float32Array(nextV * 2);
        const curV3 = batch.vCount * 3;
        const curV2 = batch.vCount * 2;
        if (curV3 > 0) {
            nPos.set(batch.pos.subarray(0, curV3));
            nCol.set(batch.col.subarray(0, curV3));
            nUv.set(batch.uv.subarray(0, curV2));
        }
        batch.pos = nPos;
        batch.col = nCol;
        batch.uv = nUv;
        batch.vCap = nextV;
    }

    const needI = batch.iCount + addIndices;
    if (needI > batch.iCap) {
        let nextI = batch.iCap;
        while (nextI < needI) nextI <<= 1;
        const nIdx = new Uint32Array(nextI);
        if (batch.iCount > 0) {
            nIdx.set(batch.idx.subarray(0, batch.iCount));
        }
        batch.idx = nIdx;
        batch.iCap = nextI;
    }
}

function getOrAcquireBatch(batchMap, mat) {
    let b = batchMap.get(mat);
    if (b === undefined) {
        b = acquireMeshBatch();
        batchMap.set(mat, b);
    }
    return b;
}

const MAX_MESH_BATCH_POOL = 24;
const MAX_POOLED_BATCH_VERTS = 8192;

function releaseBatchMap(batchMap) {
    for (const batch of batchMap.values()) {
        batch.vCount = 0;
        batch.iCount = 0;
        if (_meshBatchPool.length < MAX_MESH_BATCH_POOL && batch.vCap <= MAX_POOLED_BATCH_VERTS) {
            _meshBatchPool.push(batch);
        }
    }
    batchMap.clear();
}

// --- 2D Greedy Meshing 用再利用バッファ（ゼロGC） ---
const _chunkColMaxY = new Int16Array(256);
const _greedyMaskPos = new Int32Array(16 * CH_H); // +X / +Y / +Z 面用
const _greedyMaskNeg = new Int32Array(16 * CH_H); // -X / -Y / -Z 面用
const _greedyMatToId = new Map();
const _greedyIdToMat = [null]; // 1-based（0 は「面なし」予約）

function getGreedyMatId(mat) {
    let id = _greedyMatToId.get(mat);
    if (id === undefined) {
        id = _greedyIdToMat.length;
        _greedyIdToMat.push(mat);
        _greedyMatToId.set(mat, id);
    }
    return id;
}

// --- カスタム形状テンプレート事前ベイクキャッシュ（ブロックごとの BufferGeometry / applyMatrix4 を完全撲滅） ---
const _bakedCustomTemplateCache = new Map();

// three.js r128 公式最適化: WebGL バッファ転送完了直後に JS 側 TypedArray を解放し二重メモリ常駐をゼロ化
function releaseUploadedTypedArray() {
    this.array = null;
}

function getBakedCustomTemplate(type, cfg, shapeMeta, transformMeta) {
    // 8bit shapeMeta(ワイヤー水平4bit+上り4bit等)を衝突なしでキャッシュ
    const key = (type << 12) | ((shapeMeta & 0xFF) << 4) | (transformMeta & 0xF);
    const cached = _bakedCustomTemplateCache.get(key);
    if (cached !== undefined) return cached;

    const srcGeom = getBlockGeometry(cfg.geometryType, cfg, shapeMeta);
    if (!srcGeom) {
        _bakedCustomTemplateCache.set(key, null);
        return null;
    }

    const posAttr = srcGeom.getAttribute('position');
    const normAttr = srcGeom.getAttribute('normal');
    const uvAttr = srcGeom.getAttribute('uv');
    const indexAttr = srcGeom.index;
    const totalIdxCount = indexAttr ? indexAttr.count : posAttr.count;
    const groups = (srcGeom.groups && srcGeom.groups.length > 0)
        ? srcGeom.groups
        : [{ start: 0, count: totalIdxCount, materialIndex: 0 }];

    getCustomGeometryMatrix(transformMeta, _m1, _r1, _mTemp);
    _mTemp.makeTranslation(0.5, 0.5, 0.5);
    _m1.premultiply(_mTemp);

    const isUpsideDown = ((transformMeta >> 2) & 1) !== 0;
    const isCross = (cfg.geometryType === "cross");
    const useSelfLight = isCross || (cfg.isLadder === true);
    const bakedGroups = [];

    for (let g = 0; g < groups.length; g++) {
        const grp = groups[g];
        const start = grp.start;
        const end = Math.min(start + grp.count, totalIdxCount);
        const idxCount = end - start;
        if (idxCount <= 0) continue;

        const vertRemap = new Map();
        const localIndices = new Uint16Array(idxCount);
        const origVertIndices = [];

        for (let k = 0; k < idxCount; k++) {
            const oldIdx = indexAttr ? indexAttr.array[start + k] : (start + k);
            let newIdx = vertRemap.get(oldIdx);
            if (newIdx === undefined) {
                newIdx = origVertIndices.length;
                vertRemap.set(oldIdx, newIdx);
                origVertIndices.push(oldIdx);
            }
            localIndices[k] = newIdx;
        }

        const vertCount = origVertIndices.length;
        const bPos = new Float32Array(vertCount * 3);
        const bUv = new Float32Array(vertCount * 2);

        const firstOld = origVertIndices[0] * 3;
        const fnx = normAttr ? normAttr.array[firstOld] : 0;
        const fny = normAttr ? normAttr.array[firstOld + 1] : 1;
        const fnz = normAttr ? normAttr.array[firstOld + 2] : 0;
        const ax = Math.abs(fnx), ay = Math.abs(fny), az = Math.abs(fnz);
        let dir;
        if (ax >= ay && ax >= az) dir = fnx > 0 ? 0 : 1;
        else if (ay >= ax && ay >= az) dir = fny > 0 ? 2 : 3;
        else dir = fnz > 0 ? 4 : 5;

        _v1.copy(_dirVectors[dir]).applyMatrix4(_r1);
        const wdx = Math.round(_v1.x);
        const wdy = Math.round(_v1.y);
        const wdz = Math.round(_v1.z);

        let fw = 1.0;
        if (!isCross) {
            if (wdy > 0.5) fw = 1.0;
            else if (wdy < -0.5) fw = 0.5;
            else if (Math.abs(wdz) > 0.5) fw = 0.65;
            else fw = 0.8;
        }

        for (let vi = 0; vi < vertCount; vi++) {
            const oi = origVertIndices[vi];
            const o3 = oi * 3;
            const o2 = oi * 2;
            const d3 = vi * 3;
            const d2 = vi * 2;

            _v1.set(posAttr.array[o3], posAttr.array[o3 + 1], posAttr.array[o3 + 2]).applyMatrix4(_m1);
            bPos[d3] = _v1.x;
            bPos[d3 + 1] = _v1.y;
            bPos[d3 + 2] = _v1.z;

            const ony = normAttr ? normAttr.array[o3 + 1] : 1;
            let u = uvAttr ? uvAttr.array[o2] : 0;
            let v = uvAttr ? uvAttr.array[o2 + 1] : 0;
            if (isUpsideDown && Math.abs(ony) < 0.1) {
                u = 1.0 - u;
                v = 1.0 - v;
            }
            bUv[d2] = u;
            bUv[d2 + 1] = v;
        }

        bakedGroups.push({
            pos: bPos,
            uv: bUv,
            idx: localIndices,
            vertCount,
            idxCount,
            matIdx: grp.materialIndex,
            dir,
            wdx,
            wdy,
            wdz,
            fw255: fw * 255.0,
            useSelfLight
        });
    }

    _bakedCustomTemplateCache.set(key, bakedGroups);
    return bakedGroups;
}

// フェード終了時の共有 originMat 復帰（単一・配列マテリアル両対応、クロージャ生成ゼロ）
function finalizeChunkMeshFade() {
    if (!this.material) return;
    if (Array.isArray(this.material)) {
        for (let i = 0; i < this.material.length; i++) {
            const m = this.material[i];
            const o = m && m.userData && m.userData.originMat;
            if (o) {
                m.dispose();
                this.material[i] = o;
            }
        }
    } else {
        const o = this.material.userData && this.material.userData.originMat;
        if (o) {
            this.material.dispose();
            this.material = o;
        }
    }
}

function createFadeCloneMaterial(originMat) {
    const fadeMat = originMat.clone();
    fadeMat.vertexColors = true;
    fadeMat.transparent = true;
    fadeMat.opacity = 0;
    fadeMat.depthWrite = false;
    if (fadeMat.color) fadeMat.color.set(0xffffff);
    fadeMat.userData = {
        originMat,
        realOpacity: originMat.opacity !== undefined ? originMat.opacity : 1.0,
        shaderUniforms: originMat.userData ? originMat.userData.shaderUniforms : null
    };
    if (originMat.customProgramCacheKey) fadeMat.customProgramCacheKey = originMat.customProgramCacheKey;
    if (originMat.onBeforeCompile) fadeMat.onBeforeCompile = originMat.onBeforeCompile;
    return fadeMat;
}

/**
 * スクラッチバッチ群から単一統合 BufferGeometry を構築（23B/頂点・Uint8正規化カラー・onUpload即解放）
 */
function buildCombinedMeshFromBatches(batchMap, renderOrder, useFadeIn, baseX, baseZ, maxY) {
    let totalVerts = 0;
    let totalIndices = 0;

    for (const batch of batchMap.values()) {
        if (batch.vCount > 0 && batch.iCount > 0) {
            totalVerts += batch.vCount;
            totalIndices += batch.iCount;
        }
    }

    if (totalVerts === 0 || totalIndices === 0) return null;

    const finalPos = new Float32Array(totalVerts * 3);
    const finalCol = new Uint8Array(totalVerts * 3);
    const finalUv = new Float32Array(totalVerts * 2);
    const finalIdx = (totalVerts <= 65535)
        ? new Uint16Array(totalIndices)
        : new Uint32Array(totalIndices);

    const geom = new THREE.BufferGeometry();
    const materials = [];

    let vOffset = 0;
    let iOffset = 0;

    for (const [originMat, batch] of batchMap.entries()) {
        const vc = batch.vCount;
        const ic = batch.iCount;
        if (vc === 0 || ic === 0) continue;

        const v3 = vc * 3;
        const v2 = vc * 2;
        finalPos.set(batch.pos.subarray(0, v3), vOffset * 3);
        finalCol.set(batch.col.subarray(0, v3), vOffset * 3);
        finalUv.set(batch.uv.subarray(0, v2), vOffset * 2);

        const srcIdx = batch.idx;
        for (let k = 0; k < ic; k++) {
            finalIdx[iOffset + k] = srcIdx[k] + vOffset;
        }

        const matIndex = materials.length;
        materials.push(useFadeIn ? createFadeCloneMaterial(originMat) : originMat);
        geom.addGroup(iOffset, ic, matIndex);

        vOffset += vc;
        iOffset += ic;
    }

    // GPU アップロード完了直後に JS 側配列参照を解放（boundingBox/Sphere 事前確定済みのため安全）
    geom.setAttribute('position', new THREE.BufferAttribute(finalPos, 3).onUpload(releaseUploadedTypedArray));
    geom.setAttribute('color', new THREE.BufferAttribute(finalCol, 3, true).onUpload(releaseUploadedTypedArray));
    geom.setAttribute('uv', new THREE.BufferAttribute(finalUv, 2).onUpload(releaseUploadedTypedArray));
    geom.setIndex(new THREE.BufferAttribute(finalIdx, 1).onUpload(releaseUploadedTypedArray));

    const boxMaxY = (maxY + 1) < CH_H ? (maxY + 1) : CH_H;
    const cxS = baseX + 8.0;
    const cyS = boxMaxY * 0.5;
    const czS = baseZ + 8.0;
    const radius = Math.sqrt(64.0 + cyS * cyS + 64.0);
    geom.boundingBox = new THREE.Box3(
        new THREE.Vector3(baseX, 0, baseZ),
        new THREE.Vector3(baseX + CH_S, boxMaxY, baseZ + CH_S)
    );
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(cxS, cyS, czS), radius);

    const meshMat = (materials.length === 1) ? materials[0] : materials;
    const mesh = new THREE.Mesh(geom, meshMat);
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (useFadeIn) {
        mesh.userData.finalizeFade = finalizeChunkMeshFade;
    }
    return mesh;
}

// 4近傍の未ロード／ライト未計算状態を表すビットマスク定数
const NEIGHBOR_BIT_PX = 1 << 0; // +X (cx + 1, cz)
const NEIGHBOR_BIT_NX = 1 << 1; // -X (cx - 1, cz)
const NEIGHBOR_BIT_PZ = 1 << 2; // +Z (cx, cz + 1)
const NEIGHBOR_BIT_NZ = 1 << 3; // -Z (cx, cz - 1)

// 3x3 隣接チャンク参照用再利用バッファ（index = (dx + 1) * 3 + (dz + 1)、中央は 4）
const _boundaryVoxelGrid = new Array(9).fill(null);
const _boundaryLightGrid = new Array(9).fill(null);

function populateChunkBoundaryView(cx, cz, centerVoxelData, centerLightMap) {
    let missingNeighborMask = 0;

    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const gridIdx = (dx + 1) * 3 + (dz + 1);
            if (dx === 0 && dz === 0) {
                _boundaryVoxelGrid[4] = centerVoxelData;
                _boundaryLightGrid[4] = centerLightMap;
                continue;
            }

            const nKey = encodeChunkKey(cx + dx, cz + dz);
            // 読み込み済みデータのみ参照し、メッシュ生成中の同期連鎖生成を防ぐ
            const nVoxel = ChunkSaveManager.modifiedChunks.get(nKey) || chunkReadOnlyCache.get(nKey) || null;
            const nLight = chunkLightCache.get(nKey) || null;

            _boundaryVoxelGrid[gridIdx] = nVoxel;
            _boundaryLightGrid[gridIdx] = nLight;

            if (!nVoxel || !nLight) {
                if (dx === 1 && dz === 0) missingNeighborMask |= NEIGHBOR_BIT_PX;
                else if (dx === -1 && dz === 0) missingNeighborMask |= NEIGHBOR_BIT_NX;
                else if (dx === 0 && dz === 1) missingNeighborMask |= NEIGHBOR_BIT_PZ;
                else if (dx === 0 && dz === -1) missingNeighborMask |= NEIGHBOR_BIT_NZ;
            }
        }
    }

    return missingNeighborMask;
}

const _CONN_OFFSETS_DX = [0, 0, 1, -1];
const _CONN_OFFSETS_DZ = [-1, 1, 0, 0];
const _CONN_BITS = [3, 2, 1, 0]; // 北(3), 南(2), 東(1), 西(0)

function getConnectionMaskLocal(lx, ly, lz, targetGeometryType, getFn) {
    let mask = 0;
    for (let i = 0; i < 4; i++) {
        const neighborId = getFn(lx + _CONN_OFFSETS_DX[i], ly, lz + _CONN_OFFSETS_DZ[i]);
        if (neighborId === 0) continue;

        if (_isOpaqueBlock[neighborId] === 1) {
            mask |= (1 << _CONN_BITS[i]);
            continue;
        }
        const cfg = _blockConfigFastArray[neighborId];
        if (cfg && cfg.geometryType === targetGeometryType) {
            mask |= (1 << _CONN_BITS[i]);
        }
    }
    return mask;
}

function generateChunkMeshMultiTexture(cx, cz, useInstancing = false, useFadeIn = false) {
    const baseX = cx * CH_S;
    const baseZ = cz * CH_S;
    const container = new THREE.Object3D();
    container.userData.cx = cx;
    container.userData.cz = cz;

    const chunkKey = encodeChunkKey(cx, cz);
    let voxelData = ChunkSaveManager.modifiedChunks.get(chunkKey);
    let isNewChunk = false;

    // 隣接チャンクの木などでベース地形のみ先行生成されていた場合も確実に1回デコレーションを完了させる
    if (!voxelData || !ChunkSaveManager.decoratedChunks.has(chunkKey)) {
        voxelData = ChunkSaveManager.captureBaseChunkData(cx, cz);
        isNewChunk = true;
    }

    let lightMap = chunkLightCache.get(chunkKey);
    if (!lightMap || isNewChunk) {
        lightMap = generateChunkLightMap(chunkKey, voxelData);
    }

    // --- 3x3 境界スナップショットを構築し、未ロード4近傍ビットを記録 ---
    const missingNeighborMask = populateChunkBoundaryView(cx, cz, voxelData, lightMap);
    container.userData.missingNeighborMask = missingNeighborMask;

    // 1. 列ごとの最高非空気高度を一括計測（上空の完全空気層 70% を全パスから除外）
    let chunkMaxY = -1;
    for (let x = 0; x < CH_S; x = (x + 1) | 0) {
        const xOff = x << 12;
        const xCol = x << 4;
        for (let z = 0; z < CH_S; z = (z + 1) | 0) {
            const colBase = xOff | (z << 8);
            let y = CH_H - 1;
            while (y >= 0 && voxelData[colBase | y] === 0) y--;
            _chunkColMaxY[xCol | z] = y;
            if (y > chunkMaxY) chunkMaxY = y;
        }
    }
    if (chunkMaxY < 0) return container;

    // 3x3 境界ビュー対応 O(1) 生ボクセル取得（16bit: ID + 4bit BlockState）
    function getRawLocal(x, y, z) {
        if (y < 0 || y >= CH_H) return 0;

        if (((x | z) & ~15) === 0) {
            return voxelData[y | (z << 8) | (x << 12)];
        }

        const dx = (x >> 4) + 1;
        const dz = (z >> 4) + 1;
        if (dx < 0 || dx > 2 || dz < 0 || dz > 2) return 0;

        const nData = _boundaryVoxelGrid[dx * 3 + dz];
        if (!nData) return 0;

        return nData[y | ((z & 15) << 8) | ((x & 15) << 12)];
    }

    function get(x, y, z) {
        return getRawLocal(x, y, z) & 0xFFF;
    }

    // 3x3 境界ビュー対応 O(1) ライト取得（角座標対応・未ロード境界の地下ライトリーク防止）
    function getLightLevel(lx, ly, lz) {
        if (ly < 0) return 0;
        if (ly >= CH_H) return 0xF0;

        if (((lx | lz) & ~15) === 0) {
            return lightMap[ly | (lz << 8) | (lx << 12)];
        }

        const dx = (lx >> 4) + 1;
        const dz = (lz >> 4) + 1;
        if (dx >= 0 && dx <= 2 && dz >= 0 && dz <= 2) {
            const nlMap = _boundaryLightGrid[dx * 3 + dz];
            if (nlMap) {
                return nlMap[ly | ((lz & 15) << 8) | ((lx & 15) << 12)];
            }
        }

        const clampedX = lx < 0 ? 0 : (lx > 15 ? 15 : lx);
        const clampedZ = lz < 0 ? 0 : (lz > 15 ? 15 : lz);
        return lightMap[ly | (clampedZ << 8) | (clampedX << 12)];
    }

    // 隣接ブロックに対する面可視判定（インライン用）
    function shouldShowFace(myType, myOpaque, myCullSame, nType) {
        if (nType === 0) return true;
        if (_isOpaqueBlock[nType] === 1) return false;
        if (myOpaque === 1) return true;
        if (myCullSame === 1) return nType !== myType;
        return true;
    }

    // 再利用スクラッチ状態のリセット
    releaseBatchMap(_opaqueBatchMap);
    releaseBatchMap(_waterBatchMap);
    _greedyMatToId.clear();
    _greedyIdToMat.length = 1;

    // 2D Greedy Meshing で統合された1枚の極大クワッドをスクラッチバッチへ直書き（norm撤去・8bitカラー）
    function emitGreedyQuad(faceIdx, key, x0, y0, z0, w, h) {
        const mat = _greedyIdToMat[key >>> 8];
        if (!mat) return;

        const batch = getOrAcquireBatch(_opaqueBatchMap, mat);
        ensureBatchCapacity(batch, 4, 6);

        const light = key & 0xFF;
        const fw255 = FACE_FW[faceIdx] * 255.0;
        let sByte = (LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw255 + 0.5) | 0;
        let bByte = (LIGHT_LEVEL_FACTORS[light & 15] * fw255 + 0.5) | 0;
        if (sByte > 255) sByte = 255;
        if (bByte > 255) bByte = 255;

        const vBase = batch.vCount;
        const p0 = vBase * 3;
        const u0 = vBase * 2;
        const i0 = batch.iCount;
        const pos = batch.pos;
        const col = batch.col;
        const uv = batch.uv;
        const idx = batch.idx;

        if (faceIdx === 2) { // +Y: u=x(w), v=z(h)
            const yTop = y0 + 1;
            pos[p0] = x0; pos[p0 + 1] = yTop; pos[p0 + 2] = z0 + h;
            pos[p0 + 3] = x0 + w; pos[p0 + 4] = yTop; pos[p0 + 5] = z0 + h;
            pos[p0 + 6] = x0 + w; pos[p0 + 7] = yTop; pos[p0 + 8] = z0;
            pos[p0 + 9] = x0; pos[p0 + 10] = yTop; pos[p0 + 11] = z0;
        } else if (faceIdx === 3) { // -Y: u=x(w), v=z(h)
            pos[p0] = x0; pos[p0 + 1] = y0; pos[p0 + 2] = z0;
            pos[p0 + 3] = x0 + w; pos[p0 + 4] = y0; pos[p0 + 5] = z0;
            pos[p0 + 6] = x0 + w; pos[p0 + 7] = y0; pos[p0 + 8] = z0 + h;
            pos[p0 + 9] = x0; pos[p0 + 10] = y0; pos[p0 + 11] = z0 + h;
        } else if (faceIdx === 0) { // +X: u=z(w), v=y(h)
            const xRight = x0 + 1;
            pos[p0] = xRight; pos[p0 + 1] = y0; pos[p0 + 2] = z0 + w;
            pos[p0 + 3] = xRight; pos[p0 + 4] = y0; pos[p0 + 5] = z0;
            pos[p0 + 6] = xRight; pos[p0 + 7] = y0 + h; pos[p0 + 8] = z0;
            pos[p0 + 9] = xRight; pos[p0 + 10] = y0 + h; pos[p0 + 11] = z0 + w;
        } else if (faceIdx === 1) { // -X: u=z(w), v=y(h)
            pos[p0] = x0; pos[p0 + 1] = y0; pos[p0 + 2] = z0;
            pos[p0 + 3] = x0; pos[p0 + 4] = y0; pos[p0 + 5] = z0 + w;
            pos[p0 + 6] = x0; pos[p0 + 7] = y0 + h; pos[p0 + 8] = z0 + w;
            pos[p0 + 9] = x0; pos[p0 + 10] = y0 + h; pos[p0 + 11] = z0;
        } else if (faceIdx === 4) { // +Z: u=x(w), v=y(h)
            const zFront = z0 + 1;
            pos[p0] = x0; pos[p0 + 1] = y0; pos[p0 + 2] = zFront;
            pos[p0 + 3] = x0 + w; pos[p0 + 4] = y0; pos[p0 + 5] = zFront;
            pos[p0 + 6] = x0 + w; pos[p0 + 7] = y0 + h; pos[p0 + 8] = zFront;
            pos[p0 + 9] = x0; pos[p0 + 10] = y0 + h; pos[p0 + 11] = zFront;
        } else { // 5: -Z: u=x(w), v=y(h)
            pos[p0] = x0 + w; pos[p0 + 1] = y0; pos[p0 + 2] = z0;
            pos[p0 + 3] = x0; pos[p0 + 4] = y0; pos[p0 + 5] = z0;
            pos[p0 + 6] = x0; pos[p0 + 7] = y0 + h; pos[p0 + 8] = z0;
            pos[p0 + 9] = x0 + w; pos[p0 + 10] = y0 + h; pos[p0 + 11] = z0;
        }

        // 8bit 正規化カラー（明るさはシェーダーの u_brightness Uniform で O(1) 乗算）
        col[p0] = sByte; col[p0 + 1] = bByte; col[p0 + 2] = 0;
        col[p0 + 3] = sByte; col[p0 + 4] = bByte; col[p0 + 5] = 0;
        col[p0 + 6] = sByte; col[p0 + 7] = bByte; col[p0 + 8] = 0;
        col[p0 + 9] = sByte; col[p0 + 10] = bByte; col[p0 + 11] = 0;

        // RepeatWrapping により (w, h) 倍タイル描画（テクスチャアトラス不使用）
        uv[u0] = 0; uv[u0 + 1] = 0;
        uv[u0 + 2] = w; uv[u0 + 3] = 0;
        uv[u0 + 4] = w; uv[u0 + 5] = h;
        uv[u0 + 6] = 0; uv[u0 + 7] = h;

        idx[i0] = vBase;
        idx[i0 + 1] = vBase + 1;
        idx[i0 + 2] = vBase + 2;
        idx[i0 + 3] = vBase;
        idx[i0 + 4] = vBase + 2;
        idx[i0 + 5] = vBase + 3;

        batch.vCount = vBase + 4;
        batch.iCount = i0 + 6;
    }

    // 2Dマスク配列（U_SIZE x V_SIZE）を走査して極大長方形へ統合する共通 Greedy 関数
    function runGreedySlice(mask, uSize, vSize, faceIdx, fixedAxisVal) {
        for (let v = 0; v < vSize; v = (v + 1) | 0) {
            const rowOff = v * uSize;
            for (let u = 0; u < uSize;) {
                const key = mask[rowOff + u];
                if (key === 0) { u++; continue; }

                // U方向へ極大幅 w を拡張
                let w = 1;
                while (u + w < uSize && mask[rowOff + u + w] === key) w++;

                // V方向へ極大高さ h を拡張
                let h = 1;
                outer: while (v + h < vSize) {
                    const nextRow = (v + h) * uSize + u;
                    for (let k = 0; k < w; k++) {
                        if (mask[nextRow + k] !== key) break outer;
                    }
                    h++;
                }

                // 消費済みセルを 0 にクリア
                for (let dv = 0; dv < h; dv++) {
                    const clrRow = (v + dv) * uSize + u;
                    for (let du = 0; du < w; du++) {
                        mask[clrRow + du] = 0;
                    }
                }

                if (faceIdx === 2 || faceIdx === 3) {
                    emitGreedyQuad(faceIdx, key, baseX + u, BEDROCK_LEVEL + fixedAxisVal, baseZ + v, w, h);
                } else if (faceIdx === 0 || faceIdx === 1) {
                    emitGreedyQuad(faceIdx, key, baseX + fixedAxisVal, BEDROCK_LEVEL + v, baseZ + u, w, h);
                } else {
                    emitGreedyQuad(faceIdx, key, baseX + u, BEDROCK_LEVEL + v, baseZ + fixedAxisVal, w, h);
                }

                u += w;
            }
        }
    }

    // =========================================================================
    // PASS 1: 3軸 2D Greedy Meshing（通常の立方体＋葉ブロック・横向き原木除く）
    // =========================================================================
    if (!useInstancing) {
        const H_MAX = CH_H - 1;

        // 1-A. Y軸スライス（+Y: 2 / -Y: 3）
        for (let y = 0; y <= chunkMaxY; y = (y + 1) | 0) {
            let hasPos = false;
            let hasNeg = false;

            for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                const rowOff = z << 4;
                const zShift = z << 8;
                for (let x = 0; x < CH_S; x = (x + 1) | 0) {
                    const cellIdx = rowOff | x;
                    const vIdx = y | zShift | (x << 12);
                    const raw = voxelData[vIdx];
                    const type = raw & 0xFFF;

                    if (type === 0 || _isGreedyCubeBlock[type] === 0 || (_isLogBlock[type] === 1 && (raw >> 12) !== 0)) {
                        _greedyMaskPos[cellIdx] = 0;
                        _greedyMaskNeg[cellIdx] = 0;
                        continue;
                    }

                    const myOp = _isOpaqueBlock[type];
                    const myCs = _cullSameBlock[type];
                    const mats = getBlockMaterialsFast(type, (raw >> 12) & 0xF);

                    const upType = (y < H_MAX) ? (voxelData[vIdx + 1] & 0xFFF) : 0;
                    if (shouldShowFace(type, myOp, myCs, upType) && mats) {
                        const m = mats[2] || mats[0];
                        _greedyMaskPos[cellIdx] = (getGreedyMatId(m) << 8) | getLightLevel(x, y + 1, z);
                        hasPos = true;
                    } else {
                        _greedyMaskPos[cellIdx] = 0;
                    }

                    const dnType = (y > 0) ? (voxelData[vIdx - 1] & 0xFFF) : 0;
                    if (shouldShowFace(type, myOp, myCs, dnType) && mats) {
                        const m = mats[3] || mats[0];
                        _greedyMaskNeg[cellIdx] = (getGreedyMatId(m) << 8) | getLightLevel(x, y - 1, z);
                        hasNeg = true;
                    } else {
                        _greedyMaskNeg[cellIdx] = 0;
                    }
                }
            }

            if (hasPos) runGreedySlice(_greedyMaskPos, CH_S, CH_S, 2, y);
            if (hasNeg) runGreedySlice(_greedyMaskNeg, CH_S, CH_S, 3, y);
        }

        // 1-B. X軸スライス（+X: 0 / -X: 1）
        const vSizeXZ = chunkMaxY + 1;
        for (let x = 0; x < CH_S; x = (x + 1) | 0) {
            let hasPos = false;
            let hasNeg = false;
            const xShift = x << 12;

            for (let y = 0; y <= chunkMaxY; y = (y + 1) | 0) {
                const rowOff = y << 4;
                for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                    const cellIdx = rowOff | z;
                    const vIdx = y | (z << 8) | xShift;
                    const raw = voxelData[vIdx];
                    const type = raw & 0xFFF;

                    if (type === 0 || _isGreedyCubeBlock[type] === 0 || (_isLogBlock[type] === 1 && (raw >> 12) !== 0)) {
                        _greedyMaskPos[cellIdx] = 0;
                        _greedyMaskNeg[cellIdx] = 0;
                        continue;
                    }

                    const myOp = _isOpaqueBlock[type];
                    const myCs = _cullSameBlock[type];
                    const mats = getBlockMaterialsFast(type, (raw >> 12) & 0xF);

                    const pxType = (x < 15) ? (voxelData[vIdx + STRIDE_X] & 0xFFF) : get(x + 1, y, z);
                    if (shouldShowFace(type, myOp, myCs, pxType) && mats) {
                        const m = mats[0];
                        _greedyMaskPos[cellIdx] = (getGreedyMatId(m) << 8) | getLightLevel(x + 1, y, z);
                        hasPos = true;
                    } else {
                        _greedyMaskPos[cellIdx] = 0;
                    }

                    const nxType = (x > 0) ? (voxelData[vIdx - STRIDE_X] & 0xFFF) : get(x - 1, y, z);
                    if (shouldShowFace(type, myOp, myCs, nxType) && mats) {
                        const m = mats[1] || mats[0];
                        _greedyMaskNeg[cellIdx] = (getGreedyMatId(m) << 8) | getLightLevel(x - 1, y, z);
                        hasNeg = true;
                    } else {
                        _greedyMaskNeg[cellIdx] = 0;
                    }
                }
            }

            if (hasPos) runGreedySlice(_greedyMaskPos, CH_S, vSizeXZ, 0, x);
            if (hasNeg) runGreedySlice(_greedyMaskNeg, CH_S, vSizeXZ, 1, x);
        }

        // 1-C. Z軸スライス（+Z: 4 / -Z: 5）
        for (let z = 0; z < CH_S; z = (z + 1) | 0) {
            let hasPos = false;
            let hasNeg = false;
            const zShift = z << 8;

            for (let y = 0; y <= chunkMaxY; y = (y + 1) | 0) {
                const rowOff = y << 4;
                for (let x = 0; x < CH_S; x = (x + 1) | 0) {
                    const cellIdx = rowOff | x;
                    const vIdx = y | zShift | (x << 12);
                    const raw = voxelData[vIdx];
                    const type = raw & 0xFFF;

                    if (type === 0 || _isGreedyCubeBlock[type] === 0 || (_isLogBlock[type] === 1 && (raw >> 12) !== 0)) {
                        _greedyMaskPos[cellIdx] = 0;
                        _greedyMaskNeg[cellIdx] = 0;
                        continue;
                    }

                    const myOp = _isOpaqueBlock[type];
                    const myCs = _cullSameBlock[type];
                    const mats = getBlockMaterialsFast(type, (raw >> 12) & 0xF);

                    const pzType = (z < 15) ? (voxelData[vIdx + STRIDE_Z] & 0xFFF) : get(x, y, z + 1);
                    if (shouldShowFace(type, myOp, myCs, pzType) && mats) {
                        const m = mats[4] || mats[0];
                        _greedyMaskPos[cellIdx] = (getGreedyMatId(m) << 8) | getLightLevel(x, y, z + 1);
                        hasPos = true;
                    } else {
                        _greedyMaskPos[cellIdx] = 0;
                    }

                    const nzType = (z > 0) ? (voxelData[vIdx - STRIDE_Z] & 0xFFF) : get(x, y, z - 1);
                    if (shouldShowFace(type, myOp, myCs, nzType) && mats) {
                        const m = mats[5] || mats[0];
                        _greedyMaskNeg[cellIdx] = (getGreedyMatId(m) << 8) | getLightLevel(x, y, z - 1);
                        hasNeg = true;
                    } else {
                        _greedyMaskNeg[cellIdx] = 0;
                    }
                }
            }

            if (hasPos) runGreedySlice(_greedyMaskPos, CH_S, vSizeXZ, 4, z);
            if (hasNeg) runGreedySlice(_greedyMaskNeg, CH_S, vSizeXZ, 5, z);
        }
    }

    // =========================================================================
    // PASS 2: カスタム形状（事前ベイク直書き）＆ 横向き原木（ゼロGC直書き）
    // =========================================================================
    for (let x = 0; x < CH_S; x = (x + 1) | 0) {
        const wx = baseX + x;
        const xOff = x << 12;
        const xCol = x << 4;

        for (let z = 0; z < CH_S; z = (z + 1) | 0) {
            const colMax = _chunkColMaxY[xCol | z];
            if (colMax < 0) continue;

            const wz = baseZ + z;
            const colBase = xOff | (z << 8);

            for (let y = 0; y <= colMax; y = (y + 1) | 0) {
                const vIdx = colBase | y;
                const raw = voxelData[vIdx];
                if (raw === 0) continue;

                const type = raw & 0xFFF;
                const meta = (raw >> 12) & 0xF;

                // 2-A. カスタム形状（水・溶岩・草花・階段・スラブ・フェンス・板ガラス・カーペット・ハシゴ）
                if (_isCustomGeometryBlock[type] === 1) {
                    const cfg = _blockConfigFastArray[type];
                    if (!cfg) continue;

                    const gType = cfg.geometryType;
                    const isLiquid = (gType === "water");
                    const cullAdj = cfg.cullAdjacentFaces !== false;
                    const aboveType = (y < 255) ? (voxelData[vIdx + 1] & 0xFFF) : 0;
                    let visMask = 63;

                    // 水・溶岩など隣接カリング対象のみ6近傍チェックし、完全埋没ブロックおよび未ロード境界水壁をスキップ
                    if (cullAdj) {
                        const myOp = _isOpaqueBlock[type];
                        const myCs = _cullSameBlock[type];
                        visMask = 0;

                        if (x < 15) {
                            if (shouldShowFace(type, myOp, myCs, voxelData[vIdx + STRIDE_X] & 0xFFF)) visMask |= 1;
                        } else if (!isLiquid || _boundaryVoxelGrid[7] !== null) {
                            if (shouldShowFace(type, myOp, myCs, get(16, y, z))) visMask |= 1;
                        }

                        if (x > 0) {
                            if (shouldShowFace(type, myOp, myCs, voxelData[vIdx - STRIDE_X] & 0xFFF)) visMask |= 2;
                        } else if (!isLiquid || _boundaryVoxelGrid[1] !== null) {
                            if (shouldShowFace(type, myOp, myCs, get(-1, y, z))) visMask |= 2;
                        }

                        if (shouldShowFace(type, myOp, myCs, aboveType)) visMask |= 4;
                        if (shouldShowFace(type, myOp, myCs, (y > 0) ? (voxelData[vIdx - 1] & 0xFFF) : 0)) visMask |= 8;

                        if (z < 15) {
                            if (shouldShowFace(type, myOp, myCs, voxelData[vIdx + STRIDE_Z] & 0xFFF)) visMask |= 16;
                        } else if (!isLiquid || _boundaryVoxelGrid[5] !== null) {
                            if (shouldShowFace(type, myOp, myCs, get(x, y, 16))) visMask |= 16;
                        }

                        if (z > 0) {
                            if (shouldShowFace(type, myOp, myCs, voxelData[vIdx - STRIDE_Z] & 0xFFF)) visMask |= 32;
                        } else if (!isLiquid || _boundaryVoxelGrid[3] !== null) {
                            if (shouldShowFace(type, myOp, myCs, get(x, y, -1))) visMask |= 32;
                        }

                        if (visMask === 0) continue;
                    }

                    const shapeMeta = resolveDynamicShapeMeta(type, cfg, meta, x, y, z, aboveType, get, getRawLocal);
                    const transformMeta = getTransformMeta(type, meta);
                    const bakedGroups = getBakedCustomTemplate(type, cfg, shapeMeta, transformMeta);
                    if (!bakedGroups || bakedGroups.length === 0) continue;

                    const allMats = getBlockMaterialsFast(type, meta);
                    if (!allMats) continue;

                    const isWaterBlock = (type === BLOCK_TYPES.WATER || cfg.isWater === true);
                    const targetBatchMap = isWaterBlock ? _waterBatchMap : _opaqueBatchMap;
                    const wy = BEDROCK_LEVEL + y;

                    for (let g = 0, gLen = bakedGroups.length; g < gLen; g++) {
                        const grp = bakedGroups[g];
                        if (cullAdj && !cfg.isLadder && ((visMask >> grp.dir) & 1) === 0) continue;

                        const targetMat = allMats[grp.matIdx] || allMats[0];
                        if (!targetMat) continue;

                        const batch = getOrAcquireBatch(targetBatchMap, targetMat);
                        const vc = grp.vertCount;
                        const ic = grp.idxCount;
                        ensureBatchCapacity(batch, vc, ic);

                        const light = grp.useSelfLight
                            ? getLightLevel(x, y, z)
                            : getLightLevel(x + grp.wdx, y + grp.wdy, z + grp.wdz);
                        const fw255 = grp.fw255;
                        let sByte = (LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw255 + 0.5) | 0;
                        let bByte = (LIGHT_LEVEL_FACTORS[light & 15] * fw255 + 0.5) | 0;
                        if (sByte > 255) sByte = 255;
                        if (bByte > 255) bByte = 255;

                        const vBase = batch.vCount;
                        const bPos = batch.pos;
                        const bCol = batch.col;
                        const bUv = batch.uv;
                        const bIdx = batch.idx;
                        const gPos = grp.pos;

                        let p = vBase * 3;
                        for (let o = 0, len3 = vc * 3; o < len3; o += 3) {
                            bPos[p] = gPos[o] + wx;
                            bPos[p + 1] = gPos[o + 1] + wy;
                            bPos[p + 2] = gPos[o + 2] + wz;
                            bCol[p] = sByte;
                            bCol[p + 1] = bByte;
                            bCol[p + 2] = 0;
                            p += 3;
                        }

                        bUv.set(grp.uv, vBase * 2);

                        const gIdx = grp.idx;
                        let ip = batch.iCount;
                        for (let k = 0; k < ic; k++) {
                            bIdx[ip++] = vBase + gIdx[k];
                        }

                        batch.vCount = vBase + vc;
                        batch.iCount = ip;
                    }
                    continue;
                }

                // 2-B. 横向き原木（X軸・Z軸回転の LOG_OAK）
                if (_isLogBlock[type] === 1 && meta !== 0 && !useInstancing) {
                    const myOp = _isOpaqueBlock[type];
                    const myCs = _cullSameBlock[type];
                    let visMask = 0;
                    if (shouldShowFace(type, myOp, myCs, (x < 15) ? (voxelData[vIdx + STRIDE_X] & 0xFFF) : get(x + 1, y, z))) visMask |= 1;
                    if (shouldShowFace(type, myOp, myCs, (x > 0) ? (voxelData[vIdx - STRIDE_X] & 0xFFF) : get(x - 1, y, z))) visMask |= 2;
                    if (shouldShowFace(type, myOp, myCs, (y < 255) ? (voxelData[vIdx + 1] & 0xFFF) : 0)) visMask |= 4;
                    if (shouldShowFace(type, myOp, myCs, (y > 0) ? (voxelData[vIdx - 1] & 0xFFF) : 0)) visMask |= 8;
                    if (shouldShowFace(type, myOp, myCs, (z < 15) ? (voxelData[vIdx + STRIDE_Z] & 0xFFF) : get(x, y, z + 1))) visMask |= 16;
                    if (shouldShowFace(type, myOp, myCs, (z > 0) ? (voxelData[vIdx - STRIDE_Z] & 0xFFF) : get(x, y, z - 1))) visMask |= 32;
                    if (visMask === 0) continue;

                    const logMat = getLogRotationMatrixReadOnly(meta);
                    _r1.extractRotation(logMat);
                    const baseMats = getBlockMaterialsFast(type);
                    if (!baseMats) continue;
                    const wy = BEDROCK_LEVEL + y;

                    for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
                        const offset = faceIdx * 12;
                        _n1.set(CUBE_NORMALS[offset], CUBE_NORMALS[offset + 1], CUBE_NORMALS[offset + 2]).applyMatrix4(_r1);
                        const wNX = Math.round(_n1.x), wNY = Math.round(_n1.y), wNZ = Math.round(_n1.z);
                        const wBit = (wNX > 0) ? 0 : (wNX < 0) ? 1 : (wNY > 0) ? 2 : (wNY < 0) ? 3 : (wNZ > 0) ? 4 : 5;
                        if (((visMask >> wBit) & 1) === 0) continue;

                        const targetMat = baseMats[faceIdx] || baseMats[0];
                        if (!targetMat) continue;

                        const batch = getOrAcquireBatch(_opaqueBatchMap, targetMat);
                        ensureBatchCapacity(batch, 4, 6);

                        const fw = (wNY > 0) ? 1.0 : (wNY < 0) ? 0.5 : (Math.abs(wNX) > 0) ? 0.8 : 0.65;
                        const light = getLightLevel(x + wNX, y + wNY, z + wNZ);
                        const fw255 = fw * 255.0;
                        let sByte = (LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw255 + 0.5) | 0;
                        let bByte = (LIGHT_LEVEL_FACTORS[light & 15] * fw255 + 0.5) | 0;
                        if (sByte > 255) sByte = 255;
                        if (bByte > 255) bByte = 255;

                        const vBase = batch.vCount;
                        let p = vBase * 3;
                        const bPos = batch.pos;
                        const bCol = batch.col;

                        for (let j = 0; j < 12; j += 3) {
                            const oj = offset + j;
                            _v1.set(CUBE_VERTICES[oj], CUBE_VERTICES[oj + 1], CUBE_VERTICES[oj + 2]).applyMatrix4(logMat);
                            bPos[p] = _v1.x + wx;
                            bPos[p + 1] = _v1.y + wy;
                            bPos[p + 2] = _v1.z + wz;
                            bCol[p] = sByte;
                            bCol[p + 1] = bByte;
                            bCol[p + 2] = 0;
                            p += 3;
                        }

                        batch.uv.set(CUBE_UVS, vBase * 2);
                        const i0 = batch.iCount;
                        batch.idx[i0] = vBase;
                        batch.idx[i0 + 1] = vBase + 1;
                        batch.idx[i0 + 2] = vBase + 2;
                        batch.idx[i0 + 3] = vBase;
                        batch.idx[i0 + 4] = vBase + 2;
                        batch.idx[i0 + 5] = vBase + 3;

                        batch.vCount = vBase + 4;
                        batch.iCount = i0 + 6;
                    }
                }
            }
        }
    }

    // =========================================================================
    // PASS 3: 単一統合メッシュ構築（不透明/Cutout 1メッシュ ＋ 水 1メッシュ）
    // =========================================================================
    const opaqueMesh = buildCombinedMeshFromBatches(_opaqueBatchMap, 0, useFadeIn, baseX, baseZ, chunkMaxY);
    const waterMesh = buildCombinedMeshFromBatches(_waterBatchMap, 10, useFadeIn, baseX, baseZ, chunkMaxY);

    // スクラッチバッチをプールへ即返却（次チャンクでゼロGC再利用）
    releaseBatchMap(_opaqueBatchMap);
    releaseBatchMap(_waterBatchMap);

    if (opaqueMesh) {
        container.add(opaqueMesh);
        container.userData.opaqueMesh = opaqueMesh;
    }
    if (waterMesh) {
        container.add(waterMesh);
        container.userData.waterMesh = waterMesh;
    }

    // 精密 AABB フラスタムカリング用ボックスをコンテナへ保持し、毎フレームの行列再計算を無効化
    const boxMaxY = (chunkMaxY + 1) < CH_H ? (chunkMaxY + 1) : CH_H;
    container.userData.boundingBox = new THREE.Box3(
        new THREE.Vector3(baseX, 0, baseZ),
        new THREE.Vector3(baseX + CH_S, boxMaxY, baseZ + CH_S)
    );
    container.matrixAutoUpdate = false;
    container.updateMatrix();
    container.updateMatrixWorld(true);

    return container;
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
    const maxR = dist > 0 ? (dist + 0.5) : 0;
    const maxR2 = maxR * maxR;
    const o = [];

    for (let x = -dist; x <= dist; x++) {
        for (let z = -dist; z <= dist; z++) {
            const d2 = x * x + z * z;
            // 円形視界フィルタ（角の不要チャンク約28%を最初から除外）
            if (d2 > maxR2) continue;
            o.push({ dx: x, dz: z, d: d2 });
        }
    }

    // 遠い順に並べることで chunkQueue.pop() が常にプレイヤー至近チャンクから取り出す
    return o.sort((a, b) => b.d - a.d);
};

function updateChunks() {
    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);

    if (lastChunk.x === pCx && lastChunk.z === pCz && offsets) return;

    lastChunk.x = pCx;
    lastChunk.z = pCz;
    offsets ||= precomputeOffsets();

    // 1. 事前距離ソート済みの offsets から未ロードチャンクのみを直接再構築
    chunkQueue.length = 0;
    const cands = offsets;
    for (let i = 0, len = cands.length; i < len; i++) {
        const offset = cands[i];
        const cx = pCx + offset.dx;
        const cz = pCz + offset.dz;
        const hashKey = encodeChunkKey(cx, cz);

        if (!loadedChunks.has(hashKey)) {
            chunkQueue.push(hashKey);
        }
    }

    // 2. ヒステリシス外（CHUNK_VISIBLE_DISTANCE + 1.5 超）のチャンクを予算分散アンロードキューへ登録
    for (const hashKey of loadedChunks.keys()) {
        decodeChunkKey(hashKey, _sharedChunkCoord);
        if (!isChunkWithinUnloadDistance(_sharedChunkCoord.cx, _sharedChunkCoord.cz, pCx, pCz)) {
            if (!chunkUnloadLookup.has(hashKey)) {
                chunkUnloadLookup.add(hashKey);
                chunkUnloadQueue.push(hashKey);
            }
        }
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
    // 16マスのチャンクサイズ固定前提。負の座標も自動で正しく処理されます。
    return Math.floor(val) >> 4;
}

const _refreshedSetTmp = new Set();
const _dirtyLightCoordTmp = { cx: 0, cz: 0 };

function updateAffectedChunks(blockPos, forceImmediate = false, dirtyLightChunks = null) {
    const bx = Math.floor(blockPos.x);
    const bz = Math.floor(blockPos.z);
    const cx = bx >> 4;
    const cz = bz >> 4;
    const lx = bx & 15;
    const lz = bz & 15;

    const centerKey = encodeChunkKey(cx, cz);
    _refreshedSetTmp.clear();

    // フォールバック: dirtyLightChunks が渡されなかった場合のみ中心チャンクのライトマップを保証
    if (dirtyLightChunks === null && !chunkLightCache.has(centerKey)) {
        const centerVoxel = ChunkSaveManager.modifiedChunks.get(centerKey) ||
            ChunkSaveManager.captureBaseChunkData(cx, cz);
        if (centerVoxel) generateChunkLightMap(centerKey, centerVoxel);
    }

    // 1. 中心チャンクは即座にメッシュ再構築（ライトは既にインクリメンタル更新済み）
    refreshChunkAt(cx, cz);
    _refreshedSetTmp.add(centerKey);

    // 2. 厳密に辺・角で接触している隣接チャンクを即時リビルド（面カリング・フェンス接続・境界照明反映）
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;

            const matchX = (dx === 0) || (dx === -1 && lx === 0) || (dx === 1 && lx === 15);
            const matchZ = (dz === 0) || (dz === -1 && lz === 0) || (dz === 1 && lz === 15);
            if (!forceImmediate && !(matchX && matchZ)) continue;

            const nCx = cx + dx;
            const nCz = cz + dz;
            const nKey = encodeChunkKey(nCx, nCz);
            if (!loadedChunks.has(nKey) || _refreshedSetTmp.has(nKey)) continue;

            refreshChunkAt(nCx, nCz);
            _refreshedSetTmp.add(nKey);
        }
    }

    // 3. インクリメンタル光源更新で光が変わった他のチャンク（境界越し光源など）をメッシュのみ再構築
    if (dirtyLightChunks && dirtyLightChunks.size > 0) {
        for (const dKey of dirtyLightChunks) {
            if (_refreshedSetTmp.has(dKey) || !loadedChunks.has(dKey)) continue;
            decodeChunkKey(dKey, _dirtyLightCoordTmp);
            if (forceImmediate) {
                refreshChunkAt(_dirtyLightCoordTmp.cx, _dirtyLightCoordTmp.cz);
            } else {
                requestChunkUpdate(_dirtyLightCoordTmp.cx, _dirtyLightCoordTmp.cz);
            }
            _refreshedSetTmp.add(dKey);
        }
    }
}

const _placeRotatedBox = new THREE.Box3();

function blockIntersectsPlayer(blockPos, playerAABB, tolerance = 0.01, blockId = null, meta = 0) {
    const bx = blockPos.x;
    const by = blockPos.y;
    const bz = blockPos.z;

    if (blockId !== null) {
        const cfg = getBlockConfiguration(blockId);
        if (!cfg || cfg.collision === false) return false;

        const geomType = cfg.geometryType || "cube";
        const boxes = getCollisionBoxes(geomType, meta);
        const tMeta = getTransformMeta(blockId, meta);

        for (let i = 0; i < boxes.length; i++) {
            let box = boxes[i];
            if (tMeta !== 0) {
                applyRotationToCollisionBox(box, tMeta, _placeRotatedBox);
                box = _placeRotatedBox;
            }

            if (
                playerAABB.min.x < bx + box.max.x - tolerance &&
                playerAABB.max.x > bx + box.min.x + tolerance &&
                playerAABB.min.y < by + box.max.y - tolerance &&
                playerAABB.max.y > by + box.min.y + tolerance &&
                playerAABB.min.z < bz + box.max.z - tolerance &&
                playerAABB.max.z > bz + box.min.z + tolerance
            ) {
                return true;
            }
        }
        return false;
    }

    return (
        playerAABB.min.x < bx + 1 - tolerance &&
        playerAABB.max.x > bx + tolerance &&
        playerAABB.min.y < by + 1 - tolerance &&
        playerAABB.max.y > by + tolerance &&
        playerAABB.min.z < bz + 1 - tolerance &&
        playerAABB.max.z > bz + tolerance
    );
}

// ブロック設置・破壊操作用の再利用作業オブジェクト
let lastPlacedKey = null;
const _workVec3_CamDir = new THREE.Vector3();
const _workVec3_Center = new THREE.Vector3();
const _workBox3 = new THREE.Box3();
const _interactBaseVec = new THREE.Vector3();
const _interactTargetVec = new THREE.Vector3();

// 配置・破壊時の隣接更新用再利用オブジェクト（ゼロGC）
const _replaceUpNormal = new THREE.Vector3(0, 1, 0);
const _placementResult = {
    bx: 0,
    by: 0,
    bz: 0,
    replacingBase: false,
    effectiveNormal: null
};

const _NEIGHBOR_6_DX = [1, -1, 0, 0, 0, 0];
const _NEIGHBOR_6_DY = [0, 0, 1, -1, 0, 0];
const _NEIGHBOR_6_DZ = [0, 0, 0, 0, 1, -1];
const _CASCADE_MAX_NODES = 64;
const _cascadeQueueX = new Int32Array(_CASCADE_MAX_NODES);
const _cascadeQueueY = new Int32Array(_CASCADE_MAX_NODES);
const _cascadeQueueZ = new Int32Array(_CASCADE_MAX_NODES);
const _cascadeVisited = new Set();
const _extraUpdateCoords = [];
const _particleCenterTmp = new THREE.Vector3();

function _getBlockIdForPlacement(wx, wy, wz) {
    return getVoxelAtWorld(wx, wy, wz, false);
}

/**
 * クリック対象(base)が置換可能(overwrite: true)なら同座標へ、そうでなければ隣接座標(target)へ配置先を解決する
 */
function resolvePlacementTarget(base, target, rawNormal) {
    const baseX = Math.floor(base.x);
    const baseY = Math.floor(base.y);
    const baseZ = Math.floor(base.z);

    const baseRaw = getVoxelAtWorld(baseX, baseY, baseZ, true);
    const baseId = baseRaw & 0xFFF;
    const baseCfg = getBlockConfiguration(baseId);

    if (baseId !== BLOCK_TYPES.SKY && baseCfg && (baseCfg.overwrite === true || baseCfg.geometryType === "water")) {
        _placementResult.bx = baseX;
        _placementResult.by = baseY;
        _placementResult.bz = baseZ;
        _placementResult.replacingBase = true;
        // クロス形状（45度平面）等の法線で向きが歪まないよう、置換時は上向き法線へ正規化
        _placementResult.effectiveNormal = (baseCfg.geometryType === "cross") ? _replaceUpNormal : rawNormal;
        return _placementResult;
    }

    _placementResult.bx = Math.floor(target.x);
    _placementResult.by = Math.floor(target.y);
    _placementResult.bz = Math.floor(target.z);
    _placementResult.replacingBase = false;
    _placementResult.effectiveNormal = rawNormal;
    return _placementResult;
}

/**
 * ブロック設置・破壊後に自身および周囲6近傍の接続メタデータ同期と支持喪失ブロックの連鎖処理を行う
 * @returns {Array<{x: number, y: number, z: number}>} 追加でチャンク更新が必要になった座標リスト
 */
function updateNeighborBlockStates(originX, originY, originZ) {
    _cascadeVisited.clear();
    _extraUpdateCoords.length = 0;

    let head = 0;
    let tail = 0;

    const enqueue = (x, y, z) => {
        if (y < 0 || y >= CHUNK_HEIGHT || tail >= _CASCADE_MAX_NODES) return;
        const hash = getVoxelHash(x, y, z);
        if (_cascadeVisited.has(hash)) return;
        _cascadeVisited.add(hash);
        _cascadeQueueX[tail] = x;
        _cascadeQueueY[tail] = y;
        _cascadeQueueZ[tail] = z;
        tail++;
    };

    // 変更点自身と周囲6近傍を初期キューに積む
    enqueue(originX, originY, originZ);
    for (let i = 0; i < 6; i++) {
        enqueue(originX + _NEIGHBOR_6_DX[i], originY + _NEIGHBOR_6_DY[i], originZ + _NEIGHBOR_6_DZ[i]);
    }

    while (head < tail) {
        const wx = _cascadeQueueX[head];
        const wy = _cascadeQueueY[head];
        const wz = _cascadeQueueZ[head];
        head++;

        const raw = getVoxelAtWorld(wx, wy, wz, true);
        const id = raw & 0xFFF;
        if (id === BLOCK_TYPES.SKY) continue;

        const meta = (raw >> 12) & 0xF;
        const cfg = getBlockConfiguration(id);
        if (!cfg) continue;

        // 1. 宣言的 autoSyncConnection 対象ブロックの接続メタデータを保存データへ自動同期
        if (cfg.autoSyncConnection) {
            const newMask = getConnectionMask(wx, wy, wz, cfg.geometryType);
            if (newMask !== meta) {
                const cx = wx >> 4;
                const cz = wz >> 4;
                ChunkSaveManager.setBlock(cx, cz, wx & 15, wy, wz & 15, (id & 0xFFF) | ((newMask & 0xF) << 12));
                if (wx !== originX || wy !== originY || wz !== originZ) {
                    _extraUpdateCoords.push({ x: wx, y: wy, z: wz });
                }
            }
            continue;
        }

        // 2. 支持依存ブロック（ハシゴ・カーペット・植物等）が支持を失っていれば破壊して周囲へ連鎖
        if (isSupportDependentBlock(id) && !canPlaceBlockAt(id, meta, wx, wy, wz, _getBlockIdForPlacement)) {
            const cx = wx >> 4;
            const cz = wz >> 4;
            _particleCenterTmp.set(wx + 0.5, wy + 0.5, wz + 0.5);
            createMinecraftBreakParticles(_particleCenterTmp, id, 0.8);
            ChunkSaveManager.setBlock(cx, cz, wx & 15, wy, wz & 15, BLOCK_TYPES.SKY);
            updateLightAtBlockChange(wx, wy, wz, raw, BLOCK_TYPES.SKY, _lightDirtySet);

            if (wx !== originX || wy !== originY || wz !== originZ) {
                _extraUpdateCoords.push({ x: wx, y: wy, z: wz });
            }

            for (let i = 0; i < 6; i++) {
                enqueue(wx + _NEIGHBOR_6_DX[i], wy + _NEIGHBOR_6_DY[i], wz + _NEIGHBOR_6_DZ[i]);
            }
        }
    }

    return _extraUpdateCoords;
}

const _updatedChunkSetTmp = new Set();

function interactWithBlock(action) {
    if (action !== "place" && action !== "destroy") return;

    const EPS = 1e-6;
    const TOP_FACE_THRESHOLD = 0.9;

    // --- 1. 統一ボクセルレイキャスト（黒枠・HUD・操作で100%同一アルゴリズムを使用） ---
    camera.getWorldDirection(_workVec3_CamDir);
    const includeWater = (action === "destroy" && activeBlockType === BLOCK_TYPES.WATER);
    const hit = raycastVoxel(camera.position, _workVec3_CamDir, BLOCK_INTERACT_RANGE, includeWater);
    if (!hit) return;

    // --- 2. ヒット座標および配置先（置換含む）の解決 ---
    const rawNormal = hit.normal;
    _interactBaseVec.set(hit.x, hit.y, hit.z);
    _interactTargetVec.set(hit.x + rawNormal.x, hit.y + rawNormal.y, hit.z + rawNormal.z);

    let bx, by, bz;
    let effectiveNormal = rawNormal;
    let isReplacingBase = false;

    if (action === "place") {
        const resolved = resolvePlacementTarget(_interactBaseVec, _interactTargetVec, rawNormal);
        bx = resolved.bx;
        by = resolved.by;
        bz = resolved.bz;
        effectiveNormal = resolved.effectiveNormal;
        isReplacingBase = resolved.replacingBase;
    } else {
        bx = hit.x;
        by = hit.y;
        bz = hit.z;
    }

    const candidateHash = getVoxelHash(bx, by, bz);
    _workVec3_Center.set(bx + 0.5, by + 0.5, bz + 0.5);

    // ブロックデータ取得
    const cx = bx >> 4, cz = bz >> 4, lx = bx & 15, lz = bz & 15;
    let voxel = ChunkSaveManager.getBlock(cx, cz, lx, by, lz) ?? getVoxelAtWorld(bx, by, bz, true);
    const voxelIdOnly = voxel & 0xFFF;
    const cfg = getBlockConfiguration(voxelIdOnly);

    let playerBox = null;
    try { playerBox = getPlayerAABB(); } catch (e) { }

    // ====================
    // 破壊ロジック
    // ====================
    if (action === "destroy") {
        if (voxelIdOnly === BLOCK_TYPES.SKY) return;
        const canBreakWater = includeWater && cfg?.geometryType === "water";
        if (cfg?.targetblock === false && !canBreakWater) return;

        createMinecraftBreakParticles(_workVec3_Center, voxelIdOnly, 1.0);

        _lightDirtySet.clear();
        ChunkSaveManager.setBlock(cx, cz, lx, by, lz, BLOCK_TYPES.SKY);
        updateLightAtBlockChange(bx, by, bz, voxel, BLOCK_TYPES.SKY, _lightDirtySet);
        if (lastPlacedKey === candidateHash) lastPlacedKey = null;
    }
    // ====================
    // 設置ロジック（クリックした対象ブロック hit 本体の onInteract を最優先評価）
    // ====================
    else if (action === "place") {
        // 隣の配置先マス(cfg)ではなく、実際に視線が当たっている hit.blockId 本体の onInteract を評価する
        const hitCfg = getBlockConfiguration(hit.blockId);
        if (!sneakActive && hitCfg && typeof hitCfg.onInteract === "function") {
            const hCx = hit.x >> 4, hCz = hit.z >> 4;
            const hitRaw = ChunkSaveManager.getBlock(hCx, hCz, hit.x & 15, hit.y, hit.z & 15)
                ?? getVoxelAtWorld(hit.x, hit.y, hit.z, true);
            const hitId = hitRaw & 0xFFF;
            const currentState = (hitRaw >> 12) & 0xF;

            const nextState = hitCfg.onInteract({
                x: hit.x,
                y: hit.y,
                z: hit.z,
                blockId: hitId,
                state: currentState,
                normal: rawNormal,
                point: hit.point,
                getBlock: _getBlockIdForPlacement,
                scheduleTick: (delay, type, priority = 0, payload = 0) =>
                    TickScheduler.schedule(hit.x, hit.y, hit.z, delay, type, priority, payload)
            });

            if (typeof nextState === "number" && nextState >= 0) {
                const updatedRaw = (hitId & 0xFFF) | ((nextState & 0xF) << 12);
                _lightDirtySet.clear();
                ChunkSaveManager.setBlock(hCx, hCz, hit.x & 15, hit.y, hit.z & 15, updatedRaw);
                updateLightAtBlockChange(hit.x, hit.y, hit.z, hitRaw, updatedRaw, _lightDirtySet);
                updateNeighborBlockStates(hit.x, hit.y, hit.z);
                RedstoneEngine.onBlockChanged(hit.x, hit.y, hit.z);
                updateAffectedChunks({ x: hit.x, y: hit.y, z: hit.z }, false, _lightDirtySet);
                updateTargetBlockDisplay(true);
                // 1クリックで綺麗に1段階だけ切り替わるよう長押し連打を停止
                stopInteraction("right");
                stopInteraction("touch");
                return;
            }
        }

        const newBlockCfg = getBlockConfiguration(activeBlockType);
        if (!newBlockCfg || activeBlockType === BLOCK_TYPES.SKY || by < 0 || by >= CHUNK_HEIGHT) return;

        // 同一座標への連続長押し重複設置ガード
        if (candidateHash === lastPlacedKey) return;

        // 置換・上書き可否判定（空気・水・overwrite属性ブロックのみ許可）
        if (voxelIdOnly !== BLOCK_TYPES.SKY) {
            if (!(cfg?.geometryType === "water" || cfg?.overwrite === true)) return;
        }

        // 1) 配置メタデータ（向き・反転・接続マスク）を事前確定（hit.point で正確な上下判定）
        let meta = calculatePlacementMeta(activeBlockType, _workVec3_CamDir, effectiveNormal, hit.point);
        if (meta < 0) return;

        if (newBlockCfg.autoSyncConnection) {
            meta = getConnectionMask(bx, by, bz, newBlockCfg.geometryType);
        }

        // 2) 支持条件（壁面・土壌・下面）チェック
        if (!canPlaceBlockAt(activeBlockType, meta, bx, by, bz, _getBlockIdForPlacement)) return;

        // 3) 実形状＋メタデータ適用済み衝突ボックスによるプレイヤー干渉判定
        if (newBlockCfg.collision !== false && playerBox) {
            if (blockIntersectsPlayer({ x: bx, y: by, z: bz }, playerBox, 0.001, activeBlockType, meta)) return;
        }

        // 4) スニーク時の足元設置制限
        if (playerBox && sneakActive && !isReplacingBase) {
            const isTopAttempt = (effectiveNormal.y > TOP_FACE_THRESHOLD) || (rawNormal.y > 0);
            if (isTopAttempt) {
                _workBox3.min.set(bx + EPS, by - 1 + EPS, bz + EPS);
                _workBox3.max.set(bx + 1 - EPS, by - EPS, bz + 1 - EPS);
                if (playerBox.intersectsBox(_workBox3)) return;
            }
        }

        // 5) ブロック確定書き込み ＋ 2フェーズ インクリメンタル光源更新
        const blockDataToSave = (activeBlockType & 0xFFF) | ((meta & 0xF) << 12);
        _lightDirtySet.clear();
        ChunkSaveManager.setBlock(cx, cz, lx, by, lz, blockDataToSave);
        updateLightAtBlockChange(bx, by, bz, voxel, blockDataToSave, _lightDirtySet);
        lastPlacedKey = candidateHash;
    }

    // --- 5. 予約Tickキャンセル ＆ 隣接ブロック状態同期 ＆ レッドストーン信号ネットワーク更新 ---
    TickScheduler.cancelAt(bx, by, bz);
    const extraCoords = updateNeighborBlockStates(bx, by, bz);
    RedstoneEngine.onBlockChanged(bx, by, bz);

    // --- 6. チャンク・UI更新（光が変わった全チャンクを含め重複なしで再構築） ---
    _updatedChunkSetTmp.clear();
    _updatedChunkSetTmp.add(encodeChunkKey(cx, cz));
    updateAffectedChunks({ x: bx, y: by, z: bz }, false, _lightDirtySet);

    for (let i = 0; i < extraCoords.length; i++) {
        const pos = extraCoords[i];
        TickScheduler.cancelAt(pos.x, pos.y, pos.z);
        RedstoneEngine.onBlockChanged(pos.x, pos.y, pos.z);
        const eKey = encodeChunkKey(pos.x >> 4, pos.z >> 4);
        if (!_updatedChunkSetTmp.has(eKey)) {
            _updatedChunkSetTmp.add(eKey);
            updateAffectedChunks(pos, false, _lightDirtySet);
        }
    }

    updateTargetBlockDisplay(true);
}

// ----------------------------------------
// 地面に着いたら連続設置ガードをリセット
// ----------------------------------------
function resetLastPlacedIfOnGround() {
    if (player && player.onGround) {
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
const create2DPreview = ({ id, textures = {}, previewTexture = null, previewOptions = {} }, size) => {
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

    const src = previewTexture || textures.all || textures.side || textures.top;

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

    // 2. テクスチャがある場合（非同期読み込み＋BlockStateティント色乗算対応）
    loadImage(src).then(img => {
        const { x = 0, y = 0 } = previewOptions.offset || {};
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, x, y, size, size);

        const cfg = getBlockConfiguration(id);
        const pMeta = (cfg && cfg.previewState !== null && cfg.previewState !== undefined) ? cfg.previewState : (cfg?.defaultState ?? 0);
        const variant = cfg && cfg._compiledVariants ? cfg._compiledVariants[pMeta & 15] : null;
        const tintHex = (variant && variant.defaultColor !== undefined) ? variant.defaultColor : (cfg?.defaultColor ?? 0xffffff);

        if (tintHex !== 0xffffff) {
            const tr = (tintHex >> 16) & 255;
            const tg = (tintHex >> 8) & 255;
            const tb = tintHex & 255;
            const imgData = ctx.getImageData(0, 0, size, size);
            const d = imgData.data;
            for (let p = 0; p < d.length; p += 4) {
                if (d[p + 3] === 0) continue;
                d[p] = (d[p] * tr) / 255;
                d[p + 1] = (d[p + 1] * tg) / 255;
                d[p + 2] = (d[p + 2] * tb) / 255;
            }
            ctx.putImageData(imgData, 0, 0);
        }

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

const sharedRenderer = new THREE.WebGLRenderer({
    canvas: shared3DCanvas,
    alpha: true,
    antialias: false,
    stencil: false,
    powerPreference: "low-power"
});
sharedRenderer.debug.checkShaderErrors = false;
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

// 3Dプレビュー計算用再利用オブジェクト（GC削減・共有リソース保護）
const _previewBox = new THREE.Box3();
const _previewCenter = new THREE.Vector3();
const _previewOrigin = new THREE.Vector3(0, 0, 0);

// 3Dプレビュー作成（共有ジオメトリ・共有テクスチャを絶対に dispose しない安全版）
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

    const cfg = getBlockConfiguration(id);
    if (!cfg) return previewCanvas;

    const sharedGeom = getBlockGeometry(cfg.geometryType, cfg, 0);
    const sharedMats = getBlockMaterials(id);
    if (!sharedGeom || !sharedMats) {
        console.error(`プレビュー素材取得失敗 id: ${id}`);
        return previewCanvas;
    }

    const originalMaterials = Array.isArray(sharedMats) ? sharedMats : [sharedMats];
    const previewMaterials = originalMaterials.map(m => new THREE.MeshBasicMaterial({
        map: m.map || null,
        color: m.color ? m.color.clone() : 0xffffff,
        side: THREE.FrontSide,
        transparent: m.transparent || false,
        opacity: m.opacity !== undefined ? m.opacity : 1,
        alphaTest: m.alphaTest || 0
    }));

    const mesh = new THREE.Mesh(
        sharedGeom,
        Array.isArray(sharedMats) ? previewMaterials : previewMaterials[0]
    );
    mesh.position.copy(_previewOrigin);

    try {
        const loadPromises = previewMaterials
            .map(m => m.map)
            .filter(map => map && !(map.image && map.image.complete))
            .map(map => new Promise(resolve => {
                let waited = 0;
                const checkLoaded = () => {
                    if ((map.image && map.image.complete) || waited > 3000) resolve();
                    else {
                        waited += 10;
                        setTimeout(checkLoaded, 10);
                    }
                };
                checkLoaded();
            }));
        await Promise.all(loadPromises);

        for (let i = 0; i < previewMaterials.length; i++) {
            const map = previewMaterials[i].map;
            if (map) {
                map.magFilter = THREE.NearestFilter;
                map.minFilter = THREE.NearestMipmapNearestFilter;
                map.generateMipmaps = true;
                map.needsUpdate = true;
            }
        }

        light.position.set(10, 10, 10);
        light.intensity = 0.8;
        sharedCamera.position.set(2, 2, 2);
        sharedCamera.lookAt(0, 0, 0);
        sharedCamera.updateProjectionMatrix();

        sharedScene.add(mesh);

        _previewBox.setFromObject(mesh);
        _previewBox.getCenter(_previewCenter);
        mesh.position.sub(_previewCenter);

        if (previewOptions.offset) {
            mesh.position.x += previewOptions.offset.x || 0;
            mesh.position.y += previewOptions.offset.y || 0;
            mesh.position.z += previewOptions.offset.z || 0;
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
            _previewBox.setFromObject(mesh);
            _previewBox.getCenter(_previewCenter);
            mesh.position.sub(_previewCenter);
        }

        sharedRenderer.render(sharedScene, sharedCamera);

        const cacheCanvas = createCanvas(size);
        cacheCanvas.getContext("2d").drawImage(shared3DCanvas, 0, 0, size, size);
        previewCache.set(hashKey, cacheCanvas);

        const resultCanvas = createCanvas(size);
        resultCanvas.getContext("2d").drawImage(cacheCanvas, 0, 0);
        return resultCanvas;
    } finally {
        // 描画直後にシーンから外し、一時生成した previewMaterials のみ確実に破棄（共有ジオメトリ・共有テクスチャは保護）
        sharedScene.remove(mesh);
        mesh.geometry = null;
        mesh.material = null;
        for (let i = 0; i < previewMaterials.length; i++) {
            previewMaterials[i].dispose();
        }
    }
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

// --- ホットバー初期化（DOM要素キャッシュ配列＋単一イベント委譲） ---
const hotbarEl = document.getElementById("hotbar");
const _hotbarSlotEls = new Array(9);
hotbarEl.innerHTML = "";

for (let i = 0; i < 9; i++) {
    const item = document.createElement("div");
    item.className = "hotbar-item";
    if (i === 0) item.classList.add("active");
    item.dataset.blocktype = "";
    item.dataset.slotIndex = String(i);
    hotbarEl.appendChild(item);
    _hotbarSlotEls[i] = item;
}

hotbarEl.addEventListener("click", (e) => {
    const slotEl = e.target.closest(".hotbar-item");
    if (!slotEl) return;
    const idx = Number(slotEl.dataset.slotIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx < 9) {
        selectedHotbarIndex = idx;
        updateHotbarSelection();
    }
});

// --- ホットバー選択更新（querySelectorAll ゼロ） ---
function updateHotbarSelection() {
    for (let i = 0; i < 9; i++) {
        const el = _hotbarSlotEls[i];
        if (!el) continue;
        if (i === selectedHotbarIndex) {
            el.classList.add("active");
            activeBlockType = Number(el.dataset.blocktype || 0);
        } else {
            el.classList.remove("active");
        }
    }
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
    // 2. レンダラーの描画サイズを更新（DPR上限を初期化時と統一）
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO));
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
// ======================================================
// 【統一ゼロGCレイキャストエンジン】NaN安全 3D DDA ＋ 解析的 Slab法 Ray-AABB交差
// ======================================================
const _rayDirTmp = new THREE.Vector3();
const _rayRotatedBoxTmp = new THREE.Box3();
const _sharedRaycastHit = {
    hit: false,
    x: 0,
    y: 0,
    z: 0,
    normal: new THREE.Vector3(),
    point: new THREE.Vector3(),
    distance: 0,
    rawVoxel: 0,
    blockId: 0,
    metadata: 0
};

/**
 * ボクセル内の選択ボックス群（1〜5個）とレイの最近接交点を解析的Slab法で求める（ゼロGC）
 */
function rayIntersectVoxelBoxes(ox, oy, oz, dx, dy, dz, bx, by, bz, blockId, metadata, maxDistance, stepNx, stepNy, stepNz, outResult) {
    const boxes = getSelectionBoxesReadOnly(blockId, metadata);
    const len = boxes.length;
    const cfg = _blockConfigFastArray[blockId];
    const gType = cfg ? cfg.geometryType : "cube";
    const tMeta = getTransformMeta(blockId, metadata);

    const EPS_DIR = 1e-8;
    let bestT = maxDistance + 1.0;
    let bestNx = 0, bestNy = 0, bestNz = 0;
    let found = false;

    for (let i = 0; i < len; i++) {
        let box = boxes[i];
        if (tMeta !== 0) {
            applyRotationToCollisionBox(box, tMeta, _rayRotatedBoxTmp);
            box = _rayRotatedBoxTmp;
        }

        const minX = bx + box.min.x, maxX = bx + box.max.x;
        const minY = by + box.min.y, maxY = by + box.max.y;
        const minZ = bz + box.min.z, maxZ = bz + box.max.z;

        let tMinX, tMaxX, nxX;
        if (dx > EPS_DIR || dx < -EPS_DIR) {
            const invX = 1.0 / dx;
            const t1 = (minX - ox) * invX;
            const t2 = (maxX - ox) * invX;
            if (t1 <= t2) { tMinX = t1; tMaxX = t2; nxX = -1; }
            else { tMinX = t2; tMaxX = t1; nxX = 1; }
        } else {
            if (ox < minX || ox > maxX) continue;
            tMinX = -Infinity; tMaxX = Infinity; nxX = 0;
        }

        let tMinY, tMaxY, nyY;
        if (dy > EPS_DIR || dy < -EPS_DIR) {
            const invY = 1.0 / dy;
            const t1 = (minY - oy) * invY;
            const t2 = (maxY - oy) * invY;
            if (t1 <= t2) { tMinY = t1; tMaxY = t2; nyY = -1; }
            else { tMinY = t2; tMaxY = t1; nyY = 1; }
        } else {
            if (oy < minY || oy > maxY) continue;
            tMinY = -Infinity; tMaxY = Infinity; nyY = 0;
        }

        let tMinZ, tMaxZ, nzZ;
        if (dz > EPS_DIR || dz < -EPS_DIR) {
            const invZ = 1.0 / dz;
            const t1 = (minZ - oz) * invZ;
            const t2 = (maxZ - oz) * invZ;
            if (t1 <= t2) { tMinZ = t1; tMaxZ = t2; nzZ = -1; }
            else { tMinZ = t2; tMaxZ = t1; nzZ = 1; }
        } else {
            if (oz < minZ || oz > maxZ) continue;
            tMinZ = -Infinity; tMaxZ = Infinity; nzZ = 0;
        }

        // 3軸の共通区間 [tEnter, tExit]
        let tEnter = tMinX;
        let hitNx = nxX, hitNy = 0, hitNz = 0;
        if (tMinY > tEnter) {
            tEnter = tMinY;
            hitNx = 0; hitNy = nyY; hitNz = 0;
        }
        if (tMinZ > tEnter) {
            tEnter = tMinZ;
            hitNx = 0; hitNy = 0; hitNz = nzZ;
        }

        const tExit = tMaxX < tMaxY ? (tMaxX < tMaxZ ? tMaxX : tMaxZ) : (tMaxY < tMaxZ ? tMaxY : tMaxZ);
        if (tExit < 0.0 || tEnter > tExit || tEnter > maxDistance) continue;

        // 視点がボックス内部から開始している場合は t = 0 として扱う
        let tHit = tEnter;
        if (tHit < 0.0) {
            tHit = 0.0;
            if (stepNx !== 0 || stepNy !== 0 || stepNz !== 0) {
                hitNx = stepNx; hitNy = stepNy; hitNz = stepNz;
            } else {
                const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
                if (ax >= ay && ax >= az) { hitNx = dx > 0 ? -1 : 1; hitNy = 0; hitNz = 0; }
                else if (ay >= ax && ay >= az) { hitNx = 0; hitNy = dy > 0 ? -1 : 1; hitNz = 0; }
                else { hitNx = 0; hitNy = 0; hitNz = dz > 0 ? -1 : 1; }
            }
        }

        if (tHit < bestT) {
            bestT = tHit;
            bestNx = hitNx;
            bestNy = hitNy;
            bestNz = hitNz;
            found = true;
        }
    }

    if (!found || bestT > maxDistance) return false;

    outResult.distance = bestT;
    outResult.normal.set(bestNx, bestNy, bestNz);
    outResult.point.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    return true;
}

/**
 * 3D DDA（Amanatides & Woo, NaN安全）＋実形状Slab法による統一ボクセルレイキャスト
 * ※戻り値は再利用オブジェクトのため、呼び出し元で参照を長期保持しないこと
 */
function raycastVoxel(origin, dir, maxDistance, includeWater = false, outResult = _sharedRaycastHit) {
    outResult.hit = false;

    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;
    if ((dx * dx + dy * dy + dz * dz) < 1e-12) return null;

    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);

    const EPS_DIR = 1e-8;
    let stepX = 0, tDeltaX = Infinity, tMaxX = Infinity;
    if (dx > EPS_DIR) {
        stepX = 1;
        tDeltaX = 1.0 / dx;
        tMaxX = (x + 1.0 - ox) * tDeltaX;
    } else if (dx < -EPS_DIR) {
        stepX = -1;
        tDeltaX = -1.0 / dx;
        tMaxX = (ox - x) * tDeltaX;
    }

    let stepY = 0, tDeltaY = Infinity, tMaxY = Infinity;
    if (dy > EPS_DIR) {
        stepY = 1;
        tDeltaY = 1.0 / dy;
        tMaxY = (y + 1.0 - oy) * tDeltaY;
    } else if (dy < -EPS_DIR) {
        stepY = -1;
        tDeltaY = -1.0 / dy;
        tMaxY = (oy - y) * tDeltaY;
    }

    let stepZ = 0, tDeltaZ = Infinity, tMaxZ = Infinity;
    if (dz > EPS_DIR) {
        stepZ = 1;
        tDeltaZ = 1.0 / dz;
        tMaxZ = (z + 1.0 - oz) * tDeltaZ;
    } else if (dz < -EPS_DIR) {
        stepZ = -1;
        tDeltaZ = -1.0 / dz;
        tMaxZ = (oz - z) * tDeltaZ;
    }

    let tCurrent = 0.0;
    let stepNx = 0, stepNy = 0, stepNz = 0;
    const maxSteps = Math.ceil(maxDistance * 3) + 4;

    for (let step = 0; step < maxSteps; step++) {
        if (tCurrent > maxDistance) break;

        // ステップ0（カメラ現在セル）を含めてボクセル検査
        if (y >= 0 && y < CHUNK_HEIGHT) {
            const rawVoxel = getVoxelAtWorld(x, y, z, true);
            const blockId = rawVoxel & 0xFFF;

            if (blockId !== BLOCK_TYPES.SKY) {
                const conf = _blockConfigFastArray[blockId];
                const isWaterTarget = includeWater && conf && conf.geometryType === "water";

                if (conf && (conf.targetblock !== false || isWaterTarget)) {
                    const meta = (rawVoxel >> 12) & 0xF;
                    if (rayIntersectVoxelBoxes(
                        ox, oy, oz, dx, dy, dz,
                        x, y, z, blockId, meta,
                        maxDistance, stepNx, stepNy, stepNz, outResult
                    )) {
                        outResult.hit = true;
                        outResult.x = x;
                        outResult.y = y;
                        outResult.z = z;
                        outResult.rawVoxel = rawVoxel;
                        outResult.blockId = blockId;
                        outResult.metadata = meta;
                        return outResult;
                    }
                }
            }
        }

        // 次のボクセル境界へ歩進
        if (tMaxX < tMaxY) {
            if (tMaxX < tMaxZ) {
                tCurrent = tMaxX;
                x += stepX;
                tMaxX += tDeltaX;
                stepNx = -stepX; stepNy = 0; stepNz = 0;
            } else {
                tCurrent = tMaxZ;
                z += stepZ;
                tMaxZ += tDeltaZ;
                stepNx = 0; stepNy = 0; stepNz = -stepZ;
            }
        } else {
            if (tMaxY < tMaxZ) {
                tCurrent = tMaxY;
                y += stepY;
                tMaxY += tDeltaY;
                stepNx = 0; stepNy = -stepY; stepNz = 0;
            } else {
                tCurrent = tMaxZ;
                z += stepZ;
                tMaxZ += tDeltaZ;
                stepNx = 0; stepNy = 0; stepNz = -stepZ;
            }
        }
    }

    return null;
}

function getTargetBlockByDDA(maxDistance, includeWater = false) {
    camera.getWorldDirection(_rayDirTmp);
    return raycastVoxel(camera.position, _rayDirTmp, maxDistance, includeWater);
}

// 選択枠の共有マテリアル・作業用ベクトル・Dirty Checkキャッシュ（リーク＆GC防止）
const _sharedSelectionLineMaterial = new THREE.LineBasicMaterial({
    color: 0x000000,
    linewidth: 1,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
});
const _selBoxSize = new THREE.Vector3();
const _selBoxCenter = new THREE.Vector3();
let _lastSelX = 0x7FFFFFFF;
let _lastSelY = 0x7FFFFFFF;
let _lastSelZ = 0x7FFFFFFF;
let _lastSelRawVoxel = -1;

function clearSelectionLines() {
    for (let i = 0; i < selectionGroup.children.length; i++) {
        const child = selectionGroup.children[i];
        if (child.geometry) child.geometry.dispose();
    }
    selectionGroup.clear();
    selectionGroup.visible = false;
    _lastSelRawVoxel = -1;
}

/* ======================================================
    【最新・完全版】ブロック選択枠＆HUD情報の統一更新
   ====================================================== */
function updateBlockSelection(precomputedHit = undefined, forceRebuild = false) {
    const hit = (precomputedHit !== undefined) ? precomputedHit : getTargetBlockByDDA(BLOCK_INTERACT_RANGE);
    if (!hit) {
        if (selectionGroup.visible) clearSelectionLines();
        return;
    }

    const x = hit.x, y = hit.y, z = hit.z;
    const rawVoxel = hit.rawVoxel;
    const blockId = hit.blockId;
    const metadata = hit.metadata;

    if (blockId === BLOCK_TYPES.SKY) {
        if (selectionGroup.visible) clearSelectionLines();
        return;
    }

    // Dirty Check: 前回と完全に同じ座標・同じブロック状態ならジオメトリ再構築をスキップ
    if (
        !forceRebuild &&
        selectionGroup.visible &&
        x === _lastSelX && y === _lastSelY && z === _lastSelZ &&
        rawVoxel === _lastSelRawVoxel
    ) {
        return;
    }

    // 1. 古い枠線ジオメトリのみ破棄（マテリアルは共有のため破棄しない）
    for (let i = 0; i < selectionGroup.children.length; i++) {
        const child = selectionGroup.children[i];
        if (child.geometry) child.geometry.dispose();
    }
    selectionGroup.clear();

    const rotatedBox = getPooledBox();
    const tMeta = getTransformMeta(blockId, metadata);
    const baseBoxes = getSelectionBoxesReadOnly(blockId, metadata);

    // 2. Raycastと100%同一のボックス群から枠線を生成
    for (let i = 0; i < baseBoxes.length; i++) {
        if (tMeta === 0) {
            rotatedBox.copy(baseBoxes[i]);
        } else {
            applyRotationToCollisionBox(baseBoxes[i], tMeta, rotatedBox);
        }
        createSelectionLine(x, y, z, rotatedBox);
    }

    releasePooledBox(rotatedBox);
    selectionGroup.visible = true;
    _lastSelX = x;
    _lastSelY = y;
    _lastSelZ = z;
    _lastSelRawVoxel = rawVoxel;
}

/**
 * 枠線（LineSegments）を生成してGroupに追加するヘルパー（共有マテリアル＆共有ベクトル使用）
 */
function createSelectionLine(worldX, worldY, worldZ, box3) {
    box3.getSize(_selBoxSize);
    box3.getCenter(_selBoxCenter);

    const geom = new THREE.BoxGeometry(_selBoxSize.x + 0.001, _selBoxSize.y + 0.001, _selBoxSize.z + 0.001);
    const edges = new THREE.EdgesGeometry(geom);
    geom.dispose();

    const line = new THREE.LineSegments(edges, _sharedSelectionLineMaterial);
    line.position.set(worldX + _selBoxCenter.x, worldY + _selBoxCenter.y, worldZ + _selBoxCenter.z);
    selectionGroup.add(line);
}

let currentTargetBlockText = "None";
function updateBlockInfo(precomputedHit = undefined) {
    const hit = (precomputedHit !== undefined) ? precomputedHit : getTargetBlockByDDA(BLOCK_INTERACT_RANGE);

    if (!hit || hit.blockId === BLOCK_TYPES.SKY) {
        currentTargetBlockText = "None";
        return;
    }

    const blockId = hit.blockId;
    const blockName = BLOCK_NAMES[blockId] || "Unknown";
    const config = _blockConfigFastArray[blockId];
    const stateStr = formatBlockStateString(blockId, hit.metadata);

    currentTargetBlockText = `${blockName}${stateStr} (ID: ${blockId}) [${hit.x}, ${hit.y}, ${hit.z}]` +
        (config ? `<br>Type: ${config.geometryType}` : "");
}

/**
 * 1回のレイキャスト結果で黒枠（Selection）とデバッグ表示（BlockInfo）を同時更新する
 */
function updateTargetBlockDisplay(forceRebuild = false) {
    const hit = getTargetBlockByDDA(BLOCK_INTERACT_RANGE);
    updateBlockSelection(hit, forceRebuild);
    updateBlockInfo(hit);
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

    const hLx = hX & 15;
    const hLz = hZ & 15;

    const rawValue = ChunkSaveManager.getBlock(cx, cz, hLx, hY, hLz)
        ?? getVoxelAtWorld(hX, hY, hZ, true);

    const blockId = rawValue & 0xFFF;
    const meta = (rawValue >> 12) & 0xF;
    const blockName = BLOCK_NAMES[blockId] || "Unknown";
    const stateStr = formatBlockStateString(blockId, meta);

    if (elem) {
        const newText = `Head Block: ${blockName}${stateStr} (ID: ${blockId})`;
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

/* ======================================================
   【固定タイムステップ Tickエンジン】（60Hz物理 ＋ 20TPSワールド ＋ 予約Tick ＋ ランダムTick）
   ====================================================== */
const PHYSICS_TPS = 60;
const PHYSICS_FIXED_DT = 1.0 / PHYSICS_TPS;
const MAX_PHYSICS_STEPS_PER_FRAME = 5;

const WORLD_TPS = 20;
const WORLD_TICK_DT = 1.0 / WORLD_TPS;
const MAX_WORLD_TICKS_PER_FRAME = 3;
const SIMULATION_DISTANCE = 4; // ランダムTick対象距離（チャンク単位）

let physicsAccumulator = 0;
let physicsStepCounter = 0;
let worldTickAccumulator = 0;
let worldTickCount = 0;
let ticksInSecond = 0;
let measuredTps = WORLD_TPS;

// タイマー管理用
let chunkUpdateFrameTimer = 0;
let chunkCacheEvictTimer = 0;
let blockInfoTimer = 0;

// 最適化：再利用するベクトル・フラスタム群（ゼロGC）
const _camOffset = new THREE.Vector3();
const _tempVec3 = new THREE.Vector3();
const _interpPlayerPos = new THREE.Vector3();
const _chunkFrustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _tickLightDirtySet = new Set();
const _tickDirtyCoordTmp = { cx: 0, cz: 0 };

/**
 * ワールド座標 (wx, wy, wz) を 48bit 安全整数キーへパック（±524,288ブロックまで衝突ゼロ・ゼロGC）
 */
function encodeWorldBlockKey(wx, wy, wz) {
    const ox = (wx + 524288) & 0xFFFFF;
    const oz = (wz + 524288) & 0xFFFFF;
    const oy = wy & 0xFF;
    return ox * 268435456 + (((oz << 8) | oy) >>> 0);
}

/**
 * 【予約ブロックTickスケジューラ】（Step17レッドストーン・液体・落下ブロック共通基盤）
 */
const TickScheduler = (() => {
    const MAX_TICKS_PER_STEP = 1024;
    const buckets = new Map();     // Map<targetTick, Array<Task>>
    const activeByCoord = new Map(); // Map<coordKey, Array<Task>>（高速キャンセル＆重複抑制用）
    const handlers = new Map();    // Map<type, Function(task, currentTick)>
    const taskPool = [];
    let pendingCount = 0;

    function allocTask(x, y, z, targetTick, type, priority, payload, coordKey) {
        if (taskPool.length > 0) {
            const t = taskPool.pop();
            t.x = x; t.y = y; t.z = z;
            t.targetTick = targetTick;
            t.type = type;
            t.priority = priority;
            t.payload = payload;
            t.coordKey = coordKey;
            t.cancelled = false;
            return t;
        }
        return { x, y, z, targetTick, type, priority, payload, coordKey, cancelled: false };
    }

    function releaseTask(t) {
        t.type = null;
        t.cancelled = true;
        if (taskPool.length < 2048) taskPool.push(t);
    }

    return {
        get pendingCount() {
            return pendingCount;
        },

        registerHandler(type, fn) {
            handlers.set(type, fn);
        },

        schedule(wx, wy, wz, delayTicks, type, priority = 0, payload = 0) {
            const x = wx | 0, y = wy | 0, z = wz | 0;
            if (y < 0 || y >= CHUNK_HEIGHT) return;

            const delay = delayTicks > 1 ? (delayTicks | 0) : 1;
            const targetTick = worldTickCount + delay;
            const coordKey = encodeWorldBlockKey(x, y, z);

            // 同一座標・同一種別・同一実行Tickの重複スケジュールを抑止
            let coordList = activeByCoord.get(coordKey);
            if (coordList) {
                for (let i = 0; i < coordList.length; i++) {
                    const existing = coordList[i];
                    if (!existing.cancelled && existing.type === type && existing.targetTick === targetTick) {
                        return;
                    }
                }
            } else {
                coordList = [];
                activeByCoord.set(coordKey, coordList);
            }

            const task = allocTask(x, y, z, targetTick, type, priority, payload, coordKey);
            coordList.push(task);

            let bucket = buckets.get(targetTick);
            if (!bucket) {
                bucket = [];
                buckets.set(targetTick, bucket);
            }
            bucket.push(task);
            pendingCount++;
        },

        cancelAt(wx, wy, wz, type = null) {
            const coordKey = encodeWorldBlockKey(wx | 0, wy | 0, wz | 0);
            const coordList = activeByCoord.get(coordKey);
            if (!coordList) return;

            for (let i = coordList.length - 1; i >= 0; i--) {
                const task = coordList[i];
                if (type === null || task.type === type) {
                    if (!task.cancelled) {
                        task.cancelled = true;
                        if (pendingCount > 0) pendingCount--;
                    }
                    coordList.splice(i, 1);
                }
            }
            if (coordList.length === 0) activeByCoord.delete(coordKey);
        },

        processTick(currentTick) {
            const bucket = buckets.get(currentTick);
            if (!bucket) return;
            buckets.delete(currentTick);

            // 優先度順（数値が小さいほど高優先：Minecraft Java Edition TickPriority 準拠）
            if (bucket.length > 1) {
                bucket.sort((a, b) => a.priority - b.priority);
            }

            const limit = bucket.length < MAX_TICKS_PER_STEP ? bucket.length : MAX_TICKS_PER_STEP;
            for (let i = 0; i < limit; i++) {
                const task = bucket[i];
                if (!task.cancelled) {
                    if (pendingCount > 0) pendingCount--;
                    const coordList = activeByCoord.get(task.coordKey);
                    if (coordList) {
                        const idx = coordList.indexOf(task);
                        if (idx !== -1) coordList.splice(idx, 1);
                        if (coordList.length === 0) activeByCoord.delete(task.coordKey);
                    }
                    const handler = handlers.get(task.type);
                    if (handler) handler(task, currentTick);
                }
                releaseTask(task);
            }

            // 上限超過分は次Tickへ繰り越し（フレームスパイク防止）
            if (bucket.length > limit) {
                const nextTick = currentTick + 1;
                let nextBucket = buckets.get(nextTick);
                if (!nextBucket) {
                    nextBucket = [];
                    buckets.set(nextTick, nextBucket);
                }
                for (let i = limit; i < bucket.length; i++) {
                    const overflowTask = bucket[i];
                    if (!overflowTask.cancelled) {
                        overflowTask.targetTick = nextTick;
                        nextBucket.push(overflowTask);
                    } else {
                        releaseTask(overflowTask);
                    }
                }
            }
        },

        clear() {
            for (const bucket of buckets.values()) {
                for (let i = 0; i < bucket.length; i++) releaseTask(bucket[i]);
            }
            buckets.clear();
            activeByCoord.clear();
            pendingCount = 0;
        }
    };
})();







/* ======================================================
   【レッドストーン信号伝播エンジン】(Minecraft Java Edition 強/弱動力モデル準拠)
   - 2フェーズ ワイヤーネットワーク再解決によりリング配線のゴースト電力を完全防止
   - トーチ(NOTゲート: 2ticks) / リピーター(ダイオード増幅: 2 or 4ticks) を TickScheduler で遅延駆動
   ====================================================== */
const REPEATER_OUT_DX = new Int8Array([1, 0, -1, 0]);
const REPEATER_OUT_DZ = new Int8Array([0, -1, 0, 1]);
const RS_HORIZ_DX = new Int8Array([1, -1, 0, 0]);
const RS_HORIZ_DZ = new Int8Array([0, 0, 1, -1]);

const RedstoneEngine = (() => {
    const MAX_WIRE_NODES = 1024;
    const _wireX = new Int32Array(MAX_WIRE_NODES);
    const _wireY = new Int32Array(MAX_WIRE_NODES);
    const _wireZ = new Int32Array(MAX_WIRE_NODES);
    const _wireOldPower = new Uint8Array(MAX_WIRE_NODES);
    const _wireNewPower = new Uint8Array(MAX_WIRE_NODES);
    const _wireVisited = new Map();

    const _bfsQueue = new Int32Array(MAX_WIRE_NODES * 4);
    const _deviceCoordsX = new Int32Array(512);
    const _deviceCoordsY = new Int32Array(512);
    const _deviceCoordsZ = new Int32Array(512);
    const _deviceVisited = new Set();

    function getRaw(wx, wy, wz) {
        if (wy < 0 || wy >= CHUNK_HEIGHT) return 0;
        const r = _getWorldRawLoaded(wx, wy, wz);
        return r < 0 ? 0 : r;
    }

    // ブロック定義の redstoneConductive に基づく「通電する / しない」統一判定
    function isRedstoneConductor(wx, wy, wz) {
        return _isRedstoneConductive[getRaw(wx, wy, wz) & 0xFFF] === 1;
    }

    // 段差ワイヤーの物理遮断用（不透明ブロック全般）
    function isWireBlockingOpaque(wx, wy, wz) {
        return _isOpaqueBlock[getRaw(wx, wy, wz) & 0xFFF] === 1;
    }

    /**
     * ワイヤー (wx, wy, wz) の現在の接続形状に基づき、水平隣接 (tx, wy, tz) 方向へ出力が向いているか判定
     */
    function doesWirePointTowards(wx, wy, wz, tx, tz) {
        const mask = getRedstoneWireConnectionMaskLocal(wx, wy, wz, getRaw) & 0xF;
        if (mask === 0) return true;

        const dx = tx - wx;
        const dz = tz - wz;
        let dirBit = 0;
        if (dz === -1) dirBit = 8;
        else if (dz === 1) dirBit = 4;
        else if (dx === 1) dirBit = 2;
        else if (dx === -1) dirBit = 1;
        else return false;

        if ((mask & dirBit) !== 0) return true;
        const oppositeBit = (dirBit === 8) ? 4 : (dirBit === 4) ? 8 : (dirBit === 2) ? 1 : 2;
        return mask === oppositeBit;
    }

    /**
     * (sx, sy, sz) が (tx, ty, tz) へ直接出力する強動力 (0..15)
     */
    function getDirectStrongPowerTo(sx, sy, sz, tx, ty, tz, targetIsConductor = false) {
        const raw = getRaw(sx, sy, sz);
        const id = raw & 0xFFF;
        const meta = (raw >> 12) & 0xF;
        const cfg = _blockConfigFastArray[id];
        if (!cfg) return 0;

        // 常時電源ブロック（REDSTONE_BLOCK等）: 隣接ワイヤー・デバイスは直接駆動するが、導体ブロックは強励起しない
        if (cfg.redstonePowerOutput > 0) {
            return targetIsConductor ? 0 : cfg.redstonePowerOutput;
        }

        const role = cfg.redstoneRole;
        if (role === "lever") {
            if (!getBlockStateProp(id, meta, "powered")) return 0;
            const mount = Math.min(getBlockStateRawProp(id, meta, "mount"), 4);
            if (targetIsConductor) {
                return (
                    tx === sx + MOUNT_SUPPORT_DX[mount] &&
                    ty === sy + MOUNT_SUPPORT_DY[mount] &&
                    tz === sz + MOUNT_SUPPORT_DZ[mount]
                ) ? 15 : 0;
            }
            return 15;
        }

        if (role === "torch") {
            if (!getBlockStateProp(id, meta, "lit")) return 0;
            const mount = Math.min(getBlockStateRawProp(id, meta, "mount"), 4);
            if (
                tx === sx + MOUNT_SUPPORT_DX[mount] &&
                ty === sy + MOUNT_SUPPORT_DY[mount] &&
                tz === sz + MOUNT_SUPPORT_DZ[mount]
            ) {
                return 0;
            }
            if (targetIsConductor) {
                return (tx === sx && ty === sy + 1 && tz === sz) ? 15 : 0;
            }
            return 15;
        }

        if (role === "repeater" && cfg.repeaterPowered) {
            const rot = getBlockStateRawProp(id, meta, "facing");
            if (tx === sx + REPEATER_OUT_DX[rot] && ty === sy && tz === sz + REPEATER_OUT_DZ[rot]) {
                return 15;
            }
            return 0;
        }

        return 0;
    }

    /**
     * 通電する導体ブロック (cx, cy, cz) が受けている「強動力」(0..15)
     */
    function getConductorStrongPower(cx, cy, cz) {
        if (!isRedstoneConductor(cx, cy, cz)) return 0;
        let maxP = 0;
        for (let i = 0; i < 6; i++) {
            const p = getDirectStrongPowerTo(
                cx + LIGHT_DIR_DX[i], cy + LIGHT_DIR_DY[i], cz + LIGHT_DIR_DZ[i],
                cx, cy, cz, true
            );
            if (p > maxP) maxP = p;
            if (maxP === 15) return 15;
        }
        return maxP;
    }

    /**
     * 通電する導体ブロック (cx, cy, cz) が受けている「弱動力＋強動力」(0..15)
     */
    function getConductorAnyPower(cx, cy, cz, excludeX = 0x7FFFFFFF, excludeY = 0x7FFFFFFF, excludeZ = 0x7FFFFFFF) {
        if (!isRedstoneConductor(cx, cy, cz)) return 0;

        let maxP = getConductorStrongPower(cx, cy, cz);
        if (maxP === 15) return 15;

        const upRaw = getRaw(cx, cy + 1, cz);
        if ((upRaw & 0xFFF) === BLOCK_TYPES.REDSTONE_WIRE && !(cx === excludeX && (cy + 1) === excludeY && cz === excludeZ)) {
            const wp = (upRaw >> 12) & 0xF;
            if (wp > maxP) maxP = wp;
        }

        for (let d = 0; d < 4; d++) {
            const nx = cx + RS_HORIZ_DX[d];
            const nz = cz + RS_HORIZ_DZ[d];
            if (nx === excludeX && cy === excludeY && nz === excludeZ) continue;
            const nRaw = getRaw(nx, cy, nz);
            if ((nRaw & 0xFFF) === BLOCK_TYPES.REDSTONE_WIRE) {
                const wp = (nRaw >> 12) & 0xF;
                if (wp > maxP && doesWirePointTowards(nx, cy, nz, cx, cz)) {
                    maxP = wp;
                }
            }
        }

        return maxP;
    }

    /**
     * レッドストーントーチの支持ブロック (sx, sy, sz) が通電状態か統一判定
     * - 支持ブロック自身が電源ブロック（REDSTONE_BLOCK等）の場合も true を返し、確実にトーチを消灯させる
     */
    function isSupportBlockPowered(sx, sy, sz, torchX, torchY, torchZ) {
        const sId = getRaw(sx, sy, sz) & 0xFFF;
        const sCfg = _blockConfigFastArray[sId];
        if (sCfg && sCfg.redstonePowerOutput > 0) return true;
        return getConductorAnyPower(sx, sy, sz, torchX, torchY, torchZ) > 0;
    }

    /**
     * ランプ等の対象ブロック (wx, wy, wz) が周囲から受けている総信号強度 (弱＋強)
     */
    function getTotalPowerAt(wx, wy, wz) {
        let maxP = isRedstoneConductor(wx, wy, wz) ? getConductorAnyPower(wx, wy, wz) : 0;
        if (maxP === 15) return 15;

        for (let i = 0; i < 6; i++) {
            const nx = wx + LIGHT_DIR_DX[i], ny = wy + LIGHT_DIR_DY[i], nz = wz + LIGHT_DIR_DZ[i];
            const direct = getDirectStrongPowerTo(nx, ny, nz, wx, wy, wz, false);
            if (direct > maxP) maxP = direct;

            const nRaw = getRaw(nx, ny, nz);
            const nId = nRaw & 0xFFF;
            if (nId === BLOCK_TYPES.REDSTONE_WIRE) {
                const wp = (nRaw >> 12) & 0xF;
                if (wp > maxP && (ny !== wy || doesWirePointTowards(nx, ny, nz, wx, wz))) {
                    maxP = wp;
                }
            } else if (_isRedstoneConductive[nId] === 1) {
                const cp = getConductorAnyPower(nx, ny, nz, wx, wy, wz);
                if (cp > maxP) maxP = cp;
            }
            if (maxP === 15) return 15;
        }
        return maxP;
    }

    /**
     * ワイヤーセル (wx, wy, wz) が外部電源（直接電源＋強励起済み通電導体）から受け取る初期電力 (0..15)
     */
    function getExternalWireInputPower(wx, wy, wz) {
        let maxP = 0;
        for (let i = 0; i < 6; i++) {
            const nx = wx + LIGHT_DIR_DX[i], ny = wy + LIGHT_DIR_DY[i], nz = wz + LIGHT_DIR_DZ[i];

            const direct = getDirectStrongPowerTo(nx, ny, nz, wx, wy, wz, false);
            if (direct > maxP) maxP = direct;

            if (isRedstoneConductor(nx, ny, nz)) {
                const cp = getConductorStrongPower(nx, ny, nz);
                if (cp > maxP) maxP = cp;
            }
            if (maxP === 15) return 15;
        }
        return maxP;
    }

    /**
     * リピーター (rx, ry, rz) の背面入力側が信号を受けているか判定
     */
    function isRepeaterReceivingInput(rx, ry, rz, rot) {
        const ix = rx - REPEATER_OUT_DX[rot];
        const iz = rz - REPEATER_OUT_DZ[rot];
        const iRaw = getRaw(ix, ry, iz);
        const iId = iRaw & 0xFFF;

        if (iId === BLOCK_TYPES.REDSTONE_WIRE) {
            return ((iRaw >> 12) & 0xF) > 0 && doesWirePointTowards(ix, ry, iz, rx, rz);
        }
        if (getDirectStrongPowerTo(ix, ry, iz, rx, ry, rz, false) > 0) {
            return true;
        }
        if (_isRedstoneConductive[iId] === 1) {
            return getConductorAnyPower(ix, ry, iz, rx, ry, rz) > 0;
        }
        return false;
    }

    function evaluateDevice(wx, wy, wz) {
        const raw = getRaw(wx, wy, wz);
        const id = raw & 0xFFF;
        const meta = (raw >> 12) & 0xF;
        const cfg = _blockConfigFastArray[id];
        if (!cfg || !cfg.redstoneDevice) return;

        const role = cfg.redstoneRole;
        if (role === "lamp") {
            const powered = getTotalPowerAt(wx, wy, wz) > 0;
            if (getBlockStateProp(id, meta, "lit") !== powered) {
                const nextMeta = setBlockStateProp(id, meta, "lit", powered);
                setBlockFromWorldTick(wx, wy, wz, (id & 0xFFF) | (nextMeta << 12));
            }
            return;
        }

        if (role === "torch") {
            const mount = Math.min(getBlockStateRawProp(id, meta, "mount"), 4);
            const sx = wx + MOUNT_SUPPORT_DX[mount];
            const sy = wy + MOUNT_SUPPORT_DY[mount];
            const sz = wz + MOUNT_SUPPORT_DZ[mount];
            const targetLit = !isSupportBlockPowered(sx, sy, sz, wx, wy, wz);

            if (getBlockStateProp(id, meta, "lit") !== targetLit) {
                TickScheduler.schedule(wx, wy, wz, 2, "redstone_device", -1, targetLit ? 1 : 0);
            }
            return;
        }

        if (role === "repeater") {
            const rot = getBlockStateRawProp(id, meta, "facing");
            const delayTicks = getBlockStateProp(id, meta, "delay");
            const currentPowered = !!cfg.repeaterPowered;
            const targetPowered = isRepeaterReceivingInput(wx, wy, wz, rot);

            if (currentPowered !== targetPowered) {
                TickScheduler.schedule(wx, wy, wz, delayTicks, "redstone_device", -2, targetPowered ? 1 : 0);
            }
        }
    }

    function resolveFromOrigin(originX, originY, originZ) {
        _wireVisited.clear();
        _deviceVisited.clear();
        let wireCount = 0;
        let devCount = 0;

        const addDevice = (x, y, z) => {
            if (y < 0 || y >= CHUNK_HEIGHT || devCount >= 512) return;
            const id = getRaw(x, y, z) & 0xFFF;
            const cfg = _blockConfigFastArray[id];
            if (!cfg || !cfg.redstoneDevice) return;

            const k = encodeWorldBlockKey(x, y, z);
            if (_deviceVisited.has(k)) return;
            _deviceVisited.add(k);
            _deviceCoordsX[devCount] = x;
            _deviceCoordsY[devCount] = y;
            _deviceCoordsZ[devCount] = z;
            devCount++;
        };

        const addWire = (x, y, z) => {
            if (y < 0 || y >= CHUNK_HEIGHT || wireCount >= MAX_WIRE_NODES) return -1;
            const raw = getRaw(x, y, z);
            if ((raw & 0xFFF) !== BLOCK_TYPES.REDSTONE_WIRE) return -1;
            const k = encodeWorldBlockKey(x, y, z);
            const existing = _wireVisited.get(k);
            if (existing !== undefined) return existing;

            const idx = wireCount++;
            _wireVisited.set(k, idx);
            _wireX[idx] = x;
            _wireY[idx] = y;
            _wireZ[idx] = z;
            _wireOldPower[idx] = (raw >> 12) & 0xF;
            _wireNewPower[idx] = 0;
            return idx;
        };

        for (let dx = -2; dx <= 2; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dz = -2; dz <= 2; dz++) {
                    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 3) continue;
                    const x = originX + dx, y = originY + dy, z = originZ + dz;
                    addWire(x, y, z);
                    addDevice(x, y, z);
                }
            }
        }

        for (let idx = 0; idx < wireCount; idx++) {
            const wx = _wireX[idx], wy = _wireY[idx], wz = _wireZ[idx];
            const aboveOpaque = isWireBlockingOpaque(wx, wy + 1, wz);

            for (let d = 0; d < 4; d++) {
                const nx = wx + RS_HORIZ_DX[d];
                const nz = wz + RS_HORIZ_DZ[d];
                addWire(nx, wy, nz);
                if (!aboveOpaque) addWire(nx, wy + 1, nz);
                if (!isWireBlockingOpaque(nx, wy, nz)) addWire(nx, wy - 1, nz);
            }
        }

        let qHead = 0, qTail = 0;
        for (let idx = 0; idx < wireCount; idx++) {
            const extP = getExternalWireInputPower(_wireX[idx], _wireY[idx], _wireZ[idx]);
            if (extP > 0) {
                _wireNewPower[idx] = extP;
                _bfsQueue[qTail++] = idx;
            }
        }

        while (qHead < qTail) {
            const idx = _bfsQueue[qHead++];
            const curP = _wireNewPower[idx];
            if (curP <= 1) continue;
            const nextP = curP - 1;

            const wx = _wireX[idx], wy = _wireY[idx], wz = _wireZ[idx];
            const aboveOpaque = isWireBlockingOpaque(wx, wy + 1, wz);

            const relax = (nx, ny, nz) => {
                const nIdx = _wireVisited.get(encodeWorldBlockKey(nx, ny, nz));
                if (nIdx !== undefined && nextP > _wireNewPower[nIdx]) {
                    _wireNewPower[nIdx] = nextP;
                    if (qTail < _bfsQueue.length) _bfsQueue[qTail++] = nIdx;
                }
            };

            for (let d = 0; d < 4; d++) {
                const nx = wx + RS_HORIZ_DX[d];
                const nz = wz + RS_HORIZ_DZ[d];
                relax(nx, wy, nz);
                if (!aboveOpaque) relax(nx, wy + 1, nz);
                if (!isWireBlockingOpaque(nx, wy, nz)) relax(nx, wy - 1, nz);
            }
        }

        for (let idx = 0; idx < wireCount; idx++) {
            const newP = _wireNewPower[idx];
            const wx = _wireX[idx], wy = _wireY[idx], wz = _wireZ[idx];
            const powerChanged = (newP !== _wireOldPower[idx]);

            if (powerChanged) {
                const packed = (BLOCK_TYPES.REDSTONE_WIRE & 0xFFF) | ((newP & 0xF) << 12);
                setBlockFromWorldTick(wx, wy, wz, packed);
            }

            const nearOrigin = (Math.abs(wx - originX) + Math.abs(wy - originY) + Math.abs(wz - originZ)) <= 2;
            if (powerChanged || nearOrigin) {
                for (let dx = -2; dx <= 2; dx++) {
                    for (let dy = -2; dy <= 2; dy++) {
                        for (let dz = -2; dz <= 2; dz++) {
                            if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= 2) {
                                addDevice(wx + dx, wy + dy, wz + dz);
                            }
                        }
                    }
                }
            }
        }

        for (let i = 0; i < devCount; i++) {
            evaluateDevice(_deviceCoordsX[i], _deviceCoordsY[i], _deviceCoordsZ[i]);
        }
    }

    return {
        onBlockChanged(wx, wy, wz) {
            resolveFromOrigin(wx | 0, wy | 0, wz | 0);
        },
        handleScheduledDeviceTick(task) {
            const { x, y, z, payload } = task;
            const raw = getRaw(x, y, z);
            const id = raw & 0xFFF;
            const meta = (raw >> 12) & 0xF;
            const cfg = _blockConfigFastArray[id];
            if (!cfg || !cfg.redstoneDevice) return;

            if (cfg.redstoneRole === "torch") {
                const mount = Math.min(getBlockStateRawProp(id, meta, "mount"), 4);
                const sx = x + MOUNT_SUPPORT_DX[mount];
                const sy = y + MOUNT_SUPPORT_DY[mount];
                const sz = z + MOUNT_SUPPORT_DZ[mount];
                const nextLit = !isSupportBlockPowered(sx, sy, sz, x, y, z);

                if (getBlockStateProp(id, meta, "lit") !== nextLit) {
                    const nextMeta = setBlockStateProp(id, meta, "lit", nextLit);
                    setBlockFromWorldTick(x, y, z, (id & 0xFFF) | (nextMeta << 12));
                    resolveFromOrigin(x, y, z);
                }
            } else if (cfg.redstoneRole === "repeater") {
                const rot = getBlockStateRawProp(id, meta, "facing");
                const curPowered = !!cfg.repeaterPowered;
                const desiredPowered = isRepeaterReceivingInput(x, y, z, rot);
                const fallbackPowered = (payload & 1) !== 0;

                const nextPowered = (curPowered !== desiredPowered) ? desiredPowered : fallbackPowered;
                if (curPowered !== nextPowered) {
                    const nextId = nextPowered ? BLOCK_TYPES.REDSTONE_REPEATER_ON : BLOCK_TYPES.REDSTONE_REPEATER;
                    setBlockFromWorldTick(x, y, z, (nextId & 0xFFF) | (meta << 12));
                    resolveFromOrigin(x, y, z);
                }
            }
        }
    };
})();

// Step14 の TickScheduler へレッドストーン遅延デバイスハンドラを登録
TickScheduler.registerHandler("redstone_device", (task) => {
    RedstoneEngine.handleScheduledDeviceTick(task);
});

function setBlockFromWorldTick(wx, wy, wz, newRaw) {
    if (wy < 0 || wy >= CHUNK_HEIGHT) return false;
    const cx = wx >> 4;
    const cz = wz >> 4;
    const lx = wx & 15;
    const lz = wz & 15;
    const key = encodeChunkKey(cx, cz);

    const dataArray = ChunkSaveManager.modifiedChunks.get(key);
    if (!dataArray) return false;

    const idx = wy | (lz << 8) | (lx << 12);
    const oldRaw = dataArray[idx];
    const packed = newRaw & 0xFFFF;
    if (oldRaw === packed) return false;

    dataArray[idx] = packed;
    if (ChunkSaveManager.playerModifiedKeys.has(key)) {
        ChunkSaveManager.dirtySaveKeys.add(key);
    }

    _tickLightDirtySet.clear();
    updateLightAtBlockChange(wx, wy, wz, oldRaw, packed, _tickLightDirtySet);

    requestChunkUpdate(cx, cz);
    if (lx === 0) requestChunkUpdate(cx - 1, cz);
    else if (lx === 15) requestChunkUpdate(cx + 1, cz);
    if (lz === 0) requestChunkUpdate(cx, cz - 1);
    else if (lz === 15) requestChunkUpdate(cx, cz + 1);

    for (const dKey of _tickLightDirtySet) {
        if (dKey !== key && loadedChunks.has(dKey)) {
            decodeChunkKey(dKey, _tickDirtyCoordTmp);
            requestChunkUpdate(_tickDirtyCoordTmp.cx, _tickDirtyCoordTmp.cz);
        }
    }
    return true;
}

// --- ランダムTick処理（高速 xorshift32 ＆ ブロックIDハンドラテーブル） ---
let _tickRngState = 0x9E3779B9;
function nextTickRng() {
    let x = _tickRngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    _tickRngState = x;
    return x >>> 0;
}

const RANDOM_TICK_HANDLERS = new Array(MAX_BLOCK_IDS).fill(null);

export function registerRandomTickHandler(blockId, fn) {
    const id = blockId & 0xFFF;
    if (id >= 0 && id < RANDOM_TICK_HANDLERS.length && typeof fn === "function") {
        RANDOM_TICK_HANDLERS[id] = fn;
    }
}

// Minecraft Java Edition 準拠: 草ブロックの枯死（上を不透明ブロックで塞いだ場合）と隣接土への自然伝播
RANDOM_TICK_HANDLERS[BLOCK_TYPES.GRASS] = (wx, wy, wz) => {
    const aboveId = _getWorldBlockIdLoaded(wx, wy + 1, wz);
    if (aboveId < 0) return;

    // 1. 不透明ブロックが真上にあると草は土へ戻る
    if (getBlockLightOpacity(aboveId) >= 15) {
        setBlockFromWorldTick(wx, wy, wz, BLOCK_TYPES.DIRT);
        return;
    }

    // 2. 光量 >= 9 の草ブロックは周囲 3x3（高さ -1..+2）の露出した土へ伝播
    const aboveLight = _getWorldLightCell(wx, wy + 1, wz);
    if (aboveLight < 0) return;
    const sky = (aboveLight >> 4) & 15;
    const blk = aboveLight & 15;
    if ((sky > blk ? sky : blk) < 9) return;

    const r = nextTickRng();
    const tx = wx + ((r % 3) - 1);
    const tz = wz + ((((r >>> 4) | 0) % 3) - 1);
    const ty = wy + ((((r >>> 8) | 0) % 4) - 1);
    if (ty <= 0 || ty >= CHUNK_HEIGHT - 1) return;

    const targetId = _getWorldBlockIdLoaded(tx, ty, tz);
    if (targetId !== BLOCK_TYPES.DIRT) return;

    const targetAboveId = _getWorldBlockIdLoaded(tx, ty + 1, tz);
    if (targetAboveId < 0 || getBlockLightOpacity(targetAboveId) >= 2) return;

    const targetAboveLight = _getWorldLightCell(tx, ty + 1, tz);
    if (targetAboveLight < 0) return;
    const tSky = (targetAboveLight >> 4) & 15;
    const tBlk = targetAboveLight & 15;
    if ((tSky > tBlk ? tSky : tBlk) < 4) return;

    setBlockFromWorldTick(tx, ty, tz, BLOCK_TYPES.GRASS);
};

const RANDOM_TICKS_PER_CHUNK = 12;
const _randomTickCoordTmp = { cx: 0, cz: 0 };

function processRandomTicks(pCx, pCz) {
    let chunksSampled = 0;
    const maxChunksPerTick = 48;

    for (const key of loadedChunks.keys()) {
        decodeChunkKey(key, _randomTickCoordTmp);
        const cx = _randomTickCoordTmp.cx;
        const cz = _randomTickCoordTmp.cz;
        if (Math.abs(cx - pCx) > SIMULATION_DISTANCE || Math.abs(cz - pCz) > SIMULATION_DISTANCE) {
            continue;
        }

        const vData = ChunkSaveManager.modifiedChunks.get(key);
        if (!vData) continue;

        const baseX = cx << 4;
        const baseZ = cz << 4;

        for (let s = 0; s < RANDOM_TICKS_PER_CHUNK; s++) {
            const r = nextTickRng();
            const lx = r & 15;
            const lz = (r >>> 4) & 15;
            const ly = 1 + ((r >>> 8) & 127); // Y=1..128 帯を高速サンプル

            const raw = vData[ly | (lz << 8) | (lx << 12)];
            if (raw === 0) continue;

            const handler = RANDOM_TICK_HANDLERS[raw & 0xFFF];
            if (handler) {
                handler(baseX + lx, ly, baseZ + lz, raw);
            }
        }

        if (++chunksSampled >= maxChunksPerTick) break;
    }
}

/**
 * 固定 60Hz 物理シミュレーション 1ステップ実行
 */
function runPhysicsStep() {
    player.prevPosition.copy(player.position);

    // 水中判定は 20Hz（3物理Tickに1回）で決定論的に更新
    if ((physicsStepCounter % 3) === 0) {
        wasUnderwater = isPlayerEntireBodyInWater();
    }
    physicsStepCounter++;

    if (!flightMode && keys[" "] && player.onGround && !wasUnderwater) {
        jumpRequest = true;
    }

    if (flightMode) {
        updateFlightPhysics();
    } else if (wasUnderwater) {
        updateUnderwaterPhysics(PHYSICS_FIXED_DT);
        jumpRequest = false;
    } else {
        updateNormalPhysics();
    }

    resolvePlayerCollision();
    updateOnGround();
    resetLastPlacedIfOnGround();
}

/**
 * 固定 20 TPS ワールドロジック 1Tick実行（Minecraft Java Edition 準拠）
 */
function runWorldTick(pCx, pCz) {
    worldTickCount++;
    ticksInSecond++;

    gameTime = (gameTime + TIME_SPEED) % TICKS_PER_DAY;
    TickScheduler.processTick(worldTickCount);
    processRandomTicks(pCx, pCz);
}

/**
 * 最新カメラの視錐台（Frustum）と各チャンクの精密 AABB（実最高高度ベース）で一括カリング
 */
function updateChunkFrustumCulling() {
    camera.updateMatrixWorld();
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _chunkFrustum.setFromProjectionMatrix(_projScreenMatrix);

    for (const chunk of loadedChunks.values()) {
        const bbox = chunk.userData.boundingBox;
        chunk.visible = bbox ? _chunkFrustum.intersectsBox(bbox) : true;
    }
}

function animate() {
    requestAnimationFrame(animate);

    let delta = clock.getDelta();
    if (delta > 0.1) delta = 0.1; // タブ復帰・スパイク対策
    const now = performance.now();

    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);

    // 0. -------- ロード・スポーン待機ガード --------
    if (!player.spawnFixed) {
        const spawnKey = encodeChunkKey(pCx, pCz);
        if (loadedChunks.has(spawnKey)) {
            if (player.position.y === 40) {
                const sx = Math.floor(player.position.x);
                const sz = Math.floor(player.position.z);
                let safeY = SEA_LEVEL + 2;
                for (let y = CHUNK_HEIGHT - 2; y >= 1; y--) {
                    const bid = getVoxelAtWorld(sx, y, sz, false);
                    if (bid === BLOCK_TYPES.SKY) continue;
                    const cfg = _blockConfigFastArray[bid];
                    if (cfg && (cfg.collision !== false || cfg.geometryType === "water")) {
                        safeY = y + 1.05;
                        break;
                    }
                }
                player.position.y = safeY;
            }
            player.prevPosition.copy(player.position);
            player.spawnFixed = true;
            updateSunMoonPosition(gameTime);
            updateStars(gameTime);
        } else {
            player.velocity.y = 0;
            updateChunks();
            processChunkQueue(true);
            return;
        }
    }
    frameCount++;

    // 1. -------- 固定タイムステップ実行（ポーズ中はシミュレーション完全停止） --------
    if (!isPaused) {
        // 1-A. 固定 60Hz 物理シミュレーション（どのリフレッシュレートでも同一の移動・重力・ジャンプ）
        camera.rotation.set(pitch, yaw, 0);
        physicsAccumulator += delta;
        let physSteps = 0;
        while (physicsAccumulator >= PHYSICS_FIXED_DT && physSteps < MAX_PHYSICS_STEPS_PER_FRAME) {
            runPhysicsStep();
            physicsAccumulator -= PHYSICS_FIXED_DT;
            physSteps++;
        }
        if (physSteps >= MAX_PHYSICS_STEPS_PER_FRAME && physicsAccumulator > PHYSICS_FIXED_DT) {
            physicsAccumulator = 0; // スパイラル・オブ・デス防止
        }

        // 1-B. 固定 20 TPS ワールドロジックTick（時間進行・予約Tick・ランダムTick）
        worldTickAccumulator += delta;
        let worldSteps = 0;
        while (worldTickAccumulator >= WORLD_TICK_DT && worldSteps < MAX_WORLD_TICKS_PER_FRAME) {
            runWorldTick(getChunkCoord(player.position.x), getChunkCoord(player.position.z));
            worldTickAccumulator -= WORLD_TICK_DT;
            worldSteps++;
        }
        if (worldSteps >= MAX_WORLD_TICKS_PER_FRAME && worldTickAccumulator > WORLD_TICK_DT) {
            worldTickAccumulator = 0;
        }

        // 1-C. パーティクル・雲スクロール更新
        updateBlockParticles(delta);
        updateCloudTiles(delta);
    } else {
        // ポーズ中は残余アキュムレータを破棄し、再開時のワープを防止
        physicsAccumulator = 0;
        worldTickAccumulator = 0;
        player.prevPosition.copy(player.position);
    }

    // 2. -------- 補間済み時間による昼夜サイクル・天体更新 --------
    const worldTickAlpha = isPaused ? 0 : (worldTickAccumulator * WORLD_TPS);
    const renderGameTime = (gameTime + worldTickAlpha * TIME_SPEED) % TICKS_PER_DAY;
    updateSunMoonPosition(renderGameTime);
    updateStars(renderGameTime);
    const currentSkyFactor = getSkyLightFactor(renderGameTime);

    const curPCx = getChunkCoord(player.position.x);
    const curPCz = getChunkCoord(player.position.z);

    // 3. -------- HUD（デバッグ情報）の更新（1秒ごと） --------
    if (now - lastFpsTime > 1000) {
        const elapsedSec = (now - lastFpsTime) * 0.001;
        const fps = Math.round(frameCount / elapsedSec);
        measuredTps = isPaused ? 0 : Math.min(WORLD_TPS, Math.round((ticksInSecond / elapsedSec) * 10) / 10);

        const activeUpdates = pendingChunkUpdates.size + chunkQueue.length;
        const editedCount = ChunkSaveManager.playerModifiedKeys.size;
        const unsavedCount = ChunkSaveManager.dirtySaveKeys.size;
        const cachedChunkCount = ChunkSaveManager.modifiedChunks.size;

        const drawCalls = renderer.info.render.calls;
        const triangles = renderer.info.render.triangles;

        const targetText = (typeof currentTargetBlockText !== 'undefined') ? currentTargetBlockText : "None";
        const moveMode = flightMode ? "Flight" : (wasUnderwater ? "Swimming" : "Walking");

        const pxInt = Math.floor(player.position.x);
        const py = player.position.y;
        const pzInt = Math.floor(player.position.z);
        const biome = _getBiomeAt(pxInt, pzInt);
        const biomeName = biome ? biome.name : "Unknown";

        fpsCounter.innerHTML = `
        <b>Minecraft test 0.0.1</b><br>
        Seed: ${currentSeed}<br>
        Time: ${getGameClock(gameTime)} (${Math.floor(gameTime)} ticks)<br>
        ${fps} fps, ${measuredTps.toFixed(1)} tps, ${activeUpdates} chunks update<br>
        <b>Draw calls: ${drawCalls}</b> (Tri: ${triangles.toLocaleString()})<br>
        ${editedCount} edited chunks (${unsavedCount} unsaved / ${cachedChunkCount} cached)<br>
        C: ${loadedChunks.size} loaded. (Quality: ${CHUNK_VISIBLE_DISTANCE})<br>
        Dimension: Overworld<br>
        <b>Biome: ${biomeName}</b><br>
        x: ${pxInt} (C: ${curPCx})<br>
        y: ${Math.round(py)} (feet)<br>
        z: ${pzInt} (C: ${curPCz})<br>
        Mode: ${moveMode} / Dash: ${dashActive ? "ON" : "OFF"}<br>
        --------------------------<br>
        TargetBlock: ${targetText}
    `;

        frameCount = 0;
        ticksInSecond = 0;
        lastFpsTime = now;
    }

    // 4. -------- チャンク生成・アンロード & メッシュ再構築 --------
    updateChunks();
    processChunkUnloadQueue();
    processChunkQueue(false);
    updateChunkFadeIns(now);
    chunkUpdateFrameTimer += delta;
    if (chunkUpdateFrameTimer > 0.016) {
        if (pendingChunkUpdates.size > 0) processPendingChunkUpdates(4);
        chunkUpdateFrameTimer = 0;
    }
    chunkCacheEvictTimer += delta;
    if (chunkCacheEvictTimer > 0.25) {
        evictDistantChunkCaches(curPCx, curPCz);
        chunkCacheEvictTimer = 0;
    }

    if (showChunkBorders) {
        chunkBorderMesh.position.set(curPCx * CHUNK_SIZE, 0, curPCz * CHUNK_SIZE);
    }

    // 5. -------- 描画補間によるカメラ位置の更新（高リフレッシュレート滑らか追従） --------
    const physicsAlpha = isPaused ? 1.0 : (physicsAccumulator * PHYSICS_TPS);
    _interpPlayerPos.lerpVectors(player.prevPosition, player.position, physicsAlpha);

    const playerHeight = getCurrentPlayerHeight() - (flightMode ? 0.15 : 0);
    _camOffset.set(0, playerHeight, 0);
    _tempVec3.copy(_interpPlayerPos).add(_camOffset);

    camera.position.x = _tempVec3.x;
    camera.position.z = _tempVec3.z;
    // フレームレート非依存の指数平滑（60Hz時の 0.5 相当を全リフレッシュレートで再現）
    const camYLerp = 1.0 - Math.exp(-36.0 * delta);
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, _tempVec3.y, camYLerp);

    // 6. -------- ブロック選択・情報の更新 --------
    if (!isPaused) {
        blockInfoTimer += delta;
        if (blockInfoTimer > 0.05) {
            const hasMoved = camera.position.distanceToSquared(lastCamPos) > 0.0001 ||
                Math.abs(camera.rotation.y - lastCamRot.y) > 0.0001 ||
                Math.abs(camera.rotation.x - lastCamRot.x) > 0.0001;

            if (hasMoved) {
                updateTargetBlockDisplay(false);
                updateHeadBlockInfo();
                lastCamPos.copy(camera.position);
                lastCamRot.copy(camera.rotation);
            }
            blockInfoTimer = 0;
        }
    }

    // 7. -------- クラウド（雲）の描画更新 --------
    updateCloudGrid(scene, camera.position);
    updateCloudOpacity(camera.position, currentSkyFactor);
    adjustCloudLayerDepth(null, camera);

    // 8. -------- チャンク単位 精密 AABB フラスタムカリング --------
    updateChunkFrustumCulling();

    // 9. -------- 最終処理 & レンダリング --------
    updateScreenOverlay();
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

let isLaunchingWorld = false;

/**
 * 保存された座標・視点データを安全に検証・クランプする
 */
function sanitizeSavedPosition(rawPos) {
    if (!rawPos || typeof rawPos !== 'object') {
        return { x: 0, y: 40, z: 0, yaw: 0, pitch: 0 };
    }
    const x = Number.isFinite(rawPos.x) ? Math.max(-30000000, Math.min(30000000, rawPos.x)) : 0;
    const y = Number.isFinite(rawPos.y) ? Math.max(-10, Math.min(512, rawPos.y)) : 64;
    const z = Number.isFinite(rawPos.z) ? Math.max(-30000000, Math.min(30000000, rawPos.z)) : 0;
    const savedYaw = Number.isFinite(rawPos.yaw) ? rawPos.yaw : 0;
    const savedPitch = Number.isFinite(rawPos.pitch)
        ? Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rawPos.pitch))
        : 0;
    return { x, y, z, yaw: savedYaw, pitch: savedPitch };
}

/**
 * 保存されたホットバー9スロット・選択スロット・飛行状態をUIとゲーム状態へ復元する
 */
async function restorePlayerSaveState(savedPlayerState) {
    const hotbarItems = document.querySelectorAll(".hotbar-item");
    const hotbarKeys = Array.isArray(savedPlayerState?.hotbarKeys) ? savedPlayerState.hotbarKeys : [];

    for (let i = 0; i < hotbarItems.length; i++) {
        const slot = hotbarItems[i];
        slot.innerHTML = "";
        slot.dataset.blocktype = "";
        slot.classList.remove("active");

        const key = hotbarKeys[i];
        if (!key || typeof key !== "string") continue;

        const blockId = keyToId(key);
        if (!blockId || blockId === BLOCK_TYPES.SKY) continue;

        const cfg = getBlockConfiguration(blockId);
        if (!cfg || cfg.itemdisplay === false) continue;

        slot.dataset.blocktype = String(blockId);
        const preview = await createHotbarItemPreview(cfg);
        preview.style.width = preview.style.height = "55px";
        slot.appendChild(preview);
    }

    const rawSlot = Number(savedPlayerState?.selectedHotbarIndex);
    selectedHotbarIndex = Number.isInteger(rawSlot) ? Math.max(0, Math.min(8, rawSlot)) : 0;
    updateHotbarSelection();

    // インベントリ側の選択ハイライトもホットバーと同期
    document.querySelectorAll(".inventory-item.active").forEach(el => el.classList.remove("active"));
    if (activeBlockType > 0) {
        const invMatch = document.querySelector(`.inventory-item[data-blocktype="${activeBlockType}"]`);
        if (invMatch) invMatch.classList.add("active");
    }

    if (typeof savedPlayerState?.flightMode === "boolean") {
        flightMode = savedPlayerState.flightMode;
    }
}

/**
 * スポーン周囲チャンク（半径2チャンク）をローディング画面中に事前構築し、開始直後の空中浮遊・ポップインを防ぐ
 */
async function prewarmSpawnChunks(updateProgressFn, startPct, endPct) {
    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);
    const radius = Math.min(CHUNK_VISIBLE_DISTANCE, 2);

    const targets = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const d2 = dx * dx + dz * dz;
            if (d2 <= (radius + 0.5) * (radius + 0.5)) {
                targets.push({ cx: pCx + dx, cz: pCz + dz, d2, key: encodeChunkKey(pCx + dx, pCz + dz) });
            }
        }
    }
    // プレイヤー至近（中央）から順に処理
    targets.sort((a, b) => a.d2 - b.d2);

    const total = targets.length || 1;
    const midPct = Math.round((startPct + endPct) * 0.5);

    // Pass 1: 全対象チャンクのベース地形・デコレーション・ライトマップを先行構築（境界データ欠損を完全防止）
    for (let i = 0; i < targets.length; i++) {
        const { cx, cz, key } = targets[i];
        let vData = ChunkSaveManager.modifiedChunks.get(key);
        if (!vData || !ChunkSaveManager.decoratedChunks.has(key)) {
            vData = ChunkSaveManager.captureBaseChunkData(cx, cz);
        }
        if (vData && !chunkLightCache.has(key)) {
            generateChunkLightMap(key, vData);
        }
        if ((i & 3) === 3 || i === targets.length - 1) {
            const pct = Math.round(startPct + ((i + 1) / total) * (midPct - startPct));
            await updateProgressFn(pct);
        }
    }

    // Pass 2: 隣接データ・ライトが全て揃った状態でメッシュを一括構築＋隣接通知
    for (let i = 0; i < targets.length; i++) {
        const { cx, cz, key } = targets[i];
        if (!loadedChunks.has(key)) {
            const mesh = generateChunkMeshMultiTexture(cx, cz, false, false);
            if (mesh) {
                syncSingleChunkSkyLight(mesh);
                mesh.userData.fadedIn = true;
                scene.add(mesh);
                loadedChunks.set(key, mesh);

                checkNeighborUpdate(cx + 1, cz, NEIGHBOR_BIT_NX);
                checkNeighborUpdate(cx - 1, cz, NEIGHBOR_BIT_PX);
                checkNeighborUpdate(cx, cz + 1, NEIGHBOR_BIT_NZ);
                checkNeighborUpdate(cx, cz - 1, NEIGHBOR_BIT_PZ);
            }
        }
        if ((i & 1) === 1 || i === targets.length - 1) {
            const pct = Math.round(midPct + ((i + 1) / total) * (endPct - midPct));
            await updateProgressFn(pct);
        }
    }

    // 新規ワールド時（y === 40）は事前生成した中央チャンクの実ボクセルから正確な地表高度へ着地させる
    if (!player.spawnFixed) {
        const sx = Math.floor(player.position.x);
        const sz = Math.floor(player.position.z);
        let safeY = SEA_LEVEL + 2;
        for (let y = CHUNK_HEIGHT - 2; y >= 1; y--) {
            const bid = getVoxelAtWorld(sx, y, sz, false);
            if (bid === BLOCK_TYPES.SKY) continue;
            const cfg = _blockConfigFastArray[bid];
            if (cfg && (cfg.collision !== false || cfg.geometryType === "water")) {
                safeY = y + 1.05;
                break;
            }
        }
        player.position.y = safeY;
        player.prevPosition.copy(player.position);
        player.spawnFixed = true;
    }

    // 周囲チャンクのロード状態を同期して残りの外周チャンクキューを準備
    lastChunk.x = null;
    lastChunk.z = null;
    updateChunks();
}

// 3. 生成開始
document.getElementById('btn-start-game').onclick = async () => {
    if (isLaunchingWorld) return;
    isLaunchingWorld = true;

    try {
        ui.menu.style.display = 'none';
        ui.config.style.display = 'none';
        ui.loading.style.display = 'flex';
        const seed = applySeed(ui.seedInput.value);
        await startGame(seed);
    } catch (error) {
        console.error("新規ワールド生成中にエラーが発生しました:", error);
        alert("ワールドの生成に失敗しました。ページを再読み込みしてください。");
        ui.loading.style.display = 'none';
        ui.menu.style.display = 'flex';
        isLaunchingWorld = false;
    }
};

// 保存データから再開（連打防止・即時ローディング遷移・ホットバー完全復元版）
document.getElementById('btn-load-saved').onclick = async () => {
    if (isLaunchingWorld) return;
    isLaunchingWorld = true;

    try {
        // 押下直後にローディング画面へ切り替え、DB読込中の無反応感を排除
        ui.config.style.display = 'none';
        ui.menu.style.display = 'none';
        ui.loading.style.display = 'flex';

        const fill = document.getElementById('loading-fill');
        if (fill) fill.style.width = '5%';

        // 1. データの読み込みを待機
        const saveData = await loadFullSaveData();

        // 2. データの存在チェック
        if (saveData) {
            const restoredTime = (typeof saveData.gameTime === 'number' && Number.isFinite(saveData.gameTime))
                ? ((saveData.gameTime % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY
                : 6000;

            const startPos = sanitizeSavedPosition(saveData.pos);

            console.log(
                `[Load] ロード成功: Seed=${saveData.seed}, Time=${Math.floor(restoredTime)}, ` +
                `Chunks=${saveData.chunks?.size || 0}件, Hotbar=${saveData.playerState?.hotbarKeys?.filter(Boolean).length || 0}個`
            );

            await startGame(
                saveData.seed,
                startPos,
                saveData.chunks,
                restoredTime,
                saveData.worldUid || null,
                saveData.playerState || null
            );
        } else {
            ui.loading.style.display = 'none';
            ui.menu.style.display = 'flex';
            isLaunchingWorld = false;
            alert("セーブデータが見つかりませんでした。");
        }
    } catch (error) {
        console.error("ロード中にエラーが発生しました:", error);
        ui.loading.style.display = 'none';
        ui.menu.style.display = 'flex';
        isLaunchingWorld = false;
        alert("データの読み込みに失敗しました。IndexedDBの状態を確認してください。");
    }
};

// ワールド一意識別子（新規作成時の前ワールドチャンク混入防止＆同一ワールド差分セーブ判定用）
let currentWorldUid = null;
let isWorldSavedToDB = false;

function generateWorldUid() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function startGame(seed, savedPos = null, savedChunks = null, savedTime = 0, savedWorldUid = null, savedPlayerState = null) {
    const fill = document.getElementById('loading-fill');

    const updateProgress = async (percent) => {
        if (fill) fill.style.width = `${percent}%`;
        await new Promise(resolve => requestAnimationFrame(resolve));
    };

    // 10%：開始
    ui.loading.style.display = 'flex';
    await updateProgress(10);

    initCanvas();
    initSunMoon();
    initStars();

    gameTime = Number.isFinite(savedTime) ? savedTime : 0;

    // 25%：基本システム初期化完了
    await updateProgress(25);

    // --- 1. シード値とキャッシュ・ワールド所有権・データの適用 ---
    applySeed(seed);
    chunkLightCache.clear();
    chunkReadOnlyCache.clear();
    _vC0_key = null; _vC0_data = null;
    _vC1_key = null; _vC1_data = null;

    const hasSavedChunks = (savedChunks instanceof Map && savedChunks.size > 0);
    const isLoadedWorld = (savedPos !== null) || (savedWorldUid !== null) || hasSavedChunks;
    currentWorldUid = isLoadedWorld ? (savedWorldUid || `legacy_${seed}`) : generateWorldUid();
    isWorldSavedToDB = isLoadedWorld;

    ChunkSaveManager.playerModifiedKeys.clear();
    ChunkSaveManager.dirtySaveKeys.clear();
    ChunkSaveManager.decoratedChunks.clear();

    if (isLoadedWorld && hasSavedChunks) {
        ChunkSaveManager.modifiedChunks = savedChunks;
        for (const savedKey of savedChunks.keys()) {
            ChunkSaveManager.playerModifiedKeys.add(savedKey);
            ChunkSaveManager.decoratedChunks.add(savedKey);
        }
    } else {
        ChunkSaveManager.modifiedChunks = new Map();
    }

    // 40%：チャンクデータ復元完了
    await updateProgress(40);

    // --- 2. プレイヤー位置・視点・Tick状態の初期化 ---
    TickScheduler.clear();
    worldTickCount = 0;
    worldTickAccumulator = 0;
    physicsAccumulator = 0;
    physicsStepCounter = 0;
    ticksInSecond = 0;
    clock.getDelta();

    const startPos = savedPos ? sanitizeSavedPosition(savedPos) : { x: 0, y: 40, z: 0, yaw: 0, pitch: 0 };
    player.position.set(startPos.x, startPos.y, startPos.z);
    player.prevPosition.copy(player.position);
    player.velocity.set(0, 0, 0);
    player.spawnFixed = (savedPos !== null);
    yaw = startPos.yaw;
    pitch = startPos.pitch;

    // 50%：座標・視点確定
    await updateProgress(50);

    // --- 3. アイテムプレビュー生成＆ホットバー・プレイヤー状態復元 ---
    if (typeof itemspreview === 'function') {
        await itemspreview();
        await initTooltip();
    }
    await restorePlayerSaveState(savedPlayerState);

    // 70%：UI・ホットバー復元完了
    await updateProgress(70);

    // --- 4. スポーン周囲チャンク事前生成（開始直後の空中浮遊・地面ポップイン防止） ---
    await prewarmSpawnChunks(updateProgress, 70, 95);

    // --- 5. 天体・カメラ初期同期 ---
    updateSunMoonPosition();
    updateStars();
    camera.position.set(
        player.position.x,
        player.position.y + getCurrentPlayerHeight() - (flightMode ? 0.15 : 0),
        player.position.z
    );
    camera.rotation.set(pitch, yaw, 0);

    // 100%：すべてのロードが完了
    await updateProgress(100);

    setTimeout(() => {
        ui.config.style.display = 'none';
        ui.menu.style.display = 'none';
        ui.loading.style.display = 'none';
        addChatMessage(isLoadedWorld ? "セーブデータをロードしました" : "世界を新しく生成しました", "#ffff00");
        animate();
    }, 100);
}


/* ======================================================
   【中断・ポーズシステム】修正版
   ====================================================== */
let isPaused = false;
const pauseMenu = document.getElementById("pause-menu");
const mainMenu = document.getElementById("main-menu");

/**
 * ポーズ移行・タブ非表示時に入力キーと長押し破壊/設置を安全解除する（キー張り付き防止）
 */
function releaseAllActiveInputs() {
    for (const k in keys) {
        keys[k] = false;
    }
    dashActive = false;
    sneakActive = false;
    jumpRequest = false;
    f3Pressed = false;
    stopInteraction("left");
    stopInteraction("right");
    stopInteraction("touch");
}

// ポーズ状態を画面に反映させる関数
function updatePauseUI() {
    if (isPaused) {
        releaseAllActiveInputs();
        pauseMenu.style.display = "flex";
    } else {
        clock.getDelta(); // ポーズ中の経過時間を捨てて再開時の時間飛びを防止
        pauseMenu.style.display = "none";
    }
}

// タブ切り替え・最小化時のキー張り付きおよび自動ポーズ保護
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        releaseAllActiveInputs();
        physicsAccumulator = 0;
        worldTickAccumulator = 0;
        if (renderer && mainMenu && mainMenu.style.display === "none" && !isPaused) {
            isPaused = true;
            updatePauseUI();
        }
    } else {
        clock.getDelta();
    }
});

/* ======================================================
   保存してタイトルへ戻る
   ====================================================== */
let isSavingWorld = false;

/**
 * ホットバー構成（文字列ブロックキー配列）・選択スロット・飛行状態を収集
 */
function collectPlayerSaveState() {
    const hotbarItems = document.querySelectorAll(".hotbar-item");
    const hotbarKeys = new Array(9).fill("");
    for (let i = 0; i < 9 && i < hotbarItems.length; i++) {
        const rawId = Number(hotbarItems[i].dataset.blocktype || 0);
        hotbarKeys[i] = rawId > 0 ? idToKey(rawId & 0xFFF) : "";
    }
    return {
        hotbarKeys,
        selectedHotbarIndex,
        flightMode: !!flightMode
    };
}

/**
 * 現在のワールドを安全に保存する（手動セーブ・終了時セーブ・将来のオートセーブ共通入口）
 */
async function saveCurrentWorld() {
    if (isSavingWorld) return false;
    isSavingWorld = true;

    try {
        const s = (typeof currentSeed !== 'undefined') ? currentSeed : 0;
        const pPos = (typeof player !== 'undefined' && player.position)
            ? { x: player.position.x, y: player.position.y, z: player.position.z, yaw: yaw, pitch: pitch }
            : { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };

        const playerState = collectPlayerSaveState();
        const result = await saveWorldData(s, pPos, ChunkSaveManager, gameTime, currentWorldUid, playerState);

        console.log(
            `[Save] 完了 (${result.mode}): ${result.savedChunks} チャンク / ` +
            `${(result.totalBytes / 1024).toFixed(1)} KB (${result.elapsedMs.toFixed(1)} ms)`
        );
        return true;
    } finally {
        isSavingWorld = false;
    }
}

const btnSaveAndQuit = document.getElementById("btn-save-quit");

if (btnSaveAndQuit) {
    btnSaveAndQuit.onclick = async () => {
        if (isSavingWorld) return;

        const originalText = btnSaveAndQuit.textContent;
        btnSaveAndQuit.disabled = true;
        btnSaveAndQuit.textContent = "保存中...";

        try {
            const ok = await saveCurrentWorld();
            if (ok) {
                window.location.reload();
                return;
            }
        } catch (error) {
            console.error("保存失敗:", error);
            alert(
                "ワールドの保存に失敗しました（ブラウザのストレージ容量不足またはIndexedDBエラー）。\n" +
                "現在のデータは失われていません。空き容量を確認してから再度お試しください。"
            );
        }

        // 保存失敗時はリロードせず操作へ復帰し、建築データを保護する
        btnSaveAndQuit.disabled = false;
        btnSaveAndQuit.textContent = originalText;
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

function isGameplayInputActive() {
    return !!renderer && !isPaused && !isInventoryOpen && mainMenu && mainMenu.style.display === "none";
}

function startInteraction(action, key = "default") {
    if (!isGameplayInputActive()) return;
    if (interactIntervalIds[key] != null) {
        clearInterval(interactIntervalIds[key]);
    }
    interactWithBlock(action);
    interactIntervalIds[key] = setInterval(() => {
        if (!isGameplayInputActive()) {
            stopInteraction(key);
            return;
        }
        interactWithBlock(action);
    }, INTERACT_SPEED);
}

function stopInteraction(key = "default") {
    if (interactIntervalIds[key] != null) {
        clearInterval(interactIntervalIds[key]);
        interactIntervalIds[key] = null;
    }
}

// 物理キーコード(e.code) -> 論理操作キー変換（日本語IMEオン時も確実に動作）
const CODE_TO_LOGICAL_KEY = {
    KeyW: "w",
    KeyA: "a",
    KeyS: "s",
    KeyD: "d",
    ArrowUp: "arrowup",
    ArrowDown: "arrowdown",
    ArrowLeft: "arrowleft",
    ArrowRight: "arrowright",
    Space: " ",
    ShiftLeft: "shift",
    ShiftRight: "shift"
};

const CODE_TO_HOTBAR_SLOT = {
    Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4,
    Digit6: 5, Digit7: 6, Digit8: 7, Digit9: 8,
    Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4,
    Numpad6: 5, Numpad7: 6, Numpad8: 7, Numpad9: 8
};

// ==========================================
// 3. キーボード入力 (e.code ベース正規化)
// ==========================================
window.addEventListener('keydown', (e) => {
    if (!renderer) return;
    const code = e.code;

    // --- A. F3キー関連 (デバッグ表示・チャンク境界) ---
    if (code === "F3") {
        e.preventDefault();
        f3Pressed = true;
        return;
    }
    if (f3Pressed && code === "KeyG") {
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

    // --- B. Eキー (インベントリ開閉) ---
    if (code === "KeyE") {
        if (isPaused || mainMenu.style.display !== "none") return;
        e.preventDefault();
        e.stopImmediatePropagation();

        if (isInventoryOpen) {
            isInventoryOpen = false;
            inventoryContainer.style.display = "none";
            if (tooltip) tooltip.style.display = "none";
            if (!isPaused && renderer.domElement.requestPointerLock) {
                renderer.domElement.requestPointerLock();
            }
        } else {
            releaseAllActiveInputs();
            isInventoryOpen = true;
            inventoryContainer.style.display = "block";
            if (document.pointerLockElement && document.exitPointerLock) {
                document.exitPointerLock();
            }
            setTimeout(() => {
                if (typeof updateTooltipInstant === "function") {
                    updateTooltipInstant();
                }
            }, 10);
        }
        return;
    }

    // --- C. ESCキー (インベントリ閉じ / ポーズ遷移の単一経路化) ---
    if (code === "Escape") {
        if (isInventoryOpen) {
            isInventoryOpen = false;
            inventoryContainer.style.display = "none";
            if (tooltip) tooltip.style.display = "none";
            return;
        }
        if (mainMenu.style.display === "none" && !isPaused) {
            if (document.pointerLockElement === renderer.domElement && document.exitPointerLock) {
                // pointerlockchange 側で一元的に isPaused = true へ遷移（二重呼び出し防止）
                document.exitPointerLock();
            } else {
                isPaused = true;
                updatePauseUI();
            }
        }
        return;
    }

    // --- D. ゲームプレイ中以外は以降の操作を無効化 ---
    if (!isGameplayInputActive()) return;

    // 数字キー (1-9 / テンキー 1-9)
    if (CODE_TO_HOTBAR_SLOT[code] !== undefined) {
        selectedHotbarIndex = CODE_TO_HOTBAR_SLOT[code];
        updateHotbarSelection();
        return;
    }

    // スペースキー (ジャンプ / 飛行切替)
    if (code === "Space") {
        e.preventDefault();
        if (e.repeat) return;
        const now = performance.now();
        if (now - lastSpaceTime < doubleTapThreshold) {
            flightMode = !flightMode;
            jumpRequest = false;
        }
        lastSpaceTime = now;
        keys[" "] = true;
        return;
    }

    // Wキー (ダブルタップダッシュ判定)
    if (code === "KeyW" && !e.repeat) {
        const now = performance.now();
        if (now - lastWPressTime < doubleTapThreshold) dashActive = true;
        lastWPressTime = now;
    }

    // Shiftキー (スニーク / 飛行下降)
    if (code === "ShiftLeft" || code === "ShiftRight") {
        sneakActive = true;
        if (!flightMode) dashActive = false;
    }

    const logical = CODE_TO_LOGICAL_KEY[code];
    if (logical) {
        keys[logical] = true;
    }
});

document.addEventListener("keyup", (e) => {
    const code = e.code;
    if (code === "F3") f3Pressed = false;
    if (code === "KeyW") dashActive = false;
    if (code === "ShiftLeft" || code === "ShiftRight") sneakActive = false;

    const logical = CODE_TO_LOGICAL_KEY[code];
    if (logical) {
        keys[logical] = false;
    }
});

// ==========================================
// 4. マウス・ホイール操作
// ==========================================
window.addEventListener("wheel", (e) => {
    if (!isGameplayInputActive() || e.deltaY === 0) return;
    selectedHotbarIndex = (selectedHotbarIndex + (e.deltaY > 0 ? 1 : 8)) % 9;
    updateHotbarSelection();
}, { passive: true });

function onCanvasMouseDown(event) {
    if (!isGameplayInputActive() || document.pointerLockElement !== renderer.domElement) return;

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

// ウィンドウフォーカス喪失時に全入力・長押しタイマーを即時安全解除
window.addEventListener("blur", () => {
    releaseAllActiveInputs();
});

// ==========================================
// 5. ポインターロック管理
// ==========================================
function onMouseMove(e) {
    if (!pointerLocked || !isGameplayInputActive()) return;
    yaw -= e.movementX * mouseSensitivity;
    pitch = Math.min(Math.max(pitch - e.movementY * mouseSensitivity, -Math.PI / 2), Math.PI / 2);
}

window.addEventListener("mousemove", onMouseMove);

document.addEventListener('pointerlockchange', () => {
    pointerLocked = !!(renderer && document.pointerLockElement === renderer.domElement);

    if (pointerLocked) {
        isPaused = false;
        updatePauseUI();
    } else if (!isInventoryOpen && mainMenu && mainMenu.style.display === "none") {
        isPaused = true;
        updatePauseUI();
    }
});

const btnResume = document.getElementById("btn-resume");
if (btnResume) {
    btnResume.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        btnResume.blur();
        isPaused = false;
        updatePauseUI();

        await new Promise(resolve => setTimeout(resolve, 100));

        if (!isPaused && !isInventoryOpen && renderer && renderer.domElement) {
            renderer.domElement.requestPointerLock();
        }
    });
}

document.getElementById('btn-quit').addEventListener('click', () => {
    window.close();

    setTimeout(() => {
        if (!window.closed) {
            alert("ブラウザのセキュリティ制限により自動で閉じられませんでした。タブを直接閉じてください。");
        }
    }, 500);
});

// ==========================================
// 7. タッチUI・マルチタッチ統合管理 (二重登録・長押し無限継続・touchcancel対策済)
// ==========================================
let _touchControlsInitialized = false;

function setupTouchControls() {
    if (_touchControlsInitialized) return;
    if (typeof renderer === 'undefined' || !renderer || !renderer.domElement) {
        setTimeout(setupTouchControls, 100);
        return;
    }
    _touchControlsInitialized = true;

    const canvas = renderer.domElement;

    let lastForwardTapTime = 0;
    let lastJumpTime = 0;
    let lastSneakTime = 0;
    let sneakToggled = false;
    const TAP_THRESHOLD = 300;

    let lookTouchId = null;
    let lastTouchX = 0, lastTouchY = 0;
    let touchStartTime = 0;
    let isLongPress = false;
    let hasMovedSinceTouchStart = false;
    let longPressTimer = null;
    const TOUCH_SENSITIVITY = 0.005;

    const resetLookTouchState = () => {
        lookTouchId = null;
        isLongPress = false;
        hasMovedSinceTouchStart = false;
        if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        stopInteraction("touch");
    };

    const bindButton = (id, key, onStart, onEnd) => {
        const btn = document.getElementById(id);
        if (!btn) return;

        const start = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isGameplayInputActive()) return;
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
        btn.addEventListener("touchcancel", end, { passive: false });
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
        const onJumpStart = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!isGameplayInputActive()) return;
            const now = performance.now();
            if (now - lastJumpTime < TAP_THRESHOLD) { flightMode = !flightMode; jumpRequest = false; }
            else { if (flightMode) keys[" "] = true; else jumpRequest = true; }
            lastJumpTime = now;
        };
        const onJumpEnd = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (flightMode) keys[" "] = false;
        };
        btnJump.addEventListener("touchstart", onJumpStart, { passive: false });
        btnJump.addEventListener("touchend", onJumpEnd, { passive: false });
        btnJump.addEventListener("touchcancel", onJumpEnd, { passive: false });
    }

    const btnSneak = document.getElementById("btn-sneak");
    if (btnSneak) {
        const onSneakStart = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!isGameplayInputActive()) return;
            const now = performance.now();
            if (now - lastSneakTime < TAP_THRESHOLD) {
                sneakToggled = !sneakToggled; keys["shift"] = sneakToggled; sneakActive = sneakToggled;
            } else { keys["shift"] = true; sneakActive = true; }
            lastSneakTime = now;
        };
        const onSneakEnd = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!sneakToggled) { keys["shift"] = false; sneakActive = false; }
        };
        btnSneak.addEventListener("touchstart", onSneakStart, { passive: false });
        btnSneak.addEventListener("touchend", onSneakEnd, { passive: false });
        btnSneak.addEventListener("touchcancel", onSneakEnd, { passive: false });
    }

    // --- 2. インベントリの開閉制御 ---
    const updateInvUI = () => {
        const container = document.getElementById("inventory-container");
        if (container) container.style.display = isInventoryOpen ? "block" : "none";
        if (isInventoryOpen) {
            resetLookTouchState();
        }
    };

    const btnInvOpen = document.getElementById("btn-inventory");
    if (btnInvOpen) {
        const openInv = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (isPaused || mainMenu.style.display !== "none") return;
            isInventoryOpen = true;
            updateInvUI();
        };
        btnInvOpen.addEventListener("touchstart", openInv, { passive: false });
        btnInvOpen.addEventListener("mousedown", openInv);
    }

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

    // --- 2.5 ポーズメニューの制御 ---
    const btnPause = document.getElementById("btn-pause");
    if (btnPause) {
        const togglePause = (e) => {
            if (isInventoryOpen || mainMenu.style.display !== "none") return;
            e.preventDefault();
            e.stopPropagation();

            isPaused = !isPaused;
            updatePauseUI();

            if (isPaused) {
                resetLookTouchState();
                if (document.pointerLockElement && document.exitPointerLock) {
                    document.exitPointerLock();
                }
            }
        };

        btnPause.addEventListener("touchstart", togglePause, { passive: false });
        btnPause.addEventListener("mousedown", togglePause);
    }

    // --- 3. 視点移動 ＆ タップ設置 / 長押し破壊（単一統合） ---
    canvas.addEventListener('touchstart', (e) => {
        if (!isGameplayInputActive()) return;

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (lookTouchId === null) {
                lookTouchId = touch.identifier;
                lastTouchX = touch.clientX;
                lastTouchY = touch.clientY;
                touchStartTime = performance.now();
                isLongPress = false;
                hasMovedSinceTouchStart = false;

                longPressTimer = setTimeout(() => {
                    isLongPress = true;
                    startInteraction("destroy", "touch");
                }, 450);
                break;
            }
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        if (!isGameplayInputActive()) return;

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (touch.identifier === lookTouchId) {
                const dx = touch.clientX - lastTouchX;
                const dy = touch.clientY - lastTouchY;

                yaw -= dx * TOUCH_SENSITIVITY;
                pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch - dy * TOUCH_SENSITIVITY));

                lastTouchX = touch.clientX;
                lastTouchY = touch.clientY;

                if (!hasMovedSinceTouchStart && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
                    hasMovedSinceTouchStart = true;
                    if (!isLongPress && longPressTimer !== null) {
                        clearTimeout(longPressTimer);
                        longPressTimer = null;
                    }
                }
                break;
            }
        }
    }, { passive: false });

    const handleTouchEndOrCancel = (e, isCancel) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (touch.identifier === lookTouchId) {
                const wasLong = isLongPress;
                const moved = hasMovedSinceTouchStart;
                const duration = performance.now() - touchStartTime;
                resetLookTouchState();

                if (!isCancel && isGameplayInputActive() && !wasLong && !moved && duration < 300) {
                    interactWithBlock("place");
                }
                break;
            }
        }
    };

    canvas.addEventListener('touchend', (e) => handleTouchEndOrCancel(e, false), { passive: false });
    canvas.addEventListener('touchcancel', (e) => handleTouchEndOrCancel(e, true), { passive: false });
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
function applyBrightnessSetting(val) {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(val) ? val : 50));
    if (brightnessValLabel) brightnessValLabel.innerText = clamped;
    globalBrightnessMultiplier = clamped / 50;
    // O(1) 単一 Uniform 更新により、チャンク再構築ゼロで全ブロックへ即座に反映
    SHARED_BRIGHTNESS_UNIFORM.value = globalBrightnessMultiplier;
}

window.updateGlobalBrightnessFromUI = function () {
    const slider = document.getElementById("brightnessSlider");
    if (!slider) return;
    applyBrightnessSetting(parseInt(slider.value, 10));
};

/* ======================================================
   【5. UIイベントリスナーの設定（最適化版）】
   ====================================================== */

// 描画距離スライダー：デバウンス処理
if (rangeRenderDist) {
    rangeRenderDist.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (renderDistValLabel) renderDistValLabel.innerText = val;

        clearTimeout(renderDistanceTimeout);
        renderDistanceTimeout = setTimeout(() => {
            applyRenderDistance(val);
        }, 300);
    });
}

// 明るさスライダー（ドラッグ中にリアルタイム O(1) 反映、重い全チャンクリビルド不要）
if (brightnessSlider) {
    brightnessSlider.addEventListener('input', () => {
        applyBrightnessSetting(parseInt(brightnessSlider.value, 10));
    });
}

/* ======================================================
   【6. 設定のリセット機能】
   ====================================================== */
const resetSettings = () => {
    const DEFAULTS = {
        renderDist: 6,
        brightness: 50
    };

    if (rangeRenderDist) {
        rangeRenderDist.value = DEFAULTS.renderDist;
        applyRenderDistance(DEFAULTS.renderDist);
    }

    if (brightnessSlider) {
        brightnessSlider.value = DEFAULTS.brightness;
        applyBrightnessSetting(DEFAULTS.brightness);
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
const SAVE_FORMAT_VERSION = 2;

let _cachedDBPromise = null;

/**
 * DB接続をキャッシュ付きで取得する（接続リーク防止＆バージョン変更時の自動再接続）
 */
async function getDB() {
    if (_cachedDBPromise) return _cachedDBPromise;

    _cachedDBPromise = new Promise((resolve, reject) => {
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

        request.onsuccess = (e) => {
            const db = e.target.result;
            db.onversionchange = () => {
                db.close();
                _cachedDBPromise = null;
            };
            db.onclose = () => {
                _cachedDBPromise = null;
            };
            resolve(db);
        };

        request.onerror = () => {
            _cachedDBPromise = null;
            reject(request.error || new Error("IndexedDBのオープンに失敗しました"));
        };
    });

    return _cachedDBPromise;
}

// --- ゼロGC パレット＋RLE バイナリエンコーダ用再利用バッファ ---
const _rleValToPal = new Int32Array(65536).fill(-1);
const _rleUsedVals = new Uint16Array(4096);
const _rleScratch = new Uint16Array(TOTAL_CELLS * 2);

/**
 * チャンク Uint16Array(65536) を「文字列キーパレット配列 + Uint16Array RLE」へ高速圧縮する
 * - blocks.js のID順変更に対する耐性を100%維持（パレット内は "KEY:meta" 文字列）
 * - 容量を従来の約 500KB -> 約 6〜14KB（約 97% 削減）へ圧縮
 */
function encodeChunkPaletteRLE(dataArray) {
    const len = dataArray.length;
    const palette = [];
    let palCount = 0;
    let rlePtr = 0;

    let i = 0;
    while (i < len) {
        const val = dataArray[i];
        let palIdx = _rleValToPal[val];
        if (palIdx === -1) {
            palIdx = palCount++;
            _rleValToPal[val] = palIdx;
            if (palIdx < _rleUsedVals.length) {
                _rleUsedVals[palIdx] = val;
            }
            const id = val & 0xFFF;
            const meta = (val >> 12) & 0xF;
            palette.push(idToKey(id) + ":" + meta);
        }

        // Uint16 上限(65535)を超えない範囲で同一ブロック状態の連続長を集約
        let runLen = 1;
        while (i + runLen < len && runLen < 65535 && dataArray[i + runLen] === val) {
            runLen++;
        }

        _rleScratch[rlePtr++] = palIdx;
        _rleScratch[rlePtr++] = runLen;
        i += runLen;
    }

    // 使用済みインデックスのみ -1 に戻す（O(ユニークブロック状態数)）
    if (palCount <= _rleUsedVals.length) {
        for (let k = 0; k < palCount; k++) {
            _rleValToPal[_rleUsedVals[k]] = -1;
        }
    } else {
        _rleValToPal.fill(-1);
    }

    return {
        v: SAVE_FORMAT_VERSION,
        len,
        palette,
        rle: _rleScratch.slice(0, rlePtr)
    };
}

/**
 * DB上の現在の world_uid を読み取り、全量クリア置換か差分更新かを安全に判定する
 */
async function readStoredWorldUid(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(["world_meta"], "readonly");
        const req = tx.objectStore("world_meta").get("world_uid");
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * ワールドデータの保存（パレット＋RLEバイナリ圧縮・編集チャンク限定・差分セーブ・アトミック置換）
 */
async function saveWorldData(seed, playerPos, chunkManager, gameTime, worldUid = null, playerState = null) {
    const startTime = performance.now();
    const db = await getDB();
    const activeWorldUid = worldUid || generateWorldUid();

    // 1. DB上のワールドIDと照合し、新規ワールド（別ID）なら旧チャンクをクリアして全量保存、同一IDなら差分のみ保存
    const storedUid = await readStoredWorldUid(db);
    const isFullReplace = !isWorldSavedToDB || (storedUid !== activeWorldUid);

    const targetKeys = isFullReplace
        ? chunkManager.playerModifiedKeys
        : chunkManager.dirtySaveKeys;

    // 2. IndexedDB トランザクション開始前に CPU エンコードを全件完了（ロック時間を最小化）
    const encodedEntries = [];
    let totalBytes = 0;

    if (chunkManager && targetKeys && targetKeys.size > 0) {
        for (const key of targetKeys) {
            const dataArray = chunkManager.modifiedChunks.get(key);
            if (!dataArray) continue;

            const payload = encodeChunkPaletteRLE(dataArray);
            encodedEntries.push({ keyStr: key.toString(), payload });
            totalBytes += payload.rle.byteLength + payload.palette.length * 16;
        }
    }

    // 3. 単一 readwrite トランザクション内でメタ＋チャンクをアトミック保存
    await new Promise((resolve, reject) => {
        const tx = db.transaction(["world_meta", "chunks"], "readwrite");
        const metaStore = tx.objectStore("world_meta");
        const chunkStore = tx.objectStore("chunks");

        if (isFullReplace) {
            // 新規ワールド保存時は前ワールドの古いチャンクを同一トランザクション内で一掃
            chunkStore.clear();
        }

        metaStore.put(SAVE_FORMAT_VERSION, "save_version");
        metaStore.put(activeWorldUid, "world_uid");
        metaStore.put(seed, "last_seed");
        metaStore.put(playerPos, "player_pos");
        metaStore.put(gameTime, "game_time");
        metaStore.put(Date.now(), "saved_at");
        if (playerState) {
            metaStore.put(playerState, "player_state");
        }

        for (let i = 0; i < encodedEntries.length; i++) {
            const entry = encodedEntries[i];
            chunkStore.put(entry.payload, entry.keyStr);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IndexedDBトランザクションエラー"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDBトランザクションが中断されました"));
    });

    // 4. コミット成功確定後に差分セットをクリアし、DB同期済みフラグを立てる
    currentWorldUid = activeWorldUid;
    isWorldSavedToDB = true;
    if (chunkManager && chunkManager.dirtySaveKeys) {
        chunkManager.dirtySaveKeys.clear();
    }

    return {
        mode: isFullReplace ? "FullReplace/v2-RLE" : "IncrementalDiff/v2-RLE",
        savedChunks: encodedEntries.length,
        totalBytes,
        elapsedMs: performance.now() - startTime
    };
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
        const reqWorldUid = metaStore.get("world_uid");
        const reqPlayerState = metaStore.get("player_state");
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
                if (!Number.isFinite(chunkKey)) continue;

                const chunkData = values[i];
                if (!chunkData) continue;

                // 常に TOTAL_CELLS (65536) 要素の Uint16Array に正規化し、不完全チャンクによる描画異常を防ぐ
                const numericBlocks = new Uint16Array(TOTAL_CELLS);
                let hasValidData = false;

                // 0. v2 パレット＋RLEバイナリ圧縮形式 ({ v: 2, len, palette, rle })
                if (chunkData.v === 2 && Array.isArray(chunkData.palette) && chunkData.rle) {
                    const pal = chunkData.palette;
                    const palLen = pal.length;
                    const palPacked = new Uint16Array(palLen);
                    for (let p = 0; p < palLen; p++) {
                        const entry = String(pal[p] || "");
                        const parts = entry.split(":");
                        const id = _keyToId(parts[0]);
                        const meta = parseInt(parts[1], 10) || 0;
                        palPacked[p] = (id & 0xFFF) | ((meta & 0xF) << 12);
                    }

                    const rle = chunkData.rle;
                    const rLen = rle.length & ~1; // 偶数ペア長に安全丸め
                    let dst = 0;
                    for (let r = 0; r < rLen && dst < TOTAL_CELLS; r += 2) {
                        const palIdx = rle[r];
                        const count = rle[r + 1];
                        if (count <= 0) continue;
                        const packedVal = (palIdx >= 0 && palIdx < palLen) ? palPacked[palIdx] : 0;
                        const end = (dst + count <= TOTAL_CELLS) ? (dst + count) : TOTAL_CELLS;
                        numericBlocks.fill(packedVal, dst, end);
                        dst = end;
                    }
                    hasValidData = true;
                }
                // 1. 旧・文字列パレット形式 ({ s: "stone:0,..." })
                else if (typeof chunkData.s === "string") {
                    const blockStrings = chunkData.s.split(",");
                    const bLen = Math.min(blockStrings.length, TOTAL_CELLS);

                    for (let j = 0; j < bLen; j++) {
                        const parts = blockStrings[j].split(":");
                        const id = _keyToId(parts[0]);
                        const meta = parseInt(parts[1], 10) || 0;
                        numericBlocks[j] = (id & 0xFFF) | ((meta & 0xF) << 12);
                    }
                    hasValidData = true;
                }
                // 2. 旧・オブジェクト配列形式 ({ blocks: [{k,m}, ...] })
                else if (Array.isArray(chunkData.blocks)) {
                    const blocks = chunkData.blocks;
                    const bLen = Math.min(blocks.length, TOTAL_CELLS);

                    if (bLen > 0) {
                        const firstItem = blocks[0];
                        const isObjMode = (firstItem !== null && typeof firstItem === 'object');

                        for (let j = 0; j < bLen; j++) {
                            const item = blocks[j];
                            if (isObjMode && item) {
                                const id = _keyToId(item.k);
                                const meta = item.m ?? 0;
                                numericBlocks[j] = (id & 0xFFF) | ((meta & 0xF) << 12);
                            } else {
                                numericBlocks[j] = _keyToId(item) & 0xFFF;
                            }
                        }
                    }
                    hasValidData = true;
                }
                // 3. 旧・直接Uint16Array形式
                else if (chunkData instanceof Uint16Array) {
                    numericBlocks.set(chunkData.subarray(0, TOTAL_CELLS));
                    hasValidData = true;
                }

                if (hasValidData) {
                    chunks.set(chunkKey, numericBlocks);
                }
            }

            resolve({
                seed: reqSeed.result,
                pos: reqPos.result ?? null,
                gameTime: reqTime.result ?? 6000,
                worldUid: reqWorldUid.result ?? null,
                playerState: reqPlayerState.result ?? null,
                chunks: chunks
            });
        };

        tx.onerror = () => reject(tx.error || new Error("セーブデータの読み込みに失敗しました"));
        tx.onabort = () => reject(tx.error || new Error("セーブデータの読み込みが中断されました"));
    });
}

/* ======================================================
   【外部プラグイン・デバッグ診断用 統一ファサード】
   ====================================================== */
window.MinecraftEngine = Object.freeze({
    BLOCK_CONFIG,
    BLOCK_TYPES,
    STATE_SCHEMAS,
    registerCustomBlock,
    registerGeometryBuilder,
    registerPlacementRule,
    registerSupportRule,
    registerRandomTickHandler,
    TickScheduler,
    RedstoneEngine,
    ChunkSaveManager,
    saveCurrentWorld,
    getStats: () => ({
        seed: currentSeed,
        ticks: worldTickCount,
        gameTime: Math.floor(gameTime),
        loadedChunks: loadedChunks.size,
        editedChunks: ChunkSaveManager.playerModifiedKeys.size,
        unsavedChunks: ChunkSaveManager.dirtySaveKeys.size,
        pendingTicks: TickScheduler.pendingCount,
        drawCalls: renderer ? renderer.info.render.calls : 0,
        triangles: renderer ? renderer.info.render.triangles : 0
    })
});