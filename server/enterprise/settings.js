const express = require("express");
const fs = require("fs");
const path = require("path");
const { handleAssetUpload } = require("../utils/files/multer");
const {
  renameLogoFile,
  removeCustomLogo,
  validFilename,
} = require("../utils/files/logo");
const store = require("./store");
const providers = require("./providers");
const {
  requireAuth,
  requirePlatformAuth,
  assertManagerContext,
  fail,
} = require("./auth");
const { resolveSite } = require("./domains");
const {
  allowedRules,
  secretField,
  sanitizeUpstreamEnvironment,
} = require("./settings-environment");
const {
  defaultRow,
  saveDefault,
  projectConnections,
} = require("./settings-connections");
const {
  runWithEnvironment,
  runConnection,
} = require("./ai/connection-context");
const { vectorFields } = require("./vector-config");

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const labelFor = (ctx, label) =>
  ctx.identity === "platform" ? label : `saas:tenant:${ctx.tenantId}:${label}`;
const environmentLabel = (ctx) => labelFor(ctx, "saas:environment");
const isPlatform = (ctx) => ctx.identity === "platform";
const tenantRule = (key) =>
  !/^(?:ImageGeneration|VectorDB|Chroma|Weaviate|Qdrant|PineCone|Milvus|Zilliz|AstraDB|PGVector|Whisper|TextToSpeech|TTS|SpeechToText|STT|DisableTelemetry|Agent)/.test(
    key
  );
const preferenceFields = new Set([
  ...require("../models/systemSettings").SystemSettings.publicFields,
  "experimental_live_file_sync",
  "active_agent_flows",
  "custom_app_name",
  "footer_data",
  "support_email",
  "meta_page_title",
  "meta_page_favicon",
  "text_splitter_chunk_size",
  "text_splitter_chunk_overlap",
  "default_system_prompt",
]);
const defaults = {
  DisableTelemetry: "false",
  TextToSpeechProvider: "native",
  SpeechToTextProvider: "native",
  TTSPiperTTSVoiceModel: "en_US-hfc_female-medium",
  WhisperProvider: "local",
  WhisperModelPref: "Xenova/whisper-small",
  ImageGenerationProvider: null,
  ImageGenerationModelPref: null,
  ImageGenerationDimensions: "512x512",
  OllamaEmbeddingBatchSize: 1,
  GenericOpenAiEmbeddingMaxConcurrentChunks: 500,
};
async function readSetting(
  ctx,
  label,
  fallback = null,
  db = store,
  inherit = true
) {
  if (
    !isPlatform(ctx) &&
    require("../models/systemSettings").SystemSettings.tenantCredentialFields.has(
      label
    )
  )
    inherit = false;
  const own = await db.one(
    "SELECT value FROM system_settings WHERE label=$1",
    labelFor(ctx, label)
  );
  if (own) return own.value ?? fallback;
  if (!isPlatform(ctx) && inherit) {
    const shared = await db.one(
      "SELECT value FROM system_settings WHERE label=$1",
      label
    );
    if (shared) return shared.value ?? fallback;
  }
  return fallback;
}
async function writeSetting(ctx, label, value, db = store) {
  await db.run(
    'INSERT INTO system_settings(label,value,"createdAt","lastUpdatedAt") VALUES($1,$2,NOW(),NOW()) ON CONFLICT(label) DO UPDATE SET value=EXCLUDED.value,"lastUpdatedAt"=NOW()',
    labelFor(ctx, label),
    value === null ? null : String(value)
  );
}
async function savedEnvironment(ctx, db = store) {
  const row = await db.one(
    "SELECT value FROM system_settings WHERE label=$1",
    environmentLabel(ctx)
  );
  if (!row?.value) return {};
  try {
    return sanitizeUpstreamEnvironment(
      JSON.parse(providers.decrypt(row.value))
    );
  } catch {
    throw fail(503, "保存的系统配置无法读取，请重新保存配置");
  }
}
async function environment(
  ctx,
  db = store,
  editable = false,
  purpose = "chat"
) {
  const global = Object.fromEntries(
    Object.values(allowedRules())
      .filter(({ envKey }) => process.env[envKey] !== undefined)
      .map(({ envKey }) => [envKey, process.env[envKey]])
  );
  return projectConnections(
    ctx,
    {
      ...(editable && !isPlatform(ctx) ? {} : global),
      ...(await savedEnvironment({ identity: "platform" }, db)),
    },
    db,
    !editable,
    purpose
  );
}

