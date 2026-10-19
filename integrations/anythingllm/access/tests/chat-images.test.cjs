const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { requireServer, serverDirectory } = require("../dependencies.cjs");
const { createImageDrafts } = require("../image-drafts.cjs");
const { validateImage } = require("../image-runtime.cjs");
const { installImageChat } = require("../chat-images.cjs");
let directory, prisma, owner, other, admin, space, thread, stream, websocket, images;
let upstreamCalls = 0, ingested = 0;
const attachment = { name: "报价.png", mime: "image/png", contentString: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
const message = "识别这张图片存入知识库";
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "kb-chat-image-"));
  const file = path.join(directory, "test.db"), db = new DatabaseSync(file);
  const migrations = path.join(serverDirectory, "prisma/migrations");
  for (const name of fs.readdirSync(migrations).sort()) {
    const migration = path.join(migrations, name, "migration.sql");
    if (fs.existsSync(migration)) db.exec(fs.readFileSync(migration, "utf8"));
  }
  db.close();
  const { PrismaClient } = requireServer("@prisma/client");
  prisma = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  owner = await prisma.users.create({ data: { username: "owner", password: "unused", role: "default" } });
  other = await prisma.users.create({ data: { username: "other", password: "unused", role: "default" } });
  admin = await prisma.users.create({ data: { username: "admin", password: "unused", role: "admin" } });
  space = await prisma.workspaces.create({ data: { name: "私有库", slug: "private-test", chatMode: "automatic" } });
  thread = await prisma.workspace_threads.create({ data: { name: "我的会话", slug: "own-thread", workspace_id: space.id, user_id: owner.id } });
  await prisma.system_settings.create({ data: { label: `kb_access_space_${space.id}`, value: JSON.stringify({ visibility: "private", ownerId: owner.id }) } });
  images = createImageDrafts({ prisma, directory: path.join(directory, "images"), recognize: async () => "测试价格 123 元", ingest: async () => { ingested++; } });
  stream = { streamChatWithWorkspace: async () => { upstreamCalls++; } };
  websocket = { plugin({ socket }) { return { setup() { socket.askForFeedback = async () => socket.queue.shift(); } }; } };
  installImageChat({ prisma, images, validateImage, stream, websocket });
});
after(async () => { await prisma?.$disconnect(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
async function chat({ user = owner, workspace = space, inThread = null, attachments = [attachment], prompt = message } = {}) {
  let wire = "";
  await stream.streamChatWithWorkspace({ write(chunk) { wire += chunk; } }, workspace, prompt, "automatic", user, inThread, attachments);
  return wire ? JSON.parse(wire.slice(6).trim()) : null;
}
test("original automatic chat creates an OCR draft and a persistent review link without calling the LLM or indexing", async () => {
  const result = await chat();
  assert.equal(result.type, "textResponse"); assert.equal(result.close, true);
  assert.match(result.textResponse, /核对/); assert.match(result.textResponse, /\/portal\?space=private-test&image=[a-f0-9]{32}/);
  assert.equal(upstreamCalls, 0); assert.equal(ingested, 0);
  const saved = await prisma.workspace_chats.findUnique({ where: { id: result.chatId } });
  const response = JSON.parse(saved.response);
  assert.equal(saved.user_id, owner.id); assert.equal(saved.thread_id, null);
  assert.equal(response.text, result.textResponse); assert.equal(response.attachments[0].contentString, attachment.contentString);
  const drafts = await images.list(space, owner); assert.equal(drafts.length, 1);
});
test("thread messages stay in the owning user's thread; unrelated chats still use upstream", async () => {
  const result = await chat({ inThread: thread });
  const saved = await prisma.workspace_chats.findUnique({ where: { id: result.chatId } });
  assert.equal(saved.thread_id, thread.id);
  assert.equal(await chat({ attachments: [], prompt: "你好" }), null);
  assert.equal(await chat({ prompt: "图片描述" }), null);
  assert.equal(upstreamCalls, 2);
  const denied = await chat({ user: other, inThread: thread });
  assert.match(denied.textResponse, /权限|不存在/); assert.equal(denied.chatId, undefined);
});
test("active agent feedback uses the same OCR bridge and resumes waiting without invoking the model", async () => {
  const packets = [], socket = { queue: [{ feedback: message, attachments: [attachment] }, { feedback: "继续", attachments: [] }], send: value => packets.push(JSON.parse(value)), readyState: 1, OPEN: 1 };
  const plugin = websocket.plugin({ socket });
  plugin.setup({ handlerProps: { invocation: { workspace: space, user_id: owner.id, thread_id: thread.id } } });
  const next = await socket.askForFeedback(socket, { from: "USER", to: "agent" });
  assert.equal(next.feedback, "继续");
  const reply = packets.find(packet => packet.content?.type === "fullTextResponse");
  assert.equal(reply.type, "reportStreamEvent");
  assert.match(reply.content.content, /核对/);
  assert.ok(packets.some(packet => packet.content?.type === "chatId"));
  assert.equal(ingested, 0);
});
test("invalid payloads and read-only libraries cannot create drafts or misleading successes", async () => {
  const before = await prisma.system_settings.count({ where: { label: { startsWith: "kb_access_image_" } } });
  for (const attachments of [[{ ...attachment, contentString: "data:image/png;base64,@@" }], [{ ...attachment, contentString: "https://example.com/picture.png" }], [attachment, attachment], [{ ...attachment, contentString: `data:image/png;base64,${"A".repeat(14_000_000)}` }]]) {
    const result = await chat({ attachments }); assert.match(result.textResponse, /图片|一张|10MB/); assert.equal(result.chatId, undefined);
  }
  await prisma.system_settings.update({ where: { label: `kb_access_space_${space.id}` }, data: { value: JSON.stringify({ visibility: "public", ownerId: owner.id }) } });
  assert.match((await chat()).textResponse, /管理员/);
  assert.match((await chat({ user: admin, inThread: thread })).textResponse, /会话不存在|权限/);
  await prisma.users.update({ where: { id: admin.id }, data: { suspended: 1 } });
  assert.match((await chat({ user: admin })).textResponse, /登录/);
  await prisma.users.update({ where: { id: admin.id }, data: { suspended: 0 } });
  await prisma.system_settings.delete({ where: { label: `kb_access_space_${space.id}` } });
  assert.match((await chat()).textResponse, /管理员|分类/);
  assert.equal(await prisma.system_settings.count({ where: { label: { startsWith: "kb_access_image_" } } }), before);
  const legacy = await chat({ user: admin }); assert.match(legacy.textResponse, /核对/);
  assert.equal(await prisma.system_settings.findUnique({ where: { label: `kb_access_space_${space.id}` } }), null, "Legacy permissions must not be silently changed");
});
