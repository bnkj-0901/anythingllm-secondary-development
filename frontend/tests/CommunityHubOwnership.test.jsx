import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import SystemPrompt from "../src/pages/GeneralSettings/CommunityHub/ImportItem/Steps/PullAndReview/HubItem/SystemPrompt";
import SlashCommand from "../src/pages/GeneralSettings/CommunityHub/ImportItem/Steps/PullAndReview/HubItem/SlashCommand";
import CommunityHub from "../src/models/communityHub";

vi.mock("../src/models/communityHub", () => ({
  default: { applyItem: vi.fn() },
}));
vi.mock("../src/utils/toast", () => ({ default: vi.fn() }));
vi.mock("../src/pages/GeneralSettings/CommunityHub/ImportItem/Steps", () => ({
  default: { completed: { key: "completed" } },
}));
vi.mock("../src/components/lib/ExecutionIdentity", () => ({
  TenantSelection: ({ value, onChange }) => (
    <select
      aria-label="Tenant"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Choose</option>
      <option value="company">Company</option>
    </select>
  ),
  default: ({ value, onChange }) => (
    <button onClick={() => onChange({ tenantId: "company", userId: "person" })}>
      Choose user {value.userId}
    </button>
  ),
}));
beforeEach(() =>
  vi
    .mocked(CommunityHub.applyItem)
    .mockReset()
    .mockResolvedValue({ success: true, error: null })
);
it("applies a Hub system prompt to the chosen tenant without a Workspace destination", async () => {
  const done = vi.fn();
  render(
    <SystemPrompt
      item={{ name: "Prompt", importId: "hub-prompt", prompt: "Instructions" }}
      setStep={done}
    />
  );
  expect(
    screen.queryByRole("button", { name: "Apply system prompt to tenant" })
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Tenant"), {
    target: { value: "company" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Apply system prompt to tenant" })
  );
  await waitFor(() =>
    expect(CommunityHub.applyItem).toHaveBeenCalledWith("hub-prompt", {
      tenantId: "company",
    })
  );
  expect(done).toHaveBeenCalledWith("completed");
});
it("requires an explicit enterprise user before importing a personal preset", async () => {
  const done = vi.fn();
  render(
    <SlashCommand
      item={{
        name: "Report",
        importId: "hub-slash",
        command: "/report",
        prompt: "Prepare a report",
      }}
      setStep={done}
    />
  );
  expect(
    screen.getByRole("button", { name: "Import slash command" })
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Choose user" }));
  fireEvent.click(screen.getByRole("button", { name: "Import slash command" }));
  await waitFor(() =>
    expect(CommunityHub.applyItem).toHaveBeenCalledWith("hub-slash", {
      tenantId: "company",
      userId: "person",
    })
  );
  expect(done).toHaveBeenCalledWith("completed");
});
