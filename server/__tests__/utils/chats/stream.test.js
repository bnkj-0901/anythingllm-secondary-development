const { EventEmitter } = require("events");
const {
  generateChatResponse,
  compressChatMessages,
} = require("../../../utils/chats/stream");
const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
const {
  chatHistory,
} = require("../../../utils/agents/aibitat/plugins/chat-history");
jest.mock("../../../models/workspaceChats", () => ({
  Chat: { reserve: jest.fn(), update: jest.fn() },
}));
jest.mock("../../../models/workspaceThread", () => ({
  ChatThread: { get: jest.fn() },
}));
const { Chat } = require("../../../models/workspaceChats");
function connector(streaming = true) {
  return {
    model: "test-model",
    temperature: 0.4,
    streamingEnabled: () => streaming,
    getChatCompletion: jest.fn(async () => ({
      textResponse: "Sync answer",
      metrics: { prompt_tokens: 8, completion_tokens: 2 },
    })),
    streamGetChatCompletion: jest.fn(async () => ({
      metrics: { prompt_tokens: 9, completion_tokens: 3 },
    })),
    handleStream: jest.fn(async (response, _stream, { uuid }) => {
      writeResponseChunk(response, {
        uuid,
        type: "textResponseChunk",
        textResponse: "Stream answer",
        close: false,
        error: false,
      });
      return "Stream answer";
    }),
    compressMessages: jest.fn(async (args) => args),
  };
}
test("generation reuses the original provider stream decoder and performance metrics", async () => {
  const llm = connector(),
    response = new EventEmitter();
  response.write = jest.fn();
  const result = await generateChatResponse({
    connector: llm,
    messages: [{ role: "user", content: "Question" }],
    response,
    uuid: "request",
    user: { id: "alice" },
    parameters: { temperature: 0.4 },
  });
  expect(llm.streamGetChatCompletion).toHaveBeenCalledWith(
    [{ role: "user", content: "Question" }],
    expect.objectContaining({ temperature: 0.4, user: { id: "alice" } })
  );
  expect(llm.handleStream).toHaveBeenCalledWith(response, expect.any(Object), {
    uuid: "request",
    sources: [],
  });
  expect(response.write).toHaveBeenCalledWith(
    expect.stringContaining("Stream answer")
  );
  expect(result).toEqual({
    textResponse: "Stream answer",
    metrics: { prompt_tokens: 9, completion_tokens: 3 },
  });
});
test.each([false, true])(
  "sync and disabled streaming preserve original completion behavior (%s)",
  async (streaming) => {
    const llm = connector(streaming);
    const result = await generateChatResponse({
      connector: llm,
      messages: [],
      parameters: { streamingDisabled: true },
    });
    expect(result.textResponse).toBe("Sync answer");
    expect(llm.streamGetChatCompletion).not.toHaveBeenCalled();
  }
);
test("compression calls the selected provider including its attachments and raw pair history", async () => {
  const llm = connector(),
    attachments = [
      { name: "photo", mime: "image/png", contentString: "image" },
    ],
    raw = [{ prompt: "Before", response: JSON.stringify({ text: "Answer" }) }];
  const result = await compressChatMessages(
    llm,
    {
      systemPrompt: "Configured",
      userPrompt: "Now",
      contextTexts: ["Source"],
      attachments,
    },
    raw
  );
  expect(llm.compressMessages).toHaveBeenCalledWith(
    expect.objectContaining({
      attachments,
      contextTexts: ["Source"],
      chatHistory: [
        { role: "user", content: "Before" },
        { role: "assistant", content: "Answer" },
      ],
    }),
    raw
  );
  expect(result.systemPrompt).toBe("Configured");
});
test("cancellation before generation does not invoke the provider", async () => {
  const llm = connector(),
    abort = new AbortController();
  abort.abort();
  await expect(
    generateChatResponse({ connector: llm, messages: [], signal: abort.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(llm.getChatCompletion).not.toHaveBeenCalled();
});
test("a fast Agent response waits for reservation before saving the personal pair", async () => {
  let release;
  Chat.reserve.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  Chat.update.mockResolvedValue({ id: "pair" });
  const aibitat = {
    handlerProps: {
      ctx: { tenantId: "tenant", userId: "alice" },
      invocation: { thread_id: "thread" },
    },
    _chats: [],
    _pendingCitations: [],
    onAbort: jest.fn(),
    onMessage(listener) {
      this.listeners.push(listener);
    },
    listeners: [],
    registerChatId(id) {
      this.trackedChatId = id;
    },
    clearTrackedChatId() {
      this.trackedChatId = null;
    },
    assertExecutionContext: jest.fn(),
    get chats() {
      return this._chats;
    },
  };
  const plugin = chatHistory.plugin();
  plugin._autoRenameThread = jest.fn(async () => true);
  plugin.setup(aibitat);
  const user = {
    from: "USER",
    content: "@agent summarize",
    attachments: [{ name: "picture" }],
  };
  aibitat._chats = [user];
  aibitat.listeners[0](user);
  aibitat._chats.push({ from: "AGENT", content: "Fast response" });
  const saving = aibitat.listeners[1]();
  expect(Chat.update).not.toHaveBeenCalled();
  release({ id: "pair" });
  await saving;
  expect(Chat.update).toHaveBeenCalledWith(
    aibitat.handlerProps.ctx,
    "pair",
    expect.objectContaining({
      prompt: "@agent summarize",
      include: true,
      response: expect.objectContaining({
        text: "Fast response",
        attachments: user.attachments,
      }),
    })
  );
});
