"use strict";
import * as THREE from './build/three.module.js';
import { camera, scene, getVoxelAtWorld, ChunkSaveManager, blockCollisionBoxCache } from './script.js';
import { getBlockMaterials, BLOCK_TYPES, getBlockConfiguration, applyRotationToCollisionBox, usesConnectionMeta, getRawBlockId, getRawLocalState } from './blocks.js';

/* ======================================================
   【three.js r128 最適化版】InstancedMesh パーティクルシステム（64 Draw Calls -> 1 Draw Call）
   ====================================================== */
const PARTICLE_GRID = 4;
const PARTICLE_COUNT = PARTICLE_GRID * PARTICLE_GRID * PARTICLE_GRID; // 64
const PARTICLE_SIZE = 0.5 / PARTICLE_GRID;
const MAX_PARTICLE_BATCHES = 8; // 同時最大 8ブロック（512個）＝最大 8 Draw Calls
const GRAVITY = 9.8 * 0.8;

const particleMeshPool = [];
const activeParticleMeshes = [];
const materialPool = new Map();
let noTextureMaterial = null;

// 全 InstancedMesh で共有する単一ジオメトリ＋静的 aUvOffset (64スロット分の 1/4 タイルUV)
const PARTICLE_INST_GEO = (() => {
    const geo = new THREE.PlaneGeometry(PARTICLE_SIZE, PARTICLE_SIZE).center();
    const offsets = new Float32Array(PARTICLE_COUNT * 2);
    let ptr = 0;
    for (let i = 0; i < PARTICLE_GRID; i++) {
        const u0 = i / PARTICLE_GRID;
        for (let j = 0; j < PARTICLE_GRID; j++) {
            const v0 = j / PARTICLE_GRID;
            for (let k = 0; k < PARTICLE_GRID; k++) {
                offsets[ptr++] = u0;
                offsets[ptr++] = v0;
            }
        }
    }
    geo.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(offsets, 2));
    return geo;
})();

const _particleShaderKey = () => 'mc_particle_instanced_v1';

function _applyParticleInstancedShader(mat) {
    mat.customProgramCacheKey = _particleShaderKey;
    mat.onBeforeCompile = (shader) => {
        shader.vertexShader = `
            attribute vec2 aUvOffset;
            ${shader.vertexShader}
        `.replace(
            '#include <uv_vertex>',
            `#include <uv_vertex>
            #ifdef USE_UV
                vUv = vUv * 0.25 + aUvOffset;
            #endif`
        );
    };
    return mat;
}

const getOrCreateMaterialForTexture = (texture) => {
    if (!texture) {
        if (!noTextureMaterial) {
            noTextureMaterial = _applyParticleInstancedShader(new THREE.MeshBasicMaterial({
                color: 0xffffff,
                transparent: false,
                alphaTest: 0.5,
                side: THREE.DoubleSide
            }));
        }
        return noTextureMaterial;
    }

    const cached = materialPool.get(texture);
    if (cached) return cached;

    const mat = _applyParticleInstancedShader(new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: texture,
        transparent: false,
        alphaTest: 0.5,
        side: THREE.DoubleSide
    }));

    materialPool.set(texture, mat);
    return mat;
};

// 行列合成用再利用オブジェクト（ゼロGC）
const _pPosTmp = new THREE.Vector3();
const _pUnitScale = new THREE.Vector3(1, 1, 1);
const _pMat4 = new THREE.Matrix4();
const _pZeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

