"use strict";
import { getBlockStateProp, setBlockStateProp } from '../../blockstate.js';
import { getCustomCollision } from '../collision.js';
import { defineBlocks } from '../registry.js';

// blockstates 配下のサブフォルダ設定（フォルダ構成を変えたらここ1行だけで全量産ブロックへ反映）
const BUTTON_BLOCKSTATE_FOLDER = "buttons";
const PRESSURE_PLATE_BLOCKSTATE_FOLDER = "pressure_plate";
const PLATE_BLOCKSTATE_FOLDER = "";

// ボタン1行量産ヘルパー（今後シラカバ・マツ等を追加しても1行で完了）
function buttonBlock(name, pressTicks, options = {}) {
    return {
        name,
        blockstateFolder: BUTTON_BLOCKSTATE_FOLDER,
        blockstateFile: name,
        redstoneRole: "button",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        redstoneDevice: true,
        buttonPressTicks: pressTicks,
        properties: {
            mount: ['floor', 'east', 'west', 'south', 'north'],
            powered: false
        },
        placementRule: "mount_floor_or_wall",
        supportRule: "mount_opaque",
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 0.5,
        previewOptions: { rotation: { x: 0, y: 0, z: 0 }, scale: 4.2 },
        onInteract: ({ blockId, state, scheduleTick }) => {
            if (getBlockStateProp(blockId, state, "powered")) return "consumed";
            scheduleTick(pressTicks, "redstone_device", -1, 0);
            return setBlockStateProp(blockId, state, "powered", true);
        },
        ...options
    };
}

// 感圧板1行量産ヘルパー
function pressurePlateBlock(name, holdTicks = 20, options = {}) {
    return {
        name,
        blockstateFolder: PRESSURE_PLATE_BLOCKSTATE_FOLDER,
        blockstateFile: name,
        redstoneRole: "pressure_plate",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        redstoneDevice: true,
        plateHoldTicks: holdTicks,
        properties: { powered: false },
        placementRule: "default_state",
        supportRule: "floor_opaque",
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 0.5,
        onEntityStep: ({ blockId, state, setState, scheduleTick }) => {
            if (!getBlockStateProp(blockId, state, "powered")) {
                setState(setBlockStateProp(blockId, state, "powered", true));
                scheduleTick(holdTicks, "redstone_device", -1, 0);
            }
        },
        ...options
    };
}

