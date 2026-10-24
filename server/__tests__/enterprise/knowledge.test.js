const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const express = require("express");

let mockFixture, mockPgStore;
const mockStore = {
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
const mockProviders = {
  encrypt: (...args) =>
    jest.requireActual("../../enterprise/providers").encrypt(...args),
  decrypt: (...args) =>
    jest.requireActual("../../enterprise/providers").decrypt(...args),
  contextWindow: () => 16384,
  maxOutputTokens: () => 1800,
  embeddingChunkLimit: jest.fn(() => 8192),
  resolveConnection: jest.fn(async (_ctx, kind) => ({ id: kind, version: 1 })),
  connectionIdentity: (connection) => `${connection.id}:${connection.version}`,
  embed: jest.fn(async (_connection, texts) => texts.map(() => [1, 0, 0])),
  complete: jest.fn(async () => "公开答案与私有答案 [1]"),
  compress: async (_connection, args, history) =>
    jest.requireActual("../../enterprise/ai/runtime").compress(
      {
        provider: "openai-compatible",
        config: {
          model: "test-chat",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "unused",
          options: {
            contextWindow: mockProviders.contextWindow(_connection),
            maxTokens: 1800,
          },
        },
      },
      args,
      history
    ),
};
jest.mock("../../enterprise/store", () => mockStore);
jest.mock("../../utils/memories", () => ({
  promptWithMemories: async ({ systemPrompt }) => systemPrompt,
}));
jest.mock("../../enterprise/providers", () => mockProviders);
jest.mock("../../enterprise/auth", () => ({
  requireAuth: (_req, _res, next) => next(),
  requirePlatformAuth: (_req, _res, next) =>
    _req.ep?.identity === "platform"
      ? next()
      : next(Object.assign(new Error("platform only"), { status: 403 })),
  context: (...args) =>
    jest.requireActual("../../enterprise/auth").context(...args),
  platformContext: (...args) =>
    jest.requireActual("../../enterprise/auth").platformContext(...args),
  fail: (status, message) => Object.assign(new Error(message), { status }),
  refreshContext: (ctx, db = mockStore) =>
    jest.requireActual("../../enterprise/auth").refreshContext(ctx, db),
}));

let knowledge, rag, vectorStore;
const ctx = {
  a1: { tenantId: "tenant-a", userId: 1, role: "user" },
  a2: { tenantId: "tenant-a", userId: 2, role: "user" },
  aa: { tenantId: "tenant-a", userId: 3, role: "admin" },
  b1: { tenantId: "tenant-b", userId: 4, role: "user" },
  ba: { tenantId: "tenant-b", userId: 5, role: "admin" },
};
let temp, listener, base, collectorProcess;
let originalEncryption;
async function request(user, url, method = "GET", body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": user,
      host: `${ctx[user].tenantId}.localhost`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function ready(id, user = "a1") {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await request(user, `/documents/${id}`);
    if (result.body.document?.status === "ready") return result.body.document;
    if (result.body.document?.status === "failed")
      throw new Error(result.body.document.error);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Indexing did not complete");
}
async function library(user, name, visibility) {
  const result = await request(user, "/libraries", "POST", {
    name,
    visibility,
    tenantId: "tenant-b",
    ownerId: "b1",
  });
  if (result.body.approvalRequired) {
    const admin = ctx[user].tenantId === "tenant-b" ? "ba" : "aa";
    const approved = await request(
      admin,
      `/knowledge-changes/${result.body.change.id}/review`,
      "POST",
      { decision: "approve" }
    );
    expect(approved.status).toBe(200);
    return (await request(user, "/libraries")).body.libraries.find(
      (item) => item.name === name
    );
  }
  expect(result.status).toBe(201);
  return result.body.library;
}
async function document(user, libraryId, title, content) {
  const result = await request(user, "/documents", "POST", {
    libraryId,
    title,
    content,
  });
  expect(result.status).toBe(202);
  if (result.body.approvalRequired) {
    const admin = ctx[user].tenantId === "tenant-b" ? "ba" : "aa";
    const approved = await request(
      admin,
      `/knowledge-changes/${result.body.change.id}/review`,
      "POST",
      { decision: "approve" }
    );
    expect(approved.status).toBe(200);
    const doc = (await request(user, "/documents")).body.documents.find(
      (item) => item.title === title && item.libraryId === libraryId
    );
    return (await request(user, `/documents/${doc.id}`)).body.document;
  }
  return ready(result.body.document.id, user);
}

async function uploadFile(user, libraryId, filename, bytes) {
  const form = new FormData();
  form.set("libraryId", libraryId);
  form.set("file", new Blob([bytes]), filename);
  const response = await fetch(`${base}/documents/upload`, {
    method: "POST",
    headers: { "x-test-user": user, host: `${ctx[user].tenantId}.localhost` },
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  originalEncryption = {
    SIG_KEY: process.env.SIG_KEY,
    SIG_SALT: process.env.SIG_SALT,
    STORAGE_DIR: process.env.STORAGE_DIR,
    COLLECTOR_PORT: process.env.COLLECTOR_PORT,
  };
  process.env.SIG_KEY = "knowledge-test-key";
  process.env.SIG_SALT = "knowledge-test-salt";
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-knowledge-"));
  // File storage captures its root when required. Set it before loading the
  // real upload pipeline so a developer's .env can never receive test files.
  process.env.STORAGE_DIR = temp;
  // Exercise the same signed HTTP boundary as production while keeping every
  // original, communication key and parser artifact in this test's directory.
  const { CommunicationKey } = require("../../utils/comKey");
  new CommunicationKey(true);
  collectorProcess = require("child_process").spawn(
    process.execPath,
    [
      "-e",
      `const server = require('./app').createCollectorApp().listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
       process.on('message', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });`,
    ],
    {
      cwd: path.resolve(__dirname, "../../../collector"),
      env: { ...process.env },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    }
  );
  process.env.COLLECTOR_PORT = String(
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Test Collector startup timed out")),
        10000
      );
      collectorProcess.once("message", ({ port }) => {
        clearTimeout(timeout);
        resolve(port);
      });
      collectorProcess.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      collectorProcess.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Test Collector exited before listening"));
      });
    })
  );
  knowledge = require("../../enterprise/knowledge");
  rag = require("../../enterprise/rag");
  vectorStore = require("../../enterprise/vector-store");
  mockFixture = await createPostgresFixture();
  mockPgStore = mockFixture.db;

  const stamp = new Date().toISOString();
  await mockStore.run(
    'INSERT INTO ep_vector_settings(id,provider,config,revision,"updatedAt") VALUES(\'platform\',\'lancedb\',$1,1,$2) ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider, config=EXCLUDED.config, revision=EXCLUDED.revision, "updatedAt"=EXCLUDED."updatedAt"',
    mockProviders.encrypt(JSON.stringify({ path: path.join(temp, "lancedb") })),
    stamp
  );
  for (const tenantId of ["tenant-a", "tenant-b"])
    await mockStore.run(
      'INSERT INTO ep_tenants (id,code,name,hostname,"createdAt","updatedAt") VALUES ($1,$2,$3,$2 || \'.localhost\',$4,$5)',
      tenantId,
      tenantId,
      tenantId,
      stamp,
      stamp
    );
  for (const [userId, identity] of Object.entries(ctx))
    await mockStore.run(
      'INSERT INTO users (id,"tenantId",username,name,"passwordHash",role,"createdAt","lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      identity.userId,
      identity.tenantId,
      userId,
      userId,
      "unused-test-hash",
      identity.role,
      new Date(stamp),
      new Date(stamp)
    );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.ep = ctx[req.headers["x-test-user"]];
    next();
  });
  const router = express.Router();
  knowledge.registerKnowledge(router);
  rag.registerRag(router);
  app.use(router);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});
