"use strict";
import {
    getBlockStateProp, setBlockStateProp,
    getRawBlockId, getRawLocalState, packRawBlock
} from '../../blockstate.js';
import { BLOCK_TYPES, defineBlocks, getBlockConfiguration, registerPlacementRule } from '../registry.js';

// blockstates 配下のサブフォルダ設定（フォルダ構成を変えたらここ1行だけで全ドア・トラップドアへ反映）
const DOOR_BLOCKSTATE_FOLDER = "doors";
const TRAPDOOR_BLOCKSTATE_FOLDER = "trapdoors";

// トラップドア専用の配置ルール（Java Edition TrapDoorBlock.getStateForPlacement 準拠）
// facing: 0=north, 1=east, 2=south, 3=west / half: 0=bottom, 1=top (bit2) / open: 0 (bit3)
registerPlacementRule("trapdoor", (cfg, camDir, rawNormal, intersectPoint) => {
    let facingIdx = 0;
    let halfBit = 0;

    if (Math.abs(rawNormal.y) > 0.5) {
        // 床/天井クリック: プレイヤー視線の反対方向が正面
        if (Math.abs(camDir.x) > Math.abs(camDir.z)) {
            facingIdx = camDir.x > 0 ? 3 : 1; // 東向き->west(3), 西向き->east(1)
        } else {
            facingIdx = camDir.z > 0 ? 0 : 2; // 南向き->north(0), 北向き->south(2)
        }
        halfBit = rawNormal.y < -0.5 ? 1 : 0; // 天井裏クリックなら上付き
    } else {
        // 壁面クリック: クリックした壁にヒンジを合わせる
        if (rawNormal.z < -0.5) facingIdx = 0;      // north
        else if (rawNormal.x > 0.5) facingIdx = 1;  // east
        else if (rawNormal.z > 0.5) facingIdx = 2;  // south
        else if (rawNormal.x < -0.5) facingIdx = 3; // west

        let fracY = intersectPoint.y - Math.floor(intersectPoint.y);
        if (fracY < 0) fracY += 1;
        halfBit = fracY > 0.5 ? 1 : 0;
    }

    return (facingIdx & 3) | ((halfBit & 1) << 2);
});

// トラップドア1行量産ヘルパー（Java Edition TrapDoorBlock 準拠：powered を BlockState 永続化）
function trapdoorBlock(name, fallbackTexture = "textures/blocks/planks_oak.png", { hardness = 3.0, canHandOpen = true, ...options } = {}) {
    return {
        name,
        blockstateFolder: TRAPDOOR_BLOCKSTATE_FOLDER,
        blockstateFile: name,
        fallbackTexture,
        redstoneRole: "trapdoor",
        redstoneConductive: false,
        redstoneConnectsWire: false,
        redstoneDevice: true,
        properties: {
            facing: ['north', 'east', 'south', 'west'],
            half: ['bottom', 'top'],
            open: false,
            powered: false
        },
        interactCycle: canHandOpen ? "open" : null,
        placementRule: "trapdoor",
        collision: true,
        transparent: true,
        alphaCutout: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness,
        onRedstoneUpdate: ({ x, y, z, id, meta, power, setBlock }) => {
            const isPowered = power > 0;
            const wasPowered = getBlockStateProp(id, meta, "powered");
            if (isPowered === wasPowered) return;

            let nextMeta = setBlockStateProp(id, meta, "powered", isPowered);
            if (getBlockStateProp(id, nextMeta, "open") !== isPowered) {
                nextMeta = setBlockStateProp(id, nextMeta, "open", isPowered);
            }
            setBlock(x, y, z, packRawBlock(id, nextMeta));
        },
        ...options
    };
}

defineBlocks({
    OAK_TRAPDOOR: trapdoorBlock("oak_trapdoor", "textures/blocks/planks_oak.png")
});

// ======================================================
// ドア配置ルール＆両開きヒンジ自動判定 (Java Edition DoorBlock.java 準拠)
// facing: 0=north, 1=east, 2=south, 3=west / half: 0=lower, 1=upper
// hinge: 0=left, 1=right / open: false|true / powered: false|true
// ======================================================
const DOOR_FACINGS = ['north', 'east', 'south', 'west'];
const DOOR_LEFT_DX = [-1, 0, 1, 0]; // north->W, east->N, south->E, west->S
const DOOR_LEFT_DZ = [0, -1, 0, 1];
const DOOR_RIGHT_DX = [1, 0, -1, 0]; // north->E, east->S, south->W, west->N
const DOOR_RIGHT_DZ = [0, 1, 0, -1];

