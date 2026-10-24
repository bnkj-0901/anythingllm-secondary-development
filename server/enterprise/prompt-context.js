const { fail } = require("./auth");
const providers = require("./providers");
const { TokenManager } = require("../utils/helpers/tiktoken");
const { fillSourceWindow } = require("../utils/helpers/chat");
const { safeJsonParse } = require("../utils/http");

function countTokens(connection, messages) {
  try {
    const tokenizer = new TokenManager(connection.config?.model || "");
    for (const message of messages) {
      const count = tokenizer.countFromContent(message.content);
      if (!Number.isFinite(count) || (message.content && count <= 0))
        throw new Error("Token count unavailable");
    }
    return tokenizer.statsFrom(messages);
  } catch {
    throw fail(503, "模型 Token 计算失败，请稍后重试");
  }
}

function prepareChatContext(
  history,
  sources,
  { documents = [], topK = 4 } = {}
) {
  // Saved citations remain personal snapshots. The original backfill policy
  // can use them as history, while new search results are authorized live.
  const filled = fillSourceWindow({
    nDocs: topK,
    searchResults: sources,
    history,
  });
  return {
    contextTexts: [
      ...documents.map((doc) => doc.pageContent),
      ...filled.contextTexts,
    ],
  };
}

async function packPrompt(
  connection,
  question,
  history,
  candidates,
  {
    systemPrompt,
    attachments = [],
    documents = [],
    topK = 4,
    contextTexts = null,
  } = {}
) {
  const rawHistory = history.filter((record) => {
    const response = safeJsonParse(record.response, {}) || {};
    return (
      record.include !== false &&
      typeof record.prompt === "string" &&
      record.prompt.trim() &&
      typeof response.text === "string" &&
      response.text.trim()
    );
  });
  const contexts =
    contextTexts ??
    prepareChatContext(rawHistory, candidates, { documents, topK })
      .contextTexts;
  const promptArgs = {
    systemPrompt:
      systemPrompt ??
      require("../models/systemSettings").SystemSettings
        .saneDefaultSystemPrompt,
    userPrompt: question,
    contextTexts: contexts,
    attachments,
  };
  countTokens(connection, [
    { role: "system", content: promptArgs.systemPrompt },
    { role: "user", content: question },
  ]);
  const messages = await providers.compress(connection, promptArgs, rawHistory);
  // Compression remains each original provider's policy, including providers
  // with string prompts or vision content rather than OpenAI role messages.
  return { messages, sources: candidates, historySources: [] };
}

module.exports = { packPrompt, countTokens, prepareChatContext };