afterAll(async () => {
  try {
    if (listener) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    if (collectorProcess?.connected) {
      await new Promise((resolve) => {
        collectorProcess.once("exit", resolve);
        collectorProcess.send("close");
      });
    }
  } finally {
    try {
      await mockFixture?.cleanup();
    } finally {
      try {
        if (temp) {
          const target = path.resolve(temp);
          if (
            !target.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
            !path.basename(target).startsWith("enterprise-knowledge-")
          )
            throw new Error("Refusing to remove a non-test storage directory");
          fs.rmSync(target, { recursive: true, force: true });
        }
      } finally {
        for (const [key, value] of Object.entries(originalEncryption || {})) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  }
});

test("personal mutation routes preserve original pairs, regeneration order and fork ownership", async () => {
  const { Chat } = require("../../models/workspaceChats");
  const conversation = (
    await request("a1", "/conversations", "POST", {
      title: "Mutation route contract",
    })
  ).body.conversation;
  const first = (
    await Chat.new(
      ctx.a1,
      {
        threadId: conversation.id,
        prompt: "First question",
        response: {
          text: "First answer",
          sources: [{ title: "Saved citation", text: "Historical snapshot" }],
          metrics: { tokens: 2 },
        },
      },
      mockStore.orm
    )
  ).chat;
  const attachments = [
    {
      name: "diagram.png",
      mime: "image/png",
      contentString: "data:image/png;base64,YQ==",
    },
  ];
  const last = (
    await Chat.new(
      ctx.a1,
      {
        threadId: conversation.id,
        prompt: "Last question",
        response: { text: "Last answer", attachments },
      },
      mockStore.orm
    )
  ).chat;
  for (const user of ["a2", "aa", "b1"]) {
    for (const [url, method, body] of [
      [
        `/messages/${first.id}`,
        "PATCH",
        { role: "assistant", content: "Stolen" },
      ],
      [`/messages/${first.id}`, "DELETE"],
      [`/messages/${first.id}/truncate`, "POST", {}],
      [`/messages/${first.id}/fork`, "POST", {}],
    ])
      expect((await request(user, url, method, body)).status).toBe(404);
  }
  for (const body of [
    { role: "system", content: "Injected" },
    { role: "assistant", content: " " },
    { role: "assistant", content: 7 },
  ])
    expect(
      (await request("a1", `/messages/${first.id}`, "PATCH", body)).status
    ).toBe(400);
  expect(
    (
      await request("a1", `/messages/${first.id}`, "PATCH", {
        role: "user",
        content: "Revised question",
      })
    ).body.messages[0].content
  ).toBe("Revised question");
  const edit = await request("a1", `/messages/${first.id}`, "PATCH", {
    role: "assistant",
    content: "Revised answer",
  });
  expect(edit.body.messages[1]).toMatchObject({
    content: "Revised answer",
    metrics: { tokens: 2 },
    sources: [{ title: "Saved citation", text: "Historical snapshot" }],
  });
  expect(
    (
      await request("a1", `/messages/${first.id}/feedback`, "POST", {
        feedbackScore: false,
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request("a1", `/messages/${first.id}/feedback`, "POST", {
        feedbackScore: null,
      })
    ).status
  ).toBe(200);
  expect(
    (await Chat.get(ctx.a1, { id: first.id }, mockStore.orm)).feedbackScore
  ).toBeNull();
  const fork = await request("a1", `/messages/${first.id}/fork`, "POST", {});
  expect(fork.status).toBe(201);
  const forked = await request(
    "a1",
    `/conversations/${fork.body.conversation.id}`
  );
  expect(forked.body.messages.map((row) => row.content)).toEqual([
    "Revised question",
    "Revised answer",
  ]);
  expect(
    (await request("a2", `/conversations/${fork.body.conversation.id}`)).status
  ).toBe(404);
  expect(
    (
      await request("a1", `/messages/${first.id}/truncate`, "POST", {
        regenerate: true,
      })
    ).status
  ).toBe(409);
  const regenerate = await request(
    "a1",
    `/messages/${last.id}/truncate`,
    "POST",
    { regenerate: true }
  );
  expect(regenerate.body).toMatchObject({
    prompt: "Last question",
    attachments,
  });
  expect(await Chat.get(ctx.a1, { id: last.id }, mockStore.orm)).toBeNull();
  expect(
    (await request("a1", `/messages/${first.id}/truncate`, "POST", {})).status
  ).toBe(200);
  expect((await request("a1", `/messages/${first.id}`, "DELETE")).status).toBe(
    404
  );
  expect(
    (await request("a1", `/messages/${first.id}/fork`, "POST", {})).status
  ).toBe(404);
  expect(
    (await request("a1", `/messages/${first.id}/truncate`, "POST", {})).status
  ).toBe(404);
  expect(
    (await request("a1", `/messages/${forked.body.messages[1].id}`, "DELETE"))
      .status
  ).toBe(200);
});

test("top administrator reviews and manages personal content across tenant boundaries", async () => {
  const { Chat } = require("../../models/workspaceChats");
  const stamp = new Date().toISOString();
  await mockStore.orm.ep_platform_accounts.create({
    data: {
      id: "rag-platform",
      username: "rag-platform",
      name: "Platform",
      passwordHash: "unused",
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  ctx.platform = { identity: "platform", userId: "rag-platform" };
  try {
    const a = (
      await request("a1", "/conversations", "POST", { title: "Personal A" })
    ).body.conversation;
    const b = (
      await request("b1", "/conversations", "POST", { title: "Personal B" })
    ).body.conversation;
    const one = (
      await Chat.new(
        ctx.a1,
        {
          threadId: a.id,
          prompt: "A question",
          response: { text: "A answer", sources: [{ text: "Snapshot" }] },
        },
        mockStore.orm
      )
    ).chat;
    const two = (
      await Chat.new(
        ctx.b1,
        {
          threadId: b.id,
          prompt: "B question",
          response: { text: "B answer" },
        },
        mockStore.orm
      )
    ).chat;
    expect((await request("a1", "/platform/conversations")).status).toBe(403);
    const all = await request("platform", "/platform/conversations");
    expect(all.body.conversations.map((row) => row.id)).toEqual(
      expect.arrayContaining([a.id, b.id])
    );
    const filtered = await request(
      "platform",
      "/platform/conversations?tenantId=tenant-b"
    );
    expect(
      filtered.body.conversations.every((row) => row.tenantId === "tenant-b")
    ).toBe(true);
    expect(
      (
        await request("platform", `/platform/conversations/${b.id}`)
      ).body.messages.map((row) => row.content)
    ).toEqual(["B question", "B answer"]);
    const renamed = await request(
      "platform",
      `/platform/conversations/${b.id}`,
      "PATCH",
      { title: "Managed B" }
    );
    expect(renamed).toMatchObject({
      status: 200,
      body: { conversation: { title: "Managed B" } },
    });
    expect(
      (
        await request("platform", `/platform/conversations/${b.id}`, "PATCH", {
          title: " ",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request("platform", `/platform/messages/${two.id}`, "PATCH", {
          role: "user",
          content: "Managed question",
        })
      ).body.messages[0].content
    ).toBe("Managed question");
    expect(
      (
        await request("platform", `/platform/messages/${one.id}`, "PATCH", {
          role: "assistant",
          content: "Managed answer",
        })
      ).body.messages[1]
    ).toMatchObject({
      content: "Managed answer",
      sources: [{ text: "Snapshot" }],
    });
    for (const body of [
      { role: "system", content: "Injected" },
      { role: "user", content: " " },
      { role: "user", content: 4 },
    ])
      expect(
        (
          await request(
            "platform",
            `/platform/messages/${one.id}`,
            "PATCH",
            body
          )
        ).status
      ).toBe(400);
    expect(
      (
        await request(
          "platform",
          `/platform/conversations/${a.id}/reset-history`,
          "POST",
          {}
        )
      ).status
    ).toBe(200);
    expect(
      (await Chat.get(ctx.a1, { id: one.id }, mockStore.orm)).include
    ).toBe(false);
    expect(
      (await request("platform", `/platform/messages/${one.id}`, "DELETE"))
        .status
    ).toBe(200);
    expect(
      (await request("platform", `/platform/conversations/${b.id}`, "DELETE"))
        .status
    ).toBe(200);
    expect(await Chat.get(ctx.b1, { id: two.id }, mockStore.orm)).toBeNull();
    for (const [url, method, body] of [
      ["/platform/conversations/missing", "GET"],
      ["/platform/conversations/missing", "PATCH", { title: "X" }],
      ["/platform/conversations/missing", "DELETE"],
      ["/platform/conversations/missing/reset-history", "POST", {}],
      ["/platform/messages/missing", "PATCH", { role: "user", content: "X" }],
      ["/platform/messages/missing", "DELETE"],
    ])
      expect((await request("platform", url, method, body)).status).toBe(404);
  } finally {
    delete ctx.platform;
  }
});

test("reset command keeps saved personal history, returns an ephemeral original response and rejects invalid requests", async () => {
  const { Chat } = require("../../models/workspaceChats");
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  const { chat } = await Chat.new(
    ctx.a1,
    {
      threadId: conversation.id,
      prompt: "Keep saved words",
      response: { text: "Saved answer" },
    },
    mockStore.orm
  );
  const count = mockProviders.complete.mock.calls.length;
  const reset = await request(
    "a1",
    `/conversations/${conversation.id}/messages`,
    "POST",
    { message: "/reset" }
  );
  expect(reset.status).toBe(200);
  expect(reset.body).toMatchObject({
    action: "reset_chat",
    message: { ephemeral: true, content: "Chat memory was reset!" },
  });
  expect((await Chat.get(ctx.a1, { id: chat.id }, mockStore.orm)).include).toBe(
    false
  );
  expect(
    (await request("a1", `/conversations/${conversation.id}`)).body.messages
  ).toHaveLength(0);
  expect(mockProviders.complete.mock.calls.length).toBe(count);
  await expect(
    rag.executeChat({ ctx: ctx.a1, persist: false, prompt: "/reset" })
  ).rejects.toMatchObject({ status: 400 });
  for (const message of ["", " ", null, 42])
    expect(
      (
        await request(
          "a1",
          `/conversations/${conversation.id}/messages`,
          "POST",
          { message }
        )
      ).status
    ).toBe(400);
  const stream = await fetch(
    `${base}/conversations/${conversation.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "a1" },
      body: JSON.stringify({ message: "", stream: true }),
    }
  );
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  expect(await stream.text()).toContain('"type":"abort"');
  expect(
    (
      await request(
        "a2",
        `/conversations/${conversation.id}/messages`,
        "POST",
        { message: "Stolen" }
      )
    ).status
  ).toBe(404);
});

test("ephemeral personal execution preserves protocol history, streaming metrics and route notifications without storing a conversation", async () => {
  const before = await mockStore.orm.chats.count();
  const resolve = mockProviders.resolveConnection.getMockImplementation();
  const complete = mockProviders.complete.getMockImplementation();
  mockProviders.resolveConnection.mockImplementation(async (...args) => ({
    ...(await resolve(...args)),
    resolvedProvider: {
      routingMetadata: {
        routedTo: { shouldNotify: true, model: "routed-model" },
      },
    },
  }));
  mockProviders.complete.mockImplementation(
    async (_connection, messages, onToken, options) => {
      expect(
        messages.some((message) =>
          message.content?.includes?.("Earlier answer")
        )
      ).toBe(true);
      options.onMetrics({ output_tokens: 3 });
      await onToken("A");
      await onToken("B");
      return "AB";
    }
  );
  try {
    const events = [];
    const result = await rag.executeChat({
      ctx: ctx.a1,
      persist: false,
      prompt: "Current question",
      history: [
        { role: "system", content: "Skip system row" },
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Unanswered" },
      ],
      systemPrompt: "Explicit system",
      model: "chosen-model",
      temperature: 0.7,
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({
      textResponse: "AB",
      metrics: { output_tokens: 3 },
      message: { content: "AB" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "modelRouteNotification",
      "textResponseChunk",
      "textResponseChunk",
      "finalizeResponseStream",
    ]);
    expect(
      events
        .filter((event) => event.type === "textResponseChunk")
        .map((event) => event.textResponse)
        .join("")
    ).toBe("AB");
    expect(await mockStore.orm.chats.count()).toBe(before);
    expect(mockProviders.resolveConnection).toHaveBeenCalledWith(
      ctx.a1,
      "chat",
      expect.objectContaining({ model: "chosen-model", temperature: 0.7 })
    );
  } finally {
    mockProviders.complete.mockImplementation(complete);
    mockProviders.resolveConnection.mockImplementation(resolve);
  }
});

test("empty upstream answers release personal generation locks and a pending generation blocks destructive regeneration", async () => {
  const { Chat } = require("../../models/workspaceChats");
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  const { chat } = await Chat.new(
    ctx.a1,
    {
      threadId: conversation.id,
      prompt: "Existing",
      response: { text: "Existing answer" },
    },
    mockStore.orm
  );
  const complete = mockProviders.complete.getMockImplementation();
  mockProviders.complete.mockResolvedValueOnce(" ");
  expect(
    (
      await request(
        "a1",
        `/conversations/${conversation.id}/messages`,
        "POST",
        { message: "Empty answer" }
      )
    ).status
  ).toBe(502);
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  mockProviders.complete.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = request(
    "a1",
    `/conversations/${conversation.id}/messages`,
    "POST",
    { message: "Pending generation" }
  );
  try {
    await ready;
    expect(
      (
        await request(
          "a1",
          `/conversations/${conversation.id}/messages`,
          "POST",
          { message: "Concurrent" }
        )
      ).status
    ).toBe(409);
    expect(
      (
        await request("a1", `/messages/${chat.id}/truncate`, "POST", {
          regenerate: true,
        })
      ).status
    ).toBe(409);
  } finally {
    release("Finished");
    mockProviders.complete.mockImplementation(complete);
  }
  expect((await pending).status).toBe(200);
});

test("only grants authorize knowledge; creation tenant and creator are audit metadata", () => {
  const library = {
    tenantId: "tenant-a",
    createdBy: "a1",
    grants: [{ userId: 1 }],
  };
  expect(knowledge.allowedLibrary(library, ctx.a1)).toBe(true);
  expect(knowledge.allowedLibrary(library, ctx.aa)).toBe(false);
  expect(knowledge.allowedLibrary(library, ctx.b1)).toBe(false);
  expect(
    knowledge.allowedLibrary(
      { ...library, grants: [{ tenantId: "tenant-b" }] },
      ctx.b1
    )
  ).toBe(true);
  expect(knowledge.allowedLibrary({ ...library, grants: [] }, ctx.a1)).toBe(
    false
  );
});

test("default chat without knowledge calls the model without requiring embedding and replays complete personal turns", async () => {
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  const calls = mockProviders.complete.mock.calls.length;
  const embeddingCalls = mockProviders.resolveConnection.mock.calls.filter(
    ([, kind]) => kind === "embedding"
  ).length;
  const first = await request(
    "a1",
    `/conversations/${conversation.id}/messages`,
    "POST",
    {
      message: "你好，请介绍一下你自己。",
    }
  );
  expect(first.status).toBe(200);
  expect(mockProviders.complete.mock.calls.length).toBe(calls + 1);
  expect(first.body.message.sources).toEqual([]);
  expect(
    mockProviders.resolveConnection.mock.calls.filter(
      ([, kind]) => kind === "embedding"
    )
  ).toHaveLength(embeddingCalls);
  const stored = await mockStore.one(
    "SELECT * FROM chats WHERE thread_id=$1",
    conversation.id
  );
  expect(stored.include).toBe(true);
  expect(JSON.parse(stored.response)).toMatchObject({
    type: "chat",
    sources: [],
  });
  expect(await rag.modelHistory(ctx.a1, conversation.id)).toHaveLength(1);
  const second = await request(
    "a1",
    `/conversations/${conversation.id}/messages`,
    "POST",
    {
      message: "你刚才说了什么？",
    }
  );
  expect(second.status).toBe(200);
  const modelInput = mockProviders.complete.mock.calls.at(-1)[1];
  expect(modelInput).toEqual(
    expect.arrayContaining([
      { role: "user", content: "你好，请介绍一下你自己。" },
      { role: "assistant", content: first.body.message.content },
    ])
  );
  expect(modelInput[0].content).not.toContain("\nContext:\n");
});

test("query without knowledge refuses without a provider call and excludes the saved refusal from model history", async () => {
  const { DEFAULTS } = require("../../enterprise/rag-settings");
  await mockStore.run(
    'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3)',
    ctx.a1.tenantId,
    JSON.stringify({ ...DEFAULTS, chatMode: "query" }),
    mockStore.now()
  );
  try {
    const conversation = (await request("a1", "/conversations", "POST", {}))
      .body.conversation;
    const calls = mockProviders.complete.mock.calls.length;
    const connections = mockProviders.resolveConnection.mock.calls.length;
    const response = await request(
      "a1",
      `/conversations/${conversation.id}/messages`,
      "POST",
      {
        message: "我们公司的报销规则是什么？",
      }
    );
    expect(response.status).toBe(200);
    expect(response.body.message.content).toBe(
      "当前可检索资料中没有找到足够依据。请补充相关资料，或描述得更具体一些。"
    );
    expect(response.body.message.sources).toEqual([]);
    expect(mockProviders.complete.mock.calls.length).toBe(calls);
    expect(mockProviders.resolveConnection.mock.calls.length).toBe(connections);
    const stored = await mockStore.one(
      "SELECT * FROM chats WHERE thread_id=$1",
      conversation.id
    );
    expect(stored.include).toBe(false);
    expect(JSON.parse(stored.response)).toMatchObject({
      type: "query",
      sources: [],
    });
    expect(await rag.modelHistory(ctx.a1, conversation.id)).toEqual([]);
    expect(
      (await request("a1", `/conversations/${conversation.id}`)).body.messages
    ).toHaveLength(0);
  } finally {
    await mockStore.run(
      'DELETE FROM ep_rag_settings WHERE "tenantId"=$1',
      ctx.a1.tenantId
    );
  }
});

test("the upload contract exposes actual supported formats and reprocessing reuses only the same document embeddings", async () => {
  const types = await request("a1", "/file-types");
  expect(types.status).toBe(200);
  expect(types.body.extensions).toEqual(
    require("../../utils/files/types").extensions
  );
  expect(types.body.maxFileSizeBytes).toBe(
    require("../../utils/files/types").maxFileSizeBytes
  );
  expect(types.body.textFallback).toBe(true);
  expect(types.body.extensions).toEqual(
    expect.arrayContaining([".wav", ".mp3", ".mp4", ".mov", ".webm"])
  );
  const lib = await library("a1", "缓存回归", "private");
  const doc = await document(
    "a1",
    lib.id,
    "缓存",
    "这是一段仅属于本资料的缓存内容。"
  );
  mockProviders.embed.mockClear();
  expect(
    (await request("a1", `/documents/${doc.id}/retry`, "POST")).status
  ).toBe(202);
  await ready(doc.id);
  expect(mockProviders.embed).not.toHaveBeenCalled();
  // A backend rebuild must reuse this document's persisted cache even when
  // its previously published vectors are no longer present at the target.
  const indexed = await mockStore.all(
    'SELECT id,namespace FROM ep_chunks WHERE "documentId"=$1',
    doc.id
  );
  await vectorStore.withWrite(async (backend) => {
    for (const row of indexed)
      await backend.delete({ namespace: row.namespace, ids: [row.id] });
  });
  await request("a1", `/documents/${doc.id}/retry`, "POST");
  await ready(doc.id);
  expect(mockProviders.embed).not.toHaveBeenCalled();
  await document(
    "a1",
    lib.id,
    "另一份资料",
    "这是一段仅属于本资料的缓存内容。"
  );
  expect(mockProviders.embed).toHaveBeenCalled();
  await mockStore.run(
    'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3) ON CONFLICT("tenantId") DO UPDATE SET settings=excluded.settings',
    "tenant-a",
    JSON.stringify({ embeddingCache: false }),
    mockStore.now()
  );
  try {
    mockProviders.embed.mockClear();
    await request("a1", `/documents/${doc.id}/retry`, "POST");
    await ready(doc.id);
    expect(mockProviders.embed).toHaveBeenCalled();
  } finally {
    await mockStore.run(
      'DELETE FROM ep_rag_settings WHERE "tenantId"=$1',
      "tenant-a"
    );
  }
});

test("reranking receives only current authorized candidates and retains valid source identities", async () => {
  const lib = await library("a1", "重排回归", "private");
  const doc = await document(
    "a1",
    lib.id,
    "重排",
    "重排只处理当前用户有权访问的内容。"
  );
  const reranker = require("../../enterprise/rerank");
  const probe = jest
    .spyOn(reranker, "rerank")
    .mockImplementation(async (_query, rows) => {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const allowed = await knowledge.requireDocument(ctx.a1, row.documentId);
        expect(allowed.tenantId).toBe(ctx.a1.tenantId);
      }
      return rows
        .filter((row) => row.documentId === doc.id)
        .map((row, index) => ({ ...row, citationNumber: index + 1 }));
    });
  try {
    const result = await rag.retrieve(
      ctx.a1,
      "重排",
      { id: "embedding", version: 1 },
      {
        ...require("../../enterprise/rag-settings").DEFAULTS,
        rerank: true,
      }
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((source) => source.documentId === doc.id)).toBe(true);
    expect(result[0].citationNumber).toBe(1);
  } finally {
    probe.mockRestore();
  }
});

test("saved complete pairs retain insertion order when timestamps are equal", async () => {
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  const stamp = new Date("2026-10-21T00:00:00.000Z");
  const messages = [
    ["900001:user", "user", "第一问"],
    [900001, "assistant", "第一答"],
    ["900002:user", "user", "第二问"],
    [900002, "assistant", "第二答"],
  ];
  await mockStore.run(
    'INSERT INTO chats(id,"tenantId","userId",thread_id,prompt,response,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
    900001,
    ctx.a1.tenantId,
    ctx.a1.userId,
    conversation.id,
    "第一问",
    JSON.stringify({
      text: "第一答",
      sources: [],
    }),
    stamp
  );
  await mockStore.run(
    'INSERT INTO chats(id,"tenantId","userId",thread_id,prompt,response,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$7)',
    900002,
    ctx.a1.tenantId,
    ctx.a1.userId,
    conversation.id,
    "第二问",
    JSON.stringify({
      text: "第二答",
      sources: [],
    }),
    stamp
  );
  expect(
    (await rag.modelHistory(ctx.a1, conversation.id)).map(
      (record) => record.prompt
    )
  ).toEqual(["第一问", "第二问"]);
  const response = await request("a1", `/conversations/${conversation.id}`);
  expect(response.status).toBe(200);
  expect(response.body.messages.map((message) => message.id)).toEqual(
    messages.map(([id]) => id)
  );
});

test("the original pair model enforces tenant and personal ownership for writes, feedback, history reset and memory flags", async () => {
  const { Chat } = require("../../models/workspaceChats");
  const { ChatThread } = require("../../models/workspaceThread");
  const lib = await library("a1", "成对会话权限", "private");
  const doc = await document("a1", lib.id, "会话依据", "成对保存和个人权限。");
  const source = await mockStore.one(
    'SELECT id FROM ep_chunks WHERE "documentId"=$1',
    doc.id
  );
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  const payload = {
    prompt: "原版问答结构如何复用？",
    response: {
      text: "通过租户和本人归属复用。",
      sources: [{ id: source.id }],
      metrics: { output_tokens: 6 },
    },
    threadId: conversation.id,
  };
  for (const other of [ctx.a2, ctx.aa, ctx.b1]) {
    await expect(Chat.new(other, payload, mockStore.orm)).rejects.toMatchObject(
      {
        status: 404,
      }
    );
    expect(
      await ChatThread.get(other, { id: conversation.id }, mockStore.orm)
    ).toBeNull();
  }
  await expect(
    Chat.new({ identity: "platform" }, payload, mockStore.orm)
  ).rejects.toMatchObject({ status: 401 });
  for (const response of [{}, { text: "" }, { text: "   " }])
    await expect(
      Chat.new(ctx.a1, { ...payload, response }, mockStore.orm)
    ).rejects.toMatchObject({ status: 400 });
  const { chat } = await Chat.new(ctx.a1, payload, mockStore.orm);
  expect(chat).toMatchObject({
    tenantId: ctx.a1.tenantId,
    userId: ctx.a1.userId,
    thread_id: conversation.id,
    prompt: payload.prompt,
    include: true,
    feedbackScore: null,
    api_session_id: null,
    memoryProcessed: null,
  });
  expect(JSON.parse(chat.response)).toEqual(payload.response);
  expect(await rag.modelHistory(ctx.a1, conversation.id)).toHaveLength(1);
  expect(
    await Chat.where(ctx.a2, { id: chat.id, userId: 1 }, {}, mockStore.orm)
  ).toEqual([]);
  await expect(rag.modelHistory(ctx.a2, conversation.id)).rejects.toMatchObject(
    {
      status: 404,
    }
  );
  for (const actor of ["a2", "aa", "b1"])
    expect(
      (
        await request(actor, `/messages/${chat.id}/feedback`, "POST", {
          feedbackScore: true,
        })
      ).status
    ).toBe(404);
  expect(
    (
      await request("a1", `/messages/${chat.id}/feedback`, "POST", {
        feedbackScore: "admin",
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("a1", `/messages/${chat.id}/feedback`, "POST", {
        feedbackScore: true,
      })
    ).status
  ).toBe(200);
  await Chat.markMemoryProcessed(ctx.a2, [chat.id], mockStore.orm);
  expect(
    (await Chat.get(ctx.a1, { id: chat.id }, mockStore.orm)).memoryProcessed
  ).toBeNull();
  await Chat.markMemoryProcessed(ctx.a1, [chat.id], mockStore.orm);
  expect(
    (await Chat.get(ctx.a1, { id: chat.id }, mockStore.orm)).memoryProcessed
  ).toBe(true);
  const visible = await request("a1", `/conversations/${conversation.id}`);
  expect(visible.body.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);
  expect(visible.body.messages[1]).toMatchObject({
    id: chat.id,
    chatId: chat.id,
    content: payload.response.text,
    feedbackScore: true,
    metrics: payload.response.metrics,
  });
  expect(
    (
      await request(
        "a2",
        `/conversations/${conversation.id}/reset-history`,
        "POST",
        {}
      )
    ).status
  ).toBe(404);
  expect(
    (
      await request(
        "a1",
        `/conversations/${conversation.id}/reset-history`,
        "POST",
        {}
      )
    ).status
  ).toBe(200);
  expect(await rag.modelHistory(ctx.a1, conversation.id)).toEqual([]);
  expect(
    (await request("a1", `/conversations/${conversation.id}`)).body.messages
  ).toHaveLength(0);
  const update = await ChatThread.update(
    ctx.a2,
    conversation.id,
    { name: "不允许改名", userId: 2, tenantId: "tenant-b" },
    mockStore.orm
  );
  expect(update.thread).toBeNull();
  expect(
    (await request("a2", `/conversations/${conversation.id}`, "DELETE")).status
  ).toBe(404);
  expect(
    (await request("a1", `/conversations/${conversation.id}`, "DELETE")).status
  ).toBe(200);
  expect(await Chat.get(ctx.a1, { id: chat.id }, mockStore.orm)).toBeNull();
});

test("a streamed provider failure saves no partial pair and cannot pair a failed question with the next answer", async () => {
  const lib = await library("a1", "流式成对提交", "private");
  await document(
    "a1",
    lib.id,
    "有效依据",
    "失败回答不保存，后续回答独立配对。"
  );
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  mockProviders.complete.mockImplementationOnce(
    async (_connection, _messages, onToken) => {
      await onToken("尚未完成的片段");
      throw new Error("provider-stopped-midstream");
    }
  );
  const failed = await fetch(
    `${base}/conversations/${conversation.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "a1" },
      body: JSON.stringify({ message: "失败的问题", stream: true }),
    }
  );
  const events = await failed.text();
  expect(events).toContain('"type":"abort"');
  expect(events).not.toContain('"type":"finalizeResponseStream"');
  expect(
    await mockStore.all(
      "SELECT * FROM chats WHERE thread_id=$1",
      conversation.id
    )
  ).toEqual([]);
  expect(
    (await request("a1", `/conversations/${conversation.id}`)).body.messages
  ).toEqual([]);
  const next = await request(
    "a1",
    `/conversations/${conversation.id}/messages`,
    "POST",
    {
      message: "独立的新问题",
    }
  );
  expect(next.status).toBe(200);
  const records = await mockStore.all(
    "SELECT * FROM chats WHERE thread_id=$1",
    conversation.id
  );
  expect(records).toHaveLength(1);
  expect(records[0].prompt).toBe("独立的新问题");
  expect(JSON.parse(records[0].response).text).toBe(next.body.message.content);
  expect(
    (await request("a1", `/conversations/${conversation.id}`)).body.messages[0]
      .content
  ).toBe("独立的新问题");
});

test("chat and query both retrieve authorized knowledge while query refuses when retrieval has no match", async () => {
  const { DEFAULTS } = require("../../enterprise/rag-settings");
  const lib = await library("a1", "对话模式资料", "private");
  const doc = await document(
    "a1",
    lib.id,
    "模式规则",
    "两种模式均检索可访问的资料。"
  );
  try {
    for (const chatMode of ["chat", "query"]) {
      await mockStore.run(
        'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3) ON CONFLICT("tenantId") DO UPDATE SET settings=excluded.settings',
        ctx.a1.tenantId,
        JSON.stringify({ ...DEFAULTS, chatMode, topK: 20 }),
        mockStore.now()
      );
      const conversation = (await request("a1", "/conversations", "POST", {}))
        .body.conversation;
      const calls = mockProviders.complete.mock.calls.length;
      const answer = await request(
        "a1",
        `/conversations/${conversation.id}/messages`,
        "POST",
        {
          message: "模式规则是什么？",
        }
      );
      expect(answer.status).toBe(200);
      expect(mockProviders.complete.mock.calls.length).toBe(calls + 1);
      expect(
        answer.body.message.sources.map((source) => source.documentId)
      ).toContain(doc.id);
      const modelInput = mockProviders.complete.mock.calls.at(-1)[1];
      expect(modelInput[0].content).toContain("[CONTEXT 0]");
      if (chatMode === "query") {
        const search = jest
          .spyOn(vectorStore, "withDatabase")
          .mockImplementation(async (callback) =>
            callback({ search: async () => [] })
          );
        try {
          const withHistory = await request(
            "a1",
            `/conversations/${conversation.id}/messages`,
            "POST",
            { message: "上一条规则呢？" }
          );
          expect(withHistory.status).toBe(200);
          expect(withHistory.body.message.sources).toEqual([]);
          expect(mockProviders.complete.mock.calls.length).toBe(calls + 2);
          expect(
            mockProviders.complete.mock.calls.at(-1)[1][0].content
          ).toContain("两种模式均检索可访问的资料。");
          const emptyConversation = (
            await request("a1", "/conversations", "POST", {})
          ).body.conversation;
          const noMatch = await request(
            "a1",
            `/conversations/${emptyConversation.id}/messages`,
            "POST",
            {
              message: "资料中没有的规则是什么？",
            }
          );
          expect(noMatch.status).toBe(200);
          expect(noMatch.body.message.content).toContain("没有找到足够依据");
          expect(mockProviders.complete.mock.calls.length).toBe(calls + 2);
        } finally {
          search.mockRestore();
        }
      }
    }
  } finally {
    await mockStore.run(
      'DELETE FROM ep_rag_settings WHERE "tenantId"=$1',
      ctx.a1.tenantId
    );
  }
});

test("public documents can be maintained by peers; private and cross-tenant resources are hidden on every endpoint", async () => {
  const pub = await library("a1", "团队资料", "public");
  const priv = await library("a1", "个人资料", "private");
  const listedLibraries = await request("a1", "/libraries");
  expect(listedLibraries.status).toBe(200);
  expect(typeof listedLibraries.body.libraries[0].documentCount).toBe("number");
  expect(priv.createdBy).toBe("1");
  expect(priv.tenantId).toBe("tenant-a");
  const shared = await document(
    "a1",
    pub.id,
    "公有规则",
    "允许所有租户同事维护的规则。"
  );
  const secret = await document(
    "a1",
    priv.id,
    "私人规则",
    "仅本人可访问的秘密规则。"
  );
  const peerEdit = await request("a2", `/documents/${shared.id}`, "PATCH", {
    content: "另一位同事修改后的公有规则。",
  });
  expect(peerEdit.status).toBe(202);
  expect(
    (
      await request(
        "aa",
        `/knowledge-changes/${peerEdit.body.change.id}/review`,
        "POST",
        { decision: "approve" }
      )
    ).status
  ).toBe(200);
  await ready(shared.id, "a2");
  for (const user of ["a2", "aa", "b1"]) {
    for (const [suffix, method, body] of [
      ["", "GET"],
      ["", "PATCH", { title: "越权" }],
      ["", "DELETE"],
      ["/retry", "POST"],
      ["/download", "GET"],
    ]) {
      expect(
        (await request(user, `/documents/${secret.id}${suffix}`, method, body))
          .status
      ).toBe(404);
    }
    expect(
      (await request(user, `/documents?libraryId=${priv.id}`)).status
    ).toBe(404);
    expect(
      (
        await request(user, "/documents", "POST", {
          libraryId: priv.id,
          title: "越权",
          content: "越权",
        })
      ).status
    ).toBe(404);
    const listed = await request(user, "/documents");
    expect(listed.body.documents.map((d) => d.id)).not.toContain(secret.id);
  }
  expect((await request("b1", `/documents/${shared.id}`)).status).toBe(404);
  const removal = await request("a2", `/documents/${shared.id}`, "DELETE");
  expect(removal.status).toBe(202);
  expect(
    (
      await request(
        "aa",
        `/knowledge-changes/${removal.body.change.id}/review`,
        "POST",
        { decision: "approve" }
      )
    ).status
  ).toBe(200);
});

test("replacement and deletion prevent stale jobs and stale chunks from reappearing", async () => {
  const lib = await library("a1", "版本资料", "private");
  const doc = await document(
    "a1",
    lib.id,
    "发布规则",
    "旧版：交付截止日期是周一。"
  );
  await request("a1", `/documents/${doc.id}`, "PATCH", {
    content: "新版：交付截止日期是周五。",
  });
  const updated = await ready(doc.id);
  expect(updated.version).toBe(2);
  await knowledge.indexDocument(doc.id, 1, ctx.a1);
  const chunks = await mockStore.all(
    'SELECT * FROM ep_chunks WHERE "documentId" = $1',
    doc.id
  );
  expect(chunks.length).toBeGreaterThan(0);
  expect(
    chunks.every(
      (chunk) => chunk.version === 2 && chunk.content.includes("周五")
    )
  ).toBe(true);
  await request("a1", `/documents/${doc.id}`, "DELETE");
  await knowledge.indexDocument(doc.id, 2, ctx.a1);
  expect(
    await mockStore.one("SELECT id FROM ep_documents WHERE id = $1", doc.id)
  ).toBeNull();
  expect(
    await mockStore.all(
      'SELECT id FROM ep_chunks WHERE "documentId" = $1',
      doc.id
    )
  ).toEqual([]);
});

test("same-name TXT/MD uploads use distinct resources and enforce authorization before storage", async () => {
  const own = await library("a1", "上传资料", "private");
  const shared = await library("b1", "其他租户上传", "private");
  const upload = async (user, libraryId, filename, content) => {
    const form = new FormData();
    form.set("libraryId", libraryId);
    form.set("file", new Blob([content], { type: "text/plain" }), filename);
    const response = await fetch(`${base}/documents/upload`, {
      method: "POST",
      headers: { "x-test-user": user, host: `${ctx[user].tenantId}.localhost` },
      body: form,
    });
    return { status: response.status, body: await response.json() };
  };
  expect(
    (await upload("a2", own.id, "same.txt", "blocked secret")).status
  ).toBe(404);
  const a = await upload("a1", own.id, "same.txt", "A TXT 原始文字。");
  const b = await upload("b1", shared.id, "same.txt", "B TXT 原始文字。");
  const md = await upload(
    "a1",
    own.id,
    "same.md",
    "# Markdown\n独立 Markdown 资料。"
  );
  for (const item of [a, b, md]) expect(item.status).toBe(202);
  expect((await ready(a.body.document.id)).content).toContain("A TXT");
  expect((await ready(b.body.document.id, "b1")).content).toContain("B TXT");
  expect((await ready(md.body.document.id)).content).toContain("Markdown");
  const originals = await mockStore.all(
    'SELECT "originalPath" FROM ep_documents WHERE id IN ($1,$2,$3)',
    a.body.document.id,
    b.body.document.id,
    md.body.document.id
  );
  expect(new Set(originals.map((item) => item.originalPath)).size).toBe(3);
  expect(
    originals.every(
      (item) =>
        path
          .resolve(item.originalPath)
          .startsWith(path.join(temp, "enterprise") + path.sep) &&
        knowledge.safeOriginal(item.originalPath) &&
        fs.existsSync(item.originalPath)
    )
  ).toBe(true);
  await request("a1", `/documents/${a.body.document.id}`, "DELETE");
  const survivor = await fetch(
    `${base}/documents/${b.body.document.id}/download`,
    { headers: { "x-test-user": "b1", host: "tenant-b.localhost" } }
  );
  // Download is deliberately plain text; fetch it directly to verify the other
  // tenant's identically named original was not overwritten or removed.
  expect(survivor.status).toBe(200);
  expect(await survivor.text()).toContain("B TXT");
  await request("b1", `/documents/${b.body.document.id}`, "DELETE");
  await request("a1", `/documents/${md.body.document.id}`, "DELETE");
});

test("unknown text uploads use signed Collector fallback while binary parse failures never publish chunks", async () => {
  const own = await library("a1", "原版格式检测", "private");
  const uploads = [
    [
      "guide.customtext",
      Buffer.from("未知格式文字规则：报销截止日期为周五。"),
      true,
    ],
    ["binary.custombin", Buffer.from([0, 1, 2, 3, 0, 4, 5, 6]), false],
    [
      "program.exe",
      Buffer.from("not accepted as text despite printable bytes"),
      false,
    ],
  ];
  for (const [filename, bytes, valid] of uploads) {
    const created = await uploadFile("a1", own.id, filename, bytes);
    expect(created.status).toBe(202);
    const id = created.body.document.id;
    try {
      if (valid) {
        const indexed = await ready(id);
        expect(indexed.content).toBe(bytes.toString());
        expect(
          await mockStore.all(
            'SELECT id FROM ep_chunks WHERE "documentId"=$1',
            id
          )
        ).not.toHaveLength(0);
      } else {
        let failed;
        for (let attempt = 0; attempt < 100; attempt++) {
          failed = (await request("a1", `/documents/${id}`)).body.document;
          if (failed.status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        expect(failed).toMatchObject({ status: "failed", hasOriginal: true });
        expect(failed.error).toBe("Response could not be completed");
        expect(failed.error).not.toContain(temp);
        expect(
          await mockStore.all(
            'SELECT id FROM ep_chunks WHERE "documentId"=$1',
            id
          )
        ).toEqual([]);
      }
      const stored = await mockStore.one(
        'SELECT "originalPath" FROM ep_documents WHERE id=$1',
        id
      );
      expect(fs.readFileSync(stored.originalPath)).toEqual(bytes);
      expect((await request("a2", `/documents/${id}`)).status).toBe(404);
    } finally {
      await request("a1", `/documents/${id}`, "DELETE");
    }
  }
});

test("saving unchanged extracted DOCX text preserves the original and index; editing the text converts it", async () => {
  const { Document, Packer, Paragraph } = require("docx");
  const collector = require("../../utils/collectorApi");
  const originalText = "DOCX 原始规则：交付截止日期是周五。";
  const parse = jest
    .spyOn(collector.CollectorApi.prototype, "parseDocument")
    .mockResolvedValue({
      success: true,
      documents: [{ pageContent: originalText }],
    });
  let documentId;
  try {
    const lib = await library("a1", "文件编辑语义", "private");
    const bytes = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph(originalText)] }] })
    );
    const form = new FormData();
    form.set("libraryId", lib.id);
    form.set("file", new Blob([bytes]), "original.docx");
    const upload = await fetch(`${base}/documents/upload`, {
      method: "POST",
      headers: { "x-test-user": "a1", host: "tenant-a.localhost" },
      body: form,
    });
    expect(upload.status).toBe(202);
    documentId = (await upload.json()).document.id;
    const indexed = await ready(documentId);
    const before = await mockStore.one(
      'SELECT "originalPath" FROM ep_documents WHERE id=$1',
      documentId
    );
    const chunks = await mockStore.all(
      'SELECT id,version FROM ep_chunks WHERE "documentId"=$1',
      documentId
    );
    const embeddingCalls = mockProviders.embed.mock.calls.length;
    const saved = await request("a1", `/documents/${documentId}`, "PATCH", {
      title: "已修改标题.docx",
      content: indexed.content,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.document).toMatchObject({
      title: "已修改标题.docx",
      inputType: "file",
      hasOriginal: true,
      status: "ready",
      version: indexed.version,
    });
    expect(
      (
        await mockStore.one(
          'SELECT "originalPath" FROM ep_documents WHERE id=$1',
          documentId
        )
      ).originalPath
    ).toBe(before.originalPath);
    expect(
      await mockStore.all(
        'SELECT id,version FROM ep_chunks WHERE "documentId"=$1',
        documentId
      )
    ).toEqual(chunks);
    expect(mockProviders.embed.mock.calls.length).toBe(embeddingCalls);
    const download = await fetch(`${base}/documents/${documentId}/download`, {
      headers: { "x-test-user": "a1", host: "tenant-a.localhost" },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

    const changed = await request("a1", `/documents/${documentId}`, "PATCH", {
      title: "确实编辑正文",
      content: "新规则：交付截止日期改为周四。",
    });
    expect(changed.status).toBe(200);
    const final = await ready(documentId);
    expect(final).toMatchObject({
      inputType: "text",
      hasOriginal: false,
      version: indexed.version + 1,
    });
    expect(final.content).toContain("周四");
    expect(fs.existsSync(before.originalPath)).toBe(false);
    expect(
      (await request("a1", `/documents/${documentId}/download`)).status
    ).toBe(404);
  } finally {
    parse.mockRestore();
    if (documentId) await request("a1", `/documents/${documentId}`, "DELETE");
  }
});

test("UTF-16 originals index Chinese text and locked deleted originals survive as recoverable cleanup tasks", async () => {
  const lib = await library("a1", "编码与删除恢复", "private");
  const text = "差旅住宿标准为每晚 460 元，财务须复核发票。";
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text, "utf16le"),
  ]);
  const form = new FormData();
  form.set("libraryId", lib.id);
  form.set("file", new Blob([bytes]), "windows-unicode.txt");
  const response = await fetch(`${base}/documents/upload`, {
    method: "POST",
    headers: { "x-test-user": "a1", host: "tenant-a.localhost" },
    body: form,
  });
  expect(response.status).toBe(202);
  const doc = await ready((await response.json()).document.id);
  expect(doc.content).toBe(text);
  const stored = await mockStore.one(
    'SELECT "originalPath" FROM ep_documents WHERE id=$1',
    doc.id
  );
  const unlink = fs.promises.unlink;
  const blocked = jest
    .spyOn(fs.promises, "unlink")
    .mockImplementation(async (target) => {
      if (target === stored.originalPath)
        throw Object.assign(new Error("locked original"), { code: "EACCES" });
      return unlink(target);
    });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await request("a1", `/documents/${doc.id}`, "DELETE")).status).toBe(
      200
    );
    expect(
      await mockStore.one("SELECT id FROM ep_documents WHERE id=$1", doc.id)
    ).toBeNull();
    expect(
      await mockStore.one(
        "SELECT * FROM ep_file_cleanup WHERE path=$1",
        stored.originalPath
      )
    ).toMatchObject({ tenantId: "tenant-a" });
    expect(fs.existsSync(stored.originalPath)).toBe(true);
  } finally {
    blocked.mockRestore();
    log.mockRestore();
  }
  expect(await require("../../enterprise/file-store").recoverCleanup()).toBe(
    true
  );
  expect(fs.existsSync(stored.originalPath)).toBe(false);
  expect(
    await mockStore.one(
      "SELECT * FROM ep_file_cleanup WHERE path=$1",
      stored.originalPath
    )
  ).toBeNull();
});

test("retrieval combines authorized public and own private sources without leaking other tenants or owners", async () => {
  const pub = await library("a1", "联合公开", "public");
  const own = await library("a1", "联合私有", "private");
  const other = await library("a2", "他人私有", "private");
  const foreign = await library("b1", "其他租户", "public");
  const visible = [
    await document("a1", pub.id, "同名资料", "公开检索标记。"),
    await document("a1", own.id, "同名资料", "本人私有检索标记。"),
  ];
  const hidden = [
    await document("a2", other.id, "同名资料", "他人私有绝密。"),
    await document("b1", foreign.id, "同名资料", "跨租户绝密。"),
  ];
  // This suite intentionally indexes many equal vectors. Request enough
  // results to exercise both authorization classes independently of default topN.
  const sources = await rag.retrieve(
    ctx.a1,
    "检索标记",
    { id: "embedding", version: 1 },
    { ...require("../../enterprise/rag-settings").DEFAULTS, topK: 20 }
  );
  for (const doc of visible)
    expect(sources.map((source) => source.documentId)).toContain(doc.id);
  for (const doc of hidden)
    expect(sources.map((source) => source.documentId)).not.toContain(doc.id);
  expect(
    sources
      .filter((source) => source.title === "同名资料")
      .map((source) => source.id).length
  ).toBe(2);
  const allChunks = await mockStore.all("SELECT id FROM ep_chunks");
  const permitted = await rag.currentSources(ctx.a1, allChunks);
  expect(
    permitted.every(
      (source) => !hidden.some((doc) => doc.id === source.documentId)
    )
  ).toBe(true);
  await expect(
    rag.retrieve(ctx.a1, "测试", { id: "embedding", version: 2 })
  ).rejects.toMatchObject({ status: 409 });
});

test("tenant splitting and retrieval settings change actual indexing and selection without rewriting other tenants", async () => {
  const { DEFAULTS } = require("../../enterprise/rag-settings");
  const { getSettings } = require("../../enterprise/rag-settings");
  const before = await mockStore.all(
    "SELECT * FROM ep_chunks WHERE \"tenantId\"='tenant-b'"
  );
  const settings = {
    ...DEFAULTS,
    chunkSize: 100,
    chunkOverlap: 10,
    topK: 1,
    similarityThreshold: 0.5,
  };
  await mockStore.run(
    'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3)',
    "tenant-a",
    JSON.stringify(settings),
    new Date().toISOString()
  );
  let documentId;
  try {
    const lib = await library("a1", "分片设置验证", "private");
    const doc = await document(
      "a1",
      lib.id,
      "长文本规则",
      Array.from(
        { length: 20 },
        (_, index) => `第${index + 1}条分片规则按企业设置生效。`
      ).join("\n")
    );
    documentId = doc.id;
    const chunks = await mockStore.all(
      'SELECT content FROM ep_chunks WHERE "documentId"=$1',
      doc.id
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (c) =>
          c.content.replace(
            /^<document_metadata>[\s\S]*?<\/document_metadata>\s*/,
            ""
          ).length <= 100
      )
    ).toBe(true);
    expect(await getSettings("tenant-b")).toEqual(DEFAULTS);
    expect(
      await mockStore.all(
        "SELECT * FROM ep_chunks WHERE \"tenantId\"='tenant-b'"
      )
    ).toEqual(before);
    // Isolate this document's embedding space so previous fixtures cannot
    // dominate ranking. The query vector is [1,0,0], giving these chunks a
    // cosine score of 0.6 between the configured acceptance/rejection values.
    const identity = "settings-probe:1";
    await mockStore.run(
      'UPDATE ep_documents SET "embeddingId"=$1 WHERE id=$2 AND "tenantId"=$3',
      identity,
      doc.id,
      ctx.a1.tenantId
    );
    await vectorStore.withWrite(async (backend) => {
      const stored = await mockStore.all(
        'SELECT id,namespace FROM ep_chunks WHERE "documentId"=$1',
        doc.id
      );
      const records = await backend.fetch({
        namespace: stored[0].namespace,
        ids: stored.map((row) => row.id),
      });
      const namespace = vectorStore.namespaceFor({
        tenantId: ctx.a1.tenantId,
        embeddingId: identity,
        dimensions: 3,
      });
      await backend.upsert({
        namespace,
        records: records.map((record) => ({
          ...record,
          embeddingId: identity,
          vector: [0.6, 0.8, 0],
        })),
      });
      await mockStore.run(
        'UPDATE ep_chunks SET "embeddingId"=$1,namespace=$2 WHERE "documentId"=$3 AND "tenantId"=$4',
        identity,
        namespace,
        doc.id,
        ctx.a1.tenantId
      );
      await backend.delete({
        namespace: stored[0].namespace,
        ids: stored.map((row) => row.id),
      });
    });
    const probe = { id: "settings-probe", version: 1 };
    expect(await rag.retrieve(ctx.a1, "分片规则", probe)).toHaveLength(1);
    expect(
      await rag.retrieve(ctx.a1, "分片规则", probe, { ...settings, topK: 2 })
    ).toHaveLength(2);
    await mockStore.run(
      'UPDATE ep_rag_settings SET settings=$1 WHERE "tenantId"=$2',
      JSON.stringify({ ...settings, similarityThreshold: 0.7 }),
      ctx.a1.tenantId
    );
    expect(await rag.retrieve(ctx.a1, "分片规则", probe)).toEqual([]);
  } finally {
    if (documentId) await request("a1", `/documents/${documentId}`, "DELETE");
    await mockStore.run(
      "DELETE FROM ep_rag_settings WHERE \"tenantId\"='tenant-a'"
    );
  }
});

