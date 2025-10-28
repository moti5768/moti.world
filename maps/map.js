let navMode = false;              // ナビモード ON/OFF
let routingControl = null;        // ルーティングコントロール
let currentDestination = null;    // 目的地を保持
let userSelectedRoute = null;     // ユーザーが代替ルートを選択した場合に保持
let startMarker = null;
let userInteracting = false;
let programMoving = false; // 追加
let currentLabel = null;

// ログUI
const logToggleBtn = document.getElementById('logToggleBtn');
const logContainer = document.getElementById('log');

// ===== ログ折りたたみ =====
logToggleBtn.addEventListener('click', () => {
    const logContainer = document.getElementById('log-container');
    const log = document.getElementById('log');
    log.classList.toggle('collapsed');

    if (log.classList.contains('collapsed')) {
        logContainer.style.minHeight = '40px';
        logContainer.style.height = '40px';
        logToggleBtn.textContent = '▲';
    } else {
        logContainer.style.height = '';
        logContainer.style.minHeight = '20vh';
        logToggleBtn.textContent = '▼';
    }

    const panel = document.querySelector('.panel');
    panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
});

// ===== マップ・トラッキング初期化 =====
let map, marker, watchId = null, pathSegments = [[]], polylines = [], logData = [];
let lastFetchTime = 0, lastPosTime = 0, follow = true, lastOrientation = null;
const LS_KEYS = { PATH: 'hp_map_path_v3', LOG: 'hp_map_log_v3' };

// ===== マップ初期化 =====
async function initMap() {
    // 仮の初期座標（東京駅など）を用意
    let initLat = 35.6812, initLng = 139.7671;
    let initialZoom = 17; // 初回ロード時のズーム

    let lastPath = null;

    // ローカルストレージに保存された最後の位置があればそれを使う
    try {
        lastPath = JSON.parse(localStorage.getItem(LS_KEYS.PATH));
        if (lastPath && lastPath.length && lastPath[lastPath.length - 1].length) {
            const lastPoint = lastPath[lastPath.length - 1].slice(-1)[0];
            if (lastPoint) {
                initLat = lastPoint[0];
                initLng = lastPoint[1];
                initialZoom = 17; // ローカル復元でも初回ズーム
            }
        }
    } catch (e) { console.warn('ローカル復元失敗', e); }

    // ===== マップ作成（iPhoneマップ風のスタイル・即時更新対応） =====
    map = L.map('map', {
        zoomAnimation: true,          // ズームを滑らかに
        fadeAnimation: true,          // タイル切り替えをフェードで
        markerZoomAnimation: true,    // マーカー拡大縮小アニメ
        inertia: true,                // スワイプ慣性
        inertiaDeceleration: 2500,    // 慣性の減衰（iPhoneっぽく）
        zoomControl: false,           // デフォルトズームUIを隠す
        attributionControl: false,    // 著作権表記を下に移す
    }).setView([initLat, initLng], initialZoom);

    // ===== 高精細（Retina対応）タイル読み込み（即時更新最適化） =====
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        detectRetina: false,
        attribution: '© OpenStreetMap contributors',
        tileSize: 256,
        updateWhenIdle: false,        // パン中も更新（← 即座に反映）
        updateWhenZooming: true,      // ズーム中も更新（← 即座に反映）
        reuseTiles: true,             // 既存タイルを再利用して高速化
        unloadInvisibleTiles: false,  // スクロール中に破棄しない（スムーズに）
        keepBuffer: 4,                // 少し広めにタイルを保持（連続パンに強い）
    }).addTo(map);

    // iPhoneの右下ズームボタン風に再配置
    L.control.zoom({ position: 'topleft' }).addTo(map);

    // 下部にスッキリと著作権表記
    L.control.attribution({ position: 'bottomleft' }).addTo(map);


    // ドラッグやズーム開始時にユーザー操作フラグを立てる
    map.on('dragstart zoomstart', () => {
        if (!programMoving) { // プログラム移動中は無視
            userInteracting = true;
        }
        if (currentLabel) {
            currentLabel.remove();
            currentLabel = null;
        }
    });

    // ドラッグやズーム終了時にユーザー操作ならOFF
    map.on('dragend zoomend', () => {
        if (userInteracting) {
            follow = false;
            document.getElementById('centerToggle').textContent = '自動追尾: OFF';
            userInteracting = false;
        }
    });

    // ローカル座標がなければ現在地取得して初回表示
    if (!lastPath || !lastPath.length) {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(pos => {
                const { latitude, longitude } = pos.coords;
                // 初回だけズームレベル17で表示
                map.setView([latitude, longitude], 17);
            });
        }
    }
}


