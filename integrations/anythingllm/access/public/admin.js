import { api, currentUser, message } from "./common.js";
import { loadVision } from "./vision-settings.js";
const byId = id => document.getElementById(id);
function callbacks() {
  const base = byId("publicUrl").value.trim().replace(/\/$/, "");
  for (const provider of ["h5", "web"]) byId(`${provider}-callback`).textContent = base ? `${base}/api/access/wechat/${provider}/callback` : "请先填写公网 HTTPS 地址";
}
async function load() {
  const value = await api("/admin/config");
  byId("registrationEnabled").checked = value.registrationEnabled; byId("publicUrl").value = value.publicUrl;
  for (const [provider, key] of [["h5", "wechatH5"], ["web", "wechatWeb"]]) {
    byId(`${provider}-appid`).value = value[key].appId;
    byId(`${provider}-secret`).value = "";
    byId(`${provider}-clear`).checked = false;
    byId(`${provider}-secret-status`).textContent = value[key].secretConfigured ? "密钥已保存；留空则保留现有密钥。" : "尚未配置密钥";
  }
  callbacks(); byId("config-form").hidden = false; byId("admin-login-panel").hidden = true; message("page-message", ""); if (byId("vision-form").hidden) await loadVision();
}
byId("publicUrl").addEventListener("input", callbacks);
byId("admin-login").addEventListener("submit", async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    const result = await api("/login", { method: "POST", body: Object.fromEntries(new FormData(event.target)) });
    const destination = new URL(result.loginPath, location.origin); destination.searchParams.set("redirectTo", "/access/admin");
    byId("admin-password").value = ""; location.assign(destination.pathname + destination.search);
  }
  catch (error) { message("page-message", error.message, true); } finally { event.submitter.disabled = false; }
});
byId("config-form").addEventListener("submit", async event => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true;
  const body = { registrationEnabled: byId("registrationEnabled").checked, publicUrl: byId("publicUrl").value };
  for (const [provider, key] of [["h5", "wechatH5"], ["web", "wechatWeb"]]) body[key] = { appId: byId(`${provider}-appid`).value.trim(), appSecret: byId(`${provider}-secret`).value, clearSecret: byId(`${provider}-clear`).checked };
  try { await api("/admin/config", { method: "PUT", body }); await load(); message("page-message", "配置已保存。"); }
  catch (error) { message("page-message", error.message, true); } finally { submit.disabled = false; }
});
async function init() {
  let user;
  try { user = await currentUser(); } catch { byId("admin-login-panel").hidden = false; message("page-message", "请先使用管理员账号登录。"); return; }
  if (user.role !== "admin") { message("page-message", "当前账号为普通用户，只有平台管理员可以配置此页面。", true); return; }
  await load();
}
init().catch(error => message("page-message", error.message, true));
