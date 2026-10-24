const { ChatThread } = require("../../../../../models/workspaceThread");

/**
 * Select or create the bound employee's personal conversation.
 * @param {object} params
 * @param {import("../../commands/index").BotContext} params.ctx
 * @param {number} params.chatId
 * @param {{id: string}} params.query
 * @param {string} params.data
 */
async function handleThreadSelect({ ctx, chatId, query, data } = {}) {
  const identity = await ctx.identity(chatId);
  let thread;
  if (data === "th:new") ({ thread } = await ChatThread.new(identity));
  else thread = await ChatThread.get(identity, { id: Number(data.slice(3)) });
  if (!thread) throw new Error("Conversation not found");
  ctx.setState(chatId, { threadSlug: thread.id });
  await ctx.bot.answerCallbackQuery(query.id, {
    text: "Conversation selected",
  });
}

module.exports = { handleThreadSelect };
