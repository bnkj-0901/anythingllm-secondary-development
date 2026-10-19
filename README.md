# 智能体回收：知识库首期

本仓库首期只交付知识库。ERP、Android/iOS App 和经营数据能力留到后续阶段。

知识库采用“开源底座 + 按实际缺口补充适配”：底座复用 [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) v1.18.0 的文档处理、向量检索、问答、引用、多用户工作空间和模型适配；项目按验证结果补充版本发布、图片人工确认、审计和微信渠道。

## 当前状态

目前已完成方案、任务拆解和底座源码整合，并在 Windows 本机启动了服务端、文档处理和工作台。首页、健康检查及浏览器登录页已验证。运行方式与验证边界见 [整合说明](integrations/anythingllm/README.md)；真实资料索引和引用问答仍待联调验收。

## 目录

- `docs/`：需求、技术方案和架构决策
- `tasks/`：按阶段拆解的实施任务
- `integrations/anythingllm/`：AnythingLLM 源码整合入口、环境模板和启动说明
- `vendor/anythingllm/`：纳入本仓库版本管理的 AnythingLLM v1.18.0 底座源码；不提交依赖、构建产物或运行数据

## Git 分支与源码基线

远程仓库：<https://github.com/bnkj-0901/anythingllm-secondary-development>。

- `main`：仅一个初始提交，目录树与 AnythingLLM v1.18.0 上游提交 `3e4f9411b67f2dd7fa9fc6f2b95dfacbda0633ba` 完全一致；不包含本项目扩展。
- `feature/knowledge-platform`：以该基线为父提交，将原版源码放入 `vendor/anythingllm/`，第二个提交保存现有扩展、测试、启动脚本和文档。后续项目开发在非主分支继续。

本地嵌套仓库的 `.git` 不提交；源码以实际文件保存，不把整个 AnythingLLM 当作子模块。上游自身的可选 `browser-extension`、`embed` 子模块引用仍按原版保留。数据库、用户上传、模型、密钥、依赖、构建产物和临时文档预览不进入 Git；运行数据需要另行备份。

原版知识库不包含本项目要求的共享投稿审核与共享/本人私有联合检索；当前源码二次开发目标见 [规格](docs/specs/anythingllm-source-development.md)，现有运行时适配保留为迁移前快照，不代表新方案已经实施。

## 本地入口

本机已安装依赖并编译前端，日常直接启动：

```powershell
.\integrations\anythingllm\start-local.ps1
```

新环境首次运行改用 `start-local.ps1 -Setup` 安装依赖、构建并启动。访问 [http://localhost:3001](http://localhost:3001)，向量模型位于「设置 → 人工智能提供商 → 嵌入器（Embedder）」。

在具备 Docker 与 Compose 的环境执行：

```powershell
.\integrations\anythingllm\fetch-source.ps1 -CheckOnly
.\integrations\anythingllm\start.ps1
```

Docker 构建仍待验证。当前使用本地源码运行，模型配置和真实问答需另行验证。

## 首期边界

- 私有、团队和公开知识空间
- 文字、图片、语音、文档录入
- 图片识别先生成待确认草稿，人工确认后才进入知识库
- 版本、审核、发布、撤回和引用原文
- 多用户和服务端权限校验
- 小程序和公众号渠道适配预留

ERP 和 App 不纳入本轮实现。

## 开源许可证说明

AnythingLLM v1.18.0 采用 MIT 许可证，允许在保留版权和许可声明的前提下修改和整合。依赖包、模型、OCR/ASR 服务各自的许可证和数据条款仍需在上线前单独核对。

## 参考

- [开源整合说明](docs/open-source-integration.md)
- [架构决策 ADR-002](docs/decisions/knowledge-platform-002.md)
- [实施计划](tasks/plan.md)
- [任务清单](tasks/todo.md)
