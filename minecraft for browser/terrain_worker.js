"use strict";
import { createBeta18TerrainEngine } from './world/beta18_terrain.js';

/* ======================================================
   【基本地形生成 Web Worker】(terrain_worker.js)
   - world/beta18_terrain.js を script.js と 100% 共有
   - 生成済み Uint16Array(65536) を Transferable でゼロコピー返却
   ====================================================== */

const terrainEngine = createBeta18TerrainEngine();
let SEA_LEVEL = 62;
let BLOCK_IDS = null;
let BIOME_LIST = null;

self.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === "init") {
        SEA_LEVEL = msg.seaLevel | 0;
        BLOCK_IDS = msg.blockIds;
        BIOME_LIST = msg.biomes;
        terrainEngine.setSeed(msg.seed);
        return;
    }

    if (msg.type === "generate") {
        if (!BLOCK_IDS || !BIOME_LIST) return;
        const data = new Uint16Array(65536);
        terrainEngine.generateChunkBaseTerrain(
            msg.cx | 0,
            msg.cz | 0,
            data,
            SEA_LEVEL,
            BLOCK_IDS,
            BIOME_LIST
        );
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