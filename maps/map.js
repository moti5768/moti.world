let navMode = false;              // ナビモード ON/OFF
let routingControl = null;        // ルーティングコントロール
let currentDestination = null;    // 目的地を保持
let userSelectedRoute = null;     // ユーザーが代替ルートを選択した場合に保持
let startMarker = null;
let userInteracting = false;
let programMoving = false;
let currentLabel = null;
let currentLatLng = null;
let currentSpeed = 0;
const reqLat = lat;
const reqLng = lng;
// ===== マップ中心の市町村を表示 =====
let lastCenterFetch = 0;
let currentCenterController = null; // 中断用

// ====== よく使う要素 ======
const panel = document.querySelector('.panel');
const navModeBtn = document.getElementById("navModeBtn");
const cancelNavBtn = document.getElementById("cancelNavBtn");
const elEta = document.getElementById("eta");
const elCurrentAddr = document.getElementById("currentAddress");
const elDestAddr = document.getElementById("destAddress");
const elTotalDist = document.getElementById("totalDist");
const elAvgSpeed = document.getElementById("avgSpeed");
const lastAge = document.getElementById('lastAge');

const centerToggle = document.getElementById('centerToggle');
const stopBtn = document.getElementById('stopBtn');
const restartBtn = document.getElementById('restartBtn');

const elLat = document.getElementById('lat');
const elLng = document.getElementById('lng');
const elAcc = document.getElementById('acc');
const elAlt = document.getElementById('alt');
const elSpeed = document.getElementById('speed');
const elHeading = document.getElementById('heading');

// ログUI
const logToggleBtn = document.getElementById('logToggleBtn');
const log = document.getElementById('log');
const logContainer = document.getElementById('log-container');

// ===== ログ折りたたみ =====
logToggleBtn.addEventListener('click', () => {
    log.classList.toggle('collapsed');
    logtoggle();
});
function logtoggle() {
    const collapsed = log.classList.contains('collapsed');
    logContainer.style.minHeight = collapsed ? '40px' : '20vh';
    logContainer.style.height = collapsed ? '40px' : '';
    logToggleBtn.textContent = collapsed ? '▲' : '▼';
    if (!collapsed) requestAnimationFrame(() => panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' }));
}
// ログ初期読み込み
log.classList.add('collapsed');
logtoggle();

// ===== マップ・トラッキング初期化 =====
let map, marker, watchId = null, pathSegments = [], polylines = [], logData = [];
let lastFetchTime = 0, lastPosTime = 0, follow = true, lastOrientation = null;
const LS_KEYS = { PATH: 'hp_map_path_v3', LOG: 'hp_map_log_v3' };

// ===== マップ初期化 =====
async function initMap() {
    // 仮の初期座標（東京駅など）
    let initLat = 35.6812, initLng = 139.7671;
    let initialZoom = 17;
    let lastPath = null;

    // ローカルストレージに保存された最後の位置があれば使用
    try {
        lastPath = JSON.parse(localStorage.getItem(LS_KEYS.PATH));
        if (lastPath && lastPath.length && lastPath[lastPath.length - 1].length) {
            const lastPoint = lastPath[lastPath.length - 1].slice(-1)[0];
            if (lastPoint) {
                initLat = lastPoint[0];
                initLng = lastPoint[1];
                initialZoom = 17;
            }
        }
    } catch (e) { console.warn('ローカル復元失敗', e); }

    // ===== マップ作成（iPhoneマップ風・即時更新対応） =====
    map = L.map('map', {
        zoomAnimation: true,
        fadeAnimation: true,
        markerZoomAnimation: true,
        inertia: true,
        inertiaDeceleration: 2500,
        zoomControl: false,
        attributionControl: false,
    }).setView([initLat, initLng], initialZoom);

    // --- タイルレイヤー定義 ---
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        detectRetina: false,
        tileSize: 256,
        updateWhenIdle: false,
        updateWhenZooming: true,
        reuseTiles: true,
        unloadInvisibleTiles: false,
        keepBuffer: 3,
        attribution: '© OpenStreetMap contributors',
    });

    const terrainLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        detectRetina: false,
        tileSize: 256,
        updateWhenIdle: false,
        updateWhenZooming: true,
        reuseTiles: true,
        unloadInvisibleTiles: false,
        keepBuffer: 3,
        attribution: '© OpenTopoMap contributors',
    });

    const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 20,
        detectRetina: false,
        tileSize: 256,
        updateWhenIdle: false,
        updateWhenZooming: true,
        reuseTiles: true,
        unloadInvisibleTiles: false,
        keepBuffer: 3,
        attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    });

    // ダークモード用（標準のみ）
    const darkOSMLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        detectRetina: false,
        tileSize: 256,
        updateWhenIdle: false,
        updateWhenZooming: true,
        reuseTiles: true,
        unloadInvisibleTiles: false,
        keepBuffer: 3,
        attribution: '© CartoDB',
        opacity: 0.92,
    });

    // 初期表示は標準OSM
    osmLayer.addTo(map);

    // レイヤー切替コントロール追加（右上）
    L.control.layers(
        { "標準": osmLayer, "地形": terrainLayer, "衛星": satelliteLayer },
        null,
        { position: 'topright' }
    ).addTo(map);

    // ===== ダークモード制御（安定・維持対応） =====
    const darkModeToggle = document.getElementById("darkModeToggle");
    let darkMode = false;
    let currentBase = "標準"; // 現在のベースレイヤー名
    // モード適用関数（remove/add競合を回避）
    function applyMapTheme() {
        const mapEl = document.getElementById("map");

        // 標準レイヤー
        if (currentBase === "標準") {
            const targetLayer = darkMode ? darkOSMLayer : osmLayer;

            // 必ず正しいレイヤーだけ残す
            [osmLayer, darkOSMLayer].forEach(l => {
                if (l !== targetLayer && map.hasLayer(l)) map.removeLayer(l);
            });

            // targetLayer が未追加なら追加
            if (!map.hasLayer(targetLayer)) targetLayer.addTo(map);

            mapEl.style.filter = ""; // 標準は filter 不要
        }
        // 地形レイヤー
        else if (currentBase === "地形") {
            if (!map.hasLayer(terrainLayer)) terrainLayer.addTo(map);
            mapEl.style.filter = darkMode ? "brightness(0.78) contrast(1.05)" : "";
        }
        // 衛星レイヤー
        else if (currentBase === "衛星") {
            if (!map.hasLayer(satelliteLayer)) satelliteLayer.addTo(map);
            mapEl.style.filter = darkMode ? "brightness(0.78) contrast(1.05)" : "";
        }
    }
    // ベースレイヤー変更時は必ず適用
    map.on("baselayerchange", (e) => {
        currentBase = e.name;
        applyMapTheme();
    });
    // ダークモードトグル
    darkModeToggle?.addEventListener("click", () => {
        darkMode = !darkMode;
        document.body.classList.toggle("dark-mode", darkMode);
        document.querySelector('.leaflet-control-zoom').classList.toggle("dark-mode", darkMode);
        document.querySelector('.leaflet-control-layers-toggle').classList.toggle("dark-mode", darkMode);
        darkModeToggle.textContent = darkMode ? "ライトモード" : "ダークモード";
        applyMapTheme();
    });

    // ===== コントロール =====
    L.control.zoom({ position: 'topleft' }).addTo(map);
    L.control.attribution({ position: 'bottomleft' }).addTo(map);

    // ===== ドラッグ・ズーム開始時にユーザー操作フラグを立てる =====
    map.on('dragstart zoomstart', () => {
        if (!programMoving) userInteracting = true;
        if (currentLabel) {
            currentLabel.remove();
            currentLabel = null;
        }
    });

    // ===== ドラッグ・ズーム終了時にユーザー操作ならOFF =====
    map.on('dragend zoomend', () => {
        if (userInteracting) {
            follow = false;
            centerToggle.textContent = '自動追尾: OFF';
            userInteracting = false;
        }
    });

    map.on("moveend", updateCenterLocation);

    // ===== ローカル座標がなければ現在地取得して初回表示 =====
    if (!lastPath || !lastPath.length) {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(pos => {
                const { latitude, longitude } = pos.coords;
                map.setView([latitude, longitude], 17);
            });
        }
    }
}

