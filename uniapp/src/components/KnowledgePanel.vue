<template>
  <view class="knowledge-panel">
    <scroll-view scroll-y class="knowledge-scroll" :show-scrollbar="false">
      <view class="knowledge-content">
        <view class="page-heading">
          <view class="page-heading__copy">
            <text class="eyebrow">KNOWLEDGE</text>
            <text class="page-title">知识资料</text>
            <text class="page-description"
              >共同维护公有知识，也为自己保留一份私有经验。</text
            >
          </view>
          <wd-button
            icon="add"
            :round="false"
            :disabled="!uploadLibraries.length"
            custom-style="height:42px;border-radius:10px;background:#237b61;border-color:#237b61;font-size:14px;"
            @click="openAdd"
            >新增资料</wd-button
          >
        </view>

        <view class="scope-tabs">
          <view
            v-for="scope in scopeOptions"
            :key="scope.id"
            class="scope-tab"
            :class="{ 'is-active': selectedScope === scope.id }"
            @click="selectScope(scope.id)"
          >
            <text>{{ scope.label }}</text
            ><text class="scope-tab-count">{{ scopeCount(scope.id) }}</text>
          </view>
        </view>
        <view class="scope-explanation"
          ><wd-icon
            :name="selectedScope === 'private' ? 'secured' : 'info-circle'"
            size="14px"
          /><text>{{ scopeExplanation }}</text></view
        >

        <view class="library-section">
          <view class="section-heading">
            <text class="section-label">知识分类</text>
            <view class="permission-hint"
              ><wd-icon name="secured" size="13px" /><text
                >公有知识 + 我的私有知识</text
              ></view
            >
          </view>
          <view class="library-list">
            <view
              class="library-item library-item--all"
              :class="{ 'is-active': selectedLibrary === 'all' }"
              @click="selectedLibrary = 'all'"
            >
              <view class="library-icon"
                ><wd-icon name="layers" size="21px"
              /></view>
              <view class="library-copy"
                ><text class="library-name">全部分类</text
                ><text class="library-description">{{
                  selectedScope === "all"
                    ? "所有可访问的资料"
                    : selectedScope === "private"
                      ? "我的全部私有资料"
                      : "全部公有资料"
                }}</text></view
              >
              <text class="library-count">{{ scopeCount(selectedScope) }}</text>
            </view>
            <view
              v-for="library in scopeLibraries"
              :key="library.id"
              class="library-item"
              :class="{ 'is-active': selectedLibrary === library.id }"
              @click="selectedLibrary = library.id"
            >
              <view
                class="library-icon"
                :style="{ color: library.color || '#237b61' }"
                ><wd-icon :name="library.icon || 'folder'" size="21px"
              /></view>
              <view class="library-copy"
                ><view class="library-name-line"
                  ><text class="library-name">{{ library.name }}</text
                  ><text
                    class="scope-badge"
                    :class="`scope-badge--${library.scope}`"
                    >{{ library.scope === "public" ? "公有" : "私有" }}</text
                  ></view
                ><text class="library-description">{{
                  library.description
                }}</text></view
              >
              <text class="library-count">{{ libraryCount(library.id) }}</text>
            </view>
          </view>
        </view>

        <view class="documents-section">
          <view class="documents-toolbar">
            <view class="documents-title"
              ><text>{{ activeLibraryName }}</text
              ><text class="result-count"
                >{{ filteredDocuments.length }} 份资料</text
              ></view
            >
            <view class="document-search">
              <wd-icon name="search" size="17px" color="#85948b" />
              <input
                v-model="search"
                class="document-search__input"
                placeholder="搜索资料名称或内容"
                placeholder-style="color:#98a49d;font-size:13px"
                confirm-type="search"
              />
              <view v-if="search" class="clear-search" @click="search = ''"
                ><wd-icon name="close" size="13px" color="#89968e"
              /></view>
            </view>
          </view>
          <view class="document-table-head">
            <text class="document-column--name">资料名称</text
            ><text class="document-column--library">所属知识库</text
            ><text class="document-column--status">状态</text
            ><text class="document-column--updated">来源 / 更新时间</text
            ><text class="document-column--actions">操作</text>
          </view>
          <view
            v-for="document in filteredDocuments"
            :key="document.id"
            class="document-row"
            @click="openDetail(document)"
          >
            <view class="document-column--name document-name-cell">
              <view
                class="document-type"
                :class="`document-type--${document.type}`"
                ><wd-icon
                  :name="document.type === 'text' ? 'edit-outline' : 'file'"
                  size="19px"
                /><text>{{ typeLabel(document.type) }}</text></view
              >
              <view class="document-name-copy"
                ><view class="document-title-line"
                  ><text class="document-name">{{ document.name }}</text
                  ><text
                    class="scope-badge"
                    :class="`scope-badge--${documentScope(document)}`"
                    >{{
                      documentScope(document) === "public" ? "公有" : "私有"
                    }}</text
                  ></view
                ><text class="document-size">{{
                  document.size || "文字知识"
                }}</text
                ><text class="document-mobile-meta"
                  >{{ libraryName(document.libraryId) }} ·
                  {{ document.updatedAt }}</text
                ></view
              >
            </view>
            <view class="document-column--library"
              ><text class="library-tag">{{
                libraryName(document.libraryId)
              }}</text></view
            >
            <view class="document-column--status"
              ><view
                class="document-status"
                :class="`document-status--${document.status}`"
                ><view class="status-dot" /><text>{{
                  documentStatus(document)
                }}</text></view
              ></view
            >
            <view class="document-column--updated"
              ><text class="document-source"
                >{{ document.type === "text" ? "文字录入" : "文件上传" }} ·
                {{ document.owner || "我" }}</text
              ><text class="document-updated">{{
                document.updatedAt
              }}</text></view
            >
            <view class="document-column--actions document-actions" @click.stop
              ><wd-button
                type="text"
                size="small"
                custom-style="font-size:13px;color:#237b61;"
                @click="openDetail(document)"
                >查看</wd-button
              ><view
                v-if="canOperate(document)"
                class="delete-document"
                @click.stop="openEdit(document)"
                ><wd-icon
                  name="edit-outline"
                  size="16px"
                  color="#718d7b" /></view
              ><view
                v-if="canOperate(document)"
                class="delete-document"
                @click.stop="confirmDelete(document)"
                ><wd-icon name="delete" size="16px" color="#94a097" /></view
            ></view>
          </view>
          <view v-if="!filteredDocuments.length" class="documents-empty">
            <view class="empty-icon"
              ><wd-icon
                :name="search ? 'search' : 'folder-open'"
                size="29px"
                color="#8da89b"
            /></view>
            <text class="empty-title">{{
              search ? "没有找到相关资料" : "这里还没有知识资料"
            }}</text>
            <text class="empty-description">{{
              search
                ? "试试其他关键词，或切换到全部知识。"
                : "上传一份资料，或把你的工作经验记录下来。"
            }}</text>
            <wd-button
              v-if="search"
              type="text"
              custom-style="color:#237b61;"
              @click="
                search = '';
                selectedLibrary = 'all';
                selectedScope = 'all';
              "
              >清除筛选</wd-button
            >
            <wd-button
              v-else-if="uploadLibraries.length"
              type="text"
              custom-style="color:#237b61;"
              @click="openAdd"
              >新增第一份资料</wd-button
            >
          </view>
          <view v-else class="document-table-footer"
            ><wd-icon name="check-outline" size="13px" color="#899a8f" /><text
              >标记为「可检索」的资料，可用于问答中的知识检索</text
            ></view
          >
        </view>
        <view class="demo-notice"
          ><wd-icon name="info-circle" size="13px" /><text
            >演示数据，本地模拟入库</text
          ></view
        >
      </view>
    </scroll-view>

    <wd-popup
      v-model="addVisible"
      position="center"
      :close-on-click-modal="!submitting"
      custom-style="width:calc(100% - 32px);max-width:600px;border-radius:18px;overflow:hidden;"
    >
      <view class="knowledge-dialog">
        <view class="dialog-heading"
          ><view
            ><text class="dialog-title">新增知识资料</text
            ><text class="dialog-subtitle"
              >先选择可见范围，再选择资料所属分类。</text
            ></view
          ><view
            v-if="!submitting"
            class="dialog-close"
            @click="addVisible = false"
            ><wd-icon name="close" size="18px" color="#89968f" /></view
        ></view>
        <scroll-view scroll-y class="dialog-scroll" :show-scrollbar="false">
          <view v-if="submitted" class="submit-success">
            <view class="success-symbol"
              ><wd-icon name="check" size="29px" color="#237b61" /></view
            ><text class="success-title">{{
              entryMode === "file" ? "资料已收录" : "资料已可检索"
            }}</text
            ><text class="success-description"
              >{{ successCount }} 份资料已加入「{{
                libraryName(targetLibrary)
              }}」</text
            ><text class="success-notice">{{
              entryMode === "file"
                ? "本地演示仅记录名称和大小，暂未解析文件内容。"
                : "本次为本地模拟入库，仅用于页面演示。"
            }}</text>
          </view>
          <view v-else class="dialog-body">
            <text class="field-label">谁可以使用和维护</text>
            <view class="target-scope-options">
              <view
                class="target-scope-option"
                :class="{ 'is-selected': targetScope === 'private' }"
                @click="setTargetScope('private')"
                ><wd-icon name="secured" size="18px" /><view
                  ><text class="target-scope-title">我的私有</text
                  ><text class="target-scope-description"
                    >仅我可读、上传、修改和删除</text
                  ></view
                ><wd-icon
                  v-if="targetScope === 'private'"
                  name="check"
                  size="16px"
              /></view>
              <view
                class="target-scope-option"
                :class="{ 'is-selected': targetScope === 'public' }"
                @click="setTargetScope('public')"
                ><wd-icon name="usergroup" size="18px" /><view
                  ><text class="target-scope-title">公有知识</text
                  ><text class="target-scope-description"
                    >所有登录用户可读、上传、修改和删除</text
                  ></view
                ><wd-icon
                  v-if="targetScope === 'public'"
                  name="check"
                  size="16px"
              /></view>
            </view>
            <text class="field-label">所属知识分类</text>
            <view class="target-libraries"
              ><view
                v-for="library in targetLibraries"
                :key="library.id"
                class="target-library"
                :class="{ 'is-selected': targetLibrary === library.id }"
                @click="!submitting && (targetLibrary = library.id)"
                ><wd-icon name="folder" size="15px" /><text>{{
                  library.name
                }}</text
                ><wd-icon
                  v-if="targetLibrary === library.id"
                  name="check"
                  size="14px" /></view
            ></view>
            <text v-if="!targetLibraries.length" class="form-error"
              >此范围下暂无可用分类，请切换范围。</text
            >
            <view class="entry-modes"
              ><view
                :class="{ 'is-active': entryMode === 'file' }"
                @click="!submitting && (entryMode = 'file')"
                ><wd-icon name="upload" size="16px" /><text
                  >上传文件</text
                ></view
              ><view
                :class="{ 'is-active': entryMode === 'text' }"
                @click="!submitting && (entryMode = 'text')"
                ><wd-icon name="edit-outline" size="16px" /><text
                  >文字录入</text
                ></view
              ></view
            >
            <view v-if="entryMode === 'file'">
              <view
                class="file-dropzone"
                :class="{ 'is-disabled': submitting || choosing }"
                @click="chooseFiles"
                ><view class="upload-symbol"
                  ><wd-icon name="upload" size="25px" color="#237b61" /></view
                ><text class="dropzone-title">{{
                  choosing ? "正在选择文件…" : "点击选择本地文件"
                }}</text
                ><text class="dropzone-description"
                  >支持 PDF、DOCX、XLSX、TXT，最多 5 份</text
                ></view
              >
              <view
                v-for="file in selectedFiles"
                :key="file.id"
                class="selected-file"
                ><wd-icon name="file" size="18px" color="#637e70" /><text
                  class="selected-file-name"
                  >{{ file.name }}</text
                ><text class="selected-file-size">{{ file.size }}</text
                ><view
                  v-if="!submitting"
                  class="selected-file-remove"
                  @click="
                    selectedFiles = selectedFiles.filter(
                      (item) => item.id !== file.id
                    )
                  "
                  ><wd-icon name="close" size="13px" color="#8e9a92" /></view
              ></view>
            </view>
            <view v-else class="text-entry"
              ><text class="field-label">知识标题</text
              ><input
                v-model="textTitle"
                :disabled="submitting"
                class="title-input"
                :maxlength="80"
                placeholder="例如：销售订单审核注意事项"
                placeholder-style="color:#a0aaa4;font-size:13px"
              /><text class="field-label content-label">知识内容</text
              ><textarea
                v-model="textContent"
                :disabled="submitting"
                class="content-input"
                :maxlength="6000"
                placeholder="记录业务规则、工作经验或操作步骤…"
                placeholder-style="color:#a0aaa4;font-size:13px"
              /><text class="character-count"
                >{{ textContent.length }} / 6000</text
              ></view
            >
            <view v-if="submitting" class="processing-note"
              ><wd-loading size="16px" color="#237b61" /><text
                >正在本地模拟入库…</text
              ></view
            >
            <text v-if="formError" class="form-error">{{ formError }}</text>
            <view class="form-notice"
              ><wd-icon name="info-circle" size="13px" /><text
                >演示数据，本地模拟入库。文件仅选择名称和大小。</text
              ></view
            >
          </view>
        </scroll-view>
        <view class="dialog-footer"
          ><wd-button
            v-if="!submitted"
            :plain="true"
            :round="false"
            :disabled="submitting"
            custom-style="height:40px;border-radius:9px;color:#66796d;border-color:#dfe7e1;background:#fff;"
            @click="addVisible = false"
            >取消</wd-button
          ><wd-button
            :round="false"
            :loading="submitting"
            custom-style="height:40px;border-radius:9px;background:#237b61;border-color:#237b61;"
            @click="submitted ? (addVisible = false) : submitDocument()"
            >{{
              submitted ? "完成" : submitting ? "入库处理中" : "确认入库"
            }}</wd-button
          ></view
        >
      </view>
    </wd-popup>

    <wd-popup
      v-model="detailVisible"
      position="center"
      custom-style="width:calc(100% - 32px);max-width:620px;border-radius:18px;overflow:hidden;"
    >
      <view v-if="detailDocument" class="knowledge-dialog">
        <view class="dialog-heading"
          ><view
            ><text class="dialog-title">资料详情</text
            ><text class="dialog-subtitle">查看资料来源及知识内容</text></view
          ><view class="dialog-close" @click="detailVisible = false"
            ><wd-icon name="close" size="18px" color="#89968f" /></view
        ></view>
        <scroll-view
          scroll-y
          class="dialog-scroll detail-scroll"
          :show-scrollbar="false"
          ><view class="detail-body"
            ><view class="detail-document-heading"
              ><view
                class="document-type"
                :class="`document-type--${detailDocument.type}`"
                ><wd-icon
                  :name="
                    detailDocument.type === 'text' ? 'edit-outline' : 'file'
                  "
                  size="21px"
                /><text>{{ typeLabel(detailDocument.type) }}</text></view
              ><text class="detail-name">{{ detailDocument.name }}</text></view
            ><view class="detail-metadata"
              ><view
                ><text>可见与操作范围</text
                ><text
                  class="scope-badge"
                  :class="`scope-badge--${documentScope(detailDocument)}`"
                  >{{
                    documentScope(detailDocument) === "public"
                      ? "公有 · 所有登录用户"
                      : "私有 · 仅我自己"
                  }}</text
                ></view
              ><view
                ><text>所属知识库</text
                ><text>{{ libraryName(detailDocument.libraryId) }}</text></view
              ><view
                ><text>处理状态</text
                ><text
                  :class="{ 'is-ready': detailDocument.status === 'ready' }"
                  >{{ documentStatus(detailDocument) }}</text
                ></view
              ><view
                ><text>资料来源</text
                ><text
                  >{{
                    detailDocument.type === "text" ? "文字录入" : "文件上传"
                  }}
                  · {{ detailDocument.owner || "我" }}</text
                ></view
              ><view
                ><text>更新时间</text
                ><text>{{ detailDocument.updatedAt }}</text></view
              ><view v-if="detailDocument.updatedByName"
                ><text>最近修改人</text
                ><text>{{ detailDocument.updatedByName }}</text></view
              ></view
            ><text class="detail-content-label">{{
              detailDocument.type === "text" ? "知识内容" : "内容摘要"
            }}</text
            ><text class="detail-content">{{
              detailDocument.content ||
              "本地演示暂未解析文件内容。完成真实知识库接入后，可以在此查看资料原文与解析结果。"
            }}</text
            ><view class="form-notice"
              ><wd-icon name="info-circle" size="13px" /><text
                >演示数据，本地模拟入库</text
              ></view
            ></view
          ></scroll-view
        >
        <view class="dialog-footer detail-footer"
          ><wd-button
            v-if="canOperate(detailDocument)"
            type="text"
            custom-style="color:#b56b63;font-size:13px;"
            @click="confirmDelete(detailDocument)"
            >删除资料</wd-button
          ><view class="detail-footer-buttons"
            ><wd-button
              type="text"
              custom-style="color:#75887c;font-size:13px;"
              @click="detailVisible = false"
              >关闭</wd-button
            ><wd-button
              v-if="canOperate(detailDocument)"
              :round="false"
              custom-style="height:40px;border-radius:9px;background:#237b61;border-color:#237b61;"
              @click="openEdit(detailDocument)"
              >编辑资料</wd-button
            ></view
          ></view
        >
      </view>
    </wd-popup>

    <wd-popup
      v-model="editVisible"
      position="center"
      custom-style="width:calc(100% - 32px);max-width:600px;border-radius:18px;overflow:hidden;"
    >
      <view v-if="editingDocument" class="knowledge-dialog">
        <view class="dialog-heading"
          ><view
            ><text class="dialog-title">编辑资料</text
            ><text class="dialog-subtitle">{{
              documentScope(editingDocument) === "public"
                ? "这份公有资料由所有登录用户共同维护。"
                : "这份私有资料仅你自己可读和维护。"
            }}</text></view
          ><view class="dialog-close" @click="editVisible = false"
            ><wd-icon name="close" size="18px" color="#89968f" /></view
        ></view>
        <scroll-view scroll-y class="dialog-scroll" :show-scrollbar="false"
          ><view class="dialog-body text-entry">
            <view class="edit-library-note"
              ><wd-icon
                :name="
                  documentScope(editingDocument) === 'public'
                    ? 'folder'
                    : 'secured'
                "
                size="15px"
              /><text
                >{{ libraryName(editingDocument.libraryId) }} ·
                {{
                  documentScope(editingDocument) === "public"
                    ? "公有知识"
                    : "我的私有"
                }}</text
              ></view
            >
            <text class="field-label">{{
              editingDocument.type === "text" ? "知识标题" : "资料名称"
            }}</text
            ><input
              v-model="editTitle"
              class="title-input"
              :maxlength="160"
              placeholder="请输入资料名称"
            />
            <template v-if="editingDocument.type === 'text'"
              ><text class="field-label content-label">知识内容</text
              ><textarea
                v-model="editContent"
                class="content-input"
                :maxlength="6000"
                placeholder="请输入知识内容"
              /><text class="character-count"
                >{{ editContent.length }} / 6000</text
              ></template
            >
            <text v-if="editError" class="form-error">{{ editError }}</text
            ><view class="form-notice"
              ><wd-icon name="info-circle" size="13px" /><text
                >编辑不会改变所属知识库或公私范围。{{
                  editingDocument.type === "text"
                    ? "保存后按新内容参与模拟检索。"
                    : "文件内容暂未接入解析，本次仅修改名称。"
                }}</text
              ></view
            >
          </view></scroll-view
        >
        <view class="dialog-footer"
          ><wd-button
            type="text"
            custom-style="color:#75887c;"
            @click="editVisible = false"
            >取消</wd-button
          ><wd-button
            :round="false"
            custom-style="height:40px;border-radius:9px;background:#237b61;border-color:#237b61;"
            @click="saveEdit"
            >保存修改</wd-button
          ></view
        >
      </view>
    </wd-popup>
  </view>
