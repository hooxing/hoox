# 用户 Web：公开首页与工作台

平台管理员可在后台「品牌设置」在线定制工作台（含登录页），无需重新构建；范围与安全约束见[品牌设置参考](../../../docs/reference/branding.md)。静态公开首页仍使用以下构建配置，不读取动态品牌。

工作台只在当前会话的最新运行读取未完成时显示恢复状态；快速读取不显示占位。登录凭据到期或当前凭据被 API 拒绝时返回登录并停止后台轮询，不自动提交草稿。云盘找不到交付文件时，可从原对话的交付卡片预览或下载。

`corepack pnpm --filter @hoox/web... build` 使用同一套 React 组件预渲染首页、构建客户端并输出 `dist/`。首页正文无需 JavaScript 或 API；浏览器随后水合。`/app` 及其他工作台入口才检查安装状态；旧 OAuth 根路径 `?error=…` 回调仍进入工作台。

自托管时先构建工作区依赖，再运行以下命令提供公开站点源和可选的页脚链接：

```sh
corepack pnpm --filter @hoox/web^... build
corepack pnpm --filter @hoox/web build --site-origin https://hoox.example.org \
  --privacy-url https://hoox.example.org/privacy --terms-url https://hoox.example.org/terms
```

- `--site-origin` 是 HTTP(S) 源，不含路径、查询、片段和凭据。省略时不发布 canonical，且 sitemap 不列出 URL；Demo 的 Nginx 使用部署域名为此类构建补齐站点元数据和 sitemap，不使用访问者提供的 Host。该 Demo 上游只应监听回环。
- `--privacy-url` 和 `--terms-url` 分别接受不含凭据的 HTTP(S) 链接；未配置的入口不显示。应用不提供隐私或条款正文。
- 静态服务应仅为 `/`、`/index.html` 提供 `index.html`，将工作台页面路由（包括旧 OAuth 错误回调）回退到自带 `noindex` 的 `workspace.html`。按实际文件提供 `robots.txt`（`text/plain`）和 `sitemap.xml`（`application/xml`），不要让它们进入 SPA 回退。Demo 静态服务已实现这些规则。
