import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import Chat from "../src/pages/Chat";
import Sidebar from "../src/components/Sidebar";
import { ThemeProvider } from "../src/ThemeContext";
import { AuthContext } from "../src/AuthContext";
import { LogoContext } from "../src/LogoContext";
import { api, streamMessage } from "../src/models/platform";
import System from "../src/models/system";

vi.mock("../src/models/platform", async (importOriginal) => ({
  ...(await importOriginal()),
  api: vi.fn(),
  streamMessage: vi.fn(),
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
            <ToastContainer autoClose={false} />
          </LogoContext.Provider>
        </AuthContext.Provider>
      </ThemeProvider>
    </MemoryRouter>
  );
}

let files, contextWindow, parseTokens, libraries, parseError, resolveParse;
const pending = {
  id: "parsed-a",
  filename: "quotation.txt",
  title: "Temporary quotation",
  tokenCountEstimate: 20,
};

beforeEach(() => {
  localStorage.clear();
  files = [];
  contextWindow = 8192;
  parseTokens = 20;
  parseError = null;
  resolveParse = null;
  libraries = [
    { id: "public", name: "Company library", visibility: "public" },
    { id: "private", name: "Personal library", visibility: "private" },
  ];
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
  vi.mocked(streamMessage).mockReset();
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path, options = {}) => {
      if (path === "/chat/capabilities") return { reasoningEffort: false };
      if (path === "/conversations" && options.method === "POST")
        return { conversation: { id: "new", title: "New chat" } };
      if (path === "/conversations")
        return { conversations: [{ id: "history", title: "Past chat" }] };
      if (path === "/libraries") return { libraries };
      if (path.endsWith("/parse")) {
        if (parseError) throw new Error(parseError);
        const parsed = { ...pending, tokenCountEstimate: parseTokens };
        files = [parsed];
        return { files: [parsed] };
      }
      if (path.endsWith("/parsed-files")) {
        if (options.method === "DELETE") {
          files = files.filter(
            (file) => !options.body.fileIds.includes(file.id)
          );
          return { success: true };
        }
        return {
          files,
          contextWindow,
          currentContextTokenCount: files.reduce(
            (sum, file) => sum + file.tokenCountEstimate,
            0
          ),
        };
      }
      if (path.endsWith("/save"))
        return {
          success: true,
          approvalRequired: options.body.libraryId === "public",
        };
      if (path === "/conversations/history/parsed-files/parsed-a")
        return {
          document: {
            title: "Temporary quotation",
            content: "Private temporary source body",
            visibility: "private",
            status: "ready",
          },
        };
      if (path === "/conversations/history")
        return {
          messages: [
            {
              id: "answer",
              role: "assistant",
              content: "Comparison answer",
              sources: [
                { parsedFileId: "parsed-a", title: "Temporary quotation" },
              ],
            },
          ],
        };
      throw new Error(`Unexpected API: ${options.method || "GET"} ${path}`);
    });
});

async function page() {
  const user = userEvent.setup();
  const view = render(<ChatPage />);
  await screen.findByText("Past chat");
  await waitFor(() =>
    expect(System.checkDocumentProcessorOnline).toHaveBeenCalled()
  );
  return { user, ...view };
}

async function upload(user) {
  const input = document.getElementById("dnd-chat-file-uploader");
  await user.upload(
    input,
    new File(["Quotation content"], "quotation.txt", { type: "text/plain" })
  );
}

async function largeUpload(user) {
  await user.click(screen.getByText("Past chat"));
  await screen.findByText("Comparison answer");
  contextWindow = 100;
  parseTokens = 150;
  await upload(user);
  await screen.findByText("Context Window Warning");
  await user.click(screen.getByRole("button", { name: "Embed File" }));
}

