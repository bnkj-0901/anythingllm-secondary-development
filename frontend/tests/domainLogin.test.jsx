import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Login from "../src/pages/Login";
import { api, saveSession, sessionMatchesSite } from "../src/models/platform";
import { saveAs } from "file-saver";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const sso = vi.hoisted(() => ({
  loading: false,
  ssoConfig: { enabled: false },
}));

vi.mock("../src/hooks/useSimpleSSO", () => ({
  default: () => sso,
}));
vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

vi.mock("../src/models/platform", () => ({
  api: vi.fn(),
  saveSession: vi.fn(),
  sessionMatchesSite: vi.fn(),
}));
vi.mock("../src/ThemeContext", () => ({
  useThemeContext: () => ({ isLight: false }),
}));

const tenantSite = {
  kind: "tenant",
  hostname: "acme.localhost",
  tenant: { id: "acme", code: "acme", name: "示例企业" },
};
const platformSite = { kind: "platform", hostname: "localhost" };
const tenantSession = {
  identity: "tenant",
  tenant: { id: "acme" },
  user: { username: "admin" },
  token: "test-token",
};
beforeEach(() => {
  sso.loading = false;
  sso.ssoConfig = { enabled: false };
  window.history.replaceState(null, "", "/");
  vi.mocked(api).mockReset();
  vi.mocked(saveSession).mockReset();
  vi.mocked(sessionMatchesSite).mockReset().mockReturnValue(true);
});

function login(props = {}) {
  const onSession = vi.fn();
  render(
    <Login initialized site={tenantSite} onSession={onSession} {...props} />,
    { container: document.getElementById("root") }
  );
  return { user: userEvent.setup(), onSession };
}
async function credentials(user, account = "admin") {
  await user.type(screen.getByLabelText(/企业账号|平台账号/), account);
  await user.type(screen.getByLabelText(/^密码/), "test-password");
}

