"use strict";
import {
    MOUNT_SUPPORT_DX, MOUNT_SUPPORT_DY, MOUNT_SUPPORT_DZ,
    STATE_SCHEMAS, getSchemaDefaultState,
    resolveStateSchema, computeTransformMask, normalizeStateValue, compileAndRegisterBlockState,
    cycleBlockStateProp
} from '../blockstate.js';
import { createBox, getSelectionBoxesForConfig } from './collision.js';

/* ======================================================
   【ブロック登録レジストリ＆配置・支持ルール】(blocks/registry.js)
   - BLOCK_CONFIG / BLOCK_TYPES / ID_TO_KEY を一元管理
   - blocks/definitions/*.js から defineBlock() / defineBlocks() で登録する
   ====================================================== */

export const BLOCK_CONFIG = {};
export const BLOCK_TYPES = {};
const ID_TO_KEY = {};
export const blockConfigLookup = {};
const _blockRegisterListeners = [];

export function onBlockRegistered(listener) {
    if (typeof listener === "function") _blockRegisterListeners.push(listener);
}

export function idToKey(id) {
    return ID_TO_KEY[id] || "SKY";
}

export function keyToId(key) {
    return BLOCK_TYPES[key] ?? 0;
}

export function getBlockConfiguration(blockID) {
    return blockConfigLookup[blockID] || null;
}

export function usesConnectionMeta(blockId) {
    const cfg = blockConfigLookup[blockId & 0xFFF];
    return !!(cfg && cfg.autoSyncConnection === true);
}

export function isRedstoneComponent(blockId) {
    const cfg = blockConfigLookup[blockId & 0xFFF];
    return !!(cfg && cfg.redstoneConnectsWire !== false);
}

export function getSelectionBoxesReadOnly(blockId, meta = 0) {
    return getSelectionBoxesForConfig(blockConfigLookup[blockId], meta);
}

// --- データ駆動・配置メタ計算ストラテジーレジストリ ---
const LADDER_SUPPORT_DX = [0, -1, 0, 1];
const LADDER_SUPPORT_DZ = [-1, 0, 1, 0];

function _calcUpperHalfBit(rawNormal, intersectPoint) {
    if (rawNormal.y < -0.5) return 1;
    if (Math.abs(rawNormal.y) < 0.5) {
        let fractionY = intersectPoint.y - Math.floor(intersectPoint.y);
        if (fractionY < 0) fractionY += 1;
        if (fractionY > 0.49999) return 1;
    }
    return 0;
}

const PLACEMENT_STRATEGIES = {
    default_state: (cfg) => (cfg.defaultState ?? 0) & (cfg.stateMask ?? 0xFFF),
    wall_ladder: (cfg, camDir, rawNormal) => {
        if (Math.abs(rawNormal.y) > 0.5) return -1;
        if (rawNormal.z > 0.5) return 0;
        if (rawNormal.z < -0.5) return 2;
        if (rawNormal.x > 0.5) return 1;
        if (rawNormal.x < -0.5) return 3;
        return -1;
    },
    mount_floor_or_wall: (cfg, camDir, rawNormal) => {
        if (rawNormal.y < -0.5) return -1;
        const baseFlags = (cfg.defaultState ?? 0) & 8;
        if (rawNormal.y > 0.5) return baseFlags | 0; // floor
        if (rawNormal.x > 0.5) return baseFlags | 1; // east
        if (rawNormal.x < -0.5) return baseFlags | 2; // west
        if (rawNormal.z > 0.5) return baseFlags | 3; // south
        if (rawNormal.z < -0.5) return baseFlags | 4; // north
        return baseFlags | 0;
    },
    axis_log: (cfg, camDir, rawNormal) => {
        const ax = Math.abs(rawNormal.x);
        const ay = Math.abs(rawNormal.y);
        const az = Math.abs(rawNormal.z);
        if (ax > ay && ax > az) return 1;
        if (az > ay && az > ax) return 2;
        return 0;
    },
    facing_horizontal: (cfg, camDir) => {
        const base = (cfg.defaultState ?? 0) & ~3;
        if (Math.abs(camDir.x) > Math.abs(camDir.z)) {
            return base | (camDir.x > 0 ? 0 : 2);
        }
        return base | (camDir.z < 0 ? 1 : 3);
    },
    half_slab: (cfg, camDir, rawNormal, intersectPoint) => {
        return (_calcUpperHalfBit(rawNormal, intersectPoint) << 2);
    },
    directional_half: (cfg, camDir, rawNormal, intersectPoint) => {
        const lookX = -camDir.x;
        const lookZ = -camDir.z;
        let direction = 0;
        if (Math.abs(lookX) > Math.abs(lookZ)) {
            direction = (lookX > 0) ? 2 : 0;
        } else {
            direction = (lookZ > 0) ? 1 : 3;
        }
        return direction | (_calcUpperHalfBit(rawNormal, intersectPoint) << 2);
    }
};

export function registerPlacementRule(name, fn) {
    if (name && typeof fn === "function") PLACEMENT_STRATEGIES[name] = fn;
}

