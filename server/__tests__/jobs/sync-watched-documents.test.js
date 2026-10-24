const OLD_CONTENT = "the approved content of the watched document";
const NEW_CONTENT = "the refreshed content of the watched document";
const mockIdentity = { identity: "tenant", tenantId: "company-a", userId: 101 };
const mockCollector = { online: jest.fn(), forwardExtensionRequest: jest.fn() };
const mockKnowledge = {
  requireDocument: jest.fn(),
  submitSyncedContent: jest.fn(),
};
const mockExecution = { loadExecutionContext: jest.fn() };
const mockQueue = {
  validFileTypes: ["link", "github"],
  maxRepeatFailures: 3,
  staleDocumentQueues: jest.fn(),
  calcNextSync: jest.fn(),
  _update: jest.fn(),
  saveRun: jest.fn(),
  unwatch: jest.fn(),
};
const mockRun = {
  statuses: { success: "success", failed: "failed", exited: "exited" },
  where: jest.fn(),
};
const mockDocument = { parseDocumentTypeAndSource: jest.fn() };
jest.mock("../../jobs/helpers", () => ({
  log: jest.fn(),
  conclude: jest.fn(),
}));
jest.mock("../../utils/collectorApi", () => ({
  CollectorApi: jest.fn(() => mockCollector),
}));
jest.mock("../../models/documents", () => ({ Document: mockDocument }));
jest.mock("../../models/documentSyncQueue", () => ({
  DocumentSyncQueue: mockQueue,
}));
jest.mock("../../models/documentSyncRun", () => ({ DocumentSyncRun: mockRun }));
jest.mock("../../enterprise/knowledge", () => mockKnowledge);
jest.mock("../../enterprise/execution-context", () => mockExecution);
const { syncWatchedDocuments } = require("../../jobs/sync-watched-documents");
let queue;

beforeEach(() => {
  jest.clearAllMocks();
  queue = {
    id: 1,
    tenantId: mockIdentity.tenantId,
    userId: mockIdentity.userId,
    document: {
      id: "watched-document",
      tenantId: mockIdentity.tenantId,
      libraryId: "authorized-library",
      title: "watched.html",
      content: OLD_CONTENT,
    },
  };
  mockQueue.staleDocumentQueues.mockResolvedValue([queue]);
  mockQueue.calcNextSync.mockReturnValue(new Date("2026-10-30T00:00:00.000Z"));
  mockCollector.online.mockResolvedValue(true);
  mockCollector.forwardExtensionRequest.mockResolvedValue({
    content: NEW_CONTENT,
  });
  mockExecution.loadExecutionContext.mockResolvedValue(mockIdentity);
  mockKnowledge.requireDocument.mockResolvedValue(queue.document);
  mockKnowledge.submitSyncedContent.mockResolvedValue({
    approvalRequired: false,
  });
  mockRun.where.mockResolvedValue([]);
  mockDocument.parseDocumentTypeAndSource.mockReturnValue({
    metadata: { chunkSource: "link://https://example.com" },
    type: "link",
    source: "https://example.com",
  });
});

test("changed private content uses the authorized mutation/indexing pipeline once and unchanged content does not reindex", async () => {
  mockKnowledge.submitSyncedContent.mockImplementationOnce(async () => {
    queue.document.content = NEW_CONTENT;
    return { approvalRequired: false };
  });
  await syncWatchedDocuments();
  expect(mockExecution.loadExecutionContext).toHaveBeenCalledWith(queue);
  expect(mockKnowledge.requireDocument).toHaveBeenCalledWith(
    mockIdentity,
    "watched-document"
  );
  expect(mockKnowledge.submitSyncedContent).toHaveBeenCalledWith(
    mockIdentity,
    "watched-document",
    NEW_CONTENT
  );
  expect(mockCollector.forwardExtensionRequest).toHaveBeenCalledWith({
    endpoint: "/ext/resync-source-document",
    method: "POST",
    body: JSON.stringify({
      type: "link",
      options: { link: "https://example.com" },
    }),
  });
  expect(mockQueue._update).toHaveBeenCalledWith(
    1,
    expect.objectContaining({
      failedAttempts: 0,
      nextSyncAt: new Date("2026-10-30T00:00:00.000Z"),
    })
  );
  expect(mockQueue.saveRun).toHaveBeenLastCalledWith(1, "success", {
    filename: "watched.html",
    libraryId: "authorized-library",
    approvalRequired: false,
  });
  await syncWatchedDocuments();
  expect(mockKnowledge.submitSyncedContent).toHaveBeenCalledTimes(1);
  expect(mockQueue.saveRun).toHaveBeenLastCalledWith(1, "exited", {
    filename: "watched.html",
    workspacesModified: [],
    reason: "Content unchanged.",
  });
});

