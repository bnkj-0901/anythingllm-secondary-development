const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const express = require("express");

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
const mockProviders = {
  encrypt: (...args) =>
    jest.requireActual("../../enterprise/providers").encrypt(...args),
  decrypt: (...args) =>
    jest.requireActual("../../enterprise/providers").decrypt(...args),
  contextWindow: () => 16384,
  maxOutputTokens: () => 1800,
  embeddingChunkLimit: jest.fn(() => 8192),
  resolveConnection: jest.fn(async (_ctx, kind) => ({ id: kind, version: 1 })),
  connectionIdentity: (connection) => `${connection.id}:${connection.version}`,
  embed: jest.fn(async (_connection, texts) => texts.map(() => [1, 0, 0])),
  complete: jest.fn(async () => "公开答案与私有答案 [1]"),
};
jest.mock("../../enterprise/store", () => mockStore);
jest.mock("../../enterprise/providers", () => mockProviders);
jest.mock("../../enterprise/auth", () => ({
  requireAuth: (_req, _res, next) => next(),
  requirePlatformAuth: (_req, _res, next) => next(),
  context: (...args) =>
    jest.requireActual("../../enterprise/auth").context(...args),
  platformContext: (...args) =>
    jest.requireActual("../../enterprise/auth").platformContext(...args),
  fail: (status, message) => Object.assign(new Error(message), { status }),
  refreshContext: (ctx, db = mockStore) =>
    jest.requireActual("../../enterprise/auth").refreshContext(ctx, db),
}));

