const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const syncFs = require("node:fs");
const suiteDirectory = syncFs.mkdtempSync(
  path.join(os.tmpdir(), "collector-parser-suite-")
);
process.env.STORAGE_DIR = suiteDirectory;
test.after(() => fs.rm(suiteDirectory, { recursive: true, force: true }));
const { parseDocument } = require("../documentParser");
const { createCollectorApp } = require("../app");
const { docx, pdf, pptx, openDocument } = require("./fixtures.cjs");
const { ACCEPTED_MIMES } = require("../utils/constants");

async function workspace(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "knowledge-parser-")
  );
  const root = path.join(directory, "enterprise");
  await fs.mkdir(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root };
}

test("DOCX parsing extracts Chinese text without changing originals or writing artifacts", async (t) => {
  const { root } = await workspace(t),
    file = path.join(root, "规则.docx");
  const bytes = docx("差旅住宿标准为每晚 460 元。财务须复核发票。<规则>");
  await fs.writeFile(file, bytes);
  const result = await parseDocument(
    { filename: "规则.docx", options: { absolutePath: file } },
    { storageRoot: root }
  );
  assert.equal(result.length, 1);
  assert.equal(
    result[0].pageContent,
    "差旅住宿标准为每晚 460 元。财务须复核发票。<规则>"
  );
  assert.equal(result[0].metadata.format, "docx");
  assert.equal(result[0].metadata.title, "规则.docx");
  assert.equal(result[0].metadata.docAuthor, "no author found");
  assert.equal(result[0].metadata.docSource, "docx file uploaded by the user.");
  assert.equal(result[0].metadata.url, undefined);
  assert.equal(result[0].metadata.location, undefined);
  assert.equal(
    result[0].metadata.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  assert.ok(result[0].metadata.token_count_estimate > 0);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(root), ["规则.docx"]);
  assert.equal(result[0].location, undefined);
});

test("PDF parsing preserves page text and reports page metadata", async (t) => {
  const { root } = await workspace(t),
    file = path.join(root, "policy.pdf");
  await fs.writeFile(
    file,
    pdf("Travel claims must be submitted within 10 working days.")
  );
  const result = await parseDocument(
    { filename: "policy.pdf", options: { absolutePath: file } },
    { storageRoot: root }
  );
  assert.match(result[0].pageContent, /within 10 working days/);
  assert.equal(result[0].metadata.format, "pdf");
  assert.equal(result[0].metadata.pageNumber, 1);
  assert.equal(result[0].metadata.totalPages, 1);
  assert.equal(result[0].metadata.mimeType, "application/pdf");
  assert.equal((await fs.readdir(root)).length, 1);
});

test("unknown text extensions retain the original Collector text fallback", async (t) => {
  const { root } = await workspace(t);
  const file = path.join(root, "guide.customtext");
  await fs.writeFile(file, "未知扩展名的文字资料，仍按原版文本识别规则解析。");
  const result = await parseDocument(
    { filename: "guide.customtext", options: { absolutePath: file } },
    { storageRoot: root }
  );
  assert.equal(
    result[0].pageContent,
    "未知扩展名的文字资料，仍按原版文本识别规则解析。"
  );
  assert.deepEqual(await fs.readdir(root), ["guide.customtext"]);
});

test("unknown binary files fail safely without falling through to the text decoder", async (t) => {
  const { root } = await workspace(t);
  const file = path.join(root, "data.custombinary");
  const bytes = Buffer.from([0, 1, 2, 3, 4, 0, 5, 6]);
  await fs.writeFile(file, bytes);
  await assert.rejects(
    parseDocument(
      { filename: "data.custombinary", options: { absolutePath: file } },
      { storageRoot: root }
    ),
    (error) =>
      error.status === 422 &&
      /无法解析/.test(error.message) &&
      !error.message.includes(root)
  );
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(root), ["data.custombinary"]);
});

