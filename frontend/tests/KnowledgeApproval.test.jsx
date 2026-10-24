import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Knowledge from "../src/pages/Knowledge";
import { api, downloadResource } from "../src/models/platform";

vi.mock("../src/models/platform", () => ({
  api: vi.fn(),
  downloadDocument: vi.fn(),
  downloadResource: vi.fn(),
}));

const library = {
  id: "public",
  tenantId: "acme",
  name: "Company",
  visibility: "public",
  canWrite: true,
};
const document = {
  id: "doc",
  libraryId: "public",
  title: "Published policy",
  content: "Published text",
  inputType: "text",
  visibility: "public",
  status: "ready",
  canWrite: true,
};
const proposal = {
  id: "proposal",
  libraryId: "public",
  documentId: "doc",
  action: "document.update",
  title: "Proposed policy",
  content: "Proposed text",
  status: "pending",
  reviewNote: "",
};
let changes, canReview, platform, failCurrent;

beforeEach(() => {
  changes = [];
  canReview = false;
  platform = false;
  failCurrent = false;
  vi.mocked(downloadResource).mockReset().mockResolvedValue(undefined);
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path, options = {}) => {
      const prefix = platform ? "/platform" : "";
      if (path === "/file-types")
        return { extensions: [".txt"], maxFileSizeBytes: 1000 };
      if (path === "/platform/tenants")
        return { tenants: [{ id: "acme", name: "Acme" }] };
      if (path === "/platform/tenants/acme/users")
        return { users: [{ id: "member", name: "Member", status: "active" }] };
      if (path === `${prefix}/knowledge-changes`) return { changes, canReview };
      if (path === `${prefix}/knowledge-changes/proposal/review`) {
        changes = changes.map((change) => ({
          ...change,
          status: options.body.decision === "approve" ? "approved" : "rejected",
        }));
        return { change: changes[0] };
      }
      if (
        path === `${prefix}/knowledge-changes/proposal` &&
        options.method === "DELETE"
      ) {
        changes = changes.map((change) => ({ ...change, status: "cancelled" }));
        return { success: true };
      }
      if (path === `${prefix}/libraries/public/grants`)
        return { approvalRequired: true, change: proposal };
      if (path === `${prefix}/libraries`) return { libraries: [library] };
      if (path === `${prefix}/documents/doc`) {
        if (failCurrent) throw new Error("Current source unavailable");
        return { document };
      }
      if (path === `${prefix}/documents` && options.method === "POST") {
        changes = [
          {
            ...proposal,
            action: "document.create",
            documentId: null,
            title: options.body.title,
            content: options.body.content,
          },
        ];
        return { approvalRequired: true, change: changes[0] };
      }
      if (path === `${prefix}/documents`) return { documents: [document] };
      throw new Error(`Unexpected ${path}`);
    });
});

