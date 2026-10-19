// Local-only adapter; upstream server and collector sources remain unchanged.
// Their default listen() binds all interfaces, and CollectorApi targets 0.0.0.0,
// which Windows cannot use as an outgoing destination.
const net = require("node:net");
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === "number" || /^\d+$/.test(args[0])) {
    if (typeof args[1] === "function" || args[1] === undefined) {
      args.splice(1, 0, "127.0.0.1");
    }
  }
  return originalListen.apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === "0.0.0.0") {
    url.hostname = "127.0.0.1";
    input = input instanceof Request ? new Request(url, input) : url;
  }
  return originalFetch.call(this, input, options);
};

const path = require("node:path");
const serverEntry = path.resolve(__dirname, "../../vendor/anythingllm/server/index.js");
if (process.argv[1] && path.resolve(process.argv[1]) === serverEntry) {
  require("./access/runtime.cjs").installAccess();
}
