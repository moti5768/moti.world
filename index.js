const app = new Vue({
  el: "#app",
  data: {
    count: 0 * 24 * 60 * 60
  },
  created() {
   setInterval(() => {
     this.count = this.count + 1
    }, 1000)
   $("#test").text(new Date())
  }
})
