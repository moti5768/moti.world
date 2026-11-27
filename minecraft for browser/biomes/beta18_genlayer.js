"use strict";

/* ======================================================
   【Minecraft Beta 1.8 準拠 GenLayer バイオーム分布エンジン】
   (biomes/beta18_genlayer.js)
   - 本家 Beta 1.8 (Adventure Update) の GenLayer パイプラインを忠実再現
   - 構成: Ocean / Plains / Desert / Extreme Hills / Forest / Taiga / Swampland / River
   - 大陸形成 → バイオーム割当 → 6段ズーム → 領域境界の川生成 → Smooth → Voronoi 4倍補間
   - メインスレッド(script.js) / Web Worker(terrain_worker.js) 共通 ES モジュール
   ====================================================== */

// 既存ワールド・feature_rules.js 互換のバイオームID定義
export const BETA18_IDS = Object.freeze({
    PLAINS: 0,
    TAIGA: 1,         // 旧 SNOWY_TUNDRA 互換枠
    FOREST: 2,
    DESERT: 3,
    EXTREME_HILLS: 4, // 旧 MOUNTAINS 互換枠
    RIVER: 5,
    OCEAN: 6,
    SWAMPLAND: 7
});

const LAND_BIOMES = new Int32Array([
    BETA18_IDS.DESERT,
    BETA18_IDS.FOREST,
    BETA18_IDS.EXTREME_HILLS,
    BETA18_IDS.SWAMPLAND,
    BETA18_IDS.PLAINS,
    BETA18_IDS.TAIGA
]);

// --- 32bit 高速決定論的座標PRNG（GenLayer の chunkSeed 相当） ---
function mixBaseSeed(worldSeed, salt) {
    let s = (worldSeed ^ Math.imul(salt | 0, 0x9E3779B1)) | 0;
    s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B);
    s = Math.imul(s ^ (s >>> 13), 0xC2B2AE35);
    return (s ^ (s >>> 16)) | 0;
}

class GenLayerBase {
    constructor(salt, parent = null) {
        this.salt = salt | 0;
        this.parent = parent;
        this.worldGenSeed = 0;
        this.chunkSeed = 0;
    }

    initWorldGenSeed(worldSeed) {
        this.worldGenSeed = mixBaseSeed(worldSeed | 0, this.salt);
        if (this.parent) {
            this.parent.initWorldGenSeed(worldSeed);
        }
    }

    initChunkSeed(x, z) {
        let s = this.worldGenSeed;
        s = Math.imul(s ^ (x | 0), 0x27D4EB2D);
        s = Math.imul(s ^ (z | 0), 0x165667B1);
        s = Math.imul(s ^ (x | 0), 0x9E3779B1);
        s = Math.imul(s ^ (z | 0), 0x85EBCA6B);
        this.chunkSeed = (s ^ (s >>> 15)) | 0;
    }

    nextInt(bound) {
        let s = this.chunkSeed;
        s = (Math.imul(s, 0x19660D) + 0x3C6EF35F) | 0;
        this.chunkSeed = s;
        return ((s >>> 8) % bound) | 0;
    }
}

/**
 * 1. GenLayerIsland: 大陸の種（1/10で陸地、原点(0,0)は必ず陸地）
 */
class GenLayerIsland extends GenLayerBase {
    constructor(salt) {
        super(salt, null);
    }

    getInts(areaX, areaZ, areaW, areaH) {
        const out = new Int32Array(areaW * areaH);
        for (let z = 0; z < areaH; z++) {
            const wz = areaZ + z;
            const row = z * areaW;
            for (let x = 0; x < areaW; x++) {
                this.initChunkSeed(areaX + x, wz);
                out[row + x] = (this.nextInt(10) === 0) ? 1 : 0;
            }
        }
        // スポーン付近が完全な外洋にならないよう (0,0) を陸地固定（Beta 1.8 準拠）
        if (areaX <= 0 && areaX + areaW > 0 && areaZ <= 0 && areaZ + areaH > 0) {
            out[(-areaZ) * areaW + (-areaX)] = 1;
        }
        return out;
    }
}

/**
 * 2. GenLayerZoom / GenLayerFuzzyZoom: 2倍拡大（Fuzzy=4隅均等 / Normal=最頻値優先）
 */
class GenLayerZoom extends GenLayerBase {
    constructor(salt, parent, fuzzy = false) {
        super(salt, parent);
        this.fuzzy = fuzzy;
    }

    _choose2(a, b) {
        return this.nextInt(2) === 0 ? a : b;
    }

