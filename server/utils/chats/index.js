const { v4: uuidv4 } = require("uuid");
const { Chat } = require("../../models/workspaceChats");
const { resetMemory } = require("./commands/reset");
const { generateImage } = require("./commands/img");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { SlashCommandPresets } = require("../../models/slashCommandsPresets");
const { SystemPromptVariables } = require("../../models/systemPromptVariables");

const VALID_COMMANDS = {
  "/reset": resetMemory,
  "/img": generateImage,
};

/**
 * Checks if a command exactly matches a built-in system command (eg: /reset)
 * so a preset cannot shadow it. Commands that merely extend a built-in name
 * (eg: /reset-all) are valid user-defined presets.
 * @param {string} command - the formatted command to check (eg: /reset)
 * @returns {boolean}
 */
function isReservedCommand(command = "") {
  return Object.keys(VALID_COMMANDS).includes(String(command).toLowerCase());
}

async function grepCommand(message, ctx = null, db = undefined) {
  const userPresets = ctx
    ? await SlashCommandPresets.getUserPresets(ctx, db)
    : [];
  const availableCommands = Object.keys(VALID_COMMANDS);

  // Check if the message starts with any built-in command. Like the preset
  // matching below, require the command to not be part of a longer command
  // (e.g. don't match /reset in /reset-all) so preset commands that extend a
  // built-in name are not hijacked.
  for (let i = 0; i < availableCommands.length; i++) {
    const cmd = availableCommands[i];
    const re = new RegExp(`^(${cmd})(?![a-z0-9_-])`, "i");
    if (re.test(message)) {
      return cmd;
    }
  }

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of userPresets) {
    // Match the command when it starts the message or follows a space (`lead`),
    // and is not part of a longer command (e.g. don't match /weather in /weatherman).
    // `lead` is captured so we can keep the space when swapping in the prompt.
    const regex = new RegExp(`(^|\\s)(${preset.command})(?![a-z0-9_-])`, "g");
    updatedMessage = updatedMessage.replace(
      regex,
      (_match, lead) => `${lead}${preset.prompt}`
    );
  }

  return updatedMessage;
}

/**
 * @description This function will do recursive replacement of all slash commands with their corresponding prompts.
 * @notice API requests use the same executing user's presets as personal chat.
 * @returns {Promise<string>}
 */
async function grepAllSlashCommands(message, ctx) {
  const allPresets = await SlashCommandPresets.where(ctx, {});

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of allPresets) {
    // Match the command when it starts the message or follows a space (`lead`),
    // and is not part of a longer command (e.g. don't match /weather in /weatherman).
    // `lead` is captured so we can keep the space when swapping in the prompt.
    const regex = new RegExp(`(^|\\s)(${preset.command})(?![a-z0-9_-])`, "g");
    updatedMessage = updatedMessage.replace(
      regex,
      (_match, lead) => `${lead}${preset.prompt}`
    );
  }

  return updatedMessage;
}

async function recentChatHistory({ ctx, threadId, messageLimit = 20, db }) {
  const rawHistory = (
    await Chat.forThread(
      ctx,
      threadId,
      { include: true, limit: messageLimit, orderBy: { id: "desc" } },
      db
    )
  ).reverse();
  return { rawHistory, chatHistory: convertToPromptHistory(rawHistory) };
}

/**
 * @typedef {Object} ChatPromptOptions
 * @property {string} [prompt] - The current user message. Used to rerank injected memories.
 * @property {object[]} [rawHistory] - Recent chat history rows. Used to rerank injected memories.
 * @property {boolean} [skipMemories] - When true, no stored memories are looked up or injected.
 * Set this for unauthenticated contexts (eg: embeds) where there is no real user identity.
 */

/**
 * Returns the base prompt for the chat with memories appended (when enabled).
 * Also does variable substitution on the prompt if there are any defined variables.
 * @param {Object|null} configuration - resolved tenant chat settings
 * @param {Object|null} ctx - authenticated execution identity
 * @param {ChatPromptOptions} [opts]
 * @returns {Promise<string>}
 */
async function chatPrompt(configuration, ctx = null, opts = {}) {
  const { SystemSettings } = require("../../models/systemSettings");
  const { promptWithMemories } = require("../memories");
  const basePrompt =
    configuration?.openAiPrompt ?? SystemSettings.saneDefaultSystemPrompt;
  const systemPrompt =
    opts.variablesExpanded === true
      ? basePrompt
      : await SystemPromptVariables.expandSystemPromptVariables(
          basePrompt,
          ctx?.userId,
          { tenantId: ctx?.tenantId }
        );

  // Anonymous publications and stateless API history have no personal memory.
  if (
    opts.skipMemories === true ||
    !ctx?.tenantId ||
    !ctx?.userId ||
    ctx.identity === "embed"
  )
    return systemPrompt;

  return promptWithMemories({
    systemPrompt,
    ctx,
    prompt: opts.prompt ?? "",
    rawHistory: opts.rawHistory ?? [],
  });
}

// We use this util function to deduplicate sources from similarity searching
// if the document is already pinned.
// Eg: You pin a csv, if we RAG + full-text that you will get the same data
// points both in the full-text and possibly from RAG - result in bad results
// even if the LLM was not even going to hallucinate.
function sourceIdentifier(sourceDocument) {
  if (!sourceDocument?.title || !sourceDocument?.published) return uuidv4();
  return `title:${sourceDocument.title}-timestamp:${sourceDocument.published}`;
}

module.exports = {
  sourceIdentifier,
  recentChatHistory,
  chatPrompt,
  grepCommand,
  grepAllSlashCommands,
  isReservedCommand,
  VALID_COMMANDS,
};
