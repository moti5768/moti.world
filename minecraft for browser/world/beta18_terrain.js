"use strict";
import { createBeta18BiomeGenerator, BETA18_IDS } from '../biomes/beta18_genlayer.js';

/* ======================================================
   【Minecraft Beta 1.8 準拠 3D密度地形エンジン】(world/beta18_terrain.js)
   - ChunkProviderGenerate 準拠: 5x17x5 密度グリッド + 4x8x4 トリリニア補間
   - 5x5 パラボリック重み (10 / sqrt(dx^2 + dz^2 + 0.2)) によるバイオーム高度ブレンド
   - Extreme Hills の雄大な丘陵・絶壁・オーバーハングと、なだらかな平原・浅瀬湿地・深海を両立
   - replaceBlocksForBiome 準拠の表土置換（上向き面は草・土、絶壁や天井は石が自然露出）
   - メインスレッド(script.js) / Web Worker(terrain_worker.js) 100% 共有
   ====================================================== */

// 5x5 パラボリック重みテーブル（本家 Beta 1.8 parabolicField 準拠）
const PARABOLIC_WEIGHTS = new Float32Array(25);
for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
        PARABOLIC_WEIGHTS[(dx + 2) * 5 + (dz + 2)] = 10.0 / Math.sqrt(dx * dx + dz * dz + 0.2);
    }
}

const CAVE_SCALE_XZ = 0.02;
const CAVE_SCALE_Y = 0.025;
const CAVE_THRESHOLD = 0.08;
const OFF_X = 1234 * CAVE_SCALE_XZ;
const OFF_Y = 5678 * CAVE_SCALE_Y;
const OFF_Z = 9101 * CAVE_SCALE_XZ;

const D_SX = 5;
const D_SY = 17; // 0..16 -> Y=0..128 (8ブロック間隔)
const D_SZ = 5;

function fade(t) {
    const t3 = t * t * t;
    return t3 * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
    return a + t * (b - a);
}

function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function grad2D(hash, x, y) {
    const v = (hash & 1) === 0 ? x : y;
    const u = (hash & 2) === 0 ? y : x;
    return (((hash & 4) === 0 ? -v : v) + ((hash & 8) === 0 ? -2.0 * u : 2.0 * u));
}

