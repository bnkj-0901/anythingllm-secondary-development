# 图片知识上传验证 · 2026-10-16

Windows 本地源码运行，复用固定版本 AnythingLLM v1.18.0 的 OCRLoader（Tesseract 6.0.1）与 Sharp 0.33.5，不修改上游跟踪文件、不新增 npm 依赖。页面沿用现有设计样式，原图与确认协议在适配层实现。

## 已验证

- 密集型号表修复后，36 项后端测试通过，新增覆盖连续分区不丢像素、独立主标题保留、非表格不分区、分段图片字节及顺序、共享截止时间、任一段失败拒绝半份结果，以及处理中/失败后的实际模型与进度。首次完整图调用复现 `finish_reason=length`，4096 tokens 后出现重复型号；分区加简洁提示后 `qwen3.5-ocr` 仍在真我区域返回 `finish_reason=repeated`，故未接收残缺结果。现为重复生成提供可操作的安全错误。
- 用户原件 `bf6131d74fe76b23fd7aec44931738ab`（1290×1880）按像素布局切为 9 段，起点为 `0,331,496,629,835,1079,1254,1466,1774`，覆盖全高 1880，保留黄色主标题。切换图片识别至阿里 `qwen3-vl-plus` 后，真实页面约 57 秒完成，状态 `ready`、进度 `9/9`、正文 2848 字符。抽查标题、9 个品牌和首末单元格等 20 个文本片段均保留（忽略空白及大小写，不代表全图准确率）；末行按原图印刷的 `荣耀Mgic V Flip` 保留，未按商品常识改为 `Magic`。仍有 `1/l`、`O/0` 等歧义，需逐项核对。
- 密集图真实浏览器验证处理中实际显示 `qwen3-vl-plus` 和 `0/9` 分区进度，完成后正文与服务端一致、刷新可恢复、上一版保留、确认按钮默认禁用。320/768/1024/1440 宽度无页面横向溢出，未捕获浏览器运行错误。原图哈希不变、无确认快照、正式资料数未增加。证据：`vision-dense-progress.png`、`vision-review-320.png`、`vision-review-1440.png`。仅更换图片识别模型，未改聊天/向量配置。
- 新增阿里视觉/OCR 接入后，29 项后端测试通过：管理员配置隔离、密钥保留及加密、官方接口限制、真实图片字节传递、输出被截断/失败校验，以及重识别版本冲突、上一版保留、失败保留正文和已确认草稿禁止重识别。
- 经用户选择阿里百炼后，在隔离 Chrome 中复用现有阿里连接，开启图片识别。早先的 1440×1169 表格实测：`qwen3-vl-plus` 约 24 秒、`qwen3.5-ocr` 约 7–9 秒。后者抽查的 24 个内存/数字/型号文本片段均出现，包括原图印刷的 `16+356`；这是样本抽查，不代表全图准确率。仍观察到顶部标题遗漏、`XFlip` → `XF1ip`、`XFold3` → `XP0ld3` 等错误，因此继续要求人工核对，未确认、未建立知识索引。
- 首次接入时已在真实页面验证管理员保存模型配置、旧草稿重新识别、展示识别模型、上一版文字对照、确认按钮默认禁用、刷新结果保留及 320/768/1024/1440 宽度无横向溢出。原图哈希与所属空间不变，正式资料数未增加，未捕获浏览器运行错误。当前本地启用 `qwen3-vl-plus`；可在平台配置改用其他有权限的视觉模型或关闭云识别。

- 22 项后端测试通过：既有权限和图片草稿测试，以及聊天图片接入、会话所有权、未分类库核对、禁用账号、伪造/超限附件、普通聊天兼容等回归测试。
- 原聊天窗口上传图片并要求入库：自动模式下在调用模型之前生成 OCR 草稿、聊天回复持久保存、刷新后核对链接仍有效，链接直接打开原图与识别结果。接着完成人工更正、草稿保存/刷新、真实阿里向量服务入库、原图权限与撤权验证。浏览器无运行错误。
- 实际启动 DeepSeek 智能体并等待后续输入，通过同一 WebSocket 发送图片和入库要求，收到可见且可持久恢复的核对链接，未确认时资料数为零。验证截图 `agent-image-chat.png`。该测试调用一次现有聊天模型。
- 原有未分类库在个人后台提供“管理资料 / 核对图片”，聊天右下角提供当前库的“图片录入与核对”。用隔离管理员、未分类库和已有待确认图片验证入口可见、打开草稿、空间链接直达及 320/768/1024/1440 宽度；不自动分类、不入库。先验证缺少入口的断言失败，再添加入口后通过。
- 隔离 Chrome 中，普通用户注册、创建私有库、上传生成的中英文营业时间测试图；真实 OCR 提取出时间、星期与电话，初始正式资料数为零。
- 人工改写识别文字，保存草稿，关闭窗口并刷新后内容仍在。勾选确认后调用现有阿里 `text-embedding-v4` 和 LanceDB 建立索引，仅创建一份资料。原文显示人工最终值，并可查看来源原图。
- 直接 HTTP 检查：公共库中的待确认原图不向其他普通用户开放，他人不能确认；缺少明确确认被拒绝；重复确认不增资料；正式公共原图允许读取，改为私有立即拒绝；资料移出后不再共享原图。
- 320、768、1024、1440 宽度无横向溢出；原图/文字在手机上下布局、桌面左右布局。无浏览器运行错误。
- 原有自助注册、私有/公共空间、原版工作台登录、管理员配置和退出同步浏览器回归通过；本地服务健康检查与上游源码校验通过。

