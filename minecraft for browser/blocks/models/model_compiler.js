"use strict";
import * as THREE from '../../build/three.module.js';
import {
    getBlockStateProp,
    compileAndRegisterBlockState
} from '../../blockstate.js';
import {
    createBox,
    registerCollisionPreset,
    registerSelectionPreset
} from '../collision.js';
import { invalidateBlockMaterialCache } from '../materials.js';
import { registerGeometryBuilder } from './geometry_builders.js';

/* ======================================================
   【Java Edition 準拠 JSON モデル＆BlockState コンパイラ】
   (blocks/models/model_compiler.js)
   - assets/minecraft/models/block/*.json (parent継承・#texture参照・0..16px elements・UV回転)
   - assets/minecraft/blockstates/*.json  (variants条件マッチ・x/y回転)
   - 方向(dir 0..5) x マテリアルIndex 単位で BufferGeometry.groups を自動構築し、
     script.js の getBakedCustomTemplate（面別シェーディング＆隣接ライト参照）へ完全適合
   ====================================================== */

const DEFAULT_ASSET_ROOT = 'assets/minecraft';

// Java Edition 面名 -> エンジン標準方向インデックス (0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z)
const FACE_NAMES = ['east', 'west', 'up', 'down', 'south', 'north'];

const _modelJsonCache = new Map();
const _blockstateJsonCache = new Map();
const _compiledVariantCache = new Map();

function stripNamespace(id) {
    if (typeof id !== 'string') return '';
    return id.startsWith('minecraft:') ? id.slice(10) : id;
}

/**
 * Java Edition 形式のテクスチャ参照 ("block/stone", "minecraft:block/stone", "textures/blocks/stone.png") を
 * 現行プロジェクトのテクスチャパス ("textures/blocks/stone.png") へ統一変換する
 */
export function resolveJavaTexturePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    if (rawPath.startsWith('#')) return rawPath;

    const clean = stripNamespace(rawPath.trim());
    if (clean.startsWith('textures/')) {
        return clean.endsWith('.png') ? clean : `${clean}.png`;
    }
    if (clean.startsWith('block/')) {
        const name = clean.slice(6);
        return `textures/blocks/${name.endsWith('.png') ? name : `${name}.png`}`;
    }
    if (clean.startsWith('blocks/')) {
        const name = clean.slice(7);
        return `textures/blocks/${name.endsWith('.png') ? name : `${name}.png`}`;
    }
    return `textures/blocks/${clean.endsWith('.png') ? clean : `${clean}.png`}`;
}

async function fetchJsonCached(url, cacheMap) {
    if (cacheMap.has(url)) return cacheMap.get(url);
    const promise = fetch(url).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
        return res.json();
    });
    cacheMap.set(url, promise);
    try {
        return await promise;
    } catch (err) {
        cacheMap.delete(url);
        throw err;
    }
}

/**
 * models/block/*.json を parent 継承チェーンごと再帰ロードし、textures と elements を統合解決する
 */
export async function loadResolvedModelJson(modelId, assetRoot = DEFAULT_ASSET_ROOT, depth = 0) {
    if (depth > 16) {
        throw new Error(`[ModelCompiler] parent 継承が深すぎます: ${modelId}`);
    }
    let rel = stripNamespace(modelId);
    if (!rel.startsWith('block/') && !rel.startsWith('item/')) {
        rel = `block/${rel}`;
    }
    const url = `${assetRoot}/models/${rel}.json`;
    const raw = await fetchJsonCached(url, _modelJsonCache);

    let parentResolved = null;
    if (raw.parent) {
        const pClean = stripNamespace(raw.parent);
        if (pClean !== 'builtin/generated' && pClean !== 'builtin/entity') {
            parentResolved = await loadResolvedModelJson(raw.parent, assetRoot, depth + 1);
        }
    }

    const mergedTextures = {
        ...(parentResolved ? parentResolved.textures : {}),
        ...(raw.textures || {})
    };

    const elements = Array.isArray(raw.elements)
        ? raw.elements
        : (parentResolved ? parentResolved.elements : []);

    return {
        textures: mergedTextures,
        elements
    };
}

/**
 * テクスチャ変数 ("#top" -> "#all" -> "textures/blocks/stone.png") を最終実パスまで多段解決する
 */
function resolveTextureRef(ref, texturesMap) {
    let cur = ref;
    for (let guard = 0; guard < 12; guard++) {
        if (!cur || typeof cur !== 'string') return null;
        if (!cur.startsWith('#')) return resolveJavaTexturePath(cur);
        const key = cur.slice(1);
        cur = texturesMap[key];
    }
    return null;
}

