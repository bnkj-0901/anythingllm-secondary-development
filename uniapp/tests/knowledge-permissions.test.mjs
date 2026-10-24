import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computed, ref } from "vue";

function harness(api = {}) {
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
    `${source}\nreturn { libraries, documents, accessibleLibraries, uploadLibraries, canOperate, openDetail, detailDocument, detailVisible, openEdit, editVisible };`
  )(
    computed,
    () => api,
    () => {},
    () => {},
    ref,
    () => {},
    () => () => {},
    () => {},
    {}
  );
}

test("knowledge lists retain every server-authorized library regardless of storage origin or creator", () => {
  const h = harness();
  const libraries = [
    {
      id: "granted-private",
      scope: "private",
      tenantId: "another-origin",
      createdBy: "someone-else",
      canWrite: true,
    },
    { id: "review-only", scope: "public", canWrite: false },
    { id: "missing-permission", scope: "public" },
  ];
  h.libraries.value = libraries;
  assert.deepEqual(h.accessibleLibraries.value, libraries);
  assert.deepEqual(
    h.uploadLibraries.value.map((library) => library.id),
    ["granted-private"]
  );
  assert.equal(
    h.canOperate({ libraryId: "granted-private", canWrite: true }),
    true
  );
  assert.equal(
    h.canOperate({ libraryId: "review-only", canWrite: false }),
    false
  );
  assert.equal(
    h.canOperate({
      libraryId: "missing-permission",
      createdBy: "current-user",
    }),
    false
  );
  assert.equal(h.canOperate(null), false);
});

test("read-only authorized documents can open while edit remains unavailable", async () => {
  const document = {
    id: "readable",
    libraryId: "review",
    title: "Read only",
    canWrite: false,
  };
  let calls = 0;
  const h = harness({
    document: async () => {
      calls++;
      return { document };
    },
  });
  h.libraries.value = [{ id: "review", canWrite: false }];
  h.documents.value = [document];
  await h.openDetail(document);
  assert.equal(calls, 1);
  assert.equal(h.detailVisible.value, true);
  assert.equal(h.detailDocument.value.id, document.id);
  await h.openEdit(document);
  assert.equal(h.editVisible.value, false);
  await h.openDetail({ id: "unlisted", libraryId: "review" });
  assert.equal(calls, 1);
});
