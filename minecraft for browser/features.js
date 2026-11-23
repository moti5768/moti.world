import { BLOCK_TYPES } from './blocks.js';

const ID_SKY = BLOCK_TYPES.SKY;
const ID_GRASS = BLOCK_TYPES.GRASS;
const ID_DIRT = BLOCK_TYPES.DIRT;
const ID_SAND = BLOCK_TYPES.SAND;
const ID_STONE = BLOCK_TYPES.STONE;
const ID_SNOW = BLOCK_TYPES.SNOW;
const ID_WATER = BLOCK_TYPES.WATER;
const ID_LEAVES = BLOCK_TYPES.LEAVES_OAK;
const ID_LOG = BLOCK_TYPES.LOG_OAK;
const ID_TALLGRASS = BLOCK_TYPES.TALLGRASS;
const ID_FLOWER = BLOCK_TYPES.FLOWER;
const ID_ROSE = BLOCK_TYPES.FLOWER_ROSE;
const ID_MUSHROOM_RED = BLOCK_TYPES.MUSHROOM_RED;
const ID_MUSHROOM_BROWN = BLOCK_TYPES.MUSHROOM_BROWN;
const ID_DEADBUSH = BLOCK_TYPES.DEADBUSH;
const ID_COBBLE = BLOCK_TYPES.COBBLE_STONE || ID_DIRT;

// --- 拡張: データ駆動型の汎用構造物ビルダー（多点平坦性検証＆基礎自動補填付き） ---
function buildStructure(lx, ly, lz, setBlock, getBlock, structureData) {
    const bx = lx | 0;
    const by = ly | 0;
    const bz = lz | 0;
    const fpX = structureData.footprintX || 1;
    const fpZ = structureData.footprintZ || 1;

    if (getBlock && structureData.requiresFlatTerrain) {
        for (let dx = 0; dx < fpX; dx++) {
            for (let dz = 0; dz < fpZ; dz++) {
                const wx = bx + dx;
                const wz = bz + dz;
                // 1段下または2段下まで支持地面があるか確認（急崖への空中生成を防止）
                const b1 = getBlock(wx, by - 1, wz) & 0xFFF;
                const b2 = getBlock(wx, by - 2, wz) & 0xFFF;
                const valid1 = (b1 === ID_GRASS || b1 === ID_DIRT || b1 === ID_SAND);
                const valid2 = (b2 === ID_GRASS || b2 === ID_DIRT || b2 === ID_SAND);
                if (!valid1 && !valid2) return;

                // 構造物内部空間に既存の木や水が被っていないか確認
                const at0 = getBlock(wx, by, wz) & 0xFFF;
                const at1 = getBlock(wx, by + 1, wz) & 0xFFF;
                if (at0 === ID_WATER || at0 === ID_LOG || at1 === ID_LOG) return;

                // 1段分の段差がある角には基礎ブロックを補填して浮遊を防ぐ
                if (!valid1 && valid2) {
                    setBlock(wx, by - 1, wz, ID_COBBLE, true);
                }
            }
        }
    }

    // 定義された相対座標の配列に従ってブロックを一括配置
    for (let i = 0; i < structureData.blocks.length; i++) {
        const [dx, dy, dz, blockId] = structureData.blocks[i];
        setBlock(bx + dx, by + dy, bz + dz, blockId, true);
    }
}

// 構造物テンプレートの定義例
const STRUCTURE_TENT = {
    requiresFlatTerrain: true,
    footprintX: 2,
    footprintZ: 2,
    blocks: [
        [0, 0, 0, BLOCK_TYPES.PLANKS_OAK || ID_LOG], [1, 0, 0, BLOCK_TYPES.PLANKS_OAK || ID_LOG],
        [0, 0, 1, BLOCK_TYPES.PLANKS_OAK || ID_LOG], [1, 0, 1, BLOCK_TYPES.PLANKS_OAK || ID_LOG],
        [0, 1, 0, BLOCK_TYPES.GLOWSTONE || ID_DIRT], [1, 1, 0, BLOCK_TYPES.WHITE_WOOL || ID_DIRT],
        [0, 1, 1, BLOCK_TYPES.WHITE_WOOL || ID_DIRT], [1, 1, 1, BLOCK_TYPES.GLOWSTONE || ID_DIRT],
        [0, 2, 0, BLOCK_TYPES.GLOWSTONE || ID_DIRT], [0, 2, 1, BLOCK_TYPES.WHITE_WOOL || ID_DIRT]
    ]
};

