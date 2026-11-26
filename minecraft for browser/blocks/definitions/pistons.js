"use strict";
import {
    getBlockStateProp, setBlockStateProp,
    getRawBlockId, getRawLocalState, packRawBlock
} from '../../blockstate.js';
import {
    BLOCK_TYPES, defineBlocks, getBlockConfiguration, isSupportDependentBlock
} from '../registry.js';

// blockstates 配下のサブフォルダ設定
const PISTON_BLOCKSTATE_FOLDER = "pistons";

// 6方向テーブル（facing プロパティ順と完全一致）
export const PISTON_FACINGS = ['north', 'east', 'south', 'west', 'up', 'down'];
export const PISTON_DX = [0, 1, 0, -1, 0, 0];
export const PISTON_DY = [0, 0, 0, 0, 1, -1];
export const PISTON_DZ = [-1, 0, 1, 0, 0, 0];

const MAX_PUSH_BLOCKS = 12;
const PISTON_MOVE_TICKS = 2; // Java Edition 準拠: MovingPiston 完了まで 2 game ticks
const SILENT_WRITE = { notifyNC: false, notifyPP: false, notifyRedstone: false, notifyFluid: false };

// Java Edition PistonBaseBlock.TRIGGER_* 定数に完全一致
const ACTION_EXTEND = 0; // TRIGGER_EXTEND
const ACTION_CONTRACT = 1; // TRIGGER_CONTRACT (粘着引き戻しあり)
const ACTION_DROP = 2; // TRIGGER_DROP     (短パルス・0-tick 引きはがし)

// 外部ワールドAPI（script.js から PistonEngine.init で注入）
let _deps = {
    getRaw: null,
    setBlock: null,
    notifyBlock: null,
    getEngine: null,
    getCurrentTick: null,
    isHandlingScheduledTicks: null
};

// 座標ごとの独立 MovingBlock（Java Edition の PistonMovingBlockEntity 相当）
// Map<coordKey, MovingBlock>
const _movingBlocks = new Map();

// Java Edition ServerLevel.blockEvents 相当の FIFO キュー（重複排除付き）
const _pendingBlockEvents = [];
const _pendingEventKeys = new Set();

// 3D スライドアニメーション接続フック
let _pistonAnimatorCallback = null;
export function registerPistonAnimator(fn) {
    _pistonAnimatorCallback = (typeof fn === "function") ? fn : null;
}

function pistonCoordKey(x, y, z) {
    return `${x},${y},${z}`;
}

function isPistonId(id) {
    return id === BLOCK_TYPES.PISTON || id === BLOCK_TYPES.STICKY_PISTON;
}

function isCoordInTransit(wx, wy, wz) {
    if (_movingBlocks.size === 0) return false;
    return _movingBlocks.has(pistonCoordKey(wx | 0, wy | 0, wz | 0));
}

function registerMovingBlock(mb) {
    _movingBlocks.set(mb.key, mb);
}

/**
 * Java Edition PistonMovingBlockEntity.finalTick() 相当:
 * 指定座標の MovingBlock を確定させて通常ブロックへ戻し、到着通知を発火する
 */
function finishMovingBlock(key, skipNotify = false) {
    const mb = _movingBlocks.get(key);
    if (!mb || mb.finished) return false;

    mb.finished = true;
    _movingBlocks.delete(key);

    if (!skipNotify) {
        const notifyBlock = _deps.notifyBlock;
        if (typeof notifyBlock === "function") {
            notifyBlock(mb.x, mb.y, mb.z, mb.oldRaw, mb.movedRaw);
        }
        // Java Edition PistonMovingBlockEntity.tick() -> level.setBlock() -> PistonBaseBlock.onPlace() 準拠:
        // 移動完了したブロックがピストン（収縮完了した本体・別ピストンに押された/引き戻されたピストンすべて）なら即座に信号を再評価する
        if (mb.isSourcePiston || isPistonId(getRawBlockId(mb.movedRaw))) {
            checkPistonIfExtend(mb.x, mb.y, mb.z);
        }
    }
    return true;
}

