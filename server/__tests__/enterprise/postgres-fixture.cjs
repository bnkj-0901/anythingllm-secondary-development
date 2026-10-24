const { randomUUID } = require("crypto");
const path = require("path");
const { spawnSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");

// Each suite owns one schema in an explicitly supplied disposable database.
// Developer .env files and production databases are never discovered here.
async function createPostgresFixture({ migrate = true } = {}) {
  if (!process.env.EP_TEST_DATABASE_URL)
    throw new Error(
      "EP_TEST_DATABASE_URL must point to an isolated PostgreSQL test database"
    );
  const schema = `ep_test_${randomUUID().replace(/-/g, "")}`;
  const url = new URL(process.env.EP_TEST_DATABASE_URL);
  url.searchParams.set("schema", schema);
  const admin = new PrismaClient({
    datasources: { db: { url: process.env.EP_TEST_DATABASE_URL } },
  });
  const prisma = new PrismaClient({
    datasources: { db: { url: url.toString() } },
  });
  const cleanup = async () => {
    await prisma.$disconnect();
    if (!/^ep_test_[a-f0-9]{32}$/.test(schema))
      throw new Error("Refusing to drop an unrecognized test schema");
    try {
      await admin.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`
      );
    } finally {
      await admin.$disconnect();
    }
  };
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    if (migrate) {
      const result = spawnSync(
        process.execPath,
        [
          require.resolve("prisma/build/index.js"),
          "migrate",
          "deploy",
          "--schema",
          path.resolve(__dirname, "../../prisma/schema.prisma"),
        ],
        {
          env: { ...process.env, DATABASE_URL: url.toString() },
          windowsHide: true,
          encoding: "utf8",
          timeout: 60000,
        }
      );
      if (result.error || result.status !== 0)
        throw new Error("Failed to deploy the PostgreSQL test baseline");
    }
    const { createStore } =
      typeof jest === "undefined"
        ? require("../../enterprise/store")
        : jest.requireActual("../../enterprise/store");
    const db = createStore(prisma);
    return { prisma, db, schema, url: url.toString(), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = { createPostgresFixture };
