const path = require("path");
const fs = require("fs");
const os = require("os");
const multer = require("multer");
const store = require("./store");
const { Document } = require("../models/documents");
const { DocumentVectors } = require("../models/vectors");
const {
  requireAuth,
  requirePlatformAuth,
  fail,
  refreshContext,
} = require("./auth");
const providers = require("./providers");
const { getSettings } = require("./rag-settings");
const vectorStore = require("./vector-store");
const fileStore = require("./file-store");
const {
  extensions,
  textFallback,
  maxFileSizeBytes,
} = require("../utils/files/types");
const configuredContentLimit = Number(
  process.env.KNOWLEDGE_MAX_CONTENT_CHARACTERS
);
const MAX_CONTENT =
  Number.isSafeInteger(configuredContentLimit) && configuredContentLimit > 0
    ? configuredContentLimit
    : Number.MAX_SAFE_INTEGER;
const approvals = require("./knowledge-approvals");
const pending = new Set();
let work = Promise.resolve();
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function allowedLibrary(library, ctx) {
  return !!library?.grants?.some(
    (grant) => grant.tenantId === ctx.tenantId || grant.userId === ctx.userId
  );
}

async function requireLibrary(ctx, libraryId, db = store) {
  if (ctx.identity === "platform") {
    const library = await db.one(
      `SELECT l.*, CASE WHEN EXISTS (SELECT 1 FROM ep_library_grants g WHERE g."libraryId"=l.id AND g."tenantId" IS NOT NULL) THEN 'public' ELSE 'private' END AS visibility FROM ep_libraries l WHERE l.id=$1`,
      libraryId
    );
    if (!library) throw fail(404, "知识库不存在");
    return library;
  }
  const library = await db.one(
    `SELECT l.*, ${Document.libraryVisibilitySQL()} AS visibility FROM ep_libraries l WHERE ${Document.libraryAccessSQL()} AND l.id=$3`,
    ctx.tenantId,
    ctx.userId,
    libraryId
  );
  if (!library) throw fail(404, "知识库不存在或无权访问");
  return library;
}

async function requireDocument(ctx, documentId, db = store) {
  const document = await Document.get(ctx, { id: documentId }, db.orm);
  if (!document) throw fail(404, "资料不存在或无权访问");
  const library = await requireLibrary(ctx, document.libraryId, db);
  return {
    ...document,
    libraryName: library.name,
    visibility: library.visibility,
  };
}

function publicDocument(document, { canWrite = true } = {}) {
  const { originalPath, metadata, ...result } = document;
  const parsedMetadata = require("../utils/http").safeJsonParse(metadata, {});
  const canWatch =
    require("../models/documentSyncQueue").DocumentSyncQueue.canWatch(
      parsedMetadata
    );
  return { ...result, hasOriginal: !!originalPath, canWrite, canWatch };
}

function textInput(value, label, max, required = true) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  ) {
    throw fail(400, `${label}不能为空，且长度不能超过 ${max} 个字符`);
  }
  return value.replace(/\r\n/g, "\n").split("\u0000").join("").trim();
}

// Keep the original disk-upload lifecycle. UUID temporary names avoid one
// tenant replacing another upload before the destination grant is checked.
const uploadDirectory = path.resolve(
  os.tmpdir(),
  "anythingllm-knowledge-uploads"
);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) =>
      fs.mkdir(uploadDirectory, { recursive: true }, (error) =>
        done(error, uploadDirectory)
      ),
    filename: (_req, file, done) =>
      done(
        null,
        `${store.id()}${path.extname(file.originalname).toLowerCase()}`
      ),
  }),
  limits: { fileSize: maxFileSizeBytes, files: 1, fields: 5, fieldSize: 4096 },
}).single("file");

function receiveUpload(req, res, next) {
  if (req.file) return next();
  upload(req, res, (error) => {
    if (error)
      return next(
        error.code === "LIMIT_FILE_SIZE"
          ? fail(413, "文件超过当前部署允许的上传大小")
          : error
      );
    if (!req.file) return next(fail(400, "请选择上传文件"));
    const temporary = req.file.path;
    let cleanupStarted = false;
    const remove = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      return fs.promises.unlink(temporary).catch((failure) => {
        if (failure.code !== "ENOENT")
          console.error("[knowledge] temporary upload cleanup failed");
      });
    };
    res.once("finish", remove);
    res.once("close", remove);
    next();
  });
}

async function parseFile(document) {
  const original = await fileStore.resolveOriginal(
    document.originalPath,
    document.tenantId
  );
  const ext = path.extname(document.originalPath).toLowerCase();
  const { CollectorApi } = require("../utils/collectorApi");
  const result = await new CollectorApi().parseDocument(
    `${document.id}${ext}`,
    {
      absolutePath: original,
    }
  );
  if (!result.success)
    throw new Error(
      result.reason || "无法提取文件文字，请检查文件是否损坏或为扫描 PDF"
    );
  return result.documents || [];
}

