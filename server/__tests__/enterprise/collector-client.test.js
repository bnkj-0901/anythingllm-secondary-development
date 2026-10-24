jest.mock("../../utils/comKey", () => ({
  CommunicationKey: class {
    sign = jest.fn(() => "test-signature");
    encrypt = jest.fn(() => "test-encrypted-payload");
  },
}));
jest.mock("../../utils/EncryptionManager", () => ({
  EncryptionManager: class {
    xPayload = "test-encryption-payload";
  },
}));

const { CollectorApi } = require("../../utils/collectorApi");
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test("an empty filename does not call the Collector", async () => {
  global.fetch = jest.fn();
  await expect(new CollectorApi().parseDocument()).resolves.toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
});

test("successful responses retain the original parse and signature contract", async () => {
  const collector = new CollectorApi();
  const parsed = {
    success: true,
    reason: null,
    documents: [{ pageContent: "正文" }],
  };
  global.fetch = jest.fn(async () => new Response(JSON.stringify(parsed)));

  await expect(
    collector.parseDocument("file.docx", { absolutePath: "/test/file.docx" })
  ).resolves.toEqual(parsed);

  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe(`${collector.endpoint}/parse`);
  expect(JSON.parse(options.body)).toMatchObject({
    filename: "file.docx",
    options: { absolutePath: "/test/file.docx" },
  });
  expect(collector.comkey.sign).toHaveBeenCalledWith(options.body);
  expect(collector.comkey.encrypt).toHaveBeenCalledWith(
    "test-encryption-payload"
  );
  expect(options.headers).toEqual({
    "Content-Type": "application/json",
    "X-Integrity": "test-signature",
    "X-Payload-Signer": "test-encrypted-payload",
  });
});

test("the original Collector client forwards OCR, transcription and runtime options", async () => {
  const values = {
    TARGET_OCR_LANG: "chi_sim,eng",
    WHISPER_PROVIDER: "generic-openai",
    WHISPER_GENERIC_OPEN_AI_MODEL: "configured-transcription",
    COLLECTOR_ALLOW_ANY_IP: "false",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, values);
  try {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ success: true, documents: [] }))
    );
    await new CollectorApi().parseDocument("scan.pdf", {
      absolutePath: "/test/scan.pdf",
    });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({
      filename: "scan.pdf",
      options: {
        absolutePath: "/test/scan.pdf",
        ocr: { langList: "chi_sim,eng" },
        whisperProvider: "generic-openai",
        WhisperGenericOpenAiModel: "configured-transcription",
        runtimeSettings: { allowAnyIp: "false" },
      },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("HTTP failures use the original failed parse response", async () => {
  const collector = new CollectorApi();
  jest.spyOn(collector, "log").mockImplementation(() => {});
  global.fetch = jest.fn(
    async () => new Response("unavailable", { status: 503 })
  );

  await expect(collector.parseDocument("file.pdf")).resolves.toEqual({
    success: false,
    reason: "Response could not be completed",
    documents: [],
  });
  expect(collector.log).toHaveBeenCalledWith("Response could not be completed");
});

test("transport failures preserve the original error contract without retrying", async () => {
  const collector = new CollectorApi();
  jest.spyOn(collector, "log").mockImplementation(() => {});
  const error = Object.assign(new Error("fetch failed"), {
    cause: { code: "ECONNREFUSED" },
  });
  global.fetch = jest.fn().mockRejectedValue(error);

  await expect(collector.parseDocument("file.pdf")).resolves.toEqual({
    success: false,
    reason: "fetch failed",
    documents: [],
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(collector.log).toHaveBeenCalledWith(error.message);
});
