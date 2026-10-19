const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { requireServer, serverDirectory } = require("../dependencies.cjs");
const express = requireServer("express");
const bcrypt = requireServer("bcryptjs");
const JWT = requireServer("jsonwebtoken");
const { PrismaClient } = requireServer("@prisma/client");
const { User } = requireServer("./models/user");
const { createAccessRouter } = require("../router.cjs");
let directory, prisma, server, base, adminId;
const jwtSecret = crypto.randomBytes(32).toString("hex");
const cipherKey = crypto.randomBytes(32);
const encryption = {
  encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", cipherKey, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  },
  decrypt(text) {
    const buffer = Buffer.from(text, "base64");
    const cipher = crypto.createDecipheriv("aes-256-gcm", cipherKey, buffer.subarray(0, 12));
    cipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString("utf8");
  },
};
const password = "TestOnly!" + crypto.randomBytes(12).toString("hex");
let wxCalls = 0, providerFails = false;
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "kb-access-test-"));
  const file = path.join(directory, "access.db");
  const sqlite = new DatabaseSync(file);
  const migrations = path.join(serverDirectory, "prisma/migrations");
  for (const name of fs.readdirSync(migrations).sort()) {
    const migration = path.join(migrations, name, "migration.sql");
    if (fs.existsSync(migration)) sqlite.exec(fs.readFileSync(migration, "utf8"));
  }
  sqlite.close();
  prisma = new PrismaClient({ datasources: { db: { url: `file:${file.replaceAll("\\", "/")}` } } });
  await prisma.system_settings.create({ data: { label: "multi_user_mode", value: "true" } });
  const admin = await prisma.users.create({ data: { username: "test_admin", password: await bcrypt.hash(password, 4), role: "admin" } });
  adminId = admin.id;
  const app = express();
  app.use(createAccessRouter({ prisma, User, bcrypt, JWT, encryption, jwtSecret, rateLimit: 100,
    fetchImpl: async () => { wxCalls++; return { ok: !providerFails, json: async () => ({ openid: "wx-test-openid", access_token: "provider-secret", scope: "snsapi_base" }) }; },
  }));
  const { installWorkspacePolicy } = require("../space-policy.cjs");
  const Workspace = {
    get: where => prisma.workspaces.findFirst({ where }),
    getWithUser: (user, where) => prisma.workspaces.findFirst({ where: { ...where, ...(user.role === "admin" || user.role === "manager" ? {} : { workspace_users: { some: { user_id: user.id } } }) } }),
    whereWithUser: user => prisma.workspaces.findMany({ where: user.role === "admin" || user.role === "manager" ? {} : { workspace_users: { some: { user_id: user.id } } } }),
  };
  installWorkspacePolicy(Workspace, prisma);
  app.get("/api/workspaces", async (req, res) => res.json({ workspaces: await Workspace.whereWithUser(JWT.verify(req.headers.authorization.split(" ")[1], jwtSecret)) }));
  app.get("/api/workspace/:slug", async (req, res) => res.json({ workspace: await Workspace.getWithUser(JWT.verify(req.headers.authorization.split(" ")[1], jwtSecret), { slug: req.params.slug }) }));
  server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); if (prisma) await prisma.$disconnect(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
async function request(route, { method = "GET", body, cookie, token, origin = base } = {}) {
  return fetch(base + route, { method, redirect: "manual", headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
function adminToken() { return JWT.sign({ id: adminId }, jwtSecret, { expiresIn: "5m" }); }

test("new registrations always have ordinary role and no workspace membership", async () => {
  const response = await request("/api/access/register", { method: "POST", body: { username: "new_member", password, confirmPassword: password, role: "admin", workspaceIds: [1] } });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.loginPath, /^\/sso\/simple\?token=/);
  assert.equal(result.user.role, "default");
  assert.equal(result.user.password, undefined);
  const user = await prisma.users.findUnique({ where: { username: "new_member" } });
  assert.notEqual(user.password, password);
  assert.equal(await bcrypt.compare(password, user.password), true);
  assert.equal(await prisma.workspace_users.count({ where: { user_id: user.id } }), 0);
});
test("duplicate usernames and invalid passwords are rejected without extra users", async () => {
  const duplicate = await request("/api/access/register", { method: "POST", body: { username: "new_member", password, confirmPassword: password } });
  assert.equal(duplicate.status, 409);
  for (const body of [{ username: "invalid_user", password: "short", confirmPassword: "short" }, { username: "another_user", password, confirmPassword: "other" }]) {
    assert.equal((await request("/api/access/register", { method: "POST", body })).status, 422);
  }
  assert.equal(await prisma.users.count(), 2);
});
test("registration rejects cross-origin submissions", async () => {
  assert.equal((await request("/api/access/register", { method: "POST", origin: "https://attacker.invalid", body: { username: "evil", password, confirmPassword: password } })).status, 403);
});
test("configuration requires an active admin and never returns AppSecret", async () => {
  assert.equal((await request("/api/access/admin/config")).status, 401);
  const ordinary = await prisma.users.findUnique({ where: { username: "new_member" } });
  const token = JWT.sign({ id: ordinary.id }, jwtSecret);
  assert.equal((await request("/api/access/admin/config", { token })).status, 403);
  const saved = await request("/api/access/admin/config", { method: "PUT", token: adminToken(), body: { registrationEnabled: true, publicUrl: "https://knowledge.example.com", wechatH5: { appId: "wx_test", appSecret: "secret-value" }, wechatWeb: { appId: "", appSecret: "" } } });
  assert.equal(saved.status, 200);
  const visible = await saved.text();
  assert.equal(visible.includes("secret-value"), false);
  assert.equal(JSON.parse(visible).wechatH5.secretConfigured, true);
  const stored = await prisma.system_settings.findUnique({ where: { label: "kb_access_config" } });
  assert.equal(stored.value.includes("secret-value"), false);
});
test("vision configuration is admin-only, source-checked, encrypted and never returns API keys", async () => {
  assert.equal((await request("/api/access/admin/vision")).status, 401);
  const ordinary = await prisma.users.findUnique({ where: { username: "new_member" } }), token = JWT.sign({ id: ordinary.id }, jwtSecret);
  assert.equal((await request("/api/access/admin/vision", { token })).status, 403);
  assert.equal((await request("/api/access/admin/vision", { method: "PUT", token, body: { enabled: true } })).status, 403);
  const body = { enabled: true, keySource: "custom", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "vision-test-secret", model: "qwen3-vl-plus" };
  assert.equal((await request("/api/access/admin/vision", { method: "PUT", token: adminToken(), origin: "https://evil.invalid", body })).status, 403);
  const result = await request("/api/access/admin/vision", { method: "PUT", token: adminToken(), body });
  assert.equal(result.status, 200); assert.equal((await result.text()).includes("vision-test-secret"), false);
  const stored = await prisma.system_settings.findUnique({ where: { label: "kb_access_vision" } });
  assert.equal(stored.value.includes("vision-test-secret"), false);
});
test("closing registration stops new users and keeps existing login working", async () => {
  await request("/api/access/admin/config", { method: "PUT", token: adminToken(), body: { registrationEnabled: false } });
  assert.equal((await request("/api/access/register", { method: "POST", body: { username: "closed_user", password, confirmPassword: password } })).status, 403);
  const login = await request("/api/access/login", { method: "POST", body: { username: "new_member", password } });
  assert.equal(login.status, 200);
  assert.ok(login.headers.get("set-cookie").includes("HttpOnly"));
  const invalid = await request("/api/access/login", { method: "POST", body: { username: "new_member", password: "incorrect" } });
  assert.equal(invalid.status, 401);
});
test("OAuth rejects missing, forged and browser-mismatched state before contacting WeChat", async () => {
  const beforeCalls = wxCalls;
  for (const query of ["code=abc", "code=abc&state=forged"]) {
    const result = await request(`/api/access/wechat/h5/callback?${query}`);
    assert.equal(result.status, 302);
    assert.match(result.headers.get("location"), /wechat_state/);
  }
  assert.equal(wxCalls, beforeCalls);
  const start = await request("/api/access/wechat/h5/start");
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get("location"));
  assert.equal(location.hostname, "open.weixin.qq.com");
  assert.equal(location.searchParams.get("redirect_uri"), "https://knowledge.example.com/api/access/wechat/h5/callback");
  const callback = await request(`/api/access/wechat/h5/callback?code=abc&state=${location.searchParams.get("state")}`);
  assert.match(callback.headers.get("location"), /wechat_state/);
  assert.equal(wxCalls, beforeCalls);
});
test("WeChat identities register once, cannot replay state, and disabled users cannot login", async () => {
  await request("/api/access/admin/config", { method: "PUT", token: adminToken(), body: { registrationEnabled: true } });
  const login = async () => {
    const start = await request("/api/access/wechat/h5/start");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cookie = start.headers.get("set-cookie").split(";")[0];
    const route = `/api/access/wechat/h5/callback?code=abc&state=${state}`;
    return { response: await request(route, { cookie }), route, cookie };
  };
  const first = await login();
  assert.match(first.response.headers.get("location"), /^\/sso\/simple\?token=/);
  const beforeCalls = wxCalls;
  assert.match((await request(first.route, { cookie: first.cookie })).headers.get("location"), /wechat_state/);
  assert.equal(wxCalls, beforeCalls);
  const second = await login();
  assert.match(second.response.headers.get("location"), /^\/sso\/simple\?token=/);
  const accounts = await prisma.users.findMany({ where: { username: { startsWith: "wx_" } } });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].role, "default");
  await prisma.users.update({ where: { id: accounts[0].id }, data: { suspended: 1 } });
  const disabled = await login();
  assert.match(disabled.response.headers.get("location"), /account_disabled/);
});