// ===== ユーティリティ =====
function toFixedOrDash(v, d = 6) {
    if (!Number.isFinite(v)) return '---';
    // 0〜20 に制限（toFixed 仕様の安全範囲）
    const digits = Math.max(0, Math.min(20, Math.floor(d)));
    let s = Number(v).toFixed(digits);
    // -0 / -0.000 を "0" / "0.000" に修正
    if (/^-0(\.0+)?$/.test(s)) {
        s = s.replace('-', '');
    }
    return s;
}
const now = () => Date.now();
function haversine(a, b) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const φ1 = a[0] * toRad, φ2 = b[0] * toRad;
    const Δφ = (b[0] - a[0]) * toRad;
    const Δλ = (b[1] - a[1]) * toRad;
    const sinΔφ = Math.sin(Δφ / 2);
    const sinΔλ = Math.sin(Δλ / 2);
    const aa = sinΔφ * sinΔφ + Math.cos(φ1) * Math.cos(φ2) * sinΔλ * sinΔλ;
    return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}
function directionName(deg) {
    if (deg == null || isNaN(deg) || deg < 0 || deg > 360) return '---';
    const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
    const idx = Math.round(deg / 45) & 7;
    return `${dirs[idx]} (${Math.round(deg)}°)`;
}
// ===== 距離・速度計算 =====
function calcTotalDistance() {
    let total = 0;
    for (const seg of pathSegments) {
        for (let i = 1; i < seg.length; i++) {
            total += haversine(seg[i - 1], seg[i]);
        }
    }
    return total;
}
function calcAvgSpeed() {
    const len = logData.length;
    if (len < 2) return 0;
    const firstTime = logData[0]?.time;
    const lastTime = logData[len - 1]?.time;
    const t1 = firstTime ? new Date(firstTime).getTime() : now();
    const t2 = lastTime ? new Date(lastTime).getTime() : now();
    const dt = Math.abs(t2 - t1) / 1000;
    if (dt <= 0) return 0;
    return (calcTotalDistance() / dt) * 3.6;
}
function updateStatsUI() {
    const dist = calcTotalDistance(); // メートル
    const avg = calcAvgSpeed();
    let distText;
    if (dist < 1000) {
        // 1km未満 → m（小数1桁）
        distText = dist.toFixed(1) + ' m';
    }
    else if (dist < 10000) {
        // 1〜10 km → 小数2桁
        distText = (dist / 1000).toFixed(2) + ' km';
    }
    else {
        // 10km以上 → 小数1桁
        distText = (dist / 1000).toFixed(1) + ' km';
    }
    elTotalDist.textContent = distText;
    elAvgSpeed.textContent = avg.toFixed(2) + ' km/h';
}

// ===== 保存・復元 =====
let saveTimer = null;
let isSaving = false;
function safeSaveLocal() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        if (isSaving) return;
        isSaving = true;
        try {
            const paths = JSON.stringify(pathSegments);
            const logs = JSON.stringify(logData);
            localStorage.setItem(LS_KEYS.PATH, paths);
            localStorage.setItem(LS_KEYS.LOG, logs);
            console.log("localStorage 保存完了");
        } catch (e) {
            console.warn("ローカル保存失敗", e);
        } finally {
            isSaving = false;
        }
    }, 1500);
}

// ページ閉じる前にも確実に保存
window.addEventListener("beforeunload", () => {
    try {
        localStorage.setItem(LS_KEYS.PATH, JSON.stringify(pathSegments));
        localStorage.setItem(LS_KEYS.LOG, JSON.stringify(logData));
    } catch { }
});

// ===== 復元関数（空チェック付き） =====
function restoreLocal() {
    try {
        const rawP = localStorage.getItem(LS_KEYS.PATH);
        const rawL = localStorage.getItem(LS_KEYS.LOG);
        // 空配列または無効データなら復元しない
        if (!rawP || rawP === "[]" || rawP === "{}" || rawP.length < 5) return;
        pathSegments = JSON.parse(rawP);
        logData = rawL ? JSON.parse(rawL) : [];
        if (logData.length) {
            logData.slice(0, 200).forEach(e => addLogEntry(e, true));
        }
    } catch (e) {
        console.warn("復元エラー", e);
    }
}

// --- 軽量化ポリライン更新 ---
let polylineUpdateCounter = 0;
const POLYLINE_UPDATE_INTERVAL = 3;
function yellowgreenrawPolylines() {
    // --- 空データ（全削除時）対応 ---
    if (!pathSegments?.length) {
        if (polylines?.length) {
            polylines.forEach(line => {
                try { map.removeLayer(line); } catch (e) { console.warn(e); }
            });
            polylines = [];
        }
        polylineUpdateCounter = 0; // カウンタもリセット
        return;
    }
    // --- 通常更新処理 ---
    const lastSeg = pathSegments[pathSegments.length - 1];
    if (!lastSeg?.length) return;
    let lastLine = polylines[0];
    if (!lastLine) {
        // --- 初回ポリライン生成（全ルート復元対応） ---
        const allPoints = pathSegments.flat();  // ★ 全ルートを1本に結合
        lastLine = L.polyline(allPoints, {
            color: '#9ACD32',
            weight: 8,
            opacity: 0.8,
            smoothFactor: 1.5,
            noClip: true
        }).addTo(map);
        polylines.push(lastLine);
        polylineUpdateCounter = allPoints.length; // 全体の長さをカウントに
        return;
    }
    // --- 軽量化アップデート ---
    polylineUpdateCounter++;
    if (polylineUpdateCounter % POLYLINE_UPDATE_INTERVAL === 0) {
        // 一定回数ごとに全体を再設定（軽量化）
        lastLine.setLatLngs(lastSeg);
    } else {
        // 普段は末尾だけ追加
        const newPoint = lastSeg[lastSeg.length - 1];
        lastLine.addLatLng(newPoint);
    }
}

// ===== マーカー更新（軽量安定版）=====
function updateMarker(lat, lng, heading, accColor, speed) {
    const speedKmh = speed * 3.6;
    const size = (speedKmh > 200 ? 20 : 16);
    if (lat == null || lng == null) {
        if (marker) {
            map.removeLayer(marker);
            marker = null;
        }
        return;
    }
    if (!marker) {
        const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="width:${size}px;height:${size}px;background:${accColor};
                    border:2px solid #fff;border-radius:50%;
                    transform:rotate(${heading || 0}deg)"></div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        });
        marker = L.marker([lat, lng], { icon }).addTo(map);
        marker._div = marker.getElement()?.querySelector('div') || null;
        marker._lastHeading = heading || 0;
        marker._animId = null;
        marker._lastPos = marker.getLatLng();
        marker.on("click", e => {
            showMarkerLabelLeaflet(e, "現在地");
        });
        map.on("click", () => {
            if (currentLabel) {
                currentLabel.remove();
                currentLabel = null;
            }
        });
        return;
    }
    const div = marker._div;
    const from = marker._lastPos;
    const fromLat = from.lat, fromLng = from.lng;
    const toLat = lat, toLng = lng;
    const dLat = toLat - fromLat, dLng = toLng - fromLng;
    const dist = Math.hypot(dLat, dLng) * 111000;
    if (dist < 0.5 && Math.abs((heading - marker._lastHeading + 540) % 360 - 180) < 1)
        return;
    const fromHead = marker._lastHeading;
    const toHead = (typeof heading === 'number') ? heading : fromHead;
    const deltaHead = ((toHead - fromHead + 540) % 360) - 180;
    if (div && div.style.background !== accColor) div.style.background = accColor;
    const start = performance.now(), duration = 400;
    function step(now) {
        const t = Math.min(1, (now - start) / duration);
        const e = t * (2 - t);
        marker.setLatLng([fromLat + dLat * e, fromLng + dLng * e]);
        if (div) div.style.transform = `rotate(${fromHead + deltaHead * e}deg)`;
        if (t < 1) marker._animId = requestAnimationFrame(step);
        else {
            marker._animId = null;
            marker._lastHeading = toHead;
            marker._lastPos = marker.getLatLng();
        }
    }
    cancelAnimationFrame(marker._animId);
    marker._animId = requestAnimationFrame(step);
}

