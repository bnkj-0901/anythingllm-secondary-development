import { api, currentUser, logout, message, element, button } from "./common.js";
import { createImageUpload } from "./image-upload.js";
let user, filter = "private", spaces = [], summary = {}, currentSpace, page = 1, documentsPage = 1, editing;
const byId = id => document.getElementById(id);
const imageUpload = createImageUpload({ onIndexed: async () => { await loadDocuments(); await load(); } });
for (const node of document.querySelectorAll("[data-close]")) node.addEventListener("click", () => byId(node.dataset.close).close());
byId("logout").addEventListener("click", () => logout().catch(error => message("page-message", error.message, true)));
byId("create-open").addEventListener("click", () => { byId("create-dialog").showModal(); byId("space-name").focus(); });
for (const tab of document.querySelectorAll("[data-filter]")) tab.addEventListener("click", () => { filter = tab.dataset.filter; render(); });
function render() {
  for (const tab of document.querySelectorAll("[data-filter]")) tab.setAttribute("aria-selected", String(tab.dataset.filter === filter));
  byId("visibility-help").textContent = filter === "private" ? "私有资料仅本人和平台管理员可访问。" : "公共资料供所有登录用户查阅，由管理员维护。";
  byId("stat-private").textContent = summary.privateCount || 0;
  byId("stat-public").textContent = summary.publicCount || 0;
  byId("stat-documents").textContent = spaces.reduce((sum, space) => sum + space.documentCount, 0);
  const list = byId("spaces"); list.replaceChildren();
  const visible = spaces.filter(space => space.visibility === filter);
  if (!visible.length) {
    const empty = element("div", undefined, "empty");
    empty.append(element("h2", filter === "private" ? "还没有私有知识库" : "暂无公共知识库"), element("p", filter === "private" ? "新建一个知识库，开始整理你的资料。" : "管理员发布公共知识后，你就可以在这里查阅和问答。", "muted"));
    list.append(empty);
  }
  for (const space of visible) {
    const card = element("article", undefined, "panel space-card"), top = element("div", undefined, "card-top");
    top.append(element("span", space.visibility === "public" ? "公共" : "私有", `badge ${space.visibility}`), element("small", `${space.documentCount} 份资料`));
    const actions = element("div", undefined, "actions");
    actions.append(button("进入问答", async () => {
      if (localStorage.getItem("anythingllm_authToken")) location.assign(`/workspace/${space.slug}`);
      else { const result = await api(`/spaces/${space.slug}/open`); location.assign(result.loginPath); }
    }, "primary"), button(space.canWrite ? "管理资料" : "查看资料", () => openDocuments(space)));
    if (space.canWrite) actions.append(button("设置", () => { editing = space; byId("edit-name").value = space.name; byId("edit-visibility").value = space.visibility; byId("edit-visibility-field").hidden = user.role !== "admin"; message("edit-message", ""); byId("edit-dialog").showModal(); }, "quiet"));
    card.append(top, element("h3", space.name), element("small", space.visibility === "public" ? "所有登录用户可查阅" : space.ownerId === user.id ? "属于我的私有资料" : `用户 ${space.ownerId} 的私有资料 · 管理员视图`), actions); list.append(card);
  }
}
async function load() {
  const data = await api(`/spaces?page=${page}`); spaces = data.spaces; summary = data.summary; render();
  const navigation = byId("pagination"); navigation.replaceChildren();
  if (page > 1) navigation.append(button("上一页", async () => { page--; await load(); }));
  if (data.pagination.total > 50) navigation.append(element("span", `第 ${page} 页 · 共 ${data.pagination.total} 个知识库`));
  if (page * 50 < data.pagination.total) navigation.append(button("下一页", async () => { page++; await load(); }));
  byId("legacy-section").hidden = !data.legacy.length;
  const legacy = byId("legacy-list"); legacy.replaceChildren();
  for (const space of data.legacy) {
    const row = element("div", undefined, "doc-row"); row.append(element("span", space.name, "doc-name"));
    row.append(button("管理资料 / 核对图片", async () => {
      const result = await api(`/spaces/${encodeURIComponent(space.slug)}`); await openDocuments(result.space);
    }, "legacy-manage primary"));
    for (const [value, title] of [["private", "纳入我的私有库"], ["public", "发布为公共库"]]) row.append(button(title, async () => {
      if (!confirm(value === "public" ? "该库所有资料将向所有登录用户开放，确认发布？" : "分类后该库仅当前管理员可见，原有成员将失去访问权限，确认继续？")) return;
      await api("/spaces/adopt", { method: "POST", body: { workspaceId: space.id, visibility: value } }); await load();
    }));
    legacy.append(row);
  }
}
byId("create-form").addEventListener("submit", async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true;
  try { const result = await api("/spaces", { method: "POST", body: Object.fromEntries(new FormData(event.target)) }); filter = result.space.visibility; page = 1; await load(); event.target.reset(); byId("create-dialog").close(); message("page-message", "知识库已创建，可以添加资料了。"); }
  catch (error) { message("create-message", error.message, true); } finally { submit.disabled = false; }
});
byId("edit-form").addEventListener("submit", async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try { await api(`/spaces/${editing.slug}`, { method: "PATCH", body: { name: byId("edit-name").value, ...(user.role === "admin" ? { visibility: byId("edit-visibility").value } : {}) } }); await load(); byId("edit-dialog").close(); }
  catch (error) { message("edit-message", error.message, true); } finally { event.submitter.disabled = false; }
});
async function openDocuments(space) {
  currentSpace = space; documentsPage = 1; byId("documents-title").textContent = space.name; byId("documents-help").textContent = space.canWrite ? "文字与文档建立索引后即可用于知识问答。" : "公共资料仅供查看与问答。";
  byId("document-editor").hidden = !space.canWrite; message("documents-message", ""); byId("documents-dialog").showModal(); await loadDocuments();
  imageUpload.setSpace(space);
}
async function loadDocuments() {
  const result = await api(`/spaces/${currentSpace.slug}/documents?page=${documentsPage}`), list = byId("documents-list"); list.replaceChildren();
  if (!result.documents.length) list.append(element("p", "还没有资料。添加文字或上传文档后，会显示在这里。", "muted"));
  for (const doc of result.documents) {
    const row = element("div", undefined, "doc-row"), actions = element("div", undefined, "actions");
    actions.append(button("查看原文", async () => {
      const result = await api(`/spaces/${currentSpace.slug}/documents/${doc.id}`); byId("reader-title").textContent = result.title; byId("reader-text").textContent = result.text;
      byId("reader-image").hidden = !result.imageId;
      if (result.imageId) byId("reader-image").href = `/api/access/spaces/${currentSpace.slug}/images/${result.imageId}/original`;
      byId("reader-dialog").showModal();
    }));
    if (currentSpace.canWrite) actions.append(button("移出知识库", async () => {
      if (!confirm("确认移出该资料？之后问答将不再检索这份资料。原件仍保留在管理员存储中。")) return;
      await api(`/spaces/${currentSpace.slug}/documents/${doc.id}`, { method: "DELETE" }); await loadDocuments(); await load();
    }, "danger"));
    row.append(element("span", doc.filename, "doc-name"), actions); list.append(row);
  }
  const nav = byId("documents-pagination"); nav.replaceChildren();
  if (documentsPage > 1) nav.append(button("上一页", async () => { documentsPage--; await loadDocuments(); }));
  if (documentsPage * 50 < result.pagination.total) nav.append(button("下一页", async () => { documentsPage++; await loadDocuments(); }));
}
for (const [id, upload] of [["text-form", false], ["upload-form", true]]) byId(id).addEventListener("submit", async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true; message("documents-message", "正在解析并建立索引，资料较大时需要一些时间，请保持页面打开…");
  try {
    let body;
    if (upload) { body = new FormData(); body.append("file", byId("doc-file").files[0]); }
    else body = Object.fromEntries(new FormData(event.target));
    await api(`/spaces/${currentSpace.slug}/${upload ? "upload" : "documents"}`, { method: "POST", body });
    event.target.reset(); message("documents-message", "资料已保存，索引已完成。"); await loadDocuments(); await load();
  } catch (error) { message("documents-message", error.message, true); } finally { submit.disabled = false; }
});
async function init() {
  try { user = await currentUser(); } catch { location.replace("/h5"); return; }
  byId("account-name").textContent = user.username;
  for (const id of ["admin-config", "user-management", "public-option"]) byId(id).hidden = user.role !== "admin";
  await load();
  const params = new URLSearchParams(location.search), slug = params.get("space"), image = params.get("image");
  if (slug) {
    const result = await api(`/spaces/${encodeURIComponent(slug)}`);
    await openDocuments(result.space);
    if (/^[a-f0-9]{32}$/.test(image || "")) await imageUpload.openDraft(image);
  }
}
init().catch(error => message("page-message", error.message, true));
