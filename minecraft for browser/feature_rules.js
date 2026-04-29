import { BIOME_TYPES, BIOME_CONFIG } from './biomes/biomes.js';

export const FeatureRules = {
    [BIOME_CONFIG[BIOME_TYPES.FOREST].name]: [
        { feature: 'OAK_TREE', chance: 0.035 },
        { feature: 'GRASS', chance: 0.12 },
        { feature: 'TALLGRASS', chance: 0.08 },
        { feature: 'FLOWER', chance: 0.01 },
        { feature: 'FLOWER_ROSE', chance: 0.01 }
    ],
    // 平原: 草の密度を下げ、広がりを感じさせる構成
    [BIOME_CONFIG[BIOME_TYPES.PLAINS].name]: [
        { feature: 'OAK_TREE', chance: 0.001 },
        { feature: 'GRASS', chance: 0.15 },      // 40% -> 15% に調整
        { feature: 'TALLGRASS', chance: 0.05 },
        { feature: 'FLOWER', chance: 0.04 },
        { feature: 'FLOWER_ROSE', chance: 0.01 }
    ],
    // 雪原: 木を完全に削除
    [BIOME_CONFIG[BIOME_TYPES.SNOWY_TUNDRA].name]: [
        // 木を削除し、雪に埋もれた草を稀に配置
        { feature: 'GRASS', chance: 0 },
    ],
    // 山岳: 岩場に合う植物を追加
    [BIOME_CONFIG[BIOME_TYPES.MOUNTAINS].name]: [
        { feature: 'GRASS', chance: 0.05 },
        { feature: 'DEADBUSH', chance: 0.001 }
    ],
    // 砂漠: 枯れ木のみ
    [BIOME_CONFIG[BIOME_TYPES.DESERT].name]: [
        { feature: 'DEADBUSH', chance: 0.02 }
    ],
    // 一致しない場合のフォールバック
    Default: [
        { feature: 'GRASS', chance: 0.05 },
        { feature: 'FLOWER', chance: 0.01 }
    ]
};