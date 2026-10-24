# Knowledge document parser

`yarn dev` / `yarn start` 统一使用 `index.js`，由 `app.js` 注册 `GET /`、`GET /health`、`GET /accepts`、`POST /parse`，并复用原版内部纯工具接口 `POST /util/get-link`、`POST /util/convert-audio-to-wav`、`POST /process-raw-text` 和 `POST /ext/resync-source-document`。数据连接器通过内部 `POST /ext/import` 返回解析结果。没有第二套启动入口。原版格式分派器与提取器继续复用。

`POST /parse` 接收 `{ filename, options: { absolutePath } }`，通过 `X-Integrity` 对精确正文做 RSA-SHA256 校验。真实路径必须位于 `STORAGE_DIR/enterprise`。文件大小与正文长度可由部署设置 `KNOWLEDGE_MAX_FILE_BYTES`、`KNOWLEDGE_MAX_CONTENT_CHARACTERS` 限制，默认不另设产品配额。server 与 collector 需共享相同的 `STORAGE_DIR` 和 `comkey` 公钥。

所有上传文件（包括 TXT、MD）直接调用原 `processSingleFile` 分派器与原格式提取器。预设格式沿用 `utils/constants.js`，包括办公文档、EPUB、MBOX、图片 OCR 和音视频转写；未列出的后缀交原 `isTextType` 判断，识别为文字时按 TXT 解析，二进制或明确的非文字 MIME 返回安全失败。server 与网页只限制大小和权限，不再把预设后缀当作上传白名单。

新增 `returnDocuments` 分支只把结果返回给 server，不写全局 documents、不删除上传原件。PDF 页码通过白名单映射为引用元数据，响应不含本地 source 路径。HTML、XLSX、OCR、文本编码与 Whisper 选项沿用原实现。OCR 与音视频转写需要相应的本地模型或配置好的服务；音频转换需要 `ffmpeg`（Docker 镜像已安装）。

两个 `/util/*` 接口原样复用原路由处理、`verifyPayloadIntegrity`、`reqBody`、链接提取和音频转换实现，不接入新的用户或知识发布逻辑。路由专属文本解析接收 `application/json` 和 `text/plain`，沿用原版 `3GB` 请求正文上限，保留签名前的原始正文；这不是上传文档的文件大小配置。原中间件继续应用 `options.runtimeSettings`，也保留原版开发模式跳过签名的行为。生产环境验证 `X-Integrity`。服务应只在内部网络访问，不直接暴露给浏览器。

原 `CollectorApi` 传递的 OCR/Whisper 选项可能包含配置好的转写服务密钥。RSA 签名只提供完整性和来源校验，不加密正文。链接工具网页分支只返回文本，文件链接分支沿用原版下载和 `direct-uploads` 临时解析文件行为；音频转换沿用原版删除 hotdir 源文件、由调用者读取并清理 WAV 结果的约定。这两个工具不会创建租户知识库授权。

当前未挂载的原路由与依赖原因：

| 原路由                                      | 当前不挂载的原因                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/process`                                  | 原流程向全局文件池发布，缺少本产品知识库、租户和用户归属；当前文件/文字均先通过 server 的知识库权限检查。                 |
| `/process-link`                             | 原流程向全局文件池发布；知识库网页导入由原 WebsiteDepth 连接器经 `/ext/import` 返回结果。链接提取源码与转换选项测试保留。 |
| 原连接器直接发布路由，如 `/ext/github-repo` | 不再允许绕过 server 发布全局资料；原连接器引擎通过 `/ext/import` 的 return-only 模式复用。                                |

`/process-raw-text` 沿用原文字与元数据处理，强制仅返回结果给 server；`/ext/resync-source-document` 沿用原来源刷新引擎，返回正文，由 server 以监控创建用户的当前权限执行资料变更。公有库刷新内容仍须审批，原已批准版本持续可读。两条接口验证精确正文签名，不能绕过 server 直接发布知识。

`/ext/import` 接收签名正文 `{ connector, args }`，复用原 GitHub、GitLab、Gitea、Confluence、Drupal Wiki、Obsidian、Paperless-ngx、YouTube 和 WebsiteDepth 解析引擎，强制只返回文档。server 先校验目标知识库，再调用提取；结果统一走文字入库权限，私有库直接索引，公有库形成待审批候选。原仓库分支发现接口保留；原引擎的默认调用和元数据格式保持，连接凭据不向普通文档响应暴露。

未挂载的接口返回 404；不能仅因源码仍在就视为产品已支持这些入口。

collector 默认端口为 8888，可配置 `COLLECTOR_PORT`。server 负责租户、用户、知识权限、原件存储、正文持久化和向量索引；collector 不决定知识归属与可见性。

新增测试验证签名、路径边界、原件保留、禁止全局发布及原解析接线。`OCR_INTEGRATION=1` 可启用额外真实 OCR 检查；默认测试使用受控 OCR 返回，不代表真实 OCR 推理已经验收。
