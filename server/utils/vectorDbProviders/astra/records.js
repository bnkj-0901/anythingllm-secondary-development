const {
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  metadata,
} = require("../shared");

function accessFilter({ documentVersions }) {
  const versions = documentVersions.map(({ documentId, version }) => ({
    $and: [
      { "metadata.documentId": { $eq: documentId } },
      { "metadata.version": { $eq: version } },
    ],
  }));
  return versions.length === 1 ? versions[0] : { $or: versions };
}
function missing(error) {
  return error?.errors?.some(
    ({ errorCode }) => errorCode === "COLLECTION_NOT_EXIST"
  );
}
const collectionName = (namespace) => namespace.slice(0, 48);
function create(config = {}, { client }, provider) {
  const db = client.db(config.database);
  const preparing = new Map();
  const collections = async () =>
    (
      await db.httpClient.executeCommand(
        { findCollections: { options: { explain: true } } },
        new Set(["explain"])
      )
    ).status.collections;
  async function prepare(namespace, dimension) {
    if (preparing.has(namespace)) return preparing.get(namespace);
    const name = collectionName(namespace);
    const pending = (async () => {
      let existing = (await collections()).find((item) => item.name === name);
      if (!existing) {
        try {
          await db.createCollection(name, {
            vector: { dimension, metric: "cosine" },
          });
          return;
        } catch (error) {
          existing = (await collections()).find((item) => item.name === name);
          if (!existing) throw error;
        }
      }
      if (
        existing.options?.vector?.dimension !== dimension ||
        existing.options?.vector?.metric !== "cosine"
      )
        throw new Error("Astra collection vector configuration does not match");
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
      await collections();
      return true;
    },
    async upsert({ namespace, records }) {
      if (!validateNamespace(namespace)) throw new Error("Invalid namespace");
      const rows = validateRecords(records);
      if (!rows.length) return 0;
      await prepare(namespace, rows[0].vector.length);
      const collection = db.collection(collectionName(namespace));
      for (const record of rows)
        await collection.findOneAndReplace(
          { _id: record.id },
          {
            _id: record.id,
            $vector: record.vector,
            metadata: metadata(record),
          },
          { upsert: true }
        );
      return rows.length;
    },
    async fetch({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return [];
      try {
        const rows = [];
        for (let i = 0; i < selected.length; i += 100)
          rows.push(
            ...(await db
              .collection(collectionName(namespace))
              .find(
                { _id: { $in: selected.slice(i, i + 100) } },
                { projection: { _id: 1, metadata: 1, $vector: 1 } }
              )
              .toArray())
          );
        return rows.map((row) => ({ ...row.metadata, vector: row.$vector }));
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
    async search(args) {
      const query = validateSearch(args);
      if (!query) return [];
      try {
        const rows = await db
          .collection(collectionName(query.namespace))
          .find(accessFilter(query.filter), {
            sort: { $vector: query.vector },
            limit: query.topK,
            projection: { _id: 1 },
            includeSimilarity: true,
          })
          .toArray();
        // Astra normalizes cosine to [0, 1]; the public contract uses [-1, 1].
        return rows
          .map((row) => ({
            id: row._id,
            score: provider.similarityToScore(row.$similarity),
          }))
          .filter(
            ({ score }) => Number.isFinite(score) && score >= query.threshold
          );
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
    },
    async delete({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return 0;
      try {
        // The pinned SDK's deleteMany throws when Data API reports moreData.
        // Exact-ID deletes avoid its server-side batch limit and partial deletes.
        let count = 0;
        const collection = db.collection(collectionName(namespace));
        for (const id of selected)
          count += (await collection.deleteOne({ _id: id })).deletedCount;
        return count;
      } catch (error) {
        if (missing(error)) return 0;
        throw error;
      }
    },
  };
}

module.exports = { create };