/**
 * Java Edition 標準デフォルトUV（face.uv 省略時、0..16px 空間）
 */
function getDefaultFaceUv(faceName, x1, y1, z1, x2, y2, z2) {
    switch (faceName) {
        case 'north': return [16 - x2, 16 - y2, 16 - x1, 16 - y1];
        case 'south': return [x1, 16 - y2, x2, 16 - y1];
        case 'west': return [z1, 16 - y2, z2, 16 - y1];
        case 'east': return [16 - z2, 16 - y2, 16 - z1, 16 - y1];
        case 'up': return [x1, z1, x2, z2];
        case 'down': return [x1, 16 - z2, x2, 16 - z1];
        default: return [0, 0, 16, 16];
    }
}

/**
 * 各面の 4頂点 [TL, TR, BR, BL] を CCW（外側向き法線）で生成
 */
function getFaceCorners(faceName, x1, y1, z1, x2, y2, z2) {
    switch (faceName) {
        case 'north': return [[x2, y2, z1], [x1, y2, z1], [x1, y1, z1], [x2, y1, z1]];
        case 'south': return [[x1, y2, z2], [x2, y2, z2], [x2, y1, z2], [x1, y1, z2]];
        case 'west': return [[x1, y2, z1], [x1, y2, z2], [x1, y1, z2], [x1, y1, z1]];
        case 'east': return [[x2, y2, z2], [x2, y2, z1], [x2, y1, z1], [x2, y1, z2]];
        case 'up': return [[x1, y2, z1], [x2, y2, z1], [x2, y2, z2], [x1, y2, z2]];
        case 'down': return [[x1, y1, z2], [x2, y1, z2], [x2, y1, z1], [x1, y1, z1]];
        default: return null;
    }
}

const FACE_LOCAL_NORMALS = {
    east: [1, 0, 0],
    west: [-1, 0, 0],
    up: [0, 1, 0],
    down: [0, -1, 0],
    south: [0, 0, 1],
    north: [0, 0, -1]
};

function normalToDirIndex(nx, ny, nz) {
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    if (ax >= ay && ax >= az) return nx > 0 ? 0 : 1;
    if (ay >= ax && ay >= az) return ny > 0 ? 2 : 3;
    return nz > 0 ? 4 : 5;
}

/**
 * 解決済み Java Edition モデル + blockstate 回転 (rotX, rotY) から
 * - THREE.BufferGeometry（(dir, matIdx) ごとにグループ化済）
 * - materialTextures（各 matIdx に対応するテクスチャパス配列）
 * - boxes（elements の回転後 AABB 配列：選択枠・衝突判定にそのまま利用可能）
 * をコンパイルする
 */
