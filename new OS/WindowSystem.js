if(navigator.userAgent.match(/(iPhone|iPod|Android.*Mobile)/i)){
    no();
}else{
    // PC・タブレットの場合の処理を記述
    const alerttext = document.querySelector('.alerttext');
    alerttext.textContent = "お使いの端末がPCのため、ご利用可能です。";
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
    sound();
}else{
    alert('パスワードが正しくありません！');
}
}

        const element = document.getElementById('user');
        element.insertAdjacentHTML('afterend','<p class="user blacktext">BROWSER: '+ navigator.appName + '<br>' 
            + 'VERSION: ' + navigator.appVersion +  '<br>' + 'USER: ' + navigator.userAgent +  '<br>' + 'WIDTH: ' + screen.width +  '<br>' 
            + 'HEIGHT: ' + screen.height +  '<br>' + 'BIT: '  + screen.colorDepth + '</p>');
            
    const pass = document.querySelector('.pass_area');
    const popupwrap = document.getElementsByClassName('popupwrap');
    const screen_open = document.querySelector(".Windows95_group");
    const start_menu = document.querySelector(".start_menu");
    const taskbar = document.querySelector(".taskbar");
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
        
        function sound(){
            const sound = new Audio("https://github.com/moti5768/moti.world/raw/main/new%20OS/IMG_6946.mp3");
            sound.play();
        }

        function sound2() {
            const sound3 = new Audio("https://github.com/moti5768/moti.world/raw/main/new%20OS/IMG_6947.mp3");
            sound3.play();
        }

        function screen_close() {
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

    function update( _v ) // input tag を更新する関数
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
            update( f().toString() )
        } catch( _error ) {
            update( _error ) // 計算に失敗した場合は、そのエラーの内容を表示する
        }
    }

     function Credit() {
        const Credit = document.querySelector(".Credit");
        Credit.style.display = "block";
        setTimeout(() => {
            const Credit = document.querySelector(".Credit");
        Credit.style.display = "none";
    }, 2000);
};

    function colorbox(){
    if (document.getElementById("color_box").checked) {
        colorbtn.style.display = "none";
    } else {
        colorbtn.style.display = "inline";
    }
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
    }
    
    function startmenu_close(){
        start_menu.style.display = "none";
        program_menu.style.display = "none";
        app_menu.style.display = "none";
        setting_menu.style.display = "none";
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
    }

    function netmenu_open(){
        net.style.display = "block";
    }
    function netmenu_close(){
        net.style.display = "none";
    }

    function backcolormenu_close(){
        backcolor_menu.style.display = "none";
    }
    function backcolormenu_open(){
        backcolor_menu.style.display = "block";
    }

    function programmenu_close(){
        program_menu.style.display = "none";
    }
    function programmenu_open(){
        program_menu.style.display = "block";
    }

    function appmenu_open(){
        app_menu.style.display = "block";
        program_menu.style.display = "none";
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
            for(var i=0; i<eleShape.length; i++){
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
    var canvas = document.getElementById('canvas');
   
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
        var canvas = document.getElementById('canvas');
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
