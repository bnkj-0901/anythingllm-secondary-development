import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "../src/AuthContext";
import { LogoContext } from "../src/LogoContext";
import RetrievalPreference from "../src/pages/GeneralSettings/RetrievalPreference";
import { api } from "../src/models/platform";
import System from "../src/models/system";

vi.mock("../src/models/platform", async (importOriginal) => ({
  ...(await importOriginal()),
  api: vi.fn(),
}));

vi.mock("../src/pages/WorkspaceSettings/ChatSettings", () => ({
  default: ({ workspace, onUpdate }) => (
    <div>
      <p>聊天配置企业：{workspace.tenantId}</p>
      <button onClick={() => onUpdate({ openAiPrompt: "Updated prompt" })}>
        保存原版聊天配置
      </button>
    </div>
  ),
}));

vi.mock("../src/pages/WorkspaceSettings/AgentConfig", () => ({
  default: ({ workspace, onUpdate }) => (
    <div>
      <p>Agent 配置企业：{workspace.tenantId}</p>
      <button onClick={() => onUpdate({ agentModel: "selected-agent-model" })}>
        保存原版 Agent 配置
      </button>
    </div>
  ),
}));

const endpoint = "/platform/tenants/a/rag-settings";
const tenants = [
  { id: "a", name: "Enterprise A" },
  { id: "b", name: "Enterprise B" },
];

const current = {
  chatMode: "chat",
  chunkSize: 1000,
  chunkOverlap: 20,
  topK: 8,
  similarityThreshold: 0.1,
  rerank: false,
  embeddingCache: true,
};

async function configuredResponse(path, options = {}) {
  if (path === "/platform/tenants") return { tenants };
  if (path.endsWith("/suggested-messages")) return { messages: [] };
  return { settings: { ...current, ...options.body?.settings } };
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(configuredResponse);
  vi.spyOn(System, "keys").mockResolvedValue({ VectorDB: "lancedb" });
  vi.spyOn(System, "fetchSupportEmail").mockResolvedValue({ email: "" });
  vi.spyOn(System, "fetchAppVersion").mockResolvedValue("1.0.0");
  vi.spyOn(System, "fetchCustomFooterIcons").mockResolvedValue({
    footerData: [],
  });
});

