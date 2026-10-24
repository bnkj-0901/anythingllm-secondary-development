const fs = require("fs");
const os = require("os");
const path = require("path");
const { v5: uuidv5 } = require("uuid");

jest.mock("../../models/documents", () => ({ Document: {} }));
jest.mock("../../models/documentSyncQueue", () => ({ DocumentSyncQueue: {} }));

const cache = require("../../enterprise/vector-cache");
const scope = { tenantId: "tenant-a", documentId: "document-a" };
const identity = "embedding-a:1";
const chunks = ["first text", "second text"];
const vectors = [
  [1, 0, 0],
  [0, 1, 0],
];
let directory, previousStorage, files;

beforeAll(() => {
  previousStorage = process.env.STORAGE_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ep-vector-cache-"));
  process.env.STORAGE_DIR = directory;
  files = require("../../utils/files");
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  if (previousStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = previousStorage;
  fs.rmSync(directory, { recursive: true, force: true });
});

function filename(target = scope) {
  const key = JSON.stringify(["knowledge", target.tenantId, target.documentId]);
  return path.join(
    directory,
    "vector-cache",
    `${uuidv5(key, uuidv5.URL)}.json`
  );
}

test("uses the original persistent cache after all published index rows disappear", async () => {
  expect(
    await cache.storeVectorResult({ ...scope, identity, chunks, vectors })
  ).toBe(true);
  expect(fs.existsSync(filename())).toBe(true);
  const backend = { fetch: jest.fn() };
  expect(
    await cache.cachedVectorInformation({
      ...scope,
      identity,
      chunks,
      rows: [],
      backend,
    })
  ).toEqual(vectors);
  expect(backend.fetch).not.toHaveBeenCalled();
});

test.each([
  [{ tenantId: "tenant-b" }, identity],
  [{ documentId: "document-b" }, identity],
  [{}, "embedding-a:2"],
])(
  "isolates tenant, document and embedding identity (%j, %s)",
  async (overrides, embeddingId) => {
    await cache.storeVectorResult({ ...scope, identity, chunks, vectors });
    expect(
      await cache.cachedVectorInformation({
        ...scope,
        ...overrides,
        identity: embeddingId,
        chunks,
      })
    ).toEqual([null, null]);
  }
);

test("matches exact chunk text and fills missing entries from verified published records", async () => {
  await cache.storeVectorResult({
    ...scope,
    identity,
    chunks: [chunks[0]],
    vectors: [vectors[0]],
  });
  const row = {
    id: "chunk-b",
    ...scope,
    embeddingId: identity,
    namespace: "namespace",
    content: chunks[1],
    dimensions: 3,
    version: 1,
  };
  const backend = {
    fetch: jest.fn(async () => [
      { ...row, text: chunks[1], vector: vectors[1] },
    ]),
  };
  expect(
    await cache.cachedVectorInformation({
      ...scope,
      identity,
      chunks: [...chunks, "changed text"],
      rows: [row],
      backend,
    })
  ).toEqual([...vectors, null]);
  expect(backend.fetch).toHaveBeenCalledTimes(1);
});

test("ignores corrupt cache files and mismatched or invalid cached entries", async () => {
  fs.writeFileSync(filename(), "{broken");
  expect(
    await cache.cachedVectorInformation({ ...scope, identity, chunks })
  ).toEqual([null, null]);
  fs.writeFileSync(
    filename(),
    JSON.stringify([
      { text: chunks[0], embeddingId: identity, vector: [0, 0, 0] },
      { text: chunks[1], embeddingId: "another", vector: vectors[1] },
    ])
  );
  expect(
    await cache.cachedVectorInformation({ ...scope, identity, chunks })
  ).toEqual([null, null]);
});

test("does not trust fetched records with different ownership or invalid vectors", async () => {
  await cache.purgeVectorCache(scope);
  const row = {
    id: "chunk",
    ...scope,
    embeddingId: identity,
    namespace: "namespace",
    content: chunks[0],
    dimensions: 3,
    version: 1,
  };
  for (const changes of [
    { tenantId: "other" },
    { documentId: "other" },
    { embeddingId: "other" },
    { version: 2 },
    { text: "other" },
    { vector: [0, 0, 0] },
    { vector: [1, 0] },
    { vector: [1, Infinity, 0] },
  ]) {
    const backend = {
      fetch: async () => [
        { ...row, text: chunks[0], vector: vectors[0], ...changes },
      ],
    };
    expect(
      await cache.cachedVectorInformation({
        ...scope,
        identity,
        chunks: [chunks[0]],
        rows: [row],
        backend,
      })
    ).toEqual([null]);
  }
});

test("purges only the deleted document through the original helper", async () => {
  await cache.storeVectorResult({ ...scope, identity, chunks, vectors });
  const other = { ...scope, tenantId: "tenant-b" };
  await cache.storeVectorResult({ ...other, identity, chunks, vectors });
  expect(await cache.purgeVectorCache(scope)).toBe(true);
  expect(fs.existsSync(filename())).toBe(false);
  expect(fs.existsSync(filename(other))).toBe(true);
});

test("optional cache IO failures and invalid vectors do not undo successful publication", async () => {
  jest
    .spyOn(files, "storeVectorResult")
    .mockRejectedValue(new Error("unavailable"));
  expect(
    await cache.storeVectorResult({ ...scope, identity, chunks, vectors })
  ).toBe(false);
  expect(
    await cache.storeVectorResult({
      ...scope,
      identity,
      chunks,
      vectors: [[1, 0], [1]],
    })
  ).toBe(false);
  expect(
    await cache.storeVectorResult({
      ...scope,
      identity,
      chunks,
      vectors: [
        [0, 0],
        [1, 0],
      ],
    })
  ).toBe(false);
  jest
    .spyOn(files, "purgeVectorCache")
    .mockRejectedValue(new Error("unavailable"));
  expect(await cache.purgeVectorCache(scope)).toBe(false);
});
