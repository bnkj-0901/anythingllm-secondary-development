jest.mock("../../utils/prisma", () => ({
  system_prompt_variables: { findMany: jest.fn() },
  users: { findFirst: jest.fn() },
}));

const { SystemPromptVariables } = require("../../models/systemPromptVariables");
const prisma = require("../../utils/prisma");
const mockUser = {
  id: "196142dd-28d7-40e2-9248-3f74ab6104bb",
  tenantId: "tenant-a",
  username: "john.doe",
  name: "John Doe",
  bio: "Tenant A profile",
};
const scope = { tenantId: mockUser.tenantId };
const mockStaticVariable = {
  id: 1,
  key: "mystaticvariable",
  value: "AnythingLLM testing runtime",
  description: "A test variable",
  type: "static",
};
const expand = (prompt, options = scope) =>
  SystemPromptVariables.expandSystemPromptVariables(
    prompt,
    mockUser.id,
    options
  );

beforeEach(() => {
  jest.clearAllMocks();
  prisma.system_prompt_variables.findMany.mockResolvedValue([
    mockStaticVariable,
  ]);
  prisma.users.findFirst.mockResolvedValue(mockUser);
});

test("expands original static and date variables with current tenant user fields", async () => {
  const result = await expand(
    "{mystaticvariable} | {user.name} ({user.id}) | {datetime}"
  );
  expect(result).toContain(
    `${mockStaticVariable.value} | john.doe (${mockUser.id}) | `
  );
  expect(result).not.toContain("{datetime}");
  expect(prisma.users.findFirst).toHaveBeenCalledWith({
    where: { id: mockUser.id, tenantId: mockUser.tenantId },
    select: { username: true },
  });
});

test("UUID lookup stays inside its tenant and retains the original username meaning", async () => {
  prisma.users.findFirst.mockImplementation(async ({ where }) =>
    where.tenantId === mockUser.tenantId ? mockUser : null
  );
  expect(await expand("{user.name}")).toBe(mockUser.username);
  expect(await expand("{user.name}", { tenantId: "tenant-b" })).toBe(
    "[User name is empty or unknown]"
  );
});

test.each([undefined, null, {}, 123])(
  "missing tenant scope %p never looks up global user data",
  async (options) => {
    const result = await SystemPromptVariables.expandSystemPromptVariables(
      "{user.name} | {mystaticvariable}",
      mockUser.id,
      options
    );
    expect(result).toBe(`[User name] | ${mockStaticVariable.value}`);
    expect(prisma.users.findFirst).not.toHaveBeenCalled();
  }
);

test("Workspace variables are absent while the original bio resolves only inside its tenant", async () => {
  expect(SystemPromptVariables.VALID_TYPES).not.toContain("workspace");
  const variables = await SystemPromptVariables.getAll(mockUser.id);
  expect(variables.map((variable) => variable.key)).not.toEqual(
    expect.arrayContaining(["workspace.id", "workspace.name"])
  );
  expect(await expand("{workspace.id} | {workspace.name} | {user.bio}")).toBe(
    "{workspace.id} | {workspace.name} | Tenant A profile"
  );
  expect(prisma.users.findFirst).toHaveBeenCalledWith({
    where: { id: mockUser.id, tenantId: mockUser.tenantId },
    select: { bio: true },
  });
  prisma.users.findFirst.mockResolvedValueOnce(null);
  expect(await expand("{user.bio}", { tenantId: "tenant-b" })).toBe(
    "[User bio is empty]"
  );
  prisma.users.findFirst.mockClear();
  expect(await expand("{user.bio}", {})).toBe("[User bio]");
  expect(prisma.users.findFirst).not.toHaveBeenCalled();
});

test("unknown fields preserve the original placeholders and static variables still work without a user", async () => {
  expect(
    await SystemPromptVariables.expandSystemPromptVariables(
      "{invalid.variable} {user.password} {user.name} {user.id} {mystaticvariable}"
    )
  ).toBe(
    `{invalid.variable} [User password] [User name] [User id] ${mockStaticVariable.value}`
  );
});

test.each(["cost is $$5 and matched $& here", "before $` after $'"])(
  "preserves String.replace special characters in static values: %s",
  async (value) => {
    prisma.system_prompt_variables.findMany.mockResolvedValue([
      { ...mockStaticVariable, value },
    ]);
    expect(await expand("X {mystaticvariable} Y")).toBe(`X ${value} Y`);
  }
);

test("preserves dollar replacement specials in usernames", async () => {
  prisma.users.findFirst.mockResolvedValue({
    ...mockUser,
    username: "$$ $& $` $' John",
  });
  expect(await expand("{user.name}")).toBe("$$ $& $` $' John");
});

test("does not expand placeholders inside inserted user values", async () => {
  prisma.users.findFirst.mockResolvedValue({
    ...mockUser,
    username: "see {mystaticvariable}",
  });
  expect(await expand("{user.name} | {mystaticvariable}")).toBe(
    `see {mystaticvariable} | ${mockStaticVariable.value}`
  );
});

test("does not expand placeholders inside inserted static values", async () => {
  prisma.system_prompt_variables.findMany.mockResolvedValue([
    { ...mockStaticVariable, value: "Hi {user.name}" },
  ]);
  expect(await expand("{mystaticvariable} | {user.name}")).toBe(
    "Hi {user.name} | john.doe"
  );
});

test("resolves each repeated dynamic placeholder once", async () => {
  expect(await expand("{user.name} and {user.name}")).toBe(
    "john.doe and john.doe"
  );
  expect(prisma.users.findFirst).toHaveBeenCalledTimes(1);
});

test("self-references and unknown nested static placeholders do not recurse", async () => {
  prisma.users.findFirst.mockResolvedValue({
    ...mockUser,
    username: "x{user.name}",
  });
  prisma.system_prompt_variables.findMany.mockResolvedValue([
    { ...mockStaticVariable, value: "{unknownvariable}" },
  ]);
  expect(
    await expand("{user.name} {user.name} {mystaticvariable} {unknownvariable}")
  ).toBe("x{user.name} x{user.name} {unknownvariable} {unknownvariable}");
});

test("injected database delegates resolve static and user values together", async () => {
  const db = {
    system_prompt_variables: {
      findMany: jest.fn(async () => [
        { ...mockStaticVariable, value: "Scoped" },
      ]),
    },
    users: { findFirst: jest.fn(async () => ({ username: "scoped.user" })) },
  };
  expect(
    await expand("{mystaticvariable}: {user.name}", { ...scope, db })
  ).toBe("Scoped: scoped.user");
  expect(prisma.users.findFirst).not.toHaveBeenCalled();
  expect(prisma.system_prompt_variables.findMany).not.toHaveBeenCalled();
});

test("failed user lookup returns the original safe placeholder", async () => {
  prisma.users.findFirst.mockRejectedValueOnce(new Error("offline"));
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await expand("{user.name}")).toBe("[User name is empty or unknown]");
  } finally {
    log.mockRestore();
  }
});

test("empty prompts and missing database metadata retain the original prompt contract", async () => {
  expect(await expand("")).toBe("");
  expect(await expand(null)).toBeNull();
  prisma.system_prompt_variables.findMany.mockRejectedValueOnce(
    new Error("offline")
  );
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await expand("{user.name}")).toBe("{user.name}");
  } finally {
    log.mockRestore();
  }
});