test("all upstream text formats retain source text and legacy encodings", async (t) => {
  const { root } = await workspace(t);
  const samples = [
    [
      "utf16.txt",
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("中文资料", "utf16le"),
      ]),
      "中文资料",
    ],
    ["utf16be.md", Buffer.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]), "中文"],
    [
      "windows.org",
      Buffer.from([0x80, 0x20, 0x93, 0x48, 0x69, 0x94]),
      "€ “Hi”",
    ],
    ["notes.adoc", Buffer.from("= 文档标题\n段落"), "= 文档标题\n段落"],
    ["notes.rst", Buffer.from("标题\n===="), "标题\n===="],
    [
      "records.csv",
      Buffer.from('名称,金额\n"含,逗号",123'),
      '名称,金额\n"含,逗号",123',
    ],
    ["records.json", Buffer.from('{"金额":123}'), '{"金额":123}'],
    [
      "page.html",
      Buffer.from("<h1>上游文本语义</h1>"),
      "<h1>上游文本语义</h1>",
    ],
  ];
  for (const [filename, bytes, expected] of samples) {
    const original = path.join(root, filename);
    await fs.writeFile(original, bytes);
    const documents = await parseDocument(
      { filename, options: { absolutePath: original } },
      { storageRoot: root }
    );
    assert.equal(documents[0].pageContent, expected, filename);
    assert.deepEqual(await fs.readFile(original), bytes);
  }
  assert.equal((await fs.readdir(root)).length, samples.length);
});

test("XLSX preserves sheet order, long numbers, dates and RFC 4180 quoting", async (t) => {
  const { root } = await workspace(t);
  const xlsx = require("node-xlsx").default;
  const file = path.join(root, "workbook.xlsx");
  const bytes = xlsx.build([
    {
      name: "规则",
      data: [
        ["编号", "日期", "说明"],
        [
          1234567890123,
          { v: 45585, t: "n", z: "yyyy-mm-dd" },
          '含,逗号与"引号"\n换行',
        ],
      ],
    },
    { name: "第二页", data: [["另一条资料"]] },
  ]);
  await fs.writeFile(file, bytes);
  const documents = await parseDocument(
    { filename: "workbook.xlsx", options: { absolutePath: file } },
    { storageRoot: root }
  );
  assert.equal(documents.length, 1);
  assert.match(documents[0].pageContent, /^Sheet: 规则\n/);
  assert.match(documents[0].pageContent, /Sheet: 规则[\s\S]*Sheet: 第二页/);
  assert.match(documents[0].pageContent, /1234567890123/);
  assert.match(documents[0].pageContent, /2024-10-20/);
  assert.match(documents[0].pageContent, /"含,逗号与""引号""\n换行"/);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(root), ["workbook.xlsx"]);
});

test("PPTX retains numeric slide ordering and notes; ODT/ODP extract local text", async (t) => {
  const { root } = await workspace(t);
  const fixtures = [
    ["slides.pptx", pptx()],
    ["document.odt", openDocument("开放文档正文")],
    ["slides.odp", openDocument("开放演示正文")],
  ];
  for (const [filename, bytes] of fixtures) {
    const file = path.join(root, filename);
    await fs.writeFile(file, bytes);
    const documents = await parseDocument(
      { filename, options: { absolutePath: file } },
      { storageRoot: root }
    );
    if (filename.endsWith(".pptx"))
      assert.match(
        documents[0].pageContent,
        /第一页[\s\S]*第二页[\s\S]*第二页备注[\s\S]*第十页/
      );
    else assert.match(documents[0].pageContent, /标题[\s\S]*正文/);
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.equal(documents[0].metadata.format, path.extname(filename).slice(1));
    assert.doesNotMatch(
      JSON.stringify(documents),
      /knowledge-parser-|absolutePath|file:\/\//
    );
  }
  assert.equal((await fs.readdir(root)).length, fixtures.length);
});

test("Office parsing failures expose no paths and leave the original untouched", async (t) => {
  const { root } = await workspace(t);
  for (const extension of ["pptx", "odt", "odp"]) {
    const file = path.join(root, `broken.${extension}`);
    const bytes = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    await fs.writeFile(file, bytes);
    await assert.rejects(
      parseDocument(
        { filename: path.basename(file), options: { absolutePath: file } },
        { storageRoot: root }
      ),
      (error) => error.status === 422 && !error.message.includes(root)
    );
    assert.deepEqual(await fs.readFile(file), bytes);
  }
});

