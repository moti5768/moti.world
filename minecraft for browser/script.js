"use strict";
import * as THREE from './build/three.module.js';
import {
    STATE_SCHEMAS,
    registerStateSchema, getBlockStateProp, getBlockStateRawProp, setBlockStateProp,
    cycleBlockStateProp, hasBlockStateProp, packBlockState, unpackBlockState,
    formatBlockStateString, getTransformMeta, getBlockLightEmissionForState,
    getRawBlockId, getRawLocalState, packRawBlock, getGlobalStatePaletteStats
} from './blockstate.js';
import {
    BLOCK_CONFIG, BLOCK_TYPES, SHARED_SKY_UNIFORM, SHARED_BRIGHTNESS_UNIFORM,
    onBlockRegistered, registerCustomBlock, registerGeometryBuilder, registerPlacementRule, registerSupportRule,
    getBlockMaterials, getBlockMaterialsForState, getBlockConfiguration, getBlockGeometry,
    getCollisionBoxes, getCollisionBoxesReadOnly, getSelectionBoxesReadOnly,
    isRedstoneComponent,
    calculatePlacementMeta, canPlaceBlockAt, isSupportDependentBlock,
    getLogRotationMatrixReadOnly, applyRotationToCollisionBox, getCustomGeometryMatrix,
    idToKey, keyToId, loadBlockAssets
} from './blocks.js';
import { createRedstoneEngine } from './redstone_engine.js';
import { createFluidEngine } from './fluid_engine.js';
import { createPlayerData, GAME_MODES } from './entities/player_data.js';
import { createEntityManager } from './entities/entity_manager.js';
import { MOB_TYPES } from './entities/mob_registry.js';
import { createBlockEntityManager } from './blocks/block_entity.js';
import { createPistonAnimator } from './blocks/piston_animator.js';
import { createChestAnimator } from './blocks/chest_animator.js';
import { PistonEngine, registerPistonAnimator } from './blocks/definitions/pistons.js';

import { createContainerUI } from './ui/container_ui.js';
import { createInventoryUI } from './ui/inventory_ui.js';

import { createMinecraftBreakParticles, updateBlockParticles } from './particles.js';
import { setMinecraftSky, loadCloudTexture, updateCloudGrid, updateCloudTiles, updateCloudOpacity, adjustCloudLayerDepth } from './cloudsky.js';

import { BIOME_CONFIG, BIOME_COUNT } from './biomes/biomes.js';
import { createBeta18TerrainEngine } from './world/beta18_terrain.js';

import { Features } from './features.js';
import { FeatureRules } from './feature_rules.js';

import { generateWorldUid, saveWorldData, loadFullSaveData } from './world/save_manager.js';
import { TICKS_PER_DAY, getSkyLightFactor, getGameClock, createSkySystem } from './world/sky_system.js';
import { createLightingEngine, LIGHT_LEVEL_FACTORS } from './world/lighting_engine.js';
import {
    createChunkMesher,
    NEIGHBOR_BIT_PX, NEIGHBOR_BIT_NX, NEIGHBOR_BIT_PZ, NEIGHBOR_BIT_NZ
} from './world/chunk_mesher.js';
import { createOcclusionCuller } from './world/occlusion_culler.js';
import { createInputController, addChatMessage } from './core/input_controller.js';
import {
    createPhysicsEngine,
    COLLISION_MARGIN, PLAYER_RADIUS, PLAYER_HEIGHT, SNEAK_HEIGHT
} from './core/physics_engine.js';

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
const _isLeavesBlock = new Uint8Array(MAX_BLOCK_IDS);
const _blockLightOpacity = new Uint8Array(MAX_BLOCK_IDS);
const _blockMayEmitLight = new Uint8Array(MAX_BLOCK_IDS);