    _modeOrRandom(a, b, c, d) {
        if (b === c && c === d) return b;
        if (a === b && a === c) return a;
        if (a === b && a === d) return a;
        if (a === c && a === d) return a;
        if (a === b && c !== d) return a;
        if (a === c && b !== d) return a;
        if (a === d && b !== c) return a;
        if (b === c && a !== d) return b;
        if (b === d && a !== c) return b;
        if (c === d && a !== b) return c;
        const r = this.nextInt(4);
        return r === 0 ? a : (r === 1 ? b : (r === 2 ? c : d));
    }

    getInts(areaX, areaZ, areaW, areaH) {
        const pxMin = areaX >> 1;
        const pzMin = areaZ >> 1;
        const pxMax = ((areaX + areaW - 1) >> 1) + 1;
        const pzMax = ((areaZ + areaH - 1) >> 1) + 1;
        const pw = pxMax - pxMin + 1;
        const ph = pzMax - pzMin + 1;

        const parentInts = this.parent.getInts(pxMin, pzMin, pw, ph);
        const tmpW = (pw - 1) << 1;
        const tmpH = (ph - 1) << 1;
        const tmp = new Int32Array(tmpW * tmpH);

        for (let iz = 0; iz < ph - 1; iz++) {
            const pRow0 = iz * pw;
            const pRow1 = pRow0 + pw;
            const tRow0 = (iz << 1) * tmpW;
            const tRow1 = tRow0 + tmpW;
            const seedZ = (pzMin + iz) << 1;

            let ul = parentInts[pRow0];
            let dl = parentInts[pRow1];

            for (let ix = 0; ix < pw - 1; ix++) {
                const ur = parentInts[pRow0 + ix + 1];
                const dr = parentInts[pRow1 + ix + 1];
                const tx = ix << 1;

                this.initChunkSeed((pxMin + ix) << 1, seedZ);

                tmp[tRow0 + tx] = ul;
                tmp[tRow1 + tx] = this._choose2(ul, dl);
                tmp[tRow0 + tx + 1] = this._choose2(ul, ur);
                if (this.fuzzy) {
                    const r = this.nextInt(4);
                    tmp[tRow1 + tx + 1] = r === 0 ? ul : (r === 1 ? ur : (r === 2 ? dl : dr));
                } else {
                    tmp[tRow1 + tx + 1] = this._modeOrRandom(ul, ur, dl, dr);
                }

                ul = ur;
                dl = dr;
            }
        }

        const out = new Int32Array(areaW * areaH);
        const offX = areaX & 1;
        const offZ = areaZ & 1;

        for (let z = 0; z < areaH; z++) {
            const srcRow = (z + offZ) * tmpW + offX;
            const dstRow = z * areaW;
            for (let x = 0; x < areaW; x++) {
                out[dstRow + x] = tmp[srcRow + x];
            }
        }
        return out;
    }

    static magnify(baseSalt, parent, count) {
        let layer = parent;
        for (let i = 0; i < count; i++) {
            layer = new GenLayerZoom(baseSalt + i, layer, false);
        }
        return layer;
    }
}

/**
 * 3. GenLayerAddIsland: 斜め4近傍から海岸線を侵食・拡張し自然な大陸形状を作る
 */
class GenLayerAddIsland extends GenLayerBase {
    getInts(areaX, areaZ, areaW, areaH) {
        const px = areaX - 1;
        const pz = areaZ - 1;
        const pw = areaW + 2;
        const ph = areaH + 2;
        const p = this.parent.getInts(px, pz, pw, ph);
        const out = new Int32Array(areaW * areaH);

        for (let z = 0; z < areaH; z++) {
            const pRow0 = z * pw;
            const pRow1 = pRow0 + pw;
            const pRow2 = pRow1 + pw;
            const dstRow = z * areaW;

            for (let x = 0; x < areaW; x++) {
                const nw = p[pRow0 + x];
                const ne = p[pRow0 + x + 2];
                const sw = p[pRow2 + x];
                const se = p[pRow2 + x + 2];
                const c = p[pRow1 + x + 1];

                this.initChunkSeed(areaX + x, areaZ + z);

                if (c === 0 && (nw !== 0 || ne !== 0 || sw !== 0 || se !== 0)) {
                    let k = 1;
                    let val = 1;
                    if (nw !== 0 && this.nextInt(k++) === 0) val = nw;
                    if (ne !== 0 && this.nextInt(k++) === 0) val = ne;
                    if (sw !== 0 && this.nextInt(k++) === 0) val = sw;
                    if (se !== 0 && this.nextInt(k++) === 0) val = se;
                    out[dstRow + x] = (this.nextInt(3) === 0) ? val : 0;
                } else if (c > 0 && (nw === 0 || ne === 0 || sw === 0 || se === 0)) {
                    out[dstRow + x] = (this.nextInt(5) === 0) ? 0 : c;
                } else {
                    out[dstRow + x] = c;
                }
            }
        }
        return out;
    }
}

