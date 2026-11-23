# 嵌入聊天示例

示例把静态页面、React 聊天组件与最小 Node 同源代理放在一个本地服务中。需要 Node 20+、已安装仓库依赖，并先构建组件依赖：

```sh
cp examples/chat-embed/.env.example examples/chat-embed/.env
# 编辑示例配置，设置 API Key 与随机的本地会话占位值
set -a
. examples/chat-embed/.env
set +a
corepack pnpm --filter @hoox/chat-ui... build
node --env-file=examples/chat-embed/.env examples/chat-embed/server.mjs
```

把 `agent_REPLACE_WITH_PUBLISHED_ID` 改成已发布 Agent ID 后访问 `http://127.0.0.1:4173`，点击“建立本地示例会话”。该按钮只用于本地演示：服务器通过 HttpOnly、SameSite Cookie 固定到 `.env` 中的示例终端用户，不提供生产登录。真实业务应把会话校验替换为自己的认证中间件。

## 安全模型

- API Key 只由 Node 进程读取并添加到上游 `Authorization`；浏览器 SDK 不设置 `apiKey`。代理忽略浏览器传入的 `Authorization`、`Hoox-End-User` 和其他身份声明，由已验证业务会话决定 `Hoox-End-User`。
- 代理只接受配置的精确 `Origin`，仅提供同源路由，不开放 CORS；拒绝没有正确来源的代理请求。生产环境必须通过 HTTPS 设置 Secure Cookie，并将 Origin、Cookie、限流和会话撤销接入业务现有安全体系。
- 代理不转发 Cookie 或浏览器凭据，只转发 API 所需请求头；保留 SSE 响应流和 `Last-Event-ID`，拒绝上游重定向，并在客户端断开时取消上游请求。
- 业务后端必须对所有状态修改请求实施 CSRF 防护（精确 Origin 校验、SameSite Cookie，并按业务认证方案添加 CSRF Token）；不要把 CORS 当作 CSRF 防护，也不要信任浏览器提交的终端用户 ID。
- `.env.example` 全是占位值。不要把真实 API Key 放入静态资源、前端环境变量、源码控制或浏览器存储。

本地代理测试由 `corepack pnpm --filter @hoox/chat-ui test` 执行；组件消费同源 `/hoox` 路径，代理把它映射到 `HOOX_API_ORIGIN` 下的公开 `/v1` API。
