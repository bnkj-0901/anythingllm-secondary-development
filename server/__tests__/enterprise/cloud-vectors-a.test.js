const mockBackends = {};

function mockFailure(state, method) {
  const failure = state.errors?.[method];
  if (!failure) return;
  if (Array.isArray(failure)) {
    const next = failure.shift();
    if (next) throw next;
  } else throw failure;
}

function mockMongoFilter(where, record) {
  if (where.$and)
    return where.$and.every((item) => mockMongoFilter(item, record));
  if (where.$or) return where.$or.some((item) => mockMongoFilter(item, record));
  return Object.entries(where).every(([key, expression]) =>
    typeof expression === "object" ? record[key] === expression.$eq : false
  );
}

function mockQdrantFilter(where, record) {
  if (where.must && !where.must.every((item) => mockQdrantFilter(item, record)))
    return false;
  if (
    where.should &&
    !where.should.some((item) => mockQdrantFilter(item, record))
  )
    return false;
  return !where.key || record[where.key] === where.match.value;
}

function mockWeaviateFilter(where, record) {
  if (where.and)
    return where.and.every((item) => mockWeaviateFilter(item, record));
  if (where.or)
    return where.or.some((item) => mockWeaviateFilter(item, record));
  return record[where.key] === where.value;
}

function mockScore(vector) {
  return vector[0] / Math.hypot(...vector);
}

