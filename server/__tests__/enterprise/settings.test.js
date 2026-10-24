/* global jest, beforeAll, beforeEach, afterAll, test, expect */
const jwt = require("jsonwebtoken");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const { requestJson } = require("./http-test-client.cjs");
let mockFixture;
const mockStore = {
  init: () => mockFixture.db.init(),
  get orm() {
    return mockFixture?.prisma;
  },
  one: (...args) => mockFixture.db.one(...args),
  all: (...args) => mockFixture.db.all(...args),
  run: (...args) => mockFixture.db.run(...args),
  transaction: (...args) => mockFixture.db.transaction(...args),
  id: () => require("crypto").randomUUID(),
  now: () => new Date().toISOString(),
};
jest.mock("../../enterprise/store", () => mockStore);
jest.mock(
  "../../utils/prisma",
  () =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          const value = mockFixture?.prisma[key];
          return typeof value === "function"
            ? value.bind(mockFixture.prisma)
            : value;
        },
      }
    )
);
const {
  defaultPrompt,
  loadPlatformEnvironment,
  environment,
} = require("../../enterprise/settings");
const { createApp } = require("../../app");
const providers = require("../../enterprise/providers");
const { allowedRules } = require("../../enterprise/settings-environment");
const {
  connectionEnvironment,
  runConnection,
  env,
} = require("../../enterprise/ai/connection-context");
let listener, base, originals, storageRoot;
const userIds = { a: 1, b: 2, member: 3 };
const ctx = (tenant = "a") => ({
  identity: "tenant",
  tenantId: tenant,
  userId: userIds[tenant],
  username: `admin-${tenant}`,
  role: "admin",
  authVersion: 1,
});
const token = (id, identity, tenantId) =>
  jwt.sign(
    { identity, ver: 1, ...(tenantId ? { tenantId } : {}) },
    process.env.JWT_SECRET,
    {
      subject: String(id),
      audience:
        identity === "platform"
          ? "enterprise-platform-v1"
          : "enterprise-tenant-v1",
    }
  );
