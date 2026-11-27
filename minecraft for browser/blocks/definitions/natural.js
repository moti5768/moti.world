"use strict";
import { getBlockStateProp, setBlockStateProp, packRawBlock } from '../../blockstate.js';
import { getCustomCollision } from '../collision.js';
import { BLOCK_TYPES, defineBlocks } from '../registry.js';

// クロス植物の1行量産ヘルパー
function plant(name, texture, size, offsetY, overwrite = false) {
    return {
        name,
        textures: { all: texture },
        collision: false,
        geometryType: "cross",
        transparent: true,
        lightOpacity: 0,
        overwrite,
        customCollision: () => getCustomCollision("cross"),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        selectionSize: { x: size, y: offsetY * 2, z: size },
        selectionOffset: { x: 0.5, y: offsetY, z: 0.5 }
    };
}

defineBlocks({
    SKY: {
        id: 0,
        itemdisplay: false,
        collision: false,
        geometryType: "none",
        transparent: true,
        opacity: 1,
        overwrite: true,
        screenFill: false,
        textures: {}
    },

    GRASS: {
        name: "grass_block",
        biomeTint: "grass",
        sideOverlay: "textures/blocks/grass_side_overlay.png",
        properties: { snowy: false },
        textures: {
            top: "textures/blocks/grass_top.png",
            side: "textures/blocks/grass_side.png",
            bottom: "textures/blocks/dirt.png"
        },
        stateVariants: {
            "snowy=false": {
                biomeTint: "grass",
                sideOverlay: "textures/blocks/grass_side_overlay.png",
                textures: {
                    top: "textures/blocks/grass_top.png",
                    side: "textures/blocks/grass_side.png",
                    bottom: "textures/blocks/dirt.png"
                }
            },
            "snowy=true": {
                biomeTint: null,
                sideOverlay: null,
                textures: {
                    top: "textures/blocks/snow.png",
                    side: "textures/blocks/grass_side_snowed.png",
                    bottom: "textures/blocks/dirt.png"
                }
            }
        },
        onPlace: ({ x, y, z, blockId, state, getBlockId }) => {
            const shouldBeSnowy = (getBlockId(x, y + 1, z) === BLOCK_TYPES.SNOW);
            return setBlockStateProp(blockId, state, "snowy", shouldBeSnowy);
        },
        onNeighborChange: ({ x, y, z, blockId, state, getBlockId }) => {
            const shouldBeSnowy = (getBlockId(x, y + 1, z) === BLOCK_TYPES.SNOW);
            if (getBlockStateProp(blockId, state, "snowy") !== shouldBeSnowy) {
                return setBlockStateProp(blockId, state, "snowy", shouldBeSnowy);
            }
            return null;
        },
        onRandomTick: ({ x, y, z, blockId, state, getBlockId, getLightOpacity, getLightLevel, setBlock, nextRng, chunkHeight }) => {
            const aboveId = getBlockId(x, y + 1, z);
            if (aboveId < 0) return;

            if (aboveId === BLOCK_TYPES.SNOW) {
                if (!getBlockStateProp(blockId, state, "snowy")) {
                    const nextMeta = setBlockStateProp(blockId, state, "snowy", true);
                    setBlock(x, y, z, packRawBlock(blockId, nextMeta));
                }
                return;
            }

            if (getLightOpacity(aboveId) >= 15 || aboveId === BLOCK_TYPES.WATER || aboveId === BLOCK_TYPES.LAVA) {
                setBlock(x, y, z, BLOCK_TYPES.DIRT);
                return;
            }

            if (getBlockStateProp(blockId, state, "snowy")) {
                const nextMeta = setBlockStateProp(blockId, state, "snowy", false);
                setBlock(x, y, z, packRawBlock(blockId, nextMeta));
            }

            const aboveLight = getLightLevel(x, y + 1, z);
            if (aboveLight < 0) return;
            const sky = (aboveLight >> 4) & 15;
            const blk = aboveLight & 15;
            if ((sky > blk ? sky : blk) < 9) return;

            const r = nextRng();
            const tx = x + ((r % 3) - 1);
            const tz = z + ((((r >>> 4) | 0) % 3) - 1);
            const ty = y + ((((r >>> 8) | 0) % 4) - 1);
            if (ty <= 0 || ty >= chunkHeight - 1) return;

            if (getBlockId(tx, ty, tz) !== BLOCK_TYPES.DIRT) return;

            const targetAboveId = getBlockId(tx, ty + 1, tz);
            if (targetAboveId < 0) return;
            if (targetAboveId !== BLOCK_TYPES.SNOW && getLightOpacity(targetAboveId) >= 2) return;

            const targetAboveLight = getLightLevel(tx, ty + 1, tz);
            if (targetAboveLight < 0) return;
            const tSky = (targetAboveLight >> 4) & 15;
            const tBlk = targetAboveLight & 15;
            if ((tSky > tBlk ? tSky : tBlk) < 4) return;

            const spreadMeta = setBlockStateProp(
                BLOCK_TYPES.GRASS,
                0,
                "snowy",
                targetAboveId === BLOCK_TYPES.SNOW
            );
            setBlock(tx, ty, tz, packRawBlock(BLOCK_TYPES.GRASS, spreadMeta));
        }
    },

    DIRT: { name: "dirt", textures: { all: "textures/blocks/dirt.png" } },
    SAND: { name: "sand", textures: { all: "textures/blocks/sand.png" } },
    SANDSTONE: {
        name: "sandstone",
        textures: {
            top: "textures/blocks/sandstone_top.png",
            side: "textures/blocks/sandstone_normal.png",
            bottom: "textures/blocks/sandstone_bottom.png"
        }
    },
    SNOW: { name: "snow", textures: { all: "textures/blocks/snow.png" } },
    GRAVEL: { name: "gravel", textures: { all: "textures/blocks/gravel.png" } },

    LOG_OAK: {
        name: "log_oak",
        isLog: true,
        textures: {
            top: "textures/blocks/log_oak_top.png",
            bottom: "textures/blocks/log_oak_top.png",
            side: "textures/blocks/log_oak.png"
        }
    },

    LEAVES_OAK: {
        name: "leaves_oak",
        biomeTint: "foliage",
        textures: { all: "textures/blocks/leaves_oak.png" },
        geometryType: "leaves",
        transparent: true,
        cullAdjacentFaces: false,
        lightOpacity: 1,
        screenFill: false
    },

    FLOWER: plant("flower", "textures/blocks/flower.png", 0.4, 0.3, false),
    FLOWER_ROSE: plant("flower_rose", "textures/blocks/flower_rose.png", 0.4, 0.3, false),
    TALLGRASS: { ...plant("tallgrass", "textures/blocks/tallgrass.png", 0.8, 0.4, true), biomeTint: "grass" },
    MUSHROOM_RED: plant("mushroom_red", "textures/blocks/mushroom_red.png", 0.5, 0.25, true),
    MUSHROOM_BROWN: plant("mushroom_brown", "textures/blocks/mushroom_brown.png", 0.5, 0.25, true),
    SAPLING_OAK: plant("sapling_oak", "textures/blocks/sapling_oak.png", 0.8, 0.4, false),
    DEADBUSH: plant("deadbush", "textures/blocks/deadbush.png", 0.8, 0.4, false),

    WATER: {
        name: "water",
        properties: { level: { min: 0, max: 7, default: 0 }, falling: false },
        textures: { all: "textures/blocks/water.png" },
        collision: false,
        transparent: true,
        opacity: 0.8,
        targetblock: false,
        lightOpacity: 2,
        overwrite: true,
        cullAdjacentFaces: true,
        screenFill: { enabled: true, opacity: 0.5 },
        geometryType: "water",
        previewType: "3D"
    },

    LAVA: {
        name: "lava",
        properties: { level: { min: 0, max: 7, default: 0 }, falling: false },
        textures: { all: "textures/blocks/lava.png" },
        collision: false,
        transparent: true,
        opacity: 1,
        targetblock: false,
        overwrite: true,
        cullAdjacentFaces: true,
        geometryType: "water",
        lightLevel: 15,
        previewType: "3D"
    }
});