const ctx = { identity: "tenant", tenantId: "company-a", userId: "alice" };
jest.mock("../../../models/slashCommandsPresets", () => ({
  SlashCommandPresets: { getUserPresets: jest.fn(), where: jest.fn() },
}));
jest.mock("../../../utils/memories", () => ({
  promptWithMemories: jest.fn(async ({ systemPrompt }) => systemPrompt),
}));
jest.mock("../../../models/systemPromptVariables", () => ({
  SystemPromptVariables: {
    expandSystemPromptVariables: jest.fn(async (prompt) => prompt),
  },
}));
const {
  grepCommand,
  grepAllSlashCommands,
  isReservedCommand,
  chatPrompt,
} = require("../../../utils/chats");
const { SlashCommandPresets } = require("../../../models/slashCommandsPresets");
const { promptWithMemories } = require("../../../utils/memories");
const {
  SystemPromptVariables,
} = require("../../../models/systemPromptVariables");
beforeEach(() => {
  jest.clearAllMocks();
  SlashCommandPresets.getUserPresets.mockResolvedValue([
    { command: "/weather", prompt: "the weather" },
    { command: "/time", prompt: "the time" },
    { command: "/reset-all", prompt: "reset all" },
  ]);
  SlashCommandPresets.where.mockResolvedValue([
    { command: "/weather", prompt: "the weather" },
  ]);
});
test.each([
  ["/reset", "/reset"],
  ["/RESET now", "/reset"],
  ["/reset?", "/reset"],
  ["/img a cat", "/img"],
  ["/resetall", "/resetall"],
  ["/imgs hello", "/imgs hello"],
  ["hello there", "hello there"],
  ["/reset-all", "reset all"],
  ["/weather", "the weather"],
  ["ok, /weather", "ok, the weather"],
  ["/weather?", "the weather?"],
  ["/weatherman", "/weatherman"],
  ["foo/weather", "foo/weather"],
  ["/weather and /time", "the weather and the time"],
])("command %s preserves original matching", async (input, expected) =>
  expect(await grepCommand(input, ctx)).toBe(expected)
);
test("presets always use the actual execution identity", async () => {
  await grepCommand("hello", ctx);
  expect(SlashCommandPresets.getUserPresets).toHaveBeenCalledWith(
    ctx,
    undefined
  );
  expect(await grepCommand("/weather")).toBe("/weather");
});
test.each([
  ["/reset", true],
  ["/RESET", true],
  ["/img", true],
  ["/Img", true],
  ["/reset-all", false],
  ["/resetall", false],
  ["/img-gen", false],
  ["/imgs", false],
  ["/weather", false],
  ["", false],
])("reserved command %s", (command, result) =>
  expect(isReservedCommand(command)).toBe(result)
);
test("API preset expansion has the same personal scope", async () => {
  expect(await grepAllSlashCommands("ok, /weather?", ctx)).toBe(
    "ok, the weather?"
  );
  expect(SlashCommandPresets.where).toHaveBeenCalledWith(ctx, {});
});
test("API expansion keeps command boundaries", async () =>
  expect(await grepAllSlashCommands("/weatherman", ctx)).toBe("/weatherman"));
test("prompt variables and memories resolve the tenant user without Workspace ownership", async () => {
  await chatPrompt({ openAiPrompt: "Company prompt" }, ctx, {
    prompt: "Question",
  });
  expect(
    SystemPromptVariables.expandSystemPromptVariables
  ).toHaveBeenCalledWith("Company prompt", ctx.userId, {
    tenantId: ctx.tenantId,
  });
  expect(promptWithMemories).toHaveBeenCalledWith(
    expect.objectContaining({ ctx, prompt: "Question" })
  );
});
test.each([
  null,
  { identity: "embed", tenantId: "company-a", userId: "anonymous" },
  "visitor",
])("anonymous context never loads personal memories", async (identity) => {
  expect(await chatPrompt({ openAiPrompt: "Prompt" }, identity)).toBe("Prompt");
  expect(promptWithMemories).not.toHaveBeenCalled();
});
test("stateless API can skip memories and a preexpanded prompt is not expanded twice", async () => {
  await chatPrompt({ openAiPrompt: "Already expanded {literal}" }, ctx, {
    skipMemories: true,
    variablesExpanded: true,
  });
  expect(promptWithMemories).not.toHaveBeenCalled();
  expect(
    SystemPromptVariables.expandSystemPromptVariables
  ).not.toHaveBeenCalled();
});
