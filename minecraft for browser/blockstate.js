"use strict";

/* ======================================================
   【BlockState 一元管理モジュール】(blockstate.js)
   - Minecraft Java Edition の StateDefinition / blockstates 準拠
   - 4bit (0..15) O(1) ビットパック / アンパック
   - 16通りのバリアント・発光量・F3文字列を登録時に事前コンパイル（ランタイムゼロGC）
   ====================================================== */

// 床(0)＋壁4方向(1:east/+X向き, 2:west/-X向き, 3:south/+Z向き, 4:north/-Z向き)に対応する支持ブロック相対オフセット
export const MOUNT_SUPPORT_DX = Object.freeze([0, -1, 1, 0, 0]);
export const MOUNT_SUPPORT_DY = Object.freeze([-1, 0, 0, 0, 0]);
export const MOUNT_SUPPORT_DZ = Object.freeze([0, 0, 0, -1, 1]);

// 標準 BlockState スキーマ定義（registerStateSchema で後から自由に拡張可能）
export const STATE_SCHEMAS = {
    NONE: Object.freeze({}),
    AXIS: Object.freeze({
        axis: Object.freeze({ shift: 0, mask: 3, values: Object.freeze(['y', 'x', 'z']) })
    }),
    FACING_4: Object.freeze({
        facing: Object.freeze({ shift: 0, mask: 3, values: Object.freeze(['south', 'east', 'north', 'west']) })
    }),
    SLAB: Object.freeze({
        half: Object.freeze({ shift: 2, mask: 1, values: Object.freeze(['bottom', 'top']) })
    }),
    STAIRS: Object.freeze({
        facing: Object.freeze({ shift: 0, mask: 3, values: Object.freeze(['north', 'east', 'south', 'west']) }),
        half: Object.freeze({ shift: 2, mask: 1, values: Object.freeze(['bottom', 'top']) })
    }),
    CONNECTIONS_4: Object.freeze({
        north: Object.freeze({ shift: 3, mask: 1, bool: true }),
        south: Object.freeze({ shift: 2, mask: 1, bool: true }),
        east: Object.freeze({ shift: 1, mask: 1, bool: true }),
        west: Object.freeze({ shift: 0, mask: 1, bool: true })
    }),
    POWER_16: Object.freeze({
        power: Object.freeze({ shift: 0, mask: 15 })
    }),
    LIT: Object.freeze({
        lit: Object.freeze({ shift: 0, mask: 1, bool: true })
    }),
    MOUNT_5: Object.freeze({
        mount: Object.freeze({ shift: 0, mask: 7, values: Object.freeze(['floor', 'east', 'west', 'south', 'north']) })
    }),
    TORCH: Object.freeze({
        mount: Object.freeze({ shift: 0, mask: 7, values: Object.freeze(['floor', 'east', 'west', 'south', 'north']) }),
        lit: Object.freeze({ shift: 3, mask: 1, bool: true })
    }),
    LEVER: Object.freeze({
        mount: Object.freeze({ shift: 0, mask: 7, values: Object.freeze(['floor', 'east', 'west', 'south', 'north']) }),
        powered: Object.freeze({ shift: 3, mask: 1, bool: true })
    }),
    REPEATER_4: Object.freeze({
        facing: Object.freeze({ shift: 0, mask: 3, values: Object.freeze(['east', 'north', 'west', 'south']) }),
        delay: Object.freeze({ shift: 2, mask: 3, values: Object.freeze([2, 4, 6, 8]) })
    }),
    // --- Step 3 / Step 4 ＆ 将来ブロック追加用の標準スキーマ ---
    SNOWY: Object.freeze({
        snowy: Object.freeze({ shift: 0, mask: 1, bool: true })
    }),
    LIQUID_LEVEL: Object.freeze({
        level: Object.freeze({ shift: 0, mask: 7 }),
        falling: Object.freeze({ shift: 3, mask: 1, bool: true })
    }),
    OPEN_FACING: Object.freeze({
        facing: Object.freeze({ shift: 0, mask: 3, values: Object.freeze(['north', 'east', 'south', 'west']) }),
        open: Object.freeze({ shift: 2, mask: 1, bool: true })
    })
};

// ブロックID -> BlockState コンパイル済み設定の高速配列 (MAX 4096)
const MAX_STATE_BLOCK_IDS = 4096;
const MAX_GLOBAL_STATES = 65536;
const MAX_STATE_BITS = 12; // 1ブロックあたりのプロパティ合計ビット上限 (最大 4096 状態/ブロック)