export function calculatePlacementMeta(blockId, camDir, rawNormal, intersectPoint) {
    const cfg = blockConfigLookup[blockId & 0xFFF];
    if (!cfg) return 0;

    if (typeof cfg.calculatePlacementMeta === "function") {
        return cfg.calculatePlacementMeta(cfg, camDir, rawNormal, intersectPoint);
    }
    const strategy = PLACEMENT_STRATEGIES[cfg.placementRule] || PLACEMENT_STRATEGIES.default_state;
    return strategy(cfg, camDir, rawNormal, intersectPoint);
}

// --- データ駆動・支持条件バリデータレジストリ ---
const SUPPORT_VALIDATORS = {
    none: () => true,
    wall_opaque: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        const dir = meta & 3;
        if (meta < 0 || dir > 3) return false;
        const supportId = getBlockIdFn(wx + LADDER_SUPPORT_DX[dir], wy, wz + LADDER_SUPPORT_DZ[dir]) & 0xFFF;
        const supportCfg = blockConfigLookup[supportId];
        return !!(supportCfg && supportCfg.isOpaqueCube === true);
    },
    mount_opaque: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        const mount = meta & 7;
        if (meta < 0 || mount > 4) return false;
        const sy = wy + MOUNT_SUPPORT_DY[mount];
        if (sy < 0 || sy >= 256) return false;
        const supportId = getBlockIdFn(wx + MOUNT_SUPPORT_DX[mount], sy, wz + MOUNT_SUPPORT_DZ[mount]) & 0xFFF;
        const supportCfg = blockConfigLookup[supportId];
        return !!(supportCfg && supportCfg.isOpaqueCube === true);
    },
    floor_opaque: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        if (wy <= 0) return false;
        const belowCfg = blockConfigLookup[getBlockIdFn(wx, wy - 1, wz) & 0xFFF];
        return !!(belowCfg && belowCfg.isOpaqueCube === true);
    },
    floor_non_liquid: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        if (wy <= 0) return false;
        const belowId = getBlockIdFn(wx, wy - 1, wz) & 0xFFF;
        if (belowId === BLOCK_TYPES.SKY) return false;
        const belowCfg = blockConfigLookup[belowId];
        return !!(belowCfg && belowCfg.geometryType !== "water");
    },
    soil_grass: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        if (wy <= 0) return false;
        const belowId = getBlockIdFn(wx, wy - 1, wz) & 0xFFF;
        return belowId === BLOCK_TYPES.GRASS || belowId === BLOCK_TYPES.DIRT;
    },
    soil_desert: (cfg, meta, wx, wy, wz, getBlockIdFn) => {
        if (wy <= 0) return false;
        const belowId = getBlockIdFn(wx, wy - 1, wz) & 0xFFF;
        return belowId === BLOCK_TYPES.SAND || belowId === BLOCK_TYPES.DIRT;
    }
};

export function registerSupportRule(name, fn) {
    if (name && typeof fn === "function") SUPPORT_VALIDATORS[name] = fn;
}

export function isSupportDependentBlock(blockId) {
    const cfg = blockConfigLookup[blockId & 0xFFF];
    if (!cfg) return false;
    return !!(cfg.supportRule && cfg.supportRule !== "none") || typeof cfg.canSurvive === "function";
}

export function canPlaceBlockAt(blockId, meta, wx, wy, wz, getBlockIdFn) {
    if (wy < 0 || wy >= 256) return false;
    const cfg = blockConfigLookup[blockId & 0xFFF];
    if (!cfg || blockId === BLOCK_TYPES.SKY) return false;

    if (typeof cfg.canSurvive === "function") {
        return !!cfg.canSurvive(cfg, meta, wx, wy, wz, getBlockIdFn);
    }
    const validator = SUPPORT_VALIDATORS[cfg.supportRule || "none"];
    return validator ? validator(cfg, meta, wx, wy, wz, getBlockIdFn) : true;
}

// ── 共通デフォルト設定 ──
const defaultBlockConfig = {
    isOpaqueCube: true,
    itemdisplay: true,
    collision: true,
    geometryType: "cube",
    transparent: false,
    targetblock: true,
    screenFill: true,
    textures: {},
    customCollision: null,
    hardness: 1.0,
    Gamma: 1.0,
    lightLevel: 0,
    lightOpacity: 1,
    drop: null,
    cullAdjacentFaces: true,
    overwrite: false,
    previewType: "3D",
    previewOptions: { rotation: { x: 0, y: 0, z: 0 }, scale: 2.2 },
    fallbackTexture: "textures/blocks/missing_texture.png",
    defaultColor: 0xffffff,
    selectionSize: { x: 1, y: 1, z: 1 },
    selectionOffset: { x: 0.5, y: 0.5, z: 0.5 },

    properties: null,
    interactCycle: null,
    blockstateFile: null,
    modelFile: null,
    autoModelCollision: true,
    stateSchema: STATE_SCHEMAS.NONE,
    defaultState: null,
    previewState: null,
    previewTexture: null,
    selectionPreset: null,
    alphaCutout: null,
    stateVariants: null,
    resolveStateVisual: null,
    transformMask: null,
    placementRule: null,
    supportRule: null,
    shapeMode: null,
    autoSyncConnection: false,
    hasStateMaterials: false,

    redstoneConductive: null,
    redstoneConnectsWire: false,
    redstonePowerOutput: 0,
    redstoneDevice: false,
    redstoneRole: "none",

    onPlace: null,
    onNeighborChange: null,
    onRandomTick: null,
    onRedstoneUpdate: null,
    onEntityStep: null,
    blockEntityType: null
};

