const express = require("express");
const { ApiKey } = require("../models/apiKeys");
const prisma = require("../utils/prisma");
const {
  authenticate,
  manager,
  tenantId,
  wrap,
} = require("../utils/middleware/externalIdentity");
const { context, fail } = require("../enterprise/auth");

function registerApiKeyManagement(router) {
  router.get(
    "/admin/api-keys",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const where =
        req.ep.identity === "platform" && !req.query.tenantId
          ? {}
          : { tenantId: tenantId(req) };
      const keys = await ApiKey.whereWithUser(where);
      const users = await prisma.users.findMany({
        where: { id: { in: keys.map((key) => key.userId) } },
        select: { id: true, username: true },
      });
      res.json({
        apiKeys: keys.map((key) => ({
          ...key,
          executionUser: users.find((user) => user.id === key.userId) || null,
        })),
      });
    })
  );
  router.post(
    "/admin/generate-api-key",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const target = await context(req.body.userId || req.ep.userId);
      if (target.tenantId !== tenantId(req)) throw fail(404, "用户不存在");
      const result = await ApiKey.create(req.ep.userId, req.body.name, {
        tenantId: target.tenantId,
        userId: target.userId,
      });
      if (!result.apiKey) throw fail(400, "无法创建 API Key");
      res.json(result);
    })
  );
  router.delete(
    "/admin/delete-api-key/:id",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const key = await ApiKey.get({ id: Number(req.params.id) });
      if (
        !key ||
        (req.ep.identity !== "platform" && key.tenantId !== req.ep.tenantId)
      )
        throw fail(404, "API Key 不存在");
      await ApiKey.delete({ id: key.id });
      res.json({ success: true });
    })
  );
}

function registerExternal(app) {
  const router = express.Router();
  registerApiKeyManagement(router);
  router.get(
    "/request-token/sso/simple",
    require("../utils/middleware/simpleSSOEnabled").simpleSSOEnabled,
    wrap(async (req, res) => {
      const site = await require("../enterprise/domains").resolveSite(req);
      if (site.kind !== "tenant") throw fail(401, "请通过企业域名访问");
      const result =
        await require("../models/temporaryAuthToken").TemporaryAuthToken.validate(
          req.query.token,
          site.tenant.id
        );
      if (result.error)
        return res.status(401).json({ valid: false, message: result.error });
      res.json({
        valid: true,
        user: result.session.user,
        token: result.sessionToken,
        session: result.session,
      });
    })
  );
  require("./browserExtension").browserExtensionEndpoints(router);
  require("./mobile").mobileEndpoints(router);
  require("./embedManagement").embedManagementEndpoints(router);
  require("./embed").embeddedEndpoints(router);
  require("./scheduledJobs").scheduledJobEndpoints(router);
  require("./telegram").telegramEndpoints(router);
  require("./experimental/liveSync").liveSyncEndpoints(router);
  require("./webPush").webPushEndpoints(router);
  require("./api").developerEndpoints(app, router);
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "服务处理失败，请稍后重试",
    });
  });
  app.use("/api", router);
}
module.exports = { registerExternal, registerApiKeyManagement };
