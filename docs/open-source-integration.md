# 知识库开源整合说明

日期：2026-10-15  
状态：首期实施基线

## 结论

首期以 AnythingLLM v1.18.0 作为可替换的知识库底座。选择它是因为源码已经覆盖文档上传与解析、工作空间、向量检索、问答引用、模型适配、图片 OCR 和音频转写，并提供多用户权限能力。项目只实现本方案的业务边界，不重新实现通用 RAG 平台。

上游固定提交：`3e4f9411b67f2dd7fa9fc6f2b95dfacbda0633ba`。来源：

- https://github.com/Mintplex-Labs/anything-llm/releases/tag/v1.18.0
- https://github.com/Mintplex-Labs/anything-llm/blob/v1.18.0/LICENSE
- https://github.com/Mintplex-Labs/anything-llm/blob/v1.18.0/docker/docker-compose.yml

## 复用范围

| 能力 | 处理方式 |
|---|---|
| 文档、PDF、DOCX、图片和音频处理 | 复用上游 collector 与解析器；按样本验证中文效果 |
| 向量检索、片段召回、回答引用 | 复用上游 workspace/API 和向量适配 |
| 模型、embedding 和转写服务 | 复用上游 provider 接口，通过配置替换供应商 |
| 多用户、工作空间和成员角色 | 复用上游用户/工作空间模型；项目侧再做空间授权核验 |
| 知识版本、审核、发布、撤回 | 先验证现有能力，只补缺口，不依赖提示词实现 |
| 图片人工确认 | 在上传解析完成后增加待确认草稿和确认快照；确认前不触发正式索引 |
| 微信小程序/公众号 | 后续实现渠道适配器，调用项目适配层，不直接暴露底座管理接口 |
| ERP、库存和经营记账 | 本阶段不接入 |

## 目录约定

`vendor/anythingllm/` 是本地开发使用的上游源码目录，固定到上面的提交。`integrations/anythingllm/` 只放本项目的环境模板、启动配置、适配说明和验证脚本，不直接修改上游源码。

上游更新时先在独立分支验证：

1. 重新固定提交并记录版本、许可证和变更。
2. 运行底座自带测试与项目适配层测试。
3. 验证工作空间隔离、引用来源、删除和撤权缓存。
4. 再把版本变更写入 ADR 和变更记录。

## 安全边界

先复用并验证底座已有的多用户与工作空间权限，再对本项目的组织、私有空间和发布规则补缺。底座 developer API key 只验证密钥是否有效，并不代表微信用户已获某个空间的授权；渠道接入必须由服务端验证身份、空间映射和引用范围。上游示例凭证不能直接用于生产。

## 许可证边界

AnythingLLM 是 MIT 许可证，修改和分发时需保留版权与许可声明。MaxKB 官方仓库标注 GPLv3，允许商业使用，相关义务取决于实际修改、组合与分发方式。RAGFlow 为 Apache-2.0，可作为后续复杂文档解析的评估对象。

本地采用 Git 稀疏检出，保留官方容器构建实际需要的 `server`、`collector`、`frontend`、`docker` 目录及根目录许可证、依赖和说明文件；不下载与首期无关的演示图片和扩展项目。源码仍由官方 Git 对象校验并固定到同一提交。

## 已核对的源码边界

- `server/utils/middleware/validWorkspace.js`：登录用户走 `Workspace.getWithUser`；需继续验证管理员与成员规则、引用和撤权。
- `server/utils/middleware/validApiKey.js`：developer API 校验全局密钥，不能直接当作微信用户授权。
- `server/endpoints/api/document/index.js`：文件解析可以和 `addToWorkspaces` 自动嵌入分开；图片确认流程应先解析、核对，再授权嵌入。
- `collector/processSingleFile/convert/asImage.js` 与 `asAudio.js`：解析结束会按选项清理输入临时文件。图片人工核对所需原图不能仅依赖该临时文件，需验证或补充正式原件留存。
- `docker/docker-entrypoint.sh`：执行 Prisma 生成和迁移，再启动 server 与 collector；`docker/docker-healthcheck.sh` 检查 `/api/ping`。

本次只验证了源码与整合文件。尚未运行问答、OCR/转写、空间隔离或人工确认验收。
