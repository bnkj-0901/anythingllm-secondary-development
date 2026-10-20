<template>
  <wd-config-provider :theme-vars="themeVars">
    <view class="app-shell" :style="shellStyle">
      <view v-if="isDesktop" class="desktop-sidebar"
        ><ChatSidebar
          v-bind="sidebarProps"
          @navigate="navigate"
          @new-conversation="newConversation"
          @select-conversation="openConversation"
          @switch-user="userPickerOpen = true"
      /></view>
      <wd-popup
        v-if="!isDesktop"
        v-model="sidebarOpen"
        position="left"
        :z-index="60"
        custom-style="width:286px;max-width:88vw;height:100%;background:#f7f9f8;"
      >
        <view class="mobile-sidebar" :style="{ paddingTop: `${drawerTop}px` }"
          ><ChatSidebar
            v-bind="sidebarProps"
            mobile
            @navigate="navigate"
            @new-conversation="newConversation"
            @select-conversation="openConversation"
            @close="sidebarOpen = false"
            @switch-user="userPickerOpen = true"
        /></view>
      </wd-popup>
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
            ><view
              class="demo-badge"
              role="button"
              aria-label="切换演示身份"
              @click="userPickerOpen = true"
              ><view class="badge-dot" /><text
                >演示 · {{ currentUser.name }}</text
              ><wd-icon name="arrow-down" size="10px" /></view
            ><wd-button
              v-if="active === 'chat'"
              type="icon"
              icon="add"
              aria-label="开启新对话"
              custom-style="width:32px;min-width:32px;color:#74867a;"
              @click="newConversation"
          /></view>
        </view>
        <view
          class="chat-layout"
          :style="{ display: active === 'chat' ? 'flex' : 'none' }"
        >
          <view class="chat-main">
            <view class="chat-toolbar">
              <view class="conversation-title">
                <wd-icon name="chat" size="15px" color="#87958b" />
                <text>{{ currentConversation?.title || "新的对话" }}</text>
              </view>
            </view>
            <view class="retrieval-controls">
              <text class="retrieval-label">检索范围</text>
              <view
                v-for="option in scopeOptions"
                :key="option.id"
                class="scope-option"
                :class="{ selected: retrievalScope === option.id }"
                role="button"
                :aria-label="`检索${option.label}`"
                @click="setRetrievalScope(option.id)"
                ><wd-icon
                  v-if="option.id === 'private'"
                  name="secured"
                  size="12px"
                /><text>{{ option.label }}</text></view
              >
              <text class="scope-count"
                >{{ scopedDocuments.length }} 份资料</text
              >
            </view>
            <scroll-view
              scroll-y
              class="conversation-scroll"
              :scroll-into-view="scrollTarget"
              :scroll-with-animation="false"
            >
              <view
                class="conversation-content"
                :class="{ 'is-welcome': !messages.length }"
              >
                <view v-if="!messages.length" class="welcome-screen">
                  <view class="welcome-eyebrow"
                    ><view class="eyebrow-line" /><text
                      >知识相连，工作向前</text
                    ></view
                  >
                  <view class="welcome-heading"
                    ><text class="welcome-greeting"
                      >你好，{{ currentUser.name }}</text
                    ><text class="welcome-title">今天想了解什么？</text></view
                  >
                  <text class="welcome-description"
                    >让团队的共同知识与自己的工作经验，一起成为答案。</text
                  >
                  <view class="scope-label"
                    ><wd-icon
                      name="check-circle"
                      size="14px"
                      color="#6d927e"
                    /><text
                      >{{ retrievalDescription }}，直接提问即可</text
                    ></view
                  >
                  <view class="suggestion-grid">
                    <view
                      v-for="item in suggestions"
                      :key="item.title"
                      class="suggestion-card"
                      role="button"
                      :aria-label="item.prompt"
                      @click="askSuggestion(item.prompt)"
                      ><view
                        class="suggestion-icon"
                        :style="{
                          color: item.color,
                          background: item.background,
                        }"
                        ><wd-icon :name="item.icon" size="19px" /></view
                      ><text class="suggestion-title">{{ item.title }}</text
                      ><text class="suggestion-description">{{
                        item.description
                      }}</text
                      ><wd-icon
                        name="arrow-right"
                        size="13px"
                        color="#a0ada4"
                        custom-class="suggestion-arrow"
                    /></view>
                  </view>
                  <view class="welcome-footnote"
                    ><text>知识来自每一份资料，也来自每一个人的经验。</text
                    ><text
                      class="inline-link"
                      role="button"
                      @click="navigate('knowledge')"
                      >去补充知识 <text>↗</text></text
                    ></view
                  >
                </view>
                <view v-else class="message-list"
                  ><ChatMessage
                    v-for="message in messages"
                    :key="message.id"
                    :message="message"
                    assistant-name="知行 · 知识助手"
                    @retry="restorePrompt"
                    @view-source="openSource"
                /></view>
                <view id="messages-bottom" class="messages-bottom" />
              </view>
            </scroll-view>
            <view class="composer-region"
              ><view class="composer-width"
                ><ChatComposer
                  ref="composerRef"
                  v-model="draft"
                  :sending="sending"
                  :compact="keyboardHeight > 0"
                  :context-label="retrievalDescription"
                  placeholder="输入你的问题，让团队知识为你解答…"
                  @send="sendMessage"
                  @stop="stopGeneration"
                  @keyboard-height="keyboardHeight = $event"
                /><view v-if="!keyboardHeight" class="composer-caption"
                  ><text>演示回答基于本地示例资料，请结合引用查看</text
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
            ><text class="rail-description"
              >公有知识 + 我的私有，答案附带来源</text
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
            ><view class="rail-divider" /><view class="rail-tip"
              ><wd-icon name="file" size="19px" color="#a3b1a6" /><text
                class="rail-tip-title"
                >答案有出处，经验有归处</text
              ><text class="rail-tip-body"
                >公有资料由所有用户共同维护；私有资料仅自己可见、可操作。</text
              ><text
                class="inline-link"
                role="button"
                @click="navigate('knowledge')"
                >管理知识资料 <text>→</text></text
              ></view
            ></view
          >
        </view>
        <view
          class="panel-slot"
          :style="{ display: active === 'knowledge' ? 'flex' : 'none' }"
          ><KnowledgePanel
            :key="previewVersion"
            :libraries="visibleLibraries"
            :documents="visibleDocuments"
            :current-user="currentUser"
            @add-document="addDocument"
            @remove-document="removeDocument"
            @update-document="updateDocument"
        /></view>
        <view
          class="panel-slot"
          :style="{ display: active === 'erp' ? 'flex' : 'none' }"
          ><ErpPanel
            :key="previewVersion"
            :user-name="currentUser.name"
            @keyboard-height="onKeyboardHeight"
        /></view>
        <view v-if="!isDesktop && !keyboardHeight" class="bottom-nav"
          ><view
            v-for="item in mobileNavigation"
            :key="item.id"
            class="bottom-item"
            :class="{ selected: active === item.id }"
            role="button"
            :aria-label="item.title"
            @click="navigate(item.id)"
            ><wd-icon :name="item.icon" size="21px" /><text>{{
              item.title
            }}</text></view
          ></view
        >
      </view>
      <wd-popup
        v-model="userPickerOpen"
        position="center"
        :z-index="100"
        custom-style="width:calc(100% - 40px);max-width:420px;border-radius:16px;"
      >
        <view class="identity-dialog"
          ><text class="dialog-title">切换演示身份</text
          ><text class="dialog-description"
            >体验公有知识共享、私有知识和个人对话隔离。</text
          ><view
            v-for="user in demoUsers"
            :key="user.id"
            class="identity-option"
            :class="{ selected: currentUser.id === user.id }"
            role="button"
            :aria-label="`切换为${user.name}`"
            @click="switchUser(user.id)"
            ><view class="identity-avatar">{{ user.name.slice(0, 1) }}</view
            ><view class="identity-copy"
              ><text>{{ user.name }}</text
              ><text class="identity-role">{{ user.role }}</text></view
            ><wd-icon
              v-if="currentUser.id === user.id"
              name="check"
              size="17px"
              color="#237b61" /></view
          ><text class="identity-note"
            >当前为本地模拟身份，实际产品使用登录身份校验。</text
          ><wd-button block type="text" @click="userPickerOpen = false"
            >关闭</wd-button
          ></view
        >
      </wd-popup>
      <wd-popup
        v-model="sourceOpen"
        position="center"
        :z-index="80"
        custom-style="width:calc(100% - 36px);max-width:620px;border-radius:16px;"
      >
        <view v-if="sourceDocument" class="source-dialog"
          ><view class="source-dialog-header"
            ><view
              ><text class="dialog-title">{{ sourceDocument.name }}</text
              ><text class="dialog-description">{{
                sourceLibrary?.scope === "public"
                  ? "公有知识 · 所有用户可读可操作"
                  : "我的私有 · 仅自己可读可操作"
              }}</text></view
            ><wd-button
              type="icon"
              icon="close"
              aria-label="关闭引用原文"
              @click="sourceOpen = false" /></view
          ><scroll-view scroll-y class="source-dialog-content"
            ><text selectable>{{
              sourceDocument.content || "演示文件尚未解析内容。"
            }}</text></scroll-view
          ><text class="source-dialog-foot"
            >上传人：{{ sourceDocument.owner }} ·
            {{ sourceDocument.updatedAt }}</text
          ></view
        >
      </wd-popup>
    </view>
  </wd-config-provider>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { onResize } from "@dcloudio/uni-app";