async function request(identity, route, method = "GET", body, host) {
  const tenant =
    identity === "platform" ? null : identity === "member" ? "a" : identity;
  const id =
    identity === "platform"
      ? "platform"
      : identity === "member"
        ? userIds.member
        : userIds[identity];
  return requestJson(`${base}/api${route}`, {
    method,
    headers: {
      host: host || (tenant ? `settings-${tenant}.localhost` : "localhost"),
      "content-type": "application/json",
      ...(identity
        ? {
            authorization: `Bearer ${token(id, tenant ? "tenant" : "platform", tenant)}`,
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function rawRequest(
  identity,
  route,
  { method = "GET", body, headers = {}, host } = {}
) {
  const tenant =
    identity === "platform" ? null : identity === "member" ? "a" : identity;
  const id =
    identity === "platform"
      ? "platform"
      : identity === "member"
        ? userIds.member
        : userIds[identity];
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      `${base}/api${route}`,
      {
        method,
        headers: {
          host: host || (tenant ? `settings-${tenant}.localhost` : "localhost"),
          ...(identity
            ? {
                authorization: `Bearer ${token(id, tenant ? "tenant" : "platform", tenant)}`,
              }
            : {}),
          ...headers,
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          })
        );
        incoming.on("error", reject);
      }
    );
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}
async function serveUpstream(handler, action) {
  const upstream = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((resolve) => upstream.once("listening", resolve));
  try {
    await action(`http://127.0.0.1:${upstream.address().port}`);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
}
const chat = {
  LLMProvider: "deepseek",
  DeepSeekModelPref: "deepseek-chat",
  DeepSeekApiKey: "settings-secret-chat",
};
beforeAll(async () => {
  originals = { ...process.env };
  process.env.JWT_SECRET = "settings-test-jwt";
  process.env.SIG_KEY = "settings-test-encryption";
  process.env.SIG_SALT = "settings-test-salt";
  process.env.PLATFORM_HOSTS = "localhost";
  process.env.TENANT_BASE_DOMAIN = "localhost";
  storageRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "anythingllm-settings-test-")
  );
  process.env.STORAGE_DIR = storageRoot;
  for (const { envKey } of Object.values(allowedRules()))
    delete process.env[envKey];
  mockFixture = await createPostgresFixture();
  for (const id of ["a", "b"]) {
    await mockStore.run(
      'INSERT INTO ep_tenants(id,code,name,hostname,"createdAt","updatedAt") VALUES($1,$2,$1,$2 || \'.localhost\',NOW(),NOW())',
      id,
      `settings-${id}`
    );
    await mockStore.run(
      "UPDATE ep_tenants SET hostname=$1 WHERE id=$2",
      `settings-${id}.localhost`,
      id
    );
    await mockStore.run(
      'INSERT INTO users(id,"tenantId",username,name,"passwordHash",role,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$3,\'unused\',\'admin\',NOW(),NOW())',
      userIds[id],
      id,
      `admin-${id}`
    );
  }
  await mockStore.run(
    "INSERT INTO users(id,\"tenantId\",username,name,\"passwordHash\",role,\"createdAt\",\"lastUpdatedAt\") VALUES(3,'a','member','member','unused','user',NOW(),NOW())"
  );
  await mockStore.run(
    "INSERT INTO ep_platform_accounts(id,username,name,\"passwordHash\",\"createdAt\",\"updatedAt\") VALUES('platform','platform','platform','unused',NOW(),NOW())"
  );
  const app = createApp();
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});
beforeEach(async () => {
  await mockStore.run("DELETE FROM system_settings");
  await mockStore.run("DELETE FROM ep_connections");
  await mockStore.run("DELETE FROM ep_rag_settings");
  await mockStore.run("DELETE FROM event_logs");
  await mockStore.run("DELETE FROM system_prompt_variables");
  await mockStore.run(
    "INSERT INTO ep_vector_settings(id,provider,config,revision,\"updatedAt\") VALUES('platform','lancedb',NULL,1,NOW()) ON CONFLICT(id) DO UPDATE SET provider='lancedb',config=NULL,revision=1"
  );
  for (const { envKey } of Object.values(allowedRules()))
    delete process.env[envKey];
});
afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  if (
    storageRoot &&
    path.dirname(storageRoot) === path.resolve(os.tmpdir()) &&
    path.basename(storageRoot).startsWith("anythingllm-settings-test-")
  )
    fs.rmSync(storageRoot, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (!(key in originals)) delete process.env[key];
  Object.assign(process.env, originals);
});

test("the original footer reads the deployment version without exposing global storage or configuration", async () => {
  const previous = process.env.DEPLOYMENT_VERSION;
  try {
    process.env.DEPLOYMENT_VERSION = "1.18.0";
    expect((await request(null, "/utils/metrics")).body).toEqual({
      appVersion: "1.18.0",
    });
  } finally {
    if (previous === undefined) delete process.env.DEPLOYMENT_VERSION;
    else process.env.DEPLOYMENT_VERSION = previous;
  }
});

test("original setup contract requires host-bound auth and returns only safe voice settings to members", async () => {
  expect((await request(null, "/setup-complete")).status).toBe(200);
  expect(
    (
      await request(
        "a",
        "/setup-complete",
        "GET",
        undefined,
        "settings-b.localhost"
      )
    ).status
  ).toBe(401);
  expect(
    (
      await request(
        "a",
        "/setup-complete",
        "GET",
        undefined,
        "unknown.localhost"
      )
    ).status
  ).toBe(401);
  const member = await request("member", "/setup-complete");
  expect(member.status).toBe(200);
  expect(member.body.results).toMatchObject({
    SpeechToTextProvider: "native",
    TextToSpeechProvider: "native",
  });
  expect(member.body.results).not.toHaveProperty("DeepSeekApiKey");
  expect(member.body.results).not.toHaveProperty("LLMProvider");
  expect(
    (await request("member", "/system/update-env", "POST", chat)).status
  ).toBe(403);
});

test("setup reflects the original persisted Memory preferences without forcing them off", async () => {
  await mockStore.run(
    "INSERT INTO system_settings(label,value) VALUES('memory_enabled','true'),('memory_auto_extraction','false')"
  );
  expect(
    (await request("platform", "/setup-complete")).body.results
  ).toMatchObject({
    MemoryEnabled: true,
    MemoryAutoExtraction: false,
  });
  expect(
    (await request("member", "/setup-complete")).body.results.MemoryEnabled
  ).toBe(true);
  await mockStore.run(
    "UPDATE system_settings SET value='false' WHERE label='memory_enabled'"
  );
  expect(
    (await request("platform", "/setup-complete")).body.results.MemoryEnabled
  ).toBe(false);
});

test("original LLM form writes the same encrypted default connection used by RAG", async () => {
  const saved = await request("platform", "/system/update-env", "POST", chat);
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({
    error: false,
    newValues: { DeepSeekApiKey: true },
  });
  expect(JSON.stringify(saved.body)).not.toContain(chat.DeepSeekApiKey);
  const row = await mockStore.one(
    "SELECT * FROM ep_connections WHERE scope='platform'"
  );
  expect(row).toMatchObject({
    scope: "platform",
    kind: "chat",
    provider: "deepseek",
    model: "deepseek-chat",
    isDefault: 1,
  });
  expect(row.secret).not.toContain(chat.DeepSeekApiKey);
  expect((await providers.resolveConnection(ctx(), "chat")).config.apiKey).toBe(
    chat.DeepSeekApiKey
  );
  const visible = await request("a", "/setup-complete");
  expect(visible.body.results).toMatchObject({
    LLMProvider: "deepseek",
    DeepSeekModelPref: "deepseek-chat",
    DeepSeekApiKey: true,
  });
  expect(JSON.stringify(visible.body)).not.toContain(chat.DeepSeekApiKey);
  expect(
    (await request("b", "/setup-complete")).body.results.DeepSeekApiKey
  ).toBe(true);
});

test("blank and masked original secret inputs preserve a same-scope credential", async () => {
  await request("platform", "/system/update-env", "POST", chat);
  const row = await mockStore.one(
    "SELECT * FROM ep_connections WHERE scope='platform'"
  );
  for (const key of ["", "********"]) {
    expect(
      (
        await request("platform", "/system/update-env", "POST", {
          ...chat,
          DeepSeekApiKey: key,
        })
      ).status
    ).toBe(200);
    const after = await mockStore.one(
      "SELECT * FROM ep_connections WHERE id=$1",
      row.id
    );
    expect(providers.hydrate(after).config.apiKey).toBe(chat.DeepSeekApiKey);
  }
});

test("tenant users cannot create or overwrite shared credentials, including masked keys", async () => {
  expect(
    (await request("platform", "/system/update-env", "POST", chat)).status
  ).toBe(200);
  for (const identity of ["a", "b", "member"]) {
    expect(
      (
        await request(identity, "/system/update-env", "POST", {
          ...chat,
          DeepSeekApiKey: "",
        })
      ).status
    ).toBe(403);
  }
  expect(
    await mockStore.one(
      'SELECT id FROM ep_connections WHERE "tenantId" IS NOT NULL'
    )
  ).toBeNull();
  expect((await providers.resolveConnection(ctx(), "chat")).config.apiKey).toBe(
    chat.DeepSeekApiKey
  );
});

test("original Embedding form retains generic endpoint and prefix fields in the original runtime", async () => {
  const saved = await request("platform", "/system/update-env", "POST", {
    EmbeddingEngine: "generic-openai",
    EmbeddingModelPref: "text-embedding-v3",
    EmbeddingBasePath: "https://example.test/v1",
    GenericOpenAiEmbeddingApiKey: "embedding-secret",
    GenericOpenAiEmbeddingPassagePrefix: "document: ",
    GenericOpenAiEmbeddingQueryPrefix: "query: ",
    GenericOpenAiEmbeddingMaxConcurrentChunks: "20",
  });
  expect(saved.status).toBe(200);
  const row = await mockStore.one(
    "SELECT * FROM ep_connections WHERE scope='platform'"
  );
  const connection = providers.hydrate(row);
  expect(connection.config).toMatchObject({
    baseUrl: "https://example.test/v1",
    model: "text-embedding-v3",
    apiKey: "embedding-secret",
    options: {
      batchSize: 20,
      documentPrefix: "document: ",
      queryPrefix: "query: ",
    },
  });
  expect(connectionEnvironment(connection)).toMatchObject({
    GENERIC_OPEN_AI_EMBEDDING_PASSAGE_PREFIX: "document: ",
  });
  expect((await request("a", "/setup-complete")).body.results).toMatchObject({
    EmbeddingEngine: "generic-openai",
    EmbeddingModelPref: "text-embedding-v3",
    GenericOpenAiEmbeddingApiKey: true,
  });
});

test("embedding credentials and batching preserve the vector space while model and prefix changes invalidate it", async () => {
  const draft = {
    EmbeddingEngine: "generic-openai",
    EmbeddingModelPref: "text-embedding-v3",
    EmbeddingBasePath: "https://example.test/v1",
    GenericOpenAiEmbeddingApiKey: "first-key",
  };
  expect(
    (await request("platform", "/system/update-env", "POST", draft)).status
  ).toBe(200);
  const current = () =>
    mockStore.one("SELECT * FROM ep_connections WHERE kind='embedding'");
  const initial = await current();
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        EmbeddingEngine: "generic-openai",
        GenericOpenAiEmbeddingApiKey: "rotated-key",
        GenericOpenAiEmbeddingMaxConcurrentChunks: "10",
      })
    ).status
  ).toBe(200);
  expect((await current()).version).toBe(initial.version);
  expect(providers.hydrate(await current()).config.apiKey).toBe("rotated-key");
  for (const [offset, update] of [
    { EmbeddingModelPref: "different-model" },
    { GenericOpenAiEmbeddingPassagePrefix: "document: " },
    { EmbeddingOutputDimensions: "512" },
  ].entries()) {
    expect(
      (
        await request("platform", "/system/update-env", "POST", {
          EmbeddingEngine: "generic-openai",
          ...update,
        })
      ).status
    ).toBe(200);
    expect((await current()).version).toBe(initial.version + offset + 1);
  }
});

