import { BIOME_TYPES } from './biomes/biomes.js';

/**
 * 最適化ポイント:
 * 1. キーを BIOME_CONFIG[...].name (文字列) から BIOME_TYPES (数値ID) に変更。
 *    これにより、毎フレームの文字列ハッシュ計算を回避し、高速な参照が可能になります。
 * 2. データ構造を整理し、ランタイムでの動的な名前参照コストをゼロにしました。
 */
export const FeatureRules = {
    // 森林 (Forest)
    [BIOME_TYPES.FOREST]: [
        { feature: 'OAK_TREE', chance: 0.035 },
        { feature: 'GRASS', chance: 0.12 },
        { feature: 'FLOWER', chance: 0.01 },
        { feature: 'FLOWER_ROSE', chance: 0.01 }
    ],

    // 平原 (Plains)
    [BIOME_TYPES.PLAINS]: [
        { feature: 'OAK_TREE', chance: 0.001 },
        { feature: 'GRASS', chance: 0.15 },
        { feature: 'FLOWER', chance: 0.04 },
        { feature: 'FLOWER_ROSE', chance: 0.01 }
    ],

    // 雪原 (Snowy Tundra)
    [BIOME_TYPES.SNOWY_TUNDRA]: [
        { feature: 'GRASS', chance: 0 },
    ],

    // 山岳 (Mountains)
    [BIOME_TYPES.MOUNTAINS]: [
        { feature: 'GRASS', chance: 0.05 },
        { feature: 'DEADBUSH', chance: 0.001 }
    ],

    // 砂漠 (Desert)
    [BIOME_TYPES.DESERT]: [
        { feature: 'DEADBUSH', chance: 0.02 }
    ],

    // 一致しない場合のフォールバック (数値以外のキー)
    Default: [
        { feature: 'GRASS', chance: 0.05 },
        { feature: 'FLOWER', chance: 0.01 }
    ]
};