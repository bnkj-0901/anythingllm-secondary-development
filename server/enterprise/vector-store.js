const store = require("./store");
const { encrypt, decrypt } = require("./providers");
const { assertManagerContext, fail: authFailure } = require("./auth");
const {
  createVectorDatabase,
  namespaceFor,
} = require("../utils/vectorDbProviders");

const fail = authFailure;
const { normalizeVectorConfig, sameVectorStorage } = require("./vector-config");
const operationErrors = {
  heartbeat: "向量数据库连接失败，请核对配置与服务状态",
  upsert: "向量索引写入失败，请检查向量数据库连接与服务状态",
  fetch: "向量索引读取失败，请检查向量数据库连接与服务状态",
  search: "知识检索暂时不可用，请检查向量数据库连接与服务状态",
  delete: "向量索引清理失败，请检查向量数据库连接与服务状态",
};

// SDK errors can include credentials, URLs and their own HTTP status. Normalize
// only at the adapter boundary so application permission/version failures keep
// their existing semantics when a withDatabase/withWrite callback throws.
function createDatabase(value) {
  let adapter;
  try {
    adapter = createVectorDatabase(value);
  } catch {
    throw fail(502, "向量数据库初始化失败，请核对配置与服务状态");
  }
  return Object.fromEntries(
    Object.entries(operationErrors).map(([method, message]) => [
      method,
      async (...args) => {
        try {
          return await adapter[method](...args);
        } catch {
          throw fail(502, message);
        }
      },
    ])
  );
}

// Changing the platform backend must not race a document publication or search.
// This coordinates the current single API process; multi-instance rollout needs
// a shared lease before enabling configuration changes across processes.
let readers = 0;
let changing = false;
let waitingReaders = [];
let waitingWriter = null;
let changes = Promise.resolve();
let writes = Promise.resolve();
let cached;
async function read(task) {
  while (changing) await new Promise((resolve) => waitingReaders.push(resolve));
  readers++;
  try {
    return await task();
  } finally {
    readers--;
    if (!readers && waitingWriter) {
      waitingWriter();
      waitingWriter = null;
    }
  }
}
function exclusive(task) {
  const next = changes.then(async () => {
    changing = true;
    if (readers)
      await new Promise((resolve) => {
        waitingWriter = resolve;
      });
    try {
      return await task();
    } finally {
      changing = false;
      const pending = waitingReaders;
      waitingReaders = [];
      pending.forEach((resolve) => resolve());
    }
  });
  changes = next.catch(() => {});
  return next;
}
async function settings() {
  const row = await store.one(
    "SELECT * FROM ep_vector_settings WHERE id='platform'"
  );
  if (!row) throw fail(503, "向量数据库配置尚未初始化");
  let config;
  try {
    config = row.config ? JSON.parse(decrypt(row.config)) : {};
  } catch {
    throw fail(503, "向量数据库配置无法解密，请联系平台管理员");
  }
  return { provider: row.provider, config, revision: row.revision };
}
function database(value) {
  const key = JSON.stringify(value);
  if (cached?.key !== key) cached = { key, backend: createDatabase(value) };
  return cached.backend;
}
const withDatabase = (task) =>
  read(async () => {
    const value = await settings();
    return task(database(value), value);
  });
