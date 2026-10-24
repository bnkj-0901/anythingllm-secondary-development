const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { zip, pdf, scannedPdf } = require("./fixtures.cjs");

// Every original, model cache and parser artifact in this suite stays in a
// disposable directory. No test uses an existing installation's storage.
const directory = syncFs.mkdtempSync(
  path.join(os.tmpdir(), "collector-formats-")
);
process.env.STORAGE_DIR = directory;
const root = path.join(directory, "enterprise");
syncFs.mkdirSync(root);
after(() => fs.rm(directory, { recursive: true, force: true }));
const { parseDocument } = require("../documentParser");
const { createCollectorApp } = require("../app");
const OCRLoader = require("../utils/OCRLoader");

const epub = zip({
  mimetype: "application/epub+zip",
  "META-INF/container.xml":
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  "OEBPS/content.opf":
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="book"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>费用规则</dc:title><dc:language>zh</dc:language><dc:identifier id="book">rules</dc:identifier></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/></manifest><spine><itemref idref="chapter"/></spine></package>',
  "OEBPS/style.css": "p { color: black; }",
  "OEBPS/chapter.xhtml":
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>费用</title></head><body><h1>费用规则</h1><p>住宿标准为每晚460元，发票须复核。</p></body></html>',
});
const mbox = Buffer.from(
  [
    "From alice@example.com Mon Oct 20 10:00:00 2025",
    "From: Alice <alice@example.com>",
    "To: finance@example.com",
    "Subject: Expense rules",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="fixture-boundary"',
    "",
    "--fixture-boundary",
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(
      '<p>邮件中的差旅标准为460元。</p><script>doNotIndex()</script><img src="tracking.gif">'
    ).toString("base64"),
    "--fixture-boundary",
    'Content-Type: application/octet-stream; name="attachment.bin"',
    'Content-Disposition: attachment; filename="attachment.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    "AAECAw==",
    "--fixture-boundary--",
    "",
  ].join("\r\n")
);

test("EPUB and HTML-only multipart MBOX use the original local extraction engines and preserve originals", async () => {
  for (const [filename, bytes, expected] of [
    ["规则.epub", epub, /住宿标准为每晚460元/],
    ["邮件.mbox", mbox, /邮件中的差旅标准为460元/],
  ]) {
    const original = path.join(root, filename);
    await fs.writeFile(original, bytes);
    const result = await parseDocument({
      filename,
      options: { absolutePath: original },
    });
    assert.match(
      result.map((document) => document.pageContent).join("\n"),
      expected
    );
    assert.doesNotMatch(result[0].pageContent, /doNotIndex|tracking.gif/);
    assert.equal(result[0].metadata.format, path.extname(filename).slice(1));
    assert.ok(result[0].metadata.token_count_estimate > 0);
    assert.deepEqual(await fs.readFile(original), bytes);
  }
  assert.deepEqual(
    (await fs.readdir(root)).sort(),
    ["规则.epub", "邮件.mbox"].sort()
  );
  assert.equal(syncFs.existsSync(path.join(directory, "documents")), false);
});

test("restored EPUB/MBOX parsers remain behind exact signatures and authorized original paths", async (t) => {
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = createCollectorApp({
    verifySignature: (signature, body) =>
      crypto.verify(
        "RSA-SHA256",
        Buffer.from(body),
        keys.publicKey,
        Buffer.from(signature, "hex")
      ),
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
  const url = `http://127.0.0.1:${listener.address().port}/parse`;
  for (const [filename, bytes] of [
    ["签名.epub", epub],
    ["签名.mbox", mbox],
  ]) {
    const original = path.join(root, filename);
    await fs.writeFile(original, bytes);
    const body = JSON.stringify({
      filename,
      options: { absolutePath: original },
    });
    const signature = crypto
      .sign("RSA-SHA256", Buffer.from(body), keys.privateKey)
      .toString("hex");
    assert.equal(
      (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        })
      ).status,
      401
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Integrity": signature },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    assert.deepEqual(await fs.readFile(original), bytes);
  }
  const body = JSON.stringify({
    filename: "external.epub",
    options: { absolutePath: path.join(directory, "external.epub") },
  });
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(body), keys.privateKey)
    .toString("hex");
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Integrity": signature,
        },
        body,
      })
    ).status,
    400
  );
});

test("image and scanned-PDF OCR contracts retain language options, page order and originals", async (t) => {
  const image = path.join(root, "扫描.png"),
    blank = path.join(root, "扫描.pdf");
  const originalImage = Buffer.from("image fixture routed to OCR adapter");
  await fs.writeFile(image, originalImage);
  await fs.writeFile(blank, pdf(""));
  t.mock.method(OCRLoader.prototype, "ocrImage", async function (file) {
    assert.equal(file, image);
    assert.deepEqual(this.language, ["chi_sim", "eng"]);
    assert.equal(this.cacheDir, path.join(directory, "models", "tesseract"));
    return "图片规则460元";
  });
  t.mock.method(OCRLoader.prototype, "ocrPDF", async (file) => {
    assert.equal(file, blank);
    return [
      {
        pageContent: "扫描规则460元",
        metadata: { loc: { pageNumber: 1 }, pdf: { totalPages: 1 } },
      },
    ];
  });
  const imageResult = await parseDocument({
    filename: "扫描.png",
    options: { absolutePath: image, ocr: { langList: "chi_sim,eng" } },
  });
  const pdfResult = await parseDocument({
    filename: "扫描.pdf",
    options: { absolutePath: blank },
  });
  assert.equal(imageResult[0].pageContent, "图片规则460元");
  assert.equal(imageResult[0].metadata.format, "png");
  assert.equal(pdfResult[0].pageContent, "扫描规则460元");
  assert.equal(pdfResult[0].metadata.pageNumber, 1);
  assert.equal(pdfResult[0].metadata.source, undefined);
  assert.deepEqual(await fs.readFile(image), originalImage);
  assert.deepEqual(await fs.readFile(blank), pdf(""));
  assert.equal(
    syncFs.existsSync(path.join(directory, "models")),
    true,
    "the original OCR engine creates its configured cache directory"
  );
});

