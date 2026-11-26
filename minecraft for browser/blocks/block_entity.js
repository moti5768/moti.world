"use strict";
import { getRawBlockId, getRawLocalState, packRawBlock } from '../blockstate.js';

/* ======================================================
   【BlockEntity (旧 TileEntity) 管理エンジン】(blocks/block_entity.js)
   - Minecraft Java Edition BlockEntity / BlockEntityType 準拠
   - 座標 (x, y, z) に紐づく任意データ（チェスト中身・かまど燃焼時間・看板文字等）を管理
   - 20TPS のサーバーTick実行・ブロック破壊時の自動削除・IndexedDB 永続化を提供
   ====================================================== */

function encodeBlockKey(wx, wy, wz) {
    const ox = (wx + 524288) & 0xFFFFF;
    const oz = (wz + 524288) & 0xFFFFF;
    const oy = wy & 0xFF;
    return ox * 268435456 + (((oz << 8) | oy) >>> 0);
}

const _blockEntityTypes = new Map();

/**
 * 新しい BlockEntityType を登録する
 * @param {string} typeId 例: "minecraft:chest", "minecraft:furnace"
 * @param {object} spec   { createData, tick, serialize, deserialize, onRemoved }
 */
export function registerBlockEntityType(typeId, spec) {
    if (!typeId || !spec || typeof spec !== "object") return null;
    const entry = Object.freeze({
        id: typeId,
        createData: typeof spec.createData === "function" ? spec.createData : () => ({}),
        tick: typeof spec.tick === "function" ? spec.tick : null,
        serialize: typeof spec.serialize === "function" ? spec.serialize : (data) => structuredCloneSafe(data),
        deserialize: typeof spec.deserialize === "function" ? spec.deserialize : (saved) => structuredCloneSafe(saved),
        onRemoved: typeof spec.onRemoved === "function" ? spec.onRemoved : null
    });
    _blockEntityTypes.set(typeId, entry);
    return entry;
}

export function getBlockEntityType(typeId) {
    return _blockEntityTypes.get(typeId) || null;
}

function structuredCloneSafe(obj) {
    return obj ? JSON.parse(JSON.stringify(obj)) : {};
}

// ======================================================
// 標準 BlockEntityType 登録（チェスト & かまど）
// ======================================================
registerBlockEntityType("minecraft:chest", {
    createData: () => ({
        customName: "",
        slots: new Array(27).fill(null) // 各スロット: { key: "STONE", count: 1 } | null
    })
});

// かまど精錬レシピテーブル（registerSmeltingRecipe で後から自由に拡張可能）
export const SMELTING_RECIPES = {
    COBBLE_STONE: "STONE",
    COBBLE_STONE_MOSSY: "STONE",
    SAND: "GLASS",
    SANDSTONE: "SMOOTHSTONE_SLAB",
    IRON_ORE: "STONE",
    GOLD_ORE: "STONE",
    LOG_OAK: "COAL_ORE"
};

export function registerSmeltingRecipe(inputKey, outputKey) {
    if (inputKey && outputKey) SMELTING_RECIPES[inputKey] = outputKey;
}

registerBlockEntityType("minecraft:comparator", {
    createData: () => ({
        outputSignal: 0
    })
});

registerBlockEntityType("minecraft:furnace", {
    createData: () => ({
        burnTime: 0,
        burnDuration: 0,
        cookTime: 0,
        cookTimeTotal: 100, // 5秒 (100 ticks) で1個精錬
        input: null,        // { key: "IRON_ORE", count: 1 }
        fuelCount: 0,
        output: null        // { key: "STONE", count: 1 }
    }),
    tick: (be, ctx) => {
        const d = be.data;
        const wasLit = d.burnTime > 0;
        let invChanged = false;

        if (d.burnTime > 0) {
            d.burnTime--;
        }

        const resultKey = (d.input && d.input.count > 0)
            ? (SMELTING_RECIPES[d.input.key] || "STONE")
            : null;
        const canSmelt = !!(resultKey && (!d.output || (d.output.key === resultKey && d.output.count < 64)));

        // 燃焼切れ時に精錬可能＆燃料ありなら次の燃料を消費して着火
        if (d.burnTime <= 0 && canSmelt && d.fuelCount > 0) {
            d.fuelCount--;
            d.burnTime = 200; // 10秒燃焼
            d.burnDuration = 200;
            invChanged = true;
        }

        if (d.burnTime > 0 && canSmelt) {
            d.cookTime++;
            if (d.cookTime >= d.cookTimeTotal) {
                d.cookTime = 0;
                d.input.count--;
                if (d.input.count <= 0) d.input = null;

                if (!d.output) {
                    d.output = { key: resultKey, count: 1 };
                } else {
                    d.output.count++;
                }
                invChanged = true;
                if (typeof ctx.onMessage === "function") {
                    ctx.onMessage(`かまど [${be.x}, ${be.y}, ${be.z}] の精錬完了: ${resultKey} (計 ${d.output.count}個)`, "#55ff55");
                }
            }
        } else if (d.cookTime > 0) {
            d.cookTime = Math.max(0, d.cookTime - 2);
        }

        const isLit = d.burnTime > 0;
        if (wasLit !== isLit) {
            ctx.setBlockProp(be.x, be.y, be.z, "lit", isLit);
        }
        if (invChanged && typeof ctx.onInventoryChanged === "function") {
            ctx.onInventoryChanged(be.x, be.y, be.z);
        }
    }
});

