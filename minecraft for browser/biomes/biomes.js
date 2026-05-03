"use strict";
import { BLOCK_TYPES } from '../blocks.js';

/**
 * アルファ版用バイオームID定義
 * Zero-GCキャッシュのために数値で管理
 */
export const BIOME_TYPES = {
    PLAINS: 0,
    SNOWY_TUNDRA: 1,
    FOREST: 2,
    DESERT: 3,
    MOUNTAINS: 4,
    RIVER: 5
};

/**
 * バイオームの設定データ
 * ChunkSaveManagerが参照する id プロパティを追加
 */
export const BIOME_CONFIG = {
    [BIOME_TYPES.PLAINS]: {
        id: 0,
        name: 'Plains',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 64,
        heightVariation: 6,
        noiseScale: 0.01
    },
    [BIOME_TYPES.SNOWY_TUNDRA]: {
        id: 1,
        name: 'Snowy Tundra',
        topBlock: BLOCK_TYPES.SNOW,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 64,
        heightVariation: 5,
        noiseScale: 0.01
    },
    [BIOME_TYPES.FOREST]: {
        id: 2,
        name: 'Forest',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 66,
        heightVariation: 15,
        noiseScale: 0.02
    },
    [BIOME_TYPES.DESERT]: {
        id: 3,
        name: 'Desert',
        topBlock: BLOCK_TYPES.SAND,
        fillerBlock: BLOCK_TYPES.SANDSTONE,
        baseHeight: 62,
        heightVariation: 5,
        noiseScale: 0.01
    },
    [BIOME_TYPES.MOUNTAINS]: {
        id: 4,
        name: 'Mountains',
        topBlock: BLOCK_TYPES.STONE,
        fillerBlock: BLOCK_TYPES.STONE,
        baseHeight: 90,
        heightVariation: 50,
        noiseScale: 0.05
    },
    [BIOME_TYPES.RIVER]: {
        id: 5,
        name: 'River',
        topBlock: BLOCK_TYPES.DIRT,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 58,
        heightVariation: 2,
        noiseScale: 0.01
    }
};

/**
 * キャッシュからの逆引き用テーブル
 * ChunkSaveManager 内の BIOME_ID_TO_NAME エラーを解決します
 */
export const BIOME_ID_TO_NAME = Object.values(BIOME_CONFIG).reduce((acc, config) => {
    acc[config.id] = config.name;
    return acc;
}, {});

/**
 * 温度、湿度、標高に基づいてバイオームを決定する
 * 事前に定義された BIOME_CONFIG の参照を返すことで GC 負荷をゼロにします
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
    if (humidity > 0.5) {
        return BIOME_CONFIG[BIOME_TYPES.FOREST];
    }

    // デフォルト
    return BIOME_CONFIG[BIOME_TYPES.PLAINS];
}