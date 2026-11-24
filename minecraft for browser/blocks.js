"use strict";
import * as THREE from "./build/three.module.js";
import {
    MOUNT_SUPPORT_DX, MOUNT_SUPPORT_DY, MOUNT_SUPPORT_DZ,
    STATE_SCHEMAS, registerStateSchema, buildStateSchemaFromProperties, getSchemaDefaultState,
    getBlockStateRawProp, getBlockStateProp, setBlockStateProp, cycleBlockStateProp,
    hasBlockStateProp, packBlockState, unpackBlockState, formatBlockStateString,
    getTransformMeta, getBlockLightEmissionForState, getCompiledStateVariant,
    getRawBlockId, getRawLocalState, packRawBlock, getBlockStateCount, getGlobalStatePaletteStats
} from './blockstate.js';
import {
    createBox, registerCollisionPreset, registerSelectionPreset,
    getCustomCollision, getFenceCollisionBoxes, getPaneCollisionBoxes,
    getCollisionBoxesReadOnly, getCollisionBoxes,
    applyRotationToCollisionBox, getCustomGeometryMatrix,
    getLogRotationMatrixReadOnly, getLogRotationMatrix,
    applyMetadataTransformForConfig
} from './blocks/collision.js';
import {
    SHARED_SKY_UNIFORM, SHARED_BRIGHTNESS_UNIFORM,
    cachedLoadTexture, getOrCreateSharedBlockMaterial,
    createMaterialsFromBlockConfig, getBlockMaterialsForConfig, getBlockMaterialsForStateConfig,
    invalidateBlockMaterialCache
} from './blocks/materials.js';
import {
    mergeGeometriesPreservingGroups,
    registerGeometryBuilder, getBlockGeometry, clearBlockGeometryCache
} from './blocks/models/geometry_builders.js';
import {
    loadAllJavaBlockAssets, applyJavaAssetsToBlockConfig, resolveJavaTexturePath
} from './blocks/models/model_compiler.js';
import {
    BLOCK_CONFIG, BLOCK_TYPES, blockConfigLookup,
    onBlockRegistered, idToKey, keyToId, getBlockConfiguration,
    usesConnectionMeta, isRedstoneComponent, getSelectionBoxesReadOnly,
    registerPlacementRule, calculatePlacementMeta,
    registerSupportRule, isSupportDependentBlock, canPlaceBlockAt,
    defineBlock, defineBlocks, registerCustomBlock
} from './blocks/registry.js';

// 全カテゴリ定義をロード（SKY=0 を先頭にして全ブロックを自動登録）
import './blocks/definitions/index.js';

export {
    MOUNT_SUPPORT_DX, MOUNT_SUPPORT_DY, MOUNT_SUPPORT_DZ,
    STATE_SCHEMAS, registerStateSchema, buildStateSchemaFromProperties, getSchemaDefaultState,
    getBlockStateRawProp, getBlockStateProp, setBlockStateProp, cycleBlockStateProp,
    hasBlockStateProp, packBlockState, unpackBlockState, formatBlockStateString,
    getTransformMeta, getBlockLightEmissionForState, getCompiledStateVariant,
    getRawBlockId, getRawLocalState, packRawBlock, getBlockStateCount, getGlobalStatePaletteStats,
    createBox, registerCollisionPreset, registerSelectionPreset,
    getCollisionBoxesReadOnly, getCollisionBoxes,
    applyRotationToCollisionBox, getCustomGeometryMatrix,
    getLogRotationMatrixReadOnly, getLogRotationMatrix,
    SHARED_SKY_UNIFORM, SHARED_BRIGHTNESS_UNIFORM,
    cachedLoadTexture, getOrCreateSharedBlockMaterial,
    createMaterialsFromBlockConfig, invalidateBlockMaterialCache,
    mergeGeometriesPreservingGroups,
    registerGeometryBuilder, getBlockGeometry, clearBlockGeometryCache,
    applyJavaAssetsToBlockConfig, resolveJavaTexturePath,
    BLOCK_CONFIG, BLOCK_TYPES,
    onBlockRegistered, idToKey, keyToId, getBlockConfiguration,
    usesConnectionMeta, isRedstoneComponent, getSelectionBoxesReadOnly,
    registerPlacementRule, calculatePlacementMeta,
    registerSupportRule, isSupportDependentBlock, canPlaceBlockAt,
    defineBlock, defineBlocks, registerCustomBlock
};

export function getBlockMaterials(blockType) {
    const bId = (typeof blockType === "string") ? keyToId(blockType) : (Number(blockType) & 0xFFF);
    return getBlockMaterialsForConfig(blockConfigLookup[bId]);
}

export function getBlockMaterialsForState(blockId, meta = 0) {
    return getBlockMaterialsForStateConfig(blockConfigLookup[blockId & 0xFFF], meta);
}

export function applyMetadataTransform(target, metadata, blockId) {
    if (metadata === undefined || metadata === null) return;
    const cfg = getBlockConfiguration(blockId);
    if (!cfg) return;
    applyMetadataTransformForConfig(target, metadata, cfg, getTransformMeta(blockId, metadata));
}

export function createBlockMesh(rawBlockType, pos, metadata = 0) {
    const raw = Number(rawBlockType);
    const blockId = getRawBlockId(raw);
    const finalMetadata = metadata !== 0 ? metadata : getRawLocalState(raw);

    const config = getBlockConfiguration(blockId);
    if (!config) return null;

    const materials = getBlockMaterialsForState(blockId, finalMetadata);
    const geometry = getBlockGeometry(config.geometryType, config, finalMetadata);
    if (!materials || !geometry) return null;

    const mesh = new THREE.Mesh(geometry, materials);
    mesh.position.copy(pos);
    applyMetadataTransform(mesh, finalMetadata, blockId);

    let boxes = null;
    if (config.geometryType === "fence") {
        boxes = getFenceCollisionBoxes(finalMetadata);
    } else if (typeof config.customCollision === "function") {
        boxes = config.customCollision();
    } else if (config.collision) {
        boxes = getCustomCollision(config.geometryType || "cube");
    }

    if (boxes && boxes.length > 0) {
        for (let i = 0, len = boxes.length; i < len; i++) {
            const box = boxes[i];
            applyMetadataTransform(box, finalMetadata, blockId);
            box.translate(pos);
        }
        mesh.userData.collisionBoxes = boxes;
    } else {
        mesh.userData.collisionBoxes = [];
    }

    mesh.updateMatrixWorld();
    return mesh;
}

export async function loadBlockAssets(assetRoot = 'assets/minecraft') {
    return loadAllJavaBlockAssets(BLOCK_CONFIG, assetRoot);
}