test("anonymous setup exposes only the original public SSO settings on a recognized site", async () => {
  process.env.SIMPLE_SSO_ENABLED = "true";
  process.env.SIMPLE_SSO_NO_LOGIN = "true";
  process.env.SIMPLE_SSO_NO_LOGIN_REDIRECT = "https://sso.example.test/login";
  try {
    await request("platform", "/system/update-env", "POST", chat);
    for (const host of ["localhost", "settings-a.localhost"]) {
      const result = await request(
        null,
        "/setup-complete",
        "GET",
        undefined,
        host
      );
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        results: {
          SimpleSSOEnabled: true,
          SimpleSSONoLogin: true,
          SimpleSSONoLoginRedirect: "https://sso.example.test/login",
        },
      });
    }
    expect(
      (
        await request(
          null,
          "/setup-complete",
          "GET",
          undefined,
          "unknown.localhost"
        )
      ).status
    ).toBe(404);
  } finally {
    delete process.env.SIMPLE_SSO_ENABLED;
    delete process.env.SIMPLE_SSO_NO_LOGIN;
    delete process.env.SIMPLE_SSO_NO_LOGIN_REDIRECT;
  }
});

test("repeated original form editing preserves canonical values and extra settings", async () => {
  await request("platform", "/system/update-env", "POST", {
    LLMProvider: "anthropic",
    AnthropicModelPref: "claude-sonnet-4-6",
    AnthropicApiKey: "sk-ant-settings-secret",
    AnthropicCacheControl: "1h",
  });
  const row = await mockStore.one(
    "SELECT * FROM ep_connections WHERE scope='platform'"
  );
  const updated = await request("platform", "/system/update-env", "POST", {
    LLMProvider: "anthropic",
    AnthropicModelPref: "claude-next",
  });
  expect(updated.status).toBe(200);
  const current = await mockStore.one(
    "SELECT * FROM ep_connections WHERE id=$1",
    row.id
  );
  const connection = providers.hydrate(current);
  expect(connection.config.model).toBe("claude-next");
  expect(connection.config.upstreamEnvironment.ANTHROPIC_CACHE_CONTROL).toBe(
    "1h"
  );
  expect(
    (await request("a", "/setup-complete")).body.results.AnthropicModelPref
  ).toBe("claude-next");
  expect(runConnection(connection, {}, () => env.ANTHROPIC_MODEL_PREF)).toBe(
    "claude-next"
  );
});

test("runtime environment rejects arbitrary process variables even if stored encrypted", async () => {
  const bad = {
    kind: "chat",
    provider: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    options: "{}",
    secret: providers.encrypt(
      JSON.stringify({
        apiKey: "safe",
        upstreamEnvironment: { JWT_SECRET: "override" },
      })
    ),
  };
  expect(() => providers.hydrate(bad)).toThrow();
});

test("original field validation rejects unknown and reserved values without partial writes", async () => {
  for (const body of [
    { JWTSecret: "change" },
    { DATABASE_URL: "change" },
    { LLMProvider: "unknown" },
    { ...chat, AnthropicCacheControl: "invalid" },
  ]) {
    const response = await request(
      "platform",
      "/system/update-env",
      "POST",
      body
    );
    expect([400, 403]).toContain(response.status);
    expect(
      await mockStore.one(
        "SELECT id FROM ep_connections WHERE scope='platform'"
      )
    ).toBeNull();
  }
});

test("platform audio config survives process restart while tenant mutations never alter global environment", async () => {
  const saved = await request("platform", "/system/update-env", "POST", {
    TextToSpeechProvider: "generic-openai",
    TTSOpenAICompatibleEndpoint: "https://speech.test/v1",
    TTSOpenAICompatibleKey: "speech-secret",
    TTSOpenAICompatibleModel: "tts-1",
  });
  expect(saved.status).toBe(200);
  expect(process.env.TTS_OPEN_AI_COMPATIBLE_KEY).toBe("speech-secret");
  delete process.env.TTS_OPEN_AI_COMPATIBLE_KEY;
  await loadPlatformEnvironment();
  expect(process.env.TTS_OPEN_AI_COMPATIBLE_KEY).toBe("speech-secret");
  const secret = await mockStore.one(
    "SELECT value FROM system_settings WHERE label='saas:environment'"
  );
  expect(secret.value).not.toContain("speech-secret");
  expect((await request("a", "/system/update-env", "POST", chat)).status).toBe(
    403
  );
  expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
  expect(
    (await request("member", "/setup-complete")).body.results
      .TextToSpeechProvider
  ).toBe("generic-openai");
});

test("top administrator maintains shared branding and prompts while enterprise users cannot overwrite them", async () => {
  expect(
    (
      await request("platform", "/admin/system-preferences", "POST", {
        custom_app_name: "Shared",
        default_system_prompt: "Shared prompt",
      })
    ).status
  ).toBe(200);
  for (const identity of ["a", "b", "member"]) {
    expect(
      (
        await request(identity, "/admin/system-preferences", "POST", {
          custom_app_name: "Forged",
          default_system_prompt: "Forged prompt",
        })
      ).status
    ).toBe(403);
  }
  for (const host of ["settings-a.localhost", "settings-b.localhost"]) {
    expect(
      (await request(null, "/system/custom-app-name", "GET", undefined, host))
        .body.customAppName
    ).toBe("Shared");
  }
  expect(
    (
      await request(
        null,
        "/system/custom-app-name",
        "GET",
        undefined,
        "unknown.localhost"
      )
    ).status
  ).toBe(404);
  expect(await defaultPrompt(ctx())).toBe("Shared prompt");
  expect(await defaultPrompt(ctx("b"))).toBe("Shared prompt");
});

