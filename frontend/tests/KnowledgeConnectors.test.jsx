import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import Knowledge from "../src/pages/Knowledge";
import YoutubeOptions from "../src/components/Modals/ManageWorkspace/DataConnectors/Connectors/Youtube";
import { api } from "../src/models/platform";
import System from "../src/models/system";
vi.mock("../src/models/platform", () => ({
  api: vi.fn(),
  downloadDocument: vi.fn(),
  downloadResource: vi.fn(),
}));
vi.mock("../src/utils/toast", () => ({ default: vi.fn() }));
vi.mock("../src/models/system", () => ({
  default: { dataConnectors: { youtube: { transcribe: vi.fn() } } },
}));
vi.mock("../src/components/Modals/ManageWorkspace/DataConnectors", () => ({
  default: ({ onImport }) => (
    <button
      onClick={() =>
        onImport("obsidian", {
          files: [
            { name: "Note.md", path: "Vault/Note.md", content: "Note body" },
          ],
        })
      }
    >
      Import original notes
    </button>
  ),
}));
let pending;
beforeEach(() => {
  pending = false;
  vi.mocked(System.dataConnectors.youtube.transcribe)
    .mockReset()
    .mockResolvedValue({
      data: { title: "Video", author: "Author", destination: "legacy" },
      error: null,
    });
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path === "/file-types")
        return { extensions: [".txt"], maxFileSizeBytes: 10000 };
      if (path === "/platform/tenants") return { tenants: [] };
      if (path.endsWith("/libraries"))
        return {
          libraries: [
            {
              id: "library",
              name: "Chosen library",
              visibility: "private",
              canWrite: true,
            },
          ],
        };
      if (path.endsWith("/documents")) return { documents: [] };
      if (path.endsWith("/knowledge-changes"))
        return { changes: [], canReview: false };
      if (path.endsWith("/data-connectors/import"))
        return { data: { imported: 1, approvalRequired: pending } };
      throw new Error(path);
    });
});
it.each([false, true])(
  "Knowledge routes original connector output to its selected library; platform=%s",
  async (platform) => {
    pending = platform;
    render(
      <Knowledge
        session={{
          identity: platform ? "platform" : "tenant",
          user: { id: "owner" },
        }}
      />
    );
    await screen.findByRole("button", { name: "上传文件" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "数据连接器" })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "数据连接器" }));
    await screen.findByRole("dialog", { name: "导入到知识库" });
    fireEvent.click(
      screen.getByRole("button", { name: "Import original notes" })
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        `${platform ? "/platform" : ""}/data-connectors/import`,
        {
          method: "POST",
          body: {
            libraryId: "library",
            connector: "obsidian",
            args: {
              files: [
                {
                  name: "Note.md",
                  path: "Vault/Note.md",
                  content: "Note body",
                },
              ],
            },
          },
        }
      )
    );
    await screen.findByText(
      platform
        ? "1 份资料已提交管理员审批，批准前不会公开。"
        : "1 份资料已导入私有知识库并开始建立索引。"
    );
  }
);
it("an original connector form forwards its original arguments to the new ownership callback", async () => {
  const onImport = vi
    .fn()
    .mockResolvedValue({
      data: { message: "Submitted for review" },
      error: null,
    });
  const { container } = render(<YoutubeOptions onImport={onImport} />);
  const input = container.querySelector('[name="url"]');
  fireEvent.change(input, {
    target: { value: "https://youtube.com/watch?v=fixture" },
  });
  fireEvent.submit(container.querySelector("form"));
  await waitFor(() =>
    expect(onImport).toHaveBeenCalledWith({
      url: "https://youtube.com/watch?v=fixture",
    })
  );
  expect(System.dataConnectors.youtube.transcribe).not.toHaveBeenCalled();
});
it("an original connector form retains its default caller when no ownership callback is supplied", async () => {
  const { container } = render(<YoutubeOptions />);
  fireEvent.change(container.querySelector('[name="url"]'), {
    target: { value: "https://youtube.com/watch?v=fixture" },
  });
  fireEvent.submit(container.querySelector("form"));
  await waitFor(() =>
    expect(System.dataConnectors.youtube.transcribe).toHaveBeenCalledWith({
      url: "https://youtube.com/watch?v=fixture",
    })
  );
});
