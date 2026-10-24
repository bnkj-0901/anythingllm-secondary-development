const { AsyncLocalStorage } = require("async_hooks");
const { context, refreshContext, fail } = require("./auth");

const executions = new AsyncLocalStorage();

// Background workers reload an actual user; a stored tenant/user pair is not
// itself an authorization grant and never turns a platform actor into that user.
async function loadExecutionContext(identity) {
  if (!identity?.tenantId || !identity?.userId)
    throw fail(401, "缺少企业执行身份");
  const current = await context(identity.userId);
  if (current.tenantId !== identity.tenantId ||
      (identity.authVersion !== undefined && identity.authVersion !== current.authVersion))
    throw fail(401, "执行身份已失效");
  return current;
}

async function runExecution(identity, task) {
  const current = identity.identity
    ? await refreshContext(identity)
    : await loadExecutionContext(identity);
  return executions.run(Object.freeze(current), () => task(current));
}

function executionContext() {
  const current = executions.getStore();
  if (!current) throw fail(401, "缺少执行身份");
  return current;
}

function optionalExecutionContext() { return executions.getStore() || null; }

module.exports = { loadExecutionContext, runExecution, executionContext, optionalExecutionContext };
