import { BLOCK_TYPES } from './blocks.js';

const ID_GRASS = BLOCK_TYPES.GRASS;
const ID_DIRT = BLOCK_TYPES.DIRT;
const ID_LEAVES = BLOCK_TYPES.LEAVES_OAK;
const ID_LOG = BLOCK_TYPES.LOG_OAK;
const ID_TALLGRASS = BLOCK_TYPES.TALLGRASS;
const ID_FLOWER = BLOCK_TYPES.FLOWER;
const ID_ROSE = BLOCK_TYPES.FLOWER_ROSE;
const ID_DEADBUSH = BLOCK_TYPES.DEADBUSH;

export const Features = {
    // 🌳 オークの木
    // 🌟 引数の最後に worldX, worldZ を追加
    OAK_TREE: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        const baseX = Math.floor(lx);
        const baseY = Math.floor(ly);
        const baseZ = Math.floor(lz);

        // 🌟 1. 座標に基づいた絶対的な乱数（シード）を生成
        // これにより、隣のチャンクからこの木を計算しても、必ず同じ treeRnd が得られる
        let treeHash = Math.imul(worldX ^ (worldZ << 16), 16777619);
        treeHash = (treeHash ^ (treeHash >>> 16)) >>> 0;
        const treeRnd = treeHash / 4294967296;

        // --- 1. 周辺チェック ---
        if (getBlock) {
            const offsets = [
                [-1, -1], [0, -1], [1, -1],
                [-1, 0], [1, 0],
                [-1, 1], [0, 1], [1, 1],
                [-2, 0], [2, 0], [0, -2], [0, 2]
            ];
            for (let i = 0; i < offsets.length; i++) {
                const block = getBlock(baseX + offsets[i][0], baseY, baseZ + offsets[i][1]) & 0xFFF;
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

        // 🌟 2. 高さを treeRnd で決定 (外部の rnd に依存しない)
        const height = Math.floor(4 + (treeRnd * 3));

        // --- 3. 葉っぱの配置 ---
        for (let y = height - 2; y <= height + 1; y++) {
            const isUpper = y >= height;
            const radius = isUpper ? 1 : 2;

            for (let x = -radius; x <= radius; x++) {
                const absX = Math.abs(x);
                for (let z = -radius; z <= radius; z++) {
                    const absZ = Math.abs(z);

                    // 四隅をランダムに削って丸みを出す
                    if (absX === radius && absZ === radius) {
                        // 🌟 3. 葉っぱの欠け判定も、その座標固有の乱数で行う
                        // (y座標も含めることで、段ごとに違う欠け方にする)
                        let leafHash = Math.imul(treeHash ^ (x + 7) ^ ((z + 7) << 4) ^ (y << 8), 16777619);
                        const leafRnd = (leafHash >>> 0) / 4294967296;

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

    // 🌟 花も rnd ではなく座標ハッシュで種類を固定するとさらに安定します
    FLOWER: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        const flowerHash = Math.imul(worldX ^ (worldZ << 16), 16777619);
        const flowerRnd = (flowerHash >>> 0) / 4294967296;
        setBlock(lx, ly | 0, lz, (flowerRnd > 0.5) ? ID_FLOWER : ID_ROSE, false);
    },

    FLOWER_ROSE: (lx, ly, lz, setBlock) => {
        setBlock(lx, ly | 0, lz, ID_ROSE, false);
    },

    DEADBUSH: (lx, ly, lz, setBlock) => {
        setBlock(lx, ly | 0, lz, ID_DEADBUSH, false);
    }
};