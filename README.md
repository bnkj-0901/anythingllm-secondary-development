# AnythingLLM 二次开发

本仓库基于 [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm)，用于后续定制开发。上游源码基线为 `d7d68e75c422d10384b8aa30f72d6d032fcc555e`。

## 分支约定

- `source`：保留上游源码及完整历史，作为对照。
- `dev`：以单个独立基线提交开始二开，后续业务修改在此进行。
- `main`：当前为空白初始化分支，后续按项目发布流程使用。

## 目录

| 目录 | 用途 |
| --- | --- |
| `frontend/` | React + Vite 前端页面、组件和界面翻译 |
| `server/` | Node.js + Express API、聊天/RAG、Agent、MCP、模型与向量库适配 |
| `server/prisma/` | 数据库模型、迁移和初始化 |
| `server/storage/` | 原件、LanceDB 向量、缓存和加密/签名配置等运行数据 |
| `collector/` | 文档采集、文本解析、OCR 等处理服务 |
| `docker/` | Docker 构建与部署配置 |
| `scripts/` | 仓库维护脚本 |
| `.github/workflows/` | Lint、测试、翻译和依赖版本检查 |
| `.vscode/` | 本地调试和服务启动任务 |

## 本地开发（Windows PowerShell）

以下命令均从本仓库根目录执行。准备好 Node.js、Yarn Classic 1.x 和 Git。上游 `.nvmrc` 指定 `v18.18.0`，服务包声明 Node.js `>=18.12.1`；本项目含原生依赖，更换 Node 大版本后需重新验证安装和运行。

安装四处依赖：

```powershell
yarn install
yarn --cwd server install
yarn --cwd collector install
yarn --cwd frontend install
```

首次创建环境文件，保留已有配置：

```powershell
if (!(Test-Path frontend/.env)) { Copy-Item frontend/.env.example frontend/.env }
if (!(Test-Path server/.env.development)) { Copy-Item server/.env.example server/.env.development }
if (!(Test-Path collector/.env.development)) { Copy-Item collector/.env.example collector/.env.development }
```

在 `server/.env.development` 中，将 `JWT_SECRET`、`SIG_KEY`、`SIG_SALT` 的模板值替换成独立随机串（分别至少 12、32、32 个字符），并保持加密密钥稳定。网页使用同源 `/api`，Vite 将请求转发到 3001 并保留 Host。

业务数据库使用 PostgreSQL，唯一模型和迁移位于 `server/prisma/schema.prisma`、`server/prisma/migrations`，运行时统一使用标准 `@prisma/client`。当前有 40 张产品表，包含原版账号恢复、Agent、记忆、模型路由、外部接入和任务等能力所需结构。原 `users`、`chat_threads`、`chats` 保留整数自增主键与原生日期字段，用户、聊天、资料和向量元数据按新归属调整，不创建 Workspace 或成员关系。先创建数据库，在 `server/.env.development` 配置 `DATABASE_URL=postgresql://用户名:经过URL编码的密码@数据库主机:5432/数据库名?schema=public`。开发模式默认使用 `server/storage` 存放原件和本地向量等运行数据。初始化数据库：

```powershell
yarn prisma:setup
```

数据库命令默认读取 `server/.env.development`；生产模式读取 `server/.env`，显式进程环境中的 `DATABASE_URL` 优先。部署使用 `yarn db:init`，开发 schema 修改使用 `yarn prisma:migrate`。`prisma:reset` 会清空目标库，仅用于明确需要重置的开发数据库。

当前处于未上线的开发阶段，从空库仅部署 `20261022000100_saas_postgres` 一份基线，不提供旧开发库升级和数据搬迁。初始化幂等创建首位顶级管理员，不创建租户、企业用户或示例会话；重启不重置账号。可配置 `INITIAL_ADMIN_USERNAME/PASSWORD`，未设置密码时随机生成并保存到持久目录 `initial-admin.json`，不输出到日志。产品不包含第二套 SQLite schema、生成客户端或导入器。正式上线后的结构变更使用增量迁移，并在升级前备份数据库和持久文件；业务数据库迁移不替换 LanceDB 或其它原向量后端。