test("original splitter settings remain shared defaults and reject invalid overlap atomically", async () => {
  const body = {
    text_splitter_chunk_size: 700,
    text_splitter_chunk_overlap: 40,
  };
  expect(
    (await request("platform", "/admin/system-preferences", "POST", body))
      .status
  ).toBe(200);
  const { getSettings } = require("../../enterprise/rag-settings");
  expect(await getSettings("a")).toMatchObject({
    chunkSize: 700,
    chunkOverlap: 40,
  });
  expect(await getSettings("b")).toMatchObject({
    chunkSize: 700,
    chunkOverlap: 40,
  });
  expect(
    (
      await request(
        "platform",
        "/admin/system-preferences-for?labels=text_splitter_chunk_size,text_splitter_chunk_overlap"
      )
    ).body.settings
  ).toEqual({
    text_splitter_chunk_size: "700",
    text_splitter_chunk_overlap: "40",
  });
  expect(
    (
      await request("platform", "/admin/system-preferences", "POST", {
        text_splitter_chunk_overlap: 800,
      })
    ).status
  ).toBe(400);
  expect((await getSettings("a")).chunkOverlap).toBe(40);
  expect(
    await mockStore.one(
      'SELECT settings FROM ep_rag_settings WHERE "tenantId"=$1',
      "a"
    )
  ).toBeNull();
});

test("platform configuration event logs redact values and are restricted to top administration", async () => {
  await request("platform", "/system/update-env", "POST", chat);
  const logs = await request("platform", "/system/event-logs", "POST", {
    offset: 0,
  });
  expect(logs.status).toBe(200);
  expect(logs.body.totalLogs).toBe(1);
  expect(logs.body.logs[0].user.username).toBe("platform");
  expect(JSON.stringify(logs.body)).not.toContain(chat.DeepSeekApiKey);
  for (const identity of ["a", "b", "member"]) {
    expect(
      (await request(identity, "/system/event-logs", "POST", {})).status
    ).toBe(403);
    expect(
      (await request(identity, "/system/event-logs", "DELETE")).status
    ).toBe(403);
  }
  expect(
    (await request("platform", "/system/event-logs", "DELETE")).status
  ).toBe(200);
  expect(
    (await request("platform", "/system/event-logs", "POST", {})).body.logs.map(
      (log) => log.event
    )
  ).toEqual(["event_logs_cleared"]);
});

test("platform prompt variables retain original CRUD and are not tenant-editable", async () => {
  const created = await request(
    "platform",
    "/system/prompt-variables",
    "POST",
    { key: "company_label", value: "Shared company", description: "test" }
  );
  expect(created.status).toBe(200);
  expect(created.body.success).toBe(true);
  const id = created.body.variable.id;
  expect(
    (
      await request("a", "/system/prompt-variables", "POST", {
        key: "other_key",
        value: "no",
      })
    ).status
  ).toBe(403);
  const listed = await request("platform", "/system/prompt-variables");
  expect(
    listed.body.variables.some((entry) => entry.key === "company_label")
  ).toBe(true);
  expect(
    listed.body.variables.some((entry) => entry.key.startsWith("workspace."))
  ).toBe(false);
  expect(
    (
      await request("platform", `/system/prompt-variables/${id}`, "PUT", {
        key: "company_label",
        value: "Updated",
      })
    ).body.success
  ).toBe(true);
  expect(
    (await request("platform", `/system/prompt-variables/${id}`, "DELETE")).body
      .success
  ).toBe(true);
});

test("prompt editor retains placeholders and RAG expands platform variables with the current SaaS identity", async () => {
  await request("platform", "/system/prompt-variables", "POST", {
    key: "review_company",
    value: "Example",
  });
  const prompt =
    "For {review_company}, answer {user.name} ({user.id}) on {date}.";
  expect(
    (
      await request("platform", "/system/default-system-prompt", "POST", {
        defaultSystemPrompt: prompt,
      })
    ).status
  ).toBe(200);
  expect(
    (await request("a", "/system/default-system-prompt")).body
      .defaultSystemPrompt
  ).toBe(prompt);
  const expanded = await defaultPrompt(ctx());
  expect(expanded).toContain("For Example, answer admin-a (1) on ");
  expect(expanded).not.toContain("{date}");
  expect(expanded).not.toContain("{user.name}");
});

test("prompt expansion retains username meaning with tenant-scoped profiles and excludes Workspace fields", async () => {
  const id = 4;
  await mockStore.run(
    "INSERT INTO users(id,\"tenantId\",username,name,\"passwordHash\",role,\"createdAt\",\"lastUpdatedAt\") VALUES($1,'a','prompt-user','Display $& {date}','unused','user',NOW(),NOW())",
    id
  );
  await mockStore.run(
    "UPDATE users SET bio=$1 WHERE id=$2",
    "Tenant A profile",
    id
  );
  const prompt = "{user.name} ({user.id}) | {workspace.name} | {user.bio}";
  try {
    expect(
      (
        await request("platform", "/system/default-system-prompt", "POST", {
          defaultSystemPrompt: prompt,
        })
      ).status
    ).toBe(200);
    expect(await defaultPrompt({ ...ctx(), userId: id })).toBe(
      `prompt-user (${id}) | {workspace.name} | Tenant A profile`
    );
    const variables =
      require("../../models/systemPromptVariables").SystemPromptVariables;
    expect(
      await variables.expandSystemPromptVariables("{user.name}", id, {
        tenantId: "b",
        db: mockFixture.prisma,
      })
    ).toBe("[User name is empty or unknown]");
    const read = await request("a", "/system/prompt-variables");
    const keys = read.body.variables.map((variable) => variable.key);
    for (const key of ["workspace.name", "workspace.id"])
      expect(keys).not.toContain(key);
    expect(keys).toContain("user.bio");
  } finally {
    await mockStore.run("DELETE FROM users WHERE id=$1", id);
  }
});

test("shared OpenAI fields select the current editor's actual default connection", async () => {
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        LLMProvider: "openai",
        OpenAiKey: "sk-settings-chat",
        OpenAiModelPref: "gpt-4.1-mini",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        EmbeddingEngine: "openai",
        OpenAiKey: "sk-settings-embedding",
        EmbeddingModelPref: "text-embedding-3-small",
      })
    ).status
  ).toBe(200);
  expect(
    (await request("a", "/setup-complete")).body.results.OpenAiModelPref
  ).toBe("gpt-4.1-mini");
  expect((await environment(ctx(), mockStore, false, "chat")).OPEN_AI_KEY).toBe(
    "sk-settings-chat"
  );
  expect(
    (await environment(ctx(), mockStore, false, "embedding")).OPEN_AI_KEY
  ).toBe("sk-settings-embedding");
  expect(
    (await request("a", "/setup-complete?purpose=embedding")).body.results
      .OpenAiKey
  ).toBe(true);
});

