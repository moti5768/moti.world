"use strict";
import { BLOCK_TYPES } from '../blocks.js';

/**
 * バイオームID定義
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
 * 常に同じ不変オブジェクト参照を返すことでGC負荷をゼロに抑制
 */
export const BIOME_CONFIG = {
    [BIOME_TYPES.PLAINS]: {
        id: 0,
        name: 'Plains',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 64,
        heightVariation: 6,
        noiseScale: 0.008
    },
    [BIOME_TYPES.SNOWY_TUNDRA]: {
        id: 1,
        name: 'Snowy Tundra',
        topBlock: BLOCK_TYPES.SNOW,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 65,
        heightVariation: 7,
        noiseScale: 0.009
    },
    [BIOME_TYPES.FOREST]: {
        id: 2,
        name: 'Forest',
        topBlock: BLOCK_TYPES.GRASS,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 67,
        heightVariation: 14,
        noiseScale: 0.015
    },
    [BIOME_TYPES.DESERT]: {
        id: 3,
        name: 'Desert',
        topBlock: BLOCK_TYPES.SAND,
        fillerBlock: BLOCK_TYPES.SANDSTONE,
        baseHeight: 64,
        heightVariation: 6,
        noiseScale: 0.008
    },
    [BIOME_TYPES.MOUNTAINS]: {
        id: 4,
        name: 'Mountains',
        topBlock: BLOCK_TYPES.STONE,
        fillerBlock: BLOCK_TYPES.STONE,
        baseHeight: 86,
        heightVariation: 36,
        noiseScale: 0.025
    },
    [BIOME_TYPES.RIVER]: {
        id: 5,
        name: 'River',
        topBlock: BLOCK_TYPES.DIRT,
        fillerBlock: BLOCK_TYPES.DIRT,
        baseHeight: 56,
        heightVariation: 2,
        noiseScale: 0.008
    }
};

/**
 * キャッシュからの逆引き用テーブル
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
 * 気温(0..1)・湿度(0..1)・大陸度/起伏(0..1)・川ノイズ(0..1)に基づいてバイオームを決定する
 * 循環依存(標高入力)を廃止し、大陸度パラメータにより山岳バイオームを確実に連続生成する
 */
export function determineBiome(temp, humidity, continentalness = 0.5, riverValue = 0.5) {
    // 1. 河川判定（中心 0.5 から ±0.042 の帯、高地山岳の頂上付近は渓谷化しすぎないよう緩和）
    const riverDist = riverValue >= 0.5 ? (riverValue - 0.5) : (0.5 - riverValue);
    if (riverDist < 0.042 && continentalness < 0.72) {
        return BIOME_CONFIG[BIOME_TYPES.RIVER];
    }

    // 2. 山岳判定（大陸度・隆起度による連続エリア形成）
    if (continentalness > 0.66) {
        return BIOME_CONFIG[BIOME_TYPES.MOUNTAINS];
    }

    // 3. 気温と湿度による気候帯判定
    // --- 寒冷地 ---
    if (temp < 0.32) {
        return BIOME_CONFIG[BIOME_TYPES.SNOWY_TUNDRA];
    }

    // --- 乾燥帯 ---
    if (temp > 0.64 && humidity < 0.38) {
        return BIOME_CONFIG[BIOME_TYPES.DESERT];
    }

    // --- 温帯・湿潤 ---
    if (humidity > 0.52) {
        return BIOME_CONFIG[BIOME_TYPES.FOREST];
    }

    // デフォルト（温帯草原）
    return BIOME_CONFIG[BIOME_TYPES.PLAINS];
}