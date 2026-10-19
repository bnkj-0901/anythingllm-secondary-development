// Explicitly requested live evaluation: optionally enables Aliyun and re-recognizes only
// the supplied unedited draft/revision. Never confirms or indexes the result.
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { requireServer, serverDirectory } = require("./dependencies.cjs");
requireServer("dotenv").config({ path: path.join(serverDirectory, ".env") });
process.env.NODE_ENV = "production";
const prisma = requireServer("./utils/prisma"), JWT = requireServer("jsonwebtoken");
const puppeteer = createRequire(path.resolve(serverDirectory, "../collector/package.json"))("puppeteer");
const id = process.argv[2], revision = Number(process.argv[3]), base = "http://localhost:3001";
const model = process.argv[4] || "qwen3.5-ocr";
const reviewOnly = process.argv.includes("--review-only");
const useCurrentConfig = process.argv.includes("--use-current-config");
const denseModels = process.argv.includes("--dense-models");
let browser;
async function main() {
  assert.match(id || "", /^[a-f0-9]{32}$/); assert.ok(Number.isSafeInteger(revision));
  const row = await prisma.system_settings.findUnique({ where: { label: `kb_access_image_${id}` } }), old = JSON.parse(row.value);
  assert.equal(old.revision, revision, "Draft changed; re-open it before evaluating");
  assert.ok(["ready", "failed"].includes(old.status)); if (!reviewOnly) assert.equal(old.text.trim(), (old.recognizedText || "").trim(), "Preserve user-edited drafts");
  const user = await prisma.users.findUnique({ where: { id: old.ownerId } });
  assert.equal(user.role, "admin"); assert.ok(!user.suspended);
  const space = await prisma.workspaces.findUnique({ where: { id: old.spaceId } });
  const beforeCount = await prisma.workspace_documents.count({ where: { workspaceId: space.id } });
  const token = JWT.sign({ id: user.id }, process.env.JWT_SECRET, { algorithm: "HS256", audience: "kb-access", expiresIn: "10m" });
  browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setCookie({ name: "kb_access_session", value: token, domain: "localhost", path: "/api/access", httpOnly: true, sameSite: "Lax" });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(base + "/access/admin", { waitUntil: "networkidle0" }); await page.waitForSelector("#vision-form:not([hidden])");
  if (!reviewOnly && !useCurrentConfig) {
    if (!await page.$eval("#vision-enabled", node => node.checked)) await page.click("#vision-enabled");
    await page.select("#vision-key-source", "embedding");
    await page.click("#vision-model", { clickCount: 3 }); await page.type("#vision-model", model);
    const saved = page.waitForResponse(response => response.url().endsWith("/api/access/admin/vision") && response.request().method() === "PUT");
    await page.click("#vision-save"); assert.equal((await saved).status(), 200);
    await page.waitForFunction(() => document.getElementById("vision-message").textContent.includes("已保存"));
  }
  assert.equal(await page.$eval("#vision-enabled", node => node.checked), true);
  assert.equal(await page.$eval("#vision-model", node => node.value), model);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Admin overflow: ${width}`);
  }
  await page.screenshot({ path: path.resolve(__dirname, "../data/local-logs/vision-settings.png"), fullPage: true });
  await page.goto(`${base}/portal?space=${space.slug}&image=${id}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#image-review-dialog[open]");
  assert.equal(await page.$eval("#image-text", node => node.value), old.text);
  const started = Date.now();
  if (!reviewOnly) {
    page.once("dialog", dialog => dialog.accept());
    await page.click("#image-recognize");
    await page.waitForFunction(() => document.getElementById("image-review-status").textContent === "正在识别");
    console.log("Aliyun recognition started; original preserved, no indexing requested.");
    await page.waitForFunction(expected => document.getElementById("image-engine").textContent === `识别模型：${expected}`, { timeout: 15_000 }, model);
    if (denseModels) {
      await page.waitForFunction(() => document.getElementById("image-review-message").textContent.includes("/9 段"), { timeout: 15_000 });
      console.log(await page.$eval("#image-review-message", node => node.textContent));
      await page.screenshot({ path: path.resolve(__dirname, "../data/local-logs/vision-dense-progress.png"), fullPage: true });
    }
    await page.waitForFunction(() => document.getElementById("image-review-status").textContent !== "正在识别", { timeout: 140_000 });
  }
  const result = JSON.parse((await prisma.system_settings.findUnique({ where: { label: `kb_access_image_${id}` } })).value);
  assert.equal(result.status, "ready", result.error); assert.equal(result.engine, `aliyun:${model}`);
  if (denseModels) assert.deepEqual(result.progress, { completed: 9, total: 9 });
  if (!reviewOnly) { assert.equal(result.previousRecognition.text, old.text); assert.ok(result.revision > revision); }
  assert.equal(await page.$eval("#image-text", node => node.value), result.text);
  assert.equal(await page.$eval("#image-confirm", node => node.disabled), true);
  assert.equal(await prisma.workspace_documents.count({ where: { workspaceId: space.id } }), beforeCount);
  assert.equal(result.originalSha256, old.originalSha256);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Review overflow: ${width}`);
    if ([320, 1440].includes(width)) await page.screenshot({ path: path.resolve(__dirname, `../data/local-logs/vision-review-${width}.png`), fullPage: true });
  }
  await page.reload({ waitUntil: "networkidle0" }); await page.waitForSelector("#image-review-dialog[open]");
  assert.equal(await page.$eval("#image-text", node => node.value), result.text);
  assert.equal(await page.$eval("#image-previous", node => node.hidden), false);
  assert.deepEqual(errors, []);
  // Sample strings come from the source pixels, including its printed "Mgic".
  const tokens = denseModels ? ["496球手机型号", "OPPO", "一加", "真我", "VIVO", "IQOO", "小米", "红米", "三星", "华为/荣耀", "K10Pro", "FindX9Pro", "一加13T", "GT7Pro竞速", "S20Pro", "iqooneo10pro+", "红米Note12Turbo", "W24FLIP", "P50Pocket", "荣耀MgicVFlip"] : ["8+128", "8+256", "8+512", "12+256", "12+512", "12+1TB", "16+356", "16+512", "16+1TB", "24+1TB", "155", "205", "240", "230", "290", "400", "340", "500", "530", "X50Pro+", "X80", "X200Pro mini", "XFold3Pro", "一加13T"];
  const normalized = result.text.replace(/\s/g, "").toLowerCase();
  const missingTokens = tokens.filter(token => !normalized.includes(token.replace(/\s/g, "").toLowerCase()));
  if (denseModels) assert.deepEqual(missingTokens, [], "Selected source-image samples should be retained");
  if (!reviewOnly) console.log(result.text);
  console.log({ reviewOnly, seconds: Math.round((Date.now() - started) / 1000), checkedTokens: tokens.length, missingTokens, previousVersionRetained: true, indexed: false, browserErrors: errors.length });
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await prisma.$disconnect(); });
