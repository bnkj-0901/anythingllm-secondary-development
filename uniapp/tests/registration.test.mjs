import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computed, ref } from "vue";

function harness(handlers = {}) {
  const source = readFileSync(
    new URL("../src/pages/index/index.vue", import.meta.url),
    "utf8"
  )
    .split("<script setup>")[1]
    .split("</script>")[0]
    .replace(/^import[\s\S]*?;\r?\n/gm, "");
  const modals = [],
    copied = [],
    calls = [],
    navigation = [],
    toasts = [];
  const api = {
    getEndpoint: () => "https://acme.example.com/api",
    conversations: async () => ({ conversations: [] }),
    register: async (...args) => {
      calls.push(args);
      return handlers.register(...args);
    },
    ...handlers,
  };
  const page = new Function(
    "computed",
    "nextTick",
    "onBeforeUnmount",
    "onMounted",
    "inject",
    "ref",
    "onResize",
    "onShow",
    "uni",
    `${source}\nreturn {registering,username,password,confirmPassword,loggingIn,loginError,session,login,wechatLogin,wechatLoginEnabled,toggleRegistration,reset,boot,openSettings,resumeFromSettings,onProfileUpdated,draft,messages,currentConversation,sending};`
  )(
    computed,
    async () => {},
    () => {},
    () => {},
    () => api,
    ref,
    () => {},
    () => {},
    {
      showModal: (options) => modals.push(options),
      setClipboardData: ({ data }) => copied.push(data),
      navigateTo: (options) => navigation.push(options),
      redirectTo: (options) => navigation.push(options),
      showToast: (options) => toasts.push(options),
    }
  );
  return { ...page, calls, modals, copied, navigation, toasts };
}

test("registration uses the login form and rejects mismatched confirmation before requesting", async () => {
  const h = harness();
  h.password.value = "old-password";
  h.loginError.value = "old-error";
  h.toggleRegistration();
  assert.equal(h.registering.value, true);
  assert.equal(h.password.value, "");
  assert.equal(h.loginError.value, "");
  h.username.value = "alice";
  h.password.value = "new-password";
  h.confirmPassword.value = "different";
  await h.login();
  assert.match(h.loginError.value, /两次输入/);
  assert.equal(h.calls.length, 0);
});

test("registration logs in immediately, prevents duplicate submission and offers one-time recovery codes", async () => {
  let resolve;
  let count = 0;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const h = harness({
    register: () => {
      count++;
      return pending;
    },
  });
  h.toggleRegistration();
  h.username.value = " alice ";
  h.password.value = h.confirmPassword.value = "valid-password";
  const sending = h.login();
  await h.login();
  h.toggleRegistration();
  assert.equal(h.loggingIn.value, true);
  assert.equal(h.registering.value, true);
  assert.equal(count, 1);
  const identity = {
    identity: "tenant",
    role: "user",
    user: { id: "u1", username: "alice" },
    tenant: { id: "t1", name: "Acme" },
  };
  resolve({ ...identity, recoveryCodes: ["code-one", "code-two"] });
  await sending;
  assert.deepEqual(h.session.value, identity);
  assert.equal(h.password.value, "");
  assert.equal(h.confirmPassword.value, "");
  assert.equal(h.registering.value, false);
  assert.equal(h.loggingIn.value, false);
  assert.equal(h.modals.length, 1);
  assert.match(h.modals[0].content, /仅显示一次/);
  h.modals[0].success({ confirm: true });
  assert.deepEqual(h.copied, ["code-one\ncode-two"]);
});

test("registration errors remain in the form and resetting clears registration secrets", async () => {
  const h = harness({
    register: async () => {
      throw new Error("当前企业用户名已存在");
    },
  });
  h.toggleRegistration();
  h.username.value = "alice";
  h.password.value = h.confirmPassword.value = "valid-password";
  await h.login();
  assert.equal(h.session.value, null);
  assert.equal(h.registering.value, true);
  assert.match(h.loginError.value, /已存在/);
  assert.equal(h.loggingIn.value, false);
  h.reset();
  assert.equal(h.registering.value, false);
  assert.equal(h.password.value, "");
  assert.equal(h.confirmPassword.value, "");
});

test("WeChat login uses the same session lifecycle and prevents duplicate submissions", async () => {
  let count = 0,
    resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const h = harness({
    wechatLogin: () => {
      count++;
      return pending;
    },
  });
  h.wechatLoginEnabled.value = true;
  h.password.value = h.confirmPassword.value = "typed-password";
  const sending = h.wechatLogin();
  await h.wechatLogin();
  assert.equal(count, 1);
  assert.equal(h.loggingIn.value, true);
  const identity = {
    identity: "tenant",
    role: "user",
    user: { id: 3, username: "wechat-user" },
    tenant: { id: "t1", name: "Acme" },
  };
  resolve(identity);
  await sending;
  assert.deepEqual(h.session.value, identity);
  assert.equal(h.password.value, "");
  assert.equal(h.confirmPassword.value, "");
  assert.equal(h.loggingIn.value, false);
});

test("WeChat login keeps errors visible and does not expose an unconfigured entry", async () => {
  let count = 0;
  const h = harness({
    wechatLogin: async () => {
      count++;
      throw new Error("微信登录失败");
    },
  });
  await h.wechatLogin();
  assert.equal(count, 0);
  h.wechatLoginEnabled.value = true;
  await h.wechatLogin();
  assert.equal(count, 1);
  assert.equal(h.session.value, null);
  assert.equal(h.loginError.value, "微信登录失败");
  assert.equal(h.loggingIn.value, false);
});