async function loadPlatformEnvironment() {
  const saved = await savedEnvironment({ identity: "platform" });
  for (const [key, value] of Object.entries(saved)) process.env[key] = value;
}

async function authenticate(req, res, next) {
  try {
    const site = await resolveSite(req);
    return site.kind === "platform"
      ? requirePlatformAuth(req, res, next)
      : requireAuth(req, res, next);
  } catch (error) {
    next(error);
  }
}
function manager(req, _res, next) {
  return isPlatform(req.ep) ? next() : next(fail(403, "需要管理员权限"));
}
async function siteContext(req) {
  const site = await resolveSite(req);
  if (site.kind === "platform") return { identity: "platform" };
  if (site.kind === "tenant")
    return { identity: "tenant", tenantId: site.tenant.id };
  throw fail(404, "当前访问域名未绑定租户");
}

async function requireTenantConfiguration(req, res, next) {
  requirePlatformAuth(req, res, async (error) => {
    if (error) return next(error);
    try {
      const tenantId = req.query.tenantId;
      if (
        typeof tenantId !== "string" ||
        !(await store.one(
          "SELECT id FROM ep_tenants WHERE id=$1 AND status='active'",
          tenantId
        ))
      )
        throw fail(400, "请选择有效企业");
      require("../models/systemSettings").SystemSettings.withTenantConfiguration(
        tenantId,
        next
      );
    } catch (error) {
      next(error);
    }
  });
}

async function settingsFor(ctx, purpose = "chat") {
  const values = await environment(ctx, store, false, purpose);
  const { SystemSettings } = require("../models/systemSettings");
  const result = { ...defaults, ...SystemSettings.llmPreferenceKeys(values) };
  for (const [field, rule] of Object.entries(allowedRules())) {
    if (values[rule.envKey] !== undefined)
      result[field] = secretField(field)
        ? !!values[rule.envKey]
        : values[rule.envKey];
    else if (secretField(field)) result[field] = false;
  }
  result.LLMProvider = values.LLM_PROVIDER || null;
  result.EmbeddingEngine = values.EMBEDDING_ENGINE || "native";
  result.EmbeddingModelPref =
    values.EMBEDDING_MODEL_PREF ||
    require("../utils/EmbeddingEngines/native").NativeEmbedder._getEmbeddingModel();
  result.RequiresAuth = true;
  result.MultiUserMode = true;
  Object.assign(result, await publicLoginSettings(ctx));
  result.MemoryEnabled = await SystemSettings.memoriesEnabled();
  result.MemoryAutoExtraction =
    await SystemSettings.memoryAutoExtractionSetting();
  const where = isPlatform(ctx) ? "" : ' WHERE "tenantId"=$1';
  const count = await store.one(
    `SELECT COUNT(*) AS count FROM ep_chunks${where}`,
    ...(isPlatform(ctx) ? [] : [ctx.tenantId])
  );
  result.HasExistingEmbeddings = Number(count?.count) > 0;
  result.HasCachedEmbeddings = result.HasExistingEmbeddings;
  const vector = await require("./vector-store").settings();
  result.VectorDB = vector.provider;
  if (isPlatform(ctx))
    for (const [key, field] of Object.entries(
      vectorFields[vector.provider] || {}
    ))
      result[field] = secretField(field)
        ? !!vector.config[key]
        : vector.config[key];
  if (!isPlatform(ctx) && ctx.role !== "admin") {
    const safe = [
      "SpeechToTextProvider",
      "TextToSpeechProvider",
      "TTSPiperTTSVoiceModel",
      "RequiresAuth",
      "MultiUserMode",
      "MemoryEnabled",
      "SimpleSSOEnabled",
      "SimpleSSONoLogin",
      "SimpleSSONoLoginRedirect",
    ];
    return Object.fromEntries(safe.map((key) => [key, result[key]]));
  }
  if (!isPlatform(ctx))
    for (const key of Object.keys(result))
      if (
        !tenantRule(key) &&
        ![
          "VectorDB",
          "TextToSpeechProvider",
          "SpeechToTextProvider",
          "TTSPiperTTSVoiceModel",
        ].includes(key)
      )
        delete result[key];
  return result;
}

