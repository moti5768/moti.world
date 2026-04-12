"use strict";
import * as THREE from './build/three.module.js';
import { BLOCK_CONFIG, BLOCK_TYPES, createBlockMesh, getBlockMaterials, getBlockConfiguration, getBlockGeometry, calculatePlacementMeta, applyMetadataTransform, getLogRotationMatrix, applyRotationToCollisionBox, getCustomGeometryMatrix, idToKey, keyToId } from './blocks.js';
import { createMinecraftBreakParticles, updateBlockParticles } from './particles.js';
import { setMinecraftSky, loadCloudTexture, updateCloudGrid, updateCloudTiles, updateCloudOpacity, adjustCloudLayerDepth } from './cloudsky.js';
import { determineBiome } from './biomes/biomes.js';

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
    sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), sunMat);
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
    moonMesh = new THREE.Mesh(new THREE.PlaneGeometry(350, 350), moonMat);
    scene.add(moonMesh);
}

function updateSunMoonPosition() {
    if (!sunMesh || !moonMesh || !player) return;

    // 1. 角度と向きベクトルを計算（外部の _tmpSunDir を直接更新）
    const angle = (gameTime / TICKS_PER_DAY) * Math.PI * 2;
    _tmpSunDir.set(Math.cos(angle), Math.sin(angle), 0).normalize();

    // 2. プレイヤー位置を基準とした配置座標
    const sunX = _tmpSunDir.x * CELESTIAL_ORBIT_RADIUS;
    const sunY = _tmpSunDir.y * CELESTIAL_ORBIT_RADIUS;

    sunMesh.position.set(player.position.x + sunX, player.position.y + sunY, player.position.z);
    sunMesh.lookAt(player.position);

    moonMesh.position.set(player.position.x - sunX, player.position.y - sunY, player.position.z);
    moonMesh.lookAt(player.position);

    // 3. 表示判定
    sunMesh.visible = (sunY > -150);
    moonMesh.visible = (sunY < 150);

    // 4. 空の色の更新。計算済みの sunY と、向きベクトル(_tmpSunDir)をそのまま利用する
    // ※引数として sunDir も渡すように修正
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
}
/* ======================================================
   【新・チャンク保存管理システム (クラスなし版) - 高速最適化ver】
   ====================================================== */
// キー計算用の定数（ChunkSaveManagerの外または冒頭に配置）
const STEP_X = 1 << 16; // 32bit数値パッキングに合わせたステップ数
const STEP_Z = 1;

