const { ChatThread } = require("../../../../../models/workspaceThread");
async function handleNewThread(ctx, chatId) {
  const user = await ctx.identity(chatId);
  const { thread } = await ChatThread.new(user);
  ctx.setState(chatId, { threadSlug: thread.id });
  await ctx.bot.sendMessage(chatId, "New personal conversation created.");
}
module.exports = { handleNewThread };