const _stateEntries = new Array(MAX_STATE_BLOCK_IDS).fill(null);

// 16bit グローバル BlockState パレット (0..4095 = 各ブロックの localState=0、4096..65535 = localState>=1)
const _globalToBlockId = new Uint16Array(MAX_GLOBAL_STATES);
const _globalToLocalState = new Uint16Array(MAX_GLOBAL_STATES);
let _nextGlobalStateId = MAX_STATE_BLOCK_IDS;

/**
 * 16bit パック済みボクセル値 (globalStateId) からブロック ID (0..4095) を O(1) 取得する
 */
export function getRawBlockId(raw) {
    return _globalToBlockId[raw & 0xFFFF];
}

/**
 * 16bit パック済みボクセル値 (globalStateId) からブロック内状態値 (localState) を O(1) 取得する
 */
export function getRawLocalState(raw) {
    return _globalToLocalState[raw & 0xFFFF];
}

/**
 * ブロック ID とブロック内状態値 (localState) から 16bit グローバル状態 ID を O(1) で返す
 */
export function packRawBlock(blockId, localState = 0) {
    const id = blockId & 0xFFF;
    const entry = _stateEntries[id];
    if (!entry) return id;
    const ls = (localState >= 0 && localState < entry.stateCount) ? localState : 0;
    return entry.localToGlobal[ls];
}

/**
 * 指定ブロックが持つ状態空間サイズ (1..4096) を返す
 */
export function getBlockStateCount(blockId) {
    const entry = _stateEntries[blockId & 0xFFF];
    return entry ? entry.stateCount : 1;
}

/**
 * 現在のグローバル状態パレット使用状況を取得する（デバッグ診断用）
 */
export function getGlobalStatePaletteStats() {
    return {
        usedExtendedStates: _nextGlobalStateId - MAX_STATE_BLOCK_IDS,
        maxExtendedStates: MAX_GLOBAL_STATES - MAX_STATE_BLOCK_IDS,
        nextGlobalStateId: _nextGlobalStateId
    };
}

/**
 * 新しい BlockState スキーマを登録する（ブロック追加時の拡張用）
 * 例: registerStateSchema("AGE_4", { age: { shift: 0, mask: 3 } })
 */
export function registerStateSchema(name, schemaDef) {
    if (!name || !schemaDef || typeof schemaDef !== "object") return null;
    const frozen = {};
    const keys = Object.keys(schemaDef);
    for (let i = 0; i < keys.length; i++) {
        const propName = keys[i];
        const def = schemaDef[propName];
        if (!def || typeof def !== "object") continue;
        frozen[propName] = Object.freeze({
            shift: def.shift | 0,
            mask: def.mask | 0,
            bool: def.bool === true,
            values: Array.isArray(def.values) ? Object.freeze([...def.values]) : undefined
        });
    }
    const sealedSchema = Object.freeze(frozen);
    STATE_SCHEMAS[name] = sealedSchema;
    return sealedSchema;
}

/**
 * ブロック定義の簡易 properties オブジェクトから 4bit BlockState スキーマを自動コンパイルする
 * 対応記法:
 *   - bool略記:       lit: false / snowy: false
 *   - enum配列略記:   facing: ['north', 'east', 'south', 'west']
 *   - 詳細指定:       delay: { values: [2, 4, 6, 8], default: 2 }
 *   - 整数レンジ:     power: { min: 0, max: 15, default: 0 } または age: { range: [0, 3] }
 *   - ビット位置固定: half: { values: ['bottom', 'top'], shift: 2 }
 */
