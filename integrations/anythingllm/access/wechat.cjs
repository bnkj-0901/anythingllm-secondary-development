const { fail, random, digest } = require("./service.cjs");
function createWechat(service, { bcrypt, fetchImpl = globalThis.fetch }) {
  const { prisma } = service;
  const providerConfig = (config, provider) => {
    if (!["h5", "web"].includes(provider)) fail(404, "unknown_provider", "微信登录方式不存在。");
    const app = config[provider === "h5" ? "wechatH5" : "wechatWeb"];
    if (!config.publicUrl || !app.appId || !app.appSecret) fail(503, "wechat_unconfigured", "微信登录尚未开通，请使用账号密码登录。");
    return app;
  };
  async function start(provider) {
    await service.multiUser();
    const config = await service.config();
    const app = providerConfig(config, provider);
    const state = random(), binding = random(), now = Date.now();
    await prisma.system_settings.deleteMany({ where: { label: { startsWith: "kb_access_state_" }, createdAt: { lt: new Date(now - 300_000) } } });
    if (await prisma.system_settings.count({ where: { label: { startsWith: "kb_access_state_" } } }) >= 20000) fail(429, "rate_limited", "微信登录请求过多，请稍后重试。");
    await prisma.system_settings.create({ data: { label: `kb_access_state_${digest(state)}`, value: JSON.stringify({ binding: digest(binding), provider, appId: app.appId, expires: now + 300_000 }) } });
    const url = new URL(provider === "h5" ? "https://open.weixin.qq.com/connect/oauth2/authorize" : "https://open.weixin.qq.com/connect/qrconnect");
    url.search = new URLSearchParams({ appid: app.appId, redirect_uri: `${config.publicUrl}/api/access/wechat/${provider}/callback`, response_type: "code", scope: provider === "h5" ? "snsapi_base" : "snsapi_login", state }).toString();
    url.hash = "wechat_redirect";
    return { url: url.href, binding };
  }
  async function callback(provider, query, binding) {
    await service.multiUser();
    if (typeof query.state !== "string" || !/^[a-f0-9]{64}$/.test(query.state) || !binding) fail(400, "wechat_state", "微信登录状态已失效，请重新发起登录。");
    const label = `kb_access_state_${digest(query.state)}`;
    const row = await prisma.system_settings.findUnique({ where: { label } });
    if (!row) fail(400, "wechat_state", "微信登录状态已失效，请重新发起登录。");
    const state = JSON.parse(row.value);
    if (state.expires < Date.now() || state.provider !== provider || state.binding !== digest(binding)) fail(400, "wechat_state", "微信登录状态已失效，请重新发起登录。");
    const config = await service.config(), app = providerConfig(config, provider);
    if (app.appId !== state.appId || (await prisma.system_settings.deleteMany({ where: { id: row.id } })).count !== 1) fail(400, "wechat_state", "微信登录状态已失效，请重新发起登录。");
    if (typeof query.code !== "string" || !query.code || query.code.length > 512) fail(400, "wechat_denied", "未完成微信授权，请重新登录。");
    const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    url.search = new URLSearchParams({ appid: app.appId, secret: app.appSecret, code: query.code, grant_type: "authorization_code" }).toString();
    let data;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) throw new Error();
      data = await response.json();
    } catch { fail(502, "wechat_provider", "微信授权服务暂不可用，请稍后重试。"); }
    if (!data || data.errcode || typeof data.openid !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.openid) || typeof data.access_token !== "string" || !data.access_token)
      fail(502, "wechat_provider", "微信授权未通过，请检查平台配置或重新登录。");
    const identity = `kb_access_identity_${digest(`${app.appId}:${data.openid}`)}`;
    // A unique mapping and its ordinary user are committed together. No profile-based merging.
    const password = await bcrypt.hash(random(), 12);
    async function resolveIdentity() {
      return prisma.$transaction(async tx => {
        const mapping = await tx.system_settings.findUnique({ where: { label: identity } });
        if (mapping) {
          const user = await tx.users.findUnique({ where: { id: Number(mapping.value) } });
          if (!user) fail(403, "account_removed", "账号已移除，请联系管理员。");
          return user;
        }
        if (!config.registrationEnabled) fail(403, "registration_closed", "注册暂未开放，请联系管理员。");
        const user = await tx.users.create({ data: { username: `wx_${random().slice(0, 24)}`, password, role: "default" } });
        await tx.system_settings.create({ data: { label: identity, value: String(user.id) } });
        return user;
      });
    }
    let user;
    try { user = await resolveIdentity(); }
    catch (error) { if (error.code !== "P2002") throw error; user = await resolveIdentity(); }
    if (user.suspended) fail(403, "account_disabled", "账号已停用，请联系管理员。");
    return user;
  }
  return { start, callback };
}
module.exports = { createWechat };
