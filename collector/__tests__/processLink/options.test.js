/* eslint-env jest, node */
process.env.STORAGE_DIR = "test-storage"; // needed for tests to run
jest.mock("../../processSingleFile", () => ({ processSingleFile: jest.fn() }));
jest.mock("../../utils/downloadURIToFile", () => ({
  downloadURIToFile: jest.fn(async () => ({
    success: true,
    fileLocation: "/tmp/talk.mp3",
  })),
}));
jest.mock("../../utils/extensions/YoutubeTranscript", () => ({}));
jest.mock("langchain/document_loaders/web/puppeteer", () => ({}));

const { processSingleFile } = require("../../processSingleFile");
const { processLink, getLinkText } = require("../../processLink");

afterEach(() => {
  jest.restoreAllMocks();
  processSingleFile.mockReset();
});

it.each([
  ["processLink", false],
  ["getLinkText", true],
])(
  "%s preserves file conversion settings and its storage mode",
  async (operation, parseOnly) => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      headers: { get: () => "audio/mpeg" },
    });
    const options = {
      whisperProvider: "generic-openai",
      WhisperModelPref: "fixture-model",
      WhisperGenericOpenAiApiKey: "dummy-key",
      ocr: { langList: "deu" },
      parseOnly: !parseOnly,
    };
    processSingleFile.mockResolvedValue({
      success: true,
      documents: [{ pageContent: "fixture transcript" }],
    });
    const result =
      operation === "processLink"
        ? await processLink("https://example.com/talk.mp3", {}, {}, options)
        : await getLinkText("https://example.com/talk.mp3", "text", options);
    expect(processSingleFile).toHaveBeenCalledWith(
      "talk.mp3",
      { ...options, parseOnly },
      {}
    );
    expect(result).toMatchObject({ success: true });
    if (parseOnly) expect(result.content).toBe("fixture transcript");
  }
);