## 实现与接口

API 前缀为 `/api/access/spaces/:slug/images`，沿用原有会话、请求来源检查、写入限流和知识库权限。

| 方法与路径 | 输入 | 输出/作用 |
|---|---|---|
| GET `/` | 无 | `{drafts}`，最多 100 条未入库草稿，仅上传者/管理员可见 |
| POST `/` | multipart `file` | 202 `{draft}`，校验原件后开始异步 OCR |
| GET `/:id` | 无 | `{draft}`，草稿上传者或管理员可读 |
| GET `/:id/original` | 可选 `preview=1` | 按权限返回原图或规范化 PNG 预览，禁止缓存 |
| PATCH `/:id` | `{revision,title,text}` | 保存核对结果，更新版本；过期版本 409 |
| POST `/:id/confirm` | `{revision,confirmed:true}` | 原子锁定快照并入库，重复已完成请求返回原状态 |
| POST `/:id/recognition` | `{revision}` | 重新识别原件，保留上一版已保存文字，更新版本；旧版本/已确认草稿 409 |
| DELETE `/:id` | 无 | 仅未确认且非处理中的草稿可删除 |

草稿输出字段为 `id,title,text,status,revision,error,createdAt`，新增 `engine,progress,warning,previousRecognition`。`engine` 未确定或历史未记录时为 `null`，不默认显示本地 OCR；`progress` 为 `null` 或 `{completed,total}`。分段进度不改变确认版本，识别最终成功/失败递增版本。状态依次为 `recognizing` → `ready`/`failed` → `indexing` → `indexed`/`index_failed`；失败索引冻结确认快照供重试。OCR 原始文字另存于内部记录，编辑不覆盖它。重新识别保留上一版已保存文字；未保存的编辑需先保存。服务启动将中断的 OCR/索引标记为失败。

`GET/PUT /api/access/admin/vision` 仅管理员可访问，用于启用/关闭、模型、官方接口地址及密钥来源。配置加密保存，不回传 API Key。调用只传当前图片，不传会话、其他资料、账号或密钥到模型提示中。供应商失败不静默改用本地 OCR；显示经过处理的错误，可手工编辑或重试。接口依据阿里官方 [视觉理解](https://help.aliyun.com/zh/model-studio/vision) 和 [文字提取](https://help.aliyun.com/zh/model-studio/qwen-vl-ocr) 文档。

原图哈希与最终文字哈希、版本、确认人和确认时间均在服务端生成。发布前校验原图哈希，数据库按旧值进行原子比较更新。入库使用稳定文档路径；重试先查该路径是否已经关联该库，避免已成功请求因响应中断而重复入库。沿用底座向量服务的失败处理，本次不声称数据库与外部向量库具有跨系统事务。

## 命令与证据

```powershell
node --test .\integrations\anythingllm\access\tests\*.test.cjs
node .\integrations\anythingllm\access\verify-images.cjs
node .\integrations\anythingllm\access\verify-images.cjs --chat
node .\integrations\anythingllm\access\verify-agent-images.cjs
node .\integrations\anythingllm\access\verify-legacy-images.cjs
node .\integrations\anythingllm\access\verify-browser.cjs
node .\integrations\anythingllm\verify-local.cjs
.\integrations\anythingllm\fetch-source.ps1 -CheckOnly
```

截图为 `integrations/anythingllm/data/local-logs/image-review-320.png` 与 `image-review-1440.png`。测试只生成虚构资料与临时账号，结束后清理其数据库、向量关联、图片原件与测试文档；语言模型缓存保留供实际使用。

## 边界

这是图片文字录入，支持 JPG/PNG/WebP 静态图，10MB、3200 万像素上限。本地 OCR 和云模型均不保证正确，仍可能漏字、错字、补字；不能按产品常识自动更正原图型号。手写、模糊单据、其他表格、扫描 PDF 还需更多业务样本评测。外观识物、自动判断型号、语音录入未纳入本次功能。没有修改用户现有聊天与向量模型配置。

原图、预览在 `server/storage/knowledge-images/`；记录在现有 SQLite。需要同时备份整个存储目录和环境配置。当前是单进程本地适配器，Docker、多实例队列、公网部署、长期配额和备份恢复演练仍未验收。