function queueBlockEvent(x, y, z, action, facingIdx) {
    const bx = x | 0, by = y | 0, bz = z | 0;
    const evKey = `${bx},${by},${bz},${action},${facingIdx}`;
    if (_pendingEventKeys.has(evKey)) return;
    _pendingEventKeys.add(evKey);
    _pendingBlockEvents.push(bx, by, bz, action, facingIdx, evKey);
}

function breaksWhenPushed(id) {
    if (id === BLOCK_TYPES.SKY) return true;
    const cfg = getBlockConfiguration(id);
    if (!cfg) return true;
    if (cfg.pistonPushReaction === "destroy") return true;
    if (cfg.overwrite === true || cfg.geometryType === "water") return true;
    if (isSupportDependentBlock(id)) return true;
    return false;
}

function cannotPushBlock(id, meta) {
    if (id === BLOCK_TYPES.BEDROCK || id === BLOCK_TYPES.PISTON_HEAD) return true;
    const cfg = getBlockConfiguration(id);
    if (!cfg) return true;
    if (cfg.pistonPushReaction === "block") return true;
    if (cfg.blockEntityType) return true; // Java Edition 準拠: チェスト・かまど等は不動
    if (isPistonId(id) && getBlockStateProp(id, meta, "extended")) return true;
    return false;
}

/**
 * 押し出しライン（最大12ブロック）を解決する（移動中ブロックがあるマスは通過不可）
 */
function resolvePushLine(px, py, pz, dx, dy, dz, getRaw) {
    const toMove = [];
    let toDestroy = null;

    for (let step = 1; step <= MAX_PUSH_BLOCKS + 1; step++) {
        const cx = px + dx * step;
        const cy = py + dy * step;
        const cz = pz + dz * step;
        if (cy < 0 || cy >= 256) return null;

        if (isCoordInTransit(cx, cy, cz)) return null;

        const raw = getRaw(cx, cy, cz);
        if (raw < 0) return null;

        const id = getRawBlockId(raw);
        if (id === BLOCK_TYPES.SKY) {
            return { toMove, toDestroy };
        }

        const meta = getRawLocalState(raw);
        if (breaksWhenPushed(id)) {
            toDestroy = { x: cx, y: cy, z: cz, raw };
            return { toMove, toDestroy };
        }

        if (cannotPushBlock(id, meta)) return null;
        if (step > MAX_PUSH_BLOCKS) return null;

        toMove.push({ x: cx, y: cy, z: cz, raw });
    }
    return null;
}

/**
 * Java Edition PistonBaseBlock.checkIfExtend 完全準拠:
 * 信号と状態を確認し、実行すべき BlockEvent (EXTEND / CONTRACT / DROP) をキューへ積む
 */
function checkPistonIfExtend(x, y, z) {
    const bx = x | 0, by = y | 0, bz = z | 0;
    const getRaw = _deps.getRaw;
    const engine = _deps.getEngine ? _deps.getEngine() : null;
    if (!getRaw || !engine) return;

    // 収縮中などで自身が MovingBlock の間は反応しない（Java Edition では Blocks.MOVING_PISTON 状態）
    if (isCoordInTransit(bx, by, bz)) return;

    const raw = getRaw(bx, by, bz);
    if (raw <= 0) return;

    const id = getRawBlockId(raw);
    if (!isPistonId(id)) return;

    const meta = getRawLocalState(raw);
    const facingName = getBlockStateProp(id, meta, "facing");
    const facingIdx = PISTON_FACINGS.indexOf(facingName);
    if (facingIdx < 0) return;

    const dx = PISTON_DX[facingIdx];
    const dy = PISTON_DY[facingIdx];
    const dz = PISTON_DZ[facingIdx];

    const extended = getBlockStateProp(id, meta, "extended");
    const powered = engine.getPistonSignalAt(bx, by, bz, dx, dy, dz) > 0;

    if (powered && !extended) {
        if (resolvePushLine(bx, by, bz, dx, dy, dz, getRaw) !== null) {
            queueBlockEvent(bx, by, bz, ACTION_EXTEND, facingIdx);
        }
    } else if (!powered && extended) {
        const currentTick = _deps.getCurrentTick ? _deps.getCurrentTick() : 0;
        const isHandlingScheduled = _deps.isHandlingScheduledTicks ? !!_deps.isHandlingScheduledTicks() : false;
        const b2x = bx + dx * 2, b2y = by + dy * 2, b2z = bz + dz * 2;
        const mb2 = _movingBlocks.get(pistonCoordKey(b2x, b2y, b2z));
        // Java Edition PistonBaseBlock.checkIfExtend 完全準拠:
        // progressO < 0.5 (0gt/1gt) || lastTicked === currentTick || Phase 1(ScheduledTick実行中) なら ACTION_DROP
        const isSpit = !!(
            mb2 && !mb2.finished && mb2.extending &&
            mb2.dx === dx && mb2.dy === dy && mb2.dz === dz &&
            (mb2.progressO < 0.5 || mb2.lastTicked === currentTick || isHandlingScheduled)
        );
        queueBlockEvent(bx, by, bz, isSpit ? ACTION_DROP : ACTION_CONTRACT, facingIdx);
    }
}

