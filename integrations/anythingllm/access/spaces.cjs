const { fail, random } = require("./service.cjs");
const { labelFor, spacePolicy, canRead, canWrite, mountWorkspaceGuard } = require("./space-policy.cjs");

function mountKnowledgeRoutes(router, context) {
  const { service, options, auth, sameOrigin, limit, asyncRoute } = context;
  const { prisma } = service;
  mountWorkspaceGuard(router, context);
  async function getSpace(req, write = false) {
    const space = await prisma.workspaces.findUnique({ where: { slug: req.params.slug } });
    if (!space) fail(404, "space_not_found", "知识库不存在或你没有访问权限。");
    // Admins already manage legacy workspaces upstream. Review their chat image
    // drafts without adopting a library or changing any existing memberships.
    const policy = await spacePolicy(prisma, space.id) || (req.accessUser.role === "admin" ? { visibility: "legacy", ownerId: null } : null);
    if (!policy || !canRead(policy, req.accessUser)) fail(404, "space_not_found", "知识库不存在或你没有访问权限。");
    if (write && !canWrite(policy, req.accessUser)) fail(403, "space_read_only", "公共知识库由管理员维护。");
    return { space, policy };
  }
  const describe = (space, policy, user) => ({ id: space.id, slug: space.slug, name: space.name, visibility: policy.visibility, ownerId: policy.ownerId, canWrite: canWrite(policy, user), createdAt: space.createdAt, documentCount: space._count?.documents || 0 });
  router.get("/api/access/spaces/:slug", auth, asyncRoute(async (req, res) => {
    const { space, policy } = await getSpace(req);
    res.json({ space: describe(space, policy, req.accessUser) });
  }));
  router.get("/api/access/spaces", auth, asyncRoute(async (req, res) => {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1)), pageSize = 50;
    const rows = await prisma.system_settings.findMany({ where: { label: { startsWith: "kb_access_space_" } } });
    const policies = new Map(rows.map(row => [Number(row.label.slice("kb_access_space_".length)), JSON.parse(row.value)]));
    const ids = [...policies].filter(([, policy]) => canRead(policy, req.accessUser)).map(([id]) => id);
    const [spaces, total] = await Promise.all([
      prisma.workspaces.findMany({ where: { id: { in: ids } }, include: { _count: { select: { documents: true } } }, orderBy: { id: "desc" }, take: pageSize, skip: (page - 1) * pageSize }),
      prisma.workspaces.count({ where: { id: { in: ids } } }),
    ]);
    const legacy = req.accessUser.role === "admin" ? await prisma.workspaces.findMany({ where: { id: { notIn: [...policies.keys()] } }, select: { id: true, name: true, slug: true }, take: 50 }) : [];
    const myPrivateIds = [...policies].filter(([, policy]) => policy.visibility === "private" && policy.ownerId === req.accessUser.id).map(([id]) => id);
    const publicIds = [...policies].filter(([, policy]) => policy.visibility === "public").map(([id]) => id);
    const [privateCount, publicCount] = await Promise.all([prisma.workspaces.count({ where: { id: { in: myPrivateIds } } }), prisma.workspaces.count({ where: { id: { in: publicIds } } })]);
    res.json({ spaces: spaces.map(space => describe(space, policies.get(space.id), req.accessUser)), legacy, summary: { privateCount, publicCount }, pagination: { page, pageSize, total } });
  }));
  function nameInput(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100) fail(422, "invalid_name", "知识库名称为 1–100 个字符。");
    return value.trim();
  }
  function visibilityInput(value, user) {
    if (!["private", "public"].includes(value)) fail(422, "invalid_visibility", "请选择公共或私有。");
    if (value === "public" && user.role !== "admin") fail(403, "forbidden", "公共知识库由管理员发布与维护。");
    return value;
  }
  router.post("/api/access/spaces/adopt", sameOrigin, auth, context.admin, asyncRoute(async (req, res) => {
    const space = await prisma.workspaces.findUnique({ where: { id: Number(req.body?.workspaceId) || 0 } });
    if (!space) fail(404, "space_not_found", "知识库不存在。");
    if (await spacePolicy(prisma, space.id)) fail(409, "space_managed", "该知识库已经完成分类。");
    const policy = { ownerId: req.accessUser.id, visibility: visibilityInput(req.body?.visibility || "private", req.accessUser) };
    await prisma.system_settings.create({ data: { label: labelFor(space.id), value: JSON.stringify(policy) } });
    res.json({ space: describe(space, policy, req.accessUser) });
  }));
  router.post("/api/access/spaces", sameOrigin, auth, limit, asyncRoute(async (req, res) => {
    const name = nameInput(req.body?.name), visibility = visibilityInput(req.body?.visibility || "private", req.accessUser);
    if (await prisma.system_settings.count({ where: { label: { startsWith: "kb_access_space_" }, value: { contains: `"ownerId":${req.accessUser.id},` } } }) >= 100) fail(422, "space_limit", "每个用户最多创建 100 个知识库。");
    const policy = { ownerId: req.accessUser.id, visibility };
    const space = await prisma.$transaction(async tx => {
      const result = await tx.workspaces.create({ data: { name, slug: `kb-${random().slice(0, 24)}`, openAiPrompt: options.defaultPrompt || "请根据知识库资料回答问题，无法从资料确认时明确说明。", chatMode: "query" } });
      await tx.workspace_users.create({ data: { user_id: req.accessUser.id, workspace_id: result.id } });
      await tx.system_settings.create({ data: { label: labelFor(result.id), value: JSON.stringify(policy) } });
      return result;
    });
    res.status(201).json({ space: describe(space, policy, req.accessUser) });
  }));
  router.patch("/api/access/spaces/:slug", sameOrigin, auth, asyncRoute(async (req, res) => {
    const { space, policy } = await getSpace(req, true);
    if (policy.visibility === "legacy") fail(409, "space_unclassified", "请先在个人后台为原有知识库选择公共或私有分类。");
    const name = req.body?.name === undefined ? space.name : nameInput(req.body.name);
    if (req.body?.visibility !== undefined) {
      if (req.accessUser.role !== "admin") fail(403, "forbidden", "只有管理员可以调整公共／私有分类。");
      policy.visibility = visibilityInput(req.body.visibility, req.accessUser);
    }
    await prisma.$transaction([
      prisma.workspaces.update({ where: { id: space.id }, data: { name } }),
      prisma.system_settings.update({ where: { label: labelFor(space.id) }, data: { value: JSON.stringify(policy) } }),
    ]);
    res.json({ space: describe({ ...space, name }, policy, req.accessUser) });
  }));
  router.get("/api/access/spaces/:slug/open", auth, asyncRoute(async (req, res) => {
    const { space } = await getSpace(req);
    res.json({ loginPath: await service.ticket(req.accessUser, `/workspace/${space.slug}`) });
  }));
  router.get("/api/access/spaces/:slug/documents", auth, asyncRoute(async (req, res) => {
    const { space, policy } = await getSpace(req);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1), pageSize = 50;
    const documents = await prisma.workspace_documents.findMany({ where: { workspaceId: space.id }, select: { id: true, filename: true, createdAt: true }, orderBy: { id: "desc" }, take: pageSize, skip: (page - 1) * pageSize });
    const total = await prisma.workspace_documents.count({ where: { workspaceId: space.id } });
    res.json({ space: describe(space, policy, req.accessUser), documents, pagination: { page, pageSize, total } });
  }));
  router.get("/api/access/spaces/:slug/documents/:id", auth, asyncRoute(async (req, res) => {
    const { space } = await getSpace(req);
    const document = await prisma.workspace_documents.findFirst({ where: { id: Number(req.params.id) || 0, workspaceId: space.id } });
    if (!document) fail(404, "document_not_found", "资料不存在。");
    const { fileData } = require("./dependencies.cjs").requireServer("./utils/files");
    const data = await fileData(document.docpath);
    if (!data) fail(404, "document_not_found", "原文不可用。");
    res.json({ title: typeof data.title === "string" ? data.title : document.filename, text: String(data.pageContent || "").slice(0, 1_000_000), imageId: /^[a-f0-9]{32}$/.test(data.knowledgeImage?.id) ? data.knowledgeImage.id : null });
  }));
  async function ingest(req, res, input) {
    const { space } = await getSpace(req, true);
    if (!options.ingest) fail(503, "ingestion_unavailable", "文档处理服务未配置。");
    const result = await options.ingest({ space, user: req.accessUser, ...input });
    res.status(201).json(result);
  }
  router.post("/api/access/spaces/:slug/documents", sameOrigin, auth, limit, asyncRoute(async (req, res) => {
    await getSpace(req, true);
    const title = nameInput(req.body?.title), text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 1_000_000) fail(422, "invalid_text", "正文不能为空，最多 1MB。");
    await ingest(req, res, { title, text });
  }));
  if (options.uploadMiddleware) router.post("/api/access/spaces/:slug/upload", sameOrigin, auth, limit, asyncRoute(async (req, _res, next) => { await getSpace(req, true); next(); }), options.uploadMiddleware, asyncRoute(async (req, res) => {
    if (!req.file) fail(422, "file_required", "请选择文件。");
    await ingest(req, res, { file: req.file });
  }));
  if (options.images) {
    const images = options.images, base = "/api/access/spaces/:slug/images";
    router.get(base, auth, asyncRoute(async (req, res) => { const { space } = await getSpace(req); res.json({ drafts: await images.list(space, req.accessUser) }); }));
    router.post(base, sameOrigin, auth, limit, asyncRoute(async (req, _res, next) => { await getSpace(req, true); next(); }), options.imageUploadMiddleware, asyncRoute(async (req, res) => {
      const { space } = await getSpace(req, true);
      if (!req.file) fail(422, "file_required", "请选择图片。");
      res.status(202).json({ draft: await images.create(space, req.accessUser, req.file, options.validateImage) });
    }));
    router.get(`${base}/:id`, auth, asyncRoute(async (req, res) => { const { space } = await getSpace(req); res.json({ draft: await images.get(space, req.accessUser, req.params.id) }); }));
    router.get(`${base}/:id/original`, auth, asyncRoute(async (req, res) => {
      const { space } = await getSpace(req), file = await images.original(space, req.accessUser, req.params.id, req.query.preview === "1");
      res.type(file.mime).sendFile(file.path);
    }));
    for (const [method, action, suffix] of [["patch", "edit", ""], ["post", "confirm", "/confirm"], ["post", "rerecognize", "/recognition"], ["delete", "remove", ""]]) router[method](`${base}/:id${suffix}`, sameOrigin, auth, ...(["confirm", "rerecognize"].includes(action) ? [limit] : []), asyncRoute(async (req, res) => {
      const { space } = await getSpace(req, true);
      const draft = await images[action](space, req.accessUser, req.params.id, req.body || {});
      res.json(action === "remove" ? { success: true } : { draft });
    }));
  }
  router.delete("/api/access/spaces/:slug/documents/:id", sameOrigin, auth, asyncRoute(async (req, res) => {
    const { space } = await getSpace(req, true);
    const document = await prisma.workspace_documents.findFirst({ where: { id: Number(req.params.id) || 0, workspaceId: space.id } });
    if (!document) fail(404, "document_not_found", "资料不存在。");
    if (!options.removeDocument) fail(503, "ingestion_unavailable", "文档处理服务未配置。");
    await options.removeDocument(space, document, req.accessUser);
    res.json({ success: true });
  }));
}
module.exports = { mountKnowledgeRoutes };
