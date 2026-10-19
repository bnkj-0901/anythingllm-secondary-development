const path = require("node:path");
const { createRequire } = require("node:module");
const { fork } = require("node:child_process");
const { requireServer, serverDirectory } = require("./dependencies.cjs");
const { AccessError } = require("./service.cjs");
const requireCollector = createRequire(path.resolve(serverDirectory, "../collector/package.json"));
async function validateImage(buffer) {
  if (!buffer?.length || buffer.length > 10 * 1024 * 1024) throw new AccessError(422, "invalid_image", "图片最大 10MB。");
  try {
    const sharp = requireCollector("sharp");
    const image = sharp(buffer, { limitInputPixels: 32_000_000, failOn: "error" });
    const meta = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(meta.format) || (meta.pages || 1) !== 1) throw new Error("Unsupported image");
    const preview = await image.rotate().resize({ width: 2400, height: 3200, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).png().toBuffer();
    return { preview, mime: { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" }[meta.format] };
  } catch { throw new AccessError(422, "invalid_image", "请选择有效的 JPG、PNG 或 WebP 静态图片，最多 3200 万像素。"); }
}
function recognize(file) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, "ocr-worker.cjs"), [file], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error("OCR timeout")); }, 150_000);
    child.once("error", reject);
    child.once("message", result => typeof result.text === "string" ? resolve(result.text) : reject(new Error("OCR failed")));
    child.once("exit", () => { clearTimeout(timer); reject(new Error("OCR worker ended")); });
  });
}
function imageOptions(prisma, ingest, vision) {
  const { createImageDrafts } = require("./image-drafts.cjs");
  const recognizeImage = async (file, mime, progress) => {
    const result = await vision?.recognize(await require("node:fs/promises").readFile(file), mime, progress);
    if (result) return result;
    await progress({ engine: "local", completed: 0, total: 1 });
    const text = await recognize(file);
    await progress({ engine: "local", completed: 1, total: 1 });
    return text;
  };
  const images = createImageDrafts({ prisma, directory: path.resolve(process.env.STORAGE_DIR || path.join(serverDirectory, "storage"), "knowledge-images"), recognize: recognizeImage, ingest });
  const ready = images.recover();
  const multer = requireServer("multer");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 }, fileFilter: (_req, file, done) => done(/\.(jpe?g|png|webp)$/i.test(file.originalname) ? null : new AccessError(422, "invalid_image", "支持 JPG、PNG、WebP 图片，最大 10MB。"), true) }).single("file");
  return { images, validateImage, ready, imageUploadMiddleware(req, res, next) {
    ready.then(() => upload(req, res, error => {
      if (error) return next(error instanceof AccessError ? error : new AccessError(422, "invalid_image", "每次上传一张 JPG、PNG、WebP 图片，最大 10MB。"));
      // Multer's originalname uses latin1 for multipart headers.
      if (req.file) req.file.originalname = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      next();
    }), next);
  } };
}
module.exports = { imageOptions, validateImage, recognize };
