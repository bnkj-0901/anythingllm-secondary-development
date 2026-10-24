process.env.STORAGE_DIR = require("os").tmpdir();
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    saneDefaultSystemPrompt: "Shared default prompt",
    getValueOrFallback: jest.fn(),
    tenantBridge: (value) => value,
  },
}));
jest.mock("../../../enterprise/settings", () => ({ defaultPrompt: jest.fn() }));
jest.mock("../../../models/systemPromptVariables");
jest.mock("../../../utils/memories", () => ({
  promptWithMemories: jest.fn(async ({ systemPrompt }) => systemPrompt),
}));
jest.mock("../../../utils/agents/imported", () => ({
  activeImportedPlugins: jest.fn(() => []),
}));
jest.mock("../../../utils/agentFlows", () => ({
  AgentFlows: { activeFlowPlugins: jest.fn(() => []) },
}));
jest.mock("../../../utils/MCP", () =>
  jest
    .fn()
    .mockImplementation(() => ({ activeMCPServers: jest.fn(async () => []) }))
);
const { WORKSPACE_AGENT } = require("../../../utils/agents/defaults");
const { SystemSettings } = require("../../../models/systemSettings");
const {
  SystemPromptVariables,
} = require("../../../models/systemPromptVariables");
const { defaultPrompt } = require("../../../enterprise/settings");
const { promptWithMemories } = require("../../../utils/memories");
const ctx = { identity: "tenant", tenantId: "tenant-a", userId: "user-a" };
beforeEach(() => {
  jest.clearAllMocks();
  SystemSettings.getValueOrFallback.mockResolvedValue("[]");
  defaultPrompt.mockResolvedValue("Tenant default expanded prompt");
  SystemPromptVariables.expandSystemPromptVariables.mockImplementation(
    async (text) =>
      text
        .replace("{datetime}", "January 1, 2024 12:00 PM")
        .replace("{user.name}", "John Doe")
  );
});
describe("Agent definition with tenant configuration and personal identity", () => {
  it("inherits the tenant default system prompt when no override is configured", async () => {
    const definition = await WORKSPACE_AGENT.getDefinition(
      "openai",
      { openAiPrompt: null },
      { id: ctx.userId },
      "",
      ctx
    );
    expect(defaultPrompt).toHaveBeenCalledWith(ctx);
    expect(definition.role).toBe("Tenant default expanded prompt");
    expect(promptWithMemories).toHaveBeenCalledWith({
      systemPrompt: definition.role,
      ctx,
      prompt: "",
    });
  });
  it("expands a configured prompt against the current tenant user", async () => {
    const configuration = {
      openAiPrompt: "You help {user.name} at {datetime}",
    };
    const definition = await WORKSPACE_AGENT.getDefinition(
      "openai",
      configuration,
      { id: ctx.userId },
      "Prepare report",
      ctx
    );
    expect(
      SystemPromptVariables.expandSystemPromptVariables
    ).toHaveBeenCalledWith(configuration.openAiPrompt, ctx.userId, {
      tenantId: ctx.tenantId,
    });
    expect(definition.role).toBe(
      "You help John Doe at January 1, 2024 12:00 PM"
    );
    expect(promptWithMemories).toHaveBeenCalledWith({
      systemPrompt: definition.role,
      ctx,
      prompt: "Prepare report",
    });
  });
  it("expands a configured prompt using its real identity when no redundant user object is supplied", async () => {
    const definition = await WORKSPACE_AGENT.getDefinition(
      "lmstudio",
      { openAiPrompt: "Today is {datetime}" },
      null,
      "",
      ctx
    );
    expect(definition.role).toBe("Today is January 1, 2024 12:00 PM");
    expect(
      SystemPromptVariables.expandSystemPromptVariables
    ).toHaveBeenCalledWith("Today is {datetime}", ctx.userId, {
      tenantId: ctx.tenantId,
    });
    expect(promptWithMemories).toHaveBeenCalledWith(
      expect.objectContaining({ ctx })
    );
  });
  it("keeps the original function list and scopes Flow/MCP discovery to execution identity", async () => {
    const definition = await WORKSPACE_AGENT.getDefinition(
      "openai",
      {},
      null,
      "",
      ctx
    );
    expect(Array.isArray(definition.functions)).toBe(true);
    expect(
      require("../../../utils/agentFlows").AgentFlows.activeFlowPlugins
    ).toHaveBeenCalledWith(ctx);
    expect(
      require("../../../utils/MCP").mock.results[0].value.activeMCPServers
    ).toHaveBeenCalledWith(ctx);
  });
  it("refuses to build an Agent definition without a real execution identity", async () => {
    await expect(
      WORKSPACE_AGENT.getDefinition("lmstudio", null, null)
    ).rejects.toMatchObject({ status: 401 });
    expect(defaultPrompt).not.toHaveBeenCalled();
    expect(promptWithMemories).not.toHaveBeenCalled();
  });
});
