/* global jest, beforeAll, afterAll, test, expect */
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { requestJson } = require("./http-test-client.cjs");
const { createPostgresFixture } = require("./postgres-fixture.cjs");

let mockFixture;
const mockStore = Object.fromEntries(
  ["all", "one", "run", "transaction", "id", "now"].map((key) => [
    key,
    (...args) => mockFixture.db[key](...args),
  ])
);
Object.defineProperty(mockStore, "orm", { get: () => mockFixture.db.orm });
jest.mock("../../enterprise/store", () => mockStore);
const auth = require("../../enterprise/auth");
const { registerKnowledge } = require("../../enterprise/knowledge");
const { registerRag } = require("../../enterprise/rag");

const platformPassword = "Platform-2026!";
const passwordA = "Tenant-A-2026!";
const passwordB = "Tenant-B-2026!";
let listener, base, platform, adminA, adminB, tenantA, tenantB;
let requestNumber = 0;
let setupTenantCount, setupEnterpriseUserCount;
let previous;
const envKeys = [
  "JWT_SECRET",
  "TENANT_BASE_DOMAIN",
  "PLATFORM_HOSTS",
  "TENANT_WEB_PORT",
];

async function request(token, route, method = "GET", body, ip, explicitHost) {
  let host = explicitHost || "localhost";
  if (!explicitHost && token) {
    const claims = jwt.decode(token);
    if (claims?.tenantId) {
      const company = await mockStore.one(
        "SELECT hostname FROM ep_tenants WHERE id=$1 AND status='active'",
        claims.tenantId
      );
      if (company) host = company.hostname;
    }
  }
  return requestJson(`${base}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      host,
      "x-forwarded-for": ip || `198.51.100.${++requestNumber}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function login(tenantCode, username, password) {
  return request(
    null,
    "/login",
    "POST",
    { username, password },
    undefined,
    `${tenantCode.trim().toLowerCase()}.localhost`
  );
}

async function createTenant(code, adminPassword = passwordA) {
  return request(platform.token, "/platform/tenants", "POST", {
    code,
    name: `企业 ${code}`,
    adminUsername: "admin",
    adminPassword,
    adminName: `管理员 ${code}`,
  });
}

test("tenant suggested questions preserve original entries and restrict configuration to the top administrator", async () => {
  const messages = [
    { heading: "Install", message: "How do I install the product?" },
  ];
  const route = `/platform/tenants/${tenantA.id}/suggested-messages`;
  expect(
    (await request(adminA.token, route, "POST", { messages })).status
  ).toBe(401);
  expect(
    (await request(platform.token, route, "POST", { messages })).status
  ).toBe(200);
  expect(
    (await request(adminA.token, "/suggested-messages")).body.messages
  ).toEqual(messages);
  expect(
    (await request(adminB.token, "/suggested-messages")).body.messages
  ).toEqual([]);
  expect(
    (
      await request(platform.token, route, "POST", {
        messages: [{ heading: "broken" }],
      })
    ).status
  ).toBe(400);
});

beforeAll(async () => {
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.JWT_SECRET = "isolated-identity-test-secret";
  delete process.env.TENANT_BASE_DOMAIN;
  delete process.env.PLATFORM_HOSTS;
  delete process.env.TENANT_WEB_PORT;
  mockFixture = await createPostgresFixture();
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  const router = express.Router();
  auth.registerAuth(router);
  router.get("/identity-adapter", auth.authenticate, (req, res) =>
    res.json({ identity: req.ep.identity, ...res.locals })
  );
  registerKnowledge(router);
  registerRag(router);
  app.use(router);
  app.use((_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use((error, _req, res, _next) => {
    const conflict =
      ["P2002", "P2034", "23505", "40001"].includes(error.code) ||
      ["23505", "40001"].includes(error.meta?.code);
    const status = conflict ? 409 : error.status || 500;
    res
      .status(status)
      .json({ error: status === 409 ? "配置冲突" : error.message });
  });
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
  await mockFixture.prisma.ep_platform_accounts.create({
    data: {
      id: "platform",
      username: "platform",
      name: "平台管理员",
      passwordHash: await bcrypt.hash(platformPassword, 4),
      createdAt: mockStore.now(),
      updatedAt: mockStore.now(),
    },
  });
  const setup = await request(null, "/platform/login", "POST", {
    username: "Platform",
    password: platformPassword,
  });
  expect(setup.status).toBe(200);
  platform = setup.body;
  setupTenantCount = (await mockStore.all("SELECT id FROM ep_tenants")).length;
  setupEnterpriseUserCount = (await mockStore.all("SELECT id FROM users"))
    .length;
  const a = await createTenant(" Tenant-A ", passwordA);
  const b = await createTenant("tenant-b", passwordB);
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  tenantA = a.body.tenant;
  tenantB = b.body.tenant;
  const aLogin = await login("TENANT-A", "ADMIN", passwordA);
  const bLogin = await login("tenant-b", "admin", passwordB);
  expect(aLogin.status).toBe(200);
  expect(bLogin.status).toBe(200);
  adminA = aLogin.body;
  adminB = bLogin.body;
}, 15000);

afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  for (const [key, value] of Object.entries(previous || {}))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

test("deployment creates an independent platform identity and HTTP setup is absent", async () => {
  expect(setupTenantCount).toBe(0);
  expect(setupEnterpriseUserCount).toBe(0);
  expect(platform).toMatchObject({
    identity: "platform",
    user: { username: "platform", name: "平台管理员" },
    tenant: null,
    role: "platform_admin",
  });
  expect(platform.user).not.toHaveProperty("platformAdmin");
  expect((await request(null, "/status")).body.initialized).toBe(true);
  expect(
    (
      await request(null, "/setup", "POST", {
        username: "second-platform",
        password: platformPassword,
      })
    ).status
  ).toBe(404);
  expect(
    await mockStore.all("SELECT id FROM ep_platform_accounts")
  ).toHaveLength(1);
  const platformLogin = await request(null, "/platform/login", "POST", {
    username: " PLATFORM ",
    password: platformPassword,
  });
  expect(platformLogin.status).toBe(200);
  expect(platformLogin.body.user.id).toBe(platform.user.id);
});

test("same usernames resolve strictly inside the supplied enterprise", async () => {
  expect(adminA).toMatchObject({
    identity: "tenant",
    tenant: { id: tenantA.id, code: "tenant-a" },
    role: "admin",
  });
  expect(adminB.tenant.id).toBe(tenantB.id);
  expect(adminA.user.id).not.toBe(adminB.user.id);
  expect(adminA.user.username).toBe(adminB.user.username);
  expect(adminA.user).not.toHaveProperty("platformAdmin");
  const platformEntry = await request(null, "/login", "POST", {
    username: "admin",
    password: passwordA,
  });
  expect(platformEntry.status).toBe(403);
  const absent = await login("missing-enterprise", "admin", passwordA);
  expect(absent.status).toBe(403);
  const wrongEnterprisePassword = await login("tenant-b", "admin", passwordA);
  const wrongUsername = await login("tenant-a", "missing-user", passwordA);
  const platformAsTenant = await login(
    "tenant-a",
    "platform",
    platformPassword
  );
  for (const result of [
    wrongEnterprisePassword,
    wrongUsername,
    platformAsTenant,
  ]) {
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "账号或密码不正确" });
  }
  expect((await login(" tenant-a ", " ADMIN ", passwordA)).status).toBe(200);
});

test("the original route authentication adapter carries the current tenant or platform identity and rejects a foreign host", async () => {
  const tenant = await request(adminA.token, "/identity-adapter");
  expect(tenant.status).toBe(200);
  expect(tenant.body).toMatchObject({
    identity: "tenant",
    multiUserMode: true,
    user: {
      id: adminA.user.id,
      tenantId: tenantA.id,
      identity: "tenant",
      role: "admin",
      authVersion: 1,
    },
  });
  const top = await request(platform.token, "/identity-adapter");
  expect(top.status).toBe(200);
  expect(top.body).toMatchObject({
    identity: "platform",
    multiUserMode: true,
    user: { id: platform.user.id, role: "platform_admin" },
  });
  expect(
    (
      await request(
        adminA.token,
        "/identity-adapter",
        "GET",
        undefined,
        undefined,
        "tenant-b.localhost"
      )
    ).status
  ).toBe(401);
  expect((await request(null, "/identity-adapter")).status).toBe(401);
  const prior = process.env.PLATFORM_HOSTS;
  process.env.PLATFORM_HOSTS = "invalid host";
  try {
    const unavailable = await request(platform.token, "/identity-adapter");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).not.toHaveProperty("user");
  } finally {
    if (prior === undefined) delete process.env.PLATFORM_HOSTS;
    else process.env.PLATFORM_HOSTS = prior;
  }
});

test("usernames are case-insensitively unique per enterprise and protected fields cannot escalate identity", async () => {
  expect(
    (
      await request(adminA.token, "/users", "POST", {
        username: "AdMiN",
        password: passwordA,
      })
    ).status
  ).toBe(409);
  const forged = await request(adminA.token, "/users", "POST", {
    username: "shared-user",
    password: passwordA,
    role: "user",
    tenantId: tenantB.id,
    platformAdmin: true,
    identity: "platform",
  });
  expect(forged.status).toBe(400);
  expect(
    await mockStore.one(
      'SELECT id FROM users WHERE "tenantId"=$1 AND username=$2',
      tenantA.id,
      "shared-user"
    )
  ).toBeNull();
  const a = await request(adminA.token, "/users", "POST", {
    username: "shared-user",
    password: passwordA,
    role: "user",
  });
  const b = await request(adminB.token, "/users", "POST", {
    username: "SHARED-USER",
    password: passwordB,
  });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  const member = await login("tenant-a", "SHARED-USER", passwordA);
  expect(member.status).toBe(200);
  expect(member.body).toMatchObject({
    identity: "tenant",
    tenant: { id: tenantA.id },
    role: "user",
  });
  expect((await request(member.body.token, "/users")).status).toBe(403);
  expect(
    (
      await request(adminA.token, `/users/${a.body.user.id}`, "PATCH", {
        name: "已修改姓名",
        username: "forged-username",
        tenantId: tenantB.id,
        platformAdmin: true,
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request(adminA.token, `/users/${a.body.user.id}`, "PATCH", {
        name: "已修改姓名",
      })
    ).status
  ).toBe(200);
  const persisted = await mockStore.one(
    'SELECT "tenantId",username,name,role FROM users WHERE id=$1',
    a.body.user.id
  );
  expect(persisted).toEqual({
    tenantId: tenantA.id,
    username: "shared-user",
    name: "已修改姓名",
    role: "user",
  });
  const users = await request(adminA.token, "/users");
  expect(users.body.users.map((user) => user.id)).not.toContain(adminB.user.id);
  expect(
    (
      await request(adminA.token, `/users/${adminB.user.id}`, "PATCH", {
        role: "user",
      })
    ).status
  ).toBe(404);
  expect(
    (
      await request(adminA.token, `/users/${platform.user.id}`, "PATCH", {
        status: "disabled",
      })
    ).status
  ).toBe(404);
  expect((await request(platform.token, "/users")).status).toBe(401);
  expect(JSON.stringify(users.body)).not.toMatch(/passwordHash|authVersion/);
});

test("enterprise codes normalize, remain unique, validate format and cannot be changed", async () => {
  expect(tenantA.code).toBe("tenant-a");
  expect((await createTenant(" TENANT-A ")).status).toBe(409);
  for (const code of ["ab", "-abc", "企业一", "with space", "x".repeat(41)])
    expect((await createTenant(code)).status).toBe(400);
  for (const code of ["different-code", "tenant-a"])
    expect(
      (
        await request(
          platform.token,
          `/platform/tenants/${tenantA.id}`,
          "PATCH",
          { code }
        )
      ).status
    ).toBe(400);
  const renamed = await request(
    platform.token,
    `/platform/tenants/${tenantA.id}`,
    "PATCH",
    { name: "企业新名称" }
  );
  expect(renamed.status).toBe(200);
  expect(renamed.body.tenant).toMatchObject({
    code: "tenant-a",
    name: "企业新名称",
  });
  const invalidAdmin = await request(
    platform.token,
    "/platform/tenants",
    "POST",
    {
      code: "rollback-test",
      name: "必须整体回滚",
      adminUsername: "admin",
      adminPassword: "short",
    }
  );
  expect(invalidAdmin.status).toBe(400);
  expect(
    await mockStore.one(
      "SELECT id FROM ep_tenants WHERE code=$1",
      "rollback-test"
    )
  ).toBeNull();
});

test("enterprise and platform tokens reject each other and tenant claims must match current ownership", async () => {
  expect((await request(platform.token, "/me")).status).toBe(401);
  for (const route of ["/libraries", "/documents", "/conversations"])
    expect((await request(platform.token, route)).status).toBe(401);
  expect((await request(adminA.token, "/platform/me")).status).toBe(401);
  expect((await request(adminA.token, "/platform/tenants")).status).toBe(401);
  expect((await request(platform.token, "/platform/me")).status).toBe(200);
  const decoded = jwt.verify(adminA.token, process.env.JWT_SECRET);
  expect(decoded).toMatchObject({
    aud: "enterprise-tenant-v1",
    identity: "tenant",
    tenantId: tenantA.id,
    sub: String(adminA.user.id),
    ver: 1,
  });
  const forgedTenant = jwt.sign(
    { ...decoded, tenantId: tenantB.id },
    process.env.JWT_SECRET
  );
  expect((await request(forgedTenant, "/me")).status).toBe(401);
  const forgedIdentity = jwt.sign(
    { ...decoded, identity: "platform" },
    process.env.JWT_SECRET
  );
  expect((await request(forgedIdentity, "/me")).status).toBe(401);
  const legacyAudience = jwt.sign(
    { ...decoded, aud: "enterprise-v1" },
    process.env.JWT_SECRET
  );
  expect((await request(legacyAudience, "/me")).status).toBe(401);
  const platformClaims = jwt.verify(platform.token, process.env.JWT_SECRET);
  expect(platformClaims).toMatchObject({
    aud: "enterprise-platform-v1",
    identity: "platform",
  });
  expect(platformClaims).not.toHaveProperty("tenantId");
});

test("disabling an enterprise invalidates its sessions without affecting platform login", async () => {
  expect(
    (
      await request(
        platform.token,
        `/platform/tenants/${tenantB.id}`,
        "PATCH",
        { status: "disabled" }
      )
    ).status
  ).toBe(200);
  try {
    expect((await request(adminB.token, "/me")).status).toBe(401);
    const disabledLogin = await login("tenant-b", "admin", passwordB);
    const unknownLogin = await login("unknown", "admin", passwordB);
    expect(disabledLogin.status).toBe(403);
    expect(disabledLogin.body).toEqual(unknownLogin.body);
    expect((await request(adminA.token, "/me")).status).toBe(200);
    expect((await request(platform.token, "/platform/me")).status).toBe(200);
    expect((await request(platform.token, "/platform/tenants")).status).toBe(
      200
    );
    expect(
      (
        await request(null, "/platform/login", "POST", {
          username: "platform",
          password: platformPassword,
        })
      ).status
    ).toBe(200);
  } finally {
    await request(platform.token, `/platform/tenants/${tenantB.id}`, "PATCH", {
      status: "active",
    });
  }
});

test("account status, password version and current role apply immediately", async () => {
  const created = await request(adminA.token, "/users", "POST", {
    username: "lifecycle-admin",
    password: passwordA,
    role: "admin",
  });
  expect(created.status).toBe(201);
  const userId = created.body.user.id;
  const logged = await login("tenant-a", "lifecycle-admin", passwordA);
  expect(logged.status).toBe(200);
  const token = logged.body.token;
  expect((await request(token, "/users")).status).toBe(200);
  await request(adminA.token, `/users/${userId}`, "PATCH", { role: "user" });
  expect((await request(token, "/users")).status).toBe(401);
  expect((await request(token, "/me")).status).toBe(401);
  const demoted = await login("tenant-a", "lifecycle-admin", passwordA);
  expect(demoted.status).toBe(200);
  expect((await request(demoted.body.token, "/me")).body.role).toBe("user");
  expect((await request(demoted.body.token, "/users")).status).toBe(403);
  await request(adminA.token, `/users/${userId}`, "PATCH", {
    status: "disabled",
  });
  expect((await request(token, "/me")).status).toBe(401);
  expect((await login("tenant-a", "lifecycle-admin", passwordA)).status).toBe(
    401
  );
  await request(adminA.token, `/users/${userId}`, "PATCH", {
    status: "active",
  });
  expect((await request(token, "/me")).status).toBe(401);
  const refreshed = await login("tenant-a", "lifecycle-admin", passwordA);
  expect(refreshed.status).toBe(200);
  await request(adminA.token, `/users/${userId}`, "PATCH", {
    password: passwordB,
  });
  expect((await request(refreshed.body.token, "/me")).status).toBe(401);
  expect((await login("tenant-a", "lifecycle-admin", passwordA)).status).toBe(
    401
  );
  expect((await login("tenant-a", "lifecycle-admin", passwordB)).status).toBe(
    200
  );
  expect(
    (
      await request(adminA.token, `/users/${adminA.user.id}`, "PATCH", {
        status: "disabled",
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request(adminA.token, `/users/${adminA.user.id}`, "PATCH", {
        role: "user",
      })
    ).status
  ).toBe(400);
});

test("a queued management write rechecks the current role before creating an account", async () => {
  const original = mockStore.transaction;
  const hook = jest
    .spyOn(mockStore, "transaction")
    .mockImplementationOnce(async (fn) => {
      await mockStore.run(
        "UPDATE users SET role='user' WHERE id=$1",
        adminA.user.id
      );
      return original(fn);
    });
  try {
    const response = await request(adminA.token, "/users", "POST", {
      username: "must-not-create",
      password: passwordA,
      role: "user",
    });
    expect(response.status).toBe(403);
    expect(
      await mockStore.one(
        "SELECT id FROM users WHERE \"tenantId\"=$1 AND username='must-not-create'",
        tenantA.id
      )
    ).toBeNull();
  } finally {
    hook.mockRestore();
    await mockStore.run(
      "UPDATE users SET role='admin' WHERE id=$1",
      adminA.user.id
    );
  }
});

test("transaction guards reject stale tenant and platform account versions", async () => {
  const current = await auth.context(adminA.user.id);
  await expect(auth.assertTenantAdmin(current)).resolves.toMatchObject({
    role: "admin",
  });
  await expect(
    auth.assertTenantAdmin({ ...current, authVersion: current.authVersion - 1 })
  ).rejects.toMatchObject({ status: 401 });
  const claims = jwt.decode(platform.token);
  const ctx = {
    identity: "platform",
    userId: claims.sub,
    authVersion: claims.ver,
  };
  await expect(auth.assertManagerContext(ctx)).resolves.toMatchObject({
    role: "platform_admin",
  });
  await expect(
    auth.assertManagerContext({ ...ctx, authVersion: claims.ver - 1 })
  ).rejects.toMatchObject({ status: 401 });
});

test("the old tenant routes are absent for both identities", async () => {
  for (const token of [platform.token, adminA.token]) {
    expect((await request(token, "/tenants")).status).toBe(404);
    expect((await request(token, "/tenants", "POST", {})).status).toBe(404);
    expect(
      (await request(token, `/tenants/${tenantA.id}`, "PATCH", {})).status
    ).toBe(404);
  }
});

test("platform login throttles repeated attempts without blocking enterprise login", async () => {
  const ip = "203.0.113.99";
  for (let index = 0; index < 15; index++) {
    const result = await request(
      null,
      "/platform/login",
      "POST",
      { username: "nonexistent", password: "incorrect-password" },
      ip
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "账号或密码不正确" });
  }
  expect(
    (
      await request(
        null,
        "/platform/login",
        "POST",
        { username: "platform", password: platformPassword },
        ip
      )
    ).status
  ).toBe(429);
  const independentTenantAttempt = await request(
    null,
    "/login",
    "POST",
    { username: "admin", password: passwordA },
    ip,
    "tenant-a.localhost"
  );
  expect(independentTenantAttempt.status).toBe(200);
}, 15000);

test("managed tenant hostnames reject a trailing hyphen before creating accounts", async () => {
  const before = await mockStore.all("SELECT id FROM ep_tenants");
  for (const code of ["tenant-", "-tenant", "a--", "ab"]) {
    const result = await createTenant(code);
    expect(result.status).toBe(400);
  }
  expect(await mockStore.all("SELECT id FROM ep_tenants")).toEqual(before);
});

test("tenant login throttling is isolated between enterprises sharing a client IP", async () => {
  const ip = "203.0.113.100";
  for (let index = 0; index < 15; index++) {
    const result = await request(
      null,
      "/login",
      "POST",
      {
        username: "nonexistent",
        password: "incorrect-password",
      },
      ip,
      "tenant-a.localhost"
    );
    expect(result.status).toBe(401);
  }
  expect(
    (
      await request(
        null,
        "/login",
        "POST",
        {
          username: "admin",
          password: passwordA,
        },
        ip,
        "tenant-a.localhost"
      )
    ).status
  ).toBe(429);
  expect(
    (
      await request(
        null,
        "/login",
        "POST",
        {
          username: "admin",
          password: passwordB,
        },
        ip,
        "tenant-b.localhost"
      )
    ).status
  ).toBe(200);
}, 15000);

test.each([
  ["missing username", { username: undefined }],
  ["non-string username", { username: 42 }],
  ["blank username", { username: "   " }],
  ["short username", { username: "a" }],
  ["invalid username characters", { username: "new user" }],
  ["invalid username prefix", { username: "_new-user" }],
  ["overlong username", { username: "a".repeat(65) }],
  ["missing password", { password: undefined }],
  ["non-string password", { password: { value: passwordA } }],
  ["short password", { password: "short" }],
  ["overlong password", { password: "a".repeat(251) }],
  ["invalid role", { role: "platform_admin" }],
  ["blank name", { name: "   " }],
  ["overlong name", { name: "a".repeat(101) }],
])(
  "invalid new-user %s is rejected without inserting an account",
  async (_label, fields) => {
    const before = await mockStore.all("SELECT id FROM users ORDER BY id");
    const result = await request(adminA.token, "/users", "POST", {
      username: "rejected-user",
      password: passwordA,
      name: "新用户",
      ...fields,
    });
    expect(result.status).toBe(400);
    expect(result.body).toHaveProperty("error", expect.any(String));
    expect(await mockStore.all("SELECT id FROM users ORDER BY id")).toEqual(
      before
    );
  }
);

test.each([
  ["missing username", { password: passwordA }],
  ["non-string username", { username: 42, password: passwordA }],
  ["overlong username", { username: "a".repeat(65), password: passwordA }],
  ["missing password", { username: "admin" }],
  ["non-string password", { username: "admin", password: [passwordA] }],
  ["short password", { username: "admin", password: "short" }],
  ["overlong password", { username: "admin", password: "a".repeat(251) }],
])(
  "tenant and platform login reject %s without issuing a session",
  async (_label, body) => {
    const tenantLogin = await request(
      null,
      "/login",
      "POST",
      body,
      undefined,
      "tenant-a.localhost"
    );
    const platformLogin = await request(null, "/platform/login", "POST", {
      ...body,
      ...(body.username === "admin" ? { username: "platform" } : {}),
      ...(body.password === passwordA ? { password: platformPassword } : {}),
    });
    for (const result of [tenantLogin, platformLogin]) {
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: "账号或密码不正确" });
      expect(result.body).not.toHaveProperty("token");
    }
  }
);

test.each([
  ["invalid role", { role: "platform_admin" }],
  ["non-string role", { role: {} }],
  ["invalid status", { status: "deleted" }],
  ["non-string status", { status: false }],
  ["blank name", { name: "   " }],
  ["non-string name", { name: 42 }],
  ["overlong name", { name: "a".repeat(101) }],
  ["null password", { password: null }],
  ["non-string password", { password: [passwordA] }],
  ["short password", { password: "short" }],
  ["overlong password", { password: "a".repeat(251) }],
])(
  "invalid account update %s leaves the existing identity unchanged",
  async (_label, fields) => {
    const before = await mockStore.one(
      "SELECT * FROM users WHERE id=$1",
      adminA.user.id
    );
    const result = await request(
      adminA.token,
      `/users/${adminA.user.id}`,
      "PATCH",
      fields
    );
    expect(result.status).toBe(400);
    expect(
      await mockStore.one("SELECT * FROM users WHERE id=$1", adminA.user.id)
    ).toEqual(before);
    expect((await request(adminA.token, "/me")).status).toBe(200);
  }
);

test("ordinary members cannot write user or platform management state", async () => {
  const logged = await login("tenant-a", "shared-user", passwordA);
  expect(logged.status).toBe(200);
  const token = logged.body.token;
  const users = await mockStore.all("SELECT * FROM users ORDER BY id");
  const tenants = await mockStore.all("SELECT * FROM ep_tenants ORDER BY id");
  expect(
    (
      await request(token, "/users", "POST", {
        username: "member-must-not-create",
        password: passwordA,
        role: "admin",
      })
    ).status
  ).toBe(403);
  expect(
    (
      await request(token, `/users/${adminA.user.id}`, "PATCH", {
        password: passwordB,
        status: "disabled",
      })
    ).status
  ).toBe(403);
  expect(
    (
      await request(token, "/platform/tenants", "POST", {
        code: "member-must-not-create",
        name: "拒绝创建",
        adminUsername: "admin",
        adminPassword: passwordA,
      })
    ).status
  ).toBe(401);
  expect(await mockStore.all("SELECT * FROM users ORDER BY id")).toEqual(users);
  expect(await mockStore.all("SELECT * FROM ep_tenants ORDER BY id")).toEqual(
    tenants
  );
});

test.each([
  ["missing bearer", () => null],
  ["malformed JWT", () => "not-a-jwt"],
  [
    "missing subject",
    ({ sub: _sub, ...claims }) => jwt.sign(claims, process.env.JWT_SECRET),
  ],
  [
    "empty subject",
    (claims) => jwt.sign({ ...claims, sub: "" }, process.env.JWT_SECRET),
  ],
  [
    "unknown subject",
    (claims) =>
      jwt.sign({ ...claims, sub: "missing-account" }, process.env.JWT_SECRET),
  ],
  [
    "missing version",
    ({ ver: _ver, ...claims }) => jwt.sign(claims, process.env.JWT_SECRET),
  ],
  [
    "noninteger version",
    (claims) => jwt.sign({ ...claims, ver: "1" }, process.env.JWT_SECRET),
  ],
  [
    "stale version",
    (claims) =>
      jwt.sign({ ...claims, ver: claims.ver + 1 }, process.env.JWT_SECRET),
  ],
  [
    "expired token",
    (claims) => jwt.sign({ ...claims, exp: 1 }, process.env.JWT_SECRET),
  ],
  [
    "unsupported algorithm",
    (claims) =>
      jwt.sign(claims, process.env.JWT_SECRET, { algorithm: "HS384" }),
  ],
])(
  "both identities reject %s on reads and writes",
  async (_label, tokenFor) => {
    const tenantToken = tokenFor(jwt.decode(adminA.token));
    const platformToken = tokenFor(jwt.decode(platform.token));
    expect((await request(tenantToken, "/me")).status).toBe(401);
    expect(
      (
        await request(tenantToken, "/users", "POST", {
          username: "invalid-token-user",
          password: passwordA,
        })
      ).status
    ).toBe(401);
    expect((await request(platformToken, "/platform/me")).status).toBe(401);
    expect(
      (
        await request(platformToken, "/platform/tenants", "POST", {
          code: "invalid-token-tenant",
          name: "拒绝创建",
          adminUsername: "admin",
          adminPassword: passwordA,
        })
      ).status
    ).toBe(401);
    expect(
      await mockStore.one(
        "SELECT id FROM users WHERE username='invalid-token-user'"
      )
    ).toBeNull();
    expect(
      await mockStore.one(
        "SELECT id FROM ep_tenants WHERE code='invalid-token-tenant'"
      )
    ).toBeNull();
  }
);

test("a disabled platform account cannot log in or use an already issued token", async () => {
  await mockStore.run(
    "UPDATE ep_platform_accounts SET status='disabled' WHERE id=$1",
    platform.user.id
  );
  try {
    const logged = await request(null, "/platform/login", "POST", {
      username: "platform",
      password: platformPassword,
    });
    expect(logged.status).toBe(401);
    expect(logged.body).toEqual({ error: "账号或密码不正确" });
    expect((await request(platform.token, "/platform/me")).status).toBe(401);
    expect((await createTenant("disabled-platform-write")).status).toBe(401);
    expect(
      await mockStore.one(
        "SELECT id FROM ep_tenants WHERE code='disabled-platform-write'"
      )
    ).toBeNull();
    expect((await request(adminA.token, "/me")).status).toBe(200);
  } finally {
    await mockStore.run(
      "UPDATE ep_platform_accounts SET status='active' WHERE id=$1",
      platform.user.id
    );
  }
});

test("a queued platform write rechecks the account version inside its transaction", async () => {
  const original = mockStore.transaction;
  const version = jwt.decode(platform.token).ver;
  const hook = jest
    .spyOn(mockStore, "transaction")
    .mockImplementationOnce(async (fn) => {
      await mockStore.run(
        'UPDATE ep_platform_accounts SET "authVersion"="authVersion"+1 WHERE id=$1',
        platform.user.id
      );
      return original(fn);
    });
  try {
    expect((await createTenant("revoked-platform-write")).status).toBe(401);
    expect(
      await mockStore.one(
        "SELECT id FROM ep_tenants WHERE code='revoked-platform-write'"
      )
    ).toBeNull();
    expect((await request(platform.token, "/platform/me")).status).toBe(401);
    const fresh = await request(null, "/platform/login", "POST", {
      username: "platform",
      password: platformPassword,
    });
    expect(fresh.status).toBe(200);
    expect(jwt.decode(fresh.body.token).ver).toBe(version + 1);
    expect((await request(fresh.body.token, "/platform/me")).status).toBe(200);
  } finally {
    hook.mockRestore();
    await mockStore.run(
      'UPDATE ep_platform_accounts SET "authVersion"=$1 WHERE id=$2',
      version,
      platform.user.id
    );
  }
});

test("transaction context validation reloads platform identity and rejects absent or mismatched tenant contexts", async () => {
  const current = await auth.context(adminA.user.id);
  for (const ctx of [null, { ...current, tenantId: tenantB.id }])
    await expect(auth.refreshContext(ctx)).rejects.toMatchObject({
      status: 401,
    });
  await expect(
    auth.refreshContext({ identity: "platform", userId: platform.user.id })
  ).resolves.toMatchObject({
    identity: "platform",
    userId: platform.user.id,
    role: "platform_admin",
  });
  await expect(
    auth.refreshContext({ identity: "platform", userId: "missing" })
  ).rejects.toMatchObject({ status: 401 });
  await expect(auth.refreshContext(current)).resolves.toMatchObject({
    userId: adminA.user.id,
    tenantId: tenantA.id,
  });
  await expect(auth.context("missing-user")).rejects.toMatchObject({
    status: 401,
  });
});

test("missing signing configuration prevents registration writes", async () => {
  const configured = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    const before = await mockStore.all("SELECT id FROM users ORDER BY id");
    const result = await request(
      null,
      "/register",
      "POST",
      {
        username: "no-secret-account",
        password: platformPassword,
      },
      undefined,
      "tenant-a.localhost"
    );
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "服务认证密钥未配置" });
    expect(await mockStore.all("SELECT id FROM users ORDER BY id")).toEqual(
      before
    );
  } finally {
    process.env.JWT_SECRET = configured;
  }
});