test("public revisions are submitted for approval while the published document remains intact", async () => {
  mockKnowledge.submitSyncedContent.mockResolvedValue({
    approvalRequired: true,
  });
  await syncWatchedDocuments();
  expect(queue.document.content).toBe(OLD_CONTENT);
  expect(mockKnowledge.submitSyncedContent).toHaveBeenCalledTimes(1);
  expect(mockQueue.saveRun).toHaveBeenLastCalledWith(1, "success", {
    filename: "watched.html",
    libraryId: "authorized-library",
    approvalRequired: true,
  });
});

test("encrypted connector sources retain their original chunkSource resync contract", async () => {
  mockDocument.parseDocumentTypeAndSource.mockReturnValue({
    metadata: { chunkSource: "github://encrypted-source" },
    type: "github",
    source: "github://encrypted-source",
  });
  await syncWatchedDocuments();
  expect(mockCollector.forwardExtensionRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      body: JSON.stringify({
        type: "github",
        options: { chunkSource: "github://encrypted-source" },
      }),
    })
  );
});

test.each(["disabled employee", "revoked knowledge grant"])(
  "%s pauses watching before contacting the source",
  async (reason) => {
    if (reason === "disabled employee")
      mockExecution.loadExecutionContext.mockRejectedValue(new Error(reason));
    else mockKnowledge.requireDocument.mockRejectedValue(new Error(reason));
    await syncWatchedDocuments();
    expect(mockCollector.forwardExtensionRequest).not.toHaveBeenCalled();
    expect(mockKnowledge.submitSyncedContent).not.toHaveBeenCalled();
    expect(mockQueue._update).not.toHaveBeenCalled();
    expect(mockQueue.unwatch).not.toHaveBeenCalled();
  }
);

test("missing source content records failure and retries on the next worker interval", async () => {
  mockCollector.forwardExtensionRequest.mockResolvedValue({
    success: false,
    content: null,
  });
  await syncWatchedDocuments();
  await syncWatchedDocuments();
  expect(mockCollector.forwardExtensionRequest).toHaveBeenCalledTimes(2);
  expect(mockKnowledge.submitSyncedContent).not.toHaveBeenCalled();
  expect(mockQueue.saveRun).toHaveBeenLastCalledWith(1, "failed", {
    filename: "watched.html",
    workspacesModified: [],
    reason: "No content found.",
  });
  expect(mockQueue.unwatch).not.toHaveBeenCalled();
  expect(mockQueue._update).not.toHaveBeenCalled();
});

test("only consecutive failed refreshes reach the original removal threshold; unchanged exits are not failures", async () => {
  mockCollector.forwardExtensionRequest.mockResolvedValue({ content: null });
  mockRun.where.mockResolvedValueOnce([
    { status: "failed" },
    { status: "exited" },
    { status: "failed" },
  ]);
  await syncWatchedDocuments();
  expect(mockQueue.unwatch).not.toHaveBeenCalled();
  mockRun.where.mockResolvedValue([
    { status: "failed" },
    { status: "failed" },
    { status: "failed" },
  ]);
  await syncWatchedDocuments();
  expect(mockRun.where).toHaveBeenCalledWith({ queueId: 1 }, 3, {
    createdAt: "desc",
  });
  expect(mockQueue.unwatch).toHaveBeenCalledWith(mockIdentity, queue.document);
});

test("invalid source metadata removes only the bound employee's watch", async () => {
  mockDocument.parseDocumentTypeAndSource.mockReturnValue({
    metadata: null,
    type: "unsupported",
    source: null,
  });
  await syncWatchedDocuments();
  expect(mockQueue.unwatch).toHaveBeenCalledWith(mockIdentity, queue.document);
  expect(mockCollector.forwardExtensionRequest).not.toHaveBeenCalled();
});

test("empty queues and an offline collector leave stored content and schedules untouched", async () => {
  mockQueue.staleDocumentQueues.mockResolvedValueOnce([]);
  await syncWatchedDocuments();
  expect(mockCollector.online).not.toHaveBeenCalled();
  mockCollector.online.mockResolvedValue(false);
  await syncWatchedDocuments();
  expect(mockKnowledge.submitSyncedContent).not.toHaveBeenCalled();
  expect(mockQueue._update).not.toHaveBeenCalled();
});
