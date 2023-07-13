if(navigator.userAgent.match(/(iPhone|iPod|Android.*Mobile)/i)){
    no();
}else{
    // PC・タブレットの場合の処理を記述
    const alerttext = document.querySelector('.alerttext');
    alerttext.textContent = "";
}
function no(){
    alert("お使いの端末がPCではないため、ご利用できません");
    no();
}
function passcheck(){
if (pass_form.pass.value === "0000"){
    const alerttext = document.querySelector('.alerttext');
    alerttext.style.display = "";
    screen_start();
    playsound();
}else{
    alert('パスワードが正しくありません！');
}
}

const element = document.getElementById('user');
        element.insertAdjacentHTML('afterend','<p class="white user">BROWSER: '+ navigator.appName + '<br>' 
            + 'VERSION: ' + navigator.appVersion +  '<br>' + 'USER: ' + navigator.userAgent +  '<br>' + 'WIDTH: ' + screen.width +  '<br>' 
            + 'HEIGHT: ' + screen.height +  '<br>' + 'BIT: '  + screen.colorDepth + '</p>');
            
    const pass = document.querySelector('.pass_area');
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
    const backcolor_menu = document.querySelector(".backcolor_menu");
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
    const help = document.querySelector(".help");
    const calendar = document.querySelector(".calendar")

    function twoDigit(num) {
            let ret;
            if( num < 10)
            ret = "0" + num;
            else
            ret = num;
            return ret;
        }
    function showClock() {
        const nowDate = new Date();
        let nowTime = new Date();
        let nowHour = twoDigit( nowTime.getHours() );
        let nowMin = twoDigit( nowTime.getMinutes() );
        if(nowHour>=12){
            document.getElementById('ampm').textContent = 'PM';
        }else {
            document.getElementById('ampm').textContent = 'AM';
        }

        let msg = "" + nowHour + ":" + nowMin + "　";

        document.getElementById("timer").innerHTML = msg;
    }
    setInterval('showClock()',100);

    function LoadProc() {
        const nowDate = new Date();
        let now = new Date();
        let Year = twoDigit ( now.getFullYear() );
        let Month = twoDigit( now.getMonth()+1 );
        let Dates = twoDigit( now.getDate() );

        let msg = Year + "年" + Month + "月" + Dates + "日";
        
        document.getElementById("date").innerHTML = msg;
    }
    setInterval('LoadProc()',100);

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
        
        function playsound(){
            const playsound = new Audio("https://github.com/moti5768/moti.world/raw/main/new%20OS/IMG_6946.mp3");
            playsound.play();
        }

        function playsound2() {
            const playsound2 = new Audio("https://github.com/moti5768/moti.world/raw/main/new%20OS/IMG_6947.mp3");
            playsound2.play();
        }

        function screen_close() {
            let targets = document.querySelectorAll(`input[type='checkbox'][name='checkbox']`);
            for (const i of targets) {		
                i.checked = false;
            }
            task_soft.style.display = "block";
            taskbar2.style.display = "none";
            taskbar.style.display = "block";
            setTimeout(function() {
            let screen_close = document.getElementsByClassName('screen_close');
            screen_close[0].classList.add('active');
        }, 0);
            setTimeout(function() {
            let screen_close2 = document.getElementsByClassName('screen_close');
            screen_close2[0].classList.add('fadein');
            }, 4000);
            let screen_start2 = document.getElementsByClassName('screen_start');
            screen_start2[0].classList.remove('fadeout');
            setTimeout(function() {
            let screen = document.getElementsByClassName('screen');
            screen[0].classList.add('active');
            let screen_close = document.getElementsByClassName('screen_close');
            screen_close[0].classList.remove('active');
            let screen_close2 = document.getElementsByClassName('screen_close');
            screen_close2[0].classList.remove('fadein');
            pass.style.display = "block";
        }, 10000);
    };

        function screen_start() {
            document.getElementsByClassName("pass")[0].value = '';
            pass.style.display = "none";
            let user = document.querySelector(".user");
            user.style.display = "block";
            document.getElementById("backcolor").style.backgroundColor = "black";
            let screen_start = document.getElementsByClassName('screen_start');
            screen_start[0].classList.add('active');
            let screen = document.getElementsByClassName('screen');
            screen[0].classList.remove('active');
        setTimeout(function() {
            let user = document.querySelector(".user");
            user.style.display = "none";
            let screen_start = document.getElementsByClassName('screen_start');
            screen_start[0].classList.remove('active');
            let screen_start2 = document.getElementsByClassName('screen_start');
            screen_start2[0].classList.add('fadeout');
            document.getElementById("backcolor").style.backgroundColor = "";
        setTimeout(function() {
            const screen_open = document.querySelector(".Windows95_group");
            screen_open.style.display = "block";
        }, 0);
    }, 3000);
};

     window.addEventListener('load', function() {
            if ( !sessionStorage.getItem('disp_popup') ) {
                sessionStorage.setItem('disp_popup', 'on');
                let popup = document.getElementsByClassName('popupwrap');
                popup[0].style.display = "block";
            }
        });
        window.addEventListener('load', function() {
            if ( !sessionStorage.getItem('disp_screen') ) {
                sessionStorage.setItem('disp_screen', 'on');
                let screen = document.getElementsByClassName('screen');
                screen[0].classList.add('active');
            }
        });

        const bar =document.querySelectorAll('.soft');
        function softbar(){
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
        if(!localStorage.getItem('MemoData')) {
            MemoData = "メモは登録されていません。";
        } else {
            MemoData = localStorage.getItem('MemoData');
        }
        document.form1.Memo.value = MemoData;
    }
    // 保存
    function save() {
        let MemoData = document.form1.Memo.value;
        localStorage.setItem('MemoData', MemoData);
    }
    document.getElementById('cleartextbtn').addEventListener('click',function (){
        document.getElementsByClassName("Memo")[0].value = '';
    });
    function ShowLength( str ) {
        document.getElementById("inputlength").innerHTML = str.length + "文字";
    }

    function updates( _v ) // input tag を更新する関数
    {
        document.querySelector( ".calc" ).value = _v
    }

    function append( _v ) // 数字ボタンが押されたので数字を後ろに追加する
    {
        document.querySelector( ".calc" ).value += _v
    }

    function calc() // 「＝」ボタンが押されたので計算する
    {
        const v = document.querySelector( ".calc" ).value
        try {
            const f = new Function( 'return ' + v )
            updates( f().toString() )
        } catch( _error ) {
            updates( _error ) // 計算に失敗した場合は、そのエラーの内容を表示する
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
rand = Math.floor(Math.random()*10); //0～4の乱数を発生

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
rand = Math.floor(Math.random()*10);

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
rand = Math.floor(Math.random()*10);

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
	rand = Math.floor(Math.random()*100);
	msg = "大吉"; //0～9（10%）
	if (rand > 9) msg = "中吉"; //10～29（20%）
	if (rand > 29) msg = "吉"; //30～69（40%）
	if (rand > 69) msg = "凶"; //70～89（20%）
	if (rand > 89) msg = "大凶"; //90～99（10%）
	alert(msg);
}

function colorbox(){
    if (document.getElementById("color_box").checked) {
        colorbtn.style.display = "none";
    } else {
        colorbtn.style.display = "inline";
    }
}

function settingbox(){
    if (document.getElementById("setting_box").checked) {
        underbar.style.display = "none";
        start_menu.style.display = "none";
    } else {
        underbar.style.display = "block";
        start_menu.style.display = "block";
    }
}
function settingbox2(){
    if (document.getElementById("setting_box2").checked) {
        taskbar.style.display = "none";
    } else {
        taskbar.style.display = "block";
    }
}
function settingbox3(){
    if (document.getElementById("setting_box3").checked) {
        content.style.display = "none";
    } else {
        content.style.display = "block";
    }
}
function settingbox4(){
    if (document.getElementById("setting_box4").checked) {
        task_soft.style.display = "none";
        taskbar2.style.display = "block";
        taskbar.style.display = "none";
    } else {
        task_soft.style.display = "block";
        taskbar2.style.display = "none";
        taskbar.style.display = "block";
    }
}
function settingbox5(){
    if (document.getElementById("setting_box5").checked) {
        screen_open.style.display = "none";
    } else {
        screen_open.style.display = "block";
    }
}

function testalert(){
    alert("test");
}

    function backcolor_black(){
        document.getElementById("backcolor").style.background = "black";
    }
    function backcolor_gray(){
        document.getElementById("backcolor").style.background = "gray";
    }
    function backcolor_silver(){
        document.getElementById("backcolor").style.background = "silver";
    }
    function backcolor_darkblue(){
        document.getElementById("backcolor").style.background = "darkblue";
    }
    function backcolor_lightskyblue(){
        document.getElementById("backcolor").style.background = "#87cefa";
    }
    function backcolor_red(){
        document.getElementById("backcolor").style.background = "red";
    }
    function backcolor_orange(){
        document.getElementById("backcolor").style.background = "orange";
    }
    function backcolor_yellow(){
        document.getElementById("backcolor").style.background = "yellow";
    }
    function backcolor_green(){
        document.getElementById("backcolor").style.background = "green";
    }
    function backcolor_lime(){
        document.getElementById("backcolor").style.background = "lime";
    }
    function backcolor_purple(){
        document.getElementById("backcolor").style.background = "purple";
    }
    function backcolor_redpurple(){
        document.getElementById("backcolor").style.background = "#c450a0";
    }
    function backcolor_bluepurple(){
        document.getElementById("backcolor").style.background = "#704cbc";
    }
    function backcolor_brown(){
        document.getElementById("backcolor").style.background = "brown";
    }
    function backcolor_pink(){
        document.getElementById("backcolor").style.background = "pink";
    }
    function backcolor_skincolor(){
        document.getElementById("backcolor").style.background = "#fedcbd";
    }
    function backcolor_reset(){
        document.getElementById("backcolor").style.background = "";
    }

    function allwindow_close(){
        screen_open.style.display = "none";
        start_menu.style.display = "none";
        taskbar.style.display = "block";
        backcolor_menu.style.display = "none";
        program_menu.style.display = "none";
        app_menu.style.display = "none";
        setting_menu.style.display = "none";
        command_menu.style.display = "none";
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
    }
    
    function startmenu_close(){
        start_menu.style.display = "none";
        program_menu.style.display = "none";
        app_menu.style.display = "none";
    }
    function startmenu_open(){
        start_menu.style.display = "block";
    }

    function popupwindow_open(){
        popupwrap[0].style.display = "block";
    }
    function popupwindow_close(){
        popupwrap[0].style.display = "none";
    }

    function controlpanel_open(){
        controlpanel.style.display = "block";
    }
    function controlpanel_close(){
        controlpanel.style.display = "none";
    }

    function mycomputer_open(){
        mycomputer.style.display = "block";
    }
    function mycomputer_close(){
        mycomputer.style.display = "none";
        let myc = document.getElementsByClassName('myc');
            myc[0].classList.remove('task_bar');
    }

    function netmenu_open(){
        net.style.display = "block";
    }
    function netmenu_close(){
        net.style.display = "none";
    }

    function sound_open(){
        sound.style.display = "block";
    }
    function sound_close(){
        sound.style.display = "none";
    }

    function updatemenu_open(){
        updatemenu.style.display = "block";
    }
    function updatemenu_close(){
        updatemenu.style.display = "none";
    }

    function updownmenu_open(){
        updown_menu.style.display = "block";
    }
    function updownmenu_close(){
        updown_menu.style.display = "none";
    }

    function backcolormenu_close(){
        backcolor_menu.style.display = "none";
    }
    function backcolormenu_open(){
        backcolor_menu.style.display = "block";
    }

    function programmenu_close(){
        program_menu.style.display = "none";
        app_menu.style.display = "none";
    }
    function programmenu_open(){
        program_menu.style.display = "block";
    }

    function appmenu_open(){
        app_menu.style.display = "block";
    }
    function appmenu_close(){
        app_menu.style.display = "none";
    }

    function settingmenu_open(){
        setting_menu.style.display = "block";
    }
    function settingmenu_close(){
        setting_menu.style.display = "none";
    }

    function calc_open(){
        app_calc.style.display = "block";
    }

    function calc_close(){
        app_calc.style.display = "none";
    }

    function memo_open(){
        app_memo.style.display = "block";
    }
    function memo_close(){
        app_memo.style.display = "none";
    }

    function commandmenu_close(){
        command_menu.style.display = "none";
    }
    function commandmenu_open(){
        command_menu.style.display = "block";
    }

    function paint_close(){
        paint.style.display = "none";
    }
    function paint_open(){
        paint.style.display = "block";
    }

    function server_close(){
        server.style.display = "none";
    }
    function server_open(){
        server.style.display = "block";
    }

    function error_close(){
        error.style.display = "none";
    }
    function error_open(){
        error.style.display = "block";
    }

    function help_close(){
        help.style.display = "none";
    }
    function help_open(){
        help.style.display = "block";
    }

    function calendar_close(){
        calendar.style.display = "none";
    }
    function calendar_open(){
        calendar.style.display = "block";
        caload();
    }

    function check(){
        if (mail_form.mail.value === "Reload"){
            //条件に一致する場合(空の場合)
            alert('コマンドが実行されました！');
            window.location = '';
        }else{
            //条件に一致しない場合(入力されている場合)
            alert('コマンドが正しくありません！');
        }
    }
    
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

    function draggable(target) {
        target.onmousedown = function(event) {
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
            target.onmouseup = function() {
                document.removeEventListener('mousemove', onMouseMove);
                target.onmouseup = null;
            };
        };
    }

    let count = 0;
            // 図形にクリックイベント登録＆z-indexを表示
            let eleShape = document.getElementsByClassName("shape");
            for(var i=0; i< eleShape.length; i++){
                // クリックイベント登録
                eleShape[i].addEventListener("click", moveFront, event);
                // 図形にz-indexを表示
            }
            // クリックされた要素のz-indexに、クリックされた回数を設定する
            function moveFront(e){
                // 図形のクリック数をカウントアップ
                count++;
                // z-indexに図形のクリック数を設定（最前面に表示される）
                e.target.style.zIndex = count;
                // 図形にz-indexを表示
            }
               
    let ele = document.documentElement;

    function hoge() {

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

    function foo() {
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

window.onload = function() {
    
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
function changeColor(){

    gColor = document.getElementById('color').value;
    console.log(gColor);
    
}
// 描画開始
function startDraw(e){
    
    flgDraw = true;
    gX = e.offsetX;
    gY = e.offsetY;
    
}

// 描画
function Draw(e){
    
    if (flgDraw == true){
        
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
function endDraw(){
    
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
for(var canvasIndex in canvasList) {
        var canvas = canvasList[canvasIndex];
        canvas.width = document.documentElement.clientWidth; //Canvasのwidthをウィンドウの幅に合わせる
        canvas.height = 600;//波の高さ
        canvas.contextCache = canvas.getContext("2d");
    }
    // 共通の更新処理呼び出し
    update();
}

function update() {
    for(var canvasIndex in canvasList) {
        var canvas = canvasList[canvasIndex];
        // 各キャンバスの描画
        draw(canvas, colorList[canvasIndex]);
    }
    // 共通の描画情報の更新
    info.seconds = info.seconds + .014;
    info.t = info.seconds*Math.PI;
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
    var xAxis = Math.floor(canvas.height/2);
    var yAxis = 0;
    var context = canvas.contextCache;
    // Set the initial x and y, starting at 0,0 and translating to the origin on
    // the canvas.
    var x = t; //時間を横の位置とする
    var y = Math.sin(x)/zoom;
    context.moveTo(yAxis, unit*y+xAxis); //スタート位置にパスを置く

    // Loop to draw segments (横幅の分、波を描画)
    for (i = yAxis; i <= canvas.width + 10; i += 10) {
        x = t+(-yAxis+i)/unit/zoom;
        y = Math.sin(x - delay)/3;
        context.lineTo(i, unit*y+xAxis);
    }
}

init();

let counts = 1;
function hogee(){
  counts = counts + 0.01;
  backcolor.style.transform = "scale(" + counts + "," + counts + ")";
}

function fooo(){
  counts = counts - 0.01;
  backcolor.style.transform = "scale(" + counts + "," + counts + ")";
}


const week = ["日", "月", "火", "水", "木", "金", "土"];
const today = new Date();
// 月末だとずれる可能性があるため、1日固定で取得
var showDate = new Date(today.getFullYear(), today.getMonth(), 1);

// 初期表示
function caload () {
    showProcess(today, calendar);
};
// 前の月表示
function prev(){
    showDate.setMonth(showDate.getMonth() - 1);
    showProcess(showDate);
}

// 次の月表示
function next(){
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
                if(year == today.getFullYear()
                  && month == (today.getMonth())
                  && count == today.getDate()){
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
