const bcrypt = require("bcryptjs");
const { createHash, randomBytes } = require("crypto");
const store = require("./store");
const { fail, context, signed, assertManagerContext } = require("./auth");
const { resolveSite } = require("./domains");
const { generateRecoveryCodes } = require("../utils/PasswordRecovery");

const label = (tenantId) => `saas:tenant:${tenantId}:wechat`;
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

async function configuration(tenantId, db = store) {
  const row = await db.one(
    "SELECT value FROM system_settings WHERE label=$1",
    label(tenantId)
  );
  if (!row?.value) return { appId: "", appSecret: "", enabled: false };
  try {
    const value = JSON.parse(require("./providers").decrypt(row.value));
    if (
      !value ||
      typeof value.appId !== "string" ||
      typeof value.appSecret !== "string" ||
      typeof value.enabled !== "boolean"
    )
      throw new Error("Invalid WeChat configuration");
    return value;
  } catch {
    throw fail(503, "微信登录配置无法读取，请联系管理员重新保存");
  }
}

const safeConfiguration = (value) => ({
  appId: value.appId,
  enabled: value.enabled,
  hasSecret: !!value.appSecret,
});

async function loginEnabled(tenantId) {
  try {
    const value = await configuration(tenantId);
    return !!(value.enabled && value.appId && value.appSecret);
  } catch {
    return false;
  }
}

async function exchangeCode(config, code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let result;
  try {
    const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
    url.search = new URLSearchParams({
      appid: config.appId,
      secret: config.appSecret,
      js_code: code,
      grant_type: "authorization_code",
    });
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw fail(502, "微信登录服务暂时不可用，请稍后重试");
    result = await response.json();
  } catch {
    if (controller.signal.aborted)
      throw fail(504, "微信登录服务响应超时，请稍后重试");
    throw fail(502, "微信登录服务暂时不可用，请稍后重试");
  } finally {
    clearTimeout(timer);
  }
  if ([40029, 40163].includes(Number(result?.errcode)))
    throw fail(401, "微信登录凭证已失效，请重新登录");
  if (
    !result ||
    (result.errcode && Number(result.errcode) !== 0) ||
    typeof result.openid !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(result.openid)
  )
    throw fail(502, "微信登录服务返回无效结果，请联系管理员");
  return result.openid;
}