test("Azure original default model type and supported Gemini dimensions map to the existing runtime", async () => {
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        LLMProvider: "azure",
        AzureOpenAiEndpoint: "https://azure.example.test",
        AzureOpenAiKey: "azure-secret",
        AzureOpenAiModelPref: "gpt-deployment",
        AzureOpenAiModelType: "default",
        AzureOpenAiTokenLimit: "8192",
      })
    ).status
  ).toBe(200);
  const chatRow = await mockStore.one(
    "SELECT * FROM ep_connections WHERE scope='platform' AND kind='chat'"
  );
  expect(providers.hydrate(chatRow).config.options).toMatchObject({
    deployment: "gpt-deployment",
    modelType: "chat",
    contextWindow: 8192,
  });
  expect(
    (await request("a", "/setup-complete")).body.results.AzureOpenAiModelType
  ).toBe("default");
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        EmbeddingEngine: "gemini",
        GeminiEmbeddingApiKey: "gemini-secret",
        EmbeddingModelPref: "gemini-embedding-001",
        EmbeddingOutputDimensions: "768",
      })
    ).status
  ).toBe(200);
  const embedding = providers.hydrate(
    await mockStore.one(
      "SELECT * FROM ep_connections WHERE scope='platform' AND kind='embedding'"
    )
  );
  expect(embedding.config.options.dimensions).toBe(768);
  expect(connectionEnvironment(embedding).EMBEDDING_OUTPUT_DIMENSIONS).toBe(
    768
  );
});

test("original public logo-state contract and metadata validation retain tenant boundaries", async () => {
  expect(
    (
      await request(
        null,
        "/system/is-default-logo",
        "GET",
        undefined,
        "settings-a.localhost"
      )
    ).body
  ).toEqual({ isDefaultLogo: true });
  expect(
    (
      await request("platform", "/admin/system-preferences", "POST", {
        meta_page_favicon: "javascript:alert(1)",
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("platform", "/admin/system-preferences", "POST", {
        meta_page_favicon: "bad url",
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("platform", "/admin/system-preferences", "POST", {
        hub_api_key: "blocked",
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("platform", "/system/custom-models", "POST", {
        provider: "deepseek",
        options: "bad",
      })
    ).status
  ).toBe(400);
});

test("switching original provider forms restores only credentials previously saved in the same scope", async () => {
  expect(
    (await request("platform", "/system/update-env", "POST", chat)).status
  ).toBe(200);
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        LLMProvider: "anthropic",
        AnthropicApiKey: "sk-ant-own-secret",
        AnthropicModelPref: "claude-sonnet-4-6",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        LLMProvider: "deepseek",
        DeepSeekApiKey: "********",
      })
    ).status
  ).toBe(200);
  const own = await providers.resolveConnection(ctx(), "chat");
  expect(own.config.apiKey).toBe(chat.DeepSeekApiKey);
  expect(own.config.model).toBe(chat.DeepSeekModelPref);
  expect(own.config.upstreamEnvironment.ANTHROPIC_API_KEY).toBeUndefined();
  expect(
    (await request("platform", "/system/update-env", "POST", chat)).status
  ).toBe(200);
  expect(
    (
      await request("b", "/system/update-env", "POST", {
        LLMProvider: "deepseek",
        DeepSeekApiKey: "********",
      })
    ).status
  ).toBe(403);
});

test("original native embedding selection uses supported defaults and does not retain a remote credential", async () => {
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        EmbeddingEngine: "openai",
        OpenAiKey: "sk-embed-settings",
        EmbeddingModelPref: "text-embedding-3-small",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        EmbeddingEngine: "native",
      })
    ).status
  ).toBe(200);
  const native = await providers.resolveConnection(ctx(), "embedding");
  expect(native.provider).toBe("native");
  expect(native.config.apiKey).toBe("");
  expect(native.config.model).toBe(
    require("../../utils/EmbeddingEngines/native").NativeEmbedder._getEmbeddingModel()
  );
});

test("switching chat providers cannot silently copy the embedding key from an original shared field", async () => {
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        LLMProvider: "openai",
        OpenAiKey: "sk-chat-first",
        OpenAiModelPref: "gpt-4.1-mini",
      })
    ).status
  ).toBe(200);
  expect(
    (await request("platform", "/system/update-env", "POST", chat)).status
  ).toBe(200);
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        EmbeddingEngine: "openai",
        OpenAiKey: "sk-embedding-only",
        EmbeddingModelPref: "text-embedding-3-small",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        LLMProvider: "openai",
        OpenAiKey: "********",
      })
    ).status
  ).toBe(400);
  expect((await providers.resolveConnection(ctx(), "chat")).provider).toBe(
    "deepseek"
  );
  expect(
    (await providers.resolveConnection(ctx(), "embedding")).config.apiKey
  ).toBe("sk-embedding-only");
});

test("a plain default prompt never queries the original identity or variable tables", async () => {
  await request("platform", "/system/default-system-prompt", "POST", {
    defaultSystemPrompt: "Answer with tenant context.",
  });
  const variables =
    require("../../models/systemPromptVariables").SystemPromptVariables;
  const lookup = jest.spyOn(variables, "getAll");
  try {
    expect(await defaultPrompt(ctx())).toBe("Answer with tenant context.");
    expect(lookup).not.toHaveBeenCalled();
  } finally {
    lookup.mockRestore();
  }
});