let nextId = 0;

function compileBlockConfig(config) {
    const id = (config.id !== undefined) ? config.id : nextId++;
    if (id >= nextId) nextId = id + 1;

    const gType = config.geometryType ?? "cube";
    const isTransparent = config.transparent === true;
    const isFullCube = (gType === "cube") || config.isLog === true;
    const isSky = (id === 0 && config.geometryType === "none");
    const isOpaqueCube = (!isSky && !isTransparent && isFullCube);

    const stateSchema = resolveStateSchema(config);
    const transformMask = computeTransformMask(stateSchema, config.transformMask);
    const schemaDefault = getSchemaDefaultState(stateSchema);
    const defaultState = normalizeStateValue(stateSchema, config.defaultState, schemaDefault);
    const previewState = (config.previewState !== undefined && config.previewState !== null)
        ? normalizeStateValue(stateSchema, config.previewState, defaultState)
        : null;

    let onInteract = config.onInteract ?? null;
    if (!onInteract && typeof config.interactCycle === "string") {
        const cycleProp = config.interactCycle;
        onInteract = ({ blockId, state }) => cycleBlockStateProp(blockId, state, cycleProp);
    }

    let placementRule = config.placementRule;
    if (!placementRule) {
        if (config.isLadder) placementRule = "wall_ladder";
        else if (config.isLog) placementRule = "axis_log";
        else if (config.directional) placementRule = "directional_half";
        else if (config.isSlab) placementRule = "half_slab";
        else placementRule = "default_state";
    }

    let supportRule = config.supportRule;
    if (!supportRule) {
        if (config.isLadder) supportRule = "wall_opaque";
        else if (gType === "carpet") supportRule = "floor_non_liquid";
        else if (gType === "cross") {
            if (config.name === "mushroom_red" || config.name === "mushroom_brown") supportRule = "floor_opaque";
            else if (config.name === "deadbush") supportRule = "soil_desert";
            else supportRule = "soil_grass";
        } else {
            supportRule = "none";
        }
    }

    let shapeMode = config.shapeMode;
    if (!shapeMode) {
        if (gType === "fence") shapeMode = "connect_fence";
        else if (gType === "pane") shapeMode = "connect_pane";
        else if (gType === "wire") shapeMode = "connect_wire";
        else if (gType === "water") shapeMode = "liquid";
        else shapeMode = "static";
    }

    const autoSyncConnection = config.autoSyncConnection ?? (shapeMode === "connect_fence" || shapeMode === "connect_pane");
    const hasStateMaterials = config.hasStateMaterials ?? !!(config.stateVariants || config.resolveStateVisual);
    const redstoneConductive = (config.redstoneConductive !== undefined && config.redstoneConductive !== null)
        ? !!config.redstoneConductive
        : isOpaqueCube;

    const cfg = {
        ...defaultBlockConfig,
        ...config,
        id,
        isOpaqueCube,
        stateSchema,
        transformMask,
        defaultState,
        previewState,
        onInteract,
        placementRule,
        supportRule,
        shapeMode,
        autoSyncConnection,
        hasStateMaterials,
        redstoneConductive
    };

    compileAndRegisterBlockState(cfg);

    if (cfg.selectionSize && gType !== "cube" && gType !== "stairs" && gType !== "fence" && gType !== "pane") {
        const s = cfg.selectionSize;
        const o = cfg.selectionOffset || { x: 0.5, y: 0.5, z: 0.5 };
        cfg._selectionBoxes = Object.freeze([
            createBox(
                o.x - s.x * 0.5, o.y - s.y * 0.5, o.z - s.z * 0.5,
                o.x + s.x * 0.5, o.y + s.y * 0.5, o.z + s.z * 0.5
            )
        ]);
    }

    blockConfigLookup[id] = cfg;
    return cfg;
}

export function defineBlock(key, config, notify = false) {
    if (!key || BLOCK_CONFIG[key]) return BLOCK_CONFIG[key] || null;
    const cfg = compileBlockConfig(config);
    BLOCK_CONFIG[key] = cfg;
    BLOCK_TYPES[key] = cfg.id;
    ID_TO_KEY[cfg.id] = key;
    if (notify) {
        for (let i = 0; i < _blockRegisterListeners.length; i++) {
            _blockRegisterListeners[i](key, cfg);
        }
    }
    return cfg;
}

export function defineBlocks(defs) {
    const keys = Object.keys(defs);
    for (let i = 0; i < keys.length; i++) {
        defineBlock(keys[i], defs[keys[i]], false);
    }
}

export function registerCustomBlock(key, config) {
    return defineBlock(key, config, true);
}