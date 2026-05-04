import { BIOME_TYPES } from './biomes/biomes.js';

/**
 * 最適化ポイント:
 * 1. isStructure フラグの導入: 
 *    木のようにチャンク境界を超えるものだけを true に。
 *    草花などは自身のチャンク内でのみ計算させることで、負荷を 1/9 に軽減します。
 * 2. attempts (試行回数) のバイオーム別定義:
 *    砂漠や雪原など、装飾が少ない場所でのループ回数を減らし、CPUコストを最適化。
 */
export const FeatureRules = {

    // 川 (River)
    [BIOME_TYPES.RIVER]: {
        attempts: 0,
        rules: [
            { feature: 'GRASS', chance: 0 },
        ]
    },

    // 森林 (Forest): 木が多く、装飾密度が高い
    [BIOME_TYPES.FOREST]: {
        attempts: 200, // 森は密度を上げる
        rules: [
            { feature: 'OAK_TREE', chance: 0.035, isStructure: true }, // 木は構造物
            { feature: 'GRASS', chance: 0.12 },
            { feature: 'FLOWER', chance: 0.01 },
            { feature: 'FLOWER_ROSE', chance: 0.01 }
        ]
    },

    // 平原 (Plains): 草原がメイン
    [BIOME_TYPES.PLAINS]: {
        attempts: 120,
        rules: [
            { feature: 'OAK_TREE', chance: 0.001, isStructure: true },
            { feature: 'GRASS', chance: 0.15 },
            { feature: 'FLOWER', chance: 0.04 },
            { feature: 'FLOWER_ROSE', chance: 0.01 }
        ]
    },

    // 雪原 (Snowy Tundra): ほぼ何もないので試行回数を最小に
    [BIOME_TYPES.SNOWY_TUNDRA]: {
        attempts: 5,
        rules: [
            { feature: 'GRASS', chance: 0 },
        ]
    },

    // 山岳 (Mountains)
    [BIOME_TYPES.MOUNTAINS]: {
        attempts: 50,
        rules: [
            { feature: 'GRASS', chance: 0.05 },
            { feature: 'DEADBUSH', chance: 0.001 }
        ]
    },

    // 砂漠 (Desert)
    [BIOME_TYPES.DESERT]: {
        attempts: 20,
        rules: [
            { feature: 'DEADBUSH', chance: 0.02 }
        ]
    },

    // フォールバック
    Default: {
        attempts: 50,
        rules: [
            { feature: 'GRASS', chance: 0.05 },
            { feature: 'FLOWER', chance: 0.01 }
        ]
    }
};