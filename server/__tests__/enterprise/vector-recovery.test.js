const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const express = require("express");
const jwt = require("jsonwebtoken");
const { requestJson } = require("./http-test-client.cjs");

let mockFixture, mockPgStore;
const mockStore = {
  get orm() {
    return mockPgStore.orm;
  },
  all: (...args) => mockPgStore.all(...args),
  one: (...args) => mockPgStore.one(...args),
  run: (...args) => mockPgStore.run(...args),
  transaction: (...args) => mockPgStore.transaction(...args),
  id: () => require("crypto").randomUUID(),
  now: () => new Date().toISOString(),
};
let mockDeletionFailure = false;
const mockUpserts = jest.fn();
const mockDeletes = jest.fn();
const mockProviders = {
  encrypt: (...args) =>
    jest.requireActual("../../enterprise/providers").encrypt(...args),
  decrypt: (...args) =>
    jest.requireActual("../../enterprise/providers").decrypt(...args),
  resolveConnection: async (_ctx, kind) => ({ id: kind, version: 1 }),
  connectionIdentity: (connection) => `${connection.id}:${connection.version}`,
  embeddingChunkLimit: () => 8192,
  embed: async (_connection, texts) => texts.map(() => [1, 0, 0]),
};
jest.mock("../../enterprise/store", () => mockStore);
jest.mock("../../enterprise/providers", () => mockProviders);
jest.mock("../../utils/vectorDbProviders", () => ({
  ...jest.requireActual("../../utils/vectorDbProviders"),
  createVectorDatabase: (config) => {
    const native = jest
      .requireActual("../../utils/vectorDbProviders")
      .createVectorDatabase(config);
    return {
      ...native,
      upsert: async (request) => {
        mockUpserts(request);
        return native.upsert(request);
      },
      delete: async (request) => {
        mockDeletes(request);
        if (mockDeletionFailure)
          throw new Error("temporary vector delete outage");
        return native.delete(request);
      },
    };
  },
}));
const vectorStore = require("../../enterprise/vector-store");
const knowledge = require("../../enterprise/knowledge");
const rag = require("../../enterprise/rag");
const { namespaceFor } = jest.requireActual("../../utils/vectorDbProviders");

const ctx = { tenantId: "tenant", userId: 1 };
const embedding = { id: "embedding", version: 1 };
const namespace = namespaceFor({
  tenantId: ctx.tenantId,
  embeddingId: "embedding:1",
  dimensions: 3,
});
const content =
  "The currently authorized knowledge should remain retrievable after recovery.";
let directory, listener, base, environment, token;
let revision = 0;

async function crashedAttempt() {
  const record = {
    id: `orphan-${randomUUID()}`,
    vector: [1, 0, 0],
    tenantId: ctx.tenantId,
    documentId: "document",
    version: 1,
    embeddingId: "embedding:1",
    libraryId: "library",
    ownerId: ctx.userId,
    text: content,
  };
  // Reproduce a crash after the durable outbox and vector upsert, before the
  // transaction that would publish chunk IDs and mark the document ready.
  await mockStore.transaction((tx) =>
    vectorStore.queueCleanup(tx, [{ ...record, namespace }])
  );
  await vectorStore.withWrite((db) =>
    db.upsert({ namespace, records: [record] })
  );
  expect(
    await vectorStore.withDatabase((db) =>
      db.fetch({ namespace, ids: [record.id] })
    )
  ).toHaveLength(1);
  mockUpserts.mockClear();
  mockDeletes.mockClear();
  return record;
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const document = await mockStore.one(
      "SELECT * FROM ep_documents WHERE id='document'"
    );
    if (document.status === "ready") return document;
    if (document.status === "failed") throw new Error(document.error);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Recovery did not publish the document");
}
async function assertRecovered(orphan, version) {
  const document = await ready();
  expect(document.version).toBe(version);
  const chunks = await mockStore.all(
    "SELECT id,version FROM ep_chunks WHERE \"documentId\"='document'"
  );
  expect(chunks).toHaveLength(1);
  expect(chunks[0].id).not.toBe(orphan.id);
  expect(chunks[0].version).toBe(version);
  expect(await mockStore.all("SELECT * FROM ep_vector_cleanup")).toEqual([]);
  expect(
    await vectorStore.withDatabase((db) =>
      db.fetch({ namespace, ids: [orphan.id] })
    )
  ).toEqual([]);
  const matches = await rag.retrieve(ctx, "Find the knowledge", embedding, {
    topK: 1,
    similarityThreshold: 0.3,
  });
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ id: chunks[0].id });
  expect(matches[0].text).toContain(content);
}

