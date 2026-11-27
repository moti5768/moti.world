"use strict";
import * as THREE from '../build/three.module.js';
import { getRawBlockId } from '../blockstate.js';

/* ======================================================
   【Java Edition 準拠 セクション可視グラフ & BFS オクルージョンカリング】
   (world/occlusion_culler.js)
   - VisGraph: 16x16x16 セクション内の 6面間通り抜け可視性 (15bit) を高速フラッドフィル計算
   - Cave Culling BFS: カメラ現在セクションから視錐台＋可視グラフ＋単調方向制限で到達可能セクションのみ描画
   - 地上にいる間の地下洞窟セクション・壁/山の裏側セクションを完全カリング
   ====================================================== */

// 6方向定数: 0:+X, 1:-X, 2:+Y, 3:-Y, 4:+Z, 5:-Z
const DIR_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const DIR_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const DIR_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);
const OPPOSITE_DIR = new Uint8Array([1, 0, 3, 2, 5, 4]);

// 6面のうち異なる2面のペア (15組) を 15bit 整数へマップするテーブル
const PAIR_BIT = new Uint16Array(36);
let _pairBitIdx = 0;
for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) {
        const bit = 1 << _pairBitIdx++;
        PAIR_BIT[a * 6 + b] = bit;
        PAIR_BIT[b * 6 + a] = bit;
    }
}

export const VIS_ALL = 0x7FFF; // 全6面が相互に通り抜け可能（空気・透過セクション）
export const VIS_NONE = 0;     // 全方向遮断（完全な不透明ブロック塊）

// --- VisGraph フラッドフィル用再利用バッファ（完全ゼロGC） ---
const _visVisited = new Uint32Array(4096);
const _visQueue = new Int16Array(4096);
let _visStamp = 1;

function _addFacePairs(visMask, touchMask) {
    // 立っているビットが2個未満なら他面へ通り抜け不可
    if ((touchMask & (touchMask - 1)) === 0) return visMask;
    for (let a = 0; a < 6; a++) {
        if (((touchMask >> a) & 1) === 0) continue;
        const a6 = a * 6;
        for (let b = a + 1; b < 6; b++) {
            if (((touchMask >> b) & 1) !== 0) {
                visMask |= PAIR_BIT[a6 + b];
            }
        }
    }
    return visMask;
}

/**
 * 16x16x16 セクション (sy = 0..15) の 6面間通り抜け可視ビットマスク (15bit) を計算する
 * ※Minecraft Java Edition VisGraph.resolve() 準拠
 */
