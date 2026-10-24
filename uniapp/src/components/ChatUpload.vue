<template>
  <view class="chat-upload">
    <scroll-view scroll-y class="upload-panel" :show-scrollbar="false">
      <view
        class="upload-panel__content"
        :class="{ 'is-empty': !files.length }"
      >
        <view v-if="!files.length" class="upload-empty">
          <view class="upload-empty__symbol">
            <wd-icon name="file-add" size="30px" color="#238568" />
          </view>
          <text class="upload-empty__title">选择你的文件</text>
          <text class="upload-empty__description">{{
            libraryId
              ? "每次最多选择 5 个文件，上传后自动解析并加入当前知识库。"
              : "请先选择目标知识库，再上传资料。"
          }}</text>
        </view>

        <view v-else class="upload-files">
          <view class="upload-files__heading">
            <text class="upload-files__title"
              >已选择 {{ files.length }} 个文件</text
            >
            <text class="upload-files__count"
              >{{ files.length }} / {{ maxFiles }}</text
            >
          </view>
          <view v-for="file in files" :key="file.id" class="upload-file">
            <view class="upload-file__symbol">
              <wd-icon name="file" size="22px" color="#238568" />
            </view>
            <view class="upload-file__details">
              <text class="upload-file__name">{{ file.name }}</text>
              <text class="upload-file__size">{{
                formatFileSize(file.size)
              }}</text>
              <text class="upload-file__state" :class="`is-${file.status}`">{{
                fileStatus(file)
              }}</text>
              <view v-if="file.status === 'uploading'" class="upload-progress">
                <view
                  class="upload-progress__fill"
                  :style="{ width: `${file.progress}%` }"
                />
              </view>
              <text v-if="file.error" class="upload-file__error">{{
                file.error
              }}</text>
            </view>
            <view class="upload-file__actions">
              <wd-button
                v-if="file.status === 'error'"
                type="text"
                size="small"
                :disabled="locked"
                @click="uploadFiles(file.id)"
                >重试</wd-button
              >
              <wd-button
                type="icon"
                icon="close"
                :disabled="locked"
                :aria-label="`从列表移除 ${file.name}`"
                custom-style="width:32px;height:32px;min-width:32px;color:#8a9690;"
                @click="removeFile(file.id)"
              />
            </view>
          </view>
          <view v-if="completedCount" class="upload-complete">
            <text class="upload-complete__title"
              >{{ completedNotice }}</text
            >
            <wd-button
              type="text"
              size="small"
              :disabled="locked"
              @click="emit('chat')"
              >切回对话</wd-button
            >
          </view>
          <text class="upload-status">{{ queueNotice }}</text>
        </view>
      </view>
    </scroll-view>

    <view class="upload-action-region">
      <view class="upload-action-region__content">
        <view v-if="libraryName" class="upload-workspace">
          <wd-icon name="folder-open" size="14px" color="#8a9690" />
          <text>{{ libraryName }}</text>
        </view>
        <wd-button
          block
          icon="upload"
          :round="false"
          :plain="files.length > 0"
          :loading="choosing"
          :disabled="locked || !libraryId || files.length >= maxFiles"
          custom-class="upload-select-button"
          custom-style="height:46px;border-radius:12px;font-size:15px;font-weight:600;"
          @click="chooseFiles"
        >
          {{ files.length ? "继续选择文件" : "选择上传文件" }}
        </wd-button>
        <wd-button
          v-if="files.length && (uploading || readyCount)"
          block
          :round="false"
          :loading="uploading"
          :disabled="disabled || choosing || uploading || !libraryId"
          custom-style="height:46px;margin-top:10px;border-radius:12px;font-size:15px;font-weight:600;"
          @click="uploadFiles()"
          >{{ uploadButtonText }}</wd-button
        >
      </view>
    </view>
  </view>
</template>

<script setup>
import { computed, inject, markRaw, onUnmounted, ref, watch } from "vue";
import { uploadKnowledgeFile } from "@/services/knowledgeUpload.mjs";

defineOptions({ options: { virtualHost: true, styleIsolation: "shared" } });

