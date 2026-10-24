/* global jest, beforeAll, afterAll, test, expect */
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const { createStore, CURRENT_MIGRATION } = require("../../enterprise/store");
let fixture, store;
beforeAll(async () => {
  fixture = await createPostgresFixture();
  store = fixture.db;
});
afterAll(async () => fixture?.cleanup());

test("initialization verifies the deployed PostgreSQL baseline and shares readiness", async () => {
  await expect(
    Promise.all([store.init(), store.init(), store.init()])
  ).resolves.toEqual(
    Array(3).fill({
      provider: "postgresql",
      migration: CURRENT_MIGRATION,
    })
  );
  const rows = await store.all(
    "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1",
    "ep_%"
  );
  expect(rows.map((row) => row.tablename)).toEqual(
    expect.arrayContaining([
      "ep_chunks",
      "ep_vector_settings",
      "ep_file_cleanup",
    ])
  );
  expect(
    await store.one(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2",
      "ep_chunks",
      "vector"
    )
  ).toBeNull();
});

test("readiness errors are safe and retriable without creating tables", async () => {
  const fake = {
    $queryRawUnsafe: jest
      .fn()
      .mockRejectedValueOnce(new Error("credential-url-secret"))
      .mockResolvedValueOnce([{ migration_name: CURRENT_MIGRATION }]),
  };
  const isolated = createStore(fake);
  await expect(isolated.init()).rejects.toThrow("PostgreSQL 数据库尚未初始化");
  await expect(isolated.init()).resolves.toEqual({
    provider: "postgresql",
    migration: CURRENT_MIGRATION,
  });
  expect(fake.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  const missing = createStore({ $queryRawUnsafe: jest.fn(async () => []) });
  await expect(missing.init()).rejects.toThrow("PostgreSQL 数据库尚未初始化");
});

test("an unfinished deployment is rejected until the current baseline finishes", async () => {
  const db = {
    $queryRawUnsafe: jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ migration_name: CURRENT_MIGRATION }]),
  };
  const pending = createStore(db);
  await expect(pending.init()).rejects.toThrow("PostgreSQL 数据库尚未初始化");
  await expect(pending.init()).resolves.toMatchObject({
    migration: CURRENT_MIGRATION,
  });
  expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
    expect.stringContaining('"finished_at" IS NOT NULL'),
    CURRENT_MIGRATION
  );
});

test("native PostgreSQL parameters, quoted names and bigint normalization preserve query semantics", async () => {
  await store.run(
    'CREATE TABLE "storeChecks" ("id" TEXT PRIMARY KEY,"value" INTEGER)'
  );
  const id = "quote' ; DROP TABLE storeChecks; --";
  await store.run(
    'INSERT INTO "storeChecks" ("id","value") VALUES($1,$2)',
    id,
    7
  );
  expect(
    await store.one('SELECT * FROM "storeChecks" WHERE "id"=$1', id)
  ).toEqual({ id, value: 7 });
  expect(
    await store.one('SELECT * FROM "storeChecks" WHERE "id"=$1', "absent")
  ).toBeNull();
  expect(
    await store.one('SELECT COUNT(*) AS count FROM "storeChecks"')
  ).toEqual({ count: 1 });
  expect(store.id()).toMatch(/^[a-f0-9-]{36}$/);
  expect(Number.isNaN(Date.parse(store.now()))).toBe(false);
  await expect(
    store.one("SELECT 9007199254740992::bigint AS value")
  ).rejects.toThrow("数据库整数超出接口支持范围");
});

test("transaction rollback is atomic and independent queries continue", async () => {
  await expect(
    store.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO "storeChecks" ("id","value") VALUES($1,$2)',
        "rollback",
        2
      );
      expect(
        await tx.one(
          'SELECT "value" FROM "storeChecks" WHERE "id"=$1',
          "rollback"
        )
      ).toEqual({ value: 2 });
      throw new Error("abort transaction");
    })
  ).rejects.toThrow("abort transaction");
  expect(
    await store.one('SELECT * FROM "storeChecks" WHERE "id"=$1', "rollback")
  ).toBeNull();
  await store.run(
    'INSERT INTO "storeChecks" ("id","value") VALUES($1,$2)',
    "after-rollback",
    3
  );
});

test("explicitly retryable pure database transactions preserve concurrent increments", async () => {
  await store.run(
    'INSERT INTO "storeChecks" ("id","value") VALUES($1,$2)',
    "counter",
    0
  );
  const increment = () =>
    store.transaction(
      async (tx) => {
        const row = await tx.one(
          'SELECT "value" FROM "storeChecks" WHERE "id"=$1 FOR UPDATE',
          "counter"
        );
        await tx.run(
          'UPDATE "storeChecks" SET "value"=$1 WHERE "id"=$2',
          row.value + 1,
          "counter"
        );
      },
      { retry: true }
    );
  await Promise.all(Array.from({ length: 3 }, increment));
  expect(
    await store.one(
      'SELECT "value" FROM "storeChecks" WHERE "id"=$1',
      "counter"
    )
  ).toEqual({ value: 3 });
});

test("callbacks are not repeated unless opted into a bounded serialization retry", async () => {
  const conflict = Object.assign(new Error("serialization"), { code: "P2034" });
  const defaultDb = {
    $transaction: jest.fn(async () => {
      throw conflict;
    }),
  };
  await expect(createStore(defaultDb).transaction(jest.fn())).rejects.toThrow(
    "serialization"
  );
  expect(defaultDb.$transaction).toHaveBeenCalledTimes(1);
  const retryDb = {
    $transaction: jest
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce("committed"),
  };
  await expect(
    createStore(retryDb).transaction(jest.fn(), { retry: true })
  ).resolves.toBe("committed");
  expect(retryDb.$transaction).toHaveBeenCalledTimes(2);
  const exhausted = {
    $transaction: jest.fn(async () => {
      throw Object.assign(new Error("serialization"), {
        meta: { code: "40001" },
      });
    }),
  };
  await expect(
    createStore(exhausted).transaction(jest.fn(), { retry: true })
  ).rejects.toThrow("serialization");
  expect(exhausted.$transaction).toHaveBeenCalledTimes(3);
});

test("explicit pure database retry also handles PostgreSQL deadlock codes", async () => {
  const db = {
    $transaction: jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("deadlock"), { meta: { code: "40P01" } })
      )
      .mockResolvedValueOnce("committed"),
  };
  await expect(
    createStore(db).transaction(jest.fn(), { retry: true })
  ).resolves.toBe("committed");
  expect(db.$transaction).toHaveBeenCalledTimes(2);
});