function showMarkerLabelLeaflet(e, text) {
    // 古いラベルを消す
    if (currentLabel) {
        currentLabel.remove();
        currentLabel = null;
    }
    // マップ座標
    const point = map.mouseEventToContainerPoint(e.originalEvent);
    const mapEl = map.getContainer();
    const rect = mapEl.getBoundingClientRect();
    // transform の安全取得（null / none 対策）
    const transform = window.getComputedStyle(mapEl).transform;
    let scale = 1;
    const match = (transform && transform !== 'none')
        ? transform.match(/matrix\(([^,]+),/)
        : null;
    if (match) {
        const parsed = parseFloat(match[1]);
        if (!isNaN(parsed)) scale = parsed;
    }
    // scale 補正後の座標
    const x = rect.left + point.x * scale;
    const y = rect.top + point.y * scale;
    const label = document.createElement('div');
    label.textContent = text;
    label.style.position = 'absolute';
    label.style.left = `${x + 20}px`;
    label.style.top = `${y - 20}px`;
    label.style.background = 'rgba(0,0,0,0.7)';
    label.style.color = 'white';
    label.style.padding = '2px 5px';
    label.style.borderRadius = '4px';
    label.style.fontSize = '15px';
    label.style.pointerEvents = 'none';
    label.style.zIndex = 1000;
    document.body.appendChild(label);
    currentLabel = label;
}

// --- 住所取得 fetchAddress（キャッシュ・中断対応・距離制限付き） ---
const addrCache = new Map();              // キャッシュ: 緯度経度キー
let lastAddressPoint = null;              // 最後に住所を取得した座標
let currentAddressController = null;      // Abort用コントローラ

async function fetchAddress(lat, lng) {
    const nowTime = Date.now();
    // === 1. 取得間隔制御（1秒以内の連続呼び出しを防ぐ） ===
    if (nowTime - lastFetchTime < 1000) return '取得間隔制御中';
    // === 2. 近接チェック（15m以内ならキャッシュ／既存表示を使う） ===
    try {
        if (lastAddressPoint && haversine([lat, lng], lastAddressPoint) < 15) {
            const key = `${lastAddressPoint[0].toFixed(4)},${lastAddressPoint[1].toFixed(4)}`;
            if (addrCache.has(key)) return addrCache.get(key);
        }
    } catch (e) {
        console.warn('近接チェック例外', e);
    }
    lastFetchTime = nowTime;
    lastAddressPoint = [lat, lng];
    // === 3. キャッシュ利用（約10m精度・高速移動でも安定） ===
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`; // 10〜11m精度
    if (addrCache.has(key)) return addrCache.get(key);
    // === 4. 既存リクエスト中止（高速移動対応） ===
    if (currentAddressController) {
        try { currentAddressController.abort(); } catch (e) { /* ignore */ }
    }
    currentAddressController = new AbortController();
    const signal = currentAddressController.signal;
    try {
        // === 5. Nominatim 逆ジオコーディング ===
        const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja`,
            { signal, headers: { 'User-Agent': 'HighSpeedMap/1.0 (compatible; fetchAddress)' } }
        );
        if (!res.ok) {
            console.warn('住所取得HTTP失敗', res.status);
            return '住所取得失敗';
        }
        const data = await res.json();
        const a = data.address || {};
        // === 6. 日本の都道府県判定 ===
        const jpPrefs = [
            '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
            '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
            '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県',
            '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
            '鳥取県', '島根県', '岡山県', '広島県', '山口県',
            '徳島県', '香川県', '愛媛県', '高知県',
            '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'
        ];
        let joined = Object.values(a).filter(Boolean).join(' ');
        if (data.display_name) joined += ' ' + data.display_name;
        let prefecture = '';
        const regex = new RegExp(jpPrefs.join('|'));
        const match = joined.match(regex);
        if (match) {
            prefecture = match[0];
        } else {
            for (const full of jpPrefs) {
                const short = full.replace(/(都|道|府|県)$/, '');
                if (short && joined.includes(short)) {
                    prefecture = full;
                    break;
                }
            }
        }
        // === 7. 番地・建物名の補完 ===
        if (!a.house_number || !a.building) {
            const parts = (data.display_name || '').split(',').map(s => s.trim());
            if (!a.house_number) {
                const hn = parts.find(p => /\d{1,4}(-\d{1,4})*/.test(p) && !/\d{3}-\d{4}/.test(p));
                if (hn) a.house_number = hn;
            }
            if (!a.building) {
                const bd = parts.find(p => /ビル|マンション|ハイツ|アパート/.test(p));
                if (bd) a.building = bd;
            }
        }
        // === 8. 出力形式 ===
        const result = [
            a.postcode,
            prefecture,
            a.city || a.town || a.village,
            a.suburb || a.neighbourhood,
            a.road,
            a.house_number,
            a.building
        ].filter(Boolean).join(', ');
        const finalAddress = result || data.display_name || '住所情報なし';
        // === 9. キャッシュ保存 ===
        addrCache.set(key, finalAddress);
        return finalAddress;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn('住所取得中止（新しいリクエストへ切替）');
            return '住所取得中止';
        }
        console.warn('fetchAddress error', err);
        return '住所取得エラー';
    } finally {
        currentAddressController = null;
    }
}

// ===== ログ表示（軽量バッチ版・最新安定） =====
let pendingLogs = [];
const MAX_LOG = 200;
const LOG_UPDATE_INTERVAL = 1500; // 更新間隔(ms)
let lastLogFlush = 0;
function flushLogs() {
    if (pendingLogs.length === 0) return;
    if (log.classList && log.classList.contains('collapsed')) {
        // 表示折りたたみ中はログデータにだけ追加して保存・統計更新に留める
        logData.unshift(...pendingLogs);
        pendingLogs.length = 0;
        safeSaveLocal();
        updateStatsUI();
        return;
    }
    const now = performance.now();
    if (now - lastLogFlush < LOG_UPDATE_INTERVAL) return;
    lastLogFlush = now;
    const fragment = document.createDocumentFragment();
    for (const e of pendingLogs) {
        const accClass = e.accuracy < 5 ? 'acc-green' :
            e.accuracy < 15 ? 'acc-yellowgreen' :
                e.accuracy < 30 ? 'acc-orange' : 'acc-red';
        const div = document.createElement('div');
        div.className = 'log-entry';
        div.innerHTML = `
            <div class="time">🕒 ${new Date(e.time).toLocaleString()}</div>
            <div class="coords">(${e.lat.toFixed(6)}, ${e.lng.toFixed(6)})</div>
            <div class="address">📍 ${e.address}</div>
            <div class="info">
                <div class="accuracy ${accClass}">精度:${e.accuracy.toFixed(1)}m</div>
                <div>速度:${e.speedText}</div>
                <div>方角:${e.headingText}</div>
            </div>
        `;
        fragment.appendChild(div);
    }
    // 一括追加（新しいものを上に）
    log.prepend(fragment);
    pendingLogs.length = 0;
    // 古いログ削除（まとめて削除）
    const excess = log.childElementCount - MAX_LOG;
    if (excess > 0) {
        for (let i = 0; i < excess; i++) {
            if (log.lastChild) log.lastChild.remove();
        }
    }
    // 必要な関数呼び出し
    safeSaveLocal();
    updateStatsUI();
}
// 定期更新（軽量タイマー）
setInterval(flushLogs, LOG_UPDATE_INTERVAL);

// addLogEntry は pendingLogs に push だけ
function addLogEntry(e, restoreMode = false) {
    if (!restoreMode) logData.unshift(e);
    pendingLogs.push(e);
}

// ===== ダウンロード =====
function download(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = filename;
    a.click();
}

document.getElementById('exportJsonBtn').addEventListener('click', () => download('location_log.json', JSON.stringify({ pathSegments, logData, savedAt: new Date().toISOString() }, null, 2)));

