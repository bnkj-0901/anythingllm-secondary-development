const express = require("express");
const { createPostgresFixture } = require("./postgres-fixture.cjs");

let mockFixture, mockDb;
const mockStore = {
  get orm() {
    return mockDb.orm;
  },
  all: (...args) => mockDb.all(...args),
  one: (...args) => mockDb.one(...args),
  run: (...args) => mockDb.run(...args),
  transaction: (...args) => mockDb.transaction(...args),
};
const mockAgent = {
  result: null,
  outputs: [],
  onStart: null,
  aborted: jest.fn(),
  constructed: [],
};
const mockCacheInvocation = jest.fn();
const mockProviders = {
  connectionIdentity: () => "embedding:1",
  resolveConnection: jest.fn(async (_ctx, kind) => ({
    id: kind,
    config: { model: "gpt-4o" },
  })),
  embed: async () => [[1, 0]],
  compress: jest.fn(async (_connection, args, history) => [
    { role: "system", content: args.systemPrompt },
    ...history.flatMap((row) => [
      { role: "user", content: row.prompt },
      { role: "assistant", content: JSON.parse(row.response).text },
    ]),
    { role: "user", content: args.userPrompt },
  ]),
  complete: jest.fn(async () => "Ordinary answer"),
};
jest.mock("../../enterprise/store", () => mockStore);
jest.mock(
  "../../utils/prisma",
  () =>
    new Proxy(
      {},
      {
        get: (_target, key) => mockDb.orm[key],
      }
    )
);
jest.mock("../../enterprise/providers", () => mockProviders);
jest.mock("../../enterprise/auth", () => ({
  ...jest.requireActual("../../enterprise/auth"),
  requireAuth: (_req, _res, next) => next(),
  requirePlatformAuth: (req, _res, next) =>
    req.ep.identity === "platform"
      ? next()
      : next(Object.assign(new Error("platform only"), { status: 403 })),
}));
jest.mock("../../enterprise/rag-settings", () => ({
  ...jest.requireActual("../../enterprise/rag-settings"),
  getSettings: async () => ({
    ...jest.requireActual("../../enterprise/rag-settings").DEFAULTS,
  }),
}));
jest.mock("../../enterprise/settings", () => ({
  defaultPrompt: async () => "System prompt",
}));
jest.mock("../../enterprise/vector-store", () => ({
  withDatabase: async (action) =>
    action({ search: async () => [], fetch: async () => [{ id: "chunk-a" }] }),
}));
jest.mock("../../utils/chats", () => ({
  grepCommand: async (message) => message,
  VALID_COMMANDS: {
    "/output": async () => ({
      textResponse: "Generated output",
      outputs: [{ type: "image", name: "image.png" }],
    }),
    "/failure": async () => ({ error: "Tool failed" }),
  },
  recentChatHistory: async () => ({ rawHistory: [] }),
  chatPrompt: async ({ openAiPrompt }) => openAiPrompt,
}));
jest.mock("../../enterprise/execution-context", () => ({
  runExecution: async (_ctx, action) => action(),
}));
jest.mock("../../utils/chats/attachments", () => ({
  processDocumentAttachments: async (attachments) => ({
    parsedDocuments: [],
    imageAttachments: attachments,
  }),
}));
jest.mock("../../endpoints/agentFileServer", () => ({
  validateGeneratedImageAccess: async () => {},
}));
jest.mock("../../endpoints/utils", () => ({ registerChatExport: () => {} }));
jest.mock("../../utils/helpers/reasoningEffort", () => ({
  getReasoningCapabilities: async () => ({ supported: false }),
}));
jest.mock("../../utils/chats/agents", () => ({
  cacheInvocationOptions: (...args) => mockCacheInvocation(...args),
}));
jest.mock("../../utils/agents", () => ({
  AgentHandler: {
    isAgentInvocation: async ({ message }) => message.startsWith("@agent"),
  },
}));
jest.mock("../../utils/agents/ephemeral", () => ({
  EphemeralEventListener: class {
    waitForClose() {
      return new Promise((resolve) => {
        this.resolve = resolve;
      });
    }
    close() {
      this.resolve(mockAgent.result);
    }
  },
  EphemeralAgentHandler: class {
    constructor(options) {
      mockAgent.constructed.push(options);
      this.aibitat = { abort: mockAgent.aborted };
    }
    async init() {
      return this;
    }
    async createAIbitat({ handler, onToolApproval }) {
      this.handler = handler;
      this.onToolApproval = onToolApproval;
    }
    async startAgentCluster() {
      await mockAgent.onStart?.(this);
      this.handler.close();
    }
    getPendingOutputs() {
      return mockAgent.outputs;
    }
  },
}));

