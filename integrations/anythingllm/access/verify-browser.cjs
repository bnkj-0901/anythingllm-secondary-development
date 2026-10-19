const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { requireServer, serverDirectory } = require("./dependencies.cjs");
requireServer("dotenv").config({ path: path.join(serverDirectory, ".env") });
process.env.NODE_ENV = "production";
const prisma = requireServer("./utils/prisma");
const bcrypt = requireServer("bcryptjs");
const JWT = requireServer("jsonwebtoken");
const puppeteer = createRequire(path.resolve(serverDirectory, "../collector/package.json"))("puppeteer");
const base = "http://localhost:3001", fixture = `qa_${crypto.randomBytes(8).toString("hex")}`;
const password = crypto.randomBytes(24).toString("base64url");
const logs = path.resolve(__dirname, "../data/local-logs");
let browser, temporaryAdmin, activePage;
async function main() {
  const errors = [], failures = [], screenshotPaths = [];
  const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(file => fs.existsSync(file));
  assert.ok(executablePath, "Chrome or Edge is required.");
  browser = await puppeteer.launch({ executablePath, headless: "new" });
  const page = await browser.newPage();
  activePage = page;
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) { const url = new URL(frame.url()); console.log("Navigation", url.pathname, url.searchParams.get("redirectTo") || ""); } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()); });
  page.on("requestfailed", req => { if (req.failure()?.errorText !== "net::ERR_ABORTED") failures.push(new URL(req.url()).pathname); });
  await page.goto(`${base}/register`, { waitUntil: "networkidle0" });
  await page.waitForSelector('#tab-register[aria-selected="true"]');
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Registration overflow: ${width}`);
  }
  await page.type("#username", fixture);
  await page.type("#password", password);
  await page.type("#confirmPassword", password);
  console.log("Registering isolated browser fixture");
  await page.click("#auth-submit");
  await page.waitForFunction(() => location.pathname === "/portal" && document.querySelector("#account-name")?.textContent.startsWith("qa_"), { timeout: 20000 });
  console.log("Registration reached personal backend");
  await page.click("#create-open");
  await page.type("#space-name", "浏览器测试私有库");
  await page.click('#create-form button[type="submit"]');
  await page.waitForSelector(".space-card");
  console.log("Private workspace created");
  if (process.argv.includes("--with-ingestion")) {
    await page.evaluate(() => [...document.querySelectorAll(".space-card button")].find(node => node.textContent === "管理资料").click());
    await page.waitForSelector("#documents-dialog[open]");
    await page.click("#document-editor summary");
    await page.type("#doc-title", "隔离验证用例");
    await page.type("#doc-text", "知识库测试资料：示例回收点的营业时间为周一至周五 09:00 到 18:00。周六和周日休息。这是一份自动验证用的虚构资料。");
    await page.click('#text-form button[type="submit"]');
    await page.waitForFunction(() => /索引已完成|索引未全部完成|请求未完成|未能解析/.test(document.querySelector("#documents-message")?.textContent), { timeout: 120000 });
    const status = await page.$eval("#documents-message", node => node.textContent);
    assert.match(status, /索引已完成/, status);
    await page.waitForSelector(".doc-row");
    await page.evaluate(() => [...document.querySelectorAll("#documents-list button")].find(node => node.textContent === "查看原文").click());
    await page.waitForSelector("#reader-dialog[open]");
    assert.match(await page.$eval("#reader-text", node => node.textContent), /09:00 到 18:00/);
    await page.click('[data-close="reader-dialog"]');
    console.log("Real text ingestion, embedding and source reading passed");
    await (await page.$("#doc-file")).uploadFile(path.join(__dirname, "tests/fixtures/knowledge.txt"));
    await page.click('#upload-form button[type="submit"]');
    await page.waitForFunction(() => /索引已完成|索引未全部完成|请求未完成|未能解析/.test(document.querySelector("#documents-message")?.textContent), { timeout: 120000 });
    assert.match(await page.$eval("#documents-message", node => node.textContent), /索引已完成/);
    await page.waitForFunction(() => document.querySelectorAll("#documents-list .doc-row").length === 2);
    console.log("Real file upload and embedding passed");
    await page.click('[data-close="documents-dialog"]');
  }
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Portal overflow: ${width}`);
    if ([320, 1440].includes(width)) {
      const screenshot = path.join(logs, `personal-backend-${width}.png`); await page.screenshot({ path: screenshot, fullPage: true }); screenshotPaths.push(screenshot);
    }
  }
  // A real upstream query workspace must open with this ordinary account.
  await page.evaluate(() => [...document.querySelectorAll(".space-card button")].find(node => node.textContent === "进入问答").click());
  await page.waitForFunction(() => /^\/workspace\/kb-/.test(location.pathname), { timeout: 20000 });
  console.log("Original workspace opened");
  await page.waitForFunction(() => document.body.innerText.includes("浏览器测试私有库"), { timeout: 15000 });
  if (process.argv.includes("--with-ingestion")) {
    const evidence = await page.evaluate(async () => {
      const response = await fetch(`/api/workspace/${location.pathname.split("/")[2]}/stream-chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("anythingllm_authToken")}` }, body: JSON.stringify({ message: "根据知识库资料，示例回收点的营业时间是什么？周末营业吗？" }), signal: AbortSignal.timeout(90000) });
      const chunks = (await response.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
      const sources = chunks.flatMap(chunk => chunk.sources || []);
      const text = chunks.map(chunk => chunk.textResponse || "").join("");
      return { status: response.status, sourceCount: sources.length, mentionsTime: /09:00|9:00|9点|九点|9 时/.test(text), mentionsWeekend: /周末|周六|周日|星期六/.test(text), errors: chunks.filter(chunk => chunk.error).map(chunk => chunk.error) };
    });
    assert.equal(evidence.status, 200); assert.ok(evidence.sourceCount > 0, "Answer must cite the ingested source"); assert.equal(evidence.mentionsTime, true); assert.equal(evidence.mentionsWeekend, true); assert.deepEqual(evidence.errors, []);
    console.log("Real RAG answer and citation passed", JSON.stringify(evidence));
  }
  await page.goto(`${base}/portal`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".space-card");
  // Exercise the mobile login screen and logout round trip.
  await page.click("#logout");
  await page.waitForSelector("#auth-form");
  await page.type("#username", fixture); await page.type("#password", password); await page.click("#auth-submit");
  await page.waitForFunction(() => location.pathname === "/portal", { timeout: 20000 });
  temporaryAdmin = await prisma.users.create({ data: { username: `${fixture}_admin`, password: await bcrypt.hash(password, 4), role: "admin" } });
  const token = JWT.sign({ id: temporaryAdmin.id, username: temporaryAdmin.username }, process.env.JWT_SECRET, { expiresIn: "5m" });
  const owner = await prisma.users.findUnique({ where: { username: fixture } });
  const mapping = await prisma.system_settings.findFirst({ where: { label: { startsWith: "kb_access_space_" }, value: { contains: `"ownerId":${owner.id},` } } });
  const space = await prisma.workspaces.findUnique({ where: { id: Number(mapping.label.slice("kb_access_space_".length)) } });
  const other = await prisma.users.create({ data: { username: `${fixture}_other`, password: await bcrypt.hash(password, 4), role: "default" } });
  const otherToken = JWT.sign({ id: other.id }, process.env.JWT_SECRET, { expiresIn: "5m" });
  const request = (route, auth = otherToken, method = "GET", body) => fetch(base + route, { method, headers: { Origin: base, Authorization: `Bearer ${auth}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request(`/api/workspace/${space.slug}`)).status, 404);
  assert.equal((await request(`/api/workspace/${space.slug}/stream-chat`, otherToken, "POST", { message: "读取其他用户资料" })).status, 404);
  assert.equal((await request(`/api/access/spaces/${space.slug}/documents`)).status, 404);
  assert.equal((await request(`/api/access/spaces/${space.slug}`, token, "PATCH", { visibility: "public" })).status, 200);
  assert.equal((await request(`/api/workspace/${space.slug}`)).status, 200);
  assert.equal((await request(`/api/workspace/${space.slug}/update`, otherToken, "POST", { name: "越权修改" })).status, 403);
  assert.equal((await request(`/api/access/spaces/${space.slug}/documents`, otherToken, "POST", { title: "越权写入", text: "越权写入" })).status, 403);
  const thread = await (await request(`/api/workspace/${space.slug}/thread/new`, otherToken, "POST", {})).json();
  assert.ok(thread.thread?.slug, "Public readers may create their own conversation threads");
  const beforeRevoke = await (await request("/api/workspace/search", otherToken, "POST", { searchTerm: thread.thread.name })).json();
  assert.ok(beforeRevoke.threads.some(item => item.slug === thread.thread.slug));
  assert.equal((await request(`/api/access/spaces/${space.slug}`, token, "PATCH", { visibility: "private" })).status, 200);
  assert.equal((await request(`/api/workspace/${space.slug}`)).status, 404);
  const afterRevoke = await (await request("/api/workspace/search", otherToken, "POST", { searchTerm: thread.thread.name })).json();
  assert.equal(afterRevoke.threads.some(item => item.slug === thread.thread.slug), false);
  console.log("Live private isolation, public read-only access and revocation passed");
  await page.evaluate(({ token, user }) => { localStorage.setItem("anythingllm_authToken", token); localStorage.setItem("anythingllm_user", JSON.stringify(user)); }, { token, user: { id: temporaryAdmin.id, username: temporaryAdmin.username, role: "admin" } });
  await page.goto(`${base}/access/admin`, { waitUntil: "networkidle0" });
  await page.waitForSelector('#config-form:not([hidden])');
  assert.equal(await page.$eval("#h5-secret", node => node.value), "");
  assert.equal(await page.$eval("#web-secret", node => node.value), "");
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewport({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Config overflow: ${width}`);
  }
  const configShot = path.join(logs, "registration-wechat-config.png"); await page.screenshot({ path: configShot, fullPage: true }); screenshotPaths.push(configShot);
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#kb-entry-links");
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/access/logout" && response.status() === 200),
    page.evaluate(() => localStorage.removeItem("anythingllm_authToken")),
  ]);
  assert.equal((await page.cookies(`${base}/api/access`)).some(cookie => cookie.name === "kb_access_session"), false, "Upstream logout clears the portal cookie");
  assert.deepEqual(errors, [], "Browser runtime/console errors");
  assert.deepEqual(failures, [], "Browser failed requests");
  console.log(JSON.stringify({ registration: "passed", personalBackend: "passed", ordinaryWorkspaceSSO: "passed", passwordLogin: "passed", adminConfig: "passed", responsiveWidths: [320, 768, 1024, 1440], errors, failures, screenshotPaths }, null, 2));
}
async function cleanup() {
  if (browser) await browser.close();
  const users = await prisma.users.findMany({ where: { username: { in: [fixture, `${fixture}_admin`, `${fixture}_other`] } }, select: { id: true } });
  for (const user of users) {
    const policies = await prisma.system_settings.findMany({ where: { label: { startsWith: "kb_access_space_" } } });
    for (const row of policies) if (JSON.parse(row.value).ownerId === user.id) {
      const id = Number(row.label.slice("kb_access_space_".length));
      const docs = await prisma.workspace_documents.findMany({ where: { workspaceId: id } });
      if (docs.length) {
        const workspace = await prisma.workspaces.findUnique({ where: { id } });
        const { Document } = requireServer("./models/documents");
        await Document.removeDocuments(workspace, docs.map(doc => doc.docpath), user.id);
        await requireServer("./utils/helpers").getVectorDbClass()["delete-namespace"]({ namespace: workspace.slug });
        assert.equal(await prisma.workspace_documents.count({ where: { workspaceId: id } }), 0, "Keep unexpected documents for inspection");
      }
      await prisma.workspaces.delete({ where: { id } }); await prisma.system_settings.delete({ where: { id: row.id } });
      const directory = path.resolve(serverDirectory, "storage/documents", `kb-${id}`);
      const root = path.resolve(serverDirectory, "storage/documents");
      assert.equal(path.dirname(directory), root);
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true });
    }
    await prisma.users.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
}
main().catch(async error => {
  console.error(error.message);
  if (activePage) {
    await activePage.screenshot({ path: path.join(logs, "access-browser-failure.png"), fullPage: true });
    console.error(await activePage.evaluate(() => ({ path: location.pathname, text: document.body.innerText.slice(0, 1800) })));
  }
  process.exitCode = 1;
}).finally(cleanup);