describe("personal chat attachments with original components", () => {
  it("uploads a temporary document to its own conversation and deletes it through the original attachment button", async () => {
    const { user } = await page();
    await upload(user);
    await screen.findByText("Added as context!");
    const parseCall = vi
      .mocked(api)
      .mock.calls.find(([path]) => path === "/conversations/new/parse");
    expect(parseCall[1].method).toBe("POST");
    expect(parseCall[1].body.get("file").name).toBe("quotation.txt");
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path === "/libraries")
    ).toBe(false);
    const attachment = screen
      .getByText("Added as context!")
      .closest("[data-tooltip-id]");
    await user.click(within(attachment).getByRole("button"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/conversations/new/parsed-files", {
        method: "DELETE",
        body: { fileIds: ["parsed-a"] },
      })
    );
    expect(screen.queryByText("Added as context!")).not.toBeInTheDocument();
    expect(files).toEqual([]);
  });

  it.each([
    ["Company library（公有，提交审批）", "public"],
    ["Personal library（私有）", "private"],
  ])(
    "explicitly selects %s when saving a temporary document",
    async (name, libraryId) => {
      const { user } = await page();
      await largeUpload(user);
      const picker = await screen.findByRole("dialog", {
        name: "保存到知识库",
      });
      await user.click(within(picker).getByRole("button", { name }));
      await waitFor(() =>
        expect(api).toHaveBeenCalledWith(
          "/conversations/history/parsed-files/parsed-a/save",
          { method: "POST", body: { libraryId } }
        )
      );
      expect(
        screen.queryByRole("dialog", { name: "保存到知识库" })
      ).not.toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.queryByText("Context Window Warning")
        ).not.toBeInTheDocument()
      );
      expect(files).toHaveLength(1);
    }
  );

  it("checks model context limits on the first upload in a new conversation and saves only to the chosen library", async () => {
    contextWindow = 100;
    parseTokens = 150;
    const { user } = await page();
    await upload(user);
    await screen.findByText("Context Window Warning");
    await user.click(screen.getByRole("button", { name: "Embed File" }));
    const picker = await screen.findByRole("dialog", { name: "保存到知识库" });
    await user.click(
      within(picker).getByRole("button", {
        name: "Company library（公有，提交审批）",
      })
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/conversations/new/parsed-files/parsed-a/save",
        { method: "POST", body: { libraryId: "public" } }
      )
    );
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(
          ([path, options]) =>
            path === "/conversations" && options?.method === "POST"
        )
    ).toHaveLength(1);
  });

  it("cancels library selection without publishing or removing the temporary document", async () => {
    const { user } = await page();
    await largeUpload(user);
    const picker = await screen.findByRole("dialog", { name: "保存到知识库" });
    await user.click(within(picker).getByRole("button", { name: "Close" }));
    expect(await screen.findByText("已取消保存")).toBeInTheDocument();
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/save"))
    ).toBe(false);
    expect(files).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Continue Anyway" }));
    expect(
      screen.queryByText("Context Window Warning")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Added as context!")).toBeInTheDocument();
  });

  it("reports that no library is available and preserves the temporary document", async () => {
    libraries = [];
    const { user } = await page();
    await largeUpload(user);
    expect(await screen.findByText("请先创建知识库")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "保存到知识库" })
    ).not.toBeInTheDocument();
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/save"))
    ).toBe(false);
    expect(files).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(files).toEqual([]));
  });

  it("keeps the active conversation while its document upload is being processed", async () => {
    const original = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation((path, options) =>
      path.endsWith("/parse")
        ? new Promise((resolve) => {
            resolveParse = async () => resolve(await original(path, options));
          })
        : original(path, options)
    );
    const { user } = await page();
    await upload(user);
    await screen.findByText("Uploading...");
    await waitFor(() => expect(resolveParse).toBeTypeOf("function"));
    await user.click(screen.getByText("Past chat"));
    await user.click(screen.getByRole("button", { name: "发起新对话" }));
    expect(
      vi
        .mocked(api)
        .mock.calls.some(([path]) => path === "/conversations/history")
    ).toBe(false);
    expect(screen.getByText("Uploading...")).toBeInTheDocument();
    await act(async () => resolveParse());
    await screen.findByText("Added as context!");
    await user.click(screen.getByText("Past chat"));
    await screen.findByText("Comparison answer");
    expect(screen.queryByText("Added as context!")).not.toBeInTheDocument();
  });

  it("shows parser errors in the original attachment queue without saving to knowledge", async () => {
    parseError = "The document could not be parsed";
    const { user } = await page();
    await upload(user);
    expect(await screen.findByText(parseError)).toBeInTheDocument();
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/save"))
    ).toBe(false);
    const failed = screen.getByText(parseError).closest("[data-tooltip-id]");
    await user.click(within(failed).getByRole("button"));
    expect(screen.queryByText(parseError)).not.toBeInTheDocument();
  });

  it("opens a temporary citation through the current conversation instead of the knowledge-document API", async () => {
    const { user } = await page();
    await user.click(screen.getByText("Past chat"));
    await user.click(await screen.findByRole("button", { name: "来源" }));
    await user.click(
      await screen.findByRole("button", { name: /^Temporary quotation/ })
    );
    expect(
      await screen.findByText("Private temporary source body")
    ).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(
      "/conversations/history/parsed-files/parsed-a",
      { signal: expect.any(AbortSignal) }
    );
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path.startsWith("/documents/"))
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.queryByText("Private temporary source body")
    ).not.toBeInTheDocument();
  });
});
