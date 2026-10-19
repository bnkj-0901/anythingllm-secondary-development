const fs = require("node:fs");
const path = require("node:path");
const { requireServer, serverDirectory } = require("./dependencies.cjs");
const { fail, random } = require("./service.cjs");

function runtimeOptions() {
  const multer = requireServer("multer");
  const { CollectorApi } = requireServer("./utils/collectorApi");
  const { Document } = requireServer("./models/documents");
  const { moveProcessedDocsToFolder, documentsPath } = requireServer("./utils/files");
  require("./collector-compat.cjs").installCollectorCompatibility(CollectorApi, documentsPath);
  const hotdir = path.resolve(serverDirectory, "../collector/hotdir");
  fs.mkdirSync(hotdir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({ destination: hotdir, filename: (_req, file, done) => done(null, `kb-${random()}${path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12)}`) }),
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 },
    fileFilter: (_req, file, done) => {
      if (!/\.(?:txt|md|csv|pdf|docx|xlsx|pptx)$/i.test(file.originalname)) return done(new Error("Unsupported file type"));
      done(null, true);
    },
  }).single("file");
  return {
    uploadMiddleware(req, res, next) {
      upload(req, res, error => { if (error) { try { fail(422, "invalid_file", "文件不符合要求：支持 TXT、MD、CSV、PDF、DOCX、XLSX、PPTX，最大 20MB。"); } catch (failure) { return next(failure); } } next(); });
    },
    async ingest({ space, user, title, text, file, imageSnapshot }) {
      const collector = new CollectorApi();
      try {
        const imagePath = imageSnapshot ? `kb-${space.id}/image-${imageSnapshot.id}.json` : null;
        if (imagePath && await requireServer("./utils/prisma").workspace_documents.findFirst({ where: { workspaceId: space.id, docpath: imagePath } })) return { success: true, count: 1 };
        if (!(await collector.online())) fail(503, "collector_offline", "文档处理服务暂不可用，请稍后重试。");
        const result = file
          ? await collector.processDocument(file.filename, { title: Buffer.from(file.originalname, "latin1").toString("utf8") })
          : await collector.processRawText(text, { title, docSource: "个人后台" });
        if (!result.success || !result.documents?.length) fail(422, "document_processing", "未能解析资料，请检查文件内容或格式后重试。");
        moveProcessedDocsToFolder(result.documents, `kb-${space.id}`);
        let paths = result.documents.map(document => document.location);
        if (imageSnapshot) {
          const source = path.join(documentsPath, paths[0]);
          const data = JSON.parse(fs.readFileSync(source, "utf8"));
          data.knowledgeImage = { id: imageSnapshot.id, revision: imageSnapshot.revision, originalSha256: imageSnapshot.originalSha256, textSha256: imageSnapshot.textSha256, confirmedBy: imageSnapshot.confirmedBy, confirmedAt: imageSnapshot.confirmedAt };
          data.docSource = "图片文字 · 已人工核对";
          fs.writeFileSync(path.join(documentsPath, imagePath), JSON.stringify(data));
          fs.rmSync(source, { force: true });
          paths = [imagePath];
        }
        const embedded = await Document.addDocuments(space, paths, user.id);
        if (embedded.embedded?.length !== paths.length) fail(502, "embedding_failed", "资料已解析，但索引未全部完成。请联系管理员检查向量模型配置后重新提交。");
        return { success: true, count: paths.length };
      } finally {
        // Only remove this request's random temporary upload, if the collector left it behind.
        if (file?.path && path.dirname(file.path) === hotdir) fs.rmSync(file.path, { force: true });
      }
    },
    async removeDocument(space, document, user) {
      await Document.removeDocuments(space, [document.docpath], user.id);
      const remaining = await requireServer("./utils/prisma").workspace_documents.findUnique({ where: { id: document.id } });
      if (remaining) fail(502, "document_removal_failed", "资料移除未完成，请稍后重试。");
    },
  };
}
function installAccess() {
  requireServer("dotenv").config({ path: path.join(serverDirectory, ".env") });
  process.env.SIMPLE_SSO_ENABLED = "1";
  const express = requireServer("express");
  const prisma = requireServer("./utils/prisma");
  const { User } = requireServer("./models/user");
  const { Workspace } = requireServer("./models/workspace");
  const { EncryptionManager } = requireServer("./utils/EncryptionManager");
  require("./space-policy.cjs").installWorkspacePolicy(Workspace, prisma);
  const search = requireServer("./utils/helpers/search");
  const originalSearch = search.searchWorkspaceAndThreads;
  search.searchWorkspaceAndThreads = async (term, user) => {
    const result = await originalSearch(term, user);
    if (!user) return result;
    const allowed = new Set((await Workspace.whereWithUser(user)).map(space => space.slug));
    return { workspaces: result.workspaces.filter(space => allowed.has(space.slug)), threads: result.threads.filter(thread => allowed.has(thread.workspace.slug)) };
  };
  const { createAccessRouter } = require("./router.cjs");
  const options = runtimeOptions();
  const encryption = new EncryptionManager();
  const vision = require("./vision.cjs").createVision({ prisma, encryption });
  const imageRuntime = require("./image-runtime.cjs").imageOptions(prisma, options.ingest, vision);
  require("./chat-images.cjs").installImageChat({ prisma, ...imageRuntime, stream: requireServer("./utils/chats/stream"), websocket: requireServer("./utils/agents/aibitat/plugins/websocket").websocket, canSendChat: User.canSendChat.bind(User) });
  const router = createAccessRouter({ prisma, User, bcrypt: requireServer("bcryptjs"), JWT: requireServer("jsonwebtoken"), encryption, vision, jwtSecret: process.env.JWT_SECRET, defaultPrompt: Workspace.defaultPrompt, ...options, ...imageRuntime });
  const originalInit = express.application.init;
  express.application.init = function (...args) {
    originalInit.apply(this, args);
    this.use(router);
    // Only the upstream main server app receives the integration.
    express.application.init = originalInit;
    this.use((req, res, next) => {
      if (req.method === "GET" && !req.path.startsWith("/api/") && !path.extname(req.path)) {
        res.set("Referrer-Policy", "no-referrer");
        const send = res.send;
        res.send = function (body) {
          if (typeof body === "string" && body.includes('<div id="root"')) {
            if (req.path === "/sso/simple") body = body.replace("<head>", '<head><script src="/access/assets/sso-reset.js"></script>');
            body = body.replace("</head>", '<script defer src="/access/assets/entry-links.js"></script></head>');
          }
          return send.call(this, body);
        };
      }
      next();
    });
  };
}
module.exports = { installAccess };
