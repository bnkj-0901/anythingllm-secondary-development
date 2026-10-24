// The original Collector owns its preset converters and unknown-text fallback.
// These extensions describe presets for upload hints; they are not an allowlist.
const {
  SUPPORTED_FILETYPE_CONVERTERS,
} = require("../../../collector/utils/constants");
const extensions = Object.freeze(Object.keys(SUPPORTED_FILETYPE_CONVERTERS));
const textFallback = true;
// The upstream document uploader has no fixed per-file product quota. Operators
// can set a deployment limit without changing library permissions or parsers.
const configuredLimit = Number(process.env.KNOWLEDGE_MAX_FILE_BYTES);
const maxFileSizeBytes =
  Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : Number.MAX_SAFE_INTEGER;
module.exports = { extensions, textFallback, maxFileSizeBytes };