function grad3D(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

export function createBeta18TerrainEngine() {
    const p = new Uint8Array(512);
    const biomeGen = createBeta18BiomeGenerator(0, 4);
    const densityGrid = new Float32Array(D_SX * D_SY * D_SZ);
    const colTopYMap = new Int16Array(256);
    let currentSeed = 0;

    function perlin2D(x, y) {
        const xi = x >= 0 ? (x | 0) : (x === (x | 0) ? (x | 0) : (x | 0) - 1);
        const yi = y >= 0 ? (y | 0) : (y === (y | 0) ? (y | 0) : (y | 0) - 1);

        const X = xi & 255;
        const Y = yi & 255;
        const xf = x - xi;
        const yf = y - yi;
        const u = fade(xf);
        const v = fade(yf);

        const aa = p[p[X] + Y];
        const ab = p[p[X] + Y + 1];
        const ba = p[p[X + 1] + Y];
        const bb = p[p[X + 1] + Y + 1];

        return lerp(
            lerp(grad2D(aa, xf, yf), grad2D(ba, xf - 1, yf), u),
            lerp(grad2D(ab, xf, yf - 1), grad2D(bb, xf - 1, yf - 1), u),
            v
        );
    }

    function fractal2D(x, z, octaves = 3, persistence = 0.5) {
        let total = 0.0;
        let amp = 1.0;
        let f = 1.0;
        let maxA = 0.0;
        for (let i = 0; i < octaves; i++) {
            total += perlin2D(x * f, z * f) * amp;
            maxA += amp;
            amp *= persistence;
            f *= 2.0;
        }
        return total / maxA;
    }

    function perlin3D(x, y, z) {
        const xi = x >= 0 ? (x | 0) : (x === (x | 0) ? (x | 0) : (x | 0) - 1);
        const yi = y >= 0 ? (y | 0) : (y === (y | 0) ? (y | 0) : (y | 0) - 1);
        const zi = z >= 0 ? (z | 0) : (z === (z | 0) ? (z | 0) : (z | 0) - 1);

        const X = xi & 255;
        const Y = yi & 255;
        const Z = zi & 255;
        const xf = x - xi;
        const yf = y - yi;
        const zf = z - zi;

        const u = fade(xf);
        const v = fade(yf);
        const w = fade(zf);
        const xf1 = xf - 1;
        const yf1 = yf - 1;
        const zf1 = zf - 1;

        const A = (p[X] + Y) & 255;
        const AA = (p[A] + Z) & 255;
        const AB = (p[A + 1] + Z) & 255;
        const B = (p[X + 1] + Y) & 255;
        const BA = (p[B] + Z) & 255;
        const BB = (p[B + 1] + Z) & 255;

        return lerp(
            lerp(
                lerp(grad3D(p[AA], xf, yf, zf), grad3D(p[BA], xf1, yf, zf), u),
                lerp(grad3D(p[AB], xf, yf1, zf), grad3D(p[BB], xf1, yf1, zf), u),
                v
            ),
            lerp(
                lerp(grad3D(p[AA + 1], xf, yf, zf1), grad3D(p[BA + 1], xf1, yf, zf1), u),
                lerp(grad3D(p[AB + 1], xf, yf1, zf1), grad3D(p[BB + 1], xf1, yf1, zf1), u),
                v
            ),
            w
        );
    }

    function fractal3D(x, y, z, octaves = 3, persistence = 0.5) {
        let total = 0.0;
        let amp = 1.0;
        let f = 1.0;
        let maxA = 0.0;
        for (let i = 0; i < octaves; i++) {
            total += perlin3D(x * f, y * f, z * f) * amp;
            maxA += amp;
            amp *= persistence;
            f *= 2.0;
        }
        return total / maxA;
    }

    function isCave(y, surfaceHeight, nx, ny, nz) {
        const depth = (surfaceHeight - y) | 0;
        if (depth <= 0) return false;

        let currentThreshold = CAVE_THRESHOLD;
        if (depth < 5) {
            currentThreshold *= (depth * 0.16 + 0.6);
        }

        const n1 = perlin3D(nx, ny, nz);
        if (n1 >= currentThreshold || n1 <= -currentThreshold) return false;

        const absN1 = n1 < 0 ? -n1 : n1;
        const remaining = currentThreshold - absN1;
        const n2 = perlin3D(nx + OFF_X, ny + OFF_Y, nz + OFF_Z);

        return n2 < remaining && n2 > -remaining;
    }

    function setSeed(seedNum) {
        currentSeed = seedNum >>> 0;
        let s = currentSeed;
        const nextRand = () => {
            s |= 0;
            s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        const base = new Uint8Array(256);
        for (let i = 0; i < 256; i++) base[i] = i;
        for (let i = 255; i > 0; i--) {
            const j = (nextRand() * (i + 1)) | 0;
            const tmp = base[i];
            base[i] = base[j];
            base[j] = tmp;
        }
        for (let i = 0; i < 256; i++) {
            p[i] = p[i + 256] = base[i];
        }

        biomeGen.setSeed(currentSeed);
    }

    function getBiomeIdAt(wx, wz) {
        return biomeGen.getBiomeIdAt(wx, wz);
    }

    function getBiomeArea(areaX, areaZ, areaW, areaH) {
        return biomeGen.getArea(areaX, areaZ, areaW, areaH);
    }

    function getApproxHeightAt(wx, wz, biomeList) {
        const bId = biomeGen.getBiomeIdAt(wx, wz);
        const b = biomeList[bId] || biomeList[0];
        const minH = b.minHeight !== undefined ? b.minHeight : 0.12;
        const maxH = b.maxHeight !== undefined ? b.maxHeight : 0.25;
        const n = fractal2D(wx * 0.01, wz * 0.01, 3);
        return (63.0 + minH * 17.0 + n * maxH * 14.0) | 0;
    }

    /**
     * 16x256x16 チャンクの基本地形（3D密度地形＋表土置換＋洞窟＋岩盤＋鉱石）を一括生成
     */
    function generateChunkBaseTerrain(cx, cz, outData, seaLevel, blockIds, biomeList) {
        outData.fill(0);

        const baseX = (cx << 4) | 0;
        const baseZ = (cz << 4) | 0;
        const {
            SKY, STONE, DIRT, SAND, SANDSTONE, WATER, LAVA, BEDROCK, GRAVEL,
            COAL_ORE, IRON_ORE, GOLD_ORE, REDSTONE_ORE, LAPIS_ORE, EMERALD_ORE
        } = blockIds;

        // 1. 33x33 領域の Beta 1.8 バイオームIDを一括取得（5x5パラボリック補間と内部16x16参照を共有）
        const areaBiomes = biomeGen.getArea(baseX - 8, baseZ - 8, 33, 33);

        // 2. 5x17x5 3D密度グリッドの計算（本家 Beta 1.8 initializeNoiseField 準拠）
        for (let gx = 0; gx < D_SX; gx++) {
            const wx = baseX + (gx << 2);
            for (let gz = 0; gz < D_SZ; gz++) {
                const wz = baseZ + (gz << 2);

                const centerBiomeId = areaBiomes[(gz * 4 + 8) * 33 + (gx * 4 + 8)];
                const centerBiome = biomeList[centerBiomeId] || biomeList[0];
                const centerMin = centerBiome.minHeight;

                // 5x5 パラボリック重み付きバイオーム高度ブレンディング（高い山が海を不自然に引き上げない本家補正付き）
                let wSum = 0.0;
                let minSum = 0.0;
                let maxSum = 0.0;
                let wIdx = 0;

                for (let dx = -2; dx <= 2; dx++) {
                    const ax = (gx + dx) * 4 + 8;
                    for (let dz = -2; dz <= 2; dz++) {
                        const az = (gz + dz) * 4 + 8;
                        const nb = biomeList[areaBiomes[az * 33 + ax]] || biomeList[0];
                        let w = PARABOLIC_WEIGHTS[wIdx++] / (nb.minHeight + 2.0);
                        if (nb.minHeight > centerMin) w *= 0.5;
                        minSum += nb.minHeight * w;
                        maxSum += nb.maxHeight * w;
                        wSum += w;
                    }
                }

                const blendedMin = minSum / wSum;
                const blendedMax = maxSum / wSum;

                // 低周波の地形うねり（depthNoise）
                const depthNoise = fractal2D(wx * 0.0032 + 31.7, wz * 0.0032 + 89.1, 2);
                const baseY = 63.0 + blendedMin * 17.0 + depthNoise * (2.5 + blendedMax * 8.0);
                const ampScale = 3.6 + blendedMax * 16.5;

                const colBase = (gx * D_SZ + gz) * D_SY;

                for (let gy = 0; gy < D_SY; gy++) {
                    const wy = gy << 3; // 0, 8, 16, ..., 128

                    // 本家 Beta 1.8 の 3D セレクター（大地形 low + 細部崖 high を selector で補間）
                    const nLow = fractal3D(wx * 0.011, wy * 0.020, wz * 0.011, 3);
                    const nHigh = fractal3D(wx * 0.023 + 113.5, wy * 0.032, wz * 0.023 + 227.3, 3);
                    const nSel = clamp01(0.5 + perlin3D(wx * 0.0075 + 53.1, wy * 0.015, wz * 0.0075 + 79.7) * 1.45);
                    const terrainNoise = lerp(nLow, nHigh, nSel);

                    const dy = wy - baseY;
                    let falloff = dy / ampScale;
                    // 基準高度より下側は密度を強く保ち、上側の Extreme Hills ではオーバーハングを形成
                    if (dy < 0) falloff *= 2.3;

                    let density = terrainNoise * 1.65 - falloff;

                    // 天井（Y=112..128）で滑らかに空へ収束、最下層（Y=0..8）は必ず固体
                    if (gy > 13) {
                        const topT = (gy - 13) / 3.0;
                        density = density * (1.0 - topT) - 10.0 * topT;
                    } else if (gy === 0) {
                        density += 12.0;
                    }

                    densityGrid[colBase + gy] = density;
                }
            }
        }

        // 3. 4x8x4 トリリニア補間による STONE / WATER / SKY の一括充填
        const invX = 0.25;
        const invY = 0.125;
        const invZ = 0.25;

        for (let gx = 0; gx < 4; gx++) {
            const xBase = gx << 2;
            for (let gz = 0; gz < 4; gz++) {
                const zBase = gz << 2;
                const c00 = (gx * D_SZ + gz) * D_SY;
                const c01 = (gx * D_SZ + (gz + 1)) * D_SY;
                const c10 = ((gx + 1) * D_SZ + gz) * D_SY;
                const c11 = ((gx + 1) * D_SZ + (gz + 1)) * D_SY;

                for (let gy = 0; gy < 16; gy++) {
                    const yBase = gy << 3;
                    let d00 = densityGrid[c00 + gy];
                    let d01 = densityGrid[c01 + gy];
                    let d10 = densityGrid[c10 + gy];
                    let d11 = densityGrid[c11 + gy];

                    const stepY00 = (densityGrid[c00 + gy + 1] - d00) * invY;
                    const stepY01 = (densityGrid[c01 + gy + 1] - d01) * invY;
                    const stepY10 = (densityGrid[c10 + gy + 1] - d10) * invY;
                    const stepY11 = (densityGrid[c11 + gy + 1] - d11) * invY;

                    for (let ly = 0; ly < 8; ly++) {
                        const y = yBase + ly;
                        let dx0 = d00;
                        let dx1 = d01;
                        const stepX0 = (d10 - d00) * invX;
                        const stepX1 = (d11 - d01) * invX;

                        for (let lx = 0; lx < 4; lx++) {
                            const xOff = ((xBase + lx) << 12) | y;
                            let val = dx0;
                            const stepZ = (dx1 - dx0) * invZ;

                            for (let lz = 0; lz < 4; lz++) {
                                const idx = xOff | ((zBase + lz) << 8);
                                if (val > 0.0) {
                                    outData[idx] = STONE;
                                } else if (y <= seaLevel) {
                                    outData[idx] = WATER;
                                }
                                val += stepZ;
                            }
                            dx0 += stepX0;
                            dx1 += stepX1;
                        }
                        d00 += stepY00;
                        d01 += stepY01;
                        d10 += stepY10;
                        d11 += stepY11;
                    }
                }
            }
        }

        // 4. Beta 1.8 準拠 replaceBlocksForBiome（上から走査して草・土・砂・砂岩・海底を貼る）
        const seedMix = currentSeed | 0;
        const scaleXZ = CAVE_SCALE_XZ;
        const scaleY = CAVE_SCALE_Y;

        for (let x = 0; x < 16; x = (x + 1) | 0) {
            const worldX = (baseX + x) | 0;
            const nx = worldX * scaleXZ;
            const xOff = (x << 12) | 0;
            const xMap = (x << 4) | 0;

            for (let z = 0; z < 16; z = (z + 1) | 0) {
                const worldZ = (baseZ + z) | 0;
                const nz = worldZ * scaleXZ;
                const xzOff = (xOff | (z << 8)) | 0;

                const bId = areaBiomes[(z + 8) * 33 + (x + 8)];
                const biome = biomeList[bId] || biomeList[0];
                const isDesert = (bId === BETA18_IDS.DESERT);
                const isMountain = (bId === BETA18_IDS.EXTREME_HILLS);
                const isOceanOrRiver = (bId === BETA18_IDS.OCEAN || bId === BETA18_IDS.RIVER);

                let colHash = (Math.imul(worldX, 374761393) ^ Math.imul(worldZ, 668265263) ^ seedMix) | 0;
                colHash = (Math.imul(colHash ^ (colHash >>> 13), 1274126177)) >>> 0;
                const bedrockTopY = 1 + (colHash & 3);
                const surfDepth = 3 + ((colHash >>> 4) & 1); // 3〜4マスの表土層

                const topBlock = biome.topBlock | 0;
                const fillerBlock = biome.fillerBlock | 0;

                let runDepth = -1;
                let sandstoneRemain = 0;
                let topSolidY = 0;

                for (let y = 127; y >= 1; y = (y - 1) | 0) {
                    const idx = (xzOff | y) | 0;
                    const cur = outData[idx];

                    if (cur === SKY || cur === WATER) {
                        runDepth = -1;
                        sandstoneRemain = 0;
                        continue;
                    }

                    if (cur === STONE) {
                        if (topSolidY === 0) topSolidY = y;

                        if (runDepth === -1) {
                            runDepth = surfDepth;
                            const above = outData[(xzOff | (y + 1)) | 0];
                            if (y >= seaLevel - 1 && above === SKY) {
                                // 水辺の浅い岸（Y=62付近）は砂浜が少し出ると自然
                                outData[idx] = topBlock;
                            } else {
                                // 水底は砂または土（Ocean は砂地、川底は土／砂）
                                outData[idx] = isOceanOrRiver ? (((colHash >>> 8) & 3) === 0 ? DIRT : SAND) : fillerBlock;
                            }
                        } else if (runDepth > 0) {
                            runDepth--;
                            outData[idx] = fillerBlock;
                            if (runDepth === 0 && isDesert) {
                                sandstoneRemain = 2 + ((colHash >>> 10) & 2);
                            }
                        } else if (sandstoneRemain > 0) {
                            sandstoneRemain--;
                            outData[idx] = SANDSTONE;
                        }
                    }
                }

                colTopYMap[xMap | z] = topSolidY;

                // 5. 岩盤層 (Y=0..4)・洞窟カービング・7種鉱石＆砂利ポケット
                outData[xzOff] = BEDROCK;
                const caveMaxY = (topSolidY <= seaLevel) ? (topSolidY - 3) : topSolidY;

                for (let y = 1; y <= topSolidY; y = (y + 1) | 0) {
                    const idx = (xzOff | y) | 0;

                    if (y <= bedrockTopY) {
                        outData[idx] = BEDROCK;
                        continue;
                    }

                    if (y >= 5 && y < caveMaxY && isCave(y, topSolidY, nx, y * scaleY, nz)) {
                        outData[idx] = (y <= 11) ? LAVA : SKY;
                        continue;
                    }

                    if (outData[idx] !== STONE) continue;

                    let h3 = (colHash ^ Math.imul(y, 2246822519)) | 0;
                    h3 = (Math.imul(h3 ^ (h3 >>> 16), 3266489917)) >>> 0;
                    const roll = h3 & 1023;

                    if (y <= 16 && roll < 10) {
                        outData[idx] = REDSTONE_ORE;
                    } else if (y <= 32 && roll >= 10 && roll < 16) {
                        outData[idx] = GOLD_ORE;
                    } else if (y >= 10 && y <= 32 && roll >= 16 && roll < 21) {
                        outData[idx] = LAPIS_ORE;
                    } else if (isMountain && y <= 32 && roll >= 21 && roll < 25) {
                        outData[idx] = EMERALD_ORE;
                    } else if (y <= 64 && roll >= 25 && roll < 43) {
                        outData[idx] = IRON_ORE;
                    } else if (y <= 128 && roll >= 43 && roll < 67) {
                        outData[idx] = COAL_ORE;
                    } else if (y <= 60 && roll >= 67 && roll < 83) {
                        outData[idx] = GRAVEL;
                    }
                }
            }
        }

        return outData;
    }

    return {
        setSeed,
        getBiomeIdAt,
        getBiomeArea,
        getApproxHeightAt,
        generateChunkBaseTerrain
    };
}