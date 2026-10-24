jest.mock("../../utils/prisma", () => ({
  memories: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  },
}));

const prisma = require("../../utils/prisma");
const { Memory } = require("../../models/memory");
const ctx = { identity: "tenant", tenantId: "company-a", userId: "user-a" };
const scope = { tenantId: ctx.tenantId, userId: ctx.userId };

beforeEach(() => {
  jest.resetAllMocks();
  prisma.memories.findMany.mockResolvedValue([]);
  prisma.memories.findFirst.mockResolvedValue(null);
  prisma.memories.count.mockResolvedValue(0);
  prisma.memories.create.mockImplementation(async ({ data }) => ({
    id: 1,
    ...data,
  }));
  prisma.memories.updateMany.mockResolvedValue({ count: 1 });
  prisma.memories.deleteMany.mockResolvedValue({ count: 1 });
});

// Workspace/global destinations are now one personal memory resource. Their
// original content, capacity, deduplication and CRUD assertions remain here;
// promote/demote and single-user migration have no destination in this model.
describe("Memory.validations", () => {
  it.each([1, "5"])("accepts a valid integer memory ID: %p", (id) => {
    expect(Memory.validations.id(id)).toBe(Number(id));
  });

  it.each(["abc", 1.5, 0, -1, null, undefined, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid memory ID before a database query: %p",
    (id) => {
      expect(() => Memory.get(ctx, id)).toThrow("Memory not found.");
      expect(prisma.memories.findFirst).not.toHaveBeenCalled();
    }
  );

  it("accepts content and trims leading and trailing whitespace", () => {
    expect(Memory.validations.content("hello")).toBe("hello");
    expect(Memory.validations.content("  hello  ")).toBe("hello");
  });

  it.each(["", "   ", 123, null, undefined])(
    "rejects empty or non-string content: %p",
    (content) =>
      expect(() => Memory.validations.content(content)).toThrow(
        "Content must be a non-empty string"
      )
  );

  it.each([
    undefined,
    {},
    { ...ctx, userId: null },
    { ...ctx, userId: 1 },
    { ...ctx, tenantId: "" },
    { ...ctx, identity: "platform" },
  ])(
    "requires a tenant user identity instead of numeric/nullable Workspace ownership: %p",
    async (identity) => {
      expect(() => Memory.forUser(identity)).toThrow();
      await expect(
        Memory.create(identity, { content: "private fact" })
      ).rejects.toMatchObject({ status: 401 });
      expect(prisma.memories.findMany).not.toHaveBeenCalled();
      expect(prisma.memories.count).not.toHaveBeenCalled();
    }
  );
});

describe("Memory.forUser", () => {
  it("lists the current user's long-term memories newest first", async () => {
    const memories = [{ id: 2 }, { id: 1 }];
    prisma.memories.findMany.mockResolvedValue(memories);
    expect(await Memory.forUser(ctx)).toEqual(memories);
    expect(prisma.memories.findMany).toHaveBeenCalledWith({
      where: scope,
      orderBy: { createdAt: "desc" },
    });
  });

  it("propagates query failures to the endpoint instead of reporting an empty successful list", async () => {
    prisma.memories.findMany.mockRejectedValue(new Error("db error"));
    await expect(Memory.forUser(ctx)).rejects.toThrow("db error");
  });
});

describe("Memory.create", () => {
  it("creates a memory below the original personal limit and ignores payload ownership", async () => {
    const result = await Memory.create(ctx, {
      content: "  test  ",
      tenantId: "company-b",
      userId: "someone-else",
    });
    expect(result).toEqual({
      memory: { id: 1, ...scope, content: "test" },
      message: null,
    });
    expect(prisma.memories.count).toHaveBeenCalledWith({ where: scope });
    expect(prisma.memories.create).toHaveBeenCalledWith({
      data: { ...scope, content: "test" },
    });
  });

  it("rejects creation at the personal limit", async () => {
    prisma.memories.count.mockResolvedValue(Memory.PERSONAL_LIMIT);
    const result = await Memory.create(ctx, { content: "test" });
    expect(result.memory).toBeNull();
    expect(result.message).toMatch(/limit/i);
    expect(prisma.memories.create).not.toHaveBeenCalled();
  });

  it("rejects empty content before writing", async () => {
    await expect(Memory.create(ctx, { content: " " })).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.memories.create).not.toHaveBeenCalled();
  });

  it("propagates database errors to the endpoint", async () => {
    prisma.memories.create.mockRejectedValue(new Error("unique constraint"));
    await expect(Memory.create(ctx, { content: "test" })).rejects.toThrow(
      "unique constraint"
    );
  });
});