/**
 * Java Edition PistonBaseBlock.triggerEvent(TRIGGER_EXTEND) 準拠
 */
function executeExtend(x, y, z, id, meta, facingIdx, dx, dy, dz, currentTick, getRaw, setBlock, notifyBlock) {
    const plan = resolvePushLine(x, y, z, dx, dy, dz, getRaw);
    if (!plan) return false;

    const isSticky = (id === BLOCK_TYPES.STICKY_PISTON);
    const facingName = PISTON_FACINGS[facingIdx];
    const hx = x + dx, hy = y + dy, hz = z + dz;
    const animatedBlocks = [];

    const oldBaseRaw = packRawBlock(id, meta);
    const oldHeadSpotRaw = getRaw(hx, hy, hz);
    const oldTargetRaws = new Array(plan.toMove.length);
    for (let i = 0; i < plan.toMove.length; i++) {
        const b = plan.toMove[i];
        oldTargetRaws[i] = getRaw(b.x + dx, b.y + dy, b.z + dz);
    }

    // 1. 終端の破壊対象があれば静かに消去
    if (plan.toDestroy) {
        setBlock(plan.toDestroy.x, plan.toDestroy.y, plan.toDestroy.z, BLOCK_TYPES.SKY, SILENT_WRITE);
    }

    // 2. 奥側から順に 1 マス先へ書き込み、各移動先を独立した MovingBlock (2gt) として登録
    for (let i = plan.toMove.length - 1; i >= 0; i--) {
        const b = plan.toMove[i];
        const tx = b.x + dx, ty = b.y + dy, tz = b.z + dz;
        setBlock(tx, ty, tz, b.raw, SILENT_WRITE);
        registerMovingBlock({
            key: pistonCoordKey(tx, ty, tz),
            x: tx, y: ty, z: tz,
            movedRaw: b.raw,
            oldRaw: oldTargetRaws[i],
            dx, dy, dz,
            extending: true,
            isSourcePiston: false,
            isHead: false,
            progress: 0.0,
            progressO: 0.0,
            lastTicked: 0,
            finished: false
        });
        animatedBlocks.push({
            fromX: b.x, fromY: b.y, fromZ: b.z,
            toX: tx, toY: ty, toZ: tz,
            raw: b.raw
        });
    }

    // 3. 1マス先へピストンヘッドを独立 MovingBlock (2gt) として配置
    //    ※Java Edition PistonBaseBlock.triggerEvent 準拠:
    //      moveBlocks() 完了まで本体(x,y,z)は extended=false のまま維持する
    let headMeta = setBlockStateProp(BLOCK_TYPES.PISTON_HEAD, 0, "facing", facingName);
    headMeta = setBlockStateProp(BLOCK_TYPES.PISTON_HEAD, headMeta, "type", isSticky ? "sticky" : "normal");
    const headRaw = packRawBlock(BLOCK_TYPES.PISTON_HEAD, headMeta);

    setBlock(hx, hy, hz, headRaw, SILENT_WRITE);
    registerMovingBlock({
        key: pistonCoordKey(hx, hy, hz),
        x: hx, y: hy, z: hz,
        movedRaw: headRaw,
        oldRaw: oldHeadSpotRaw,
        dx, dy, dz,
        extending: true,
        isSourcePiston: false,
        isHead: true,
        progress: 0.0,
        progressO: 0.0,
        lastTicked: 0,
        finished: false
    });

    // 4. moveBlocks() 内の移動元・破壊先の周囲通知（この時点では本体 extended=false なので自己遮断で0-tick収縮しない）
    if (typeof notifyBlock === "function") {
        if (plan.toDestroy) {
            notifyBlock(plan.toDestroy.x, plan.toDestroy.y, plan.toDestroy.z, plan.toDestroy.raw, BLOCK_TYPES.SKY);
        }
        for (let i = plan.toMove.length - 1; i >= 0; i--) {
            const b = plan.toMove[i];
            notifyBlock(b.x, b.y, b.z, b.raw, BLOCK_TYPES.SKY);
        }
    }

    // 5. moveBlocks() 完了後に本体を extended=true へ確定し、周囲6隣接（上の更新用ピストン等）のみ通知
    const extMeta = setBlockStateProp(id, meta, "extended", true);
    const extBaseRaw = packRawBlock(id, extMeta);
    setBlock(x, y, z, extBaseRaw, SILENT_WRITE);

    if (_pistonAnimatorCallback) {
        _pistonAnimatorCallback({
            type: "extend",
            x, y, z, dx, dy, dz,
            facing: facingName,
            isSticky,
            headRaw,
            movedBlocks: animatedBlocks,
            durationTicks: PISTON_MOVE_TICKS
        });
    }

    if (typeof notifyBlock === "function") {
        notifyBlock(x, y, z, oldBaseRaw, extBaseRaw);
    }

    return true;
}

