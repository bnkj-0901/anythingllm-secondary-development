/* eslint-env jest */
jest.mock("../../../models/workspaceChats", () => ({
  chatScope: jest.requireActual("../../../models/workspaceChats").chatScope,
  Chat: { where: jest.fn() },
}));
jest.mock("../../../models/workspaceThread", () => ({
  ChatThread: { where: jest.fn() },
}));
jest.mock("../../../models/embedChats", () => ({
  EmbedChats: { whereWithEmbedAndLibrary: jest.fn() },
}));
jest.mock("../../../enterprise/rag-settings", () => ({
  getSettings: jest.fn(),
}));
jest.mock("../../../enterprise/settings", () => ({
  defaultPrompt: jest.fn(),
}));

const {
  prepareChatsForExport,
  exportChatsAsType,
} = require("../../../utils/helpers/chat/convertTo");
const { Chat } = require("../../../models/workspaceChats");
const { ChatThread } = require("../../../models/workspaceThread");
const { EmbedChats } = require("../../../models/embedChats");
const { getSettings } = require("../../../enterprise/rag-settings");
const { defaultPrompt } = require("../../../enterprise/settings");

const ctx = {
  identity: "tenant",
  tenantId: "tenant-a",
  userId: "alice",
  user: { username: "alice" },
};
const thread = { id: "thread-a", name: "Personal conversation" };
const attachments = [
  { mime: "image/png", contentString: "data:image/png;base64,cG5n" },
  { mime: "image/jpeg", contentString: "anBlZw==" },
];
function chat(overrides = {}) {
  return {
    id: "chat-a",
    thread_id: thread.id,
    prompt: "Test prompt",
    response: JSON.stringify({
      text: "Test response",
      sources: [],
      attachments,
    }),
    createdAt: "2026-10-23T00:00:00.000Z",
    feedbackScore: true,
    api_session_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  ChatThread.where.mockResolvedValue([thread]);
  Chat.where.mockResolvedValue([chat()]);
  EmbedChats.whereWithEmbedAndLibrary.mockResolvedValue([]);
  getSettings.mockResolvedValue({ openAiPrompt: "Tenant prompt" });
  defaultPrompt.mockResolvedValue("Default prompt");
});

test("rejects invalid formats and retired Workspace export calls", async () => {
  await expect(
    prepareChatsForExport("invalid", "personal", ctx)
  ).rejects.toThrow("Invalid export type: invalid");
  await expect(prepareChatsForExport("json", "workspace", ctx)).rejects.toThrow(
    "Invalid chat type: workspace"
  );
});

