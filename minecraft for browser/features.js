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
    OAK_TREE: (lx, ly, lz, setBlock, rnd, getBlock) => {
        // 座標を整数に固定（負の座標でのズレを防止）
        const baseX = Math.floor(lx);
        const baseY = Math.floor(ly);
        const baseZ = Math.floor(lz);

        // --- 1. 干渉チェック: 周囲3マスに他の樹木要素があったら中止 ---
        if (getBlock) {
            for (let ox = -3; ox <= 3; ox++) {
                for (let oz = -3; oz <= 3; oz++) {
                    if (ox === 0 && oz === 0) continue;

                    // 足元〜高さ2マス分くらいをチェック
                    const block = getBlock(baseX + ox, baseY, baseZ + oz) & 0xFFF;
                    if (block === ID_LOG || block === ID_LEAVES) {
                        return; // 近くに木がある場合は、何もせず終了
                    }
                }
            }
        }

        // --- 2. 土台の処理: 木の下を強制的に土にする ---
        if (getBlock) {
            const below = getBlock(baseX, baseY - 1, baseZ) & 0xFFF;
            if (below === ID_GRASS) {
                setBlock(baseX, baseY - 1, baseZ, ID_DIRT, true);
            }
        }

        // 木の高さ決定 (4〜6マス)
        const height = Math.floor(4 + (rnd * 3));

        // --- 3. 葉っぱの配置 ---
        // 高さに余裕を持たせてループ (上書き許可 true で境界問題を解消)
        for (let y = height - 2; y <= height + 1; y++) {
            const isUpper = y >= height;
            const radius = isUpper ? 1 : 2;

            for (let x = -radius; x <= radius; x++) {
                const absX = Math.abs(x);
                for (let z = -radius; z <= radius; z++) {
                    const absZ = Math.abs(z);

                    // 四隅をランダムに削って丸みを出す
                    if (absX === radius && absZ === radius) {
                        if (isUpper || rnd > 0.5) continue;
                    }

                    // チャンク境界での消失を防ぐため、allowOverwrite を true に設定
                    setBlock(baseX + x, baseY + y, baseZ + z, ID_LEAVES, true);
                }
            }
        }

        // --- 4. 幹の配置 ---
        for (let y = 0; y < height; y++) {
            // 幹も念のため上書き許可(true)にしておくと、
            // 稀に葉っぱと座標が被った際にも幹が優先されます
            setBlock(baseX, baseY + y, baseZ, ID_LOG, true);
        }
    },

    // 🌿 背の高い草
    GRASS: (lx, ly, lz, setBlock) => {
        setBlock(lx, ly | 0, lz, ID_TALLGRASS, false);
    },

    //  Tulip / Rose
    FLOWER: (lx, ly, lz, setBlock, rnd) => {
        setBlock(lx, ly | 0, lz, (rnd > 0.5) ? ID_FLOWER : ID_ROSE, false);
    },

    FLOWER_ROSE: (lx, ly, lz, setBlock) => {
        setBlock(lx, ly | 0, lz, ID_ROSE, false);
    },

    // 🌵 枯れ木
    DEADBUSH: (lx, ly, lz, setBlock) => {
        setBlock(lx, ly | 0, lz, ID_DEADBUSH, false);
    }
};