let knowledge, rag, vectorStore;
const ctx = {
  a1: { tenantId: "tenant-a", userId: 1, role: "user" },
  a2: { tenantId: "tenant-a", userId: 2, role: "user" },
  aa: { tenantId: "tenant-a", userId: 3, role: "admin" },
  b1: { tenantId: "tenant-b", userId: 4, role: "user" },
  ba: { tenantId: "tenant-b", userId: 5, role: "admin" },
  top: { identity: "platform", userId: "top", role: "platform_admin" },
};
let temp, listener, base, collectorProcess;
let originalEncryption;
async function request(user, url, method = "GET", body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": user,
      host: `${ctx[user].tenantId}.localhost`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function ready(id, user = "a1") {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await request(user, `/documents/${id}`);
    if (result.body.document?.status === "ready") return result.body.document;
    if (result.body.document?.status === "failed")
      throw new Error(result.body.document.error);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Indexing did not complete");
}
async function library(user, name, visibility) {
  const result = await request(user, "/libraries", "POST", {
    name,
    visibility,
    tenantId: "tenant-b",
    ownerId: "b1",
  });
  if (visibility === "public") {
    expect(result.status).toBe(202);
    const approved = await review("aa", result.body.change.id);
    expect(approved.status).toBe(200);
    const rows = (await request(user, "/libraries")).body.libraries;
    return rows.find((item) => item.name === name);
  }
  expect(result.status).toBe(201);
  return result.body.library;
}
async function document(user, libraryId, title, content) {
  const result = await request(user, "/documents", "POST", {
    libraryId,
    title,
    content,
  });
  expect(result.status).toBe(202);
  if (result.body.approvalRequired) {
    const approved = await review("aa", result.body.change.id);
    expect(approved.status).toBe(200);
    return (await request(user, "/documents")).body.documents.find(
      (item) => item.title === title
    );
  }
  return ready(result.body.document.id, user);
}

async function uploadFile(
  user,
  libraryId,
  filename,
  bytes,
  route = "/documents/upload"
) {
  const form = new FormData();
  form.set("libraryId", libraryId);
  form.set("file", new Blob([bytes]), filename);
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "x-test-user": user, host: `${ctx[user].tenantId}.localhost` },
    body: form,
  });
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  originalEncryption = {
    SIG_KEY: process.env.SIG_KEY,
    SIG_SALT: process.env.SIG_SALT,
    STORAGE_DIR: process.env.STORAGE_DIR,
    COLLECTOR_PORT: process.env.COLLECTOR_PORT,
  };
  process.env.SIG_KEY = "knowledge-test-key";
  process.env.SIG_SALT = "knowledge-test-salt";
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "enterprise-knowledge-"));
  // File storage captures its root when required. Set it before loading the
  // real upload pipeline so a developer's .env can never receive test files.
  process.env.STORAGE_DIR = temp;
  // Exercise the same signed HTTP boundary as production while keeping every
  // original, communication key and parser artifact in this test's directory.
  const { CommunicationKey } = require("../../utils/comKey");
  new CommunicationKey(true);
  collectorProcess = require("child_process").spawn(
    process.execPath,
    [
      "-e",
      `const server = require('./app').createCollectorApp().listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
       process.on('message', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });`,
    ],
    {
      cwd: path.resolve(__dirname, "../../../collector"),
      env: { ...process.env },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    }
  );
  process.env.COLLECTOR_PORT = String(
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Test Collector startup timed out")),
        10000
      );
      collectorProcess.once("message", ({ port }) => {
        clearTimeout(timeout);
        resolve(port);
      });
      collectorProcess.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      collectorProcess.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Test Collector exited before listening"));
      });
    })
  );
  knowledge = require("../../enterprise/knowledge");
  rag = require("../../enterprise/rag");
  vectorStore = require("../../enterprise/vector-store");
  mockFixture = await createPostgresFixture();
  mockPgStore = mockFixture.db;

  const stamp = new Date().toISOString();
  await mockStore.run(
    'INSERT INTO ep_vector_settings(id,provider,config,revision,"updatedAt") VALUES(\'platform\',\'lancedb\',$1,1,$2) ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider, config=EXCLUDED.config, revision=EXCLUDED.revision, "updatedAt"=EXCLUDED."updatedAt"',
    mockProviders.encrypt(JSON.stringify({ path: path.join(temp, "lancedb") })),
    stamp
  );
  for (const tenantId of ["tenant-a", "tenant-b"])
    await mockStore.run(
      'INSERT INTO ep_tenants (id,code,name,hostname,"createdAt","updatedAt") VALUES ($1,$2,$3,$2 || \'.localhost\',$4,$5)',
      tenantId,
      tenantId,
      tenantId,
      stamp,
      stamp
    );
  for (const [userId, identity] of Object.entries(ctx).filter(
    ([, item]) => item.identity !== "platform"
  ))
    await mockStore.run(
      'INSERT INTO users (id,"tenantId",username,name,"passwordHash",role,"createdAt","lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      identity.userId,
      identity.tenantId,
      userId,
      userId,
      "unused-test-hash",
      identity.role,
      new Date(stamp),
      new Date(stamp)
    );
  await mockStore.run(
    'INSERT INTO ep_platform_accounts(id,username,name,"passwordHash","createdAt","updatedAt") VALUES($1,$1,$1,$2,$3,$3)',
    "top",
    "unused-test-hash",
    stamp
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.ep = ctx[req.headers["x-test-user"]];
    next();
  });
  const router = express.Router();
  knowledge.registerKnowledge(router);
  require("../../endpoints/extensions").knowledgeImportEndpoints(router);

  app.use(router);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});
