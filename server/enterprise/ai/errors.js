const providerError = (status, message) =>
  Object.assign(new Error(message), {
    status,
    enterpriseProvider: true,
  });

function safeError(error) {
  if (error?.enterpriseGuard || error?.enterpriseProvider) return error;
  const status = Number(error?.status);
  if (status === 401 || status === 403)
    return providerError(502, "模型服务拒绝认证，请检查 API 密钥与访问权限");
  if (status === 404) return providerError(502, "模型服务地址或模型名称不存在");
  if (status === 429)
    return providerError(502, "模型服务限流或额度不足，请稍后重试");
  if (
    error?.name === "TimeoutError" ||
    error?.name === "AbortError" ||
    /timeout/i.test(error?.message || "")
  )
    return providerError(504, "模型服务响应超时，请稍后重试");
  return providerError(
    502,
    `模型连接失败${status ? `（HTTP ${status}）` : "，请检查服务地址和网络"}`
  );
}

module.exports = { safeError, providerError };
