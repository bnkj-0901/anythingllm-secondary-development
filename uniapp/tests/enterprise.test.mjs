import test from "node:test";
import assert from "node:assert/strict";
import {
  createEnterpriseClient as createClient,
  normalizeEndpoint,
  TOKEN_KEY,
  SESSION_KEY,
} from "../src/services/enterprise.mjs";
const endpoint = "https://acme.example.com/api";
const createEnterpriseClient = (options) =>
  createClient({ baseURL: endpoint, ...options });
const identity = {
  identity: "tenant",
  user: { id: "u1", username: "alice", name: "Alice" },
  tenant: { id: "t1", code: "acme", name: "Acme 企业" },
  role: "user",
};
const status = {
  initialized: true,
  site: {
    kind: "tenant",
    hostname: "acme.example.com",
    tenant: identity.tenant,
  },
};
function credentials(token = "token") {
  return {
    [TOKEN_KEY]: token,
    [SESSION_KEY]: { ...identity, token, endpoint },
  };
}
function harness(initial = {}) {
  const storage = new Map(Object.entries(initial)),
    requests = [],
    uploads = [],
    aborted = [];
  const runtime = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    request(options) {
      requests.push(options);
      return {
        abort() {
          aborted.push(options.url);
        },
      };
    },
    uploadFile(options) {
      uploads.push(options);
      return {
        onProgressUpdate(callback) {
          options.progressCallback = callback;
        },
        abort() {
          aborted.push(options.url);
        },
      };
    },
  };
  const respond = (options, data, statusCode = 200) => {
    options.success({ data, statusCode });
    options.complete?.();
  };
  return { storage, requests, uploads, aborted, runtime, respond };
}

test("knowledge approval originals use authenticated downloads without exposing credentials in URLs", async () => {
  const h = harness(credentials());
  const downloads = [],
    opened = [];
  h.runtime.downloadFile = (options) => {
    downloads.push(options);
    return { abort() {} };
  };
  h.runtime.openDocument = (options) => {
    opened.push(options.filePath);
    options.success({});
  };
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.openKnowledgeOriginal("change /1");
  assert.equal(
    downloads[0].url,
    `${endpoint}/enterprise/knowledge-changes/change%20%2F1/download`
  );
  assert.equal(downloads[0].header.Authorization, "Bearer token");
  downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://approved-preview",
  });
  downloads[0].complete();
  await pending;
  assert.deepEqual(opened, ["wxfile://approved-preview"]);
});

test("knowledge original download rejects revoked access and stale-session results before opening", async () => {
  for (const changeSession of [false, true]) {
    const h = harness(credentials());
    let download,
      opened = 0;
    h.runtime.downloadFile = (options) => {
      download = options;
      return { abort() {} };
    };
    h.runtime.openDocument = () => {
      opened++;
    };
    const client = createEnterpriseClient({ runtime: h.runtime });
    const pending = client.openKnowledgeOriginal("change");
    if (changeSession) client.clearSession();
    download.success({
      statusCode: changeSession ? 200 : 403,
      tempFilePath: "wxfile://private-preview",
    });
    download.complete();
    await assert.rejects(
      pending,
      (error) => error.status === (changeSession ? 409 : 403)
    );
    assert.equal(opened, 0);
  }
});

test("unsupported original-file preview directs the user to the web client", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  await assert.rejects(client.openKnowledgeOriginal("change"), /网页端/);
});

test("upload reports transport progress and settles cancellation immediately", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const progress = [];
  const uploading = client.upload(
    "library",
    { path: "original.pdf", name: "Policy" },
    (event) => progress.push(event.progress)
  );
  h.uploads[0].progressCallback({ progress: 65 });
  assert.deepEqual(progress, [65]);
  uploading.cancel();
  await assert.rejects(uploading, (error) => error.cancelled === true);
  h.uploads[0].progressCallback({ progress: 100 });
  h.respond(h.uploads[0], { document: { id: "late-document" } });
  assert.deepEqual(progress, [65]);
  assert.equal(h.aborted.length, 1);
});