// ===== ユーティリティ =====
const toFixedOrDash = (v, d = 6) => typeof v === 'number' ? v.toFixed(d) : '---';
const now = () => Date.now();
const haversine = (a, b) => {
    const R = 6371e3, toRad = d => d * Math.PI / 180;
    const φ1 = toRad(a[0]), φ2 = toRad(b[0]);
    const Δφ = toRad(b[0] - a[0]), Δλ = toRad(b[1] - a[1]);
    const aa = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
};
const directionName = deg => {
    if (deg === null || isNaN(deg)) return '---';
    const dirs = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
    return `${dirs[Math.round(deg / 45) % 8]} (${deg.toFixed(0)}°)`;
};

// ===== 距離・速度計算 =====
function calcTotalDistance() {
    return pathSegments.flatMap(seg => seg.slice(1).map((_, i) => haversine(seg[i], seg[i + 1]))).reduce((a, b) => a + b, 0);
}
function calcAvgSpeed() {
    if (logData.length < 2) return 0;
    const first = new Date(logData[logData.length - 1]?.time || now()).getTime();
    const last = new Date(logData[0]?.time || now()).getTime();
    const dt = Math.abs(last - first) / 1000;
    return dt <= 0 ? 0 : (calcTotalDistance() / dt) * 3.6;
}
function updateStatsUI() {
    document.getElementById('totalDist').textContent = (calcTotalDistance() / 1000).toFixed(3) + ' km';
    document.getElementById('avgSpeed').textContent = calcAvgSpeed().toFixed(2) + ' km/h';
}

// ===== 保存・復元 =====
function safeSaveLocal() {
    try {
        localStorage.setItem(LS_KEYS.PATH, JSON.stringify(pathSegments));
        localStorage.setItem(LS_KEYS.LOG, JSON.stringify(logData));
    } catch { }
}
function restoreLocal() {
    try {
        const rawP = localStorage.getItem(LS_KEYS.PATH);
        const rawL = localStorage.getItem(LS_KEYS.LOG);
        if (rawP) pathSegments = JSON.parse(rawP);
        if (rawL) logData = JSON.parse(rawL);
        logData.slice(0, 200).forEach(e => addLogEntry(e, true));
    } catch { }
}

// ===== ポリライン =====
function yellowgreenrawPolylines() {
    const lastSeg = pathSegments[pathSegments.length - 1];
    if (!lastSeg || lastSeg.length === 0) return;

    let lastLine = polylines[polylines.length - 1];
    if (!lastLine || lastLine.getLatLngs().length === 0) {
        lastLine = L.polyline(lastSeg, { color: '#9ACD32', weight: 6, opacity: 0.8 }).addTo(map);
        polylines.push(lastLine);
    } else {
        lastLine.addLatLng(lastSeg[lastSeg.length - 1]);
    }
}

// ===== マーカー更新（軽量化版）=====
function updateMarker(lat, lng, heading, accColor, speedKmh) {
    const size = speedKmh && speedKmh * 3.6 > 200 ? 20 : 16;

    // 無効座標ならマーカー削除
    if (lat === null || lng === null || accColor === null) accColor = 'black';
    if (lat === null || lng === null) {
        if (marker) {
            try { map.removeLayer(marker); } catch (e) { /* ignore */ }
            marker = null;
        }
        return;
    }

    // 初回作成
    if (!marker) {
        const icon = L.divIcon({
            className: 'custom-marker',
            html: `<div style="width:${size}px;height:${size}px;background:${accColor};border:2px solid #fff;border-radius:50%;transform:rotate(${heading || 0}deg)"></div>`,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2]
        });
        marker = L.marker([lat, lng], { icon }).addTo(map);
        marker._animId = null;
        marker._lastHeading = (typeof heading === 'number') ? heading : 0;
        marker._lastPos = marker.getLatLng();

        // div 要素を保持して再利用
        const el = marker.getElement && marker.getElement();
        marker._div = el ? el.querySelector('div') : null;

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

    // div 更新は色だけ
    if (div) div.style.background = accColor;

    // 既存アニメがあればキャンセル
    if (marker._animId) {
        cancelAnimationFrame(marker._animId);
        marker._animId = null;
    }

    // 補間開始値と終了値
    const from = marker.getLatLng();
    const fromLat = from.lat, fromLng = from.lng;
    const fromHeading = (marker._lastHeading === undefined) ? 0 : marker._lastHeading;
    const toLat = lat, toLng = lng;
    const toHeading = (typeof heading === 'number') ? heading : fromHeading;

    // 座標・角度がほぼ変わらなければ更新スキップ
    const deltaLat = toLat - fromLat;
    const deltaLng = toLng - fromLng;
    const deltaHeading = ((toHeading - fromHeading + 540) % 360) - 180;
    if (Math.abs(deltaLat) < 1e-6 && Math.abs(deltaLng) < 1e-6 && deltaHeading === 0) return;

    const duration = 400;
    const startTime = performance.now();

    function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const e = t * (2 - t); // easeOutQuad インライン化

        const curLat = fromLat + deltaLat * e;
        const curLng = fromLng + deltaLng * e;
        marker.setLatLng([curLat, curLng]);

        if (div) {
            const curHead = fromHeading + deltaHeading * e;
            div.style.transform = `rotate(${curHead}deg)`;
            div.style.background = accColor; // 色は毎フレーム反映
        }

        if (t < 1) {
            marker._animId = requestAnimationFrame(step);
        } else {
            marker._animId = null;
            marker._lastHeading = toHeading;
            marker._lastPos = marker.getLatLng();
        }
    }

    marker._animId = requestAnimationFrame(step);
}

