const {
  NativeEmbeddingReranker,
} = require("../utils/EmbeddingRerankers/native");
let client;
async function rerank(query, sources, { topK, signal } = {}) {
  if (!sources.length) return [];
  signal?.throwIfAborted();
  try {
    client ||= new NativeEmbeddingReranker();
    const result = await client.rerank(query, sources, { topK, signal });
    signal?.throwIfAborted();
    return result.map((source, index) => ({
      ...source,
      citationNumber: index + 1,
    }));
  } catch {
    signal?.throwIfAborted();
    // Match the original provider's failed-rerank behavior without masking
    // request cancellation or exposing model paths from native errors.
    console.error("[Reranker] Unable to rerank the retrieved sources.");
    return [];
  }
}
module.exports = { rerank };