/**
 * Java Edition PistonBaseBlock.triggerEvent(TRIGGER_CONTRACT / TRIGGER_DROP) 完全準拠
 */
function executeRetract(x, y, z, id, meta, facingIdx, dx, dy, dz, action, currentTick, getRaw, setBlock, notifyBlock) {
    const isSticky = (id === BLOCK_TYPES.STICKY_PISTON);
    const facingName = PISTON_FACINGS[facingIdx];
    const hx = x + dx, hy = y + dy, hz = z + dz;
    const px = x + dx * 2, py = y + dy * 2, pz = z + dz * 2;
    const headKey = pistonCoordKey(hx, hy, hz);
    const animatedBlocks = [];

    // 1. 自身のヘッドがまだ移動中であれば確定解除（ヘッド自身はこの後撤去するため通知はスキップ）
    const headMb = _movingBlocks.get(headKey);
    if (headMb && !headMb.finished && headMb.isHead) {
        finishMovingBlock(headKey, true);
    }

    const oldBaseRaw = packRawBlock(id, meta);
    const retMeta = setBlockStateProp(id, meta, "extended", false);
    const retBaseRaw = packRawBlock(id, retMeta);

    const oldHeadRaw = getRaw(hx, hy, hz);
    const hasOwnHead = (
        oldHeadRaw > 0 &&
        getRawBlockId(oldHeadRaw) === BLOCK_TYPES.PISTON_HEAD &&
        getBlockStateProp(BLOCK_TYPES.PISTON_HEAD, getRawLocalState(oldHeadRaw), "facing") === facingName
    );

    // 2. 本体 (x, y, z) を extended=false にして 2gt の間 MovingBlock (isSourcePiston=true) に登録
    setBlock(x, y, z, retBaseRaw, SILENT_WRITE);
    registerMovingBlock({
        key: pistonCoordKey(x, y, z),
        x, y, z,
        movedRaw: retBaseRaw,
        oldRaw: oldBaseRaw,
        dx: -dx, dy: -dy, dz: -dz,
        extending: false,
        isSourcePiston: true,
        isHead: false,
        progress: 0.0,
        progressO: 0.0,
        lastTicked: 0,
        finished: false
    });

    let pulledRaw = 0;
    let spitBlockKey = null;

    if (isSticky) {
        const pKey = pistonCoordKey(px, py, pz);
        const mb2 = _movingBlocks.get(pKey);
        if (mb2 && !mb2.finished && mb2.extending && mb2.dx === dx && mb2.dy === dy && mb2.dz === dz) {
            // Java Edition 0-tick / 1rt 引きはがし: 2マス先で伸長移動中だったブロックを即確定して置き去り
            spitBlockKey = pKey;
            if (hasOwnHead) {
                setBlock(hx, hy, hz, BLOCK_TYPES.SKY, SILENT_WRITE);
            }
        } else if (action === ACTION_CONTRACT && py >= 0 && py < 256 && !isCoordInTransit(px, py, pz)) {
            // 通常の粘着引き戻し
            const candRaw = getRaw(px, py, pz);
            if (candRaw > 0) {
                const candId = getRawBlockId(candRaw);
                const candMeta = getRawLocalState(candRaw);
                if (candId !== BLOCK_TYPES.SKY && !cannotPushBlock(candId, candMeta) && !breaksWhenPushed(candId)) {
                    pulledRaw = candRaw;
                }
            }
            if (pulledRaw > 0) {
                setBlock(px, py, pz, BLOCK_TYPES.SKY, SILENT_WRITE);
                setBlock(hx, hy, hz, pulledRaw, SILENT_WRITE);
                registerMovingBlock({
                    key: headKey,
                    x: hx, y: hy, z: hz,
                    movedRaw: pulledRaw,
                    oldRaw: oldHeadRaw,
                    dx: -dx, dy: -dy, dz: -dz,
                    extending: false,
                    isSourcePiston: false,
                    isHead: false,
                    progress: 0.0,
                    progressO: 0.0,
                    lastTicked: 0,
                    finished: false
                });
                animatedBlocks.push({
                    fromX: px, fromY: py, fromZ: pz,
                    toX: hx, toY: hy, toZ: hz,
                    raw: pulledRaw
                });
            } else if (hasOwnHead) {
                setBlock(hx, hy, hz, BLOCK_TYPES.SKY, SILENT_WRITE);
            }
        } else if (hasOwnHead) {
            setBlock(hx, hy, hz, BLOCK_TYPES.SKY, SILENT_WRITE);
        }
    } else if (hasOwnHead) {
        // 通常ピストンの収縮: ヘッド跡地は即座に空気化し、2gt 移動中ブロックは置かない
        setBlock(hx, hy, hz, BLOCK_TYPES.SKY, SILENT_WRITE);
    }

    // 3. 3D スライドアニメーション開始
    if (_pistonAnimatorCallback) {
        let headMeta = setBlockStateProp(BLOCK_TYPES.PISTON_HEAD, 0, "facing", facingName);
        headMeta = setBlockStateProp(BLOCK_TYPES.PISTON_HEAD, headMeta, "type", isSticky ? "sticky" : "normal");
        _pistonAnimatorCallback({
            type: "retract",
            x, y, z, dx, dy, dz,
            facing: facingName,
            isSticky,
            headRaw: packRawBlock(BLOCK_TYPES.PISTON_HEAD, headMeta),
            movedBlocks: animatedBlocks,
            durationTicks: PISTON_MOVE_TICKS
        });
    }

    // 4. 通知フェーズ（ヘッド撤去完了後に、本体通知 -> 置き去りブロック即確定 or 引き戻し元空化通知）
    if (typeof notifyBlock === "function") {
        notifyBlock(x, y, z, oldBaseRaw, retBaseRaw);
        if (pulledRaw > 0) {
            notifyBlock(px, py, pz, pulledRaw, BLOCK_TYPES.SKY);
        } else if (hasOwnHead) {
            notifyBlock(hx, hy, hz, oldHeadRaw, BLOCK_TYPES.SKY);
        }
    }
    if (spitBlockKey) {
        finishMovingBlock(spitBlockKey, false);
    }
}

