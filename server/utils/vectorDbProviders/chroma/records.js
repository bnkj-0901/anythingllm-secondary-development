const {
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  metadata,
} = require("../shared");

const noEmbedding = {
  generate() {
    throw new Error(
      "Vectors must be supplied by the configured embedding model"
    );
  },
};

function accessFilter({ documentVersions }) {
  const versions = documentVersions.map(({ documentId, version }) => ({
    $and: [{ documentId: { $eq: documentId } }, { version: { $eq: version } }],
  }));
  return versions.length === 1 ? versions[0] : { $or: versions };
}

function missing(error) {
  return error?.status === 404 || error?.name === "ChromaNotFoundError";
}

function createAdapter(client, provider) {
  async function collection(namespace, write = false) {
    const options = {
      name: provider.normalize(namespace),
      embeddingFunction: noEmbedding,
    };
    let result;
    try {
      result = write
        ? await client.getOrCreateCollection({
            ...options,
            metadata: { "hnsw:space": "cosine" },
            configuration: { hnsw: { space: "cosine" } },
          })
        : await client.getCollection(options);
    } catch (error) {
      if (!write && missing(error)) return null;
      throw error;
    }
    const space =
      result.configuration?.hnsw?.space || result.metadata?.["hnsw:space"];
    if (space !== "cosine")
      throw new Error("Chroma collection must use the cosine metric");
    return result;
  }
  return {
    async heartbeat() {
      await client.heartbeat();
      return true;
    },
    async upsert({ namespace, records }) {
      if (!validateNamespace(namespace)) throw new Error("Invalid namespace");
      const rows = validateRecords(records);
      if (!rows.length) return 0;
      const target = await collection(namespace, true);
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        await provider.smartAdd(
          { add: (submission) => target.upsert(submission) },
          {
            ids: batch.map(({ id }) => id),
            embeddings: batch.map(({ vector }) => vector),
            documents: batch.map(({ text }) => text),
            metadatas: batch.map((record) =>
              Object.fromEntries(
                Object.entries(metadata(record)).filter(
                  ([key, value]) => key !== "text" && value !== null
                )
              )
            ),
          }
        );
      }
      return rows.length;
    },
    async fetch({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return [];
      const target = await collection(namespace);
      if (!target) return [];
      const result = await target.get({
        ids: selected,
        include: ["embeddings", "metadatas", "documents"],
      });
      return result.ids.map((id, i) => ({
        ...result.metadatas[i],
        id,
        text: result.documents[i],
        vector: result.embeddings[i],
      }));
    },
    async search(args) {
      const query = validateSearch(args);
      if (!query) return [];
      const target = await collection(query.namespace);
      if (!target) return [];
      const result = await target.query({
        queryEmbeddings: [query.vector],
        where: accessFilter(query.filter),
        nResults: query.topK,
        include: ["distances"],
      });
      return (result.ids[0] || []).flatMap((id, i) => {
        const distance = result.distances?.[0]?.[i];
        const score = provider.distanceToSimilarity(distance);
        return Number.isFinite(distance) && score >= query.threshold
          ? [{ id, score }]
          : [];
      });
    },
    async delete({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return 0;
      const target = await collection(namespace);
      if (!target) return 0;
      await provider.smartDelete(target, selected);
      return selected.length;
    },
  };
}

module.exports = {
  create: (_config, connection, provider) =>
    createAdapter(connection.client, provider),
};
