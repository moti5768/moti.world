"use strict";
import { BLOCK_TYPES } from '../blocks.js';

export const BIOME_TYPES = {
    PLAINS: 'plains',
    DESERT: 'desert',
    FOREST: 'forest',
    MOUNTAINS: 'mountains',
    SNOWY_TUNDRA: 'snowy_tundra'
};

// 各バイオームの特徴定義
export const BIOME_CONFIG = {
    [BIOME_TYPES.PLAINS]: {
        name: 'Plains',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 64,
        heightVariation: 10,
        noiseScale: 0.01
    },
    [BIOME_TYPES.DESERT]: {
        name: 'Desert',
        topBlock: BLOCK_TYPES.SAND,
        fillerBlock: BLOCK_TYPES.SANDSTONE,
        baseHeight: 62,
        heightVariation: 5,
        noiseScale: 0.005
    },
    [BIOME_TYPES.FOREST]: {
        name: 'Forest',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 68,
        heightVariation: 15,
        noiseScale: 0.02
    },
    [BIOME_TYPES.MOUNTAINS]: {
        name: 'Mountains',
        topBlock: BLOCK_TYPES.STONE,
        fillerBlock: BLOCK_TYPES.STONE,
        baseHeight: 80,
        heightVariation: 40,
        noiseScale: 0.04
    },
    [BIOME_TYPES.SNOWY_TUNDRA]: {
        name: 'Snowy_tundra',
        topBlock: BLOCK_TYPES.SNOW,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 66,
        heightVariation: 8,
        noiseScale: 0.01
    }
};

/**
 * 温度と湿度の値（0.0 〜 1.0）からバイオームを決定する
 */
export function determineBiome(temp, humidity) {
    if (temp < 0.3) {
        return BIOME_CONFIG[BIOME_TYPES.SNOWY_TUNDRA];
    }

    if (temp > 0.7) {
        if (humidity < 0.4) return BIOME_CONFIG[BIOME_TYPES.DESERT];
        return BIOME_CONFIG[BIOME_TYPES.FOREST];
    }

    if (humidity > 0.6) {
        return BIOME_CONFIG[BIOME_TYPES.FOREST];
    }

    // デフォルトは平原
    return BIOME_CONFIG[BIOME_TYPES.PLAINS];
}
