const BLOCKED_FIELDS = new Set(["AuthToken", "JWTSecret", "ModelRouterId"]);

function rules() {
  return require("../utils/helpers/updateENV").KEY_MAPPING;
}

function allowedRules() {
  return Object.fromEntries(
    Object.entries(rules()).filter(([key]) => !BLOCKED_FIELDS.has(key))
  );
}

function secretField(field) {
  return /(?:key|password|authToken|apiToken|applicationToken|connectionString)$/i.test(
    field
  );
}

// Only original product settings may enter a provider's private environment.
// Runtime paths, JWT/signing keys and arbitrary process variables never do.
function sanitizeUpstreamEnvironment(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider environment");
  const allowed = new Set(
    Object.values(allowedRules()).map((rule) => rule.envKey)
  );
  const result = {};
  for (const [key, setting] of Object.entries(value)) {
    if (
      !allowed.has(key) ||
      typeof setting !== "string" ||
      setting.length > 32768
    )
      throw new Error("Invalid provider environment");
    result[key] = setting;
  }
  return result;
}

module.exports = {
  rules,
  allowedRules,
  secretField,
  sanitizeUpstreamEnvironment,
};