test("model text limits clamp actual chunks and overlap before one batched embedding handoff", async () => {
  const { DEFAULTS } = require("../../enterprise/rag-settings");
  const previousLimit =
    mockProviders.embeddingChunkLimit.getMockImplementation();
  const settings = { ...DEFAULTS, chunkSize: 700, chunkOverlap: 300 };
  let documentId;
  await mockStore.run(
    'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3)',
    ctx.a1.tenantId,
    JSON.stringify(settings),
    new Date().toISOString()
  );
  mockProviders.embeddingChunkLimit.mockReturnValue(256);
  const callsBefore = mockProviders.embed.mock.calls.length;
  try {
    const lib = await library("a1", "模型长度限制验证", "private");
    const doc = await document("a1", lib.id, "模型上限文本", "x".repeat(290));
    documentId = doc.id;
    const chunks = await mockStore.all(
      'SELECT content FROM ep_chunks WHERE "documentId"=$1 ORDER BY position',
      doc.id
    );
    // Configured overlap (300) exceeds the model cap (256); successful ready
    // indexing proves the overlap was also clamped instead of rejected.
    expect(doc.status).toBe("ready");
    expect(chunks.length).toBeGreaterThan(24);
    const bodies = chunks.map(({ content }) =>
      content.replace(
        /^<document_metadata>[\s\S]*?<\/document_metadata>\s*/,
        ""
      )
    );
    expect(bodies.every((content) => content.length <= 256)).toBe(true);
    expect(bodies.some((content) => content.length === 256)).toBe(true);
    expect(mockProviders.embed.mock.calls.length - callsBefore).toBe(1);
    expect(mockProviders.embed.mock.calls.at(-1)[1]).toEqual(
      chunks.map(({ content }) => content)
    );
  } finally {
    mockProviders.embeddingChunkLimit.mockImplementation(previousLimit);
    if (documentId) await request("a1", `/documents/${documentId}`, "DELETE");
    await mockStore.run(
      'DELETE FROM ep_rag_settings WHERE "tenantId"=$1',
      ctx.a1.tenantId
    );
  }
});

