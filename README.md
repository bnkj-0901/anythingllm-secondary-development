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
| `server/storage/` | 默认 SQLite 数据库、文档和模型等运行数据 |
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

在 `server/.env.development` 中，将 `JWT_SECRET`、`SIG_KEY`、`SIG_SALT` 的模板值替换成独立随机串（分别至少 12、32、32 个字符），并保持加密密钥稳定。前端默认 API 地址为 `http://localhost:3001/api`。

默认使用 SQLite，不需要单独安装数据库，也不需要配置 `DATABASE_URL`。开发模式默认使用 `server/storage` 存放运行数据。初始化数据库：

```powershell
yarn prisma:setup
```

在三个终端中分别启动：

```powershell
# 终端一：API，默认 3001
yarn dev:server

# 终端二：文档处理，默认 8888
yarn dev:collector

# 终端三：前端，默认 3000
yarn dev:frontend
```

打开 <http://localhost:3000>，在界面中配置聊天模型、Embedding 模型和向量库。云模型通常需要 API Key；本地模型服务需另行启动，首次使用内置 Embedding 等功能可能需要下载模型。

根目录 `yarn setup` / `yarn setup:envs` 沿用上游的类 Unix 命令；Windows PowerShell 初始化请使用上面的命令。Server 和 Collector 在开发模式下均读取各自的 `.env.development`。

## 开发检查

```powershell
yarn lint:ci
yarn test
yarn translations:verify
node scripts/verifyPackageVersions.mjs
```

Lint 和测试需要先安装对应目录依赖。Docker 部署参考 [Docker 说明](docker/HOW_TO_USE_DOCKER.md)；非容器生产部署可参考保留的上游 [BARE_METAL.md](BARE_METAL.md)，其中上游拉取和更新脚本需按本仓库分支流程调整。

## 本次整理范围

已移除独立浏览器扩展和嵌入组件的 Git 子模块，以及云部署示例、开发容器、宣传资源、README 翻译、自动翻译生成工具和上游发布/赞助配置。界面翻译、主站自带嵌入资源及相关 API、模型适配、测试和 Docker 配置保留。

## 来源与许可

上游作者为 Timothy Carambat / Mintplex Labs，遵循 [MIT License](LICENSE)。原始版权与许可声明保留。上游使用文档见 <https://docs.anythingllm.com>。
