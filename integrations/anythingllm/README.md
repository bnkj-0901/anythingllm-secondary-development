# AnythingLLM 源码整合入口

首期复用官方工作台、文档处理、OCR、音频转写、多用户工作空间、检索与引用问答。先运行原版并验证，再补知识发布、图片人工确认和微信等实际缺口。

## 固定版本

上游：[AnythingLLM v1.18.0](https://github.com/Mintplex-Labs/anything-llm/releases/tag/v1.18.0)  \
提交：`3e4f9411b67f2dd7fa9fc6f2b95dfacbda0633ba`  \
许可证：MIT，保留官方版权与许可声明。

`source-lock.json` 是本项目的上游版本基线。源码在根目录 `vendor/anythingllm/`，已作为实际文件纳入项目开发分支；首次基线提交保留完整上游目录树，现有扩展尚未直接修改原版源码。旧本地环境仍可保留嵌套 Git 检出；从项目仓库克隆时不再需要另行克隆底座，`fetch-source.ps1` 会识别项目跟踪的源码。后续源码二次开发以项目分支为准，旧运行时适配的说明保留历史含义。

## 获取与启动

### Windows 本地源码运行（无需 Docker）

需要 PowerShell 7、Git、Node.js，以及本机 Chrome 或 Edge（用于网页资料解析）。启动步骤依据上游 `vendor/anythingllm/BARE_METAL.md`；这是本地试用方式，上游团队不为非容器部署提供支持。

首次安装依赖、编译并启动：

```powershell
.\integrations\anythingllm\start-local.ps1 -Setup
```

依赖和前端构建准备好后，日常启动：

```powershell
.\integrations\anythingllm\start-local.ps1
```

入口为 [http://localhost:3001](http://localhost:3001)。脚本运行数据库迁移，后台启动服务端和文档处理进程，检查两个服务和首页；重复启动复用已有进程，其他程序占用端口时退出并保留该程序。服务只监听 `127.0.0.1`，日志位于 `integrations/anythingllm/data/local-logs/`。

本地配置保存在 `vendor/anythingllm/server/.env`，数据库、原件、向量和模型位于 `vendor/anythingllm/server/storage/`。启动不覆盖已有环境文件，也不重置数据库。备份时应保存这些目录；不要删除源码目录后再获取源码，以免丢失本地数据。

`local-runtime.cjs` 在启动时限制监听地址，并将上游 CollectorApi 的 `0.0.0.0` 请求转换为 Windows 可连接的 `127.0.0.1`，上游跟踪文件保持不变。首次进入保留初始化向导，模型和账号在页面中配置。音频转换另需 FFmpeg；OCR、音频转写和向量模型可能还需下载对应模型文件。

### Docker 源码构建

需要 PowerShell 7、Git、Docker 与 Compose。以下从项目根目录执行：

```powershell
.\integrations\anythingllm\fetch-source.ps1
.\integrations\anythingllm\fetch-source.ps1 -CheckOnly
.\integrations\anythingllm\start.ps1
```

首次启动自动从模板生成本地 `.env`，为签名和会话生成随机密钥，不覆盖已有配置。后续从任意工作目录调用启动脚本均使用本目录的 Compose、环境文件和源码路径。

容器默认只监听 [本机 3001 端口](http://localhost:3001)。首次打开完成管理员初始化、启用多用户模式，并配置聊天模型和 embedding 模型。未配置模型不代表问答可用。图片/语音处理还依赖相应模型和真实样本验证。

模型供应商、密钥和模型名称应在底座设置页或本地环境文件填写。模板配置中文/英文 OCR、关闭遥测，容器按官方提供的 Chromium 参数运行，无需额外授予 SYS_ADMIN。此配置面向本地验证；公网渠道在完成身份和空间授权后接入。

## 持久化

本目录 `.env` 挂载到上游服务实际使用的配置文件路径，保留界面写入的供应商配置。原件与数据库、向量、处理目录使用命名卷，构建/重启不会清空数据。备份需同时包含环境文件和命名卷；本项目脚本没有删除卷或重置数据的命令。

## 验证

```powershell
.\integrations\anythingllm\start.ps1 -CheckOnly
docker compose --project-directory integrations/anythingllm -f integrations/anythingllm/docker-compose.yml ps
```

源码校验会检查提交、关键文件和上游是否被改动。配置检查不会启动容器。完整 smoke test 还需 Docker 服务运行、配置好模型，并实际完成“创建空间—上传—索引—提问—查看原文”。

## 当前验证边界

2026-10-15 已在 Windows 11 / Node.js 22.22.2 下安装上游锁定依赖、编译前端并应用 40 个数据库迁移；服务端 3001 和文档处理 8888 均只监听 `127.0.0.1`。重复启动复用已有进程。启动时已验证首页、`/api/ping`、初始化状态、服务端到文档处理服务的健康检查和文件类型接口。随后隔离的 Chrome 浏览器确认中文登录页正常，未捕获运行错误或请求失败；账号启用后受保护接口对匿名请求返回 401。

复查服务和浏览器：

```powershell
node .\integrations\anythingllm\verify-local.cjs
```

该检查不会登录或修改模型设置；截图保存到本地日志目录。上游跟踪源码仍未修改。当前主机没有 Docker，官方容器构建尚未验证。扩展已通过虚构文字/TXT 资料、真实模型索引与引用问答，以及图片识别人工确认的本地验证，记录见下方；业务资料完整评测、真实微信登录仍未验收。

## 实施任务

### 自助注册、个人后台与知识库分类（本地源码运行）

新增 [H5 登录](http://localhost:3001/h5)、[自助注册](http://localhost:3001/register)、[个人后台](http://localhost:3001/portal) 和 [注册/微信配置](http://localhost:3001/access/admin)。新用户为普通用户，可管理自己的私有知识库；公共知识库对所有登录用户可查阅与问答，由平台管理员维护。原版用户管理继续使用 `/settings/users`；私有库对其他用户隔离，平台管理员保留管理权。

扩展复用现有用户、工作空间、Collector、向量与聊天模型，未修改上游跟踪源码。新增配置和权限保存在已有 SQLite，整份微信配置用原版签名密钥加密，备份必须同时保留原 `.env` 的 SIG_KEY/SIG_SALT 与数据库。已有工作空间由管理员主动分类，不会自动公开。

微信资质尚未提供，配置入口与 H5/扫码授权流程已实现，真实微信回调需另行联调。上述扩展目前由 `start-local.ps1` 启用，Docker Compose 尚未接入。权限和配置细节见 [权限说明](../../docs/access-matrix.md)，已完成的真实资料验证见 [验证记录](../../docs/verification-self-service-2026-10-15.md)。

```powershell
node --test .\integrations\anythingllm\access\tests\*.test.cjs
node .\integrations\anythingllm\access\verify-browser.cjs
```

增加 `--with-ingestion` 可验证真实文字/文件入库、模型问答与引用，会使用现有模型并产生少量调用费用，结束后清理测试账号与资料。

### 图片识别录入（2026-10-16）

也可在原聊天窗口发送一张图片，输入“识别这张图片存入知识库”。系统回复“打开图片核对页面”，点击即可核对并确认；普通问答与正在进行的智能体会话均支持。此路径复用同一 OCR 草稿服务，不依赖 DeepSeek 的图片能力。原有未分类库的管理员可直接核对，不会自动改变知识库分类或成员权限。

原有未分类库在个人后台下方“原有知识库”中点击“管理资料 / 核对图片”；聊天右下角的“图片录入与核对”也可直接打开当前库的资料管理。

[个人后台](http://localhost:3001/portal) → 知识库“管理资料” → “图片识别录入”。每次上传一张 JPG、PNG 或 WebP，最大 10MB；关闭云识别时复用上游 OCRLoader 和已安装的 Tesseract/Sharp。[平台配置](http://localhost:3001/access/admin) 的“图片识别 · 阿里百炼”可单独启用视觉/OCR 模型，复用同一接口的阿里密钥或填写独立密钥。启用后原图会发送到阿里并按模型计费，不改变当前聊天和向量配置。

识别结果进入待确认草稿，可对照原图修改并保存，刷新后继续核对。明确勾选确认后才建立知识索引；后端绑定版本、原图哈希、最终文字、确认人和时间。公共库的待确认草稿仍只允许上传者和平台管理员访问；已入库原图依当前库权限访问，移出资料后不再向公共阅读者共享。取消窗口保留草稿，“删除草稿”清理该草稿及原图；已确认资料的“移出知识库”仍保留平台原件。

图片与预览存于 `server/storage/knowledge-images/`，草稿、确认快照存于原数据库的 `kb_access_image_*` 设置行；加密的图片识别配置在 `kb_access_vision`。备份应覆盖整个存储目录及 `.env` 中的签名加密密钥。OCR 语言缓存位于 `server/storage/models/tesseract/`，首次本地识别可能联网下载语言模型。同时最多识别两张，本地子进程最多 150 秒，百炼整个识别任务共享 120 秒。带重复同色标题带和长竖线的密集表格会切成最多 12 个连续分区，依次识别、全部成功后合并；普通图片仍单次识别。分区增加模型调用次数，按供应商规则计费。页面展示本次实际模型及已完成分区数，未确定模型时不会误报本地 OCR。重启中断的任务标记失败，可重新识别、人工填写或重试已确认的索引。重新识别保留上一版已保存文字供对照，版本更新使旧确认失效。

```powershell
node .\integrations\anythingllm\access\verify-images.cjs
node .\integrations\anythingllm\access\verify-images.cjs --chat
node .\integrations\anythingllm\access\verify-agent-images.cjs
```

该命令使用生成的虚构图片和临时普通账号，验证真实 OCR、人工更正、持久草稿、现有向量模型入库、来源与撤权，并清理测试数据。入库会调用现有向量服务。详见 [图片上传验证记录](../../docs/verification-image-upload-2026-10-16.md)。

见 [当前任务清单](../../tasks/todo.md)。首个交付目标是可试用的文字/文档知识库；后续验证空间隔离，补齐人工确认和版本发布，再连接微信。ERP 和 App 保留到后续阶段。