defineBlocks({
    REDSTONE_WIRE: {
        name: "redstone_wire",
        redstoneRole: "wire",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        properties: { power: { min: 0, max: 15, default: 0 } },
        previewState: 15,
        itemIcon: "textures/items/redstone_dust.png",
        previewTexture: "textures/blocks/redstone_dust_dot.png",
        placementRule: "default_state",
        supportRule: "floor_redstone_wire",
        shapeMode: "connect_wire",
        geometryType: "wire",
        alphaCutout: true,
        textures: {
            top: "textures/blocks/redstone_dust_dot.png",
            side: "textures/blocks/redstone_dust_line0.png"
        },
        resolveStateVisual: (meta) => {
            const p = meta & 15;
            if (p === 0) return { defaultColor: 0x4d0000, isLightSource: false };
            const f = p / 15;
            const r = Math.round((0.40 + 0.60 * f) * 255);
            const g = Math.round(Math.max(0, f * f * 0.70 - 0.50) * 255);
            const b = Math.round(Math.max(0, f * f * 0.60 - 0.70) * 255);
            return { defaultColor: (r << 16) | (g << 8) | b, isLightSource: false };
        },
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        hardness: 0.0,
        selectionSize: { x: 1, y: 0.0625, z: 1 },
        selectionOffset: { x: 0.5, y: 0.03125, z: 0.5 }
    },

    REDSTONE_BLOCK: {
        name: "redstone_block",
        redstoneRole: "block",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        redstonePowerOutput: 15,
        textures: { all: "textures/blocks/redstone_block.png" },
        geometryType: "cube",
        hardness: 5.0
    },

    REDSTONE_LAMP: {
        name: "redstone_lamp",
        redstoneRole: "lamp",
        redstoneConductive: true,
        redstoneConnectsWire: false,
        redstoneDevice: true,
        properties: { lit: false },
        geometryType: "cube",
        textures: { all: "textures/blocks/redstone_lamp_off.png" },
        stateVariants: {
            "lit=false": {
                textures: { all: "textures/blocks/redstone_lamp_off.png" },
                lightLevel: 0,
                isLightSource: false
            },
            "lit=true": {
                textures: { all: "textures/blocks/redstone_lamp_on.png" },
                lightLevel: 15,
                isLightSource: true
            }
        },
        hardness: 0.3
    },

    LEVER: {
        name: "lever",
        redstoneRole: "lever",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        properties: {
            mount: ['floor', 'east', 'west', 'south', 'north'],
            powered: false
        },
        interactCycle: "powered",
        placementRule: "mount_floor_or_wall",
        supportRule: "mount_opaque",
        shapeMode: "raw",
        selectionPreset: "lever",
        geometryType: "lever",
        alphaCutout: true,
        textures: {
            side: "textures/blocks/cobblestone.png",
            top: "textures/blocks/lever.png"
        },
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 0.5,
        selectionSize: { x: 0.5, y: 0.5, z: 0.5 },
        selectionOffset: { x: 0.5, y: 0.25, z: 0.5 }
    },

    REDSTONE_TORCH: {
        name: "redstone_torch",
        redstoneRole: "torch",
        redstoneConductive: false,
        redstoneConnectsWire: "all",
        redstoneDevice: true,
        properties: {
            mount: ['floor', 'east', 'west', 'south', 'north'],
            lit: true
        },
        previewState: { mount: 'floor', lit: true },
        placementRule: "mount_floor_or_wall",
        supportRule: "mount_opaque",
        shapeMode: "propRaw:mount",
        selectionPreset: "torch",
        geometryType: "redstone_torch",
        alphaCutout: true,
        textures: { all: "textures/blocks/redstone_torch_on.png" },
        stateVariants: {
            "lit=false": {
                textures: { all: "textures/blocks/redstone_torch_off.png" },
                lightLevel: 0,
                isLightSource: false
            },
            "lit=true": {
                textures: { all: "textures/blocks/redstone_torch_on.png" },
                lightLevel: 7,
                isLightSource: true
            }
        },
        collision: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        previewType: "2D",
        hardness: 0.0,
        selectionSize: { x: 0.25, y: 0.625, z: 0.25 },
        selectionOffset: { x: 0.5, y: 0.3125, z: 0.5 }
    },

    REDSTONE_REPEATER: {
        name: "redstone_repeater",
        redstoneRole: "repeater",
        redstoneConductive: false,
        redstoneConnectsWire: "axis",
        redstoneDevice: true,
        repeaterPowered: false,
        properties: {
            facing: ['east', 'north', 'west', 'south'],
            delay: [2, 4, 6, 8],
            locked: false
        },
        interactCycle: "delay",
        placementRule: "facing_horizontal",
        supportRule: "floor_opaque",
        shapeMode: "raw",
        geometryType: "repeater",
        alphaCutout: true,
        textures: {
            top: "textures/blocks/repeater_off.png",
            side: "textures/blocks/stone_slab_side.png",
            bottom: "textures/blocks/stone_slab_top.png",
            south: "textures/blocks/redstone_torch_off.png",
            north: "textures/blocks/bedrock.png"
        },
        collision: true,
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("repeater"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 0.0,
        selectionSize: { x: 1, y: 0.125, z: 1 },
        selectionOffset: { x: 0.5, y: 0.0625, z: 0.5 }
    },

    REDSTONE_REPEATER_ON: {
        name: "redstone_repeater_on",
        itemdisplay: false,
        redstoneRole: "repeater",
        redstoneConductive: false,
        redstoneConnectsWire: "axis",
        redstoneDevice: true,
        repeaterPowered: true,
        properties: {
            facing: ['east', 'north', 'west', 'south'],
            delay: [2, 4, 6, 8],
            locked: false
        },
        interactCycle: "delay",
        placementRule: "facing_horizontal",
        supportRule: "floor_opaque",
        shapeMode: "raw",
        geometryType: "repeater",
        alphaCutout: true,
        textures: {
            top: "textures/blocks/repeater_on.png",
            side: "textures/blocks/stone_slab_side.png",
            bottom: "textures/blocks/stone_slab_top.png",
            south: "textures/blocks/redstone_torch_on.png",
            north: "textures/blocks/bedrock.png"
        },
        lightLevel: 7,
        collision: true,
        transparent: true,
        lightOpacity: 0,
        customCollision: () => getCustomCollision("repeater"),
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 0.0,
        selectionSize: { x: 1, y: 0.125, z: 1 },
        selectionOffset: { x: 0.5, y: 0.0625, z: 0.5 }
    },

    STONE_BUTTON: buttonBlock("stone_button", 20),
    OAK_BUTTON: buttonBlock("oak_button", 30),
    STONE_PRESSURE_PLATE: pressurePlateBlock("stone_pressure_plate", 20),
    OAK_PRESSURE_PLATE: pressurePlateBlock("oak_pressure_plate", 20)
});