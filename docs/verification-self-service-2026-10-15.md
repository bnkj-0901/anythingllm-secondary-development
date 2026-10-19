# 自助注册、个人后台与知识库分类验证

环境：Windows 11，Node.js 22.22.2，Chrome 隔离临时配置。AnythingLLM v1.18.0 固定源码；本轮新增代码位于 `integrations/anythingllm/access/`，由本地启动预加载，上游跟踪源码无修改。

## 已验证

- 后端 11 项自动测试通过：普通用户注册且无隐式空间授权、密码哈希和输入校验、同源限制、管理员配置鉴权与密钥不回传、关闭注册后老用户登录、微信 state 伪造/浏览器不匹配/过期/重放、微信供应商失败、禁用账号、个人/公共库权限与撤权、认证限流、Windows 文档路径边界。
- 实际服务与浏览器：自助注册进入个人后台，普通用户创建私有库，打开原版问答，退出后密码登录，管理员配置页可用。320/768/1024/1440 宽度均无横向溢出，未捕获浏览器运行错误或失败请求（正常导航取消不计为失败）。
- 真实资料链路：录入一份虚构营业时间资料、上传一份 TXT 测试文档；使用现有阿里 `text-embedding-v4` 建立 LanceDB 索引，原文读取正确。使用现有 DeepSeek 配置问答，返回营业时间与周末休息说明，带 2 个来源引用；测试流无错误。
- 实际跨用户 HTTP 检查：其他用户直接访问私有库、问答、资料被拒绝；管理员发布为公共后可访问，写入与修改被拒绝；改回私有后访问和已有对话搜索结果被拒绝/过滤。
- 原版工作台退出与扩展 Cookie 同步；上游服务健康检查、登录页自助注册链接、源码校验通过。

命令：

```powershell
node --test .\integrations\anythingllm\access\tests\*.test.cjs
node .\integrations\anythingllm\access\verify-browser.cjs
node .\integrations\anythingllm\access\verify-browser.cjs --with-ingestion
node .\integrations\anythingllm\verify-local.cjs
.\integrations\anythingllm\fetch-source.ps1 -CheckOnly
```

浏览器截图保存在被忽略的 `integrations/anythingllm/data/local-logs/`。验证仅使用随机临时账号、库和虚构资料；不修改用户已有账号密码、知识内容或模型设置。

## 待验证

真实微信登录仍需要平台资质、AppID/AppSecret、HTTPS 域名与回调域配置；已验证授权代码路径与失败边界，未声称真实微信联调通过。PDF/DOCX/XLSX/PPTX 的实际质量、扫描 OCR、语音、图片人工确认、多实例与公网部署、完整备份恢复和大规模并发仍属后续验收。本机未安装 Docker，Docker 路线未启用本扩展。
