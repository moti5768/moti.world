"use strict";
import * as THREE from '../build/three.module.js';
import {
    getRawBlockId, getRawLocalState, setBlockStateProp, packRawBlock
} from '../blockstate.js';

/* ======================================================
   【ピストン 3D スライドアニメーションエンジン】(blocks/piston_animator.js)
   - Java Edition MovingPiston 準拠の滑らかな伸縮＆ブロック移動補間
   - 共有マテリアル＋チャンク同一ライトマップ計算で輝度ジャンプ＆GCを最小化
   - 伸び縮み途中で棒がピストン背面へ突き抜けない動的ロッド長補正付き
   ====================================================== */

const _m1 = new THREE.Matrix4();
const _r1 = new THREE.Matrix4();
const _mTemp = new THREE.Matrix4();
const _vNorm = new THREE.Vector3();

function encodeCoordKey(wx, wy, wz) {
    const ox = (wx + 524288) & 0xFFFFF;
    const oz = (wz + 524288) & 0xFFFFF;
    const oy = wy & 0xFF;
    return ox * 268435456 + (((oz << 8) | oy) >>> 0);
}

export function createPistonAnimator(deps) {
    const {
        scene,
        getBlockConfiguration,
        getBlockGeometry,
        getBlockMaterialsFast,
        getTransformMeta,
        getCustomGeometryMatrix,
        getLogRotationMatrixReadOnly,
        getWorldLightCell,
        lightLevelFactors,
        requestChunkUpdate,
        blockTypes
    } = deps;

    const animGroup = new THREE.Group();
    animGroup.name = "PistonAnimations";
    animGroup.frustumCulled = false;
    scene.add(animGroup);

    // Map<pistonKey, AnimationRecord>
    const activeByPiston = new Map();
    // 参照カウント式隠蔽マップ（複数ピストンが隣接座標を連続駆動しても破綻しない）
    const hiddenCoordRefCount = new Map();

    function addHiddenCoord(wx, wy, wz, listOut) {
        const key = encodeCoordKey(wx, wy, wz);
        const prev = hiddenCoordRefCount.get(key) || 0;
        hiddenCoordRefCount.set(key, prev + 1);
        listOut.push({ key, x: wx, y: wy, z: wz });
    }

    function markCoordChunksDirty(wx, wz) {
        const cx = wx >> 4;
        const cz = wz >> 4;
        const lx = wx & 15;
        const lz = wz & 15;
        requestChunkUpdate(cx, cz);
        if (lx === 0) requestChunkUpdate(cx - 1, cz);
        else if (lx === 15) requestChunkUpdate(cx + 1, cz);
        if (lz === 0) requestChunkUpdate(cx, cz - 1);
        else if (lz === 15) requestChunkUpdate(cx, cz + 1);
    }

    /**
     * 静止チャンクと同じ 8bit 正規化カラー（天空光R・ブロック光G・面陰影）を付与して
     * 共有マテリアル直結の軽量メッシュを 1 個生成する
     */
    function buildBlockMesh(raw, lightSampleX, lightSampleY, lightSampleZ, headDir = null) {
        const id = getRawBlockId(raw);
        const meta = getRawLocalState(raw);
        const cfg = getBlockConfiguration(id);
        if (!cfg || id === blockTypes.SKY) return null;

        const mats = getBlockMaterialsFast(id, meta);
        if (!mats) return null;

        const gType = cfg.geometryType || "cube";
        const isCubeLike = !cfg.customGeometry && (gType === "cube" || gType === "leaves");
        let geom = null;

        if (isCubeLike) {
            const src = getBlockGeometry("cube", cfg, 0);
            if (!src) return null;
            geom = src.clone();
            if (cfg.isLog === true && meta !== 0) {
                geom.applyMatrix4(getLogRotationMatrixReadOnly(meta));
            }
        } else {
            const shapeMeta = (cfg.shapeMode === "static") ? 0 : meta;
            const src = getBlockGeometry(gType, cfg, shapeMeta);
            if (!src) return null;
            geom = src.clone();
            const tMeta = getTransformMeta(id, meta);
            if (tMeta !== 0) {
                getCustomGeometryMatrix(tMeta, _m1, _r1, _mTemp);
                _mTemp.makeTranslation(0.5, 0.5, 0.5);
                _m1.premultiply(_mTemp);
                geom.applyMatrix4(_m1);
            }
        }

        const posAttr = geom.getAttribute('position');
        let normAttr = geom.getAttribute('normal');
        if (!normAttr) {
            geom.computeVertexNormals();
            normAttr = geom.getAttribute('normal');
        }

        const vertCount = posAttr.count;
        const colArr = new Uint8Array(vertCount * 3);
        const selfCell = getWorldLightCell(lightSampleX, lightSampleY, lightSampleZ);
        const fallbackCell = selfCell >= 0 ? selfCell : 0xF0;

        for (let i = 0; i < vertCount; i++) {
            const nx = normAttr.getX(i);
            const ny = normAttr.getY(i);
            const nz = normAttr.getZ(i);
            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);

            let wdx = 0, wdy = 0, wdz = 0, fw = 1.0;
            if (ax >= ay && ax >= az) {
                wdx = nx > 0 ? 1 : -1;
                fw = 0.8;
            } else if (ay >= ax && ay >= az) {
                wdy = ny > 0 ? 1 : -1;
                fw = ny > 0 ? 1.0 : 0.5;
            } else {
                wdz = nz > 0 ? 1 : -1;
                fw = 0.65;
            }

            let cell = getWorldLightCell(lightSampleX + wdx, lightSampleY + wdy, lightSampleZ + wdz);
            if (cell < 0 || cell === 0) cell = fallbackCell;

            const fw255 = fw * 255.0;
            let sByte = (lightLevelFactors[(cell >> 4) & 15] * fw255 + 0.5) | 0;
            let bByte = (lightLevelFactors[cell & 15] * fw255 + 0.5) | 0;
            if (sByte > 255) sByte = 255;
            if (bByte > 255) bByte = 255;

            const p3 = i * 3;
            colArr[p3] = sByte;
            colArr[p3 + 1] = bByte;
            colArr[p3 + 2] = 0;
        }
        geom.setAttribute('color', new THREE.BufferAttribute(colArr, 3, true));

        // ピストンヘッドの棒が本体背面へ突き出ないよう、0..1 範囲外の棒後端頂点を記録
        let rodClip = null;
        if (headDir) {
            const axis = headDir.dx !== 0 ? 0 : (headDir.dy !== 0 ? 1 : 2);
            const dirVal = axis === 0 ? headDir.dx : (axis === 1 ? headDir.dy : headDir.dz);
            const boundary = dirVal > 0 ? 0.0 : 1.0;
            const indices = [];

            for (let i = 0; i < vertCount; i++) {
                const v = posAttr.array[i * 3 + axis];
                if ((dirVal > 0 && v < -1e-4) || (dirVal < 0 && v > 1.0 + 1e-4)) {
                    indices.push(i);
                }
            }
            if (indices.length > 0) {
                rodClip = { axis, dirVal, boundary, indices, posAttr };
            }
        }

        const meshMat = Array.isArray(mats) && mats.length === 1 ? mats[0] : mats;
        const mesh = new THREE.Mesh(geom, meshMat);
        mesh.frustumCulled = false;
        mesh.renderOrder = 2;

        return { mesh, rodClip };
    }

    function updateRodExtension(rodClip, extensionT) {
        if (!rodClip) return;
        const { axis, dirVal, boundary, indices, posAttr } = rodClip;
        const target = boundary - dirVal * (0.25 * extensionT);
        const arr = posAttr.array;
        for (let i = 0; i < indices.length; i++) {
            arr[indices[i] * 3 + axis] = target;
        }
        posAttr.needsUpdate = true;
    }

    function disposeRecord(rec, requestRebuild = true) {
        for (let i = 0; i < rec.items.length; i++) {
            const item = rec.items[i];
            animGroup.remove(item.mesh);
            if (item.mesh.geometry) item.mesh.geometry.dispose();
            item.mesh.geometry = null;
            item.mesh.material = null;
        }
        rec.items.length = 0;

        for (let i = 0; i < rec.hiddenCoords.length; i++) {
            const hc = rec.hiddenCoords[i];
            const cur = hiddenCoordRefCount.get(hc.key) || 0;
            if (cur <= 1) hiddenCoordRefCount.delete(hc.key);
            else hiddenCoordRefCount.set(hc.key, cur - 1);

            if (requestRebuild) {
                markCoordChunksDirty(hc.x, hc.z);
            }
        }
        rec.hiddenCoords.length = 0;
    }

    function onPistonAction(event) {
        if (!event) return;
        const { type, x, y, z, dx, dy, dz, facing, isSticky, headRaw, movedBlocks, durationTicks } = event;
        const pistonKey = encodeCoordKey(x, y, z);

        // 短パルス等で同一ピストンが動作中に反転した場合、旧アニメーションを即終了してから新規開始
        const existing = activeByPiston.get(pistonKey);
        if (existing) {
            disposeRecord(existing, true);
            activeByPiston.delete(pistonKey);
        }

        const durationSec = Math.max(0.05, (durationTicks || 2) * 0.05);
        const items = [];
        const hiddenCoords = [];
        const headDir = { dx, dy, dz };

        if (type === "extend") {
            const hx = x + dx, hy = y + dy, hz = z + dz;
            addHiddenCoord(hx, hy, hz, hiddenCoords);

            const headObj = buildBlockMesh(headRaw, hx, hy, hz, headDir);
            if (headObj) {
                updateRodExtension(headObj.rodClip, 0.0);
                headObj.mesh.position.set(x, y, z);
                animGroup.add(headObj.mesh);
                items.push({
                    mesh: headObj.mesh,
                    rodClip: headObj.rodClip,
                    fromX: x, fromY: y, fromZ: z,
                    toX: hx, toY: hy, toZ: hz,
                    isHead: true,
                    isExtending: true
                });
            }

            if (Array.isArray(movedBlocks)) {
                for (let i = 0; i < movedBlocks.length; i++) {
                    const b = movedBlocks[i];
                    addHiddenCoord(b.toX, b.toY, b.toZ, hiddenCoords);
                    const obj = buildBlockMesh(b.raw, b.toX, b.toY, b.toZ, null);
                    if (obj) {
                        obj.mesh.position.set(b.fromX, b.fromY, b.fromZ);
                        animGroup.add(obj.mesh);
                        items.push({
                            mesh: obj.mesh,
                            rodClip: null,
                            fromX: b.fromX, fromY: b.fromY, fromZ: b.fromZ,
                            toX: b.toX, toY: b.toY, toZ: b.toZ,
                            isHead: false,
                            isExtending: true
                        });
                    }
                }
            }
        } else if (type === "retract") {
            const hx = x + dx, hy = y + dy, hz = z + dz;
            // 縮み中は本体を「伸びベース状態」で保持しつつ、ヘッドが中へ吸い込まれる様子を描画
            addHiddenCoord(x, y, z, hiddenCoords);

            const pistonId = isSticky ? blockTypes.STICKY_PISTON : blockTypes.PISTON;
            let extMeta = setBlockStateProp(pistonId, 0, "facing", facing);
            extMeta = setBlockStateProp(pistonId, extMeta, "extended", true);
            const baseObj = buildBlockMesh(packRawBlock(pistonId, extMeta), x, y, z, null);
            if (baseObj) {
                baseObj.mesh.position.set(x, y, z);
                animGroup.add(baseObj.mesh);
                items.push({
                    mesh: baseObj.mesh,
                    rodClip: null,
                    fromX: x, fromY: y, fromZ: z,
                    toX: x, toY: y, toZ: z,
                    isHead: false,
                    isExtending: false
                });
            }

            const headObj = buildBlockMesh(headRaw, hx, hy, hz, headDir);
            if (headObj) {
                updateRodExtension(headObj.rodClip, 1.0);
                headObj.mesh.position.set(hx, hy, hz);
                animGroup.add(headObj.mesh);
                items.push({
                    mesh: headObj.mesh,
                    rodClip: headObj.rodClip,
                    fromX: hx, fromY: hy, fromZ: hz,
                    toX: x, toY: y, toZ: z,
                    isHead: true,
                    isExtending: false
                });
            }

            if (Array.isArray(movedBlocks)) {
                for (let i = 0; i < movedBlocks.length; i++) {
                    const b = movedBlocks[i];
                    addHiddenCoord(b.toX, b.toY, b.toZ, hiddenCoords);
                    const obj = buildBlockMesh(b.raw, b.toX, b.toY, b.toZ, null);
                    if (obj) {
                        obj.mesh.position.set(b.fromX, b.fromY, b.fromZ);
                        animGroup.add(obj.mesh);
                        items.push({
                            mesh: obj.mesh,
                            rodClip: null,
                            fromX: b.fromX, fromY: b.fromY, fromZ: b.fromZ,
                            toX: b.toX, toY: b.toY, toZ: b.toZ,
                            isHead: false,
                            isExtending: false
                        });
                    }
                }
            }
        }

        if (items.length === 0) {
            disposeRecord({ items, hiddenCoords }, false);
            return;
        }

        activeByPiston.set(pistonKey, {
            elapsed: 0,
            duration: durationSec,
            items,
            hiddenCoords
        });

        for (let i = 0; i < hiddenCoords.length; i++) {
            markCoordChunksDirty(hiddenCoords[i].x, hiddenCoords[i].z);
        }
    }

    function update(deltaSec) {
        if (activeByPiston.size === 0) return;

        for (const [key, rec] of activeByPiston.entries()) {
            rec.elapsed += deltaSec;
            const t = rec.elapsed / rec.duration;

            if (t >= 1.0) {
                disposeRecord(rec, true);
                activeByPiston.delete(key);
                continue;
            }

            for (let i = 0; i < rec.items.length; i++) {
                const it = rec.items[i];
                it.mesh.position.set(
                    it.fromX + (it.toX - it.fromX) * t,
                    it.fromY + (it.toY - it.fromY) * t,
                    it.fromZ + (it.toZ - it.fromZ) * t
                );
                if (it.isHead && it.rodClip) {
                    updateRodExtension(it.rodClip, it.isExtending ? t : (1.0 - t));
                }
            }
        }
    }

    function clear() {
        for (const rec of activeByPiston.values()) {
            disposeRecord(rec, false);
        }
        activeByPiston.clear();
        hiddenCoordRefCount.clear();
    }

    return {
        onPistonAction,
        update,
        clear,
        hasActiveAnimations: () => hiddenCoordRefCount.size > 0,
        isCoordHidden: (wx, wy, wz) => hiddenCoordRefCount.has(encodeCoordKey(wx, wy, wz))
    };
}