registerPlacementRule("door", (cfg, camDir, rawNormal, intersectPoint) => {
    let facingIdx = 0;
    if (Math.abs(camDir.x) > Math.abs(camDir.z)) {
        facingIdx = camDir.x > 0 ? 1 : 3; // east(1) or west(3)
    } else {
        facingIdx = camDir.z > 0 ? 2 : 0; // south(2) or north(0)
    }

    let fx = intersectPoint.x - Math.floor(intersectPoint.x);
    let fz = intersectPoint.z - Math.floor(intersectPoint.z);
    if (fx < 0) fx += 1;
    if (fz < 0) fz += 1;

    // 視線方向に対して右半分をクリックしていれば hinge=right、左半分なら hinge=left
    let isRightSide = false;
    if (facingIdx === 0) isRightSide = fx > 0.5;      // north: 東(+X)が右
    else if (facingIdx === 1) isRightSide = fz > 0.5; // east:  南(+Z)が右
    else if (facingIdx === 2) isRightSide = fx < 0.5; // south: 西(-X)が右
    else isRightSide = fz < 0.5;                      // west:  北(-Z)が右

    let meta = 0;
    meta = setBlockStateProp(cfg.id, meta, "facing", DOOR_FACINGS[facingIdx]);
    meta = setBlockStateProp(cfg.id, meta, "half", "lower");
    meta = setBlockStateProp(cfg.id, meta, "hinge", isRightSide ? "right" : "left");
    meta = setBlockStateProp(cfg.id, meta, "open", false);
    meta = setBlockStateProp(cfg.id, meta, "powered", false);
    return meta;
});

function isReplaceableForDoorUpper(blockId) {
    if (blockId === BLOCK_TYPES.SKY) return true;
    const cfg = getBlockConfiguration(blockId);
    return !!(cfg && (cfg.overwrite === true || cfg.geometryType === "water"));
}