export function buildStateSchemaFromProperties(properties, blockName = "unknown") {
    if (!properties || typeof properties !== "object") return STATE_SCHEMAS.NONE;

    const keys = Object.keys(properties);
    if (keys.length === 0) return STATE_SCHEMAS.NONE;

    const compiled = {};
    let usedBitMask = 0;

    for (let i = 0; i < keys.length; i++) {
        const propName = keys[i];
        const spec = properties[propName];
        if (spec === undefined || spec === null) continue;

        let bool = false;
        let values = undefined;
        let count = 2;
        let bits = 1;
        let defaultVal = 0;
        let explicitShift = null;

        if (typeof spec === "boolean") {
            bool = true;
            count = 2;
            bits = 1;
            defaultVal = spec;
        } else if (Array.isArray(spec)) {
            values = Object.freeze([...spec]);
            count = Math.max(1, values.length);
            bits = count <= 1 ? 1 : Math.ceil(Math.log2(count));
            defaultVal = values[0];
        } else if (typeof spec === "object") {
            if (Number.isInteger(spec.shift)) {
                explicitShift = spec.shift | 0;
            }

            if (spec.bool === true || spec.type === "bool" || typeof spec.default === "boolean") {
                bool = true;
                count = 2;
                bits = 1;
                defaultVal = !!spec.default;
            } else if (Array.isArray(spec.values)) {
                values = Object.freeze([...spec.values]);
                count = Math.max(1, values.length);
                bits = count <= 1 ? 1 : Math.ceil(Math.log2(count));
                defaultVal = (spec.default !== undefined) ? spec.default : values[0];
            } else {
                const min = Array.isArray(spec.range) ? (spec.range[0] | 0) : ((spec.min ?? 0) | 0);
                const max = Array.isArray(spec.range) ? (spec.range[1] | 0) : ((spec.max ?? 1) | 0);
                count = Math.max(1, (max - min) + 1);
                bits = count <= 1 ? 1 : Math.ceil(Math.log2(count));

                if (min !== 0) {
                    const arr = new Array(count);
                    for (let v = 0; v < count; v++) arr[v] = min + v;
                    values = Object.freeze(arr);
                }
                defaultVal = (spec.default !== undefined) ? spec.default : min;
            }
        } else {
            continue;
        }

        const mask = (1 << bits) - 1;
        let shift = explicitShift;

        if (shift === null) {
            for (let s = 0; s <= MAX_STATE_BITS - bits; s++) {
                if (((mask << s) & usedBitMask) === 0) {
                    shift = s;
                    break;
                }
            }
        }

        if (shift === null || shift < 0 || (shift + bits) > MAX_STATE_BITS || ((mask << shift) & usedBitMask) !== 0) {
            console.error(
                `[BlockState] ブロック "${blockName}" のプロパティ "${propName}" (${bits}bit) が${MAX_STATE_BITS}bit上限を超過または重複しました。`
            );
            continue;
        }

        usedBitMask |= (mask << shift);
        compiled[propName] = Object.freeze({
            shift,
            mask,
            count,
            bool,
            values,
            defaultVal
        });
    }

    return Object.freeze(compiled);
}

const STATE_LOCAL_MASK = (1 << MAX_STATE_BITS) - 1; // 0xFFF

/**
 * スキーマが使用する最大ビット幅から状態空間サイズ (1, 2, 4, 8, 16, 32, 64...) を計算する
 */
export function computeSchemaStateSpace(schema) {
    if (!schema || typeof schema !== "object") return 1;
    const keys = Object.keys(schema);
    if (keys.length === 0) return 1;

    let maxBitEnd = 0;
    for (let i = 0; i < keys.length; i++) {
        const def = schema[keys[i]];
        if (!def || !def.mask) continue;
        let bits = 0;
        let m = def.mask >>> 0;
        while (m > 0) { bits++; m >>>= 1; }
        const end = (def.shift | 0) + bits;
        if (end > maxBitEnd) maxBitEnd = end;
    }
    if (maxBitEnd > MAX_STATE_BITS) maxBitEnd = MAX_STATE_BITS;
    return 1 << maxBitEnd;
}

export function getSchemaDefaultState(schema) {
    if (!schema || typeof schema !== "object") return 0;
    let packed = 0;
    const keys = Object.keys(schema);
    for (let i = 0; i < keys.length; i++) {
        const def = schema[keys[i]];
        if (!def || def.defaultVal === undefined) continue;
        packed = _writePropToMeta(def, packed, def.defaultVal);
    }
    return packed & STATE_LOCAL_MASK;
}

/**
 * ブロック設定から stateSchema を解決する（properties簡易定義 / 文字列指定 / スキーマ直接指定 / 自動推論）
 */
