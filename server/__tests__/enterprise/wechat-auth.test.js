/* eslint-env jest */
const express = require("express");
const bcrypt = require("bcryptjs");
const { createHash } = require("crypto");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const { requestJson } = require("./http-test-client.cjs");
let mockFixture;
jest.mock(
  "../../enterprise/store",
  () =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          const value = mockFixture.db[key];
          return typeof value === "function"
            ? value.bind(mockFixture.db)
            : value;
        },
      }
    )
);
const auth = require("../../enterprise/auth");
const { exchangeCode } = require("../../enterprise/wechat");
let listener, base, topToken, memberToken, previous, originalFetch;
let requestNumber = 1;
const environmentKeys = ["JWT_SECRET", "SIG_KEY", "SIG_SALT", "PLATFORM_HOSTS"];
const appId = "wx1234567890abcdef";
const appSecret = "isolated-wechat-secret-not-for-client";

function request(
  path,
  { host = "wechat-a.localhost", token, method = "GET", body } = {}
) {
  return requestJson(`${base}/api/enterprise${path}`, {
    method,
    headers: {
      host,
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${requestNumber++}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const configure = (tenantId = "a", value = {}) =>
  request(`/platform/tenants/${tenantId}/wechat`, {
    host: "localhost",
    token: topToken,
    method: "PUT",
    body: { appId, appSecret, enabled: true, ...value },
  });
const login = (
  host = "wechat-a.localhost",
  body = { code: "temporary-code" }
) => request("/wechat/login", { host, method: "POST", body });

beforeAll(async () => {
  previous = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]])
  );
  process.env.JWT_SECRET = "isolated-wechat-auth-secret";
  process.env.SIG_KEY = "isolated-wechat-config-encryption-key";
  process.env.SIG_SALT = "isolated-wechat-config-encryption-salt";
  process.env.PLATFORM_HOSTS = "localhost";
  originalFetch = global.fetch;
  mockFixture = await createPostgresFixture();
  const stamp = mockFixture.db.now();
  await mockFixture.prisma.ep_platform_accounts.create({
    data: {
      id: "operator",
      username: "operator",
      name: "Operator",
      passwordHash: "unused",
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  for (const id of ["a", "b"])
    await mockFixture.prisma.ep_tenants.create({
      data: {
        id,
        code: id,
        name: id,
        hostname: `wechat-${id}.localhost`,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  const member = await mockFixture.prisma.users.create({
    data: {
      tenantId: "a",
      username: "member",
      name: "Member",
      passwordHash: "unused",
    },
  });
  topToken = auth.signed(await auth.platformContext("operator")).token;
  memberToken = auth.signed(await auth.context(member.id)).token;
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  const router = express.Router();
  auth.registerAuth(router);
  app.use("/api/enterprise", router);
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
});

beforeEach(async () => {
  await mockFixture.prisma.ep_tenants.updateMany({
    data: { status: "active" },
  });
  await mockFixture.prisma.users.updateMany({ data: { status: "active" } });
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      openid: "shared-openid",
      session_key: "never-persist-session-key",
    }),
  }));
  expect((await configure("a")).status).toBe(200);
  expect((await configure("b")).status).toBe(200);
});

afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(previous || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("top administrator saves encrypted per-tenant configuration and blank secrets preserve the saved value", async () => {
  expect(await configure("a", { appSecret: "" })).toEqual({
    status: 200,
    body: { appId, enabled: true, hasSecret: true },
  });
  const saved = await mockFixture.prisma.system_settings.findUnique({
    where: { label: "saas:tenant:a:wechat" },
  });
  expect(saved.value).not.toContain(appSecret);
  expect(saved.value).not.toContain(appId);
  const result = await request("/platform/tenants/a/wechat", {
    host: "localhost",
    token: topToken,
  });
  expect(result.body).toEqual({ appId, enabled: true, hasSecret: true });
  await login();
  const upstream = global.fetch.mock.calls.at(-1)[0];
  expect(upstream.hostname).toBe("api.weixin.qq.com");
  expect(upstream.searchParams.get("secret")).toBe(appSecret);
});

test("first login registers an active ordinary enterprise user with an unusable random password and reuses its identity", async () => {
  const first = await login();
  const second = await login();
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    role: "user",
    tenant: { id: "a" },
    user: { id: expect.any(Number) },
  });
  expect(second.body.user.id).toBe(first.body.user.id);
  const user = await mockFixture.prisma.users.findUnique({
    where: { id: first.body.user.id },
  });
  expect(user).toMatchObject({
    tenantId: "a",
    role: "user",
    status: "active",
    wechatIdentity: `${appId}:shared-openid`,
    name: `用户${user.id}`,
  });
  expect(first.body.user.wechatBound).toBe(true);
  expect(first.body.user.wechatRegistrationRequired).toBe(true);
  expect(first.body.recoveryCodes).toBeUndefined();
  expect(user.username).toMatch(/^wx_[a-f0-9]{40}$/);
  expect(bcrypt.getRounds(user.passwordHash)).toBe(12);
  expect(await bcrypt.compare("admin123", user.passwordHash)).toBe(false);
  expect(JSON.stringify(first.body)).not.toMatch(
    /shared-openid|appSecret|session_key|passwordHash/
  );
});

