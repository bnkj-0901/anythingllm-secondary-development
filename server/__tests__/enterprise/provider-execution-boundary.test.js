const mockContext = jest.fn();
const mockRefresh = jest.fn();
const mockStore = { one: jest.fn() };
jest.mock("../../enterprise/store", () => mockStore);
jest.mock("../../enterprise/auth", () => ({
  context: (...args) => mockContext(...args),
  refreshContext: (...args) => mockRefresh(...args),
  fail: (status, message) => Object.assign(new Error(message), { status }),
}));
const providers = require("../../enterprise/providers");
const runtime = require("../../enterprise/ai/runtime");
const execution = require("../../enterprise/execution-context");
const previous = {
  SIG_KEY: process.env.SIG_KEY,
  SIG_SALT: process.env.SIG_SALT,
};
const employee = {
  identity: "tenant",
  tenantId: "company-a",
  userId: 101,
  authVersion: 3,
};
const row = (changes = {}) => ({
  id: "saved-model",
  kind: "embedding",
  provider: "openai-compatible",
  version: 2,
  available: true,
  model: "embedding-model",
  baseUrl: "https://provider.example/v1",
  secret: providers.encrypt(JSON.stringify({ apiKey: "private-test-token" })),
  options: "{}",
  ...changes,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SIG_KEY = "isolated-provider-test-key";
  process.env.SIG_SALT = "isolated-provider-test-salt";
  mockContext.mockResolvedValue(employee);
  mockRefresh.mockImplementation(async (value) => value);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("background identity rejects incomplete pairs, changed tenant and revoked session versions", async () => {
  for (const value of [
    undefined,
    {},
    { tenantId: "company-a" },
    { userId: 101 },
  ])
    await expect(execution.loadExecutionContext(value)).rejects.toMatchObject({
      status: 401,
    });
  await expect(
    execution.loadExecutionContext({ tenantId: "other-company", userId: 101 })
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    execution.loadExecutionContext({ ...employee, authVersion: 2 })
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    execution.loadExecutionContext({ ...employee, authVersion: 3 })
  ).resolves.toEqual(employee);
});

test("concurrent and nested executions isolate identities and clean up after failed work", async () => {
  expect(execution.optionalExecutionContext()).toBeNull();
  expect(() => execution.executionContext()).toThrow();
  const peer = { ...employee, userId: 102 };
  const top = {
    identity: "platform",
    userId: "operator",
    role: "platform_admin",
  };
  await Promise.all(
    [employee, peer].map((identity) =>
      execution.runExecution(identity, async (current) => {
        await new Promise((resolve) => setImmediate(resolve));
        expect(execution.executionContext().userId).toBe(identity.userId);
        expect(Object.isFrozen(current)).toBe(true);
        await execution.runExecution(top, async () =>
          expect(execution.executionContext().userId).toBe("operator")
        );
        expect(execution.executionContext().userId).toBe(identity.userId);
      })
    )
  );
  await expect(
    execution.runExecution(
      { tenantId: employee.tenantId, userId: employee.userId },
      async () => {
        throw new Error("tool failed");
      }
    )
  ).rejects.toThrow("tool failed");
  expect(execution.optionalExecutionContext()).toBeNull();
});

test("encrypted credentials round-trip legacy and structured records without sharing mutable configuration", () => {
  expect(providers.encrypt("")).toBeNull();
  expect(providers.decrypt(null)).toBe("");
  const legacy = providers.hydrate(
    row({
      secret: providers.encrypt("legacy-private-token"),
      options: { maxChunkLength: 512 },
    })
  );
  expect(legacy.config.apiKey).toBe("legacy-private-token");
  expect(Object.isFrozen(legacy.config.options)).toBe(true);
  const structured = providers.hydrate(
    row({
      secret: providers.encrypt(
        JSON.stringify({
          headers: { "x-provider-key": "header-token" },
          upstreamEnvironment: { OPEN_MODEL_PREF: "alternate" },
        })
      ),
    })
  );
  expect(structured.config.apiKey).toBe("");
  expect(structured.config.headers["x-provider-key"]).toBe("header-token");
  expect(structured.config.upstreamEnvironment).toEqual({
    OPEN_MODEL_PREF: "alternate",
  });
  for (const value of ["null", "[]", "42"])
    expect(
      providers.hydrate(
        row({ secret: providers.encrypt(value), options: null })
      ).config.apiKey
    ).toBe(value);
  expect(providers.connectionIdentity(legacy)).toBe("saved-model:2");
});

test.each([
  { secret: "corrupted-private-test-token" },
  { options: "{broken-private-test-token" },
  { options: [] },
  { options: "null" },
  { options: "17" },
])(
  "damaged saved configuration %j exposes only a safe administrator action",
  (changes) => {
    expect(() => providers.hydrate(row(changes))).toThrow(
      "保存的模型配置无法读取"
    );
    try {
      providers.hydrate(row(changes));
    } catch (error) {
      expect(error.status).toBe(503);
      expect(error.message).not.toContain("private-test-token");
    }
  }
);

test("missing encryption settings fail closed without echoing credentials", () => {
  for (const field of ["SIG_KEY", "SIG_SALT"]) {
    const saved = process.env[field];
    delete process.env[field];
    expect(() => providers.encrypt("private-test-token")).toThrow(
      "服务加密密钥未配置"
    );
    process.env[field] = saved;
  }
});

test("default connection resolution rejects missing or disabled connections and prepares only chat", async () => {
  mockStore.one.mockResolvedValue(null);
  for (const kind of ["chat", "embedding"])
    await expect(
      providers.resolveConnection(employee, kind)
    ).rejects.toMatchObject({ status: 422 });
  mockStore.one.mockResolvedValue(row({ available: false }));
  await expect(
    providers.resolveConnection(employee, "embedding")
  ).rejects.toMatchObject({ status: 422 });
  mockStore.one.mockResolvedValue(row());
  const prepared = jest
    .spyOn(runtime, "prepareChatConnection")
    .mockResolvedValue({ id: "prepared-chat" });
  await expect(
    providers.resolveConnection(employee, "embedding")
  ).resolves.toMatchObject({ id: "saved-model" });
  expect(prepared).not.toHaveBeenCalled();
  mockStore.one.mockResolvedValue(row({ kind: "chat" }));
  const options = { ctx: employee, model: "selected-model" };
  await expect(
    providers.resolveConnection(employee, "chat", options)
  ).resolves.toEqual({ id: "prepared-chat" });
  expect(prepared).toHaveBeenCalledWith(
    expect.objectContaining({ id: "saved-model" }),
    options
  );
});

test("invalid embedding input and empty work never invoke the upstream adapter", async () => {
  const adapter = jest.spyOn(runtime, "embed");
  for (const texts of ["text", null, ["text", 4]])
    await expect(providers.embed({}, texts)).rejects.toMatchObject({
      status: 400,
    });
  await expect(providers.embed({}, [])).resolves.toEqual([]);
  expect(adapter).not.toHaveBeenCalled();
});

test.each([
  null,
  [[1]],
  ["not-a-vector", "not-a-vector"],
  [[], [1]],
  [[NaN], [1]],
  [
    [0, 0],
    [1, 2],
  ],
  [[1], [1, 2]],
])(
  "malformed embedding result %j cannot enter the knowledge index",
  async (vectors) => {
    jest.spyOn(runtime, "embed").mockResolvedValue(vectors);
    await expect(
      providers.embed({}, ["first", "second"])
    ).rejects.toMatchObject({
      status: 502,
      message: "Embedding 服务返回的向量无效",
    });
  }
);

test("valid finite embedding vectors retain the original adapter result", async () => {
  const vectors = [
    [1, 0.5],
    [-0.25, 1],
  ];
  jest.spyOn(runtime, "embed").mockResolvedValue(vectors);
  await expect(providers.embed({}, ["first", "second"])).resolves.toBe(vectors);
});
