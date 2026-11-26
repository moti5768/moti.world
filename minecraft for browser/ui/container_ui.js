"use strict";

/* ======================================================
   【コンテナGUI（チェスト／かまど）＆ プレイヤーHUD】(ui/container_ui.js)
   - Minecraft Java Edition 準拠のチェスト(27スロット)・かまど(原料/燃料/炎/進行/完成品)画面
   - index.html 変更不要（初回起動時にスタイルとDOMを自動生成）
   - サバイバルモード時の体力(HP)＆満腹度バー表示
   ====================================================== */

import { GAME_MODES } from '../entities/player_data.js';

function injectContainerStyles() {
    if (document.getElementById("mc-container-ui-style")) return;
    const style = document.createElement("style");
    style.id = "mc-container-ui-style";
    style.textContent = `
        #mc-container-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.55);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 3000;
            user-select: none;
            font-family: monospace, sans-serif;
        }
        #mc-container-panel {
            background: #c6c6c6;
            border: 3px solid #373737;
            box-shadow: inset 3px 3px 0 #ffffff, inset -3px -3px 0 #555555, 0 12px 32px rgba(0,0,0,0.6);
            padding: 14px 16px 16px;
            color: #222;
            min-width: 440px;
        }
        .mc-ui-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            font-weight: bold;
            font-size: 15px;
        }
        .mc-ui-close {
            background: #8b8b8b;
            border: 2px solid #373737;
            color: #fff;
            cursor: pointer;
            padding: 2px 8px;
            font-weight: bold;
        }
        .mc-ui-close:hover { background: #a85555; }
        .mc-slot-grid {
            display: grid;
            grid-template-columns: repeat(9, 44px);
            gap: 4px;
            margin-bottom: 12px;
        }
        .mc-slot {
            width: 44px;
            height: 44px;
            background: #8b8b8b;
            border-top: 2px solid #373737;
            border-left: 2px solid #373737;
            border-right: 2px solid #ffffff;
            border-bottom: 2px solid #ffffff;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-sizing: border-box;
        }
        .mc-slot:hover { background: #a4a4a4; }
        .mc-slot canvas { width: 34px !important; height: 34px !important; image-rendering: pixelated; pointer-events: none; }
        .mc-slot-count {
            position: absolute;
            right: 2px;
            bottom: 1px;
            color: #fff;
            font-size: 12px;
            font-weight: bold;
            text-shadow: 1px 1px 0 #000;
            pointer-events: none;
        }
        .mc-slot-label {
            font-size: 11px;
            color: #444;
            margin-bottom: 4px;
        }
        .mc-furnace-layout {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 24px;
            margin: 14px 0 18px;
        }
        .mc-furnace-col {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
        }
        .mc-flame-bar {
            width: 26px;
            height: 26px;
            background: #444;
            border: 2px solid #222;
            position: relative;
            overflow: hidden;
        }
        .mc-flame-fill {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 0%;
            background: linear-gradient(to top, #ff4500, #ffcc00);
        }
        .mc-arrow-bar {
            width: 64px;
            height: 18px;
            background: #444;
            border: 2px solid #222;
            position: relative;
            overflow: hidden;
        }
        .mc-arrow-fill {
            position: absolute;
            top: 0;
            bottom: 0;
            left: 0;
            width: 0%;
            background: #ffffff;
        }
        .mc-ui-hint {
            font-size: 11px;
            color: #444;
            margin-top: 6px;
        }
        #mc-survival-hud {
            position: fixed;
            left: 50%;
            bottom: 84px;
            transform: translateX(-50%);
            width: 460px;
            display: none;
            justify-content: space-between;
            pointer-events: none;
            z-index: 1500;
            font-family: monospace, sans-serif;
            text-shadow: 1px 1px 0 #000;
        }
        .mc-hud-bar {
            background: rgba(0, 0, 0, 0.45);
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 14px;
            font-weight: bold;
            letter-spacing: 1px;
        }
    `;
    document.head.appendChild(style);
}

