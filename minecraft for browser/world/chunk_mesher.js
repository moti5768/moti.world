"use strict";
import * as THREE from '../build/three.module.js';
import {
    getRawBlockId,
    getRawLocalState,
    getTransformMeta,
    getBlockStateRawProp
} from '../blockstate.js';
import {
    getBlockGeometry,
    getCustomGeometryMatrix,
    getLogRotationMatrixReadOnly
} from '../blocks.js';
import { computeSectionVisibilityMask, VIS_ALL } from './occlusion_culler.js';

/* ======================================================
   【16x16x16 セクション チャンクメッシャー】(world/chunk_mesher.js)
   - 3軸 2D Greedy Meshing（不透明・葉キューブ統合）＋ 液体水平面 Greedy Meshing
   - 内側コア葉の動的不透明化（外側Fancy透過＋内部Opaqueコア）
   - aBiomeColor 頂点属性によるバイオーム着色＆草側面オーバーレイ対応
   - カスタム形状テンプレート事前ベイクキャッシュ（ゼロGC）
   - Uint8正規化カラー ＆ onUpload JS配列即時解放
   - 3x3 隣接チャンク境界ビュー・欠損マスク管理
   ====================================================== */

// 4近傍の未ロード／ライト未計算状態を表すビットマスク定数
export const NEIGHBOR_BIT_PX = 1 << 0; // +X (cx + 1, cz)
export const NEIGHBOR_BIT_NX = 1 << 1; // -X (cx - 1, cz)
export const NEIGHBOR_BIT_PZ = 1 << 2; // +Z (cx, cz + 1)
export const NEIGHBOR_BIT_NZ = 1 << 3; // -Z (cx, cz - 1)

const FACE_FW = new Float32Array([0.8, 0.8, 1.0, 0.5, 0.65, 0.65]);

const CUBE_VERTICES = new Int8Array([
    1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, // 0: px
    0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, // 1: nx
    0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 0, // 2: py
    0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, // 3: ny
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, // 4: pz
    1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0  // 5: nz
]);

const CUBE_NORMALS = new Int8Array([
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,   // 0: px
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, // 1: nx
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,   // 2: py
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, // 3: ny
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,   // 4: pz
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1  // 5: nz
]);

const CUBE_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);

const _CONN_OFFSETS_DX = [0, 0, 1, -1];
const _CONN_OFFSETS_DZ = [-1, 1, 0, 0];
const _CONN_BITS = [3, 2, 1, 0]; // 北(3), 南(2), 東(1), 西(0)

const MAX_MESH_BATCH_POOL = 24;
const MAX_POOLED_BATCH_VERTS = 8192;

// three.js r128 最適化: WebGL バッファ転送完了直後に JS 側 TypedArray を解放し二重メモリ常駐をゼロ化
function releaseUploadedTypedArray() {
    this.array = null;
}

// フェード終了時の共有 originMat 復帰（単一・配列マテリアル両対応、クロージャ生成ゼロ）
function finalizeChunkMeshFade() {
    if (!this.material) return;
    if (Array.isArray(this.material)) {
        for (let i = 0; i < this.material.length; i++) {
            const m = this.material[i];
            const o = m && m.userData && m.userData.originMat;
            if (o) {
                m.dispose();
                this.material[i] = o;
            }
        }
    } else {
        const o = this.material.userData && this.material.userData.originMat;
        if (o) {
            this.material.dispose();
            this.material = o;
        }
    }
}

function createFadeCloneMaterial(originMat) {
    const fadeMat = originMat.clone();
    fadeMat.vertexColors = true;
    fadeMat.transparent = true;
    fadeMat.opacity = 0;
    fadeMat.depthWrite = false;
    if (fadeMat.color && originMat.color) fadeMat.color.copy(originMat.color);
    fadeMat.userData = {
        originMat,
        realOpacity: originMat.opacity !== undefined ? originMat.opacity : 1.0,
        shaderUniforms: originMat.userData ? originMat.userData.shaderUniforms : null
    };
    if (originMat.customProgramCacheKey) fadeMat.customProgramCacheKey = originMat.customProgramCacheKey;
    if (originMat.onBeforeCompile) fadeMat.onBeforeCompile = originMat.onBeforeCompile;
    return fadeMat;
}

const _opaqueLeafMatCache = new WeakMap();

/**
 * 6方向すべてを囲まれた「内側の葉コア」専用の完全不透明マテリアルを生成・キャッシュする
 */
function getOpaqueLeafMaterial(originMat) {
    if (!originMat) return null;
    let opaqueMat = _opaqueLeafMatCache.get(originMat);
    if (opaqueMat) return opaqueMat;

    opaqueMat = originMat.clone();
    opaqueMat.transparent = false;
    opaqueMat.alphaTest = 0;
    opaqueMat.opacity = 1.0;
    opaqueMat.depthWrite = true;
    opaqueMat.side = THREE.FrontSide;
    opaqueMat.vertexColors = true;
    if (opaqueMat.color && originMat.color) opaqueMat.color.copy(originMat.color);

    const origUserData = originMat.userData || {};
    opaqueMat.userData = {
        ...origUserData,
        isShared: true,
        isOpaqueLeafCore: true
    };

    const hasBiomeTint = !!(origUserData.shaderUniforms && origUserData.shaderUniforms.biomeTintMode > 0);
    const origCompile = originMat.onBeforeCompile;
    const origKey = originMat.customProgramCacheKey;
    opaqueMat.customProgramCacheKey = () => {
        const baseKey = (typeof origKey === "function") ? origKey.call(originMat) : "basic";
        return `${baseKey}_leafcore`;
    };
    opaqueMat.onBeforeCompile = (shader, renderer) => {
        if (typeof origCompile === "function") {
            origCompile.call(opaqueMat, shader, renderer);
        }
        // #include <map_fragment> 内のバイオーム着色後に実行されるよう #include <color_fragment> 直前へ差し込む
        const coreFillRgb = hasBiomeTint ? '( vBiomeTint * 0.16 )' : 'vec3( 0.05, 0.11, 0.03 )';
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <color_fragment>',
            `#ifdef USE_MAP
            if ( texelColor.a < 0.5 ) {
                diffuseColor.rgb = diffuse * ${coreFillRgb};
                diffuseColor.a = opacity;
            }
            #endif
            #include <color_fragment>`
        );
    };

    _opaqueLeafMatCache.set(originMat, opaqueMat);
    return opaqueMat;
}

