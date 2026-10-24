<template>
  <wd-config-provider :theme-vars="themeVars">
    <view
      v-if="!session || session.user.wechatRegistrationRequired"
      class="login-shell"
      :style="shellStyle"
    >
      <view class="login-card"
        ><view class="brand-symbol"
          ><wd-icon name="layers" size="26px" color="#fff" /></view
        ><text class="login-brand">知行</text
        ><text class="login-heading">{{
          booting ? "正在连接服务" : session?.user.wechatRegistrationRequired ? "完成注册" : registering ? "注册账号" : "登录知行"
        }}</text
        ><view v-if="booting" class="login-loading"
          ><wd-loading color="#237b61" /></view
        ><view v-else-if="!initialized" class="setup-note"
          ><text>{{
            bootError ||
            "系统尚未初始化，请联系平台管理员完成设置并开通企业账号。"
          }}</text
          ><wd-button plain size="small" @click="boot"
            >重新检查</wd-button
          ></view
        ><template v-else-if="session?.user.wechatRegistrationRequired">
          <wd-button
            block
            custom-style="margin-top:28px;height:44px;"
            @click="openRegistration"
            >完成注册</wd-button
          >
          <text v-if="loginError" class="login-error" role="alert">{{
            loginError
          }}</text> </template
        ><template v-else>
          <!-- #ifdef MP-WEIXIN -->
          <wd-button
            v-if="wechatLoginEnabled && !passwordLogin && !registering"
            block
            :loading="loggingIn"
            :disabled="loggingIn"
            custom-style="margin-top:28px;height:44px;"
            @click="wechatLogin"
            >微信登录</wd-button
          >
          <wd-button
            v-if="wechatLoginEnabled && !registering"
            block
            type="text"
            :disabled="loggingIn"
            @click="passwordLogin = !passwordLogin"
            >{{ passwordLogin ? "返回微信登录" : "账号密码登录" }}</wd-button
          >
          <!-- #endif -->
          <view v-if="!wechatLoginEnabled || passwordLogin || registering">
            <text class="field-label">用户名</text>
            <input
              v-model="username"
              class="login-input"
              placeholder="输入用户名"
              :disabled="loggingIn"
              :maxlength="64"
            />
            <text class="field-label">密码</text>
            <input
              v-model="password"
              class="login-input"
              password
              placeholder="输入密码"
              :disabled="loggingIn"
              :maxlength="-1"
              confirm-type="done"
              @confirm="login"
            />
            <template v-if="registering"
              ><text class="field-label">确认密码</text
              ><input
                v-model="confirmPassword"
                class="login-input"
                password
                placeholder="再次输入密码"
                :disabled="loggingIn"
                :maxlength="-1"
                confirm-type="done"
                @confirm="login"
            /></template>
            <wd-button
              block
              :loading="loggingIn"
              custom-style="margin-top:26px;height:44px;"
              @click="login"
              >{{ registering ? "注册并登录" : "登录" }}</wd-button
            >
            <wd-button
              block
              type="text"
              :disabled="loggingIn"
              @click="toggleRegistration"
              >{{ registering ? "已有账号？返回登录" : "注册账号" }}</wd-button
            >
          </view>
          <text v-if="loginError" class="login-error" role="alert">{{
            loginError
          }}</text>
        </template>
      </view>
    </view>
    <view v-else class="app-shell" :style="shellStyle">
      <view v-if="isDesktop" class="desktop-sidebar"
        ><ChatSidebar
          v-bind="sidebarProps"
          @navigate="navigate"
          @new-conversation="newConversation"
          @select-conversation="openConversation"
          @settings="openSettings"
      /></view>
      <wd-popup
        v-if="!isDesktop"
        v-model="sidebarOpen"
        position="left"
        :z-index="60"
        custom-style="width:286px;max-width:88vw;height:100%;background:#f7f9f8;"
        ><view class="mobile-sidebar" :style="{ paddingTop: `${drawerTop}px` }"
          ><ChatSidebar
            v-bind="sidebarProps"
            mobile
            @navigate="navigate"
            @new-conversation="newConversation"
            @select-conversation="openConversation"
            @close="sidebarOpen = false"
            @settings="openSettings" /></view
      ></wd-popup>
      <view class="main-panel">
        <view class="app-header" :style="headerStyle">
          <view class="header-left"
            ><wd-button
              v-if="!isDesktop"
              type="icon"
              icon="menu-unfold"
              aria-label="打开导航"
              custom-style="width:34px;min-width:34px;color:#637269;"
              @click="sidebarOpen = true"
            /><text class="header-title">{{ currentSection.title }}</text
            ><text v-if="isDesktop" class="header-divider">/</text
            ><text v-if="isDesktop" class="header-subtitle">{{
              currentSection.description
            }}</text></view
          >
          <view class="header-actions"
            ><wd-button
              v-if="active === 'chat'"
              type="icon"
              icon="add"
              aria-label="开启新对话"
              custom-style="width:32px;min-width:32px;color:#74867a;"
              @click="newConversation"
          /></view>
        </view>
        <view v-if="pageError" class="page-error" role="alert"
          ><text>{{ pageError }}</text
          ><wd-button type="text" size="small" @click="refreshConversations"
            >重试</wd-button
          ></view
        >
        <view
          class="chat-layout"
          :style="{ display: active === 'chat' ? 'flex' : 'none' }"
        >
          <view class="chat-main"
            ><view class="chat-toolbar">
              <view class="conversation-title"
                ><wd-icon name="chat" size="15px" color="#87958b" /><text>{{
                  currentConversation?.title || "新的对话"
                }}</text></view
              >
              <wd-button
                v-if="currentConversation"
                type="icon"
                icon="delete"
                aria-label="删除当前对话"
                :disabled="sending || conversationLoading"
                @click="deleteConversation"
              />
            </view>
            <view class="retrieval-controls"
              ><text class="retrieval-label">检索范围</text
              ><view class="scope-option selected"
                ><wd-icon name="secured" size="12px" /><text
                  >全部获授权知识库</text
                ></view
              ><text class="scope-count">{{ documentCount }} 份资料</text></view
            >
            <scroll-view
              scroll-y
              class="conversation-scroll"
              :scroll-into-view="scrollTarget"
              :scroll-with-animation="false"
              ><view
                class="conversation-content"
                :class="{ 'is-welcome': !messages.length }"
                ><view v-if="conversationLoading" class="loading-state"
                  ><wd-loading color="#237b61" /><text
                    >正在加载对话…</text
                  ></view
                ><view v-else-if="!messages.length" class="welcome-screen">
                  <view class="welcome-heading"
                    ><text class="welcome-title">有什么想了解的？</text></view
                  >
                  <text class="welcome-description"
                    >输入问题，检索你有权限访问的知识。</text
                  >
                </view>
                <view v-else class="message-list"
                  ><ChatMessage
                    v-for="message in messages"
                    :key="message.id"
                    :message="message"
                    @view-source="openSource"
                    @retry="retryMessage" /></view
                ><view id="messages-bottom" class="messages-bottom" /></view
            ></scroll-view>
            <view class="composer-region"
              ><view class="composer-width"
                ><ChatComposer
                  ref="composer"
                  v-model="draft"
                  :disabled="conversationLoading"
                  :sending="sending"
                  :max-length="8000"
                  :compact="keyboardHeight > 0"
                  :error="sendError"
                  placeholder="输入问题…"
                  context-label="全部获授权知识库"
                  @send="sendMessage"
                  @stop="stopMessage"
                  @clear-error="sendError = ''"
                  @keyboard-height="onKeyboardHeight"
                /><view v-if="!keyboardHeight" class="composer-caption"
                  ><text
                    >答案基于可访问的资料与对话上下文，请核对参考来源。</text
                  ><text v-if="isDesktop">Shift + Enter 换行</text></view
                ></view
              ></view
            >
          </view>
          <view v-if="isDesktop" class="context-rail"
            ><view class="rail-heading"
              ><text>我的知识范围</text
              ><text class="rail-count">{{
                visibleLibraries.length
              }}</text></view
            ><text class="rail-description">全部获授权知识库，答案附带来源</text
            ><view
              v-for="library in visibleLibraries"
              :key="library.id"
              class="rail-library"
              ><view class="rail-icon" :style="{ color: library.color }"
                ><wd-icon :name="library.icon" size="18px" /></view
              ><view class="rail-library-copy"
                ><text class="rail-library-name">{{ library.name }}</text
                ><text class="rail-library-count"
                  >{{
                    visibleDocuments.filter(
                      (doc) => doc.libraryId === library.id
                    ).length
                  }}
                  份资料 ·
                  {{ library.scope === "public" ? "公有" : "仅自己" }}</text
                ></view
              ><wd-icon name="check" size="13px" color="#91ab98" /></view
          ></view>
        </view>
        <view
          class="panel-slot"
          :style="{ display: active === 'knowledge' ? 'flex' : 'none' }"
          ><KnowledgePanel
            ref="knowledge"
            @count="documentCount = $event"
            @updated="updateKnowledge"
            @chat="navigate('chat')"
        /></view>
        <view v-if="!isDesktop && !keyboardHeight" class="bottom-nav"
          ><view
            v-for="item in navigation"
            :key="item.id"
            :id="`nav-${item.id}`"
            :data-section="item.id"
            class="bottom-item"
            :class="{ selected: active === item.id }"
            @click="navigate(item.id)"
            ><wd-icon :name="item.icon" size="21px" /><text>{{
              item.name
            }}</text></view
          ><view
            id="nav-settings"
            class="bottom-item"
            role="button"
            aria-label="设置"
            @click="openSettings"
            ><wd-icon name="setting" size="21px" /><text>设置</text></view
          ></view
        >
      </view>
    </view>
    <wd-popup
      v-model="sourceOpen"
      position="center"
      custom-style="width:calc(100% - 32px);max-width:680px;border-radius:18px;"
      ><view class="source-dialog"
        ><view class="source-dialog-header"
          ><view
            ><text class="dialog-title">{{
              sourceDocument?.title || "参考来源"
            }}</text
            ><text class="dialog-description"
              >{{
                sourceDocument?.visibility === "private"
                  ? "我的私有资料"
                  : "租户公有资料"
              }}
              · 当前版本</text
            ></view
          ><wd-button
            type="icon"
            icon="close"
            aria-label="关闭来源"
            @click="sourceOpen = false" /></view
        ><scroll-view scroll-y class="source-dialog-content"
          ><text selectable>{{
            sourceDocument?.content || "该资料暂时没有正文。"
          }}</text></scroll-view
        ><text class="source-dialog-foot"
          >打开原文时已由服务端重新验证当前访问权限。</text
        ></view
      ></wd-popup
    >
  </wd-config-provider>
