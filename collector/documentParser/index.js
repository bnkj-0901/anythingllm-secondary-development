const fs = require("fs/promises");
const path = require("path");
const { isWithin } = require("../utils/files");
const { MimeDetector } = require("../utils/files/mime");
const { tokenizeString } = require("../utils/tokenizer");
const mimeDetector = new MimeDetector();
const { processSingleFile } = require("../processSingleFile");

const configuredFileLimit = Number(process.env.KNOWLEDGE_MAX_FILE_BYTES);
const configuredContentLimit = Number(
  process.env.KNOWLEDGE_MAX_CONTENT_CHARACTERS
);
const MAX_FILE_SIZE =
  Number.isSafeInteger(configuredFileLimit) && configuredFileLimit > 0
    ? configuredFileLimit
    : Number.MAX_SAFE_INTEGER;
const MAX_CONTENT =
  Number.isSafeInteger(configuredContentLimit) && configuredContentLimit > 0
    ? configuredContentLimit
    : Number.MAX_SAFE_INTEGER;
const storageRoot = path.resolve(
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../server/storage"),
  "enterprise"
);

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status, expose: true });
}

// The server owns originals, permissions, indexing and persistence. This service
// only reads an authorized original and returns its text to that server.
async function parseDocument(payload, settings = {}) {
  const filename = payload?.filename;
  const inputPath = payload?.options?.absolutePath;
  if (
    typeof filename !== "string" ||
    !filename.trim() ||
    filename.length > 255 ||
    typeof inputPath !== "string" ||
    !path.isAbsolute(inputPath)
  ) {
    throw invalid("请提供有效的文件名称与绝对路径");
  }
  const root = path.resolve(settings.storageRoot || storageRoot);
  const target = path.resolve(inputPath);
  if (!isWithin(root, target)) throw invalid("文件路径不在知识资料存储范围内");
  const [realRoot, realPath] = await Promise.all([
    fs.realpath(root),
    fs.realpath(target),
  ]).catch(() => {
    throw invalid("知识资料原文件不存在");
  });
  if (!isWithin(realRoot, realPath))
    throw invalid("知识资料不能通过链接访问外部文件");
  const stat = await fs.stat(realPath);
  if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_SIZE)
    throw invalid("请选择有效且符合当前部署容量限制的文档");
  const extension = path.extname(realPath).toLowerCase();
  let documents;
  try {
    const result = await processSingleFile(filename, {
      ...payload.options,
      absolutePath: realPath,
      parseOnly: true,
      returnDocuments: true,
    });
    if (!result.success) throw new Error(result.reason);
    documents = result.documents;
  } catch {
    // Parser exceptions can contain absolute paths and library internals.
    // Report an actionable format failure without persisting those details.
    throw invalid(
      `无法解析 ${extension
        .slice(1)
        .toUpperCase()}，请确认文件未损坏且没有密码保护`,
      422
    );
  }
  documents = documents
    .map((document) => {
      const { pageContent, metadata = {}, id: _id, ...source } = document;
      return {
        pageContent: String(pageContent || "")
          .replaceAll("\0", "")
          .trim(),
        metadata: { ...source, ...metadata },
      };
    })
    .filter((document) => document.pageContent);
  const length = documents.reduce(
    (total, document) => total + document.pageContent.length,
    0
  );
  if (!length)
    throw invalid("文档中没有可提取的文字，扫描件需先转换为文字文档", 422);
  if (length > MAX_CONTENT) throw invalid("文档正文过长，请拆分后重新上传");
  return documents.map((document) => ({
    ...document,
    metadata: {
      ...Object.fromEntries(
        Object.entries(document.metadata).filter(([key, value]) => {
          if (["location", "filePath", "path"].includes(key)) return false;
          if (!["source", "url"].includes(key)) return true;
          try {
            return ["http:", "https:"].includes(new URL(value).protocol);
          } catch {
            return false;
          }
        })
      ),
      // Internal paths are not public citation URLs.
      format: extension.slice(1),
      ...(Number.isInteger(document.metadata.loc?.pageNumber)
        ? { pageNumber: document.metadata.loc.pageNumber }
        : {}),
      ...(Number.isInteger(document.metadata.pdf?.totalPages)
        ? { totalPages: document.metadata.pdf.totalPages }
        : {}),
      mimeType: mimeDetector.getType(filename),
      token_count_estimate: tokenizeString(document.pageContent),
    },
  }));
}

module.exports = { parseDocument, isWithin };
