import { useEffect, useRef, useState } from "react";
import {
  USERNAME_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_PATTERN,
} from "@/utils/username";
import { MessageLimitInput } from "@/pages/Admin/Users";
import { api, downloadDocument, TOKEN_KEY } from "@/models/platform";
import { API_BASE } from "@/utils/constants";
import {
  Button,
  Empty,
  Field,
  Icon,
  Modal,
  Notice,
  Status,
  Markdown,
} from "@/components/lib/PlatformUI";

function useManagement(path, key) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function refresh() {
    setLoading(true);
    try {
      const result = await api(path);
      setItems(result[key] || []);
      return result;
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, [path]);
  return { items, loading, error, setError, success, setSuccess, refresh };
}

function Feedback({ data }) {
  return (
    <>
      <Notice onClose={() => data.setError("")}>{data.error}</Notice>
      <Notice type="success" onClose={() => data.setSuccess("")}>
        {data.success}
      </Notice>
    </>
  );
}
function Loading() {
  return (
    <div className="flex min-h-[200px] items-center justify-center gap-3 text-sm text-theme-text-secondary">
      <span className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
      正在加载…
    </div>
  );
}

function UserAvatar({ user, basePath }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl;
    setUrl("");
    if (user.pfpFilename) {
      const token = localStorage.getItem(TOKEN_KEY);
      fetch(
        `${API_BASE.replace(/\/$/, "")}/enterprise${basePath}/${encodeURIComponent(user.id)}/avatar`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        }
      )
        .then(async (response) => {
          if (!response.ok || response.status === 204) return;
          const blob = await response.blob();
          if (!active) return;
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [basePath, user.id, user.pfpFilename]);

  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-theme-sidebar-item-default text-sm text-theme-text-primary">
      {url ? (
        <img
          className="h-full w-full object-cover"
          src={url}
          alt={`${user.name || "用户"}的头像`}
          onError={() => setUrl("")}
        />
      ) : (
        (user.name || "用户").slice(0, 1)
      )}
    </span>
  );
}

