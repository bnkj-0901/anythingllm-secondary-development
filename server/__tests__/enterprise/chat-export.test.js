const { createPostgresFixture } = require("./postgres-fixture.cjs");
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
        get(_target, key) {
          const value = mockFixture.prisma[key];
          return typeof value === "function"
            ? value.bind(mockFixture.prisma)
            : value;
        },
      }
    )
);
const { Chat } = require("../../models/workspaceChats");
const { ChatThread } = require("../../models/workspaceThread");
const {
  exportChatsAsType,
  prepareChatsForExport,
} = require("../../utils/helpers/chat/convertTo");

const owner = {
  identity: "tenant",
  tenantId: "a",
  userId: 101,
  username: "alice",
};
const peer = {
  identity: "tenant",
  tenantId: "a",
  userId: 102,
  role: "admin",
};
const foreign = { identity: "tenant", tenantId: "b", userId: 103 };
let first, second, peerThread, foreignThread, resetId;

beforeAll(async () => {
  mockFixture = await createPostgresFixture();
  const db = mockFixture.prisma;
  const stamp = mockFixture.db.now();
  for (const id of ["a", "b"])
    await db.ep_tenants.create({
      data: {
        id,
        code: id,
        name: id,
        hostname: `${id}.example.test`,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  for (const ctx of [owner, peer, foreign])
    await db.users.create({
      data: {
        id: ctx.userId,
        tenantId: ctx.tenantId,
        username: ctx.username || String(ctx.userId),
        name: String(ctx.userId),
        passwordHash: "unused",
        role: ctx.role || "user",
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  for (const tenantId of ["a", "b"])
    await db.ep_rag_settings.create({
      data: {
        tenantId,
        settings: JSON.stringify({
          openAiPrompt: `${tenantId} configured prompt`,
        }),
        updatedAt: stamp,
      },
    });

  first = (await ChatThread.new(owner, { name: "First conversation" })).thread;
  second = (await ChatThread.new(owner, { name: "Second conversation" }))
    .thread;
  peerThread = (
    await ChatThread.new(peer, { name: "Peer private conversation" })
  ).thread;
  foreignThread = (
    await ChatThread.new(foreign, { name: "Foreign conversation" })
  ).thread;
  resetId = (
    await Chat.new(owner, {
      threadId: first.id,
      prompt: "OWNER_FIRST",
      include: false,
      response: {
        text: "OWNER_ANSWER",
        attachments: [{ mime: "image/png", contentString: "cG5n" }],
        sources: [{ text: "Saved authorized context" }],
      },
    })
  ).chat.id;
  await Chat.new(owner, {
    threadId: first.id,
    prompt: "OWNER_FOLLOWUP",
    response: { text: "Follow up answer" },
  });
  await Chat.new(owner, {
    threadId: second.id,
    prompt: "OWNER_SECOND",
    response: { text: "Second answer" },
  });
  await Chat.reserve(owner, { threadId: first.id, prompt: "INCOMPLETE_AGENT" });
  await Chat.new(peer, {
    threadId: peerThread.id,
    prompt: "PEER_SECRET",
    response: { text: "Peer answer" },
  });
  await Chat.new(foreign, {
    threadId: foreignThread.id,
    prompt: "FOREIGN_SECRET",
    response: { text: "Foreign answer" },
  });
}, 30000);

afterAll(async () => {
  await mockFixture?.cleanup();
});

test.each(["json", "csv", "jsonl", "jsonAlpaca"])(
  "%s exports contain only the current user's conversations and retain reset snapshots",
  async (format) => {
    const { data } = await exportChatsAsType(format, "personal", owner);
    expect(data).toContain("OWNER_FIRST");
    expect(data).toContain("OWNER_SECOND");
    expect(data).not.toContain("PEER_SECRET");
    expect(data).not.toContain("FOREIGN_SECRET");
    expect(data).not.toContain("INCOMPLETE_AGENT");
    expect((await Chat.get(owner, { id: resetId })).include).toBe(false);
  }
);

test("JSONL creates one sample per personal conversation and preserves original content blocks", async () => {
  const { data } = await exportChatsAsType("jsonl", "personal", owner);
  const entries = data.split("\n").map(JSON.parse);
  expect(entries).toHaveLength(2);
  const conversation = entries.find(
    (entry) => entry.messages[1].content[0].text === "OWNER_FIRST"
  );
  expect(conversation.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(conversation.messages[0].content).toEqual([
    { type: "text", text: "a configured prompt" },
  ]);
  expect(conversation.messages[1].content[1]).toEqual({
    type: "image",
    image: "data:image/png;base64,cG5n",
  });
});

test("single conversation IDs cannot expand access to another user's or tenant's messages", async () => {
  const rows = await prepareChatsForExport("json", "personal", owner, {
    threadId: first.id,
  });
  expect(rows.map((row) => row.prompt)).toEqual([
    "OWNER_FIRST",
    "OWNER_FOLLOWUP",
  ]);
  for (const thread of [peerThread, foreignThread])
    await expect(
      prepareChatsForExport("json", "personal", owner, { threadId: thread.id })
    ).rejects.toMatchObject({ status: 404 });
  await expect(
    prepareChatsForExport("json", "personal", peer, { threadId: first.id })
  ).rejects.toMatchObject({ status: 404 });
});

test("personal export does not treat administrator status as access to employee conversations", async () => {
  const { data } = await exportChatsAsType("json", "personal", peer);
  expect(JSON.parse(data).map((row) => row.prompt)).toEqual(["PEER_SECRET"]);
  await expect(
    exportChatsAsType("json", "personal", { identity: "platform" })
  ).rejects.toMatchObject({ status: 401 });
});

test("embedded export uses database tenant filtering without mixing employee conversations", async () => {
  const db = mockFixture.prisma;
  for (const tenantId of ["a", "b"]) {
    const config = await db.embed_configs.create({
      data: {
        uuid: `embed-${tenantId}`,
        tenantId,
        libraryId: `library-${tenantId}`,
        enabled: true,
      },
    });
    await db.embed_chats.create({
      data: {
        embed_id: config.id,
        session_id: "visitor",
        prompt: `${tenantId}_VISITOR`,
        response: JSON.stringify({ text: `${tenantId} public answer` }),
      },
    });
  }
  const tenant = await exportChatsAsType("json", "embed", peer);
  expect(JSON.parse(tenant.data).map((row) => row.prompt)).toEqual([
    "a_VISITOR",
  ]);
  expect(tenant.data).not.toContain("OWNER_FIRST");
  const platform = await exportChatsAsType("jsonl", "embed", {
    identity: "platform",
  });
  const entries = platform.data.split("\n").map(JSON.parse);
  expect(entries).toHaveLength(2);
  expect(
    entries.map((entry) => entry.messages[0].content[0].text).sort()
  ).toEqual(["a configured prompt", "b configured prompt"]);
  await expect(exportChatsAsType("json", "embed", owner)).rejects.toMatchObject(
    { status: 403 }
  );
});
