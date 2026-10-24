const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");
const path = require("path");

const storage = new AsyncLocalStorage();
const runtimeKeys = ["NODE_ENV", "STORAGE_DIR", "DISABLE_TELEMETRY"];
const connectionCaches = new Map();

// The original integrations still consume their environment contract. A tenant
// receives a private copy of those settings for the whole asynchronous call.
// Outside this boundary the integrations retain their original behavior.
const env = new Proxy(Object.create(null), {
  get: (_, key) => (storage.getStore()?.values || process.env)[key],
  set: (_, key, value) => {
    (storage.getStore()?.values || process.env)[key] = String(value);
    return true;
  },
  has: (_, key) => key in (storage.getStore()?.values || process.env),
  deleteProperty: (_, key) => {
    delete (storage.getStore()?.values || process.env)[key];
    return true;
  },
  ownKeys: () => Reflect.ownKeys(storage.getStore()?.values || process.env),
  getOwnPropertyDescriptor: (_, key) => {
    const values = storage.getStore()?.values || process.env;
    if (!(key in values)) return undefined;
    return {
      configurable: true,
      enumerable: true,
      value: values[key],
      writable: true,
    };
  },
});

function runWithEnvironment(values, callback, metadata = {}) {
  const scoped = Object.create(null);
  for (const key of runtimeKeys)
    if (process.env[key] !== undefined) scoped[key] = process.env[key];
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null) scoped[key] = String(value);
  let caches = new Map();
  if (metadata.connection) {
    const connection = metadata.connection;
    const key = `${connection.kind}:${connection.id}`;
    const signature = JSON.stringify([
      connection.provider,
      scoped,
      connection.config.headers,
    ]);
    // Reuse the original integration's model caches across calls to the same
    // connection. Replacing its configuration discards that connection's old
    // cache while in-flight calls retain their own reference.
    if (connectionCaches.get(key)?.signature !== signature)
      connectionCaches.set(key, { signature, caches });
    caches = connectionCaches.get(key).caches;
  }
  return storage.run({ ...metadata, values: scoped, caches }, callback);
}

const prefixes = {
  openai: "OPEN",
  deepseek: "DEEPSEEK",
  cohere: "COHERE",
  anthropic: "ANTHROPIC",
  gemini: "GEMINI_LLM",
  ollama: "OLLAMA",
  openrouter: "OPENROUTER",
  lmstudio: "LMSTUDIO",
  localai: "LOCAL_AI",
  litellm: "LITE_LLM",
  cometapi: "COMETAPI_LLM",
  foundry: "FOUNDRY",
  lemonade: "LEMONADE_LLM",
  apipie: "APIPIE_LLM",
  togetherai: "TOGETHER_AI",
  omlx: "OMLX_LLM",
  "nvidia-nim": "NVIDIA_NIM_LLM",
  groq: "GROQ",
  mistral: "MISTRAL",
  giteeai: "GITEE_AI",
  cerebras: "CEREBRAS",
  sambanova: "SAMBANOVA_LLM",
  fireworksai: "FIREWORKS_AI_LLM",
  llmman: "LLMMAN",
  perplexity: "PERPLEXITY",
  xai: "XAI_LLM",
  zai: "ZAI",
  moonshotai: "MOONSHOT_AI",
  novita: "NOVITA_LLM",
  ppio: "PPIO",
  minimax: "MINIMAX",
  privatemode: "PRIVATEMODE_LLM",
  vertex: "VERTEX_AI_LLM",
  bedrock: "AWS_BEDROCK_LLM",
  "openai-compatible": "GENERIC_OPEN_AI",
  embedded_lemonade: "EMBEDDED_LEMONADE",
  "text-generation-webui": "TEXT_GEN_WEB_UI",
  koboldcpp: "KOBOLD_CPP",
  textgenwebui: "TEXT_GEN_WEB_UI",
};

