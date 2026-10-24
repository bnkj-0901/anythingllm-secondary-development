/* global jest, beforeAll, afterAll, test, expect */
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const { requestJson } = require("./http-test-client.cjs");

let mockFixture, mockPgStore;
const mockStore = {
  get orm() {
    return mockFixture?.prisma;
  },
  all: (...args) => mockPgStore.all(...args),
  one: (...args) => mockPgStore.one(...args),
  run: (...args) => mockPgStore.run(...args),
  transaction: (...args) => mockPgStore.transaction(...args),
  id: () => require("crypto").randomUUID(),
  now: () => new Date().toISOString(),
};
jest.mock("../../enterprise/store", () => mockStore);
const settingsModule = require("../../enterprise/rag-settings");
const { DEFAULTS, validateSettings, getSettings, registerRagSettings } =
  settingsModule;
let temp, listener, base, oldEnvironment;
const tokens = {};

async function request(user, method = "GET", body, targetTenantId = null) {
  const claims = user ? jwt.decode(tokens[user]) : null;
  const tenant = claims?.tenantId
    ? await mockStore.one(
        "SELECT code FROM ep_tenants WHERE id=$1",
        claims.tenantId
      )
    : null;
  return requestJson(
    base +
      (targetTenantId
        ? `/platform/tenants/${targetTenantId}/rag-settings`
        : "/rag-settings"),
    {
      method,
      headers: {
        "content-type": "application/json",
        host: tenant ? `${tenant.code}.localhost` : "localhost",
        ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  );
}

beforeAll(async () => {
  oldEnvironment = {
    JWT_SECRET: process.env.JWT_SECRET,
    TENANT_BASE_DOMAIN: process.env.TENANT_BASE_DOMAIN,
    PLATFORM_HOSTS: process.env.PLATFORM_HOSTS,
  };
  process.env.JWT_SECRET = "rag-settings-isolated-secret";
  process.env.TENANT_BASE_DOMAIN = "localhost";
  process.env.PLATFORM_HOSTS = "localhost";
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-settings-"));
  mockFixture = await createPostgresFixture();
  mockPgStore = mockFixture.db;

  const stamp = new Date().toISOString();
  for (const id of ["a", "b"])
    await mockStore.run(
      'INSERT INTO ep_tenants(id,code,name,hostname,"createdAt","updatedAt") VALUES($1,$2,$3,$2 || \'.localhost\',$4,$5)',
      id,
      `tenant-${id}`,
      id,
      stamp,
      stamp
    );
  for (const [id, tenantId, role, userId] of [
    ["admin-a", "a", "admin", 1],
    ["member-a", "a", "user", 2],
    ["admin-b", "b", "admin", 3],
  ]) {
    await mockStore.run(
      'INSERT INTO users(id,"tenantId",username,name,"passwordHash",role,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())',
      userId,
      tenantId,
      id,
      id,
      "unused-hash",
      role
    );
    tokens[id] = jwt.sign(
      { identity: "tenant", tenantId, ver: 1 },
      process.env.JWT_SECRET,
      { audience: "enterprise-tenant-v1", subject: String(userId) }
    );
  }
  await mockStore.run(
    "INSERT INTO ep_platform_accounts(id,username,name,\"passwordHash\",\"createdAt\",\"updatedAt\") VALUES('platform','platform','平台','unused-hash',$1,$2)",
    stamp,
    stamp
  );
  tokens.platform = jwt.sign(
    { identity: "platform", ver: 1 },
    process.env.JWT_SECRET,
    { audience: "enterprise-platform-v1", subject: "platform" }
  );
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerRagSettings(router);
  app.use(router);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});

afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  if (
    temp &&
    path.resolve(temp).startsWith(path.resolve(os.tmpdir(), "rag-settings-"))
  )
    fs.rmSync(temp, { recursive: true, force: true });
  for (const [name, value] of Object.entries(oldEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("enterprise users can read effective settings while only top administration can change a target enterprise", async () => {
  expect((await request(null)).status).toBe(401);
  for (const identity of ["admin-a", "member-a", "admin-b"]) {
    expect((await request(identity)).status).toBe(200);
    expect(
      (await request(identity, "PATCH", { settings: { topK: 2 } })).status
    ).toBe(403);
    expect(
      (await request(identity, "PATCH", { settings: { topK: 2 } }, "a")).status
    ).toBe(401);
  }
  expect((await request("platform")).status).toBe(401);
  expect(await request("platform", "GET", undefined, "a")).toEqual({
    status: 200,
    body: { settings: DEFAULTS, defaults: DEFAULTS },
  });
  expect((await request("platform", "GET", undefined, "missing")).status).toBe(
    404
  );
});

test("defaults preserve original splitter, retrieval and model selection fields", () => {
  expect(DEFAULTS).toMatchObject({
    chatMode: "chat",
    chunkSize: 1000,
    chunkOverlap: 20,
    topK: 4,
    similarityThreshold: 0.25,
    rerank: false,
    embeddingCache: true,
  });
});

test("the original platform splitter settings apply to tenants without an override", async () => {
  await mockStore.run(
    "INSERT INTO system_settings(label,value,\"createdAt\",\"lastUpdatedAt\") VALUES('text_splitter_chunk_size','700',NOW(),NOW()),('text_splitter_chunk_overlap','40',NOW(),NOW())"
  );
  try {
    expect(await getSettings("a")).toEqual({
      ...DEFAULTS,
      chunkSize: 700,
      chunkOverlap: 40,
    });
    await mockStore.run(
      'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES(\'a\',$1,$2)',
      JSON.stringify({ ...DEFAULTS, chunkSize: 500, chunkOverlap: 30 }),
      new Date().toISOString()
    );
    expect((await getSettings("a")).chunkSize).toBe(500);
    expect((await getSettings("b")).chunkSize).toBe(700);
  } finally {
    await mockStore.run(
      "DELETE FROM system_settings WHERE label IN ('text_splitter_chunk_size','text_splitter_chunk_overlap')"
    );
    await mockStore.run("DELETE FROM ep_rag_settings WHERE \"tenantId\"='a'");
  }
});

test("partial edits persist per tenant and never change another tenant or existing indices", async () => {
  const before = await mockStore.all("SELECT * FROM ep_chunks");
  const change = await request(
    "platform",
    "PATCH",
    {
      tenantId: "b",
      settings: {
        chunkSize: 1000,
        chunkOverlap: 120,
        topK: 3,
        similarityThreshold: 0.6,
      },
    },
    "a"
  );
  expect(change.status).toBe(200);
  expect(await getSettings("a")).toEqual(change.body.settings);
  expect(await getSettings("b")).toEqual(DEFAULTS);
  expect(
    (await request("platform", "PATCH", { settings: { topK: 4 } }, "a")).body
      .settings
  ).toMatchObject({ topK: 4, chunkSize: 1000, chunkOverlap: 120 });
  expect(await mockStore.all("SELECT * FROM ep_chunks")).toEqual(before);
});

test("chat/query mode edits stay in the current tenant and preserve existing split/index settings", async () => {
  const before = await getSettings("a");
  const other = await getSettings("b");
  const changed = await request(
    "platform",
    "PATCH",
    {
      tenantId: "b",
      settings: { chatMode: "query" },
    },
    "a"
  );
  expect(changed.status).toBe(200);
  expect(changed.body.settings).toEqual({ ...before, chatMode: "query" });
  expect(await getSettings("b")).toEqual(other);
  expect(
    (
      await request("member-a", "PATCH", {
        settings: { chatMode: "chat" },
      })
    ).status
  ).toBe(403);
  expect((await getSettings("a")).chatMode).toBe("query");
  expect(
    (
      await request(
        "platform",
        "PATCH",
        {
          settings: { chatMode: "chat" },
        },
        "a"
      )
    ).status
  ).toBe(200);
});

test("a top administrator disabled while a settings write is queued cannot commit it", async () => {
  const prior = await getSettings("a");
  const transaction = mockStore.transaction;
  mockStore.transaction = async (operation) => {
    await mockStore.run(
      "UPDATE ep_platform_accounts SET status='disabled' WHERE id='platform'"
    );
    return transaction(operation);
  };
  try {
    const result = await request(
      "platform",
      "PATCH",
      {
        settings: { topK: 17 },
      },
      "a"
    );
    expect(result.status).toBe(401);
    expect(await getSettings("a")).toEqual(prior);
  } finally {
    mockStore.transaction = transaction;
    await mockStore.run(
      "UPDATE ep_platform_accounts SET status='active' WHERE id='platform'"
    );
  }
});

test.each([
  null,
  [],
  "bad",
  { unexpected: 1 },
  { toString: 1 },
  { constructor: 1 },
  { topK: 0 },
  { topK: Number.MAX_SAFE_INTEGER + 1 },
  { topK: 1.5 },
  { topK: "2" },
  { rerank: "true" },
  { embeddingCache: 1 },
  { chatMode: "agent" },
  { chatMode: null },
  { chatMode: 1 },
  { similarityThreshold: -0.1 },
  { similarityThreshold: 1.1 },
  { chunkSize: 0 },
  { chunkSize: 1.5 },
  { chunkOverlap: -1 },
  { chunkOverlap: 1001 },
  { contextBudget: 9000 },
  { chunkSize: 100, chunkOverlap: 100 },
])(
  "invalid parameter changes fail without replacing valid settings: %j",
  async (settings) => {
    const prior = await getSettings("a");
    expect((await request("platform", "PATCH", { settings }, "a")).status).toBe(
      400
    );
    expect(await getSettings("a")).toEqual(prior);
  }
);

test("boundaries, partial overlap validation and nonfinite values are enforced", () => {
  expect(
    validateSettings({
      chunkSize: 8000,
      chunkOverlap: 1000,
      topK: 20,
      similarityThreshold: 0,
    })
  ).toMatchObject({ chunkSize: 8000, topK: 20 });
  expect(() => validateSettings({ topK: NaN })).toThrow();
  expect(() => validateSettings({ similarityThreshold: Infinity })).toThrow();
  expect(() =>
    validateSettings({ chunkSize: 100 }, { ...DEFAULTS, chunkOverlap: 120 })
  ).toThrow("重叠");
  expect(validateSettings({})).toEqual(DEFAULTS);
});

test("ownership adaptation does not introduce product limits absent from the original settings", () => {
  const settings = {
    chunkSize: 16000,
    chunkOverlap: 1200,
    topK: 42,
    openAiHistory: 2000,
    openAiTemp: 3.1,
    openAiPrompt: "x".repeat(100001),
  };
  expect(validateSettings(settings)).toMatchObject(settings);
  expect(validateSettings({ chunkSize: 1, chunkOverlap: 0 })).toMatchObject({
    chunkSize: 1,
  });
});

test("corrupt persisted configuration fails closed without exposing its contents", async () => {
  for (const value of [
    "secret-corrupt-json",
    JSON.stringify({ topK: -5 }),
    JSON.stringify({ topK: 2, contextBudget: 9000 }),
    "null",
  ]) {
    await mockStore.run(
      'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES(\'b\',$1,$2) ON CONFLICT("tenantId") DO UPDATE SET settings=excluded.settings',
      value,
      new Date().toISOString()
    );
    const result = await request("admin-b");
    expect(result.status).toBe(503);
    expect(result.body.error).not.toContain("secret-corrupt-json");
  }
  await mockStore.run("DELETE FROM ep_rag_settings WHERE \"tenantId\"='b'");
});

test("tenant model, Agent, prompt and automatic mode retain original values under top ownership", async () => {
  const before = await getSettings("b");
  const settings = {
    chatMode: "automatic",
    chatProvider: "deepseek",
    chatModel: "deepseek-chat",
    agentProvider: "deepseek",
    agentModel: "deepseek-reasoner",
    openAiTemp: 0.7,
    openAiHistory: 30,
    openAiPrompt: "Tenant A prompt",
    queryRefusalResponse: "No matching knowledge",
  };
  expect((await request("platform", "PATCH", { settings }, "a")).status).toBe(
    200
  );
  expect(await getSettings("a")).toMatchObject(settings);
  expect(await getSettings("b")).toEqual(before);
  for (const [name, value] of [
    ["chatProvider", 123],
    ["openAiTemp", -1],
    ["openAiHistory", 1.5],
    ["router_id", -1],
  ]) {
    expect(
      (await request("platform", "PATCH", { settings: { [name]: value } }, "a"))
        .status
    ).toBe(400);
  }
  expect(
    (
      await request(
        "platform",
        "PATCH",
        { settings: { router_id: 2147483647 } },
        "a"
      )
    ).status
  ).toBe(400);
  expect(await getSettings("a")).toMatchObject(settings);
});

test("changing an enterprise prompt preserves the original history and only top administration may clear it", async () => {
  const prompt = "Previous enterprise prompt";
  expect(
    (
      await request(
        "platform",
        "PATCH",
        { settings: { openAiPrompt: prompt } },
        "a"
      )
    ).status
  ).toBe(200);
  expect(
    (
      await request(
        "platform",
        "PATCH",
        { settings: { openAiPrompt: "Updated enterprise prompt" } },
        "a"
      )
    ).status
  ).toBe(200);
  const history = await mockFixture.prisma.prompt_history.findMany({
    where: { tenantId: "a" },
  });
  expect(history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        tenantId: "a",
        prompt,
        modifiedBy: "platform",
      }),
    ])
  );
  expect(
    await mockFixture.prisma.prompt_history.findMany({
      where: { tenantId: "b" },
    })
  ).toEqual([]);
  const topHeaders = {
    host: "localhost",
    authorization: `Bearer ${tokens.platform}`,
  };
  const route = `${base}/platform/tenants/a/prompt-history`;
  expect(
    (await requestJson(route, { headers: topHeaders })).body.history
  ).toEqual(expect.arrayContaining([expect.objectContaining({ prompt })]));
  expect(
    (
      await requestJson(route, {
        method: "DELETE",
        headers: {
          host: "tenant-a.localhost",
          authorization: `Bearer ${tokens["member-a"]}`,
        },
      })
    ).status
  ).toBe(401);
  expect(
    (
      await requestJson(`${route}/invalid`, {
        method: "DELETE",
        headers: topHeaders,
      })
    ).status
  ).toBe(400);
  expect(
    (await requestJson(route, { method: "DELETE", headers: topHeaders })).body
      .success
  ).toBe(true);
  expect(
    await mockFixture.prisma.prompt_history.findMany({
      where: { tenantId: "a" },
    })
  ).toEqual([]);
});