test("personal spaces isolate users in the portal and original workspace APIs", async () => {
  const member = await prisma.users.findUnique({ where: { username: "new_member" } });
  const token = JWT.sign({ id: member.id, role: member.role }, jwtSecret);
  const other = await prisma.users.create({ data: { username: "second_member", password: await bcrypt.hash(password, 4), role: "default" } });
  const otherToken = JWT.sign({ id: other.id, role: other.role }, jwtSecret);
  const created = await request("/api/access/spaces", { method: "POST", token, body: { name: "我的私有资料", ownerId: other.id } });
  assert.equal(created.status, 201);
  const { space } = await created.json();
  assert.equal(space.visibility, "private");
  assert.equal(space.ownerId, member.id);
  assert.equal((await request(`/api/access/spaces/${space.slug}/documents`, { token: otherToken })).status, 404);
  assert.equal((await request(`/api/workspace/${space.slug}`, { token: otherToken })).status, 404);
  const own = await request(`/api/workspace/${space.slug}`, { token });
  assert.equal((await own.json()).workspace.name, "我的私有资料");
  const list = await (await request("/api/workspaces", { token: otherToken })).json();
  assert.equal(list.workspaces.some(item => item.slug === space.slug), false);
  assert.equal((await request(`/api/access/spaces/${space.slug}`, { method: "PATCH", token: otherToken, body: { name: "被篡改" } })).status, 404);
  assert.equal((await request(`/api/access/spaces/${space.slug}`, { method: "PATCH", token, body: { visibility: "public" } })).status, 403);
  assert.equal((await request("/api/access/spaces", { method: "POST", token, body: { name: "越权发布", visibility: "public" } })).status, 403);
  assert.equal((await request(`/api/access/spaces/${space.slug}`, { method: "PATCH", token: adminToken(), body: { visibility: "public" } })).status, 200);
  const publicList = await (await request("/api/access/spaces", { token: otherToken })).json();
  assert.equal(publicList.spaces.find(item => item.slug === space.slug).canWrite, false);
  assert.equal((await request(`/api/workspace/${space.slug}`, { token: otherToken })).status, 200);
  assert.equal((await request(`/api/workspace/${space.slug}/update`, { method: "POST", token: otherToken, body: { name: "改公共库" } })).status, 403);
  assert.equal((await request(`/api/access/spaces/${space.slug}/documents`, { method: "POST", token: otherToken, body: { title: "注入", text: "注入内容" } })).status, 403);
  assert.equal((await request(`/api/access/spaces/${space.slug}`, { method: "PATCH", token: adminToken(), body: { visibility: "private" } })).status, 200);
  // A legacy membership does not override the new private ownership boundary.
  await prisma.workspace_users.create({ data: { user_id: other.id, workspace_id: space.id } });
  assert.equal((await request(`/api/workspace/${space.slug}`, { token: otherToken })).status, 404);
  const manager = await prisma.users.create({ data: { username: "test_manager", password: "unused", role: "manager" } });
  const managerToken = JWT.sign({ id: manager.id, role: "manager" }, jwtSecret);
  assert.equal((await request(`/api/workspace/${space.slug}`, { token: managerToken })).status, 404);
  assert.equal((await request("/api/system/workspace-chats", { method: "POST", token: managerToken, body: {} })).status, 403);
  assert.equal((await request("/api/system/local-files", { token: managerToken })).status, 403);
});

