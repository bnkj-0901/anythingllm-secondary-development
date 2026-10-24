const store = require("./store");
const providers = require("./providers");
const { connectionEnvironment } = require("./ai/connection-context");
const { providerClass, upstreamName } = require("./ai/provider-config");
const { allowedRules } = require("./settings-environment");
const { fail } = require("./auth");

const aliases = {
  "generic-openai": "openai-compatible",
  "azure-openai": "azure",
};
const sharedCredentialFields = new Set([
  "OpenAiKey",
  "AzureOpenAiKey",
  "CohereApiKey",
  "MistralApiKey",
  "OpenRouterApiKey",
  "LiteLLMApiKey",
  "LocalAiApiKey",
  "LMStudioAuthToken",
  "LemonadeLLMApiKey",
  "OllamaLLMAuthToken",
]);
const numericOptions = new Set([
  "temperature",
  "contextWindow",
  "maxTokens",
  "timeoutMs",
  "streamTimeout",
  "maxChunkLength",
  "dimensions",
  "batchSize",
  "batchDelayMs",
]);

function identityChanged(prior, value) {
  const config = providers.hydrate(prior).config;
  const spaceOptions = (options) =>
    Object.fromEntries(
      ["dimensions", "queryPrefix", "documentPrefix", "deployment"]
        .filter((key) => options?.[key] !== undefined)
        .map((key) => [key, options[key]])
    );
  return (
    prior.provider !== value.provider ||
    prior.model !== value.model ||
    prior.baseUrl !== value.baseUrl ||
    (prior.kind !== "embedding" &&
      (config.apiKey !== value.credentials.apiKey ||
        JSON.stringify(config.headers || {}) !==
          JSON.stringify(value.credentials.headers || {}))) ||
    JSON.stringify(
      prior.kind === "embedding" ? spaceOptions(config.options) : config.options
    ) !==
      JSON.stringify(
        prior.kind === "embedding" ? spaceOptions(value.options) : value.options
      )
  );
}

async function defaultRow(ctx, kind, db = store) {
  return db.one(
    "SELECT * FROM ep_connections WHERE scope='platform' AND kind=$1 AND \"isDefault\"=1",
    kind
  );
}

// Derive the original form-field contract from the existing runtime adapter,
// instead of maintaining a second provider-to-model/credential mapping.
function formTargets(provider, kind) {
  const optionNames = [
    "temperature",
    "contextWindow",
    "maxTokens",
    "keepAlive",
    "timeoutMs",
    "cacheControl",
    "safetySetting",
    "streamTimeout",
    "serviceTier",
    "deployment",
    "modelType",
    "projectId",
    "region",
    "maxChunkLength",
    "dimensions",
    "batchSize",
    "documentPrefix",
    "queryPrefix",
    "batchDelayMs",
    "maxTokensKey",
    "includeUsage",
    "streamingDisabled",
  ];
  const options = Object.fromEntries(
    optionNames.map((key) => [key, `option:${key}`])
  );
  const probe = connectionEnvironment({
    provider,
    kind,
    config: {
      model: "field:model",
      baseUrl: "field:baseUrl",
      apiKey: "field:apiKey",
      options,
    },
  });
  return Object.fromEntries(
    Object.entries(allowedRules()).flatMap(([field, rule]) => {
      const marker = probe[rule.envKey];
      return typeof marker === "string" && /^(field|option):/.test(marker)
        ? [[field, marker.split(":")]]
        : [];
    })
  );
}

function belongsToProvider(provider, kind, field) {
  if (kind === "chat" && /Embedding|Voyage/.test(field)) return false;
  if (
    kind === "embedding" &&
    !(
      /Embedding|Voyage/.test(field) ||
      field === "AzureOpenAiEndpoint" ||
      sharedCredentialFields.has(field)
    )
  )
    return false;
  const providerKey = provider.replace(/[^a-z]/g, "");
  const fieldKey = field.toLowerCase().replace(/[^a-z]/g, "");
  return (
    fieldKey.startsWith(providerKey) ||
    (provider === "openai" && field.startsWith("OpenAi")) ||
    (provider === "openai-compatible" && field.startsWith("GenericOpenAi")) ||
    (provider === "azure" && field.startsWith("AzureOpenAi")) ||
    (provider === "bedrock" && field.startsWith("AwsBedrock")) ||
    (provider === "vertex" && field.startsWith("VertexAi")) ||
    (provider === "native" && field.startsWith("Embedding")) ||
    (kind === "embedding" && field.startsWith("Embedding"))
  );
}

