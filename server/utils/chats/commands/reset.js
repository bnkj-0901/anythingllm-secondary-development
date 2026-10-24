const { Chat } = require("../../../models/workspaceChats");
async function resetMemory({ctx, threadId, configuration, db}) {
  await Chat.markThreadHistoryInvalid(ctx, threadId, db);
  const { ModelRouterService } = require("../../router");
  ModelRouterService.resetForConversation(ctx, threadId, configuration);
  return {textResponse: "Chat memory was reset!", sources: [], outputs: [], action: "reset_chat"};
}
module.exports = { resetMemory };