export function createBlockEntityManager(deps) {
    const {
        isChunkLoaded,
        getWorldRawLoaded,
        setBlockFromWorldTick,
        setBlockStateProp,
        onMessage = null,
        onInventoryChanged = null
    } = deps;

    const entitiesByKey = new Map(); // Map<coordKey, BlockEntity>
    const tickingSet = new Set();    // Tick関数を持つ BlockEntity のみ高速巡回

    const tickCtx = {
        getRaw: getWorldRawLoaded,
        setBlockProp: (wx, wy, wz, propName, value) => {
            const raw = getWorldRawLoaded(wx, wy, wz);
            if (raw <= 0) return false;
            const id = getRawBlockId(raw);
            const meta = getRawLocalState(raw);
            const nextMeta = setBlockStateProp(id, meta, propName, value);
            if (nextMeta === meta) return false;
            return setBlockFromWorldTick(wx, wy, wz, packRawBlock(id, nextMeta), true);
        },
        onMessage,
        onInventoryChanged
    };

    /**
     * Java Edition AbstractContainerMenu.getRedstoneSignalFromContainer 準拠:
     * 指定座標にコンテナ系 BlockEntity があれば充填率 0..15 を返す（対象外は -1）
     */
    function getAnalogSignal(wx, wy, wz) {
        const be = get(wx, wy, wz);
        if (!be || !be.data) return -1;

        if (be.type === "minecraft:chest") {
            const slots = be.data.slots;
            if (!Array.isArray(slots) || slots.length === 0) return 0;
            let nonEmpty = 0;
            let fillSum = 0;
            for (let i = 0; i < slots.length; i++) {
                const s = slots[i];
                if (s && s.count > 0) {
                    nonEmpty++;
                    fillSum += Math.min(1.0, s.count / 64);
                }
            }
            return nonEmpty === 0 ? 0 : (Math.floor((fillSum / slots.length) * 14) + 1);
        }

        if (be.type === "minecraft:furnace") {
            const d = be.data;
            let nonEmpty = 0;
            let fillSum = 0;
            if (d.input && d.input.count > 0) { nonEmpty++; fillSum += Math.min(1.0, d.input.count / 64); }
            if (d.fuelCount > 0) { nonEmpty++; fillSum += Math.min(1.0, d.fuelCount / 64); }
            if (d.output && d.output.count > 0) { nonEmpty++; fillSum += Math.min(1.0, d.output.count / 64); }
            return nonEmpty === 0 ? 0 : (Math.floor((fillSum / 3) * 14) + 1);
        }

        return -1;
    }

    function create(wx, wy, wz, typeId, initialData = null) {
        const spec = _blockEntityTypes.get(typeId);
        if (!spec) {
            console.warn(`[BlockEntity] 未登録のタイプ: ${typeId}`);
            return null;
        }
        const x = wx | 0, y = wy | 0, z = wz | 0;
        const key = encodeBlockKey(x, y, z);

        if (entitiesByKey.has(key)) {
            remove(x, y, z);
        }

        const be = {
            key,
            x, y, z,
            type: typeId,
            spec,
            data: initialData ? spec.deserialize(initialData) : spec.createData()
        };
        entitiesByKey.set(key, be);
        if (spec.tick) tickingSet.add(be);
        return be;
    }

    function get(wx, wy, wz) {
        return entitiesByKey.get(encodeBlockKey(wx | 0, wy | 0, wz | 0)) || null;
    }

    function remove(wx, wy, wz) {
        const key = encodeBlockKey(wx | 0, wy | 0, wz | 0);
        const be = entitiesByKey.get(key);
        if (!be) return false;

        entitiesByKey.delete(key);
        tickingSet.delete(be);
        if (be.spec.onRemoved) {
            be.spec.onRemoved(be, tickCtx);
        }
        return true;
    }

    function tick() {
        if (tickingSet.size === 0) return;
        for (const be of tickingSet) {
            const cx = be.x >> 4;
            const cz = be.z >> 4;
            if (!isChunkLoaded(cx, cz)) continue;
            be.spec.tick(be, tickCtx);
        }
    }

    function clear() {
        entitiesByKey.clear();
        tickingSet.clear();
    }

    function exportState() {
        const out = [];
        for (const be of entitiesByKey.values()) {
            out.push({
                id: be.type,
                x: be.x,
                y: be.y,
                z: be.z,
                data: be.spec.serialize(be.data)
            });
        }
        return out;
    }

    function importState(savedList) {
        clear();
        if (!Array.isArray(savedList)) return;
        for (let i = 0; i < savedList.length; i++) {
            const s = savedList[i];
            if (!s || typeof s.id !== "string") continue;
            create(s.x | 0, s.y | 0, s.z | 0, s.id, s.data || null);
        }
    }

    return {
        get count() { return entitiesByKey.size; },
        create,
        get,
        remove,
        tick,
        clear,
        getAnalogSignal,
        exportState,
        importState,
        registerType: registerBlockEntityType
    };
}