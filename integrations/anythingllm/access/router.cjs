const path = require("node:path");
const { requireServer } = require("./dependencies.cjs");
const express = requireServer("express");
const { createAccessService, AccessError, fail, publicUser } = require("./service.cjs");
const { createWechat } = require("./wechat.cjs");
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
function cookie(req, name) {
  const item = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(name + "="));
  return item ? item.slice(name.length + 1) : "";
}
function createAccessRouter(options) {
  const router = express.Router();
  const service = createAccessService(options), wechat = createWechat(service, options);
  const limits = new Map();
  const limit = (req, _res, next) => {
    const key = req.socket.remoteAddress || "unknown", now = Date.now();
    for (const [address, record] of limits) if (record.until < now) limits.delete(address);
    if (!limits.has(key)) {
      if (limits.size >= 10000) return next(new AccessError(429, "rate_limited", "请求过多，请稍后重试。"));
      limits.set(key, { count: 0, until: now + 900_000 });
    }
    const record = limits.get(key);
    if (++record.count > (options.rateLimit || 30)) return next(new AccessError(429, "rate_limited", "操作过于频繁，请 15 分钟后再试。"));
    next();
  };
  const sameOrigin = asyncRoute(async (req, _res, next) => {
    const origin = req.get("origin");
    const config = await service.config();
    const localOrigin = `${req.socket.encrypted ? "https" : "http"}://${req.get("host")}`;
    if (!origin || (origin !== localOrigin && origin !== config.publicUrl)) fail(403, "invalid_origin", "请求来源不受信任，请刷新页面后重试。");
    next();
  });
  const auth = asyncRoute(async (req, res, next) => {
    await service.multiUser();
    const bearer = /^Bearer ([^ ]+)$/i.exec(req.get("authorization") || "");
    req.accessUser = await service.authenticate(bearer?.[1] || cookie(req, "kb_access_session"), !bearer);
    next();
  });
  const admin = (req, _res, next) => req.accessUser.role === "admin" ? next() : next(new AccessError(403, "forbidden", "仅管理员可以配置此页面。"));
  const cookieOptions = req => ({ httpOnly: true, sameSite: "lax", secure: Boolean(req.accessSecure || req.socket.encrypted), path: "/api/access", maxAge: 8 * 3600_000 });
  const setSession = (req, res, user) => res.cookie("kb_access_session", service.session(user), cookieOptions(req));
  router.use("/api/access", (_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }); next(); });
  router.use("/api/access", asyncRoute(async (req, _res, next) => {
    const value = await service.config();
    // Public HTTPS can terminate at a reverse proxy; never trust client-supplied
    // forwarding headers to decide whether a session cookie needs Secure.
    req.accessSecure = Boolean(value.publicUrl && new URL(value.publicUrl).host === req.get("host"));
    next();
  }));
  router.use("/api/access", express.json({ limit: "2mb" }));
  router.post("/api/request-token", sameOrigin, limit, (_req, _res, next) => next());
  router.get("/api/access/options", asyncRoute(async (_req, res) => {
    const value = await service.config();
    const multiUser = (await service.prisma.system_settings.findUnique({ where: { label: "multi_user_mode" } }))?.value === "true";
    res.json({ registrationEnabled: multiUser && value.registrationEnabled, wechatH5: Boolean(multiUser && value.publicUrl && value.wechatH5.appId && value.wechatH5.appSecret), wechatWeb: Boolean(multiUser && value.publicUrl && value.wechatWeb.appId && value.wechatWeb.appSecret) });
  }));
  for (const [action, status] of [["register", 201], ["login", 200]]) router.post(`/api/access/${action}`, sameOrigin, limit, asyncRoute(async (req, res) => {
    const user = await service[action](req.body || {});
    setSession(req, res, user);
    res.status(status).json({ user: publicUser(user), loginPath: await service.ticket(user) });
  }));
  router.post("/api/access/session", sameOrigin, auth, asyncRoute(async (req, res) => { setSession(req, res, req.accessUser); res.json({ user: publicUser(req.accessUser) }); }));
  router.get("/api/access/me", auth, (req, res) => res.json({ user: publicUser(req.accessUser) }));
  router.post("/api/access/logout", sameOrigin, (_req, res) => { res.clearCookie("kb_access_session", { path: "/api/access" }); res.json({ success: true }); });
  router.get("/api/access/admin/config", auth, admin, asyncRoute(async (_req, res) => res.json(service.visibleConfig(await service.config()))));
  router.put("/api/access/admin/config", sameOrigin, auth, admin, asyncRoute(async (req, res) => res.json(await service.saveConfig(req.body || {}))));
  const vision = options.vision || require("./vision.cjs").createVision(options);
  router.get("/api/access/admin/vision", auth, admin, asyncRoute(async (_req, res) => res.json(await vision.visible())));
  router.put("/api/access/admin/vision", sameOrigin, auth, admin, asyncRoute(async (req, res) => res.json(await vision.save(req.body || {}))));
  router.get("/api/access/wechat/:provider/start", limit, asyncRoute(async (req, res) => {
    try {
      const result = await wechat.start(req.params.provider);
      res.cookie("kb_wechat_binding", result.binding, { ...cookieOptions(req), path: "/api/access/wechat", maxAge: 300_000 });
      res.redirect(result.url);
    } catch (error) { if (!(error instanceof AccessError)) throw error; res.redirect(`/h5?error=${encodeURIComponent(error.code)}`); }
  }));
  router.get("/api/access/wechat/:provider/callback", limit, asyncRoute(async (req, res) => {
    try {
      const user = await wechat.callback(req.params.provider, req.query, cookie(req, "kb_wechat_binding"));
      res.clearCookie("kb_wechat_binding", { path: "/api/access/wechat" });
      setSession(req, res, user);
      res.redirect(await service.ticket(user));
    } catch (error) { if (!(error instanceof AccessError)) throw error; res.redirect(`/h5?error=${encodeURIComponent(error.code)}`); }
  }));
  // Portal routes share the exact same authentication and request-source checks.
  const { mountKnowledgeRoutes } = require("./spaces.cjs");
  mountKnowledgeRoutes(router, { service, options, auth, admin, sameOrigin, limit, asyncRoute });
  const assets = path.join(__dirname, "public");
  const pageHeaders = (_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" }); next(); };
  router.use("/access/assets", express.static(assets, { fallthrough: false }));
  for (const route of ["/h5", "/register"]) router.get(route, pageHeaders, (_req, res) => res.sendFile(path.join(assets, "index.html")));
  router.get("/access/admin", pageHeaders, (_req, res) => res.sendFile(path.join(assets, "admin.html")));
  router.get("/portal", pageHeaders, (_req, res) => res.sendFile(path.join(assets, "portal.html")));
  router.use((error, _req, res, _next) => {
    const known = error instanceof AccessError;
    const status = known ? error.status : error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
    if (status === 429) res.set("Retry-After", "900");
    if (!known && status === 500) console.error("[KnowledgeAccess] Request failed", error.code || error.name, error.stack?.split("\n").slice(1, 5).join("\n"));
    res.status(status).json({ error: { code: known ? error.code : "request_failed", message: known ? error.message : "请求未完成，请检查输入或稍后重试。" } });
  });
  return router;
}
module.exports = { createAccessRouter, asyncRoute };
