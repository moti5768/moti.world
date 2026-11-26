"use strict";

import {
    MOUNT_SUPPORT_DX, MOUNT_SUPPORT_DY, MOUNT_SUPPORT_DZ,
    getBlockStateProp, getBlockStateRawProp, setBlockStateProp, hasBlockStateProp,
    getRawBlockId, getRawLocalState, packRawBlock
} from './blockstate.js';
import { BLOCK_TYPES } from './blocks.js';

/* ======================================================
   【レッドストーン信号伝播エンジン】(redstone_engine.js)
   - Minecraft Java Edition 強/弱動力モデル準拠
   - 2フェーズ ワイヤーネットワーク再解決（リング配線のゴースト電力防止）
   - トーチ(NOTゲート: 2ticks) / リピーター(2,4,6,8ticks + ロック) の遅延駆動
   - ピストン準接続(QC/BUD)・移動中ブロック(Block 36)除外・距離2通知対応
   - 拡張API: registerRole() / ブロック定義 onRedstoneUpdate() 対応
   ====================================================== */

export const REPEATER_OUT_DX = new Int8Array([1, 0, -1, 0]);
export const REPEATER_OUT_DZ = new Int8Array([0, -1, 0, 1]);
export const RS_HORIZ_DX = new Int8Array([1, -1, 0, 0]);
export const RS_HORIZ_DZ = new Int8Array([0, 0, 1, -1]);

const DIR6_DX = new Int8Array([1, -1, 0, 0, 0, 0]);
const DIR6_DY = new Int8Array([0, 0, 1, -1, 0, 0]);
const DIR6_DZ = new Int8Array([0, 0, 0, 0, 1, -1]);

const WIRE_CONN_DX = new Int8Array([0, 0, 1, -1]); // N, S, E, W
const WIRE_CONN_DZ = new Int8Array([-1, 1, 0, 0]);
const WIRE_CONN_BITS = new Int8Array([3, 2, 1, 0]);

function encodeBlockKey(wx, wy, wz) {
    const ox = (wx + 524288) & 0xFFFFF;
    const oz = (wz + 524288) & 0xFFFFF;
    const oy = wy & 0xFF;
    return ox * 268435456 + (((oz << 8) | oy) >>> 0);
}

/**
 * ワールド参照・ブロック属性テーブル・TickScheduler を注入してレッドストーンエンジンを生成する
 */