/**
 * 4. GenLayerBiome (Beta 1.8 GenLayerVillageLandscape): 陸地に6種の陸上バイオームを等確率割当
 */
class GenLayerBiomeBeta18 extends GenLayerBase {
    getInts(areaX, areaZ, areaW, areaH) {
        const p = this.parent.getInts(areaX, areaZ, areaW, areaH);
        const out = new Int32Array(areaW * areaH);

        for (let z = 0; z < areaH; z++) {
            const row = z * areaW;
            const wz = areaZ + z;
            for (let x = 0; x < areaW; x++) {
                const v = p[row + x];
                if (v === 0) {
                    out[row + x] = BETA18_IDS.OCEAN;
                } else {
                    this.initChunkSeed(areaX + x, wz);
                    out[row + x] = LAND_BIOMES[this.nextInt(LAND_BIOMES.length)];
                }
            }
        }
        return out;
    }
}

/**
 * 5. GenLayerRiverInit: 陸地セルを 2 / 3 にランダム色分け（後の川境界の元）
 */
class GenLayerRiverInit extends GenLayerBase {
    getInts(areaX, areaZ, areaW, areaH) {
        const p = this.parent.getInts(areaX, areaZ, areaW, areaH);
        const out = new Int32Array(areaW * areaH);

        for (let z = 0; z < areaH; z++) {
            const row = z * areaW;
            const wz = areaZ + z;
            for (let x = 0; x < areaW; x++) {
                const v = p[row + x];
                if (v > 0) {
                    this.initChunkSeed(areaX + x, wz);
                    out[row + x] = this.nextInt(2) + 2;
                } else {
                    out[row + x] = 0;
                }
            }
        }
        return out;
    }
}

/**
 * 6. GenLayerRiver: 上下左右と値が異なる境界線だけを RIVER として抽出
 */
class GenLayerRiver extends GenLayerBase {
    getInts(areaX, areaZ, areaW, areaH) {
        const px = areaX - 1;
        const pz = areaZ - 1;
        const pw = areaW + 2;
        const ph = areaH + 2;
        const p = this.parent.getInts(px, pz, pw, ph);
        const out = new Int32Array(areaW * areaH);

        for (let z = 0; z < areaH; z++) {
            const pRow0 = z * pw;
            const pRow1 = pRow0 + pw;
            const pRow2 = pRow1 + pw;
            const dstRow = z * areaW;

            for (let x = 0; x < areaW; x++) {
                const c = p[pRow1 + x + 1];
                const l = p[pRow1 + x];
                const r = p[pRow1 + x + 2];
                const u = p[pRow0 + x + 1];
                const d = p[pRow2 + x + 1];

                if (c === 0 || l === 0 || r === 0 || u === 0 || d === 0) {
                    out[dstRow + x] = -1;
                } else if (c !== l || c !== r || c !== u || c !== d) {
                    out[dstRow + x] = BETA18_IDS.RIVER;
                } else {
                    out[dstRow + x] = -1;
                }
            }
        }
        return out;
    }
}

/**
 * 7. GenLayerSmooth: ギザギザした境界を滑らかに丸める
 */
class GenLayerSmooth extends GenLayerBase {
    getInts(areaX, areaZ, areaW, areaH) {
        const px = areaX - 1;
        const pz = areaZ - 1;
        const pw = areaW + 2;
        const ph = areaH + 2;
        const p = this.parent.getInts(px, pz, pw, ph);
        const out = new Int32Array(areaW * areaH);

        for (let z = 0; z < areaH; z++) {
            const pRow0 = z * pw;
            const pRow1 = pRow0 + pw;
            const pRow2 = pRow1 + pw;
            const dstRow = z * areaW;

            for (let x = 0; x < areaW; x++) {
                const c = p[pRow1 + x + 1];
                const l = p[pRow1 + x];
                const r = p[pRow1 + x + 2];
                const u = p[pRow0 + x + 1];
                const d = p[pRow2 + x + 1];

                if (l === r && u === d) {
                    this.initChunkSeed(areaX + x, areaZ + z);
                    out[dstRow + x] = (this.nextInt(2) === 0) ? l : u;
                } else if (l === r) {
                    out[dstRow + x] = l;
                } else if (u === d) {
                    out[dstRow + x] = u;
                } else {
                    out[dstRow + x] = c;
                }
            }
        }
        return out;
    }
}