afterAll(async () => {
  try {
    if (listener) await new Promise((resolve) => listener.close(resolve));
    if (collectorProcess?.connected) {
      await new Promise((resolve) => {
        collectorProcess.once("exit", resolve);
        collectorProcess.send("close");
      });
    }
  } finally {
    try {
      await mockFixture?.cleanup();
    } finally {
      try {
        if (temp) {
          const target = path.resolve(temp);
          if (
            !target.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
            !path.basename(target).startsWith("enterprise-knowledge-")
          )
            throw new Error("Refusing to remove a non-test storage directory");
          fs.rmSync(target, { recursive: true, force: true });
        }
      } finally {
        for (const [key, value] of Object.entries(originalEncryption || {})) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  }
});

async function review(user, id, decision = "approve", extra = {}) {
  return request(
    user,
    `${user === "top" ? "/platform" : ""}/knowledge-changes/${id}/review`,
    "POST",
    { decision, ...extra }
  );
}

test("private knowledge CRUD remains immediate and admin does not acquire access", async () => {
  const lib = await library("a1", "private-direct", "private");
  const doc = await document("a1", lib.id, "private", "private original");
  expect((await request("aa", `/documents/${doc.id}`)).status).toBe(404);
  expect(
    (await request("a2", `/libraries/${lib.id}`, "PATCH", { name: "attack" }))
      .status
  ).toBe(404);
  expect(
    (await request("a1", `/libraries/${lib.id}`, "PATCH", { name: "renamed" }))
      .status
  ).toBe(200);
  const changed = await request("a1", `/documents/${doc.id}`, "PATCH", {
    content: "private changed",
  });
  expect(changed.status).toBe(200);
  await ready(doc.id);
  expect((await request("a1", `/documents/${doc.id}`, "DELETE")).status).toBe(
    200
  );
  expect((await request("a1", `/libraries/${lib.id}`, "DELETE")).status).toBe(
    200
  );
});

test("public library creation and document changes are unpublished until explicit admin approval", async () => {
  const proposed = await request("a1", "/libraries", "POST", {
    name: "public-reviewed",
    visibility: "public",
  });
  expect(proposed.status).toBe(202);
  expect(proposed.body.approvalRequired).toBe(true);
  expect(
    (await request("a2", "/libraries")).body.libraries.some(
      (item) => item.name === "public-reviewed"
    )
  ).toBe(false);
  expect((await review("a1", proposed.body.change.id)).status).toBe(403);
  expect((await review("ba", proposed.body.change.id)).status).toBe(404);
  expect((await review("aa", proposed.body.change.id)).body.change.status).toBe(
    "approved"
  );
  const lib = (await request("a2", "/libraries")).body.libraries.find(
    (item) => item.name === "public-reviewed"
  );
  const change = await request("a1", "/documents", "POST", {
    libraryId: lib.id,
    title: "approved source",
    content: "published original text",
  });
  expect(change.body.approvalRequired).toBe(true);
  expect(
    (await request("a2", "/documents")).body.documents.some(
      (item) => item.title === "approved source"
    )
  ).toBe(false);
  expect((await review("aa", change.body.change.id)).body.change.status).toBe(
    "approved"
  );
  const doc = (await request("a2", "/documents")).body.documents.find(
    (item) => item.title === "approved source"
  );
  const update = await request("a2", `/documents/${doc.id}`, "PATCH", {
    content: "new proposed text",
  });
  expect(update.status).toBe(202);
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document.content
  ).toBe("published original text");
  expect((await review("aa", update.body.change.id)).body.change.status).toBe(
    "approved"
  );
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document.content
  ).toBe("new proposed text");
  const removal = await request("aa", `/documents/${doc.id}`, "DELETE");
  expect(removal.body.approvalRequired).toBe(true);
  expect((await request("a2", `/documents/${doc.id}`)).status).toBe(200);
  expect((await review("aa", removal.body.change.id)).body.change.status).toBe(
    "approved"
  );
  expect((await request("a2", `/documents/${doc.id}`)).status).toBe(404);
});

test("conflicting public proposals wait for administrator resolution and do not overwrite silently", async () => {
  const lib = await library("a1", "public-conflict", "public");
  const doc = await document("a1", lib.id, "conflict source", "version one");
  const first = await request("a1", `/documents/${doc.id}`, "PATCH", {
    content: "first update",
  });
  const second = await request("a2", `/documents/${doc.id}`, "PATCH", {
    content: "second update",
  });
  expect((await review("aa", first.body.change.id)).status).toBe(200);
  const conflict = await review("aa", second.body.change.id);
  expect(conflict.status).toBe(409);
  expect(conflict.body.change.status).toBe("conflict");
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document.content
  ).toBe("first update");
  expect(
    (
      await review("aa", second.body.change.id, "approve", {
        resolveConflict: true,
      })
    ).status
  ).toBe(200);
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document.content
  ).toBe("second update");
});