async function publicLoginSettings(ctx) {
  const values = {
    ...Object.fromEntries(
      [
        "SIMPLE_SSO_ENABLED",
        "SIMPLE_SSO_NO_LOGIN",
        "SIMPLE_SSO_NO_LOGIN_REDIRECT",
      ]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
    ),
    ...(await environment(ctx)),
  };
  const enabled = "SIMPLE_SSO_ENABLED" in values;
  const noLogin = "SIMPLE_SSO_NO_LOGIN" in values;
  let redirect = null;
  if (enabled && noLogin && values.SIMPLE_SSO_NO_LOGIN_REDIRECT) {
    try {
      redirect = new URL(values.SIMPLE_SSO_NO_LOGIN_REDIRECT).toString();
    } catch {}
  }
  return {
    SimpleSSOEnabled: enabled,
    SimpleSSONoLogin: noLogin,
    SimpleSSONoLoginRedirect: redirect,
  };
}

async function logChange(ctx, event, fields, db = store) {
  await db.run(
    'INSERT INTO event_logs(event,metadata,"occurredAt") VALUES($1,$2,NOW())',
    event,
    JSON.stringify({
      identity: ctx.identity,
      tenantId: ctx.tenantId || null,
      actor: ctx.username,
      fields,
    })
  );
}

async function updateEnvironment(ctx, updates) {
  let vectorResult;
  if (!isPlatform(ctx)) throw fail(403, "平台配置由顶级管理员维护");
  if (!updates || typeof updates !== "object" || Array.isArray(updates))
    throw fail(400, "配置必须为对象");
  const rules = allowedRules();
  const accepted = {};
  for (const [field, value] of Object.entries(updates)) {
    if (!rules[field]) throw fail(400, "包含不支持的配置字段");
    if (!isPlatform(ctx) && !tenantRule(field))
      throw fail(403, "当前配置由平台管理员管理");
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    )
      throw fail(400, "配置值格式无效");
    if (String(value).length > 32768 || /\0/.test(String(value)))
      throw fail(400, "配置值格式无效");
    if (secretField(field) && (!value || /^\*+$/.test(String(value)))) continue;
    const errors =
      await require("../utils/helpers/updateENV").executeValidationChecks(
        rules[field].checks,
        String(value),
        false
      );
    if (errors.length) throw fail(400, errors.join("\n"));
    accepted[field] = String(value);
  }
  const isVector = "VectorDB" in accepted;
  if (accepted.LLMProvider && accepted.EmbeddingEngine)
    throw fail(400, "请分别保存聊天与Embedding配置");
  if (isVector) {
    const { settings, change } = require("./vector-store");
    const current = await settings();
    const provider = accepted.VectorDB;
    const config = {};
    if (!vectorFields[provider]) throw fail(400, "向量数据库类型无效");
    const allowed = new Set([
      "VectorDB",
      ...Object.values(vectorFields[provider]),
    ]);
    if (Object.keys(accepted).some((key) => !allowed.has(key)))
      throw fail(400, "请单独保存向量数据库配置");
    for (const [key, field] of Object.entries(vectorFields[provider]))
      if (accepted[field] !== undefined) config[key] = accepted[field];
      else if (
        current.provider === provider &&
        current.config[key] !== undefined
      )
        config[key] = current.config[key];
    vectorResult = await change(
      { provider, config, revision: current.revision },
      ctx
    );
    await logChange(ctx, "update_vector_db", Object.keys(accepted));
  } else {
    await store.transaction(
      async (tx) => {
        await assertManagerContext(ctx, tx);
        const saved = await savedEnvironment(ctx, tx);
        if (accepted.LLMProvider)
          await saveDefault(ctx, "chat", accepted, tx, saved);
        if (accepted.EmbeddingEngine)
          await saveDefault(ctx, "embedding", accepted, tx, saved);
        for (const [field, value] of Object.entries(accepted))
          saved[rules[field].envKey] = value;
        await tx.run(
          'INSERT INTO system_settings(label,value,"createdAt","lastUpdatedAt") VALUES($1,$2,NOW(),NOW()) ON CONFLICT(label) DO UPDATE SET value=EXCLUDED.value,"lastUpdatedAt"=NOW()',
          environmentLabel(ctx),
          providers.encrypt(JSON.stringify(saved))
        );
        await logChange(
          ctx,
          "update_system_settings",
          Object.keys(accepted),
          tx
        );
      },
      { retry: true }
    );
    if (isPlatform(ctx))
      for (const [field, value] of Object.entries(accepted))
        process.env[rules[field].envKey] = value;
  }
  return {
    ...(vectorResult
      ? {
          reindexRequired: vectorResult.reindexRequired || false,
          affectedDocuments: vectorResult.affectedDocuments || 0,
        }
      : {}),
    newValues: Object.fromEntries(
      Object.entries(accepted).map(([key, value]) => [
        key,
        secretField(key) ? true : value,
      ])
    ),
    error: false,
  };
}

