"use strict";
import {
    getRawBlockId,
    getRawLocalState,
    getBlockLightEmissionForState
} from '../blockstate.js';

/* ======================================================
   【15段階 マイクラ準拠 ライティングエンジン】(world/lighting_engine.js)
   - SkyLight (上位4bit) / BlockLight (下位4bit) 統合管理
   - 2フェーズ インクリメンタル光源更新（削除BFS -> 加算BFS）
   - 隣接チャンク到着時の境界差分光同期（全再計算ゼロ）
   ====================================================== */

export const LIGHT_LEVEL_FACTORS = new Float32Array(16);
const DEFAULT_BRIGHTNESS = 0.5; // マイクラの設定「明るさ: 50%」に相当
for (let i = 0; i <= 15; i++) {
    const f = Math.pow(0.8, 15 - i);
    const level = f / (f * (1.0 - DEFAULT_BRIGHTNESS) + DEFAULT_BRIGHTNESS);
    LIGHT_LEVEL_FACTORS[i] = Math.max(0.03, level);
}

const LIGHT_DIR_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const LIGHT_DIR_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const LIGHT_DIR_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);

// オーバーフローを構造的に防ぐリングバッファ（初期ライト構築用: 131072）
const LIGHT_RING_SIZE = 131072;
const LIGHT_RING_MASK = LIGHT_RING_SIZE - 1;

// 2フェーズ インクリメンタル光源エンジン用リングバッファ（ワールド座標ベース: 32768）
const INC_RING_SIZE = 32768;
const INC_RING_MASK = INC_RING_SIZE - 1;