async function snippets() {
  return waitFor(() => {
    const element = document.querySelector('input[name="topN"]');
    expect(element).not.toBeNull();
    return element;
  });
}
function page(initialEntry = "/settings/retrieval-preference?tenantId=a") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthContext.Provider
        value={{
          store: {
            user: { identity: "platform", role: "platform_admin" },
          },
        }}
      >
        <LogoContext.Provider value={{ logo: "logo.png" }}>
          <RetrievalPreference />
        </LogoContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe("top-owned enterprise retrieval settings reuse original controls", () => {
  it("retains original retrieval presets and autosaves only mapped fields", async () => {
    page();
    const count = await snippets();
    expect(
      document.querySelector('select[name="similarityThreshold"]')
    ).toHaveValue("0.1");
    for (const value of ["0", "0.25", "0.5", "0.75"])
      expect(
        document.querySelector(
          `select[name="similarityThreshold"] option[value="${value}"]`
        )
      ).not.toBeNull();
    fireEvent.change(count, { target: { value: "12" } });
    fireEvent.blur(count);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(endpoint, {
        method: "PATCH",
        body: {
          settings: {
            topK: 12,
            similarityThreshold: 0.1,
            embeddingCache: true,
            rerank: false,
          },
        },
      })
    );
    expect(
      screen.getByRole("link", { name: "文本分片设置", exact: true })
    ).toHaveAttribute("href", "/settings/text-splitter-preference");
    expect(document.querySelector('[name="chatMode"]')).toBeNull();
    expect(document.querySelector('[name="chunkSize"]')).toBeNull();
  });
  it("keeps edited fields after a rejected autosave and retries on blur", async () => {
    page();
    const count = await snippets();
    vi.mocked(api).mockRejectedValueOnce(new Error("保存失败"));
    fireEvent.change(count, { target: { value: "14" } });
    fireEvent.blur(count);
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(count).toHaveValue(14);
    expect(count).toBeEnabled();
    fireEvent.blur(count);
    await screen.findByText("知识检索设置已保存。");
  });
  it("keeps the form unavailable during loading and reports failure", async () => {
    vi.mocked(api).mockImplementation((path, options) =>
      path === endpoint
        ? Promise.reject(new Error("加载失败"))
        : configuredResponse(path, options)
    );
    page();
    expect(screen.getByText("正在加载检索设置…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("加载失败");
    expect(document.querySelector('input[name="topN"]')).toBeNull();
  });
  it("disables retrieval controls until an autosave completes", async () => {
    page();
    const count = await snippets();
    let finish;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    fireEvent.change(count, { target: { value: "9" } });
    fireEvent.blur(count);
    await waitFor(() => expect(count).toBeDisabled());
    await act(async () => finish({ settings: { ...current, topK: 9 } }));
    await waitFor(() => expect(count).toBeEnabled());
  });
  it("requires selecting an enterprise before requesting its resources", async () => {
    page("/settings/retrieval-preference");
    await screen.findByRole("option", { name: "Enterprise A" });
    expect(api).toHaveBeenCalledTimes(1);
    expect(document.querySelector('input[name="topN"]')).toBeNull();
    fireEvent.change(screen.getByLabelText("企业"), { target: { value: "b" } });
    await snippets();
    expect(api).toHaveBeenCalledWith(
      "/platform/tenants/b/rag-settings",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(screen.getByText("聊天配置企业：b")).toBeInTheDocument();
  });
  it.each([
    ["保存原版聊天配置", { openAiPrompt: "Updated prompt" }],
    ["保存原版 Agent 配置", { agentModel: "selected-agent-model" }],
  ])("keeps original %s form and scopes its writes", async (name, settings) => {
    page();
    fireEvent.click(await screen.findByRole("button", { name }));
    await screen.findByText("企业配置已保存。");
    expect(api).toHaveBeenCalledWith(endpoint, {
      method: "PATCH",
      body: { settings },
    });
  });
  it("replaces uncontrolled original fields when switching between loaded enterprises", async () => {
    vi.mocked(api).mockImplementation((path, options) =>
      path === "/platform/tenants/b/rag-settings"
        ? Promise.resolve({
            settings: { ...current, topK: 3, similarityThreshold: 0.5 },
          })
        : configuredResponse(path, options)
    );
    page();
    expect(await snippets()).toHaveValue(8);
    fireEvent.change(screen.getByLabelText("企业"), { target: { value: "b" } });
    await waitFor(() =>
      expect(document.querySelector('input[name="topN"]')).toHaveValue(3)
    );
    expect(
      document.querySelector('select[name="similarityThreshold"]')
    ).toHaveValue("0.5");
    fireEvent.change(screen.getByLabelText("企业"), { target: { value: "a" } });
    await waitFor(() =>
      expect(document.querySelector('input[name="topN"]')).toHaveValue(8)
    );
    expect(
      document.querySelector('select[name="similarityThreshold"]')
    ).toHaveValue("0.1");
  });
  it("ignores delayed settings from a previous selected enterprise", async () => {
    let finishA;
    vi.mocked(api).mockImplementation((path, options) =>
      path === endpoint
        ? new Promise((resolve) => {
            finishA = resolve;
          })
        : configuredResponse(path, options)
    );
    page();
    await screen.findByRole("option", { name: "Enterprise B" });
    const signal = vi
      .mocked(api)
      .mock.calls.find(([path]) => path === endpoint)[1].signal;
    fireEvent.change(screen.getByLabelText("企业"), { target: { value: "b" } });
    const count = await snippets();
    expect(count).toHaveValue(8);
    expect(signal.aborted).toBe(true);
    await act(async () => finishA({ settings: { ...current, topK: 19 } }));
    expect(count).toHaveValue(8);
    fireEvent.change(count, { target: { value: "10" } });
    fireEvent.blur(count);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/platform/tenants/b/rag-settings",
        expect.objectContaining({ method: "PATCH" })
      )
    );
  });
  it("reuses the original suggested message editor in the selected enterprise", async () => {
    page();
    await snippets();
    expect(api).toHaveBeenCalledWith("/platform/tenants/a/suggested-messages");
    fireEvent.click(screen.getByRole("button", { name: /添加新消息/ }));
    fireEvent.click(screen.getByRole("button", { name: /保存消息/ }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/platform/tenants/a/suggested-messages",
        expect.objectContaining({
          method: "POST",
          body: { messages: expect.any(Array) },
        })
      )
    );
  });
});
