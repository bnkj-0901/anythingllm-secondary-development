/* eslint-env jest, node */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const mockDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "collector-tools-")
);
const mockHotdir = path.join(mockDirectory, "hotdir");
fs.mkdirSync(mockHotdir);
process.env.STORAGE_DIR = mockDirectory;
const originalEnvironment = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
fs.mkdirSync(path.join(mockDirectory, "comkey"));
fs.writeFileSync(
  path.join(mockDirectory, "comkey/ipc-pub.pem"),
  keys.publicKey.export({ type: "spki", format: "pem" })
);

jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../utils/constants", () => ({
  ...jest.requireActual("../../utils/constants"),
  WATCH_DIRECTORY: mockHotdir,
}));
jest.mock("../../processSingleFile", () => ({ processSingleFile: jest.fn() }));
jest.mock("../../utils/downloadURIToFile", () => ({
  downloadURIToFile: jest.fn(),
}));
jest.mock("../../utils/extensions/YoutubeTranscript", () => ({
  loadYouTubeTranscript: jest.fn(),
}));
jest.mock("../../utils/extensions/RepoLoader", () => ({
  resolveRepoLoader: jest.fn(),
  resolveRepoLoaderFunction: jest.fn(),
}));
jest.mock("../../utils/extensions/WebsiteDepth", () => jest.fn());
jest.mock("langchain/document_loaders/web/puppeteer", () => ({}));

const { createCollectorApp } = require("../../app");
const { processSingleFile } = require("../../processSingleFile");
const { downloadURIToFile } = require("../../utils/downloadURIToFile");
const { FFMPEGWrapper } = require("../../utils/WhisperProviders/ffmpeg");
const RuntimeSettings = require("../../utils/runtimeSettings");
const {
  loadYouTubeTranscript,
} = require("../../utils/extensions/YoutubeTranscript");
const { resolveRepoLoader } = require("../../utils/extensions/RepoLoader");
const websiteDepth = require("../../utils/extensions/WebsiteDepth");
const originalFetch = global.fetch;
let listener;
let endpoint;

beforeAll(async () => {
  const app = createCollectorApp({
    parseDocument: async () => [{ pageContent: "正文" }],
  });
  listener = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  endpoint = `http://127.0.0.1:${listener.address().port}`;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  processSingleFile.mockReset();
  downloadURIToFile.mockReset();
  loadYouTubeTranscript.mockReset();
  resolveRepoLoader.mockReset();
  websiteDepth.mockReset();
  new RuntimeSettings().settings = {};
});

afterAll(async () => {
  await new Promise((resolve) => {
    listener.close(resolve);
    listener.closeAllConnections();
  });
  fs.rmSync(mockDirectory, { recursive: true, force: true });
  if (originalEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnvironment;
});

function signedRequest(
  route,
  payload,
  { mode = "valid", type = "application/json" } = {}
) {
  // Whitespace makes reserialization observably different from the signed body.
  const body = JSON.stringify(payload, null, 2) + "\n";
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(body), keys.privateKey)
    .toString("hex");
  return originalFetch(endpoint + route, {
    method: "POST",
    headers: {
      "Content-Type": type,
      ...(mode === "missing" ? {} : { "X-Integrity": signature }),
    },
    body: mode === "tampered" ? body + " " : body,
  });
}

test.each(["/util/get-link", "/util/convert-audio-to-wav"])(
  "%s uses the original signature middleware before applying runtime options",
  async (route) => {
    const payload = { options: { runtimeSettings: { allowAnyIp: "true" } } };
    for (const mode of ["missing", "tampered"]) {
      const response = await signedRequest(route, payload, { mode });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        msg: "Failed integrity signature check.",
      });
      expect(new RuntimeSettings().get("allowAnyIp")).toBe(false);
    }
    expect(processSingleFile).not.toHaveBeenCalled();
  }
);

test.each(["application/json", "text/plain"])(
  "get-link accepts %s raw signed JSON and preserves original converter/runtime options",
  async (type) => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(null, { headers: { "Content-Type": "audio/mpeg" } })
      );
    downloadURIToFile.mockResolvedValue({
      success: true,
      fileLocation: path.join(mockHotdir, "talk.mp3"),
    });
    processSingleFile.mockResolvedValue({
      success: true,
      documents: [
        { pageContent: "first page" },
        { pageContent: "second page" },
      ],
    });
    const options = {
      whisperProvider: "generic-openai",
      WhisperGenericOpenAiApiKey: "dummy-test-key",
      ocr: { langList: "chi_sim,eng" },
      runtimeSettings: {
        allowAnyIp: "true",
        browserLaunchArgs: "--no-sandbox, --disable-gpu",
      },
    };
    const link = "https://example.com/talk.mp3";
    const response = await signedRequest(
      "/util/get-link",
      { link, options },
      { type }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: link,
      success: true,
      content: "first page\n\nsecond page",
    });
    expect(processSingleFile).toHaveBeenCalledWith(
      "talk.mp3",
      { ...options, parseOnly: true },
      {}
    );
    expect(new RuntimeSettings().get("allowAnyIp")).toBe(true);
    expect(new RuntimeSettings().get("browserLaunchArgs")).toEqual([
      "--no-sandbox",
      "--disable-gpu",
    ]);
    expect(fs.existsSync(path.join(mockDirectory, "documents"))).toBe(false);
  }
);

