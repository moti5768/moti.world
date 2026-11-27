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

const TREE_OFFSETS = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
    [-2, 0], [2, 0], [0, -2], [0, 2]
];

const INV_2_32 = 1 / 4294967296;

function makeCoordRng(wx, wy, wz, salt) {
    let s = (Math.imul(wx | 0, 374761393) ^ Math.imul(wz | 0, 668265263) ^ Math.imul(wy | 0, 1274126177) ^ (salt | 0)) | 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0);
    };
}

function canGrowTreeAt(baseX, baseY, baseZ, getBlock) {
    if (!getBlock) return true;
    const below = getBlock(baseX, baseY - 1, baseZ) & 0xFFF;
    if (below !== ID_GRASS && below !== ID_DIRT && below !== ID_SNOW) {
        return false;
    }

    for (let i = 0; i < TREE_OFFSETS.length; i++) {
        const off = TREE_OFFSETS[i];
        const b0 = getBlock(baseX + off[0], baseY, baseZ + off[1]) & 0xFFF;
        const b1 = getBlock(baseX + off[0], baseY + 1, baseZ + off[1]) & 0xFFF;
        if (b0 === ID_LOG || b0 === ID_LEAVES || b1 === ID_LOG) {
            return false;
        }
    }
    return true;
}

/**
 * 本家 Beta 1.8 WorldGenTallGrass / WorldGenFlowers 準拠の群生パッチ生成ヘルパー
 */
function placePlantPatch(lx, ly, lz, setBlock, getBlock, blockId, tries, spreadXZ, allowSand = false) {
    const bx = lx | 0;
    const by = ly | 0;
    const bz = lz | 0;
    const next = makeCoordRng(bx, by, bz, blockId * 97 + tries);

    for (let i = 0; i < tries; i++) {
        const rx = ((next() % (spreadXZ * 2 + 1)) | 0) - spreadXZ;
        const rz = ((next() % (spreadXZ * 2 + 1)) | 0) - spreadXZ;
        const ry = ((next() % 5) | 0) - 2;

        const wx = bx + rx;
        const wy = by + ry;
        const wz = bz + rz;
        if (wy <= 62 || wy >= 254) continue;

        if (getBlock) {
            if ((getBlock(wx, wy, wz) & 0xFFF) !== ID_SKY) continue;
            const below = getBlock(wx, wy - 1, wz) & 0xFFF;
            const validSoil = allowSand
                ? (below === ID_SAND || below === ID_DIRT)
                : (below === ID_GRASS || below === ID_DIRT);
            if (!validSoil) continue;
        }
        setBlock(wx, wy, wz, blockId, false);
    }
}