test("resource grants authorize across storage origins without changing user tenancy", async () => {
  const shared = await library("a1", "grant independent", "public");
  const source = await document(
    "a1",
    shared.id,
    "grant source",
    "Grant source body"
  );
  expect((await request("b1", `/documents/${source.id}`)).status).toBe(404);
  await mockStore.orm.ep_library_grants.create({
    data: {
      id: mockStore.id(),
      libraryId: shared.id,
      tenantId: ctx.b1.tenantId,
    },
  });
  expect(
    (await request("b1", `/documents/${source.id}`)).body.document
  ).toMatchObject({
    tenantId: ctx.a1.tenantId,
    content: "Grant source body",
  });
  expect(
    (await request("b1", "/libraries")).body.libraries.map((row) => row.id)
  ).toContain(shared.id);
  const embedding = await mockProviders.resolveConnection(ctx.b1, "embedding");
  expect(
    (await rag.retrieve(ctx.b1, "Grant", embedding)).map(
      (row) => row.documentId
    )
  ).toContain(source.id);
  const edit = await request("b1", `/documents/${source.id}`, "PATCH", {
    title: "maintained together",
  });
  expect(edit.status).toBe(202);
  expect(
    (
      await request(
        "aa",
        `/knowledge-changes/${edit.body.change.id}/review`,
        "POST",
        { decision: "approve" }
      )
    ).status
  ).toBe(200);
  expect(
    (await mockStore.orm.users.findUnique({ where: { id: ctx.b1.userId } }))
      .tenantId
  ).toBe(ctx.b1.tenantId);
  await mockStore.orm.ep_library_grants.deleteMany({
    where: { libraryId: shared.id, tenantId: ctx.b1.tenantId },
  });
  expect((await request("b1", `/documents/${source.id}`)).status).toBe(404);
  expect(
    (await rag.retrieve(ctx.b1, "Grant", embedding)).map(
      (row) => row.documentId
    )
  ).not.toContain(source.id);
  const removal = await request("a1", `/documents/${source.id}`, "DELETE");
  expect(
    (
      await request(
        "aa",
        `/knowledge-changes/${removal.body.change.id}/review`,
        "POST",
        { decision: "approve" }
      )
    ).status
  ).toBe(200);
});

