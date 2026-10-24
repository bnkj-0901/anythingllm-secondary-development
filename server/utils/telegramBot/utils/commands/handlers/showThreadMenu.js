const { ChatThread } = require("../../../../../models/workspaceThread");
const { Chat } = require("../../../../../models/workspaceChats");
const THREADS_PER_PAGE = 8;
async function showThreadMenu(
  ctx,
  chatId,
  _unused,
  page = 0,
  messageId = null
) {
  const user = await ctx.identity(chatId);
  const threads = await ChatThread.where(user);
  const activeId = ctx.getState(chatId).threadSlug;
  threads.sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId));
  const safe = Math.max(
    0,
    Math.min(
      Number(page) || 0,
      Math.max(0, Math.ceil(threads.length / THREADS_PER_PAGE) - 1)
    )
  );
  const buttons = await Promise.all(threads
    .slice(safe * THREADS_PER_PAGE, (safe + 1) * THREADS_PER_PAGE)
    .map(async (t) => {
      const count = await Chat.count(user, { thread_id: t.id });
      const name = t.id === activeId ? `🟢 ${t.name} (active)` : t.name;
      return [{ text: count ? `${name} - ${count} chats` : name, callback_data: `th:${t.id}` }];
    }));
  const nav = [];
  if (safe) nav.push({ text: "← Prev", callback_data: `thpg:${safe - 1}` });
  if ((safe + 1) * THREADS_PER_PAGE < threads.length)
    nav.push({ text: "Next →", callback_data: `thpg:${safe + 1}` });
  if (nav.length) buttons.push(nav);
  buttons.push([{ text: "New conversation", callback_data: "th:new" }]);
  const opts = { reply_markup: { inline_keyboard: buttons } };
  const text = "Select your personal conversation:";
  if (messageId)
    return ctx.bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      ...opts,
    });
  return ctx.bot.sendMessage(chatId, text, opts);
}
module.exports = { showThreadMenu };
