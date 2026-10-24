const fs = require("fs/promises");
const path = require("path");
const store = require("./store");

const STORAGE_ROOT = path.resolve(
  process.env.STORAGE_DIR || path.resolve(__dirname, "../storage"),
  "enterprise"
);

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function createFileStore({ db = store, root = STORAGE_ROOT, files = fs } = {}) {
  root = path.resolve(root);
  let writes = Promise.resolve();
  function withWrite(task) {
    const next = writes.then(task);
    writes = next.catch(() => {});
    return next;
  }
  function tenantRoot(tenantId) {
    if (
      typeof tenantId !== "string" ||
      !tenantId ||
      tenantId === "." ||
      tenantId === ".." ||
      /[/\\]/.test(tenantId)
    )
      return null;
    const directory = path.resolve(root, tenantId);
    return isWithin(root, directory) ? directory : null;
  }
  function safeOriginal(filePath, tenantId) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath))
      return false;
    const directory = tenantId === undefined ? root : tenantRoot(tenantId);
    return !!directory && isWithin(directory, path.resolve(filePath));
  }
  async function resolveOriginal(
    filePath,
    tenantId,
    { allowMissing = false } = {}
  ) {
    if (!safeOriginal(filePath, tenantId))
      throw new Error("知识资料原文件路径无效，请重新上传");
    try {
      const [realRoot, realTenant, realFile] = await Promise.all([
        files.realpath(root),
        files.realpath(tenantRoot(tenantId)),
        files.realpath(filePath),
      ]);
      const expectedTenant = path.resolve(realRoot, tenantId);
      if (realTenant !== expectedTenant || !isWithin(realTenant, realFile))
        throw new Error("知识资料不能通过链接访问其他租户或外部文件");
      const stat = await files.stat(realFile);
      if (!stat.isFile()) throw new Error("知识资料原文件无效，请重新上传");
      return realFile;
    } catch (error) {
      if (error.code === "ENOENT") {
        if (allowMissing) return null;
        throw new Error("知识资料原文件不存在，请重新上传");
      }
      if (error.code)
        throw new Error("知识资料原文件暂时无法读取，请检查文件存储状态");
      throw error;
    }
  }
  async function queueCleanup(tx, originals) {
    for (const original of originals) {
      if (!original.path) continue;
      if (!safeOriginal(original.path, original.tenantId))
        throw new Error("知识资料原文件路径无效，无法登记清理任务");
      await tx.run(
        'INSERT INTO ep_file_cleanup (path,"tenantId","createdAt") VALUES ($1,$2,$3) ON CONFLICT(path) DO NOTHING',
        original.path,
        original.tenantId,
        db.now()
      );
    }
  }
  // Caller holds withWrite through the SQL transaction that attaches this
  // candidate and removes its cleanup row. A crash leaves a durable orphan task.
  async function persistOriginal(ctx, resourceId, file) {
    const directory = path.resolve(root, ctx.tenantId, resourceId);
    if (!safeOriginal(directory, ctx.tenantId))
      throw new Error("知识资料存储路径无效");
    const filePath = path.join(
      directory,
      `${db.id()}${path.extname(file.originalname).toLowerCase()}`
    );
    await queueCleanup(db, [{ path: filePath, tenantId: ctx.tenantId }]);
    await files.mkdir(directory, { recursive: true });
    const [realRoot, realTenant, realDirectory] = await Promise.all([
      files.realpath(root),
      files.realpath(tenantRoot(ctx.tenantId)),
      files.realpath(directory),
    ]);
    if (
      realTenant !== path.resolve(realRoot, ctx.tenantId) ||
      !isWithin(realTenant, realDirectory)
    )
      throw new Error("知识资料不能通过链接写入其他租户或外部目录");
    if (file.path)
      await files.copyFile(
        file.path,
        filePath,
        require("fs").constants.COPYFILE_EXCL
      );
    else await files.writeFile(filePath, file.buffer, { flag: "wx" });
    return filePath;
  }
  async function releaseCandidate(tx, filePath, tenantId) {
    if (!filePath) return;
    await tx.run(
      'DELETE FROM ep_file_cleanup WHERE path=$1 AND "tenantId"=$2',
      filePath,
      tenantId
    );
  }
  async function flushCleanup() {
    return withWrite(async () => {
      let complete = true;
      const originals = await db.all(
        'SELECT * FROM ep_file_cleanup ORDER BY "createdAt",path'
      );
      for (const original of originals) {
        try {
          // An attached original always wins over a stale cleanup candidate.
          const referenced = await db.one(
            'SELECT id FROM ep_documents WHERE "originalPath"=$1 LIMIT 1',
            original.path
          );
          if (!referenced) {
            const existing = await resolveOriginal(
              original.path,
              original.tenantId,
              {
                allowMissing: true,
              }
            );
            if (existing) {
              // Unlink the authorized path, never a resolved external target.
              await files.unlink(original.path).catch((error) => {
                if (error.code !== "ENOENT") throw error;
              });
            }
          }
          await releaseCandidate(db, original.path, original.tenantId);
        } catch {
          complete = false;
          console.error("[knowledge] original file cleanup deferred");
        }
      }
      return complete;
    }).catch(() => {
      console.error("[knowledge] original file cleanup deferred");
      return false;
    });
  }
  return {
    withWrite,
    safeOriginal,
    resolveOriginal,
    persistOriginal,
    queueCleanup,
    releaseCandidate,
    flushCleanup,
    recoverCleanup: flushCleanup,
  };
}

module.exports = { ...createFileStore(), createFileStore };
