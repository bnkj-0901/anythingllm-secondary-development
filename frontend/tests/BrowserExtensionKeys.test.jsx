import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BrowserExtensionApiKeys from "../src/pages/GeneralSettings/BrowserExtensionApiKey";
import BrowserExtensionApiKey from "../src/models/browserExtensionApiKey";

const identity = vi.hoisted(() => ({
  user: { identity: "tenant", role: "user" },
}));
vi.mock("../src/hooks/useUser", () => ({ default: () => identity }));
vi.mock("../src/components/SettingsSidebar", () => ({ default: () => null }));
vi.mock("../src/models/browserExtensionApiKey", () => ({
  default: { getAll: vi.fn() },
}));
vi.mock(
  "../src/pages/GeneralSettings/BrowserExtensionApiKey/NewBrowserExtensionApiKeyModal",
  () => ({ default: () => <div>Execution identity selection</div> })
);

beforeEach(() => {
  identity.user = { identity: "tenant", role: "user" };
  vi.mocked(BrowserExtensionApiKey.getAll)
    .mockReset()
    .mockResolvedValue({ success: true, apiKeys: [] });
});

describe("browser extension management authority", () => {
  it("keeps a user's own connection listing without offering administrator key generation", async () => {
    render(<BrowserExtensionApiKeys />);
    expect(await screen.findByText("No API keys found")).toBeInTheDocument();
    expect(BrowserExtensionApiKey.getAll).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Generate New API Key" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Execution identity selection")
    ).not.toBeInTheDocument();
  });

  it.each([
    { identity: "tenant", role: "admin" },
    { identity: "platform", role: "platform_admin" },
  ])(
    "allows administrators to open execution identity selection (%#)",
    async (user) => {
      identity.user = user;
      render(<BrowserExtensionApiKeys />);
      await screen.findByText("No API keys found");
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Generate New API Key" }));
      expect(
        screen.getByText("Execution identity selection")
      ).toBeInTheDocument();
    }
  );
});
