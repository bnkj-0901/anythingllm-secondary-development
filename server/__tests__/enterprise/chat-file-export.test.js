const http = require("http");
const jwt = require("jsonwebtoken");
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
const owner = { identity: "tenant", tenantId: "a", userId: 101 };
const peer = { identity: "tenant", tenantId: "a", userId: 102 };
const foreign = { identity: "tenant", tenantId: "b", userId: 103 };
const envKeys = ["JWT_SECRET", "PLATFORM_HOSTS"];
let previous, listener, base, saved, empty, reserved;
const tokens = {};
const actorIds = { owner: 101, peer: 102, foreign: 103 };

function requestExport(actor, threadId, type = "markdown", host) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${base}/api/enterprise/conversations/${threadId}/export/${type}`,
      {
        method: "POST",
        headers: {
          host: host || (actor === "foreign" ? "b.localhost" : "a.localhost"),
          "content-type": "application/json",
          ...(actor
            ? { authorization: `Bearer ${tokens[actorIds[actor]]}` }
            : {}),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
          })
        );
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    request.end("{}");
  });
}

beforeAll(async () => {
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.JWT_SECRET = "isolated-personal-file-export";
  process.env.PLATFORM_HOSTS = "localhost";
  mockFixture = await createPostgresFixture();
  const db = mockFixture.prisma;
  const stamp = mockFixture.db.now();
  for (const id of ["a", "b"])
    await db.ep_tenants.create({
      data: {
        id,
        code: id,
        name: id,
        hostname: `${id}.localhost`,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  for (const ctx of [owner, peer, foreign]) {
    await db.users.create({
      data: {
        id: ctx.userId,
        tenantId: ctx.tenantId,
        username: String(ctx.userId),
        name: String(ctx.userId),
        passwordHash: "unused",
        role: ctx.userId === 102 ? "admin" : "user",
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
    tokens[ctx.userId] = jwt.sign(
      { identity: "tenant", tenantId: ctx.tenantId, ver: 1 },
      process.env.JWT_SECRET,
      { subject: String(ctx.userId), audience: "enterprise-tenant-v1" }
    );
  }
  saved = (await ChatThread.new(owner, { name: "Personal quotation" })).thread;
  empty = (await ChatThread.new(owner, { name: "Empty" })).thread;
  reserved = (await ChatThread.new(owner, { name: "Pending Agent" })).thread;
  await Chat.new(owner, {
    threadId: saved.id,
    prompt: "FIRST_QUESTION",
    response: { text: "<think>Hidden reasoning</think>FIRST_ANSWER" },
  });
  await Chat.new(owner, {
    threadId: saved.id,
    prompt: "RESET_SNAPSHOT",
    include: false,
    response: { text: "RESET_ANSWER" },
  });
  await Chat.reserve(owner, {
    threadId: reserved.id,
    prompt: "INCOMPLETE_AGENT",
  });
  const app = require("../../app").createApp();
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
}, 30000);

afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  for (const [key, value] of Object.entries(previous || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("exports the owner's personal conversation with the original Markdown renderer", async () => {
  const response = await requestExport("owner", saved.id);
  expect(response.status).toBe(200);
  expect(response.headers["content-type"]).toMatch(/^text\/markdown/);
  expect(response.text).toContain("**Conversation:** Personal quotation");
  expect(response.text).toContain("**You**");
  expect(response.text).toContain("FIRST_QUESTION");
  expect(response.text).toContain("FIRST_ANSWER");
  expect(response.text).not.toContain("RESET_SNAPSHOT");
  expect(response.text).not.toContain("Hidden reasoning");
  expect(response.text).not.toContain("Workspace:");
});

test.each(["peer", "foreign"])(
  "%s cannot export another user's conversation, including tenant administrators",
  async (actor) => {
    const response = await requestExport(actor, saved.id);
    expect(response.status).toBe(404);
    expect(response.text).not.toContain("FIRST_QUESTION");
  }
);

test.each(["plaintext", "json", "html"])(
  "retains the original %s renderer with personal conversation metadata",
  async (type) => {
    const response = await requestExport("owner", saved.id, type);
    expect(response.status).toBe(200);
    expect(response.text).toContain("Personal quotation");
    expect(response.text).toContain("FIRST_ANSWER");
    if (type === "json") {
      const parsed = JSON.parse(response.text);
      expect(parsed.conversation).toBe("Personal quotation");
      expect(parsed.messages[1]).toEqual({
        role: "assistant",
        content: "FIRST_ANSWER",
        reasoning: "Hidden reasoning",
      });
      expect(parsed).not.toHaveProperty("workspace");
    }
  }
);

test("empty conversations, unfinished Agent responses and invalid formats return 400", async () => {
  expect((await requestExport("owner", empty.id)).status).toBe(400);
  expect((await requestExport("owner", reserved.id)).status).toBe(400);
  expect((await requestExport("owner", saved.id, "exe")).status).toBe(400);
});

test("file exports enforce the current live login and request hostname", async () => {
  expect((await requestExport(null, saved.id)).status).toBe(401);
  expect(
    (await requestExport("owner", saved.id, "markdown", "b.localhost")).status
  ).toBe(401);
  await mockFixture.prisma.users.update({
    where: { id: owner.userId },
    data: { status: "disabled" },
  });
  expect((await requestExport("owner", saved.id)).status).toBe(401);
});
