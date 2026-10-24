const store = require("./store");
const fileStore = require("./file-store");
const {
  requireAuth,
  requirePlatformAuth,
  refreshContext,
  fail,
} = require("./auth");

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const active = ["pending", "conflict", "failed"];

function payload(change) {
  return JSON.parse(change.payload || "{}");
}

function view(change) {
  const { payload: _payload, ...result } = change;
  const data = payload(change);
  return {
    ...result,
    title: data.title || data.name || "",
    content: data.content || "",
    visibility: data.visibility,
    targetUserId: data.userId || null,
    hasOriginal: !!data.originalPath,
  };
}

async function submit(ctx, { action, library, document, data }, db = store) {
  await refreshContext(ctx, db);
  const change = {
    id: store.id(),
    tenantId: library.tenantId,
    libraryId: action === "library.create" ? null : library.id,
    documentId: document?.id || null,
    action,
    payload: JSON.stringify(data),
    baseVersion: document?.version || null,
    baseUpdatedAt: document?.updatedAt || library.updatedAt || null,
    status: "pending",
    requestedBy: String(ctx.userId),
    createdAt: store.now(),
    updatedAt: store.now(),
  };
  await db.run(
    'INSERT INTO ep_knowledge_changes(id,"tenantId","libraryId","documentId",action,payload,"baseVersion","baseUpdatedAt",status,"requestedBy","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    ...Object.values(change)
  );
  return { approvalRequired: true, change: view(change) };
}

async function cleanupCandidate(change, db = store) {
  const data = payload(change);
  if (data.originalPath)
    await fileStore.queueCleanup(db, [
      { path: data.originalPath, tenantId: change.tenantId },
    ]);
}

