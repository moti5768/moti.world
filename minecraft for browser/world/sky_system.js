"use strict";
import * as THREE from '../build/three.module.js';

/* ======================================================
   【昼夜サイクル・天体・空＆フォグ色エンジン】(world/sky_system.js)
   - 太陽・月・2層星フィールドの描画および軌道更新
   - 24000 ticks/日 の Minecraft 準拠スカイライト係数・朝焼け/夕焼け・太陽グレア
   - ゲーム内時計 (HH:mm) 変換ユーティリティ
   ====================================================== */

export const TICKS_PER_DAY = 24000;

const CELESTIAL_ORBIT_RADIUS = 1500; // 描画距離(2500)より内側、雲より外側に配置

const SKY_COLORS = {
    DAY: { r: 120, g: 167, b: 255 },
    SUNSET: { r: 240, g: 160, b: 80 },
    NIGHT: { r: 10, g: 10, b: 20 },
    DAWN: { r: 255, g: 180, b: 100 }
};

/**
 * Minecraft 準拠の空の明るさ係数 (0.1 〜 1.0)
 * 0: 日の出, 6000: 正午, 12000: 日没, 18000: 真夜中
 */
export function getSkyLightFactor(time) {
    // --- 昼間 ---
    if (time >= 0 && time < 11000) return 1.0;

    // --- 日没（夕焼け） ---
    if (time >= 11000 && time < 13000) {
        const t = (time - 11000) / 2000;
        return THREE.MathUtils.lerp(1.0, 0.1, t);
    }

    // --- 深夜（22800まで維持） ---
    if (time >= 13000 && time < 22800) return 0.1;

    // --- 朝焼け（22800から日の出の24000にかけて一気に明るくする） ---
    if (time >= 22800 && time < 24000) {
        const t = (time - 22800) / 1200;
        return THREE.MathUtils.lerp(0.1, 1.0, t);
    }

    return 1.0;
}

/**
 * ゲーム内時間を HH:mm 形式に変換 (1000 ticks = 1時間, 0 ticks = 06:00)
 */
