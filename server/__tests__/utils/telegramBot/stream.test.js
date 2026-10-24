/* eslint-env jest */
jest.mock("../../../enterprise/rag", () => ({ executeChat: jest.fn() }));
jest.mock("../../../enterprise/auth", () => ({ context: jest.fn() }));
jest.mock("../../../enterprise/rag-settings", () => ({
  getSettings: jest.fn(async () => ({ chatMode: "query" })),
}));
jest.mock("../../../models/workspaceChats", () => ({
  Chat: { forThread: jest.fn(async () => []) },
}));
jest.mock("../../../models/externalCommunicationConnector", () => ({
  ExternalCommunicationConnector: { get: jest.fn() },
}));
jest.mock("../../../utils/agents", () => ({
  AgentHandler: { isAgentInvocation: jest.fn(async () => false) },
}));
jest.mock("../../../utils/telegramBot/utils", () => ({
  editMessage: jest.fn(async () => {}),
}));
jest.mock("../../../utils/telegramBot/utils/media", () => ({
  sendVoiceResponse: jest.fn(),
}));
const { executeChat } = require("../../../enterprise/rag");
const { context } = require("../../../enterprise/auth");
const {
  ExternalCommunicationConnector,
} = require("../../../models/externalCommunicationConnector");
const { editMessage } = require("../../../utils/telegramBot/utils");
const { streamResponse } = require("../../../utils/telegramBot/chat/stream");
const identity = { identity: "tenant", tenantId: "company", userId: 1 };
let ctx;
beforeEach(() => {
  jest.clearAllMocks();
  context.mockResolvedValue(identity);
  ExternalCommunicationConnector.get.mockResolvedValue({
    active: true,
    config: { approved_users: [{ chatId: "7", userId: 1 }] },
  });
  ctx = {
    bot: {
      sendChatAction: jest.fn(async () => {}),
      sendMessage: jest.fn(async () => ({ message_id: 17 })),
    },
    log: jest.fn(),
  };
});
const run = () =>
  streamResponse({
    ctx,
    identity,
    chatId: 7,
    thread: { id: 1 },
    message: "Question",
  });

test("final-only query refusal reaches the original Telegram display handler", async () => {
  executeChat.mockImplementation(async ({ onEvent }) => {
    await onEvent({
      type: "finalizeResponseStream",
      close: true,
      textResponse: "No authorized source",
    });
    return { textResponse: "No authorized source" };
  });
  await run();
  expect(ctx.bot.sendMessage).toHaveBeenCalledTimes(1);
  expect(editMessage).toHaveBeenLastCalledWith(
    ctx.bot,
    7,
    17,
    "No authorized source",
    ctx.log,
    { format: true }
  );
});

test("ordinary token streams do not append the full final response twice", async () => {
  executeChat.mockImplementation(async ({ onEvent }) => {
    await onEvent({
      type: "textResponseChunk",
      close: false,
      textResponse: "Answer",
    });
    await onEvent({
      type: "finalizeResponseStream",
      close: true,
      textResponse: "Answer",
    });
    return { textResponse: "Answer" };
  });
  await run();
  expect(editMessage).toHaveBeenLastCalledWith(
    ctx.bot,
    7,
    17,
    "Answer",
    ctx.log,
    { format: true }
  );
});

test("a revoked Telegram pairing stops the final-only response before display", async () => {
  ExternalCommunicationConnector.get.mockResolvedValue({
    active: true,
    config: { approved_users: [] },
  });
  executeChat.mockImplementation(async ({ onEvent }) => {
    await onEvent({
      type: "finalizeResponseStream",
      close: true,
      textResponse: "Private answer",
    });
  });
  await expect(run()).rejects.toThrow("Telegram access revoked");
  expect(ctx.bot.sendMessage).not.toHaveBeenCalled();
  expect(editMessage).not.toHaveBeenCalled();
});