test("failed approved indexing preserves the published document and active chunks", async () => {
  const lib = await library("a1", "public-failure", "public");
  const doc = await document("a1", lib.id, "stable source", "stable published");
  const originalChunks = await mockStore.all(
    'SELECT id,version,content FROM ep_chunks WHERE "documentId"=$1',
    doc.id
  );
  const edit = await request("a1", `/documents/${doc.id}`, "PATCH", {
    content: "unavailable candidate",
  });
  mockProviders.embed.mockRejectedValueOnce(new Error("Embedding unavailable"));
  const failed = await review("aa", edit.body.change.id);
  expect(failed.status).toBe(500);
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document
  ).toMatchObject({
    content: "stable published",
    status: "ready",
    version: doc.version,
  });
  expect(
    await mockStore.all(
      'SELECT id,version,content FROM ep_chunks WHERE "documentId"=$1',
      doc.id
    )
  ).toEqual(originalChunks);
  const changes = (await request("aa", "/knowledge-changes")).body.changes;
  expect(changes.find((item) => item.id === edit.body.change.id).status).toBe(
    "failed"
  );
  expect((await review("aa", edit.body.change.id)).status).toBe(200);
});

test("pending uploaded original is private to applicant and reviewer and cleaned on rejection", async () => {
  const lib = await library("a1", "public-files", "public");
  const result = await uploadFile(
    "a1",
    lib.id,
    "pending.txt",
    "not public yet"
  );
  expect(result.body.approvalRequired).toBe(true);
  const id = result.body.change.id;
  const record = await mockStore.one(
    "SELECT payload FROM ep_knowledge_changes WHERE id=$1",
    id
  );
  const filename = JSON.parse(record.payload).originalPath;
  expect(fs.existsSync(filename)).toBe(true);
  expect(
    (await request("a2", "/knowledge-changes")).body.changes.some(
      (item) => item.id === id
    )
  ).toBe(false);
  const other = await fetch(`${base}/knowledge-changes/${id}/download`, {
    headers: { "x-test-user": "a2" },
  });
  expect(other.status).toBe(404);
  const own = await fetch(`${base}/knowledge-changes/${id}/download`, {
    headers: { "x-test-user": "a1" },
  });
  expect(own.status).toBe(200);
  expect(await own.text()).toBe("not public yet");
  expect(
    (await review("aa", id, "reject", { note: "wrong content" })).body.change
      .status
  ).toBe("rejected");
  expect(fs.existsSync(filename)).toBe(false);
});

test("disabled applicants cannot publish pending changes and admins lose review rights immediately", async () => {
  const lib = await library("a1", "public-identity", "public");
  const change = await request("a1", "/documents", "POST", {
    libraryId: lib.id,
    title: "disabled",
    content: "never publish",
  });
  await mockStore.run("UPDATE users SET status='disabled' WHERE id=1");
  expect((await review("aa", change.body.change.id)).status).toBe(401);
  await mockStore.run("UPDATE users SET status='active' WHERE id=1");
  await mockStore.run("UPDATE users SET role='user' WHERE id=3");
  expect((await review("aa", change.body.change.id)).status).toBe(403);
  await mockStore.run("UPDATE users SET role='admin' WHERE id=3");
  expect((await review("aa", change.body.change.id)).status).toBe(200);
});

test("platform management retains platform audit identity and can access all private knowledge", async () => {
  const lib = await library("a1", "private-platform", "private");
  const doc = await document(
    "a1",
    lib.id,
    "private for platform",
    "original private"
  );
  expect((await request("top", `/platform/documents/${doc.id}`)).status).toBe(
    200
  );
  const edit = await request("top", `/platform/documents/${doc.id}`, "PATCH", {
    title: "platform edited",
  });
  expect(edit.status).toBe(200);
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document.updatedBy
  ).toBe("top");
  const proposal = await request("top", "/platform/libraries", "POST", {
    tenantId: "tenant-b",
    name: "platform public",
    visibility: "public",
  });
  expect(proposal.body.approvalRequired).toBe(true);
  expect((await review("top", proposal.body.change.id)).status).toBe(200);
  expect(
    (await request("ba", "/libraries")).body.libraries.find(
      (item) => item.name === "platform public"
    ).createdBy
  ).toBe("top");
});