</template>

<script setup>
import { computed, onUnmounted, ref } from "vue";

defineOptions({ options: { virtualHost: true, styleIsolation: "shared" } });
const props = defineProps({
  libraries: { type: Array, default: () => [] },
  documents: { type: Array, default: () => [] },
  currentUser: {
    type: Object,
    default: () => ({ id: "lin", name: "林晓", role: "user" }),
  },
});
const emit = defineEmits([
  "add-document",
  "remove-document",
  "update-document",
]);
const scopeOptions = [
  { id: "all", label: "全部" },
  { id: "public", label: "公有知识" },
  { id: "private", label: "我的私有" },
];
const selectedScope = ref("all");
const selectedLibrary = ref("all");
const search = ref("");
const addVisible = ref(false);
const entryMode = ref("file");
const targetLibrary = ref("");
const targetScope = ref("private");
const selectedFiles = ref([]);
const textTitle = ref("");
const textContent = ref("");
const formError = ref("");
const submitting = ref(false);
const choosing = ref(false);
const submitted = ref(false);
const successCount = ref(0);
const detailVisible = ref(false);
const detailDocument = ref(null);
const editVisible = ref(false);
const editingDocument = ref(null);
const editTitle = ref("");
const editContent = ref("");
const editError = ref("");
let submitTimer;
let disposed = false;
let selectionVersion = 0;

