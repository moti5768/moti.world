const element = document.getElementById('user');
element.insertAdjacentHTML('afterend', '<p class="white user">BROWSER: ' + navigator.appName + '<br>'
    + 'VERSION: ' + navigator.appVersion + '<br>' + 'USER: ' + navigator.userAgent + '<br>' + 'WIDTH: ' + screen.width + '<br>'
    + 'HEIGHT: ' + screen.height + '<br>' + 'BIT: ' + screen.colorDepth + '</p>');

setInterval(() => {
    navigator.getBattery().then(function (battery) {
        document.getElementById('level').innerHTML = battery.level;
        document.getElementById('charging').innerHTML = battery.charging;
        document.getElementById('chargingTime').innerHTML = battery.chargingTime;
        document.getElementById('dischargingTime').innerHTML = battery.dischargingTime;
    });
    const memory = document.querySelector('.memory');
    memory.textContent = (`memory:   ${(performance.memory.usedJSHeapSize / 1024).toFixed(2)}KB`);
}, 100);

if (navigator.userAgent.match(/(iPhone|iPod|Android.*Mobile)/i)) {
    no();
} else {
    // PC・タブレットの場合の処理を記述
    const alerttext = document.querySelector('.alerttext');
    alerttext.textContent = "";
}
function no() {
    alert("お使いの端末は対応していません!");
    no();
}

const screen2 = document.querySelector(".screen");
const passs = document.querySelector('#passkey');
const passkey = localStorage.getItem('iddata');
const content_file = document.querySelector(".content8");
const eastermenu = document.querySelector(".easter_menu");
const title = document.getElementById('title');

function passload() {
    const passkey = localStorage.getItem('iddata');
    passs.textContent = (passkey);
}
setInterval(() => {
    passload();
    if ((passkey.value = "black") === localStorage.getItem('iddata')) {
        backcolor_black();
        taskcolor_black();
        title.textContent = "WindowSystem　　　";
    } else if ((passkey.value = "white") === localStorage.getItem('iddata')) {
        backcolor_white();
        taskcolor_white();
        title.textContent = "WindowSystem　　　";
    } else if ((passkey.value = "minecraft") === localStorage.getItem('iddata')) {
        title.textContent = "Minecraft　　　";
    } else if ((passkey.value = "menu") === localStorage.getItem('iddata')) {
        content.style.display = "none";
        underbar.style.display = "none";
        taskbar.style.display = "none";
        start_menu.style.display = "none";
        const menu = document.querySelector('.menu');
        menu.style.display = "block";
        title.textContent = "WindowSystem　　　";
    } else {
        title.textContent = "WindowSystem　　　";
    }
}, 100);

function menu_close() {
    content.style.display = "block";
    underbar.style.display = "block";
    const menu = document.querySelector('.menu');
    menu.style.display = "none";
    if (document.getElementById("setting_box4").checked) {
        taskbar.style.display = "none";
    } if (document.getElementById("setting_box3").checked) {
        content.style.display = "none";
    }
}

function passcheck() {
    if (pass_form.pass.value === "0000" && localStorage.getItem('iddata') === (userid_form.userid_text.value)) {
        console.log("ログイン成功!");
        const alerttext = document.querySelector('.alerttext');
        alerttext.style.display = "";
        screen_start();
        playsound();
    } else if (userid_form.userid_text.value === "") {
        alert("IDが入力されていません!");
    } else {
        alert('IDもしくはパスワードが正しくありません!');
    }
}

function id_alert() {
    if (localStorage.getItem('iddata')) {
        alert(localStorage.getItem('iddata'));
    } else {
        alert("IDが登録されていません!");
        localStorage.removeItem('iddata');
    }
}

function loadStorage() {
    if (passkey) {
        passs.textContent = `${passkey}`;
    }
}

function passcheck2() {
    menu_close();
    const userid_text = document.querySelector('#useridtext');
    userid_text.textContent = (pass_set_form.set_pass.value);
    const iddata = document.pass_set_form.set_pass.value;
    localStorage.setItem('iddata', iddata);
    if (localStorage.getItem('iddata')) {
        const pass_text = document.getElementById('pass_text');
        pass_text.textContent = "保存しました!";
    } else {
        idload();
        localStorage.removeItem('iddata');
    }
}

const value = localStorage.getItem('iddata');
console.log(value);

let isReload = false;
window.addEventListener('load', () => {
    const perfEntries = performance.getEntriesByType("navigation");
    isReload = perfEntries[0].type === 'reload';
    iddata = localStorage.getItem('iddata');
    document.getElementById("useridtext").innerHTML = iddata;
    if (localStorage.getItem('iddata')) {
        console.log("ID TRUE");
        let screen = document.querySelector('.screen');
        screen.style.display = "none";
        pass.style.display = "none";
        userid2.style.display = "none";
        start.style.display = "block";
    } else {
        console.log("ID FALSE");
        let screen = document.querySelector('.screen');
        screen.style.display = "block";
        pass.style.display = "block";
        userid2.style.display = "block";
        start.style.display = "none";
    }
});


function idload() {
    if (localStorage.getItem('iddata')) {
        let screen = document.querySelector('.screen');
        screen.style.display = "none";
        pass.style.display = "none";
        userid2.style.display = "none";
        start.style.display = "block";
    } else {
        const pass_text = document.getElementById('pass_text');
        pass_text.textContent = "IDが入力されていません!";
        let screen = document.querySelector('.screen');
        screen.style.display = "block";
        pass.style.display = "block";
        userid2.style.display = "block";
        start.style.display = "none";
    }
}

(function () {
    // 5分
    const sec = 300;
    const events = ['keydown', 'mousemove', 'click'];
    let timeoutId;

    // タイマー設定
    function setTimer() {
        timeoutId = setTimeout(server, sec * 1000);
    }
    function resetTimer() {
        clearTimeout(timeoutId);
        setTimer();
    }

    // イベント設定
    function setEvents(func) {
        let len = events.length;
        while (len--) {
            addEventListener(events[len], func, false);
        }
    }

    // ログアウト
    function server() {
        server_open();
        console.log("5分間放置されていたため、スクリーンセーバーが起動しました！");
    }

    setTimer();
    setEvents(resetTimer);
})();

const star = document.querySelector(".star");
const pass = document.querySelector('.pass_area');
const userid2 = document.querySelector('.userid_area');
const start = document.querySelector('.start');
const popupwrap = document.getElementsByClassName('popupwrap');
const screen_open = document.querySelector(".Windows95_group");
const content = document.querySelector(".content");
const start_menu = document.querySelector(".start_menu");
const taskbar = document.querySelector(".taskbar");
const taskbar2 = document.querySelector(".taskbar2");
const program_menu = document.querySelector(".program_menu");
const app_menu = document.querySelector(".app_menu");
const setting_menu = document.querySelector(".setting_menu");
const command_menu = document.querySelector(".command_menu");
const alerttextmenu = document.querySelector(".alerttext_menu");
const backcolor_menu = document.querySelector(".backcolor_menu");
const taskcolor_menu = document.querySelector(".taskcolor_menu");
const colorbtn = document.querySelector(".colorbtn");
const controlpanel = document.querySelector(".controlpanel");
const mycomputer = document.querySelector(".mycomputer");
const app_calc = document.querySelector(".app_calc");
const app_memo = document.querySelector(".app_memo");
const net = document.querySelector(".network");
const paint = document.querySelector(".paint");
const server = document.querySelector(".screenserver");
const sound = document.querySelector(".sound");
const updatemenu = document.querySelector(".updatemenu");
const updown_menu = document.querySelector(".updown_menu");
const underbar = document.querySelector(".underbar");
const task_soft = document.querySelector(".task_soft");
const error = document.querySelector(".error");
const error2 = document.querySelector(".error2");
const help = document.querySelector(".help");
const calendar = document.querySelector(".calendar");
const btcolor = document.getElementById("backcolor");
const windows = document.querySelector(".windows");
const debug = document.querySelector(".debug");
const stopwatch = document.querySelector(".stopwatch");
const set_pass = document.querySelector(".pass_setting");
const help_command = document.querySelector(".help_command");
const alarm = document.querySelector(".alarm");
const weather_menu = document.querySelector(".weather_menu");
const update_log = document.querySelector(".update_log");
const font_menu = document.querySelector(".font_menu");
const videomenu = document.querySelector(".video_menu");
const youtubevideomenu = document.querySelector(".youtubevideo_menu");

