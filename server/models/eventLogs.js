const prisma = require("../utils/prisma");

const EventLogs = {
  logEvent: async function (event, metadata = {}, userId = null) {
    try {
      const actorId = userId || require("../enterprise/execution-context").optionalExecutionContext()?.userId;
      const actor = Number.isInteger(Number(actorId)) && Number(actorId) > 0 ? await prisma.users.findUnique({where:{id:Number(actorId)},select:{tenantId:true,username:true}}) : null;
      const eventLog = await prisma.event_logs.create({
        data: {
          event,
          userId: actorId ? String(actorId) : null,
          metadata: JSON.stringify({...metadata, userId:actorId || null,tenantId:actor?.tenantId || null,actor:actor?.username || null}),
          occurredAt: new Date(),
        },
      });
      console.log(`\x1b[32m[Event Logged]\x1b[0m - ${event}`);
      return { eventLog, message: null };
    } catch (error) {
      console.error(
        `\x1b[31m[Event Logging Failed]\x1b[0m - ${event}`,
        error.message
      );
      return { eventLog: null, message: error.message };
    }
  },

  getByEvent: async function (event, limit = null, orderBy = null) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: { event },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null
          ? { orderBy }
          : { orderBy: { occurredAt: "desc" } }),
      });
      return logs;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  getByUserId: async function (userId, limit = null, orderBy = null) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: { userId: String(userId) },
        ...(limit !== null ? { take: limit } : {}),
        orderBy: orderBy || { occurredAt: "desc" },
      });
      return logs;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const logs = await prisma.event_logs.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null
          ? { orderBy }
          : { orderBy: { occurredAt: "desc" } }),
      });
      return logs;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  whereWithData: async function (
    clause = {},
    limit = null,
    offset = null,
    orderBy = null
  ) {
    try {
      const results = await this.where(clause, limit, orderBy, offset);

      for (const res of results) {
        const metadata = require("../utils/http").safeJsonParse(res.metadata, {});
        const actorId = res.userId || metadata?.userId;
        const user = actorId ? (Number.isInteger(Number(actorId)) && Number(actorId) > 0
          ? await prisma.users.findUnique({where:{id:Number(actorId)},select:{username:true}})
          : await prisma.ep_platform_accounts.findUnique({where:{id:String(actorId)},select:{username:true}})) : null;
        res.user = user
          ? { username: user.username }
          : { username: metadata?.actor || "unknown user" };
      }

      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.event_logs.count({
        where: clause,
      });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.event_logs.deleteMany({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },
};

module.exports = { EventLogs };
