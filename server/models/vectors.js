const prisma = require("../utils/prisma");
const { Document } = require("./documents");

function scope(ctx, clause = {}) {
  if (ctx?.identity === "platform" && typeof ctx.userId === "string" && ctx.userId)
    return clause;
  if (
    typeof ctx?.tenantId !== "string" ||
    !ctx.tenantId ||
    !Number.isInteger(ctx?.userId) ||
    ctx.userId < 1 ||
    ctx.identity === "platform"
  )
    throw Object.assign(new Error("索引操作需要企业用户身份"), { status: 403 });
  return {
    AND: [
      clause,
      {
        document: {
          library: Document.libraryScope(ctx),
        },
      },
    ],
  };
}

const DocumentVectors = {
  async bulkInsert(ctx, records = [], db = prisma) {
    if (!records.length) return { documentsInserted: 0 };
    const documents = new Map();
    for (const documentId of new Set(
      records.map((record) => record.documentId)
    )) {
      const document = await Document.get(ctx, { id: documentId }, db);
      if (!document)
        throw Object.assign(new Error("资料不存在或无权访问"), { status: 404 });
      documents.set(documentId, document);
    }
    const result = await db.document_vectors.createMany({
      data: records.map((record) => ({
        ...record,
        tenantId: documents.get(record.documentId).tenantId,
      })),
    });
    return { documentsInserted: result.count };
  },
  async where(ctx, clause = {}, db = prisma) {
    return db.document_vectors.findMany({ where: scope(ctx, clause) });
  },
  async delete(ctx, clause = {}, db = prisma) {
    return db.document_vectors.deleteMany({ where: scope(ctx, clause) });
  },
  async deleteIds(ctx, ids = [], db = prisma) {
    return this.delete(ctx, { id: { in: ids } }, db);
  },
};

module.exports = { DocumentVectors };
