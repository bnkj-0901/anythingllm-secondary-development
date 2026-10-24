import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Users, Tenants } from "../src/pages/Management";
import { api } from "../src/models/platform";
vi.mock("../src/models/platform", () => ({
  api: vi.fn(),
  downloadDocument: vi.fn(),
  TOKEN_KEY: "ep_token",
}));
const session = { user: { id: "self" } };
let users, tenants, failure;
beforeEach(() => {
  users = [
    {
      id: "self",
      name: "Ada",
      username: "ada",
      role: "admin",
      status: "active",
    },
  ];
  tenants = [
    {
      id: "acme",
      code: "acme",
      name: "Acme",
      hostname: "acme.localhost",
      webHost: "acme.localhost",
      webURL: "http://acme.localhost:3000",
      status: "active",
    },
  ];
  failure = null;
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path, options = {}) => {
      if (failure) throw new Error(failure);
      if (options.method) return {};
      return path === "/users" ? { users } : { tenants };
    });
});
async function userPage() {
  render(<Users session={session} />);
  await screen.findByText("Ada");
  return userEvent.setup();
}
async function tenantPage() {
  render(<Tenants session={session} />);
  await screen.findByText("Acme");
  return userEvent.setup();
}
async function fillUser(user) {
  await user.type(screen.getByLabelText("显示名称"), "Lin");
  await user.type(screen.getByLabelText(/^登录账号/), "lin");
  await user.type(screen.getByLabelText(/^初始密码/), "new-test-password");
}
describe("tenant user management", () => {
  it("shows the generated WeChat account and its binding status in separate columns", async () => {
    users = [
      {
        id: 25,
        name: "小林",
        username: "wx_internal-identity-hash",
        wechatBound: true,
        role: "user",
        status: "active",
      },
    ];
    render(<Users session={session} />);
    const user = userEvent.setup();
    await screen.findByText("小林");
    expect(
      screen.getByRole("columnheader", { name: "微信登录" })
    ).toBeInTheDocument();
    const row = screen.getByText("小林").closest("tr");
    const cells = within(row).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("wx_internal-identity-hash");
    expect(cells[1]).not.toHaveTextContent("微信登录");
    expect(cells[2]).toHaveTextContent("已绑定");
    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText(/^登录账号/)).toHaveValue(
      "wx_internal-identity-hash"
    );
    expect(screen.getByLabelText(/^登录账号/)).toHaveAttribute("readonly");
    expect(screen.getByLabelText("显示名称")).toHaveValue("小林");
    expect(screen.getByLabelText(/^重设密码/)).toBeInTheDocument();
  });
  it("shows unbound WeChat status without changing a password user's account", async () => {
    await userPage();
    const row = screen.getByText("Ada").closest("tr");
    const cells = within(row).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("ada");
    expect(cells[2]).toHaveTextContent("未绑定");
  });
  it("reuses the original daily message limit control for ordinary users", async () => {
    const user = await userPage();
    await user.click(screen.getByRole("button", { name: "添加用户" }));
    await fillUser(user);
    await user.click(
      screen.getByRole("checkbox", { name: /Limit messages per day/ })
    );
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "35" },
    });
    await user.click(screen.getByRole("button", { name: "保存用户" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/users",
        expect.objectContaining({
          body: expect.objectContaining({ dailyMessageLimit: 35 }),
        })
      )
    );
  });
  it.each(["12345678", "p".repeat(129)])(
    "uses original username rules and leaves configurable password rules to the server (%#)",
    async (password) => {
      const user = await userPage();
      await user.click(screen.getByRole("button", { name: "添加用户" }));
      fireEvent.change(screen.getByLabelText("显示名称"), {
        target: { value: "Short account" },
      });
      const username = screen.getByLabelText(/^登录账号/);
      fireEvent.change(username, { target: { value: "1a" } });
      expect(username.checkValidity()).toBe(false);
      fireEvent.change(username, { target: { value: "ab" } });
      expect(username.checkValidity()).toBe(true);
      const input = screen.getByLabelText(/^初始密码/);
      expect(input).not.toHaveAttribute("minlength");
      expect(input).not.toHaveAttribute("maxlength");
      fireEvent.change(input, { target: { value: password } });
      await user.click(screen.getByRole("button", { name: "保存用户" }));
      await waitFor(() =>
        expect(api).toHaveBeenCalledWith(
          "/users",
          expect.objectContaining({
            body: expect.objectContaining({ username: "ab", password }),
          })
        )
      );
    }
  );
  it("creates tenant-scoped users and closes the form after success", async () => {
    const user = await userPage();
    expect(screen.getByText("我")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加用户" }));
    await fillUser(user);
    await user.selectOptions(screen.getByLabelText("角色"), "admin");
    await user.click(screen.getByRole("button", { name: "保存用户" }));
    await screen.findByText("用户已创建，可使用设置的账号密码登录。");
    expect(api).toHaveBeenCalledWith("/users", {
      method: "POST",
      body: {
        name: "Lin",
        username: "lin",
        password: "new-test-password",
        role: "admin",
        status: "active",
        dailyMessageLimit: null,
      },
    });
  });
  it("updates role/status and omits an unchanged password", async () => {
    const user = await userPage();
    await user.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText(/^登录账号/)).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("角色"), "user");
    await user.selectOptions(screen.getByLabelText("账号状态"), "disabled");
    await user.click(screen.getByRole("button", { name: "保存用户" }));
    await screen.findByText("用户信息已更新。");
    expect(api).toHaveBeenCalledWith("/users/self", {
      method: "PATCH",
      body: {
        name: "Ada",
        username: "ada",
        role: "user",
        status: "disabled",
        dailyMessageLimit: null,
      },
    });
  });
  it("preserves a rejected user draft and accepts retry", async () => {
    const user = await userPage();
    await user.click(screen.getByRole("button", { name: "添加用户" }));
    await fillUser(user);
    failure = "当前企业账号重复";
    await user.click(screen.getByRole("button", { name: "保存用户" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure);
    expect(screen.getByLabelText(/^登录账号/)).toHaveValue("lin");
    failure = null;
    await user.click(screen.getByRole("button", { name: "保存用户" }));
    await screen.findByText("用户已创建，可使用设置的账号密码登录。");
  });
  it("shows empty/load failure states and allows refresh and cancelling a draft", async () => {
    failure = "用户加载失败";
    render(<Users session={session} />);
    await screen.findByText(failure);
    const user = userEvent.setup();
    failure = null;
    users = [];
    await user.click(screen.getByRole("button", { name: "关闭提示" }));
    await user.click(screen.getByRole("button", { name: "刷新用户" }));
    await screen.findByText("暂无用户");
    await user.click(screen.getByRole("button", { name: "添加用户" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("authenticated user avatars", () => {
  let originalCreate, originalRevoke;
  beforeEach(() => {
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:managed-user-avatar");
    URL.revokeObjectURL = vi.fn();
    users[0].pfpFilename = "saved-avatar.png";
    localStorage.setItem("ep_token", "avatar-session");
  });
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    localStorage.clear();
  });
  it("fetches an authorized avatar as a blob and releases it when the list closes", async () => {
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(["avatar"], { type: "image/png" }),
    });
    const { unmount } = render(<Users session={session} />);
    expect(
      await screen.findByRole("img", { name: "Ada的头像" })
    ).toHaveAttribute("src", "blob:managed-user-avatar");
    expect(fetchAvatar).toHaveBeenCalledWith(
      "/api/enterprise/users/self/avatar",
      {
        headers: { Authorization: "Bearer avatar-session" },
        signal: expect.any(AbortSignal),
      }
    );
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:managed-user-avatar"
    );
  });
  it("uses the selected tenant endpoint and falls back when avatar access is denied", async () => {
    api.mockResolvedValue({ users });
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
    });
    render(<Users session={session} tenantId="selected-tenant" />);
    await screen.findByText("Ada");
    await waitFor(() => expect(fetchAvatar).toHaveBeenCalled());
    expect(fetchAvatar.mock.calls[0][0]).toBe(
      "/api/enterprise/platform/tenants/selected-tenant/users/self/avatar"
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
  it("keeps a late avatar response from creating a URL after unmount", async () => {
    let respond;
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise((resolve) => {
        respond = resolve;
      })
    );
    const { unmount } = render(<Users session={session} />);
    await screen.findByText("Ada");
    unmount();
    respond({ ok: true, status: 200, blob: async () => new Blob(["late"]) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
describe("platform tenant management", () => {
  it("edits mini-program credentials in the existing tenant form without returning or resubmitting the saved secret", async () => {
    vi.mocked(api).mockImplementation(async (path, options = {}) => {
      if (path.endsWith("/wechat")) {
        if (options.method)
          return { appId: "wx-new", enabled: true, hasSecret: true };
        return { appId: "wx-existing", enabled: false, hasSecret: true };
      }
      return options.method ? {} : { tenants };
    });
    const user = await tenantPage();
    await user.click(screen.getByRole("button", { name: "编辑" }));
    const appId = await screen.findByLabelText("微信小程序 AppID");
    expect(appId).toHaveValue("wx-existing");
    const secret = screen.getByLabelText(/^微信小程序 AppSecret/);
    expect(secret).toHaveValue("");
    await user.clear(appId);
    await user.type(appId, "wx-new");
    await user.selectOptions(screen.getByLabelText("微信登录"), "enabled");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/platform/tenants/acme/wechat", {
        method: "PUT",
        body: { appId: "wx-new", enabled: true },
      })
    );
    await screen.findByText("租户信息和访问域名已更新。");
  });
  it("keeps a rejected mini-program credential draft available for correction", async () => {
    vi.mocked(api).mockImplementation(async (path, options = {}) => {
      if (path.endsWith("/wechat")) {
        if (options.method) throw new Error("小程序配置不完整");
        return { appId: "", enabled: false, hasSecret: false };
      }
      return options.method ? {} : { tenants };
    });
    const user = await tenantPage();
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.type(
      await screen.findByLabelText("微信小程序 AppID"),
      "wx-test"
    );
    await user.type(
      screen.getByLabelText(/^微信小程序 AppSecret/),
      "submitted-secret"
    );
    await user.selectOptions(screen.getByLabelText("微信登录"), "enabled");
    await user.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "小程序配置不完整"
    );
    expect(screen.getByLabelText(/^微信小程序 AppSecret/)).toHaveValue(
      "submitted-secret"
    );
    expect(api).toHaveBeenCalledWith("/platform/tenants/acme/wechat", {
      method: "PUT",
      body: { appId: "wx-test", enabled: true, appSecret: "submitted-secret" },
    });
  });
  it("manages a selected enterprise's users without using the enterprise login routes", async () => {
    const user = await tenantPage();
    vi.mocked(api).mockImplementation(async (path, options = {}) => {
      if (options.method) return {};
      if (path === "/platform/tenants/acme/users") return { users };
      if (path === "/platform/tenants") return { tenants };
      throw new Error(`unexpected endpoint: ${path}`);
    });
    await user.click(screen.getByRole("button", { name: "用户管理" }));
    const panel = await screen.findByRole("dialog", {
      name: "Acme · 用户管理",
    });
    await within(panel).findByText("Ada");
    await user.click(within(panel).getByRole("button", { name: "添加用户" }));
    await fillUser(user);
    await user.click(screen.getByRole("button", { name: "保存用户" }));
    await screen.findByText("用户已创建，可使用设置的账号密码登录。");
    expect(api).toHaveBeenCalledWith("/platform/tenants/acme/users", {
      method: "POST",
      body: {
        name: "Lin",
        username: "lin",
        password: "new-test-password",
        role: "user",
        status: "active",
        dailyMessageLimit: null,
      },
    });
    await user.click(within(panel).getByRole("button", { name: "编辑" }));
    await user.selectOptions(screen.getByLabelText("角色"), "user");
    await user.type(screen.getByLabelText(/^重设密码/), "reset-test-password");
    await user.click(screen.getByRole("button", { name: "保存用户" }));
    await screen.findByText("用户信息已更新。");
    expect(api).toHaveBeenCalledWith("/platform/tenants/acme/users/self", {
      method: "PATCH",
      body: {
        name: "Ada",
        username: "ada",
        password: "reset-test-password",
        role: "user",
        status: "active",
        dailyMessageLimit: null,
      },
    });
    expect(api.mock.calls.some(([path]) => path === "/users")).toBe(false);
    await user.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("lets the top administrator read tenant knowledge and personal conversations through platform endpoints", async () => {
    const user = await tenantPage();
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/platform/libraries?tenantId=acme")
        return { libraries: [{ id: "private-lib", name: "Private library" }] };
      if (path === "/platform/conversations?tenantId=acme")
        return {
          conversations: [
            { id: "personal-chat", userId: "alice", title: "Personal chat" },
          ],
        };
      if (path.startsWith("/platform/documents?"))
        return {
          documents: [{ id: "private-doc", title: "Private document" }],
        };
      if (path === "/platform/documents/private-doc")
        return {
          document: {
            title: "Private document",
            content: "Authorized top administrator preview",
          },
        };
      if (path === "/platform/conversations/personal-chat")
        return {
          messages: [
            {
              id: "answer",
              role: "assistant",
              content: "Personal answer",
              sources: [{ title: "Saved reference" }],
            },
          ],
        };
      throw new Error("unexpected endpoint");
    });
    await user.click(screen.getByRole("button", { name: "查看内容" }));
    await user.selectOptions(
      await screen.findByLabelText("知识库"),
      "private-lib"
    );
    await user.click(
      await screen.findByRole("button", { name: "Private document" })
    );
    expect(
      await screen.findByText("Authorized top administrator preview")
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("个人会话"),
      "personal-chat"
    );
    expect(await screen.findByText("Personal answer")).toBeInTheDocument();
    expect(screen.getByText("来源：Saved reference")).toBeInTheDocument();
    expect(
      screen.queryByText("Authorized top administrator preview")
    ).not.toBeInTheDocument();
    expect(
      api.mock.calls.every(
        ([path, options]) => !options?.method || path === "/platform/tenants"
      )
    ).toBe(true);
  });
  it("shows the single assigned tenant URL and edits it in the tenant form", async () => {
    await tenantPage();
    const link = screen.getByRole("link", { name: "acme.localhost" });
    expect(link).toHaveAttribute("href", "http://acme.localhost:3000");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "访问域名" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "域名管理" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "企业代码" })
    ).not.toBeInTheDocument();
  });
  it("validates internal tenant identifiers with alphanumeric endings", async () => {
    const user = await tenantPage();
    await user.click(screen.getByRole("button", { name: "创建租户" }));
    const subdomain = screen.getByLabelText(/^租户标识/);
    for (const invalid of ["acme-", "-acme", "a_b", "ab"]) {
      fireEvent.change(subdomain, { target: { value: invalid } });
      expect(subdomain.checkValidity()).toBe(false);
    }
    for (const valid of ["abc", "acme-2", "a".repeat(40)]) {
      fireEvent.change(subdomain, { target: { value: valid } });
      expect(subdomain.checkValidity()).toBe(true);
    }
  });
  it("creates a tenant and its first admin without a login tenant code", async () => {
    const user = await tenantPage();
    await user.click(screen.getByRole("button", { name: "创建租户" }));
    await user.type(screen.getByLabelText("租户名称"), "Beta");
    await user.type(screen.getByLabelText(/^租户标识/), "BeTa");
    await user.type(screen.getByLabelText("管理员姓名"), "Admin");
    await user.type(screen.getByLabelText(/^管理员账号/), "admin");
    await user.type(
      screen.getByLabelText("管理员初始密码"),
      "new-test-password"
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "创建租户",
      })
    );
    await screen.findByText("租户和首位管理员已创建。");
    expect(api).toHaveBeenCalledWith("/platform/tenants", {
      method: "POST",
      body: {
        name: "Beta",
        code: "beta",
        adminName: "Admin",
        adminUsername: "admin",
        adminPassword: "new-test-password",
      },
    });
  });
  it("creates a tenant with an explicit normalized hostname and preserves a rejected draft", async () => {
    const user = await tenantPage();
    await user.click(screen.getByRole("button", { name: "创建租户" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByLabelText("租户名称"), "Beta");
    await user.type(dialog.getByLabelText(/^租户标识/), "beta");
    await user.type(
      dialog.getByLabelText(/^完整域名/),
      " Ai.Beta.Example.com "
    );
    await user.type(dialog.getByLabelText("管理员姓名"), "Admin");
    await user.type(dialog.getByLabelText(/^管理员账号/), "admin");
    await user.type(dialog.getByLabelText("管理员初始密码"), "test-password");
    failure = "域名冲突";
    await user.click(dialog.getByRole("button", { name: "创建租户" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure);
    expect(dialog.getByLabelText(/^完整域名/)).toHaveValue(
      " Ai.Beta.Example.com "
    );
    failure = null;
    await user.click(dialog.getByRole("button", { name: "创建租户" }));
    await screen.findByText("租户和首位管理员已创建。");
    expect(api).toHaveBeenCalledWith("/platform/tenants", {
      method: "POST",
      body: {
        name: "Beta",
        code: "beta",
        hostname: "ai.beta.example.com",
        adminName: "Admin",
        adminUsername: "admin",
        adminPassword: "test-password",
      },
    });
  });
  it("replaces one hostname without exposing domain arrays or another administrator form", async () => {
    const user = await tenantPage();
    await user.click(screen.getByRole("button", { name: "编辑" }));
    const dialog = within(screen.getByRole("dialog", { name: "编辑租户" }));
    expect(dialog.getByLabelText(/^租户标识/)).toBeDisabled();
    expect(dialog.queryByLabelText(/^管理员账号/)).not.toBeInTheDocument();
    expect(dialog.getByLabelText(/^访问域名/)).toBeRequired();
    expect(dialog.getByLabelText(/^访问域名/)).toHaveValue("acme.localhost");
    await user.clear(dialog.getByLabelText(/^访问域名/));
    await user.type(
      dialog.getByLabelText(/^访问域名/),
      " New.Acme.Example.com "
    );
    await user.clear(dialog.getByLabelText("租户名称"));
    await user.type(dialog.getByLabelText("租户名称"), "Acme New");
    failure = "该域名已被使用";
    await user.click(dialog.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure);
    expect(dialog.getByLabelText(/^访问域名/)).toHaveValue(
      " New.Acme.Example.com "
    );
    failure = null;
    tenants[0] = {
      ...tenants[0],
      name: "Acme New",
      hostname: "new.acme.example.com",
      webHost: "new.acme.example.com",
      webURL: "https://new.acme.example.com",
    };
    await user.click(dialog.getByRole("button", { name: "保存修改" }));
    await screen.findByText("租户信息和访问域名已更新。");
    expect(api).toHaveBeenCalledWith("/platform/tenants/acme", {
      method: "PATCH",
      body: { name: "Acme New", hostname: "new.acme.example.com" },
    });
    expect(
      screen.queryByRole("link", { name: "acme.localhost" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "new.acme.example.com" })
    ).toHaveAttribute("href", "https://new.acme.example.com");
    expect(api.mock.calls.some(([path]) => path.includes("/domains"))).toBe(
      false
    );
  });
  it("requires confirmation to disable and supports enabling a tenant", async () => {
    const user = await tenantPage();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "停用" }));
    expect(api).not.toHaveBeenCalledWith(
      "/platform/tenants/acme",
      expect.anything()
    );
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "停用" }));
    await screen.findByText("租户状态已更新。");
    expect(api).toHaveBeenCalledWith("/platform/tenants/acme", {
      method: "PATCH",
      body: { status: "disabled" },
    });
    tenants[0].status = "disabled";
    await user.click(screen.getByRole("button", { name: "刷新租户" }));
    await user.click(await screen.findByRole("button", { name: "启用" }));
    expect(api).toHaveBeenCalledWith("/platform/tenants/acme", {
      method: "PATCH",
      body: { status: "active" },
    });
  });
  it("shows tenant operation errors and retains failed creation", async () => {
    const user = await tenantPage();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    failure = "租户更新失败";
    await user.click(screen.getByRole("button", { name: "停用" }));
    await screen.findByText(failure);
    await user.click(screen.getByRole("button", { name: "创建租户" }));
    await user.type(screen.getByLabelText("租户名称"), "Beta");
    fireEvent.submit(screen.getByLabelText("租户名称").closest("form"));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getByLabelText("租户名称")).toHaveValue("Beta");
    await user.click(screen.getByRole("button", { name: "取消" }));
    failure = null;
    await user.click(screen.getByRole("button", { name: "刷新租户" }));
    await screen.findByText("Acme");
  });
});
