const {
  namespaceFor,
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
} = require("./shared");

function createVectorDatabase({ provider = "lancedb", config = {} } = {}) {
  if (
    !Object.hasOwn(
      require("../../enterprise/vector-config").vectorFields,
      provider
    )
  )
    throw new Error("不支持的向量数据库");
  const adapter = require("./records").create(provider, config);
  return {
    heartbeat: () => adapter.heartbeat(),
    async upsert(input = {}) {
      const records = validateRecords(input.records || []);
      if (!records.length) return 0;
      if (
        !validateNamespace(input.namespace) ||
        records.some(
          (record) =>
            namespaceFor({
              tenantId: record.tenantId,
              embeddingId: record.embeddingId,
              dimensions: record.vector.length,
            }) !== input.namespace
        )
      )
        throw new Error("记录与租户向量空间不匹配");
      return adapter.upsert({ ...input, records });
    },
    fetch: (input = {}) =>
      !input.namespace || !idFilter(input.ids).length
        ? Promise.resolve([])
        : adapter.fetch(input),
    search: (input = {}) => {
      const value = validateSearch(input);
      return value ? adapter.search(value) : Promise.resolve([]);
    },
    delete: (input = {}) =>
      !input.namespace || !idFilter(input.ids).length
        ? Promise.resolve(0)
        : adapter.delete(input),
  };
}
module.exports = { createVectorDatabase, namespaceFor };