test("WeChat registration offers recovery codes without opening profile settings", async () => {
  const identity = {
    identity: "tenant",
    role: "user",
    user: {
      id: 9,
      username: "internal-wechat",
      name: "用户9",
      wechatBound: true,
    },
    tenant: { id: "t1", name: "Acme" },
  };
  const h = harness({
    wechatLogin: async () => ({ ...identity, recoveryCodes: ["code-one"] }),
  });
  h.wechatLoginEnabled.value = true;
  await h.wechatLogin();
  assert.deepEqual(h.session.value, identity);
  assert.equal(h.modals.length, 1);
  assert.match(h.modals[0].content, /code-one/);
  assert.equal(h.navigation.length, 0);
});

test("completed WeChat login does not reopen registration just for a missing avatar", async () => {
  const identity = {
    identity: "tenant",
    role: "user",
    user: {
      id: 9,
      username: "internal-wechat",
      name: "陈小明",
      wechatBound: true,
    },
    tenant: { id: "t1", name: "Acme" },
  };
  const h = harness({ wechatLogin: async () => identity });
  h.wechatLoginEnabled.value = true;
  await h.wechatLogin();
  assert.equal(h.navigation.length, 0);
  assert.equal(h.modals.length, 0);
});

test("complete WeChat profiles do not prompt on subsequent login", async () => {
  const identity = {
    identity: "tenant",
    role: "user",
    user: {
      id: 9,
      username: "internal-wechat",
      name: "陈小明",
      pfpFilename: "avatar.png",
      wechatBound: true,
    },
    tenant: { id: "t1", name: "Acme" },
  };
  const h = harness({
    wechatLogin: async () => identity,
    avatar: async () => "local-avatar",
  });
  h.wechatLoginEnabled.value = true;
  await h.wechatLogin();
  assert.equal(h.navigation.length, 0);
});

test("restoring an unfinished WeChat registration redirects before loading conversations", async () => {
  const identity = {
    identity: "tenant",
    role: "user",
    user: {
      id: 9,
      username: "internal-wechat",
      name: "用户9",
      wechatBound: true,
      wechatRegistrationRequired: true,
    },
    tenant: { id: "t1", name: "Acme" },
  };
  const h = harness({
    status: async () => ({
      initialized: true,
      site: { tenant: { wechatLoginEnabled: true } },
    }),
    hasToken: () => true,
    me: async () => identity,
  });
  await h.boot();
  assert.deepEqual(
    h.navigation.map((value) => value.url),
    ["/pages/settings/index"]
  );
  assert.equal(h.modals.length, 0);
});

test("first WeChat login redirects to registration without loading chat or showing a profile popup", async () => {
  let reads = 0;
  const identity = {
    identity: "tenant",
    role: "user",
    user: { id: 9, username: "wx_account", wechatRegistrationRequired: true },
    tenant: { id: "t1", name: "Acme" },
  };
  const h = harness({
    wechatLogin: async () => identity,
    conversations: async () => {
      reads++;
      return { conversations: [] };
    },
  });
  h.wechatLoginEnabled.value = true;
  await h.wechatLogin();
  assert.deepEqual(
    h.navigation.map((value) => value.url),
    ["/pages/settings/index"]
  );
  assert.equal(reads, 0);
  assert.equal(h.modals.length, 0);
});

test("settings navigation uses a real route, prevents duplicate navigation and preserves the current conversation", async () => {
  const updated = {
    user: { id: 9, name: "陈小明" },
    tenant: { id: "t1" },
    role: "user",
  };
  const h = harness({ getSession: () => updated });
  h.session.value = { ...updated, user: { id: 9, name: "用户9" } };
  h.draft.value = "未发送的问题";
  h.messages.value = [{ id: 1, content: "之前的对话" }];
  h.currentConversation.value = { id: "conversation-a" };
  h.openSettings();
  h.openSettings();
  assert.equal(h.navigation.length, 1);
  assert.equal(h.navigation[0].url, "/pages/settings/index");
  await h.resumeFromSettings();
  assert.deepEqual(h.session.value, updated);
  assert.equal(h.draft.value, "未发送的问题");
  assert.equal(h.messages.value[0].content, "之前的对话");
  assert.equal(h.currentConversation.value.id, "conversation-a");
});

test("settings cannot interrupt an active answer and navigation can be retried after failure", () => {
  const h = harness();
  h.session.value = { user: { id: 9 } };
  h.sending.value = true;
  h.openSettings();
  assert.equal(h.navigation.length, 0);
  assert.equal(h.toasts.length, 1);
  h.sending.value = false;
  h.openSettings();
  h.navigation[0].fail();
  h.openSettings();
  assert.equal(h.navigation.length, 2);
});

test("returning without authentication clears the previous user's draft and conversation", async () => {
  const h = harness({ getSession: () => null });
  h.session.value = { user: { id: 9 } };
  h.draft.value = "private draft";
  h.messages.value = [{ id: 1 }];
  h.openSettings();
  await h.resumeFromSettings();
  assert.equal(h.session.value, null);
  assert.equal(h.draft.value, "");
  assert.deepEqual(h.messages.value, []);
});

test("profile completion after returning updates only the current tenant user", () => {
  const h = harness();
  const original = { user: { id: 9, name: "原昵称" }, tenant: { id: "t1" } };
  h.session.value = original;
  h.onProfileUpdated({
    user: { id: 9, name: "其他企业" },
    tenant: { id: "t2" },
  });
  h.onProfileUpdated({
    user: { id: 10, name: "其他用户" },
    tenant: { id: "t1" },
  });
  assert.deepEqual(h.session.value, original);
  h.onProfileUpdated({ user: { id: 9, name: "新昵称" }, tenant: { id: "t1" } });
  assert.equal(h.session.value.user.name, "新昵称");
  h.reset();
  h.onProfileUpdated(original);
  assert.equal(h.session.value, null);
});