/**
 * BlockEvent フェーズで 1 件のイベントを実行する
 */
function executeBlockEvent(x, y, z, action, expectedFacingIdx, currentTick) {
    const getRaw = _deps.getRaw;
    const setBlock = _deps.setBlock;
    const notifyBlock = _deps.notifyBlock;
    if (!getRaw || !setBlock) return;

    if (isCoordInTransit(x, y, z)) return;

    const raw = getRaw(x, y, z);
    if (raw <= 0) return;

    const id = getRawBlockId(raw);
    if (!isPistonId(id)) return;

    const meta = getRawLocalState(raw);
    const facingName = getBlockStateProp(id, meta, "facing");
    const facingIdx = PISTON_FACINGS.indexOf(facingName);
    if (facingIdx < 0 || facingIdx !== expectedFacingIdx) return;

    const dx = PISTON_DX[facingIdx];
    const dy = PISTON_DY[facingIdx];
    const dz = PISTON_DZ[facingIdx];
    const extended = getBlockStateProp(id, meta, "extended");

    // Java Edition PistonBaseBlock.triggerEvent 準拠: 実行直前の実信号を再確認
    const engine = _deps.getEngine ? _deps.getEngine() : null;
    const powered = !!(engine && engine.getPistonSignalAt(x, y, z, dx, dy, dz) > 0);

    if (action === ACTION_EXTEND) {
        if (extended || !powered) return;
        executeExtend(x, y, z, id, meta, facingIdx, dx, dy, dz, currentTick, getRaw, setBlock, notifyBlock);
    } else if (action === ACTION_CONTRACT || action === ACTION_DROP) {
        if (!extended || powered) return;
        executeRetract(x, y, z, id, meta, facingIdx, dx, dy, dz, action, currentTick, getRaw, setBlock, notifyBlock);
    }
}

