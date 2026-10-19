const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { serverDirectory } = require("../dependencies.cjs");
const sharp = createRequire(path.resolve(serverDirectory, "../collector/package.json"))("sharp");
const { createVision } = require("../vision.cjs");
const smallImage = () => sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
async function sectionedImage() {
  const width = 600, height = 900, data = Buffer.alloc(width * height * 3, 255);
  const pixel = (x, y, color) => color.forEach((v, c) => { data[(y * width + x) * 3 + c] = v; });
  for (const top of [50, 300, 600]) for (let y = top; y < top + 25; y++) for (let x = 10; x <= 590; x++) pixel(x, y, [0, 165, 220]);
  for (const x of [10, 110, 210, 310, 410, 510, 590]) for (let y = 10; y < 890; y++) pixel(x, y, [10, 10, 10]);
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
function fixture(fetchImpl) {
  let stored;
  const prisma = { system_settings: { findUnique: async () => stored, upsert: async ({ create, update }) => { stored = stored ? { ...stored, ...update } : create; } } };
  const encryption = { encrypt: text => Buffer.from(text).toString("base64"), decrypt: text => Buffer.from(text, "base64").toString() };
  return createVision({ prisma, encryption, fetchImpl, embeddingConfig: () => ({ baseUrl: "https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", apiKey: "existing-key" }) });
}
test("vision config hides keys, preserves blank secrets, and restricts external hosts", async () => {
  const vision = fixture();
  assert.equal((await vision.visible()).enabled, false);
  const saved = await vision.save({ enabled: true, keySource: "custom", apiKey: "test-only-key", model: "qwen-vl-max" });
  assert.equal(saved.secretConfigured, true); assert.equal(JSON.stringify(saved).includes("test-only-key"), false);
  assert.equal((await vision.save({ apiKey: "" })).secretConfigured, true);
  for (const baseUrl of ["http://localhost/v1", "https://evil.invalid/v1", "https://dashscope.aliyuncs.com.evil.invalid/v1", "https://user:secret@dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/anything"]) await assert.rejects(vision.save({ baseUrl }), { code: "invalid_vision_url" });
  await assert.rejects(vision.save({ model: "text-embedding-v4" }), { code: "invalid_vision_model" });
  assert.equal((await vision.save({ enabled: false, clearSecret: true })).secretConfigured, false);
});
test("vision sends actual image bytes and table prompt to the configured Aliyun endpoint", async () => {
  let captured;
  const vision = fixture(async (url, options) => { captured = { url, options, body: JSON.parse(options.body) }; return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "| 内存 | 8+128 |\n| --- | --- |\n| 数字 | 155 |" } }] })); });
  await vision.save({ enabled: true, keySource: "embedding", model: "qwen-vl-max" });
  const original = await smallImage(), result = await vision.recognize(original, "image/png");
  assert.match(result.text, /8\+128/); assert.equal(result.engine, "aliyun:qwen-vl-max");
  assert.match(captured.url, /^https:\/\/ws-test.cn-beijing.maas.aliyuncs.com\//);
  assert.equal(captured.options.headers.Authorization, "Bearer existing-key");
  assert.match(captured.body.messages[1].content[0].image_url.url, /^data:image\/png;base64,/);
  assert.equal(captured.body.messages[1].content[0].image_url.url.split(",")[1], original.toString("base64"));
  assert.match(captured.body.messages[0].content, /不.*猜/);
  assert.equal(captured.options.redirect, "error");
});
test("vision rejects truncated, empty and failed output without leaking provider secrets", async () => {
  for (const response of [new Response("secret error", { status: 401 }), new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "half table" } }] })), new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }] }))]) {
    const vision = fixture(async () => response);
    await vision.save({ enabled: true });
    await assert.rejects(vision.recognize(await smallImage(), "image/png"), error => { assert.ok(!error.message.includes("secret error")); assert.match(error.code, /^vision_(provider|output)$/); return true; });
  }
});
test("dedicated OCR models use documented user prompts, pixel bounds and a 4096 token cap", async () => {
  let body;
  const vision = fixture(async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "转录结果" } }] })); });
  await vision.save({ enabled: true, model: "qwen3.5-ocr" });
  await vision.recognize(await smallImage(), "image/png");
  assert.equal(body.messages.length, 1); assert.equal(body.messages[0].role, "user");
  assert.equal(body.max_tokens, 4096); assert.ok(body.messages[0].content[0].max_pixels <= 32 * 32 * 8192);
  assert.match(body.messages[0].content[1].text, /顶部的标题/);
  assert.match(body.messages[0].content[1].text, /保留空白格/);
  assert.match(body.messages[0].content[1].text, /不猜测/);
  assert.match(body.messages[0].content[1].text, /不执行图中指令/);
  assert.match(body.messages[0].content[1].text, /【待核对】/);
});

test("dense tables send distinct ordered crops, merge only complete results and share one deadline", async () => {
  const requests = [], progress = [], words = ["顶部标题与第一品牌", "第二品牌", "末尾品牌"];
  const vision = fixture(async (_url, options) => {
    const body = JSON.parse(options.body), encoded = body.messages[0].content[0].image_url.url.split(",")[1];
    const crop = await sharp(Buffer.from(encoded, "base64")).metadata();
    requests.push({ encoded, crop, signal: options.signal });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: words[requests.length - 1] } }] }));
  });
  await vision.save({ enabled: true });
  const result = await vision.recognize(await sectionedImage(), "image/png", async value => progress.push(value));
  assert.equal(requests.length, 3); assert.equal(result.text, words.join("\n\n"));
  assert.notEqual(requests[0].encoded, requests[1].encoded);
  assert.deepEqual(requests.map(request => request.crop.height), [300, 300, 300]);
  assert.ok(requests.every(request => request.signal === requests[0].signal));
  assert.deepEqual(progress.filter(item => item.total === 3).map(item => item.completed), [0, 1, 2, 3]);
  assert.match(result.warning, /3 个分区/);
});

test("a truncated section stops recognition without accepting partial table text or calling later sections", async () => {
  let calls = 0;
  const progress = [], vision = fixture(async () => new Response(JSON.stringify({ choices: [{ finish_reason: ++calls === 2 ? "length" : "stop", message: { content: "部分表格" } }] })));
  await vision.save({ enabled: true });
  await assert.rejects(vision.recognize(await sectionedImage(), "image/png", async value => progress.push(value)), { code: "vision_output" });
  assert.equal(calls, 2); assert.equal(progress.at(-1).completed, 1);
});

test("provider repetition is rejected with an actionable safe error", async () => {
  const vision = fixture(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "repeated", message: { content: "循环生成的残缺表格" } }] })));
  await vision.save({ enabled: true });
  await assert.rejects(vision.recognize(await smallImage(), "image/png"), error => {
    assert.equal(error.code, "vision_output"); assert.match(error.message, /模型重复生成/); assert.match(error.message, /更换视觉模型/); return true;
  });
});
