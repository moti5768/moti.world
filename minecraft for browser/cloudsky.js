"use strict";
import * as THREE from "./build/three.module.js";

// 単一メッシュ雲レイヤー設定（169ドローコール -> 1ドローコールへ統合）
const CLOUD_ALTITUDE = 256;
const CLOUD_PLANE_SIZE = 4000;
// 元のスケール（500ブロックあたり0.06リピート）と100%同一の密度を維持
const CLOUD_UV_PER_BLOCK = 0.06 / 500;
const CLOUD_REPEAT = CLOUD_PLANE_SIZE * CLOUD_UV_PER_BLOCK;

let cloudTexture = null;
let cloudMesh = null;
let cloudMaterial = null;
let cloudScrollX = 0;
let lastSkyFactor = -1;
let lastCloudAbove = null;

function wrapUnit(v) {
    const r = v % 1;
    return r < 0 ? r + 1 : r;
}

/**
 * クラウドテクスチャを読み込み、黒背景を透明化
 */
export function loadCloudTexture(callback) {
    new THREE.TextureLoader().load(
        'textures/environment/clouds.png',
        texture => {
            const img = texture.image;
            const w = img.width, h = img.height;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, 0, 0);

            const imageData = ctx.getImageData(0, 0, w, h);
            const data = imageData.data;
            for (let i = 0, len = data.length; i < len; i += 4) {
                if (!(data[i] | data[i + 1] | data[i + 2])) data[i + 3] = 0;
            }
            ctx.putImageData(imageData, 0, 0);

            const tex = new THREE.CanvasTexture(canvas);
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(CLOUD_REPEAT, CLOUD_REPEAT);
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.anisotropy = 1;
            tex.offset.set(0, 0);
            tex.needsUpdate = true;

            cloudTexture = tex;
            callback && callback();
        },
        undefined,
        err => console.error("Error loading cloud texture", err)
    );
}

/**
 * Minecraft風の青空背景
 */
export function setMinecraftSky(scene) {
    scene.background = null;
    scene.environment = null;
}

/**
 * 単一雲レイヤー（円形距離フェードシェーダー付き）を1回だけ生成
 */
function ensureCloudMesh(scene) {
    if (cloudMesh || !cloudTexture) return cloudMesh;

    const geo = new THREE.PlaneGeometry(CLOUD_PLANE_SIZE, CLOUD_PLANE_SIZE);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: false
    });

    // プレーン端が遠方で角切れないよう、水平距離 1100..1950 で円形に滑らかフェードアウト
    mat.customProgramCacheKey = () => 'mc_cloud_single_plane_v1';
    mat.onBeforeCompile = (shader) => {
        shader.vertexShader = `
            varying vec2 vCloudLocalXZ;
            ${shader.vertexShader}
        `.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            vCloudLocalXZ = position.xz;`
        );

        shader.fragmentShader = `
            varying vec2 vCloudLocalXZ;
            ${shader.fragmentShader}
        `.replace(
            '#include <dithering_fragment>',
            `float cloudDist = length(vCloudLocalXZ);
            float cloudEdgeFade = 1.0 - smoothstep(1100.0, 1950.0, cloudDist);
            gl_FragColor.a *= cloudEdgeFade;
            if (gl_FragColor.a <= 0.004) discard;
            #include <dithering_fragment>`
        );
    };

    const initialFactor = lastSkyFactor < 0 ? 1.0 : lastSkyFactor;
    mat.color.setScalar(initialFactor);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, CLOUD_ALTITUDE, 0);
    // 雲は水面(renderOrder=10)より先に描き、半透明水面越しに空と雲が正しく合成されるようにする
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;

    scene.add(mesh);
    cloudMesh = mesh;
    cloudMaterial = mat;
    return mesh;
}

/**
 * プレイヤー位置に基づき単一雲プレーンと UV オフセットを O(1) で同期
 */
export function updateCloudGrid(scene, playerPos) {
    if (!cloudTexture) return;
    const mesh = ensureCloudMesh(scene);
    if (!mesh) return;

    const px = playerPos.x;
    const pz = playerPos.z;
    mesh.position.set(px, CLOUD_ALTITUDE, pz);

    // プレーン追従分を UV オフセットで厳密に打ち消し、雲がワールド空間に固定されて流れるようにする
    cloudTexture.offset.set(
        wrapUnit(px * CLOUD_UV_PER_BLOCK + cloudScrollX),
        wrapUnit(-pz * CLOUD_UV_PER_BLOCK)
    );
}

/**
 * 雲の風スクロール進行
 */
export function updateCloudTiles(delta) {
    if (!cloudTexture) return;
    cloudScrollX = wrapUnit(cloudScrollX + 0.0005 * delta);
}

/**
 * 昼夜サイクルに応じた雲の明るさ（色）を O(1) 更新
 */
export function updateCloudOpacity(playerPos, currentSkyFactor = 1.0) {
    if (!cloudMaterial) return;
    if (currentSkyFactor !== lastSkyFactor) {
        cloudMaterial.color.setScalar(currentSkyFactor);
        lastSkyFactor = currentSkyFactor;
    }
}

/**
 * カメラ高さに応じた雲レイヤーの描画順序を O(1) 調整（needsUpdate 再コンパイル不要）
 */
export function adjustCloudLayerDepth(tileOrUnused, camera) {
    if (!cloudMesh || !camera) return;
    const above = camera.position.y >= CLOUD_ALTITUDE;
    if (above === lastCloudAbove) return;

    // 雲の下にいるときは水面(10)より前(5)、雲の上にいるときは水面(10)より後(15)で正しく前後合成
    cloudMesh.renderOrder = above ? 15 : 5;
    lastCloudAbove = above;
}