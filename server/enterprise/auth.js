const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const store = require("./store");
const { User } = require("../models/user");
const { extensions, maxFileSizeBytes } = require("../utils/files/types");
const {
  resolveSite,
  routingConfig,
  requirePlatformSite,
  managedHostname,
  tenantEntry,
  tenantHostname,
} = require("./domains");
const {
  generateRecoveryCodes,
  recoverAccount,
  resetPassword,
} = require("../utils/PasswordRecovery");

const TENANT_AUDIENCE = "enterprise-tenant-v1";
const PLATFORM_AUDIENCE = "enterprise-platform-v1";
const DUMMY_HASH =
  "$2b$12$SlD4ZF8FO5ew6GMRpL3HCeofqXej1mCyRhXbMNUl1O..KZSU9A8ve";
const fail = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const secret = () => {
  if (!process.env.JWT_SECRET) throw fail(503, "服务认证密钥未配置");
  return process.env.JWT_SECRET;
};

function text(value, label, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw fail(400, `${label}不能为空，最长 ${max} 个字符`);
  return value.trim();
}

function password(value) {
  const check = User.checkPasswordComplexity(value);
  if (!check.checkedOK) throw fail(400, check.error);
  return value;
}

function username(value) {
  try {
    return User.validations.username(text(value, "账号", 64).toLowerCase());
  } catch (error) {
    throw fail(400, error.message);
  }
}

function requireTenantOwnedAccount(body) {
  if (
    [
      "tenantId",
      "tenantCode",
      "identity",
      "platformRole",
      "platformAdmin",
    ].some((key) => Object.prototype.hasOwnProperty.call(body, key))
  )
    throw fail(400, "用户只属于当前企业，不能指定企业归属或平台身份");
}

function tenantCode(value) {
  const normalized = text(value, "租户标识", 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(normalized))
    throw fail(
      400,
      "租户标识为 3—40 位英文字母、数字或短横线，以字母或数字开头和结尾"
    );
  return normalized;
}

const session = (ctx) => ({
  identity: ctx.identity,
  user: {
    id: ctx.userId,
    username: ctx.username,
    name: ctx.name,
    bio: ctx.bio || "",
    pfpFilename: ctx.pfpFilename || null,
    wechatBound: ctx.wechatBound === true,
    wechatRegistrationRequired: ctx.wechatRegistrationRequired === true,
  },
  tenant:
    ctx.identity === "tenant"
      ? { id: ctx.tenantId, code: ctx.tenantCode, name: ctx.tenantName }
      : null,
  role: ctx.role,
});

async function context(userId, db = store) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) < 1) throw fail(401, "请先登录企业账号");
  const row = await User.authenticationContext(Number(userId), db);
  if (
    !row ||
    row.status !== "active" ||
    row.tenantStatus !== "active" ||
    !["admin", "user"].includes(row.role)
  )
    throw fail(401, "账号或租户已停用，请联系管理员");
  return {
    ...row,
    identity: "tenant",
    userId: row.id,
    user: {
      id: row.id,
      username: row.username,
      name: row.name,
      bio: row.bio || "",
      pfpFilename: row.pfpFilename || null,
      wechatBound: row.wechatBound === true,
      wechatRegistrationRequired: row.wechatRegistrationRequired === true,
    },
    tenant: { id: row.tenantId, code: row.tenantCode, name: row.tenantName },
  };
}

async function platformContext(userId, db = store) {
  const row = await db.one(
    'SELECT id,username,name,status,"authVersion" FROM ep_platform_accounts WHERE id=$1',
    userId
  );
  if (!row || row.status !== "active")
    throw fail(401, "账号已停用，请联系管理员");
  return {
    ...row,
    identity: "platform",
    userId: row.id,
    role: "platform_admin",
    user: { id: row.id, username: row.username, name: row.name },
    tenant: null,
  };
}

async function refreshContext(ctx, db = store) {
  if (ctx?.identity === "platform") {
    const current = await platformContext(ctx.userId, db);
    if (ctx.authVersion !== undefined && current.authVersion !== ctx.authVersion)
      throw fail(401, "登录已失效，请重新登录");
    return current;
  }
  if (!ctx || (ctx.identity && ctx.identity !== "tenant"))
    throw fail(401, "请先登录企业账号");
  const current = await context(ctx.userId, db);
  if (
    current.tenantId !== ctx.tenantId ||
    (ctx.authVersion !== undefined && current.authVersion !== ctx.authVersion)
  )
    throw fail(401, "登录已失效，请重新登录");
  return current;
}

