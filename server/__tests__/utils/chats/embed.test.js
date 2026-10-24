const { EventEmitter } = require("events");
jest.mock("../../../enterprise/rag", () => ({
  executePublishedChat: jest.fn(),
}));
jest.mock("../../../models/embedChats", () => ({
  EmbedChats: { new: jest.fn(), forEmbedByUser: jest.fn() },
}));
const { executePublishedChat } = require("../../../enterprise/rag");
const { EmbedChats } = require("../../../models/embedChats");
const { streamChatWithForEmbed } = require("../../../utils/chats/embed");
const config = (options = {}) => ({
  id: "publication",
  tenantId: "tenant-a",
  libraryId: "published-library",
  chat_mode: "chat",
  allow_prompt_override: true,
  allow_temperature_override: true,
  allow_model_override: true,
  ...options,
});
const response = () =>
  Object.assign(new EventEmitter(), {
    write: jest.fn(),
    locals: { connection: { ip: "127.0.0.1" } },
  });
beforeEach(() => {
  jest.clearAllMocks();
  EmbedChats.forEmbedByUser.mockResolvedValue([]);
  EmbedChats.new.mockResolvedValue({ chat: { id: "visitor-chat" } });
  executePublishedChat.mockImplementation(async ({ onEvent }) => {
    const result = {
      textResponse: "An answer.",
      sources: [{ title: "Published source" }],
    };
    onEvent({ type: "textResponseChunk", textResponse: result.textResponse });
    onEvent({ type: "finalizeResponseStream", ...result });
    return result;
  });
});
describe("published chat overrides without Workspace ownership", () => {
  it("keeps tenant defaults when overrides are omitted", async () => {
    await streamChatWithForEmbed(response(), config(), "hello", "session", {
      promptOverride: null,
      temperatureOverride: null,
    });
    expect(executePublishedChat).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        libraryId: "published-library",
        systemPrompt: null,
        temperature: null,
      })
    );
  });
  it("passes enabled prompt, model and temperature overrides into shared chat execution", async () => {
    await streamChatWithForEmbed(response(), config(), "hello", "session", {
      promptOverride: "Overridden prompt.",
      modelOverride: "selected-model",
      temperatureOverride: 0.9,
    });
    expect(executePublishedChat).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "Overridden prompt.",
        model: "selected-model",
        temperature: 0.9,
      })
    );
  });
  it("preserves an empty prompt and zero temperature override", async () => {
    await streamChatWithForEmbed(response(), config(), "hello", "session", {
      promptOverride: "",
      temperatureOverride: 0,
    });
    expect(executePublishedChat).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: "", temperature: 0 })
    );
  });
  it("does not pass forbidden overrides to the model", async () => {
    await streamChatWithForEmbed(
      response(),
      config({
        allow_prompt_override: false,
        allow_temperature_override: false,
        allow_model_override: false,
      }),
      "hello",
      "session",
      {
        promptOverride: "Injected",
        modelOverride: "forbidden",
        temperatureOverride: 0.9,
      }
    );
    expect(executePublishedChat).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: undefined,
        model: undefined,
        temperature: undefined,
      })
    );
  });
});
describe("visitor history and stream persistence", () => {
  it("retains visitor username and model usage metrics in the original saved record", async () => {
    executePublishedChat.mockImplementationOnce(async ({onEvent}) => {
      const result={textResponse:"Answer",sources:[],metrics:{prompt_tokens:7}};
      onEvent({type:"finalizeResponseStream",...result});
      return result;
    });
    await streamChatWithForEmbed(response(),config(),"hello","session",{username:"Visitor"});
    expect(EmbedChats.new).toHaveBeenCalledWith(expect.objectContaining({response:expect.objectContaining({metrics:{prompt_tokens:7}}),connection_information:{ip:"127.0.0.1",username:"Visitor"}}));
  });
  it("stores the model answer and sources before finalizing with the persisted visitor ID", async () => {
    const res = response();
    await streamChatWithForEmbed(res, config(), "hello", "session");
    expect(EmbedChats.new).toHaveBeenCalledWith({
      embedId: "publication",
      prompt: "hello",
      response: {
        text: "An answer.",
        sources: [{ title: "Published source" }],
        type: "chat",
        metrics: {},
      },
      sessionId: "session",
      connection_information: { ip: "127.0.0.1", username: null },
    });
    expect(JSON.parse(res.write.mock.calls.at(-1)[0].slice(6))).toMatchObject({
      type: "finalizeResponseStream",
      chatId: "visitor-chat",
    });
    expect(res.listenerCount("close")).toBe(0);
  });
  it.each(["streaming", "non-streaming"])(
    "saves no visitor record when shared %s execution rejects an empty answer",
    async () => {
      executePublishedChat.mockRejectedValueOnce(
        new Error("聊天模型未返回有效回答")
      );
      const res = response();
      await expect(
        streamChatWithForEmbed(res, config(), "hello", "session")
      ).rejects.toThrow("未返回有效回答");
      expect(EmbedChats.new).not.toHaveBeenCalled();
      expect(res.listenerCount("close")).toBe(0);
    }
  );
  it("loads the publication history limit and converts pairs before model execution", async () => {
    EmbedChats.forEmbedByUser.mockResolvedValue([
      {
        prompt: "Earlier question",
        response: JSON.stringify({ text: "Earlier answer" }),
        include: true,
      },
    ]);
    await streamChatWithForEmbed(
      response(),
      config({ message_limit: 5 }),
      "hello",
      "session"
    );
    expect(EmbedChats.forEmbedByUser).toHaveBeenCalledWith(
      "publication",
      "session",
      5,
      { id: "desc" }
    );
    expect(executePublishedChat).toHaveBeenCalledWith(
      expect.objectContaining({
        history: [
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
        ],
      })
    );
  });
  it("aborts shared generation when the visitor disconnects and removes its listener", async () => {
    const res = response();
    let signal;
    executePublishedChat.mockImplementationOnce(async (options) => {
      signal = options.signal;
      res.emit("close");
      throw new Error("disconnected");
    });
    await expect(
      streamChatWithForEmbed(res, config(), "hello", "session")
    ).rejects.toThrow("disconnected");
    expect(signal.aborted).toBe(true);
    expect(res.listenerCount("close")).toBe(0);
    expect(EmbedChats.new).not.toHaveBeenCalled();
  });
});
