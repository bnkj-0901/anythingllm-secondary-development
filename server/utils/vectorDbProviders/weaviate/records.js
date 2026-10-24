const { createHash } = require("crypto");
const { Filters } = require("weaviate-client");
const {
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  metadata,
} = require("../shared");

function objectId(namespace, id) {
  const hex = createHash("sha256").update(`${namespace}\0${id}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function collectionName(namespace) {
  return `Ep_${namespace.slice(3)}`;
}

function accessFilter(collection, { documentVersions }) {
  const equal = (key, value) => collection.filter.byProperty(key).equal(value);
  const { and, or } = Filters;
  return or(
    ...documentVersions.map(({ documentId, version }) =>
      and(equal("documentId", documentId), equal("version", version))
    )
  );
}

function create(_config, connection, provider) {
  async function client() {
    return connection.client;
  }
  async function collection(namespace, write = false) {
    const connection = await client();
    const name = collectionName(namespace);
    if (!(await connection.collections.exists(name))) {
      if (!write) return null;
      try {
        await connection.collections.createFromSchema({
          class: name,
          vectorizer: "none",
          vectorIndexConfig: { distance: "cosine" },
          properties: [
            "recordId",
            "tenantId",
            "documentId",
            "embeddingId",
            "libraryId",
            "text",
            "metadata",
          ]
            .map((field) => ({
              name: field,
              dataType: ["text"],
              tokenization: "field",
              indexFilterable: true,
            }))
            .concat({
              name: "version",
              dataType: ["int"],
              indexFilterable: true,
            }),
        });
      } catch (error) {
        if (!(await connection.collections.exists(name))) throw error;
      }
    }
    return connection.collections.get(name);
  }
  return {
    async heartbeat() {
      if (!(await (await client()).isLive()))
        throw new Error("Weaviate service is not live");
      return true;
    },
    async upsert({ namespace, records }) {
      if (!validateNamespace(namespace)) throw new Error("Invalid namespace");
      const rows = validateRecords(records);
      if (!rows.length) return 0;
      const target = await collection(namespace, true);
      // The SDK has no atomic bulk upsert. Stable IDs make interrupted retries safe.
      for (const record of rows) {
        const id = objectId(namespace, record.id);
        const { id: recordId, ...properties } = metadata(record);
        const object = {
          id,
          properties: { ...properties, recordId },
          vectors: record.vector,
        };
        if (await target.data.exists(id)) {
          await target.data.replace(object);
        } else {
          try {
            await target.data.insert(object);
          } catch (error) {
            // Only recover a concurrent insert; unrelated failures propagate.
            if (!(await target.data.exists(id))) throw error;
            await target.data.replace(object);
          }
        }
      }
      return rows.length;
    },
    async fetch({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return [];
      const target = await collection(namespace);
      if (!target) return [];
      const records = [];
      for (const id of selected) {
        const object = await target.query.fetchObjectById(
          objectId(namespace, id),
          {
            includeVector: true,
          }
        );
        if (!object) continue;
        const { recordId, ...properties } = object.properties;
        records.push({
          ...properties,
          id: recordId,
          vector: object.vectors.default,
        });
      }
      return records;
    },
    async search(args) {
      const query = validateSearch(args);
      if (!query) return [];
      const target = await collection(query.namespace);
      if (!target) return [];
      const result = await target.query.nearVector(query.vector, {
        filters: accessFilter(target, query.filter),
        limit: query.topK,
        distance: 1 - query.threshold,
        returnMetadata: ["distance"],
        returnProperties: ["recordId"],
      });
      return (result.objects || []).flatMap(({ properties, metadata }) => {
        const distance = metadata?.distance;
        const score = provider.distanceToSimilarity(distance);
        return typeof properties?.recordId === "string" &&
          Number.isFinite(distance) &&
          score >= query.threshold
          ? [{ id: properties.recordId, score }]
          : [];
      });
    },
    async delete({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return 0;
      const target = await collection(namespace);
      if (!target) return 0;
      for (const id of selected)
        await target.data.deleteById(objectId(namespace, id));
      return selected.length;
    },
  };
}

module.exports = { create };
