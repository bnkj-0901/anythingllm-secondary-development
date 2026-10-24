const { ChatThread } = require("../../../models/workspaceThread");
const { Chat } = require("../../../models/workspaceChats");
const { executeChat } = require("../../../enterprise/rag");
const { MobileDevice } = require("../../../models/mobileDevice");
const { fail } = require("../../../enterprise/auth");
async function handleMobileCommand(req, res) {
  const { command } = req.params;
  const ctx = req.ep;
  const body = req.body || {};
  if (command === "conversations")
    return res.json({ threads: await ChatThread.where(ctx) });
  if (command === "conversation-content") {
    const thread = await ChatThread.get(ctx, { id: body.conversationId });
    if (!thread) throw fail(404, "Conversation not found");
    return res.json({ thread, chats: await Chat.forThread(ctx, thread.id) });
  }
  if (command === "model-tag") {
    const connection =
      await require("../../../enterprise/providers").resolveConnection(
        ctx,
        "chat"
      );
    return res.json({ model: connection.config.model || "default" });
  }
  if (command === "new-thread") return res.json(await ChatThread.new(ctx));
  if (command === "reset-chat") {
    const thread = await ChatThread.get(ctx, { id: body.conversationId });
    if (!thread) throw fail(404, "Conversation not found");
    await Chat.markThreadHistoryInvalid(ctx, thread.id);
    return res.json({ success: true });
  }
  if (command === "stream-chat") {
    const thread = await ChatThread.get(ctx, { id: body.conversationId });
    if (!thread) throw fail(404, "Conversation not found");
    res.set({
      "Cache-Control": "no-cache",
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const controller = new AbortController();
    const close = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", close);
    try {
      await executeChat({
        ctx,
        threadId: thread.id,
        prompt: body.message,
        signal: controller.signal,
        onEvent: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      });
      return res.end();
    } finally {
      res.off("close", close);
    }
  }
  if (command === "unregister-device") {
    await MobileDevice.delete(res.locals.device.id);
    return res.json({ success: true });
  }
  throw fail(
    400,
    "Invalid command; this SaaS client uses personal conversations instead of Workspaces"
  );
}
module.exports = { handleMobileCommand };
