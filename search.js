function check(){
  if (search_form.search.value == "#test#"){
    alert('コマンドが実行されました!')
    return true;
  }else{(search_form.search.value == "")
  alert('コマンドが正しく入力されていません!')
    return false;
  }
}
