// Upload acceptance and transport progress are separate from index readiness.
// A failed index retries its existing document rather than uploading a duplicate.
export function uploadKnowledgeFile({
  api,
  libraryId,
  file,
  onProgress = () => {},
  onDocument = () => {},
  pollInterval = 1500,
  timeout = 300000,
}) {
  let cancelled = false,
    active,
    timer,
    rejectCancellation;
  const cancellation = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  const started = Date.now();
  const check = () => {
    if (cancelled)
      throw Object.assign(new Error("上传已取消"), { cancelled: true });
  };
  const work = (async () => {
    check();
    active = file.documentId
      ? api.retryDocument(file.documentId)
      : api.upload(libraryId, file, onProgress);
    let result = await active;
    check();
    if (result?.approvalRequired === true) {
      if (!result.change?.id) throw new Error("服务未返回有效的审批申请");
      return { approvalRequired: true, change: result.change };
    }
    let document = result?.document;
    if (!document?.id) throw new Error("服务未返回有效的资料信息");
    const documentId = document.id;
    onDocument(documentId);
    while (document.status !== "ready") {
      check();
      if (document.status === "failed")
        throw new Error(document.error || "解析或索引失败，请重试");
      if (document.status !== "processing")
        throw new Error("服务返回了未知的资料处理状态");
      if (Date.now() - started >= timeout)
        throw new Error("处理仍未完成，请在知识资料中查看进度");
      await new Promise((resolve) => {
        timer = setTimeout(resolve, pollInterval);
      });
      check();
      result = await api.document(documentId);
      check();
      document = result?.document;
      if (document?.id !== documentId)
        throw new Error("服务返回的资料信息不一致");
    }
    return { document };
  })();
  return {
    promise: Promise.race([work, cancellation]).finally(() =>
      clearTimeout(timer)
    ),
    abort() {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      active?.cancel?.();
      rejectCancellation(
        Object.assign(new Error("上传已取消"), { cancelled: true })
      );
    },
  };
}
