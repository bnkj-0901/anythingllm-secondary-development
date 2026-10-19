const { randomUUID } = require("node:crypto");
const { AccessError, fail } = require("./service.cjs");
const { spacePolicy, canRead, canWrite } = require("./space-policy.cjs");
const maxBytes = 10 * 1024 * 1024;
function wantsImageKnowledge(message, attachments) {
  return typeof message === "string" && Array.isArray(attachments) && attachments.some(item => /^image\//i.test(item?.mime || "") || /^data:image\//i.test(item?.contentString || ""))
    && (/(?:知识库|资料库)/.test(message) && /存|添加|写入|加入|录入|上传|收录|导入|放|入库/.test(message) || /(?:图片|图像|照片|识别).*入库/.test(message));
}
function decodeAttachment(attachments) {
  if (attachments.length !== 1) fail(422, "one_image", "图片入库请每次发送一张图片，单张最大 10MB。");
  const item = attachments[0], value = item?.contentString;
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 + 64) fail(422, "invalid_image", "图片最大 10MB，请压缩后重新发送。");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) fail(422, "invalid_image", "图片附件格式无效，请重新发送 JPG、PNG 或 WebP 图片。");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > maxBytes || buffer.toString("base64") !== match[2]) fail(422, "invalid_image", "图片附件无效或超过 10MB，请重新发送。");
  const name = (typeof item.name === "string" ? item.name.split(/[\\/]/).pop() : "图片资料").replace(/[\x00-\x1f]/g, "").slice(0, 150) || "图片资料";
  return { file: { originalname: name, buffer }, attachment: { name, mime: match[1], contentString: value } };
}

// Runs before upstream chooses RAG or agent mode. All OCR and indexing remain
// in the shared draft service; neither the model nor this bridge can confirm it.
function installImageChat({ prisma, images, validateImage, ready = Promise.resolve(), stream, websocket, canSendChat = async () => true }) {
  async function respond({ workspace, user, thread, message, attachments }) {
    const uuid = randomUUID();
    try {
      const currentUser = user?.id && await prisma.users.findUnique({ where: { id: user.id } });
      if (!currentUser || currentUser.suspended) fail(403, "login_required", "请登录有效账号后再上传图片。");
      const currentSpace = workspace?.id && await prisma.workspaces.findUnique({ where: { id: workspace.id } });
      const policy = currentSpace && await spacePolicy(prisma, currentSpace.id);
      if (!currentSpace || (policy && !canRead(policy, currentUser))) fail(404, "space_not_found", "知识库不存在或你没有访问权限。");
      if (policy ? !canWrite(policy, currentUser) : currentUser.role !== "admin") fail(403, "space_read_only", policy ? "公共知识库由管理员维护，请在自己的私有知识库中上传图片。" : "该知识库尚未分类，请由管理员分类后再上传图片。");
      if (thread?.id && !await prisma.workspace_threads.findFirst({ where: { id: thread.id, workspace_id: currentSpace.id, user_id: currentUser.id } })) fail(404, "thread_not_found", "会话不存在或你没有访问权限。");
      if (!await canSendChat(currentUser)) fail(429, "chat_limit", "今日对话次数已达上限，请稍后再试。");
      const decoded = decodeAttachment(attachments);
      await ready;
      const draft = await images.create(currentSpace, currentUser, decoded.file, validateImage);
      const link = `/portal?space=${encodeURIComponent(currentSpace.slug)}&image=${draft.id}`;
      const textResponse = `已收到图片，正在识别文字并生成待核对草稿。\n\n[打开图片核对页面](${link})\n\n请对照原图核对并修改文字，勾选确认后点击“确认入库”。确认前不会加入知识库。`;
      const chat = await prisma.workspace_chats.create({ data: { workspaceId: currentSpace.id, user_id: currentUser.id, thread_id: thread?.id || null, prompt: message, response: JSON.stringify({ text: textResponse, sources: [], attachments: [decoded.attachment], type: "chat", knowledgeImageId: draft.id }) } });
      return { uuid, type: "textResponse", textResponse, sources: [], close: true, error: null, chatId: chat.id };
    } catch (error) {
      if (!(error instanceof AccessError)) console.error("[KnowledgeImageChat] Request failed", error.code || error.name);
      return { uuid, type: "textResponse", textResponse: error instanceof AccessError ? error.message : "图片处理未完成，请在个人后台查看草稿或稍后重试。", sources: [], close: true, error: null };
    }
  }
  const originalStream = stream.streamChatWithWorkspace;
  stream.streamChatWithWorkspace = async function (response, workspace, message, chatMode, user, thread, attachments, ...rest) {
    if (!wantsImageKnowledge(message, attachments)) return originalStream.call(this, response, workspace, message, chatMode, user, thread, attachments, ...rest);
    const result = await respond({ workspace, user, thread, message, attachments });
    if (!response.writableEnded && !response.destroyed) response.write(`data: ${JSON.stringify(result)}\n\n`);
  };
  // Active agent sessions send subsequent messages over the existing websocket.
  // Keep the agent paused after OCR, then wait for its next ordinary message.
  const originalPlugin = websocket.plugin;
  websocket.plugin = function (config) {
    const plugin = originalPlugin.call(this, config), originalSetup = plugin.setup;
    plugin.setup = function (aibitat) {
      const result = originalSetup.call(this, aibitat), socket = config.socket, ask = socket.askForFeedback;
      socket.askForFeedback = async function (...args) {
        for (;;) {
          const input = await ask.apply(this, args);
          if (!wantsImageKnowledge(input.feedback, input.attachments)) return input;
          const invocation = aibitat.handlerProps?.invocation;
          const reply = await respond({ workspace: invocation?.workspace, user: { id: invocation?.user_id }, thread: invocation?.thread_id ? { id: invocation.thread_id } : null, message: input.feedback, attachments: input.attachments });
          if (socket.readyState !== socket.OPEN) return { feedback: "exit", attachments: [] };
          socket.send(JSON.stringify({ type: "reportStreamEvent", content: { type: "fullTextResponse", uuid: reply.uuid, content: reply.textResponse } }));
          if (reply.chatId) socket.send(JSON.stringify({ type: "reportStreamEvent", content: { type: "chatId", uuid: reply.uuid, chatId: reply.chatId } }));
        }
      };
      return result;
    };
    return plugin;
  };
}
module.exports = { installImageChat };
