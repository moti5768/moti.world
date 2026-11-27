import { BIOME_TYPES } from './biomes/biomes.js';

/**
 * Minecraft Beta 1.8 BiomeDecorator 準拠のバイオーム別生成ルール
 * ※各バイオームの rules 内 chance 合計は必ず 1.0 以下
 */
export const FeatureRules = {
    // 海洋 (Ocean): 植生なし
    [BIOME_TYPES.OCEAN]: {
        attempts: 0,
        rules: []
    },

    // 川 (River): 植生なし
    [BIOME_TYPES.RIVER]: {
        attempts: 0,
        rules: []
    },

    // 平原 (Plains): 木はほぼ無く、広大な背の高い草の群生と花畑（Beta 1.8: trees=-999, grass=10, flowers=4）
    [BIOME_TYPES.PLAINS]: {
        attempts: 18,
        rules: [
            { feature: 'GRASS_PATCH', chance: 0.62, isStructure: false },
            { feature: 'FLOWER_PATCH', chance: 0.16, isStructure: false },
            { feature: 'ROSE_PATCH', chance: 0.08, isStructure: false }
        ]
    },

    // 森林 (Forest): 高密度のオーク林 ＋ ほどよい下草と花・キノコ（Beta 1.8: trees=10, grass=2）
    [BIOME_TYPES.FOREST]: {
        attempts: 36,
        rules: [
            { feature: 'OAK_TREE', chance: 0.42, isStructure: true },
            { feature: 'GRASS_PATCH', chance: 0.22, isStructure: false },
            { feature: 'FLOWER_PATCH', chance: 0.06, isStructure: false },
            { feature: 'ROSE_PATCH', chance: 0.04, isStructure: false },
            { feature: 'MUSHROOM_BROWN_PATCH', chance: 0.03, isStructure: false },
            { feature: 'MUSHROOM_RED_PATCH', chance: 0.02, isStructure: false }
        ]
    },

    // タイガ (Taiga): 高密度の針葉樹林 ＋ 下草（Beta 1.8: trees=10, grass=1）
    [BIOME_TYPES.TAIGA]: {
        attempts: 34,
        rules: [
            { feature: 'TAIGA_TREE', chance: 0.44, isStructure: true },
            { feature: 'GRASS_PATCH', chance: 0.14, isStructure: false },
            { feature: 'FLOWER_PATCH', chance: 0.03, isStructure: false },
            { feature: 'MUSHROOM_BROWN_PATCH', chance: 0.03, isStructure: false }
        ]
    },

    // 湿地 (Swampland): 幅広な沼地の木 ＋ 豊富なキノコ ＋ 下草 ＋ 枯れ木（Beta 1.8: trees=2, mushrooms=8, deadBush=1）
    [BIOME_TYPES.SWAMPLAND]: {
        attempts: 24,
        rules: [
            { feature: 'SWAMP_TREE', chance: 0.14, isStructure: true },
            { feature: 'MUSHROOM_BROWN_PATCH', chance: 0.22, isStructure: false },
            { feature: 'MUSHROOM_RED_PATCH', chance: 0.14, isStructure: false },
            { feature: 'GRASS_PATCH', chance: 0.18, isStructure: false },
            { feature: 'DEADBUSH', chance: 0.08, isStructure: false }
        ]
    },

    // 山岳丘陵 (Extreme Hills): 疎らなオークと点在する草・花（Beta 1.8: trees=0〜1, grass=1）
    [BIOME_TYPES.EXTREME_HILLS]: {
        attempts: 14,
        rules: [
            { feature: 'OAK_TREE', chance: 0.05, isStructure: true },
            { feature: 'GRASS_PATCH', chance: 0.28, isStructure: false },
            { feature: 'FLOWER_PATCH', chance: 0.06, isStructure: false },
            { feature: 'ROSE_PATCH', chance: 0.03, isStructure: false }
        ]
    },

    // 砂漠 (Desert): 枯れ木のみ（Beta 1.8: trees=-999, deadBush=2）
    [BIOME_TYPES.DESERT]: {
        attempts: 10,
        rules: [
            { feature: 'DEADBUSH_PATCH', chance: 0.22, isStructure: false }
        ]
    },

    // フォールバック
    Default: {
        attempts: 12,
        rules: [
            { feature: 'GRASS_PATCH', chance: 0.25, isStructure: false },
            { feature: 'FLOWER_PATCH', chance: 0.05, isStructure: false }
        ]
    }
};