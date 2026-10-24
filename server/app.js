const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { registerEnterprise } = require("./enterprise");
const { httpLogger } = require("./middleware/httpLogger");
const FILE_LIMIT = "3GB";

function createApp() {
  const app = express();
  if (!process.env.ENABLE_HTTPS)
    require("@mintplex-labs/express-ws").default(app);
  app.disable("x-powered-by");
  if (process.env.NODE_ENV === "development" && process.env.ENABLE_HTTP_LOGGER)
    app.use(
      httpLogger({
        enableTimestamps: !!process.env.ENABLE_HTTP_LOGGER_TIMESTAMPS,
      })
    );
  app.use(cors({ origin: true }));
  app.use((_req, res, next) => {
    res.set({ "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" });
    next();
  });
  app.use("/api/embed", express.json({ limit: "1mb", type: ["application/json", "text/plain"] }), express.urlencoded({ limit: "1mb", extended: true }));
  // Upstream forms send JSON.stringify bodies using fetch's text/plain default.
  app.use(
    express.json({
      limit: FILE_LIMIT,
      type: ["application/json", "text/plain"],
    })
  );
  app.use(express.urlencoded({ limit: FILE_LIMIT, extended: true }));
  app.use((error, _req, res, next) => {
    if (!error) return next();
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "请求内容过大" });
    return res.status(400).json({ error: "请求正文格式无效" });
  });
  app.get("/api/ping", (_req, res) =>
    res.json({ online: true, product: "enterprise-v1" })
  );
  require("./enterprise/media").registerMedia(app);
  registerEnterprise(app);
  require("./endpoints/agentWebsocket").agentWebsocket(app);
  require("./enterprise/settings").registerSettings(app);
  const platformCapabilities = express.Router();
  platformCapabilities.use(require("./enterprise/auth").requirePlatformAuth);
  require("./endpoints/agentFlows").agentFlowEndpoints(platformCapabilities);
  require("./endpoints/mcpServers").mcpServersEndpoints(platformCapabilities);
  require("./endpoints/modelRouter").modelRouterEndpoints(platformCapabilities);
  require("./endpoints/communityHub").communityHubEndpoints(platformCapabilities);
  require("./endpoints/experimental/imported-agent-plugins").importedAgentPluginEndpoints(platformCapabilities);
  require("./endpoints/system").systemAgentEndpoints(platformCapabilities);
  require("./endpoints/utils/googleAgentSkillEndpoints").googleAgentSkillEndpoints(platformCapabilities);
  require("./endpoints/utils/outlookAgentUtils").outlookAgentEndpoints(platformCapabilities);
  // Keep original endpoint contracts, guarding global definitions at their mount.
  app.use("/api", (req,res,next) =>
    /^\/(?:agent-flows|mcp-servers|model-routers|community-hub)(?:\/|$)|^\/experimental\/agent-plugins(?:\/|$)|^\/system\/validate-sql-connection$|^\/admin\/agent-skills\//.test(req.path)
      ? platformCapabilities(req,res,next) : next());
  const oauthCallbacks = express.Router();
  require("./endpoints/utils/outlookAgentUtils").outlookAgentEndpoints(oauthCallbacks);
  app.use("/api", (req,res,next) => req.path === "/agent-skills/outlook/auth-callback" ? oauthCallbacks(req,res,next) : next());
  const authenticatedCapabilities = express.Router();
  require("./endpoints/agentSkillWhitelist").agentSkillWhitelistEndpoints(authenticatedCapabilities);
  require("./endpoints/memory").memoryEndpoints(authenticatedCapabilities);
  require("./endpoints/system").slashCommandPresetEndpoints(authenticatedCapabilities);
  require("./endpoints/agentFileServer").agentFileServerEndpoints(authenticatedCapabilities);
  app.use("/api", authenticatedCapabilities);
  const extractionTools = express.Router();
  require("./endpoints/extensions").extensionEndpoints(extractionTools);
  app.use("/api", (req, res, next) =>
    /^\/ext\/(?:[^/]+\/branches|website-depth|youtube\/transcript)$/.test(req.path)
      ? extractionTools(req, res, next)
      : next()
  );
  require("./endpoints/external").registerExternal(app);
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在" }));
  if (process.env.NODE_ENV !== "development") {
    const publicDirectory = path.resolve(
      process.env.PUBLIC_DIR || path.resolve(__dirname, "../frontend/dist")
    );
    // The upstream postbuild renames the SPA template to _index.html.
    const indexPage = path.join(publicDirectory, "_index.html");
    const metadata = async (req) => {
      const { resolveSite } = require("./enterprise/domains");
      const { readPreference } = require("./enterprise/settings");
      const { MetaGenerator } = require("./utils/boot/MetaGenerator");
      const site = await resolveSite(req);
      const ctx =
        site.kind === "tenant"
          ? { identity: "tenant", tenantId: site.tenant.id }
          : site.kind === "platform"
            ? { identity: "platform" }
            : null;
      return new MetaGenerator({
        settings: {
          getValueOrFallback: ({ label }, fallback) =>
            ctx ? readPreference(ctx, label, fallback) : fallback,
        },
      });
    };
    app.get("/manifest.json", async (req, res, next) => {
      try {
        await (await metadata(req)).generateManifest(res);
      } catch (error) {
        next(error);
      }
    });
    app.use(express.static(publicDirectory));
    app.get("/robots.txt", (_req, res) =>
      res.type("text/plain").send("User-agent: *\nDisallow: /\n")
    );
    app.get("*", async (req, res, next) => {
      if (!fs.existsSync(indexPage)) return next();
      try {
        await (await metadata(req)).generate(res);
      } catch (error) {
        next(error);
      }
    });
  }
  app.use((_req, res) => res.status(404).json({ error: "页面不存在" }));
  return app;
}
module.exports = { createApp };
