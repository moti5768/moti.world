import * as THREE from "./build/three.module.js";
"use strict";

let cloudTiles = new Map();
const tileSize = 500;
const gridRadius = 6;
let cloudTexture = null;

/**
 * クラウドテクスチャを読み込み、黒背景を透明化＋パディング
 */
function loadCloudTexture(callback) {
    new THREE.TextureLoader().load(
        'textures/clouds.png',
        texture => {
            const img = texture.image, b = 2;
            const w = img.width, h = img.height;
            const canvas = document.createElement('canvas');
            canvas.width = w + b * 2;
            canvas.height = h + b * 2;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, b, b);
            // 上下左右の境界コピーをまとめて処理
            [
                [0, 0, w, 1, b, 0, w, 1],
                [0, h - 1, w, 1, b, h + b, w, 1],
                [0, 0, 1, h, 0, b, 1, h],
                [w - 1, 0, 1, h, w + b, b, 1, h]
            ].forEach(a => ctx.drawImage(img, ...a));

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                if (!(data[i] | data[i + 1] | data[i + 2])) data[i + 3] = 0;
            }
            ctx.putImageData(imageData, 0, 0);

            const tex = new THREE.CanvasTexture(canvas);
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(0.06, 0.06);
            tex.magFilter = tex.minFilter = THREE.NearestFilter;
            tex.generateMipmaps = false;
            tex.anisotropy = 4;
            tex.offset.set(0, 0); // 初期 offset を0に固定
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
function setMinecraftSky(scene) {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, "#000066");
    grad.addColorStop(1, "#87ceeb");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestMipmapNearestFilter;
    scene.background = tex;
}

/**
 * 雲タイル生成（UVはワールド座標基準でスナップ）
 */
function addCloudTile(scene, gridX, gridZ) {
    if (!cloudTexture) return;
    const geo = new THREE.PlaneGeometry(tileSize, tileSize);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: 1,
        alphaTest: 1,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: true
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.material.opacity = 0;        // 初期透明化
    mesh.userData.fadeFactor = 0;     // フェード用フラグ
    const px = gridX * tileSize + tileSize / 2;
    const pz = gridZ * tileSize + tileSize / 2;
    mesh.position.set(px, 256, pz);

    const texW = cloudTexture.image.width;
    const uvScale = 1 / tileSize;
    const pos = geo.attributes.position.array;
    const uvs = geo.attributes.uv.array;
    for (let i = 0, j = 0; j < uvs.length; i += 3, j += 2) {
        // 元のスナップ方式でUV計算
        uvs[j] = Math.floor((px + pos[i]) * uvScale * texW) / texW;
        uvs[j + 1] = Math.floor((pz + pos[i + 2]) * uvScale * texW) / texW;
    }
    geo.attributes.uv.needsUpdate = true;
    scene.add(mesh);
    return mesh;
}

/**
 * プレイヤー位置に基づき雲タイルを更新
 */
function updateCloudGrid(scene, playerPos) {
    const gx = Math.floor(playerPos.x / tileSize);
    const gz = Math.floor(playerPos.z / tileSize);
    const needed = new Set();

    for (let x = gx - gridRadius; x <= gx + gridRadius; x++) {
        for (let z = gz - gridRadius; z <= gz + gridRadius; z++) {
            const key = `${x},${z}`;
            needed.add(key);
            if (!cloudTiles.has(key)) {
                const tile = addCloudTile(scene, x, z);
                if (tile) {
                    tile.userData.fadeFactor = 1;
                    cloudTiles.set(key, tile);
                }
            }
        }
    }
    // 不要タイル削除
    for (const [key, tile] of cloudTiles) {
        if (!needed.has(key)) {
            scene.remove(tile);
            tile.geometry.dispose();
            tile.material.dispose();
            cloudTiles.delete(key);
        }
    }
}

/**
 * 雲テクスチャのオフセット更新
 */
function updateCloudTiles(delta) {
    if (!cloudTexture) return;
    let off = cloudTexture.offset.x + 0.0005 * delta;
    cloudTexture.offset.x = off >= 1 ? off - 1 : off;
}

/**
 * 距離に応じた雲の不透明度更新
 */
function updateCloudOpacity(playerPos) {
    const nearD2 = 2000 ** 2;
    const farD2 = 6000 ** 2;
    cloudTiles.forEach(tile => {
        const dist2 = tile.position.distanceToSquared(playerPos);
        let baseOpacity = 1;
        if (dist2 > nearD2 && dist2 < farD2) {
            baseOpacity = 1 - ((Math.sqrt(dist2) - 2000) / 4000);
        } else if (dist2 >= farD2) {
            baseOpacity = 0;
        }
        tile.userData.fadeFactor = Math.min((tile.userData.fadeFactor ?? 0) + 0.05, 1); // フェードイン
        tile.material.opacity = baseOpacity * tile.userData.fadeFactor;
    });
}

/**
 * カメラ高さに応じた描画順序調整
 */
function adjustCloudLayerDepth(tile, camera) {
    const above = camera.position.y >= tile.position.y;
    tile.renderOrder = above ? 1000 : 0;
    tile.material.depthTest = !above;
}

// グローバル公開
window.setMinecraftSky = setMinecraftSky;
window.loadCloudTexture = loadCloudTexture;
window.updateCloudGrid = updateCloudGrid;
window.updateCloudTiles = updateCloudTiles;
window.updateCloudOpacity = updateCloudOpacity;
window.adjustCloudLayerDepth = adjustCloudLayerDepth;