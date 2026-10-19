async function init() {
  const { api, message } = await import("./common.js");
  let mode = location.pathname === "/register" ? "register" : "login";
  const form = document.getElementById("auth-form"), submit = document.getElementById("auth-submit");
  let options;
  function render() {
    const register = mode === "register";
    document.getElementById("tab-login").setAttribute("aria-selected", String(!register));
    document.getElementById("tab-register").setAttribute("aria-selected", String(register));
    document.getElementById("confirm-field").hidden = !register;
    document.getElementById("confirmPassword").required = register;
    document.getElementById("password").autocomplete = register ? "new-password" : "current-password";
    document.getElementById("password").minLength = register ? 8 : 1;
    document.getElementById("username-help").textContent = register ? "2–64 位，以英文字母开头，可含数字、点、下划线、@ 或短横线。" : "请输入你的登录账号。";
    submit.textContent = register ? "注册并进入个人后台" : "登录个人后台";
    submit.disabled = register && !options?.registrationEnabled;
    message("auth-message", register && !options?.registrationEnabled ? "注册暂未开放，请联系管理员。" : "");
  }
  for (const action of ["login", "register"]) document.getElementById(`tab-${action}`).addEventListener("click", () => { mode = action; render(); });
  form.addEventListener("submit", async event => {
    event.preventDefault(); submit.disabled = true; message("auth-message", "正在处理，请稍候…");
    try {
      const data = await api(`/${mode}`, { method: "POST", body: Object.fromEntries(new FormData(form)) });
      location.assign(data.loginPath);
    } catch (error) { message("auth-message", error.message, true); submit.disabled = false; }
  });
  try { options = await api("/options"); } catch (error) { message("auth-message", error.message, true); return; }
  render();
  const inWechat = /MicroMessenger/i.test(navigator.userAgent), provider = inWechat ? "h5" : "web";
  const enabled = options[inWechat ? "wechatH5" : "wechatWeb"];
  const wechat = document.getElementById("wechat-login");
  wechat.disabled = !enabled; wechat.textContent = enabled ? (inWechat ? "微信授权登录" : "微信扫码登录") : "微信登录尚未开通";
  wechat.addEventListener("click", () => location.assign(`/api/access/wechat/${provider}/start`));
  const errors = { wechat_state: "微信登录已过期或页面已切换，请重新发起登录。", wechat_provider: "微信授权未通过，请重试或联系管理员检查配置。", wechat_unconfigured: "微信登录尚未配置，请先使用账号密码。", wechat_denied: "未完成微信授权，请重新登录。", account_disabled: "账号已停用，请联系管理员。", account_removed: "账号已移除，请联系管理员。", registration_closed: "注册暂未开放，请联系管理员。" };
  const error = new URLSearchParams(location.search).get("error");
  if (error) message("auth-message", errors[error] || "登录未完成，请重新尝试。", true);
}
init().catch(() => { document.getElementById("auth-message").textContent = "页面加载失败，请刷新后重试。"; });
