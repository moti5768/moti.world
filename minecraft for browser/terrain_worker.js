"use strict";

/* ======================================================
   【基本地形生成 Web Worker】(terrain_worker.js)
   - script.js の generateBaseTerrain / biomes.js と 100% 同一アルゴリズム
   - Three.js / DOM / blocks.js 非依存（メインスレッドから ID・バイオーム定義を注入）
   - 生成済み Uint16Array(65536) を Transferable でゼロコピー返却
   ====================================================== */

const p = new Uint8Array(512);
let currentSeed = 0;

const _seedNoiseOffsets = {
    tempX: 13.7, tempZ: 47.3,
    humX: 91.1, humZ: 157.9,
    contX: 211.3, contZ: 73.9,
    rivX: 181.7, rivZ: 29.3
};

let SEA_LEVEL = 62;
let BLOCK_IDS = null;
let BIOME_LIST = null;

// 9x9 広域ガウス風ブレンディング重み（script.js と完全一致）
const BLEND_RADIUS = 4;
const BLEND_SPAN = BLEND_RADIUS * 2 + 1;
const BLEND_WEIGHTS = new Float32Array(BLEND_SPAN * BLEND_SPAN);
let _totalWeight = 0;
for (let dx = -BLEND_RADIUS; dx <= BLEND_RADIUS; dx++) {
    for (let dz = -BLEND_RADIUS; dz <= BLEND_RADIUS; dz++) {
        const idx = (dx + BLEND_RADIUS) * BLEND_SPAN + (dz + BLEND_RADIUS);
        const w = 1.0 / (1.0 + 0.35 * (dx * dx + dz * dz));
        BLEND_WEIGHTS[idx] = w;
        _totalWeight += w;
    }
}
const INV_TOTAL_WEIGHT = 1.0 / _totalWeight;

const CAVE_SCALE_XZ = 0.02;
const CAVE_SCALE_Y = 0.025;
const CAVE_THRESHOLD = 0.08;
const OFF_X = 1234 * CAVE_SCALE_XZ;
const OFF_Y = 5678 * CAVE_SCALE_Y;
const OFF_Z = 9101 * CAVE_SCALE_XZ;

const _paddedBiomeMap = new Uint8Array(576);
const _paddedHMap = new Float32Array(576);
const _biomeSampleOut = { biome: null, continentalness: 0.5, riverValue: 0.5 };