test("prompt variable reads redact static values outside the platform and reject malformed or conflicting writes", async () => {
  const created = await request(
    "platform",
    "/system/prompt-variables",
    "POST",
    { key: "private_label", value: "platform-value" }
  );
  const id = created.body.variable.id;
  for (const actor of ["a", "member"]) {
    const read = await request(actor, "/system/prompt-variables");
    expect(
      read.body.variables.find((variable) => variable.key === "user.name").value
    ).toBe("");
    expect(
      read.body.variables.find((variable) => variable.key === "private_label")
        .value
    ).toBe("");
    expect(JSON.stringify(read.body)).not.toContain("platform-value");
  }
  for (const body of [
    { key: "new_label", value: "" },
    { key: "new_label", value: {} },
    { key: "new_label", value: "v", description: [] },
    { key: "user.id", value: "v" },
    { key: "private_label", value: "duplicate" },
  ])
    expect(
      (await request("platform", "/system/prompt-variables", "POST", body))
        .status
    ).toBe(400);
  for (const invalid of ["0", "-1", "1.5", "abc", "2147483648"])
    expect(
      (
        await request(
          "platform",
          `/system/prompt-variables/${invalid}`,
          "PUT",
          { key: "new_label", value: "v" }
        )
      ).status
    ).toBe(400);
  expect(
    (
      await request("platform", "/system/prompt-variables/2147483647", "PUT", {
        key: "new_label",
        value: "v",
      })
    ).status
  ).toBe(404);
  const second = await request("platform", "/system/prompt-variables", "POST", {
    key: "second_label",
    value: "second",
  });
  expect(
    (
      await request(
        "platform",
        `/system/prompt-variables/${second.body.variable.id}`,
        "PUT",
        { key: "private_label", value: "v" }
      )
    ).status
  ).toBe(400);
  expect(
    (await rawRequest("platform", `/system/prompt-variables/${id}`)).status
  ).toBe(404);
});

test("public branding APIs keep original field names and per-domain values", async () => {
  await request("platform", "/admin/system-preferences", "POST", {
    custom_app_name: "Shared App",
    support_email: "support@example.test",
    footer_data: JSON.stringify([
      { text: "Shared", href: "https://example.test" },
    ]),
  });
  await request("platform", "/admin/system-preferences", "POST", {
    custom_app_name: "Shared App",
    support_email: "support@example.test",
  });
  for (const [route, field, own, shared] of [
    ["custom-app-name", "customAppName", "Shared App", "Shared App"],
    [
      "support-email",
      "supportEmail",
      "support@example.test",
      "support@example.test",
    ],
  ]) {
    expect(
      (
        await request(
          null,
          `/system/${route}`,
          "GET",
          undefined,
          "settings-a.localhost"
        )
      ).body
    ).toEqual({ [field]: own });
    expect(
      (
        await request(
          null,
          `/system/${route}`,
          "GET",
          undefined,
          "settings-b.localhost"
        )
      ).body
    ).toEqual({ [field]: shared });
  }
  expect(
    (
      await request(
        null,
        "/system/footer-data",
        "GET",
        undefined,
        "settings-b.localhost"
      )
    ).body.footerData
  ).toBeTruthy();
});

test("original logo upload, download and removal require top administration and serve shared branding", async () => {
  const platformImage = await require("sharp")({
    create: { width: 2, height: 2, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const tenantImage = await require("sharp")({
    create: { width: 3, height: 2, channels: 4, background: "blue" },
  })
    .png()
    .toBuffer();
  const upload = async (
    identity,
    content,
    filename = "logo.png",
    mime = "image/png"
  ) => {
    const boundary = "settings-upload-boundary";
    return rawRequest(identity, "/system/upload-logo", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="logo"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
        ),
        content,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  };
  expect((await upload("platform", platformImage)).status).toBe(200);
  const logoFilename = async () =>
    (
      await mockStore.one(
        "SELECT value FROM system_settings WHERE label='logo_filename'"
      )
    ).value;
  const firstFile = await logoFilename();
  expect((await upload("member", tenantImage)).status).toBe(403);
  expect((await upload("a", tenantImage)).status).toBe(403);
  const own = await rawRequest(null, "/system/logo", {
    host: "settings-a.localhost",
  });
  const shared = await rawRequest(null, "/system/logo", {
    host: "settings-b.localhost",
  });
  expect(own.status).toBe(200);
  expect(shared.status).toBe(200);
  expect(own.headers["x-is-custom-logo"]).toBe("true");
  expect(own.body).toEqual(platformImage);
  expect(shared.body).toEqual(platformImage);
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>'
  );
  expect(
    (await upload("platform", svg, "logo.svg", "image/svg+xml")).status
  ).toBe(200);
  const replacement = await logoFilename();
  expect(replacement).toMatch(/\.svg$/);
  expect(fs.existsSync(path.join(storageRoot, "assets", firstFile))).toBe(
    false
  );
  expect(
    (await rawRequest(null, "/system/logo", { host: "settings-a.localhost" }))
      .body
  ).toEqual(svg);
  expect((await request("member", "/system/remove-logo")).status).toBe(403);
  expect((await request("a", "/system/remove-logo")).status).toBe(403);
  expect((await request("platform", "/system/remove-logo")).status).toBe(200);
  expect(fs.existsSync(path.join(storageRoot, "assets", replacement))).toBe(
    false
  );
  expect(
    (
      await request(
        null,
        "/system/is-default-logo",
        "GET",
        undefined,
        "settings-a.localhost"
      )
    ).body
  ).toEqual({ isDefaultLogo: true });
  // The isolated asset directory has no packaged default logo.
  expect(
    (await rawRequest(null, "/system/logo", { host: "settings-a.localhost" }))
      .status
  ).toBe(204);
  expect(
    (await rawRequest(null, "/system/logo", { host: "unknown.localhost" }))
      .status
  ).toBe(404);
});

test("original Foundry capabilities probe the scoped platform runtime without allowing tenants to manage it", async () => {
  const requests = [];
  await serveUpstream(
    (req, res) => {
      requests.push(req.url);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    },
    async (url) => {
      expect(
        (
          await request("platform", "/system/update-env", "POST", {
            FoundryBasePath: `${url}/v1`,
          })
        ).status
      ).toBe(200);
      expect(
        (await request("platform", "/utils/foundry/capabilities", "POST", {}))
          .body
      ).toEqual({ source: "rest", canManage: true });
      expect(requests).toEqual(["/foundry/list"]);
      expect(
        (
          await request("a", "/utils/foundry/capabilities", "POST", {
            basePath: url,
          })
        ).status
      ).toBe(403);
      expect(
        (await request("member", "/utils/foundry/capabilities", "POST", {}))
          .status
      ).toBe(403);
      expect(requests).toHaveLength(1);
    }
  );
});

test("original Lemonade download SSE and delete reuse platform runtime credentials and block tenant writes", async () => {
  const requests = [];
  await serveUpstream(
    (req, res) => {
      let text = "";
      req.on("data", (chunk) => {
        text += chunk;
      });
      req.on("end", () => {
        requests.push({
          path: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(text),
        });
        if (req.url === "/api/v1/pull")
          res
            .writeHead(200, { "content-type": "text/event-stream" })
            .end(
              'event: progress\ndata: {"percent":25,"file":"weights"}\n\nevent: complete\ndata: {}\n\n'
            );
        else
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ status: "success", message: "deleted" }));
      });
    },
    async (url) => {
      expect(
        (
          await request("platform", "/system/update-env", "POST", {
            LemonadeLLMBasePath: `${url}/api/v1`,
            LemonadeLLMApiKey: "lemonade-platform-test",
          })
        ).status
      ).toBe(200);
      for (const actor of ["a", "member"])
        for (const operation of ["download", "delete"])
          expect(
            (
              await request(
                actor,
                `/utils/lemonade/${operation}-model`,
                "POST",
                { modelId: "local-model", basePath: url }
              )
            ).status
          ).toBe(403);
      expect(requests).toHaveLength(0);
      const downloaded = await rawRequest(
        "platform",
        "/utils/lemonade/download-model",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelId: "local-model",
            basePath: `${url}/api/v1`,
          }),
        }
      );
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers["content-type"]).toContain("text/event-stream");
      expect(downloaded.body.toString()).toContain(
        '"type":"progress","percentage":25'
      );
      expect(downloaded.body.toString()).toContain(
        '"type":"success","percentage":100'
      );
      expect(downloaded.body.toString()).not.toContain(
        "lemonade-platform-test"
      );
      expect(
        (
          await request("platform", "/utils/lemonade/delete-model", "POST", {
            modelId: "local-model",
            basePath: `${url}/api/v1`,
          })
        ).body
      ).toEqual({ success: true, message: "deleted" });
      expect(requests).toEqual([
        {
          path: "/api/v1/pull",
          authorization: "Bearer lemonade-platform-test",
          body: { model_name: "local-model", stream: true },
        },
        {
          path: "/api/v1/delete",
          authorization: "Bearer lemonade-platform-test",
          body: { model_name: "local-model" },
        },
      ]);
    }
  );
});

