const path = require("path");
const environmentFile =
  process.env.NODE_ENV === "development" ? ".env.development" : ".env";
require("dotenv").config({
  path: path.resolve(__dirname, environmentFile),
});
require("./utils/logger")();
const { createCollectorApp } = require("./app");
const { wipeCollectorStorage } = require("./utils/files");
const port = require("./utils/http").getCollectorPort();
createCollectorApp()
  .listen(port, async () => {
    await wipeCollectorStorage();
    console.log(`Document processor app listening on port ${port}`);
  })
  .on("error", function (_) {
    process.once("SIGUSR2", function () {
      process.kill(process.pid, "SIGUSR2");
    });
    process.on("SIGINT", function () {
      process.kill(process.pid, "SIGINT");
    });
  });