function registerApprovals(
  router,
  {
    apply,
    authorize,
    authenticate = requireAuth,
    platformAuthenticate = requirePlatformAuth,
  }
) {
  async function list(req, res) {
    const current = await refreshContext(req.ep);
    const platform = current.identity === "platform";
    const admin = platform || current.role === "admin";
    const params = platform ? [] : [current.tenantId];
    let condition = platform ? "TRUE" : '"tenantId"=$1';
    if (!admin) {
      params.push(String(current.userId));
      condition += ` AND "requestedBy"=$${params.length}`;
    }
    if (req.query.status) {
      if (
        ![
          ...active,
          "processing",
          "approved",
          "rejected",
          "cancelled",
        ].includes(req.query.status)
      )
        throw fail(400, "审批状态无效");
      params.push(req.query.status);
      condition += ` AND status=$${params.length}`;
    }
    const changes = await store.all(
      `SELECT c.*, u.name AS "targetUserName" FROM
        (SELECT * FROM ep_knowledge_changes WHERE ${condition} ORDER BY "createdAt" DESC) c
        LEFT JOIN users u ON u.id::text=c.payload::jsonb->>'userId' AND u."tenantId"=c."tenantId"
        ORDER BY c."createdAt" DESC`,
      ...params
    );
    res.json({ changes: changes.map(view), canReview: admin });
  }

  async function review(req, res) {
    if (!["approve", "reject"].includes(req.body.decision))
      throw fail(400, "请选择批准或驳回");
    let change;
    let conflict = false;
    await store.transaction(
      async (tx) => {
        const actor = await refreshContext(req.ep, tx);
        if (actor.identity !== "platform" && actor.role !== "admin")
          throw fail(403, "需要管理员审批");
        change = await tx.one(
          "SELECT * FROM ep_knowledge_changes WHERE id=$1 FOR UPDATE",
          req.params.id
        );
        if (
          !change ||
          (actor.identity !== "platform" && actor.tenantId !== change.tenantId)
        )
          throw fail(404, "审批申请不存在");
        if (!active.includes(change.status))
          throw fail(409, "该申请已经处理或正在发布");
        if (req.body.decision === "reject") {
          await cleanupCandidate(change, tx);
          await tx.run(
            'UPDATE ep_knowledge_changes SET status=\'rejected\',"reviewedBy"=$1,"reviewNote"=$2,"reviewedAt"=$3,"updatedAt"=$3 WHERE id=$4',
            String(actor.userId),
            String(req.body.note || "").slice(0, 1000),
            store.now(),
            change.id
          );
          return;
        }
        const data = payload(change);
        const resource = await authorize(change, actor, tx);
        const mismatch =
          resource &&
          (change.documentId
            ? resource.version !== change.baseVersion ||
              resource.updatedAt !== change.baseUpdatedAt
            : resource.updatedAt !== change.baseUpdatedAt);
        if (mismatch && req.body.resolveConflict !== true) {
          await tx.run(
            'UPDATE ep_knowledge_changes SET status=\'conflict\',"reviewNote"=$1,"updatedAt"=$2 WHERE id=$3',
            "资源已变更，请比较当前内容后由管理员处理冲突",
            store.now(),
            change.id
          );
          conflict = true;
          return;
        }
        // An explicit conflict resolution approves the submitted fields against
        // the current resource; it never replays a stale whole-resource snapshot.
        change.baseVersion = resource?.version || null;
        change.baseUpdatedAt = resource?.updatedAt || null;
        change.reviewedBy = String(actor.userId);
        change.reviewedAt = store.now();
        await tx.run(
          'UPDATE ep_knowledge_changes SET status=\'processing\',"baseVersion"=$1,"baseUpdatedAt"=$2,"reviewedBy"=$3,"reviewNote"=$4,"reviewedAt"=$5,"updatedAt"=$5 WHERE id=$6',
          change.baseVersion,
          change.baseUpdatedAt,
          String(actor.userId),
          String(req.body.note || "").slice(0, 1000),
          change.reviewedAt,
          change.id
        );
        change.payload = JSON.stringify(data);
      },
      { retry: true }
    );
    if (conflict)
      return res.status(409).json({
        error: "资源已变更，请比较当前内容后由管理员处理冲突",
        change: view(
          await store.one(
            "SELECT * FROM ep_knowledge_changes WHERE id=$1",
            change.id
          )
        ),
      });
    if (req.body.decision === "approve") {
      try {
        await apply(change, req.ep);
      } catch (error) {
        await store.run(
          "UPDATE ep_knowledge_changes SET status='failed',\"reviewNote\"=$1,\"updatedAt\"=$2 WHERE id=$3 AND status='processing'",
          error.status ? error.message : "发布失败，请检查服务后重试",
          store.now(),
          change.id
        );
        throw error;
      }
    }
    await fileStore.flushCleanup();
    res.json({
      change: view(
        await store.one(
          "SELECT * FROM ep_knowledge_changes WHERE id=$1",
          change.id
        )
      ),
    });
  }

  async function cancel(req, res) {
    await store.transaction(
      async (tx) => {
        const actor = await refreshContext(req.ep, tx);
        const change = await tx.one(
          "SELECT * FROM ep_knowledge_changes WHERE id=$1 FOR UPDATE",
          req.params.id
        );
        if (
          !change ||
          (actor.identity !== "platform" &&
            (actor.tenantId !== change.tenantId ||
              String(actor.userId) !== change.requestedBy))
        )
          throw fail(404, "审批申请不存在");
        if (!active.includes(change.status)) throw fail(409, "该申请不能撤回");
        await cleanupCandidate(change, tx);
        await tx.run(
          "UPDATE ep_knowledge_changes SET status='cancelled',\"updatedAt\"=$1 WHERE id=$2",
          store.now(),
          change.id
        );
      },
      { retry: true }
    );
    await fileStore.flushCleanup();
    res.json({ success: true });
  }

  async function original(req, res) {
    const actor = await refreshContext(req.ep);
    const change = await store.one(
      "SELECT * FROM ep_knowledge_changes WHERE id=$1",
      req.params.id
    );
    if (
      !change ||
      (actor.identity !== "platform" &&
        (actor.tenantId !== change.tenantId ||
          (actor.role !== "admin" &&
            String(actor.userId) !== change.requestedBy)))
    )
      throw fail(404, "审批申请不存在");
    const data = payload(change);
    if (!data.originalPath) throw fail(404, "该申请没有原始文件");
    const filename = await fileStore.resolveOriginal(
      data.originalPath,
      change.tenantId
    );
    res.download(
      filename,
      (data.title || "审批原件").replace(/[<>:"/\\|?*\r\n]/g, "_")
    );
  }

  for (const [prefix, auth] of [
    ["", authenticate],
    ["/platform", platformAuthenticate],
  ]) {
    router.get(`${prefix}/knowledge-changes`, auth, wrap(list));
    router.get(
      `${prefix}/knowledge-changes/:id/download`,
      auth,
      wrap(original)
    );
    router.post(`${prefix}/knowledge-changes/:id/review`, auth, wrap(review));
    router.delete(`${prefix}/knowledge-changes/:id`, auth, wrap(cancel));
  }
}

module.exports = { submit, view, payload, registerApprovals };