async function assertTenantAdmin(ctx, db = store) {
  const current = await refreshContext(ctx, db);
  if (current.role !== "admin") throw fail(403, "需要租户管理员权限");
  return current;
}

// Revalidate inside the write transaction: a request may have been queued while
// another administrator revoked its role, changed its password or disabled it.
async function assertManagerContext(ctx, db = store) {
  if (ctx?.identity !== "platform") return assertTenantAdmin(ctx, db);
  const current = await platformContext(ctx.userId, db);
  if (current.authVersion !== ctx.authVersion)
    throw fail(401, "登录已失效，请重新登录");
  return current;
}

function claimsFor(req, audience, identity) {
  let claims;
  try {
    claims = jwt.verify(
      (req.headers.authorization || "").replace(/^Bearer /i, ""),
      secret(),
      { audience, algorithms: ["HS256"] }
    );
  } catch {
    throw fail(401, "请先登录");
  }
  if (
    claims.identity !== identity ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    !Number.isInteger(claims.ver)
  )
    throw fail(401, "请先登录");
  return claims;
}

const requireAuth = wrap(async (req, res, next) => {
  const claims = claimsFor(req, TENANT_AUDIENCE, "tenant");
  const ctx = await context(claims.sub);
  if (claims.tenantId !== ctx.tenantId || claims.ver !== ctx.authVersion)
    throw fail(401, "登录已失效，请重新登录");
  const site = await resolveSite(req);
  if (site.kind !== "tenant" || site.tenant.id !== ctx.tenantId)
    throw fail(401, "当前企业域名与登录身份不匹配，请从企业入口重新登录");
  if (
    ctx.wechatRegistrationRequired &&
    !["/me", "/me/avatar"].includes(req.path)
  )
    throw fail(428, "请先完成头像、昵称和密码注册");
  req.ep = ctx;
  next();
});

const requirePlatformAuth = wrap(async (req, res, next) => {
  const claims = claimsFor(req, PLATFORM_AUDIENCE, "platform");
  const ctx = await platformContext(claims.sub);
  if (claims.ver !== ctx.authVersion) throw fail(401, "登录已失效，请重新登录");
  await requirePlatformSite(req);
  req.ep = ctx;
  next();
});

async function authenticate(req, res, next) {
  try {
    const site = await resolveSite(req);
    const authenticateSite = site.kind === "platform" ? requirePlatformAuth : requireAuth;
    return authenticateSite(req, res, (error) => {
      if (error) return next(error);
      res.locals.user = { ...req.ep.user, tenantId: req.ep.tenantId,
        role: req.ep.role, identity: req.ep.identity, authVersion: req.ep.authVersion };
      res.locals.multiUserMode = true;
      next();
    });
  } catch (error) {
    next(error);
  }
}

const requireTenantAdmin = (req, res, next) =>
  req.ep?.identity === "tenant" && req.ep.role === "admin"
    ? next()
    : next(fail(403, "需要租户管理员权限"));

function signed(ctx) {
  return {
    ...session(ctx),
    token: jwt.sign(
      {
        identity: ctx.identity,
        ver: ctx.authVersion,
        ...(ctx.identity === "tenant" ? { tenantId: ctx.tenantId } : {}),
      },
      secret(),
      {
        subject: String(ctx.userId),
        audience:
          ctx.identity === "tenant" ? TENANT_AUDIENCE : PLATFORM_AUDIENCE,
        expiresIn: process.env.JWT_EXPIRY || "30d",
        algorithm: "HS256",
      }
    ),
  };
}

async function createAccount(tx, tenantId, data) {
  const accountName = username(data.username);
  const hash = await bcrypt.hash(password(data.password), 12);
  const stamp = new Date();
  const user = await User.create(
    {
      tenantId,
      username: accountName,
      name: User.validations.name(data.name || accountName),
      passwordHash: hash,
      role: data.role === "admin" ? "admin" : "user",
      dailyMessageLimit: data.dailyMessageLimit,
      createdAt: stamp,
    },
    tx
  );
  return user.id;
}

