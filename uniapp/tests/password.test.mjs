import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ref } from "vue";

function harness(handlers = {}) {
  const source = readFileSync(
    new URL("../src/pages/settings/password.vue", import.meta.url),
    "utf8"
  )
    .split("<script setup>")[1]
    .split("</script>")[0]
    .replace(/^import.*;\r?\n/gm, "");
  const calls = [],
    events = [],
    navigation = [],
    toasts = [];
  const identity = { user: { id: 1 }, tenant: { id: "tenant-a" } };
  const api = {
    hasToken: () => true,
    getSession: () => identity,
    changePassword: async (password) => {
      calls.push(password);
      return identity;
    },
    ...handlers,
  };
  let load, unload;
  const page = new Function(
    "inject",
    "ref",
    "onLoad",
    "onUnload",
    "uni",
    `${source}\nreturn {save,password,confirmation,saving,error};`
  )(
    () => api,
    ref,
    (fn) => {
      load = fn;
    },
    (fn) => {
      unload = fn;
    },
    {
      $emit: (...args) => events.push(args),
      showToast: (value) => toasts.push(value),
      navigateBack: () => navigation.push("back"),
      reLaunch: (value) => navigation.push(value.url),
      redirectTo: (value) => navigation.push(value.url),
    }
  );
  return { ...page, calls, events, navigation, toasts, load, unload };
}
const form = (password, confirmation = password) => ({
  detail: { value: { password, confirmation } },
});

test("password change validates confirmation and length before sending", async () => {
  const h = harness();
  await h.save(form("short"));
  assert.match(h.error.value, /8—250/);
  await h.save(form("safe-password", "different"));
  assert.match(h.error.value, /两次输入/);
  assert.deepEqual(h.calls, []);
});
test("password change uses the shared session, clears secrets and returns after saving", async () => {
  const h = harness();
  h.password.value = h.confirmation.value = "safe-password";
  await h.save(form("safe-password"));
  assert.deepEqual(h.calls, ["safe-password"]);
  assert.equal(h.password.value, "");
  assert.equal(h.confirmation.value, "");
  assert.deepEqual(h.navigation, ["back"]);
  assert.equal(h.events[0][0], "enterprise-profile-updated");
});
test("password changes cannot be submitted twice and errors allow retry", async () => {
  let reject;
  const h = harness({
    changePassword: () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  });
  const pending = h.save(form("safe-password"));
  await h.save(form("another-password"));
  assert.equal(h.saving.value, true);
  reject(new Error("密码不符合要求"));
  await pending;
  assert.equal(h.error.value, "密码不符合要求");
  assert.equal(h.saving.value, false);
  assert.deepEqual(h.navigation, []);
});
test("expired password changes return to login and leaving the page clears secrets", async () => {
  const h = harness({
    changePassword: async () => {
      throw Object.assign(new Error("expired"), { status: 401 });
    },
  });
  await h.save(form("safe-password"));
  assert.deepEqual(h.navigation, ["/pages/index/index"]);
  h.password.value = h.confirmation.value = "safe-password";
  h.unload();
  assert.equal(h.password.value, "");
  assert.equal(h.confirmation.value, "");
});