test("upload 401 preserves the authorization error while canceling other pending transports", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const uploading = client.upload("library", { path: "original.pdf" });
  const second = client.upload("library", { path: "other.pdf" });
  const firstRejected = assert.rejects(
    uploading,
    (error) => error.status === 401 && !error.cancelled
  );
  const secondRejected = assert.rejects(
    second,
    (error) => error.cancelled === true
  );
  h.respond(h.uploads[0], { error: "expired" }, 401);
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(h.storage.has(TOKEN_KEY), false);
  assert.equal(h.aborted.length, 1);
});

test("session change aborts an upload before its runtime invokes failure", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const uploading = client.upload("library", { path: "original.pdf" });
  const rejected = assert.rejects(
    uploading,
    (error) => error.cancelled === true
  );
  client.clearSession();
  await rejected;
  assert.equal(h.aborted.length, 1);
});
async function discover(client, h, value = status) {
  const pending = client.status();
  h.respond(h.requests.at(-1), value);
  return pending;
}

test("enterprise URLs normalize without credentials, query strings or arbitrary paths", () => {
  assert.equal(
    normalizeEndpoint(" HTTPS://ACME.Example.COM:443/api/ "),
    "https://acme.example.com:443/api"
  );
  assert.equal(
    normalizeEndpoint("http://acme.localhost:3001"),
    "http://acme.localhost:3001/api"
  );
  for (const address of [
    "",
    "acme",
    "/api",
    "https://u:p@acme.com",
    "https://acme.com?tenant=a",
    "https://acme.com/path",
    "https://acme.com:99999",
    "http://acme.com",
    "https://-bad.com",
    "https://acme.com#x",
  ])
    assert.throws(() => normalizeEndpoint(address));
});
test("missing deployment configuration fails closed without credentials transmission", async () => {
  const h = harness({ ep_tenant_endpoint: endpoint });
  const client = createEnterpriseClient({ runtime: h.runtime, baseURL: "" });
  await assert.rejects(client.login("alice", "secret"), /未配置.*管理员/);
  assert.equal(h.requests.length, 0);
});
test("invalid deployment configuration blocks requests, uploads and streams", async () => {
  const h = harness({ ep_tenant_endpoint: endpoint });
  const client = createEnterpriseClient({
    runtime: h.runtime,
    baseURL: "https://bad.example/path",
  });
  await assert.rejects(client.status(), /配置无效.*管理员/);
  await assert.rejects(
    client.upload("library", { path: "/tmp/a.txt" }),
    /管理员/
  );
  await assert.rejects(
    client.streamMessage("conversation", "question"),
    /管理员/
  );
  assert.equal(h.requests.length, 0);
  assert.equal(h.uploads.length, 0);
});
test("H5 derives its API from the current origin when no fixed endpoint is configured", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
  };
  globalThis.window = {};
  globalThis.document = {};
  globalThis.location = { origin: "https://h5.example.com" };
  try {
    for (const baseURL of ["", "/api"]) {
      const h = harness({
        ep_tenant_endpoint: "https://other.example.com/api",
      });
      const client = createClient({ runtime: h.runtime, baseURL });
      assert.equal(client.getEndpoint(), "https://h5.example.com/api");
      const pending = client.status();
      assert.equal(
        h.requests[0].url,
        "https://h5.example.com/api/enterprise/status"
      );
      h.respond(h.requests[0], status);
      await pending;
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
test("domain discovery precedes login and login contains no tenant selector", async () => {
  const h = harness();
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.login(" alice ", "secret");
  assert.equal(h.requests[0].url, endpoint + "/enterprise/status");
  h.respond(h.requests[0], status);
  await new Promise(setImmediate);
  assert.deepEqual(h.requests[1].data, {
    username: "alice",
    password: "secret",
  });
  assert.equal(h.requests[1].header.Authorization, undefined);
  h.respond(h.requests[1], { ...identity, token: "new-token" });
  assert.deepEqual(await pending, {
    ...identity,
    token: "new-token",
    endpoint,
  });
  assert.equal(h.storage.get(TOKEN_KEY), "new-token");
  assert.equal(h.storage.get(SESSION_KEY).endpoint, endpoint);
});

test("open registration uses the discovered enterprise and never sends role or tenant selectors", async () => {
  const h = harness();
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.register(" alice ", "secret");
  assert.equal(h.requests[0].url, endpoint + "/enterprise/status");
  h.respond(h.requests[0], status);
  await new Promise(setImmediate);
  assert.equal(h.requests[1].url, endpoint + "/enterprise/register");
  assert.equal(h.requests[1].method, "POST");
  assert.equal(h.requests[1].header.Authorization, undefined);
  assert.deepEqual(h.requests[1].data, {
    username: "alice",
    password: "secret",
  });
  h.respond(
    h.requests[1],
    {
      ...identity,
      token: "registered-token",
      recoveryCodes: ["code-one", "code-two"],
    },
    201
  );
  const value = await pending;
  assert.equal(value.role, "user");
  assert.equal(value.tenant.id, identity.tenant.id);
  assert.deepEqual(value.recoveryCodes, ["code-one", "code-two"]);
  assert.equal(client.hasToken(), true);
  assert.equal(h.storage.get(TOKEN_KEY), "registered-token");
  assert.equal(h.storage.get(SESSION_KEY).recoveryCodes, undefined);
});

test("registration rejects invalid enterprise discovery, duplicate accounts and foreign identities", async () => {
  for (const kind of ["unknown", "platform"]) {
    const h = harness();
    const client = createEnterpriseClient({ runtime: h.runtime });
    const pending = client.register("alice", "secret");
    h.respond(h.requests[0], { initialized: true, site: { kind } });
    await assert.rejects(pending, /企业入口/);
    assert.equal(h.requests.length, 1);
  }
  for (const response of [
    { status: 409, body: { error: "当前企业用户名已存在" }, pattern: /已存在/ },
    {
      status: 201,
      body: {
        ...identity,
        tenant: { ...identity.tenant, id: "other" },
        token: "wrong",
      },
      pattern: /有效的企业身份/,
    },
  ]) {
    const h = harness();
    const client = createEnterpriseClient({ runtime: h.runtime });
    await discover(client, h);
    const pending = client.register("alice", "secret");
    h.respond(h.requests.at(-1), response.body, response.status);
    await assert.rejects(pending, response.pattern);
    assert.equal(client.hasToken(), false);
  }
});
test("server hostname metadata never replaces the configured request endpoint", async () => {
  const h = harness();
  const client = createEnterpriseClient({ runtime: h.runtime });
  await discover(client, h, {
    ...status,
    site: {
      ...status.site,
      tenant: { ...identity.tenant, hostname: "assigned.example.com" },
    },
  });
  const pending = client.login("alice", "secret");
  h.respond(h.requests.at(-1), {
    ...identity,
    tenant: { ...identity.tenant, hostname: "assigned.example.com" },
    token: "new-token",
  });
  assert.equal((await pending).tenant.id, identity.tenant.id);
  assert.equal(client.getEndpoint(), endpoint);
  assert.equal(h.requests.at(-1).url, endpoint + "/enterprise/login");
});
test("unknown, disabled and platform domains never receive login credentials", async () => {
  for (const kind of ["unknown", "platform"]) {
    const h = harness();
    const client = createEnterpriseClient({ runtime: h.runtime });
    const pending = client.login("alice", "secret");
    h.respond(h.requests[0], { initialized: true, site: { kind } });
    await assert.rejects(pending, /企业入口/);
    assert.equal(h.requests.length, 1);
  }
});
test("legacy endpoint storage cannot override the deployment address", async () => {
  const h = harness({
    ...credentials(),
    ep_tenant_endpoint: "https://other.example.com/api",
  });
  const client = createEnterpriseClient({ runtime: h.runtime });
  assert.equal(client.getEndpoint(), endpoint);
  assert.equal(client.connect, undefined);
  assert.equal(client.hasToken(), true);
  const pending = client.libraries();
  assert.equal(h.requests[0].url, endpoint + "/enterprise/libraries");
  h.respond(h.requests[0], { libraries: [] });
  await pending;
});
test("a deployment endpoint change discards the previous tenant session", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({
    runtime: h.runtime,
    baseURL: "https://other.example.com",
  });
  assert.equal(client.getEndpoint(), "https://other.example.com/api");
  assert.equal(client.hasToken(), false);
  assert.equal(h.storage.has(TOKEN_KEY), false);
  assert.equal(h.storage.has(SESSION_KEY), false);
});
test("restored sessions remain bound to their enterprise endpoint and are revalidated", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  await discover(client, h);
  const pending = client.me();
  assert.equal(h.requests[1].header.Authorization, "Bearer token");
  h.respond(h.requests[1], identity);
  assert.deepEqual(await pending, { ...identity, token: "token", endpoint });
});
test("old sessions, different endpoint sessions and platform identities are discarded", () => {
  for (const saved of [
    { ...identity, token: "token" },
    { ...identity, token: "token", endpoint: "https://other.com/api" },
    { ...identity, identity: "platform", endpoint },
    { ...identity, role: "platformAdmin", endpoint },
  ]) {
    const h = harness({ ...credentials(), [SESSION_KEY]: saved });
    const client = createEnterpriseClient({ runtime: h.runtime });
    assert.equal(client.hasToken(), false);
    assert.equal(h.storage.has(TOKEN_KEY), false);
    assert.equal(client.getEndpoint(), endpoint);
  }
});
test("server identities that disagree with the discovered domain are rejected", async () => {
  const h = harness();
  const client = createEnterpriseClient({ runtime: h.runtime });
  await discover(client, h);
  const pending = client.login("alice", "secret");
  h.respond(h.requests[1], {
    ...identity,
    tenant: { ...identity.tenant, id: "other" },
    token: "wrong",
  });
  await assert.rejects(pending, /有效的企业身份/);
  assert.equal(client.hasToken(), false);
});
test("platform login and me responses never restore a tenant session", async () => {
  for (const method of ["login", "me"]) {
    const h = harness(credentials());
    const client = createEnterpriseClient({ runtime: h.runtime });
    await discover(client, h);
    const pending =
      method === "login" ? client.login("alice", "secret") : client.me();
    h.respond(h.requests.at(-1), {
      ...identity,
      identity: "platform",
      token: "wrong",
    });
    await assert.rejects(pending, (error) => error.status === 403);
    assert.equal(client.getSession(), null);
  }
});
test("failed login keeps the fixed deployment address", async () => {
  const h = harness();
  const client = createEnterpriseClient({ runtime: h.runtime });
  await discover(client, h);
  const pending = client.login("alice", "wrong");
  h.respond(h.requests.at(-1), { error: "账号或密码错误" }, 401);
  await assert.rejects(pending, /账号或密码错误/);
  assert.equal(client.getEndpoint(), endpoint);
  assert.equal(client.hasToken(), false);
});
test("401 clears credentials and notifies the page without changing deployment", async () => {
  const h = harness(credentials());
  let count = 0;
  const client = createEnterpriseClient({
    runtime: h.runtime,
    onUnauthorized() {
      count++;
    },
  });
  const pending = client.me();
  h.respond(h.requests[0], { error: "会话过期" }, 401);
  await assert.rejects(pending, (error) => error.status === 401);
  assert.equal(count, 1);
  assert.equal(client.hasToken(), false);
  assert.equal(client.getEndpoint(), endpoint);
});
test("late responses after logout cannot restore data", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.me();
  client.clearSession();
  h.respond(h.requests[0], identity);
  await assert.rejects(pending, (error) => error.status === 409);
  assert.equal(client.getSession(), null);
});