function mockRank(rows, predicate, limit) {
  return [...rows.values()]
    .filter(predicate)
    .map((row) => ({ ...row, score: mockScore(row.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

jest.mock(
  "@pinecone-database/pinecone",
  () => ({
    Pinecone: jest.fn(() => {
      const state = mockBackends.pinecone;
      const namespace = (name) => {
        if (!state.data.has(name)) state.data.set(name, new Map());
        const rows = state.data.get(name);
        return {
          upsert: jest.fn(async (records) => {
            state.calls.push(["upsert", records]);
            for (const row of records)
              rows.set(row.id, { ...row.metadata, vector: row.values });
          }),
          fetch: jest.fn(async (ids) => {
            state.calls.push(["fetch", ids]);
            if (state.omitRecords) return {};
            return {
              records: Object.fromEntries(
                ids
                  .filter((id) => rows.has(id))
                  .map((id) => [
                    id,
                    {
                      id,
                      metadata: rows.get(id),
                      values: rows.get(id).vector,
                    },
                  ])
              ),
            };
          }),
          query: jest.fn(async (request) => {
            state.calls.push(["search", request]);
            if (state.omitMatches) return {};
            return {
              matches: mockRank(
                rows,
                (row) => mockMongoFilter(request.filter, row),
                request.topK
              ),
            };
          }),
          deleteMany: jest.fn(async (ids) => {
            state.calls.push(["delete", ids]);
            ids.forEach((id) => rows.delete(id));
          }),
        };
      };
      return {
        Index: jest.fn((name) => {
          state.indexName = name;
          return { namespace };
        }),
        describeIndex: jest.fn(async () => {
          mockFailure(state, "describe");
          return {
            status: { ready: state.ready !== false },
            metric: state.metric || "cosine",
          };
        }),
      };
    }),
  }),
  { virtual: true }
);

function mockChromaClient(kind, config) {
  const state = mockBackends[kind];
  state.config = config;
  const collection = ({ name, metadata }) => {
    mockFailure(state, "collection");
    state.collectionMetadata = metadata || state.collectionMetadata;
    const rows = state.data.get(name);
    if (!rows) throw Object.assign(new Error("not found"), { status: 404 });
    return {
      configuration: state.useConfiguration
        ? { hnsw: { space: state.metric || "cosine" } }
        : undefined,
      metadata: { "hnsw:space": state.metric || "cosine" },
      upsert: async (request) => {
        state.calls.push(["upsert", request]);
        request.ids.forEach((id, i) =>
          rows.set(id, {
            ...request.metadatas[i],
            id,
            vector: request.embeddings[i],
            text: request.documents[i],
          })
        );
      },
      get: async (request) => {
        state.calls.push(["fetch", request]);
        const found = request.ids
          .filter((id) => rows.has(id))
          .map((id) => rows.get(id));
        return {
          ids: found.map((row) => row.id),
          metadatas: found,
          embeddings: found.map((row) => row.vector),
          documents: found.map((row) => row.text),
        };
      },
      query: async (request) => {
        state.calls.push(["search", request]);
        if (state.omitMatches) return { ids: [] };
        if (state.omitDistances) return { ids: [["missing-distance"]] };
        const found = mockRank(
          rows,
          (row) => mockMongoFilter(request.where, row),
          request.nResults
        );
        return {
          ids: [found.map((row) => row.id)],
          distances: [found.map((row) => 1 - row.score)],
        };
      },
      delete: async (request) => {
        state.calls.push(["delete", request]);
        request.ids.forEach((id) => rows.delete(id));
      },
    };
  };
  return {
    heartbeat: async () => 123,
    getOrCreateCollection: async (options) => {
      state.embeddingFunction = options.embeddingFunction;
      if (!state.data.has(options.name))
        state.data.set(options.name, new Map());
      return collection(options);
    },
    getCollection: async (options) => collection(options),
  };
}

jest.mock(
  "chromadb",
  () => ({
    ChromaClient: jest.fn((config) => mockChromaClient("chroma", config)),
    CloudClient: jest.fn((config) => mockChromaClient("chromacloud", config)),
  }),
  { virtual: true }
);

jest.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: jest.fn((config) => {
    const state = mockBackends.qdrant;
    state.config = config;
    return {
      api: () => ({ clusterStatus: async () => ({ ok: true }) }),
      getCollections: async () => ({ collections: [] }),
      getCollection: async (namespace) => {
        mockFailure(state, "getCollection");
        if (!state.data.has(namespace))
          throw Object.assign(new Error("missing"), { status: 404 });
        return {
          config: {
            params: {
              vectors: state.vectorConfig || { size: 2, distance: "Cosine" },
            },
          },
        };
      },
      createCollection: async (namespace, options) => {
        state.calls.push(["create", options]);
        state.data.set(namespace, new Map());
        mockFailure(state, "create");
      },
      createPayloadIndex: async (namespace, options) => {
        mockFailure(state, "index");
        state.calls.push(["index", options]);
      },
      upsert: async (namespace, request) => {
        state.calls.push(["upsert", request]);
        for (const point of request.points)
          state.data.get(namespace).set(point.id, {
            ...point.payload,
            vector: point.vector,
            pointId: point.id,
          });
      },
      retrieve: async (namespace, request) => {
        mockFailure(state, "fetch");
        state.calls.push(["fetch", request]);
        const rows = state.data.get(namespace) || new Map();
        return request.ids
          .filter((id) => rows.has(id))
          .map((id) => ({
            payload: rows.get(id),
            vector: rows.get(id).vector,
          }));
      },
      search: async (namespace, request) => {
        mockFailure(state, "search");
        state.calls.push(["search", request]);
        const rows = state.data.get(namespace) || new Map();
        return mockRank(
          rows,
          (row) => mockQdrantFilter(request.filter, row),
          request.limit
        )
          .filter((row) => row.score >= request.score_threshold)
          .map((row) => ({ payload: row, score: row.score }));
      },
      delete: async (namespace, request) => {
        mockFailure(state, "delete");
        state.calls.push(["delete", request]);
        request.points.forEach((id) => state.data.get(namespace)?.delete(id));
      },
    };
  }),
}));

function mockWeaviateClient(config) {
  const state = mockBackends.weaviate;
  mockFailure(state, "connect");
  state.config = config;
  const collection = (name) => {
    const rows = state.data.get(name);
    return {
      filter: { byProperty: (key) => ({ equal: (value) => ({ key, value }) }) },
      data: {
        exists: async (id) => rows.has(id),
        insert: async (object) => {
          state.calls.push(["insert", object]);
          if (rows.has(object.id)) throw new Error("duplicate");
          if (state.insertFailed) mockFailure(state, "insert");
          rows.set(object.id, { ...object.properties, vector: object.vectors });
          mockFailure(state, "insert");
        },
        replace: async (object) => {
          state.calls.push(["replace", object]);
          rows.set(object.id, { ...object.properties, vector: object.vectors });
        },
        deleteById: async (id) => {
          state.calls.push(["delete", id]);
          rows.delete(id);
        },
      },
      query: {
        fetchObjectById: async (id) => {
          state.calls.push(["fetch", id]);
          return rows.has(id)
            ? {
                properties: rows.get(id),
                vectors: { default: rows.get(id).vector },
              }
            : null;
        },
        nearVector: async (_vector, request) => {
          state.calls.push(["search", request]);
          if (state.omitMatches) return {};
          if (state.invalidResult)
            return {
              objects: [
                { properties: {}, metadata: {} },
                { properties: { recordId: "invalid-score" } },
              ],
            };
          const found = mockRank(
            rows,
            (row) => mockWeaviateFilter(request.filters, row),
            request.limit
          );
          return {
            objects: found.map((row) => ({
              properties: row,
              metadata: { distance: 1 - row.score },
            })),
          };
        },
      },
    };
  };
  return {
    isLive: async () => state.live !== false,
    collections: {
      exists: async (name) => state.data.has(name),
      get: collection,
      createFromSchema: async (schema) => {
        state.schema = schema;
        state.data.set(schema.class, new Map());
        if (state.creationFailed) state.data.delete(schema.class);
        mockFailure(state, "create");
      },
    },
  };
}

jest.mock(
  "weaviate-client",
  () => ({
    Filters: {
      and: (...and) => ({ and }),
      or: (...or) => ({ or }),
    },
    default: {
      ApiKey: function (key) {
        this.key = key;
      },
      filter: { and: (...and) => ({ and }), or: (...or) => ({ or }) },
      connectToCustom: jest.fn(async (config) => mockWeaviateClient(config)),
      connectToWeaviateCloud: jest.fn(async (url, config) =>
        mockWeaviateClient({ url, ...config })
      ),
    },
  }),
  { virtual: true }
);

const namespace = `ep_${"a".repeat(48)}`;
const otherNamespace = `ep_${"b".repeat(48)}`;
const configurations = {
  pinecone: { apiKey: "test-key", indexName: "existing-cosine-index" },
  chroma: { endpoint: "http://chroma.example.test:8000", apiKey: "test-key" },
  chromacloud: {
    apiKey: "cloud-key",
    projectId: "chroma-tenant",
    indexName: "cloud-database",
  },
  qdrant: { endpoint: "https://qdrant.example.test", apiKey: "qdrant-key" },
  weaviate: {
    endpoint: "http://weaviate.example.test:8080",
    grpcHost: "grpc.example.test",
    grpcPort: 50052,
  },
};
const base = {
  id: "public-current",
  tenantId: "tenant-a",
  documentId: "doc-a",
  version: 1,
  embeddingId: "embedding-1",
  libraryId: "library-1",
  text: "original",
  vector: [0.8, 0.6],
};
const filter = {
  tenantId: "tenant-a",
  userId: "user-a",
  documentVersions: [
    { documentId: "doc-a", version: 1 },
    { documentId: "doc-b", version: 2 },
  ],
};

let mockNetwork;
beforeEach(() => {
  jest.clearAllMocks();
  // These tests exercise adapter behavior against SDK fakes. A real request
  // must fail immediately instead of reaching a fixture hostname if a mock
  // stops matching after another suite has resolved the installed SDK.
  mockNetwork = jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Vector adapter unit tests must not make network requests");
  });
  for (const provider of Object.keys(configurations))
    mockBackends[provider] = { data: new Map(), calls: [] };
});