beforeAll(async () => {
  environment = Object.fromEntries(
    [
      "JWT_SECRET",
      "SIG_KEY",
      "SIG_SALT",
      "TENANT_BASE_DOMAIN",
      "PLATFORM_HOSTS",
    ].map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, {
    JWT_SECRET: "recovery-jwt",
    SIG_KEY: "recovery-key",
    SIG_SALT: "recovery-salt",
    TENANT_BASE_DOMAIN: "localhost",
    PLATFORM_HOSTS: "localhost",
  });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ep-vector-recovery-"));
  mockFixture = await createPostgresFixture();
  mockPgStore = mockFixture.db;

  const stamp = new Date().toISOString();
  await mockStore.run(
    "INSERT INTO ep_tenants(id,code,name,hostname,\"createdAt\",\"updatedAt\") VALUES('tenant','tenant-a','Tenant','tenant-a.localhost',$1,$2)",
    stamp,
    stamp
  );
  await mockStore.run(
    "INSERT INTO users(id,\"tenantId\",username,name,\"passwordHash\",role,\"createdAt\",\"lastUpdatedAt\") VALUES(1,'tenant','user','User','unused','admin',NOW(),NOW())"
  );
  await mockStore.run(
    "INSERT INTO ep_libraries(id,\"tenantId\",name,\"createdBy\",\"createdAt\",\"updatedAt\") VALUES('library','tenant','Library','user',$1,$2)",
    stamp,
    stamp
  );
  await mockStore.run(
    'INSERT INTO ep_vector_settings(id,provider,config,revision,"updatedAt") VALUES(\'platform\',\'lancedb\',NULL,1,$1) ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider, config=EXCLUDED.config, revision=EXCLUDED.revision, "updatedAt"=EXCLUDED."updatedAt"',
    stamp
  );
  token = jwt.sign(
    { identity: "tenant", tenantId: ctx.tenantId, ver: 1 },
    process.env.JWT_SECRET,
    { subject: String(ctx.userId), audience: "enterprise-tenant-v1" }
  );
  await mockStore.run(
    "INSERT INTO ep_library_grants(id,\"libraryId\",\"userId\") VALUES('grant','library',1)"
  );
  const app = express();
  app.use(express.json());
  const router = express.Router();
  knowledge.registerKnowledge(router);
  app.use(router);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});
beforeEach(async () => {
  mockDeletionFailure = false;
  await mockStore.run("DELETE FROM ep_vector_cleanup");
  await mockStore.run("DELETE FROM ep_chunks");
  await mockStore.run("DELETE FROM ep_documents");
  await mockStore.run("UPDATE users SET status='active'");
  const stamp = new Date().toISOString();
  await mockStore.run(
    "INSERT INTO ep_documents(id,\"tenantId\",\"libraryId\",title,\"inputType\",content,status,version,\"createdBy\",\"updatedBy\",\"createdAt\",\"updatedAt\") VALUES('document','tenant','library','Document','text',$1,'processing',1,'1','1',$2,$3)",
    content,
    stamp,
    stamp
  );
  await mockStore.run(
    "UPDATE ep_vector_settings SET config=$1,revision=$2",
    mockProviders.encrypt(
      JSON.stringify({ path: path.join(directory, randomUUID()) })
    ),
    ++revision
  );
  mockUpserts.mockClear();
  mockDeletes.mockClear();
});
afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  if (
    directory &&
    path
      .resolve(directory)
      .startsWith(path.resolve(os.tmpdir(), "ep-vector-recovery-"))
  )
    fs.rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(environment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("startup leaves the original version processing until orphan deletion succeeds, then recovers searchable chunks", async () => {
  const orphan = await crashedAttempt();
  mockDeletionFailure = true;
  await expect(knowledge.recoverJobs()).rejects.toMatchObject({
    status: 503,
    message: "向量索引清理尚未完成，请恢复向量数据库后重试资料处理",
  });
  expect(
    await mockStore.one(
      "SELECT status,version FROM ep_documents WHERE id='document'"
    )
  ).toEqual({ status: "processing", version: 1 });
  expect(await mockStore.all("SELECT * FROM ep_chunks")).toEqual([]);
  expect(mockUpserts).not.toHaveBeenCalled();
  expect(mockDeletes).toHaveBeenCalledTimes(1);
  expect(await mockStore.all("SELECT id FROM ep_vector_cleanup")).toEqual([
    { id: orphan.id },
  ]);
  // Upsert/search remain usable: deletion alone is broken, so continuing the
  // rebuild would otherwise introduce same-version IDs that compete in TopK.
  const existing = await vectorStore.withDatabase((db) =>
    db.search({
      namespace,
      vector: [1, 0, 0],
      filter: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        documentVersions: [{ documentId: "document", version: 1 }],
      },
      topK: 1,
      threshold: 0.3,
    })
  );
  expect(existing.map((row) => row.id)).toEqual([orphan.id]);
  mockDeletionFailure = false;
  await knowledge.recoverJobs();
  await assertRecovered(orphan, 1);
});

test("index publication also fails closed when old cleanup fails, and the normal retry endpoint recovers", async () => {
  const orphan = await crashedAttempt();
  mockDeletionFailure = true;
  await knowledge.indexDocument("document", 1, ctx);
  expect(
    await mockStore.one(
      "SELECT status,error,version FROM ep_documents WHERE id='document'"
    )
  ).toEqual({
    status: "failed",
    error: "向量索引清理尚未完成，请恢复连接后重试",
    version: 1,
  });
  expect(await mockStore.all("SELECT * FROM ep_chunks")).toEqual([]);
  expect(mockUpserts).not.toHaveBeenCalled();
  expect(await mockStore.all("SELECT id FROM ep_vector_cleanup")).toEqual([
    { id: orphan.id },
  ]);
  mockDeletionFailure = false;
  const response = await requestJson(`${base}/documents/document/retry`, {
    method: "POST",
    headers: {
      host: "tenant-a.localhost",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(response.status).toBe(202);
  await assertRecovered(orphan, 2);
});

test("non-vector authorization failures keep their existing document error semantics", async () => {
  await mockStore.run("UPDATE users SET status='disabled' WHERE id=1");
  await knowledge.indexDocument("document", 1, ctx);
  expect(
    await mockStore.one(
      "SELECT status,error FROM ep_documents WHERE id='document'"
    )
  ).toEqual({ status: "failed", error: "账号或租户已停用，请联系管理员" });
  expect(mockUpserts).not.toHaveBeenCalled();
  expect(mockDeletes).not.toHaveBeenCalled();
});
