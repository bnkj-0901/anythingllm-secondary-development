/* global beforeEach, afterEach, test, expect */
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createVectorDatabase,
  namespaceFor,
} = require("../../utils/vectorDbProviders");
const shared = require("../../utils/vectorDbProviders/shared");
let directory, db, namespace;
const dimensions = 2;
function record(id, extra = {}) {
  return {
    id,
    vector: [0.8, 0.6],
    tenantId: "tenant-a",
    documentId: `doc-${id}`,
    version: 1,
    embeddingId: "embedding:1",
    libraryId: "library",
    text: `Text ${id}`,
    ...extra,
  };
}
function search(records, extra = {}) {
  return {
    namespace,
    vector: [1, 0],
    filter: {
      tenantId: "tenant-a",
      userId: "owner-a",
      documentVersions: records.map(({ documentId, version }) => ({
        documentId,
        version,
      })),
    },
    topK: 1,
    threshold: -1,
    ...extra,
  };
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ep-vector-lance-"));
  db = createVectorDatabase({ config: { path: directory } });
  namespace = namespaceFor({
    tenantId: "tenant-a",
    embeddingId: "embedding:1",
    dimensions,
  });
});
afterEach(() => {
  if (
    directory &&
    path
      .resolve(directory)
      .startsWith(path.resolve(os.tmpdir(), "ep-vector-lance-"))
  )
    fs.rmSync(directory, { recursive: true, force: true });
});
test("LanceDB uses its real native vector search with explicit authorized document-version filtering before topK", async () => {
  const allowed = record("public");
  const mine = record("mine", { vector: [0.9, 0.1], visibility: "private" });
  const other = record("other", {
    vector: [1, 0],
  });
  const stale = record("stale", { vector: [1, 0], version: 1 });
  const cross = record("cross", { vector: [1, 0], tenantId: "tenant-b" });
  // Seed an out-of-scope row directly in the adapter to prove query filtering,
  // independently of the factory's write-side namespace guard.
  const adapter = require("../../utils/vectorDbProviders/records").create(
    "lancedb",
    {
      path: directory,
    }
  );
  await adapter.upsert({
    namespace,
    records: [allowed, mine, other, stale, cross],
  });
  const query = search([allowed, mine, { ...stale, version: 2 }]);
  const found = await db.search(query);
  expect(found).toHaveLength(1);
  expect(found[0].id).toBe("mine");
  expect(found[0].score).toBeGreaterThan(0.9);
  const publicOnly = await db.search({
    ...query,
    filter: {
      documentVersions: [
        { documentId: allowed.documentId, version: allowed.version },
      ],
    },
  });
  expect(publicOnly.map((row) => row.id)).toEqual(["public"]);
  expect(await db.search({ ...query, threshold: 1 })).toEqual([]);
});
test("deterministic namespaces isolate tenant, model identity and dimension without touching upstream workspace tables", async () => {
  const params = {
    tenantId: "tenant-a",
    embeddingId: "embedding:1",
    dimensions,
  };
  expect(namespaceFor(params)).toMatch(/^ep_[a-f0-9]{48}$/);
  expect(namespaceFor(params)).toBe(namespace);
  for (const changed of [
    { tenantId: "tenant-b" },
    { embeddingId: "embedding:2" },
    { dimensions: 3 },
  ])
    expect(namespaceFor({ ...params, ...changed })).not.toBe(namespace);
  const native = await require("@lancedb/lancedb").connect(directory);
  await native.createTable("old_workspace", [
    { id: "untouched", vector: [1, 0] },
  ]);
  await db.upsert({ namespace, records: [record("new")] });
  expect(
    (await (await native.openTable("old_workspace")).query().toArray()).map(
      (row) => row.id
    )
  ).toEqual(["untouched"]);
});
test("real merge upserts remain idempotent under concurrent writes and returned vectors can migrate unchanged", async () => {
  await Promise.all([
    db.upsert({ namespace, records: [record("one")] }),
    db.upsert({ namespace, records: [record("two")] }),
    db.upsert({
      namespace,
      records: [record("one", { text: "Updated", vector: [1, 0] })],
    }),
  ]);
  const rows = await db.fetch({ namespace, ids: ["one", "two", "one"] });
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === "one")).toMatchObject({
    text: "Updated",
    vector: [1, 0],
  });
  const native = await require("@lancedb/lancedb").connect(directory);
  expect(await (await native.openTable(namespace)).countRows()).toBe(2);
  const target = createVectorDatabase({
    provider: "lancedb",
    config: { path: path.join(directory, "copy") },
  });
  await target.upsert({ namespace, records: rows });
  expect(
    (await target.fetch({ namespace, ids: ["one", "two"] })).sort((a, b) =>
      a.id.localeCompare(b.id)
    )
  ).toEqual(rows.sort((a, b) => a.id.localeCompare(b.id)));
});
test("empty namespace, missing IDs and nonexistent spaces are safe; delete only removes the explicit IDs", async () => {
  expect(await db.heartbeat()).toEqual({ ok: true, provider: "lancedb" });
  expect(await db.fetch({ namespace, ids: [] })).toEqual([]);
  expect(await db.fetch({ namespace, ids: ["absent"] })).toEqual([]);
  expect(await db.search(search([record("absent")]))).toEqual([]);
  expect(await db.search({ namespace: "" })).toEqual([]);
  expect(await db.delete({ namespace, ids: [] })).toBe(0);
  expect(await db.upsert({ namespace, records: [] })).toBe(0);
  await db.upsert({ namespace, records: [record("one"), record("two")] });
  expect(await db.delete({ namespace, ids: ["one"] })).toBe(1);
  expect(
    (await db.fetch({ namespace, ids: ["one", "two"] })).map((row) => row.id)
  ).toEqual(["two"]);
  expect(
    await db.search({
      ...search([]),
      filter: { tenantId: "tenant-a", userId: "owner-a", documentVersions: [] },
    })
  ).toEqual([]);
});
test("write and search validation fail closed without accepting mismatched namespaces or incomplete permissions", async () => {
  expect(() => createVectorDatabase({ provider: "unknown" })).toThrow(/不支持/);
  await expect(
    db.upsert({
      namespace,
      records: [record("other", { tenantId: "tenant-b" })],
    })
  ).rejects.toThrow(/不匹配/);
  await expect(
    db.upsert({ namespace: "old_workspace", records: [record("bad")] })
  ).rejects.toThrow(/不匹配/);
  for (const extra of [
    { vector: [0, 0] },
    { vector: [NaN, 1] },
    { version: 0 },
    { text: "" },
    { tenantId: "" },
  ])
    await expect(
      db.upsert({ namespace, records: [record("bad", extra)] })
    ).rejects.toThrow();
  for (const bad of [
    { filter: {} },
    { filter: { tenantId: "tenant-a", userId: "owner-a" } },
    { topK: 0 },
    { topK: Number.MAX_SAFE_INTEGER + 1 },
    { threshold: 2 },
  ])
    expect(() => db.search({ ...search([record("one")]), ...bad })).toThrow();
  expect(() =>
    namespaceFor({ tenantId: "a", embeddingId: "e", dimensions: 0 })
  ).toThrow();
  expect(() => shared.validateRecords(null)).toThrow();
  expect(() => shared.idFilter("all")).toThrow();
});
test("source metadata survives native storage and topK follows the original positive-integer configuration", async () => {
  const source = record("metadata", {
    metadata: {
      title: "Source title",
      url: "https://example.test/source",
      nested: { page: 3 },
      documentId: "untrusted",
    },
  });
  await db.upsert({ namespace, records: [source] });
  const [stored] = await db.fetch({ namespace, ids: [source.id] });
  expect(stored).toMatchObject({ ...source, vector: expect.any(Array) });
  expect(stored.vector[0]).toBeCloseTo(source.vector[0]);
  expect(await db.search(search([source], { topK: 101 }))).toHaveLength(1);
  await db.upsert({
    namespace,
    records: [record("later", { metadata: { title: "Second" } })],
  });
  expect((await db.fetch({ namespace, ids: ["later"] }))[0].metadata).toEqual({
    title: "Second",
  });
});
test("permission filters quote user values and preserve document/version pairs without letting newer documents authorize old vectors", async () => {
  const row = record("quote-id", {
    documentId: "doc'quoted",
  });
  await db.upsert({ namespace, records: [row] });
  expect(
    await db.search({
      ...search([row]),
      filter: {
        tenantId: row.tenantId,
        userId: row.ownerId,
        documentVersions: [{ documentId: row.documentId, version: 2 }],
      },
    })
  ).toEqual([]);
  expect(
    (
      await db.search({
        ...search([row]),
        filter: {
          tenantId: row.tenantId,
          userId: row.ownerId,
          documentVersions: [{ documentId: row.documentId, version: 1 }],
        },
      })
    )[0].id
  ).toBe(row.id);
});

