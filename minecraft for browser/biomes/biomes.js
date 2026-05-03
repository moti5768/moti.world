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
 * 
 * 最適化ポイント:
 * 1. 数値キーによる高速ルックアップ
 * 2. 常に同じオブジェクト参照を返すことでGC負荷をゼロに抑制
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
 * 
 * 最適化ポイント:
 * 実行時の計算を排除するため、リテラルとして定義
 */
export const BIOME_ID_TO_NAME = {
    0: 'Plains',
    1: 'Snowy Tundra',
    2: 'Forest',
    3: 'Desert',
    4: 'Mountains',
    5: 'River'
};

/**
 * 温度、湿度、標高に基づいてバイオームを決定する
 * 
 * 軽量化ポイント:
 * 1. Math.absを使わずインラインで絶対値を計算し、関数呼び出しを削減
 * 2. 頻繁にアクセスされるBIOME_CONFIG[BIOME_TYPES.X]を直接返却
 */
export function determineBiome(temp, humidity, height = 64, riverValue = 0.5) {

    // 1. 特殊地形：川の判定
    const riverDiff = riverValue - 0.5;
    const absRiverDiff = riverDiff < 0 ? -riverDiff : riverDiff;

    if (absRiverDiff < 0.05) {
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