function connectionEnvironment(connection) {
  const { config, provider, kind } = connection;
  const options = config.options || {};
  const prefix = prefixes[provider] || "GENERIC_OPEN_AI";
  const values = {
    [`${prefix}_API_KEY`]: config.apiKey || "local-no-key",
    [`${prefix}_MODEL_PREF`]: config.model,
    [`${prefix}_BASE_PATH`]: config.baseUrl,
    [`${prefix}_AUTH_TOKEN`]: config.apiKey,
    [`${prefix}_MODEL_TOKEN_LIMIT`]: options.contextWindow,
    [`${prefix}_TOKEN_LIMIT`]: options.contextWindow,
    OMLX_LLM_TOKEN_LIMIT: options.contextWindow,
    [`${prefix}_MAX_TOKENS`]: options.maxTokens,
    [`${prefix}_KEEP_ALIVE_TIMEOUT`]: options.keepAlive,
    [`${prefix}_RESPONSE_TIMEOUT`]: options.timeoutMs,
    [`${prefix}_TIMEOUT_MS`]: options.timeoutMs,
    OPEN_AI_KEY: config.apiKey || "local-no-key",
    OPEN_MODEL_PREF: config.model,
    GENERIC_OPENAI_STREAMING_DISABLED: options.streamingDisabled
      ? "true"
      : undefined,
    AWS_BEDROCK_STREAMING_DISABLED: options.streamingDisabled
      ? "true"
      : undefined,
    GENERIC_OPEN_AI_MODEL_MAX_TOKEN_KEY: options.maxTokensKey,
    GENERIC_OPEN_AI_REPORT_USAGE: options.includeUsage,
    GEMINI_API_KEY: config.apiKey,
    ANTHROPIC_CACHE_CONTROL: options.cacheControl,
    GEMINI_SAFETY_SETTING: options.safetySetting,
    OPENROUTER_TIMEOUT_MS: options.streamTimeout,
    COMETAPI_LLM_TIMEOUT_MS: options.streamTimeout,
    NOVITA_LLM_TIMEOUT_MS: options.streamTimeout,
    OPENROUTER_SERVICE_TIER: options.serviceTier,
    AZURE_OPENAI_ENDPOINT: config.baseUrl,
    AZURE_OPENAI_KEY: config.apiKey,
    AZURE_OPENAI_MODEL_PREF: options.deployment || config.model,
    AZURE_OPENAI_MODEL_TYPE: options.modelType,
    AZURE_OPENAI_TOKEN_LIMIT: options.contextWindow,
    VERTEX_AI_LLM_PROJECT_ID: options.projectId,
    VERTEX_AI_LLM_REGION: options.region,
    AWS_BEDROCK_LLM_REGION: options.region || "us-east-1",
    AWS_BEDROCK_LLM_MODEL_PREFERENCE: config.model,
    EMBEDDING_BASE_PATH: config.baseUrl,
    EMBEDDING_MODEL_PREF:
      provider === "azure" ? options.deployment || config.model : config.model,
    EMBEDDING_MODEL_MAX_CHUNK_LENGTH: options.maxChunkLength,
    EMBEDDING_OUTPUT_DIMENSIONS: options.dimensions,
    GENERIC_OPEN_AI_EMBEDDING_API_KEY: config.apiKey || "local-no-key",
    GENERIC_OPEN_AI_EMBEDDING_MAX_CONCURRENT_CHUNKS: options.batchSize,
    GENERIC_OPEN_AI_EMBEDDING_API_DELAY_MS: options.batchDelayMs,
    GENERIC_OPEN_AI_EMBEDDING_PASSAGE_PREFIX: options.documentPrefix,
    GENERIC_OPEN_AI_EMBEDDING_QUERY_PREFIX: options.queryPrefix,
    OLLAMA_EMBEDDING_BATCH_SIZE: options.batchSize,
    OLLAMA_AUTH_TOKEN: config.apiKey,
    LOCAL_AI_API_KEY: config.apiKey,
    GEMINI_EMBEDDING_API_KEY: config.apiKey,
    VOYAGEAI_API_KEY: config.apiKey,
    EMBEDDING_ENGINE: require("./provider-config").upstreamName(provider),
    LLM_PROVIDER:
      provider === "openai-compatible" ? "generic-openai" : provider,
  };
  // The same provider can serve chat and embeddings under different settings.
  if (kind === "embedding") values.LLM_PROVIDER = undefined;
  return {
    ...require("../settings-environment").sanitizeUpstreamEnvironment(
      config.upstreamEnvironment
    ),
    ...Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined)
    ),
  };
}

function runConnection(connection, options, callback) {
  return runWithEnvironment(connectionEnvironment(connection), callback, {
    connection,
    signal: options?.signal,
  });
}

function scopedFetch(input, init = {}, fetchImpl = globalThis.fetch) {
  const scope = storage.getStore();
  if (!scope) return fetchImpl(input, init);
  const signals = [init.signal, scope.signal].filter(Boolean);
  const timeout = scope.connection?.config.options?.timeoutMs;
  if (timeout) signals.push(AbortSignal.timeout(timeout));
  return fetchImpl(input, {
    ...init,
    ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
  });
}

function sdkOptions(original) {
  const connection = storage.getStore()?.connection;
  if (!connection) return original;
  return {
    ...original,
    // Generic OpenAI already supports custom request headers upstream. Fixed
    // providers keep their own headers and endpoint conventions.
    ...(["generic-openai", "openai-compatible"].includes(connection.provider)
      ? {
          defaultHeaders: {
            ...original.defaultHeaders,
            ...connection.config.headers,
          },
        }
      : {}),
    fetch: (input, init) =>
      scopedFetch(input, init, original.fetch || globalThis.fetch),
  };
}

function scopedCache(original) {
  const scope = storage.getStore();
  if (!scope) return original;
  if (!scope.caches.has(original)) {
    const value =
      original instanceof Set
        ? new Set()
        : original instanceof Map
          ? new Map()
          : Object.create(null);
    scope.caches.set(original, value);
  }
  return scope.caches.get(original);
}

function inConnectionScope() {
  return Boolean(storage.getStore());
}

function scopedCacheFolder(original) {
  const connection = storage.getStore()?.connection;
  if (!connection) return original;
  const identity = crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        connection.id,
        connection.version,
        connection.provider,
        connection.config.baseUrl,
        connection.config.apiKey,
      ])
    )
    .digest("hex");
  return path.join(original, "connections", identity);
}

module.exports = {
  env,
  runWithEnvironment,
  runConnection,
  connectionEnvironment,
  sdkOptions,
  scopedFetch,
  scopedCache,
  scopedCacheFolder,
  inConnectionScope,
};
