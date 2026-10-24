<template>
  <view
    class="chat-message"
    :class="isUser ? 'chat-message--user' : 'chat-message--assistant'"
  >
    <view v-if="!isUser" class="message-identity">
      <view class="assistant-mark">
        <wd-icon name="chat" size="15" color="#ffffff" />
      </view>
      <text class="assistant-name">{{ assistantName }}</text>
      <text v-if="message.knowledgeScope" class="message-scope">{{
        message.knowledgeScope
      }}</text>
    </view>

    <view v-if="isUser" class="user-bubble">
      <text class="user-content" selectable>{{ message.content }}</text>
    </view>
    <view v-else class="assistant-body">
      <view
        v-for="(block, blockIndex) in blocks"
        :key="blockIndex"
        class="content-block"
        :class="`content-block--${block.type}`"
      >
        <view v-if="block.type === 'code'" class="code-block">
          <view class="code-toolbar">
            <text class="code-language">{{ block.language }}</text>
            <wd-button
              type="text"
              size="small"
              :icon="copied === `code-${blockIndex}` ? 'check' : 'file-copy'"
              custom-style="height: 34px; padding: 0 2px; color: #cbd5e1; font-size: 12px; --wot-button-icon-fs: 14px;"
              @click="copyText(block.content, `code-${blockIndex}`)"
            >
              {{ copied === `code-${blockIndex}` ? "已复制" : "复制代码" }}
            </wd-button>
          </view>
          <scroll-view scroll-x class="code-scroll">
            <text class="code-content" selectable>{{
              block.content || " "
            }}</text>
          </scroll-view>
        </view>
        <view v-else-if="block.type === 'list'" class="markdown-list">
          <view
            v-for="(item, itemIndex) in block.items"
            :key="itemIndex"
            class="markdown-list-item"
          >
            <text class="list-marker">{{ item.marker }}</text>
            <rich-text
              class="inline-rich-text"
              :nodes="item.nodes"
              user-select
            />
          </view>
        </view>
        <view v-else-if="block.type === 'rule'" class="markdown-rule" />
        <rich-text
          v-else
          class="message-rich-text"
          :class="
            block.type === 'heading'
              ? `markdown-heading markdown-heading--${block.level}`
              : ''
          "
          :nodes="block.nodes"
          user-select
        />
      </view>

      <view v-if="message.pending && !message.content" class="thinking-state">
        <wd-loading size="16" color="#287b5f" />
        <text>正在思考</text>
      </view>
      <view v-else-if="message.pending" class="generation-state">
        <wd-loading size="13" color="#287b5f" />
        <text>正在生成</text>
      </view>

      <view v-if="message.error" class="message-error">
        <wd-icon name="error-circle" size="17" color="#b5473f" />
        <text class="error-text">{{ errorText }}</text>
      </view>
      <text
        v-else-if="message.interrupted && !message.pending"
        class="interrupted-state"
        >已停止生成</text
      >

      <view v-if="sources.length && !message.pending" class="message-sources">
        <view class="sources-heading"
          ><text class="sources-label">参考来源</text
          ><text class="sources-count">{{ sources.length }}</text></view
        >
        <wd-collapse v-model="expandedSource" accordion>
          <wd-collapse-item
            v-for="(source, sourceIndex) in visibleSources"
            :key="source.id"
            :name="source.id"
            custom-style="--wot-collapse-header-padding: 11px 0; --wot-collapse-body-padding: 0 0 12px;"
            custom-body-style="font-size: 13px; line-height: 1.7; color: #667085;"
          >
            <template #title="{ expanded }">
              <view class="source-heading">
                <text class="source-number">{{
                  source.citationNumber || sourceIndex + 1
                }}</text>
                <text class="source-title">{{ source.title }}</text>
                <wd-icon
                  :name="expanded ? 'arrow-up' : 'arrow-down'"
                  size="14"
                  color="#98a2b3"
                />
              </view>
            </template>
            <view class="source-summary">
              <text selectable
                >{{ source.summary || "该来源未返回内容摘要。"
                }}{{ source.truncated ? "…" : "" }}</text
              >
              <wd-button
                v-if="source.documentId"
                type="text"
                size="small"
                custom-style="color:#237b61;font-size:12px;padding:0;"
                @click="$emit('view-source', source)"
                >查看当前原文</wd-button
              >
            </view>
          </wd-collapse-item>
        </wd-collapse>
        <wd-button
          v-if="sources.length > 3"
          type="text"
          size="small"
          :icon="showAllSources ? 'arrow-up' : 'arrow-down'"
          custom-style="height: 34px; color: #287b5f; font-size: 12px; --wot-button-icon-fs: 14px;"
          @click="showAllSources = !showAllSources"
        >
          {{
            showAllSources ? "收起来源" : `查看全部 ${sources.length} 个来源`
          }}
        </wd-button>
      </view>

      <view
        v-if="!message.pending && (message.content || message.error)"
        class="message-actions"
      >
        <wd-button
          v-if="message.content"
          type="text"
          size="small"
          :icon="copied === 'message' ? 'check' : 'file-copy'"
          custom-style="height: 34px; padding: 0 2px; color: #667085; font-size: 12px; --wot-button-icon-fs: 15px;"
          @click="copyText(message.content, 'message')"
        >
          {{ copied === "message" ? "已复制" : "复制" }}
        </wd-button>
        <wd-button
          v-if="message.error"
          type="text"
          size="small"
          icon="refresh"
          custom-style="height: 34px; padding: 0 2px; color: #287b5f; font-size: 12px; --wot-button-icon-fs: 15px;"
          @click="$emit('retry', message)"
        >
          重新编辑
        </wd-button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from "vue";
