const crypto = require("crypto");
const store = require("./store");
const { fail } = require("./auth");
const { deepFreeze } = require("./ai/provider-config");
const { embeddingChunkLimit } = require("./ai/options");
const runtime = require("./ai/runtime");
function key() {
  if (!process.env.SIG_KEY || !process.env.SIG_SALT)
    throw fail(503, "服务加密密钥未配置");
  return crypto.scryptSync(process.env.SIG_KEY, process.env.SIG_SALT, 32);
}
function encrypt(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const content = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    content.toString("base64"),
  ].join(".");
}
function decrypt(value) {
  if (!value) return "";
  const [iv, tag, data] = value.split(".").map((s) => Buffer.from(s, "base64"));
  const cipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
function hydrate(row) {
  let options, credentials;
  try {
    options =
      typeof row.options === "string"
        ? JSON.parse(row.options)
        : row.options || {};
    const value = decrypt(row.secret);
    try {
      credentials = JSON.parse(value);
    } catch {
      credentials = { apiKey: value };
    }
    if (
      !credentials ||
      typeof credentials !== "object" ||
      Array.isArray(credentials)
    )
      credentials = { apiKey: value };
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new Error("Invalid options");
  } catch {
    throw fail(503, "保存的模型配置无法读取，请联系管理员重新保存连接");
  }
  return deepFreeze({
    id: row.id,
    version: row.version,
    kind: row.kind,
    provider: row.provider,
    config: {
      model: row.model,
      baseUrl: row.baseUrl,
      apiKey: credentials.apiKey || "",
      headers: credentials.headers || {},
      options,
      ...(credentials.upstreamEnvironment
        ? {
            upstreamEnvironment:
              require("./settings-environment").sanitizeUpstreamEnvironment(
                credentials.upstreamEnvironment
              ),
          }
        : {}),
    },
  });
}
async function resolveConnection(ctx, kind, options = {}) {
  // V1 shares platform-managed credentials; tenant settings only select models.
  const row = await store.one(
    "SELECT * FROM ep_connections WHERE scope='platform' AND kind=$1 AND \"isDefault\"=1",
    kind
  );
  if (!row)
    throw fail(
      422,
      `尚未配置${kind === "chat" ? "聊天模型" : "Embedding"}，请管理员在 AI 配置中设置默认连接`
    );
  if (!row.available) throw fail(422, "默认 AI 连接已停用，请联系管理员");
  const connection = hydrate(row);
  return kind === "chat"
    ? runtime.prepareChatConnection(connection, options)
    : connection;
}
const connectionIdentity = (c) => `${c.id}:${c.version}`;
async function embed(connection, texts, options = {}) {
  if (!Array.isArray(texts) || texts.some((text) => typeof text !== "string"))
    throw fail(400, "Embedding 输入必须为文本数组");
  if (!texts.length) return [];
  const vectors = await runtime.embed(connection, texts, options);
  if (
    !Array.isArray(vectors) ||
    vectors.length !== texts.length ||
    vectors.some(
      (v) =>
        !Array.isArray(v) ||
        !v.length ||
        v.some((n) => !Number.isFinite(n)) ||
        !v.some((n) => n !== 0)
    ) ||
    new Set(vectors.map((v) => v.length)).size !== 1
  )
    throw fail(502, "Embedding 服务返回的向量无效");
  return vectors;
}
module.exports = {
  resolveConnection,
  connectionIdentity,
  embed,
  complete: runtime.complete,
  compress: runtime.compress,
  encrypt,
  decrypt,
  hydrate,
  embeddingChunkLimit,
};
