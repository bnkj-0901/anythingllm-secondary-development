<template>
  <view class="sidebar">
    <view class="brand-row">
      <view class="brand"
        ><view class="brand-mark"
          ><wd-icon name="layers" size="22px" color="#fff" /></view
        ><view
          ><text class="brand-name">知行</text
          ><text class="brand-caption">企业 AI 助手</text></view
        ></view
      >
      <wd-button
        v-if="mobile"
        type="icon"
        icon="close"
        aria-label="关闭导航"
        @click="$emit('close')"
      />
    </view>
    <view class="sidebar-main">
      <text class="section-label">我的工作台</text>
      <view
        v-for="item in navigation"
        :key="item.id"
        class="nav-item"
        :class="{ active: active === item.id }"
        role="button"
        :aria-label="item.name"
        @click="$emit('navigate', item.id)"
      >
        <wd-icon :name="item.icon" size="20px" /><text>{{ item.name }}</text
        ><text v-if="item.id === 'knowledge'" class="nav-count">{{
          documentCount
        }}</text
        ><view v-else-if="active === item.id" class="active-dot" />
      </view>
      <view class="history-title"
        ><text class="section-label">最近对话</text
        ><wd-button
          type="icon"
          icon="add"
          aria-label="新建对话"
          custom-style="width:28px;height:28px;color:#89958e;"
          @click="$emit('new-conversation')"
      /></view>
      <scroll-view scroll-y class="history-scroll">
        <view
          v-for="conversation in conversations"
          :key="conversation.id"
          class="history-item"
          :class="{
            selected:
              active === 'chat' && conversation.id === selectedConversation,
          }"
          role="button"
          @click="$emit('select-conversation', conversation.id)"
          ><wd-icon name="chat" size="15px" /><text>{{
            conversation.title
          }}</text></view
        >
        <text v-if="!conversations.length" class="history-empty"
          >暂无对话</text
        >
      </scroll-view>
    </view>
    <view class="sidebar-bottom">
      <view
        class="profile"
        role="button"
        aria-label="设置"
        @click="$emit('settings')"
        ><image v-if="currentUser.avatar" class="avatar" :src="currentUser.avatar" mode="aspectFill" /><view v-else class="avatar">{{ currentUser.name.slice(0, 1) }}</view
        ><view class="profile-copy"
          ><text class="profile-name">{{ currentUser.name }}</text
          ><text class="profile-role">{{ currentUser.role }}</text></view
        ><wd-icon name="setting" size="18px" color="#929e95" /></view
      >
    </view>
  </view>
</template>

<script setup>
defineOptions({ options: { virtualHost: true, styleIsolation: "shared" } });
defineProps({
  active: String,
  documentCount: Number,
  conversations: { type: Array, default: () => [] },
  selectedConversation: String,
  mobile: Boolean,
  currentUser: {
    type: Object,
    default: () => ({ id: "", name: "用户", role: "成员" }),
  },
});
defineEmits([
  "navigate",
  "select-conversation",
  "new-conversation",
  "close",
  "settings",
]);
const navigation = [
  { id: "chat", name: "问答检索", icon: "chat" },
  { id: "knowledge", name: "知识资料", icon: "books" },
];
</script>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: #f7f9f8;
  color: #64726b;
  padding: 0 16px;
}
.brand-row {
  height: 94px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
}
.brand {
  display: flex;
  gap: 11px;
  align-items: center;
}
.brand-mark {
  height: 40px;
  width: 40px;
  border-radius: 12px;
  background: #237b61;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 9px #237b6115;
}
.brand-name {
  display: block;
  font-size: 23px;
  letter-spacing: 3px;
  font-weight: 700;
  color: #203d31;
  line-height: 28px;
}
.brand-caption {
  display: block;
  font-size: 10px;
  color: #8b9890;
  letter-spacing: 1px;
  line-height: 18px;
}
.sidebar-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.section-label {
  font-size: 11px;
  color: #97a299;
  letter-spacing: 1px;
  padding: 0 12px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 14px;
  border-radius: 9px;
  margin-top: 7px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s;
}
.nav-item.active {
  background: #e6f0ea;
  color: #237b61;
  font-weight: 600;
}
.nav-item:hover,
.history-item:hover {
  background: #edf2ee;
}
.nav-count {
  font-size: 11px;
  padding: 1px 6px;
  background: #e9edea;
  border-radius: 5px;
  color: #7e8e83;
  margin-left: auto;
}
.active-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #237b61;
  margin-left: auto;
}
.history-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 35px;
  margin-bottom: 5px;
  padding-right: 8px;
}
.history-scroll {
  flex: 1;
  height: 0;
  min-height: 0;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 12px;
  font-size: 12px;
  border-radius: 8px;
  margin: 2px 0;
  cursor: pointer;
}
.history-item text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  line-height: 20px;
}
.history-item.selected {
  color: #237b61;
  background: #edf3ef;
}
.history-empty {
  display: block;
  color: #a3aca6;
  font-size: 11px;
  line-height: 20px;
  padding: 10px 12px;
}
.sidebar-bottom {
  flex-shrink: 0;
}
.profile {
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px solid #e5eae6;
  padding: 18px 6px;
  padding-bottom: calc(18px + env(safe-area-inset-bottom));
}
.avatar {
  flex-shrink: 0;
  width: 33px;
  height: 33px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #e9dfd0;
  color: #927653;
  font-size: 13px;
}
.profile-copy {
  flex: 1;
  min-width: 0;
}
.profile-name {
  display: block;
  font-size: 12px;
  color: #3e5146;
  line-height: 19px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.profile-role {
  display: block;
  font-size: 10px;
  color: #9aa49d;
  line-height: 16px;
}
@media (max-height: 650px) {
  .brand-row {
    height: 78px;
  }
  .history-title {
    margin-top: 18px;
  }
}
</style>
