import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import Knowledge from "../src/pages/Knowledge";
import { api, downloadDocument } from "../src/models/platform";

vi.mock("../src/models/platform", () => ({
  api: vi.fn(),
  downloadDocument: vi.fn(),
  downloadResource: vi.fn(),
}));
let failTypes;
beforeEach(() => {
  vi.mocked(api).mockReset();
  failTypes = false;
  vi.mocked(api).mockImplementation(async (path, options = {}) => {
    if (path === "/knowledge-changes") return {changes:[],canReview:false};
    if (path === "/file-types") {
      if (failTypes) throw new Error("unavailable");
      return { extensions: [".xlsx", ".pptx", ".org"], maxFileSizeBytes: 8 };
    }
    if (path === "/libraries")
      return {
        libraries: [{ id: "l", name: "Policies", visibility: "public" }],
      };
    if (path === "/documents") return { documents: [] };
    if (path === "/documents/upload" && options.method === "POST") return {};
    throw new Error(`Unexpected ${path}`);
  });
});
async function upload() {
  render(<Knowledge />);
  await screen.findByText("Policies");
  fireEvent.click(screen.getByRole("button", { name: /上传文件/ }));
  return screen.getByLabelText("选择上传文件");
}
describe("server-owned upload capabilities", () => {
  it("queues a batch, keeps successful items and retries only a failed file in its original library", async () => {
    const input = await upload();
    const original = vi.mocked(api).getMockImplementation();
    let fail = true;
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (
        path === "/documents/upload" &&
        options.body.get("file").name === "two.xlsx" &&
        fail
      )
        throw new Error("temporary upload failure");
      return original(path, options);
    });
    fireEvent.change(input, {
      target: {
        files: [new File(["one"], "one.xlsx"), new File(["two"], "two.xlsx")],
      },
    });
    await screen.findByText("two.xlsx");
    fireEvent.submit(input.closest("form"));
    await screen.findByRole("button", { name: "重试上传 two.xlsx" });
    expect(screen.getByText("one.xlsx")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重试上传 two.xlsx" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "重试上传 two.xlsx" })
      ).not.toBeInTheDocument()
    );
    const uploads = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path === "/documents/upload");
    expect(uploads).toHaveLength(3);
    expect(uploads.map(([, options]) => options.body.get("file").name)).toEqual(
      ["one.xlsx", "two.xlsx", "two.xlsx"]
    );
    expect(
      uploads.every(([, options]) => options.body.get("libraryId") === "l")
    ).toBe(true);
  });
  it("adds drag-and-drop files to the same queue and removes entries before upload", async () => {
    const input = await upload();
    const file = new File(["one"], "dropped.xlsx");
    await act(async () =>
      fireEvent.drop(screen.getByLabelText("资料拖放区"), {
        dataTransfer: {
          files: [file],
          items: [{ kind: "file", type: "", getAsFile: () => file }],
          types: ["Files"],
        },
      })
    );
    await screen.findByText("dropped.xlsx");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "bad.exe")] },
    });
    await screen.findByText("bad.exe");
    fireEvent.click(screen.getByRole("button", { name: "移除上传 bad.exe" }));
    expect(screen.queryByText("bad.exe")).not.toBeInTheDocument();
    fireEvent.submit(input.closest("form"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/documents/upload", expect.anything())
    );
  });
  it("shows the server presets without restricting the picker or rejecting unknown text formats", async () => {
    const input = await upload();
    await waitFor(() => expect(input).toHaveAttribute("accept", ""));
    fireEvent.change(input, {
      target: { files: [new File(["data"], "guide.customtext")] },
    });
    await screen.findByText("guide.customtext");
    expect(screen.getByText(/其他文字文件由解析服务识别/)).toBeInTheDocument();
    fireEvent.submit(input.closest("form"));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/documents/upload",
        expect.objectContaining({ method: "POST", body: expect.any(FormData) })
      )
    );
    const [, options] = vi
      .mocked(api)
      .mock.calls.find(([path]) => path === "/documents/upload");
    expect(options.body.get("file").name).toBe("guide.customtext");
  });
  it.each(["recording.mp3", "recording.wav", "meeting.mp4", "meeting.mov"])(
    "sends the original audio/video format %s to the document processor",
    async (name) => {
      const input = await upload();
      fireEvent.change(input, {
        target: { files: [new File(["audio"], name)] },
      });
      await screen.findByText(name);
      fireEvent.submit(input.closest("form"));
      await waitFor(() =>
        expect(api).toHaveBeenCalledWith("/documents/upload", expect.anything())
      );
      const [, options] = vi
        .mocked(api)
        .mock.calls.find(([path]) => path === "/documents/upload");
      expect(options.body.get("file").name).toBe(name);
    }
  );
  it.each([["file.xlsx", "123456789", "大小限制"]])(
    "rejects %s before submitting it",
    async (name, content, reason) => {
      const input = await upload();
      fireEvent.change(input, {
        target: { files: [new File([content], name)] },
      });
      await screen.findByText(name);
      fireEvent.submit(input.closest("form"));
      expect(await screen.findByRole("alert")).toHaveTextContent(reason);
      expect(api).not.toHaveBeenCalledWith(
        "/documents/upload",
        expect.anything()
      );
    }
  );
  it("disables file selection if the supported-type request failed", async () => {
    failTypes = true;
    const input = await upload();
    expect(input).toBeDisabled();
    expect(screen.getByText(/无法读取支持的文件格式/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传并处理" })).toBeDisabled();
    failTypes = false;
    fireEvent.click(screen.getByRole("button", { name: "重试读取文件格式" }));
    await waitFor(() => expect(input).not.toBeDisabled());
  });
});

