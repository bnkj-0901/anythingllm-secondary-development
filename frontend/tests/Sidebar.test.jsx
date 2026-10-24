import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../src/ThemeContext";
import Sidebar from "../src/components/Sidebar";
import i18n from "../src/i18n";
import { resources } from "../src/locales/resources";
import { MemoryRouter } from "react-router-dom";
import ThreadItem from "../src/components/Sidebar/ActiveWorkspaces/ThreadContainer/ThreadItem";
import { AuthContext } from "../src/AuthContext";
import { LogoContext } from "../src/LogoContext";
import System from "../src/models/system";

beforeEach(() => {
  vi.spyOn(System, "fetchCustomFooterIcons").mockResolvedValue({
    footerData: [],
  });
});

const pages = {
  chat: { label: "问答检索", icon: "chat" },
  knowledge: { label: "知识管理", icon: "books" },
  users: { label: "用户与角色", icon: "users" },
  connections: { label: "AI连接", icon: "settings" },
};
const session = {
  identity: "tenant",
  role: "user",
  tenant: { id: "a", name: "A company" },
  user: { username: "alice" },
};
function page(allowed = ["chat", "knowledge"], extra = {}) {
  const navigate = vi.fn();
  const logout = vi.fn();
  render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthContext.Provider
          value={{
            store: {
              user: {
                ...session.user,
                role: session.role,
                identity: session.identity,
              },
            },
          }}
        >
          <LogoContext.Provider value={{ logo: "logo.png" }}>
            <Sidebar
              session={session}
              hostname="a.localhost"
              pages={pages}
              allowed={allowed}
              active="chat"
              navigate={navigate}
              onLogout={logout}
              close={vi.fn()}
              {...extra}
            />
          </LogoContext.Provider>
        </AuthContext.Provider>
      </ThemeProvider>
    </MemoryRouter>
  );
  return { navigate, logout };
}

function modifiedClick(link, modifier) {
  const browserAction = vi.fn((event) => {
    expect(event.defaultPrevented).toBe(false);
    event.preventDefault();
  });
  document.addEventListener("click", browserAction, { once: true });
  fireEvent.click(link, { [modifier]: true });
  expect(browserAction).toHaveBeenCalledOnce();
}

describe("upstream navigation and preferences adapted to tenant identity", () => {
  it("shows only supplied permitted routes and keeps router navigation in the same host", () => {
    const { navigate, logout } = page();
    expect(
      screen.queryByRole("link", { name: "用户与角色" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "管理设置" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("a.localhost")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "知识管理" }));
    expect(navigate).toHaveBeenCalledWith("/knowledge");
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(logout).toHaveBeenCalledOnce();
  });
  it("uses the product chat URL for conversation links and preserves browser new-tab actions", () => {
    const conversation = { id: 42, title: "报销问答" };
    const onSelect = vi.fn();
    page(undefined, {
      chat: {
        conversations: [conversation],
        activeId: 42,
        onSelect,
        onNew: vi.fn(),
        onRemove: vi.fn(),
      },
    });
    const link = screen.getByRole("link", { name: "报销问答" });
    expect(link).toHaveAttribute("href", "/chat");
    expect(link.href).not.toMatch(/workspace|undefined/);
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(conversation);
    onSelect.mockClear();
    modifiedClick(link, "ctrlKey");
    modifiedClick(link, "metaKey");
    expect(onSelect).not.toHaveBeenCalled();
  });
  it("retains the original workspace link when no scoped href is provided", () => {
    render(
      <MemoryRouter>
        <ThreadItem
          workspace={{ slug: "product" }}
          thread={{ id: 1, slug: "installation", name: "原工作区对话" }}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: "原工作区对话" })).toHaveAttribute(
      "href",
      "/workspace/product/t/installation"
    );
  });
  it("retains the original expandable settings menu for authorized administration", () => {
    page(["chat", "knowledge", "users", "connections"]);
    const management = screen.getByRole("link", { name: "管理设置" });
    expect(
      screen.queryByRole("link", { name: "用户与角色" })
    ).not.toBeInTheDocument();
    fireEvent.click(management);
    expect(
      screen.getByRole("link", { name: "用户与角色" })
    ).toBeInTheDocument();
    fireEvent.click(management);
    expect(
      screen.queryByRole("link", { name: "AI连接" })
    ).not.toBeInTheDocument();
  });
  it("opens original settings through the existing generation navigation guard and preserves new-tab actions", async () => {
    const { navigate } = page();
    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link).toHaveAttribute("href", "/settings/interface");
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith("/settings/interface");
    navigate.mockClear();
    modifiedClick(link, "ctrlKey");
    modifiedClick(link, "metaKey");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("uses original translations and an explicit English fallback for new SaaS vocabulary", async () => {
    expect(Object.keys(resources)).toHaveLength(31);
    await i18n.changeLanguage("fr");
    expect(i18n.t("customization.items.display-language.title")).not.toBe(
      "customization.items.display-language.title"
    );
    expect(i18n.t("enterprise:pages.knowledge")).toBe("Knowledge management");
  });
});