function showMarkerLabelLeaflet(e, text) {
    // 既存ラベル削除
    if (currentLabel) {
        currentLabel.remove();
        currentLabel = null;
    }

    // Leaflet のマップ座標 → DOM 座標
    const point = map.mouseEventToContainerPoint(e.originalEvent);

    const label = document.createElement('div');
    label.textContent = text;
    label.style.position = 'absolute';
    label.style.background = 'rgba(0,0,0,0.7)';
    label.style.color = 'white';
    label.style.padding = '2px 5px';
    label.style.borderRadius = '4px';
    label.style.fontSize = '15px';
    label.style.pointerEvents = 'none';
    label.style.zIndex = 1000;

    label.style.left = (point.x + 20) + 'px';
    label.style.top = (point.y - 20) + 'px';

    document.body.appendChild(label);
    currentLabel = label;
}

// ===== 住所取得 =====
// --- 改良版 fetchAddress（キャッシュ・中断対応・距離制限付き） ---
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
            a.country,
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

// ===== ログ表示（バッチ化版） =====
let pendingLogs = [];
const MAX_LOG = 200;
// 1秒にまとめてDOMに反映
setInterval(() => {
    if (pendingLogs.length === 0) return;

    const logElem = document.getElementById('log');
    const fragment = document.createDocumentFragment();

    pendingLogs.forEach(e => {
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
    });

    // 新しいものを上に追加
    logElem.prepend(fragment);

    // 最大200件を維持（まとめて削除）
    while (logElem.childElementCount > MAX_LOG) {
        logElem.removeChild(logElem.lastChild);
    }

    pendingLogs = [];
    safeSaveLocal();
    updateStatsUI();
}, 1000);

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
document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const h = ['time,lat,lng,accuracy,speed_kmh,heading,address'];
    const rows = logData.map(e => `${JSON.stringify(e.time)},${e.lat},${e.lng},${e.accuracy},${parseFloat(e.speedKmh) || ''},${JSON.stringify(e.headingText)},${JSON.stringify(e.address)}`);
    download('location_log.csv', h.concat(rows).join('\n'));
});

// ===== 位置更新 =====
let lastRouteUpdate = 0;
let lastRoutePoint = null;
let lastAddressTime = 0;
const MIN_ACCURACY = 40; // 精度40m以上は無視
let firstPositionReceived = false; // 初回位置フラグ
const SMOOTHING_COUNT = 3; // 平滑化点数
let smoothBuffer = [];
let retryAccuracyThreshold = MIN_ACCURACY;
let lastGoodUpdate = null;
let lastGoodUpdateTime = 0;