test("granted file writes and downloads use the resource storage origin", async () => {
  const shared = await library("a1", "granted files", "public");
  await mockStore.orm.ep_library_grants.create({
    data: {
      id: mockStore.id(),
      libraryId: shared.id,
      tenantId: ctx.b1.tenantId,
    },
  });
  const upload = await uploadFile(
    "b1",
    shared.id,
    "shared.txt",
    "shared original text"
  );
  expect(upload.status).toBe(202);
  expect(upload.body.approvalRequired).toBe(true);
  expect(
    (
      await request(
        "aa",
        `/knowledge-changes/${upload.body.change.id}/review`,
        "POST",
        { decision: "approve" }
      )
    ).status
  ).toBe(200);
  const source = (await request("b1", "/documents")).body.documents.find(
    (item) => item.title === "shared.txt"
  );
  expect(source.tenantId).toBe(ctx.a1.tenantId);
  const stored = await mockStore.orm.documents.findUnique({
    where: { id: source.id },
  });
  expect(stored.originalPath.replace(/\\/g, "/")).toContain(
    `/${ctx.a1.tenantId}/`
  );
  const download = await fetch(`${base}/documents/${source.id}/download`, {
    headers: { "x-test-user": "b1", host: `${ctx.b1.tenantId}.localhost` },
  });
  expect(download.status).toBe(200);
  expect(await download.text()).toBe("shared original text");
  await mockStore.orm.ep_library_grants.deleteMany({
    where: { libraryId: shared.id, tenantId: ctx.b1.tenantId },
  });
  expect((await request("b1", `/documents/${source.id}/download`)).status).toBe(
    404
  );
  const removal = await request("a1", `/documents/${source.id}`, "DELETE");
  expect(
    (
      await request(
        "aa",
        `/knowledge-changes/${removal.body.change.id}/review`,
        "POST",
        { decision: "approve" }
      )
    ).status
  ).toBe(200);
});

