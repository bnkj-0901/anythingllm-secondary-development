const { v5: uuidv5 } = require("uuid");
const {
  validateNamespace,
  validateRecords,
  validateSearch,
  idFilter,
  metadata,
} = require("../shared");

function create(config = {}, provider) {
  const tableName = config.tableName || "anythingllm_vectors";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,59}$/.test(tableName))
    throw new Error("PGVector table name is invalid");
  // Honor the same table configured in the original provider. Tenant/model
  // namespaces isolate records; they do not require a second physical table.
  const table = `"${tableName}"`;
  // The upstream table has a UUID primary key. Scope logical record IDs to
  // their namespace while retaining the caller's ID in metadata.
  const physicalId = (namespace, id) =>
    uuidv5(JSON.stringify([namespace, id]), uuidv5.URL);
  async function connected(operation) {
    const client = await provider.connect();
    try {
      return await operation(client);
    } finally {
      await client.end();
    }
  }
  const absent = (error) => error?.code === "42P01";
  return {
    async heartbeat() {
      await connected((client) => client.query("SELECT 1"));
      return true;
    },
    async upsert({ namespace, records }) {
      if (!validateNamespace(namespace)) throw new Error("Invalid namespace");
      const rows = validateRecords(records);
      if (!rows.length) return 0;
      // PostgreSQL JSONB rejects NUL. Reject before any writes rather than
      // silently changing text and breaking migration verification/citations.
      if (
        rows.some((record) =>
          Object.values(metadata(record)).some(
            (value) => typeof value === "string" && value.includes("\0")
          )
        )
      )
        throw new Error("PGVector metadata cannot contain NUL characters");
      return connected(async (client) => {
        // The original provider owns the schema. Model-specific namespaces can
        // have different dimensions in the same unconstrained vector column.
        await provider.createTableIfNotExists(client, null);
        await client.query("BEGIN");
        try {
          for (const record of rows)
            await client.query(
              `INSERT INTO ${table} (namespace, id, embedding, metadata)
               VALUES ($1, $2, $3::vector, $4::jsonb)
               ON CONFLICT (id) DO UPDATE
               SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata
               WHERE ${table}.namespace = EXCLUDED.namespace`,
              [
                namespace,
                physicalId(namespace, record.id),
                JSON.stringify(record.vector),
                JSON.stringify(metadata(record)),
              ]
            );
          await client.query("COMMIT");
          return rows.length;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    },
    async fetch({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return [];
      try {
        return await connected(async (client) => {
          const result = await client.query(
            `SELECT metadata, embedding::text AS vector FROM ${table}
             WHERE namespace = $1 AND id::text = ANY($2::text[])`,
            [namespace, selected.map((id) => physicalId(namespace, id))]
          );
          return result.rows.map((row) => ({
            ...row.metadata,
            vector:
              typeof row.vector === "string"
                ? JSON.parse(row.vector)
                : row.vector,
          }));
        });
      } catch (error) {
        if (absent(error)) return [];
        throw error;
      }
    },
    async search(args) {
      const query = validateSearch(args);
      if (!query) return [];
      const values = [JSON.stringify(query.vector), query.namespace];
      const versions = query.filter.documentVersions.map(
        ({ documentId, version }) => {
          values.push(documentId, version);
          return `(metadata->>'documentId' = $${values.length - 1} AND (metadata->>'version')::integer = $${values.length})`;
        }
      );
      values.push(query.topK);
      try {
        return await connected(async (client) => {
          const result = await client.query(
            `SELECT metadata->>'id' AS id, 1 - (embedding <=> $1::vector) AS score FROM ${table}
             WHERE namespace = $2 AND (${versions.join(" OR ")})
             ORDER BY embedding <=> $1::vector ASC LIMIT $${values.length}`,
            values
          );
          return result.rows
            .map(({ id, score }) => ({
              id,
              score: provider.distanceToSimilarity(1 - Number(score)),
            }))
            .filter(
              ({ score }) => Number.isFinite(score) && score >= query.threshold
            );
        });
      } catch (error) {
        if (absent(error)) return [];
        throw error;
      }
    },
    async delete({ namespace, ids }) {
      const selected = idFilter(ids);
      if (!validateNamespace(namespace) || !selected.length) return 0;
      try {
        const result = await connected((client) =>
          client.query(
            `DELETE FROM ${table} WHERE namespace = $1 AND id::text = ANY($2::text[])`,
            [namespace, selected.map((id) => physicalId(namespace, id))]
          )
        );
        return result.rowCount;
      } catch (error) {
        if (absent(error)) return 0;
        throw error;
      }
    },
  };
}

module.exports = { create };