test("get-link retains invalid-link and unexpected extraction failure responses", async () => {
  const invalid = await signedRequest("/util/get-link", {
    link: "file:///private",
  });
  expect(await invalid.json()).toEqual({
    url: "file:///private",
    success: false,
    content: null,
  });
  expect(processSingleFile).not.toHaveBeenCalled();
  jest
    .spyOn(global, "fetch")
    .mockResolvedValue(
      new Response(null, { headers: { "Content-Type": "audio/mpeg" } })
    );
  downloadURIToFile.mockResolvedValue({
    success: true,
    fileLocation: path.join(mockHotdir, "talk.mp3"),
  });
  processSingleFile.mockRejectedValue(new Error("fixture extraction failure"));
  jest.spyOn(console, "error").mockImplementation(() => {});
  const link = "https://example.com/talk.mp3";
  const failed = await signedRequest("/util/get-link", { link });
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({
    url: link,
    success: false,
    content: null,
  });
});

test.each(["application/json", "text/plain"])(
  "audio conversion accepts %s through the original converter and retains its cleanup contract",
  async (type) => {
    const filename = "recording.mp3";
    const source = path.join(mockHotdir, filename);
    fs.writeFileSync(source, "fixture audio");
    const convert = jest
      .spyOn(FFMPEGWrapper.prototype, "convertAudioToWav")
      .mockImplementation(async (_input, output) =>
        fs.writeFileSync(output, "wav")
      );
    const response = await signedRequest(
      "/util/convert-audio-to-wav",
      { filename },
      { type }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      filename,
      success: true,
      reason: null,
      wavFilename: "recording.wav",
    });
    expect(convert).toHaveBeenCalledWith(
      source,
      path.join(mockHotdir, "recording.wav")
    );
    expect(fs.existsSync(source)).toBe(false);
    expect(
      fs.readFileSync(path.join(mockHotdir, "recording.wav"), "utf8")
    ).toBe("wav");
  }
);

test("audio conversion retains path rejection and converter failure responses", async () => {
  const convert = jest
    .spyOn(FFMPEGWrapper.prototype, "convertAudioToWav")
    .mockRejectedValue(new Error("fixture conversion failed"));
  const rejected = await signedRequest("/util/convert-audio-to-wav", {
    filename: "../external.mp3",
  });
  expect(await rejected.json()).toEqual({
    filename: "../external.mp3",
    success: false,
    reason: "Filename is outside the hotdir.",
    wavFilename: null,
  });
  expect(convert).not.toHaveBeenCalled();
  const filename = "broken.mp3";
  const source = path.join(mockHotdir, filename);
  fs.writeFileSync(source, "fixture audio");
  jest.spyOn(console, "error").mockImplementation(() => {});
  const failed = await signedRequest("/util/convert-audio-to-wav", {
    filename,
  });
  expect(failed.status).toBe(200);
  expect(await failed.json()).toEqual({
    filename,
    success: false,
    reason: "fixture conversion failed",
    wavFilename: null,
  });
  expect(fs.existsSync(source)).toBe(false);
});

test("restoring original tools preserves health, accepted formats and the separate signed parser", async () => {
  for (const route of ["/", "/health"]) {
    const response = await originalFetch(endpoint + route);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "document-parser",
    });
  }
  expect((await originalFetch(endpoint + "/accepts")).status).toBe(200);
  const parsed = await signedRequest("/parse", {
    filename: "policy.txt",
    options: { absolutePath: "/authorized/policy.txt" },
  });
  expect(parsed.status).toBe(200);
  expect(await parsed.json()).toEqual({
    filename: "policy.txt",
    success: true,
    reason: null,
    documents: [{ pageContent: "正文" }],
  });
  expect((await signedRequest("/parse", {}, { mode: "missing" })).status).toBe(
    401
  );
  for (const route of ["/process", "/process-link", "/extensions"]) {
    expect((await signedRequest(route, {})).status).toBe(404);
  }
});

