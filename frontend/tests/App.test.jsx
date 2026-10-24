import { useEffect } from "react";
import {
  act,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  createBrowserRouter,
  Link,
  Route,
  RouterProvider,
  Routes,
  useOutletContext,
} from "react-router-dom";
import {
  api,
  clearSession,
  savedSession,
  saveSession,
  sessionMatchesSite,
  TOKEN_KEY,
} from "../src/models/platform";

const renderFailure = vi.hoisted(() => ({ page: null }));
const stopped = vi.hoisted(() => vi.fn());
const originalURL = window.location.href;

let activeRouter;
const routers = [];
function render(element) {
  activeRouter = createBrowserRouter([
    { path: "/", element, children: [{ path: "*", element: null }] },
  ]);
  routers.push(activeRouter);
  return renderView(<RouterProvider router={activeRouter} />);
}

vi.mock("../src/models/system", () => ({
  default: {
    fetchLogo: vi.fn(async () => ({ logoURL: null })),
    fetchPfp: vi.fn(async () => null),
  },
}));

vi.mock("../src/models/platform", () => ({
  api: vi.fn(),
  clearSession: vi.fn(),
  savedSession: vi.fn(),
  saveSession: vi.fn(),
  sessionMatchesSite: vi.fn(),
  TOKEN_KEY: "ep_token",
}));
vi.mock("../src/pages/Login", () => ({
  default: ({ site, initialError, onSession, onRetry }) => (
    <div>
      登录入口：{site?.kind}
      <span>{initialError}</span>
      <button
        onClick={() =>
          onSession({
            identity: "tenant",
            role: "user",
            tenant: { id: "a" },
            user: { username: "user" },
          })
        }
      >
        模拟登录
      </button>
      <button onClick={onRetry}>重试连接</button>
    </div>
  ),
}));
vi.mock("../src/components/Sidebar", () => ({
  default: ({
    hostname,
    allowed,
    navigate,
    onLogout,
    onAccount,
    close,
    open,
  }) => (
    <aside>
      {hostname}
      <span>{allowed.join(",")}</span>
      <span>{open ? "菜单已展开" : "菜单已关闭"}</span>
      <button onClick={() => navigate("knowledge")}>打开知识管理</button>
      <button onClick={() => navigate("chat")}>打开问答</button>
      <button onClick={() => navigate("/settings/llm-preference")}>
        打开原版模型设置
      </button>
      <button onClick={onLogout}>退出登录</button>
      <button onClick={onAccount}>编辑账号</button>
      <button onClick={close}>关闭菜单</button>
    </aside>
  ),
}));
vi.mock("../src/pages/Chat", () => ({
  default: ({ onNavigation }) => {
    useEffect(() => {
      window.addEventListener("abort-chat-stream", stopped);
      return () => window.removeEventListener("abort-chat-stream", stopped);
    }, []);
    if (renderFailure.page === "chat") throw new Error("Chat render failed");
    return (
      <div>
        企业问答
        <button
          onClick={() => onNavigation({ streaming: true, onStop: stopped })}
        >
          模拟开始生成
        </button>
        <button
          onClick={() => onNavigation({ streaming: false, onStop: stopped })}
        >
          模拟生成完成
        </button>
      </div>
    );
  },
}));
vi.mock("../src/pages/Knowledge", () => ({
  default: () => {
    if (renderFailure.page === "knowledge")
      throw new Error("Knowledge render failed");
    return <div>企业知识</div>;
  },
}));
vi.mock("../src/pages/Management", () => ({
  Tenants: () => <div>平台企业列表</div>,
  Connections: () => <div>模型配置</div>,
  Users: () => <div>用户列表</div>,
}));

const tenantSite = {
  kind: "tenant",
  hostname: "a.localhost",
  tenant: { id: "a", name: "A" },
};
const platformSite = { kind: "platform", hostname: "localhost" };
beforeEach(() => {
  stopped.mockReset();
  renderFailure.page = null;
  localStorage.clear();
  window.history.replaceState(null, "", "/#chat");
  for (const mock of [
    api,
    clearSession,
    savedSession,
    saveSession,
    sessionMatchesSite,
  ])
    vi.mocked(mock).mockReset();
  vi.mocked(sessionMatchesSite).mockImplementation(
    (session, site) =>
      !!session &&
      session.identity === site.kind &&
      (site.kind === "platform" || session.tenant?.id === site.tenant?.id)
  );
});
afterEach(() => {
  routers.splice(0).forEach((router) => router.dispose());
  globalThis.jsdom.reconfigure({ url: originalURL });
});

