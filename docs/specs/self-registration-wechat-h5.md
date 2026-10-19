# 自助注册、H5 与微信登录

日期：2026-10-15。实施授权来自用户“多用户管理用户要能自助注册要有 H5 微信登录”。本增量只补身份入口，复用现有用户、用户管理、工作空间权限和 Simple SSO，不改 RAG 与 ERP/App 范围。

## 目标与验收

- 新用户在 `/h5`、`/register` 自助设置账号密码，用户名唯一，密码校验由服务端执行；忽略客户端提交的角色和空间列表，角色固定为普通用户。
- 原版登录页提供自助注册和 H5 入口；管理员继续使用 `/settings/users` 创建、禁用、调整用户。
- 用户登录后进入 `/portal` 个人后台，可创建和重命名私有知识库，添加文字、上传文档、查看原文、移出索引及进入原版问答工作台。
- 公共知识库对所有登录用户开放查阅与问答，仅平台管理员可发布或维护。私有知识库仅所属用户与平台管理员可访问，经理角色无额外私有库访问权。普通用户不自行发布公共内容。
- 平台管理员保留管理权限，私有不是对平台管理员隐藏或端到端加密。已有工作空间保持原权限，管理员在个人后台主动分类后纳入公共／私有规则；分类为私有时归当前管理员，旧成员关系不能覆盖新规则。
- 权限同时作用于扩展接口、原版工作空间模型、问答路由和搜索；从公共改回私有后旧访问者立即失去新请求权限。已下载内容或已展示到客户端的回答无法远程收回。
- H5 在 320、768、1024、1440 像素宽度可用，输入有标签，错误/加载状态明确，无横向溢出。
- 管理员在 `/access/admin` 控制注册开放状态、配置公网地址及微信公众号/网站应用凭据。普通用户和匿名请求不能读取或改写配置；返回内容不含 AppSecret。
- 微信内走服务号网页授权，普通浏览器走开放平台网站应用扫码授权。回调检查随机 state、浏览器绑定、有效期及单次消费；第三方失败不建立登录。
- 微信身份按应用 ID 与 OpenID 绑定，禁止按昵称自动合并账号。新微信用户为普通用户且不加入已有空间；禁用用户不能登录。
- 登录通过上游 Simple SSO 的临时票据进入原工作台；新增 H5 不在 localStorage 保存会话。管理配置使用 HttpOnly/SameSite Cookie，并验证修改请求来源。
- 无微信凭据时如实显示未开通；真实微信登录验收另依赖对应已审核账号、HTTPS 域名和微信后台回调域名配置。

## 技术与目录

使用 Node.js 22.22.2、上游 Express 4.21.2、Prisma 5.3.1、bcryptjs 3.0.3 和浏览器原生 HTML/CSS/JS，不新增依赖。项目代码放在 `integrations/anythingllm/access/`，通过启动预加载挂载入口，上游跟踪源码不变。

扩展配置、微信身份映射、知识库所属/分类与短期 OAuth 状态放在现有 SQLite `system_settings` 的 `kb_access_` 命名空间；整份配置使用上游 EncryptionManager 加密。此命名空间不在上游 publicFields/supportedFields 白名单中，原版设置接口不能读写。避免修改上游 Prisma 模型或迁移。身份映射与微信用户建立、知识库与所属关系建立均使用事务。

知识库仍是原版 workspaces，资料仍走原版 Collector、Document 与向量引擎，使用独立 workspace slug 作为索引命名空间。用户不获得 manager/admin 角色。由于上游全局文件库、全量聊天记录和管理接口可能允许 manager 广泛查看，扩展将这些入口限定为平台管理员，个人用户从所属库的受控接口管理资料。新私有库的上游角色限制仍保留，资料写入从个人后台进入。

Windows 上游 Collector 返回的绝对文档路径经校验后转换为两段相对路径，拒绝存储根目录外的位置。Simple SSO 页面加载原版 React 前清除旧认证状态，避免上游 AuthProvider 与一次性票据消费冲突。原版退出账号时同步清除扩展 Cookie。

## 接口约定

| 方法/路径 | 权限与行为 |
|---|---|
| GET `/api/access/options` | 公开，仅返回注册开关与微信可用状态 |
| POST `/api/access/register` | 同源、限流、校验；创建普通用户并返回本机 SSO 路径 |
| POST `/api/access/login` | 同源、限流、校验密码与禁用状态，返回 SSO 路径 |
| GET `/api/access/wechat/:provider/start` | provider 为 h5/web；建立绑定浏览器的 state 并转授权页 |
| GET `/api/access/wechat/:provider/callback` | 验证 state，服务端换取身份并登录；失败返回 H5 错误状态 |
| GET/PUT `/api/access/admin/config` | 管理员；PUT 还需同源检查；密钥字段只写不回传 |
| GET/POST `/api/access/spaces` | 登录用户；分页列表／创建所属知识库，普通用户只能创建私有库 |
| PATCH `/api/access/spaces/:slug` | 所属私有库可改名；管理员可改公共／私有分类 |
| POST `/api/access/spaces/adopt` | 管理员主动将已有工作空间纳入公共／私有分类 |
| GET `/api/access/spaces/:slug/open` | 权限检查后生成指向原版问答的临时登录路径 |
| GET/POST `/api/access/spaces/:slug/documents` | 受控列表／文字录入并索引；公共库仅管理员写入 |
| POST `/api/access/spaces/:slug/upload` | 所属库文件上传，20MB，限 TXT/MD/CSV/PDF/DOCX/XLSX/PPTX |
| GET/DELETE `/api/access/spaces/:slug/documents/:id` | 校验所属库后查看原文／移出该库索引，原件保留给管理员 |

错误使用 HTTP 状态码与 `{error:{code,message}}`。Cookie、密码、密钥、微信票据不写日志。

## 实施与验证

1. 先实现并测试账号注册、登录、权限与配置，再添加微信授权和回调测试。
2. 挂载 H5、管理配置、原版入口链接与本地启动；保留官方用户管理。
3. 运行 `node --test integrations/anythingllm/access/tests/*.test.cjs`，测试数据库/外部微信边界与业务结果。
4. 运行 `node integrations/anythingllm/access/verify-browser.cjs`，使用隔离 Chrome 检查注册、登录、响应式和控制台。
5. 执行 `integrations/anythingllm/fetch-source.ps1 -CheckOnly`，确认上游跟踪源码未修改；记录真实微信联调的待办。

需要真实模型调用的验收命令为 `node integrations/anythingllm/access/verify-browser.cjs --with-ingestion`。会创建临时用户和库，录入两份虚构资料，调用现有向量/聊天模型并验证引用，之后清理临时账号、库、索引及这些库的原件；会产生少量供应商调用费用。默认浏览器检查不调用模型。

本增量当前由 Windows `start-local.ps1` 的预加载适配器启用，Docker Compose 尚未接入此扩展，也未经本机验证。

## 边界与资料

始终：服务端校验、固定普通权限、保护现有账号与资料、密钥加密和限流。微信绑定不授予管理员或工作空间权限。不把本地替身测试称为微信真实登录通过。

官方依据：上游 `server/models/user.js`、`temporaryAuthToken.js`、`endpoints/admin.js`；[微信网页授权](https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/Wechat_webpage_authorization.html)、[网站应用微信登录](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)。
