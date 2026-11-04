import test from "node:test";
import assert from "node:assert/strict";
import { parseMessageContent } from "../src/utils/messageContent.js";

function textOf(nodes) {
  return nodes.map((node) => node.text || textOf(node.children || [])).join("");
}

test("Chinese GFM tables keep headers, alignment and inline formatting", () => {
  const [table] = parseMessageContent(
    "| 芯片型号 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| **国产芯片** | 12 | `QFN`封装 |"
  );
  assert.equal(table.type, "table");
  assert.deepEqual(table.alignments, ["left", "right", "center"]);
  assert.deepEqual(table.headers.map(textOf), ["芯片型号", "数量", "备注"]);
  assert.deepEqual(table.rows[0].map(textOf), ["国产芯片", "12", "QFN封装"]);
  assert.equal(table.rows[0][0][0].name, "strong");
});

test("tables without outer pipes are recognized after an introductory paragraph", () => {
  const blocks = parseMessageContent(
    "查询结果：\n型号 | 库存\n--- | ---\nA001 | 20\n\n下一段文字。"
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["paragraph", "table", "paragraph"]
  );
  assert.deepEqual(blocks[1].rows[0].map(textOf), ["A001", "20"]);
  assert.equal(textOf(blocks[2].nodes), "下一段文字。");
});

test("table pipes follow the web Markdown-it rules, including inside code spans", () => {
  const [table] = parseMessageContent(
    "| 表达式 | 结果 |\n| --- | --- |\n| left\\|right | `a|b` |\n| \\`left | right |\n| `未闭合 | 第二列 |"
  );
  // Markdown-it requires escaping a table pipe even inside a code span.
  assert.deepEqual(table.rows[0].map(textOf), ["left|right", "`a"]);
  assert.deepEqual(table.rows[1].map(textOf), ["`left", "right"]);
  assert.deepEqual(table.rows[2].map(textOf), ["`未闭合", "第二列"]);
});

test("table rows pad omitted cells and ignore cells past the header width", () => {
  const [table] = parseMessageContent(
    "| 型号 | 库存 |\n| --- | --- |\n| A001 |\n| A002 | 12 | 多余单元格 |"
  );
  assert.deepEqual(
    table.rows.map((row) => row.map(textOf)),
    [
      ["A001", ""],
      ["A002", "12"],
    ]
  );
});

test("a one-column GFM table accepts a short delimiter with outer pipes", () => {
  const [table] = parseMessageContent("| 型号 |\n| - |\n| A001 |");
  assert.equal(table.type, "table");
  assert.deepEqual(table.rows[0].map(textOf), ["A001"]);
});

test("escaped code-span pipes and multi-backtick spans follow the web parser", () => {
  const [table] = parseMessageContent(
    "| 表达式 | 说明 |\n| --- | --- |\n| `` a|`b `` | 双反引号 |\n| `a\\|b` | 转义分隔符 |"
  );
  assert.deepEqual(table.rows[0].map(textOf), ["`` a", "`b ``"]);
  assert.deepEqual(table.rows[1].map(textOf), ["a|b", "转义分隔符"]);
});

test("fenced samples and incomplete streaming delimiters stay ordinary content", () => {
  const blocks = parseMessageContent(
    "```md\n| 型号 | 库存 |\n| --- | --- |\n```\n\n| 型号 | 库存 |\n| --"
  );
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[1].type, "paragraph");
  assert(!blocks.some((block) => block.type === "table"));
});

test("unsafe HTML and URLs in cells never create executable rich-text elements", () => {
  const [table] = parseMessageContent(
    "| 标题 | 内容 |\n| --- | --- |\n| <img src=x onerror=alert(1)> | [打开](javascript:alert) |"
  );
  assert.equal(textOf(table.rows[0][0]), "<img src=x onerror=alert(1)>");
  assert.equal(textOf(table.rows[0][1]), "[打开](javascript:alert)");
  const inspect = (nodes) =>
    nodes.forEach((node) => {
      assert(!["script", "img", "iframe", "a"].includes(node.name));
      assert(!node.attrs?.href && !node.attrs?.src && !node.attrs?.onclick);
      inspect(node.children || []);
    });
  table.rows[0].forEach(inspect);
});
