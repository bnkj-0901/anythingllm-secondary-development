const { Chat } = require("../../models/workspaceChats.js");
const { safeJsonParse } = require("../../utils/http/index.js");
const { getBaseLLMProviderModel } = require("../../utils/helpers/index.js");
const AIbitat = require("../../utils/agents/aibitat/index.js");
const truncate = require("truncate");

// Cap per-group chat review so a long-dormant user can't trigger a 500-chat summarization.
const CHATS_PER_RUN_LIMIT = 20;

// Per-message cap — we keep 20 chats of context but truncate each prompt/response
// so a single huge message doesn't blow the LLM's context window.
const MAX_CHARS_PER_MESSAGE = 1500;

// Hard ceiling on candidates the Observer can return per run.
const MAX_CANDIDATES_PER_RUN = 3;

const OBSERVER_SYSTEM_PROMPT = `You are a memory observer for a personalized AI assistant. Your job is to identify facts about the user that are worth remembering for future conversations.

You will be shown recent conversations between a user and an AI assistant. Extract candidate observations — factual statements about the user that would help personalize future responses.

RULES:
- Maximum ${MAX_CANDIDATES_PER_RUN} observations per batch.
- Each observation must be a single, concise factual statement (1 sentence max).
- Assign a confidence level: "high" for explicitly stated facts, "medium" for strongly implied facts, "low" for inferences.
- If the user shares their name, that is ALWAYS worth extracting.
- If nothing useful is found, return an empty list — but look carefully first.

WHAT TO EXTRACT:
- The user's name, role, company, or team
- What the user is working on or their goals
- Preferences the user has stated (communication style, tools, formats)
- Expertise areas or technical background
- Constraints or requirements the user mentioned

WHAT TO SKIP:
- The assistant's opinions or assessments about the user
- Emotional states or motivational commentary
- Generic politeness ("thanks", "sounds good", willingness to continue)
- Information that only the assistant stated, not the user

When finished you MUST call the submit-observations tool.`;

const REFLECTOR_SYSTEM_PROMPT = `You are a memory reflector for a personalized AI assistant. Review candidate observations against this user's existing personal memories.
DEDUPLICATE: drop overlaps, including differently worded duplicates.
CONSOLIDATE: update an existing memory by its ID when an observation refines it.
FILTER: drop low-confidence candidates unless explicitly stated identity facts; keep persistent facts and preferences only.
All memories are personal to this user. Never create shared company knowledge.
When finished call save-memories. An empty list is correct if nothing should change.`;

/**
 * Group chats by (user_id, workspaceId).
 * @param {object[]} chats
 * @returns {Map<string, object[]>}
 */
