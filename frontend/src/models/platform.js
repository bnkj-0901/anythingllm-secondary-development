import { fetchEventSource } from "@microsoft/fetch-event-source";
import { API_BASE } from "@/utils/constants";

const BASE = `${API_BASE.replace(/\/$/, "")}/enterprise`;
export const TOKEN_KEY = "ep_token";
const SESSION_KEY = "ep_session";

export function savedSession() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return session?.hostname === window.location.hostname ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  if (session.token) localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ ...session, hostname: window.location.hostname })
  );
}

export function sessionMatchesSite(session, site) {
  if (!session || !["tenant", "platform"].includes(site?.kind)) return false;
  if (session.identity !== site.kind) return false;
  return site.kind === "platform" || session.tenant?.id === site.tenant?.id;
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}

function headers(form = false) {
  const result = form ? {} : { "Content-Type": "application/json" };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

async function failed(response, requestHeaders) {
  let result;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  const currentToken = localStorage.getItem(TOKEN_KEY);
  // An older request may finish after logout/login (including another tab).
  // Only invalidate the session whose credentials the server rejected.
  if (
    response.status === 401 &&
    currentToken &&
    new Headers(requestHeaders).get("Authorization") ===
      `Bearer ${currentToken}`
  ) {
    clearSession();
    window.dispatchEvent(new Event("enterprise:unauthorized"));
  }
  throw new Error(
    result?.error || result?.message || `请求失败（${response.status}）`
  );
}

export async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const requestHeaders = { ...headers(isForm), ...options.headers };
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: requestHeaders,
    body: options.body
      ? isForm
        ? options.body
        : JSON.stringify(options.body)
      : undefined,
  });
  if (!response.ok) return failed(response, requestHeaders);
  if (response.status === 204) return {};
  return response.json();
}

export async function downloadDocument(id, title, { platform = false } = {}) {
  return downloadResource(
    `${platform ? "/platform" : ""}/documents/${encodeURIComponent(id)}/download`,
    title
  );
}

export async function downloadResource(resourcePath, title) {
  const requestHeaders = headers(true);
  const response = await fetch(`${BASE}${resourcePath}`, {
    headers: requestHeaders,
  });
  if (!response.ok) return failed(response, requestHeaders);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  link.download = encoded
    ? decodeURIComponent(encoded[1])
    : plain?.[1] || title;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportConversation(id, type) {
  const requestHeaders = headers();
  const response = await fetch(
    `${BASE}/conversations/${encodeURIComponent(id)}/export/${encodeURIComponent(type)}`,
    {
      method: "POST",
      headers: requestHeaders,
      body: "{}",
    }
  );
  if (!response.ok) return failed(response, requestHeaders);
  return response.blob();
}

export async function streamMessage(
  id,
  message,
  onEvent,
  signal,
  options = {}
) {
  const requestHeaders = headers();
  signal?.throwIfAborted();
  const transport = new AbortController();
  const abort = () => transport.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let complete = false;
  try {
    await fetchEventSource(
      `${BASE}/conversations/${encodeURIComponent(id)}/messages`,
      {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ message, stream: true, ...options }),
        signal: transport.signal,
        openWhenHidden: true,
        async onopen(response) {
          if (!response.ok) return failed(response, requestHeaders);
          signal?.throwIfAborted();
          if (
            !response.headers.get("content-type")?.includes("text/event-stream")
          ) {
            const result = await response.json();
            signal?.throwIfAborted();
            if (!result.message)
              throw new Error("服务没有返回有效回答，请重试。");
            complete = true;
            onEvent({
              type: "finalizeResponseStream",
              message: result.message,
            });
            transport.abort();
            return;
          }
          if (!response.body) throw new Error("回答连接中断，请重试此问题。");
        },
        onmessage({ data }) {
          if (!data || data === "[DONE]") return;
          signal?.throwIfAborted();
          const event = JSON.parse(data);
          if (event.error || event.type === "abort")
            throw new Error(event.error || "回答生成失败");
          if (
            ["finalizeResponseStream", "agentInitWebsocketConnection"].includes(
              event.type
            )
          )
            complete = true;
          onEvent(event);
        },
        onclose() {
          if (!complete) throw new Error("回答连接中断，请重试此问题。");
        },
        onerror(error) {
          // Retrying a POST would create another answer. Surface the failure.
          throw error;
        },
      }
    );
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  signal?.throwIfAborted();
}