function acquireParticleInstancedMesh(sharedMat) {
    if (particleMeshPool.length > 0) {
        const mesh = particleMeshPool.pop();
        mesh.material = sharedMat;
        mesh.visible = true;
        return mesh;
    }

    const mesh = new THREE.InstancedMesh(PARTICLE_INST_GEO, sharedMat, PARTICLE_COUNT);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.userData.state = {
        posX: new Float32Array(PARTICLE_COUNT),
        posY: new Float32Array(PARTICLE_COUNT),
        posZ: new Float32Array(PARTICLE_COUNT),
        velX: new Float32Array(PARTICLE_COUNT),
        velY: new Float32Array(PARTICLE_COUNT),
        velZ: new Float32Array(PARTICLE_COUNT),
        elapsed: new Float32Array(PARTICLE_COUNT),
        lifetime: new Float32Array(PARTICLE_COUNT),
        alive: new Uint8Array(PARTICLE_COUNT),
        aliveCount: 0
    };
    return mesh;
}

function releaseParticleInstancedMesh(mesh) {
    mesh.visible = false;
    if (mesh.parent) mesh.parent.remove(mesh);
    if (particleMeshPool.length < MAX_PARTICLE_BATCHES) {
        particleMeshPool.push(mesh);
    } else {
        mesh.dispose();
    }
}

/**
 * マイクラ準拠の破壊パーティクルを 1 InstancedMesh（1 Draw Call）で一括生成
 */
export const createMinecraftBreakParticles = (pos, blockType, lifetime = 3.0) => {
    while (activeParticleMeshes.length >= MAX_PARTICLE_BATCHES) {
        const oldest = activeParticleMeshes.shift();
        releaseParticleInstancedMesh(oldest);
    }

    const texture = getBlockMaterials(blockType)?.[0]?.map || null;
    const sharedMat = getOrCreateMaterialForTexture(texture);
    const instMesh = acquireParticleInstancedMesh(sharedMat);
    const st = instMesh.userData.state;

    const invGrid = 1 / PARTICLE_GRID;
    const baseOffset = 0.5 * invGrid - 0.5;
    const camQuat = camera.quaternion;
    const ox = pos.x, oy = pos.y, oz = pos.z;

    let slot = 0;
    for (let i = 0; i < PARTICLE_GRID; i++) {
        const xBase = i * invGrid + baseOffset;
        for (let j = 0; j < PARTICLE_GRID; j++) {
            const yBase = j * invGrid + baseOffset;
            for (let k = 0; k < PARTICLE_GRID; k++) {
                const zBase = k * invGrid + baseOffset;

                const px = ox + xBase + (Math.random() - 0.5) * 0.05;
                const py = oy + yBase + (Math.random() - 0.5) * 0.05;
                const pz = oz + zBase + (Math.random() - 0.5) * 0.05;

                st.posX[slot] = px;
                st.posY[slot] = py;
                st.posZ[slot] = pz;
                st.velX[slot] = (Math.random() - 0.5) * 2;
                st.velY[slot] = Math.random() * 2;
                st.velZ[slot] = (Math.random() - 0.5) * 2;
                st.elapsed[slot] = 0;
                st.lifetime[slot] = 0.2 + Math.random() * (lifetime - 0.2);
                st.alive[slot] = 1;

                _pPosTmp.set(px, py, pz);
                _pMat4.compose(_pPosTmp, camQuat, _pUnitScale);
                instMesh.setMatrixAt(slot, _pMat4);
                slot++;
            }
        }
    }

    st.aliveCount = PARTICLE_COUNT;
    instMesh.instanceMatrix.needsUpdate = true;

    scene.add(instMesh);
    activeParticleMeshes.push(instMesh);
    return instMesh;
};

const PUSH_DIRS = [
    { x: 1, z: 0 }, { x: -1, z: 0 },
    { x: 0, z: 1 }, { x: 0, z: -1 }
];
const _validCandidates = new Array(4);
const _tempRotatedBox = new THREE.Box3();

