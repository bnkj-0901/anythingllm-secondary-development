const { addChatCostToMetrics } = require("../helpers/modelPricing");
const {
  convertToPromptHistory,
  writeResponseChunk,
} = require("../helpers/chat/responses");
const {
  resolveReasoningEffort,
  usesModelRouter,
} = require("../helpers/reasoningEffort");

const VALID_CHAT_MODE = ["automatic", "chat", "query"];

// Ownership and source authorization are resolved before this stage. Keep the
// provider-specific prompt construction, vision encoding and compression here.
async function compressChatMessages(connector, promptArgs, rawHistory = []) {
  return connector.compressMessages(
    {
      ...promptArgs,
      chatHistory: convertToPromptHistory(rawHistory),
    },
    rawHistory
  );
}

// Shared by personal chat, developer API and published chat. Providers retain
// their original decoder, reasoning format and performance monitor.
async function generateChatResponse({
  connector,
  messages,
  response = null,
  uuid,
  sources = [],
  user = null,
  configuration = null,
  parameters = {},
  sessionReasoningEffort = null,
  signal,
  onStream = null,
}) {
  signal?.throwIfAborted();
  const routingMetadata = connector.routingMetadata || null;
  const reasoningEffort = usesModelRouter(configuration)
    ? null
    : await resolveReasoningEffort(connector, sessionReasoningEffort);
  const options = { ...parameters, user, reasoningEffort };
  let textResponse, metrics;
  if (
    !response ||
    parameters.streamingDisabled ||
    connector.streamingEnabled() !== true
  ) {
    const result = await connector.getChatCompletion(messages, options);
    signal?.throwIfAborted();
    textResponse = result.textResponse;
    metrics = result.metrics;
    if (response)
      writeResponseChunk(response, {
        uuid,
        sources,
        type: "textResponseChunk",
        textResponse,
        close: true,
        error: false,
      });
  } else {
    const stream = await connector.streamGetChatCompletion(messages, options);
    onStream?.(stream);
    signal?.throwIfAborted();
    textResponse = await connector.handleStream(response, stream, {
      uuid,
      sources,
    });
    signal?.throwIfAborted();
    metrics = stream.metrics;
  }
  return {
    textResponse,
    metrics: addChatCostToMetrics(metrics, {
      routingMetadata,
      workspace: configuration,
      connector,
    }),
  };
}

module.exports = {
  VALID_CHAT_MODE,
  compressChatMessages,
  generateChatResponse,
};
