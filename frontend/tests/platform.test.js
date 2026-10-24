import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  clearSession,
  downloadDocument,
  exportConversation,
  savedSession,
  saveSession,
  sessionMatchesSite,
  streamMessage,
  TOKEN_KEY,
} from "../src/models/platform";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
});

describe("same-origin session and API", () => {
  it("exports a personal conversation as a binary file using the host-bound session", async () => {
    localStorage.setItem(TOKEN_KEY, "personal-token");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("# Saved chat", {
        headers: { "content-type": "text/markdown" },
      })
    );
    const file = await exportConversation("personal/chat", "markdown");
    expect(await file.text()).toBe("# Saved chat");
    expect(file.type).toBe("text/markdown");
    expect(fetch).toHaveBeenCalledWith(
      "/api/enterprise/conversations/personal%2Fchat/export/markdown",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer personal-token",
        }),
        body: "{}",
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "当前无权访问" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    await expect(exportConversation("other", "json")).rejects.toThrow(
      "当前无权访问"
    );
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("stores a host-scoped session and rejects legacy or copied cache", () => {
    saveSession({
      identity: "tenant",
      tenant: { id: "a" },
      token: "session-token",
    });
    expect(savedSession()).toMatchObject({
      hostname: window.location.hostname,
      identity: "tenant",
    });
    saveSession({ identity: "tenant", tenant: { id: "a" } });
    expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token");
    localStorage.setItem(
      "ep_session",
      JSON.stringify({ identity: "tenant", hostname: "another.example" })
    );
    expect(savedSession()).toBeNull();
    localStorage.setItem(
      "ep_session",
      JSON.stringify({ identity: "platform" })
    );
    expect(savedSession()).toBeNull();
    localStorage.setItem("ep_session", "invalid-json");
    expect(savedSession()).toBeNull();
    clearSession();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
  it("matches tenant and platform identities strictly against the resolved site", () => {
    expect(
      sessionMatchesSite({ identity: "platform" }, { kind: "platform" })
    ).toBe(true);
    expect(
      sessionMatchesSite(
        { identity: "tenant", tenant: { id: "a" } },
        { kind: "tenant", tenant: { id: "a" } }
      )
    ).toBe(true);
    expect(
      sessionMatchesSite(
        { identity: "tenant", tenant: { id: "b" } },
        { kind: "tenant", tenant: { id: "a" } }
      )
    ).toBe(false);
    expect(
      sessionMatchesSite(
        { identity: "platform" },
        { kind: "tenant", tenant: { id: "a" } }
      )
    ).toBe(false);
    expect(sessionMatchesSite(null, { kind: "platform" })).toBe(false);
    expect(
      sessionMatchesSite({ identity: "platform" }, { kind: "unknown" })
    ).toBe(false);
  });
  it("uses same-origin API requests, auth headers and JSON bodies", async () => {
    localStorage.setItem(TOKEN_KEY, "token");
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    await api("/login", {
      method: "POST",
      body: { username: "admin", password: "test" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/enterprise/login",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer token",
        },
        body: '{"username":"admin","password":"test"}',
      })
    );
    const form = new FormData();
    form.append("text", "body");
    await api("/documents", { method: "POST", body: form });
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/enterprise/documents",
      expect.objectContaining({
        body: form,
        headers: { Authorization: "Bearer token" },
      })
    );
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 204 });
    expect(await api("/documents/id", { method: "DELETE" })).toEqual({});
  });
  it("clears a rejected host-bound token and emits unauthorized", async () => {
    saveSession({ identity: "tenant", token: "stale" });
    const listener = vi.fn();
    window.addEventListener("enterprise:unauthorized", listener);
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "域名与身份不匹配" }),
    });
    await expect(api("/me")).rejects.toThrow("域名与身份不匹配");
    expect(savedSession()).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("enterprise:unauthorized", listener);
  });
  it.each([
    ["JSON API", () => api("/me")],
    ["document download", () => downloadDocument("doc", "doc.txt")],
    ["answer stream", () => streamMessage("chat", "question", vi.fn())],
  ])(
    "does not log out a newer session after a late %s rejection",
    async (_name, request) => {
      saveSession({ identity: "tenant", token: "old-session" });
      let respond;
      vi.mocked(fetch).mockImplementation(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          })
      );
      const listener = vi.fn();
      window.addEventListener("enterprise:unauthorized", listener);
      const pending = request();
      clearSession();
      saveSession({ identity: "tenant", token: "new-session" });
      respond({
        ok: false,
        status: 401,
        json: async () => ({ error: "旧会话已失效" }),
      });
      await expect(pending).rejects.toThrow("旧会话已失效");
      expect(localStorage.getItem(TOKEN_KEY)).toBe("new-session");
      expect(savedSession()).toMatchObject({ token: "new-session" });
      expect(listener).not.toHaveBeenCalled();
      window.removeEventListener("enterprise:unauthorized", listener);
    }
  );
  it("does not invalidate a session created while an anonymous login request was pending", async () => {
    let respond;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        })
    );
    const pending = api("/login", {
      method: "POST",
      body: { username: "wrong" },
    });
    saveSession({ identity: "tenant", token: "signed-in-in-another-tab" });
    respond({
      ok: false,
      status: 401,
      json: async () => ({ error: "登录失败" }),
    });
    await expect(pending).rejects.toThrow("登录失败");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("signed-in-in-another-tab");
  });
  it("reports structured and non-JSON API failures without unauthorized events for anonymous requests", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ message: "权限不足" }),
    });
    await expect(api("/users")).rejects.toThrow("权限不足");
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("not-json");
      },
    });
    await expect(api("/status")).rejects.toThrow("请求失败（502）");
  });
});

