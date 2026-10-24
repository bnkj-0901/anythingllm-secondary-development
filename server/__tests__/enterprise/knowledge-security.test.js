const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const express = require("express");
const jwt = require("jsonwebtoken");
const { requestJson } = require("./http-test-client.cjs");
let mockFixture, mockPgStore;
const mockStore = {
  init: () => mockPgStore.init(),
  get orm() {
    return mockPgStore.orm;
  },
  all: (...args) => mockPgStore.all(...args),
  one: (...args) => mockPgStore.one(...args),
  run: (...args) => mockPgStore.run(...args),
  transaction: (...args) => mockPgStore.transaction(...args),
  id: () => require("crypto").randomUUID(),
  now: () => new Date().toISOString(),
};
const mockNativeInputs = [];
const mockNative = class {
  static supportedModels = { "test/prefix": {} };
  static availableModels() {
    return [{ id: "test/prefix", name: "Prefix test" }];
  }
  constructor(options) {
    this.options = options;
    this.queryPrefix = "query: ";
    this.embeddingPrefix = "passage: ";
  }
  async embedChunks(texts) {
    mockNativeInputs.push(texts);
    return texts.map(() => [1, 0]);
  }
};
const mockSdkCalls = [];
jest.mock("../../enterprise/store", () => mockStore);
jest.mock("../../utils/EmbeddingEngines/native", () => ({
  NativeEmbedder: mockNative,
}));
jest.mock("openai", () => {
  const OpenAI = jest.fn().mockImplementation((options) => ({
    embeddings: {
      create: async (body) => {
        mockSdkCalls.push({ options, body });
        if (body.model === "failing")
          throw Object.assign(
            new Error(`provider echoed secret ${options.apiKey}`),
            { status: 401 }
          );
        return {
          data: body.input.map((_, index) => ({ index, embedding: [1, 0] })),
        };
      },
    },
    chat: {
      completions: {
        create: async (body) => {
          mockSdkCalls.push({ options, body });
          return { choices: [{ message: { content: "OK" } }] };
        },
      },
    },
  }));
  return { OpenAI, AzureOpenAI: OpenAI };
});
const auth = require("../../enterprise/auth");
const providers = require("../../enterprise/providers");
const { registerSettings } = require("../../enterprise/settings");
let temp,
  listener,
  base,
  platform,
  ownerA,
  adminA,
  memberA,
  adminB,
  originalEnvironment;