// ==========================================================
// 位置情報関連 変数定義
// ==========================================================
let lastRouteUpdate = 0;
let lastRoutePoint = null;
let lastAddressTime = 0;
const MIN_ACCURACY = 40; // 精度40m以上は無視
let firstPositionReceived = false; // 初回フラグ
const SMOOTHING_COUNT = 3; // 平滑化点数
let smoothBuffer = [];     // 平滑化バッファ
let retryAccuracyThreshold = MIN_ACCURACY;
let lastGoodUpdate = null;
let lastGoodUpdateTime = 0;
let lastAcc; // 最後の精度値
// ==========================================================
// 位置更新メイン関数
// ==========================================================
async function handlePosition(pos) {
    // ---------- 無効データ防御 ----------
    if (!pos || !pos.coords) {
        updateMarker(null, null, 0, 'black', 0);
        return;
    }
    // ---------- 基本値取得 ----------
    const c = pos.coords;
    const lat = c.latitude;
    const lng = c.longitude;
    const acc = c.accuracy || 0;
    const alt = c.altitude;
    let speed = (c.speed >= 0) ? c.speed : null;
    currentSpeed = Number.isFinite(speed) ? speed : 0;
    let heading = (typeof c.heading === 'number') ? c.heading : null;
    const nowTime = Date.now();
    let smoothed = [lat, lng];
    const lastSegment = pathSegments[pathSegments.length - 1];
    const prev = lastSegment ? lastSegment.slice(-1)[0] : null;
    const isFirst = !firstPositionReceived;
    if (isFirst) firstPositionReceived = true;
    // ==========================================================
    // 外れ値除外（徒歩〜新幹線まで対応）
    // ==========================================================
    if (lastGoodUpdate) {
        const dt = Math.max((pos.timestamp - lastGoodUpdateTime) / 1000, 0.1);
        const dist = haversine(lastGoodUpdate, [lat, lng]);
        const impliedSpeed = dist / dt;

        const MAX_REALISTIC_SPEED = 140; // ≈504 km/h

        if (impliedSpeed > MAX_REALISTIC_SPEED && acc > 50) {
            return;
        }
    }
    lastGoodUpdate = [lat, lng];
    lastGoodUpdateTime = pos.timestamp;
    // ==========================================================
    // 精度チェック
    // ==========================================================
    const accChanged = (typeof lastAcc !== 'undefined' && acc !== lastAcc);
    lastAcc = acc;
    if (!isFirst) {
        const recentlyUpdated = Date.now() - lastGoodUpdateTime <= 5000;
        if (acc > retryAccuracyThreshold && recentlyUpdated && !accChanged) {
            return;
        }
    }
    // 精度に応じた色
    const accColor =
        acc < 5 ? 'green'
            : acc < 15 ? 'yellowgreen'
                : acc < 30 ? 'orange'
                    : 'red';
    // ==========================================================
    // 速度・方角補正
    // ==========================================================
    if (prev) {
        const dt = Math.max((pos.timestamp - lastPosTime) / 1000, 0.1);
        if (!speed) speed = haversine(prev, [lat, lng]) / dt;
        if ((heading === null || isNaN(heading)) && dt > 0) {
            heading = Math.atan2(lng - prev[1], lat - prev[0]) * 180 / Math.PI;
            if (heading < 0) heading += 360;
        }
    }
    // デバイスコンパス優先
    if (lastOrientation !== null) heading = lastOrientation;
    heading = (heading === null || isNaN(heading)) ? 0 : heading;
    const speedKmh = speed ? speed * 3.6 : 0;
    // ==========================================================
    // UI更新
    // ==========================================================
    elLat.textContent = toFixedOrDash(lat, 6);
    elLng.textContent = toFixedOrDash(lng, 6);
    elAcc.textContent = `${acc.toFixed(1)} m`;
    elAlt.textContent = alt === null ? '---' : `${alt.toFixed(1)} m`;
    elSpeed.textContent = speed ? `${speedKmh.toFixed(1)} km/h` : '---';
    elHeading.textContent = directionName(heading);
    elAcc.style.color = accColor;
    // ==========================================================
    // 平滑化＋低精度補正
    // ==========================================================
    if (isFirst || acc <= MIN_ACCURACY || (prev && haversine(prev, [lat, lng]) > 5)) {
        // ---- バッファ追加 ----
        smoothBuffer.push([lat, lng]);
        if (smoothBuffer.length > SMOOTHING_COUNT) smoothBuffer.shift();
        const prevMarkerPos = marker
            ? [marker.getLatLng().lat, marker.getLatLng().lng]
            : [lat, lng];
        // ---- ワープ検知（80m） ----
        const jumpDist = haversine(prevMarkerPos, [lat, lng]);
        if (jumpDist > 80) {
            smoothed = [lat, lng];
            smoothBuffer = [[lat, lng]];
            updateMarker(lat, lng, heading, accColor, speed, false);
            if (follow && map) map.setView([lat, lng]);
            return;
        }
        // ---- 平滑化平均 ----
        smoothed = [
            smoothBuffer.reduce((s, p) => s + p[0], 0) / smoothBuffer.length,
            smoothBuffer.reduce((s, p) => s + p[1], 0) / smoothBuffer.length
        ];
        // ---- マーカー移動制限 ----
        if (marker) {
            const prevMarker = [marker.getLatLng().lat, marker.getLatLng().lng];
            const d = haversine(prevMarker, smoothed);
            const speedMs = speed || 0;
            const timeSinceLast = (nowTime - lastPosTime) / 1000;
            const wasPaused = timeSinceLast > 3;
            if (wasPaused) {
                smoothed = [lat, lng];
                smoothBuffer = [[lat, lng]];
            } else {
                const MAX_STEP_BASE = Math.min(Math.max(5, acc / 2), 50);
                const MAX_STEP_SPEED_FACTOR = Math.min(1 + speedMs / 5, 10);
                const MAX_STEP = Math.min(MAX_STEP_BASE * MAX_STEP_SPEED_FACTOR, 500);
                if (d > MAX_STEP) {
                    const ratio = MAX_STEP / d;
                    smoothed = [
                        prevMarker[0] + (smoothed[0] - prevMarker[0]) * ratio,
                        prevMarker[1] + (smoothed[1] - prevMarker[1]) * ratio
                    ];
                }
            }
        }
        // ---- 経路追加 ----
        const smoothDist = prev ? haversine(prev, smoothed) : Infinity;
        const threshold = Math.max(1.5, acc / 2);
        if (!marker || !prev || smoothDist > threshold || isFirst) {
            let seg = pathSegments[pathSegments.length - 1];
            if (!seg || seg.length === 0) {
                pathSegments.push([]);
                seg = pathSegments[pathSegments.length - 1];
            }
            seg.push(smoothed);
            yellowgreenrawPolylines();
            updateMarker(smoothed[0], smoothed[1], heading, accColor, speed);
            if (follow && map && !userInteracting) {
                programMoving = true;
                const center = map.getCenter();
                const d = haversine(
                    [center.lat, center.lng],
                    smoothed
                );
                map.panTo(smoothed, {
                    animate: d > 10,      // ★ 10m以上のみアニメ
                    duration: d > 10 ? 0.3 : 0
                });
                map.once('moveend', () => (programMoving = false));
            }
            updateCenterLocation();
            if (isFirst && map) map.setView(smoothed, 17);
        }
    }
    // ==========================================================
    // 住所更新（3秒間隔）
    // ==========================================================
    if (
        nowTime - lastAddressTime > 3000 &&   // ★ 3秒以上
        (!lastAddressPoint ||
            haversine(lastAddressPoint, [lat, lng]) > 30) // ★ 30m以上移動
    ) {
        fetchAddress(lat, lng).then(addr => {
            if (reqLat === lat && reqLng === lng) {
                elCurrentAddr.textContent = addr;
            }
        });
        lastAddressTime = nowTime;
    }
    // ==========================================================
    // ログ追加
    // ==========================================================
    addLogEntry({
        time: new Date().toISOString(),
        lat, lng, accuracy: acc, altitude: alt,
        speedKmh: speed ? speedKmh : null,
        speedText: speed ? `${speedKmh.toFixed(1)} km/h` : '---',
        headingText: directionName(heading),
        address: elCurrentAddr.textContent
    });
    // ==========================================================
    // ルート中のリアルタイム ETA更新
    // ==========================================================
    if (routingControl && routePath && routePath.length > 0 && currentDestination) {
        currentLatLng = marker ? marker.getLatLng() : L.latLng(lat, lng);
        updateEtaSmart(currentLatLng.lat, currentLatLng.lng, speed || 0);
    }
    // ==========================================================
    // スタート地点マーカーの追従（Routing Machine）
    // ==========================================================
    try {
        const plan = routingControl?.getPlan?.();
        if (plan && plan._waypoints && plan._waypoints[0]) {
            plan._waypoints[0].latLng = L.latLng(smoothed[0], smoothed[1]);
            plan._updateMarkers();
        }
    } catch (err) { }
    lastPosTime = pos.timestamp || now();
    lastAge.textContent = '0秒前';
}


// ======== グローバル定数 ========
const MAX_DEVIATION = 30;       // ルート逸脱判定[m]
const SPEED_BUFFER_SIZE = 7;    // 速度平滑化バッファサイズ
const MIN_SPEED = 0.5;          // 停止判定速度[m/s]
const MIN_MOVE_DIST = 10;       // 小移動無視距離[m]
const ETA_ALPHA = 0.08;         // 補間係数
const ETA_UPDATE_INTERVAL = 1000; // ETA更新間隔[ms]

// ===== アニメーション用ポリライン管理 =====
let animatedPolylines = []; // {polyline, route}
let routePath = [];             // ← これを追加
let speedBuffer = [];
let displayedRemainTimeSec = null;
let lastNearestIndex = null;
let lastUpdateTime = null;
let lastLatLng = null;
let navActive = false;
let etaTimerRunning = false;
let routingInProgress = false;
let rerouting = false;

