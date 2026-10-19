import { api, message } from "./common.js";
const byId = id => document.getElementById(id);
function secretField() { byId("vision-secret-field").hidden = byId("vision-key-source").value !== "custom"; }
export async function loadVision() {
  const value = await api("/admin/vision");
  byId("vision-enabled").checked = value.enabled;
  byId("vision-model").value = value.model; byId("vision-base-url").value = value.baseUrl; byId("vision-key-source").value = value.keySource;
  byId("vision-api-key").value = ""; byId("vision-clear").checked = false;
  byId("vision-secret-status").textContent = value.secretConfigured ? "独立密钥已保存，留空保留；服务端加密存储，不会回传。" : "尚未保存独立密钥。";
  byId("vision-existing-status").textContent = value.existingKeyAvailable ? "检测到现有阿里连接，可复用。" : "未检测到可复用的阿里连接，请填写独立密钥。";
  secretField(); byId("vision-form").hidden = false;
}
byId("vision-key-source").addEventListener("change", secretField);
byId("vision-form").addEventListener("submit", async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    await api("/admin/vision", { method: "PUT", body: { enabled: byId("vision-enabled").checked, model: byId("vision-model").value.trim(), baseUrl: byId("vision-base-url").value.trim(), keySource: byId("vision-key-source").value, apiKey: byId("vision-api-key").value, clearSecret: byId("vision-clear").checked } });
    await loadVision(); message("vision-message", "图片识别配置已保存。已有图片可在核对窗口点击“重新识别”。");
  } catch (error) { message("vision-message", error.message, true); }
  finally { event.submitter.disabled = false; }
});
