const { reqBody } = require("../../utils/http");
const { requireTenantConfiguration } = require("../../enterprise/settings");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("crypto");
const { SystemSettings } = require("../../models/systemSettings");
const prisma = require("../../utils/prisma");

async function outlookCallbackIdentity(request,response,next) {
  try {
    await require("../../enterprise/domains").requirePlatformSite(request);
    const claims = jwt.verify(request.query.state,process.env.JWT_SECRET,{audience:"outlook-enterprise-configuration",algorithms:["HS256"]});
    const actor = await require("../../enterprise/auth").platformContext(claims.sub);
    if (actor.authVersion !== claims.ver || typeof claims.tenantId !== "string") throw new Error();
    if (!await prisma.ep_tenants.findFirst({where:{id:claims.tenantId,status:"active"},select:{id:true}})) throw new Error();
    const used = await prisma.cache_data.deleteMany({where:{name:`outlook-oauth:${claims.jti}`,expiresAt:{gt:new Date()}}});
    if (used.count !== 1) throw new Error();
    request.ep = actor;
    request.configurationTenantId = claims.tenantId;
    return SystemSettings.withTenantConfiguration(claims.tenantId,next);
  } catch { response.status(401).send("授权已失效，请从企业连接配置重新发起授权。"); }
}

/**
 * Constructs the OAuth redirect URI from the request headers.
 * @param {Object} request - Express request object
 * @returns {string} The redirect URI for OAuth callback
 */
function getOutlookRedirectUri(request) {
  const protocol = request.headers["x-forwarded-proto"] || request.protocol;
  const host = request.get("host");
  return `${protocol}://${host}/api/agent-skills/outlook/auth-callback`;
}

function outlookAgentEndpoints(app) {
  if (!app) return;

  app.post(
    "/admin/agent-skills/outlook/auth-url",
    [validatedRequest, requireTenantConfiguration],
    async (request, response) => {
      try {
        const { clientId, tenantId, clientSecret, authType } = reqBody(request);

        if (!clientId || !clientSecret) {
          return response.status(400).json({
            success: false,
            error: "Client ID and Client Secret are required.",
          });
        }

        const outlookLib = require("../../utils/agents/aibitat/plugins/outlook/lib");
        const { AUTH_TYPES } = outlookLib;
        const validAuthType = Object.values(AUTH_TYPES).includes(authType)
          ? authType
          : AUTH_TYPES.common;

        if (validAuthType === AUTH_TYPES.organization && !tenantId) {
          return response.status(400).json({
            success: false,
            error:
              "Tenant ID is required for organization-only authentication.",
          });
        }

        const existingConfig = await outlookLib.OutlookBridge.getConfig();
        const configUpdate = {
          ...existingConfig,
          clientId: clientId.trim(),
          tenantId: tenantId?.trim() || "",
          authType: validAuthType,
        };

        if (!/^\*+$/.test(clientSecret))
          configUpdate.clientSecret = clientSecret.trim();

        // If auth type changed, clear tokens as they won't work with different authority
        if (
          existingConfig.authType &&
          existingConfig.authType !== validAuthType
        ) {
          delete configUpdate.accessToken;
          delete configUpdate.refreshToken;
          delete configUpdate.tokenExpiry;
        }

        await outlookLib.OutlookBridge.updateConfig(configUpdate);
        outlookLib.reset();

        const redirectUri = getOutlookRedirectUri(request);
        const result = await outlookLib.getAuthUrl(redirectUri);
        if (!result.success) {
          return response
            .status(400)
            .json({ success: false, error: result.error });
        }
        const configurationTenantId = SystemSettings.tenantConfigurationId();
        const nonce = randomUUID();
        await prisma.cache_data.create({data:{name:`outlook-oauth:${nonce}`,data:"outlook",expiresAt:new Date(Date.now()+10*60*1000)}});
        const state = jwt.sign({tenantId:configurationTenantId,ver:request.ep.authVersion},process.env.JWT_SECRET,{subject:request.ep.userId,jwtid:nonce,audience:"outlook-enterprise-configuration",expiresIn:"10m",algorithm:"HS256"});
        const url = new URL(result.url);
        url.searchParams.set("state",state);
        return response.status(200).json({ success: true, url: url.toString() });
      } catch (e) {
        console.error("Outlook auth URL error:", e);
        response.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.get(
    "/agent-skills/outlook/auth-callback",
    [outlookCallbackIdentity],
    async (request, response) => {
      try {
        const { code, error, error_description } = request.query;

        if (error) {
          console.error("Outlook OAuth error:", error, error_description);
          return response.redirect(
            `/?outlook_auth=error&message=${encodeURIComponent(error_description || error)}`
          );
        }

        if (!code) {
          return response.redirect(
            "/?outlook_auth=error&message=No authorization code received"
          );
        }

        const outlookLib = require("../../utils/agents/aibitat/plugins/outlook/lib");
        const redirectUri = getOutlookRedirectUri(request);
        const result = await outlookLib.exchangeCodeForToken(code, redirectUri);

        const frontendUrl =
          process.env.NODE_ENV === "development" ? "http://localhost:3000" : "";

        if (!result.success) {
          return response.redirect(
            `${frontendUrl}/settings/agents?outlook_auth=error&message=${encodeURIComponent(result.error)}`
          );
        }

        return response.redirect(
          `${frontendUrl}/settings/agents?tenantId=${encodeURIComponent(request.configurationTenantId)}&outlook_auth=success`
        );
      } catch (e) {
        console.error("Outlook OAuth callback error:", e);
        response.redirect(
          `/?outlook_auth=error&message=${encodeURIComponent(e.message)}`
        );
      }
    }
  );

  app.get(
    "/admin/agent-skills/outlook/status",
    [validatedRequest, requireTenantConfiguration],
    async (_request, response) => {
      try {
        const outlookLib = require("../../utils/agents/aibitat/plugins/outlook/lib");
        const { AUTH_TYPES, normalizeTokenExpiry } = outlookLib;
        const config = await outlookLib.OutlookBridge.getConfig();
        const isConfigured = await outlookLib.OutlookBridge.isToolAvailable();

        const authType = config.authType || AUTH_TYPES.common;
        let hasCredentials = !!(config.clientId && config.clientSecret);
        if (authType === AUTH_TYPES.organization) {
          hasCredentials = hasCredentials && !!config.tenantId;
        }

        const safeConfig = {
          clientId: config.clientId || "",
          tenantId: config.tenantId || "",
          clientSecret: config.clientSecret ? "********" : "",
          authType: config.authType || AUTH_TYPES.common,
        };

        return response.status(200).json({
          success: true,
          isConfigured,
          hasCredentials,
          isAuthenticated: !!config.accessToken,
          tokenExpiry: normalizeTokenExpiry(config.tokenExpiry),
          config: safeConfig,
        });
      } catch (e) {
        console.error("Outlook status error:", e);
        response.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.post(
    "/admin/agent-skills/outlook/revoke",
    [validatedRequest, requireTenantConfiguration],
    async (_request, response) => {
      try {
        const outlookLib = require("../../utils/agents/aibitat/plugins/outlook/lib");
        const { SystemSettings } = require("../../models/systemSettings");
        await SystemSettings.delete({ label: "outlook_agent_config" });
        outlookLib.reset();
        return response.status(200).json({ success: true });
      } catch (e) {
        console.error("Outlook revoke error:", e);
        response.status(500).json({ success: false, error: e.message });
      }
    }
  );
}

module.exports = { outlookAgentEndpoints };
