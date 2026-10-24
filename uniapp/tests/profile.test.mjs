import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ref } from "vue";

async function harness(handlers = {}, user = {}) {
  const source = readFileSync(
    new URL("../src/pages/settings/index.vue", import.meta.url),
    "utf8"
  )
    .split("<script setup>")[1]
    .split("</script>")[0]
    .replace(/^import.*;\r?\n/gm, "");
  const calls = [],
    navigation = [],
    toasts = [],
    events = [];
  let authenticated = true;
  let identity = {
    user: { id: 7, name: "用户7", ...user },
    tenant: { id: "tenant-a", name: "企业 A" },
    role: "user",
  };
  const api = {
    getEndpoint: () => "https://acme.example.com/api",
    hasToken: () => authenticated,
    getSession: () => identity,
    me: async () => identity,
    avatar: async () => "",
    clearSession() {
      authenticated = false;
      calls.push(["logout"]);
    },
    async updateProfile(name) {
      calls.push(["name", name]);
      identity = { ...identity, user: { ...identity.user, name } };
      return identity;
    },
    async uploadAvatar(file) {
      calls.push(["avatar", file.path]);
      identity = {
        ...identity,
        user: { ...identity.user, pfpFilename: "avatar.png" },
      };
      return identity;
    },
    ...handlers,
  };
  let unload;
  const settings = new Function(
    "inject",
    "ref",
    "onLoad",
    "onUnload",
    "uni",
    `${source}\nreturn {name,selectedAvatar,error,saving,loading,session,save,chooseAvatar,logout,load,registering,password,confirmPassword,openPassword,copyWebAddress};`
  )(
    () => api,
    ref,
    () => {},
    (callback) => {
      unload = callback;
    },
    {
      reLaunch: (value) => navigation.push(value),
      navigateTo: (value) => navigation.push(value),
      setNavigationBarTitle() {},
      setClipboardData: (value) => calls.push(["copy", value.data]),
      showToast: (value) => toasts.push(value),
      $emit: (...args) => events.push(args),
    }
  );
  await settings.load();
  return { ...settings, calls, navigation, toasts, events, unload, api };
}

test("settings validates the submitted nickname before sending any update", async () => {
  const h = await harness();
  await h.save({ detail: { value: { nickname: "  " } } });
  assert.match(h.error.value, /昵称/);
  assert.equal(h.calls.length, 0);
});

test("first WeChat registration requires avatar, nickname and matching password before entering", async () => {
  const h = await harness(
    {},
    { wechatBound: true, wechatRegistrationRequired: true }
  );
  await h.save({
    detail: {
      value: {
        nickname: "陈小明",
        password: "safe-password",
        confirmPassword: "safe-password",
      },
    },
  });
  assert.match(h.error.value, /头像/);
  h.chooseAvatar({ avatarUrl: "wxfile://chosen" });
  await h.save({
    detail: {
      value: {
        nickname: "陈小明",
        password: "short",
        confirmPassword: "short",
      },
    },
  });
  assert.match(h.error.value, /密码/);
  await h.save({
    detail: {
      value: {
        nickname: "陈小明",
        password: "safe-password",
        confirmPassword: "different",
      },
    },
  });
  assert.match(h.error.value, /两次输入/);
  assert.equal(h.calls.length, 0);
});

test("registration uploads avatar before atomically completing nickname and password", async () => {
  const h = await harness(
    {
      completeWechatRegistration: async (name, password) => {
        h.calls.push(["register", name, password]);
        return {
          user: { id: 7, name, wechatRegistrationRequired: false },
          tenant: { id: "tenant-a" },
        };
      },
    },
    { wechatBound: true, wechatRegistrationRequired: true }
  );
  h.chooseAvatar({ avatarUrl: "wxfile://chosen" });
  h.password.value = h.confirmPassword.value = "safe-password";
  await h.save({ detail: { value: { nickname: " 陈小明 " } } });
  assert.deepEqual(h.calls, [
    ["avatar", "wxfile://chosen"],
    ["register", "陈小明", "safe-password"],
  ]);
  assert.equal(h.password.value, "");
  assert.equal(h.confirmPassword.value, "");
  assert.deepEqual(h.navigation, [{ url: "/pages/index/index" }]);
});

test("failed registration completion retains uploaded avatar for retry without reupload", async () => {
  let count = 0;
  const h = await harness(
    {
      completeWechatRegistration: async () => {
        count++;
        throw new Error("密码不符合要求");
      },
    },
    { wechatBound: true, wechatRegistrationRequired: true }
  );
  h.chooseAvatar({ avatarUrl: "wxfile://chosen" });
  const form = {
    detail: {
      value: {
        nickname: "陈小明",
        password: "safe-password",
        confirmPassword: "safe-password",
      },
    },
  };
  await h.save(form);
  await h.save(form);
  assert.equal(count, 2);
  assert.deepEqual(h.calls, [["avatar", "wxfile://chosen"]]);
  assert.equal(h.error.value, "密码不符合要求");
  assert.equal(h.navigation.length, 0);
});

