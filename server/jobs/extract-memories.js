const { log, conclude } = require("./helpers/index.js");
const { SystemSettings } = require("../models/systemSettings.js");
const { Memory } = require("../models/memory.js");
const { Chat } = require("../models/workspaceChats.js");
const prisma = require("../utils/prisma");
const {
  loadExecutionContext,
  runExecution,
} = require("../enterprise/execution-context");
const {
  groupByUser,
  loadLatestChats,
  resolveLLM,
  buildObserverUserMessage,
  runObserver,
  buildReflectorUserMessage,
  runReflector,
} = require("./helpers/memory-extraction-utils.js");
const IDLE_THRESHOLD_MS = Number(
  process.env.MEMORY_IDLE_THRESHOLD_MS ?? 20 * 60 * 1000
);
const MIN_CHATS_TO_PROCESS = 5;

async function processGroup(chats) {
  if (
    chats.length < MIN_CHATS_TO_PROCESS ||
    Date.now() - new Date(chats.at(-1).createdAt).getTime() < IDLE_THRESHOLD_MS
  )
    return;
  const ctx = await loadExecutionContext(chats[0]);
  return runExecution(ctx, async () => {
    const current = await loadLatestChats(ctx);
    const configuration =
      await require("../enterprise/rag-settings").getSettings(ctx.tenantId);
    const llm = resolveLLM(configuration);
    if (!current.length || !llm) return;
    const memories = await Memory.forUser(ctx);
    const { candidates } = await runObserver({
      ...llm,
      userMessage: buildObserverUserMessage(current),
    });
    if (!candidates) return;
    if (candidates.length) {
      const { memories: finalMemories } = await runReflector({
        ...llm,
        userMessage: buildReflectorUserMessage(
          candidates,
          memories,
          Memory.PERSONAL_LIMIT - memories.length
        ),
      });
      if (!finalMemories) return;
      await loadExecutionContext(ctx);
      await Memory.applyExtractedMemories(ctx, finalMemories);
    }
    await Chat.markMemoryProcessed(
      ctx,
      chats.map((chat) => chat.id)
    );
  });
}
async function extractMemories() {
  if (!(await SystemSettings.autoMemoriesEnabled())) return;
  const chats = await prisma.chats.findMany({
    where: { include: true, memoryProcessed: null },
    orderBy: { id: "asc" },
  });
  for (const group of groupByUser(chats).values()) {
    try {
      await processGroup(group);
    } catch {
      log("Skipping memory extraction for an unavailable user or provider.");
    }
  }
}
if (require.main === module)
  extractMemories()
    .catch(() => log("Memory extraction failed."))
    .finally(() => conclude());
module.exports = { extractMemories, processGroup };
