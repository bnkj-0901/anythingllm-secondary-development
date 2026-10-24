// Stored SaaS connection names predate the upstream settings names. Keep this
// translation at the boundary; provider classes and model choices stay upstream.
const aliases = {
  "openai-compatible": "generic-openai",
  "azure-openai": "azure",
  voyage: "voyageai",
};
const upstreamName = (provider) => aliases[provider] || provider;

function providerClass(provider, kind) {
  const helpers = require("../../utils/helpers");
  return kind === "embedding"
    ? helpers.getEmbeddingEngineClass(upstreamName(provider))
    : kind === "chat"
      ? helpers.getLLMProviderClass({ provider: upstreamName(provider) })
      : null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

module.exports = {
  upstreamName,
  providerClass,
  deepFreeze,
};
