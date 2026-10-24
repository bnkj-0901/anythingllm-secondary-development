const path = require("path");
const { secretField } = require("./settings-environment");

// Translate the existing settings forms to stored connection values. Provider
// choices, field validation and environment names remain owned by updateENV.
const vectorFields = {
  lancedb: {},
  pgvector: {
    connectionString: "PGVectorConnectionString",
    tableName: "PGVectorTableName",
  },
  pinecone: { apiKey: "PineConeKey", indexName: "PineConeIndex" },
  chroma: {
    endpoint: "ChromaEndpoint",
    apiKey: "ChromaApiKey",
    authHeader: "ChromaApiHeader",
  },
  chromacloud: {
    apiKey: "ChromaCloudApiKey",
    projectId: "ChromaCloudTenant",
    indexName: "ChromaCloudDatabase",
  },
  weaviate: {
    endpoint: "WeaviateEndpoint",
    apiKey: "WeaviateApiKey",
    deployment: "WeaviateDeployment",
    grpcHost: "WeaviateGrpcHost",
    grpcPort: "WeaviateGrpcPort",
  },
  qdrant: { endpoint: "QdrantEndpoint", apiKey: "QdrantApiKey" },
  milvus: {
    address: "MilvusAddress",
    username: "MilvusUsername",
    password: "MilvusPassword",
  },
  zilliz: { address: "ZillizEndpoint", token: "ZillizApiToken" },
  astra: { endpoint: "AstraDBEndpoint", token: "AstraDBApplicationToken" },
};
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const rules = () => require("../utils/helpers/updateENV").KEY_MAPPING;

async function normalizeVectorConfig(body, current = {}) {
  const provider = body?.provider;
  const fields = vectorFields[provider];
  if (!Object.hasOwn(vectorFields, provider) || !fields)
    throw invalid("请选择有效的向量数据库");
  const config = body.config;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw invalid("请填写有效的向量数据库配置");
  const keys = Object.keys(fields);
  // LanceDB's path is a deployment setting; the upstream form has no path field.
  if (provider === "lancedb") keys.push("path");
  if (Object.keys(config).some((key) => !keys.includes(key)))
    throw invalid("向量数据库配置包含不支持的字段");
  const normalized = {};
  const mapping = rules();
  const { executeValidationChecks } = require("../utils/helpers/updateENV");
  for (const key of keys) {
    let value = config[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > 8192 || value.includes("\0"))
    )
      throw invalid("向量数据库配置值格式无效");
    if (typeof value === "string") value = value.trim();
    const field = fields[key];
    if (
      field &&
      secretField(field) &&
      (!value || /^\*+$/.test(value)) &&
      provider === current.provider
    )
      value = current.config?.[key];
    const checks = field ? mapping[field].checks : [];
    if (
      value !== undefined ||
      checks.some((check) =>
        [
          "isNotEmpty",
          "isValidURL",
          "looksLikePostgresConnectionString",
        ].includes(check.name)
      )
    ) {
      const errors = await executeValidationChecks(checks, value || "", false);
      if (errors.length) throw invalid(errors.join("\n"));
    }
    if (value) normalized[key] = value;
  }
  if (
    provider === "lancedb" &&
    normalized.path &&
    !path.isAbsolute(normalized.path)
  )
    throw invalid("LanceDB 存储目录必须为绝对路径");
  if (
    provider === "pgvector" &&
    normalized.tableName &&
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,59}$/.test(normalized.tableName)
  )
    throw invalid("PGVector 表名称格式无效");
  return { provider, config: normalized };
}

function environment(provider, config = {}) {
  const mapping = rules();
  const result = { VECTOR_DB: provider, STORAGE_DIR: process.env.STORAGE_DIR };
  for (const fields of Object.values(vectorFields))
    for (const field of Object.values(fields))
      result[mapping[field].envKey] = undefined;
  for (const [key, field] of Object.entries(vectorFields[provider] || {}))
    result[mapping[field].envKey] = config[key];
  result.LANCE_DB_PATH = provider === "lancedb" ? config.path : undefined;
  return result;
}

// Credential rotation may use the replacement client for cleanup only after
// all live IDs have also been checked. Matching an index name alone cannot
// establish a Pinecone project, and matching a URL alone cannot prove access.
function sameVectorStorage(current, next) {
  if (current.provider !== next.provider) return false;
  const provider = current.provider;
  const location = (config = {}) => {
    if (provider === "lancedb")
      return path.resolve(
        config.path ||
          path.resolve(
            process.env.STORAGE_DIR || path.resolve(__dirname, "../storage"),
            "lancedb"
          )
      );
    const values = Object.fromEntries(
      Object.entries(vectorFields[provider] || {})
        .filter(([, field]) => !secretField(field))
        .map(([key]) => [key, config[key] || ""])
    );
    if (provider === "pgvector") {
      const url = new URL(config.connectionString);
      url.username = "";
      url.password = "";
      values.connectionString = url.toString();
      values.tableName = config.tableName || "anythingllm_vectors";
    }
    return JSON.stringify(values);
  };
  try {
    return location(current.config) === location(next.config);
  } catch {
    return false;
  }
}

async function initializeVectorSettings(
  db = require("./store"),
  source = process.env
) {
  return db.transaction(
    async (tx) => {
      const current = await tx.one(
        "SELECT * FROM ep_vector_settings WHERE id='platform'"
      );
      if (
        !current ||
        current.provider !== "lancedb" ||
        current.config !== null ||
        current.revision !== 1
      )
        return false;
      const existing = await tx.one("SELECT COUNT(*) AS count FROM ep_chunks");
      const provider =
        Number(existing?.count) > 0 ? "lancedb" : source.VECTOR_DB || "lancedb";
      const config = {};
      const mapping = rules();
      if (!Object.hasOwn(vectorFields, provider))
        throw invalid("初始向量数据库类型无效");
      if (!Number(existing?.count)) {
        for (const [key, field] of Object.entries(vectorFields[provider])) {
          const value = source[mapping[field].envKey];
          if (value !== undefined) config[key] = value;
        }
        if (provider === "lancedb" && source.LANCE_DB_PATH)
          config.path = source.LANCE_DB_PATH;
      }
      const next = await normalizeVectorConfig({ provider, config });
      // Encrypted {} marks an initialized local default too. Subsequent boots
      // must never replace saved settings with changed container environment.
      await tx.run(
        "UPDATE ep_vector_settings SET provider=$1,config=$2,\"updatedAt\"=$3 WHERE id='platform' AND provider='lancedb' AND config IS NULL AND revision=1",
        next.provider,
        require("./providers").encrypt(JSON.stringify(next.config)),
        new Date().toISOString()
      );
      return true;
    },
    { retry: true }
  );
}

module.exports = {
  vectorFields,
  normalizeVectorConfig,
  environment,
  sameVectorStorage,
  initializeVectorSettings,
};
