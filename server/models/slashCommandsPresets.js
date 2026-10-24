const { v4 } = require("uuid");
const prisma = require("../utils/prisma");
const { chatScope } = require("./workspaceChats");
const CMD_REGEX = new RegExp(/[^a-zA-Z0-9_-]/g);

const SlashCommandPresets = {
  formatCommand(command = "") {
    if (!command || command.length < 2) return `/${v4().split("-")[0]}`;
    let adjustedCmd = command.toLowerCase();
    if (!adjustedCmd.startsWith("/")) adjustedCmd = `/${adjustedCmd}`;
    return `/${adjustedCmd.slice(1).toLowerCase().replace(CMD_REGEX, "-")}`;
  },
  get(ctx, clause = {}, db = prisma) {
    return db.slash_command_presets.findFirst({ where: { ...clause, ...chatScope(ctx) } });
  },
  where(ctx, clause = {}, limit, db = prisma) {
    return db.slash_command_presets.findMany({
      where: { ...clause, ...chatScope(ctx) },
      take: limit || undefined,
      orderBy: { createdAt: "asc" },
    });
  },
  async create(ctx, presetData = {}, db = prisma) {
    const scope = chatScope(ctx);
    const command = this.formatCommand(presetData.command);
    return db.slash_command_presets.upsert({
      where: { tenantId_userId_command: { ...scope, command } },
      create: { ...scope, command, prompt: String(presetData.prompt), description: String(presetData.description || "") },
      update: {},
    });
  },
  async getUserPresets(ctx, db = prisma) {
    return (await this.where(ctx, {}, undefined, db)).map(({id, command, prompt, description}) => ({id, command, prompt, description}));
  },
  async update(ctx, presetId, presetData = {}, db = prisma) {
    const result = await db.slash_command_presets.updateMany({
      where: { id: Number(presetId), ...chatScope(ctx) },
      data: { command: this.formatCommand(presetData.command), prompt: String(presetData.prompt), description: String(presetData.description || "") },
    });
    return result.count ? this.get(ctx, { id: Number(presetId) }, db) : null;
  },
  async delete(ctx, presetId, db = prisma) {
    const result = await db.slash_command_presets.deleteMany({where: { id: Number(presetId), ...chatScope(ctx) }});
    return result.count > 0;
  },
};
module.exports.SlashCommandPresets = SlashCommandPresets;