const accessibleLibraries = computed(() =>
  props.libraries.filter(
    (library) =>
      library.scope === "public" ||
      (library.scope === "private" && library.ownerId === props.currentUser.id)
  )
);
const accessibleDocuments = computed(() =>
  props.documents.filter((document) =>
    accessibleLibraries.value.some(
      (library) => library.id === document.libraryId
    )
  )
);
const uploadLibraries = computed(() =>
  accessibleLibraries.value.filter((library) => library.canUpload)
);
const scopeLibraries = computed(() =>
  accessibleLibraries.value.filter(
    (library) =>
      selectedScope.value === "all" || library.scope === selectedScope.value
  )
);
const targetLibraries = computed(() =>
  uploadLibraries.value.filter((library) => library.scope === targetScope.value)
);
const scopeExplanation = computed(
  () =>
    ({
      all: "公有知识全员共享与维护；我的私有知识仅自己可读、可操作。",
      public: "所有登录用户都可以查看、上传、修改和删除公有资料。",
      private: "只有你自己可以查看、上传、修改和删除这些私有资料。",
    })[selectedScope.value]
);
const activeLibraryName = computed(() =>
  selectedLibrary.value === "all"
    ? `${scopeLabel(selectedScope.value)}资料`
    : libraryName(selectedLibrary.value)
);
const filteredDocuments = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return accessibleDocuments.value.filter(
    (document) =>
      (selectedScope.value === "all" ||
        documentScope(document) === selectedScope.value) &&
      (selectedLibrary.value === "all" ||
        document.libraryId === selectedLibrary.value) &&
      (!keyword ||
        `${document.name} ${document.content || ""}`
          .toLowerCase()
          .includes(keyword))
  );
});

