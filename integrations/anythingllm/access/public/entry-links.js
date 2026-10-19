(() => {
  const removeItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key) {
    if (this === localStorage && key === "anythingllm_authToken" && location.pathname !== "/sso/simple") {
      fetch("/api/access/logout", { method: "POST", credentials: "same-origin", keepalive: true }).catch(() => {});
    }
    return removeItem.call(this, key);
  };
  function update() {
    const login = Boolean(document.querySelector('input[type="password"]')) && !localStorage.getItem("anythingllm_authToken");
    const workspaceSlug = /^\/workspace\/([^/]+)/.exec(location.pathname)?.[1];
    const mode = login ? "login" : `workspace:${workspaceSlug || ""}`;
    const host = login ? document.querySelector("form")?.parentElement : document.body;
    if (!host) return;
    const existing = document.getElementById("kb-entry-links");
    if (existing?.dataset.mode === mode) return;
    existing?.remove();
    const links = document.createElement("nav"); links.id = "kb-entry-links"; links.setAttribute("aria-label", "知识库入口"); links.dataset.mode = mode;
    // Kept outside React's managed subtree when used as a workbench navigation aid.
    Object.assign(links.style, login ? { display: "flex", justifyContent: "center", gap: "20px", marginTop: "20px", fontSize: "14px" } : { position: "fixed", right: "16px", bottom: "16px", display: "flex", flexWrap: "wrap", maxWidth: "calc(100vw - 32px)", gap: "16px", background: "#fff", color: "#10576a", padding: "10px 16px", border: "1px solid #dce4eb", borderRadius: "8px", zIndex: "40", fontSize: "14px" });
    const entries = login ? [["/register", "自助注册"], ["/h5", "手机 H5 登录"]] : [["/portal", "个人后台"]];
    if (!login && workspaceSlug) entries.push([`/portal?space=${workspaceSlug}`, "图片录入与核对"]);
    let user; try { user = JSON.parse(localStorage.getItem("anythingllm_user")); } catch {}
    if (!login && user?.role === "admin") entries.push(["/access/admin", "平台配置"]);
    for (const [href, title] of entries) { const link = document.createElement("a"); link.href = href; link.textContent = title; link.style.color = "#16758a"; links.appendChild(link); }
    host.appendChild(links);
  }
  new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
  update();
})();