function twoDigit(num) {
    let ret;
    if (num < 10)
        ret = "0" + num;
    else
        ret = num;
    return ret;
}
function showClock() {
    const nowDate = new Date();
    let nowTime = new Date();
    let nowHour = twoDigit(nowTime.getHours());
    let nowMin = twoDigit(nowTime.getMinutes());
    if (nowHour >= 12) {
        document.getElementById('ampm').textContent = 'PM';
    } else {
        document.getElementById('ampm').textContent = 'AM';
    }

    let msg = "" + nowHour + ":" + nowMin + "　";

    document.getElementById("timer").innerHTML = msg;
}
setInterval('showClock()', 100);

function LoadProc() {
    const nowDate = new Date();
    let now = new Date();
    let Year = twoDigit(now.getFullYear());
    let Month = twoDigit(now.getMonth() + 1);
    let Dates = twoDigit(now.getDate());

    let msg = Year + "年" + Month + "月" + Dates + "日";

    document.getElementById("date").innerHTML = msg;
}
setInterval('LoadProc()', 100);

setInterval(() => {
    if (window.navigator.onLine) {
        const online = document.getElementsByClassName('online_icon');
        online[0].classList.add('online');
        const onlinewifi = document.getElementsByClassName('icon_wifi');
        onlinewifi[0].classList.add('online');
    } else {
        const online = document.getElementsByClassName('online_icon');
        online[0].classList.remove('online');
        const onlinewifi = document.getElementsByClassName('icon_wifi');
        onlinewifi[0].classList.remove('online');
    }
}, 100);
setInterval(() => {
    if (navigator.connection.effectiveType === '3g' || navigator.connection.effectiveType === '4g') {
        const online4 = document.getElementsByClassName('icon_4g');
        online4[0].classList.add('online');
    } else {
        const online4 = document.getElementsByClassName('icon_4g');
        online4[0].classList.remove('online');
    }
}, 100);

window.addEventListener('load', (event) => {
    const screen_open = document.querySelector(".Windows95_group");
    screen_open.style.display = "block";
    console.log('ページが完全に読み込まれました');
});

if (window.performance) {
    if (window.performance.navigation.type === 1) {
        const screen_open = document.querySelector(".Windows95_group");
        screen_open.style.display = "block";
    }
}

function playsound() {
    const playsound = new Audio("https://github.com/moti5768/moti.world/raw/main/new%20OS/IMG_6946.mp3");
    playsound.play();
}
function playsound2() {
    const playsound2 = new Audio("https://github.com/moti5768/moti.world/raw/main/new%20OS/IMG_6947.mp3");
    playsound2.play();
}
function playsound3() {
    const playsound3 = new Audio("https://github.com/moti5768/moti.world/raw/main/windows%202000/IMG_7324.mp3");
    playsound3.play();
}
function playsound4() {
    const playsound4 = new Audio("https://github.com/moti5768/moti.world/raw/main/windows%202000/IMG_7325.mp3");
    playsound4.play();
}
function playsound5() {
    const playsound5 = new Audio("https://github.com/moti5768/moti.world/raw/main/IMG_6305.mp3");
    playsound5.play();
}
function playsound6() {
    const playsound6 = new Audio("https://github.com/moti5768/moti.world/raw/main/IMG_6307.mp3");
    playsound6.play();
}

function finish_mes() {
    document.querySelector('.ref').textContent = "終了";
}
function screen_close() {
    document.getElementsByClassName("pass_area")[0].value = '';
    document.getElementsByClassName("userid")[0].value = '';
    idload();
    let targets = document.querySelectorAll(`input[type='checkbox'][name='checkbox']`);
    for (const i of targets) {
        i.checked = false;
    }
    task_soft.style.display = "block";
    taskbar2.style.display = "none";
    taskbar.style.display = "block";
    setTimeout(function () {
        let screen_close = document.getElementsByClassName('screen_close');
        screen_close[0].classList.add('active');
    }, 0);
    setTimeout(function () {
        let screen_close2 = document.getElementsByClassName('screen_close');
        screen_close2[0].classList.add('fadein');
    }, 4000);
    let screen_start2 = document.getElementsByClassName('screen_start');
    screen_start2[0].classList.remove('fadeout');
    setTimeout(function () {
        let screen = document.querySelector('.screen');
        screen.style.display = "block";
        let screen_close = document.getElementsByClassName('screen_close');
        screen_close[0].classList.remove('active');
        let screen_close2 = document.getElementsByClassName('screen_close');
        screen_close2[0].classList.remove('fadein');
    }, 10000);
};

function screen_start() {
    loadStorage();
    document.getElementById("backcolor").style.backgroundColor = "black";
    let screen_start = document.getElementsByClassName('screen_start');
    screen_start[0].classList.add('active');
    let screen = document.querySelector('.screen');
    screen.style.display = "none";
    setTimeout(function () {
        let screen_start = document.getElementsByClassName('screen_start');
        screen_start[0].classList.remove('active');
        let screen_start2 = document.getElementsByClassName('screen_start');
        screen_start2[0].classList.add('fadeout');
        document.getElementById("backcolor").style.backgroundColor = "";
        setTimeout(function () {
            error2.style.display = "none";
            const screen_open = document.querySelector(".Windows95_group");
            screen_open.style.display = "block";
        }, 0);
    }, 3000);
};

window.addEventListener('load', function () {
    if (!this.localStorage.getItem('disp_popup')) {
        this.localStorage.setItem('disp_popup', 'on');
        let popup = document.getElementsByClassName('popupwrap');
        popup[0].style.display = "block";
    }
});
window.addEventListener('load', function () {
    if (!sessionStorage.getItem('disp_screen')) {
        sessionStorage.setItem('disp_screen', 'on');
        let screen = document.getElementsByClassName('screen');
        screen[0].classList.add('active');
    }
});

const bar = document.querySelectorAll('.soft');
function softbar() {
    bar.forEach((item) => {
        item.classList.remove("soft_bar");
    });
    this.classList.add("soft_bar");
}
bar.forEach((item) => {
    item.addEventListener("click", softbar)
});

// 読込
function load() {
    let MemoData = "";
    if (!localStorage.getItem('MemoData')) {
        MemoData = "メモは登録されていません。";
        document.getElementById("inputlength").innerHTML = MemoData.length + "文字";
    } else {
        MemoData = localStorage.getItem('MemoData');
        document.getElementById("inputlength").innerHTML = MemoData.length + "文字";
    }
    document.form1.Memo.value = MemoData;
    const memo_save = document.getElementById('memo_save_text');
    memo_save.textContent = "";
}
// 保存
function save() {
    let MemoData = document.form1.Memo.value;
    localStorage.setItem('MemoData', MemoData);
    const memo_save = document.getElementById('memo_save_text');
    memo_save.textContent = "保存しました！";
}
document.getElementById('cleartextbtn').addEventListener('click', function () {
    document.getElementsByClassName("Memo")[0].value = '';
    const memo_save = document.getElementById('memo_save_text');
    memo_save.textContent = "";
    resetShowLength();
});
function ShowLength(str) {
    document.getElementById("inputlength").innerHTML = str.length + "文字";
}
function resetShowLength() {
    document.getElementById("inputlength").innerHTML = "0文字";
}
function memotext_red() {
    document.querySelector('.Memo').style.color = "red";
}
function memotext_orange() {
    document.querySelector('.Memo').style.color = "orange";
}
function memotext_blue() {
    document.querySelector('.Memo').style.color = "blue";
}
function memotext_green() {
    document.querySelector('.Memo').style.color = "green";
}
function memotext_red() {
    document.querySelector('.Memo').style.color = "red";
}
function memotext_black() {
    document.querySelector('.Memo').style.color = "black";
}

function memotext_bold() {
    var Memo = document.querySelector('.Memo');
    if (Memo.style.fontWeight == "bold") {
        Memo.style.fontWeight = "normal";
    } else {
        Memo.style.fontWeight = "bold";
    }
}
function memotext_underline() {
    var Memo = document.querySelector('.Memo');
    if (Memo.style.textDecoration == "underline") {
        Memo.style.textDecoration = "none";
    } else {
        Memo.style.textDecoration = "underline";
    }
}

function updates(_v) // input tag を更新する関数
{
    document.querySelector(".calc").value = _v
}

function append(_v) // 数字ボタンが押されたので数字を後ろに追加する
{
    document.querySelector(".calc").value += _v
}

function calc() // 「＝」ボタンが押されたので計算する
{
    const v = document.querySelector(".calc").value
    try {
        const f = new Function('return ' + v)
        updates(f().toString())
    } catch (_error) {
        updates(_error) // 計算に失敗した場合は、そのエラーの内容を表示する
    }
}