test("different login codes for the same OpenID preserve the user and its chosen profile", async () => {
  const openid = "stable-profile-openid";
  global.fetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ openid }),
  }));
  const first = await login("wechat-a.localhost", {
    code: "first-unique-code",
  });
  expect(first.status).toBe(200);
  expect(first.body.user.name).toBe(`用户${first.body.user.id}`);
  const incomplete = await request("/me", {
    method: "PATCH",
    token: first.body.token,
    body: { name: "微信昵称" },
  });
  expect(incomplete.status).toBe(400);
  await mockFixture.prisma.users.update({
    where: { id: first.body.user.id },
    data: { pfpFilename: "selected-avatar.png" },
  });
  const renamed = await request("/me", {
    method: "PATCH",
    token: first.body.token,
    body: { name: "  微信昵称  ", password: "chosen-password" },
  });
  expect(renamed.status).toBe(200);
  expect(renamed.body.user.wechatRegistrationRequired).toBe(false);
  expect(renamed.body.recoveryCodes).toHaveLength(4);
  expect((await request("/me", { token: first.body.token })).status).toBe(401);
  const passwordLogin = await request("/login", {
    method: "POST",
    body: { username: first.body.user.username, password: "chosen-password" },
  });
  expect(passwordLogin.status).toBe(200);
  expect(passwordLogin.body.user.id).toBe(first.body.user.id);
  const second = await login("wechat-a.localhost", {
    code: "second-unique-code",
  });
  expect(second.status).toBe(200);
  expect(second.body.user).toMatchObject({
    id: first.body.user.id,
    name: "微信昵称",
    wechatBound: true,
    wechatRegistrationRequired: false,
  });
  expect(
    await mockFixture.prisma.users.count({
      where: { tenantId: "a", wechatIdentity: `${appId}:${openid}` },
    })
  ).toBe(1);
  const codeCalls = global.fetch.mock.calls.map(([url]) =>
    url.searchParams.get("js_code")
  );
  expect(codeCalls).toEqual(["first-unique-code", "second-unique-code"]);
});

test("the same AppID and openid remain separate enterprise users according to the request Host", async () => {
  const a = await login();
  const b = await login("wechat-b.localhost");
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(a.body.user.id).not.toBe(b.body.user.id);
  expect(b.body.tenant.id).toBe("b");
});

test("an ordinary account with the generated username is not reused or allowed to block WeChat registration", async () => {
  const openid = "occupied-name";
  const username = `wx_${createHash("sha256").update(`${appId}:${openid}`).digest("hex").slice(0, 40)}`;
  const ordinary = await mockFixture.prisma.users.create({
    data: {
      tenantId: "a",
      username,
      name: "Ordinary account",
      passwordHash: "unused",
    },
  });
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ openid }),
  });
  const result = await login();
  expect(result.status).toBe(200);
  expect(result.body.user.id).not.toBe(ordinary.id);
  expect(result.body.user.username).toMatch(
    new RegExp(`^${username}_[a-f0-9]{12}$`)
  );
  expect(
    (await mockFixture.prisma.users.findUnique({ where: { id: ordinary.id } }))
      .wechatIdentity
  ).toBeNull();
});

test("concurrent first logins create a single user and all return that same integer identity", async () => {
  global.fetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ openid: "concurrent-new-user" }),
  }));
  const results = await Promise.all(Array.from({ length: 4 }, () => login()));
  for (const result of results) expect(result.body.error).toBeUndefined();
  expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200]);
  expect(new Set(results.map((result) => result.body.user.id)).size).toBe(1);
  expect(
    await mockFixture.prisma.users.count({
      where: { tenantId: "a", wechatIdentity: `${appId}:concurrent-new-user` },
    })
  ).toBe(1);
});