const attempts = new Map();
function limitLogin(req, identity) {
  const key = `${identity}:${req.ip}`,
    stamp = Date.now(),
    prior = attempts.get(key);
  if (prior && stamp - prior.start < 60000 && prior.count >= 15)
    throw fail(429, "尝试次数过多，请一分钟后重试");
  if (!prior || stamp - prior.start >= 60000)
    attempts.set(key, { start: stamp, count: 1 });
  else prior.count++;
  if (attempts.size > 10000) {
    for (const [k, v] of attempts)
      if (stamp - v.start >= 60000) attempts.delete(k);
    while (attempts.size > 10000) attempts.delete(attempts.keys().next().value);
  }
}

function loginText(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

async function validPassword(user, value) {
  const candidate = typeof value === "string" ? value : "";
  const valid = await bcrypt.compare(
    candidate.slice(0, 251),
    user?.passwordHash || DUMMY_HASH
  );
  return !!user && candidate.length > 0 && candidate.length <= 250 && valid;
}

async function loginContext(user, valid, identity) {
  if (!valid) throw fail(401, "账号或密码不正确");
  try {
    return identity === "tenant"
      ? await context(user.id)
      : await platformContext(user.id);
  } catch (error) {
    if (error.status === 401) throw fail(401, "账号或密码不正确");
    throw error;
  }
}

const userHandlers = {
    list: wrap(async (req, res) => {
      res.json({ users: await User.list(req.userTenantId, store) });
    }),
    avatar: wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw fail(404, "用户不存在");
      const user = await User.get(req.userTenantId, id, store);
      if (!user) throw fail(404, "用户不存在");
      sendAvatar(res, user.pfpFilename);
    }),
    create: wrap(async (req, res) => {
      requireTenantOwnedAccount(req.body);
      if (!["admin", "user"].includes(req.body.role || "user"))
        throw fail(400, "角色无效");
      const id = await store.transaction(async (tx) => {
        await assertManagerContext(req.ep, tx);
        if (!await tx.one("SELECT id FROM ep_tenants WHERE id=$1", req.userTenantId))
          throw fail(404, "租户不存在");
        return createAccount(tx, req.userTenantId, req.body);
      });
      res.status(201).json({ user: { id } });
    }),
    update: wrap(async (req, res) => {
      requireTenantOwnedAccount(req.body);
      await store.transaction(async (tx) => {
        await assertManagerContext(req.ep, tx);
        // Serialize administrator changes so two requests cannot remove the last admin.
        await tx.one('SELECT id FROM ep_tenants WHERE id=$1 FOR UPDATE', req.userTenantId);
        const user = await User.get(req.userTenantId, Number(req.params.id), tx);
        if (!user) throw fail(404, "用户不存在");
        const role = req.body.role ?? user.role;
        const status = req.body.status ?? user.status;
        if (!["admin", "user"].includes(role) || !["active", "disabled"].includes(status))
          throw fail(400, "角色或状态无效");
        if (req.ep.identity !== "platform" && user.id === req.ep.userId &&
            (role !== "admin" || status !== "active"))
          throw fail(400, "不能停用自己或移除自己的管理权限");
        if (req.ep.identity !== "platform" && user.role === "admin" && user.status === "active" &&
            (role !== "admin" || status !== "active")) {
          const admins = await tx.one(`SELECT COUNT(*) AS count FROM users WHERE "tenantId"=$1 AND role='admin' AND status='active'`, req.userTenantId);
          if (Number(admins.count) <= 1) throw fail(409, "企业必须保留至少一名有效管理员");
        }
        const hash = Object.hasOwn(req.body, "password")
          ? await bcrypt.hash(password(req.body.password), 12) : user.passwordHash;
        await User.update(req.userTenantId, user.id, {
          name: User.validations.name(req.body.name ?? user.name), role, status,
          passwordHash: hash,
          authVersion: user.authVersion +
            (hash !== user.passwordHash || status !== user.status || role !== user.role ? 1 : 0),
          updatedAt: new Date(),
          ...(Object.hasOwn(req.body, "dailyMessageLimit") ? { dailyMessageLimit: User.validations.dailyMessageLimit(req.body.dailyMessageLimit) } : {}),
        }, tx);
      }, { retry: true });
      res.json({ ok: true });
    }),
  };

