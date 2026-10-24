const {
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  quote,
  sqlFilter,
  metadata,
} = require("../shared");
const writeQueues = new Map();

// Keep the upstream LanceDb connection/search implementation in its provider
// class. Storage methods take explicit records and authorization filters;
// Workspace, embedding and cache orchestration belong to the business layer.
class LanceRecords {
  constructor(provider, config = {}) {
    this.provider = provider;
    this.queueKey = config.path || provider.uri;
  }
  connect() {
    return this.provider.connect();
  }
  distanceToSimilarity(distance) {
    return this.provider.distanceToSimilarity(distance);
  }
  serialized(fn) {
    // Multiple connection revisions can use the same directory in one process.
    // Serialize their first table creation too; native concurrent creates can
    // otherwise overwrite one another's initial rows.
    const result = (writeQueues.get(this.queueKey) || Promise.resolve()).then(
      fn
    );
    const settled = result.catch(() => {});
    writeQueues.set(this.queueKey, settled);
    settled.then(() => {
      if (writeQueues.get(this.queueKey) === settled)
        writeQueues.delete(this.queueKey);
    });
    return result;
  }
  async table(namespace) {
    if (!validateNamespace(namespace)) return null;
    const { client } = await this.connect();
    return (await this.provider.namespaceExists(client, namespace))
      ? client.openTable(namespace)
      : null;
  }
  async heartbeat() {
    await (await this.connect()).client.tableNames();
    return { ok: true, provider: "lancedb" };
  }
  async upsert({ namespace, records = [] } = {}) {
    if (!records.length) return 0;
    if (!validateNamespace(namespace)) throw new Error("向量命名空间无效");
    const unique = [
      ...new Map(
        validateRecords(records).map((record) => [
          record.id,
          { ...metadata(record), vector: record.vector },
        ])
      ).values(),
    ];
    return this.serialized(async () => {
      const { client } = await this.connect();
      await this.provider.updateOrCreateCollection(client, unique, namespace, {
        upsert: true,
      });
      return unique.length;
    });
  }
  async fetch({ namespace, ids } = {}) {
    const wanted = idFilter(ids);
    if (!wanted.length) return [];
    const target = await this.table(namespace);
    if (!target) return [];
    const rows = await target
      .query()
      .where(`id IN (${wanted.map(quote).join(",")})`)
      .toArray();
    return rows.map(({ vector, ...row }) => ({
      ...row,
      vector: Array.from(vector),
    }));
  }
  async search(input = {}) {
    const request = validateSearch(input);
    if (!request) return [];
    const target = await this.table(request.namespace);
    if (!target) return [];
    const rows = await target
      .vectorSearch(request.vector)
      .distanceType("cosine")
      .where(sqlFilter(request.filter))
      .limit(request.topK)
      .toArray();
    return rows
      .filter((row) => Number.isFinite(row._distance))
      .map((row) => ({
        id: row.id,
        score: this.distanceToSimilarity(row._distance),
      }))
      .filter(
        (row) => Number.isFinite(row.score) && row.score >= request.threshold
      );
  }
  async delete({ namespace, ids } = {}) {
    const wanted = idFilter(ids);
    if (!wanted.length) return 0;
    return this.serialized(async () => {
      const target = await this.table(namespace);
      if (!target) return 0;
      await target.delete(`id IN (${wanted.map(quote).join(",")})`);
      return wanted.length;
    });
  }
}
module.exports = {
  create: (config, provider) => new LanceRecords(provider, config),
};
