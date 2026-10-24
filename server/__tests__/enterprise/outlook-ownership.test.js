/* global jest, beforeAll, beforeEach, afterAll, test, expect */
const express = require("express");
const http = require("http");
const jwt = require("jsonwebtoken");
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
        get: (_target, key) => {
          const value = mockFixture.prisma[key];
          return typeof value === "function"
            ? value.bind(mockFixture.prisma)
            : value;
        },
      }
    )
);

const auth = require("../../enterprise/auth");
const { SystemSettings } = require("../../models/systemSettings");
const outlook = require("../../utils/agents/aibitat/plugins/outlook/lib");
const {
  outlookAgentEndpoints,
} = require("../../endpoints/utils/outlookAgentUtils");
const authorizationPath = "/api/admin/agent-skills/outlook/auth-url";
const callbackPath = "/api/agent-skills/outlook/auth-callback";
const audience = "outlook-enterprise-configuration";
const credentials = {
  clientId: "client-a",
  clientSecret: "secret-a",
  tenantId: "microsoft-directory-a",
  authType: "organization",
};
let listener, base, originalFetch, originalEnvironment;
const userIds = {
  "admin-a": 101,
  "user-a": 102,
  "admin-b": 103,
  "user-b": 104,
};
const environmentKeys = ["JWT_SECRET", "PLATFORM_HOSTS", "TENANT_BASE_DOMAIN"];

function request(
  path,
  { token, host = "localhost", method = "GET", body } = {}
) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          host,
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        let content = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (content += chunk));
        response.on("end", () => {
          let result = content;
          try {
            result = JSON.parse(content);
          } catch {}
          resolve({
            status: response.statusCode,
            body: result,
            location: response.headers.location,
          });
        });
        response.on("error", reject);
      }
    );
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

async function topToken() {
  return auth.signed(await auth.platformContext("platform")).token;
}

async function start(tenantId = "a", options = {}) {
  return request(
    `${authorizationPath}?tenantId=${encodeURIComponent(tenantId)}`,
    {
      token: await topToken(),
      method: "POST",
      body: credentials,
      ...options,
    }
  );
}

async function createState(tenantId = "a") {
  const response = await start(tenantId);
  expect(response.status).toBe(200);
  return new URL(response.body.url).searchParams.get("state");
}

function callback(state, { code = "authorized-a", ...options } = {}) {
  return request(
    `${callbackPath}?${new URLSearchParams({ state, code })}`,
    options
  );
}

async function configuration(tenantId) {
  return SystemSettings.withTenantConfiguration(tenantId, () =>
    outlook.OutlookBridge.getConfig()
  );
}

