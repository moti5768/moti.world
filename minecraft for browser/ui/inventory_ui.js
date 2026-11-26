"use strict";
import * as THREE from '../build/three.module.js';

/* ======================================================
   【インベントリ・ホットバー・アイテムプレビュー統合UI】(ui/inventory_ui.js)
   - 2D / 3D / 専用 itemIcon プレビュー生成と32bitハッシュキャッシュ
   - クリエイティブタブ自動分類（creativeTab 明示指定を最優先）
   - ホットバー 9 スロット管理・ツールチップ・開閉状態の一元管理
   ====================================================== */

const INVENTORY_TABS = [
    { id: "all", label: "すべて" },
    { id: "building", label: "建築" },
    { id: "natural", label: "自然" },
    { id: "redstone", label: "レッドストーン" },
    { id: "functional", label: "機能" }
];

// creativeTab 未指定ブロック向けのフォールバック分類テーブル
const NATURAL_FALLBACK_NAMES = new Set([
    "grass_block", "dirt", "sand", "sandstone", "snow", "gravel"
]);
const FUNCTIONAL_FALLBACK_NAMES = new Set(["torch", "glowstone"]);
const BUILDING_EXTRA_NAMES = new Set(["sandstone", "glowstone"]);

const HOTBAR_ICON_SIZE_PX = "34px";
const INVENTORY_ICON_SIZE_PX = "38px";

function createCanvas(size) {
    return Object.assign(document.createElement("canvas"), { width: size, height: size });
}

// ID(0~65535)、サイズ(0~255)、タイプ(0:2D / 1:3D / 2:itemIcon) を1つの32bit整数にパック
function getPreviewHash(id, size, type) {
    return (id << 16) | (size << 8) | type;
}

/**
 * ブロック定義の creativeTab（明示指定）または属性から所属タブ配列を自動解決する
 */
function resolveBlockCreativeTabs(cfg) {
    if (cfg.creativeTab) {
        return Array.isArray(cfg.creativeTab) ? cfg.creativeTab : [cfg.creativeTab];
    }

    const tabs = [];
    const name = cfg.name || "";
    const gType = cfg.geometryType || "cube";

    // 1. レッドストーン系（デフォルト値 "none" を除外し厳密判定）
    const hasRedstoneRole = typeof cfg.redstoneRole === "string" &&
        cfg.redstoneRole.length > 0 &&
        cfg.redstoneRole !== "none";

    if (
        hasRedstoneRole ||
        cfg.redstoneDevice === true ||
        cfg.redstonePowerOutput > 0 ||
        cfg.isStickyPiston === true
    ) {
        tabs.push("redstone");
    }

    // 2. 機能・装飾系（ドア・トラップドアはレッドストーンと機能の両方に表示）
    if (
        cfg.blockEntityType ||
        cfg.isLadder === true ||
        FUNCTIONAL_FALLBACK_NAMES.has(name) ||
        cfg.redstoneRole === "door" ||
        cfg.redstoneRole === "trapdoor"
    ) {
        tabs.push("functional");
    }

    // 3. 自然系
    if (
        gType === "cross" ||
        gType === "water" ||
        gType === "leaves" ||
        cfg.isLog === true ||
        NATURAL_FALLBACK_NAMES.has(name) ||
        name.endsWith("_ore")
    ) {
        tabs.push("natural");
    }

    // 4. 建築系
    if (tabs.length === 0 || BUILDING_EXTRA_NAMES.has(name)) {
        tabs.push("building");
    }

    return tabs;
}