test("native adapter handles its direct boundary safely and recovers simultaneous collection creation", async () => {
  const create = (config) =>
    require("../../utils/vectorDbProviders/records").create("lancedb", config);
  const first = create({ path: directory });
  const second = create({ path: directory });
  expect(await first.upsert()).toBe(0);
  expect(await first.fetch()).toEqual([]);
  expect(await first.delete()).toBe(0);
  expect(await first.search()).toEqual([]);
  expect(
    await first.fetch({ namespace: "old_workspace", ids: ["one"] })
  ).toEqual([]);
  expect(await first.delete({ namespace, ids: ["one"] })).toBe(0);
  await expect(
    first.upsert({ namespace: "old_workspace", records: [record("one")] })
  ).rejects.toThrow();
  await Promise.all([
    first.upsert({
      namespace,
      records: [record("one"), record("one", { text: "Deduplicated" })],
    }),
    second.upsert({ namespace, records: [record("two")] }),
  ]);
  expect(
    (await first.fetch({ namespace, ids: ["one", "two"] }))
      .map(({ id }) => id)
      .sort()
  ).toEqual(["one", "two"]);
  const native = await require("@lancedb/lancedb").connect(directory);
  expect(await (await native.openTable(namespace)).countRows()).toBe(2);
  const defaultStorage = process.env.STORAGE_DIR;
  try {
    process.env.STORAGE_DIR = path.join(directory, "default-storage");
    expect(await create().heartbeat()).toEqual({
      ok: true,
      provider: "lancedb",
    });
    delete process.env.STORAGE_DIR;
    expect(create()).toHaveProperty("search");
  } finally {
    if (defaultStorage === undefined) delete process.env.STORAGE_DIR;
    else process.env.STORAGE_DIR = defaultStorage;
  }
});