describe("host-bound app startup", () => {
  it("reuses the original account form and persists the renewed signed session after editing a profile", async () => {
    const session = {
      identity: "tenant",
      role: "user",
      tenant: { id: "a" },
      user: { id: "account-a", username: "alice", bio: "before" },
    };
    const renewed = {
      ...session,
      token: "renewed-password-token",
      user: {
        ...session.user,
        username: "edited-user",
        bio: "updated biography",
      },
    };
    localStorage.setItem(TOKEN_KEY, "old-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path, options) =>
      path === "/status"
        ? { initialized: true, site: tenantSite }
        : options?.method === "PATCH"
          ? renewed
          : session
    );
    render(<App />);
    await screen.findByText("企业问答");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "编辑账号" }));
    const username = document.querySelector('input[name="username"]');
    await user.clear(username);
    await user.type(username, "edited-user");
    const bio = document.querySelector('textarea[name="bio"]');
    await user.clear(bio);
    await user.type(bio, "updated biography");
    await user.type(
      document.querySelector('input[name="password"]'),
      "new-password"
    );
    await user.click(document.querySelector('form button[type="submit"]'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/me", {
        method: "PATCH",
        body: {
          username: "edited-user",
          bio: "updated biography",
          password: "new-password",
        },
      })
    );
    expect(saveSession).toHaveBeenLastCalledWith(renewed);
    await waitFor(() =>
      expect(
        document.querySelector('textarea[name="bio"]')
      ).not.toBeInTheDocument()
    );
  });
  it("keeps browser-history settings navigation clear of queued business hash events", async () => {
    const session = {
      identity: "platform",
      role: "platform_admin",
      user: { id: "platform-admin", username: "admin" },
    };
    window.history.replaceState(null, "", "/#connections");
    localStorage.setItem(TOKEN_KEY, "platform-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status" ? { initialized: true, site: platformSite } : session
    );
    let openEmbedding;
    const embeddingReady = new Promise((resolve) => {
      openEmbedding = resolve;
    });
    function ModelSettings() {
      return (
        <>
          <p>原版模型设置</p>
          <Link to="/settings/embedding-preference">选择嵌入器</Link>
          <Link to="/">返回首页</Link>
        </>
      );
    }
    function EmbeddingSettings() {
      return (
        <>
          <p>原版嵌入器设置</p>
          <Link to="/settings/llm-preference">选择聊天模型</Link>
        </>
      );
    }
    const router = createBrowserRouter([
      {
        path: "/",
        element: <App />,
        children: [
          { path: "*", element: null },
          { path: "settings/llm-preference", element: <ModelSettings /> },
          {
            path: "settings/embedding-preference",
            lazy: async () => {
              await embeddingReady;
              return { Component: EmbeddingSettings };
            },
          },
        ],
      },
    ]);
    const view = renderView(<RouterProvider router={router} />);
    try {
      await screen.findByText("原版模型设置");
      expect(window.location.pathname).toBe("/settings/llm-preference");
      expect(window.location.hash).toBe("");
      fireEvent.click(screen.getByRole("link", { name: "选择嵌入器" }));
      await act(async () => {
        window.dispatchEvent(
          new HashChangeEvent("hashchange", {
            oldURL: `${window.location.origin}/#connections`,
            newURL: window.location.href,
          })
        );
      });
      expect(window.location.hash).toBe("");
      await act(async () => openEmbedding());
      await screen.findByText("原版嵌入器设置");
      expect(window.location.pathname).toBe("/settings/embedding-preference");
      expect(window.location.hash).toBe("");
      fireEvent.click(screen.getByRole("link", { name: "选择聊天模型" }));
      await screen.findByText("原版模型设置");
      expect(window.location.pathname).toBe("/settings/llm-preference");
      expect(window.location.hash).toBe("");
      fireEvent.click(screen.getByRole("link", { name: "返回首页" }));
      await screen.findByText("平台企业列表");
      expect(window.location.pathname).toBe("/");
      expect(window.location.hash).toBe("");
      fireEvent.click(screen.getByRole("button", { name: "打开知识管理" }));
      await screen.findByText("企业知识");
      expect(window.location.pathname).toBe("/knowledge");
      expect(window.location.hash).toBe("");
    } finally {
      view.unmount();
      router.dispose();
    }
  });

  it("redirects the existing connections bookmark to the original settings page with the verified top administrator identity", async () => {
    const session = {
      identity: "platform",
      role: "platform_admin",
      user: { id: "platform-admin", username: "admin" },
    };
    window.location.hash = "connections";
    localStorage.setItem(TOKEN_KEY, "platform-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status" ? { initialized: true, site: platformSite } : session
    );
    function Settings() {
      const identity = useOutletContext();
      return (
        <p>
          原版模型设置：{identity.identity}:{identity.user.id}
        </p>
      );
    }
    const router = createBrowserRouter([
      {
        path: "/",
        element: <App />,
        children: [
          { path: "*", element: null },
          { path: "settings/llm-preference", element: <Settings /> },
        ],
      },
    ]);
    routers.push(router);
    renderView(<RouterProvider router={router} />);
    expect(
      await screen.findByText("原版模型设置：platform:platform-admin")
    ).toBeInTheDocument();
    expect(screen.queryByText("模型配置")).not.toBeInTheDocument();
  });

  it("keeps tenant administrators on a permitted page for the old shared-settings bookmark", async () => {
    const session = {
      identity: "tenant",
      role: "admin",
      tenant: { id: "a" },
      user: { username: "admin" },
    };
    window.location.hash = "connections";
    localStorage.setItem(TOKEN_KEY, "tenant-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status" ? { initialized: true, site: tenantSite } : session
    );
    render(<App />);
    expect(await screen.findByText("企业问答")).toBeInTheDocument();
    expect(screen.getByText("chat,knowledge,users")).toBeInTheDocument();
    expect(screen.queryByText("模型配置")).not.toBeInTheDocument();
  });

  async function generatingChat() {
    const session = {
      identity: "tenant",
      role: "user",
      tenant: { id: "a" },
      user: { username: "user" },
    };
    localStorage.setItem(TOKEN_KEY, "tenant-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status" ? { initialized: true, site: tenantSite } : session
    );
    render(<App />);
    await screen.findByText("企业问答");
    fireEvent.click(screen.getByRole("button", { name: "模拟开始生成" }));
  }
  it("keeps generation running when leaving is cancelled and aborts only on confirmation", async () => {
    await generatingChat();
    fireEvent.click(screen.getByRole("button", { name: "打开知识管理" }));
    await screen.findByText("停止生成回复吗？");
    expect(stopped).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("停止生成回复吗？")).not.toBeInTheDocument();
    expect(screen.getByText("企业问答")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开知识管理" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(stopped).toHaveBeenCalledOnce();
    expect(await screen.findByText("企业知识")).toBeInTheDocument();
  });
  it("guards router history changes and retains an open decision after generation completes", async () => {
    await generatingChat();
    await act(async () => {
      await activeRouter.navigate("/knowledge");
    });
    expect(screen.getByText("停止生成回复吗？")).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "模拟生成完成" }));
    expect(screen.getByText("停止生成回复吗？")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(stopped).not.toHaveBeenCalled();
    expect(await screen.findByText("企业知识")).toBeInTheDocument();
  });
  it("guards logout until the user confirms stopping the current response", async () => {
    await generatingChat();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(clearSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(stopped).toHaveBeenCalledOnce();
    expect(clearSession).toHaveBeenCalledOnce();
    expect(await screen.findByText("登录入口：tenant")).toBeInTheDocument();
  });
  it("drops legacy or copied sessions before calling an identity API", async () => {
    localStorage.setItem(TOKEN_KEY, "old-token");
    vi.mocked(savedSession).mockReturnValue(null);
    vi.mocked(api).mockResolvedValue({ initialized: true, site: tenantSite });
    render(<App />, { container: document.getElementById("root") });
    expect(await screen.findByText("登录入口：tenant")).toBeInTheDocument();
    expect(clearSession).toHaveBeenCalledOnce();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/status");
  });
  it("restores tenant sessions only through the enterprise API and renders enterprise navigation", async () => {
    const session = {
      identity: "tenant",
      role: "admin",
      tenant: { id: "a" },
      user: { username: "admin" },
    };
    localStorage.setItem(TOKEN_KEY, "tenant-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status" ? { initialized: true, site: tenantSite } : session
    );
    render(<App />, { container: document.getElementById("root") });
    expect(await screen.findByText("企业问答")).toBeInTheDocument();
    expect(screen.getByText("chat,knowledge,users")).toBeInTheDocument();
    expect(screen.getByText("a.localhost")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/me");
    expect(api).not.toHaveBeenCalledWith("/platform/me");
    expect(saveSession).toHaveBeenCalledWith({
      ...session,
      token: "tenant-token",
    });
  });
  it("restores platform accounts with platform-only navigation", async () => {
    const session = {
      identity: "platform",
      role: "platform_admin",
      user: { username: "operator" },
    };
    localStorage.setItem(TOKEN_KEY, "platform-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status" ? { initialized: true, site: platformSite } : session
    );
    render(<App />, { container: document.getElementById("root") });
    expect(await screen.findByText("平台企业列表")).toBeInTheDocument();
    expect(
      screen.getByText("tenants,knowledge,connections")
    ).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/platform/me");
    expect(api).not.toHaveBeenCalledWith("/me");
  });
  it("rejects server sessions whose tenant does not match the resolved host", async () => {
    localStorage.setItem(TOKEN_KEY, "tenant-token");
    vi.mocked(savedSession).mockReturnValue({
      identity: "tenant",
      tenant: { id: "a" },
    });
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status"
        ? { initialized: true, site: tenantSite }
        : { identity: "tenant", tenant: { id: "b" } }
    );
    render(<App />, { container: document.getElementById("root") });
    expect(
      await screen.findByText("登录身份与当前访问域名不匹配，请重新登录。")
    ).toBeInTheDocument();
    expect(clearSession).toHaveBeenCalledOnce();
    expect(saveSession).not.toHaveBeenCalled();
  });
  it("returns to the same host's login entry after unauthorized events", async () => {
    const session = {
      identity: "tenant",
      role: "user",
      tenant: { id: "a" },
      user: { username: "user" },
    };
    localStorage.setItem(TOKEN_KEY, "tenant-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status" ? { initialized: true, site: tenantSite } : session
    );
    render(<App />, { container: document.getElementById("root") });
    await screen.findByText("企业问答");
    expect(screen.getByText("chat,knowledge")).toBeInTheDocument();
    act(() => window.dispatchEvent(new Event("enterprise:unauthorized")));
    await waitFor(() =>
      expect(screen.getByText("登录入口：tenant")).toBeInTheDocument()
    );
    expect(screen.getByText("登录已失效，请重新登录。")).toBeInTheDocument();
  });
  it("navigates permitted pages, responds to router changes and logs out on the current host", async () => {
    const session = {
      identity: "tenant",
      role: "user",
      tenant: { id: "a" },
      user: { username: "user" },
    };
    localStorage.setItem(TOKEN_KEY, "tenant-token");
    vi.mocked(savedSession).mockReturnValue(session);
    vi.mocked(api).mockImplementation(async (path) =>
      path === "/status" ? { initialized: true, site: tenantSite } : session
    );
    render(<App />, { container: document.getElementById("root") });
    await screen.findByText("企业问答");
    fireEvent.click(screen.getByRole("button", { name: "打开知识管理" }));
    expect(await screen.findByText("企业知识")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开问答" }));
    expect(await screen.findByText("企业问答")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开菜单" }));
    expect(screen.getByText("菜单已展开")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭菜单" }));
    expect(screen.getByText("菜单已关闭")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByText("登录入口：tenant")).toBeInTheDocument();
    expect(clearSession).toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });
  it("recovers a failed status request and opens the host's session after login", async () => {
    vi.mocked(api)
      .mockRejectedValueOnce(new Error("服务暂不可用"))
      .mockResolvedValue({ initialized: true, site: tenantSite });
    render(<App />, { container: document.getElementById("root") });
    expect(await screen.findByText("服务暂不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试连接" }));
    await screen.findByText("登录入口：tenant");
    fireEvent.click(screen.getByRole("button", { name: "模拟登录" }));
    expect(await screen.findByText("企业问答")).toBeInTheDocument();
  });
});
