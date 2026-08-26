// ======== 時計の更新 ========
function updateClock() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    document.getElementById('clock').textContent =
        `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
setInterval(updateClock, 1000);
updateClock();

// ======== 震度カラーマッピング ========
const scaleMap = {
    10: { text: "1", color: "#4682B4" },
    20: { text: "2", color: "#00FF7F" },
    30: { text: "3", color: "#FFFF00", textColor: "#000" },
    40: { text: "4", color: "#FF1493" },
    45: { text: "5弱", color: "#FF8C00" },
    50: { text: "5強", color: "#FF0000" },
    55: { text: "6弱", color: "#A52A2A" },
    60: { text: "6強", color: "#800080" },
    70: { text: "7", color: "#9400D3" }
};

function getScaleInfo(scale) {
    return scaleMap[scale] || { text: "-", color: "#333" };
}

// ======== マップ初期化 (Leaflet.js) ========
const map = L.map('map').setView([36.2048, 138.2529], 5);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
}).addTo(map);

// 【改善】ウィンドウサイズ変更時にマップの描画サイズを再計算させる
window.addEventListener('resize', () => {
    map.invalidateSize();
});

let currentMarker = null;
const stationMarkers = L.layerGroup().addTo(map);
let stationMap = new Map();

let prefGeoJsonLayer = null; // 都道府県境界レイヤー
let prefData = null;        // 読み込んだGeoJSONデータ

// 都道府県のGeoJSONを読み込む関数
async function loadPrefectures() {
    try {
        const res = await fetch('prefectures.geojson'); // 都道府県境界のGeoJSONファイル
        prefData = await res.json();

        prefGeoJsonLayer = L.geoJSON(prefData, {
            style: {
                color: '#30363d',     // 境界線の色
                weight: 1,            // 境界線の太さ
                fillColor: '#161b22', // 通常時の塗りつぶし色
                fillOpacity: 0.05     // 【改善】初期状態はほとんど透明にして目立たなくする
            }
        }).addTo(map);
        console.log("都道府県GeoJSONを読み込みました。");
    } catch (e) {
        console.error("都道府県GeoJSONの読み込みに失敗しました", e);
    }
}

async function loadStations() {
    try {
        const res = await fetch('stations.json');
        const data = await res.json();
        data.forEach(st => {
            const lat = parseFloat(st.lat);
            const lon = parseFloat(st.lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                // 【修正】st.pref がオブジェクトの場合に備えて .name から文字列を取り出す
                const pref = (typeof st.pref === 'object' && st.pref !== null) ? st.pref.name : st.pref;

                // 観測点名（詳細な地域名）でマッピング
                if (!stationMap.has(st.name)) {
                    stationMap.set(st.name, { lat, lon, pref }); // pref を含めて保存
                }
                // 市町村名でもマッピング
                if (st.city && st.city.name && !stationMap.has(st.city.name)) {
                    stationMap.set(st.city.name, { lat, lon, pref }); // pref を含めて保存
                }
            }
        });
        console.log("観測点データ (stations.json) を読み込みました。");
    } catch (e) {
        console.error("stations.jsonの読み込みに失敗しました", e);
    }
}

// 【改善後】
let pWaveCircle = null;
let sWaveCircle = null;
let waveAnimationId = null;

function updateMap(lat, lng, scaleInfo, originTimeStr, isRealtime = false) {
    if (!lat || !lng || lat === -200 || lng === -200) return;

    if (currentMarker) map.removeLayer(currentMarker);
    if (pWaveCircle) map.removeLayer(pWaveCircle);
    if (sWaveCircle) map.removeLayer(sWaveCircle);
    if (waveAnimationId) cancelAnimationFrame(waveAnimationId);

    const pos = [lat, lng];
    const epicenterIcon = L.divIcon({
        className: 'epicenter-icon',
        html: '✕',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });

    currentMarker = L.marker(pos, { icon: epicenterIcon }).addTo(map);
    currentMarker.bindTooltip(`震源地 (最大震度${scaleInfo.text})`);

    // 【修正】リアルタイムの時だけP波・S波を描画する
    if (isRealtime) {
        pWaveCircle = L.circle(pos, { color: '#00bfff', weight: 1.5, fillOpacity: 0.1, radius: 0 }).addTo(map);
        sWaveCircle = L.circle(pos, { color: '#ff4d4d', weight: 2, fillOpacity: 0.2, radius: 0 }).addTo(map);

        const originTime = originTimeStr ? new Date(originTimeStr).getTime() : Date.now();

        function animateWaves() {
            const elapsedSec = (Date.now() - originTime) / 1000;
            if (elapsedSec > 0 && elapsedSec < 180) {
                const pRadius = elapsedSec * 6500;
                const sRadius = elapsedSec * 3500;

                pWaveCircle.setRadius(pRadius);
                sWaveCircle.setRadius(sRadius);
                waveAnimationId = requestAnimationFrame(animateWaves);
            } else if (elapsedSec >= 180) {
                cancelAnimationFrame(waveAnimationId);
                if (pWaveCircle) map.removeLayer(pWaveCircle);
                if (sWaveCircle) map.removeLayer(sWaveCircle);
            }
        }
        animateWaves();
    }
}

// ======== 画面更新ロジック ========
function updateLatest(data, isRealtime = false) {
    const eq = data.earthquake;
    if (!eq) return;

    const issueMap = {
        "ScalePrompt": "震度速報", "Destination": "震源に関する情報",
        "ScaleAndDestination": "震源・震度情報", "DetailScale": "各地の震度に関する情報",
        "Foreign": "遠地地震に関する情報", "Other": "地震情報"
    };
    const issueType = data.issue ? issueMap[data.issue.type] || "地震情報" : "地震情報";

    const headerEl = document.querySelector('.latest-panel .panel-header');
    if (headerEl) headerEl.textContent = `詳細情報 (${issueType})`;

    const scaleInfo = getScaleInfo(eq.maxScale);
    document.getElementById('latest-scale').textContent = scaleInfo.text;
    document.getElementById('latest-scale-box').style.backgroundColor = scaleInfo.color;
    document.getElementById('latest-time').textContent = eq.time || "不明";
    document.getElementById('latest-name').textContent = eq.hypocenter?.name || "調査中";

    const depth = eq.hypocenter?.depth;
    let depthText = "不明";
    if (depth === 0) depthText = "ごく浅い";
    else if (typeof depth === 'number' && depth > 0) depthText = `${depth} km`;
    document.getElementById('latest-depth').textContent = depthText;

    const mag = eq.hypocenter?.magnitude;
    document.getElementById('latest-mag').textContent = mag === -1 ? "-" : (mag ? mag.toFixed(1) : "-");

    // 【修正】フラグを updateMap に渡し、アラートも条件付きにする
    updateMap(eq.hypocenter?.latitude, eq.hypocenter?.longitude, scaleInfo, eq.time, isRealtime);
    if (isRealtime) {
        checkAndNotifyScale(eq);
    }

    // 描画範囲を収めるための座標保持配列
    const boundsPoints = [];

    // 震源地座標が存在する場合は判定対象に登録
    if (eq.hypocenter?.latitude && eq.hypocenter?.longitude && eq.hypocenter.latitude !== -200 && eq.hypocenter.longitude !== -200) {
        boundsPoints.push([eq.hypocenter.latitude, eq.hypocenter.longitude]);
    }

    // 各地の震度プロットと座標集計 ＋ 都道府県の最大震度を集計
    stationMarkers.clearLayers();

    // ① 都道府県ごとの最大震度を保持するマップ
    const prefMaxScaleMap = new Map();

    if (data.points && Array.isArray(data.points)) {
        data.points.forEach(point => {
            const st = stationMap.get(point.addr);
            if (st) {
                // ② 観測点データから都道府県名を取得して最大震度を算出
                // ※stに都道府県名が入っているプロパティ名（例: st.pref）に合わせて変更してください
                const prefName = st.pref;
                if (prefName) {
                    const currentMax = prefMaxScaleMap.get(prefName) || -1;
                    if (point.scale > currentMax) {
                        prefMaxScaleMap.set(prefName, point.scale);
                    }
                }

                // 従来通りのマーカー生成処理
                const pScaleInfo = getScaleInfo(point.scale);
                const textColor = pScaleInfo.textColor || "#fff";

                const scaleIcon = L.divIcon({
                    className: 'station-scale-icon',
                    html: `<div style="background-color: ${pScaleInfo.color}; color: ${textColor};">${pScaleInfo.text}</div>`,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10]
                });

                const marker = L.marker([st.lat, st.lon], { icon: scaleIcon });
                marker.bindTooltip(`${point.addr} (震度${pScaleInfo.text})`);
                stationMarkers.addLayer(marker);

                // 観測点の座標をバウンディングボックス用に追加
                boundsPoints.push([st.lat, st.lon]);
            }
        });
    }
    console.log("prefMaxScaleMapの中身:", prefMaxScaleMap);
    // ③ 都道府県の境界線（GeoJSON）の色を震度に合わせて変更
    if (typeof prefGeoJsonLayer !== 'undefined' && prefGeoJsonLayer) {
        prefGeoJsonLayer.eachLayer(layer => {
            const prefName = layer.feature.properties.name;
            const scale = prefMaxScaleMap.get(prefName);

            if (scale !== undefined) {
                const scaleInfo = getScaleInfo(scale);
                // 【改善】地震が発生し揺れが観測された都道府県に「強めのハイライト」をかける
                layer.setStyle({
                    fillColor: '#161b22',
                    fillOpacity: 0.0,       // 不透明度を高くして色をハッキリさせる
                    color: '#ffffff',       // 境界線を真っ白にする
                    weight: 2.0             // 境界線を太くして目立たせる
                });
            } else {
                // 【改善】揺れが観測されなかった都道府県はハイライトを消す（目立たなくする）
                layer.setStyle({
                    fillColor: '#161b22',
                    fillOpacity: 0.0,       // 塗りつぶしをなくす
                    color: '#21262d',       // 境界線も暗くする
                    weight: 0.5
                });
            }
        });
    }

    // 震源地＋観測点全体が収まるように表示範囲を自動調整
    if (boundsPoints.length > 1) {
        map.fitBounds(L.latLngBounds(boundsPoints), { padding: [40, 40], maxZoom: 10 });
    } else if (boundsPoints.length === 1) {
        map.setView(boundsPoints[0], 7, { animate: true });
    }

    // 【改善】データ更新・表示切り替え直後にマップの描画サイズを強制再計算する
    setTimeout(() => {
        map.invalidateSize();
    }, 100);

    const tsunamiMap = {
        "None": "この地震による津波の心配はありません。",
        "Unknown": "津波の影響は不明です。",
        "Checking": "津波の影響を調査中です。",
        "NonEffective": "若干の海面変動が予想されますが、被害の心配はありません。",
        "Watch": "津波注意報が発表されています。",
        "Warning": "津波警報が発表されています。"
    };

    const tsunamiText = tsunamiMap[eq.domesticTsunami] || "情報なし";
    const tsunamiEl = document.getElementById('latest-tsunami');
    tsunamiEl.textContent = tsunamiText;

    if (["Watch", "Warning"].includes(eq.domesticTsunami)) {
        tsunamiEl.style.color = "#ff4d4d";
        tsunamiEl.style.fontWeight = "bold";
    } else {
        tsunamiEl.style.color = "";
    }
}

function createHistoryElement(data) {
    const eq = data.earthquake;
    if (!eq || eq.maxScale === undefined || eq.maxScale < 10) return null;
    const scaleInfo = getScaleInfo(eq.maxScale);
    const magText = (eq.hypocenter?.magnitude && eq.hypocenter.magnitude !== -1)
        ? eq.hypocenter.magnitude.toFixed(1) : "-";

    const li = document.createElement('li');
    li.className = 'history-item';

    const scaleDiv = document.createElement('div');
    scaleDiv.className = 'hist-scale';
    scaleDiv.style.backgroundColor = scaleInfo.color;
    if (scaleInfo.textColor) scaleDiv.style.color = scaleInfo.textColor;
    scaleDiv.textContent = scaleInfo.text;

    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'hist-details';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'hist-name';
    nameDiv.textContent = eq.hypocenter?.name || "調査中";

    const timeDiv = document.createElement('div');
    timeDiv.className = 'hist-time';
    timeDiv.textContent = eq.time || "不明";

    detailsDiv.append(nameDiv, timeDiv);

    const magDiv = document.createElement('div');
    magDiv.className = 'hist-mag';
    magDiv.textContent = `M ${magText}`;

    li.append(scaleDiv, detailsDiv, magDiv);

    // 【修正】クリック時にハイライト処理を追加（isRealtimeはデフォルトのfalseが適用されます）
    li.addEventListener('click', (e) => {
        document.querySelectorAll('.history-item').forEach(item => item.classList.remove('active'));
        e.currentTarget.classList.add('active');
        updateLatest(data);
    });

    return li;
}

// ======== API連携 ========
async function fetchHistory() {
    try {
        const res = await fetch('https://api.p2pquake.net/v2/history?codes=551&limit=15');
        const json = await res.json();

        if (json.length > 0) {
            // 【修正】履歴の中から、遠地地震（Foreign）ではない「国内の最新の地震」を自動で探す
            // 見つからない場合は、念のため json[0] を使う
            const domesticLatest = json.find(data => data.issue?.type !== "Foreign") || json[0];

            // 見つかった国内の最新情報を初期表示に設定
            updateLatest(domesticLatest);

            const list = document.getElementById('history-list');
            list.innerHTML = '';
            json.forEach(data => {
                const el = createHistoryElement(data);
                if (el) list.appendChild(el);
            });
        }
    } catch (e) {
        console.error("履歴の取得に失敗しました", e);
    }
}



// ======== 改善後のコード ========
let wsReconnectDelay = 15000; // 初期リトライを15秒
const maxReconnectDelay = 300000; // 最大5分に延長
let ws = null; // 現在の接続インスタンスを保持
let reconnectTimer = null; // 再接続用のタイマーを保持

// 【追加】接続状態をUI（文字とパルス色）に反映する関数
function updateConnectionStatus(statusText, pulseClass) {
    const pulse = document.getElementById('connection-pulse');
    const textEl = document.getElementById('connection-status');

    if (pulse) {
        pulse.className = `pulse ${pulseClass}`;
    }
    if (textEl) {
        textEl.textContent = statusText;
        if (pulseClass === 'connected') {
            textEl.style.color = '#3fb950';
        } else if (pulseClass === 'reconnecting') {
            textEl.style.color = '#d29922';
        } else {
            textEl.style.color = '#ff4d4d';
        }
    }
}

function connectWebSocket() {
    if (ws) {
        ws.onclose = null;
        ws.close();
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // 接続試行中のステータスを表示
    updateConnectionStatus("接続中...", "reconnecting");

    ws = new WebSocket('wss://api.p2pquake.net/v2/ws');

    ws.onopen = () => {
        console.log("リアルタイム接続を開始しました。");
        wsReconnectDelay = 15000;
        // 接続成功時は緑色＆「リアルタイム接続中」に変更
        updateConnectionStatus("リアルタイム接続中", "connected");
    };

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (!data.code) return;
        if (data.code === 551) {
            updateLatest(data, true);
            const list = document.getElementById('history-list');
            const el = createHistoryElement(data);
            if (el) {
                list.insertBefore(el, list.firstChild);
                if (list.children.length > 15) list.removeChild(list.lastChild);
            }
        }
        if (data.code === 552) handleTsunamiAlert(data);
        if (data.code === 556) handleEEWAlert(data);
    };

    ws.onclose = (e) => {
        const waitSec = Math.round(wsReconnectDelay / 1000);
        console.log(`切断されました。(コード: ${e.code}) ${waitSec}秒後に再接続します...`);
        // 切断時はオレンジ色＆カウントダウン表示
        updateConnectionStatus(`切断 (${waitSec}秒後に再接続)`, "reconnecting");

        reconnectTimer = setTimeout(connectWebSocket, wsReconnectDelay);
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, maxReconnectDelay);
    };

    ws.onerror = (err) => {
        console.error("WebSocketエラーが発生しました。");
        // エラー時は赤色表示
        updateConnectionStatus("接続エラー", "disconnected");
    };
}

window.addEventListener('online', () => {
    console.log("ネットワーク接続が復旧しました。直ちにWebSocketを再接続します。");
    updateConnectionStatus("ネットワーク復旧・再接続中", "reconnecting");
    wsReconnectDelay = 15000;
    connectWebSocket();
});

window.addEventListener('offline', () => {
    console.log("ネットワーク接続が切れました。WebSocketを待機状態にします。");
    // オフライン時は赤色＆オフライン表示
    updateConnectionStatus("オフライン（切断中）", "disconnected");
    if (ws) {
        ws.onclose = null;
        ws.close();
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
});

// 【新機能】stations.jsonをロードしてから履歴・WebSocketの取得を開始する
Promise.all([loadStations(), loadPrefectures()]).then(() => {
    fetchHistory();
    connectWebSocket();
});

// ======== 音声（警告音）を生成する関数 (Web Audio API) ========
let audioCtx = null;

function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// ブラウザの制限対策：最初に画面のどこかを触った時に、音声機能だけを準備（音は鳴らさない）
window.addEventListener('pointerdown', initAudio, { once: true });

function playAlertSound() {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }

        for (let i = 0; i < 8; i++) {
            const startTime = audioCtx.currentTime + (i * 0.5);

            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();

            osc.type = 'square';
            osc.frequency.value = 940;
            gain.gain.value = 0.1;

            osc.connect(gain).connect(audioCtx.destination);

            osc.start(startTime);
            osc.stop(startTime + 0.3);
        }
    } catch (e) {
        console.error("音声の再生に失敗しました", e);
    }
}

// ======== アラートバナーを表示する関数 ========
// 【改善後】
// アラートの消去・リセット機能
function hideAlertBanner() {
    const banner = document.getElementById('alert-banner');
    banner.classList.add('hidden');
    banner.className = 'alert-banner hidden'; // クラスリセット
    document.querySelectorAll('.panel').forEach(panel => {
        panel.classList.remove('emergency-active');
    });
}

// レベル別アラート表示 (level: 'info' | 'warning' | 'emergency')
let alertTimeoutId = null;

function showAlertBanner(title, message, level = 'info') {
    hideAlertBanner(); // 状態リセット
    // 既存のタイマーがあればリセット
    if (alertTimeoutId) {
        clearTimeout(alertTimeoutId);
        alertTimeoutId = null;
    }

    const banner = document.getElementById('alert-banner');
    document.getElementById('alert-title').textContent = title;
    document.getElementById('alert-message').textContent = message;

    banner.classList.remove('hidden');
    banner.classList.add(`alert-${level}`);

    if (level === 'emergency') {
        document.querySelectorAll('.panel').forEach(panel => panel.classList.add('emergency-active'));
        playAlertSound();
        // 緊急時は30秒後に自動消去
        alertTimeoutId = setTimeout(hideAlertBanner, 30000);
    } else if (level === 'warning') {
        // 注意報は15秒後に自動消去
        alertTimeoutId = setTimeout(hideAlertBanner, 15000);
    } else {
        // 情報は10秒後に自動消去
        alertTimeoutId = setTimeout(hideAlertBanner, 10000);
    }
}

// バナークリックで通知を閉じる
document.getElementById('alert-banner').addEventListener('click', hideAlertBanner);

// 地震情報受信時の判定追加 (updateLatest 内で呼び出し)
function checkAndNotifyScale(eq) {
    const maxScale = eq.maxScale;
    const name = eq.hypocenter?.name || "未知の地域";

    if (maxScale >= 40) {
        showAlertBanner("【地震警報】", `${name}で最大震度${getScaleInfo(maxScale).text}の強い揺れ`, 'emergency');
    } else if (maxScale >= 20) {
        showAlertBanner("【地震注意】", `${name}で震度${getScaleInfo(maxScale).text}を観測`, 'warning');
    } else if (maxScale >= 10) {
        showAlertBanner("【地震情報】", `${name}で微震（震度${getScaleInfo(maxScale).text}）を観測`, 'info');
    }
}

// ======== 津波予報の処理 (code: 552) ========
function handleTsunamiAlert(data) {
    console.log("津波情報を受信:", data);
    const cancelled = data.cancelled;
    const areas = data.areas || [];

    if (cancelled) {
        showAlertBanner("津波情報", "津波予報は解除されました。", 'info');
        return;
    }

    let msg = areas.map(a => `${a.name}: ${a.grade}`).join(" / ");
    showAlertBanner("【津波注意報・警報】", msg || "津波情報が発表されました。", 'emergency');
}

// ======== 緊急地震速報の処理 (code: 556 等) ========
function handleEEWAlert(data) {
    console.log("緊急地震速報を受信:", data);
    const eq = data.earthquake || {};
    const hypocenter = eq.hypocenter?.name || "調査中";
    const mag = eq.hypocenter?.magnitude || "-";
    const isCancelled = data.cancelled;

    if (isCancelled) {
        showAlertBanner("緊急地震速報", "緊急地震速報はキャンセルされました。", 'info');
        return;
    }

    showAlertBanner(
        "【緊急地震速報（予報・警報）】",
        `震源: ${hypocenter} (M${mag}) 強い揺れに警戒してください！`,
        'emergency'
    );

    // 【追加】EEW受信時にも予測震源地があれば波及アニメーションを描画する
    if (eq.hypocenter && eq.hypocenter.latitude && eq.hypocenter.longitude) {
        // 暫定的な表示として震度不明でマップを更新し、対象エリアにズーム
        updateMap(eq.hypocenter.latitude, eq.hypocenter.longitude, { text: "?", color: "#ff4d4d" }, eq.originTime || new Date().toISOString());
        map.setView([eq.hypocenter.latitude, eq.hypocenter.longitude], 7, { animate: true });
    }
}



// // ======== デモ実行用関数 ========
// function runEarthquakeDemo(level = 'emergency') {
//     // P/S波のアニメーションを動かすため発生時間を「現在時刻」に設定
//     const nowISO = new Date().toISOString();

//     if (level === 'emergency') {
//         // 1. 緊急地震速報（警報）を発令
//         handleEEWAlert({
//             earthquake: { hypocenter: { name: "駿河湾沖", magnitude: 7.2 } },
//             cancelled: false
//         });

//         // 2. 地震情報更新（P波・S波アニメーション開始）
//         updateLatest({
//             issue: { type: "ScaleAndDestination" },
//             earthquake: {
//                 time: nowISO,
//                 maxScale: 60, // 震度6強
//                 hypocenter: {
//                     name: "駿河湾沖",
//                     latitude: 34.7,
//                     longitude: 138.4,
//                     depth: 20,
//                     magnitude: 7.2
//                 },
//                 domesticTsunami: "Watch"
//             },
//             points: [
//                 { addr: "静岡市", scale: 60 },
//                 { addr: "横浜市", scale: 45 },
//                 { addr: "東京都", scale: 40 }
//             ]
//         }, true);
//     } else if (level === 'info') {
//         // 小規模な地震のお知らせ通知デモ
//         updateLatest({
//             issue: { type: "ScalePrompt" },
//             earthquake: {
//                 time: nowISO,
//                 maxScale: 20, // 震度2
//                 hypocenter: {
//                     name: "千葉県東方沖",
//                     latitude: 35.6,
//                     longitude: 140.5,
//                     depth: 30,
//                     magnitude: 3.5
//                 },
//                 domesticTsunami: "None"
//             },
//             points: []
//         }, true);
//     }
// }

// // JSで画面右下に操作ボタンを注入
// window.addEventListener('DOMContentLoaded', () => {
//     const container = document.createElement('div');
//     container.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; gap: 8px;';

//     const btnEmergency = document.createElement('button');
//     btnEmergency.textContent = '強震デモ';
//     btnEmergency.style.cssText = 'padding: 8px 12px; background: #ff4d4d; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;';
//     btnEmergency.onclick = () => runEarthquakeDemo('emergency');

//     const btnInfo = document.createElement('button');
//     btnInfo.textContent = '微震デモ';
//     btnInfo.style.cssText = 'padding: 8px 12px; background: #1f6feb; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;';
//     btnInfo.onclick = () => runEarthquakeDemo('info');

//     container.appendChild(btnEmergency);
//     container.appendChild(btnInfo);
//     document.body.appendChild(container);
// });