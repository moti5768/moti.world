"use strict";
import { defineBlocks, idToKey } from '../registry.js';

// facing 4方向（プレイヤー側を正面に向ける: placementRule="facing_horizontal" 準拠）
const FACING_VALUES = ['west', 'south', 'east', 'north'];

function buildDirectionalFaceVariants(frontOffTex, sideTex, topTex, bottomTex, frontOnTex = null, litLight = 0) {
    const variants = {};
    for (let i = 0; i < FACING_VALUES.length; i++) {
        const f = FACING_VALUES[i];
        const baseTex = { top: topTex, bottom: bottomTex, side: sideTex, [f]: frontOffTex };
        if (frontOnTex) {
            variants[`facing=${f},lit=false`] = { textures: baseTex, lightLevel: 0, isLightSource: false };
            variants[`facing=${f},lit=true`] = {
                textures: { top: topTex, bottom: bottomTex, side: sideTex, [f]: frontOnTex },
                lightLevel: litLight,
                isLightSource: litLight > 0
            };
        } else {
            variants[`facing=${f}`] = { textures: baseTex };
        }
    }
    return variants;
}

defineBlocks({
    CHEST: {
        name: "chest",
        blockEntityType: "minecraft:chest",
        properties: { facing: FACING_VALUES },
        placementRule: "facing_horizontal",
        shapeMode: "static",
        geometryType: "chest",
        selectionPreset: "chest",
        redstoneConductive: false,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        fallbackTexture: "textures/entity/chest/normal.png",
        textures: {
            all: "textures/entity/chest/normal.png"
        },
        previewOptions: { rotation: { x: 0, y: 90, z: 0 }, scale: 2.3 },
        hardness: 2.5,
        onInteract: ({ blockEntity, openContainer }) => {
            if (blockEntity && typeof openContainer === "function") {
                openContainer(blockEntity);
            }
            return "consumed";
        }
    },

    FURNACE: {
        name: "furnace",
        blockEntityType: "minecraft:furnace",
        properties: {
            facing: FACING_VALUES,
            lit: false
        },
        previewState: { facing: 'south', lit: false },
        placementRule: "facing_horizontal",
        fallbackTexture: "textures/blocks/furnace_side.png",
        textures: {
            top: "textures/blocks/furnace_top.png",
            bottom: "textures/blocks/furnace_top.png",
            side: "textures/blocks/furnace_side.png"
        },
        stateVariants: buildDirectionalFaceVariants(
            "textures/blocks/furnace_front_off.png",
            "textures/blocks/furnace_side.png",
            "textures/blocks/furnace_top.png",
            "textures/blocks/furnace_top.png",
            "textures/blocks/furnace_front_on.png",
            13
        ),
        hardness: 3.5,
        onInteract: ({ blockEntity, openContainer }) => {
            if (blockEntity && typeof openContainer === "function") {
                openContainer(blockEntity);
            }
            return "consumed";
        }
    }
});