export function computeSectionVisibilityMask(voxelData, sy, isOpaqueBlock) {
    const yStart = sy << 4;

    if (++_visStamp >= 0x7FFFFFFF) {
        _visVisited.fill(0);
        _visStamp = 1;
    }
    const stamp = _visStamp;

    let visMask = 0;
    let nonOpaqueCount = 0;

    // 1. まず外周6面上の非不透明セルのみを始点にフラッドフィルを実行
    // （内部に閉じた空洞は外周に触れないため通り抜けには一切寄与しない）
    const floodFrom = (sx, syLocal, sz) => {
        const startIdx = (sx << 8) | (sz << 4) | syLocal;
        if (_visVisited[startIdx] === stamp) return;

        const vIdx0 = (sx << 12) | (sz << 8) | (yStart + syLocal);
        const bid0 = getRawBlockId(voxelData[vIdx0]);
        if (isOpaqueBlock[bid0] === 1) return;

        nonOpaqueCount++;
        _visVisited[startIdx] = stamp;
        let head = 0;
        let tail = 0;
        _visQueue[tail++] = startIdx;

        let touchMask = 0;

        while (head < tail) {
            const cur = _visQueue[head++];
            const x = cur >> 8;
            const z = (cur >> 4) & 15;
            const y = cur & 15;

            if (x === 15) touchMask |= 1;      // +X
            else if (x === 0) touchMask |= 2;  // -X
            if (y === 15) touchMask |= 4;      // +Y
            else if (y === 0) touchMask |= 8;  // -Y
            if (z === 15) touchMask |= 16;     // +Z
            else if (z === 0) touchMask |= 32; // -Z

            // +X
            if (x < 15) {
                const ni = cur + 256;
                if (_visVisited[ni] !== stamp) {
                    const b = getRawBlockId(voxelData[((x + 1) << 12) | (z << 8) | (yStart + y)]);
                    if (isOpaqueBlock[b] === 0) {
                        _visVisited[ni] = stamp;
                        _visQueue[tail++] = ni;
                    }
                }
            }
            // -X
            if (x > 0) {
                const ni = cur - 256;
                if (_visVisited[ni] !== stamp) {
                    const b = getRawBlockId(voxelData[((x - 1) << 12) | (z << 8) | (yStart + y)]);
                    if (isOpaqueBlock[b] === 0) {
                        _visVisited[ni] = stamp;
                        _visQueue[tail++] = ni;
                    }
                }
            }
            // +Y
            if (y < 15) {
                const ni = cur + 1;
                if (_visVisited[ni] !== stamp) {
                    const b = getRawBlockId(voxelData[(x << 12) | (z << 8) | (yStart + y + 1)]);
                    if (isOpaqueBlock[b] === 0) {
                        _visVisited[ni] = stamp;
                        _visQueue[tail++] = ni;
                    }
                }
            }
            // -Y
            if (y > 0) {
                const ni = cur - 1;
                if (_visVisited[ni] !== stamp) {
                    const b = getRawBlockId(voxelData[(x << 12) | (z << 8) | (yStart + y - 1)]);
                    if (isOpaqueBlock[b] === 0) {
                        _visVisited[ni] = stamp;
                        _visQueue[tail++] = ni;
                    }
                }
            }
            // +Z
            if (z < 15) {
                const ni = cur + 16;
                if (_visVisited[ni] !== stamp) {
                    const b = getRawBlockId(voxelData[(x << 12) | ((z + 1) << 8) | (yStart + y)]);
                    if (isOpaqueBlock[b] === 0) {
                        _visVisited[ni] = stamp;
                        _visQueue[tail++] = ni;
                    }
                }
            }
            // -Z
            if (z > 0) {
                const ni = cur - 16;
                if (_visVisited[ni] !== stamp) {
                    const b = getRawBlockId(voxelData[(x << 12) | ((z - 1) << 8) | (yStart + y)]);
                    if (isOpaqueBlock[b] === 0) {
                        _visVisited[ni] = stamp;
                        _visQueue[tail++] = ni;
                    }
                }
            }
        }

        visMask = _addFacePairs(visMask, touchMask);
    };

    // X=0, X=15 面
    for (let z = 0; z < 16; z++) {
        for (let y = 0; y < 16; y++) {
            floodFrom(0, y, z);
            if (visMask === VIS_ALL) return VIS_ALL;
            floodFrom(15, y, z);
            if (visMask === VIS_ALL) return VIS_ALL;
        }
    }
    // Y=0, Y=15 面
    for (let x = 1; x < 15; x++) {
        for (let z = 0; z < 16; z++) {
            floodFrom(x, 0, z);
            if (visMask === VIS_ALL) return VIS_ALL;
            floodFrom(x, 15, z);
            if (visMask === VIS_ALL) return VIS_ALL;
        }
    }
    // Z=0, Z=15 面
    for (let x = 1; x < 15; x++) {
        for (let y = 1; y < 15; y++) {
            floodFrom(x, y, 0);
            if (visMask === VIS_ALL) return VIS_ALL;
            floodFrom(x, y, 15);
            if (visMask === VIS_ALL) return VIS_ALL;
        }
    }

    return nonOpaqueCount === 0 ? VIS_NONE : visMask;
}

