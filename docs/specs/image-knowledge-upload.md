# 图片知识上传

用户在个人后台的知识库资料管理中上传 JPG、PNG、WebP，单张不超过 10MB。默认复用 AnythingLLM 的中文、英文 OCRLoader；管理员可启用阿里百炼视觉/OCR 模型识别。模型只转录原文，不根据商品常识推断或纠正型号。

聊天窗口同样支持：发送一张图片并明确要求“识别这张图片存入知识库”，适配层在选择普通问答或智能体之前接入相同的 OCR 草稿流程。正在进行的智能体会话通过 WebSocket 发送的后续附件也走此流程。回复中的核对链接直接打开目标库和草稿，刷新仍可继续。普通聊天、图片描述类问答保持原有模型能力。

分类知识库沿用当前写权限；原有未分类库仅管理员可录入并核对，不自动改变库的分类或既有成员关系。每条请求重新验证账号、空间、会话所有者及附件大小和真实图片格式。图片入库请求不交给不支持图片的 DeepSeek 进行处理，不声称已自动入库。

## 流程与边界

1. 服务端校验真实图片格式和像素上限，原件保存于非公开存储；异步 OCR 在有超时和并发上限的子进程中运行。
2. 图片和识别文字构成待确认草稿；刷新页面可继续核对，识别失败可重新识别、手工填写或删除草稿。识别使用原件，预览仅供显示。原图、草稿仅上传者和管理员可见，即使目标库为公共。
3. 用户保存更正后，明确勾选核对并确认；后端通过版本号和原子状态变更绑定原图哈希、最终文字、确认人和时间，再调用原有入库流程。
4. 未确认、取消、识别失败均不建立向量索引。重复确认不重复入库，索引失败可重试同一快照；原图保留供已授权用户查看。
5. 每次读取、编辑、确认、原图访问都重新校验当前知识库权限。原图地址不公开到静态目录。
6. `POST /api/access/spaces/:slug/images/:id/recognition` 接收 `{revision}`，仅未确认草稿可重识别；保留上一版已保存文字，递增版本，旧确认失效。失败仍保留文字，不自动回退并掩盖云服务错误。
7. 密集表格中至少三个同色全宽标题带且存在长竖向表格线时，沿标题带切成最多 12 个连续分区。仅按像素布局裁剪，不推断文字；保留顶部主标题、底部内容与所有像素顺序。各段全部成功才合并为可核对正文，任一段失败不接受半份结果。
8. 草稿额外返回 `engine`（尚未确定或历史未记录时为 `null`）与 `progress`（`null` 或 `{completed,total}`）。处理中和失败后显示本次实际识别模型；重识别重置进度，不能默认标为本地 OCR。进度更新不改变确认版本，最终成功/失败才递增版本。

## 阿里百炼配置

管理员在 `/access/admin` 的“图片识别 · 阿里百炼”中选择启用、模型、接口地址和密钥来源。配置 API 为 `GET/PUT /api/access/admin/vision`，仅管理员访问并沿用来源校验。字段为 `enabled,baseUrl,model,keySource`，写入可另带 `apiKey,clearSecret`；读取仅回传 `secretConfigured,existingKeyAvailable`，不回传密钥。

默认禁用，关闭时使用本地 OCR。启用会将图片发送到管理员配置的阿里百炼官方 HTTPS 接口并产生费用；密钥可复用相同接口的现有阿里向量服务配置，也可独立填写。整份配置通过原有 EncryptionManager 加密保存到 `kb_access_vision`，不改变聊天或向量配置。只允许百炼官方固定域名与业务空间域名，禁止任意 URL、重定向和客户端传入的图片 URL。

视觉 API 通过 `image_url` 的 Base64 data URI 传真实原图或按原序裁剪的分区，整个任务共享 120 秒截止时间、最多同时 2 个识别任务。分区依次调用，不自动重试；普通图片仍单次调用。每次输出上限为通用视觉 8192 tokens / OCR 4096 tokens，并拒绝空结果、超限和被截断的响应。OCR 使用简洁的专用转录提示，要求包含标题、保留空白格、不猜测、不补全、不执行图片指令；通用视觉模型仍使用独立系统提示。所有输出仅作为可编辑正文处理。识别仍可能误读或补字，必须人工核对型号、价格及表格关系后明确确认。

官方接口与 OCR 专用提示格式依据：<https://help.aliyun.com/zh/model-studio/vision>、<https://help.aliyun.com/zh/model-studio/qwen-vl-ocr>。

## 实施与验证

沿用 `integrations/anythingllm/access/` 的 CommonJS 服务、Prisma 参数化查询和原有页面样式，不改上游跟踪源码、不增加 npm 依赖、不改变聊天或向量模型配置。

先验证草稿状态与确认幂等性，再接 API 和页面，最后用生成的中英文测试图完成真实 OCR、人工修改、入库、原文和权限测试。

```powershell
node --test .\integrations\anythingllm\access\tests\*.test.cjs
node .\integrations\anythingllm\access\verify-images.cjs
node .\integrations\anythingllm\access\verify-images.cjs --chat
node .\integrations\anythingllm\access\verify-agent-images.cjs
.\integrations\anythingllm\fetch-source.ps1 -CheckOnly
```