async function handlePosition(pos) {
    if (!pos || !pos.coords) {
        updateMarker(null, null, 0, 'black', 0);
        return;
    }

    const c = pos.coords;
    const lat = c.latitude, lng = c.longitude, acc = c.accuracy || 0, alt = c.altitude;
    let speed = (c.speed >= 0) ? c.speed : null;
    const speedKmh = speed ? speed * 3.6 : 0;
    let heading = (typeof c.heading === 'number') ? c.heading : null;
    const nowTime = Date.now();

    let smoothed = [lat, lng];

    const lastSegment = pathSegments[pathSegments.length - 1];
    const prev = lastSegment ? lastSegment.slice(-1)[0] : null;
    const isFirst = !firstPositionReceived;
    if (isFirst) firstPositionReceived = true;

    // --- 外れ値除外（徒歩〜新幹線対応） ---
    if (lastGoodUpdate) {
        const dt = Math.max((pos.timestamp - lastGoodUpdateTime) / 1000, 0.1);
        const dist = haversine(lastGoodUpdate, [lat, lng]);
        const impliedSpeed = dist / dt;
        const MAX_REALISTIC_SPEED = 140; // ≒ 504 km/h

        if (impliedSpeed > MAX_REALISTIC_SPEED && acc > 50) {
            console.warn('外れ値検出: 異常速度', impliedSpeed.toFixed(1), 'm/s, 精度', acc);
            return;
        }
    }
    lastGoodUpdate = [lat, lng];
    lastGoodUpdateTime = pos.timestamp;

    // --- 精度チェック + 時間経過で更新 ---
    let accChanged = false;
    if (typeof lastAcc !== 'undefined' && acc !== lastAcc) accChanged = true;
    lastAcc = acc;

    if (!isFirst) {
        if (acc <= MIN_ACCURACY) {
            lastGoodUpdateTime = Date.now();
        } else if (acc > retryAccuracyThreshold) {
            if (Date.now() - lastGoodUpdateTime <= 5000 && !accChanged) return;
            console.warn('精度悪いが時間経過で更新:', acc);
        } else {
            if (!accChanged) return;
        }
    }

    const accColor = acc < 5 ? 'green' : acc < 15 ? 'yellowgreen' : acc < 30 ? 'orange' : 'red';
    yellowgreenrawPolylines();

    // --- 速度・方角補正 ---
    if (prev) {
        const dt = Math.max((pos.timestamp - lastPosTime) / 1000, 0.1);
        if (!speed) speed = haversine(prev, [lat, lng]) / dt;
        if ((heading === null || isNaN(heading)) && dt > 0) {
            heading = Math.atan2(lng - prev[1], lat - prev[0]) * 180 / Math.PI;
            if (heading < 0) heading += 360;
        }
    }
    if (lastOrientation !== null) heading = lastOrientation;
    heading = (heading === null || isNaN(heading)) ? 0 : heading;

    // --- UI更新 ---
    document.getElementById('lat').textContent = toFixedOrDash(lat, 6);
    document.getElementById('lng').textContent = toFixedOrDash(lng, 6);
    document.getElementById('acc').textContent = `${acc.toFixed(1)} m`;
    document.getElementById('alt').textContent = alt === null ? '---' : `${alt.toFixed(1)} m`;
    document.getElementById('speed').textContent = speed ? `${(speed * 3.6).toFixed(1)} km/h` : '---';
    document.getElementById('heading').textContent = directionName(heading);
    document.getElementById('acc').style.color = accColor;

    // --- 平滑化 + 低精度補正 ---
    if (isFirst || acc <= MIN_ACCURACY || (prev && haversine(prev, [lat, lng]) > 5)) {
        smoothBuffer.push([lat, lng]);
        if (smoothBuffer.length > SMOOTHING_COUNT) smoothBuffer.shift();

        smoothed = [
            smoothBuffer.reduce((s, p) => s + p[0], 0) / smoothBuffer.length,
            smoothBuffer.reduce((s, p) => s + p[1], 0) / smoothBuffer.length
        ];

        if (marker) {
            const prevMarkerPos = [marker.getLatLng().lat, marker.getLatLng().lng];
            const d = haversine(prevMarkerPos, smoothed);
            const speedMs = speed || 0;

            // --- 停止→再開検出 ---
            const timeSinceLast = (nowTime - lastPosTime) / 1000;
            const wasPaused = timeSinceLast > 3;

            if (wasPaused) {
                console.warn('再開検出: 即ジャンプで補正');
                smoothed = [lat, lng];
                smoothBuffer = [[lat, lng]];
            } else {
                // --- 通常補間 ---
                const MAX_STEP_BASE = Math.min(Math.max(5, acc / 2), 50);
                const MAX_STEP_SPEED_FACTOR = Math.min(1 + speedMs / 5, 10);
                const MAX_STEP = Math.min(MAX_STEP_BASE * MAX_STEP_SPEED_FACTOR, 500);

                if (d > MAX_STEP) {
                    const ratio = MAX_STEP / d;
                    smoothed = [
                        prevMarkerPos[0] + (smoothed[0] - prevMarkerPos[0]) * ratio,
                        prevMarkerPos[1] + (smoothed[1] - prevMarkerPos[1]) * ratio
                    ];
                }
            }
        }

        const smoothDist = prev ? haversine(prev, smoothed) : Infinity;
        const threshold = Math.max(1.5, acc / 2);

        if (!marker || !prev || smoothDist > threshold || isFirst) {
            let lastSegment = pathSegments[pathSegments.length - 1];
            if (!lastSegment || lastSegment.length === 0) {
                pathSegments.push([]);
                lastSegment = pathSegments[pathSegments.length - 1];
            }
            lastSegment.push(smoothed);
            yellowgreenrawPolylines();
            updateMarker(smoothed[0], smoothed[1], heading, accColor, speed);

            if (follow && map && !userInteracting) {
                programMoving = true;
                map.panTo(smoothed, { animate: true, duration: 0.3 });
                map.once('moveend', () => programMoving = false);
            }

            if (isFirst && map) map.setView(smoothed, 17);
        }
    }

    // --- 住所更新 ---
    const currentAddrElem = document.getElementById('currentAddress');
    if (nowTime - lastAddressTime > 1000) {
        const addrLat = lat, addrLng = lng;
        fetchAddress(addrLat, addrLng).then(addr => {
            if (lat === addrLat && lng === addrLng) currentAddrElem.textContent = addr;
        });
        lastAddressTime = nowTime;
    }

    // --- ログ追加 ---
    addLogEntry({
        time: new Date().toISOString(),
        lat, lng, accuracy: acc, altitude: alt,
        speedKmh: speed ? speed * 3.6 : null,
        speedText: speed ? `${(speed * 3.6).toFixed(1)} km/h` : '---',
        headingText: directionName(heading),
        address: currentAddrElem.textContent
    });

    // --- ナビ中（オートリルート無効＋ETA＆追従対応） ---
    const current = [lat, lng];
    if (routingControl && currentDestination) {
        // --- 目的地までの距離・時間をリアルタイム更新 ---
        const distToDest = haversine(current, [currentDestination.lat, currentDestination.lng]);
        if (speed && speed > 0) {
            const timeSec = distToDest / speed;
            const hours = Math.floor(timeSec / 3600);
            const minutes = Math.round((timeSec % 3600) / 60);
            let timeText = '';
            if (hours > 0) timeText += `${hours}時間`;
            timeText += `${minutes}分`;
            document.getElementById('eta').textContent =
                `${(distToDest / 1000).toFixed(2)} km / 約 ${timeText}`;
        } else {
            document.getElementById('eta').textContent =
                `${(distToDest / 1000).toFixed(2)} km / ---`;
        }

        // --- スタートマーカー追従（Routing Machine内部をリアルタイム更新） ---
        try {
            const plan = routingControl.getPlan();
            if (plan && plan._waypoints && plan._waypoints[0]) {
                plan._waypoints[0].latLng = L.latLng(smoothed[0], smoothed[1]);
                plan._updateMarkers(); // 内部マーカーを再描画
            }
        } catch (err) {
            console.warn('スタートマーカー追従エラー:', err);
        }
    }

    lastPosTime = pos.timestamp || now();
    document.getElementById('lastAge').textContent = '0秒前';
}

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
async function startTracking() {
    if (!navigator.geolocation) {
        alert('位置情報未対応');
        return;
    }

    // 初回取得（低精度で即時表示）
    navigator.geolocation.getCurrentPosition(
        pos => {
            retryAccuracyThreshold = MIN_ACCURACY; // 成功したら閾値リセット
            handlePosition(pos);
        },
        err => handleError(err),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 5000 }
    );

    // 継続追跡（高精度）
    watchId = navigator.geolocation.watchPosition(
        pos => {
            // 成功したらリトライ精度閾値リセット
            retryAccuracyThreshold = MIN_ACCURACY;
            handlePosition(pos);
        },
        err => handleError(err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
}

// ===== 更新時間表示 =====
setInterval(() => {
    if (lastPosTime) {
        const deltaSec = Math.floor((now() - lastPosTime) / 1000);
        const h = Math.floor(deltaSec / 3600), m = Math.floor((deltaSec % 3600) / 60), s = deltaSec % 60;
        let text = '';
        if (h > 0) text += `${h}時間`;
        if (m > 0 || h > 0) text += `${m}分`;
        text += `${s}秒前`;
        document.getElementById('lastAge').textContent = text;
    }
}, 1000);

// ===== DeviceOrientation =====
async function setupDeviceOrientation() {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const btn = document.createElement('button');
        btn.textContent = 'コンパス許可';
        btn.className = 'warning';
        btn.style.margin = '6px';
        document.querySelector('.panel').appendChild(btn);
        btn.addEventListener('click', async () => {
            const perm = await DeviceOrientationEvent.requestPermission();
            if (perm === 'granted') { window.addEventListener('deviceorientationabsolute', onDeviceOrientation); btn.remove(); } else alert('拒否');
        });
    } else if (window.DeviceOrientationEvent) window.addEventListener('deviceorientationabsolute', onDeviceOrientation);
}
function onDeviceOrientation(e) {
    if (e && typeof e.alpha === 'number') {
        lastOrientation = (360 - e.alpha) % 360;
        document.getElementById('heading').textContent = directionName(lastOrientation);
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
    yellowgreenrawPolylines();
    setupDeviceOrientation();
    startTracking();

    const navModeBtn = document.getElementById("navModeBtn");

    // ナビモード切替
    navModeBtn.addEventListener("click", () => {
        navMode = !navMode;
        navModeBtn.textContent = navMode ? "地図クリックで目的地を選択中…" : "ナビ開始(車のみ)";
    });

    // ===== アニメーション用ポリライン管理 =====
    let animatedPolylines = []; // {polyline, route}
    let routingControl = null;
    let currentDestination = null;

    // ===== スムーズアニメーション関数 =====
    function animateRouteSmooth(latlngs, color = "#1976d2", weight = 7, duration = 2000) {
        if (!latlngs || latlngs.length < 2) return;

        // ---- 軽量化：5〜10mごとにサンプリング ----
        const simplified = [latlngs[0]];
        for (let i = 1; i < latlngs.length; i++) {
            const prev = simplified[simplified.length - 1];
            const dist = map.distance(prev, latlngs[i]);
            if (dist > 8) simplified.push(latlngs[i]); // ← 距離を短めに
        }
        simplified.push(latlngs[latlngs.length - 1]);

        // ---- 線を追加 ----
        const polyline = L.polyline([simplified[0]], { color, weight, opacity: 1 }).addTo(map);

        // 総距離
        let totalDist = 0;
        const segDist = [];
        for (let i = 0; i < simplified.length - 1; i++) {
            const d = map.distance(simplified[i], simplified[i + 1]);
            segDist.push(d);
            totalDist += d;
        }

        let startTime = null;

        function step(ts) {
            if (!startTime) startTime = ts;
            const elapsed = ts - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const targetDist = totalDist * progress;

            // 現在までの距離に応じてどこまで描くか計算
            let traveled = 0;
            const points = [simplified[0]];

            for (let i = 0; i < segDist.length; i++) {
                if (traveled + segDist[i] >= targetDist) {
                    // 区間内の補間
                    const remain = targetDist - traveled;
                    const ratio = remain / segDist[i];
                    const a = simplified[i], b = simplified[i + 1];
                    const interp = L.latLng(
                        a.lat + (b.lat - a.lat) * ratio,
                        a.lng + (b.lng - a.lng) * ratio
                    );
                    points.push(interp);
                    break;
                } else {
                    points.push(simplified[i + 1]);
                    traveled += segDist[i];
                }
            }

            polyline.setLatLngs(points);
            if (progress < 1) requestAnimationFrame(step);
        }

        requestAnimationFrame(step);
        return polyline;
    }

    // ===== ETA更新関数 =====
    function updateEta(route) {
        if (!route || !route.summary) return;
        const summary = route.summary;
        if (!summary.totalDistance || !summary.totalTime) return;
        const distKm = (summary.totalDistance / 1000).toFixed(2);
        let totalSec = summary.totalTime;
        const hours = Math.floor(totalSec / 3600);
        const minutes = Math.round((totalSec % 3600) / 60);
        let timeText = '';
        if (hours > 0) timeText += `${hours}時間`;
        timeText += `${minutes}分`;
        document.getElementById("eta").textContent = `${distKm} km / 約 ${timeText}`;
    }

    // ===== マップクリックで目的地選択 =====
    map.on("click", async e => {
        if (!navMode) return;
        if (!marker) {
            alert("現在地を取得中です。位置が確定したらもう一度クリックしてください。");
            return;
        }

        currentDestination = e.latlng;
        userSelectedRoute = false;

        // 目的地住所更新
        const destAddr = await fetchAddress(currentDestination.lat, currentDestination.lng);
        document.getElementById("destAddress").textContent = destAddr;

        const start = marker.getLatLng();
        const dest = currentDestination;

        // 既存ルート削除
        if (routingControl) map.removeControl(routingControl);
        animatedPolylines.forEach(p => map.removeLayer(p.polyline || p));
        animatedPolylines = [];

        // ルート作成（透明でアニメーション）
        routingControl = L.Routing.control({
            waypoints: [start, dest],
            routeWhileDragging: false,
            addWaypoints: false,
            draggableWaypoints: false,
            showAlternatives: true,
            fitSelectedRoutes: false,
            language: "en",
            lineOptions: { styles: [{ color: "transparent", weight: 0, opacity: 0 }] },
            altLineOptions: { styles: [{ color: "transparent", weight: 0, opacity: 0 }] },
            createMarker: (i, wp) => {
                const size = 20;
                const color = i === 0 ? "#00BCD4" : "#800080";
                const m = L.marker(wp.latLng, {
                    icon: L.divIcon({
                        className: 'custom-marker',
                        html: `<div style="width:${size}px;height:${size}px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 0 5px rgba(0,0,0,0.3);"></div>`,
                        iconSize: [size, size],
                        iconAnchor: [size / 2, size / 2]
                    })
                });
                m.on("click", e => {
                    showMarkerLabelLeaflet(e, "現在地");
                });
                if (i === 1) m.on('click', () => map.flyTo(m.getLatLng(), 17));
                return m;
            },
            position: 'bottomright'
        })
            .on("routingstart", () => {
                // 手動操作・追尾移動中は無視
                if (userInteracting || programMoving) return;
                const etaElem = document.getElementById("eta");
                // 既に計算結果が表示されている場合は維持
                if (etaElem.textContent && etaElem.textContent !== "---" && !etaElem.textContent.includes("計算中")) return;
                etaElem.textContent = "計算中...";
            })
            .on("routesfound", e => {
                e.routes.forEach(route => translateInstructions(route));
                updateEta(e.routes[0]);
                // 各ルートのアニメーション & クリックでETA更新＆選択色
                e.routes.forEach((route, idx) => {
                    const color = idx === 0 ? "#1976d2" : "#f44336";
                    const weight = idx === 0 ? 8 : 4;
                    const animLine = animateRouteSmooth(route.coordinates, color, weight, 1500);
                    // プラットフォーム判定（iPhone 向けにヒット幅を大きめに）
                    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
                    const touchHitWeight = isIOS ? 31 : 31; // iPhone はさらに広く
                    // 透明クリック用ライン（タッチ領域を拡大）
                    const clickLine = L.polyline(route.coordinates, {
                        color: color,
                        weight: touchHitWeight,
                        opacity: 0.02,      // 完全透明は拾わない場合があるのでごく薄く
                        interactive: true,
                    }).addTo(map);
                    // 保険：要素が取れたら直接 style/属性を設定して確実に当たり判定を広げる
                    setTimeout(() => {
                        try {
                            const el = clickLine.getElement && clickLine.getElement();
                            if (el) {
                                // SVG path の strokeWidth 等を上書き（Leaflet がつけた属性より確実に効く）
                                el.style.pointerEvents = 'stroke';
                                el.style.cursor = 'pointer';
                                el.style.strokeLinecap = 'round';
                                el.style.strokeWidth = (touchHitWeight) + 'px';
                                // iOS では opacity を微小値にしておく（表示上はほぼ透明）
                                el.style.opacity = 0.02;
                                // さらに属性としても設定（ブラウザ差対策）
                                el.setAttribute('stroke-linecap', 'round');
                                el.setAttribute('stroke-width', String(touchHitWeight));
                            }
                        } catch (e) { /* ignore */ }
                    }, 0);
                    // 選択処理（タッチ / クリック の両方に対応）
                    const onSelect = (ev) => {
                        updateEta(route);
                        userSelectedRoute = true;
                        // 選択色反映（選択中：青、他：赤）
                        try {
                            animatedPolylines.forEach(p => {
                                if (p.polyline && p.route) {
                                    if (p.route === route) p.polyline.setStyle({ color: "#1976d2", weight: 8 });
                                    else p.polyline.setStyle({ color: "#f44336", weight: 4 });
                                }
                            });
                        } catch (err) {
                            console.warn('route style update error', err);
                        }
                        if (ev && ev.originalEvent && ev.originalEvent.stopPropagation) ev.originalEvent.stopPropagation();
                    };
                    // pointerdown / touchstart / click を登録（幅広くカバー）
                    clickLine.on('pointerdown touchstart click', onSelect);
                    // 任意：ホバー/タッチで少し見せるフィードバック（必要なら）
                    clickLine.on('mouseover', () => clickLine.setStyle({ opacity: 0.12 }));
                    clickLine.on('mouseout', () => clickLine.setStyle({ opacity: 0.02 }));
                    // 元と同じ形式で配列に格納（構造は変えない）
                    animatedPolylines.push({ polyline: animLine, route });
                    animatedPolylines.push({ polyline: clickLine, route });
                });

                // ルートパネル日本語化
                setTimeout(() => {
                    document.querySelectorAll('.leaflet-routing-instruction').forEach(el => {
                        let text = el.textContent;
                        Object.entries(instructionMap)
                            .sort((a, b) => b[0].length - a[0].length)
                            .forEach(([en, ja]) => { text = text.replace(new RegExp(`\\b${en}\\b`, 'gi'), ja); });
                        el.textContent = text;
                    });
                }, 100);
            })
            .on("routeselected", e => {
                translateInstructions(e.route);
                updateEta(e.route);
                userSelectedRoute = true;

                // 選択色反映（選択中：青、他：赤）
                animatedPolylines.forEach(p => {
                    if (p.route === e.route) p.polyline.setStyle({ color: "#1976d2", weight: 7 });
                    else p.polyline.setStyle({ color: "#f44336", weight: 5 });
                });

                setTimeout(() => {
                    document.querySelectorAll('.leaflet-routing-instruction').forEach(el => {
                        let text = el.textContent;
                        Object.entries(instructionMap)
                            .sort((a, b) => b[0].length - a[0].length)
                            .forEach(([en, ja]) => { text = text.replace(new RegExp(`\\b${en}\\b`, 'gi'), ja); });
                        el.textContent = text;
                    });
                }, 100);
            })
            .on("routingerror", () => {
                document.getElementById("eta").textContent = "経路取得失敗";
            })
            .addTo(map);
        const container = routingControl.getContainer();
        container.style.zIndex = "998";
        let closeBtn = document.querySelector('.leaflet-routing-close');
        if (!closeBtn) {
            closeBtn = document.createElement('a');
            closeBtn.className = 'leaflet-routing-close';
            closeBtn.style.cssText = `
        position:absolute;
        bottom:12.5px;
        right:20px;
        padding:6px 16px;
        height:20px;
        background-color:darkgray;
        font-size:16px;
        font-weight:500;
        color:#333;
        border:1.5px solid gray;
        border-radius:8px;
        box-shadow:0 2px 6px rgba(0,0,0,0.2);
        cursor:pointer;
        z-index:999;
        pointer-events:auto;`;
            closeBtn.onclick = () => {
                const container = routingControl.getContainer();
                container.style.display = container.style.display === 'none' ? 'block' : 'none';
            };
            document.getElementById('map').appendChild(closeBtn);
        }
        navMode = false;
        navModeBtn.textContent = "ナビ開始(車のみ)";
    });

    // ===== ナビキャンセル =====
    cancelNavBtn.addEventListener("click", async () => {
        if (routingControl) {
            map.removeControl(routingControl);
            routingControl = null;
        }
        animatedPolylines.forEach(p => map.removeLayer(p.polyline || p));
        animatedPolylines = [];

        navMode = false;
        navModeBtn.textContent = "ナビ開始(車のみ)";
        currentDestination = null;
        userSelectedRoute = false;

        const closeBtn = document.querySelector('.leaflet-routing-close');
        if (closeBtn) closeBtn.remove();

        if (marker) {
            const currentLatLng = marker.getLatLng();
            const address = await fetchAddress(currentLatLng.lat, currentLatLng.lng);
            document.getElementById("currentAddress").textContent = address;
        }

        const destElem = document.getElementById("destAddress");
        if (destElem) destElem.textContent = "---";
        const etaContainer = document.getElementById("eta");
        if (etaContainer) etaContainer.textContent = "---";
    });
});