async function indexDocument(documentId, version, ctx, change = null) {
  let originTenantId;
  try {
    // A queued actor may be disabled before recovery. Keep the stored origin
    // available for the failure transition without substituting actor tenancy.
    originTenantId = (
      await store.one(
        'SELECT "tenantId" FROM ep_documents WHERE id=$1 AND version=$2',
        documentId,
        version
      )
    )?.tenantId;
    ctx = await refreshContext(ctx);
    let document;
    if (change) {
      const data = approvals.payload(change);
      await requireReviewer(ctx, change.tenantId);
      await authorizeChange(change, ctx, store);
      if (change.action === "document.create") document = data;
      else {
        const previous = await requireDocument(ctx, documentId);
        document = { ...previous, ...data, version, status: "processing" };
        if (
          change.action === "document.update" &&
          data.content !== undefined &&
          data.content !== previous.content
        )
          document = { ...document, originalPath: null, inputType: "text" };
      }
      await requireLibrary(ctx, document.libraryId);
    } else {
      document = await requireDocument(ctx, documentId);
      if (document.version !== version || document.status !== "processing")
        return;
    }
    originTenantId = document.tenantId;
    const metadata = require("../utils/http").safeJsonParse(
      document.metadata,
      {}
    );
    let pages = [{ pageContent: document.content, metadata }];
    if (document.inputType === "file" && !document.content)
      pages = await parseFile(document);
    let content = pages.map((page) => page.pageContent || "").join("\n\n");
    content = textInput(content, "资料正文", MAX_CONTENT);
    const connection = await providers.resolveConnection(
      { tenantId: originTenantId },
      "embedding"
    );
    const embeddingId = providers.connectionIdentity(connection);
    const { TextSplitter } = require("../utils/TextSplitter");
    const settings = await getSettings(originTenantId);
    const chunkSize = TextSplitter.determineMaxChunkSize(
      settings.chunkSize,
      providers.embeddingChunkLimit(connection)
    );
    const split = [];
    for (const page of pages) {
      const sourceMetadata = {
        ...metadata,
        ...page.metadata,
        title: document.title,
      };
      const texts = await new TextSplitter({
        chunkSize,
        chunkOverlap: Math.min(settings.chunkOverlap, chunkSize - 1),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(sourceMetadata),
      }).splitText(page.pageContent);
      for (const text of texts.filter((text) => text.trim()))
        split.push({ text, metadata: sourceMetadata });
    }
    const chunks = split.map((chunk) => chunk.text);
    if (!chunks.length)
      throw new Error("文件没有可提取的文字，请上传文字型文件");
    let vectors = chunks.map(() => null);
    if (settings.embeddingCache) {
      const rows = await store.all(
        'SELECT id,"tenantId","documentId","embeddingId",version,namespace,dimensions,content FROM ep_chunks WHERE "tenantId"=$1 AND "documentId"=$2 AND "embeddingId"=$3',
        originTenantId,
        documentId,
        embeddingId
      );
      vectors = await vectorStore.withDatabase((backend) =>
        require("./vector-cache").cachedVectorInformation({
          backend,
          rows,
          chunks,
          identity: embeddingId,
          tenantId: originTenantId,
          documentId,
        })
      );
    }
    const missing = chunks.flatMap((text, index) =>
      vectors[index] ? [] : [{ text, index }]
    );
    const embedded = missing.length
      ? await providers.embed(
          connection,
          missing.map(({ text }) => text)
        )
      : [];
    if (embedded.length !== missing.length)
      throw new Error("Embedding 服务返回无效向量");
    missing.forEach(({ index }, offset) => {
      vectors[index] = embedded[offset];
    });
    if (
      vectors.length !== chunks.length ||
      vectors.some(
        (vector) =>
          !Array.isArray(vector) ||
          !vector.length ||
          vector.some((n) => !Number.isFinite(n))
      )
    ) {
      throw new Error("Embedding 服务返回无效向量");
    }
    await vectorStore.withWrite(async (backend) => {
      // A recovered attempt can reuse the same document version. Retired vectors
      // must be gone before publishing new chunk IDs for that version, or they
      // could occupy TopK and then be discarded by the SQL authorization join.
      await vectorStore.flushCleanup(backend, true);
      const dimensions = vectors[0].length;
      if (vectors.some((vector) => vector.length !== dimensions))
        throw new Error("Embedding 服务返回不一致的向量维度");
      const namespace = vectorStore.namespaceFor({
        tenantId: originTenantId,
        embeddingId,
        dimensions,
      });
      const records = chunks.map((text, position) => ({
        id: store.id(),
        vector: vectors[position],
        tenantId: originTenantId,
        documentId,
        version,
        embeddingId,
        libraryId: document.libraryId,
        metadata: split[position].metadata,
        text,
      }));
      // The cleanup outbox survives a crash between vector upsert and SQL
      // publication. Only a committed current version becomes searchable.
      await store.transaction(
        (tx) =>
          vectorStore.queueCleanup(
            tx,
            records.map((record) => ({ ...record, namespace }))
          ),
        { retry: true }
      );
      await backend.upsert({ namespace, records });
      await store.transaction(
        async (tx) => {
          await refreshContext(ctx, tx);
          let current;
          if (change) {
            await requireReviewer(ctx, change.tenantId, tx);
            await authorizeChange(change, ctx, tx);
            const pendingChange = await tx.one(
              "SELECT * FROM ep_knowledge_changes WHERE id=$1 FOR UPDATE",
              change.id
            );
            if (!pendingChange || pendingChange.status !== "processing")
              throw fail(409, "审批状态已经变更");
            if (change.action === "document.create") {
              await requireLibrary(ctx, document.libraryId, tx);
              await Document.new(
                ctx,
                {
                  ...document,
                  content,
                  status: "ready",
                  error: null,
                  embeddingId,
                },
                tx.orm
              );
              await tx.run(
                'UPDATE ep_documents SET "createdBy"=$1 WHERE id=$2',
                document.createdBy,
                documentId
              );
            } else {
              current = await requireDocument(ctx, documentId, tx);
              if (
                current.version !== change.baseVersion ||
                current.updatedAt !== change.baseUpdatedAt
              )
                throw fail(409, "处理期间资源已变更，请管理员重新审核");
              if (current.originalPath !== document.originalPath)
                await fileStore.queueCleanup(tx, [
                  { path: current.originalPath, tenantId: current.tenantId },
                ]);
              await tx.run(
                'UPDATE ep_documents SET title=$1,content=$2,"originalPath"=$3,"inputType"=$4,status=\'ready\',error=NULL,version=$5,"embeddingId"=$6,"updatedBy"=$7,"updatedAt"=$8,pinned=COALESCE($10,pinned) WHERE id=$9',
                document.title,
                content,
                document.originalPath,
                document.inputType,
                version,
                embeddingId,
                String(ctx.userId),
                store.now(),
                documentId,
                document.pinned ?? null
              );
            }
            await fileStore.releaseCandidate(
              tx,
              document.originalPath,
              document.tenantId
            );
          } else {
            current = await requireDocument(ctx, documentId, tx);
            if (current.version !== version || current.status !== "processing")
              return;
          }
          const obsolete = await tx.all(
            'SELECT id,"tenantId",namespace FROM ep_chunks WHERE "documentId"=$1 AND "tenantId"=$2',
            documentId,
            originTenantId
          );
          await vectorStore.queueCleanup(tx, obsolete);
          await DocumentVectors.delete(ctx, { documentId }, tx.orm);
          await DocumentVectors.bulkInsert(
            ctx,
            records.map((record, position) => ({
              id: record.id,
              tenantId: originTenantId,
              documentId,
              version,
              position,
              content: chunks[position],
              metadata: JSON.stringify(split[position].metadata),
              embeddingId,
              dimensions,
              namespace,
            })),
            tx.orm
          );
          for (const record of records)
            await tx.run(
              "DELETE FROM ep_vector_cleanup WHERE id=$1 AND namespace=$2",
              record.id,
              namespace
            );
          await tx.run(
            'UPDATE ep_documents SET content = $1, status = \'ready\', error = NULL, "embeddingId" = $2, "updatedAt" = $3 WHERE id = $4 AND "tenantId" = $5 AND version = $6',
            content,
            embeddingId,
            store.now(),
            documentId,
            originTenantId,
            version
          );
          if (change)
            await tx.run(
              "UPDATE ep_knowledge_changes SET status='approved',\"updatedAt\"=$1 WHERE id=$2",
              store.now(),
              change.id
            );
        },
        { retry: true }
      );
      if (settings.embeddingCache) {
        const published = await store.one(
          "SELECT id FROM ep_documents WHERE id=$1 AND version=$2 AND status='ready'",
          documentId,
          version
        );
        if (published)
          await require("./vector-cache").storeVectorResult({
            chunks,
            vectors,
            identity: embeddingId,
            tenantId: originTenantId,
            documentId,
          });
      }
      await vectorStore.flushCleanup(backend);
    });
  } catch (error) {
    if (change) {
      await store.run(
        'UPDATE ep_knowledge_changes SET status=$1,"reviewNote"=$2,"updatedAt"=$3 WHERE id=$4 AND status=\'processing\'',
        error.status === 409 ? "conflict" : "failed",
        error.status
          ? error.message
          : "资料发布失败，请检查模型或索引服务后重试",
        store.now(),
        change.id
      );
      throw error;
    }
    // The version guard also prevents an interrupted older task from marking a replacement as failed.
    await store
      .run(
        "UPDATE ep_documents SET status = 'failed', error = $1, \"updatedAt\" = $2 WHERE id = $3 AND \"tenantId\" = $4 AND version = $5 AND status = 'processing'",
        error.message?.slice(0, 800) || "资料处理失败",
        store.now(),
        documentId,
        originTenantId,
        version
      )
      .catch(() => {});
  }
}