afterEach(() => {
  try {
    expect(mockNetwork).not.toHaveBeenCalled();
  } finally {
    mockNetwork.mockRestore();
  }
});

describe.each(Object.keys(configurations))(
  "%s explicit vector adapter",
  (provider) => {
    const create = (config = {}) =>
      require("../../utils/vectorDbProviders/records").create(provider, {
        ...configurations[provider],
        ...config,
      });

    test("prefilters the authorized document/version pairs before topK", async () => {
      const adapter = create();
      await adapter.upsert({
        namespace,
        records: [
          base,
          {
            ...base,
            id: "own-private",
            documentId: "doc-b",
            version: 2,
            vector: [0.9, Math.sqrt(0.19)],
          },
          {
            ...base,
            id: "other-tenant",
            tenantId: "tenant-b",
            documentId: "denied-doc",
            vector: [1, 0],
          },
          {
            ...base,
            id: "other-private",
            documentId: "denied-private",
            vector: [1, 0],
          },
          { ...base, id: "crossed-version", version: 2, vector: [1, 0] },
          { ...base, id: "stale-version", version: 3, vector: [1, 0] },
        ],
      });
      const result = await adapter.search({
        namespace,
        vector: [1, 0],
        filter,
        topK: 2,
        threshold: 0.7,
      });
      expect(result.map(({ id }) => id)).toEqual([
        "own-private",
        "public-current",
      ]);
      expect(result[0].score).toBeCloseTo(0.9);
      const threshold = await adapter.search({
        namespace,
        vector: [1, 0],
        filter,
        topK: 2,
        threshold: 0.85,
      });
      expect(threshold.map(({ id }) => id)).toEqual(["own-private"]);
    });

    test("upserts stable IDs and fetches complete updated vectors without namespace collisions", async () => {
      const adapter = create();
      await adapter.upsert({ namespace, records: [base] });
      await adapter.upsert({
        namespace,
        records: [{ ...base, text: "updated", vector: [0, 1] }],
      });
      await adapter.upsert({
        namespace: otherNamespace,
        records: [{ ...base, text: "other namespace" }],
      });
      const rows = await adapter.fetch({
        namespace,
        ids: [base.id, base.id, "missing"],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ...base,
        text: "updated",
        vector: [0, 1],
      });
      expect(
        (await adapter.fetch({ namespace: otherNamespace, ids: [base.id] }))[0]
          .text
      ).toBe("other namespace");
      await adapter.delete({ namespace, ids: [base.id, base.id] });
      expect(await adapter.fetch({ namespace, ids: [base.id] })).toEqual([]);
      expect(
        await adapter.fetch({ namespace: otherNamespace, ids: [base.id] })
      ).toHaveLength(1);
      expect(await adapter.heartbeat()).toBe(true);
    });

    test("collector metadata round trips without overriding authorization fields", async () => {
      const adapter = create();
      const source = {
        ...base,
        metadata: {
          title: "Source",
          url: "https://example.test",
          nested: { page: 2 },
          tenantId: "denied",
        },
      };
      await adapter.upsert({ namespace, records: [source] });
      expect(await adapter.fetch({ namespace, ids: [base.id] })).toEqual([
        expect.objectContaining(source),
      ]);
    });

    test("empty IDs, invalid namespaces and no valid document versions never read or delete all data", async () => {
      const adapter = create();
      await adapter.upsert({ namespace, records: [base] });
      const state = mockBackends[provider];
      state.calls.length = 0;
      expect(await adapter.fetch({ namespace, ids: [] })).toEqual([]);
      expect(await adapter.fetch({ namespace, ids: undefined })).toEqual([]);
      expect(await adapter.delete({ namespace, ids: [] })).toBe(0);
      expect(await adapter.delete({ namespace, ids: undefined })).toBe(0);
      expect(await adapter.fetch({ namespace: "", ids: [base.id] })).toEqual(
        []
      );
      expect(await adapter.delete({ namespace: "", ids: [base.id] })).toBe(0);
      expect(
        await adapter.search({
          namespace,
          vector: [1, 0],
          filter: { ...filter, documentVersions: [] },
          topK: 2,
          threshold: 0,
        })
      ).toEqual([]);
      expect(state.calls).toEqual([]);
      expect(await adapter.fetch({ namespace, ids: [base.id] })).toHaveLength(
        1
      );
    });
  }
);

