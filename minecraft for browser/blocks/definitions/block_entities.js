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
        fallbackTexture: "textures/blocks/planks_oak.png",
        textures: {
            top: "textures/blocks/planks_oak.png",
            bottom: "textures/blocks/planks_oak.png",
            side: "textures/blocks/planks_oak.png"
        },
        stateVariants: buildDirectionalFaceVariants(
            "textures/blocks/chest_front.png",
            "textures/blocks/planks_oak.png",
            "textures/blocks/planks_oak.png",
            "textures/blocks/planks_oak.png"
        ),
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
        placementRule: "facing_horizontal",
        fallbackTexture: "textures/blocks/cobblestone.png",
        textures: {
            top: "textures/blocks/stone.png",
            bottom: "textures/blocks/stone.png",
            side: "textures/blocks/cobblestone.png"
        },
        stateVariants: buildDirectionalFaceVariants(
            "textures/blocks/furnace_front_off.png",
            "textures/blocks/cobblestone.png",
            "textures/blocks/stone.png",
            "textures/blocks/stone.png",
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