function enqueue(document, ctx) {
  const key = `${document.id}:${document.version}`;
  if (pending.has(key)) return;
  pending.add(key);
  work = work
    .then(() => indexDocument(document.id, document.version, { ...ctx }))
    .catch(() => {})
    .finally(() => pending.delete(key));
}

async function recoverJobs() {
  const filesClean = await fileStore.recoverCleanup();
  if (!(await vectorStore.recoverCleanup()))
    throw fail(503, "向量索引清理尚未完成，请恢复向量数据库后重试资料处理");
  const jobs = await store.all(
    'SELECT d.*,u."tenantId" AS "actorTenantId",p.id AS "platformActor" FROM ep_documents d LEFT JOIN users u ON u.id::text=d."updatedBy" LEFT JOIN ep_platform_accounts p ON p.id=d."updatedBy" WHERE d.status = \'processing\''
  );
  for (const job of jobs)
    enqueue(job, {
      ...(job.platformActor
        ? { identity: "platform" }
        : { tenantId: job.actorTenantId }),
      userId: job.platformActor ? job.updatedBy : Number(job.updatedBy),
    });
  const changes = await store.all(
    "SELECT * FROM ep_knowledge_changes WHERE status='processing'"
  );
  for (const change of changes) {
    try {
      const platform = await store.one(
        "SELECT id FROM ep_platform_accounts WHERE id=$1",
        change.reviewedBy
      );
      const actor = platform
        ? await require("./auth").platformContext(change.reviewedBy)
        : await require("./auth").context(Number(change.reviewedBy));
      await applyChange(change, actor);
    } catch (error) {
      await store.run(
        "UPDATE ep_knowledge_changes SET status='failed',\"reviewNote\"=$1,\"updatedAt\"=$2 WHERE id=$3 AND status='processing'",
        error.status ? error.message : "审批发布恢复失败，请检查服务后重试",
        store.now(),
        change.id
      );
    }
  }
  if (!filesClean) throw fail(503, "原文件清理尚未完成，请检查文件存储状态");
}

// Recovery is bounded and runs in the background. A temporarily unavailable
// backend during startup must not abandon all persisted processing jobs.
function startRecovery({
  attempts = 5,
  delay = 1000,
  schedule = setTimeout,
} = {}) {
  let attempt = 0;
  const run = async () => {
    attempt++;
    try {
      await recoverJobs();
    } catch {
      console.error(`[knowledge] recovery deferred (${attempt}/${attempts})`);
      if (attempt < attempts) {
        const timer = schedule(run, delay * 2 ** (attempt - 1));
        timer?.unref?.();
      }
    }
  };
  return run();
}

function requirePrivate(library) {
  if (library.visibility === "public")
    throw fail(409, "知识库授权已变更，请刷新后重新提交审批");
}

async function createLibraryRow(ctx, library, visibility, tx) {
  await tx.run(
    'INSERT INTO ep_libraries(id,"tenantId",name,"createdBy","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6)',
    library.id,
    library.tenantId,
    library.name,
    library.createdBy,
    library.createdAt,
    library.updatedAt
  );
  await tx.orm.ep_library_grants.create({
    data: {
      id: store.id(),
      libraryId: library.id,
      ...(visibility === "public"
        ? { tenantId: library.tenantId }
        : { userId: ctx.userId }),
    },
  });
}

async function requireLibraryManager(ctx, library, tx = store) {
  const current = await refreshContext(ctx, tx);
  if (current.identity === "platform") return current;
  if (library.tenantId !== current.tenantId)
    throw fail(403, "只能管理本企业知识库");
  if (library.visibility === "public") {
    if (current.role !== "admin")
      throw fail(403, "需要企业管理员管理公有知识库");
  } else await requireLibrary(current, library.id, tx);
  return current;
}