function Credit() {
    const Credit = document.querySelector(".Credit");
    Credit.style.display = "block";
    setTimeout(() => {
        const Credit = document.querySelector(".Credit");
        Credit.style.display = "none";
    }, 2000);
}

msg3 = "";
rand = Math.floor(Math.random() * 10); //0～4の乱数を発生

if (rand == 0) who = "鈴木君が";
if (rand == 1) who = "山田君が";
if (rand == 2) who = "田中君が";
if (rand == 3) who = "小林君が";
if (rand == 4) who = "山本君が";
if (rand == 5) who = "名無し君が";
if (rand == 6) who = "前田君が";
if (rand == 7) who = "君が";
if (rand == 8) who = "みんなが";
if (rand == 9) who = "動物が";

//どこで
rand = Math.floor(Math.random() * 10);

if (rand == 0) where = "学校で";
if (rand == 1) where = "公園で";
if (rand == 2) where = "自宅で";
if (rand == 3) where = "隣の家で";
if (rand == 4) where = "畑で";
if (rand == 5) where = "水族館で";
if (rand == 6) where = "地中で";
if (rand == 7) where = "空で";
if (rand == 8) where = "頭の上で";
if (rand == 9) where = "虚無空間で";

msg3 = who + where; //msgは前のセクションから引き継いだものにwhereを追加して、新しくmsgに上書きしている。

//どうした
rand = Math.floor(Math.random() * 10);

if (rand == 0) what = "イモを掘った。";
if (rand == 1) what = "カレーを食べた。";
if (rand == 2) what = "水浴びをした。";
if (rand == 3) what = "熊と戦った。";
if (rand == 4) what = "犬と遊んだ。";
if (rand == 5) what = "万引きをした。";
if (rand == 6) what = "共食いをした。";
if (rand == 7) what = "溶岩浴びをした。";
if (rand == 8) what = "モンスターと戦った。";
if (rand == 9) what = "一人ぼっちにされた。";

msg3 = msg3 + what;
document.getElementById("text").innerHTML = msg3;

//乱数の発生から、文字列の追加までのセクションを増やせば、長い文章も作成可能
//各セクションの文章選択肢を増やすときは乱数の数字に注意

function omikuji() {
    rand = Math.floor(Math.random() * 100);
    msg = "大吉";
    if (rand > 9) msg = "吉";
    if (rand > 29) msg = "中吉";
    if (rand > 39) msg = "小吉";
    if (rand > 49) msg = "大凶";
    if (rand > 59) msg = "中吉";
    if (rand > 69) msg = "末吉";
    if (rand > 79) msg = "凶";
    if (rand > 89) msg = "残念!! 今日はおみくじがなかったみたい...";
    alert(msg);
}

function colorbox() {
    if (document.getElementById("color_box").checked) {
        colorbtn.style.display = "none";
    } else {
        colorbtn.style.display = "inline";
    }
}

function settingbox() {
    if (document.getElementById("setting_box").checked) {
        underbar.style.display = "none";
        start_menu.style.display = "none";
    } else {
        underbar.style.display = "block";
    }
}
function settingbox2() {
    if (document.getElementById("setting_box2").checked) {
        taskbar.style.display = "none";
    } else if (taskbar2.style.display = "none") {
        taskbar.style.display = "block";
        task_soft.style.display = "block";
    }
}
function settingbox3() {
    if (document.getElementById("setting_box3").checked) {
        content.style.display = "none";
    } else {
        content.style.display = "block";
    }
}
function settingbox4() {
    if (document.getElementById("setting_box4").checked) {
        task_soft.style.display = "none";
        taskbar2.style.display = "block";
        taskbar.style.display = "none";
    } else if (document.getElementById("setting_box2").checked) {
        console.log("test");
    } else {
        task_soft.style.display = "block";
        taskbar2.style.display = "none";
        taskbar.style.display = "block";
    }
}
function settingbox5() {
    if (document.getElementById("setting_box5").checked) {
        screen_open.style.display = "none";
    } else {
        screen_open.style.display = "block";
    }
}
function settingbox6() {
    if (document.getElementById("setting_box6").checked) {
        content_file.style.display = "block";
    } else {
        content_file.style.display = "none";
    }
}
function settingbox7() {
    if (document.getElementById("setting_box7").checked) {
        window_visible_add();
    } else {
        window_visible_remove();
    }
}


function testalert() {
    alert("test");
}

function windowsNT() {
    const winNT = document.getElementsByClassName('winNT');
    winNT[0].classList.add('block');
    star.style.display = "block";
}
function windowsNT_r() {
    const winNT = document.getElementsByClassName('winNT');
    winNT[0].classList.remove('block');
    star.style.display = "none";
}

function backcolor_black() {
    document.getElementById("backcolor").style.background = "black";
}
function backcolor_white() {
    document.getElementById("backcolor").style.background = "white";
}
function backcolor_gray() {
    document.getElementById("backcolor").style.background = "gray";
}
function backcolor_silver() {
    document.getElementById("backcolor").style.background = "silver";
}
function backcolor_darkblue() {
    document.getElementById("backcolor").style.background = "darkblue";
}
function backcolor_lightskyblue() {
    document.getElementById("backcolor").style.background = "#87cefa";
}
function backcolor_red() {
    document.getElementById("backcolor").style.background = "red";
}
function backcolor_orange() {
    document.getElementById("backcolor").style.background = "orange";
}
function backcolor_yellow() {
    document.getElementById("backcolor").style.background = "yellow";
}
function backcolor_green() {
    document.getElementById("backcolor").style.background = "green";
}
function backcolor_lime() {
    document.getElementById("backcolor").style.background = "lime";
}
function backcolor_purple() {
    document.getElementById("backcolor").style.background = "purple";
}
function backcolor_redpurple() {
    document.getElementById("backcolor").style.background = "#c450a0";
}
function backcolor_bluepurple() {
    document.getElementById("backcolor").style.background = "#704cbc";
}
function backcolor_brown() {
    document.getElementById("backcolor").style.background = "brown";
}
function backcolor_pink() {
    document.getElementById("backcolor").style.background = "pink";
}
function backcolor_skincolor() {
    document.getElementById("backcolor").style.background = "#fedcbd";
}
function backcolor_reset() {
    document.getElementById("backcolor").style.background = "";
}


function taskcolor_black() {
    document.getElementById("taskbar").style.background = "black";
    document.getElementById("taskbar").style.borderColor = "black";
}
function taskcolor_white() {
    document.getElementById("taskbar").style.background = "white";
    document.getElementById("taskbar").style.borderColor = "white";
}
function taskcolor_gray() {
    document.getElementById("taskbar").style.background = "gray";
    document.getElementById("taskbar").style.borderColor = "gray";
}
function taskcolor_silver() {
    document.getElementById("taskbar").style.background = "silver";
    document.getElementById("taskbar").style.borderColor = "silver";
}
function taskcolor_darkblue() {
    document.getElementById("taskbar").style.background = "darkblue";
    document.getElementById("taskbar").style.borderColor = "darkblue";
}
function taskcolor_lightskyblue() {
    document.getElementById("taskbar").style.background = "#87cefa";
    document.getElementById("taskbar").style.borderColor = "#87cefa";
}
function taskcolor_red() {
    document.getElementById("taskbar").style.background = "red";
    document.getElementById("taskbar").style.borderColor = "red";
}
function taskcolor_orange() {
    document.getElementById("taskbar").style.background = "orange";
    document.getElementById("taskbar").style.borderColor = "orange";
}
function taskcolor_yellow() {
    document.getElementById("taskbar").style.background = "yellow";
    document.getElementById("taskbar").style.borderColor = "yellow";
}
function taskcolor_green() {
    document.getElementById("taskbar").style.background = "green";
    document.getElementById("taskbar").style.borderColor = "green";
}
function taskcolor_lime() {
    document.getElementById("taskbar").style.background = "lime";
    document.getElementById("taskbar").style.borderColor = "lime";
}
function taskcolor_purple() {
    document.getElementById("taskbar").style.background = "purple";
    document.getElementById("taskbar").style.borderColor = "purple";
}
function taskcolor_redpurple() {
    document.getElementById("taskbar").style.background = "#c450a0";
    document.getElementById("taskbar").style.borderColor = "#c450a0";
}
function taskcolor_bluepurple() {
    document.getElementById("taskbar").style.background = "#704cbc";
    document.getElementById("taskbar").style.borderColor = "#704cbc";
}
function taskcolor_brown() {
    document.getElementById("taskbar").style.background = "brown";
    document.getElementById("taskbar").style.borderColor = "brown";
}
function taskcolor_pink() {
    document.getElementById("taskbar").style.background = "pink";
    document.getElementById("taskbar").style.borderColor = "pink";
}
function taskcolor_skincolor() {
    document.getElementById("taskbar").style.background = "#fedcbd";
    document.getElementById("taskbar").style.borderColor = "#fedcbd";
}
function taskcolor_reset() {
    document.getElementById("taskbar").style.background = "";
    document.getElementById("taskbar").style.borderColor = "";
}

