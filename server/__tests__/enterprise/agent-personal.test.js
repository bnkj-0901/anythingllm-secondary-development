const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "personal-agent-"));
process.env.STORAGE_DIR = temp;
let mockOrm, mockDb;
jest.mock(
  "../../utils/prisma",
  () =>
    new Proxy(
      {},
      {
        get(_target, key) {
          const value = mockOrm[key];
          return typeof value === "function" ? value.bind(mockOrm) : value;
        },
      }
    )
);
jest.mock(
  "../../enterprise/store",
  () =>
    new Proxy(
      {},
      {
        get(_target, key) {
          const value = mockDb[key];
          return typeof value === "function" ? value.bind(mockDb) : value;
        },
      }
    )
);
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: async () => {} },
}));
const { ChatThread } = require("../../models/workspaceThread");
const { Chat } = require("../../models/workspaceChats");
const {
  WorkspaceAgentInvocation,
} = require("../../models/workspaceAgentInvocation");
const { agentWebsocket } = require("../../endpoints/agentWebsocket");
const auth = require("../../enterprise/auth");
const providers = require("../../enterprise/providers");
const { executeChat } = require("../../enterprise/rag");
let fixture, listener, modelServer, port, owner, peer, foreign;
let modelRequests = [];
const sockets = [];
const prior = {};
function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
async function eventually(check) {
  for (let i = 0; i < 150; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Agent condition was not reached");
}
async function connect(uuid, ctx, hostname = "agent-a.example.test") {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/api/agent-invocation/${uuid}`,
    { headers: { host: hostname } }
  );
  sockets.push(socket);
  const frames = [];
  socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({ type: "authenticate", token: auth.signed(ctx).token })
  );
  return { socket, frames };
}
beforeAll(async () => {
  for (const key of [
    "NODE_ENV",
    "STORAGE_DIR",
    "SIG_KEY",
    "SIG_SALT",
    "JWT_SECRET",
    "PLATFORM_HOSTS",
    "LLM_PROVIDER",
    "GENERIC_OPEN_AI_BASE_PATH",
    "GENERIC_OPEN_AI_API_KEY",
    "GENERIC_OPEN_AI_MODEL_PREF",
    "GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT",
    "GENERIC_OPEN_AI_MAX_TOKENS",
  ]) {
    prior[key] = process.env[key];
  }
  process.env.NODE_ENV = "test";
  process.env.SIG_KEY = "agent-integration-key";
  process.env.SIG_SALT = "agent-integration-salt";
  process.env.JWT_SECRET = "agent-jwt-key";
  process.env.PLATFORM_HOSTS = "admin.example.test";
  fixture = await createPostgresFixture();
  mockOrm = fixture.prisma;
  mockDb = fixture.db;
  const now = new Date().toISOString();
  for (const id of ["agent-a", "agent-b"])
    await mockOrm.ep_tenants.create({
      data: {
        id,
        code: id,
        name: String(id),
        hostname: `${id}.example.test`,
        createdAt: now,
        updatedAt: now,
      },
    });
  for (const [id, tenantId] of [
    [101, "agent-a"],
    [102, "agent-a"],
    [103, "agent-b"],
  ])
    await mockOrm.users.create({
      data: {
        id,
        tenantId,
        username: String(id),
        name: String(id),
        passwordHash: "unused",
        role: "user",
        createdAt: now,
        updatedAt: now,
      },
    });
  owner = await auth.context(101);
  peer = await auth.context(102);
  foreign = await auth.context(103);
  await mockOrm.system_settings.create({
    data: {
      label: "disabled_agent_skills",
      value: JSON.stringify([
        "rag-memory",
        "summarize-document",
        "web-scraping",
        "web-browsing",
      ]),
    },
  });
  modelServer = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    modelRequests.push(input);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const text of ["Agent ", "answer"]) {
      res.write(
        `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
      );
    }
    res.write(
      `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })}\n\n`
    );
    res.end("data: [DONE]\n\n");
  });
  await listen(modelServer);
  const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
  // Startup restores these same shared platform settings for original Agent SDKs.
  Object.assign(process.env, {
    LLM_PROVIDER: "generic-openai",
    GENERIC_OPEN_AI_BASE_PATH: baseUrl,
    GENERIC_OPEN_AI_API_KEY: "agent-test-key",
    GENERIC_OPEN_AI_MODEL_PREF: "test-agent",
    GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT: "8192",
    GENERIC_OPEN_AI_MAX_TOKENS: "1024",
  });
  await mockOrm.ep_connections.create({
    data: {
      id: "agent-chat",
      scope: "platform",
      kind: "chat",
      provider: "openai-compatible",
      name: "Agent test",
      model: "test-agent",
      baseUrl,
      secret: providers.encrypt("agent-test-key"),
      options: JSON.stringify({ contextWindow: 8192, maxTokens: 1024 }),
      isDefault: 1,
      createdAt: now,
      updatedAt: now,
    },
  });
  const app = express();
  require("@mintplex-labs/express-ws").default(app);
  agentWebsocket(app);
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  port = listener.address().port;
});
afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await new Promise((resolve) => listener?.close(resolve));
  modelServer?.closeAllConnections();
  await new Promise((resolve) => modelServer?.close(resolve));
  await fixture?.cleanup();
  fs.rmSync(temp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("real original Agent WebSocket streams and persists only its owner's conversation", async () => {
  const thread = (await ChatThread.new(owner, { name: "Agent" })).thread;
  const { invocation } = await WorkspaceAgentInvocation.new({
    ctx: owner,
    threadId: thread.id,
    prompt: "@agent Answer briefly",
  });
  const { socket, frames } = await connect(invocation.uuid, owner);
  await eventually(() =>
    frames.find((frame) => frame.type === "WAITING_ON_INPUT")
  );
  const pairs = await eventually(async () => {
    const rows = await Chat.forThread(owner, thread.id, { include: true });
    return rows.length ? rows : null;
  });
  expect(pairs).toHaveLength(1);
  expect(JSON.parse(pairs[0].response)).toMatchObject({
    text: "Agent answer",
    type: "chat",
  });
  expect(frames.some((frame) => frame.type === "reportStreamEvent")).toBe(true);
  expect(await Chat.forThread(peer, thread.id)).toEqual([]);
  expect(await Chat.forThread(foreign, thread.id)).toEqual([]);
  const count = modelRequests.length;
  await mockOrm.users.update({
    where: { id: owner.userId },
    data: { status: "disabled" },
  });
  socket.send(
    JSON.stringify({ type: "awaitingFeedback", feedback: "Another question" })
  );
  await eventually(() => socket.readyState === WebSocket.CLOSED);
  expect(modelRequests).toHaveLength(count);
  await mockOrm.users.update({
    where: { id: owner.userId },
    data: { status: "active" },
  });
});

test("a peer, another tenant or a mismatched host cannot resume an invocation", async () => {
  const thread = (await ChatThread.new(owner)).thread;
  const { invocation } = await WorkspaceAgentInvocation.new({
    ctx: owner,
    threadId: thread.id,
    prompt: "@agent Answer",
  });
  const count = modelRequests.length;
  for (const [ctx, host] of [
    [peer, "agent-a.example.test"],
    [foreign, "agent-b.example.test"],
    [owner, "agent-b.example.test"],
  ]) {
    const { socket, frames } = await connect(invocation.uuid, ctx, host);
    await eventually(() => socket.readyState === WebSocket.CLOSED);
    expect(frames.some((frame) => frame.type === "wssFailure")).toBe(true);
  }
  expect(modelRequests).toHaveLength(count);
  expect(await Chat.forThread(owner, thread.id)).toEqual([]);
});

test("real HTTP Agent uses the same original engine and personal pair persistence", async () => {
  const thread = (await ChatThread.new(peer)).thread;
  const events = [];
  const result = await executeChat({
    ctx: peer,
    threadId: thread.id,
    prompt: "@agent Answer over HTTP",
    onEvent: (event) => events.push(event),
  });
  expect(result.textResponse).toBe("Agent answer");
  expect(events.at(-1)).toMatchObject({
    type: "finalizeResponseStream",
    chatId: expect.any(Number),
  });
  expect(await Chat.forThread(peer, thread.id, { include: true })).toHaveLength(
    1
  );
  expect(await Chat.forThread(owner, thread.id)).toEqual([]);
});
