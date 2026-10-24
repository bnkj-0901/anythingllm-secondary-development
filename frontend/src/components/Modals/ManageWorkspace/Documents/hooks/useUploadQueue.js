import { useCallback, useEffect, useState, useRef } from "react";
import { v4 } from "uuid";
import System from "@/models/system";
import { groupDroppedFiles, groupFilesIntoFolder } from "@/utils/folderUpload";

/**
 * The queue of in-flight uploads, shared by every drop target in the picker.
 *
 * There are two ways to start an upload and they must feed the same queue and
 * the same progress list: the dropzone under the picker, where the drop's own
 * folder structure decides the destination, and an individual folder row,
 * where the user has named the destination by dropping onto it.
 */
export default function useUploadQueue(options = {}) {
  /** Whether the document processor is up; nothing can be uploaded if not. */
  const [ready, setReady] = useState(false);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const request = useRef(null);
  const scoped = options.ready !== undefined;
  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (scoped) return;
    let cancelled = false;
    System.checkDocumentProcessorOnline().then((online) => {
      if (!cancelled) setReady(online);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Queue a drop on the main dropzone. Loose files land in custom-documents;
   * a dropped folder becomes a folder of the same name.
   * @param {File[]} accepted
   * @param {Array<{file: File, errors: Array<{code: string}>}>} rejections
   */
  const enqueueDrop = useCallback(
    (accepted = [], rejections = []) => {
      const grouped = groupDroppedFiles(accepted);
      const additions = [
        ...grouped.looseFiles.map((file) => ({ uid: v4(), file })),
        ...grouped.folders.flatMap(({ folderName, files: folderFiles }) =>
          folderFiles.map(({ file, relativePath }) => ({
            uid: v4(),
            file,
            folderName,
            relativePath,
          }))
        ),
        ...rejections.map((rejection) => ({
          uid: v4(),
          file: rejection.file,
          rejected: true,
          reason: rejection.errors[0].code,
        })),
      ];
      if (scoped) {
        const validated = additions.map((item) => {
          const reason = item.reason || options.validate?.(item.file) || "";
          return {
            ...item,
            relativePath: item.relativePath || item.file.name,
            reason,
            status: reason ? "rejected" : "queued",
          };
        });
        setFiles((current) =>
          options.multiple === false
            ? validated.slice(0, 1)
            : [...current, ...validated]
        );
      } else setFiles(additions);
    },
    [scoped, options.validate, options.multiple]
  );

  /**
   * Queue a drop that was aimed at a specific folder row.
   * @param {File[]} accepted
   * @param {string} folderName
   * @returns {{queued: number, skipped: number}}
   */
  const enqueueIntoFolder = useCallback((accepted = [], folderName) => {
    const { files: targeted, skipped } = groupFilesIntoFolder(
      accepted,
      folderName
    );
    if (targeted.length > 0) {
      setFiles(
        targeted.map(({ file, relativePath }) => ({
          uid: v4(),
          file,
          folderName,
          relativePath,
        }))
      );
    }
    return { queued: targeted.length, skipped };
  }, []);

  async function uploadAll(destination, onlyId) {
    if (request.current) return { busy: true };
    const selected = files.filter(
      (item) =>
        (!onlyId || item.uid === onlyId) &&
        ["queued", "failed"].includes(item.status)
    );
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    const failures = [];
    let uploaded = 0;
    const update = (uid, patch) => {
      if (!controller.signal.aborted)
        setFiles((current) =>
          current.map((item) =>
            item.uid === uid ? { ...item, ...patch } : item
          )
        );
    };
    try {
      for (const item of selected) {
        controller.signal.throwIfAborted();
        const target = item.destination || destination;
        update(item.uid, {
          status: "uploading",
          reason: "",
          destination: target,
        });
        try {
          await options.uploadFile(item.file, target, controller.signal);
          controller.signal.throwIfAborted();
          update(item.uid, { status: "complete" });
          uploaded++;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          failures.push(err.message);
          update(item.uid, { status: "failed", reason: err.message });
        }
      }
      return {
        uploaded,
        failures,
        rejected: files
          .filter((item) => item.status === "rejected")
          .map((item) => item.reason),
      };
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }
  function clear() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setFiles([]);
  }
  function remove(uid) {
    if (!busy)
      setFiles((current) => current.filter((item) => item.uid !== uid));
  }

  return {
    ready: scoped ? options.ready : ready,
    files,
    setFiles,
    enqueueDrop,
    enqueueIntoFolder,
    ...(scoped ? { busy, uploadAll, clear, remove } : {}),
  };
}
