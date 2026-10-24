// Suppress deprecated content-type warning when sending files via the Telegram bot API.
// https://github.com/yagop/node-telegram-bot-api/blob/master/doc/usage.md#file-options-metadata
process.env.NTBA_FIX_350 = 1;
const TelegramBot = require("node-telegram-bot-api");
const { log, conclude } = require("./helpers/index.js");
const { context } = require("../enterprise/auth");
const { ChatThread } = require("../models/workspaceThread");
const { streamResponse } = require("../utils/telegramBot/chat/stream");

process.on("message", async (payload) => {
  // Ignore tool approval responses - these are handled by http-socket plugin
  if (payload?.type === "toolApprovalResponse") return;

  const {
    botToken,
    chatId,
    tenantId,
    userId,
    conversationId,
    message,
    attachments = [],
    voiceResponse = false,
  } = payload;

  try {
    const bot = new TelegramBot(botToken, { polling: false });
    const ctx = {
      bot,
      log: (text, ...args) =>
        log(args.length ? `${text} ${args.join(" ")}` : text),
    };

    const identity = await context(userId);
    if (identity.tenantId !== tenantId)
      throw new Error("Invalid Telegram execution identity");
    const connector =
      await require("../models/externalCommunicationConnector").ExternalCommunicationConnector.get(
        "telegram",
        tenantId
      );
    if (
      !connector?.active ||
      !connector.config.approved_users?.some(
        (u) => String(u.chatId) === String(chatId) && u.userId === userId
      )
    )
      throw new Error("Telegram binding revoked");
    // Buffered edits, generated files and voice replies are authorization exits
    // too. Check the live binding immediately before every Telegram write.
    ctx.bot = new Proxy(bot, {
      get(target, key) {
        const value = target[key];
        if (typeof value !== "function") return value;
        if (!/^(send|editMessage|answerCallback)/.test(String(key)))
          return value.bind(target);
        return async (...args) => {
          const live = await context(userId);
          const row =
            await require("../models/externalCommunicationConnector").ExternalCommunicationConnector.get(
              "telegram",
              tenantId
            );
          if (
            live.tenantId !== tenantId ||
            live.authVersion !== identity.authVersion ||
            !row?.active ||
            !row.config.approved_users?.some(
              (u) => String(u.chatId) === String(chatId) && u.userId === userId
            )
          )
            throw new Error("Telegram binding revoked");
          return value.apply(target, args);
        };
      },
    });
    const thread = await ChatThread.get(identity, { id: conversationId });
    if (!thread) throw new Error("Personal conversation not found");

    await require("../enterprise/execution-context").runExecution(
      identity,
      () =>
        streamResponse({
          ctx,
          chatId,
          identity,
          thread,
          message,
          attachments,
          voiceResponse,
        })
    );
  } catch (error) {
    log(`Telegram chat error: ${error.message}`);
    try {
      const bot = new TelegramBot(botToken, { polling: false });
      await bot.sendMessage(
        chatId,
        "Sorry, something went wrong. Please try again."
      );
    } catch {}
  } finally {
    conclude();
  }
});
