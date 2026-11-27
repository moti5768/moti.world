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

// 草側面オーバーレイ用: 画像が存在しない場合は自動フォールバック（赤黒エラーを出さない）
const optionalOverlayCache = new Map();
const EMPTY_OVERLAY_TEX = (() => {
    const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
})();

function loadOptionalOverlayTexture(path) {
    if (!path) return null;
    if (optionalOverlayCache.has(path)) return optionalOverlayCache.get(path);

    const entry = { tex: EMPTY_OVERLAY_TEX, ready: { value: 0.0 } };
    optionalOverlayCache.set(path, entry);

    textureLoader.load(
        path,
        (tex) => {
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestMipmapNearestFilter;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.generateMipmaps = true;
            tex.needsUpdate = true;
            entry.tex = tex;
            entry.ready.value = 1.0;
        },
        undefined,
        () => {
            // 未配置時は grass_side.png 緑領域の自動オーバーレイへフォールバック
            entry.ready.value = 0.0;
        }
    );
    return entry;
}

// 全ブロックマテリアルで共有する単一 Uniform（昼夜・明るさ変更を O(1) で全チャンクへ即時反映）
export const SHARED_SKY_UNIFORM = { value: 1.0 };
export const SHARED_BRIGHTNESS_UNIFORM = { value: 1.0 };

const DEFAULT_GRASS_TINT = new THREE.Color(0x91BD59);
const DEFAULT_FOLIAGE_TINT = new THREE.Color(0x77AB2F);

function onBeforeCompileBlock(shader, mat) {
    const u = mat.userData && mat.userData.shaderUniforms;
    const biomeTintMode = (u && u.biomeTintMode) ? u.biomeTintMode : 0; // 0:なし, 1:全面着色, 2:側面オーバーレイ
    const defaultTint = (u && u.defaultBiomeTint) ? u.defaultBiomeTint : DEFAULT_GRASS_TINT;

    shader.uniforms.u_skyFactor = SHARED_SKY_UNIFORM;
    shader.uniforms.u_brightness = SHARED_BRIGHTNESS_UNIFORM;
    shader.uniforms.u_isLightSource = (u && u.u_isLightSource) ? u.u_isLightSource : { value: 0.0 };

    if (biomeTintMode > 0) {
        shader.uniforms.u_defaultBiomeTint = { value: defaultTint };
    }
    if (biomeTintMode === 2 && u && u.overlayEntry) {
        shader.uniforms.u_overlayMap = { value: u.overlayEntry.tex };
        shader.uniforms.u_hasOverlayMap = u.overlayEntry.ready;
    }

    const vertexHeader = `
        uniform float u_skyFactor;
        uniform float u_brightness;
        uniform float u_isLightSource;
        ${biomeTintMode > 0 ? `
        attribute vec3 aBiomeColor;
        uniform vec3 u_defaultBiomeTint;
        varying vec3 vBiomeTint;
        ` : ''}
    `;

    const vertexInjection = `
        #include <color_vertex>
        float skyLight = vColor.r;
        float blockLight = vColor.g;

        if (u_isLightSource > 0.5) {
            vColor.rgb = vec3(1.0);
        } else {
            float lit = max(skyLight * u_skyFactor, blockLight) * u_brightness;
            vColor.rgb = vec3(clamp(lit, 0.04, 1.0));
        }
        ${biomeTintMode > 0 ? `
        vBiomeTint = (dot(aBiomeColor, aBiomeColor) > 0.0001) ? aBiomeColor : u_defaultBiomeTint;
        ` : ''}
    `;

    shader.vertexShader = (vertexHeader + shader.vertexShader)
        .replace('#include <color_vertex>', vertexInjection);

    if (biomeTintMode === 1) {
        shader.fragmentShader = `
            varying vec3 vBiomeTint;
            ${shader.fragmentShader}
        `.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
            #ifdef USE_MAP
            float maxC = max(texelColor.r, max(texelColor.g, texelColor.b));
            float minC = min(texelColor.r, min(texelColor.g, texelColor.b));
            // グレースケールテクスチャはそのまま乗算、既存緑テクスチャは明度を保ってバイオーム色へ置換
            float isGray = step(maxC - minC, 0.04);
            float lum = clamp(dot(texelColor.rgb, vec3(0.32, 0.58, 0.10)) * 1.35, 0.0, 1.0);
            vec3 tinted = mix(vec3(lum) * vBiomeTint, texelColor.rgb * vBiomeTint, isGray);
            diffuseColor.rgb = diffuse * tinted;
            #endif`
        );
    } else if (biomeTintMode === 2) {
        shader.fragmentShader = `
            varying vec3 vBiomeTint;
            uniform sampler2D u_overlayMap;
            uniform float u_hasOverlayMap;
            ${shader.fragmentShader}
        `.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
            #ifdef USE_MAP
            if (u_hasOverlayMap > 0.5) {
                vec4 ov = texture2D(u_overlayMap, vUv);
                vec3 ovCol = ov.rgb * vBiomeTint;
                diffuseColor.rgb = diffuse * mix(texelColor.rgb, ovCol, ov.a);
            } else {
                // grass_side_overlay.png 未配置時: 側面の緑フチ領域のみ自動抽出してバイオーム着色
                float isGreenEdge = step(texelColor.r * 1.06, texelColor.g) * step(texelColor.b * 1.06, texelColor.g);
                if (isGreenEdge > 0.5) {
                    float lum = clamp(dot(texelColor.rgb, vec3(0.32, 0.58, 0.10)) * 1.35, 0.0, 1.0);
                    diffuseColor.rgb = diffuse * (vec3(lum) * vBiomeTint);
                }
            }
            #endif`
        );
    }
}