test("original model discovery uses the shared platform connection and does not forward its key to an edited endpoint", async () => {
  const calls = [];
  await serveUpstream(
    (req, res) => {
      calls.push({ path: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          data: [{ id: "local-test-model", owned_by: "local" }],
        })
      );
    },
    async (url) => {
      expect(
        (
          await request("platform", "/system/update-env", "POST", {
            LLMProvider: "generic-openai",
            GenericOpenAiBasePath: `${url}/v1`,
            GenericOpenAiKey: "sk-platform-models",
            GenericOpenAiModelPref: "local-test-model",
          })
        ).status
      ).toBe(200);
      const discovered = await request(
        "platform",
        "/system/custom-models",
        "POST",
        { provider: "generic-openai" }
      );
      expect(discovered.body).toEqual({
        models: [
          {
            id: "local-test-model",
            name: "local-test-model",
            organization: "local",
          },
        ],
        error: null,
      });
      expect(calls).toEqual([
        { path: "/v1/models", authorization: "Bearer sk-platform-models" },
      ]);
      for (const identity of ["a", "b", "member"])
        expect(
          (
            await request(identity, "/system/custom-models", "POST", {
              provider: "generic-openai",
            })
          ).status
        ).toBe(403);
      expect(calls).toHaveLength(1);
      expect(process.env.GENERIC_OPEN_AI_API_KEY).toBe("sk-platform-models");
      expect(
        (
          await request("platform", "/system/custom-models", "POST", {
            provider: "generic-openai",
            basePath: `${url}/edited`,
          })
        ).status
      ).toBe(200);
      expect(calls[1].authorization).not.toMatch(/sk-platform-models/);
      expect(
        (
          await request("platform", "/system/custom-models", "POST", {
            provider: "unsupported",
          })
        ).body.error
      ).toBeTruthy();
    }
  );
});

test("upstream fetch text/plain JSON works through the full app for discovery and settings saves", async () => {
  async function post(identity, route, body) {
    const response = await rawRequest(identity, route, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return JSON.parse(response.body.toString());
  }
  const calls = [];
  await serveUpstream(
    (req, res) => {
      calls.push({ path: req.url, authorization: req.headers.authorization });
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({ data: [{ id: "browser-model", owned_by: "local" }] })
        );
    },
    async (url) => {
      await post("platform", "/system/update-env", {
        LLMProvider: "generic-openai",
        GenericOpenAiBasePath: `${url}/v1`,
        GenericOpenAiKey: "browser-test-key",
        GenericOpenAiModelPref: "browser-model",
      });
      const discovered = await post("platform", "/system/custom-models", {
        provider: "generic-openai",
        apiKey: null,
        basePath: `${url}/v1`,
        purpose: "chat",
        options: {},
      });
      expect(discovered.models).toEqual([
        { id: "browser-model", name: "browser-model", organization: "local" },
      ]);
      expect(calls).toEqual([
        { path: "/v1/models", authorization: "Bearer browser-test-key" },
      ]);
      expect(
        (await request("a", "/setup-complete")).body.results
      ).toMatchObject({
        GenericOpenAiModelPref: "browser-model",
        GenericOpenAiKey: true,
      });
    }
  );
  await post("platform", "/admin/system-preferences", {
    custom_app_name: "Browser App",
  });
  expect(
    (await request("a", "/system/custom-app-name")).body.customAppName
  ).toBe("Browser App");
  await post("platform", "/system/default-system-prompt", {
    defaultSystemPrompt: "Browser prompt.",
  });
  expect(await defaultPrompt(ctx())).toBe("Browser prompt.");
  const created = await post("platform", "/system/prompt-variables", {
    key: "browser_label",
    value: "browser-value",
  });
  expect(created.variable).toMatchObject({
    key: "browser_label",
    value: "browser-value",
  });
});

test("original vector form maps and masks platform connection fields while preserving blank saved keys", async () => {
  const calls = [];
  await serveUpstream(
    (req, res) => {
      calls.push({ path: req.url, key: req.headers["api-key"] });
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ok: true,
          result: { status: "disabled" },
          status: "ok",
          time: 0,
          version: "1.18.0",
        })
      );
    },
    async (url) => {
      expect(
        (
          await request("platform", "/system/update-env", "POST", {
            VectorDB: "qdrant",
            QdrantEndpoint: url,
            QdrantApiKey: "qdrant-settings-key",
          })
        ).status
      ).toBe(200);
      const read = await request("platform", "/setup-complete");
      expect(read.body.results).toMatchObject({
        VectorDB: "qdrant",
        QdrantEndpoint: url,
        QdrantApiKey: true,
      });
      expect(JSON.stringify(read.body)).not.toContain("qdrant-settings-key");
      expect(
        (await request("a", "/setup-complete")).body.results
      ).not.toHaveProperty("QdrantApiKey");
      expect(
        (
          await request("platform", "/system/update-env", "POST", {
            VectorDB: "qdrant",
            QdrantEndpoint: url,
            QdrantApiKey: "",
          })
        ).status
      ).toBe(200);
      expect(
        calls.some(
          (entry) =>
            entry.path === "/cluster" && entry.key === "qdrant-settings-key"
        )
      ).toBe(true);
      const stored = await mockStore.one(
        "SELECT config FROM ep_vector_settings WHERE id='platform'"
      );
      expect(JSON.parse(providers.decrypt(stored.config)).apiKey).toBe(
        "qdrant-settings-key"
      );
      expect(
        (
          await request("platform", "/system/update-env", "POST", {
            VectorDB: "qdrant",
            LLMProvider: "deepseek",
          })
        ).status
      ).toBe(400);
    }
  );
});

