const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const requireCollector = createRequire(path.resolve(__dirname, "../../vendor/anythingllm/collector/package.json"));
const puppeteer = requireCollector("puppeteer");

async function main() {
  const base = "http://localhost:3001";
  for (const endpoint of ["/api/ping", "/api/onboarding", "/api/system/document-processing-status", "/api/system/accepted-document-types"]) {
    const response = await fetch(base + endpoint);
    const protectedEndpoint = endpoint.startsWith('/api/system/');
    assert.ok(response.status === 200 || (protectedEndpoint && response.status === 401), `${endpoint}: ${response.status}`);
    console.log(`${endpoint}: ${response.status === 401 ? "authentication required" : "OK"}`);
  }
  assert.equal((await fetch("http://127.0.0.1:8888/accepts")).status, 200, "Collector health");
  const executablePath = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(executablePath, "Chrome or Edge is required for this browser check.");
  const browser = await puppeteer.launch({ executablePath, headless: "new", args: ["--lang=zh-CN"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors = [];
    const failures = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("requestfailed", (request) => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on("response", (response) => {
      if (response.url().startsWith(base) && response.status() >= 400) {
        failures.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(base, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForFunction(() => document.querySelector("#root")?.innerText.trim().length > 10, { timeout: 15000 }).catch(() => {});
    const body = await page.evaluate(() => document.body.innerText);
    const screenshot = path.join(__dirname, "data/local-logs/startup.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(JSON.stringify({ url: page.url(), title: await page.title(), text: body.slice(0, 1800), errors, failures, screenshot }, null, 2));
    assert.ok(body.trim().length > 10, "Application content should render.");
    assert.deepEqual(errors, [], "Browser should have no runtime/console errors.");
    assert.deepEqual(failures, [], "Page requests should succeed.");
  } finally {
    await browser.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
