import { useCallback, useEffect, useState } from "react";
import { PushPin } from "@phosphor-icons/react";
import { api, downloadDocument, downloadResource } from "@/models/platform";
import { useTranslation } from "react-i18next";
import usePolling from "@/hooks/usePolling";
import LiveDocumentSync from "@/models/experimental/liveSync";
import UploadFile from "@/components/Modals/ManageWorkspace/Documents/UploadFile";
import DataConnectors from "@/components/Modals/ManageWorkspace/DataConnectors";
import useUploadQueue from "@/components/Modals/ManageWorkspace/Documents/hooks/useUploadQueue";
import {
  Button,
  dateLabel,
  DocumentViewer,
  Empty,
  Field,
  Icon,
  Modal,
  Notice,
  Scope,
  Status,
} from "@/components/lib/PlatformUI";

export default function Knowledge({ session }) {
  const platform = session?.identity === "platform";
  const endpoint = (route) =>
    platform && route !== "/file-types" ? `/platform${route}` : route;
  const knowledgeApi = (route, options) => api(endpoint(route), options);
  const [changes, setChanges] = useState([]);
  const [canReview, setCanReview] = useState(false);
  const [comparisons, setComparisons] = useState({});
  const [reviewNotes, setReviewNotes] = useState({});
  const [tenantId, setTenantId] = useState("");
  const [privateUserId, setPrivateUserId] = useState("");
  const [tenants, setTenants] = useState([]);
  const [tenantUsers, setTenantUsers] = useState([]);
  const [watchedIds, setWatchedIds] = useState([]);
  const [watchUsers, setWatchUsers] = useState([]);
  const [watchUserId, setWatchUserId] = useState("");
  useEffect(() => {
    if (!platform) return;
    api("/platform/tenants")
      .then((result) => setTenants(result.tenants || []))
      .catch((err) => setError(err.message));
  }, [platform]);
  useEffect(() => {
    if (!platform || !tenantId) return;
    const controller = new AbortController();
    setPrivateUserId("");
    api(`/platform/tenants/${tenantId}/users`, { signal: controller.signal })
      .then((result) => setTenantUsers(result.users || []))
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      });
    return () => controller.abort();
  }, [platform, tenantId]);
  const pendingText = "变更已提交管理员审批，批准前继续使用已发布内容。";

  const { t } = useTranslation();
  const [fileTypes, setFileTypes] = useState(null);
  const [fileTypeError, setFileTypeError] = useState(false);
  const [fileTypeRequest, setFileTypeRequest] = useState(0);
  const [libraries, setLibraries] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [scope, setScope] = useState("all");
  const [libraryId, setLibraryId] = useState("");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(null);
  const [modalError, setModalError] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(null);
  const [form, setForm] = useState({
    name: "",
    visibility: "public",
    title: "",
    content: "",
    libraryId: "",
  });
  const uploadQueue = useUploadQueue({
    ready: !!fileTypes,
    multiple: modal?.type !== "replace",
    validate: (file) => {
      if (!fileTypes) return t("enterprise:files.unavailable");
      if (file.size > fileTypes.maxFileSizeBytes)
        return t("enterprise:files.tooLarge", {
          size: fileTypes.maxFileSizeBytes / 1024 / 1024,
        });
      return "";
    },
    uploadFile: (file, destination, signal) => {
      const body = new FormData();
      if (destination.libraryId)
        body.append("libraryId", destination.libraryId);
      body.append("file", file);
      return knowledgeApi(
        destination.replaceId
          ? `/documents/${destination.replaceId}/replace`
          : "/documents/upload",
        { method: "POST", body, signal }
      );
    },
  });

  const refresh = useCallback(
    async (initial = false) => {
      if (initial) setLoading(true);
      try {
        const [libs, docs, approvals] = await Promise.all([
          knowledgeApi("/libraries"),
          knowledgeApi("/documents"),
          knowledgeApi("/knowledge-changes"),
        ]);
        setLibraries(libs.libraries || []);
        setDocuments(docs.documents || []);
        if ((docs.documents || []).some((doc) => doc.canWatch)) {
          const queues = await LiveDocumentSync.queues();
          setWatchedIds(queues.map((queue) => queue.documentId));
        } else setWatchedIds([]);
        setChanges(approvals.changes || []);
        setCanReview(approvals.canReview === true);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [platform]
  );
  useEffect(() => {
    refresh(true);
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setFileTypeError(false);
    api("/file-types", { signal: controller.signal })
      .then((result) => {
        if (
          !Array.isArray(result.extensions) ||
          !result.extensions.length ||
          !Number.isFinite(result.maxFileSizeBytes)
        )
          throw new Error("Invalid file types");
        if (!controller.signal.aborted) setFileTypes(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFileTypeError(true);
      });
    return () => controller.abort();
  }, [fileTypeRequest]);
  const processing = documents.some((doc) => doc.status === "processing");
  usePolling(refresh, 3000, processing);
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(""), 6000);
    return () => clearTimeout(timer);
  }, [success]);

  function open(type) {
    setModalError("");
    uploadQueue.clear();
    const available = libraries.filter(
      (lib) => scope === "all" || lib.visibility === scope
    );
    const selected =
      available.find((lib) => String(lib.id) === String(libraryId)) ||
      available[0];
    setForm({
      name: "",
      visibility: scope === "private" ? "private" : "public",
      title: "",
      content: "",
      libraryId: selected?.id || "",
    });
    setModal({
      type: type !== "library" && !selected ? "library" : type,
      needsLibrary: type !== "library" && !selected,
    });
  }
  const close = () => {
    if (!busy && !uploadQueue.busy) {
      uploadQueue.clear();
      setModal(null);
    }
  };
  const change = (key) => (event) =>
    setForm({ ...form, [key]: event.target.value });
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setModalError("");
    try {
      if (modal.type === "library") {
        const result = await knowledgeApi("/libraries", {
          method: "POST",
          body: {
            name: form.name.trim(),
            visibility: form.visibility,
            ...(platform ? { tenantId, userId: privateUserId } : {}),
          },
        });
        if (result.library) setLibraryId(result.library.id);
        setScope(form.visibility);
        setSuccess(
          result.approvalRequired
            ? pendingText
            : "知识库已创建，可以开始录入资料。"
        );
      } else if (modal.type === "upload" || modal.type === "replace") {
        if (!uploadQueue.files.length)
          throw new Error("请先选择需要上传的文件。");
        if (!fileTypes) throw new Error(t("enterprise:files.unavailable"));
        const result = await uploadQueue.uploadAll(
          modal.type === "replace"
            ? { replaceId: modal.doc.id }
            : { libraryId: form.libraryId }
        );
        await refresh();
        const errors = [...result.rejected, ...result.failures];
        if (errors.length) throw new Error(errors.join("；"));
        setSuccess(
          "文件已提交；公有库资料等待管理员审批，私有库资料自动建立索引。"
        );
        uploadQueue.clear();
      } else if (modal.type === "edit") {
        const body = { title: form.title.trim() };
        if (form.content !== (modal.doc.content || ""))
          body.content = form.content;
        const result = await knowledgeApi(`/documents/${modal.doc.id}`, {
          method: "PATCH",
          body,
        });
        setSuccess(
          result.approvalRequired
            ? pendingText
            : "资料已保存，内容变更后将自动更新索引。"
        );
      } else {
        const result = await knowledgeApi("/documents", {
          method: "POST",
          body: {
            libraryId: form.libraryId,
            title: form.title.trim(),
            content: form.content.trim(),
          },
        });
        setSuccess(
          result.approvalRequired
            ? pendingText
            : "文字资料已录入，正在建立检索索引。"
        );
      }
      setModal(null);
      await refresh();
    } catch (err) {
      setModalError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function detail(doc, edit = false) {
    setWorking(doc.id);
    setError("");
    try {
      const result = await knowledgeApi(`/documents/${doc.id}`);
      if (edit) {
        setForm({
          title: result.document.title,
          content: result.document.content || "",
        });
        setModalError("");
      }
      setModal({ type: edit ? "edit" : "view", doc: result.document });
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }
  async function remove(doc) {
    if (
      !window.confirm(
        `确定删除“${doc.title}”？删除后将无法在问答中检索到此资料。`
      )
    )
      return;
    setWorking(doc.id);
    setError("");
    try {
      const result = await knowledgeApi(`/documents/${doc.id}`, {
        method: "DELETE",
      });
      setSuccess(result.approvalRequired ? pendingText : "资料已删除。");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }
  async function pin(doc) {
    setWorking(doc.id);
    setError("");
    try {
      const result = await knowledgeApi(`/documents/${doc.id}`, {
        method: "PATCH",
        body: { pinned: !doc.pinned },
      });
      setSuccess(
        result.approvalRequired
          ? pendingText
          : doc.pinned
            ? "已取消固定资料。"
            : "资料已固定，将在问答时作为上下文使用。"
      );
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking(null);
    }
  }
  async function retry(doc) {
    setWorking(doc.id);
    setError("");
    try {
      const result = await knowledgeApi(`/documents/${doc.id}/retry`, {
        method: "POST",
      });
      setSuccess(
        result.approvalRequired
          ? pendingText
          : "已提交重新处理，请稍候查看状态。"
      );
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }
  async function download(doc) {
    setWorking(doc.id);
    try {
      await downloadDocument(doc.id, doc.title, { platform });
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }
  async function setWatch(doc, userId) {
    setWorking(doc.id);
    try {
      const enabled = !watchedIds.includes(doc.id);
      if (
        !(await LiveDocumentSync.setWatchStatusForDocument(
          doc.id,
          enabled,
          userId
        ))
      )
        throw new Error("无法更新文档同步状态，请检查资料权限或同步配置。");
      setModal(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }
  async function toggleWatch(doc) {
    if (!platform || watchedIds.includes(doc.id)) return setWatch(doc);
    try {
      const result = await api(`/platform/tenants/${doc.tenantId}/users`);
      setWatchUsers(
        (result.users || []).filter((user) => user.status === "active")
      );
      setWatchUserId("");
      setModal({ type: "watch", doc });
    } catch (err) {
      setError(err.message);
    }
  }
  async function review(change, decision) {
    const conflict = change.status === "conflict";
    if (conflict && decision === "approve" && !comparisons[change.id]) {
      await compareChange(change);
      return;
    }
    if (
      conflict &&
      decision === "approve" &&
      !window.confirm("此申请基于旧版本，是否按当前版本明确批准覆盖？")
    )
      return;
    setWorking(change.id);
    setError("");
    try {
      await knowledgeApi(`/knowledge-changes/${change.id}/review`, {
        method: "POST",
        body: {
          decision,
          resolveConflict: conflict,
          note: reviewNotes[change.id] || "",
        },
      });
      setSuccess(
        decision === "approve" ? "审批通过，变更已发布。" : "已驳回申请。"
      );
      await refresh();
    } catch (err) {
      setError(err.message);
      await refresh();
    } finally {
      setWorking(null);
    }
  }
  async function compareChange(change) {
    setWorking(change.id);
    setError("");
    try {
      const current = change.documentId
        ? (await knowledgeApi(`/documents/${change.documentId}`)).document
        : libraries.find((library) => library.id === change.libraryId);
      if (!current)
        throw new Error("当前资源不存在，请驳回申请或刷新后重新审核。");
      setComparisons((values) => ({ ...values, [change.id]: current }));
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(null);
    }
  }
  function changeTitle(change) {
    return (
      change.title ||
      documents.find((doc) => doc.id === change.documentId)?.title ||
      libraries.find((library) => library.id === change.libraryId)?.name ||
      "知识库"
    );
  }
  async function manageLibrary(action) {
    if (!selectedLibrary) return;
    try {
      let result;
      if (action === "rename") {
        const name = window.prompt("知识库名称", selectedLibrary.name);
        if (!name?.trim()) return;
        result = await knowledgeApi(`/libraries/${selectedLibrary.id}`, {
          method: "PATCH",
          body: { name },
        });
      } else if (action === "delete") {
        if (!window.confirm("删除整个知识库及其资料？公有库将提交审批。"))
          return;
        result = await knowledgeApi(`/libraries/${selectedLibrary.id}`, {
          method: "DELETE",
        });
        if (!result.approvalRequired) setLibraryId("");
      } else {
        const visibility =
          selectedLibrary.visibility === "public" ? "private" : "public";
        let userId;
        if (visibility === "private") {
          userId = session?.user?.id;
          if (platform) {
            const result = await api(
              `/platform/tenants/${selectedLibrary.tenantId}/users`
            );
            setTenantUsers(
              (result.users || []).filter((user) => user.status === "active")
            );
            setPrivateUserId("");
            setModal({ type: "grants", library: selectedLibrary });
            return;
          }
          if (!userId) throw new Error("请重新登录后调整知识授权。");
        }
        if (
          !window.confirm(
            `将知识库改为${visibility === "public" ? "公有" : "私有"}？变更需管理员审批。`
          )
        )
          return;
        result = await knowledgeApi(`/libraries/${selectedLibrary.id}/grants`, {
          method: "PUT",
          body: { visibility, userId },
        });
      }
      setSuccess(result.approvalRequired ? pendingText : "知识库已更新。");
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }
  const visibleLibraries = libraries.filter(
    (lib) => scope === "all" || lib.visibility === scope
  );
  const rows = documents.filter(
    (doc) =>
      (scope === "all" || doc.visibility === scope) &&
      (!libraryId || String(doc.libraryId) === String(libraryId)) &&
      (!search.trim() || doc.title.toLowerCase().includes(search.toLowerCase()))
  );
  const selectedLibrary = libraries.find(
    (lib) => String(lib.id) === String(libraryId)
  );
  return (
    <>
      <Notice onClose={() => setError("")}>{error}</Notice>
      <Notice type="success" onClose={() => setSuccess("")}>
        {success}
      </Notice>
      {platform && (
        <div className="mb-4 flex gap-3 text-sm">
          <Field label="新建库所属企业">
            <select
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            >
              <option value="">请选择企业</option>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="私有库授权用户">
            <select
              value={privateUserId}
              onChange={(e) => setPrivateUserId(e.target.value)}
            >
              <option value="">请选择用户</option>
              {tenantUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name || user.username}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {changes.length > 0 && (
        <section className="mb-5 rounded-lg border border-theme-sidebar-border bg-theme-bg-secondary p-4">
          <h2 className="mb-3 font-medium">
            {canReview ? "知识变更审批" : "我的知识变更申请"}
          </h2>
          <p className="mb-3 text-xs text-theme-text-secondary">
            公有库读取已批准内容；待审变更不会影响现有内容。冲突由管理员处理。
          </p>
          {changes.map((item) => (
            <details
              key={item.id}
              className="border-t border-theme-sidebar-border py-3 text-sm"
            >
              <summary>
                {changeTitle(item)} · {changeActionLabel(item.action)} ·{" "}
                {changeStatusLabel(item.status)}
              </summary>
              {item.title && <p className="mt-2">申请名称：{item.title}</p>}
              {item.visibility && (
                <p className="mt-2">
                  申请授权范围：
                  {item.visibility === "public" ? "企业公有" : "个人私有"}
                </p>
              )}
              {item.targetUserId && (
                <p className="mt-2">
                  授权用户：{item.targetUserName || item.targetUserId}
                </p>
              )}
              {item.content && (
                <p className="mt-2 whitespace-pre-wrap text-theme-text-secondary">
                  申请正文：{item.content}
                </p>
              )}
              {item.reviewNote && (
                <p className="mt-2 whitespace-pre-wrap text-theme-text-secondary">
                  审批说明：{item.reviewNote}
                </p>
              )}
              {canReview && item.libraryId && (
                <Button
                  variant="secondary"
                  disabled={working === item.id}
                  onClick={() => compareChange(item)}
                >
                  查看当前内容
                </Button>
              )}
              {comparisons[item.id] && (
                <div className="mt-3 whitespace-pre-wrap text-theme-text-secondary">
                  <p>
                    当前名称：
                    {comparisons[item.id].title || comparisons[item.id].name}
                  </p>
                  {comparisons[item.id].content !== undefined && (
                    <p>当前正文：{comparisons[item.id].content}</p>
                  )}
                </div>
              )}
              {item.hasOriginal && (
                <a
                  className="mr-3 text-primary-button"
                  href="#"
                  onClick={async (e) => {
                    e.preventDefault();
                    try {
                      await downloadResource(
                        endpoint(`/knowledge-changes/${item.id}/download`),
                        item.title || "待审原件"
                      );
                    } catch (err) {
                      setError(err.message);
                    }
                  }}
                >
                  下载待审原件
                </a>
              )}
              {canReview &&
                ["pending", "conflict", "failed"].includes(item.status) && (
                  <div className="mt-3">
                    <Field label={`审批说明 ${changeTitle(item)}`}>
                      <input
                        value={reviewNotes[item.id] || ""}
                        maxLength={1000}
                        onChange={(event) =>
                          setReviewNotes((values) => ({
                            ...values,
                            [item.id]: event.target.value,
                          }))
                        }
                        placeholder="可填写批准或驳回原因"
                      />
                    </Field>
                    <div className="mt-3 flex gap-3">
                      <Button
                        disabled={working === item.id}
                        onClick={() => review(item, "approve")}
                      >
                        {item.status === "conflict" ? "处理冲突并批准" : "批准"}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={working === item.id}
                        onClick={() => review(item, "reject")}
                      >
                        驳回
                      </Button>
                    </div>
                  </div>
                )}
              {!canReview &&
                ["pending", "conflict", "failed"].includes(item.status) && (
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await knowledgeApi(`/knowledge-changes/${item.id}`, {
                          method: "DELETE",
                        });
                        await refresh();
                      } catch (err) {
                        setError(err.message);
                      }
                    }}
                  >
                    撤回
                  </Button>
                )}
            </details>
          ))}
        </section>
      )}
      {selectedLibrary && (
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-0 break-all">{selectedLibrary.name}</span>
          <Button variant="secondary" onClick={() => manageLibrary("rename")}>
            改名
          </Button>
          <Button variant="secondary" onClick={() => manageLibrary("grants")}>
            调整授权
          </Button>
          <Button variant="secondary" onClick={() => manageLibrary("delete")}>
            删除知识库
          </Button>
        </div>
      )}
      <div className="grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-[200px_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-lg border border-theme-sidebar-border bg-theme-bg-secondary p-3">
          <div className="mb-3 flex items-center justify-between px-2 text-sm font-medium">
            <strong>知识库</strong>
            <button
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-theme-text-secondary hover:bg-theme-action-menu-item-hover hover:text-theme-text-primary disabled:opacity-50"
              onClick={() => open("library")}
              title="新建知识库"
              aria-label="新建知识库"
            >
              <Icon name="plus" size={18} />
            </button>
          </div>
          <div className="flex gap-1 overflow-auto xl:max-h-[420px] xl:flex-col [&>button]:flex [&>button]:shrink-0 [&>button]:items-center [&>button]:gap-2 [&>button]:rounded-lg [&>button]:px-3 [&>button]:py-2.5 [&>button]:text-left [&>button]:text-sm [&>button]:text-theme-text-secondary [&>button:hover]:bg-theme-sidebar-item-hover [&_span]:max-w-[150px] [&_span]:flex-1 [&_span]:truncate [&_small]:text-xs">
            <button
              className={
                !libraryId
                  ? "bg-theme-sidebar-item-selected text-theme-text-primary"
                  : ""
              }
              onClick={() => setLibraryId("")}
            >
              <Icon name="books" size={18} />
              <span>全部资料</span>
              <small>
                {
                  documents.filter(
                    (doc) => scope === "all" || doc.visibility === scope
                  ).length
                }
              </small>
            </button>
            {visibleLibraries.map((lib) => (
              <button
                key={lib.id}
                className={
                  String(lib.id) === String(libraryId)
                    ? "bg-theme-sidebar-item-selected text-theme-text-primary"
                    : ""
                }
                onClick={() => setLibraryId(lib.id)}
              >
                <Icon
                  name={lib.visibility === "private" ? "lock" : "globe"}
                  size={17}
                />
                <span title={lib.name}>{lib.name}</span>
                <small>
                  {
                    documents.filter(
                      (doc) => String(doc.libraryId) === String(lib.id)
                    ).length
                  }
                </small>
              </button>
            ))}
          </div>
          <div className="mt-5 hidden items-start gap-2 border-t border-theme-sidebar-border pt-4 text-xs leading-relaxed text-theme-text-secondary xl:flex">
            <Icon name="info" size={16} />
            <p>
              公有库：全员可读，内容变更需管理员审批。
              <br />
              私有库：仅获授权用户可读写。
            </p>
          </div>
        </aside>
        <section className="min-w-0 overflow-hidden rounded-lg border border-theme-sidebar-border bg-theme-bg-secondary ">
          <div className="flex flex-wrap items-center justify-between gap-4 p-5 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:text-base [&_h2]:font-semibold [&_p]:mt-2 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-theme-text-secondary">
            <div>
              <h2>
                {selectedLibrary?.name || "全部资料"}
                {selectedLibrary && (
                  <Scope value={selectedLibrary.visibility} />
                )}
              </h2>
              <p>文件上传与文字录入使用同一套访问规则。</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="secondary"
                icon="text"
                onClick={() => open("text")}
              >
                录入文字
              </Button>
              <Button icon="upload" onClick={() => open("upload")}>
                上传文件
              </Button>
              <Button variant="secondary" onClick={() => open("connector")}>
                数据连接器
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 px-5 pb-5">
            <div className="flex rounded-lg bg-theme-sidebar-item-default p-1 [&>button]:rounded-md [&>button]:px-3 [&>button]:py-1.5 [&>button]:text-xs [&>button]:text-theme-text-secondary">
              {[
                ["all", "全部"],
                ["public", "公有"],
                ["private", "我的私有"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={
                    scope === key
                      ? "bg-theme-sidebar-item-selected text-theme-text-primary"
                      : ""
                  }
                  onClick={() => {
                    setScope(key);
                    setLibraryId("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex h-9 min-w-[130px] flex-1 items-center gap-2 rounded-lg bg-theme-settings-input-bg px-3 text-theme-text-secondary sm:max-w-[240px] [&_input]:w-full [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-xs [&_input]:text-theme-settings-input-text [&_input]:outline-none">
              <Icon name="search" size={17} />
              <input
                aria-label="搜索资料名称"
                placeholder="搜索资料名称…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <button
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-theme-text-secondary hover:bg-theme-action-menu-item-hover hover:text-theme-text-primary disabled:opacity-50"
              onClick={() => refresh(true)}
              aria-label="刷新资料"
              title="刷新"
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>
          {loading ? (
            <div className="flex min-h-[200px] items-center justify-center gap-3 text-sm text-theme-text-secondary">
              <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
              正在加载资料…
            </div>
          ) : !rows.length ? (
            <Empty title={search ? "没有匹配的资料" : "从第一份资料开始"}>
              {search
                ? "试试其他关键词，或切换知识库查看。"
                : "新建公有或私有知识库，上传文件或直接录入一段知识。"}
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-theme-sidebar-border [&_th]:bg-theme-sidebar-item-default [&_th]:px-5 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-theme-text-secondary [&_td]:border-b [&_td]:border-theme-sidebar-border [&_td]:px-5 [&_td]:py-4 [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-theme-sidebar-subitem-hover">
                <thead>
                  <tr>
                    <th>资料名称</th>
                    <th>权限</th>
                    <th>状态</th>
                    <th>更新时间</th>
                    <th className="text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((doc) => (
                    <tr key={doc.id}>
                      <td>
                        <button
                          className="flex max-w-[260px] items-center gap-3 text-left [&>span:last-child]:min-w-0 [&_strong]:block [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-medium [&_small]:mt-1 [&_small]:block [&_small]:truncate [&_small]:text-xs [&_small]:text-theme-text-secondary"
                          onClick={() => detail(doc)}
                          disabled={working === doc.id}
                        >
                          <span className="flex h-10 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-sidebar-item-default text-theme-text-secondary">
                            <Icon
                              name={doc.inputType === "text" ? "text" : "file"}
                              size={21}
                            />
                          </span>
                          <span>
                            <strong>{doc.title}</strong>
                            <small>
                              {libraries.find(
                                (lib) =>
                                  String(lib.id) === String(doc.libraryId)
                              )?.name || "知识库"}{" "}
                              ·{" "}
                              {doc.inputType === "text"
                                ? "文字录入"
                                : "文件上传"}
                            </small>
                          </span>
                        </button>
                      </td>
                      <td>
                        <Scope value={doc.visibility} />
                      </td>
                      <td>
                        <Status value={doc.status} />
                        {doc.error && (
                          <span
                            className="mt-1 block max-w-[160px] truncate text-xs text-red-400 light:text-red-700"
                            title={doc.error}
                          >
                            {doc.error}
                          </span>
                        )}
                      </td>
                      <td className="text-theme-text-secondary whitespace-nowrap">
                        {dateLabel(doc.updatedAt || doc.createdAt)}
                      </td>
                      <td>
                        <div className="flex justify-end gap-2 [&>button]:rounded [&>button]:p-1 [&>button]:text-theme-text-secondary [&>button:hover]:bg-theme-action-menu-item-hover [&>button]:disabled:opacity-50">
                          <button
                            title={
                              doc.pinned ? "取消固定资料" : "固定到问答上下文"
                            }
                            aria-label={`${doc.pinned ? "取消固定" : "固定"} ${doc.title}`}
                            disabled={working === doc.id}
                            onClick={() => pin(doc)}
                          >
                            <PushPin
                              size={16}
                              weight={doc.pinned ? "fill" : "regular"}
                            />
                          </button>
                          {doc.canWatch && (
                            <button
                              aria-label={`${watchedIds.includes(doc.id) ? "停止同步" : "自动同步"} ${doc.title}`}
                              title={
                                watchedIds.includes(doc.id)
                                  ? "停止同步"
                                  : "自动同步来源"
                              }
                              disabled={working === doc.id}
                              onClick={() => toggleWatch(doc)}
                            >
                              <Icon
                                name={
                                  watchedIds.includes(doc.id)
                                    ? "check"
                                    : "refresh"
                                }
                                size={16}
                              />
                            </button>
                          )}
                          {doc.status !== "processing" && (
                            <button
                              title={
                                doc.status === "failed"
                                  ? "重新处理"
                                  : "重建检索索引"
                              }
                              aria-label={`重新处理 ${doc.title}`}
                              disabled={working === doc.id}
                              onClick={() => retry(doc)}
                            >
                              <Icon name="refresh" size={16} />
                            </button>
                          )}
                          {doc.inputType !== "text" && (
                            <button
                              title="下载原件"
                              aria-label={`下载 ${doc.title}`}
                              disabled={working === doc.id}
                              onClick={() => download(doc)}
                            >
                              <Icon
                                name="upload"
                                size={16}
                                style={{ transform: "rotate(180deg)" }}
                              />
                            </button>
                          )}
                          <button
                            title="编辑资料"
                            aria-label={`编辑 ${doc.title}`}
                            disabled={working === doc.id}
                            onClick={() => detail(doc, true)}
                          >
                            <Icon name="edit" size={16} />
                          </button>
                          <button
                            className="text-red-400 light:text-red-700"
                            title="删除资料"
                            aria-label={`删除 ${doc.title}`}
                            disabled={working === doc.id}
                            onClick={() => remove(doc)}
                          >
                            <Icon name="trash" size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-theme-sidebar-border px-5 py-4 text-xs text-theme-text-secondary [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1">
            <span>
              共 {rows.length} 份资料
              {processing && " · 处理状态每 3 秒自动更新"}
            </span>
            <span>
              <Icon name="shield" size={13} />
              仅展示您有权访问的资料
            </span>
          </div>
        </section>
      </div>
      {modal?.type === "view" && (
        <DocumentViewer document={modal.doc} onClose={close} />
      )}
      {modal?.type === "watch" && (
        <Modal title="自动同步来源" onClose={close}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setWatch(modal.doc, watchUserId);
            }}
          >
            <Field
              label="执行用户"
              hint="按该用户当前知识权限同步；公有内容变更仍需审批。"
            >
              <select
                required
                value={watchUserId}
                onChange={(event) => setWatchUserId(event.target.value)}
              >
                <option value="">请选择执行用户</option>
                {watchUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name || user.username}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              type="submit"
              disabled={!watchUserId || working === modal.doc.id}
            >
              启用同步
            </Button>
          </form>
        </Modal>
      )}
      {modal?.type === "grants" && (
        <Modal title="调整知识库授权" onClose={close}>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setModalError("");
              try {
                const result = await knowledgeApi(
                  `/libraries/${modal.library.id}/grants`,
                  {
                    method: "PUT",
                    body: { visibility: "private", userId: privateUserId },
                  }
                );
                setSuccess(
                  result.approvalRequired ? pendingText : "知识库授权已更新。"
                );
                setModal(null);
                await refresh();
              } catch (err) {
                setModalError(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="私有库授权用户">
              <select
                required
                value={privateUserId}
                onChange={(event) => setPrivateUserId(event.target.value)}
              >
                <option value="">请选择用户</option>
                {tenantUsers.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name || user.username}
                  </option>
                ))}
              </select>
            </Field>
            <Notice>{modalError}</Notice>
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={close}
              >
                取消
              </Button>
              <Button type="submit" busy={busy}>
                保存授权
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal?.type === "connector" && (
        <Modal
          title="导入到知识库"
          subtitle="使用原数据连接器提取资料；公有库资料须审批后发布。"
          onClose={close}
          wide
        >
          <Field label="目标知识库">
            <select value={form.libraryId} onChange={change("libraryId")}>
              {libraries.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))}
            </select>
          </Field>
          <DataConnectors
            onImport={async (connector, args) => {
              const result = await knowledgeApi("/data-connectors/import", {
                method: "POST",
                body: { libraryId: form.libraryId, connector, args },
              });
              await refresh();
              const message = result.data.approvalRequired
                ? `${result.data.imported} 份资料已提交管理员审批，批准前不会公开。`
                : `${result.data.imported} 份资料已导入私有知识库并开始建立索引。`;
              setSuccess(message);
              return { data: { ...result.data, message }, error: null };
            }}
          />
        </Modal>
      )}
      {modal &&
        !["view", "watch", "grants", "connector"].includes(modal.type) && (
          <Modal
            title={
              {
                library: "新建知识库",
                text: "录入文字知识",
                upload: "上传知识文件",
                edit: "编辑资料",
                replace: "替换原始文件",
              }[modal.type]
            }
            subtitle={
              modal.needsLibrary
                ? `请先新建${scope === "private" ? "私有" : scope === "public" ? "公有" : "一个"}知识库，再上传文件或录入文字。`
                : modal.type === "library"
                  ? "公有库及共享范围变更需管理员审批。"
                  : "资料处理完成后，可在问答入口检索并引用。"
            }
            onClose={close}
            wide={modal.type === "text" || modal.type === "edit"}
          >
            <form onSubmit={submit}>
              <Notice>{modalError}</Notice>
              {modal.type === "library" ? (
                <>
                  <Field label="知识库名称">
                    <input
                      required
                      value={form.name}
                      onChange={change("name")}
                      maxLength={80}
                      placeholder="例如：产品手册、我的工作笔记"
                    />
                  </Field>
                  <Field label="可见范围">
                    <div className="flex flex-col gap-3 [&>button]:flex [&>button]:items-center [&>button]:gap-3 [&>button]:rounded-lg [&>button]:border [&>button]:border-theme-sidebar-border [&>button]:p-4 [&>button]:text-left [&>button>span:first-of-type]:flex [&>button>span:first-of-type]:flex-1 [&>button>span:first-of-type]:flex-col [&>button>span:first-of-type]:gap-2 [&_strong]:text-sm [&_strong]:font-medium [&_small]:text-xs [&_small]:text-theme-text-secondary">
                      {[
                        [
                          "public",
                          "公有知识库",
                          "当前企业全员可读，内容和整库变更需管理员审批。",
                          "globe",
                        ],
                        [
                          "private",
                          "私有知识库",
                          "授权用户可直接读取和管理；顶级管理员拥有全部权限。",
                          "lock",
                        ],
                      ].map(([key, label, hint, icon]) => (
                        <button
                          key={key}
                          type="button"
                          className={
                            form.visibility === key
                              ? "bg-theme-sidebar-item-selected text-theme-text-primary"
                              : ""
                          }
                          onClick={() => setForm({ ...form, visibility: key })}
                        >
                          <Icon name={icon} />
                          <span>
                            <strong>{label}</strong>
                            <small>{hint}</small>
                          </span>
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-theme-sidebar-border [&>i]:h-2 [&>i]:w-2 [&>i]:rounded-full [&>i]:bg-primary-button">
                            {form.visibility === key && <i />}
                          </span>
                        </button>
                      ))}
                    </div>
                  </Field>
                </>
              ) : (
                <>
                  {["text", "upload"].includes(modal.type) && (
                    <Field
                      label="存入知识库"
                      hint="资料将继承所选知识库的公有或私有权限。"
                    >
                      <select
                        required
                        disabled={busy || uploadQueue.busy}
                        value={form.libraryId}
                        onChange={change("libraryId")}
                      >
                        <option value="" disabled>
                          选择知识库
                        </option>
                        {libraries.map((lib) => (
                          <option key={lib.id} value={lib.id}>
                            {lib.name}（
                            {lib.visibility === "public"
                              ? "公有 · 租户共享"
                              : "私有 · 仅本人"}
                            ）
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {["text", "edit"].includes(modal.type) && (
                    <>
                      <Field label="资料标题">
                        <input
                          required
                          maxLength={200}
                          value={form.title}
                          onChange={change("title")}
                          placeholder="用清晰的标题描述这份知识"
                        />
                      </Field>
                      <Field label="知识正文">
                        <textarea
                          required
                          rows={10}
                          value={form.content}
                          onChange={change("content")}
                          placeholder="在这里写下业务规则、操作经验或一段需要被记住的知识…"
                        />
                      </Field>
                      {modal.type === "edit" &&
                        modal.doc.inputType !== "text" && (
                          <div className="flex items-center gap-3 text-xs text-theme-text-secondary">
                            <span>需要重新上传原始文件？</span>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 text-sm text-primary-button hover:underline"
                              onClick={() => {
                                uploadQueue.clear();
                                setModalError("");
                                setModal({ type: "replace", doc: modal.doc });
                              }}
                            >
                              替换文件
                            </button>
                          </div>
                        )}
                    </>
                  )}
                  {["upload", "replace"].includes(modal.type) && (
                    <Field
                      label={
                        modal.type === "replace"
                          ? `替换：${modal.doc.title}`
                          : "选择文件"
                      }
                    >
                      <UploadFile
                        showLink={false}
                        queue={uploadQueue}
                        disabled={busy}
                        multiple={modal.type !== "replace"}
                        onRetry={async (uid) => {
                          setModalError("");
                          try {
                            const result = await uploadQueue.uploadAll(
                              undefined,
                              uid
                            );
                            if (result.failures?.length)
                              setModalError(result.failures.join("；"));
                            await refresh();
                          } catch (error) {
                            if (error.name !== "AbortError")
                              setModalError(error.message);
                          }
                        }}
                      />
                      <p className="text-xs text-theme-text-secondary mt-2">
                        {fileTypes
                          ? t("enterprise:files.supported", {
                              extensions: fileTypes.extensions.join("、"),
                              size: fileTypes.maxFileSizeBytes / 1024 / 1024,
                            })
                          : t(
                              `enterprise:files.${fileTypeError ? "unavailable" : "loading"}`
                            )}
                      </p>
                      {fileTypeError && (
                        <button
                          type="button"
                          className="text-xs text-primary-button"
                          onClick={() =>
                            setFileTypeRequest((value) => value + 1)
                          }
                        >
                          重试读取文件格式
                        </button>
                      )}
                      {modal.type === "replace" && (
                        <small>替换后将重新解析文件并更新检索索引。</small>
                      )}
                    </Field>
                  )}
                </>
              )}
              <div className="mt-6 flex justify-end gap-2 border-t border-theme-sidebar-border pt-5">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || uploadQueue.busy}
                  onClick={close}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  busy={busy || uploadQueue.busy}
                  disabled={
                    uploadQueue.busy ||
                    (["upload", "replace"].includes(modal.type) && !fileTypes)
                  }
                  icon={
                    modal.type === "upload" || modal.type === "replace"
                      ? "upload"
                      : "check"
                  }
                >
                  {modal.type === "library"
                    ? "创建知识库"
                    : modal.type === "edit"
                      ? "保存资料"
                      : modal.type === "upload" || modal.type === "replace"
                        ? "上传并处理"
                        : "保存并建立索引"}
                </Button>
              </div>
            </form>
          </Modal>
        )}
    </>
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
