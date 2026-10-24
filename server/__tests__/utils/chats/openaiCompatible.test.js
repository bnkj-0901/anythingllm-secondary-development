const { EventEmitter } = require("events");
jest.mock("../../../enterprise/rag", () => ({ executeChat: jest.fn() }));
const { executeChat } = require("../../../enterprise/rag");
const {
  OpenAICompatibleChat,
} = require("../../../utils/chats/openaiCompatible");
const {
  extractTextContent,
  extractAttachments,
} = require("../../../endpoints/api/openai/helpers");
const ctx = { identity: "tenant", tenantId: "company-a", userId: "alice" };
const history = [
  { role: "user", content: "Previous question" },
  { role: "assistant", content: "Previous answer" },
];
const multimodal = [
  { type: "text", text: "Describe this image" },
  {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aGVsbG8=", detail: "low" },
  },
];
beforeEach(() => jest.clearAllMocks());

test("query refusal delivered only by the final event is not lost in OpenAI streaming", async () => {
  executeChat.mockImplementation(async ({ onEvent }) => {
    await onEvent({ type: "finalizeResponseStream", textResponse: "No relevant information.", close: true, metrics: {} });
  });
  const response = Object.assign(new EventEmitter(), { write: jest.fn() });
  await OpenAICompatibleChat.streamChat({ ctx, prompt: "unknown", response });
  const chunks = response.write.mock.calls.map(([frame]) => frame.trim().slice(6)).filter((frame) => frame !== "[DONE]").map(JSON.parse);
  expect(chunks.map((chunk) => chunk.choices[0].delta.content).join("")).toBe("No relevant information.");
  expect(response.write.mock.calls.filter(([frame]) => frame === "data: [DONE]\n\n")).toHaveLength(1);
});
test.each(["Hello", multimodal])(
  "OpenAI sync retains protocol and forwards personal execution identity and multimodal input",
  async (content) => {
    executeChat.mockResolvedValue({
      textResponse: "Answer",
      metrics: { prompt_tokens: 8, completion_tokens: 2 },
    });
    const result = await OpenAICompatibleChat.chatSync({
      ctx,
      prompt: extractTextContent(content),
      attachments: extractAttachments(content),
      history,
      systemPrompt: "System",
      temperature: 0.7,
    });
    expect(executeChat).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx,
        prompt: extractTextContent(content),
        attachments: extractAttachments(content),
        history,
        systemPrompt: "System",
        temperature: 0.7,
        persist: false,
      })
    );
    expect(result).toMatchObject({
      object: "chat.completion",
      model: "default",
      choices: [
        {
          message: { role: "assistant", content: "Answer" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    });
  }
);
test("streaming translates the shared personal SSE into OpenAI chunks and one DONE marker", async () => {
  executeChat.mockImplementation(async ({ onEvent }) => {
    await onEvent({ type: "textResponseChunk", textResponse: "First " });
    await onEvent({ type: "textResponseChunk", textResponse: "second" });
    await onEvent({
      type: "finalizeResponseStream",
      metrics: { completion_tokens: 2 },
    });
  });
  const response = new EventEmitter();
  response.write = jest.fn();
  await OpenAICompatibleChat.streamChat({
    ctx,
    prompt: extractTextContent(multimodal),
    attachments: extractAttachments(multimodal),
    history,
    response,
  });
  const frames = response.write.mock.calls.map(([chunk]) =>
    chunk.trim().slice(6)
  );
  expect(frames.at(-1)).toBe("[DONE]");
  const chunks = frames.slice(0, -1).map(JSON.parse);
  expect(chunks.map((chunk) => chunk.choices[0].delta.content)).toEqual([
    "First ",
    "second",
    "",
  ]);
  expect(chunks.at(-1)).toMatchObject({
    choices: [{ finish_reason: "stop" }],
    usage: { completion_tokens: 2 },
  });
  expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
  expect(executeChat).toHaveBeenCalledWith(
    expect.objectContaining({
      ctx,
      persist: false,
      attachments: extractAttachments(multimodal),
    })
  );
  expect(response.listenerCount("close")).toBe(0);
});
test("disconnect aborts the shared provider request and leaves no close listener", async () => {
  const response = new EventEmitter();
  response.write = jest.fn();
  executeChat.mockImplementation(async ({ signal }) => {
    response.emit("close");
    signal.throwIfAborted();
  });
  await expect(
    OpenAICompatibleChat.streamChat({ ctx, prompt: "Question", response })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(response.write).not.toHaveBeenCalled();
  expect(response.listenerCount("close")).toBe(0);
});