export const PistonEngine = {
    init(deps) {
        _deps = { ..._deps, ...deps };
    },

    isCoordInTransit,

    cancelAt(x, y, z) {
        finishMovingBlock(pistonCoordKey(x | 0, y | 0, z | 0), true);
    },

    /**
     * Phase 2 (Java Edition ServerLevel.runBlockEvents 準拠)
     */
    runBlockEvents(currentTick) {
        const getRaw = _deps.getRaw;
        const deferred = [];
        let guard = 0;

        while (_pendingBlockEvents.length >= 6 && guard < 512) {
            const x = _pendingBlockEvents.shift();
            const y = _pendingBlockEvents.shift();
            const z = _pendingBlockEvents.shift();
            const action = _pendingBlockEvents.shift();
            const facingIdx = _pendingBlockEvents.shift();
            const evKey = _pendingBlockEvents.shift();
            _pendingEventKeys.delete(evKey);

            // ワールド再読込直後などチャンク未ロード時は破棄せず次Tickへ持ち越す
            if (getRaw && getRaw(x, y, z) < 0) {
                deferred.push(x, y, z, action, facingIdx, evKey);
                continue;
            }

            executeBlockEvent(x, y, z, action, facingIdx, currentTick);
            guard++;
        }

        for (let i = 0; i < deferred.length; i += 6) {
            const evKey = deferred[i + 5];
            if (_pendingEventKeys.has(evKey)) continue;
            _pendingEventKeys.add(evKey);
            _pendingBlockEvents.push(
                deferred[i], deferred[i + 1], deferred[i + 2],
                deferred[i + 3], deferred[i + 4], evKey
            );
        }
    },

    /**
     * Phase 3 (Java Edition PistonMovingBlockEntity.tick 完全準拠: 0.0 -> 0.5 -> 1.0 で到着確定)
     */
    tickMovingBlocks(currentTick) {
        if (_movingBlocks.size === 0) return;

        const getRaw = _deps.getRaw;
        const dueKeys = [];
        for (const mb of _movingBlocks.values()) {
            if (mb.finished) continue;
            // チャンク未ロード中は進行を凍結し、ロード完了後に正確なタイミングで再開
            if (getRaw && getRaw(mb.x, mb.y, mb.z) < 0) continue;

            mb.lastTicked = currentTick;
            mb.progressO = mb.progress;
            if (mb.progressO >= 1.0) {
                dueKeys.push(mb.key);
            } else {
                mb.progress += 0.5;
                if (mb.progress > 1.0) mb.progress = 1.0;
            }
        }
        for (let i = 0; i < dueKeys.length; i++) {
            finishMovingBlock(dueKeys[i], false);
        }
    },

    /**
     * ワールド保存用シリアライズ（MovingBlock の progress/progressO ＋ 未実行 BlockEvent キュー）
     */
    exportState(currentTick = 0) {
        const now = currentTick | 0;
        const movingBlocks = [];
        for (const mb of _movingBlocks.values()) {
            if (mb.finished) continue;
            movingBlocks.push({
                x: mb.x,
                y: mb.y,
                z: mb.z,
                movedRaw: mb.movedRaw,
                oldRaw: mb.oldRaw,
                dx: mb.dx,
                dy: mb.dy,
                dz: mb.dz,
                extending: !!mb.extending,
                isSourcePiston: !!mb.isSourcePiston,
                isHead: !!mb.isHead,
                progress: mb.progress,
                progressO: mb.progressO,
                tickedThisTick: mb.lastTicked === now
            });
        }

        const pendingEvents = [];
        for (let i = 0; i < _pendingBlockEvents.length; i += 6) {
            pendingEvents.push([
                _pendingBlockEvents[i],
                _pendingBlockEvents[i + 1],
                _pendingBlockEvents[i + 2],
                _pendingBlockEvents[i + 3],
                _pendingBlockEvents[i + 4]
            ]);
        }

        return { movingBlocks, pendingEvents };
    },

    /**
     * ワールド読込用復元（旧セーブの remainingTicks 形式にも後方互換）
     */
    importState(state, currentTick = 0) {
        PistonEngine.clear();
        if (!state || typeof state !== "object") return;

        const now = currentTick | 0;
        if (Array.isArray(state.movingBlocks)) {
            for (let i = 0; i < state.movingBlocks.length; i++) {
                const m = state.movingBlocks[i];
                if (!m) continue;
                const x = m.x | 0, y = m.y | 0, z = m.z | 0;
                let progress = Number.isFinite(m.progress) ? m.progress : 0.0;
                let progressO = Number.isFinite(m.progressO) ? m.progressO : 0.0;
                if (!Number.isFinite(m.progress) && Number.isFinite(m.remainingTicks)) {
                    const rem = Math.max(0, m.remainingTicks | 0);
                    progress = rem === 0 ? 1.0 : (rem === 1 ? 0.5 : 0.0);
                    progressO = rem === 0 ? 1.0 : 0.0;
                }
                registerMovingBlock({
                    key: pistonCoordKey(x, y, z),
                    x, y, z,
                    movedRaw: m.movedRaw & 0xFFFF,
                    oldRaw: m.oldRaw & 0xFFFF,
                    dx: m.dx | 0,
                    dy: m.dy | 0,
                    dz: m.dz | 0,
                    extending: !!m.extending,
                    isSourcePiston: !!m.isSourcePiston,
                    isHead: !!m.isHead,
                    progress,
                    progressO,
                    lastTicked: m.tickedThisTick ? now : 0,
                    finished: false
                });
            }
        }

        if (Array.isArray(state.pendingEvents)) {
            for (let i = 0; i < state.pendingEvents.length; i++) {
                const ev = state.pendingEvents[i];
                if (!Array.isArray(ev) || ev.length < 5) continue;
                queueBlockEvent(ev[0] | 0, ev[1] | 0, ev[2] | 0, ev[3] | 0, ev[4] | 0);
            }
        }
    },

    clear() {
        _movingBlocks.clear();
        _pendingBlockEvents.length = 0;
        _pendingEventKeys.clear();
    }
};

