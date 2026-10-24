<template>
  <wd-config-provider :theme-vars="themeVars" custom-style="height:100%;">
    <scroll-view scroll-y class="settings-scroll">
      <view v-if="session" class="settings-content">
        <view v-if="registering" class="registration-heading">完成注册</view>
        <form @submit="save">
          <wd-cell-group border>
            <wd-cell title="头像" center title-width="72px">
              <!-- #ifdef MP-WEIXIN -->
              <wd-button
                type="text"
                open-type="chooseAvatar"
                :disabled="saving || loading"
                custom-style="height:64px;padding:0;color:#92a095;"
                aria-label="选择头像"
                @chooseavatar="chooseAvatar"
              >
                <view class="avatar-control">
                  <image
                    v-if="selectedAvatar || avatar"
                    class="profile-avatar"
                    :src="selectedAvatar || avatar"
                    mode="aspectFill"
                  />
                  <view v-else class="profile-avatar avatar-fallback">{{
                    (name || "用户").slice(0, 1)
                  }}</view>
                  <wd-icon name="arrow-right" size="14px" />
                </view>
              </wd-button>
              <!-- #endif -->
              <!-- #ifndef MP-WEIXIN -->
              <wd-button
                type="text"
                :disabled="saving || loading"
                custom-style="height:64px;padding:0;color:#92a095;"
                aria-label="选择头像"
                @click="chooseImage"
              >
                <view class="avatar-control">
                  <image
                    v-if="selectedAvatar || avatar"
                    class="profile-avatar"
                    :src="selectedAvatar || avatar"
                    mode="aspectFill"
                  />
                  <view v-else class="profile-avatar avatar-fallback">{{
                    (name || "用户").slice(0, 1)
                  }}</view>
                  <wd-icon name="arrow-right" size="14px" />
                </view>
              </wd-button>
              <!-- #endif -->
            </wd-cell>
            <wd-cell title="昵称" center title-width="72px">
              <input
                v-model="name"
                name="nickname"
                type="nickname"
                class="nickname-input"
                placeholder="填写昵称"
                :maxlength="80"
                :disabled="saving || loading"
              />
            </wd-cell>
          </wd-cell-group>
          <view v-if="registering" class="settings-section">
            <wd-cell-group border>
              <wd-cell title="密码" center title-width="72px">
                <input
                  v-model="password"
                  name="password"
                  password
                  class="nickname-input"
                  placeholder="设置登录密码"
                  :maxlength="250"
                  :disabled="saving || loading"
                />
              </wd-cell>
              <wd-cell title="确认密码" center title-width="72px">
                <input
                  v-model="confirmPassword"
                  name="confirmPassword"
                  password
                  class="nickname-input"
                  placeholder="再次输入密码"
                  :maxlength="250"
                  :disabled="saving || loading"
                />
              </wd-cell>
            </wd-cell-group>
          </view>
          <view class="settings-actions">
            <text v-if="error" class="settings-error" role="alert">{{
              error
            }}</text>
            <button
              class="save-button"
              form-type="submit"
              :loading="saving"
              :disabled="saving || loading"
            >
              {{ registering ? "注册并进入" : "保存" }}
            </button>
          </view>
        </form>
        <view v-if="!registering" class="settings-section">
          <wd-cell-group border>
            <wd-cell
              title="登录账号"
              center
              title-width="72px"
              clickable
              @click="copyAccount"
            >
              <text class="account-value">{{ session.user.username }}</text>
            </wd-cell>
            <wd-cell title="修改密码" is-link clickable @click="openPassword" />
            <wd-cell
              title="用户后台"
              :label="webAddress"
              value="复制地址"
              is-link
              clickable
              @click="copyWebAddress"
            />
          </wd-cell-group>
        </view>
        <view class="logout-section">
          <wd-button
            block
            type="text"
            :disabled="saving"
            custom-style="height:48px;border-radius:0;background:#fff;color:#b5473f;font-size:15px;"
            @click="logout"
            >退出登录</wd-button
          >
        </view>
      </view>
      <view v-else class="settings-loading"
        ><wd-loading color="#237b61"
      /></view>
    </scroll-view>
  </wd-config-provider>
</template>

<script setup>
import { inject, ref } from "vue";
import { onLoad, onUnload } from "@dcloudio/uni-app";

const api = inject("enterprise-api");
const themeVars = {
  colorTheme: "#237b61",
  colorTitle: "#25342e",
  colorContent: "#5e6e64",
  colorSecondary: "#92a095",
  colorBorder: "#e5ebe7",
};
const session = ref(null),
  name = ref(""),
  avatar = ref(""),
  selectedAvatar = ref("");
const error = ref(""),
  saving = ref(false),
  loading = ref(true),
  registering = ref(false),
  password = ref(""),
  confirmPassword = ref("");
const webAddress = api.getEndpoint().replace(/\/api$/, "");
let disposed = false;