export function createContainerUI(deps) {
    const {
        getBlockConfiguration,
        keyToId,
        idToKey,
        createPreview,
        getHotbarKeys,
        setHotbarSlotKey,
        onOpenChanged = null,
        onContainerModified = null,
        addChatMessage = null
    } = deps;

    injectContainerStyles();

    // コンテナ用モーダル DOM
    const backdrop = document.createElement("div");
    backdrop.id = "mc-container-backdrop";
    backdrop.innerHTML = `<div id="mc-container-panel"></div>`;
    document.body.appendChild(backdrop);
    const panel = backdrop.querySelector("#mc-container-panel");

    // サバイバル用 体力・満腹度 HUD DOM
    const survivalHud = document.createElement("div");
    survivalHud.id = "mc-survival-hud";
    survivalHud.innerHTML = `
        <div id="mc-hud-hp" class="mc-hud-bar" style="color:#ff4444;"></div>
        <div id="mc-hud-food" class="mc-hud-bar" style="color:#e6a23c;"></div>
    `;
    document.body.appendChild(survivalHud);
    const hudHpEl = survivalHud.querySelector("#mc-hud-hp");
    const hudFoodEl = survivalHud.querySelector("#mc-hud-food");

    let activeBE = null;
    let isOpen = false;
    let lastItemsHash = "";
    let lastProgressHash = "";
    let chestRefs = null;
    let furnaceRefs = null;
    let hotbarSlotEls = [];
    let lastHotbarSig = "";

    // モーダル外側クリックで閉じる
    backdrop.addEventListener("mousedown", (e) => {
        if (e.target === backdrop) close();
    });

    // コンテナを開いた直後の右クリック解放・モーダル上でのブラウザ標準メニュー表示を防止
    backdrop.addEventListener("contextmenu", (e) => {
        e.preventDefault();
    });

    async function renderSlotIcon(slotEl, blockKey, count) {
        const sig = (blockKey && count > 0) ? `${blockKey}:${count}` : "";
        if (slotEl.dataset.renderSig === sig) return;
        slotEl.dataset.renderSig = sig;

        const token = ((Number(slotEl.dataset.renderTok) || 0) + 1);
        slotEl.dataset.renderTok = String(token);

        if (!sig) {
            slotEl.innerHTML = "";
            slotEl.title = "";
            return;
        }

        const id = keyToId(blockKey);
        const cfg = getBlockConfiguration(id);
        let canvas = null;
        if (cfg && typeof createPreview === "function") {
            try {
                canvas = await createPreview(cfg);
            } catch (e) { }
        }
        // 非同期完了時にすでに別の内容へ更新されていれば破棄（点滅・逆転防止）
        if (Number(slotEl.dataset.renderTok) !== token) return;

        slotEl.title = cfg ? `${cfg.name} x${count}` : `${blockKey} x${count}`;
        slotEl.innerHTML = "";
        if (canvas) slotEl.appendChild(canvas);
        if (count > 1) {
            const badge = document.createElement("span");
            badge.className = "mc-slot-count";
            badge.textContent = String(count);
            slotEl.appendChild(badge);
        }
    }

    function addKeyToHotbarIfMissing(blockKey) {
        if (!blockKey) return;
        const keys = getHotbarKeys();
        if (keys.includes(blockKey)) return;
        for (let i = 0; i < 9; i++) {
            if (!keys[i]) {
                setHotbarSlotKey(i, blockKey);
                return;
            }
        }
    }

    function syncHotbarSlotsDOM() {
        if (hotbarSlotEls.length !== 9) return;
        const hotbarKeys = getHotbarKeys();
        const sig = hotbarKeys.join(",");
        if (sig === lastHotbarSig) return;
        lastHotbarSig = sig;
        for (let i = 0; i < 9; i++) {
            const key = hotbarKeys[i];
            hotbarSlotEls[i].dataset.hotbarKey = key || "";
            renderSlotIcon(hotbarSlotEls[i], key || "", key ? 1 : 0);
        }
    }

    function syncChestDOM(be) {
        if (!chestRefs) return;
        const slots = be.data.slots;
        for (let i = 0; i < 27; i++) {
            const item = slots[i];
            if (item && item.key && item.count > 0) {
                renderSlotIcon(chestRefs.slotEls[i], item.key, item.count);
            } else {
                renderSlotIcon(chestRefs.slotEls[i], "", 0);
            }
        }
        syncHotbarSlotsDOM();
    }

    function buildChestUI(be) {
        furnaceRefs = null;
        lastHotbarSig = "";
        panel.innerHTML = `
            <div class="mc-ui-header">
                <span>チェスト [${be.x}, ${be.y}, ${be.z}]</span>
                <button class="mc-ui-close" id="mc-ui-close-btn">✕</button>
            </div>
            <div class="mc-slot-label">チェスト (27スロット) — クリックで取り出し / 右クリックで1個削除</div>
            <div class="mc-slot-grid" id="mc-chest-grid"></div>
            <div class="mc-slot-label">ホットバー — クリックでチェストへ格納 (Shift+クリックで16個)</div>
            <div class="mc-slot-grid" id="mc-hotbar-grid"></div>
        `;
        panel.querySelector("#mc-ui-close-btn").onclick = close;

        const chestGrid = panel.querySelector("#mc-chest-grid");
        const slots = be.data.slots;
        const slotEls = new Array(27);

        for (let i = 0; i < 27; i++) {
            const slotEl = document.createElement("div");
            slotEl.className = "mc-slot";
            slotEl.addEventListener("click", () => {
                const cur = slots[i];
                if (!cur) return;
                addKeyToHotbarIfMissing(cur.key);
                cur.count--;
                if (cur.count <= 0) slots[i] = null;
                onUserEdited();
            });
            slotEl.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                if (!slots[i]) return;
                slots[i].count--;
                if (slots[i].count <= 0) slots[i] = null;
                onUserEdited();
            });
            chestGrid.appendChild(slotEl);
            slotEls[i] = slotEl;
        }

        const hotbarGrid = panel.querySelector("#mc-hotbar-grid");
        hotbarSlotEls = new Array(9);
        for (let i = 0; i < 9; i++) {
            const slotEl = document.createElement("div");
            slotEl.className = "mc-slot";
            slotEl.addEventListener("click", (e) => {
                const key = slotEl.dataset.hotbarKey;
                if (!key) return;
                const addAmount = e.shiftKey ? 16 : 1;
                let remaining = addAmount;

                for (let s = 0; s < 27 && remaining > 0; s++) {
                    if (slots[s] && slots[s].key === key && slots[s].count < 64) {
                        const add = Math.min(remaining, 64 - slots[s].count);
                        slots[s].count += add;
                        remaining -= add;
                    }
                }
                for (let s = 0; s < 27 && remaining > 0; s++) {
                    if (!slots[s]) {
                        const add = Math.min(remaining, 64);
                        slots[s] = { key, count: add };
                        remaining -= add;
                    }
                }
                onUserEdited();
            });
            hotbarGrid.appendChild(slotEl);
            hotbarSlotEls[i] = slotEl;
        }

        chestRefs = { slotEls };
        syncChestDOM(be);
    }

    function syncFurnaceProgressDOM(be) {
        if (!furnaceRefs) return;
        const d = be.data;
        const burnPct = d.burnDuration > 0 ? Math.min(100, Math.round((d.burnTime / d.burnDuration) * 100)) : 0;
        const cookPct = d.cookTimeTotal > 0 ? Math.min(100, Math.round((d.cookTime / d.cookTimeTotal) * 100)) : 0;

        furnaceRefs.flameFill.style.height = `${burnPct}%`;
        furnaceRefs.flameBar.title = `残り燃焼: ${d.burnTime}t`;
        furnaceRefs.arrowFill.style.width = `${cookPct}%`;
        furnaceRefs.arrowBar.title = `精錬進行: ${cookPct}%`;
        furnaceRefs.cookLabel.textContent = `${cookPct}%`;
    }

    function syncFurnaceSlotsDOM(be) {
        if (!furnaceRefs) return;
        const d = be.data;
        if (d.input && d.input.count > 0) renderSlotIcon(furnaceRefs.inSlot, d.input.key, d.input.count);
        else renderSlotIcon(furnaceRefs.inSlot, "", 0);

        if (d.fuelCount > 0) renderSlotIcon(furnaceRefs.fuelSlot, "COAL_ORE", d.fuelCount);
        else renderSlotIcon(furnaceRefs.fuelSlot, "", 0);

        if (d.output && d.output.count > 0) renderSlotIcon(furnaceRefs.outSlot, d.output.key, d.output.count);
        else renderSlotIcon(furnaceRefs.outSlot, "", 0);

        furnaceRefs.fuelLabel.textContent = `燃料 (${d.fuelCount})`;
        syncHotbarSlotsDOM();
    }

    function buildFurnaceUI(be) {
        chestRefs = null;
        lastHotbarSig = "";
        const d = be.data;

        panel.innerHTML = `
            <div class="mc-ui-header">
                <span>かまど [${be.x}, ${be.y}, ${be.z}]</span>
                <button class="mc-ui-close" id="mc-ui-close-btn">✕</button>
            </div>
            <div class="mc-furnace-layout">
                <div class="mc-furnace-col">
                    <div class="mc-slot-label">原料</div>
                    <div class="mc-slot" id="mc-furnace-input"></div>
                    <div class="mc-flame-bar" id="mc-furnace-flame-bar"><div class="mc-flame-fill" id="mc-furnace-flame-fill"></div></div>
                    <div class="mc-slot" id="mc-furnace-fuel" title="クリックで燃料追加"></div>
                    <div class="mc-slot-label" id="mc-furnace-fuel-label"></div>
                </div>
                <div class="mc-furnace-col">
                    <div class="mc-arrow-bar" id="mc-furnace-arrow-bar"><div class="mc-arrow-fill" id="mc-furnace-arrow-fill"></div></div>
                    <div class="mc-slot-label" id="mc-furnace-cook-label"></div>
                </div>
                <div class="mc-furnace-col">
                    <div class="mc-slot-label">完成品</div>
                    <div class="mc-slot" id="mc-furnace-output"></div>
                </div>
            </div>
            <div class="mc-slot-label">ホットバー — 左クリックで原料へ投入 / 右クリックで燃料(+1)</div>
            <div class="mc-slot-grid" id="mc-hotbar-grid"></div>
            <div class="mc-ui-hint">レシピ例: 丸石→石 / 砂→ガラス / 原木・板材→燃料</div>
        `;
        panel.querySelector("#mc-ui-close-btn").onclick = close;

        const inSlot = panel.querySelector("#mc-furnace-input");
        const fuelSlot = panel.querySelector("#mc-furnace-fuel");
        const outSlot = panel.querySelector("#mc-furnace-output");

        inSlot.addEventListener("click", () => {
            if (!d.input) return;
            addKeyToHotbarIfMissing(d.input.key);
            d.input.count--;
            if (d.input.count <= 0) d.input = null;
            onUserEdited();
        });

        fuelSlot.addEventListener("click", () => {
            d.fuelCount = Math.min(64, d.fuelCount + 1);
            onUserEdited();
        });

        outSlot.addEventListener("click", () => {
            if (!d.output) return;
            addKeyToHotbarIfMissing(d.output.key);
            if (typeof addChatMessage === "function") {
                addChatMessage(`かまどから ${d.output.key} x${d.output.count} を取り出しました`, "#55ff55");
            }
            d.output = null;
            onUserEdited();
        });

        const hotbarGrid = panel.querySelector("#mc-hotbar-grid");
        hotbarSlotEls = new Array(9);
        for (let i = 0; i < 9; i++) {
            const slotEl = document.createElement("div");
            slotEl.className = "mc-slot";
            slotEl.addEventListener("click", () => {
                const key = slotEl.dataset.hotbarKey;
                if (!key) return;
                if (!d.input) d.input = { key, count: 1 };
                else if (d.input.key === key && d.input.count < 64) d.input.count++;
                else d.input = { key, count: 1 };
                onUserEdited();
            });
            slotEl.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                const key = slotEl.dataset.hotbarKey;
                if (!key) return;
                d.fuelCount = Math.min(64, d.fuelCount + 1);
                onUserEdited();
            });
            hotbarGrid.appendChild(slotEl);
            hotbarSlotEls[i] = slotEl;
        }

        furnaceRefs = {
            inSlot,
            fuelSlot,
            outSlot,
            flameBar: panel.querySelector("#mc-furnace-flame-bar"),
            flameFill: panel.querySelector("#mc-furnace-flame-fill"),
            arrowBar: panel.querySelector("#mc-furnace-arrow-bar"),
            arrowFill: panel.querySelector("#mc-furnace-arrow-fill"),
            cookLabel: panel.querySelector("#mc-furnace-cook-label"),
            fuelLabel: panel.querySelector("#mc-furnace-fuel-label")
        };

        syncFurnaceSlotsDOM(be);
        syncFurnaceProgressDOM(be);
    }

    function computeItemsHash(be) {
        if (!be) return "";
        if (be.type === "minecraft:furnace") {
            const d = be.data;
            return `f|${d.fuelCount}|${d.input?.key}:${d.input?.count}|${d.output?.key}:${d.output?.count}`;
        }
        return `c|${be.key}|${be.data.slots.map(s => s ? `${s.key}:${s.count}` : "").join(",")}`;
    }

    function computeProgressHash(be) {
        if (!be || be.type !== "minecraft:furnace") return "";
        const d = be.data;
        return `${d.burnTime}|${d.burnDuration}|${d.cookTime}`;
    }

    function onUserEdited() {
        if (!isOpen || !activeBE) return;
        const nextItemsHash = computeItemsHash(activeBE);
        const changed = nextItemsHash !== lastItemsHash;
        lastItemsHash = nextItemsHash;
        lastProgressHash = computeProgressHash(activeBE);

        if (activeBE.type === "minecraft:chest") {
            syncChestDOM(activeBE);
        } else if (activeBE.type === "minecraft:furnace") {
            syncFurnaceSlotsDOM(activeBE);
            syncFurnaceProgressDOM(activeBE);
        }
        if (changed && typeof onContainerModified === "function") {
            onContainerModified(activeBE);
        }
    }

    function open(be) {
        if (!be) return;
        if (isOpen && activeBE && activeBE !== be && typeof onOpenChanged === "function") {
            onOpenChanged(false, activeBE);
        }
        activeBE = be;
        isOpen = true;
        backdrop.style.display = "flex";
        lastItemsHash = computeItemsHash(be);
        lastProgressHash = computeProgressHash(be);
        if (be.type === "minecraft:chest") buildChestUI(be);
        else if (be.type === "minecraft:furnace") buildFurnaceUI(be);
        if (typeof onOpenChanged === "function") onOpenChanged(true, activeBE);
    }

    function close() {
        if (!isOpen) return;
        const closedBE = activeBE;
        isOpen = false;
        activeBE = null;
        chestRefs = null;
        furnaceRefs = null;
        hotbarSlotEls = [];
        lastHotbarSig = "";
        lastItemsHash = "";
        lastProgressHash = "";
        backdrop.style.display = "none";
        if (typeof onOpenChanged === "function") onOpenChanged(false, closedBE);
    }

    function refreshIfOpen() {
        if (!isOpen || !activeBE) return;

        if (activeBE.type === "minecraft:furnace") {
            const pHash = computeProgressHash(activeBE);
            if (pHash !== lastProgressHash) {
                lastProgressHash = pHash;
                syncFurnaceProgressDOM(activeBE);
            }
            const iHash = computeItemsHash(activeBE);
            if (iHash !== lastItemsHash) {
                lastItemsHash = iHash;
                syncFurnaceSlotsDOM(activeBE);
            }
            return;
        }

        const iHash = computeItemsHash(activeBE);
        if (iHash !== lastItemsHash) {
            lastItemsHash = iHash;
            syncChestDOM(activeBE);
        }
    }

    function updateSurvivalHUD(playerDataObj) {
        if (!playerDataObj || playerDataObj.gameMode !== GAME_MODES.SURVIVAL) {
            if (survivalHud.style.display !== "none") survivalHud.style.display = "none";
            return;
        }
        if (survivalHud.style.display !== "flex") survivalHud.style.display = "flex";

        const hearts = Math.max(0, Math.min(10, Math.ceil(playerDataObj.health / 2)));
        const foods = Math.max(0, Math.min(10, Math.ceil(playerDataObj.foodLevel / 2)));
        const hpStr = "♥".repeat(hearts) + "♡".repeat(10 - hearts) + ` ${Math.ceil(playerDataObj.health)}/20`;
        const fdStr = "◆".repeat(foods) + "◇".repeat(10 - foods) + ` ${playerDataObj.foodLevel}/20`;
        if (hudHpEl.textContent !== hpStr) hudHpEl.textContent = hpStr;
        if (hudFoodEl.textContent !== fdStr) hudFoodEl.textContent = fdStr;
    }

    return {
        get isOpen() { return isOpen; },
        get activeBlockEntity() { return activeBE; },
        open,
        close,
        refreshIfOpen,
        updateSurvivalHUD
    };
}