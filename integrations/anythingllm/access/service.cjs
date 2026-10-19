const crypto = require("node:crypto");
const random = () => crypto.randomBytes(32).toString("hex");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
class AccessError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new AccessError(status, code, message); };
const publicUser = ({ id, username, role }) => ({ id, username, role });
const defaults = () => ({ registrationEnabled: true, publicUrl: "", wechatH5: { appId: "", appSecret: "" }, wechatWeb: { appId: "", appSecret: "" } });

function createAccessService({ prisma, User, bcrypt, JWT, encryption, jwtSecret }) {
  const dummyHash = bcrypt.hashSync(random(), 12);
  async function multiUser() {
    if ((await prisma.system_settings.findUnique({ where: { label: "multi_user_mode" } }))?.value !== "true")
      fail(403, "multi_user_required", "请先在系统中启用多用户模式。");
  }
  async function config() {
    const row = await prisma.system_settings.findUnique({ where: { label: "kb_access_config" } });
    return row?.value ? { ...defaults(), ...JSON.parse(encryption.decrypt(row.value)) } : defaults();
  }
  function visibleConfig(value) {
    const result = { registrationEnabled: value.registrationEnabled, publicUrl: value.publicUrl };
    for (const key of ["wechatH5", "wechatWeb"]) result[key] = { appId: value[key].appId, secretConfigured: Boolean(value[key].appSecret) };
    return result;
  }
  async function saveConfig(body) {
    const value = await config();
    if (body.registrationEnabled !== undefined) {
      if (typeof body.registrationEnabled !== "boolean") fail(422, "invalid_config", "注册开关格式错误。");
      value.registrationEnabled = body.registrationEnabled;
    }
    if (body.publicUrl !== undefined) {
      if (typeof body.publicUrl !== "string") fail(422, "invalid_url", "请填写 HTTPS 公网地址。");
      const input = body.publicUrl.trim().replace(/\/$/, "");
      if (input) {
        let url;
        try { url = new URL(input); } catch { fail(422, "invalid_url", "公网地址格式不正确。"); }
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
          fail(422, "invalid_url", "公网地址须为 HTTPS 域名，不包含路径或参数。");
      }
      value.publicUrl = input;
    }
    for (const key of ["wechatH5", "wechatWeb"]) {
      if (body[key] === undefined) continue;
      const input = body[key];
      if (!input || typeof input !== "object" || Array.isArray(input)) fail(422, "invalid_config", "微信配置格式错误。");
      if (input.appId !== undefined) {
        if (typeof input.appId !== "string" || !/^[a-zA-Z0-9_-]{0,64}$/.test(input.appId)) fail(422, "invalid_appid", "AppID 格式不正确。");
        if (input.appId !== value[key].appId) value[key].appSecret = "";
        value[key].appId = input.appId;
      }
      if (input.clearSecret === true) value[key].appSecret = "";
      if (input.appSecret !== undefined) {
        if (typeof input.appSecret !== "string" || input.appSecret.length > 256) fail(422, "invalid_secret", "AppSecret 格式不正确。");
        if (input.appSecret.trim()) value[key].appSecret = input.appSecret.trim();
      }
    }
    const encrypted = encryption.encrypt(JSON.stringify(value));
    await prisma.system_settings.upsert({ where: { label: "kb_access_config" }, create: { label: "kb_access_config", value: encrypted }, update: { value: encrypted } });
    return visibleConfig(value);
  }
  async function authenticate(token, cookie = false) {
    let claims;
    try { claims = JWT.verify(token, jwtSecret, { algorithms: ["HS256"], ...(cookie ? { audience: "kb-access" } : {}) }); }
    catch { fail(401, "unauthorized", "请先登录。"); }
    if (!Number.isSafeInteger(claims.id)) fail(401, "unauthorized", "请先登录。");
    const user = await prisma.users.findUnique({ where: { id: claims.id } });
    if (!user || user.suspended) fail(401, "unauthorized", "登录已失效或账号已停用，请重新登录。");
    return user;
  }
  async function ticket(user, destination = "/portal") {
    const token = random();
    await prisma.temporary_auth_tokens.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await prisma.temporary_auth_tokens.create({ data: { token, userId: user.id, expiresAt: new Date(Date.now() + 60_000) } });
    return `/sso/simple?token=${token}&redirectTo=${encodeURIComponent(destination)}`;
  }
  function session(user) { return JWT.sign({ id: user.id }, jwtSecret, { algorithm: "HS256", audience: "kb-access", expiresIn: "8h" }); }
  async function register(body) {
    await multiUser();
    if (!(await config()).registrationEnabled) fail(403, "registration_closed", "注册暂未开放，请联系管理员。");
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    try { User.validations.username(username); } catch { fail(422, "invalid_username", "账号须为 2–64 位，以字母开头，可含数字、点、下划线、@ 或短横线。"); }
    if (typeof body.password !== "string" || Buffer.byteLength(body.password) > 72 || !User.checkPasswordComplexity(body.password).checkedOK)
      fail(422, "invalid_password", "密码至少 8 位，最多 72 字节，并须符合系统密码策略。");
    if (body.password !== body.confirmPassword) fail(422, "password_mismatch", "两次输入的密码不一致。");
    const password = await bcrypt.hash(body.password, 12);
    try { return await prisma.users.create({ data: { username, password, role: "default" } }); }
    catch (error) { if (error.code === "P2002") fail(409, "username_taken", "账号已存在，请更换账号或直接登录。"); throw error; }
  }
  async function login(body) {
    await multiUser();
    if (typeof body.username !== "string" || body.username.length > 64 || typeof body.password !== "string" || Buffer.byteLength(body.password) > 1024)
      fail(401, "invalid_credentials", "账号或密码不正确。");
    const user = await prisma.users.findUnique({ where: { username: body.username.trim() } });
    const valid = await bcrypt.compare(body.password, user?.password || dummyHash);
    if (!user || !valid) fail(401, "invalid_credentials", "账号或密码不正确。");
    if (user.suspended) fail(403, "account_disabled", "账号已停用，请联系管理员。");
    return user;
  }
  return { prisma, config, visibleConfig, saveConfig, multiUser, authenticate, register, login, ticket, session };
}
module.exports = { createAccessService, AccessError, fail, publicUser, random, digest };