export function compileJavaModelVariant(resolvedModel, rotXDeg = 0, rotYDeg = 0, fallbackTexture = null) {
    const { textures, elements } = resolvedModel;
    const matPathToIdx = new Map();
    const materialTextures = [];

    const getMatIdx = (texPath) => {
        const key = texPath || fallbackTexture || 'textures/blocks/missing_texture.png';
        let idx = matPathToIdx.get(key);
        if (idx === undefined) {
            idx = materialTextures.length;
            materialTextures.push(key);
            matPathToIdx.set(key, idx);
        }
        return idx;
    };

    // Java Edition blockstate 回転行列: T(+0.5) * Ry(-rotY) * Rx(-rotX) * T(-0.5)
    const bsMat = new THREE.Matrix4();
    const bsRotMat = new THREE.Matrix4();
    const tmpMat = new THREE.Matrix4();

    if (rotXDeg !== 0) {
        tmpMat.makeRotationX(-THREE.MathUtils.degToRad(rotXDeg));
        bsRotMat.premultiply(tmpMat);
    }
    if (rotYDeg !== 0) {
        tmpMat.makeRotationY(-THREE.MathUtils.degToRad(rotYDeg));
        bsRotMat.premultiply(tmpMat);
    }

    bsMat.makeTranslation(-0.5, -0.5, -0.5);
    bsMat.premultiply(bsRotMat);
    tmpMat.makeTranslation(0.5, 0.5, 0.5);
    bsMat.premultiply(tmpMat);

    // バケットキー: (dir << 16) | matIdx
    // getBakedCustomTemplate は各 group の先頭頂点法線から dir と面シェーディング(fw)を決めるため、
    // 同じ法線方向 & 同じマテリアルごとにグループを揃える
    const buckets = new Map();
    const boxes = [];

    const vPos = new THREE.Vector3();
    const vNorm = new THREE.Vector3();
    const elemMat = new THREE.Matrix4();
    const elemRotMat = new THREE.Matrix4();
    const combinedMat = new THREE.Matrix4();
    const combinedRotMat = new THREE.Matrix4();

    for (let e = 0; e < elements.length; e++) {
        const el = elements[e];
        if (!el || !Array.isArray(el.from) || !Array.isArray(el.to)) continue;

        const fx = el.from[0], fy = el.from[1], fz = el.from[2];
        const tx = el.to[0], ty = el.to[1], tz = el.to[2];
        const x1 = fx / 16, y1 = fy / 16, z1 = fz / 16;
        const x2 = tx / 16, y2 = ty / 16, z2 = tz / 16;

        // 要素単体の任意回転 (el.rotation)
        elemMat.identity();
        elemRotMat.identity();
        if (el.rotation && typeof el.rotation.angle === 'number' && el.rotation.angle !== 0) {
            const ox = (el.rotation.origin?.[0] ?? 8) / 16;
            const oy = (el.rotation.origin?.[1] ?? 8) / 16;
            const oz = (el.rotation.origin?.[2] ?? 8) / 16;
            const rad = THREE.MathUtils.degToRad(el.rotation.angle);
            if (el.rotation.axis === 'x') elemRotMat.makeRotationX(rad);
            else if (el.rotation.axis === 'y') elemRotMat.makeRotationY(rad);
            else if (el.rotation.axis === 'z') elemRotMat.makeRotationZ(rad);

            elemMat.makeTranslation(-ox, -oy, -oz);
            elemMat.premultiply(elemRotMat);
            if (el.rotation.rescale) {
                const s = 1.0 / Math.cos(Math.abs(rad));
                if (el.rotation.axis === 'x') tmpMat.makeScale(1, s, s);
                else if (el.rotation.axis === 'y') tmpMat.makeScale(s, 1, s);
                else if (el.rotation.axis === 'z') tmpMat.makeScale(s, s, 1);
                elemMat.premultiply(tmpMat);
            }
            tmpMat.makeTranslation(ox, oy, oz);
            elemMat.premultiply(tmpMat);
        }

        combinedMat.copy(elemMat).premultiply(bsMat);
        combinedRotMat.copy(elemRotMat).premultiply(bsRotMat);

        // 要素の8頂点から回転済み AABB を自動算出（選択枠・衝突判定用）
        const box = new THREE.Box3();
        for (let cx = 0; cx < 2; cx++) {
            for (let cy = 0; cy < 2; cy++) {
                for (let cz = 0; cz < 2; cz++) {
                    vPos.set(cx ? x2 : x1, cy ? y2 : y1, cz ? z2 : z1).applyMatrix4(combinedMat);
                    box.expandByPoint(vPos);
                }
            }
        }
        boxes.push(box);

        if (!el.faces || typeof el.faces !== 'object') continue;

        for (let fi = 0; fi < FACE_NAMES.length; fi++) {
            const faceName = FACE_NAMES[fi];
            const faceDef = el.faces[faceName];
            if (!faceDef) continue;

            const texPath = resolveTextureRef(faceDef.texture, textures);
            const matIdx = getMatIdx(texPath);

            const corners = getFaceCorners(faceName, x1, y1, z1, x2, y2, z2);
            const baseNorm = FACE_LOCAL_NORMALS[faceName];
            vNorm.set(baseNorm[0], baseNorm[1], baseNorm[2]).applyMatrix4(combinedRotMat).normalize();
            const dir = normalToDirIndex(vNorm.x, vNorm.y, vNorm.z);

            const uvArr = Array.isArray(faceDef.uv)
                ? faceDef.uv
                : getDefaultFaceUv(faceName, fx, fy, fz, tx, ty, tz);

            const uMin = uvArr[0] / 16;
            const vTop = 1.0 - (uvArr[1] / 16);
            const uMax = uvArr[2] / 16;
            const vBot = 1.0 - (uvArr[3] / 16);

            const uvCorners = [
                [uMin, vTop], // TL
                [uMax, vTop], // TR
                [uMax, vBot], // BR
                [uMin, vBot]  // BL
            ];
            const uvShift = (((faceDef.rotation | 0) / 90) | 0) & 3;

            const bucketKey = (dir << 16) | matIdx;
            let bucket = buckets.get(bucketKey);
            if (!bucket) {
                bucket = { matIdx, pos: [], norm: [], uv: [], idx: [], vCount: 0 };
                buckets.set(bucketKey, bucket);
            }

            const vBase = bucket.vCount;
            for (let k = 0; k < 4; k++) {
                const c = corners[k];
                vPos.set(c[0], c[1], c[2]).applyMatrix4(combinedMat);
                bucket.pos.push(vPos.x, vPos.y, vPos.z);
                bucket.norm.push(vNorm.x, vNorm.y, vNorm.z);

                const uvC = uvCorners[(k - uvShift + 4) & 3];
                bucket.uv.push(uvC[0], uvC[1]);
            }

            // CCW 2三角形: (TL, BL, BR) & (TL, BR, TR)
            bucket.idx.push(vBase, vBase + 3, vBase + 2, vBase, vBase + 2, vBase + 1);
            bucket.vCount += 4;
        }
    }

    // 全バケットを1つの BufferGeometry へ結合し、各 (dir, matIdx) ごとに group を付与
    let totalVerts = 0;
    let totalIndices = 0;
    for (const b of buckets.values()) {
        totalVerts += b.vCount;
        totalIndices += b.idx.length;
    }

    const posArr = new Float32Array(totalVerts * 3);
    const normArr = new Float32Array(totalVerts * 3);
    const uvArr = new Float32Array(totalVerts * 2);
    const idxArr = new Uint16Array(totalIndices);

    const geom = new THREE.BufferGeometry();
    let vOff = 0;
    let iOff = 0;

    for (const b of buckets.values()) {
        posArr.set(b.pos, vOff * 3);
        normArr.set(b.norm, vOff * 3);
        uvArr.set(b.uv, vOff * 2);

        const ic = b.idx.length;
        for (let k = 0; k < ic; k++) {
            idxArr[iOff + k] = b.idx[k] + vOff;
        }
        geom.addGroup(iOff, ic, b.matIdx);

        vOff += b.vCount;
        iOff += ic;
    }

    geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    geom.setIndex(new THREE.BufferAttribute(idxArr, 1));
    geom.computeBoundingBox();

    return {
        geometry: geom,
        materialTextures,
        boxes: boxes.length > 0 ? Object.freeze(boxes) : Object.freeze([createBox(0, 0, 0, 1, 1, 1)])
    };
}

