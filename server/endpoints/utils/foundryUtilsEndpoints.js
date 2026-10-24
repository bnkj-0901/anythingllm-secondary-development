const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { reqBody } = require("../../utils/http");
const FoundryModels = require("../../utils/AiProviders/foundry/models");
const { env } = require("../../enterprise/ai/connection-context");

function foundryUtilsEndpoints(
  app,
  middleware = [validatedRequest, flexUserRoleValid([ROLES.admin])]
) {
  if (!app) return;

  app.post(
    "/utils/foundry/capabilities",
    middleware,
    async (request, response) => {
      try {
        const { basePath = null } = reqBody(request);
        const capabilities = await FoundryModels.resolveSource(
          basePath || env.FOUNDRY_BASE_PATH
        );
        return response.status(200).json(capabilities);
      } catch (e) {
        console.error(e);
        return response
          .status(200)
          .json({ source: "openai", canManage: false });
      }
    }
  );
}

module.exports = { foundryUtilsEndpoints };