/**
 * 8. GenLayerRiverMix: バイオーム層と川層を合成（海の上には川を重ねない）
 */
class GenLayerRiverMix extends GenLayerBase {
    constructor(salt, biomeParent, riverParent) {
        super(salt, null);
        this.biomeParent = biomeParent;
        this.riverParent = riverParent;
    }

    initWorldGenSeed(worldSeed) {
        this.biomeParent.initWorldGenSeed(worldSeed);
        this.riverParent.initWorldGenSeed(worldSeed);
        super.initWorldGenSeed(worldSeed);
    }

    getInts(areaX, areaZ, areaW, areaH) {
        const b = this.biomeParent.getInts(areaX, areaZ, areaW, areaH);
        const r = this.riverParent.getInts(areaX, areaZ, areaW, areaH);
        const out = new Int32Array(areaW * areaH);

        for (let i = 0, len = areaW * areaH; i < len; i++) {
            if (b[i] === BETA18_IDS.OCEAN) {
                out[i] = BETA18_IDS.OCEAN;
            } else if (r[i] === BETA18_IDS.RIVER) {
                out[i] = BETA18_IDS.RIVER;
            } else {
                out[i] = b[i];
            }
        }
        return out;
    }
}

/**
 * 9. GenLayerVoronoiZoom: 4ブロック解像度をボロノイ補間で 1ブロック解像度へ有機的に拡大
 */
class GenLayerVoronoiZoom extends GenLayerBase {
    getInts(areaX, areaZ, areaW, areaH) {
        const ax = areaX - 2;
        const az = areaZ - 2;
        const pxMin = ax >> 2;
        const pzMin = az >> 2;
        const pxMax = ((ax + areaW - 1) >> 2) + 1;
        const pzMax = ((az + areaH - 1) >> 2) + 1;
        const pw = pxMax - pxMin + 1;
        const ph = pzMax - pzMin + 1;

        const p = this.parent.getInts(pxMin, pzMin, pw, ph);
        const tmpW = (pw - 1) << 2;
        const tmpH = (ph - 1) << 2;
        const tmp = new Int32Array(tmpW * tmpH);

        for (let iz = 0; iz < ph - 1; iz++) {
            const pRow0 = iz * pw;
            const pRow1 = pRow0 + pw;
            const wz0 = (pzMin + iz) << 2;
            const wz1 = wz0 + 4;

            let ul = p[pRow0];
            let dl = p[pRow1];

            for (let ix = 0; ix < pw - 1; ix++) {
                const ur = p[pRow0 + ix + 1];
                const dr = p[pRow1 + ix + 1];
                const wx0 = (pxMin + ix) << 2;
                const wx1 = wx0 + 4;

                // 4隅それぞれの決定論的ボロノイ中心点（0..3.6）
                this.initChunkSeed(wx0, wz0);
                const x00 = (this.nextInt(1024) / 1024.0 - 0.5) * 3.6;
                const z00 = (this.nextInt(1024) / 1024.0 - 0.5) * 3.6;

                this.initChunkSeed(wx1, wz0);
                const x10 = (this.nextInt(1024) / 1024.0 - 0.5) * 3.6 + 4.0;
                const z10 = (this.nextInt(1024) / 1024.0 - 0.5) * 3.6;

                this.initChunkSeed(wx0, wz1);
                const x01 = (this.nextInt(1024) / 1024.0 - 0.5) * 3.6;
                const z01 = (this.nextInt(1024) / 1024.0 - 0.5) * 3.6 + 4.0;

                this.initChunkSeed(wx1, wz1);
                const x11 = (this.nextInt(1024) / 1024.0 - 0.5) * 3.6 + 4.0;
                const z11 = (this.nextInt(1024) / 1024.0 - 0.5) * 3.6 + 4.0;

                const baseTx = ix << 2;
                const baseTz = iz << 2;

                for (let sz = 0; sz < 4; sz++) {
                    const rowOff = (baseTz + sz) * tmpW + baseTx;
                    const dz00 = sz - z00, dz10 = sz - z10, dz01 = sz - z01, dz11 = sz - z11;
                    const dz00_2 = dz00 * dz00, dz10_2 = dz10 * dz10, dz01_2 = dz01 * dz01, dz11_2 = dz11 * dz11;

                    for (let sx = 0; sx < 4; sx++) {
                        const d00 = (sx - x00) * (sx - x00) + dz00_2;
                        const d10 = (sx - x10) * (sx - x10) + dz10_2;
                        const d01 = (sx - x01) * (sx - x01) + dz01_2;
                        const d11 = (sx - x11) * (sx - x11) + dz11_2;

                        if (d00 < d10 && d00 < d01 && d00 < d11) tmp[rowOff + sx] = ul;
                        else if (d10 < d01 && d10 < d11) tmp[rowOff + sx] = ur;
                        else if (d01 < d11) tmp[rowOff + sx] = dl;
                        else tmp[rowOff + sx] = dr;
                    }
                }

                ul = ur;
                dl = dr;
            }
        }

        const out = new Int32Array(areaW * areaH);
        const offX = ax & 3;
        const offZ = az & 3;

        for (let z = 0; z < areaH; z++) {
            const srcRow = (z + offZ) * tmpW + offX;
            const dstRow = z * areaW;
            for (let x = 0; x < areaW; x++) {
                out[dstRow + x] = tmp[srcRow + x];
            }
        }
        return out;
    }
}

