const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { requireServer } = require("../dependencies.cjs");
const { createImageDrafts } = require("../image-drafts.cjs");
let directory, prisma, images, ingested = [], failIngest = false;
const space = { id: 1, slug: "fixture" }, user = { id: 5, role: "default" };
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "kb-images-"));
  const file = path.join(directory, "test.db"), db = new DatabaseSync(file);
  db.exec('CREATE TABLE system_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT UNIQUE, value TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, lastUpdatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)'); db.close();
  const { PrismaClient } = requireServer("@prisma/client");
  prisma = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  images = createImageDrafts({ prisma, directory: path.join(directory, "images"), recognize: async () => "识别原文 123", ingest: async input => { if (failIngest) throw new Error("Unavailable"); ingested.push(input); return { success: true, count: 1 }; } });
});
after(async () => { await prisma?.$disconnect(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
async function draft() {
  const result = await images.create(space, user, { originalname: "test.png", buffer: Buffer.from("image") }, async () => ({ preview: Buffer.from("preview"), mime: "image/png" }));
  for (let i = 0; i < 30; i++) { const value = await images.get(space, user, result.id); if (value.status !== "recognizing") return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("OCR did not settle");
}
test("OCR remains outside knowledge until edited text is explicitly confirmed", async () => {
  const value = await draft();
  assert.equal(value.text, "识别原文 123"); assert.equal(ingested.length, 0);
  await assert.rejects(images.confirm(space, user, value.id, { revision: value.revision }), { code: "confirmation_required" });
  const edited = await images.edit(space, user, value.id, { revision: value.revision, title: "核对资料", text: "人工更正 456" });
  await assert.rejects(images.confirm(space, user, value.id, { revision: value.revision, confirmed: true }), { code: "stale_draft" });
  const [a, b] = await Promise.allSettled([1, 2].map(() => images.confirm(space, user, value.id, { revision: edited.revision, confirmed: true })));
  assert.ok([a, b].some(result => result.status === "fulfilled"));
  assert.equal(ingested.length, 1); assert.equal(ingested[0].text, "人工更正 456");
  assert.equal(ingested[0].imageSnapshot.confirmedBy, user.id);
  assert.match(ingested[0].imageSnapshot.originalSha256, /^[a-f0-9]{64}$/);
  const saved = await images.confirm(space, user, value.id, { revision: edited.revision, confirmed: true });
  assert.equal(saved.status, "indexed"); assert.equal(ingested.length, 1);
  await assert.rejects(images.rerecognize(space, user, value.id, { revision: saved.revision }), { code: "draft_locked" });
});
test("draft text and originals stay private, and stale edits cannot overwrite", async () => {
  const value = await draft();
  await assert.rejects(images.get(space, { id: 6, role: "default" }, value.id), { status: 404 });
  await assert.rejects(images.get({ id: 2 }, user, value.id), { status: 404 });
  await assert.rejects(images.get(space, user, "../test"), { status: 404 });
  const edited = await images.edit(space, user, value.id, { revision: value.revision, title: "最新", text: "latest" });
  await assert.rejects(images.edit(space, user, value.id, { revision: value.revision, title: "旧", text: "stale" }), { code: "stale_draft" });
  assert.equal((await images.get(space, user, value.id)).text, edited.text);
  await images.remove(space, user, value.id);
  await assert.rejects(images.get(space, user, value.id), { status: 404 });
});
test("failed indexing retries only the confirmed snapshot", async () => {
  const value = await draft(); failIngest = true;
  await assert.rejects(images.confirm(space, user, value.id, { revision: value.revision, confirmed: true }), { code: "image_index_failed" });
  assert.equal((await images.get(space, user, value.id)).status, "index_failed");
  await assert.rejects(images.edit(space, user, value.id, { revision: value.revision, title: "变化", text: "changed" }), { code: "draft_locked" });
  failIngest = false;
  assert.equal((await images.confirm(space, user, value.id, { revision: value.revision, confirmed: true })).status, "indexed");
});
test("tampering with an original prevents publishing its draft", async () => {
  const value = await draft(), file = await images.original(space, user, value.id);
  fs.writeFileSync(file.path, "changed original");
  const before = ingested.length;
  await assert.rejects(images.confirm(space, user, value.id, { revision: value.revision, confirmed: true }), { code: "original_changed" });
  assert.equal(ingested.length, before);
});
test("image validation rejects renamed non-images, SVG and oversized inputs", async () => {
  const { validateImage } = require("../image-runtime.cjs");
  for (const buffer of [Buffer.from("pretend this is a png"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), Buffer.alloc(10 * 1024 * 1024 + 1)]) await assert.rejects(validateImage(buffer), { code: "invalid_image" });
});
test("OCR failure retains a private editable draft without indexing", async () => {
  const failedImages = createImageDrafts({ prisma, directory: path.join(directory, "failed-images"), recognize: async () => { throw new Error("OCR unavailable"); }, ingest: async () => { throw new Error("Must not ingest without confirmation"); } });
  const value = await failedImages.create(space, user, { originalname: "empty.png", buffer: Buffer.from("fixture") }, async () => ({ preview: Buffer.from("fixture"), mime: "image/png" }));
  let result;
  for (let i = 0; i < 30; i++) { result = await failedImages.get(space, user, value.id); if (result.status === "failed") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(result.status, "failed"); assert.equal(result.text, "");
  await assert.rejects(failedImages.confirm(space, user, value.id, { revision: result.revision, confirmed: true }), { code: "draft_locked" });
  assert.equal((await failedImages.edit(space, user, value.id, { revision: result.revision, title: "手工核对", text: "手动录入的内容" })).status, "ready");
});
test("re-recognition uses the original, preserves previous edits and invalidates old confirmations", async () => {
  let finish;
  const retryImages = createImageDrafts({ prisma, directory: path.join(directory, "retry-images"), recognize: async file => {
    assert.equal(path.basename(file), "original");
    return new Promise(resolve => { finish = resolve; });
  }, ingest: async () => { throw Error("Must not index"); } });
  const first = await retryImages.create(space, user, { originalname: "test.png", buffer: Buffer.from("original") }, async () => ({ preview: Buffer.from("smaller preview"), mime: "image/png" }));
  await new Promise(resolve => setImmediate(resolve)); finish("旧识别");
  let ready;
  for (let i = 0; i < 50; i++) { ready = await retryImages.get(space, user, first.id); if (ready.status === "ready") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  const edited = await retryImages.edit(space, user, first.id, { revision: ready.revision, title: "edited", text: "人工修订" });
  await assert.rejects(retryImages.rerecognize(space, { id: 66, role: "default" }, first.id, { revision: edited.revision }), { status: 404 });
  await assert.rejects(retryImages.rerecognize(space, user, first.id, { revision: ready.revision }), { code: "stale_draft" });
  const retry = await retryImages.rerecognize(space, user, first.id, { revision: edited.revision });
  assert.equal(retry.status, "recognizing"); assert.equal(retry.previousRecognition.text, "人工修订");
  await assert.rejects(retryImages.rerecognize(space, user, first.id, { revision: retry.revision }), { code: "draft_locked" });
  await new Promise(resolve => setImmediate(resolve)); finish({ text: "新识别", engine: "aliyun:test", warning: "核对数字" });
  for (let i = 0; i < 50; i++) { ready = await retryImages.get(space, user, first.id); if (ready.status === "ready") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(ready.text, "新识别"); assert.equal(ready.engine, "aliyun:test"); assert.equal(ready.previousRecognition.text, "人工修订");
  await assert.rejects(retryImages.confirm(space, user, first.id, { revision: edited.revision, confirmed: true }), { code: "stale_draft" });
});
test("failed cloud re-recognition retains the last text and reports a safe actionable error", async () => {
  let failRecognition = false;
  const retryImages = createImageDrafts({ prisma, directory: path.join(directory, "cloud-failure"), recognize: async () => {
    if (failRecognition) throw Object.assign(new Error("百炼额度不足，请检查余额后重试。"), { code: "vision_provider" });
    return "保留的识别文字";
  }, ingest: async () => { throw Error("Must not index"); } });
  const first = await retryImages.create(space, user, { originalname: "test.png", buffer: Buffer.from("original") }, async () => ({ preview: Buffer.from("preview"), mime: "image/png" }));
  let ready;
  for (let i = 0; i < 50; i++) { ready = await retryImages.get(space, user, first.id); if (ready.status === "ready") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  failRecognition = true;
  await retryImages.rerecognize(space, user, first.id, { revision: ready.revision });
  for (let i = 0; i < 50; i++) { ready = await retryImages.get(space, user, first.id); if (ready.status === "failed") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(ready.status, "failed"); assert.equal(ready.text, "保留的识别文字"); assert.match(ready.error, /余额/);
  assert.equal(ready.previousRecognition.text, "保留的识别文字");
});
test("pending and failed drafts show the actual cloud model and completed section progress", async () => {
  let finish;
  const progressImages = createImageDrafts({ prisma, directory: path.join(directory, "progress-images"), recognize: async (_file, _mime, progress) => {
    await progress({ engine: "aliyun:qwen3.5-ocr", completed: 0, total: 3 });
    await progress({ engine: "aliyun:qwen3.5-ocr", completed: 1, total: 3 });
    return new Promise((_resolve, reject) => { finish = () => reject(Object.assign(Error("分段识别未完成"), { code: "vision_output" })); });
  }, ingest: async () => { throw Error("Must not index"); } });
  const first = await progressImages.create(space, user, { originalname: "test.png", buffer: Buffer.from("original") }, async () => ({ preview: Buffer.from("preview"), mime: "image/png" }));
  assert.equal(first.engine, null, "Do not invent a local engine before dispatch");
  let pending;
  for (let i = 0; i < 50; i++) { pending = await progressImages.get(space, user, first.id); if (pending.progress?.completed === 1) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(pending.status, "recognizing"); assert.equal(pending.engine, "aliyun:qwen3.5-ocr"); assert.deepEqual(pending.progress, { completed: 1, total: 3 });
  finish();
  for (let i = 0; i < 50; i++) { pending = await progressImages.get(space, user, first.id); if (pending.status === "failed") break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(pending.status, "failed"); assert.equal(pending.engine, "aliyun:qwen3.5-ocr"); assert.equal(pending.text, "");
});
