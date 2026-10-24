/* global jest, beforeAll, afterAll, test, expect */
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { requestJson } = require("./http-test-client.cjs");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
let mockFixture;
const mockStore = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "orm"
        ? mockFixture.db.orm
        : (...args) => mockFixture.db[key](...args),
  }
);
jest.mock("../../enterprise/store", () => mockStore);
const { registerAuth } = require("../../enterprise/auth");
const {
  normalizeHostname,
  resolveSite,
  routingConfig,
  tenantEntry,
} = require("../../enterprise/domains");

const password = "Domain-Login-2026!";
const stamp = "2026-10-21T00:00:00.000Z";
let listener, base, platform, tokenA, tokenB, previous;
let ipNumber = 1;
const envKeys = [
  "NODE_ENV",
  "JWT_SECRET",
  "TENANT_BASE_DOMAIN",
  "PLATFORM_HOSTS",
  "TENANT_WEB_PORT",
  "TENANT_WEB_PROTOCOL",
];
function signed(id, identity, tenantId) {
  return jwt.sign(
    { identity, ver: 1, ...(tenantId ? { tenantId } : {}) },
    process.env.JWT_SECRET,
    {
      subject: String(id),
      audience:
        identity === "platform"
          ? "enterprise-platform-v1"
          : "enterprise-tenant-v1",
    }
  );
}
function request(host, token, route, method = "GET", body, headers = {}) {
  return requestJson(`${base}${route}`, {
    method,
    headers: {
      host,
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${ipNumber++}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeAll(async () => {
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "isolated-domain-jwt";
  delete process.env.TENANT_BASE_DOMAIN;
  delete process.env.PLATFORM_HOSTS;
  delete process.env.TENANT_WEB_PORT;
  delete process.env.TENANT_WEB_PROTOCOL;
  mockFixture = await createPostgresFixture();
  for (const [id, status] of [
    ["a", "active"],
    ["b", "active"],
    ["disabled", "disabled"],
  ])
    await mockStore.run(
      'INSERT INTO ep_tenants(id,code,name,hostname,status,"createdAt","updatedAt") VALUES($1,$2,$3,$2 || \'.localhost\',$4,$5,$6)',
      id,
      `company-${id}`,
      `Company ${id}`,
      status,
      stamp,
      stamp
    );
  const hash = await bcrypt.hash(password, 4);
  for (const [id, tenant, role] of [
    [101, "a", "admin"],
    [102, "b", "admin"],
    [103, "a", "user"],
  ])
    await mockStore.run(
      'INSERT INTO users(id,"tenantId",username,name,"passwordHash",role,"createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,$5,$6,$7::timestamp,$8::timestamp)',
      id,
      tenant,
      id === 103 ? "user" : "admin",
      String(id),
      hash,
      role,
      stamp,
      stamp
    );
  await mockStore.run(
    "INSERT INTO ep_platform_accounts(id,username,name,\"passwordHash\",\"createdAt\",\"updatedAt\") VALUES('platform','admin','Platform',$1,$2,$3)",
    hash,
    stamp,
    stamp
  );
  platform = signed("platform", "platform");
  tokenA = signed(101, "tenant", "a");
  tokenB = signed(102, "tenant", "b");
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  const router = express.Router();
  registerAuth(router);
  app.use(router);
  app.use((_req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use((error, _req, res, _next) => {
    const conflict =
      ["P2002", "P2034", "23505", "40001"].includes(error.code) ||
      ["23505", "40001"].includes(error.meta?.code);
    res
      .status(conflict ? 409 : error.status || 500)
      .json({ error: conflict ? "配置冲突" : error.message });
  });
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
}, 20000);
afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  for (const [key, value] of Object.entries(previous || {}))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

test("top administrator can manage another enterprise's last administrator without borrowing its identity", async () => {
  const result = await request(
    "localhost",
    platform,
    "/platform/tenants/b/users/102",
    "PATCH",
    { status: "disabled" }
  );
  expect(result.status).toBe(200);
  expect(
    await mockFixture.db.one(
      'SELECT status,"authVersion" FROM users WHERE id=102'
    )
  ).toEqual({ status: "disabled", authVersion: 2 });
  expect((await request("company-b.localhost", tokenB, "/me")).status).toBe(
    401
  );
  expect(
    (
      await request(
        "localhost",
        platform,
        "/platform/tenants/b/users/102",
        "PATCH",
        { status: "active" }
      )
    ).status
  ).toBe(200);
  // Other tests deliberately reuse the original token; restore fixture state.
  await mockFixture.db.run('UPDATE users SET "authVersion"=1 WHERE id=102');
});

test("hostname parsing normalizes case, terminal dots, ports, IPv6 and IDN without accepting URL injection", () => {
  for (const [input, expected] of [
    ["COMPANY-A.LocalHost.:3000", "company-a.localhost"],
    ["[::1]:3000", "::1"],
    ["::1", "::1"],
    ["127.0.0.1:3001", "127.0.0.1"],
    ["知识.example", "xn--k7y073b.example"],
  ])
    expect(normalizeHostname(input)).toBe(expected);
  for (const input of [
    undefined,
    [],
    "",
    " host.example",
    "a.example/path",
    "a.example?key=1",
    "user@a.example",
    "a.example#part",
    "a\\example",
    "a..example",
    "-bad.example",
    "a.example:bad",
    "a.example:65536",
    "[::1]:65536",
    "[bad]",
    "[127.0.0.1]",
    `${"x".repeat(254)}.example`,
    "https://a.example",
  ])
    expect(normalizeHostname(input)).toBeNull();
  expect(normalizeHostname("a.example:80", { allowPort: false })).toBeNull();
  expect(normalizeHostname("[::1]:80", { allowPort: false })).toBeNull();
});

test("status resolves only the raw Host and never trusts forwarded hosts, Origin or a tenant query", async () => {
  const status = await request(
    "COMPANY-A.LOCALHOST.:3001",
    null,
    "/status?tenantId=b",
    "GET",
    undefined,
    {
      "x-forwarded-host": "company-b.localhost",
      origin: "https://company-b.localhost",
    }
  );
  expect(status.body.site).toEqual({
    kind: "tenant",
    hostname: "company-a.localhost",
    tenant: { id: "a", code: "company-a", name: "Company a", wechatLoginEnabled: false },
  });
  expect(status.body.routing).toEqual({
    baseDomain: "localhost",
    platformHosts: ["localhost", "127.0.0.1", "::1", "admin.localhost"],
  });
  for (const host of [
    "localhost:3000",
    "127.0.0.1:3001",
    "[::1]:3001",
    "admin.localhost",
  ])
    expect((await request(host, null, "/status")).body.site.kind).toBe(
      "platform"
    );
  for (const host of [
    "missing.localhost",
    "company-disabled.localhost",
    "nested.company-a.localhost",
    "unknown.example",
  ])
    expect((await request(host, null, "/status")).body.site).toEqual({
      kind: "unknown",
      hostname: host,
    });
  const db = { one: jest.fn() };
  expect(
    await resolveSite(
      {
        headers: {
          host: "user@company-a.localhost",
          "x-forwarded-host": "company-a.localhost",
        },
      },
      db
    )
  ).toEqual({ kind: "unknown", hostname: "" });
  expect(db.one).not.toHaveBeenCalled();
});

test("same username logs into the enterprise resolved by host and legacy body identifiers are rejected", async () => {
  for (const [host, id] of [
    ["company-a.localhost", "a"],
    ["company-b.localhost", "b"],
  ]) {
    const response = await request(host, null, "/login", "POST", {
      username: "ADMIN",
      password,
    });
    expect(response.status).toBe(200);
    expect(response.body.tenant.id).toBe(id);
  }
  for (const body of [
    { username: "admin", password, tenantCode: "company-b" },
    { username: "admin", password, tenantId: "b" },
  ])
    expect(
      (await request("company-a.localhost", null, "/login", "POST", body))
        .status
    ).toBe(400);
  for (const host of [
    "localhost",
    "unknown.localhost",
    "company-disabled.localhost",
  ])
    expect(
      (
        await request(host, null, "/login", "POST", {
          username: "admin",
          password,
        })
      ).status
    ).toBe(403);
  expect(
    (
      await request("company-a.localhost", null, "/login", "POST", {
        username: "admin",
        password: "wrong-password",
      })
    ).body
  ).toEqual({ error: "账号或密码不正确" });
});

test("tokens are verified against the current domain on every request and platform endpoints require platform hosts", async () => {
  expect((await request("company-a.localhost", tokenA, "/me")).status).toBe(
    200
  );
  for (const host of ["company-b.localhost", "localhost", "unknown.localhost"])
    expect((await request(host, tokenA, "/me")).status).toBe(401);
  expect((await request("company-a.localhost", tokenB, "/me")).status).toBe(
    401
  );
  expect(
    (await request("company-a.localhost", platform, "/platform/me")).status
  ).toBe(403);
  expect(
    (await request("unknown.localhost", platform, "/platform/tenants")).status
  ).toBe(403);
  for (const route of ["/platform/login"])
    expect(
      (
        await request("company-a.localhost", null, route, "POST", {
          username: "admin",
          password,
        })
      ).status
    ).toBe(403);
  expect(
    (
      await request("localhost", null, "/platform/login", "POST", {
        username: "admin",
        password,
      })
    ).status
  ).toBe(200);
});

test("platform tenant entries use configured trusted hostnames and reserve platform subdomains", async () => {
  const listing = await request(
    "localhost",
    platform,
    "/platform/tenants",
    "GET",
    undefined,
    { "x-forwarded-host": "attacker.example" }
  );
  expect(listing.body.tenants.find((row) => row.id === "a")).toMatchObject({
    webHost: "company-a.localhost",
    webURL: "http://company-a.localhost:3000",
  });
  expect(
    (
      await request("localhost", platform, "/platform/tenants", "POST", {
        code: "admin",
        name: "reserved",
        adminUsername: "admin",
        adminPassword: password,
      })
    ).status
  ).toBe(400);
});

test("production requires explicit routing and builds HTTPS entries without using untrusted request hosts", async () => {
  const keys = [
    "NODE_ENV",
    "TENANT_BASE_DOMAIN",
    "PLATFORM_HOSTS",
    "TENANT_WEB_PORT",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = "production";
    expect(() => routingConfig()).toThrow(/域名入口尚未配置/);
    process.env.TENANT_BASE_DOMAIN = "saas.example.org";
    process.env.PLATFORM_HOSTS = "admin.example.org,admin.example.org";
    expect(routingConfig()).toEqual({
      baseDomain: "saas.example.org",
      platformHosts: ["admin.example.org"],
    });
    expect(
      (await tenantEntry({ id: "a", hostname: "company-a.localhost" })).webURL
    ).toBe("https://company-a.localhost");
    delete process.env.TENANT_BASE_DOMAIN;
    expect(routingConfig().baseDomain).toBeNull();
    process.env.TENANT_WEB_PORT = "8443";
    expect(
      (await tenantEntry({ id: "a", hostname: "company-a.localhost" })).webURL
    ).toBe("https://company-a.localhost:8443");
    process.env.TENANT_WEB_PORT = "malformed";
    await expect(
      tenantEntry({ id: "a", hostname: "company-a.localhost" })
    ).rejects.toThrow(/网页端口配置无效/);
    process.env.PLATFORM_HOSTS = "https://admin.example.org";
    expect(() => routingConfig()).toThrow(/域名入口尚未配置/);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test.each([
  ["production", "http", "", "http://company-a.localhost"],
  ["production", "http", "3001", "http://company-a.localhost:3001"],
  ["production", "https", "8443", "https://company-a.localhost:8443"],
  ["development", "https", "3000", "https://company-a.localhost:3000"],
])(
  "%s tenant entries honor explicit %s deployment protocol and port %s",
  async (mode, protocol, port, expected) => {
    const keys = ["NODE_ENV", "TENANT_WEB_PROTOCOL", "TENANT_WEB_PORT"];
    const saved = Object.fromEntries(
      keys.map((key) => [key, process.env[key]])
    );
    try {
      process.env.NODE_ENV = mode;
      process.env.TENANT_WEB_PROTOCOL = protocol;
      process.env.TENANT_WEB_PORT = port;
      expect(
        (await tenantEntry({ id: "a", hostname: "company-a.localhost" })).webURL
      ).toBe(expected);
    } finally {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  }
);

test("arbitrary domains map to stable tenant IDs and unbound code prefixes never resolve", async () => {
  const response = await request(
    "localhost",
    platform,
    "/platform/tenants",
    "POST",
    {
      code: "internal-company",
      hostname: "Payroll.Customer.Test",
      name: "Customer",
      adminUsername: "admin",
      adminPassword: password,
    }
  );
  expect(response.status).toBe(201);
  expect(response.body.tenant).toMatchObject({
    webHost: "payroll.customer.test",
    hostname: "payroll.customer.test",
  });
  const login = await request("payroll.customer.test", null, "/login", "POST", {
    username: "admin",
    password,
  });
  expect(login.status).toBe(200);
  expect(login.body.tenant.id).toBe(response.body.tenant.id);
  expect(
    (await request("internal-company.localhost", null, "/status")).body.site
      .kind
  ).toBe("unknown");
  const duplicate = await request(
    "localhost",
    platform,
    "/platform/tenants",
    "POST",
    {
      code: "rollback-domain",
      hostname: "payroll.customer.test",
      name: "Duplicate",
      adminUsername: "admin",
      adminPassword: password,
    }
  );
  expect(duplicate.status).toBe(409);
  expect(
    await mockStore.one(
      "SELECT id FROM ep_tenants WHERE code=$1",
      "rollback-domain"
    )
  ).toBeNull();
  for (const hostname of [
    "localhost",
    "admin.localhost",
    "https://customer.test",
    "customer.test:443",
    "127.0.0.1",
  ])
    expect(
      (
        await request("localhost", platform, "/platform/tenants", "POST", {
          hostname,
          name: "Invalid",
          adminUsername: "admin",
          adminPassword: password,
        })
      ).status
    ).toBe(400);
});

test("a tenant has one hostname and changing it invalidates the previous entry", async () => {
  const change = await request(
    "localhost",
    platform,
    "/platform/tenants/a",
    "PATCH",
    { hostname: "New.Customer.Test" }
  );
  expect(change.status).toBe(200);
  expect(change.body.tenant).toMatchObject({
    hostname: "new.customer.test",
    webHost: "new.customer.test",
  });
  expect(change.body.tenant.domains).toBeUndefined();
  expect((await request("company-a.localhost", tokenA, "/me")).status).toBe(
    401
  );
  expect((await request("new.customer.test", tokenA, "/me")).status).toBe(200);
  expect(
    (await request("localhost", platform, "/platform/tenants/a/domains")).status
  ).toBe(404);
  expect(
    (
      await request(
        "localhost",
        platform,
        "/platform/tenants/a/domains",
        "POST",
        { hostname: "alias.customer.test" }
      )
    ).status
  ).toBe(404);
  expect(
    (
      await request("localhost", platform, "/platform/tenants/a", "PATCH", {
        hostname: "company-a.localhost",
      })
    ).status
  ).toBe(200);
});
test("hostname uniqueness rejects reassignment and concurrent writes without losing either tenant", async () => {
  expect(
    (
      await request("localhost", platform, "/platform/tenants/b", "PATCH", {
        hostname: "company-a.localhost",
      })
    ).status
  ).toBe(409);
  const responses = await Promise.all(
    ["a", "b"].map((id) =>
      request("localhost", platform, "/platform/tenants/" + id, "PATCH", {
        hostname: "racing.customer.test",
      })
    )
  );
  expect(responses.map((row) => row.status).sort()).toEqual([200, 409]);
  expect(
    await mockStore.all(
      "SELECT id FROM ep_tenants WHERE hostname=$1",
      "racing.customer.test"
    )
  ).toHaveLength(1);
  for (const id of ["a", "b"])
    await request("localhost", platform, "/platform/tenants/" + id, "PATCH", {
      hostname: "company-" + id + ".localhost",
    });
});
test("only platform operators can change a tenant hostname and invalid updates are atomic", async () => {
  for (const hostname of [
    "localhost",
    "127.0.0.1",
    "https://customer.test",
    "customer.test:443",
    "",
  ]) {
    expect(
      (
        await request("localhost", platform, "/platform/tenants/a", "PATCH", {
          hostname,
        })
      ).status
    ).toBe(400);
  }
  expect(
    (
      await request(
        "company-a.localhost",
        tokenA,
        "/platform/tenants/a",
        "PATCH",
        { hostname: "forbidden.customer.test" }
      )
    ).status
  ).toBe(401);
  expect(
    (
      await request(
        "localhost",
        platform,
        "/platform/tenants/missing",
        "PATCH",
        { hostname: "missing.customer.test" }
      )
    ).status
  ).toBe(404);
  expect((await request("company-a.localhost", tokenA, "/me")).status).toBe(
    200
  );
});
