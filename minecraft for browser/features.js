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
        let treeHash = Math.imul(worldX ^ (worldZ << 16), 16777619);
        treeHash = (treeHash ^ (treeHash >>> 16)) >>> 0;
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

        const height = (4 + (treeRnd * 3)) | 0;

        // 🌟 最適化: 葉の角を削る判定用に、treeHashのビット列をフラグとして使い回す
        // これにより、ブロックごとのハッシュ計算が不要になります
        let cornerIdx = 0;

        // --- 3. 葉っぱの配置 ---
        for (let y = height - 2; y <= height + 1; y++) {
            const isUpper = y >= height;
            const radius = isUpper ? 1 : 2;

            for (let x = -radius; x <= radius; x++) {
                const absX = x < 0 ? -x : x;
                for (let z = -radius; z <= radius; z++) {
                    const absZ = z < 0 ? -z : z;

                    // 角のブロックの処理
                    if (absX === radius && absZ === radius) {
                        if (isUpper) continue; // 上部は必ず削る

                        // 🌟 最適化: treeHashの特定のビットをチェックして確率50%を高速に判定
                        const skipCorner = (treeHash & (1 << cornerIdx)) !== 0;
                        cornerIdx = (cornerIdx + 1) & 31; // 次のビットへ進める (最大32ビット)

                        if (skipCorner) continue;
                    }

                    setBlock(baseX + x, baseY + y, baseZ + z, ID_LEAVES, true);
                }
            }
        }

        // --- 4. 幹の配置 ---
        for (let y = 0; y < height; y++) {
            setBlock(baseX, baseY + y, baseZ, ID_LOG, true);
        }
    },

    // 🌿 背の高い草
    GRASS: (lx, ly, lz, setBlock) => {
        setBlock(lx, ly | 0, lz, ID_TALLGRASS, false);
    },

    // 🌟 花
    FLOWER: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        // 花の種類も簡単なハッシュで決定（ここは1回なのでそのままで問題ありません）
        const flowerHash = Math.imul(worldX ^ (worldZ << 16), 16777619);
        const flowerRnd = (flowerHash >>> 0) * INV_2_32;
        setBlock(lx, ly | 0, lz, (flowerRnd > 0.5) ? ID_FLOWER : ID_ROSE, false);
    },

    FLOWER_ROSE: (lx, ly, lz, setBlock) => {
        setBlock(lx, ly | 0, lz, ID_ROSE, false);
    },

    DEADBUSH: (lx, ly, lz, setBlock) => {
        setBlock(lx, ly | 0, lz, ID_DEADBUSH, false);
    }
};