test("cloud and self-hosted constructors use only explicit configuration", async () => {
  const chroma = require("chromadb");
  await require("../../utils/vectorDbProviders/records")
    .create("chroma", {
      endpoint: "http://explicit:8000",
      apiKey: "local-token",
      authHeader: "X-Token",
    })
    .heartbeat();
  expect(chroma.ChromaClient).toHaveBeenCalledWith({
    path: "http://explicit:8000",
    fetchOptions: { headers: { "X-Token": "local-token" } },
  });
  await require("../../utils/vectorDbProviders/records")
    .create("chromacloud", configurations.chromacloud)
    .heartbeat();
  expect(chroma.CloudClient).toHaveBeenCalledWith({
    apiKey: "cloud-key",
    tenant: "chroma-tenant",
    database: "cloud-database",
  });
  const { default: weaviate } = require("weaviate-client");
  await require("../../utils/vectorDbProviders/records")
    .create("weaviate", {
      endpoint: "https://tenant.weaviate.cloud",
      apiKey: "explicit-cloud-key",
    })
    .heartbeat();
  expect(weaviate.connectToWeaviateCloud).toHaveBeenCalledWith(
    "https://tenant.weaviate.cloud",
    { authCredentials: expect.objectContaining({ key: "explicit-cloud-key" }) }
  );
  await require("../../utils/vectorDbProviders/records")
    .create("weaviate", configurations.weaviate)
    .heartbeat();
  expect(weaviate.connectToCustom).toHaveBeenCalledWith(
    expect.objectContaining({
      httpHost: "weaviate.example.test",
      httpPort: 8080,
      grpcHost: "grpc.example.test",
      grpcPort: 50052,
    })
  );
});

