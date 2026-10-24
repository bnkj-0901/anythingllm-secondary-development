const store = require("./store");
const {
  requireAuth: tenantAuth,
  requirePlatformAuth,
  fail,
  refreshContext,
} = require("./auth");
const providers = require("./providers");
const { Document } = require("../models/documents");
const { getSettings } = require("./rag-settings");
const { packPrompt } = require("./prompt-context");
const vectorStore = require("./vector-store");
const { Chat } = require("../models/workspaceChats");
const { ChatThread } = require("../models/workspaceThread");
const { convertToChatHistory } = require("../utils/helpers/chat/responses");
const { safeJsonParse } = require("../utils/http");

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const generating = new Set();
const NO_EVIDENCE =
  "当前可检索资料中没有找到足够依据。请补充相关资料，或描述得更具体一些。";

function parseSources(raw) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function recordId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw fail(404, "记录不存在");
  return id;
}

async function requireConversation(ctx, id, db = store) {
  const conversation = await ChatThread.get(ctx, { id: Number(id) }, db.orm);
  if (!conversation) throw fail(404, "对话不存在或无权访问");
  return conversation;
}

function conversationView(thread) {
  return {
    id: thread.id,
    tenantId: thread.tenantId,
    userId: thread.userId,
    title: thread.name,
    createdAt: thread.createdAt,
    updatedAt: thread.lastUpdatedAt,
  };
}

function pairMessages(record) {
  return convertToChatHistory([record]).map((message) => ({
    ...message,
    id: message.role === "user" ? `${record.id}:user` : record.id,
    tenantId: record.tenantId,
    conversationId: record.thread_id,
    feedbackScore: record.feedbackScore,
    createdAt:
      message.role === "user" ? record.createdAt : record.lastUpdatedAt,
  }));
}

// Fresh source reads use live authorization and the active version. Saved chat
// citation snippets remain personal historical snapshots.
async function currentSources(ctx, candidates, db = store) {
  if (!candidates.length) return [];
  const ids = [
    ...new Set(
      candidates
        .map((source) => source.id)
        .filter((id) => typeof id === "string")
    ),
  ];
  if (!ids.length) return [];
  const rows = await db.all(
    `SELECT c.id, c."documentId", c.content AS text, c.metadata, d.title, d."libraryId", ${Document.libraryVisibilitySQL()} AS visibility FROM ep_chunks c JOIN ep_documents d ON d.id = c."documentId" AND d."tenantId" = c."tenantId" AND d.version = c.version JOIN ep_libraries l ON l.id = d."libraryId" AND l."tenantId" = d."tenantId" WHERE ${Document.libraryAccessSQL()} AND d.status = 'ready' AND c.id IN (${ids.map((_, index) => `$${index + 3}`).join(",")})`,
    ctx.tenantId,
    ctx.userId,
    ...ids
  );
  const allowed = new Map(rows.map((row) => [row.id, row]));
  return candidates
    .map((source, index) => ({
      source,
      citationNumber:
        Number.isInteger(source.citationNumber) && source.citationNumber > 0
          ? source.citationNumber
          : index + 1,
    }))
    .filter(({ source }) => allowed.has(source.id))
    .map(({ source, citationNumber }) => ({
      ...safeJsonParse(allowed.get(source.id).metadata, {}),
      ...allowed.get(source.id),
      metadata: safeJsonParse(allowed.get(source.id).metadata, {}),
      score: Number(source.score) || 0,
      citationNumber,
    }));
}

