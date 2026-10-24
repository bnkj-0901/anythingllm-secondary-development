const fs = require("fs");
const os = require("os");
const path = require("path");
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
let mockBackend;
const mockCreate = jest.fn(() => mockBackend);
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
  createVectorDatabase: (...args) => mockCreate(...args),
}));
const vectorStore = require("../../enterprise/vector-store");
const knowledge = require("../../enterprise/knowledge");
const rag = require("../../enterprise/rag");
const { fail } = require("../../enterprise/auth");
const { namespaceFor } = jest.requireActual("../../utils/vectorDbProviders");

const ctx = { tenantId: "tenant", userId: 1 };
const namespace = namespaceFor({
  tenantId: ctx.tenantId,
  embeddingId: "embedding:1",
  dimensions: 3,
});
const record = {
  id: "chunk",
  tenantId: ctx.tenantId,
  documentId: "ready",
  version: 1,
  embeddingId: "embedding:1",
  libraryId: "library",
  ownerId: ctx.userId,
  text: "A source document for retrieval.",
  vector: [1, 0, 0],
};
const rawDetails =
  "SDK Authorization Bearer test-vector-secret postgres://admin:password@private-db.invalid";
const sdkFailure = () =>
  Object.assign(new Error(rawDetails), {
    status: 401,
    enterpriseProvider: true,
  });
let directory, listener, base, environment, platformToken, tenantToken;
let revision = 0;

