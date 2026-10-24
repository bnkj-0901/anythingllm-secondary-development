let mockRows = [];
jest.mock("../../../utils/files", () => ({ chatHistoryAttachments: () => [] }));
jest.mock("../../../utils/prisma", () => ({
  chats: {
    findMany: jest.fn(async ({ where, take, orderBy }) => {
      let rows = mockRows.filter((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value)
      );
      rows.sort(
        (a, b) =>
          (a.sequence - b.sequence) * (orderBy.sequence === "desc" ? -1 : 1)
      );
      return take == null ? rows : rows.slice(0, take);
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const rows = mockRows.filter((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value)
      );
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    }),
  },
}));
jest.mock("../../../utils/router", () => ({
  ModelRouterService: { resetForConversation: jest.fn() },
}));
const { Chat } = require("../../../models/workspaceChats");
const { recentChatHistory } = require("../../../utils/chats");
const { resetMemory } = require("../../../utils/chats/commands/reset");
const { ModelRouterService } = require("../../../utils/router");
const owner = { identity: "tenant", tenantId: "company-a", userId: "alice" };
const peer = { identity: "tenant", tenantId: "company-a", userId: "bob" };
const foreign = { identity: "tenant", tenantId: "company-b", userId: "alice" };
const seed = (prompt, scope = owner, extra = {}) =>
  mockRows.push({
    id: prompt,
    sequence: mockRows.length + 1,
    tenantId: scope.tenantId,
    userId: scope.userId,
    thread_id: "one",
    api_session_id: null,
    include: true,
    prompt,
    response: JSON.stringify({ text: "answer", sources: [] }),
    ...extra,
  });
beforeEach(() => {
  jest.clearAllMocks();
  mockRows = [];
  seed("first");
  seed("second");
  seed("reset snapshot", owner, { include: false });
  seed("another conversation", owner, { thread_id: "two" });
  seed("peer", peer);
  seed("foreign", foreign);
  seed("API session", owner, { api_session_id: "session-a" });
});
test("personal model history is ordered, active and isolated by tenant/user/conversation", async () => {
  const result = await recentChatHistory({ ctx: owner, threadId: "one" });
  expect(result.rawHistory.map((row) => row.prompt)).toEqual([
    "first",
    "second",
  ]);
  expect(result.chatHistory.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(
    (await recentChatHistory({ ctx: peer, threadId: "one" })).rawHistory.map(
      (row) => row.prompt
    )
  ).toEqual(["peer"]);
});
test("reset keeps saved answers visible while removing only the current conversation from model context", async () => {
  const result = await resetMemory({
    ctx: owner,
    threadId: "one",
    configuration: { chatProvider: "test" },
  });
  expect(result.textResponse).toBe("Chat memory was reset!");
  expect(
    (await recentChatHistory({ ctx: owner, threadId: "one" })).rawHistory
  ).toEqual([]);
  expect((await Chat.forThread(owner, "one")).map((row) => row.prompt)).toEqual(
    ["first", "second", "reset snapshot"]
  );
  expect(mockRows).toHaveLength(7);
  expect(
    mockRows.filter((row) => row.include).map((row) => row.prompt)
  ).toEqual(["another conversation", "peer", "foreign"]);
  expect(ModelRouterService.resetForConversation).toHaveBeenCalledWith(
    owner,
    "one",
    { chatProvider: "test" }
  );
});
test("reset writer cannot erase another user's or another company's context", async () => {
  await resetMemory({ ctx: peer, threadId: "one", configuration: {} });
  expect(
    (await recentChatHistory({ ctx: owner, threadId: "one" })).rawHistory
  ).toHaveLength(2);
  expect(
    (await recentChatHistory({ ctx: foreign, threadId: "one" })).rawHistory
  ).toHaveLength(1);
  expect(
    (await recentChatHistory({ ctx: peer, threadId: "one" })).rawHistory
  ).toEqual([]);
});
test("a missing conversation scope cannot become a wildcard reset", async () => {
  await expect(
    resetMemory({ ctx: null, threadId: "one", configuration: {} })
  ).rejects.toMatchObject({ status: 401 });
  await resetMemory({ ctx: owner, threadId: null, configuration: {} });
  expect(mockRows.filter((row) => row.include)).toHaveLength(6);
});
