import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Chat from "../src/pages/Chat";
import { useState } from "react";
import Sidebar from "../src/components/Sidebar";
import { ThemeProvider } from "../src/ThemeContext";
import { api, streamMessage, exportConversation } from "../src/models/platform";
import { saveAs } from "file-saver";
import { MemoryRouter } from "react-router-dom";
import PromptInput from "../src/components/WorkspaceChat/ChatContainer/PromptInput";
import { AuthContext } from "../src/AuthContext";
import { LogoContext } from "../src/LogoContext";
import System from "../src/models/system";
import { ttsMessage } from "../src/models/media";
import Appearance from "../src/models/appearance";
import i18n from "../src/i18n";

vi.mock("../src/models/media", () => ({ ttsMessage: vi.fn() }));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

vi.mock("../src/models/platform", async (importOriginal) => ({
  ...(await importOriginal()),
  api: vi.fn(),
  streamMessage: vi.fn(),
  exportConversation: vi.fn(),
}));
const session = {
  identity: "tenant",
  tenant: { id: "tenant-a" },
  user: { id: "u", name: "User" },
};
function ChatPage() {
  const [navigation, setNavigation] = useState(null);
  return (
    <MemoryRouter>
      <ThemeProvider>
        <AuthContext.Provider
          value={{
            store: {
              user: { ...session.user, identity: "tenant", role: "user" },
            },
          }}
        >
          <LogoContext.Provider value={{ logo: "test-logo.png" }}>
            <Sidebar
              session={session}
              pages={{ chat: { label: "问答", icon: "chat" } }}
              allowed={["chat"]}
              active="chat"
              navigate={vi.fn()}
              onLogout={vi.fn()}
              chat={navigation}
            />
            <Chat session={session} onNavigation={setNavigation} />
          </LogoContext.Provider>
        </AuthContext.Provider>
      </ThemeProvider>
    </MemoryRouter>
  );
}
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(System, "keys").mockResolvedValue({
    TextToSpeechProvider: "native",
    SpeechToTextProvider: "native",
  });
  vi.spyOn(System, "fetchCustomFooterIcons").mockResolvedValue({
    footerData: [],
  });
  vi.spyOn(System, "checkDocumentProcessorOnline").mockResolvedValue({
    online: true,
  });
  vi.spyOn(System, "getSlashCommandPresets").mockResolvedValue([]);
  vi.mocked(ttsMessage).mockReset();
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path, options = {}) => {
      if (path.endsWith("/parsed-files"))
        return { files: [], contextWindow: 8192, currentContextTokenCount: 0 };
      if (path === "/chat/capabilities") return { reasoningEffort: false };
      if (path === "/conversations" && options.method === "POST")
        return { conversation: { id: "new", title: "New chat" } };
      if (path === "/conversations")
        return { conversations: [{ id: "history", title: "Past chat" }] };
      return {
        messages: [{ id: "past", role: "assistant", content: "Past answer" }],
      };
    });
  vi.mocked(streamMessage).mockReset();
  vi.mocked(exportConversation).mockReset();
});
afterEach(() => vi.unstubAllGlobals());
async function page() {
  const user = userEvent.setup();
  const view = render(<ChatPage />);
  await screen.findByText("Past chat");
  return { user, ...view };
}

function useApi(handler) {
  const original = vi.mocked(api).getMockImplementation();
  vi.mocked(api).mockImplementation(
    (path, options = {}) => handler(path, options) ?? original(path, options)
  );
}

function installAgentSocket() {
  const sockets = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      send = vi.fn();
      constructor(url) {
        this.url = url;
        sockets.push(this);
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
      receive(data) {
        this.onmessage?.({ data: JSON.stringify(data) });
      }
    }
  );
  vi.mocked(streamMessage).mockImplementation(async (_id, _text, event) =>
    event({ type: "agentInitWebsocketConnection", websocketUUID: "agent-run" })
  );
  return sockets;
}