export function resolveStateSchema(config) {
    if (config.properties && typeof config.properties === "object") {
        return buildStateSchemaFromProperties(config.properties, config.name || String(config.id ?? "unknown"));
    }
    if (typeof config.stateSchema === "string") {
        return STATE_SCHEMAS[config.stateSchema] || STATE_SCHEMAS.NONE;
    }
    if (config.stateSchema && typeof config.stateSchema === "object") {
        return config.stateSchema;
    }

    const gType = config.geometryType ?? "cube";
    if (config.isLog) return STATE_SCHEMAS.AXIS;
    if (config.isLadder) return STATE_SCHEMAS.FACING_4;
    if (config.directional) return STATE_SCHEMAS.STAIRS;
    if (config.isSlab) return STATE_SCHEMAS.SLAB;
    if (gType === "fence" || gType === "pane") return STATE_SCHEMAS.CONNECTIONS_4;
    return STATE_SCHEMAS.NONE;
}

/**
 * stateSchema から「3D回転・上下反転に使うビット」のマスクを自動導出する
 */
export function computeTransformMask(stateSchema, explicitMask = null) {
    if (explicitMask !== undefined && explicitMask !== null) {
        return explicitMask & STATE_LOCAL_MASK;
    }
    let mask = 0;
    if (stateSchema.facing) mask |= (stateSchema.facing.mask << stateSchema.facing.shift);
    if (stateSchema.axis) mask |= (stateSchema.axis.mask << stateSchema.axis.shift);
    if (stateSchema.half) mask |= (stateSchema.half.mask << stateSchema.half.shift);
    return mask & STATE_LOCAL_MASK;
}

function _encodePropValue(def, value) {
    if (def.bool) {
        return value ? 1 : 0;
    }
    if (def.values) {
        if (typeof value === "number" && !def.values.includes(value)) {
            return value & def.mask;
        }
        const idx = def.values.indexOf(value);
        return idx >= 0 ? idx : 0;
    }
    return (Number(value) | 0) & def.mask;
}

function _decodePropValue(def, raw) {
    if (def.bool) return raw !== 0;
    if (def.values) return def.values[raw] !== undefined ? def.values[raw] : def.values[0];
    return raw;
}

function _writePropToMeta(def, meta, value) {
    const raw = _encodePropValue(def, value);
    const clearMask = ~(def.mask << def.shift);
    return ((meta & clearMask) | ((raw & def.mask) << def.shift)) & STATE_LOCAL_MASK;
}

/**
 * 数値またはプロパティオブジェクト ({ lit: true, mount: 'floor' }) をブロック内状態値へ正規化する
 * （オブジェクト指定時はスキーマ側の defaultVal を土台にして差分適用する）
 */
export function normalizeStateValue(schema, stateValue, fallback = 0) {
    if (typeof stateValue === "number") return stateValue & STATE_LOCAL_MASK;
    if (stateValue && typeof stateValue === "object" && schema) {
        let packed = getSchemaDefaultState(schema);
        const keys = Object.keys(stateValue);
        for (let i = 0; i < keys.length; i++) {
            const propName = keys[i];
            const def = schema[propName];
            if (!def) continue;
            packed = _writePropToMeta(def, packed, stateValue[propName]);
        }
        return packed & STATE_LOCAL_MASK;
    }
    return fallback & STATE_LOCAL_MASK;
}

/**
 * バリアント条件文字列（例: "lit=true" や "powered=true,delay=4"）が指定 state(0..15) に一致するか判定
 */
function _matchesVariantCondition(schema, meta, condStr) {
    if (!schema || !condStr) return false;
    const clauses = condStr.split(",");
    for (let i = 0; i < clauses.length; i++) {
        const eqIdx = clauses[i].indexOf("=");
        if (eqIdx < 0) return false;
        const propName = clauses[i].slice(0, eqIdx).trim();
        const expected = clauses[i].slice(eqIdx + 1).trim();
        const def = schema[propName];
        if (!def) return false;

        const raw = (meta >> def.shift) & def.mask;
        let actualStr;
        if (def.bool) actualStr = raw !== 0 ? "true" : "false";
        else if (def.values) actualStr = String(def.values[raw]);
        else actualStr = String(raw);

        if (actualStr !== expected) return false;
    }
    return true;
}

/**
 * ブロック1種の全状態 (0..stateCount-1) に対するバリアント・発光量・F3文字列・16bitグローバル状態IDを事前コンパイルする
 */