describe("host-derived login", () => {
  it("uses the host's enterprise name and submits only username and password", async () => {
    vi.mocked(api).mockResolvedValue(tenantSession);
    const { user, onSession } = login();
    expect(
      screen.getByRole("heading", { name: "示例企业登录" })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("企业代码")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /平台管理登录|企业用户登录/ })
    ).not.toBeInTheDocument();
    await credentials(user, " admin ");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/login", {
        method: "POST",
        body: { username: "admin", password: "test-password" },
      })
    );
    expect(saveSession).toHaveBeenCalledWith(tenantSession);
    expect(onSession).toHaveBeenCalledWith(tenantSession);
  });
  it("shows platform login only at platform hosts and validates the resulting identity", async () => {
    vi.mocked(api).mockResolvedValue({
      identity: "platform",
      token: "platform-token",
    });
    const { user, onSession } = login({ site: platformSite });
    expect(
      screen.getByRole("heading", { name: "平台管理登录" })
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("企业账号")).not.toBeInTheDocument();
    await credentials(user);
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/platform/login", expect.anything())
    );
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({ identity: "platform" })
    );
  });
  it("explains deployment initialization without offering HTTP setup", () => {
    login({ initialized: false, site: platformSite });
    expect(screen.getByRole("alert")).toHaveTextContent("数据库尚未完成初始化");
    expect(screen.queryByLabelText("平台账号")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建并进入平台" })
    ).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });
  it("does not show forms for unknown hosts or an uninitialized enterprise entry", () => {
    const { unmount } = render(
      <Login
        initialized
        site={{ kind: "unknown", hostname: "wrong.example.com" }}
      />,
      { container: document.getElementById("root") }
    );
    expect(
      screen.getByRole("heading", { name: "访问入口未绑定" })
    ).toBeInTheDocument();
    expect(screen.getByText("wrong.example.com")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "登录" })
    ).not.toBeInTheDocument();
    unmount();
    document.body.innerHTML = '<div id="root"></div>';
    login({ initialized: false });
    expect(screen.getByRole("alert")).toHaveTextContent("数据库尚未完成初始化");
    expect(screen.queryByLabelText("企业账号")).not.toBeInTheDocument();
  });
  it("reports service failures and allows retry without showing a login form", async () => {
    const onRetry = vi.fn();
    const { user } = login({
      initialized: null,
      site: null,
      initialError: "服务不可达",
      onRetry,
    });
    expect(screen.getByRole("alert")).toHaveTextContent("服务不可达");
    await user.click(screen.getByRole("button", { name: "重新连接" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("密码")).not.toBeInTheDocument();
  });
  it("rejects mismatched host identities without caching or opening the session", async () => {
    vi.mocked(api).mockResolvedValue({ identity: "platform" });
    vi.mocked(sessionMatchesSite).mockReturnValue(false);
    const { user, onSession } = login();
    await credentials(user);
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "登录身份与当前访问域名不匹配"
    );
    expect(saveSession).not.toHaveBeenCalled();
    expect(onSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("keeps credentials on authentication errors for a corrected retry", async () => {
    vi.mocked(api).mockRejectedValue(new Error("账号或密码错误"));
    const { user } = login();
    await credentials(user);
    await user.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "账号或密码错误"
    );
    expect(screen.getByLabelText("企业账号")).toHaveValue("admin");
    expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
  });
  it("registers within the current domain and displays original recovery-code download before saving a session", async () => {
    const codes = ["first-code", "second-code", "third-code", "fourth-code"];
    vi.mocked(api).mockResolvedValue({
      ...tenantSession,
      role: "user",
      recoveryCodes: codes,
    });
    const { user, onSession } = login();
    await user.click(screen.getByRole("button", { name: "注册账号" }));
    await user.type(screen.getByLabelText("姓名"), "New user");
    await credentials(user, "new-user");
    await user.click(screen.getByRole("button", { name: "注册" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/register", {
        method: "POST",
        body: {
          username: "new-user",
          password: "test-password",
          name: "New user",
        },
      })
    );
    expect(await screen.findByText("first-code")).toBeInTheDocument();
    expect(saveSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(saveAs).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(saveSession).toHaveBeenCalledWith({
      ...tenantSession,
      role: "user",
    });
    expect(onSession).toHaveBeenCalledWith({ ...tenantSession, role: "user" });
  });
  it("reuses the recovery and reset forms and keeps reset tokens out of browser storage", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({
        success: true,
        resetToken: "private-reset-token",
      })
      .mockResolvedValueOnce({ success: true });
    const { user } = login();
    await user.click(screen.getByRole("button", { name: "找回密码" }));
    await user.type(
      document.querySelector('input[name="username"]'),
      "new-user"
    );
    await user.type(
      document.querySelector('input[name="recoveryCode1"]'),
      "first-code"
    );
    await user.type(
      document.querySelector('input[name="recoveryCode2"]'),
      "second-code"
    );
    await user.click(document.querySelector('form button[type="submit"]'));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/recover-account", {
        method: "POST",
        body: {
          username: "new-user",
          recoveryCodes: ["first-code", "second-code"],
        },
      })
    );
    await user.type(
      document.querySelector('input[name="newPassword"]'),
      "new-password"
    );
    await user.type(
      document.querySelector('input[name="confirmPassword"]'),
      "new-password"
    );
    await user.click(screen.getByRole("button", { name: "Reset Password" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/reset-password", {
        method: "POST",
        body: {
          token: "private-reset-token",
          newPassword: "new-password",
          confirmPassword: "new-password",
        },
      })
    );
    expect(
      await screen.findByRole("button", { name: "登录" })
    ).toBeInTheDocument();
    expect(localStorage.getItem("resetToken")).toBeNull();
    expect(saveSession).not.toHaveBeenCalled();
  });
});

describe("original Simple SSO tenant entry", () => {
  function Destination() {
    const location = useLocation();
    return <div>SSO callback {location.search}</div>;
  }

  it("forwards an SSO token to the original callback instead of exposing local login", async () => {
    sso.ssoConfig = {
      enabled: true,
      noLogin: true,
      noLoginRedirect: "https://identity.example.com/sign-in",
    };
    window.history.replaceState(null, "", "/?token=callback-token");
    render(
      <MemoryRouter initialEntries={["/?token=callback-token"]}>
        <Routes>
          <Route path="/" element={<Login initialized site={tenantSite} />} />
          <Route path="/sso/simple" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    );
    expect(
      await screen.findByText("SSO callback ?token=callback-token")
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("企业账号")).not.toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });

  it("uses the original SSO callback when password login is disabled without an external redirect", async () => {
    sso.ssoConfig = { enabled: true, noLogin: true };
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Login initialized site={tenantSite} />} />
          <Route path="/sso/simple" element={<Destination />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText("SSO callback")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "注册账号" })
    ).not.toBeInTheDocument();
  });

  it("keeps top administrator login available when tenant SSO is enabled", () => {
    sso.ssoConfig = { enabled: true, noLogin: true };
    login({ site: platformSite });
    expect(screen.getByLabelText("平台账号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  });
});
