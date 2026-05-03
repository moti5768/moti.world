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
// 関数外で定義することで、呼び出しごとのメモリ確保(GC)をゼロにします
const TREE_OFFSETS = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
    [-2, 0], [2, 0], [0, -2], [0, 2]
];

// 除算(重い)を避けるための逆数定数 (1 / 2^32)
const INV_2_32 = 1 / 4294967296;

export const Features = {
    // 🌳 オークの木
    OAK_TREE: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        // 高速化: Math.floor の代わりにビット演算を使用[cite: 7]
        const baseX = lx | 0;
        const baseY = ly | 0;
        const baseZ = lz | 0;

        // 座標ベースのハッシュ生成
        let treeHash = Math.imul(worldX ^ (worldZ << 16), 16777619);
        treeHash = (treeHash ^ (treeHash >>> 16)) >>> 0;
        // 高速化: 除算を乗算に変更[cite: 7]
        const treeRnd = treeHash * INV_2_32;

        // --- 1. 周辺チェック ---
        if (getBlock) {
            for (let i = 0; i < TREE_OFFSETS.length; i++) {
                const off = TREE_OFFSETS[i];
                // getBlock の座標計算をインライン化
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

        // --- 3. 葉っぱの配置 ---
        for (let y = height - 2; y <= height + 1; y++) {
            const isUpper = y >= height;
            const radius = isUpper ? 1 : 2;

            for (let x = -radius; x <= radius; x++) {
                // 高速化: Math.abs を三項演算子でインライン化[cite: 7]
                const absX = x < 0 ? -x : x;
                for (let z = -radius; z <= radius; z++) {
                    const absZ = z < 0 ? -z : z;

                    if (absX === radius && absZ === radius) {
                        let leafHash = Math.imul(treeHash ^ (x + 7) ^ ((z + 7) << 4) ^ (y << 8), 16777619);
                        const leafRnd = (leafHash >>> 0) * INV_2_32;

                        if (isUpper || leafRnd > 0.5) continue;
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