export function compileAndRegisterBlockState(cfg) {
    const id = cfg.id & 0xFFF;
    const schema = cfg.stateSchema || STATE_SCHEMAS.NONE;
    const schemaKeys = Object.keys(schema);
    const stateCount = computeSchemaStateSpace(schema);
    const stateMask = stateCount - 1;

    // 1. 16bit グローバル状態IDテーブルの確保（再コンパイル時は既存の割当を再利用してIDズレを防止）
    const prevEntry = _stateEntries[id];
    let localToGlobal;
    if (prevEntry && prevEntry.localToGlobal && prevEntry.localToGlobal.length === stateCount) {
        localToGlobal = prevEntry.localToGlobal;
    } else {
        localToGlobal = new Uint16Array(stateCount);
        // localState = 0 は常に globalStateId = id (0..4095) へ固定マッピング
        localToGlobal[0] = id;
        _globalToBlockId[id] = id;
        _globalToLocalState[id] = 0;

        for (let m = 1; m < stateCount; m++) {
            if (_nextGlobalStateId >= MAX_GLOBAL_STATES) {
                console.error(`[BlockState] 16bit グローバル状態上限 (65536) に達しました: ${cfg.name || id}`);
                localToGlobal[m] = id;
                continue;
            }
            const gid = _nextGlobalStateId++;
            localToGlobal[m] = gid;
            _globalToBlockId[gid] = id;
            _globalToLocalState[gid] = m;
        }
    }

    const stateLightLevels = new Uint8Array(stateCount);
    const compiledVariants = new Array(stateCount).fill(null);
    const stateStrings = new Array(stateCount);
    const variantEntries = cfg.stateVariants ? Object.entries(cfg.stateVariants) : null;

    for (let m = 0; m < stateCount; m++) {
        // 2. 静的 stateVariants ＋ 動的 resolveStateVisual のマージ
        let merged = null;
        if (variantEntries) {
            for (let v = 0; v < variantEntries.length; v++) {
                if (_matchesVariantCondition(schema, m, variantEntries[v][0])) {
                    merged = merged ? { ...merged, ...variantEntries[v][1] } : { ...variantEntries[v][1] };
                }
            }
        }
        if (typeof cfg.resolveStateVisual === "function") {
            const dyn = cfg.resolveStateVisual(m, cfg);
            if (dyn) merged = merged ? { ...merged, ...dyn } : dyn;
        }
        compiledVariants[m] = merged;

        // 3. 状態別発光量の決定
        let light = cfg.lightLevel > 0 ? cfg.lightLevel : 0;
        if (merged && typeof merged.lightLevel === "number") {
            light = merged.lightLevel;
        } else if (typeof cfg.getLightLevel === "function") {
            light = cfg.getLightLevel(m);
        }
        stateLightLevels[m] = light & 15;

        // 4. F3 / デバッグ表示文字列の事前キャッシュ（ランタイム文字列生成をゼロ化）
        if (schemaKeys.length === 0) {
            stateStrings[m] = "";
        } else {
            const parts = new Array(schemaKeys.length);
            for (let k = 0; k < schemaKeys.length; k++) {
                const propName = schemaKeys[k];
                const def = schema[propName];
                const raw = (m >> def.shift) & def.mask;
                parts[k] = `${propName}=${_decodePropValue(def, raw)}`;
            }
            stateStrings[m] = `[${parts.join(",")}]`;
        }
    }

    cfg.stateCount = stateCount;
    cfg.stateMask = stateMask;
    cfg._stateLightLevels = stateLightLevels;
    cfg._compiledVariants = compiledVariants;
    cfg._stateStrings = stateStrings;
    cfg._localToGlobal = localToGlobal;

    _stateEntries[id] = {
        id,
        schema,
        schemaKeys,
        stateCount,
        stateMask,
        localToGlobal,
        transformMask: cfg.transformMask & stateMask,
        defaultState: cfg.defaultState & stateMask,
        stateLightLevels,
        compiledVariants,
        stateStrings
    };

    return _stateEntries[id];
}

/**
 * 指定ブロックがそのプロパティを持っているか判定する
 */
export function hasBlockStateProp(blockId, propName) {
    const entry = _stateEntries[blockId & 0xFFF];
    return !!(entry && entry.schema[propName]);
}

/**
 * ブロックの 4bit BlockState から指定プロパティの生数値 (0..mask) を O(1) で取得する
 */
export function getBlockStateRawProp(blockId, meta, propName) {
    const entry = _stateEntries[blockId & 0xFFF];
    const def = entry && entry.schema[propName];
    if (!def) return 0;
    return (meta >> def.shift) & def.mask;
}

/**
 * ブロックの 4bit BlockState から指定プロパティの論理値（boolean / enum文字列 / 数値）を取得する
 */
