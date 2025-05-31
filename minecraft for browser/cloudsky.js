import * as THREE from "./build/three.module.js";
"use strict";

// グローバル変数
let cloudTiles = new Map(); // "gridX,gridZ" キーごとに各雲タイルを保持
const tileSize = 500;      // 各タイルのサイズ
const gridRadius = 6;       // プレイヤー周辺に生成するグリッドの半径
let cloudTexture = null;    // 全タイルで共有する雲テクスチャ

/**
 * クラウドテクスチャを読み込み、画像内の黒（背景色）を透明に変換します。
 * （パディングも適用）
 */
function loadCloudTexture(callback) {
    const loader = new THREE.TextureLoader();
    loader.load(
        'textures/clouds.png',
        function (texture) {
            console.log("Cloud texture loaded successfully with border padding.");
            const image = texture.image;
            // パディングサイズは 2ピクセル（必要に応じて変更可能）
            const border = 2;
            const paddedWidth = image.width + 2 * border;
            const paddedHeight = image.height + 2 * border;
            const canvas = document.createElement('canvas');
            canvas.width = paddedWidth;
            canvas.height = paddedHeight;
            const ctx = canvas.getContext('2d');

            // キャンバスでの描画時に補間をしない（シャープに描画するため）
            ctx.imageSmoothingEnabled = false;

            // 中央に元画像を描く
            ctx.drawImage(image, border, border);

            // エッジ部を複製して余白を埋める（上端、下端、左右・四隅）
            ctx.drawImage(canvas,
                border, border, image.width, 1,
                border, 0, image.width, 1);
            ctx.drawImage(canvas,
                border, image.height + border - 1, image.width, 1,
                border, image.height + border, image.width, 1);
            ctx.drawImage(canvas,
                border, border, 1, image.height,
                0, border, 1, image.height);
            ctx.drawImage(canvas,
                image.width + border - 1, border, 1, image.height,
                image.width + border, border, 1, image.height);
            ctx.drawImage(canvas,
                border, border, 1, 1,
                0, 0, 1, 1);
            ctx.drawImage(canvas,
                image.width + border - 1, border, 1, 1,
                image.width + border, 0, 1, 1);
            ctx.drawImage(canvas,
                border, image.height + border - 1, 1, 1,
                0, image.height + border, 1, 1);
            ctx.drawImage(canvas,
                image.width + border - 1, image.height + border - 1, 1, 1,
                image.width + border, image.height + border, 1, 1);

            // 黒ピクセル（背景）を透明に
            const imageData = ctx.getImageData(0, 0, paddedWidth, paddedHeight);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) {
                    data[i + 3] = 0;
                }
            }
            ctx.putImageData(imageData, 0, 0);

            // 新規テクスチャ生成
            const newTexture = new THREE.CanvasTexture(canvas);
            newTexture.wrapS = THREE.RepeatWrapping;
            newTexture.wrapT = THREE.RepeatWrapping;
            // 今回はテクスチャ自体の repeat は 1,1 としておき、UV のスケールで調整します
            newTexture.repeat.set(0.06, 0.06);
            newTexture.magFilter = THREE.NearestFilter;
            newTexture.minFilter = THREE.NearestFilter;
            newTexture.generateMipmaps = false;
            newTexture.anisotropy = 4;
            newTexture.needsUpdate = true;

            cloudTexture = newTexture;
            if (callback) {
                callback();
            }
        },
        undefined,
        function (err) {
            console.error("Error loading cloud texture", err);
        }
    );
}

/**
 * Minecraft風の青空背景の設定
 */
function setMinecraftSky(scene) {
    const canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#000066");
    gradient.addColorStop(1, "#87ceeb");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapNearestFilter;
    scene.background = texture;
}

/**
 * UV座標をテクセルグリッドに合わせるためのヘルパー関数
 * @param {number} worldCoord - ワールド座標
 * @param {number} uvScale - uvScale (例: 1/tileSize)
 * @param {number} textureSize - テクスチャのピクセルサイズ（横幅または縦幅）
 * @returns {number} - スナップ後のUV座標
 */
function snapUV(worldCoord, uvScale, textureSize) {
    const pixelPos = worldCoord * uvScale * textureSize;
    const snappedPixelPos = Math.round(pixelPos);
    return snappedPixelPos / textureSize;
}

/**
 * 指定したグリッド座標 (gridX, gridZ) において雲タイル（平面）を生成しシーンに追加
 * （各タイルの UV をワールド座標に基づいて計算することで、すべてのタイルが同じテクスチャ空間を参照するようにします）
 */