const BLOCK_MATERIALS_CACHE = new Map();
const GLOBAL_BLOCK_MATERIAL_POOL = new Map();
const STATE_MATERIALS_CACHE = new Map();
const FACE_ORDER = ["east", "west", "top", "bottom", "south", "north"];
const _shaderKeyNone = () => 'mc_block_light_v3_0';
const _shaderKeyTint = () => 'mc_block_light_v3_1';
const _shaderKeyOverlay = () => 'mc_block_light_v3_2';

export function getOrCreateSharedBlockMaterial(texPath, config, props, override = null, faceName = null) {
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

    const biomeTintType = (override && override.biomeTint !== undefined) ? override.biomeTint : (config.biomeTint || null);
    const sideOverlayPath = (override && override.sideOverlay !== undefined) ? override.sideOverlay : (config.sideOverlay || null);

    let biomeTintMode = 0;
    let overlayEntry = null;
    if (biomeTintType) {
        if (sideOverlayPath) {
            if (faceName === "top") biomeTintMode = 1;
            else if (faceName !== "bottom") {
                biomeTintMode = 2;
                overlayEntry = loadOptionalOverlayTexture(sideOverlayPath);
            }
        } else {
            biomeTintMode = 1;
        }
    }

    const poolKey = `${keyPath}|${props.isBlendTransparent ? 1 : 0}|${opacity}|${alphaTest}|${props.side}|${depthWrite ? 1 : 0}|${isLightSource}|${defaultColor}|${biomeTintMode}|${biomeTintType || ""}|${sideOverlayPath || ""}`;
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
        u_isLightSource: { value: isLightSource ? 1.0 : 0.0 },
        biomeTintMode,
        defaultBiomeTint: (biomeTintType === "foliage") ? DEFAULT_FOLIAGE_TINT : DEFAULT_GRASS_TINT,
        overlayEntry
    };
    mat.userData.isShared = true;
    mat.customProgramCacheKey = (biomeTintMode === 2) ? _shaderKeyOverlay : ((biomeTintMode === 1) ? _shaderKeyTint : _shaderKeyNone);
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

        result[i] = getOrCreateSharedBlockMaterial(texPath, config, props, stateOverride, face);
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