function pistonBlock(name, fallbackTexture, isSticky) {
    return {
        name,
        blockstateFolder: PISTON_BLOCKSTATE_FOLDER,
        blockstateFile: name,
        fallbackTexture,
        isStickyPiston: isSticky,
        redstoneRole: "piston",
        redstoneConductive: false,
        redstoneConnectsWire: false,
        redstoneDevice: true,
        properties: {
            facing: PISTON_FACINGS,
            extended: false
        },
        // アイテム表示は Java Edition 同様に上向き（木面／粘着面が上）
        previewState: { facing: 'up', extended: false },
        placementRule: "facing_6dir",
        collision: true,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,

        onAfterPlace: ({ x, y, z }) => {
            checkPistonIfExtend(x, y, z);
        },

        onRedstoneUpdate: ({ x, y, z }) => {
            checkPistonIfExtend(x, y, z);
        },

        onBlockUpdate: ({ x, y, z }) => {
            checkPistonIfExtend(x, y, z);
        },

        // 伸びた本体を破壊したら同じ向きのヘッドのみ連動破壊
        onDestroy: ({ x, y, z, blockId, state, getRaw, setBlock }) => {
            PistonEngine.cancelAt(x, y, z);
            if (!getBlockStateProp(blockId, state, "extended")) return;

            const facingName = getBlockStateProp(blockId, state, "facing");
            const facingIdx = PISTON_FACINGS.indexOf(facingName);
            if (facingIdx < 0) return;

            const hx = x + PISTON_DX[facingIdx];
            const hy = y + PISTON_DY[facingIdx];
            const hz = z + PISTON_DZ[facingIdx];
            PistonEngine.cancelAt(hx, hy, hz);
            const hRaw = getRaw(hx, hy, hz);
            if (
                hRaw > 0 &&
                getRawBlockId(hRaw) === BLOCK_TYPES.PISTON_HEAD &&
                getBlockStateProp(BLOCK_TYPES.PISTON_HEAD, getRawLocalState(hRaw), "facing") === facingName
            ) {
                setBlock(hx, hy, hz, BLOCK_TYPES.SKY);
            }
        }
    };
}

