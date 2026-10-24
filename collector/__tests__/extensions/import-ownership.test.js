const fs = require("fs");
const os = require("os");
const path = require("path");
const mockDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "collector-import-")
);
const previousStorage = process.env.STORAGE_DIR,
  previousEnvironment = process.env.NODE_ENV;
process.env.STORAGE_DIR = mockDirectory;
process.env.NODE_ENV = "production";

function mockRepo() {
  return {
    ready: true,
    repo: "https://example.com/team/project",
    author: "team",
    project: "project",
    branch: "main",
    init: async () => {},
    recursiveLoader: async () => [
      { pageContent: "Repository body", metadata: { source: "README.md" } },
    ],
  };
}
jest.mock("../../utils/extensions/RepoLoader/GithubRepo/RepoLoader", () =>
  jest.fn(mockRepo)
);
jest.mock("../../utils/extensions/RepoLoader/GitlabRepo/RepoLoader", () =>
  jest.fn(mockRepo)
);
jest.mock("../../utils/extensions/RepoLoader/GiteaRepo/RepoLoader", () =>
  jest.fn(mockRepo)
);
jest.mock("../../utils/extensions/Confluence/ConfluenceLoader", () => ({
  ConfluencePagesLoader: jest.fn(() => ({
    load: async () => [
      {
        pageContent: "Confluence body",
        metadata: { url: "https://example.com/page", title: "Confluence page" },
      },
    ],
  })),
}));
jest.mock("../../utils/extensions/PaperlessNgx/PaperlessNgxLoader", () =>
  jest.fn(() => ({
    baseUrl: "https://example.com",
    load: async () => [
      {
        pageContent: "Paperless body",
        metadata: {
          url: "https://example.com/doc",
          title: "Paperless document",
        },
      },
    ],
  }))
);
jest.mock("langchain/document_loaders/web/puppeteer", () => ({
  PuppeteerWebBaseLoader: jest.fn(() => ({
    load: async () => [{ pageContent: "<p>Website body</p>" }],
  })),
}));
const response = {
  locals: {
    returnDocuments: true,
    encryptionWorker: { encrypt: () => "encrypted-test-payload" },
  },
};
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  fs.rmSync(mockDirectory, { recursive: true, force: true });
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  if (previousEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnvironment;
});
function assertUnpublished(result, body) {
  expect(result.success).toBe(true);
  expect(result.documents).toHaveLength(1);
  expect(result.documents[0].pageContent).toContain(body);
  expect(result.documents[0]).not.toHaveProperty("location");
  expect(fs.existsSync(path.join(mockDirectory, "documents"))).toBe(false);
}
test.each([
  ["GithubRepo", "loadGithubRepo"],
  ["GitlabRepo", "loadGitlabRepo"],
  ["GiteaRepo", "loadGiteaRepo"],
])(
  "%s retains its original metadata but returns content to the authorized publisher",
  async (folder, method) => {
    const result = await require(`../../utils/extensions/RepoLoader/${folder}`)[
      method
    ]({}, response);
    assertUnpublished(result, "Repository body");
    expect(result.documents[0].chunkSource).toContain("encrypted-test-payload");
  }
);
test("Confluence and Paperless retain source metadata without global files", async () => {
  const confluence =
    await require("../../utils/extensions/Confluence").loadConfluence(
      {
        baseUrl: "https://example.com",
        spaceKey: "space",
        username: "user",
        accessToken: "test-token",
      },
      response
    );
  assertUnpublished(confluence, "Confluence body");
  const paperless =
    await require("../../utils/extensions/PaperlessNgx").loadPaperlessNgx(
      { baseUrl: "https://example.com", apiToken: "test-token" },
      response
    );
  assertUnpublished(paperless, "Paperless body");
});
test("Obsidian parse-only mode retains original fields and returns all readable notes", async () => {
  const result =
    await require("../../utils/extensions/ObsidianVault").loadObsidianVault(
      {
        files: [
          { name: "Note.md", path: "Vault/Note.md", content: "Private note" },
          { name: "Empty.md", path: "Vault/Empty.md", content: " " },
        ],
      },
      { returnDocuments: true }
    );
  assertUnpublished(result, "Private note");
  expect(result.data.processed).toBe(1);
});
test("Drupal returns pages through the same mode, without creating its original global destination", async () => {
  const {
    DrupalWiki,
  } = require("../../utils/extensions/DrupalWiki/DrupalWiki");
  jest
    .spyOn(DrupalWiki.prototype, "_doFetch")
    .mockImplementation(async (url) => {
      if (url.includes("/attachment?")) return { content: [] };
      if (url.includes("/page?")) return { content: [{ id: 1 }], last: true };
      return {
        id: 1,
        title: "Drupal page",
        body: "<p>Drupal body</p>",
        lastModified: "2026-10-23",
        type: "page",
      };
    });
  const result =
    await require("../../utils/extensions/DrupalWiki").loadAndStoreSpaces(
      {
        baseUrl: "https://example.com",
        spaceIds: "1",
        accessToken: "test-token",
      },
      response
    );
  assertUnpublished(result, "Drupal body");
});
test("WebsiteDepth keeps its original scraping result while suppressing all destination writes", async () => {
  const documents = await require("../../utils/extensions/WebsiteDepth")(
    "https://example.com",
    0,
    1,
    { returnDocuments: true }
  );
  expect(documents).toHaveLength(1);
  expect(documents[0].pageContent).toContain("Website body");
  expect(documents[0].chunkSource).toBe("link://https://example.com/");
  expect(fs.existsSync(path.join(mockDirectory, "documents"))).toBe(false);
});
