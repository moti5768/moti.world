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
const _stateEntries = new Array(MAX_STATE_BLOCK_IDS).fill(null);

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
            for (let s = 0; s <= 4 - bits; s++) {
                if (((mask << s) & usedBitMask) === 0) {
                    shift = s;
                    break;
                }
            }
        }

        if (shift === null || shift < 0 || (shift + bits) > 4 || ((mask << shift) & usedBitMask) !== 0) {
            console.error(
                `[BlockState] ブロック "${blockName}" のプロパティ "${propName}" (${bits}bit) が4bit上限を超過または重複しました。`
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

/**
 * スキーマ内の各プロパティの defaultVal から初期 4bit 状態値を計算する
 */
export function getSchemaDefaultState(schema) {
    if (!schema || typeof schema !== "object") return 0;
    let packed = 0;
    const keys = Object.keys(schema);
    for (let i = 0; i < keys.length; i++) {
        const def = schema[keys[i]];
        if (!def || def.defaultVal === undefined) continue;
        packed = _writePropToMeta(def, packed, def.defaultVal);
    }
    return packed & 0xF;
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
        return explicitMask & 0xF;
    }
    let mask = 0;
    if (stateSchema.facing) mask |= (stateSchema.facing.mask << stateSchema.facing.shift);
    if (stateSchema.axis) mask |= (stateSchema.axis.mask << stateSchema.axis.shift);
    if (stateSchema.half) mask |= (stateSchema.half.mask << stateSchema.half.shift);
    return mask & 0xF;
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
    return ((meta & clearMask) | ((raw & def.mask) << def.shift)) & 0xF;
}

/**
 * 数値またはプロパティオブジェクト ({ lit: true, mount: 'floor' }) を 4bit 状態値へ正規化する
 * （オブジェクト指定時はスキーマ側の defaultVal を土台にして差分適用する）
 */
export function normalizeStateValue(schema, stateValue, fallback = 0) {
    if (typeof stateValue === "number") return stateValue & 0xF;
    if (stateValue && typeof stateValue === "object" && schema) {
        let packed = getSchemaDefaultState(schema);
        const keys = Object.keys(stateValue);
        for (let i = 0; i < keys.length; i++) {
            const propName = keys[i];
            const def = schema[propName];
            if (!def) continue;
            packed = _writePropToMeta(def, packed, stateValue[propName]);
        }
        return packed & 0xF;
    }
    return fallback & 0xF;
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
 * ブロック1種の 16状態(0..15) に対するバリアント・発光量・F3文字列を事前コンパイルして登録する
 */
export function compileAndRegisterBlockState(cfg) {
    const id = cfg.id & 0xFFF;
    const schema = cfg.stateSchema || STATE_SCHEMAS.NONE;
    const schemaKeys = Object.keys(schema);

    const stateLightLevels = new Uint8Array(16);
    const compiledVariants = new Array(16).fill(null);
    const stateStrings = new Array(16);
    const variantEntries = cfg.stateVariants ? Object.entries(cfg.stateVariants) : null;

    for (let m = 0; m < 16; m++) {
        // 1. 静的 stateVariants ＋ 動的 resolveStateVisual のマージ
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

        // 2. 状態別発光量の決定
        let light = cfg.lightLevel > 0 ? cfg.lightLevel : 0;
        if (merged && typeof merged.lightLevel === "number") {
            light = merged.lightLevel;
        } else if (typeof cfg.getLightLevel === "function") {
            light = cfg.getLightLevel(m);
        }
        stateLightLevels[m] = light & 15;

        // 3. F3 / デバッグ表示文字列の事前キャッシュ（ランタイム文字列生成をゼロ化）
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

    cfg._stateLightLevels = stateLightLevels;
    cfg._compiledVariants = compiledVariants;
    cfg._stateStrings = stateStrings;

    _stateEntries[id] = {
        id,
        schema,
        schemaKeys,
        transformMask: cfg.transformMask & 0xF,
        defaultState: cfg.defaultState & 0xF,
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
 * ブロックの 4bit BlockState の指定プロパティを書き換えた新しい 4bit 状態値を返す
 */
export function setBlockStateProp(blockId, meta, propName, value) {
    const entry = _stateEntries[blockId & 0xFFF];
    const def = entry && entry.schema[propName];
    if (!def) return meta & 0xF;
    return _writePropToMeta(def, meta, value);
}

/**
 * 指定プロパティを次の値へ巡回（トグル・段階切替）した新しい 4bit 状態値を返す
 */
export function cycleBlockStateProp(blockId, meta, propName) {
    const entry = _stateEntries[blockId & 0xFFF];
    const def = entry && entry.schema[propName];
    if (!def) return meta & 0xF;

    const raw = (meta >> def.shift) & def.mask;
    const count = def.bool
        ? 2
        : (def.values ? def.values.length : (def.count || (def.mask + 1)));
    const nextRaw = (raw + 1) % count;
    const clearMask = ~(def.mask << def.shift);
    return ((meta & clearMask) | ((nextRaw & def.mask) << def.shift)) & 0xF;
}

/**
 * プロパティオブジェクトから 4bit BlockState を生成する（baseMeta を渡すと差分更新になる）
 */
export function packBlockState(blockId, propsObj, baseMeta = 0) {
    const entry = _stateEntries[blockId & 0xFFF];
    if (!entry || !propsObj) return baseMeta & 0xF;
    let meta = baseMeta & 0xF;
    const keys = Object.keys(propsObj);
    for (let i = 0; i < keys.length; i++) {
        const propName = keys[i];
        const def = entry.schema[propName];
        if (!def) continue;
        meta = _writePropToMeta(def, meta, propsObj[propName]);
    }
    return meta;
}

/**
 * 4bit BlockState を人間が読みやすいプロパティオブジェクトへ展開する（デバッグ・ロジック用）
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
    return entry.stateStrings[meta & 15];
}

/**
 * 4bit BlockState から「3D回転・上下反転に使うビット」を事前コンパイル済み transformMask で O(1) 抽出する
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
    return entry ? entry.stateLightLevels[meta & 15] : 0;
}

/**
 * BlockState(meta) に応じた事前コンパイル済みバリアント設定を O(1) 取得する
 */
export function getCompiledStateVariant(blockId, meta = 0) {
    const entry = _stateEntries[blockId & 0xFFF];
    return entry ? entry.compiledVariants[meta & 15] : null;
}