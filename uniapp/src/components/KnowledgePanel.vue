<template>
  <view class="knowledge-panel">
    <scroll-view scroll-y class="knowledge-scroll" :show-scrollbar="false">
      <view class="knowledge-content">
        <view class="page-heading">
          <view class="page-heading__copy">
            <text class="page-title">知识资料</text>
          </view>
          <view class="page-actions">
            <view class="page-action">
              <wd-button block plain @click="openLibrary">新建知识库</wd-button>
            </view>
            <view class="page-action">
              <wd-button
                block
                icon="add"
                :disabled="!uploadLibraries.length"
                @click="openAdd"
              >
                新增资料
              </wd-button>
            </view>
            <wd-button
              type="icon"
              icon="refresh"
              aria-label="刷新知识资料"
              :loading="loading"
              :disabled="loading"
              @click="refresh"
            />
          </view>
        </view>
        <text v-if="error" class="form-error page-error" role="alert">{{ error }}</text>

        <view v-if="changes.length" class="library-section">
          <text class="section-label">{{
            canReview ? "知识变更审批" : "我的变更申请"
          }}</text>
          <view
            v-for="change in changes"
            :key="change.id"
            class="library-item knowledge-approval"
          >
            <view class="library-copy">
              <text class="library-name"
                >{{ changeTitle(change) }} ·
                {{ changeStatusLabel(change.status) }}</text
              >
              <text class="library-description">{{
                changeActionLabel(change.action)
              }}</text>
              <text v-if="change.title" class="library-description"
                >申请名称：{{ change.title }}</text
              >
              <text v-if="change.visibility" class="library-description"
                >申请授权范围：{{
                  change.visibility === "public" ? "企业公有" : "个人私有"
                }}</text
              >
              <text v-if="change.content" class="library-description"
                >申请正文：{{ change.content }}</text
              >
              <text v-if="change.targetUserId" class="library-description"
                >授权用户：{{
                  change.targetUserName || change.targetUserId
                }}</text
              >
              <text v-if="change.reviewNote" class="library-description"
                >审批说明：{{ change.reviewNote }}</text
              >
              <wd-button
                v-if="change.hasOriginal"
                plain
                size="small"
                :disabled="!!reviewing"
                @click="openChangeOriginal(change)"
                >查看待审原件</wd-button
              >
              <wd-button
                v-if="canReview && change.libraryId"
                plain
                size="small"
                :disabled="!!reviewing"
                @click="compareChange(change)"
                >查看当前内容</wd-button
              >
              <template v-if="comparisons[change.id]">
                <text class="library-description"
                  >当前名称：{{
                    comparisons[change.id].title || comparisons[change.id].name
                  }}</text
                >
                <text
                  v-if="comparisons[change.id].content !== undefined"
                  class="library-description"
                  >当前正文：{{ comparisons[change.id].content }}</text
                >
              </template>
              <input
                v-if="
                  canReview &&
                  ['pending', 'conflict', 'failed'].includes(change.status)
                "
                v-model="reviewNotes[change.id]"
                :maxlength="1000"
                class="title-input"
                placeholder="审批说明（选填）"
              />
            </view>
            <template
              v-if="['pending', 'conflict', 'failed'].includes(change.status)"
            >
              <template v-if="canReview"
                ><wd-button
                  size="small"
                  :disabled="!!reviewing"
                  @click="reviewChange(change, 'approve')"
                  >{{
                    change.status === "conflict" ? "处理冲突并批准" : "批准"
                  }}</wd-button
                ><wd-button
                  plain
                  size="small"
                  :disabled="!!reviewing"
                  @click="reviewChange(change, 'reject')"
                  >驳回</wd-button
                ></template
              >
              <wd-button
                v-else
                plain
                size="small"
                :disabled="!!reviewing"
                @click="cancelChange(change)"
                >撤回</wd-button
              >
            </template>
          </view>
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
                >全部获授权知识库</text
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
              <wd-button
                v-if="library.canWrite"
                size="small"
                type="text"
                @click.stop="renameLibrary(library)"
                >更名</wd-button
              >
              <wd-button
                v-if="library.canWrite"
                size="small"
                type="text"
                @click.stop="removeLibrary(library)"
                >删除</wd-button
              >
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
            >文件上传和文字录入遵守同一套知识库授权。</text
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
            @click="!submitting && (addVisible = false)"
            ><wd-icon name="close" size="18px" color="#89968f" /></view
        ></view>
        <scroll-view scroll-y class="dialog-scroll" :show-scrollbar="false">
          <view v-if="submitted" class="submit-success">
            <view class="success-symbol"
              ><wd-icon name="check" size="29px" color="#237b61" /></view
            ><text class="success-title">{{
              approvalPending
                ? "已提交审批"
                : entryMode === "file"
                  ? "资料已收录"
                  : "资料已提交"
            }}</text
            ><text class="success-description"
              >{{ successCount }} 份资料{{
                approvalPending ? "已提交到" : "已加入"
              }}「{{ libraryName(targetLibrary) }}」</text
            ><text class="success-notice">{{
              approvalPending
                ? "管理员批准前，资料不会进入知识检索。"
                : entryMode === "file"
                  ? "已完成解析和索引，可用于问答检索。"
                  : "资料已提交，完成解析和索引后可用于问答。"
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
                    >当前企业用户可读，新增、修改和删除需管理员审批</text
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
            <view v-if="entryMode === 'file'" class="file-upload-region">
              <ChatUpload
                v-if="addVisible"
                :file-types="fileTypes"
                :library-id="targetLibrary"
                :library-name="libraryName(targetLibrary)"
                @busy-change="submitting = $event"
                @uploaded="onUploaded"
                @chat="
                  addVisible = false;
                  emit('chat');
                "
              />
            </view>
            <view v-else class="text-entry"
              ><text class="field-label">知识标题</text
              ><input
                v-model="textTitle"
                :disabled="submitting"
                class="title-input"
                :maxlength="200"
                placeholder="例如：销售订单审核注意事项"
                placeholder-style="color:#a0aaa4;font-size:13px"
              /><text class="field-label content-label">知识内容</text
              ><textarea
                v-model="textContent"
                :disabled="submitting"
                class="content-input"
                :maxlength="100000"
                placeholder="记录业务规则、工作经验或操作步骤…"
                placeholder-style="color:#a0aaa4;font-size:13px"
              /><text class="character-count"
                >{{ textContent.length }} / 100000</text
              ></view
            >
            <view v-if="submitting" class="processing-note"
              ><wd-loading size="16px" color="#237b61" /><text
                >正在提交资料，请稍候…</text
              ></view
            >
            <text v-if="formError" class="form-error">{{ formError }}</text>
            <view class="form-notice"
              ><wd-icon name="info-circle" size="13px" /><text
                >文件上传与文字录入遵守相同权限，处理完成后可用于问答。</text
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
            @click="!submitting && (addVisible = false)"
            >取消</wd-button
          ><wd-button
            v-if="entryMode === 'text' || submitted"
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
                      ? "公有 · 变更需管理员审批"
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
              detailDocument.error ||
              (detailDocument.status === "processing"
                ? "资料正在解析和索引，请稍候。"
                : "暂无可显示的正文。")
            }}</text
            ><view class="form-notice"
              ><wd-icon name="info-circle" size="13px" /><text
                >文件上传和文字录入使用相同的公私权限。</text
              ></view
            ></view
          ></scroll-view
        >
        <view v-if="detailDocument.error" class="form-error">{{
          detailDocument.error
        }}</view>
        <view class="dialog-footer detail-footer"
          ><wd-button
            v-if="canOperate(detailDocument)"
            type="text"
            custom-style="color:#b56b63;font-size:13px;"
            @click="confirmDelete(detailDocument)"
            >删除资料</wd-button
          ><wd-button
            v-if="
              detailDocument.status === 'failed' && canOperate(detailDocument)
            "
            type="text"
            :loading="submitting"
            @click="retryDocument"
            >重试处理</wd-button
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
      :close-on-click-modal="!submitting"
      position="center"
      custom-style="width:calc(100% - 32px);max-width:600px;border-radius:18px;overflow:hidden;"
    >
      <view v-if="editingDocument" class="knowledge-dialog">
        <view class="dialog-heading"
          ><view
            ><text class="dialog-title">编辑资料</text
            ><text class="dialog-subtitle">{{
              documentScope(editingDocument) === "public"
                ? "公有资料的修改需管理员批准，批准前保留当前内容。"
                : "这份私有资料仅你自己可读和维护。"
            }}</text></view
          ><view
            class="dialog-close"
            @click="!submitting && (editVisible = false)"
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
              :maxlength="200"
              placeholder="请输入资料名称"
            />
            <template v-if="editingDocument.type === 'text'"
              ><text class="field-label content-label">知识内容</text
              ><textarea
                v-model="editContent"
                class="content-input"
                :maxlength="100000"
                placeholder="请输入知识内容"
              /><text class="character-count"
                >{{ editContent.length }} / 100000</text
              ></template
            >
            <text v-if="editError" class="form-error">{{ editError }}</text
            ><view class="form-notice"
              ><wd-icon name="info-circle" size="13px" /><text
                >编辑不会改变所属知识库或公私范围。{{
                  documentScope(editingDocument) === "public"
                    ? "本次变更将提交管理员审批。"
                    : editingDocument.type === "text"
                      ? "保存后将重新建立检索索引。"
                      : "本次修改名称，保留已解析的文件正文。"
                }}</text
              ></view
            >
          </view></scroll-view
        >
        <view class="dialog-footer"
          ><wd-button
            type="text"
            custom-style="color:#75887c;"
            @click="!submitting && (editVisible = false)"
            >取消</wd-button
          ><wd-button
            :round="false"
            custom-style="height:40px;border-radius:9px;background:#237b61;border-color:#237b61;"
            :loading="submitting"
            @click="saveEdit"
            >保存修改</wd-button
          ></view
        >
      </view>
    </wd-popup>
    <wd-popup
      v-model="libraryVisible"
      position="center"
      :close-on-click-modal="!submitting"
      custom-style="width:calc(100% - 32px);max-width:540px;border-radius:18px;overflow:hidden;"
    >
      <view class="knowledge-dialog">
        <view class="dialog-heading"
          ><text class="dialog-title">新建知识库</text></view
        >
        <view class="dialog-body">
          <text class="field-label">知识库名称</text
          ><input
            v-model="libraryNameDraft"
            class="title-input"
            :maxlength="80"
            :disabled="submitting"
            placeholder="例如：产品资料、工作笔记"
          />
          <text class="field-label">可见与操作范围</text>
          <view class="target-scope-options">
            <view
              class="target-scope-option"
              :class="{ 'is-selected': libraryScope === 'private' }"
              @click="!submitting && (libraryScope = 'private')"
              ><text>我的私有 · 仅本人可读写</text></view
            >
            <view
              class="target-scope-option"
              :class="{ 'is-selected': libraryScope === 'public' }"
              @click="!submitting && (libraryScope = 'public')"
              ><text>租户公有 · 可读，变更需审批</text></view
            >
          </view>
          <text v-if="formError" class="form-error">{{ formError }}</text>
        </view>
        <view class="dialog-footer"
          ><wd-button
            plain
            :disabled="submitting"
            @click="libraryVisible = false"
            >取消</wd-button
          ><wd-button :loading="submitting" @click="createLibrary"
            >创建</wd-button
          ></view
        >
      </view>
    </wd-popup>
  </view>