async function saveDefault(ctx, kind, updates, db = store, saved = {}) {
  if (ctx.identity !== "platform") throw fail(403, "模型连接由顶级管理员维护");
  const selector = kind === "chat" ? "LLMProvider" : "EmbeddingEngine";
  const own = await defaultRow(ctx, kind, db);
  const provider =
    aliases[updates[selector]] || updates[selector] || own?.provider;
  if (!providerClass(provider, kind))
    throw fail(400, "当前模型供应商不支持此用途");
  const prior =
    own?.provider === provider ? providers.hydrate(own).config : null;
  const draft = {
    kind,
    provider,
    name: own?.name || `${provider} ${kind === "chat" ? "LLM" : "Embedding"}`,
    // Presets and defaults belong to the original forms and constructors.
    // Empty values let the upstream integration apply its own default.
    model: prior?.model || "",
    baseUrl: prior?.baseUrl || "",
    options: { ...(prior?.options || {}) },
    available: true,
    isDefault: true,
  };
  if (provider === "native" && !prior)
    draft.model =
      require("../utils/EmbeddingEngines/native").NativeEmbedder._getEmbeddingModel();
  const targetMap = formTargets(provider, kind);
  const upstreamEnvironment = { ...(prior?.upstreamEnvironment || {}) };
  const selected = { ...updates };
  const savedProvider =
    aliases[saved[kind === "chat" ? "LLM_PROVIDER" : "EMBEDDING_ENGINE"]] ||
    saved[kind === "chat" ? "LLM_PROVIDER" : "EMBEDDING_ENGINE"];
  if (!prior)
    for (const [field, { envKey }] of Object.entries(allowedRules()))
      if (
        !(field in selected) &&
        belongsToProvider(provider, kind, field) &&
        saved[envKey] !== undefined &&
        // Original shared fields cannot identify another provider or purpose.
        // A current same-provider connection is the only source for its key.
        !sharedCredentialFields.has(field) &&
        (!field.startsWith("Embedding") || savedProvider === provider)
      )
        selected[field] = saved[envKey];
  for (const [field, value] of Object.entries(selected)) {
    if (field !== selector && !belongsToProvider(provider, kind, field))
      continue;
    const rule = allowedRules()[field];
    if (rule) upstreamEnvironment[rule.envKey] = String(value);
    const target = targetMap[field];
    if (!target) continue;
    const [type, key] = target;
    if (type === "field") draft[key] = value;
    else {
      draft.options[key] = numericOptions.has(key)
        ? Number(value)
        : key === "streamingDisabled"
          ? String(value) === "true"
          : key === "modelType" && value === "default"
            ? "chat"
            : String(value);
    }
  }
  if (kind === "embedding" && selected.AzureOpenAiEmbeddingModelPref)
    draft.model = selected.AzureOpenAiEmbeddingModelPref;
  // All incoming form fields have passed the upstream KEY_MAPPING checks in
  // settings.updateEnvironment. Do not validate them through a second catalog.
  const value = {
    ...draft,
    credentials: {
      apiKey: draft.apiKey || prior?.apiKey || "",
      headers: prior?.headers || {},
      upstreamEnvironment,
    },
  };
  const needsKey = Object.entries(targetMap).some(
    ([field, target]) =>
      target[0] === "field" &&
      target[1] === "apiKey" &&
      belongsToProvider(provider, kind, field) &&
      allowedRules()[field]?.checks?.some(
        (check) => check.name === "isNotEmpty"
      )
  );
  if (needsKey && !value.credentials.apiKey)
    throw fail(400, "请填写当前供应商的 API 密钥");
  if (provider === "native") {
    if (
      !require("../utils/EmbeddingEngines/native").NativeEmbedder
        .supportedModels[value.model]
    )
      throw fail(400, "本地模式只支持原配置页列出的 Embedding 模型");
    value.credentials.apiKey = "";
    value.credentials.headers = {};
  }
  const stamp = store.now();
  if (own) {
    const changed =
      identityChanged(own, value) ||
      (kind !== "embedding" &&
        JSON.stringify(prior?.upstreamEnvironment || {}) !==
          JSON.stringify(upstreamEnvironment));
    await db.run(
      'UPDATE ep_connections SET provider=$1,name=$2,model=$3,"baseUrl"=$4,secret=$5,options=$6,version=$7,available=1,"updatedAt"=$8 WHERE id=$9',
      value.provider,
      value.name,
      value.model,
      value.baseUrl,
      providers.encrypt(JSON.stringify(value.credentials)),
      JSON.stringify(value.options),
      own.version + (changed ? 1 : 0),
      stamp,
      own.id
    );
  } else {
    await db.run(
      'INSERT INTO ep_connections(id,"tenantId",scope,kind,provider,name,model,"baseUrl",secret,options,available,"isDefault","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,$11,$12)',
      store.id(),
      ctx.identity === "platform" ? null : ctx.tenantId,
      ctx.identity === "platform" ? "platform" : "tenant",
      kind,
      value.provider,
      value.name,
      value.model,
      value.baseUrl,
      providers.encrypt(JSON.stringify(value.credentials)),
      JSON.stringify(value.options),
      stamp,
      stamp
    );
  }
}

async function projectConnections(
  ctx,
  environment,
  db = store,
  _inherit = true,
  purpose = "chat"
) {
  const result = { ...environment };
  for (const kind of purpose === "embedding"
    ? ["chat", "embedding"]
    : ["embedding", "chat"]) {
    const row = await defaultRow(ctx, kind, db);
    if (!row) continue;
    const connection = providers.hydrate(row);
    const generated = connectionEnvironment(connection);
    // Only fields used by this provider are projected. Shared aliases from the
    // runtime environment must not overwrite the other default connection.
    const targets = formTargets(row.provider, kind);
    for (const field of Object.keys(targets)) {
      const rule = allowedRules()[field];
      if (!rule) continue;
      if (!belongsToProvider(row.provider, kind, field)) continue;
      const setting = generated[rule.envKey];
      if (setting !== undefined)
        result[rule.envKey] =
          field === "AzureOpenAiModelType" && setting === "chat"
            ? "default"
            : String(setting);
    }
    if (kind === "embedding") {
      result.EMBEDDING_ENGINE = upstreamName(row.provider);
      result.EMBEDDING_MODEL_PREF = connection.config.model;
      if (row.provider !== "native")
        result.EMBEDDING_BASE_PATH = connection.config.baseUrl;
    } else result.LLM_PROVIDER = upstreamName(row.provider);
  }
  return result;
}

module.exports = {
  defaultRow,
  formTargets,
  saveDefault,
  projectConnections,
  upstreamName,
};
