const {
  runWithEnvironment,
} = require("../../enterprise/ai/connection-context");
const { environment } = require("../../enterprise/vector-config");
const { restoreMetadata } = require("./shared");
function create(provider, config = {}) {
  if (
    provider === "pgvector" &&
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,59}$/.test(
      config.tableName || "anythingllm_vectors"
    )
  )
    throw new Error("PGVector table name is invalid");
  const original = require("../helpers").getVectorDbClass(provider);
  const values = environment(provider, config);
  let adapter;
  async function records() {
    if (!adapter) {
      adapter = (async () => {
        return original.records(config);
      })().catch((error) => {
        adapter = null;
        throw error;
      });
    }
    return adapter;
  }
  return Object.fromEntries(
    ["heartbeat", "upsert", "fetch", "search", "delete"].map((method) => [
      method,
      (...args) =>
        runWithEnvironment(values, async () => {
          const result = await (await records())[method](...args);
          return method === "fetch" ? result.map(restoreMetadata) : result;
        }),
    ])
  );
}
module.exports = { create };