const api = inject("enterprise-api");
const props = defineProps({
  fileTypes: { type: Object, default: null },
  libraryId: { type: String, default: "" },
  libraryName: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["busy-change", "uploaded", "chat"]);

const maxFiles = 5;
const files = ref([]);
const choosing = ref(false);
const uploading = ref(false);
const busy = computed(() => choosing.value || uploading.value);
const locked = computed(() => props.disabled || busy.value);
const completedCount = computed(
  () => files.value.filter((file) => file.status === "success").length
);
const approvalCount = computed(
  () => files.value.filter((file) => file.status === "success" && file.approvalRequired).length
);
const completedNotice = computed(() => {
  const ready = completedCount.value - approvalCount.value;
  const notices = [];
  if (ready) notices.push(`${ready} 个文件已可用于问答`);
  if (approvalCount.value) notices.push(`${approvalCount.value} 个文件等待管理员审批`);
  return notices.join("，");
});
const readyCount = computed(
  () =>
    files.value.filter(
      (file) => file.status === "pending" || file.status === "error"
    ).length
);
const uploadButtonText = computed(() => {
  if (uploading.value) return "正在上传并处理，请稍候";
  const pending = files.value.some((file) => file.status === "pending");
  const failed = files.value.some((file) => file.status === "error");
  if (pending && failed) return `上传并重试（${readyCount.value}）`;
  if (failed) return `重试失败文件（${readyCount.value}）`;
  return `开始上传（${readyCount.value}）`;
});
const queueNotice = computed(() => {
  if (uploading.value)
    return "文件将依次上传。上传完成后仍需解析和索引，请等待“可用于问答”。";
  if (files.value.some((file) => file.status === "error"))
    return "失败文件保留在列表中，可单独重试或批量重试。";
  if (completedCount.value)
    return "从列表移除仅清理本页记录，已上传资料仍保留在知识库。";
  return "文件尚未上传，点击“开始上传”后会自动解析并建立索引。";
});
let nextFileId = 0;
let contextVersion = 0;
let activeRequest = null;
let disposed = false;

watch(busy, (value) => emit("busy-change", value), { flush: "sync" });
watch(() => props.libraryId, resetQueue);
onUnmounted(() => {
  disposed = true;
  resetQueue();
  emit("busy-change", false);
});

function showNotice(title) {
  uni.showToast({ title, icon: "none" });
}

function addFiles(result) {
  const selected = result.tempFiles || [];
  let invalidCount = 0;
  let overflowCount = 0;

  for (const file of selected) {
    const path = file.path || file.tempFilePath || "";
    const name = file.name || path.split(/[\\/]/).pop() || "未命名文件";
    const size = Math.max(0, Number(file.size) || 0);
    const extension = name.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase();
    if (
      !props.fileTypes?.extensions.includes(extension) ||
      !size ||
      size > props.fileTypes.maxFileSizeBytes
    ) {
      invalidCount += 1;
      continue;
    }
    if (files.value.length >= maxFiles) {
      overflowCount += 1;
      continue;
    }
    files.value.push({
      id: ++nextFileId,
      name,
      size,
      path,
      file: markRaw(file.file || file),
      status: "pending",
      progress: 0,
      error: "",
    });
  }

  if (invalidCount) showNotice("部分文件格式或大小不符合服务要求");
  if (overflowCount) showNotice(`最多选择 ${maxFiles} 个文件`);
}

function onChooseError(error) {
  const message = String(error?.errMsg || "");
  if (/cancel/i.test(message)) return;
  showNotice("选择文件失败，请重试");
}

function chooseFiles() {
  if (locked.value || !props.libraryId || !props.fileTypes) return;
  const remaining = maxFiles - files.value.length;
  if (remaining <= 0) {
    showNotice(`最多选择 ${maxFiles} 个文件，请先移除文件`);
    return;
  }

  choosing.value = true;
  const version = contextVersion;
  const libraryId = props.libraryId;
  const isCurrent = () =>
    !disposed && contextVersion === version && props.libraryId === libraryId;
  const options = {
    count: remaining,
    success: (result) => {
      if (isCurrent()) addFiles(result);
    },
    fail: (error) => {
      if (isCurrent()) onChooseError(error);
    },
    complete: () => {
      if (isCurrent()) choosing.value = false;
    },
  };

  try {
    // #ifdef MP-WEIXIN
    uni.chooseMessageFile({
      ...options,
      type: "file",
      extension: props.fileTypes.extensions.map((value) => value.slice(1)),
    });
    // #endif
    // #ifdef H5
    uni.chooseFile({
      ...options,
      type: "all",
      extension: props.fileTypes.extensions,
    });
    // #endif
    // #ifndef MP-WEIXIN || H5
    choosing.value = false;
    showNotice("请在微信小程序或浏览器中选择文件");
    // #endif
  } catch (error) {
    if (!isCurrent()) return;
    choosing.value = false;
    onChooseError(error);
  }
}

function removeFile(id) {
  if (locked.value) return;
  files.value = files.value.filter((file) => file.id !== id);
}

function fileStatus(file) {
  if (file.status === "uploading") return `上传中 ${file.progress}%`;
  if (file.status === "processing") return "正在解析并建立索引…";
  if (file.status === "success") return file.approvalRequired ? "等待管理员审批" : "可用于问答";
  if (file.status === "error") return "上传或处理失败";
  return "待上传";
}

async function uploadFiles(onlyId) {
  if (locked.value || !props.libraryId) return;
  const queue = files.value.filter(
    (file) =>
      (onlyId === undefined || file.id === onlyId) &&
      (file.status === "pending" || file.status === "error")
  );
  if (!queue.length) return;

  const version = contextVersion;
  const libraryId = props.libraryId;
  const completed = [];
  const isCurrent = () =>
    !disposed && contextVersion === version && props.libraryId === libraryId;
  uploading.value = true;

  try {
    // Keep per-file progress and retry state while indexing sequentially.
    for (const file of queue) {
      if (!isCurrent()) break;
      file.status = "uploading";
      file.progress = 0;
      file.error = "";
      try {
        const request = uploadKnowledgeFile({
          api,
          libraryId,
          onDocument(id) {
            if (isCurrent()) {
              file.documentId = id;
              file.progress = 100;
              file.status = "processing";
            }
          },
          file,
          onProgress(event) {
            if (!isCurrent()) return;
            file.progress = Math.min(
              100,
              Math.max(0, Math.round(Number(event?.progress) || 0))
            );
            // Transport completion is not index completion.
            file.status = file.progress >= 100 ? "processing" : "uploading";
          },
        });
        activeRequest = request;
        const result = await request.promise;
        if (!isCurrent()) break;
        if (result?.aborted) {
          file.status = "error";
          file.error = "上传已中断，请重试";
          continue;
        }
        file.progress = 100;
        file.status = "success";
        file.approvalRequired = result.approvalRequired === true;
        completed.push({ id: file.id, name: file.name, result });
      } catch (error) {
        if (!isCurrent()) break;
        file.status = "error";
        file.error = error?.message || "文件处理失败，请重试";
      } finally {
        if (isCurrent()) activeRequest = null;
      }
    }
  } finally {
    if (isCurrent()) {
      uploading.value = false;
      if (completed.length)
        emit("uploaded", {
          libraryId,
          count: completed.length,
          files: completed,
        });
    }
  }
}

function resetQueue() {
  contextVersion += 1;
  const request = activeRequest;
  activeRequest = null;
  choosing.value = false;
  uploading.value = false;
  files.value = [];
  request?.abort();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<style scoped>
.chat-upload {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #ffffff;
}
.upload-panel {
  flex: 1;
  height: 0;
  min-height: 0;
}
.upload-panel__content {
  width: 100%;
  min-height: 100%;
  max-width: 820px;
  margin: 0 auto;
  padding: 24px 24px 32px;
  box-sizing: border-box;
}
.upload-panel__content.is-empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
.upload-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 300px;
  padding: 24px 0;
  text-align: center;
}
.upload-empty__symbol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 68px;
  height: 68px;
  margin-bottom: 20px;
  border: 1px solid #e4ede7;
  border-radius: 20px;
  background: #f1f7f3;
}
.upload-empty__title {
  color: #2c4035;
  font-size: 20px;
  font-weight: 600;
  line-height: 30px;
}
.upload-empty__description {
  margin-top: 10px;
  color: #8c9890;
  font-size: 13px;
  line-height: 22px;
}
.upload-status {
  display: block;
  margin-top: 18px;
  color: #98a39d;
  font-size: 12px;
  line-height: 20px;
}
.upload-files__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.upload-files__title {
  color: #3b5044;
  font-size: 15px;
  font-weight: 600;
  line-height: 24px;
}
.upload-files__count {
  flex-shrink: 0;
  color: #98a39d;
  font-size: 12px;
}
.upload-file {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  padding: 13px 10px 13px 14px;
  border: 1px solid #e7ece8;
  border-radius: 12px;
  background: #f9fbfa;
}
.upload-file__symbol {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 44px;
  border-radius: 9px;
  background: #edf5f0;
}
.upload-file__details {
  flex: 1;
  min-width: 0;
}
.upload-file__name {
  display: block;
  overflow: hidden;
  color: #40554a;
  font-size: 14px;
  line-height: 22px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.upload-file__size {
  display: block;
  margin-top: 3px;
  color: #98a39d;
  font-size: 11px;
  line-height: 18px;
}
.upload-file__state {
  display: block;
  margin-top: 4px;
  color: #87968c;
  font-size: 12px;
  line-height: 19px;
}
.upload-file__state.is-uploading,
.upload-file__state.is-processing,
.upload-file__state.is-success {
  color: #238568;
}
.upload-file__state.is-error,
.upload-file__error {
  color: #bf5757;
}
.upload-file__error {
  display: block;
  margin-top: 4px;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 19px;
}
.upload-file__actions {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  align-items: center;
}
.upload-progress {
  height: 4px;
  margin-top: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: #e4ede7;
}
.upload-progress__fill {
  height: 100%;
  background: #238568;
  transition: width 0.2s;
}
.upload-complete {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #edf7f0;
}
.upload-complete__title {
  color: #238568;
  font-size: 12px;
  line-height: 20px;
}
.upload-action-region {
  flex-shrink: 0;
  padding: 14px 24px 20px;
  padding-bottom: calc(20px + env(safe-area-inset-bottom));
  border-top: 1px solid #edf1ee;
  background: #ffffff;
}
.upload-action-region__content {
  max-width: 772px;
  margin: 0 auto;
}
.upload-workspace {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: #8a9690;
  font-size: 12px;
  line-height: 18px;
}
.upload-workspace text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
@media (max-width: 767px) {
  .upload-panel__content {
    padding: 20px 18px 24px;
  }
  .upload-action-region {
    padding: 12px 18px 16px;
    padding-bottom: calc(16px + env(safe-area-inset-bottom));
  }
}
</style>
