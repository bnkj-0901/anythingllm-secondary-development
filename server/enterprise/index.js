const express = require("express");
const store = require("./store");
const { registerAuth } = require("./auth");
const { registerKnowledge, startRecovery } = require("./knowledge");
const { registerRag } = require("./rag");
const { registerRagSettings } = require("./rag-settings");
function registerEnterprise(app) {
  const router = express.Router();
  router.use((req, res, next) =>
    store
      .init()
      .then(() => next())
      .catch(next)
  );
  registerAuth(router);
  registerKnowledge(router);
  require("../endpoints/extensions").knowledgeImportEndpoints(router);
  registerRag(router);
  registerRagSettings(router);
  require("../endpoints/workspacesParsedFiles").parsedFilesEndpoints(router);
  router.use((req, res) => res.status(404).json({ error: "接口不存在" }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const conflict =
      error.code === "P2002" ||
      error.code === "P2034" ||
      ["23505", "40001", "40P01"].includes(error.code) ||
      ["23505", "40001", "40P01"].includes(error.meta?.code);
    const status = conflict ? 409 : error.status || 500;
    // Provider errors and secrets are never echoed or logged verbatim.
    if (status >= 500)
      console.error(
        `[enterprise] ${req.method} ${req.path}: ${error.status ? "upstream unavailable" : "internal failure"}`
      );
    res.status(status).json({
      error: conflict
        ? "账号已存在或配置发生冲突"
        : status === 500
          ? "服务处理失败，请稍后重试"
          : error.message,
    });
  });
  app.use("/api/enterprise", router);
  store
    .init()
    .then(() => startRecovery())
    .catch(() => console.error("[enterprise] initialization failed"));
}
module.exports = { registerEnterprise };
