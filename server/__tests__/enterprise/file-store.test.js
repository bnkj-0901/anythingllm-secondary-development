const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const { createFileStore } = require("../../enterprise/file-store");

let directory, root, prisma, db, files, fixture;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-files-"));
  fixture = await createPostgresFixture({ migrate: false });
  prisma = fixture.prisma;
  db = fixture.db;
  await prisma.$executeRawUnsafe(
    'CREATE TABLE ep_file_cleanup(path TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL, "createdAt" TEXT NOT NULL)'
  );
  await prisma.$executeRawUnsafe(
    'CREATE TABLE ep_documents(id TEXT PRIMARY KEY, "originalPath" TEXT)'
  );
});
beforeEach(async () => {
  root = path.join(directory, crypto.randomUUID(), "enterprise");
  await db.run("DELETE FROM ep_file_cleanup");
  await db.run("DELETE FROM ep_documents");
  files = createFileStore({ db, root });
});
afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true });
  jest.restoreAllMocks();
});
afterAll(async () => {
  await fixture?.cleanup();
  await fs.rm(directory, { recursive: true, force: true });
});

async function original(
  tenantId = "tenant-a",
  resourceId = "document-a",
  content = "原件"
) {
  return files.withWrite(() =>
    files.persistOriginal({ tenantId }, resourceId, {
      originalname: "same.TXT",
      buffer: Buffer.from(content),
    })
  );
}

test("an interrupted upload leaves a durable candidate and a new store recovers it without touching other tenant files", async () => {
  const first = await original();
  const other = await original("tenant-b", "document-b", "另一租户原件");
  await db.run(
    'INSERT INTO ep_documents(id,"originalPath") VALUES($1,$2)',
    "document-b",
    other
  );
  await files.releaseCandidate(db, other, "tenant-b");
  expect(await db.all("SELECT * FROM ep_file_cleanup")).toEqual([
    expect.objectContaining({ path: first, tenantId: "tenant-a" }),
  ]);
  const recovered = createFileStore({ db, root });
  expect(await recovered.recoverCleanup()).toBe(true);
  await expect(fs.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(other, "utf8")).toBe("另一租户原件");
  expect(await db.all("SELECT * FROM ep_file_cleanup")).toEqual([]);
});

test("cleanup retries locked files after restart and treats already missing originals as success", async () => {
  const file = await original();
  const locked = createFileStore({
    db,
    root,
    files: {
      ...fs,
      unlink: jest.fn(async () => {
        throw Object.assign(new Error("locked"), { code: "EACCES" });
      }),
    },
  });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  expect(await locked.flushCleanup()).toBe(false);
  expect((await db.all("SELECT * FROM ep_file_cleanup"))[0].path).toBe(file);
  expect(await fs.readFile(file, "utf8")).toBe("原件");
  expect(await files.recoverCleanup()).toBe(true);
  await files.queueCleanup(db, [{ path: file, tenantId: "tenant-a" }]);
  expect(await files.flushCleanup()).toBe(true);
  expect(await db.all("SELECT * FROM ep_file_cleanup")).toEqual([]);
  expect(log).toHaveBeenCalled();
});

test("cleanup never removes an attached original even if a stale task remains", async () => {
  const file = await original();
  await db.run(
    'INSERT INTO ep_documents(id,"originalPath") VALUES($1,$2)',
    "attached",
    file
  );
  expect(await files.flushCleanup()).toBe(true);
  expect(await fs.readFile(file, "utf8")).toBe("原件");
  expect(await db.all("SELECT * FROM ep_file_cleanup")).toEqual([]);
});

test("publication and old-original retirement roll back atomically with the document", async () => {
  const first = await original();
  await db.run(
    'INSERT INTO ep_documents(id,"originalPath") VALUES($1,$2)',
    "attached",
    first
  );
  await files.releaseCandidate(db, first, "tenant-a");
  const replacement = await original();
  await expect(
    prisma.$transaction(async (tx) => {
      const transaction = {
        run: (sql, ...params) => tx.$executeRawUnsafe(sql, ...params),
      };
      await files.queueCleanup(transaction, [
        { path: first, tenantId: "tenant-a" },
      ]);
      await transaction.run(
        'UPDATE ep_documents SET "originalPath"=$1 WHERE id=$2',
        replacement,
        "attached"
      );
      await files.releaseCandidate(transaction, replacement, "tenant-a");
      throw new Error("rollback");
    })
  ).rejects.toThrow("rollback");
  expect(
    (
      await db.one(
        'SELECT "originalPath" FROM ep_documents WHERE id=$1',
        "attached"
      )
    ).originalPath
  ).toBe(first);
  expect(await files.flushCleanup()).toBe(true);
  expect(await fs.readFile(first, "utf8")).toBe("原件");
  await expect(fs.stat(replacement)).rejects.toMatchObject({ code: "ENOENT" });
});

