async function showModelMenu(ctx, chatId) {
  const user = await ctx.identity(chatId);
  const providers = require("../../../../../enterprise/providers");
  const connection = await providers.resolveConnection(user, "chat");
  await ctx.bot.sendMessage(
    chatId,
    `Your enterprise model: ${connection.config.model || connection.provider}. Model selection is maintained by the platform administrator.`
  );
}
module.exports = { showModelMenu };