describe("knowledge library permissions and document management", () => {
  let libraries, documents, failure;
  beforeEach(() => {
    libraries = [
      { id: "public", name: "Company", visibility: "public" },
      { id: "private", name: "My notes", visibility: "private" },
    ];
    documents = [
      { id: "doc", libraryId: "public", title: "Policy file", inputType: "file", visibility: "public", status: "failed", error: "parse failed", content: "Current source" },
      { id: "note", libraryId: "private", title: "Private note", inputType: "text", visibility: "private", status: "ready", content: "My own note" },
    ];
    failure = null;
    vi.mocked(downloadDocument).mockReset().mockResolvedValue(undefined);
    vi.mocked(api).mockImplementation(async (path, options = {}) => {
      if (path === "/knowledge-changes") return {changes:[],canReview:false};
      if (path === "/file-types") return { extensions: [".xlsx"], maxFileSizeBytes: 1000 };
      if (failure) throw new Error(failure);
      if (options.method) {
        if (path === "/libraries") return { library: { id: "new-library" } };
        return {};
      }
      if (path === "/libraries") return { libraries };
      if (path === "/documents") return { documents };
      if (path.startsWith("/documents/")) return { document: documents.find((doc) => path === `/documents/${doc.id}`) };
      throw new Error(path);
    });
  });
  async function page() { render(<Knowledge />); await screen.findByText("Policy file"); return userEvent.setup(); }
  it("filters public and own private libraries, searches titles and resets a selected library", async () => {
    const user = await page();
    await user.click(screen.getByRole("button", { name: "我的私有" }));
    expect(screen.queryByText("Policy file")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^My notes/ }));
    expect(screen.getByRole("heading", { name: /My notes/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText("搜索资料名称"), "absent");
    expect(screen.getByText("没有匹配的资料")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("搜索资料名称"));
    await user.click(screen.getByRole("button", { name: /^全部资料/ }));
    await user.click(screen.getByRole("button", { name: "公有", exact: true }));
    expect(screen.getByText("Policy file")).toBeInTheDocument();
    expect(screen.queryByText("Private note")).not.toBeInTheDocument();
  });
  it("creates a private library and records text under the selected library", async () => {
    const user = await page();
    await user.click(screen.getByRole("button", { name: "新建知识库" }));
    await user.type(screen.getByLabelText("知识库名称"), " Working notes ");
    await user.click(screen.getByRole("button", { name: /私有知识库/ }));
    await user.click(screen.getByRole("button", { name: "创建知识库" }));
    await screen.findByText("知识库已创建，可以开始录入资料。");
    expect(api).toHaveBeenCalledWith("/libraries", { method: "POST", body: { name: "Working notes", visibility: "private" } });
    await user.click(screen.getByRole("button", { name: "录入文字" }));
    expect(screen.getByLabelText(/^存入知识库/)).toHaveValue("private");
    await user.type(screen.getByLabelText("资料标题"), "  New rule  ");
    await user.type(screen.getByLabelText("知识正文"), "  Content  ");
    await user.click(screen.getByRole("button", { name: "保存并建立索引" }));
    await screen.findByText("文字资料已录入，正在建立检索索引。");
    expect(api).toHaveBeenCalledWith("/documents", { method: "POST", body: { libraryId: "private", title: "New rule", content: "Content" } });
  });
  it("edits document title/content and replaces the original file in the same document", async () => {
    const user = await page();
    await user.click(screen.getByRole("button", { name: "编辑 Policy file" }));
    const title = screen.getByLabelText("资料标题");
    await user.clear(title); await user.type(title, "Changed title");
    await user.click(screen.getByRole("button", { name: "保存资料" }));
    await screen.findByText("资料已保存，内容变更后将自动更新索引。");
    expect(api).toHaveBeenCalledWith("/documents/doc", { method: "PATCH", body: { title: "Changed title" } });
    await user.click(screen.getByRole("button", { name: "编辑 Private note" }));
    await user.type(screen.getByLabelText("知识正文"), " updated");
    await user.click(screen.getByRole("button", { name: "保存资料" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/documents/note", { method: "PATCH", body: { title: "Private note", content: "My own note updated" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "编辑 Policy file" }));
    await user.click(screen.getByRole("button", { name: "替换文件" }));
    const input = screen.getByLabelText("选择上传文件");
    expect(input).not.toHaveAttribute("multiple");
    fireEvent.change(input, { target: { files: [new File(["replacement"], "replace.xlsx")] } });
    await screen.findByText("replace.xlsx");
    fireEvent.submit(input.closest("form"));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/documents/doc/replace", expect.objectContaining({ method: "POST", body: expect.any(FormData) })));
  });
  it("rebuilds an index, downloads source and confirms deletion", async () => {
    const user = await page();
    await user.click(screen.getByRole("button", { name: "重新处理 Policy file" }));
    await screen.findByText("已提交重新处理，请稍候查看状态。");
    expect(api).toHaveBeenCalledWith("/documents/doc/retry", { method: "POST" });
    await user.click(screen.getByRole("button", { name: "下载 Policy file" }));
    expect(downloadDocument).toHaveBeenCalledWith("doc", "Policy file", {platform:false});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(screen.getByRole("button", { name: "删除 Policy file" }));
    expect(api).not.toHaveBeenCalledWith("/documents/doc", { method: "DELETE" });
    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "删除 Policy file" }));
    await screen.findByText("资料已删除。");
    expect(api).toHaveBeenCalledWith("/documents/doc", { method: "DELETE" });
  });
  it("reports document action errors and preserves failed edit drafts", async () => {
    const user = await page();
    failure = "资料权限已变更";
    await user.click(screen.getByRole("button", { name: "编辑 Policy file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure);
    await user.click(screen.getByRole("button", { name: "关闭提示" }));
    await user.click(screen.getByRole("button", { name: "重新处理 Policy file" }));
    await screen.findByText(failure);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "删除 Policy file" }));
    vi.mocked(downloadDocument).mockRejectedValueOnce(new Error("下载失败"));
    await user.click(screen.getByRole("button", { name: "下载 Policy file" }));
    await screen.findByText("下载失败");
    failure = null;
    await user.click(screen.getByRole("button", { name: "编辑 Policy file" }));
    failure = "保存失败";
    await user.click(screen.getByRole("button", { name: "保存资料" }));
    await screen.findByText(failure);
    expect(screen.getByLabelText("资料标题")).toHaveValue("Policy file");
    await user.click(screen.getByRole("button", { name: "取消" }));
  });
  it("requires creating a library before input when the filtered scope is empty", async () => {
    libraries = []; documents = [];
    render(<Knowledge />);
    await screen.findByText("从第一份资料开始");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "我的私有" }));
    await user.click(screen.getByRole("button", { name: "录入文字" }));
    expect(screen.getByText(/请先新建私有知识库/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /私有知识库/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    failure = "读取资料失败";
    await user.click(screen.getByRole("button", { name: "刷新资料" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(failure);
  });
});
