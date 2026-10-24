import { createAnswerStream, createUtf8Decoder } from "./enterprise-stream.mjs";

export const TOKEN_KEY = "ep_token";
export const SESSION_KEY = "ep_session";

export function normalizeEndpoint(value) {
  const address = String(value || "")
    .trim()
    .replace(/\/+$/, "");
  const match = address.match(
    /^(https?):\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\/api)?$/i
  );
  if (!match) throw new EnterpriseError("企业服务地址配置无效，请联系管理员");
  const [, protocol, hostname, port] = match;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    !host
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    host.length > 253 ||
    (port && (+port < 1 || +port > 65535))
  )
    throw new EnterpriseError("企业服务地址配置无效，请联系管理员");
  if (
    protocol.toLowerCase() !== "https" &&
    host !== "localhost" &&
    !host.endsWith(".localhost") &&
    host !== "127.0.0.1"
  )
    throw new EnterpriseError(
      "企业服务地址需配置 HTTPS，请联系管理员；本地开发地址可使用 HTTP"
    );
  return `${protocol.toLowerCase()}://${host}${port ? `:${+port}` : ""}/api`;
}

export class EnterpriseError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "EnterpriseError";
    this.status = status;
  }
}

// H5 and WeChat share this authenticated transport and session lifecycle.
export function createEnterpriseClient(options = {}) {
  // uni-app injects the platform adapter through the lexical `uni` binding in
  // mini-program builds; it is not guaranteed to exist on globalThis.
  const runtime =
    options.runtime || (typeof uni !== "undefined" ? uni : globalThis.uni);
  const configured = options.baseURL ?? import.meta.env?.VITE_API_BASE ?? "";
  const platform = import.meta.env?.UNI_PLATFORM;
  const isH5 =
    platform === "h5" ||
    (!platform &&
      typeof window !== "undefined" &&
      typeof document !== "undefined");
  const origin = isH5 ? globalThis.location?.origin || "" : "";
  const address = configured === "/api" ? origin : configured || origin;
  let endpoint = "";
  let configurationError = null;
  try {
    endpoint = normalizeEndpoint(address);
  } catch {
    configurationError = new EnterpriseError(
      address
        ? "企业服务地址配置无效，请联系管理员"
        : "企业服务尚未配置，请联系管理员"
    );
  }
  const base = endpoint ? endpoint + "/enterprise" : "";
  let site = null;
  let token = runtime.getStorageSync(TOKEN_KEY) || "";
  let session = null;
  const pending = new Set();
  let epoch = 0;
  let avatarFile = "";
  let avatarRequest = 0;

  function removeAvatarFile(file) {
    if (!file) return;
    if (file.startsWith("blob:")) globalThis.URL?.revokeObjectURL?.(file);
    else runtime.getFileSystemManager?.().unlink({ filePath: file, fail() {} });
  }
  function discardAvatar() {
    avatarRequest += 1;
    removeAvatarFile(avatarFile);
    avatarFile = "";
  }

  function cancelPending() {
    epoch += 1;
    for (const task of pending) task.abort?.();
    pending.clear();
  }

  function clearSession() {
    cancelPending();
    discardAvatar();
    token = "";
    session = null;
    site = null;
    runtime.removeStorageSync(TOKEN_KEY);
    runtime.removeStorageSync(SESSION_KEY);
  }
  function tenantSession(value, authToken) {
    if (
      value?.identity !== "tenant" ||
      !["admin", "user"].includes(value?.role)
    ) {
      clearSession();
      throw new EnterpriseError("请使用企业账号登录", 403);
    }
    if (
      typeof authToken !== "string" ||
      !authToken ||
      !value.user?.id ||
      typeof value.user.username !== "string" ||
      !value.user.username ||
      !value.tenant?.id ||
      typeof value.tenant.name !== "string" ||
      !value.tenant.name ||
      typeof value.tenant.code !== "string" ||
      !value.tenant.code ||
      (site && site.tenant.id !== value.tenant.id)
    ) {
      clearSession();
      throw new EnterpriseError("登录服务没有返回有效的企业身份，请重新登录");
    }
    return {
      identity: "tenant",
      user: {
        id: value.user.id,
        username: value.user.username,
        name: value.user.name || value.user.username,
        ...(Object.hasOwn(value.user, "pfpFilename")
          ? { pfpFilename: value.user.pfpFilename || null }
          : {}),
        ...(typeof value.user.wechatBound === "boolean"
          ? { wechatBound: value.user.wechatBound }
          : {}),
        ...(typeof value.user.wechatRegistrationRequired === "boolean"
          ? {
              wechatRegistrationRequired: value.user.wechatRegistrationRequired,
            }
          : {}),
      },
      tenant: {
        id: value.tenant.id,
        code: value.tenant.code,
        name: value.tenant.name,
      },
      role: value.role,
      token: authToken,
    };
  }
  const savedSession = runtime.getStorageSync(SESSION_KEY);
  if (token || savedSession) {
    try {
      if (!endpoint || savedSession?.endpoint !== endpoint)
        throw new EnterpriseError("企业服务配置已变更，请重新登录");
      session = tenantSession(savedSession, token);
    } catch {
      clearSession();
    }
  }
  function setSession(value) {
    const nextSession = tenantSession(value, value?.token);
    discardAvatar();
    epoch += 1;
    token = nextSession.token;
    session = nextSession;
    session.endpoint = endpoint;
    runtime.setStorageSync(TOKEN_KEY, token);
    runtime.setStorageSync(SESSION_KEY, session);
    return session;
  }
  function handleResponse(response, expectedEpoch) {
    if (expectedEpoch !== epoch)
      throw new EnterpriseError("会话已变更，请重新操作", 409);
    const status = Number(response.statusCode) || 0;
    let data = response.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        if (status >= 200 && status < 300)
          throw new EnterpriseError("服务返回了无法识别的数据，请重试", status);
        data = {};
      }
    }
    if (status === 401) {
      clearSession();
      options.onUnauthorized?.();
    }
    if (status < 200 || status >= 300 || data?.error) {
      throw new EnterpriseError(
        typeof data?.error === "string"
          ? data.error
          : data?.message ||
            (status === 401
              ? "登录已过期，请重新登录"
              : `请求失败（${status || "网络"}）`),
        status
      );
    }
    return data || {};
  }
  function request(path, method = "GET", data) {
    if (!base) return Promise.reject(configurationError);
    const expectedEpoch = epoch;
    return new Promise((resolve, reject) => {
      let task;
      task = runtime.request({
        url: base + path,
        method,
        data,
        timeout: 120000,
        header: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        success(response) {
          try {
            resolve(handleResponse(response, expectedEpoch));
          } catch (error) {
            reject(error);
          }
        },
        fail(error) {
          reject(
            new EnterpriseError(
              /abort/i.test(error?.errMsg || "")
                ? "请求已取消"
                : "无法连接服务，请检查网络与服务地址"
            )
          );
        },
        complete() {
          pending.delete(task);
        },
      });
      if (task) pending.add(task);
    });
  }
  function openKnowledgeOriginal(id) {
    if (!base) return Promise.reject(configurationError);
    if (!runtime.downloadFile || !runtime.openDocument)
      return Promise.reject(
        new EnterpriseError("请在网页端下载并查看待审原件")
      );
    const expectedEpoch = epoch;
    return new Promise((resolve, reject) => {
      let task;
      task = runtime.downloadFile({
        url: `${base}/knowledge-changes/${encodeURIComponent(id)}/download`,
        header: token ? { Authorization: `Bearer ${token}` } : {},
        success(response) {
          try {
            handleResponse(
              { statusCode: response.statusCode, data: {} },
              expectedEpoch
            );
            if (!response.tempFilePath)
              throw new EnterpriseError("原件下载失败，请重试");
            runtime.openDocument({
              filePath: response.tempFilePath,
              showMenu: true,
              success: resolve,
              fail: () =>
                reject(
                  new EnterpriseError("该文件无法预览，请在网页端下载查看")
                ),
            });
          } catch (error) {
            reject(error);
          }
        },
        fail: () => reject(new EnterpriseError("原件下载失败，请重试")),
        complete() {
          pending.delete(task);
        },
      });
      if (task) pending.add(task);
    });
  }
  function uploadFile(path, file, formData = {}, onProgress = () => {}) {
    if (!base) return Promise.reject(configurationError);
    const expectedEpoch = epoch;
    let underlying,
      settled = false,
      resolveResult,
      rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const task = {
      abort() {
        if (settled) return;
        const error = new EnterpriseError("上传已取消");
        error.cancelled = true;
        finish(error);
        underlying?.abort?.();
      },
    };
    function finish(error, value) {
      if (settled) return;
      settled = true;
      pending.delete(task);
      if (error) rejectResult(error);
      else resolveResult(value);
    }
    result.cancel = () => task.abort();
    pending.add(task);
    try {
      underlying = runtime.uploadFile({
        url: base + path,
        filePath: file.path || file.tempFilePath,
        file:
          typeof Blob !== "undefined" && (file.file || file) instanceof Blob
            ? file.file || file
            : undefined,
        name: "file",
        formData,
        timeout: 120000,
        header: token ? { Authorization: `Bearer ${token}` } : {},
        success(response) {
          if (settled) return;
          // A 401 clears pending work; keep this completed upload's real error.
          pending.delete(task);
          try {
            finish(null, handleResponse(response, expectedEpoch));
          } catch (error) {
            finish(error);
          }
        },
        fail() {
          finish(new EnterpriseError("文件上传失败，请检查网络后重试"));
        },
      });
      underlying?.onProgressUpdate?.((event) => {
        if (!settled && expectedEpoch === epoch) onProgress(event);
      });
    } catch (error) {
      finish(error);
    }
    return result;
  }
  function upload(libraryId, file, onProgress) {
    return uploadFile(
      "/documents/upload",
      file,
      { libraryId, ...(file.name ? { title: file.name } : {}) },
      onProgress
    );
  }
  function avatar() {
    if (!base) return Promise.reject(configurationError);
    if (!session?.user.pfpFilename || !runtime.downloadFile)
      return Promise.resolve("");
    const expectedEpoch = epoch;
    const expectedRequest = ++avatarRequest;
    return new Promise((resolve, reject) => {
      let task;
      task = runtime.downloadFile({
        url: `${base}/me/avatar`,
        header: token ? { Authorization: `Bearer ${token}` } : {},
        success(response) {
          try {
            handleResponse(
              { statusCode: response.statusCode, data: {} },
              expectedEpoch
            );
            if (expectedRequest !== avatarRequest)
              throw new EnterpriseError("头像请求已更新", 409);
            discardAvatar();
            avatarFile =
              response.statusCode === 204 ? "" : response.tempFilePath || "";
            resolve(avatarFile);
          } catch (error) {
            removeAvatarFile(response.tempFilePath);
            reject(error);
          }
        },
        fail: () => reject(new EnterpriseError("头像加载失败")),
        complete() {
          pending.delete(task);
        },
      });
      if (task) pending.add(task);
    });
  }
  function streamMessage(id, message, onEvent = () => {}) {
    const expectedEpoch = epoch;
    let underlying;
    let settled = false;
    let resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const task = {
      abort() {
        if (settled) return;
        const error = new EnterpriseError(
          expectedEpoch === epoch ? "已停止生成" : "会话已变更，请重新操作",
          expectedEpoch === epoch ? 0 : 409
        );
        error.cancelled = true;
        finish(error);
        underlying?.abort?.();
      },
    };
    result.cancel = () => task.abort();
    function finish(error, value) {
      if (settled) return;
      settled = true;
      pending.delete(task);
      if (error) rejectResult(error);
      else resolveResult(value);
    }
    function current() {
      if (settled) return false;
      if (expectedEpoch !== epoch) {
        finish(new EnterpriseError("会话已变更，请重新操作", 409));
        return false;
      }
      return true;
    }
    const parser = createAnswerStream((event) => {
      if (current()) onEvent(event);
    });
    const decoder = createUtf8Decoder();
    const consume = (chunk, final = false) => {
      if (!current()) return;
      parser.append(typeof chunk === "string" ? chunk : decoder(chunk, final));
    };
    const complete = () => {
      if (!current()) return;
      consume(null, true);
      finish(null, parser.finish());
    };
    if (!base) {
      finish(configurationError);
      return result;
    }
    pending.add(task);
    const url = `${base}/conversations/${encodeURIComponent(id)}/messages`;
    const header = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const data = { message, stream: true };
    const fetchStream =
      options.fetch ||
      (typeof window !== "undefined" && typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null);
    if (fetchStream) {
      const controller = new AbortController();
      underlying = { abort: () => controller.abort() };
      (async () => {
        let reader;
        try {
          const response = await fetchStream(url, {
            method: "POST",
            headers: header,
            body: JSON.stringify(data),
            signal: controller.signal,
          });
          if (!current()) return;
          if (!response.ok) {
            let value = {};
            try {
              value = await response.json();
            } catch {
              /* Error body is optional. */
            }
            pending.delete(task);
            handleResponse(
              { statusCode: response.status, data: value },
              expectedEpoch
            );
          }
          if (
            !response.headers
              .get("content-type")
              ?.includes("text/event-stream") ||
            !response.body
          )
            throw new EnterpriseError("服务未返回流式回答，请重试");
          reader = response.body.getReader();
          while (current()) {
            const { value, done } = await reader.read();
            if (!current()) return;
            if (done) break;
            consume(value);
          }
          complete();
        } catch (error) {
          if (!settled)
            finish(
              expectedEpoch !== epoch && error?.status !== 401
                ? new EnterpriseError("会话已变更，请重新操作", 409)
                : error instanceof Error
                  ? error
                  : new EnterpriseError("回答连接失败，请重试")
            );
        } finally {
          await reader?.cancel?.().catch(() => {});
          reader?.releaseLock?.();
        }
      })();
    } else {
      let statusCode = 0;
      let chunks = 0;
      let errorBody = "";
      try {
        underlying = runtime.request({
          url,
          method: "POST",
          data,
          header,
          timeout: 120000,
          enableChunked: true,
          responseType: "arraybuffer",
          success(response) {
            if (!current()) return;
            try {
              statusCode = Number(response.statusCode) || statusCode;
              if (statusCode < 200 || statusCode >= 300) {
                const raw = chunks
                  ? errorBody + decoder(null, true)
                  : typeof response.data === "string"
                    ? response.data
                    : response.data instanceof ArrayBuffer ||
                        ArrayBuffer.isView(response.data)
                      ? decoder(response.data, true)
                      : response.data;
                pending.delete(task);
                handleResponse({ statusCode, data: raw }, expectedEpoch);
              }
              if (!chunks) consume(response.data);
              complete();
            } catch (error) {
              finish(error);
            }
          },
          fail(error) {
            if (current())
              finish(
                new EnterpriseError(
                  /abort/i.test(error?.errMsg || "")
                    ? "请求已取消"
                    : "回答连接失败，请检查网络后重试"
                )
              );
          },
        });
        underlying?.onHeadersReceived?.((response) => {
          statusCode = Number(response.statusCode) || 0;
        });
        underlying?.onChunkReceived?.(({ data: chunk }) => {
          if (!current()) return;
          chunks++;
          try {
            if (statusCode >= 400) errorBody += decoder(chunk);
            else consume(chunk);
          } catch (error) {
            finish(error);
            underlying?.abort?.();
          }
        });
      } catch (error) {
        finish(error);
      }
    }
    return result;
  }
  return {
    request,
    upload,
    clearSession,
    cancelPending,
    streamMessage,
    getSession: () => session,
    getEndpoint: () => endpoint,
    hasToken: () => !!token,
    async status() {
      const value = await request("/status");
      if (value.site?.kind !== "tenant" || !value.site.tenant?.id) {
        clearSession();
        throw new EnterpriseError(
          "该地址不是已开通的企业入口，请核对企业域名",
          403
        );
      }
      site = value.site;
      return value;
    },
    async login(username, password) {
      if (!String(username || "").trim() || !password)
        throw new EnterpriseError("请填写用户名和密码");
      if (!site) await this.status();
      return setSession(
        await request("/login", "POST", {
          username: String(username).trim(),
          password,
        })
      );
    },
    async wechatLogin() {
      if (!site) await this.status();
      if (!site.tenant.wechatLoginEnabled)
        throw new EnterpriseError("当前企业尚未启用微信登录", 403);
      if (!runtime.login)
        throw new EnterpriseError("请在微信小程序内使用微信登录");
      const expectedEpoch = epoch;
      const code = await new Promise((resolve, reject) => {
        runtime.login({
          provider: "weixin",
          success(result) {
            if (typeof result.code !== "string" || !result.code.trim())
              reject(new EnterpriseError("微信未返回有效登录凭证，请重试"));
            else resolve(result.code);
          },
          fail() {
            reject(new EnterpriseError("微信登录失败，请重试"));
          },
        });
      });
      if (expectedEpoch !== epoch)
        throw new EnterpriseError("会话已变更，请重新操作", 409);
      const value = await request("/wechat/login", "POST", { code });
      return { ...setSession(value), recoveryCodes: value.recoveryCodes || [] };
    },
    async register(username, password) {
      if (!String(username || "").trim() || !password)
        throw new EnterpriseError("请填写用户名和密码");
      if (!site) await this.status();
      const value = await request("/register", "POST", {
        username: String(username).trim(),
        password,
      });
      return { ...setSession(value), recoveryCodes: value.recoveryCodes || [] };
    },
    async me() {
      const value = await request("/me");
      session = tenantSession(value, token);
      session.endpoint = endpoint;
      runtime.setStorageSync(SESSION_KEY, session);
      return session;
    },
    async updateProfile(name) {
      return setSession(await request("/me", "PATCH", { name }));
    },
    async completeWechatRegistration(name, password) {
      const value = await request("/me", "PATCH", { name, password });
      return { ...setSession(value), recoveryCodes: value.recoveryCodes || [] };
    },
    async changePassword(password) {
      return setSession(await request("/me", "PATCH", { password }));
    },
    async uploadAvatar(file) {
      await uploadFile("/me/avatar", file);
      return this.me();
    },
    avatar,
    knowledgeChanges: () => request("/knowledge-changes"),
    openKnowledgeOriginal,
    reviewKnowledge: (id, data) =>
      request(
        `/knowledge-changes/${encodeURIComponent(id)}/review`,
        "POST",
        data
      ),
    cancelKnowledge: (id) =>
      request(`/knowledge-changes/${encodeURIComponent(id)}`, "DELETE"),
    updateLibrary: (id, data) =>
      request(`/libraries/${encodeURIComponent(id)}`, "PATCH", data),
    deleteLibrary: (id) =>
      request(`/libraries/${encodeURIComponent(id)}`, "DELETE"),
    libraries: () => request("/libraries"),
    fileTypes: () => request("/file-types"),
    createLibrary: (data) => request("/libraries", "POST", data),
    documents: (id) =>
      request(
        "/documents" + (id ? `?libraryId=${encodeURIComponent(id)}` : "")
      ),
    document: (id) => request(`/documents/${encodeURIComponent(id)}`),
    createDocument: (data) => request("/documents", "POST", data),
    updateDocument: (id, data) =>
      request(`/documents/${encodeURIComponent(id)}`, "PATCH", data),
    deleteDocument: (id) =>
      request(`/documents/${encodeURIComponent(id)}`, "DELETE"),
    retryDocument: (id) =>
      request(`/documents/${encodeURIComponent(id)}/retry`, "POST"),
    conversations: () => request("/conversations"),
    createConversation: () => request("/conversations", "POST", {}),
    conversation: (id) => request(`/conversations/${encodeURIComponent(id)}`),
    deleteConversation: (id) =>
      request(`/conversations/${encodeURIComponent(id)}`, "DELETE"),
  };
}