test("Pinecone preserves the original availability and score threshold contract for dotproduct indices", async () => {
  mockBackends.pinecone.metric = "dotproduct";
  const adapter = require("../../utils/vectorDbProviders/records").create(
    "pinecone",
    configurations.pinecone
  );
  await expect(adapter.heartbeat()).resolves.toBe(true);
  await expect(adapter.upsert({ namespace, records: [base] })).resolves.toBe(1);
  expect(await adapter.search(searchRequest({ threshold: 0.7 }))).toEqual([
    { id: base.id, score: 0.8 },
  ]);
  expect(await adapter.search(searchRequest({ threshold: 0.9 }))).toEqual([]);
});

const searchRequest = (changes = {}) => ({
  namespace,
  vector: [1, 0],
  filter,
  topK: 2,
  threshold: -1,
  ...changes,
});

test.each(Object.keys(configurations))(
  "%s direct adapter rejects invalid writes and safely handles empty writes",
  async (provider) => {
    const adapter = require("../../utils/vectorDbProviders/records").create(
      provider,
      configurations[provider]
    );
    await expect(
      adapter.upsert({ namespace: "workspace-name", records: [base] })
    ).rejects.toThrow("namespace");
    expect(await adapter.upsert({ namespace, records: [] })).toBe(0);
    expect(await adapter.search({})).toEqual([]);
    expect(
      await adapter.fetch({ namespace: "workspace-name", ids: [base.id] })
    ).toEqual([]);
    expect(
      await adapter.delete({ namespace: "workspace-name", ids: [base.id] })
    ).toBe(0);
    expect(mockBackends[provider].calls).toEqual([]);
  }
);

test("Pinecone retries readiness failures and safely handles missing response lists", async () => {
  const state = mockBackends.pinecone;
  const adapter = require("../../utils/vectorDbProviders/records").create(
    "pinecone",
    configurations.pinecone
  );
  state.ready = false;
  await expect(adapter.upsert({ namespace, records: [base] })).rejects.toThrow(
    "not ready"
  );
  state.ready = true;
  await adapter.upsert({ namespace, records: [base] });
  state.omitMatches = state.omitRecords = true;
  expect(await adapter.fetch({ namespace, ids: [base.id] })).toEqual([]);
  expect(await adapter.search(searchRequest())).toEqual([]);
});