function allwindow_close() {
    popupwrap[0].style.display = "none";
    screen_open.style.display = "none";
    start_menu.style.display = "none";
    taskbar.style.display = "block";
    taskcolor_menu.style.display = "none";
    backcolor_menu.style.display = "none";
    program_menu.style.display = "none";
    app_menu.style.display = "none";
    setting_menu.style.display = "none";
    command_menu.style.display = "none";
    help_command.style.display = "none";
    controlpanel.style.display = "none";
    mycomputer.style.display = "none";
    app_calc.style.display = "none";
    app_memo.style.display = "none";
    net.style.display = "none";
    paint.style.display = "none";
    server.style.display = "none";
    sound.style.display = "none";
    updatemenu.style.display = "none";
    updown_menu.style.display = "none";
    help.style.display = "none";
    calendar.style.display = "none";
    windows.style.display = "none";
    debug.style.display = "none";
    stopwatch.style.display = "none";
    error2.style.display = "none";
    alerttextmenu.style.display = "none";
    alarm.style.display = "none";
    weather_menu.style.display = "none";
    update_log.style.display = "none";
    font_menu.style.display = "none";
    videomenu.style.display = "none";
    youtubevideomenu.style.display = "none";

}

function startmenu_close() {
    start_menu.style.display = "none";
    program_menu.style.display = "none";
    app_menu.style.display = "none";
}
function startmenu_open() {
    start_menu.style.display = "block";
}

function popupwindow_open() {
    popupwrap[0].style.display = "block";
}
function popupwindow_close() {
    popupwrap[0].style.display = "none";
}

function controlpanel_open() {
    controlpanel.style.display = "block";
}
function controlpanel_close() {
    controlpanel.style.display = "none";
}

function mycomputer_open() {
    mycomputer.style.display = "block";
}
function mycomputer_close() {
    mycomputer.style.display = "none";
    let myc = document.getElementsByClassName('myc');
    myc[0].classList.remove('task_bar');
}

function netmenu_open() {
    net.style.display = "block";
}
function netmenu_close() {
    net.style.display = "none";
}

function sound_open() {
    sound.style.display = "block";
}
function sound_close() {
    sound.style.display = "none";
}

function updatemenu_open() {
    updatemenu.style.display = "block";
}
function updatemenu_close() {
    updatemenu.style.display = "none";
}

function updownmenu_open() {
    updown_menu.style.display = "block";
}
function updownmenu_close() {
    updown_menu.style.display = "none";
}

function backcolormenu_close() {
    backcolor_menu.style.display = "none";
}
function backcolormenu_open() {
    backcolor_menu.style.display = "block";
}

function taskcolormenu_close() {
    taskcolor_menu.style.display = "none";
}
function taskcolormenu_open() {
    taskcolor_menu.style.display = "block";
}

function programmenu_close() {
    program_menu.style.display = "none";
    app_menu.style.display = "none";
}
function programmenu_open() {
    program_menu.style.display = "block";
}

function appmenu_open() {
    app_menu.style.display = "block";
}
function appmenu_close() {
    app_menu.style.display = "none";
}

function settingmenu_open() {
    setting_menu.style.display = "block";
}
function settingmenu_close() {
    setting_menu.style.display = "none";
}

function calc_open() {
    app_calc.style.display = "block";
}

function calc_close() {
    app_calc.style.display = "none";
}

function memo_open() {
    app_memo.style.display = "block";
    document.form1.Memo.focus();
}
function memo_close() {
    app_memo.style.display = "none";
    const memo_save = document.getElementById('memo_save_text');
    memo_save.textContent = "";
}

function commandmenu_close() {
    command_menu.style.display = "none";
    help_command_close();
}
function commandmenu_open() {
    command_menu.style.display = "block";
}

function paint_close() {
    paint.style.display = "none";
}
function paint_open() {
    paint.style.display = "block";
}

function server_close() {
    server.style.display = "none";
}
function server_open() {
    server.style.display = "block";
}

function error_close() {
    error.style.display = "none";
}
function error_open() {
    error.style.display = "block";
}

function error2_open() {
    error2.style.display = "block";
}

function help_close() {
    help.style.display = "none";
}
function help_open() {
    help.style.display = "block";
}

function calendar_close() {
    calendar.style.display = "none";
}
function calendar_open() {
    calendar.style.display = "block";
    caload();
}

function windows_close() {
    windows.style.display = "none";
}
function windows_open() {
    windows.style.display = "block";
}

function debug_close() {
    debug.style.display = "none";
}
function debug_open() {
    debug.style.display = "block";
}

function stopwatch_close() {
    stopwatch.style.display = "none";
}
function stopwatch_open() {
    stopwatch.style.display = "block";
}

function alerttextmenu_close() {
    alerttextmenu.style.display = "none";
}
function alerttextmenu_open() {
    alerttextmenu.style.display = "block";
}

function setpass_close() {
    set_pass.style.display = "none";
    const pass_text = document.getElementById('pass_text');
    pass_text.textContent = "";
}
function setpass_open() {
    set_pass.style.display = "block";
}

function eastermenu_close() {
    eastermenu.style.display = "none";
}
function eastermenu_open() {
    eastermenu.style.display = "block";
}


function help_command_close() {
    help_command.style.display = "none";
}
function help_command_open() {
    help_command.style.display = "block";
}


function alarm_close() {
    alarm.style.display = "none";
}
function alarm_open() {
    alarm.style.display = "block";
}

function weathermenu_open() {
    weather_menu.style.display = "block";
}
function weathermenu_close() {
    weather_menu.style.display = "none";
}

function updatelog_open() {
    update_log.style.display = "block";
}
function updatelog_close() {
    update_log.style.display = "none";
}

function fontmenu_open() {
    font_menu.style.display = "block";
}
function fontmenu_close() {
    font_menu.style.display = "none";
}

function videomenu_open() {
    videomenu.style.display = "block";
}
function videomenu_close() {
    videomenu.style.display = "none";
}

function youtubevideomenu_open() {
    youtubevideomenu.style.display = "block";
}
function youtubevideomenu_close() {
    youtubevideomenu.style.display = "none";
}

function font_serif() {
    document.querySelector("body, textarea").style.fontFamily = "serif";
}
function font_sans_serif() {
    document.querySelector("body, textarea").style.fontFamily = "sans-serif";
}
function font_cursive() {
    document.querySelector("body, textarea").style.fontFamily = "cursive";
}
function font_fantasy() {
    document.querySelector("body, textarea").style.fontFamily = "fantasy";
}
function font_monospace() {
    document.querySelector("body, textarea").style.fontFamily = "monospace";
}