// --- 最適化: 静的定数の定義 ---
const TREE_OFFSETS = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
    [-2, 0], [2, 0], [0, -2], [0, 2]
];

const INV_2_32 = 1 / 4294967296;

export const Features = {
    // 🌳 オークの木 (アルゴリズムによるプロシージャル生成)
    OAK_TREE: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        const baseX = lx | 0;
        const baseY = ly | 0;
        const baseZ = lz | 0;

        // 木全体のベースとなるハッシュ（この木専用の乱数シード）
        let treeHash = (Math.imul(worldX, 31) ^ Math.imul(worldZ, 16777619)) | 0;
        treeHash = (Math.imul(treeHash ^ (treeHash >>> 16), 2246822507)) >>> 0;
        const treeRnd = treeHash * INV_2_32;

        // --- 1. 土台・周辺チェック ---
        if (getBlock) {
            const below = getBlock(baseX, baseY - 1, baseZ) & 0xFFF;
            // 木は草・土・雪原表土の上のみ生える（石・砂・水の上には生えない）
            if (below !== ID_GRASS && below !== ID_DIRT && below !== ID_SNOW) {
                return;
            }

            // 根元および1段上（斜面隣接）の幹・葉干渉を防止
            for (let i = 0; i < TREE_OFFSETS.length; i++) {
                const off = TREE_OFFSETS[i];
                const b0 = getBlock(baseX + off[0], baseY, baseZ + off[1]) & 0xFFF;
                const b1 = getBlock(baseX + off[0], baseY + 1, baseZ + off[1]) & 0xFFF;
                if (b0 === ID_LOG || b0 === ID_LEAVES || b1 === ID_LOG) {
                    return;
                }
            }

            if (below === ID_GRASS || below === ID_SNOW) {
                setBlock(baseX, baseY - 1, baseZ, ID_DIRT, true);
            }
        }

        const height = 4 + (treeRnd * 3 | 0);
        let cornerIdx = 0;

        // --- 2. 葉っぱの配置 (本家Java版の配置パターン) ---
        for (let y = height - 3; y <= height; y++) {
            const dy = y - (height - 1);
            const radius = (dy >= 0) ? 1 : 2;

            for (let x = -radius; x <= radius; x++) {
                for (let z = -radius; z <= radius; z++) {
                    const absX = Math.abs(x);
                    const absZ = Math.abs(z);

                    if (absX === radius && absZ === radius) {
                        if (dy === 1) continue;

                        const skipCorner = (treeHash & (1 << cornerIdx)) !== 0;
                        cornerIdx = (cornerIdx + 1) & 31;
                        if (skipCorner) continue;
                    }

                    setBlock(baseX + x, baseY + y, baseZ + z, ID_LEAVES, true);
                }
            }
        }

        // --- 3. 幹の配置 ---
        for (let y = 0; y < height; y++) {
            setBlock(baseX, baseY + y, baseZ, ID_LOG, true);
        }
    },

    // ⛺ データ配列定義から生成されるカスタム構造物
    CUSTOM_TENT: (lx, ly, lz, setBlock, rnd, getBlock) => {
        buildStructure(lx, ly, lz, setBlock, getBlock, STRUCTURE_TENT);
    },

    // 🌿 背の高い草（草ブロック・土の上のみ配置）
    GRASS: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT) return;
        }
        setBlock(bx, by, bz, ID_TALLGRASS, false);
    },

    // 🌼 タンポポ（草ブロック・土の上のみ配置）
    FLOWER: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT) return;
        }
        setBlock(bx, by, bz, ID_FLOWER, false);
    },

    // 🌹 バラ（草ブロック・土の上のみ配置）
    FLOWER_ROSE: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT) return;
        }
        setBlock(bx, by, bz, ID_ROSE, false);
    },

    // 🍄 赤キノコ（草・土・石の上のみ配置）
    MUSHROOM_RED: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT && below !== ID_STONE) return;
        }
        setBlock(bx, by, bz, ID_MUSHROOM_RED, false);
    },

    // 🍄 茶キノコ（草・土・石の上のみ配置）
    MUSHROOM_BROWN: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT && below !== ID_STONE) return;
        }
        setBlock(bx, by, bz, ID_MUSHROOM_BROWN, false);
    },

    // 🥀 枯れ木（砂・土・雪原表土の上のみ配置）
    DEADBUSH: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_SAND && below !== ID_DIRT && below !== ID_SNOW) return;
        }
        setBlock(bx, by, bz, ID_DEADBUSH, false);
    }
};