test("only a WeChat identity uniqueness collision retries the registration transaction", async () => {
  const collision = jest
    .spyOn(mockFixture.db, "transaction")
    .mockRejectedValueOnce({
      code: "P2010",
      meta: {
        code: "23505",
        message: 'Key ("tenantId", username) already exists.',
      },
    });
  try {
    const result = await login();
    expect(result.status).toBe(200);
    expect(collision).toHaveBeenCalledTimes(2);
  } finally {
    collision.mockRestore();
  }
  const unrelated = jest
    .spyOn(mockFixture.db, "transaction")
    .mockRejectedValueOnce({
      code: "P2010",
      meta: { code: "23505", message: "Unrelated unique key conflict" },
      message: "Unrelated unique key conflict",
    });
  try {
    expect((await login()).status).toBe(500);
    expect(unrelated).toHaveBeenCalledTimes(1);
  } finally {
    unrelated.mockRestore();
  }
});

test("incomplete registration can only manage its own profile, and completion cannot cross tenants", async () => {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ openid: "onboarding-access" }),
  });
  const result = await login();
  const token = result.body.token;
  expect((await request("/me", { token })).status).toBe(200);
  expect((await request("/suggested-messages", { token })).status).toBe(428);
  expect(
    (await request("/me", { host: "wechat-b.localhost", token })).status
  ).toBe(401);
  const update = (body) => request("/me", { token, method: "PATCH", body });
  expect(
    (await update({ name: "张三", password: "safe-password" })).status
  ).toBe(400);
  await mockFixture.prisma.users.update({
    where: { id: result.body.user.id },
    data: { pfpFilename: "valid-avatar.png" },
  });
  expect((await update({ name: "张三", password: "short" })).status).toBe(400);
  expect(
    (
      await update({
        name: "张三",
        password: "safe-password",
        wechatRegistrationComplete: true,
      })
    ).status
  ).toBe(400);
  expect(
    (await update({ name: "张三", password: "safe-password" })).status
  ).toBe(200);
  expect((await login()).body.user.wechatRegistrationRequired).toBe(true);
});

test("public status exposes only whether the current tenant enables WeChat login", async () => {
  const status = await request("/status");
  expect(status.body.site.tenant).toMatchObject({
    id: "a",
    wechatLoginEnabled: true,
  });
  expect(JSON.stringify(status.body)).not.toContain(appSecret);
  expect(JSON.stringify(status.body)).not.toContain(appId);
  await configure("a", { enabled: false });
  expect((await request("/status")).body.site.tenant.wechatLoginEnabled).toBe(
    false
  );
});

test("unknown or disabled tenants and disabled WeChat settings never contact WeChat", async () => {
  expect((await login("unknown.localhost")).status).toBe(403);
  await mockFixture.prisma.ep_tenants.update({
    where: { id: "a" },
    data: { status: "disabled" },
  });
  expect((await login()).status).toBe(403);
  await mockFixture.prisma.ep_tenants.update({
    where: { id: "a" },
    data: { status: "active" },
  });
  await configure("a", { enabled: false });
  expect((await login()).status).toBe(403);
  expect(global.fetch).not.toHaveBeenCalled();
});

test("disabled bound users cannot regain access or cause a replacement account", async () => {
  const first = await login();
  await mockFixture.prisma.users.update({
    where: { id: first.body.user.id },
    data: { status: "disabled" },
  });
  expect((await login()).status).toBe(401);
  expect(
    await mockFixture.prisma.users.count({
      where: { tenantId: "a", wechatIdentity: `${appId}:shared-openid` },
    })
  ).toBe(1);
});

test.each([
  { tenantId: "b" },
  { role: "admin" },
  { openid: "other" },
  { appId: "other" },
  { identity: "platform" },
])(
  "client-supplied identity %j is rejected before contacting WeChat",
  async (extra) => {
    expect(
      (await login(undefined, { code: "temporary-code", ...extra })).status
    ).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  }
);

test("configuration requires top administrator, a valid tenant and complete enabled credentials", async () => {
  expect(
    (await request("/platform/tenants/a/wechat", { token: memberToken })).status
  ).toBe(401);
  expect(
    (await request("/platform/tenants/a/wechat", { host: "localhost" })).status
  ).toBe(401);
  expect((await configure("missing")).status).toBe(404);
  expect((await configure("a", { role: "admin" })).status).toBe(400);
  expect((await configure("a", { appId: "not-an-appid" })).status).toBe(400);
  await mockFixture.prisma.system_settings.delete({
    where: { label: "saas:tenant:a:wechat" },
  });
  expect((await configure("a", { appSecret: "" })).status).toBe(400);
});

