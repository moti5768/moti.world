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

let currentMarker = null;

function updateMap(lat, lng, scaleInfo, maxScale) {
    if (!lat || !lng || lat === -200 || lng === -200) return;

    if (currentMarker) {
        map.removeLayer(currentMarker);
    }

    const pos = [lat, lng];
    const radius = maxScale ? Math.max(8, (maxScale / 70) * 22) : 8;

    currentMarker = L.circleMarker(pos, {
        radius: radius,
        fillColor: scaleInfo.color,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.85
    }).addTo(map);

    map.setView(pos, 7, { animate: true, duration: 1.0 });
}

// ======== 画面更新ロジック ========
function updateLatest(data) {
    const eq = data.earthquake;
    if (!eq) return;

    const scaleInfo = getScaleInfo(eq.maxScale);

    document.getElementById('latest-scale').textContent = scaleInfo.text;
    document.getElementById('latest-scale-box').style.backgroundColor = scaleInfo.color;

    document.getElementById('latest-time').textContent = eq.time || "不明";
    document.getElementById('latest-name').textContent = eq.hypocenter?.name || "調査中";

    const depth = eq.hypocenter?.depth;
    document.getElementById('latest-depth').textContent = depth === -1 ? "ごく浅い" : (depth ? depth + " km" : "不明");

    const mag = eq.hypocenter?.magnitude;
    document.getElementById('latest-mag').textContent = mag === -1 ? "-" : (mag ? mag.toFixed(1) : "-");

    updateMap(eq.hypocenter?.latitude, eq.hypocenter?.longitude, scaleInfo, eq.maxScale);

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
    if (!eq?.maxScale) return null;

    const scaleInfo = getScaleInfo(eq.maxScale);
    const magText = (eq.hypocenter?.magnitude && eq.hypocenter.magnitude !== -1)
        ? eq.hypocenter.magnitude.toFixed(1)
        : "-";

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
    li.addEventListener('click', () => updateLatest(data));

    return li;
}

// ======== API連携 ========
async function fetchHistory() {
    try {
        const res = await fetch('https://api.p2pquake.net/v2/history?codes=551&limit=15');
        const json = await res.json();

        if (json.length > 0) {
            updateLatest(json[0]);
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

function connectWebSocket() {
    const ws = new WebSocket('wss://api.p2pquake.net/v2/ws');

    ws.onopen = () => console.log("リアルタイム接続を開始しました。");

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);

        if (data.code === 551) {
            updateLatest(data);

            const list = document.getElementById('history-list');
            const el = createHistoryElement(data);
            if (el) {
                list.insertBefore(el, list.firstChild);
                if (list.children.length > 15) list.removeChild(list.lastChild);
            }
        }

        if (data.code === 552) {
            handleTsunamiAlert(data);
        }

        if (data.code === 556) {
            handleEEWAlert(data);
        }
    };

    ws.onclose = () => {
        console.log("切断されました。5秒後に再接続します...");
        setTimeout(connectWebSocket, 5000);
    };
}

fetchHistory();
connectWebSocket();

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
function showAlertBanner(title, message, isEmergency = true) {
    const banner = document.getElementById('alert-banner');
    const titleEl = document.getElementById('alert-title');
    const msgEl = document.getElementById('alert-message');

    titleEl.textContent = title;
    msgEl.textContent = message;
    banner.classList.remove('hidden');

    document.querySelectorAll('.panel').forEach(panel => {
        if (isEmergency) panel.classList.add('emergency-active');
    });

    // ★ 警告が発生した時（かつ緊急度が高い場合など）にだけ警告音を鳴らす
    if (isEmergency) {
        playAlertSound();
    }
}

// ======== 津波予報の処理 (code: 552) ========
function handleTsunamiAlert(data) {
    console.log("津波情報を受信:", data);
    const cancelled = data.cancelled;
    const areas = data.areas || [];

    if (cancelled) {
        showAlertBanner("津波情報", "津波予報は解除されました。", false);
        return;
    }

    let msg = areas.map(a => `${a.name}: ${a.grade}`).join(" / ");
    showAlertBanner("【津波注意報・警報】", msg || "津波情報が発表されました。", true);
}

// ======== 緊急地震速報の処理 (code: 556 等) ========
function handleEEWAlert(data) {
    console.log("緊急地震速報を受信:", data);
    const eq = data.earthquake || {};
    const hypocenter = eq.hypocenter?.name || "調査中";
    const mag = eq.hypocenter?.magnitude || "-";
    const isCancelled = data.cancelled;

    if (isCancelled) {
        showAlertBanner("緊急地震速報", "緊急地震速報はキャンセルされました。", false);
        return;
    }

    showAlertBanner(
        "【緊急地震速報（予報・警報）】",
        `震源: ${hypocenter} (M${mag}) 強い揺れに警戒してください！`,
        true
    );
}

// 画面のどこかをタップしたとき、警告が出ている場合のみ音声を初期化・再生し、1回きりで終了する
const handleDocumentClick = () => {
    const banner = document.getElementById('alert-banner');

    // 'hidden' クラスを持っていない（＝警告が出ている）場合のみ実行
    if (banner && !banner.classList.contains('hidden')) {
        initAudio();
        playAlertSound();

        // 1回きりにするため、イベントリスナーを削除
        document.removeEventListener('click', handleDocumentClick);
    }
};

document.addEventListener('click', handleDocumentClick);


// テスト用にダミーデータを渡して実行する
setTimeout(() => {
    handleEEWAlert({
        earthquake: {
            hypocenter: { name: "テスト震源", magnitude: 5.5 }
        },
        cancelled: false
    });
}, 0);