function addCloudTile(scene, gridX, gridZ) {
    if (!cloudTexture) return;
    // タイルサイズのジオメトリ生成
    const geometry = new THREE.PlaneGeometry(tileSize, tileSize);
    // 2Dの平面を地面に合わせるため X 軸で回転（これによりローカル座標は [x, 0, z] になる）
    geometry.rotateX(-Math.PI / 2);

    // マテリアル定義
    const material = new THREE.MeshBasicMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: 1,
        alphaTest: 1,  // この値は元画像のエッジのアルファ状況に合わせ調整
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        fog: true
    });

    const mesh = new THREE.Mesh(geometry, material);
    // 各タイルは、グリッド座標から決まる一意のワールド位置に配置
    mesh.position.set(
        gridX * tileSize + tileSize / 2,
        256, // 雲の高さ（固定）
        gridZ * tileSize + tileSize / 2
    );

    // ★ここでUVをワールド座標に基づいて再計算し、テクセルグリッドにスナップする★
    const textureWidth = cloudTexture.image.width; // ここでは正方形テクスチャを想定
    const uvScale = 1 / tileSize;
    const positions = geometry.attributes.position.array;
    const uvs = geometry.attributes.uv.array;
    for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
        const worldX = mesh.position.x + positions[i];
        const worldZ = mesh.position.z + positions[i + 2];
        uvs[j] = snapUV(worldX, uvScale, textureWidth);
        uvs[j + 1] = snapUV(worldZ, uvScale, textureWidth);
    }
    geometry.attributes.uv.needsUpdate = true;
    scene.add(mesh);
    return mesh;
}

/**
 * プレイヤー（またはカメラ）の位置に基づいて必要な雲タイルのグリッドを更新
 * （不要なタイルは削除、新しいタイルは追加）
 * @param {THREE.Scene} scene - 対象シーン
 * @param {THREE.Vector3} playerPos - プレイヤーの現在位置
 * @param {number} delta - 経過時間（秒）
 */
function updateCloudGrid(scene, playerPos, delta) {
    const currentGridX = Math.floor(playerPos.x / tileSize);
    const currentGridZ = Math.floor(playerPos.z / tileSize);
    const requiredTiles = new Set();

    for (let x = currentGridX - gridRadius; x <= currentGridX + gridRadius; x++) {
        for (let z = currentGridZ - gridRadius; z <= currentGridZ + gridRadius; z++) {
            const key = `${x},${z}`;
            requiredTiles.add(key);
            if (!cloudTiles.has(key)) {
                const tile = addCloudTile(scene, x, z);
                if (tile) {
                    tile.userData.fadeFactor = 1;
                    cloudTiles.set(key, tile);
                }
            }
        }
    }

    // 不要なタイルはシーンから削除
    for (let key of Array.from(cloudTiles.keys())) {
        if (!requiredTiles.has(key)) {
            const tile = cloudTiles.get(key);
            scene.remove(tile);
            tile.geometry.dispose();
            tile.material.dispose();
            cloudTiles.delete(key);
        }
    }
}

/**
 * 全タイルで共有する雲テクスチャのオフセットを更新し、流れる雲を演出
 * @param {number} delta - 前フレームからの経過時間
 */
function updateCloudTiles(delta) {
    if (!cloudTexture) return;
    const offsetSpeed = 0.0005;
    cloudTexture.offset.x += offsetSpeed * delta;
    if (cloudTexture.offset.x >= 1) {
        cloudTexture.offset.x -= 1;
    }
}

/**
 * プレイヤー（カメラ）との距離に応じて各タイルの不透明度を更新
 * @param {THREE.Vector3} playerPos - プレイヤーの位置
 */
function updateCloudOpacity(playerPos) {
    const nearDistance = 2000;
    const farDistance = 6000;
    cloudTiles.forEach(tile => {
        const distance = tile.position.distanceTo(playerPos);
        let baseOpacity = 1;
        if (distance <= nearDistance) {
            baseOpacity = 1;
        } else if (distance >= farDistance) {
            baseOpacity = 0;
        } else {
            baseOpacity = 1 - ((distance - nearDistance) / (farDistance - nearDistance));
        }
        const fadeFactor = tile.userData.fadeFactor !== undefined ? tile.userData.fadeFactor : 1;
        tile.material.opacity = baseOpacity * fadeFactor;
    });
}

/**
 * カメラの位置に応じて各雲タイルの描画順序／深度テストの設定を調整する補助関数
 */
function adjustCloudLayerDepth(tile, camera) {
    if (camera.position.y >= tile.position.y) {
        tile.renderOrder = 1000;
        tile.material.depthTest = false;
    } else {
        tile.renderOrder = 0;
        tile.material.depthTest = true;
    }
}

// グローバルに関数を公開
window.setMinecraftSky = setMinecraftSky;
window.loadCloudTexture = loadCloudTexture;
window.updateCloudGrid = updateCloudGrid;
window.updateCloudTiles = updateCloudTiles;
window.updateCloudOpacity = updateCloudOpacity;
window.adjustCloudLayerDepth = adjustCloudLayerDepth;
