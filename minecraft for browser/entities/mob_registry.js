"use strict";
import * as THREE from '../build/three.module.js';

/* ======================================================
   【モブ定義レジストリ＆3Dモデル生成】(entities/mob_registry.js)
   - Minecraft Java Edition EntityType 準拠の ID / 当たり判定サイズ / 体力 / 移動速度
   - registerMobType() で新しいモブを外部ファイルから自由に拡張可能
   ====================================================== */

export const MOB_TYPES = Object.freeze({
    PIG: "minecraft:pig",
    SHEEP: "minecraft:sheep",
    ZOMBIE: "minecraft:zombie"
});

const _mobDefinitions = new Map();
const _sharedBoxGeoCache = new Map();

function getSharedBoxGeo(w, h, d) {
    const key = `${w}|${h}|${d}`;
    let g = _sharedBoxGeoCache.get(key);
    if (!g) {
        g = new THREE.BoxGeometry(w, h, d);
        _sharedBoxGeoCache.set(key, g);
    }
    return g;
}

export function registerMobType(id, def) {
    if (!id || !def) return null;
    const normalized = Object.freeze({
        id,
        name: def.name || id,
        category: def.category || "creature", // "creature" | "monster"
        width: def.width ?? 0.6,
        height: def.height ?? 1.8,
        maxHealth: def.maxHealth ?? 10.0,
        moveSpeed: def.moveSpeed ?? 0.11,     // blocks / tick (20TPS)
        jumpSpeed: def.jumpSpeed ?? 0.42,
        aiType: def.aiType || "wander",       // "wander" | "chase_player"
        chaseRange: def.chaseRange ?? 14.0,
        parts: Object.freeze(def.parts || [])
    });
    _mobDefinitions.set(id, normalized);
    return normalized;
}

export function getMobDefinition(id) {
    return _mobDefinitions.get(id) || null;
}

export function listMobTypes() {
    return Array.from(_mobDefinitions.keys());
}

// ======================================================
// 標準モブ登録（Java Edition 当たり判定・体力準拠）
// ======================================================
registerMobType(MOB_TYPES.PIG, {
    name: "Pig",
    category: "creature",
    width: 0.9,
    height: 0.9,
    maxHealth: 10.0,
    moveSpeed: 0.10,
    aiType: "wander",
    parts: [
        // 胴体・頭・鼻・4本脚（単位: ブロック、足元Y=0基準）
        { role: "body",  size: [0.625, 0.50, 1.00], pos: [0, 0.5625, 0],     color: 0xf0a5a2 },
        { role: "head",  size: [0.50,  0.50, 0.50], pos: [0, 0.75, 0.5625],  color: 0xf4b2af },
        { role: "snout", size: [0.25,  0.1875, 0.08], pos: [0, 0.68, 0.84],  color: 0xe28a86 },
        { role: "legFL", size: [0.25,  0.375, 0.25], pos: [-0.1875, 0.1875, 0.3125], color: 0xe39491 },
        { role: "legFR", size: [0.25,  0.375, 0.25], pos: [ 0.1875, 0.1875, 0.3125], color: 0xe39491 },
        { role: "legBL", size: [0.25,  0.375, 0.25], pos: [-0.1875, 0.1875, -0.3125], color: 0xe39491 },
        { role: "legBR", size: [0.25,  0.375, 0.25], pos: [ 0.1875, 0.1875, -0.3125], color: 0xe39491 }
    ]
});

registerMobType(MOB_TYPES.SHEEP, {
    name: "Sheep",
    category: "creature",
    width: 0.9,
    height: 1.3,
    maxHealth: 8.0,
    moveSpeed: 0.095,
    aiType: "wander",
    parts: [
        { role: "body",  size: [0.6875, 0.625, 1.0625], pos: [0, 0.8125, 0],    color: 0xf2f2f2 },
        { role: "head",  size: [0.4375, 0.4375, 0.50],  pos: [0, 1.0625, 0.60], color: 0xe6d4be },
        { role: "legFL", size: [0.25, 0.625, 0.25], pos: [-0.1875, 0.3125, 0.3125],  color: 0xdcc7ae },
        { role: "legFR", size: [0.25, 0.625, 0.25], pos: [ 0.1875, 0.3125, 0.3125],  color: 0xdcc7ae },
        { role: "legBL", size: [0.25, 0.625, 0.25], pos: [-0.1875, 0.3125, -0.3125], color: 0xdcc7ae },
        { role: "legBR", size: [0.25, 0.625, 0.25], pos: [ 0.1875, 0.3125, -0.3125], color: 0xdcc7ae }
    ]
});

registerMobType(MOB_TYPES.ZOMBIE, {
    name: "Zombie",
    category: "monster",
    width: 0.6,
    height: 1.95,
    maxHealth: 20.0,
    moveSpeed: 0.115,
    aiType: "chase_player",
    chaseRange: 16.0,
    parts: [
        { role: "head",  size: [0.50, 0.50, 0.50],  pos: [0, 1.75, 0],      color: 0x568249 },
        { role: "body",  size: [0.50, 0.75, 0.25],  pos: [0, 1.125, 0],     color: 0x2b8b96 },
        { role: "armL",  size: [0.25, 0.25, 0.75],  pos: [-0.375, 1.375, 0.25], color: 0x4f7843 },
        { role: "armR",  size: [0.25, 0.25, 0.75],  pos: [ 0.375, 1.375, 0.25], color: 0x4f7843 },
        { role: "legBL", size: [0.25, 0.75, 0.25],  pos: [-0.125, 0.375, 0], color: 0x3a3f8f },
        { role: "legBR", size: [0.25, 0.75, 0.25],  pos: [ 0.125, 0.375, 0], color: 0x3a3f8f }
    ]
});

/**
 * モブ1体分の Three.js グループを生成する（個体別ライティング乗算対応）
 */
export function createMobMesh(mobDef) {
    const root = new THREE.Group();
    const partMaterials = [];
    const limbMeshes = [];

    for (let i = 0; i < mobDef.parts.length; i++) {
        const p = mobDef.parts[i];
        const geo = getSharedBoxGeo(p.size[0], p.size[1], p.size[2]);
        const baseColor = new THREE.Color(p.color);
        const mat = new THREE.MeshBasicMaterial({ color: baseColor.clone() });
        mat.userData.baseColor = baseColor;

        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
        mesh.userData.role = p.role;
        mesh.userData.baseY = p.pos[1];
        root.add(mesh);

        partMaterials.push(mat);
        if (p.role.startsWith("leg")) {
            limbMeshes.push(mesh);
        }
    }

    root.userData.partMaterials = partMaterials;
    root.userData.limbMeshes = limbMeshes;
    return root;
}

export function disposeMobMesh(root) {
    if (!root) return;
    const mats = root.userData.partMaterials;
    if (Array.isArray(mats)) {
        for (let i = 0; i < mats.length; i++) {
            mats[i].dispose();
        }
    }
    if (root.parent) root.parent.remove(root);
}