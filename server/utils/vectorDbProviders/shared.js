const { createHash } = require("crypto");

function identifier(value, label = "标识") {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 300 ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error(`${label}无效`);
  return value;
}
const validateNamespace = (value) =>
  typeof value === "string" && /^ep_[a-f0-9]{48}$/.test(value);
function namespaceFor({ tenantId, embeddingId, dimensions } = {}) {
  identifier(tenantId, "租户标识");
  identifier(embeddingId, "Embedding 标识");
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65536)
    throw new Error("向量维度无效");
  return `ep_${createHash("sha256")
    .update(JSON.stringify([tenantId, embeddingId, dimensions]))
    .digest("hex")
    .slice(0, 48)}`;
}
function vector(value) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 65536 ||
    value.some((number) => !Number.isFinite(number)) ||
    !value.some((number) => number !== 0)
  )
    throw new Error("向量数据无效");
  return value;
}
function validateRecords(records) {
  if (!Array.isArray(records)) throw new Error("向量记录必须为数组");
  return records.map((record) => {
    if (!record || typeof record !== "object") throw new Error("向量记录无效");
    const result = {};
    for (const field of [
      "id",
      "tenantId",
      "documentId",
      "embeddingId",
      "libraryId",
    ])
      result[field] = identifier(record[field], field);
    result.vector = [...vector(record.vector)];
    if (!Number.isInteger(record.version) || record.version < 1)
      throw new Error("资料版本无效");
    result.version = record.version;
    if (typeof record.text !== "string" || !record.text.length)
      throw new Error("知识分片正文无效");
    result.text = record.text;
    if (record.metadata !== undefined && record.metadata !== null) {
      if (typeof record.metadata !== "object" || Array.isArray(record.metadata))
        throw new Error("知识来源元数据无效");
      // Collector metadata belongs to the source; it cannot overwrite the
      // tenant, document version or other authorization fields above.
      result.metadata = JSON.parse(JSON.stringify(record.metadata));
    }
    return result;
  });
}
function idFilter(ids) {
  if (ids == null) return [];
  if (!Array.isArray(ids)) throw new Error("向量标识必须为数组");
  return [...new Set(ids.map((id) => identifier(id, "向量标识")))];
}
function metadata(record) {
  const { vector: _vector, ...rest } = record;
  // Scalar-only backends (including Chroma and Pinecone) can preserve the same
  // collector metadata as JSON without changing their filterable identity.
  return { ...rest, metadata: JSON.stringify(record.metadata ?? null) };
}
function restoreMetadata(record) {
  if (typeof record.metadata !== "string") return record;
  const { metadata: serialized, ...rest } = record;
  const source = JSON.parse(serialized);
  return source === null ? rest : { ...rest, metadata: source };
}
function validateSearch({
  namespace,
  vector: query,
  filter,
  topK = 4,
  threshold = 0.25,
} = {}) {
  if (!namespace) return null;
  if (!validateNamespace(namespace)) throw new Error("向量命名空间无效");
  vector(query);
  if (!filter || typeof filter !== "object")
    throw new Error("检索权限过滤条件缺失");
  if (!Array.isArray(filter.documentVersions))
    throw new Error("有效资料版本过滤条件缺失");
  const versions = new Map();
  for (const pair of filter.documentVersions) {
    const documentId = identifier(pair?.documentId, "资料标识");
    if (!Number.isInteger(pair.version) || pair.version < 1)
      throw new Error("资料版本无效");
    versions.set(`${documentId}:${pair.version}`, {
      documentId,
      version: pair.version,
    });
  }
  if (!Number.isSafeInteger(topK) || topK < 1)
    throw new Error("检索条数必须为正整数");
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1)
    throw new Error("相似度阈值无效");
  if (!versions.size) return null;
  return {
    namespace,
    vector: [...query],
    filter: { documentVersions: [...versions.values()] },
    topK,
    threshold,
  };
}
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
function sqlFilter(filter) {
  return `(${filter.documentVersions.map(({ documentId, version }) => `(\`documentId\` = ${quote(documentId)} AND version = ${version})`).join(" OR ")})`;
}
module.exports = {
  namespaceFor,
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  metadata,
  restoreMetadata,
  quote,
  sqlFilter,
};
