// Isolated browser regression for an image sent during an existing agent session.
// This verifier connects to the already running server.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { requireServer, serverDirectory } = require("./dependencies.cjs");
requireServer("dotenv").config({ path: path.join(serverDirectory, ".env") });
process.env.NODE_ENV = "production";
const prisma = requireServer("./utils/prisma");
const puppeteer = createRequire(path.resolve(serverDirectory, "../collector/package.json"))("puppeteer");
const prefix = `agentimg_${crypto.randomBytes(5).toString("hex")}`, base = "http://localhost:3001";
let browser, directory, user, space, page;
async function main() {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "kb-agent-image-"));
  browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
  page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewport({ width: 1200, height: 800 });
  await page.setContent('<body style="background:white;color:black;font:40px Arial;padding:50px">Agent OCR fixture<br>Price: 123 RMB</body>');
  const file = path.join(directory, "agent-price.png"); await page.screenshot({ path: file });
  await page.goto(base + "/register", { waitUntil: "networkidle0" });
  const password = crypto.randomBytes(24).toString("base64url");
  await page.type("#username", prefix); await page.type("#password", password); await page.type("#confirmPassword", password); await page.click("#auth-submit");
  await page.waitForSelector("#account-name");
  user = await prisma.users.findUnique({ where: { username: prefix } });
  await page.click("#create-open"); await page.type("#space-name", "智能体会话图片验证"); await page.click('#create-form button[type="submit"]'); await page.waitForSelector(".space-card");
  space = await prisma.workspaces.findFirst({ where: { workspace_users: { some: { user_id: user.id } } } });
  await prisma.workspaces.update({ where: { id: space.id }, data: { chatMode: "automatic" } });
  await page.click(".space-card button:first-child"); await page.waitForSelector("#primary-prompt-input"); await page.reload({ waitUntil: "networkidle0" });
  const feedback = [], socketData = [];
  const cdp = await page.target().createCDPSession(); await cdp.send("Network.enable");
  cdp.on("Network.webSocketFrameSent", event => { try { const data = JSON.parse(event.response.payloadData); if (data.type === "awaitingFeedback") feedback.push({ text: data.feedback, images: data.attachments?.length }); } catch {} });
  cdp.on("Network.webSocketFrameReceived", event => { try { const data = JSON.parse(event.response.payloadData); socketData.push({ type: data.type, subtype: data.content?.type }); } catch {} });
  await page.type("#primary-prompt-input", "你好，只回复你好，不调用工具。", { delay: 40 }); await page.click('[data-tooltip-id="send-prompt"]');
  await page.waitForFunction(() => !document.querySelector('[data-tooltip-id="send-prompt"]')?.disabled && document.body.innerText.includes("你好"), { timeout: 90000 });
  // WAITING_ON_INPUT proves subsequent attachments will use the websocket.
  for (let attempt = 0; !socketData.some(data => data.type === "WAITING_ON_INPUT") && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(socketData.some(data => data.type === "WAITING_ON_INPUT"), "Agent must be awaiting a follow-up");
  await (await page.$("#dnd-chat-file-uploader")).uploadFile(file);
  await page.type("#primary-prompt-input", "识别这张图片存入知识库", { delay: 40 });
  await page.waitForFunction(() => !document.querySelector('[data-tooltip-id="send-prompt"]').disabled);
  await page.click('[data-tooltip-id="send-prompt"]');
  await page.waitForSelector('a[href*="/portal?space="]', { timeout: 20000 });
  assert.ok(feedback.some(data => data.text === "识别这张图片存入知识库" && data.images === 1));
  assert.ok(socketData.some(data => data.type === "reportStreamEvent" && data.subtype === "fullTextResponse"));
  assert.equal(await prisma.workspace_documents.count({ where: { workspaceId: space.id } }), 0);
  await page.screenshot({ path: path.resolve(__dirname, "../data/local-logs/agent-image-chat.png"), fullPage: true });
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector('a[href*="/portal?space="]');
  assert.deepEqual(errors, []);
  console.log("PASS: Live agent websocket follow-up attachment -> OCR draft, visible persistent review link, no indexing, no browser errors.");
}
async function cleanup() {
  await browser?.close();
  if (space) {
    const rows = await prisma.system_settings.findMany({ where: { label: { startsWith: "kb_access_image_" }, value: { contains: `"spaceId":${space.id},` } } });
    for (const row of rows) {
      const value = JSON.parse(row.value);
      await fs.rm(path.join(process.env.STORAGE_DIR, "knowledge-images", value.id, "original"), { force: true });
      await fs.rm(path.join(process.env.STORAGE_DIR, "knowledge-images", value.id, "preview.png"), { force: true });
      await fs.rmdir(path.join(process.env.STORAGE_DIR, "knowledge-images", value.id));
      await prisma.system_settings.delete({ where: { id: row.id } });
    }
    await prisma.system_settings.deleteMany({ where: { label: `kb_access_space_${space.id}` } });
    await prisma.workspaces.delete({ where: { id: space.id } });
  }
  if (user) await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
}
main().catch(async error => { if (page) await page.screenshot({ path: path.resolve(__dirname, "../data/local-logs/agent-image-failed.png"), fullPage: true }).catch(() => {}); console.error(error); process.exitCode = 1; }).finally(cleanup);