// ===== 操作ボタン =====
document.getElementById('stopBtn').addEventListener('click', () => {
    if (watchId) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;

        // 平滑化バッファをクリア（再開時に古い位置に引きずられないようにする）
        smoothBuffer = [];
    }
});

document.getElementById('restartBtn').addEventListener('click', () => {
    if (!watchId) {
        // 平滑化バッファをクリアして再開（念のため）
        smoothBuffer = [];
        startTracking();
    }
});

document.getElementById('clearBtn').addEventListener('click', () => { if (confirm('本当にクリアしますか？')) { pathSegments = [[]]; logData = []; yellowgreenrawPolylines(); document.getElementById('log').innerHTML = ''; safeSaveLocal(); updateStatsUI(); } });
document.getElementById('centerToggle').addEventListener('click', async () => {
    follow = !follow;
    document.getElementById('centerToggle').textContent = `自動追尾: ${follow ? 'ON' : 'OFF'}`;

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
        document.getElementById('currentAddress').textContent = addr;

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
    const stopBtn = document.getElementById('stopBtn');
    const restartBtn = document.getElementById('restartBtn');
    if (stopBtn.classList.contains('btn-pointer-none')) {
        stopBtn.classList.remove('btn-pointer-none');
        restartBtn.classList.add('btn-pointer-none');
    } else {
        stopBtn.classList.add('btn-pointer-none');
        restartBtn.classList.remove('btn-pointer-none');
    }
}
