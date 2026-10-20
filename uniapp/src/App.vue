<script>
export default {};
</script>

<style>
page {
  height: 100%;
  overflow: hidden;
  background: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}
/* Keep uni-app's page wrappers bounded so each panel scrolls independently. */
uni-page-body,
#app {
  height: 100%;
}
</style>
<style>
/* #ifdef H5 */
uni-scroll-view .uni-scroll-view::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}
uni-scroll-view .uni-scroll-view::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: #dce5de;
}
uni-scroll-view .uni-scroll-view::-webkit-scrollbar-track {
  background: transparent;
}
uni-scroll-view .uni-scroll-view::-webkit-scrollbar-button {
  display: none;
}
/* #endif */
</style>