describe("Memory.update", () => {
  it("updates content by ID only inside the current user's tenant", async () => {
    const updated = { id: 1, ...scope, content: "new content" };
    prisma.memories.findFirst.mockResolvedValue(updated);
    expect(await Memory.update(ctx, 1, { content: "new content" })).toEqual({
      memory: updated,
      message: null,
    });
    expect(prisma.memories.updateMany).toHaveBeenCalledWith({
      where: { id: 1, ...scope },
      data: { content: "new content", updatedAt: expect.any(Date) },
    });
    expect(prisma.memories.findFirst).toHaveBeenCalledWith({
      where: { id: 1, ...scope },
    });
  });

  it("does not return a memory that belongs to another user or tenant", async () => {
    prisma.memories.updateMany.mockResolvedValue({ count: 0 });
    expect(await Memory.update(ctx, 999, { content: "attempt" })).toEqual({
      memory: null,
      message: "Memory not found.",
    });
    expect(prisma.memories.findFirst).not.toHaveBeenCalled();
  });

  it("rejects invalid content before modifying the database", async () => {
    await expect(Memory.update(ctx, 1, { content: "" })).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.memories.updateMany).not.toHaveBeenCalled();
  });

  it("propagates database failures", async () => {
    prisma.memories.updateMany.mockRejectedValue(new Error("db error"));
    await expect(Memory.update(ctx, 1, { content: "test" })).rejects.toThrow(
      "db error"
    );
  });
});

describe("Memory.delete", () => {
  it("returns true only after deleting an owned memory", async () => {
    expect(await Memory.delete(ctx, 1)).toBe(true);
    expect(prisma.memories.deleteMany).toHaveBeenCalledWith({
      where: { id: 1, ...scope },
    });
  });

  it("returns false for a missing or inaccessible memory", async () => {
    prisma.memories.deleteMany.mockResolvedValue({ count: 0 });
    expect(await Memory.delete(ctx, 999)).toBe(false);
  });

  it("propagates database failures", async () => {
    prisma.memories.deleteMany.mockRejectedValue(new Error("db error"));
    await expect(Memory.delete(ctx, 1)).rejects.toThrow("db error");
  });
});

