"use strict";
import * as THREE from '../build/three.module.js';

/* ======================================================
   【テクスチャ＆跨ブロック共有マテリアルプール】(blocks/materials.js)
   - 非アトラス個別テクスチャ運用を前提とした重複排除キャッシュ
   - 全ブロック共有 Uniform (SHARED_SKY_UNIFORM / SHARED_BRIGHTNESS_UNIFORM) で O(1) 昼夜・明るさ更新
   ====================================================== */

const ERROR_TEXTURE = (() => {
    const data = new Uint8Array([
        255, 0, 255, 255, 0, 0, 0, 255,
        0, 0, 0, 255, 255, 0, 255, 255
    ]); // 2x2 マゼンタ/ブラック
    const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
})();

const loadingManager = new THREE.LoadingManager();
loadingManager.maxConnections = 16;

const textureLoader = new THREE.TextureLoader(loadingManager);
const textureCache = new Map();
const failedTextureCache = new Set();

export function cachedLoadTexture(path, fallback = null) {
    if (!path || path === "" || path === "none" || failedTextureCache.has(path)) {
        if (fallback && fallback !== path && !failedTextureCache.has(fallback)) {
            return cachedLoadTexture(fallback, null);
        }
        return ERROR_TEXTURE;
    }

    if (textureCache.has(path)) return textureCache.get(path);

    const placeholder = new THREE.Texture();
    placeholder.image = ERROR_TEXTURE.image;
    placeholder.magFilter = ERROR_TEXTURE.magFilter;
    placeholder.wrapS = THREE.RepeatWrapping;
    placeholder.wrapT = THREE.RepeatWrapping;
    placeholder.needsUpdate = true;

    textureCache.set(path, placeholder);

    textureLoader.load(
        path,
        (tex) => {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestMipmapNearestFilter;
            tex.generateMipmaps = true;
            placeholder.image = tex.image;
            placeholder.magFilter = tex.magFilter;
            placeholder.minFilter = tex.minFilter;
            placeholder.wrapS = THREE.RepeatWrapping;
            placeholder.wrapT = THREE.RepeatWrapping;
            placeholder.needsUpdate = true;
        },
        undefined,
        () => {
            console.error(`[Texture] Failed to load: ${path}`);
            failedTextureCache.add(path);

            if (fallback && fallback !== path && !failedTextureCache.has(fallback)) {
                textureLoader.load(fallback, (fbTex) => {
                    placeholder.image = fbTex.image;
                    placeholder.magFilter = THREE.NearestFilter;
                    placeholder.needsUpdate = true;
                }, undefined, () => {
                    failedTextureCache.add(fallback);
                });
            }
        }
    );

    return placeholder;
}

// 全ブロックマテリアルで共有する単一 Uniform（昼夜・明るさ変更を O(1) で全チャンクへ即時反映）
export const SHARED_SKY_UNIFORM = { value: 1.0 };
export const SHARED_BRIGHTNESS_UNIFORM = { value: 1.0 };

function onBeforeCompileBlock(shader, mat) {
    const u = mat.userData && mat.userData.shaderUniforms;
    shader.uniforms.u_skyFactor = SHARED_SKY_UNIFORM;
    shader.uniforms.u_brightness = SHARED_BRIGHTNESS_UNIFORM;
    shader.uniforms.u_isLightSource = (u && u.u_isLightSource) ? u.u_isLightSource : { value: 0.0 };

    const vertexInjection = `
        #include <color_vertex>
        // vColor.r に空の明るさ(0..1)、vColor.g にブロックの明るさ(0..1)が Uint8 正規化で格納されている
        float skyLight = vColor.r;
        float blockLight = vColor.g;

        if (u_isLightSource > 0.5) {
            vColor.rgb = vec3(1.0);
        } else {
            // 明るい方の光を採用し、明るさ設定を O(1) Uniform で適用
            float lit = max(skyLight * u_skyFactor, blockLight) * u_brightness;
            vColor.rgb = vec3(clamp(lit, 0.04, 1.0));
        }
    `;

    shader.vertexShader = `
        uniform float u_skyFactor;
        uniform float u_brightness;
        uniform float u_isLightSource;
        ${shader.vertexShader}
    `.replace('#include <color_vertex>', vertexInjection);
}

const BLOCK_MATERIALS_CACHE = new Map();
const GLOBAL_BLOCK_MATERIAL_POOL = new Map();
const STATE_MATERIALS_CACHE = new Map();
const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];
const _blockShaderCacheKey = () => 'mc_block_light_v2';

