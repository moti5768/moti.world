const app = new Vue({
  el: "#app",
  data: {
    count: 0 * 24 * 60 * 60
  },
  created() {
   setInterval(() => {
     this.count = this.count + 1
    }, 1000)
   $("#time").text(new Date().toLocaleString());
  }
})

function color1(){
    document.getElementById("color").classList.remove("addColor-red")
    document.getElementById("color").classList.remove("addColor-blue")
    document.getElementById("color").classList.remove("addColor-green")
    document.getElementById("color").classList.remove("addColor-yellow")
    document.getElementById("color").classList.remove("addColor-black")
    document.getElementById("color").classList.remove("addColor-darkmode")
    document.getElementById("color").classList.add("addColor-red");
}
function color2(){
    document.getElementById("color").classList.remove("addColor-red")
    document.getElementById("color").classList.remove("addColor-blue")
    document.getElementById("color").classList.remove("addColor-green")
    document.getElementById("color").classList.remove("addColor-yellow")
    document.getElementById("color").classList.remove("addColor-black")
    document.getElementById("color").classList.remove("addColor-darkmode")
    document.getElementById('color').classList.add('addColor-blue');
}
function color3(){
    document.getElementById("color").classList.remove("addColor-red")
    document.getElementById("color").classList.remove("addColor-blue")
    document.getElementById("color").classList.remove("addColor-green")
    document.getElementById("color").classList.remove("addColor-yellow")
    document.getElementById("color").classList.remove("addColor-black")
    document.getElementById("color").classList.remove("addColor-darkmode")
    document.getElementById('color').classList.add('addColor-green');
}
function color4(){
    document.getElementById("color").classList.remove("addColor-red")
    document.getElementById("color").classList.remove("addColor-blue")
    document.getElementById("color").classList.remove("addColor-green")
    document.getElementById("color").classList.remove("addColor-yellow")
    document.getElementById("color").classList.remove("addColor-black")
    document.getElementById("color").classList.remove("addColor-darkmode")
    document.getElementById('color').classList.add('addColor-yellow');
}
function color5(){
    document.getElementById("color").classList.remove("addColor-red")
    document.getElementById("color").classList.remove("addColor-blue")
    document.getElementById("color").classList.remove("addColor-green")
    document.getElementById("color").classList.remove("addColor-yellow")
    document.getElementById("color").classList.remove("addColor-black")
    document.getElementById("color").classList.remove("addColor-darkmode")
    document.getElementById('color').classList.add('addColor-black');
}

function darkmode(){
    document.getElementById("color").classList.remove("addColor-red")
    document.getElementById("color").classList.remove("addColor-blue")
    document.getElementById("color").classList.remove("addColor-green")
    document.getElementById("color").classList.remove("addColor-yellow")
    document.getElementById("color").classList.remove("addColor-black")
    document.getElementById("color").classList.remove("addColor-darkmode")
    document.getElementById('color').classList.add('addColor-darkmode');
}




function v0122a(){
    alert('ホームページ設立・説明　各リンク先追加')
}
function v0123a(){
    alert('デザイン変更・更新情報　サイト情報追加')
}
function v0124a(){
    alert('画面下部に次ページ　ボタン追加')
}
function v0125a(){
    alert('コマンド入力欄を追加 (試験的)')
}
function v0126a(){
    alert('配布所・リストページ　設立')
}
function v0127a(){
    alert('経過時間　現在時刻を追加 (試験的)　プロフィールの追加')
}
function v0207a(){
    alert('目次など様々な機能の追加(デザイン調整を含む)')
}
function v0210a(){
    alert('メニュー欄を表示した際に一部ボタンが手前に出てた問題の修正　その他機能の追加・微調整')
}
function v0214a(){
    alert('文字色変更ボタンの追加・微調整')
}