async function updatePreferences(ctx, updates, targetTenantId = null) {
  if (!isPlatform(ctx)) throw fail(403, "配置由顶级管理员维护");
  if (!updates || typeof updates !== "object" || Array.isArray(updates))
    throw fail(400, "配置必须为对象");
  if (Object.keys(updates).some((key) => !preferenceFields.has(key)))
    throw fail(400, "包含不支持的配置字段");
  const values = {};
  for (const [key, value] of Object.entries(updates)) {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean" &&
      value !== null
    )
      throw fail(400, "配置值格式无效");
    if (value !== null && String(value).length > 32768)
      throw fail(400, "配置内容过长");
    if (/^text_splitter_/.test(key)) continue;
    const { SystemSettings } = require("../models/systemSettings");
    const validator = SystemSettings.validations[key];
    values[key] =
      validator && !["meta_page_title", "meta_page_favicon"].includes(key)
        ? await SystemSettings.withTenantConfiguration(targetTenantId, () =>
            validator(value)
          )
        : value;
    if (key === "meta_page_favicon" && value) {
      try {
        if (!/^https?:$/.test(new URL(value).protocol)) throw new Error();
      } catch {
        throw fail(400, "图标地址必须使用HTTP或HTTPS");
      }
    }
  }
  await store.transaction(
    async (tx) => {
      await assertManagerContext(ctx, tx);
      const chunk = {};
      if ("text_splitter_chunk_size" in updates)
        chunk.chunkSize = Number(updates.text_splitter_chunk_size);
      if ("text_splitter_chunk_overlap" in updates)
        chunk.chunkOverlap = Number(updates.text_splitter_chunk_overlap);
      if (Object.keys(chunk).length) {
        const { getSettings, validateSettings } = require("./rag-settings");
        if (isPlatform(ctx)) {
          const current = {
            chunkSize: Number(
              await readSetting(ctx, "text_splitter_chunk_size", "1000", tx)
            ),
            chunkOverlap: Number(
              await readSetting(ctx, "text_splitter_chunk_overlap", "20", tx)
            ),
          };
          const next = validateSettings(chunk, current);
          values.text_splitter_chunk_size = next.chunkSize;
          values.text_splitter_chunk_overlap = next.chunkOverlap;
        } else {
          const next = validateSettings(
            chunk,
            await getSettings(ctx.tenantId, tx)
          );
          await tx.run(
            'INSERT INTO ep_rag_settings("tenantId",settings,"updatedAt") VALUES($1,$2,$3) ON CONFLICT("tenantId") DO UPDATE SET settings=EXCLUDED.settings,"updatedAt"=EXCLUDED."updatedAt"',
            ctx.tenantId,
            JSON.stringify(next),
            store.now()
          );
        }
      }
      if (
        targetTenantId &&
        !(await tx.one("SELECT id FROM ep_tenants WHERE id=$1", targetTenantId))
      )
        throw fail(404, "租户不存在");
      for (const [key, value] of Object.entries(values)) {
        const scoped =
          targetTenantId &&
          require("../models/systemSettings").SystemSettings.tenantCredentialFields.has(
            key
          );
        if (
          require("../models/systemSettings").SystemSettings.tenantCredentialFields.has(
            key
          ) &&
          !targetTenantId
        )
          throw fail(400, "企业连接配置必须选择所属企业");
        await writeSetting(
          scoped ? { identity: "tenant", tenantId: targetTenantId } : ctx,
          key,
          value,
          tx
        );
      }
      await logChange(
        ctx,
        "update_system_preferences",
        Object.keys(updates),
        tx
      );
    },
    { retry: true }
  );
}