export function getOrCreateSharedBlockMaterial(texPath, config, props, override = null) {
    const opacity = (override && override.opacity !== undefined) ? override.opacity : (config.opacity ?? 1.0);
    const defaultColor = (override && override.defaultColor !== undefined) ? override.defaultColor : (config.defaultColor ?? 0xffffff);
    const alphaTest = props.isAlphaCutout ? 0.5 : 0;
    const depthWrite = props.isBlendTransparent ? false : true;
    const isLightSource = (override && override.isLightSource !== undefined)
        ? (override.isLightSource ? 1 : 0)
        : ((override && typeof override.lightLevel === "number")
            ? (override.lightLevel > 0 ? 1 : 0)
            : (config.lightLevel > 0 ? 1 : 0));
    const keyPath = (texPath && texPath !== "none") ? texPath : "__none__";

    const poolKey = `${keyPath}|${props.isBlendTransparent ? 1 : 0}|${opacity}|${alphaTest}|${props.side}|${depthWrite ? 1 : 0}|${isLightSource}|${defaultColor}`;
    const existing = GLOBAL_BLOCK_MATERIAL_POOL.get(poolKey);
    if (existing !== undefined) return existing;

    const mat = new THREE.MeshBasicMaterial({
        color: defaultColor,
        transparent: props.isBlendTransparent,
        opacity,
        vertexColors: true,
        side: props.side,
        depthWrite,
        alphaTest,
        map: (texPath && texPath !== "none") ? cachedLoadTexture(texPath, config.fallbackTexture) : null
    });

    mat.userData.shaderUniforms = {
        u_skyFactor: SHARED_SKY_UNIFORM,
        u_brightness: SHARED_BRIGHTNESS_UNIFORM,
        u_isLightSource: { value: isLightSource ? 1.0 : 0.0 }
    };
    mat.userData.isShared = true;
    mat.customProgramCacheKey = _blockShaderCacheKey;
    mat.onBeforeCompile = (shader) => onBeforeCompileBlock(shader, mat);

    GLOBAL_BLOCK_MATERIAL_POOL.set(poolKey, mat);
    return mat;
}

/**
 * ブロック設定＋事前コンパイル済み BlockState バリアントから6面マテリアル配列を汎用生成する
 */
export function createMaterialsFromBlockConfig(config, stateOverride = null) {
    const gType = config.geometryType;
    const isWater = (gType === "water") || !!config.isWater;
    const effOpacity = (stateOverride && stateOverride.opacity !== undefined) ? stateOverride.opacity : (config.opacity ?? 1.0);
    const isBlendTransparent = isWater && (effOpacity < 1.0);
    const isDoubleSide = (gType === "cross" || gType === "leaves" || gType === "ladder" || gType === "wire");

    const isAlphaCutout = !isWater && (
        config.alphaCutout === true ||
        gType === "cross" ||
        gType === "leaves" ||
        gType === "ladder" ||
        gType === "pane" ||
        (gType === "cube" && config.transparent === true)
    );

    const props = {
        isBlendTransparent,
        isAlphaCutout,
        side: (isDoubleSide || isWater) ? THREE.DoubleSide : THREE.FrontSide
    };

    // Java Edition JSON モデル由来: modelTextures 配列があれば各 materialIndex 分の共有マテリアル配列を生成
    if (stateOverride && Array.isArray(stateOverride.modelTextures) && stateOverride.modelTextures.length > 0) {
        const list = stateOverride.modelTextures;
        const result = new Array(list.length);
        for (let i = 0; i < list.length; i++) {
            result[i] = getOrCreateSharedBlockMaterial(list[i], config, props, stateOverride);
        }
        return result;
    }

    const textures = (stateOverride && stateOverride.textures)
        ? { ...config.textures, ...stateOverride.textures }
        : config.textures;

    const result = new Array(6);

    for (let i = 0; i < 6; i++) {
        const face = FACE_ORDER[i];
        const texPath = textures?.[face] || textures?.all ||
            ((face !== "top" && face !== "bottom") ? textures?.side : null) ||
            textures?.top || textures?.bottom || config.fallbackTexture;

        result[i] = getOrCreateSharedBlockMaterial(texPath, config, props, stateOverride);
    }
    return result;
}

export function getBlockMaterialsForConfig(config) {
    if (!config) return null;
    const bId = config.id & 0xFFF;
    if (BLOCK_MATERIALS_CACHE.has(bId)) return BLOCK_MATERIALS_CACHE.get(bId);

    const stateCount = config.stateCount || 1;
    const rawDefault = (config.previewState !== null && config.previewState !== undefined)
        ? config.previewState
        : (config.defaultState ?? 0);
    const defaultMeta = (rawDefault >= 0 && rawDefault < stateCount) ? rawDefault : 0;
    const override = config._compiledVariants ? config._compiledVariants[defaultMeta] : null;
    const materials = createMaterialsFromBlockConfig(config, override);
    BLOCK_MATERIALS_CACHE.set(bId, materials);
    return materials;
}

export function getBlockMaterialsForStateConfig(config, meta = 0) {
    if (!config) return null;
    if (!config.hasStateMaterials) return getBlockMaterialsForConfig(config);

    const bId = config.id & 0xFFF;
    const stateCount = config.stateCount || 1;
    const m = (meta >= 0 && meta < stateCount) ? meta : 0;
    const stateKey = (bId << 12) | (m & 0xFFF);
    const cached = STATE_MATERIALS_CACHE.get(stateKey);
    if (cached !== undefined) return cached;

    const override = config._compiledVariants ? config._compiledVariants[m] : null;
    const mats = createMaterialsFromBlockConfig(config, override);
    STATE_MATERIALS_CACHE.set(stateKey, mats);
    return mats;
}

export function invalidateBlockMaterialCache(blockId = null) {
    if (blockId === null) {
        BLOCK_MATERIALS_CACHE.clear();
        STATE_MATERIALS_CACHE.clear();
        return;
    }
    const bId = blockId & 0xFFF;
    BLOCK_MATERIALS_CACHE.delete(bId);
    for (const key of STATE_MATERIALS_CACHE.keys()) {
        if ((key >>> 12) === bId) {
            STATE_MATERIALS_CACHE.delete(key);
        }
    }
}