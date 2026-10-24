jest.mock("../../../../models/workspaceChats", () => ({
  Chat: { markThreadHistoryInvalid: jest.fn() },
}));
jest.mock("../../../../models/workspaceThread", () => ({
  ChatThread: { get: jest.fn() },
}));
jest.mock("../../../../models/mobileDevice", () => ({ MobileDevice: {} }));
jest.mock("../../../../enterprise/rag", () => ({ executeChat: jest.fn() }));
jest.mock("../../../../enterprise/auth", () => ({
  fail: (status, message) => Object.assign(new Error(message), { status }),
}));

const { Chat } = require("../../../../models/workspaceChats");
const { ChatThread } = require("../../../../models/workspaceThread");
const { executeChat } = require("../../../../enterprise/rag");
const { handleMobileCommand } = require("../../../../endpoints/mobile/utils");

describe("mobile personal conversations", () => {
  const ctx = { tenantId: "tenant-a", userId: 101, identity: "tenant" };
  const thread = { id: 201, tenantId: "tenant-a", userId: 101 };
  function response() {
    return {
      json: jest.fn().mockReturnThis(),
      set: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      on: jest.fn(),
      off: jest.fn(),
      end: jest.fn(),
      writableEnded: false,
    };
  }
  beforeEach(() => {
    jest.clearAllMocks();
    ChatThread.get.mockResolvedValue(thread);
  });

  it("resets only the selected conversation under the device's live identity", async () => {
    const res = response();
    await handleMobileCommand(
      {
        ep: ctx,
        params: { command: "reset-chat" },
        body: { conversationId: thread.id, userId: "other", tenantId: "other" },
      },
      res
    );
    expect(ChatThread.get).toHaveBeenCalledWith(ctx, { id: thread.id });
    expect(Chat.markThreadHistoryInvalid).toHaveBeenCalledWith(ctx, thread.id);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it("rejects an inaccessible conversation without resetting any history", async () => {
    ChatThread.get.mockResolvedValue(null);
    await expect(
      handleMobileCommand(
        {
          ep: ctx,
          params: { command: "reset-chat" },
          body: { conversationId: "other-user" },
        },
        response()
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(Chat.markThreadHistoryInvalid).not.toHaveBeenCalled();
  });

  it("does not fall back to another conversation when the selection is absent", async () => {
    ChatThread.get.mockResolvedValue(null);
    await expect(
      handleMobileCommand(
        { ep: ctx, params: { command: "reset-chat" }, body: {} },
        response()
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(Chat.markThreadHistoryInvalid).not.toHaveBeenCalled();
  });

  it("rejects inaccessible streams before sending SSE headers", async () => {
    ChatThread.get.mockResolvedValue(null);
    const res = response();
    await expect(
      handleMobileCommand(
        {
          ep: ctx,
          params: { command: "stream-chat" },
          body: { conversationId: "other-user", message: "hi" },
        },
        res
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(res.flushHeaders).not.toHaveBeenCalled();
    expect(executeChat).not.toHaveBeenCalled();
  });

  it("awaits streaming and forwards disconnect cancellation to the original chat engine", async () => {
    const res = response();
    executeChat.mockImplementation(
      async ({ ctx: actual, threadId, signal, onEvent }) => {
        expect(actual).toBe(ctx);
        expect(threadId).toBe(thread.id);
        onEvent({ type: "textResponse", textResponse: "hello" });
        res.on.mock.calls.find(([event]) => event === "close")[1]();
        expect(signal.aborted).toBe(true);
      }
    );
    await handleMobileCommand(
      {
        ep: ctx,
        params: { command: "stream-chat" },
        body: { conversationId: thread.id, message: "hi" },
      },
      res
    );
    expect(res.write).toHaveBeenCalledWith(
      'data: {"type":"textResponse","textResponse":"hello"}\n\n'
    );
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.off).toHaveBeenCalledWith("close", expect.any(Function));
  });
});
