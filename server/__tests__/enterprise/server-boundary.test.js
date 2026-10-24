jest.mock("../../enterprise/store", () => ({
  init: jest.fn(async () => {}),
  all: jest.fn(async () => []),
  one: jest.fn(async (sql) =>
    sql.includes("ep_vector_settings")
      ? {
          id: "platform",
          provider: "lancedb",
          config: null,
          revision: 1,
          updatedAt: "2026-10-21T00:00:00.000Z",
        }
      : null
  ),
}));
const { createApp } = require("../../app");
const store = require("../../enterprise/store");
const fs = require("fs");
const os = require("os");
const path = require("path");

let listener, base;
beforeAll(async () => {
  process.env.JWT_SECRET = "boundary-test-secret";
  listener = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});

test("production serves upstream generated metadata and assets without turning unknown APIs into HTML", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "enterprise-static-")
  );
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    PUBLIC_DIR: process.env.PUBLIC_DIR,
    PLATFORM_HOSTS: process.env.PLATFORM_HOSTS,
  };
  let productionListener;
  try {
    fs.writeFileSync(
      path.join(directory, "_index.html"),
      "<!doctype html><title>Upstream build</title>"
    );
    fs.writeFileSync(path.join(directory, "asset.js"), "/* upstream asset */");
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_DIR = directory;
    process.env.PLATFORM_HOSTS = "localhost,127.0.0.1";
    productionListener = createApp().listen(0, "127.0.0.1");
    await new Promise((resolve) =>
      productionListener.once("listening", resolve)
    );
    const productionBase = `http://127.0.0.1:${productionListener.address().port}`;
    for (const route of ["/", "/client-route"]) {
      const response = await fetch(`${productionBase}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("/index.js");
    }
    expect(await (await fetch(`${productionBase}/asset.js`)).text()).toBe(
      "/* upstream asset */"
    );
    const unknownApi = await fetch(`${productionBase}/api/workspaces`);
    expect(unknownApi.status).toBe(404);
    expect(await unknownApi.json()).toEqual({ error: "接口不存在" });
  } finally {
    if (productionListener)
      await new Promise((resolve) => productionListener.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
afterAll(async () => new Promise((resolve) => listener.close(resolve)));

test("the running server exposes health and authenticated enterprise APIs without the replaced Workspace and global user routes", async () => {
  expect(await (await fetch(`${base}/api/ping`)).json()).toEqual({
    online: true,
    product: "enterprise-v1",
  });
  expect((await fetch(`${base}/api/enterprise/libraries`)).status).toBe(401);
  for (const endpoint of [
    "/api/workspace",
    "/api/workspaces",
    "/api/admin/users",
  ]) {
    const response = await fetch(`${base}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "接口不存在" });
  }
  // The developer API remains an original authenticated capability; its old
  // endpoint cannot be treated as an intentionally removed product feature.
  expect((await fetch(`${base}/api/v1/workspaces`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"})).status).toBe(403);
});

test.each(["application/json", "text/plain;charset=UTF-8"])(
  "malformed JSON using %s is rejected by the app parser",
  async (contentType) => {
    const response = await fetch(`${base}/api/system/update-env`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: '{"LLMProvider":',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "请求正文格式无效" });
  }
);

test("upstream text/plain JSON is not restricted by an added 8 MiB limit", async () => {
  const response = await fetch(`${base}/api/system/update-env`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ value: "x".repeat(8 * 1024 * 1024) }),
  });
  expect(response.status).toBe(401);
});

test.each([
  { code: "P2002" },
  { code: "P2010", meta: { code: "23505" } },
  { code: "P2034" },
  { code: "P2010", meta: { code: "40001" } },
  { code: "40P01" },
  { code: "P2010", meta: { code: "40P01" } },
])(
  "database conflict %j returns a safe retryable response",
  async (details) => {
    const raw = "database connection secret must never be returned";
    store.one.mockRejectedValueOnce(Object.assign(new Error(raw), details));
    const response = await fetch(`${base}/api/enterprise/status`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "账号已存在或配置发生冲突",
    });
  }
);

// Restored upstream modules may be imported as libraries.
// The HTTP assertions above enforce the executable authorization boundary.
