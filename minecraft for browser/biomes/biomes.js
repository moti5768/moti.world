"use strict";
import { BLOCK_TYPES } from '../blocks.js';

/**
 * アルファ版（Minecraft classic 0.0.1）用バイオーム定義
 * 種類を厳選し、地形の個性を際立たせる構成
 */
export const BIOME_TYPES = {
    SNOWY_TUNDRA: 'snowy_tundra',
    PLAINS: 'plains',
    FOREST: 'forest',
    DESERT: 'desert',
    MOUNTAINS: 'mountains',
    RIVER: 'river'
};

export const BIOME_CONFIG = {
    [BIOME_TYPES.SNOWY_TUNDRA]: {
        name: 'Snowy Tundra',
        topBlock: BLOCK_TYPES.SNOW,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 64,
        heightVariation: 5,
        noiseScale: 0.01
    },
    [BIOME_TYPES.PLAINS]: {
        name: 'Plains',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 64,
        heightVariation: 6,
        noiseScale: 0.01
    },
    [BIOME_TYPES.FOREST]: {
        name: 'Forest',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 66,
        heightVariation: 15,
        noiseScale: 0.02
    },
    [BIOME_TYPES.DESERT]: {
        name: 'Desert',
        topBlock: BLOCK_TYPES.SAND,
        fillerBlock: BLOCK_TYPES.SANDSTONE,
        baseHeight: 62,
        heightVariation: 5,
        noiseScale: 0.01
    },
    [BIOME_TYPES.MOUNTAINS]: {
        name: 'Mountains',
        topBlock: BLOCK_TYPES.STONE,
        fillerBlock: BLOCK_TYPES.STONE,
        baseHeight: 90,
        heightVariation: 50,
        noiseScale: 0.05
    },
    [BIOME_TYPES.RIVER]: {
        name: 'River',
        topBlock: BLOCK_TYPES.DIRT,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 58,
        heightVariation: 2,
        noiseScale: 0.01
    }
};

/**
 * 温度、湿度、標高に基づいてバイオームを決定する
 * アルファ版向けに判定マトリックスをシンプル化
 */
export function determineBiome(temp, humidity, height = 64, riverValue = 0.5) {

    // 1. 特殊地形：川の判定
    const riverThreshold = 0.05;
    if (Math.abs(riverValue - 0.5) < riverThreshold) {
        return BIOME_CONFIG[BIOME_TYPES.RIVER];
    }

    // 2. 山岳判定 (標高による優先判定)
    if (height > 95) {
        return BIOME_CONFIG[BIOME_TYPES.MOUNTAINS];
    }

    // 3. 気温と湿度による判定

    // --- 寒冷地 ---
    if (temp < 0.3) {
        return BIOME_CONFIG[BIOME_TYPES.SNOWY_TUNDRA];
    }

    // --- 乾燥帯 ---
    if (temp > 0.7 && humidity < 0.3) {
        return BIOME_CONFIG[BIOME_TYPES.DESERT];
    }

    // --- 温帯 ---
    // 湿度が高い場合は森林、それ以外は平原
    if (humidity > 0.5) {
        return BIOME_CONFIG[BIOME_TYPES.FOREST];
    }

    // デフォルト（基準バイオーム）
    return BIOME_CONFIG[BIOME_TYPES.PLAINS];
}