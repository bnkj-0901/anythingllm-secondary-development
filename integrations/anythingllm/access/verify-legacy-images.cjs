const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const { requireServer, serverDirectory } = require("./dependencies.cjs");
requireServer("dotenv").config({ path: path.join(serverDirectory, ".env") });
process.env.NODE_ENV = "production";
const prisma = requireServer("./utils/prisma");
const puppeteer = createRequire(path.resolve(serverDirectory, "../collector/package.json"))("puppeteer");
const prefix = `legacyimg_${crypto.randomBytes(5).toString("hex")}`, base = "http://localhost:3001";
let browser, user, space, draft;
async function main() {
  const password = crypto.randomBytes(24).toString("base64url");
  user = await prisma.users.create({ data: { username: prefix, password: await requireServer("bcryptjs").hash(password, 4), role: "admin" } });
  space = await prisma.workspaces.create({ data: { slug: prefix, name: "原有库图片核对测试" } });
  const images = require("./image-drafts.cjs").createImageDrafts({ prisma, directory: path.join(process.env.STORAGE_DIR, "knowledge-images"), recognize: async () => "测试资料：型号 TEST123，价格 123。", ingest: async () => { throw Error("This regression must not index"); } });
  draft = await images.create(space, user, { originalname: "原有图片.png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") }, require("./image-runtime.cjs").validateImage);
  browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(base + "/h5", { waitUntil: "networkidle0" });
  await page.type("#username", prefix); await page.type("#password", password); await page.click("#auth-submit");
  await page.waitForSelector("#legacy-list .doc-row");
  const ownRow = await page.waitForFunction(name => [...document.querySelectorAll("#legacy-list .doc-row")].find(node => node.textContent.includes(name)), {}, space.name);
  const manage = await ownRow.$(".legacy-manage");
  assert.ok(manage, "An unclassified workspace needs a visible management entry for its existing OCR drafts");
  await manage.click(); await page.waitForSelector("#documents-dialog[open] .image-review-open");
  await page.click(".image-review-open"); await page.waitForSelector("#image-review-dialog[open]");
  assert.match(await page.$eval("#image-text", node => node.value), /TEST123/);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Legacy review overflow at ${width}`);
  }
  await page.click('[data-close="image-review-dialog"]'); await page.click('[data-close="documents-dialog"]');
  await page.setViewport({ width: 1200, height: 900 }); await page.screenshot({ path: path.resolve(__dirname, "../data/local-logs/legacy-image-entry.png"), fullPage: true });
  await page.goto(`${base}/portal?space=${space.slug}`, { waitUntil: "networkidle0" });
  await page.waitForSelector("#documents-dialog[open] .image-review-open");
  await page.goto(`${base}/workspace/${space.slug}`, { waitUntil: "networkidle0" });
  const entry = `#kb-entry-links a[href="/portal?space=${space.slug}"]`;
  await page.waitForSelector(entry);
  assert.equal(await page.$eval(entry, node => node.textContent), "图片录入与核对");
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.$eval("#kb-entry-links", node => { const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; }), true, `Chat review entry overflow at ${width}`);
  }
  await page.click(entry); await page.waitForSelector("#documents-dialog[open] .image-review-open");
  assert.equal(await prisma.system_settings.findUnique({ where: { label: `kb_access_space_${space.id}` } }), null);
  assert.equal(await prisma.workspace_documents.count({ where: { workspaceId: space.id } }), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: Legacy library management and original chat have visible draft review entries; no classification or indexing; responsive 320/768/1024/1440.");
}
async function cleanup() {
  await browser?.close();
  if (draft) {
    for (const file of ["original", "preview.png"]) await fs.rm(path.join(process.env.STORAGE_DIR, "knowledge-images", draft.id, file), { force: true });
    await fs.rmdir(path.join(process.env.STORAGE_DIR, "knowledge-images", draft.id));
    await prisma.system_settings.deleteMany({ where: { label: `kb_access_image_${draft.id}` } });
  }
  if (space) await prisma.workspaces.delete({ where: { id: space.id } });
  if (user) await prisma.users.delete({ where: { id: user.id } });
  await prisma.$disconnect();
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(cleanup);
