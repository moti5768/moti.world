import { BIOME_TYPES } from './biomes/biomes.js';

/**
 * バイオームごとの生成ルール定義
 */

export const FeatureRules = {

    // 川 (River): attempts 0 により生成ループを完全にバイパス
    [BIOME_TYPES.RIVER]: {
        attempts: 0,
        rules: []
    },

    // 森林 (Forest)
    [BIOME_TYPES.FOREST]: {
        attempts: 200,
        rules: [
            { feature: 'OAK_TREE', chance: 0.035, isStructure: true },
            { feature: 'GRASS', chance: 0.12, isStructure: false },
            { feature: 'FLOWER', chance: 0.01, isStructure: false },
            { feature: 'FLOWER_ROSE', chance: 0.01, isStructure: false }
        ]
    },

    // 平原 (Plains)
    [BIOME_TYPES.PLAINS]: {
        attempts: 120,
        rules: [
            { feature: 'OAK_TREE', chance: 0.001, isStructure: true },
            { feature: 'GRASS', chance: 0.15, isStructure: false },
            { feature: 'FLOWER', chance: 0.04, isStructure: false },
            { feature: 'FLOWER_ROSE', chance: 0.01, isStructure: false }
        ]
    },

    // 雪原 (Snowy Tundra)
    [BIOME_TYPES.SNOWY_TUNDRA]: {
        attempts: 5,
        rules: []
    },

    // 山岳 (Mountains)
    [BIOME_TYPES.MOUNTAINS]: {
        attempts: 50,
        rules: [
            { feature: 'GRASS', chance: 0.05, isStructure: false },
            { feature: 'DEADBUSH', chance: 0.001, isStructure: false }
        ]
    },

    // 砂漠 (Desert)
    [BIOME_TYPES.DESERT]: {
        attempts: 20,
        rules: [
            { feature: 'DEADBUSH', chance: 0.02, isStructure: false }
        ]
    },

    // フォールバック
    Default: {
        attempts: 50,
        rules: [
            { feature: 'GRASS', chance: 0.05, isStructure: false },
            { feature: 'FLOWER', chance: 0.01, isStructure: false }
        ]
    }
};