function registerAuth(router) {
  router.get(
    "/status",
    wrap(async (req, res) => {
      const site = await resolveSite(req);
      if (site.kind === "tenant")
        site.tenant.wechatLoginEnabled = await require("./wechat").loginEnabled(site.tenant.id);
      res.json({
        initialized: !!(await store.one(
          "SELECT id FROM ep_platform_accounts LIMIT 1"
        )),
        version: "1.0.0",
        vectorStore: (await require("./vector-store").describe()).provider,
        formats: extensions.map((extension) => extension.slice(1)),
        maxFileMB: maxFileSizeBytes / (1024 * 1024),
        site,
        routing: routingConfig(),
      });
    })
  );
  router.post(
    "/login",
    wrap(async (req, res) => {
      if (
        Object.prototype.hasOwnProperty.call(req.body, "tenantCode") ||
        Object.prototype.hasOwnProperty.call(req.body, "tenantId")
      )
        throw fail(400, "企业身份由访问域名确定，请仅提交账号和密码");
      const site = await resolveSite(req);
      limitLogin(
        req,
        `tenant:${site.kind === "tenant" ? site.tenant.id : "unknown"}`
      );
      if (site.kind !== "tenant")
        throw fail(
          403,
          site.kind === "platform"
            ? "请通过企业专属域名登录"
            : "企业域名不存在或已停用，请联系管理员"
        );
      const user = await User.forLogin(
        site.tenant.id,
        loginText(req.body.username),
        store
      );
      const ctx = await loginContext(
        user,
        await validPassword(user, req.body.password),
        "tenant"
      );
      const recoveryCodes = await generateRecoveryCodes(
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
  router.post(
    "/register",
    wrap(async (req, res) => {
      requireTenantOwnedAccount(req.body);
      if (Object.hasOwn(req.body, "role"))
        throw fail(400, "注册账号的角色固定为普通用户");
      const site = await resolveSite(req);
      if (site.kind !== "tenant") throw fail(403, "请通过企业专属域名注册");
      limitLogin(req, `tenant:${site.tenant.id}`);
      secret();
      const id = await store.transaction(async (tx) => {
        const tenant = await tx.one(
          "SELECT id FROM ep_tenants WHERE id=$1 AND status='active'",
          site.tenant.id
        );
        if (!tenant) throw fail(403, "企业已停用");
        return createAccount(tx, tenant.id, { ...req.body, role: "user" });
      });
      const ctx = await context(id);
      const recoveryCodes = await generateRecoveryCodes(
        ctx.tenantId,
        ctx.userId,
        store
      );
      res.status(201).json({ ...signed(ctx), recoveryCodes });
    })
  );
  router.post(
    "/recover-account",
    wrap(async (req, res) => {
      const site = await resolveSite(req);
      if (site.kind !== "tenant") throw fail(403, "请通过企业专属域名找回账号");
      limitLogin(req, `tenant:${site.tenant.id}`);
      const result = await recoverAccount(
        site.tenant.id,
        loginText(req.body.username),
        req.body.recoveryCodes,
        store
      );
      res.status(result.success ? 200 : 400).json(result);
    })
  );
  router.post(
    "/reset-password",
    wrap(async (req, res) => {
      const site = await resolveSite(req);
      if (site.kind !== "tenant") throw fail(403, "请通过企业专属域名重置密码");
      limitLogin(req, `tenant:${site.tenant.id}`);
      const result = await resetPassword(
        site.tenant.id,
        req.body.token,
        req.body.newPassword,
        req.body.confirmPassword,
        store
      );
      res.status(result.success ? 200 : 400).json(result);
    })
  );
  router.post(
    "/platform/login",
    wrap(async (req, res) => {
      await requirePlatformSite(req);
      limitLogin(req, "platform");
      const user = await store.one(
        'SELECT id,"passwordHash" FROM ep_platform_accounts WHERE username=$1',
        loginText(req.body.username)
      );
      try {
        res.json(
          signed(
            await loginContext(
              user,
              await validPassword(user, req.body.password),
              "platform"
            )
          )
        );
      } catch (error) {
        if (error.status === 401) throw fail(401, "账号或密码不正确");
        throw error;
      }
    })
  );
  router.get("/me", requireAuth, (req, res) => res.json(session(req.ep)));
  router.patch(
    "/me",
    requireAuth,
    wrap(async (req, res) => {
      const keys = Object.keys(req.body);
      if (
        !keys.length ||
        keys.some((key) => !["username", "password", "bio", "name"].includes(key))
      )
        throw fail(400, "仅可修改本人的账号、密码、昵称和简介");
      let user;
      try {
        user = await store.transaction(async (tx) => {
          await refreshContext(req.ep, tx);
          return User.updateProfile(
            req.ep.tenantId,
            req.ep.userId,
            req.body,
            tx
          );
        });
      } catch (error) {
        if (error.code || error.status) throw error;
        throw fail(400, error.message);
      }
      const current = await context(user.id);
      const recoveryCodes =
        req.ep.wechatRegistrationRequired && !current.wechatRegistrationRequired
          ? await generateRecoveryCodes(current.tenantId, current.userId, store)
          : [];
      res.json({
        success: true,
        ...signed(current),
        ...(recoveryCodes.length ? { recoveryCodes } : {}),
      });
    })
  );
  registerAvatar(router);
  router.get("/platform/me", requirePlatformAuth, (req, res) =>
    res.json(session(req.ep))
  );
  router.get(
    "/platform/tenants",
    requirePlatformAuth,
    wrap(async (req, res) =>
      res.json({
        tenants: await Promise.all(
          (
            await store.all(
              'SELECT id,code,name,hostname,status,"createdAt","updatedAt" FROM ep_tenants ORDER BY "createdAt"'
            )
          ).map((row) => tenantEntry(row))
        ),
      })
    )
  );
  router.post(
    "/platform/tenants",
    requirePlatformAuth,
    wrap(async (req, res) => {
      const id = store.id(),
        stamp = store.now(),
        code = tenantCode(req.body.code ?? `tenant-${id.slice(0, 12)}`),
        name = text(req.body.name, "租户名称");
      const hostname = tenantHostname(
        req.body.hostname ?? managedHostname(code)
      );
      const tenant = await store.transaction(async (tx) => {
        await assertManagerContext(req.ep, tx);
        await tx.run(
          'INSERT INTO ep_tenants(id,code,name,hostname,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6)',
          id,
          code,
          name,
          hostname,
          stamp,
          stamp
        );
        await createAccount(tx, id, {
          username: req.body.adminUsername,
          password: req.body.adminPassword,
          name: req.body.adminName,
          role: "admin",
        });
        return tenantEntry(
          await tx.one("SELECT * FROM ep_tenants WHERE id=$1", id),
          tx
        );
      });
      res.status(201).json({ tenant });
    })
  );
  router.patch(
    "/platform/tenants/:id",
    requirePlatformAuth,
    wrap(async (req, res) => {
      if (Object.prototype.hasOwnProperty.call(req.body, "code"))
        throw fail(400, "租户标识创建后不能修改，请修改租户的访问域名");
      const entry = await store.transaction(async (tx) => {
        await assertManagerContext(req.ep, tx);
        const tenant = await tx.one(
          "SELECT * FROM ep_tenants WHERE id=$1",
          req.params.id
        );
        if (!tenant) throw fail(404, "租户不存在");
        const status = req.body.status ?? tenant.status;
        if (!["active", "disabled"].includes(status))
          throw fail(400, "租户状态无效");
        await tx.run(
          'UPDATE ep_tenants SET name=$1,status=$2,hostname=$3,"updatedAt"=$4 WHERE id=$5',
          text(req.body.name ?? tenant.name, "租户名称"),
          status,
          tenantHostname(req.body.hostname ?? tenant.hostname),
          store.now(),
          tenant.id
        );
        return tenantEntry(
          await tx.one("SELECT * FROM ep_tenants WHERE id=$1", tenant.id),
          tx
        );
      });
      res.json({ tenant: entry });
    })
  );
  const currentTenant = (req, _res, next) => {
    req.userTenantId = req.ep.tenantId;
    next();
  };
  const selectedTenant = (req, _res, next) => {
    req.userTenantId = req.params.tenantId;
    next();
  };
  const { SuggestedMessages } = require("../models/workspacesSuggestedMessages");
  router.get("/suggested-messages", requireAuth, wrap(async (req, res) => {
    res.json({ messages: await SuggestedMessages.getMessages(req.ep.tenantId, store.orm) });
  }));
  router.get("/platform/tenants/:tenantId/suggested-messages", requirePlatformAuth, selectedTenant, wrap(async (req, res) => {
    res.json({ messages: await SuggestedMessages.getMessages(req.userTenantId, store.orm) });
  }));
  router.post("/platform/tenants/:tenantId/suggested-messages", requirePlatformAuth, selectedTenant, wrap(async (req, res) => {
    if (!await store.one("SELECT id FROM ep_tenants WHERE id=$1", req.userTenantId)) throw fail(404, "企业不存在");
    await SuggestedMessages.saveAll(req.body.messages, req.userTenantId, store.orm);
    res.json({ success: true });
  }));

  router.get("/users", requireAuth, requireTenantAdmin, currentTenant, userHandlers.list);
  router.get("/users/:id/avatar", requireAuth, requireTenantAdmin, currentTenant, userHandlers.avatar);
  router.post("/users", requireAuth, requireTenantAdmin, currentTenant, userHandlers.create);
  router.patch("/users/:id", requireAuth, requireTenantAdmin, currentTenant, userHandlers.update);
  router.get("/platform/tenants/:tenantId/users", requirePlatformAuth, selectedTenant, userHandlers.list);
  router.get("/platform/tenants/:tenantId/users/:id/avatar", requirePlatformAuth, selectedTenant, userHandlers.avatar);
  router.post("/platform/tenants/:tenantId/users", requirePlatformAuth, selectedTenant, userHandlers.create);
  router.patch("/platform/tenants/:tenantId/users/:id", requirePlatformAuth, selectedTenant, userHandlers.update);

  require("./wechat").registerWechat(router, { requirePlatformAuth, limitLogin });
}

const avatarDirectory = () => path.resolve(
  process.env.STORAGE_DIR || path.join(__dirname, "../storage"), "assets/pfp"
);
const validAvatarFilename = (filename) => typeof filename === "string" && /^[a-f0-9-]+(?:\.[a-z0-9]+)?$/i.test(filename);

function sendAvatar(res, filename) {
  res.set("Cache-Control", "private, no-store");
  if (!validAvatarFilename(filename)) return res.sendStatus(204);
  const target = path.join(avatarDirectory(), filename);
  if (!fs.existsSync(target)) return res.sendStatus(204);
  return res.sendFile(target);
}

function registerAvatar(router) {
  const { handlePfpUpload } = require("../utils/files/multer");
  const remove = async (ctx, filename) => {
    if (!validAvatarFilename(filename)) return;
    await fs.promises
      .unlink(path.join(avatarDirectory(), filename))
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  };
  router.get(
    "/me/avatar",
    requireAuth,
    wrap(async (req, res) => {
      sendAvatar(res, req.ep.pfpFilename);
    })
  );
  router.post(
    "/me/avatar",
    requireAuth,
    handlePfpUpload,
    wrap(async (req, res) => {
      if (!req.file) throw fail(400, "请选择头像图片");
      const filename = req.randomFileName;
      const target = req.file.path;
      try {
        const header = Buffer.alloc(12);
        const file = await fs.promises.open(target, "r");
        try {
          await file.read(header, 0, header.length, 0);
        } finally {
          await file.close();
        }
        const format = header
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? "png"
            : header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
            ? "jpeg"
            : /^GIF8[79]a$/.test(header.toString("ascii", 0, 6))
              ? "gif"
              : header.toString("ascii", 0, 4) === "RIFF" &&
                  header.toString("ascii", 8, 12) === "WEBP"
                ? "webp"
                : null;
        const extensions = {
          png: [".png"],
          jpeg: [".jpg", ".jpeg"],
          webp: [".webp"],
          gif: [".gif"],
        };
        if (!extensions[format]?.includes(path.extname(filename).toLowerCase()))
          throw new Error("Unsupported avatar image");
      } catch {
        await fs.promises.unlink(target);
        throw fail(415, "头像仅支持 PNG、JPEG、WebP 或 GIF 图片");
      }
      let previous;
      try {
        await store.transaction(async (tx) => {
          const current = await refreshContext(req.ep, tx);
          previous = current.pfpFilename;
          await tx.orm.users.update({
            where: { id: req.ep.userId },
            data: { pfpFilename: filename, updatedAt: new Date() },
          });
        });
      } catch (error) {
        await fs.promises.unlink(target);
        throw error;
      }
      await remove(req.ep, previous);
      res.json({ success: true, pfpFilename: filename });
    })
  );
  router.delete(
    "/me/avatar",
    requireAuth,
    wrap(async (req, res) => {
      let previous;
      await store.transaction(async (tx) => {
        const current = await refreshContext(req.ep, tx);
        previous = current.pfpFilename;
        await tx.orm.users.update({
          where: { id: req.ep.userId },
          data: { pfpFilename: null, updatedAt: new Date() },
        });
      });
      await remove(req.ep, previous);
      res.json({ success: true });
    })
  );
}

module.exports = {
  userHandlers,
  signed,
  requireAuth,
  requirePlatformAuth,
  requireTenantAdmin,
  fail,
  registerAuth,
  context,
  platformContext,
  authenticate,
  refreshContext,
  assertTenantAdmin,
  assertManagerContext,
};
