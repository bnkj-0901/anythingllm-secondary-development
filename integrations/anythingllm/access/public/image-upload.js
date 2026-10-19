import { api, message, element, button } from "./common.js";
const byId = id => document.getElementById(id);
const statuses = { recognizing: "正在识别", ready: "待人工确认", failed: "识别未完成 · 可手工填写", indexing: "正在建立索引", index_failed: "索引未完成 · 可重试", indexed: "已入库" };
export function createImageUpload({ onIndexed }) {
  let space, selected, timer, busy = false;
  const route = () => `/spaces/${space.slug}/images`;
  function controls() {
    const editable = ["ready", "failed"].includes(selected?.status) && !busy;
    for (const id of ["image-title", "image-text"]) byId(id).readOnly = !editable;
    byId("image-save").disabled = !editable;
    byId("image-recognize").disabled = !editable;
    byId("image-review-dialog").querySelector("[data-close]").disabled = busy;
    byId("image-confirmed").disabled = busy || !["ready", "failed", "index_failed"].includes(selected?.status);
    byId("image-confirm").disabled = busy || !byId("image-confirmed").checked || byId("image-confirmed").disabled || !byId("image-text").value.trim();
  }
  function show(draft) {
    selected = draft;
    byId("image-title").value = draft.title; byId("image-text").value = draft.text;
    byId("image-confirmed").checked = false;
    byId("image-review-status").textContent = statuses[draft.status];
    byId("image-engine").textContent = draft.engine?.startsWith("aliyun:") ? `识别模型：${draft.engine.slice(7)}` : draft.engine === "local" ? "识别方式：本地 OCR" : draft.status === "recognizing" ? "正在确定识别服务…" : "未记录识别模型";
    byId("image-previous").hidden = !draft.previousRecognition;
    byId("image-previous-text").textContent = draft.previousRecognition?.text || "";
    byId("image-original").href = `/api/access${route()}/${draft.id}/original`;
    byId("image-preview").src = byId("image-original").href + "?preview=1";
    const progress = draft.progress?.total > 1 ? `正在分区识别，已完成 ${draft.progress.completed}/${draft.progress.total} 段。` : "正在识别中英文文字。";
    message("image-review-message", draft.error || (draft.status === "indexed" ? "这份图片文字已确认入库，可在知识库中查询。" : draft.status === "recognizing" ? `${progress}可以关闭窗口，稍后继续核对。` : draft.warning || "请核对型号、金额、日期等内容，识别结果可能有误。"), ["failed", "index_failed"].includes(draft.status));
    controls();
  }
  async function refresh() {
    if (!space?.canWrite || !byId("documents-dialog").open) return;
    const requestedSpace = space;
    const data = await api(route());
    if (space !== requestedSpace || !byId("documents-dialog").open) return;
    const list = byId("image-drafts"); list.replaceChildren();
    if (!data.drafts.length) list.append(element("p", "暂无待确认图片。", "muted"));
    for (const draft of data.drafts) {
      const row = element("div", undefined, "doc-row"), name = element("div", undefined, "doc-name"), actions = element("div", undefined, "actions");
      name.append(element("strong", draft.title), element("small", statuses[draft.status]));
      actions.append(button("核对文字", () => { show(draft); byId("image-review-dialog").showModal(); }, "image-review-open"));
      if (["ready", "failed"].includes(draft.status)) actions.append(button("删除草稿", async () => {
        if (!confirm("删除此图片草稿和原图？未确认的内容尚未入库。")) return;
        await api(`${route()}/${draft.id}`, { method: "DELETE" }); await refresh();
      }, "danger"));
      row.append(name, actions); list.append(row);
    }
    if (selected && byId("image-review-dialog").open && ["recognizing", "indexing"].includes(selected.status) && !busy) {
      const value = data.drafts.find(draft => draft.id === selected.id);
      if (value && (value.status !== selected.status || value.engine !== selected.engine || JSON.stringify(value.progress) !== JSON.stringify(selected.progress))) show(value);
    }
    clearTimeout(timer);
    if (data.drafts.some(draft => ["recognizing", "indexing"].includes(draft.status))) timer = setTimeout(() => refresh().catch(error => message("images-message", error.message, true)), 2000);
  }
  byId("documents-dialog").addEventListener("close", () => clearTimeout(timer));
  byId("image-review-dialog").addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  byId("image-upload-form").addEventListener("submit", async event => {
    event.preventDefault(); const submit = event.submitter, file = byId("image-file").files[0];
    if (!file || file.size > 10 * 1024 * 1024) { message("images-message", "请选择最大 10MB 的图片。", true); return; }
    const requestedSpace = space;
    submit.disabled = true; message("images-message", "正在上传图片…");
    try {
      const body = new FormData(); body.append("file", file);
      const result = await api(route(), { method: "POST", body });
      if (space !== requestedSpace || !byId("documents-dialog").open) return;
      event.target.reset(); message("images-message", "图片已保存，正在识别。未确认前不会进入知识问答。");
      show(result.draft); byId("image-review-dialog").showModal(); await refresh();
    } catch (error) { message("images-message", error.message, true); } finally { submit.disabled = false; }
  });
  for (const id of ["image-title", "image-text"]) byId(id).addEventListener("input", () => { byId("image-confirmed").checked = false; controls(); });
  byId("image-confirmed").addEventListener("change", controls);
  byId("image-recognize").addEventListener("click", async () => {
    if (busy || !selected) return;
    if (!confirm("将使用当前识别配置重新读取原图，替换文字。上一版已保存文字将保留供对照；尚未保存的编辑请先保存。继续？")) return;
    busy = true; controls();
    try { const result = await api(`${route()}/${selected.id}/recognition`, { method: "POST", body: { revision: selected.revision } }); show(result.draft); }
    catch (error) { message("image-review-message", error.message, true); }
    finally { busy = false; controls(); await refresh().catch(error => message("images-message", error.message, true)); }
  });
  byId("image-review-form").addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return;
    const confirm = event.submitter?.dataset.action === "confirm";
    if (confirm && !byId("image-confirmed").checked) return;
    busy = true; controls(); message("image-review-message", confirm ? "正在保存确认内容并建立索引，请稍候…" : "正在保存草稿…");
    try {
      if (["ready", "failed"].includes(selected.status)) selected = (await api(`${route()}/${selected.id}`, { method: "PATCH", body: { revision: selected.revision, title: byId("image-title").value, text: byId("image-text").value } })).draft;
      if (confirm) {
        selected = (await api(`${route()}/${selected.id}/confirm`, { method: "POST", body: { revision: selected.revision, confirmed: true } })).draft;
        byId("image-review-dialog").close(); message("images-message", "图片文字已确认入库，索引已完成。可在资料中查看原文和原图。");
        await onIndexed();
      } else { show(selected); message("image-review-message", "草稿已保存，尚未入库。核对后勾选确认即可建立索引。"); }
    } catch (error) {
      if (confirm) { try { selected = (await api(`${route()}/${selected.id}`)).draft; } catch {} }
      message("image-review-message", error.message, true);
    } finally { busy = false; controls(); await refresh().catch(error => message("images-message", error.message, true)); }
  });
  return {
    setSpace(value) { space = value; selected = null; clearTimeout(timer); message("images-message", ""); refresh().catch(error => message("images-message", error.message, true)); },
    async openDraft(id) {
      const requestedSpace = space, result = await api(`${route()}/${id}`);
      if (space !== requestedSpace || !byId("documents-dialog").open) return;
      show(result.draft); byId("image-review-dialog").showModal(); await refresh();
    },
  };
}
