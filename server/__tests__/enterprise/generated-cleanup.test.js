const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
let mockFixture;
let mockFilesDirectory;
let mockImagesDirectory;
jest.mock("../../utils/prisma", () => new Proxy({}, {
  get: (_target, key) => {
    const value = mockFixture.prisma[key];
    return typeof value === "function" ? value.bind(mockFixture.prisma) : value;
  },
}));
jest.mock("../../utils/agents/aibitat/plugins/create-files/lib", () => ({
  getOutputDirectory: async () => mockFilesDirectory,
}));
jest.mock("../../utils/files", () => ({
  get generatedImagesPath() { return mockImagesDirectory; },
  GENERATED_IMAGE_FILENAME_PATTERN: /^img-[a-f0-9-]{36}\.png$/i,
}));
jest.mock("../../jobs/helpers", () => ({ log: jest.fn(), conclude: jest.fn() }));
const { cleanupGeneratedFiles, getActiveStorageFilenames } = require("../../jobs/cleanup-generated-files");
let cleanupGeneratedImages, referencedImageFilenames;
let tempRoot;
const output = filename => JSON.stringify({ outputs: [{ payload: { storageFilename: filename } }] });
const filename = (type = "pdf") => `${type}-${randomUUID()}.${type === "img" ? "png" : "pdf"}`;
function writeAsset(directory, name, { fresh = false } = {}) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, "isolated generated asset");
  const date = new Date(Date.now() - (fresh ? 1000 : 2 * 60 * 60 * 1000));
  fs.utimesSync(target, date, date);
  return target;
}
async function chat(tenantId, response, include = true) {
  const now = new Date().toISOString();
  return mockFixture.prisma.chats.create({ data: {
    tenantId, userId: tenantId === "a" ? 1 : 2, thread_id: tenantId === "a" ? 1 : 2,
    prompt: "generated output", response, include, createdAt: now, lastUpdatedAt: now,
  } });
}
beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-generated-cleanup-"));
  mockFilesDirectory = path.join(tempRoot, "generated-files");
  mockImagesDirectory = path.join(tempRoot, "generated-images");
  fs.mkdirSync(mockFilesDirectory); fs.mkdirSync(mockImagesDirectory);
  // Images imports its original directory as a constant at worker startup.
  ({ cleanupGeneratedImages, referencedImageFilenames } = require("../../jobs/cleanup-generated-images"));
  mockFixture = await createPostgresFixture();
  const now = new Date().toISOString();
  for (const tenantId of ["a", "b"]) {
    await mockFixture.prisma.ep_tenants.create({ data: { id: tenantId, code: tenantId, name: tenantId, hostname: `${tenantId}.localhost`, createdAt: now, updatedAt: now } });
    await mockFixture.prisma.users.create({ data: { id: tenantId === "a" ? 1 : 2, tenantId, username: "employee", name: "Employee", passwordHash: "unused", createdAt: now, updatedAt: now } });
    await mockFixture.prisma.chat_threads.create({ data: { id: tenantId === "a" ? 1 : 2, tenantId, userId: tenantId === "a" ? 1 : 2, slug: `${tenantId}-thread`, name: "Personal", createdAt: now, lastUpdatedAt: now } });
  }
});
beforeEach(async () => {
  await mockFixture.prisma.chats.deleteMany();
  await mockFixture.prisma.scheduled_jobs.deleteMany();
  for (const directory of [mockFilesDirectory, mockImagesDirectory])
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await mockFixture?.cleanup();
  const resolved = path.resolve(tempRoot);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("anythingllm-generated-cleanup-"))
    throw new Error("Refusing cleanup outside the isolated temporary test directory");
  fs.rmSync(resolved, { recursive: true });
});

test("global cleanup preserves active outputs across tenants and expires hidden history outputs", async () => {
  for (const [directory, type, cleanup] of [[mockFilesDirectory, "pdf", cleanupGeneratedFiles], [mockImagesDirectory, "img", cleanupGeneratedImages]]) {
    const own = filename(type), other = filename(type), orphan = filename(type), fresh = filename(type);
    const ownPath = writeAsset(directory, own), otherPath = writeAsset(directory, other);
    const orphanPath = writeAsset(directory, orphan), freshPath = writeAsset(directory, fresh, { fresh: true });
    await chat("a", output(own), false); await chat("b", output(other));
    await cleanup();
    expect(fs.existsSync(ownPath)).toBe(false); expect(fs.existsSync(otherPath)).toBe(true);
    expect(fs.existsSync(orphanPath)).toBe(false); expect(fs.existsSync(freshPath)).toBe(true);
  }
});

test("completed scheduled outputs remain available while failed-run artifacts expire", async () => {
  const job = await mockFixture.prisma.scheduled_jobs.create({ data: { tenantId: "b", userId: 2, name: "Generated report", prompt: "report", schedule: "0 0 * * *" } });
  for (const [directory, type, cleanup] of [[mockFilesDirectory, "pdf", cleanupGeneratedFiles], [mockImagesDirectory, "img", cleanupGeneratedImages]]) {
    const completed = filename(type), failed = filename(type);
    const completedPath = writeAsset(directory, completed), failedPath = writeAsset(directory, failed);
    await mockFixture.prisma.scheduled_job_runs.createMany({ data: [
      { jobId: job.id, status: "completed", result: output(completed) },
      { jobId: job.id, status: "failed", result: output(failed) },
    ] });
    await cleanup();
    expect(fs.existsSync(completedPath)).toBe(true); expect(fs.existsSync(failedPath)).toBe(false);
  }
});

test("reference scans paginate retained history and tolerate unrelated malformed responses", async () => {
  const retained = Array.from({ length: 53 }, () => filename("img"));
  for (const name of retained) await chat("a", output(name));
  await chat("b", "malformed response"); await chat("b", JSON.stringify({ outputs: [null, { payload: {} }] }));
  const files = await getActiveStorageFilenames(3), images = await referencedImageFilenames();
  expect([...files].sort()).toEqual(retained.sort()); expect([...images].sort()).toEqual(retained.sort());
});

test.each(["chats", "scheduled_job_runs"])("a %s database lookup failure prevents deleting any candidates", async model => {
  const filePath = writeAsset(mockFilesDirectory, filename());
  const imagePath = writeAsset(mockImagesDirectory, filename("img"));
  jest.spyOn(mockFixture.prisma[model], "findMany").mockRejectedValue(new Error("database unavailable"));
  await cleanupGeneratedFiles(); await cleanupGeneratedImages();
  expect(fs.existsSync(filePath)).toBe(true); expect(fs.existsSync(imagePath)).toBe(true);
  expect(console.error).toHaveBeenCalledTimes(2);
});