</template>

<script setup>
import { computed, inject, onMounted, onUnmounted, ref } from "vue";
import ChatUpload from "./ChatUpload.vue";

defineOptions({ options: { virtualHost: true, styleIsolation: "shared" } });
const api = inject("enterprise-api");
const emit = defineEmits(["count", "chat", "updated"]);
const changes = ref([]),
  canReview = ref(false);
const comparisons = ref({}),
  reviewNotes = ref({}),
  reviewing = ref("");
const libraries = ref([]),
  documents = ref([]),
  fileTypes = ref(null);
const loading = ref(false),
  error = ref("");
const libraryVisible = ref(false),
  libraryNameDraft = ref(""),
  libraryScope = ref("private");
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
const textTitle = ref("");
const textContent = ref("");
const formError = ref("");
const submitting = ref(false);
const submitted = ref(false);
const approvalPending = ref(false);
const successCount = ref(0);
const detailVisible = ref(false);
const detailDocument = ref(null);
const editVisible = ref(false);
const editingDocument = ref(null);
const editTitle = ref("");
const editContent = ref("");
const editError = ref("");
let refreshTimer,
  requestVersion = 0,
  openingVersion = 0;
let disposed = false;

const accessibleLibraries = computed(() => libraries.value);
const accessibleDocuments = computed(() =>
  documents.value.filter((document) =>
    accessibleLibraries.value.some(
      (library) => library.id === document.libraryId
    )
  )
);
const uploadLibraries = computed(() =>
  accessibleLibraries.value.filter((library) => library.canWrite === true)
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
      all: "展示你获授权的全部知识库，操作权限由服务端授权决定。",
      public: "已批准内容可直接读取；资料和整库变更需管理员审批。",
      private: "授权用户可直接查看、上传、修改和删除；顶级管理员拥有全部权限。",
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
  return libraries.value.find((library) => library.id === document.libraryId)
    ?.scope;
}
function canOperate(document) {
  return document?.canWrite === true;
}
function setTargetScope(scope) {
  if (submitting.value) return;
  targetScope.value = scope;
  targetLibrary.value =
    uploadLibraries.value.find((library) => library.scope === scope)?.id || "";
}
function libraryName(id) {
  return libraries.value.find((library) => library.id === id)?.name || "知识库";
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
  return statusLabel(document.status);
}
function formatSize(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function normalized(document) {
  return {
    ...document,
    name: document.title,
    type:
      document.inputType === "text"
        ? "text"
        : document.title.match(/\.([a-z0-9]+)$/i)?.[1] || "file",
    size:
      document.inputType === "text"
        ? "文字知识"
        : document.inputType === "file"
          ? "文件资料"
          : "文字知识",
    owner: document.ownerName || "",
    updatedAt: formatTime(document.updatedAt),
  };
}
function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
async function refresh() {
  const version = ++requestVersion;
  clearTimeout(refreshTimer);
  loading.value = true;
  try {
    const [libResult, docResult, types, approvals] = await Promise.all([
      api.libraries(),
      api.documents(),
      api.fileTypes(),
      api.knowledgeChanges(),
    ]);
    if (disposed || version !== requestVersion) return;
    if (
      !Array.isArray(types.extensions) ||
      !types.extensions.length ||
      !types.extensions.every(
        (value) => typeof value === "string" && /^\.[a-z0-9]+$/.test(value)
      ) ||
      !Number.isFinite(types.maxFileSizeBytes) ||
      types.maxFileSizeBytes <= 0
    )
      throw new Error("服务未返回有效的文件格式，请刷新后重试");
    libraries.value = (libResult.libraries || []).map((library) => ({
      ...library,
      scope: library.visibility,
      description: library.canWrite
        ? "已获知识库读写授权"
        : "已获知识库读取授权",
    }));
    documents.value = (docResult.documents || []).map(normalized);
    fileTypes.value = types;
    changes.value = approvals.changes || [];
    canReview.value = approvals.canReview === true;
    emit("count", documents.value.length);
    emit("updated", { libraries: libraries.value, documents: documents.value });
    error.value = "";
    if (detailVisible.value && detailDocument.value) {
      const updated = documents.value.find(
        (document) => document.id === detailDocument.value.id
      );
      if (updated && updated.status !== detailDocument.value.status)
        await openDetail(updated);
    }
    if (documents.value.some((document) => document.status === "processing"))
      refreshTimer = setTimeout(refresh, 2500);
  } catch (failure) {
    if (!disposed && version === requestVersion) error.value = failure.message;
  } finally {
    if (!disposed && version === requestVersion) loading.value = false;
  }
}
function openLibrary() {
  if (submitting.value) return;
  libraryNameDraft.value = "";
  libraryScope.value = "private";
  formError.value = "";
  libraryVisible.value = true;
}
async function createLibrary() {
  if (submitting.value) return;
  if (!libraryNameDraft.value.trim())
    return void (formError.value = "请填写知识库名称");
  submitting.value = true;
  formError.value = "";
  try {
    const result = await api.createLibrary({
      name: libraryNameDraft.value.trim(),
      visibility: libraryScope.value,
    });
    if (disposed) return;
    libraryVisible.value = false;
    mutationNotice(result);
    await refresh();
  } catch (failure) {
    if (!disposed) formError.value = failure.message;
  } finally {
    if (!disposed) submitting.value = false;
  }
}
function openAdd() {
  if (!uploadLibraries.value.length) return;
  setTargetScope(
    uploadLibraries.value.some((library) => library.scope === "private")
      ? "private"
      : "public"
  );
  entryMode.value = "file";
  textTitle.value = "";
  textContent.value = "";
  formError.value = "";
  submitted.value = false;
  approvalPending.value = false;
  successCount.value = 0;
  addVisible.value = true;
}
async function onUploaded(result) {
  successCount.value += result.count;
  if (result.files?.some((file) => file.result?.approvalRequired)) {
    approvalPending.value = true;
    uni.showToast({ title: "公有资料已提交审批", icon: "none" });
  }
  await refresh();
}
async function submitDocument() {
  if (submitting.value || entryMode.value !== "text") return;
  formError.value = "";
  if (
    !targetLibraries.value.some((library) => library.id === targetLibrary.value)
  )
    return void (formError.value = "请选择知识分类");
  if (!textTitle.value.trim() || !textContent.value.trim())
    return void (formError.value = "请填写知识标题和内容");
  submitting.value = true;
  try {
    const result = await api.createDocument({
      libraryId: targetLibrary.value,
      title: textTitle.value.trim(),
      content: textContent.value.trim(),
    });
    if (disposed) return;
    mutationNotice(result);
    submitted.value = true;
    approvalPending.value = result.approvalRequired === true;
    successCount.value = 1;
    selectedScope.value = targetScope.value;
    selectedLibrary.value = targetLibrary.value;
    search.value = "";
    await refresh();
  } catch (failure) {
    if (!disposed) formError.value = failure.message;
  } finally {
    if (!disposed) submitting.value = false;
  }
}
async function openDetail(document) {
  if (!accessibleDocuments.value.some((item) => item.id === document?.id))
    return;
  const version = ++openingVersion;
  try {
    const result = await api.document(document.id);
    if (disposed || version !== openingVersion) return;
    detailDocument.value = normalized(result.document);
    detailVisible.value = true;
  } catch (failure) {
    if (!disposed && version === openingVersion) error.value = failure.message;
  }
}
function confirmDelete(document) {
  if (!canOperate(document) || submitting.value) return;
  uni.showModal({
    title: "删除知识资料",
    content:
      documentScope(document) === "public"
        ? `确定申请删除「${document.name}」？管理员批准前继续使用当前资料。`
        : `确定删除「${document.name}」？资料将不再用于后续问答检索。`,
    confirmText: "删除",
    confirmColor: "#b56b63",
    async success(result) {
      if (!result.confirm || disposed || !canOperate(document)) return;
      submitting.value = true;
      try {
        const changed = await api.deleteDocument(document.id);
        mutationNotice(changed);
        if (disposed) return;
        if (detailDocument.value?.id === document.id)
          detailVisible.value = false;
        await refresh();
      } catch (failure) {
        if (!disposed) error.value = failure.message;
      } finally {
        if (!disposed) submitting.value = false;
      }
    },
  });
}
async function openEdit(document) {
  if (!canOperate(document) || submitting.value) return;
  const version = ++openingVersion;
  try {
    const result = await api.document(document.id);
    if (disposed || version !== openingVersion) return;
    editingDocument.value = normalized(result.document);
    editTitle.value = result.document.title || "";
    editContent.value = result.document.content || "";
    editError.value = "";
    detailVisible.value = false;
    editVisible.value = true;
  } catch (failure) {
    if (!disposed && version === openingVersion) error.value = failure.message;
  }
}
async function saveEdit() {
  if (submitting.value || !canOperate(editingDocument.value)) return;
  if (!editTitle.value.trim() || !editContent.value.trim())
    return void (editError.value = "请填写资料名称和知识内容");
  submitting.value = true;
  try {
    const result = await api.updateDocument(editingDocument.value.id, {
      title: editTitle.value.trim(),
      content: editContent.value.trim(),
    });
    if (disposed) return;
    editVisible.value = false;
    mutationNotice(result);
    await refresh();
  } catch (failure) {
    if (!disposed) editError.value = failure.message;
  } finally {
    if (!disposed) submitting.value = false;
  }
}
async function retryDocument() {
  if (submitting.value || !canOperate(detailDocument.value)) return;
  submitting.value = true;
  try {
    const result = await api.retryDocument(detailDocument.value.id);
    if (disposed) return;
    if (result.document) detailDocument.value = normalized(result.document);
    mutationNotice(result);
    await refresh();
  } catch (failure) {
    if (!disposed) error.value = failure.message;
  } finally {
    if (!disposed) submitting.value = false;
  }
}
function mutationNotice(result) {
  if (result?.approvalRequired)
    uni.showToast({ title: "已提交管理员审批", icon: "none" });
}
async function renameLibrary(library) {
  const result = await new Promise((resolve) =>
    uni.showModal({
      title: "知识库更名",
      editable: true,
      placeholderText: library.name,
      success: resolve,
    })
  );
  if (!result.confirm || !result.content?.trim()) return;
  try {
    mutationNotice(
      await api.updateLibrary(library.id, { name: result.content.trim() })
    );
    await refresh();
  } catch (failure) {
    error.value = failure.message;
  }
}
async function removeLibrary(library) {
  const result = await new Promise((resolve) =>
    uni.showModal({
      title: "删除知识库",
      content: `删除“${library.name}”及其资料？公有库需管理员审批。`,
      success: resolve,
    })
  );
  if (!result.confirm) return;
  try {
    const changed = await api.deleteLibrary(library.id);
    mutationNotice(changed);
    if (!changed.approvalRequired) selectedLibrary.value = "all";
    await refresh();
  } catch (failure) {
    error.value = failure.message;
  }
}
async function reviewChange(change, decision) {
  if (reviewing.value) return;
  let resolveConflict = false;
  if (change.status === "conflict" && decision === "approve") {
    if (!comparisons.value[change.id]) return compareChange(change);
    const result = await new Promise((resolve) =>
      uni.showModal({
        title: "处理冲突",
        content: "申请基于旧版本，是否按当前版本明确批准覆盖？",
        success: resolve,
      })
    );
    if (!result.confirm) return;
    resolveConflict = true;
  }
  reviewing.value = change.id;
  error.value = "";
  try {
    await api.reviewKnowledge(change.id, {
      decision,
      resolveConflict,
      note: reviewNotes.value[change.id] || "",
    });
    await refresh();
  } catch (failure) {
    await refresh();
    error.value = failure.message;
  } finally {
    reviewing.value = "";
  }
}
async function cancelChange(change) {
  if (reviewing.value) return;
  reviewing.value = change.id;
  try {
    await api.cancelKnowledge(change.id);
    await refresh();
  } catch (failure) {
    error.value = failure.message;
  } finally {
    reviewing.value = "";
  }
}
async function compareChange(change) {
  if (reviewing.value) return;
  reviewing.value = change.id;
  try {
    const current = change.documentId
      ? (await api.document(change.documentId)).document
      : libraries.value.find((library) => library.id === change.libraryId);
    if (!current)
      throw new Error("当前资源不存在，请驳回申请或刷新后重新审核。");
    comparisons.value = { ...comparisons.value, [change.id]: current };
  } catch (failure) {
    error.value = failure.message;
  } finally {
    reviewing.value = "";
  }
}
async function openChangeOriginal(change) {
  if (reviewing.value) return;
  reviewing.value = change.id;
  try {
    await api.openKnowledgeOriginal(change.id);
  } catch (failure) {
    error.value = failure.message;
  } finally {
    reviewing.value = "";
  }
}
function changeTitle(change) {
  return (
    change.title ||
    documents.value.find((document) => document.id === change.documentId)
      ?.name ||
    libraries.value.find((library) => library.id === change.libraryId)?.name ||
    "知识变更"
  );
}
function changeActionLabel(action) {
  return (
    {
      "library.create": "新建知识库",
      "library.update": "知识库更名",
      "library.delete": "删除知识库",
      "library.grants": "调整知识授权",
      "document.create": "新增资料",
      "document.update": "修改资料",
      "document.replace": "替换文件",
      "document.reindex": "重建索引",
      "document.delete": "删除资料",
    }[action] || "知识变更"
  );
}
function changeStatusLabel(status) {
  return (
    {
      pending: "待审批",
      processing: "发布中",
      approved: "已批准",
      rejected: "已驳回",
      conflict: "存在冲突",
      failed: "发布失败",
      cancelled: "已撤回",
    }[status] || status
  );
}
onMounted(refresh);
onUnmounted(() => {
  disposed = true;
  requestVersion += 1;
  openingVersion += 1;
  clearTimeout(refreshTimer);
});
defineExpose({ refresh });
</script>

<style scoped>
.file-upload-region {
  height: 460px;
  display: flex;
  min-height: 0;
}
.knowledge-approval {
  flex-wrap: wrap;
  align-items: flex-start;
}
.knowledge-approval .library-copy {
  flex-basis: 100%;
}
.knowledge-approval .library-description {
  white-space: pre-wrap;
  overflow: visible;
  overflow-wrap: anywhere;
  font-size: 12px;
}
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
.page-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.page-action {
  min-width: 120px;
}
.page-error {
  display: block;
  margin: -12px 0 18px;
}
.page-title {
  font-size: 28px;
  font-weight: 650;
  line-height: 39px;
  letter-spacing: 0.3px;
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
    padding: 16px;
  }
  .page-heading {
    margin-bottom: 18px;
  }
  .page-heading__copy {
    display: none;
  }
  .page-actions {
    width: 100%;
    gap: 8px;
  }
  .page-action {
    flex: 1;
    min-width: 0;
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
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }
  .library-item {
    min-height: 68px;
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