test("disposing a page cancels pending work without removing its enterprise session", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.streamMessage("conversation", "question");
  client.cancelPending();
  assert.equal(h.aborted.length, 1);
  assert.equal(client.hasToken(), true);
  assert.equal(client.getSession().tenant.id, "t1");
  assert.equal(h.storage.get(TOKEN_KEY), "token");
  h.respond(h.requests[0], { message: { content: "late answer" } });
  await assert.rejects(pending, (error) => error.status === 409);
  const next = client.libraries();
  h.respond(h.requests[1], { libraries: [] });
  assert.deepEqual(await next, { libraries: [] });
});
test("upload uses the configured enterprise and authenticated multipart contract", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.upload("lib-1", {
    path: "/tmp/file.pdf",
    name: "file.pdf",
  });
  assert.equal(h.uploads[0].url, endpoint + "/enterprise/documents/upload");
  assert.equal(h.uploads[0].filePath, "/tmp/file.pdf");
  assert.equal(h.uploads[0].name, "file");
  assert.deepEqual(h.uploads[0].formData, {
    libraryId: "lib-1",
    title: "file.pdf",
  });
  assert.equal(h.uploads[0].header.Authorization, "Bearer token");
  assert.equal(h.uploads[0].header["Content-Type"], undefined);
  h.respond(
    h.uploads[0],
    JSON.stringify({ document: { id: "d1", status: "processing" } })
  );
  assert.equal((await pending).document.status, "processing");
});
test("malformed successful upload responses are errors", async () => {
  const h = harness();
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.upload("lib", { path: "/tmp/file.txt" });
  h.respond(h.uploads[0], "not-json");
  await assert.rejects(pending, /无法识别的数据/);
});
test("API and network failures keep their actionable messages", async () => {
  const h = harness();
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.streamMessage("c /1", "question");
  assert.equal(
    h.requests[0].url,
    endpoint + "/enterprise/conversations/c%20%2F1/messages"
  );
  h.respond(h.requests[0], { error: "请配置模型" }, 503);
  await assert.rejects(pending, (error) => error.status === 503);
  const failed = client.status();
  h.requests[1].fail({ errMsg: "request:fail" });
  await assert.rejects(failed, /无法连接服务/);
});
test("source access always calls the server and encodes document identifiers", async () => {
  const h = harness();
  const client = createEnterpriseClient({ runtime: h.runtime });
  const first = client.document("d /1");
  h.respond(h.requests[0], { document: { id: "d /1" } });
  await first;
  const second = client.document("d /1");
  assert.equal(h.requests[1].url, endpoint + "/enterprise/documents/d%20%2F1");
  h.respond(h.requests[1], { error: "不可访问" }, 404);
  await assert.rejects(second, (error) => error.status === 404);
});
test("runtime injection remains optional and status confirms the tenant site", async () => {
  const h = harness();
  const previous = globalThis.uni;
  globalThis.uni = h.runtime;
  try {
    const client = createEnterpriseClient();
    assert.equal((await discover(client, h)).initialized, true);
  } finally {
    if (previous === undefined) delete globalThis.uni;
    else globalThis.uni = previous;
  }
});

