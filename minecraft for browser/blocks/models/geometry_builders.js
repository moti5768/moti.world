"use strict";
import * as THREE from '../../build/three.module.js';
import { BufferGeometryUtils } from '../../jsm/utils/BufferGeometryUtils.js';
import { getSideConnections } from '../collision.js';

/* ======================================================
   【ブロックジオメトリビルダー＆キャッシュ】(blocks/models/geometry_builders.js)
   - カスタム形状（階段・スラブ・フェンス・板ガラス・レッドストーン等）のジオメトリ生成を一元管理
   - Step 2 の Java Edition JSON モデルコンパイラも同じレジストリ (registerGeometryBuilder) に接続可能
   ====================================================== */

const cachedBlockGeometries = {};
const cachedCustomGeometries = {};
const SHARED_PLANE = new THREE.PlaneGeometry(1, 1);

function adjustSideUVs(geom, scaleY = 0.5) {
    const normals = geom.attributes.normal.array;
    const uvs = geom.attributes.uv.array;
    for (let i = 0, j = 0; i < normals.length; i += 3, j++) {
        if (Math.abs(normals[i + 1]) < 0.1) uvs[j * 2 + 1] *= scaleY;
    }
    geom.attributes.uv.needsUpdate = true;
}

function adjustSideUVsForCarpet(geom, scaleY = 0.0625) {
    const normals = geom.attributes.normal.array;
    const uvs = geom.attributes.uv.array;
    const count = uvs.length >> 1;
    for (let i = 0; i < count; i++) {
        const ny = normals[i * 3 + 1];
        if (Math.abs(ny) < 0.9) {
            uvs[i * 2 + 1] *= scaleY;
        }
    }
    geom.attributes.uv.needsUpdate = true;
}

/**
 * three.js r128 の mergeBufferGeometries(..., true) が group.materialIndex を配列添字(0,1,2...)で
 * 強制上書きする仕様を回避し、各パーツが指定した materialIndex を 100% 保持して結合するヘルパー
 */
export function mergeGeometriesPreservingGroups(geometries) {
    if (!geometries || geometries.length === 0) return null;
    if (geometries.length === 1) return geometries[0];

    const preservedGroups = [];
    let indexOffset = 0;

    for (let i = 0; i < geometries.length; i++) {
        const g = geometries[i];
        const count = g.index ? g.index.count : g.attributes.position.count;
        if (g.groups && g.groups.length > 0) {
            for (let j = 0; j < g.groups.length; j++) {
                const gr = g.groups[j];
                const gCount = Number.isFinite(gr.count) ? Math.min(gr.count, count - gr.start) : (count - gr.start);
                if (gCount > 0) {
                    preservedGroups.push({
                        start: indexOffset + gr.start,
                        count: gCount,
                        materialIndex: gr.materialIndex
                    });
                }
            }
        } else if (count > 0) {
            preservedGroups.push({ start: indexOffset, count, materialIndex: 0 });
        }
        indexOffset += count;
    }

    const merged = BufferGeometryUtils.mergeBufferGeometries(geometries, false);
    if (!merged) return null;

    merged.clearGroups();
    for (let i = 0; i < preservedGroups.length; i++) {
        const gr = preservedGroups[i];
        merged.addGroup(gr.start, gr.count, gr.materialIndex);
    }
    return merged;
}