import ChatSidebar from "@/components/ChatSidebar.vue";
import ChatComposer from "@/components/ChatComposer.vue";
import ChatMessage from "@/components/ChatMessage.vue";
import KnowledgePanel from "@/components/KnowledgePanel.vue";
import ErpPanel from "@/components/ErpPanel.vue";
import {
  DEMO_STORAGE_KEY,
  demoLibraries,
  demoUsers,
  accessibleLibraries,
  canOperateDocument,
  initialPreview,
  answerFromDocuments,
} from "@/services/demo";

const seed = initialPreview();
let saved;
try {
  saved = uni.getStorageSync(DEMO_STORAGE_KEY);
} catch {}
const libraries = ref(demoLibraries);
const currentUserId = ref(
  demoUsers.some((user) => user.id === saved?.currentUserId)
    ? saved.currentUserId
    : "lin"
);
const currentUser = computed(() =>
  demoUsers.find((user) => user.id === currentUserId.value)
);
const visibleLibraries = computed(() =>
  accessibleLibraries(libraries.value, currentUserId.value)
);
const visibleDocuments = computed(() =>
  documents.value.filter((doc) =>
    canOperateDocument(doc, libraries.value, currentUserId.value)
  )
);
const validDocuments =
  Array.isArray(saved?.documents) &&
  saved.documents.every(
    (doc) =>
      doc &&
      typeof doc.id === "string" &&
      typeof doc.name === "string" &&
      typeof doc.content === "string" &&
      demoLibraries.some((lib) => lib.id === doc.libraryId)
  );