async function waitForSearch(search, signal) {
  if (!signal) return search;
  let aborted;
  const canceled = new Promise((_resolve, reject) => {
    aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    // The underlying withDatabase operation retains its read lease until the
    // remote request settles. Only the caller's wait is canceled here; race
    // still consumes a late rejection from the outstanding search.
    return await Promise.race([search, canceled]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

async function retrieve(
  ctx,
  query,
  connection,
  settings,
  { signal, libraryIds } = {}
) {
  settings = settings || (await getSettings(ctx.tenantId));
  const identity = providers.connectionIdentity(connection);
  const libraryFilter = libraryIds?.length
    ? ` AND d."libraryId" IN (${libraryIds.map((_, i) => `$${i + 4}`).join(",")})`
    : "";
  const rows = await store.all(
    `SELECT c."documentId",c.version,c.namespace,c.dimensions,MIN(c.id) AS "sampleId",COUNT(*)::int AS count FROM ep_chunks c JOIN ep_documents d ON d.id=c."documentId" AND d."tenantId"=c."tenantId" AND d.version=c.version JOIN ep_libraries l ON l.id=d."libraryId" AND l."tenantId"=d."tenantId" WHERE ${Document.libraryAccessSQL()} AND d.status='ready' AND c."embeddingId"=$3 AND d."embeddingId"=$3${libraryFilter} GROUP BY c."documentId",c.version,c.namespace,c.dimensions`,
    ctx.tenantId,
    ctx.userId,
    identity,
    ...(libraryIds || [])
  );
  if (!rows.length) {
    const incompatible = await store.one(
      `SELECT COUNT(*) AS count FROM ep_documents d JOIN ep_libraries l ON l.id=d."libraryId" AND l."tenantId"=d."tenantId" WHERE ${Document.libraryAccessSQL()} AND d.status='ready' AND (d."embeddingId" IS NULL OR d."embeddingId"<>$3)${libraryFilter}`,
      ctx.tenantId,
      ctx.userId,
      identity,
      ...(libraryIds || [])
    );
    if (Number(incompatible?.count))
      throw fail(409, "Embedding 配置已变更，请在知识资料页重建索引后再提问");
    return [];
  }
  const [queryVector] = await providers.embed(connection, [query], {
    query: true,
    signal,
  });
  const spaces = new Map();
  for (const row of rows) {
    if (row.dimensions !== queryVector.length)
      throw fail(409, "Embedding 向量维度与索引不一致，请重建索引后再提问");
    if (!spaces.has(row.namespace)) spaces.set(row.namespace, []);
    spaces
      .get(row.namespace)
      .push({ documentId: row.documentId, version: row.version });
  }
  const search = vectorStore.withDatabase(async (backend) => {
    const result = [];
    for (const [namespace, documentVersions] of spaces) {
      signal?.throwIfAborted();
      const matches = await backend.search({
        namespace,
        vector: queryVector,
        filter: {
          documentVersions,
        },
        topK: settings.rerank
          ? Math.min(
              50,
              Math.max(
                10,
                Math.ceil(
                  rows.reduce(
                    (count, row) => count + Number(row.count || 0),
                    0
                  ) * 0.1
                )
              )
            )
          : settings.topK,
        threshold: settings.similarityThreshold,
      });
      // Probe a published, authorized record to distinguish no similar matches
      // from an empty backend after a connection change.
      if (!matches.length && backend.fetch) {
        const sample = rows.find((row) => row.namespace === namespace);
        const indexed = await backend.fetch({
          namespace,
          ids: [sample.sampleId],
        });
        if (!indexed.length)
          throw fail(409, "当前向量后端尚无资料索引，请在知识资料页重建索引");
      }
      result.push(...matches);
      signal?.throwIfAborted();
    }
    return result
      .sort((a, b) => b.score - a.score)
      .slice(0, settings.rerank ? 50 : settings.topK);
  });
  const matches = await waitForSearch(search, signal);
  let scored = await currentSources(ctx, matches);
  // Only SQL-rechecked, currently authorized text reaches the reranker.
  if (settings.rerank)
    scored = await require("./rerank").rerank(query, scored, {
      topK: settings.topK,
      signal,
    });
  // Keep the vector ranking and source identities; the original prompt
  // compressor handles the model's token budget after retrieval.
  const seen = new Set();
  const sources = [];
  for (const source of scored) {
    if (sources.length >= settings.topK) break;
    const key = `${source.documentId}:${source.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return sources;
}

async function modelHistory(ctx, conversationId, messageLimit = 20) {
  await requireConversation(ctx, conversationId);
  // Saved answers are personal conversation snapshots. Revoking a knowledge
  // grant blocks fresh source access, not the user's previously saved words.
  const { rawHistory } = await require("../utils/chats").recentChatHistory({
    ctx,
    threadId: conversationId,
    messageLimit,
    db: store.orm,
  });
  return rawHistory.filter((row) => {
    const response = safeJsonParse(row.response, {}) || {};
    return (
      typeof row.prompt === "string" &&
      row.prompt.trim() &&
      typeof response.text === "string" &&
      response.text.trim()
    );
  });
}

async function saveChatPair(
  ctx,
  conversationId,
  question,
  content,
  sources = [],
  {
    signal,
    contextSources = sources,
    historySources = [],
    pinnedDocuments = [],
    chatMode = "chat",
    include = true,
    attachments = [],
    metrics = {},
    outputs = [],
  } = {}
) {
  sources = sources.map((source, index) => ({
    ...source,
    citationNumber: index + 1,
  }));
  const record = await store.transaction(
    async (tx) => {
      signal?.throwIfAborted();
      await assertAnswerContext(
        ctx,
        conversationId,
        contextSources,
        tx,
        historySources,
        pinnedDocuments
      );
      signal?.throwIfAborted();
      const thread = await requireConversation(ctx, conversationId, tx);
      const { chat } = await Chat.new(
        ctx,
        {
          prompt: question,
          response: {
            text: content,
            sources,
            type: chatMode,
            attachments,
            metrics,
            ...(outputs.length ? { outputs } : {}),
          },
          threadId: conversationId,
          include,
        },
        tx.orm
      );
      await ChatThread.autoRenameThread(ctx, thread, question, tx.orm);
      await tx.orm.chat_threads.updateMany({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        },
        data: { lastUpdatedAt: chat.lastUpdatedAt },
      });
      signal?.throwIfAborted();
      return chat;
    },
    { retry: true }
  );
  return pairMessages(record).find((message) => message.role === "assistant");
}

async function assertAnswerContext(
  ctx,
  conversationId,
  sources,
  db = store,
  _historySources = [],
  pinnedDocuments = []
) {
  try {
    await refreshContext(ctx, db);
    await requireConversation(ctx, conversationId, db);
    const current = await currentSources(ctx, sources, db);
    if (current.length !== sources.length)
      throw fail(409, "引用资料在生成过程中已更新或删除，请重新提问");
    await assertPinnedDocuments(ctx, pinnedDocuments, db);
    return current;
  } catch (error) {
    error.enterpriseGuard = true;
    throw error;
  }
}

async function assertPinnedDocuments(ctx, documents, db = store) {
  if (!documents.length) return;
  const current = await Document.where(
    ctx,
    {
      id: { in: documents.map((document) => document.id) },
      status: "ready",
    },
    {},
    db.orm
  );
  if (
    documents.some(
      (document) =>
        !current.some(
          (row) => row.id === document.id && row.version === document.version
        )
    )
  )
    throw fail(409, "固定资料在生成过程中已更新或撤销授权，请重新提问");
}

async function executeChat({
  ctx,
  threadId,
  prompt: question,
  attachments = [],
  mode,
  onEvent = null,
  onToolApproval = null,
  signal,
  libraryIds = null,
  persist = true,
  history: suppliedHistory = [],
  agentTransport = "http",
  reasoningEffort = null,
  systemPrompt: promptOverride = null,
  model = null,
  temperature = null,
}) {
  if (typeof question !== "string" || !question.trim())
    throw fail(400, "请输入问题");
  question = question.trim();
  const originalQuestion = question;
  if (ctx.identity !== "embed") await refreshContext(ctx);
  else await validatePublishedContext(ctx, libraryIds);
  if (persist) {
    threadId = Number(threadId);
    const currentUser = await refreshContext(ctx);
    if (
      !(await require("../models/user").User.canSendChat(
        currentUser,
        store.orm
      ))
    )
      throw fail(429, "您已达到过去24小时的消息额度，请稍后再试");
    await requireConversation(ctx, threadId);
  }
  if (ctx.identity !== "embed")
    await require("../endpoints/agentFileServer").validateGeneratedImageAccess(
      attachments,
      ctx
    );
  const key = `${ctx.tenantId}:${ctx.userId}:${threadId}`;
  if (persist && generating.has(key))
    throw fail(409, "该对话正在生成回答，请等待完成");
  if (persist) generating.add(key);
  const uuid = require("crypto").randomUUID();
  try {
    const settings = await getSettings(ctx.tenantId);
    if (mode) settings.chatMode = mode;
    if (ctx.identity !== "embed") {
      const { grepCommand, VALID_COMMANDS } = require("../utils/chats");
      const command = await grepCommand(question, ctx, store.orm);
      if (Object.hasOwn(VALID_COMMANDS, command)) {
        if (!persist) throw fail(400, "此命令需要个人会话");
        const result =
          command === "/reset"
            ? await store.transaction(
                async (tx) => {
                  await refreshContext(ctx, tx);
                  await requireConversation(ctx, threadId, tx);
                  return VALID_COMMANDS[command]({
                    ctx,
                    threadId,
                    configuration: settings,
                    db: tx.orm,
                  });
                },
                { retry: true }
              )
            : await require("./execution-context").runExecution(ctx, () =>
                VALID_COMMANDS[command]({
                  message: question,
                  msgUUID: uuid,
                  onEvent,
                  attachments,
                  signal,
                  canConfigure: ctx.identity === "platform",
                })
              );
        signal?.throwIfAborted();
        await assertAnswerContext(ctx, threadId, []);
        if (result.error) throw fail(502, result.error);
        const message = result.outputs?.length
          ? await saveChatPair(
              ctx,
              threadId,
              originalQuestion,
              result.textResponse,
              [],
              { signal, attachments, outputs: result.outputs }
            )
          : {
              role: "assistant",
              content: result.textResponse,
              sources: [],
              ephemeral: true,
            };
        await onEvent?.({
          ...result,
          id: uuid,
          type: "finalizeResponseStream",
          close: true,
          error: false,
          message,
          chatId: message.id,
        });
        return { ...result, message, chatId: message.id };
      }
      question = command;
    }
    const { parsedDocuments, imageAttachments } =
      await require("../utils/chats/attachments").processDocumentAttachments(
        attachments
      );
    attachments = imageAttachments;
    const history = persist
      ? await modelHistory(ctx, threadId, settings.openAiHistory ?? 20)
      : protocolHistory(suppliedHistory);
    const { AgentHandler } = require("../utils/agents");
    if (
      ctx.identity !== "embed" &&
      (await AgentHandler.isAgentInvocation({
        message: question,
        workspace: settings,
        chatMode: settings.chatMode,
      }))
    ) {
      if (persist && agentTransport === "websocket") {
        const { invocation } =
          await require("../models/workspaceAgentInvocation").WorkspaceAgentInvocation.new(
            { ctx, threadId, prompt: question }
          );
        if (!invocation) throw fail(500, "无法创建 Agent 会话");
        require("../utils/chats/agents").cacheInvocationOptions(
          invocation.uuid,
          { attachments, reasoningEffort }
        );
        await onEvent?.({
          id: uuid,
          type: "agentInitWebsocketConnection",
          websocketUUID: invocation.uuid,
          close: true,
          error: false,
        });
        return { websocketUUID: invocation.uuid };
      }
      const {
        EphemeralAgentHandler,
        EphemeralEventListener,
      } = require("../utils/agents/ephemeral");
      const agent = await new EphemeralAgentHandler({
        ctx,
        uuid,
        prompt: question,
        threadId,
        attachments,
        parsedDocuments,
      }).init();
      const handler = new EphemeralEventListener();
      const closed = handler.waitForClose();
      await agent.createAIbitat({ handler, onToolApproval });
      const aborted = () => {
        agent.aibitat.abort();
        handler.close();
      };
      signal?.addEventListener("abort", aborted, { once: true });
      try {
        signal?.throwIfAborted();
        await agent.startAgentCluster();
        const result = await closed;
        signal?.throwIfAborted();
        if (!result.textResponse) throw fail(502, "Agent 未返回回答");
        await refreshContext(ctx);
        const incoming = result.citations || [];
        const authorized = await currentSources(
          ctx,
          incoming.filter((source) => source.documentId)
        );
        if (
          authorized.length !==
          incoming.filter((source) => source.documentId).length
        )
          throw fail(409, "引用资料在生成过程中已更新或删除，请重新提问");
        const citations = incoming.filter(
          (source) =>
            !source.documentId ||
            authorized.some((allowed) => allowed.id === source.id)
        );
        const outputs = agent.getPendingOutputs();
        const message = persist
          ? await saveChatPair(
              ctx,
              threadId,
              originalQuestion,
              result.textResponse,
              citations,
              {
                signal,
                chatMode: "chat",
                attachments,
                metrics: result.metrics || {},
                outputs,
                contextSources: citations.filter((source) => source.documentId),
              }
            )
          : {
              role: "assistant",
              content: result.textResponse,
              sources: citations,
              metrics: result.metrics || {},
              outputs,
            };
        await onEvent?.({
          id: uuid,
          type: "textResponseChunk",
          textResponse: result.textResponse,
          sources: [],
          close: false,
          error: false,
        });
        await onEvent?.({
          id: uuid,
          type: "finalizeResponseStream",
          textResponse: result.textResponse,
          sources: citations,
          outputs,
          close: true,
          error: false,
          chatId: message.id,
          message,
        });
        return {
          message,
          chatId: message.id,
          textResponse: result.textResponse,
          sources: citations,
          outputs,
          metrics: result.metrics || {},
        };
      } finally {
        signal?.removeEventListener("abort", aborted);
      }
    }

    const readable = await store.one(
      `SELECT d.id FROM ep_documents d JOIN ep_libraries l ON l.id=d."libraryId" AND l."tenantId"=d."tenantId" WHERE ${Document.libraryAccessSQL()} AND d.status='ready' ${libraryIds?.length ? `AND d."libraryId" IN (${libraryIds.map((_, i) => `$${i + 3}`).join(",")})` : ""} LIMIT 1`,
      ctx.tenantId,
      ctx.userId,
      ...(libraryIds || [])
    );
    let sources = [];
    if (readable) {
      const embedding = await providers.resolveConnection(ctx, "embedding");
      sources = await retrieve(ctx, question, embedding, settings, {
        signal,
        libraryIds,
      });
    }
    sources = await currentSources(ctx, sources);
    const pinnedDocs =
      ctx.identity === "embed"
        ? []
        : await Document.pinnedContext(
            ctx,
            Number.POSITIVE_INFINITY,
            store.orm
          );
    const documents = [
      ...pinnedDocs,
      ...parsedDocuments,
      ...(persist
        ? await require("../models/workspaceParsedFiles").ParsedFiles.getContextFiles(
            ctx,
            threadId,
            store.orm
          )
        : []),
    ];
    const { contextTexts } = require("./prompt-context").prepareChatContext(
      history,
      sources,
      { documents, topK: settings.topK }
    );
    const shouldGenerate =
      settings.chatMode !== "query" || contextTexts.length > 0;
    let content = settings.queryRefusalResponse || NO_EVIDENCE;
    let metrics = {};
    let chatConnection;
    if (shouldGenerate) {
      chatConnection = await providers.resolveConnection(ctx, "chat", {
        signal,
        ctx,
        configuration: settings,
        thread: { id: threadId },
        prompt: question,
        attachments,
        model,
        temperature,
      });
      const systemPrompt =
        promptOverride ??
        (await require("../utils/chats").chatPrompt(
          { openAiPrompt: await require("./settings").defaultPrompt(ctx) },
          ctx,
          {
            prompt: question,
            rawHistory: history,
            skipMemories: !persist,
            variablesExpanded: true,
          }
        ));
      const packed = await packPrompt(
        chatConnection,
        question,
        history,
        sources,
        {
          systemPrompt,
          attachments,
          contextTexts,
        }
      );
      sources = packed.sources;
      const check = async () => {
        signal?.throwIfAborted();
        if (persist)
          await assertAnswerContext(
            ctx,
            threadId,
            sources,
            store,
            [],
            pinnedDocs
          );
        else if (ctx.identity === "embed")
          await validatePublishedContext(ctx, libraryIds);
        else {
          await refreshContext(ctx);
          await assertPinnedDocuments(ctx, pinnedDocs);
          if ((await currentSources(ctx, sources)).length !== sources.length)
            throw fail(409, "引用资料在生成过程中已更新或删除，请重新提问");
        }
      };
      await check();
      if (
        chatConnection.resolvedProvider?.routingMetadata?.routedTo?.shouldNotify
      )
        await onEvent?.({
          type: "modelRouteNotification",
          uuid,
          ...chatConnection.resolvedProvider.routingMetadata,
        });
      let pendingText = "";
      let deliveredText = false;
      let deliveredAt = 0;
      const flushText = async () => {
        if (!pendingText || !onEvent) return;
        await check();
        const textResponse = pendingText;
        pendingText = "";
        await onEvent({
          id: uuid,
          type: "textResponseChunk",
          textResponse,
          sources: [],
          close: false,
          error: false,
        });
        deliveredText = true;
        deliveredAt = Date.now();
      };
      content = await providers.complete(
        chatConnection,
        packed.messages,
        onEvent
          ? async (textResponse) => {
              pendingText += textResponse;
              // Deliver the first token immediately, then authorize/send small
              // token batches instead of querying PostgreSQL for every token.
              if (
                !deliveredText ||
                pendingText.length >= 32 ||
                Date.now() - deliveredAt >= 32
              )
                await flushText();
            }
          : null,
        {
          signal,
          ctx,
          configuration: settings,
          reasoningEffort,
          onMetrics: (value) => {
            metrics = value || {};
          },
        }
      );
      if (typeof content !== "string" || !content.trim())
        throw fail(502, "聊天模型未返回有效回答");
      await check();
      if (onEvent) {
        if (!deliveredText && !pendingText) pendingText = content;
        await flushText();
      }
    }
    signal?.throwIfAborted();
    const answerSources = [
      ...documents.map(({ pageContent, ...metadata }) => ({
        ...metadata,
        text:
          pageContent.slice(0, 1000) +
          (pageContent.length > 1000
            ? "...continued on in source document..."
            : ""),
      })),
      ...sources,
    ];
    const message = persist
      ? await saveChatPair(
          ctx,
          threadId,
          originalQuestion,
          content,
          answerSources,
          {
            signal,
            contextSources: sources,
            pinnedDocuments: pinnedDocs,
            chatMode: settings.chatMode,
            include: shouldGenerate,
            attachments,
            metrics,
          }
        )
      : { role: "assistant", content, sources: answerSources, metrics };
    await onEvent?.({
      id: uuid,
      type: "finalizeResponseStream",
      textResponse: content,
      sources: answerSources,
      metrics,
      close: true,
      error: false,
      chatId: message.id,
      message,
    });
    return {
      message,
      chatId: message.id,
      textResponse: content,
      sources: answerSources,
      metrics,
    };
  } finally {
    if (persist) generating.delete(key);
  }
}

async function validatePublishedContext(ctx, libraryIds) {
  const tenant = await store.orm.ep_tenants.findFirst({
    where: { id: ctx.tenantId, status: "active" },
  });
  const libraries = await store.orm.ep_libraries.count({
    where: {
      id: { in: libraryIds || [] },
      tenantId: ctx.tenantId,
      grants: { some: { tenantId: ctx.tenantId } },
    },
  });
  if (!tenant || libraries !== libraryIds?.length || !libraries)
    throw fail(403, "发布的知识范围已失效");
}

async function executePublishedChat({ tenantId, libraryId, ...options }) {
  // Only a service-loaded publication chooses this boundary, never a user body.
  const ctx = {
    identity: "embed",
    tenantId,
    userId: 0,
  };
  await validatePublishedContext(ctx, [libraryId]);
  return executeChat({
    ...options,
    ctx,
    persist: false,
    libraryIds: [libraryId],
  });
}

function protocolHistory(history) {
  if (!history[0]?.role) return history.map((row) => ({ ...row }));
  const rows = [];
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i]?.role !== "user" || history[i + 1]?.role !== "assistant")
      continue;
    rows.push({
      prompt: history[i].content,
      response: JSON.stringify({ text: history[i + 1].content }),
    });
    i++;
  }
  return rows;
}

function registerRag(router, { authenticate = tenantAuth } = {}) {
  const requireAuth = authenticate;
  require("../endpoints/utils").registerChatExport(router, {
    authenticate: requireAuth,
  });
  router.get(
    "/chat/capabilities",
    requireAuth,
    wrap(async (req, res) => {
      const configuration = await getSettings(req.ep.tenantId);
      const connection = await providers.resolveConnection(req.ep, "chat", {
        ctx: req.ep,
        configuration,
      });
      const result =
        await require("../utils/helpers/reasoningEffort").getReasoningCapabilities(
          connection.resolvedProvider
        );
      res.json(result);
    })
  );
  router.patch(
    "/platform/conversations/:id",
    requirePlatformAuth,
    wrap(async (req, res) => {
      if (typeof req.body.title !== "string" || !req.body.title.trim())
        throw fail(400, "请输入对话标题");
      const result = await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const result = await tx.orm.chat_threads.updateMany({
            where: { id: recordId(req.params.id) },
            data: { name: req.body.title.trim(), lastUpdatedAt: new Date() },
          });
          if (!result.count) throw fail(404, "对话不存在");
          return tx.orm.chat_threads.findUnique({
            where: { id: recordId(req.params.id) },
          });
        },
        { retry: true }
      );
      res.json({ conversation: conversationView(result) });
    })
  );
  router.delete(
    "/platform/conversations/:id",
    requirePlatformAuth,
    wrap(async (req, res) => {
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const thread = await tx.orm.chat_threads.findUnique({
            where: { id: recordId(req.params.id) },
          });
          if (!thread) throw fail(404, "对话不存在");
          await tx.orm.chats.deleteMany({ where: { thread_id: thread.id } });
          await tx.orm.workspace_agent_invocations.deleteMany({
            where: { thread_id: thread.id },
          });
          await require("../models/workspaceParsedFiles").ParsedFiles.delete(
            {
              identity: "tenant",
              tenantId: thread.tenantId,
              userId: thread.userId,
            },
            (
              await tx.orm.workspace_parsed_files.findMany({
                where: { threadId: thread.id },
                select: { id: true },
              })
            ).map((file) => file.id),
            tx.orm
          );
          await tx.orm.chat_threads.delete({ where: { id: thread.id } });
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  router.post(
    "/platform/conversations/:id/reset-history",
    requirePlatformAuth,
    wrap(async (req, res) => {
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const thread = await tx.orm.chat_threads.findUnique({
            where: { id: recordId(req.params.id) },
          });
          if (!thread) throw fail(404, "对话不存在");
          await tx.orm.chats.updateMany({
            where: { thread_id: thread.id },
            data: { include: false },
          });
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  router.patch(
    "/platform/messages/:id",
    requirePlatformAuth,
    wrap(async (req, res) => {
      if (
        !["user", "assistant"].includes(req.body.role) ||
        typeof req.body.content !== "string" ||
        !req.body.content.trim()
      )
        throw fail(400, "消息内容无效");
      const record = await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const target = await tx.orm.chats.findUnique({
            where: { id: recordId(req.params.id) },
          });
          if (!target) throw fail(404, "消息不存在");
          const data =
            req.body.role === "user"
              ? { prompt: req.body.content }
              : {
                  response: JSON.stringify({
                    ...safeJsonParse(target.response, {}),
                    text: req.body.content,
                  }),
                };
          return tx.orm.chats.update({
            where: { id: target.id },
            data: { ...data, lastUpdatedAt: new Date() },
          });
        },
        { retry: true }
      );
      res.json({ messages: pairMessages(record) });
    })
  );
  router.delete(
    "/platform/messages/:id",
    requirePlatformAuth,
    wrap(async (req, res) => {
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const result = await tx.orm.chats.updateMany({
            where: { id: recordId(req.params.id) },
            data: { include: false, lastUpdatedAt: new Date() },
          });
          if (!result.count) throw fail(404, "消息不存在");
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  router.get(
    "/platform/conversations",
    requirePlatformAuth,
    wrap(async (req, res) => {
      const threads = await store.orm.chat_threads.findMany({
        where: req.query.tenantId ? { tenantId: req.query.tenantId } : {},
        orderBy: { lastUpdatedAt: "desc" },
      });
      res.json({ conversations: threads.map(conversationView) });
    })
  );
  router.get(
    "/platform/conversations/:id",
    requirePlatformAuth,
    wrap(async (req, res) => {
      const conversation = await store.orm.chat_threads.findUnique({
        where: { id: recordId(req.params.id) },
      });
      if (!conversation) throw fail(404, "对话不存在");
      const records = await store.orm.chats.findMany({
        where: { thread_id: conversation.id, include: true },
        orderBy: { id: "asc" },
      });
      const messages = records.flatMap(pairMessages);
      // Review preserves the saved conversation snapshot; it does not use or
      // grant access to source bodies in an ordinary tenant request.
      res.json({ conversation: conversationView(conversation), messages });
    })
  );
  router.get(
    "/conversations",
    requireAuth,
    wrap(async (req, res) => {
      const threads = await ChatThread.where(req.ep, {}, {}, store.orm);
      res.json({ conversations: threads.map(conversationView) });
    })
  );
  router.post(
    "/conversations",
    requireAuth,
    wrap(async (req, res) => {
      const thread = await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const { thread } = await ChatThread.new(
            req.ep,
            { name: req.body.title },
            tx.orm
          );
          return thread;
        },
        { retry: true }
      );
      res.status(201).json({ conversation: conversationView(thread) });
    })
  );
  router.get(
    "/conversations/:id",
    requireAuth,
    wrap(async (req, res) => {
      const conversation = await requireConversation(req.ep, req.params.id);
      const records = await Chat.forThread(
        req.ep,
        conversation.id,
        {},
        store.orm
      );
      const messages = records.flatMap(pairMessages);
      // Citation labels and saved answers are historical snapshots. Opening a
      // source remains a separately authorized document request.
      res.json({ conversation: conversationView(conversation), messages });
    })
  );
  router.patch(
    "/conversations/:id",
    requireAuth,
    wrap(async (req, res) => {
      if (typeof req.body.title !== "string" || !req.body.title.trim())
        throw fail(400, "请输入对话标题");
      const conversation = await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          await requireConversation(req.ep, req.params.id, tx);
          const { thread } = await ChatThread.update(
            req.ep,
            recordId(req.params.id),
            { name: req.body.title },
            tx.orm
          );
          return thread;
        },
        { retry: true }
      );
      res.json({ conversation: conversationView(conversation) });
    })
  );
  router.delete(
    "/conversations/:id",
    requireAuth,
    wrap(async (req, res) => {
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const conversation = await requireConversation(
            req.ep,
            req.params.id,
            tx
          );
          await ChatThread.delete(req.ep, conversation.id, tx.orm);
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  router.post(
    "/conversations/:id/reset-history",
    requireAuth,
    wrap(async (req, res) => {
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          await requireConversation(req.ep, req.params.id, tx);
          await Chat.markThreadHistoryInvalid(
            req.ep,
            recordId(req.params.id),
            tx.orm
          );
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  router.post(
    "/messages/:id/feedback",
    requireAuth,
    wrap(async (req, res) => {
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const result = await Chat.updateFeedbackScore(
            req.ep,
            recordId(req.params.id),
            req.body.feedbackScore,
            tx.orm
          );
          if (!result.count) throw fail(404, "消息不存在或无权访问");
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  router.patch(
    "/messages/:id",
    requireAuth,
    wrap(async (req, res) => {
      if (
        !["user", "assistant"].includes(req.body.role) ||
        typeof req.body.content !== "string" ||
        !req.body.content.trim()
      )
        throw fail(400, "消息内容无效");
      const record = await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const chat = await Chat.get(
            req.ep,
            { id: recordId(req.params.id) },
            tx.orm
          );
          if (!chat) throw fail(404, "消息不存在或无权访问");
          const response = safeJsonParse(chat.response, {}) || {};
          const data =
            req.body.role === "user"
              ? { prompt: req.body.content }
              : {
                  response: { ...response, text: req.body.content },
                };
          return Chat.update(req.ep, chat.id, data, tx.orm);
        },
        { retry: true }
      );
      res.json({ messages: pairMessages(record) });
    })
  );
  router.delete(
    "/messages/:id",
    requireAuth,
    wrap(async (req, res) => {
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const record = await Chat.get(
            req.ep,
            { id: recordId(req.params.id) },
            tx.orm
          );
          if (!record) throw fail(404, "消息不存在或无权访问");
          await Chat.update(req.ep, record.id, { include: false }, tx.orm);
        },
        { retry: true }
      );
      res.json({ success: true });
    })
  );
  router.post(
    "/messages/:id/truncate",
    requireAuth,
    wrap(async (req, res) => {
      let prompt, attachments;
      await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const target = await Chat.get(
            req.ep,
            { id: recordId(req.params.id) },
            tx.orm
          );
          if (!target) throw fail(404, "消息不存在或无权访问");
          if (
            generating.has(
              `${req.ep.tenantId}:${req.ep.userId}:${target.thread_id}`
            )
          )
            throw fail(409, "对话正在生成回答");
          if (req.body.regenerate === true) {
            const last = await Chat.forThread(
              req.ep,
              target.thread_id,
              { limit: 1, include: true, orderBy: { id: "desc" } },
              tx.orm
            );
            if (last[0]?.id !== target.id)
              throw fail(409, "只能重新生成最后一条回答");
          }
          prompt = target.prompt;
          attachments = safeJsonParse(target.response, {})?.attachments || [];
          await Chat.delete(
            req.ep,
            { thread_id: target.thread_id, id: { gte: target.id } },
            tx.orm
          );
        },
        { retry: true }
      );
      res.json({ success: true, prompt, attachments });
    })
  );
  router.post(
    "/messages/:id/fork",
    requireAuth,
    wrap(async (req, res) => {
      const thread = await store.transaction(
        async (tx) => {
          await refreshContext(req.ep, tx);
          const target = await Chat.get(
            req.ep,
            { id: recordId(req.params.id) },
            tx.orm
          );
          if (!target) throw fail(404, "消息不存在或无权访问");
          const records = await Chat.where(
            req.ep,
            {
              thread_id: target.thread_id,
              include: true,
              api_session_id: null,
              id: { lte: target.id },
            },
            {},
            tx.orm
          );
          const { thread: created } = await ChatThread.new(
            req.ep,
            {
              name: require("truncate")(
                require("../utils/helpers").stripThinkingFromText(
                  safeJsonParse(target.response, {})?.text || target.prompt
                ) || target.prompt,
                22
              ),
            },
            tx.orm
          );
          for (const row of records)
            await Chat.new(
              req.ep,
              {
                prompt: row.prompt,
                response: safeJsonParse(row.response, {}),
                threadId: created.id,
              },
              tx.orm
            );
          await require("../models/workspaceParsedFiles").ParsedFiles.fork(
            req.ep,
            target.thread_id,
            created.id,
            tx.orm
          );
          return created;
        },
        { retry: true }
      );
      res.status(201).json({ conversation: conversationView(thread) });
    })
  );
  router.post(
    "/conversations/:id/messages",
    requireAuth,
    wrap(async (req, res) => {
      const controller = new AbortController();
      const disconnected = () => {
        if (!res.writableEnded) controller.abort(fail(499, "客户端已取消回答"));
      };
      res.on("close", disconnected);
      try {
        if (req.body.stream === true) {
          res.status(200).set({
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders();
        }
        const result = await executeChat({
          ctx: req.ep,
          threadId: req.params.id,
          prompt: req.body.message,
          attachments: req.body.attachments || [],
          reasoningEffort: req.body.reasoningEffort,
          agentTransport: req.body.agentTransport,
          signal: controller.signal,
          onEvent:
            req.body.stream === true
              ? (event) => {
                  if (!res.destroyed && !res.writableEnded)
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                }
              : null,
        });
        if (req.body.stream === true) res.end();
        else res.json(result);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!res.headersSent) throw error;
        res.write(
          `data: ${JSON.stringify({ type: "abort", textResponse: null, error: error.message, close: true })}\n\n`
        );
        res.end();
      } finally {
        res.off("close", disconnected);
      }
    })
  );
}

module.exports = {
  registerRag,
  executeChat,
  executePublishedChat,
  currentSources,
  retrieve,
  modelHistory,
  requireConversation,
  parseSources,
  assertAnswerContext,
  pairMessages,
};
