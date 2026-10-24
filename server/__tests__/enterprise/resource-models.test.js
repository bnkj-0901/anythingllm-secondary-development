const { createPostgresFixture } = require("./postgres-fixture.cjs");
let mockDefaultOrm;
// Production callers omit the explicit database argument. Keep that path on
// the same real disposable database instead of using the developer's client.
jest.mock(
  "../../utils/prisma",
  () =>
    new Proxy(
      {},
      {
        get(_target, key) {
          const value = mockDefaultOrm[key];
          return typeof value === "function"
            ? value.bind(mockDefaultOrm)
            : value;
        },
      }
    )
);
const { Document } = require("../../models/documents");
const { DocumentVectors } = require("../../models/vectors");
const { Chat } = require("../../models/workspaceChats");
const { ChatThread } = require("../../models/workspaceThread");

let fixture, orm;
const owner = { identity: "tenant", tenantId: "a", userId: 1 };
const peer = { identity: "tenant", tenantId: "a", userId: 2 };
const foreign = { identity: "tenant", tenantId: "b", userId: 3 };
const stamp = "2026-10-22T00:00:00.000Z";
beforeAll(async () => {
  fixture = await createPostgresFixture();
  orm = fixture.prisma;
  mockDefaultOrm = orm;
  for (const id of ["a", "b"])
    await orm.ep_tenants.create({
      data: {
        id,
        code: id,
        name: id,
        hostname: `${id}.example.test`,
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  for (const ctx of [owner, peer, foreign])
    await orm.users.create({
      data: {
        id: ctx.userId,
        tenantId: ctx.tenantId,
        username: `employee-${ctx.userId}`,
        name: `Employee ${ctx.userId}`,
        passwordHash: "unused",
        role: ctx === peer ? "admin" : "user",
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
  for (const [id, visibility, ctx] of [
    ["public", "public", owner],
    ["private", "private", owner],
    ["foreign", "public", foreign],
  ]) {
    await orm.ep_libraries.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        name: id,
        createdBy: String(ctx.userId),
        grants: {
          create: {
            id: `grant-${id}`,
            ...(visibility === "public"
              ? { tenantId: ctx.tenantId }
              : { userId: ctx.userId }),
          },
        },
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
    await Document.new(
      ctx,
      {
        id,
        libraryId: id,
        title: id,
        content: "source",
        inputType: "text",
        status: "ready",
        createdAt: stamp,
        updatedAt: stamp,
      },
      orm
    );
  }
}, 30000);
afterAll(async () => fixture?.cleanup());

test("pinned context uses only currently authorized ready documents and respects the original token budget", async () => {
  await Document.update(owner,"private",{pinned:true},orm);
  await Document.update(owner,"public",{pinned:true},orm);
  expect((await Document.pinnedContext(owner,Infinity,orm)).map((d)=>d.documentId).sort()).toEqual(["private","public"]);
  expect((await Document.pinnedContext(peer,Infinity,orm)).map((d)=>d.documentId)).toEqual(["public"]);
  expect(await Document.pinnedContext(foreign,Infinity,orm)).toEqual([]);
  expect(await Document.pinnedContext(owner,0,orm)).toEqual([]);
  await Document.update(owner,"private",{status:"processing"},orm);
  expect((await Document.pinnedContext(owner,Infinity,orm)).map((d)=>d.documentId)).toEqual(["public"]);
  await Document.update(owner,"private",{status:"ready",pinned:false},orm);
  await Document.update(owner,"public",{pinned:false},orm);
});

test("enterprise suggested questions replace atomically without overwriting another tenant", async () => {
  const { SuggestedMessages } = require("../../models/workspacesSuggestedMessages");
  await SuggestedMessages.saveAll([{heading:"A",message:"Company A?"}],"a",orm);
  await SuggestedMessages.saveAll([{heading:"B",message:"Company B?"}],"b",orm);
  await SuggestedMessages.saveAll([{heading:"A2",message:"New question?"}],"a",orm);
  expect(await SuggestedMessages.getMessages("a",orm)).toEqual([{heading:"A2",message:"New question?"}]);
  expect(await SuggestedMessages.getMessages("b",orm)).toEqual([{heading:"B",message:"Company B?"}]);
  await expect(SuggestedMessages.saveAll([{heading:"bad"}],"a",orm)).rejects.toMatchObject({status:400});
  expect(await SuggestedMessages.getMessages("a",orm)).toHaveLength(1);
});

test("document model scopes all reads to tenant public and personal private knowledge", async () => {
  expect(
    (await Document.where(owner, {}, { orderBy: { id: "asc" } }, orm)).map(
      (row) => row.id
    )
  ).toEqual(["private", "public"]);
  expect(await Document.count(peer, {}, orm)).toBe(1);
  expect(await Document.get(peer, { id: "private" }, orm)).toBeNull();
  expect(await Document.get(foreign, { id: "public" }, orm)).toBeNull();
  await expect(Document.content(peer, "private", orm)).rejects.toMatchObject({
    status: 404,
  });
  expect(await Document.content(owner, "private", orm)).toEqual({
    title: "private",
    content: "source",
  });
  for (const ctx of [
    null,
    { tenantId: "a" },
    { identity: "platform", userId: "" },
  ])
    await expect(Document.get(ctx, {}, orm)).rejects.toMatchObject({
      status: 403,
    });
});

test("document writes force actor ownership and cannot move documents into another library", async () => {
  await expect(
    Document.new(peer, { libraryId: "private" }, orm)
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    Document.new(owner, { libraryId: "foreign" }, orm)
  ).rejects.toMatchObject({ status: 404 });
  const created = await Document.new(
    peer,
    {
      id: "created",
      libraryId: "public",
      tenantId: "b",
      createdBy: "foreign",
      updatedBy: "foreign",
      title: "before",
      inputType: "text",
      status: "pending",
      createdAt: stamp,
      updatedAt: stamp,
    },
    orm
  );
  expect(created).toMatchObject({
    tenantId: "a",
    createdBy: "2",
    updatedBy: "2",
  });
  expect(
    (
      await Document.update(
        peer,
        created.id,
        { title: "after", tenantId: "b", libraryId: "foreign" },
        orm
      )
    ).count
  ).toBe(1);
  expect(await Document.get(owner, { id: created.id }, orm)).toMatchObject({
    title: "after",
    tenantId: "a",
    libraryId: "public",
  });
  expect(
    (await Document.update(peer, "private", { content: "stolen" }, orm)).count
  ).toBe(0);
  expect((await Document.delete(peer, { id: "private" }, orm)).count).toBe(0);
  expect((await Document.delete(peer, { id: created.id }, orm)).count).toBe(1);
});

test("trusted top administrator can manage private knowledge across enterprises without becoming an enterprise user", async () => {
  const top = {identity: "platform", userId: "top-admin"};
  expect(await Document.get(top, {id: "private"}, orm)).toMatchObject({tenantId: "a"});
  expect(await Document.get(top, {id: "foreign"}, orm)).toMatchObject({tenantId: "b"});
  const created = await Document.new(top, {
    id: "platform-document", libraryId: "private", title: "Administrative correction",
    inputType: "text", status: "ready", content: "reviewed", createdAt: stamp, updatedAt: stamp,
  }, orm);
  expect(created).toMatchObject({tenantId: "a", createdBy: "top-admin", updatedBy: "top-admin"});
  expect((await Document.update(top, created.id, {title: "Corrected"}, orm)).count).toBe(1);
  expect(await Document.get(top, {id: created.id}, orm)).toMatchObject({title: "Corrected", updatedBy: "top-admin"});
  expect((await Document.delete(top, {id: created.id}, orm)).count).toBe(1);
  // Personal execution still requires an actual enterprise user. Administrative
  // chat access uses the explicit audited management routes instead.
  await expect(ChatThread.new(top, {}, orm)).rejects.toMatchObject({status: 401});
});

test("index metadata uses exactly the document policy without storing vector arrays", async () => {
  const record = {
    id: "chunk",
    documentId: "private",
    tenantId: "b",
    version: 1,
    position: 0,
    content: "source",
    embeddingId: "embed:1",
    dimensions: 3,
    namespace: "test",
  };
  expect(await DocumentVectors.bulkInsert(owner, [], orm)).toEqual({
    documentsInserted: 0,
  });
  await expect(
    DocumentVectors.bulkInsert(peer, [record], orm)
  ).rejects.toMatchObject({ status: 404 });
  expect(await DocumentVectors.bulkInsert(owner, [record], orm)).toEqual({
    documentsInserted: 1,
  });
  expect(await DocumentVectors.where(peer, {}, orm)).toEqual([]);
  expect((await DocumentVectors.where(owner, {}, orm))[0]).toMatchObject({
    tenantId: "a",
    dimensions: 3,
  });
  expect((await DocumentVectors.deleteIds(foreign, ["chunk"], orm)).count).toBe(
    0
  );
  expect((await DocumentVectors.deleteIds(owner, ["chunk"], orm)).count).toBe(
    1
  );
  expect(await DocumentVectors.where({identity: "platform", userId: "top"}, {}, orm)).toEqual([]);
});

test("conversation model methods cannot override current identity through query or update data", async () => {
  const { thread } = await ChatThread.new(owner, {}, orm);
  expect(thread.name).toBe("Thread");
  expect(
    await ChatThread.get(peer, { id: thread.id, userId: 1 }, orm)
  ).toBeNull();
  expect(
    (await ChatThread.update(peer, thread.id, { name: "foreign" }, orm)).thread
  ).toBeNull();
  expect(await ChatThread.delete(peer, thread.id, orm)).toBe(false);
  expect((await ChatThread.update(owner, null, {}, orm)).thread).toBeNull();
  expect(await ChatThread.delete(owner, null, orm)).toBe(false);
  expect(await ChatThread.autoRenameThread(owner, null, "hello", orm)).toBe(
    false
  );
  expect(await ChatThread.autoRenameThread(owner, thread, "hello", orm)).toBe(
    false
  );
  await expect(
    Chat.new(
      peer,
      { threadId: thread.id, prompt: "question", response: { text: "answer" } },
      orm
    )
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    Chat.new(owner, { threadId: thread.id, prompt: "question" }, orm)
  ).rejects.toMatchObject({ status: 400 });
  const { chat } = await Chat.new(
    owner,
    { threadId: thread.id, prompt: "question", response: { text: "answer" } },
    orm
  );
  expect(
    await Chat.get(peer, { id: chat.id, userId: 1 }, orm)
  ).toBeNull();
  expect(await Chat.count(foreign, {}, orm)).toBe(0);
  expect(await Chat.forThread(owner, null, {}, orm)).toEqual([]);
  expect(
    (await Chat.where(owner, {}, { limit: 1, offset: 0 }, orm))[0].id
  ).toBe(chat.id);
  expect((await ChatThread.where(owner, {}, { limit: 1 }, orm))[0].id).toBe(
    thread.id
  );
  expect(
    (
      await Chat.forThread(owner, thread.id, { include: true, limit: 1 }, orm)
    )[0].id
  ).toBe(chat.id);
  expect(
    await ChatThread.autoRenameThread(
      owner,
      thread,
      "This prompt is deliberately longer than twenty-two characters",
      orm
    )
  ).toBe(true);
  expect((await ChatThread.get(owner, { id: thread.id }, orm)).name).toBe(
    "This prompt is deliber…"
  );
  expect(
    await ChatThread.autoRenameThread(
      owner,
      { ...thread, name: "renamed" },
      "hello",
      orm
    )
  ).toBe(false);
  expect(
    (
      await ChatThread.update(
        owner,
        thread.id,
        { name: " ", userId: 2 },
        orm
      )
    ).thread.userId
  ).toBe(1);
  expect(
    (await ChatThread.update(owner, thread.id, { name: "  edited  " }, orm))
      .thread.name
  ).toBe("  edited  ");
  await expect(
    Chat.updateFeedbackScore(owner, chat.id, "invalid", orm)
  ).rejects.toMatchObject({ status: 400 });
  expect((await Chat.updateFeedbackScore(peer, chat.id, true, orm)).count).toBe(
    0
  );
  await Chat.updateFeedbackScore(owner, chat.id, null, orm);
  await Chat.updateFeedbackScore(owner, chat.id, false, orm);
  await Chat.markMemoryProcessed(owner, [null, "", chat.id], orm);
  expect(await Chat.markMemoryProcessed(owner, [], orm)).toBeUndefined();
  expect((await Chat.get(owner, { id: chat.id }, orm)).memoryProcessed).toBe(
    true
  );
  expect(await Chat.markThreadHistoryInvalid(owner, null, orm)).toEqual({
    count: 0,
  });
  await Chat.markThreadHistoryInvalid(owner, thread.id, orm);
  expect(
    await Chat.forThread(owner, thread.id, { include: true }, orm)
  ).toEqual([]);
  expect(await ChatThread.delete(owner, thread.id, orm)).toBe(true);
  await expect(Chat.count(null, {}, orm)).rejects.toMatchObject({
    status: 401,
  });
});

test("original document source parsing and thread slug rules remain available", () => {
  expect(Document.parseDocumentTypeAndSource({ metadata: "broken" })).toEqual({
    metadata: null,
    type: null,
    source: null,
  });
  expect(
    Document.parseDocumentTypeAndSource({
      metadata: JSON.stringify({
        chunkSource: "github://https://example.test/a?token=unused",
      }),
    }).source
  ).toBe("https://example.test/a");
  expect(Document._stripSource("source.txt", "file")).toBe("source.txt");
  expect(ChatThread.slugify("a+b", { lower: true })).toContain("plus");
});

test.each([
  ["missing identity", undefined],
  ["non-string tenant", { tenantId: 1, userId: 1 }],
  ["empty tenant", { tenantId: "", userId: 1 }],
  ["string user", { tenantId: "a", userId: "1" }],
  ["empty user", { tenantId: "a", userId: "" }],
  ["empty platform identity", { identity: "platform", userId: "" }],
])(
  "resource models reject %s before querying or mutating enterprise data",
  async (_label, ctx) => {
    const before = await Promise.all([
      orm.documents.count(),
      orm.document_vectors.count(),
      orm.chat_threads.count(),
      orm.chats.count(),
    ]);
    await expect(
      Document.get(ctx, { id: "public" }, orm)
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      Document.new(ctx, { libraryId: "public" }, orm)
    ).rejects.toMatchObject({ status: 403 });
    await expect(DocumentVectors.where(ctx, {}, orm)).rejects.toMatchObject({
      status: 403,
    });
    await expect(DocumentVectors.delete(ctx, {}, orm)).rejects.toMatchObject({
      status: 403,
    });
    await expect(Chat.get(ctx, {}, orm)).rejects.toMatchObject({ status: 401 });
    await expect(ChatThread.new(ctx, {}, orm)).rejects.toMatchObject({
      status: 401,
    });
    expect(
      await Promise.all([
        orm.documents.count(),
        orm.document_vectors.count(),
        orm.chat_threads.count(),
        orm.chats.count(),
      ])
    ).toEqual(before);
  }
);

test("nested caller clauses cannot replace tenant or private-document policy", async () => {
  const malicious = {
    OR: [{ tenantId: "b" }, { id: "private" }],
  };
  expect(await Document.where(peer, malicious, {}, orm)).toEqual([]);
  expect(await Document.count(peer, malicious, orm)).toBe(0);
  expect((await Document.delete(peer, malicious, orm)).count).toBe(0);
  const record = {
    id: "scoped-chunk",
    documentId: "private",
    version: 1,
    position: 0,
    content: "private source",
    embeddingId: "embed:1",
    dimensions: 3,
    namespace: "test",
  };
  await DocumentVectors.bulkInsert(owner, [record], orm);
  try {
    expect(
      await DocumentVectors.where(
        peer,
        { OR: [{ tenantId: "b" }, { documentId: "private" }] },
        orm
      )
    ).toEqual([]);
    expect(
      (
        await DocumentVectors.delete(
          peer,
          { OR: [{ tenantId: "b" }, { documentId: "private" }] },
          orm
        )
      ).count
    ).toBe(0);
    expect(
      await DocumentVectors.where(owner, { id: record.id }, orm)
    ).toHaveLength(1);
    expect(await Document.get(owner, { id: "private" }, orm)).not.toBeNull();
    expect(await Document.get(foreign, { id: "foreign" }, orm)).not.toBeNull();
  } finally {
    await DocumentVectors.deleteIds(owner, [record.id], orm);
  }
});

test("incomplete turns and missing thread identifiers never create chat records", async () => {
  const { thread } = await ChatThread.new(owner, { name: "Validation" }, orm);
  const valid = {
    threadId: thread.id,
    prompt: "question",
    response: { text: "answer" },
  };
  try {
    for (const patch of [
      { prompt: null },
      { prompt: "" },
      { prompt: "   " },
      { response: null },
      { response: { text: 12 } },
      { response: { text: "" } },
      { response: { text: "   " } },
      { threadId: null },
      { threadId: "12" },
      { threadId: "" },
    ]) {
      await expect(
        Chat.new(owner, { ...valid, ...patch }, orm)
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      Chat.new(owner, { ...valid, threadId: 999999 }, orm)
    ).rejects.toMatchObject({ status: 404 });
    expect(await Chat.count(owner, { thread_id: thread.id }, orm)).toBe(0);
    expect(await Chat.forThread(owner, 12, {}, orm)).toEqual([]);
    expect(await Chat.markThreadHistoryInvalid(owner, 12, orm)).toEqual({
      count: 0,
    });
  } finally {
    await ChatThread.delete(owner, thread.id, orm);
  }
});

test("thread and turn payloads cannot impersonate another tenant or user", async () => {
  const originalTitle = `  My conversation ${"x".repeat(120)}  `;
  const { thread } = await ChatThread.new(
    owner,
    {
      tenantId: "b",
      userId: 3,
      name: originalTitle,
      slug: "custom+thread",
    },
    orm
  );
  try {
    expect(thread).toMatchObject({
      tenantId: "a",
      userId: 1,
      name: originalTitle,
      slug: "custom-plus-thread",
    });
    const { chat } = await Chat.new(
      owner,
      {
        threadId: thread.id,
        tenantId: "b",
        userId: 3,
        prompt: "question",
        response: { text: "answer" },
      },
      orm
    );
    expect(chat).toMatchObject({ tenantId: "a", userId: 1 });
    expect(
      await Chat.where(
        peer,
        { OR: [{ id: chat.id }, { tenantId: "a", userId: 1 }] },
        {},
        orm
      )
    ).toEqual([]);
    expect(
      await ChatThread.where(
        foreign,
        { OR: [{ id: thread.id }, { tenantId: "a", userId: 1 }] },
        {},
        orm
      )
    ).toEqual([]);
    expect(
      await Chat.delete(
        peer,
        { id: chat.id, tenantId: "a", userId: 1 },
        orm
      )
    ).toBe(true);
    expect(await Chat.get(owner, { id: chat.id }, orm)).not.toBeNull();
    expect(
      (
        await ChatThread.update(
          owner,
          thread.id,
          {
            name: `  Edited ${originalTitle}  `,
            tenantId: "b",
            userId: 3,
          },
          orm
        )
      ).thread
    ).toMatchObject({
      name: `  Edited ${originalTitle}  `,
      tenantId: "a",
      userId: 1,
    });
  } finally {
    await ChatThread.delete(owner, thread.id, orm);
  }
});

test("automatic naming cannot overwrite a title changed after the chat loaded", async () => {
  const { thread } = await ChatThread.new(owner, {}, orm);
  try {
    await Chat.new(
      owner,
      { threadId: thread.id, prompt: "question", response: { text: "answer" } },
      orm
    );
    expect(await ChatThread.autoRenameThread(owner, thread, "", orm)).toBe(
      false
    );
    await ChatThread.update(owner, thread.id, { name: "My edited title" }, orm);
    expect(
      await ChatThread.autoRenameThread(
        owner,
        thread,
        "An old generated title",
        orm
      )
    ).toBe(false);
    expect((await ChatThread.get(owner, { id: thread.id }, orm)).name).toBe(
      "My edited title"
    );
  } finally {
    await ChatThread.delete(owner, thread.id, orm);
  }
});

test("the production default repository completes a scoped resource lifecycle without an injected database", async () => {
  const ctx = {
    identity: "tenant",
    tenantId: "lifecycle",
    userId: 4,
  };
  await orm.ep_tenants.create({
    data: {
      id: ctx.tenantId,
      code: ctx.tenantId,
      name: ctx.tenantId,
      hostname: "lifecycle.example.test",
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  await orm.users.create({
    data: {
      id: ctx.userId,
      tenantId: ctx.tenantId,
      username: `employee-${ctx.userId}`,
      name: `Employee ${ctx.userId}`,
      passwordHash: "unused",
      role: "user",
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  await orm.ep_libraries.create({
    data: {
      id: "lifecycle-library",
      tenantId: ctx.tenantId,
      name: "Lifecycle",
      createdBy: String(ctx.userId),
      grants: { create: { id: "lifecycle-grant", userId: ctx.userId } },
      createdAt: stamp,
      updatedAt: stamp,
    },
  });
  const otherDocuments = await Document.count(owner);
  const created = await Document.new(ctx, {
    id: "lifecycle-document",
    libraryId: "lifecycle-library",
    title: "Original",
    inputType: "text",
    content: "Scoped content",
    status: "ready",
    createdAt: stamp,
    updatedAt: stamp,
  });
  expect((await Document.get(ctx)).id).toBe(created.id);
  expect((await Document.where(ctx)).map((row) => row.id)).toEqual([
    created.id,
  ]);
  expect(await Document.count(ctx)).toBe(1);
  expect((await Document.update(ctx, created.id)).count).toBe(1);
  expect(await Document.content(ctx, created.id)).toEqual({
    title: "Original",
    content: "Scoped content",
  });
  expect(await DocumentVectors.bulkInsert(ctx)).toEqual({
    documentsInserted: 0,
  });
  await DocumentVectors.bulkInsert(ctx, [
    {
      id: "lifecycle-chunk",
      documentId: created.id,
      version: 1,
      position: 0,
      content: "Scoped content",
      embeddingId: "embed:1",
      dimensions: 3,
      namespace: "test",
    },
  ]);
  expect((await DocumentVectors.where(ctx)).map((row) => row.id)).toEqual([
    "lifecycle-chunk",
  ]);
  expect((await DocumentVectors.deleteIds(ctx)).count).toBe(0);
  expect((await DocumentVectors.delete(ctx)).count).toBe(1);

  const { thread } = await ChatThread.new(ctx);
  expect((await ChatThread.get(ctx)).id).toBe(thread.id);
  expect((await ChatThread.where(ctx)).map((row) => row.id)).toEqual([
    thread.id,
  ]);
  expect((await ChatThread.update(ctx, thread.id)).thread.name).toBe(
    ChatThread.defaultName
  );
  const { chat } = await Chat.new(ctx, {
    threadId: thread.id,
    prompt: "question",
    response: { text: "answer" },
  });
  expect((await Chat.get(ctx)).id).toBe(chat.id);
  expect((await Chat.where(ctx)).map((row) => row.id)).toEqual([chat.id]);
  expect(await Chat.count(ctx)).toBe(1);
  expect((await Chat.forThread(ctx, thread.id)).map((row) => row.id)).toEqual([
    chat.id,
  ]);
  expect((await Chat.updateFeedbackScore(ctx, chat.id)).count).toBe(1);
  expect(await Chat.markMemoryProcessed(ctx)).toBeUndefined();
  await Chat.markMemoryProcessed(ctx, [chat.id]);
  expect((await Chat.get(ctx)).memoryProcessed).toBe(true);
  expect(await ChatThread.autoRenameThread(ctx, thread, "New title")).toBe(
    true
  );
  expect((await Chat.markThreadHistoryInvalid(ctx, thread.id)).count).toBe(1);
  expect(await Chat.forThread(ctx, thread.id, { include: true })).toEqual([]);
  expect(await ChatThread.delete(ctx, thread.id)).toBe(true);
  expect(await Chat.count(ctx)).toBe(0);
  expect(await Chat.delete(ctx)).toBe(true);
  expect((await Document.delete(ctx)).count).toBe(1);
  expect(await Document.count(owner)).toBe(otherDocuments);
});
