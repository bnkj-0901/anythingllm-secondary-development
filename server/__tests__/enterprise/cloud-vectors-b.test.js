const mockState = {};

function mockError(state, method) {
  if (state.errors[method]) throw state.errors[method];
}
function mockRank(rows, predicate, topK) {
  return [...rows.values()]
    .filter(predicate)
    .map((row) => ({
      ...row,
      score: row.vector[0] / Math.hypot(...row.vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
function mockAllowed(filter, row) {
  return filter.documentVersions.some(
    (item) => item.documentId === row.documentId && item.version === row.version
  );
}
function mockMongo(filter, row) {
  if (filter.$and) return filter.$and.every((child) => mockMongo(child, row));
  if (filter.$or) return filter.$or.some((child) => mockMongo(child, row));
  return Object.entries(filter).every(([key, predicate]) => {
    const value = key.split(".").reduce((parent, part) => parent?.[part], row);
    return predicate.$in
      ? predicate.$in.includes(value)
      : value === predicate.$eq;
  });
}

jest.mock("pg", () => ({
  Client: jest.fn(() => {
    const state = mockState.pgvector;
    return {
      connect: jest.fn(async () => mockError(state, "connect")),
      end: jest.fn(async () => {
        state.closed++;
      }),
      query: jest.fn(async (sql, params = []) => {
        state.calls.push({ sql, params });
        mockError(state, "query");
        if (sql.startsWith("INSERT")) {
          mockError(state, "insert");
          const row = {
            ...JSON.parse(params[3]),
            vector: JSON.parse(params[2]),
          };
          expect(params[1]).toMatch(
            /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
          );
          state.data.set(params[1], { ...row, namespace: params[0] });
        }
        if (sql.startsWith("SELECT metadata,"))
          return {
            rows: [...state.data.entries()]
              .filter(
                ([key, row]) =>
                  row.namespace === params[0] && params[1].includes(key)
              )
              .map(([, row]) => ({
                metadata: Object.fromEntries(
                  Object.entries(row).filter(([key]) => key !== "namespace")
                ),
                vector: state.arrayVectors
                  ? row.vector
                  : JSON.stringify(row.vector),
              })),
          };
        if (sql.startsWith("SELECT metadata->>'id' AS id")) {
          // The mock only emulates the guarded native distance query.
          if (!sql.includes("ORDER BY embedding <=> $1::vector ASC LIMIT"))
            throw new Error("Unsafe SQL contract");
          const versions = [];
          for (let i = 2; i < params.length - 1; i += 2) {
            expect(sql).toContain(
              `(metadata->>'documentId' = $${i + 1} AND (metadata->>'version')::integer = $${i + 2})`
            );
            versions.push({ documentId: params[i], version: params[i + 1] });
          }
          const filter = {
            documentVersions: versions,
          };
          return {
            rows: mockRank(
              state.data,
              (row) => row.namespace === params[1] && mockAllowed(filter, row),
              params.at(-1)
            ),
          };
        }
        if (sql.startsWith("DELETE")) {
          let rowCount = 0;
          for (const id of params[1])
            rowCount +=
              state.data.get(id)?.namespace === params[0] &&
              state.data.delete(id)
                ? 1
                : 0;
          return { rowCount };
        }
        return { rows: [] };
      }),
    };
  }),
}));

jest.mock("@zilliz/milvus2-sdk-node", () => ({
  DataType: { VarChar: 21, FloatVector: 101, JSON: 23 },
  IndexType: { AUTOINDEX: "AUTOINDEX" },
  MetricType: { COSINE: "COSINE" },
  ConsistencyLevelEnum: { Strong: 0 },
  MilvusClient: jest.fn((config) => {
    const state = mockState[config.address];
    const status = { error_code: "Success" };
    const call = (method, args) => {
      state.calls.push({ method, args });
      mockError(state, method);
    };
    return {
      checkHealth: jest.fn(async () => {
        call("health");
        return { isHealthy: state.healthy };
      }),
      hasCollection: jest.fn(async (args) => {
        call("has", args);
        return { status, value: state.data.has(args.collection_name) };
      }),
      createCollection: jest.fn(async (args) => {
        call("create", args);
        state.data.set(args.collection_name, new Map());
        if (state.createRace) throw new Error("concurrent collection creation");
        return status;
      }),
      createIndex: jest.fn(async (args) => {
        call("index", args);
        return status;
      }),
      loadCollectionSync: jest.fn(async (args) => {
        call("load", args);
        return status;
      }),
      upsert: jest.fn(async (args) => {
        call("upsert", args);
        if (state.mutationStatus) return { status: state.mutationStatus };
        if (state.partial) return { status, err_index: [0] };
        for (const row of args.data)
          state.data
            .get(args.collection_name)
            .set(row.id, { ...row.metadata, vector: row.vector });
        return { status, err_index: [] };
      }),
      query: jest.fn(async (args) => {
        call("query", args);
        const ids = JSON.parse(args.filter.slice("id in ".length));
        return {
          status,
          data: [...state.data.get(args.collection_name).values()]
            .filter((row) => ids.includes(row.id))
            .map((row) => ({ id: row.id, metadata: row, vector: row.vector })),
        };
      }),
      search: jest.fn(async (args) => {
        call("search", args);
        const predicate = new Function(
          "metadata",
          `return ${args.filter.replace(/\band\b/g, "&&").replace(/\bor\b/g, "||")}`
        );
        return {
          status,
          results: mockRank(
            state.data.get(args.collection_name),
            predicate,
            args.limit
          ),
        };
      }),
      deleteEntities: jest.fn(async (args) => {
        call("delete", args);
        let count = 0;
        for (const id of JSON.parse(args.expr.slice("id in ".length)))
          count += state.data.get(args.collection_name).delete(id) ? 1 : 0;
        return { status, delete_cnt: `${count}` };
      }),
    };
  }),
}));

jest.mock("@datastax/astra-db-ts", () => ({
  AstraDB: jest.fn((...args) => {
    const state = mockState.astra;
    if (state.realSdk) {
      const { AstraDB } = jest.requireActual("@datastax/astra-db-ts");
      return new AstraDB(...args);
    }
    const call = (method, args) => {
      state.calls.push({ method, args });
      mockError(state, method);
    };
    const db = {
      httpClient: {
        executeCommand: jest.fn(async (args, optionsToRetain) => {
          expect(optionsToRetain.has("explain")).toBe(true);
          call("collections", args);
          return {
            status: {
              collections: [...state.data.keys()].map((name) => ({
                name,
                options: state.options.get(name),
              })),
            },
          };
        }),
      },
      createCollection: jest.fn(async (name, options) => {
        call("create", { name, options });
        state.options.set(name, options);
        state.data.set(name, new Map());
        if (state.createRace) throw new Error("concurrent collection creation");
      }),
      collection: jest.fn((name) => {
        const exists = () => {
          if (!state.data.has(name))
            throw { errors: [{ errorCode: "COLLECTION_NOT_EXIST" }] };
        };
        return {
          findOneAndReplace: jest.fn(async (filter, record, options) => {
            call("upsert", { name, filter, record, options });
            exists();
            state.data.get(name).set(record._id, record);
            return { ok: 1 };
          }),
          find: jest.fn((filter, options) => ({
            toArray: async () => {
              call("find", { name, filter, options });
              exists();
              const rows = state.data.get(name);
              if (options.sort)
                return mockRank(
                  new Map(
                    [...rows].map(([id, row]) => [
                      id,
                      { ...row, vector: row.$vector },
                    ])
                  ),
                  (row) => mockMongo(filter, row),
                  options.limit
                ).map((row) => ({ ...row, $similarity: (row.score + 1) / 2 }));
              return [...rows.values()].filter((row) =>
                filter._id.$in.includes(row._id)
              );
            },
          })),
          deleteOne: jest.fn(async (args) => {
            call("delete", { name, ...args });
            exists();
            return {
              deletedCount: state.data.get(name).delete(args._id) ? 1 : 0,
            };
          }),
        };
      }),
    };
    return { db: jest.fn(() => db) };
  }),
}));

const {
  createVectorDatabase,
  namespaceFor,
} = require("../../utils/vectorDbProviders");
const ns = namespaceFor({
  tenantId: "tenant-a",
  embeddingId: "model-a",
  dimensions: 2,
});
const otherNs = namespaceFor({
  tenantId: "tenant-a",
  embeddingId: "model-b",
  dimensions: 2,
});
const filter = {
  tenantId: "tenant-a",
  userId: "user-a",
  documentVersions: [
    { documentId: "doc-public", version: 2 },
    { documentId: "doc-a", version: 2 },
    { documentId: "doc-b", version: 1 },
  ],
};
const record = (id, changes = {}) => ({
  id,
  tenantId: "tenant-a",
  documentId: "doc-a",
  version: 2,
  embeddingId: "model-a",
  libraryId: "lib-a",
  text: id,
  vector: [0.7, 0.7],
  ...changes,
});
const config = (provider) =>
  provider === "pgvector"
    ? { connectionString: "postgres://local/test" }
    : provider === "astra"
      ? { endpoint: "https://db.example", token: "test", database: "ks" }
      : { address: provider, token: "test", database: "db", ssl: "false" };
const api = (provider) =>
  createVectorDatabase({ provider, config: config(provider) });
const raw = (provider) =>
  require("../../utils/vectorDbProviders/records").create(
    provider,
    config(provider)
  );
const query = (changes = {}) => ({
  namespace: ns,
  vector: [1, 0],
  filter,
  topK: 1,
  threshold: -1,
  ...changes,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const provider of ["pgvector", "milvus", "zilliz", "astra"])
    mockState[provider] = {
      data: new Map(),
      options: new Map(),
      calls: [],
      errors: {},
      closed: 0,
      healthy: true,
    };
});

describe.each(["pgvector", "milvus", "zilliz", "astra"])(
  "%s SDK contract",
  (provider) => {
    test("preserves collector source metadata alongside protected tenant and document identity", async () => {
      const db = api(provider);
      const source = record("metadata", {
        metadata: {
          title: "Title",
          nested: { page: 7 },
          tenantId: "untrusted",
        },
      });
      await db.upsert({ namespace: ns, records: [source] });
      expect(await db.fetch({ namespace: ns, ids: [source.id] })).toEqual([
        source,
      ]);
    });
    test("applies authorized paired document versions before native topK", async () => {
      const db = api(provider);
      await raw(provider).upsert({
        namespace: ns,
        records: [
          record("other-tenant", {
            documentId: "denied-tenant",
            tenantId: "tenant-b",
            vector: [1, 0],
          }),
          record("other-private", {
            documentId: "denied-private",
            visibility: "private",
            vector: [1, 0],
          }),
          record("old-version", { version: 1, vector: [1, 0] }),
          record("crossed-version", {
            documentId: "doc-b",
            version: 2,
            vector: [1, 0],
          }),
          record("unknown-document", { documentId: "doc-c", vector: [1, 0] }),
          record("own-private", {
            vector: [0.9, 0.1],
          }),
          record("public", { documentId: "doc-public" }),
        ],
      });
      expect(await db.search(query())).toEqual([
        { id: "own-private", score: expect.any(Number) },
      ]);
      expect(await db.search(query({ threshold: 1 }))).toEqual([]);
      expect(
        await db.search(
          query({
            filter: {
              documentVersions: [{ documentId: "doc-public", version: 2 }],
            },
          })
        )
      ).toEqual([{ id: "public", score: expect.any(Number) }]);
      expect(await db.heartbeat()).toBe(true);
      if (provider === "pgvector") {
        const { sql } = mockState[provider].calls.find((call) =>
          call.sql.startsWith("SELECT metadata->>'id' AS id")
        );
        expect(sql.indexOf("metadata->>'documentId'")).toBeLessThan(
          sql.indexOf("ORDER BY")
        );
        expect(sql).toContain('FROM "anythingllm_vectors"');
      } else if (provider !== "astra") {
        const call = mockState[provider].calls.find(
          (item) => item.method === "search"
        );
        expect(call.args).toMatchObject({
          metric_type: "COSINE",
          consistency_level: 0,
          limit: 1,
        });
      } else {
        const call = mockState.astra.calls.find(
          (item) => item.method === "find" && item.args.options.sort
        );
        expect(call.args.options).toMatchObject({
          sort: { $vector: [1, 0] },
          includeSimilarity: true,
          limit: 1,
        });
        expect(call.args.name.length).toBeLessThanOrEqual(48);
      }
    });

    test("stable-ID upsert, full vector fetch and deletion preserve other namespaces", async () => {
      const db = api(provider);
      await db.upsert({ namespace: ns, records: [record("same-id")] });
      const revised = record("same-id", {
        text: "updated",
        vector: [0.6, 0.8],
      });
      await db.upsert({ namespace: ns, records: [revised] });
      const other = record("same-id", { embeddingId: "model-b" });
      await db.upsert({ namespace: otherNs, records: [other] });
      expect(
        await db.fetch({ namespace: ns, ids: ["same-id", "missing"] })
      ).toEqual([revised]);
      expect(await db.fetch({ namespace: otherNs, ids: ["same-id"] })).toEqual([
        other,
      ]);
      expect(await db.delete({ namespace: ns, ids: ["same-id"] })).toBe(1);
      expect(await db.fetch({ namespace: ns, ids: ["same-id"] })).toEqual([]);
      expect(await db.fetch({ namespace: otherNs, ids: ["same-id"] })).toEqual([
        other,
      ]);
    });

    test("empty IDs, empty permitted versions and absent collections are safe", async () => {
      const db = api(provider);
      expect(await db.fetch({ namespace: ns, ids: [] })).toEqual([]);
      expect(await db.delete({ namespace: ns, ids: [] })).toBe(0);
      expect(await db.upsert({ namespace: ns, records: [] })).toBe(0);
      expect(
        await db.search(query({ filter: { ...filter, documentVersions: [] } }))
      ).toEqual([]);
      expect(mockState[provider].calls).toEqual([]);
      expect(await db.fetch({ namespace: ns, ids: ["absent"] })).toEqual([]);
      expect(await db.delete({ namespace: ns, ids: ["absent"] })).toBe(0);
      expect(await db.search(query())).toEqual([]);
    });

    test("connection/query errors propagate rather than reporting success", async () => {
      const state = mockState[provider];
      const db = api(provider);
      state.errors[
        provider === "pgvector"
          ? "query"
          : provider === "astra"
            ? "collections"
            : "health"
      ] = new Error("denied");
      await expect(db.heartbeat()).rejects.toThrow("denied");
      state.errors = {};
      await db.upsert({ namespace: ns, records: [record("a")] });
      state.errors[
        provider === "pgvector"
          ? "query"
          : provider === "astra"
            ? "find"
            : "search"
      ] = new Error("network failed");
      await expect(db.search(query())).rejects.toThrow("network failed");
      state.errors = {};
      state.errors[
        provider === "pgvector"
          ? "query"
          : provider === "astra"
            ? "delete"
            : "delete"
      ] = new Error("delete failed");
      await expect(db.delete({ namespace: ns, ids: ["a"] })).rejects.toThrow(
        "delete failed"
      );
    });
  }
);

test("PGVector binds quoted values and closes clients on failures and rollbacks", async () => {
  expect(() =>
    createVectorDatabase({
      provider: "pgvector",
      config: { tableName: 'x"; DROP TABLE users;' },
    })
  ).toThrow("table name");
  const state = mockState.pgvector;
  const db = api("pgvector");
  await db.upsert({ namespace: ns, records: [record("a")] });
  await db.search(
    query({
      filter: {
        tenantId: "x'; DROP TABLE x;--",
        userId: "u'",
        documentVersions: [{ documentId: "d'", version: 2 }],
      },
    })
  );
  const call = state.calls.find((item) =>
    item.sql.startsWith("SELECT metadata->>'id' AS id")
  );
  expect(call.sql).not.toContain("DROP TABLE");
  expect(call.params).toEqual(["[1,0]", ns, "d'", 2, 1]);
  state.errors.insert = new Error("failed insert");
  await expect(
    db.upsert({ namespace: ns, records: [record("b")] })
  ).rejects.toThrow("failed insert");
  expect(state.calls.at(-1).sql).toBe("ROLLBACK");
  expect(state.closed).toBe(3);
  state.errors = { query: { code: "42P01" } };
  expect(await db.fetch({ namespace: ns, ids: ["a"] })).toEqual([]);
  expect(await db.search(query())).toEqual([]);
  expect(await db.delete({ namespace: ns, ids: ["a"] })).toBe(0);
});

test("PGVector rejects NUL before writes so a batch cannot partly persist or silently change source text", async () => {
  const state = mockState.pgvector;
  await expect(
    api("pgvector").upsert({
      namespace: ns,
      records: [record("good"), { ...record("bad"), text: "a\0b" }],
    })
  ).rejects.toThrow("NUL");
  expect(state.calls).toEqual([]);
});

test.each(["milvus", "zilliz"])(
  "%s rejects unhealthy, failed and partial SDK writes, then permits retry",
  async (provider) => {
    const state = mockState[provider];
    const db = api(provider);
    state.healthy = false;
    await expect(db.heartbeat()).rejects.toThrow("Invalid Heartbeat");
    state.healthy = true;
    state.errors.index = new Error("index failed");
    await expect(
      db.upsert({ namespace: ns, records: [record("a")] })
    ).rejects.toThrow("index failed");
    state.errors = {};
    state.mutationStatus = {
      error_code: "UnexpectedError",
      reason: "write rejected",
    };
    await expect(
      db.upsert({ namespace: ns, records: [record("a")] })
    ).rejects.toThrow("write rejected");
    state.mutationStatus = null;
    state.partial = true;
    await expect(
      db.upsert({ namespace: ns, records: [record("a")] })
    ).rejects.toThrow("partially accepted");
    state.partial = false;
    expect(await db.upsert({ namespace: ns, records: [record("a")] })).toBe(1);
    const { MilvusClient } = require("@zilliz/milvus2-sdk-node");
    expect(MilvusClient).toHaveBeenCalledWith(
      expect.objectContaining({
        address: provider,
        ...(provider === "zilliz" ? { token: "test" } : {}),
      })
    );
  }
);

test("Astra validates existing dimensions and metric and retries collection creation failures", async () => {
  const state = mockState.astra;
  const name = ns.slice(0, 48);
  state.data.set(name, new Map());
  state.options.set(name, { vector: { dimension: 3, metric: "cosine" } });
  const db = api("astra");
  await expect(
    db.upsert({ namespace: ns, records: [record("a")] })
  ).rejects.toThrow("configuration does not match");
  state.options.set(name, { vector: { dimension: 2, metric: "cosine" } });
  expect(await db.upsert({ namespace: ns, records: [record("a")] })).toBe(1);
  state.errors.create = new Error("create failed");
  await expect(
    db.upsert({
      namespace: otherNs,
      records: [record("b", { embeddingId: "model-b" })],
    })
  ).rejects.toThrow("create failed");
  state.errors = {};
  expect(
    await db.upsert({
      namespace: otherNs,
      records: [record("b", { embeddingId: "model-b" })],
    })
  ).toBe(1);
});

test.each(["pgvector", "milvus", "zilliz", "astra"])(
  "%s direct adapter validates empty and malformed requests",
  async (provider) => {
    const adapter = raw(provider);
    await expect(
      adapter.upsert({ namespace: "workspace", records: [record("a")] })
    ).rejects.toThrow("namespace");
    expect(await adapter.upsert({ namespace: ns, records: [] })).toBe(0);
    expect(await adapter.fetch({ namespace: ns, ids: [] })).toEqual([]);
    expect(await adapter.delete({ namespace: ns, ids: [] })).toBe(0);
    expect(await adapter.fetch({ namespace: "workspace", ids: ["a"] })).toEqual(
      []
    );
    expect(await adapter.delete({ namespace: "workspace", ids: ["a"] })).toBe(
      0
    );
    expect(await adapter.search({})).toEqual([]);
  }
);

test.each(["milvus", "zilliz"])(
  "%s recovers only genuine collection races and quotes exact deletion IDs",
  async (provider) => {
    const state = mockState[provider];
    const db = api(provider);
    state.errors.create = new Error("denied");
    await expect(
      db.upsert({ namespace: ns, records: [record("a")] })
    ).rejects.toThrow("denied");
    state.errors = {};
    state.createRace = true;
    const id = 'quoted"id\\tail';
    expect(
      await db.upsert({ namespace: ns, records: [record(id), record("keep")] })
    ).toBe(2);
    expect(await db.delete({ namespace: ns, ids: [id] })).toBe(1);
    const deletion = state.calls.find((call) => call.method === "delete").args;
    expect(deletion.expr).toBe(`id in ${JSON.stringify([id])}`);
    expect(await db.fetch({ namespace: ns, ids: [id, "keep"] })).toEqual([
      record("keep"),
    ]);
    await require("../../utils/vectorDbProviders/records")
      .create("milvus", {
        address: provider,
        username: "user",
        password: "pass",
      })
      .heartbeat();
    const { MilvusClient } = require("@zilliz/milvus2-sdk-node");
    expect(MilvusClient).toHaveBeenLastCalledWith({
      address: provider,
      username: "user",
      password: "pass",
    });
  }
);

test("Astra handles collection races and preserves original fetch errors", async () => {
  const state = mockState.astra;
  state.createRace = true;
  const db = api("astra");
  expect(await db.upsert({ namespace: ns, records: [record("a")] })).toBe(1);
  state.errors.find = new Error("fetch denied");
  await expect(db.fetch({ namespace: ns, ids: ["a"] })).rejects.toThrow(
    "fetch denied"
  );
});

test("PGVector supports parsed vector responses and propagates fetch and connection failures", async () => {
  const state = mockState.pgvector;
  const db = api("pgvector");
  await db.upsert({ namespace: ns, records: [record("a")] });
  state.arrayVectors = true;
  expect(await db.fetch({ namespace: ns, ids: ["a"] })).toEqual([record("a")]);
  state.errors.query = new Error("fetch denied");
  await expect(db.fetch({ namespace: ns, ids: ["a"] })).rejects.toThrow(
    "fetch denied"
  );
  state.errors = { connect: new Error("connection refused") };
  await expect(db.heartbeat()).rejects.toThrow("connection refused");
  expect(state.closed).toBe(3);
});

test("the installed Astra SDK retains explain and upsert options in Data API commands", async () => {
  mockState.astra.realSdk = true;
  const { HTTPClient } = jest.requireActual(
    "@datastax/astra-db-ts/dist/client/httpClient"
  );
  const requests = [];
  const request = jest
    .spyOn(HTTPClient.prototype, "_request")
    .mockImplementation(async ({ data }) => {
      requests.push(data);
      if (data.findCollections)
        return {
          status: {
            collections: [
              {
                name: ns.slice(0, 48),
                options: { vector: { dimension: 2, metric: "cosine" } },
              },
            ],
          },
        };
      return { data: { document: null } };
    });
  try {
    const db = api("astra");
    expect(await db.heartbeat()).toBe(true);
    expect(await db.upsert({ namespace: ns, records: [record("a")] })).toBe(1);
    expect(requests[0]).toEqual({
      findCollections: { options: { explain: true } },
    });
    expect(requests.at(-1).findOneAndReplace).toMatchObject({
      filter: { _id: "a" },
      options: { upsert: true },
      replacement: { _id: "a", $vector: [0.7, 0.7] },
    });
  } finally {
    request.mockRestore();
  }
});