test("empty parser output, unsupported formats and corrupt DOCX report safe failures", async (t) => {
  t.mock.method(
    require("../utils/OCRLoader").prototype,
    "ocrPDF",
    async () => []
  );
  const { root } = await workspace(t);
  const empty = path.join(root, "scan.pdf"),
    audio = path.join(root, "audio.bin"),
    broken = path.join(root, "broken.docx");
  await Promise.all([
    fs.writeFile(empty, pdf("")),
    fs.writeFile(audio, "fake-audio"),
    fs.writeFile(broken, "not-a-docx"),
  ]);
  const parse = (file) =>
    parseDocument(
      { filename: path.basename(file), options: { absolutePath: file } },
      { storageRoot: root }
    );
  await assert.rejects(parse(empty), /没有可提取的文字/);
  await assert.rejects(parse(audio), /无法解析 BIN/);
  await assert.rejects(parse(broken), /无法解析 DOCX.*损坏.*密码/);
});

test("unexpected parser internals never appear in an HTTP failure", async (t) => {
  const app = createCollectorApp({
    verifySignature: () => true,
    parseDocument: async () => {
      throw new Error("ENOENT D:/private/tenant-secret/file.pdf token=secret");
    },
  });
  const listener = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(
    () =>
      new Promise((resolve) => {
        listener.close(resolve);
        listener.closeAllConnections();
      })
  );
  const response = await fetch(
    `http://127.0.0.1:${listener.address().port}/parse`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-integrity": "signed" },
      body: JSON.stringify({ filename: "broken.pdf" }),
    }
  );
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.equal(result.reason, "无法提取文档正文，请检查文件或稍后重试");
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|tenant-secret|token|secret|ENOENT/
  );
});

test("path validation rejects external files, traversal and links leaving the storage root", async (t) => {
  const { directory, root } = await workspace(t),
    outside = path.join(directory, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "external.pdf"), pdf("external"));
  const parse = (input) =>
    parseDocument(
      { filename: "policy.pdf", options: { absolutePath: input } },
      { storageRoot: root }
    );
  await assert.rejects(parse(path.join(outside, "external.pdf")), /存储范围/);
  await assert.rejects(
    parse(path.join(root, "..", "outside", "external.pdf")),
    /存储范围/
  );
  await assert.rejects(parse("relative.pdf"), /绝对路径/);
  await fs.symlink(
    outside,
    path.join(root, "link"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await assert.rejects(
    parse(path.join(root, "link", "external.pdf")),
    /链接访问外部/
  );
});

test("HTTP parsing requires exact signed bytes and exposes only supported service routes", async (t) => {
  const { root } = await workspace(t),
    file = path.join(root, "http.docx");
  await fs.writeFile(file, docx("HTTP签名解析验证"));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const app = createCollectorApp({
    verifySignature: (signature, body) =>
      crypto.verify(
        "RSA-SHA256",
        Buffer.from(body),
        publicKey,
        Buffer.from(signature, "hex")
      ),
    parseDocument: (payload) => parseDocument(payload, { storageRoot: root }),
  });
  const listener = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  t.after(
    () =>
      new Promise((resolve) => {
        listener.close(resolve);
        listener.closeAllConnections();
      })
  );
  const url = `http://127.0.0.1:${listener.address().port}`;
  const body = JSON.stringify({
    filename: "http.docx",
    options: { absolutePath: file },
  });
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(body), privateKey)
    .toString("hex");
  const request = (payload, signed) =>
    fetch(`${url}/parse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signed ? { "X-Integrity": signed } : {}),
      },
      body: payload,
    });
  assert.equal((await request(body)).status, 401);
  assert.equal((await request(body + " ", signature)).status, 401);
  const response = await request(body, signature);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.documents[0].pageContent, "HTTP签名解析验证");
  for (const route of ["/", "/health"]) {
    const health = await fetch(url + route);
    assert.equal(health.status, 200, route);
    assert.deepEqual(await health.json(), {
      status: "ok",
      service: "document-parser",
    });
  }
  assert.equal((await fetch(`${url}/unknown`)).status, 404);
  const types = await (await fetch(`${url}/accepts`)).json();
  assert.deepEqual(
    Object.values(types).flat().sort(),
    Object.values(ACCEPTED_MIMES).flat().sort()
  );
  for (const route of ["/process", "/process-link", "/extensions", "/resync"]) {
    assert.equal(
      (await fetch(url + route, { method: "POST" })).status,
      404,
      route
    );
  }
});
