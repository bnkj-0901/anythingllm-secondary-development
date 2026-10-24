import { Navigate, useOutletContext } from "react-router-dom";
import paths from "@/utils/paths";

// App validates the enterprise session against the current host before mounting
// its outlet. Settings use that identity, never the upstream single-user bypass
// or a second global user session.
function SettingsRoute({ Component, scope = "personal" }) {
  const session = useOutletContext();
  const isPlatform = session?.identity === "platform";
  const isTenantAdmin =
    session?.identity === "tenant" && session.role === "admin";
  const authenticated = isPlatform || session?.identity === "tenant";
  const allowed =
    authenticated &&
    (scope === "personal" ||
      (isPlatform && scope !== "tenant-admin") ||
      (scope === "tenant-admin" && isTenantAdmin) ||
      (scope === "admin" && isTenantAdmin));

  return allowed ? <Component /> : <Navigate to={paths.home()} replace />;
}

export function PlatformRoute({ Component }) {
  return <SettingsRoute Component={Component} scope="platform" />;
}

export function AdminRoute({ Component }) {
  return <SettingsRoute Component={Component} scope="admin" />;
}

export function TenantAdminRoute({ Component }) {
  return <SettingsRoute Component={Component} scope="tenant-admin" />;
}

export default function PrivateRoute({ Component }) {
  return <SettingsRoute Component={Component} />;
}