// Java Edition PistonHeadBlock.neighborChanged 準拠:
// 到着済みのピストンヘッドが更新を受けたら、背後の伸びた本体へ評価を転送する
function forwardHeadUpdateToBase(x, y, z, blockId, state) {
    if (isCoordInTransit(x, y, z)) return;

    const facingName = getBlockStateProp(blockId, state, "facing");
    const facingIdx = PISTON_FACINGS.indexOf(facingName);
    if (facingIdx < 0) return;

    const bx = x - PISTON_DX[facingIdx];
    const by = y - PISTON_DY[facingIdx];
    const bz = z - PISTON_DZ[facingIdx];
    const getRaw = _deps.getRaw;
    if (!getRaw) return;

    const bRaw = getRaw(bx, by, bz);
    if (bRaw <= 0) return;

    const bId = getRawBlockId(bRaw);
    const bMeta = getRawLocalState(bRaw);
    if (
        isPistonId(bId) &&
        getBlockStateProp(bId, bMeta, "extended") &&
        getBlockStateProp(bId, bMeta, "facing") === facingName
    ) {
        checkPistonIfExtend(bx, by, bz);
    }
}

defineBlocks({
    PISTON: pistonBlock("piston", "textures/blocks/piston_side.png", false),
    STICKY_PISTON: pistonBlock("sticky_piston", "textures/blocks/piston_side.png", true),
    PISTON_HEAD: {
        name: "piston_head",
        itemdisplay: false,
        blockstateFolder: PISTON_BLOCKSTATE_FOLDER,
        blockstateFile: "piston_head",
        fallbackTexture: "textures/blocks/piston_side.png",
        pistonPushReaction: "block",
        redstoneRole: "piston",
        redstoneConductive: false,
        redstoneConnectsWire: false,
        redstoneDevice: true,
        properties: {
            facing: PISTON_FACINGS,
            type: ['normal', 'sticky']
        },
        collision: true,
        transparent: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 1.5,

        // ヘッド隣接のブロック変化・回路変化を背後のピストン本体へ転送
        onBlockUpdate: ({ x, y, z, blockId, state }) => {
            forwardHeadUpdateToBase(x, y, z, blockId, state);
        },

        onRedstoneUpdate: ({ x, y, z, id, meta }) => {
            forwardHeadUpdateToBase(x, y, z, id, meta);
        },

        // ヘッドを壊したら背後にある同じ向きの伸びたピストン本体のみ連動破壊
        onDestroy: ({ x, y, z, blockId, state, getRaw, setBlock }) => {
            PistonEngine.cancelAt(x, y, z);
            const facingName = getBlockStateProp(blockId, state, "facing");
            const facingIdx = PISTON_FACINGS.indexOf(facingName);
            if (facingIdx < 0) return;

            const bx = x - PISTON_DX[facingIdx];
            const by = y - PISTON_DY[facingIdx];
            const bz = z - PISTON_DZ[facingIdx];
            const bRaw = getRaw(bx, by, bz);
            if (bRaw > 0) {
                const bId = getRawBlockId(bRaw);
                const bMeta = getRawLocalState(bRaw);
                if (
                    isPistonId(bId) &&
                    getBlockStateProp(bId, bMeta, "extended") &&
                    getBlockStateProp(bId, bMeta, "facing") === facingName
                ) {
                    PistonEngine.cancelAt(bx, by, bz);
                    setBlock(bx, by, bz, BLOCK_TYPES.SKY);
                }
            }
        }
    }
});