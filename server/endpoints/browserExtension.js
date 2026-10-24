const { BrowserExtensionApiKey } = require("../models/browserExtensionApiKey");
const {
  validBrowserExtensionApiKey,
} = require("../utils/middleware/validBrowserExtensionApiKey");
const {
  authenticate,
  manager,
  tenantId,
  wrap,
} = require("../utils/middleware/externalIdentity");
const { fail, context } = require("../enterprise/auth");
const prisma = require("../utils/prisma");
const { submitText, requireLibrary } = require("../enterprise/knowledge");
const { Document } = require("../models/documents");
async function libraries(ctx) {
  const store = require("../enterprise/store");
  return store.all(
    `SELECT l.* FROM ep_libraries l WHERE ${Document.libraryAccessSQL()}`,
    ctx.tenantId,
    ctx.userId
  );
}
function browserExtensionEndpoints(app) {
  app.get(
    "/browser-extension/check",
    validBrowserExtensionApiKey,
    wrap(async (req, res) =>
      res.json({
        connected: true,
        libraries: await libraries(req.ep),
        apiKeyId: res.locals.apiKey.id,
      })
    )
  );
  app.get(
    "/browser-extension/libraries",
    validBrowserExtensionApiKey,
    wrap(async (req, res) => res.json({ libraries: await libraries(req.ep) }))
  );
  app.delete(
    "/browser-extension/disconnect",
    validBrowserExtensionApiKey,
    wrap(async (req, res) =>
      res.json(await BrowserExtensionApiKey.delete(res.locals.apiKey.id))
    )
  );
  app.post(
    ["/browser-extension/embed-content", "/browser-extension/upload-content"],
    validBrowserExtensionApiKey,
    wrap(async (req, res) => {
      const { libraryId, textContent, metadata = {} } = req.body;
      await requireLibrary(req.ep, libraryId);
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        JSON.stringify(metadata).length > 65536
      )
        throw fail(400, "采集元数据无效");
      const title = metadata.title || metadata.url || "Browser capture";
      const parsed =
        await new (require("../utils/collectorApi").CollectorApi)().processRawText(
          textContent,
          { ...metadata, title }
        );
      if (!parsed.success || !parsed.documents?.[0])
        throw fail(422, parsed.reason || "采集正文解析失败");
      const {
        pageContent,
        location: _location,
        ...sourceMetadata
      } = parsed.documents[0];
      const result = await submitText(req.ep, {
        libraryId,
        title,
        content: pageContent,
        metadata: { ...sourceMetadata, title },
      });
      res
        .status(result.approvalRequired ? 202 : 200)
        .json({ success: true, ...result });
    })
  );
  app.get(
    "/browser-extension/api-keys",
    authenticate,
    wrap(async (req, res) => {
      const scope = {
        ...(req.ep.identity === "platform" && !req.query.tenantId
          ? {}
          : { tenantId: tenantId(req) }),
        ...(req.ep.identity === "platform" || req.ep.role === "admin"
          ? {}
          : { user_id: req.ep.userId }),
      };
      const apiKeys = await BrowserExtensionApiKey.where(scope);
      const rows = await Promise.all(
        apiKeys.map(async (key) => {
          const tenant = await prisma.ep_tenants.findUnique({
            where: { id: key.tenantId },
          });
          return {
            ...key,
            apiOrigin: tenant
              ? (await require("../enterprise/domains").tenantEntry(tenant))
                  .webURL
              : null,
          };
        })
      );
      res.json({ success: true, apiKeys: rows });
    })
  );
  app.post(
    "/browser-extension/api-keys/new",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const target = await context(req.body.userId || req.ep.userId);
      if (target.tenantId !== tenantId(req)) throw fail(404, "User not found");
      const result = await BrowserExtensionApiKey.create(
        target.userId,
        target.tenantId
      );
      const tenant = await prisma.ep_tenants.findUnique({
        where: { id: target.tenantId },
      });
      const apiOrigin = (
        await require("../enterprise/domains").tenantEntry(tenant)
      ).webURL;
      res.json({
        success: !!result.apiKey,
        apiKey: result.apiKey?.key,
        error: result.error,
        apiOrigin,
      });
    })
  );
  app.delete(
    "/browser-extension/api-keys/:id",
    authenticate,
    wrap(async (req, res) => {
      const key = await BrowserExtensionApiKey.get({
        id: Number(req.params.id),
        tenantId: tenantId(req),
      });
      if (
        !key ||
        (req.ep.identity !== "platform" &&
          req.ep.role !== "admin" &&
          key.user_id !== req.ep.userId)
      )
        throw fail(404, "Key not found");
      res.json(await BrowserExtensionApiKey.delete(key.id));
    })
  );
}
module.exports = { browserExtensionEndpoints };
