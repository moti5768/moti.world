"use strict";
import {
    getBlockStateProp, setBlockStateProp,
    getRawBlockId, getRawLocalState
} from '../../blockstate.js';
import { getCustomCollision, getFenceCollisionBoxes, getPaneCollisionBoxes } from '../collision.js';
import { defineBlocks, getBlockConfiguration, registerPlacementRule } from '../registry.js';

// 1行量産ヘルパー（今後バリエーションを増やしてもコードが肥大化しない）
const cube = (name, texture, extra = null) => ({
    name,
    textures: { all: texture },
    ...extra
});

const STAIRS_BLOCKSTATE_FOLDER = "stairs";
const STAIRS_FACINGS = ['north', 'east', 'south', 'west'];
const STAIRS_SHAPES = ['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right'];
const STAIRS_DIR_DX = [0, 1, 0, -1]; // north, east, south, west
const STAIRS_DIR_DZ = [-1, 0, 1, 0];

registerPlacementRule("stairs", (cfg, camDir, rawNormal, intersectPoint) => {
    let facingIdx = 0;
    if (Math.abs(camDir.x) > Math.abs(camDir.z)) {
        facingIdx = camDir.x > 0 ? 1 : 3; // east(1) or west(3)
    } else {
        facingIdx = camDir.z > 0 ? 2 : 0; // south(2) or north(0)
    }

    let isTop = false;
    if (rawNormal.y < -0.5) {
        isTop = true;
    } else if (Math.abs(rawNormal.y) < 0.5) {
        let fracY = intersectPoint.y - Math.floor(intersectPoint.y);
        if (fracY < 0) fracY += 1;
        if (fracY > 0.49999) isTop = true;
    }

    let meta = 0;
    meta = setBlockStateProp(cfg.id, meta, "facing", STAIRS_FACINGS[facingIdx]);
    meta = setBlockStateProp(cfg.id, meta, "half", isTop ? "top" : "bottom");
    meta = setBlockStateProp(cfg.id, meta, "shape", "straight");
    return meta;
});

function readNeighborStairs(getRaw, wx, wy, wz) {
    const raw = getRaw(wx, wy, wz);
    if (raw <= 0) return null;
    const nId = getRawBlockId(raw);
    const nCfg = getBlockConfiguration(nId);
    if (!nCfg || nCfg.isStairs !== true) return null;
    const nMeta = getRawLocalState(raw);
    return {
        facingIdx: STAIRS_FACINGS.indexOf(getBlockStateProp(nId, nMeta, "facing")),
        half: getBlockStateProp(nId, nMeta, "half")
    };
}

// Java Edition StairBlock.getStairsShape 完全準拠（内角・外角・直線列の保護）
function computeStairsShape(x, y, z, facingIdx, half, getRaw) {
    const oppIdx = (facingIdx + 2) & 3;
    const leftIdx = (facingIdx + 3) & 3;
    const rightIdx = (facingIdx + 1) & 3;

    const canTakeShape = (sideDirIdx) => {
        const s = readNeighborStairs(getRaw, x + STAIRS_DIR_DX[sideDirIdx], y, z + STAIRS_DIR_DZ[sideDirIdx]);
        return !s || s.facingIdx !== facingIdx || s.half !== half;
    };

    // 1. 正面（高い側）に直交する同上下の階段があれば外角化
    const front = readNeighborStairs(getRaw, x + STAIRS_DIR_DX[facingIdx], y, z + STAIRS_DIR_DZ[facingIdx]);
    if (front && front.half === half && front.facingIdx >= 0 && front.facingIdx !== facingIdx && front.facingIdx !== oppIdx) {
        if (canTakeShape((front.facingIdx + 2) & 3)) {
            return (front.facingIdx === leftIdx) ? "outer_left" : "outer_right";
        }
    }

    // 2. 背面（低い側）に直交する同上下の階段があれば内角化
    const back = readNeighborStairs(getRaw, x + STAIRS_DIR_DX[oppIdx], y, z + STAIRS_DIR_DZ[oppIdx]);
    if (back && back.half === half && back.facingIdx >= 0 && back.facingIdx !== facingIdx && back.facingIdx !== oppIdx) {
        if (canTakeShape(back.facingIdx)) {
            return (back.facingIdx === leftIdx) ? "inner_left" : "inner_right";
        }
    }

    return "straight";
}

const stairs = (name, texture, options = {}) => ({
    name,
    blockstateFolder: STAIRS_BLOCKSTATE_FOLDER,
    blockstateFile: name,
    fallbackTexture: texture,
    isStairs: true,
    properties: {
        facing: STAIRS_FACINGS,
        half: ['bottom', 'top'],
        shape: STAIRS_SHAPES
    },
    placementRule: "stairs",
    collision: true,
    transparent: true,
    lightOpacity: 0,
    cullAdjacentFaces: false,
    screenFill: false,
    hardness: 2.0,
    onPlace: ({ x, y, z, blockId, state, getRaw }) => {
        const facingIdx = STAIRS_FACINGS.indexOf(getBlockStateProp(blockId, state, "facing"));
        const half = getBlockStateProp(blockId, state, "half");
        if (facingIdx < 0) return state;
        const shape = computeStairsShape(x, y, z, facingIdx, half, getRaw);
        return setBlockStateProp(blockId, state, "shape", shape);
    },
    onNeighborChange: ({ x, y, z, blockId, state, getRaw }) => {
        const facingIdx = STAIRS_FACINGS.indexOf(getBlockStateProp(blockId, state, "facing"));
        const half = getBlockStateProp(blockId, state, "half");
        if (facingIdx < 0) return null;
        const nextShape = computeStairsShape(x, y, z, facingIdx, half, getRaw);
        if (getBlockStateProp(blockId, state, "shape") !== nextShape) {
            return setBlockStateProp(blockId, state, "shape", nextShape);
        }
        return null;
    },
    ...options
});