test("WeChat login exchanges only a runtime code at the domain's enterprise endpoint and validates the returned tenant", async () => {
  const h = harness();
  const logins = [];
  h.runtime.login = (options) => logins.push(options);
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.wechatLogin();
  h.respond(h.requests[0], {
    ...status,
    site: {
      ...status.site,
      tenant: { ...status.site.tenant, wechatLoginEnabled: true },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logins[0].provider, "weixin");
  logins[0].success({ code: "runtime-code" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests[1].url, `${endpoint}/enterprise/wechat/login`);
  assert.equal(h.requests[1].method, "POST");
  assert.deepEqual(h.requests[1].data, { code: "runtime-code" });
  h.respond(h.requests[1], {
    ...identity,
    token: "wechat-token",
    recoveryCodes: ["one-time-code"],
  });
  const loggedIn = await pending;
  assert.equal(loggedIn.user.username, "alice");
  assert.deepEqual(loggedIn.recoveryCodes, ["one-time-code"]);
  assert.equal(
    Object.hasOwn(h.storage.get(SESSION_KEY), "recoveryCodes"),
    false
  );
  assert.equal(h.storage.get(TOKEN_KEY), "wechat-token");
  assert.equal(h.storage.get(SESSION_KEY).tenant.id, "t1");
});

test("WeChat login refuses disabled enterprise bindings before requesting a platform credential", async () => {
  const h = harness();
  let logins = 0;
  h.runtime.login = () => {
    logins++;
  };
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.wechatLogin();
  h.respond(h.requests[0], status);
  await assert.rejects(pending, /尚未启用微信登录/);
  assert.equal(logins, 0);
  assert.equal(h.requests.length, 1);
});

test("WeChat denial and empty codes never reach the login exchange", async () => {
  for (const denied of [true, false]) {
    const h = harness();
    h.runtime.login = (options) =>
      denied
        ? options.fail({ errMsg: "cancel" })
        : options.success({ code: "" });
    const client = createEnterpriseClient({ runtime: h.runtime });
    const pending = client.wechatLogin();
    h.respond(h.requests[0], {
      ...status,
      site: {
        ...status.site,
        tenant: { ...identity.tenant, wechatLoginEnabled: true },
      },
    });
    await assert.rejects(pending, /微信.*登录|微信未返回有效登录凭证/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.storage.has(TOKEN_KEY), false);
  }
});

test("WeChat login rejects another tenant identity and leaves no cached session", async () => {
  const h = harness();
  h.runtime.login = (options) => options.success({ code: "runtime-code" });
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.wechatLogin();
  h.respond(h.requests[0], {
    ...status,
    site: {
      ...status.site,
      tenant: { ...identity.tenant, wechatLoginEnabled: true },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  h.respond(h.requests[1], {
    ...identity,
    tenant: { ...identity.tenant, id: "foreign-tenant" },
    token: "invalid-token",
  });
  await assert.rejects(pending, /有效的企业身份/);
  assert.equal(h.storage.has(TOKEN_KEY), false);
});

test("a cancelled session cannot be revived by a delayed WeChat login callback", async () => {
  const h = harness();
  let login;
  h.runtime.login = (options) => {
    login = options;
  };
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.wechatLogin();
  h.respond(h.requests[0], {
    ...status,
    site: {
      ...status.site,
      tenant: { ...identity.tenant, wechatLoginEnabled: true },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  client.clearSession();
  login.success({ code: "late-code" });
  await assert.rejects(pending, /会话已变更/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.storage.has(TOKEN_KEY), false);
});

test("profile updates preserve avatar metadata without accepting identity fields from the client", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.updateProfile("陈小明");
  assert.equal(h.requests[0].url, endpoint + "/enterprise/me");
  assert.equal(h.requests[0].method, "PATCH");
  assert.deepEqual(h.requests[0].data, { name: "陈小明" });
  const user = {
    ...identity.user,
    name: "陈小明",
    pfpFilename: "avatar.png",
    wechatBound: true,
  };
  h.respond(h.requests[0], { ...identity, user, token: "updated-token" });
  assert.deepEqual((await pending).user, user);
  assert.equal(h.storage.get(SESSION_KEY).user.wechatBound, true);
});

test("avatar selection uploads through the existing authenticated endpoint and refreshes the profile", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.uploadAvatar({ path: "wxfile://chosen-avatar" });
  assert.equal(h.uploads[0].url, endpoint + "/enterprise/me/avatar");
  assert.equal(h.uploads[0].header.Authorization, "Bearer token");
  assert.deepEqual(h.uploads[0].formData, {});
  assert.equal(h.uploads[0].filePath, "wxfile://chosen-avatar");
  h.respond(h.uploads[0], { pfpFilename: "saved.png" });
  await new Promise((resolve) => setImmediate(resolve));
  h.respond(h.requests[0], {
    ...identity,
    user: { ...identity.user, pfpFilename: "saved.png" },
  });
  assert.equal((await pending).user.pfpFilename, "saved.png");
});

test("first WeChat registration persists completion and the replacement token without accepting client identity", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.completeWechatRegistration("陈小明", "safe-password");
  assert.deepEqual(h.requests[0].data, {
    name: "陈小明",
    password: "safe-password",
  });
  assert.equal(h.requests[0].method, "PATCH");
  h.respond(h.requests[0], {
    ...identity,
    user: {
      ...identity.user,
      wechatBound: true,
      wechatRegistrationRequired: false,
    },
    token: "new-token",
    recoveryCodes: ["recovery-once"],
  });
  const result = await pending;
  assert.equal(result.user.wechatRegistrationRequired, false);
  assert.deepEqual(result.recoveryCodes, ["recovery-once"]);
  assert.equal(h.storage.get(TOKEN_KEY), "new-token");
  assert.equal(h.storage.get(SESSION_KEY).password, undefined);
  assert.equal(h.storage.get(SESSION_KEY).recoveryCodes, undefined);
});

test("password changes reuse the existing profile endpoint and subsequent requests use the fresh token", async () => {
  const h = harness(credentials());
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.changePassword("safe-password");
  assert.deepEqual(h.requests[0].data, { password: "safe-password" });
  h.respond(h.requests[0], { ...identity, token: "fresh-token" });
  await pending;
  const me = client.me();
  assert.equal(h.requests[1].header.Authorization, "Bearer fresh-token");
  h.respond(h.requests[1], identity);
  await me;
  assert.equal(client.getSession().token, "fresh-token");
});

test("avatars use authenticated temporary files and are discarded on logout", async () => {
  const initial = credentials();
  initial[SESSION_KEY].user = { ...identity.user, pfpFilename: "saved.png" };
  const h = harness(initial),
    downloads = [],
    removed = [];
  h.runtime.downloadFile = (options) => {
    downloads.push(options);
    return { abort() {} };
  };
  h.runtime.getFileSystemManager = () => ({
    unlink: (options) => removed.push(options.filePath),
  });
  const client = createEnterpriseClient({ runtime: h.runtime });
  const pending = client.avatar();
  assert.equal(downloads[0].url, endpoint + "/enterprise/me/avatar");
  assert.equal(downloads[0].header.Authorization, "Bearer token");
  assert.equal(downloads[0].url.includes("token"), false);
  downloads[0].success({
    statusCode: 200,
    tempFilePath: "wxfile://protected-avatar",
  });
  assert.equal(await pending, "wxfile://protected-avatar");
  client.clearSession();
  assert.deepEqual(removed, ["wxfile://protected-avatar"]);
});

test("late and superseded avatars cannot restore a former session's image", async () => {
  for (const logout of [true, false]) {
    const initial = credentials();
    initial[SESSION_KEY].user = { ...identity.user, pfpFilename: "saved.png" };
    const h = harness(initial),
      downloads = [],
      removed = [];
    h.runtime.downloadFile = (options) => {
      downloads.push(options);
      return { abort() {} };
    };
    h.runtime.getFileSystemManager = () => ({
      unlink: (options) => removed.push(options.filePath),
    });
    const client = createEnterpriseClient({ runtime: h.runtime });
    const stale = client.avatar();
    const rejected = assert.rejects(stale, (error) => error.status === 409);
    let current;
    if (logout) client.clearSession();
    else current = client.avatar();
    downloads[0].success({
      statusCode: 200,
      tempFilePath: "wxfile://stale-avatar",
    });
    await rejected;
    assert.deepEqual(removed, ["wxfile://stale-avatar"]);
    if (current) {
      downloads[1].success({ statusCode: 204 });
      assert.equal(await current, "");
    }
  }
});