describe("personal conversation original actions", () => {
  it("uses the original chat settings menu to export a personal conversation and copy its private link", async () => {
    const blob = new Blob(["# Exported personal conversation"], {
      type: "text/markdown",
    });
    vi.mocked(exportConversation).mockResolvedValue(blob);
    const { user } = await page();
    await user.click(screen.getByText("Past chat"));
    await screen.findByText("Past answer");
    await user.click(screen.getByRole("button", { name: "Chat settings" }));
    await user.hover(
      screen.getByText(i18n.t("chat_window.export"), { exact: true })
    );
    fireEvent.click(await screen.findByText("Markdown", { exact: true }));
    expect(exportConversation).toHaveBeenCalledWith("history", "markdown");
    await waitFor(() =>
      expect(saveAs).toHaveBeenCalledWith(
        blob,
        expect.stringMatching(/AnythingLLM Export.*\.md$/)
      )
    );
    await user.click(screen.getByRole("button", { name: "Chat settings" }));
    await user.click(screen.getByText("Copy chat link"));
    expect(await navigator.clipboard.readText()).toBe(
      `${window.location.origin}/chat?conversationId=history`
    );
    expect(screen.getByText("Chat link copied!")).toBeInTheDocument();
  });

  it("renames a conversation using the original sidebar thread menu", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(" Revised name ");
    const { user } = await page();
    await user.click(screen.getByRole("button", { name: "Thread options" }));
    await user.click(
      screen.getByRole("button", { name: "Rename", exact: true })
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/conversations/history", {
        method: "PATCH",
        body: { title: "Revised name" },
      })
    );
  });

  it.each([true, false])(
    "edits a personal question with the original save-only=%s behavior",
    async (saveOnly) => {
      let changed = false;
      useApi((path, options) => {
        if (path === "/conversations/history")
          return Promise.resolve({
            messages: changed
              ? []
              : [
                  {
                    id: "pair:user",
                    chatId: "pair",
                    role: "user",
                    content: "Old question",
                  },
                  { id: "pair", role: "assistant", content: "Old answer" },
                ],
          });
        if (path === "/messages/pair" && options.method === "PATCH") {
          changed = true;
          return Promise.resolve({});
        }
        if (path === "/messages/pair/truncate") {
          changed = true;
          return Promise.resolve({});
        }
      });
      vi.mocked(streamMessage).mockImplementation(async (_id, _text, event) =>
        event({
          type: "finalizeResponseStream",
          message: { id: "revised", content: "Revised answer" },
        })
      );
      const { user } = await page();
      await user.click(screen.getByText("Past chat"));
      await user.click(
        await screen.findByRole("button", {
          name: `Edit ${i18n.t("chat_window.edit_prompt")}`,
        })
      );
      const editor = screen.getByDisplayValue("Old question");
      await user.clear(editor);
      await user.type(editor, "New question");
      await user.click(
        screen.getByRole("button", {
          name: i18n.t(saveOnly ? "chat_window.save" : "chat_window.submit"),
          exact: true,
        })
      );
      if (saveOnly) {
        await waitFor(() =>
          expect(api).toHaveBeenCalledWith("/messages/pair", {
            method: "PATCH",
            body: { role: "user", content: "New question" },
          })
        );
        expect(streamMessage).not.toHaveBeenCalled();
      } else {
        await screen.findByText("Revised answer");
        expect(api).toHaveBeenCalledWith("/messages/pair/truncate", {
          method: "POST",
          body: {},
        });
        expect(streamMessage).toHaveBeenCalledWith(
          "history",
          "New question",
          expect.any(Function),
          expect.any(AbortSignal),
          expect.objectContaining({ attachments: [] })
        );
      }
    }
  );

  it("saves original message feedback and can clear the vote", async () => {
    const { user } = await page();
    await user.click(screen.getByText("Past chat"));
    const button = await screen.findByRole("button", {
      name: i18n.t("chat_window.good_response"),
    });
    await user.click(button);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/messages/past/feedback", {
        method: "POST",
        body: { feedbackScore: true },
      })
    );
    await user.click(button);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/messages/past/feedback", {
        method: "POST",
        body: { feedbackScore: null },
      })
    );
  });

  it("edits a saved assistant answer using the original inline editor", async () => {
    useApi((path, options) =>
      options.method === "PATCH" && path === "/messages/past"
        ? Promise.resolve({})
        : undefined
    );
    const { user } = await page();
    await user.click(screen.getByText("Past chat"));
    await user.click(
      await screen.findByRole("button", {
        name: `Edit ${i18n.t("chat_window.edit_response")}`,
      })
    );
    const editor = screen.getByDisplayValue("Past answer");
    await user.clear(editor);
    await user.type(editor, "Corrected answer");
    await user.click(
      screen.getByRole("button", {
        name: i18n.t("chat_window.save"),
        exact: true,
      })
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/messages/past", {
        method: "PATCH",
        body: { role: "assistant", content: "Corrected answer" },
      })
    );
    expect(streamMessage).not.toHaveBeenCalled();
  });

  it("regenerates with the original prompt and retained attachments", async () => {
    const attachments = [
      {
        name: "sketch.png",
        mime: "image/png",
        contentString: "data:image/png;base64,YQ==",
      },
    ];
    useApi((path) =>
      path === "/messages/past/truncate"
        ? Promise.resolve({ prompt: "Repeat my question", attachments })
        : undefined
    );
    vi.mocked(streamMessage).mockImplementation(async (_id, _text, event) =>
      event({
        type: "finalizeResponseStream",
        message: { id: "again", content: "New answer" },
      })
    );
    const { user } = await page();
    await user.click(screen.getByText("Past chat"));
    await user.click(
      await screen.findByRole("button", {
        name: i18n.t("chat_window.regenerate"),
      })
    );
    await screen.findByText("New answer");
    expect(api).toHaveBeenCalledWith("/messages/past/truncate", {
      method: "POST",
      body: { regenerate: true },
    });
    expect(streamMessage).toHaveBeenCalledWith(
      "history",
      "Repeat my question",
      expect.any(Function),
      expect.any(AbortSignal),
      expect.objectContaining({ attachments })
    );
  });

  it("forks a personal conversation through the original message action menu", async () => {
    useApi((path) =>
      path === "/messages/past/fork"
        ? Promise.resolve({
            conversation: { id: "forked", title: "Forked chat" },
          })
        : path === "/conversations/forked"
          ? Promise.resolve({
              messages: [
                { id: "copy", role: "assistant", content: "Fork snapshot" },
              ],
            })
          : undefined
    );
    const { user } = await page();
    await user.click(screen.getByText("Past chat"));
    await user.click(
      await screen.findByRole("button", {
        name: i18n.t("chat_window.more_actions"),
      })
    );
    await user.click(
      screen.getByRole("button", {
        name: i18n.t("chat_window.fork"),
        exact: true,
      })
    );
    await screen.findByText("Fork snapshot");
    expect(api).toHaveBeenCalledWith("/messages/past/fork", {
      method: "POST",
      body: {},
    });
  });

  it("hides an individual answer through the original action and preserves its conversation", async () => {
    const { user } = await page();
    await user.click(screen.getByText("Past chat"));
    await user.click(
      await screen.findByRole("button", {
        name: i18n.t("chat_window.more_actions"),
      })
    );
    await user.click(
      screen.getByRole("button", {
        name: i18n.t("chat_window.delete"),
        exact: true,
      })
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/messages/past", { method: "DELETE" })
    );
    expect(api).not.toHaveBeenCalledWith(
      "/conversations/history",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("renders original model route notices and completes an ephemeral image command", async () => {
    vi.mocked(streamMessage).mockImplementation(async (_id, _text, event) => {
      event({
        type: "modelRouteNotification",
        uuid: "route",
        routedTo: { provider: "openai", model: "test-model" },
      });
      event({ type: "imageGenerationPending" });
      event({
        type: "finalizeResponseStream",
        message: { content: "Image generation cancelled" },
      });
    });
    const { user } = await page();
    await user.type(screen.getByRole("textbox"), "/img Draw a plan");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("Image generation cancelled");
    expect(
      screen.queryByRole("button", {
        name: i18n.t("chat_window.good_response"),
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop generating" })
    ).not.toBeInTheDocument();
  });
});

describe("original Agent websocket in personal chat", () => {
  it("authenticates, renders original approval cards, then continues on the same personal session", async () => {
    localStorage.setItem("ep_token", "host-bound-token");
    const sockets = installAgentSocket();
    const { user } = await page();
    await user.type(screen.getByRole("textbox"), "@agent Inspect inventory");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await act(async () => socket.onopen());
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "authenticate", token: "host-bound-token" })
    );
    await act(async () =>
      socket.receive({
        type: "toolApprovalRequest",
        requestId: "approve-1",
        skillName: "inventory",
        description: "Read stock",
        payload: { warehouse: "main" },
      })
    );
    await user.click(
      await screen.findByRole("button", {
        name: i18n.t("chat_window.agent_invocation.approve"),
        exact: true,
      })
    );
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "toolApprovalResponse",
        requestId: "approve-1",
        approved: true,
      })
    );
    await act(async () => {
      socket.receive({
        type: "reportStreamEvent",
        content: {
          type: "fullTextResponse",
          uuid: "answer-1",
          content: "Stock is available",
        },
      });
      socket.receive({ type: "WAITING_ON_INPUT" });
    });
    await screen.findByText("Stock is available");
    await user.type(screen.getByRole("textbox"), "Check the next item");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    const continuation = socket.send.mock.calls
      .map(([frame]) => JSON.parse(frame))
      .find((frame) => frame.type === "awaitingFeedback");
    expect(continuation).toMatchObject({
      feedback: "Check the next item",
      attachments: [],
    });
    expect(streamMessage).toHaveBeenCalledTimes(1);
    await act(async () => socket.receive({ type: "WAITING_ON_INPUT" }));
    expect(
      screen.getByRole("button", { name: "发送消息" })
    ).toBeInTheDocument();
    await act(async () => socket.close());
    await screen.findByText("Past answer");
  });

  it("closes invalid Agent events, exposes connection errors, and aborts on page departure", async () => {
    const sockets = installAgentSocket();
    const { user, unmount } = await page();
    await user.type(screen.getByRole("textbox"), "@agent Search");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await act(async () => socket.onerror());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent 连接失败"
    );
    unmount();
    expect(socket.readyState).toBe(3);
  });

  it("rejects malformed Agent JSON and reloads only the current personal conversation", async () => {
    const sockets = installAgentSocket();
    const { user } = await page();
    await user.type(screen.getByRole("textbox"), "@agent Search");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => sockets[0].onmessage({ data: "{broken" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Agent 返回了无效消息"
    );
    expect(sockets[0].readyState).toBe(3);
    await screen.findByText("Past answer");
    expect(api).toHaveBeenCalledWith("/conversations/new");
  });
});