function check() {
    if (mail_form.mail.value === "reload") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        window.location = '';
    } else if (mail_form.mail.value === "") {
        alert('コマンドが入力されていません！');
    } else if (mail_form.mail.value === "shutdown") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        screen_close();
        allwindow_close();
        playsound2();
    } else if (mail_form.mail.value === "debug") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        debug_open();
    } else if (mail_form.mail.value === "setting") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        settingmenu_open();
    } else if (mail_form.mail.value === "storage.clear") {
        var res = confirm("windowsystemに保存されたデータは削除されます。それでもよろしいですか？");
        if (res == true) {
            document.getElementsByClassName("textcommand_area")[0].value = '';
            localStorage.clear();
            sessionStorage.clear();
            allwindow_close();
            screen_close();
            playsound2();
        } else { }
    } else if (mail_form.mail.value === "backcolor.windows95") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        document.getElementById("backcolor").style.background = "teal";
    } else if (mail_form.mail.value === "backcolor.windows2000") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        document.getElementById("backcolor").style.background = "steelblue";
    } else if (mail_form.mail.value === "backcolor.windows8") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        document.getElementById("backcolor").style.background = "#FF0033";
    } else if (mail_form.mail.value === "gradation.color1") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        const box = document.getElementById('backcolor');
        box.style.background = '-webkit-gradient(linear, left top, right top, color-stop(0.5, darkblue), color-stop(1, blue))';
    } else if (mail_form.mail.value === "gradation.color2") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        const box = document.getElementById('backcolor');
        box.style.background = '-webkit-gradient(linear, left top, right top, color-stop(0.5, darkred), color-stop(1, red))';
    } else if (mail_form.mail.value === "gradation.color3") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        const box = document.getElementById('backcolor');
        box.style.background = '-webkit-gradient(linear, left top, right top, color-stop(0.5, yellow), color-stop(1, green))';
    } else if (mail_form.mail.value === "gradation.color4") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        const box = document.getElementById('backcolor');
        box.style.background = '-webkit-gradient(linear, left top, right top, color-stop(0.5, black), color-stop(1, white))';
    } else if (mail_form.mail.value === "gradation.color-1") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        const box = document.getElementById('backcolor');
        box.style.background = '-webkit-gradient(linear, left top, right top, color-stop(0.5, black), color-stop(0.5, white))';
    } else if (mail_form.mail.value === "backcolor.reset") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        const box = document.getElementById('backcolor');
        box.style.background = '';
    } else if (mail_form.mail.value === "fullscreen.set") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        full();
    } else if (mail_form.mail.value === "fullscreen.reset") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        min();
    } else if (mail_form.mail.value === "backcolor.windowsNT") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        windowsNT();
    } else if (mail_form.mail.value === "backcolor.windowsNT.r") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        windowsNT_r();
    } else if (mail_form.mail.value === "alert") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        alerttextmenu_open();
    } else if (mail_form.mail.value === "css.remove") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        document.getElementById("backcolor").style.backgroundColor = "white";
        const style = document.querySelectorAll("link");
        style.forEach((s) => {
            s.remove();
        })
    } else if (mail_form.mail.value === "windowsystem") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        allwindow_close();
        error2_open();
        document.querySelector('.ref').textContent = "再起動";
        setTimeout('screen_close(),playsound2()', 1000);
        setTimeout('screen_start(),playsound(),backcolor_reset()', 11500);
    } else if (mail_form.mail.value === "help") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        help_command_open();
    } else if (mail_form.mail.value === "backcolor.menu") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        backcolormenu_open();
    } else if (mail_form.mail.value === "taskcolor.menu") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        taskcolormenu_open();
    } else if (mail_form.mail.value === "cpu.bench") {
        document.getElementsByClassName("textcommand_area")[0].value = '';
        cpubench();
    } else {
        alert('コマンドが正しくありません！');
    }
}

function restart() {
    allwindow_close();
    setTimeout('screen_close(),playsound2()', 1000);
    setTimeout('screen_start(),playsound(),backcolor_reset()', 11500);
    document.querySelector('.ref').textContent = "再起動";
}

function sclear() {
    allwindow_close();
    alert("windowsystemのストレージが削除されました");
    localStorage.clear();
    sessionStorage.clear();
    iddata = localStorage.getItem('iddata');
    document.getElementById("useridtext").innerHTML = iddata;
    setTimeout('idload()', 1000);
}

function cpubench() {
    const start = (new Date()).getTime();
    n = 0;
    for (i = 0; i < 10000; i++) {
        for (j = 0; j < 10000; j++) {
            n = (n + i) / j;
        }
    }
    end = (new Date()).getTime();
    const time = (end - start) / 1000;
    alert('計算時間は' + time + '秒でした');
}

function check2() {
    let alerttext2 = document.querySelector('#alerttext2');
    alerttext2.textContent = (mail_form2.mail2.value);
}
function check3() {
    alert(mail_form2.mail2.value);
}

function invisible_remove() {
    var invisible = document.getElementsByClassName('invisible');
    for (var i = 0, len = invisible.length; i < len; i++) {
        invisible[i].classList.add('none');
    }
}
function invisible_add() {
    var invisible = document.getElementsByClassName('invisible');
    for (var i = 0, len = invisible.length; i < len; i++) {
        invisible[i].classList.remove('none');
    }
}

function window_visible_add() {
    var list = document.querySelectorAll('.medium_window,.small_window,.help_window,.popup_window,.paint_window');
    for (var i = 0, len = list.length; i < len; i++) {
        list[i].style.background = "rgba(0,0,0,0)";
    }
}
function window_visible_remove() {
    var list = document.querySelectorAll('.medium_window,.small_window,.help_window,.popup_window,.paint_window');
    for (var i = 0, len = list.length; i < len; i++) {
        list[i].style.background = "";
    }
}

const target = document.querySelector('.windowvisiblebtn');
target.addEventListener('mouseover', () => {
    window_visible_add();
}, false);
target.addEventListener('mouseleave', () => {
    window_visible_remove();
}, false);
target.addEventListener('mouseleave', () => {
    if (document.getElementById("setting_box7").checked) {
        window_visible_add();
    };
}, false);

draggable(document.querySelector('.drag1'));
draggable(document.querySelector('.drag2'));
draggable(document.querySelector('.drag3'));
draggable(document.querySelector('.drag4'));
draggable(document.querySelector('.drag5'));
draggable(document.querySelector('.drag6'));
draggable(document.querySelector('.drag7'));
draggable(document.querySelector('.drag8'));
draggable(document.querySelector('.drag9'));
draggable(document.querySelector('.drag10'));
draggable(document.querySelector('.drag11'));
draggable(document.querySelector('.drag12'));
draggable(document.querySelector('.drag13'));
draggable(document.querySelector('.drag14'));
draggable(document.querySelector('.drag15'));
draggable(document.querySelector('.drag16'));
draggable(document.querySelector('.drag17'));
draggable(document.querySelector('.drag18'));
draggable(document.querySelector('.drag19'));
draggable(document.querySelector('.drag20'));
draggable(document.querySelector('.drag21'));
draggable(document.querySelector('.drag22'));
draggable(document.querySelector('.drag23'));
draggable(document.querySelector('.drag24'));
draggable(document.querySelector('.drag25'));
draggable(document.querySelector('.drag26'));
draggable(document.querySelector('.drag27'));
draggable(document.querySelector('.drag28'));
draggable(document.querySelector('.drag29'));
draggable(document.querySelector('.drag30'));
draggable(document.querySelector('.drag31'));
draggable(document.querySelector('.drag32'));
draggable(document.querySelector('.drag33'));
draggable(document.querySelector('.drag34'));

function draggable(target) {
    target.onmousedown = function (event) {
        let shiftX = event.clientX - target.getBoundingClientRect().left;
        let shiftY = event.clientY - target.getBoundingClientRect().top;
        let top = document.querySelector('.top');
        moveAt(event.pageX, event.pageY);
        // ボールを（pageX、pageY）座標の中心に置く
        function moveAt(pageX, pageY) {
            target.style.left = pageX - shiftX + 'px';
            target.style.top = pageY - shiftY + 'px';
        }
        function onMouseMove(event) {
            moveAt(event.pageX, event.pageY);
        }
        // (3) mousemove でボールを移動する
        document.addEventListener('mousemove', onMouseMove);
        // (4) ボールをドロップする。不要なハンドラを削除する
        target.onmouseup = function () {
            document.removeEventListener('mousemove', onMouseMove);
            target.onmouseup = null;
        };
    };
}



function draggable(target) {
    target.touchstart = function (event) {
        let shiftX = event.clientX - target.getBoundingClientRect().left;
        let shiftY = event.clientY - target.getBoundingClientRect().top;
        let top = document.querySelector('.top');
        moveAt(event.pageX, event.pageY);
        // ボールを（pageX、pageY）座標の中心に置く
        function moveAt(pageX, pageY) {
            target.style.left = pageX - shiftX + 'px';
            target.style.top = pageY - shiftY + 'px';
        }
        function touchmove(event) {
            moveAt(event.pageX, event.pageY);
        }
        // (3) mousemove でボールを移動する
        document.addEventListener('touchmove', touchmove);
        // (4) ボールをドロップする。不要なハンドラを削除する
        target.touchend = function () {
            document.removeEventListener('touchmove', touchmove);
            target.touchend = null;
        };
    };
}




let count = 0;
// 図形にクリックイベント登録＆z-indexを表示
let eleShape = document.getElementsByClassName("shape");
for (var i = 0; i < eleShape.length; i++) {
    // クリックイベント登録
    eleShape[i].addEventListener("mousedown", moveFront, event);
    // 図形にz-indexを表示
}
// クリックされた要素のz-indexに、クリックされた回数を設定する
function moveFront(e) {
    // 図形のクリック数をカウントアップ
    count++;
    // z-indexに図形のクリック数を設定（最前面に表示される）
    e.target.style.zIndex = count;
    // 図形にz-indexを表示
}