function groupByUser(chats) {
  const groups = new Map();
  for (const chat of chats) {
    const key = `${chat.tenantId}:${chat.userId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chat);
  }
  return groups;
}

/**
 * Requery at summarize time so we reflect the current state (new chats, deletions).
 * Drop chats that died mid-stream / are pending, then reverse to chronological order.
 * @returns {Promise<object[]>}
 */
async function loadLatestChats(ctx) {
  const latest = await Chat.where(
    ctx,
    { include: true },
    { limit: CHATS_PER_RUN_LIMIT, orderBy: { id: "desc" } }
  );
  return latest
    .filter(
      (chat) =>
        typeof safeJsonParse(chat.response)?.text === "string" &&
        safeJsonParse(chat.response).text.length
    )
    .reverse();
}

/**
 * Pick a provider/model: workspace chat → workspace agent → system default.
 * @returns {{provider: string, model: string}|null}
 */
function resolveLLM(configuration = {}) {
  if (configuration.chatProvider && configuration.chatModel)
    return {
      provider: configuration.chatProvider,
      model: configuration.chatModel,
    };
  if (configuration.agentProvider && configuration.agentModel)
    return {
      provider: configuration.agentProvider,
      model: configuration.agentModel,
    };
  const provider = process.env.LLM_PROVIDER;
  const model = provider ? getBaseLLMProviderModel({ provider }) : null;
  return provider && model ? { provider, model } : null;
}

// ── Phase 1: Observer ────────────────────────────────────────────────

function buildObserverUserMessage(chats) {
  const formattedChats = chats
    .map((chat) => {
      const lines = [`User: ${truncate(chat.prompt, MAX_CHARS_PER_MESSAGE)}`];
      const parsed = safeJsonParse(chat.response);
      if (parsed?.text)
        lines.push(
          `Assistant: ${truncate(parsed.text, MAX_CHARS_PER_MESSAGE)}`
        );
      return lines.join("\n");
    })
    .join("\n\n");

  return `Recent conversations to analyze:\n${formattedChats}`;
}

/**
 * Phase 1: Observer agent — extracts candidate facts from conversations.
 * Returns {candidates, rawText} where candidates is an array or null,
 * and rawText is whatever the model said (for debugging when the tool isn't called).
 */
async function runObserver({ provider, model, userMessage }) {
  let candidates = null;
  let rawText = "";
  const aibitat = new AIbitat({ provider, model, maxRounds: 3 });

  aibitat.onMessage((msg) => {
    if (msg.from === "OBSERVER" && msg.content) rawText = msg.content;
  });

  aibitat
    .function({
      name: "submit-observations",
      description:
        "Submit candidate observations extracted from the conversations. An empty list is correct if nothing worth remembering was found.",
      parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          observations: {
            type: "array",
            maxItems: MAX_CANDIDATES_PER_RUN,
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description:
                    "A single factual statement about the user (1 sentence max).",
                },
                confidence: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                  description:
                    "high = explicitly stated, medium = strongly implied, low = inferred.",
                },
                reasoning: {
                  type: "string",
                  description:
                    "Brief justification for why this is worth remembering.",
                },
              },
              required: ["content", "confidence", "reasoning"],
              additionalProperties: false,
            },
            description: `Candidate observations, max ${MAX_CANDIDATES_PER_RUN} items. Empty list is fine.`,
          },
        },
        required: ["observations"],
        additionalProperties: false,
      },
      handler: function (args) {
        const { observations } = args;
        candidates = Array.isArray(observations)
          ? observations
              .filter(
                (o) =>
                  typeof o === "object" &&
                  o !== null &&
                  typeof o.content === "string" &&
                  o.content.trim().length > 0 &&
                  ["high", "medium", "low"].includes(o.confidence)
              )
              .slice(0, MAX_CANDIDATES_PER_RUN)
          : null;
        aibitat.skipHandleExecution = true;
        return "Observations submitted.";
      },
    })
    .agent("USER", { role: "Provides conversations for observation." })
    .agent("OBSERVER", {
      role: OBSERVER_SYSTEM_PROMPT,
      functions: ["submit-observations"],
    });

  await aibitat.start({
    from: "USER",
    to: "OBSERVER",
    content: userMessage,
  });

  return { candidates, rawText };
}

// ── Phase 2: Reflector ───────────────────────────────────────────────

function buildReflectorUserMessage(candidates, memories, availableSlots) {
  const listed = memories.length
    ? memories
        .map((memory) => `- [ID: ${memory.id}] ${memory.content}`)
        .join("\n")
    : "None.";
  return `Candidate observations:\n${candidates.map((item, index) => `${index + 1}. "${item.content}" (${item.confidence}) — ${item.reasoning}`).join("\n")}\n\nExisting personal memories:\n${listed}\n\nAvailable slots for new memories: ${Math.max(0, availableSlots)}`;
}

/**
 * Phase 2: Reflector agent — classifies scope, deduplicates, and filters
 * candidates against existing memories.
 * Returns {memories, rawText} where memories is an array or null.
 */
async function runReflector({ provider, model, userMessage }) {
  let finalMemories = null;
  let rawText = "";
  const aibitat = new AIbitat({ provider, model, maxRounds: 3 });

  aibitat.onMessage((msg) => {
    if (msg.from === "REFLECTOR" && msg.content) rawText = msg.content;
  });

  aibitat
    .function({
      name: "save-memories",
      description:
        "Save the final list of memories after classification, deduplication, and filtering. An empty list is correct if all candidates were filtered out.",
      parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          memories: {
            type: "array",
            maxItems: MAX_CANDIDATES_PER_RUN,
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: "The memory statement (1 sentence max).",
                },
                scope: {
                  type: "string",
                  enum: ["PERSONAL"],
                  description:
                    "Personal facts and preferences belonging to this user.",
                },
                action: {
                  type: "string",
                  enum: ["create", "update", "skip"],
                  description:
                    "create = new memory, update = revise an existing workspace memory, skip = do not save.",
                },
                updateId: {
                  type: "number",
                  description:
                    "The ID of the existing WORKSPACE memory to update. Required when action is 'update'.",
                },
                reasoning: {
                  type: "string",
                  description:
                    "Brief justification for the scope classification and action decision.",
                },
              },
              required: ["content", "scope", "action", "reasoning"],
              additionalProperties: false,
            },
            description: `Final memories to save, max ${MAX_CANDIDATES_PER_RUN} items. Empty list is fine.`,
          },
        },
        required: ["memories"],
        additionalProperties: false,
      },
      handler: function (args) {
        const { memories } = args;
        finalMemories = Array.isArray(memories)
          ? memories
              .filter(
                (m) =>
                  typeof m === "object" &&
                  m !== null &&
                  typeof m.content === "string" &&
                  m.content.trim().length > 0 &&
                  m.scope === "PERSONAL" &&
                  ["create", "update", "skip"].includes(m.action)
              )
              .filter((m) => m.action !== "skip")
              .slice(0, MAX_CANDIDATES_PER_RUN)
          : null;
        aibitat.skipHandleExecution = true;
        return "Memories saved.";
      },
    })
    .agent("USER", { role: "Provides candidate observations for reflection." })
    .agent("REFLECTOR", {
      role: REFLECTOR_SYSTEM_PROMPT,
      functions: ["save-memories"],
    });

  await aibitat.start({
    from: "USER",
    to: "REFLECTOR",
    content: userMessage,
  });

  return { memories: finalMemories, rawText };
}

module.exports = {
  groupByUser,
  loadLatestChats,
  resolveLLM,
  buildObserverUserMessage,
  runObserver,
  buildReflectorUserMessage,
  runReflector,
};
