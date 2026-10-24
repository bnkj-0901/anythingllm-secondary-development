const { randomUUID } = require("crypto");
const prisma = require("../utils/prisma");

const CURRENT_MIGRATION = "20261022000100_saas_postgres";
const now = () => new Date().toISOString();
function normalize(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([name, value]) => {
        if (typeof value !== "bigint") return [name, value];
        const number = Number(value);
        if (!Number.isSafeInteger(number))
          throw new Error("数据库整数超出接口支持范围");
        return [name, number];
      })
    )
  );
}
function client(db) {
  return {
    orm: db,
    all: async (sql, ...params) =>
      normalize(await db.$queryRawUnsafe(sql, ...params)),
    one: async (sql, ...params) =>
      normalize(await db.$queryRawUnsafe(sql, ...params))[0] || null,
    run: (sql, ...params) => db.$executeRawUnsafe(sql, ...params),
  };
}

// PostgreSQL is the sole runtime database. Queries use native $n parameters;
// no SQLite dialect translation or process-wide query serialization is used.
function createStore(db = prisma) {
  const api = client(db);
  let ready;
  async function init() {
    if (!ready)
      ready = (async () => {
        try {
          const rows = await db.$queryRawUnsafe(
            'SELECT "migration_name" FROM "_prisma_migrations" WHERE "migration_name" = $1 AND "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL',
            CURRENT_MIGRATION
          );
          if (!rows.some((row) => row.migration_name === CURRENT_MIGRATION))
            throw new Error("missing required schema migration");
          return {
            provider: "postgresql",
            migration: CURRENT_MIGRATION,
          };
        } catch {
          throw new Error(
            "PostgreSQL 数据库尚未初始化，请先执行数据库部署迁移"
          );
        }
      })().catch((error) => {
        ready = null;
        throw error;
      });
    return ready;
  }
  return {
    ...api,
    id: randomUUID,
    now,
    init,
    async transaction(fn, { retry = false } = {}) {
      const attempts = retry ? 3 : 1;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await db.$transaction((tx) => fn(client(tx)), {
            maxWait: 15000,
            timeout: 30000,
            isolationLevel: "Serializable",
          });
        } catch (error) {
          const conflict =
            error.code === "P2034" ||
            ["40001", "40P01"].includes(error.code) ||
            ["40001", "40P01"].includes(error.meta?.code);
          if (!conflict || attempt === attempts) throw error;
        }
      }
    },
  };
}
module.exports = { ...createStore(), createStore, CURRENT_MIGRATION };
