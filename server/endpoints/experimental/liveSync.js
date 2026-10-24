const { DocumentSyncQueue } = require("../../models/documentSyncQueue");
const { EventLogs } = require("../../models/eventLogs");
const { SystemSettings } = require("../../models/systemSettings");
const { Telemetry } = require("../../models/telemetry");
const {
  authenticate,
  wrap,
} = require("../../utils/middleware/externalIdentity");
const { requireDocument } = require("../../enterprise/knowledge");
const { context, fail } = require("../../enterprise/auth");

function liveSyncEndpoints(app) {
  if (!app) return;
  const enabled = wrap(async (_req, _res, next) => {
    if (!(await DocumentSyncQueue.enabled()))
      throw fail(403, "文档自动同步未启用");
    next();
  });
  app.post(
    "/experimental/toggle-live-sync",
    authenticate,
    wrap(async (req, res) => {
      if (req.ep.identity !== "platform")
        throw fail(403, "仅顶级管理员可修改此配置");
      const newStatus = SystemSettings.validations.experimental_live_file_sync(
        req.body.updatedStatus === true
      );
      const current =
        (await SystemSettings.get({ label: DocumentSyncQueue.featureKey }))
          ?.value || "disabled";
      if (current !== newStatus) {
        await SystemSettings._updateSettings({
          [DocumentSyncQueue.featureKey]: newStatus,
        });
        if (newStatus === "enabled") {
          await Telemetry.sendTelemetry("experimental_feature_enabled", {
            feature: "live_file_sync",
          });
          await EventLogs.logEvent(
            "experimental_feature_enabled",
            { feature: "live_file_sync" },
            req.ep.userId
          );
        }
        await new (require("../../utils/BackgroundWorkers").BackgroundService)().syncDocumentSyncJob(
          newStatus === "enabled"
        );
      }
      res.json({ liveSyncEnabled: newStatus === "enabled" });
    })
  );
  app.get(
    "/experimental/live-sync/queues",
    authenticate,
    wrap(async (req, res) => {
      const where =
        req.ep.identity === "platform"
          ? {}
          : { tenantId: req.ep.tenantId, userId: req.ep.userId };
      const rows = await DocumentSyncQueue.where(
        where,
        null,
        { createdAt: "asc" },
        { document: true }
      );
      const queues = [];
      for (const row of rows) {
        try {
          await requireDocument(req.ep, row.documentId);
          const { document, ...queue } = row;
          queues.push({
            ...queue,
            document: {
              id: document.id,
              title: document.title,
              libraryId: document.libraryId,
            },
          });
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      res.json({ queues, liveSyncEnabled: await DocumentSyncQueue.enabled() });
    })
  );
  app.post(
    "/documents/:id/update-watch-status",
    authenticate,
    enabled,
    wrap(async (req, res) => {
      if (typeof req.body.watchStatus !== "boolean")
        throw fail(400, "监控状态无效");
      const document = await requireDocument(req.ep, req.params.id);
      let executor = req.ep;
      if (req.ep.identity === "platform" && req.body.watchStatus) {
        executor = await context(req.body.userId);
        if (executor.tenantId !== document.tenantId)
          throw fail(400, "请选择资料所属企业的执行用户");
      }
      await DocumentSyncQueue.toggleWatchStatus(
        executor,
        document,
        req.body.watchStatus
      );
      res.json({ success: true });
    })
  );
}
module.exports = { liveSyncEndpoints };