// ======== 距離計算（ハバースイン） ========
function haversineDistance([lat1, lon1], [lat2, lon2]) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ======== スマートETA更新 ========
function updateEtaSmart(lat, lng, speed) {
    if (!navActive || rerouting || !routePath || routePath.length === 0) return;
    const current = [lat, lng];
    // --- 最も近いルート点を探索 ---
    let minDist = Infinity;
    let nearestIndex = lastNearestIndex ?? 0;
    for (let i = 0; i < routePath.length; i++) {
        const p = routePath[i];
        const coord = Array.isArray(p) ? p : [p.lat, p.lng];
        const d = haversineDistance(current, coord);
        if (d < minDist) {
            minDist = d;
            nearestIndex = i;
        }
    }
    // --- 小移動・誤差無視 ---
    if (lastNearestIndex !== null && Math.abs(nearestIndex - lastNearestIndex) < 3 && minDist < MIN_MOVE_DIST) {
        nearestIndex = lastNearestIndex;
    }
    lastNearestIndex = nearestIndex;
    // --- 残距離計算 ---
    let remain = 0;
    for (let i = nearestIndex; i < routePath.length - 1; i++) {
        const a = routePath[i], b = routePath[i + 1];
        const pa = Array.isArray(a) ? a : [a.lat, a.lng];
        const pb = Array.isArray(b) ? b : [b.lat, b.lng];
        remain += haversineDistance(pa, pb);
    }
    if (remain < 3) {
        elEta.textContent = "目的地に到着";
        displayedRemainTimeSec = 0;
        lastLatLng = current;
        // --- 自動ナビキャンセル ---
        if (navActive) {
            setTimeout(() => {
                cancelNavigation();
            }, 1000);
        }
        return;
    }
    // --- 速度平滑化 ---
    if (Number.isFinite(speed) && speed >= 0) {
        speedBuffer.push(speed);
        if (speedBuffer.length > SPEED_BUFFER_SIZE) speedBuffer.shift();
    }
    let avgSpeed = speedBuffer.length > 0 ? speedBuffer.reduce((a, b) => a + b, 0) / speedBuffer.length : 0;
    if (avgSpeed < MIN_SPEED) avgSpeed = 0;
    // --- 仮速度判定 ---
    let effectiveSpeed = (!Number.isFinite(speed) || speed <= 0) ? 1 : (avgSpeed > 0 ? avgSpeed : 1);
    // --- 残時間計算 ---
    let remainTimeSec = remain / effectiveSpeed;
    // --- 補間更新 ---
    if (displayedRemainTimeSec == null) displayedRemainTimeSec = remainTimeSec;
    else displayedRemainTimeSec = displayedRemainTimeSec * (1 - ETA_ALPHA) + remainTimeSec * ETA_ALPHA;
    lastLatLng = current;
    // --- 表示 ---
    const distText = remain >= 1000 ? (remain / 1000).toFixed(2) + "km" : Math.round(remain) + "m";
    const t = Math.max(0, displayedRemainTimeSec);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const timeText = h > 0
        ? `${h}時間${m.toString().padStart(2, '0')}分`
        : `${m}分${s.toString().padStart(2, '0')}秒`;
    elEta.textContent = `${distText} / 約${timeText}`;
}

// ======== ETA タイマー ========
function startEtaTimer() {
    if (etaTimerRunning) return;
    etaTimerRunning = true;
    const loop = () => {
        if (!navActive) {
            etaTimerRunning = false;
            return;
        }
        if (currentLatLng) {
            updateEtaSmart(
                currentLatLng.lat,
                currentLatLng.lng,
                Number.isFinite(currentSpeed) ? currentSpeed : 0
            );
        }
        setTimeout(loop, ETA_UPDATE_INTERVAL);
    };
    loop();
}

// ======== 5秒ごとのルート逸脱チェック ========
setInterval(async () => {
    // --- ナビ状態を確認 ---
    if (rerouting || routingInProgress || !navActive || !marker || !routePath?.length) return;
    const current = marker.getLatLng();
    const acc = lastAcc || 0; // 最新の精度（handlePositionで更新）
    // --- GPS精度が悪いときはスキップ ---
    if (acc > 50) { // 50m以上の誤差なら再ルート禁止
        console.log("⚠️ 精度低下中のため再ルートをスキップ (精度:", acc.toFixed(1), "m)");
        return;
    }
    // --- 現在地とルート上の最も近い点の距離を算出 ---
    let minDist = Infinity;
    routePath.forEach(p => {
        const point = Array.isArray(p) ? L.latLng(p[0], p[1]) : p;
        const d = map.distance(current, point);
        if (d < minDist) minDist = d;
    });
    // --- 一定距離以上外れた場合のみ再ルート ---
    if (minDist > MAX_DEVIATION && currentDestination) {
        rerouting = true;
        elEta.textContent = "ルート修正中…";
        try {
            await generateNavigationRoute(current, currentDestination, animatedPolylines);
        } catch (err) {
            console.warn("再ルート失敗:", err);
        } finally {
            rerouting = false;
        }
    }
}, 5000);

// ===== エラー処理 =====
let retryTimer = null;
function handleError(err) {
    console.warn('位置取得エラー', err);
    if (!retryTimer) {
        retryTimer = setTimeout(() => {
            retryTimer = null;
            // 精度条件を緩めて再追跡
            retryAccuracyThreshold = Math.max(retryAccuracyThreshold * 1.5, 100);
            startTracking();
        }, 3000);
    }
}

// ===== 追跡開始 =====
function startTracking() {
    if (!navigator.geolocation) {
        alert('位置情報未対応');
        return;
    }

    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }

    // 初回は低精度
    navigator.geolocation.getCurrentPosition(
        pos => {
            retryAccuracyThreshold = MIN_ACCURACY;
            handlePosition(pos);
        },
        err => handleError(err),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 5000 }
    );

    // 継続監視（動いている時だけ高精度）
    watchId = navigator.geolocation.watchPosition(
        pos => {
            retryAccuracyThreshold = MIN_ACCURACY;
            handlePosition(pos);
        },
        err => handleError(err),
        {
            enableHighAccuracy: currentSpeed > 1.5,
            timeout: 15000,
            maximumAge: currentSpeed > 1.5 ? 1000 : 5000
        }
    );
}

// ===== 更新時間表示 =====
setInterval(() => {
    if (document.hidden) return;
    if (lastPosTime) {
        const deltaSec = Math.floor((now() - lastPosTime) / 1000);
        const h = Math.floor(deltaSec / 3600), m = Math.floor((deltaSec % 3600) / 60), s = deltaSec % 60;
        let text = '';
        if (h > 0) text += `${h}時間`;
        if (m > 0 || h > 0) text += `${m}分`;
        text += `${s}秒前`;
        lastAge.textContent = text;
    }
}, 1000);

// ===== DeviceOrientation =====
async function setupDeviceOrientation() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const btn = document.createElement('button');
        btn.textContent = 'コンパス許可';
        btn.className = 'warning';
        btn.style.margin = '6px';
        panel.appendChild(btn);
        btn.addEventListener('click', async () => {
            const perm = await DeviceOrientationEvent.requestPermission();
            if (perm === 'granted') { window.addEventListener('deviceorientationabsolute', onDeviceOrientation); btn.remove(); } else alert('拒否');
        });
    } else if (window.DeviceOrientationEvent) window.addEventListener('deviceorientationabsolute', onDeviceOrientation);
}
function onDeviceOrientation(e) {
    if (e && typeof e.alpha === 'number') {
        lastOrientation = (360 - e.alpha) % 360;
        elHeading.textContent = directionName(lastOrientation);
        if (marker && marker.getElement()) {
            const div = marker.getElement().querySelector('div');
            if (div) div.style.transform = `rotate(${lastOrientation}deg)`;
        }
    }
}

const instructionMap = {
    "Destination": "目的地",
    "Arrive at destination": "目的地に到着",
    "Start": "出発地点",
    "Merge": "合流",
    "U-turn": "Uターン",
    "Via": "経由",
    "on": "上",
    "toward": "方面",
    "heading": "方向",
    "north": "北",
    "south": "南",
    "east": "東",
    "west": "西",
    "the left": "左側",
    "the right": "右側",
    "left": "左",
    "right": "右",
    "onto": "上に"
};