export function createInventoryUI(deps) {
    const {
        BLOCK_CONFIG,
        BLOCK_TYPES,
        getBlockConfiguration,
        getBlockGeometry,
        getBlockMaterialsFast,
        idToKey,
        keyToId,
        onActiveBlockChanged = null,
        onOpenChanged = null
    } = deps;

    let activeBlockType = 0;
    let selectedHotbarIndex = 0;
    let isOpen = false;
    let activeInventoryTab = "all";

    const inventoryEntries = [];
    const imageCache = new Map();
    const previewCache = new Map();

    // ツールチップ管理
    let tooltipEl = null;
    let lastMouseX = 0;
    let lastMouseY = 0;

    // 3Dプレビュー用オフスクリーン描画リソース（初回使用時に遅延初期化）
    let shared3DCanvas = null;
    let sharedRenderer = null;
    let sharedScene = null;
    let sharedLight = null;
    let sharedCamera = null;
    const _previewBox = new THREE.Box3();
    const _previewCenter = new THREE.Vector3();
    const _previewOrigin = new THREE.Vector3(0, 0, 0);

    function ensure3DPreviewContext() {
        if (sharedRenderer) return;
        shared3DCanvas = createCanvas(64);
        shared3DCanvas.style.display = "none";
        document.body.appendChild(shared3DCanvas);

        sharedRenderer = new THREE.WebGLRenderer({
            canvas: shared3DCanvas,
            alpha: true,
            antialias: false,
            stencil: false,
            powerPreference: "low-power"
        });
        sharedRenderer.debug.checkShaderErrors = false;
        sharedRenderer.setSize(64, 64);
        sharedRenderer.setClearColor(0x000000, 0);

        sharedScene = new THREE.Scene();
        sharedScene.add(new THREE.AmbientLight(0xffffff, 0.6));
        sharedLight = new THREE.DirectionalLight(0xffffff, 0.8);
        sharedLight.position.set(5, 5, 5);
        sharedScene.add(sharedLight);

        sharedCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
        sharedCamera.position.set(2, 2, 2);
        sharedCamera.lookAt(0, 0, 0);
    }

    function loadImage(src) {
        if (imageCache.has(src)) return Promise.resolve(imageCache.get(src));
        return new Promise((res, rej) => {
            const img = new Image();
            img.onload = () => {
                imageCache.set(src, img);
                res(img);
            };
            img.onerror = rej;
            img.src = src;
        });
    }

    // --- 2Dプレビュー ---
    function create2DPreview({ id, textures = {}, previewTexture = null, previewOptions = {} }, size) {
        const hashKey = getPreviewHash(id, size, 0);

        if (previewCache.has(hashKey)) {
            const cached = previewCache.get(hashKey);
            const clone = createCanvas(size);
            clone.getContext("2d").drawImage(cached, 0, 0);
            return clone;
        }

        const canvas = createCanvas(size);
        canvas.style.imageRendering = "pixelated";
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = false;

        const drawErrorPattern = (context, s) => {
            const half = s / 2;
            context.fillStyle = "#FF00FF";
            context.fillRect(0, 0, half, half);
            context.fillRect(half, half, half, half);
            context.fillStyle = "#000000";
            context.fillRect(half, 0, half, half);
            context.fillRect(0, half, half, half);
        };

        const src = previewTexture || textures.all || textures.side || textures.top;
        if (!src) {
            console.warn(`テクスチャ定義なし block: ${id}`);
            drawErrorPattern(ctx, size);
            const cacheCanvas = createCanvas(size);
            cacheCanvas.getContext("2d").drawImage(canvas, 0, 0);
            previewCache.set(hashKey, cacheCanvas);
            return canvas;
        }

        loadImage(src).then((img) => {
            const { x = 0, y = 0 } = previewOptions.offset || {};
            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(img, x, y, size, size);

            const cfg = getBlockConfiguration(id);
            const pMeta = (cfg && cfg.previewState !== null && cfg.previewState !== undefined)
                ? cfg.previewState
                : (cfg?.defaultState ?? 0);
            const variant = cfg && cfg._compiledVariants
                ? cfg._compiledVariants[pMeta & (cfg.stateMask ?? 0xFFF)]
                : null;
            const tintHex = (variant && variant.defaultColor !== undefined)
                ? variant.defaultColor
                : (cfg?.defaultColor ?? 0xffffff);

            if (tintHex !== 0xffffff) {
                const tr = (tintHex >> 16) & 255;
                const tg = (tintHex >> 8) & 255;
                const tb = tintHex & 255;
                const imgData = ctx.getImageData(0, 0, size, size);
                const d = imgData.data;
                for (let p = 0; p < d.length; p += 4) {
                    if (d[p + 3] === 0) continue;
                    d[p] = (d[p] * tr) / 255;
                    d[p + 1] = (d[p + 1] * tg) / 255;
                    d[p + 2] = (d[p + 2] * tb) / 255;
                }
                ctx.putImageData(imgData, 0, 0);
            }

            const cacheCanvas = createCanvas(size);
            cacheCanvas.getContext("2d").drawImage(canvas, 0, 0);
            previewCache.set(hashKey, cacheCanvas);
        }).catch((e) => {
            console.error(`画像読み込み失敗 block: ${id}`, e);
            drawErrorPattern(ctx, size);
            const cacheCanvas = createCanvas(size);
            cacheCanvas.getContext("2d").drawImage(canvas, 0, 0);
            previewCache.set(hashKey, cacheCanvas);
        });

        drawErrorPattern(ctx, size);
        return canvas;
    }

    // --- 3Dプレビュー（共有ジオメトリ・共有テクスチャ保護版） ---
    async function create3DPreview({ id, previewOptions = {}, geometryType }, size) {
        const hashKey = getPreviewHash(id, size, 1);

        if (previewCache.has(hashKey)) {
            const cached = previewCache.get(hashKey);
            const clone = createCanvas(size);
            clone.getContext("2d").drawImage(cached, 0, 0);
            return clone;
        }

        ensure3DPreviewContext();

        const previewCanvas = createCanvas(size);
        previewCanvas.style.imageRendering = "pixelated";

        if (sharedRenderer.domElement.width !== size || sharedRenderer.domElement.height !== size) {
            sharedRenderer.setSize(size, size);
        }

        const cfg = getBlockConfiguration(id);
        if (!cfg) return previewCanvas;

        const previewMeta = (cfg.previewState !== null && cfg.previewState !== undefined)
            ? cfg.previewState
            : (cfg.defaultState ?? 0);
        const maskedMeta = previewMeta & (cfg.stateMask ?? 0xFFF);
        const sharedGeom = getBlockGeometry(cfg.geometryType, cfg, maskedMeta);
        const sharedMats = getBlockMaterialsFast(id, maskedMeta);
        if (!sharedGeom || !sharedMats) {
            console.error(`プレビュー素材取得失敗 id: ${id}`);
            return previewCanvas;
        }

        const originalMaterials = Array.isArray(sharedMats) ? sharedMats : [sharedMats];
        const previewMaterials = originalMaterials.map((m) => new THREE.MeshBasicMaterial({
            map: m.map || null,
            color: m.color ? m.color.clone() : 0xffffff,
            side: THREE.FrontSide,
            transparent: m.transparent || false,
            opacity: m.opacity !== undefined ? m.opacity : 1,
            alphaTest: m.alphaTest || 0
        }));

        const mesh = new THREE.Mesh(
            sharedGeom,
            Array.isArray(sharedMats) ? previewMaterials : previewMaterials[0]
        );
        mesh.position.copy(_previewOrigin);

        try {
            const loadPromises = previewMaterials
                .map((m) => m.map)
                .filter((map) => map && !(map.image && map.image.complete))
                .map((map) => new Promise((resolve) => {
                    let waited = 0;
                    const checkLoaded = () => {
                        if ((map.image && map.image.complete) || waited > 3000) resolve();
                        else {
                            waited += 10;
                            setTimeout(checkLoaded, 10);
                        }
                    };
                    checkLoaded();
                }));
            await Promise.all(loadPromises);

            for (let i = 0; i < previewMaterials.length; i++) {
                const map = previewMaterials[i].map;
                if (map) {
                    map.magFilter = THREE.NearestFilter;
                    map.minFilter = THREE.NearestMipmapNearestFilter;
                    map.generateMipmaps = true;
                    map.needsUpdate = true;
                }
            }

            sharedLight.position.set(10, 10, 10);
            sharedLight.intensity = 0.8;
            sharedCamera.position.set(2, 2, 2);
            sharedCamera.lookAt(0, 0, 0);
            sharedCamera.updateProjectionMatrix();

            sharedScene.add(mesh);

            const rot = previewOptions.rotation || { x: 0, y: 0, z: 0 };
            mesh.rotation.set(
                THREE.MathUtils.degToRad(rot.x),
                THREE.MathUtils.degToRad(rot.y),
                THREE.MathUtils.degToRad(rot.z)
            );

            mesh.scale.setScalar(previewOptions.scale || 1);
            if (geometryType === "stairs") {
                mesh.scale.x *= -1;
            }

            mesh.position.set(0, 0, 0);
            mesh.updateMatrixWorld(true);
            _previewBox.setFromObject(mesh);
            _previewBox.getCenter(_previewCenter);
            mesh.position.sub(_previewCenter);

            if (previewOptions.offset) {
                mesh.position.x += previewOptions.offset.x || 0;
                mesh.position.y += previewOptions.offset.y || 0;
                mesh.position.z += previewOptions.offset.z || 0;
            }

            sharedRenderer.render(sharedScene, sharedCamera);

            const cacheCanvas = createCanvas(size);
            cacheCanvas.getContext("2d").drawImage(shared3DCanvas, 0, 0, size, size);
            previewCache.set(hashKey, cacheCanvas);

            const resultCanvas = createCanvas(size);
            resultCanvas.getContext("2d").drawImage(cacheCanvas, 0, 0);
            return resultCanvas;
        } finally {
            sharedScene.remove(mesh);
            mesh.geometry = null;
            mesh.material = null;
            for (let i = 0; i < previewMaterials.length; i++) {
                previewMaterials[i].dispose();
            }
        }
    }

    // --- 専用 2D アイテムアイコンプレビュー ---
    async function createItemIconPreview(config, size) {
        const rawIcon = config.itemIcon;
        if (!rawIcon) return null;

        const iconCfg = (typeof rawIcon === "string") ? { texture: rawIcon } : rawIcon;
        if (!iconCfg || !iconCfg.texture) return null;

        const hashKey = getPreviewHash(config.id, size, 2);
        if (previewCache.has(hashKey)) {
            const cached = previewCache.get(hashKey);
            const clone = createCanvas(size);
            clone.getContext("2d").drawImage(cached, 0, 0);
            return clone;
        }

        try {
            const img = await loadImage(iconCfg.texture);
            const canvas = createCanvas(size);
            canvas.style.imageRendering = "pixelated";
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = false;

            const { x = 0, y = 0 } = iconCfg.offset || {};
            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(img, x, y, size, size);

            if (iconCfg.tint === true) {
                const pMeta = (config.previewState !== null && config.previewState !== undefined)
                    ? config.previewState
                    : (config.defaultState ?? 0);
                const variant = config._compiledVariants
                    ? config._compiledVariants[pMeta & (config.stateMask ?? 0xFFF)]
                    : null;
                const tintHex = (variant && variant.defaultColor !== undefined)
                    ? variant.defaultColor
                    : (config.defaultColor ?? 0xffffff);

                if (tintHex !== 0xffffff) {
                    const tr = (tintHex >> 16) & 255;
                    const tg = (tintHex >> 8) & 255;
                    const tb = tintHex & 255;
                    const imgData = ctx.getImageData(0, 0, size, size);
                    const d = imgData.data;
                    for (let p = 0; p < d.length; p += 4) {
                        if (d[p + 3] === 0) continue;
                        d[p] = (d[p] * tr) / 255;
                        d[p + 1] = (d[p + 1] * tg) / 255;
                        d[p + 2] = (d[p + 2] * tb) / 255;
                    }
                    ctx.putImageData(imgData, 0, 0);
                }
            }

            const cacheCanvas = createCanvas(size);
            cacheCanvas.getContext("2d").drawImage(canvas, 0, 0);
            previewCache.set(hashKey, cacheCanvas);
            return canvas;
        } catch (e) {
            console.warn(`[ItemIcon] 2Dアイテム画像未配置のため通常プレビューへフォールバック (${config.name}): ${iconCfg.texture}`);
            return null;
        }
    }

    async function createItemPreview(blockConfig, size) {
        const config = getBlockConfiguration(blockConfig.id);
        if (!config) return createCanvas(size);

        if (config.itemIcon) {
            const iconCanvas = await createItemIconPreview(config, size);
            if (iconCanvas) return iconCanvas;
        }
        return config.previewType === "2D"
            ? create2DPreview(config, size)
            : await create3DPreview(config, size);
    }

    const createInventoryItemPreview = (blockConfig) => createItemPreview(blockConfig, 40);
    const createHotbarItemPreview = (blockConfig) => createItemPreview(blockConfig, 64);

    // --- ツールチップ ---
    function updateTooltipPosition(clientX, clientY) {
        if (!tooltipEl) return;
        const gap = 12;
        let x = clientX + gap;
        let y = clientY + gap;

        const tooltipWidth = tooltipEl.offsetWidth;
        if (x + tooltipWidth > window.innerWidth) {
            x = clientX - tooltipWidth - gap;
        }

        tooltipEl.style.left = x + "px";
        tooltipEl.style.top = y + "px";
    }

    function updateTooltipInstant() {
        if (!tooltipEl || !isOpen) return;

        const targetEl = document.elementFromPoint(lastMouseX, lastMouseY);
        const itemEl = targetEl?.closest(".inventory-item");

        if (itemEl) {
            const blockId = itemEl.dataset.blocktype;
            const cfg = getBlockConfiguration(blockId);
            tooltipEl.textContent = cfg?.name || "Unknown";
            tooltipEl.style.display = "block";
            updateTooltipPosition(lastMouseX, lastMouseY);
        } else {
            tooltipEl.style.display = "none";
        }
    }

    function attachTooltip(element, blockId) {
        element.addEventListener("mouseenter", () => {
            if (!tooltipEl) return;
            const cfg = getBlockConfiguration(blockId);
            tooltipEl.textContent = cfg?.name || "Unknown";
            tooltipEl.style.display = "block";
        });

        element.addEventListener("mouseleave", () => {
            if (!tooltipEl) return;
            tooltipEl.style.display = "none";
        });
    }

    function ensureTooltip() {
        if (tooltipEl) return;
        tooltipEl = document.createElement("div");
        tooltipEl.style.position = "fixed";
        tooltipEl.style.pointerEvents = "none";
        tooltipEl.style.padding = "4px 8px";
        tooltipEl.style.background = "rgba(0,0,0,0.85)";
        tooltipEl.style.color = "#fff";
        tooltipEl.style.fontSize = "12px";
        tooltipEl.style.borderRadius = "4px";
        tooltipEl.style.whiteSpace = "nowrap";
        tooltipEl.style.zIndex = "9999";
        tooltipEl.style.display = "none";
        tooltipEl.style.border = "1px solid #555";
        document.body.appendChild(tooltipEl);

        document.addEventListener("mousemove", (e) => {
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            if (!tooltipEl || tooltipEl.style.display === "none") return;
            updateTooltipPosition(e.clientX, e.clientY);
        });
    }

    // --- ホットバー＆インベントリ DOM 初期化 ---
    const inventoryContainer = document.getElementById("inventory-container");
    if (inventoryContainer) inventoryContainer.style.display = "none";

    const hotbarEl = document.getElementById("hotbar");
    const hotbarSlotEls = new Array(9);
    if (hotbarEl) {
        hotbarEl.innerHTML = "";
        for (let i = 0; i < 9; i++) {
            const item = document.createElement("div");
            item.className = "hotbar-item";
            if (i === 0) item.classList.add("active");
            item.dataset.blocktype = "";
            item.dataset.slotIndex = String(i);
            hotbarEl.appendChild(item);
            hotbarSlotEls[i] = item;
        }

        hotbarEl.addEventListener("click", (e) => {
            const slotEl = e.target.closest(".hotbar-item");
            if (!slotEl) return;
            const idx = Number(slotEl.dataset.slotIndex);
            if (Number.isInteger(idx) && idx >= 0 && idx < 9) {
                selectSlot(idx);
            }
        });
    }

    function notifyActiveBlockChanged() {
        if (typeof onActiveBlockChanged === "function") {
            onActiveBlockChanged(activeBlockType, selectedHotbarIndex);
        }
    }

    function updateHotbarSelection() {
        for (let i = 0; i < 9; i++) {
            const el = hotbarSlotEls[i];
            if (!el) continue;
            if (i === selectedHotbarIndex) {
                el.classList.add("active");
                activeBlockType = Number(el.dataset.blocktype || 0);
            } else {
                el.classList.remove("active");
            }
        }
        notifyActiveBlockChanged();
    }

    function selectSlot(index) {
        selectedHotbarIndex = Math.max(0, Math.min(8, index | 0));
        updateHotbarSelection();
    }

    function stepSlot(delta) {
        selectedHotbarIndex = (((selectedHotbarIndex + (delta | 0)) % 9) + 9) % 9;
        updateHotbarSelection();
    }

    async function setHotbarSlotBlockId(slotIdx, blockId) {
        const slotEl = hotbarSlotEls[slotIdx];
        if (!slotEl) return;
        const cfg = getBlockConfiguration(blockId);
        if (!cfg) return;

        slotEl.innerHTML = "";
        slotEl.dataset.blocktype = String(blockId);

        const hotbarPreview = await createHotbarItemPreview(cfg);
        hotbarPreview.style.width = hotbarPreview.style.height = HOTBAR_ICON_SIZE_PX;
        slotEl.appendChild(hotbarPreview);

        if (slotIdx === selectedHotbarIndex) {
            activeBlockType = Number(blockId);
            notifyActiveBlockChanged();
        }
    }

    async function setHotbarSlotKey(slotIdx, key) {
        if (!key || slotIdx < 0 || slotIdx >= 9) return;
        const bid = keyToId(key);
        if (!bid || bid === BLOCK_TYPES.SKY) return;
        await setHotbarSlotBlockId(slotIdx, bid);
        updateHotbarSelection();
    }

    function getHotbarKeys() {
        const out = new Array(9).fill("");
        for (let i = 0; i < 9; i++) {
            const rawId = Number(hotbarSlotEls[i]?.dataset.blocktype || 0);
            out[i] = rawId > 0 ? idToKey(rawId & 0xFFF) : "";
        }
        return out;
    }

    function setActiveInventoryTab(tabId) {
        activeInventoryTab = tabId;

        const tabBtns = document.querySelectorAll("#inventory-tabs .inv-tab");
        for (let i = 0; i < tabBtns.length; i++) {
            tabBtns[i].classList.toggle("active", tabBtns[i].dataset.tab === tabId);
        }

        for (let i = 0; i < inventoryEntries.length; i++) {
            const entry = inventoryEntries[i];
            const visible = (tabId === "all") || entry.tabs.includes(tabId);
            entry.el.style.display = visible ? "" : "none";
        }

        const inventoryEl = document.getElementById("inventory");
        if (inventoryEl) inventoryEl.scrollTop = 0;
    }

    async function buildInventoryGrid() {
        const inventoryEl = document.getElementById("inventory");
        const tabsEl = document.getElementById("inventory-tabs");
        if (!inventoryEl) return;

        inventoryEl.innerHTML = "";
        inventoryEntries.length = 0;

        if (tabsEl) {
            tabsEl.innerHTML = "";
            for (let i = 0; i < INVENTORY_TABS.length; i++) {
                const tab = INVENTORY_TABS[i];
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "inv-tab" + (tab.id === activeInventoryTab ? " active" : "");
                btn.dataset.tab = tab.id;
                btn.setAttribute("role", "tab");
                btn.textContent = tab.label;
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    setActiveInventoryTab(tab.id);
                });
                tabsEl.appendChild(btn);
            }
        }

        const promises = Object.values(BLOCK_CONFIG).map(async (blockConfig) => {
            if (!blockConfig.itemdisplay) return null;
            const item = document.createElement("div");
            item.className = "inventory-item";
            const blockId = Number(blockConfig.id);
            item.dataset.blocktype = blockId;

            attachTooltip(item, blockId);

            const preview = await createInventoryItemPreview(blockConfig);
            preview.style.width = preview.style.height = INVENTORY_ICON_SIZE_PX;
            item.appendChild(preview);

            item.addEventListener("click", async (e) => {
                e.stopPropagation();
                for (let j = 0; j < inventoryEntries.length; j++) {
                    inventoryEntries[j].el.classList.remove("active");
                }
                item.classList.add("active");
                await setHotbarSlotBlockId(selectedHotbarIndex, blockId);
            });

            return { el: item, tabs: resolveBlockCreativeTabs(blockConfig) };
        });

        const entries = (await Promise.all(promises)).filter(Boolean);
        for (let i = 0; i < entries.length; i++) {
            inventoryEntries.push(entries[i]);
            inventoryEl.appendChild(entries[i].el);
        }

        setActiveInventoryTab(activeInventoryTab);
    }

    async function init() {
        ensureTooltip();
        await buildInventoryGrid();
    }

    function open() {
        if (isOpen) return;
        isOpen = true;
        if (inventoryContainer) inventoryContainer.style.display = "block";
        if (typeof onOpenChanged === "function") onOpenChanged(true);
        setTimeout(() => updateTooltipInstant(), 10);
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        if (inventoryContainer) inventoryContainer.style.display = "none";
        if (tooltipEl) tooltipEl.style.display = "none";
        if (typeof onOpenChanged === "function") onOpenChanged(false);
    }

    function exportHotbarState() {
        return {
            hotbarKeys: getHotbarKeys(),
            selectedHotbarIndex
        };
    }

    async function restoreHotbarState(savedPlayerState) {
        const hotbarKeys = Array.isArray(savedPlayerState?.hotbarKeys) ? savedPlayerState.hotbarKeys : [];

        for (let i = 0; i < 9; i++) {
            const slot = hotbarSlotEls[i];
            if (!slot) continue;
            slot.innerHTML = "";
            slot.dataset.blocktype = "";
            slot.classList.remove("active");

            const key = hotbarKeys[i];
            if (!key || typeof key !== "string") continue;

            const blockId = keyToId(key);
            if (!blockId || blockId === BLOCK_TYPES.SKY) continue;

            const cfg = getBlockConfiguration(blockId);
            if (!cfg || cfg.itemdisplay === false) continue;

            slot.dataset.blocktype = String(blockId);
            const preview = await createHotbarItemPreview(cfg);
            preview.style.width = preview.style.height = HOTBAR_ICON_SIZE_PX;
            slot.appendChild(preview);
        }

        const rawSlot = Number(savedPlayerState?.selectedHotbarIndex);
        selectedHotbarIndex = Number.isInteger(rawSlot) ? Math.max(0, Math.min(8, rawSlot)) : 0;
        updateHotbarSelection();

        // インベントリ側の選択ハイライトもホットバーと同期
        for (let i = 0; i < inventoryEntries.length; i++) {
            const el = inventoryEntries[i].el;
            el.classList.toggle("active", activeBlockType > 0 && Number(el.dataset.blocktype) === activeBlockType);
        }
    }

    return {
        get isOpen() { return isOpen; },
        get activeBlockType() { return activeBlockType; },
        get selectedHotbarIndex() { return selectedHotbarIndex; },
        init,
        open,
        close,
        containsTarget: (target) => !!(inventoryContainer && inventoryContainer.contains(target)),
        selectSlot,
        stepSlot,
        getHotbarKeys,
        setHotbarSlotKey,
        exportHotbarState,
        restoreHotbarState,
        createInventoryItemPreview,
        createHotbarItemPreview
    };
}