</template>

<script setup>
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  inject,
  ref,
} from "vue";
import { onResize, onShow } from "@dcloudio/uni-app";
import ChatSidebar from "@/components/ChatSidebar.vue";
import ChatComposer from "@/components/ChatComposer.vue";
import ChatMessage from "@/components/ChatMessage.vue";
import KnowledgePanel from "@/components/KnowledgePanel.vue";

const themeVars = {
  colorTheme: "#237b61",
  colorTitle: "#25342e",
  colorContent: "#5e6e64",
  colorSecondary: "#92a095",
  colorBorder: "#e5ebe7",
  buttonMediumHeight: "40px",
  buttonMediumRadius: "9px",
  buttonMediumFs: "13px",
  buttonSmallHeight: "32px",
  buttonSmallRadius: "7px",
  buttonSmallFs: "12px",
  buttonIconSize: "19px",
};
const visibleLibraries = ref([]),
  visibleDocuments = ref([]);
const currentSection = computed(() =>
  active.value === "chat"
    ? { title: "问答检索", description: "个人对话" }
    : { title: "知识资料", description: "知识库与资料" }
);
function updateKnowledge(value) {
  visibleLibraries.value = value.libraries.map((library) => ({
    ...library,
    icon: library.scope === "private" ? "secured" : "folder",
    color: "#6b8d7c",
  }));
  visibleDocuments.value = value.documents;
}
const session = ref(null),
  booting = ref(true),
  initialized = ref(false),
  wechatLoginEnabled = ref(false),
  passwordLogin = ref(true),
  bootError = ref("");