export function Users({ session, tenantId }) {
  const basePath = tenantId ? `/platform/tenants/${tenantId}/users` : "/users";
  const data = useManagement(basePath, "users");
  const [editing, setEditing] = useState(null);
  const [messageLimit, setMessageLimit] = useState({
    enabled: false,
    limit: 10,
  });
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = (key) => (event) =>
    setForm({ ...form, [key]: event.target.value });
  function open(user = {}) {
    setMessageLimit({
      enabled: user.dailyMessageLimit != null,
      limit: user.dailyMessageLimit || 10,
    });
    setEditing(user);
    setError("");
    setForm({
      username: user.username || "",
      name: user.name || "",
      password: "",
      role: user.role || "user",
      status: user.status || "active",
    });
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {
        ...form,
        dailyMessageLimit:
          form.role === "admin" || !messageLimit.enabled
            ? null
            : messageLimit.limit,
      };
      if (!body.password) delete body.password;
      await api(editing.id ? `${basePath}/${editing.id}` : basePath, {
        method: editing.id ? "PATCH" : "POST",
        body,
      });
      setEditing(null);
      data.setSuccess(
        editing.id
          ? "用户信息已更新。"
          : "用户已创建，可使用设置的账号密码登录。"
      );
      await data.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Feedback data={data} />
      <section className="overflow-hidden rounded-lg border border-theme-sidebar-border bg-theme-bg-secondary">
        <div className="flex flex-wrap items-center justify-between gap-4 p-5 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:text-base [&_h2]:font-semibold [&_p]:mt-2 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-theme-text-secondary">
          <div>
            <h2>
              用户列表{" "}
              <span className="rounded bg-theme-sidebar-item-default px-2 py-1 text-xs font-normal text-theme-text-secondary">
                {data.items.length}
              </span>
            </h2>
            <p>
              知识访问由知识库授权决定，企业管理员角色不自动授予私有资料访问权。
            </p>
          </div>
          <div className="flex items-center gap-x-2">
            <Button icon="plus" onClick={() => open()}>
              添加用户
            </Button>
            <button
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-theme-text-secondary hover:bg-theme-action-menu-item-hover hover:text-theme-text-primary disabled:opacity-50"
              onClick={data.refresh}
              aria-label="刷新用户"
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>
        </div>
        {data.loading ? (
          <Loading />
        ) : !data.items.length ? (
          <Empty icon="users" title="暂无用户">
            添加团队用户，一起建立企业知识。
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-theme-sidebar-border [&_th]:bg-theme-sidebar-item-default [&_th]:px-5 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-theme-text-secondary [&_td]:border-b [&_td]:border-theme-sidebar-border [&_td]:px-5 [&_td]:py-4 [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-theme-sidebar-subitem-hover">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>账号</th>
                  <th>微信登录</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>注册时间</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((user) => (
                  <tr key={user.id}>
                    <td>
                      <div className="flex min-w-[120px] items-center gap-3 [&_strong]:flex [&_strong]:items-center [&_strong]:gap-2 [&_strong]:font-medium [&_small]:rounded [&_small]:bg-theme-sidebar-item-default [&_small]:px-1.5 [&_small]:py-0.5 [&_small]:text-xs [&_small]:text-theme-text-secondary">
                        <UserAvatar user={user} basePath={basePath} />
                        <strong>
                          {user.name ||
                            (user.wechatBound
                              ? `用户 #${user.id}`
                              : user.username)}
                          {String(user.id) === String(session.user.id) && (
                            <small>我</small>
                          )}
                        </strong>
                      </div>
                    </td>
                    <td className="text-theme-text-secondary">
                      {user.username}
                    </td>
                    <td className="whitespace-nowrap text-theme-text-secondary">
                      {user.wechatBound ? "已绑定" : "未绑定"}
                    </td>
                    <td>
                      <span className="inline-flex whitespace-nowrap rounded bg-theme-sidebar-item-default px-2 py-1 text-xs text-theme-text-secondary">
                        {user.role === "admin" ? "管理员" : "普通用户"}
                      </span>
                    </td>
                    <td>
                      <Status value={user.status || "active"} />
                    </td>
                    <td className="whitespace-nowrap text-theme-text-secondary">
                      {user.createdAt
                        ? new Date(user.createdAt).toLocaleString("zh-CN")
                        : "—"}
                    </td>
                    <td className="text-right">
                      <button
                        className="inline-flex items-center gap-1.5 text-sm text-primary-button hover:underline"
                        onClick={() => open(user)}
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && (
        <Modal
          title={editing.id ? "编辑用户" : "添加用户"}
          subtitle="用户归属当前租户，登录账号在当前企业内唯一。"
          onClose={() => !busy && setEditing(null)}
        >
          <form onSubmit={save}>
            <Notice>{error}</Notice>
            <Field label="显示名称">
              <input
                required
                maxLength={80}
                value={form.name}
                onChange={change("name")}
                placeholder="请输入姓名"
              />
            </Field>
            {editing.wechatBound ? (
              <Field label="登录账号" hint="微信登录账号由系统生成，不可修改。">
                <input readOnly value={editing.username} />
              </Field>
            ) : (
              <Field
                label="登录账号"
                hint="2—64 位，以小写字母开头，可包含数字或 _ . @ -"
              >
                <input
                  required
                  pattern={USERNAME_PATTERN}
                  minLength={USERNAME_MIN_LENGTH}
                  maxLength={USERNAME_MAX_LENGTH}
                  disabled={!!editing.id}
                  value={form.username}
                  onChange={change("username")}
                  placeholder="例如：zhangsan"
                  autoComplete="off"
                />
              </Field>
            )}
            <Field
              label={editing.id ? "重设密码（可选）" : "初始密码"}
              hint={
                editing.id
                  ? "留空保持原密码；新密码须符合系统密码要求。"
                  : "设置符合系统密码要求的密码，并告知用户。"
              }
            >
              <input
                type="password"
                required={!editing.id}
                value={form.password}
                onChange={change("password")}
                autoComplete="new-password"
                placeholder={editing.id ? "不修改则留空" : "请输入初始密码"}
              />
            </Field>
            <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <Field label="角色">
                <select value={form.role} onChange={change("role")}>
                  <option value="user">普通用户</option>
                  <option value="admin">租户管理员</option>
                </select>
              </Field>
              {editing.id && (
                <Field label="账号状态">
                  <select value={form.status} onChange={change("status")}>
                    <option value="active">正常</option>
                    <option value="disabled">已停用</option>
                  </select>
                </Field>
              )}
            </div>
            <MessageLimitInput
              role={form.role}
              enabled={messageLimit.enabled}
              limit={messageLimit.limit}
              updateState={setMessageLimit}
            />
            <div className="mt-6 flex justify-end gap-2 border-t border-theme-sidebar-border pt-5">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                取消
              </Button>
              <Button type="submit" busy={busy}>
                保存用户
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export function Tenants({ session }) {
  const data = useManagement("/platform/tenants", "tenants");
  const [reviewing, setReviewing] = useState(null);
  const [managingUsers, setManagingUsers] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    code: "",
    hostname: "",
    adminUsername: "",
    adminName: "",
    adminPassword: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingTenant, setEditingTenant] = useState(null);
  const [wechat, setWechat] = useState(null);
  const [wechatForm, setWechatForm] = useState({
    appId: "",
    appSecret: "",
    enabled: false,
  });
  useEffect(() => {
    setWechat(null);
    setWechatForm({ appId: "", appSecret: "", enabled: false });
    if (!open || !editingTenant) return;
    const controller = new AbortController();
    api(`/platform/tenants/${encodeURIComponent(editingTenant.id)}/wechat`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const configuration = {
          appId: result.appId || "",
          enabled: result.enabled === true,
          hasSecret: result.hasSecret === true,
        };
        setWechat(configuration);
        setWechatForm({ ...configuration, appSecret: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [open, editingTenant?.id]);
  const change = (key) => (event) =>
    setForm({
      ...form,
      [key]:
        key === "code"
          ? event.target.value.trim().toLowerCase()
          : event.target.value,
    });
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = editingTenant
        ? { name: form.name, hostname: form.hostname }
        : { ...form, code: form.code.trim().toLowerCase() };
      if (body.hostname.trim())
        body.hostname = body.hostname.trim().toLowerCase();
      else delete body.hostname;
      await api(
        editingTenant
          ? `/platform/tenants/${editingTenant.id}`
          : "/platform/tenants",
        {
          method: editingTenant ? "PATCH" : "POST",
          body,
        }
      );
      if (
        editingTenant &&
        wechat &&
        (wechatForm.appId.trim() !== wechat.appId ||
          wechatForm.enabled !== wechat.enabled ||
          wechatForm.appSecret)
      ) {
        const configuration = await api(
          `/platform/tenants/${encodeURIComponent(editingTenant.id)}/wechat`,
          {
            method: "PUT",
            body: {
              appId: wechatForm.appId.trim(),
              enabled: wechatForm.enabled,
              ...(wechatForm.appSecret
                ? { appSecret: wechatForm.appSecret }
                : {}),
            },
          }
        );
        setWechat(configuration);
        setWechatForm({ ...configuration, appSecret: "" });
      }
      setOpen(false);
      data.setSuccess(
        editingTenant
          ? "租户信息和访问域名已更新。"
          : "租户和首位管理员已创建。"
      );
      await data.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(tenant) {
    const status = tenant.status === "disabled" ? "active" : "disabled";
    if (
      !window.confirm(
        `${status === "disabled" ? "停用" : "启用"}租户“${tenant.name}”？${status === "disabled" ? "停用后该租户用户将无法继续使用平台。" : ""}`
      )
    )
      return;
    try {
      await api(`/platform/tenants/${tenant.id}`, {
        method: "PATCH",
        body: { status },
      });
      data.setSuccess("租户状态已更新。");
      await data.refresh();
    } catch (err) {
      data.setError(err.message);
    }
  }
  return (
    <>
      <Feedback data={data} />
      <section className="overflow-hidden rounded-lg border border-theme-sidebar-border bg-theme-bg-secondary">
        <div className="flex flex-wrap items-center justify-between gap-4 p-5 [&_h2]:flex [&_h2]:items-center [&_h2]:gap-2 [&_h2]:text-base [&_h2]:font-semibold [&_p]:mt-2 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-theme-text-secondary">
          <div>
            <h2>
              租户列表{" "}
              <span className="rounded bg-theme-sidebar-item-default px-2 py-1 text-xs font-normal text-theme-text-secondary">
                {data.items.length}
              </span>
            </h2>
            <p>平台管理员负责组织的开通及使用状态。</p>
          </div>
          <div className="flex items-center gap-x-2">
            <Button
              icon="plus"
              onClick={() => {
                setEditingTenant(null);
                setOpen(true);
                setError("");
                setForm({
                  name: "",
                  code: "",
                  hostname: "",
                  adminUsername: "",
                  adminName: "",
                  adminPassword: "",
                });
              }}
            >
              创建租户
            </Button>
            <button
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-theme-text-secondary hover:bg-theme-action-menu-item-hover hover:text-theme-text-primary disabled:opacity-50"
              onClick={data.refresh}
              aria-label="刷新租户"
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>
        </div>
        {data.loading ? (
          <Loading />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-theme-sidebar-border [&_th]:bg-theme-sidebar-item-default [&_th]:px-5 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-theme-text-secondary [&_td]:border-b [&_td]:border-theme-sidebar-border [&_td]:px-5 [&_td]:py-4 [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-theme-sidebar-subitem-hover">
              <thead>
                <tr>
                  <th>租户名称</th>
                  <th>访问域名</th>
                  <th>状态</th>
                  <th className="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((tenant) => (
                  <tr key={tenant.id}>
                    <td>
                      <div className="flex min-w-[120px] items-center gap-3 [&_strong]:flex [&_strong]:items-center [&_strong]:gap-2 [&_strong]:font-medium [&_small]:rounded [&_small]:bg-theme-sidebar-item-default [&_small]:px-1.5 [&_small]:py-0.5 [&_small]:text-xs [&_small]:text-theme-text-secondary">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-theme-sidebar-item-default text-theme-text-secondary">
                          <Icon name="building" size={19} />
                        </span>
                        <strong>{tenant.name}</strong>
                      </div>
                    </td>
                    <td className="text-theme-text-secondary max-w-[220px] break-all font-mono text-xs">
                      {tenant.webURL ? (
                        <a
                          className="text-primary-button hover:underline"
                          href={tenant.webURL}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {tenant.webHost}
                        </a>
                      ) : (
                        tenant.hostname
                      )}
                    </td>
                    <td>
                      <Status value={tenant.status || "active"} />
                    </td>
                    <td className="text-right">
                      <button
                        className="mr-4 text-sm text-primary-button hover:underline"
                        onClick={() => setManagingUsers(tenant)}
                      >
                        用户管理
                      </button>
                      <a
                        className="mr-4 text-sm text-primary-button hover:underline"
                        href={`/settings/retrieval-preference?tenantId=${encodeURIComponent(tenant.id)}`}
                      >
                        企业配置
                      </a>
                      <button
                        className="mr-4 inline-flex items-center gap-1.5 text-sm text-primary-button hover:underline"
                        onClick={() => setReviewing(tenant)}
                      >
                        查看内容
                      </button>
                      <button
                        className="mr-4 inline-flex items-center gap-1.5 text-sm text-primary-button hover:underline"
                        onClick={() => {
                          setEditingTenant(tenant);
                          setForm({
                            name: tenant.name,
                            code: tenant.code,
                            hostname: tenant.hostname,
                          });
                          setError("");
                          setOpen(true);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        className={`inline-flex items-center gap-1.5 text-sm text-primary-button hover:underline ${tenant.status === "disabled" ? "" : "text-red-400 light:text-red-700"}`}
                        onClick={() => toggle(tenant)}
                      >
                        {tenant.status === "disabled" ? "启用" : "停用"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {reviewing && (
        <TenantContent tenant={reviewing} onClose={() => setReviewing(null)} />
      )}
      {managingUsers && (
        <Modal
          title={`${managingUsers.name} · 用户管理`}
          onClose={() => setManagingUsers(null)}
        >
          <Users session={session} tenantId={managingUsers.id} />
        </Modal>
      )}
      {open && (
        <Modal
          title={editingTenant ? "编辑租户" : "创建租户"}
          subtitle={
            editingTenant
              ? "每个租户使用一个独立域名，变更后旧域名立即失效。"
              : "同时创建该租户的首位管理员，后续由其管理团队。"
          }
          onClose={() => !busy && setOpen(false)}
        >
          <form onSubmit={save}>
            <Notice>{error}</Notice>
            <Field label="租户名称">
              <input
                required
                maxLength={80}
                value={form.name}
                onChange={change("name")}
                placeholder="请输入组织名称"
              />
            </Field>
            <Field
              label="租户标识"
              hint="内部标识，3—40 位小写英文、数字或短横线，以英文或数字开头和结尾，创建后不可修改。"
            >
              <input
                required
                minLength={3}
                maxLength={40}
                pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
                value={form.code}
                disabled={!!editingTenant}
                onChange={change("code")}
                placeholder="例如：qinghe"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field
              label={editingTenant ? "访问域名" : "完整域名（可选）"}
              hint={
                editingTenant
                  ? "租户唯一访问域名，例如 knowledge.example.com。"
                  : "例如 knowledge.example.com；留空由平台生成并登记访问域名。"
              }
            >
              <input
                required={!!editingTenant}
                maxLength={253}
                value={form.hostname}
                onChange={change("hostname")}
                placeholder="例如：knowledge.example.com"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            {editingTenant && wechat && (
              <>
                <Field label="微信小程序 AppID">
                  <input
                    value={wechatForm.appId}
                    onChange={(event) =>
                      setWechatForm({
                        ...wechatForm,
                        appId: event.target.value,
                      })
                    }
                    autoComplete="off"
                  />
                </Field>
                <Field
                  label="微信小程序 AppSecret"
                  hint={
                    wechat.hasSecret
                      ? "已配置密钥；留空保留原密钥。"
                      : "密钥仅在服务端用于微信登录，不会返回客户端。"
                  }
                >
                  <input
                    type="password"
                    value={wechatForm.appSecret}
                    onChange={(event) =>
                      setWechatForm({
                        ...wechatForm,
                        appSecret: event.target.value,
                      })
                    }
                    autoComplete="new-password"
                  />
                </Field>
                <Field label="微信登录">
                  <select
                    value={wechatForm.enabled ? "enabled" : "disabled"}
                    onChange={(event) =>
                      setWechatForm({
                        ...wechatForm,
                        enabled: event.target.value === "enabled",
                      })
                    }
                  >
                    <option value="disabled">未启用</option>
                    <option value="enabled">启用</option>
                  </select>
                </Field>
              </>
            )}
            {!editingTenant && (
              <>
                <Field label="管理员姓名">
                  <input
                    required
                    maxLength={80}
                    value={form.adminName}
                    onChange={change("adminName")}
                    placeholder="请输入管理员姓名"
                  />
                </Field>
                <Field
                  label="管理员账号"
                  hint="2—64 位，以小写字母开头，可包含数字或 _ . @ -，当前企业内唯一。"
                >
                  <input
                    required
                    pattern={USERNAME_PATTERN}
                    minLength={USERNAME_MIN_LENGTH}
                    maxLength={USERNAME_MAX_LENGTH}
                    value={form.adminUsername}
                    onChange={change("adminUsername")}
                    autoComplete="off"
                    placeholder="设置登录账号"
                  />
                </Field>
                <Field label="管理员初始密码">
                  <input
                    type="password"
                    required
                    value={form.adminPassword}
                    onChange={change("adminPassword")}
                    autoComplete="new-password"
                    placeholder="设置符合系统密码要求的密码"
                  />
                </Field>
              </>
            )}
            <div className="mt-6 flex justify-end gap-2 border-t border-theme-sidebar-border pt-5">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" busy={busy}>
                {editingTenant ? "保存修改" : "创建租户"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function TenantContent({ tenant, onClose }) {
  const [libraries, setLibraries] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [selection, setSelection] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const query = `?tenantId=${encodeURIComponent(tenant.id)}`;
    Promise.all([
      api(`/platform/libraries${query}`, { signal: controller.signal }),
      api(`/platform/conversations${query}`, { signal: controller.signal }),
    ])
      .then(([knowledge, chats]) => {
        setLibraries(knowledge.libraries || []);
        setConversations(chats.conversations || []);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      request.current++;
    };
  }, [tenant.id]);
  async function select(kind, item) {
    const generation = ++request.current;
    setSelection({ kind, item });
    setDetail(null);
    setDocuments([]);
    setError("");
    setLoading(true);
    try {
      const value = await api(
        kind === "library"
          ? `/platform/documents?tenantId=${encodeURIComponent(tenant.id)}&libraryId=${encodeURIComponent(item.id)}`
          : `/platform/conversations/${encodeURIComponent(item.id)}`
      );
      if (generation !== request.current) return;
      if (kind === "library") setDocuments(value.documents || []);
      else setDetail(value);
    } catch (err) {
      if (generation === request.current) setError(err.message);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }
  async function openDocument(item) {
    const generation = ++request.current;
    setError("");
    setLoading(true);
    try {
      const value = await api(
        `/platform/documents/${encodeURIComponent(item.id)}`
      );
      if (generation === request.current) setDetail(value);
    } catch (err) {
      if (generation === request.current) setError(err.message);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }
  return (
    <Modal
      title={`${tenant.name} · 内容查看`}
      subtitle="顶级管理员可查看企业知识与个人会话。"
      onClose={onClose}
      wide
    >
      <Notice onClose={() => setError("")}>{error}</Notice>
      <div className="flex flex-wrap gap-3">
        <Field label="知识库">
          <select
            value={selection?.kind === "library" ? selection.item.id : ""}
            onChange={(event) => {
              const item = libraries.find(
                (library) => library.id === event.target.value
              );
              if (item) select("library", item);
            }}
          >
            <option value="">选择知识库</option>
            {libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="个人会话">
          <select
            value={selection?.kind === "conversation" ? selection.item.id : ""}
            onChange={(event) => {
              const item = conversations.find(
                (conversation) => conversation.id === event.target.value
              );
              if (item) select("conversation", item);
            }}
          >
            <option value="">选择会话</option>
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title} · {conversation.userId}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {loading ? (
        <Loading />
      ) : (
        <>
          {!selection && (
            <Empty title="选择知识库或个人会话">仅展示当前企业的内容。</Empty>
          )}
          {selection?.kind === "library" && (
            <div className="flex flex-col gap-2">
              {documents.length ? (
                documents.map((document) => (
                  <div
                    key={document.id}
                    className="flex items-center justify-between gap-3"
                  >
                    <button
                      className="text-sm text-primary-button hover:underline"
                      onClick={() => openDocument(document)}
                    >
                      {document.title}
                    </button>
                    {document.hasOriginal && (
                      <button
                        className="text-sm text-primary-button hover:underline"
                        onClick={async () => {
                          try {
                            await downloadDocument(
                              document.id,
                              document.title,
                              { platform: true }
                            );
                          } catch (err) {
                            setError(err.message);
                          }
                        }}
                      >
                        下载原件
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <Empty title="暂无资料" />
              )}
            </div>
          )}
          {detail?.document && (
            <div className="mt-4 border-t border-theme-sidebar-border pt-4">
              <h3 className="mb-3 font-medium">{detail.document.title}</h3>
              <Markdown>
                {detail.document.content || "此资料未提供文本预览。"}
              </Markdown>
            </div>
          )}
          {detail?.messages && (
            <div className="flex flex-col gap-4">
              {detail.messages.map((message) => (
                <div
                  key={message.id}
                  className="border-b border-theme-sidebar-border pb-4"
                >
                  <p className="mb-2 text-xs text-theme-text-secondary">
                    {message.role === "user" ? "用户" : "助手"}
                  </p>
                  <Markdown>{message.content || ""}</Markdown>
                  {!!message.sources?.length && (
                    <p className="mt-2 text-xs text-theme-text-secondary">
                      来源：
                      {message.sources
                        .map((source) => source.title)
                        .filter(Boolean)
                        .join("、")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
