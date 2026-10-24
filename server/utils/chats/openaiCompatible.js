const { v4: uuidv4 } = require("uuid");
const { executeChat } = require("../../enterprise/rag");
async function chatSync({
  ctx,
  systemPrompt = null,
  history = [],
  prompt = null,
  attachments = [],
  temperature = null,
}) {
  const result = await executeChat({
    ctx,
    prompt,
    history,
    attachments,
    temperature,
    systemPrompt,
    persist: false,
  });
  return formatJSON(
    { id: result.chatId || uuidv4(), textResponse: result.textResponse },
    { model: "default", finish_reason: "stop", usage: result.metrics || {} }
  );
}
async function streamChat({
  ctx,
  systemPrompt = null,
  history = [],
  prompt = null,
  attachments = [],
  temperature = null,
  response,
}) {
  const id = uuidv4(),
    abort = new AbortController();
  let deliveredText = false;
  const close = () => {
    if (!response.writableEnded) abort.abort();
  };
  response.on("close", close);
  try {
    await executeChat({
      ctx,
      prompt,
      history,
      attachments,
      temperature,
      systemPrompt,
      persist: false,
      signal: abort.signal,
      onEvent: async (event) => {
        if (event.type === "textResponseChunk" || event.type === "textResponse") {
          deliveredText = deliveredText || Boolean(event.textResponse);
          response.write(
            `data: ${JSON.stringify(formatJSON({ ...event, id }, { chunked: true, model: "default" }))}\n\n`
          );
        }
        if (event.type === "finalizeResponseStream")
          response.write(
            `data: ${JSON.stringify(formatJSON({ id, textResponse: deliveredText ? "" : event.textResponse || "" }, { chunked: true, model: "default", finish_reason: "stop", usage: event.metrics || {} }))}\n\n`
          );
      },
    });
    response.write("data: [DONE]\n\n");
  } finally {
    response.off("close", close);
  }
}
function formatJSON(
  chat,
  { chunked = false, model, finish_reason = null, usage = {} }
) {
  const data = {
    id: chat.uuid ?? chat.id,
    object: "chat.completion",
    created: Math.floor(Number(new Date()) / 1000),
    model: model,
    choices: [
      {
        index: 0,
        [chunked ? "delta" : "message"]: {
          role: "assistant",
          content: chat.textResponse,
        },
        logprobs: null,
        finish_reason: finish_reason,
      },
    ],
    usage,
  };

  return data;
}

module.exports.OpenAICompatibleChat = { chatSync, streamChat };
