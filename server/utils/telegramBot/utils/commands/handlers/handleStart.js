async function handleStart(ctx, chatId) {
  const user = await ctx.identity(chatId);
  await ctx.bot.sendMessage(
    chatId,
    `Welcome, ${user.user.username}. Your conversations are personal. Use /switch to select a conversation and /help for commands.`
  );
}
module.exports = { handleStart };
