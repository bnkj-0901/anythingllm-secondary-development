const prisma = require("../utils/prisma");

// Suggestions follow the enterprise chat configuration after Workspace exits.
const SuggestedMessages = {
  async getMessages(tenantId, db = prisma) {
    const messages = await db.suggested_messages.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return messages.map(({ heading, message }) => ({ heading, message }));
  },
  async saveAll(messages, tenantId, db = prisma) {
    if (!Array.isArray(messages) || messages.some((item) =>
      !item || typeof item.heading !== "string" || typeof item.message !== "string"
    ))
      throw Object.assign(new Error("Suggested messages must contain heading and message text"), { status: 400 });
    await db.$transaction(async (tx) => {
      await tx.suggested_messages.deleteMany({ where: { tenantId } });
      for (const { heading, message } of messages)
        await tx.suggested_messages.create({ data: { tenantId, heading, message } });
    });
  },
};

module.exports = { SuggestedMessages };
