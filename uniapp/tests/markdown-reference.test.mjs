import test from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it/dist/markdown-it.js";
import {
  inlineNodes,
  normalizeThoughtIndentation,
  parseMessageContent,
  parseMessageTokens,
} from "../src/utils/messageContent.js";

// Independent reference configured from the existing frontend options. The
// uni-app implementation has no runtime dependency on the React application.
const referenceMarkdown = new MarkdownIt({ html: false, typographer: true });
const plainTokens = (tokens) => JSON.parse(JSON.stringify(tokens));
const textOf = (nodes) =>
  nodes.map((node) => node.text || textOf(node.children || [])).join("");

test("native tables, nesting, escaping and typography follow the backend reference rules", () => {
  const samples = [
    '## 查询结果\n\n"芯片" (c) ...\n\n| 型号 | 数量 |\n| :--- | ---: |\n| **A001** | 12 |',
    "3. 第三项\n   - **子项**\n     > 引用 `代码`\n   - 下一项\n4. 第四项",
    "标题\n====\n\n~~删除~~ &amp; [**标签**](https://example.com)\n\n![图片](https://example.com/a.png)",
    "<script>alert(1)</script>\n\n[打开](javascript:alert)\n\n    indented code",
    "```js\nconst value = '<div>';\n```\n\n末尾 **未闭合",
    "<https://中文.example/路径> [中文域名](https://中文.example/路径)",
  ];
  for (const input of samples) {
    assert.deepEqual(
      plainTokens(parseMessageTokens(input)),
      plainTokens(referenceMarkdown.parse(input, {}))
    );
  }
});

test("each incomplete streaming snapshot follows the backend Markdown rules", () => {
  const sample =
    "先看 **重点** 与 `a|b`\n\n| 型号 | 数量 |\n| --- | ---: |\n| A001 | 12 |\n\n```js\nconst x = 1;\n```";
  for (let end = 0; end <= sample.length; end += 1) {
    const input = sample.slice(0, end);
    assert.deepEqual(
      plainTokens(parseMessageTokens(input)),
      plainTokens(referenceMarkdown.parse(input, {})),
      `stream prefix ${end}`
    );
    assert.doesNotThrow(() => parseMessageContent(input));
  }
});

test("nested lists preserve their paragraphs, nested lists, quotes and code", () => {
  const [list] = parseMessageContent(
    "3. 父项目\n   - **子项目**\n     > 子引用\n\n     ```js\n     const x = 1;\n     ```\n4. 下一项目"
  );
  assert.deepEqual(
    list.items.map((item) => item.marker),
    ["3.", "4."]
  );
  assert.equal(textOf(list.items[0].nodes), "父项目");
  const nested = list.items[0].blocks[1];
  assert.equal(nested.type, "list");
  assert.equal(textOf(nested.items[0].nodes), "子项目");
  const quote = nested.items[0].blocks[1];
  assert.equal(quote.type, "quote");
  assert.equal(textOf(quote.blocks[0].nodes), "子引用");
  assert.equal(nested.items[0].blocks[2].type, "code");
  assert.equal(nested.items[0].blocks[2].content, "const x = 1;");
});

test("thought normalization follows the web treatment of padded lists and preserves answer code rules", () => {
  const input = "    *   第一项\n        *   子项\n    *   第二项";
  assert.equal(
    normalizeThoughtIndentation(input),
    "  * 第一项\n    * 子项\n  * 第二项"
  );
  const [thought] = parseMessageContent(input, { thought: true });
  assert.equal(thought.type, "list");
  assert.equal(thought.items[0].blocks[1].type, "list");
  assert.equal(parseMessageContent("    code")[0].type, "code");
  assert.equal(
    parseMessageContent("    code", { thought: true })[0].type,
    "paragraph"
  );
  assert.equal(parseMessageContent("    code")[0].type, "code");
});

test("inline nodes use Markdown-it escapes, entities and nested formatting", () => {
  const nodes = inlineNodes(
    "**粗体 *强调*** &amp; \\*字面量\\* ~~删除~~  \n硬换行"
  );
  assert.equal(nodes[0].name, "strong");
  assert.equal(nodes[0].children[1].name, "em");
  assert(textOf(nodes).includes("& *字面量* 删除"));
  assert(nodes.some((node) => node.name === "s"));
  assert(nodes.some((node) => node.name === "br"));
});