function applySeed(seedNum) {
    currentSeed = seedNum >>> 0;
    let s = currentSeed;
    const nextRand = () => {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
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

    _seedNoiseOffsets.tempX = nextRand() * 256;
    _seedNoiseOffsets.tempZ = nextRand() * 256;
    _seedNoiseOffsets.humX = nextRand() * 256;
    _seedNoiseOffsets.humZ = nextRand() * 256;
    _seedNoiseOffsets.contX = nextRand() * 256;
    _seedNoiseOffsets.contZ = nextRand() * 256;
    _seedNoiseOffsets.rivX = nextRand() * 256;
    _seedNoiseOffsets.rivZ = nextRand() * 256;
}

function fade(t) {
    const t3 = t * t * t;
    return t3 * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
    return a + t * (b - a);
}

function grad2D(hash, x, y) {
    const v = (hash & 1) === 0 ? x : y;
    const u = (hash & 2) === 0 ? y : x;
    return (((hash & 4) === 0 ? -v : v) + ((hash & 8) === 0 ? -2.0 * u : 2.0 * u));
}

function perlinNoise2D(x, y) {
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

function fractalNoise2D(x, z, octaves = 4, persistence = 0.5) {
    const nOct = octaves | 0;
    let total = 0.0;
    let amp = 1.0;
    let f = 1.0;
    let maxA = 0.0;

    for (let i = 0; i < nOct; i++) {
        total += perlinNoise2D(x * f, z * f) * amp;
        maxA += amp;
        amp *= persistence;
        f *= 2.0;
    }
    return total / maxA;
}

function grad3D(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function perlinNoise3D(x, y, z) {
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

function _clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
}

function _smoothstep(edge0, edge1, x) {
    const t = _clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function determineBiome(temp, humidity, continentalness, riverValue) {
    const riverDist = riverValue >= 0.5 ? (riverValue - 0.5) : (0.5 - riverValue);
    if (riverDist < 0.042 && continentalness < 0.72) return BIOME_LIST[5]; // RIVER
    if (continentalness > 0.66) return BIOME_LIST[4]; // MOUNTAINS
    if (temp < 0.32) return BIOME_LIST[1]; // SNOWY_TUNDRA
    if (temp > 0.64 && humidity < 0.38) return BIOME_LIST[3]; // DESERT
    if (humidity > 0.52) return BIOME_LIST[2]; // FOREST
    return BIOME_LIST[0]; // PLAINS
}

function _sampleBiomeAndParams(wx, wz, out = _biomeSampleOut) {
    const nTemp = fractalNoise2D(wx * 0.0006 + _seedNoiseOffsets.tempX, wz * 0.0006 + _seedNoiseOffsets.tempZ, 3);
    const nHum = fractalNoise2D(wx * 0.0006 + _seedNoiseOffsets.humX, wz * 0.0006 + _seedNoiseOffsets.humZ, 3);
    const nCont = fractalNoise2D(wx * 0.0008 + _seedNoiseOffsets.contX, wz * 0.0008 + _seedNoiseOffsets.contZ, 3);
    const nRiv = fractalNoise2D(wx * 0.0035 + _seedNoiseOffsets.rivX, wz * 0.0035 + _seedNoiseOffsets.rivZ, 2);

    const temp = _clamp01(0.5 + nTemp * 1.35);
    const humidity = _clamp01(0.5 + nHum * 1.35);
    const continentalness = _clamp01(0.5 + nCont * 1.35);
    const riverValue = _clamp01(0.5 + nRiv * 1.25);

    out.biome = determineBiome(temp, humidity, continentalness, riverValue);
    out.continentalness = continentalness;
    out.riverValue = riverValue;
    return out;
}

function _computeRawHeightFromSample(wx, wz, biome, continentalness, riverValue) {
    const nNoise = fractalNoise2D(wx * biome.noiseScale, wz * biome.noiseScale, 5);
    let h = biome.baseHeight + (nNoise * biome.heightVariation);

    if (continentalness > 0.62) {
        const mFactor = _smoothstep(0.62, 0.92, continentalness);
        h += mFactor * 26.0;
    }

    if (continentalness < 0.72) {
        const riverDist = Math.abs(riverValue - 0.5);
        if (riverDist < 0.085) {
            const bankBlend = _smoothstep(0.018, 0.085, riverDist);
            const riverBedY = 55.5 + nNoise * 1.5;
            h = riverBedY + (h - riverBedY) * bankBlend;
        }
    }

    return h;
}

function isCave(y, surfaceHeight, nx, ny, nz) {
    const depth = (surfaceHeight - y) | 0;
    if (depth <= 0) return false;

    let currentThreshold = CAVE_THRESHOLD;
    if (depth < 5) {
        currentThreshold *= (depth * 0.16 + 0.6);
    }

    const n1 = perlinNoise3D(nx, ny, nz);
    if (n1 >= currentThreshold || n1 <= -currentThreshold) return false;

    const absN1 = n1 < 0 ? -n1 : n1;
    const remaining = currentThreshold - absN1;
    const n2 = perlinNoise3D(nx + OFF_X, ny + OFF_Y, nz + OFF_Z);

    return n2 < remaining && n2 > -remaining;
}

function generateBaseTerrainBuffer(cx, cz) {
    const data = new Uint16Array(65536);
    const baseX = (cx << 4) | 0;
    const baseZ = (cz << 4) | 0;

    const {
        SKY, STONE, WATER, LAVA, BEDROCK, GRAVEL,
        COAL_ORE, IRON_ORE, GOLD_ORE, REDSTONE_ORE, LAPIS_ORE, EMERALD_ORE
    } = BLOCK_IDS;
    const MOUNTAINS_ID = 4;
    const seaLevel = SEA_LEVEL | 0;

    const blendRadius = BLEND_RADIUS | 0;
    const paddedSize = 24 | 0;
    const start = -blendRadius;
    const end = 16 + blendRadius;

    for (let x = start, xOff = 0; x < end; x++, xOff += paddedSize) {
        const worldX = (baseX + x) | 0;
        for (let z = start; z < end; z++) {
            const worldZ = (baseZ + z) | 0;
            const localIdx = (xOff + (z + blendRadius)) | 0;
            const s = _sampleBiomeAndParams(worldX, worldZ);
            _paddedBiomeMap[localIdx] = s.biome.id;
            _paddedHMap[localIdx] = _computeRawHeightFromSample(
                worldX, worldZ, s.biome, s.continentalness, s.riverValue
            );
        }
    }

    const scaleXZ = CAVE_SCALE_XZ;
    const scaleY = CAVE_SCALE_Y;
    const seedMix = currentSeed | 0;

    for (let x = 0; x < 16; x = (x + 1) | 0) {
        const worldX = (baseX + x) | 0;
        const nx = worldX * scaleXZ;
        const xOff = (x << 12) | 0;

        for (let z = 0; z < 16; z = (z + 1) | 0) {
            const worldZ = (baseZ + z) | 0;
            const nz = worldZ * scaleXZ;
            const xzOff = (xOff | (z << 8)) | 0;

            const currentBiomeId = _paddedBiomeMap[(x + blendRadius) * paddedSize + (z + blendRadius)];
            const biome = BIOME_LIST[currentBiomeId];
            const isMountainBiome = (currentBiomeId === MOUNTAINS_ID);

            let totalHeight = 0.0;
            let weightIdx = 0;
            for (let dx = -blendRadius; dx <= blendRadius; dx = (dx + 1) | 0) {
                const xShift = ((x + dx + blendRadius) * paddedSize) | 0;
                for (let dz = -blendRadius; dz <= blendRadius; dz = (dz + 1) | 0) {
                    totalHeight += _paddedHMap[xShift + ((z + dz + blendRadius) | 0)] * BLEND_WEIGHTS[weightIdx++];
                }
            }
            const sHeight = (totalHeight * INV_TOTAL_WEIGHT) | 0;

            const filler = biome.fillerBlock | 0;
            const top = biome.topBlock | 0;
            const dirtEnd = (sHeight - 1) | 0;
            let stoneEnd = (sHeight - 4) | 0;
            if (stoneEnd < 1) stoneEnd = 1;

            data[xzOff] = BEDROCK;

            let colHash = (Math.imul(worldX, 374761393) ^ Math.imul(worldZ, 668265263) ^ seedMix) | 0;
            colHash = (Math.imul(colHash ^ (colHash >>> 13), 1274126177)) >>> 0;
            const bedrockTopY = 1 + (colHash & 3);

            const maxY = sHeight > seaLevel ? sHeight : seaLevel;

            for (let y = 1; y <= maxY; y = (y + 1) | 0) {
                const idx = (xzOff + y) | 0;

                if (y < sHeight) {
                    if (y <= bedrockTopY) {
                        data[idx] = BEDROCK;
                        continue;
                    }

                    const caveMaxY = (sHeight <= seaLevel) ? (sHeight - 3) : sHeight;
                    if (y >= 5 && y < caveMaxY && isCave(y, sHeight, nx, y * scaleY, nz)) {
                        data[idx] = (y <= 11) ? LAVA : SKY;
                        continue;
                    }

                    if (y >= stoneEnd) {
                        data[idx] = (y === dirtEnd && dirtEnd >= seaLevel) ? top : filler;
                        continue;
                    }

                    let h3 = (colHash ^ Math.imul(y, 2246822519)) | 0;
                    h3 = (Math.imul(h3 ^ (h3 >>> 16), 3266489917)) >>> 0;
                    const roll = h3 & 1023;

                    let blockToPlace = STONE;
                    if (y <= 16 && roll < 10) {
                        blockToPlace = REDSTONE_ORE;
                    } else if (y <= 32 && roll >= 10 && roll < 16) {
                        blockToPlace = GOLD_ORE;
                    } else if (y >= 10 && y <= 32 && roll >= 16 && roll < 21) {
                        blockToPlace = LAPIS_ORE;
                    } else if (isMountainBiome && y <= 32 && roll >= 21 && roll < 25) {
                        blockToPlace = EMERALD_ORE;
                    } else if (y <= 64 && roll >= 25 && roll < 43) {
                        blockToPlace = IRON_ORE;
                    } else if (y <= 128 && roll >= 43 && roll < 67) {
                        blockToPlace = COAL_ORE;
                    } else if (y <= 60 && roll >= 67 && roll < 83) {
                        blockToPlace = GRAVEL;
                    }

                    data[idx] = blockToPlace;
                } else if (y >= sHeight && y <= seaLevel) {
                    data[idx] = WATER;
                }
            }
        }
    }

    return data;
}

self.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === "init") {
        SEA_LEVEL = msg.seaLevel | 0;
        BLOCK_IDS = msg.blockIds;
        BIOME_LIST = msg.biomes;
        applySeed(msg.seed);
        return;
    }

    if (msg.type === "generate") {
        if (!BLOCK_IDS || !BIOME_LIST) return;
        const data = generateBaseTerrainBuffer(msg.cx | 0, msg.cz | 0);
        self.postMessage({
            type: "chunk",
            gen: msg.gen,
            key: msg.key,
            cx: msg.cx | 0,
            cz: msg.cz | 0,
            isPrimary: !!msg.isPrimary,
            buffer: data.buffer
        }, [data.buffer]);
    }
};