describe("public knowledge approval", () => {
  it("submits public pin changes for approval while retaining the published document state", async () => {
    const original = vi.mocked(api).getMockImplementation();
    vi.mocked(api).mockImplementation((path, options = {}) =>
      path === "/documents/doc" && options.method === "PATCH"
        ? Promise.resolve({ approvalRequired: true })
        : original(path, options)
    );
    const user = userEvent.setup();
    render(
      <Knowledge
        session={{ identity: "tenant", user: { id: "member" }, role: "user" }}
      />
    );
    await user.click(
      await screen.findByRole("button", { name: "固定 Published policy" })
    );
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/documents/doc", {
        method: "PATCH",
        body: { pinned: true },
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent("审批");
    expect(
      screen.getByRole("button", { name: "固定 Published policy" })
    ).toBeInTheDocument();
  });
  it("submits public text for approval and keeps the published list unchanged", async () => {
    const user = userEvent.setup();
    render(
      <Knowledge
        session={{ identity: "tenant", user: { id: "member" }, role: "user" }}
      />
    );
    await screen.findByText("Published policy");
    await user.click(screen.getByRole("button", { name: "录入文字" }));
    await user.type(screen.getByLabelText("资料标题"), "New proposal");
    await user.type(screen.getByLabelText("知识正文"), "Pending text");
    await user.click(screen.getByRole("button", { name: "保存并建立索引" }));
    await screen.findByText("变更已提交管理员审批，批准前继续使用已发布内容。");
    expect(screen.getByText("Published policy")).toBeInTheDocument();
    expect(screen.getByText("我的知识变更申请")).toBeInTheDocument();
    expect(
      screen.queryByText("文字资料已录入，正在建立检索索引。")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "批准" })
    ).not.toBeInTheDocument();
  });

  it("lets the requester withdraw without exposing administrator review actions", async () => {
    changes = [proposal];
    const user = userEvent.setup();
    render(<Knowledge />);
    await user.click(
      await screen.findByText("Proposed policy · 修改资料 · 待审批")
    );
    expect(
      screen.queryByRole("button", { name: "批准" })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "撤回" }));
    await screen.findByText("Proposed policy · 修改资料 · 已撤回");
    expect(api).toHaveBeenCalledWith("/knowledge-changes/proposal", {
      method: "DELETE",
    });
  });

  it("shows proposal and review note separately and submits an administrator reason", async () => {
    changes = [
      {
        ...proposal,
        targetUserId: "member",
        targetUserName: "Member",
        reviewNote: "Previous publication failed",
      },
    ];
    canReview = true;
    const user = userEvent.setup();
    render(<Knowledge />);
    await user.click(
      await screen.findByText("Proposed policy · 修改资料 · 待审批")
    );
    expect(screen.getByText("申请正文：Proposed text")).toBeInTheDocument();
    expect(screen.getByText("授权用户：Member")).toBeInTheDocument();
    expect(
      screen.getByText("审批说明：Previous publication failed")
    ).toBeInTheDocument();
    await user.type(
      screen.getByLabelText("审批说明 Proposed policy"),
      "Needs correction"
    );
    await user.click(screen.getByRole("button", { name: "驳回" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/knowledge-changes/proposal/review", {
        method: "POST",
        body: {
          decision: "reject",
          resolveConflict: false,
          note: "Needs correction",
        },
      })
    );
    await screen.findByText("Proposed policy · 修改资料 · 已驳回");
  });

  it("requires loading current content before explicitly approving a conflicting change", async () => {
    changes = [{ ...proposal, status: "conflict" }];
    canReview = true;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<Knowledge />);
    await user.click(
      await screen.findByText("Proposed policy · 修改资料 · 存在冲突")
    );
    await user.click(screen.getByRole("button", { name: "处理冲突并批准" }));
    await screen.findByText("当前正文：Published text");
    expect(api).not.toHaveBeenCalledWith(
      "/knowledge-changes/proposal/review",
      expect.anything()
    );
    expect(confirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "处理冲突并批准" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/knowledge-changes/proposal/review", {
        method: "POST",
        body: { decision: "approve", resolveConflict: true, note: "" },
      })
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("does not approve a conflict if the current source cannot be read", async () => {
    changes = [{ ...proposal, status: "conflict" }];
    canReview = true;
    failCurrent = true;
    const user = userEvent.setup();
    render(<Knowledge />);
    await user.click(
      await screen.findByText("Proposed policy · 修改资料 · 存在冲突")
    );
    await user.click(screen.getByRole("button", { name: "处理冲突并批准" }));
    await screen.findByText("Current source unavailable");
    expect(api).not.toHaveBeenCalledWith(
      "/knowledge-changes/proposal/review",
      expect.anything()
    );
  });

  it("uses authenticated platform routes for approval and source download", async () => {
    changes = [{ ...proposal, hasOriginal: true }];
    canReview = true;
    platform = true;
    const user = userEvent.setup();
    render(<Knowledge session={{ identity: "platform" }} />);
    await user.click(
      await screen.findByText("Proposed policy · 修改资料 · 待审批")
    );
    await user.click(screen.getByText("下载待审原件"));
    expect(downloadResource).toHaveBeenCalledWith(
      "/platform/knowledge-changes/proposal/download",
      "Proposed policy"
    );
    await user.click(screen.getByRole("button", { name: "批准" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        "/platform/knowledge-changes/proposal/review",
        expect.objectContaining({ method: "POST" })
      )
    );
  });

  it("lets the top administrator choose a private grantee without entering database identifiers", async () => {
    platform = true;
    const user = userEvent.setup();
    render(<Knowledge session={{ identity: "platform" }} />);
    await user.click(await screen.findByRole("button", { name: "Company 1" }));
    await user.click(screen.getByRole("button", { name: "调整授权" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(dialog.querySelector("select"), {
      target: { value: "member" },
    });
    await user.click(screen.getByRole("button", { name: "保存授权" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/platform/libraries/public/grants", {
        method: "PUT",
        body: { visibility: "private", userId: "member" },
      })
    );
  });
});