/**
 * blockstates/*.json のキー ("" または "lit=true,facing=east") が指定 (blockId, meta) に一致するか判定
 */
function matchesBlockstateVariantKey(blockId, meta, keyStr) {
    if (!keyStr || keyStr.trim() === '') return true;
    const clauses = keyStr.split(',');
    for (let i = 0; i < clauses.length; i++) {
        const eqIdx = clauses[i].indexOf('=');
        if (eqIdx < 0) return false;
        const propName = clauses[i].slice(0, eqIdx).trim();
        const expected = clauses[i].slice(eqIdx + 1).trim();
        const actual = getBlockStateProp(blockId, meta, propName);
        if (actual === undefined || String(actual) !== expected) return false;
    }
    return true;
}

async function getOrCompileVariant(modelId, rotX, rotY, assetRoot, fallbackTexture) {
    const cacheKey = `${assetRoot}|${modelId}|${rotX}|${rotY}`;
    if (_compiledVariantCache.has(cacheKey)) {
        return _compiledVariantCache.get(cacheKey);
    }
    const resolved = await loadResolvedModelJson(modelId, assetRoot);
    const compiled = compileJavaModelVariant(resolved, rotX, rotY, fallbackTexture);
    _compiledVariantCache.set(cacheKey, compiled);
    return compiled;
}