export function getBlockStateProp(blockId, meta, propName) {
    const entry = _stateEntries[blockId & 0xFFF];
    const def = entry && entry.schema[propName];
    if (!def) return undefined;
    return _decodePropValue(def, (meta >> def.shift) & def.mask);
}

/**
 * ブロックの BlockState の指定プロパティを書き換えた新しい状態値 (localState) を返す
 */
export function setBlockStateProp(blockId, meta, propName, value) {
    const entry = _stateEntries[blockId & 0xFFF];
    if (!entry) return 0;
    const def = entry.schema[propName];
    if (!def) return meta & entry.stateMask;
    return _writePropToMeta(def, meta, value) & entry.stateMask;
}

/**
 * 指定プロパティを次の値へ巡回（トグル・段階切替）した新しい状態値 (localState) を返す
 */
export function cycleBlockStateProp(blockId, meta, propName) {
    const entry = _stateEntries[blockId & 0xFFF];
    if (!entry) return 0;
    const def = entry.schema[propName];
    if (!def) return meta & entry.stateMask;

    const raw = (meta >> def.shift) & def.mask;
    const count = def.bool
        ? 2
        : (def.values ? def.values.length : (def.count || (def.mask + 1)));
    const nextRaw = (raw + 1) % count;
    const clearMask = ~(def.mask << def.shift);
    return ((meta & clearMask) | ((nextRaw & def.mask) << def.shift)) & entry.stateMask;
}

/**
 * プロパティオブジェクトから BlockState 値 (localState) を生成する（baseMeta を渡すと差分更新になる）
 */
export function packBlockState(blockId, propsObj, baseMeta = 0) {
    const entry = _stateEntries[blockId & 0xFFF];
    if (!entry) return 0;
    let meta = baseMeta & entry.stateMask;
    if (!propsObj) return meta;
    const keys = Object.keys(propsObj);
    for (let i = 0; i < keys.length; i++) {
        const propName = keys[i];
        const def = entry.schema[propName];
        if (!def) continue;
        meta = _writePropToMeta(def, meta, propsObj[propName]) & entry.stateMask;
    }
    return meta;
}

/**
 * BlockState 値 (localState) を人間が読みやすいプロパティオブジェクトへ展開する（デバッグ・ロジック用）
 */
export function unpackBlockState(blockId, meta) {
    const entry = _stateEntries[blockId & 0xFFF];
    if (!entry) return {};
    const out = {};
    const keys = entry.schemaKeys;
    for (let i = 0; i < keys.length; i++) {
        const propName = keys[i];
        const def = entry.schema[propName];
        out[propName] = _decodePropValue(def, (meta >> def.shift) & def.mask);
    }
    return out;
}

/**
 * F3 HUD やデバッグログ向けに Minecraft Java Edition 準拠の BlockState 文字列を O(1) で取得する
 * 例: "[facing=east,delay=4]" / 状態なしは ""
 */
export function formatBlockStateString(blockId, meta) {
    const entry = _stateEntries[blockId & 0xFFF];
    if (!entry) return "";
    const idx = (meta >= 0 && meta < entry.stateCount) ? meta : 0;
    return entry.stateStrings[idx];
}

/**
 * BlockState から「3D回転・上下反転に使うビット」を事前コンパイル済み transformMask で O(1) 抽出する
 */
export function getTransformMeta(blockId, rawMeta) {
    if (!rawMeta) return 0;
    const entry = _stateEntries[blockId & 0xFFF];
    return entry ? (rawMeta & entry.transformMask) : 0;
}

/**
 * BlockState(meta) に応じた動的発光量 (0..15) を事前ベイク済みテーブルから O(1) 返却する
 */
export function getBlockLightEmissionForState(blockId, meta = 0) {
    const entry = _stateEntries[blockId & 0xFFF];
    if (!entry) return 0;
    const idx = (meta >= 0 && meta < entry.stateCount) ? meta : 0;
    return entry.stateLightLevels[idx];
}

/**
 * BlockState(meta) に応じた事前コンパイル済みバリアント設定を O(1) 取得する
 */
export function getCompiledStateVariant(blockId, meta = 0) {
    const entry = _stateEntries[blockId & 0xFFF];
    if (!entry) return null;
    const idx = (meta >= 0 && meta < entry.stateCount) ? meta : 0;
    return entry.compiledVariants[idx];
}