test("settings validation rolls back invalid primitives and independent original form submissions", async () => {
  for (const body of [
    [],
    null,
    { LLMProvider: {} },
    { LLMProvider: "deep\0seek" },
    { LLMProvider: "x".repeat(32769) },
    { LLMProvider: "deepseek", EmbeddingEngine: "native" },
  ])
    expect(
      (await request("platform", "/system/update-env", "POST", body)).status
    ).toBe(400);
  for (const body of [
    [],
    null,
    { custom_app_name: {} },
    { custom_app_name: "x".repeat(32769) },
  ])
    expect(
      (await request("platform", "/admin/system-preferences", "POST", body))
        .status
    ).toBe(400);
  expect(
    await mockStore.one("SELECT id FROM ep_connections WHERE scope='platform'")
  ).toBeNull();
  expect((await rawRequest("a", "/system/check-token")).status).toBe(200);
});

test("preference reads retain original maximum chunk limits and platform splitter defaults", async () => {
  expect(
    (
      await request("platform", "/admin/system-preferences", "POST", {
        text_splitter_chunk_size: 600,
        text_splitter_chunk_overlap: 30,
        custom_app_name: "Platform",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request(
        "platform",
        "/admin/system-preferences-for?labels=text_splitter_chunk_size,text_splitter_chunk_overlap,custom_app_name,unknown"
      )
    ).body.settings
  ).toEqual({
    text_splitter_chunk_size: "600",
    text_splitter_chunk_overlap: "30",
    custom_app_name: "Platform",
  });
  expect(
    (
      await request(
        "platform",
        "/admin/system-preferences-for?labels=max_embed_chunk_size"
      )
    ).body.settings
  ).toEqual({ max_embed_chunk_size: 1000 });
  expect(
    (
      await request("platform", "/system/update-env", "POST", {
        EmbeddingEngine: "generic-openai",
        EmbeddingModelPref: "test-embed",
        EmbeddingBasePath: "https://example.test/v1",
        GenericOpenAiEmbeddingApiKey: "embedding-limit-key",
        EmbeddingModelMaxChunkLength: "6000",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request(
        "platform",
        "/admin/system-preferences-for?labels=max_embed_chunk_size"
      )
    ).body.settings
  ).toEqual({ max_embed_chunk_size: 6000 });
});

test("malformed shared encrypted settings fail closed for every tenant without disclosing their contents", async () => {
  await mockStore.run(
    "INSERT INTO system_settings(label,value) VALUES('saas:environment','invalid-settings-ciphertext')"
  );
  for (const identity of ["platform", "a", "b"]) {
    const read = await request(identity, "/setup-complete");
    expect(read.status).toBe(503);
    expect(JSON.stringify(read.body)).not.toContain(
      "invalid-settings-ciphertext"
    );
  }
});

test("formal model discovery retains original metadata, inherited endpoints and embedding purpose", async () => {
  const calls = [];
  await serveUpstream(
    (req, res) => {
      calls.push({ path: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          data: [{ id: "available-model", owned_by: "test" }],
        })
      );
    },
    async (url) => {
      expect(
        (
          await request("platform", "/system/update-env", "POST", {
            LLMProvider: "generic-openai",
            GenericOpenAiBasePath: `${url}/chat/v1`,
            GenericOpenAiKey: "sk-inherited-chat",
            GenericOpenAiModelPref: "available-model",
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request("platform", "/system/custom-models", "POST", {
            provider: "generic-openai",
          })
        ).body.models[0].id
      ).toBe("available-model");
      expect(process.env.GENERIC_OPEN_AI_API_KEY).toBe("sk-inherited-chat");
      expect(calls).toEqual([
        {
          path: "/chat/v1/models",
          authorization: "Bearer sk-inherited-chat",
        },
      ]);
      expect(
        (
          await request("platform", "/system/update-env", "POST", {
            EmbeddingEngine: "generic-openai",
            EmbeddingBasePath: `${url}/embedding/v1`,
            EmbeddingModelPref: "test-embedding",
            GenericOpenAiEmbeddingApiKey: "sk-inherited-embedding",
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request("platform", "/system/custom-models", "POST", {
            provider: "generic-openai",
            purpose: "embedding",
          })
        ).body.models[0].id
      ).toBe("available-model");
      expect(calls[1]).toEqual({
        path: "/embedding/v1/models",
        authorization: "Bearer sk-inherited-embedding",
      });
      expect(
        (
          await request("platform", "/system/custom-models", "POST", {
            provider: "generic-openai",
            purpose: "embedding",
            basePath: `${url}/other`,
            apiKey: "sk-explicit-discovery",
          })
        ).status
      ).toBe(200);
      expect(calls[2]).toEqual({
        path: "/other/models",
        authorization: "Bearer sk-explicit-discovery",
      });
    }
  );
});

test("formal model discovery sanitizes original helper failures without exposing credentials", async () => {
  const discovery = jest
    .spyOn(require("../../utils/helpers/customModels"), "getCustomModels")
    .mockResolvedValueOnce({
      models: [],
      error: "private service response: fixture-secret",
    })
    .mockRejectedValueOnce(new Error("private endpoint and fixture-secret"));
  try {
    const rejected = await request(
      "platform",
      "/system/custom-models",
      "POST",
      {
        provider: "generic-openai",
      }
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body).toEqual({
      models: [],
      error: "模型列表获取失败，请核对连接设置",
    });
    const unavailable = await request(
      "platform",
      "/system/custom-models",
      "POST",
      {
        provider: "generic-openai",
      }
    );
    expect(unavailable.status).toBe(502);
    expect(JSON.stringify(unavailable.body)).not.toMatch(
      /private|fixture-secret/
    );
    expect(discovery).toHaveBeenCalledTimes(2);
  } finally {
    discovery.mockRestore();
  }
});