export const Features = {
    // 🌳 通常オークの木（本家 Beta 1.8 WorldGenTrees 準拠: 高さ 4〜6）
    OAK_TREE: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        const baseX = lx | 0;
        const baseY = ly | 0;
        const baseZ = lz | 0;

        if (!canGrowTreeAt(baseX, baseY, baseZ, getBlock)) return;

        let treeHash = (Math.imul(worldX, 31) ^ Math.imul(worldZ, 16777619)) | 0;
        treeHash = (Math.imul(treeHash ^ (treeHash >>> 16), 2246822507)) >>> 0;
        const treeRnd = treeHash * INV_2_32;

        if (getBlock) {
            const below = getBlock(baseX, baseY - 1, baseZ) & 0xFFF;
            if (below === ID_GRASS || below === ID_SNOW) {
                setBlock(baseX, baseY - 1, baseZ, ID_DIRT, true);
            }
        }

        const height = 4 + ((treeRnd * 3) | 0);
        let cornerIdx = 0;

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

        for (let y = 0; y < height; y++) {
            setBlock(baseX, baseY + y, baseZ, ID_LOG, true);
        }
    },

    // 🌲 タイガ針葉樹（本家 Beta 1.8 WorldGenTaiga2 準拠: 高さ 6〜9、段々円錐の葉冠）
    TAIGA_TREE: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        const baseX = lx | 0;
        const baseY = ly | 0;
        const baseZ = lz | 0;

        if (!canGrowTreeAt(baseX, baseY, baseZ, getBlock)) return;

        const next = makeCoordRng(worldX, baseY, worldZ, 0x7A16A);
        const height = 6 + (next() % 4);          // 6..9
        const trunkTopLeafGap = 1 + (next() % 2); // 下部の枝無し高さ
        const maxLeafRadius = 2 + (next() % 2);   // 2..3

        if (getBlock) {
            const below = getBlock(baseX, baseY - 1, baseZ) & 0xFFF;
            if (below === ID_GRASS || below === ID_SNOW) {
                setBlock(baseX, baseY - 1, baseZ, ID_DIRT, true);
            }
        }

        let curRadius = next() % 2;
        let maxR = 1;
        let resetFlag = 0;

        for (let dy = 0; dy <= height - trunkTopLeafGap; dy++) {
            const y = baseY + height - dy;
            for (let x = -curRadius; x <= curRadius; x++) {
                const absX = Math.abs(x);
                for (let z = -curRadius; z <= curRadius; z++) {
                    const absZ = Math.abs(z);
                    if (absX === curRadius && absZ === curRadius && curRadius > 0) continue;
                    setBlock(baseX + x, y, baseZ + z, ID_LEAVES, true);
                }
            }

            if (curRadius >= maxR) {
                curRadius = resetFlag;
                resetFlag = 1;
                if (++maxR > maxLeafRadius) maxR = maxLeafRadius;
            } else {
                curRadius++;
            }
        }

        const trunkHeight = height - 1;
        for (let y = 0; y < trunkHeight; y++) {
            setBlock(baseX, baseY + y, baseZ, ID_LOG, true);
        }
    },

    // 🌳 沼地の木（本家 Beta 1.8 WorldGenSwamp 準拠: 幅広な平たい傘状オーク）
    SWAMP_TREE: (lx, ly, lz, setBlock, rnd, getBlock, worldX = 0, worldZ = 0) => {
        const baseX = lx | 0;
        const baseY = ly | 0;
        const baseZ = lz | 0;

        if (!canGrowTreeAt(baseX, baseY, baseZ, getBlock)) return;

        const next = makeCoordRng(worldX, baseY, worldZ, 0x5BA49);
        const height = 5 + (next() % 3); // 5..7

        if (getBlock) {
            const below = getBlock(baseX, baseY - 1, baseZ) & 0xFFF;
            if (below === ID_GRASS || below === ID_SNOW) {
                setBlock(baseX, baseY - 1, baseZ, ID_DIRT, true);
            }
        }

        for (let y = height - 3; y <= height; y++) {
            const dy = y - height;
            const radius = 2 - (dy >> 1); // 下2段=半径3、上2段=半径2

            for (let x = -radius; x <= radius; x++) {
                const absX = Math.abs(x);
                for (let z = -radius; z <= radius; z++) {
                    const absZ = Math.abs(z);
                    if (absX === radius && absZ === radius && (dy === 0 || (next() & 1) === 0)) continue;
                    setBlock(baseX + x, baseY + y, baseZ + z, ID_LEAVES, true);
                }
            }
        }

        for (let y = 0; y < height; y++) {
            setBlock(baseX, baseY + y, baseZ, ID_LOG, true);
        }
    },

    // 🌿 草の群生パッチ（Beta 1.8 WorldGenTallGrass 準拠）
    GRASS_PATCH: (lx, ly, lz, setBlock, rnd, getBlock) => {
        placePlantPatch(lx, ly, lz, setBlock, getBlock, ID_TALLGRASS, 24, 5, false);
    },

    // 🌼 タンポポ群生パッチ（Beta 1.8 WorldGenFlowers 準拠）
    FLOWER_PATCH: (lx, ly, lz, setBlock, rnd, getBlock) => {
        placePlantPatch(lx, ly, lz, setBlock, getBlock, ID_FLOWER, 10, 4, false);
    },

    // 🌹 バラ群生パッチ
    ROSE_PATCH: (lx, ly, lz, setBlock, rnd, getBlock) => {
        placePlantPatch(lx, ly, lz, setBlock, getBlock, ID_ROSE, 8, 4, false);
    },

    // 🍄 キノコ群生パッチ（沼地・森林用）
    MUSHROOM_BROWN_PATCH: (lx, ly, lz, setBlock, rnd, getBlock) => {
        placePlantPatch(lx, ly, lz, setBlock, getBlock, ID_MUSHROOM_BROWN, 6, 3, false);
    },

    MUSHROOM_RED_PATCH: (lx, ly, lz, setBlock, rnd, getBlock) => {
        placePlantPatch(lx, ly, lz, setBlock, getBlock, ID_MUSHROOM_RED, 5, 3, false);
    },

    // 🥀 枯れ木パッチ（砂漠・沼地用）
    DEADBUSH_PATCH: (lx, ly, lz, setBlock, rnd, getBlock) => {
        placePlantPatch(lx, ly, lz, setBlock, getBlock, ID_DEADBUSH, 5, 4, true);
    },

    // --- 単体配置（後方互換維持） ---
    GRASS: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT) return;
        }
        setBlock(bx, by, bz, ID_TALLGRASS, false);
    },

    FLOWER: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT) return;
        }
        setBlock(bx, by, bz, ID_FLOWER, false);
    },

    FLOWER_ROSE: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT) return;
        }
        setBlock(bx, by, bz, ID_ROSE, false);
    },

    MUSHROOM_RED: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT && below !== ID_STONE) return;
        }
        setBlock(bx, by, bz, ID_MUSHROOM_RED, false);
    },

    MUSHROOM_BROWN: (lx, ly, lz, setBlock, rnd, getBlock) => {
        const bx = lx | 0, by = ly | 0, bz = lz | 0;
        if (getBlock) {
            if ((getBlock(bx, by, bz) & 0xFFF) !== ID_SKY) return;
            const below = getBlock(bx, by - 1, bz) & 0xFFF;
            if (below !== ID_GRASS && below !== ID_DIRT && below !== ID_STONE) return;
        }
        setBlock(bx, by, bz, ID_MUSHROOM_BROWN, false);
    },

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