保留原版向量库选择、连接配置与 Provider SDK。当前改造通过 `Document`、`DocumentVectors` 和新增的 `records()` 记录接口接入知识库授权、namespace 和版本过滤；该接口及各后端的记录 CRUD 是新增实现，并非原 Workspace 向量流程原样复用，它用于在相似度排序前限定获授权文档及版本，避免未授权资料挤占检索结果。更换后端不会自动搬迁索引；已有索引须先在目标配置中验证原记录可访问，或另行安排重建。

扩展与移动设备的凭据、配对和身份校验已接入企业用户，但资源合同已改为知识库与个人会话；原官方扩展和移动客户端尚未完成协议适配与验收，具体限制见 [V1 改动边界](docs/change-boundary.md)。

在三个终端中分别启动：

```powershell
# 终端一：API，默认 3001
yarn dev:server

# 终端二：文档处理，默认 8888
yarn dev:collector

# 终端三：前端，默认 3000
yarn dev:frontend
```

Server 与 Collector 均从各自原 `index.js` 启动。初始化后打开 <http://localhost:3000> 登录顶级管理员，在租户管理中登记唯一访问域名并创建首位企业管理员。开发默认可分配 `<租户标识>.localhost:3000`，域名直接写入 `ep_tenants.hostname`。生产配置 `PLATFORM_HOSTS`，代理保留 Host，并为实际域名配置 DNS/TLS。请求按 Host 精确查租户；每个用户固定属于一个租户，用户名仅在该租户内唯一。小程序的租户 API 地址在构建时固定，用户不填写企业域名。微信登录需要顶级管理员为该企业配置小程序 AppID／AppSecret；后端按域名兑换微信临时 code，首次建立普通企业用户。模拟接口与独立 PostgreSQL 测试已通过，真实微信凭据与真机流程仍需验收。

在界面中配置聊天模型、Embedding 模型和向量库。云模型通常需要 API Key；本地模型服务需另行启动，首次使用内置 Embedding 等功能可能需要下载模型。

根目录 `yarn setup` / `yarn setup:envs` 沿用上游的类 Unix 命令；Windows PowerShell 初始化请使用上面的命令。Server 和 Collector 在开发模式下均读取各自的 `.env.development`。

## 开发检查

```powershell
yarn lint:ci
yarn test
yarn translations:verify
node scripts/verifyPackageVersions.mjs
```

SaaS 定向验证使用 `yarn test:enterprise`、`yarn test:frontend`、`yarn test:client` 和 `yarn test:collector`。后端集成测试要求显式 `EP_TEST_DATABASE_URL` 指向独立 PostgreSQL 测试库，每个测试套件创建和清理自己的 schema，不自动读取开发数据库配置。

Lint 和测试需要先安装对应目录依赖。Docker 部署参考 [Docker 说明](docker/HOW_TO_USE_DOCKER.md)；非容器生产部署可参考保留的上游 [BARE_METAL.md](BARE_METAL.md)，其中上游拉取和更新脚本需按本仓库分支流程调整。

本地 Docker 将 Server、Collector 和静态 Frontend 部署在同一容器，默认访问 `http://localhost:3000`；`uniapp` 单独开发。Compose 连接已有 PostgreSQL，不创建数据库容器。首次部署使用空库及空业务存储目录，在 `docker/.env` 配置 `DATABASE_URL` 和稳定独立的加密密钥；本地未启用 TLS 时设置 `TENANT_WEB_PROTOCOL=http`。容器健康检查同时探测 API 与 Collector。

## 本次整理范围

已移除独立浏览器扩展和嵌入组件的 Git 子模块，以及云部署示例、开发容器、宣传资源、README 翻译、自动翻译生成工具和上游发布/赞助配置。界面翻译、主站自带嵌入资源及相关 API、模型适配、测试和 Docker 配置保留。

## 来源与许可

上游作者为 Timothy Carambat / Mintplex Labs，遵循 [MIT License](LICENSE)。原始版权与许可声明保留。上游使用文档见 <https://docs.anythingllm.com>。