test("browser text uses the original extractor without writing to the global file pool", async () => {
  const result = await signedRequest("/process-raw-text", {
    textContent: "Captured text",
    metadata: { title: "Web page", chunkSource: "link://https://example.com" },
  });
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body.documents[0]).toMatchObject({
    pageContent: "Captured text",
    chunkSource: "link://https://example.com",
  });
  expect(body.documents[0]).not.toHaveProperty("location");
  expect(
    (await signedRequest("/process-raw-text", {}, { mode: "missing" })).status
  ).toBe(401);
});

test("watched link refresh uses the original resync engine behind a signed request", async () => {
  jest
    .spyOn(global, "fetch")
    .mockResolvedValue(
      new Response(null, { headers: { "Content-Type": "audio/mpeg" } })
    );
  downloadURIToFile.mockResolvedValue({
    success: true,
    fileLocation: path.join(mockHotdir, "watched.mp3"),
  });
  processSingleFile.mockResolvedValue({
    success: true,
    documents: [{ pageContent: "Updated source text" }],
  });
  const synced = await signedRequest("/ext/resync-source-document", {
    type: "link",
    options: { link: "https://example.com/watched.mp3" },
  });
  expect(await synced.json()).toEqual({
    success: true,
    content: "Updated source text",
  });
  expect(processSingleFile).toHaveBeenCalledWith(
    "watched.mp3",
    { parseOnly: true },
    {}
  );
  const response = await signedRequest("/ext/resync-source-document", {
    type: "unknown",
    options: {},
  });
  expect(response.status).toBe(400);
  expect(
    (
      await signedRequest(
        "/ext/resync-source-document",
        { type: "link", options: { link: "https://example.com" } },
        { mode: "missing" }
      )
    ).status
  ).toBe(401);
});

test.each([
  "/ext/github-repo/branches",
  "/ext/website-depth",
  "/ext/youtube-transcript",
  "/ext/import",
])(
  "%s verifies original raw signatures before invoking extraction engines",
  async (route) => {
    for (const mode of ["missing", "tampered"]) {
      const response = await signedRequest(
        route,
        { url: "https://example.com" },
        { mode }
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        msg: "Failed integrity signature check.",
      });
    }
    expect(resolveRepoLoader).not.toHaveBeenCalled();
    expect(websiteDepth).not.toHaveBeenCalled();
    expect(loadYouTubeTranscript).not.toHaveBeenCalled();
  }
);

test("repository branch discovery preserves the original loader and return contract", async () => {
  const getRepoBranches = jest.fn().mockResolvedValue(["main", "release"]);
  const constructor = jest.fn(function () {
    this.getRepoBranches = getRepoBranches;
  });
  resolveRepoLoader.mockReturnValue(constructor);
  const payload = { repo: "org/project", accessToken: "test-token" };
  const result = await signedRequest("/ext/github-repo/branches", payload, {
    type: "text/plain",
  });
  expect(await result.json()).toEqual({
    success: true,
    reason: null,
    data: { branches: ["main", "release"] },
  });
  expect(resolveRepoLoader).toHaveBeenCalledWith("github");
  expect(constructor).toHaveBeenCalledWith(payload);
  expect(getRepoBranches).toHaveBeenCalledTimes(1);
});

test("website discovery preserves depth and limits without publishing extracted knowledge", async () => {
  websiteDepth.mockResolvedValue(["https://example.com/about"]);
  const result = await signedRequest("/ext/website-depth", {
    url: "https://example.com",
    depth: 2,
    maxLinks: 7,
  });
  expect(await result.json()).toEqual({
    success: true,
    data: ["https://example.com/about"],
  });
  expect(websiteDepth).toHaveBeenCalledWith("https://example.com", 2, 7, {
    returnDocuments: true,
  });
  expect(fs.existsSync(path.join(mockDirectory, "documents"))).toBe(false);
});

test("YouTube extraction forces parse-only and never writes to the old global document pool", async () => {
  const result = {
    success: true,
    reason: null,
    content: "Transcript",
    documents: [],
    saveAsDocument: true,
    data: {},
  };
  loadYouTubeTranscript.mockResolvedValue(result);
  const payload = {
    url: "https://www.youtube.com/watch?v=fixture",
    parseOnly: false,
  };
  const response = await signedRequest("/ext/youtube-transcript", payload);
  expect(await response.json()).toEqual(result);
  expect(loadYouTubeTranscript).toHaveBeenCalledWith(payload, {
    parseOnly: true,
  });
  expect(fs.existsSync(path.join(mockDirectory, "documents"))).toBe(false);
});

test.each([
  "/ext/github-repo",
  "/ext/confluence",
  "/ext/drupalwiki",
  "/ext/obsidian/vault",
  "/ext/paperless",
])("%s cannot publish into the old global file pool", async (route) => {
  expect((await signedRequest(route, {})).status).toBe(404);
});