test("symlinks into another tenant or outside storage cannot be read, persisted, or cleaned", async () => {
  const other = await original("tenant-b", "document-b", "另一租户原件");
  await files.releaseCandidate(db, other, "tenant-b");
  const tenant = path.join(root, "tenant-a");
  await fs.mkdir(tenant);
  await fs.symlink(
    path.dirname(other),
    path.join(tenant, "linked"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const link = path.join(tenant, "linked", path.basename(other));
  await expect(files.resolveOriginal(link, "tenant-a")).rejects.toThrow(
    "链接访问其他租户"
  );
  await expect(original("tenant-a", "linked")).rejects.toThrow(
    "链接写入其他租户"
  );
  await files.queueCleanup(db, [{ path: link, tenantId: "tenant-a" }]);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  expect(await files.flushCleanup()).toBe(false);
  expect(await fs.readFile(other, "utf8")).toBe("另一租户原件");
  expect(log).toHaveBeenCalled();
});

test("tenant and path validation rejects traversal and wrong-tenant cleanup before file access", async () => {
  for (const tenantId of [
    "",
    ".",
    "..",
    "../tenant-b",
    "tenant/a",
    "tenant\\a",
  ]) {
    expect(
      files.safeOriginal(path.join(root, "tenant-b", "x.txt"), tenantId)
    ).toBe(false);
  }
  expect(files.safeOriginal("relative.txt", "tenant-a")).toBe(false);
  expect(files.safeOriginal(null, "tenant-a")).toBe(false);
  await expect(
    files.resolveOriginal(path.join(root, "tenant-b", "x.txt"), "tenant-a")
  ).rejects.toThrow("路径无效");
  await expect(
    files.queueCleanup(db, [
      { path: path.join(directory, "outside.txt"), tenantId: "tenant-a" },
    ])
  ).rejects.toThrow("路径无效");
  await expect(original("tenant-a", "../../outside")).rejects.toThrow(
    "存储路径无效"
  );
  await files.queueCleanup(db, [{ path: null, tenantId: "tenant-a" }]);
  await files.releaseCandidate(db, null, "tenant-a");
});

test("a tenant-directory alias cannot expose or change another tenant's originals", async () => {
  const other = await original("tenant-b", "document-b", "另一租户原件");
  await files.releaseCandidate(db, other, "tenant-b");
  await fs.symlink(
    path.join(root, "tenant-b"),
    path.join(root, "tenant-a"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const alias = path.join(root, "tenant-a", "document-b", path.basename(other));
  await expect(files.resolveOriginal(alias, "tenant-a")).rejects.toThrow(
    "链接访问其他租户"
  );
  await expect(original("tenant-a", "document-b")).rejects.toThrow(
    "链接写入其他租户"
  );
  expect(await fs.readFile(other, "utf8")).toBe("另一租户原件");
});

test("read failures are safe and directory paths are never treated as originals", async () => {
  const file = await original();
  await expect(
    files.resolveOriginal(path.dirname(file), "tenant-a")
  ).rejects.toThrow("原文件无效");
  await expect(
    files.resolveOriginal(
      path.join(path.dirname(file), "missing.txt"),
      "tenant-a"
    )
  ).rejects.toThrow("不存在");
  const inaccessible = createFileStore({
    db,
    root,
    files: {
      ...fs,
      realpath: async () => {
        throw Object.assign(new Error("sensitive path"), { code: "EACCES" });
      },
    },
  });
  await expect(inaccessible.resolveOriginal(file, "tenant-a")).rejects.toThrow(
    "暂时无法读取"
  );
});

test("cleanup waits for an in-flight original publication and the lock continues after a failed write", async () => {
  let unlock;
  const gate = new Promise((resolve) => {
    unlock = resolve;
  });
  const publishing = files.withWrite(async () => {
    const file = await files.persistOriginal(
      { tenantId: "tenant-a" },
      "publishing",
      { originalname: "a.txt", buffer: Buffer.from("published") }
    );
    await gate;
    await db.run(
      'INSERT INTO ep_documents(id,"originalPath") VALUES($1,$2)',
      "published",
      file
    );
    await files.releaseCandidate(db, file, "tenant-a");
    return file;
  });
  const cleaning = files.flushCleanup();
  unlock();
  const file = await publishing;
  expect(await cleaning).toBe(true);
  expect(await fs.readFile(file, "utf8")).toBe("published");
  await expect(
    files.withWrite(() => Promise.reject(new Error("failed write")))
  ).rejects.toThrow("failed write");
  expect(await files.withWrite(async () => "continued")).toBe("continued");
});

test("a missing file after realpath is idempotent and database failures retain deferred recovery", async () => {
  const file = await original();
  const gone = createFileStore({
    db,
    root,
    files: {
      ...fs,
      unlink: async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    },
  });
  expect(await gone.flushCleanup()).toBe(true);
  expect(await db.all("SELECT * FROM ep_file_cleanup")).toEqual([]);
  const failed = createFileStore({
    db: {
      ...db,
      all: async () => {
        throw new Error("database failed");
      },
    },
    root,
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
  expect(await failed.recoverCleanup()).toBe(false);
  expect(await fs.readFile(file, "utf8")).toBe("原件");
});
