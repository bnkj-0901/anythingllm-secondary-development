// A user belongs to exactly one tenant. Platform operators have a separate
// identity and are never members of an enterprise's knowledge or conversations.
const User = {
  usernameRegex: /^[a-z][a-z0-9._@-]*$/,
  validations: {
    name(value) {
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value.trim().length > 80
      )
        throw Object.assign(new Error("姓名不能为空，最长 80 个字符"), {
          status: 400,
        });
      return value.trim();
    },
    username(value = "") {
      if (typeof value !== "string")
        throw new Error("Username must be a string");
      if (value.length > 64)
        throw new Error("Username cannot be longer than 64 characters");
      if (value.length < 2)
        throw new Error("Username must be at least 2 characters");
      if (!User.usernameRegex.test(value))
        throw new Error(
          "Username must start with a lowercase letter and only contain lowercase letters, numbers, underscores, hyphens, and periods"
        );
      return value;
    },
    bio(value = "") {
      if (!value || typeof value !== "string") return "";
      if (value.length > 1000)
        throw new Error("Bio cannot be longer than 1,000 characters");
      return value;
    },
    dailyMessageLimit(value = null) {
      if (value === null) return null;
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1)
        throw new Error(
          "Daily message limit must be null or a number greater than or equal to 1"
        );
      return limit;
    },
  },
  filterFields(user = {}) {
    const {
      password: _password,
      passwordHash: _passwordHash,
      web_push_subscription_config: _push,
      wechatIdentity: _wechatIdentity,
      ...rest
    } = user;
    return rest;
  },
  checkPasswordComplexity(passwordInput = "", environment = process.env) {
    const passwordComplexity = require("joi-password-complexity");
    const result = passwordComplexity(
      {
        min: environment.PASSWORDMINCHAR || 8,
        max: environment.PASSWORDMAXCHAR || 250,
        lowerCase: environment.PASSWORDLOWERCASE || 0,
        upperCase: environment.PASSWORDUPPERCASE || 0,
        numeric: environment.PASSWORDNUMERIC || 0,
        symbol: environment.PASSWORDSYMBOL || 0,
        requirementCount: environment.PASSWORDREQUIREMENTS || 0,
      },
      "password"
    ).validate(passwordInput);
    return result.error
      ? {
          checkedOK: false,
          error: result.error.details.map(({ message }) => message).join(", "),
        }
      : { checkedOK: true, error: "No error." };
  },
  authenticationContext(id, db) {
    return db.one(
      'SELECT u.id,u."tenantId",u.username,u.name,u.bio,u."pfpFilename",(u."wechatIdentity" IS NOT NULL) AS "wechatBound",(u."wechatIdentity" IS NOT NULL AND NOT u."wechatRegistrationComplete") AS "wechatRegistrationRequired",u.seen_recovery_codes,u.role,u.status,u."dailyMessageLimit",u."authVersion",t.code AS "tenantCode",t.name AS "tenantName",t.status AS "tenantStatus" FROM users u JOIN ep_tenants t ON t.id=u."tenantId" WHERE u.id=$1',
      id
    );
  },
  forLogin(tenantId, username, db) {
    return db.one(
      'SELECT id,"passwordHash" FROM users WHERE "tenantId"=$1 AND username=$2',
      tenantId,
      username
    );
  },
  get(tenantId, id, db) {
    return db.one(
      'SELECT * FROM users WHERE "tenantId"=$1 AND id=$2',
      tenantId,
      id
    );
  },
  list(tenantId, db) {
    return db.all(
      'SELECT id,username,name,status,role,"dailyMessageLimit","pfpFilename",("wechatIdentity" IS NOT NULL) AS "wechatBound","createdAt" FROM users WHERE "tenantId"=$1 ORDER BY "createdAt"',
      tenantId
    );
  },
  create(user, db) {
    return db.one(
      'INSERT INTO users("tenantId",username,name,"passwordHash",role,"createdAt","lastUpdatedAt","dailyMessageLimit") VALUES($1,$2,$3,$4,$5,$6,$6,$7) RETURNING id',
      user.tenantId,
      user.username,
      user.name,
      user.passwordHash,
      user.role,
      user.createdAt,
      this.validations.dailyMessageLimit(user.dailyMessageLimit ?? null)
    );
  },
  update(tenantId, id, updates, db) {
    return db.run(
      'UPDATE users SET name=$1,role=$2,status=$3,"passwordHash"=$4,"authVersion"=$5,"lastUpdatedAt"=$6,"dailyMessageLimit"=CASE WHEN $9 THEN $10 ELSE "dailyMessageLimit" END WHERE id=$7 AND "tenantId"=$8',
      updates.name,
      updates.role,
      updates.status,
      updates.passwordHash,
      updates.authVersion,
      updates.updatedAt,
      id,
      tenantId,
      Object.hasOwn(updates, "dailyMessageLimit"),
      this.validations.dailyMessageLimit(updates.dailyMessageLimit ?? null)
    );
  },
  async canSendChat(user, db = require("../utils/prisma")) {
    if (!user || user.dailyMessageLimit == null || user.role === "admin" || user.identity === "platform")
      return true;
    const count = await db.chats.count({
      where: {
        tenantId: user.tenantId,
        userId: user.id,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    return count < user.dailyMessageLimit;
  },
  async updateProfile(tenantId, id, updates, db) {
    const current = await this.get(tenantId, id, db);
    if (!current)
      throw Object.assign(new Error("User not found"), { status: 404 });
    const username = Object.hasOwn(updates, "username")
      ? this.validations.username(
          typeof updates.username === "string"
            ? updates.username.trim().toLowerCase()
            : updates.username
        )
      : current.username;
    const bio = Object.hasOwn(updates, "bio")
      ? this.validations.bio(updates.bio)
      : current.bio;
    const name = Object.hasOwn(updates, "name")
      ? this.validations.name(updates.name)
      : current.name;
    const completingWechatRegistration =
      current.wechatIdentity && !current.wechatRegistrationComplete;
    if (
      completingWechatRegistration &&
      (!Object.hasOwn(updates, "name") ||
        !Object.hasOwn(updates, "password") ||
        !current.pfpFilename)
    )
      throw Object.assign(new Error("请先选择头像，并填写昵称和密码完成注册"), {
          status: 400,
        });
    let passwordHash = current.passwordHash;
    if (Object.hasOwn(updates, "password")) {
      const check = this.checkPasswordComplexity(updates.password);
      if (!check.checkedOK)
        throw Object.assign(new Error(check.error), { status: 400 });
      passwordHash = await require("bcryptjs").hash(updates.password, 12);
    }
    const user = await db.orm.users.update({
      where: { id },
      data: {
        username,
        name,
        bio,
        passwordHash,
        ...(completingWechatRegistration
          ? { wechatRegistrationComplete: true }
          : {}),
        authVersion:
          current.authVersion + (passwordHash !== current.passwordHash ? 1 : 0),
        updatedAt: new Date(),
      },
    });
    return this.filterFields(user);
  },
};
module.exports = { User };
