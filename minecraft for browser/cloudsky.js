"use strict";
import * as THREE from "./build/three.module.js";

let cloudTiles = new Map();
const tileSize = 500;
const gridRadius = 6;
let cloudTexture = null;

// ==========================================
// 💡 軽量化用の共有変数・キャッシュ
// ==========================================
const _neededKeys = new Set(); // 毎フレームの new Set() によるメモリ確保を排除

// 座標 (x, z) を 32bit の数値1つに圧縮するハッシュ関数 (文字列キーを排除)
function getTileHash(x, z) {
    return ((x + 20000) << 16) | ((z + 20000) & 0xFFFF);
}

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

            const edgeData = [
                [0, 0, w, 1, b, 0, w, 1],
                [0, h - 1, w, 1, b, h + b, w, 1],
                [0, 0, 1, h, 0, b, 1, h],
                [w - 1, 0, 1, h, w + b, b, 1, h]
            ];
            for (let i = 0; i < edgeData.length; i++) {
                ctx.drawImage(img, ...edgeData[i]);
            }

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const len = data.length;

            for (let i = 0; i < len; i += 4) {
                if (!(data[i] | data[i + 1] | data[i + 2])) data[i + 3] = 0;
            }
            ctx.putImageData(imageData, 0, 0);

            const tex = new THREE.CanvasTexture(canvas);
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(0.06, 0.06);

            // 🌟 連鎖代入をやめ、個別に代入して確実にピクセルアート設定を適用 🌟
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;

            tex.generateMipmaps = false;
            tex.anisotropy = 1; // 💡 遠くがボケる場合、異方性フィルタを 1 (無効) にするとよりクッキリします
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
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: true
    });

    const mesh = new THREE.Mesh(geo, mat);
    const px = gridX * tileSize + tileSize / 2;
    const pz = gridZ * tileSize + tileSize / 2;
    mesh.position.set(px, 256, pz);

    const texW = cloudTexture.image.width;
    const uvScale = 1 / tileSize;
    const pos = geo.attributes.position.array;
    const uvs = geo.attributes.uv.array;
    const uvLen = uvs.length; // 配列長のキャッシュ

    for (let i = 0, j = 0; j < uvLen; i += 3, j += 2) {
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
    if (!cloudTexture) return;

    const gx = Math.floor(playerPos.x / tileSize);
    const gz = Math.floor(playerPos.z / tileSize);

    _neededKeys.clear(); // 既存の Set を再利用

    for (let x = gx - gridRadius; x <= gx + gridRadius; x++) {
        for (let z = gz - gridRadius; z <= gz + gridRadius; z++) {
            const key = getTileHash(x, z); // 数値ハッシュ化
            _neededKeys.add(key);

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
        if (!_neededKeys.has(key)) {
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
    const nearD2 = 4000000;  // 2000 ** 2 をあらかじめ定数化
    const farD2 = 36000000; // 6000 ** 2 をあらかじめ定数化

    cloudTiles.forEach(tile => {
        const dist2 = tile.position.distanceToSquared(playerPos);
        let baseOpacity = 1;

        if (dist2 > nearD2 && dist2 < farD2) {
            // 平方根（重い計算）は範囲内に入った時だけ行う
            baseOpacity = 1 - ((Math.sqrt(dist2) - 2000) / 4000);
        } else if (dist2 >= farD2) {
            baseOpacity = 0;
        }

        tile.userData.fadeFactor = Math.min((tile.userData.fadeFactor ?? 0) + 0.05, 1);
        tile.material.opacity = baseOpacity * tile.userData.fadeFactor;
    });
}

/**
 * カメラ高さに応じた描画順序調整
 */
function adjustCloudLayerDepth(tile, camera) {
    const above = camera.position.y >= tile.position.y;

    if (above) {
        tile.renderOrder = 0;
        tile.material.depthTest = true;
        tile.material.depthWrite = false;
    } else {
        tile.renderOrder = -100;
        tile.material.depthTest = true;
        tile.material.depthWrite = false;
    }

    tile.material.needsUpdate = true;
}

// グローバル公開
window.setMinecraftSky = setMinecraftSky;
window.loadCloudTexture = loadCloudTexture;
window.updateCloudGrid = updateCloudGrid;
window.updateCloudTiles = updateCloudTiles;
window.updateCloudOpacity = updateCloudOpacity;
window.adjustCloudLayerDepth = adjustCloudLayerDepth;