import test from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_STORAGE_KEY,
  demoUsers,
  demoLibraries,
  demoDocuments,
  canAccessLibrary,
  accessibleLibraries,
  canOperateDocument,
  answerFromDocuments,
  initialPreview,
} from "../src/services/demo.js";

test("every signed-in user can read and operate shared documents regardless of uploader", () => {
  const shared = demoDocuments.filter(
    (doc) => !doc.libraryId.startsWith("private-")
  );
  assert.equal(shared.length, 7);
  for (const user of demoUsers) {
    for (const doc of shared) {
      assert.equal(canOperateDocument(doc, demoLibraries, user.id), true);
    }
    assert.deepEqual(
      accessibleLibraries(demoLibraries, user.id, "public").map(
        (lib) => lib.id
      ),
      ["product", "business", "people"]
    );
  }
});

test("private libraries allow only their owner, including when another user is an administrator", () => {
  for (const user of demoUsers) {
    const privateLibraries = accessibleLibraries(
      demoLibraries,
      user.id,
      "private"
    );
    assert.equal(privateLibraries.length, 1);
    assert.equal(privateLibraries[0].ownerId, user.id);
    for (const library of demoLibraries.filter(
      (lib) => lib.scope === "private"
    )) {
      assert.equal(
        canAccessLibrary(library, user.id),
        library.ownerId === user.id
      );
      const doc = demoDocuments.find((entry) => entry.libraryId === library.id);
      assert.equal(
        canOperateDocument(doc, demoLibraries, user.id),
        library.ownerId === user.id
      );
    }
  }
  assert.equal(
    canAccessLibrary(
      demoLibraries.find((lib) => lib.id === "private-chen"),
      "lin"
    ),
    false
  );
});

test("missing identities, missing private owners and unknown libraries are denied", () => {
  assert.equal(
    canAccessLibrary({ id: "private", scope: "private" }, "lin"),
    false
  );
  assert.equal(
    canAccessLibrary({ id: "private", scope: "private", ownerId: "" }, ""),
    false
  );
  assert.equal(
    canAccessLibrary({ id: "unknown", scope: "unexpected" }, "lin"),
    false
  );
  for (const userId of [undefined, null, "", " "]) {
    assert.equal(canAccessLibrary(demoLibraries[0], userId), false);
    assert.deepEqual(accessibleLibraries(demoLibraries, userId), []);
    assert.equal(
      canOperateDocument(demoDocuments[0], demoLibraries, userId),
      false
    );
    assert.deepEqual(
      answerFromDocuments("采购", demoDocuments, demoLibraries, userId).sources,
      []
    );
  }
  assert.equal(
    canOperateDocument({ libraryId: "removed-library" }, demoLibraries, "lin"),
    false
  );
  assert.equal(canOperateDocument(undefined, demoLibraries, "lin"), false);
});

test("retrieval enforces ownership even when all mock documents are passed in", () => {
  const ownerAnswer = answerFromDocuments(
    "松岚",
    demoDocuments,
    demoLibraries,
    "chen"
  );
  assert.equal(ownerAnswer.sources.length, 1);
  assert.equal(ownerAnswer.sources[0].documentId, "doc-private-chen");
  assert.match(ownerAnswer.content, /松岚客户折扣37/);
  for (const userId of ["lin", "zhou", undefined]) {
    const answer = answerFromDocuments(
      "松岚",
      demoDocuments,
      demoLibraries,
      userId
    );
    assert.deepEqual(answer.sources, []);
    assert.doesNotMatch(answer.content, /松岚|折扣37|客户回访个人计划/);
  }
  const orphan = {
    ...demoDocuments.find((doc) => doc.id === "doc-private-chen"),
    libraryId: "deleted",
  };
  assert.deepEqual(
    answerFromDocuments("松岚", [orphan], demoLibraries, "chen").sources,
    []
  );
});

test("scope limits retrieval to shared knowledge or the current user's private knowledge", () => {
  const publicAnswer = answerFromDocuments(
    "网关",
    demoDocuments,
    demoLibraries,
    "lin",
    "public"
  );
  assert.ok(publicAnswer.sources.length > 0);
  assert.ok(publicAnswer.sources.every((source) => source.scope === "public"));
  assert.doesNotMatch(publicAnswer.content, /每周检查一次/);
  const privateAnswer = answerFromDocuments(
    "网关",
    demoDocuments,
    demoLibraries,
    "lin",
    "private"
  );
  assert.deepEqual(
    privateAnswer.sources.map((source) => source.documentId),
    ["doc-private-lin"]
  );
  assert.match(privateAnswer.content, /每周检查一次/);
  assert.deepEqual(
    answerFromDocuments("松岚", demoDocuments, demoLibraries, "chen", "public")
      .sources,
    []
  );
  assert.deepEqual(
    answerFromDocuments("采购", demoDocuments, demoLibraries, "lin", "private")
      .sources,
    []
  );
  assert.deepEqual(
    answerFromDocuments("采购", demoDocuments, demoLibraries, "lin", "invalid")
      .sources,
    []
  );
});

test("sources include document identity and visible scope labels for permission checks", () => {
  const publicSource = answerFromDocuments(
    "验收",
    demoDocuments,
    demoLibraries,
    "chen",
    "public"
  ).sources[0];
  assert.equal(publicSource.documentId, "doc-install");
  assert.equal(publicSource.libraryId, "product");
  assert.equal(publicSource.scope, "public");
  assert.equal(publicSource.ownerId, null);
  assert.match(publicSource.title, /^公有 · 产品资料 · /);
  assert.ok(publicSource.text);
  const privateSource = answerFromDocuments(
    "巡检",
    demoDocuments,
    demoLibraries,
    "lin"
  ).sources[0];
  assert.equal(privateSource.documentId, "doc-private-lin");
  assert.equal(privateSource.libraryId, "private-lin");
  assert.equal(privateSource.scope, "private");
  assert.equal(privateSource.ownerId, "lin");
  assert.match(privateSource.title, /^私有 · 我的笔记 · /);
});

test("preview data uses isolated conversation ownership and fresh copies", () => {
  assert.equal(DEMO_STORAGE_KEY, "enterprise-ai-preview-v2");
  const first = initialPreview();
  const second = initialPreview();
  assert.equal(first.conversations[0].ownerId, "lin");
  assert.equal(first.conversations[0].messages[1].sources[0].scope, "public");
  first.documents[0].content = "changed";
  first.conversations[0].messages[1].sources[0].text = "changed";
  assert.notEqual(second.documents[0].content, "changed");
  assert.notEqual(
    second.conversations[0].messages[1].sources[0].text,
    "changed"
  );
});