export async function applyJavaAssetsToBlockConfig(cfg, assetRoot = DEFAULT_ASSET_ROOT) {
    if (!cfg || (!cfg.blockstateFile && !cfg.modelFile)) return false;

    const id = cfg.id & 0xFFF;
    const stateCount = cfg.stateCount || 1;
    const stateMask = cfg.stateMask ?? (stateCount - 1);
    const geomsByMeta = new Array(stateCount).fill(null);
    const boxesByMeta = new Array(stateCount).fill(null);
    const texturesByMeta = new Array(stateCount).fill(null);

    if (cfg.blockstateFile) {
        const bsName = stripNamespace(cfg.blockstateFile).replace(/\.json$/, '');
        const bsUrl = `${assetRoot}/blockstates/${bsName}.json`;
        const bsJson = await fetchJsonCached(bsUrl, _blockstateJsonCache);
        const variantEntries = bsJson && bsJson.variants ? Object.entries(bsJson.variants) : [];

        for (let m = 0; m < stateCount; m++) {
            let matchedSpec = null;
            for (let v = 0; v < variantEntries.length; v++) {
                if (matchesBlockstateVariantKey(id, m, variantEntries[v][0])) {
                    const rawSpec = variantEntries[v][1];
                    matchedSpec = Array.isArray(rawSpec) ? rawSpec[0] : rawSpec;
                    break;
                }
            }
            if (!matchedSpec || !matchedSpec.model) continue;

            const compiled = await getOrCompileVariant(
                matchedSpec.model,
                matchedSpec.x || 0,
                matchedSpec.y || 0,
                assetRoot,
                cfg.fallbackTexture
            );
            geomsByMeta[m] = compiled.geometry;
            boxesByMeta[m] = compiled.boxes;
            texturesByMeta[m] = compiled.materialTextures;
        }
    } else if (cfg.modelFile) {
        const compiled = await getOrCompileVariant(
            cfg.modelFile,
            0,
            0,
            assetRoot,
            cfg.fallbackTexture
        );
        for (let m = 0; m < stateCount; m++) {
            geomsByMeta[m] = compiled.geometry;
            boxesByMeta[m] = compiled.boxes;
            texturesByMeta[m] = compiled.materialTextures;
        }
    }

    // フォールバック用に最初の有効ジオメトリを確保
    const defaultMeta = (cfg.defaultState ?? 0) & stateMask;
    const fallbackGeom = geomsByMeta[defaultMeta] || geomsByMeta.find(Boolean);
    const fallbackBoxes = boxesByMeta[defaultMeta] || boxesByMeta.find(Boolean);
    const fallbackTextures = texturesByMeta[defaultMeta] || texturesByMeta.find(Boolean);
    if (!fallbackGeom) return false;

    for (let m = 0; m < stateCount; m++) {
        if (!geomsByMeta[m]) geomsByMeta[m] = fallbackGeom;
        if (!boxesByMeta[m]) boxesByMeta[m] = fallbackBoxes;
        if (!texturesByMeta[m]) texturesByMeta[m] = fallbackTextures;
    }

    const geomTypeKey = `json_model:${cfg.name || id}`;
    registerGeometryBuilder(geomTypeKey, (_config, meta = 0) => {
        const idx = (meta >= 0 && meta < stateCount) ? meta : 0;
        return geomsByMeta[idx];
    });

    // 選択枠・衝突箱を meta 別テーブルへ登録（既存プリセット明示時は尊重）
    if (!cfg.selectionPreset && !cfg.selectionSizeOverride) {
        registerSelectionPreset(geomTypeKey, boxesByMeta);
        cfg.selectionPreset = geomTypeKey;
    }
    if (cfg.collision !== false && !cfg.customCollision && cfg.autoModelCollision !== false) {
        registerCollisionPreset(geomTypeKey, boxesByMeta);
    }

    // ブロック設定を更新（blockstateFile 側で x/y 回転済みなら transformMask を 0 にして二重回転を防止）
    cfg.geometryType = geomTypeKey;
    cfg.shapeMode = 'raw';
    cfg.hasStateMaterials = true;
    if (cfg.blockstateFile && cfg.preserveTransformMask !== true) {
        cfg.transformMask = 0;
        compileAndRegisterBlockState(cfg);
    }

    // 事前コンパイル済みバリアントへ modelTextures を反映
    for (let m = 0; m < stateCount; m++) {
        const texList = texturesByMeta[m];
        if (!texList) continue;
        const existing = cfg._compiledVariants ? cfg._compiledVariants[m] : null;
        cfg._compiledVariants[m] = existing
            ? { ...existing, modelTextures: texList }
            : { modelTextures: texList };
    }

    // 状態別マテリアルキャッシュを破棄して最新モデルテクスチャを反映
    invalidateBlockMaterialCache(id);
    return true;
}

/**
 * 登録済み全ブロックの中から blockstateFile / modelFile を持つブロックを一括並列ロード＆コンパイルする
 * @returns {Promise<Array<object>>} 更新されたブロック設定配列
 */
export async function loadAllJavaBlockAssets(blockConfigMap, assetRoot = DEFAULT_ASSET_ROOT) {
    const targets = Object.values(blockConfigMap).filter(
        (cfg) => cfg && (cfg.blockstateFile || cfg.modelFile)
    );
    if (targets.length === 0) return [];

    const updated = [];
    await Promise.all(
        targets.map(async (cfg) => {
            try {
                const ok = await applyJavaAssetsToBlockConfig(cfg, assetRoot);
                if (ok) updated.push(cfg);
            } catch (err) {
                console.error(`[ModelCompiler] アセット読込失敗 (${cfg.name}):`, err);
            }
        })
    );
    return updated;
}