test("validation rejects malformed identifiers, unbounded vectors and missing query permissions", async () => {
  expect(await db.upsert()).toBe(0);
  expect(await db.fetch()).toEqual([]);
  expect(await db.delete()).toBe(0);
  expect(await db.search()).toEqual([]);
  for (const dimensions of [1.5, 65537])
    expect(() =>
      namespaceFor({ tenantId: "a", embeddingId: "e", dimensions })
    ).toThrow();
  expect(() => namespaceFor()).toThrow();
  for (const row of [
    null,
    "string",
    record("bad", { id: "bad\u0000id" }),
    record("bad", { id: "x".repeat(301) }),
    record("bad", { vector: [] }),
    record("bad", { vector: new Array(65537).fill(1) }),
    record("bad", { text: null }),
  ])
    expect(() => shared.validateRecords([row])).toThrow();
  for (const request of [
    { ...search([record("one")]), namespace: "workspace" },
    { ...search([record("one")]), filter: null },
    {
      ...search([record("one")]),
      filter: {
        tenantId: "a",
        userId: "u",
        documentVersions: [{ documentId: "d", version: 0 }],
      },
    },
  ])
    expect(() => db.search(request)).toThrow();
});

test("the same Lance instance reconnects and retries writes after a transient native connection failure", async () => {
  const native = require("@lancedb/lancedb");
  const connecting = jest
    .spyOn(native, "connect")
    .mockRejectedValueOnce(new Error("temporary storage failure"));
  const retry = record("retry", { vector: [1, 0] });
  try {
    await expect(db.upsert({ namespace, records: [retry] })).rejects.toThrow(
      "temporary storage failure"
    );
    expect(await db.upsert({ namespace, records: [retry] })).toBe(1);
    expect(await db.fetch({ namespace, ids: ["retry"] })).toEqual([retry]);
    expect(connecting).toHaveBeenCalledTimes(2);
  } finally {
    connecting.mockRestore();
  }
});

test("Lance propagates create failures and only recovers when the target table was actually created", async () => {
  const native = require("@lancedb/lancedb");
  const client = await native.connect(directory);
  const createTable = client.createTable.bind(client);
  const connecting = jest.spyOn(native, "connect").mockResolvedValue(client);
  const creating = jest
    .spyOn(client, "createTable")
    .mockRejectedValueOnce(new Error("disk unavailable"));
  try {
    const adapter = require("../../utils/vectorDbProviders/records").create(
      "lancedb",
      {
        path: directory,
      }
    );
    await expect(
      adapter.upsert({ namespace, records: [record("retry")] })
    ).rejects.toThrow("disk unavailable");
    creating.mockImplementationOnce(async (name) => {
      const row = shared.validateRecords([record("external")])[0];
      await createTable(name, [
        { ...shared.metadata(row), vector: row.vector },
      ]);
      throw new Error("another writer created the table");
    });
    expect(
      await adapter.upsert({ namespace, records: [record("retry")] })
    ).toBe(1);
    expect(
      (await adapter.fetch({ namespace, ids: ["retry", "external"] }))
        .map(({ id }) => id)
        .sort()
    ).toEqual(["external", "retry"]);
  } finally {
    creating.mockRestore();
    connecting.mockRestore();
  }
});
