const { TextDecoder } = require("util");

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Busboy interprets a plain multipart filename as Latin-1, while browsers send
// UTF-8 bytes. Decode at the upload boundary only. filename* may already be
// Unicode, and older clients may send real Latin-1, so neither can be coerced.
function decodeUploadFileName(filename) {
  if (typeof filename !== "string") return filename;
  for (const character of filename)
    if (character.codePointAt(0) > 255) return filename;
  try {
    return utf8.decode(Buffer.from(filename, "latin1"));
  } catch {
    return filename;
  }
}

module.exports = { decodeUploadFileName };