function syncSession(value) {
  session.value = value;
  registering.value = value?.user?.wechatRegistrationRequired === true;
  const currentName = value?.user?.name || "";
  name.value =
    value?.user?.wechatRegistrationRequired === true &&
    (!currentName ||
      currentName === "微信用户" ||
      /^用户\d+$/.test(currentName))
      ? ""
      : currentName;
}
function returnToLogin() {
  uni.reLaunch({ url: "/pages/index/index" });
}
async function load() {
  if (!api?.hasToken()) return returnToLogin();
  syncSession(api.getSession());
  try {
    const value = await api.me();
    if (disposed) return;
    syncSession(value);
    uni.setNavigationBarTitle({ title: registering.value ? "注册" : "设置" });
    await refreshAvatar();
  } catch (failure) {
    if (disposed) return;
    if (failure.status === 401 || !api.hasToken()) return returnToLogin();
    error.value = failure.message;
  } finally {
    if (!disposed) loading.value = false;
  }
}
async function refreshAvatar() {
  try {
    const path = await api.avatar();
    if (!disposed) avatar.value = path;
  } catch (failure) {
    if (failure.status === 401) throw failure;
  }
}
function chooseAvatar(event) {
  if (!saving.value && !loading.value && event?.avatarUrl)
    selectedAvatar.value = event.avatarUrl;
}
function chooseImage() {
  if (saving.value || loading.value) return;
  uni.chooseImage({
    count: 1,
    sizeType: ["compressed"],
    success(value) {
      if (!disposed && !saving.value)
        selectedAvatar.value = value.tempFilePaths?.[0] || "";
    },
  });
}
async function save(event) {
  if (saving.value || loading.value || !session.value) return;
  const nickname = String(event.detail?.value?.nickname ?? name.value).trim();
  if (!nickname || nickname.length > 80) {
    error.value = "请填写 1—80 个字符的昵称";
    return;
  }
  const newPassword = event.detail?.value?.password ?? password.value;
  const repeatedPassword =
    event.detail?.value?.confirmPassword ?? confirmPassword.value;
  if (
    registering.value &&
    !selectedAvatar.value &&
    !session.value.user.pfpFilename
  ) {
    error.value = "请选择头像";
    return;
  }
  if (
    registering.value &&
    (!newPassword || newPassword.length < 8 || newPassword.length > 250)
  ) {
    error.value = "请设置 8—250 个字符的密码";
    return;
  }
  if (registering.value && newPassword !== repeatedPassword) {
    error.value = "两次输入的密码不一致";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    if (registering.value) {
      if (selectedAvatar.value) {
        const value = await api.uploadAvatar({ path: selectedAvatar.value });
        if (disposed) return;
        session.value = value;
        selectedAvatar.value = "";
        await refreshAvatar();
      }
      const { recoveryCodes, ...profile } =
        await api.completeWechatRegistration(nickname, newPassword);
      password.value = "";
      confirmPassword.value = "";
      uni.$emit("enterprise-profile-updated", profile);
      if (disposed) return;
      if (recoveryCodes?.length) {
        uni.showModal({
          title: "请保存账号恢复码",
          content: `恢复码仅显示一次，找回密码时需要使用。\n${recoveryCodes.join("\n")}`,
          confirmText: "复制恢复码",
          cancelText: "已保存",
          success(result) {
            if (result.confirm)
              uni.setClipboardData({ data: recoveryCodes.join("\n") });
          },
          complete() {
            returnToLogin();
          },
        });
      } else returnToLogin();
      return;
    }
    const profile = await api.updateProfile(nickname);
    uni.$emit("enterprise-profile-updated", profile);
    if (disposed) return;
    syncSession(profile);
    if (selectedAvatar.value) {
      const value = await api.uploadAvatar({ path: selectedAvatar.value });
      uni.$emit("enterprise-profile-updated", value);
      if (disposed) return;
      syncSession(value);
      selectedAvatar.value = "";
    }
    if (!disposed) uni.showToast({ title: "已保存", icon: "success" });
    await refreshAvatar();
  } catch (failure) {
    if (disposed) return;
    if (failure.status === 401 || !api.hasToken()) return returnToLogin();
    error.value = failure.message;
  } finally {
    if (!disposed) saving.value = false;
  }
}
function openPassword() {
  if (!saving.value) uni.navigateTo({ url: "/pages/settings/password" });
}
function copyWebAddress() {
  uni.setClipboardData({ data: webAddress });
}
function copyAccount() {
  uni.setClipboardData({ data: session.value.user.username });
}
function logout() {
  if (saving.value) return;
  api.clearSession();
  returnToLogin();
}
onLoad(load);
onUnload(() => {
  disposed = true;
  password.value = "";
  confirmPassword.value = "";
});
</script>

<style scoped>
.settings-scroll {
  height: 100%;
  background: #f7f9f8;
}
.settings-content {
  box-sizing: border-box;
  padding: 16px 0 calc(24px + env(safe-area-inset-bottom));
  color: #25342e;
}
.avatar-control {
  display: flex;
  align-items: center;
  gap: 12px;
}
.profile-avatar {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  border-radius: 10px;
}
.avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e6f0ea;
  color: #527661;
  font-size: 23px;
}
.nickname-input {
  width: 100%;
  height: 28px;
  text-align: right;
  font-size: 15px;
  color: #25342e;
}
.account-value {
  display: block;
  text-align: right;
  word-break: break-all;
  white-space: normal;
  font-size: 13px;
  line-height: 20px;
}
.settings-section {
  margin-top: 16px;
}
.registration-heading {
  padding: 12px 20px 24px;
  font-size: 24px;
  font-weight: 600;
}
.settings-actions {
  padding: 24px 20px 0;
}
.settings-error {
  display: block;
  margin-bottom: 12px;
  font-size: 13px;
  line-height: 20px;
  color: #b5473f;
}
.save-button {
  height: 46px;
  line-height: 46px;
  background: #237b61;
  color: #fff;
  border-radius: 8px;
  font-size: 15px;
}
.save-button::after {
  border: none;
}
.save-button[disabled] {
  background: #a8c7bb;
  color: #fff;
}
.logout-section {
  margin-top: 24px;
}
.settings-loading {
  display: flex;
  justify-content: center;
  padding-top: 80px;
}
</style>
