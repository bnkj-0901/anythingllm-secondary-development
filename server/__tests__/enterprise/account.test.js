/* global jest, beforeAll, afterAll, test, expect */
const express = require("express");
const jwt = require("jsonwebtoken");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPostgresFixture } = require("./postgres-fixture.cjs");
const { requestJson } = require("./http-test-client.cjs");
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
const auth = require("../../enterprise/auth");
const { registerAuth } = auth;
let listener,
  base,
  saved,
  directory,
  accountA,
  accountB,
  ip = 0;
const password = "Original-Password-2026!";
function request(host, route, body, token, method = "POST") {
  const options = {
    method,
    headers: {
      host,
      "content-type": "application/json",
      "x-forwarded-for": `198.51.100.${++ip}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  if (route.endsWith("/avatar") && method === "GET")
    return new Promise((resolve, reject) => {
      const req = http.request(`${base}${route}`, options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          bytes: Buffer.concat(chunks),
        }));
      });
      req.on("error", reject);
      req.end();
    });
  return requestJson(`${base}${route}`, options);
}
beforeAll(async () => {
  const keys = [
    "JWT_SECRET",
    "PLATFORM_HOSTS",
    "TENANT_BASE_DOMAIN",
    "STORAGE_DIR",
  ];
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.JWT_SECRET = "account-regression-secret";
  delete process.env.PLATFORM_HOSTS;
  delete process.env.TENANT_BASE_DOMAIN;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "anythingllm-account-"));
  process.env.STORAGE_DIR = directory;
  mockFixture = await createPostgresFixture();
  const stamp = new Date().toISOString();
  for (const id of ["a", "b"])
    await mockFixture.prisma.ep_tenants.create({
      data: {
        id,
        code: `company-${id}`,
        name: id,
        hostname: `company-${id}.localhost`,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  const router = express.Router();
  registerAuth(router);
  app.use(router);
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  app.use((error, _req, res, _next) =>
    res
      .status(
        error.code === "P2002" || error.meta?.code === "23505"
          ? 409
          : error.status || 500
      )
      .json({ error: error.message })
  );
  listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  base = `http://127.0.0.1:${listener.address().port}`;
  const a = await request("company-a.localhost", "/register", {
    username: "Same-User",
    password,
  });
  const b = await request("company-b.localhost", "/register", {
    username: "same-user",
    password,
  });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  accountA = a.body;
  accountB = b.body;
});
afterAll(async () => {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await mockFixture?.cleanup();
  fs.rmSync(directory, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved || {}))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
test("registration binds the resolved enterprise and issues only the user role with one set of recovery codes", async () => {
  expect(accountA).toMatchObject({
    role: "user",
    tenant: { id: "a" },
    user: { username: "same-user", bio: "", pfpFilename: null, wechatBound: false },
  });
  expect(accountB.tenant.id).toBe("b");
  expect(accountA.user.id).not.toBe(accountB.user.id);
  expect(accountA.recoveryCodes).toHaveLength(4);
  expect(new Set(accountA.recoveryCodes).size).toBe(4);
  expect(accountA.user).not.toHaveProperty("passwordHash");
  const rows = await mockFixture.prisma.recovery_codes.findMany({
    where: { user_id: accountA.user.id },
  });
  expect(rows).toHaveLength(4);
  expect(
    rows.every((row) => !accountA.recoveryCodes.includes(row.code_hash))
  ).toBe(true);
  const login = await request("company-a.localhost", "/login", {
    username: "same-user",
    password,
  });
  expect(login.status).toBe(200);
  expect(login.body).not.toHaveProperty("recoveryCodes");
  expect(
    (
      await request("company-a.localhost", "/register", {
        username: "same-user",
        password,
      })
    ).status
  ).toBe(409);
});
test("registration rejects caller roles, ownership and unknown or platform domains", async () => {
  for (const fields of [
    { role: "admin" },
    { role: "user" },
    { tenantId: "b" },
    { identity: "platform" },
  ])
    expect(
      (
        await request("company-a.localhost", "/register", {
          username: "cannot-escalate",
          password,
          ...fields,
        })
      ).status
    ).toBe(400);
  for (const host of ["localhost", "unknown.localhost"])
    expect(
      (await request(host, "/register", { username: "unknown", password }))
        .status
    ).toBe(403);
  expect(
    (await request("localhost", "/setup", { username: "admin", password }))
      .status
  ).toBe(404);
});
test("concurrent first logins issue a single set of recovery codes and disabled accounts cannot recover", async () => {
  const stamp = new Date().toISOString();
  const id = 1001;
  await mockFixture.prisma.users.create({
    data: {
      id,
      tenantId: "a",
      username: "first-login",
      name: "First login",
      passwordHash: await require("bcryptjs").hash(password, 4),
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  const responses = await Promise.all(
    [1, 2].map(() =>
      request("company-a.localhost", "/login", {
        username: "first-login",
        password,
      })
    )
  );
  expect(responses.map((row) => row.status)).toEqual([200, 200]);
  const issued = responses.filter((row) => row.body.recoveryCodes);
  expect(issued).toHaveLength(1);
  expect(issued[0].body.recoveryCodes).toHaveLength(4);
  expect(
    await mockFixture.prisma.recovery_codes.count({ where: { user_id: id } })
  ).toBe(4);
  await mockFixture.prisma.users.update({
    where: { id },
    data: { status: "disabled" },
  });
  expect(
    (
      await request("company-a.localhost", "/recover-account", {
        username: "first-login",
        recoveryCodes: issued[0].body.recoveryCodes.slice(0, 2),
      })
    ).status
  ).toBe(400);
});
test("profile changes preserve ownership, normalize usernames, enforce original validation and renew signed sessions", async () => {
  const updated = await request(
    "company-a.localhost",
    "/me",
    { username: "Edited-User", name: "  用户昵称  ", bio: "Company A profile" },
    accountA.token,
    "PATCH"
  );
  expect(updated.status).toBe(200);
  expect(updated.body).toMatchObject({
    success: true,
    role: "user",
    tenant: { id: "a" },
    user: {
      id: accountA.user.id,
      username: "edited-user",
      name: "用户昵称",
      bio: "Company A profile",
      wechatBound: false,
    },
  });
  expect(updated.body.user).not.toHaveProperty("passwordHash");
  accountA = { ...accountA, ...updated.body };
  for (const fields of [
    { tenantId: "b" },
    { role: "admin" },
    { pfpFilename: "../escape" },
    { bio: "x".repeat(1001) },
    { username: "_invalid" },
    { name: "   " },
    { name: 42 },
    { name: "x".repeat(81) },
  ])
    expect(
      (
        await request(
          "company-a.localhost",
          "/me",
          fields,
          accountA.token,
          "PATCH"
        )
      ).status
    ).toBe(400);
  expect(
    (
      await request(
        "company-b.localhost",
        "/me",
        { bio: "stolen" },
        accountA.token,
        "PATCH"
      )
    ).status
  ).toBe(401);
  expect(
    (
      await mockFixture.prisma.users.findUnique({
        where: { id: accountB.user.id },
      })
    ).bio
  ).toBe("");
});

test("a display-name change preserves credentials, WeChat binding and existing sessions", async () => {
  const before = await mockFixture.prisma.users.findUnique({
    where: { id: accountA.user.id },
  });
  const result = await request(
    "company-a.localhost", "/me", { name: "  张三  " }, accountA.token, "PATCH"
  );
  expect(result.status).toBe(200);
  expect(result.body.user.name).toBe("张三");
  const after = await mockFixture.prisma.users.findUnique({
    where: { id: accountA.user.id },
  });
  expect(after).toMatchObject({
    username: before.username,
    passwordHash: before.passwordHash,
    wechatIdentity: before.wechatIdentity,
    authVersion: before.authVersion,
    bio: before.bio,
  });
  expect((await request(
    "company-a.localhost", "/me", undefined, accountA.token, "GET"
  )).body.user.name).toBe("张三");
  accountA = { ...accountA, ...result.body };
});
test("original configurable password complexity applies and successful changes revoke old tokens while renewing this session", async () => {
  const old = process.env.PASSWORDNUMERIC;
  process.env.PASSWORDNUMERIC = "1";
  try {
    expect(
      (
        await request(
          "company-a.localhost",
          "/me",
          { password: "long-but-no-number" },
          accountA.token,
          "PATCH"
        )
      ).status
    ).toBe(400);
  } finally {
    if (old === undefined) delete process.env.PASSWORDNUMERIC;
    else process.env.PASSWORDNUMERIC = old;
  }
  const prior = accountA.token;
  const changed = await request(
    "company-a.localhost",
    "/me",
    { password: "New-Password-2026!" },
    prior,
    "PATCH"
  );
  expect(changed.status).toBe(200);
  expect(jwt.decode(changed.body.token).ver).toBe(jwt.decode(prior).ver + 1);
  expect(
    (await request("company-a.localhost", "/me", undefined, prior, "GET"))
      .status
  ).toBe(401);
  accountA = { ...accountA, ...changed.body };
  expect(
    (
      await request(
        "company-a.localhost",
        "/me",
        undefined,
        accountA.token,
        "GET"
      )
    ).status
  ).toBe(200);
});
test("recovery codes and reset tokens are bound to the host tenant, expire, consume once and revoke sessions", async () => {
  const codes = accountA.recoveryCodes.slice(0, 2);
  expect(
    (
      await request("company-b.localhost", "/recover-account", {
        username: "edited-user",
        recoveryCodes: codes,
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("company-a.localhost", "/recover-account", {
        username: "edited-user",
        recoveryCodes: [codes[0], codes[0]],
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request("company-a.localhost", "/recover-account", {
        username: "edited-user",
        recoveryCodes: {},
      })
    ).status
  ).toBe(400);
  const recovered = await request("company-a.localhost", "/recover-account", {
    username: "edited-user",
    recoveryCodes: codes,
  });
  expect(recovered.status).toBe(200);
  const token = recovered.body.resetToken;
  expect(token).toEqual(expect.any(String));
  const resetBody = {
    token,
    newPassword: "Recovered-Password-2026!",
    confirmPassword: "Recovered-Password-2026!",
  };
  expect(
    (await request("company-b.localhost", "/reset-password", resetBody)).status
  ).toBe(400);
  expect(
    (
      await request("company-a.localhost", "/reset-password", {
        ...resetBody,
        confirmPassword: "different",
      })
    ).status
  ).toBe(400);
  await mockFixture.prisma.password_reset_tokens.update({
    where: { token },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  expect(
    (await request("company-a.localhost", "/reset-password", resetBody)).status
  ).toBe(400);
  await mockFixture.prisma.password_reset_tokens.update({
    where: { token },
    data: { expiresAt: new Date(Date.now() + 600000) },
  });
  expect(
    (await request("company-a.localhost", "/reset-password", resetBody)).status
  ).toBe(200);
  expect(
    (await request("company-a.localhost", "/reset-password", resetBody)).status
  ).toBe(400);
  expect(
    (
      await request(
        "company-a.localhost",
        "/me",
        undefined,
        accountA.token,
        "GET"
      )
    ).status
  ).toBe(401);
  expect(
    await mockFixture.prisma.recovery_codes.count({
      where: { user_id: accountA.user.id },
    })
  ).toBe(0);
  const login = await request("company-a.localhost", "/login", {
    username: "edited-user",
    password: resetBody.newPassword,
  });
  expect(login.status).toBe(200);
  expect(login.body.recoveryCodes).toHaveLength(4);
  accountA = login.body;
});
test("avatars preserve original file storage and restrict upload/read/removal to their owner", async () => {
  const upload = async (host, token, buffer) => {
    const boundary = "account-avatar-boundary";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return requestJson(`${base}/me/avatar`, {
      method: "POST",
      headers: {
        host,
        authorization: `Bearer ${token}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
  };
  const png = await require("sharp")({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const uploaded = await upload("company-a.localhost", accountA.token, png);
  expect(uploaded.status).toBe(200);
  const file = path.join(directory, "assets/pfp", uploaded.body.pfpFilename);
  expect(fs.existsSync(file)).toBe(true);
  for (const invalid of [
    Buffer.from("<html><script>alert(1)</script></html>"),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>'),
  ]) {
    const rejected = await upload("company-a.localhost", accountA.token, invalid);
    expect(rejected.status).toBe(415);
    expect(fs.readdirSync(path.dirname(file))).toEqual([uploaded.body.pfpFilename]);
  }
  expect(
    (
      await request(
        "company-a.localhost",
        "/me/avatar",
        undefined,
        accountA.token,
        "GET"
      )
    ).status
  ).toBe(200);
  expect(
    (
      await request(
        "company-a.localhost",
        "/me",
        undefined,
        accountA.token,
        "GET"
      )
    ).body.user.pfpFilename
  ).toBe(uploaded.body.pfpFilename);
  expect(
    (
      await request(
        "company-b.localhost",
        "/me/avatar",
        undefined,
        accountA.token,
        "GET"
      )
    ).status
  ).toBe(401);
  expect(
    (
      await request(
        "company-b.localhost",
        "/me/avatar",
        undefined,
        accountB.token,
        "GET"
      )
    ).status
  ).toBe(204);
  expect(
    (
      await request(
        "company-a.localhost",
        "/me/avatar",
        undefined,
        accountA.token,
        "DELETE"
      )
    ).status
  ).toBe(200);
  expect(fs.existsSync(file)).toBe(false);
  expect(
    (
      await request(
        "company-a.localhost",
        "/me/avatar",
        undefined,
        accountA.token,
        "GET"
      )
    ).status
  ).toBe(204);
});

test("user management exposes profile metadata and avatars only to the owning tenant's administrator or the top administrator", async () => {
  const managers = {};
  for (const tenantId of ["a", "b"]) {
    const user = await mockFixture.prisma.users.create({
      data: {
        tenantId, username: `avatar-admin-${tenantId}`, name: "管理员",
        role: "admin", passwordHash: "unused",
      },
    });
    managers[tenantId] = auth.signed(await auth.context(user.id)).token;
  }
  const stamp = new Date().toISOString();
  await mockFixture.prisma.ep_platform_accounts.create({
    data: {
      id: "avatar-operator", username: "avatar-operator", name: "平台管理员",
      passwordHash: "unused", createdAt: stamp, updatedAt: stamp,
    },
  });
  const platformToken = auth.signed(await auth.platformContext("avatar-operator")).token;
  const filename = "aabbccdd-1122-3344-5566-778899aabbcc.png";
  const png = await require("sharp")({
    create: { width: 2, height: 2, channels: 3, background: "blue" },
  }).png().toBuffer();
  fs.mkdirSync(path.join(directory, "assets/pfp"), { recursive: true });
  fs.writeFileSync(path.join(directory, "assets/pfp", filename), png);
  const target = await mockFixture.prisma.users.create({
    data: {
      tenantId: "a", username: "avatar-target", name: "可识别昵称",
      passwordHash: "unused", pfpFilename: filename,
      wechatIdentity: "wx-profile-test:private-openid",
    },
  });
  const route = `/users/${target.id}/avatar`;
  const platformRoute = `/platform/tenants/a${route}`;
  for (const [host, token, path] of [
    ["company-a.localhost", managers.a, route],
    ["localhost", platformToken, platformRoute],
  ]) {
    const result = await request(host, path, undefined, token, "GET");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.bytes).toEqual(png);
  }
  for (const [host, token, path, status] of [
    ["company-a.localhost", accountA.token, route, 403],
    ["company-a.localhost", null, route, 401],
    ["company-b.localhost", managers.b, route, 404],
    ["company-b.localhost", managers.a, route, 401],
    ["localhost", platformToken, `/platform/tenants/b${route}`, 404],
    ["company-a.localhost", managers.a, platformRoute, 401],
    ["company-a.localhost", managers.a, "/users/not-a-user/avatar", 404],
  ])
    expect((await request(host, path, undefined, token, "GET")).status).toBe(status);

  for (const [host, token, listRoute] of [
    ["company-a.localhost", managers.a, "/users"],
    ["localhost", platformToken, "/platform/tenants/a/users"],
  ]) {
    const result = await request(host, listRoute, undefined, token, "GET");
    expect(result.status).toBe(200);
    expect(result.body.users.find((user) => user.id === target.id)).toMatchObject({
      name: "可识别昵称", pfpFilename: filename, wechatBound: true,
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(result.body)).not.toMatch(/private-openid|passwordHash|wechatIdentity/);
  }

  const targetSession = auth.signed(await auth.context(target.id));
  expect(targetSession.user.wechatBound).toBe(true);
  expect(JSON.stringify(targetSession)).not.toContain("private-openid");
  for (const pfpFilename of [null, "../private.png", "deadbeef.png"]) {
    await mockFixture.prisma.users.update({ where: { id: target.id }, data: { pfpFilename } });
    const result = await request("company-a.localhost", route, undefined, managers.a, "GET");
    expect(result.status).toBe(204);
    expect(result.headers["cache-control"]).toBe("private, no-store");
  }
});
