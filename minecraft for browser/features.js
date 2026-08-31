import { BLOCK_TYPES } from './blocks.js';

const ID_GRASS = BLOCK_TYPES.GRASS;
const ID_DIRT = BLOCK_TYPES.DIRT;
const ID_LEAVES = BLOCK_TYPES.LEAVES_OAK;
const ID_LOG = BLOCK_TYPES.LOG_OAK;
const ID_TALLGRASS = BLOCK_TYPES.TALLGRASS;
const ID_FLOWER = BLOCK_TYPES.FLOWER;
const ID_ROSE = BLOCK_TYPES.FLOWER_ROSE;
const ID_DEADBUSH = BLOCK_TYPES.DEADBUSH;

// --- 最適化: 静的定数の定義 ---
const TREE_OFFSETS = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
    [-2, 0], [2, 0], [0, -2], [0, 2]
];

const INV_2_32 = 1 / 4294967296;

export const Features = {
    // 🌳 オークの木
    OAK_TREE: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        const baseX = lx | 0;
        const baseY = ly | 0;
        const baseZ = lz | 0;

        // 木全体のベースとなるハッシュ（この木専用の乱数シード）
        // Z座標のビット欠損を防ぐため、単純な乗算とXORでハッシュを合成
        let treeHash = (Math.imul(worldX, 31) ^ Math.imul(worldZ, 16777619)) | 0;
        treeHash = (Math.imul(treeHash ^ (treeHash >>> 16), 2246822507)) >>> 0;
        const treeRnd = treeHash * INV_2_32;

        // --- 1. 周辺チェック ---
        if (getBlock) {
            for (let i = 0; i < TREE_OFFSETS.length; i++) {
                const off = TREE_OFFSETS[i];
                const block = getBlock(baseX + off[0], baseY, baseZ + off[1]) & 0xFFF;
                if (block === ID_LOG || block === ID_LEAVES) {
                    return;
                }
            }
        }

        // --- 2. 土台の処理 ---
        if (getBlock) {
            const below = getBlock(baseX, baseY - 1, baseZ) & 0xFFF;
            if (below === ID_GRASS) {
                setBlock(baseX, baseY - 1, baseZ, ID_DIRT, true);
            }
        }

        const height = 4 + (treeRnd * 3 | 0);
        let cornerIdx = 0;

        // --- 3. 葉っぱの配置 (本家Java版の配置パターン) ---
        // 幹の最上部とその上の2段(半径1)、その下の2段(半径2)
        for (let y = height - 3; y <= height; y++) {
            const dy = y - (height - 1); // 頂点からの相対高さ
            // 上2段(dy=0, 1)は半径1、下2段(dy=-1, -2)は半径2
            const radius = (dy >= 0) ? 1 : 2;

            for (let x = -radius; x <= radius; x++) {
                for (let z = -radius; z <= radius; z++) {
                    const absX = Math.abs(x);
                    const absZ = Math.abs(z);

                    // 本家特有の角の欠けロジック
                    if (absX === radius && absZ === radius) {
                        // 最上段の角は必ず削る
                        if (dy === 1) continue;

                        // 下段の角はランダム(約50%)で削る
                        const skipCorner = (treeHash & (1 << cornerIdx)) !== 0;
                        cornerIdx = (cornerIdx + 1) & 31;
                        if (skipCorner) continue;
                    }

                    setBlock(baseX + x, baseY + y, baseZ + z, ID_LEAVES, true);
                }
            }
        }

        // --- 4. 幹の配置 ---
        // 本家は幹が最上部の葉の1段下まで伸びる
        for (let y = 0; y < height; y++) {
            setBlock(baseX, baseY + y, baseZ, ID_LOG, true);
        }

    },

    // 🌿 背の高い草
    GRASS: (lx, ly, lz, setBlock) => setBlock(lx, ly | 0, lz, ID_TALLGRASS, false),

    // 🌟 花
    FLOWER: (lx, ly, lz, setBlock) => setBlock(lx, ly | 0, lz, ID_FLOWER, false),

    FLOWER_ROSE: (lx, ly, lz, setBlock) => setBlock(lx, ly | 0, lz, ID_ROSE, false),

    DEADBUSH: (lx, ly, lz, setBlock) => setBlock(lx, ly | 0, lz, ID_DEADBUSH, false)
};