import MarkdownIt from "markdown-it/dist/markdown-it.js";

// Match the existing web client's Markdown-it grammar. Rendering stays native
// because uni-app rich-text does not share React's HTML/DOM renderer.
const markdown = new MarkdownIt({ html: false, typographer: true });

export function normalizeThoughtIndentation(text = "") {
  let inFence = false;
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const width = line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
      const normWidth = width >= 4 ? Math.floor(width / 2) : width;
      const dedented = " ".repeat(normWidth) + line.trimStart();
      return dedented.replace(/^(\s*(?:[*+-]|\d+[.)]))\s{2,}/, "$1 ");
    })
    .join("\n");
}

// Syntax, escaping, entities and incomplete streaming input are all parsed by
// the same Markdown-it rules as the web client. This adapter only chooses
// the safe native nodes and block components used to display those tokens.
export function parseMessageTokens(
  value,
  { thought = false, inline = false } = {}
) {
  const content = String(value ?? "");
  const parse = (text) =>
    inline ? markdown.parseInline(text, {}) : markdown.parse(text, {});
  if (!thought) return parse(content);
  // This follows renderThoughtMarkdown on the web: normalize padded lists and
  // disable indented code only for this synchronous thought snapshot.
  markdown.disable("code");
  try {
    return parse(normalizeThoughtIndentation(content));
  } finally {
    markdown.enable("code");
  }
}

function tokenTree(tokens) {
  const roots = [];
  const stack = [roots];
  for (const token of tokens || []) {
    if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const item = { token, children: [] };
    stack[stack.length - 1].push(item);
    if (token.nesting === 1) stack.push(item.children);
  }
  return roots;
}

function textNode(text) {
  return { type: "text", text };
}

function inlineTreeNodes(items) {
  return items.flatMap(({ token, children }) => {
    switch (token.type) {
      case "strong_open":
      case "em_open":
      case "s_open":
        return [{ name: token.tag, children: inlineTreeNodes(children) }];
      case "code_inline":
        return [
          {
            name: "span",
            attrs: {
              style:
                "font-family:monospace;background:#f0f2f5;color:#48556a;padding:2px 5px;border-radius:4px;",
            },
            children: [textNode(token.content)],
          },
        ];
      case "softbreak":
        // The web renderer leaves soft breaks as whitespace (breaks:false).
        return [textNode("\n")];
      case "hardbreak":
        return [{ name: "br" }];
      case "link_open":
        // Native rich-text has no common link interaction contract. Keep the
        // Markdown-it label/formatting while leaving navigation to the app.
        return inlineTreeNodes(children);
      case "image": {
        const label = markdown.renderer.renderInlineAsText(
          token.children || [],
          markdown.options,
          {}
        );
        return [textNode(label ? `[图片：${label}]` : "[图片]")];
      }
      default:
        // html:false prevents HTML tokens; fallback content is always text.
        return token.content
          ? [textNode(token.content)]
          : inlineTreeNodes(children);
    }
  });
}

function inlineTokenNodes(tokens) {
  return inlineTreeNodes(tokenTree(tokens));
}

export function inlineNodes(value) {
  return parseMessageTokens(value, { inline: true }).flatMap((token) =>
    inlineTokenNodes(token.children)
  );
}

function inlineChildren(items) {
  return items.flatMap(({ token }) =>
    token.type === "inline" ? inlineTokenNodes(token.children) : []
  );
}

function tableBlock(item) {
  const rows = [];
  let headers = [];
  let alignments = [];
  for (const section of item.children) {
    for (const row of section.children) {
      const cells = row.children.map((cell) => inlineChildren(cell.children));
      if (section.token.type === "thead_open") {
        headers = cells;
        alignments = row.children.map(({ token }) => {
          const style = token.attrGet("style");
          return style === "text-align:right"
            ? "right"
            : style === "text-align:center"
              ? "center"
              : "left";
        });
      } else {
        rows.push(cells);
      }
    }
  }
  return { type: "table", headers, alignments, rows };
}

function blockTree(items) {
  return items.flatMap((item) => {
    const { token, children } = item;
    switch (token.type) {
      case "paragraph_open":
        return [{ type: "paragraph", nodes: inlineChildren(children) }];
      case "heading_open":
        return [
          {
            type: "heading",
            level: Number(token.tag.slice(1)),
            nodes: inlineChildren(children),
          },
        ];
      case "fence":
      case "code_block":
        return [
          {
            type: "code",
            language: token.info.trim().split(/\s+/)[0] || "code",
            content: token.content.endsWith("\n")
              ? token.content.slice(0, -1)
              : token.content,
          },
        ];
      case "hr":
        return [{ type: "rule" }];
      case "table_open":
        return [tableBlock(item)];
      case "bullet_list_open":
      case "ordered_list_open": {
        const ordered = token.type === "ordered_list_open";
        const start = Number(token.attrGet("start") || 1);
        return [
          {
            type: "list",
            ordered,
            items: children.map((child, index) => {
              const blocks = blockTree(child.children);
              return {
                marker: ordered ? `${start + index}.` : "•",
                nodes: blocks[0]?.nodes || [],
                blocks,
              };
            }),
          },
        ];
      }
      case "blockquote_open": {
        const blocks = blockTree(children);
        return [
          {
            type: "quote",
            nodes: blocks.flatMap((block) => block.nodes || []),
            blocks,
          },
        ];
      }
      default:
        return token.content
          ? [{ type: "paragraph", nodes: [textNode(token.content)] }]
          : blockTree(children);
    }
  });
}

export function parseMessageContent(value, options = {}) {
  return blockTree(tokenTree(parseMessageTokens(value, options)));
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
        citationNumber:
          Number.isInteger(source.citationNumber) && source.citationNumber > 0
            ? source.citationNumber
            : index + 1,
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