export const ChunkSaveManager = {
    modifiedChunks: new Map(),
    chunkUpdateInfo: new Map(),

    // 基本のインデックス計算（維持：Yが一番下の桁）
    getBlockIndex: function (lx, ly, lz) {
        return ((ly | 0) + ((lz | 0) << 8) + ((lx | 0) << 12)) >>> 0;
    },

    /**
     * 指定した座標のブロックを書き換え、自分と隣接チャンクに更新フラグを立てる（最適化版）
     */
    setBlock: function (cx, cz, lx, ly, lz, blockType) {
        if (ly < 0 || ly >= CHUNK_HEIGHT) return;

        // 1. キー計算の最適化（一回だけ生成 / インライン化検討可だが可読性維持）
        const key = encodeChunkKey(cx, cz);
        let dataArray = this.modifiedChunks.get(key);

        if (!dataArray) {
            dataArray = this.captureBaseChunkData(cx, cz);
            this.modifiedChunks.set(key, dataArray);
        }

        // 2. インデックス計算（ご提示の式を維持）
        const idx = ((ly | 0) + ((lz | 0) << 8) + ((lx | 0) << 12)) >>> 0;
        dataArray[idx] = blockType;

        // 3. 更新メタ情報の記録（自分自身）
        this._markByKey(key, ly);

        // 4. 境界チェック：BigInt()を再計算せずビット加減算で隣接キーを特定
        if (lx === 0) this._markByKey(key - STEP_X, ly);
        else if (lx === 15) this._markByKey(key + STEP_X, ly);

        if (lz === 0) this._markByKey(key - STEP_Z, ly);
        else if (lz === 15) this._markByKey(key + STEP_Z, ly);
    },

    /**
     * 内部用：キーを直接受け取って更新情報を記録（GC対策版）
     */
    _markByKey: function (key, ly) {
        let info = this.chunkUpdateInfo.get(key);
        if (info === undefined) {
            this.chunkUpdateInfo.set(key, {
                maxModifiedY: ly,
                minModifiedY: ly,
                needsRebuild: true
            });
        } else {
            // オブジェクトを新規作成せず中身を更新（重要）
            if (ly > info.maxModifiedY) info.maxModifiedY = ly;
            else if (ly < info.minModifiedY) info.minModifiedY = ly;
            info.needsRebuild = true;
        }
    },

    // 既存互換用
    _markChunkForUpdate: function (cx, cz, ly) {
        this._markByKey(encodeChunkKey(cx, cz), ly);
    },

    /**
     * ブロックの取得（高速版）
     */
    getBlock: function (cx, cz, lx, ly, lz) {
        if (ly < 0 || ly >= CHUNK_HEIGHT) return null;
        const dataArray = this.modifiedChunks.get(encodeChunkKey(cx, cz));
        if (!dataArray) return null;

        const idx = ((ly | 0) + ((lz | 0) << 8) + ((lx | 0) << 12)) >>> 0;
        return dataArray[idx];
    },

    /**
     * 地形生成のコアロジック（Minecraft生成パイプライン準拠・軽量化版）
     */
    // 💡 改善: メモリのゴミを出さないように共有バッファを外に定義
    _sharedHeightMap: new Int32Array(256),
    _sharedBiomeMap: new Array(256),

    captureBaseChunkData: function (cx, cz) {
        // 1. チャンク割当・初期化
        const data = new Uint16Array(65536); // 16x16x256
        const baseX = (cx << 4) | 0;
        const baseZ = (cz << 4) | 0;

        const { SKY, STONE, DIRT, GRASS, WATER, LAVA, BEDROCK } = BLOCK_TYPES;
        const seaLevel = SEA_LEVEL | 0;

        // 💡 改善: 毎回 new せず、共有バッファへの参照を渡す
        const heightMap = this._sharedHeightMap;
        const biomeMap = this._sharedBiomeMap;

        // ------------------------------------------------------
        // 4. バイオーム割当 (順序を入れ替え、地形生成の基礎とする)
        // ------------------------------------------------------
        for (let x = 0; x < 16; x++) {
            const worldX = (baseX + x) | 0;
            for (let z = 0; z < 16; z++) {
                const worldZ = (baseZ + z) | 0;

                // バイオーム決定用の大きなスケールのノイズ
                // 0.0005 程度のスケールにすることで、バイオームが数千ブロック単位で広がる
                const temp = fractalNoise2D(worldX * 0.0005, worldZ * 0.0005, 3) + 0.5;
                const humidity = fractalNoise2D(worldX * 0.0005 + 500, worldZ * 0.0005 + 500, 3) + 0.5;

                // biomes.js からバイオーム設定を取得
                const biome = determineBiome(temp, humidity);
                biomeMap[(x << 4) | z] = biome;
            }
        }

        // ------------------------------------------------------
        // 3. 地形（高さマップ）生成 (Base Terrain)
        // ------------------------------------------------------
        for (let x = 0; x < 16; x++) {
            const worldX = (baseX + x) | 0;
            const xOff = (x << 12) | 0;

            for (let z = 0; z < 16; z++) {
                const worldZ = (baseZ + z) | 0;
                const zOff = (z << 8) | 0;
                const idxBase = (xOff + zOff) | 0;
                const biome = biomeMap[(x << 4) | z];

                // バイオーム固有のパラメータ（noiseScale, baseHeight, heightVariation）を使用
                const hNoise = fractalNoise2D(worldX * biome.noiseScale, worldZ * biome.noiseScale, 5);
                const sHeight = Math.floor(biome.baseHeight + (hNoise * biome.heightVariation));

                heightMap[(x << 4) | z] = sHeight;

                // 岩盤層
                data[idxBase] = BEDROCK;

                // 地殻層（基本はすべて石で埋める）
                for (let y = 1; y < sHeight; y++) {
                    data[idxBase + y] = STONE;
                }

                // 海洋層
                for (let y = sHeight; y <= seaLevel; y++) {
                    data[idxBase + y] = WATER;
                }
            }
        }

        // ------------------------------------------------------
        // 5. カーバー処理（洞窟・渓谷） (Carvers)
        // ------------------------------------------------------
        const scaleXZ = CAVE_SCALE_XZ;
        const scaleY = CAVE_SCALE_Y;

        for (let x = 0; x < 16; x++) {
            const worldX = (baseX + x) | 0;
            const nx = worldX * scaleXZ;
            const xOff = (x << 12) | 0;

            for (let z = 0; z < 16; z++) {
                const worldZ = (baseZ + z) | 0;
                const nz = worldZ * scaleXZ;
                const zOff = (z << 8) | 0;
                const idxBase = (xOff + zOff) | 0;
                const sHeight = heightMap[(x << 4) | z];

                for (let y = 5; y < sHeight; y++) {
                    if (isCave(worldX, y, worldZ, sHeight, nx, y * scaleY, nz)) {
                        // 溶岩湖の高さ(11)以下なら溶岩、それ以外は空気
                        data[idxBase + y] = (y <= 11) ? LAVA : SKY;
                    }
                }
            }
        }

        // ------------------------------------------------------
        // 6. 表面ビルダー（表土配置） (Surface Builder)
        // ------------------------------------------------------
        for (let x = 0; x < 16; x++) {
            const xOff = (x << 12) | 0;
            for (let z = 0; z < 16; z++) {
                const zOff = (z << 8) | 0;
                const idxBase = (xOff + zOff) | 0;

                const sHeight = heightMap[(x << 4) | z];
                const biome = biomeMap[(x << 4) | z];
                if (sHeight <= 1) continue;

                const dirtBoundary = (sHeight - 4) | 0;
                const stoneEnd = dirtBoundary > 1 ? dirtBoundary : 1;
                const dirtEnd = (sHeight - 1) | 0;

                // 中層（バイオーム固有の fillerBlock）
                for (let y = stoneEnd; y < dirtEnd; y++) {
                    if (data[idxBase + y] === STONE) {
                        data[idxBase + y] = biome.fillerBlock;
                    }
                }

                // 最表層（バイオーム固有の topBlock）
                const topY = sHeight - 1;
                if (data[idxBase + topY] === STONE) {
                    // 水中の場合はバイオーム設定に関わらず DIRT または砂にする等も可能ですが、
                    // ここではバイオーム設定を優先します。
                    data[idxBase + topY] = (topY < seaLevel) ? biome.fillerBlock : biome.topBlock;
                }
            }
        }

        // 7. 構造物配置 (Structures) - 未実装
        // 8. デコレーション配置 (Features / Decorators) - 未実装
        // 9. エンティティ・最終調整

        return data;
    },

    clearUpdateFlag: function (cx, cz) {
        const key = encodeChunkKey(cx, cz);
        const info = this.chunkUpdateInfo.get(key);
        if (info) info.needsRebuild = false;
    }
};

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

export const globalTerrainCache = new Map();
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

/**
 * プレイヤーの衝突判定用AABBを取得する
 * @param {THREE.Vector3} pos - 計算基準となる座標（省略時は現在のプレイヤー位置）
 * @param {Object|null} size - {h, r} 形式のサイズ指定（ループ最適化用）
 * @returns {THREE.Box3} 計算済みのAABB（※内部で再利用されるため、保持する場合は .clone() 推奨）
 */
function getPlayerAABB(pos = player.position, size = null) {
    // 💡 改善：sizeが渡されていれば再計算しない
    const h = size ? size.h : getCurrentPlayerHeight();
    const r = size ? size.r : (PLAYER_RADIUS - COLLISION_MARGIN);

    // 💡 改善：足元のY座標計算を共通化
    const feetY = player.positionIsCenter ? pos.y - (h * 0.5) : pos.y;

    // 💡 改善：Box3のプロパティを直接セット（中間変数を経由しない）
    _tempAABB.min.set(pos.x - r, feetY, pos.z - r);
    _tempAABB.max.set(pos.x + r, feetY + h, pos.z + r);

    return _tempAABB;
}

function getPlayerAABBAt(pos) {
    return getPlayerAABB(pos);
}

/* ======================================================
   【衝突判定キャッシュ＆プールシステム】
   ====================================================== */

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
   【超軽量化】AABB衝突判定システム (Garbage Collection ゼロ化)
   ====================================================== */

/**
 * AABB衝突判定（回転・上下反転メタデータ完全対応版）
 * @param {THREE.Box3} aabb - 判定対象のAABB
 * @param {THREE.Vector3} [velocity] - 移動ベクトル（動的判定時）
 * @param {number} [dt] - デルタタイム
 * @returns {Object|boolean} 動的判定時は結果オブジェクト、静的判定時は真偽値
 */