const username = ref(""),
  password = ref(""),
  confirmPassword = ref(""),
  registering = ref(false),
  loggingIn = ref(false),
  loginError = ref("");
const active = ref("chat"),
  sidebarOpen = ref(false),
  documentCount = ref(0),
  conversations = ref([]),
  currentConversation = ref(null),
  messages = ref([]);
const draft = ref(""),
  sending = ref(false),
  sendError = ref(""),
  pageError = ref(""),
  conversationLoading = ref(false),
  scrollTarget = ref("");
const avatarPath = ref("");
const sourceOpen = ref(false),
  sourceDocument = ref(null),
  composer = ref(null),
  knowledge = ref(null);
const isDesktop = ref(false),
  viewportHeight = ref(700),
  viewportTop = ref(0),
  statusBarHeight = ref(0),
  drawerTop = ref(0),
  capsuleWidth = ref(0),
  keyboardHeight = ref(0),
  nativeBaseHeight = ref(0);
const navigation = [
  { id: "chat", name: "问答检索", icon: "chat" },
  { id: "knowledge", name: "知识资料", icon: "books" },
];
let version = 0,
  disposed = false,
  sourceVersion = 0,
  activeMessage = null;
const api = inject("enterprise-api");
function onUnauthorized() {
  reset();
  loginError.value = "登录已过期，请重新登录";
}
const currentUser = computed(() => ({
  id: session.value?.user?.id,
  name: session.value?.user?.name || session.value?.user?.username || "用户",
  role: session.value?.role === "admin" ? "管理员" : "成员",
  avatar: avatarPath.value,
  tenantName: session.value?.tenant?.name || "",
  tenantHost: api.getEndpoint().replace(/\/api$/, ""),
}));
const sidebarProps = computed(() => ({
  active: active.value,
  documentCount: documentCount.value,
  conversations: conversations.value,
  selectedConversation: currentConversation.value?.id || "",
  currentUser: currentUser.value,
}));
const shellStyle = computed(() => ({
  top: `${viewportTop.value}px`,
  height: `${Math.max(250, viewportHeight.value - nativeKeyboardInset())}px`,
}));
const headerStyle = computed(() => ({
  minHeight: `${64 + statusBarHeight.value}px`,
  paddingTop: `${statusBarHeight.value}px`,
  paddingRight: capsuleWidth.value ? `${capsuleWidth.value}px` : undefined,
}));
function nativeKeyboardInset() {
  let inset = 0;
  // #ifndef H5
  inset = Math.max(
    0,
    keyboardHeight.value -
      Math.max(0, nativeBaseHeight.value - viewportHeight.value)
  );
  // #endif
  return inset;
}
function reset() {
  activeMessage?.cancel?.();
  activeMessage = null;
  version += 1;
  sourceVersion += 1;
  session.value = null;
  avatarPath.value = "";
  conversations.value = [];
  currentConversation.value = null;
  messages.value = [];
  draft.value = "";
  password.value = "";
  confirmPassword.value = "";
  registering.value = false;
  sourceOpen.value = false;
  sourceDocument.value = null;
  sidebarOpen.value = false;
  documentCount.value = 0;
  visibleLibraries.value = [];
  visibleDocuments.value = [];
  sending.value = false;
  conversationLoading.value = false;
  sendError.value = "";
  pageError.value = "";
  active.value = "chat";
}
async function boot() {
  booting.value = true;
  bootError.value = "";
  try {
    const result = await api.status();
    if (disposed) return;
    initialized.value = !!result.initialized;
    wechatLoginEnabled.value = result.site?.tenant?.wechatLoginEnabled === true;
    // #ifdef MP-WEIXIN
    passwordLogin.value = !wechatLoginEnabled.value;
    // #endif
    if (initialized.value && api.hasToken()) {
      session.value = await api.me();
      if (session.value.user.wechatRegistrationRequired)
        return openRegistration();
      await refreshAvatar();
      await refreshConversations();
    }
  } catch (error) {
    if (disposed) return;
    if (error.status !== 401) {
      bootError.value = error.message;
      if (initialized.value) loginError.value = error.message;
    }
  } finally {
    if (!disposed) booting.value = false;
  }
}
async function login() {
  if (loggingIn.value) return;
  if (!username.value.trim() || !password.value)
    return void (loginError.value = "请填写用户名和密码");
  if (registering.value && password.value !== confirmPassword.value)
    return void (loginError.value = "两次输入的密码不一致");
  loggingIn.value = true;
  loginError.value = "";
  try {
    const value = await (registering.value ? api.register : api.login).call(
      api,
      username.value.trim(),
      password.value
    );
    if (disposed) return;
    version += 1;
    const { recoveryCodes, ...identity } = value;
    session.value = identity;
    password.value = "";
    confirmPassword.value = "";
    registering.value = false;
    if (identity.user.wechatRegistrationRequired) return openRegistration();
    showRecoveryCodes(recoveryCodes);
    await refreshAvatar();
    await refreshConversations();
  } catch (error) {
    if (!disposed) loginError.value = error.message;
  } finally {
    if (!disposed) loggingIn.value = false;
  }
}
// #ifdef MP-WEIXIN
async function wechatLogin() {
  if (loggingIn.value || !wechatLoginEnabled.value) return;
  loggingIn.value = true;
  loginError.value = "";
  try {
    const { recoveryCodes, ...identity } = await api.wechatLogin();
    if (disposed) return;
    version += 1;
    session.value = identity;
    password.value = "";
    confirmPassword.value = "";
    registering.value = false;
    if (identity.user.wechatRegistrationRequired) return openRegistration();
    showRecoveryCodes(recoveryCodes);
    await refreshAvatar();
    await refreshConversations();
  } catch (error) {
    if (!disposed) loginError.value = error.message;
  } finally {
    if (!disposed) loggingIn.value = false;
  }
}
// #endif
let registrationOpening = false;
async function openRegistration() {
  if (registrationOpening) return;
  registrationOpening = true;
  await nextTick();
  if (disposed) return;
  uni.navigateTo({
    url: "/pages/settings/index",
    fail() {
      registrationOpening = false;
      loginError.value = "注册页面打开失败，请重试";
    },
  });
}
function showRecoveryCodes(recoveryCodes) {
  if (!recoveryCodes?.length) return;
  const codes = recoveryCodes.join("\n");
  uni.showModal({
    title: "请保存账号恢复码",
    content: `恢复码仅显示一次，找回密码时需要使用，请妥善保存。\n${codes}`,
    confirmText: "复制恢复码",
    cancelText: "已保存",
    success(result) {
      if (result.confirm) uni.setClipboardData({ data: codes });
    },
  });
}
let avatarVersion = 0;
async function refreshAvatar() {
  const expected = ++avatarVersion;
  avatarPath.value = "";
  if (!session.value?.user?.pfpFilename) return;
  try {
    const path = await api.avatar();
    if (!disposed && expected === avatarVersion && session.value)
      avatarPath.value = path;
  } catch {
    /* A missing avatar falls back to the user's initial. */
  }
}
let settingsOpen = false;
function openSettings() {
  if (settingsOpen || !session.value) return;
  if (sending.value) {
    uni.showToast({ title: "请等待回答完成或先停止生成", icon: "none" });
    return;
  }
  sidebarOpen.value = false;
  settingsOpen = true;
  uni.navigateTo({
    url: "/pages/settings/index",
    fail() {
      settingsOpen = false;
    },
  });
}
async function resumeFromSettings() {
  registrationOpening = false;
  if (!settingsOpen || disposed) return;
  settingsOpen = false;
  const value = api.getSession();
  if (!value) return reset();
  session.value = value;
  if (value.user.wechatRegistrationRequired) return openRegistration();
  await refreshAvatar();
}
function onProfileUpdated(value) {
  if (
    disposed ||
    !session.value ||
    value?.user?.id !== session.value.user.id ||
    value?.tenant?.id !== session.value.tenant.id
  )
    return;
  session.value = value;
  if (!settingsOpen) refreshAvatar();
}
function toggleRegistration() {
  if (loggingIn.value) return;
  registering.value = !registering.value;
  password.value = "";
  confirmPassword.value = "";
  loginError.value = "";
}
function navigate(id) {
  active.value = id;
  sidebarOpen.value = false;
  if (id === "knowledge") knowledge.value?.refresh();
}
async function refreshConversations() {
  if (!session.value) return;
  const expected = version;
  try {
    const result = await api.conversations();
    if (disposed || expected !== version) return;
    conversations.value = result.conversations || [];
    pageError.value = "";
  } catch (error) {
    if (!disposed && expected === version) pageError.value = error.message;
  }
}
function newConversation() {
  if (sending.value || conversationLoading.value) return;
  version += 1;
  currentConversation.value = null;
  messages.value = [];
  draft.value = "";
  sendError.value = "";
  active.value = "chat";
  sidebarOpen.value = false;
  composer.value?.clear();
}
async function openConversation(id) {
  if (sending.value || conversationLoading.value) return;
  const expected = ++version;
  conversationLoading.value = true;
  sendError.value = "";
  sidebarOpen.value = false;
  active.value = "chat";
  try {
    const result = await api.conversation(id);
    if (disposed || expected !== version) return;
    currentConversation.value = result.conversation;
    messages.value = result.messages || [];
    draft.value = "";
    await scrollBottom();
  } catch (error) {
    if (!disposed && expected === version) pageError.value = error.message;
  } finally {
    if (!disposed && expected === version) conversationLoading.value = false;
  }
}
async function scrollBottom() {
  scrollTarget.value = "";
  await nextTick();
  if (!disposed) scrollTarget.value = "messages-bottom";
}
async function sendMessage(value) {
  const text = String(value || draft.value).trim();
  if (!text || sending.value || conversationLoading.value || !session.value)
    return;
  const expected = version;
  let cancelWaiting;
  const cancellation = new Promise((resolve, reject) => {
    cancelWaiting = reject;
  });
  // Each awaited send step shares one cancellation promise, including the
  // initial scroll and saving a new empty conversation.
  const operation = { cancelled: false, request: null };
  activeMessage = operation;
  operation.cancel = () => {
    if (operation.cancelled) return;
    operation.cancelled = true;
    operation.request?.cancel?.();
    const error = new Error("已停止生成");
    error.cancelled = true;
    cancelWaiting(error);
  };
  sending.value = true;
  sendError.value = "";
  const userMessage = {
    id: `local-user-${Date.now()}`,
    role: "user",
    content: text,
  };
  const assistant = {
    id: `local-assistant-${Date.now()}`,
    role: "assistant",
    content: "",
    pending: true,
    question: text,
  };
  messages.value.push(userMessage, assistant);
  draft.value = "";
  composer.value?.clear();
  try {
    await Promise.race([scrollBottom(), cancellation]);
    if (!currentConversation.value) {
      const result = await Promise.race([
        api.createConversation(),
        cancellation,
      ]);
      if (disposed || expected !== version) return;
      currentConversation.value = result.conversation;
    }
    if (operation.cancelled) {
      const error = new Error("已停止生成");
      error.cancelled = true;
      throw error;
    }
    operation.request = api.streamMessage(
      currentConversation.value.id,
      text,
      (event) => {
        if (disposed || expected !== version || operation.cancelled) return;
        if (event.type === "delta") {
          const preview = messages.value.find(
            (message) => message.id === assistant.id
          );
          if (preview) preview.content += event.text;
          scrollBottom();
        }
      }
    );
    const result = await Promise.race([operation.request, cancellation]);
    if (disposed || expected !== version) return;
    const index = messages.value.findIndex(
      (message) => message.id === assistant.id
    );
    if (index >= 0)
      messages.value.splice(index, 1, { ...result.message, pending: false });
    await refreshConversations();
    if (disposed || expected !== version) return;
    currentConversation.value =
      conversations.value.find(
        (conversation) => conversation.id === currentConversation.value?.id
      ) || currentConversation.value;
  } catch (error) {
    if (disposed || expected !== version) return;
    const index = messages.value.findIndex(
      (message) => message.id === assistant.id
    );
    if (index >= 0)
      messages.value.splice(index, 1, {
        ...assistant,
        content: "",
        pending: false,
        interrupted: !!error.cancelled,
        error: error.cancelled ? "" : error.message,
      });
    sendError.value = error.cancelled ? "" : error.message;
  } finally {
    if (activeMessage === operation) activeMessage = null;
    if (!disposed && expected === version) {
      sending.value = false;
      await scrollBottom();
    }
  }
}
function stopMessage() {
  activeMessage?.cancel?.();
}
function retryMessage(message) {
  draft.value = message.question || "";
  sendError.value = "";
  composer.value?.focus();
}
function deleteConversation() {
  if (!currentConversation.value || sending.value || conversationLoading.value)
    return;
  const id = currentConversation.value.id,
    expected = version;
  uni.showModal({
    title: "删除对话",
    content: "确认删除这段对话及其历史消息？",
    confirmColor: "#b5473f",
    async success(result) {
      if (!result.confirm || disposed || expected !== version) return;
      conversationLoading.value = true;
      try {
        await api.deleteConversation(id);
        if (disposed || expected !== version) return;
        conversationLoading.value = false;
        newConversation();
        await refreshConversations();
      } catch (error) {
        if (!disposed && expected === version) {
          pageError.value = error.message;
          conversationLoading.value = false;
        }
      }
    },
  });
}
async function openSource(source) {
  const expected = version,
    sourceRequest = ++sourceVersion;
  sourceDocument.value = null;
  sourceOpen.value = false;
  try {
    const result = await api.document(source.documentId);
    if (disposed || expected !== version || sourceRequest !== sourceVersion)
      return;
    sourceDocument.value = result.document;
    sourceOpen.value = true;
  } catch (error) {
    if (!disposed && expected === version)
      uni.showToast({ title: error.message, icon: "none" });
  }
}
function onKeyboardHeight(value) {
  keyboardHeight.value = Math.max(0, Number(value) || 0);
}
function nativeKeyboardChange(event) {
  onKeyboardHeight(event?.height);
}
function syncLayout() {
  const info = uni.getWindowInfo
    ? uni.getWindowInfo()
    : uni.getSystemInfoSync();
  isDesktop.value = info.windowWidth >= 960;
  viewportHeight.value = info.windowHeight;
  statusBarHeight.value = Number(info.statusBarHeight) || 0;
  drawerTop.value = statusBarHeight.value;
  // #ifndef H5
  if (!keyboardHeight.value) nativeBaseHeight.value = info.windowHeight;
  // #endif
  // #ifdef H5
  viewportHeight.value = window.visualViewport?.height || window.innerHeight;
  viewportTop.value = window.visualViewport?.offsetTop || 0;
  keyboardHeight.value = Math.max(0, window.innerHeight - viewportHeight.value);
  // #endif
  // #ifdef MP-WEIXIN
  const capsule = uni.getMenuButtonBoundingClientRect();
  if (capsule?.right) {
    capsuleWidth.value = info.windowWidth - capsule.left + 8;
    drawerTop.value = capsule.bottom + 8;
  }
  // #endif
}
onResize(syncLayout);
onShow(resumeFromSettings);
onMounted(() => {
  uni.$on("enterprise-unauthorized", onUnauthorized);
  uni.$on("enterprise-profile-updated", onProfileUpdated);
  syncLayout();
  boot();
  // #ifdef MP-WEIXIN
  uni.onKeyboardHeightChange(nativeKeyboardChange);
  // #endif
  // #ifdef H5
  window.visualViewport?.addEventListener("resize", syncLayout);
  window.visualViewport?.addEventListener("scroll", syncLayout);
  // #endif
});
onBeforeUnmount(() => {
  uni.$off("enterprise-unauthorized", onUnauthorized);
  uni.$off("enterprise-profile-updated", onProfileUpdated);
  disposed = true;
  version += 1;
  sourceVersion += 1;
  api.cancelPending();
  // #ifdef MP-WEIXIN
  uni.offKeyboardHeightChange(nativeKeyboardChange);
  // #endif
  // #ifdef H5
  window.visualViewport?.removeEventListener("resize", syncLayout);
  window.visualViewport?.removeEventListener("scroll", syncLayout);
  // #endif
});
</script>

