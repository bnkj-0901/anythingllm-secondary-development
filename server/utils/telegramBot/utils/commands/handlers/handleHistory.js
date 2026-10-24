const { ChatThread } = require("../../../../../models/workspaceThread");
const { Chat } = require("../../../../../models/workspaceChats");
const { convertToChatHistory } = require("../../../../helpers/chat/responses");
const { sendBatchedMessages } = require("../../../utils");
const { escapeHTML } = require("../../format");

const DEFAULT_HISTORY_COUNT = 10;
const MAX_HISTORY_COUNT = 50;

/**
 * /history [count] - Show recent chat history.
 * @param {import("../index").BotContext} ctx
 * @param {number} chatId
 * @param {string} [messageText] - Full message text to parse count from
 */
async function handleHistory(ctx, chatId, messageText = "") {
  const state = ctx.getState(chatId);
  const identity = await ctx.identity(chatId);
  const match = messageText.match(/\/history\s+(\d+)/);
  const count = match
    ? Math.min(parseInt(match[1], 10), MAX_HISTORY_COUNT)
    : DEFAULT_HISTORY_COUNT;

  const thread = state.threadSlug
    ? await ChatThread.get(identity, { id: state.threadSlug })
    : null;
  const rawChats = thread
    ? await Chat.forThread(identity, thread.id, {
        limit: count,
        orderBy: { id: "desc" },
        include: true,
      })
    : [];

  if (!rawChats.length) {
    await ctx.bot.sendMessage(chatId, "No messages yet in this thread.");
    return;
  }

  const history = convertToChatHistory(rawChats.reverse());

  const exchanges = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (entry.role === "user") {
      let block = `<b>You:</b> ${escapeHTML(entry.content || "")}`;
      if (i + 1 < history.length && history[i + 1].role === "assistant") {
        block += `\n\n<b>AI:</b> ${escapeHTML(history[i + 1].content || "")}`;
        i++;
      }
      exchanges.push(block);
    } else if (entry.role === "assistant") {
      exchanges.push(`<b>AI:</b> ${escapeHTML(entry.content || "")}`);
    }
  }

  if (!exchanges.length) return;

  const threadName = thread?.name || "Default";
  const header = `<b>${threadName}</b>\nLast ${exchanges.length} message(s)\n\n`;

  await sendBatchedMessages(ctx.bot, chatId, exchanges, {
    header,
    separator: "\n\n———\n\n",
    sendOptions: { parse_mode: "HTML" },
  });
}

module.exports = { handleHistory };