test.each([
  "tenantId",
  "tenantCode",
  "identity",
  "platformRole",
  "platformAdmin",
])(
  "account writes reject caller supplied %s without changing enterprise ownership",
  async (key) => {
    const before = await mockStore.all("SELECT * FROM users ORDER BY id");
    expect(
      (
        await request(adminA.token, "/users", "POST", {
          username: "ownership-rejected",
          password: passwordA,
          [key]: "forged",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request(adminA.token, "/users/" + adminA.user.id, "PATCH", {
          name: "must-not-change",
          [key]: "forged",
        })
      ).status
    ).toBe(400);
    expect(await mockStore.all("SELECT * FROM users ORDER BY id")).toEqual(
      before
    );
  }
);

test("platform can review and manage private resources without granting ordinary administrators content access", async () => {
  const stamp = mockStore.now();
  const library = await mockStore.orm.ep_libraries.create({
    data: {
      id: "review-library",
      tenantId: tenantA.id,
      name: "Private review",
      createdBy: String(adminA.user.id),
      createdAt: stamp,
      updatedAt: stamp,
      grants: { create: { id: "review-grant", userId: adminA.user.id } },
    },
  });
  await mockStore.orm.documents.create({
    data: {
      id: "review-document",
      tenantId: tenantA.id,
      libraryId: library.id,
      title: "Private content",
      inputType: "text",
      content: "platform review body",
      status: "ready",
      createdBy: String(adminA.user.id),
      updatedBy: String(adminA.user.id),
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  const thread = (
    await request(adminA.token, "/conversations", "POST", {
      title: "Personal review",
    })
  ).body.conversation;
  await mockStore.orm.chats.create({
    data: {
      id: 901,
      tenantId: tenantA.id,
      userId: adminA.user.id,
      thread_id: thread.id,
      prompt: "private question",
      response: JSON.stringify({ text: "private answer", sources: [] }),
      createdAt: new Date(stamp),
      lastUpdatedAt: new Date(stamp),
    },
  });
  for (const route of [
    "/platform/libraries",
    "/platform/documents",
    "/platform/documents/review-document",
    "/platform/conversations",
    `/platform/conversations/${thread.id}`,
  ]) {
    expect((await request(null, route)).status).toBe(401);
    expect((await request(adminA.token, route)).status).toBe(401);
    expect((await request(adminB.token, route)).status).toBe(401);
    expect((await request(platform.token, route)).status).toBe(200);
  }
  expect(
    (
      await request(
        platform.token,
        `/platform/libraries?tenantId=${tenantA.id}`
      )
    ).body.libraries
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: library.id, canWrite: true }),
    ])
  );
  expect(
    (
      await request(
        platform.token,
        `/platform/documents?tenantId=${tenantB.id}`
      )
    ).body.documents
  ).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "review-document" })])
  );
  expect(
    (await request(platform.token, "/platform/documents/review-document")).body
      .document
  ).toMatchObject({ content: "platform review body", canWrite: true });
  expect(
    (
      await request(platform.token, `/platform/conversations/${thread.id}`)
    ).body.messages.map((row) => row.content)
  ).toEqual(["private question", "private answer"]);
  expect(
    (
      await request(
        platform.token,
        "/platform/documents/review-document",
        "PATCH",
        { title: "Platform managed title" }
      )
    ).status
  ).toBe(200);
  expect(
    (await request(platform.token, "/platform/documents/review-document")).body
      .document
  ).toMatchObject({
    title: "Platform managed title",
    content: "platform review body",
  });
  expect(
    (
      await request(
        platform.token,
        `/platform/conversations/${thread.id}/messages`,
        "POST",
        { message: "forged" }
      )
    ).status
  ).toBe(404);
  expect(
    (await request(adminB.token, "/documents/review-document")).status
  ).toBe(404);
  expect(
    (await request(adminB.token, `/conversations/${thread.id}`)).status
  ).toBe(404);
});