export function createLightingEngine(deps) {
    const {
        CHUNK_SIZE,
        CHUNK_HEIGHT,
        encodeChunkKey,
        decodeChunkKey,
        getSectionMaskForY,
        getLoadedVoxelData,
        blockLightOpacity,
        blockMayEmitLight,
        pendingChunkUpdates
    } = deps;

    const CS = CHUNK_SIZE;
    const CH = CHUNK_HEIGHT;
    const CS_CH = CS * CH;            // 4096
    const TOTAL_CELLS = CS * CH * CS; // 65536
    const MOVE_OFFSETS = new Int32Array([CS_CH, -CS_CH, 1, -1, CH, -CH]);

    const chunkLightCache = new Map();
    const _localLightCoord = { cx: 0, cz: 0 };

    const _sharedQueue = new Int32Array(LIGHT_RING_SIZE);
    const _blockSeedIndices = new Int32Array(4096);
    const _blockSeedLevels = new Uint8Array(4096);

    const _incRemX = new Int32Array(INC_RING_SIZE);
    const _incRemY = new Int32Array(INC_RING_SIZE);
    const _incRemZ = new Int32Array(INC_RING_SIZE);
    const _incRemV = new Uint8Array(INC_RING_SIZE);
    const _incAddX = new Int32Array(INC_RING_SIZE);
    const _incAddY = new Int32Array(INC_RING_SIZE);
    const _incAddZ = new Int32Array(INC_RING_SIZE);

    function _markKeyDirty(outDirty, key, mask) {
        if (outDirty instanceof Map) {
            outDirty.set(key, (outDirty.get(key) || 0) | mask);
        } else {
            outDirty.add(key);
        }
    }

    function _markLightDirty(outDirty, wx, wy, wz) {
        if (!outDirty) return;
        const mask = (outDirty instanceof Map) ? getSectionMaskForY(wy) : 1;
        if (mask === 0) return;

        const cx = wx >> 4;
        const cz = wz >> 4;
        const lx = wx & 15;
        const lz = wz & 15;

        _markKeyDirty(outDirty, encodeChunkKey(cx, cz), mask);
        // チャンク境界セルのライトを参照する隣接チャンクの面も確実に再構築対象へ含める
        if (lx === 0) _markKeyDirty(outDirty, encodeChunkKey(cx - 1, cz), mask);
        else if (lx === 15) _markKeyDirty(outDirty, encodeChunkKey(cx + 1, cz), mask);
        if (lz === 0) _markKeyDirty(outDirty, encodeChunkKey(cx, cz - 1), mask);
        else if (lz === 15) _markKeyDirty(outDirty, encodeChunkKey(cx, cz + 1), mask);
    }

    function getBlockLightOpacity(blockId) {
        return blockLightOpacity[blockId];
    }

    function getBlockLightEmission(blockId, meta = 0) {
        if (blockMayEmitLight[blockId] === 0) return 0;
        return getBlockLightEmissionForState(blockId, meta);
    }

    function getWorldLightCell(wx, wy, wz) {
        if (wy < 0) return 0;
        if (wy >= CH) return 0xF0;
        const lMap = chunkLightCache.get(encodeChunkKey(wx >> 4, wz >> 4));
        if (!lMap) return -1;
        return lMap[wy | ((wz & 15) << 8) | ((wx & 15) << 12)];
    }

    function _getWorldRawLoaded(wx, wy, wz) {
        if (wy < 0 || wy >= CH) return 0;
        const vData = getLoadedVoxelData(wx >> 4, wz >> 4);
        if (!vData) return -1;
        return vData[wy | ((wz & 15) << 8) | ((wx & 15) << 12)];
    }

    function _getWorldBlockIdLoaded(wx, wy, wz) {
        const raw = _getWorldRawLoaded(wx, wy, wz);
        return raw < 0 ? -1 : getRawBlockId(raw);
    }

    function _setWorldSkyLight(wx, wy, wz, val, outDirtyChunks) {
        if (wy < 0 || wy >= CH) return;
        const key = encodeChunkKey(wx >> 4, wz >> 4);
        const lMap = chunkLightCache.get(key);
        if (!lMap) return;
        const idx = wy | ((wz & 15) << 8) | ((wx & 15) << 12);
        const prev = lMap[idx];
        const next = ((val & 15) << 4) | (prev & 15);
        if (prev !== next) {
            lMap[idx] = next;
            _markLightDirty(outDirtyChunks, wx, wy, wz);
        }
    }

    function _setWorldBlockLight(wx, wy, wz, val, outDirtyChunks) {
        if (wy < 0 || wy >= CH) return;
        const key = encodeChunkKey(wx >> 4, wz >> 4);
        const lMap = chunkLightCache.get(key);
        if (!lMap) return;
        const idx = wy | ((wz & 15) << 8) | ((wx & 15) << 12);
        const prev = lMap[idx];
        const next = (prev & 0xF0) | (val & 15);
        if (prev !== next) {
            lMap[idx] = next;
            _markLightDirty(outDirtyChunks, wx, wy, wz);
        }
    }

    function _runBlockLightAddBFS(addHead, addTail, outDirtyChunks) {
        while (addHead !== addTail) {
            const x = _incAddX[addHead];
            const y = _incAddY[addHead];
            const z = _incAddZ[addHead];
            addHead = (addHead + 1) & INC_RING_MASK;

            const cell = getWorldLightCell(x, y, z);
            if (cell < 0) continue;
            const val = cell & 15;
            if (val <= 1) continue;

            for (let i = 0; i < 6; i++) {
                const nx = x + LIGHT_DIR_DX[i];
                const ny = y + LIGHT_DIR_DY[i];
                const nz = z + LIGHT_DIR_DZ[i];
                if (ny < 0 || ny >= CH) continue;

                const nBlockId = _getWorldBlockIdLoaded(nx, ny, nz);
                if (nBlockId < 0) continue;
                const nOpacity = getBlockLightOpacity(nBlockId);
                if (nOpacity >= 15) continue;

                const decay = nOpacity > 1 ? nOpacity : 1;
                const nextVal = val - decay;
                if (nextVal <= 0) continue;

                const nCell = getWorldLightCell(nx, ny, nz);
                if (nCell < 0) continue;
                if (nextVal > (nCell & 15)) {
                    _setWorldBlockLight(nx, ny, nz, nextVal, outDirtyChunks);
                    const nextTail = (addTail + 1) & INC_RING_MASK;
                    if (nextTail !== addHead) {
                        _incAddX[addTail] = nx;
                        _incAddY[addTail] = ny;
                        _incAddZ[addTail] = nz;
                        addTail = nextTail;
                    }
                }
            }
        }
    }

    function _runSkyLightAddBFS(addHead, addTail, outDirtyChunks) {
        while (addHead !== addTail) {
            const x = _incAddX[addHead];
            const y = _incAddY[addHead];
            const z = _incAddZ[addHead];
            addHead = (addHead + 1) & INC_RING_MASK;

            const cell = getWorldLightCell(x, y, z);
            if (cell < 0) continue;
            const val = (cell >> 4) & 15;
            if (val <= 1) continue;

            for (let i = 0; i < 6; i++) {
                const nx = x + LIGHT_DIR_DX[i];
                const ny = y + LIGHT_DIR_DY[i];
                const nz = z + LIGHT_DIR_DZ[i];
                if (ny < 0 || ny >= CH) continue;

                const nBlockId = _getWorldBlockIdLoaded(nx, ny, nz);
                if (nBlockId < 0) continue;
                const nOpacity = getBlockLightOpacity(nBlockId);
                if (nOpacity >= 15) continue;

                let nextVal;
                if (i === 3 && val === 15) {
                    nextVal = 15 - nOpacity;
                } else {
                    const decay = nOpacity > 1 ? nOpacity : 1;
                    nextVal = val - decay;
                }
                if (nextVal <= 0) continue;

                const nCell = getWorldLightCell(nx, ny, nz);
                if (nCell < 0) continue;
                if (nextVal > ((nCell >> 4) & 15)) {
                    _setWorldSkyLight(nx, ny, nz, nextVal, outDirtyChunks);
                    const nextTail = (addTail + 1) & INC_RING_MASK;
                    if (nextTail !== addHead) {
                        _incAddX[addTail] = nx;
                        _incAddY[addTail] = ny;
                        _incAddZ[addTail] = nz;
                        addTail = nextTail;
                    }
                }
            }
        }
    }

    function updateLightAtBlockChange(wx, wy, wz, oldRaw, newRaw, outDirtyChunks) {
        if (wy < 0 || wy >= CH) return;

        const oldId = getRawBlockId(oldRaw);
        const newId = getRawBlockId(newRaw);
        const oldOpacity = getBlockLightOpacity(oldId);
        const newOpacity = getBlockLightOpacity(newId);
        const oldEmit = getBlockLightEmission(oldId, getRawLocalState(oldRaw));
        const newEmit = getBlockLightEmission(newId, getRawLocalState(newRaw));

        if (oldOpacity === newOpacity && oldEmit === newEmit) return;

        const centerKey = encodeChunkKey(wx >> 4, wz >> 4);
        const centerMap = chunkLightCache.get(centerKey);
        if (!centerMap) return;

        const centerIdx = wy | ((wz & 15) << 8) | ((wx & 15) << 12);
        const currentCell = centerMap[centerIdx];
        const currentSky = (currentCell >> 4) & 15;
        const currentBlock = currentCell & 15;

        // 1. ブロック光 (BlockLight): 削除BFS -> 加算BFS
        {
            let remHead = 0, remTail = 0;
            let addHead = 0, addTail = 0;

            const pushRem = (x, y, z, v) => {
                const nt = (remTail + 1) & INC_RING_MASK;
                if (nt === remHead) return;
                _incRemX[remTail] = x; _incRemY[remTail] = y; _incRemZ[remTail] = z; _incRemV[remTail] = v;
                remTail = nt;
            };
            const pushAdd = (x, y, z) => {
                const nt = (addTail + 1) & INC_RING_MASK;
                if (nt === addHead) return;
                _incAddX[addTail] = x; _incAddY[addTail] = y; _incAddZ[addTail] = z;
                addTail = nt;
            };

            if (currentBlock > newEmit && (oldEmit > newEmit || newOpacity > oldOpacity)) {
                _setWorldBlockLight(wx, wy, wz, 0, outDirtyChunks);
                pushRem(wx, wy, wz, currentBlock);

                while (remHead !== remTail) {
                    const x = _incRemX[remHead], y = _incRemY[remHead], z = _incRemZ[remHead], oldVal = _incRemV[remHead];
                    remHead = (remHead + 1) & INC_RING_MASK;

                    for (let i = 0; i < 6; i++) {
                        const nx = x + LIGHT_DIR_DX[i], ny = y + LIGHT_DIR_DY[i], nz = z + LIGHT_DIR_DZ[i];
                        if (ny < 0 || ny >= CH) continue;

                        const nCell = getWorldLightCell(nx, ny, nz);
                        if (nCell < 0) continue;
                        const nVal = nCell & 15;
                        if (nVal === 0) continue;

                        const nRaw = _getWorldRawLoaded(nx, ny, nz);
                        const nEmit = nRaw >= 0 ? getBlockLightEmission(getRawBlockId(nRaw), getRawLocalState(nRaw)) : 0;

                        if (nVal < oldVal) {
                            if (nEmit > 0) {
                                pushAdd(nx, ny, nz);
                            } else {
                                _setWorldBlockLight(nx, ny, nz, 0, outDirtyChunks);
                                pushRem(nx, ny, nz, nVal);
                            }
                        } else if (nVal >= oldVal) {
                            pushAdd(nx, ny, nz);
                        }
                    }
                }
            }

            if (newEmit > 0) {
                _setWorldBlockLight(wx, wy, wz, newEmit, outDirtyChunks);
                pushAdd(wx, wy, wz);
            } else if (newOpacity < 15) {
                for (let i = 0; i < 6; i++) {
                    const nx = wx + LIGHT_DIR_DX[i], ny = wy + LIGHT_DIR_DY[i], nz = wz + LIGHT_DIR_DZ[i];
                    const nCell = getWorldLightCell(nx, ny, nz);
                    if (nCell >= 0 && (nCell & 15) > 1) {
                        pushAdd(nx, ny, nz);
                    }
                }
            }

            _runBlockLightAddBFS(addHead, addTail, outDirtyChunks);
        }

        // 2. 天空光 (SkyLight): 垂直直射処理 -> 削除BFS -> 加算BFS
        {
            let remHead = 0, remTail = 0;
            let addHead = 0, addTail = 0;

            const pushRem = (x, y, z, v) => {
                const nt = (remTail + 1) & INC_RING_MASK;
                if (nt === remHead) return;
                _incRemX[remTail] = x; _incRemY[remTail] = y; _incRemZ[remTail] = z; _incRemV[remTail] = v;
                remTail = nt;
            };
            const pushAdd = (x, y, z) => {
                const nt = (addTail + 1) & INC_RING_MASK;
                if (nt === addHead) return;
                _incAddX[addTail] = x; _incAddY[addTail] = y; _incAddZ[addTail] = z;
                addTail = nt;
            };

            const aboveCell = (wy < CH - 1) ? getWorldLightCell(wx, wy + 1, wz) : 0xF0;
            const aboveSky = aboveCell >= 0 ? ((aboveCell >> 4) & 15) : 15;
            const expectedDirectSky = (newOpacity >= 15) ? 0 : (aboveSky === 15 ? (15 - newOpacity) : 0);

            if (newOpacity > oldOpacity && currentSky > 0) {
                _setWorldSkyLight(wx, wy, wz, 0, outDirtyChunks);
                pushRem(wx, wy, wz, currentSky);

                if (currentSky === 15 && expectedDirectSky < 15) {
                    for (let y = wy - 1; y >= 0; y--) {
                        const c = getWorldLightCell(wx, y, wz);
                        if (c < 0) break;
                        const s = (c >> 4) & 15;
                        if (s === 15) {
                            _setWorldSkyLight(wx, y, wz, 0, outDirtyChunks);
                            pushRem(wx, y, wz, 15);
                        } else {
                            break;
                        }
                    }
                }

                while (remHead !== remTail) {
                    const x = _incRemX[remHead], y = _incRemY[remHead], z = _incRemZ[remHead], oldVal = _incRemV[remHead];
                    remHead = (remHead + 1) & INC_RING_MASK;

                    for (let i = 0; i < 6; i++) {
                        const nx = x + LIGHT_DIR_DX[i], ny = y + LIGHT_DIR_DY[i], nz = z + LIGHT_DIR_DZ[i];
                        if (ny < 0 || ny >= CH) continue;

                        const nCell = getWorldLightCell(nx, ny, nz);
                        if (nCell < 0) continue;
                        const nVal = (nCell >> 4) & 15;
                        if (nVal === 0) continue;

                        if ((i === 3 && oldVal === 15 && nVal === 15) || nVal < oldVal) {
                            _setWorldSkyLight(nx, ny, nz, 0, outDirtyChunks);
                            pushRem(nx, ny, nz, nVal);
                        } else if (nVal >= oldVal) {
                            pushAdd(nx, ny, nz);
                        }
                    }
                }
            }

            if (newOpacity < 15) {
                if (expectedDirectSky === 15) {
                    for (let y = wy; y >= 0; y--) {
                        const bid = _getWorldBlockIdLoaded(wx, y, wz);
                        if (bid < 0) break;
                        const op = getBlockLightOpacity(bid);
                        if (op >= 15) break;
                        if (op === 0) {
                            _setWorldSkyLight(wx, y, wz, 15, outDirtyChunks);
                            pushAdd(wx, y, wz);
                        } else {
                            const atten = 15 - op;
                            const c = getWorldLightCell(wx, y, wz);
                            if (c >= 0 && atten > ((c >> 4) & 15)) {
                                _setWorldSkyLight(wx, y, wz, atten, outDirtyChunks);
                                pushAdd(wx, y, wz);
                            }
                            break;
                        }
                    }
                } else if (expectedDirectSky > 0) {
                    const c = getWorldLightCell(wx, wy, wz);
                    if (c >= 0 && expectedDirectSky > ((c >> 4) & 15)) {
                        _setWorldSkyLight(wx, wy, wz, expectedDirectSky, outDirtyChunks);
                        pushAdd(wx, wy, wz);
                    }
                }

                for (let i = 0; i < 6; i++) {
                    const nx = wx + LIGHT_DIR_DX[i], ny = wy + LIGHT_DIR_DY[i], nz = wz + LIGHT_DIR_DZ[i];
                    const nCell = getWorldLightCell(nx, ny, nz);
                    if (nCell >= 0 && ((nCell >> 4) & 15) > 1) {
                        pushAdd(nx, ny, nz);
                    }
                }
            }

            _runSkyLightAddBFS(addHead, addTail, outDirtyChunks);
        }
    }

    function syncBorderLightFromNeighbors(chunkKey, voxelData, outDirtyChunks = null) {
        const lightData = chunkLightCache.get(chunkKey);
        if (!lightData || !voxelData) return;

        decodeChunkKey(chunkKey, _localLightCoord);
        const cx = _localLightCoord.cx | 0;
        const cz = _localLightCoord.cz | 0;
        const baseX = cx << 4;
        const baseZ = cz << 4;

        const nMaps = [
            chunkLightCache.get(encodeChunkKey(cx + 1, cz)) || null,
            chunkLightCache.get(encodeChunkKey(cx - 1, cz)) || null,
            null, null,
            chunkLightCache.get(encodeChunkKey(cx, cz + 1)) || null,
            chunkLightCache.get(encodeChunkKey(cx, cz - 1)) || null
        ];
        const nVoxels = [
            getLoadedVoxelData(cx + 1, cz),
            getLoadedVoxelData(cx - 1, cz),
            null, null,
            getLoadedVoxelData(cx, cz + 1),
            getLoadedVoxelData(cx, cz - 1)
        ];

        let skyTail = 0;
        let blkTail = 0;

        // 1. 天空光 (SkyLight): 隣接4チャンクとの双方向境界シード（流入 ＋ 流出）
        for (let i = 0; i < 6; i++) {
            const nm = nMaps[i];
            const nv = nVoxels[i];
            if (!nm) continue;

            for (let s = 0; s < 16; s++) {
                let x = 0, z = 0, nLx = 0, nLz = 0;
                if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
                else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
                else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
                else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

                const myCol = (z << 8) | (x << 12);
                const nCol = (nLz << 8) | (nLx << 12);
                const myWx = baseX + x;
                const myWz = baseZ + z;
                const nWx = myWx + LIGHT_DIR_DX[i];
                const nWz = myWz + LIGHT_DIR_DZ[i];

                for (let y = 0; y < CH; y++) {
                    const idx = myCol | y;
                    const nIdx = nCol | y;
                    const mySky = (lightData[idx] >> 4) & 15;
                    const nSky = (nm[nIdx] >> 4) & 15;

                    if (nSky > mySky + 1) {
                        const myOp = getBlockLightOpacity(getRawBlockId(voxelData[idx]));
                        if (myOp < 15) {
                            const nextSky = nSky - (myOp > 1 ? myOp : 1);
                            if (nextSky > mySky) {
                                lightData[idx] = (nextSky << 4) | (lightData[idx] & 15);
                                _markLightDirty(outDirtyChunks, myWx, y, myWz);
                                if (skyTail < INC_RING_MASK) {
                                    _incAddX[skyTail] = myWx;
                                    _incAddY[skyTail] = y;
                                    _incAddZ[skyTail] = myWz;
                                    skyTail++;
                                }
                            }
                        }
                    } else if (nv && mySky > nSky + 1) {
                        const nOp = getBlockLightOpacity(getRawBlockId(nv[nIdx]));
                        if (nOp < 15) {
                            const nextSky = mySky - (nOp > 1 ? nOp : 1);
                            if (nextSky > nSky) {
                                nm[nIdx] = (nextSky << 4) | (nm[nIdx] & 15);
                                _markLightDirty(outDirtyChunks, nWx, y, nWz);
                                if (skyTail < INC_RING_MASK) {
                                    _incAddX[skyTail] = nWx;
                                    _incAddY[skyTail] = y;
                                    _incAddZ[skyTail] = nWz;
                                    skyTail++;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (skyTail > 0) {
            _runSkyLightAddBFS(0, skyTail, outDirtyChunks);
        }

        // 2. ブロック光 (BlockLight): 隣接4チャンクとの双方向境界シード（流入 ＋ 流出）
        for (let i = 0; i < 6; i++) {
            const nm = nMaps[i];
            const nv = nVoxels[i];
            if (!nm) continue;

            for (let s = 0; s < 16; s++) {
                let x = 0, z = 0, nLx = 0, nLz = 0;
                if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
                else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
                else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
                else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

                const myCol = (z << 8) | (x << 12);
                const nCol = (nLz << 8) | (nLx << 12);
                const myWx = baseX + x;
                const myWz = baseZ + z;
                const nWx = myWx + LIGHT_DIR_DX[i];
                const nWz = myWz + LIGHT_DIR_DZ[i];

                for (let y = 0; y < CH; y++) {
                    const idx = myCol | y;
                    const nIdx = nCol | y;
                    const myBlk = lightData[idx] & 15;
                    const nBlk = nm[nIdx] & 15;

                    if (nBlk > myBlk + 1) {
                        const myOp = getBlockLightOpacity(getRawBlockId(voxelData[idx]));
                        if (myOp < 15) {
                            const nextBlk = nBlk - (myOp > 1 ? myOp : 1);
                            if (nextBlk > myBlk) {
                                lightData[idx] = (lightData[idx] & 0xF0) | nextBlk;
                                _markLightDirty(outDirtyChunks, myWx, y, myWz);
                                if (blkTail < INC_RING_MASK) {
                                    _incAddX[blkTail] = myWx;
                                    _incAddY[blkTail] = y;
                                    _incAddZ[blkTail] = myWz;
                                    blkTail++;
                                }
                            }
                        }
                    } else if (nv && myBlk > nBlk + 1) {
                        const nOp = getBlockLightOpacity(getRawBlockId(nv[nIdx]));
                        if (nOp < 15) {
                            const nextBlk = myBlk - (nOp > 1 ? nOp : 1);
                            if (nextBlk > nBlk) {
                                nm[nIdx] = (nm[nIdx] & 0xF0) | nextBlk;
                                _markLightDirty(outDirtyChunks, nWx, y, nWz);
                                if (blkTail < INC_RING_MASK) {
                                    _incAddX[blkTail] = nWx;
                                    _incAddY[blkTail] = y;
                                    _incAddZ[blkTail] = nWz;
                                    blkTail++;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (blkTail > 0) {
            _runBlockLightAddBFS(0, blkTail, outDirtyChunks);
        }
    }

    function generateChunkLightMap(chunkKey, voxelData) {
        if (!voxelData || voxelData.length < TOTAL_CELLS) {
            console.warn("generateChunkLightMap: voxelData is invalid or too small.");
            return null;
        }

        let lightData = chunkLightCache.get(chunkKey);
        if (!lightData) {
            lightData = new Uint8Array(TOTAL_CELLS);
            chunkLightCache.set(chunkKey, lightData);
        } else {
            lightData.fill(0);
        }

        const queue = _sharedQueue;
        let head = 0, tail = 0;
        const pushLocal = (idx) => {
            if ((tail - head) < LIGHT_RING_MASK) {
                queue[tail & LIGHT_RING_MASK] = idx;
                tail++;
            }
        };

        decodeChunkKey(chunkKey, _localLightCoord);
        const cx = _localLightCoord.cx | 0;
        const cz = _localLightCoord.cz | 0;
        const baseX = cx << 4;
        const baseZ = cz << 4;

        const nMaps = new Array(6);
        const nVoxels = new Array(6);
        const nKeys = new Array(6);
        for (let i = 0; i < 6; i++) {
            if (i === 2 || i === 3) continue;
            const ncx = (cx + LIGHT_DIR_DX[i]) | 0;
            const ncz = (cz + LIGHT_DIR_DZ[i]) | 0;
            const nk = encodeChunkKey(ncx, ncz);
            nKeys[i] = nk;
            nMaps[i] = chunkLightCache.get(nk) || null;
            nVoxels[i] = getLoadedVoxelData(ncx, ncz);
        }

        // PHASE 1: 天空光 (SkyLight) ＋ 発光ブロック同時収集
        let chunkMaxAttenY = -1;
        let bSeedCount = 0;

        for (let x = 0; x < 16; x = (x + 1) | 0) {
            const xBase = (x << 12) | 0;
            for (let z = 0; z < 16; z = (z + 1) | 0) {
                const xzBase = (xBase | (z << 8)) | 0;
                let directSun = true;

                for (let y = 255; y >= 0; y = (y - 1) | 0) {
                    const idx = (xzBase | y) | 0;
                    const type = getRawBlockId(voxelData[idx]);

                    if (type !== 0) {
                        const emit = getBlockLightEmission(type, getRawLocalState(voxelData[idx]));
                        if (emit > 0 && bSeedCount < 4096) {
                            _blockSeedIndices[bSeedCount] = idx;
                            _blockSeedLevels[bSeedCount] = emit;
                            bSeedCount++;
                        }
                    }

                    if (directSun) {
                        const opacity = getBlockLightOpacity(type);
                        if (opacity === 0) {
                            lightData[idx] = 0xF0;
                        } else {
                            if (y > chunkMaxAttenY) chunkMaxAttenY = y;
                            directSun = false;
                            if (opacity < 15) {
                                const atten = 15 - opacity;
                                if (atten > 0) {
                                    lightData[idx] = (atten << 4);
                                    pushLocal(idx);
                                }
                            }
                        }
                    }
                }
            }
        }

        const scanMaxY = chunkMaxAttenY < 255 ? (chunkMaxAttenY + 1) : 255;
        if (scanMaxY >= 0) {
            for (let x = 0; x < 16; x = (x + 1) | 0) {
                const xBase = (x << 12) | 0;
                for (let z = 0; z < 16; z = (z + 1) | 0) {
                    const xzBase = (xBase | (z << 8)) | 0;
                    for (let y = 0; y <= scanMaxY; y = (y + 1) | 0) {
                        const idx = (xzBase | y) | 0;
                        const sky = (lightData[idx] >> 4) & 15;
                        if (sky <= 1) continue;

                        let needSpread = false;
                        if (x < 15 && ((lightData[idx + CS_CH] >> 4) & 15) < sky - 1 && getBlockLightOpacity(getRawBlockId(voxelData[idx + CS_CH])) < 15) needSpread = true;
                        else if (x > 0 && ((lightData[idx - CS_CH] >> 4) & 15) < sky - 1 && getBlockLightOpacity(getRawBlockId(voxelData[idx - CS_CH])) < 15) needSpread = true;
                        else if (z < 15 && ((lightData[idx + CH] >> 4) & 15) < sky - 1 && getBlockLightOpacity(getRawBlockId(voxelData[idx + CH])) < 15) needSpread = true;
                        else if (z > 0 && ((lightData[idx - CH] >> 4) & 15) < sky - 1 && getBlockLightOpacity(getRawBlockId(voxelData[idx - CH])) < 15) needSpread = true;
                        else if (y > 0 && ((lightData[idx - 1] >> 4) & 15) < sky - 1 && getBlockLightOpacity(getRawBlockId(voxelData[idx - 1])) < 15) needSpread = true;
                        else if (y < 255 && ((lightData[idx + 1] >> 4) & 15) < sky - 1 && getBlockLightOpacity(getRawBlockId(voxelData[idx + 1])) < 15) needSpread = true;

                        if (needSpread) pushLocal(idx);
                    }
                }
            }
        }

        let crossSkyTail = 0;
        for (let i = 0; i < 6; i = (i + 1) | 0) {
            const nm = nMaps[i];
            const nv = nVoxels[i];
            if (!nm) continue;

            for (let s = 0; s < 16; s = (s + 1) | 0) {
                let x = 0, z = 0, nLx = 0, nLz = 0;
                if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
                else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
                else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
                else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

                const myCol = (z << 8) | (x << 12);
                const nCol = (nLz << 8) | (nLx << 12);
                const nWx = baseX + x + LIGHT_DIR_DX[i];
                const nWz = baseZ + z + LIGHT_DIR_DZ[i];

                for (let y = 0; y < 256; y = (y + 1) | 0) {
                    const idx = myCol | y;
                    const nIdx = nCol | y;
                    const nSky = (nm[nIdx] >> 4) & 15;
                    const mySky = (lightData[idx] >> 4) & 15;

                    if (nSky > mySky + 1) {
                        const myOp = getBlockLightOpacity(getRawBlockId(voxelData[idx]));
                        if (myOp < 15) {
                            const nextSky = nSky - (myOp > 1 ? myOp : 1);
                            if (nextSky > mySky) {
                                lightData[idx] = (nextSky << 4) | (lightData[idx] & 15);
                                pushLocal(idx);
                            }
                        }
                    } else if (nv && mySky > nSky + 1) {
                        const nOp = getBlockLightOpacity(getRawBlockId(nv[nIdx]));
                        if (nOp < 15) {
                            const nextSky = mySky - (nOp > 1 ? nOp : 1);
                            if (nextSky > nSky) {
                                nm[nIdx] = (nextSky << 4) | (nm[nIdx] & 15);
                                if (crossSkyTail < INC_RING_MASK) {
                                    _incAddX[crossSkyTail] = nWx;
                                    _incAddY[crossSkyTail] = y;
                                    _incAddZ[crossSkyTail] = nWz;
                                    crossSkyTail++;
                                }
                                pendingChunkUpdates.add(nKeys[i]);
                            }
                        }
                    }
                }
            }
        }

        while (head < tail) {
            const idx = queue[head & LIGHT_RING_MASK] | 0;
            head++;
            const skyLight = (lightData[idx] >> 4) & 15;
            if (skyLight <= 1) continue;

            const y = idx & 255;
            const z = (idx >> 8) & 15;
            const x = idx >> 12;

            for (let i = 0; i < 6; i = (i + 1) | 0) {
                if ((i === 2 && y === 255) || (i === 3 && y === 0)) continue;

                const isBorder = (i === 0 && x === 15) || (i === 1 && x === 0) || (i === 4 && z === 15) || (i === 5 && z === 0);
                if (isBorder) {
                    const nm = nMaps[i];
                    const nv = nVoxels[i];
                    if (nm && nv) {
                        const nx = (i === 0) ? 0 : (i === 1) ? 15 : x;
                        const nz = (i === 4) ? 0 : (i === 5) ? 15 : z;
                        const nIdx = (y | (nz << 8) | (nx << 12)) | 0;
                        const nOp = getBlockLightOpacity(getRawBlockId(nv[nIdx]));
                        if (nOp < 15) {
                            const nextSky = skyLight - (nOp > 1 ? nOp : 1);
                            if (nextSky > ((nm[nIdx] >> 4) & 15)) {
                                nm[nIdx] = (nextSky << 4) | (nm[nIdx] & 15);
                                if (crossSkyTail < INC_RING_MASK) {
                                    _incAddX[crossSkyTail] = baseX + x + LIGHT_DIR_DX[i];
                                    _incAddY[crossSkyTail] = y;
                                    _incAddZ[crossSkyTail] = baseZ + z + LIGHT_DIR_DZ[i];
                                    crossSkyTail++;
                                }
                                pendingChunkUpdates.add(nKeys[i]);
                            }
                        }
                    }
                    continue;
                }

                const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
                const nOp = getBlockLightOpacity(getRawBlockId(voxelData[nIdx]));
                if (nOp < 15) {
                    const nextSky = (i === 3 && skyLight === 15) ? (15 - nOp) : (skyLight - (nOp > 1 ? nOp : 1));
                    if (nextSky > ((lightData[nIdx] >> 4) & 15)) {
                        lightData[nIdx] = (nextSky << 4) | (lightData[nIdx] & 15);
                        pushLocal(nIdx);
                    }
                }
            }
        }

        if (crossSkyTail > 0) {
            _runSkyLightAddBFS(0, crossSkyTail, pendingChunkUpdates);
        }

        // PHASE 2: ブロック光 (BlockLight)
        head = 0;
        tail = 0;

        for (let i = 0; i < bSeedCount; i = (i + 1) | 0) {
            const idx = _blockSeedIndices[i];
            const lvl = _blockSeedLevels[i];
            lightData[idx] = (lightData[idx] & 0xF0) | lvl;
            pushLocal(idx);
        }

        let crossBlkTail = 0;
        for (let i = 0; i < 6; i = (i + 1) | 0) {
            const nm = nMaps[i];
            if (!nm) continue;

            for (let s = 0; s < 16; s = (s + 1) | 0) {
                let x = 0, z = 0, nLx = 0, nLz = 0;
                if (i === 0) { x = 15; z = s; nLx = 0; nLz = s; }
                else if (i === 1) { x = 0; z = s; nLx = 15; nLz = s; }
                else if (i === 4) { x = s; z = 15; nLx = s; nLz = 0; }
                else if (i === 5) { x = s; z = 0; nLx = s; nLz = 15; }

                const myCol = (z << 8) | (x << 12);
                const nCol = (nLz << 8) | (nLx << 12);

                for (let y = 0; y < 256; y = (y + 1) | 0) {
                    const nBlk = nm[nCol | y] & 15;
                    if (nBlk <= 1) continue;

                    const idx = myCol | y;
                    const myOp = getBlockLightOpacity(getRawBlockId(voxelData[idx]));
                    if (myOp >= 15) continue;

                    const nextBlk = nBlk - (myOp > 1 ? myOp : 1);
                    if (nextBlk > (lightData[idx] & 15)) {
                        lightData[idx] = (lightData[idx] & 0xF0) | nextBlk;
                        pushLocal(idx);
                    }
                }
            }
        }

        while (head < tail) {
            const idx = queue[head & LIGHT_RING_MASK] | 0;
            head++;
            const blockLight = lightData[idx] & 15;
            if (blockLight <= 1) continue;

            const y = idx & 255;
            const z = (idx >> 8) & 15;
            const x = idx >> 12;

            for (let i = 0; i < 6; i = (i + 1) | 0) {
                if ((i === 2 && y === 255) || (i === 3 && y === 0)) continue;

                const isBorder = (i === 0 && x === 15) || (i === 1 && x === 0) || (i === 4 && z === 15) || (i === 5 && z === 0);
                if (isBorder) {
                    const nm = nMaps[i];
                    const nv = nVoxels[i];
                    if (nm && nv) {
                        const nx = (i === 0) ? 0 : (i === 1) ? 15 : x;
                        const nz = (i === 4) ? 0 : (i === 5) ? 15 : z;
                        const nIdx = (y | (nz << 8) | (nx << 12)) | 0;
                        const nOp = getBlockLightOpacity(getRawBlockId(nv[nIdx]));
                        if (nOp < 15) {
                            const nextBlk = blockLight - (nOp > 1 ? nOp : 1);
                            if (nextBlk > (nm[nIdx] & 15)) {
                                nm[nIdx] = (nm[nIdx] & 0xF0) | nextBlk;
                                if (crossBlkTail < INC_RING_MASK) {
                                    _incAddX[crossBlkTail] = baseX + x + LIGHT_DIR_DX[i];
                                    _incAddY[crossBlkTail] = y;
                                    _incAddZ[crossBlkTail] = baseZ + z + LIGHT_DIR_DZ[i];
                                    crossBlkTail++;
                                }
                                pendingChunkUpdates.add(nKeys[i]);
                            }
                        }
                    }
                    continue;
                }

                const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
                const nOp = getBlockLightOpacity(getRawBlockId(voxelData[nIdx]));
                if (nOp < 15) {
                    const nextBlk = blockLight - (nOp > 1 ? nOp : 1);
                    if (nextBlk > (lightData[nIdx] & 15)) {
                        lightData[nIdx] = (lightData[nIdx] & 0xF0) | nextBlk;
                        pushLocal(nIdx);
                    }
                }
            }
        }

        if (crossBlkTail > 0) {
            _runBlockLightAddBFS(0, crossBlkTail, pendingChunkUpdates);
        }

        return lightData;
    }

    return {
        chunkLightCache,
        getBlockLightOpacity,
        getBlockLightEmission,
        getWorldLightCell,
        updateLightAtBlockChange,
        syncBorderLightFromNeighbors,
        generateChunkLightMap,
        clear() {
            chunkLightCache.clear();
        }
    };
}