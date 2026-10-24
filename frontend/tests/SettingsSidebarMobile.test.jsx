import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "../src/AuthContext";
import { LogoContext } from "../src/LogoContext";
import SettingsSidebar from "../src/components/SettingsSidebar";
import System from "../src/models/system";
import i18n from "../src/i18n";

vi.mock("react-device-detect", () => ({ isMobile: true, isDesktop: false }));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(System, "fetchSupportEmail").mockResolvedValue({ email: "support@example.test" });
  vi.spyOn(System, "fetchAppVersion").mockResolvedValue("1.0.0");
  vi.spyOn(System, "fetchCustomFooterIcons").mockResolvedValue({ footerData: [] });
});

function sidebar(identity = "tenant", role = "user") {
  return render(
    <MemoryRouter initialEntries={["/settings/chat"]}>
      <AuthContext.Provider value={{ store: { user: { identity, role, username: "alice" } } }}>
        <LogoContext.Provider value={{ logo: "tenant-logo.png" }}>
          <SettingsSidebar />
        </LogoContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe("original mobile settings navigation", () => {
  it("opens and dismisses the mobile drawer while retaining personal settings and support", async () => {
    const { container } = sidebar();
    const drawer = container.querySelector("div[style*='translateX']");
    expect(drawer.style.transform).toBe("translateX(-100vw)");
    fireEvent.click(container.querySelector("button"));
    await waitFor(() => expect(drawer.style.transform).toBe("translateX(0vw)"));
    await waitFor(() => expect(drawer.firstElementChild.className).toContain("opacity-1"));
    const contact = await screen.findByRole("link", { name: i18n.t("settings.contact") });
    expect(contact).toHaveAttribute("href", "mailto:support@example.test");
    expect(screen.getAllByAltText("Logo").every((node) => node.getAttribute("src") === "tenant-logo.png")).toBe(true);
    if (!screen.queryByRole("link", { name: i18n.t("settings.interface"), exact: true }))
      fireEvent.click(screen.getByRole("link", { name: i18n.t("settings.customization"), exact: true }));
    expect(screen.getByRole("link", { name: i18n.t("settings.interface"), exact: true })).toHaveAttribute("href", "/settings/interface");
    expect(screen.getByRole("link", { name: i18n.t("settings.chat"), exact: true })).toHaveAttribute("href", "/settings/chat");
    expect(screen.queryByRole("link", { name: i18n.t("settings.privacy"), exact: true })).not.toBeInTheDocument();
    fireEvent.click(drawer.firstElementChild);
    await waitFor(() => expect(drawer.style.transform).toBe("translateX(-100vw)"));
    expect(drawer.firstElementChild.className).toContain("opacity-0");
  });

  it("shows platform provider settings and privacy in the same mobile menu", async () => {
    const { container } = sidebar("platform", "platform_admin");
    fireEvent.click(container.querySelector("button"));
    await screen.findByText("v1.0.0");
    fireEvent.click(screen.getByRole("link", { name: i18n.t("settings.ai-providers"), exact: true }));
    expect(screen.getByRole("link", { name: i18n.t("settings.llm"), exact: true })).toHaveAttribute("href", "/settings/llm-preference");
    expect(screen.getByRole("link", { name: i18n.t("settings.privacy"), exact: true })).toHaveAttribute("href", "/settings/privacy");
  });
});