async function authorizeChange(change, actor, tx) {
  // Requests do not acquire a permanent permission: disabled users and revoked
  // grants cannot publish a previously queued proposal.
  const auth = require("./auth");
  const platformRequester = await tx.one(
    "SELECT id FROM ep_platform_accounts WHERE id=$1",
    change.requestedBy
  );
  const requester =
    change.requestedBy === String(actor.userId)
      ? actor
      : platformRequester
        ? await auth.platformContext(change.requestedBy, tx)
        : await auth.context(change.requestedBy, tx);
  if (change.action === "library.create") {
    const tenant = await tx.one(
      "SELECT status FROM ep_tenants WHERE id=$1",
      change.tenantId
    );
    if (tenant?.status !== "active") throw fail(409, "企业已停用");
    return null;
  }
  const library = await requireLibrary(requester, change.libraryId, tx);
  if (library.tenantId !== change.tenantId) throw fail(403, "审批企业不匹配");
  if (change.action.startsWith("library.")) return library;
  return change.documentId && change.action !== "document.create"
    ? requireDocument(requester, change.documentId, tx)
    : library;
}

async function deleteLibraryOrDocument(ctx, library, document, tx) {
  const documents = document
    ? [document]
    : await tx.all(
        'SELECT * FROM ep_documents WHERE "libraryId"=$1',
        library.id
      );
  for (const item of documents) {
    const abandoned = await tx.all(
      "SELECT * FROM ep_knowledge_changes WHERE \"documentId\"=$1 AND status IN ('pending','conflict','failed','processing')",
      item.id
    );
    for (const proposal of abandoned) {
      const candidate = approvals.payload(proposal);
      if (candidate.originalPath)
        await fileStore.queueCleanup(tx, [
          { path: candidate.originalPath, tenantId: proposal.tenantId },
        ]);
      await tx.run(
        'UPDATE ep_knowledge_changes SET status=\'cancelled\',"reviewNote"=$1,"updatedAt"=$2 WHERE id=$3',
        "资料已删除",
        store.now(),
        proposal.id
      );
    }
    await fileStore.queueCleanup(tx, [
      { path: item.originalPath, tenantId: item.tenantId },
    ]);
    await vectorStore.queueCleanup(
      tx,
      await tx.all(
        'SELECT id,"tenantId",namespace FROM ep_chunks WHERE "documentId"=$1',
        item.id
      )
    );
    await tx.run('DELETE FROM ep_chunks WHERE "documentId"=$1', item.id);
    await tx.run("DELETE FROM ep_documents WHERE id=$1", item.id);
    await require("./vector-cache").purgeVectorCache({
      tenantId: item.tenantId,
      documentId: item.id,
    });
  }
  if (!document) {
    const outstanding = await tx.all(
      "SELECT * FROM ep_knowledge_changes WHERE \"libraryId\"=$1 AND status IN ('pending','conflict','failed','processing')",
      library.id
    );
    for (const proposal of outstanding) {
      const candidate = approvals.payload(proposal);
      if (candidate.originalPath)
        await fileStore.queueCleanup(tx, [
          { path: candidate.originalPath, tenantId: proposal.tenantId },
        ]);
      await tx.run(
        'UPDATE ep_knowledge_changes SET status=\'cancelled\',"reviewNote"=$1,"updatedAt"=$2 WHERE id=$3',
        "知识库已删除",
        store.now(),
        proposal.id
      );
    }
    await tx.run(
      'DELETE FROM ep_library_grants WHERE "libraryId"=$1',
      library.id
    );
    await tx.run("DELETE FROM ep_libraries WHERE id=$1", library.id);
  }
}

async function requireReviewer(ctx, tenantId, tx = store) {
  const actor = await refreshContext(ctx, tx);
  if (
    actor.identity !== "platform" &&
    (actor.role !== "admin" || actor.tenantId !== tenantId)
  )
    throw fail(403, "需要本企业管理员审批");
  return actor;
}

async function applyChange(change, ctx) {
  await requireReviewer(ctx, change.tenantId);
  const data = approvals.payload(change);
  if (
    [
      "document.create",
      ...(change.action === "document.update" && data.content === undefined
        ? []
        : ["document.update"]),
      "document.replace",
      "document.reindex",
    ].includes(change.action)
  ) {
    await indexDocument(
      change.documentId || data.id,
      (change.baseVersion || 0) + 1,
      ctx,
      change
    );
    await fileStore.flushCleanup();
    return;
  }
  await fileStore.withWrite(() =>
    vectorStore.withWrite(async (backend) => {
      await store.transaction(
        async (tx) => {
          await requireReviewer(ctx, change.tenantId, tx);
          const current = await tx.one(
            "SELECT * FROM ep_knowledge_changes WHERE id=$1 FOR UPDATE",
            change.id
          );
          if (current?.status !== "processing")
            throw fail(409, "审批状态已变更");
          const resource = await authorizeChange(change, ctx, tx);
          if (
            resource &&
            (resource.updatedAt !== change.baseUpdatedAt ||
              (change.documentId && resource.version !== change.baseVersion))
          )
            throw fail(409, "资源已变更，请管理员重新审核");
          if (change.action === "library.create")
            await createLibraryRow(ctx, data, "public", tx);
          else if (change.action === "library.update")
            await tx.run(
              'UPDATE ep_libraries SET name=$1,"updatedAt"=$2 WHERE id=$3',
              data.name,
              store.now(),
              resource.id
            );
          else if (change.action === "library.grants") {
            await tx.run(
              'DELETE FROM ep_library_grants WHERE "libraryId"=$1',
              resource.id
            );
            await tx.orm.ep_library_grants.create({
              data: {
                id: store.id(),
                libraryId: resource.id,
                ...(data.visibility === "public"
                  ? { tenantId: resource.tenantId }
                  : { userId: data.userId }),
              },
            });
            await tx.run(
              'UPDATE ep_libraries SET "updatedAt"=$1 WHERE id=$2',
              store.now(),
              resource.id
            );
          } else if (change.action === "library.delete")
            await deleteLibraryOrDocument(ctx, resource, null, tx);
          else if (change.action === "document.update")
            await tx.run(
              'UPDATE ep_documents SET title=$1,"updatedBy"=$2,"updatedAt"=$3,pinned=COALESCE($5,pinned) WHERE id=$4',
              data.title || resource.title,
              String(ctx.userId),
              store.now(),
              resource.id,
              data.pinned ?? null
            );
          else if (change.action === "document.delete")
            await deleteLibraryOrDocument(
              ctx,
              { id: resource.libraryId },
              resource,
              tx
            );
          else throw fail(400, "不支持的知识变更");
          await tx.run(
            "UPDATE ep_knowledge_changes SET status='approved',\"updatedAt\"=$1 WHERE id=$2",
            store.now(),
            change.id
          );
        },
        { retry: true }
      );
      await vectorStore.flushCleanup(backend);
    })
  );
  await fileStore.flushCleanup();
}

