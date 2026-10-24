const { Chat } = require("../../../../../models/workspaceChats");
async function handleReset(ctx, chatId) {
  const user = await ctx.identity(chatId);
  const state = ctx.getState(chatId);
  if (state.threadSlug)
    await Chat.markThreadHistoryInvalid(user, state.threadSlug);
  await ctx.bot.sendMessage(
    chatId,
    "Previous messages remain visible but will not be used as model context."
  );
}
module.exports = { handleReset };
