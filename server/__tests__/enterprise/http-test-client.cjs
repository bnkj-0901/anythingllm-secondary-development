const http = require("http");

// Native http preserves a deliberate Host header. Some bundled fetch runtimes
// replace it with the socket URL, which would skip the real domain boundary.
function requestJson(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        content += chunk;
      });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(content) });
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}
module.exports = { requestJson };