test.each([
  undefined,
  {},
  { ...ctx, userId: "" },
  { ...ctx, identity: "platform" },
])(
  "personal export requires an authenticated tenant user: %p",
  async (identity) => {
    await expect(
      prepareChatsForExport("json", "personal", identity)
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(Chat.where).not.toHaveBeenCalled();
  }
);

test("uses authorized thread IDs and preserves the legacy JSON field structure", async () => {
  const [result] = await prepareChatsForExport("json", "personal", ctx);
  expect(ChatThread.where).toHaveBeenCalledWith(ctx, {});
  expect(Chat.where).toHaveBeenCalledWith(
    ctx,
    { thread_id: { in: [thread.id] } },
    { orderBy: { sequence: "asc" } }
  );
  expect(result).toEqual({
    id: "chat-a",
    workspace: thread.name,
    username: "alice",
    prompt: "Test prompt",
    response: "Test response",
    sent_at: "2026-10-23T00:00:00.000Z",
    rating: "GOOD",
    attachments: [
      { type: "image", image: attachments[0].contentString },
      { type: "image", image: "data:image/jpeg;base64,anBlZw==" },
    ],
  });
});

test("a single-conversation export authorizes the requested thread before loading chats", async () => {
  await prepareChatsForExport("json", "personal", ctx, { threadId: thread.id });
  expect(ChatThread.where).toHaveBeenCalledWith(ctx, { id: thread.id });
  ChatThread.where.mockResolvedValue([]);
  Chat.where.mockClear();
  await expect(
    prepareChatsForExport("json", "personal", ctx, {
      threadId: "another-user-thread",
    })
  ).rejects.toMatchObject({ status: 404 });
  expect(Chat.where).not.toHaveBeenCalled();
});

test("CSV omits attachments and escapes spreadsheet formulas, quotes, commas and newlines", async () => {
  Chat.where.mockResolvedValue([
    chat({ prompt: '=SUM(1,2)\n"quoted"', feedbackScore: false }),
  ]);
  const { contentType, data } = await exportChatsAsType("csv", "personal", ctx);
  expect(contentType).toBe("text/csv");
  expect(data).toContain('"\'=SUM(1,2) ""quoted"""');
  expect(data).toContain('"BAD"');
  expect(data).not.toContain("attachments");
  expect(data.split("\n")).toHaveLength(2);
});

test.each([
  [null, "--"],
  [false, "BAD"],
  [true, "GOOD"],
])("preserves rating %p as %s", async (feedbackScore, rating) => {
  Chat.where.mockResolvedValue([chat({ feedbackScore })]);
  expect((await prepareChatsForExport("json", "personal", ctx))[0].rating).toBe(
    rating
  );
});

test("keeps reset history but excludes reserved, incomplete and malformed answers", async () => {
  Chat.where.mockResolvedValue([
    chat({ include: false }),
    chat({ id: "reserved", response: "{}" }),
    chat({ id: "empty", response: JSON.stringify({ text: " " }) }),
    chat({ id: "invalid", response: "invalid" }),
    chat({ id: "no-prompt", prompt: " " }),
  ]);
  expect(await prepareChatsForExport("json", "personal", ctx)).toHaveLength(1);
});

test("JSONL retains content blocks, attachment data URLs, chronology and conversation separation", async () => {
  ChatThread.where.mockResolvedValue([
    thread,
    { id: "thread-b", name: "Second" },
  ]);
  Chat.where.mockResolvedValue([
    chat(),
    chat({ id: "chat-b", prompt: "Follow up" }),
    chat({ id: "chat-c", thread_id: "thread-b", prompt: "Other topic" }),
  ]);
  const { contentType, data } = await exportChatsAsType(
    "jsonl",
    "personal",
    ctx
  );
  expect(contentType).toBe("application/jsonl");
  const [first, second] = data.split("\n").map(JSON.parse);
  expect(first.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(first.messages[0].content).toEqual([
    { type: "text", text: "Tenant prompt" },
  ]);
  expect(first.messages[1].content).toEqual([
    { type: "text", text: "Test prompt" },
    { type: "image", image: attachments[0].contentString },
    { type: "image", image: "data:image/jpeg;base64,anBlZw==" },
  ]);
  expect(second.messages[1].content[0].text).toBe("Other topic");
});

test("Alpaca retains source snapshots and uses the current tenant prompt", async () => {
  Chat.where.mockResolvedValue([
    chat({
      response: JSON.stringify({
        text: "Answer",
        sources: [{ text: "Saved context" }],
      }),
    }),
  ]);
  const { data } = await exportChatsAsType("jsonAlpaca", "personal", ctx);
  expect(JSON.parse(data)).toEqual([
    {
      instruction:
        "Tenant prompt\nContext:\n[CONTEXT 0]:\nSaved context\n[END CONTEXT 0]\n\n",
      input: "Test prompt",
      output: "Answer",
    },
  ]);
});

test("falls back to the tenant-aware default system prompt", async () => {
  getSettings.mockResolvedValue({ openAiPrompt: null });
  const result = await prepareChatsForExport("jsonl", "personal", ctx);
  expect(defaultPrompt).toHaveBeenCalledWith(ctx);
  expect(result[thread.id].messages[0].content[0].text).toBe("Default prompt");
});

test.each([undefined, ctx, { ...ctx, role: "manager" }])(
  "embedded export rejects non-admin identities: %p",
  async (identity) => {
    await expect(
      prepareChatsForExport("json", "embed", identity)
    ).rejects.toMatchObject({ status: 403 });
    expect(EmbedChats.whereWithEmbedAndLibrary).not.toHaveBeenCalled();
  }
);

test("tenant admins export only published chat records from their own tenant", async () => {
  const admin = { ...ctx, role: "admin" };
  EmbedChats.whereWithEmbedAndLibrary.mockResolvedValue([
    {
      ...chat(),
      embed_id: 10,
      embed_config: {
        tenantId: ctx.tenantId,
        library: { name: "Published knowledge" },
      },
    },
  ]);
  const [result] = await prepareChatsForExport("json", "embed", admin);
  expect(EmbedChats.whereWithEmbedAndLibrary).toHaveBeenCalledWith(
    { embed_config: { tenantId: ctx.tenantId } },
    null,
    { id: "asc" },
    null
  );
  expect(Chat.where).not.toHaveBeenCalled();
  expect(result.workspace).toBe("Published knowledge");
  expect(result.username).toBeUndefined();
});

test("platform embedded exports keep separate widgets and use each tenant's prompt", async () => {
  getSettings.mockImplementation(async (tenantId) => ({
    openAiPrompt: `${tenantId} prompt`,
  }));
  EmbedChats.whereWithEmbedAndLibrary.mockResolvedValue([
    {
      ...chat(),
      embed_id: 10,
      embed_config: { tenantId: "a", library: { name: "A" } },
    },
    {
      ...chat(),
      embed_id: 20,
      embed_config: { tenantId: "b", library: { name: "B" } },
    },
  ]);
  const result = await prepareChatsForExport("jsonl", "embed", {
    identity: "platform",
  });
  expect(EmbedChats.whereWithEmbedAndLibrary).toHaveBeenCalledWith(
    {},
    null,
    { id: "asc" },
    null
  );
  expect(Object.keys(result)).toEqual(["10", "20"]);
  expect(result[10].messages[0].content[0].text).toBe("a prompt");
  expect(result[20].messages[0].content[0].text).toBe("b prompt");
});
