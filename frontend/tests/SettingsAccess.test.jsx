import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import PrivateRoute, {
  AdminRoute,
  PlatformRoute,
  TenantAdminRoute,
} from "../src/components/PrivateRoute";

const SettingsPage = () => <div>原版设置</div>;

function route(Guard, session) {
  render(
    <MemoryRouter initialEntries={["/settings/test"]}>
      <Routes>
        <Route element={<Outlet context={session} />}>
          <Route
            path="/settings/test"
            element={<Guard Component={SettingsPage} />}
          />
        </Route>
        <Route path="/" element={<div>产品首页</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe("settings use the host-validated enterprise identity from App", () => {
  it.each([
    [PrivateRoute, { identity: "platform", role: "platform_admin" }, true],
    [PrivateRoute, { identity: "tenant", role: "admin" }, true],
    [PrivateRoute, { identity: "tenant", role: "user" }, true],
    [AdminRoute, { identity: "platform", role: "platform_admin" }, true],
    [AdminRoute, { identity: "tenant", role: "admin" }, true],
    [AdminRoute, { identity: "tenant", role: "user" }, false],
    [PlatformRoute, { identity: "platform", role: "platform_admin" }, true],
    [PlatformRoute, { identity: "tenant", role: "admin" }, false],
    [PlatformRoute, { identity: "tenant", role: "user" }, false],
    [AdminRoute, { role: "admin" }, false],
    [PlatformRoute, { identity: "unknown", role: "admin" }, false],
    [PrivateRoute, null, false],
    [TenantAdminRoute, { identity: "platform", role: "platform_admin" }, false],
    [TenantAdminRoute, { identity: "tenant", role: "admin" }, true],
    [TenantAdminRoute, { identity: "tenant", role: "user" }, false],
  ])(
    "applies the requested scope without upstream single-user bypass (%#)",
    (Guard, session, allowed) => {
      route(Guard, session);
      expect(
        screen.getByText(allowed ? "原版设置" : "产品首页")
      ).toBeInTheDocument();
      expect(
        screen.queryByText(allowed ? "产品首页" : "原版设置")
      ).not.toBeInTheDocument();
    }
  );
});
