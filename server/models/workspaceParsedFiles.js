const prisma = require("../utils/prisma");
const { chatScope } = require("./workspaceChats");
const { directUploadsPath } = require("../utils/files");
const { safeJsonParse } = require("../utils/http");
const fs = require("fs");
const path = require("path");

const ParsedFiles = {
  async fork(ctx, sourceThreadId, targetThreadId, db = prisma) {
    const files = await this.where(ctx, sourceThreadId, db);
    for (const file of files) {
      const metadata = safeJsonParse(file.metadata, {});
      if (!metadata.location) continue;
      const source = path.join(
        directUploadsPath,
        path.basename(metadata.location)
      );
      if (!fs.existsSync(source)) continue;
      const filename = `${require("crypto").randomUUID()}.json`;
      fs.copyFileSync(source, path.join(directUploadsPath, filename));
      await this.create(
        ctx,
        {
          filename: file.filename,
          threadId: targetThreadId,
          metadata: { ...metadata, location: filename },
          tokenCountEstimate: file.tokenCountEstimate,
        },
        db
      );
    }
  },
  async create(
    ctx,
    { filename, threadId, metadata, tokenCountEstimate = 0 },
    db = prisma
  ) {
    const thread = await db.chat_threads.findFirst({where:{id:threadId, ...chatScope(ctx)}});
    if (!thread) throw Object.assign(new Error("Conversation not found."), {status:404});
    const file = await db.workspace_parsed_files.create({
      data: {
        ...chatScope(ctx),
        filename,
        threadId,
        metadata: JSON.stringify(metadata),
        tokenCountEstimate,
      },
    });
    return { file, error: null };
  },
  get(ctx, id, db = prisma) {
    return db.workspace_parsed_files.findFirst({
      where: { id: Number(id), ...chatScope(ctx) },
    });
  },
  where(ctx, threadId, db = prisma) {
    return db.workspace_parsed_files.findMany({
      where: { ...chatScope(ctx), threadId },
      orderBy: { createdAt: "asc" },
    });
  },
  async delete(ctx, ids, db = prisma) {
    const rows = await db.workspace_parsed_files.findMany({
      where: { ...chatScope(ctx), id: { in: ids.map(Number) } },
    });
    for (const row of rows) {
      const metadata = safeJsonParse(row.metadata, {});
      if (metadata.location)
        fs.rmSync(
          path.join(directUploadsPath, path.basename(metadata.location)),
          { force: true }
        );
    }
    return db.workspace_parsed_files.deleteMany({
      where: { ...chatScope(ctx), id: { in: rows.map((row) => row.id) } },
    });
  },
  async getContextFiles(ctx, threadId, db = prisma) {
    const files = await this.where(ctx, threadId, db);
    const results = [];
    for (const file of files) {
      const metadata = safeJsonParse(file.metadata, {});
      if (!metadata.location) continue;
      const sourceFile = path.join(
        directUploadsPath,
        path.basename(metadata.location)
      );
      if (!fs.existsSync(sourceFile)) continue;
      const data = safeJsonParse(fs.readFileSync(sourceFile, "utf8"), null);
      if (data?.pageContent)
        results.push({
          parsedFileId: file.id,
          ...metadata,
          pageContent: data.pageContent,
          token_count_estimate: file.tokenCountEstimate,
        });
    }
    return results;
  },
};
module.exports = { ParsedFiles };
