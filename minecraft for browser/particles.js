"use strict";
import * as THREE from './build/three.module.js';
import { camera, scene, getVoxelAtWorld, ChunkSaveManager, blockCollisionBoxCache } from './script.js';
import { getBlockMaterials, BLOCK_TYPES, getBlockConfiguration, applyRotationToCollisionBox, usesConnectionMeta } from './blocks.js';
/* ======================================================
   【統合・最適化】パーティクルシステム（マイクラ準拠）
   ====================================================== */
const MAX_PARTICLE_POOL = 256;
const MAX_PARTICLE_GROUPS = 8; // 同時最大 8ブロック分（512個）でメモリ・ドローコール暴走を防止
const particlePool = [];
const particleGroupPool = [];
const activeParticleGroups = [];
const GRAVITY = 9.8 * 0.8;

// パーティクル生成用再利用ベクトル（毎回 new Vector3 を廃止）
const _pOffset = new THREE.Vector3();
const _pRndVec = new THREE.Vector3();

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

    const u0 = i / grid;
    const v0 = j / grid;
    const u1 = (i + 1) / grid;
    const v1 = (j + 1) / grid;

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

/**
 * プールからパーティクルを取得（キャッシュ済み共有 geo/mat を直接渡し、ダミーVRAMリークを完全ゼロ化）
 */
const getPooledParticle = (sharedGeo, sharedMat) => {
    const p = particlePool.pop();
    if (p) {
        p.geometry = sharedGeo;
        p.material = sharedMat;
        p.visible = true;
        return p;
    }
    const mesh = new THREE.Mesh(sharedGeo, sharedMat);
    mesh.userData = {
        velocity: new THREE.Vector3(),
        lifetime: 0,
        elapsed: 0
    };
    return mesh;
};

const releasePooledParticle = p => {
    p.visible = false;
    if (p.parent) p.parent.remove(p);
    // 共有キャッシュジオメトリ/マテリアルは破棄せず参照のみ切断
    if (p.geometry && !p.geometry.__cached) {
        p.geometry.dispose();
    }
    p.geometry = null;
    p.material = null;
    if (particlePool.length < MAX_PARTICLE_POOL) {
        particlePool.push(p);
    }
};

const acquireParticleGroup = () => {
    return particleGroupPool.length > 0 ? particleGroupPool.pop() : new THREE.Group();
};

const releaseParticleGroup = (group) => {
    for (let i = group.children.length - 1; i >= 0; i--) {
        releasePooledParticle(group.children[i]);
    }
    if (group.parent) group.parent.remove(group);
    if (particleGroupPool.length < MAX_PARTICLE_GROUPS) {
        particleGroupPool.push(group);
    }
};

/**
 * マイクラ準拠の破壊パーティクルを一括生成（ゼロリーク・上限管理版）
 */
export const createMinecraftBreakParticles = (pos, blockType, lifetime = 3.0) => {
    // 同時発生上限を超えたら最も古いグループを回収してメモリ・ドローコール膨張を防止
    while (activeParticleGroups.length >= MAX_PARTICLE_GROUPS) {
        const oldest = activeParticleGroups.shift();
        releaseParticleGroup(oldest);
    }

    const grid = 4;
    const size = 0.5 / grid;
    const group = acquireParticleGroup();
    const texture = getBlockMaterials(blockType)?.[0]?.map || null;
    const sharedMat = getOrCreateMaterialForTexture(texture);

    const invGrid = 1 / grid;
    const baseOffset = 0.5 * invGrid - 0.5;

    for (let i = 0; i < grid; i++) {
        const xBase = i * invGrid + baseOffset;
        for (let j = 0; j < grid; j++) {
            const yBase = j * invGrid + baseOffset;
            const cachedGeo = getCachedParticleGeometry(i, j, grid, size);

            for (let k = 0; k < grid; k++) {
                const zBase = k * invGrid + baseOffset;
                const p = getPooledParticle(cachedGeo, sharedMat);
                const ud = p.userData;

                _pOffset.set(
                    xBase + (Math.random() - 0.5) * 0.05,
                    yBase + (Math.random() - 0.5) * 0.05,
                    zBase + (Math.random() - 0.5) * 0.05
                );
                p.position.copy(pos).add(_pOffset);
                p.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);

                _pRndVec.set((Math.random() - 0.5) * 2, Math.random() * 2, (Math.random() - 0.5) * 2);
                ud.velocity.copy(_pRndVec);
                ud.lifetime = 0.2 + Math.random() * (lifetime - 0.2);
                ud.elapsed = 0;

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

            // 寿命チェック（releasePooledParticle 内で parent.remove 済みのため二重 remove 不要）
            if (ud.elapsed >= ud.lifetime) {
                releasePooledParticle(p);
                continue;
            }
            ud.elapsed += delta;

            const pos = p.position;
            const vel = ud.velocity;

            pos.x += vel.x * delta;
            pos.y += vel.y * delta;
            pos.z += vel.z * delta;

            vel.y -= GRAVITY * delta;
            vel.x *= 0.98;
            vel.z *= 0.98;

            const bx = Math.floor(pos.x);
            const by = Math.floor(pos.y);
            const bz = Math.floor(pos.z);

            const pCx = bx >> 4;
            const pCz = bz >> 4;
            const lx = bx & 15;
            const lz = bz & 15;

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
                        const isConnBlock = usesConnectionMeta(id);
                        let maxBoxY = -Infinity;
                        for (let j = 0; j < relBoxes.length; j++) {
                            if (isConnBlock) {
                                if (relBoxes[j].max.y > maxBoxY) maxBoxY = relBoxes[j].max.y;
                            } else {
                                _tempRotatedBox.makeEmpty();
                                applyRotationToCollisionBox(relBoxes[j], metadata, _tempRotatedBox);
                                if (_tempRotatedBox.max.y > maxBoxY) maxBoxY = _tempRotatedBox.max.y;
                            }
                        }
                        topY = by + maxBoxY;
                    } else {
                        topY = by + getBlockHeight(id);
                    }

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

                            // null 返却時も確実に getVoxelAtWorld へフォールバックして誤空気判定を防止
                            const rawSideVoxel = ((cx >> 4) === pCx && (cz >> 4) === pCz)
                                ? (ChunkSaveManager.getBlock(pCx, pCz, cx & 15, by, cz & 15) ?? getVoxelAtWorld(cx, by, cz, true))
                                : getVoxelAtWorld(cx, by, cz, true);

                            const sideId = rawSideVoxel & 0xFFF;
                            if (sideId === BLOCK_TYPES.SKY || sideId === BLOCK_TYPES.WATER) {
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
                            ud.elapsed = ud.lifetime;
                        }
                    }
                }
            }

            p.quaternion.copy(camQuat);
        }

        // 空になったグループをプールへ返却（GC削減）
        if (group.children.length === 0) {
            releaseParticleGroup(group);
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