export const updateBlockParticles = delta => {
    const meshes = activeParticleMeshes;
    if (meshes.length === 0) return;

    const camQuat = camera.quaternion;

    for (let mi = meshes.length - 1; mi >= 0; mi--) {
        const instMesh = meshes[mi];
        const st = instMesh.userData.state;
        const posX = st.posX, posY = st.posY, posZ = st.posZ;
        const velX = st.velX, velY = st.velY, velZ = st.velZ;
        const elapsed = st.elapsed, lifetime = st.lifetime, alive = st.alive;

        for (let slot = 0; slot < PARTICLE_COUNT; slot++) {
            if (alive[slot] === 0) continue;

            if (elapsed[slot] >= lifetime[slot]) {
                alive[slot] = 0;
                st.aliveCount--;
                instMesh.setMatrixAt(slot, _pZeroMatrix);
                continue;
            }
            elapsed[slot] += delta;

            let px = posX[slot] + velX[slot] * delta;
            let py = posY[slot] + velY[slot] * delta;
            let pz = posZ[slot] + velZ[slot] * delta;

            let vx = velX[slot] * 0.98;
            let vy = velY[slot] - GRAVITY * delta;
            let vz = velZ[slot] * 0.98;

            const bx = Math.floor(px);
            const by = Math.floor(py);
            const bz = Math.floor(pz);

            const pCx = bx >> 4;
            const pCz = bz >> 4;
            const rawVoxel = ChunkSaveManager.getBlock(pCx, pCz, bx & 15, by, bz & 15)
                ?? getVoxelAtWorld(bx, by, bz, true);

            const id = getRawBlockId(rawVoxel);
            const metadata = getRawLocalState(rawVoxel);

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

                    if (vy < 0 && py >= topY - 0.1 && py <= topY + 0.2) {
                        py = topY;
                        vy = 0;
                        vx *= 0.7;
                        vz *= 0.7;
                    } else if (py < topY - 0.1) {
                        let validCount = 0;
                        for (let di = 0; di < 4; di++) {
                            const dir = PUSH_DIRS[di];
                            const cx = bx + dir.x;
                            const cz = bz + dir.z;

                            const rawSideVoxel = ((cx >> 4) === pCx && (cz >> 4) === pCz)
                                ? (ChunkSaveManager.getBlock(pCx, pCz, cx & 15, by, cz & 15) ?? getVoxelAtWorld(cx, by, cz, true))
                                : getVoxelAtWorld(cx, by, cz, true);

                            const sideId = getRawBlockId(rawSideVoxel);
                            if (sideId === BLOCK_TYPES.SKY || sideId === BLOCK_TYPES.WATER) {
                                _validCandidates[validCount++] = dir;
                            }
                        }

                        if (validCount > 0) {
                            const chosenDir = _validCandidates[(Math.random() * validCount) | 0];
                            px += chosenDir.x * 0.1;
                            pz += chosenDir.z * 0.1;
                            vx = chosenDir.x * 1.5;
                            vz = chosenDir.z * 1.5;
                            vy = 0;
                        } else {
                            alive[slot] = 0;
                            st.aliveCount--;
                            instMesh.setMatrixAt(slot, _pZeroMatrix);
                            continue;
                        }
                    }
                }
            }

            posX[slot] = px; posY[slot] = py; posZ[slot] = pz;
            velX[slot] = vx; velY[slot] = vy; velZ[slot] = vz;

            _pPosTmp.set(px, py, pz);
            _pMat4.compose(_pPosTmp, camQuat, _pUnitScale);
            instMesh.setMatrixAt(slot, _pMat4);
        }

        if (st.aliveCount <= 0) {
            releaseParticleInstancedMesh(instMesh);
            meshes.splice(mi, 1);
        } else {
            instMesh.instanceMatrix.needsUpdate = true;
        }
    }
};

/**
 * ブロックIDから正確な高さを返す（フルブロック、ハーフブロック、階段、カーペット対応）
 */
function getBlockHeight(id) {
    const config = getBlockConfiguration(id);
    if (!config || config.collision === false) return 0.0;

    if (typeof config.height === "number") {
        return config.height;
    }

    switch (config.geometryType) {
        case "slab":
            return 0.5;
        case "carpet":
            return 0.0625;
        case "stairs":
            return 1.0;
        default:
            return 1.0;
    }
}