describe("chat request lifecycle", () => {
  it("uses the original native TTS button for persisted answers without enabling Workspace actions", async () => {
    const speak = vi.fn();
    vi.stubGlobal("speechSynthesis", {
      speaking: false,
      speak,
      cancel: vi.fn(),
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        constructor(text) {
          this.text = text;
        }
        addEventListener() {}
      }
    );
    const { user } = await page();
    await user.click(screen.getByText("Past chat"));
    await user.click(
      await screen.findByRole("button", { name: "Speak message" })
    );
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Past answer" })
    );
    expect(ttsMessage).not.toHaveBeenCalled();
  });

  it("passes the persisted personal message ID to the original asynchronous TTS player", async () => {
    vi.mocked(System.keys).mockResolvedValue({
      TextToSpeechProvider: "openai",
      SpeechToTextProvider: "native",
    });
    vi.mocked(ttsMessage).mockResolvedValue("blob:personal-answer");
    const previous = URL.revokeObjectURL;
    URL.revokeObjectURL = vi.fn();
    const { user, unmount } = await page();
    try {
      await user.click(screen.getByText("Past chat"));
      await user.click(
        await screen.findByRole("button", { name: "Speak message" })
      );
      await waitFor(() =>
        expect(ttsMessage).toHaveBeenCalledWith(undefined, "past")
      );
      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:personal-answer");
    } finally {
      unmount();
      URL.revokeObjectURL = previous;
    }
  });

  it.each([false, true])(
    "restores original recorded STT append and auto-submit preference (%s)",
    async (autoSubmit) => {
      vi.mocked(System.keys).mockResolvedValue({
        TextToSpeechProvider: "native",
        SpeechToTextProvider: "openai",
      });
      vi.spyOn(System, "transcribeAudio").mockResolvedValue({
        text: "dictated text",
        error: null,
      });
      Appearance.set("autoSubmitSttInput", autoSubmit);
      const stopTrack = vi.fn();
      const previousDevices = navigator.mediaDevices;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: vi.fn(async () => ({
            getTracks: () => [{ stop: stopTrack }],
          })),
        },
      });
      vi.stubGlobal(
        "MediaRecorder",
        class {
          static isTypeSupported() {
            return true;
          }
          mimeType = "audio/webm";
          state = "inactive";
          start() {
            this.state = "recording";
          }
          stop() {
            this.state = "inactive";
            this.ondataavailable({
              data: new Blob(["recorded audio"], { type: this.mimeType }),
            });
            this.onstop();
          }
        }
      );
      vi.mocked(streamMessage).mockImplementation(
        async (_id, _text, onEvent) => {
          onEvent({
            type: "finalizeResponseStream",
            message: { id: "spoken-answer", content: "Recorded answer" },
          });
        }
      );
      const { user, unmount } = await page();
      try {
        await user.type(screen.getByRole("textbox"), "Existing ");
        const microphone = await screen.findByLabelText("语音输入你的提示。");
        await user.click(microphone);
        await waitFor(() =>
          expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled()
        );
        await user.click(microphone);
        await waitFor(() => expect(System.transcribeAudio).toHaveBeenCalled());
        expect(stopTrack).toHaveBeenCalled();
        if (autoSubmit) {
          await waitFor(() =>
            expect(streamMessage).toHaveBeenCalledWith(
              "new",
              "Existing dictated text",
              expect.any(Function),
              expect.any(AbortSignal),
              expect.objectContaining({
                attachments: [],
                agentTransport: "websocket",
              })
            )
          );
          await screen.findByText("Recorded answer");
        } else {
          await waitFor(() =>
            expect(screen.getByRole("textbox")).toHaveValue(
              "Existing dictated text"
            )
          );
          expect(streamMessage).not.toHaveBeenCalled();
        }
      } finally {
        unmount();
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: previousDevices,
        });
      }
    }
  );

  it("keeps the original send label by default and accepts a product label consistently", () => {
    const view = (sendLabel) => (
      <MemoryRouter>
        <ThemeProvider>
          <PromptInput
            submit={vi.fn()}
            sendCommand={vi.fn()}
            sendLabel={sendLabel}
            capabilities={{
              tools: false,
              attachments: false,
              reasoning: false,
              speech: false,
            }}
          />
        </ThemeProvider>
      </MemoryRouter>
    );
    const { rerender } = render(view());
    const original = screen.getByRole("button", {
      name: "将提示消息发送到工作区",
    });
    expect(original).toHaveAttribute(
      "data-tooltip-content",
      "将提示消息发送到工作区"
    );
    expect(within(original).getByText("将提示消息发送到工作区")).toHaveClass(
      "sr-only"
    );
    rerender(view("发送消息"));
    const product = screen.getByRole("button", { name: "发送消息" });
    expect(product).toHaveAttribute("data-tooltip-content", "发送消息");
    expect(within(product).getByText("发送消息")).toHaveClass("sr-only");
    expect(
      screen.queryByRole("button", { name: "将提示消息发送到工作区" })
    ).not.toBeInTheDocument();
  });
  it("aborts conversation creation and never sends a late question after stopping", async () => {
    const { user } = await page();
    let resolve;
    const original = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation((path, options) =>
      options?.method === "POST"
        ? new Promise((done) => {
            resolve = done;
          })
        : original(path, options)
    );
    await user.type(screen.getByRole("textbox"), "My question");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    const signal = vi.mocked(api).mock.lastCall[1].signal;
    await user.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(signal.aborted).toBe(true);
    await act(async () =>
      resolve({ conversation: { id: "late", title: "Late chat" } })
    );
    expect(streamMessage).not.toHaveBeenCalled();
    expect(screen.queryByText("Late chat")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("已停止接收");
  });
  it("discards an unfinished answer preview when the stream fails and restores the question for retry", async () => {
    vi.mocked(streamMessage).mockImplementation(
      async (_id, _question, onEvent) => {
        onEvent({
          type: "textResponseChunk",
          textResponse: "Unverified partial answer",
        });
        throw new Error("引用资料在生成过程中已更新");
      }
    );
    const { user } = await page();
    await user.type(screen.getByRole("textbox"), "Question to retry");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "引用资料在生成过程中已更新"
    );
    expect(
      screen.queryByText("Unverified partial answer")
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("暂时未能生成回答，请查看上方提示后重试。")
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Question to retry");
    expect(screen.queryByText("基于知识库回答")).not.toBeInTheDocument();
  });
  it("keeps a completed answer and source metadata after incremental deltas", async () => {
    vi.mocked(streamMessage).mockImplementation(
      async (_id, _question, onEvent) => {
        onEvent({ type: "textResponseChunk", textResponse: "Partial" });
        onEvent({
          type: "finalizeResponseStream",
          message: {
            id: "saved",
            content: "Final answer",
            sources: [
              { documentId: "source", title: "Source", visibility: "public" },
            ],
          },
        });
      }
    );
    const { user } = await page();
    await user.type(screen.getByRole("textbox"), "Question");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(await screen.findByText("Final answer")).toBeInTheDocument();
    expect(screen.queryByText("Partial")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "来源" })).toBeInTheDocument();
  });
  it("marks deltas as pending until the canonical answer and renumbered sources are complete", async () => {
    let emit, resolve;
    vi.mocked(streamMessage).mockImplementation((_id, _question, onEvent) => {
      emit = onEvent;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const { user } = await page();
    await user.type(screen.getByRole("textbox"), "Question");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await act(async () =>
      emit({ type: "textResponseChunk", textResponse: "Partial answer [1]" })
    );
    expect(
      screen.getByRole("button", { name: "Stop generating" })
    ).toBeInTheDocument();
    expect(screen.queryByText("基于知识库回答")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Source/ })
    ).not.toBeInTheDocument();
    await act(async () => {
      emit({
        type: "finalizeResponseStream",
        message: {
          id: "saved",
          content: "Final answer [1]",
          sources: [
            { documentId: "third-source", title: "Source", citationNumber: 1 },
          ],
        },
      });
      resolve();
    });
    expect(await screen.findByText("Final answer [1]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "来源" })).toBeInTheDocument();
    expect(screen.queryByText("正在生成")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "来源" })).toBeInTheDocument();
  });
  it("removes an incomplete answer and its pending state when the user cancels midstream", async () => {
    vi.mocked(streamMessage).mockImplementation(
      (_id, _question, onEvent, signal) => {
        onEvent({
          type: "textResponseChunk",
          textResponse: "Unfinished answer [1]",
        });
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          })
        );
      }
    );
    const { user } = await page();
    await user.type(screen.getByRole("textbox"), "Question");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    expect(
      await screen.findByText("Unfinished answer [1]")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(await screen.findByText("本次生成已停止。")).toBeInTheDocument();
    expect(screen.queryByText("Unfinished answer [1]")).not.toBeInTheDocument();
    expect(screen.queryByText("正在生成")).not.toBeInTheDocument();
    expect(screen.queryByText("基于知识库回答")).not.toBeInTheDocument();
  });
  it("invalidates an in-flight history load when starting a new chat", async () => {
    const { user } = await page();
    let resolve;
    const original = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation((path, options) =>
      path === "/conversations/history"
        ? new Promise((done) => {
            resolve = done;
          })
        : original(path, options)
    );
    await user.click(screen.getByRole("link", { name: /^Past chat/ }));
    const signal = vi.mocked(api).mock.lastCall[1].signal;
    await user.click(screen.getByRole("button", { name: "发起新对话" }));
    expect(signal.aborted).toBe(true);
    await act(async () =>
      resolve({
        messages: [{ id: "late", role: "assistant", content: "Late history" }],
      })
    );
    expect(screen.queryByText("Late history")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
  it("aborts the active stream when leaving the page and ignores subsequent events", async () => {
    let resolve, signal, emit;
    vi.mocked(streamMessage).mockImplementation(
      (_id, _question, onEvent, currentSignal) => {
        signal = currentSignal;
        emit = onEvent;
        return new Promise((done) => {
          resolve = done;
        });
      }
    );
    const { user, unmount } = await page();
    await user.type(screen.getByRole("textbox"), "Question");
    await user.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(streamMessage).toHaveBeenCalledOnce());
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      emit({ type: "textResponseChunk", textResponse: "Late answer" });
      resolve();
    });
    expect(screen.queryByText("Late answer")).not.toBeInTheDocument();
  });
  it("loads a saved conversation and rechecks current document permissions for each source view", async () => {
    const original = vi.mocked(api).getMockImplementation();
    let allowed = true;
    vi.mocked(api).mockImplementation((path, options) => {
      if (path === "/conversations/history")
        return Promise.resolve({
          messages: [
            {
              id: "past",
              role: "assistant",
              content: "Past answer",
              sources: [
                {
                  documentId: "doc /1",
                  title: "Source",
                  visibility: "private",
                },
              ],
            },
          ],
        });
      if (path === "/documents/doc%20%2F1")
        return allowed
          ? Promise.resolve({
              document: {
                title: "Current source",
                content: "Current authorized content",
                status: "ready",
                visibility: "private",
              },
            })
          : Promise.reject(new Error("资料已删除或不再有权访问"));
      return original(path, options);
    });
    const { user } = await page();
    await user.click(screen.getByRole("link", { name: /^Past chat/ }));
    expect(await screen.findByText("Past answer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "来源" }));
    await user.click(await screen.findByRole("button", { name: /^Source/ }));
    expect(
      await screen.findByText("Current authorized content")
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    allowed = false;
    await user.click(await screen.findByRole("button", { name: /^Source/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("不再有权访问");
    expect(
      screen.queryByText("Current authorized content")
    ).not.toBeInTheDocument();
  });
  it("aborts a source lookup when leaving the page and ignores its late result", async () => {
    const original = vi.mocked(api).getMockImplementation();
    let resolve, signal;
    vi.mocked(api).mockImplementation((path, options) => {
      if (path === "/conversations/history")
        return Promise.resolve({
          messages: [
            {
              id: "past",
              role: "assistant",
              content: "Past answer",
              sources: [{ documentId: "source", title: "Source" }],
            },
          ],
        });
      if (path === "/documents/source") {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      }
      return original(path, options);
    });
    const { user, unmount } = await page();
    await user.click(screen.getByRole("link", { name: /^Past chat/ }));
    await user.click(await screen.findByRole("button", { name: "来源" }));
    await user.click(await screen.findByRole("button", { name: /^Source/ }));
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ document: { title: "Late source" } }));
    expect(screen.queryByText("Late source")).not.toBeInTheDocument();
  });
  it("removes a selected conversation only after confirmation and returns to a new chat", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = await page();
    await user.click(screen.getByRole("link", { name: /^Past chat/ }));
    await screen.findByText("Past answer");
    await user.click(screen.getByRole("button", { name: "Thread options" }));
    await user.click(screen.getByRole("button", { name: "Delete Thread" }));
    expect(api).not.toHaveBeenCalledWith(
      "/conversations/history",
      expect.objectContaining({ method: "DELETE" })
    );
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Thread options" }));
    await user.click(screen.getByRole("button", { name: "Delete Thread" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/conversations/history", {
        method: "DELETE",
      })
    );
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.queryByText("Past answer")).not.toBeInTheDocument();
  });
});

describe("tenant-owned original suggested messages", () => {
  it("loads configured suggestions and sends the selected question using the original auto-submit behavior", async () => {
    useApi((path) =>
      path === "/suggested-messages"
        ? Promise.resolve({
            messages: [
              { heading: "Getting started", message: "Explain the setup" },
            ],
          })
        : null
    );
    vi.mocked(streamMessage).mockImplementation(async (_id, _text, onEvent) => {
      onEvent({
        type: "finalizeResponseStream",
        message: { id: 9, role: "assistant", content: "Configured response" },
      });
    });
    const { user } = await page();
    await user.click(
      await screen.findByRole("button", {
        name: "Getting started Explain the setup",
      })
    );
    expect(await screen.findByText("Configured response")).toBeInTheDocument();
    expect(streamMessage).toHaveBeenCalledWith(
      "new",
      "Getting started Explain the setup",
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Object)
    );
    expect(api).toHaveBeenCalledWith(
      "/suggested-messages",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});
