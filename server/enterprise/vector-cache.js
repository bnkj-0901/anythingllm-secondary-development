// Keep the original disk cache lifecycle, scoped to a document instead of its
// old global filename. Embedding identity is checked before any cached reuse.
function cacheKey({ tenantId, documentId }) {
  if (
    typeof tenantId !== "string" ||
    !tenantId ||
    typeof documentId !== "string" ||
    !documentId
  )
    throw new TypeError("Vector cache requires tenant and document identity");
  return JSON.stringify(["knowledge", tenantId, documentId]);
}

function validVector(vector, dimensions = vector?.length) {
  return (
    Array.isArray(vector) &&
    vector.length > 0 &&
    vector.length === dimensions &&
    vector.some((n) => n !== 0) &&
    vector.every((n) => Number.isFinite(n))
  );
}

async function cachedVectorInformation({
  backend,
  rows = [],
  chunks,
  identity,
  tenantId,
  documentId,
}) {
  const key = cacheKey({ tenantId, documentId });
  const byText = new Map();
  try {
    const cached = await require("../utils/files").cachedVectorInformation(key);
    for (const entry of Array.isArray(cached.chunks) ? cached.chunks : []) {
      if (
        entry.embeddingId === identity &&
        typeof entry.text === "string" &&
        validVector(entry.vector)
      )
        byText.set(entry.text, [...entry.vector]);
    }
  } catch {
    // A corrupt or unavailable optional cache must not prevent reindexing.
    console.warn("Unable to read the document embedding cache");
  }
  if (chunks.every((chunk) => byText.has(chunk)))
    return chunks.map((chunk) => byText.get(chunk));

  const groups = new Map();
  for (const row of rows) {
    if (
      row.tenantId !== tenantId ||
      row.documentId !== documentId ||
      row.embeddingId !== identity ||
      byText.has(row.content)
    )
      continue;
    if (!groups.has(row.namespace)) groups.set(row.namespace, []);
    groups.get(row.namespace).push(row);
  }
  for (const [namespace, selected] of groups) {
    for (let offset = 0; offset < selected.length; offset += 100) {
      const batch = selected.slice(offset, offset + 100);
      const expected = new Map(batch.map((row) => [row.id, row]));
      for (const record of await backend.fetch({
        namespace,
        ids: [...expected.keys()],
      })) {
        const row = expected.get(record.id);
        if (
          !row ||
          record.tenantId !== tenantId ||
          record.documentId !== documentId ||
          record.embeddingId !== identity ||
          record.version !== row.version ||
          record.text !== row.content ||
          !validVector(record.vector, row.dimensions)
        )
          continue;
        byText.set(row.content, [...record.vector]);
      }
    }
  }
  return chunks.map((chunk) => byText.get(chunk) || null);
}

async function storeVectorResult({
  chunks,
  vectors,
  identity,
  tenantId,
  documentId,
}) {
  const key = cacheKey({ tenantId, documentId });
  if (
    typeof identity !== "string" ||
    !identity ||
    !chunks.length ||
    chunks.length !== vectors.length ||
    chunks.some((text) => typeof text !== "string") ||
    vectors.some((vector) => !validVector(vector, vectors[0]?.length))
  )
    return false;
  try {
    await require("../utils/files").storeVectorResult(
      chunks.map((text, index) => ({
        text,
        vector: vectors[index],
        embeddingId: identity,
      })),
      key
    );
    return true;
  } catch {
    console.warn("Unable to store the document embedding cache");
    return false;
  }
}

async function purgeVectorCache({ tenantId, documentId }) {
  const key = cacheKey({ tenantId, documentId });
  try {
    await require("../utils/files").purgeVectorCache(key);
    return true;
  } catch {
    console.warn("Unable to purge the document embedding cache");
    return false;
  }
}

module.exports = {
  cachedVectorInformation,
  storeVectorResult,
  purgeVectorCache,
};
