import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computed, ref } from "vue";

function harness(overrides = {}, runtime = {}) {
  const api = {
    libraries: async () => ({
      libraries: [
        { id: "public", visibility: "public", name: "Company", canWrite: true },
      ],
    }),
    documents: async () => ({
      documents: [
        {
          id: "doc",
          libraryId: "public",
          title: "Published",
          content: "Current text",
          status: "ready",
          canWrite: true,
        },
      ],
    }),
    fileTypes: async () => ({ extensions: [".txt"], maxFileSizeBytes: 1000 }),
    knowledgeChanges: async () => ({ changes: [], canReview: false }),
    ...overrides,
  };
  const notices = [];
  const source = readFileSync(
    new URL("../src/components/KnowledgePanel.vue", import.meta.url),
    "utf8"
  )
    .split("<script setup>")[1]
    .split("</script>")[0]
    .replace(/^import .*;\r?\n/gm, "");
  return new Function(
    "computed",
    "inject",
    "onMounted",
    "onUnmounted",
    "ref",
    "defineOptions",
    "defineEmits",
    "defineExpose",
    "uni",
    `${source}\nreturn {changes,canReview,reviewNotes,comparisons,reviewing,error,reviewChange,cancelChange,compareChange,openChangeOriginal,changeTitle,changeActionLabel,changeStatusLabel,submitDocument,approvalPending,submitted,targetLibrary,targetScope,textTitle,textContent,entryMode,documents,libraries,refresh,notices:uni.notices};`
  )(
    computed,
    () => api,
    () => {},
    () => {},
    ref,
    () => {},
    () => () => {},
    () => {},
    { notices, showToast: (value) => notices.push(value), ...runtime }
  );
}

const proposal = {
  id: "change",
  documentId: "doc",
  libraryId: "public",
  action: "document.update",
  title: "Proposal",
  content: "Proposed text",
  status: "conflict",
};

test("conflict review first loads current content, then requires an explicit administrator confirmation", async () => {
  const calls = [],
    confirmations = [];
  const h = harness(
    {
      document: async (id) => {
        calls.push(["read", id]);
        return { document: { title: "Published", content: "Current text" } };
      },
      reviewKnowledge: async (id, data) => {
        calls.push(["review", id, data]);
      },
    },
    {
      showModal: (options) => {
        confirmations.push(options.content);
        options.success({ confirm: true });
      },
    }
  );
  await h.reviewChange(proposal, "approve");
  assert.deepEqual(calls, [["read", "doc"]]);
  assert.equal(h.comparisons.value.change.content, "Current text");
  assert.equal(confirmations.length, 0);
  h.reviewNotes.value.change = "Compared with current version";
  await h.reviewChange(proposal, "approve");
  assert.equal(confirmations.length, 1);
  assert.deepEqual(calls[1], [
    "review",
    "change",
    {
      decision: "approve",
      resolveConflict: true,
      note: "Compared with current version",
    },
  ]);
  assert.equal(h.reviewing.value, "");
});

test("a failed current-content read cannot approve a conflicting request", async () => {
  let approvals = 0;
  const h = harness({
    document: async () => {
      throw new Error("Resource unavailable");
    },
    reviewKnowledge: async () => {
      approvals++;
    },
  });
  await h.reviewChange(proposal, "approve");
  assert.equal(approvals, 0);
  assert.equal(h.error.value, "Resource unavailable");
  assert.deepEqual(h.comparisons.value, {});
});

test("review errors remain visible after refreshing a server-side conflict", async () => {
  const h = harness({
    reviewKnowledge: async () => {
      throw new Error("Resource changed");
    },
  });
  await h.reviewChange({ ...proposal, status: "pending" }, "approve");
  assert.equal(h.error.value, "Resource changed");
  assert.equal(h.reviewing.value, "");
});

test("public text acceptance is pending approval and does not appear as published knowledge", async () => {
  const h = harness({
    createDocument: async () => ({ approvalRequired: true, change: proposal }),
  });
  await h.refresh();
  h.entryMode.value = "text";
  h.targetScope.value = "public";
  h.targetLibrary.value = "public";
  h.textTitle.value = "Proposal";
  h.textContent.value = "Proposed text";
  await h.submitDocument();
  assert.equal(h.submitted.value, true);
  assert.equal(h.approvalPending.value, true);
  assert.deepEqual(
    h.documents.value.map((document) => document.name),
    ["Published"]
  );
  assert.equal(h.notices[0].title, "已提交管理员审批");
});

test("review labels describe deletion and conflict in product language", async () => {
  const h = harness();
  await h.refresh();
  assert.equal(h.changeTitle({ documentId: "doc" }), "Published");
  assert.equal(h.changeActionLabel("document.delete"), "删除资料");
  assert.equal(h.changeStatusLabel("conflict"), "存在冲突");
});
