const { handleSourceSelect } = require("./handleSourceSelect");
const { handleSourcePagination } = require("./handleSourcePagination");
const { handleBackSources } = require("./handleBackSources");
const { handleToolApproval } = require("./handleToolApproval");
const { handleThreadSelect } = require("./handleThreadSelect");
const { handleThreadPagination } = require("./handleThreadPagination");

const ExactCallbackHandlers = {
  "src:back": handleBackSources,
  "src:close": handleSourceSelect,
};

const PrefixCallbackHandlers = [
  { prefix: "th:", handler: handleThreadSelect },
  { prefix: "thpg:", handler: handleThreadPagination },
  { prefix: "tool:", handler: handleToolApproval },
  { prefix: "srcpg:", handler: handleSourcePagination },
  { prefix: "src:", handler: handleSourceSelect },
];

/**
 * Resolves the appropriate callback handler for the given data string.
 * First checks exact matches, then prefix matches (in order).
 * @param {string} data - The callback data string
 * @returns {Function|null} - The handler function or null if not found
 */
function resolveCallbackHandler(data) {
  if (ExactCallbackHandlers[data]) {
    return ExactCallbackHandlers[data];
  }

  for (const { prefix, handler } of PrefixCallbackHandlers) {
    if (data.startsWith(prefix)) {
      return handler;
    }
  }

  return null;
}

module.exports = {
  ExactCallbackHandlers,
  PrefixCallbackHandlers,
  resolveCallbackHandler,
};
