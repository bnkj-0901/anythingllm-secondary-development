const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { flexUserRoleValid, ROLES } = require("../utils/middleware/multiUserProtected");
const { SlashCommandPresets } = require("../models/slashCommandsPresets");
const { isReservedCommand } = require("../utils/chats");

// Shared by the original system router and the SaaS configuration router.
function systemAgentEndpoints(app) {
  app.post(
    "/system/validate-sql-connection",
    [validatedRequest, flexUserRoleValid([ROLES.admin])],
    async (request, response) => {
      const { engine, connectionString } = reqBody(request);
      try {
        if (!engine || !connectionString) {
          return response.status(400).json({
            success: false,
            error: "Both engine and connection details are required.",
          });
        }

        const {
          validateConnection,
        } = require("../utils/agents/aibitat/plugins/sql-agent/SQLConnectors");
        const result = await validateConnection(engine, { connectionString });

        if (!result.success) {
          return response.status(200).json({
            success: false,
            error: `Unable to connect to ${engine}. Please verify your connection details.`,
          });
        }

        response.status(200).json(result);
      } catch (error) {
        console.error("SQL validation error:", error);
        response.status(500).json({
          success: false,
          error: `Unable to connect to ${engine}. Please verify your connection details.`,
        });
      }
    }
  );
}

function slashCommandPresetEndpoints(app) {
  const { requireAuth, fail } = require("../enterprise/auth");
  const store = require("../enterprise/store");
  const guarded = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  const presetData = (req) => {
    const { command, prompt, description } = reqBody(req);
    if (typeof command !== "string" || typeof prompt !== "string" || !prompt.trim())
      throw fail(400, "Command and prompt are required");
    const formatted = SlashCommandPresets.formatCommand(command);
    if (isReservedCommand(formatted)) throw fail(400, "Cannot shadow a system command");
    return { command: formatted, prompt, description: String(description || "") };
  };
  app.get("/system/slash-command-presets", requireAuth, guarded(async (req,res) => {
    res.json({ presets: await SlashCommandPresets.getUserPresets(req.ep, store.orm) });
  }));
  app.post("/system/slash-command-presets", requireAuth, guarded(async (req,res) => {
    res.status(201).json({ preset: await SlashCommandPresets.create(req.ep, presetData(req), store.orm) });
  }));
  app.post("/system/slash-command-presets/:slashCommandId", requireAuth, guarded(async (req,res) => {
    const preset = await SlashCommandPresets.update(req.ep, req.params.slashCommandId, presetData(req), store.orm);
    if (!preset) throw fail(404, "Preset not found");
    res.json({preset});
  }));
  app.delete("/system/slash-command-presets/:slashCommandId", requireAuth, guarded(async (req,res) => {
    if (!await SlashCommandPresets.delete(req.ep, req.params.slashCommandId, store.orm)) throw fail(404, "Preset not found");
    res.sendStatus(204);
  }));
}

module.exports = { systemAgentEndpoints, slashCommandPresetEndpoints };
