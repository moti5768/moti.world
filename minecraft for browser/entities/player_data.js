"use strict";

/* ======================================================
   【プレイヤーデータモデル】(entities/player_data.js)
   - Minecraft Java Edition playerdata (NBT) 準拠のフィールド構造
   - 既存 script.js の player.position / velocity / hotbar と双方向同期
   ====================================================== */

export const GAME_MODES = Object.freeze({
    SURVIVAL: 0,
    CREATIVE: 1,
    ADVENTURE: 2,
    SPECTATOR: 3
});

export function createPlayerData() {
    const data = {
        uuid: generateUuidV4(),
        name: "Player",
        dimension: "minecraft:overworld",
        gameMode: GAME_MODES.CREATIVE,

        // バイタル・経験値（サバイバル拡張用）
        health: 20.0,
        maxHealth: 20.0,
        foodLevel: 20,
        foodSaturationLevel: 5.0,
        air: 300,
        maxAir: 300,
        xpLevel: 0,
        xpProgress: 0.0,
        xpTotal: 0,
        score: 0,
        fireTicks: 0,
        fallDistance: 0.0,

        // 位置・視点・能力（Java Edition NBT: Pos / Motion / Rotation / abilities 準拠）
        pos: [0, 64, 0],
        motion: [0, 0, 0],
        rotation: [0, 0],
        onGround: false,
        abilities: {
            mayfly: true,
            flying: false,
            instabuild: true,
            invulnerable: true,
            flySpeed: 0.05,
            walkSpeed: 0.1
        },

        // インベントリ（ホットバー 0..8 + メイン 9..35 = 計36スロット）
        selectedItemSlot: 0,
        inventory: new Array(36).fill(null)
    };

    function reset() {
        data.dimension = "minecraft:overworld";
        data.gameMode = GAME_MODES.CREATIVE;
        data.health = 20.0;
        data.maxHealth = 20.0;
        data.foodLevel = 20;
        data.foodSaturationLevel = 5.0;
        data.air = 300;
        data.xpLevel = 0;
        data.xpProgress = 0.0;
        data.xpTotal = 0;
        data.score = 0;
        data.fireTicks = 0;
        data.fallDistance = 0.0;
        data.pos = [0, 64, 0];
        data.motion = [0, 0, 0];
        data.rotation = [0, 0];
        data.onGround = false;
        data.abilities.flying = false;
        data.selectedItemSlot = 0;
        data.inventory.fill(null);
    }

    /**
     * script.js のランタイム状態から PlayerData を最新化（セーブ直前・定期同期用）
     */
    function syncFromRuntime(runtime) {
        if (!runtime) return;
        if (runtime.position) {
            data.pos[0] = runtime.position.x;
            data.pos[1] = runtime.position.y;
            data.pos[2] = runtime.position.z;
        }
        if (runtime.velocity) {
            data.motion[0] = runtime.velocity.x;
            data.motion[1] = runtime.velocity.y;
            data.motion[2] = runtime.velocity.z;
        }
        if (Number.isFinite(runtime.yaw)) data.rotation[0] = runtime.yaw;
        if (Number.isFinite(runtime.pitch)) data.rotation[1] = runtime.pitch;
        if (typeof runtime.onGround === "boolean") data.onGround = runtime.onGround;
        if (typeof runtime.flightMode === "boolean") data.abilities.flying = runtime.flightMode;
        if (Number.isInteger(runtime.selectedHotbarIndex)) {
            data.selectedItemSlot = Math.max(0, Math.min(8, runtime.selectedHotbarIndex));
        }
        if (Array.isArray(runtime.hotbarKeys)) {
            for (let i = 0; i < 9; i++) {
                const key = runtime.hotbarKeys[i];
                data.inventory[i] = key ? { id: `minecraft:${key.toLowerCase()}`, key, count: 64 } : null;
            }
        }
    }

    /**
     * IndexedDB 保存用のシリアライズデータ (Java Edition playerdata NBT 風 JSON)
     */
    function exportNBT() {
        const compactInv = [];
        for (let slot = 0; slot < data.inventory.length; slot++) {
            const item = data.inventory[slot];
            if (item && item.key && item.count > 0) {
                compactInv.push({ Slot: slot, id: item.id, key: item.key, Count: item.count });
            }
        }
        return {
            DataVersion: 1,
            UUID: data.uuid,
            Name: data.name,
            Dimension: data.dimension,
            playerGameType: data.gameMode,
            Health: data.health,
            MaxHealth: data.maxHealth,
            foodLevel: data.foodLevel,
            foodSaturationLevel: data.foodSaturationLevel,
            Air: data.air,
            XpLevel: data.xpLevel,
            XpP: data.xpProgress,
            XpTotal: data.xpTotal,
            Score: data.score,
            Pos: [...data.pos],
            Motion: [...data.motion],
            Rotation: [...data.rotation],
            OnGround: data.onGround,
            abilities: { ...data.abilities },
            SelectedItemSlot: data.selectedItemSlot,
            Inventory: compactInv
        };
    }

    /**
     * IndexedDB から読み込んだ NBT 風データを復元
     */
    function importNBT(nbt) {
        reset();
        if (!nbt || typeof nbt !== "object") return;
        if (typeof nbt.UUID === "string") data.uuid = nbt.UUID;
        if (typeof nbt.Name === "string") data.name = nbt.Name;
        if (typeof nbt.Dimension === "string") data.dimension = nbt.Dimension;
        if (Number.isInteger(nbt.playerGameType)) data.gameMode = nbt.playerGameType;
        if (Number.isFinite(nbt.Health)) data.health = nbt.Health;
        if (Number.isFinite(nbt.MaxHealth)) data.maxHealth = nbt.MaxHealth;
        if (Number.isFinite(nbt.foodLevel)) data.foodLevel = nbt.foodLevel;
        if (Number.isFinite(nbt.foodSaturationLevel)) data.foodSaturationLevel = nbt.foodSaturationLevel;
        if (Number.isFinite(nbt.Air)) data.air = nbt.Air;
        if (Number.isFinite(nbt.XpLevel)) data.xpLevel = nbt.XpLevel;
        if (Number.isFinite(nbt.XpP)) data.xpProgress = nbt.XpP;
        if (Number.isFinite(nbt.XpTotal)) data.xpTotal = nbt.XpTotal;
        if (Number.isFinite(nbt.Score)) data.score = nbt.Score;
        if (Array.isArray(nbt.Pos) && nbt.Pos.length === 3) data.pos = [...nbt.Pos];
        if (Array.isArray(nbt.Motion) && nbt.Motion.length === 3) data.motion = [...nbt.Motion];
        if (Array.isArray(nbt.Rotation) && nbt.Rotation.length === 2) data.rotation = [...nbt.Rotation];
        if (typeof nbt.OnGround === "boolean") data.onGround = nbt.OnGround;
        if (nbt.abilities && typeof nbt.abilities === "object") {
            Object.assign(data.abilities, nbt.abilities);
        }
        if (Number.isInteger(nbt.SelectedItemSlot)) {
            data.selectedItemSlot = Math.max(0, Math.min(8, nbt.SelectedItemSlot));
        }
        if (Array.isArray(nbt.Inventory)) {
            for (let i = 0; i < nbt.Inventory.length; i++) {
                const it = nbt.Inventory[i];
                if (!it || !Number.isInteger(it.Slot)) continue;
                if (it.Slot >= 0 && it.Slot < data.inventory.length && it.key) {
                    data.inventory[it.Slot] = {
                        id: it.id || `minecraft:${String(it.key).toLowerCase()}`,
                        key: String(it.key),
                        count: it.Count | 0
                    };
                }
            }
        }
    }

    return {
        data,
        reset,
        syncFromRuntime,
        exportNBT,
        importNBT,
        setGameMode(mode) {
            data.gameMode = mode;
            data.abilities.mayfly = (mode === GAME_MODES.CREATIVE || mode === GAME_MODES.SPECTATOR);
            data.abilities.instabuild = (mode === GAME_MODES.CREATIVE);
            data.abilities.invulnerable = (mode === GAME_MODES.CREATIVE || mode === GAME_MODES.SPECTATOR);
        }
    };
}

function generateUuidV4() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : ((r & 3) | 8)).toString(16);
    });
}