export function createChunkMesher(deps) {
    const {
        CHUNK_SIZE,
        CHUNK_HEIGHT,
        SECTION_HEIGHT,
        SECTIONS_PER_CHUNK,
        BEDROCK_LEVEL,
        BLOCK_TYPES,
        LIGHT_LEVEL_FACTORS,
        encodeChunkKey,
        isOpaqueBlock,
        isGreedyCubeBlock,
        isCustomGeometryBlock,
        cullSameBlock,
        isLogBlock,
        isLeavesBlock,
        getChunkBiomeColors,
        blockConfigFastArray,
        getBlockMaterialsFast,
        getChunkVoxelData,
        getLoadedVoxelData,
        isChunkDecorated,
        captureBaseChunkData,
        getLightMap,
        generateChunkLightMap,
        getWireConnectionMask,
        hasActiveBlockAnimations,
        isCoordHiddenByAnimation,
        onSectionBuilt
    } = deps;

    const CH_H = CHUNK_HEIGHT;
    const CH_S = CHUNK_SIZE;
    const STRIDE_Z = CH_H;
    const STRIDE_X = CH_H * CH_S;

    // 再利用一時ベクトル・行列
    const _v1 = new THREE.Vector3();
    const _n1 = new THREE.Vector3();
    const _m1 = new THREE.Matrix4();
    const _r1 = new THREE.Matrix4();
    const _mTemp = new THREE.Matrix4();
    const _dirVectors = [
        new THREE.Vector3(1, 0, 0),  // 0: px
        new THREE.Vector3(-1, 0, 0), // 1: nx
        new THREE.Vector3(0, 1, 0),  // 2: py
        new THREE.Vector3(0, -1, 0), // 3: ny
        new THREE.Vector3(0, 0, 1),  // 4: pz
        new THREE.Vector3(0, 0, -1)  // 5: nz
    ];

    // 再利用スクラッチバッチプール
    const _meshBatchPool = [];
    const _opaqueBatchMap = new Map();
    const _waterBatchMap = new Map();

    // 2D Greedy Meshing 用再利用バッファ
    const _greedyMaskPos = new Int32Array(16 * CH_H);
    const _greedyMaskNeg = new Int32Array(16 * CH_H);
    const _greedyMatToId = new Map();
    const _greedyIdToMat = [null]; // 1-based（0 は「面なし」予約）

    // カスタム形状テンプレート事前ベイクキャッシュ
    const _bakedCustomTemplateCache = new Map();

    // 3x3 隣接チャンク参照用再利用バッファ（index = (dx + 1) * 3 + (dz + 1)、中央は 4）
    const _boundaryVoxelGrid = new Array(9).fill(null);
    const _boundaryLightGrid = new Array(9).fill(null);

    const _secColMinY = new Int16Array(256);
    const _secColMaxY = new Int16Array(256);

    // 液体（水・溶岩）の水平面 (+Y / -Y) 2D Greedy Meshing 用再利用バッファ（ゼロGC）
    const _liquidTopMask = new Int32Array(4096); // (ly << 8) | (z << 4) | x
    const _liquidBotMask = new Int32Array(4096);
    const _liquidStyleMap = new Map();
    const _liquidStyles = [null]; // 1-based（0 は「面なし」予約）
    const _liquidFlatInfoCache = new Map();

    // 葉ブロックの内側コア判定用スタンプキャッシュ（完全ゼロGC）
    const _secInnerLeafState = new Uint32Array(4096);
    let _innerLeafStamp = 2;

    function acquireMeshBatch() {
        if (_meshBatchPool.length > 0) {
            const b = _meshBatchPool.pop();
            b.vCount = 0;
            b.iCount = 0;
            return b;
        }
        const initV = 256;
        const initI = 384;
        return {
            pos: new Float32Array(initV * 3),
            col: new Uint8Array(initV * 3),
            bCol: new Uint8Array(initV * 3),
            uv: new Float32Array(initV * 2),
            idx: new Uint32Array(initI),
            vCap: initV,
            iCap: initI,
            vCount: 0,
            iCount: 0
        };
    }

    function ensureBatchCapacity(batch, addVerts, addIndices) {
        const needV = batch.vCount + addVerts;
        if (needV > batch.vCap) {
            let nextV = batch.vCap;
            while (nextV < needV) nextV <<= 1;
            const nPos = new Float32Array(nextV * 3);
            const nCol = new Uint8Array(nextV * 3);
            const nBCol = new Uint8Array(nextV * 3);
            const nUv = new Float32Array(nextV * 2);
            const curV3 = batch.vCount * 3;
            const curV2 = batch.vCount * 2;
            if (curV3 > 0) {
                nPos.set(batch.pos.subarray(0, curV3));
                nCol.set(batch.col.subarray(0, curV3));
                nBCol.set(batch.bCol.subarray(0, curV3));
                nUv.set(batch.uv.subarray(0, curV2));
            }
            batch.pos = nPos;
            batch.col = nCol;
            batch.bCol = nBCol;
            batch.uv = nUv;
            batch.vCap = nextV;
        }

        const needI = batch.iCount + addIndices;
        if (needI > batch.iCap) {
            let nextI = batch.iCap;
            while (nextI < needI) nextI <<= 1;
            const nIdx = new Uint32Array(nextI);
            if (batch.iCount > 0) {
                nIdx.set(batch.idx.subarray(0, batch.iCount));
            }
            batch.idx = nIdx;
            batch.iCap = nextI;
        }
    }

    function getOrAcquireBatch(batchMap, mat) {
        let b = batchMap.get(mat);
        if (b === undefined) {
            b = acquireMeshBatch();
            batchMap.set(mat, b);
        }
        return b;
    }

    function releaseBatchMap(batchMap) {
        for (const batch of batchMap.values()) {
            batch.vCount = 0;
            batch.iCount = 0;
            if (_meshBatchPool.length < MAX_MESH_BATCH_POOL && batch.vCap <= MAX_POOLED_BATCH_VERTS) {
                _meshBatchPool.push(batch);
            }
        }
        batchMap.clear();
    }

    function getGreedyMatId(mat) {
        let id = _greedyMatToId.get(mat);
        if (id === undefined) {
            id = _greedyIdToMat.length;
            _greedyIdToMat.push(mat);
            _greedyMatToId.set(mat, id);
        }
        return id;
    }

    function getConnectionMaskLocal(lx, ly, lz, targetGeometryType, getFn) {
        let mask = 0;
        for (let i = 0; i < 4; i++) {
            const neighborId = getFn(lx + _CONN_OFFSETS_DX[i], ly, lz + _CONN_OFFSETS_DZ[i]);
            if (neighborId === 0) continue;

            if (isOpaqueBlock[neighborId] === 1) {
                mask |= (1 << _CONN_BITS[i]);
                continue;
            }
            const cfg = blockConfigFastArray[neighborId];
            if (cfg && cfg.geometryType === targetGeometryType) {
                mask |= (1 << _CONN_BITS[i]);
            }
        }
        return mask;
    }

    function resolveDynamicShapeMeta(type, cfg, meta, x, y, z, aboveType, getFn, getRawFn) {
        const mode = cfg.shapeMode;
        if (!mode || mode === "static") return 0;
        if (mode === "raw") return meta;
        if (mode === "connect_fence") return getConnectionMaskLocal(x, y, z, "fence", getFn);
        if (mode === "connect_pane") return getConnectionMaskLocal(x, y, z, "pane", getFn);
        if (mode === "connect_wire") return getWireConnectionMask(x, y, z, getRawFn);
        if (mode === "liquid") return (aboveType === type) ? 8 : (meta & 0xF);
        if (mode.startsWith("propRaw:")) {
            return getBlockStateRawProp(type, meta, mode.slice(8));
        }
        return meta;
    }

    function getBakedCustomTemplate(type, cfg, shapeMeta, transformMeta) {
        const key = type * 65536 + ((shapeMeta & 0xFFF) << 4) + (transformMeta & 0xF);
        const cached = _bakedCustomTemplateCache.get(key);
        if (cached !== undefined) return cached;

        const srcGeom = getBlockGeometry(cfg.geometryType, cfg, shapeMeta);
        if (!srcGeom) {
            _bakedCustomTemplateCache.set(key, null);
            return null;
        }

        const posAttr = srcGeom.getAttribute('position');
        const normAttr = srcGeom.getAttribute('normal');
        const uvAttr = srcGeom.getAttribute('uv');
        const indexAttr = srcGeom.index;
        const totalIdxCount = indexAttr ? indexAttr.count : posAttr.count;
        const groups = (srcGeom.groups && srcGeom.groups.length > 0)
            ? srcGeom.groups
            : [{ start: 0, count: totalIdxCount, materialIndex: 0 }];

        getCustomGeometryMatrix(transformMeta, _m1, _r1, _mTemp);
        _mTemp.makeTranslation(0.5, 0.5, 0.5);
        _m1.premultiply(_mTemp);

        const isUpsideDown = ((transformMeta >> 2) & 1) !== 0;
        const isCross = (cfg.geometryType === "cross");
        const useSelfLight = isCross || (cfg.isLadder === true);
        const bakedGroups = [];

        for (let g = 0; g < groups.length; g++) {
            const grp = groups[g];
            const start = grp.start;
            const end = Math.min(start + grp.count, totalIdxCount);
            const idxCount = end - start;
            if (idxCount <= 0) continue;

            const vertRemap = new Map();
            const localIndices = new Uint16Array(idxCount);
            const origVertIndices = [];

            for (let k = 0; k < idxCount; k++) {
                const oldIdx = indexAttr ? indexAttr.array[start + k] : (start + k);
                let newIdx = vertRemap.get(oldIdx);
                if (newIdx === undefined) {
                    newIdx = origVertIndices.length;
                    vertRemap.set(oldIdx, newIdx);
                    origVertIndices.push(oldIdx);
                }
                localIndices[k] = newIdx;
            }

            const vertCount = origVertIndices.length;
            const bPos = new Float32Array(vertCount * 3);
            const bUv = new Float32Array(vertCount * 2);

            const firstOld = origVertIndices[0] * 3;
            const fnx = normAttr ? normAttr.array[firstOld] : 0;
            const fny = normAttr ? normAttr.array[firstOld + 1] : 1;
            const fnz = normAttr ? normAttr.array[firstOld + 2] : 0;
            const ax = Math.abs(fnx), ay = Math.abs(fny), az = Math.abs(fnz);
            let dir;
            if (ax >= ay && ax >= az) dir = fnx > 0 ? 0 : 1;
            else if (ay >= ax && ay >= az) dir = fny > 0 ? 2 : 3;
            else dir = fnz > 0 ? 4 : 5;

            _v1.copy(_dirVectors[dir]).applyMatrix4(_r1);
            const wdx = Math.round(_v1.x);
            const wdy = Math.round(_v1.y);
            const wdz = Math.round(_v1.z);

            let fw = 1.0;
            if (!isCross) {
                if (wdy > 0.5) fw = 1.0;
                else if (wdy < -0.5) fw = 0.5;
                else if (Math.abs(wdz) > 0.5) fw = 0.65;
                else fw = 0.8;
            }

            for (let vi = 0; vi < vertCount; vi++) {
                const oi = origVertIndices[vi];
                const o3 = oi * 3;
                const o2 = oi * 2;
                const d3 = vi * 3;
                const d2 = vi * 2;

                _v1.set(posAttr.array[o3], posAttr.array[o3 + 1], posAttr.array[o3 + 2]).applyMatrix4(_m1);
                bPos[d3] = _v1.x;
                bPos[d3 + 1] = _v1.y;
                bPos[d3 + 2] = _v1.z;

                const ony = normAttr ? normAttr.array[o3 + 1] : 1;
                let u = uvAttr ? uvAttr.array[o2] : 0;
                let v = uvAttr ? uvAttr.array[o2 + 1] : 0;
                if (isUpsideDown && Math.abs(ony) < 0.1) {
                    u = 1.0 - u;
                    v = 1.0 - v;
                }
                bUv[d2] = u;
                bUv[d2 + 1] = v;
            }

            bakedGroups.push({
                pos: bPos,
                uv: bUv,
                idx: localIndices,
                vertCount,
                idxCount,
                matIdx: grp.materialIndex,
                dir,
                wdx,
                wdy,
                wdz,
                fw255: fw * 255.0,
                useSelfLight
            });
        }

        _bakedCustomTemplateCache.set(key, bakedGroups);
        return bakedGroups;
    }

    /**
     * 液体テンプレートの上面(+Y)・下面(-Y)が水平フル幅(0..1)か自動解析しキャッシュする
     */
    function getLiquidFlatInfo(type, shapeMeta, transformMeta, bakedGroups) {
        const key = type * 65536 + ((shapeMeta & 0xFFF) << 4) + (transformMeta & 0xF);
        const cached = _liquidFlatInfoCache.get(key);
        if (cached !== undefined) return cached;

        let topGrp = null, topCount = 0;
        let botGrp = null, botCount = 0;

        for (let g = 0; g < bakedGroups.length; g++) {
            const grp = bakedGroups[g];
            if (grp.dir === 2) { topGrp = grp; topCount++; }
            else if (grp.dir === 3) { botGrp = grp; botCount++; }
        }

        const analyzeFace = (grp, count) => {
            if (count !== 1 || !grp || grp.vertCount < 4) return null;
            const p = grp.pos;
            const y0 = p[1];
            let minX = p[0], maxX = p[0];
            let minZ = p[2], maxZ = p[2];
            for (let i = 0, len = grp.vertCount * 3; i < len; i += 3) {
                const vx = p[i], vy = p[i + 1], vz = p[i + 2];
                if (Math.abs(vy - y0) > 1e-4) return null; // 斜め水面は Greedy 対象外
                if (vx < minX) minX = vx;
                if (vx > maxX) maxX = vx;
                if (vz < minZ) minZ = vz;
                if (vz > maxZ) maxZ = vz;
            }
            if (minX > 0.001 || maxX < 0.999 || minZ > 0.001 || maxZ < 0.999) return null;
            return { yOff: y0, matIdx: grp.matIdx, fw255: grp.fw255 };
        };

        const info = {
            top: analyzeFace(topGrp, topCount),
            bot: analyzeFace(botGrp, botCount)
        };
        _liquidFlatInfoCache.set(key, info);
        return info;
    }

    function getLiquidStyleId(mat, yOff, fw255, isWaterBatch) {
        const yMilli = Math.round(yOff * 1000);
        const key = `${getGreedyMatId(mat)}_${yMilli}_${isWaterBatch ? 1 : 0}`;
        let id = _liquidStyleMap.get(key);
        if (id === undefined) {
            // Greedy クワッドの UV リピート (0..w, 0..h) が正しくタイルされるよう保証
            if (mat.map && (mat.map.wrapS !== THREE.RepeatWrapping || mat.map.wrapT !== THREE.RepeatWrapping)) {
                mat.map.wrapS = THREE.RepeatWrapping;
                mat.map.wrapT = THREE.RepeatWrapping;
                mat.map.needsUpdate = true;
            }
            id = _liquidStyles.length;
            _liquidStyles.push({ mat, yOff, fw255, isWaterBatch });
            _liquidStyleMap.set(key, id);
        }
        return id;
    }

    function buildCombinedMeshFromBatches(batchMap, renderOrder, useFadeIn, baseX, baseZ, maxY, minY = 0) {
        let totalVerts = 0;
        let totalIndices = 0;

        for (const batch of batchMap.values()) {
            if (batch.vCount > 0 && batch.iCount > 0) {
                totalVerts += batch.vCount;
                totalIndices += batch.iCount;
            }
        }

        if (totalVerts === 0 || totalIndices === 0) return null;

        const finalPos = new Float32Array(totalVerts * 3);
        const finalCol = new Uint8Array(totalVerts * 3);
        const finalBCol = new Uint8Array(totalVerts * 3);
        const finalUv = new Float32Array(totalVerts * 2);
        const finalIdx = (totalVerts <= 65535)
            ? new Uint16Array(totalIndices)
            : new Uint32Array(totalIndices);

        const geom = new THREE.BufferGeometry();
        const materials = [];

        let vOffset = 0;
        let iOffset = 0;

        for (const [originMat, batch] of batchMap.entries()) {
            const vc = batch.vCount;
            const ic = batch.iCount;
            if (vc === 0 || ic === 0) continue;

            const v3 = vc * 3;
            const v2 = vc * 2;
            finalPos.set(batch.pos.subarray(0, v3), vOffset * 3);
            finalCol.set(batch.col.subarray(0, v3), vOffset * 3);
            finalBCol.set(batch.bCol.subarray(0, v3), vOffset * 3);
            finalUv.set(batch.uv.subarray(0, v2), vOffset * 2);

            const srcIdx = batch.idx;
            for (let k = 0; k < ic; k++) {
                finalIdx[iOffset + k] = srcIdx[k] + vOffset;
            }

            const matIndex = materials.length;
            materials.push(useFadeIn ? createFadeCloneMaterial(originMat) : originMat);
            geom.addGroup(iOffset, ic, matIndex);

            vOffset += vc;
            iOffset += ic;
        }

        geom.setAttribute('position', new THREE.BufferAttribute(finalPos, 3).onUpload(releaseUploadedTypedArray));
        geom.setAttribute('color', new THREE.BufferAttribute(finalCol, 3, true).onUpload(releaseUploadedTypedArray));
        geom.setAttribute('aBiomeColor', new THREE.BufferAttribute(finalBCol, 3, true).onUpload(releaseUploadedTypedArray));
        geom.setAttribute('uv', new THREE.BufferAttribute(finalUv, 2).onUpload(releaseUploadedTypedArray));
        geom.setIndex(new THREE.BufferAttribute(finalIdx, 1).onUpload(releaseUploadedTypedArray));

        const boxMinY = BEDROCK_LEVEL + minY;
        const boxMaxY = BEDROCK_LEVEL + ((maxY + 1) < CH_H ? (maxY + 1) : CH_H);
        const cxS = baseX + 8.0;
        const cyS = (boxMinY + boxMaxY) * 0.5;
        const czS = baseZ + 8.0;
        const halfH = (boxMaxY - boxMinY) * 0.5;
        const radius = Math.sqrt(64.0 + halfH * halfH + 64.0);
        geom.boundingBox = new THREE.Box3(
            new THREE.Vector3(baseX, boxMinY, baseZ),
            new THREE.Vector3(baseX + CH_S, boxMaxY, baseZ + CH_S)
        );
        geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(cxS, cyS, czS), radius);

        const meshMat = (materials.length === 1) ? materials[0] : materials;
        const mesh = new THREE.Mesh(geom, meshMat);
        mesh.renderOrder = renderOrder;
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        if (useFadeIn) {
            mesh.userData.finalizeFade = finalizeChunkMeshFade;
        }
        return mesh;
    }

    function populateChunkBoundaryView(cx, cz, centerVoxelData, centerLightMap) {
        let missingNeighborMask = 0;

        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const gridIdx = (dx + 1) * 3 + (dz + 1);
                if (dx === 0 && dz === 0) {
                    _boundaryVoxelGrid[4] = centerVoxelData;
                    _boundaryLightGrid[4] = centerLightMap;
                    continue;
                }

                const nKey = encodeChunkKey(cx + dx, cz + dz);
                const nVoxel = getLoadedVoxelData(nKey);
                const nLight = getLightMap(nKey);

                _boundaryVoxelGrid[gridIdx] = nVoxel;
                _boundaryLightGrid[gridIdx] = nLight;

                if (!nVoxel || !nLight) {
                    if (dx === 1 && dz === 0) missingNeighborMask |= NEIGHBOR_BIT_PX;
                    else if (dx === -1 && dz === 0) missingNeighborMask |= NEIGHBOR_BIT_NX;
                    else if (dx === 0 && dz === 1) missingNeighborMask |= NEIGHBOR_BIT_PZ;
                    else if (dx === 0 && dz === -1) missingNeighborMask |= NEIGHBOR_BIT_NZ;
                }
            }
        }

        return missingNeighborMask;
    }

    function recomputeChunkBoundingBox(container) {
        const baseX = container.userData.cx * CH_S;
        const baseZ = container.userData.cz * CH_S;
        const sections = container.userData.sections;

        let minY = CH_H;
        let maxY = -1;
        if (sections) {
            for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
                const sec = sections[sy];
                if (!sec || !sec.userData.boundingBox) continue;
                const sb = sec.userData.boundingBox;
                if (sb.min.y < minY) minY = sb.min.y;
                if (sb.max.y > maxY) maxY = sb.max.y;
            }
        }

        if (maxY < minY) {
            container.userData.boundingBox = null;
        } else if (container.userData.boundingBox) {
            container.userData.boundingBox.min.set(baseX, minY, baseZ);
            container.userData.boundingBox.max.set(baseX + CH_S, maxY, baseZ + CH_S);
        } else {
            container.userData.boundingBox = new THREE.Box3(
                new THREE.Vector3(baseX, minY, baseZ),
                new THREE.Vector3(baseX + CH_S, maxY, baseZ + CH_S)
            );
        }
    }

    /**
     * 16x16x16 セクションの 6面間通り抜け可視マスク(15bit)を算出
     * （完全空気セクションは即 VIS_ALL、石の塊セクションはメッシュ空でも正確に VIS_NONE を返す）
     */
    function computeSectionVisibility(voxelData, sy) {
        const yStart = sy << 4;
        const yEnd = yStart + SECTION_HEIGHT;
        let hasAnyBlock = false;

        outer: for (let x = 0; x < CH_S; x = (x + 1) | 0) {
            const xOff = x << 12;
            for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                const colBase = xOff | (z << 8);
                for (let y = yStart; y < yEnd; y = (y + 1) | 0) {
                    if (voxelData[colBase | y] !== 0) {
                        hasAnyBlock = true;
                        break outer;
                    }
                }
            }
        }

        if (!hasAnyBlock) return VIS_ALL;
        return computeSectionVisibilityMask(voxelData, sy, isOpaqueBlock);
    }

    /**
     * 16x16x16 サブチャンク (sy = 0..15) 単体のメッシュを生成する
     * ※呼び出し前に populateChunkBoundaryView(cx, cz, voxelData, lightMap) を実行済みであること
     */
    function buildChunkSectionMesh(cx, cz, sy, voxelData, lightMap, useInstancing = false, useFadeIn = false, precomputedBiomeColors = null) {
        const baseX = cx * CH_S;
        const baseZ = cz * CH_S;
        const yStart = sy << 4;
        const yEnd = yStart + SECTION_HEIGHT - 1;

        let secMinY = CH_H;
        let secMaxY = -1;
        for (let x = 0; x < CH_S; x = (x + 1) | 0) {
            const xOff = x << 12;
            const xCol = x << 4;
            for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                const colBase = xOff | (z << 8);
                let yMax = yEnd;
                while (yMax >= yStart && voxelData[colBase | yMax] === 0) yMax--;
                if (yMax < yStart) {
                    _secColMinY[xCol | z] = CH_H;
                    _secColMaxY[xCol | z] = -1;
                    continue;
                }
                let yMin = yStart;
                while (yMin < yMax && voxelData[colBase | yMin] === 0) yMin++;
                _secColMinY[xCol | z] = yMin;
                _secColMaxY[xCol | z] = yMax;
                if (yMin < secMinY) secMinY = yMin;
                if (yMax > secMaxY) secMaxY = yMax;
            }
        }
        if (secMaxY < 0) return null;

        const hasPistonAnim = hasActiveBlockAnimations();

        function getRawLocal(x, y, z) {
            if (y < 0 || y >= CH_H) return 0;
            if (hasPistonAnim && isCoordHiddenByAnimation(baseX + x, BEDROCK_LEVEL + y, baseZ + z)) return 0;

            if (((x | z) & ~15) === 0) {
                return voxelData[y | (z << 8) | (x << 12)];
            }

            const dx = (x >> 4) + 1;
            const dz = (z >> 4) + 1;
            if (dx < 0 || dx > 2 || dz < 0 || dz > 2) return 0;

            const nData = _boundaryVoxelGrid[dx * 3 + dz];
            if (!nData) return 0;

            return nData[y | ((z & 15) << 8) | ((x & 15) << 12)];
        }

        function get(x, y, z) {
            return getRawBlockId(getRawLocal(x, y, z));
        }

        function getLightLevel(lx, ly, lz) {
            if (ly < 0) return 0;
            if (ly >= CH_H) return 0xF0;

            if (((lx | lz) & ~15) === 0) {
                return lightMap[ly | (lz << 8) | (lx << 12)];
            }

            const dx = (lx >> 4) + 1;
            const dz = (lz >> 4) + 1;
            if (dx >= 0 && dx <= 2 && dz >= 0 && dz <= 2) {
                const nlMap = _boundaryLightGrid[dx * 3 + dz];
                if (nlMap) {
                    return nlMap[ly | ((lz & 15) << 8) | ((lx & 15) << 12)];
                }
            }

            const clampedX = lx < 0 ? 0 : (lx > 15 ? 15 : lx);
            const clampedZ = lz < 0 ? 0 : (lz > 15 ? 15 : lz);
            const colBase = (clampedZ << 8) | (clampedX << 12);
            const selfLight = lightMap[colBase | ly];
            if (selfLight !== 0) return selfLight;
            if (ly + 1 < CH_H) {
                const aboveLight = lightMap[colBase | (ly + 1)];
                if (aboveLight !== 0) return aboveLight;
            }
            return ly >= 62 ? 0xF0 : 0;
        }

        _innerLeafStamp += 2;
        if (_innerLeafStamp >= 0x7FFFFFF0) {
            _secInnerLeafState.fill(0);
            _innerLeafStamp = 2;
        }
        const leafOuterStamp = _innerLeafStamp;
        const leafInnerStamp = _innerLeafStamp + 1;

        function isLeafOrOpaque(t) {
            return t !== 0 && (isOpaqueBlock[t] === 1 || (isLeavesBlock && isLeavesBlock[t] === 1));
        }

        /**
         * (x, y, z) の葉ブロックが6方向すべてを葉または不透明ブロックで囲まれているか判定
         */
        function isInnerLeafAt(x, y, z) {
            if (!isLeavesBlock) return false;
            const inSec = (((x | z) & ~15) === 0) && y >= yStart && y <= yEnd;
            let sIdx = 0;
            if (inSec) {
                sIdx = ((y - yStart) << 8) | (z << 4) | x;
                const st = _secInnerLeafState[sIdx];
                if (st === leafInnerStamp) return true;
                if (st === leafOuterStamp) return false;
            }

            const isInner = (
                isLeafOrOpaque(get(x + 1, y, z)) &&
                isLeafOrOpaque(get(x - 1, y, z)) &&
                isLeafOrOpaque(get(x, y + 1, z)) &&
                isLeafOrOpaque(get(x, y - 1, z)) &&
                isLeafOrOpaque(get(x, y, z + 1)) &&
                isLeafOrOpaque(get(x, y, z - 1))
            );

            if (inSec) {
                _secInnerLeafState[sIdx] = isInner ? leafInnerStamp : leafOuterStamp;
            }
            return isInner;
        }

        function shouldShowFace(myType, myOpaque, myCullSame, nType, nx, ny, nz) {
            if (nType === 0) return true;
            if (isOpaqueBlock[nType] === 1) return false;
            if (isLeavesBlock && isLeavesBlock[nType] === 1 && nx !== undefined && isInnerLeafAt(nx, ny, nz)) {
                return false;
            }
            if (myOpaque === 1) return true;
            if (myCullSame === 1) return nType !== myType;
            return true;
        }

        function matUsesBiomeTint(mat) {
            return !!(mat && mat.userData && mat.userData.shaderUniforms && mat.userData.shaderUniforms.biomeTintMode > 0);
        }

        releaseBatchMap(_opaqueBatchMap);
        releaseBatchMap(_waterBatchMap);
        _greedyMatToId.clear();
        _greedyIdToMat.length = 1;
        _liquidStyleMap.clear();
        _liquidStyles.length = 1;
        let liquidTopLayerMask = 0;
        let liquidBotLayerMask = 0;

        const biomeTintTable = precomputedBiomeColors ||
            ((typeof getChunkBiomeColors === "function") ? getChunkBiomeColors(cx, cz) : null);

        function emitGreedyQuad(faceIdx, key, x0, y0, z0, w, h) {
            const mat = _greedyIdToMat[key >>> 12];
            if (!mat) return;
            const biomeIdx = (key >>> 8) & 15;

            const batch = getOrAcquireBatch(_opaqueBatchMap, mat);
            ensureBatchCapacity(batch, 4, 6);

            const light = key & 0xFF;
            const fw255 = FACE_FW[faceIdx] * 255.0;
            let sByte = (LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw255 + 0.5) | 0;
            let bByte = (LIGHT_LEVEL_FACTORS[light & 15] * fw255 + 0.5) | 0;
            if (sByte > 255) sByte = 255;
            if (bByte > 255) bByte = 255;

            const vBase = batch.vCount;
            const p0 = vBase * 3;
            const u0 = vBase * 2;
            const i0 = batch.iCount;
            const pos = batch.pos;
            const col = batch.col;
            const bCol = batch.bCol;
            const uv = batch.uv;
            const idx = batch.idx;

            if (faceIdx === 2) {
                const yTop = y0 + 1;
                pos[p0] = x0; pos[p0 + 1] = yTop; pos[p0 + 2] = z0 + h;
                pos[p0 + 3] = x0 + w; pos[p0 + 4] = yTop; pos[p0 + 5] = z0 + h;
                pos[p0 + 6] = x0 + w; pos[p0 + 7] = yTop; pos[p0 + 8] = z0;
                pos[p0 + 9] = x0; pos[p0 + 10] = yTop; pos[p0 + 11] = z0;
            } else if (faceIdx === 3) {
                pos[p0] = x0; pos[p0 + 1] = y0; pos[p0 + 2] = z0;
                pos[p0 + 3] = x0 + w; pos[p0 + 4] = y0; pos[p0 + 5] = z0;
                pos[p0 + 6] = x0 + w; pos[p0 + 7] = y0; pos[p0 + 8] = z0 + h;
                pos[p0 + 9] = x0; pos[p0 + 10] = y0; pos[p0 + 11] = z0 + h;
            } else if (faceIdx === 0) {
                const xRight = x0 + 1;
                pos[p0] = xRight; pos[p0 + 1] = y0; pos[p0 + 2] = z0 + w;
                pos[p0 + 3] = xRight; pos[p0 + 4] = y0; pos[p0 + 5] = z0;
                pos[p0 + 6] = xRight; pos[p0 + 7] = y0 + h; pos[p0 + 8] = z0;
                pos[p0 + 9] = xRight; pos[p0 + 10] = y0 + h; pos[p0 + 11] = z0 + w;
            } else if (faceIdx === 1) {
                pos[p0] = x0; pos[p0 + 1] = y0; pos[p0 + 2] = z0;
                pos[p0 + 3] = x0; pos[p0 + 4] = y0; pos[p0 + 5] = z0 + w;
                pos[p0 + 6] = x0; pos[p0 + 7] = y0 + h; pos[p0 + 8] = z0 + w;
                pos[p0 + 9] = x0; pos[p0 + 10] = y0 + h; pos[p0 + 11] = z0;
            } else if (faceIdx === 4) {
                const zFront = z0 + 1;
                pos[p0] = x0; pos[p0 + 1] = y0; pos[p0 + 2] = zFront;
                pos[p0 + 3] = x0 + w; pos[p0 + 4] = y0; pos[p0 + 5] = zFront;
                pos[p0 + 6] = x0 + w; pos[p0 + 7] = y0 + h; pos[p0 + 8] = zFront;
                pos[p0 + 9] = x0; pos[p0 + 10] = y0 + h; pos[p0 + 11] = zFront;
            } else {
                pos[p0] = x0 + w; pos[p0 + 1] = y0; pos[p0 + 2] = z0;
                pos[p0 + 3] = x0; pos[p0 + 4] = y0; pos[p0 + 5] = z0;
                pos[p0 + 6] = x0; pos[p0 + 7] = y0 + h; pos[p0 + 8] = z0;
                pos[p0 + 9] = x0 + w; pos[p0 + 10] = y0 + h; pos[p0 + 11] = z0;
            }

            col[p0] = sByte; col[p0 + 1] = bByte; col[p0 + 2] = 0;
            col[p0 + 3] = sByte; col[p0 + 4] = bByte; col[p0 + 5] = 0;
            col[p0 + 6] = sByte; col[p0 + 7] = bByte; col[p0 + 8] = 0;
            col[p0 + 9] = sByte; col[p0 + 10] = bByte; col[p0 + 11] = 0;

            let br = 255, bg = 255, bb = 255;
            if (biomeIdx > 0 && biomeTintTable) {
                const su = mat.userData && mat.userData.shaderUniforms;
                const isFoliage = !!(su && su.defaultBiomeTint && su.defaultBiomeTint.getHex() === 0x77AB2F);
                const palette = isFoliage ? biomeTintTable.foliagePalette : biomeTintTable.grassPalette;
                const pi = (biomeIdx - 1) * 3;
                if (pi + 2 < palette.length) {
                    br = palette[pi];
                    bg = palette[pi + 1];
                    bb = palette[pi + 2];
                }
            }
            bCol[p0] = br; bCol[p0 + 1] = bg; bCol[p0 + 2] = bb;
            bCol[p0 + 3] = br; bCol[p0 + 4] = bg; bCol[p0 + 5] = bb;
            bCol[p0 + 6] = br; bCol[p0 + 7] = bg; bCol[p0 + 8] = bb;
            bCol[p0 + 9] = br; bCol[p0 + 10] = bg; bCol[p0 + 11] = bb;

            uv[u0] = 0; uv[u0 + 1] = 0;
            uv[u0 + 2] = w; uv[u0 + 3] = 0;
            uv[u0 + 4] = w; uv[u0 + 5] = h;
            uv[u0 + 6] = 0; uv[u0 + 7] = h;

            idx[i0] = vBase;
            idx[i0 + 1] = vBase + 1;
            idx[i0 + 2] = vBase + 2;
            idx[i0 + 3] = vBase;
            idx[i0 + 4] = vBase + 2;
            idx[i0 + 5] = vBase + 3;

            batch.vCount = vBase + 4;
            batch.iCount = i0 + 6;
        }

        function runGreedySlice(mask, uSize, vSize, faceIdx, fixedAxisVal, yOffset = 0) {
            for (let v = 0; v < vSize; v = (v + 1) | 0) {
                const rowOff = v * uSize;
                for (let u = 0; u < uSize;) {
                    const key = mask[rowOff + u];
                    if (key === 0) { u++; continue; }

                    let w = 1;
                    while (u + w < uSize && mask[rowOff + u + w] === key) w++;

                    let h = 1;
                    outer: while (v + h < vSize) {
                        const nextRow = (v + h) * uSize + u;
                        for (let k = 0; k < w; k++) {
                            if (mask[nextRow + k] !== key) break outer;
                        }
                        h++;
                    }

                    for (let dv = 0; dv < h; dv++) {
                        const clrRow = (v + dv) * uSize + u;
                        for (let du = 0; du < w; du++) {
                            mask[clrRow + du] = 0;
                        }
                    }

                    if (faceIdx === 2 || faceIdx === 3) {
                        emitGreedyQuad(faceIdx, key, baseX + u, BEDROCK_LEVEL + fixedAxisVal, baseZ + v, w, h);
                    } else if (faceIdx === 0 || faceIdx === 1) {
                        emitGreedyQuad(faceIdx, key, baseX + fixedAxisVal, BEDROCK_LEVEL + yOffset + v, baseZ + u, w, h);
                    } else {
                        emitGreedyQuad(faceIdx, key, baseX + u, BEDROCK_LEVEL + yOffset + v, baseZ + fixedAxisVal, w, h);
                    }

                    u += w;
                }
            }
        }

        // PASS 1: 3軸 2D Greedy Meshing（このセクション secMinY..secMaxY のみ最大 16 層）
        if (!useInstancing) {
            const H_MAX = CH_H - 1;

            // 1-A. Y軸スライス
            for (let y = secMinY; y <= secMaxY; y = (y + 1) | 0) {
                let hasPos = false;
                let hasNeg = false;

                for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                    const rowOff = z << 4;
                    const zShift = z << 8;
                    for (let x = 0; x < CH_S; x = (x + 1) | 0) {
                        const cellIdx = rowOff | x;
                        const vIdx = y | zShift | (x << 12);
                        const raw = (hasPistonAnim && isCoordHiddenByAnimation(baseX + x, BEDROCK_LEVEL + y, baseZ + z)) ? 0 : voxelData[vIdx];
                        const type = getRawBlockId(raw);
                        const meta = getRawLocalState(raw);

                        if (type === 0 || isGreedyCubeBlock[type] === 0 || (isLogBlock[type] === 1 && meta !== 0)) {
                            _greedyMaskPos[cellIdx] = 0;
                            _greedyMaskNeg[cellIdx] = 0;
                            continue;
                        }

                        const isInnerLeaf = (isLeavesBlock && isLeavesBlock[type] === 1) && isInnerLeafAt(x, y, z);
                        const myOp = isInnerLeaf ? 1 : isOpaqueBlock[type];
                        const myCs = cullSameBlock[type];
                        const mats = getBlockMaterialsFast(type, meta);
                        const cellBiomeShift = biomeTintTable ? (((biomeTintTable.ids[(z << 4) | x] + 1) & 15) << 8) : 0;

                        const upType = hasPistonAnim ? get(x, y + 1, z) : ((y < H_MAX) ? getRawBlockId(voxelData[vIdx + 1]) : 0);
                        if (shouldShowFace(type, myOp, myCs, upType, x, y + 1, z) && mats) {
                            const baseMat = mats[2] || mats[0];
                            const m = isInnerLeaf ? getOpaqueLeafMaterial(baseMat) : baseMat;
                            const bShift = matUsesBiomeTint(m) ? cellBiomeShift : 0;
                            _greedyMaskPos[cellIdx] = (getGreedyMatId(m) << 12) | bShift | getLightLevel(x, y + 1, z);
                            hasPos = true;
                        } else {
                            _greedyMaskPos[cellIdx] = 0;
                        }

                        const dnType = hasPistonAnim ? get(x, y - 1, z) : ((y > 0) ? getRawBlockId(voxelData[vIdx - 1]) : 0);
                        if (shouldShowFace(type, myOp, myCs, dnType, x, y - 1, z) && mats) {
                            const baseMat = mats[3] || mats[0];
                            const m = isInnerLeaf ? getOpaqueLeafMaterial(baseMat) : baseMat;
                            const bShift = matUsesBiomeTint(m) ? cellBiomeShift : 0;
                            _greedyMaskNeg[cellIdx] = (getGreedyMatId(m) << 12) | bShift | getLightLevel(x, y - 1, z);
                            hasNeg = true;
                        } else {
                            _greedyMaskNeg[cellIdx] = 0;
                        }
                    }
                }

                if (hasPos) runGreedySlice(_greedyMaskPos, CH_S, CH_S, 2, y, 0);
                if (hasNeg) runGreedySlice(_greedyMaskNeg, CH_S, CH_S, 3, y, 0);
            }

            // 1-B. X軸スライス
            const vSizeXZ = secMaxY - secMinY + 1;
            for (let x = 0; x < CH_S; x = (x + 1) | 0) {
                let hasPos = false;
                let hasNeg = false;
                const xShift = x << 12;

                for (let ly = 0; ly < vSizeXZ; ly = (ly + 1) | 0) {
                    const y = secMinY + ly;
                    const rowOff = ly << 4;
                    for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                        const cellIdx = rowOff | z;
                        const vIdx = y | (z << 8) | xShift;
                        const raw = (hasPistonAnim && isCoordHiddenByAnimation(baseX + x, BEDROCK_LEVEL + y, baseZ + z)) ? 0 : voxelData[vIdx];
                        const type = getRawBlockId(raw);
                        const meta = getRawLocalState(raw);

                        if (type === 0 || isGreedyCubeBlock[type] === 0 || (isLogBlock[type] === 1 && meta !== 0)) {
                            _greedyMaskPos[cellIdx] = 0;
                            _greedyMaskNeg[cellIdx] = 0;
                            continue;
                        }

                        const isInnerLeaf = (isLeavesBlock && isLeavesBlock[type] === 1) && isInnerLeafAt(x, y, z);
                        const myOp = isInnerLeaf ? 1 : isOpaqueBlock[type];
                        const myCs = cullSameBlock[type];
                        const mats = getBlockMaterialsFast(type, meta);
                        const cellBiomeShift = biomeTintTable ? (((biomeTintTable.ids[(z << 4) | x] + 1) & 15) << 8) : 0;

                        const pxType = hasPistonAnim ? get(x + 1, y, z) : ((x < 15) ? getRawBlockId(voxelData[vIdx + STRIDE_X]) : get(x + 1, y, z));
                        if (shouldShowFace(type, myOp, myCs, pxType, x + 1, y, z) && mats) {
                            const baseMat = mats[0];
                            const m = isInnerLeaf ? getOpaqueLeafMaterial(baseMat) : baseMat;
                            const bShift = matUsesBiomeTint(m) ? cellBiomeShift : 0;
                            _greedyMaskPos[cellIdx] = (getGreedyMatId(m) << 12) | bShift | getLightLevel(x + 1, y, z);
                            hasPos = true;
                        } else {
                            _greedyMaskPos[cellIdx] = 0;
                        }

                        const nxType = hasPistonAnim ? get(x - 1, y, z) : ((x > 0) ? getRawBlockId(voxelData[vIdx - STRIDE_X]) : get(x - 1, y, z));
                        if (shouldShowFace(type, myOp, myCs, nxType, x - 1, y, z) && mats) {
                            const baseMat = mats[1] || mats[0];
                            const m = isInnerLeaf ? getOpaqueLeafMaterial(baseMat) : baseMat;
                            const bShift = matUsesBiomeTint(m) ? cellBiomeShift : 0;
                            _greedyMaskNeg[cellIdx] = (getGreedyMatId(m) << 12) | bShift | getLightLevel(x - 1, y, z);
                            hasNeg = true;
                        } else {
                            _greedyMaskNeg[cellIdx] = 0;
                        }
                    }
                }

                if (hasPos) runGreedySlice(_greedyMaskPos, CH_S, vSizeXZ, 0, x, secMinY);
                if (hasNeg) runGreedySlice(_greedyMaskNeg, CH_S, vSizeXZ, 1, x, secMinY);
            }

            // 1-C. Z軸スライス
            for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                let hasPos = false;
                let hasNeg = false;
                const zShift = z << 8;

                for (let ly = 0; ly < vSizeXZ; ly = (ly + 1) | 0) {
                    const y = secMinY + ly;
                    const rowOff = ly << 4;
                    for (let x = 0; x < CH_S; x = (x + 1) | 0) {
                        const cellIdx = rowOff | x;
                        const vIdx = y | zShift | (x << 12);
                        const raw = (hasPistonAnim && isCoordHiddenByAnimation(baseX + x, BEDROCK_LEVEL + y, baseZ + z)) ? 0 : voxelData[vIdx];
                        const type = getRawBlockId(raw);
                        const meta = getRawLocalState(raw);

                        if (type === 0 || isGreedyCubeBlock[type] === 0 || (isLogBlock[type] === 1 && meta !== 0)) {
                            _greedyMaskPos[cellIdx] = 0;
                            _greedyMaskNeg[cellIdx] = 0;
                            continue;
                        }

                        const isInnerLeaf = (isLeavesBlock && isLeavesBlock[type] === 1) && isInnerLeafAt(x, y, z);
                        const myOp = isInnerLeaf ? 1 : isOpaqueBlock[type];
                        const myCs = cullSameBlock[type];
                        const mats = getBlockMaterialsFast(type, meta);
                        const cellBiomeShift = biomeTintTable ? (((biomeTintTable.ids[(z << 4) | x] + 1) & 15) << 8) : 0;

                        const pzType = hasPistonAnim ? get(x, y, z + 1) : ((z < 15) ? getRawBlockId(voxelData[vIdx + STRIDE_Z]) : get(x, y, z + 1));
                        if (shouldShowFace(type, myOp, myCs, pzType, x, y, z + 1) && mats) {
                            const baseMat = mats[4] || mats[0];
                            const m = isInnerLeaf ? getOpaqueLeafMaterial(baseMat) : baseMat;
                            const bShift = matUsesBiomeTint(m) ? cellBiomeShift : 0;
                            _greedyMaskPos[cellIdx] = (getGreedyMatId(m) << 12) | bShift | getLightLevel(x, y, z + 1);
                            hasPos = true;
                        } else {
                            _greedyMaskPos[cellIdx] = 0;
                        }

                        const nzType = hasPistonAnim ? get(x, y, z - 1) : ((z > 0) ? getRawBlockId(voxelData[vIdx - STRIDE_Z]) : get(x, y, z - 1));
                        if (shouldShowFace(type, myOp, myCs, nzType, x, y, z - 1) && mats) {
                            const baseMat = mats[5] || mats[0];
                            const m = isInnerLeaf ? getOpaqueLeafMaterial(baseMat) : baseMat;
                            const bShift = matUsesBiomeTint(m) ? cellBiomeShift : 0;
                            _greedyMaskNeg[cellIdx] = (getGreedyMatId(m) << 12) | bShift | getLightLevel(x, y, z - 1);
                            hasNeg = true;
                        } else {
                            _greedyMaskNeg[cellIdx] = 0;
                        }
                    }
                }

                if (hasPos) runGreedySlice(_greedyMaskPos, CH_S, vSizeXZ, 4, z, secMinY);
                if (hasNeg) runGreedySlice(_greedyMaskNeg, CH_S, vSizeXZ, 5, z, secMinY);
            }
        }

        // PASS 2: カスタム形状＆横向き原木（このセクション内のみ）
        for (let x = 0; x < CH_S; x = (x + 1) | 0) {
            const wx = baseX + x;
            const xOff = x << 12;
            const xCol = x << 4;

            for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                const colMax = _secColMaxY[xCol | z];
                if (colMax < 0) continue;
                const colMin = _secColMinY[xCol | z];

                const wz = baseZ + z;
                const colBase = xOff | (z << 8);

                for (let y = colMin; y <= colMax; y = (y + 1) | 0) {
                    const vIdx = colBase | y;
                    const raw = (hasPistonAnim && isCoordHiddenByAnimation(wx, BEDROCK_LEVEL + y, wz)) ? 0 : voxelData[vIdx];
                    if (raw === 0) continue;

                    const type = getRawBlockId(raw);
                    const meta = getRawLocalState(raw);

                    if (isCustomGeometryBlock[type] === 1) {
                        const cfg = blockConfigFastArray[type];
                        if (!cfg) continue;

                        const gType = cfg.geometryType;
                        const isLiquid = (gType === "water");
                        const cullAdj = cfg.cullAdjacentFaces !== false;
                        const aboveType = (y < 255) ? getRawBlockId(voxelData[vIdx + 1]) : 0;
                        let visMask = 63;

                        if (cullAdj) {
                            const myOp = isOpaqueBlock[type];
                            const myCs = cullSameBlock[type];
                            const myLiquidRank = isLiquid
                                ? ((aboveType === type || ((meta >> 3) & 1) !== 0) ? 9 : (8 - (meta & 7)))
                                : 0;

                            const showHorizFace = (nx, nz, nRaw) => {
                                const nType = getRawBlockId(nRaw);
                                if (isLiquid && nType === type) {
                                    const nMeta = getRawLocalState(nRaw);
                                    const nAboveType = (y < 255) ? get(nx, y + 1, nz) : 0;
                                    const nRank = (nAboveType === type || ((nMeta >> 3) & 1) !== 0) ? 9 : (8 - (nMeta & 7));
                                    return myLiquidRank > nRank;
                                }
                                return shouldShowFace(type, myOp, myCs, nType);
                            };

                            visMask = 0;

                            if (x < 15) {
                                if (showHorizFace(x + 1, z, voxelData[vIdx + STRIDE_X])) visMask |= 1;
                            } else if (!isLiquid || _boundaryVoxelGrid[7] !== null) {
                                if (showHorizFace(16, z, getRawLocal(16, y, z))) visMask |= 1;
                            }

                            if (x > 0) {
                                if (showHorizFace(x - 1, z, voxelData[vIdx - STRIDE_X])) visMask |= 2;
                            } else if (!isLiquid || _boundaryVoxelGrid[1] !== null) {
                                if (showHorizFace(-1, z, getRawLocal(-1, y, z))) visMask |= 2;
                            }

                            if (shouldShowFace(type, myOp, myCs, aboveType)) visMask |= 4;
                            if (shouldShowFace(type, myOp, myCs, (y > 0) ? getRawBlockId(voxelData[vIdx - 1]) : 0)) visMask |= 8;

                            if (z < 15) {
                                if (showHorizFace(x, z + 1, voxelData[vIdx + STRIDE_Z])) visMask |= 16;
                            } else if (!isLiquid || _boundaryVoxelGrid[5] !== null) {
                                if (showHorizFace(x, 16, getRawLocal(x, y, 16))) visMask |= 16;
                            }

                            if (z > 0) {
                                if (showHorizFace(x, z - 1, voxelData[vIdx - STRIDE_Z])) visMask |= 32;
                            } else if (!isLiquid || _boundaryVoxelGrid[3] !== null) {
                                if (showHorizFace(x, -1, getRawLocal(x, y, -1))) visMask |= 32;
                            }

                            if (visMask === 0) continue;
                        }

                        const shapeMeta = resolveDynamicShapeMeta(type, cfg, meta, x, y, z, aboveType, get, getRawLocal);
                        const transformMeta = getTransformMeta(type, meta);
                        const bakedGroups = getBakedCustomTemplate(type, cfg, shapeMeta, transformMeta);
                        if (!bakedGroups || bakedGroups.length === 0) continue;

                        const allMats = getBlockMaterialsFast(type, meta);
                        if (!allMats) continue;

                        const isWaterBlock = (type === BLOCK_TYPES.WATER || cfg.isWater === true);
                        const targetBatchMap = isWaterBlock ? _waterBatchMap : _opaqueBatchMap;
                        const wy = BEDROCK_LEVEL + y;
                        const liqFlat = isLiquid ? getLiquidFlatInfo(type, shapeMeta, transformMeta, bakedGroups) : null;
                        const lySec = y - yStart;

                        let br = 255, bg = 255, bb = 255;
                        if (biomeTintTable && cfg.biomeTint) {
                            const ci = ((z << 4) | x) * 3;
                            const arr = (cfg.biomeTint === "foliage") ? biomeTintTable.foliageCell : biomeTintTable.grassCell;
                            br = arr[ci];
                            bg = arr[ci + 1];
                            bb = arr[ci + 2];
                        }

                        for (let g = 0, gLen = bakedGroups.length; g < gLen; g++) {
                            const grp = bakedGroups[g];
                            if (cullAdj && !cfg.isLadder && ((visMask >> grp.dir) & 1) === 0) continue;

                            const targetMat = allMats[grp.matIdx] || allMats[0];
                            if (!targetMat) continue;

                            // 液体（水・溶岩）の平坦な上面(+Y)・下面(-Y)は 2D Greedy Meshing へ統合
                            if (liqFlat) {
                                if (grp.dir === 2 && liqFlat.top) {
                                    const lightTop = getLightLevel(x, y + 1, z);
                                    const sid = getLiquidStyleId(targetMat, liqFlat.top.yOff, liqFlat.top.fw255, isWaterBlock);
                                    _liquidTopMask[(lySec << 8) | (z << 4) | x] = (sid << 8) | lightTop;
                                    liquidTopLayerMask |= (1 << lySec);
                                    continue;
                                }
                                if (grp.dir === 3 && liqFlat.bot) {
                                    const lightBot = getLightLevel(x, y - 1, z);
                                    const sid = getLiquidStyleId(targetMat, liqFlat.bot.yOff, liqFlat.bot.fw255, isWaterBlock);
                                    _liquidBotMask[(lySec << 8) | (z << 4) | x] = (sid << 8) | lightBot;
                                    liquidBotLayerMask |= (1 << lySec);
                                    continue;
                                }
                            }

                            const batch = getOrAcquireBatch(targetBatchMap, targetMat);
                            const vc = grp.vertCount;
                            const ic = grp.idxCount;
                            ensureBatchCapacity(batch, vc, ic);

                            const light = grp.useSelfLight
                                ? getLightLevel(x, y, z)
                                : getLightLevel(x + grp.wdx, y + grp.wdy, z + grp.wdz);
                            const fw255 = grp.fw255;
                            let sByte = (LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw255 + 0.5) | 0;
                            let bByte = (LIGHT_LEVEL_FACTORS[light & 15] * fw255 + 0.5) | 0;
                            if (sByte > 255) sByte = 255;
                            if (bByte > 255) bByte = 255;

                            const vBase = batch.vCount;
                            const bPos = batch.pos;
                            const bCol = batch.col;
                            const bBCol = batch.bCol;
                            const bUv = batch.uv;
                            const bIdx = batch.idx;
                            const gPos = grp.pos;

                            let p = vBase * 3;
                            for (let o = 0, len3 = vc * 3; o < len3; o += 3) {
                                bPos[p] = gPos[o] + wx;
                                bPos[p + 1] = gPos[o + 1] + wy;
                                bPos[p + 2] = gPos[o + 2] + wz;
                                bCol[p] = sByte;
                                bCol[p + 1] = bByte;
                                bCol[p + 2] = 0;
                                bBCol[p] = br;
                                bBCol[p + 1] = bg;
                                bBCol[p + 2] = bb;
                                p += 3;
                            }

                            bUv.set(grp.uv, vBase * 2);

                            const gIdx = grp.idx;
                            let ip = batch.iCount;
                            for (let k = 0; k < ic; k++) {
                                bIdx[ip++] = vBase + gIdx[k];
                            }

                            batch.vCount = vBase + vc;
                            batch.iCount = ip;
                        }
                        continue;
                    }

                    if (isLogBlock[type] === 1 && meta !== 0 && !useInstancing) {
                        const myOp = isOpaqueBlock[type];
                        const myCs = cullSameBlock[type];
                        let visMask = 0;
                        if (shouldShowFace(type, myOp, myCs, (x < 15) ? getRawBlockId(voxelData[vIdx + STRIDE_X]) : get(x + 1, y, z), x + 1, y, z)) visMask |= 1;
                        if (shouldShowFace(type, myOp, myCs, (x > 0) ? getRawBlockId(voxelData[vIdx - STRIDE_X]) : get(x - 1, y, z), x - 1, y, z)) visMask |= 2;
                        if (shouldShowFace(type, myOp, myCs, (y < 255) ? getRawBlockId(voxelData[vIdx + 1]) : 0, x, y + 1, z)) visMask |= 4;
                        if (shouldShowFace(type, myOp, myCs, (y > 0) ? getRawBlockId(voxelData[vIdx - 1]) : 0, x, y - 1, z)) visMask |= 8;
                        if (shouldShowFace(type, myOp, myCs, (z < 15) ? getRawBlockId(voxelData[vIdx + STRIDE_Z]) : get(x, y, z + 1), x, y, z + 1)) visMask |= 16;
                        if (shouldShowFace(type, myOp, myCs, (z > 0) ? getRawBlockId(voxelData[vIdx - STRIDE_Z]) : get(x, y, z - 1), x, y, z - 1)) visMask |= 32;
                        if (visMask === 0) continue;

                        const logMat = getLogRotationMatrixReadOnly(meta);
                        _r1.extractRotation(logMat);
                        const baseMats = getBlockMaterialsFast(type);
                        if (!baseMats) continue;
                        const wy = BEDROCK_LEVEL + y;

                        for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
                            const offset = faceIdx * 12;
                            _n1.set(CUBE_NORMALS[offset], CUBE_NORMALS[offset + 1], CUBE_NORMALS[offset + 2]).applyMatrix4(_r1);
                            const wNX = Math.round(_n1.x), wNY = Math.round(_n1.y), wNZ = Math.round(_n1.z);
                            const wBit = (wNX > 0) ? 0 : (wNX < 0) ? 1 : (wNY > 0) ? 2 : (wNY < 0) ? 3 : (wNZ > 0) ? 4 : 5;
                            if (((visMask >> wBit) & 1) === 0) continue;

                            const targetMat = baseMats[faceIdx] || baseMats[0];
                            if (!targetMat) continue;

                            const batch = getOrAcquireBatch(_opaqueBatchMap, targetMat);
                            ensureBatchCapacity(batch, 4, 6);

                            const fw = (wNY > 0) ? 1.0 : (wNY < 0) ? 0.5 : (Math.abs(wNX) > 0) ? 0.8 : 0.65;
                            const light = getLightLevel(x + wNX, y + wNY, z + wNZ);
                            const fw255 = fw * 255.0;
                            let sByte = (LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw255 + 0.5) | 0;
                            let bByte = (LIGHT_LEVEL_FACTORS[light & 15] * fw255 + 0.5) | 0;
                            if (sByte > 255) sByte = 255;
                            if (bByte > 255) bByte = 255;

                            const vBase = batch.vCount;
                            let p = vBase * 3;
                            const bPos = batch.pos;
                            const bCol = batch.col;
                            const bBCol = batch.bCol;

                            for (let j = 0; j < 12; j += 3) {
                                const oj = offset + j;
                                _v1.set(CUBE_VERTICES[oj], CUBE_VERTICES[oj + 1], CUBE_VERTICES[oj + 2]).applyMatrix4(logMat);
                                bPos[p] = _v1.x + wx;
                                bPos[p + 1] = _v1.y + wy;
                                bPos[p + 2] = _v1.z + wz;
                                bCol[p] = sByte;
                                bCol[p + 1] = bByte;
                                bCol[p + 2] = 0;
                                bBCol[p] = 255;
                                bBCol[p + 1] = 255;
                                bBCol[p + 2] = 255;
                                p += 3;
                            }

                            batch.uv.set(CUBE_UVS, vBase * 2);
                            const i0 = batch.iCount;
                            batch.idx[i0] = vBase;
                            batch.idx[i0 + 1] = vBase + 1;
                            batch.idx[i0 + 2] = vBase + 2;
                            batch.idx[i0 + 3] = vBase;
                            batch.idx[i0 + 4] = vBase + 2;
                            batch.idx[i0 + 5] = vBase + 3;

                            batch.vCount = vBase + 4;
                            batch.iCount = i0 + 6;
                        }
                    }
                }
            }
        }

        // PASS 2.5: 液体（水・溶岩）の水平面 2D Greedy Meshing 出力
        if (liquidTopLayerMask !== 0 || liquidBotLayerMask !== 0) {
            const emitLiquidGreedySlice = (maskBuf, isTop, ly) => {
                const layerOff = ly << 8;
                const yWorldBase = BEDROCK_LEVEL + yStart + ly;

                for (let z = 0; z < CH_S; z = (z + 1) | 0) {
                    const rowOff = layerOff | (z << 4);
                    for (let x = 0; x < CH_S;) {
                        const key = maskBuf[rowOff | x];
                        if (key === 0) { x++; continue; }

                        let w = 1;
                        while (x + w < CH_S && maskBuf[rowOff | (x + w)] === key) w++;

                        let h = 1;
                        outerLiq: while (z + h < CH_S) {
                            const nextRow = layerOff | ((z + h) << 4);
                            for (let k = 0; k < w; k++) {
                                if (maskBuf[nextRow | (x + k)] !== key) break outerLiq;
                            }
                            h++;
                        }

                        // 使用済みセルを即座に 0 クリア（次セクションへの残留ゼロ）
                        for (let dz = 0; dz < h; dz++) {
                            const clrRow = layerOff | ((z + dz) << 4);
                            for (let dx = 0; dx < w; dx++) {
                                maskBuf[clrRow | (x + dx)] = 0;
                            }
                        }

                        const style = _liquidStyles[key >>> 8];
                        if (style) {
                            const batchMap = style.isWaterBatch ? _waterBatchMap : _opaqueBatchMap;
                            const batch = getOrAcquireBatch(batchMap, style.mat);
                            ensureBatchCapacity(batch, 4, 6);

                            const light = key & 0xFF;
                            const fw255 = style.fw255;
                            let sByte = (LIGHT_LEVEL_FACTORS[(light >> 4) & 15] * fw255 + 0.5) | 0;
                            let bByte = (LIGHT_LEVEL_FACTORS[light & 15] * fw255 + 0.5) | 0;
                            if (sByte > 255) sByte = 255;
                            if (bByte > 255) bByte = 255;

                            const vBase = batch.vCount;
                            const p0 = vBase * 3;
                            const u0 = vBase * 2;
                            const i0 = batch.iCount;
                            const pos = batch.pos;
                            const col = batch.col;
                            const bCol = batch.bCol;
                            const uv = batch.uv;
                            const idx = batch.idx;

                            const x0 = baseX + x;
                            const z0 = baseZ + z;
                            const yPos = yWorldBase + style.yOff;

                            if (isTop) {
                                pos[p0] = x0; pos[p0 + 1] = yPos; pos[p0 + 2] = z0 + h;
                                pos[p0 + 3] = x0 + w; pos[p0 + 4] = yPos; pos[p0 + 5] = z0 + h;
                                pos[p0 + 6] = x0 + w; pos[p0 + 7] = yPos; pos[p0 + 8] = z0;
                                pos[p0 + 9] = x0; pos[p0 + 10] = yPos; pos[p0 + 11] = z0;
                            } else {
                                pos[p0] = x0; pos[p0 + 1] = yPos; pos[p0 + 2] = z0;
                                pos[p0 + 3] = x0 + w; pos[p0 + 4] = yPos; pos[p0 + 5] = z0;
                                pos[p0 + 6] = x0 + w; pos[p0 + 7] = yPos; pos[p0 + 8] = z0 + h;
                                pos[p0 + 9] = x0; pos[p0 + 10] = yPos; pos[p0 + 11] = z0 + h;
                            }

                            col[p0] = sByte; col[p0 + 1] = bByte; col[p0 + 2] = 0;
                            col[p0 + 3] = sByte; col[p0 + 4] = bByte; col[p0 + 5] = 0;
                            col[p0 + 6] = sByte; col[p0 + 7] = bByte; col[p0 + 8] = 0;
                            col[p0 + 9] = sByte; col[p0 + 10] = bByte; col[p0 + 11] = 0;

                            bCol[p0] = 255; bCol[p0 + 1] = 255; bCol[p0 + 2] = 255;
                            bCol[p0 + 3] = 255; bCol[p0 + 4] = 255; bCol[p0 + 5] = 255;
                            bCol[p0 + 6] = 255; bCol[p0 + 7] = 255; bCol[p0 + 8] = 255;
                            bCol[p0 + 9] = 255; bCol[p0 + 10] = 255; bCol[p0 + 11] = 255;

                            uv[u0] = 0; uv[u0 + 1] = 0;
                            uv[u0 + 2] = w; uv[u0 + 3] = 0;
                            uv[u0 + 4] = w; uv[u0 + 5] = h;
                            uv[u0 + 6] = 0; uv[u0 + 7] = h;

                            idx[i0] = vBase;
                            idx[i0 + 1] = vBase + 1;
                            idx[i0 + 2] = vBase + 2;
                            idx[i0 + 3] = vBase;
                            idx[i0 + 4] = vBase + 2;
                            idx[i0 + 5] = vBase + 3;

                            batch.vCount = vBase + 4;
                            batch.iCount = i0 + 6;
                        }

                        x += w;
                    }
                }
            };

            for (let ly = 0; ly < SECTION_HEIGHT; ly++) {
                if (((liquidTopLayerMask >> ly) & 1) !== 0) {
                    emitLiquidGreedySlice(_liquidTopMask, true, ly);
                }
                if (((liquidBotLayerMask >> ly) & 1) !== 0) {
                    emitLiquidGreedySlice(_liquidBotMask, false, ly);
                }
            }
        }

        // PASS 3: セクション統合メッシュ構築
        const opaqueMesh = buildCombinedMeshFromBatches(_opaqueBatchMap, 0, useFadeIn, baseX, baseZ, secMaxY, secMinY);
        const waterMesh = buildCombinedMeshFromBatches(_waterBatchMap, 10, useFadeIn, baseX, baseZ, secMaxY, secMinY);

        releaseBatchMap(_opaqueBatchMap);
        releaseBatchMap(_waterBatchMap);

        if (!opaqueMesh && !waterMesh) return null;

        const secGroup = new THREE.Object3D();
        secGroup.userData.sy = sy;
        if (opaqueMesh) secGroup.add(opaqueMesh);
        if (waterMesh) secGroup.add(waterMesh);

        const boxMinY = BEDROCK_LEVEL + secMinY;
        const boxMaxY = BEDROCK_LEVEL + ((secMaxY + 1) < CH_H ? (secMaxY + 1) : CH_H);
        secGroup.userData.boundingBox = new THREE.Box3(
            new THREE.Vector3(baseX, boxMinY, baseZ),
            new THREE.Vector3(baseX + CH_S, boxMaxY, baseZ + CH_S)
        );
        secGroup.matrixAutoUpdate = false;
        secGroup.updateMatrix();
        secGroup.updateMatrixWorld(true);
        return secGroup;
    }

    function generateChunkMeshMultiTexture(cx, cz, useInstancing = false, useFadeIn = false) {
        const container = new THREE.Object3D();
        container.userData.cx = cx;
        container.userData.cz = cz;
        const sections = new Array(SECTIONS_PER_CHUNK).fill(null);
        const sectionVis = new Uint16Array(SECTIONS_PER_CHUNK);
        container.userData.sections = sections;
        container.userData.sectionVis = sectionVis;

        const chunkKey = encodeChunkKey(cx, cz);
        let voxelData = getChunkVoxelData(chunkKey);
        let isNewChunk = false;

        if (!voxelData || !isChunkDecorated(chunkKey)) {
            voxelData = captureBaseChunkData(cx, cz);
            isNewChunk = true;
        }

        let lightMap = getLightMap(chunkKey);
        if (!lightMap || isNewChunk) {
            lightMap = generateChunkLightMap(chunkKey, voxelData);
        }

        container.userData.missingNeighborMask = populateChunkBoundaryView(cx, cz, voxelData, lightMap);
        const chunkBiomeColors = (typeof getChunkBiomeColors === "function") ? getChunkBiomeColors(cx, cz) : null;

        for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
            sectionVis[sy] = computeSectionVisibility(voxelData, sy);
            const secGroup = buildChunkSectionMesh(cx, cz, sy, voxelData, lightMap, useInstancing, useFadeIn, chunkBiomeColors);
            if (secGroup) {
                container.add(secGroup);
                sections[sy] = secGroup;
                if (typeof onSectionBuilt === "function") onSectionBuilt();
            }
        }

        recomputeChunkBoundingBox(container);
        container.matrixAutoUpdate = false;
        container.updateMatrix();
        container.updateMatrixWorld(true);
        return container;
    }

    return {
        populateChunkBoundaryView,
        recomputeChunkBoundingBox,
        computeSectionVisibility,
        buildChunkSectionMesh,
        generateChunkMeshMultiTexture,
        clearTemplateCache() {
            _bakedCustomTemplateCache.clear();
            _liquidFlatInfoCache.clear();
        }
    };
}