function checkAABBCollision(aabb, velocity, dt) {
    const isDynamic = velocity !== undefined && dt !== undefined;

    let result = false;
    if (isDynamic) {
        result = _SHARED_AABB_RESULT;
        result.collision = false;
        result.time = dt;
        result.normal.set(0, 0, 0);
    }

    // 判定範囲の算出
    const minX = Math.floor(aabb.min.x - 0.1);
    const maxX = Math.floor(aabb.max.x + 0.1);
    const minY = Math.floor(aabb.min.y - 1.1);
    const maxY = Math.floor(aabb.max.y + 0.1);
    const minZ = Math.floor(aabb.min.z - 0.1);
    const maxZ = Math.floor(aabb.max.z + 0.1);

    const rotatedRelBox = getPooledBox();

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            for (let z = minZ; z <= maxZ; z++) {

                const rawVoxel = getVoxelAtWorld(x, y, z, globalTerrainCache, true);
                if (!rawVoxel || rawVoxel === BLOCK_TYPES.SKY || rawVoxel === BLOCK_TYPES.WATER) {
                    continue;
                }

                const id = rawVoxel & 0xFFF;
                // 💡 3ビット目（値4）の上下反転フラグも含めて抽出 (0xF = 1111)
                const metadata = (rawVoxel >> 12) & 0xF;

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

                    // 1. メタデータ（回転・反転）を適用
                    applyRotationToCollisionBox(rel, metadata, rotatedRelBox);

                    // 2. ワールド座標のAABBを作成
                    const wb = getPooledBox();
                    wb.min.set(rotatedRelBox.min.x + x, rotatedRelBox.min.y + y, rotatedRelBox.min.z + z);
                    wb.max.set(rotatedRelBox.max.x + x, rotatedRelBox.max.y + y, rotatedRelBox.max.z + z);

                    if (isDynamic) {
                        const r = sweptAABB(aabb, velocity, dt, wb);
                        if (r.collision && r.time < result.time) {
                            result.collision = true;
                            result.time = r.time;
                            result.normal.copy(r.normal);
                        }

                        // 衝突時間が極小（食い込んでいる）場合は即座に終了
                        if (r.time < 1e-5) {
                            releasePooledBox(wb);
                            releasePooledBox(rotatedRelBox);
                            return result;
                        }
                    } else if (aabb.intersectsBox(wb)) {
                        releasePooledBox(wb);
                        releasePooledBox(rotatedRelBox);
                        return true;
                    }

                    releasePooledBox(wb);
                }
            }
        }
    }

    releasePooledBox(rotatedRelBox);
    return result;
}

/* ======================================================
   【地形生成】（フラクタルノイズ＋ユーザー変更反映・最適化・強化版）
   ====================================================== */
/**
 * 💡 リファクタリング：純粋な地形生成（ノイズ）専用関数
 * キーの衝突対策と、スパイク防止のキャッシュ管理を導入。
 */