<style scoped>
.app-shell {
  position: fixed;
  left: 0;
  right: 0;
  display: flex;
  overflow: hidden;
  background: #fff;
  color: #25342e;
}
.desktop-sidebar {
  width: 236px;
  flex-shrink: 0;
  border-right: 1px solid #e6ece7;
}
.mobile-sidebar {
  height: 100%;
  box-sizing: border-box;
}
.main-panel {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-sizing: border-box;
  padding: 0 30px;
  border-bottom: 1px solid #edf0ed;
  flex-shrink: 0;
  background: #fff;
  gap: 12px;
}
.header-left,
.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.header-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.header-divider {
  color: #d5ddd7;
  font-size: 15px;
  margin: 0 2px;
}
.header-subtitle {
  font-size: 11px;
  color: #a0aaa3;
  white-space: nowrap;
}
.chat-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.chat-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.chat-toolbar {
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 32px;
  flex-shrink: 0;
  gap: 12px;
}
.conversation-title {
  display: flex;
  gap: 7px;
  align-items: center;
  min-width: 0;
  font-size: 11px;
  color: #9aa69e;
}
.conversation-title text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 340px;
}
.conversation-scroll {
  flex: 1;
  height: 0;
  min-height: 0;
}
.conversation-content {
  padding: 10px 34px 24px;
  box-sizing: border-box;
  max-width: 880px;
  margin: 0 auto;
  min-height: 100%;
}
.conversation-content.is-welcome {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding-bottom: 40px;
}
.welcome-screen {
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
}
.welcome-heading {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.welcome-title {
  font-size: 32px;
  line-height: 45px;
  letter-spacing: -1px;
  font-weight: 600;
  color: #24382d;
}
.welcome-description {
  display: block;
  font-size: 13px;
  line-height: 24px;
  color: #8e9b93;
  margin-top: 18px;
}
.inline-link {
  color: #638872;
  font-size: 11px;
  line-height: 20px;
  cursor: pointer;
  white-space: nowrap;
}
.inline-link text {
  margin-left: 4px;
}
.message-list {
  max-width: 770px;
  margin: 0 auto;
}
.messages-bottom {
  height: 1px;
}
.composer-region {
  flex-shrink: 0;
  padding: 12px 34px 15px;
  background: #fff;
}
.composer-width {
  max-width: 812px;
  margin: 0 auto;
}
.composer-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  line-height: 18px;
  color: #a3ada6;
  margin-top: 10px;
  padding: 0 3px;
}
.context-rail {
  width: 232px;
  flex-shrink: 0;
  background: #fafcfb;
  border-left: 1px solid #edf1ed;
  padding: 33px 22px;
  box-sizing: border-box;
}
.rail-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
  color: #5a6f60;
}
.rail-count {
  font-size: 9px;
  font-weight: 400;
  background: #eef2ed;
  color: #8e9f90;
  padding: 2px 5px;
  border-radius: 4px;
}
.rail-description {
  display: block;
  color: #a5afa7;
  font-size: 10px;
  line-height: 20px;
  margin: 9px 0 21px;
}
.rail-library {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 0;
}
.rail-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: #f0f4f0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rail-library-copy {
  flex: 1;
}
.rail-library-name {
  display: block;
  color: #617365;
  font-size: 11px;
  line-height: 19px;
}
.rail-library-count {
  display: block;
  color: #a2ada4;
  font-size: 10px;
  line-height: 18px;
}
.bottom-nav {
  display: flex;
  flex-shrink: 0;
  border-top: 1px solid #e8ede8;
  background: #fff;
  padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
  gap: 8px;
}
.bottom-item {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #98a49b;
  padding: 3px 0;
  cursor: pointer;
  border-radius: 8px;
}
.bottom-item.selected {
  color: #237b61;
}
.bottom-item.selected text {
  font-weight: 600;
}
@media (max-width: 1250px) {
  .context-rail {
    display: none;
  }
}
@media (min-width: 1600px) {
  .desktop-sidebar {
    width: 254px;
  }
  .context-rail {
    width: 264px;
    padding: 40px 28px;
  }
  .welcome-title {
    font-size: 38px;
    line-height: 52px;
  }
}
@media (max-width: 959px) {
  .app-header {
    padding: 0 18px;
    min-height: 58px;
  }
  .header-left {
    gap: 9px;
  }
  .header-actions {
    gap: 6px;
  }
  .header-title {
    font-size: 14px;
  }
  .chat-toolbar {
    height: 46px;
    padding: 0 23px;
  }
  .conversation-content {
    padding: 14px 24px 24px;
  }
  .conversation-content.is-welcome {
    justify-content: center;
    padding-bottom: 20px;
  }
  .welcome-title {
    font-size: 28px;
    line-height: 40px;
  }
  .welcome-description {
    font-size: 12px;
    line-height: 22px;
    margin-top: 14px;
  }
  .inline-link {
    font-size: 10px;
  }
  .composer-region {
    padding: 9px 20px 10px;
  }
  .composer-caption {
    justify-content: center;
    font-size: 9px;
    margin-top: 7px;
  }
  .conversation-title text {
    max-width: 180px;
  }
}
@media (max-width: 380px) {
  .conversation-content {
    padding-left: 20px;
    padding-right: 20px;
  }
  .welcome-title {
    font-size: 25px;
  }
}
@media (max-height: 760px) {
  .welcome-title {
    font-size: 28px;
    line-height: 38px;
  }
  .welcome-description {
    margin-top: 10px;
  }
  .conversation-content.is-welcome {
    padding-top: 12px;
    padding-bottom: 16px;
  }
}
</style>
<style scoped>
.panel-slot {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  flex-direction: column;
}
/* #ifdef H5 */
.conversation-scroll :deep(.uni-scroll-view),
.history-scroll :deep(.uni-scroll-view) {
  scrollbar-width: thin;
  scrollbar-color: #dce5de transparent;
}
/* #endif */
</style>
<style scoped>
.retrieval-controls {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 32px 13px;
  flex-shrink: 0;
  border-bottom: 1px solid #f3f5f2;
}
.retrieval-label {
  font-size: 10px;
  color: #99a69c;
  margin-right: 4px;
  white-space: nowrap;
}
.scope-option {
  display: flex;
  align-items: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 5px 9px;
  color: #89998e;
  font-size: 10px;
  white-space: nowrap;
  cursor: pointer;
}
.scope-option.selected {
  color: #237b61;
  background: #eff6f1;
  border-color: #ddebe1;
}
.scope-count {
  font-size: 10px;
  color: #a2ada5;
  margin-left: auto;
  white-space: nowrap;
}
.dialog-title {
  display: block;
  font-size: 18px;
  line-height: 27px;
  color: #2d4435;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.dialog-description {
  display: block;
  margin-top: 9px;
  font-size: 12px;
  line-height: 21px;
  color: #90a095;
}
.source-dialog {
  padding: 24px;
}
.source-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding-bottom: 18px;
  border-bottom: 1px solid #edf1ec;
}
.source-dialog-content {
  height: 320px;
  max-height: 48vh;
  padding: 18px 0;
  box-sizing: border-box;
}
.source-dialog-content text {
  font-size: 13px;
  line-height: 25px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #5f7565;
}
.source-dialog-foot {
  display: block;
  font-size: 10px;
  color: #9da99f;
  padding-top: 15px;
  border-top: 1px solid #edf1ec;
}
@media (max-width: 959px) {
  .retrieval-controls {
    padding: 0 21px 10px;
    gap: 4px;
  }
  .scope-option {
    font-size: 9px;
    padding: 4px 6px;
  }
  .scope-count {
    font-size: 9px;
  }
  .source-dialog {
    padding: 20px;
  }
  .retrieval-label {
    font-size: 9px;
    margin-right: 2px;
  }
}
@media (max-width: 380px) {
  .scope-count {
    display: none;
  }
}
</style>
<style scoped>
/* New authentication form uses the existing theme; app styles above are unchanged. */
.login-shell {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  background: #f5f8f2;
  overflow-y: auto;
  padding: 30px 20px;
  box-sizing: border-box;
}
.login-card {
  flex-shrink: 0;
  margin: auto 0;
  width: 100%;
  max-width: 410px;
  box-sizing: border-box;
  padding: 37px 34px 28px;
  border: 1px solid #e5ece1;
  border-radius: 22px;
  background: #fff;
  box-shadow: 0 15px 55px #294e3010;
}
.brand-symbol {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  background: #237b61;
  border-radius: 14px;
  vertical-align: middle;
}
.login-brand {
  font-size: 28px;
  color: #234b33;
  font-weight: 600;
  letter-spacing: 4px;
  margin-left: 13px;
  vertical-align: middle;
}
.login-heading {
  display: block;
  font-size: 23px;
  color: #304f3b;
  font-weight: 600;
  line-height: 34px;
  margin-top: 29px;
}
.field-label {
  display: block;
  font-size: 12px;
  color: #698371;
  margin: 18px 0 8px;
}
.field-hint {
  display: block;
  margin-top: 6px;
  font-size: 10px;
  line-height: 18px;
  color: #97a599;
}
.login-input {
  width: 100%;
  height: 44px;
  box-sizing: border-box;
  border: 1px solid #dfe7dd;
  border-radius: 9px;
  padding: 0 12px;
  font-size: 13px;
  background: #fbfcfa;
}
.login-error {
  display: block;
  font-size: 12px;
  line-height: 21px;
  color: #b5473f;
  margin-top: 13px;
}
.login-loading {
  padding: 25px;
  text-align: center;
}
.setup-note {
  color: #8b9e8e;
  font-size: 13px;
  line-height: 25px;
}
.setup-note text {
  display: block;
  margin-bottom: 20px;
}

.page-error,
.loading-state {
  padding: 16px 32px;
  color: #b56b63;
  font-size: 13px;
}
</style>
