const { showThreadMenu } = require("../../commands/handlers/showThreadMenu");

/**
 * Handle thread menu pagination.
 * @param {object} params
 * @param {import("../../commands/index").BotContext} params.ctx
 * @param {number} params.chatId
 * @param {{id: string}} params.query
 * @param {number} params.messageId
 * @param {string} params.data
 */
async function handleThreadPagination({
  ctx,
  chatId,
  query,
  messageId,
  data,
} = {}) {
  const page = parseInt(data.slice(5), 10);
  await showThreadMenu(ctx, chatId, null, page, messageId);
  await ctx.bot.answerCallbackQuery(query.id);
}

module.exports = { handleThreadPagination };
