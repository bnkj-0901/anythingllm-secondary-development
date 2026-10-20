// rich-text receives a node tree, never HTML from a model or document. Every
// untrusted value is a text node; only the fixed tags/styles below are emitted.
function appendText(nodes, value) {
  String(value)
    .split("\n")
    .forEach((part, index) => {
      if (index) nodes.push({ name: "br" });
      if (part) nodes.push({ type: "text", text: part });
    });
}

export function inlineNodes(value, depth = 0) {
  const text = String(value || "");
  if (depth > 4) return [{ type: "text", text }];

  const nodes = [];
  const tokens =
    /`([^`\n]+)`|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+)\*|!\[([^\]\n]*)\]\([^\n)]*\)|\[([^\]\n]+)\]\([^\n)]*\)/g;
  let cursor = 0;
  let match;
  while ((match = tokens.exec(text))) {
    appendText(nodes, text.slice(cursor, match.index));
    if (match[1] !== undefined) {
      nodes.push({
        name: "span",
        attrs: {
          style:
            "font-family:monospace;background:#f0f2f5;color:#48556a;padding:2px 5px;border-radius:4px;",
        },
        children: [{ type: "text", text: match[1] }],
      });
    } else if (match[2] !== undefined || match[3] !== undefined) {
      nodes.push({
        name: "strong",
        children: inlineNodes(match[2] ?? match[3], depth + 1),
      });
    } else if (match[4] !== undefined) {
      nodes.push({ name: "em", children: inlineNodes(match[4], depth + 1) });
    } else if (match[5] !== undefined) {
      appendText(nodes, match[5] ? `[图片：${match[5]}]` : "[图片]");
    } else {
      // Keep link labels readable without opening arbitrary model-generated URLs.
      appendText(nodes, match[6]);
    }
    cursor = tokens.lastIndex;
  }
  appendText(nodes, text.slice(cursor));
  return nodes;
}

const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const headingPattern = /^ {0,3}(#{1,6})\s+(.+)$/;
const listPattern = /^\s{0,3}([-+*]|\d+[.)])\s+(.+)$/;
const quotePattern = /^ {0,3}>\s?(.*)$/;
const rulePattern = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

function isBlockStart(line) {
  return (
    fencePattern.test(line) ||
    headingPattern.test(line) ||
    listPattern.test(line) ||
    quotePattern.test(line) ||
    rulePattern.test(line)
  );
}

export function parseMessageContent(value) {
  const lines = String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(fencePattern);
    if (fence) {
      const marker = fence[1][0];
      const closingPattern = new RegExp(
        `^ {0,3}${marker}{${fence[1].length},}\\s*$`
      );
      const code = [];
      index += 1;
      while (index < lines.length && !closingPattern.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: "code",
        language: fence[2].trim().split(/\s+/)[0] || "code",
        content: code.join("\n"),
      });
      continue;
    }

    const heading = line.match(headingPattern);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        nodes: inlineNodes(heading[2].replace(/\s+#+\s*$/, "")),
      });
      index += 1;
      continue;
    }

    if (rulePattern.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    const list = line.match(listPattern);
    if (list) {
      const ordered = /^\d/.test(list[1]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(listPattern);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push({
          marker: ordered ? item[1].replace(")", ".") : "•",
          nodes: inlineNodes(item[2]),
        });
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    const quote = line.match(quotePattern);
    if (quote) {
      const quoted = [];
      while (index < lines.length) {
        const item = lines[index].match(quotePattern);
        if (!item) break;
        quoted.push(item[1]);
        index += 1;
      }
      blocks.push({ type: "quote", nodes: inlineNodes(quoted.join("\n")) });
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockStart(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({
      type: "paragraph",
      nodes: inlineNodes(paragraph.join("\n")),
    });
  }
  return blocks;
}

function nonEmptyText(...values) {
  const found = values.find(
    (value) => typeof value === "string" && value.trim()
  );
  return found ? found.trim() : "";
}

export function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((source) => source && typeof source === "object")
    .map((source, index) => {
      const metadata =
        source.metadata && typeof source.metadata === "object"
          ? source.metadata
          : {};
      const title =
        nonEmptyText(
          source.title,
          metadata.title,
          source.name,
          metadata.name,
          source.docFilename,
          metadata.docFilename
        ) || `参考资料 ${index + 1}`;
      const summary = nonEmptyText(
        source.text,
        source.pageContent,
        source.content,
        source.description,
        metadata.text,
        metadata.description
      );
      return {
        id: `source-${index}`,
        title,
        summary: summary.slice(0, 1600),
        truncated: summary.length > 1600,
        documentId:
          typeof source.documentId === "string" ? source.documentId : "",
        libraryId: typeof source.libraryId === "string" ? source.libraryId : "",
        scope:
          source.scope === "public" || source.scope === "private"
            ? source.scope
            : "",
      };
    });
}
