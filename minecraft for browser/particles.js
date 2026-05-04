"use strict";
import * as THREE from './build/three.module.js';
import { camera, scene, getVoxelAtWorld, ChunkSaveManager, blockCollisionBoxCache } from './script.js';
import { getBlockMaterials, BLOCK_TYPES, getBlockConfiguration, applyRotationToCollisionBox } from './blocks.js';
/* ======================================================
   【統合・最適化】パーティクルシステム（マイクラ準拠）
   ====================================================== */
const particlePool = [];
const activeParticleGroups = [];
const GRAVITY = 9.8 * 0.8;

const materialPool = new Map();
let noTextureMaterial = null;

// 💡 干渉を避けるため、名前を 'particleGeoCache' に変更
const particleGeoCache = new Map();

// --- 💡 マテリアルを Basic にし、色を「白」で統一（真っ黒防止） ---
const getOrCreateMaterialForTexture = (texture) => {
    if (!texture) {
        if (!noTextureMaterial) {
            noTextureMaterial = new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 1,
                side: THREE.DoubleSide
            });
        }
        return noTextureMaterial;
    }

    if (materialPool.has(texture)) return materialPool.get(texture);

    const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: texture,
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide
    });

    materialPool.set(texture, mat);
    return mat;
};

const getCachedParticleGeometry = (i, j, grid, size) => {
    const sizeInt = Math.floor(size * 100);
    const hashKey = (grid << 24) | (i << 16) | (j << 8) | sizeInt;

    if (particleGeoCache.has(hashKey)) return particleGeoCache.get(hashKey);

    const geo = new THREE.PlaneGeometry(size, size).center();
    const uv = geo.attributes.uv.array;

    // UVの範囲を計算
    const u0 = i / grid;
    const v0 = j / grid;
    const u1 = (i + 1) / grid;
    const v1 = (j + 1) / grid;

    /**
     * Three.js PlaneGeometry の標準的なUV順序:
     * [0, 1] 左上: (u0, v1)
     * [2, 3] 右上: (u1, v1)
     * [4, 5] 左下: (u0, v0)
     * [6, 7] 右下: (u1, v0)
     */
    uv.set([
        u0, v1, // 左上
        u1, v1, // 右上
        u0, v0, // 左下
        u1, v0  // 右下
    ]);

    geo.attributes.uv.needsUpdate = true;
    geo.__cached = true;

    particleGeoCache.set(hashKey, geo);
    return geo;
};

const getPooledParticle = () => {
    const p = particlePool.pop();
    if (p) {
        p.visible = true;
        return p;
    }
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.__cached = false;
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, side: THREE.DoubleSide });
    return new THREE.Mesh(geo, mat);
};

const releasePooledParticle = p => {
    p.visible = false;
    if (p.parent) p.parent.remove(p);
    if (p.geometry && !p.geometry.__cached) {
        p.geometry.dispose();
        p.geometry = null;
    }
    particlePool.push(p);
};

/**
 * マイクラ準拠の破壊パーティクルを一括生成（最適化版）
 */
