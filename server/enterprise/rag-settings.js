const store = require("./store");
const {
  requireAuth,
  requirePlatformAuth,
  assertManagerContext,
  fail,
} = require("./auth");

const DEFAULTS = Object.freeze({
  chatMode: "chat",
  chunkSize: 1000,
  chunkOverlap: 20,
  topK: 4,
  similarityThreshold: 0.25,
  rerank: false,
  embeddingCache: true,
  chatProvider: null,
  chatModel: null,
  agentProvider: null,
  agentModel: null,
  router_id: null,
  openAiTemp: null,
  openAiHistory: 20,
  openAiPrompt: null,
  queryRefusalResponse: null,
});
const limits = {
  chunkSize: [1, Number.MAX_SAFE_INTEGER, true],
  chunkOverlap: [0, Number.MAX_SAFE_INTEGER, true],
  topK: [1, Number.MAX_SAFE_INTEGER, true],
  similarityThreshold: [0, 1, false],
  openAiHistory: [0, Number.MAX_SAFE_INTEGER, true],
  openAiTemp: [0, Infinity, false],
  router_id: [1, 2147483647, true],
};

function validateSettings(value, current = DEFAULTS) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(400, "知识检索设置必须为对象");
  for (const [name, number] of Object.entries(value)) {
    if (name === "chatMode") {
      if (!["automatic", "chat", "query"].includes(number))
        throw fail(400, "对话模式仅支持 automatic、chat 或 query");
      continue;
    }
    if (
      [
        "chatProvider",
        "chatModel",
        "agentProvider",
        "agentModel",
        "openAiPrompt",
        "queryRefusalResponse",
      ].includes(name)
    ) {
      if (number !== null && typeof number !== "string")
        throw fail(400, "企业模型或提示词配置无效");
      continue;
    }
    if (["router_id", "openAiTemp"].includes(name) && number === null) continue;
    if (name === "rerank" || name === "embeddingCache") {
      if (typeof number !== "boolean")
        throw fail(400, "重排与向量缓存开关必须为布尔值");
      continue;
    }
    if (!Object.hasOwn(limits, name))
      throw fail(400, "包含不支持的知识检索设置");
    const range = limits[name];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < range[0] ||
      number > range[1] ||
      (range[2] && !Number.isInteger(number))
    )
      throw fail(400, "知识检索设置超出允许范围");
  }
  const settings = { ...current, ...value };
  if (settings.chunkOverlap >= settings.chunkSize)
    throw fail(400, "分片重叠必须小于分片大小");
  return settings;
}

async function getSettings(tenantId, db = store) {
  const row = await db.one(
    'SELECT settings FROM ep_rag_settings WHERE "tenantId"=$1',
    tenantId
  );
  if (!row) {
    const platform = await db.all(
      "SELECT label,value FROM system_settings WHERE label IN ('text_splitter_chunk_size','text_splitter_chunk_overlap')"
    );
    const inherited = { ...DEFAULTS };
    for (const setting of platform)
      inherited[
        setting.label.endsWith("chunk_size") ? "chunkSize" : "chunkOverlap"
      ] = Number(setting.value);
    try {
      return validateSettings(inherited);
    } catch {
      throw fail(503, "平台文本分片配置无效，请联系管理员");
    }
  }
  try {
    return validateSettings(JSON.parse(row.settings));
  } catch {
    throw fail(503, "知识检索配置无效，请联系管理员");
  }
}

function registerRagSettings(router) {
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  router.get(
    "/platform/tenants/:tenantId/prompt-history",
    requirePlatformAuth,
    wrap(async (req, res) => {
      const history = await store.orm.prompt_history.findMany({
        where: { tenantId: req.params.tenantId },
        orderBy: { modifiedAt: "desc" },
      });
      res.json({ history });
    })
  );
  router.delete(
    "/platform/tenants/:tenantId/prompt-history/:id?",
    requirePlatformAuth,
    wrap(async (req, res) => {
      if (req.params.id && !/^\d+$/.test(req.params.id))
        throw fail(400, "历史记录不存在");
      await store.orm.prompt_history.deleteMany({
        where: {
          tenantId: req.params.tenantId,
          ...(req.params.id ? { id: Number(req.params.id) } : {}),
        },
      });
      res.json({ success: true });
    })
  );
  // Employees use these settings but only the top administrator maintains them.
  router.get(
    "/rag-settings",
    requireAuth,
    wrap(async (req, res) =>
      res.json({
        settings: await getSettings(req.ep.tenantId),
        defaults: DEFAULTS,
      })
    )
  );
  router.get(
    "/platform/tenants/:tenantId/rag-settings",
    requirePlatformAuth,
    wrap(async (req, res) => {
      if (
        !(await store.one(
          "SELECT id FROM ep_tenants WHERE id=$1",
          req.params.tenantId
        ))
      )
        throw fail(404, "租户不存在");
      res.json({
        settings: await getSettings(req.params.tenantId),
        defaults: DEFAULTS,
      });
    })
  );
  router.patch("/rag-settings", requireAuth, (_req, _res, next) =>
    next(fail(403, "企业配置由顶级管理员维护"))
  );
  router.patch(
    "/platform/tenants/:tenantId/rag-settings",
    requirePlatformAuth,
    wrap(async (req, res) => {
      let settings;
      await store.transaction(
        async (tx) => {
          await assertManagerContext(req.ep, tx);
          if (
            !(await tx.one(
              "SELECT id FROM ep_tenants WHERE id=$1",
              req.params.tenantId
            ))
          )
            throw fail(404, "租户不存在");
          const current = await getSettings(req.params.tenantId, tx);
          settings = validateSettings(req.body.settings, current);
          if (
            Object.hasOwn(req.body.settings, "openAiPrompt") &&
            current.openAiPrompt !== settings.openAiPrompt &&
            current.openAiPrompt
          )
            await tx.orm.prompt_history.create({
              data: {
                tenantId: req.params.tenantId,
                prompt: current.openAiPrompt,
                modifiedBy: String(req.ep.userId),
              },
            });
          if (
            settings.router_id !== null &&
            !(await tx.orm.model_routers.findUnique({
              where: { id: settings.router_id },
            }))
          )
            throw fail(400, "模型路由不存在");
          await tx.run(
            'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3) ON CONFLICT("tenantId") DO UPDATE SET settings=excluded.settings,"updatedAt"=excluded."updatedAt"',
            req.params.tenantId,
            JSON.stringify(settings),
            store.now()
          );
        },
        { retry: true }
      );
      res.json({ settings, defaults: DEFAULTS });
    })
  );
}

module.exports = {
  DEFAULTS,
  validateSettings,
  getSettings,
  registerRagSettings,
};