test("whole public-library changes require approval and private access changes immediately", async () => {
  const lib = await library("a1", "review whole library", "public");
  const rename = await request("a2", `/libraries/${lib.id}`, "PATCH", {
    name: "reviewed rename",
  });
  expect(rename.status).toBe(202);
  expect(
    (await request("a2", "/libraries")).body.libraries.find(
      (item) => item.id === lib.id
    )
  ).toMatchObject({ name: "review whole library", canManage: true });
  expect((await review("aa", rename.body.change.id)).status).toBe(200);
  expect(
    (await request("a2", "/libraries")).body.libraries.find(
      (item) => item.id === lib.id
    ).name
  ).toBe("reviewed rename");
  const privatize = await request("a2", `/libraries/${lib.id}/grants`, "PUT", {
    visibility: "private",
    userId: 2,
  });
  expect(privatize.status).toBe(202);
  expect(
    (await request("a1", "/libraries")).body.libraries.some(
      (item) => item.id === lib.id
    )
  ).toBe(true);
  expect((await review("aa", privatize.body.change.id)).status).toBe(200);
  expect(
    (await request("a1", "/libraries")).body.libraries.some(
      (item) => item.id === lib.id
    )
  ).toBe(false);
  const publish = await request("a2", `/libraries/${lib.id}/grants`, "PUT", {
    visibility: "public",
  });
  expect(publish.status).toBe(202);
  expect(
    (await request("a1", "/libraries")).body.libraries.some(
      (item) => item.id === lib.id
    )
  ).toBe(false);
  expect((await review("aa", publish.body.change.id)).status).toBe(200);
  const remove = await request("a1", `/libraries/${lib.id}`, "DELETE");
  expect(remove.status).toBe(202);
  expect(
    (await request("a2", "/libraries")).body.libraries.some(
      (item) => item.id === lib.id
    )
  ).toBe(true);
  expect((await review("aa", remove.body.change.id)).body.change.status).toBe(
    "approved"
  );
  expect(
    (await request("a2", "/libraries")).body.libraries.some(
      (item) => item.id === lib.id
    )
  ).toBe(false);
});

test("approved title changes retain content and embeddings without re-indexing", async () => {
  const lib = await library("a1", "title approval", "public");
  const doc = await document(
    "a1",
    lib.id,
    "old title",
    "stable unchanged text"
  );
  const chunks = await mockStore.all(
    'SELECT id,content FROM ep_chunks WHERE "documentId"=$1',
    doc.id
  );
  const before = mockProviders.embed.mock.calls.length;
  const proposal = await request("a2", `/documents/${doc.id}`, "PATCH", {
    title: "new reviewed title",
  });
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document.title
  ).toBe("old title");
  expect((await review("aa", proposal.body.change.id)).status).toBe(200);
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document
  ).toMatchObject({
    title: "new reviewed title",
    content: "stable unchanged text",
    version: doc.version,
  });
  expect(mockProviders.embed.mock.calls.length).toBe(before);
  expect(
    await mockStore.all(
      'SELECT id,content FROM ep_chunks WHERE "documentId"=$1',
      doc.id
    )
  ).toEqual(chunks);
});

test("pinning respects private access and public approval without replacing the live index", async () => {
  const privateLibrary = await library(
    "a1",
    "Private pinned context",
    "private"
  );
  const privateDocument = await document(
    "a1",
    privateLibrary.id,
    "Private pinned",
    "Private complete context"
  );
  expect(
    (
      await request("aa", `/documents/${privateDocument.id}`, "PATCH", {
        pinned: true,
      })
    ).status
  ).toBe(404);
  expect(
    (
      await request("a1", `/documents/${privateDocument.id}`, "PATCH", {
        pinned: true,
      })
    ).status
  ).toBe(200);
  expect(
    (await request("a1", `/documents/${privateDocument.id}`)).body.document
      .pinned
  ).toBe(true);

  const publicLibrary = await library("a1", "Public pinned context", "public");
  const publicDocument = await document(
    "a1",
    publicLibrary.id,
    "Public pinned",
    "Public complete context"
  );
  const before = mockProviders.embed.mock.calls.length;
  const proposal = await request(
    "a2",
    `/documents/${publicDocument.id}`,
    "PATCH",
    { pinned: true }
  );
  expect(proposal.body.approvalRequired).toBe(true);
  expect(
    (await request("a1", `/documents/${publicDocument.id}`)).body.document
      .pinned
  ).toBe(false);
  expect((await review("aa", proposal.body.change.id)).status).toBe(200);
  expect(
    (await request("a1", `/documents/${publicDocument.id}`)).body.document
      .pinned
  ).toBe(true);
  expect(mockProviders.embed.mock.calls.length).toBe(before);
  const { Document } = require("../../models/documents");
  const contexts = await Document.pinnedContext(
    ctx.a2,
    Infinity,
    mockStore.orm
  );
  expect(contexts.some((item) => item.id === publicDocument.id)).toBe(true);
  expect(contexts.some((item) => item.id === privateDocument.id)).toBe(false);
});