const list = document.getElementById("dragbutton");
let dragTarget;


// ドラッグ開始時の処理
list.addEventListener("dragstart", (e) => {
    dragTarget = e.target;
});

// ドロップ対象に入った時の処理
list.addEventListener("dragover", (e) => {
    e.preventDefault();

    const dropTarget = e.target.closest(".button-item");
    if (!dropTarget || dropTarget === dragTarget) return;

    const rect = dropTarget.getBoundingClientRect();
    const middleY = (rect.top + rect.bottom) / 2;

    if (e.clientY < middleY) {
        list.insertBefore(dragTarget, dropTarget);
    } else {
        list.insertBefore(dragTarget, dropTarget.nextSibling);
    }
});


function preview(obj, previewId) {
    let fileReader = new FileReader();
    fileReader.onload = (function () {
        document.getElementById(previewId).src = fileReader.result;
    });
    fileReader.readAsDataURL(obj.files[0]);
}

let ele = document.documentElement;
function full() {

    // 全画面表示      
    if (ele.webkitRequestFullscreen) {
        ele.webkitRequestFullscreen() // Chrome, Safari
    } else if (ele.mozRequestFullScreen) {
        ele.mozRequestFullScreen() // firefox
    } else if (ele.requestFullscreen) {
        ele.requestFullscreen() // HTML5 Fullscreen API
    } else {
        alert('未対応')
        return
    }

};

function min() {
    // 全画面表示　終了
    if (ele.webkitRequestFullscreen) {
        document.webkitCancelFullScreen() // Chrome, Safari
    } else if (ele.mozRequestFullScreen) {
        document.mozCancelFullScreen() // firefox
    } else if (ele.requestFullscreen) {
        document.exitFullscreen() // HTML5 Fullscreen API
    }
};

// 描画用フラグ  true: 描画中   false: 描画中でない
var flgDraw = false;

// 座標
var gX = 0;
var gY = 0;

// 描画色
var gColor = 'white';

window.onload = function () {

    // イベント登録
    // マウス
    var canvas = document.getElementById('canvaspaint');

    canvas.addEventListener('mousedown', startDraw, false);
    canvas.addEventListener('mousemove', Draw, false);
    canvas.addEventListener('mouseup', endDraw, false);

    // セレクトボックス
    var s = document.getElementById('color');
    s.addEventListener('change', changeColor, false);

}
// セレクトボックス変更時に色を変更する
function changeColor() {

    gColor = document.getElementById('color').value;
    console.log(gColor);

}
// 描画開始
function startDraw(e) {

    flgDraw = true;
    gX = e.offsetX;
    gY = e.offsetY;

}

// 描画
function Draw(e) {

    if (flgDraw == true) {

        // '2dコンテキスト'を取得
        var canvas = document.getElementById('canvaspaint');
        var con = canvas.getContext('2d');

        var x = e.offsetX;
        var y = e.offsetY;

        // 線のスタイルを設定
        con.lineWidth = 3;
        // 色設定
        con.strokeStyle = gColor;

        // 描画開始
        con.beginPath();
        con.moveTo(gX, gY);
        con.lineTo(x, y);
        con.closePath();
        con.stroke();

        // 次の描画開始点
        gX = x;
        gY = y;

    }
}

// 描画終了
function endDraw() {

    flgDraw = false;

}


var unit = 100,
    canvasList, // キャンバスの配列
    info = {}, // 全キャンバス共通の描画情報
    colorList; // 各キャンバスの色情報

/**
 * Init function.
 * 
 * Initialize variables and begin the animation.
 */
function init() {
    info.seconds = 0;
    info.t = 0;
    canvasList = [];
    colorList = [];
    // canvas1個めの色指定
    canvasList.push(document.getElementById("waveCanvas"));
    colorList.push(['#333', '#666', '#999']);//重ねる波の色設定
    // 各キャンバスの初期化
    for (var canvasIndex in canvasList) {
        var canvas = canvasList[canvasIndex];
        canvas.width = document.documentElement.clientWidth; //Canvasのwidthをウィンドウの幅に合わせる
        canvas.height = 600;//波の高さ
        canvas.contextCache = canvas.getContext("2d");
    }
    // 共通の更新処理呼び出し
    update();
}

function update() {
    for (var canvasIndex in canvasList) {
        var canvas = canvasList[canvasIndex];
        // 各キャンバスの描画
        draw(canvas, colorList[canvasIndex]);
    }
    // 共通の描画情報の更新
    info.seconds = info.seconds + .014;
    info.t = info.seconds * Math.PI;
    // 自身の再起呼び出し
    setTimeout(update, 35);
}

/**
 * Draw animation function.
 * 
 * This function draws one frame of the animation, waits 20ms, and then calls
 * itself again.
 */
function draw(canvas, color) {
    // 対象のcanvasのコンテキストを取得
    var context = canvas.contextCache;
    // キャンバスの描画をクリア
    context.clearRect(0, 0, canvas.width, canvas.height);

    //波の重なりを描画 drawWave(canvas, color[数字（波の数を0から数えて指定）], 透過, 波の幅のzoom,波の開始位置の遅れ )
    drawWave(canvas, color[0], 0.5, 1.5, 0);//0.5⇒透過具合50%、3⇒数字が大きいほど波がなだらか
    drawWave(canvas, color[1], 0.4, 2, 187);
    drawWave(canvas, color[2], 0.2, 4, 375);
}

/**
* 波を描画
* drawWave(色, 不透明度, 波の幅のzoom, 波の開始位置の遅れ)
*/
function drawWave(canvas, color, alpha, zoom, delay) {
    var context = canvas.contextCache;
    context.fillStyle = color;//塗りの色
    context.globalAlpha = alpha;
    context.beginPath(); //パスの開始
    drawSine(canvas, info.t / 0.5, zoom, delay);
    context.lineTo(canvas.width + 10, canvas.height); //パスをCanvasの右下へ
    context.lineTo(0, canvas.height); //パスをCanvasの左下へ
    context.closePath() //パスを閉じる
    context.fill(); //波を塗りつぶす
}

/**
 * Function to draw sine
 * 
 * The sine curve is drawn in 10px segments starting at the origin. 
 * drawSine(時間, 波の幅のzoom, 波の開始位置の遅れ)
 */
function drawSine(canvas, t, zoom, delay) {
    var xAxis = Math.floor(canvas.height / 2);
    var yAxis = 0;
    var context = canvas.contextCache;
    // Set the initial x and y, starting at 0,0 and translating to the origin on
    // the canvas.
    var x = t; //時間を横の位置とする
    var y = Math.sin(x) / zoom;
    context.moveTo(yAxis, unit * y + xAxis); //スタート位置にパスを置く

    // Loop to draw segments (横幅の分、波を描画)
    for (i = yAxis; i <= canvas.width + 10; i += 10) {
        x = t + (-yAxis + i) / unit / zoom;
        y = Math.sin(x - delay) / 3;
        context.lineTo(i, unit * y + xAxis);
    }
}

init();

let counts = 1;
function hogee() {
    counts = counts + 0.01;
    backcolor.style.transform = "scale(" + counts + "," + counts + ")";
}

function fooo() {
    counts = counts - 0.01;
    backcolor.style.transform = "scale(" + counts + "," + counts + ")";
}


const week = ["日", "月", "火", "水", "木", "金", "土"];
const today = new Date();
// 月末だとずれる可能性があるため、1日固定で取得
var showDate = new Date(today.getFullYear(), today.getMonth(), 1);

// 初期表示
function caload() {
    showProcess(today, calendar);
};
// 前の月表示
function prev() {
    showDate.setMonth(showDate.getMonth() - 1);
    showProcess(showDate);
}

// 次の月表示
function next() {
    showDate.setMonth(showDate.getMonth() + 1);
    showProcess(showDate);
}

// カレンダー表示
function showProcess(date) {
    var year = date.getFullYear();
    var month = date.getMonth();
    document.querySelector('#header').innerHTML = year + "年 " + (month + 1) + "月";

    var calendar = createProcess(year, month);
    document.querySelector('#calendar').innerHTML = calendar;
}

