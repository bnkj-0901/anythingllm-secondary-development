<template>
  <wd-config-provider
    :theme-vars="{ colorTheme: '#237b61' }"
    custom-style="height:100%;"
  >
    <scroll-view scroll-y class="password-page">
      <form class="password-form" @submit="save">
        <wd-cell-group border>
          <wd-cell title="新密码" center title-width="72px">
            <input
              v-model="password"
              name="password"
              password
              placeholder="输入新密码"
              :maxlength="250"
              :disabled="saving"
              class="password-input"
            />
          </wd-cell>
          <wd-cell title="确认密码" center title-width="72px">
            <input
              v-model="confirmation"
              name="confirmation"
              password
              placeholder="再次输入新密码"
              :maxlength="250"
              :disabled="saving"
              class="password-input"
            />
          </wd-cell>
        </wd-cell-group>
        <view class="password-actions">
          <text v-if="error" class="password-error" role="alert">{{
            error
          }}</text>
          <button
            form-type="submit"
            class="password-save"
            :loading="saving"
            :disabled="saving"
          >
            保存
          </button>
        </view>
      </form>
    </scroll-view>
  </wd-config-provider>
</template>

<script setup>
import { inject, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";
const api = inject("enterprise-api");
const password = ref(""),
  confirmation = ref(""),
  saving = ref(false),
  error = ref("");
let disposed = false;
function returnToLogin() {
  uni.reLaunch({ url: "/pages/index/index" });
}
async function save(event) {
  if (saving.value) return;
  const nextPassword = event.detail?.value?.password ?? password.value;
  const repeated = event.detail?.value?.confirmation ?? confirmation.value;
  if (!nextPassword || nextPassword.length < 8 || nextPassword.length > 250) {
    error.value = "请设置 8—250 个字符的密码";
    return;
  }
  if (nextPassword !== repeated) {
    error.value = "两次输入的密码不一致";
    return;
  }
  error.value = "";
  saving.value = true;
  try {
    const profile = await api.changePassword(nextPassword);
    password.value = "";
    confirmation.value = "";
    uni.$emit("enterprise-profile-updated", profile);
    if (disposed) return;
    uni.showToast({ title: "密码已更新", icon: "success" });
    uni.navigateBack();
  } catch (failure) {
    if (disposed) return;
    if (failure.status === 401 || !api.hasToken()) return returnToLogin();
    error.value = failure.message;
  } finally {
    if (!disposed) saving.value = false;
  }
}
onLoad(() => {
  if (!api?.hasToken()) return returnToLogin();
  if (api.getSession()?.user?.wechatRegistrationRequired)
    uni.redirectTo({ url: "/pages/settings/index" });
});
onUnload(() => {
  disposed = true;
  password.value = "";
  confirmation.value = "";
});
</script>

<style scoped>
.password-page {
  height: 100%;
  background: #f7f9f8;
}
.password-form {
  padding: 16px 0 calc(24px + env(safe-area-inset-bottom));
}
.password-input {
  width: 100%;
  height: 28px;
  text-align: right;
  font-size: 15px;
  color: #25342e;
}
.password-actions {
  padding: 24px 20px;
}
.password-error {
  display: block;
  margin-bottom: 12px;
  font-size: 13px;
  line-height: 20px;
  color: #b5473f;
}
.password-save {
  height: 46px;
  line-height: 46px;
  background: #237b61;
  color: #fff;
  border-radius: 8px;
  font-size: 15px;
}
.password-save::after {
  border: none;
}
.password-save[disabled] {
  background: #a8c7bb;
  color: #fff;
}
</style>
