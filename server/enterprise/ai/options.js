const { fail } = require("../auth");
const { NativeEmbedder } = require("../../utils/EmbeddingEngines/native");
const { providerClass } = require("./provider-config");
const { runConnection } = require("./connection-context");
function embeddingChunkLimit(connection) {
  if (connection.provider === "native") {
    const supported =
      NativeEmbedder.supportedModels[connection.config.model]
        ?.embeddingMaxChunkLength || 1000;
    return Math.min(
      connection.config.options?.maxChunkLength || supported,
      supported
    );
  }
  const Class = providerClass(connection.provider, "embedding");
  if (!Class) throw fail(400, "连接类型或供应商无效");
  const limit = runConnection(
    connection,
    {},
    () => new Class().embeddingMaxChunkLength
  );
  return Math.min(connection.config.options?.maxChunkLength || limit, limit);
}
module.exports = { embeddingChunkLimit };
