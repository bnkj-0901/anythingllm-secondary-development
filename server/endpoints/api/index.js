const { useSwagger } = require("../../swagger/utils");
const { apiAuthEndpoints } = require("./auth");
const { apiOpenAICompatibleEndpoints } = require("./openai");
const express = require("express");
const { validApiKey } = require("../../utils/middleware/validApiKey");
const { fail } = require("../../enterprise/auth");

// All endpoints must be documented and pass through the validApiKey Middleware.
// How to JSDoc an endpoint
// https://www.npmjs.com/package/swagger-autogen#openapi-3x
function developerEndpoints(app, router) {
  if (!router) return;
  useSwagger(app);
  registerDeveloperApiRoutes(router);
}

function registerDeveloperApiRoutes(router) {
  apiAuthEndpoints(router);
  apiOpenAICompatibleEndpoints(router);
  require("./userManagement").apiUserManagementEndpoints(router);
  require("./embed").apiEmbedEndpoints(router);
  require("./document").apiDocumentUtilityEndpoints(router);
  router.get("/v1/system", validApiKey, async (req, res, next) => {
    try {
      res.json({
        settings: await require("../../enterprise/settings").settingsFor(
          req.ep
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get("/v1/system/export-chats", validApiKey, async (req, res, next) => {
    try {
      const {
        exportChatsAsType,
        validExportTypes,
      } = require("../../utils/helpers/chat/convertTo");
      const type = req.query.type || "jsonl";
      if (!validExportTypes.includes(type))
        throw fail(400, `Invalid export type: ${type}`);
      const { contentType, data } = await exportChatsAsType(
        type,
        "personal",
        req.ep
      );
      res.setHeader("Content-Type", contentType);
      res.send(data);
    } catch (error) {
      next(error);
    }
  });
  // Reuse the product resource handlers; API credentials never select another
  // execution identity or grant access to the platform operations namespace.
  const resources = express.Router();
  const platformAuthenticate = (_req, _res, next) =>
    next(fail(403, "企业 API Key 无平台管理权限"));
  require("../../enterprise/knowledge").registerKnowledge(resources, {
    authenticate: validApiKey,
    platformAuthenticate,
  });
  require("../../enterprise/rag").registerRag(resources, {
    authenticate: validApiKey,
    platformAuthenticate,
  });
  router.use("/v1", resources);
  router.all(["/v1/workspace*", "/v1/workspaces*"], validApiKey, (_req, res) =>
    res.status(410).json({
      error: "Workspace 已由个人 conversations 和授权 libraries 替代",
      resources: ["/api/v1/conversations", "/api/v1/libraries"],
    })
  );
  return resources;
}

module.exports = { developerEndpoints, registerDeveloperApiRoutes };