// カレンダー作成
function createProcess(year, month) {
    // 曜日
    var calendar = "<table><tr class='dayOfWeek'>";
    for (var i = 0; i < week.length; i++) {
        calendar += "<th>" + week[i] + "</th>";
    }
    calendar += "</tr>";

    var count = 0;
    var startDayOfWeek = new Date(year, month, 1).getDay();
    var endDate = new Date(year, month + 1, 0).getDate();
    var lastMonthEndDate = new Date(year, month, 0).getDate();
    var row = Math.ceil((startDayOfWeek + endDate) / week.length);

    // 1行ずつ設定
    for (var i = 0; i < row; i++) {
        calendar += "<tr>";
        // 1colum単位で設定
        for (var j = 0; j < week.length; j++) {
            if (i == 0 && j < startDayOfWeek) {
                // 1行目で1日まで先月の日付を設定
                calendar += "<td class='disabled'>" + (lastMonthEndDate - startDayOfWeek + j + 1) + "</td>";
            } else if (count >= endDate) {
                // 最終行で最終日以降、翌月の日付を設定
                count++;
                calendar += "<td class='disabled'>" + (count - endDate) + "</td>";
            } else {
                // 当月の日付を曜日に照らし合わせて設定
                count++;
                if (year == today.getFullYear()
                    && month == (today.getMonth())
                    && count == today.getDate()) {
                    calendar += "<td class='today'>" + count + "</td>";
                } else {
                    calendar += "<td>" + count + "</td>";
                }
            }
        }
        calendar += "</tr>";
    }
    return calendar;
}


const time = document.getElementById('time');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const resetButton = document.getElementById('reset');

// 開始時間
let startTime;
// 停止時間
let stopTime = 0;
// タイムアウトID
let timeoutID;

// 時間を表示する関数
function displayTime() {
    const currentTime = new Date(Date.now() - startTime + stopTime);
    const h = String(currentTime.getHours() - 9).padStart(2, '0');
    const m = String(currentTime.getMinutes()).padStart(2, '0');
    const s = String(currentTime.getSeconds()).padStart(2, '0');
    const ms = String(currentTime.getMilliseconds()).padStart(3, '0');

    time.textContent = `${h}:${m}:${s}.${ms}`;
    timeoutID = setTimeout(displayTime, 10);
}

// スタートボタンがクリックされたら時間を進める
startButton.addEventListener('click', () => {
    startButton.disabled = true;
    stopButton.disabled = false;
    resetButton.disabled = true;
    startTime = Date.now();
    displayTime();
});

// ストップボタンがクリックされたら時間を止める
stopButton.addEventListener('click', function () {
    startButton.disabled = false;
    stopButton.disabled = true;
    resetButton.disabled = false;
    clearTimeout(timeoutID);
    stopTime += (Date.now() - startTime);
});

// リセットボタンがクリックされたら時間を0に戻す
resetButton.addEventListener('click', function () {
    startButton.disabled = false;
    stopButton.disabled = true;
    resetButton.disabled = true;
    time.textContent = '00:00:00.000';
    stopTime = 0;
});


'use strict';
let currentDate = new Date();
let hours = currentDate.getHours();
let minutes = currentDate.getMinutes();
let seconds = currentDate.getSeconds();
let timerText = document.getElementById('timerText');
let set_btn = document.getElementById('set_btn');
let delete_btn = document.getElementById('delete_btn');
let option_hours;
let option_minutes;
let parent_list = document.getElementById('parent_list');
let record = []; //アラーム設定格納
let x = 0; // 計算用の変数

//アラーム設定用オブジェクト
let Setting = function (sethour, setminute) {
    this.sethour = sethour;
    this.setminute = setminute;
};

// 時計の"12:1"を"12:01"と表記
function adjustDigit(num) {
    let digit;
    if (num < 10) { digit = `0${num}`; }
    else { digit = num; }
    return digit;
}

// アラームセット
set_btn.addEventListener('click', function () {
    //アラームは最大5まで
    let lis = parent_list.getElementsByTagName('li');
    let len = lis.length;
    if (len >= 5) { return; }

    //設定時間を記録
    option_hours = document.alarm_form.option_hours.value;
    option_minutes = document.alarm_form.option_minutes.value;
    record[x] = new Setting(option_hours, option_minutes);

    //設定時間を表示
    let container_list = document.createElement('li');
    let list_content = document.createTextNode(`${record[x].sethour}時${record[x].setminute}分`);
    parent_list.appendChild(container_list);
    container_list.appendChild(list_content);

    //表示削除用ボタン
    let list_span = document.createElement('span');
    let id_li = document.createAttribute('id');
    let id_span = document.createAttribute('id');
    let span_content = document.createTextNode('削除');
    container_list.appendChild(list_span);
    list_span.appendChild(span_content);
    container_list.setAttributeNode(id_li);
    container_list.id = x;
    container_list.classList.add('deletes');
    list_span.classList.add('delete_btn');

    //設定時刻と表示を削除
    let deletes = document.getElementsByClassName('deletes');
    for (var i = 0, de_len = deletes.length; i < de_len; i++) {
        deletes[i].onclick = function () {
            record[this.id] = 'disabled';
            this.id = 'temp';
            var temp = document.getElementById('temp');
            temp.parentNode.removeChild(temp);
        };
    };
    x++;
});

//時計を動かす
function updateCurrentTime() {
    setTimeout(function () {
        currentDate = new Date();
        hours = adjustDigit(currentDate.getHours());
        minutes = adjustDigit(currentDate.getMinutes());
        seconds = adjustDigit(currentDate.getSeconds());
        timerText.innerHTML = `${hours}:${minutes}:${seconds}`;

        //アラーム機能
        for (var i = 0, len = record.length; i < len; i++) {
            if (record[i].sethour == currentDate.getHours() && record[i].setminute == currentDate.getMinutes() && seconds == 0) {
                alert('お時間です!');
            };
        };
        updateCurrentTime();
    }, 100);
} updateCurrentTime();


