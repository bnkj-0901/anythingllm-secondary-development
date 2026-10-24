const { authenticate, context, fail } = require("../../enterprise/auth");
const { resolveSite } = require("../../enterprise/domains");

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
function tenantId(req) {
  if (req.ep.identity === "tenant") return req.ep.tenantId;
  const id = req.query.tenantId || req.body?.tenantId;
  if (typeof id !== "string" || !id) throw fail(400, "请选择目标企业");
  return id;
}
function manager(req, _res, next) {
  return req.ep?.identity === "platform" || req.ep?.role === "admin"
    ? next()
    : next(fail(403, "需要管理员权限"));
}
function owned(ctx, resource) {
  return (
    !!resource &&
    (ctx.identity === "platform" ||
      (resource.tenantId === ctx.tenantId && resource.userId === ctx.userId))
  );
}
async function bindIdentity(req, res, record, userId) {
  if (!record || !userId) throw fail(403, "接入凭据无效");
  const site = await resolveSite(req);
  const ctx = await context(userId);
  if (
    site.kind !== "tenant" ||
    site.tenant.id !== record.tenantId ||
    ctx.tenantId !== record.tenantId
  )
    throw fail(403, "接入凭据不属于当前企业");
  req.ep = ctx;
  res.locals.user = { ...ctx.user, ...ctx, id: ctx.userId };
  res.locals.multiUserMode = true;
  return ctx;
}
module.exports = { authenticate, tenantId, manager, owned, bindIdentity, wrap };
