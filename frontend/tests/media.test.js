import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ttsMessage } from "../src/models/media";
import { saveSession } from "../src/models/platform";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:private-message-audio");
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("private message speech requests", () => {
  it("uses the authenticated message endpoint without a Workspace or shared cache", async () => {
    saveSession({ identity: "tenant", token: "current-user-token" });
    const audio = new Blob(["audio"], { type: "audio/mpeg" });
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      ok: true,
      blob: async () => audio,
    });

    await expect(ttsMessage("unused-workspace", "message/id?query")).resolves.toBe(
      "blob:private-message-audio"
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/enterprise/messages/message%2Fid%3Fquery/tts",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Bearer current-user-token",
        }),
      })
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(audio);
  });

  it("does not create an audio URL for a message with no spoken content", async () => {
    const blob = vi.fn();
    vi.mocked(fetch).mockResolvedValue({ status: 204, ok: true, blob });
    await expect(ttsMessage(null, "empty")).resolves.toBeNull();
    expect(blob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("reports the authorized endpoint's error without treating it as audio", async () => {
    const blob = vi.fn();
    vi.mocked(fetch).mockResolvedValue({
      status: 404,
      ok: false,
      json: async () => ({ error: "消息不存在或无权访问" }),
      blob,
    });
    await expect(ttsMessage(null, "another-users-message")).rejects.toThrow(
      "消息不存在或无权访问"
    );
    expect(blob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON without a message", async () => ({})],
    ["non-JSON proxy response", async () => { throw new Error("bad JSON"); }],
  ])("handles a %s safely", async (_name, json) => {
    vi.mocked(fetch).mockResolvedValue({ status: 502, ok: false, json });
    await expect(ttsMessage(null, "failed")).rejects.toThrow("语音播放暂时不可用");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
