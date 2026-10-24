const jwt = require("jsonwebtoken");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const { requestJson } = require("./http-test-client.cjs");
let mockFixture;
const mockStore = Object.fromEntries(
  ["all", "one", "run", "transaction", "id", "now", "init"].map((key) => [
    key,
    (...args) => mockFixture.db[key](...args),
  ])
);
Object.defineProperty(mockStore, "orm", { get: () => mockFixture.prisma });
jest.mock("../../enterprise/store", () => mockStore);
jest.mock(
  "../../utils/prisma",
  () =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          const value = mockFixture.prisma[key];
          return typeof value === "function"
            ? value.bind(mockFixture.prisma)
            : value;
        },
      }
    )
);
const mockBots = [];
jest.mock("web-push", () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(async () => ({ statusCode: 201 })),
  generateVAPIDKeys: jest.fn(),
}));
jest.mock("node-telegram-bot-api", () =>
  jest.fn().mockImplementation(() => {
    const bot = {
      handlers: {},
      texts: [],
      on(event, handler) {
        this.handlers[event] = handler;
      },
      onText(pattern, handler) {
        this.texts.push({ pattern, handler });
      },
      getUpdates: jest.fn(async () => []),
      startPolling: jest.fn(),
      stopPolling: jest.fn(async () => {}),
      setMyCommands: jest.fn(async () => {}),
      sendMessage: jest.fn(async () => ({ message_id: 1 })),
      answerCallbackQuery: jest.fn(async () => {}),
    };
    mockBots.push(bot);
    return bot;
  })
);
const mockCollector = {
  acceptedFileTypes: jest.fn(async () => ({ "text/plain": [".txt"] })),
  processRawText: jest.fn(async (textContent, metadata) => ({
    success: true,
    documents: [{ ...metadata, pageContent: textContent }],
  })),
  online: jest.fn(async () => true),
  forwardExtensionRequest: jest.fn(async () => ({
    success: true,
    content: "Worker source revision",
  })),
};
jest.mock("../../utils/collectorApi", () => ({
  CollectorApi: jest.fn().mockImplementation(() => mockCollector),
}));
jest.mock("../../jobs/helpers", () => ({
  log: jest.fn(),
  conclude: jest.fn(),
}));
const { ApiKey } = require("../../models/apiKeys");
const { ScheduledJob } = require("../../models/scheduledJob");
const { ScheduledJobRun } = require("../../models/scheduledJobRun");
const { TelegramBotService } = require("../../utils/telegramBot");
const {
  ExternalCommunicationConnector: Connector,
} = require("../../models/externalCommunicationConnector");
const { TemporaryAuthToken } = require("../../models/temporaryAuthToken");
const { context } = require("../../enterprise/auth");
let listener, base, job;
const sessions = {};
const envKeys = [
  "JWT_SECRET",
  "PLATFORM_HOSTS",
  "TENANT_BASE_DOMAIN",
  "TENANT_WEB_PORT",
  "SIMPLE_SSO_ENABLED",
];
let previous;
function request(
  actor,
  path,
  method = "GET",
  body,
  host = "a.localhost",
  extraHeaders = {}
) {
  return requestJson(`${base}/api${path}`, {
    method,
    headers: {
      host,
      "content-type": "application/json",
      ...(actor ? { authorization: `Bearer ${sessions[actor] || actor}` } : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.JWT_SECRET = "isolated-external-test";
  process.env.PLATFORM_HOSTS = "localhost";
  process.env.TENANT_BASE_DOMAIN = "localhost";
  process.env.TENANT_WEB_PORT = "3000";
  process.env.SIMPLE_SSO_ENABLED = "true";
  mockFixture = await createPostgresFixture();
  const now = mockFixture.db.now();
  for (const id of ["a", "b"])
    await mockFixture.prisma.ep_tenants.create({
      data: {
        id,
        code: `tenant-${id}`,
        name: `Tenant ${id}`,
        hostname: `${id}.localhost`,
        createdAt: now,
        updatedAt: now,
      },
    });
  for (const [alias, id, tenantId, role] of [
    ["a1", 101, "a", "user"],
    ["a2", 102, "a", "user"],
    ["aa", 103, "a", "admin"],
    ["b1", 104, "b", "user"],
    ["ba", 105, "b", "admin"],
  ]) {
    await mockFixture.prisma.users.create({
      data: {
        id,
        tenantId,
        username: alias,
        name: alias,
        passwordHash: "not-used",
        role,
        createdAt: now,
        updatedAt: now,
      },
    });
    sessions[alias] = jwt.sign(
      { identity: "tenant", tenantId, ver: 1 },
      process.env.JWT_SECRET,
      { subject: String(id), audience: "enterprise-tenant-v1" }
    );
  }
  await mockFixture.prisma.ep_platform_accounts.create({
    data: {
      id: "top",
      username: "top",
      name: "Top",
      passwordHash: "unused",
      createdAt: now,
      updatedAt: now,
    },
  });
  sessions.top = jwt.sign(
    { identity: "platform", ver: 1 },
    process.env.JWT_SECRET,
    { subject: "top", audience: "enterprise-platform-v1" }
  );
  await mockFixture.prisma.ep_libraries.create({
    data: {
      id: "public-a",
      tenantId: "a",
      name: "Public A",
      createdBy: "101",
      createdAt: now,
      updatedAt: now,
      grants: { create: { id: "public-a-grant", tenantId: "a" } },
    },
  });
  await mockFixture.prisma.ep_libraries.create({
    data: {
      id: "private-a",
      tenantId: "a",
      name: "Private A",
      createdBy: "101",
      createdAt: now,
      updatedAt: now,
      grants: { create: { id: "private-a-grant", userId: 101 } },
    },
  });
  const app = require("../../app").createApp();
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
}, 30000);
afterAll(async () => {
  for (const service of TelegramBotService._instances.values())
    await service.stop();
  TelegramBotService._instances.clear();
  await new (require("../../utils/BackgroundWorkers").BackgroundService)().stop();
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  for (const [key, value] of Object.entries(previous || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("API management binds a fixed execution user and rejects other tenant/user supplied identities", async () => {
  expect(
    (
      await request("a1", "/admin/generate-api-key", "POST", {
        name: "denied",
        userId: 101,
      })
    ).status
  ).toBe(403);
  expect(
    (
      await request("aa", "/admin/generate-api-key", "POST", {
        name: "wrong",
        userId: 104,
      })
    ).status
  ).toBe(404);
  const created = await request("aa", "/admin/generate-api-key", "POST", {
    name: "employee",
    userId: 101,
  });
  expect(created.status).toBe(200);
  sessions.key = created.body.apiKey.secret;
  expect(created.body.apiKey).toMatchObject({
    tenantId: "a",
    userId: 101,
    createdBy: "103",
  });
  const libraries = await request("key", "/v1/libraries");
  expect(libraries.body.libraries.map((row) => row.id).sort()).toEqual([
    "private-a",
    "public-a",
  ]);
  expect(
    (await request("key", "/v1/auth", "GET", undefined, "b.localhost")).status
  ).toBe(403);
  expect((await request("key", "/v1/users")).status).toBe(403);
  expect((await request("key", "/v1/platform/libraries")).status).toBe(403);
});
test("API conversations belong to credential execution user, payload userId never impersonates", async () => {
  const created = await request("key", "/v1/conversations", "POST", {
    title: "API personal",
    userId: 102,
    tenantId: "b",
  });
  expect(created.status).toBe(201);
  const row = await mockFixture.prisma.chat_threads.findFirst({
    where: { userId: 101 },
  });
  expect(row).toMatchObject({ tenantId: "a", userId: 101 });
  const second = await ApiKey.create(103, "second", {
    tenantId: "a",
    userId: 102,
  });
  expect(
    (await request(second.apiKey.secret, `/v1/conversations/${row.id}`)).status
  ).toBe(404);
});
test("credential access follows live user status", async () => {
  await mockFixture.prisma.users.update({
    where: { id: 101 },
    data: { status: "disabled" },
  });
  expect((await request("key", "/v1/auth")).status).toBe(401);
  await mockFixture.prisma.users.update({
    where: { id: 101 },
    data: { status: "active" },
  });
});
test("browser capture to a public library enters the approval pipeline", async () => {
  const result = await request(
    "aa",
    "/browser-extension/api-keys/new",
    "POST",
    { userId: 101 }
  );
  expect(result.status).toBe(200);
  expect(result.body.apiOrigin).toBe("http://a.localhost:3000");
  const capture = await request(
    result.body.apiKey,
    "/browser-extension/embed-content",
    "POST",
    {
      libraryId: "public-a",
      textContent: "Pending browser capture",
      metadata: { title: "Capture" },
    }
  );
  expect(capture.status).toBe(202);
  expect(capture.body.approvalRequired).toBe(true);
  expect(await mockFixture.prisma.documents.count()).toBe(0);
  expect(
    (
      await request(
        result.body.apiKey,
        "/browser-extension/libraries",
        "GET",
        undefined,
        "b.localhost"
      )
    ).status
  ).toBe(403);
  const listed = await request("aa", "/browser-extension/api-keys");
  expect(listed.body.apiKeys[0].user).not.toHaveProperty("passwordHash");
});
test("device registration is one-use, tenant scoped and tied to its user", async () => {
  const pair = await request("a1", "/mobile/connect-info");
  expect(pair.status).toBe(200);
  const token = new URL(pair.body.connectionUrl).searchParams.get("t");
  const device = await request(token, "/mobile/register", "POST", {
    deviceOs: "android",
    deviceName: "Test",
    userId: 104,
    tenantId: "b",
  });
  expect(device.status).toBe(200);
  expect(
    (
      await request(token, "/mobile/register", "POST", {
        deviceOs: "android",
        deviceName: "Again",
      })
    ).status
  ).toBe(403);
  const record = await mockFixture.prisma.desktop_mobile_devices.findFirst({
    where: { token: device.body.token },
  });
  expect(record).toMatchObject({ tenantId: "a", userId: 101 });
  await mockFixture.prisma.desktop_mobile_devices.update({
    where: { id: record.id },
    data: { approved: true },
  });
  expect(
    (
      await request(null, "/mobile/auth", "GET", undefined, "b.localhost", {
        "x-anythingllm-mobile-device-token": record.token,
      })
    ).status
  ).toBe(403);
  expect((await request("a2", `/mobile/${record.id}`, "DELETE")).status).toBe(
    404
  );
});
test("embed publication rejects private knowledge and scopes management/history to tenant", async () => {
  expect(
    (await request("aa", "/embeds/new", "POST", { libraryId: "private-a" }))
      .status
  ).toBe(400);
  const result = await request("aa", "/embeds/new", "POST", {
    libraryId: "public-a",
    allowlist_domains: ["https://site.example"],
  });
  expect(result.status).toBe(200);
  sessions.embed = result.body.embed.uuid;
  const list = await request("aa", "/embeds");
  expect(list.body.embeds[0].library.id).toBe("public-a");
  const other = await request("ba", "/embeds", "GET", undefined, "b.localhost");
  expect(other.body.embeds).toEqual([]);
  expect(
    (
      await request(
        "ba",
        `/embed/${result.body.embed.id}`,
        "DELETE",
        undefined,
        "b.localhost"
      )
    ).status
  ).toBe(404);
  expect(
    (
      await request(
        null,
        `/embed/${sessions.embed}/session-test`,
        "GET",
        undefined,
        "a.localhost",
        { origin: "https://denied.example" }
      )
    ).status
  ).toBe(403);
  expect(
    (
      await request(
        null,
        `/embed/${sessions.embed}/session-test`,
        "GET",
        undefined,
        "b.localhost",
        { origin: "https://site.example" }
      )
    ).status
  ).toBe(404);
});
test("tenant admin can stop another user's task but cannot read its private prompt or runs", async () => {
  ({ job } = await ScheduledJob.create({
    name: "Private task",
    prompt: "private prompt",
    schedule: "0 0 * * *",
    tenantId: "a",
    userId: 101,
  }));
  const run = await ScheduledJobRun.start(job.id);
  expect((await request("aa", `/scheduled-jobs/${job.id}`)).status).toBe(404);
  expect((await request("aa", `/scheduled-jobs/runs/${run.id}`)).status).toBe(
    404
  );
  expect(
    (await request("a2", `/scheduled-jobs/${job.id}/toggle`, "POST")).status
  ).toBe(404);
  const managed = await request("aa", "/scheduled-jobs/managed");
  expect(managed.body.jobs[0]).not.toHaveProperty("prompt");
  const stopped = await request("aa", `/scheduled-jobs/${job.id}`, "PUT", {
    enabled: false,
  });
  expect(stopped.status).toBe(200);
  expect(stopped.body).toEqual({ success: true });
  await ScheduledJob.update(job.id, { enabled: true });
  const toggled = await request(
    "aa",
    `/scheduled-jobs/${job.id}/toggle`,
    "POST"
  );
  expect(toggled.body).toEqual({ success: true });
  expect(
    (
      await request(
        "top",
        `/scheduled-jobs/${job.id}`,
        "GET",
        undefined,
        "localhost"
      )
    ).status
  ).toBe(200);
});
test("PostgreSQL permits one concurrent claim for a scheduled job", async () => {
  await mockFixture.prisma.scheduled_job_runs.deleteMany({
    where: { jobId: job.id },
  });
  const claimed = await Promise.all(
    Array.from({ length: 6 }, () => ScheduledJobRun.start(job.id))
  );
  expect(claimed.filter(Boolean)).toHaveLength(1);
});
test("Telegram per-tenant instances reject group traffic and require own login plus chat code", async () => {
  const service = new TelegramBotService("a");
  await Connector.upsert(
    "telegram",
    { bot_id: "123", approved_users: [], active: true },
    "a"
  );
  await service.start({
    bot_token: "fake-test-token",
    bot_username: "test_bot",
    approved_users: [],
  });
  const bot = mockBots.at(-1);
  await bot.handlers.message({
    chat: { id: -10, type: "group" },
    from: { id: 55 },
    text: "Group request",
  });
  expect(service.pendingPairings).toEqual([]);
  await bot.handlers.message({
    chat: { id: 55, type: "private" },
    from: { id: 55 },
    text: "Pair",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = service.pendingPairings[0];
  expect(pending.chatId).toBe("55");
  expect(
    (
      await request("a1", "/telegram/approve-user", "POST", {
        chatId: "55",
        code: "wrong",
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("a1", "/telegram/approve-user", "POST", {
        chatId: "55",
        code: pending.code,
      })
    ).status
  ).toBe(200);
  expect(
    (await Connector.get("telegram", "a")).config.approved_users[0]
  ).toMatchObject({ userId: 101, chatId: "55" });
  expect(new TelegramBotService("b")).not.toBe(service);
  expect(
    (await request("a2", "/telegram/revoke-user", "POST", { chatId: "55" }))
      .status
  ).toBe(404);
  expect(
    (await request("a1", "/telegram/revoke-user", "POST", { chatId: "55" }))
      .status
  ).toBe(200);
});
test("simple SSO consumes a tenant-bound token once and observes auth version changes", async () => {
  const issued = await TemporaryAuthToken.issue(101);
  expect(
    (await TemporaryAuthToken.validate(issued.token, "b")).sessionToken
  ).toBeNull();
  const accepted = await Promise.all([
    TemporaryAuthToken.validate(issued.token, "a"),
    TemporaryAuthToken.validate(issued.token, "a"),
  ]);
  expect(accepted.filter((result) => result.sessionToken)).toHaveLength(1);
  expect(
    jwt.decode(accepted.find((result) => result.sessionToken).sessionToken)
  ).toMatchObject({ sub: "101", tenantId: "a", identity: "tenant" });
  const stale = await TemporaryAuthToken.issue(101);
  await mockFixture.prisma.users.update({
    where: { id: 101 },
    data: { authVersion: { increment: 1 } },
  });
  expect(
    (await TemporaryAuthToken.validate(stale.token, "a")).sessionToken
  ).toBeNull();
  sessions.a1 = jwt.sign(
    { identity: "tenant", tenantId: "a", ver: 2 },
    process.env.JWT_SECRET,
    { subject: "101", audience: "enterprise-tenant-v1" }
  );
});

test("administrator API reuses tenant user handlers and cannot create cross-tenant identities", async () => {
  const administratorKey = await ApiKey.create(103, "management", {
    tenantId: "a",
    userId: 103,
  });
  const secret = administratorKey.apiKey.secret;
  expect(
    (
      await request(secret, "/v1/admin/users/new", "POST", {
        username: "external-created",
        name: "API User",
        password: "ExternalUser123!",
        role: "user",
        tenantId: "b",
      })
    ).status
  ).toBe(400);
  const created = await request(secret, "/v1/admin/users/new", "POST", {
    username: "external-created",
    name: "API User",
    password: "ExternalUser123!",
    role: "user",
  });
  expect(created.status).toBe(201);
  const target = await mockFixture.prisma.users.findUnique({
    where: { id: created.body.user.id },
  });
  expect(target).toMatchObject({ tenantId: "a", role: "user" });
  expect(
    (
      await request(secret, `/v1/users/${target.id}`, "PATCH", {
        status: "disabled",
      })
    ).status
  ).toBe(200);
  expect(
    (await request(secret, "/v1/users/104", "PATCH", { status: "disabled" }))
      .status
  ).toBe(404);
  const listed = await request(secret, "/v1/users");
  expect(listed.status).toBe(200);
  expect(listed.body.users.every((user) => user.id !== 104)).toBe(true);
  expect((await request(secret, "/v1/admin/is-multi-user-mode")).body).toEqual({
    isMultiUser: true,
  });
  const issued = await request(secret, "/v1/users/103/issue-auth-token");
  expect(issued.status).toBe(200);
  expect(issued.body.token).toBeTruthy();
  expect((await request(secret, "/v1/users/101/issue-auth-token")).status).toBe(
    404
  );
});

test("original document metadata APIs remain available and generated downloads require ownership", async () => {
  expect(
    (await request("key", "/v1/document/accepted-file-types")).body
  ).toEqual({ types: { "text/plain": [".txt"] } });
  expect(
    (await request("key", "/v1/document/metadata-schema")).body.schema
  ).toMatchObject({ title: "string" });
  const filename = "pdf-11111111-1111-1111-1111-111111111111.pdf";
  expect(
    (await request("key", `/v1/document/generated-files/${filename}`)).status
  ).toBe(404);
  const thread = await mockFixture.prisma.chat_threads.findFirst({
    where: { tenantId: "a", userId: 101 },
  });
  const now = mockFixture.db.now();
  await mockFixture.prisma.chats.create({
    data: {
      id: 9001,
      tenantId: "a",
      userId: 101,
      thread_id: thread.id,
      prompt: "Generate file",
      response: JSON.stringify({
        text: "Created",
        outputs: [{ type: "file", payload: { storageFilename: filename } }],
      }),
      createdAt: now,
      lastUpdatedAt: now,
    },
  });
  const generated = jest
    .spyOn(
      require("../../utils/agents/aibitat/plugins/create-files/lib"),
      "getGeneratedFile"
    )
    .mockResolvedValue({ buffer: Buffer.from('"test PDF"') });
  try {
    expect(
      (await request("key", `/v1/document/generated-files/${filename}`)).status
    ).toBe(200);
    const { apiKey } = await ApiKey.create(103, "not owner", {
      tenantId: "a",
      userId: 102,
    });
    expect(
      (await request(apiKey.secret, `/v1/document/generated-files/${filename}`))
        .status
    ).toBe(404);
    expect(generated).toHaveBeenCalledTimes(1);
  } finally {
    generated.mockRestore();
  }
});

test("original system API exposes effective safe settings and exports only the key's personal chats", async () => {
  const settings = await request("key", "/v1/system");
  expect(settings.status).toBe(200);
  expect(settings.body.settings).toMatchObject({
    RequiresAuth: true,
    MultiUserMode: true,
  });
  expect(settings.body.settings).not.toHaveProperty("OpenAiKey");
  const now = mockFixture.db.now();
  await mockFixture.prisma.chat_threads.create({
    data: {
      id: 9002,
      tenantId: "a",
      userId: 102,
      name: "Other private",
      slug: "other-external-export",
      createdAt: now,
      lastUpdatedAt: now,
    },
  });
  await mockFixture.prisma.chats.create({
    data: {
      id: 9003,
      tenantId: "a",
      userId: 102,
      thread_id: 9002,
      prompt: "Hidden private prompt",
      response: JSON.stringify({ text: "Hidden private answer" }),
      createdAt: now,
      lastUpdatedAt: now,
    },
  });
  const exported = await request("key", "/v1/system/export-chats?type=json");
  expect(exported.status).toBe(200);
  expect(exported.body.some((chat) => chat.id === 9001)).toBe(true);
  expect(exported.body.some((chat) => chat.id === 9003)).toBe(false);
  expect(
    (await request("key", "/v1/system/export-chats?type=unsupported")).status
  ).toBe(400);
});

test("watched documents keep a fixed owner, revoke access immediately and send public revisions to approval", async () => {
  await mockFixture.prisma.system_settings.upsert({
    where: { label: "experimental_live_file_sync" },
    create: { label: "experimental_live_file_sync", value: "enabled" },
    update: { value: "enabled" },
  });
  const now = mockFixture.db.now();
  await mockFixture.prisma.documents.create({
    data: {
      id: "watched-public",
      tenantId: "a",
      libraryId: "public-a",
      title: "Source.html",
      content: "Published original",
      inputType: "text",
      status: "ready",
      metadata: JSON.stringify({
        title: "Source.html",
        chunkSource: "link://https://example.com",
      }),
      createdBy: "101",
      updatedBy: "101",
      createdAt: now,
      updatedAt: now,
    },
  });
  const watched = await request(
    "a1",
    "/documents/watched-public/update-watch-status",
    "POST",
    { watchStatus: true, userId: 104 }
  );
  expect(watched.status).toBe(200);
  expect(
    await mockFixture.prisma.document_sync_queues.findUnique({
      where: { documentId: "watched-public" },
    })
  ).toMatchObject({ tenantId: "a", userId: 101 });
  expect(
    (await request("a2", "/experimental/live-sync/queues")).body.queues
  ).toEqual([]);
  const own = await request("a1", "/experimental/live-sync/queues");
  expect(own.body.queues[0].document).toEqual({
    id: "watched-public",
    title: "Source.html",
    libraryId: "public-a",
  });
  const result =
    await require("../../enterprise/knowledge").submitSyncedContent(
      await context(101),
      "watched-public",
      "New source revision"
    );
  expect(result.approvalRequired).toBe(true);
  expect(
    await mockFixture.prisma.documents.findUnique({
      where: { id: "watched-public" },
    })
  ).toMatchObject({ content: "Published original", version: 1 });
  const change = await mockFixture.prisma.ep_knowledge_changes.findUnique({
    where: { id: result.change.id },
  });
  expect(change).toMatchObject({
    action: "document.update",
    requestedBy: "101",
    baseVersion: 1,
    status: "pending",
  });
  expect(
    (
      await request(
        "a2",
        "/documents/watched-public/update-watch-status",
        "POST",
        { watchStatus: false }
      )
    ).status
  ).toBe(200);
  expect(await mockFixture.prisma.document_sync_queues.count()).toBe(1);
  expect(
    (
      await request("aa", "/experimental/toggle-live-sync", "POST", {
        updatedStatus: false,
      })
    ).status
  ).toBe(403);
  const detail = await request("a1", "/enterprise/documents/watched-public");
  expect(detail).toMatchObject({
    status: 200,
    body: { document: { id: "watched-public" } },
  });
  expect(detail.body.document.canWatch).toBe(true);
  expect(detail.body.document).not.toHaveProperty("metadata");
  await mockFixture.prisma.ep_library_grants.delete({
    where: { id: "public-a-grant" },
  });
  expect(
    (await request("a1", "/experimental/live-sync/queues")).body.queues
  ).toEqual([]);
  expect(
    (
      await request(
        "a1",
        "/documents/watched-public/update-watch-status",
        "POST",
        { watchStatus: true }
      )
    ).status
  ).toBe(404);
  await mockFixture.prisma.ep_library_grants.create({
    data: { id: "public-a-grant", libraryId: "public-a", tenantId: "a" },
  });
});

test("background scheduler pauses a disabled execution account", async () => {
  await mockFixture.prisma.users.update({
    where: { id: 102 },
    data: { status: "disabled" },
  });
  const { job: paused } = await ScheduledJob.create({
    name: "Disabled owner",
    prompt: "Not run",
    schedule: "0 0 * * *",
    tenantId: "a",
    userId: 102,
  });
  const queued =
    await new (require("../../utils/BackgroundWorkers").BackgroundService)().enqueueScheduledJob(
      paused.id
    );
  expect(queued).toBeNull();
  expect(
    await mockFixture.prisma.scheduled_job_runs.count({
      where: { jobId: paused.id },
    })
  ).toBe(0);
  await mockFixture.prisma.users.update({
    where: { id: 102 },
    data: { status: "active" },
  });
});

test("watched source worker checks execution identity before fetching and never publishes public changes", async () => {
  const queue = await mockFixture.prisma.document_sync_queues.findUnique({
    where: { documentId: "watched-public" },
  });
  await mockFixture.prisma.document_sync_queues.update({
    where: { id: queue.id },
    data: { nextSyncAt: new Date(0) },
  });
  const { syncWatchedDocuments } = require("../../jobs/sync-watched-documents");
  mockCollector.forwardExtensionRequest.mockClear();
  await mockFixture.prisma.users.update({
    where: { id: 101 },
    data: { status: "disabled" },
  });
  await syncWatchedDocuments();
  expect(mockCollector.forwardExtensionRequest).not.toHaveBeenCalled();
  await mockFixture.prisma.users.update({
    where: { id: 101 },
    data: { status: "active" },
  });
  await syncWatchedDocuments();
  expect(mockCollector.forwardExtensionRequest).toHaveBeenCalledWith(
    expect.objectContaining({ endpoint: "/ext/resync-source-document" })
  );
  expect(
    await mockFixture.prisma.documents.findUnique({
      where: { id: "watched-public" },
    })
  ).toMatchObject({ content: "Published original", version: 1 });
  expect(
    await mockFixture.prisma.ep_knowledge_changes.findFirst({
      where: {
        documentId: "watched-public",
        payload: { contains: "Worker source revision" },
      },
    })
  ).toMatchObject({ status: "pending", requestedBy: "101" });
  expect(
    await mockFixture.prisma.document_sync_executions.findFirst({
      where: { queueId: queue.id },
    })
  ).toMatchObject({ status: "success" });
});

test("anonymous embed sessions and publication grant revocation isolate history", async () => {
  const embed = await mockFixture.prisma.embed_configs.findUnique({
    where: { uuid: sessions.embed },
  });
  const common = {
    embed_id: embed.id,
    prompt: "anonymous prompt",
    response: JSON.stringify({ text: "Anonymous answer" }),
  };
  await mockFixture.prisma.embed_chats.createMany({
    data: [
      { ...common, session_id: "visitor-one" },
      { ...common, session_id: "visitor-two" },
    ],
  });
  const own = await request(
    null,
    `/embed/${sessions.embed}/visitor-one`,
    "GET",
    undefined,
    "a.localhost",
    { origin: "https://site.example" }
  );
  expect(own.status).toBe(200);
  expect(own.body.history).toHaveLength(2);
  expect(new Set(own.body.history.map((message) => message.chatId)).size).toBe(
    1
  );
  expect(
    (await request("a1", "/enterprise/conversations")).body.conversations
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ prompt: "anonymous prompt" }),
    ])
  );
  await mockFixture.prisma.ep_library_grants.delete({
    where: { id: "public-a-grant" },
  });
  expect(
    (
      await request(
        null,
        `/embed/${sessions.embed}/visitor-one`,
        "GET",
        undefined,
        "a.localhost",
        { origin: "https://site.example" }
      )
    ).status
  ).toBe(404);
  await mockFixture.prisma.ep_library_grants.create({
    data: { id: "public-a-grant", libraryId: "public-a", tenantId: "a" },
  });
});

test("Telegram refreshes an expired pairing code while retaining current codes", async () => {
  const {
    sendPairingRequest,
  } = require("../../utils/telegramBot/utils/verification");
  const pending = new Map([
    [
      56,
      {
        code: "expired",
        requestedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      },
    ],
  ]);
  const bot = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
  const message = {
    chat: { id: 56, type: "private" },
    from: { id: 56, first_name: "Employee" },
  };
  await sendPairingRequest(bot, message, pending);
  const renewed = pending.get(56);
  expect(renewed.code).not.toBe("expired");
  expect(Date.now() - Date.parse(renewed.requestedAt)).toBeLessThan(5000);
  await sendPairingRequest(bot, message, pending);
  expect(pending.get(56).code).toBe(renewed.code);
});

test("Agent-created scheduled jobs retain approval and bind the current live employee", async () => {
  const {
    createScheduledJob,
  } = require("../../utils/agents/aibitat/plugins/create-scheduled-job");
  let tool;
  createScheduledJob.plugin().setup({
    function(value) {
      tool = value;
    },
  });
  const aibitat = {
    handlerProps: { log: jest.fn() },
    introspect: jest.fn(),
    requestToolApproval: jest.fn(async () => ({
      approved: false,
      message: "Rejected",
    })),
    socket: { send: jest.fn() },
  };
  tool.super = aibitat;
  tool.caller = "test";
  const background =
    new (require("../../utils/BackgroundWorkers").BackgroundService)();
  const registration = jest
    .spyOn(background, "addScheduledJob")
    .mockImplementation(() => {});
  const available = jest
    .spyOn(ScheduledJob, "availableTools")
    .mockResolvedValue([]);
  const { runExecution } = require("../../enterprise/execution-context");
  try {
    const before = await mockFixture.prisma.scheduled_jobs.count();
    const args = {
      name: "Agent-owned",
      prompt: "My private task",
      schedule: "0 9 * * *",
    };
    expect(
      await runExecution(await context(101), () => tool.execute(args))
    ).toBe("Rejected");
    expect(await mockFixture.prisma.scheduled_jobs.count()).toBe(before);
    aibitat.requestToolApproval.mockResolvedValue({ approved: true });
    await runExecution(await context(101), () => tool.execute(args));
    expect(
      await mockFixture.prisma.scheduled_jobs.findFirst({
        where: { name: "Agent-owned" },
      })
    ).toMatchObject({ tenantId: "a", userId: 101, prompt: "My private task" });
    aibitat.requestToolApproval.mockImplementationOnce(async () => {
      await mockFixture.prisma.users.update({
        where: { id: 101 },
        data: { status: "disabled" },
      });
      return { approved: true };
    });
    await expect(
      runExecution(await context(101), () =>
        tool.execute({ ...args, name: "Revoked during approval" })
      )
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await mockFixture.prisma.scheduled_jobs.count({
        where: { name: "Revoked during approval" },
      })
    ).toBe(0);
    await mockFixture.prisma.users.update({
      where: { id: 101 },
      data: { status: "active" },
    });
    const stale = await context(101);
    await mockFixture.prisma.users.update({
      where: { id: 101 },
      data: { status: "disabled" },
    });
    await expect(
      runExecution(stale, () => tool.execute(args))
    ).rejects.toMatchObject({ status: 401 });
    await mockFixture.prisma.users.update({
      where: { id: 101 },
      data: { status: "active" },
    });
  } finally {
    registration.mockRestore();
    available.mockRestore();
  }
});

test("late Telegram tool approval IPC cannot disclose payloads after employee revocation", async () => {
  const { EventEmitter } = require("events");
  const service = new TelegramBotService("a");
  await service.stop();
  await Connector.updateConfig(
    "telegram",
    { approved_users: [{ chatId: "99", userId: 101 }] },
    "a"
  );
  const live = await Connector.get("telegram", "a");
  await service.start({ ...live.config, bot_token: "fake-test-token" });
  const bot = mockBots.at(-1);
  const background =
    new (require("../../utils/BackgroundWorkers").BackgroundService)();
  const originalBree = background.bree;
  const worker = new EventEmitter();
  let ready, denied;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const denial = new Promise((resolve) => {
    denied = resolve;
  });
  worker.send = jest.fn((value) => {
    if (value.type === "toolApprovalResponse") denied(value);
  });
  worker.kill = jest.fn(() => worker.emit("exit", 0));
  const on = worker.on.bind(worker);
  worker.on = (event, handler) => {
    on(event, handler);
    if (event === "error") ready();
    return worker;
  };
  const workers = new Map();
  background.bree = {
    workers,
    add: jest.fn(async () => {}),
    run: jest.fn(async (jobId) => workers.set(jobId, worker)),
    remove: jest.fn(async () => {}),
  };
  try {
    await bot.handlers.message({
      chat: { id: 99, type: "private" },
      from: { id: 99 },
      text: "Work",
    });
    await started;
    await mockFixture.prisma.users.update({
      where: { id: 101 },
      data: { status: "disabled" },
    });
    bot.sendMessage.mockClear();
    worker.emit("message", {
      type: "toolApprovalRequest",
      requestId: "late",
      chatId: 99,
      skillName: "private-tool",
      payload: { secret: "private prompt" },
      timeoutMs: 1,
    });
    expect(await denial).toMatchObject({ requestId: "late", approved: false });
    expect(bot.sendMessage).not.toHaveBeenCalled();
  } finally {
    worker.emit("exit", 0);
    await new Promise((resolve) => setImmediate(resolve));
    background.bree = originalBree;
    await mockFixture.prisma.users.update({
      where: { id: 101 },
      data: { status: "active" },
    });
    await service.stop();
  }
});

test("Telegram partial state writes cannot restore a revoked binding, including while the bot is stopped", async () => {
  const service = new TelegramBotService("a");
  await Connector.updateConfig(
    "telegram",
    { approved_users: [{ chatId: "77", userId: 101 }] },
    "a"
  );
  let release, entered;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const locked = new Promise((resolve) => {
    entered = resolve;
  });
  const stateWrite = Connector.updateConfig(
    "telegram",
    async (current) => {
      entered();
      await paused;
      return {
        approved_users: current.approved_users.map((user) => ({
          ...user,
          active_thread: "old-thread",
        })),
      };
    },
    "a"
  );
  await locked;
  const revocation = service.revokeExistingUser("77");
  release();
  await Promise.all([stateWrite, revocation]);
  expect((await Connector.get("telegram", "a")).config.approved_users).toEqual(
    []
  );
  await Connector.updateConfig(
    "telegram",
    (current) => ({
      approved_users: current.approved_users.map((user) => ({
        ...user,
        active_thread: "delayed",
      })),
    }),
    "a"
  );
  expect((await Connector.get("telegram", "a")).config.approved_users).toEqual(
    []
  );
  await Connector.upsert(
    "telegram",
    {
      bot_id: "123",
      bot_token: "fake-test-token",
      approved_users: [{ chatId: "77", userId: 101 }],
      active: true,
    },
    "a"
  );
  expect((await Connector.get("telegram", "a")).config.approved_users).toEqual(
    []
  );
  await service.stop();
  await Connector.updateConfig(
    "telegram",
    { approved_users: [{ chatId: "78", userId: 101 }] },
    "a"
  );
  const removed = await request("a1", "/telegram/revoke-user", "POST", {
    chatId: "78",
  });
  expect(removed.status).toBe(200);
  expect((await Connector.get("telegram", "a")).config.approved_users).toEqual(
    []
  );
});

test("WebPush keeps subscriptions private and rechecks the execution tenant and account before delivery", async () => {
  const {
    pushNotificationService: service,
  } = require("../../utils/PushNotifications");
  const transport = require("web-push");
  const configured = jest
    .spyOn(service, "pushService", "get")
    .mockReturnValue(transport);
  const subscription = {
    endpoint: "https://push.example/employee-a",
    keys: { auth: "auth", p256dh: "p256dh" },
  };
  try {
    expect(
      (
        await request(
          "top",
          "/web-push/subscribe",
          "POST",
          subscription,
          "localhost"
        )
      ).status
    ).toBe(400);
    expect(
      (
        await request("a1", "/web-push/subscribe", "POST", {
          ...subscription,
          endpoint: "http://invalid.example",
        })
      ).status
    ).toBe(400);
    expect(
      (await request("a1", "/web-push/subscribe", "POST", subscription)).status
    ).toBe(201);
    expect(
      (await mockFixture.prisma.users.findUnique({ where: { id: 101 } }))
        .web_push_subscription_config
    ).toBe(JSON.stringify(subscription));
    expect(
      (await mockFixture.prisma.users.findUnique({ where: { id: 102 } }))
        .web_push_subscription_config
    ).toBeNull();
    await service.loadSubscriptions();
    transport.sendNotification.mockClear();
    await service.sendNotification({
      to: 101,
      tenantId: "b",
      payload: { body: "Wrong tenant" },
    });
    await service.sendNotification({
      to: "all",
      tenantId: "a",
      payload: { body: "Broadcast" },
    });
    expect(transport.sendNotification).not.toHaveBeenCalled();
    await service.sendNotification({
      to: 101,
      tenantId: "a",
      payload: { body: "Own private result" },
    });
    expect(transport.sendNotification).toHaveBeenCalledTimes(1);
    expect(transport.sendNotification).toHaveBeenLastCalledWith(
      subscription,
      JSON.stringify({ body: "Own private result" })
    );
    await mockFixture.prisma.users.update({
      where: { id: 101 },
      data: { status: "disabled" },
    });
    await service.sendNotification({
      to: 101,
      tenantId: "a",
      payload: { body: "Not delivered" },
    });
    expect(transport.sendNotification).toHaveBeenCalledTimes(1);
    await mockFixture.prisma.users.update({
      where: { id: 101 },
      data: { status: "active" },
    });
    await mockFixture.prisma.ep_tenants.update({
      where: { id: "a" },
      data: { status: "disabled" },
    });
    await service.sendNotification({
      to: 101,
      tenantId: "a",
      payload: { body: "Not delivered" },
    });
    expect(transport.sendNotification).toHaveBeenCalledTimes(1);
    await mockFixture.prisma.ep_tenants.update({
      where: { id: "a" },
      data: { status: "active" },
    });
    const { apiKey } = await ApiKey.create(103, "push metadata check", {
      tenantId: "a",
      userId: 103,
    });
    const listed = await request(apiKey.secret, "/v1/users");
    expect(
      listed.body.users.every(
        (user) => !Object.hasOwn(user, "web_push_subscription_config")
      )
    ).toBe(true);
  } finally {
    configured.mockRestore();
  }
});
