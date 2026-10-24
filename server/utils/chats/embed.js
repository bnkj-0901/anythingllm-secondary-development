const { executePublishedChat } = require("../../enterprise/rag");
const { EmbedChats } = require("../../models/embedChats");
const { convertToPromptHistory } = require("../helpers/chat/responses");
async function streamChatWithForEmbed(
  response,
  embed,
  message,
  sessionId,
  { promptOverride, modelOverride, temperatureOverride, username } = {}
) {
  const history = await EmbedChats.forEmbedByUser(
    embed.id,
    sessionId,
    embed.message_limit || 20,
    { id: "desc" }
  );
  const abort = new AbortController();
  const disconnected = () => {
    if (!response.writableEnded) abort.abort();
  };
  response.on("close", disconnected);
  let finalized;
  try {
    const result = await executePublishedChat({
      tenantId: embed.tenantId,
      libraryId: embed.libraryId,
      prompt: message,
      history: convertToPromptHistory(history.reverse()),
      mode: embed.chat_mode,
      systemPrompt: embed.allow_prompt_override ? promptOverride : undefined,
      model: embed.allow_model_override ? modelOverride : undefined,
      temperature: embed.allow_temperature_override
        ? temperatureOverride
        : undefined,
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === "finalizeResponseStream") finalized = event;
        else response.write(`data: ${JSON.stringify(event)}\n\n`);
      },
    });
    const { chat, message: error } = await EmbedChats.new({
      embedId: embed.id,
      prompt: message,
      response: {
        text: result.textResponse,
        sources: result.sources,
        type: embed.chat_mode,
        metrics: result.metrics || {},
      },
      sessionId,
      connection_information: {
        ...response.locals.connection,
        username: username ? String(username) : null,
      },
    });
    if (!chat) throw new Error(error || "Failed to save visitor history");
    response.write(
      `data: ${JSON.stringify({ ...finalized, id: chat.id, chatId: chat.id, type: "finalizeResponseStream" })}\n\n`
    );
    return result;
  } finally {
    response.off("close", disconnected);
  }
}
module.exports = { streamChatWithForEmbed };