// 形状ごとのビルダー関数マップ（ストラテジーパターン）
const GEOMETRY_BUILDERS = {
    cube: () => {
        const geom = new THREE.BoxGeometry(1, 1, 1);
        geom.translate(0.5, 0.5, 0.5);
        return geom;
    },
    slab: () => {
        const slabGeom = new THREE.BoxGeometry(1, 0.5, 1);
        slabGeom.translate(0.5, 0.25, 0.5);
        const posAttr = slabGeom.getAttribute('position');
        const normAttr = slabGeom.getAttribute('normal');
        const uvAttr = slabGeom.getAttribute('uv');
        const indexAttr = slabGeom.index;

        slabGeom.clearGroups();
        for (let i = 0; i < indexAttr.count; i += 6) {
            const vertexIndex = indexAttr.array[i] * 3;
            const nx = normAttr.array[vertexIndex];
            const ny = normAttr.array[vertexIndex + 1];
            const nz = normAttr.array[vertexIndex + 2];

            let matIdx = 0;
            if (nx > 0.5) matIdx = 0;
            else if (nx < -0.5) matIdx = 1;
            else if (ny > 0.5) matIdx = 2;
            else if (ny < -0.5) matIdx = 3;
            else if (nz > 0.5) matIdx = 4;
            else if (nz < -0.5) matIdx = 5;

            slabGeom.addGroup(i, 6, matIdx);

            for (let f = 0; f < 6; f++) {
                const idx = indexAttr.array[i + f];
                const vx = posAttr.array[idx * 3];
                const vy = posAttr.array[idx * 3 + 1];
                const vz = posAttr.array[idx * 3 + 2];
                let u = 0, v = 0;
                switch (matIdx) {
                    case 0: u = 1.0 - vz; v = vy; break;
                    case 1: u = vz; v = vy; break;
                    case 2: u = vx; v = 1.0 - vz; break;
                    case 3: u = vx; v = vz; break;
                    case 4: u = vx; v = vy; break;
                    case 5: u = 1.0 - vx; v = vy; break;
                }
                uvAttr.array[idx * 2] = u;
                uvAttr.array[idx * 2 + 1] = v;
            }
        }
        uvAttr.needsUpdate = true;
        return slabGeom;
    },
    stairs: () => {
        const lower = new THREE.BoxGeometry(1, 0.5, 1);
        lower.translate(0.5, 0.25, 0.5);
        const upper = new THREE.BoxGeometry(0.5, 0.5, 1);
        upper.translate(0.75, 0.75, 0.5);

        const merged = BufferGeometryUtils.mergeBufferGeometries([lower, upper], true);
        const posAttr = merged.getAttribute('position');
        const normAttr = merged.getAttribute('normal');
        const uvAttr = merged.getAttribute('uv');
        const indexAttr = merged.index;

        merged.clearGroups();
        for (let i = 0; i < indexAttr.count; i += 6) {
            const vertexIndex = indexAttr.array[i] * 3;
            const nx = normAttr.array[vertexIndex];
            const ny = normAttr.array[vertexIndex + 1];
            const nz = normAttr.array[vertexIndex + 2];

            let matIdx = 0;
            if (nx > 0.5) matIdx = 0;
            else if (nx < -0.5) matIdx = 1;
            else if (ny > 0.5) matIdx = 2;
            else if (ny < -0.5) matIdx = 3;
            else if (nz > 0.5) matIdx = 4;
            else if (nz < -0.5) matIdx = 5;

            merged.addGroup(i, 6, matIdx);

            for (let f = 0; f < 6; f++) {
                const idx = indexAttr.array[i + f];
                const vx = posAttr.array[idx * 3];
                const vy = posAttr.array[idx * 3 + 1];
                const vz = posAttr.array[idx * 3 + 2];
                let u = 0, v = 0;
                switch (matIdx) {
                    case 0: u = 1.0 - vz; v = vy; break;
                    case 1: u = vz; v = vy; break;
                    case 2: case 3: u = vx; v = vz; break;
                    case 4: u = vx; v = vy; break;
                    case 5: u = 1.0 - vx; v = vy; break;
                }
                uvAttr.array[idx * 2] = u;
                uvAttr.array[idx * 2 + 1] = v;
            }
        }
        uvAttr.needsUpdate = true;
        return merged;
    },
    cross: () => {
        const p1 = SHARED_PLANE.clone();
        p1.rotateY(THREE.MathUtils.degToRad(45));
        const p2 = SHARED_PLANE.clone();
        p2.rotateY(THREE.MathUtils.degToRad(-45));
        const geom = BufferGeometryUtils.mergeBufferGeometries([p1, p2], false);
        p1.dispose();
        p2.dispose();
        geom.translate(0.5, 0.5, 0.5);
        geom.clearGroups();
        geom.addGroup(0, geom.index.count, 0);
        return geom;
    },
    fence: (config, meta) => {
        const { n, s, e, w } = getSideConnections(meta);
        const geometries = [];

        const post = new THREE.BoxGeometry(0.25, 1, 0.25);
        post.translate(0.5, 0.5, 0.5);
        geometries.push(post);

        const barWidth = 0.125;
        const barHeight = 0.1875;

        const createBar = (x, z, bw, bd) => {
            const b1 = new THREE.BoxGeometry(bw, barHeight, bd);
            const b2 = b1.clone();
            b1.translate(x, 0.375 + (barHeight / 2), z);
            b2.translate(x, 0.75 + (barHeight / 2), z);
            return [b1, b2];
        };

        if (n) geometries.push(...createBar(0.5, 0.25, barWidth, 0.5));
        if (s) geometries.push(...createBar(0.5, 0.75, barWidth, 0.5));
        if (e) geometries.push(...createBar(0.75, 0.5, 0.5, barWidth));
        if (w) geometries.push(...createBar(0.25, 0.5, 0.5, barWidth));

        const geom = BufferGeometryUtils.mergeBufferGeometries(geometries, false);
        for (let i = 0; i < geometries.length; i++) geometries[i].dispose();
        geom.clearGroups();
        geom.addGroup(0, geom.index.count, 0);
        const posAttr = geom.getAttribute('position');
        const normAttr = geom.getAttribute('normal');
        const uvAttr = geom.getAttribute('uv');

        for (let i = 0; i < posAttr.count; i++) {
            const nx = Math.abs(normAttr.getX(i));
            const ny = Math.abs(normAttr.getY(i));

            let u, v;
            if (ny > 0.5) {
                u = posAttr.getX(i);
                v = posAttr.getZ(i);
            } else if (nx > 0.5) {
                u = posAttr.getZ(i);
                v = posAttr.getY(i);
            } else {
                u = posAttr.getX(i);
                v = posAttr.getY(i);
            }
            uvAttr.setXY(i, u, v);
        }
        uvAttr.needsUpdate = true;
        return geom;
    },
    pane: (config, meta) => {
        const { n, s, e, w } = getSideConnections(meta);
        const geometries = [];
        const thick = 0.125;
        const halfThick = thick / 2;
        const MAT_GLASS = 0; // side -> glass.png
        const MAT_FRAME = 2; // top  -> glass_pane_top.png

        const addFlatPart = (x, y, z, w_size, h_size, d_size, axis) => {
            const g = new THREE.BoxGeometry(w_size, h_size, d_size);
            g.translate(x + w_size / 2, y + h_size / 2, z + d_size / 2);
            g.clearGroups();

            const pos = g.getAttribute('position');
            const norm = g.getAttribute('normal');
            const uv = g.getAttribute('uv');

            for (let i = 0; i < 6; i++) {
                let idx = MAT_FRAME;
                if (axis === 'z' && (i === 0 || i === 1)) idx = MAT_GLASS;
                if (axis === 'x' && (i === 4 || i === 5)) idx = MAT_GLASS;
                g.addGroup(i * 6, 6, idx);
            }

            for (let i = 0; i < pos.count; i++) {
                const wx = pos.getX(i);
                const wy = pos.getY(i);
                const wz = pos.getZ(i);
                const ny = Math.abs(norm.getY(i));
                const nx = Math.abs(norm.getX(i));

                let u, v;
                if (ny > 0.5) {
                    u = (axis === 'z') ? wx : wz;
                    v = (axis === 'z') ? wz : wx;
                } else if (axis === 'z') {
                    u = (nx > 0.5) ? wz : wx;
                    v = wy;
                } else {
                    u = (nx > 0.5) ? wz : wx;
                    v = wy;
                }
                uv.setXY(i, u, v);
            }
            uv.needsUpdate = true;
            geometries.push(g);
        };

        const hasNS = (n || s);
        const hasEW = (e || w);
        const hasAnyConn = (hasNS || hasEW);

        if (hasNS || !hasAnyConn) {
            const zStart = n ? 0 : 0.5 - halfThick;
            const zEnd = s ? 1 : 0.5 + halfThick;
            addFlatPart(0.5 - halfThick, 0, zStart, thick, 1, zEnd - zStart, 'z');
        }

        if (hasEW) {
            if (hasNS) {
                if (w) addFlatPart(0, 0, 0.5 - halfThick, 0.5 - halfThick, 1, thick, 'x');
                if (e) addFlatPart(0.5 + halfThick, 0, 0.5 - halfThick, 0.5 - halfThick, 1, thick, 'x');
            } else {
                const xStart = w ? 0 : 0.5 - halfThick;
                const xEnd = e ? 1 : 0.5 + halfThick;
                addFlatPart(xStart, 0, 0.5 - halfThick, xEnd - xStart, 1, thick, 'x');
            }
        }

        return mergeGeometriesPreservingGroups(geometries);
    },
    water: (config, meta = 0) => {
        const isFalling = ((meta >> 3) & 1) !== 0;
        if (isFalling) {
            const geom = new THREE.BoxGeometry(1, 1, 1);
            geom.translate(0.5, 0.5, 0.5);
            return geom;
        }
        const level = meta & 7;
        const height = Math.max(0.12, ((8 - level) / 8) * 0.88);
        const geom = new THREE.BoxGeometry(1, height, 1);
        geom.translate(0.5, height * 0.5, 0.5);
        adjustSideUVs(geom, height);
        return geom;
    },
    leaves: () => {
        const geom = new THREE.BoxGeometry(1, 1, 1);
        geom.translate(0.5, 0.5, 0.5);
        return geom;
    },
    carpet: () => {
        const geom = new THREE.BoxGeometry(1, 0.0625, 1);
        geom.translate(0.5, 0.03125, 0.5);
        adjustSideUVsForCarpet(geom, 0.0625);
        return geom;
    },
    ladder: () => {
        const geom = new THREE.PlaneGeometry(1, 1);
        geom.translate(0.5, 0.5, 0.05);
        geom.addGroup(0, 6, 0);
        return geom;
    },
    wire: (config, meta = 0) => {
        const n = (meta >> 3) & 1;
        const s = (meta >> 2) & 1;
        const e = (meta >> 1) & 1;
        const w = meta & 1;
        const upN = (meta >> 7) & 1;
        const upS = (meta >> 6) & 1;
        const upE = (meta >> 5) & 1;
        const upW = (meta >> 4) & 1;

        const geoms = [];
        const hasEW = (e || w);
        const hasNS = (n || s);

        const makeHorizQuad = (x0, z0, x1, z1, yPos, matIdx, uvFn) => {
            const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
            g.rotateX(-Math.PI / 2);
            g.translate((x0 + x1) * 0.5, yPos, (z0 + z1) * 0.5);
            const pos = g.attributes.position;
            const uv = g.attributes.uv;
            for (let i = 0; i < pos.count; i++) {
                uvFn(uv, i, pos.getX(i), pos.getZ(i));
            }
            uv.needsUpdate = true;
            g.clearGroups();
            g.addGroup(0, g.index.count, matIdx);
            return g;
        };

        if (!hasEW && !hasNS) {
            geoms.push(makeHorizQuad(0.0, 0.0, 1.0, 1.0, 0.015, 2, (uv, i, px, pz) => {
                uv.setXY(i, px, 1.0 - pz);
            }));
        } else if (hasEW && !hasNS) {
            geoms.push(makeHorizQuad(0.0, 0.0, 1.0, 1.0, 0.015, 0, (uv, i, px, pz) => {
                uv.setXY(i, px, 1.0 - pz);
            }));
        } else if (!hasEW && hasNS) {
            geoms.push(makeHorizQuad(0.0, 0.0, 1.0, 1.0, 0.015, 0, (uv, i, px, pz) => {
                uv.setXY(i, pz, px);
            }));
        } else {
            const x0 = w ? 0.0 : (3 / 16);
            const x1 = e ? 1.0 : (13 / 16);
            const z0 = n ? 0.0 : (3 / 16);
            const z1 = s ? 1.0 : (13 / 16);
            geoms.push(makeHorizQuad(x0, z0, x1, z1, 0.015, 2, (uv, i, px, pz) => {
                uv.setXY(i, px, 1.0 - pz);
            }));
        }

        const makeUpQuad = (rotY, tx, tz) => {
            const g = new THREE.PlaneGeometry(1.0, 1.0);
            if (rotY !== 0) g.rotateY(rotY);
            g.translate(tx, 0.5, tz);
            const uv = g.attributes.uv;
            for (let i = 0; i < uv.count; i++) {
                const u = uv.getX(i), v = uv.getY(i);
                uv.setXY(i, v, u);
            }
            uv.needsUpdate = true;
            g.clearGroups();
            g.addGroup(0, g.index.count, 0);
            return g;
        };

        if (upE) geoms.push(makeUpQuad(-Math.PI / 2, 0.984, 0.5));
        if (upW) geoms.push(makeUpQuad(Math.PI / 2, 0.016, 0.5));
        if (upS) geoms.push(makeUpQuad(Math.PI, 0.5, 0.984));
        if (upN) geoms.push(makeUpQuad(0, 0.5, 0.016));

        return mergeGeometriesPreservingGroups(geoms);
    },
    torch: (config, meta = 0) => {
        const mount = Math.min(meta & 7, 4);
        const geom = new THREE.BoxGeometry(0.125, 0.625, 0.125);
        const uv = geom.attributes.uv;
        const norm = geom.attributes.normal;
        const u0 = 7 / 16, u1 = 9 / 16;
        for (let i = 0; i < uv.count; i++) {
            const ny = norm.getY(i);
            const su = uv.getX(i), sv = uv.getY(i);
            if (ny > 0.5) uv.setXY(i, u0 + su * (u1 - u0), (8 / 16) + sv * (2 / 16));
            else if (ny < -0.5) uv.setXY(i, u0 + su * (u1 - u0), sv * (2 / 16));
            else uv.setXY(i, u0 + su * (u1 - u0), sv * (10 / 16));
        }
        uv.needsUpdate = true;

        geom.translate(0, 0.3125, 0);
        if (mount === 0) geom.translate(0.5, 0.0, 0.5);
        else if (mount === 1) { geom.rotateZ(-0.40); geom.translate(0.0625, 0.20, 0.5); }
        else if (mount === 2) { geom.rotateZ(0.40); geom.translate(0.9375, 0.20, 0.5); }
        else if (mount === 3) { geom.rotateX(0.40); geom.translate(0.5, 0.20, 0.0625); }
        else if (mount === 4) { geom.rotateX(-0.40); geom.translate(0.5, 0.20, 0.9375); }

        geom.clearGroups();
        geom.addGroup(0, geom.index.count, 0);
        return geom;
    },
    redstone_torch: (config, meta = 0) => {
        const mount = Math.min(meta & 7, 4);
        const u0 = 7 / 16, u1 = 9 / 16;

        const makeCap = (rotX, ty, vMin, vSpan) => {
            const g = new THREE.PlaneGeometry(0.125, 0.125);
            g.rotateX(rotX);
            g.translate(0, ty, 0);
            const uv = g.attributes.uv;
            for (let i = 0; i < uv.count; i++) {
                uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), vMin + uv.getY(i) * vSpan);
            }
            uv.needsUpdate = true;
            g.clearGroups();
            g.addGroup(0, g.index.count, 0);
            return g;
        };

        const makeSidePlate = (rotY, tx, tz) => {
            const g = new THREE.PlaneGeometry(0.5, 0.75);
            if (rotY !== 0) g.rotateY(rotY);
            g.translate(tx, 0.375, tz);
            const uv = g.attributes.uv;
            for (let i = 0; i < uv.count; i++) {
                uv.setXY(i, (4 / 16) + uv.getX(i) * (8 / 16), uv.getY(i) * (12 / 16));
            }
            uv.needsUpdate = true;
            g.clearGroups();
            g.addGroup(0, g.index.count, 0);
            return g;
        };

        const parts = [
            makeCap(-Math.PI / 2, 0.625, 8 / 16, 2 / 16),
            makeCap(Math.PI / 2, 0.0, 0, 2 / 16),
            makeSidePlate(0, 0, 0.0625),
            makeSidePlate(Math.PI, 0, -0.0625),
            makeSidePlate(Math.PI / 2, 0.0625, 0),
            makeSidePlate(-Math.PI / 2, -0.0625, 0)
        ];

        const geom = mergeGeometriesPreservingGroups(parts);
        for (let i = 0; i < parts.length; i++) parts[i].dispose();

        if (mount === 0) geom.translate(0.5, 0.0, 0.5);
        else if (mount === 1) { geom.rotateZ(-0.40); geom.translate(0.0625, 0.20, 0.5); }
        else if (mount === 2) { geom.rotateZ(0.40); geom.translate(0.9375, 0.20, 0.5); }
        else if (mount === 3) { geom.rotateX(0.40); geom.translate(0.5, 0.20, 0.0625); }
        else if (mount === 4) { geom.rotateX(-0.40); geom.translate(0.5, 0.20, 0.9375); }

        return geom;
    },
    lever: (config, meta = 0) => {
        const mount = Math.min(meta & 7, 4);
        const isOn = ((meta >> 3) & 1) !== 0;

        const base = new THREE.BoxGeometry(0.375, 0.1875, 0.50);
        const bNorm = base.attributes.normal;
        const bUv = base.attributes.uv;
        for (let i = 0; i < bUv.count; i++) {
            const nx = Math.abs(bNorm.getX(i));
            const ny = Math.abs(bNorm.getY(i));
            const su = bUv.getX(i), sv = bUv.getY(i);
            if (ny > 0.5) bUv.setXY(i, (5 / 16) + su * (6 / 16), (4 / 16) + sv * (8 / 16));
            else if (nx > 0.5) bUv.setXY(i, (4 / 16) + su * (8 / 16), sv * (3 / 16));
            else bUv.setXY(i, (5 / 16) + su * (6 / 16), sv * (3 / 16));
        }
        bUv.needsUpdate = true;
        base.translate(0, 0.09375, 0);
        base.clearGroups();
        base.addGroup(0, base.index.count, 0);

        const handle = new THREE.BoxGeometry(0.125, 0.625, 0.125);
        const uv = handle.attributes.uv;
        const norm = handle.attributes.normal;
        const u0 = 7 / 16, u1 = 9 / 16;
        for (let i = 0; i < uv.count; i++) {
            const ny = norm.getY(i);
            const su = uv.getX(i), sv = uv.getY(i);
            if (ny > 0.5) uv.setXY(i, u0 + su * (u1 - u0), (8 / 16) + sv * (2 / 16));
            else if (ny < -0.5) uv.setXY(i, u0 + su * (u1 - u0), sv * (2 / 16));
            else uv.setXY(i, u0 + su * (u1 - u0), sv * (10 / 16));
        }
        uv.needsUpdate = true;
        handle.translate(0, 0.3125, 0);
        handle.rotateX(isOn ? 0.65 : -0.65);
        handle.translate(0, 0.125, 0);
        handle.clearGroups();
        handle.addGroup(0, handle.index.count, 2);

        const merged = mergeGeometriesPreservingGroups([base, handle]);

        if (mount === 0) {
            merged.translate(0.5, 0.0, 0.5);
        } else if (mount === 1) {
            merged.rotateX(Math.PI / 2);
            merged.rotateY(Math.PI / 2);
            merged.translate(0.0, 0.5, 0.5);
        } else if (mount === 2) {
            merged.rotateX(Math.PI / 2);
            merged.rotateY(-Math.PI / 2);
            merged.translate(1.0, 0.5, 0.5);
        } else if (mount === 3) {
            merged.rotateX(Math.PI / 2);
            merged.translate(0.5, 0.5, 0.0);
        } else if (mount === 4) {
            merged.rotateX(Math.PI / 2);
            merged.rotateY(Math.PI);
            merged.translate(0.5, 0.5, 1.0);
        }

        return merged;
    },
    repeater: (config, meta = 0) => {
        const delayIdx = meta & 3;
        const base = new THREE.BoxGeometry(1.0, 0.125, 1.0);
        base.translate(0.5, 0.0625, 0.5);

        const bNorm = base.attributes.normal;
        const bUv = base.attributes.uv;
        const bIdx = base.index;
        base.clearGroups();
        for (let i = 0; i < bIdx.count; i += 6) {
            const vi = bIdx.array[i] * 3;
            const ny = bNorm.array[vi + 1];
            const matIdx = ny > 0.5 ? 2 : (ny < -0.5 ? 3 : 0);
            base.addGroup(i, 6, matIdx);
        }
        for (let vIdx = 0; vIdx < bUv.count; vIdx++) {
            const ny = bNorm.getY(vIdx);
            const u = bUv.getX(vIdx), v = bUv.getY(vIdx);
            if (ny > 0.5) bUv.setXY(vIdx, 1.0 - v, u);
            else if (ny > -0.5) bUv.setXY(vIdx, u, v * 0.125);
        }
        bUv.needsUpdate = true;

        const parts = [base];
        const addTorchPin = (px, halfThick) => {
            const cap = new THREE.PlaneGeometry(0.125, 0.125);
            cap.rotateX(-Math.PI / 2);
            cap.translate(px, 7 / 16, 0.5);
            const cUv = cap.attributes.uv;
            for (let i = 0; i < cUv.count; i++) {
                cUv.setXY(i, (7 / 16) + cUv.getX(i) * (2 / 16), (8 / 16) + cUv.getY(i) * (2 / 16));
            }
            cUv.needsUpdate = true;
            cap.clearGroups();
            cap.addGroup(0, cap.index.count, 4);
            parts.push(cap);

            const makeSide = (rotY, ox, oz) => {
                const g = new THREE.PlaneGeometry(6 / 16, 7 / 16);
                if (rotY !== 0) g.rotateY(rotY);
                g.translate(px + ox, (2 / 16) + (7 / 32), 0.5 + oz);
                const uv = g.attributes.uv;
                for (let i = 0; i < uv.count; i++) {
                    uv.setXY(i, (5 / 16) + uv.getX(i) * (6 / 16), (5 / 16) + uv.getY(i) * (7 / 16));
                }
                uv.needsUpdate = true;
                g.clearGroups();
                g.addGroup(0, g.index.count, 4);
                return g;
            };

            parts.push(
                makeSide(0, 0, halfThick),
                makeSide(Math.PI, 0, -halfThick),
                makeSide(Math.PI / 2, halfThick, 0),
                makeSide(-Math.PI / 2, -halfThick, 0)
            );
        };

        const delayPinX = [0.5625, 0.4375, 0.3125, 0.1875][delayIdx];
        addTorchPin(0.8125, 0.0625);
        addTorchPin(delayPinX, 0.0628);

        const merged = mergeGeometriesPreservingGroups(parts);
        for (let i = 0; i < parts.length; i++) parts[i].dispose();
        return merged;
    }
};

