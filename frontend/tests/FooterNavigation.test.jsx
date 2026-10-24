import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import Footer from "../src/components/Footer";
import { TenantFooter } from "../src/components/Sidebar/TenantNavigation";
import System from "../src/models/system";

vi.mock("react-device-detect", () => ({ isMobile: true }));
beforeEach(() => {
  vi.spyOn(System, "fetchCustomFooterIcons").mockResolvedValue({
    footerData: [{ icon: "Globe", url: "https://help.example.com" }],
  });
});

describe("original footer branding and settings navigation on mobile", () => {
  it("retains the original mobile default when no override is requested", async () => {
    render(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>
    );
    await screen.findByRole("link", { name: "" });
    expect(
      screen.queryByRole("link", { name: "Settings" })
    ).not.toBeInTheDocument();
  });

  it.each([
    { identity: "platform", role: "platform_admin" },
    { identity: "tenant", role: "admin" },
    { identity: "tenant", role: "user" },
  ])(
    "keeps branded links and a guarded settings entrance for $identity $role",
    async (identity) => {
      const navigate = vi.fn();
      render(
        <MemoryRouter>
          <TenantFooter
            session={{ ...identity, user: { username: "alice" } }}
            navigate={navigate}
            onLogout={vi.fn()}
          />
        </MemoryRouter>
      );
      const link = await screen.findByRole("link", { name: "Settings" });
      expect(
        document.querySelector('a[href="https://help.example.com"]')
      ).toBeInTheDocument();
      expect(link).toHaveAttribute("href", "/settings/interface");
      fireEvent.click(link);
      expect(navigate).toHaveBeenCalledWith("/settings/interface");
      navigate.mockClear();
      const browserAction = vi.fn((event) => {
        expect(event.defaultPrevented).toBe(false);
        event.preventDefault();
      });
      document.addEventListener("click", browserAction, { once: true });
      fireEvent.click(link, { ctrlKey: true });
      expect(browserAction).toHaveBeenCalledOnce();
      expect(navigate).not.toHaveBeenCalled();
    }
  );
});
