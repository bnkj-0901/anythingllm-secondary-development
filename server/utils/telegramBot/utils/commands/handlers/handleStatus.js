const { ChatThread } = require("../../../../../models/workspaceThread");
async function handleStatus(ctx, chatId) {
  const user = await ctx.identity(chatId);
  const thread = ctx.getState(chatId).threadSlug
    ? await ChatThread.get(user, { id: ctx.getState(chatId).threadSlug })
    : null;
  const configuration = await require("../../../../../enterprise/rag-settings").getSettings(user.tenantId);
  const connection = await require("../../../../../enterprise/providers").resolveConnection(user, "chat", { ctx: user, configuration });
  const provider = configuration.agentProvider || configuration.chatProvider || connection.provider;
  const model = configuration.agentModel || configuration.chatModel || connection.config.model;
  const AIbitat = require("../../../../agents/aibitat");
  const agentProvider = new AIbitat({ provider, model }).getProviderForConfig({ provider, model });
  const nativeToolCalling = await agentProvider.supportsNativeToolCalling?.();
  await ctx.bot.sendMessage(
    chatId,
    `Enterprise: ${user.tenant.name}\nAccount: ${user.user.username}\nConversation: ${thread?.name || "New conversation"}\nLLM Provider: ${provider}\nLLM Model: ${model}\nNative Tool Calling: ${nativeToolCalling ? "Enabled" : "Disabled"}\nChat Mode: ${configuration.chatMode || "chat"}`
  );
}
module.exports = { handleStatus };
