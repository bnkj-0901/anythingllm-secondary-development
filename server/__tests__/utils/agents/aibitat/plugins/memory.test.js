/* eslint-env jest */
jest.mock("../../../../../enterprise/execution-context", () => ({
  loadExecutionContext: jest.fn(async (ctx) => ctx),
}));
jest.mock("../../../../../utils/prisma", () => ({
  ep_libraries: { findMany: jest.fn() },
}));
jest.mock("../../../../../models/documents", () => ({
  Document: {
    libraryScope: jest.fn(() => ({ grants: { some: { userId: 1 } } })),
  },
}));
jest.mock("../../../../../enterprise/knowledge", () => ({
  submitText: jest.fn(),
}));
const prisma = require("../../../../../utils/prisma");
const { submitText } = require("../../../../../enterprise/knowledge");
const {
  loadExecutionContext,
} = require("../../../../../enterprise/execution-context");
const {
  memory,
} = require("../../../../../utils/agents/aibitat/plugins/memory");
const identity = { identity: "tenant", tenantId: "company", userId: 1 };

function setup() {
  let tool;
  const aibitat = {
    handlerProps: { ctx: identity, log: jest.fn() },
    introspect: jest.fn(),
    function(value) {
      tool = value;
    },
  };
  memory.plugin().setup(aibitat);
  return tool;
}

beforeEach(() => {
  jest.clearAllMocks();
  loadExecutionContext.mockResolvedValue(identity);
  submitText.mockResolvedValue({ approvalRequired: false });
});

test("store selects the sole authorized private library and uses the normal knowledge pipeline", async () => {
  prisma.ep_libraries.findMany.mockResolvedValue([{ id: "private" }]);
  expect(await setup().store("Remember this")).toContain(
    "after indexing completes"
  );
  expect(prisma.ep_libraries.findMany).toHaveBeenCalledWith({
    where: {
      AND: [
        { grants: { some: { userId: 1 } } },
        { grants: { none: { tenantId: { not: null } } } },
      ],
    },
    take: 2,
  });
  expect(submitText).toHaveBeenCalledWith(
    identity,
    expect.objectContaining({
      libraryId: "private",
      title: "agent-memory.txt",
      content: "Remember this",
    })
  );
});

test.each([{ libraries: [] }, { libraries: [{ id: "one" }, { id: "two" }] }])(
  "ambiguous store destinations request a library without creating hidden storage",
  async ({ libraries }) => {
    prisma.ep_libraries.findMany.mockResolvedValue(libraries);
    expect(await setup().store("Remember this")).toContain(
      "choose an authorized knowledge library"
    );
    expect(submitText).not.toHaveBeenCalled();
  }
);

test("explicit public destination preserves administrator approval and does not claim searchable content", async () => {
  submitText.mockResolvedValue({ approvalRequired: true });
  expect(await setup().store("Proposed shared fact", "public")).toBe(
    "The knowledge change awaits administrator approval and is not searchable yet."
  );
  expect(prisma.ep_libraries.findMany).not.toHaveBeenCalled();
  expect(submitText).toHaveBeenCalledWith(
    identity,
    expect.objectContaining({ libraryId: "public" })
  );
});

test("a revoked execution identity cannot save content", async () => {
  loadExecutionContext.mockRejectedValue(new Error("Account revoked"));
  expect(await setup().store("Do not persist", "private")).toContain(
    "not successful"
  );
  expect(submitText).not.toHaveBeenCalled();
});