const password = "SecurityTest-2026!";
async function request(token, url, method = "GET", body, loginHost) {
  const claims = token ? jwt.decode(token) : null;
  const tenant = claims?.tenantId
    ? await mockStore.one(
        "SELECT hostname FROM ep_tenants WHERE id=$1",
        claims.tenantId
      )
    : null;
  const host = loginHost || tenant?.hostname || "localhost";
  return requestJson(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      host,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(tenantCode, username) {
  const result = await request(
    null,
    "/login",
    "POST",
    { username, password },
    `${tenantCode}.localhost`
  );
  expect(result.status).toBe(200);
  return result.body;
}
beforeAll(async () => {
  originalEnvironment = Object.fromEntries(
    [
      "JWT_SECRET",
      "SIG_KEY",
      "SIG_SALT",
      "TENANT_BASE_DOMAIN",
      "PLATFORM_HOSTS",
    ].map((name) => [name, process.env[name]])
  );
  process.env.JWT_SECRET = "isolated-test-jwt-secret";
  process.env.SIG_KEY = "isolated-test-encryption-key";
  process.env.SIG_SALT = "isolated-test-encryption-salt";
  process.env.TENANT_BASE_DOMAIN = "localhost";
  process.env.PLATFORM_HOSTS = "localhost";
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-security-"));
  mockFixture = await createPostgresFixture();
  mockPgStore = mockFixture.db;

  await mockStore.run(
    'INSERT INTO ep_vector_settings(id,provider,config,revision,"updatedAt") VALUES(\'platform\',\'lancedb\',NULL,1,$1) ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider, config=EXCLUDED.config, revision=EXCLUDED.revision, "updatedAt"=EXCLUDED."updatedAt"',
    new Date().toISOString()
  );
  const app = express();
  app.use(express.json());
  const router = express.Router();
  auth.registerAuth(router);
  registerSettings(app);
  router.use((_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use(router);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
  await require("../../prisma/init").initializeAdministrator({
    prisma: mockFixture.prisma,
    environment: {
      INITIAL_ADMIN_USERNAME: "platform",
      INITIAL_ADMIN_NAME: "Platform",
      INITIAL_ADMIN_PASSWORD: password,
    },
  });
  const platformLogin = await request(null, "/platform/login", "POST", {
    username: "platform",
    password,
  });
  expect(platformLogin.status).toBe(200);
  platform = platformLogin.body;
  expect(
    (
      await request(platform.token, "/platform/tenants", "POST", {
        code: "company-a",
        hostname: "company-a.localhost",
        name: "A",
        adminUsername: "owner-a",
        adminPassword: password,
      })
    ).status
  ).toBe(201);
  expect(
    (
      await request(platform.token, "/platform/tenants", "POST", {
        code: "company-b",
        hostname: "company-b.localhost",
        name: "B",
        adminUsername: "admin-b",
        adminPassword: password,
      })
    ).status
  ).toBe(201);
  ownerA = await login("company-a", "owner-a");
  expect(
    (
      await request(ownerA.token, "/users", "POST", {
        username: "admin-a",
        name: "A Admin",
        password,
        role: "admin",
      })
    ).status
  ).toBe(201);
  expect(
    (
      await request(ownerA.token, "/users", "POST", {
        username: "member-a",
        password,
        role: "user",
      })
    ).status
  ).toBe(201);
  adminA = await login("company-a", "admin-a");
  memberA = await login("company-a", "member-a");
  adminB = await login("company-b", "admin-b");
}, 15000);
afterAll(async () => {
  await new Promise((resolve) => listener?.close(resolve));
  await mockFixture?.cleanup();
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("auth reads current roles and tenant status; untrusted fields cannot grant platform access", async () => {
  expect(
    (
      await request(ownerA.token, "/users", "POST", {
        username: "forged",
        password,
        tenantId: "another-enterprise",
      })
    ).status
  ).toBe(400);
  expect(memberA.identity).toBe("tenant");
  expect(platform.identity).toBe("platform");
  expect(platform.tenant).toBeNull();
  expect(memberA.tenant.id).toBe(ownerA.tenant.id);
  expect(
    (
      await request(null, "/setup", "POST", {
        tenantName: "forged",
        username: "attacker",
        password,
      })
    ).status
  ).toBe(404);
  expect((await request(memberA.token, "/users")).status).toBe(403);
  expect((await request(adminA.token, "/platform/tenants")).status).toBe(401);
  expect((await request(platform.token, "/users")).status).toBe(401);
  expect(
    (
      await request(adminA.token, `/users/${adminB.user.id}`, "PATCH", {
        role: "admin",
      })
    ).status
  ).toBe(404);
  expect(
    (
      await request(adminA.token, `/users/${platform.user.id}`, "PATCH", {
        status: "disabled",
      })
    ).status
  ).toBe(404);
  expect(
    (
      await request(ownerA.token, `/users/${adminA.user.id}`, "PATCH", {
        role: "user",
      })
    ).status
  ).toBe(200);
  expect((await request(adminA.token, "/users")).status).toBe(401);
  await request(ownerA.token, `/users/${adminA.user.id}`, "PATCH", {
    role: "admin",
  });
  adminA = await login("company-a", "admin-a");
  expect(
    (
      await request(
        platform.token,
        `/platform/tenants/${adminB.tenant.id}`,
        "PATCH",
        { status: "disabled" }
      )
    ).status
  ).toBe(200);
  expect((await request(adminB.token, "/me")).status).toBe(401);
  expect((await request(platform.token, "/platform/me")).status).toBe(200);
  await request(
    platform.token,
    `/platform/tenants/${adminB.tenant.id}`,
    "PATCH",
    { status: "active" }
  );
});

test("shared platform embedding stays encrypted and enterprise execution does not mix private inputs", async () => {
  const form = (name, model = "text-embedding") => ({
    EmbeddingEngine: "generic-openai",
    EmbeddingModelPref: model,
    EmbeddingBasePath: "https://platform.test.invalid/v1",
    GenericOpenAiEmbeddingApiKey: `api-key-${name}`,
  });
  const save = (token, fields) =>
    request(token, "/api/system/update-env", "POST", fields);
  const result = await save(platform.token, form("shared"));
  expect(result.status).toBe(200);
  expect(JSON.stringify(result.body)).not.toContain("api-key-");
  for (const user of [adminA, adminB, memberA])
    expect((await save(user.token, form("forged"))).status).toBe(403);
  expect(
    (
      await save(adminA.token, {
        ...form("forged"),
        tenantId: adminB.tenant.id,
      })
    ).status
  ).toBe(403);
  expect(
    (await request(adminA.token, "/connections", "POST", form("obsolete")))
      .status
  ).toBe(404);
  const [ca, cb] = await Promise.all([
    providers.resolveConnection({ tenantId: adminA.tenant.id }, "embedding"),
    providers.resolveConnection({ tenantId: adminB.tenant.id }, "embedding"),
  ]);
  expect(ca.id).toBe(cb.id);
  const encrypted = await mockStore.one(
    "SELECT secret FROM ep_connections WHERE id=$1",
    ca.id
  );
  expect(encrypted.secret).not.toContain("api-key-shared");
  await Promise.all([
    providers.embed(ca, ["A private input"]),
    providers.embed(cb, ["B private input"]),
  ]);
  expect(
    mockSdkCalls
      .slice(-2)
      .map((call) => [
        call.options.baseURL,
        call.options.apiKey,
        call.body.input[0],
      ])
  ).toEqual(
    expect.arrayContaining([
      ["https://platform.test.invalid/v1", "api-key-shared", "A private input"],
      ["https://platform.test.invalid/v1", "api-key-shared", "B private input"],
    ])
  );
  expect(
    (await save(platform.token, form("shared", "version-two"))).status
  ).toBe(200);
  for (const tenantId of [adminA.tenant.id, adminB.tenant.id]) {
    const next = await providers.resolveConnection({ tenantId }, "embedding");
    expect(next.id).toBe(ca.id);
    expect(next.version).toBe(ca.version + 1);
  }
  expect((await save(platform.token, form("shared", "failing"))).status).toBe(
    200
  );
  const failing = await providers.resolveConnection(
    { tenantId: adminA.tenant.id },
    "embedding"
  );
  await expect(providers.embed(failing, ["fail"])).rejects.toMatchObject({
    status: 502,
  });
  try {
    await providers.embed(failing, ["fail"]);
  } catch (error) {
    expect(error.message).not.toContain("api-key-shared");
  }
});

test("native document and query prefixes use separate explicit inputs", async () => {
  const connection = {
    id: "native",
    version: 1,
    provider: "native",
    config: { model: "test/prefix" },
  };
  await providers.embed(connection, ["stored document"]);
  await providers.embed(connection, ["search question"], { query: true });
  expect(mockNativeInputs).toEqual([
    ["passage: stored document"],
    ["query: search question"],
  ]);
});