test("disk uploads publish only after review and replacements keep the old downloadable original until approved", async () => {
  const lib = await library("a1", "review uploaded content", "public");
  const upload = await uploadFile(
    "a1",
    lib.id,
    "source.txt",
    "first file content"
  );
  expect(upload.status).toBe(202);
  expect((await review("aa", upload.body.change.id)).status).toBe(200);
  const doc = (await request("a2", "/documents")).body.documents.find(
    (item) => item.title === "source.txt"
  );
  expect(
    (await request("a2", `/documents/${doc.id}`)).body.document.content
  ).toBe("first file content");
  const replacement = await uploadFile(
    "a2",
    lib.id,
    "replacement.txt",
    "second reviewed content",
    `/documents/${doc.id}/replace`
  );
  expect(replacement.status).toBe(202);
  const download = async () => {
    const response = await fetch(`${base}/documents/${doc.id}/download`, {
      headers: { "x-test-user": "a1" },
    });
    expect(response.status).toBe(200);
    return response.text();
  };
  expect(await download()).toBe("first file content");
  expect((await review("aa", replacement.body.change.id)).status).toBe(200);
  expect(await download()).toBe("second reviewed content");
  expect(
    (await request("a1", `/documents/${doc.id}`)).body.document.content
  ).toBe("second reviewed content");
});