const patterns = [
    // ラウンドアバウト
    { re: /^Enter roundabout/i, replace: "ロータリーに入る" },
    { re: /^Exit roundabout/i, replace: "ロータリーを出る" },
    { re: /^Roundabout with (\d+) exits/i, replace: (m) => `ロータリー（${m[1]}出口）` },
    // Turn + direction + onto + road
    { re: /^Turn (?:the )?(left|right) onto (.+)/i, replace: (m) => `${m[2]} に${m[1].toLowerCase() === "left" ? "左折" : "右折"}で合流` },
    // right/left onto 単体対応（Turnなし）
    { re: /^(?:the )?(left|right) onto (.+)/i, replace: (m) => `${m[2]} に${m[1].toLowerCase() === "left" ? "左折" : "右折"}で合流` },
    // Make a + Sharp/Slight + direction
    { re: /make a sharp left/i, replace: "鋭角に左折" },
    { re: /make a sharp right/i, replace: "鋭角に右折" },
    { re: /make a slight left/i, replace: "やや左方向" },
    { re: /make a slight right/i, replace: "やや右方向" },
    // 左右折単体
    { re: /^Turn (left|right)/i, replace: (m) => m[1].toLowerCase() === "left" ? "左折" : "右折" },
    { re: /^Slight (left|right)/i, replace: (m) => "やや" + (m[1].toLowerCase() === "left" ? "左" : "右") + "方向" },
    { re: /^Sharp (left|right)/i, replace: (m) => "鋭角に" + (m[1].toLowerCase() === "left" ? "左" : "右") + "折" },
    { re: /^Keep (left|right)/i, replace: (m) => m[1].toLowerCase() === "left" ? "左側を維持" : "右側を維持" },
    // Take the ramp / Take the exit
    { re: /^Take (?:the )?ramp(?: to (.+))?/i, replace: (m) => m[1] ? `${m[1]} にランプで合流` : "ランプで合流" },
    { re: /^Take (?:the )?exit (\d+)(?: to (.+))?/i, replace: (m) => m[2] ? `${m[2]} に${m[1]}出口で合流` : `${m[1]}出口で合流` },
    // 分岐点
    { re: /at the fork/i, replace: "分岐点で" },
    // 進行方向・head対応
    { re: /^head (\w+)/i, replace: (m) => `${m[1]} 方向に進む` },
    { re: /^Head (\w+)/i, replace: (m) => `${m[1]} 方向に進む` },
    { re: /heading (\w+)/i, replace: (m) => `${m[1]} 方向に進む` },
    // 進行方向単体
    { re: /^Continue/i, replace: "直進" },
    { re: /Go straight/i, replace: "直進" },
    { re: /Proceed/i, replace: "直進" },
    // 信号・交差点
    { re: /At traffic light/i, replace: "信号で" },
    { re: /At intersection/i, replace: "交差点で" },
    { re: /Turn at junction/i, replace: "交差点で曲がる" }
];

function translateInstructions(route) {
    if (!route.instructions) return;
    route.instructions.forEach(instr => {
        let text = instr.text;
        // 文章をフレーズに分割
        const parts = text.split(/,|then|and/i).map(p => p.trim()).filter(p => p);
        const translatedParts = parts.map(part => {
            let t = part;
            // 目的地到着
            if (/You have arrived at your/i.test(t)) return "目的地に到着です";
            // right/left onto 単体対応（Turnなし）
            let match = t.match(/^(?:the )?(left|right) onto (.+)/i);
            if (match) return `${match[2]}に${match[1].toLowerCase() === "left" ? "左折" : "右折"}してください`;
            // Turn + left/right onto
            match = t.match(/^Turn (?:the )?(left|right) onto (.+)/i);
            if (match) return `${match[2]}に${match[1].toLowerCase() === "left" ? "左折" : "右折"}してください`;
            // Take the ramp（入口）
            match = t.match(/^Take (?:the )?ramp(?: to (.+))?/i);
            if (match) {
                const road = match[1];
                if (!road) return "道路に入ります"; // 道路名が無い場合の汎用表現
                if (/I-|Highway/i.test(road)) return `${road}高速に入ります`;
                if (/Route/i.test(road)) return `国道${road.replace(/\D/g, '')}号に入ります`;
                if (/Prefectural Road/i.test(road)) return `県道${road.replace(/\D/g, '')}号に入ります`;
                return `${road}に入ります`; // 一般道路
            }
            // Take the exit（出口）
            match = t.match(/^Take (?:the )?exit (\d+)(?: to (.+))?/i);
            if (match) {
                const exitNum = match[1];
                const road = match[2];
                if (!road) return `${exitNum}番出口で降ります`; // 道路名なしの場合
                if (/I-|Highway/i.test(road)) return `${exitNum}番出口で降りて${road}高速に入ります`;
                if (/Route/i.test(road)) return `${exitNum}番出口で降りて国道${road.replace(/\D/g, '')}号に入ります`;
                if (/Prefectural Road/i.test(road)) return `${exitNum}番出口で降りて県道${road.replace(/\D/g, '')}号に入ります`;
                return `${exitNum}番出口で降りて${road}に入ります`; // 一般道路
            }
            // Enter + 道路名
            match = t.match(/^Enter (.+)/i);
            if (match) return `${match[1]}に入ります`;
            // head / heading + 方角
            match = t.match(/^(head|Head|heading) (\w+)/i);
            if (match) {
                const dirMap = { north: "北", south: "南", east: "東", west: "西" };
                const dirJa = dirMap[match[2].toLowerCase()] || match[2];
                return `${dirJa}方向に進みます`;
            }
            // straight ahead
            if (/straight ahead/i.test(t)) return "直進してください";
            // パターンルール
            for (const p of patterns) {
                const m = t.match(p.re);
                if (m) {
                    const replaced = typeof p.replace === "function" ? p.replace(m) : p.replace;
                    return replaced.replace(/方向$/, "方向に進みます");
                }
            }
            // 単語置換
            Object.entries(instructionMap)
                .sort((a, b) => b[0].length - a[0].length)
                .forEach(([en, ja]) => {
                    const re = new RegExp(`\\b${en}\\b`, 'gi');
                    t = t.replace(re, ja);
                });

            return t;
        });
        // 自然な接続語で結合
        instr.text = translatedParts.join("。次に、");
    });
}

// ===== 初期ロード =====
window.addEventListener('load', () => {
    initMap();
    restoreLocal();
    setupDeviceOrientation();
    startTracking();
    yellowgreenrawPolylines();
    // ナビモード切替
    navModeBtn.addEventListener("click", () => {
        navMode = !navMode;
        navModeBtn.textContent = navMode
            ? "地図クリックで目的地を選択中…"
            : "ナビ開始(車のみ)";
        if (navMode) {
            // ナビ開始時にETAリセット
            displayedRemainTimeSec = null; // 補間値リセット
            lastNearestIndex = null;       // 最近点インデックスリセット
            lastUpdateTime = null;         // 時間基準リセット
            speedBuffer = [];              // 速度バッファリセット
        }
    });
    // ===== マップクリックで目的地選択（代替ルート対応＆翻訳安定版） =====
    map.on("click", async e => {
        if (!navMode) return;
        if (!marker) {
            alert("現在地を取得中です。位置が確定したらもう一度クリックしてください。");
            return;
        }
        currentDestination = e.latlng;
        userSelectedRoute = false;
        displayedRemainTimeSec = null;
        lastUpdateTime = null;
        speedBuffer = [];
        const start = marker.getLatLng();
        const dest = currentDestination;
        navMode = false;
        navModeBtn.textContent = "ナビ開始(車のみ)";
        await generateNavigationRoute(start, dest, animatedPolylines);
    });
    cancelNavBtn.addEventListener("click", cancelNavigation);
});

async function cancelNavigation() {
    try {
        // --- 経路描画中でも強制停止 ---
        if (routingControl) {
            try {
                const container = routingControl.getContainer?.();
                if (container && container.parentNode) container.remove();
                map.removeControl(routingControl);
            } catch (err) {
                console.warn("routingControl削除時エラー:", err);
            }
            routingControl = null;
        }

        // --- 残留ルート線（Leaflet Routing Machine内部線も含む）を完全除去 ---
        map.eachLayer(layer => {
            if (layer instanceof L.Polyline) {
                const col = layer.options?.color;
                if (col === "#1976d2" || col === "#f44336" || col === "transparent") {
                    map.removeLayer(layer);
                }
            }
        });

        // --- アニメーション線削除 ---
        if (window.animatedPolylines?.length) {
            animatedPolylines.forEach(p => {
                try { map.removeLayer(p.polyline || p); } catch { }
            });
        }
        animatedPolylines = [];

        // --- 目的地マーカー削除（現在地マーカー除外） ---
        map.eachLayer(layer => {
            if (layer instanceof L.Marker) {
                const iconClass = layer.options.icon?.options?.className || "";
                if (layer === marker || iconClass.includes("user") || iconClass.includes("current")) return;
                if (iconClass.includes("custom-marker") || iconClass.includes("destination")) {
                    map.removeLayer(layer);
                }
            }
        });

        // --- 状態リセット ---
        navMode = false;
        navActive = false;
        navModeBtn.textContent = "ナビ開始(車のみ)";
        currentDestination = null;
        userSelectedRoute = false;
        displayedRemainTimeSec = null;
        lastNearestIndex = null;
        lastUpdateTime = null;
        speedBuffer = [];

        // --- UIリセット ---
        const closeBtn = document.querySelector(".leaflet-routing-close");
        if (closeBtn) closeBtn.remove();

        if (marker) {
            const { lat, lng } = marker.getLatLng();
            const address = await fetchAddress(lat, lng);
            elCurrentAddr.textContent = address;
        }

        if (elDestAddr) elDestAddr.textContent = "---";
        if (elEta) elEta.textContent = "---";

        console.log("✅ ナビキャンセル完了：ルート削除");

    } catch (err) {
        console.error("ナビキャンセル処理中エラー:", err);
    }
}
// ===== 操作ボタン =====
stopBtn.addEventListener('click', () => {
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        smoothBuffer = [];
    }
});

