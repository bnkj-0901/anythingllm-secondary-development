const express = require("express");
const multer = require("multer");
const path = require("path");
const store = require("./store");
const { requireAuth, refreshContext, fail } = require("./auth");
const { getTTSProvider } = require("../utils/TextToSpeech");
const { getSTTProvider } = require("../utils/SpeechToText");
const { messageToSpeech } = require("../utils/TextToSpeech/messageToSpeech");
const { getAudioFileInfo } = require("../utils/TextToSpeech/audioFormat");
const { Chat } = require("../models/workspaceChats");
const { safeJsonParse } = require("../utils/http");

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res)).catch(next);

async function ownMessage(ctx, id) {
  const record = await Chat.get(ctx, { id: Number(id) }, store.orm);
  const response = safeJsonParse(record?.response, {}) || {};
  if (!record || typeof response.text !== "string" || !response.text.trim())
    throw fail(404, "消息不存在或无权访问");
  return { content: response.text };
}

function registerMedia(app) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 0, parts: 2 },
    fileFilter: (_req, file, done) =>
      file.mimetype?.startsWith("audio/")
        ? done(null, true)
        : done(fail(400, "仅支持上传音频文件")),
  }).single("audio");

  // Keep the upstream recording/transcription UI and provider implementations.
  // Only authentication and upload error handling differ for SaaS users.
  router.post(
    "/system/transcribe-audio",
    requireAuth,
    upload,
    wrap(async (req, res) => {
      if (!req.file?.buffer?.length) throw fail(400, "请上传音频文件");
      if (!process.env.STT_PROVIDER || process.env.STT_PROVIDER === "native")
        throw fail(400, "当前使用浏览器语音识别，无需上传音频");
      let text;
      try {
        text = await getSTTProvider().transcribe(
          req.file.buffer,
          path.basename(req.file.originalname || "audio.webm")
        );
      } catch {
        throw fail(502, "语音识别失败，请检查平台语音配置");
      }
      await refreshContext(req.ep);
      res.json({ success: true, text: typeof text === "string" ? text : "" });
    })
  );

  router.get(
    "/enterprise/messages/:id/tts",
    requireAuth,
    wrap(async (req, res) => {
      const message = await ownMessage(req.ep, req.params.id);
      const text = messageToSpeech(message.content);
      res.set("Cache-Control", "private, no-store");
      if (!text) return res.status(204).end();
      if (
        !process.env.TTS_PROVIDER ||
        ["native", "piper_local"].includes(process.env.TTS_PROVIDER)
      )
        throw fail(400, "当前使用浏览器语音播放，无需请求服务器");
      let buffer;
      try {
        buffer = await getTTSProvider().ttsBuffer(text);
      } catch {
        throw fail(502, "语音生成失败，请检查平台语音配置");
      }
      if (!Buffer.isBuffer(buffer) || !buffer.length)
        throw fail(502, "语音生成失败，请检查平台语音配置");
      // Generation can outlive a password change, suspension or conversation
      // deletion. Recheck before releasing private message audio.
      await refreshContext(req.ep);
      await ownMessage(req.ep, req.params.id);
      res.type(getAudioFileInfo(buffer).mime).send(buffer);
    })
  );

  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    const status = tooLarge
      ? 413
      : error instanceof multer.MulterError
        ? 400
        : error.status || 502;
    res.status(status).json({
      success: false,
      error: tooLarge
        ? "音频文件不能超过 25 MB"
        : error instanceof multer.MulterError
          ? "音频上传格式无效"
          : error.status
            ? error.message
            : "语音处理失败，请稍后重试",
    });
  });
  app.use("/api", router);
}

module.exports = { registerMedia };
