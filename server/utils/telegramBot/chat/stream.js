const {
  STREAM_EDIT_INTERVAL,
  MAX_MSG_LEN,
  CURSOR_CHAR,
} = require("../constants");
const { editMessage } = require("../utils");
const { sendVoiceResponse } = require("../utils/media");
const { safeJsonParse } = require("../../http");
async function streamResponse({
  ctx,
  chatId,
  identity,
  thread,
  message,
  attachments = [],
  voiceResponse = false,
}) {
  const { executeChat } = require("../../../enterprise/rag");
  const { context } = require("../../../enterprise/auth");
  const settings =
    await require("../../../enterprise/rag-settings").getSettings(
      identity.tenantId
    );
  const history =
    await require("../../../models/workspaceChats").Chat.forThread(
      identity,
      thread.id,
      { include: true }
    );
  const { AgentHandler } = require("../../agents");
  if (
    (settings.chatMode === "chat" &&
      history.some((pair) => pair.prompt.startsWith("@agent"))) ||
    (await AgentHandler.isAgentInvocation({
      message,
      workspace: settings,
      chatMode: settings.chatMode || "automatic",
    }))
  ) {
    return require("./agent").handleAgentResponse(
      ctx,
      chatId,
      identity,
      thread,
      message,
      voiceResponse,
      attachments
    );
  }
  await ctx.bot.sendChatAction(chatId, "typing");
  const { responseHandler, flushEdit, cancel } = createStreamHandler({
    ctx,
    chatId,
  });
  let deliveredText = false;
  const check = async () => {
    const current = await context(identity.userId);
    const connector =
      await require("../../../models/externalCommunicationConnector").ExternalCommunicationConnector.get(
        "telegram",
        identity.tenantId
      );
    if (
      current.tenantId !== identity.tenantId ||
      !connector?.active ||
      !connector.config.approved_users?.some(
        (u) =>
          String(u.chatId) === String(chatId) && u.userId === identity.userId
      )
    )
      throw new Error("Telegram access revoked");
  };
  const timer = setInterval(
    () => ctx.bot.sendChatAction(chatId, "typing").catch(() => {}),
    4000
  );
  try {
    const result = await executeChat({
      ctx: identity,
      threadId: thread.id,
      prompt: message,
      attachments,
      onEvent: async (event) => {
        await check();
        if (event.type === "finalizeResponseStream") {
          if (!deliveredText && event.textResponse)
            responseHandler.write(`data: ${JSON.stringify({ ...event, close: false })}\n\n`);
        } else {
          if (event.textResponse && !event.close) deliveredText = true;
          responseHandler.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      },
    });
    await check();
    await flushEdit(true);
    if (voiceResponse && result.textResponse)
      await sendVoiceResponse(ctx.bot, chatId, result.textResponse, ctx.log);
    return result;
  } finally {
    clearInterval(timer);
    cancel();
  }
}

function parseSSEChunk(data) {
  const match = data.match(/^data: (.+)\n\n$/s);
  if (!match) return null;
  const parsed = safeJsonParse(match[1], null);
  if (!parsed || !parsed.textResponse || parsed.close) return null;
  return parsed.textResponse;
}

/**
 * Create a stream response handler for editing Telegram messages as tokens arrive.
 * Manages message splitting when content exceeds Telegram's length limit.
 * @param {object} options
 * @param {import("./commands").BotContext} options.ctx - Bot context
 * @param {number} options.chatId - Telegram chat ID
 * @returns {{ responseHandler: object, flushEdit: function }}
 */
function createStreamHandler({ ctx, chatId }) {
  let completeText = "";
  let messageId = null;
  let messagePending = null;
  let lastEditTime = 0;
  let editTimer = null;
  let msgOffset = 0;

  const currentText = () => completeText.slice(msgOffset);

  /**
   * Finalize the current message and reset state when accumulated text
   * exceeds Telegram's max message length.
   */
  function splitMessageIfOverflow() {
    if (messageId === null || currentText().length <= MAX_MSG_LEN) return;
    clearTimeout(editTimer);
    editTimer = null;
    editMessage(
      ctx.bot,
      chatId,
      messageId,
      completeText.slice(msgOffset, msgOffset + MAX_MSG_LEN),
      ctx.log,
      { format: true }
    ).catch(() => {});
    msgOffset += MAX_MSG_LEN;
    messageId = null;
    messagePending = null;
  }

  /**
   * Send a new Telegram message when none exists yet.
   * @returns {boolean} true if a new message was initiated (caller should skip edit).
   */
  function startNewMessageIfNeeded() {
    if (messageId !== null || messagePending) return false;
    messagePending = ctx.bot
      .sendMessage(chatId, currentText() + CURSOR_CHAR)
      .then((sent) => {
        messageId = sent.message_id;
        lastEditTime = Date.now();
      })
      .catch(() => {
        messagePending = null;
      });
    return true;
  }

  /**
   * Throttle edits to the current message so we don't exceed Telegram rate limits.
   */
  function scheduleThrottledEdit() {
    if (!messageId) return;

    const now = Date.now();
    if (now - lastEditTime >= STREAM_EDIT_INTERVAL) {
      clearTimeout(editTimer);
      lastEditTime = now;
      editMessage(
        ctx.bot,
        chatId,
        messageId,
        currentText() + CURSOR_CHAR,
        ctx.log
      ).catch(() => {});
    } else if (!editTimer) {
      editTimer = setTimeout(() => {
        lastEditTime = Date.now();
        editMessage(
          ctx.bot,
          chatId,
          messageId,
          currentText() + CURSOR_CHAR,
          ctx.log
        ).catch(() => {});
        editTimer = null;
      }, STREAM_EDIT_INTERVAL);
    }
  }

  const flushEdit = async (final = false) => {
    if (messagePending) await messagePending;
    if (!messageId) return;
    clearTimeout(editTimer);
    editTimer = null;
    const text = currentText();
    const display = final ? text : text + CURSOR_CHAR;
    await editMessage(ctx.bot, chatId, messageId, display, ctx.log, {
      format: final,
    }).catch(() => {});
  };

  const responseHandler = {
    on: () => {},
    removeListener: () => {},
    write: (data) => {
      const token = parseSSEChunk(data);
      if (!token) return;

      completeText += token;
      splitMessageIfOverflow();
      if (!startNewMessageIfNeeded()) scheduleThrottledEdit();
    },
  };

  return {
    responseHandler,
    flushEdit,
    cancel: () => {
      clearTimeout(editTimer);
      editTimer = null;
    },
  };
}

module.exports = { streamResponse };