test("only the owner can rename a personal conversation", async () => {
  const created = await request("a1", "/conversations", "POST", {
    title: "original title",
  });
  const id = created.body.conversation.id;
  for (const user of ["a2", "aa", "b1"])
    expect(
      (
        await request(user, `/conversations/${id}`, "PATCH", {
          title: "stolen",
        })
      ).status
    ).toBe(404);
  expect(
    (await request("a1", `/conversations/${id}`, "PATCH", { title: "   " }))
      .status
  ).toBe(400);
  const renamed = await request("a1", `/conversations/${id}`, "PATCH", {
    title: "  reviewed title  ",
    tenantId: "tenant-b",
    userId: 4,
  });
  expect(renamed.status).toBe(200);
  expect(renamed.body.conversation).toMatchObject({
    id,
    title: "  reviewed title  ",
    tenantId: ctx.a1.tenantId,
    userId: ctx.a1.userId,
  });
  expect(
    (await request("a1", `/conversations/${id}`)).body.conversation.title
  ).toBe("  reviewed title  ");
});

test("private conversations, generated model inputs, streaming citations and deleted-source history remain scoped", async () => {
  await mockStore.run(
    'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3)',
    ctx.a1.tenantId,
    JSON.stringify({ topK: 20 }),
    new Date().toISOString()
  );
  try {
    const creation = await request("a1", "/conversations", "POST", {});
    const conv = creation.body.conversation;
    for (const user of ["a2", "aa", "b1"]) {
      expect((await request(user, `/conversations/${conv.id}`)).status).toBe(
        404
      );
      expect(
        (
          await request(user, `/conversations/${conv.id}/messages`, "POST", {
            message: "读取秘密",
          })
        ).status
      ).toBe(404);
    }
    const answer = await request(
      "a1",
      `/conversations/${conv.id}/messages`,
      "POST",
      { message: "联合检索有什么？" }
    );
    expect(answer.status).toBe(200);
    const modelInput = JSON.stringify(
      mockProviders.complete.mock.calls.at(-1)[1]
    );
    expect(modelInput).toContain("本人私有检索标记");
    expect(modelInput).toContain("[CONTEXT 0]");
    expect(modelInput).not.toContain("他人私有绝密");
    expect(modelInput).not.toContain("跨租户绝密");
    const removed = answer.body.message.sources[0];
    await request("a1", `/documents/${removed.documentId}`, "DELETE");
    const history = await request("a1", `/conversations/${conv.id}`);
    expect(
      history.body.messages
        .find((message) => message.role === "assistant")
        .sources.map((source) => source.id)
    ).toContain(removed.id);
    expect(
      (await request("a1", `/documents/${removed.documentId}`)).status
    ).toBe(404);
    const replay = await rag.modelHistory(ctx.a1, conv.id);
    expect(replay).toHaveLength(1);
    const response = await fetch(`${base}/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-user": "a1",
        host: "tenant-a.localhost",
      },
      body: JSON.stringify({ message: "还有什么？", stream: true }),
    });
    const events = await response.text();
    expect(events).toContain('"type":"textResponseChunk"');
    expect(events).toContain('"type":"finalizeResponseStream"');
    expect(
      (await request("a1", `/conversations/${conv.id}`, "DELETE")).status
    ).toBe(200);
    expect((await request("a1", `/conversations/${conv.id}`)).status).toBe(404);
  } finally {
    await mockStore.run(
      'DELETE FROM ep_rag_settings WHERE "tenantId"=$1',
      ctx.a1.tenantId
    );
  }
});

test("retrieval rejects an embedding dimension change before querying the vector database", async () => {
  mockProviders.embed.mockImplementationOnce(async () => [[1, 0]]);
  await expect(
    rag.retrieve(ctx.a1, "维度变更", { id: "embedding", version: 1 })
  ).rejects.toMatchObject({ status: 409 });
});

test("disabling a user while embedding prevents publication of the document", async () => {
  const lib = await library("a1", "停用中断入库", "private");
  mockProviders.embed.mockImplementationOnce(async (_connection, texts) => {
    await mockStore.run(
      "UPDATE users SET status = 'disabled' WHERE id = $1",
      1
    );
    return texts.map(() => [1, 0, 0]);
  });
  const result = await request("a1", "/documents", "POST", {
    libraryId: lib.id,
    title: "停用任务",
    content: "此资料不能在账号停用后发布。",
  });
  try {
    let stored;
    for (let attempt = 0; attempt < 100; attempt++) {
      stored = await mockStore.one(
        "SELECT * FROM ep_documents WHERE id = $1",
        result.body.document.id
      );
      if (stored.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(stored.status).toBe("failed");
    expect(stored.error).toContain("停用");
    expect(
      await mockStore.all(
        'SELECT id FROM ep_chunks WHERE "documentId" = $1',
        stored.id
      )
    ).toEqual([]);
  } finally {
    await mockStore.run("UPDATE users SET status = 'active' WHERE id = $1", 1);
  }
});

test("disabling a user while a model runs rejects the answer before persistence and streaming", async () => {
  const lib = await library("a1", "停用中断问答", "private");
  await document("a1", lib.id, "可用事实", "这是问答所需的业务事实。");
  const {
    body: { conversation },
  } = await request("a1", "/conversations", "POST", {});
  mockProviders.complete.mockImplementationOnce(async () => {
    await mockStore.run(
      "UPDATE users SET status = 'disabled' WHERE id = $1",
      1
    );
    return "不应发送的事实 [1]";
  });
  try {
    const result = await fetch(
      `${base}/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "a1" },
        body: JSON.stringify({ message: "业务事实是什么？", stream: true }),
      }
    );
    const events = await result.text();
    expect(result.status).toBe(200);
    expect(events).toContain('"type":"abort"');
    expect(events).not.toContain('"type":"textResponseChunk"');
    expect(events).not.toContain('"type":"finalizeResponseStream"');
    expect(
      await mockStore.all(
        "SELECT id FROM chats WHERE thread_id = $1",
        conversation.id
      )
    ).toEqual([]);
  } finally {
    await mockStore.run("UPDATE users SET status = 'active' WHERE id = $1", 1);
  }
});

