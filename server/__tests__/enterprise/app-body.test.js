const http = require("http");
jest.mock("../../enterprise", () => ({ registerEnterprise: jest.fn() }));
jest.mock("../../enterprise/media", () => ({ registerMedia: jest.fn() }));
jest.mock("../../enterprise/settings", () => ({
  registerSettings: jest.fn(),
  requireTenantConfiguration: (_req, _res, next) => next(),
}));
jest.mock("../../endpoints/agentWebsocket", () => ({
  agentWebsocket: jest.fn(),
}));
jest.mock("../../endpoints/external", () => ({ registerExternal: jest.fn() }));
const { createApp } = require("../../app");
let listener, base;

beforeAll(async () => {
  listener = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});
afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
});

function request(route, contentType, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      base + route,
      {
        method: "POST",
        headers: {
          "content-type": contentType,
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test.each([
  "application/json",
  "text/plain",
  "application/x-www-form-urlencoded",
])(
  "anonymous embed requests retain the original 1MB parser bound for %s",
  async (type) => {
    const large = "x".repeat(1024 * 1024 + 1);
    const body =
      type === "application/x-www-form-urlencoded"
        ? `message=${large}`
        : JSON.stringify({ message: large });
    const response = await request("/api/embed/fixture", type, body);
    expect(response).toEqual({ status: 413, body: { error: "请求内容过大" } });
    // The global parser keeps its original size and must not inherit the
    // anonymous widget restriction from the preceding scoped middleware.
    expect((await request("/api/body-parser-fixture", type, body)).status).toBe(
      404
    );
  }
);

test.each(["application/json", "text/plain"])(
  "small valid %s embed JSON passes parsing and malformed JSON fails at the body boundary",
  async (type) => {
    expect(
      (await request("/api/embed/fixture", type, '{"message":"hello"}')).status
    ).toBe(404);
    expect(await request("/api/embed/fixture", type, '{"message":')).toEqual({
      status: 400,
      body: { error: "请求正文格式无效" },
    });
  }
);
