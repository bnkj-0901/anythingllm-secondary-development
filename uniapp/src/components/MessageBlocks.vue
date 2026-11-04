<template>
  <view class="message-blocks">
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
            :icon="
              copied === `${copyPrefix}-${blockIndex}` ? 'check' : 'file-copy'
            "
            custom-style="height: 34px; padding: 0 2px; color: #cbd5e1; font-size: 12px; --wot-button-icon-fs: 14px;"
            @click="$emit('copy', block.content, `${copyPrefix}-${blockIndex}`)"
          >
            {{
              copied === `${copyPrefix}-${blockIndex}` ? "已复制" : "复制代码"
            }}
          </wd-button>
        </view>
        <scroll-view scroll-x class="code-scroll">
          <text class="code-content" selectable>{{
            block.content || " "
          }}</text>
        </scroll-view>
      </view>
      <scroll-view
        v-else-if="block.type === 'table'"
        scroll-x
        class="table-scroll"
      >
        <view
          class="markdown-table"
          :style="{ minWidth: `${block.headers.length * 132}px` }"
        >
          <view class="table-row table-row--header">
            <view
              v-for="(cell, cellIndex) in block.headers"
              :key="cellIndex"
              class="table-cell"
              :style="{ textAlign: block.alignments[cellIndex] }"
            >
              <rich-text class="message-rich-text" :nodes="cell" user-select />
            </view>
          </view>
          <view
            v-for="(row, rowIndex) in block.rows"
            :key="rowIndex"
            class="table-row"
          >
            <view
              v-for="(cell, cellIndex) in row"
              :key="cellIndex"
              class="table-cell"
              :style="{ textAlign: block.alignments[cellIndex] }"
            >
              <rich-text class="message-rich-text" :nodes="cell" user-select />
            </view>
          </view>
        </view>
      </scroll-view>
      <view v-else-if="block.type === 'list'" class="markdown-list">
        <view
          v-for="(item, itemIndex) in block.items"
          :key="itemIndex"
          class="markdown-list-item"
        >
          <text class="list-marker">{{ item.marker }}</text>
          <view class="list-content">
            <MessageBlocks
              v-if="item.blocks"
              :blocks="item.blocks"
              :copied="copied"
              :copy-prefix="`${copyPrefix}-${blockIndex}-${itemIndex}`"
              @copy="(content, key) => $emit('copy', content, key)"
            />
            <rich-text
              v-else
              class="inline-rich-text"
              :nodes="item.nodes"
              user-select
            />
          </view>
        </view>
      </view>
      <MessageBlocks
        v-else-if="block.type === 'quote' && block.blocks"
        :blocks="block.blocks"
        :copied="copied"
        :copy-prefix="`${copyPrefix}-${blockIndex}`"
        @copy="(content, key) => $emit('copy', content, key)"
      />
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
  </view>
</template>

<script setup>
import MessageBlocks from "./MessageBlocks.vue";

defineOptions({
  name: "MessageBlocks",
  options: { virtualHost: true, styleIsolation: "shared" },
});

defineProps({
  blocks: { type: Array, default: () => [] },
  copied: { type: String, default: "" },
  copyPrefix: { type: String, default: "code" },
});
defineEmits(["copy"]);
</script>

<style scoped>
.message-blocks {
  width: 100%;
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
.inline-rich-text,
.list-content {
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
.code-scroll,
.table-scroll {
  width: 100%;
  min-width: 0;
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
.markdown-table {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #dfe5e1;
  border-radius: 7px;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.7;
}
.table-row {
  display: flex;
  align-items: stretch;
}
.table-row + .table-row {
  border-top: 1px solid #e4e9e6;
}
.table-row--header {
  background: #f2f6f4;
  color: #253b31;
  font-weight: 600;
}
.table-cell {
  flex: 1;
  width: 0;
  min-width: 0;
  box-sizing: border-box;
  padding: 9px 12px;
  word-break: break-word;
  white-space: normal;
}
.table-cell + .table-cell {
  border-left: 1px solid #e4e9e6;
}
</style>
