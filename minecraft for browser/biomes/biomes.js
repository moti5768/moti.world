"use strict";
import { BLOCK_TYPES } from '../blocks.js';
import { BETA18_IDS } from './beta18_genlayer.js';

/**
 * バイオームID定義（Minecraft Beta 1.8 全8バイオーム ＋ 既存エイリアス互換）
 */
export const BIOME_TYPES = {
    PLAINS: BETA18_IDS.PLAINS,               // 0
    TAIGA: BETA18_IDS.TAIGA,                 // 1
    SNOWY_TUNDRA: BETA18_IDS.TAIGA,          // 1 (後方互換エイリアス)
    FOREST: BETA18_IDS.FOREST,               // 2
    DESERT: BETA18_IDS.DESERT,               // 3
    EXTREME_HILLS: BETA18_IDS.EXTREME_HILLS, // 4
    MOUNTAINS: BETA18_IDS.EXTREME_HILLS,     // 4 (後方互換エイリアス)
    RIVER: BETA18_IDS.RIVER,                 // 5
    OCEAN: BETA18_IDS.OCEAN,                 // 6
    SWAMPLAND: BETA18_IDS.SWAMPLAND          // 7
};

/**
 * Minecraft Beta 1.8 準拠バイオーム設定
 * - minHeight / maxHeight: Beta 1.8 BiomeGenBase と同等の基準高度・起伏スケール
 * - grassColor / foliageColor: バイオーム着色＆草オーバーレイ用カラー
 */
export const BIOME_CONFIG = {
    [BIOME_TYPES.PLAINS]: {
        id: 0,
        name: 'Plains',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        minHeight: 0.12,
        maxHeight: 0.22,
        baseHeight: 65,
        heightVariation: 4,
        noiseScale: 0.008,
        grassColor: 0x91BD59,
        foliageColor: 0x77AB2F
    },
    [BIOME_TYPES.TAIGA]: {
        id: 1,
        name: 'Taiga',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        minHeight: 0.20,
        maxHeight: 0.45,
        baseHeight: 66,
        heightVariation: 9,
        noiseScale: 0.011,
        grassColor: 0x86B783,
        foliageColor: 0x68A464
    },
    [BIOME_TYPES.FOREST]: {
        id: 2,
        name: 'Forest',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        minHeight: 0.16,
        maxHeight: 0.40,
        baseHeight: 66,
        heightVariation: 8,
        noiseScale: 0.012,
        grassColor: 0x79C05A,
        foliageColor: 0x59AE30
    },
    [BIOME_TYPES.DESERT]: {
        id: 3,
        name: 'Desert',
        topBlock: BLOCK_TYPES.SAND,
        fillerBlock: BLOCK_TYPES.SAND,
        minHeight: 0.12,
        maxHeight: 0.22,
        baseHeight: 65,
        heightVariation: 4,
        noiseScale: 0.008,
        grassColor: 0xBFB755,
        foliageColor: 0xAEA42A
    },
    [BIOME_TYPES.EXTREME_HILLS]: {
        id: 4,
        name: 'Extreme Hills',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        minHeight: 0.48,
        maxHeight: 1.55,
        baseHeight: 74,
        heightVariation: 30,
        noiseScale: 0.012,
        grassColor: 0x8AB689,
        foliageColor: 0x6DA36B
    },
    [BIOME_TYPES.RIVER]: {
        id: 5,
        name: 'River',
        topBlock: BLOCK_TYPES.DIRT,
        fillerBlock: BLOCK_TYPES.DIRT,
        minHeight: -0.50,
        maxHeight: 0.08,
        baseHeight: 55,
        heightVariation: 2,
        noiseScale: 0.008,
        grassColor: 0x8EB971,
        foliageColor: 0x71A74D
    },
    [BIOME_TYPES.OCEAN]: {
        id: 6,
        name: 'Ocean',
        topBlock: BLOCK_TYPES.SAND,
        fillerBlock: BLOCK_TYPES.DIRT,
        minHeight: -1.00,
        maxHeight: 0.30,
        baseHeight: 46,
        heightVariation: 6,
        noiseScale: 0.010,
        grassColor: 0x8EB971,
        foliageColor: 0x71A74D
    },
    [BIOME_TYPES.SWAMPLAND]: {
        id: 7,
        name: 'Swampland',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        minHeight: -0.14,
        maxHeight: 0.15,
        baseHeight: 61,
        heightVariation: 3,
        noiseScale: 0.010,
        grassColor: 0x6A7039,
        foliageColor: 0x6A7039
    }
};

export const BIOME_ID_TO_NAME = {
    0: 'Plains',
    1: 'Taiga',
    2: 'Forest',
    3: 'Desert',
    4: 'Extreme Hills',
    5: 'River',
    6: 'Ocean',
    7: 'Swampland'
};

export const BIOME_COUNT = 8;

export function determineBiome() {
    return BIOME_CONFIG[BIOME_TYPES.PLAINS];
}