const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { randomUUID } = require("crypto");
const { CollectorApi } = require("../utils/collectorApi");
const { hotdirPath, directUploadsPath } = require("../utils/files");
const { maxFileSizeBytes } = require("../utils/files/types");
const { ParsedFiles } = require("../models/workspaceParsedFiles");
const { ChatThread } = require("../models/workspaceThread");
const { requireAuth, refreshContext, fail } = require("../enterprise/auth");
const store = require("../enterprise/store");
const { safeJsonParse } = require("../utils/http");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      fs.mkdirSync(hotdirPath, { recursive: true });
      callback(null, hotdirPath);
    },
    filename: (_req, file, callback) =>
      callback(null, `${randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: maxFileSizeBytes },
}).single("file");

async function requireThread(ctx, id, db = store) {
  const thread = await ChatThread.get(ctx, { id: Number(id) }, db.orm);
  if (!thread) throw fail(404, "对话不存在或无权访问");
  return thread;
}

function parsedFilesEndpoints(app) {
  app.get("/conversations/:id/parsed-files/:fileId", requireAuth, wrap(async (req,res) => {
    await requireThread(req.ep, Number(req.params.id));
    const file = await ParsedFiles.get(req.ep, req.params.fileId, store.orm);
    if (!file || file.threadId !== Number(req.params.id)) throw fail(404,"附件不存在或无权访问");
    const metadata = safeJsonParse(file.metadata, {});
    const data = safeJsonParse(fs.readFileSync(path.join(directUploadsPath, path.basename(metadata.location)),"utf8"), {});
    res.json({ document: { id: file.id, title: metadata.title || file.filename, content: data.pageContent } });
  }));
  app.get(
    "/conversations/:id/parsed-files",
    requireAuth,
    wrap(async (req, res) => {
      await requireThread(req.ep, Number(req.params.id));
      const files = await ParsedFiles.where(req.ep, Number(req.params.id), store.orm);
      const configuration =
        await require("../enterprise/rag-settings").getSettings(
          req.ep.tenantId
        );
      const connection =
        await require("../enterprise/providers").resolveConnection(
          req.ep,
          "chat",
          { ctx: req.ep, configuration, thread: { id: Number(req.params.id) } }
        );
      res.json({
        files: files.map((file) => ({
          ...file,
          title: safeJsonParse(file.metadata, {}).title || file.filename,
        })),
        contextWindow: connection.contextWindow,
        currentContextTokenCount: files.reduce(
          (total, file) => total + file.tokenCountEstimate,
          0
        ),
      });
    })
  );
  app.post(
    "/conversations/:id/parse",
    requireAuth,
    (req, res, next) => {
      requireThread(req.ep, Number(req.params.id))
        .then(() => upload(req, res, next))
        .catch(next);
    },
    wrap(async (req, res) => {
      if (!req.file) throw fail(400, "请选择文件");
      try {
        const collector = new CollectorApi();
        if (!(await collector.online())) throw fail(503, "资料解析服务未连接");
        const { success, reason, documents } = await collector.parseDocument(
          req.file.filename
        );
        if (!success || !documents?.length)
          throw fail(422, reason || "资料解析失败");
        const files = await store.transaction(
          async (tx) => {
            await refreshContext(req.ep, tx);
            await requireThread(req.ep, Number(req.params.id), tx);
            return Promise.all(
              documents.map(async (doc) => {
                const metadata = {
                  ...doc,
                  title: Buffer.from(req.file.originalname, "latin1").toString(
                    "utf8"
                  ),
                };
                delete metadata.pageContent;
                const { file } = await ParsedFiles.create(
                  req.ep,
                  {
                    filename: `${req.file.filename}-${doc.id}.json`,
                    threadId: Number(req.params.id),
                    metadata,
                    tokenCountEstimate: doc.token_count_estimate || 0,
                  },
                  tx.orm
                );
                return file;
              })
            );
          },
          { retry: true }
        );
        res.json({ success: true, files });
      } finally {
        fs.rmSync(req.file.path, { force: true });
      }
    })
  );
  app.delete(
    "/conversations/:id/parsed-files",
    requireAuth,
    wrap(async (req, res) => {
      if (!Array.isArray(req.body.fileIds) || !req.body.fileIds.length)
        throw fail(400, "请选择附件");
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          await requireThread(req.ep, Number(req.params.id), tx);
          const files = await ParsedFiles.where(req.ep, Number(req.params.id), tx.orm);
          const requested = req.body.fileIds.map(Number);
          if (requested.some((id) => !files.some((file) => file.id === id)))
            throw fail(404, "附件不存在或无权访问");
          await ParsedFiles.delete(req.ep, requested, tx.orm);
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  app.post(
    "/conversations/:id/parsed-files/:fileId/save",
    requireAuth,
    wrap(async (req, res) => {
      await requireThread(req.ep, Number(req.params.id));
      const file = await ParsedFiles.get(req.ep, req.params.fileId, store.orm);
      if (!file || file.threadId !== Number(req.params.id))
        throw fail(404, "附件不存在或无权访问");
      const metadata = safeJsonParse(file.metadata, {});
      const parsed = safeJsonParse(
        fs.readFileSync(
          path.join(directUploadsPath, path.basename(metadata.location)),
          "utf8"
        ),
        {}
      );
      const result = await require("../enterprise/knowledge").submitText(
        req.ep,
        {
          libraryId: req.body.libraryId,
          title: metadata.title || file.filename,
          content: parsed.pageContent,
        }
      );
      res.status(201).json({ success: true, ...result });
    })
  );
}
module.exports = { parsedFilesEndpoints };