const SLAB_BLOCKSTATE_FOLDER = "halfblock";

const slab = (name, textures, options = {}) => {
    const fallbackTexture = typeof textures === "string"
        ? textures
        : (textures.top || textures.side || textures.all || "textures/blocks/stone.png");
    return {
        name,
        blockstateFolder: SLAB_BLOCKSTATE_FOLDER,
        blockstateFile: name,
        fallbackTexture,
        isSlab: true,
        properties: {
            type: ['bottom', 'top', 'double']
        },
        placementRule: "slab",
        collision: true,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,
        ...options
    };
};

defineBlocks({
    STONE: cube("stone", "textures/blocks/stone.png"),
    COBBLE_STONE: cube("cobblestone", "textures/blocks/cobblestone.png"),
    COBBLE_STONE_MOSSY: cube("cobblestone_mossy", "textures/blocks/cobblestone_mossy.png"),
    COAL_ORE: cube("coal_ore", "textures/blocks/coal_ore.png"),
    IRON_ORE: cube("iron_ore", "textures/blocks/iron_ore.png"),
    GOLD_ORE: cube("gold_ore", "textures/blocks/gold_ore.png"),
    REDSTONE_ORE: cube("redstone_ore", "textures/blocks/redstone_ore.png"),
    LAPIS_ORE: cube("lapis_ore", "textures/blocks/lapis_ore.png"),
    EMERALD_ORE: cube("emerald_ore", "textures/blocks/emerald_ore.png"),
    PLANKS_OAK: cube("planks_oak", "textures/blocks/planks_oak.png"),
    BRICK: cube("brick", "textures/blocks/brick.png"),
    BEDROCK: cube("bedrock", "textures/blocks/bedrock.png"),
    WHITE_WOOL: cube("white_wool", "textures/blocks/wool_colored_white.png"),
    GLOWSTONE: cube("glowstone", "textures/blocks/glowstone.png", {
        lightLevel: 15,
        hardness: 1.0,
        redstoneConductive: false
    }),

    GLASS: cube("glass", "textures/blocks/glass.png", {
        transparent: true,
        lightOpacity: 0,
        screenFill: false
    }),

    STONE_STAIRS: stairs("stone_stairs", "textures/blocks/stone.png"),
    COBBLESTONE_STAIRS: stairs("cobblestone_stairs", "textures/blocks/cobblestone.png"),
    PLANKS_OAK_STAIRS: stairs("planks_oak_stairs", "textures/blocks/planks_oak.png"),

    STONE_SLAB: slab("stone_slab", "textures/blocks/stone.png"),
    COBBLESTONE_SLAB: slab("cobblestone_slab", "textures/blocks/cobblestone.png"),
    SMOOTHSTONE_SLAB: slab("smoothstone_slab", {
        top: "textures/blocks/stone_slab_top.png",
        bottom: "textures/blocks/stone_slab_top.png",
        side: "textures/blocks/stone_slab_side.png"
    }),
    BRICK_SLAB: slab("brick_slab", "textures/blocks/brick.png"),
    PLANKS_OAK_SLAB: slab("planks_oak_slab", "textures/blocks/planks_oak.png"),

    WHITE_WOOL_CARPET: {
        name: "white_wool_carpet",
        textures: { all: "textures/blocks/wool_colored_white.png" },
        geometryType: "carpet",
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("carpet"),
        Gamma: 0.8,
        cullAdjacentFaces: false,
        screenFill: false,
        selectionSize: { x: 1, y: 0.0625, z: 1 },
        selectionOffset: { x: 0.5, y: 0.03125, z: 0.5 }
    },

    LADDER: {
        name: "ladder",
        textures: { all: "textures/blocks/ladder.png" },
        geometryType: "ladder",
        transparent: true,
        collision: true,
        isLadder: true,
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        lightOpacity: 0,
        customCollision: () => getCustomCollision("ladder"),
        selectionSize: { x: 1, y: 1, z: 0.125 },
        selectionOffset: { x: 0.5, y: 0.5, z: 0.0625 }
    },

    PLANKS_OAK_FENCE: {
        name: "planks_oak_fence",
        textures: { all: "textures/blocks/planks_oak.png" },
        geometryType: "fence",
        transparent: true,
        lightOpacity: 0,
        customCollision: (meta) => getFenceCollisionBoxes(meta),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 2.0
    },

    GLASS_PANE: {
        name: "glass_pane",
        textures: {
            top: "textures/blocks/glass_pane_top.png",
            bottom: "textures/blocks/glass_pane_top.png",
            side: "textures/blocks/glass.png"
        },
        geometryType: "pane",
        transparent: true,
        lightOpacity: 0,
        customCollision: (meta) => getPaneCollisionBoxes(meta),
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        hardness: 0.3
    },

    TORCH: {
        name: "torch",
        redstoneConductive: false,
        properties: { mount: ['floor', 'east', 'west', 'south', 'north'] },
        placementRule: "mount_floor_or_wall",
        supportRule: "mount_opaque",
        shapeMode: "propRaw:mount",
        selectionPreset: "torch",
        geometryType: "torch",
        alphaCutout: true,
        textures: { all: "textures/blocks/torch_on.png" },
        lightLevel: 14,
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        hardness: 0.0,
        selectionSize: { x: 0.25, y: 0.625, z: 0.25 },
        selectionOffset: { x: 0.5, y: 0.3125, z: 0.5 }
    }
});