import { useEffect, useState } from "react";
import { api, savedSession } from "@/models/platform";
import { ModalLabel, ModalHint } from "@/components/lib/Modal";

const selectClass =
  "min-w-[15rem] rounded-lg bg-zinc-800 light:bg-white border border-zinc-800 light:border-slate-300 px-4 py-2 text-sm text-zinc-100 light:text-slate-900";

export function TenantSelection({ value, onChange }) {
  const [tenants, setTenants] = useState([]);
  const [error, setError] = useState(null);
  const platform = savedSession()?.identity === "platform";
  useEffect(() => {
    if (!platform) return;
    api("/platform/tenants")
      .then((result) => setTenants(result.tenants || []))
      .catch((error) => setError(error.message));
  }, [platform]);
  if (!platform) return null;
  return (
    <div className="flex flex-col gap-y-2">
      <ModalLabel htmlFor="target-tenant">企业</ModalLabel>
      <select
        id="target-tenant"
        name="tenantId"
        value={value || ""}
        required
        onChange={(event) => onChange(event.target.value)}
        className={selectClass}
      >
        <option value="">请选择企业</option>
        {tenants.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.name}
          </option>
        ))}
      </select>
      {error && <p className="text-red-400 text-sm">{error}</p>}
    </div>
  );
}

export default function ExecutionIdentity({ value, onChange }) {
  const session = savedSession();
  const platform = session?.identity === "platform";
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const tenantId = value.tenantId || (platform ? "" : session?.tenant?.id);
  useEffect(() => {
    setUsers([]);
    if (!tenantId) return;
    api(
      platform
        ? `/platform/tenants/${encodeURIComponent(tenantId)}/users`
        : "/users"
    )
      .then((result) =>
        setUsers(
          (result.users || []).filter((user) => user.status === "active")
        )
      )
      .catch((error) => setError(error.message));
  }, [tenantId, platform]);
  return (
    <>
      <TenantSelection
        value={tenantId}
        onChange={(id) => onChange({ tenantId: id, userId: "" })}
      />
      <div className="flex flex-col gap-y-2">
        <ModalLabel htmlFor="execution-user">执行用户</ModalLabel>
        <select
          id="execution-user"
          name="userId"
          required
          value={value.userId || ""}
          onChange={(event) =>
            onChange({ tenantId, userId: event.target.value })
          }
          className={selectClass}
        >
          <option value="">请选择执行用户</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.username}
            </option>
          ))}
        </select>
        <ModalHint>
          凭据固定属于该企业和用户，使用此用户当时有效的知识与操作权限。
        </ModalHint>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    </>
  );
}