const rag = require("../../enterprise/rag");
const { ChatThread } = require("../../models/workspaceThread");
const {
  WorkspaceAgentInvocation,
} = require("../../models/workspaceAgentInvocation");
const user = { identity: "tenant", tenantId: "tenant-a", userId: 1 };
let listener, base;

beforeAll(async () => {
  mockFixture = await createPostgresFixture();
  mockDb = mockFixture.db;
  const stamp = new Date().toISOString();
  await mockDb.orm.ep_platform_accounts.create({
    data: {
      id: "rag-execution-platform",
      username: "platform",
      name: "Platform",
      passwordHash: "unused",
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  for (const id of ["tenant-a", "tenant-b"]) {
    await mockDb.orm.ep_tenants.create({
      data: {
        id,
        code: id,
        name: id,
        hostname: `${id}.localhost`,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  }
  for (const [id, tenantId] of [
    [1, "tenant-a"],
    [2, "tenant-a"],
    [3, "tenant-b"],
  ]) {
    await mockDb.orm.users.create({
      data: {
        id,
        tenantId,
        username: `user-${id}`,
        name: `User ${id}`,
        passwordHash: "unused",
      },
    });
  }
  for (const [id, tenantId, userId] of [
    ["library-a", "tenant-a", 1],
    ["library-b", "tenant-b", 3],
    ["published", "tenant-a", null],
  ]) {
    await mockDb.orm.ep_libraries.create({
      data: {
        id,
        tenantId,
        name: id,
        createdBy: String(userId || 1),
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
    await mockDb.orm.ep_library_grants.create({
      data: {
        id: `grant-${id}`,
        libraryId: id,
        ...(userId ? { userId } : { tenantId }),
      },
    });
  }
  for (const suffix of ["a", "b"]) {
    await mockDb.orm.documents.create({
      data: {
        id: `document-${suffix}`,
        tenantId: `tenant-${suffix}`,
        libraryId: `library-${suffix}`,
        title: `Document ${suffix}`,
        inputType: "text",
        content: `Private text ${suffix}`,
        status: "ready",
        embeddingId: "embedding:1",
        createdBy: suffix === "a" ? "1" : "3",
        updatedBy: "1",
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
    await mockDb.orm.document_vectors.create({
      data: {
        id: `chunk-${suffix}`,
        tenantId: `tenant-${suffix}`,
        documentId: `document-${suffix}`,
        version: 1,
        position: 0,
        content: `Private text ${suffix}`,
        embeddingId: "embedding:1",
        dimensions: 2,
        namespace: `space-${suffix}`,
      },
    });
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.ep =
      req.headers["x-test-platform"] === "true"
        ? { identity: "platform", userId: "rag-execution-platform" }
        : user;
    next();
  });
  rag.registerRag(app);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});

beforeEach(() => {
  mockAgent.result = {
    textResponse: "Agent answer",
    citations: [
      { id: "chunk-a", documentId: "document-a" },
      { title: "Web result", url: "https://example.test" },
    ],
    metrics: { output_tokens: 4 },
  };
  mockAgent.outputs = [{ type: "file", name: "report.txt" }];
  mockAgent.onStart = null;
  mockAgent.constructed.length = 0;
  mockAgent.aborted.mockClear();
  mockProviders.complete.mockReset().mockResolvedValue("Ordinary answer");
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  listener?.closeAllConnections();
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
});

async function thread() {
  return (await ChatThread.new(user, {}, mockDb.orm)).thread;
}

test("HTTP Agent saves authorized citations, generated outputs and metrics as an original personal pair", async () => {
  const conversation = await thread();
  const events = [];
  const result = await rag.executeChat({
    ctx: user,
    threadId: conversation.id,
    prompt: "@agent make a report",
    onEvent: (event) => events.push(event),
  });
  expect(result.message).toMatchObject({
    role: "assistant",
    content: "Agent answer",
    metrics: { output_tokens: 4 },
    outputs: mockAgent.outputs,
  });
  expect(events.map((event) => event.type)).toEqual([
    "textResponseChunk",
    "finalizeResponseStream",
  ]);
  expect(result.sources).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "chunk-a" }),
      expect.objectContaining({ title: "Web result" }),
    ])
  );
  const saved = await mockDb.orm.chats.findMany({
    where: { thread_id: conversation.id },
  });
  expect(saved).toHaveLength(1);
  expect(JSON.parse(saved[0].response)).toMatchObject({
    outputs: mockAgent.outputs,
    metrics: { output_tokens: 4 },
  });
});

test("unpersisted Agent execution keeps tool output but never creates a personal pair", async () => {
  const before = await mockDb.orm.chats.count();
  delete mockAgent.result.metrics;
  delete mockAgent.result.citations;
  const result = await rag.executeChat({
    ctx: user,
    persist: false,
    prompt: "@agent draft",
  });
  expect(result).toMatchObject({
    metrics: {},
    sources: [],
    outputs: mockAgent.outputs,
  });
  expect(await mockDb.orm.chats.count()).toBe(before);
});

test.each(["cross-tenant", "revoked"])(
  "Agent %s source cannot be disclosed or persisted",
  async (scenario) => {
    const conversation = await thread();
    if (scenario === "cross-tenant")
      mockAgent.result.citations = [
        { id: "chunk-b", documentId: "document-b" },
      ];
    else
      mockAgent.onStart = async () =>
        mockDb.orm.ep_library_grants.deleteMany({
          where: { libraryId: "library-a" },
        });
    const events = [];
    try {
      await expect(
        rag.executeChat({
          ctx: user,
          threadId: conversation.id,
          prompt: "@agent source",
          onEvent: (event) => events.push(event),
        })
      ).rejects.toMatchObject({ status: 409 });
      expect(events).toEqual([]);
      expect(
        await mockDb.orm.chats.count({ where: { thread_id: conversation.id } })
      ).toBe(0);
    } finally {
      if (scenario === "revoked")
        await mockDb.orm.ep_library_grants.create({
          data: { id: "grant-library-a", libraryId: "library-a", userId: 1 },
        });
    }
  }
);

test("Agent empty replies and cancellation release the personal generation lock", async () => {
  const conversation = await thread();
  mockAgent.result.textResponse = "";
  await expect(
    rag.executeChat({
      ctx: user,
      threadId: conversation.id,
      prompt: "@agent empty",
    })
  ).rejects.toMatchObject({ status: 502 });
  const controller = new AbortController();
  mockAgent.onStart = async () => controller.abort(new Error("User canceled"));
  await expect(
    rag.executeChat({
      ctx: user,
      threadId: conversation.id,
      prompt: "@agent canceled",
      signal: controller.signal,
    })
  ).rejects.toThrow("User canceled");
  expect(mockAgent.aborted).toHaveBeenCalledTimes(1);
  mockAgent.onStart = null;
  mockAgent.result.textResponse = "Recovered";
  expect(
    (
      await rag.executeChat({
        ctx: user,
        threadId: conversation.id,
        prompt: "@agent retry",
      })
    ).textResponse
  ).toBe("Recovered");
});

test("websocket Agent reserves the current user's invocation and passes attachment options", async () => {
  const conversation = await thread();
  const events = [];
  const attachments = [{ name: "diagram.png", mime: "image/png" }];
  const result = await rag.executeChat({
    ctx: user,
    threadId: conversation.id,
    prompt: "@agent draw",
    agentTransport: "websocket",
    reasoningEffort: "high",
    attachments,
    onEvent: (event) => events.push(event),
  });
  const invocation = await mockDb.orm.workspace_agent_invocations.findUnique({
    where: { uuid: result.websocketUUID },
  });
  expect(invocation).toMatchObject({
    tenantId: user.tenantId,
    user_id: user.userId,
    thread_id: conversation.id,
  });
  expect(mockCacheInvocation).toHaveBeenCalledWith(invocation.uuid, {
    attachments,
    reasoningEffort: "high",
  });
  expect(events[0]).toMatchObject({
    type: "agentInitWebsocketConnection",
    websocketUUID: invocation.uuid,
  });
  expect(
    await mockDb.orm.chats.count({ where: { thread_id: conversation.id } })
  ).toBe(0);
  jest
    .spyOn(WorkspaceAgentInvocation, "new")
    .mockResolvedValue({ invocation: null });
  await expect(
    rag.executeChat({
      ctx: user,
      threadId: conversation.id,
      prompt: "@agent fail",
      agentTransport: "websocket",
    })
  ).rejects.toMatchObject({ status: 500 });
});

test("published chat skips private pinned documents and refuses revocation during model execution", async () => {
  await mockDb.orm.documents.update({
    where: { id: "document-a" },
    data: { pinned: true },
  });
  const before = await mockDb.orm.chats.count();
  try {
    const result = await rag.executePublishedChat({
      tenantId: "tenant-a",
      libraryId: "published",
      prompt: "Public question",
      history: [
        { prompt: "Prior", response: JSON.stringify({ text: "Earlier" }) },
      ],
    });
    expect(result.sources).toEqual([]);
    expect(await mockDb.orm.chats.count()).toBe(before);
    mockProviders.complete.mockImplementationOnce(async () => {
      await mockDb.orm.ep_library_grants.deleteMany({
        where: { libraryId: "published" },
      });
      return "Late unpublished answer";
    });
    await expect(
      rag.executePublishedChat({
        tenantId: "tenant-a",
        libraryId: "published",
        prompt: "Revoke",
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      rag.executePublishedChat({
        tenantId: "tenant-a",
        libraryId: "library-a",
        prompt: "Private library",
      })
    ).rejects.toMatchObject({ status: 403 });
  } finally {
    await mockDb.orm.documents.update({
      where: { id: "document-a" },
      data: { pinned: false },
    });
    await mockDb.orm.ep_library_grants.create({
      data: {
        id: "grant-published",
        libraryId: "published",
        tenantId: "tenant-a",
      },
    });
  }
});

test("unpersisted personal generation checks pinned document versions before exposing model text", async () => {
  await mockDb.orm.documents.update({
    where: { id: "document-a" },
    data: { pinned: true },
  });
  mockProviders.complete.mockImplementationOnce(async () => {
    await mockDb.orm.documents.update({
      where: { id: "document-a" },
      data: { version: 2 },
    });
    return "Answer from revoked version";
  });
  try {
    await expect(
      rag.executeChat({ ctx: user, persist: false, prompt: "Pinned question" })
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    await mockDb.orm.documents.update({
      where: { id: "document-a" },
      data: { pinned: false, version: 1 },
    });
  }
});

test("original command outputs are saved while failed commands leave no partial pair", async () => {
  const conversation = await thread();
  const events = [];
  const result = await rag.executeChat({
    ctx: user,
    threadId: conversation.id,
    prompt: "/output",
    onEvent: (event) => events.push(event),
  });
  expect(result.message).toMatchObject({
    content: "Generated output",
    outputs: [{ type: "image", name: "image.png" }],
  });
  expect(events[0]).toMatchObject({
    type: "finalizeResponseStream",
    chatId: result.message.id,
  });
  await expect(
    rag.executeChat({
      ctx: user,
      threadId: conversation.id,
      prompt: "/failure",
    })
  ).rejects.toMatchObject({ status: 502 });
  expect(
    await mockDb.orm.chats.count({ where: { thread_id: conversation.id } })
  ).toBe(1);
});

test("capabilities and legacy source decoding keep valid shapes without accepting malformed JSON", async () => {
  const response = await fetch(`${base}/chat/capabilities`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ supported: false });
  for (const raw of ["{broken", "{}", null, 2])
    expect(rag.parseSources(raw)).toEqual([]);
  const sources = [{ id: "chunk-a" }];
  expect(rag.parseSources(sources)).toBe(sources);
  expect(rag.parseSources(JSON.stringify(sources))).toEqual(sources);
  expect(await rag.currentSources(user, [{ id: 9 }])).toEqual([]);
});

test("top administrator missing numeric records and malformed identifiers return 404 without changing real personal content", async () => {
  const conversation = await thread();
  for (const id of ["999999999", "-1", "0", "NaN", "1.5", "9007199254740992"]) {
    for (const [url, method, body] of [
      [`/platform/conversations/${id}`, "GET"],
      [`/platform/conversations/${id}`, "PATCH", { title: "Missing" }],
      [`/platform/conversations/${id}`, "DELETE"],
      [`/platform/conversations/${id}/reset-history`, "POST", {}],
      [
        `/platform/messages/${id}`,
        "PATCH",
        { role: "assistant", content: "Missing" },
      ],
      [`/platform/messages/${id}`, "DELETE"],
    ]) {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-test-platform": "true",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(response.status).toBe(404);
    }
  }
  const denied = await fetch(
    `${base}/platform/conversations/${conversation.id}`
  );
  expect(denied.status).toBe(403);
  const personal = await fetch(`${base}/conversations`);
  expect((await personal.json()).conversations.map((row) => row.id)).toContain(
    conversation.id
  );
  expect(
    await mockDb.orm.chat_threads.findUnique({ where: { id: conversation.id } })
  ).not.toBeNull();
});
