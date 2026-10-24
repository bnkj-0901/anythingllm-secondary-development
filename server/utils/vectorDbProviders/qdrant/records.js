const { createHash } = require("crypto");
const {
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  metadata,
} = require("../shared");

function pointId(namespace, id) {
  const hex = createHash("sha256").update(`${namespace}\0${id}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function accessFilter({ documentVersions }) {
  return {
    should: documentVersions.map(({ documentId, version }) => ({
      must: [
        { key: "documentId", match: { value: documentId } },
        { key: "version", match: { value: version } },
      ],
    })),
  };
}

function missing(error) {
  return error?.status === 404 || error?.statusCode === 404;
}

function create(_config, { client }) {
  const preparing = new Map();
  async function prepare(namespace, size) {
    if (preparing.has(namespace)) return preparing.get(namespace);
    const pending = (async () => {
      let collection;
      try {
        collection = await client.getCollection(namespace);
      } catch (error) {
        if (!missing(error)) throw error;
        try {
          await client.createCollection(namespace, {
            vectors: { size, distance: "Cosine" },
          });
        } catch (createError) {
          // Another worker may have created the same collection concurrently.
          if (createError?.status !== 409 && createError?.statusCode !== 409)
            throw createError;
        }
        collection = await client.getCollection(namespace);
      }
      const vectors = collection.config?.params?.vectors;
      if (vectors?.distance !== "Cosine" || vectors?.size !== size)
        throw new Error(
          "Qdrant collection vector configuration does not match"
        );
      for (const field_name of ["tenantId", "documentId", "version"])
        await client.createPayloadIndex(namespace, {
          field_name,
          field_schema: field_name === "version" ? "integer" : "keyword",
          wait: true,
        });
    })();
    preparing.set(namespace, pending);
    try {
      await pending;
    } catch (error) {
      preparing.delete(namespace);
      throw error;
    }
  }

  return {
    async heartbeat() {
      await client.getCollections();
      return true;
    },
    async upsert({ namespace, records }) {
      if (!validateNamespace(namespace)) throw new Error("Invalid namespace");
      const rows = validateRecords(records);
      if (!rows.length) return 0;
      await prepare(namespace, rows[0].vector.length);
      for (let i = 0; i < rows.length; i += 100)
        await client.upsert(namespace, {
          wait: true,
          points: rows.slice(i, i + 100).map((record) => ({
            id: pointId(namespace, record.id),
            vector: record.vector,
            payload: metadata(record),
          })),
        });
      return rows.length;
    },
    async fetch({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return [];
      try {
        const result = await client.retrieve(namespace, {
          ids: selected.map((id) => pointId(namespace, id)),
          with_payload: true,
          with_vector: true,
        });
        return result.map(({ payload, vector }) => ({ ...payload, vector }));
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
    async search(args) {
      const query = validateSearch(args);
      if (!query) return [];
      try {
        const result = await client.search(query.namespace, {
          vector: query.vector,
          filter: accessFilter(query.filter),
          limit: query.topK,
          score_threshold: query.threshold,
          with_payload: ["id"],
          with_vector: false,
        });
        return result
          .filter(
            ({ payload, score }) =>
              typeof payload?.id === "string" &&
              Number.isFinite(score) &&
              score >= query.threshold
          )
          .map(({ payload, score }) => ({ id: payload.id, score }));
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
    async delete({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return 0;
      try {
        for (let i = 0; i < selected.length; i += 1000)
          await client.delete(namespace, {
            wait: true,
            points: selected
              .slice(i, i + 1000)
              .map((id) => pointId(namespace, id)),
          });
        return selected.length;
      } catch (error) {
        if (missing(error)) return 0;
        throw error;
      }
    },
  };
}

module.exports = { create };
