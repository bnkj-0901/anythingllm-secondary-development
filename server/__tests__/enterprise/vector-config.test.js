const { createPostgresFixture } = require("./postgres-fixture.cjs");
const {
  vectorFields,
  normalizeVectorConfig,
  environment,
  initializeVectorSettings,
  sameVectorStorage,
} = require("../../enterprise/vector-config");
const { encrypt, decrypt } = require("../../enterprise/providers");
const { KEY_MAPPING } = require("../../utils/helpers/updateENV");
let fixture;

beforeAll(async () => {
  process.env.SIG_KEY = "vector-config-test-key";
  process.env.SIG_SALT = "vector-config-test-salt";
  fixture = await createPostgresFixture();
});
afterAll(async () => fixture?.cleanup());
beforeEach(async () => {
  await fixture.db.run(
    "UPDATE ep_vector_settings SET provider='lancedb',config=NULL,revision=1 WHERE id='platform'"
  );
});
const saved = () =>
  fixture.db.one("SELECT * FROM ep_vector_settings WHERE id='platform'");

test("first startup imports the original environment once and encrypts credentials", async () => {
  const source = {
    VECTOR_DB: "qdrant",
    QDRANT_ENDPOINT: "https://vectors.example.test",
    QDRANT_API_KEY: "first-config-secret",
    PINECONE_API_KEY: "other-provider-secret",
  };
  expect(await initializeVectorSettings(fixture.db, source)).toBe(true);
  const row = await saved();
  expect(row.provider).toBe("qdrant");
  expect(JSON.parse(decrypt(row.config))).toEqual({
    endpoint: source.QDRANT_ENDPOINT,
    apiKey: source.QDRANT_API_KEY,
  });
  expect(row.config).not.toContain(source.QDRANT_API_KEY);
  expect(
    await initializeVectorSettings(fixture.db, { VECTOR_DB: "lancedb" })
  ).toBe(false);
  expect(await saved()).toEqual(row);
});

test("an empty first environment fixes the original local default without later overriding it", async () => {
  expect(await initializeVectorSettings(fixture.db, {})).toBe(true);
  const row = await saved();
  expect(row.provider).toBe("lancedb");
  expect(JSON.parse(decrypt(row.config))).toEqual({});
  expect(
    await initializeVectorSettings(fixture.db, {
      VECTOR_DB: "qdrant",
      QDRANT_ENDPOINT: "https://other.example.test",
    })
  ).toBe(false);
  expect(await saved()).toEqual(row);
});

test("a saved local directory is never replaced by deployment environment", async () => {
  const config = encrypt(JSON.stringify({ path: "D:/existing-vector-store" }));
  await fixture.db.run("UPDATE ep_vector_settings SET config=$1", config);
  const row = await saved();
  expect(
    await initializeVectorSettings(fixture.db, { VECTOR_DB: "invalid" })
  ).toBe(false);
  expect(await saved()).toEqual(row);
});

test("invalid initial environment is rejected without marking initialization complete", async () => {
  for (const source of [
    { VECTOR_DB: "unknown" },
    { VECTOR_DB: "qdrant" },
    { VECTOR_DB: "qdrant", QDRANT_ENDPOINT: "invalid endpoint" },
    { VECTOR_DB: "pgvector", PGVECTOR_CONNECTION_STRING: "invalid" },
  ]) {
    await expect(
      initializeVectorSettings(fixture.db, source)
    ).rejects.toMatchObject({ status: 400 });
    expect((await saved()).config).toBeNull();
  }
});

test("the original LanceDB deployment path is imported only on its first startup", async () => {
  const path = require("path");
  const directory = path.resolve("vector-config-deployment");
  await initializeVectorSettings(fixture.db, { LANCE_DB_PATH: directory });
  expect(JSON.parse(decrypt((await saved()).config))).toEqual({
    path: directory,
  });
});

test("existing indexes prevent an uninitialized baseline from switching storage at boot", async () => {
  const one = jest.fn(async (sql) =>
    sql.includes("COUNT(*)")
      ? { count: 1 }
      : { provider: "lancedb", config: null, revision: 1 }
  );
  const run = jest.fn(async () => 1);
  const db = { transaction: (task) => task({ one, run }) };
  await initializeVectorSettings(db, {
    VECTOR_DB: "qdrant",
    QDRANT_ENDPOINT: "https://different.example.test",
    LANCE_DB_PATH: "D:/different-store",
  });
  expect(run.mock.calls[0][1]).toBe("lancedb");
  expect(JSON.parse(decrypt(run.mock.calls[0][2]))).toEqual({});
});

