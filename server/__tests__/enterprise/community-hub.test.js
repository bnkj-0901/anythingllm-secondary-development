const express = require("express");
const http = require("http");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
let mockFixture;
const mockStore = Object.fromEntries(
  ["all", "one", "run", "transaction", "id", "now"].map((key) => [
    key,
    (...args) => mockFixture.db[key](...args),
  ])
);
Object.defineProperty(mockStore, "orm", { get: () => mockFixture.prisma });
jest.mock("../../enterprise/store", () => mockStore);
jest.mock(
  "../../utils/prisma",
  () =>
    new Proxy(
      {},
      {
        get(_target, key) {
          const value = mockFixture.prisma[key];
          return typeof value === "function"
            ? value.bind(mockFixture.prisma)
            : value;
        },
      }
    )
);
jest.mock("../../utils/agents/imported", () => ({
  importCommunityItemFromUrl: jest.fn(),
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
const auth = require("../../enterprise/auth");
const { CommunityHub } = require("../../models/communityHub");
const { communityHubEndpoints } = require("../../endpoints/communityHub");
const { getSettings } = require("../../enterprise/rag-settings");
const { SlashCommandPresets } = require("../../models/slashCommandsPresets");
let listener, endpoint, top, oldSecret, oldHosts;

beforeAll(async () => {
  oldSecret = process.env.JWT_SECRET;
  oldHosts = process.env.PLATFORM_HOSTS;
  process.env.JWT_SECRET = "community-hub-isolated-test-secret";
  process.env.PLATFORM_HOSTS = "localhost";
  mockFixture = await createPostgresFixture();
  const stamp = new Date().toISOString();
  await mockFixture.prisma.ep_platform_accounts.create({
    data: {
      id: "platform",
      username: "operator",
      name: "Top",
      passwordHash: "unused",
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  for (const id of ["a", "b"])
    await mockFixture.prisma.ep_tenants.create({
      data: {
        id,
        code: `hub-${id}`,
        name: String(id),
        hostname: `hub-${id}.localhost`,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  for (const [id, tenantId] of [
    [101, "a"],
    [102, "a"],
    [103, "b"],
  ])
    await mockFixture.prisma.users.create({
      data: {
        id,
        tenantId,
        username: String(id),
        name: String(id),
        passwordHash: "unused",
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  top = await auth.platformContext("platform");
  const app = express();
  app.use(express.json({ type: ["application/json", "text/plain"] }));
  const router = express.Router();
  router.use(auth.requirePlatformAuth);
  communityHubEndpoints(router);
  app.use("/api", router);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  endpoint = `http://127.0.0.1:${listener.address().port}`;
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (listener)
    await new Promise((resolve) => {
      listener.close(resolve);
      listener.closeAllConnections();
    });
  await mockFixture?.cleanup();
  if (oldSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = oldSecret;
  if (oldHosts === undefined) delete process.env.PLATFORM_HOSTS;
  else process.env.PLATFORM_HOSTS = oldHosts;
});
function apply(item, options = {}) {
  return CommunityHub.applyItem(item, { currentContext: top, ...options });
}
async function request(path, { ctx = top, body, host = "localhost" } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      endpoint + "/api" + path,
      {
        method: body ? "POST" : "GET",
        headers: {
          host,
          "content-type": "text/plain",
          ...(ctx ? { authorization: `Bearer ${auth.signed(ctx).token}` } : {}),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (data += chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode, body: JSON.parse(data) })
        );
      }
    );
    outgoing.on("error", reject);
    if (body) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

test("a system prompt replaces only the selected tenant prompt and preserves settings/history", async () => {
  await mockFixture.db.run(
    'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3)',
    "a",
    JSON.stringify({ topK: 9, chunkSize: 1200, openAiPrompt: "Old prompt" }),
    mockFixture.db.now()
  );
  expect(
    await apply(
      { itemType: "system-prompt", prompt: "New prompt" },
      { tenantId: "a" }
    )
  ).toEqual({ success: true, error: null });
  expect(await getSettings("a")).toMatchObject({
    openAiPrompt: "New prompt",
    topK: 9,
    chunkSize: 1200,
  });
  expect((await getSettings("b")).openAiPrompt).toBeNull();
  expect(await mockFixture.prisma.prompt_history.findMany()).toMatchObject([
    { tenantId: "a", prompt: "Old prompt", modifiedBy: "platform" },
  ]);
});

test("slash command imports belong to the selected enterprise user and retain original normalization", async () => {
  const item = {
    itemType: "slash-command",
    command: "/Make Report",
    prompt: "Owner prompt",
    description: "Report",
  };
  expect(await apply(item, { tenantId: "a", userId: 101 })).toMatchObject({
    success: true,
  });
  const owner = await auth.context(101),
    peer = await auth.context(102);
  expect(await SlashCommandPresets.getUserPresets(owner)).toMatchObject([
    { command: "/make-report", prompt: "Owner prompt" },
  ]);
  expect(await SlashCommandPresets.getUserPresets(peer)).toEqual([]);
  await apply(
    { ...item, prompt: "Peer prompt" },
    { tenantId: "a", userId: 102 }
  );
  expect(await SlashCommandPresets.getUserPresets(owner)).toMatchObject([
    { prompt: "Owner prompt" },
  ]);
  expect(await SlashCommandPresets.getUserPresets(peer)).toMatchObject([
    { prompt: "Peer prompt" },
  ]);
});

test("missing destinations, mismatched companies and reserved commands cannot create presets", async () => {
  const item = { itemType: "slash-command", command: "/denied", prompt: "No" };
  expect(await apply(item)).toMatchObject({ success: false });
  await expect(apply(item, { tenantId: "a", userId: 103 })).rejects.toThrow(
    "selected tenant"
  );
  expect(
    await apply({ ...item, command: "/reset" }, { tenantId: "a", userId: 101 })
  ).toMatchObject({ success: false });
  expect(
    await mockFixture.prisma.slash_command_presets.count({
      where: { command: "/denied" },
    })
  ).toBe(0);
  expect(
    await apply({ itemType: "system-prompt", prompt: "No" })
  ).toMatchObject({ success: false });
  await expect(
    apply({ itemType: "system-prompt", prompt: "No" }, { tenantId: "missing" })
  ).rejects.toThrow("Tenant not found");
});

test("imports recheck active target users and the top administrator inside the transaction", async () => {
  await mockFixture.prisma.users.update({
    where: { id: 101 },
    data: { status: "disabled" },
  });
  await expect(
    apply(
      { itemType: "slash-command", command: "/inactive", prompt: "No" },
      { tenantId: "a", userId: 101 }
    )
  ).rejects.toMatchObject({ status: 401 });
  await mockFixture.prisma.users.update({
    where: { id: 101 },
    data: { status: "active" },
  });
  await mockFixture.prisma.ep_platform_accounts.update({
    where: { id: "platform" },
    data: { authVersion: 2 },
  });
  await expect(
    apply({ itemType: "system-prompt", prompt: "No" }, { tenantId: "a" })
  ).rejects.toMatchObject({ status: 401 });
  await mockFixture.prisma.ep_platform_accounts.update({
    where: { id: "platform" },
    data: { authVersion: 1 },
  });
});

test("enterprise users cannot bypass platform ownership by calling the original Hub routes", async () => {
  const explore = jest
    .spyOn(CommunityHub, "fetchExploreItems")
    .mockResolvedValue({ systemPrompts: { items: [] } });
  expect((await request("/community-hub/explore", { ctx: null })).status).toBe(
    401
  );
  expect(
    (
      await request("/community-hub/explore", {
        ctx: await auth.context(101),
        host: "hub-a.localhost",
      })
    ).status
  ).toBe(401);
  expect(explore).not.toHaveBeenCalled();
  expect(await request("/community-hub/explore")).toEqual({
    status: 200,
    body: { success: true, result: { systemPrompts: { items: [] } } },
  });
});

test("the original apply endpoint uses trusted authentication rather than a forged options context", async () => {
  jest.spyOn(CommunityHub, "getBundleItem").mockResolvedValue({
    item: {
      id: "hub-prompt",
      itemType: "system-prompt",
      prompt: "Via original route",
    },
  });
  const result = await request("/community-hub/apply", {
    body: {
      importId: "allm-community-id:system-prompt:fixture",
      options: {
        tenantId: "b",
        currentContext: { identity: "tenant", userId: 103 },
      },
    },
  });
  expect(result).toEqual({ status: 200, body: { success: true, error: null } });
  expect((await getSettings("b")).openAiPrompt).toBe("Via original route");
});

test("bundle imports preserve the original explicit download gate", async () => {
  const previous = process.env.COMMUNITY_HUB_BUNDLE_DOWNLOADS_ENABLED;
  delete process.env.COMMUNITY_HUB_BUNDLE_DOWNLOADS_ENABLED;
  try {
    jest.spyOn(CommunityHub, "getBundleItem").mockResolvedValue({
      url: "https://example.test/bundle.zip",
      item: { itemType: "agent-skill", verified: true },
    });
    const download = jest.spyOn(CommunityHub, "importBundleItem");
    expect(
      (
        await request("/community-hub/import", {
          body: { importId: "allm-community-id:agent-skill:fixture" },
        })
      ).status
    ).toBe(422);
    expect(download).not.toHaveBeenCalled();
  } finally {
    if (previous !== undefined)
      process.env.COMMUNITY_HUB_BUNDLE_DOWNLOADS_ENABLED = previous;
  }
});