restartBtn.addEventListener('click', () => {
    if (!watchId) {
        smoothBuffer = [];
        startTracking();
    }
});

document.getElementById('clearBtn').addEventListener('click', () => {
    if (!confirm('本当にクリアしますか？')) return;
    // --- ポリライン削除 ---
    if (window.polylines?.length) {
        polylines.forEach(line => {
            try { map.removeLayer(line); } catch (e) { console.warn(e); }
        });
        polylines = [];
    }
    // --- データ初期化 ---
    pathSegments = [];
    logData = [];
    log.innerHTML = '';
    // --- localStorage 即時クリア保存（遅延なし）---
    try {
        localStorage.setItem(LS_KEYS.PATH, "[]");
        localStorage.setItem(LS_KEYS.LOG, "[]");
        console.log("✅ localStorage 即時クリア完了");
    } catch (e) {
        console.warn("⚠️ クリア保存失敗", e);
    }
    // --- 再描画・UI更新 ---
    yellowgreenrawPolylines();
    updateStatsUI();
    console.log("経路・ログをすべてクリアしました");
});

centerToggle.addEventListener('click', async () => {
    follow = !follow;
    centerToggle.textContent = `自動追尾: ${follow ? 'ON' : 'OFF'}`;
    if (follow && marker) {
        const pos = marker.getLatLng();
        // プログラム移動中フラグON
        programMoving = true;
        // 現在地にアニメーションで移動＆ズーム
        map.flyTo(pos, 17, { animate: true, duration: 1.2 });
        // flyToアニメーション終了後にフラグを解除
        map.once('moveend', () => {
            programMoving = false;
        });
        // 現在地の住所を更新
        const addr = await fetchAddress(pos.lat, pos.lng);
        elCurrentAddr.textContent = addr;
        // 追尾中はユーザー操作でズーム・パン可能
        map.dragging.enable();
        map.touchZoom.enable();
        map.scrollWheelZoom.enable();
        map.doubleClickZoom.enable();
        map.boxZoom.enable();
        map.keyboard.enable();
    }
});

function btn_toggle() {
    if (stopBtn.classList.contains('btn-pointer-none')) {
        stopBtn.classList.remove('btn-pointer-none');
        restartBtn.classList.add('btn-pointer-none');
    } else {
        stopBtn.classList.add('btn-pointer-none');
        restartBtn.classList.remove('btn-pointer-none');
    }
}

// ===== スムーズアニメーション関数（軽量最適化版） =====
function animateRouteSmooth(latlngs, color = "#1976d2", weight = 7, duration = 2000) {
    if (!Array.isArray(latlngs) || latlngs.length < 2) return null;
    // --- サンプリングを簡略化 ---
    const simplified = [latlngs[0]];
    const segDist = [];
    let totalDist = 0;
    const sampleDist = 15; // サンプリング間隔[m]
    for (let i = 1; i < latlngs.length; i++) {
        const prev = simplified[simplified.length - 1];
        const dist = map.distance(prev, latlngs[i]);
        if (dist >= sampleDist || i === latlngs.length - 1) {
            simplified.push(latlngs[i]);
            segDist.push(dist);
            totalDist += dist;
        }
    }
    // 末尾の範囲チェック追加
    if (simplified.length < 2) return null;
    // --- ポリライン生成 ---
    const polyline = L.polyline([simplified[0]], {
        color,
        weight,
        opacity: 1
    }).addTo(map);
    // --- アニメーション制御 ---
    const segCount = segDist.length;
    const speedPerMs = totalDist / duration; // 距離あたり速度[m/ms]
    let startTime = null;
    let currentSeg = 0;
    let traveled = 0;
    const points = [simplified[0]];
    function step(ts) {
        if (!startTime) startTime = ts;
        const elapsed = ts - startTime;
        const targetDist = Math.min(totalDist, elapsed * speedPerMs);
        // 進行に応じて次の座標を計算
        while (currentSeg < segCount && traveled + segDist[currentSeg] < targetDist) {
            traveled += segDist[currentSeg];
            points.push(simplified[++currentSeg]);
        }
        if (currentSeg < segCount) {
            const remain = targetDist - traveled;
            const ratio = remain / segDist[currentSeg];
            const a = simplified[currentSeg];
            const b = simplified[currentSeg + 1];
            if (a && b) {
                points[points.length - 1] = L.latLng(
                    a.lat + (b.lat - a.lat) * ratio,
                    a.lng + (b.lng - a.lng) * ratio
                );
            }
        }
        polyline.setLatLngs(points);
        if (elapsed < duration) {
            requestAnimationFrame(step);
        } else {
            polyline.setLatLngs(simplified);
        }
    }
    requestAnimationFrame(step);
    return polyline;
}

// ======== ナビルート生成関数（分離前と完全同等動作） ========
async function generateNavigationRoute(start, dest, animatedPolylines) {
    if (routingInProgress) return;
    routingInProgress = true;
    rerouting = true;
    navActive = false;
    // --- UI更新 ---
    elDestAddr.textContent = "住所取得中...";
    elEta.textContent = "経路計算中...";
    navMode = false; // ← 分離前と同様にナビモード解除
    if (navModeBtn) navModeBtn.textContent = "ナビ開始(車のみ)";
    // --- 住所取得（非同期） ---
    fetchAddress(dest.lat, dest.lng).then(addr => {
        elDestAddr.textContent = addr || "住所取得失敗";
    });
    // --- 既存ルート削除 ---
    if (routingControl) map.removeControl(routingControl);
    animatedPolylines.forEach(p => map.removeLayer(p.polyline || p));
    animatedPolylines.length = 0;
    try {
        routingControl = L.Routing.control({
            waypoints: [start, dest],
            routeWhileDragging: false,
            addWaypoints: false,
            draggableWaypoints: false,
            showAlternatives: true,
            fitSelectedRoutes: false,
            language: "en",
            lineOptions: { styles: [{ color: "transparent", weight: 25, opacity: 0 }] },
            altLineOptions: { styles: [{ color: "transparent", weight: 25, opacity: 0 }] },
            createMarker: (i, wp) => {
                if (i === 0) return null;
                const size = 20, color = "#800080";
                const markerDest = L.marker(wp.latLng, {
                    icon: L.divIcon({
                        className: "custom-marker",
                        html: `<div style="width:${size}px;height:${size}px;background:${color};
                            border:2px solid #fff;border-radius:50%;
                            box-shadow:0 0 5px rgba(0,0,0,0.3);"></div>`,
                        iconSize: [size, size],
                        iconAnchor: [size / 2, size / 2]
                    })
                });
                markerDest.on("click", () => map.flyTo(markerDest.getLatLng(), 17, { animate: true, duration: 1.2 }));
                markerDest.on("click", e => showMarkerLabelLeaflet(e, "目的地"));
                return markerDest;
            },
            position: "bottomright"
        })
            // --- 経路計算開始 ---
            .on("routingstart", () => {
                if (navActive) return; // ナビ中は無視
                elEta.textContent = "経路計算中...";
            })
            // --- 経路計算完了 ---
            .on("routesfound", e => {
                const routes = e.routes;
                if (!routes || routes.length === 0) return;
                // 翻訳適用
                routes.forEach(route => translateInstructions(route));
                // --- メインルート設定 ---
                const best = routes[0];
                routePath = best.coordinates.slice();
                currentDestination = routePath[routePath.length - 1];
                routeTotalDistance = best.summary?.totalDistance || 0;
                routeTotalTime = best.summary?.totalTime || 0;
                userSelectedRoute = false;
                navActive = true;
                startEtaTimer();
                // ETA初期更新
                const startPos = marker.getLatLng();
                updateEtaSmart(startPos.lat, startPos.lng, Number.isFinite(currentSpeed) ? currentSpeed : 0);
                // --- 各ルート描画（クリック選択可能） ---
                routes.forEach((route, idx) => {
                    const color = idx === 0 ? "#1976d2" : "#f44336";
                    const weight = idx === 0 ? 7 : 5;
                    const animLine = animateRouteSmooth(route.coordinates, color, weight, 800);
                    animatedPolylines.push({ polyline: animLine, route });
                    animLine.on("click", () => {
                        routePath = route.coordinates.slice();
                        userSelectedRoute = true;
                        displayedRemainTimeSec = null;
                        lastNearestIndex = null;
                        lastUpdateTime = null;
                        speedBuffer = [];
                        const pos = marker.getLatLng();
                        updateEtaSmart(pos.lat, pos.lng, Number.isFinite(currentSpeed) ? currentSpeed : 0);
                        animatedPolylines.forEach(p =>
                            p.polyline.setStyle(p.route === route
                                ? { color: "#1976d2", weight: 8 }
                                : { color: "#f44336", weight: 4 })
                        );
                    });
                });
                // --- 翻訳安定化再試行 ---
                let tries = 0;
                const translatePanel = () => {
                    document.querySelectorAll('.leaflet-routing-instruction').forEach(el => {
                        let text = el.textContent;
                        Object.entries(instructionMap)
                            .sort((a, b) => b[0].length - a[0].length)
                            .forEach(([en, ja]) => {
                                text = text.replace(new RegExp(`\\b${en}\\b`, 'gi'), ja);
                            });
                        el.textContent = text;
                    });
                };
                const tryTranslate = () => {
                    tries++;
                    const elems = document.querySelectorAll('.leaflet-routing-instruction');
                    if (elems.length > 0) translatePanel();
                    else if (tries < 10) setTimeout(tryTranslate, 400);
                };
                tryTranslate();
            })
            // --- 経路再選択（LRMパネルでクリック） ---
            .on("routeselected", e => {
                translateInstructions(e.route);
                routePath = e.route.coordinates.slice();
                currentDestination = routePath[routePath.length - 1];
                displayedRemainTimeSec = null;
                lastNearestIndex = null;
                lastUpdateTime = null;
                speedBuffer = [];
                const pos = marker.getLatLng();
                updateEtaSmart(pos.lat, pos.lng, Number.isFinite(currentSpeed) ? currentSpeed : 0);
                userSelectedRoute = true;
                animatedPolylines.forEach(p =>
                    p.polyline.setStyle(p.route === e.route
                        ? { color: "#1976d2", weight: 8 }
                        : { color: "#f44336", weight: 4 })
                );
            })
            // --- 経路エラー ---
            .on("routingerror", () => {
                elEta.textContent = "経路取得失敗";
            })
            .addTo(map);
        // --- パネル制御 ---
        const container = routingControl.getContainer();
        container.style.zIndex = "998";
        if (!document.querySelector(".leaflet-routing-close")) {
            const closeBtn = document.createElement("a");
            closeBtn.className = "leaflet-routing-close";
            closeBtn.textContent = "案内パネル表示切替";
            closeBtn.style.cssText = `
                position:absolute;bottom:10px;right:10px;
                padding:5px 8px;background-color:darkgray;
                font-size:15px;font-weight:500;color:#333;
                border:1.5px solid gray;border-radius:8px;
                box-shadow:0 2px 6px rgba(0,0,0,0.2);
                cursor:pointer;z-index:999;
            `;
            closeBtn.onclick = () => {
                const c = routingControl.getContainer();
                c.style.display = c.style.display === "none" ? "block" : "none";
            };
            document.getElementById("map").appendChild(closeBtn);
        }
    } finally {
        routingInProgress = false;
        rerouting = false;
        navActive = true;
    }
}