test("all original audio/video presets use the configured transcription provider and preserve original files", async (t) => {
  const {
    GenericOpenAiWhisper,
  } = require("../utils/WhisperProviders/GenericOpenAiWhisper");
  const { SUPPORTED_FILETYPE_CONVERTERS } = require("../utils/constants");
  const extensions = Object.entries(SUPPORTED_FILETYPE_CONVERTERS)
    .filter(([, converter]) => converter === "./convert/asAudio.js")
    .map(([extension]) => extension);
  assert.deepEqual(extensions, [
    ".mp3",
    ".wav",
    ".mp4",
    ".mpeg",
    ".mov",
    ".ogg",
    ".oga",
    ".opus",
    ".m4a",
    ".webm",
  ]);
  t.mock.method(
    GenericOpenAiWhisper.prototype,
    "processFile",
    async function (file, filename) {
      assert.equal(file, path.join(root, filename));
      assert.equal(this.openai.baseURL, "https://transcription.example/v1");
      assert.equal(this.model, "configured-transcription-model");
      return { content: "会议录音中的住宿标准为460元。", error: null };
    }
  );
  for (const extension of extensions) {
    const filename = `meeting${extension}`,
      original = path.join(root, filename);
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5]);
    await fs.writeFile(original, bytes);
    const result = await parseDocument({
      filename,
      options: {
        absolutePath: original,
        whisperProvider: "generic-openai",
        WhisperGenericOpenAiBaseUrl: "https://transcription.example/v1",
        WhisperGenericOpenAiApiKey: "test-only-transcription-key",
        WhisperGenericOpenAiModel: "configured-transcription-model",
      },
    });
    assert.equal(result[0].pageContent, "会议录音中的住宿标准为460元。");
    assert.equal(result[0].metadata.format, extension.slice(1));
    assert.deepEqual(await fs.readFile(original), bytes);
    assert.doesNotMatch(
      JSON.stringify(result),
      /absolutePath|file:\/\/|test-only-transcription-key/
    );
  }
});

test("original local and OpenAI audio provider options remain available and failures preserve originals", async (t) => {
  const { LocalWhisper } = require("../utils/WhisperProviders/localWhisper");
  const { OpenAiWhisper } = require("../utils/WhisperProviders/OpenAiWhisper");
  t.mock.method(LocalWhisper.prototype, "processFile", async function () {
    assert.equal(this.model, "Xenova/whisper-small");
    return { content: "本地转写内容", error: null };
  });
  t.mock.method(OpenAiWhisper.prototype, "processFile", async function () {
    assert.equal(this.model, "whisper-1");
    assert.equal(this.openai.apiKey, "test-only-openai-key");
    return { content: "", error: "provider failure path=private token=hidden" };
  });
  const original = path.join(root, "providers.wav"),
    bytes = Buffer.from([0, 1, 2, 3]);
  await fs.writeFile(original, bytes);
  const local = await parseDocument({
    filename: "providers.wav",
    options: {
      absolutePath: original,
      whisperProvider: "local",
      WhisperModelPref: "Xenova/whisper-small",
    },
  });
  assert.equal(local[0].pageContent, "本地转写内容");
  await assert.rejects(
    parseDocument({
      filename: "providers.wav",
      options: {
        absolutePath: original,
        whisperProvider: "openai",
        openAiKey: "test-only-openai-key",
      },
    }),
    (error) =>
      error.status === 422 && !/private|hidden|token/.test(error.message)
  );
  assert.deepEqual(await fs.readFile(original), bytes);
});

test(
  "actual English image OCR uses a private model cache and preserves PNG/JPG/JPEG/WebP originals",
  { skip: process.env.OCR_INTEGRATION !== "1", timeout: 180000 },
  async () => {
    const sharp = require("sharp");
    const svg = Buffer.from(
      '<svg width="1100" height="180"><rect width="100%" height="100%" fill="white"/><text x="35" y="115" font-family="Arial" font-size="72" fill="black">COMPANY POLICY 460</text></svg>'
    );
    for (const extension of ["png", "jpg", "jpeg", "webp"]) {
      const image = sharp(svg);
      const bytes = await (extension === "png"
        ? image.png()
        : extension === "webp"
        ? image.webp()
        : image.jpeg()
      ).toBuffer();
      const filename = `actual.${extension}`,
        original = path.join(root, filename);
      await fs.writeFile(original, bytes);
      const result = await parseDocument({
        filename,
        options: { absolutePath: original },
      });
      assert.match(result[0].pageContent, /COMPANY POLICY 460/i);
      assert.deepEqual(await fs.readFile(original), bytes);
    }
    assert.ok(
      (await fs.readdir(path.join(directory, "models", "tesseract"))).some(
        (name) => name.startsWith("eng")
      )
    );
    const raw = await sharp(svg)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bytes = scannedPdf(raw.data, raw.info.width, raw.info.height);
    const filename = "actual-scanned.pdf",
      original = path.join(root, filename);
    await fs.writeFile(original, bytes);
    const result = await parseDocument({
      filename,
      options: { absolutePath: original },
    });
    assert.match(result[0].pageContent, /COMPANY POLICY 460/i);
    assert.equal(result[0].metadata.format, "pdf");
    assert.deepEqual(await fs.readFile(original), bytes);
  }
);