test.each(["chroma", "chromacloud"])(
  "%s handles missing collections, SDK errors and score omissions",
  async (provider) => {
    const state = mockBackends[provider];
    const adapter = require("../../utils/vectorDbProviders/records").create(
      provider,
      configurations[provider]
    );
    expect(await adapter.fetch({ namespace, ids: [base.id] })).toEqual([]);
    expect(await adapter.delete({ namespace, ids: [base.id] })).toBe(0);
    expect(await adapter.search(searchRequest())).toEqual([]);
    state.errors = {
      collection: Object.assign(new Error("missing"), {
        name: "ChromaNotFoundError",
      }),
    };
    expect(await adapter.search(searchRequest())).toEqual([]);
    state.errors.collection = new Error("denied");
    await expect(adapter.search(searchRequest())).rejects.toThrow("denied");
    state.errors = {};
    state.useConfiguration = true;
    await adapter.upsert({ namespace, records: [base] });
    expect(() => state.embeddingFunction.generate()).toThrow(
      "Vectors must be supplied"
    );
    expect(
      await adapter.search(
        searchRequest({
          filter: { ...filter, documentVersions: [filter.documentVersions[0]] },
        })
      )
    ).toHaveLength(1);
    state.omitMatches = true;
    expect(await adapter.search(searchRequest())).toEqual([]);
    state.omitMatches = false;
    state.omitDistances = true;
    expect(await adapter.search(searchRequest())).toEqual([]);
    state.metric = "l2";
    await expect(adapter.search(searchRequest())).rejects.toThrow("cosine");
  }
);

test("Chroma Authorization uses Bearer while custom headers remain literal", async () => {
  const { ChromaClient } = require("chromadb");
  const create = (config) =>
    require("../../utils/vectorDbProviders/records").create("chroma", config);
  for (const apiKey of ["private-token"])
    await create({
      endpoint: "http://local:8000",
      authHeader: "Authorization",
      apiKey,
    }).heartbeat();
  expect(ChromaClient).toHaveBeenLastCalledWith({
    path: "http://local:8000",
    fetchOptions: { headers: { Authorization: "Bearer private-token" } },
  });
  await create({
    endpoint: "http://local:8000",
    authHeader: "X-Token",
    apiKey: "literal",
  }).heartbeat();
  expect(ChromaClient).toHaveBeenLastCalledWith({
    path: "http://local:8000",
    fetchOptions: { headers: { "X-Token": "literal" } },
  });
});

test("Chroma can connect without auth and write errors remain visible", async () => {
  const { ChromaClient } = require("chromadb");
  const adapter = require("../../utils/vectorDbProviders/records").create(
    "chroma",
    {
      endpoint: "http://local:8000",
    }
  );
  await adapter.heartbeat();
  expect(ChromaClient).toHaveBeenCalledWith({ path: "http://local:8000" });
  mockBackends.chroma.errors = {
    collection: Object.assign(new Error("failed write"), { status: 404 }),
  };
  await expect(adapter.upsert({ namespace, records: [base] })).rejects.toThrow(
    "failed write"
  );
});

test("Qdrant validates vector settings and retries failed setup", async () => {
  const state = mockBackends.qdrant;
  const adapter = require("../../utils/vectorDbProviders/records").create(
    "qdrant",
    {
      endpoint: "http://local:6333",
    }
  );
  await adapter.heartbeat();
  expect(state.config).toEqual({ url: "http://local:6333" });
  state.errors = { getCollection: new Error("access denied") };
  await expect(adapter.upsert({ namespace, records: [base] })).rejects.toThrow(
    "access denied"
  );
  state.errors = {
    create: Object.assign(new Error("race"), { statusCode: 409 }),
  };
  await adapter.upsert({ namespace, records: [base] });
  const retry = require("../../utils/vectorDbProviders/records").create(
    "qdrant",
    configurations.qdrant
  );
  state.errors = { index: new Error("index failed") };
  await expect(retry.upsert({ namespace, records: [base] })).rejects.toThrow(
    "index failed"
  );
  state.errors = {};
  state.vectorConfig = { size: 3, distance: "Cosine" };
  await expect(retry.upsert({ namespace, records: [base] })).rejects.toThrow(
    "does not match"
  );
  state.vectorConfig = { size: 2, distance: "Cosine" };
  expect(await retry.upsert({ namespace, records: [base] })).toBe(1);
  state.errors = { create: new Error("create denied") };
  await expect(
    retry.upsert({ namespace: otherNamespace, records: [base] })
  ).rejects.toThrow("create denied");
});

