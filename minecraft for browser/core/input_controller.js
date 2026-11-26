"use strict";

/* ======================================================
   【入力・ポーズ・設定・チャット統合コントローラ】(core/input_controller.js)
   - キーボード (e.code ベース) / マウス / ホイール / ポインターロック
   - モバイル マルチタッチUI (移動・視点・タップ設置・長押し破壊)
   - ポーズメニュー・設定メニュー (描画距離・明るさ)・チャットログ
   ====================================================== */

const INTERACT_SPEED = 150;
const TAP_THRESHOLD = 300;
const TOUCH_SENSITIVITY = 0.005;
const MOUSE_SENSITIVITY = 0.002;
const MAX_CHAT_LOGS = 50;

const CODE_TO_LOGICAL_KEY = {
    KeyW: "w",
    KeyA: "a",
    KeyS: "s",
    KeyD: "d",
    ArrowUp: "arrowup",
    ArrowDown: "arrowdown",
    ArrowLeft: "arrowleft",
    ArrowRight: "arrowright",
    Space: " ",
    ShiftLeft: "shift",
    ShiftRight: "shift"
};

const CODE_TO_HOTBAR_SLOT = {
    Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4,
    Digit6: 5, Digit7: 6, Digit8: 7, Digit9: 8,
    Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3, Numpad5: 4,
    Numpad6: 5, Numpad7: 6, Numpad8: 7, Numpad9: 8
};

// --- チャットログシステム ---
const chatContainer = document.getElementById("chat-container");

export function addChatMessage(text, color = "#ffffff", duration = 6000) {
    if (!chatContainer) return;

    while (chatContainer.children.length >= MAX_CHAT_LOGS) {
        chatContainer.removeChild(chatContainer.firstChild);
    }

    const messageEl = document.createElement("div");
    messageEl.className = "chat-message";
    messageEl.innerText = text;
    messageEl.style.color = color;

    chatContainer.appendChild(messageEl);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    setTimeout(() => {
        messageEl.style.opacity = "0";
        setTimeout(() => {
            if (messageEl.parentNode === chatContainer) {
                chatContainer.removeChild(messageEl);
            }
        }, 1000);
    }, duration);
}

window.addChatMessage = addChatMessage;