test("ordinary text deltas arrive before completion, coalesce small tokens, and upstream failure is terminal", async () => {
  const lib = await library("a1", "真实流式验证", "private");
  await document("a1", lib.id, "流式依据", "企业规定每周五提交报告。");
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const first = new Promise((resolve) => {
    entered = resolve;
  });
  let completed = false;
  const all = jest.spyOn(mockStore, "all");
  const one = jest.spyOn(mockStore, "one");
  mockProviders.complete.mockImplementationOnce(
    async (_connection, _messages, onToken) => {
      await onToken("周");
      entered();
      await waiting;
      for (const token of "五提交。".repeat(15)) await onToken(token);
      completed = true;
      // A displayed prefix must not become a saved answer when the provider fails.
      throw new Error("模型流意外中断");
    }
  );
  const response = await fetch(
    `${base}/conversations/${conversation.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "a1" },
      body: JSON.stringify({ message: "何时提交？", stream: true }),
    }
  );
  const reader = response.body.getReader();
  try {
    await first;
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    expect(firstChunk).toContain('"type":"textResponseChunk"');
    expect(firstChunk).toContain("周");
    expect(completed).toBe(false);
    const before = all.mock.calls.length + one.mock.calls.length;
    release();
    let tail = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      tail += new TextDecoder().decode(next.value);
    }
    expect(tail).toContain('"type":"abort"');
    expect(tail).not.toContain('"type":"finalizeResponseStream"');
    // 60 tiny provider tokens do not each trigger a fresh DB authorization round.
    expect(all.mock.calls.length + one.mock.calls.length - before).toBeLessThan(
      20
    );
    expect(
      await mockStore.all(
        "SELECT id FROM chats WHERE thread_id=$1",
        conversation.id
      )
    ).toEqual([]);
  } finally {
    release();
    reader.releaseLock();
    all.mockRestore();
    one.mockRestore();
  }
});

test("disconnect aborts an active model and never stores its late answer", async () => {
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  let aborted;
  const canceled = new Promise((resolve) => {
    aborted = resolve;
  });
  mockProviders.complete.mockImplementationOnce(
    async (_connection, _messages, onToken, { signal }) => {
      await onToken("周五");
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true })
      );
      aborted();
      signal.throwIfAborted();
    }
  );
  const controller = new AbortController();
  const response = await fetch(
    `${base}/conversations/${conversation.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "a1" },
      signal: controller.signal,
      body: JSON.stringify({ message: "何时提交？", stream: true }),
    }
  );
  const reader = response.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    '"type":"textResponseChunk"'
  );
  controller.abort();
  await canceled;
  expect(
    await mockStore.all(
      "SELECT id FROM chats WHERE thread_id=$1",
      conversation.id
    )
  ).toEqual([]);
  await reader.cancel().catch(() => {});
  reader.releaseLock();
});

test("deleting a source after the first preview interrupts the next disclosure and leaves no saved answer", async () => {
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  const selected = (
    await rag.retrieve(ctx.a1, "流式依据", { id: "embedding", version: 1 })
  )[0];
  mockProviders.complete.mockImplementationOnce(
    async (_connection, _messages, onToken) => {
      await onToken("先展示部分");
      expect(
        (await request("a1", `/documents/${selected.documentId}`, "DELETE"))
          .status
      ).toBe(200);
      await onToken("不应展示的后续".repeat(20));
      return "完整事实 [1]";
    }
  );
  const response = await fetch(
    `${base}/conversations/${conversation.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": "a1" },
      body: JSON.stringify({ message: "流式依据", stream: true }),
    }
  );
  const events = await response.text();
  expect(events).toContain("先展示部分");
  expect(events).toContain('"type":"abort"');
  expect(events).not.toContain("不应展示的后续");
  expect(events).not.toContain('"type":"finalizeResponseStream"');
  expect(
    await mockStore.all(
      "SELECT id FROM chats WHERE thread_id=$1",
      conversation.id
    )
  ).toEqual([]);
});

test("ordinary Markdown and JSON examples remain model text, with sources supplied by the authorized context", async () => {
  for (const raw of [
    "### 规则\n周五提交 [1] 🌱",
    '示例：`{"answer":"业务字段"}`',
  ]) {
    const conversation = (await request("a1", "/conversations", "POST", {}))
      .body.conversation;
    mockProviders.complete.mockImplementationOnce(
      async (_connection, _messages, onToken) => {
        for (const character of raw) await onToken(character);
        return raw;
      }
    );
    const response = await fetch(
      `${base}/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "a1" },
        body: JSON.stringify({ message: "何时提交？", stream: true }),
      }
    );
    const events = await response.text();
    expect(events).toContain('"type":"finalizeResponseStream"');
    expect(events).not.toContain('"type":"abort"');
    const saved = await mockStore.one(
      "SELECT response::jsonb->>'text' AS content,response::jsonb->>'sources' AS sources FROM chats WHERE thread_id=$1",
      conversation.id
    );
    expect(saved.content).toBe(raw);
    const packed = mockProviders.complete.mock.calls.at(-1)[1];
    expect(packed[0].content).not.toContain("hasEvidence");
    const sources = JSON.parse(saved.sources);
    expect(sources.length).toBeGreaterThan(0);
    expect(await rag.currentSources(ctx.a1, sources)).toEqual(sources);
    expect(sources.map((source) => source.citationNumber)).toEqual(
      sources.map((_source, index) => index + 1)
    );
  }
});

test("deleting a source during generation rejects the entire answer", async () => {
  const {
    body: { conversation },
  } = await request("a1", "/conversations", "POST", {});
  mockProviders.complete.mockImplementationOnce(async () => {
    const first = (
      await rag.retrieve(ctx.a1, "业务事实", { id: "embedding", version: 1 })
    )[0];
    expect(
      (await request("a1", `/documents/${first.documentId}`, "DELETE")).status
    ).toBe(200);
    return "已删除资料的答案 [1]";
  });
  const result = await request(
    "a1",
    `/conversations/${conversation.id}/messages`,
    "POST",
    { message: "业务事实是什么？" }
  );
  expect(result.status).toBe(409);
  expect(
    await mockStore.all(
      "SELECT id FROM chats WHERE thread_id = $1",
      conversation.id
    )
  ).toEqual([]);
});

test("revoking a pinned document during generation blocks its disclosure and persistence", async () => {
  const lib = await library("a1", "Pinned authorization", "private");
  const doc = await document(
    "a1",
    lib.id,
    "Pinned original",
    "Pinned secret context"
  );
  await request("a1", `/documents/${doc.id}`, "PATCH", { pinned: true });
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  mockProviders.complete.mockImplementationOnce(async () => {
    await mockStore.orm.ep_library_grants.deleteMany({
      where: { libraryId: lib.id },
    });
    return "Pinned secret answer";
  });
  const response = await request(
    "a1",
    `/conversations/${conversation.id}/messages`,
    "POST",
    { message: "Explain pinned context" }
  );
  expect(response.status).toBe(409);
  expect(
    await mockStore.orm.chats.count({ where: { thread_id: conversation.id } })
  ).toBe(0);
});

test("an empty selected vector backend requests rebuilding while a similarity cutoff remains a normal empty result", async () => {
  const lib = await library("a1", "Empty backend detection", "private");
  await document("a1", lib.id, "Published source", "A published fact");
  const connection = { id: "embedding", version: 1 };
  const backend = { search: async () => [], fetch: async () => [] };
  const selection = jest
    .spyOn(vectorStore, "withDatabase")
    .mockImplementation(async (callback) => callback(backend));
  try {
    await expect(
      rag.retrieve(ctx.a1, "missing", connection)
    ).rejects.toMatchObject({ status: 409 });
    backend.fetch = async ({ ids }) => ids.map((id) => ({ id }));
    await expect(
      rag.retrieve(ctx.a1, "below cutoff", connection)
    ).resolves.toEqual([]);
  } finally {
    selection.mockRestore();
  }
});

async function historicalAnswerFixture(question = "历史问题") {
  const lib = await library("a1", "历史依赖并发验证", "private");
  const previous = await document("a1", lib.id, "旧引用 A", "旧资料事实 A。");
  const current = await document(
    "a1",
    lib.id,
    "当前引用 B",
    "本轮有效资料事实 B。"
  );
  const priorChunk = await mockStore.one(
    'SELECT id FROM ep_chunks WHERE "documentId"=$1',
    previous.id
  );
  const currentChunk = await mockStore.one(
    'SELECT id FROM ep_chunks WHERE "documentId"=$1',
    current.id
  );
  const conversation = (await request("a1", "/conversations", "POST", {})).body
    .conversation;
  await mockStore.run(
    'INSERT INTO chats("tenantId","userId",thread_id,prompt,response,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$5,$6,$6)',
    "tenant-a",
    ctx.a1.userId,
    conversation.id,
    question,
    JSON.stringify({
      text: "历史回答私密标记 A [1]",
      sources: [{ id: priorChunk.id }],
    }),
    new Date()
  );
  const search = jest
    .spyOn(vectorStore, "withDatabase")
    .mockImplementation(async (callback) =>
      callback({
        search: async () => [{ id: currentChunk.id, score: 1 }],
      })
    );
  return { previous, current, conversation, search };
}

test("replacing an old source keeps the saved personal answer usable while new evidence stays authorized", async () => {
  const { previous, current, conversation, search } =
    await historicalAnswerFixture();
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const calls = mockProviders.complete.mock.calls.length;
  mockProviders.embed.mockImplementationOnce(async () => {
    entered();
    await waiting;
    return [[1, 0, 0]];
  });
  try {
    const pending = request(
      "a1",
      `/conversations/${conversation.id}/messages`,
      "POST",
      { message: "本轮问题" }
    );
    await started;
    await mockStore.run(
      "UPDATE ep_documents SET version=version+1 WHERE id=$1",
      previous.id
    );
    release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body.message.content).toBeTruthy();
    expect(mockProviders.complete).toHaveBeenCalledTimes(calls + 1);
    expect(
      (
        await mockStore.one(
          "SELECT status FROM ep_documents WHERE id=$1",
          current.id
        )
      ).status
    ).toBe("ready");
    expect(
      await mockStore.all(
        "SELECT id FROM chats WHERE thread_id=$1",
        conversation.id
      )
    ).toHaveLength(2);
  } finally {
    release();
    search.mockRestore();
  }
});

