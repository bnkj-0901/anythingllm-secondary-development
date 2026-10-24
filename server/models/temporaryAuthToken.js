const { context, signed } = require("../enterprise/auth");
const prisma = require("../utils/prisma");

/**
 * Temporary auth tokens are used for simple SSO.
 * They simply enable the ability for a time-based token to be used in the query of the /sso/login URL
 * to login as a user without the need of a username and password. These tokens are single-use and expire.
 */
const TemporaryAuthToken = {
  expiry: 1000 * 60 * 10, // Time-based expiry for a single-use SSO login token.
  tablename: "temporary_auth_tokens",
  writable: [],

  makeTempToken: () => {
    const uuidAPIKey = require("uuid-apikey");
    return `allm-tat-${uuidAPIKey.create().apiKey}`;
  },

  /**
   * Issues a temporary auth token for a user via its ID.
   * @param {number} userId
   * @returns {Promise<{token: string|null, error: string | null}>}
   */
  issue: async function (userId) {
    const ctx = await context(userId);
    const token = this.makeTempToken();
    await prisma.$transaction(async (tx) => {
      await tx.temporary_auth_tokens.deleteMany({
        where: { userId: ctx.userId },
      });
      await tx.temporary_auth_tokens.create({
        data: {
          token,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          authVersion: ctx.authVersion,
          expiresAt: new Date(Date.now() + this.expiry),
        },
      });
    });
    return { token, error: null };
  },

  /**
   * Invalidates (deletes) all temporary auth tokens for a user via their ID.
   * @param {number} userId
   * @returns {Promise<boolean>}
   */
  invalidateUserTokens: async function (userId) {
    if (!userId)
      throw new Error(
        "User ID is required to invalidate temporary auth tokens."
      );
    await prisma.temporary_auth_tokens.deleteMany({
      where: { userId: Number(userId) },
    });
    return true;
  },

  /**
   * Validates a temporary auth token and returns the session token
   * to be set in the browser localStorage for authentication.
   * @param {string} publicToken - the token to validate against
   * @returns {Promise<{sessionToken: string|null, token: import("@prisma/client").temporary_auth_tokens & {user: import("@prisma/client").users} | null, error: string | null}>}
   */
  validate: async function (publicToken = "", tenantId) {
    try {
      if (!publicToken || !tenantId) throw new Error("Invalid token");
      const row = await prisma.temporary_auth_tokens.findFirst({
        where: { token: String(publicToken), tenantId },
      });
      if (!row || row.expiresAt < new Date())
        throw new Error("Invalid or expired token");
      const ctx = await context(row.userId);
      if (ctx.tenantId !== tenantId || ctx.authVersion !== row.authVersion)
        throw new Error("Execution identity changed");
      const consumed = await prisma.temporary_auth_tokens.deleteMany({
        where: { id: row.id, token: row.token, tenantId },
      });
      if (consumed.count !== 1) throw new Error("Token already used");
      const session = signed(ctx);
      return {
        sessionToken: session.token,
        session,
        token: { ...row, user: ctx.user },
        error: null,
      };
    } catch {
      return {
        sessionToken: null,
        token: null,
        error: "Invalid or expired token",
      };
    }
  },
};

module.exports = { TemporaryAuthToken };
