const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { createPostgresFixture } = require("./postgres-fixture.cjs");

let mockFixture, mockPgStore;
const mockStore = {
  all: (...args) => mockPgStore.all(...args),
  one: (...args) => mockPgStore.one(...args),
  run: (...args) => mockPgStore.run(...args),
  transaction: (...args) => mockPgStore.transaction(...args),
  id: () => require("crypto").randomUUID(),
  now: () => new Date().toISOString(),
};
const mockCreate = jest.fn((config) =>
  jest
    .requireActual("../../utils/vectorDbProviders")
    .createVectorDatabase(config)
);
jest.mock("../../enterprise/store", () => mockStore);
jest.mock("../../utils/vectorDbProviders", () => ({
  ...jest.requireActual("../../utils/vectorDbProviders"),
  createVectorDatabase: (...args) => mockCreate(...args),
}));
const vectorStore = require("../../enterprise/vector-store");
const providers = require("../../enterprise/providers");
const { createVectorDatabase, namespaceFor } = jest.requireActual(
  "../../utils/vectorDbProviders"
);
let directory, environment;
const platform = { identity: "platform", userId: "platform", authVersion: 1 };
const stamp = "2026-10-21T00:00:00.000Z";
const records = [
  {
    id: "chunk",
    tenantId: "a",
    documentId: "document",
    version: 1,
    embeddingId: "embedding:1",
    libraryId: "library",
    text: "private source",
    vector: [0.6, 0.8, 0],
  },
];
const namespace = namespaceFor({
  tenantId: "a",
  embeddingId: "embedding:1",
  dimensions: 3,
});
async function save(config, extra = {}, ctx = platform) {
  try {
    return {
      status: 200,
      body: await vectorStore.change(
        {
          provider: "lancedb",
          config,
          revision: (await vectorStore.settings()).revision,
          ...extra,
        },
        ctx
      ),
    };
  } catch (error) {
    return { status: error.status || 500, body: { error: error.message } };
  }
}
async function reset(config = { path: path.join(directory, randomUUID()) }) {
  await mockStore.run("DELETE FROM ep_vector_cleanup");
  await mockStore.run(
    "UPDATE ep_vector_settings SET provider='lancedb',config=$1,revision=revision+1",
    providers.encrypt(JSON.stringify(config))
  );
  mockCreate.mockImplementation((value) => createVectorDatabase(value));
  await vectorStore.withWrite((db) => db.upsert({ namespace, records }));
}
beforeAll(async () => {
  environment = Object.fromEntries(
    [
      "JWT_SECRET",
      "SIG_KEY",
      "SIG_SALT",
      "TENANT_BASE_DOMAIN",
      "PLATFORM_HOSTS",
    ].map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, {
    JWT_SECRET: "vector-jwt",
    SIG_KEY: "vector-encryption",
    SIG_SALT: "vector-salt",
    TENANT_BASE_DOMAIN: "localhost",
    PLATFORM_HOSTS: "localhost",
  });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ep-vector-store-"));
  mockFixture = await createPostgresFixture();
  mockPgStore = mockFixture.db;

  await mockStore.run(
    "INSERT INTO ep_vector_settings VALUES('platform','lancedb',NULL,1,$1) ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider, config=EXCLUDED.config, revision=EXCLUDED.revision, \"updatedAt\"=EXCLUDED.\"updatedAt\"",
    stamp
  );
  await mockStore.run(
    "INSERT INTO ep_tenants(id,code,name,hostname,\"createdAt\",\"updatedAt\") VALUES('a','tenant-a','A','tenant-a.localhost',$1,$2)",
    stamp,
    stamp
  );
  await mockStore.run(
    "INSERT INTO ep_platform_accounts(id,username,name,\"passwordHash\",\"createdAt\",\"updatedAt\") VALUES('platform','platform','Platform','unused',$1,$2)",
    stamp,
    stamp
  );
  await mockStore.run(
    "INSERT INTO users(id,\"tenantId\",username,name,\"passwordHash\",role,\"createdAt\",\"lastUpdatedAt\") VALUES(1,'a','admin','Admin','unused','admin',NOW(),NOW())"
  );
  await mockStore.run(
    "INSERT INTO ep_libraries(id,\"tenantId\",name,\"createdBy\",\"createdAt\",\"updatedAt\") VALUES('library','a','Library','admin',$1,$2)",
    stamp,
    stamp
  );
  await mockStore.run(
    "INSERT INTO ep_documents(id,\"tenantId\",\"libraryId\",title,\"inputType\",content,status,version,\"embeddingId\",\"createdBy\",\"updatedBy\",\"createdAt\",\"updatedAt\") VALUES('document','a','library','Source','text','private source','ready',1,'embedding:1','admin','admin',$1,$2)",
    stamp,
    stamp
  );
  await mockStore.run(
    "INSERT INTO ep_chunks(id,\"tenantId\",\"documentId\",version,position,content,\"embeddingId\",dimensions,namespace) VALUES('chunk','a','document',1,0,'private source','embedding:1',3,$1)",
    namespace
  );
});
beforeEach(async () => reset());
afterAll(async () => {
  await mockFixture?.cleanup();
  if (
    directory &&
    path
      .resolve(directory)
      .startsWith(path.resolve(os.tmpdir(), "ep-vector-store-"))
  )
    fs.rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(environment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("only a current platform identity can change the shared vector database", async () => {
  for (const ctx of [
    null,
    { identity: "tenant", userId: "admin", tenantId: "a" },
  ])
    expect((await save({}, {}, ctx)).status).toBe(403);
  expect((await save({}, {}, { ...platform, authVersion: 0 })).status).toBe(
    401
  );
});
test("switching to an empty location selects it for rebuilding and preserves all old live data", async () => {
  const before = await vectorStore.settings();
  const target = path.join(directory, "empty-target");
  const saved = await save({ path: target });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({
    reindexRequired: true,
    affectedDocuments: 1,
  });
  expect((await vectorStore.settings()).config.path).toBe(target);
  expect(
    await createVectorDatabase({
      provider: "lancedb",
      config: { path: target },
    }).fetch({ namespace, ids: ["chunk"] })
  ).toEqual([]);
  expect(
    await createVectorDatabase(before).fetch({ namespace, ids: ["chunk"] })
  ).toHaveLength(1);
  expect(
    await mockStore.one(
      "SELECT status,version FROM ep_documents WHERE id='document'"
    )
  ).toEqual({ status: "ready", version: 1 });
});
test("a backend can be selected before any index is published", async () => {
  await mockStore.run("DELETE FROM ep_chunks");
  const target = path.join(directory, "initial-empty");
  expect((await save({ path: target })).status).toBe(200);
  expect((await vectorStore.settings()).config.path).toBe(target);
  await mockStore.run(
    "INSERT INTO ep_chunks(id,\"tenantId\",\"documentId\",version,position,content,\"embeddingId\",dimensions,namespace) VALUES('chunk','a','document',1,0,'private source','embedding:1',3,$1)",
    namespace
  );
});
test("same storage configuration remains a no-op; an already provisioned location must contain all current metadata", async () => {
  const before = await vectorStore.settings();
  expect((await save(before.config)).body.revision).toBe(before.revision);
  const target = path.join(directory, "existing-target");
  // Deliberately provision external data in the fixture. Saving settings never writes it.
  await createVectorDatabase({
    provider: "lancedb",
    config: { path: target },
  }).upsert({ namespace, records });
  const response = await save({ path: target });
  expect(response.status).toBe(200);
  expect(response.body.revision).toBe(before.revision + 1);
  expect(response.body).toMatchObject({
    reindexRequired: false,
    affectedDocuments: 0,
  });
  expect(
    await vectorStore.withDatabase((db) =>
      db.fetch({ namespace, ids: ["chunk"] })
    )
  ).toHaveLength(1);
});
test.each([undefined, 0, -1, "1"])(
  "a stale revision %p is rejected",
  async (revision) => {
    expect((await save({}, { revision })).status).toBe(409);
  }
);
test.each(["disabled", "credentials-reset"])(
  "revocation during a connection check prevents commit: %s",
  async (mode) => {
    const before = await vectorStore.settings();
    const target = path.join(directory, mode);
    await createVectorDatabase({
      provider: "lancedb",
      config: { path: target },
    }).upsert({ namespace, records });
    const transact = mockStore.transaction;
    const hook = jest
      .spyOn(mockStore, "transaction")
      .mockImplementationOnce(async (fn) => {
        await mockStore.run(
          mode === "disabled"
            ? "UPDATE ep_platform_accounts SET status='disabled' WHERE id='platform'"
            : "UPDATE ep_platform_accounts SET \"authVersion\"=2 WHERE id='platform'"
        );
        return transact(fn);
      });
    try {
      expect((await save({ path: target })).status).toBe(401);
      expect(await vectorStore.settings()).toEqual(before);
    } finally {
      hook.mockRestore();
      await mockStore.run(
        "UPDATE ep_platform_accounts SET status='active',\"authVersion\"=1 WHERE id='platform'"
      );
    }
  }
);
test.each(
  [
    [],
    [records[0], records[0]],
    [{ ...records[0], vector: [1] }],
    [{ ...records[0], vector: [NaN, 0, 0] }],
    [{ ...records[0], libraryId: "another" }],
    [{ ...records[0], text: "corrupted" }],
    [{ ...records[0], version: 2 }],
  ].map((value) => [value])
)(
  "missing or changed target records require rebuilding without modifying published SQL state",
  async (result) => {
    const before = await vectorStore.settings();
    mockCreate.mockImplementation((value) => ({
      ...createVectorDatabase(value),
      fetch: async () => result,
    }));
    const saved = await save({ path: path.join(directory, randomUUID()) });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      reindexRequired: true,
      affectedDocuments: 1,
    });
    expect((await vectorStore.settings()).revision).toBe(before.revision + 1);
    expect(
      await mockStore.one(
        "SELECT status,version FROM ep_documents WHERE id='document'"
      )
    ).toEqual({ status: "ready", version: 1 });
  }
);
test.each(["heartbeat", "fetch"])(
  "backend %s errors remain redacted",
  async (method) => {
    mockCreate.mockImplementation((value) => ({
      ...createVectorDatabase(value),
      [method]: async () => {
        throw new Error("password=secret-sdk-details");
      },
    }));
    const response = await save({ path: path.join(directory, randomUUID()) });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toMatch(/password|secret-sdk/);
  }
);
test("a cleanup failure stays durable, blocks a backend switch and can be retried after recovery", async () => {
  const retired = { ...records[0], id: "retired" };
  await vectorStore.withWrite((db) =>
    db.upsert({ namespace, records: [retired] })
  );
  await mockStore.transaction((tx) =>
    vectorStore.queueCleanup(tx, [{ ...retired, namespace }])
  );
  await vectorStore.withWrite(async (db) => {
    const remove = db.delete;
    db.delete = async () => {
      throw new Error("offline");
    };
    try {
      expect(await vectorStore.flushCleanup(db)).toBe(false);
      await expect(vectorStore.flushCleanup(db, true)).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      db.delete = remove;
    }
  });
  expect(await mockStore.all("SELECT id FROM ep_vector_cleanup")).toEqual([
    { id: "retired" },
  ]);
  await vectorStore.recoverCleanup();
  expect(await mockStore.all("SELECT * FROM ep_vector_cleanup")).toEqual([]);
  expect(
    await vectorStore.withDatabase((db) =>
      db.fetch({ namespace, ids: ["retired"] })
    )
  ).toEqual([]);
});

test.each(["qdrant", "pinecone"])(
  "rotated %s credentials clean pending IDs through the verified replacement without the expired key",
  async (provider) => {
    const current = await vectorStore.settings();
    const backend = createVectorDatabase({
      provider: "lancedb",
      config: current.config,
    });
    await backend.upsert({
      namespace,
      records: [{ ...records[0], id: "pending-rotation" }],
    });
    await mockStore.transaction((tx) =>
      vectorStore.queueCleanup(tx, [
        { id: "pending-rotation", tenantId: "a", namespace },
      ])
    );
    const fields =
      provider === "qdrant"
        ? { endpoint: "https://vectors.example.test" }
        : { indexName: "shared-name" };
    await mockStore.run(
      "UPDATE ep_vector_settings SET provider=$1,config=$2",
      provider,
      providers.encrypt(JSON.stringify({ ...fields, apiKey: "expired-key" }))
    );
    const expiredDelete = jest.fn(async () => {
      throw new Error("expired key");
    });
    const replacementDelete = jest.fn((input) => backend.delete(input));
    const unexpectedWrite = jest.fn(async () => {
      throw new Error("settings must not copy vectors");
    });
    mockCreate.mockImplementation((value) => ({
      ...backend,
      upsert: unexpectedWrite,
      delete:
        value.config.apiKey === "rotated-key"
          ? replacementDelete
          : expiredDelete,
    }));
    const response = await save(
      { ...fields, apiKey: "rotated-key" },
      { provider }
    );
    expect(response.status).toBe(200);
    expect(expiredDelete).not.toHaveBeenCalled();
    expect(unexpectedWrite).not.toHaveBeenCalled();
    expect(replacementDelete).toHaveBeenCalledWith({
      namespace,
      ids: ["pending-rotation"],
    });
    expect(await mockStore.all("SELECT * FROM ep_vector_cleanup")).toEqual([]);
    expect(
      await backend.fetch({ namespace, ids: ["pending-rotation"] })
    ).toEqual([]);
    expect(await backend.fetch({ namespace, ids: ["chunk"] })).toHaveLength(1);
  }
);

test("a same-name Pinecone index under a different project requires rebuild and does not delete old live IDs", async () => {
  const current = await vectorStore.settings();
  const old = createVectorDatabase({
    provider: "lancedb",
    config: current.config,
  });
  const emptyProject = createVectorDatabase({
    provider: "lancedb",
    config: { path: path.join(directory, "other-pinecone-project") },
  });
  await mockStore.run(
    "UPDATE ep_vector_settings SET provider='pinecone',config=$1",
    providers.encrypt(
      JSON.stringify({ indexName: "shared-name", apiKey: "old-project" })
    )
  );
  const deleted = jest.fn((input) => old.delete(input));
  mockCreate.mockImplementation((value) =>
    value.config.apiKey === "other-project"
      ? { ...emptyProject, delete: deleted }
      : old
  );
  const saved = await save(
    { indexName: "shared-name", apiKey: "other-project" },
    { provider: "pinecone" }
  );
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({
    reindexRequired: true,
    affectedDocuments: 1,
  });
  expect(deleted).not.toHaveBeenCalled();
  expect(await old.fetch({ namespace, ids: ["chunk"] })).toHaveLength(1);
});

test("pending cleanup without live IDs cannot use unproven replacement project credentials", async () => {
  const current = await vectorStore.settings();
  const backend = createVectorDatabase({
    provider: "lancedb",
    config: current.config,
  });
  await mockStore.run("DELETE FROM ep_chunks");
  try {
    await mockStore.transaction((tx) =>
      vectorStore.queueCleanup(tx, [
        { id: "unproven-pending", tenantId: "a", namespace },
      ])
    );
    await mockStore.run(
      "UPDATE ep_vector_settings SET provider='pinecone',config=$1",
      providers.encrypt(
        JSON.stringify({ indexName: "shared-name", apiKey: "expired-key" })
      )
    );
    const expiredDelete = jest.fn(async () => {
      throw new Error("expired key");
    });
    const replacementDelete = jest.fn((input) => backend.delete(input));
    mockCreate.mockImplementation((value) => ({
      ...backend,
      delete:
        value.config.apiKey === "rotated-key"
          ? replacementDelete
          : expiredDelete,
    }));
    const before = await vectorStore.settings();
    expect(
      (
        await save(
          { indexName: "shared-name", apiKey: "rotated-key" },
          { provider: "pinecone" }
        )
      ).status
    ).toBe(503);
    expect(replacementDelete).not.toHaveBeenCalled();
    expect(expiredDelete).toHaveBeenCalled();
    expect(await vectorStore.settings()).toEqual(before);
    expect(await mockStore.all("SELECT id FROM ep_vector_cleanup")).toEqual([
      { id: "unproven-pending" },
    ]);
  } finally {
    await mockStore.run(
      "INSERT INTO ep_chunks(id,\"tenantId\",\"documentId\",version,position,content,\"embeddingId\",dimensions,namespace) VALUES('chunk','a','document',1,0,'private source','embedding:1',3,$1)",
      namespace
    );
  }
});

test("cleanup batches more than 200 records without touching a live chunk", async () => {
  const pending = Array.from({ length: 205 }, (_, i) => ({
    id: `retired-${i}`,
    tenantId: "a",
    namespace,
  }));
  await mockStore.transaction((tx) =>
    vectorStore.queueCleanup(tx, [...pending, pending[0]])
  );
  const remove = jest.fn(async () => 0);
  expect(await vectorStore.flushCleanup({ delete: remove })).toBe(true);
  expect(remove.mock.calls.map(([arg]) => arg.ids.length)).toEqual([200, 5]);
  expect(await mockStore.all("SELECT * FROM ep_vector_cleanup")).toEqual([]);
  expect(
    await vectorStore.withDatabase((db) =>
      db.fetch({ namespace, ids: ["chunk"] })
    )
  ).toHaveLength(1);
});

test("new readers wait until the validated target is committed", async () => {
  const target = path.join(directory, "reader-target");
  await createVectorDatabase({
    provider: "lancedb",
    config: { path: target },
  }).upsert({ namespace, records });
  let entered, release;
  const active = new Promise((resolve) => (entered = resolve));
  mockCreate.mockImplementation((value) => {
    const db = createVectorDatabase(value);
    if (value.config.path === target) {
      const heartbeat = db.heartbeat;
      db.heartbeat = async () => {
        await heartbeat();
        entered();
        await new Promise((resolve) => (release = resolve));
      };
    }
    return db;
  });
  const changing = save({ path: target });
  await active;
  const reading = vectorStore.withDatabase((_db, value) => value.config.path);
  release();
  expect((await changing).status).toBe(200);
  expect(await reading).toBe(target);
});
test("failed writes release serialization for recovery", async () => {
  await expect(
    vectorStore.withWrite(() => {
      throw new Error("failed");
    })
  ).rejects.toThrow("failed");
  expect(await vectorStore.withWrite(() => "recovered")).toBe("recovered");
});
test("missing or unreadable stored settings fail closed", async () => {
  await mockStore.run(
    "UPDATE ep_vector_settings SET config='broken-encrypted-value'"
  );
  await expect(vectorStore.settings()).rejects.toMatchObject({ status: 503 });
  await mockStore.run("DELETE FROM ep_vector_settings");
  await expect(vectorStore.settings()).rejects.toMatchObject({ status: 503 });
});
