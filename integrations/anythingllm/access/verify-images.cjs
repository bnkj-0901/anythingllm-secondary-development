const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { requireServer, serverDirectory } = require("./dependencies.cjs");
requireServer("dotenv").config({ path: path.join(serverDirectory, ".env") });
process.env.NODE_ENV = "production";
const prisma = requireServer("./utils/prisma");
const JWT = requireServer("jsonwebtoken");
const puppeteer = createRequire(path.resolve(serverDirectory, "../collector/package.json"))("puppeteer");
const base = "http://localhost:3001", fixture = `imgqa_${crypto.randomBytes(6).toString("hex")}`;
let browser, directory, user, space, other, activePage;
async function request(route, { method = "GET", body, token = user && JWT.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "5m" }) } = {}) {
  return fetch(base + "/api/access" + route, { method, headers: { Origin: base, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
}
async function main() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "kb-image-browser-"));
  const errors = [];
  browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
  const page = await browser.newPage(); activePage = page;
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", item => { if (item.type() === "error") errors.push(item.text()); });
  await page.setViewport({ width: 1200, height: 500, deviceScaleFactor: 1 });
  await page.setContent('<html lang="zh-CN"><meta charset="utf-8"><body style="margin:0;padding:48px;background:white;color:black;font:40px/1.8 Microsoft YaHei"><b>知识库图片测试资料</b><br>示例回收站营业时间：周一至周五<br>09:00 - 18:00<br>周六和周日休息。联系电话：123456789</body></html>');
  const imageFile = path.join(directory, "knowledge.png"); await page.screenshot({ path: imageFile });
  if (process.argv.includes("--ocr-only")) {
    const { recognize } = require("./image-runtime.cjs");
    const text = await recognize(imageFile);
    console.log("Real OCR:", text); assert.match(text, /09[:：]00/); assert.match(text, /周\s*六|周\s*日/); return;
  }
  const password = crypto.randomBytes(20).toString("base64url");
  await page.goto(base + "/register", { waitUntil: "networkidle0" });
  await page.type("#username", fixture); await page.type("#password", password); await page.type("#confirmPassword", password); await page.click("#auth-submit");
  await page.waitForFunction(() => location.pathname === "/portal" && document.querySelector("#account-name")?.textContent.startsWith("imgqa_"), { timeout: 20000 });
  user = await prisma.users.findUnique({ where: { username: fixture } });
  await page.click("#create-open"); await page.type("#space-name", "图片知识验证"); await page.click('#create-form button[type="submit"]'); await page.waitForSelector(".space-card");
  space = await prisma.workspaces.findFirst({ where: { workspace_users: { some: { user_id: user.id } } } });
  const policy = await prisma.system_settings.findUnique({ where: { label: `kb_access_space_${space.id}` } });
  if (process.argv.includes("--chat")) {
    await prisma.workspaces.update({ where: { id: space.id }, data: { chatMode: "automatic" } });
    await page.click(".space-card button:first-child");
    await page.waitForSelector("#dnd-chat-file-uploader");
    await page.reload({ waitUntil: "networkidle0" });
    await (await page.$("#dnd-chat-file-uploader")).uploadFile(imageFile);
    await page.type("#primary-prompt-input", "识别这张图片存入知识库", { delay: 40 });
    assert.equal(await page.$eval("#primary-prompt-input", node => node.value), "识别这张图片存入知识库");
    await page.waitForFunction(() => document.querySelector('[data-tooltip-id="send-prompt"]') && !document.querySelector('[data-tooltip-id="send-prompt"]').disabled);
    const sent = page.waitForRequest(req => req.url().endsWith("/stream-chat") && req.method() === "POST");
    await page.click('[data-tooltip-id="send-prompt"]');
    const payload = JSON.parse((await sent).postData());
    assert.equal(payload.message, "识别这张图片存入知识库"); assert.equal(payload.attachments.length, 1); assert.equal(payload.attachments[0].mime, "image/png");
    await page.waitForSelector('a[href*="/portal?space="]', { timeout: 20000 });
    const beforeReload = await prisma.workspace_chats.count({ where: { workspaceId: space.id } });
    assert.equal(beforeReload, 1, "Chat acknowledgement is persisted once");
    assert.equal(await prisma.workspace_agent_invocations.count({ where: { workspace_id: space.id } }), 0, "Image save bypasses the unsupported model even in automatic mode");
    await page.reload({ waitUntil: "networkidle0" });
    const review = await page.waitForSelector('a[href*="/portal?space="]');
    const href = await review.evaluate(node => node.getAttribute("href"));
    assert.match(href, /^\/portal\?space=kb-/);
    // Upstream opens Markdown links in a new tab; follow the same known local
    // review URL in this isolated test tab to inspect the resulting modal.
    await page.goto(base + href, { waitUntil: "networkidle0" });
    console.log("PASS: Original chat upload, automatic-mode bypass, persistent review link and portal deep link");
  } else {
    const manage = await page.waitForSelector(".space-card button:nth-child(2)"); await manage.click();
    await page.waitForSelector("#documents-dialog[open]");
    await (await page.$("#image-file")).uploadFile(imageFile); await page.click('#image-upload-form button[type="submit"]');
  }
  await page.waitForSelector("#image-review-dialog[open]");
  await page.waitForFunction(() => /待人工确认|识别未完成/.test(document.querySelector("#image-review-status").textContent), { timeout: 165000 });
  const text = await page.$eval("#image-text", node => node.value); console.log("Browser OCR:", text);
  assert.match(text, /09[:：]00/); assert.match(text, /周\s*六|周\s*日/);
  assert.equal(await prisma.workspace_documents.count({ where: { workspaceId: space.id } }), 0, "Unconfirmed OCR must not be indexed");
  const row = await prisma.system_settings.findFirst({ where: { label: { startsWith: "kb_access_image_" }, value: { contains: `"spaceId":${space.id},` } } });
  const draft = JSON.parse(row.value), imageRoute = `/spaces/${space.slug}/images/${draft.id}`;
  await prisma.system_settings.update({ where: { id: policy.id }, data: { value: JSON.stringify({ ownerId: user.id, visibility: "public" }) } });
  other = await prisma.users.create({ data: { username: `${fixture}_other`, role: "default", password: "disabled-test-account", suspended: 0 } });
  const otherToken = JWT.sign({ id: other.id }, process.env.JWT_SECRET, { expiresIn: "5m" });
  assert.equal((await request(imageRoute + "/original", { token: otherToken })).status, 404, "Public members cannot view pending originals");
  assert.equal((await request(imageRoute + "/confirm", { method: "POST", token: otherToken, body: { confirmed: true, revision: draft.revision } })).status, 403);
  await prisma.system_settings.update({ where: { id: policy.id }, data: { value: JSON.stringify({ ownerId: user.id, visibility: "private" }) } });
  assert.equal((await request(imageRoute + "/confirm", { method: "POST", body: { revision: draft.revision } })).status, 422);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector("#image-review-dialog").scrollWidth <= document.querySelector("#image-review-dialog").clientWidth), true, `Image review overflow ${width}`);
    if ([320, 1440].includes(width)) await page.screenshot({ path: path.resolve(__dirname, `../data/local-logs/image-review-${width}.png`), fullPage: true });
  }
  await page.click("#image-text"); await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
  await page.type("#image-text", "图片经人工核对：示例回收站周一至周五 09:00 - 18:00 营业，周六和周日休息。联系电话 123456789。测试资料。");
  assert.equal(await page.$eval("#image-confirmed", node => node.checked), false);
  await page.click("#image-save"); await page.waitForFunction(() => document.querySelector("#image-review-message").textContent.includes("草稿已保存"));
  await page.click('[data-close="image-review-dialog"]'); await page.click('[data-close="documents-dialog"]');
  await page.reload({ waitUntil: "networkidle0" });
  if (process.argv.includes("--chat")) await page.waitForSelector("#image-review-dialog[open]");
  else {
    await page.waitForSelector(".space-card"); await (await page.$(".space-card button:nth-child(2)")).click();
    await page.waitForSelector(".image-review-open"); await page.click(".image-review-open");
  }
  assert.match(await page.$eval("#image-text", node => node.value), /经人工核对/);
  await page.click("#image-confirmed"); await page.click("#image-confirm");
  await page.waitForFunction(() => /索引已完成|索引未完成/.test(document.querySelector("#images-message").textContent + document.querySelector("#image-review-message").textContent), { timeout: 120000 });
  assert.match(await page.$eval("#images-message", node => node.textContent), /索引已完成/);
  assert.equal(await prisma.workspace_documents.count({ where: { workspaceId: space.id } }), 1);
  const saved = JSON.parse((await prisma.system_settings.findUnique({ where: { id: row.id } })).value);
  const duplicate = await request(imageRoute + "/confirm", { method: "POST", body: { confirmed: true, revision: saved.revision } }); assert.equal(duplicate.status, 200);
  assert.equal(await prisma.workspace_documents.count({ where: { workspaceId: space.id } }), 1);
  await prisma.system_settings.update({ where: { id: policy.id }, data: { value: JSON.stringify({ ownerId: user.id, visibility: "public" }) } });
  assert.equal((await request(imageRoute + "/original", { token: otherToken })).status, 200, "Public confirmed source is readable");
  await prisma.system_settings.update({ where: { id: policy.id }, data: { value: JSON.stringify({ ownerId: user.id, visibility: "private" }) } });
  assert.equal((await request(imageRoute + "/original", { token: otherToken })).status, 404, "Private source is revoked immediately");
  await page.waitForSelector("#documents-list .doc-row button"); await (await page.$("#documents-list .doc-row button")).click();
  await page.waitForSelector("#reader-dialog[open]"); assert.match(await page.$eval("#reader-text", node => node.textContent), /经人工核对/);
  assert.equal(await page.$eval("#reader-image", node => node.hidden), false);
  const document = await prisma.workspace_documents.findFirst({ where: { workspaceId: space.id } });
  const removed = await request(`/spaces/${space.slug}/documents/${document.id}`, { method: "DELETE" }); assert.equal(removed.status, 200);
  await prisma.system_settings.update({ where: { id: policy.id }, data: { value: JSON.stringify({ ownerId: user.id, visibility: "public" }) } });
  assert.equal((await request(imageRoute + "/original", { token: otherToken })).status, 404, "Removed source is no longer shared");
  await fs.rm(path.join(process.env.STORAGE_DIR, "documents", document.docpath), { force: true });
  assert.deepEqual(errors, []);
  console.log("PASS: Chinese/English OCR, draft persistence, manual correction, real embedding, one-time confirmation, original source and access revocation; responsive 320/768/1024/1440; no browser errors.");
}
async function cleanup() {
  await browser?.close();
  if (space) {
    const { Document } = requireServer("./models/documents");
    const docs = await prisma.workspace_documents.findMany({ where: { workspaceId: space.id } });
    if (docs.length) await Document.removeDocuments(space, docs.map(doc => doc.docpath), user.id);
    const rows = await prisma.system_settings.findMany({ where: { label: { startsWith: "kb_access_image_" }, value: { contains: `"spaceId":${space.id},` } } });
    for (const row of rows) { const value = JSON.parse(row.value); await fs.rm(path.join(process.env.STORAGE_DIR, "knowledge-images", value.id, "original"), { force: true }); await fs.rm(path.join(process.env.STORAGE_DIR, "knowledge-images", value.id, "preview.png"), { force: true }); await fs.rmdir(path.join(process.env.STORAGE_DIR, "knowledge-images", value.id)); await prisma.system_settings.delete({ where: { id: row.id } }); }
    for (const doc of docs) await fs.rm(path.join(process.env.STORAGE_DIR, "documents", doc.docpath), { force: true });
    await prisma.system_settings.deleteMany({ where: { label: `kb_access_space_${space.id}` } });
    await prisma.workspace_users.deleteMany({ where: { workspace_id: space.id } });
    await prisma.workspaces.delete({ where: { id: space.id } });
  }
  for (const value of [user, other]) if (value) await prisma.users.delete({ where: { id: value.id } });
  await prisma.$disconnect();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}
main().catch(async error => { if (activePage) await activePage.screenshot({ path: path.resolve(__dirname, "../data/local-logs/image-verification-failed.png"), fullPage: true }).catch(() => {}); console.error(error); process.exitCode = 1; }).finally(cleanup);
