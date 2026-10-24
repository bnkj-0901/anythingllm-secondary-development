const prisma = require("../utils/prisma");
const { chatScope } = require("./workspaceChats");

const Memory = {
  PERSONAL_LIMIT: 20,
  MAX_INJECTED_LIMIT: 5,
  validations: {
    id(value) {
      const id = Number(value);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw Object.assign(new Error("Memory not found."), { status: 404 });
      return id;
    },
    content(value) {
      if (typeof value !== "string" || !value.trim())
        throw Object.assign(new Error("Content must be a non-empty string"), {
          status: 400,
        });
      return value.trim();
    },
  },
  forUser(ctx, db = prisma) {
    return db.memories.findMany({
      where: chatScope(ctx),
      orderBy: { createdAt: "desc" },
    });
  },
  get(ctx, id, db = prisma) {
    return db.memories.findFirst({
      where: { id: this.validations.id(id), ...chatScope(ctx) },
    });
  },
  async create(ctx, { content }, db = prisma) {
    const scope = chatScope(ctx);
    if ((await db.memories.count({ where: scope })) >= this.PERSONAL_LIMIT)
      return {
        memory: null,
        message: `Maximum personal memory limit (${this.PERSONAL_LIMIT}) reached.`,
      };
    const memory = await db.memories.create({
      data: { ...scope, content: this.validations.content(content) },
    });
    return { memory, message: null };
  },
  async update(ctx, id, { content }, db = prisma) {
    const result = await db.memories.updateMany({
      where: { id: this.validations.id(id), ...chatScope(ctx) },
      data: {
        content: this.validations.content(content),
        updatedAt: new Date(),
      },
    });
    return {
      memory: result.count ? await this.get(ctx, id, db) : null,
      message: result.count ? null : "Memory not found.",
    };
  },
  async delete(ctx, id, db = prisma) {
    return (
      (
        await db.memories.deleteMany({
          where: { id: this.validations.id(id), ...chatScope(ctx) },
        })
      ).count > 0
    );
  },
  async updateLastUsed(ctx, ids = [], db = prisma) {
    if (!ids.length) return;
    await db.memories.updateMany({
      where: { ...chatScope(ctx), id: { in: ids.map(this.validations.id) } },
      data: { lastUsedAt: new Date() },
    });
  },
  // Keep Observer/Reflector results and bounded, owner-scoped updates; the two
  // former Workspace/global destinations now address one personal resource.
  async applyExtractedMemories(ctx, memories, db = prisma) {
    const result = { createdCount: 0, updatedCount: 0 };
    const scope = chatScope(ctx);
    for (const item of Array.isArray(memories) ? memories : []) {
      if (!item || typeof item.content !== "string" || !item.content.trim())
        continue;
      if (item.action === "update" && Number.isSafeInteger(item.updateId)) {
        const update = await this.update(ctx, item.updateId, item, db);
        if (update.memory) result.updatedCount++;
      } else if (item.action === "create") {
        if (
          await db.memories.findFirst({
            where: { ...scope, content: item.content.trim() },
          })
        )
          continue;
        const created = await this.create(ctx, item, db);
        if (created.memory) result.createdCount++;
      }
    }
    return result;
  },
};
module.exports = { Memory };
