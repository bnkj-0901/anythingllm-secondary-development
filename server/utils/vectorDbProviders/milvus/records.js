const {
  DataType,
  MetricType,
  IndexType,
  ConsistencyLevelEnum,
} = require("@zilliz/milvus2-sdk-node");
const {
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  metadata,
} = require("../shared");

function checked(response) {
  const status = response?.status || response;
  if (
    status?.error_code !== undefined &&
    ![0, "0", "Success"].includes(status.error_code)
  )
    throw new Error(status.reason || "Milvus request failed");
  return response;
}

function accessFilter({ documentVersions }) {
  const equal = (field, value) =>
    `metadata[${JSON.stringify(field)}] == ${JSON.stringify(value)}`;
  return `(${documentVersions.map(({ documentId, version }) => `(${equal("documentId", documentId)} and ${equal("version", version)})`).join(" or ")})`;
}

function create(_config, { client }, provider) {
  const preparing = new Map();
  async function collection(namespace, dimensions) {
    if (preparing.has(namespace)) return preparing.get(namespace);
    const pending = (async () => {
      const existing = checked(
        await client.hasCollection({
          collection_name: provider.normalize(namespace),
        })
      );
      if (!existing.value) {
        if (!dimensions) return false;
        try {
          checked(
            await client.createCollection({
              collection_name: provider.normalize(namespace),
              consistency_level: "Strong",
              fields: [
                {
                  name: "id",
                  data_type: DataType.VarChar,
                  is_primary_key: true,
                  max_length: 1200,
                },
                {
                  name: "vector",
                  data_type: DataType.FloatVector,
                  dim: dimensions,
                },
                { name: "metadata", data_type: DataType.JSON },
              ],
            })
          );
        } catch (error) {
          if (
            !checked(
              await client.hasCollection({
                collection_name: provider.normalize(namespace),
              })
            ).value
          )
            throw error;
        }
      }
      checked(
        await client.createIndex({
          collection_name: provider.normalize(namespace),
          field_name: "vector",
          index_type: IndexType.AUTOINDEX,
          metric_type: MetricType.COSINE,
        })
      );
      checked(
        await client.loadCollectionSync({
          collection_name: provider.normalize(namespace),
        })
      );
      return true;
    })();
    preparing.set(namespace, pending);
    try {
      const exists = await pending;
      if (!exists) preparing.delete(namespace);
      return exists;
    } catch (error) {
      preparing.delete(namespace);
      throw error;
    }
  }
  return {
    async heartbeat() {
      const health = await client.checkHealth();
      if (!health.isHealthy) throw new Error("Milvus service is unhealthy");
      return true;
    },
    async upsert({ namespace, records }) {
      if (!validateNamespace(namespace)) throw new Error("Invalid namespace");
      const rows = validateRecords(records);
      if (!rows.length) return 0;
      await collection(namespace, rows[0].vector.length);
      for (let i = 0; i < rows.length; i += 100) {
        const result = checked(
          await client.upsert({
            collection_name: provider.normalize(namespace),
            data: rows.slice(i, i + 100).map((record) => ({
              id: record.id,
              vector: record.vector,
              metadata: metadata(record),
            })),
          })
        );
        if (result.err_index?.length)
          throw new Error("Milvus upsert was only partially accepted");
      }
      return rows.length;
    },
    async fetch({ namespace, ids }) {
      const selected = idFilter(ids);
      if (
        !validateNamespace(namespace) ||
        !selected.length ||
        !(await collection(namespace))
      )
        return [];
      const result = checked(
        await client.query({
          collection_name: provider.normalize(namespace),
          filter: `id in ${JSON.stringify(selected)}`,
          output_fields: ["id", "vector", "metadata"],
          consistency_level: ConsistencyLevelEnum.Strong,
        })
      );
      return result.data.map((record) => ({
        ...record.metadata,
        vector: record.vector,
      }));
    },
    async search(args) {
      const query = validateSearch(args);
      if (!query || !(await collection(query.namespace))) return [];
      const result = checked(
        await client.search({
          collection_name: provider.normalize(query.namespace),
          vector: query.vector,
          filter: accessFilter(query.filter),
          output_fields: ["id"],
          metric_type: MetricType.COSINE,
          limit: query.topK,
          consistency_level: ConsistencyLevelEnum.Strong,
        })
      );
      return result.results
        .filter(
          ({ score }) => Number.isFinite(score) && score >= query.threshold
        )
        .map(({ id, score }) => ({ id, score }));
    },
    async delete({ namespace, ids }) {
      const selected = idFilter(ids);
      if (
        !validateNamespace(namespace) ||
        !selected.length ||
        !(await collection(namespace))
      )
        return 0;
      const result = checked(
        // The pinned SDK delete(ids) joins VarChar IDs without escaping quotes.
        await client.deleteEntities({
          collection_name: provider.normalize(namespace),
          expr: `id in ${JSON.stringify(selected)}`,
        })
      );
      return Number(result.delete_cnt || 0);
    },
  };
}

module.exports = { create };