async function submitText(ctx, input) {
  let library;
  const document = {
    id: store.id(),
    title: textInput(input.title, "资料标题", 255),
    content: textInput(input.content, "资料正文", MAX_CONTENT),
    inputType: "text",
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
    originalPath: null,
    status: "processing",
    error: null,
    version: 1,
    embeddingId: null,
    createdBy: String(ctx.userId),
    updatedBy: String(ctx.userId),
    createdAt: store.now(),
    updatedAt: store.now(),
  };
  const result = await store.transaction(
    async (tx) => {
      await refreshContext(ctx, tx);
      library = await requireLibrary(ctx, input.libraryId, tx);
      Object.assign(document, {
        tenantId: library.tenantId,
        libraryId: library.id,
      });
      if (library.visibility === "public")
        return approvals.submit(
          ctx,
          { action: "document.create", library, data: document },
          tx
        );
      await Document.new(ctx, document, tx.orm);
      return { document: publicDocument(document) };
    },
    { retry: true }
  );
  if (!result.approvalRequired) enqueue(document, ctx);
  return result;
}

async function submitSyncedContent(ctx, documentId, newContent) {
  const content = textInput(newContent, "资料正文", MAX_CONTENT);
  let document, result;
  await fileStore.withWrite(() =>
    store.transaction(
      async (tx) => {
        await refreshContext(ctx, tx);
        const old = await requireDocument(ctx, documentId, tx);
        const library = await requireLibrary(ctx, old.libraryId, tx);
        if (old.content === content) {
          result = { document: publicDocument(old) };
          return;
        }
        if (library.visibility === "public") {
          result = await approvals.submit(
            ctx,
            {
              action: "document.update",
              library,
              document: old,
              data: { content },
            },
            tx
          );
          return;
        }
        await fileStore.queueCleanup(tx, [
          { path: old.originalPath, tenantId: old.tenantId },
        ]);
        await Document.update(
          ctx,
          old.id,
          {
            content,
            originalPath: null,
            inputType: "text",
            status: "processing",
            error: null,
            version: old.version + 1,
            updatedAt: store.now(),
          },
          tx.orm
        );
        document = await requireDocument(ctx, old.id, tx);
        result = { document: publicDocument(document) };
      },
      { retry: true }
    )
  );
  if (document) {
    await fileStore.flushCleanup();
    enqueue(document, ctx);
  }
  return result;
}

function publicMutation(action) {
  return wrap(async (req, res, next) => {
    let document;
    const library =
      action === "library.create"
        ? {
            id: store.id(),
            tenantId:
              req.ep.identity === "platform"
                ? req.body.tenantId
                : req.ep.tenantId,
            name: textInput(req.body.name, "知识库名称", 120),
            createdBy: String(req.ep.userId),
            createdAt: store.now(),
            updatedAt: store.now(),
            visibility: req.body.visibility,
          }
        : action.startsWith("library.")
          ? await requireLibrary(req.ep, req.params.id)
          : action === "document.create"
            ? await requireLibrary(req.ep, req.body.libraryId)
            : await (async () => {
                document = await requireDocument(req.ep, req.params.id);
                return requireLibrary(req.ep, document.libraryId);
              })();
    const becomingPublic =
      action === "library.grants" && req.body.visibility === "public";
    if (library.visibility !== "public" && !becomingPublic) return next();
    if (!library.tenantId) throw fail(400, "请选择企业");
    let data = {};
    if (action === "library.create") data = library;
    else if (action === "library.update")
      data = { name: textInput(req.body.name, "知识库名称", 120) };
    else if (action === "library.grants") {
      if (!["public", "private"].includes(req.body.visibility))
        throw fail(400, "知识授权类型无效");
      data = {
        visibility: req.body.visibility,
        userId:
          req.body.userId === undefined
            ? req.ep.userId
            : Number(req.body.userId),
      };
      if (data.visibility === "private") {
        const user = await store.one(
          "SELECT id FROM users WHERE id=$1 AND \"tenantId\"=$2 AND status='active'",
          data.userId,
          library.tenantId
        );
        if (!user) throw fail(400, "请选择本企业有效用户");
      }
    } else if (action === "document.create")
      data = {
        id: store.id(),
        tenantId: library.tenantId,
        libraryId: library.id,
        title: textInput(
          req.body.title || req.file?.originalname,
          "资料标题",
          255
        ),
        inputType: req.file ? "file" : "text",
        content: req.file
          ? ""
          : textInput(req.body.content, "资料正文", MAX_CONTENT),
        originalPath: null,
        status: "processing",
        error: null,
        version: 1,
        embeddingId: null,
        createdBy: String(req.ep.userId),
        updatedBy: String(req.ep.userId),
        createdAt: store.now(),
        updatedAt: store.now(),
      };
    else if (action === "document.update") {
      if (req.body.title !== undefined)
        data.title = textInput(req.body.title, "资料标题", 255);
      if (req.body.pinned !== undefined) {
        if (typeof req.body.pinned !== "boolean")
          throw fail(400, "置顶状态无效");
        data.pinned = req.body.pinned;
      }
      if (req.body.content !== undefined)
        data.content = textInput(req.body.content, "资料正文", MAX_CONTENT);
    } else if (action === "document.replace")
      data = { inputType: "file", content: "", originalPath: null };
    let result;
    try {
      await fileStore.withWrite(async () => {
        if (req.file)
          data.originalPath = await fileStore.persistOriginal(
            { tenantId: library.tenantId },
            document?.id || data.id,
            req.file
          );
        await store.transaction(
          async (tx) => {
            await refreshContext(req.ep, tx);
            if (action !== "library.create")
              await requireLibrary(req.ep, library.id, tx);
            result = await approvals.submit(
              req.ep,
              { action, library, document, data },
              tx
            );
            if (data.originalPath)
              await fileStore.releaseCandidate(
                tx,
                data.originalPath,
                library.tenantId
              );
          },
          { retry: true }
        );
      });
    } catch (error) {
      await fileStore.flushCleanup();
      throw error;
    }
    res.status(202).json(result);
  });
}

