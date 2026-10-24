# Vector database adapters

This directory retains AnythingLLM's original provider classes and extends them
with `records()` for tenant-authorized knowledge records. Each provider's
`records.js` uses its existing connection and SDK; there is no parallel
`server/enterprise/vector-adapters` implementation.
`createVectorDatabase({ provider, config })` creates an independent adapter.
Connection fields and validation come from the existing settings mapping. Provider
selection and credentials use an asynchronous scope when the original classes read
their environment contract. Concurrent connections never mutate global settings.

## Common contract

An adapter exposes async `heartbeat()`, `upsert({ namespace, records })`,
`fetch({ namespace, ids })`, `search({ namespace, vector, filter, topK, threshold })`
and `delete({ namespace, ids })`. Fetch returns full records, including vectors,
so the application can verify existing records before changing the active connection.
Upsert uses stable IDs, making retry after an interrupted write safe. Delete
always requires explicit IDs; an empty selection never deletes a namespace.

Each record contains `id`, `vector`, `tenantId`, `documentId`, positive integer
`version`, `embeddingId`, `libraryId`, and `text`.
`tenantId` records the resource's storage origin, not the requesting user's
access boundary. `namespaceFor({ tenantId, embeddingId, dimensions })`
provides a stable `ep_` namespace. The public factory rejects writes whose
tenant, model identity or vector dimensions do not match that namespace.
Existing Workspace collections are never opened for enterprise data.

Search requires a server-derived filter:

```js
{
  documentVersions: [{ documentId: "document-id", version: 2 }],
}
```

Every backend applies the exact authorized document/version pairs **inside the
database query before topK**. The server derives these pairs from current
library grants, independently of storage origin. Adapters do not interpret
user identities, public/private flags, or ownership. Missing version filters
fail closed. An empty valid document set returns no results. Application code
supplies only authorized, currently active versions. Providers retain their upstream score normalization;
defaults are `topK: 4` and `threshold: 0.25`.

## Storage details

- LanceDB retains native local tables, mergeInsert and cosine vectorSearch.
  Writes to the same directory are serialized within the server process,
  including writes through different connection revisions. Use a single writer
  process per local storage directory; distributed write coordination is not
  provided by this adapter.
- PGVector uses the configured table name, parameterized SQL and native `<=>`
  cosine distance. Its vector column has no fixed dimensions to support multiple
  model namespaces. It uses exact native search without an ANN index; a future
  scale-based index change must preserve namespace/dimension filtering.
- Pinecone requires an existing cosine index; enterprise namespaces share that
  index. Its configured index dimension must match the embedding model.
- Chroma, Chroma Cloud and Qdrant use cosine collections named by namespace.
- Weaviate uses `Ep_` class names, field tokenization for exact metadata filters,
  and stable UUIDs with the application ID retained as `recordId`.
- Milvus and Zilliz share the upstream Milvus SDK, JSON metadata filters, cosine
  indexes and Strong consistency for verification and retrieval. Exact-ID delete
  uses escaped expressions because the pinned SDK's convenience delete method
  does not escape VarChar IDs.
- Astra DB uses cosine collections and converts its normalized similarity to
  the upstream clipped cosine score. Its collection name limit requires truncating the namespace to
  48 characters, retaining 180 hash bits. Fetch includes `$vector`; deletion
  uses exact IDs to avoid the pinned SDK's partial bulk-delete limit.

The application owns encrypted settings, connection revisions, serialized
mutations and tenant/resource authorization. Configuration changes do not copy
records between backends. With existing indexes, the proposed connection must
already expose the complete original records; a different physical backend
requires a separately planned migration or rebuild. Adapters do not read users,
tenants, documents, chat threads or global system settings.

## Verification

`vector-lance.test.js` exercises real temporary LanceDB storage. The
`cloud-vectors-a.test.js` and `cloud-vectors-b.test.js` suites exercise all nine
remote choices against their original connection and installed SDK contracts using mocks. They verify
pre-topK permissions with deliberately higher-scoring unauthorized records,
version pairing, idempotency, complete fetches, namespace isolation, empty-ID
safety, configuration, error propagation and retriable setup races. Remote
service availability and credentials require deployment-specific smoke checks.
