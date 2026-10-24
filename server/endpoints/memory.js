const { Memory } = require("../models/memory");
const { SystemSettings } = require("../models/systemSettings");
const {
  requireAuth,
  requirePlatformAuth,
  refreshContext,
  assertManagerContext,
  fail,
} = require("../enterprise/auth");
const store = require("../enterprise/store");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch(next);

function memoryEndpoints(app) {
  app.get(
    "/memories",
    requireAuth,
    wrap(async (req, res) => {
      if (!(await SystemSettings.memoriesEnabled()))
        throw fail(403, "Personalization is disabled.");
      res.json({ memories: await Memory.forUser(req.ep) });
    })
  );
  app.post(
    "/memories",
    requireAuth,
    wrap(async (req, res) => {
      if (!(await SystemSettings.memoriesEnabled()))
        throw fail(403, "Personalization is disabled.");
      const result = await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const result = await Memory.create(req.ep, req.body, tx.orm);
          if (!result.memory) throw fail(400, result.message);
          return result;
        },
        { retry: true }
      );
      res.status(201).json(result);
    })
  );
  app.put(
    "/memories/:memoryId",
    requireAuth,
    wrap(async (req, res) => {
      const result = await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const result = await Memory.update(
            req.ep,
            req.params.memoryId,
            req.body,
            tx.orm
          );
          if (!result.memory) throw fail(404, result.message);
          return result;
        },
        { retry: true }
      );
      res.json(result);
    })
  );
  app.delete(
    "/memories/:memoryId",
    requireAuth,
    wrap(async (req, res) => {
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          if (!(await Memory.delete(req.ep, req.params.memoryId, tx.orm)))
            throw fail(404, "Memory not found.");
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  app.get(
    "/platform/memories",
    requirePlatformAuth,
    wrap(async (req, res) => {
      res.json({
        memories: await store.orm.memories.findMany({
          where: req.query.tenantId ? { tenantId: req.query.tenantId } : {},
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      });
    })
  );
  for (const method of ["put", "delete"])
    app[method](
      "/platform/memories/:memoryId",
      requirePlatformAuth,
      wrap(async (req, res) => {
        const result = await store.transaction(
          async (tx) => {
            await assertManagerContext(req.ep, tx);
            const memory = await tx.orm.memories.findUnique({
              where: { id: Memory.validations.id(req.params.memoryId) },
            });
            if (!memory) throw fail(404, "Memory not found.");
            const ctx = { tenantId: memory.tenantId, userId: memory.userId };
            return method === "delete"
              ? { success: await Memory.delete(ctx, memory.id, tx.orm) }
              : Memory.update(ctx, memory.id, req.body, tx.orm);
          },
          { retry: true }
        );
        res.json(result);
      })
    );
}
module.exports = { memoryEndpoints };