function registerKnowledge(
  router,
  {
    authenticate = requireAuth,
    platformAuthenticate = requirePlatformAuth,
  } = {}
) {
  const knowledgeAuth = (req, res, next) =>
    req.path.startsWith("/platform/")
      ? platformAuthenticate(req, res, next)
      : authenticate(req, res, next);
  approvals.registerApprovals(router, {
    apply: applyChange,
    authorize: authorizeChange,
    authenticate,
    platformAuthenticate,
  });
  for (const [method, route, action, file] of [
    ["post", "/libraries", "library.create"],
    ["patch", "/libraries/:id", "library.update"],
    ["delete", "/libraries/:id", "library.delete"],
    ["put", "/libraries/:id/grants", "library.grants"],
    ["post", "/documents", "document.create"],
    ["post", "/documents/upload", "document.create", true],
    ["patch", "/documents/:id", "document.update"],
    ["post", "/documents/:id/replace", "document.replace", true],
    ["post", "/documents/:id/retry", "document.reindex"],
    ["delete", "/documents/:id", "document.delete"],
  ])
    router[method](
      [route, `/platform${route}`],
      knowledgeAuth,
      ...(file ? [receiveUpload] : []),
      publicMutation(action)
    );

  for (const method of ["patch", "delete", "put"]) {
    const route = method === "put" ? "/libraries/:id/grants" : "/libraries/:id";
    router[method](
      [route, `/platform${route}`],
      knowledgeAuth,
      wrap(async (req, res) => {
        let library;
        await fileStore.withWrite(() =>
          vectorStore.withWrite(async (backend) => {
            await store.transaction(
              async (tx) => {
                library = await requireLibrary(req.ep, req.params.id, tx);
                await requireLibraryManager(req.ep, library, tx);
                requirePrivate(library);
                if (method === "patch")
                  await tx.run(
                    'UPDATE ep_libraries SET name=$1,"updatedAt"=$2 WHERE id=$3',
                    textInput(req.body.name, "知识库名称", 120),
                    store.now(),
                    library.id
                  );
                else if (method === "delete")
                  await deleteLibraryOrDocument(req.ep, library, null, tx);
                else {
                  if (req.body.visibility !== "private")
                    throw fail(400, "私有库转为公有库必须提交管理员审批");
                  const userId =
                    req.body.userId === undefined
                      ? req.ep.userId
                      : Number(req.body.userId);
                  if (
                    !(await tx.one(
                      "SELECT id FROM users WHERE id=$1 AND \"tenantId\"=$2 AND status='active'",
                      userId,
                      library.tenantId
                    ))
                  )
                    throw fail(400, "请选择本企业有效用户");
                  await tx.run(
                    'DELETE FROM ep_library_grants WHERE "libraryId"=$1',
                    library.id
                  );
                  await tx.orm.ep_library_grants.create({
                    data: { id: store.id(), libraryId: library.id, userId },
                  });
                  await tx.run(
                    'UPDATE ep_libraries SET "updatedAt"=$1 WHERE id=$2',
                    store.now(),
                    library.id
                  );
                }
              },
              { retry: true }
            );
            await vectorStore.flushCleanup(backend);
          })
        );
        await fileStore.flushCleanup();
        res.json({ success: true });
      })
    );
  }

  // The platform administrator uses its own audited identity for all resources;
  // it never impersonates an enterprise account.
  router.get(
    "/platform/libraries",
    platformAuthenticate,
    wrap(async (req, res) => {
      const libraries = await store.orm.ep_libraries.findMany({
        where: req.query.tenantId ? { tenantId: req.query.tenantId } : {},
        include: { grants: true, _count: { select: { documents: true } } },
        orderBy: { createdAt: "desc" },
      });
      res.json({
        libraries: libraries.map(({ _count, ...library }) => ({
          ...library,
          visibility: library.grants.some((grant) => grant.tenantId)
            ? "public"
            : "private",
          documentCount: _count.documents,
          canWrite: true,
        })),
      });
    })
  );
  router.get(
    "/platform/documents",
    platformAuthenticate,
    wrap(async (req, res) => {
      const documents = await store.orm.documents.findMany({
        where: {
          ...(req.query.tenantId ? { tenantId: req.query.tenantId } : {}),
          ...(req.query.libraryId ? { libraryId: req.query.libraryId } : {}),
        },
        orderBy: { updatedAt: "desc" },
      });
      res.json({
        documents: documents.map(({ content: _content, ...document }) =>
          publicDocument(document, { canWrite: true })
        ),
      });
    })
  );
  async function platformDocument(id) {
    const document = await store.orm.documents.findUnique({ where: { id } });
    if (!document) throw fail(404, "资料不存在");
    return document;
  }
  router.get(
    "/platform/documents/:id",
    platformAuthenticate,
    wrap(async (req, res) =>
      res.json({
        document: publicDocument(await platformDocument(req.params.id), {
          canWrite: true,
        }),
      })
    )
  );
  router.get(
    "/platform/documents/:id/download",
    platformAuthenticate,
    wrap(async (req, res) => {
      const document = await platformDocument(req.params.id);
      const original = await fileStore
        .resolveOriginal(document.originalPath, document.tenantId)
        .catch(() => {
          throw fail(404, "该资料没有可读取的原始文件");
        });
      res.download(original, document.title.replace(/[<>:"/\\|?*\r\n]/g, "_"));
    })
  );
  router.get("/file-types", authenticate, (_req, res) =>
    res.json({ extensions, textFallback, maxFileSizeBytes })
  );
  router.get(
    "/libraries",
    authenticate,
    wrap(async (req, res) => {
      const libraries = await store.all(
        `SELECT l.*, ${Document.libraryVisibilitySQL()} AS visibility, (SELECT COUNT(*) FROM ep_documents d WHERE d."libraryId"=l.id) AS "documentCount" FROM ep_libraries l WHERE ${Document.libraryAccessSQL()} ORDER BY l."createdAt" DESC`,
        req.ep.tenantId,
        req.ep.userId
      );
      res.json({
        libraries: libraries.map((library) => ({
          ...library,
          canWrite: true,
          approvalRequired: library.visibility === "public",
          canManage: true,
          documentCount: Number(library.documentCount),
        })),
      });
    })
  );
  router.post(
    ["/libraries", "/platform/libraries"],
    knowledgeAuth,
    wrap(async (req, res) => {
      const name = textInput(req.body.name, "知识库名称", 120);
      const visibility = req.body.visibility;
      if (!["public", "private"].includes(visibility))
        throw fail(400, "请选择公有或私有知识库");
      const library = {
        id: store.id(),
        tenantId:
          req.ep.identity === "platform" ? req.body.tenantId : req.ep.tenantId,
        name,
        createdBy: String(req.ep.userId),
        createdAt: store.now(),
        updatedAt: store.now(),
      };
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const ownerId =
            req.ep.identity === "platform"
              ? Number(req.body.userId)
              : req.ep.userId;
          if (
            !(await tx.one(
              "SELECT id FROM users WHERE id=$1 AND \"tenantId\"=$2 AND status='active'",
              ownerId,
              library.tenantId
            ))
          )
            throw fail(400, "请选择本企业有效用户");
          await tx.run(
            'INSERT INTO ep_libraries (id, "tenantId", name, "createdBy", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6)',
            ...[
              library.id,
              library.tenantId,
              library.name,
              library.createdBy,
              library.createdAt,
              library.updatedAt,
            ]
          );
          await tx.orm.ep_library_grants.create({
            data: {
              id: store.id(),
              libraryId: library.id,
              ...(visibility === "public"
                ? { tenantId: req.ep.tenantId }
                : {
                    userId:
                      req.ep.identity === "platform"
                        ? req.body.userId
                        : req.ep.userId,
                  }),
            },
          });
        },
        { retry: true }
      );
      res
        .status(201)
        .json({ library: { ...library, visibility, canWrite: true } });
    })
  );
  router.get(
    "/documents",
    authenticate,
    wrap(async (req, res) => {
      if (req.query.libraryId)
        await requireLibrary(req.ep, req.query.libraryId);
      const documents = await store.all(
        `SELECT d.*, l.name AS "libraryName", ${Document.libraryVisibilitySQL()} AS visibility FROM ep_documents d JOIN ep_libraries l ON l.id=d."libraryId" AND l."tenantId"=d."tenantId" WHERE ${Document.libraryAccessSQL()} ${req.query.libraryId ? 'AND d."libraryId"=$3' : ""} ORDER BY d."updatedAt" DESC`,
        req.ep.tenantId,
        req.ep.userId,
        ...(req.query.libraryId ? [req.query.libraryId] : [])
      );
      res.json({
        documents: documents.map(({ content: _content, ...document }) =>
          publicDocument(document)
        ),
      });
    })
  );
  async function createDocument(req, res, isFile) {
    const library = await requireLibrary(req.ep, req.body.libraryId);
    const title = textInput(
      req.body.title || (isFile && req.file.originalname),
      "资料标题",
      255
    );
    const content = isFile
      ? ""
      : textInput(req.body.content, "资料正文", MAX_CONTENT);
    const document = {
      id: store.id(),
      tenantId: library.tenantId,
      libraryId: library.id,
      title,
      inputType: isFile ? "file" : "text",
      content,
      originalPath: null,
      status: "processing",
      error: null,
      version: 1,
      embeddingId: null,
      createdBy: String(req.ep.userId),
      updatedBy: String(req.ep.userId),
      createdAt: store.now(),
      updatedAt: store.now(),
    };
    try {
      await fileStore.withWrite(async () => {
        if (isFile)
          document.originalPath = await fileStore.persistOriginal(
            { tenantId: document.tenantId },
            document.id,
            req.file
          );
        await store.transaction(
          async (tx) => {
            await refreshContext(req.ep, tx);
            requirePrivate(await requireLibrary(req.ep, library.id, tx));
            await Document.new(req.ep, document, tx.orm);
            await fileStore.releaseCandidate(
              tx,
              document.originalPath,
              document.tenantId
            );
          },
          { retry: true }
        );
      });
    } catch (error) {
      await fileStore.flushCleanup();
      throw error;
    }
    enqueue(document, req.ep);
    res.status(202).json({ document: publicDocument(document) });
  }
  router.post(
    ["/documents", "/platform/documents"],
    knowledgeAuth,
    wrap((req, res) => createDocument(req, res, false))
  );
  router.post(
    ["/documents/upload", "/platform/documents/upload"],
    knowledgeAuth,
    receiveUpload,
    wrap((req, res) => createDocument(req, res, true))
  );
  router.get(
    "/documents/:id",
    authenticate,
    wrap(async (req, res) =>
      res.json({
        document: publicDocument(await requireDocument(req.ep, req.params.id)),
      })
    )
  );
  router.get(
    "/documents/:id/download",
    authenticate,
    wrap(async (req, res) => {
      const document = await requireDocument(req.ep, req.params.id);
      const original = await fileStore
        .resolveOriginal(document.originalPath, document.tenantId)
        .catch(() => {
          throw fail(404, "该资料没有可读取的原始文件");
        });
      res.download(
        original,
        `${document.title.replace(/[<>:"/\\|?*\r\n]/g, "_")}${path.extname(document.title) ? "" : path.extname(document.originalPath)}`
      );
    })
  );
  router.patch(
    ["/documents/:id", "/platform/documents/:id"],
    knowledgeAuth,
    wrap(async (req, res) => {
      let document;
      let changedContent = false;
      await fileStore.withWrite(() =>
        store.transaction(
          async (tx) => {
            await refreshContext(req.ep, tx);
            const old = await requireDocument(req.ep, req.params.id, tx);
            requirePrivate(await requireLibrary(req.ep, old.libraryId, tx));
            const title =
              req.body.title === undefined
                ? old.title
                : textInput(req.body.title, "资料标题", 255);
            const content =
              req.body.content === undefined
                ? old.content
                : textInput(req.body.content, "资料正文", MAX_CONTENT);
            if (
              req.body.pinned !== undefined &&
              typeof req.body.pinned !== "boolean"
            )
              throw fail(400, "置顶状态无效");
            changedContent = content !== old.content;
            if (changedContent)
              await fileStore.queueCleanup(tx, [
                { path: old.originalPath, tenantId: old.tenantId },
              ]);
            await tx.run(
              'UPDATE ep_documents SET title = $1, content = $2, "originalPath" = $3, "inputType" = $4, status = $5, error = $6, version = $7, "updatedBy" = $8, "updatedAt" = $9, pinned=COALESCE($12,pinned) WHERE id = $10 AND "tenantId" = $11',
              title,
              content,
              changedContent ? null : old.originalPath,
              changedContent ? "text" : old.inputType,
              changedContent ? "processing" : old.status,
              changedContent ? null : old.error,
              old.version + (changedContent ? 1 : 0),
              String(req.ep.userId),
              store.now(),
              old.id,
              old.tenantId,
              req.body.pinned ?? null
            );
            document = await requireDocument(req.ep, old.id, tx);
          },
          { retry: true }
        )
      );
      if (changedContent) {
        await fileStore.flushCleanup();
        enqueue(document, req.ep);
      }
      res.json({ document: publicDocument(document) });
    })
  );
  router.post(
    ["/documents/:id/replace", "/platform/documents/:id/replace"],
    knowledgeAuth,
    receiveUpload,
    wrap(async (req, res) => {
      const old = await requireDocument(req.ep, req.params.id);
      let document;
      try {
        await fileStore.withWrite(async () => {
          const originalPath = await fileStore.persistOriginal(
            { tenantId: old.tenantId },
            old.id,
            req.file
          );
          await store.transaction(
            async (tx) => {
              await refreshContext(req.ep, tx);
              const current = await requireDocument(req.ep, old.id, tx);
              requirePrivate(
                await requireLibrary(req.ep, current.libraryId, tx)
              );
              await fileStore.queueCleanup(tx, [
                { path: current.originalPath, tenantId: current.tenantId },
              ]);
              await tx.run(
                'UPDATE ep_documents SET "originalPath" = $1, content = \'\', "inputType" = \'file\', status = \'processing\', error = NULL, version = $2, "updatedBy" = $3, "updatedAt" = $4 WHERE id = $5 AND "tenantId" = $6',
                originalPath,
                current.version + 1,
                String(req.ep.userId),
                store.now(),
                old.id,
                current.tenantId
              );
              document = await requireDocument(req.ep, old.id, tx);
              await fileStore.releaseCandidate(
                tx,
                originalPath,
                current.tenantId
              );
            },
            { retry: true }
          );
        });
      } catch (error) {
        await fileStore.flushCleanup();
        throw error;
      }
      await fileStore.flushCleanup();
      enqueue(document, req.ep);
      res.status(202).json({ document: publicDocument(document) });
    })
  );
  router.post(
    ["/documents/:id/retry", "/platform/documents/:id/retry"],
    knowledgeAuth,
    wrap(async (req, res) => {
      let document;
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const old = await requireDocument(req.ep, req.params.id, tx);
          requirePrivate(await requireLibrary(req.ep, old.libraryId, tx));
          if (old.status === "processing") {
            document = old;
            return;
          }
          await tx.run(
            'UPDATE ep_documents SET status = \'processing\', error = NULL, version = $1, "updatedBy" = $2, "updatedAt" = $3 WHERE id = $4 AND "tenantId" = $5',
            old.version + 1,
            req.ep.userId,
            store.now(),
            old.id,
            old.tenantId
          );
          document = await requireDocument(req.ep, old.id, tx);
        },
        { retry: true }
      );
      enqueue(document, req.ep);
      res.status(202).json({ document: publicDocument(document) });
    })
  );
  router.delete(
    ["/documents/:id", "/platform/documents/:id"],
    knowledgeAuth,
    wrap(async (req, res) => {
      await fileStore.withWrite(() =>
        vectorStore.withWrite(async (backend) => {
          await store.transaction(
            async (tx) => {
              await refreshContext(req.ep, tx);
              const document = await requireDocument(req.ep, req.params.id, tx);
              requirePrivate(
                await requireLibrary(req.ep, document.libraryId, tx)
              );
              await fileStore.queueCleanup(tx, [
                { path: document.originalPath, tenantId: document.tenantId },
              ]);
              const chunks = await tx.all(
                'SELECT id,"tenantId",namespace FROM ep_chunks WHERE "documentId"=$1 AND "tenantId"=$2',
                document.id,
                document.tenantId
              );
              await vectorStore.queueCleanup(tx, chunks);
              await tx.run(
                'DELETE FROM ep_chunks WHERE "documentId" = $1 AND "tenantId" = $2',
                document.id,
                document.tenantId
              );
              await tx.run(
                'DELETE FROM ep_documents WHERE id = $1 AND "tenantId" = $2',
                document.id,
                document.tenantId
              );
            },
            { retry: true }
          );
          await vectorStore.flushCleanup(backend);
        })
      );
      await fileStore.flushCleanup();
      res.json({ success: true });
    })
  );
}

module.exports = {
  registerKnowledge,
  submitText,
  submitSyncedContent,
  recoverJobs,
  startRecovery,
  requireLibrary,
  requireDocument,
  allowedLibrary,
  publicDocument,
  indexDocument,
  enqueue,
  safeOriginal: fileStore.safeOriginal,
};