async function updateCenterLocation() {
    if (!map) return;
    const now = Date.now();
    if (now - lastCenterFetch < 1500) return;
    lastCenterFetch = now;
    const { lat, lng } = map.getCenter();
    currentCenterController?.abort();
    currentCenterController = new AbortController();
    try {
        const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja&zoom=10`,
            { headers: { "User-Agent": "MapCenterLookup/1.0" }, signal: currentCenterController.signal }
        );
        if (!res.ok) throw new Error(res.status);
        const a = (await res.json()).address || {};
        const city = a.city || a.town || a.village || a.county || "位置取得中...";
        document.getElementById("centerLocation").textContent = city;
    } catch (err) {
        if (err.name !== "AbortError") {
            console.warn("マップ中心位置の住所取得失敗", err);
            document.getElementById("centerLocation").textContent = "位置取得失敗";
        }
    } finally {
        currentCenterController = null;
    }
}

// ===== DOM camera =====
const preview = document.getElementById('preview');
const photoBtn = document.getElementById('photoBtn');
const videoBtn = document.getElementById('videoBtn');
const togglePreviewBtn = document.getElementById('togglePreview');
const camera_area = document.getElementById('camera_area');
const mapEl = document.getElementById('map');
const controls = document.getElementById('controls');
camera_area.style.pointerEvents = "none";

// ===== 状態 =====
let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recording = false;
let previewVisible = false;
let firstSnapshotPosition = null;
let snapshotCount = 0;

// ===== 共通関数 =====
const setDisplay = (el, value) => el && (el.style.display = value);
const togglePointer = (el, enable) => el && (el.style.pointerEvents = enable ? "" : "none");

// ブラウザ遷移させずに自動ダウンロード
const downloadBlob = (blob, filename) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    // 非同期で click を呼ぶ
    setTimeout(() => {
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
    }, 100);
};

// ===== カメラ制御 =====
async function startCamera() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: true
        });
        preview.srcObject = mediaStream;
        await preview.play().catch(() => { }); // スマホで映像停止対策
        previewVisible = true;
        setDisplay(preview, 'block');
        setDisplay(panel, 'none');
        setDisplay(camera_area, 'block');
        setDisplay(controls, 'flex');
        mapEl.classList.add('test');
        togglePointer(camera_area, true);
    } catch {
        alert('カメラアクセスが許可されませんでした');
    }
}

function stopCamera() {
    mediaStream?.getTracks().forEach(track => track.stop());
    mediaStream = null;
    preview.srcObject = null;
    setDisplay(preview, 'none');
    setDisplay(panel, 'block');
    setDisplay(camera_area, 'none');
    setDisplay(controls, 'none');
    mapEl.classList.remove('test');
    togglePointer(camera_area, false);
}

// ===== 写真撮影 =====
function displaySnapshot(dataURL) {
    const img = document.createElement('img');
    img.src = dataURL;
    img.alt = 'Captured Image';
    Object.assign(img.style, {
        position: 'absolute',
        width: '100px',
        height: 'auto',
        border: '2px solid white',
        borderRadius: '8px',
        zIndex: `${100 + snapshotCount}`
    });

    if (!firstSnapshotPosition) {
        const rect = mapEl.getBoundingClientRect();
        const scrollLeft = window.scrollX || document.documentElement.scrollLeft;
        const scrollTop = window.scrollY || document.documentElement.scrollTop;
        firstSnapshotPosition = {
            left: rect.right + scrollLeft - 100,
            top: rect.bottom + scrollTop + 20
        };
    }
    const offsetX = -10 * snapshotCount;
    const offsetY = 10 * snapshotCount;
    img.style.left = `${firstSnapshotPosition.left + offsetX}px`;
    img.style.top = `${firstSnapshotPosition.top + offsetY}px`;

    document.body.appendChild(img);
    snapshotCount++;

    setTimeout(() => {
        img.remove();
        snapshotCount--;
        if (snapshotCount === 0) firstSnapshotPosition = null;
    }, 3000);
}

function capturePhoto() {
    if (!mediaStream) return alert('カメラが有効になっていません');
    const canvas = document.createElement('canvas');
    canvas.width = preview.videoWidth;
    canvas.height = preview.videoHeight;
    canvas.getContext('2d').drawImage(preview, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(blob => {
        const blobUrl = URL.createObjectURL(blob);
        displaySnapshot(blobUrl);
        downloadBlob(blob, 'photo.png');
    }, 'image/png');
}

// ===== 録画 =====
function toggleRecording() {
    if (!mediaStream) return alert('カメラが有効になっていません');
    recording ? stopRecording() : startRecording();
}

function startRecording() {
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = e => e.data.size && recordedChunks.push(e.data);
    mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: 'video/webm' });
        downloadBlob(blob, 'video.webm');
        recordedChunks = [];
    };
    mediaRecorder.start();
    recording = true;
    videoBtn.classList.add('recording');
}

function stopRecording() {
    mediaRecorder?.stop();
    recording = false;
    videoBtn.classList.remove('recording');
}

// ===== イベント =====
togglePreviewBtn.addEventListener('click', async () => {
    if (!mediaStream) await startCamera();
    else preview.style.display = (previewVisible = !previewVisible) ? 'block' : 'none';
});

photoBtn.addEventListener('click', capturePhoto);
videoBtn.addEventListener('click', toggleRecording);
document.getElementById('videoreturn').addEventListener('click', stopCamera);