export function getGameClock(ticks) {
    const totalHours = (ticks / 1000 + 6) % 24;
    const hours = Math.floor(totalHours);
    const minutes = Math.floor((totalHours % 1) * 60);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

export function createSkySystem(deps) {
    const {
        scene,
        camera,
        getRenderer,
        getPlayer,
        getBrightnessMultiplier,
        sharedSkyUniform
    } = deps;

    let sunMesh = null;
    let moonMesh = null;
    let starGroup = null;

    const _tmpCamDir = new THREE.Vector3();
    const _tmpSunDir = new THREE.Vector3();
    const _skyColorObj = new THREE.Color();

    function initSunMoon() {
        if (sunMesh && moonMesh) return;
        const loader = new THREE.TextureLoader();

        // --- 太陽の設定 ---
        const sunTex = loader.load('textures/environment/sun.png');
        sunTex.magFilter = THREE.NearestFilter;
        sunTex.minFilter = THREE.NearestFilter;

        const sunMat = new THREE.MeshBasicMaterial({
            map: sunTex,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            color: new THREE.Color(0xbbbbbb),
            fog: false
        });
        sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(450, 450), sunMat);
        sunMesh.renderOrder = -20;
        sunMesh.frustumCulled = false;
        scene.add(sunMesh);

        // --- 月の設定 ---
        const moonTex = loader.load('textures/environment/moon_phases.png');
        moonTex.magFilter = THREE.NearestFilter;
        moonTex.minFilter = THREE.NearestFilter;

        // moon_phases.png から「満月」の区画だけを表示
        moonTex.repeat.set(0.25, 0.5);
        moonTex.offset.set(0, 0.5);

        const moonMat = new THREE.MeshBasicMaterial({
            map: moonTex,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            color: new THREE.Color(0xffffff),
            fog: false
        });
        moonMesh = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), moonMat);
        moonMesh.renderOrder = -20;
        moonMesh.frustumCulled = false;
        scene.add(moonMesh);
    }

    function initStars() {
        if (starGroup) return;
        starGroup = new THREE.Group();

        const starConfigs = [
            { count: 100, size: 3.0, alpha: 1.0 }, // 大きい星 (少なく、明るい)
            { count: 700, size: 1.5, alpha: 0.6 }  // 小さい星 (多く、少し暗い)
        ];

        for (let c = 0; c < starConfigs.length; c++) {
            const config = starConfigs[c];
            const positions = new Float32Array(config.count * 3);

            for (let i = 0; i < config.count; i++) {
                const theta = Math.random() * Math.PI * 2;
                const phi = Math.acos((Math.random() * 2) - 1);
                const r = CELESTIAL_ORBIT_RADIUS * 0.9;

                positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
                positions[i * 3 + 1] = r * Math.cos(phi);
                positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

            const mat = new THREE.PointsMaterial({
                color: 0xffffff,
                size: config.size,
                sizeAttenuation: false,
                transparent: true,
                opacity: 0,
                depthTest: true,
                depthWrite: false,
                fog: false
            });
            mat.userData = { baseAlpha: config.alpha };

            const mesh = new THREE.Points(geo, mat);
            mesh.renderOrder = -25;
            mesh.frustumCulled = false;
            starGroup.add(mesh);
        }

        starGroup.renderOrder = -25;
        scene.add(starGroup);
    }

    function updateSkyAndFogColor(time, sunY, sunDir) {
        let baseR, baseG, baseB;

        // --- A. ベースカラーの決定 ---
        if (time >= 22000 || time < 2000) {
            let t;
            if (time >= 22000) {
                t = (time - 22000) / 2000;
                baseR = THREE.MathUtils.lerp(SKY_COLORS.NIGHT.r, SKY_COLORS.DAWN.r, t);
                baseG = THREE.MathUtils.lerp(SKY_COLORS.NIGHT.g, SKY_COLORS.DAWN.g, t);
                baseB = THREE.MathUtils.lerp(SKY_COLORS.NIGHT.b, SKY_COLORS.DAWN.b, t);
            } else {
                t = time / 2000;
                baseR = THREE.MathUtils.lerp(SKY_COLORS.DAWN.r, SKY_COLORS.DAY.r, t);
                baseG = THREE.MathUtils.lerp(SKY_COLORS.DAWN.g, SKY_COLORS.DAY.g, t);
                baseB = THREE.MathUtils.lerp(SKY_COLORS.DAWN.b, SKY_COLORS.DAY.b, t);
            }
        } else if (time >= 2000 && time < 10000) {
            baseR = SKY_COLORS.DAY.r; baseG = SKY_COLORS.DAY.g; baseB = SKY_COLORS.DAY.b;
        } else if (time >= 10000 && time < 13000) {
            let t;
            if (time < 12000) {
                t = (time - 10000) / 2000;
                baseR = THREE.MathUtils.lerp(SKY_COLORS.DAY.r, SKY_COLORS.SUNSET.r, t);
                baseG = THREE.MathUtils.lerp(SKY_COLORS.DAY.g, SKY_COLORS.SUNSET.g, t);
                baseB = THREE.MathUtils.lerp(SKY_COLORS.DAY.b, SKY_COLORS.SUNSET.b, t);
            } else {
                t = (time - 12000) / 1000;
                baseR = THREE.MathUtils.lerp(SKY_COLORS.SUNSET.r, SKY_COLORS.NIGHT.r, t);
                baseG = THREE.MathUtils.lerp(SKY_COLORS.SUNSET.g, SKY_COLORS.NIGHT.g, t);
                baseB = THREE.MathUtils.lerp(SKY_COLORS.SUNSET.b, SKY_COLORS.NIGHT.b, t);
            }
        } else {
            baseR = SKY_COLORS.NIGHT.r; baseG = SKY_COLORS.NIGHT.g; baseB = SKY_COLORS.NIGHT.b;
        }

        let r = baseR, g = baseG, b = baseB;

        // --- B. 視線による方向別カラー補正 ---
        camera.getWorldDirection(_tmpCamDir);

        const isSunrise = (time >= 21000 || time < 3000);
        const isSunset = (time >= 9000 && time < 14000);

        if (isSunrise || isSunset) {
            const dotSun = _tmpCamDir.dot(sunDir);
            if (dotSun > 0) {
                const heightFactor = Math.max(0, 1 - Math.abs(sunDir.y) * 1.5);
                const glow = Math.pow(dotSun, 3) * 0.8 * heightFactor;
                const target = isSunrise ? SKY_COLORS.DAWN : SKY_COLORS.SUNSET;

                r = THREE.MathUtils.lerp(r, target.r, glow);
                g = THREE.MathUtils.lerp(g, target.g, glow);
                b = THREE.MathUtils.lerp(b, target.b, glow);
            }
        }

        // --- C. 太陽直視時の眩しさ ---
        if (sunY > 0) {
            const lookAtSunFactor = _tmpCamDir.dot(sunDir);
            if (lookAtSunFactor > 0.92) {
                const intensity = Math.pow(lookAtSunFactor, 25) * 35 * Math.max(0, sunDir.y);
                r += intensity; g += intensity * 0.9; b += intensity * 0.7;
            }
        }

        // --- D. 最終適用 ---
        const brightnessMult = typeof getBrightnessMultiplier === "function" ? getBrightnessMultiplier() : 1.0;
        const m = brightnessMult / 255;
        _skyColorObj.setRGB(
            Math.max(0, Math.min(1, r * m)),
            Math.max(0, Math.min(1, g * m)),
            Math.max(0, Math.min(1, b * m))
        );

        const renderer = typeof getRenderer === "function" ? getRenderer() : null;
        if (renderer) renderer.setClearColor(_skyColorObj);
        if (scene.fog) scene.fog.color.copy(_skyColorObj);
        if (sharedSkyUniform) sharedSkyUniform.value = getSkyLightFactor(time);
    }

    function updateSunMoonPosition(renderTime) {
        const player = typeof getPlayer === "function" ? getPlayer() : null;
        if (!sunMesh || !moonMesh || !player) return;

        const angle = (renderTime / TICKS_PER_DAY) * Math.PI * 2;
        _tmpSunDir.set(Math.cos(angle), Math.sin(angle), 0).normalize();

        const sunX = _tmpSunDir.x * CELESTIAL_ORBIT_RADIUS;
        const sunY = _tmpSunDir.y * CELESTIAL_ORBIT_RADIUS;

        sunMesh.position.set(player.position.x + sunX, player.position.y + sunY, player.position.z);
        sunMesh.lookAt(player.position);

        moonMesh.position.set(player.position.x - sunX, player.position.y - sunY, player.position.z);
        moonMesh.lookAt(player.position);

        sunMesh.visible = (sunY > -150);
        moonMesh.visible = (sunY < 150);

        updateSkyAndFogColor(renderTime, sunY, _tmpSunDir);
    }

    function updateStars(renderTime) {
        const player = typeof getPlayer === "function" ? getPlayer() : null;
        if (!starGroup || !player) return;

        const nightFactor = 1.0 - getSkyLightFactor(renderTime);
        const twinkle = 0.9 + Math.sin(performance.now() * 0.001) * 0.1;
        const globalAlpha = 0.65;

        for (let i = 0; i < starGroup.children.length; i++) {
            const mesh = starGroup.children[i];
            const typeAlpha = mesh.material.userData.baseAlpha || 1.0;
            mesh.material.opacity = nightFactor * twinkle * globalAlpha * typeAlpha;
        }

        const angle = (renderTime / TICKS_PER_DAY) * Math.PI * 2;
        starGroup.rotation.z = angle;
        starGroup.position.copy(player.position);

        starGroup.visible = starGroup.children[0].material.opacity > 0.001;
    }

    return {
        init() {
            initSunMoon();
            initStars();
        },
        update(renderTime) {
            updateSunMoonPosition(renderTime);
            updateStars(renderTime);
            return getSkyLightFactor(renderTime);
        },
        updateSunMoonPosition,
        updateStars
    };
}