test("expired OAuth states and provider failures never authenticate", async () => {
  const start = await request("/api/access/wechat/h5/start");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = start.headers.get("set-cookie").split(";")[0];
  const label = "kb_access_state_" + crypto.createHash("sha256").update(state).digest("hex");
  const record = await prisma.system_settings.findUnique({ where: { label } });
  await prisma.system_settings.update({ where: { label }, data: { value: JSON.stringify({ ...JSON.parse(record.value), expires: Date.now() - 1000 }) } });
  const beforeCalls = wxCalls;
  assert.match((await request(`/api/access/wechat/h5/callback?state=${state}&code=test`, { cookie })).headers.get("location"), /wechat_state/);
  assert.equal(wxCalls, beforeCalls);
  const second = await request("/api/access/wechat/h5/start");
  const fresh = new URL(second.headers.get("location")).searchParams.get("state");
  providerFails = true;
  const result = await request(`/api/access/wechat/h5/callback?state=${fresh}&code=test`, { cookie: second.headers.get("set-cookie").split(";")[0] });
  assert.match(result.headers.get("location"), /wechat_provider/);
  assert.equal(result.headers.get("set-cookie"), null);
  providerFails = false;
});

test("review deep links resolve authorized spaces without silently classifying legacy libraries", async () => {
  const member = await prisma.users.findUnique({ where: { username: "new_member" } });
  const token = JWT.sign({ id: member.id, role: member.role }, jwtSecret);
  const legacy = await prisma.workspaces.create({ data: { slug: "legacy-review", name: "原有资料库" } });
  const result = await request(`/api/access/spaces/${legacy.slug}`, { token: adminToken() });
  assert.equal(result.status, 200);
  const { space } = await result.json(); assert.equal(space.visibility, "legacy"); assert.equal(space.canWrite, true);
  assert.equal((await request(`/api/access/spaces/${legacy.slug}`, { token })).status, 404);
  assert.equal((await request(`/api/access/spaces/${legacy.slug}`, { method: "PATCH", token: adminToken(), body: { visibility: "public" } })).status, 409);
  assert.equal(await prisma.system_settings.findUnique({ where: { label: `kb_access_space_${legacy.id}` } }), null);
  const mine = await (await request("/api/access/spaces", { method: "POST", token, body: { name: "深链接验证" } })).json();
  assert.equal((await request(`/api/access/spaces/${mine.space.slug}`, { token })).status, 200);
  assert.equal((await request(`/api/access/spaces/${mine.space.slug}`, { token: JWT.sign({ id: (await prisma.users.findUnique({ where: { username: "second_member" } })).id }, jwtSecret) })).status, 404);
});

test("authentication throttles repeated requests before creating a session", async () => {
  const app = express();
  app.use(createAccessRouter({ prisma, User, bcrypt, JWT, encryption, jwtSecret, rateLimit: 2 }));
  const listener = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  const origin = `http://127.0.0.1:${listener.address().port}`;
  try {
    for (let index = 0; index < 3; index++) {
      const response = await fetch(`${origin}/api/access/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ username: "missing", password: "invalid" }) });
      assert.equal(response.status, index < 2 ? 401 : 429);
      if (index === 2) assert.equal(response.headers.get("retry-after"), "900");
      assert.equal(response.headers.get("set-cookie"), null);
    }
  } finally { await new Promise(resolve => listener.close(resolve)); }
});
