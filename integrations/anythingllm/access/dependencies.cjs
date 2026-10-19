const path = require("node:path");
const { createRequire } = require("node:module");
const serverDirectory = process.env.KB_ACCESS_SERVER_DIR || path.resolve(__dirname, "../../../vendor/anythingllm/server");
const requireServer = createRequire(path.join(serverDirectory, "package.json"));
module.exports = { requireServer, serverDirectory };