function token(identity, id) {
  return jwt.sign(
    {
      identity,
      ver: 1,
      ...(identity === "tenant" ? { tenantId: ctx.tenantId } : {}),
    },
    process.env.JWT_SECRET,
    { subject: String(id), audience: `enterprise-${identity}-v1` }
  );
}
function request(route, method = "GET", body, platform = false) {
  return requestJson(base + route, {
    method,
    headers: {
      host: platform ? "localhost" : "tenant-a.localhost",
      "content-type": "application/json",
      authorization: `Bearer ${platform ? platformToken : tenantToken}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function expectRedacted(value) {
  expect(JSON.stringify(value)).not.toMatch(
    /test-vector-secret|postgres:\/\/|private-db\.invalid|Authorization|password/
  );
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
    JWT_SECRET: "vector-errors-jwt",
    SIG_KEY: "vector-errors-key",
    SIG_SALT: "vector-errors-salt",
    TENANT_BASE_DOMAIN: "localhost",
    PLATFORM_HOSTS: "localhost",
  });
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ep-vector-errors-"));
  mockFixture = await createPostgresFixture();
  mockPgStore = mockFixture.db;

  const stamp = new Date().toISOString();
  await mockStore.run(
    "INSERT INTO ep_tenants(id,code,name,hostname,\"createdAt\",\"updatedAt\") VALUES('tenant','tenant-a','Tenant','tenant-a.localhost',$1,$2)",
    stamp,
    stamp
  );
  await mockStore.run(
    "INSERT INTO ep_platform_accounts(id,username,name,\"passwordHash\",\"createdAt\",\"updatedAt\") VALUES('platform','platform','Platform','unused',$1,$2)",
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
  for (const [id, status] of [
    ["ready", "ready"],
    ["pending", "processing"],
  ])
    await mockStore.run(
      'INSERT INTO ep_documents(id,"tenantId","libraryId",title,"inputType",content,status,version,"embeddingId","createdBy","updatedBy","createdAt","updatedAt") VALUES($1,\'tenant\',\'library\',\'Document\',\'text\',$2,$3,1,\'embedding:1\',\'user\',\'user\',$4,$5)',
      id,
      record.text,
      status,
      stamp,
      stamp
    );
  await mockStore.run(
    "INSERT INTO ep_chunks(id,\"tenantId\",\"documentId\",version,position,content,\"embeddingId\",dimensions,namespace) VALUES('chunk','tenant','ready',1,0,$1,'embedding:1',3,$2)",
    record.text,
    namespace
  );
  await mockStore.run(
    'INSERT INTO chat_threads(id,"tenantId","userId",name,slug,"createdAt","lastUpdatedAt") VALUES(1,\'tenant\',1,\'Question\',\'conversation\',NOW(),NOW())'
  );
  await mockStore.run(
    'INSERT INTO ep_vector_settings(id,provider,config,revision,"updatedAt") VALUES(\'platform\',\'qdrant\',$1,1,$2) ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider, config=EXCLUDED.config, revision=EXCLUDED.revision, "updatedAt"=EXCLUDED."updatedAt"',
    mockProviders.encrypt(
      JSON.stringify({
        endpoint: "http://source.invalid",
        apiKey: "saved-test-key",
      })
    ),
    stamp
  );
  platformToken = token("platform", "platform");
  tenantToken = token("tenant", ctx.userId);
  await mockStore.run(
    "INSERT INTO ep_library_grants(id,\"libraryId\",\"tenantId\") VALUES('grant','library','tenant')"
  );
  const app = express();
  app.use(express.json());
  const router = express.Router();
  knowledge.registerKnowledge(router);
  rag.registerRag(router);
  app.use(router);
  // Deliberately echo every thrown message: tests must prove the vector boundary
  // itself is safe before a route or document serializer receives the error.
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});
beforeEach(async () => {
  mockBackend = Object.fromEntries(
    ["heartbeat", "upsert", "fetch", "search", "delete"].map((method) => [
      method,
      jest.fn(async () => (method === "fetch" ? [record] : [])),
    ])
  );
  mockCreate.mockImplementation(() => mockBackend);
  await mockStore.run("UPDATE ep_vector_settings SET revision=$1", ++revision);
  await mockStore.run(
    "UPDATE ep_documents SET status='processing',error=NULL WHERE id='pending'"
  );
});
afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  if (
    directory &&
    path
      .resolve(directory)
      .startsWith(path.resolve(os.tmpdir(), "ep-vector-errors-"))
  )
    fs.rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(environment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test.each(["heartbeat", "upsert", "fetch", "search", "delete"])(
  "%s normalizes SDK status and secret details at the adapter boundary",
  async (method) => {
    mockBackend[method].mockRejectedValue(sdkFailure());
    const error = await vectorStore
      .withDatabase((db) => db[method]({}))
      .catch((error) => error);
    expect(error.status).toBe(502);
    expectRedacted(error.message);
  }
);

test("a failed SDK constructor is also redacted", async () => {
  mockCreate.mockImplementation(() => {
    throw sdkFailure();
  });
  const error = await vectorStore
    .withDatabase(() => {})
    .catch((error) => error);
  expect(error.status).toBe(502);
  expect(error.message).toBe("向量数据库初始化失败，请核对配置与服务状态");
  expectRedacted(error.message);
});

test("failed indexing stores and returns only a safe vector error to a tenant", async () => {
  mockBackend.upsert.mockRejectedValue(sdkFailure());
  await knowledge.indexDocument("pending", 1, ctx);
  const document = await mockStore.one(
    "SELECT status,error FROM ep_documents WHERE id='pending'"
  );
  expect(document.status).toBe("failed");
  expect(document.error).toBe(
    "向量索引写入失败，请检查向量数据库连接与服务状态"
  );
  expectRedacted(document);
  const response = await request("/documents/pending");
  expect(response.status).toBe(200);
  expect(response.body.document.error).toBe(document.error);
  expectRedacted(response.body);
});

test("a tenant retrieval SDK error returns safe 502 rather than the backend's 401 and details", async () => {
  mockBackend.search.mockRejectedValue(sdkFailure());
  const response = await request("/conversations/1/messages", "POST", {
    message: "Find the document",
  });
  expect(response.status).toBe(502);
  expect(response.body.error).toBe(
    "知识检索暂时不可用，请检查向量数据库连接与服务状态"
  );
  expectRedacted(response.body);
  expect(await mockStore.all("SELECT * FROM chats")).toEqual([]);
});

test("a failed connection check is redacted and retains the active configuration", async () => {
  mockBackend.fetch.mockRejectedValue(sdkFailure());
  const before = await vectorStore.settings();
  const error = await vectorStore
    .change(
      {
        provider: "qdrant",
        config: { endpoint: "http://target.invalid" },
        revision: before.revision,
      },
      { identity: "platform", userId: "platform", authVersion: 1 }
    )
    .catch((error) => error);
  expect(error.status).toBe(502);
  expectRedacted(error.message);
  expect(await vectorStore.settings()).toEqual(before);
});

test("local permission errors and stale configuration failures retain their own status and message", async () => {
  const denied = fail(404, "资料不存在或无权访问");
  await expect(
    vectorStore.withWrite(() => {
      throw denied;
    })
  ).rejects.toBe(denied);
  await expect(
    vectorStore.change(
      {
        provider: "qdrant",
        config: { endpoint: "http://target.invalid" },
        revision: 0,
      },
      { identity: "platform", userId: "platform", authVersion: 1 }
    )
  ).rejects.toMatchObject({
    status: 409,
    message: "向量数据库配置已更新，请刷新后重试",
  });
});
