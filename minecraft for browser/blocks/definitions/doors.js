"use strict";
import { getBlockStateProp, setBlockStateProp, packRawBlock } from '../../blockstate.js';
import { defineBlocks, registerPlacementRule } from '../registry.js';

// トラップドア専用の配置ルール（Java Edition TrapDoorBlock.getStateForPlacement 準拠）
// facing: 0=north, 1=east, 2=south, 3=west / half: 0=bottom, 1=top (bit2) / open: 0 (bit3)
registerPlacementRule("trapdoor", (cfg, camDir, rawNormal, intersectPoint) => {
    let facingIdx = 0;
    let halfBit = 0;

    if (Math.abs(rawNormal.y) > 0.5) {
        // 床/天井クリック: プレイヤー視線の反対方向が正面
        if (Math.abs(camDir.x) > Math.abs(camDir.z)) {
            facingIdx = camDir.x > 0 ? 3 : 1; // 東向き->west(3), 西向き->east(1)
        } else {
            facingIdx = camDir.z > 0 ? 0 : 2; // 南向き->north(0), 北向き->south(2)
        }
        halfBit = rawNormal.y < -0.5 ? 1 : 0; // 天井裏クリックなら上付き
    } else {
        // 壁面クリック: クリックした壁にヒンジを合わせる
        if (rawNormal.z < -0.5) facingIdx = 0;      // north
        else if (rawNormal.x > 0.5) facingIdx = 1;  // east
        else if (rawNormal.z > 0.5) facingIdx = 2;  // south
        else if (rawNormal.x < -0.5) facingIdx = 3; // west

        let fracY = intersectPoint.y - Math.floor(intersectPoint.y);
        if (fracY < 0) fracY += 1;
        halfBit = fracY > 0.5 ? 1 : 0;
    }

    return (facingIdx & 3) | ((halfBit & 1) << 2);
});

// レッドストーン信号の立ち上がり/立ち下がりエッジ記録（手動開閉と自動開閉を両立）
const _trapdoorLastPowered = new Map();

function trapdoorCoordKey(x, y, z) {
    return `${x},${y},${z}`;
}

defineBlocks({
    OAK_TRAPDOOR: {
        name: "oak_trapdoor",
        blockstateFile: "oak_trapdoor",
        redstoneRole: "trapdoor",
        redstoneConductive: false,
        redstoneConnectsWire: false,
        redstoneDevice: true,
        properties: {
            facing: ['north', 'east', 'south', 'west'],
            half: ['bottom', 'top'],
            open: false
        },
        interactCycle: "open",
        placementRule: "trapdoor",
        collision: true,
        transparent: true,
        alphaCutout: true,
        lightOpacity: 0,
        cullAdjacentFaces: false,
        screenFill: false,
        hardness: 3.0,
        onPlace: ({ x, y, z, state }) => {
            _trapdoorLastPowered.delete(trapdoorCoordKey(x, y, z));
            return state;
        },
        onRedstoneUpdate: ({ x, y, z, id, meta, power, setBlock }) => {
            const key = trapdoorCoordKey(x, y, z);
            const isPowered = power > 0;
            const prevPowered = _trapdoorLastPowered.get(key) === true;
            if (isPowered === prevPowered) return;

            _trapdoorLastPowered.set(key, isPowered);
            if (getBlockStateProp(id, meta, "open") !== isPowered) {
                const nextMeta = setBlockStateProp(id, meta, "open", isPowered);
                setBlock(x, y, z, packRawBlock(id, nextMeta));
            }
        }
    }
});