function _syncBlockFastEntry(id, cfg) {
    if (id < 0 || id >= MAX_BLOCK_IDS) return;
    _blockConfigFastArray[id] = cfg;
    _blockMaterialsFastArray[id] = null;
    if (!cfg) {
        _isLeavesBlock[id] = 0;
        _blockLightOpacity[id] = 0;
        _blockMayEmitLight[id] = 0;
        return;
    }

    _isOpaqueBlock[id] = cfg.isOpaqueCube ? 1 : 0;
    _isRedstoneConductive[id] = cfg.redstoneConductive ? 1 : 0;
    _isTransparentBlock[id] = cfg.transparent ? 1 : 0;
    _cullSameBlock[id] = cfg.cullAdjacentFaces === true ? 1 : 0;
    _isLogBlock[id] = cfg.isLog === true ? 1 : 0;
    _isLeavesBlock[id] = (cfg.geometryType === 'leaves') ? 1 : 0;
    _blockLightOpacity[id] = (id === 0)
        ? 0
        : (!cfg.transparent ? 15 : (cfg.lightOpacity !== undefined ? cfg.lightOpacity : 1));
    _blockMayEmitLight[id] = (
        id !== 0 && (
            (cfg.lightLevel > 0) ||
            cfg.isLightSource === true ||
            cfg.hasStateMaterials === true ||
            !!cfg.stateVariants ||
            !!cfg.resolveStateVisual
        )
    ) ? 1 : 0;

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

    Beta18Terrain.setSeed(currentSeed);
    terrainHeightCache.clear();
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
    // 0・負の整数境界でも正確に床関数と一致する高速座標取得
    const xi = x >= 0 ? (x | 0) : (x === (x | 0) ? (x | 0) : (x | 0) - 1);
    const yi = y >= 0 ? (y | 0) : (y === (y | 0) ? (y | 0) : (y | 0) - 1);

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
const TIME_SPEED = 1.0;

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
 * Minecraft Beta 1.8 準拠 GenLayer バイオーム＆高度算出
 */
const Beta18Terrain = createBeta18TerrainEngine();

const _getBiomeAt = (wx, wz) => {
    const bId = Beta18Terrain.getBiomeIdAt(wx, wz);
    return BIOME_CONFIG[bId] || BIOME_CONFIG[0];
};

const _getRawHeightAt = (wx, wz) => {
    return Beta18Terrain.getApproxHeightAt(wx, wz, BIOME_CONFIG);
};

export const ChunkSaveManager = {
    modifiedChunks: new Map(),
    workerBaseCache: new Map(),    // Web Worker で事前生成した未装飾ベース地形の一時待機キャッシュ（回路・保存対象から完全隔離）
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

    // 1. Beta 1.8 準拠 3D密度地形の生成（terrain_worker.js と100%共有）
    generateBaseTerrain: function (cx, cz) {
        return Beta18Terrain.generateChunkBaseTerrain(
            cx,
            cz,
            this._sharedDataBuffer,
            SEA_LEVEL,
            BLOCK_TYPES,
            BIOME_CONFIG
        );
    },

    // 1. ベース地形（デコレーション無し）のみを安全に確保・取得する
    getOrCreateBaseTerrain: function (cx, cz) {
        const key = encodeChunkKey(cx, cz);
        let dataArray = this.modifiedChunks.get(key);
        if (dataArray === undefined) {
            const prebuilt = this.workerBaseCache.get(key);
            if (prebuilt !== undefined) {
                this.workerBaseCache.delete(key);
                dataArray = prebuilt;
            } else {
                const data = this.generateBaseTerrain(cx, cz);
                dataArray = new Uint16Array(data);
            }
            this.modifiedChunks.set(key, dataArray);
        }
        return dataArray;
    },

    // 2. ワールド座標系でブロックを配置（木・構造物と草花の上書き権限を分離しロード順非依存を実現）
    setBlockWorldDecoration: function (wx, wy, wz, blockId, allowOverwrite, allowLeafOverwrite = true) {
        if (wy < 0 || wy >= CHUNK_HEIGHT) return;
        const cx = wx >> 4;
        const cz = wz >> 4;
        const key = encodeChunkKey(cx, cz);
        // 遠方チャンク回収→再訪問時に、隣接するプレイヤー編集済み・読込済みチャンクへ木が上書き復活するのを防止
        if (this.playerModifiedKeys.has(key)) return;

        const lx = wx & 15;
        const lz = wz & 15;

        const dataArray = this.getOrCreateBaseTerrain(cx, cz);
        const idx = (wy | (lz << 8) | (lx << 12)) | 0;
        const currentId = getRawBlockId(dataArray[idx]);

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
        return getRawBlockId(dataArray[idx]);
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
                const block = getRawBlockId(centerData[colBase | y]);
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
        const neighborId = getRawBlockId(neighborRaw);

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
const SECTION_HEIGHT = 16;
const SECTIONS_PER_CHUNK = CHUNK_HEIGHT >> 4; // 16 セクション (sy: 0..15)

let CHUNK_VISIBLE_DISTANCE = 6;

let flightMode = false;
let wasUnderwater = false;

let lastFpsTime = performance.now();
let frameCount = 0;
const fpsCounter = document.getElementById("fpsCounter");

const POOL_MAX = 1024;
const BEDROCK_LEVEL = 0;

// ----- スポーン位置の動的設定 -----
const spawnX = 0;
const spawnZ = 0;

// 起動前仮高度（実高度は applySeed 後の prewarmSpawnChunks で実ボクセルから確定）
const spawnY = SEA_LEVEL + 7;

// プレイヤーデータ
const player = {
    position: new THREE.Vector3(spawnX, spawnY, spawnZ),
    prevPosition: new THREE.Vector3(spawnX, spawnY, spawnZ),
    velocity: new THREE.Vector3(0, 0, 0),
    onGround: false,
    positionIsCenter: false,
    spawnFixed: false
};

const keys = {};
let jumpRequest = false;
let dashActive = false;
let sneakActive = false;
let yaw = 0, pitch = 0;

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

const SkySystem = createSkySystem({
    scene,
    camera,
    getRenderer: () => renderer,
    getPlayer: () => player,
    getBrightnessMultiplier: () => globalBrightnessMultiplier,
    sharedSkyUniform: SHARED_SKY_UNIFORM
});

const PhysicsEngine = createPhysicsEngine({
    CHUNK_HEIGHT,
    BLOCK_TYPES,
    player,
    camera,
    keys,
    blockConfigFastArray: _blockConfigFastArray,
    getVoxelAtWorld,
    getChunkBlock: (cx, cz, lx, ly, lz) => ChunkSaveManager.getBlock(cx, cz, lx, ly, lz),
    getChunkCoord,
    getYaw: () => yaw,
    getSneakActive: () => sneakActive,
    getDashActive: () => dashActive,
    getFlightMode: () => flightMode,
    getWasUnderwater: () => wasUnderwater,
    getJumpRequest: () => jumpRequest,
    setJumpRequest: (v) => { jumpRequest = v; }
});

const getCurrentPlayerHeight = PhysicsEngine.getCurrentPlayerHeight;
const getPlayerAABB = PhysicsEngine.getPlayerAABB;
const getPlayerAABBAt = PhysicsEngine.getPlayerAABB;
const checkAABBCollision = PhysicsEngine.checkAABBCollision;
const resolvePlayerCollision = PhysicsEngine.resolvePlayerCollision;
const updateNormalPhysics = PhysicsEngine.updateNormalPhysics;
const updateFlightPhysics = PhysicsEngine.updateFlightPhysics;
const updateOnGround = PhysicsEngine.updateOnGround;
const isPlayerEntireBodyInWater = PhysicsEngine.isPlayerEntireBodyInWater;
const updateUnderwaterPhysics = PhysicsEngine.updateUnderwaterPhysics;
const raycastVoxel = PhysicsEngine.raycastVoxel;
const getTargetBlockByDDA = PhysicsEngine.getTargetBlockByDDA;

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

    // --- A. マウス・クリック・タッチ系 ---
    renderer.domElement.addEventListener("mousedown", InputController.onCanvasMouseDown, false);
    InputController.bindCanvasTouchControls();

    renderer.domElement.addEventListener("click", (e) => {
        if (isInventoryOpen || isContainerOpen || InputController.pointerLocked || InventoryUI.containsTarget(e.target)) return;
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
   【衝突判定キャッシュ（particles.js 互換）＆選択枠用 Box3 プール】
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
    return encodeWorldBlockKey(x | 0, y | 0, z | 0);
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
    return isRaw ? val : getRawBlockId(val);
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

function finalizeChunkFadeImmediately(container) {
    if (!container || container.userData.fadedIn) return;
    container.userData.fadedIn = true;
    container.traverse(onMeshChildFinalize);
    for (let i = activeFadeTasks.length - 1; i >= 0; i--) {
        if (activeFadeTasks[i].object === container) {
            activeFadeTasks.splice(i, 1);
            break;
        }
    }
}

/**
 * 指定チャンク内の対象 16x16x16 セクション (syMask のビットが立っている層) のみを高速再構築する
 */
function refreshChunkSections(cx, cz, syMask) {
    const mask = syMask & 0xFFFF;
    if (mask === 0) return;

    const key = encodeChunkKey(cx, cz);
    const container = loadedChunks.get(key);

    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);
    if (!isChunkWithinUnloadDistance(cx, cz, pCx, pCz)) {
        if (container) unloadChunkByKey(key);
        return;
    }

    if (!container || !container.userData.sections) {
        refreshChunkAt(cx, cz);
        return;
    }

    finalizeChunkFadeImmediately(container);

    let voxelData = ChunkSaveManager.modifiedChunks.get(key);
    let isNewChunk = false;
    if (!voxelData || !ChunkSaveManager.decoratedChunks.has(key)) {
        voxelData = ChunkSaveManager.captureBaseChunkData(cx, cz);
        isNewChunk = true;
    }

    let lightMap = chunkLightCache.get(key);
    if (!lightMap || isNewChunk) {
        lightMap = generateChunkLightMap(key, voxelData);
    }

    const prevMissingMask = container.userData.missingNeighborMask | 0;
    const nextMissingMask = populateChunkBoundaryView(cx, cz, voxelData, lightMap);
    // 全16セクション更新時のみフラグを上書きし、部分更新時は未更新層の欠損ビットを保持する
    container.userData.missingNeighborMask = (mask === 0xFFFF) ? nextMissingMask : (prevMissingMask | nextMissingMask);
    const sections = container.userData.sections;
    if (!container.userData.sectionVis) {
        container.userData.sectionVis = new Uint16Array(SECTIONS_PER_CHUNK);
    }
    const sectionVis = container.userData.sectionVis;

    for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
        if (((mask >> sy) & 1) === 0) continue;

        sectionVis[sy] = computeSectionVisibility(voxelData, sy);
        const oldSec = sections[sy];
        const newSec = buildChunkSectionMesh(cx, cz, sy, voxelData, lightMap, false, false);
        if (newSec) {
            container.add(newSec);
            sections[sy] = newSec;
        } else {
            sections[sy] = null;
        }

        if (oldSec) {
            container.remove(oldSec);
            disposeMesh(oldSec);
        }

        chunkUpdatesInSecond++;
    }

    recomputeChunkBoundingBox(container);
    syncSingleChunkSkyLight(container);
}

function refreshChunkAt(cx, cz) {
    const key = encodeChunkKey(cx, cz);
    const oldChunk = loadedChunks.get(key);

    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);

    if (!isChunkWithinUnloadDistance(cx, cz, pCx, pCz)) {
        if (oldChunk) unloadChunkByKey(key);
        return;
    }

    const newChunk = generateChunkMeshMultiTexture(cx, cz, false, false);
    if (!newChunk) {
        if (oldChunk) unloadChunkByKey(key);
        return;
    }

    newChunk.userData.fadedIn = true;
    syncSingleChunkSkyLight(newChunk);

    scene.add(newChunk);
    loadedChunks.set(key, newChunk);

    if (oldChunk) {
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
// 16x16x16 セクション単位 更新要求キュー（重複自動マージ・メインループ統合管理）
// ───────────────────────────────

let pendingChunkUpdates = new Set();
let chunkUpdateQueue = [];
let chunkUpdateLookup = new Set();
const chunkUpdateMasks = new Map(); // Map<chunkKey, 16bit sectionMask>
let chunkUpdateIdx = 0;

function getSectionMaskForY(wy) {
    const sy = wy >> 4;
    if (sy < 0 || sy >= SECTIONS_PER_CHUNK) return 0;
    let mask = 1 << sy;
    const ly = wy & 15;
    if (ly === 0 && sy > 0) mask |= (1 << (sy - 1));
    else if (ly === 15 && sy < SECTIONS_PER_CHUNK - 1) mask |= (1 << (sy + 1));
    return mask;
}

function requestChunkUpdateMaskByKey(key, syMask) {
    const mask = syMask & 0xFFFF;
    if (mask === 0) return;
    chunkUpdateMasks.set(key, (chunkUpdateMasks.get(key) || 0) | mask);
    if (!chunkUpdateLookup.has(key)) {
        chunkUpdateLookup.add(key);
        chunkUpdateQueue.push(key);
    }
}

/**
 * チャンク／セクション更新要求（sy 省略時は全 16 セクション、sy=0..15 指定時は該当 16x16x16 のみ）
 */
function requestChunkUpdate(cx, cz, sy = -1) {
    const key = encodeChunkKey(cx, cz);
    const mask = (sy >= 0 && sy < SECTIONS_PER_CHUNK) ? (1 << sy) : 0xFFFF;
    requestChunkUpdateMaskByKey(key, mask);
}

/**
 * 1 ブロック座標 (wx, wy, wz) の変化に伴う最小限の 16x16x16 セクション群のみを更新予約する
 */
function requestBlockSectionUpdate(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_HEIGHT) return;
    const cx = wx >> 4;
    const cz = wz >> 4;
    const lx = wx & 15;
    const lz = wz & 15;
    const syMask = getSectionMaskForY(wy);
    if (syMask === 0) return;

    requestChunkUpdateMaskByKey(encodeChunkKey(cx, cz), syMask);
    if (lx === 0) requestChunkUpdateMaskByKey(encodeChunkKey(cx - 1, cz), syMask);
    else if (lx === 15) requestChunkUpdateMaskByKey(encodeChunkKey(cx + 1, cz), syMask);
    if (lz === 0) requestChunkUpdateMaskByKey(encodeChunkKey(cx, cz - 1), syMask);
    else if (lz === 15) requestChunkUpdateMaskByKey(encodeChunkKey(cx, cz + 1), syMask);
    if (lx === 0 && lz === 0) requestChunkUpdateMaskByKey(encodeChunkKey(cx - 1, cz - 1), syMask);
    else if (lx === 0 && lz === 15) requestChunkUpdateMaskByKey(encodeChunkKey(cx - 1, cz + 1), syMask);
    else if (lx === 15 && lz === 0) requestChunkUpdateMaskByKey(encodeChunkKey(cx + 1, cz - 1), syMask);
    else if (lx === 15 && lz === 15) requestChunkUpdateMaskByKey(encodeChunkKey(cx + 1, cz + 1), syMask);
}

/**
 * メインループ(animate)から呼ばれる差分セクション再構築（回路・ピストン・流体優先）
 */
function processChunkUpdateQueue(budgetMs = 6.0) {
    if (chunkUpdateIdx >= chunkUpdateQueue.length) return;
    const start = performance.now();

    while (chunkUpdateIdx < chunkUpdateQueue.length) {
        const key = chunkUpdateQueue[chunkUpdateIdx];
        chunkUpdateIdx++;

        if (!chunkUpdateLookup.has(key)) continue;
        chunkUpdateLookup.delete(key);
        const syMask = chunkUpdateMasks.get(key) || 0xFFFF;
        chunkUpdateMasks.delete(key);
        if (!loadedChunks.has(key)) continue;

        const cx = key >> 16;
        const cz = (key << 16) >> 16;
        if (syMask === 0xFFFF) {
            refreshChunkAt(cx, cz);
        } else {
            refreshChunkSections(cx, cz, syMask);
        }

        if ((performance.now() - start) >= budgetMs) break;
    }

    if (chunkUpdateIdx >= chunkUpdateQueue.length) {
        chunkUpdateQueue.length = 0;
        chunkUpdateIdx = 0;
    }
}

// ==========================================
// 周辺の自動チャンク生成キュー (メインループ定時バジェット駆動)
// ==========================================

// ==========================================
// 基本地形生成 Web Worker プール（最大 3 並列・ゼロコピー転送・自動フォールバック）
// ==========================================
const TerrainWorkerPool = (() => {
    const workers = [];
    const inFlight = new Set();
    let nextWorkerIdx = 0;
    let generation = 0;
    let initialized = false;
    let available = false;

    function buildInitPayload(seed) {
        const biomes = [];
        for (let i = 0; i < BIOME_COUNT; i++) {
            const b = BIOME_CONFIG[i];
            biomes.push({
                id: b.id,
                topBlock: b.topBlock,
                fillerBlock: b.fillerBlock,
                minHeight: b.minHeight,
                maxHeight: b.maxHeight,
                baseHeight: b.baseHeight,
                heightVariation: b.heightVariation,
                noiseScale: b.noiseScale
            });
        }
        return {
            type: "init",
            seed: seed >>> 0,
            seaLevel: SEA_LEVEL,
            biomes,
            blockIds: {
                SKY: BLOCK_TYPES.SKY,
                STONE: BLOCK_TYPES.STONE,
                DIRT: BLOCK_TYPES.DIRT,
                SAND: BLOCK_TYPES.SAND,
                SANDSTONE: BLOCK_TYPES.SANDSTONE,
                WATER: BLOCK_TYPES.WATER,
                LAVA: BLOCK_TYPES.LAVA,
                BEDROCK: BLOCK_TYPES.BEDROCK,
                GRAVEL: BLOCK_TYPES.GRAVEL,
                COAL_ORE: BLOCK_TYPES.COAL_ORE,
                IRON_ORE: BLOCK_TYPES.IRON_ORE,
                GOLD_ORE: BLOCK_TYPES.GOLD_ORE,
                REDSTONE_ORE: BLOCK_TYPES.REDSTONE_ORE,
                LAPIS_ORE: BLOCK_TYPES.LAPIS_ORE,
                EMERALD_ORE: BLOCK_TYPES.EMERALD_ORE
            }
        };
    }

    function onWorkerMessage(e) {
        const msg = e.data;
        if (!msg || msg.type !== "chunk") return;
        if (msg.gen !== generation) return;

        const key = msg.key;
        inFlight.delete(key);

        // 上書き禁止ガード: 待機中に同期生成・プレイヤー編集されたチャンクは既存データを絶対優先
        if (ChunkSaveManager.modifiedChunks.has(key) || ChunkSaveManager.playerModifiedKeys.has(key)) {
            return;
        }

        const pCx = getChunkCoord(player.position.x);
        const pCz = getChunkCoord(player.position.z);
        if (!isChunkWithinDataRetainDistance(msg.cx, msg.cz, pCx, pCz)) {
            return;
        }

        ChunkSaveManager.workerBaseCache.set(key, new Uint16Array(msg.buffer));

        // 描画範囲内かつ未ロードならメインスレッドのメッシュ化キューへ即戻す
        if (
            (msg.isPrimary || isChunkWithinRenderDistance(msg.cx, msg.cz, pCx, pCz)) &&
            !loadedChunks.has(key)
        ) {
            chunkQueue.push(key);
        }
    }

    function ensureWorkers() {
        if (initialized) return;
        initialized = true;
        if (typeof Worker === "undefined") return;

        const count = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
        try {
            for (let i = 0; i < count; i++) {
                const w = new Worker("./terrain_worker.js", { type: "module" });
                w.onmessage = onWorkerMessage;
                w.onerror = (err) => {
                    console.warn("[TerrainWorker] エラー発生のため同期フォールバックへ切替:", err.message || err);
                    available = false;
                    inFlight.clear();
                };
                workers.push(w);
            }
            available = workers.length > 0;
        } catch (err) {
            console.warn("[TerrainWorker] 初期化スキップ（同期生成を使用）:", err);
            available = false;
        }
    }

    function dispatchOne(cx, cz, isPrimary) {
        const key = encodeChunkKey(cx, cz);
        if (
            inFlight.has(key) ||
            ChunkSaveManager.modifiedChunks.has(key) ||
            ChunkSaveManager.workerBaseCache.has(key)
        ) {
            return false;
        }
        inFlight.add(key);
        const w = workers[nextWorkerIdx];
        nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
        w.postMessage({ type: "generate", gen: generation, key, cx, cz, isPrimary });
        return true;
    }

    return {
        reset(seed) {
            generation++;
            inFlight.clear();
            ChunkSaveManager.workerBaseCache.clear();
            ensureWorkers();
            if (!available) return;
            const payload = buildInitPayload(seed);
            for (let i = 0; i < workers.length; i++) {
                workers[i].postMessage(payload);
            }
        },

        isAvailable() {
            return available;
        },

        get pendingCount() {
            return inFlight.size;
        },

        /**
          * 指定チャンクと周囲 3x3 (8近傍) のベース地形を Worker へ投入（木・構造物の越境による同期生成を完全防止）
          */
        request(cx, cz) {
            if (!available) return false;
            dispatchOne(cx, cz, true);
            if (inFlight.size < 64) {
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dz = -1; dz <= 1; dz++) {
                        if (dx === 0 && dz === 0) continue;
                        dispatchOne(cx + dx, cz + dz, false);
                    }
                }
            }
            return true;
        },

        /**
         * 指定チャンクおよび周囲 3x3 のベース地形がすべてメモリ上（modifiedChunks / workerBaseCache）に揃っているか判定
         */
        isAreaBaseReady(cx, cz) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const k = encodeChunkKey(cx + dx, cz + dz);
                    if (!ChunkSaveManager.modifiedChunks.has(k) && !ChunkSaveManager.workerBaseCache.has(k)) {
                        return false;
                    }
                }
            }
            return true;
        }
    };
})();

// ==========================================
// 新規チャンク初期ライト計算 Web Worker プール（最大 2 並列・ゼロコピー転送・自動フォールバック）
// ==========================================
const LightWorkerPool = (() => {
    const workers = [];
    const inFlight = new Set();
    let nextWorkerIdx = 0;
    let generation = 0;
    let reqSeq = 0;
    let initialized = false;
    let available = false;

    function buildOpticalTables() {
        const opacityByRaw = new Uint8Array(65536);
        const emissionByRaw = new Uint8Array(65536);
        for (let raw = 1; raw < 65536; raw++) {
            const id = getRawBlockId(raw) | 0;
            if (id <= 0 || id >= MAX_BLOCK_IDS) continue;
            opacityByRaw[raw] = _blockLightOpacity[id];
            if (_blockMayEmitLight[id] !== 0) {
                emissionByRaw[raw] = getBlockLightEmissionForState(id, getRawLocalState(raw)) & 15;
            }
        }
        return { opacityByRaw, emissionByRaw };
    }

    function onWorkerMessage(e) {
        const msg = e.data;
        if (!msg || msg.type !== "light") return;
        if (msg.gen !== generation) return;

        const key = msg.key;
        inFlight.delete(key);

        // 待機中にメインスレッド側で同期ライト構築・編集済みなら上書きしない
        if (chunkLightCache.has(key)) return;

        const pCx = getChunkCoord(player.position.x);
        const pCz = getChunkCoord(player.position.z);
        if (!isChunkWithinDataRetainDistance(msg.cx, msg.cz, pCx, pCz)) {
            return;
        }

        const voxelData = ChunkSaveManager.modifiedChunks.get(key);
        if (!voxelData) return;

        const lightData = new Uint8Array(msg.buffer);
        chunkLightCache.set(key, lightData);

        // 隣接4チャンクと双方向境界同期し、光が流出した既ロード隣接セクションを即座に更新予約
        _lightDirtySet.clear();
        syncBorderLightFromNeighbors(key, voxelData, _lightDirtySet);
        for (const [dKey, dMask] of _lightDirtySet.entries()) {
            if (dKey !== key && loadedChunks.has(dKey)) {
                requestChunkUpdateMaskByKey(dKey, dMask);
            }
        }
        _lightDirtySet.clear();

        // 描画範囲内かつ未メッシュ化ならメッシュ化キューへ即戻す
        if (isChunkWithinRenderDistance(msg.cx, msg.cz, pCx, pCz) && !loadedChunks.has(key)) {
            chunkQueue.push(key);
        }
    }

    function ensureWorkers() {
        if (initialized) return;
        initialized = true;
        if (typeof Worker === "undefined") return;

        const count = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
        try {
            for (let i = 0; i < count; i++) {
                const w = new Worker("./world/light_worker.js");
                w.onmessage = onWorkerMessage;
                w.onerror = (err) => {
                    console.warn("[LightWorker] エラー発生のため同期フォールバックへ切替:", err.message || err);
                    available = false;
                    inFlight.clear();
                };
                workers.push(w);
            }
            available = workers.length > 0;
        } catch (err) {
            console.warn("[LightWorker] 初期化スキップ（同期計算を使用）:", err);
            available = false;
        }
    }

    return {
        reset() {
            generation++;
            inFlight.clear();
            ensureWorkers();
            if (!available) return;

            const { opacityByRaw, emissionByRaw } = buildOpticalTables();
            for (let i = 0; i < workers.length; i++) {
                const opCopy = new Uint8Array(opacityByRaw);
                const emCopy = new Uint8Array(emissionByRaw);
                workers[i].postMessage(
                    { type: "init", opacityByRaw: opCopy.buffer, emissionByRaw: emCopy.buffer },
                    [opCopy.buffer, emCopy.buffer]
                );
            }
        },

        isAvailable() {
            return available;
        },

        get pendingCount() {
            return inFlight.size;
        },

        request(cx, cz, voxelData) {
            if (!available || !voxelData) return false;
            const key = encodeChunkKey(cx, cz);
            if (inFlight.has(key) || chunkLightCache.has(key)) return false;

            inFlight.add(key);
            // メインスレッドの voxelData 本体を保護するためコピーをゼロコピー転送
            const copy = new Uint16Array(voxelData);
            const w = workers[nextWorkerIdx];
            nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
            w.postMessage(
                { type: "compute", gen: generation, reqId: ++reqSeq, key, cx, cz, voxelBuffer: copy.buffer },
                [copy.buffer]
            );
            return true;
        }
    };
})();

