const {
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  metadata,
} = require("../shared");

function accessFilter({ documentVersions }) {
  const versions = documentVersions.map(({ documentId, version }) => ({
    $and: [{ documentId: { $eq: documentId } }, { version: { $eq: version } }],
  }));
  return versions.length === 1 ? versions[0] : { $or: versions };
}

function create(config, connection) {
  const { client, pineconeIndex: index } = connection;
  let readiness;
  async function check() {
    const result = await client.describeIndex(config.indexName);
    if (!result.status?.ready) throw new Error("Pinecone index is not ready");
    return true;
  }
  function ensureReady() {
    if (!readiness)
      readiness = check().catch((error) => {
        readiness = null;
        throw error;
      });
    return readiness;
  }
  return {
    async heartbeat() {
      return check();
    },
    async upsert({ namespace, records }) {
      if (!validateNamespace(namespace)) throw new Error("Invalid namespace");
      const rows = validateRecords(records);
      if (!rows.length) return 0;
      await ensureReady();
      const target = index.namespace(namespace);
      for (let i = 0; i < rows.length; i += 100) {
        await target.upsert(
          rows.slice(i, i + 100).map((record) => ({
            id: record.id,
            values: record.vector,
            metadata: metadata(record),
          }))
        );
      }
      return rows.length;
    },
    async fetch({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return [];
      await ensureReady();
      const records = [];
      for (let i = 0; i < selected.length; i += 1000) {
        const result = await index
          .namespace(namespace)
          .fetch(selected.slice(i, i + 1000));
        for (const record of Object.values(result.records || {}))
          records.push({
            ...record.metadata,
            id: record.id,
            vector: record.values,
          });
      }
      return records;
    },
    async search(args) {
      const query = validateSearch(args);
      if (!query) return [];
      await ensureReady();
      const result = await index.namespace(query.namespace).query({
        vector: query.vector,
        filter: accessFilter(query.filter),
        topK: query.topK,
        includeValues: false,
        includeMetadata: false,
      });
      return (result.matches || [])
        .filter(
          ({ score }) => Number.isFinite(score) && score >= query.threshold
        )
        .map(({ id, score }) => ({ id, score }));
    },
    async delete({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return 0;
      await ensureReady();
      for (let i = 0; i < selected.length; i += 1000)
        await index
          .namespace(namespace)
          .deleteMany(selected.slice(i, i + 1000));
      return selected.length;
    },
  };
}

module.exports = { create };