export const createMinecraftBreakParticles = (pos, blockType, lifetime = 3.0) => {
    const grid = 4;
    const size = 0.5 / grid;
    const group = new THREE.Group();
    const texture = getBlockMaterials(blockType)?.[0]?.map || null;
    const sharedMat = getOrCreateMaterialForTexture(texture);

    // 💡 改善：再利用するベクトル（メモリ確保の抑制）
    const offset = new THREE.Vector3();
    const rndVec = new THREE.Vector3();

    const invGrid = 1 / grid;
    const baseOffset = 0.5 * invGrid - 0.5;

    for (let i = 0; i < grid; i++) {
        const xBase = i * invGrid + baseOffset;
        for (let j = 0; j < grid; j++) {
            const yBase = j * invGrid + baseOffset;

            for (let k = 0; k < grid; k++) {
                // 💡 改善：zBaseをkループの先頭で1回だけ計算
                const zBase = k * invGrid + baseOffset;

                const p = getPooledParticle();
                const ud = p.userData; // 💡 改善：参照をキャッシュ
                const pPos = p.position; // 💡 改善：参照をキャッシュ

                p.material = sharedMat;
                p.geometry = getCachedParticleGeometry(i, j, grid, size);

                // 💡 改善：事前計算済みのzBaseを使用
                offset.set(
                    xBase + (Math.random() - 0.5) * 0.05,
                    yBase + (Math.random() - 0.5) * 0.05,
                    zBase + (Math.random() - 0.5) * 0.05
                );

                pPos.copy(pos).add(offset);
                p.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

                rndVec.set((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2);

                // 💡 改善：userDataの構造チェックと代入を最適化
                if (!ud.origin) {
                    p.userData = {
                        origin: new THREE.Vector3(),
                        velocity: new THREE.Vector3(),
                        lifetime: 0,
                        elapsed: 0
                    };
                }

                // 💡 改善：キャッシュした ud を使って直接アクセス
                p.userData.origin.copy(pos);
                p.userData.velocity.copy(rndVec);
                p.userData.lifetime = 0.2 + Math.random() * (lifetime - 0.2);
                p.userData.elapsed = 0;

                group.add(p);
            }
        }
    }

    scene.add(group);
    activeParticleGroups.push(group);
    return group;
};

const PUSH_DIRS = [
    { x: 1, z: 0 }, { x: -1, z: 0 },
    { x: 0, z: 1 }, { x: 0, z: -1 }
];
const _validCandidates = new Array(4);
const _tempRotatedBox = new THREE.Box3(); // 💡 改善: メモリ確保を防ぐ再利用ボックス

export const updateBlockParticles = delta => {
    const ag = activeParticleGroups;
    // 💡 改善：カメラの向きをキャッシュ
    const camQuat = camera.quaternion;

    for (let gi = ag.length - 1; gi >= 0; gi--) {
        const group = ag[gi];
        const children = group.children;

        for (let pi = children.length - 1; pi >= 0; pi--) {
            const p = children[pi];
            const ud = p.userData;

            // 💡 改善：最初に寿命チェックを行い、無駄な計算（物理・衝突判定）をスキップ
            if (ud.elapsed >= ud.lifetime) {
                // 共有マテリアルの色変更は全パーティクルに影響するため削除、または個別設定が必要
                releasePooledParticle(p);
                group.remove(p);
                continue;
            }
            ud.elapsed += delta;

            // 💡 改善：プロパティアクセスをキャッシュ
            const pos = p.position;
            const vel = ud.velocity;

            pos.x += vel.x * delta;
            pos.y += vel.y * delta;
            pos.z += vel.z * delta;

            vel.y -= GRAVITY * delta;
            vel.x *= 0.98;
            vel.z *= 0.98;

            // 💡 改善：Math.floorを高速化（正の数前提ならビット演算も可だが、負の数対応のためそのままか |0 を検討）
            const bx = Math.floor(pos.x);
            const by = Math.floor(pos.y);
            const bz = Math.floor(pos.z);

            const pCx = bx >> 4;
            const pCz = bz >> 4;
            const lx = bx & 15;
            const lz = bz & 15;

            // 💡 改善：Chunk内のブロック取得を直接行う
            const rawVoxel = ChunkSaveManager.getBlock(pCx, pCz, lx, by, lz)
                ?? getVoxelAtWorld(bx, by, bz, true);

            const id = rawVoxel & 0xFFF;
            const metadata = (rawVoxel >> 12) & 0xF;

            if (id !== BLOCK_TYPES.SKY && id !== BLOCK_TYPES.WATER) {
                const cfg = getBlockConfiguration(id);
                if (!cfg || cfg.collision !== false) {
                    let topY = by + 1.0;

                    const relBoxes = blockCollisionBoxCache ? blockCollisionBoxCache.get(id) : null;
                    if (relBoxes && relBoxes.length > 0) {
                        let maxBoxY = -Infinity;
                        for (let j = 0; j < relBoxes.length; j++) {
                            _tempRotatedBox.makeEmpty();
                            applyRotationToCollisionBox(relBoxes[j], metadata, _tempRotatedBox);
                            if (_tempRotatedBox.max.y > maxBoxY) maxBoxY = _tempRotatedBox.max.y;
                        }
                        topY = by + maxBoxY;
                    } else {
                        topY = by + getBlockHeight(id);
                    }

                    // 💡 改善：pos.y への直接アクセス
                    if (vel.y < 0 && pos.y >= topY - 0.1 && pos.y <= topY + 0.2) {
                        pos.y = topY;
                        vel.y = 0;
                        vel.x *= 0.7;
                        vel.z *= 0.7;
                    }
                    else if (pos.y < topY - 0.1) {
                        let validCount = 0;
                        for (let di = 0; di < 4; di++) {
                            const dir = PUSH_DIRS[di];
                            const cx = bx + dir.x;
                            const cz = bz + dir.z;

                            // 💡 改善：隣接チャンク判定の高速化
                            const rawSideVoxel = ((cx >> 4) === pCx && (cz >> 4) === pCz)
                                ? ChunkSaveManager.getBlock(pCx, pCz, cx & 15, by, cz & 15)
                                : getVoxelAtWorld(cx, by, cz, true);

                            if ((rawSideVoxel & 0xFFF) === BLOCK_TYPES.SKY || (rawSideVoxel & 0xFFF) === BLOCK_TYPES.WATER) {
                                _validCandidates[validCount++] = dir;
                            }
                        }

                        if (validCount > 0) {
                            const chosenDir = _validCandidates[(Math.random() * validCount) | 0];
                            pos.x += chosenDir.x * 0.1;
                            pos.z += chosenDir.z * 0.1;
                            vel.x = chosenDir.x * 1.5;
                            vel.z = chosenDir.z * 1.5;
                            vel.y = 0;
                        } else {
                            vel.set(0, 0, 0);
                            ud.elapsed = ud.lifetime; // 即座に終了フラグ
                        }
                    }
                }
            }

            p.quaternion.copy(camQuat);
        }

        // グループ破棄判定
        if (group.children.length === 0) {
            if (group.userData?.dispose) group.userData.dispose();
            scene.remove(group);
            ag.splice(gi, 1);
        }
    }
};

/**
 * ブロックIDから正確な高さを返す（フルブロック、ハーフブロック、階段、カーペット対応）
 */
function getBlockHeight(id) {
    const config = getBlockConfiguration(id);
    if (!config || config.collision === false) return 0.0;

    // もし明示的に height が設定されていればそれを最優先
    if (typeof config.height === "number") {
        return config.height;
    }

    // geometryType から高さを自動判定
    switch (config.geometryType) {
        case "slab":
            return 0.5;
        case "carpet":
            return 0.0625;
        case "stairs":
            return 1.0; // 階段の最大高さは 1.0 なので、一番上から降りるときは 1.0
        default:
            return 1.0;
    }
}