function getTerrainHeight(worldX, worldZ) {
    const xInt = worldX | 0;
    const zInt = worldZ | 0;

    // 💡 修正：XOR(^)ではなく、ビットシフトと論理和(|)で正確な32bitキーを作成
    // これにより座標の重複（ハッシュ衝突）がなくなります
    const key = ((xInt & 0xFFFF) << 16) | (zInt & 0xFFFF);

    const cachedHeight = terrainHeightCache.get(key);
    if (cachedHeight !== undefined) return cachedHeight;

    // ノイズ計算（4オクターブ）
    const noise = fractalNoise2D(xInt * NOISE_SCALE, zInt * NOISE_SCALE, 4, 0.5);

    let heightModifier = noise * 35;
    // 高地の急峻な地形を作るロジック
    if (noise > 0.2) {
        const diff = noise - 0.2;
        heightModifier += (diff * diff) * 60;
    }

    const result = (BASE_HEIGHT + heightModifier) | 0;

    // 💡 修正：キャッシュがいっぱいになった時、全部消すのではなく古いものを少し消す
    // これにより、移動中の瞬間的なカクつき（スパイク）を抑えます
    if (terrainHeightCache.size >= MAX_CACHE_SIZE) {
        const iter = terrainHeightCache.keys();
        for (let i = 0; i < 1000; i++) {
            terrainHeightCache.delete(iter.next().value);
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

const chunkReadOnlyCache = new Map();
// --- 関数の外側に配置 (キャッシュ用) ---
let _vC0_key = -1, _vC0_data = null;
let _vC1_key = -1, _vC1_data = null;

export function getVoxelAtWorld(x, y, z, terrainCache = globalTerrainCache, isRaw = false) {
    const fy = y | 0;
    if (fy < 0 || fy >= CHUNK_HEIGHT) return 0;

    const fx = x | 0;
    const fz = z | 0;
    const cx = fx >> 4;
    const cz = fz >> 4;

    // 💡 1. encodeChunkKey の結果を一度だけ変数に入れる (BigInt計算コスト削減)
    const chunkKey = encodeChunkKey(cx, cz);
    let data = null;

    // 💡 2. 【劇的高速化】Map.get を呼ぶ前に、直近2つのチャンクをチェック
    // チャンク境界での往復（自分と隣）が発生しても、これでMapアクセスを99%回避できます
    if (chunkKey === _vC0_key) {
        data = _vC0_data;
    } else if (chunkKey === _vC1_key) {
        data = _vC1_data;
    } else {
        // --- キャッシュにない場合のみ、元のMap探索を実行 ---
        data = ChunkSaveManager.modifiedChunks.get(chunkKey) || chunkReadOnlyCache.get(chunkKey);

        if (!data) {
            data = ChunkSaveManager.captureBaseChunkData(cx, cz);
            chunkReadOnlyCache.set(chunkKey, data);
            if (chunkReadOnlyCache.size > MAX_CACHE_SIZE) {
                const firstKey = chunkReadOnlyCache.keys().next().value;
                chunkReadOnlyCache.delete(firstKey);
            }
        }

        // 💡 3. 今回取得したデータを「古い方のスロット」に押し込む (2世代キャッシュ)
        if (data) {
            _vC1_key = _vC0_key;
            _vC1_data = _vC0_data;
            _vC0_key = chunkKey;
            _vC0_data = data;
        }
    }

    // --- 4. 値の抽出ロジック (ここは元のまま) ---
    if (!data) return 0;

    const lx = fx & 15;
    const lz = fz & 15;
    const idx = (fy + (lz << 8) + (lx << 12)) >>> 0;

    // インデックスが範囲外になることは基本ないが、念のため安全に取得
    const val = data[idx] ?? 0;

    if (isRaw) return val;

    const blockId = val & 0xFFF;
    const cfg = _blockConfigFastArray[blockId];
    return (cfg && cfg.collision !== false) ? val : 0;
}

const CAVE_SCALE_XZ = 0.02;   // 少し小さくして、より大きなうねりに
const CAVE_SCALE_Y = 0.025;   // 垂直方向もゆったりさせる
const CAVE_THRESHOLD = 0.08;  // この値を大きくすると洞窟が太くなります

// 定数としてあらかじめ計算しておく
const OFFSET1_X = 1234 * CAVE_SCALE_XZ;
const OFFSET1_Y = 5678 * CAVE_SCALE_Y;
const OFFSET1_Z = 9101 * CAVE_SCALE_XZ;

function isCave(x, y, z, surfaceHeight, nx, ny, nz) {
    // 地表のすぐ下（薄皮状態）や地上には洞窟を作らない
    if (y > surfaceHeight - 1) return false;

    // 地表からの深さに応じて閾値を絞り、出口付近を細くする（不自然な穴あき防止）
    const depth = surfaceHeight - y;
    let currentThreshold = CAVE_THRESHOLD; // 基本値: 0.08 程度
    if (depth < 5) {
        // 深さ 0〜4 の範囲で徐々に閾値を小さくする
        currentThreshold *= (depth * 0.16 + 0.6);
    }

    // 1つ目のノイズ計算
    const n1 = perlinNoise3D(nx, ny, nz);
    const absN1 = Math.abs(n1);

    // 早期リターン：1つ目のノイズだけで閾値を超えていれば、2つ目は計算しない
    // これにより 3Dノイズの計算負荷を大幅に軽減
    if (absN1 >= currentThreshold) return false;

    // 2つ目のノイズ計算（オフセットを加えて交差させる：Worm Cave 手法）
    // OFFSET1_X などの定数はあらかじめ計算済みのものを使用
    const n2 = perlinNoise3D(nx + OFFSET1_X, ny + OFFSET1_Y, nz + OFFSET1_Z);

    // 2つのノイズの絶対値の合計が閾値未満なら「洞窟」と判定
    return (absN1 + Math.abs(n2)) < currentThreshold;
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
        const id = getVoxelAtWorld(bx, by, bz, globalTerrainCache, true);

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

        // --- 飛行モード中の上方向衝突は押し戻さない ---
        if (flightMode && vel.y > 0) {
            vel.y = 0;
        }

        // // --- 通常モードの天井衝突 ---
        // else if (vel.y > 0) {
        //     y = orig.y - 0.02;
        //     vel.y = -0.05;
        // }

        // --- 地面に着地した場合 ---
        else {
            if (wasUnderwater) {
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
                const voxel = getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });
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

    // 🌟 ハシゴの判定
    const onLadder = isOnLadder();

    if (onLadder) {
        // ハシゴに触れている時の処理
        player.velocity.y = 0; // デフォルトで重力を相殺（静止）

        if (keys["w"] || keys["arrowup"] || keys[" "]) {
            player.velocity.y = 0.05;  // 上る
        } else if (keys["s"] || keys["arrowdown"]) {
            player.velocity.y = -0.05; // 下る
        } else if (sneakActive) {
            player.velocity.y = 0;    // スニーク中は位置を固定（マイクラ仕様）
        } else {
            player.velocity.y = -0.05; // 離すとゆっくり滑り落ちる
        }

        // ハシゴ中は通常のジャンプリクエストを無効化
        jumpRequest = false;

    } else if (!flightMode) {
        // 通常時の重力計算
        if (player.velocity.y >= 0) {
            player.velocity.y -= UP_DECEL;
        } else {
            player.velocity.y -= DOWN_ACCEL;
            if (player.velocity.y < MAX_FALL_SPEED) {
                player.velocity.y = MAX_FALL_SPEED;
            }
        }
    }

    // 💡 ジャンプのクールダウン
    if (jumpCooldown > 0) {
        jumpCooldown--;
    }

    // 💡 条件に「!onLadder」を追加（ハシゴ中以外でジャンプ可能）
    if (jumpRequest && player.onGround && !flightMode && !wasUnderwater && jumpCooldown === 0 && !onLadder) {
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
function fadeInMesh(object, duration = 500, onComplete) {
    if (object.userData.fadedIn) return onComplete?.();

    const materials = [];
    object.traverse(o => {
        if (!o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (let i = 0; i < mats.length; i++) {
            const mat = mats[i];
            if (!mat) continue;

            const uData = mat.userData || {};
            const originalTransparent = mat.transparent;
            const originalDepthWrite = mat.depthWrite;
            const targetOpacity = uData.realOpacity !== undefined ? uData.realOpacity : 1.0;
            const isWater = !!uData.isWater;
            const isAlphaCutout = !!uData.isAlphaCutout;

            // 完了時に戻すべき値を計算しておく
            const finalTransparent = uData.realTransparent !== undefined ? uData.realTransparent : originalTransparent;
            const finalDepthWrite = uData.realDepthWrite !== undefined ? uData.realDepthWrite : originalDepthWrite;

            materials.push({
                mat, targetOpacity, isWater, isAlphaCutout,
                finalTransparent, finalDepthWrite
            });

            mat.opacity = 0;
            mat.transparent = true;
            mat.depthWrite = false;
            mat.needsUpdate = true;
        }
    });

    // 💡 完了処理を共通関数化
    const finalize = () => {
        for (let i = 0; i < materials.length; i++) {
            const m = materials[i];
            m.mat.opacity = m.targetOpacity;
            m.mat.transparent = m.finalTransparent;
            m.mat.depthWrite = m.finalDepthWrite;
            if (m.isAlphaCutout) m.mat.alphaTest = 0.5;
            m.mat.needsUpdate = true;
        }
        object.userData.fadedIn = true;
        onComplete?.();
    };

    if (materials.length === 0 || (typeof CHUNK_VISIBLE_DISTANCE !== "undefined" && CHUNK_VISIBLE_DISTANCE === 0)) {
        finalize();
        return;
    }

    const start = performance.now();
    const invDuration = 1 / duration; // 割り算を事前に1回だけ行う

    (function animate() {
        const now = performance.now();
        const elapsed = now - start;
        const t = elapsed * invDuration; // 掛け算にすることで高速化

        if (t < 1) {
            // ループ内で使用する変数をローカルに展開して高速化
            for (let i = 0, len = materials.length; i < len; i++) {
                const m = materials[i];
                // 三項演算子の評価を最小限にし、プロパティアクセスを減らす
                m.mat.opacity = m.isWater ? (t * m.targetOpacity) : t;
            }
            requestAnimationFrame(animate);
        } else {
            finalize();
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
// 💡 ファイルスコープで1度だけ作成して使い回す（GCを発生させない）
const _SHARED_ZERO_NORMAL = new Float32Array([0, 0, 0]);
const _SHARED_ZERO_UV = new Float32Array([0, 0]);
const _SHARED_ZERO_COLOR = new Float32Array([1, 1, 1]);

/**
 * 複数の BufferGeometry をマージして１つのジオメトリを生成する（マテリアルグループ対応）
 * パフォーマンス重視、属性構成は最初のジオメトリに準拠
 */
function mergeBufferGeometries(geometries, { computeNormals = true } = {}) {
    if (!geometries || geometries.length === 0) return null;
    if (geometries.length === 1) return geometries[0];

    const first = geometries[0];
    const hasNormal = first.hasAttribute && first.hasAttribute('normal');
    const hasUV = first.hasAttribute && first.hasAttribute('uv');
    const hasColor = first.hasAttribute && first.hasAttribute('color');

    // 1. 合計頂点数／インデックス数を一括算出
    let vertexCount = 0;
    let indexCount = 0;
    for (let i = 0; i < geometries.length; i++) {
        const g = geometries[i];
        const p = g.getAttribute && g.getAttribute('position');
        if (!p) continue;
        vertexCount += p.count;
        indexCount += g.index ? g.index.count : p.count;
    }

    if (vertexCount === 0) return null;

    // 2. インデックス配列型の選択とバッファ確保
    const IndexArray = (vertexCount > 65535 || indexCount > 65535) ? Uint32Array : Uint16Array;

    const posArray = new Float32Array(vertexCount * 3);
    const normArray = hasNormal ? new Float32Array(vertexCount * 3) : null;
    const uvArray = hasUV ? new Float32Array(vertexCount * 2) : null;
    const colorArray = hasColor ? new Float32Array(vertexCount * 3) : null;
    const indexArray = new IndexArray(indexCount);

    const zeroNormal = hasNormal ? _SHARED_ZERO_NORMAL : null;
    const zeroUV = hasUV ? _SHARED_ZERO_UV : null;
    const zeroColor = hasColor ? _SHARED_ZERO_COLOR : null;

    let posOff = 0, normOff = 0, uvOff = 0, colorOff = 0, idxOff = 0, vertOff = 0;
    const groups = [];

    // helper: 既存ロジックを維持
    const fillArray = (dest, srcAttr, offset, count, stride, zeroArr) => {
        if (!dest) return offset;
        if (srcAttr && srcAttr.array) {
            dest.set(srcAttr.array, offset);
            return offset + srcAttr.array.length;
        }
        const totalLen = count * stride;
        for (let i = 0; i < totalLen; i += stride) {
            dest.set(zeroArr, offset + i);
        }
        return offset + totalLen;
    };

    // 3. データの流し込み
    for (let i = 0; i < geometries.length; i++) {
        const g = geometries[i];
        const p = g.getAttribute('position');
        if (!p) continue;

        const count = p.count;
        const n = hasNormal ? g.getAttribute('normal') : null;
        const uv = hasUV ? g.getAttribute('uv') : null;
        const c = hasColor ? g.getAttribute('color') : null;

        // Position コピー
        posArray.set(p.array, posOff);
        posOff += p.array.length;

        // 他属性の補完コピー
        if (hasNormal) normOff = fillArray(normArray, n, normOff, count, 3, zeroNormal);
        if (hasUV) uvOff = fillArray(uvArray, uv, uvOff, count, 2, zeroUV);
        if (hasColor) colorOff = fillArray(colorArray, c, colorOff, count, 3, zeroColor);

        // Index の計算とコピー
        const idx = g.index ? g.index.array : null;
        const startIdxOff = idxOff;
        if (idx) {
            for (let j = 0; j < idx.length; j++) {
                indexArray[idxOff++] = idx[j] + vertOff;
            }
        } else {
            for (let j = 0; j < count; j++) {
                indexArray[idxOff++] = vertOff + j;
            }
        }

        // マテリアルグループの継承
        const gIdxCount = idx ? idx.length : count;
        if (g.groups && g.groups.length > 0) {
            for (let j = 0; j < g.groups.length; j++) {
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

    // 4. ジオメトリの構築
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    if (hasNormal) merged.setAttribute('normal', new THREE.BufferAttribute(normArray, 3));
    if (hasUV) merged.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
    if (hasColor) merged.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));
    merged.setIndex(new THREE.BufferAttribute(indexArray, 1));

    for (let i = 0; i < groups.length; i++) {
        merged.addGroup(groups[i].start, groups[i].count, groups[i].materialIndex);
    }

    if (computeNormals && !hasNormal) merged.computeVertexNormals();
    return merged;
}
// ---------------------------------------------------------------------------
// getCachedFaceGeometry: faceKey に対応するクワッドジオメトリをキャッシュして返す
// ---------------------------------------------------------------------------
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
    function get(x, y, z) {
        if (y < 0 || y >= CH_H) return BLOCK_TYPES.SKY;
        if (x >= 0 && x < CH_S && z >= 0 && z < CH_S) {
            return voxelData[y + (z * STRIDE_Z) + (x * STRIDE_X)] & 0xFFF;
        }
        if (x >= CH_S && neighborData.px) return neighborData.px[y + (z * STRIDE_Z) + (0 * STRIDE_X)] & 0xFFF;
        if (x < 0 && neighborData.nx) return neighborData.nx[y + (z * STRIDE_Z) + (15 * STRIDE_X)] & 0xFFF;
        if (z >= CH_S && neighborData.pz) return neighborData.pz[y + (0 * STRIDE_Z) + (x * STRIDE_X)] & 0xFFF;
        if (z < 0 && neighborData.nz) return neighborData.nz[y + (15 * STRIDE_Z) + (x * STRIDE_X)] & 0xFFF;
        return getVoxelAtWorld(baseX + x, BEDROCK_LEVEL + y, baseZ + z, globalTerrainCache, { raw: true }) & 0xFFF;
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
        return currentSkyLight;
    }

    function getVisMask(x, y, z, type, index) {
        const cached = _globalVisCache[index];
        if (cached !== 0) return cached;

        const myTrans = _isTransparentBlock[type];
        const myCustom = _isCustomGeometryBlock[type];
        let mask = 0;

        // 隣接ブロックを取得して判定する一連の処理をインライン化
        // 判定条件: 隣接が空気/空か、異なる透明ブロックか、非カスタムから見たカスタムか

        // PX (+X)
        const ntPX = (x < CH_S - 1) ? (voxelData[index + STRIDE_X] & 0xFFF) : get(x + 1, y, z);
        if (ntPX === 0 || ntPX === SKY || (_isTransparentBlock[ntPX] && (!myTrans || ntPX !== type)) || (_isCustomGeometryBlock[ntPX] && !myCustom)) mask |= 1;

        // NX (-X)
        const ntNX = (x > 0) ? (voxelData[index - STRIDE_X] & 0xFFF) : get(x - 1, y, z);
        if (ntNX === 0 || ntNX === SKY || (_isTransparentBlock[ntNX] && (!myTrans || ntNX !== type)) || (_isCustomGeometryBlock[ntNX] && !myCustom)) mask |= 2;

        // PY (+Y)
        const ntPY = (y < CH_H - 1) ? (voxelData[index + 1] & 0xFFF) : get(x, y + 1, z);
        if (ntPY === 0 || ntPY === SKY || (_isTransparentBlock[ntPY] && (!myTrans || ntPY !== type)) || (_isCustomGeometryBlock[ntPY] && !myCustom)) mask |= 4;

        // NY (-Y)
        const ntNY = (y > 0) ? (voxelData[index - 1] & 0xFFF) : get(x, y - 1, z);
        if (ntNY === 0 || ntNY === SKY || (_isTransparentBlock[ntNY] && (!myTrans || ntNY !== type)) || (_isCustomGeometryBlock[ntNY] && !myCustom)) mask |= 8;

        // PZ (+Z)
        const ntPZ = (z < CH_S - 1) ? (voxelData[index + STRIDE_Z] & 0xFFF) : get(x, y, z + 1);
        if (ntPZ === 0 || ntPZ === SKY || (_isTransparentBlock[ntPZ] && (!myTrans || ntPZ !== type)) || (_isCustomGeometryBlock[ntPZ] && !myCustom)) mask |= 16;

        // NZ (-Z)
        const ntNZ = (z > 0) ? (voxelData[index - STRIDE_Z] & 0xFFF) : get(x, y, z - 1);
        if (ntNZ === 0 || ntNZ === SKY || (_isTransparentBlock[ntNZ] && (!myTrans || ntNZ !== type)) || (_isCustomGeometryBlock[ntNZ] && !myCustom)) mask |= 32;

        _globalVisCache[index] = mask;
        return mask;
    }

    let hasAnySolidBlock = false;
    let effectiveMaxY = voxelData.maxY !== undefined ? voxelData.maxY : CHUNK_HEIGHT - 1;
    const maxIndex = (effectiveMaxY + 2) * STRIDE_Z * STRIDE_X;
    _globalVisCache.fill(0, 0, Math.min(maxIndex, _globalVisCache.length));
    const customGeomCache = new Map(), customGeomBatches = new Map(), faceGeoms = new Map();

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

                // A. カスタムジオメトリ
                if (_isCustomGeometryBlock[type]) {
                    if (!customGeomCache.has(type)) {
                        const m = createCustomBlockMesh(type, _sharedVec3Zero, null);
                        if (m) customGeomCache.set(type, m.geometry);
                    }
                    const template = customGeomCache.get(type);
                    if (!template || (!visMask && cfg.cullAdjacentFaces !== false)) continue;

                    let batchArray = customGeomBatches.get(type);
                    if (batchArray === undefined) {
                        batchArray = [];
                        customGeomBatches.set(type, batchArray);
                    }

                    for (let g = 0; g < template.groups.length; g++) {
                        const group = template.groups[g];
                        const dir = detectFaceDirection(template, group);
                        const isLadder = cfg.isLadder;

                        if (!isLadder && cfg.cullAdjacentFaces !== false && ((visMask >> dir) & 1) === 0) continue;

                        const subGeo = new THREE.BufferGeometry();
                        extractGroupGeometry(template, group, subGeo);
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
                        batchArray.push(subGeo);
                    }
                    continue;
                }

                // B. 通常の不透明ブロック
                if (visMask && !useInstancing) {
                    const isRotated = !!cfg.isLog;

                    if (isRotated) {
                        _m1.copy(getLogRotationMatrix(meta));
                        _r1.extractRotation(_m1);
                    }

                    if (!faceGeoms.has(type)) faceGeoms.set(type, new Map());
                    const matMap = faceGeoms.get(type);

                    for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
                        let wBit = faceIdx;
                        let wNX, wNY, wNZ, fw;

                        const offset = faceIdx * 12; // 🚀 平坦化配列用のオフセット計算

                        if (isRotated) {
                            // 回転あり：法線を回転させてから可視判定
                            _n1.set(CUBE_NORMALS[offset], CUBE_NORMALS[offset + 1], CUBE_NORMALS[offset + 2]);
                            _n1.applyMatrix4(_r1);

                            wNX = Math.round(_n1.x);
                            wNY = Math.round(_n1.y);
                            wNZ = Math.round(_n1.z);
                            wBit = (wNX > 0) ? 0 : (wNX < 0) ? 1 : (wNY > 0) ? 2 : (wNY < 0) ? 3 : (wNZ > 0) ? 4 : 5;

                            if (!((visMask >> wBit) & 1)) continue;
                            fw = (wNY > 0) ? 1.0 : (wNY < 0) ? 0.5 : (Math.abs(wNX) > 0) ? 0.8 : 0.65;
                        } else {
                            // 🚀 回転なし：最速パス
                            if (!((visMask >> faceIdx) & 1)) continue;
                            wNX = CUBE_NORMALS[offset];
                            wNY = CUBE_NORMALS[offset + 1];
                            wNZ = CUBE_NORMALS[offset + 2];
                            fw = FACE_FW[faceIdx];
                        }

                        // バッチ配列の取得をここで一度だけ行う
                        if (!matMap.has(faceIdx)) matMap.set(faceIdx, { positions: [], colors: [], normals: [] });
                        const batch = matMap.get(faceIdx);
                        const bPos = batch.positions; // 参照をキャッシュ
                        const bNorm = batch.normals;
                        const bCol = batch.colors;

                        if (isRotated) {
                            for (let j = 0; j < 12; j += 3) {
                                const oj = offset + j;
                                _v1.set(CUBE_VERTICES[oj], CUBE_VERTICES[oj + 1], CUBE_VERTICES[oj + 2]).applyMatrix4(_m1);
                                _n1.set(CUBE_NORMALS[oj], CUBE_NORMALS[oj + 1], CUBE_NORMALS[oj + 2]).applyMatrix4(_r1);
                                bPos.push(_v1.x + wx);
                                bPos.push(_v1.y + wy);
                                bPos.push(_v1.z + wz);
                                bNorm.push(_n1.x, _n1.y, _n1.z);
                            }
                        } else {
                            // 🚀 回転なし：メモリコピーに等しい速度でPush
                            for (let j = 0; j < 12; j += 3) {
                                const oj = offset + j;
                                bPos.push(CUBE_VERTICES[oj] + wx, CUBE_VERTICES[oj + 1] + wy, CUBE_VERTICES[oj + 2] + wz);
                                bNorm.push(CUBE_NORMALS[oj], CUBE_NORMALS[oj + 1], CUBE_NORMALS[oj + 2]);
                            }
                        }

                        // ライト計算とカラーPushの最適化
                        const light = getLightLevel(x + wNX, y + wNY, z + wNZ);
                        const lightS = (light >> 4) & 15;
                        const lightB = light & 15;
                        const brightness = fw * globalBrightnessMultiplier;
                        const sS = Math.max(0.04, LIGHT_LEVEL_FACTORS[lightS] * brightness);
                        const bS = Math.max(0.04, LIGHT_LEVEL_FACTORS[lightB] * brightness);

                        // 4頂点分をフラットにPush
                        bCol.push(
                            sS, bS, 0,
                            sS, bS, 0,
                            sS, bS, 0,
                            sS, bS, 0
                        );
                    }
                }
            }
        }
    }

    if (!hasAnySolidBlock) return container;

    // --- 4. バッチング (不透明) ---
    const materialGuidMap = new Map();
    const chunkMaterials = [];
    const opaqueGeometries = [];

    for (const [type, group] of faceGeoms.entries()) {
        let totalV = 0;
        for (const m of group.values()) totalV += m.positions.length / 3;
        if (totalV === 0) continue;

        const subGeom = new THREE.BufferGeometry();
        const pos = new Float32Array(totalV * 3), col = new Float32Array(totalV * 3),
            norm = new Float32Array(totalV * 3), uv = new Float32Array(totalV * 2),
            idx = new Uint32Array((totalV / 4) * 6);

        let vO = 0, iO = 0, uvO = 0, gO = 0;
        const baseMats = SharedMaterials.blocks.get(type) || getBlockMaterials(+type);

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
            const originMat = baseMats[mIdx];
            let guidIdx = materialGuidMap.get(originMat);
            if (guidIdx === undefined) {
                const fMat = originMat.clone();
                fMat.vertexColors = true;
                if (fMat.color) fMat.color.set(0xffffff);
                fMat.userData = { originMat, shaderUniforms: originMat.userData?.shaderUniforms };
                if (originMat.onBeforeCompile) fMat.onBeforeCompile = originMat.onBeforeCompile;
                guidIdx = chunkMaterials.length;
                materialGuidMap.set(originMat, guidIdx);
                chunkMaterials.push(fMat);
            }
            subGeom.addGroup(gO, fC * 6, guidIdx);
            gO += fC * 6;
            vO += len;
        }
        subGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        subGeom.setAttribute('color', new THREE.BufferAttribute(col, 3));
        subGeom.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
        subGeom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        subGeom.setIndex(new THREE.BufferAttribute(idx, 1));
        opaqueGeometries.push(subGeom);
    }

    if (opaqueGeometries.length > 0) {
        const finalGeom = mergeBufferGeometries(opaqueGeometries, true);
        finalGeom.computeBoundingSphere();
        const mesh = new THREE.Mesh(finalGeom, chunkMaterials);
        mesh.frustumCulled = true;
        mesh.userData.finalizeFade = function () {
            if (!mesh.material) return;
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const newMats = mats.map(m => {
                const o = m.userData?.originMat;
                if (o) { m.dispose(); return o; }
                return m;
            });
            mesh.material = Array.isArray(mesh.material) ? newMats : newMats[0];
        };
        container.add(mesh);
    }

    // --- 5. カスタムメッシュ結合 (最適化版) ---
    const cutoutGeometries = [], cutoutMaterials = [], cutoutMatMap = new Map();
    const waterGeometries = [], waterMaterials = [], waterMatMap = new Map();

    for (const [type, geoms] of customGeomBatches.entries()) {
        const mergedGeom = mergeBufferGeometries(geoms, true);
        const baseMat = (getBlockMaterials(+type) || [])[0];
        const isWater = type === BLOCK_TYPES.WATER || baseMat?.userData?.isWater === true;
        const isGlass = type === BLOCK_TYPES.GLASS;
        const isCutout = _blockConfigFastArray[type]?.geometryType === "cross" || isGlass;

        const fadeMat = getOrCreateCustomFadeMaterial(baseMat, isCutout, isWater, isGlass).clone();
        fadeMat.vertexColors = true;
        fadeMat.userData = { originMat: baseMat, shaderUniforms: baseMat?.userData?.shaderUniforms };
        if (baseMat?.onBeforeCompile) fadeMat.onBeforeCompile = baseMat.onBeforeCompile;

        const targetGeoms = isWater ? waterGeometries : cutoutGeometries;
        const targetMats = isWater ? waterMaterials : cutoutMaterials;
        const targetMap = isWater ? waterMatMap : cutoutMatMap;

        let mIdx = targetMap.get(fadeMat.uuid);
        if (mIdx === undefined) {
            mIdx = targetMats.length;
            targetMats.push(fadeMat);
            targetMap.set(fadeMat.uuid, mIdx);
        }
        mergedGeom.clearGroups();
        mergedGeom.addGroup(0, mergedGeom.index ? mergedGeom.index.count : mergedGeom.attributes.position.count, mIdx);
        targetGeoms.push(mergedGeom);
    }

    if (cutoutGeometries.length > 0) {
        const mesh = new THREE.Mesh(mergeBufferGeometries(cutoutGeometries, true), cutoutMaterials);
        mesh.renderOrder = 1; container.add(mesh);
    }
    if (waterGeometries.length > 0) {
        const mesh = new THREE.Mesh(mergeBufferGeometries(waterGeometries, true), waterMaterials);
        mesh.renderOrder = 10; container.add(mesh);
    }

    return container;
}
// ------------------------------
// CUSTOM BLOCK MESH (軽量化版)
// ------------------------------
const materialCache = new Map();
const collisionCache = new Map();
const geometryCache = new Map();

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
        ?? getVoxelAtWorld(b.x, b.y, b.z, globalTerrainCache, true);

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

async function itemspreview() {
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
        ?? getVoxelAtWorld(x, y, z, globalTerrainCache, true);

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

    // BoxGeometry作成 (Z-fighting防止のため +0.005)
    const geom = new THREE.BoxGeometry(size.x + 0.005, size.y + 0.005, size.z + 0.005);

    // 斜め線を消すためのエッジ抽出
    const edges = new THREE.EdgesGeometry(geom);

    const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
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
        ?? getVoxelAtWorld(x, y, z, globalTerrainCache, { raw: true });

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
        ?? getVoxelAtWorld(hX, hY, hZ, globalTerrainCache, { raw: true });

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

        // --- バイオーム判定ロジック ---
        // プレイヤーの現在座標を取得
        const px = player.position.x;
        const pz = player.position.z;

        // 地形生成時と全く同じスケール(0.0005)でノイズをサンプリング
        const tVal = fractalNoise2D(px * 0.0005, pz * 0.0005, 3) + 0.5;
        const hVal = fractalNoise2D(px * 0.0005 + 500, pz * 0.0005 + 500, 3) + 0.5;

        // determineBiomeを実行して名前を取得
        const biomeConfig = determineBiome(tVal, hVal);
        const biomeName = (biomeConfig && biomeConfig.name) ? biomeConfig.name : "Unknown";

        // HTMLを更新（biomeName定義の後に実行）
        fpsCounter.innerHTML = `
        <b>Minecraft classic 0.0.1</b><br>
        Seed: ${currentSeed}<br>
        Time: ${getGameClock(gameTime)} (${Math.floor(gameTime)} ticks)<br>
        ${fps} fps, ${activeUpdates} chunks update<br>
        <b>Draw calls: ${drawCalls}</b> (Tri: ${triangles.toLocaleString()})<br>
        ${modifiedCount} modified chunks (Saved)<br>
        C: ${loadedChunks.size} loaded. (Quality: ${CHUNK_VISIBLE_DISTANCE})<br>
        Dimension: Overworld<br>
        <b>Biome: ${biomeName}</b><br>
        x: ${Math.round(player.position.x)} (C: ${pCx})<br>
        y: ${Math.round(player.position.y)} (feet)<br>
        z: ${Math.round(player.position.z)} (C: ${pCz})<br>
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
    ui.config.style.display = 'none';
    ui.menu.style.display = 'none';
    ui.loading.style.display = 'flex';
    initCanvas();
    initSunMoon();

    // --- ★最重要: setTimeout の外で即座に時間をセット ---
    // これにより、500msの待機中に初期値(0)で動くのを防ぎます
    if (typeof gameTime !== 'undefined') {
        gameTime = savedTime;
    }

    setTimeout(async () => {
        if (typeof applySeed === 'function') {
            applySeed(seed);
        }

        // --- 1. データの復元 ---
        if (savedChunks instanceof Map && savedChunks.size > 0) {
            ChunkSaveManager.modifiedChunks = savedChunks;
        } else {
            ChunkSaveManager.modifiedChunks = ChunkSaveManager.modifiedChunks || new Map();
        }

        // --- 2. プレイヤー位置・視点の反映 ---
        const startPos = savedPos ? savedPos : { x: 0, y: 40, z: 0, yaw: 0, pitch: 0 };
        if (typeof player !== 'undefined') {
            player.position.set(startPos.x, startPos.y, startPos.z);
            player.spawnFixed = !!savedPos;
        }
        // 視点(カメラ角度)の復元
        if (typeof yaw !== 'undefined' && typeof pitch !== 'undefined') {
            yaw = startPos.yaw || 0;
            pitch = startPos.pitch || 0;
        }

        // --- 3. 描画の反映 ---
        if (typeof updateSunMoonPosition === 'function') {
            // 内部で正しく3引数の updateSkyAndFogColor を呼び出してくれます
            updateSunMoonPosition();
        } else if (typeof updateSkyAndFogColor === 'function') {
            // もし updateSunMoonPosition が使えない場合の予備（防衛策）
            updateSkyAndFogColor(gameTime, 0, _tmpSunDir);
        }
        console.log("時間を復元しました:", gameTime);

        ui.loading.style.display = 'none';

        // --- ★重要: ロード直後のセーブ(上書き)をコメントアウト ---
        // ロードが完了した瞬間にセーブすると、万が一ロードに失敗していた場合に
        // 保存データを「壊れたデータ」で上書きしてしまうリスクがあるためです。
        // saveWorldData(seed, startPos, ChunkSaveManager.modifiedChunks, gameTime);

        addChatMessage(savedPos ? "データをロードしました" : `世界を新しく生成しました`, "#ffff00");
        await itemspreview();
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

    // 2. フォグの設定（地形の端を隠すためだけに使用）
    if (typeof scene !== 'undefined' && scene.fog) {
        // 地形が消えるべき距離（1チャンク16マス）
        const terrainLimit = val * 16;

        if (scene.fog.isFogExp2) {
            // 指数フォグの場合、地形の端がちょうど霞む程度の濃度に設定
            scene.fog.density = 0.05 / (terrainLimit || 1);
        } else {
            // 線形フォグの場合
            // near: 霧が始まる距離（少し手前から）
            // far:  地形の描画限界で霧が最大になるように設定
            scene.fog.near = Math.max(0, (val - 2) * 16);
            scene.fog.far = terrainLimit;
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
   【保存システム】IndexedDB Manager (パフォーマンス最適化・堅牢版)
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
            for (const [key, dataArray] of modifiedChunks) {
                // 【修正ポイント】dataArray 自体が Uint16Array なので直接 length を取る
                if (!dataArray || !(dataArray instanceof Uint16Array)) {
                    // もし Uint16Array でない(既に変換済み等)場合は blocks プロパティを探す
                    const actualBlocks = dataArray.blocks || dataArray;
                    if (!actualBlocks.length) continue;
                }

                const len = dataArray.length;
                const serializedBlocks = new Array(len);

                for (let j = 0; j < len; j++) {
                    const val = dataArray[j];
                    const id = val & 0xFFF;
                    const meta = (val >> 12) & 0xF;

                    serializedBlocks[j] = {
                        k: idToKey(id), // ここで文字列化
                        m: meta
                    };
                }

                // 保存用オブジェクトの構築
                const serializedData = {
                    blocks: serializedBlocks
                    // 必要ならここにチャンクの座標などを追加
                };

                chunkStore.put(serializedData, key.toString());
            }
        }

        tx.oncomplete = () => {
            console.log(`[Save] 保存完了: ${modifiedChunks ? modifiedChunks.size : 0} チャンク`);
            resolve();
        };

        tx.onerror = () => {
            console.error("[Save] 保存エラー:", tx.error);
            reject(tx.error);
        };
    });
}

/**
 * ワールドデータの全読み込み
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

            for (let i = 0, len = keys.length; i < len; i++) {
                // すべて Number として扱う
                const chunkKey = Number(keys[i]);
                const chunkData = values[i];

                if (chunkData && chunkData.blocks) {
                    const bLen = chunkData.blocks.length;
                    const numericBlocks = new Uint16Array(bLen);

                    for (let j = 0; j < bLen; j++) {
                        const item = chunkData.blocks[j];
                        const isObj = (item !== null && typeof item === 'object');
                        const key = isObj ? item.k : item;
                        const meta = isObj ? (item.m ?? 0) : 0;

                        const id = keyToId(key);
                        numericBlocks[j] = (id & 0xFFF) | ((meta & 0xF) << 12);
                    }

                    // 【重要】オブジェクト全体ではなく、Uint16Arrayそのものをセットする
                    chunks.set(chunkKey, numericBlocks);
                } else if (chunkData instanceof Uint16Array) {
                    // すでに Uint16Array の場合はそのままセット（念のため）
                    chunks.set(chunkKey, chunkData);
                }
            }

            resolve({
                seed: reqSeed.result,
                pos: reqPos.result ?? null,
                gameTime: reqTime.result ?? 6000,
                chunks: chunks
            });
        };

        tx.onerror = () => {
            console.error("[Load] 読み込みエラー:", tx.error);
            reject(tx.error);
        };
    });
}