describe("same-origin document and answer transport", () => {
  it("downloads a document with the provided filename and revokes its object URL", async () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:document");
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["content"]),
      headers: {
        get: () => "attachment; filename*=UTF-8''%E8%B5%84%E6%96%99.txt",
      },
    });
    await downloadDocument("doc-id", "fallback.txt");
    expect(fetch).toHaveBeenCalledWith(
      "/api/enterprise/documents/doc-id/download",
      expect.anything()
    );
    expect(click.mock.instances[0].download).toBe("资料.txt");
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:document");
    vi.useRealTimers();
  });
  it("supports plain and missing download names and propagates download failures", async () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:document");
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    for (const disposition of ['attachment; filename="named.txt"', ""]) {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        blob: async () => new Blob(),
        headers: { get: () => disposition },
      });
      await downloadDocument("id", "fallback.txt");
    }
    expect(click.mock.instances.map((instance) => instance.download)).toEqual([
      "named.txt",
      "fallback.txt",
    ]);
    vi.runAllTimers();
    vi.useRealTimers();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "资料不可访问" }),
    });
    await expect(downloadDocument("id", "file.txt")).rejects.toThrow(
      "资料不可访问"
    );
  });
  it("accepts JSON answers and streams complete events across chunk boundaries", async () => {
    const onEvent = vi.fn();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ message: { content: "answer" } }),
    });
    await streamMessage("chat-id", "question", onEvent);
    expect(onEvent).toHaveBeenCalledWith({
      type: "finalizeResponseStream",
      message: { content: "answer" },
    });
    const chunks = [
      'data: {"type":"textResponseChunk","textResponse":"hi"}\r\n\r\n',
      "data: [DONE]\n\n: heartbeat\n\n",
      'data: {"type":"finalizeResponseStream","message":{"content":"hi"}}\n\n',
    ];
    const reader = {
      read: vi.fn(async () =>
        chunks.length
          ? { done: false, value: new TextEncoder().encode(chunks.shift()) }
          : { done: true }
      ),
      releaseLock: vi.fn(),
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: { getReader: () => reader },
    });
    await streamMessage("chat-id", "question", onEvent);
    expect(onEvent).toHaveBeenCalledWith({
      type: "textResponseChunk",
      textResponse: "hi",
    });
  });
  it("reports failed, incomplete and upstream-error answers", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "输入无效" }),
    });
    await expect(streamMessage("id", "", vi.fn())).rejects.toThrow("输入无效");
    for (const events of [
      [],
      ['data: {"type":"abort","error":"模型服务失败"}\n\n'],
      ['data: {"type":"abort"}\n\n'],
    ]) {
      const reader = {
        read: vi.fn(async () =>
          events.length
            ? { done: false, value: new TextEncoder().encode(events.shift()) }
            : { done: true }
        ),
        releaseLock: vi.fn(),
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        headers: { get: () => "text/event-stream" },
        body: { getReader: () => reader },
      });
      await expect(streamMessage("id", "question", vi.fn())).rejects.toThrow(
        /回答连接中断|模型服务失败|回答生成失败/
      );
    }
  });
  it("decodes UTF-8 and CRLF split across every byte", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"textResponseChunk","textResponse":"你好"}\r\n\r\ndata: {"type":"finalizeResponseStream","message":{"content":"你好"}}\r\n\r\n'
    );
    let offset = 0;
    const reader = {
      read: vi.fn(async () =>
        offset < bytes.length
          ? { done: false, value: bytes.slice(offset, ++offset) }
          : { done: true }
      ),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: { getReader: () => reader },
    });
    const event = vi.fn();
    await streamMessage("chat /1", "question", event);
    expect(fetch).toHaveBeenCalledWith(
      "/api/enterprise/conversations/chat%20%2F1/messages",
      expect.anything()
    );
    expect(event.mock.calls).toEqual([
      [{ type: "textResponseChunk", textResponse: "你好" }],
      [{ type: "finalizeResponseStream", message: { content: "你好" } }],
    ]);
  });
  it("rejects late answers after cancellation", async () => {
    const abort = new AbortController();
    const event = vi.fn();
    const reader = {
      read: vi.fn(async () => {
        abort.abort();
        return {
          done: false,
          value: new TextEncoder().encode(
            'data: {"type":"textResponseChunk","textResponse":"late"}\n\n'
          ),
        };
      }),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: { getReader: () => reader },
    });
    await expect(
      streamMessage("id", "question", event, abort.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(event).not.toHaveBeenCalled();
  });
  it("rejects successful responses with no message or no stream body", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({}),
    });
    await expect(streamMessage("id", "question", vi.fn())).rejects.toThrow(
      "有效回答"
    );
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: null,
    });
    await expect(streamMessage("id", "question", vi.fn())).rejects.toThrow(
      "连接中断"
    );
  });
});