function registerWechat(router, { requirePlatformAuth, limitLogin }) {
  router.get(
    "/platform/tenants/:tenantId/wechat",
    requirePlatformAuth,
    wrap(async (req, res) => {
      const tenant = await store.one(
        "SELECT id FROM ep_tenants WHERE id=$1",
        req.params.tenantId
      );
      if (!tenant) throw fail(404, "企业不存在");
      res.json(safeConfiguration(await configuration(tenant.id)));
    })
  );
  router.put(
    "/platform/tenants/:tenantId/wechat",
    requirePlatformAuth,
    wrap(async (req, res) => {
      const input = req.body || {};
      if (
        Object.keys(input).some(
          (key) => !["appId", "appSecret", "enabled"].includes(key)
        ) ||
        typeof input.appId !== "string" ||
        !/^wx[a-zA-Z0-9]{16}$/.test(input.appId.trim()) ||
        typeof input.enabled !== "boolean" ||
        (Object.hasOwn(input, "appSecret") &&
          (typeof input.appSecret !== "string" || input.appSecret.length > 256))
      )
        throw fail(400, "微信登录配置无效，请填写 AppID、AppSecret 和启用状态");
      const result = await store.transaction(
        async (tx) => {
          await assertManagerContext(req.ep, tx);
          const tenant = await tx.one(
            "SELECT id FROM ep_tenants WHERE id=$1",
            req.params.tenantId
          );
          if (!tenant) throw fail(404, "企业不存在");
          const current = input.appSecret?.trim()
            ? { appSecret: "" }
            : await configuration(tenant.id, tx);
          const value = {
            appId: input.appId.trim(),
            appSecret: input.appSecret?.trim() || current.appSecret,
            enabled: input.enabled,
          };
          if (value.enabled && !value.appSecret)
            throw fail(400, "启用微信登录前请配置 AppSecret");
          await tx.run(
            'INSERT INTO system_settings(label,value,"createdAt","lastUpdatedAt") VALUES($1,$2,NOW(),NOW()) ON CONFLICT(label) DO UPDATE SET value=EXCLUDED.value,"lastUpdatedAt"=NOW()',
            label(tenant.id),
            require("./providers").encrypt(JSON.stringify(value))
          );
          return safeConfiguration(value);
        },
        { retry: true }
      );
      res.json(result);
    })
  );
  router.post(
    "/wechat/login",
    wrap(async (req, res) => {
      const input = req.body || {};
      if (
        Object.keys(input).some((key) => key !== "code") ||
        typeof input.code !== "string" ||
        !input.code.trim() ||
        input.code.length > 1024
      )
        throw fail(400, "请仅提交微信登录凭证，企业和用户身份由服务端确定");
      const site = await resolveSite(req);
      limitLogin(
        req,
        `wechat:${site.kind === "tenant" ? site.tenant.id : "unknown"}`
      );
      if (site.kind !== "tenant") throw fail(403, "请通过企业小程序登录");
      if (!process.env.JWT_SECRET) throw fail(503, "服务认证密钥未配置");
      const config = await configuration(site.tenant.id);
      if (!config.enabled || !config.appId || !config.appSecret)
        throw fail(403, "当前企业尚未启用微信登录");
      const openid = await exchangeCode(config, input.code.trim());
      const wechatIdentity = `${config.appId}:${openid}`;
      const existing = await store.one(
        'SELECT id FROM users WHERE "tenantId"=$1 AND "wechatIdentity"=$2',
        site.tenant.id,
        wechatIdentity
      );
      const hash = existing
        ? null
        : await bcrypt.hash(randomBytes(48).toString("base64url"), 12);
      const registerUser = async (tx) => {
        const tenant = await tx.one(
          "SELECT id FROM ep_tenants WHERE id=$1 AND status='active' FOR SHARE",
          site.tenant.id
        );
        if (!tenant) throw fail(403, "企业已停用");
        const current = await configuration(tenant.id, tx);
        if (
          !current.enabled ||
          current.appId !== config.appId ||
          current.appSecret !== config.appSecret
        )
          throw fail(403, "微信登录配置已变更，请重新登录");
        const user = await tx.one(
          'SELECT id FROM users WHERE "tenantId"=$1 AND "wechatIdentity"=$2',
          tenant.id,
          wechatIdentity
        );
        if (user) return user.id;
        const baseUsername = `wx_${createHash("sha256").update(wechatIdentity).digest("hex").slice(0, 40)}`;
        const taken = await tx.one(
          'SELECT id FROM users WHERE "tenantId"=$1 AND username=$2',
          tenant.id,
          baseUsername
        );
        const created = await tx.one(
          'INSERT INTO users("tenantId",username,name,"passwordHash",role,"wechatIdentity","wechatRegistrationComplete","createdAt","lastUpdatedAt") VALUES($1,$2,$3,$4,\'user\',$5,false,NOW(),NOW()) ON CONFLICT("tenantId","wechatIdentity") DO UPDATE SET "wechatIdentity"=EXCLUDED."wechatIdentity" RETURNING id,name',
          tenant.id,
          taken
            ? `${baseUsername}_${randomBytes(6).toString("hex")}`
            : baseUsername,
          "微信用户",
          hash ||
            (await bcrypt.hash(randomBytes(48).toString("base64url"), 12)),
          wechatIdentity
        );
        if (created.name === "微信用户")
          await tx.run(
            'UPDATE users SET name=$1 WHERE id=$2 AND "tenantId"=$3 AND name=$4',
            `用户${created.id}`,
            created.id,
            tenant.id,
            "微信用户"
          );
        return created.id;
      };
      let id;
      try {
        id = await store.transaction(registerUser, { retry: true });
      } catch (error) {
        // Concurrent first logins can collide on the generated username before
        // PostgreSQL applies the identity upsert. A fresh transaction sees the winner.
        const uniqueViolation =
          error.code === "23505" ||
          error.code === "P2002" ||
          error.meta?.code === "23505";
        const target = error.meta?.target;
        const identityCollision =
          /users_tenantId_(?:username|wechatIdentity)_key|Key \("tenantId", (?:username|"wechatIdentity")\)/.test(
            error.meta?.message || error.message || ""
          ) ||
          (Array.isArray(target) &&
            target.length === 2 &&
            target.includes("tenantId") &&
            (target.includes("username") || target.includes("wechatIdentity")));
        if (!uniqueViolation || !identityCollision) throw error;
        id = await store.transaction(registerUser, { retry: true });
      }
      const ctx = await context(id);
      const recoveryCodes = ctx.wechatRegistrationRequired
        ? []
        : await generateRecoveryCodes(
        ctx.tenantId,
        ctx.userId,
        store
      );
      res.json({
        ...signed(ctx),
        ...(recoveryCodes.length ? { recoveryCodes } : {}),
      });
    })
  );
}

module.exports = { registerWechat, loginEnabled, exchangeCode };
