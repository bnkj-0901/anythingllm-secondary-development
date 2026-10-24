const {
  ExternalCommunicationConnector: Connector,
} = require("../models/externalCommunicationConnector");
const { TelegramBotService } = require("../utils/telegramBot");
const {
  authenticate,
  manager,
  tenantId,
  wrap,
} = require("../utils/middleware/externalIdentity");
const { fail } = require("../enterprise/auth");
const { encryptToken } = require("../utils/telegramBot/utils");
function telegramEndpoints(app) {
  app.get(
    "/telegram/config",
    authenticate,
    wrap(async (req, res) => {
      const id = tenantId(req),
        row = await Connector.get("telegram", id),
        service = new TelegramBotService(id);
      res.json({
        config: row
          ? {
              active: row.active,
              connected: service.isRunning,
              bot_username: row.config.bot_username,
              voice_response_mode:
                row.config.voice_response_mode || "text_only",
            }
          : null,
      });
    })
  );
  app.get(
    "/telegram/status",
    authenticate,
    wrap(async (req, res) => {
      const id = tenantId(req),
        row = await Connector.get("telegram", id);
      res.json({
        active: !!row?.active && new TelegramBotService(id).isRunning,
        bot_username: row?.config.bot_username || null,
      });
    })
  );
  app.post(
    "/telegram/connect",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const id = tenantId(req),
        { bot_token } = req.body;
      if (typeof bot_token !== "string" || !bot_token)
        throw fail(400, "Bot token is required");
      const check = await TelegramBotService.verifyToken(bot_token);
      if (!check.valid) throw fail(400, "Invalid bot token");
      const existing = await Connector.get("telegram", id);
      const config = {
        bot_id: check.botId,
        bot_username: check.username,
        bot_token: encryptToken(bot_token),
        active: true,
        approved_users:
          existing?.botId === check.botId
            ? existing.config.approved_users || []
            : [],
        voice_response_mode:
          existing?.config.voice_response_mode || "text_only",
      };
      const { connector } = await Connector.upsert("telegram", config, id);
      if (!connector)
        throw fail(
          409,
          "This Telegram Bot is already connected or could not be saved"
        );
      await new TelegramBotService(id).start({
        ...connector.config,
        bot_token,
      });
      res.json({ success: true, bot_username: check.username });
    })
  );
  app.post(
    "/telegram/disconnect",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const id = tenantId(req);
      await new TelegramBotService(id).stop();
      await Connector.delete("telegram", id);
      res.json({ success: true });
    })
  );
  app.get(
    "/telegram/pending-users",
    authenticate,
    manager,
    wrap(async (req, res) =>
      res.json({
        users: new TelegramBotService(tenantId(req)).pendingPairings.map(
          ({ code: _code, ...item }) => item
        ),
      })
    )
  );
  app.get(
    "/telegram/approved-users",
    authenticate,
    wrap(async (req, res) => {
      const users =
        (await Connector.get("telegram", tenantId(req)))?.config
          .approved_users || [];
      res.json({
        users:
          req.ep.identity === "platform" || req.ep.role === "admin"
            ? users
            : users.filter((user) => user.userId === req.ep.userId),
      });
    })
  );
  // The user proves both the signed-in enterprise account and the Telegram chat's code.
  app.post(
    "/telegram/approve-user",
    authenticate,
    wrap(async (req, res) => {
      if (req.ep.identity !== "tenant")
        throw fail(400, "Pair from the enterprise user account");
      const { chatId, code } = req.body;
      try {
        await new TelegramBotService(req.ep.tenantId).approvePendingUser(
          chatId,
          req.ep.userId,
          code
        );
      } catch {
        throw fail(400, "配对码无效、已过期或 Telegram 账号已绑定其他用户");
      }
      res.json({ success: true });
    })
  );
  app.post(
    "/telegram/deny-user",
    authenticate,
    manager,
    wrap(async (req, res) => {
      await new TelegramBotService(tenantId(req)).denyPendingUser(
        req.body.chatId
      );
      res.json({ success: true });
    })
  );
  app.post(
    "/telegram/revoke-user",
    authenticate,
    wrap(async (req, res) => {
      const id = tenantId(req),
        row = await Connector.get("telegram", id);
      const binding = row?.config.approved_users?.find(
        (u) => String(u.chatId) === String(req.body.chatId)
      );
      if (
        !binding ||
        (req.ep.identity !== "platform" &&
          req.ep.role !== "admin" &&
          binding.userId !== req.ep.userId)
      )
        throw fail(404, "Binding not found");
      const service = new TelegramBotService(id);
      service.abortChat(Number(req.body.chatId));
      await service.revokeExistingUser(req.body.chatId);
      res.json({ success: true });
    })
  );
  app.post(
    "/telegram/update-config",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const id = tenantId(req),
        mode = req.body.voice_response_mode;
      if (!["text_only", "mirror", "always_voice"].includes(mode))
        throw fail(400, "Invalid voice mode");
      await Connector.updateConfig(
        "telegram",
        { voice_response_mode: mode },
        id
      );
      new TelegramBotService(id).updateConfig({ voice_response_mode: mode });
      res.json({ success: true });
    })
  );
}
module.exports = { telegramEndpoints };
