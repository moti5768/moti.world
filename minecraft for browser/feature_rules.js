import { BIOME_TYPES } from './biomes/biomes.js';

/**
 * バイオームごとの生成ルール定義
 * ※各バイオームの rules 内の chance 合計は必ず 1.0 以下に収め、全ルールが正しく抽選されるようにする
 */
export const FeatureRules = {

    // 川 (River): attempts 0 により生成ループを完全にバイパス
    [BIOME_TYPES.RIVER]: {
        attempts: 0,
        rules: []
    },

    // 森林 (Forest): 木・下草・花・キノコをバランス良く配置（合計 chance = 0.80 <= 1.0）
    [BIOME_TYPES.FOREST]: {
        attempts: 360,
        rules: [
            { feature: 'OAK_TREE', chance: 0.045, isStructure: true },
            { feature: 'GRASS', chance: 0.68, isStructure: false },
            { feature: 'FLOWER', chance: 0.03, isStructure: false },
            { feature: 'FLOWER_ROSE', chance: 0.025, isStructure: false },
            { feature: 'MUSHROOM_BROWN', chance: 0.01, isStructure: false },
            { feature: 'MUSHROOM_RED', chance: 0.01, isStructure: false }
        ]
    },

    // 平原 (Plains): 広がる草花と点在するオーク・キャンプテント（合計 chance = 0.253 <= 1.0）
    [BIOME_TYPES.PLAINS]: {
        attempts: 140,
        rules: [
            { feature: 'OAK_TREE', chance: 0.002, isStructure: true },
            { feature: 'CUSTOM_TENT', chance: 0.0015, isStructure: true },
            { feature: 'GRASS', chance: 0.19, isStructure: false },
            { feature: 'FLOWER', chance: 0.04, isStructure: false },
            { feature: 'FLOWER_ROSE', chance: 0.02, isStructure: false }
        ]
    },

    // 雪原 (Snowy Tundra): 疎らなオーク木と枯れ草（合計 chance = 0.12 <= 1.0）
    [BIOME_TYPES.SNOWY_TUNDRA]: {
        attempts: 25,
        rules: [
            { feature: 'OAK_TREE', chance: 0.04, isStructure: true },
            { feature: 'DEADBUSH', chance: 0.08, isStructure: false }
        ]
    },

    // 山岳 (Mountains): 高地の草パッチと枯れ木（合計 chance = 0.12 <= 1.0）
    [BIOME_TYPES.MOUNTAINS]: {
        attempts: 60,
        rules: [
            { feature: 'GRASS', chance: 0.10, isStructure: false },
            { feature: 'DEADBUSH', chance: 0.02, isStructure: false }
        ]
    },

    // 砂漠 (Desert): 枯れ木のみ（合計 chance = 0.06 <= 1.0）
    [BIOME_TYPES.DESERT]: {
        attempts: 30,
        rules: [
            { feature: 'DEADBUSH', chance: 0.06, isStructure: false }
        ]
    },

    // フォールバック
    Default: {
        attempts: 50,
        rules: [
            { feature: 'GRASS', chance: 0.15, isStructure: false },
            { feature: 'FLOWER', chance: 0.02, isStructure: false }
        ]
    }
};