test("Qdrant returns empty only for missing resources and propagates other SDK failures", async () => {
  const state = mockBackends.qdrant;
  const adapter = require("../../utils/vectorDbProviders/records").create(
    "qdrant",
    configurations.qdrant
  );
  for (const [method, invoke, empty] of [
    ["fetch", () => adapter.fetch({ namespace, ids: [base.id] }), []],
    ["search", () => adapter.search(searchRequest()), []],
    ["delete", () => adapter.delete({ namespace, ids: [base.id] }), 0],
  ]) {
    state.errors = {
      [method]: Object.assign(new Error("missing"), { statusCode: 404 }),
    };
    expect(await invoke()).toEqual(empty);
    state.errors = { [method]: new Error("access denied") };
    await expect(invoke()).rejects.toThrow("access denied");
  }
});

test("Weaviate connection, collection and stable-ID insert races are retriable", async () => {
  const state = mockBackends.weaviate;
  const adapter = require("../../utils/vectorDbProviders/records").create(
    "weaviate",
    configurations.weaviate
  );
  state.errors = { connect: new Error("connection failed") };
  await expect(adapter.heartbeat()).rejects.toThrow("connection failed");
  state.errors = {};
  state.live = false;
  await expect(adapter.heartbeat()).rejects.toThrow("Invalid Alive signal");
  state.live = true;
  expect(await adapter.fetch({ namespace, ids: [base.id] })).toEqual([]);
  expect(await adapter.search(searchRequest())).toEqual([]);
  expect(await adapter.delete({ namespace, ids: [base.id] })).toBe(0);
  state.errors = { create: new Error("collection creation failed") };
  state.creationFailed = true;
  await expect(adapter.upsert({ namespace, records: [base] })).rejects.toThrow(
    "collection creation failed"
  );
  state.creationFailed = false;
  state.errors = {
    create: new Error("concurrent create"),
    insert: new Error("concurrent insert"),
  };
  expect(await adapter.upsert({ namespace, records: [base] })).toBe(1);
  expect(state.calls.some(([method]) => method === "replace")).toBe(true);
  state.insertFailed = true;
  state.errors = { insert: new Error("insert denied") };
  await expect(
    adapter.upsert({ namespace, records: [{ ...base, id: "new-id" }] })
  ).rejects.toThrow("insert denied");
  state.errors = {};
  state.omitMatches = true;
  expect(await adapter.search(searchRequest())).toEqual([]);
  state.omitMatches = false;
  state.invalidResult = true;
  expect(await adapter.search(searchRequest())).toEqual([]);
});

test("Weaviate keeps upstream TLS derivation and parses saved ports", async () => {
  const { default: weaviate } = require("weaviate-client");
  await require("../../utils/vectorDbProviders/records")
    .create("weaviate", {
      endpoint: "https://local.example",
      deployment: "custom",
      grpcPort: "50052",
      grpcSecure: "false",
    })
    .heartbeat();
  expect(weaviate.connectToCustom).toHaveBeenLastCalledWith(
    expect.objectContaining({
      httpPort: 443,
      grpcPort: 50052,
      grpcSecure: true,
    })
  );
  await require("../../utils/vectorDbProviders/records")
    .create("weaviate", { endpoint: "http://local.example", grpcSecure: true })
    .heartbeat();
  expect(weaviate.connectToCustom).toHaveBeenLastCalledWith(
    expect.objectContaining({
      httpPort: 80,
      grpcPort: 50051,
      grpcSecure: false,
    })
  );
  await require("../../utils/vectorDbProviders/records")
    .create("weaviate", {
      endpoint: "https://cloud.example",
      deployment: "cloud",
    })
    .heartbeat();
  expect(weaviate.connectToWeaviateCloud).toHaveBeenLastCalledWith(
    "https://cloud.example",
    {}
  );
});