export function createOcclusionCuller(deps) {
    const {
        CHUNK_SIZE,
        SECTION_HEIGHT,
        SECTIONS_PER_CHUNK,
        BEDROCK_LEVEL,
        encodeChunkKey
    } = deps;

    const _frustum = new THREE.Frustum();
    const _projScreenMatrix = new THREE.Matrix4();
    const _secBox = new THREE.Box3();

    // BFS 用再利用フラットバッファ（1セクション最大1回投入のため爆発ゼロ・完全ゼロGC）
    const MAX_QUEUE = 32768;
    const _qCx = new Int32Array(MAX_QUEUE);
    const _qSy = new Int8Array(MAX_QUEUE);
    const _qCz = new Int32Array(MAX_QUEUE);
    const _qNodeIdx = new Int32Array(MAX_QUEUE);

    // 相対チャンクグリッド用キャッシュ（必要時に自動拡張）
    let _gridRadius = 0;
    let _gridSpan = 0;
    let _gridStamp = 1;
    let _nodeStamp = new Uint32Array(0);
    let _nodeEnteredFaces = new Uint8Array(0);
    let _chunkRefGrid = [];

    const stats = {
        totalSections: 0,
        renderedSections: 0
    };

    function ensureGridCapacity(radius) {
        if (radius <= _gridRadius) return;
        _gridRadius = radius;
        _gridSpan = radius * 2 + 1;
        const totalChunks = _gridSpan * _gridSpan;
        _chunkRefGrid = new Array(totalChunks).fill(null);
        _nodeStamp = new Uint32Array(totalChunks * SECTIONS_PER_CHUNK);
        _nodeEnteredFaces = new Uint8Array(totalChunks * SECTIONS_PER_CHUNK);
        _gridStamp = 1;
    }

    function fallbackFrustumOnly(loadedChunks) {
        let total = 0;
        let rendered = 0;

        for (const chunk of loadedChunks.values()) {
            const bbox = chunk.userData.boundingBox;
            const colVisible = bbox ? _frustum.intersectsBox(bbox) : false;
            chunk.visible = colVisible;
            const sections = chunk.userData.sections;
            if (!sections) continue;

            for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
                const sec = sections[sy];
                if (!sec) continue;
                total++;
                if (!colVisible) {
                    sec.visible = false;
                    continue;
                }
                const sbox = sec.userData.boundingBox;
                const vis = sbox ? _frustum.intersectsBox(sbox) : true;
                sec.visible = vis;
                if (vis) rendered++;
            }
        }

        stats.totalSections = total;
        stats.renderedSections = rendered;
    }

    /**
     * Java Edition SectionOcclusionGraph 準拠の可視セクション決定
     * - 1セクション最大1回のみキュー投入し、複数面からの到達は進入面ビットへ合流させる
     */
    function update(loadedChunks, camera, renderDistance) {
        camera.updateMatrixWorld();
        _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _frustum.setFromProjectionMatrix(_projScreenMatrix);

        const startCx = Math.floor(camera.position.x) >> 4;
        const startCz = Math.floor(camera.position.z) >> 4;
        const rawStartSy = Math.floor((camera.position.y - BEDROCK_LEVEL) / SECTION_HEIGHT);
        const startSy = rawStartSy < 0 ? 0 : (rawStartSy >= SECTIONS_PER_CHUNK ? SECTIONS_PER_CHUNK - 1 : rawStartSy);

        const startChunk = loadedChunks.get(encodeChunkKey(startCx, startCz));
        if (!startChunk) {
            fallbackFrustumOnly(loadedChunks);
            return stats;
        }

        const radius = Math.max(renderDistance + 2, 4);
        ensureGridCapacity(radius);

        if (++_gridStamp >= 0x7FFFFFFF) {
            _nodeStamp.fill(0);
            _gridStamp = 1;
        }
        const stamp = _gridStamp;
        const span = _gridSpan;
        const gridHalf = _gridRadius;

        // 1. 全ロード済みチャンクを非表示初期化しつつ、O(1) 参照グリッドへ登録
        _chunkRefGrid.fill(null);
        let totalSections = 0;

        for (const chunk of loadedChunks.values()) {
            chunk.visible = false;
            const sections = chunk.userData.sections;
            if (sections) {
                for (let sy = 0; sy < SECTIONS_PER_CHUNK; sy++) {
                    const sec = sections[sy];
                    if (sec) {
                        sec.visible = false;
                        totalSections++;
                    }
                }
            }

            const gx = chunk.userData.cx - startCx + gridHalf;
            const gz = chunk.userData.cz - startCz + gridHalf;
            if (gx >= 0 && gx < span && gz >= 0 && gz < span) {
                _chunkRefGrid[gx * span + gz] = chunk;
            }
        }

        // 2. カメラ現在セクションを始点として最短距離順 BFS 展開
        let renderedSections = 0;
        let head = 0;
        let tail = 0;

        const startCell = gridHalf * span + gridHalf;
        const startNodeIdx = (startCell << 4) | startSy;
        _nodeStamp[startNodeIdx] = stamp;
        _nodeEnteredFaces[startNodeIdx] = 0xFF; // 始点マーク（全6方向へ無制限展開）

        _qCx[tail] = startCx;
        _qSy[tail] = startSy;
        _qCz[tail] = startCz;
        _qNodeIdx[tail] = startNodeIdx;
        tail++;

        const startSec = startChunk.userData.sections ? startChunk.userData.sections[startSy] : null;
        if (startSec) {
            startChunk.visible = true;
            startSec.visible = true;
            renderedSections++;
        }

        while (head < tail) {
            const cx = _qCx[head];
            const sy = _qSy[head];
            const cz = _qCz[head];
            const curNodeIdx = _qNodeIdx[head];
            head++;

            const curEntered = _nodeEnteredFaces[curNodeIdx];
            const isStart = (curEntered === 0xFF);

            const gx = cx - startCx + gridHalf;
            const gz = cz - startCz + gridHalf;
            const chunk = _chunkRefGrid[gx * span + gz];
            if (!chunk) continue;

            const visArr = chunk.userData.sectionVis;
            const curVisMask = visArr ? visArr[sy] : VIS_ALL;

            // 完全遮断ブロック塊なら他方向へ一切通り抜けられない
            if (!isStart && curVisMask === VIS_NONE) continue;

            const dxFromCam = cx - startCx;
            const dyFromCam = sy - startSy;
            const dzFromCam = cz - startCz;
            const nearCamCur = (
                dxFromCam >= -1 && dxFromCam <= 1 &&
                dyFromCam >= -1 && dyFromCam <= 1 &&
                dzFromCam >= -1 && dzFromCam <= 1
            );

            for (let d = 0; d < 6; d++) {
                // カメラ相対単調性ルール: 一度離れた軸をカメラ側へ逆戻りしない（最短距離順を厳密保証）
                if (!nearCamCur) {
                    if (d === 0 && dxFromCam < 0) continue;
                    if (d === 1 && dxFromCam > 0) continue;
                    if (d === 2 && dyFromCam < 0) continue;
                    if (d === 3 && dyFromCam > 0) continue;
                    if (d === 4 && dzFromCam < 0) continue;
                    if (d === 5 && dzFromCam > 0) continue;
                }

                // VisGraph 通り抜け判定（合流済みの全進入面のうち1つでも d へ抜けられれば通過）
                if (!isStart) {
                    if (curVisMask === VIS_ALL) {
                        // 進入元1面だけから同じ面へ戻る動きを除外
                        if (curEntered === (1 << d)) continue;
                    } else {
                        let canPass = false;
                        for (let f = 0; f < 6; f++) {
                            if (((curEntered >> f) & 1) !== 0 && f !== d && (curVisMask & PAIR_BIT[f * 6 + d]) !== 0) {
                                canPass = true;
                                break;
                            }
                        }
                        if (!canPass) continue;
                    }
                }

                const ncx = cx + DIR_DX[d];
                const nsy = sy + DIR_DY[d];
                const ncz = cz + DIR_DZ[d];

                if (nsy < 0 || nsy >= SECTIONS_PER_CHUNK) continue;

                const ngx = ncx - startCx + gridHalf;
                const ngz = ncz - startCz + gridHalf;
                if (ngx < 0 || ngx >= span || ngz < 0 || ngz >= span) continue;

                const nCell = ngx * span + ngz;
                const nChunk = _chunkRefGrid[nCell];
                if (!nChunk) continue;

                const enterBit = 1 << OPPOSITE_DIR[d];
                const nNodeIdx = (nCell << 4) | nsy;

                // すでに訪問済みならキューへ再投入せず、進入面ビットのみ合流させる
                if (_nodeStamp[nNodeIdx] === stamp) {
                    _nodeEnteredFaces[nNodeIdx] |= enterBit;
                    continue;
                }

                const nearCamNext = (
                    Math.abs(ncx - startCx) <= 1 &&
                    Math.abs(nsy - startSy) <= 1 &&
                    Math.abs(ncz - startCz) <= 1
                );

                // 経路探索用の視錐台チェック（視錐台エッジ掠めによる欠け防止のため ±1 ブロックの安全マージン）
                if (!nearCamNext) {
                    const bx = ncx * CHUNK_SIZE;
                    const by = BEDROCK_LEVEL + nsy * SECTION_HEIGHT;
                    const bz = ncz * CHUNK_SIZE;
                    _secBox.min.set(bx - 1, by - 1, bz - 1);
                    _secBox.max.set(bx + CHUNK_SIZE + 1, by + SECTION_HEIGHT + 1, bz + CHUNK_SIZE + 1);
                    if (!_frustum.intersectsBox(_secBox)) continue;
                }

                _nodeStamp[nNodeIdx] = stamp;
                _nodeEnteredFaces[nNodeIdx] = enterBit;

                const nSec = nChunk.userData.sections ? nChunk.userData.sections[nsy] : null;
                if (nSec) {
                    const sbox = nSec.userData.boundingBox;
                    if (nearCamNext || !sbox || _frustum.intersectsBox(sbox)) {
                        nChunk.visible = true;
                        nSec.visible = true;
                        renderedSections++;
                    }
                }

                if (tail < MAX_QUEUE) {
                    _qCx[tail] = ncx;
                    _qSy[tail] = nsy;
                    _qCz[tail] = ncz;
                    _qNodeIdx[tail] = nNodeIdx;
                    tail++;
                }
            }
        }

        stats.totalSections = totalSections;
        stats.renderedSections = renderedSections;
        return stats;
    }

    return {
        update,
        get stats() { return stats; }
    };
}