export function createRedstoneEngine(deps) {
    const {
        chunkHeight = 256,
        isOpaqueBlock,
        isRedstoneConductive,
        blockConfigFastArray,
        getWorldRawLoaded,
        setBlockFromWorldTick,
        setWorldBlock = null,
        notifyWorldBlockChanged = null,
        isCoordInTransit = null,
        tickScheduler,
        getCurrentTick = () => 0,
        onTorchBurnout = null,
        isEntityOnBlock = () => false
    } = deps;

    // Minecraft Java Edition RedstoneTorchBlock.java 完全準拠定数
    const TORCH_BURNOUT_WINDOW = 60;    // RECENT_TOGGLE_TIMER = 60 ticks (3秒)
    const TORCH_BURNOUT_LIMIT = 8;      // MAX_RECENT_TOGGLES = 8 回
    const TORCH_BURNOUT_RESTART = 160;  // RESTART_DELAY = 160 ticks (8秒後の自動復帰チェック)

    const _torchToggleHistory = new Map(); // Map<coordKey, { x, y, z, ticks: number[] }>

    const MAX_WIRE_NODES = 1024;
    const _wireX = new Int32Array(MAX_WIRE_NODES);
    const _wireY = new Int32Array(MAX_WIRE_NODES);
    const _wireZ = new Int32Array(MAX_WIRE_NODES);
    const _wireOldPower = new Uint8Array(MAX_WIRE_NODES);
    const _wireNewPower = new Uint8Array(MAX_WIRE_NODES);
    const _wireVisited = new Map();

    const _bfsQueue = new Int32Array(MAX_WIRE_NODES * 4);
    const _deviceCoordsX = new Int32Array(512);
    const _deviceCoordsY = new Int32Array(512);
    const _deviceCoordsZ = new Int32Array(512);
    const _deviceVisited = new Set();
    const _pistonWaveVisited = new Set();

    // 外部モジュール・新ブロック向けのカスタムロール拡張レジストリ
    const customRoles = new Map();

    // ピストン動作中などによる resolveFromOrigin 再入を安全に直列化する FIFO キュー
    let _isResolving = false;
    const _pendingResolveOrigins = [];

    /**
     * Java Edition 準拠: gameTime - toggle.when > 60 の古い反転履歴のみを除去する
     */
    function pruneTorchToggles(wx, wy, wz, currentTick) {
        const key = encodeBlockKey(wx, wy, wz);
        const entry = _torchToggleHistory.get(key);
        if (!entry) return null;

        const list = entry.ticks;
        let writeIdx = 0;
        for (let i = 0; i < list.length; i++) {
            if ((currentTick - list[i]) <= TORCH_BURNOUT_WINDOW) {
                list[writeIdx++] = list[i];
            }
        }
        list.length = writeIdx;
        if (list.length === 0) {
            _torchToggleHistory.delete(key);
            return null;
        }
        return entry;
    }

    /**
     * Java Edition RedstoneTorchBlock.isToggledTooFrequently(level, pos, addToggle) 完全再現
     */
    function isTorchToggledTooFrequently(wx, wy, wz, currentTick, addToggle) {
        let entry = pruneTorchToggles(wx, wy, wz, currentTick);
        if (addToggle) {
            if (!entry) {
                entry = { x: wx, y: wy, z: wz, ticks: [] };
                _torchToggleHistory.set(encodeBlockKey(wx, wy, wz), entry);
            }
            entry.ticks.push(currentTick);
        }
        return entry !== null && entry.ticks.length >= TORCH_BURNOUT_LIMIT;
    }

    function clearTorchBurnout(wx, wy, wz) {
        _torchToggleHistory.delete(encodeBlockKey(wx, wy, wz));
    }

    function exportBurnoutState() {
        const nowTick = getCurrentTick();
        const histories = [];
        for (const entry of _torchToggleHistory.values()) {
            const ages = [];
            for (let i = 0; i < entry.ticks.length; i++) {
                const age = nowTick - entry.ticks[i];
                if (age >= 0 && age <= TORCH_BURNOUT_WINDOW) {
                    ages.push(age);
                }
            }
            if (ages.length > 0) {
                histories.push({ x: entry.x, y: entry.y, z: entry.z, ages });
            }
        }
        return { histories };
    }

    function importBurnoutState(state) {
        _torchToggleHistory.clear();
        if (!state || !Array.isArray(state.histories)) return;

        const nowTick = getCurrentTick();
        for (let i = 0; i < state.histories.length; i++) {
            const h = state.histories[i];
            if (!h || !Array.isArray(h.ages) || h.ages.length === 0) continue;
            const ticks = [];
            for (let j = 0; j < h.ages.length; j++) {
                const age = h.ages[j] | 0;
                if (age >= 0 && age <= TORCH_BURNOUT_WINDOW) {
                    ticks.push(nowTick - age);
                }
            }
            if (ticks.length > 0) {
                const x = h.x | 0, y = h.y | 0, z = h.z | 0;
                _torchToggleHistory.set(encodeBlockKey(x, y, z), { x, y, z, ticks });
            }
        }
    }

    function getRaw(wx, wy, wz) {
        if (wy < 0 || wy >= chunkHeight) return 0;
        if (isCoordInTransit && isCoordInTransit(wx, wy, wz)) return 0;
        const r = getWorldRawLoaded(wx, wy, wz);
        return r < 0 ? 0 : r;
    }

    // ブロック定義の redstoneConductive に基づく「通電する / しない」統一判定
    function isRedstoneConductor(wx, wy, wz) {
        return isRedstoneConductive[getRawBlockId(getRaw(wx, wy, wz))] === 1;
    }

    // 段差ワイヤーの物理遮断用（不透明ブロック全般）
    function isWireBlockingOpaque(wx, wy, wz) {
        return isOpaqueBlock[getRawBlockId(getRaw(wx, wy, wz))] === 1;
    }

    /**
     * ワイヤーから方向 (dx, dz) にある隣接ブロックへ接続すべきか判定する（リピーターは入出力2方向のみ接続）
     */
    function canWireConnectToBlock(nRaw, dx, dz) {
        const nId = getRawBlockId(nRaw);
        const nCfg = blockConfigFastArray[nId];
        const mode = nCfg && nCfg.redstoneConnectsWire;
        if (!mode) return false;
        if (mode === "axis") {
            const rot = getRawLocalState(nRaw) & 3;
            const rdx = REPEATER_OUT_DX[rot];
            const rdz = REPEATER_OUT_DZ[rot];
            return (dx === rdx && dz === rdz) || (dx === -rdx && dz === -rdz);
        }
        return true;
    }

    /**
     * 8bit ワイヤー接続マスクを返す（下位4bit=水平NSEW、上位4bit=1段上へ壁を登るNSEW）
     * メッシュ生成（チャンクローカル座標）と信号計算（ワールド座標）の双方で共通利用する
     */
    function getWireConnectionMask(lx, ly, lz, getRawFn = getRaw) {
        let mask = 0;
        const aboveId = (ly < chunkHeight - 1) ? getRawBlockId(getRawFn(lx, ly + 1, lz)) : 0;
        const canClimbUp = (isRedstoneConductive[aboveId] === 0);

        for (let i = 0; i < 4; i++) {
            const dx = WIRE_CONN_DX[i];
            const dz = WIRE_CONN_DZ[i];
            const nx = lx + dx;
            const nz = lz + dz;
            const bit = WIRE_CONN_BITS[i];

            const sameRaw = getRawFn(nx, ly, nz);
            const sameId = getRawBlockId(sameRaw);

            if (canWireConnectToBlock(sameRaw, dx, dz)) {
                mask |= (1 << bit);
                continue;
            }

            // Java Edition 準拠:
            // 隣が導体ブロックかつ自直上が非導体のときのみ 1段上へ壁を登る接続になる
            // （隣がグロウストーン・上付きスラブ等の非導体なら下のワイヤーは上へ繋がらず一方向ダイオード化）
            if (
                canClimbUp &&
                isRedstoneConductive[sameId] === 1 &&
                ly < chunkHeight - 1 &&
                getRawBlockId(getRawFn(nx, ly + 1, nz)) === BLOCK_TYPES.REDSTONE_WIRE
            ) {
                mask |= (1 << bit) | (1 << (bit + 4));
                continue;
            }

            // 1ブロック下へ降りるワイヤー（隣の同高度が非導体なら接続）
            if (ly > 0 && isRedstoneConductive[sameId] === 0 && getRawBlockId(getRawFn(nx, ly - 1, nz)) === BLOCK_TYPES.REDSTONE_WIRE) {
                mask |= (1 << bit);
            }
        }
        return mask;
    }
    /**
     * ワイヤー (wx, wy, wz) の現在の接続形状に基づき、水平隣接 (tx, wy, tz) 方向へ出力が向いているか判定
     */
    function doesWirePointTowards(wx, wy, wz, tx, tz) {
        const mask = getWireConnectionMask(wx, wy, wz, getRaw) & 0xF;
        if (mask === 0) return true;

        const dx = tx - wx;
        const dz = tz - wz;
        let dirBit = 0;
        if (dz === -1) dirBit = 8;
        else if (dz === 1) dirBit = 4;
        else if (dx === 1) dirBit = 2;
        else if (dx === -1) dirBit = 1;
        else return false;

        if ((mask & dirBit) !== 0) return true;
        const oppositeBit = (dirBit === 8) ? 4 : (dirBit === 4) ? 8 : (dirBit === 2) ? 1 : 2;
        return mask === oppositeBit;
    }

    /**
     * (sx, sy, sz) が (tx, ty, tz) へ直接出力する強動力 (0..15)
     */
    function getDirectStrongPowerTo(sx, sy, sz, tx, ty, tz, targetIsConductor = false) {
        const raw = getRaw(sx, sy, sz);
        const id = getRawBlockId(raw);
        const meta = getRawLocalState(raw);
        const cfg = blockConfigFastArray[id];
        if (!cfg) return 0;

        // 常時電源ブロック（REDSTONE_BLOCK等）: 隣接ワイヤー・デバイスは直接駆動するが、導体ブロックは強励起しない
        if (cfg.redstonePowerOutput > 0) {
            return targetIsConductor ? 0 : cfg.redstonePowerOutput;
        }

        const role = cfg.redstoneRole;
        if (role === "lever" || role === "button") {
            if (!getBlockStateProp(id, meta, "powered")) return 0;
            const mount = Math.min(getBlockStateRawProp(id, meta, "mount"), 4);
            if (targetIsConductor) {
                return (
                    tx === sx + MOUNT_SUPPORT_DX[mount] &&
                    ty === sy + MOUNT_SUPPORT_DY[mount] &&
                    tz === sz + MOUNT_SUPPORT_DZ[mount]
                ) ? 15 : 0;
            }
            return 15;
        }

        if (role === "pressure_plate") {
            if (!getBlockStateProp(id, meta, "powered")) return 0;
            if (targetIsConductor) {
                // バニラ BasePressurePlateBlock 準拠: 真下の支持ブロックのみ強励起
                return (tx === sx && ty === sy - 1 && tz === sz) ? 15 : 0;
            }
            return 15;
        }

        if (role === "torch") {
            if (!getBlockStateProp(id, meta, "lit")) return 0;
            const mount = Math.min(getBlockStateRawProp(id, meta, "mount"), 4);
            if (
                tx === sx + MOUNT_SUPPORT_DX[mount] &&
                ty === sy + MOUNT_SUPPORT_DY[mount] &&
                tz === sz + MOUNT_SUPPORT_DZ[mount]
            ) {
                return 0;
            }
            if (targetIsConductor) {
                return (tx === sx && ty === sy + 1 && tz === sz) ? 15 : 0;
            }
            return 15;
        }

        if (role === "repeater" && cfg.repeaterPowered) {
            const rot = getBlockStateRawProp(id, meta, "facing");
            if (tx === sx + REPEATER_OUT_DX[rot] && ty === sy && tz === sz + REPEATER_OUT_DZ[rot]) {
                return 15;
            }
            return 0;
        }

        // カスタム登録ロールの出力判定
        const custom = customRoles.get(role);
        if (custom && typeof custom.getStrongPowerTo === "function") {
            return custom.getStrongPowerTo({
                sx, sy, sz, tx, ty, tz, id, meta, cfg, targetIsConductor, engine: api
            }) | 0;
        }

        return 0;
    }

    /**
     * 通電する導体ブロック (cx, cy, cz) が受けている「強動力」(0..15)
     */
    function getConductorStrongPower(cx, cy, cz) {
        if (!isRedstoneConductor(cx, cy, cz)) return 0;
        let maxP = 0;
        for (let i = 0; i < 6; i++) {
            const p = getDirectStrongPowerTo(
                cx + DIR6_DX[i], cy + DIR6_DY[i], cz + DIR6_DZ[i],
                cx, cy, cz, true
            );
            if (p > maxP) maxP = p;
            if (maxP === 15) return 15;
        }
        return maxP;
    }

    /**
     * 通電する導体ブロック (cx, cy, cz) が受けている「弱動力＋強動力」(0..15)
     */
    function getConductorAnyPower(cx, cy, cz, excludeX = 0x7FFFFFFF, excludeY = 0x7FFFFFFF, excludeZ = 0x7FFFFFFF) {
        if (!isRedstoneConductor(cx, cy, cz)) return 0;

        let maxP = getConductorStrongPower(cx, cy, cz);
        if (maxP === 15) return 15;

        const upRaw = getRaw(cx, cy + 1, cz);
        if (getRawBlockId(upRaw) === BLOCK_TYPES.REDSTONE_WIRE && !(cx === excludeX && (cy + 1) === excludeY && cz === excludeZ)) {
            const wp = getRawLocalState(upRaw) & 0xF;
            if (wp > maxP) maxP = wp;
        }

        for (let d = 0; d < 4; d++) {
            const nx = cx + RS_HORIZ_DX[d];
            const nz = cz + RS_HORIZ_DZ[d];
            if (nx === excludeX && cy === excludeY && nz === excludeZ) continue;
            const nRaw = getRaw(nx, cy, nz);
            if (getRawBlockId(nRaw) === BLOCK_TYPES.REDSTONE_WIRE) {
                const wp = getRawLocalState(nRaw) & 0xF;
                if (wp > maxP && doesWirePointTowards(nx, cy, nz, cx, cz)) {
                    maxP = wp;
                }
            }
        }

        return maxP;
    }

    /**
     * レッドストーントーチの支持ブロック (sx, sy, sz) が通電状態か統一判定
     */
    function isSupportBlockPowered(sx, sy, sz, torchX, torchY, torchZ) {
        const sId = getRawBlockId(getRaw(sx, sy, sz));
        const sCfg = blockConfigFastArray[sId];
        if (sCfg && sCfg.redstonePowerOutput > 0) return true;
        return getConductorAnyPower(sx, sy, sz, torchX, torchY, torchZ) > 0;
    }

    /**
     * ランプ等の対象ブロック (wx, wy, wz) が周囲から受けている総信号強度 (弱＋強)
     */
    function getTotalPowerAt(wx, wy, wz) {
        let maxP = isRedstoneConductor(wx, wy, wz) ? getConductorAnyPower(wx, wy, wz) : 0;
        if (maxP === 15) return 15;

        for (let i = 0; i < 6; i++) {
            const nx = wx + DIR6_DX[i], ny = wy + DIR6_DY[i], nz = wz + DIR6_DZ[i];
            const direct = getDirectStrongPowerTo(nx, ny, nz, wx, wy, wz, false);
            if (direct > maxP) maxP = direct;

            const nRaw = getRaw(nx, ny, nz);
            const nId = getRawBlockId(nRaw);
            if (nId === BLOCK_TYPES.REDSTONE_WIRE) {
                const wp = getRawLocalState(nRaw) & 0xF;
                if (wp > maxP && (ny === wy + 1 || (ny === wy && doesWirePointTowards(nx, ny, nz, wx, wz)))) {
                    maxP = wp;
                }
            } else if (isRedstoneConductive[nId] === 1) {
                const cp = getConductorAnyPower(nx, ny, nz, wx, wy, wz);
                if (cp > maxP) maxP = cp;
            }
            if (maxP === 15) return 15;
        }
        return maxP;
    }

    /**
     * ワイヤーセル (wx, wy, wz) が外部電源（直接電源＋強励起済み通電導体）から受け取る初期電力 (0..15)
     */
    function getExternalWireInputPower(wx, wy, wz) {
        let maxP = 0;
        for (let i = 0; i < 6; i++) {
            const nx = wx + DIR6_DX[i], ny = wy + DIR6_DY[i], nz = wz + DIR6_DZ[i];

            const direct = getDirectStrongPowerTo(nx, ny, nz, wx, wy, wz, false);
            if (direct > maxP) maxP = direct;

            if (isRedstoneConductor(nx, ny, nz)) {
                const cp = getConductorStrongPower(nx, ny, nz);
                if (cp > maxP) maxP = cp;
            }
            if (maxP === 15) return 15;
        }
        return maxP;
    }

    /**
     * リピーター (rx, ry, rz) の背面入力側が信号を受けているか判定
     */
    function isRepeaterReceivingInput(rx, ry, rz, rot) {
        const ix = rx - REPEATER_OUT_DX[rot];
        const iz = rz - REPEATER_OUT_DZ[rot];
        const iRaw = getRaw(ix, ry, iz);
        const iId = getRawBlockId(iRaw);

        if (iId === BLOCK_TYPES.REDSTONE_WIRE) {
            return (getRawLocalState(iRaw) & 0xF) > 0 && doesWirePointTowards(ix, ry, iz, rx, rz);
        }
        if (getDirectStrongPowerTo(ix, ry, iz, rx, ry, rz, false) > 0) {
            return true;
        }
        if (isRedstoneConductive[iId] === 1) {
            return getConductorAnyPower(ix, ry, iz, rx, ry, rz) > 0;
        }
        return false;
    }

    /**
     * Java Edition RepeaterBlock.isLocked 準拠:
     * 左右どちらかの側面から ON 状態のダイオード（リピーター等）が刺さっているか判定
     */
    function isRepeaterLocked(rx, ry, rz, rot) {
        const leftRot = (rot + 1) & 3;
        const rightRot = (rot + 3) & 3;
        const sideRots = [leftRot, rightRot];

        for (let i = 0; i < 2; i++) {
            const sr = sideRots[i];
            const sx = rx + REPEATER_OUT_DX[sr];
            const sz = rz + REPEATER_OUT_DZ[sr];
            const sRaw = getRaw(sx, ry, sz);
            const sId = getRawBlockId(sRaw);
            const sCfg = blockConfigFastArray[sId];
            if (!sCfg) continue;

            if (sCfg.redstoneRole === "repeater" && sCfg.repeaterPowered) {
                const sOutRot = getBlockStateRawProp(sId, getRawLocalState(sRaw), "facing");
                if (sx + REPEATER_OUT_DX[sOutRot] === rx && sz + REPEATER_OUT_DZ[sOutRot] === rz) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Java Edition DiodeBlock.shouldPrioritize 準拠:
     * 出力先がダイオード（リピーター等）であり、向かい合わせ（正面衝突）でなければ最優先 (-3)
     */
    function isRepeaterFacingDiode(rx, ry, rz, rot) {
        const ox = rx + REPEATER_OUT_DX[rot];
        const oz = rz + REPEATER_OUT_DZ[rot];
        const oRaw = getRaw(ox, ry, oz);
        const oId = getRawBlockId(oRaw);
        const oCfg = blockConfigFastArray[oId];
        if (!oCfg || oCfg.redstoneRole !== "repeater") return false;
        const outRot = getBlockStateRawProp(oId, getRawLocalState(oRaw), "facing");
        return outRot !== ((rot + 2) & 3);
    }

    /**
     * 指定座標 (wx, wy, wz) が方向 (dx, dy, dz) の隣接セルから信号を受けているか判定
     */
    function hasSignalFromDirection(wx, wy, wz, dx, dy, dz) {
        const nx = wx + dx, ny = wy + dy, nz = wz + dz;
        if (ny < 0 || ny >= chunkHeight) return false;

        if (getDirectStrongPowerTo(nx, ny, nz, wx, wy, wz, false) > 0) return true;

        const nRaw = getRaw(nx, ny, nz);
        const nId = getRawBlockId(nRaw);
        if (nId === BLOCK_TYPES.REDSTONE_WIRE) {
            const wp = getRawLocalState(nRaw) & 0xF;
            if (wp > 0 && (dy === 1 || (dy === 0 && doesWirePointTowards(nx, ny, nz, wx, wz)))) {
                return true;
            }
        } else if (isRedstoneConductive[nId] === 1) {
            if (getConductorAnyPower(nx, ny, nz, wx, wy, wz) > 0) return true;
        }
        return false;
    }

    /**
     * Java Edition PistonBaseBlock.getNeighborSignal 完全準拠:
     * 1. 本体位置の「前面方向 (fdx, fdy, fdz) を除く 5 方向」をチェック
     * 2. 元がドアのコードだった仕様による準接続 (QC / BUD): 1マス上 (wx, wy+1, wz) の全方向もチェック
     */
    function getPistonSignalAt(wx, wy, wz, fdx, fdy, fdz) {
        for (let i = 0; i < 6; i++) {
            const dx = DIR6_DX[i], dy = DIR6_DY[i], dz = DIR6_DZ[i];
            if (dx === fdx && dy === fdy && dz === fdz) continue;
            if (hasSignalFromDirection(wx, wy, wz, dx, dy, dz)) return 15;
        }

        const upY = wy + 1;
        if (upY < chunkHeight) {
            for (let i = 0; i < 6; i++) {
                const dx = DIR6_DX[i], dy = DIR6_DY[i], dz = DIR6_DZ[i];
                if (dx === 0 && dy === -1 && dz === 0) continue; // ピストン本体自身は除外
                if (hasSignalFromDirection(wx, upY, wz, dx, dy, dz)) return 15;
            }
        }
        return 0;
    }

    function evaluateDevice(wx, wy, wz) {
        const raw = getRaw(wx, wy, wz);
        const id = getRawBlockId(raw);
        const meta = getRawLocalState(raw);
        const cfg = blockConfigFastArray[id];
        if (!cfg || !cfg.redstoneDevice) return;

        const role = cfg.redstoneRole;
        if (role === "lamp") {
            const currentLit = getBlockStateProp(id, meta, "lit");
            const powered = getTotalPowerAt(wx, wy, wz) > 0;
            if (currentLit !== powered) {
                if (powered) {
                    // Java Edition RedstoneLampBlock 準拠: 点灯は即時 (0gt)
                    const nextMeta = setBlockStateProp(id, meta, "lit", true);
                    setBlockFromWorldTick(wx, wy, wz, packRawBlock(id, nextMeta));
                    resolveFromOrigin(wx, wy, wz, raw);
                } else {
                    // 消灯は 4 game ticks (2 redstone ticks) の遅延
                    const lampScheduled = (typeof tickScheduler.hasScheduled === "function")
                        ? tickScheduler.hasScheduled(wx, wy, wz, "redstone_device")
                        : false;
                    if (!lampScheduled) {
                        tickScheduler.schedule(wx, wy, wz, 4, "redstone_device", 0, 0);
                    }
                }
            }
            return;
        }

        // ボタン・感圧板は操作／踏み判定で起動し、予約Tickで自動復帰するため周囲信号では再評価しない
        if (role === "button" || role === "pressure_plate") {
            return;
        }

        const alreadyScheduled = (typeof tickScheduler.hasScheduled === "function")
            ? tickScheduler.hasScheduled(wx, wy, wz, "redstone_device")
            : false;

        if (role === "torch") {
            const mount = Math.min(getBlockStateRawProp(id, meta, "mount"), 4);
            const sx = wx + MOUNT_SUPPORT_DX[mount];
            const sy = wy + MOUNT_SUPPORT_DY[mount];
            const sz = wz + MOUNT_SUPPORT_DZ[mount];
            const currentLit = getBlockStateProp(id, meta, "lit");
            const targetLit = !isSupportBlockPowered(sx, sy, sz, wx, wy, wz);

            // Java Edition neighborChanged 準拠: 常に 2 ticks 後の更新を予約し、焼き切れ判定は tick() 時に行う
            if (currentLit !== targetLit && !alreadyScheduled) {
                tickScheduler.schedule(wx, wy, wz, 2, "redstone_device", -1, targetLit ? 1 : 0);
            }
            return;
        }

        if (role === "repeater") {
            const rot = getBlockStateRawProp(id, meta, "facing");
            const locked = isRepeaterLocked(wx, wy, wz, rot);
            let curMeta = meta;

            if (hasBlockStateProp(id, "locked") && getBlockStateProp(id, curMeta, "locked") !== locked) {
                curMeta = setBlockStateProp(id, curMeta, "locked", locked);
                setBlockFromWorldTick(wx, wy, wz, packRawBlock(id, curMeta));
            }

            // ロック中は現在の ON/OFF 状態を保持し、入力変化による予約Tickを出さない
            if (locked) return;

            const delayTicks = getBlockStateProp(id, curMeta, "delay");
            const currentPowered = !!cfg.repeaterPowered;
            const targetPowered = isRepeaterReceivingInput(wx, wy, wz, rot);

            if (currentPowered !== targetPowered && !alreadyScheduled) {
                // Minecraft Java Edition DiodeBlock.checkTickOnNeighbor 完全準拠のTick優先度:
                // 1. 出力先がダイオード（側面ロック・直列接続・ON/OFF問わず）: EXTREMELY_HIGH (-3)
                // 2. 通常消灯 (ON -> OFF): VERY_HIGH (-2)
                // 3. 通常点灯 (OFF -> ON): HIGH (-1)
                let priority = -1;
                if (isRepeaterFacingDiode(wx, wy, wz, rot)) {
                    priority = -3;
                } else if (currentPowered) {
                    priority = -2;
                }

                tickScheduler.schedule(wx, wy, wz, delayTicks, "redstone_device", priority, targetPowered ? 1 : 0);
            }
            return;
        }

        // 拡張ポイント1: カスタムロール評価
        const custom = customRoles.get(role);
        if (custom && typeof custom.evaluate === "function") {
            custom.evaluate({
                x: wx, y: wy, z: wz, id, meta, cfg,
                power: getTotalPowerAt(wx, wy, wz),
                currentTick: getCurrentTick(),
                getRaw,
                setBlock: setBlockFromWorldTick,
                setWorldBlock: setWorldBlock || setBlockFromWorldTick,
                notifyBlock: notifyWorldBlockChanged,
                scheduleTick: (delay, priority = 0, payload = 0) =>
                    tickScheduler.schedule(wx, wy, wz, delay, "redstone_device", priority, payload),
                scheduleTypedTick: (delay, type, priority = 0, payload = 0) =>
                    tickScheduler.schedule(wx, wy, wz, delay, type, priority, payload),
                engine: api
            });
            return;
        }

        // 拡張ポイント2: ブロック定義の onRedstoneUpdate フック
        if (typeof cfg.onRedstoneUpdate === "function") {
            cfg.onRedstoneUpdate({
                x: wx, y: wy, z: wz, id, meta, cfg,
                power: getTotalPowerAt(wx, wy, wz),
                currentTick: getCurrentTick(),
                getRaw,
                setBlock: setBlockFromWorldTick,
                setWorldBlock: setWorldBlock || setBlockFromWorldTick,
                notifyBlock: notifyWorldBlockChanged,
                scheduleTick: (delay, priority = 0, payload = 0) =>
                    tickScheduler.schedule(wx, wy, wz, delay, "redstone_device", priority, payload),
                scheduleTypedTick: (delay, type, priority = 0, payload = 0) =>
                    tickScheduler.schedule(wx, wy, wz, delay, type, priority, payload),
                engine: api
            });
        }
    }

    function resolveSingleOrigin(originX, originY, originZ, prevRaw = 0) {
        _wireVisited.clear();
        _deviceVisited.clear();
        let wireCount = 0;
        let devCount = 0;

        // 非ピストンデバイス（リピーター・トーチ・ランプ等）を収集
        const addDevice = (x, y, z) => {
            if (y < 0 || y >= chunkHeight || devCount >= 512) return;
            const id = getRawBlockId(getRaw(x, y, z));
            const cfg = blockConfigFastArray[id];
            if (!cfg || !cfg.redstoneDevice || cfg.redstoneRole === "piston") return;

            const k = encodeBlockKey(x, y, z);
            if (_deviceVisited.has(k)) return;
            _deviceVisited.add(k);
            _deviceCoordsX[devCount] = x;
            _deviceCoordsY[devCount] = y;
            _deviceCoordsZ[devCount] = z;
            devCount++;
        };

        // 現在の波面ステップ内でピストン（本体・ヘッド）を重複なく即時評価
        const evalPistonAt = (x, y, z) => {
            if (y < 0 || y >= chunkHeight) return;
            const id = getRawBlockId(getRaw(x, y, z));
            const cfg = blockConfigFastArray[id];
            if (!cfg || !cfg.redstoneDevice || cfg.redstoneRole !== "piston") return;
            const k = encodeBlockKey(x, y, z);
            if (_pistonWaveVisited.has(k)) return;
            _pistonWaveVisited.add(k);
            evaluateDevice(x, y, z);
        };

        const evalPistonsAround = (cx, cy, cz, includeCenter = true) => {
            if (includeCenter) evalPistonAt(cx, cy, cz);
            for (let i = 0; i < 6; i++) {
                evalPistonAt(cx + DIR6_DX[i], cy + DIR6_DY[i], cz + DIR6_DZ[i]);
            }
        };

        const evalPistonsDist2 = (cx, cy, cz) => {
            evalPistonsAround(cx, cy, cz, true);
            for (let i = 0; i < 6; i++) {
                evalPistonsAround(cx + DIR6_DX[i], cy + DIR6_DY[i], cz + DIR6_DZ[i], true);
            }
        };

        // Java Edition 各ブロックの updateNeighborsAt 範囲に 100% 準拠したピストン通知
        const evalPistonsByRole = (bx, by, bz, raw) => {
            const rId = getRawBlockId(raw);
            const rCfg = blockConfigFastArray[rId];
            if (!rCfg) return;
            const role = rCfg.redstoneRole;
            const rMeta = getRawLocalState(raw);

            if (role === "torch" || role === "wire") {
                evalPistonsDist2(bx, by, bz);
            } else if (role === "lever" || role === "button") {
                const mount = Math.min(getBlockStateRawProp(rId, rMeta, "mount"), 4);
                evalPistonsAround(
                    bx + MOUNT_SUPPORT_DX[mount],
                    by + MOUNT_SUPPORT_DY[mount],
                    bz + MOUNT_SUPPORT_DZ[mount],
                    true
                );
            } else if (role === "pressure_plate") {
                evalPistonsAround(bx, by - 1, bz, true);
            } else if (role === "repeater") {
                const rot = getBlockStateRawProp(rId, rMeta, "facing");
                evalPistonsAround(
                    bx + REPEATER_OUT_DX[rot],
                    by,
                    bz + REPEATER_OUT_DZ[rot],
                    true
                );
            }
        };

        const addWire = (x, y, z) => {
            if (y < 0 || y >= chunkHeight || wireCount >= MAX_WIRE_NODES) return -1;
            const raw = getRaw(x, y, z);
            if (getRawBlockId(raw) !== BLOCK_TYPES.REDSTONE_WIRE) return -1;
            const k = encodeBlockKey(x, y, z);
            const existing = _wireVisited.get(k);
            if (existing !== undefined) return existing;

            const idx = wireCount++;
            _wireVisited.set(k, idx);
            _wireX[idx] = x;
            _wireY[idx] = y;
            _wireZ[idx] = z;
            _wireOldPower[idx] = getRawLocalState(raw) & 0xF;
            _wireNewPower[idx] = 0;
            return idx;
        };

        for (let dx = -2; dx <= 2; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dz = -2; dz <= 2; dz++) {
                    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 3) continue;
                    const x = originX + dx, y = originY + dy, z = originZ + dz;
                    addWire(x, y, z);
                    addDevice(x, y, z);
                }
            }
        }

        for (let idx = 0; idx < wireCount; idx++) {
            const wx = _wireX[idx], wy = _wireY[idx], wz = _wireZ[idx];
            const aboveConductive = isRedstoneConductor(wx, wy + 1, wz);

            for (let d = 0; d < 4; d++) {
                const nx = wx + RS_HORIZ_DX[d];
                const nz = wz + RS_HORIZ_DZ[d];
                addWire(nx, wy, nz);
                if (!aboveConductive) addWire(nx, wy + 1, nz);
                if (!isRedstoneConductor(nx, wy, nz)) addWire(nx, wy - 1, nz);
            }
        }

        let qHead = 0, qTail = 0;
        for (let idx = 0; idx < wireCount; idx++) {
            const extP = getExternalWireInputPower(_wireX[idx], _wireY[idx], _wireZ[idx]);
            if (extP > 0) {
                _wireNewPower[idx] = extP;
                _bfsQueue[qTail++] = idx;
            }
        }

        while (qHead < qTail) {
            const idx = _bfsQueue[qHead++];
            const curP = _wireNewPower[idx];
            if (curP <= 1) continue;
            const nextP = curP - 1;

            const wx = _wireX[idx], wy = _wireY[idx], wz = _wireZ[idx];
            const aboveConductive = isRedstoneConductor(wx, wy + 1, wz);
            // Java Edition 準拠: 下り伝播は足元が導体ブロックのときのみ許可（グロウストーン・上付きスラブ上は下り遮断）
            const belowConductive = isRedstoneConductor(wx, wy - 1, wz);

            const relax = (nx, ny, nz) => {
                const nIdx = _wireVisited.get(encodeBlockKey(nx, ny, nz));
                if (nIdx !== undefined && nextP > _wireNewPower[nIdx]) {
                    _wireNewPower[nIdx] = nextP;
                    if (qTail < _bfsQueue.length) _bfsQueue[qTail++] = nIdx;
                }
            };

            for (let d = 0; d < 4; d++) {
                const nx = wx + RS_HORIZ_DX[d];
                const nz = wz + RS_HORIZ_DZ[d];
                relax(nx, wy, nz);
                if (!aboveConductive) relax(nx, wy + 1, nz);
                if (belowConductive && !isRedstoneConductor(nx, wy, nz)) relax(nx, wy - 1, nz);
            }
        }

        // フェーズ A: 消灯・電力低下ワイヤーを先に書き換え（電源OFF時の旧電力誤認を防止）
        let hasFalling = false;
        let maxRisingP = 0;
        let minRisingP = 16;

        for (let idx = 0; idx < wireCount; idx++) {
            const newP = _wireNewPower[idx];
            const oldP = _wireOldPower[idx];
            const wx = _wireX[idx], wy = _wireY[idx], wz = _wireZ[idx];
            const powerChanged = (newP !== oldP);

            if (newP < oldP) {
                setBlockFromWorldTick(wx, wy, wz, packRawBlock(BLOCK_TYPES.REDSTONE_WIRE, newP & 0xF));
                hasFalling = true;
            } else if (newP > oldP) {
                if (newP > maxRisingP) maxRisingP = newP;
                if (newP < minRisingP) minRisingP = newP;
            }

            const nearOrigin = (Math.abs(wx - originX) + Math.abs(wy - originY) + Math.abs(wz - originZ)) <= 2;
            if (powerChanged || nearOrigin) {
                for (let dx = -2; dx <= 2; dx++) {
                    for (let dy = -2; dy <= 2; dy++) {
                        for (let dz = -2; dz <= 2; dz++) {
                            if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= 2) {
                                addDevice(wx + dx, wy + dy, wz + dz);
                            }
                        }
                    }
                }
            }
        }

        // フェーズ B: 変化元および消灯ワイヤーのピストン評価（まだ新規点灯ワイヤーは未反映）
        _pistonWaveVisited.clear();
        evalPistonsAround(originX, originY, originZ, false);
        const curRaw = getRaw(originX, originY, originZ);
        evalPistonsByRole(originX, originY, originZ, curRaw);
        if (prevRaw > 0 && prevRaw !== curRaw) {
            evalPistonsByRole(originX, originY, originZ, prevRaw);
        }
        if (hasFalling) {
            for (let idx = 0; idx < wireCount; idx++) {
                if (_wireNewPower[idx] < _wireOldPower[idx]) {
                    evalPistonsDist2(_wireX[idx], _wireY[idx], _wireZ[idx]);
                }
            }
        }

        // フェーズ C: 点灯・上昇ワイヤーを電力の強い源流側 (15 -> 1) から波面順に書き換え＆ピストン評価
        // これにより上流ワイヤーからの通知が下流ワイヤーの最終電力を先読みするのを防ぐ
        if (maxRisingP >= minRisingP) {
            for (let p = maxRisingP; p >= minRisingP; p--) {
                let anyAtLevel = false;
                for (let idx = 0; idx < wireCount; idx++) {
                    if (_wireNewPower[idx] === p && _wireNewPower[idx] > _wireOldPower[idx]) {
                        setBlockFromWorldTick(_wireX[idx], _wireY[idx], _wireZ[idx], packRawBlock(BLOCK_TYPES.REDSTONE_WIRE, p & 0xF));
                        anyAtLevel = true;
                    }
                }
                if (!anyAtLevel) continue;

                _pistonWaveVisited.clear();
                for (let idx = 0; idx < wireCount; idx++) {
                    if (_wireNewPower[idx] === p && _wireNewPower[idx] > _wireOldPower[idx]) {
                        evalPistonsDist2(_wireX[idx], _wireY[idx], _wireZ[idx]);
                    }
                }
            }
        }

        // フェーズ D: リピーター・トーチ・ランプ等の非ピストンデバイスを一括評価
        for (let i = 0; i < devCount; i++) {
            evaluateDevice(_deviceCoordsX[i], _deviceCoordsY[i], _deviceCoordsZ[i]);
        }
    }

    function resolveFromOrigin(originX, originY, originZ, prevRaw = 0) {
        if (_isResolving) {
            if (_pendingResolveOrigins.length < 4096) {
                _pendingResolveOrigins.push(originX, originY, originZ, prevRaw);
            }
            return;
        }

        _isResolving = true;
        try {
            resolveSingleOrigin(originX, originY, originZ, prevRaw);
            let qHead = 0;
            let guard = 0;
            while (qHead + 3 < _pendingResolveOrigins.length && guard < 256) {
                const nx = _pendingResolveOrigins[qHead];
                const ny = _pendingResolveOrigins[qHead + 1];
                const nz = _pendingResolveOrigins[qHead + 2];
                const pRaw = _pendingResolveOrigins[qHead + 3];
                qHead += 4;
                resolveSingleOrigin(nx, ny, nz, pRaw);
                guard++;
            }
        } finally {
            _pendingResolveOrigins.length = 0;
            _isResolving = false;
        }
    }

    function handleScheduledDeviceTick(task, currentTick = getCurrentTick()) {
        const { x, y, z, payload } = task;
        const raw = getRaw(x, y, z);
        const id = getRawBlockId(raw);
        const meta = getRawLocalState(raw);
        const cfg = blockConfigFastArray[id];
        if (!cfg || !cfg.redstoneDevice) return;

        if (cfg.redstoneRole === "lamp") {
            if (getBlockStateProp(id, meta, "lit") && getTotalPowerAt(x, y, z) === 0) {
                const nextMeta = setBlockStateProp(id, meta, "lit", false);
                setBlockFromWorldTick(x, y, z, packRawBlock(id, nextMeta));
                resolveFromOrigin(x, y, z, raw);
            }
            return;
        }

        if (cfg.redstoneRole === "torch") {
            const mount = Math.min(getBlockStateRawProp(id, meta, "mount"), 4);
            const sx = x + MOUNT_SUPPORT_DX[mount];
            const sy = y + MOUNT_SUPPORT_DY[mount];
            const sz = z + MOUNT_SUPPORT_DZ[mount];
            const currentLit = getBlockStateProp(id, meta, "lit");
            const hasSignal = isSupportBlockPowered(sx, sy, sz, x, y, z);

            // Java Edition RedstoneTorchBlock.tick() 完全準拠
            pruneTorchToggles(x, y, z, currentTick);

            if (currentLit) {
                if (hasSignal) {
                    const nextMeta = setBlockStateProp(id, meta, "lit", false);
                    setBlockFromWorldTick(x, y, z, packRawBlock(id, nextMeta));
                    resolveFromOrigin(x, y, z, raw);

                    if (isTorchToggledTooFrequently(x, y, z, currentTick, true)) {
                        if (typeof onTorchBurnout === "function") {
                            onTorchBurnout(x, y, z);
                        }
                        // 通常の 2-tick 更新を阻害しない専用種別で 160 ticks 後の自動復帰チェックを予約
                        tickScheduler.schedule(x, y, z, TORCH_BURNOUT_RESTART, "redstone_torch_restart", -1, 1);
                    }
                }
            } else if (!hasSignal && !isTorchToggledTooFrequently(x, y, z, currentTick, false)) {
                const nextMeta = setBlockStateProp(id, meta, "lit", true);
                setBlockFromWorldTick(x, y, z, packRawBlock(id, nextMeta));
                resolveFromOrigin(x, y, z, raw);
            }
            return;
        }

        if (cfg.redstoneRole === "repeater") {
            const rot = getBlockStateRawProp(id, meta, "facing");
            // 発火時点でロック中なら状態を変更せず出力を保持
            if (isRepeaterLocked(x, y, z, rot)) return;

            const curPowered = !!cfg.repeaterPowered;
            const desiredPowered = isRepeaterReceivingInput(x, y, z, rot);

            // Minecraft Java Edition DiodeBlock.tick() 準拠
            if (curPowered && !desiredPowered) {
                setBlockFromWorldTick(x, y, z, packRawBlock(BLOCK_TYPES.REDSTONE_REPEATER, meta));
                resolveFromOrigin(x, y, z, raw);
            } else if (!curPowered) {
                setBlockFromWorldTick(x, y, z, packRawBlock(BLOCK_TYPES.REDSTONE_REPEATER_ON, meta));
                if (!desiredPowered) {
                    const delayTicks = getBlockStateProp(id, meta, "delay");
                    tickScheduler.schedule(x, y, z, delayTicks, "redstone_device", -2, 0);
                }
                resolveFromOrigin(x, y, z, raw);
            }
            return;
        }

        if (cfg.redstoneRole === "button") {
            if (getBlockStateProp(id, meta, "powered")) {
                const nextMeta = setBlockStateProp(id, meta, "powered", false);
                setBlockFromWorldTick(x, y, z, packRawBlock(id, nextMeta));
                resolveFromOrigin(x, y, z, raw);
            }
            return;
        }

        if (cfg.redstoneRole === "pressure_plate") {
            if (getBlockStateProp(id, meta, "powered")) {
                // バニラ BasePressurePlateBlock 準拠: まだ踏まれていれば再チェックを20tick延長、降りていればOFF
                if (isEntityOnBlock(x, y, z)) {
                    const holdTicks = cfg.plateHoldTicks ?? 20;
                    tickScheduler.schedule(x, y, z, holdTicks, "redstone_device", -1, 0);
                } else {
                    const nextMeta = setBlockStateProp(id, meta, "powered", false);
                    setBlockFromWorldTick(x, y, z, packRawBlock(id, nextMeta));
                    resolveFromOrigin(x, y, z, raw);
                }
            }
            return;
        }

        const custom = customRoles.get(cfg.redstoneRole);
        if (custom && typeof custom.onScheduledTick === "function") {
            const changed = custom.onScheduledTick({
                x, y, z, id, meta, cfg, payload, currentTick,
                setBlock: setBlockFromWorldTick,
                engine: api
            });
            if (changed) resolveFromOrigin(x, y, z, raw);
        }
    }

    const api = {
        onBlockChanged(wx, wy, wz, prevRaw = 0) {
            const bx = wx | 0, by = wy | 0, bz = wz | 0;
            if (getRawBlockId(getRaw(bx, by, bz)) !== BLOCK_TYPES.REDSTONE_TORCH) {
                clearTorchBurnout(bx, by, bz);
            }
            resolveFromOrigin(bx, by, bz, prevRaw);
        },
        handleScheduledDeviceTick,
        getWireConnectionMask,
        canWireConnectToBlock,
        getTotalPowerAt,
        getPistonSignalAt,
        isRepeaterLocked,
        getConductorStrongPower,
        getConductorAnyPower,
        exportBurnoutState,
        importBurnoutState,
        clearAllBurnouts() {
            _torchToggleHistory.clear();
        },
        registerRole(roleName, roleHandlers) {
            if (roleName && roleHandlers && typeof roleHandlers === "object") {
                customRoles.set(roleName, roleHandlers);
            }
        }
    };

    // TickScheduler へレッドストーン遅延デバイス＆焼き切れ復帰ハンドラを自動登録
    if (tickScheduler && typeof tickScheduler.registerHandler === "function") {
        tickScheduler.registerHandler("redstone_device", (task, currentTick) => {
            handleScheduledDeviceTick(task, currentTick);
        });
        tickScheduler.registerHandler("redstone_torch_restart", (task, currentTick) => {
            handleScheduledDeviceTick(task, currentTick);
        });
    }

    return api;
}