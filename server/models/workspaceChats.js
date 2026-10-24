const prisma = require("../utils/prisma");
const { safeJSONStringify } = require("../utils/helpers/chat/responses");

// Scope is taken from the authenticated identity, never a create/query payload.
function chatScope(ctx) {
  if (
    typeof ctx?.tenantId !== "string" ||
    !ctx.tenantId ||
    !Number.isInteger(ctx?.userId) ||
    ctx.userId < 1 ||
    ctx.identity === "platform"
  )
    throw Object.assign(new Error("请使用当前企业的用户账户访问对话"), {
      status: 401,
    });
  return { tenantId: ctx.tenantId, userId: ctx.userId };
}

const Chat = {
  new: async function (
    ctx,
    { prompt, response = {}, threadId, include = true, apiSessionId = null },
    db = prisma
  ) {
    const scope = chatScope(ctx);
    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      typeof response?.text !== "string" ||
      !response.text.trim() ||
      !Number.isInteger(threadId) ||
      threadId < 1
    )
      throw Object.assign(new Error("仅可保存完整的问答记录"), { status: 400 });
    const thread = await db.chat_threads.findFirst({
      where: { id: threadId, ...scope },
    });
    if (!thread)
      throw Object.assign(new Error("对话不存在或无权访问"), { status: 404 });
    const now = new Date();
    const chat = await db.chats.create({
      data: {
        ...scope,
        prompt,
        response: safeJSONStringify(response),
        thread_id: threadId,
        api_session_id: apiSessionId,
        include,
        createdAt: now,
        lastUpdatedAt: now,
      },
    });
    return { chat, message: null };
  },

  forThread: async function (
    ctx,
    threadId,
    { limit = null, orderBy = { id: "asc" }, include = true } = {},
    db = prisma
  ) {
    chatScope(ctx);
    if (!Number.isInteger(threadId) || threadId < 1) return [];
    return this.where(
      ctx,
      {
        thread_id: threadId,
        api_session_id: null,
        ...(include === null ? {} : { include }),
      },
      { limit, orderBy },
      db
    );
  },

  get: async function (ctx, clause = {}, db = prisma) {
    if (Object.hasOwn(clause, "id") && (!Number.isInteger(clause.id) || clause.id < 1))
      return null;
    return db.chats.findFirst({ where: { ...clause, ...chatScope(ctx) } });
  },

  update: async function (ctx, chatId, data, db = prisma) {
    const writable = {};
    for (const key of ["prompt", "include", "memoryProcessed"])
      if (Object.hasOwn(data, key)) writable[key] = data[key];
    if (Object.hasOwn(data, "response"))
      writable.response = safeJSONStringify(data.response);
    const result = await db.chats.updateMany({
      where: { id: chatId, ...chatScope(ctx) },
      data: { ...writable, lastUpdatedAt: new Date() },
    });
    return result.count ? this.get(ctx, { id: chatId }, db) : null;
  },

  // Agent execution reserves a pair before the reply and completes that same row.
  reserve: async function (ctx, { prompt, threadId }, db = prisma) {
    const scope = chatScope(ctx);
    const thread = await db.chat_threads.findFirst({
      where: { id: threadId, ...scope },
    });
    if (!thread)
      throw Object.assign(new Error("对话不存在或无权访问"), { status: 404 });
    const now = new Date();
    return db.chats.create({
      data: {
        ...scope,
        thread_id: threadId,
        prompt,
        response: safeJSONStringify({}),
        include: false,
        createdAt: now,
        lastUpdatedAt: now,
      },
    });
  },

  delete: async function (ctx, clause = {}, db = prisma) {
    await db.chats.deleteMany({ where: { ...clause, ...chatScope(ctx) } });
    return true;
  },

  where: async function (
    ctx,
    clause = {},
    { limit = null, orderBy = { id: "asc" }, offset = null } = {},
    db = prisma
  ) {
    return db.chats.findMany({
      where: { ...clause, ...chatScope(ctx) },
      ...(limit !== null ? { take: limit } : {}),
      ...(offset !== null ? { skip: offset } : {}),
      orderBy,
    });
  },

  count: async function (ctx, clause = {}, db = prisma) {
    return db.chats.count({ where: { ...clause, ...chatScope(ctx) } });
  },

  // Reset excludes prior records from normal history and model context.
  markThreadHistoryInvalid: async function (ctx, threadId, db = prisma) {
    const scope = chatScope(ctx);
    if (!Number.isInteger(threadId) || threadId < 1) return { count: 0 };
    return db.chats.updateMany({
      where: { thread_id: threadId, ...scope },
      data: { include: false, lastUpdatedAt: new Date() },
    });
  },

  updateFeedbackScore: async function (
    ctx,
    chatId,
    feedbackScore = null,
    db = prisma
  ) {
    if (![null, true, false, 0, 1].includes(feedbackScore))
      throw Object.assign(new Error("反馈值无效"), { status: 400 });
    return db.chats.updateMany({
      where: { id: chatId, ...chatScope(ctx) },
      data: {
        feedbackScore: feedbackScore === null ? null : Boolean(feedbackScore),
        lastUpdatedAt: new Date(),
      },
    });
  },

  markMemoryProcessed: async function (ctx, ids = [], db = prisma) {
    const safeIds = ids.filter((id) => Number.isInteger(id) && id > 0);
    if (!safeIds.length) return;
    return db.chats.updateMany({
      where: { id: { in: safeIds }, ...chatScope(ctx) },
      data: { memoryProcessed: true },
    });
  },
};

module.exports = { Chat, chatScope };
