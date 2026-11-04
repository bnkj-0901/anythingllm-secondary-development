const { decodeUploadFileName } = require("../../utils/files/filename");
const express = require("express");
const multer = require("multer");

describe("multipart upload filename decoding", () => {
  test.each([
    "芯片球位查询全量数据.xlsx",
    "混合 English 资料（最终版）.XLSX",
    "café-résumé.txt",
    "🧪 测试文件.txt",
  ])("recovers browser UTF-8 filename %s", (filename) => {
    const parsed = Buffer.from(filename, "utf8").toString("latin1");
    expect(decodeUploadFileName(parsed)).toBe(filename);
  });

  test.each([
    "already-normal.txt",
    "正常中文.xlsx",
    "中文 café.txt",
    "résumé.txt",
    "Müller.txt",
    "ÿ-file.txt",
    "\u00e8\u008a truncated.txt",
    "invalid-\u00c0\u00af.txt",
  ])("preserves Unicode, Latin-1, or invalid UTF-8 filename %s", (filename) => {
    expect(decodeUploadFileName(filename)).toBe(filename);
  });

  test("preserves a UTF-8 byte order mark in the original name", () => {
    const filename = "\ufeff资料.txt";
    const parsed = Buffer.from(filename, "utf8").toString("latin1");
    expect(decodeUploadFileName(parsed)).toBe(filename);
  });

  test("handles real browser multipart, filename*, and legacy Latin-1 requests", async () => {
    const app = express();
    app.post("/", multer().single("file"), (req, res) => {
      res.json({ filename: decodeUploadFileName(req.file.originalname) });
    });
    const listener = await new Promise((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => resolve(server));
    });
    const url = `http://127.0.0.1:${listener.address().port}`;
    try {
      const browser = new FormData();
      browser.set("file", new Blob(["content"]), "芯片查询全量数据.xlsx");
      const uploaded = await fetch(url, { method: "POST", body: browser });
      expect(await uploaded.json()).toEqual({
        filename: "芯片查询全量数据.xlsx",
      });

      for (const [header, filename] of [
        ["filename*=UTF-8''%E4%B8%AD%E6%96%87.txt", "中文.txt"],
        ['filename="résumé.txt"', "résumé.txt"],
      ]) {
        const boundary = "upload-filename-regression";
        const body = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; ${header}\r\nContent-Type: text/plain\r\n\r\ncontent\r\n--${boundary}--\r\n`,
          "latin1"
        );
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ filename });
      }
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });
});
