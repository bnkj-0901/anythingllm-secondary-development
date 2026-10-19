const { fail, AccessError } = require("./service.cjs");
const labelFor = id => `kb_access_space_${id}`;
async function spacePolicy(prisma, id) {
  const row = await prisma.system_settings.findUnique({ where: { label: labelFor(id) } });
  return row ? JSON.parse(row.value) : null;
}
const canRead = (policy, user) => Boolean(user && (user.role === "admin" || policy.visibility === "public" || policy.ownerId === user.id));
const canWrite = (policy, user) => Boolean(user && (user.role === "admin" || (policy.visibility === "private" && policy.ownerId === user.id)));

function installWorkspacePolicy(Workspace, prisma) {
  const originalGet = Workspace.getWithUser;
  const originalList = Workspace.whereWithUser;
  Workspace.getWithUser = async function (user, clause = {}) {
    const workspace = await prisma.workspaces.findFirst({ where: clause });
    if (!workspace) return null;
    const policy = await spacePolicy(prisma, workspace.id);
    if (!policy) return originalGet.call(this, user, clause);
    return canRead(policy, user) ? this.get(clause) : null;
  };
  Workspace.whereWithUser = async function (user, clause = {}, limit = null, orderBy = null) {
    const rows = await prisma.system_settings.findMany({ where: { label: { startsWith: "kb_access_space_" } } });
    const policies = new Map(rows.map(row => [Number(row.label.slice("kb_access_space_".length)), JSON.parse(row.value)]));
    const legacy = await originalList.call(this, user, clause, null, orderBy);
    const extraIds = [...policies].filter(([, policy]) => canRead(policy, user)).map(([id]) => id);
    const extra = extraIds.length ? await prisma.workspaces.findMany({ where: { AND: [clause, { id: { in: extraIds } }] }, ...(orderBy ? { orderBy } : {}) }) : [];
    const result = [...new Map([...legacy, ...extra].filter(space => !policies.has(space.id) || canRead(policies.get(space.id), user)).map(space => [space.id, space])).values()];
    return limit === null ? result : result.slice(0, limit);
  };
}

function mountWorkspaceGuard(router, { service, auth, asyncRoute }) {
  // These are personal conversation operations; all shared knowledge mutations stay protected.
  const personalAction = /^(?:stream-chat|delete-chats|delete-edited-chats|update-chat|chat-feedback\/\d+|update-pin|thread\/new|thread\/fork|thread-bulk-delete|thread\/[^/]+(?:\/(?:stream-chat|update|delete-edited-chats|update-chat))?|delete-parsed-files)$/;
  router.use("/api/workspace/:slug", auth, asyncRoute(async (req, _res, next) => {
    if (["new", "search", "workspace-chats"].includes(req.params.slug)) return next();
      const workspace = await service.prisma.workspaces.findUnique({ where: { slug: req.params.slug } });
      if (!workspace) return next();
      const policy = await spacePolicy(service.prisma, workspace.id);
      if (!policy) return next();
      if (!canRead(policy, req.accessUser)) fail(404, "space_not_found", "知识库不存在或你没有访问权限。");
      const action = req.path.replace(/^\//, "");
      if (!["GET", "HEAD"].includes(req.method) && !personalAction.test(action) && req.accessUser.role !== "admin")
        fail(403, "space_read_only", "请在个人后台管理资料；公共知识库由管理员维护。");
      next();
  }));
  // Upstream global file management has manager-wide access. Restrict it to admins
  // now that personal source files live in the same upstream document store.
  router.use(["/api/system/local-files", "/api/system/remove-document", "/api/system/remove-documents", "/api/system/remove-folder", "/api/system/export-chats", "/api/system/workspace-chats", "/api/system/system-vectors", "/api/document", "/api/admin"], auth, (req, _res, next) => {
    if (req.accessUser.role !== "admin") return next(new AccessError(403, "forbidden", "全局管理仅管理员可用，请在个人后台管理自己的资料。"));
    next();
  });
}
module.exports = { labelFor, spacePolicy, canRead, canWrite, installWorkspacePolicy, mountWorkspaceGuard };