export function createInputController(deps) {
    const {
        keys,
        getRenderer,
        getInventoryUI,
        getContainerUI,
        getIsPaused,
        setIsPaused,
        getIsInventoryOpen,
        getIsContainerOpen,
        getCanFly,
        getFlightMode,
        setFlightMode,
        setDashActive,
        setSneakActive,
        setJumpRequest,
        addLookDelta,
        onInteractBlock,
        onResumeClock,
        onResetAccumulators,
        onToggleChunkBorders,
        onSpawnDebugMob,
        onClearMobs,
        onToggleGameMode,
        onApplyRenderDistance,
        onApplyBrightness
    } = deps;

    const pauseMenu = document.getElementById("pause-menu");
    const mainMenu = document.getElementById("main-menu");
    const settingsMenu = document.getElementById("settings-menu");
    const btnOpenSettings = document.getElementById("btn-open-settings");
    const btnOpenSettingsPause = document.getElementById("btn-open-settings-pause");
    const btnSettingsBack = document.getElementById("btn-settings-back");
    const btnSettingsReset = document.getElementById("btn-settings-reset");
    const rangeRenderDist = document.getElementById("range-render-dist");
    const renderDistValLabel = document.getElementById("renderDistVal");
    const brightnessSlider = document.getElementById("brightnessSlider");
    const brightnessValLabel = document.getElementById("brightnessVal");

    let f3Pressed = false;
    let pointerLocked = false;
    let lastSpaceTime = 0;
    let lastWPressTime = 0;
    let isOpenedFromPause = false;
    let renderDistanceTimeout = null;
    let touchInitialized = false;

    const interactIntervalIds = { left: null, right: null, touch: null };

    // モバイルUI表示判定
    const leftControls = document.getElementById("left-controls");
    const rightControls = document.getElementById("right-controls");
    const ua = navigator.userAgent.toLowerCase();
    const isTouchDevice = ua.includes("mobile") || ua.indexOf("ipad") > -1 || (ua.indexOf("macintosh") > -1 && "ontouchend" in document);
    if (leftControls) leftControls.style.display = isTouchDevice ? "block" : "none";
    if (rightControls) rightControls.style.display = isTouchDevice ? "block" : "none";

    function isMainMenuHidden() {
        return !!(mainMenu && mainMenu.style.display === "none");
    }

    function isGameplayInputActive() {
        return !!getRenderer() && !getIsPaused() && !getIsInventoryOpen() && !getIsContainerOpen() && isMainMenuHidden();
    }

    function stopInteraction(key = "default") {
        if (interactIntervalIds[key] != null) {
            clearInterval(interactIntervalIds[key]);
            interactIntervalIds[key] = null;
        }
    }

    function startInteraction(action, key = "default") {
        if (!isGameplayInputActive()) return;
        if (interactIntervalIds[key] != null) {
            clearInterval(interactIntervalIds[key]);
        }
        onInteractBlock(action);
        interactIntervalIds[key] = setInterval(() => {
            if (!isGameplayInputActive()) {
                stopInteraction(key);
                return;
            }
            onInteractBlock(action);
        }, INTERACT_SPEED);
    }

    function releaseAllActiveInputs() {
        for (const k in keys) {
            keys[k] = false;
        }
        setDashActive(false);
        setSneakActive(false);
        setJumpRequest(false);
        f3Pressed = false;
        stopInteraction("left");
        stopInteraction("right");
        stopInteraction("touch");
    }

    function updatePauseUI() {
        if (getIsPaused()) {
            releaseAllActiveInputs();
            if (pauseMenu) pauseMenu.style.display = "flex";
        } else {
            if (typeof onResumeClock === "function") onResumeClock();
            if (pauseMenu) pauseMenu.style.display = "none";
        }
    }

    function onCanvasMouseDown(event) {
        const renderer = getRenderer();
        if (!renderer || !isGameplayInputActive() || document.pointerLockElement !== renderer.domElement) return;

        if (event.button === 0) startInteraction("destroy", "left");
        else if (event.button === 2) startInteraction("place", "right");
    }

    // --- タブ切り替え・フォーカス喪失保護 ---
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            releaseAllActiveInputs();
            if (typeof onResetAccumulators === "function") onResetAccumulators();
            if (getRenderer() && isMainMenuHidden() && !getIsPaused()) {
                setIsPaused(true);
                updatePauseUI();
            }
        } else if (typeof onResumeClock === "function") {
            onResumeClock();
        }
    });

    window.addEventListener("blur", () => {
        releaseAllActiveInputs();
    });

    // --- キーボード入力 ---
    window.addEventListener("keydown", (e) => {
        const renderer = getRenderer();
        if (!renderer) return;
        const code = e.code;

        if (code === "F3") {
            e.preventDefault();
            f3Pressed = true;
            return;
        }
        if (f3Pressed && code === "KeyG") {
            e.preventDefault();
            if (typeof onToggleChunkBorders === "function") onToggleChunkBorders();
            return;
        }
        if (f3Pressed && code === "KeyM") {
            e.preventDefault();
            if (typeof onSpawnDebugMob === "function") onSpawnDebugMob();
            return;
        }
        if (f3Pressed && code === "KeyK") {
            e.preventDefault();
            if (typeof onClearMobs === "function") onClearMobs();
            return;
        }
        if (f3Pressed && code === "KeyN") {
            e.preventDefault();
            if (typeof onToggleGameMode === "function") onToggleGameMode();
            return;
        }

        // Eキー (コンテナ閉じ / インベントリ開閉)
        if (code === "KeyE") {
            if (getIsPaused() || !isMainMenuHidden()) return;
            e.preventDefault();
            e.stopImmediatePropagation();

            if (getIsContainerOpen()) {
                getContainerUI().close();
                return;
            }
            const invUI = getInventoryUI();
            if (getIsInventoryOpen()) {
                invUI.close();
                if (!getIsPaused() && renderer.domElement.requestPointerLock) {
                    renderer.domElement.requestPointerLock();
                }
            } else {
                invUI.open();
            }
            return;
        }

        // ESCキー (コンテナ閉じ / インベントリ閉じ / ポーズ遷移)
        if (code === "Escape") {
            if (getIsContainerOpen()) {
                getContainerUI().close();
                return;
            }
            if (getIsInventoryOpen()) {
                getInventoryUI().close();
                return;
            }
            if (isMainMenuHidden() && !getIsPaused()) {
                if (document.pointerLockElement === renderer.domElement && document.exitPointerLock) {
                    document.exitPointerLock();
                } else {
                    setIsPaused(true);
                    updatePauseUI();
                }
            }
            return;
        }

        if (!isGameplayInputActive()) return;

        if (CODE_TO_HOTBAR_SLOT[code] !== undefined) {
            getInventoryUI().selectSlot(CODE_TO_HOTBAR_SLOT[code]);
            return;
        }

        if (code === "Space") {
            e.preventDefault();
            if (e.repeat) return;
            const now = performance.now();
            if (getCanFly() && now - lastSpaceTime < TAP_THRESHOLD) {
                setFlightMode(!getFlightMode());
                setJumpRequest(false);
            }
            lastSpaceTime = now;
            keys[" "] = true;
            return;
        }

        if (code === "KeyW" && !e.repeat) {
            const now = performance.now();
            if (now - lastWPressTime < TAP_THRESHOLD) setDashActive(true);
            lastWPressTime = now;
        }

        if (code === "ShiftLeft" || code === "ShiftRight") {
            setSneakActive(true);
            if (!getFlightMode()) setDashActive(false);
        }

        const logical = CODE_TO_LOGICAL_KEY[code];
        if (logical) keys[logical] = true;
    });

    document.addEventListener("keyup", (e) => {
        const code = e.code;
        if (code === "F3") f3Pressed = false;
        if (code === "KeyW") setDashActive(false);
        if (code === "ShiftLeft" || code === "ShiftRight") setSneakActive(false);

        const logical = CODE_TO_LOGICAL_KEY[code];
        if (logical) keys[logical] = false;
    });

    // --- マウス・ホイール・ポインターロック ---
    window.addEventListener("wheel", (e) => {
        if (e.deltaY === 0) return;
        const isOverInvGrid = !!(e.target && e.target.closest && e.target.closest("#inventory"));
        const canScrollHotbar = isGameplayInputActive() || (
            getIsInventoryOpen() && !getIsPaused() && !getIsContainerOpen() && !isOverInvGrid
        );
        if (!canScrollHotbar) return;
        getInventoryUI().stepSlot(e.deltaY > 0 ? 1 : -1);
    }, { passive: true });

    document.addEventListener("mouseup", (event) => {
        if (event.button === 0) stopInteraction("left");
        else if (event.button === 2) stopInteraction("right");
    }, false);

    window.addEventListener("mousemove", (e) => {
        if (!pointerLocked || !isGameplayInputActive()) return;
        addLookDelta(-e.movementX * MOUSE_SENSITIVITY, -e.movementY * MOUSE_SENSITIVITY);
    });

    document.addEventListener("pointerlockchange", () => {
        const renderer = getRenderer();
        pointerLocked = !!(renderer && document.pointerLockElement === renderer.domElement);

        if (pointerLocked) {
            setIsPaused(false);
            updatePauseUI();
        } else if (!getIsInventoryOpen() && !getIsContainerOpen() && isMainMenuHidden()) {
            setIsPaused(true);
            updatePauseUI();
        }
    });

    const btnResume = document.getElementById("btn-resume");
    if (btnResume) {
        btnResume.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();

            btnResume.blur();
            setIsPaused(false);
            updatePauseUI();

            await new Promise((resolve) => setTimeout(resolve, 100));

            const renderer = getRenderer();
            if (!getIsPaused() && !getIsInventoryOpen() && !getIsContainerOpen() && renderer && renderer.domElement) {
                renderer.domElement.requestPointerLock();
            }
        });
    }

    const btnQuit = document.getElementById("btn-quit");
    if (btnQuit) {
        btnQuit.addEventListener("click", () => {
            window.close();
            setTimeout(() => {
                if (!window.closed) {
                    alert("ブラウザのセキュリティ制限により自動で閉じられませんでした。タブを直接閉じてください。");
                }
            }, 500);
        });
    }

    // --- 設定メニュー制御 ---
    function toggleSettingsMenu(showSettings, fromPause = false) {
        if (!settingsMenu) return;
        settingsMenu.style.display = showSettings ? "flex" : "none";
        if (showSettings) {
            if (mainMenu) mainMenu.style.display = "none";
            if (pauseMenu) pauseMenu.style.display = "none";
            isOpenedFromPause = fromPause;
        } else if (isOpenedFromPause) {
            if (pauseMenu) pauseMenu.style.display = "flex";
        } else if (mainMenu) {
            mainMenu.style.display = "flex";
        }
    }

    if (btnOpenSettings) btnOpenSettings.addEventListener("click", () => toggleSettingsMenu(true, false));
    if (btnOpenSettingsPause) btnOpenSettingsPause.addEventListener("click", () => toggleSettingsMenu(true, true));
    if (btnSettingsBack) btnSettingsBack.addEventListener("click", () => toggleSettingsMenu(false));

    if (rangeRenderDist) {
        rangeRenderDist.addEventListener("input", (e) => {
            const val = parseInt(e.target.value, 10);
            if (renderDistValLabel) renderDistValLabel.innerText = val;
            clearTimeout(renderDistanceTimeout);
            renderDistanceTimeout = setTimeout(() => {
                if (typeof onApplyRenderDistance === "function") onApplyRenderDistance(val);
            }, 300);
        });
    }

    if (brightnessSlider) {
        brightnessSlider.addEventListener("input", () => {
            const val = parseInt(brightnessSlider.value, 10);
            if (brightnessValLabel) brightnessValLabel.innerText = val;
            if (typeof onApplyBrightness === "function") onApplyBrightness(val);
        });
    }

    if (btnSettingsReset) {
        btnSettingsReset.addEventListener("click", () => {
            if (rangeRenderDist) {
                rangeRenderDist.value = 6;
                if (typeof onApplyRenderDistance === "function") onApplyRenderDistance(6);
            }
            if (brightnessSlider) {
                brightnessSlider.value = 50;
                if (typeof onApplyBrightness === "function") onApplyBrightness(50);
            }
        });
    }

    // --- モバイル・タッチUI統合管理 ---
    function bindCanvasTouchControls() {
        if (touchInitialized) return;
        const renderer = getRenderer();
        if (!renderer || !renderer.domElement) return;
        touchInitialized = true;

        const canvas = renderer.domElement;
        let lastForwardTapTime = 0;
        let lastJumpTime = 0;
        let lastSneakTime = 0;
        let sneakToggled = false;

        let lookTouchId = null;
        let lastTouchX = 0, lastTouchY = 0;
        let touchStartTime = 0;
        let isLongPress = false;
        let hasMovedSinceTouchStart = false;
        let longPressTimer = null;

        const resetLookTouchState = () => {
            lookTouchId = null;
            isLongPress = false;
            hasMovedSinceTouchStart = false;
            if (longPressTimer !== null) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            stopInteraction("touch");
        };

        const bindButton = (id, key, onStart, onEnd) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            const start = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (!isGameplayInputActive()) return;
                if (onStart) onStart();
                keys[key] = true;
            };
            const end = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (onEnd) onEnd();
                keys[key] = false;
            };
            btn.addEventListener("touchstart", start, { passive: false });
            btn.addEventListener("touchend", end, { passive: false });
            btn.addEventListener("touchcancel", end, { passive: false });
            btn.addEventListener("mousedown", start);
            btn.addEventListener("mouseup", end);
        };

        bindButton("dpad-up", "w", () => {
            const now = performance.now();
            if (now - lastForwardTapTime < TAP_THRESHOLD) setDashActive(true);
            lastForwardTapTime = now;
        }, () => setDashActive(false));
        bindButton("dpad-down", "s");
        bindButton("dpad-left", "a");
        bindButton("dpad-right", "d");

        const btnJump = document.getElementById("btn-jump");
        if (btnJump) {
            const onJumpStart = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (!isGameplayInputActive()) return;
                const now = performance.now();
                if (getCanFly() && now - lastJumpTime < TAP_THRESHOLD) {
                    setFlightMode(!getFlightMode());
                    setJumpRequest(false);
                } else if (getFlightMode()) {
                    keys[" "] = true;
                } else {
                    setJumpRequest(true);
                }
                lastJumpTime = now;
            };
            const onJumpEnd = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (getFlightMode()) keys[" "] = false;
            };
            btnJump.addEventListener("touchstart", onJumpStart, { passive: false });
            btnJump.addEventListener("touchend", onJumpEnd, { passive: false });
            btnJump.addEventListener("touchcancel", onJumpEnd, { passive: false });
        }

        const btnSneak = document.getElementById("btn-sneak");
        if (btnSneak) {
            const onSneakStart = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (!isGameplayInputActive()) return;
                const now = performance.now();
                if (now - lastSneakTime < TAP_THRESHOLD) {
                    sneakToggled = !sneakToggled;
                    keys["shift"] = sneakToggled;
                    setSneakActive(sneakToggled);
                } else {
                    keys["shift"] = true;
                    setSneakActive(true);
                }
                lastSneakTime = now;
            };
            const onSneakEnd = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (!sneakToggled) {
                    keys["shift"] = false;
                    setSneakActive(false);
                }
            };
            btnSneak.addEventListener("touchstart", onSneakStart, { passive: false });
            btnSneak.addEventListener("touchend", onSneakEnd, { passive: false });
            btnSneak.addEventListener("touchcancel", onSneakEnd, { passive: false });
        }

        const btnInvOpen = document.getElementById("btn-inventory");
        if (btnInvOpen) {
            const openInv = (e) => {
                e.preventDefault(); e.stopPropagation();
                if (getIsPaused() || !isMainMenuHidden()) return;
                resetLookTouchState();
                getInventoryUI().open();
            };
            btnInvOpen.addEventListener("touchstart", openInv, { passive: false });
            btnInvOpen.addEventListener("mousedown", openInv);
        }

        const btnInvClose = document.getElementById("btn-inventory-close");
        if (btnInvClose) {
            const closeInv = (e) => {
                e.preventDefault(); e.stopPropagation();
                getInventoryUI().close();
            };
            btnInvClose.addEventListener("touchstart", closeInv, { passive: false });
            btnInvClose.addEventListener("mousedown", closeInv);
        }

        const btnPause = document.getElementById("btn-pause");
        if (btnPause) {
            const togglePause = (e) => {
                if (getIsInventoryOpen() || !isMainMenuHidden()) return;
                e.preventDefault(); e.stopPropagation();
                const next = !getIsPaused();
                setIsPaused(next);
                updatePauseUI();
                if (next) {
                    resetLookTouchState();
                    if (document.pointerLockElement && document.exitPointerLock) {
                        document.exitPointerLock();
                    }
                }
            };
            btnPause.addEventListener("touchstart", togglePause, { passive: false });
            btnPause.addEventListener("mousedown", togglePause);
        }

        canvas.addEventListener("touchstart", (e) => {
            if (!isGameplayInputActive()) return;
            for (let i = 0; i < e.changedTouches.length; i++) {
                const touch = e.changedTouches[i];
                if (lookTouchId === null) {
                    lookTouchId = touch.identifier;
                    lastTouchX = touch.clientX;
                    lastTouchY = touch.clientY;
                    touchStartTime = performance.now();
                    isLongPress = false;
                    hasMovedSinceTouchStart = false;
                    longPressTimer = setTimeout(() => {
                        isLongPress = true;
                        startInteraction("destroy", "touch");
                    }, 450);
                    break;
                }
            }
        }, { passive: false });

        canvas.addEventListener("touchmove", (e) => {
            if (!isGameplayInputActive()) return;
            for (let i = 0; i < e.changedTouches.length; i++) {
                const touch = e.changedTouches[i];
                if (touch.identifier === lookTouchId) {
                    const dx = touch.clientX - lastTouchX;
                    const dy = touch.clientY - lastTouchY;
                    addLookDelta(-dx * TOUCH_SENSITIVITY, -dy * TOUCH_SENSITIVITY);
                    lastTouchX = touch.clientX;
                    lastTouchY = touch.clientY;
                    if (!hasMovedSinceTouchStart && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
                        hasMovedSinceTouchStart = true;
                        if (!isLongPress && longPressTimer !== null) {
                            clearTimeout(longPressTimer);
                            longPressTimer = null;
                        }
                    }
                    break;
                }
            }
        }, { passive: false });

        const handleTouchEndOrCancel = (e, isCancel) => {
            for (let i = 0; i < e.changedTouches.length; i++) {
                const touch = e.changedTouches[i];
                if (touch.identifier === lookTouchId) {
                    const wasLong = isLongPress;
                    const moved = hasMovedSinceTouchStart;
                    const duration = performance.now() - touchStartTime;
                    resetLookTouchState();
                    if (!isCancel && isGameplayInputActive() && !wasLong && !moved && duration < 300) {
                        onInteractBlock("place");
                    }
                    break;
                }
            }
        };

        canvas.addEventListener("touchend", (e) => handleTouchEndOrCancel(e, false), { passive: false });
        canvas.addEventListener("touchcancel", (e) => handleTouchEndOrCancel(e, true), { passive: false });
    }

    return {
        get pointerLocked() { return pointerLocked; },
        onCanvasMouseDown,
        bindCanvasTouchControls,
        stopInteraction,
        releaseAllActiveInputs,
        updatePauseUI
    };
}