function withWrite(task) {
  const next = writes.then(() => withDatabase(task));
  writes = next.catch(() => {});
  return next;
}
async function describe() {
  return { provider: (await settings()).provider };
}
async function queueCleanup(tx, records) {
  for (const record of records)
    await tx.run(
      'INSERT INTO ep_vector_cleanup(id,"tenantId",namespace,"createdAt") VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      record.id,
      record.tenantId,
      record.namespace,
      store.now()
    );
}
async function flushCleanup(backend, strict = false) {
  const records = await store.all(
    'SELECT * FROM ep_vector_cleanup ORDER BY "createdAt",id'
  );
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.namespace)) groups.set(record.namespace, []);
    groups.get(record.namespace).push(record.id);
  }
  for (const [namespace, ids] of groups) {
    for (let start = 0; start < ids.length; start += 200) {
      const batch = ids.slice(start, start + 200);
      try {
        await backend.delete({ namespace, ids: batch });
        await store.transaction(
          async (tx) => {
            for (const id of batch)
              await tx.run(
                "DELETE FROM ep_vector_cleanup WHERE id=$1 AND namespace=$2",
                id,
                namespace
              );
          },
          { retry: true }
        );
      } catch {
        if (strict) throw fail(503, "向量索引清理尚未完成，请恢复连接后重试");
        return false;
      }
    }
  }
  return true;
}
async function recoverCleanup() {
  return withWrite((backend) => flushCleanup(backend));
}
// Determine which published documents need rebuilding at the selected backend.
// Switching storage never copies or destroys the live vectors in the old one.
async function verifyExistingIndexes(target) {
  const chunks = await store.all(`SELECT c.*, d."libraryId"
    FROM ep_chunks c JOIN ep_documents d ON d.id=c."documentId" AND d."tenantId"=c."tenantId"
    JOIN ep_libraries l ON l.id=d."libraryId" AND l."tenantId"=d."tenantId"
    ORDER BY c.namespace,c.id`);
  const groups = new Map();
  const affectedDocuments = new Set();
  for (const chunk of chunks) {
    if (!groups.has(chunk.namespace)) groups.set(chunk.namespace, []);
    groups.get(chunk.namespace).push(chunk);
  }
  for (const [namespace, rows] of groups) {
    for (let start = 0; start < rows.length; start += 200) {
      const batch = rows.slice(start, start + 200);
      const records = await target.fetch({
        namespace,
        ids: batch.map((row) => row.id),
      });
      const found = new Map(records.map((record) => [record.id, record]));
      for (const row of batch) {
        const record = found.get(row.id);
        if (
          records.length !== found.size ||
          !record ||
          !Array.isArray(record.vector) ||
          record.vector.length !== row.dimensions ||
          record.vector.some((value) => !Number.isFinite(value)) ||
          record.text !== row.content ||
          [
            "tenantId",
            "documentId",
            "version",
            "embeddingId",
            "libraryId",
          ].some((field) => record[field] !== row[field])
        )
          affectedDocuments.add(row.documentId);
      }
    }
  }
  return { chunks: chunks.length, affectedDocuments: affectedDocuments.size };
}
async function change(body, ctx) {
  const authorize = async (db = store) => {
    if (ctx?.identity !== "platform")
      throw fail(403, "向量数据库由平台管理员管理");
    await assertManagerContext(ctx, db);
  };
  return exclusive(async () => {
    await authorize();
    const current = await settings();
    if (!Number.isInteger(body?.revision) || body.revision !== current.revision)
      throw fail(409, "向量数据库配置已更新，请刷新后重试");
    const next = await normalizeVectorConfig(body, current);
    const target = createDatabase(next);
    await target.heartbeat();
    if (
      JSON.stringify(next) ===
      JSON.stringify({ provider: current.provider, config: current.config })
    )
      return {
        ok: true,
        provider: current.provider,
        revision: current.revision,
      };
    const verification = await verifyExistingIndexes(target);
    // An expired key must not block rotation when its replacement has proved
    // access to the same live data. Empty indexes cannot provide that proof.
    const cleanup =
      verification.chunks &&
      !verification.affectedDocuments &&
      sameVectorStorage(current, next)
        ? target
        : database(current);
    await flushCleanup(cleanup, true);
    await store.transaction(
      async (tx) => {
        await authorize(tx);
        const live = await tx.one(
          "SELECT revision FROM ep_vector_settings WHERE id='platform'"
        );
        if (live?.revision !== current.revision)
          throw fail(409, "向量数据库配置已更新，请刷新后重试");
        await tx.run(
          "UPDATE ep_vector_settings SET provider=$1,config=$2,revision=$3,\"updatedAt\"=$4 WHERE id='platform'",
          next.provider,
          encrypt(JSON.stringify(next.config)),
          current.revision + 1,
          store.now()
        );
      },
      { retry: true }
    );
    cached = null;
    return {
      ok: true,
      provider: next.provider,
      revision: current.revision + 1,
      reindexRequired: verification.affectedDocuments > 0,
      affectedDocuments: verification.affectedDocuments,
    };
  });
}
module.exports = {
  withDatabase,
  withWrite,
  describe,
  namespaceFor,
  queueCleanup,
  flushCleanup,
  recoverCleanup,
  settings,
  change,
};
