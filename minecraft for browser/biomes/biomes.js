"use strict";
import { BLOCK_TYPES } from '../blocks.js';

export const BIOME_TYPES = {
    SNOWY_TUNDRA: 'snowy_tundra',
    ICE_SPIKES: 'ice_spikes',
    TAIGA: 'taiga',
    PLAINS: 'plains',
    FOREST: 'forest',
    BIRCH_FOREST: 'birch_forest',
    JUNGLE: 'jungle',
    SAVANNA: 'savanna',
    DESERT: 'desert',
    BADLANDS: 'badlands',
    MOUNTAINS: 'mountains',
    RIVER: 'river',
    OCEAN: 'ocean'
};

export const BIOME_CONFIG = {
    [BIOME_TYPES.SNOWY_TUNDRA]: { name: 'Snowy Tundra', topBlock: BLOCK_TYPES.SNOW, fillerBlock: BLOCK_TYPES.DIRT, baseHeight: 64, heightVariation: 5, noiseScale: 0.01 },
    [BIOME_TYPES.TAIGA]: { name: 'Taiga', topBlock: BLOCK_TYPES.GRASS, fillerBlock: BLOCK_TYPES.DIRT, baseHeight: 68, heightVariation: 12, noiseScale: 0.02 },
    [BIOME_TYPES.PLAINS]: { name: 'Plains', topBlock: BLOCK_TYPES.GRASS, fillerBlock: BLOCK_TYPES.DIRT, baseHeight: 64, heightVariation: 6, noiseScale: 0.01 },
    [BIOME_TYPES.FOREST]: { name: 'Forest', topBlock: BLOCK_TYPES.GRASS, fillerBlock: BLOCK_TYPES.DIRT, baseHeight: 66, heightVariation: 15, noiseScale: 0.02 },
    [BIOME_TYPES.JUNGLE]: { name: 'Jungle', topBlock: BLOCK_TYPES.GRASS, fillerBlock: BLOCK_TYPES.DIRT, baseHeight: 70, heightVariation: 20, noiseScale: 0.03 },
    [BIOME_TYPES.SAVANNA]: { name: 'Savanna', topBlock: BLOCK_TYPES.GRASS, fillerBlock: BLOCK_TYPES.DIRT, baseHeight: 66, heightVariation: 8, noiseScale: 0.015 },
    [BIOME_TYPES.DESERT]: { name: 'Desert', topBlock: BLOCK_TYPES.SAND, fillerBlock: BLOCK_TYPES.SANDSTONE, baseHeight: 62, heightVariation: 5, noiseScale: 0.01 },
    [BIOME_TYPES.MOUNTAINS]: { name: 'Mountains', topBlock: BLOCK_TYPES.STONE, fillerBlock: BLOCK_TYPES.STONE, baseHeight: 90, heightVariation: 50, noiseScale: 0.05 },
    [BIOME_TYPES.RIVER]: { name: 'River', topBlock: BLOCK_TYPES.DIRT, fillerBlock: BLOCK_TYPES.DIRT, baseHeight: 58, heightVariation: 2, noiseScale: 0.01 }
};

/**
 * 温度と湿度に基づいてバイオームを決定する（マインクラフト準拠ロジック）
 * @param {number} temp 気温 (0.0: 極寒 ~ 1.0: 灼熱)
 * @param {number} humidity 湿度 (0.0: 乾燥 ~ 1.0: 多湿)
 * @param {number} height 標高 (Y座標 - オプション)
 * @param {number} riverValue 川ノイズ (0.0 ~ 1.0)
 */
export function determineBiome(temp, humidity, height = 64, riverValue = 0.5) {

    // 1. 特殊地形：川の判定 (中心線 0.5 付近を川とする)
    const riverThreshold = 0.05;
    if (Math.abs(riverValue - 0.5) < riverThreshold) {
        return BIOME_CONFIG[BIOME_TYPES.RIVER];
    }

    // 2. 標高による温度補正 (高いほど寒い)
    // マイクラ仕様：海抜(64)より30ブロック上がるごとに気温が約0.15下がる計算
    const adjustedTemp = temp - Math.max(0, (height - 64) / 200);

    // 3. 山岳判定 (標高が非常に高い場合)
    if (height > 95) {
        return BIOME_CONFIG[BIOME_TYPES.MOUNTAINS];
    }

    // 4. 気温と湿度のマトリックス判定

    // --- 寒冷地 (Frozen / Cold) ---
    if (adjustedTemp < 0.2) {
        return BIOME_CONFIG[BIOME_TYPES.SNOWY_TUNDRA];
    }
    if (adjustedTemp < 0.4) {
        return (humidity > 0.5) ? BIOME_CONFIG[BIOME_TYPES.TAIGA] : BIOME_CONFIG[BIOME_TYPES.SNOWY_TUNDRA];
    }

    // --- 温帯 (Temperate) ---
    if (adjustedTemp < 0.7) {
        if (humidity < 0.3) return BIOME_CONFIG[BIOME_TYPES.PLAINS];
        if (humidity < 0.8) return BIOME_CONFIG[BIOME_TYPES.FOREST];
        return BIOME_CONFIG[BIOME_TYPES.JUNGLE]; // 温帯かつ高湿度はジャングル寄り
    }

    // --- 熱帯・乾燥帯 (Hot / Arid) ---
    if (humidity < 0.2) {
        return BIOME_CONFIG[BIOME_TYPES.DESERT];
    }
    if (humidity < 0.5) {
        return BIOME_CONFIG[BIOME_TYPES.SAVANNA];
    }

    // 高温多湿
    return BIOME_CONFIG[BIOME_TYPES.JUNGLE];
}