/**
 * 外部モジュールから新しいカスタムジオメトリ形状ビルダーを登録する拡張API
 */
export function registerGeometryBuilder(type, builderFn) {
    if (type && typeof builderFn === "function") {
        GEOMETRY_BUILDERS[type] = builderFn;
        // 既存キャッシュに同名ビルダーの古い形状があればクリア
        const prefix = `${type}_`;
        for (const key in cachedBlockGeometries) {
            if (key.startsWith(prefix)) delete cachedBlockGeometries[key];
        }
    }
}

/**
 * 指定タイプのブロックジオメトリを取得する
 */
export function getBlockGeometry(type, config, meta = 0) {
    if (config?.customGeometry) {
        if (!cachedCustomGeometries[config.id]) {
            const customGeom = typeof config.customGeometry === "function"
                ? config.customGeometry()
                : config.customGeometry;
            customGeom.computeBoundingBox();
            customGeom.computeVertexNormals();
            cachedCustomGeometries[config.id] = customGeom;
        }
        return cachedCustomGeometries[config.id];
    }

    const cacheKey = typeof type === 'number' ? (type << 12) | (meta & 0xFFF) : `${type}_${meta}`;
    if (cachedBlockGeometries[cacheKey]) return cachedBlockGeometries[cacheKey];

    const builder = GEOMETRY_BUILDERS[type] || GEOMETRY_BUILDERS["cube"];
    const geom = builder(config, meta);

    geom.computeBoundingBox();
    geom.computeVertexNormals();

    cachedBlockGeometries[cacheKey] = geom;
    return geom;
}

export function clearBlockGeometryCache() {
    for (const key in cachedBlockGeometries) delete cachedBlockGeometries[key];
    for (const key in cachedCustomGeometries) delete cachedCustomGeometries[key];
}