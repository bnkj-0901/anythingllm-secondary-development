const prisma = require("../utils/prisma");
const { safeJsonParse } = require("../utils/http");

function identity(ctx) {
  if (ctx?.identity === "platform" && typeof ctx.userId === "string" && ctx.userId) return;
  if (
    typeof ctx?.tenantId !== "string" ||
    !ctx.tenantId ||
    !Number.isInteger(ctx?.userId) ||
    ctx.userId < 1 ||
    ctx.identity === "platform"
  )
    throw Object.assign(new Error("知识操作需要企业用户身份"), { status: 403 });
}

// One resource policy for file uploads, natural-language entries and retrieval.
// Future shared-library grants extend this policy without changing user tenancy.
function libraryScope(ctx) {
  identity(ctx);
  if (ctx.identity === "platform") return {};
  return {
    grants: {
      some: { OR: [{ tenantId: ctx.tenantId }, { userId: ctx.userId }] },
    },
  };
}

function libraryAccessSQL(alias = "l", firstParameter = 1) {
  return `EXISTS (SELECT 1 FROM ep_library_grants g WHERE g."libraryId"=${alias}.id AND (g."tenantId"=$${firstParameter} OR g."userId"=$${firstParameter + 1}))`;
}

function libraryVisibilitySQL(alias = "l", tenantParameter = 1) {
  return `CASE WHEN EXISTS (SELECT 1 FROM ep_library_grants vg WHERE vg."libraryId"=${alias}.id AND vg."tenantId"=$${tenantParameter}) THEN 'public' ELSE 'private' END`;
}

function scope(ctx, clause = {}) {
  identity(ctx);
  return {
    AND: [clause, { library: libraryScope(ctx) }],
  };
}

const Document = {
  writable: [
    "title",
    "content",
    "inputType",
    "originalPath",
    "status",
    "error",
    "version",
    "embeddingId",
    "updatedAt",
    "pinned",
  ],
  parseDocumentTypeAndSource: function (document) {
    const metadata = safeJsonParse(document.metadata, null);
    if (!metadata || typeof metadata.chunkSource !== "string") return { metadata: null, type: null, source: null };

    // Parse the correct type of source and its original source path.
    const idx = metadata.chunkSource.indexOf("://");
    const [type, source] = [
      metadata.chunkSource.slice(0, idx),
      metadata.chunkSource.slice(idx + 3),
    ];
    return { metadata, type, source: this._stripSource(source, type) };
  },

  libraryScope,
  libraryAccessSQL,
  libraryVisibilitySQL,
  async pinnedContext(ctx, maxTokens = Number.POSITIVE_INFINITY, db = prisma) {
    const documents = await this.where(ctx, { pinned: true, status: "ready" }, {
      orderBy: { createdAt: "asc" },
    }, db);
    const { TokenManager } = require("../utils/helpers/tiktoken");
    const tokenizer = new TokenManager();
    let tokens = 0;
    const pinned = [];
    for (const document of documents) {
      if (tokens >= maxTokens) continue;
      const metadata = safeJsonParse(document.metadata, {});
      pinned.push({
        ...metadata,
        id: document.id,
        documentId: document.id,
        libraryId: document.libraryId,
        tenantId: document.tenantId,
        version: document.version,
        title: document.title,
        pageContent: document.content,
      });
      tokens += tokenizer.countFromString(document.content || "");
    }
    return pinned;
  },
  async get(ctx, clause = {}, db = prisma) {
    return db.documents.findFirst({ where: scope(ctx, clause) });
  },
  async where(ctx, clause = {}, options = {}, db = prisma) {
    return db.documents.findMany({ ...options, where: scope(ctx, clause) });
  },
  async count(ctx, clause = {}, db = prisma) {
    return db.documents.count({ where: scope(ctx, clause) });
  },
  async new(ctx, data, db = prisma) {
    identity(ctx);
    const library = await db.ep_libraries.findFirst({
      where: { AND: [libraryScope(ctx), { id: data.libraryId }] },
    });
    if (!library)
      throw Object.assign(new Error("知识库不存在或无权访问"), { status: 404 });
    return db.documents.create({
      data: {
        ...data,
        tenantId: library.tenantId,
        createdBy: String(ctx.userId),
        updatedBy: String(ctx.userId),
      },
    });
  },
  async update(ctx, id, data = {}, db = prisma) {
    const values = Object.fromEntries(
      Object.entries(data).filter(([key]) => this.writable.includes(key))
    );
    return db.documents.updateMany({
      where: scope(ctx, { id }),
      data: { ...values, updatedBy: String(ctx.userId) },
    });
  },
  async delete(ctx, clause = {}, db = prisma) {
    return db.documents.deleteMany({ where: scope(ctx, clause) });
  },
  async content(ctx, id, db = prisma) {
    const document = await this.get(ctx, { id }, db);
    if (!document)
      throw Object.assign(new Error("资料不存在或无权访问"), { status: 404 });
    return { title: document.title, content: document.content };
  },
  _stripSource: function (sourceString, type) {
    if (["confluence", "github"].includes(type)) {
      const _src = new URL(sourceString);
      _src.search = ""; // remove all search params that are encoded for resync.
      return _src.toString();
    }

    return sourceString;
  },
};

module.exports = { Document };
