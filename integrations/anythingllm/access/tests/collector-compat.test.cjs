const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { relativeDocumentLocation } = require("../collector-compat.cjs");
test("Windows collector absolute paths become portable relative paths within document storage", () => {
  const root = "D:\\project\\server\\storage\\documents";
  assert.equal(relativeDocumentLocation(root + "\\custom-documents\\test.json", root, path.win32), "custom-documents/test.json");
  assert.equal(relativeDocumentLocation("custom-documents/test.json", root, path.win32), "custom-documents/test.json");
  for (const location of ["D:\\outside\\test.json", "../outside.json", root, "custom-documents/test.exe", "one/two/three.json"]) assert.throws(() => relativeDocumentLocation(location, root, path.win32));
});