const validConversations =
  Array.isArray(saved?.conversations) &&
  saved.conversations.every(
    (item) =>
      item &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      demoUsers.some((user) => user.id === item.ownerId) &&
      Array.isArray(item.messages)
  );
const documents = ref(validDocuments ? saved.documents : seed.documents);
const conversations = ref(
  validConversations ? saved.conversations : seed.conversations
);
const active = ref("chat");
const userPickerOpen = ref(false);
const sourceOpen = ref(false);
const sourceDocumentId = ref("");
const sourceDocument = computed(() =>
  visibleDocuments.value.find((doc) => doc.id === sourceDocumentId.value)
);
const sourceLibrary = computed(() =>
  visibleLibraries.value.find(
    (lib) => lib.id === sourceDocument.value?.libraryId
  )
);
const retrievalScope = ref("all");
const scopeOptions = [
  { id: "all", label: "全部可访问" },
  { id: "public", label: "仅公有" },
  { id: "private", label: "仅我的私有" },
];
const scopedLibraries = computed(() =>
  accessibleLibraries(
    libraries.value,
    currentUserId.value,
    retrievalScope.value
  )
);
const scopedDocuments = computed(() =>
  visibleDocuments.value.filter((doc) =>
    scopedLibraries.value.some((lib) => lib.id === doc.libraryId)
  )
);
const retrievalDescription = computed(
  () =>
    ({
      all: "公有知识 + 我的私有",
      public: "仅检索公有知识",
      private: "仅检索我的私有知识",
    })[retrievalScope.value]
);
const previewVersion = ref(0);
const selectedConversation = ref("");
const draft = ref("");
const sending = ref(false);
const sidebarOpen = ref(false);
const composerRef = ref(null);
const scrollTarget = ref("");
const keyboardHeight = ref(0);
const viewportHeight = ref(0);
const viewportTop = ref(0);
const isDesktop = ref(false);
const statusBarHeight = ref(0);
const drawerTop = ref(0);
const capsuleWidth = ref(0);
const nativeBaseHeight = ref(0);
let timer;
let generation;
let disposed = false;
const sections = {
  chat: { title: "问答检索", description: "连接知识，找到答案" },
  knowledge: {
    title: "知识资料",
    description: "共建公有知识，管理我的私有资料",
  },
  erp: { title: "ERP 助手", description: "用自然语言，办理业务" },
};
const mobileNavigation = [
  { id: "chat", title: "问答", icon: "chat" },
  { id: "knowledge", title: "知识", icon: "books" },
  { id: "erp", title: "ERP", icon: "layers" },
];
const suggestions = [
  {
    title: "读懂产品",
    description: "智能网关如何安装与验收？",
    prompt: "智能网关如何安装与验收？",
    icon: "goods",
    color: "#447b66",
    background: "#eef5f0",
  },
  {
    title: "理清流程",
    description: "采购申请需要经过哪些步骤？",
    prompt: "采购申请需要经过哪些步骤？",
    icon: "layers",
    color: "#6683ae",
    background: "#eef2f8",
  },
  {
    title: "查找制度",
    description: "出差报销需要准备哪些材料？",
    prompt: "出差报销需要准备哪些材料？",
    icon: "file",
    color: "#b29160",
    background: "#f9f4eb",
  },
  {
    title: "解决问题",
    description: "客户退换货应该如何处理？",
    prompt: "客户退换货应该如何处理？",
    icon: "chat",
    color: "#9b83a9",
    background: "#f5f0f8",
  },
];
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
const currentSection = computed(() => sections[active.value]);
const currentConversation = computed(() =>
  conversations.value.find(
    (item) =>
      item.id === selectedConversation.value &&
      item.ownerId === currentUserId.value
  )
);
const messages = computed(() => currentConversation.value?.messages || []);
const sidebarProps = computed(() => ({
  active: active.value,
  documentCount: visibleDocuments.value.length,
  conversations: conversations.value.filter(
    (item) => item.ownerId === currentUserId.value
  ),
  selectedConversation: selectedConversation.value,
  currentUser: currentUser.value,
}));
const shellStyle = computed(() => {
  let height = viewportHeight.value;
  // #ifndef H5
  if (keyboardHeight.value > 0)
    height = Math.min(
      height,
      Math.max(180, nativeBaseHeight.value - keyboardHeight.value)
    );
  // #endif
  return {
    height: height ? `${height}px` : "100dvh",
    top: `${viewportTop.value}px`,
  };
});
const headerStyle = computed(() => ({
  paddingTop: `${statusBarHeight.value}px`,
  paddingRight: capsuleWidth.value ? `${capsuleWidth.value}px` : undefined,
  minHeight: `${64 + statusBarHeight.value}px`,
}));
function persist() {
  try {
    uni.setStorageSync(DEMO_STORAGE_KEY, {
      documents: documents.value,
      currentUserId: currentUserId.value,
      conversations: conversations.value.map((item) => ({
        ...item,
        messages: item.messages.map((message) => ({
          ...message,
          pending: false,
        })),
      })),
    });
  } catch {
    uni.showToast({
      title: "本地空间不足，刷新后可能丢失本次记录",
      icon: "none",
    });
  }
}
function navigate(section) {
  if (!sections[section]) return;
  composerRef.value?.blur();
  uni.hideKeyboard();
  keyboardHeight.value = 0;
  active.value = section;
  sidebarOpen.value = false;
}
function newConversation() {
  stopGeneration();
  selectedConversation.value = "";
  draft.value = "";
  navigate("chat");
}
function openConversation(id) {
  if (
    !conversations.value.some(
      (item) => item.id === id && item.ownerId === currentUserId.value
    )
  )
    return;
  stopGeneration();
  selectedConversation.value = id;
  draft.value = "";
  navigate("chat");
  scrollToBottom();
}
async function scrollToBottom() {
  scrollTarget.value = "";
  await nextTick();
  if (!disposed) scrollTarget.value = "messages-bottom";
}
function askSuggestion(question) {
  if (sending.value) return;
  draft.value = question;
  sendMessage(question);
}
function sendMessage(value) {
  const question = (typeof value === "string" ? value : draft.value).trim();
  if (!question || sending.value) return;
  let conversation = currentConversation.value;
  if (!conversation) {
    conversation = {
      id: `chat-${Date.now()}`,
      ownerId: currentUserId.value,
      title: question.slice(0, 24),
      updatedAt: "刚刚",
      messages: [],
    };
    conversations.value.unshift(conversation);
    selectedConversation.value = conversation.id;
    conversation = currentConversation.value;
  }
  conversation.updatedAt = "刚刚";
  conversation.messages.push({
    id: `q-${Date.now()}`,
    role: "user",
    content: question,
  });
  const answerId = `a-${Date.now()}`;
  conversation.messages.push({
    id: answerId,
    role: "assistant",
    content: "",
    pending: true,
    sources: [],
    knowledgeScope: retrievalDescription.value,
  });
  const answer = conversation.messages.find(
    (message) => message.id === answerId
  );
  const result = answerFromDocuments(
    question,
    documents.value.filter((doc) => doc.content),
    libraries.value,
    currentUserId.value,
    retrievalScope.value
  );
  generation = { answer, result, index: 0 };
  sending.value = true;
  draft.value = "";
  composerRef.value?.clear();
  scrollToBottom();
  timer = setInterval(() => {
    if (!generation) return;
    generation.index += 24;
    generation.answer.content = generation.result.content.slice(
      0,
      generation.index
    );
    scrollToBottom();
    if (generation.index >= generation.result.content.length) {
      generation.answer.sources = generation.result.sources;
      generation.answer.pending = false;
      generation = null;
      clearInterval(timer);
      sending.value = false;
      persist();
    }
  }, 28);
}
function stopGeneration() {
  clearInterval(timer);
  if (generation) {
    generation.answer.pending = false;
    generation.answer.interrupted = true;
    generation = null;
    sending.value = false;
    persist();
  }
}
function restorePrompt(message) {
  const index = messages.value.indexOf(message);
  draft.value = messages.value[index - 1]?.content || "";
  composerRef.value?.focus();
}
function addDocument(doc) {
  if (!canOperateDocument(doc, libraries.value, currentUserId.value))
    return permissionDenied();
  if (documents.value.some((item) => item.id === doc.id)) return;
  documents.value.unshift({
    ...doc,
    owner: currentUser.value.name,
    uploadedBy: currentUserId.value,
  });
  persist();
}
function removeDocument(id) {
  const doc = documents.value.find((item) => item.id === id);
  if (!doc || !canOperateDocument(doc, libraries.value, currentUserId.value))
    return permissionDenied();
  documents.value = documents.value.filter((doc) => doc.id !== id);
  persist();
}
function updateDocument(value) {
  const index = documents.value.findIndex((doc) => doc.id === value.id);
  const original = documents.value[index];
  if (
    !original ||
    !canOperateDocument(original, libraries.value, currentUserId.value)
  )
    return permissionDenied();
  const name = String(value.name || "").trim();
  const content =
    original.type === "text"
      ? String(value.content || "").trim()
      : original.content;
  if (!name || (original.type === "text" && !content)) return;
  const updated = {
    ...original,
    name,
    content,
    size: original.type === "text" ? `${content.length} 字` : original.size,
    updatedAt: "刚刚",
    updatedBy: currentUserId.value,
    updatedByName: currentUser.value.name,
  };
  // Keyword fixtures describe the original text; edited knowledge must match its current content.
  if (original.type === "text") delete updated.keywords;
  documents.value.splice(index, 1, updated);
  persist();
}
function permissionDenied() {
  uni.showToast({ title: "当前身份无权访问这份资料", icon: "none" });
}
function openSource(source) {
  const doc = documents.value.find((item) => item.id === source.documentId);
  if (!doc || !canOperateDocument(doc, libraries.value, currentUserId.value))
    return uni.showToast({ title: "来源已删除或当前不可访问", icon: "none" });
  sourceDocumentId.value = doc.id;
  sourceOpen.value = true;
}
function setRetrievalScope(scope) {
  if (!scopeOptions.some((item) => item.id === scope)) return;
  retrievalScope.value = scope;
}
function switchUser(id) {
  if (!demoUsers.some((user) => user.id === id)) return;
  if (id !== currentUserId.value) {
    stopGeneration();
    sourceOpen.value = false;
    selectedConversation.value = "";
    draft.value = "";
    composerRef.value?.clear();
    currentUserId.value = id;
    retrievalScope.value = "all";
    previewVersion.value += 1;
    navigate(active.value);
    persist();
  }
  userPickerOpen.value = false;
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
onMounted(() => {
  syncLayout();
  // #ifdef MP-WEIXIN
  uni.onKeyboardHeightChange(nativeKeyboardChange);
  // #endif
  // #ifdef H5
  window.visualViewport?.addEventListener("resize", syncLayout);
  window.visualViewport?.addEventListener("scroll", syncLayout);
  // #endif
});
onBeforeUnmount(() => {
  disposed = true;
  stopGeneration();
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
.demo-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  padding: 5px 9px;
  border: 1px solid #e6ebe6;
  background: #fafcf9;
  border-radius: 5px;
  color: #839785;
  white-space: nowrap;
}
.badge-dot {
  width: 4px;
  height: 4px;
  background: #9ab38d;
  border-radius: 50%;
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
.welcome-eyebrow {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 10px;
  letter-spacing: 2px;
  color: #86a28f;
  margin-bottom: 25px;
}
.eyebrow-line {
  width: 21px;
  height: 2px;
  background: #9fbba9;
}
.welcome-heading {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.welcome-greeting {
  font-size: 30px;
  line-height: 44px;
  font-weight: 500;
  color: #2c4939;
  letter-spacing: -1px;
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
.scope-label {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #7f9987;
  font-size: 10px;
  line-height: 20px;
  margin-top: 14px;
}
.suggestion-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 32px;
}
.suggestion-card {
  position: relative;
  border: 1px solid #e5ebe6;
  border-radius: 12px;
  padding: 18px 19px;
  background: #fff;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
  box-sizing: border-box;
  min-width: 0;
}
.suggestion-card:hover {
  background: #fafcf9;
  border-color: #bdd2c3;
}
.suggestion-icon {
  width: 33px;
  height: 33px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  margin-bottom: 11px;
}
.suggestion-title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  line-height: 22px;
  color: #405348;
}
.suggestion-description {
  display: block;
  font-size: 11px;
  line-height: 20px;
  color: #98a39c;
  margin-top: 3px;
}
.suggestion-arrow {
  position: absolute;
  right: 17px;
  top: 29px;
}
.welcome-footnote {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
  font-size: 10px;
  line-height: 20px;
  color: #a7b1a9;
  margin-top: 21px;
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
.rail-divider {
  height: 1px;
  background: #e6ece5;
  margin: 19px 0 26px;
}
.rail-tip {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 13px;
}
.rail-tip-title {
  font-size: 11px;
  color: #839989;
  line-height: 20px;
}
.rail-tip-body {
  font-size: 10px;
  color: #a4afa6;
  line-height: 21px;
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
  .welcome-greeting {
    font-size: 35px;
    line-height: 48px;
  }
  .suggestion-card {
    padding: 20px 22px;
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
  .welcome-eyebrow {
    margin-bottom: 20px;
  }
  .welcome-greeting {
    font-size: 26px;
    line-height: 37px;
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
  .suggestion-grid {
    margin-top: 25px;
    gap: 10px;
  }
  .suggestion-card {
    padding: 13px 14px;
  }
  .suggestion-icon {
    width: 29px;
    height: 29px;
    margin-bottom: 8px;
  }
  .suggestion-title {
    font-size: 12px;
  }
  .suggestion-description {
    font-size: 10px;
    line-height: 18px;
  }
  .welcome-footnote {
    font-size: 9px;
    margin-top: 16px;
    gap: 7px;
  }
  .welcome-footnote > text:first-child {
    max-width: 220px;
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
  .scope-label {
    font-size: 9px;
  }
  .demo-badge {
    font-size: 9px;
    padding: 4px 6px;
  }
  .conversation-title text {
    max-width: 180px;
  }
}
@media (max-width: 380px) {
  .suggestion-description {
    font-size: 9px;
  }
  .conversation-content {
    padding-left: 20px;
    padding-right: 20px;
  }
  .welcome-footnote > text:first-child {
    display: none;
  }
  .welcome-footnote {
    justify-content: flex-end;
  }
  .welcome-title {
    font-size: 25px;
  }
  .scope-label {
    font-size: 8px;
  }
}
@media (max-height: 760px) {
  .welcome-eyebrow {
    margin-bottom: 13px;
  }
  .welcome-greeting {
    font-size: 25px;
    line-height: 34px;
  }
  .welcome-title {
    font-size: 28px;
    line-height: 38px;
  }
  .welcome-description {
    margin-top: 10px;
  }
  .suggestion-grid {
    margin-top: 20px;
  }
  .suggestion-card {
    padding: 12px 15px;
  }
  .suggestion-icon {
    width: 27px;
    height: 27px;
    margin-bottom: 5px;
  }
  .welcome-footnote {
    margin-top: 12px;
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
.demo-badge {
  cursor: pointer;
}
.identity-dialog {
  padding: 26px 25px 12px;
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
.identity-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 12px;
  margin-top: 12px;
  border: 1px solid #e6ece7;
  border-radius: 10px;
  cursor: pointer;
}
.identity-option.selected {
  border-color: #9dbba9;
  background: #f2f8f4;
}
.identity-avatar {
  width: 33px;
  height: 33px;
  border-radius: 50%;
  background: #e9efe8;
  color: #6b8873;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.identity-copy {
  flex: 1;
  font-size: 13px;
  color: #405b49;
}
.identity-role {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  color: #99a49a;
}
.identity-note {
  display: block;
  margin: 17px 0 5px;
  color: #a0aa9f;
  font-size: 10px;
  line-height: 19px;
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
  .identity-dialog {
    padding: 23px 20px 10px;
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
