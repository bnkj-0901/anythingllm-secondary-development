const { Telemetry } = require("../../models/telemetry");
const { CollectorApi } = require("../../utils/collectorApi");
const { reqBody } = require("../../utils/http");
const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  isSupportedRepoProvider,
} = require("../../utils/middleware/isSupportedRepoProviders");

function extensionEndpoints(app) {
  if (!app) return;

  app.post(
    "/ext/:repo_platform/branches",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      isSupportedRepoProvider,
    ],
    async (request, response) => {
      try {
        const { repo_platform } = request.params;
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: `/ext/${repo_platform}-repo/branches`,
            method: "POST",
            body: request.body,
          });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/:repo_platform/repo",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      isSupportedRepoProvider,
    ],
    async (request, response) => {
      try {
        const { repo_platform } = request.params;
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: `/ext/${repo_platform}-repo`,
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: `${repo_platform}_repo`,
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/youtube/transcript",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/youtube-transcript",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "youtube_transcript",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/confluence",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/confluence",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "confluence",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
  app.post(
    "/ext/website-depth",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/website-depth",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "website_depth",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
  app.post(
    "/ext/drupalwiki",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/drupalwiki",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "drupalwiki",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/obsidian/vault",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/obsidian/vault",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "obsidian_vault",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/paperless-ngx",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/paperless-ngx",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "paperless_ngx",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { extensionEndpoints, knowledgeImportEndpoints };

// Preserve the original extraction engines. Only the authenticated knowledge
// layer decides where content belongs and whether it requires approval.
function knowledgeImportEndpoints(router) {
  const {
    requireAuth,
    requirePlatformAuth,
    fail,
    refreshContext,
  } = require("../../enterprise/auth");
  const { requireLibrary, submitText } = require("../../enterprise/knowledge");
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  const importDocuments = wrap(async (req, res) => {
    const { libraryId, connector, args = {} } = reqBody(req);
    if (typeof libraryId !== "string" || !libraryId)
      throw fail(400, "请选择目标知识库");
    if (
      ![
        "github",
        "gitlab",
        "gitea",
        "confluence",
        "drupalwiki",
        "obsidian",
        "paperless-ngx",
        "youtube-transcript",
        "website-depth",
      ].includes(connector)
    )
      throw fail(400, "不支持的资料连接器");
    await refreshContext(req.ep);
    await requireLibrary(req.ep, libraryId);
    const result = await new CollectorApi().forwardExtensionRequest({
      endpoint: "/ext/import",
      method: "POST",
      body: { connector, args },
    });
    if (!result.success)
      throw fail(422, "连接器无法提取资料，请检查地址和连接凭据");
    const documents =
      result.documents?.filter(
        (document) =>
          typeof document.pageContent === "string" &&
          document.pageContent.trim()
      ) || [];
    if (!documents.length) throw fail(422, "连接器没有返回可导入的资料正文");
    const published = [],
      changes = [];
    for (const document of documents) {
      const { pageContent, ...metadata } = document;
      delete metadata.location;
      delete metadata.isDirectUpload;
      const submitted = await submitText(req.ep, {
        libraryId,
        title: String(document.title || document.url || connector).slice(
          0,
          255
        ),
        content: pageContent,
        metadata,
      });
      if (submitted.approvalRequired) changes.push(submitted.change);
      else published.push(submitted.document);
    }
    res.status(202).json({
      success: true,
      data: {
        imported: documents.length,
        approvalRequired: changes.length > 0,
        documents: published,
        changes,
      },
      error: null,
    });
  });
  router.post("/data-connectors/import", requireAuth, importDocuments);
  router.post(
    "/platform/data-connectors/import",
    requirePlatformAuth,
    importDocuments
  );
}