async function defaultPrompt(ctx) {
  const { SystemSettings } = require("../models/systemSettings");
  const prompt = await readSetting(
    ctx,
    "default_system_prompt",
    SystemSettings.saneDefaultSystemPrompt
  );
  if (!/\{[^}]+\}/.test(prompt)) return prompt;
  const { SystemPromptVariables } = require("../models/systemPromptVariables");
  return SystemPromptVariables.expandSystemPromptVariables(prompt, ctx.userId, {
    tenantId: ctx.tenantId,
    db: store.orm,
  });
}

function registerSettings(app) {
  const router = express.Router();
  router.get("/utils/metrics", (_req, res) =>
    res.json({
      appVersion: require("../endpoints/utils").getDeploymentVersion(),
    })
  );
  router.use(
    wrap(async (_req, _res, next) => {
      await store.init();
      next();
    })
  );
  router.get(
    "/setup-complete",
    wrap(async (req, res, next) => {
      if (req.headers.authorization) return authenticate(req, res, next);
      res.json({ results: await publicLoginSettings(await siteContext(req)) });
    }),
    wrap(async (req, res) =>
      res.json({
        results: await settingsFor(
          req.ep,
          req.query.purpose === "embedding" ? "embedding" : "chat"
        ),
      })
    )
  );
  router.get("/system/check-token", authenticate, (_req, res) =>
    res.sendStatus(200)
  );
  router.post(
    "/system/update-env",
    authenticate,
    manager,
    wrap(async (req, res) =>
      res.json(await updateEnvironment(req.ep, req.body))
    )
  );
  router.get(
    "/admin/system-preferences-for",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const labels = String(req.query.labels || "").split(",");
      const targetTenantId = req.query.tenantId || null;
      if (
        targetTenantId &&
        !(await store.one(
          "SELECT id FROM ep_tenants WHERE id=$1",
          targetTenantId
        ))
      )
        throw fail(404, "租户不存在");
      const settings = {};
      for (const label of labels) {
        if (label === "max_embed_chunk_size") {
          const row = await defaultRow(req.ep, "embedding");
          settings[label] = row
            ? providers.embeddingChunkLimit(providers.hydrate(row))
            : 1000;
        } else if (preferenceFields.has(label)) {
          const { SystemSettings } = require("../models/systemSettings");
          if (label === "agent_sql_connections") {
            settings[label] = targetTenantId
              ? await SystemSettings.withTenantConfiguration(
                  targetTenantId,
                  () => SystemSettings.agent_sql_connections()
                )
              : [];
            continue;
          }
          if (label === "imported_agent_skills") {
            settings[label] =
              require("../utils/agents/imported").listImportedPlugins();
            continue;
          }
          if (label === "feature_flags") {
            settings[label] = await SystemSettings.getFeatureFlags();
            continue;
          }
          if (
            label === "default_agent_skills" ||
            /^disabled_.*skills$/.test(label)
          ) {
            settings[label] = require("../utils/http").safeJsonParse(
              await readSetting(req.ep, label),
              []
            );
            continue;
          }
          if (!isPlatform(req.ep) && /^text_splitter_/.test(label)) {
            const rag = await require("./rag-settings").getSettings(
              req.ep.tenantId
            );
            settings[label] = label.endsWith("chunk_size")
              ? rag.chunkSize
              : rag.chunkOverlap;
          } else
            settings[label] = await readSetting(
              targetTenantId && SystemSettings.tenantCredentialFields.has(label)
                ? { identity: "tenant", tenantId: targetTenantId }
                : req.ep,
              label,
              label === "memory_enabled"
                ? "false"
                : label === "memory_auto_extraction"
                  ? "true"
                  : null
            );
        }
      }
      res.json({ settings, error: null });
    })
  );
  router.post(
    "/admin/system-preferences",
    authenticate,
    manager,
    wrap(async (req, res) => {
      await updatePreferences(req.ep, req.body, req.query.tenantId || null);
      res.json({ success: true, error: null });
    })
  );
  router.get(
    "/system/default-system-prompt",
    authenticate,
    wrap(async (req, res) =>
      res.json({
        success: true,
        defaultSystemPrompt: await readSetting(
          req.ep,
          "default_system_prompt",
          require("../models/systemSettings").SystemSettings
            .saneDefaultSystemPrompt
        ),
        saneDefaultSystemPrompt: require("../models/systemSettings")
          .SystemSettings.saneDefaultSystemPrompt,
      })
    )
  );
  router.post(
    "/system/default-system-prompt",
    authenticate,
    manager,
    wrap(async (req, res) => {
      await updatePreferences(req.ep, {
        default_system_prompt: req.body.defaultSystemPrompt,
      });
      res.json({
        success: true,
        message: "Default system prompt updated successfully.",
      });
    })
  );
  router.post(
    "/system/custom-models",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const {
        provider,
        apiKey = null,
        basePath = null,
        options = {},
        purpose = "chat",
      } = req.body;
      if (
        typeof provider !== "string" ||
        (apiKey !== null && typeof apiKey !== "string") ||
        (basePath !== null && typeof basePath !== "string") ||
        !["chat", "embedding"].includes(purpose) ||
        !options ||
        typeof options !== "object" ||
        Array.isArray(options)
      )
        throw fail(400, "模型发现参数无效");
      const values = await environment(req.ep, store, true, purpose);
      const selected = await defaultRow(req.ep, purpose);
      const connection = selected ? providers.hydrate(selected) : null;
      const providerName = provider.replace(/-embedder$/, "");
      const matchesProvider =
        connection?.provider ===
        (providerName === "generic-openai"
          ? "openai-compatible"
          : providerName);
      const suppliedKey = apiKey && !/^\*+$/.test(apiKey) ? apiKey : null;
      let trustedEndpoint = !basePath;
      if (basePath && connection?.config.baseUrl) {
        try {
          trustedEndpoint =
            new URL(basePath).toString().replace(/\/$/, "") ===
            new URL(connection.config.baseUrl).toString().replace(/\/$/, "");
        } catch {
          trustedEndpoint = false;
        }
      }
      if (!trustedEndpoint) {
        // An edited endpoint must never receive a credential saved for another URL.
        for (const [field, rule] of Object.entries(allowedRules()))
          if (secretField(field)) values[rule.envKey] = undefined;
      }
      try {
        const discover = () =>
          require("../utils/helpers/customModels").getCustomModels(
            provider,
            suppliedKey,
            basePath,
            options
          );
        // An inherited default may discover models only at its saved endpoint.
        // Unsaved endpoints and explicit credentials use the tenant's own values.
        const result =
          matchesProvider && trustedEndpoint && !suppliedKey
            ? await runConnection(connection, {}, discover)
            : await runWithEnvironment(values, discover);
        res.json({
          models: result.models || [],
          error: result.error ? "模型列表获取失败，请核对连接设置" : null,
        });
      } catch {
        throw fail(502, "模型列表获取失败，请核对连接设置");
      }
    })
  );
  router.get(
    "/system/document-processing-status",
    authenticate,
    wrap(async (_req, res) =>
      res.sendStatus(
        (await new (require("../utils/collectorApi").CollectorApi)().online())
          ? 200
          : 503
      )
    )
  );
  router.get(
    "/system/accepted-document-types",
    authenticate,
    wrap(async (_req, res) =>
      res.json({
        types:
          await new (require("../utils/collectorApi").CollectorApi)().acceptedFileTypes(),
      })
    )
  );
  router.post(
    "/system/event-logs",
    authenticate,
    manager,
    wrap(async (req, res) => {
      const limit = Math.min(100, Math.max(1, Number(req.body.limit) || 10));
      const offset = Math.max(0, Math.trunc(Number(req.body.offset) || 0));
      const where = isPlatform(req.ep)
        ? ""
        : "WHERE metadata::jsonb->>'tenantId'=$1";
      const args = isPlatform(req.ep) ? [] : [req.ep.tenantId];
      const total = await store.one(
        `SELECT COUNT(*) AS count FROM event_logs ${where}`,
        ...args
      );
      const logs = await store.all(
        `SELECT * FROM event_logs ${where} ORDER BY id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
        ...args,
        limit,
        offset * limit
      );
      res.json({
        logs: logs.map((log) => ({
          ...log,
          user: {
            username: (() => {
              try {
                return JSON.parse(log.metadata || "{}").actor;
              } catch {
                return null;
              }
            })(),
          },
        })),
        totalLogs: Number(total.count),
        hasPages: Number(total.count) > (offset + 1) * limit,
      });
    })
  );
  router.delete(
    "/system/event-logs",
    authenticate,
    manager,
    wrap(async (req, res) => {
      await store.transaction(async (tx) => {
        await assertManagerContext(req.ep, tx);
        if (isPlatform(req.ep)) await tx.run("DELETE FROM event_logs");
        else
          await tx.run(
            "DELETE FROM event_logs WHERE metadata::jsonb->>'tenantId'=$1",
            req.ep.tenantId
          );
        await logChange(req.ep, "event_logs_cleared", [], tx);
      });
      res.json({ success: true, error: null });
    })
  );
  for (const [route, field, response] of [
    ["custom-app-name", "custom_app_name", "customAppName"],
    ["support-email", "support_email", "supportEmail"],
    ["footer-data", "footer_data", "footerData"],
  ])
    router.get(
      `/system/${route}`,
      wrap(async (req, res) =>
        res.json({
          [response]: await readSetting(await siteContext(req), field),
        })
      )
    );
  registerBranding(router);
  registerVariables(router);
  const platformRuntime = (req, _res, next) =>
    isPlatform(req.ep)
      ? next()
      : next(fail(403, "本地模型运行时由平台管理员管理"));
  const runtimeScope = wrap(async (req, _res, next) =>
    runWithEnvironment(await environment(req.ep, store, true), next)
  );
  require("../endpoints/utils/foundryUtilsEndpoints").foundryUtilsEndpoints(
    router,
    [
      authenticate,
      manager,
      (req, res, next) =>
        isPlatform(req.ep)
          ? next()
          : res.json({ source: "openai", canManage: false }),
      runtimeScope,
    ]
  );
  require("../endpoints/utils/lemonadeUtilsEndpoints").lemonadeUtilsEndpoints(
    router,
    [authenticate, platformRuntime, runtimeScope]
  );
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      newValues: null,
      error: status >= 500 ? "配置服务暂时不可用，请稍后重试" : error.message,
    });
  });
  app.use("/api", router);
}

function registerBranding(router) {
  const assetRoot = () =>
    path.resolve(
      process.env.STORAGE_DIR || path.join(__dirname, "../storage"),
      "assets"
    );
  const ownLogo = (ctx) =>
    readSetting(ctx, "logo_filename", null, store, false);
  router.get(
    "/system/logo",
    wrap(async (req, res) => {
      const ctx = await siteContext(req);
      const filename = await readSetting(ctx, "logo_filename");
      const custom =
        typeof filename === "string" &&
        filename &&
        path.basename(filename) === filename &&
        validFilename(filename);
      const defaultFile =
        req.query.theme === "light"
          ? "anything-llm-invert.png"
          : "anything-llm.png";
      const selected = path.join(assetRoot(), custom ? filename : defaultFile);
      if (!fs.existsSync(selected)) return res.sendStatus(204);
      res.set({
        "X-Is-Custom-Logo": String(!!custom),
        "Cache-Control": "no-store",
      });
      res.sendFile(selected);
    })
  );
  router.get(
    "/system/is-default-logo",
    wrap(async (req, res) =>
      res.json({ isDefaultLogo: !(await ownLogo(await siteContext(req))) })
    )
  );
  router.post(
    "/system/upload-logo",
    authenticate,
    manager,
    handleAssetUpload,
    wrap(async (req, res) => {
      if (!req.file) throw fail(400, "请选择Logo图片");
      if (!validFilename(req.file.filename)) throw fail(400, "Logo文件名无效");
      const filename = await renameLogoFile(req.file.filename);
      let previous;
      try {
        await store.transaction(async (tx) => {
          await assertManagerContext(req.ep, tx);
          previous = await readSetting(
            req.ep,
            "logo_filename",
            null,
            tx,
            false
          );
          await writeSetting(req.ep, "logo_filename", filename, tx);
        });
      } catch (error) {
        await removeCustomLogo(filename);
        throw error;
      }
      await removeCustomLogo(previous);
      res.json({ success: true, error: null });
    })
  );
  router.get(
    "/system/remove-logo",
    authenticate,
    manager,
    wrap(async (req, res) => {
      let previous;
      await store.transaction(async (tx) => {
        await assertManagerContext(req.ep, tx);
        previous = await readSetting(req.ep, "logo_filename", null, tx, false);
        await tx.run(
          "DELETE FROM system_settings WHERE label=$1",
          labelFor(req.ep, "logo_filename")
        );
      });
      await removeCustomLogo(previous);
      res.json({ success: true, error: null });
    })
  );
}

function registerVariables(router) {
  const { SystemPromptVariables } = require("../models/systemPromptVariables");
  const variableInput = async (body, create) => {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.value !== "string" ||
      !body.value.trim() ||
      body.value.length > 32768 ||
      (body.description !== undefined &&
        body.description !== null &&
        (typeof body.description !== "string" ||
          body.description.length > 4096))
    )
      throw fail(400, "提示词变量内容无效");
    try {
      await SystemPromptVariables._checkVariableKey(
        body.key,
        create,
        store.orm
      );
    } catch {
      throw fail(400, "提示词变量名称无效或已经存在");
    }
    return {
      key: body.key,
      value: body.value,
      description: body.description || null,
    };
  };
  const variableId = (id) => {
    if (!/^[1-9]\d*$/.test(id) || Number(id) > 2147483647)
      throw fail(400, "提示词变量ID无效");
    return Number(id);
  };
  router.get(
    "/system/prompt-variables",
    authenticate,
    wrap(async (req, res) => {
      const variables = await SystemPromptVariables.getAll(
        req.ep.userId,
        store.orm
      );
      res.json({
        variables: variables.map((variable) => ({
          ...variable,
          value: !isPlatform(req.ep)
            ? ""
            : typeof variable.value === "function"
              ? variable.value()
              : variable.value,
        })),
      });
    })
  );
  const platform = (req, _res, next) =>
    isPlatform(req.ep) ? next() : next(fail(403, "提示词变量由平台管理员管理"));
  router.post(
    "/system/prompt-variables",
    authenticate,
    platform,
    wrap(async (req, res) => {
      const input = await variableInput(req.body, true);
      await assertManagerContext(req.ep);
      const variable = await SystemPromptVariables.create(input, store.orm);
      res.json({ success: true, variable });
    })
  );
  router.put(
    "/system/prompt-variables/:id",
    authenticate,
    platform,
    wrap(async (req, res) => {
      const id = variableId(req.params.id);
      const input = await variableInput(req.body, false);
      await assertManagerContext(req.ep);
      const existing = await SystemPromptVariables.get(input.key, store.orm);
      if (existing && existing.id !== id)
        throw fail(400, "提示词变量名称已经存在");
      const current = (
        await SystemPromptVariables.getAll(null, store.orm)
      ).find((variable) => variable.id === id);
      if (!current) throw fail(404, "提示词变量不存在");
      const variable = await SystemPromptVariables.update(id, input, store.orm);
      if (!variable) throw fail(404, "提示词变量不存在");
      res.json({ success: true, variable });
    })
  );
  router.delete(
    "/system/prompt-variables/:id",
    authenticate,
    platform,
    wrap(async (req, res) => {
      const id = variableId(req.params.id);
      await assertManagerContext(req.ep);
      res.json({ success: await SystemPromptVariables.delete(id, store.orm) });
    })
  );
}

module.exports = {
  requireTenantConfiguration,
  registerSettings,
  settingsFor,
  updateEnvironment,
  updatePreferences,
  readSetting,
  readPreference: readSetting,
  defaultPrompt,
  loadPlatformEnvironment,
  environment,
  labelFor,
};
