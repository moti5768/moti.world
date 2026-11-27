"use strict";

/* ======================================================
   【新規チャンク初期ライト計算 Web Worker】(world/light_worker.js)
   - メインスレッドを止めずに 16x256x16 (65,536セル) の SkyLight / BlockLight を計算
   - Transferable (ゼロコピー転送) で Uint8Array ライトマップを返却
   ====================================================== */

const CS = 16;
const CH = 256;
const CS_CH = CS * CH;            // 4096
const TOTAL_CELLS = CS * CH * CS; // 65536
const MOVE_OFFSETS = new Int32Array([CS_CH, -CS_CH, 1, -1, CH, -CH]);

const LIGHT_RING_SIZE = 131072;
const LIGHT_RING_MASK = LIGHT_RING_SIZE - 1;
const _sharedQueue = new Int32Array(LIGHT_RING_SIZE);
const _blockSeedIndices = new Int32Array(4096);
const _blockSeedLevels = new Uint8Array(4096);

let opacityByRaw = null;
let emissionByRaw = null;

function computeInitialLightMap(voxelData) {
    const lightData = new Uint8Array(TOTAL_CELLS);
    if (!opacityByRaw || !emissionByRaw || voxelData.length < TOTAL_CELLS) {
        return lightData;
    }

    const queue = _sharedQueue;
    let head = 0;
    let tail = 0;

    const pushLocal = (idx) => {
        if ((tail - head) < LIGHT_RING_MASK) {
            queue[tail & LIGHT_RING_MASK] = idx;
            tail++;
        }
    };

    // ======================================================
    // PHASE 1: 天空光 (SkyLight) ＋ 発光ブロック同時収集
    // ======================================================
    let chunkMaxAttenY = -1;
    let bSeedCount = 0;

    // 1-A: 直射日光 15 の垂直降下
    for (let x = 0; x < 16; x = (x + 1) | 0) {
        const xBase = (x << 12) | 0;
        for (let z = 0; z < 16; z = (z + 1) | 0) {
            const xzBase = (xBase | (z << 8)) | 0;
            let directSun = true;

            for (let y = 255; y >= 0; y = (y - 1) | 0) {
                const idx = (xzBase | y) | 0;
                const raw = voxelData[idx];

                if (raw !== 0) {
                    const emit = emissionByRaw[raw];
                    if (emit > 0 && bSeedCount < 4096) {
                        _blockSeedIndices[bSeedCount] = idx;
                        _blockSeedLevels[bSeedCount] = emit;
                        bSeedCount++;
                    }
                }

                if (directSun) {
                    const opacity = opacityByRaw[raw];
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

    // 1-A2: ハイトマップ境界シード抽出（空中の完全直射層をスキップ）
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
                    if (x < 15 && ((lightData[idx + CS_CH] >> 4) & 15) < sky - 1 && opacityByRaw[voxelData[idx + CS_CH]] < 15) needSpread = true;
                    else if (x > 0 && ((lightData[idx - CS_CH] >> 4) & 15) < sky - 1 && opacityByRaw[voxelData[idx - CS_CH]] < 15) needSpread = true;
                    else if (z < 15 && ((lightData[idx + CH] >> 4) & 15) < sky - 1 && opacityByRaw[voxelData[idx + CH]] < 15) needSpread = true;
                    else if (z > 0 && ((lightData[idx - CH] >> 4) & 15) < sky - 1 && opacityByRaw[voxelData[idx - CH]] < 15) needSpread = true;
                    else if (y > 0 && ((lightData[idx - 1] >> 4) & 15) < sky - 1 && opacityByRaw[voxelData[idx - 1]] < 15) needSpread = true;
                    else if (y < 255 && ((lightData[idx + 1] >> 4) & 15) < sky - 1 && opacityByRaw[voxelData[idx + 1]] < 15) needSpread = true;

                    if (needSpread) pushLocal(idx);
                }
            }
        }
    }

    // 1-C: チャンク内部 天空光 BFS
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
            if ((i === 0 && x === 15) || (i === 1 && x === 0) || (i === 4 && z === 15) || (i === 5 && z === 0)) continue;

            const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
            const nOp = opacityByRaw[voxelData[nIdx]];
            if (nOp < 15) {
                const nextSky = (i === 3 && skyLight === 15) ? (15 - nOp) : (skyLight - (nOp > 1 ? nOp : 1));
                if (nextSky > ((lightData[nIdx] >> 4) & 15)) {
                    lightData[nIdx] = (nextSky << 4) | (lightData[nIdx] & 15);
                    pushLocal(nIdx);
                }
            }
        }
    }

    // ======================================================
    // PHASE 2: ブロック光 (BlockLight)
    // ======================================================
    head = 0;
    tail = 0;

    for (let i = 0; i < bSeedCount; i = (i + 1) | 0) {
        const idx = _blockSeedIndices[i];
        const lvl = _blockSeedLevels[i];
        lightData[idx] = (lightData[idx] & 0xF0) | lvl;
        pushLocal(idx);
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
            if ((i === 0 && x === 15) || (i === 1 && x === 0) || (i === 4 && z === 15) || (i === 5 && z === 0)) continue;

            const nIdx = (idx + MOVE_OFFSETS[i]) | 0;
            const nOp = opacityByRaw[voxelData[nIdx]];
            if (nOp < 15) {
                const nextBlk = blockLight - (nOp > 1 ? nOp : 1);
                if (nextBlk > (lightData[nIdx] & 15)) {
                    lightData[nIdx] = (lightData[nIdx] & 0xF0) | nextBlk;
                    pushLocal(nIdx);
                }
            }
        }
    }

    return lightData;
}

self.onmessage = function (e) {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === "init") {
        opacityByRaw = new Uint8Array(msg.opacityByRaw);
        emissionByRaw = new Uint8Array(msg.emissionByRaw);
        return;
    }

    if (msg.type === "compute") {
        const voxelData = new Uint16Array(msg.voxelBuffer);
        const lightData = computeInitialLightMap(voxelData);
        self.postMessage(
            {
                type: "light",
                gen: msg.gen,
                reqId: msg.reqId,
                key: msg.key,
                cx: msg.cx,
                cz: msg.cz,
                buffer: lightData.buffer
            },
            [lightData.buffer]
        );
    }
};