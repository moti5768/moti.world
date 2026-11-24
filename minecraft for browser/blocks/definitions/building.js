"use strict";
import { getCustomCollision, getFenceCollisionBoxes, getPaneCollisionBoxes } from '../collision.js';
import { defineBlocks } from '../registry.js';

// 1行量産ヘルパー（今後バリエーションを増やしてもコードが肥大化しない）
const cube = (name, texture, extra = null) => ({
    name,
    textures: { all: texture },
    ...extra
});

const stairs = (name, texture) => ({
    name,
    textures: { all: texture },
    geometryType: "stairs",
    transparent: true,
    lightOpacity: 0,
    directional: true,
    customCollision: () => getCustomCollision("stairs"),
    cullAdjacentFaces: false,
    screenFill: false,
    hardness: 2.0
});

const slab = (name, textures) => ({
    name,
    textures: typeof textures === "string" ? { all: textures } : textures,
    geometryType: "slab",
    transparent: true,
    lightOpacity: 0,
    isSlab: true,
    customCollision: () => getCustomCollision("slab"),
    cullAdjacentFaces: false,
    screenFill: false,
    hardness: 1.5,
    selectionSize: { x: 1, y: 0.5, z: 1 },
    selectionOffset: { x: 0.5, y: 0.25, z: 0.5 }
});

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
    GLOWSTONE: cube("glowstone", "textures/blocks/glowstone.png", { lightLevel: 15, hardness: 1.0 }),

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