test("deleting an old source preserves the saved snapshot and does not block an authorized new answer", async () => {
  const { previous, current, conversation, search } =
    await historicalAnswerFixture();
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  mockProviders.complete.mockImplementationOnce(
    async (_connection, inputs, onToken) => {
      expect(JSON.stringify(inputs)).toContain("历史回答私密标记 A");
      expect(
        inputs.every((message) => !Object.hasOwn(message, "sources"))
      ).toBe(true);
      entered();
      await waiting;
      const answer = "基于个人历史与有效新资料的回答 [1]";
      await onToken(answer);
      return answer;
    }
  );
  try {
    const response = await fetch(
      `${base}/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "a1" },
        body: JSON.stringify({ message: "本轮问题", stream: true }),
      }
    );
    await started;
    expect(
      (await request("a1", `/documents/${previous.id}`, "DELETE")).status
    ).toBe(200);
    release();
    const events = await response.text();
    expect(events).not.toContain('"type":"abort"');
    expect(events).toContain('"type":"textResponseChunk"');
    expect(events).toContain('"type":"finalizeResponseStream"');
    expect(events).toContain("基于个人历史与有效新资料的回答");
    expect(
      (
        await mockStore.one(
          "SELECT status FROM ep_documents WHERE id=$1",
          current.id
        )
      ).status
    ).toBe("ready");
    expect(
      await mockStore.all(
        "SELECT id FROM chats WHERE thread_id=$1",
        conversation.id
      )
    ).toHaveLength(2);
  } finally {
    release();
    search.mockRestore();
  }
});

test("saved historical snapshots remain valid when old sources change during answer persistence", async () => {
  const { previous, conversation, search } = await historicalAnswerFixture();
  const transaction = mockStore.transaction;
  let transactions = 0;
  const intercepted = jest
    .spyOn(mockStore, "transaction")
    .mockImplementation(async (fn) => {
      if (++transactions === 1)
        await mockStore.run(
          "UPDATE ep_documents SET version=version+1 WHERE id=$1",
          previous.id
        );
      return transaction(fn);
    });
  try {
    const response = await request(
      "a1",
      `/conversations/${conversation.id}/messages`,
      "POST",
      { message: "本轮问题" }
    );
    expect(response.status).toBe(200);
    expect(response.body.message.content).toBeTruthy();
    expect(
      await mockStore.all(
        "SELECT id FROM chats WHERE thread_id=$1",
        conversation.id
      )
    ).toHaveLength(2);
  } finally {
    intercepted.mockRestore();
    search.mockRestore();
  }
});

test("compressed personal history remains usable after its historical source changes", async () => {
  const window = jest
    .spyOn(mockProviders, "contextWindow")
    .mockReturnValue(5000);
  const { previous, conversation, search } = await historicalAnswerFixture(
    Array.from({ length: 1000 }, (_, index) => `历史问题${index} `).join("")
  );
  mockProviders.embed.mockImplementationOnce(async () => {
    await mockStore.run(
      "UPDATE ep_documents SET version=version+1 WHERE id=$1",
      previous.id
    );
    return [[1, 0, 0]];
  });
  try {
    const response = await request(
      "a1",
      `/conversations/${conversation.id}/messages`,
      "POST",
      { message: "本轮问题" }
    );
    expect(response.status).toBe(200);
    expect(response.body.message.content).toBeTruthy();
    expect(
      await mockStore.all(
        "SELECT id FROM chats WHERE thread_id=$1",
        conversation.id
      )
    ).toHaveLength(2);
  } finally {
    search.mockRestore();
    window.mockRestore();
  }
});

test.each(["resolve", "reject"])(
  "canceling a deferred vector search releases the conversation while its database read remains pending until %s",
  async (outcome) => {
    const { current, conversation, search } = await historicalAnswerFixture();
    search.mockRestore();
    const currentChunk = await mockStore.one(
      'SELECT id FROM ep_chunks WHERE "documentId"=$1',
      current.id
    );
    await mockStore.run(
      'UPDATE ep_chunks SET namespace=$1 WHERE "documentId"=$2',
      "second-cancellation-namespace",
      current.id
    );
    const withDatabase = vectorStore.withDatabase;
    let entered, resolveSearch, rejectSearch, finished;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const pending = new Promise((resolve, reject) => {
      resolveSearch = resolve;
      rejectSearch = reject;
    });
    const settled = new Promise((resolve) => {
      finished = resolve;
    });
    let searches = 0,
      databaseReadPending = false;
    const deferred = jest
      .spyOn(vectorStore, "withDatabase")
      .mockImplementation((callback) =>
        withDatabase(async (backend, value) => {
          let ownsPendingSearch = false;
          try {
            return await callback(
              {
                ...backend,
                search: async () => {
                  if (++searches === 1) {
                    ownsPendingSearch = true;
                    databaseReadPending = true;
                    entered();
                    return pending;
                  }
                  return [{ id: currentChunk.id, score: 1 }];
                },
              },
              value
            );
          } finally {
            if (ownsPendingSearch) {
              databaseReadPending = false;
              finished();
            }
          }
        })
      );
    const controller = new AbortController();
    try {
      const first = fetch(`${base}/conversations/${conversation.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "a1" },
        signal: controller.signal,
        body: JSON.stringify({ message: "会被取消的问题", stream: true }),
      })
        .then((response) => response.text())
        .catch((error) => error);
      await started;
      controller.abort();
      expect((await first).name).toBe("AbortError");
      expect(databaseReadPending).toBe(true);
      let retry;
      for (let attempt = 0; attempt < 50; attempt++) {
        retry = await request(
          "a1",
          `/conversations/${conversation.id}/messages`,
          "POST",
          { message: "取消后再次提问" }
        );
        if (retry.status !== 409) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(retry.status).toBe(200);
      expect(databaseReadPending).toBe(true);
      expect(
        await mockStore.all(
          "SELECT prompt AS content FROM chats WHERE thread_id=$1 AND prompt=$2",
          conversation.id,
          "会被取消的问题"
        )
      ).toEqual([]);
      // A late network error belongs to the still-running read, not to a new
      // answer; Promise.race must consume it after the caller has stopped waiting.
      const startedSearches = searches;
      if (outcome === "reject")
        rejectSearch(new Error("late vector search failure"));
      else resolveSearch([]);
      await settled;
      expect(searches).toBe(startedSearches);
      expect(
        await mockStore.all(
          "SELECT id FROM chats WHERE thread_id=$1",
          conversation.id
        )
      ).toHaveLength(2);
      expect(searches).toBeGreaterThanOrEqual(2);
    } finally {
      controller.abort();
      rejectSearch(new Error("fixture cleanup"));
      await settled;
      deferred.mockRestore();
    }
  }
);

test("historical citation numbers remain stable after an earlier source is deleted, including legacy sources", async () => {
  const lib = await library("a1", "历史编号", "private");
  const first = await document("a1", lib.id, "来源一", "第一个编号来源。");
  const second = await document("a1", lib.id, "来源二", "第二个编号来源。");
  const firstChunk = await mockStore.one(
    'SELECT id FROM ep_chunks WHERE "documentId" = $1',
    first.id
  );
  const secondChunk = await mockStore.one(
    'SELECT id FROM ep_chunks WHERE "documentId" = $1',
    second.id
  );
  const candidates = [{ id: firstChunk.id }, { id: secondChunk.id }];
  await request("a1", `/documents/${first.id}`, "DELETE");
  expect(await rag.currentSources(ctx.a1, candidates)).toEqual([
    expect.objectContaining({ id: secondChunk.id, citationNumber: 2 }),
  ]);
  expect(
    await rag.currentSources(ctx.a1, [{ ...candidates[1], citationNumber: 5 }])
  ).toEqual([
    expect.objectContaining({ id: secondChunk.id, citationNumber: 5 }),
  ]);
});

test("recovered public jobs retain the actual editor identity instead of the library creator", async () => {
  const lib = await library("a1", "恢复操作人", "public");
  const doc = await document(
    "a2",
    lib.id,
    "待恢复任务",
    "由另一位同事上传的资料。"
  );
  await mockStore.run(
    "UPDATE ep_documents SET status = 'processing', version = version + 1, \"updatedBy\"='2' WHERE id = $1",
    doc.id
  );
  await mockStore.run("UPDATE users SET status = 'disabled' WHERE id = $1", 2);
  try {
    await knowledge.recoverJobs();
    let recovered;
    for (let attempt = 0; attempt < 100; attempt++) {
      recovered = await mockStore.one(
        "SELECT status,error FROM ep_documents WHERE id = $1",
        doc.id
      );
      if (recovered.status !== "processing") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(recovered.status).toBe("failed");
    expect(recovered.error).toContain("停用");
  } finally {
    await mockStore.run("UPDATE users SET status = 'active' WHERE id = $1", 2);
  }
});

test.each(
  ["disabled", "credentials-reset"].flatMap((revocation) =>
    [
      "library-create",
      "text-create",
      "file-create",
      "document-edit",
      "file-replace",
      "index-retry",
      "document-delete",
      "conversation-create",
      "conversation-delete",
    ].map((operation) => [revocation, operation])
  )
)("a queued %s session cannot commit %s", async (revocation, operation) => {
  const lib = await library("a2", "排队写入权限", "private");
  const doc = await document("a2", lib.id, "原资料", "原始正文必须保留。");
  const conversation = (await request("a2", "/conversations", "POST", {})).body
    .conversation;
  const tables = [
    "ep_libraries",
    "ep_documents",
    "ep_chunks",
    "chat_threads",
    "chats",
    "ep_file_cleanup",
    "ep_vector_cleanup",
  ];
  const snapshot = async () =>
    Promise.all(
      tables.map((table) =>
        mockStore.all(
          `SELECT * FROM ${table} ORDER BY ${table === "ep_file_cleanup" ? "path" : "id"}`
        )
      )
    );
  const before = await snapshot();
  const account = await mockStore.one("SELECT * FROM users WHERE id=2");
  ctx.a2.authVersion = account.authVersion;
  const transact = mockStore.transaction;
  const hook = jest
    .spyOn(mockStore, "transaction")
    .mockImplementationOnce(async (fn) => {
      // Simulate revocation after the request passed authentication, while it
      // waits for a file/vector writer. The real transaction must check
      // the current identity before changing any business rows.
      if (revocation === "disabled")
        await mockStore.run("UPDATE users SET status='disabled' WHERE id=2");
      else
        await mockStore.run(
          'UPDATE users SET "authVersion"="authVersion"+1 WHERE id=2'
        );
      return transact(fn);
    });
  try {
    let result;
    if (operation === "file-create" || operation === "file-replace") {
      const form = new FormData();
      form.append("libraryId", lib.id);
      form.append(
        "file",
        new Blob(["替换内容"], { type: "text/plain" }),
        "queued.txt"
      );
      const response = await fetch(
        `${base}${operation === "file-create" ? "/documents/upload" : `/documents/${doc.id}/replace`}`,
        { method: "POST", headers: { "x-test-user": "a2" }, body: form }
      );
      result = { status: response.status, body: await response.json() };
    } else {
      const routes = {
        "library-create": [
          "/libraries",
          "POST",
          { name: "不应创建", visibility: "private" },
        ],
        "text-create": [
          "/documents",
          "POST",
          { libraryId: lib.id, title: "不应创建", content: "不应写入" },
        ],
        "document-edit": [
          `/documents/${doc.id}`,
          "PATCH",
          { title: "不应改名", content: "不应更新" },
        ],
        "index-retry": [`/documents/${doc.id}/retry`, "POST", {}],
        "document-delete": [`/documents/${doc.id}`, "DELETE"],
        "conversation-create": [
          "/conversations",
          "POST",
          { title: "不应创建" },
        ],
        "conversation-delete": [`/conversations/${conversation.id}`, "DELETE"],
      };
      result = await request("a2", ...routes[operation]);
    }
    expect(result.status).toBe(401);
    expect(await snapshot()).toEqual(before);
  } finally {
    hook.mockRestore();
    delete ctx.a2.authVersion;
    await mockStore.run(
      'UPDATE users SET status=$1,"authVersion"=$2 WHERE id=2',
      account.status,
      account.authVersion
    );
  }
});