function processChunkQueue(isInitialBoost = false) {
    if (chunkQueue.length === 0) return 0;

    const MAX_CHUNKS_PER_FRAME = isInitialBoost ? 4 : 1;
    const FRAME_TIME_BUDGET = isInitialBoost ? 12.0 : 4.0;
    const startTime = performance.now();
    let tasksProcessed = 0;
    let workerDispatches = 0;
    let lightDispatches = 0;
    const MAX_WORKER_DISPATCH_PER_FRAME = 12;
    const MAX_LIGHT_DISPATCH_PER_FRAME = 3;

    const pCx = getChunkCoord(player.position.x);
    const pCz = getChunkCoord(player.position.z);

    // 描画距離0または初期スポーン待機中はフェードなしで即表示
    const useFade = !isInitialBoost && CHUNK_VISIBLE_DISTANCE > 0;
    const useWorker = !isInitialBoost && TerrainWorkerPool.isAvailable();
    const useLightWorker = !isInitialBoost && LightWorkerPool.isAvailable();

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

        // 本体または周囲 3x3 のベース地形が未生成ならメインスレッドを止めず Web Worker へ委譲
        if (useWorker && !TerrainWorkerPool.isAreaBaseReady(cx, cz)) {
            TerrainWorkerPool.request(cx, cz);
            if (++workerDispatches >= MAX_WORKER_DISPATCH_PER_FRAME) break;
            continue;
        }

        // 通常プレイ時はデコレーション後に初期ライト計算を Web Worker へ委譲（フォールバック時は次フレームへ分散）
        if (!isInitialBoost && (!ChunkSaveManager.decoratedChunks.has(key) || !chunkLightCache.has(key))) {
            const vData = ChunkSaveManager.captureBaseChunkData(cx, cz);
            if (vData && !chunkLightCache.has(key)) {
                if (useLightWorker) {
                    LightWorkerPool.request(cx, cz, vData);
                    if (++lightDispatches >= MAX_LIGHT_DISPATCH_PER_FRAME) break;
                    continue;
                }
                generateChunkLightMap(key, vData);
            }
            chunkQueue.push(key); // 同期フォールバック時は次フレームで即メッシュ化されるよう戻す
            tasksProcessed++;
            break;
        }

        const mesh = generateChunkMeshMultiTexture(cx, cz, false, useFade);
        if (!mesh) {
            tasksProcessed++;
            continue;
        }

        syncSingleChunkSkyLight(mesh);
        mesh.userData.fadedIn = !useFade;

        scene.add(mesh);
        loadedChunks.set(key, mesh);

        // 保留されていた予約Tickと自然生成された露出流体を起動
        TickScheduler.onChunkLoaded(cx, cz);
        const loadedVoxels = ChunkSaveManager.modifiedChunks.get(key);
        if (loadedVoxels) FluidEngine.onChunkLoaded(cx, cz, loadedVoxels);

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
    return tasksProcessed;
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

function processPendingChunkUpdates(budgetMs = 3.0) {
    if (pendingChunkUpdates.size === 0) return;

    const startTime = performance.now();
    const FRAME_BUDGET = budgetMs;
    let processed = 0;

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
        processed++;

        if (processed >= 1 || (performance.now() - startTime) > FRAME_BUDGET) {
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
    chunkUpdateMasks.delete(hashKey);
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

    const MAX_UNLOADS_PER_FRAME = 2;
    const UNLOAD_TIME_BUDGET = 1.5;
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
            FluidEngine.onChunkEvicted(key);
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

    // 4. 遠方の Worker 事前生成ベース地形キャッシュを回収
    let evictedWorkerBase = 0;
    for (const key of ChunkSaveManager.workerBaseCache.keys()) {
        decodeChunkKey(key, _evictCoordTmp);
        if (!isChunkWithinDataRetainDistance(_evictCoordTmp.cx, _evictCoordTmp.cz, pCx, pCz)) {
            ChunkSaveManager.workerBaseCache.delete(key);
            if (++evictedWorkerBase >= MAX_EVICT_PER_MAP) break;
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
   【新・15段階 マイクラ準拠 ライティングエンジン】（./world/lighting_engine.js へ分離済）
   ====================================================== */
// ブロック編集1回あたりに影響を受けたチャンクキーごとの 16bit セクションマスクを集約する再利用Map
const _lightDirtySet = new Map();

// 読み込み済みチャンクからのみ参照（未ロードチャンクの同期生成を厳禁）
function _getLoadedVoxelData(cx, cz) {
    const key = encodeChunkKey(cx, cz);
    return ChunkSaveManager.modifiedChunks.get(key) || chunkReadOnlyCache.get(key) || null;
}

function _getWorldRawLoaded(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_HEIGHT) return 0;
    const vData = _getLoadedVoxelData(wx >> 4, wz >> 4);
    if (!vData) return -1;
    return vData[wy | ((wz & 15) << 8) | ((wx & 15) << 12)];
}

function _getWorldBlockIdLoaded(wx, wy, wz) {
    const raw = _getWorldRawLoaded(wx, wy, wz);
    return raw < 0 ? -1 : getRawBlockId(raw);
}

const LightingEngine = createLightingEngine({
    CHUNK_SIZE,
    CHUNK_HEIGHT,
    encodeChunkKey,
    decodeChunkKey,
    getSectionMaskForY,
    getLoadedVoxelData: _getLoadedVoxelData,
    blockLightOpacity: _blockLightOpacity,
    blockMayEmitLight: _blockMayEmitLight,
    pendingChunkUpdates
});

const chunkLightCache = LightingEngine.chunkLightCache;
const getBlockLightOpacity = LightingEngine.getBlockLightOpacity;
const getBlockLightEmission = LightingEngine.getBlockLightEmission;
const _getWorldLightCell = LightingEngine.getWorldLightCell;
const updateLightAtBlockChange = LightingEngine.updateLightAtBlockChange;
const syncBorderLightFromNeighbors = LightingEngine.syncBorderLightFromNeighbors;
const generateChunkLightMap = LightingEngine.generateChunkLightMap;

// =======================================================
// 【チャンクメッシャー】（./world/chunk_mesher.js へ分離済）
// =======================================================
// 実行時に registerCustomBlock で追加された新ブロックを先頭定義の全高速配列＆名称表へ自動同期
onBlockRegistered((key, cfg) => {
    _syncBlockFastEntry(cfg.id, cfg);
    BLOCK_NAMES[cfg.id] = key.charAt(0) + key.slice(1).toLowerCase();
});

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

// バイオーム別 RGB パレット事前計算（0..7）
const _biomeGrassPalette = new Uint8Array(BIOME_COUNT * 3);
const _biomeFoliagePalette = new Uint8Array(BIOME_COUNT * 3);
for (let i = 0; i < BIOME_COUNT; i++) {
    const b = BIOME_CONFIG[i] || BIOME_CONFIG[0];
    const gc = b.grassColor ?? 0x91BD59;
    const fc = b.foliageColor ?? 0x77AB2F;
    _biomeGrassPalette[i * 3] = (gc >> 16) & 255;
    _biomeGrassPalette[i * 3 + 1] = (gc >> 8) & 255;
    _biomeGrassPalette[i * 3 + 2] = gc & 255;
    _biomeFoliagePalette[i * 3] = (fc >> 16) & 255;
    _biomeFoliagePalette[i * 3 + 1] = (fc >> 8) & 255;
    _biomeFoliagePalette[i * 3 + 2] = fc & 255;
}

const _chunkBiomeColorBuf = {
    ids: new Uint8Array(256),
    grassCell: new Uint8Array(256 * 3),
    foliageCell: new Uint8Array(256 * 3),
    grassPalette: _biomeGrassPalette,
    foliagePalette: _biomeFoliagePalette
};

function getChunkBiomeColors(cx, cz) {
    const area = Beta18Terrain.getBiomeArea((cx << 4) - 1, (cz << 4) - 1, 18, 18);
    for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
            const cId = area[(z + 1) * 18 + (x + 1)] | 0;
            const idx = (z << 4) | x;
            _chunkBiomeColorBuf.ids[idx] = cId;

            // 3x3 平均ブレンドで境界の草花色を滑らかにグラデーション
            let gr = 0, gg = 0, gb = 0, fr = 0, fg = 0, fb = 0;
            for (let dz = 0; dz < 3; dz++) {
                const row = (z + dz) * 18 + x;
                for (let dx = 0; dx < 3; dx++) {
                    const nb = (area[row + dx] | 0) * 3;
                    gr += _biomeGrassPalette[nb];
                    gg += _biomeGrassPalette[nb + 1];
                    gb += _biomeGrassPalette[nb + 2];
                    fr += _biomeFoliagePalette[nb];
                    fg += _biomeFoliagePalette[nb + 1];
                    fb += _biomeFoliagePalette[nb + 2];
                }
            }
            const c3 = idx * 3;
            _chunkBiomeColorBuf.grassCell[c3] = (gr / 9) | 0;
            _chunkBiomeColorBuf.grassCell[c3 + 1] = (gg / 9) | 0;
            _chunkBiomeColorBuf.grassCell[c3 + 2] = (gb / 9) | 0;
            _chunkBiomeColorBuf.foliageCell[c3] = (fr / 9) | 0;
            _chunkBiomeColorBuf.foliageCell[c3 + 1] = (fg / 9) | 0;
            _chunkBiomeColorBuf.foliageCell[c3 + 2] = (fb / 9) | 0;
        }
    }
    return _chunkBiomeColorBuf;
}

const ChunkMesher = createChunkMesher({
    CHUNK_SIZE,
    CHUNK_HEIGHT,
    SECTION_HEIGHT,
    SECTIONS_PER_CHUNK,
    BEDROCK_LEVEL,
    BLOCK_TYPES,
    LIGHT_LEVEL_FACTORS,
    encodeChunkKey,
    isOpaqueBlock: _isOpaqueBlock,
    isGreedyCubeBlock: _isGreedyCubeBlock,
    isCustomGeometryBlock: _isCustomGeometryBlock,
    cullSameBlock: _cullSameBlock,
    isLogBlock: _isLogBlock,
    isLeavesBlock: _isLeavesBlock,
    getChunkBiomeColors,
    blockConfigFastArray: _blockConfigFastArray,
    getBlockMaterialsFast,
    getChunkVoxelData: (key) => ChunkSaveManager.modifiedChunks.get(key),
    getLoadedVoxelData: (key) => ChunkSaveManager.modifiedChunks.get(key) || chunkReadOnlyCache.get(key) || null,
    isChunkDecorated: (key) => ChunkSaveManager.decoratedChunks.has(key),
    captureBaseChunkData: (cx, cz) => ChunkSaveManager.captureBaseChunkData(cx, cz),
    getLightMap: (key) => chunkLightCache.get(key) || null,
    generateChunkLightMap,
    getWireConnectionMask: (x, y, z, getRawFn) => RedstoneEngine.getWireConnectionMask(x, y, z, getRawFn),
    hasActiveBlockAnimations: () => PistonAnimator.hasActiveAnimations() || ChestAnimator.hasActiveAnimations(),
    isCoordHiddenByAnimation: (wx, wy, wz) => PistonAnimator.isCoordHidden(wx, wy, wz) || ChestAnimator.isCoordHidden(wx, wy, wz),
    onSectionBuilt: () => { chunkUpdatesInSecond++; }
});

const populateChunkBoundaryView = ChunkMesher.populateChunkBoundaryView;
const recomputeChunkBoundingBox = ChunkMesher.recomputeChunkBoundingBox;
const computeSectionVisibility = ChunkMesher.computeSectionVisibility;
const buildChunkSectionMesh = ChunkMesher.buildChunkSectionMesh;
const generateChunkMeshMultiTexture = ChunkMesher.generateChunkMeshMultiTexture;

const OcclusionCuller = createOcclusionCuller({
    CHUNK_SIZE,
    SECTION_HEIGHT,
    SECTIONS_PER_CHUNK,
    BEDROCK_LEVEL,
    encodeChunkKey
});

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

const _refreshedMaskTmp = new Map();
const _dirtyLightCoordTmp = { cx: 0, cz: 0 };

function updateAffectedChunks(blockPos, forceImmediate = false, dirtyLightChunks = null) {
    const bx = Math.floor(blockPos.x);
    const by = Math.floor(blockPos.y);
    const bz = Math.floor(blockPos.z);
    const cx = bx >> 4;
    const cz = bz >> 4;
    const lx = bx & 15;
    const lz = bz & 15;

    // 周囲6近傍に葉ブロックがある場合のみ、内側葉コアの透過切替(最大2マス伝播)に合わせて境界マージンを+1拡張
    const hasNearLeaf = (
        _isLeavesBlock[getVoxelAtWorld(bx + 1, by, bz, false)] === 1 ||
        _isLeavesBlock[getVoxelAtWorld(bx - 1, by, bz, false)] === 1 ||
        _isLeavesBlock[getVoxelAtWorld(bx, by + 1, bz, false)] === 1 ||
        _isLeavesBlock[getVoxelAtWorld(bx, by - 1, bz, false)] === 1 ||
        _isLeavesBlock[getVoxelAtWorld(bx, by, bz + 1, false)] === 1 ||
        _isLeavesBlock[getVoxelAtWorld(bx, by, bz - 1, false)] === 1
    );

    let baseSyMask = getSectionMaskForY(by) || 0xFFFF;
    if (hasNearLeaf && by >= 0 && by < CHUNK_HEIGHT) {
        const sy = by >> 4;
        const ly = by & 15;
        if (ly === 1 && sy > 0) baseSyMask |= (1 << (sy - 1));
        else if (ly === 14 && sy < SECTIONS_PER_CHUNK - 1) baseSyMask |= (1 << (sy + 1));
    }
    const edgeLo = hasNearLeaf ? 1 : 0;
    const edgeHi = hasNearLeaf ? 14 : 15;

    const centerKey = encodeChunkKey(cx, cz);
    _refreshedMaskTmp.clear();

    if (dirtyLightChunks === null && !chunkLightCache.has(centerKey)) {
        const centerVoxel = ChunkSaveManager.modifiedChunks.get(centerKey) ||
            ChunkSaveManager.captureBaseChunkData(cx, cz);
        if (centerVoxel) generateChunkLightMap(centerKey, centerVoxel);
    }

    // 1. 中心チャンクの対象 16x16x16 セクションを即時再構築
    const centerLightMask = (dirtyLightChunks instanceof Map) ? (dirtyLightChunks.get(centerKey) || 0) : 0;
    const centerMask = baseSyMask | centerLightMask;
    refreshChunkSections(cx, cz, centerMask);
    _refreshedMaskTmp.set(centerKey, centerMask);

    // 2. 辺・角で接触している隣接チャンクの該当セクションを即時再構築
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;

            const matchX = (dx === 0) || (dx === -1 && lx <= edgeLo) || (dx === 1 && lx >= edgeHi);
            const matchZ = (dz === 0) || (dz === -1 && lz <= edgeLo) || (dz === 1 && lz >= edgeHi);
            if (!forceImmediate && !(matchX && matchZ)) continue;

            const nCx = cx + dx;
            const nCz = cz + dz;
            const nKey = encodeChunkKey(nCx, nCz);
            if (!loadedChunks.has(nKey)) continue;

            const nLightMask = (dirtyLightChunks instanceof Map) ? (dirtyLightChunks.get(nKey) || 0) : 0;
            const nMask = (baseSyMask | nLightMask) & ~(_refreshedMaskTmp.get(nKey) || 0);
            if (nMask === 0) continue;

            refreshChunkSections(nCx, nCz, nMask);
            _refreshedMaskTmp.set(nKey, (_refreshedMaskTmp.get(nKey) || 0) | nMask);
        }
    }

    // 3. 光源変化が及んだ他セクションを再構築（近傍4チャンクまでは即時反映で遅延ゼロ）
    if (dirtyLightChunks && dirtyLightChunks.size > 0) {
        if (dirtyLightChunks instanceof Map) {
            let immediateBudget = forceImmediate ? 64 : 4;
            for (const [dKey, dMask] of dirtyLightChunks.entries()) {
                if (!loadedChunks.has(dKey)) continue;
                const remMask = dMask & ~(_refreshedMaskTmp.get(dKey) || 0);
                if (remMask === 0) continue;
                if (immediateBudget > 0) {
                    decodeChunkKey(dKey, _dirtyLightCoordTmp);
                    refreshChunkSections(_dirtyLightCoordTmp.cx, _dirtyLightCoordTmp.cz, remMask);
                    immediateBudget--;
                } else {
                    requestChunkUpdateMaskByKey(dKey, remMask);
                }
                _refreshedMaskTmp.set(dKey, (_refreshedMaskTmp.get(dKey) || 0) | remMask);
            }
        } else {
            for (const dKey of dirtyLightChunks) {
                if (_refreshedMaskTmp.has(dKey) || !loadedChunks.has(dKey)) continue;
                decodeChunkKey(dKey, _dirtyLightCoordTmp);
                if (forceImmediate) refreshChunkAt(_dirtyLightCoordTmp.cx, _dirtyLightCoordTmp.cz);
                else requestChunkUpdate(_dirtyLightCoordTmp.cx, _dirtyLightCoordTmp.cz);
                _refreshedMaskTmp.set(dKey, 0xFFFF);
            }
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
const _EMPTY_EXTRA_COORDS = Object.freeze([]);
const _particleCenterTmp = new THREE.Vector3();

function _getBlockIdForPlacement(wx, wy, wz) {
    return getVoxelAtWorld(wx, wy, wz, false);
}

function _getRawForPlacement(wx, wy, wz) {
    return getVoxelAtWorld(wx, wy, wz, true);
}

// Java Edition 準拠: 不透明ブロック・グロウストーン・上付き/ダブルスラブ・上付き階段の上へワイヤー設置を許可
registerSupportRule("floor_redstone_wire", (cfg, meta, wx, wy, wz) => {
    if (wy <= 0) return false;
    const belowRaw = _getRawForPlacement(wx, wy - 1, wz);
    const belowId = getRawBlockId(belowRaw);
    if (belowId === BLOCK_TYPES.SKY) return false;
    if (_isOpaqueBlock[belowId] === 1 || belowId === BLOCK_TYPES.GLOWSTONE) return true;

    const belowCfg = _blockConfigFastArray[belowId];
    if (!belowCfg) return false;
    const belowMeta = getRawLocalState(belowRaw);

    if (belowCfg.isSlab === true && hasBlockStateProp(belowId, "type")) {
        return getBlockStateProp(belowId, belowMeta, "type") !== "bottom";
    }
    if (belowCfg.isStairs === true && hasBlockStateProp(belowId, "half")) {
        return getBlockStateProp(belowId, belowMeta, "half") === "top";
    }
    return false;
});

// ブロック挙動フック用再利用コンテキスト（ゼロGC）
const _neighborHookCtx = {
    x: 0,
    y: 0,
    z: 0,
    blockId: 0,
    state: 0,
    getBlockId: _getBlockIdForPlacement,
    getRaw: _getRawForPlacement,
    getLightOpacity: getBlockLightOpacity
};

/**
 * クリック対象(base)が置換可能(overwrite: true)なら同座標へ、そうでなければ隣接座標(target)へ配置先を解決する
 */
function resolvePlacementTarget(base, target, rawNormal) {
    const baseX = Math.floor(base.x);
    const baseY = Math.floor(base.y);
    const baseZ = Math.floor(base.z);

    const baseRaw = getVoxelAtWorld(baseX, baseY, baseZ, true);
    const baseId = getRawBlockId(baseRaw);
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

// ======================================================
// 【統一ブロックアップデート基盤】(Minecraft Java Edition NC / PP Update 準拠)
// ======================================================
const MAX_BLOCK_UPDATE_DEPTH = 64;
let _blockUpdateDepth = 0;

const _ppUpdateCtx = {
    x: 0,
    y: 0,
    z: 0,
    blockId: 0,
    state: 0,
    fromX: 0,
    fromY: 0,
    fromZ: 0,
    dx: 0,
    dy: 0,
    dz: 0,
    oldRaw: 0,
    newRaw: 0,
    getRaw: _getWorldRawLoaded,
    getBlockId: _getWorldBlockIdLoaded,
    setBlock: null,
    scheduleTick: null
};

const _ncUpdateCtx = {
    x: 0,
    y: 0,
    z: 0,
    blockId: 0,
    state: 0,
    fromX: 0,
    fromY: 0,
    fromZ: 0,
    dx: 0,
    dy: 0,
    dz: 0,
    currentTick: 0,
    engine: null,
    getRaw: _getWorldRawLoaded,
    getBlockId: _getWorldBlockIdLoaded,
    setBlock: null,
    notifyBlock: null,
    scheduleTick: null
};

/**
 * PP アップデート（Post-Placement / BlockState 変化通知）
 * (fx, fy, fz) の BlockState が oldRaw -> newRaw へ変わったことを周囲6隣接へ通知する（オブザーバー等用）
 */
function notifyNeighborsPP(fx, fy, fz, oldRaw, newRaw) {
    if (oldRaw === newRaw || _blockUpdateDepth >= MAX_BLOCK_UPDATE_DEPTH) return;
    _blockUpdateDepth++;
    try {
        for (let i = 0; i < 6; i++) {
            const nx = fx + _NEIGHBOR_6_DX[i];
            const ny = fy + _NEIGHBOR_6_DY[i];
            const nz = fz + _NEIGHBOR_6_DZ[i];
            if (ny < 0 || ny >= CHUNK_HEIGHT) continue;

            const nRaw = _getWorldRawLoaded(nx, ny, nz);
            if (nRaw <= 0) continue;

            const nId = getRawBlockId(nRaw);
            const nCfg = _blockConfigFastArray[nId];
            if (!nCfg || typeof nCfg.onShapeUpdate !== "function") continue;

            _ppUpdateCtx.x = nx;
            _ppUpdateCtx.y = ny;
            _ppUpdateCtx.z = nz;
            _ppUpdateCtx.blockId = nId;
            _ppUpdateCtx.state = getRawLocalState(nRaw);
            _ppUpdateCtx.fromX = fx;
            _ppUpdateCtx.fromY = fy;
            _ppUpdateCtx.fromZ = fz;
            _ppUpdateCtx.dx = fx - nx;
            _ppUpdateCtx.dy = fy - ny;
            _ppUpdateCtx.dz = fz - nz;
            _ppUpdateCtx.oldRaw = oldRaw;
            _ppUpdateCtx.newRaw = newRaw;
            _ppUpdateCtx.setBlock = setWorldBlock;
            _ppUpdateCtx.scheduleTick = (delay, type = "redstone_device", priority = -1, payload = 0) => {
                TickScheduler.schedule(nx, ny, nz, delay, type, priority, payload);
            };
            nCfg.onShapeUpdate(_ppUpdateCtx);
        }
    } finally {
        _blockUpdateDepth--;
    }
}

/**
 * NC アップデート（Neighbor Changed 通知）
 * (fx, fy, fz) が変化したことを周囲6隣接の onBlockUpdate へ通知する（ピストン・BUD・落下ブロック用）
 */
function notifyNeighborsNC(fx, fy, fz) {
    if (_blockUpdateDepth >= MAX_BLOCK_UPDATE_DEPTH) return;
    _blockUpdateDepth++;
    try {
        for (let i = 0; i < 6; i++) {
            const nx = fx + _NEIGHBOR_6_DX[i];
            const ny = fy + _NEIGHBOR_6_DY[i];
            const nz = fz + _NEIGHBOR_6_DZ[i];
            if (ny < 0 || ny >= CHUNK_HEIGHT) continue;

            const nRaw = _getWorldRawLoaded(nx, ny, nz);
            if (nRaw <= 0) continue;

            const nId = getRawBlockId(nRaw);
            const nCfg = _blockConfigFastArray[nId];
            if (!nCfg || typeof nCfg.onBlockUpdate !== "function") continue;

            _ncUpdateCtx.x = nx;
            _ncUpdateCtx.y = ny;
            _ncUpdateCtx.z = nz;
            _ncUpdateCtx.blockId = nId;
            _ncUpdateCtx.state = getRawLocalState(nRaw);
            _ncUpdateCtx.fromX = fx;
            _ncUpdateCtx.fromY = fy;
            _ncUpdateCtx.fromZ = fz;
            _ncUpdateCtx.dx = fx - nx;
            _ncUpdateCtx.dy = fy - ny;
            _ncUpdateCtx.dz = fz - nz;
            _ncUpdateCtx.currentTick = worldTickCount;
            _ncUpdateCtx.engine = RedstoneEngine;
            _ncUpdateCtx.setBlock = setWorldBlock;
            _ncUpdateCtx.notifyBlock = notifyWorldBlockChanged;
            _ncUpdateCtx.scheduleTick = (delay, type = "redstone_device", priority = -1, payload = 0) => {
                TickScheduler.schedule(nx, ny, nz, delay, type, priority, payload);
            };
            nCfg.onBlockUpdate(_ncUpdateCtx);
        }
    } finally {
        _blockUpdateDepth--;
    }
}

/**
 * ワールド上のブロックを安全に書き換え、光源・チャンク・BlockEntity・NC/PPアップデート・回路・流体を一括連動させる統一API
 * （ピストン押し出し・オブザーバー・今後のコマンド/構造物変更の共通入口）
 */
function setWorldBlock(wx, wy, wz, newRaw, options = null) {
    const bx = wx | 0;
    const by = wy | 0;
    const bz = wz | 0;
    if (by < 0 || by >= CHUNK_HEIGHT) return false;

    const persist = options ? (options.persist !== false) : true;
    const notifyNC = options ? (options.notifyNC !== false) : true;
    const notifyPP = options ? (options.notifyPP !== false) : true;
    const notifyRedstone = options ? (options.notifyRedstone !== false) : true;
    const notifyFluid = options ? (options.notifyFluid !== false) : true;

    const oldRaw = _getWorldRawLoaded(bx, by, bz);
    if (oldRaw < 0) return false;

    const packed = newRaw & 0xFFFF;
    if (oldRaw === packed) return false;

    const oldId = getRawBlockId(oldRaw);
    const newId = getRawBlockId(packed);

    // ブロック書き込み・光源更新・チャンク更新・BlockEntity破棄（PP通知は下の統一手順で1回だけ実行）
    const changed = setBlockFromWorldTick(bx, by, bz, packed, persist, false);
    if (!changed) return false;

    if (oldId !== newId) {
        TickScheduler.cancelAt(bx, by, bz);
        const newCfg = _blockConfigFastArray[newId];
        if (newCfg && newCfg.blockEntityType) {
            BlockEntityManager.create(bx, by, bz, newCfg.blockEntityType);
        }
    }

    if (notifyPP) {
        notifyNeighborsPP(bx, by, bz, oldRaw, packed);
    }

    if (notifyNC && _blockUpdateDepth < MAX_BLOCK_UPDATE_DEPTH) {
        _blockUpdateDepth++;
        try {
            const extraCoords = updateNeighborBlockStates(bx, by, bz, _cascadeLightDirtySet);
            flushCascadeLightUpdates();
            notifyNeighborsNC(bx, by, bz);

            if (notifyRedstone) RedstoneEngine.onBlockChanged(bx, by, bz, oldRaw);
            if (notifyFluid) FluidEngine.onBlockChanged(bx, by, bz);

            for (let i = 0; i < extraCoords.length; i++) {
                const pos = extraCoords[i];
                TickScheduler.cancelAt(pos.x, pos.y, pos.z);
                notifyNeighborsNC(pos.x, pos.y, pos.z);
                if (notifyRedstone) RedstoneEngine.onBlockChanged(pos.x, pos.y, pos.z, pos.oldRaw || 0);
                if (notifyFluid) FluidEngine.onBlockChanged(pos.x, pos.y, pos.z);
                requestBlockSectionUpdate(pos.x, pos.y, pos.z);
            }
        } finally {
            _blockUpdateDepth--;
        }
    }

    return true;
}

/**
 * ブロックの書き換えを一切行わず、PP / NC / 隣接同期 / レッドストーン / 流体通知のみを安全に発火する
 * （ピストンの一括移動後に、連鎖動作した別ピストンの状態を上書きしないための専用通知API）
 */
function notifyWorldBlockChanged(wx, wy, wz, oldRaw = 0, newRaw = null) {
    const bx = wx | 0, by = wy | 0, bz = wz | 0;
    if (by < 0 || by >= CHUNK_HEIGHT) return;

    const currentRaw = (newRaw !== null && newRaw !== undefined)
        ? (newRaw & 0xFFFF)
        : _getWorldRawLoaded(bx, by, bz);
    if (currentRaw < 0) return;

    if ((oldRaw & 0xFFFF) !== currentRaw) {
        notifyNeighborsPP(bx, by, bz, oldRaw & 0xFFFF, currentRaw);
    }

    if (_blockUpdateDepth < MAX_BLOCK_UPDATE_DEPTH) {
        _blockUpdateDepth++;
        try {
            const extraCoords = updateNeighborBlockStates(bx, by, bz, _cascadeLightDirtySet);
            flushCascadeLightUpdates();
            notifyNeighborsNC(bx, by, bz);
            RedstoneEngine.onBlockChanged(bx, by, bz, oldRaw);
            FluidEngine.onBlockChanged(bx, by, bz);

            for (let i = 0; i < extraCoords.length; i++) {
                const pos = extraCoords[i];
                TickScheduler.cancelAt(pos.x, pos.y, pos.z);
                notifyNeighborsNC(pos.x, pos.y, pos.z);
                RedstoneEngine.onBlockChanged(pos.x, pos.y, pos.z, pos.oldRaw || 0);
                FluidEngine.onBlockChanged(pos.x, pos.y, pos.z);
                requestBlockSectionUpdate(pos.x, pos.y, pos.z);
            }
        } finally {
            _blockUpdateDepth--;
        }
    }
}

/**
 * ブロック設置・破壊後に自身および周囲6近傍の接続同期・支持チェック・宣言的 onNeighborChange を一括処理する
 * @returns {Array<{x: number, y: number, z: number}>} 追加でチャンク更新が必要になった座標リスト
 */
const _cascadeLightDirtySet = new Map();

function flushCascadeLightUpdates() {
    if (_cascadeLightDirtySet.size === 0) return;
    for (const [dKey, dMask] of _cascadeLightDirtySet.entries()) {
        if (loadedChunks.has(dKey)) {
            requestChunkUpdateMaskByKey(dKey, dMask);
        }
    }
    _cascadeLightDirtySet.clear();
}

function updateNeighborBlockStates(originX, originY, originZ, outLightDirty = _lightDirtySet) {
    _cascadeVisited.clear();
    let extraCoords = null;

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
        const id = getRawBlockId(raw);
        if (id === BLOCK_TYPES.SKY) continue;

        const meta = getRawLocalState(raw);
        const cfg = getBlockConfiguration(id);
        if (!cfg) continue;

        // 1. 宣言的 autoSyncConnection 対象ブロックの接続メタデータを保存データへ自動同期
        if (cfg.autoSyncConnection) {
            const newMask = getConnectionMask(wx, wy, wz, cfg.geometryType);
            if (newMask !== meta) {
                const cx = wx >> 4;
                const cz = wz >> 4;
                ChunkSaveManager.setBlock(cx, cz, wx & 15, wy, wz & 15, packRawBlock(id, newMask));
                if (wx !== originX || wy !== originY || wz !== originZ) {
                    if (!extraCoords) extraCoords = [];
                    extraCoords.push({ x: wx, y: wy, z: wz, oldRaw: raw });
                }
            }
            continue;
        }

        // 2. 支持依存ブロック（ハシゴ・カーペット・植物等）が支持を失っていれば破壊して周囲へ連鎖
        if (isSupportDependentBlock(id) && !canPlaceBlockAt(id, meta, wx, wy, wz, _getBlockIdForPlacement, _getRawForPlacement)) {
            const cx = wx >> 4;
            const cz = wz >> 4;
            _particleCenterTmp.set(wx + 0.5, wy + 0.5, wz + 0.5);
            createMinecraftBreakParticles(_particleCenterTmp, id, 0.8);
            BlockEntityManager.remove(wx, wy, wz);
            ChunkSaveManager.setBlock(cx, cz, wx & 15, wy, wz & 15, BLOCK_TYPES.SKY);
            updateLightAtBlockChange(wx, wy, wz, raw, BLOCK_TYPES.SKY, outLightDirty);

            if (wx !== originX || wy !== originY || wz !== originZ) {
                if (!extraCoords) extraCoords = [];
                extraCoords.push({ x: wx, y: wy, z: wz, oldRaw: raw });
            }

            for (let i = 0; i < 6; i++) {
                enqueue(wx + _NEIGHBOR_6_DX[i], wy + _NEIGHBOR_6_DY[i], wz + _NEIGHBOR_6_DZ[i]);
            }
            continue;
        }

        // 3. 宣言的 onNeighborChange フック（例：草ブロックの snowy 切替、将来ブロックの状態変化など）
        if (typeof cfg.onNeighborChange === "function") {
            _neighborHookCtx.x = wx;
            _neighborHookCtx.y = wy;
            _neighborHookCtx.z = wz;
            _neighborHookCtx.blockId = id;
            _neighborHookCtx.state = meta;

            const result = cfg.onNeighborChange(_neighborHookCtx);
            let nextRaw = raw;

            if (typeof result === "number" && result >= 0) {
                nextRaw = packRawBlock(id, result);
            } else if (result && typeof result === "object" && typeof result.id === "number") {
                const nextState = (result.state !== undefined) ? result.state : 0;
                nextRaw = packRawBlock(result.id, nextState);
            }

            if (nextRaw !== raw) {
                const cx = wx >> 4;
                const cz = wz >> 4;
                ChunkSaveManager.setBlock(cx, cz, wx & 15, wy, wz & 15, nextRaw);
                updateLightAtBlockChange(wx, wy, wz, raw, nextRaw, outLightDirty);

                if (wx !== originX || wy !== originY || wz !== originZ) {
                    if (!extraCoords) extraCoords = [];
                    extraCoords.push({ x: wx, y: wy, z: wz, oldRaw: raw });
                }

                for (let i = 0; i < 6; i++) {
                    enqueue(wx + _NEIGHBOR_6_DX[i], wy + _NEIGHBOR_6_DY[i], wz + _NEIGHBOR_6_DZ[i]);
                }
            }
        }
    }

    return extraCoords || _EMPTY_EXTRA_COORDS;
}

const _updatedChunkSetTmp = new Set();

function interactWithBlock(action) {
    if (action !== "place" && action !== "destroy") return;

    const EPS = 1e-6;
    const TOP_FACE_THRESHOLD = 0.9;

    // --- 1. 統一ボクセルレイキャスト（黒枠・HUD・操作で100%同一アルゴリズムを使用） ---
    camera.getWorldDirection(_workVec3_CamDir);
    const includeWater = (action === "destroy" && (activeBlockType === BLOCK_TYPES.WATER || activeBlockType === BLOCK_TYPES.LAVA));
    const hit = raycastVoxel(camera.position, _workVec3_CamDir, BLOCK_INTERACT_RANGE, includeWater);
    if (!hit) return;

    // --- 2. ヒット座標および配置先（置換含む）の解決 ---
    const rawNormal = hit.normal;
    _interactBaseVec.set(hit.x, hit.y, hit.z);
    _interactTargetVec.set(hit.x + rawNormal.x, hit.y + rawNormal.y, hit.z + rawNormal.z);

    let bx, by, bz;
    let effectiveNormal = rawNormal;
    let isReplacingBase = false;
    let isSlabMerge = false;

    if (action === "place") {
        const hitCfgForSlab = getBlockConfiguration(hit.blockId);
        if (
            hit.blockId === activeBlockType &&
            hitCfgForSlab && hitCfgForSlab.isSlab === true &&
            hasBlockStateProp(hit.blockId, "type")
        ) {
            const hitSlabType = getBlockStateProp(hit.blockId, hit.metadata, "type");
            if (
                (hitSlabType === "bottom" && rawNormal.y > 0.5) ||
                (hitSlabType === "top" && rawNormal.y < -0.5)
            ) {
                bx = hit.x;
                by = hit.y;
                bz = hit.z;
                effectiveNormal = rawNormal;
                isReplacingBase = true;
                isSlabMerge = true;
            }
        }

        if (!isSlabMerge) {
            const resolved = resolvePlacementTarget(_interactBaseVec, _interactTargetVec, rawNormal);
            bx = resolved.bx;
            by = resolved.by;
            bz = resolved.bz;
            effectiveNormal = resolved.effectiveNormal;
            isReplacingBase = resolved.replacingBase;
        }
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
    const voxelIdOnly = getRawBlockId(voxel);
    const cfg = getBlockConfiguration(voxelIdOnly);

    // 側面クリック等で配置先(bx,by,bz)に既に同種の片側スラブがある場合もダブル化合体を許可
    if (
        action === "place" &&
        !isSlabMerge &&
        voxelIdOnly === activeBlockType &&
        cfg && cfg.isSlab === true &&
        hasBlockStateProp(voxelIdOnly, "type") &&
        getBlockStateProp(voxelIdOnly, getRawLocalState(voxel), "type") !== "double"
    ) {
        isSlabMerge = true;
    }

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
        BlockEntityManager.remove(bx, by, bz);
        ChunkSaveManager.setBlock(cx, cz, lx, by, lz, BLOCK_TYPES.SKY);
        updateLightAtBlockChange(bx, by, bz, voxel, BLOCK_TYPES.SKY, _lightDirtySet);
        if (cfg && typeof cfg.onDestroy === "function") {
            cfg.onDestroy({
                x: bx,
                y: by,
                z: bz,
                blockId: voxelIdOnly,
                state: getRawLocalState(voxel),
                getRaw: _getRawForPlacement,
                setBlock: setWorldBlock
            });
        }
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
            const hitId = getRawBlockId(hitRaw);
            const currentState = getRawLocalState(hitRaw);

            let hitBE = BlockEntityManager.get(hit.x, hit.y, hit.z);
            if (!hitBE && hitCfg.blockEntityType) {
                hitBE = BlockEntityManager.create(hit.x, hit.y, hit.z, hitCfg.blockEntityType);
            }

            const nextState = hitCfg.onInteract({
                x: hit.x,
                y: hit.y,
                z: hit.z,
                blockId: hitId,
                state: currentState,
                normal: rawNormal,
                point: hit.point,
                activeBlockType,
                blockEntity: hitBE,
                openContainer: (be) => {
                    if (be && ContainerUI) ContainerUI.open(be);
                },
                getBlock: _getBlockIdForPlacement,
                getRaw: _getRawForPlacement,
                setBlock: setWorldBlock,
                scheduleTick: (delay, type, priority = 0, payload = 0) =>
                    TickScheduler.schedule(hit.x, hit.y, hit.z, delay, type, priority, payload)
            });

            if (nextState === "consumed") {
                stopInteraction("right");
                stopInteraction("touch");
                return;
            }

            if (typeof nextState === "number" && nextState >= 0) {
                const updatedRaw = packRawBlock(hitId, nextState);
                _lightDirtySet.clear();
                ChunkSaveManager.setBlock(hCx, hCz, hit.x & 15, hit.y, hit.z & 15, updatedRaw);
                updateLightAtBlockChange(hit.x, hit.y, hit.z, hitRaw, updatedRaw, _lightDirtySet);
                updateNeighborBlockStates(hit.x, hit.y, hit.z);
                notifyNeighborsPP(hit.x, hit.y, hit.z, hitRaw, updatedRaw);
                notifyNeighborsNC(hit.x, hit.y, hit.z);
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

        // 同一座標への連続長押し重複設置ガード（スラブ合体時は許可）
        if (!isSlabMerge && candidateHash === lastPlacedKey) return;

        // 置換・上書き可否判定（空気・水・overwrite属性ブロック・スラブ合体のみ許可）
        if (voxelIdOnly !== BLOCK_TYPES.SKY) {
            if (!(isSlabMerge || cfg?.geometryType === "water" || cfg?.overwrite === true)) return;
        }

        // 1) 配置メタデータ（向き・反転・接続マスク・onPlace 初期ステート）を事前確定
        let meta = isSlabMerge
            ? setBlockStateProp(activeBlockType, 0, "type", "double")
            : calculatePlacementMeta(activeBlockType, _workVec3_CamDir, effectiveNormal, hit.point);
        if (meta < 0) return;

        if (newBlockCfg.autoSyncConnection) {
            meta = getConnectionMask(bx, by, bz, newBlockCfg.geometryType);
        }

        if (typeof newBlockCfg.onPlace === "function") {
            _neighborHookCtx.x = bx;
            _neighborHookCtx.y = by;
            _neighborHookCtx.z = bz;
            _neighborHookCtx.blockId = activeBlockType;
            _neighborHookCtx.state = meta;
            const placedMeta = newBlockCfg.onPlace(_neighborHookCtx);
            if (typeof placedMeta === "number" && placedMeta >= 0) {
                meta = placedMeta & (newBlockCfg.stateMask ?? 0xFFF);
            }
        }

        // 2) 支持条件（壁面・土壌・下面）チェック
        if (!canPlaceBlockAt(activeBlockType, meta, bx, by, bz, _getBlockIdForPlacement, _getRawForPlacement)) return;

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

        // 5) ブロック確定書き込み ＋ BlockEntity生成 ＋ 2フェーズ インクリメンタル光源更新
        const blockDataToSave = packRawBlock(activeBlockType, meta);
        _lightDirtySet.clear();
        if (voxelIdOnly !== activeBlockType) {
            BlockEntityManager.remove(bx, by, bz);
        }
        ChunkSaveManager.setBlock(cx, cz, lx, by, lz, blockDataToSave);
        if (newBlockCfg.blockEntityType) {
            BlockEntityManager.create(bx, by, bz, newBlockCfg.blockEntityType);
        }
        updateLightAtBlockChange(bx, by, bz, voxel, blockDataToSave, _lightDirtySet);

        if (typeof newBlockCfg.onAfterPlace === "function") {
            newBlockCfg.onAfterPlace({
                x: bx,
                y: by,
                z: bz,
                blockId: activeBlockType,
                state: meta,
                getBlock: _getBlockIdForPlacement,
                getRaw: _getRawForPlacement,
                setBlock: setWorldBlock
            });
        }
        lastPlacedKey = candidateHash;
        if (isSlabMerge) {
            stopInteraction("right");
            stopInteraction("touch");
        }
    }

    // --- 5. 予約Tickキャンセル ＆ 隣接ブロック状態同期 ＆ NC/PP・レッドストーン・流体更新 ---
    const writtenRaw = ChunkSaveManager.getBlock(cx, cz, lx, by, lz) ?? BLOCK_TYPES.SKY;
    TickScheduler.cancelAt(bx, by, bz);
    const extraCoords = updateNeighborBlockStates(bx, by, bz);
    notifyNeighborsPP(bx, by, bz, voxel, writtenRaw);
    notifyNeighborsNC(bx, by, bz);
    RedstoneEngine.onBlockChanged(bx, by, bz, voxel);
    FluidEngine.onBlockChanged(bx, by, bz);

    // --- 6. チャンク・UI更新（光が変わった全チャンクを含め重複なしで再構築） ---
    updateAffectedChunks({ x: bx, y: by, z: bz }, false, _lightDirtySet);

    for (let i = 0; i < extraCoords.length; i++) {
        const pos = extraCoords[i];
        TickScheduler.cancelAt(pos.x, pos.y, pos.z);
        notifyNeighborsNC(pos.x, pos.y, pos.z);
        RedstoneEngine.onBlockChanged(pos.x, pos.y, pos.z, pos.oldRaw || 0);
        FluidEngine.onBlockChanged(pos.x, pos.y, pos.z);
        updateAffectedChunks(pos, false, null);
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

// --- 選択管理・インベントリ・ホットバー・プレビュー（./ui/inventory_ui.js へ分離済） ---
let activeBlockType = 0;
let selectedHotbarIndex = 0;

const InventoryUI = createInventoryUI({
    BLOCK_CONFIG,
    BLOCK_TYPES,
    getBlockConfiguration,
    getBlockGeometry,
    getBlockMaterialsFast,
    idToKey,
    keyToId,
    onActiveBlockChanged: (blockId, slotIdx) => {
        activeBlockType = blockId;
        selectedHotbarIndex = slotIdx;
    },
    onOpenChanged: (opened) => {
        isInventoryOpen = opened;
        if (opened) {
            releaseAllActiveInputs();
            if (document.pointerLockElement && document.exitPointerLock) {
                document.exitPointerLock();
            }
        }
    }
});

/* ======================================================
   【ウィンドウのリサイズ・スマホ画面回転対応】
   ====================================================== */
function syncViewportSize() {
    const vv = window.visualViewport;
    const width = Math.max(1, Math.round(vv ? vv.width : window.innerWidth));
    const height = Math.max(1, Math.round(vv ? vv.height : window.innerHeight));

    // 回転時に残るブラウザの意図しないスクロールオフセットをリセット
    if (window.scrollX !== 0 || window.scrollY !== 0) {
        window.scrollTo(0, 0);
    }

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!renderer) return;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO));
    renderer.setSize(width, height, true);
}

window.addEventListener('resize', syncViewportSize);
window.addEventListener('orientationchange', () => {
    syncViewportSize();
    // モバイルブラウザは回転アニメーション完了後に最終サイズが確定するため遅延再同期
    setTimeout(syncViewportSize, 120);
    setTimeout(syncViewportSize, 350);
});
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportSize);
}

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

    const blockId = getRawBlockId(rawValue);
    const meta = getRawLocalState(rawValue);
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
let isInsideWorldTick = false;
let isHandlingScheduledTicks = false;
let ticksInSecond = 0;
let measuredTps = WORLD_TPS;
let chunkUpdatesInSecond = 0;
let measuredChunkUpdates = 0;

// タイマー管理用
let chunkUpdateFrameTimer = 0;
let chunkCacheEvictTimer = 0;
let blockInfoTimer = 0;

// 最適化：再利用するベクトル・フラスタム群（ゼロGC）
const _camOffset = new THREE.Vector3();
const _tempVec3 = new THREE.Vector3();
const _interpPlayerPos = new THREE.Vector3();
const _tickLightDirtySet = new Map();
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
    const buckets = new Map();        // Map<targetTick, Array<Task>>
    const activeByCoord = new Map();  // Map<coordKey, Array<Task>>（高速キャンセル＆重複抑制用）
    const deferredByChunk = new Map();// Map<chunkKey, Array<SerializedTask>>（未ロードチャンクの保留Tick）
    const handlers = new Map();       // Map<type, Function(task, currentTick)>
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

    function deferTaskForChunk(chunkKey, x, y, z, delay, type, priority, payload) {
        let list = deferredByChunk.get(chunkKey);
        if (!list) {
            list = [];
            deferredByChunk.set(chunkKey, list);
        }
        // 未ロード保留キュー側も同一座標・同一種別の二重登録を抑止
        for (let i = 0; i < list.length; i++) {
            const item = list[i];
            if (item.x === x && item.y === y && item.z === z && item.type === type) {
                return;
            }
        }
        list.push({ x, y, z, delay: delay > 1 ? (delay | 0) : 1, type, priority: priority | 0, payload: payload | 0 });
    }

    const scheduler = {
        get pendingCount() {
            return pendingCount;
        },

        registerHandler(type, fn) {
            handlers.set(type, fn);
        },

        hasScheduled(wx, wy, wz, type = null) {
            const coordKey = encodeWorldBlockKey(wx | 0, wy | 0, wz | 0);
            const coordList = activeByCoord.get(coordKey);
            if (!coordList) return false;
            for (let i = 0; i < coordList.length; i++) {
                const existing = coordList[i];
                if (!existing.cancelled && (type === null || existing.type === type)) {
                    return true;
                }
            }
            return false;
        },

        schedule(wx, wy, wz, delayTicks, type, priority = 0, payload = 0) {
            const x = wx | 0, y = wy | 0, z = wz | 0;
            if (y < 0 || y >= CHUNK_HEIGHT) return;

            const delay = delayTicks > 1 ? (delayTicks | 0) : 1;
            const baseTick = isInsideWorldTick ? worldTickCount : (worldTickCount + 1);
            const targetTick = baseTick + delay;
            const coordKey = encodeWorldBlockKey(x, y, z);

            // Minecraft Java Edition LevelTicks.hasScheduledTick 準拠:
            // 同一座標・同一種別の未消化Tickが既に存在する場合は重複登録しない（クロック倍速防止）
            let coordList = activeByCoord.get(coordKey);
            if (coordList) {
                for (let i = 0; i < coordList.length; i++) {
                    const existing = coordList[i];
                    if (!existing.cancelled && existing.type === type) {
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

        onChunkLoaded(cx, cz) {
            const chunkKey = encodeChunkKey(cx, cz);
            const list = deferredByChunk.get(chunkKey);
            if (!list) return;
            deferredByChunk.delete(chunkKey);

            for (let i = 0; i < list.length; i++) {
                const item = list[i];
                scheduler.schedule(item.x, item.y, item.z, item.delay, item.type, item.priority, item.payload);
            }
        },

        exportState() {
            const out = [];
            for (const bucket of buckets.values()) {
                for (let i = 0; i < bucket.length; i++) {
                    const t = bucket[i];
                    if (t.cancelled || !t.type) continue;
                    const delay = t.targetTick - worldTickCount;
                    out.push({
                        x: t.x,
                        y: t.y,
                        z: t.z,
                        delay: delay > 1 ? delay : 1,
                        type: t.type,
                        priority: t.priority,
                        payload: t.payload
                    });
                }
            }
            for (const list of deferredByChunk.values()) {
                for (let i = 0; i < list.length; i++) {
                    const d = list[i];
                    out.push({
                        x: d.x,
                        y: d.y,
                        z: d.z,
                        delay: d.delay,
                        type: d.type,
                        priority: d.priority,
                        payload: d.payload
                    });
                }
            }
            return out;
        },

        importState(savedTicks) {
            if (!Array.isArray(savedTicks)) return;
            for (let i = 0; i < savedTicks.length; i++) {
                const item = savedTicks[i];
                if (!item || typeof item.type !== "string") continue;
                const x = item.x | 0, y = item.y | 0, z = item.z | 0;
                const delay = item.delay > 1 ? (item.delay | 0) : 1;
                const chunkKey = encodeChunkKey(x >> 4, z >> 4);

                if (loadedChunks.has(chunkKey)) {
                    scheduler.schedule(x, y, z, delay, item.type, item.priority | 0, item.payload | 0);
                } else {
                    deferTaskForChunk(chunkKey, x, y, z, delay, item.type, item.priority | 0, item.payload | 0);
                }
            }
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

                    const chunkKey = encodeChunkKey(task.x >> 4, task.z >> 4);
                    if (!loadedChunks.has(chunkKey)) {
                        // 描画範囲外へアンロードされたチャンクは捨てずに保留し、再訪問時に再開
                        deferTaskForChunk(chunkKey, task.x, task.y, task.z, 1, task.type, task.priority, task.payload);
                    } else {
                        const handler = handlers.get(task.type);
                        if (handler) handler(task, currentTick);
                    }
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
            deferredByChunk.clear();
            pendingCount = 0;
        }
    };

    return scheduler;
})();

/* ======================================================
   【レッドストーン信号伝播エンジン】(redstone_engine.js へ分離済)
   ====================================================== */
/**
 * プレイヤーの AABB が指定ブロック上の感圧板検出領域 (x+0.125..x+0.875, y..y+0.25, z+0.125..z+0.875) に
 * 重なっているか判定する（Minecraft Java Edition BasePressurePlateBlock.TOUCH_AABB 準拠・ゼロGC）
 */
const PlayerData = createPlayerData();

const EntityManager = createEntityManager({
    scene,
    chunkHeight: CHUNK_HEIGHT,
    isChunkLoaded: (cx, cz) => loadedChunks.has(encodeChunkKey(cx, cz)),
    getWorldBlockIdLoaded: _getWorldBlockIdLoaded,
    blockConfigFastArray: _blockConfigFastArray,
    getLightBrightnessAt: (wx, wy, wz) => {
        const cell = _getWorldLightCell(wx, wy, wz);
        if (cell < 0) return 1.0;
        const sky = LIGHT_LEVEL_FACTORS[(cell >> 4) & 15] * SHARED_SKY_UNIFORM.value;
        const blk = LIGHT_LEVEL_FACTORS[cell & 15];
        const lit = Math.max(sky, blk) * SHARED_BRIGHTNESS_UNIFORM.value;
        return Math.max(0.08, Math.min(1.0, lit));
    },
    getPlayerPosition: () => (player ? player.position : null)
});

let isContainerOpen = false;

const ContainerUI = createContainerUI({
    getBlockConfiguration,
    keyToId,
    idToKey,
    createPreview: (cfg) => InventoryUI.createInventoryItemPreview(cfg),
    getHotbarKeys: () => InventoryUI.getHotbarKeys(),
    setHotbarSlotKey: (slotIdx, key) => InventoryUI.setHotbarSlotKey(slotIdx, key),
    onOpenChanged: (opened, be) => {
        isContainerOpen = opened;
        if (be && be.type === "minecraft:chest") {
            ChestAnimator.setOpen(be.x, be.y, be.z, opened);
        }
        if (opened) {
            releaseAllActiveInputs();
            if (document.pointerLockElement && document.exitPointerLock) {
                document.exitPointerLock();
            }
        } else if (!isPaused && !isInventoryOpen && renderer && renderer.domElement.requestPointerLock) {
            renderer.domElement.requestPointerLock();
        }
    },
    onContainerModified: (be) => {
        if (be) RedstoneEngine.onBlockChanged(be.x, be.y, be.z);
    },
    addChatMessage
});

const BlockEntityManager = createBlockEntityManager({
    isChunkLoaded: (cx, cz) => loadedChunks.has(encodeChunkKey(cx, cz)),
    getWorldRawLoaded: _getWorldRawLoaded,
    setBlockFromWorldTick,
    setBlockStateProp,
    onMessage: (text, color) => {
        if (typeof addChatMessage === "function") addChatMessage(text, color);
    },
    onInventoryChanged: (wx, wy, wz) => {
        RedstoneEngine.onBlockChanged(wx, wy, wz);
    }
});

const PistonAnimator = createPistonAnimator({
    scene,
    getBlockConfiguration,
    getBlockGeometry,
    getBlockMaterialsFast,
    getTransformMeta,
    getCustomGeometryMatrix,
    getLogRotationMatrixReadOnly,
    getWorldLightCell: _getWorldLightCell,
    lightLevelFactors: LIGHT_LEVEL_FACTORS,
    requestChunkUpdate,
    blockTypes: BLOCK_TYPES
});
registerPistonAnimator(PistonAnimator.onPistonAction);

const ChestAnimator = createChestAnimator({
    scene,
    getWorldRawLoaded: _getWorldRawLoaded,
    getBlockMaterialsFast,
    getTransformMeta,
    getWorldLightCell: _getWorldLightCell,
    lightLevelFactors: LIGHT_LEVEL_FACTORS,
    requestBlockSectionUpdate,
    blockTypes: BLOCK_TYPES
});

function isPlayerSteppingOnBlock(wx, wy, wz) {
    if (!player) return false;
    const aabb = getPlayerAABB(player.position);
    return (
        aabb.max.x > wx + 0.125 && aabb.min.x < wx + 0.875 &&
        aabb.max.y > wy && aabb.min.y < wy + 0.25 &&
        aabb.max.z > wz + 0.125 && aabb.min.z < wz + 0.875
    );
}

/**
 * プレイヤーまたはモブが感圧板検出領域に乗っているか判定（Java Edition 準拠）
 */
function isAnyEntityOnBlock(wx, wy, wz) {
    if (isPlayerSteppingOnBlock(wx, wy, wz)) return true;
    return EntityManager.isAnyEntityInBox(wx + 0.125, wy, wz + 0.125, wx + 0.875, wy + 0.25, wz + 0.875);
}

const _burnoutParticleVec = new THREE.Vector3();
const RedstoneEngine = createRedstoneEngine({
    chunkHeight: CHUNK_HEIGHT,
    isOpaqueBlock: _isOpaqueBlock,
    isRedstoneConductive: _isRedstoneConductive,
    blockConfigFastArray: _blockConfigFastArray,
    getWorldRawLoaded: _getWorldRawLoaded,
    setBlockFromWorldTick: (wx, wy, wz, newRaw) => setBlockFromWorldTick(wx, wy, wz, newRaw, true),
    setWorldBlock,
    notifyWorldBlockChanged,
    isCoordInTransit: PistonEngine.isCoordInTransit,
    tickScheduler: TickScheduler,
    getCurrentTick: () => worldTickCount,
    isEntityOnBlock: isAnyEntityOnBlock,
    getBlockEntity: (wx, wy, wz) => BlockEntityManager.get(wx, wy, wz),
    ensureBlockEntity: (wx, wy, wz, typeId) => BlockEntityManager.get(wx, wy, wz) || BlockEntityManager.create(wx, wy, wz, typeId),
    getContainerAnalogSignal: (wx, wy, wz) => BlockEntityManager.getAnalogSignal(wx, wy, wz),
    onTorchBurnout: (wx, wy, wz) => {
        _burnoutParticleVec.set(wx + 0.5, wy + 0.65, wz + 0.5);
        createMinecraftBreakParticles(_burnoutParticleVec, BLOCK_TYPES.REDSTONE_TORCH, 0.6);
    }
});

PistonEngine.init({
    getRaw: _getWorldRawLoaded,
    setBlock: setWorldBlock,
    notifyBlock: notifyWorldBlockChanged,
    getEngine: () => RedstoneEngine,
    getCurrentTick: () => worldTickCount,
    isHandlingScheduledTicks: () => isHandlingScheduledTicks
});

/* ======================================================
   【流体シミュレーションエンジン】(fluid_engine.js へ分離済)
   ====================================================== */
const _fluidParticleVec = new THREE.Vector3();
const FluidEngine = createFluidEngine({
    chunkHeight: CHUNK_HEIGHT,
    isOpaqueBlock: _isOpaqueBlock,
    blockConfigFastArray: _blockConfigFastArray,
    getWorldRawLoaded: _getWorldRawLoaded,
    setBlockFromWorldTick: (wx, wy, wz, newRaw, srcX = wx, srcZ = wz) => {
        const srcKey = encodeChunkKey(srcX >> 4, srcZ >> 4);
        const persist = ChunkSaveManager.playerModifiedKeys.has(srcKey);
        return setBlockFromWorldTick(wx, wy, wz, newRaw, persist);
    },
    tickScheduler: TickScheduler,
    onFluidReplacedBlock: (wx, wy, wz, oldRaw) => {
        const oldId = getRawBlockId(oldRaw);
        _fluidParticleVec.set(wx + 0.5, wy + 0.5, wz + 0.5);
        createMinecraftBreakParticles(_fluidParticleVec, oldId, 0.7);
        RedstoneEngine.onBlockChanged(wx, wy, wz);
    }
});

function setBlockFromWorldTick(wx, wy, wz, newRaw, forcePersist = false, emitPP = true) {
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

    // ブロック種自体が変わった時のみ BlockEntity を破棄（かまどの lit 切替等の状態変更では保持）
    if (getRawBlockId(oldRaw) !== getRawBlockId(packed)) {
        BlockEntityManager.remove(wx, wy, wz);
    }
    dataArray[idx] = packed;
    if (forcePersist) {
        ChunkSaveManager.playerModifiedKeys.add(key);
        ChunkSaveManager.dirtySaveKeys.add(key);
    } else if (ChunkSaveManager.playerModifiedKeys.has(key)) {
        ChunkSaveManager.dirtySaveKeys.add(key);
    }

    _tickLightDirtySet.clear();
    updateLightAtBlockChange(wx, wy, wz, oldRaw, packed, _tickLightDirtySet);

    requestBlockSectionUpdate(wx, wy, wz);

    for (const [dKey, dMask] of _tickLightDirtySet.entries()) {
        if (loadedChunks.has(dKey)) {
            requestChunkUpdateMaskByKey(dKey, dMask);
        }
    }

    if (emitPP) {
        notifyNeighborsPP(wx, wy, wz, oldRaw, packed);
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

// ランダムTickフック用再利用コンテキスト（ゼロGC）
const _randomTickCtx = {
    x: 0,
    y: 0,
    z: 0,
    blockId: 0,
    state: 0,
    raw: 0,
    chunkHeight: CHUNK_HEIGHT,
    getBlockId: _getWorldBlockIdLoaded,
    getRaw: _getWorldRawLoaded,
    getLightOpacity: getBlockLightOpacity,
    getLightLevel: _getWorldLightCell,
    setBlock: setBlockFromWorldTick,
    nextRng: nextTickRng
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

            const blockId = getRawBlockId(raw);
            const cfg = _blockConfigFastArray[blockId];
            if (cfg && typeof cfg.onRandomTick === "function") {
                _randomTickCtx.x = baseX + lx;
                _randomTickCtx.y = ly;
                _randomTickCtx.z = baseZ + lz;
                _randomTickCtx.blockId = blockId;
                _randomTickCtx.state = getRawLocalState(raw);
                _randomTickCtx.raw = raw;
                cfg.onRandomTick(_randomTickCtx);
                continue;
            }

            const handler = RANDOM_TICK_HANDLERS[blockId];
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

    const prevOnGround = player.onGround;
    resolvePlayerCollision();
    updateOnGround();

    // サバイバルモード時の落下ダメージ計算（Java Edition 準拠: 3マス超の落下で1ダメージ/マス）
    if (PlayerData.data.gameMode === GAME_MODES.SURVIVAL && !flightMode && !wasUnderwater) {
        if (!player.onGround && player.velocity.y < 0) {
            const dy = player.prevPosition.y - player.position.y;
            if (dy > 0) PlayerData.data.fallDistance += dy;
        } else if (player.onGround && !prevOnGround) {
            const dmg = Math.floor(PlayerData.data.fallDistance - 3.0);
            if (dmg > 0) {
                PlayerData.data.health = Math.max(0, PlayerData.data.health - dmg);
                addChatMessage(`落下ダメージ -${dmg} (HP: ${PlayerData.data.health}/20)`, "#ff5555");
                if (PlayerData.data.health <= 0) {
                    PlayerData.data.health = PlayerData.data.maxHealth;
                    PlayerData.data.foodLevel = 20;
                    player.position.set(spawnX, Math.max(getTerrainHeight(spawnX, spawnZ), SEA_LEVEL + 2) + 2, spawnZ);
                    player.prevPosition.copy(player.position);
                    player.velocity.set(0, 0, 0);
                    addChatMessage("リスポーンしました", "#ffff55");
                }
            }
            PlayerData.data.fallDistance = 0;
        } else if (player.onGround) {
            PlayerData.data.fallDistance = 0;
        }
    } else {
        PlayerData.data.fallDistance = 0;
    }

    resetLastPlacedIfOnGround();
}

const _entityStepCtx = {
    x: 0,
    y: 0,
    z: 0,
    blockId: 0,
    state: 0,
    cfg: null,
    setState: null,
    scheduleTick: null
};

function triggerEntityStepAt(x, y, z) {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    const raw = _getWorldRawLoaded(x, y, z);
    if (raw <= 0) return;
    const id = getRawBlockId(raw);
    const cfg = _blockConfigFastArray[id];
    if (!cfg || typeof cfg.onEntityStep !== "function") return;
    if (!isAnyEntityOnBlock(x, y, z)) return;

    _entityStepCtx.x = x;
    _entityStepCtx.y = y;
    _entityStepCtx.z = z;
    _entityStepCtx.blockId = id;
    _entityStepCtx.state = getRawLocalState(raw);
    _entityStepCtx.cfg = cfg;
    _entityStepCtx.setState = (nextMeta) => {
        const packed = packRawBlock(id, nextMeta);
        if (setBlockFromWorldTick(x, y, z, packed, true)) {
            RedstoneEngine.onBlockChanged(x, y, z);
        }
    };
    _entityStepCtx.scheduleTick = (delay, type = "redstone_device", priority = -1, payload = 0) => {
        TickScheduler.schedule(x, y, z, delay, type, priority, payload);
    };
    cfg.onEntityStep(_entityStepCtx);
}

/**
 * プレイヤー＋全モブの足元と重なるブロックの onEntityStep フックを実行（感圧板等）
 */
function processEntityBlockSteps() {
    if (player) {
        const aabb = getPlayerAABB(player.position);
        const ix0 = Math.floor(aabb.min.x) | 0, ix1 = Math.floor(aabb.max.x) | 0;
        const iy0 = Math.floor(aabb.min.y) | 0, iy1 = Math.floor(aabb.max.y) | 0;
        const iz0 = Math.floor(aabb.min.z) | 0, iz1 = Math.floor(aabb.max.z) | 0;
        for (let y = iy0; y <= iy1; y++) {
            for (let x = ix0; x <= ix1; x++) {
                for (let z = iz0; z <= iz1; z++) {
                    triggerEntityStepAt(x, y, z);
                }
            }
        }
    }

    const ents = EntityManager.entities;
    for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        triggerEntityStepAt(Math.floor(e.x), Math.floor(e.y), Math.floor(e.z));
    }
}

function runWorldTick(pCx, pCz) {
    worldTickCount++;
    ticksInSecond++;
    isInsideWorldTick = true;
    try {
        gameTime = (gameTime + TIME_SPEED) % TICKS_PER_DAY;
        EntityManager.tick();
        BlockEntityManager.tick();
        processEntityBlockSteps();
        isHandlingScheduledTicks = true;
        try {
            TickScheduler.processTick(worldTickCount);  // Phase 1: リピーター・トーチ・ボタン
        } finally {
            isHandlingScheduledTicks = false;
        }
        PistonEngine.runBlockEvents(worldTickCount);    // Phase 2: ピストン BlockEvent 実行
        PistonEngine.tickMovingBlocks(worldTickCount);  // Phase 3: 移動中ブロック(2gt)の到着確定
        processRandomTicks(pCx, pCz);
        ContainerUI.refreshIfOpen();
        ContainerUI.updateSurvivalHUD(PlayerData.data);
    } finally {
        isInsideWorldTick = false;
    }
}

/**
 * Java Edition 準拠 セクション可視グラフ(VisGraph) ＋ 視錐台 BFS オクルージョンカリング
 */
function updateChunkFrustumCulling() {
    OcclusionCuller.update(loadedChunks, camera, CHUNK_VISIBLE_DISTANCE);
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
            SkySystem.update(gameTime);
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

        // 1-C. パーティクル・雲スクロール・ピストンアニメーション更新
        updateBlockParticles(delta);
        updateCloudTiles(delta);
        PistonAnimator.update(delta);
        ChestAnimator.update(delta);
    } else {
        // ポーズ中は残余アキュムレータを破棄し、再開時のワープを防止
        physicsAccumulator = 0;
        worldTickAccumulator = 0;
        player.prevPosition.copy(player.position);
    }

    // 2. -------- 補間済み時間による昼夜サイクル・天体更新 --------
    const worldTickAlpha = isPaused ? 0 : (worldTickAccumulator * WORLD_TPS);
    const renderGameTime = (gameTime + worldTickAlpha * TIME_SPEED) % TICKS_PER_DAY;
    EntityManager.updateRenderInterpolation(isPaused ? 1.0 : worldTickAlpha);
    const currentSkyFactor = SkySystem.update(renderGameTime);

    const curPCx = getChunkCoord(player.position.x);
    const curPCz = getChunkCoord(player.position.z);

    // 3. -------- HUD（デバッグ情報）の更新（1秒ごと） --------
    if (now - lastFpsTime > 1000) {
        const elapsedSec = (now - lastFpsTime) * 0.001;
        const fps = Math.round(frameCount / elapsedSec);
        measuredTps = isPaused ? 0 : Math.min(WORLD_TPS, Math.round((ticksInSecond / elapsedSec) * 10) / 10);

        measuredChunkUpdates = chunkUpdatesInSecond;
        const queuedUpdates = pendingChunkUpdates.size + chunkQueue.length + chunkUpdateLookup.size + TerrainWorkerPool.pendingCount + LightWorkerPool.pendingCount;
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
       ${fps} fps, ${measuredTps.toFixed(1)} tps, ${measuredChunkUpdates} chunk updates (${queuedUpdates} queued)<br>
        <b>Draw calls: ${drawCalls}</b> (Tri: ${triangles.toLocaleString()})<br>
        ${editedCount} edited chunks (${unsavedCount} unsaved / ${cachedChunkCount} cached)<br>
        C: ${OcclusionCuller.stats.renderedSections}/${OcclusionCuller.stats.totalSections} sections (${loadedChunks.size} chunks, Quality: ${CHUNK_VISIBLE_DISTANCE})<br>
        Dimension: Overworld<br>
        <b>Biome: ${biomeName}</b><br>
        x: ${pxInt} (C: ${curPCx})<br>
        y: ${Math.round(py)} (feet)<br>
        z: ${pzInt} (C: ${curPCz})<br>
        E: ${EntityManager.count} mobs, BE: ${BlockEntityManager.count}<br>
        Mode: ${moveMode} (${PlayerData.data.gameMode === GAME_MODES.SURVIVAL ? "Survival" : "Creative"}) / Dash: ${dashActive ? "ON" : "OFF"}<br>
        --------------------------<br>
        TargetBlock: ${targetText}
    `;

        frameCount = 0;
        ticksInSecond = 0;
        chunkUpdatesInSecond = 0;
        lastFpsTime = now;
    }

    // 4. -------- チャンク生成・アンロード & メッシュ再構築（1フレーム統合時間予算管理） --------
    updateChunks();
    const chunkPhaseStart = performance.now();
    // 回路・ピストン・流体など視界内の動的変化を最優先で反映
    processChunkUpdateQueue(4.0);
    processChunkUnloadQueue();
    let builtChunksThisFrame = 0;
    if ((performance.now() - chunkPhaseStart) < 5.0) {
        builtChunksThisFrame = processChunkQueue(false);
    }
    updateChunkFadeIns(now);
    chunkUpdateFrameTimer += delta;
    if (chunkUpdateFrameTimer > 0.016) {
        const remPending = 6.0 - (performance.now() - chunkPhaseStart);
        if (builtChunksThisFrame === 0 && pendingChunkUpdates.size > 0 && remPending > 1.5) {
            processPendingChunkUpdates(Math.min(3.0, remPending));
        }
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
            // カメラ静止中でもピストン・回路・流体・チャンク読込による変化を即時反映
            // （変化がない場合は updateBlockSelection 内の Dirty Check でジオメトリ再構築をスキップ）
            updateTargetBlockDisplay(false);
            updateHeadBlockInfo();
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
    await InventoryUI.restoreHotbarState(savedPlayerState);
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

                TickScheduler.onChunkLoaded(cx, cz);
                const prewarmedVoxels = ChunkSaveManager.modifiedChunks.get(key);
                if (prewarmedVoxels) FluidEngine.onChunkLoaded(cx, cz, prewarmedVoxels);

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
                saveData.playerState || null,
                saveData.simulationState || null,
                saveData.worldEntitiesState || null
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

async function startGame(seed, savedPos = null, savedChunks = null, savedTime = 0, savedWorldUid = null, savedPlayerState = null, savedSimulationState = null, savedWorldEntitiesState = null) {
    const fill = document.getElementById('loading-fill');

    const updateProgress = async (percent) => {
        if (fill) fill.style.width = `${percent}%`;
        await new Promise(resolve => requestAnimationFrame(resolve));
    };

    // 10%：開始
    ui.loading.style.display = 'flex';
    await updateProgress(10);

    initCanvas();
    SkySystem.init();

    // Java Edition 準拠の JSON モデル＆BlockState アセットを並列ロードし高速テーブルを再同期
    const jsonUpdatedBlocks = await loadBlockAssets();
    if (jsonUpdatedBlocks.length > 0) {
        ChunkMesher.clearTemplateCache();
        for (let i = 0; i < jsonUpdatedBlocks.length; i++) {
            const uCfg = jsonUpdatedBlocks[i];
            _syncBlockFastEntry(uCfg.id, uCfg);
        }
    }

    gameTime = Number.isFinite(savedTime) ? savedTime : 0;

    // 25%：基本システム初期化完了
    await updateProgress(25);

    // --- 1. シード値とキャッシュ・ワールド所有権・データの適用 ---
    applySeed(seed);
    TerrainWorkerPool.reset(currentSeed);
    LightWorkerPool.reset();
    chunkLightCache.clear();
    chunkReadOnlyCache.clear();
    pendingChunkUpdates.clear();
    chunkUpdateQueue.length = 0;
    chunkUpdateIdx = 0;
    chunkUpdateLookup.clear();
    chunkUpdateMasks.clear();
    chunkQueue.length = 0;
    chunkUnloadQueue.length = 0;
    chunkUnloadLookup.clear();
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
    RedstoneEngine.clearAllBurnouts();
    FluidEngine.resetActivatedChunks();
    BlockEntityManager.clear();
    PistonEngine.clear();
    PistonAnimator.clear();
    ChestAnimator.clear();
    EntityManager.clear();
    PlayerData.reset();
    PhysicsEngine.reset();

    worldTickCount = 0;
    worldTickAccumulator = 0;
    physicsAccumulator = 0;
    physicsStepCounter = 0;
    ticksInSecond = 0;
    chunkUpdatesInSecond = 0;
    measuredChunkUpdates = 0;
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
    await InventoryUI.init();
    await restorePlayerSaveState(savedPlayerState);

    // 70%：UI・ホットバー復元完了
    await updateProgress(70);

    // --- 4. 保存されていた予約Tick（クロック・リピーター・流体）＆焼き切れ・ピストン状態を先に復元 ---
    if (savedSimulationState) {
        if (savedSimulationState.redstoneBurnouts) {
            RedstoneEngine.importBurnoutState(savedSimulationState.redstoneBurnouts);
        }
        if (savedSimulationState.pistonState) {
            PistonEngine.importState(savedSimulationState.pistonState, worldTickCount);
        }
        if (Array.isArray(savedSimulationState.scheduledTicks)) {
            TickScheduler.importState(savedSimulationState.scheduledTicks);
        }
    }

    if (savedWorldEntitiesState) {
        if (savedWorldEntitiesState.playerData) {
            PlayerData.importNBT(savedWorldEntitiesState.playerData);
        }
        if (Array.isArray(savedWorldEntitiesState.blockEntities)) {
            BlockEntityManager.importState(savedWorldEntitiesState.blockEntities);
        }
        if (Array.isArray(savedWorldEntitiesState.entities)) {
            EntityManager.importState(savedWorldEntitiesState.entities);
        }
    }

    // --- 4.5. スポーン周囲チャンク事前生成（開始直後の空中浮遊・地面ポップイン防止） ---
    await prewarmSpawnChunks(updateProgress, 70, 95);

    // --- 5. 天体・カメラ初期同期 ---
    SkySystem.update(gameTime);
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
   【中断・ポーズシステム】（./core/input_controller.js へ分離済）
   ====================================================== */
let isPaused = false;

function releaseAllActiveInputs() {
    InputController.releaseAllActiveInputs();
}

function stopInteraction(key = "default") {
    InputController.stopInteraction(key);
}

/* ======================================================
   保存してタイトルへ戻る
   ====================================================== */
let isSavingWorld = false;

/**
 * ホットバー構成（文字列ブロックキー配列）・選択スロット・飛行状態を収集
 */
function collectPlayerSaveState() {
    const hotbarState = InventoryUI.exportHotbarState();
    return {
        hotbarKeys: hotbarState.hotbarKeys,
        selectedHotbarIndex: hotbarState.selectedHotbarIndex,
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
        PlayerData.syncFromRuntime({
            position: player.position,
            velocity: player.velocity,
            yaw,
            pitch,
            onGround: player.onGround,
            flightMode,
            selectedHotbarIndex,
            hotbarKeys: playerState.hotbarKeys
        });
        const simulationState = {
            scheduledTicks: TickScheduler.exportState(),
            redstoneBurnouts: RedstoneEngine.exportBurnoutState(),
            pistonState: PistonEngine.exportState(worldTickCount)
        };
        const worldEntitiesState = {
            playerData: PlayerData.exportNBT(),
            blockEntities: BlockEntityManager.exportState(),
            entities: EntityManager.exportState()
        };
        const result = await saveWorldData({
            seed: s,
            playerPos: pPos,
            chunkManager: ChunkSaveManager,
            gameTime,
            worldUid: currentWorldUid,
            isAlreadySaved: isWorldSavedToDB,
            playerState,
            simulationState,
            worldEntitiesState
        });

        currentWorldUid = result.worldUid;
        isWorldSavedToDB = true;

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

addChatMessage("Minecraft test 0.0.1", "#ffff55");

let isInventoryOpen = false;

function applyRenderDistance(val) {
    if (isNaN(val) || val < 0 || val > 32) return;
    CHUNK_VISIBLE_DISTANCE = val;

    const rangeEl = document.getElementById("range-render-dist");
    const labelEl = document.getElementById("renderDistVal");
    const debugEl = document.getElementById("chunkDistance");
    if (rangeEl) rangeEl.value = val;
    if (labelEl) labelEl.innerText = val;
    if (debugEl) debugEl.value = val;

    offsets = null;
    chunkQueue = [];
    lastChunk.x = null;
    lastChunk.z = null;

    if (typeof scene !== "undefined" && scene.fog) {
        const safeLimit = Math.max(16, val * 16);
        if (scene.fog.isFogExp2) {
            scene.fog.density = 0.8 / safeLimit;
        } else {
            scene.fog.near = Math.max(0, (val - 2) * 16);
            scene.fog.far = Math.max(safeLimit, scene.fog.near + 16);
        }
    }

    if (typeof updateChunks === "function") updateChunks();
}

function applyBrightnessSetting(val) {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(val) ? val : 50));
    const labelEl = document.getElementById("brightnessVal");
    if (labelEl) labelEl.innerText = clamped;
    globalBrightnessMultiplier = clamped / 50;
    SHARED_BRIGHTNESS_UNIFORM.value = globalBrightnessMultiplier;
}

window.updateGlobalBrightnessFromUI = function () {
    const slider = document.getElementById("brightnessSlider");
    if (!slider) return;
    applyBrightnessSetting(parseInt(slider.value, 10));
};

const InputController = createInputController({
    keys,
    getRenderer: () => renderer,
    getInventoryUI: () => InventoryUI,
    getContainerUI: () => ContainerUI,
    getIsPaused: () => isPaused,
    setIsPaused: (v) => { isPaused = v; },
    getIsInventoryOpen: () => isInventoryOpen,
    getIsContainerOpen: () => isContainerOpen,
    getCanFly: () => PlayerData.data.abilities.mayfly,
    getFlightMode: () => flightMode,
    setFlightMode: (v) => { flightMode = v; },
    setDashActive: (v) => { dashActive = v; },
    setSneakActive: (v) => { sneakActive = v; },
    setJumpRequest: (v) => { jumpRequest = v; },
    addLookDelta: (dyaw, dpitch) => {
        yaw += dyaw;
        pitch = Math.min(Math.max(pitch + dpitch, -Math.PI / 2), Math.PI / 2);
    },
    onInteractBlock: (action) => interactWithBlock(action),
    onResumeClock: () => { clock.getDelta(); },
    onResetAccumulators: () => {
        physicsAccumulator = 0;
        worldTickAccumulator = 0;
    },
    onToggleChunkBorders: () => {
        showChunkBorders = !showChunkBorders;
        if (chunkBorderMesh) chunkBorderMesh.visible = showChunkBorders;
        addChatMessage(
            showChunkBorders ? "チャンク境界を表示しました" : "チャンク境界を非表示にしました",
            "#55ff55"
        );
    },
    onSpawnDebugMob: () => {
        const hit = getTargetBlockByDDA(12);
        const sx = hit ? (hit.x + hit.normal.x + 0.5) : (player.position.x + 2);
        const sy = hit ? (hit.y + hit.normal.y) : (player.position.y + 0.5);
        const sz = hit ? (hit.z + hit.normal.z + 0.5) : (player.position.z + 2);
        const types = [MOB_TYPES.PIG, MOB_TYPES.SHEEP, MOB_TYPES.ZOMBIE];
        const chosen = types[(Math.random() * types.length) | 0];
        const ent = EntityManager.spawn(chosen, sx, sy, sz);
        if (ent) addChatMessage(`モブを召喚しました: ${ent.def.name} (計 ${EntityManager.count} 体)`, "#55ffff");
    },
    onClearMobs: () => {
        EntityManager.clear();
        addChatMessage("全モブを削除しました", "#ff8888");
    },
    onToggleGameMode: () => {
        const nextMode = (PlayerData.data.gameMode === GAME_MODES.CREATIVE)
            ? GAME_MODES.SURVIVAL
            : GAME_MODES.CREATIVE;
        PlayerData.setGameMode(nextMode);
        if (nextMode === GAME_MODES.SURVIVAL) {
            flightMode = false;
            PlayerData.data.fallDistance = 0;
        }
        ContainerUI.updateSurvivalHUD(PlayerData.data);
        addChatMessage(
            `ゲームモードを ${nextMode === GAME_MODES.SURVIVAL ? "サバイバル" : "クリエイティブ"} に変更しました`,
            "#55ff55"
        );
    },
    onApplyRenderDistance: applyRenderDistance,
    onApplyBrightness: applyBrightnessSetting
});

/* ======================================================
   【外部プラグイン・デバッグ診断用 統一ファサード】
   ====================================================== */
window.MinecraftEngine = Object.freeze({
    BLOCK_CONFIG,
    BLOCK_TYPES,
    STATE_SCHEMAS,
    registerStateSchema,
    getBlockStateProp,
    getBlockStateRawProp,
    setBlockStateProp,
    cycleBlockStateProp,
    hasBlockStateProp,
    packBlockState,
    unpackBlockState,
    formatBlockStateString,
    getRawBlockId,
    getRawLocalState,
    packRawBlock,
    getGlobalStatePaletteStats,
    registerCustomBlock,
    registerGeometryBuilder,
    registerPlacementRule,
    registerSupportRule,
    registerRandomTickHandler,
    TickScheduler,
    RedstoneEngine,
    FluidEngine,
    ChunkSaveManager,
    setWorldBlock,
    notifyNeighborsNC,
    notifyNeighborsPP,
    PlayerData,
    EntityManager,
    BlockEntityManager,
    ContainerUI,
    MOB_TYPES,
    GAME_MODES,
    spawnMob: (typeId = MOB_TYPES.PIG, x = player.position.x + 2, y = player.position.y, z = player.position.z + 2) =>
        EntityManager.spawn(typeId, x, y, z),
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