test("concurrent first startup cannot replace the first committed configuration", async () => {
  const results = await Promise.all([
    initializeVectorSettings(fixture.db, {}),
    initializeVectorSettings(fixture.db, {}),
  ]);
  expect(results.sort()).toEqual([false, true]);
  expect(JSON.parse(decrypt((await saved()).config))).toEqual({});
});

test("vector environments use the original settings field mapping and do not borrow other provider credentials", () => {
  for (const [provider, fields] of Object.entries(vectorFields)) {
    const config = Object.fromEntries(
      Object.keys(fields).map((key) => [key, `configured-${key}`])
    );
    const values = environment(provider, config);
    expect(values.VECTOR_DB).toBe(provider);
    for (const [key, field] of Object.entries(fields))
      expect(values[KEY_MAPPING[field].envKey]).toBe(config[key]);
    if (provider !== "qdrant") expect(values.QDRANT_API_KEY).toBeUndefined();
  }
});

test("normalization retains masked same-provider secrets and rejects unrelated fields", async () => {
  const current = {
    provider: "qdrant",
    config: {
      endpoint: "https://vectors.example.test",
      apiKey: "saved-secret",
    },
  };
  for (const apiKey of ["", "********", undefined])
    await expect(
      normalizeVectorConfig(
        {
          provider: "qdrant",
          config: { endpoint: current.config.endpoint, apiKey },
        },
        current
      )
    ).resolves.toEqual(current);
  for (const body of [
    { provider: "unknown", config: {} },
    { provider: "__proto__", config: {} },
    { provider: "lancedb", config: [] },
    { provider: "lancedb", config: { apiKey: "unrelated" } },
    { provider: "lancedb", config: { path: "relative/path" } },
    {
      provider: "qdrant",
      config: { endpoint: "https://ok.example.test", apiKey: 12 },
    },
    {
      provider: "pgvector",
      config: {
        connectionString: "postgresql://user:pass@localhost/test",
        tableName: "bad;sql",
      },
    },
  ])
    await expect(normalizeVectorConfig(body)).rejects.toMatchObject({
      status: 400,
    });
});

test("storage comparison retains physical identifiers while allowing credential rotation", () => {
  const before = {
    provider: "pgvector",
    config: {
      connectionString:
        "postgresql://old:expired@db.example.test:5432/vectors?schema=public",
    },
  };
  const after = {
    provider: "pgvector",
    config: {
      connectionString:
        "postgresql://new:rotated@db.example.test:5432/vectors?schema=public",
      tableName: "anythingllm_vectors",
    },
  };
  expect(sameVectorStorage(before, after)).toBe(true);
  for (const connectionString of [
    "postgresql://new:rotated@other.example.test:5432/vectors?schema=public",
    "postgresql://new:rotated@db.example.test:5433/vectors?schema=public",
    "postgresql://new:rotated@db.example.test:5432/other?schema=public",
    "postgresql://new:rotated@db.example.test:5432/vectors?schema=other",
    "invalid",
  ])
    expect(
      sameVectorStorage(before, { ...after, config: { connectionString } })
    ).toBe(false);
  expect(
    sameVectorStorage(before, {
      ...after,
      config: { ...after.config, tableName: "other" },
    })
  ).toBe(false);
  expect(sameVectorStorage(before, { provider: "lancedb", config: {} })).toBe(
    false
  );
  expect(
    sameVectorStorage(
      { provider: "lancedb", config: {} },
      {
        provider: "lancedb",
        config: {
          path: require("path").resolve(
            process.env.STORAGE_DIR ||
              require("path").resolve(__dirname, "../../storage"),
            "lancedb"
          ),
        },
      }
    )
  ).toBe(true);
  expect(
    sameVectorStorage(
      {
        provider: "qdrant",
        config: { endpoint: "https://vectors.example.test", apiKey: "old" },
      },
      {
        provider: "qdrant",
        config: { endpoint: "https://vectors.example.test", apiKey: "new" },
      }
    )
  ).toBe(true);
  expect(
    sameVectorStorage(
      {
        provider: "qdrant",
        config: { endpoint: "https://vectors.example.test" },
      },
      {
        provider: "qdrant",
        config: { endpoint: "https://other.example.test" },
      }
    )
  ).toBe(false);
});
