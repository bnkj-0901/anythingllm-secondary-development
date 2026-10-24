import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseHeaders, userFromStorage } from "../src/utils/request";
import { saveSession } from "../src/models/platform";
import System from "../src/models/system";
import Admin from "../src/models/admin";
import { AUTH_TOKEN, AUTH_USER } from "../src/utils/constants";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("upstream models share the enterprise identity contract", () => {
  it("uses the current owner avatar endpoint without sending a caller supplied user ID", async () => {
    saveSession({
      token: "owner-token",
      identity: "tenant",
      role: "user",
      tenant: { id: "a" },
      user: { id: "owner" },
    });
    const blob = new Blob(["avatar"], { type: "image/png" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.fn(() => "blob:owner-avatar");
    vi.stubGlobal("URL", { createObjectURL });
    expect(await System.fetchPfp("another-user")).toBe("blob:owner-avatar");
    const form = new FormData();
    form.append("file", blob, "avatar.png");
    expect((await System.uploadPfp(form)).success).toBe(true);
    expect((await System.removePfp()).success).toBe(true);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toMatch(/\/enterprise\/me\/avatar$/);
      expect(url).not.toContain("another-user");
      expect(options.headers.Authorization).toBe("Bearer owner-token");
    }
    expect(fetchMock.mock.calls[1][1].body).toBe(form);
    expect(fetchMock.mock.calls[1][1].headers["Content-Type"]).toBeUndefined();
  });
  it("uses the current host session token and preserves explicit token overrides", () => {
    saveSession({
      token: "enterprise-test-token",
      identity: "tenant",
      role: "admin",
      user: { id: 7, username: "alice" },
    });
    localStorage.setItem(AUTH_TOKEN, "old-global-token");
    localStorage.setItem(
      AUTH_USER,
      JSON.stringify({ username: "old-admin", role: "admin" })
    );
    expect(baseHeaders().Authorization).toBe("Bearer enterprise-test-token");
    expect(baseHeaders("explicit-test-token").Authorization).toBe(
      "Bearer explicit-test-token"
    );
    expect(userFromStorage()).toEqual({
      id: 7,
      username: "alice",
      identity: "tenant",
      role: "admin",
    });
  });
  it.each([
    null,
    "invalid-json",
    JSON.stringify({ hostname: "different.example", identity: "platform" }),
  ])(
    "ignores global identity and sessions from a different host (%#)",
    (stored) => {
      localStorage.setItem(AUTH_TOKEN, "old-global-token");
      localStorage.setItem("ep_token", "enterprise-test-token");
      if (stored !== null) localStorage.setItem("ep_session", stored);
      expect(baseHeaders().Authorization).toBeNull();
      expect(userFromStorage()).toBeNull();
    }
  );
  it("authenticates original configuration reads and saves without changing their DTO", async () => {
    saveSession({
      token: "enterprise-test-token",
      identity: "platform",
      role: "platform_admin",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: { LLMProvider: "deepseek" },
        settings: { text_splitter_chunk_size: 1000 },
        error: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await System.keys()).toEqual({ LLMProvider: "deepseek" });
    await System.updateSystem({ LLMProvider: "deepseek" });
    await Admin.systemPreferencesByFields(["text_splitter_chunk_size"]);
    await Admin.updateSystemPreferences({ text_splitter_chunk_size: 1000 });
    for (const [, options] of fetchMock.mock.calls) {
      expect(options.headers.Authorization).toBe(
        "Bearer enterprise-test-token"
      );
    }
    expect(fetchMock.mock.calls[1][1].body).toBe(
      JSON.stringify({ LLMProvider: "deepseek" })
    );
    expect(fetchMock.mock.calls[3][1].body).toBe(
      JSON.stringify({ text_splitter_chunk_size: 1000 })
    );
    await System.keys("embedding");
    expect(fetchMock.mock.calls[4][0]).toMatch(
      /setup-complete\?purpose=embedding$/
    );
  });
  it("keeps original embedding model discovery in its own credential scope", async () => {
    const priorPath = window.location.pathname;
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      window.history.replaceState({}, "", "/settings/embedding-preference");
      await System.customModels("litellm");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).purpose).toBe(
        "embedding"
      );
      window.history.replaceState({}, "", "/settings/llm-preference");
      await System.customModels("litellm");
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).purpose).toBe("chat");
    } finally {
      window.history.replaceState({}, "", priorPath);
    }
  });
});