beforeAll(async () => {
  originalEnvironment = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]])
  );
  originalFetch = global.fetch;
  process.env.JWT_SECRET = "isolated-outlook-ownership-secret";
  process.env.PLATFORM_HOSTS = "localhost";
  process.env.TENANT_BASE_DOMAIN = "localhost";
  mockFixture = await createPostgresFixture();
  const stamp = new Date().toISOString();
  await mockFixture.prisma.ep_platform_accounts.create({
    data: {
      id: "platform",
      username: "operator",
      name: "Top administrator",
      passwordHash: "unused-in-authenticated-endpoint-test",
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  for (const tenantId of ["a", "b"]) {
    await mockFixture.prisma.ep_tenants.create({
      data: {
        id: tenantId,
        code: `outlook-${tenantId}`,
        name: `Company ${tenantId}`,
        hostname: `outlook-${tenantId}.localhost`,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
    for (const role of ["admin", "user"]) {
      await mockFixture.prisma.users.create({
        data: {
          id: userIds[`${role}-${tenantId}`],
          tenantId,
          username: role,
          name: role,
          role,
          passwordHash: "unused-in-authenticated-endpoint-test",
          createdAt: stamp,
          updatedAt: stamp,
        },
      });
    }
  }
  const app = express();
  app.use(express.json());
  const router = express.Router();
  outlookAgentEndpoints(router);
  app.use("/api", router);
  app.use((error, _request, response, _next) =>
    response.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});

beforeEach(async () => {
  await mockFixture.prisma.cache_data.deleteMany();
  await mockFixture.prisma.system_settings.deleteMany();
  await mockFixture.prisma.ep_platform_accounts.updateMany({
    data: { status: "active", authVersion: 1 },
  });
  await mockFixture.prisma.ep_tenants.updateMany({
    data: { status: "active" },
  });
  await SystemSettings.updateSettings({ multi_user_mode: "true" });
  for (const tenantId of ["a", "b"]) {
    SystemSettings.withTenantConfiguration(tenantId, () => outlook.reset());
  }
  global.fetch = jest.fn(async (url, options) => {
    if (String(url).startsWith("https://login.microsoftonline.com/")) {
      const params = new URLSearchParams(options.body);
      const data = {
        access_token: `access-${params.get("code")}`,
        refresh_token: `refresh-${params.get("code")}`,
        expires_in: 3600,
      };
      return { ok: true, status: 200, json: async () => data };
    }
    if (String(url).startsWith("https://graph.microsoft.com/")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ value: [] }),
      };
    }
    throw new Error(`Unexpected network request: ${url}`);
  });
});

afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnvironment || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("only the top administrator on the platform host can initiate enterprise Outlook configuration", async () => {
  for (const role of ["admin", "user"]) {
    const token = auth.signed(await auth.context(userIds[`${role}-a`])).token;
    expect(
      (
        await start("a", {
          token,
          host: "outlook-a.localhost",
        })
      ).status
    ).toBe(401);
  }
  expect((await start("a", { token: undefined })).status).toBe(401);
  expect((await start("a", { host: "outlook-a.localhost" })).status).toBe(401);
  expect(await mockFixture.prisma.cache_data.count()).toBe(0);
  expect(
    await mockFixture.prisma.system_settings.count({
      where: { label: { contains: "outlook_agent_config" } },
    })
  ).toBe(0);
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each(["", "missing-company"])(
  "initiation rejects the invalid enterprise target %j without storing credentials",
  async (tenantId) => {
    expect((await start(tenantId)).status).toBe(400);
    expect(await mockFixture.prisma.cache_data.count()).toBe(0);
    expect(await configuration("a")).toEqual({});
  }
);

test("initiation rejects a disabled enterprise", async () => {
  await mockFixture.prisma.ep_tenants.update({
    where: { id: "a" },
    data: { status: "disabled" },
  });
  expect((await start("a")).status).toBe(400);
  expect(await mockFixture.prisma.cache_data.count()).toBe(0);
  expect(await configuration("a")).toEqual({});
});

test("authorization state binds the signed platform actor and SaaS enterprise independently from Microsoft tenantId", async () => {
  const response = await start("a");
  expect(response.status).toBe(200);
  const url = new URL(response.body.url);
  expect(url.hostname).toBe("login.microsoftonline.com");
  expect(url.pathname).toContain("/microsoft-directory-a/");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "http://localhost/api/agent-skills/outlook/auth-callback"
  );
  const claims = jwt.verify(
    url.searchParams.get("state"),
    process.env.JWT_SECRET,
    {
      audience,
      algorithms: ["HS256"],
    }
  );
  expect(claims).toMatchObject({
    sub: "platform",
    tenantId: "a",
    ver: 1,
    aud: audience,
  });
  expect(claims.exp - claims.iat).toBe(600);
  expect(typeof claims.jti).toBe("string");
  expect(
    await mockFixture.prisma.cache_data.findFirst({
      where: { name: `outlook-oauth:${claims.jti}` },
    })
  ).toMatchObject({ data: "outlook", expiresAt: expect.any(Date) });
  expect(await configuration("a")).toMatchObject(credentials);
  expect(await configuration("b")).toEqual({});
  expect(global.fetch).not.toHaveBeenCalled();
});

test("the callback uses signed enterprise ownership and consumes state exactly once", async () => {
  const state = await createState("a");
  const result = await request(
    `${callbackPath}?${new URLSearchParams({ state, code: "approved-a", tenantId: "b" })}`
  );
  expect(result.status).toBe(302);
  expect(result.location).toBe(
    "/settings/agents?tenantId=a&outlook_auth=success"
  );
  const exchange = new URLSearchParams(global.fetch.mock.calls[0][1].body);
  expect(exchange.get("client_id")).toBe("client-a");
  expect(exchange.get("client_secret")).toBe("secret-a");
  expect(exchange.get("code")).toBe("approved-a");
  expect(await configuration("a")).toMatchObject({
    accessToken: "access-approved-a",
    refreshToken: "refresh-approved-a",
  });
  expect(await configuration("b")).toEqual({});
  expect(await mockFixture.prisma.cache_data.count()).toBe(0);
  expect((await callback(state)).status).toBe(401);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("concurrent callbacks cannot exchange the same authorization state twice", async () => {
  const state = await createState();
  const results = await Promise.all([callback(state), callback(state)]);
  expect(results.map(({ status }) => status).sort()).toEqual([302, 401]);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("a callback cannot be replayed on an enterprise host", async () => {
  const state = await createState();
  expect((await callback(state, { host: "outlook-a.localhost" })).status).toBe(
    401
  );
  expect(global.fetch).not.toHaveBeenCalled();
  expect((await callback(state)).status).toBe(302);
});

test("tampering with signed enterprise ownership is rejected before Microsoft exchange", async () => {
  const state = await createState("a");
  const [header, payload, signature] = state.split(".");
  const edited = JSON.parse(Buffer.from(payload, "base64url").toString());
  edited.tenantId = "b";
  const forged = `${header}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`;
  expect((await callback(forged)).status).toBe(401);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(await configuration("b")).toEqual({});
});

test.each(["expired JWT", "expired nonce", "unknown nonce", "wrong audience"])(
  "the callback rejects %s without exchanging the Microsoft code",
  async (reason) => {
    let state = await createState();
    const claims = jwt.decode(state);
    if (reason === "expired nonce") {
      await mockFixture.prisma.cache_data.updateMany({
        where: { name: `outlook-oauth:${claims.jti}` },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    } else if (reason === "unknown nonce") {
      await mockFixture.prisma.cache_data.deleteMany();
    } else {
      if (reason === "expired JWT")
        claims.exp = Math.floor(Date.now() / 1000) - 1;
      if (reason === "wrong audience") claims.aud = "enterprise-platform-v1";
      state = jwt.sign(claims, process.env.JWT_SECRET, { algorithm: "HS256" });
    }
    expect((await callback(state)).status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await configuration("a")).not.toHaveProperty("accessToken");
  }
);

test.each(["authVersion", "disabled account", "disabled enterprise"])(
  "a pending callback rechecks %s before storing Microsoft tokens",
  async (reason) => {
    const state = await createState();
    if (reason === "disabled enterprise") {
      await mockFixture.prisma.ep_tenants.update({
        where: { id: "a" },
        data: { status: "disabled" },
      });
    } else {
      await mockFixture.prisma.ep_platform_accounts.update({
        where: { id: "platform" },
        data:
          reason === "authVersion"
            ? { authVersion: 2 }
            : { status: "disabled" },
      });
    }
    expect((await callback(state)).status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await configuration("a")).not.toHaveProperty("accessToken");
  }
);

test("the original Outlook bridge keeps concurrent enterprise credentials and token state separate", async () => {
  for (const tenantId of ["a", "b"]) {
    await SystemSettings.withTenantConfiguration(tenantId, () =>
      outlook.OutlookBridge.updateConfig({
        clientId: `client-${tenantId}`,
        clientSecret: `secret-${tenantId}`,
        accessToken: `access-${tenantId}`,
        refreshToken: `refresh-${tenantId}`,
        tokenExpiry: Date.now() + 3600 * 1000,
      })
    );
  }
  const results = await Promise.all(
    ["a", "b", "a", "b"].map((tenantId) =>
      SystemSettings.withTenantConfiguration(tenantId, () =>
        outlook.getInbox(5)
      )
    )
  );
  expect(results).toEqual(
    Array(4).fill({
      success: true,
      data: { messages: [], resultCount: 0, hasMore: false },
    })
  );
  expect(
    global.fetch.mock.calls
      .map(([, options]) => options.headers.Authorization)
      .sort()
  ).toEqual([
    "Bearer access-a",
    "Bearer access-a",
    "Bearer access-b",
    "Bearer access-b",
  ]);
  const revoked = await request(
    "/api/admin/agent-skills/outlook/revoke?tenantId=a",
    {
      token: await topToken(),
      method: "POST",
    }
  );
  expect(revoked.status).toBe(200);
  expect(await configuration("a")).toEqual({});
  expect(await configuration("b")).toMatchObject({ accessToken: "access-b" });
  expect(
    await SystemSettings.withTenantConfiguration("a", () =>
      outlook.isAvailable()
    )
  ).toBe(false);
  expect(
    await SystemSettings.withTenantConfiguration("b", () =>
      outlook.isAvailable()
    )
  ).toBe(true);
});