test("top administration manages users within the explicit enterprise including its final administrator", async () => {
  const createdTenant = await createTenant("platform-user-management");
  expect(createdTenant.status).toBe(201);
  const tenant = createdTenant.body.tenant;
  const rootPath = `/platform/tenants/${tenant.id}/users`;
  const initial = (await request(platform.token, rootPath)).body.users;
  expect(initial).toHaveLength(1);
  const first = initial[0];
  expect(first).toMatchObject({ username: "admin", role: "admin" });
  expect((await request(adminA.token, rootPath)).status).toBe(401);
  expect(
    (
      await request(platform.token, `${rootPath}/${first.id}`, "PATCH", {
        status: "disabled",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request(platform.token, `${rootPath}/${first.id}`, "PATCH", {
        status: "active",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request(platform.token, rootPath, "POST", {
        username: "another-admin",
        name: "Second",
        password: passwordA,
        role: "admin",
        tenantId: tenantA.id,
      })
    ).status
  ).toBe(400);
  const second = await request(platform.token, rootPath, "POST", {
    username: "another-admin",
    name: "Second",
    password: passwordA,
    role: "admin",
  });
  expect(second.status).toBe(201);
  expect(
    (await request(platform.token, rootPath)).body.users.find(
      (user) => user.id === second.body.user.id
    )
  ).toMatchObject({
    username: "another-admin",
    role: "admin",
  });
  expect(
    await mockFixture.prisma.users.findUnique({
      where: { id: second.body.user.id },
      select: { tenantId: true },
    })
  ).toEqual({ tenantId: tenant.id });
  expect(
    (
      await request(platform.token, `${rootPath}/${adminA.user.id}`, "PATCH", {
        status: "disabled",
      })
    ).status
  ).toBe(404);
  expect(
    (
      await request(platform.token, `${rootPath}/${first.id}`, "PATCH", {
        role: "user",
      })
    ).status
  ).toBe(200);
  expect(
    (
      await request(
        platform.token,
        `${rootPath}/${second.body.user.id}`,
        "PATCH",
        { role: "user" }
      )
    ).status
  ).toBe(200);
  expect(
    (
      await request(
        platform.token,
        `${rootPath}/${second.body.user.id}`,
        "PATCH",
        { status: "disabled" }
      )
    ).status
  ).toBe(200);
  expect((await request(platform.token, rootPath)).body.users).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: first.id, role: "user", status: "active" }),
      expect.objectContaining({
        id: second.body.user.id,
        role: "user",
        status: "disabled",
      }),
    ])
  );
});