test("settings opens password management and copies the configured web address without token", async () => {
  const h = await harness();
  h.openPassword();
  h.copyWebAddress();
  assert.deepEqual(h.navigation, [{ url: "/pages/settings/password" }]);
  assert.deepEqual(h.calls, [["copy", "https://acme.example.com"]]);
});

test("unfinished WeChat registrations show an empty nickname field without a popup", async () => {
  const h = await harness(
    {},
    { wechatBound: true, wechatRegistrationRequired: true }
  );
  assert.equal(h.name.value, "");
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.toasts, []);
  await h.save({ detail: { value: { nickname: "" } } });
  assert.equal(h.calls.length, 0);
});

test("settings retains an existing WeChat nickname and avatar", async () => {
  const h = await harness(
    { avatar: async () => "wxfile://existing" },
    { wechatBound: true, name: "陈小明", pfpFilename: "avatar.png" }
  );
  assert.equal(h.name.value, "陈小明");
  assert.equal(h.session.value.user.pfpFilename, "avatar.png");
});

test("settings saves the reviewed native form nickname and chosen avatar without changing identity", async () => {
  const h = await harness();
  h.chooseAvatar({ avatarUrl: "wxfile://chosen" });
  await h.save({ detail: { value: { nickname: " 陈小明 " } } });
  assert.deepEqual(h.calls, [
    ["name", "陈小明"],
    ["avatar", "wxfile://chosen"],
  ]);
  assert.equal(h.session.value.user.id, 7);
  assert.equal(h.session.value.tenant.id, "tenant-a");
  assert.equal(h.name.value, "陈小明");
  assert.equal(h.selectedAvatar.value, "");
  assert.equal(h.toasts.length, 1);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1][0], "enterprise-profile-updated");
});

test("failed avatar upload keeps the selection for retry and shows the error on the page", async () => {
  const h = await harness({
    uploadAvatar: async () => {
      throw new Error("图片过大");
    },
  });
  h.chooseAvatar({ avatarUrl: "wxfile://chosen" });
  await h.save({ detail: { value: { nickname: "陈小明" } } });
  assert.equal(h.error.value, "图片过大");
  assert.equal(h.selectedAvatar.value, "wxfile://chosen");
  assert.equal(h.saving.value, false);
  assert.equal(h.navigation.length, 0);
  assert.equal(h.toasts.length, 0);
});

test("settings prevents duplicate saves and logout while an update is running", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const h = await harness({ updateProfile: () => pending });
  const saving = h.save({ detail: { value: { nickname: "陈小明" } } });
  await h.save({ detail: { value: { nickname: "其他昵称" } } });
  h.logout();
  assert.equal(h.calls.length, 0);
  resolve({ user: { id: 7, name: "陈小明" }, tenant: { id: "tenant-a" } });
  await saving;
  assert.equal(h.saving.value, false);
  assert.equal(h.toasts.length, 1);
});

test("settings logout clears authentication and returns to the login page", async () => {
  const h = await harness();
  h.logout();
  assert.equal(h.api.hasToken(), false);
  assert.deepEqual(h.navigation, [{ url: "/pages/index/index" }]);
});

test("settings without a login returns to the entry page without loading private data", async () => {
  let reads = 0;
  const h = await harness({
    hasToken: () => false,
    me: async () => {
      reads++;
    },
  });
  assert.equal(reads, 0);
  assert.deepEqual(h.navigation, [{ url: "/pages/index/index" }]);
});

test("expired authentication on save returns to the login page", async () => {
  const h = await harness({
    updateProfile: async () => {
      throw Object.assign(new Error("登录已过期"), { status: 401 });
    },
  });
  await h.save({ detail: { value: { nickname: "陈小明" } } });
  assert.deepEqual(h.navigation, [{ url: "/pages/index/index" }]);
  assert.equal(h.toasts.length, 0);
});

test("leaving settings while a save is pending does not show a success toast or mutate the abandoned page", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const h = await harness({ updateProfile: () => pending });
  const saving = h.save({ detail: { value: { nickname: "陈小明" } } });
  h.unload();
  resolve({ user: { id: 7, name: "陈小明" } });
  await saving;
  assert.equal(h.toasts.length, 0);
  assert.equal(h.name.value, "用户7");
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0][1].user.name, "陈小明");
});
