const prisma = require("../utils/prisma");
const slugifyModule = require("slugify");
const { v4: uuidv4 } = require("uuid");
const truncate = require("truncate");
const { Chat, chatScope } = require("./workspaceChats");

const ChatThread = {
  defaultName: "Thread",
  writable: ["name"],

  slugify: function (...args) {
    slugifyModule.extend({
      "+": " plus ",
      "!": " bang ",
      "@": " at ",
      "*": " splat ",
      ".": " dot ",
      ":": "",
      "~": "",
      "(": "",
      ")": "",
      "'": "",
      '"': "",
      "|": "",
    });
    return slugifyModule(...args);
  },

  new: async function (ctx, data = {}, db = prisma) {
    const scope = chatScope(ctx);
    const now = new Date();
    const thread = await db.chat_threads.create({
      data: {
        ...scope,
        name: data.name ? String(data.name) : this.defaultName,
        slug: data.slug
          ? this.slugify(data.slug, { lowercase: true })
          : uuidv4(),
        createdAt: now,
        lastUpdatedAt: now,
      },
    });
    return { thread, message: null };
  },

  update: async function (ctx, threadId, data = {}, db = prisma) {
    const scope = chatScope(ctx);
    if (!Number.isInteger(threadId) || threadId < 1)
      return { thread: null, message: null };
    const validData = {};
    Object.entries(data).forEach(([key, value]) => {
      if (!this.writable.includes(key)) return;
      validData[key] = value;
    });
    const where = { id: threadId, ...scope };
    if (Object.keys(validData).length) {
      await db.chat_threads.updateMany({
        where,
        data: { ...validData, lastUpdatedAt: new Date() },
      });
    }
    return {
      thread: await db.chat_threads.findFirst({ where }),
      message: null,
    };
  },

  get: async function (ctx, clause = {}, db = prisma) {
    if (Object.hasOwn(clause, "id") && (!Number.isInteger(clause.id) || clause.id < 1))
      return null;
    return db.chat_threads.findFirst({
      where: { ...clause, ...chatScope(ctx) },
    });
  },

  // Called in the request transaction, alongside current identity checks.
  delete: async function (ctx, threadId, db = prisma) {
    const scope = chatScope(ctx);
    if (!Number.isInteger(threadId) || threadId < 1) return false;
    const where = { id: threadId, ...scope };
    const thread = await db.chat_threads.findFirst({ where });
    if (!thread) return false;
    await Chat.delete(ctx, { thread_id: thread.id }, db);
    const { ParsedFiles } = require("./workspaceParsedFiles");
    await ParsedFiles.delete(
      ctx,
      (await ParsedFiles.where(ctx, thread.id, db)).map((file) => file.id),
      db
    );
    await db.workspace_agent_invocations.deleteMany({
      where: {
        thread_id: thread.id,
        tenantId: ctx.tenantId,
        user_id: ctx.userId,
      },
    });
    await db.chat_threads.deleteMany({ where });
    return true;
  },

  where: async function (
    ctx,
    clause = {},
    { limit = null, orderBy = { lastUpdatedAt: "desc" } } = {},
    db = prisma
  ) {
    return db.chat_threads.findMany({
      where: { ...clause, ...chatScope(ctx) },
      ...(limit !== null ? { take: limit } : {}),
      orderBy,
    });
  },

  autoRenameThread: async function (ctx, thread, prompt, db = prisma) {
    if (!thread || !prompt || thread.name !== this.defaultName) return false;
    const chatCount = await Chat.count(ctx, { thread_id: thread.id }, db);
    if (chatCount !== 1) return false;
    const result = await db.chat_threads.updateMany({
      where: { id: thread.id, name: this.defaultName, ...chatScope(ctx) },
      data: { name: truncate(prompt, 22) },
    });
    return result.count === 1;
  },
};

module.exports = { ChatThread };