import { normalizeSources, parseMessageContent } from "@/utils/messageContent";

defineOptions({
  options: { virtualHost: true, styleIsolation: "shared" },
});

const props = defineProps({
  message: { type: Object, required: true },
  assistantName: { type: String, default: "知识助手" },
});
defineEmits(["retry", "view-source"]);

const copied = ref("");
const expandedSource = ref("");
const showAllSources = ref(false);
let copiedTimer;
const isUser = computed(() => props.message.role === "user");
const blocks = computed(() => parseMessageContent(props.message.content));
const sources = computed(() => normalizeSources(props.message.sources));
const visibleSources = computed(() =>
  showAllSources.value ? sources.value : sources.value.slice(0, 3)
);
const errorText = computed(() =>
  typeof props.message.error === "string"
    ? props.message.error
    : "回复失败，请重试。"
);

function copyText(text, key) {
  if (!text) return;
  uni.setClipboardData({
    data: String(text),
    showToast: false,
    success() {
      copied.value = key;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copied.value = "";
      }, 2000);
    },
    fail() {
      uni.showToast({ title: "复制失败，请长按选择文字", icon: "none" });
    },
  });
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<style scoped>
.chat-message {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  margin-bottom: 28px;
}
.chat-message--user {
  display: flex;
  justify-content: flex-end;
  padding-left: 36px;
}
.user-bubble {
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 11px 16px;
  border-radius: 16px 16px 4px 16px;
  background: #edf5f1;
  color: #253b31;
}
.user-content {
  font-size: 15px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}
.message-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.assistant-mark {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: 8px;
  background: #287b5f;
}
.assistant-name {
  color: #344054;
  font-size: 13px;
  font-weight: 600;
}
.assistant-body {
  color: #344054;
  font-size: 15px;
  line-height: 1.8;
  word-break: break-word;
  min-width: 0;
}
.content-block {
  margin-bottom: 10px;
}
.content-block:last-child {
  margin-bottom: 0;
}
.message-rich-text,
.inline-rich-text {
  display: block;
  font-size: inherit;
  line-height: inherit;
  overflow-wrap: anywhere;
}
.markdown-heading {
  color: #1d2939;
  font-weight: 650;
  line-height: 1.55;
  padding-top: 4px;
}
.markdown-heading--1 {
  font-size: 20px;
}
.markdown-heading--2 {
  font-size: 17px;
}
.markdown-heading--3,
.markdown-heading--4,
.markdown-heading--5,
.markdown-heading--6 {
  font-size: 15px;
}
.markdown-list-item {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 1px 0;
}
.list-marker {
  flex-shrink: 0;
  min-width: 12px;
  color: #667085;
  text-align: right;
}
.inline-rich-text {
  flex: 1;
  min-width: 0;
}
.content-block--quote {
  padding: 3px 0 3px 12px;
  border-left: 3px solid #c8ddd3;
  color: #667085;
}
.markdown-rule {
  height: 1px;
  background: #eaecf0;
  margin: 15px 0;
}
.code-block {
  border-radius: 10px;
  overflow: hidden;
  background: #1e293b;
}
.code-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid #334155;
}
.code-language {
  color: #cbd5e1;
  font-size: 12px;
  flex: 1;
  min-width: 0;
  margin-right: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.code-scroll {
  width: 100%;
  box-sizing: border-box;
}
.code-content {
  display: block;
  width: max-content;
  min-width: 100%;
  box-sizing: border-box;
  padding: 12px;
  color: #e2e8f0;
  font-family: Consolas, Monaco, monospace;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre;
  word-break: normal;
}
.thinking-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #667085;
  font-size: 13px;
  min-height: 28px;
  padding: 4px 0;
}
.generation-state {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #667085;
  font-size: 12px;
  min-height: 24px;
  margin-top: 6px;
}
.message-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-top: 8px;
  border-radius: 8px;
  background: #fef3f2;
  color: #b5473f;
  font-size: 13px;
  line-height: 1.65;
}
.error-text {
  min-width: 0;
}
.interrupted-state {
  display: block;
  color: #98a2b3;
  font-size: 12px;
  margin-top: 8px;
}
.message-sources {
  margin-top: 18px;
}
.sources-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
}
.sources-label {
  color: #667085;
  font-size: 12px;
}
.sources-count {
  color: #667085;
  background: #f2f4f7;
  font-size: 11px;
  line-height: 18px;
  min-width: 18px;
  text-align: center;
  border-radius: 4px;
}
.source-heading {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  text-align: left;
  line-height: 1.5;
}
.source-number {
  flex-shrink: 0;
  color: #287b5f;
  background: #edf5f1;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  text-align: center;
  line-height: 20px;
  font-size: 11px;
}
.source-title {
  flex: 1;
  min-width: 0;
  color: #475467;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.source-summary {
  padding-left: 28px;
  font-size: 13px;
  color: #667085;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}
.message-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 6px;
}
</style>
<style scoped>
.message-scope {
  font-size: 10px;
  color: #93a295;
  margin-left: 5px;
  line-height: 18px;
}
.message-identity {
  flex-wrap: wrap;
}
</style>
