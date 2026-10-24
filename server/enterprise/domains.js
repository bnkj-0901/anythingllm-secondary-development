const { domainToASCII } = require("url");
const { isIP } = require("net");
const store = require("./store");

const fail = (status, message) => Object.assign(new Error(message), { status });

function normalizeHostname(value, { allowPort = true } = {}) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    /[\s/@?#\\%]/.test(value)
  )
    return null;
  let host = value.toLowerCase();
  if (host.startsWith("[")) {
    const match = host.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (
      !match ||
      isIP(match[1]) !== 6 ||
      (!allowPort && match[2]) ||
      Number(match[2] || 1) > 65535
    )
      return null;
    return match[1];
  }
  if (isIP(host) === 6) return host;
  const colon = host.lastIndexOf(":");
  if (colon !== -1) {
    if (
      !allowPort ||
      !/^\d{1,5}$/.test(host.slice(colon + 1)) ||
      Number(host.slice(colon + 1)) > 65535
    )
      return null;
    host = host.slice(0, colon);
  }
  host = domainToASCII(host.replace(/\.$/, ""));
  if (
    !host ||
    host.length > 253 ||
    host
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return null;
  return host;
}

function routingConfig() {
  const production = process.env.NODE_ENV === "production";
  const baseDomain = normalizeHostname(
    process.env.TENANT_BASE_DOMAIN || (production ? "" : "localhost"),
    { allowPort: false }
  );
  const rawPlatform =
    process.env.PLATFORM_HOSTS ||
    (production ? "" : "localhost,127.0.0.1,::1,admin.localhost");
  const platformHosts = [
    ...new Set(
      rawPlatform
        .split(",")
        .map((host) => normalizeHostname(host.trim(), { allowPort: false }))
    ),
  ];
  if (
    (process.env.TENANT_BASE_DOMAIN && !baseDomain) ||
    (baseDomain && isIP(baseDomain)) ||
    !platformHosts.length ||
    platformHosts.some((host) => !host)
  )
    throw fail(503, "域名入口尚未配置，请联系平台管理员");
  return { baseDomain, platformHosts };
}

async function resolveSite(req, db = store) {
  const routing = routingConfig();
  const hostname = normalizeHostname(req.headers?.host);
  const site = { kind: "unknown", hostname: hostname || "" };
  if (!hostname) return site;
  if (routing.platformHosts.includes(hostname))
    return { kind: "platform", hostname };
  const tenant = await db.one(
    "SELECT id,code,name FROM ep_tenants WHERE hostname=$1 AND status='active'",
    hostname
  );
  return tenant ? { kind: "tenant", hostname, tenant } : site;
}

async function requirePlatformSite(req) {
  const site = await resolveSite(req);
  if (site.kind !== "platform") throw fail(403, "请通过平台管理域名访问此入口");
  return site;
}

function managedHostname(code) {
  const { baseDomain } = routingConfig();
  if (!baseDomain)
    throw fail(400, "请为租户配置完整访问域名，或由平台配置默认主域名");
  return `${code}.${baseDomain}`;
}

async function tenantEntry(company) {
  const webHost = company.hostname;
  const production = process.env.NODE_ENV === "production";
  const protocol =
    process.env.TENANT_WEB_PROTOCOL || (production ? "https" : "http");
  if (!["http", "https"].includes(protocol))
    throw fail(503, "企业网页协议配置无效，请联系平台管理员");
  const port = process.env.TENANT_WEB_PORT || (production ? "" : "3000");
  if (
    port &&
    (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  )
    throw fail(503, "企业网页端口配置无效，请联系平台管理员");
  return {
    ...company,
    webHost,
    webURL: webHost ? `${protocol}://${webHost}${port ? `:${port}` : ""}` : "",
  };
}

function tenantHostname(value) {
  const hostname = normalizeHostname(value, { allowPort: false });
  if (
    !hostname ||
    !hostname.includes(".") ||
    isIP(hostname) ||
    routingConfig().platformHosts.includes(hostname)
  )
    throw fail(400, "请输入完整租户域名，不能使用 IP 或平台管理域名");
  return hostname;
}

module.exports = {
  normalizeHostname,
  routingConfig,
  resolveSite,
  requirePlatformSite,
  managedHostname,
  tenantEntry,
  tenantHostname,
};