/**
 * Beta 1.8 GenLayer バイオームパイプラインを生成する（チャンク領域キャッシュ付き）
 */
export function createBeta18BiomeGenerator(seed = 0, biomeSize = 4) {
    // 1. 大陸・海洋の土台生成（本家 Beta 1.8 と同一ステップ）
    let continent = new GenLayerIsland(1);
    continent = new GenLayerZoom(2000, continent, true); // FuzzyZoom
    continent = new GenLayerAddIsland(1, continent);
    continent = new GenLayerZoom(2001, continent, false);
    continent = new GenLayerAddIsland(2, continent);
    continent = new GenLayerZoom(2002, continent, false);
    continent = new GenLayerAddIsland(3, continent);
    continent = new GenLayerZoom(2003, continent, false);
    continent = new GenLayerAddIsland(4, continent);

    // 2. バイオームブランチ（陸地を6種へ分割し、2 + biomeSize = 6回ズーム＋Smooth）
    let biomeLayer = new GenLayerBiomeBeta18(200, continent);
    biomeLayer = GenLayerZoom.magnify(1000, biomeLayer, 2);
    biomeLayer = GenLayerZoom.magnify(1002, biomeLayer, biomeSize);
    biomeLayer = new GenLayerSmooth(1000, biomeLayer);

    // 3. 川ブランチ（2 + biomeSize = 6回ズームで領域境界に沿って蛇行する川を生成）
    let riverLayer = new GenLayerRiverInit(100, continent);
    riverLayer = GenLayerZoom.magnify(1000, riverLayer, 2 + biomeSize);
    riverLayer = new GenLayerRiver(1, riverLayer);
    riverLayer = new GenLayerSmooth(1000, riverLayer);

    // 4. 合成 ＋ 4倍ボロノイ補間
    const riverMix = new GenLayerRiverMix(100, biomeLayer, riverLayer);
    const finalLayer = new GenLayerVoronoiZoom(10, riverMix);

    // 16x16 チャンク単位キャッシュ（単点参照 getBiomeIdAt の高速化用）
    const MAX_CACHE = 256;
    const chunkCache = new Map();

    function setSeed(newSeed) {
        finalLayer.initWorldGenSeed(newSeed | 0);
        chunkCache.clear();
    }

    setSeed(seed);

    return {
        setSeed,

        /**
         * 任意矩形領域 (areaX..areaX+areaW-1, areaZ..areaZ+areaH-1) のバイオームID配列を一括取得
         * インデックス = (zLocal * areaW) + xLocal
         */
        getArea(areaX, areaZ, areaW, areaH) {
            return finalLayer.getInts(areaX | 0, areaZ | 0, areaW | 0, areaH | 0);
        },

        /**
         * 1ブロック座標 (wx, wz) のバイオームIDを取得（16x16チャンク単位キャッシュ付き）
         */
        getBiomeIdAt(wx, wz) {
            const x = wx | 0;
            const z = wz | 0;
            const cx = x >> 4;
            const cz = z >> 4;
            const key = ((cx & 0xFFFF) << 16) | (cz & 0xFFFF);

            let arr = chunkCache.get(key);
            if (!arr) {
                arr = finalLayer.getInts(cx << 4, cz << 4, 16, 16);
                if (chunkCache.size >= MAX_CACHE) {
                    chunkCache.delete(chunkCache.keys().next().value);
                }
                chunkCache.set(key, arr);
            }
            return arr[((z & 15) << 4) | (x & 15)];
        }
    };
}