test("temporary upload files are removed after successful submissions and authorization failures", async () => {
  const lib = await library("a1", "temporary upload cleanup", "private");
  const unlink = jest.spyOn(fs.promises, "unlink");
  try {
    const allowed = await uploadFile(
      "a1",
      lib.id,
      "clean.txt",
      "authorized file"
    );
    expect(allowed.status).toBe(202);
    await ready(allowed.body.document.id);
    expect(
      (await uploadFile("b1", lib.id, "reject.txt", "unauthorized file")).status
    ).toBe(404);
    for (let attempt = 0; attempt < 20; attempt++) {
      const temporary = unlink.mock.calls
        .map(([filename]) => filename)
        .filter(
          (filename) =>
            path.dirname(filename) ===
            path.resolve(os.tmpdir(), "anythingllm-knowledge-uploads")
        );
      if (
        temporary.length >= 2 &&
        temporary.every((filename) => !fs.existsSync(filename))
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const temporary = unlink.mock.calls
      .map(([filename]) => filename)
      .filter(
        (filename) =>
          path.dirname(filename) ===
          path.resolve(os.tmpdir(), "anythingllm-knowledge-uploads")
      );
    expect(new Set(temporary).size).toBe(2);
    expect(temporary.every((filename) => !fs.existsSync(filename))).toBe(true);
  } finally {
    unlink.mockRestore();
  }
});

test("watched private revisions publish immediately and replace the vector index", async () => {
  const lib = await library("a1", "watched-private", "private");
  const doc = await document(
    "a1",
    lib.id,
    "Private source",
    "Private original source"
  );
  const approvalsBefore = await mockFixture.prisma.ep_knowledge_changes.count();
  const result = await knowledge.submitSyncedContent(
    ctx.a1,
    doc.id,
    "Private changed source"
  );
  expect(result.approvalRequired).toBeUndefined();
  const changed = await ready(doc.id);
  expect(changed).toMatchObject({
    content: "Private changed source",
    version: doc.version + 1,
    status: "ready",
  });
  expect(await mockFixture.prisma.ep_knowledge_changes.count()).toBe(
    approvalsBefore
  );
  await expect(
    knowledge.submitSyncedContent(ctx.aa, doc.id, "Unauthorized update")
  ).rejects.toMatchObject({ status: 404 });
  const chunks = await mockFixture.prisma.document_vectors.findMany({
    where: { documentId: doc.id },
  });
  expect(chunks.length).toBeGreaterThan(0);
  expect(
    chunks.every((chunk) => chunk.content.includes("Private changed source"))
  ).toBe(true);
});

test("approval lists expose reviewable grant targets without payload paths and scope applicants correctly", async () => {
  const lib = await library("a1", "review grant identities", "public");
  const change = await request("a1", `/libraries/${lib.id}/grants`, "PUT", {
    visibility: "private",
    userId: 2,
  });
  expect(change.status).toBe(202);
  const applicant = await request("a1", "/knowledge-changes?status=pending");
  const item = applicant.body.changes.find(
    (row) => row.id === change.body.change.id
  );
  expect(item).toMatchObject({ targetUserId: 2, visibility: "private" });
  expect(item.targetUserName).toBeTruthy();
  expect(item).not.toHaveProperty("payload");
  expect(item).not.toHaveProperty("originalPath");
  expect(
    (await request("a2", "/knowledge-changes")).body.changes.some(
      (row) => row.id === item.id
    )
  ).toBe(false);
  expect(
    (await request("aa", "/knowledge-changes")).body.changes.some(
      (row) => row.id === item.id
    )
  ).toBe(true);
  expect(
    (await request("ba", "/knowledge-changes")).body.changes.some(
      (row) => row.id === item.id
    )
  ).toBe(false);
  expect(
    (await request("top", "/platform/knowledge-changes")).body.changes.some(
      (row) => row.id === item.id
    )
  ).toBe(true);
  expect((await request("a1", "/knowledge-changes?status=forged")).status).toBe(
    400
  );
  expect((await review("aa", item.id, "invalid")).status).toBe(400);
  expect(
    (await request("a2", `/knowledge-changes/${item.id}`, "DELETE")).status
  ).toBe(404);
  expect(
    (await request("ba", `/knowledge-changes/${item.id}`, "DELETE")).status
  ).toBe(404);
  expect(
    (await request("a1", `/knowledge-changes/${item.id}/download`)).status
  ).toBe(404);
  expect(
    (await request("a1", `/knowledge-changes/${item.id}`, "DELETE")).status
  ).toBe(200);
  expect((await review("aa", item.id)).status).toBe(409);
  expect(
    (await request("a1", `/knowledge-changes/${item.id}`, "DELETE")).status
  ).toBe(409);
  expect(
    (await request("a1", `/knowledge-changes/${item.id}/download`)).status
  ).toBe(404);
});

test("private library maintenance and reassignment use current grants without creating approvals", async () => {
  const lib = await library("a1", "private management", "private");
  const doc = await document(
    "a1",
    lib.id,
    "private management source",
    "private document content"
  );
  const count = await mockFixture.prisma.ep_knowledge_changes.count();
  expect(
    (
      await request("a1", `/libraries/${lib.id}`, "PATCH", {
        name: "renamed private library",
      })
    ).status
  ).toBe(200);
  expect(
    (await request("a1", "/libraries")).body.libraries.find(
      (row) => row.id === lib.id
    ).name
  ).toBe("renamed private library");
  expect(
    (
      await request("a1", `/libraries/${lib.id}/grants`, "PUT", {
        visibility: "private",
        userId: 4,
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("a1", `/libraries/${lib.id}/grants`, "PUT", {
        visibility: "private",
        userId: 2,
      })
    ).status
  ).toBe(200);
  expect((await request("a1", `/documents/${doc.id}`)).status).toBe(404);
  expect((await request("a2", `/documents/${doc.id}`)).status).toBe(200);
  expect(
    (
      await request("a2", `/libraries/${lib.id}/grants`, "PUT", {
        visibility: "private",
      })
    ).status
  ).toBe(200);
  expect(await mockFixture.prisma.ep_knowledge_changes.count()).toBe(count);
  expect((await request("a2", `/libraries/${lib.id}`, "DELETE")).status).toBe(
    200
  );
  expect((await request("a2", `/documents/${doc.id}`)).status).toBe(404);
  expect(
    await mockFixture.prisma.ep_library_grants.count({
      where: { libraryId: lib.id },
    })
  ).toBe(0);
});

test("replacing a private file publishes immediately, replaces its index and retires the previous original", async () => {
  const lib = await library("a1", "private replacement", "private");
  const initial = await uploadFile(
    "a1",
    lib.id,
    "private-original.txt",
    "old private file text"
  );
  const first = await ready(initial.body.document.id);
  const prior = await mockFixture.prisma.documents.findUnique({
    where: { id: first.id },
  });
  const replaced = await uploadFile(
    "a1",
    lib.id,
    "private-new.txt",
    "new private replacement text",
    `/documents/${first.id}/replace`
  );
  expect(replaced.status).toBe(202);
  expect(replaced.body.approvalRequired).toBeUndefined();
  const current = await ready(first.id);
  expect(current).toMatchObject({
    content: "new private replacement text",
    version: first.version + 1,
  });
  const download = await fetch(`${base}/documents/${first.id}/download`, {
    headers: { "x-test-user": "a1" },
  });
  expect(download.status).toBe(200);
  expect(await download.text()).toBe("new private replacement text");
  const fileStore = require("../../enterprise/file-store");
  await expect(
    fileStore.resolveOriginal(prior.originalPath, prior.tenantId)
  ).rejects.toBeDefined();
  expect(
    (await request("aa", `/documents/${first.id}/replace`, "POST", {})).status
  ).toBeGreaterThanOrEqual(400);
  const retry = await request("a1", `/documents/${first.id}/retry`, "POST", {});
  expect(retry.status).toBe(202);
  expect((await ready(first.id)).version).toBe(current.version + 1);
});

test("original data connectors publish private notes and stage public notes through the same knowledge policy", async () => {
  const privateLibrary = await library(
    "a1",
    "Connector private library",
    "private"
  );
  const publicLibrary = await library(
    "a1",
    "Connector public library",
    "public"
  );
  const args = {
    files: [
      {
        name: "Note.md",
        path: "Vault/Note.md",
        content: "Connector import body",
      },
    ],
  };
  const direct = await request("a1", "/data-connectors/import", "POST", {
    libraryId: privateLibrary.id,
    connector: "obsidian",
    args,
  });
  expect(direct.status).toBe(202);
  expect(direct.body.data).toMatchObject({
    imported: 1,
    approvalRequired: false,
    changes: [],
  });
  const imported = await ready(direct.body.data.documents[0].id);
  expect(imported.content).toBe("Connector import body");
  const candidate = await request("a1", "/data-connectors/import", "POST", {
    libraryId: publicLibrary.id,
    connector: "obsidian",
    args,
  });
  expect(candidate.status).toBe(202);
  expect(candidate.body.data).toMatchObject({
    imported: 1,
    approvalRequired: true,
    documents: [],
  });
  const published = (await request("a2", "/documents")).body.documents;
  expect(published.some((item) => item.libraryId === publicLibrary.id)).toBe(
    false
  );
  const change = candidate.body.data.changes[0];
  expect(change).toMatchObject({
    libraryId: publicLibrary.id,
    status: "pending",
    requestedBy: "1",
  });
  const raw = await mockStore.one(
    "SELECT payload FROM ep_knowledge_changes WHERE id=$1",
    change.id
  );
  expect(JSON.parse(JSON.parse(raw.payload).metadata).chunkSource).toBe(
    "obsidian://Vault/Note.md"
  );
  expect((await review("aa", change.id)).status).toBe(200);
});

test("connector imports reject missing or foreign destinations before invoking the original collector", async () => {
  const privateLibrary = await library(
    "b1",
    "Foreign connector library",
    "private"
  );
  const args = {
    files: [{ name: "Note.md", path: "Note.md", content: "Must not publish" }],
  };
  const before = await mockStore.orm.documents.count();
  expect(
    (
      await request("a1", "/data-connectors/import", "POST", {
        connector: "obsidian",
        args,
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("a1", "/data-connectors/import", "POST", {
        libraryId: privateLibrary.id,
        connector: "obsidian",
        args,
      })
    ).status
  ).toBe(404);
  expect(await mockStore.orm.documents.count()).toBe(before);
});
