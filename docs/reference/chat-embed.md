# 可嵌入聊天组件

本文面向将 Hoox Agent 嵌入业务网站的前端与后端开发者，说明 `@hoox/chat-ui` 的浏览器入口、可定制项和认证边界。SDK 请求、SSE 与客户端工具契约见 [TypeScript SDK](sdk-typescript.md)，UI 颜色、字体与圆角基础 Token 见 [UI 主题 Token](ui-theme.md)。

## 安装与挂载

`@hoox/chat-ui` 导出 React 组件 `ChatWidget` 和框架无关的 `mount(element, options)`。组件使用 `@hoox/sdk`，并消费 `@hoox/ui-theme` Token；页面需加载主题和组件样式：

```tsx
import { HooxClient } from "@hoox/sdk";
import { ChatWidget } from "@hoox/chat-ui";
import "@hoox/ui-theme/theme.css";
import "@hoox/chat-ui/styles.css";

const client = new HooxClient({ baseUrl: `${location.origin}/hoox` });

<ChatWidget
  client={client}
  agentDefinitionId="agent_REPLACE_WITH_PUBLISHED_ID"
  locale="zh-CN"
  theme={{ accentColor: "#315d51", fontFamily: "system-ui", borderRadius: "12px" }}
/>;
```

普通 JavaScript 宿主可用 `mount(element, options)`，返回对象的 `unmount()` 负责卸载 React root。可选 `threadId` 恢复既有 Thread，`initialMessages` 指定初始显示内容；组件在未指定 Thread 时于首条消息时创建 Thread。`locale` 支持 `zh-CN` 与 `en`。主题覆盖项为 `accentColor`、`backgroundColor`、`textColor`、`fontFamily` 和 `borderRadius`，其他尺寸与语义色回退到共享 Token。

回复经 SDK SSE 增量更新，SDK 在连接中断后按事件游标自动续连。消息使用工作台相同的增量 Markdown 解析与净化规则：跳过原始 HTML、阻断危险 URL、将图片语法显示为文字并隔离新窗口外链。Run 完成后加载 Artifact；文本预览与短时下载交付由 SDK 公开 API 方法读取。

宿主可通过 `tools` 按工具名注册处理函数。Agent Revision 必须声明同名客户端工具；SDK 仅在有效 `requires_action` 时运行处理器并按 `callId` 回传结果。处理器必须自行执行业务授权，不得把 Agent 参数视为身份事实，也应尊重提供的 `AbortSignal`。

## 认证与代理

**浏览器不得持有 API Key。** `HooxClient` 不传 `apiKey`，`baseUrl` 指向业务方提供的同源代理。业务后端从自身已验证登录态映射 `Hoox-End-User`、注入 API Key，只转发白名单请求头与 SSE 流，不转发浏览器提供的认证或身份声明。代理应拒绝重定向并保留 `Last-Event-ID`。

Cookie 会话的代理必须验证精确 `Origin`，使用 HTTPS、`HttpOnly`、`Secure`、`SameSite` Cookie，并为状态变更按业务认证模型执行 CSRF Token 或等效防护；CORS 不是 CSRF 防护。示例代码见 [`examples/chat-embed`](../../examples/chat-embed/README.md)，示例登录固定为本地演示身份，不能直接部署到生产。

示例的环境变量只配置示例 Node 代理，不进入浏览器构建：

| 变量 | 示例值 | 用途 |
| --- | --- | --- |
| `HOOX_API_ORIGIN` | `http://127.0.0.1:3001` | Hoox API 源 |
| `HOOX_API_KEY` | `REPLACE_WITH_BACKEND_API_KEY` | 仅代理使用的服务凭据 |
| `APP_ORIGIN` | `http://127.0.0.1:4173` | 代理允许的精确页面 Origin |
| `DEMO_SESSION_TOKEN` | `REPLACE_WITH_RANDOM_LOCAL_SESSION_TOKEN` | 本地演示 HttpOnly Cookie 值 |
| `DEMO_END_USER_ID` | `Demo:local-user` | 该固定演示会话映射的 Hoox 终端用户 |

示例变量的名称和占位值由聊天包代理测试与 `examples/chat-embed/.env.example` 一并校验。生产业务应使用自身密钥管理与登录态，不复用演示 Token 或固定终端用户。

组件不上传任意文件，也不自行构造公开 API 请求；它通过 SDK 展示已发布 Artifact 与文件。扩展附件上传前应使用 SDK 与公开 API 已定义的上传/输入契约，不把 API Key 放到浏览器。