// ドア1行量産ヘルパー（今後 iron_door 等は canHandOpen: false を渡すだけで追加可能）
function doorBlock(name, fallbackTexture, { hardness = 3.0, canHandOpen = true, itemIcon = null, ...options } = {}) {
    return {
        name,
        blockstateFolder: DOOR_BLOCKSTATE_FOLDER,
        blockstateFile: name,
        fallbackTexture,
        itemIcon,
        redstoneRole: "door",
        redstoneConductive: false,
        redstoneConnectsWire: false,
        redstoneDevice: true,
        properties: {
            facing: DOOR_FACINGS,
            half: ['lower', 'upper'],
            hinge: ['left', 'right'],
            open: false,
            powered: false
        },
        placementRule: "door",
        collision: true,
        transparent: true,
        alphaCutout: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness,

        // 設置時の両開き自動ヒンジ決定（Java Edition DoorBlock.getHinge 準拠）
        onPlace: ({ x, y, z, blockId, state, getBlockId, getRaw }) => {
            const facing = getBlockStateProp(blockId, state, "facing");
            const facingIdx = DOOR_FACINGS.indexOf(facing);
            if (facingIdx < 0) return state;

            const ldx = DOOR_LEFT_DX[facingIdx], ldz = DOOR_LEFT_DZ[facingIdx];
            const rdx = DOOR_RIGHT_DX[facingIdx], rdz = DOOR_RIGHT_DZ[facingIdx];

            const leftRaw = getRaw(x + ldx, y, z + ldz);
            const rightRaw = getRaw(x + rdx, y, z + rdz);
            const leftIsLowerDoor = (getRawBlockId(leftRaw) === blockId) &&
                (getBlockStateProp(blockId, getRawLocalState(leftRaw), "half") === "lower");
            const rightIsLowerDoor = (getRawBlockId(rightRaw) === blockId) &&
                (getBlockStateProp(blockId, getRawLocalState(rightRaw), "half") === "lower");

            let chosenHinge = getBlockStateProp(blockId, state, "hinge");

            if (leftIsLowerDoor && !rightIsLowerDoor) {
                chosenHinge = "right";
            } else if (rightIsLowerDoor && !leftIsLowerDoor) {
                chosenHinge = "left";
            } else {
                const isSolid = (wx, wy, wz) => {
                    const c = getBlockConfiguration(getBlockId(wx, wy, wz));
                    return !!(c && c.isOpaqueCube === true);
                };
                const score =
                    (isSolid(x + ldx, y, z + ldz) ? -1 : 0) +
                    (isSolid(x + ldx, y + 1, z + ldz) ? -1 : 0) +
                    (isSolid(x + rdx, y, z + rdz) ? 1 : 0) +
                    (isSolid(x + rdx, y + 1, z + rdz) ? 1 : 0);
                if (score < 0) chosenHinge = "left";
                else if (score > 0) chosenHinge = "right";
            }

            return setBlockStateProp(blockId, state, "hinge", chosenHinge);
        },

        // 下半分・上半分の存続チェック（設置前チェック＋破壊時の上下自動連鎖破壊を両立）
        canSurvive: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
            const half = getBlockStateProp(cfg.id, meta, "half");

            if (half === "upper") {
                if (wy <= 0) return false;
                return getBlockIdFn(wx, wy - 1, wz) === cfg.id;
            }

            // lower: 足元が不透明固体かつ上マスが確保できること
            if (wy <= 0 || wy >= 255) return false;
            const belowCfg = getBlockConfiguration(getBlockIdFn(wx, wy - 1, wz));
            if (!belowCfg || belowCfg.isOpaqueCube !== true) return false;

            const aboveId = getBlockIdFn(wx, wy + 1, wz);
            const selfIsAlreadyDoor = (getBlockIdFn(wx, wy, wz) === cfg.id);
            if (selfIsAlreadyDoor) {
                return aboveId === cfg.id;
            }
            return aboveId === cfg.id || isReplaceableForDoorUpper(aboveId);
        },

        // 下半分を置いた直後に上半分を自動配置
        onAfterPlace: ({ x, y, z, blockId, state, setBlock }) => {
            if (getBlockStateProp(blockId, state, "half") !== "lower") return;
            if (y + 1 >= 256) return;
            const upperState = setBlockStateProp(blockId, state, "half", "upper");
            setBlock(x, y + 1, z, packRawBlock(blockId, upperState), {
                notifyNC: false,
                notifyRedstone: false
            });
        },

        // 上下どちらの右クリックでもペア同時に開閉
        onInteract: canHandOpen
            ? ({ x, y, z, blockId, state, getRaw, setBlock }) => {
                const nextOpen = !getBlockStateProp(blockId, state, "open");
                const nextSelfState = setBlockStateProp(blockId, state, "open", nextOpen);

                const half = getBlockStateProp(blockId, state, "half");
                const otherY = (half === "lower") ? (y + 1) : (y - 1);
                const otherRaw = getRaw(x, otherY, z);
                if (otherRaw > 0 && getRawBlockId(otherRaw) === blockId) {
                    const otherMeta = getRawLocalState(otherRaw);
                    const nextOtherMeta = setBlockStateProp(blockId, otherMeta, "open", nextOpen);
                    setBlock(x, otherY, z, packRawBlock(blockId, nextOtherMeta), {
                        notifyNC: false,
                        notifyRedstone: false
                    });
                }
                return nextSelfState;
            }
            : null,

        // レッドストーン連動（Java Edition DoorBlock.neighborChanged 準拠：上下どちらの信号でも動作）
        onRedstoneUpdate: ({ x, y, z, id, meta, getRaw, setBlock, engine }) => {
            const half = getBlockStateProp(id, meta, "half");
            const lowerY = (half === "lower") ? y : (y - 1);
            const upperY = lowerY + 1;

            const lowerRaw = getRaw(x, lowerY, z);
            const upperRaw = getRaw(x, upperY, z);
            if (getRawBlockId(lowerRaw) !== id || getRawBlockId(upperRaw) !== id) return;

            const lowerMeta = getRawLocalState(lowerRaw);
            const upperMeta = getRawLocalState(upperRaw);

            const isPowered =
                engine.getTotalPowerAt(x, lowerY, z) > 0 ||
                engine.getTotalPowerAt(x, upperY, z) > 0;

            const wasPowered = getBlockStateProp(id, lowerMeta, "powered");
            if (isPowered === wasPowered) return;

            let nextLower = setBlockStateProp(id, lowerMeta, "powered", isPowered);
            nextLower = setBlockStateProp(id, nextLower, "open", isPowered);

            let nextUpper = setBlockStateProp(id, upperMeta, "powered", isPowered);
            nextUpper = setBlockStateProp(id, nextUpper, "open", isPowered);

            setBlock(x, lowerY, z, packRawBlock(id, nextLower));
            setBlock(x, upperY, z, packRawBlock(id, nextUpper));
        },
        ...options
    };
}

defineBlocks({
    OAK_DOOR: doorBlock("oak_door", "textures/blocks/planks_oak.png", {
        itemIcon: "textures/items/door_wood.png"
    })
});