describe("Memory.updateLastUsed", () => {
  it("updates the original last-use timestamps within the current owner scope", async () => {
    await Memory.updateLastUsed(ctx, [1, "2"]);
    expect(prisma.memories.updateMany).toHaveBeenCalledWith({
      where: { ...scope, id: { in: [1, 2] } },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("does nothing for an empty or omitted list", async () => {
    await Memory.updateLastUsed(ctx, []);
    await Memory.updateLastUsed(ctx);
    expect(prisma.memories.updateMany).not.toHaveBeenCalled();
  });

  it("does not write a partially valid set of IDs", async () => {
    await expect(
      Memory.updateLastUsed(ctx, [1, "invalid"])
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.memories.updateMany).not.toHaveBeenCalled();
  });
});

describe("Memory.applyExtractedMemories", () => {
  it("stores Observer/Reflector results in the same personal resource", async () => {
    const result = await Memory.applyExtractedMemories(ctx, [
      { content: "first fact", action: "create" },
      { content: "second fact", action: "create" },
    ]);
    expect(result).toEqual({ createdCount: 2, updatedCount: 0 });
    expect(prisma.memories.create).toHaveBeenCalledTimes(2);
    expect(prisma.memories.create).toHaveBeenNthCalledWith(1, {
      data: { ...scope, content: "first fact" },
    });
  });

  it("deduplicates normalized content without querying another user's memories", async () => {
    prisma.memories.findFirst
      .mockResolvedValueOnce({ id: 1, content: "known fact" })
      .mockResolvedValueOnce(null);
    const result = await Memory.applyExtractedMemories(ctx, [
      { content: "  known fact  ", action: "create" },
      { content: "new fact", action: "create" },
    ]);
    expect(result.createdCount).toBe(1);
    expect(prisma.memories.findFirst).toHaveBeenNthCalledWith(1, {
      where: { ...scope, content: "known fact" },
    });
    expect(prisma.memories.create).toHaveBeenCalledWith({
      data: { ...scope, content: "new fact" },
    });
  });

  it("deduplicates repeated entries within an extraction batch", async () => {
    prisma.memories.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1, content: "same fact" });
    expect(
      await Memory.applyExtractedMemories(ctx, [
        { content: "same fact", action: "create" },
        { content: "same fact", action: "create" },
      ])
    ).toEqual({ createdCount: 1, updatedCount: 0 });
    expect(prisma.memories.create).toHaveBeenCalledTimes(1);
  });

  it("scopes an extracted update to the current tenant user", async () => {
    prisma.memories.findFirst.mockResolvedValue({
      id: 10,
      content: "revised",
      ...scope,
    });
    const result = await Memory.applyExtractedMemories(ctx, [
      { content: "revised", action: "update", updateId: 10 },
    ]);
    expect(result.updatedCount).toBe(1);
    expect(prisma.memories.updateMany).toHaveBeenCalledWith({
      where: { id: 10, ...scope },
      data: expect.objectContaining({ content: "revised" }),
    });
  });

  it("does not count an extracted update when the memory belongs to another owner", async () => {
    prisma.memories.updateMany.mockResolvedValue({ count: 0 });
    const result = await Memory.applyExtractedMemories(ctx, [
      { content: "attacker replacement", action: "update", updateId: 1 },
    ]);
    expect(result.updatedCount).toBe(0);
    expect(prisma.memories.findFirst).not.toHaveBeenCalled();
  });

  it("skips updates without a safe numeric update ID", async () => {
    const result = await Memory.applyExtractedMemories(ctx, [
      { content: "missing", action: "update" },
      { content: "invalid", action: "update", updateId: "abc" },
      { content: "fractional", action: "update", updateId: 1.5 },
    ]);
    expect(result.updatedCount).toBe(0);
    expect(prisma.memories.updateMany).not.toHaveBeenCalled();
  });

  it("stops creating at the personal memory limit", async () => {
    prisma.memories.count
      .mockResolvedValueOnce(Memory.PERSONAL_LIMIT - 1)
      .mockResolvedValue(Memory.PERSONAL_LIMIT);
    const result = await Memory.applyExtractedMemories(ctx, [
      { content: "First fact", action: "create" },
      { content: "Second fact", action: "create" },
      { content: "Third fact", action: "create" },
    ]);
    expect(prisma.memories.create).toHaveBeenCalledTimes(1);
    expect(result.createdCount).toBe(1);
  });

  it("creates no memories when the personal limit is already reached", async () => {
    prisma.memories.count.mockResolvedValue(Memory.PERSONAL_LIMIT);
    expect(
      await Memory.applyExtractedMemories(ctx, [
        { content: "rejected", action: "create" },
      ])
    ).toEqual({ createdCount: 0, updatedCount: 0 });
    expect(prisma.memories.create).not.toHaveBeenCalled();
  });

  it("filters malformed entries without suppressing the remaining valid result", async () => {
    const result = await Memory.applyExtractedMemories(ctx, [
      null,
      { content: "", action: "create" },
      { content: "   ", action: "create" },
      { content: 123, action: "create" },
      { content: "not an operation", action: "unknown" },
      { action: "create" },
      { content: "good", action: "create" },
    ]);
    expect(result).toEqual({ createdCount: 1, updatedCount: 0 });
    expect(prisma.memories.create).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, "not an array", {}])(
    "handles non-array input: %p",
    async (input) => {
      expect(await Memory.applyExtractedMemories(ctx, input)).toEqual({
        createdCount: 0,
        updatedCount: 0,
      });
      expect(prisma.memories.create).not.toHaveBeenCalled();
      expect(prisma.memories.updateMany).not.toHaveBeenCalled();
    }
  );
});

describe("Memory.get", () => {
  it("returns the matching personal memory", async () => {
    const memory = { id: 1, content: "test", ...scope };
    prisma.memories.findFirst.mockResolvedValue(memory);
    expect(await Memory.get(ctx, "1")).toEqual(memory);
    expect(prisma.memories.findFirst).toHaveBeenCalledWith({
      where: { id: 1, ...scope },
    });
  });

  it("returns null for a missing or inaccessible memory", async () => {
    expect(await Memory.get(ctx, 999)).toBeNull();
  });

  it("propagates database failures", async () => {
    prisma.memories.findFirst.mockRejectedValue(new Error("db error"));
    await expect(Memory.get(ctx, 1)).rejects.toThrow("db error");
  });
});