test("tenant or configuration revocation while exchanging a code prevents first registration", async () => {
  global.fetch.mockImplementationOnce(async () => {
    await mockFixture.prisma.ep_tenants.update({
      where: { id: "a" },
      data: { status: "disabled" },
    });
    return { ok: true, json: async () => ({ openid: "revoked-tenant" }) };
  });
  expect((await login()).status).toBe(403);
  expect(
    await mockFixture.prisma.users.count({
      where: { wechatIdentity: `${appId}:revoked-tenant` },
    })
  ).toBe(0);
  await mockFixture.prisma.ep_tenants.update({
    where: { id: "a" },
    data: { status: "active" },
  });
  global.fetch.mockImplementationOnce(async () => {
    await configure("a", { enabled: false });
    return { ok: true, json: async () => ({ openid: "revoked-config" }) };
  });
  expect((await login()).status).toBe(403);
  expect(
    await mockFixture.prisma.users.count({
      where: { wechatIdentity: `${appId}:revoked-config` },
    })
  ).toBe(0);
});

test("upstream errors never echo WeChat secrets or raw provider diagnostics", async () => {
  global.fetch.mockRejectedValueOnce(
    Object.assign(new Error(appSecret), { status: 403 })
  );
  const network = await login();
  expect(network.status).toBe(502);
  expect(JSON.stringify(network.body)).not.toContain(appSecret);
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ errcode: 40029, errmsg: appSecret }),
  });
  const rejected = await login();
  expect(rejected.status).toBe(401);
  expect(JSON.stringify(rejected.body)).not.toContain(appSecret);
});

test.each([
  ["HTTP failure", { ok: false }, 502],
  ["empty result", { ok: true, json: async () => null }, 502],
  [
    "provider failure",
    { ok: true, json: async () => ({ errcode: -1, errmsg: appSecret }) },
    502,
  ],
  [
    "non-string identity",
    { ok: true, json: async () => ({ openid: 123, errmsg: appSecret }) },
    502,
  ],
  [
    "invalid identity characters",
    { ok: true, json: async () => ({ openid: "unsafe/identity" }) },
    502,
  ],
  [
    "reused login code",
    { ok: true, json: async () => ({ errcode: 40163, errmsg: appSecret }) },
    401,
  ],
])(
  "WeChat %s cannot create an account or expose upstream diagnostics",
  async (_label, upstream, expectedStatus) => {
    const before = await mockFixture.prisma.users.count();
    global.fetch.mockResolvedValueOnce(upstream);
    const result = await login();
    expect(result.status).toBe(expectedStatus);
    expect(result.body).toEqual({ error: expect.any(String) });
    expect(JSON.stringify(result.body)).not.toContain(appSecret);
    expect(await mockFixture.prisma.users.count()).toBe(before);
  }
);

test.each([
  ["AppID", { appId: "wxabcdef1234567890" }],
  ["AppSecret", { appSecret: "replacement-wechat-secret" }],
])(
  "replacing the %s during the code exchange revokes the pending login",
  async (_label, replacement) => {
    const before = await mockFixture.prisma.users.count();
    global.fetch.mockImplementationOnce(async () => {
      expect((await configure("a", replacement)).status).toBe(200);
      return {
        ok: true,
        json: async () => ({ openid: "rotating-credentials" }),
      };
    });
    expect((await login()).status).toBe(403);
    expect(await mockFixture.prisma.users.count()).toBe(before);
  }
);

test("a damaged stored credential fails closed and the top administrator can replace it explicitly", async () => {
  await mockFixture.prisma.system_settings.update({
    where: { label: "saas:tenant:a:wechat" },
    data: { value: "damaged-encrypted-credential" },
  });
  expect((await login()).status).toBe(503);
  expect((await request("/status")).body.site.tenant.wechatLoginEnabled).toBe(
    false
  );
  expect(global.fetch).not.toHaveBeenCalled();
  expect((await configure("a")).status).toBe(200);
  expect((await login()).status).toBe(200);
});

test("code exchange times out and clears its timer without leaking credentials", async () => {
  jest.useFakeTimers();
  global.fetch = jest.fn(
    (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error(appSecret)))
      )
  );
  const result = exchangeCode({ appId, appSecret }, "temporary-code");
  const assertion = expect(result).rejects.toMatchObject({ status: 504 });
  await jest.advanceTimersByTimeAsync(8000);
  await assertion;
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