const weatherCode = {
    100: ["100.svg", "500.svg", "晴れ"],
    101: ["101.svg", "501.svg", "晴れ時々曇り"],
    102: ["102.svg", "502.svg", "晴れ一時雨"],
    103: ["102.svg", "502.svg", "晴れ時々雨"],
    104: ["104.svg", "504.svg", "晴れ一時雪"],
    105: ["104.svg", "504.svg", "晴れ時々雪"],
    106: ["102.svg", "502.svg", "晴れ一時雨か雪"],
    107: ["102.svg", "502.svg", "晴れ時々雨か雪"],
    108: ["102.svg", "502.svg", "晴れ一時雨か雷雨"],
    110: ["110.svg", "510.svg", "晴れ後時々曇り"],
    111: ["110.svg", "510.svg", "晴れ後曇り"],
    112: ["112.svg", "512.svg", "晴れ後一時雨"],
    113: ["112.svg", "512.svg", "晴れ後時々雨"],
    114: ["112.svg", "512.svg", "晴れ後雨"],
    115: ["115.svg", "515.svg", "晴れ後一時雪"],
    116: ["115.svg", "515.svg", "晴れ後時々雪"],
    117: ["115.svg", "515.svg", "晴れ後雪"],
    118: ["112.svg", "512.svg", "晴れ後雨か雪"],
    119: ["112.svg", "512.svg", "晴れ後雨か雷雨"],
    120: ["102.svg", "502.svg", "晴れ朝夕一時雨"],
    121: ["102.svg", "502.svg", "晴れ朝の内一時雨"],
    122: ["112.svg", "512.svg", "晴れ夕方一時雨"],
    123: ["100.svg", "500.svg", "晴れ山沿い雷雨"],
    124: ["100.svg", "500.svg", "晴れ山沿い雪"],
    125: ["112.svg", "512.svg", "晴れ午後は雷雨"],
    126: ["112.svg", "512.svg", "晴れ昼頃から雨"],
    127: ["112.svg", "512.svg", "晴れ夕方から雨"],
    128: ["112.svg", "512.svg", "晴れ夜は雨"],
    130: ["100.svg", "500.svg", "朝の内霧後晴れ"],
    131: ["100.svg", "500.svg", "晴れ明け方霧"],
    132: ["101.svg", "501.svg", "晴れ朝夕曇り"],
    140: ["102.svg", "502.svg", "晴れ時々雨と雷"],
    160: ["104.svg", "504.svg", "晴れ一時雪か雨"],
    170: ["104.svg", "504.svg", "晴れ時々雪か雨"],
    181: ["115.svg", "515.svg", "晴れ後雪か雨"],
    200: ["200.svg", "200.svg", "曇り"],
    201: ["201.svg", "601.svg", "曇り時々晴れ"],
    202: ["202.svg", "202.svg", "曇り一時雨"],
    203: ["202.svg", "202.svg", "曇り時々雨"],
    204: ["204.svg", "204.svg", "曇り一時雪"],
    205: ["204.svg", "204.svg", "曇り時々雪"],
    206: ["202.svg", "202.svg", "曇り一時雨か雪"],
    207: ["202.svg", "202.svg", "曇り時々雨か雪"],
    208: ["202.svg", "202.svg", "曇り一時雨か雷雨"],
    209: ["200.svg", "200.svg", "霧"],
    210: ["210.svg", "610.svg", "曇り後時々晴れ"],
    211: ["210.svg", "610.svg", "曇り後晴れ"],
    212: ["212.svg", "212.svg", "曇り後一時雨"],
    213: ["212.svg", "212.svg", "曇り後時々雨"],
    214: ["212.svg", "212.svg", "曇り後雨"],
    215: ["215.svg", "215.svg", "曇り後一時雪"],
    216: ["215.svg", "215.svg", "曇り後時々雪"],
    217: ["215.svg", "215.svg", "曇り後雪"],
    218: ["212.svg", "212.svg", "曇り後雨か雪"],
    219: ["212.svg", "212.svg", "曇り後雨か雷雨"],
    220: ["202.svg", "202.svg", "曇り朝夕一時雨"],
    221: ["202.svg", "202.svg", "曇り朝の内一時雨"],
    222: ["212.svg", "212.svg", "曇り夕方一時雨"],
    223: ["201.svg", "601.svg", "曇り日中時々晴れ"],
    224: ["212.svg", "212.svg", "曇り昼頃から雨"],
    225: ["212.svg", "212.svg", "曇り夕方から雨"],
    226: ["212.svg", "212.svg", "曇り夜は雨"],
    228: ["215.svg", "215.svg", "曇り昼頃から雪"],
    229: ["215.svg", "215.svg", "曇り夕方から雪"],
    230: ["215.svg", "215.svg", "曇り夜は雪"],
    231: ["200.svg", "200.svg", "曇り海岸霧か霧雨"],
    240: ["202.svg", "202.svg", "曇り時々雨と雷"],
    250: ["204.svg", "204.svg", "曇り時々雪と雷"],
    260: ["204.svg", "204.svg", "曇り一時雪か雨"],
    270: ["204.svg", "204.svg", "曇り時々雪か雨"],
    281: ["215.svg", "215.svg", "曇り後雪か雨"],
    300: ["300.svg", "300.svg", "雨"],
    301: ["301.svg", "701.svg", "雨時々晴れ"],
    302: ["302.svg", "302.svg", "雨時々止む"],
    303: ["303.svg", "303.svg", "雨時々雪"],
    304: ["300.svg", "300.svg", "雨か雪"],
    306: ["300.svg", "300.svg", "大雨"],
    308: ["308.svg", "308.svg", "雨で暴風を伴う"],
    309: ["303.svg", "303.svg", "雨一時雪"],
    311: ["311.svg", "711.svg", "雨後晴れ"],
    313: ["313.svg", "313.svg", "雨後曇り"],
    314: ["314.svg", "314.svg", "雨後時々雪"],
    315: ["314.svg", "314.svg", "雨後雪"],
    316: ["311.svg", "711.svg", "雨か雪後晴れ"],
    317: ["313.svg", "313.svg", "雨か雪後曇り"],
    320: ["311.svg", "711.svg", "朝の内雨後晴れ"],
    321: ["313.svg", "313.svg", "朝の内雨後曇り"],
    322: ["303.svg", "303.svg", "雨朝晩一時雪"],
    323: ["311.svg", "711.svg", "雨昼頃から晴れ"],
    324: ["311.svg", "711.svg", "雨夕方から晴れ"],
    325: ["311.svg", "711.svg", "雨夜は晴れ"],
    326: ["314.svg", "314.svg", "雨夕方から雪"],
    327: ["314.svg", "314.svg", "雨夜は雪"],
    328: ["300.svg", "300.svg", "雨一時強く降る"],
    329: ["300.svg", "300.svg", "雨一時みぞれ"],
    340: ["400.svg", "400.svg", "雪か雨"],
    350: ["300.svg", "300.svg", "雨で雷を伴う"],
    361: ["411.svg", "811.svg", "雪か雨後晴れ"],
    371: ["413.svg", "413.svg", "雪か雨後曇り"],
    400: ["400.svg", "400.svg", "雪"],
    401: ["401.svg", "801.svg", "雪時々晴れ"],
    402: ["402.svg", "402.svg", "雪時々止む"],
    403: ["403.svg", "403.svg", "雪時々雨"],
    405: ["400.svg", "400.svg", "大雪"],
    406: ["406.svg", "406.svg", "風雪強い"],
    407: ["406.svg", "406.svg", "暴風雪"],
    409: ["403.svg", "403.svg", "雪一時雨"],
    411: ["411.svg", "811.svg", "雪後晴れ"],
    413: ["413.svg", "413.svg", "雪後曇り"],
    414: ["414.svg", "414.svg", "雪後雨"],
    420: ["411.svg", "811.svg", "朝の内雪後晴れ"],
    421: ["413.svg", "413.svg", "朝の内雪後曇り"],
    422: ["414.svg", "414.svg", "雪昼頃から雨"],
    423: ["414.svg", "414.svg", "雪夕方から雨"],
    425: ["400.svg", "400.svg", "雪一時強く降る"],
    426: ["400.svg", "400.svg", "雪後みぞれ"],
    427: ["400.svg", "400.svg", "雪一時みぞれ"],
    450: ["400.svg", "400.svg", "雪で雷を伴う"],
};

const url = "https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json";

const dayList = ["日", "月", "火", "水", "木", "金", "土"];

const timeDefinesList = new Array();
const weatherCodeList = new Array();
const tempsMinList = new Array();
const tempsMaxList = new Array();

// JSON取得
fetch(url)
    .then(function (response) {
        return response.json();
    })
    .then(function (weather) {
        document
            .getElementById("location")
            .prepend(
                `${weather[1].publishingOffice}: ${weather[1].timeSeries[0].areas[0].area.name} `
            );
        const isTodaysData = weather[0].timeSeries[2].timeDefines.length === 4;
        const weatherCodes = weather[0].timeSeries[0].areas[0].weatherCodes;
        const timeDefines = weather[0].timeSeries[0].timeDefines;
        const temps = weather[0].timeSeries[2].areas[0].temps;
        weatherCodeList.push(weatherCodes[0], weatherCodes[1]);
        timeDefinesList.push(timeDefines[0], timeDefines[1]);
        if (isTodaysData) {
            tempsMinList.push(temps[0] === temps[1] ? "--" : temps[0], temps[2]);
            tempsMaxList.push(temps[1], temps[3]);
        } else {
            tempsMinList.push("--", temps[0]);
            tempsMaxList.push("--", temps[1]);
        }

        const startCount =
            weather[1].timeSeries[0].timeDefines.indexOf(timeDefines[1]) + 1;
        for (let i = startCount; i < startCount + 5; i++) {
            weatherCodeList.push(weather[1].timeSeries[0].areas[0].weatherCodes[i]);
            timeDefinesList.push(weather[1].timeSeries[0].timeDefines[i]);
            tempsMinList.push(weather[1].timeSeries[1].areas[0].tempsMin[i]);
            tempsMaxList.push(weather[1].timeSeries[1].areas[0].tempsMax[i]);
        }

        const date = document.getElementsByClassName("dates");
        const weatherImg = document.getElementsByClassName("weatherImg");
        const weatherTelop = document.getElementsByClassName("weatherTelop");
        const tempMin = document.getElementsByClassName("tempMin");
        const tempMax = document.getElementsByClassName("tempMax");

        weatherCodeList.forEach(function (el, i) {
            let dt = new Date(timeDefinesList[i]);
            let weekdayCount = dt.getDay();
            if (weekdayCount === 0) date[i].style.color = "red";
            if (weekdayCount === 6) date[i].style.color = "blue";
            var m = ("00" + (dt.getMonth() + 1)).slice(-2);
            var d = ("00" + dt.getDate()).slice(-2);
            date[i].textContent = `${m}/${d}(${dayList[weekdayCount]})`;
            var isNight = Number(i === 0 && !isTodaysData)
            weatherImg[i].src = "https://www.jma.go.jp/bosai/forecast/img/" + weatherCode[el][isNight];
            weatherTelop[i].textContent = weatherCode[el][2];
            tempMin[i].textContent = tempsMinList[i] + "℃";
            tempMax[i].textContent = tempsMaxList[i] + "℃";
        });
    });