function libraryCount(id) {
  return accessibleDocuments.value.filter(
    (document) => document.libraryId === id
  ).length;
}
function scopeLabel(scope) {
  return (
    { all: "全部", public: "公有知识", private: "我的私有" }[scope] || "全部"
  );
}
function scopeCount(scope) {
  return accessibleDocuments.value.filter(
    (document) => scope === "all" || documentScope(document) === scope
  ).length;
}
function selectScope(scope) {
  selectedScope.value = scope;
  selectedLibrary.value = "all";
}
function documentScope(document) {
  return props.libraries.find((library) => library.id === document.libraryId)
    ?.scope;
}
function canOperate(document) {
  const library = accessibleLibraries.value.find(
    (library) => library.id === document?.libraryId
  );
  return (
    !!library &&
    (library.scope === "public" || library.ownerId === props.currentUser.id)
  );
}
function setTargetScope(scope) {
  if (submitting.value) return;
  targetScope.value = scope;
  targetLibrary.value =
    uploadLibraries.value.find((library) => library.scope === scope)?.id || "";
}
function libraryName(id) {
  return props.libraries.find((library) => library.id === id)?.name || "知识库";
}
function typeLabel(type) {
  return (
    { pdf: "PDF", docx: "DOCX", xlsx: "XLSX", txt: "TXT", text: "TXT" }[type] ||
    "FILE"
  );
}
function statusLabel(status) {
  return (
    {
      ready: "可检索",
      processing: "处理中",
      failed: "处理失败",
      error: "处理失败",
      pending: "待处理",
    }[status] || "待处理"
  );
}
function documentStatus(document) {
  return document.status === "ready" &&
    document.type !== "text" &&
    !document.content
    ? "已收录"
    : statusLabel(document.status);
}
function uniqueId() {
  return `knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function formatSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function openAdd() {
  if (!uploadLibraries.value.length) return;
  selectionVersion += 1;
  choosing.value = false;
  setTargetScope("private");
  entryMode.value = "file";
  selectedFiles.value = [];
  textTitle.value = "";
  textContent.value = "";
  formError.value = "";
  submitted.value = false;
  successCount.value = 0;
  addVisible.value = true;
}
function chooseFiles() {
  if (submitting.value || choosing.value) return;
  const remaining = 5 - selectedFiles.value.length;
  if (remaining <= 0) {
    uni.showToast({ title: "每次最多选择 5 份资料", icon: "none" });
    return;
  }
  const version = selectionVersion;
  choosing.value = true;
  const options = {
    count: remaining,
    success(result) {
      if (disposed || version !== selectionVersion || !addVisible.value) return;
      let unsupported = 0;
      for (const file of (result.tempFiles || []).slice(0, remaining)) {
        const name =
          file.name || (file.path || "").split(/[\\/]/).pop() || "未命名资料";
        const extension = name.split(".").pop().toLowerCase();
        const type = { pdf: "pdf", docx: "docx", xlsx: "xlsx", txt: "txt" }[
          extension
        ];
        if (!type) {
          unsupported += 1;
          continue;
        }
        selectedFiles.value.push({
          id: uniqueId(),
          name,
          size: formatSize(file.size),
          type,
        });
      }
      formError.value = unsupported
        ? "部分文件格式不支持，请选择 PDF、DOCX、XLSX 或 TXT。"
        : "";
    },
    fail(error) {
      if (!/cancel/i.test(String(error?.errMsg || "")))
        uni.showToast({ title: "选择文件失败，请重试", icon: "none" });
    },
    complete() {
      if (version === selectionVersion) choosing.value = false;
    },
  };
  // #ifdef H5
  uni.chooseFile({
    ...options,
    type: "all",
    extension: [".pdf", ".docx", ".xlsx", ".txt"],
  });
  // #endif
  // #ifdef MP-WEIXIN
  uni.chooseMessageFile({
    ...options,
    type: "file",
    extension: ["pdf", "docx", "xlsx", "txt"],
  });
  // #endif
  // #ifndef H5 || MP-WEIXIN
  choosing.value = false;
  uni.showToast({ title: "请在浏览器或微信小程序中选择文件", icon: "none" });
  // #endif
}
function submitDocument() {
  if (submitting.value) return;
  formError.value = "";
  if (
    !targetLibraries.value.some((library) => library.id === targetLibrary.value)
  ) {
    formError.value = "请选择当前可见范围内的知识分类。";
    return;
  }
  if (entryMode.value === "file" && !selectedFiles.value.length) {
    formError.value = "请先选择需要入库的资料。";
    return;
  }
  if (
    entryMode.value === "text" &&
    (!textTitle.value.trim() || !textContent.value.trim())
  ) {
    formError.value = "请填写知识标题和内容。";
    return;
  }
  const common = {
    libraryId: targetLibrary.value,
    updatedAt: "刚刚",
    status: "ready",
    owner: props.currentUser.name,
    uploadedBy: props.currentUser.id,
    updatedBy: props.currentUser.id,
    updatedByName: props.currentUser.name,
  };
  const documents =
    entryMode.value === "file"
      ? selectedFiles.value.map((file) => ({ ...file, ...common, content: "" }))
      : [
          {
            id: uniqueId(),
            name: textTitle.value.trim(),
            type: "text",
            size: `${textContent.value.trim().length} 字`,
            content: textContent.value.trim(),
            ...common,
          },
        ];
  submitting.value = true;
  submitTimer = setTimeout(() => {
    if (disposed) return;
    documents.forEach((document) => emit("add-document", document));
    successCount.value = documents.length;
    submitting.value = false;
    submitted.value = true;
    selectedScope.value = targetScope.value;
    selectedLibrary.value = targetLibrary.value;
    search.value = "";
  }, 760);
}
function openDetail(document) {
  if (!canOperate(document)) return;
  detailDocument.value = document;
  detailVisible.value = true;
}
function confirmDelete(document) {
  if (!canOperate(document)) return;
  const isPublic = documentScope(document) === "public";
  uni.showModal({
    title: "删除知识资料",
    content: `确定删除「${document.name}」？${isPublic ? "这是公有资料，删除后所有用户将无法再检索此资料。" : "删除后将不再参与你的知识检索。"}`,
    confirmText: "删除",
    confirmColor: "#b56b63",
    success(result) {
      if (!result.confirm || disposed || !canOperate(document)) return;
      emit("remove-document", document.id);
      if (detailDocument.value?.id === document.id) detailVisible.value = false;
      uni.showToast({ title: "资料已删除", icon: "none" });
    },
  });
}
function openEdit(document) {
  if (!canOperate(document)) return;
  editingDocument.value = document;
  editTitle.value = document.name || "";
  editContent.value = document.content || "";
  editError.value = "";
  detailVisible.value = false;
  editVisible.value = true;
}
function saveEdit() {
  const original = props.documents.find(
    (document) => document.id === editingDocument.value?.id
  );
  if (!original || !canOperate(original)) {
    editError.value = "资料已不存在或无法操作，请关闭后重试。";
    return;
  }
  if (!editTitle.value.trim()) {
    editError.value = "请填写资料名称。";
    return;
  }
  if (original.type === "text" && !editContent.value.trim()) {
    editError.value = "请填写知识内容。";
    return;
  }
  emit("update-document", {
    ...original,
    name: editTitle.value.trim(),
    content:
      original.type === "text" ? editContent.value.trim() : original.content,
    size:
      original.type === "text"
        ? `${editContent.value.trim().length} 字`
        : original.size,
    updatedAt: "刚刚",
    updatedBy: props.currentUser.id,
    updatedByName: props.currentUser.name,
  });
  editVisible.value = false;
  uni.showToast({ title: "资料已更新", icon: "none" });
}
onUnmounted(() => {
  disposed = true;
  clearTimeout(submitTimer);
});
</script>

<style scoped>
.knowledge-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: #f6f8fa;
  color: #25342e;
  overflow: hidden;
}
.knowledge-scroll {
  flex: 1;
  height: 0;
  min-height: 0;
}
.knowledge-content {
  max-width: 1260px;
  margin: 0 auto;
  padding: 34px 40px 28px;
  box-sizing: border-box;
}
.page-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 32px;
}
.page-heading__copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.8px;
  color: #81968a;
  margin-bottom: 8px;
}
.page-title {
  font-size: 28px;
  font-weight: 650;
  line-height: 39px;
  letter-spacing: 0.3px;
}
.page-description {
  font-size: 13px;
  line-height: 22px;
  color: #849188;
  margin-top: 8px;
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 13px;
}
.section-label {
  font-size: 14px;
  font-weight: 600;
}
.permission-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #94a198;
}
.scope-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  padding: 5px;
  border: 1px solid #e5ebe7;
  border-radius: 12px;
  background: #edf2ef;
}
.scope-tab {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 18px;
  border-radius: 8px;
  font-size: 13px;
  color: #7e9084;
  cursor: pointer;
}
.scope-tab.is-active {
  background: #fff;
  color: #237b61;
  box-shadow: 0 1px 5px #1e4a2c0a;
  font-weight: 600;
}
.scope-tab-count {
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 10px;
  background: #e6ede8;
  color: #7e9385;
}
.scope-tab.is-active .scope-tab-count {
  background: #edf6f0;
  color: #358364;
}
.scope-explanation {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 13px 0 25px;
  color: #82968a;
  font-size: 11px;
  line-height: 20px;
}
.library-name-line,
.document-title-line {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.library-name-line .library-name,
.document-title-line .document-name {
  flex: 1;
  min-width: 0;
}
.scope-badge {
  display: inline-block;
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 9px;
  line-height: 17px;
  font-weight: 400;
  white-space: nowrap;
}
.scope-badge--public {
  background: #edf5ef;
  color: #61836d;
}
.scope-badge--private {
  background: #f0edf8;
  color: #8d7aa5;
}
.library-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.library-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 86px;
  border: 1px solid #e5ebe7;
  border-radius: 13px;
  background: #fff;
  padding: 15px;
  box-sizing: border-box;
  cursor: pointer;
  transition:
    background 0.18s,
    border-color 0.18s;
}
.library-item.is-active {
  border-color: #63a18a;
  background: #f0f8f3;
  box-shadow: 0 0 0 1px #d5e9de inset;
}
.library-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 39px;
  border-radius: 9px;
  background: #f1f6f3;
  color: #237b61;
}
.library-copy {
  flex: 1;
  min-width: 0;
}
.library-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  line-height: 22px;
}
.library-description {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 17px;
  color: #8a978f;
  margin-top: 3px;
}
.library-count {
  font-size: 19px;
  line-height: 26px;
  color: #5d7366;
  font-weight: 600;
}
.is-active .library-count {
  color: #237b61;
}
.documents-section {
  margin-top: 28px;
  border: 1px solid #e5ebe7;
  border-radius: 14px;
  overflow: hidden;
  background: #fff;
}
.documents-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
  padding: 20px 22px;
}
.documents-title {
  display: flex;
  align-items: center;
  gap: 11px;
  font-size: 15px;
  font-weight: 600;
}
.result-count {
  font-size: 11px;
  font-weight: 400;
  color: #97a39b;
}
.document-search {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 245px;
  min-width: 0;
  height: 35px;
  padding: 0 11px;
  background: #f7f9f8;
  border: 1px solid #eaf0eb;
  border-radius: 8px;
  box-sizing: border-box;
}
.document-search__input {
  flex: 1;
  min-width: 0;
  height: 32px;
  font-size: 13px;
  color: #384d40;
}
.clear-search {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 21px;
  height: 28px;
  cursor: pointer;
}
.document-table-head,
.document-row {
  display: flex;
  align-items: center;
  gap: 15px;
  padding: 0 22px;
}
.document-table-head {
  height: 42px;
  background: #f8faf9;
  border-top: 1px solid #edf1ee;
  border-bottom: 1px solid #edf1ee;
  font-size: 11px;
  color: #97a39b;
}
.document-row {
  min-height: 86px;
  border-bottom: 1px solid #eff3f0;
  cursor: pointer;
}
.document-row:hover {
  background: #fcfdfc;
}
.document-column--name {
  flex: 1;
  min-width: 0;
}
.document-column--library {
  width: 125px;
  flex-shrink: 0;
}
.document-column--status {
  width: 84px;
  flex-shrink: 0;
}
.document-column--updated {
  width: 145px;
  flex-shrink: 0;
}
.document-column--actions {
  width: 103px;
  flex-shrink: 0;
  text-align: right;
}
.document-name-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}
.document-type {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 36px;
  height: 44px;
  border-radius: 7px;
  background: #f1f5f2;
  color: #6b8677;
}
.document-type text {
  font-size: 7px;
  line-height: 8px;
  font-weight: 650;
  letter-spacing: 0.3px;
}
.document-type--pdf {
  background: #fcf1ed;
  color: #be8170;
}
.document-type--docx {
  background: #eef3fc;
  color: #6a8dbf;
}
.document-type--xlsx {
  background: #edf7f0;
  color: #5b9773;
}
.document-type--text {
  background: #f4f0fb;
  color: #9b82ba;
}
.document-name-copy {
  flex: 1;
  min-width: 0;
}
.document-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 22px;
  font-weight: 500;
}
.document-size {
  display: block;
  font-size: 10px;
  color: #9ba69f;
  margin-top: 3px;
  line-height: 16px;
}
.document-mobile-meta {
  display: none;
}
.library-tag {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: #f4f7f5;
  border-radius: 5px;
  padding: 4px 8px;
  font-size: 11px;
  line-height: 16px;
  color: #7d8f83;
  box-sizing: border-box;
}
.document-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #a7905b;
}
.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.document-status--ready {
  color: #3b8c6a;
}
.document-status--failed,
.document-status--error {
  color: #bb7770;
}
.document-source {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 19px;
  color: #7d8e82;
}
.document-updated {
  display: block;
  font-size: 10px;
  line-height: 18px;
  color: #a1aba5;
}
.document-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.delete-document {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 32px;
}
.document-table-footer {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 44px;
  padding: 9px 22px;
  box-sizing: border-box;
  font-size: 10px;
  line-height: 17px;
  color: #95a198;
  background: #fdfefd;
}
.demo-notice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin-top: 19px;
  font-size: 10px;
  line-height: 18px;
  color: #9aa69e;
}
.documents-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 55px 20px 45px;
  text-align: center;
}
.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 66px;
  height: 66px;
  background: #f2f7f4;
  border-radius: 19px;
  margin-bottom: 18px;
}
.empty-title {
  font-size: 15px;
  line-height: 25px;
  font-weight: 600;
}
.empty-description {
  font-size: 12px;
  line-height: 21px;
  color: #95a198;
  margin: 6px 0 7px;
}
.knowledge-dialog {
  display: flex;
  flex-direction: column;
  max-height: 85vh;
  background: #fff;
  color: #25342e;
}
.dialog-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 24px 25px 20px;
  border-bottom: 1px solid #edf1ee;
}
.dialog-title {
  display: block;
  font-size: 19px;
  line-height: 28px;
  font-weight: 600;
}
.dialog-subtitle {
  display: block;
  font-size: 11px;
  line-height: 19px;
  color: #92a096;
  margin-top: 5px;
}
.dialog-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 28px;
  flex-shrink: 0;
  cursor: pointer;
}
.dialog-scroll {
  flex: 1;
  min-height: 0;
  height: 480px;
  max-height: 55vh;
}
.dialog-body,
.detail-body {
  padding: 22px 25px 17px;
}
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
  margin-bottom: 9px;
}
.target-libraries {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 23px;
}
.target-scope-options {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-bottom: 22px;
}
.target-scope-option {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 13px 14px;
  border: 1px solid #e5ebe7;
  border-radius: 10px;
  color: #8b9b90;
  cursor: pointer;
}
.target-scope-option > view {
  flex: 1;
  min-width: 0;
}
.target-scope-option.is-selected {
  border-color: #8dbda6;
  color: #237b61;
  background: #f3f9f5;
}
.target-scope-title {
  display: block;
  font-size: 12px;
  line-height: 20px;
  font-weight: 600;
}
.target-scope-description {
  display: block;
  font-size: 10px;
  line-height: 18px;
  color: #93a096;
  margin-top: 2px;
}
.edit-library-note {
  display: flex;
  align-items: center;
  gap: 7px;
  border-radius: 8px;
  background: #f5f8f6;
  color: #7a9383;
  padding: 12px;
  margin-bottom: 20px;
  font-size: 12px;
}
.detail-footer-buttons {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-left: auto;
}
.target-library {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 11px;
  color: #86958b;
  border: 1px solid #e5ebe7;
  border-radius: 7px;
  cursor: pointer;
}
.target-library.is-selected {
  color: #237b61;
  border-color: #8dbda6;
  background: #f3f9f5;
}
.entry-modes {
  display: flex;
  gap: 21px;
  border-bottom: 1px solid #e9eee9;
  margin-bottom: 18px;
}
.entry-modes > view {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px 12px;
  font-size: 13px;
  color: #94a095;
  position: relative;
  cursor: pointer;
}
.entry-modes > view.is-active {
  color: #237b61;
  font-weight: 600;
}
.entry-modes > view.is-active:after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: #237b61;
}
.file-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 10px;
  border: 1px dashed #c8dcd0;
  border-radius: 10px;
  background: #fafcfb;
  cursor: pointer;
}
.file-dropzone.is-disabled {
  opacity: 0.6;
}
.upload-symbol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 43px;
  height: 43px;
  background: #edf5f0;
  border-radius: 11px;
  margin-bottom: 10px;
}
.dropzone-title {
  font-size: 13px;
  line-height: 23px;
  color: #527261;
  font-weight: 500;
}
.dropzone-description {
  font-size: 10px;
  line-height: 19px;
  color: #9aa69d;
  margin-top: 3px;
}
.selected-file {
  display: flex;
  align-items: center;
  gap: 9px;
  border-bottom: 1px solid #edf1ee;
  padding: 11px 0;
  font-size: 12px;
}
.selected-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-file-size {
  font-size: 10px;
  color: #9aa59e;
  flex-shrink: 0;
}
.selected-file-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 25px;
  cursor: pointer;
}
.title-input {
  height: 42px;
  border: 1px solid #e1e9e3;
  border-radius: 8px;
  padding: 0 12px;
  box-sizing: border-box;
  font-size: 13px;
  width: 100%;
  color: #334b3c;
}
.content-label {
  margin-top: 18px;
}
.content-input {
  width: 100%;
  height: 136px;
  border: 1px solid #e1e9e3;
  border-radius: 8px;
  padding: 11px 12px;
  box-sizing: border-box;
  font-size: 13px;
  line-height: 22px;
  color: #334b3c;
}
.character-count {
  display: block;
  text-align: right;
  font-size: 10px;
  line-height: 19px;
  color: #a2ada6;
  margin-top: 5px;
}
.form-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #9ba69e;
  font-size: 10px;
  line-height: 18px;
  margin-top: 18px;
}
.form-error {
  display: block;
  font-size: 11px;
  line-height: 19px;
  color: #bb7770;
  margin-top: 12px;
}
.processing-note {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  line-height: 20px;
  color: #237b61;
  margin-top: 16px;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  padding: 17px 25px;
  border-top: 1px solid #edf1ee;
}
.submit-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 55px 24px 60px;
  text-align: center;
}
.success-symbol {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #edf7f0;
  border-radius: 50%;
  width: 63px;
  height: 63px;
  margin-bottom: 19px;
}
.success-title {
  font-size: 18px;
  font-weight: 600;
  line-height: 28px;
}
.success-description {
  font-size: 12px;
  line-height: 23px;
  color: #7f9285;
  margin-top: 8px;
}
.success-notice {
  font-size: 11px;
  line-height: 20px;
  color: #a0aba4;
  margin-top: 8px;
}
.detail-document-heading {
  display: flex;
  align-items: center;
  gap: 13px;
  margin-bottom: 22px;
}
.detail-name {
  flex: 1;
  min-width: 0;
  font-size: 16px;
  line-height: 25px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.detail-metadata {
  padding: 12px 15px;
  border-radius: 9px;
  background: #f7faf8;
}
.detail-metadata > view {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  font-size: 12px;
  line-height: 29px;
}
.detail-metadata > view > text:first-child {
  color: #8e9d92;
  flex-shrink: 0;
}
.detail-metadata > view > text:last-child {
  text-align: right;
}
.detail-metadata .is-ready {
  color: #237b61;
}
.detail-content-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin: 23px 0 12px;
}
.detail-content {
  display: block;
  font-size: 13px;
  line-height: 25px;
  color: #708478;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.detail-footer {
  justify-content: space-between;
}
@media (min-width: 1450px) {
  .knowledge-content {
    padding-top: 42px;
  }
  .library-item {
    min-height: 96px;
    padding: 18px;
  }
  .library-name {
    font-size: 14px;
  }
  .library-description {
    font-size: 11px;
  }
  .library-icon {
    width: 42px;
    height: 43px;
  }
  .library-count {
    font-size: 22px;
  }
  .document-row {
    min-height: 90px;
  }
}
@media (max-width: 1100px) {
  .knowledge-content {
    padding: 28px 25px;
  }
  .library-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .document-column--updated {
    width: 122px;
  }
  .document-column--library {
    width: 105px;
  }
  .document-table-head,
  .document-row {
    gap: 10px;
    padding-left: 18px;
    padding-right: 18px;
  }
  .document-column--actions {
    width: 97px;
  }
}
@media (max-width: 767px) {
  .knowledge-content {
    padding: 24px 17px;
  }
  .page-heading {
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 25px;
  }
  .eyebrow {
    font-size: 9px;
    margin-bottom: 5px;
  }
  .page-title {
    font-size: 24px;
    line-height: 34px;
  }
  .page-description {
    max-width: 230px;
    font-size: 11px;
    line-height: 20px;
    margin-top: 6px;
  }
  .page-heading :deep(.wd-button) {
    height: 36px !important;
    font-size: 12px !important;
    padding: 0 12px !important;
    margin-top: 20px;
  }
  .section-label {
    font-size: 13px;
  }
  .permission-hint {
    font-size: 9px;
    gap: 3px;
  }
  .scope-tabs {
    width: 100%;
    box-sizing: border-box;
    gap: 3px;
    padding: 4px;
  }
  .scope-tab {
    flex: 1;
    justify-content: center;
    padding: 9px 5px;
    font-size: 12px;
    gap: 6px;
  }
  .scope-tab-count {
    font-size: 9px;
  }
  .scope-explanation {
    align-items: flex-start;
    margin: 11px 0 21px;
    font-size: 10px;
  }
  .library-name-line {
    gap: 3px;
  }
  .library-name-line .scope-badge {
    font-size: 8px;
    padding: 0 3px;
  }
  .document-title-line {
    gap: 5px;
  }
  .scope-badge {
    font-size: 8px;
  }
  .target-scope-description {
    font-size: 9px;
  }
  .library-list {
    gap: 8px;
  }
  .library-item {
    min-height: 77px;
    gap: 8px;
    padding: 11px 10px;
    border-radius: 10px;
  }
  .library-icon {
    width: 30px;
    height: 34px;
    border-radius: 8px;
  }
  .library-name {
    font-size: 12px;
    line-height: 20px;
  }
  .library-description {
    font-size: 9px;
    line-height: 15px;
    margin-top: 1px;
  }
  .library-count {
    font-size: 17px;
  }
  .documents-section {
    margin-top: 22px;
    border-radius: 12px;
  }
  .documents-toolbar {
    padding: 16px 14px;
    flex-direction: column;
    align-items: stretch;
    gap: 13px;
  }
  .documents-title {
    font-size: 14px;
    gap: 8px;
  }
  .result-count {
    font-size: 10px;
  }
  .document-search {
    width: 100%;
    height: 36px;
  }
  .document-table-head {
    display: none;
  }
  .document-row {
    position: relative;
    padding: 16px 13px;
    gap: 9px;
    min-height: 90px;
    flex-wrap: wrap;
    align-items: center;
  }
  .document-column--name {
    flex: 1;
    width: calc(100% - 77px);
  }
  .document-column--library,
  .document-column--updated {
    display: none;
  }
  .document-name-cell {
    gap: 10px;
  }
  .document-type {
    width: 32px;
    height: 40px;
  }
  .document-name {
    font-size: 12px;
    line-height: 21px;
  }
  .document-size {
    display: none;
  }
  .document-mobile-meta {
    display: block;
    font-size: 9px;
    line-height: 18px;
    color: #9da79f;
    margin-top: 3px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .document-column--status {
    width: 67px;
  }
  .document-status {
    font-size: 10px;
    gap: 4px;
    justify-content: flex-end;
  }
  .document-column--actions {
    display: none;
  }
  .document-table-footer {
    padding: 11px 14px;
    font-size: 9px;
    line-height: 17px;
  }
  .demo-notice {
    margin-top: 14px;
    font-size: 9px;
  }
  .dialog-heading {
    padding: 21px 19px 17px;
  }
  .dialog-title {
    font-size: 17px;
  }
  .dialog-subtitle {
    font-size: 10px;
    line-height: 18px;
  }
  .dialog-body,
  .detail-body {
    padding: 19px;
  }
  .dialog-footer {
    padding: 14px 19px;
  }
  .target-libraries {
    gap: 6px;
    margin-bottom: 20px;
  }
  .target-library {
    font-size: 10px;
    padding: 7px 8px;
  }
  .form-notice {
    font-size: 9px;
    align-items: flex-start;
  }
  .dialog-scroll {
    max-height: 52vh;
  }
  .documents-empty {
    padding: 40px 16px;
  }
  .empty-description {
    font-size: 11px;
  }
  .detail-metadata > view {
    font-size: 11px;
  }
}
</style>
