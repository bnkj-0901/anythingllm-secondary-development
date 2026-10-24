const { Document } = require("../models/documents.js");
const { DocumentSyncQueue } = require("../models/documentSyncQueue.js");
const { CollectorApi } = require("../utils/collectorApi");
const { log, conclude } = require("./helpers/index.js");
const { DocumentSyncRun } = require("../models/documentSyncRun.js");

async function syncWatchedDocuments() {
  try {
    const queuesToProcess = await DocumentSyncQueue.staleDocumentQueues();
    if (queuesToProcess.length === 0) {
      log("No outstanding documents to sync. Exiting.");
      return;
    }

    const collector = new CollectorApi();
    if (!(await collector.online())) {
      log("Could not reach collector API. Exiting.");
      return;
    }

    log(
      `${queuesToProcess.length} watched documents have been found to be stale and will be updated now.`
    );
    for (const queue of queuesToProcess) {
      let newContent = null;
      const document = queue.document;
      let identity;
      try {
        identity =
          await require("../enterprise/execution-context").loadExecutionContext(
            queue
          );
        await require("../enterprise/knowledge").requireDocument(
          identity,
          document.id
        );
      } catch {
        continue;
      } // A disabled account or revoked grant pauses its watch.

      const { metadata, type, source } =
        Document.parseDocumentTypeAndSource(document);

      if (!metadata || !DocumentSyncQueue.validFileTypes.includes(type)) {
        // Document is either broken, invalid, or not supported so drop it from future queues.
        log(
          `Document ${document.title} has no metadata, is broken, or invalid and has been removed from all future runs.`
        );
        await DocumentSyncQueue.unwatch(identity, document);
        continue;
      }

      if (["link", "youtube"].includes(type)) {
        const response = await collector.forwardExtensionRequest({
          endpoint: "/ext/resync-source-document",
          method: "POST",
          body: JSON.stringify({
            type,
            options: { link: source },
          }),
        });
        newContent = response?.content;
      }

      if (
        ["confluence", "github", "gitlab", "gitea", "drupalwiki"].includes(type)
      ) {
        const response = await collector.forwardExtensionRequest({
          endpoint: "/ext/resync-source-document",
          method: "POST",
          body: JSON.stringify({
            type,
            options: { chunkSource: metadata.chunkSource },
          }),
        });
        newContent = response?.content;
      }

      if (!newContent) {
        // Check if the last "x" runs were all failures (not exits!). If so - remove the job entirely since it is broken.
        const failedRunCount = (
          await DocumentSyncRun.where(
            { queueId: queue.id },
            DocumentSyncQueue.maxRepeatFailures,
            { createdAt: "desc" }
          )
        ).filter(
          (run) => run.status === DocumentSyncRun.statuses.failed
        ).length;
        if (failedRunCount >= DocumentSyncQueue.maxRepeatFailures) {
          log(
            `Document ${document.title} has failed to refresh ${failedRunCount} times continuously and will now be removed from the watched document set.`
          );
          await DocumentSyncQueue.unwatch(identity, document);
          continue;
        }

        log(
          `Failed to get a new content response from collector for source ${source}. Skipping, but will retry next worker interval. Attempt ${failedRunCount === 0 ? 1 : failedRunCount}/${DocumentSyncQueue.maxRepeatFailures}`
        );
        await DocumentSyncQueue.saveRun(
          queue.id,
          DocumentSyncRun.statuses.failed,
          {
            filename: document.title,
            workspacesModified: [],
            reason: "No content found.",
          }
        );
        continue;
      }

      if (document.content === newContent) {
        const nextSync = DocumentSyncQueue.calcNextSync(queue);
        log(
          `Source ${source} is unchanged and will be skipped. Next sync will be ${nextSync.toLocaleString()}.`
        );
        await DocumentSyncQueue._update(queue.id, {
          lastSyncedAt: new Date().toISOString(),
          nextSyncAt: nextSync.toISOString(),
        });
        await DocumentSyncQueue.saveRun(
          queue.id,
          DocumentSyncRun.statuses.exited,
          {
            filename: document.title,
            workspacesModified: [],
            reason: "Content unchanged.",
          }
        );
        continue;
      }

      // A source update uses the same content mutation as an interactive user.
      // Public revisions remain pending; the published version stays searchable.
      const result =
        await require("../enterprise/knowledge").submitSyncedContent(
          identity,
          document.id,
          newContent
        );
      await DocumentSyncQueue._update(queue.id, {
        lastSyncedAt: new Date(),
        nextSyncAt: DocumentSyncQueue.calcNextSync(queue),
        failedAttempts: 0,
      });
      await DocumentSyncQueue.saveRun(
        queue.id,
        DocumentSyncRun.statuses.success,
        {
          filename: document.title,
          libraryId: document.libraryId,
          approvalRequired: !!result.approvalRequired,
        }
      );
    }
  } catch (e) {
    console.error(e);
    log(`errored with ${e.message}`);
  }
}

if (require.main === module) syncWatchedDocuments().finally(conclude);
module.exports = { syncWatchedDocuments };
