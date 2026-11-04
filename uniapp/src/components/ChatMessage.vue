<template>
  <view
    class="chat-message"
    :class="isUser ? 'chat-message--user' : 'chat-message--assistant'"
  >
    <view v-if="!isUser && message.knowledgeScope" class="message-identity">
      <text class="message-scope">{{ message.knowledgeScope }}</text>
    </view>

    <view v-if="isUser" class="user-bubble">
      <text class="user-content" selectable>{{ message.content }}</text>
    </view>
    <view v-else class="assistant-body">
      <view v-if="answer.hasReasoning" class="reasoning-panel">
        <button
          class="reasoning-heading"
          hover-class="reasoning-heading--hover"
          :aria-expanded="expandedReasoning"
          :aria-label="reasoningLabel"
          @click="expandedReasoning = !expandedReasoning"
        >
          <image class="reasoning-icon" src="/static/icons/brain.svg" />
          <text
            class="reasoning-label"
            :class="{ 'reasoning-label--thinking': answer.thinking }"
            >{{ reasoningLabel }}</text
          >
          <image
            class="reasoning-caret"
            :class="{ 'reasoning-caret--expanded': expandedReasoning }"
            src="/static/icons/caret-right.svg"
          />
        </button>
        <wd-transition
          :show="expandedReasoning"
          :duration="150"
          lazy-render
          name="fade"
          enter-class="chat-thought-enter"
          leave-to-class="chat-thought-leave-to"
          custom-style="transition-property: opacity, transform; transition-timing-function: ease-out;"
        >
          <view class="reasoning-content">
            <view class="reasoning-step-icon">
              <image src="/static/icons/brain.svg" />
            </view>
            <view class="reasoning-text">
              <MessageBlocks
                :blocks="reasoningBlocks"
                :copied="copied"
                copy-prefix="reasoning-code"
                @copy="copyText"
              />
            </view>
          </view>
        </wd-transition>
      </view>
      <MessageBlocks :blocks="blocks" :copied="copied" @copy="copyText" />

      <view
        v-if="message.pending && !answer.content && !answer.hasReasoning"
        class="thinking-state"
      >
        <wd-loading size="16" color="#287b5f" />
        <text>正在思考</text>
      </view>
      <view
        v-else-if="message.pending && !answer.thinking"
        class="generation-state"
      >
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
        <button
          class="sources-toggle"
          hover-class="sources-toggle--hover"
          :aria-expanded="expandedSources"
          :aria-label="`${expandedSources ? '收起' : '展开'} ${sources.length} 个参考来源`"
          @click="expandedSources = !expandedSources"
        >
          <wd-icon name="books" size="16" color="#667085" />
          <text class="sources-label">参考来源</text>
          <text class="sources-count">{{ sources.length }}</text>
          <image
            class="sources-caret"
            :class="{ 'sources-caret--expanded': expandedSources }"
            src="/static/icons/caret-right.svg"
          />
        </button>
        <view v-if="expandedSources" class="sources-list">
          <wd-collapse v-model="expandedSource" accordion>
            <wd-collapse-item
              v-for="(source, sourceIndex) in sources"
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
        </view>
      </view>

      <view
        v-if="!message.pending && (answer.content || message.error)"
        class="message-actions"
      >
        <wd-button
          v-if="answer.content"
          type="text"
          size="small"
          :icon="copied === 'message' ? 'check' : 'file-copy'"
          custom-style="height: 34px; padding: 0 2px; color: #667085; font-size: 12px; --wot-button-icon-fs: 15px;"
          @click="copyText(answer.content, 'message')"
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
import MessageBlocks from "@/components/MessageBlocks.vue";
import { normalizeSources, parseMessageContent } from "@/utils/messageContent";
import { splitMessageReasoning } from "@/utils/reasoning.mjs";

defineOptions({
  options: { virtualHost: true, styleIsolation: "shared" },
});

const props = defineProps({
  message: { type: Object, required: true },
});
defineEmits(["retry", "view-source"]);

const copied = ref("");
const expandedSource = ref("");
const expandedSources = ref(false);
const expandedReasoning = ref(false);
let copiedTimer;
const isUser = computed(() => props.message.role === "user");
const answer = computed(() => splitMessageReasoning(props.message));
const blocks = computed(() => parseMessageContent(answer.value.content));
const reasoningBlocks = computed(() =>
  parseMessageContent(answer.value.reasoning, { thought: true })
);
const reasoningLabel = computed(() =>
  answer.value.thinking
    ? "正在思考…"
    : props.message.interrupted
      ? "思考已停止"
      : props.message.error
        ? "思考已中断"
        : "想法、思绪"
);
const sources = computed(() => normalizeSources(props.message.sources));
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
.assistant-body {
  color: #344054;
  font-size: 15px;
  line-height: 1.8;
  word-break: break-word;
  min-width: 0;
}
.reasoning-panel {
  max-width: 65ch;
  margin: 8px 0 4px;
}
.reasoning-heading {
  display: flex;
  align-items: center;
  width: 100%;
  margin: 0;
  padding: 0;
  gap: 8px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #71717a;
  font-size: 16px;
  font-weight: 400;
  line-height: 24px;
  text-align: left;
  transition: color 150ms;
}
.reasoning-heading::after {
  border: 0;
}
.reasoning-heading--hover {
  color: #09090b;
}
.reasoning-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
.reasoning-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reasoning-label--thinking {
  color: transparent;
  background: linear-gradient(90deg, #a1a1aa, #18181b, #a1a1aa);
  background-size: 200% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  animation: reasoning-shimmer 3s linear infinite;
}
.reasoning-caret {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  transition: transform 150ms;
}
.reasoning-caret--expanded {
  transform: rotate(90deg);
}
.reasoning-content {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 16px;
  margin-bottom: 12px;
  color: #71717a;
  font-size: 14px;
  line-height: 20px;
}
.reasoning-step-icon {
  display: flex;
  align-items: center;
  width: 16px;
  height: 20px;
  flex-shrink: 0;
}
.reasoning-step-icon image {
  width: 16px;
  height: 16px;
}
.reasoning-text {
  flex: 1;
  min-width: 0;
}
@keyframes reasoning-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .reasoning-label--thinking {
    animation: none;
    background: none;
    color: #71717a;
  }
  .reasoning-caret,
  .sources-caret {
    transition: none;
  }
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
.sources-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  min-height: 44px;
  box-sizing: border-box;
  margin: 0;
  padding: 6px 12px;
  border: 1px solid #eaecf0;
  border-radius: 999px;
  background: #f9fafb;
  color: #475467;
  font-size: 12px;
  font-weight: 500;
  line-height: 22px;
  text-align: left;
}
.sources-toggle::after {
  border: 0;
}
.sources-toggle--hover {
  background: #f2f4f7;
}
.sources-label {
  white-space: nowrap;
}
.sources-count {
  color: #667085;
  font-size: 12px;
  font-weight: 400;
}
.sources-caret {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  margin-left: 1px;
  transition: transform 150ms;
}
.sources-caret--expanded {
  transform: rotate(90deg);
}
.sources-list {
  margin-top: 10px;
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
<style>
/* Wot's transition owns the native region; match the admin's short slide. */
.chat-thought-enter,
.chat-thought-leave-to {
  transform: translateY(-8px);
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
