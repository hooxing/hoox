# ADR-0039：本地 Agent 工作台与公开 API 边界

- 状态：已接受
- 日期：2026-07-28
- 决策者：Runtime 团队
- 关联任务/PR：本地工作台体验
- 替代关系：无

## 背景

本地开发需要可操作的浏览器界面来创建 Thread 与 Run、观察追加事件并安全下载 Artifact。浏览器不得访问服务端持久层，也不得持久化开发凭据。服务端事件 HTTP 契约正在由内部追加日志 `{ sequence, kind, payload, occurredAt }` 演进为可选 `{ eventId, type }` 信封。

## 决策驱动因素

- 同源开发体验、固定开发身份和不泄露环境秘密；
- 对事件契约增量演进的兼容性；
- 避免工具回执或不可信 payload 被整个渲染；
- 保持本地启动、测试和替换 UI 框架的成本可控。

## 备选方案

### 方案 A：Vite 同源代理与轮询公开 API

浏览器仅请求 `/api`，Vite 将其代理到 `VITE_WEB_API_TARGET`，客户端轮询 Run、事件和 Artifact。优点是无需 CORS，开发配置简单；缺点是事件存在约 1.2 秒延迟并增加短轮询请求。

### 方案 B：浏览器直连 API 并配置 CORS

前端从环境变量读取 API URL 后跨域请求。优点是部署拓扑更直接；缺点是开发身份、预检、CORS 配置及错误排查范围扩大，不适合作为当前本地默认。

### 方案 C：SSE/WebSocket 推送

服务器主动推送事件。优点是低延迟；缺点是需要新增连接恢复、游标重放、认证续期和更多服务端协议，当前公开契约尚未具备。

## 选择

选择方案 A。Vite 使用 `loadEnv` 读取 `VITE_WEB_API_TARGET`，默认代理到 `http://127.0.0.1:3001`，兼容旧 `WEB_API_TARGET` 命令行变量。所有 POST 自动附加幂等键，固定 `Bearer dev-user-a` 只在请求 Header 使用，页面仅标明该本地身份。

`RuntimeApi` 的默认传输使用一层箭头函数包装，并在调用时通过 `globalThis.fetch(...)` 保留浏览器原生 fetch 所要求的 Window receiver；不能把裸 `fetch` 直接保存为实例字段后以 `this.fetcher(...)` 调用。构造器仍接受显式 fetcher，供契约测试和受控适配注入。

客户端从 `kind` 与 agent payload 的 `type` 派生稳定事件类型和 `event-${sequence}` 标识；只展示 message delta、工具 name/callId/受限结果和 attempt 状态。Artifact 下载固定使用 Run 嵌套 GET 路由。

Thread 选择使用同步递增的 navigation generation。创建 Run、取消 Run、归档 Thread 等异步命令只有在响应返回时仍属于发起它的选择代次，才能写回当前 Run、事件或选择状态；切走后再选回相同 Thread 也视为新代次。Thread 创建和归档的迟到成功仍以独立 reducer 动作更新列表，但不能覆盖用户已经切换到的工作区。

## 理由

当前后端已提供 REST 读取模型而尚未承诺推送连接。方案 A 在不扩展可信边界的情况下可立即运行，且 sequence 去重能容忍轮询重叠和未来信封字段补充。方案 B 不必要地把 CORS 与配置复杂度带入本地工作流；方案 C 应在服务端具备完整重放语义后再评估。

## 影响

### 正面影响

- 本地以 `pnpm dev:web` 启动，不需要浏览器 CORS 配置；
- 用户能即时看到本轮输入，随后看到增量 delta、工具状态和终态；
- UI 不会把完整工具回执或巨大 payload 渲染到页面。

### 负面影响与成本

- 活跃 Run 每约 1.2 秒产生三次读取；
- 页面刷新不保留服务端未建模的本轮输入；
- 若以后切换推送协议，需要替换轮询调度层。

### 安全、数据与运维影响

- 不写入 token、环境变量或下载 URL；
- 下载 URL 由嵌套授权端点获取，失败统一显示为页面错误；
- `dev-user-a` 仅限开发组装，不能作为生产身份方案。

## 验证

- `api.test.ts` 验证浏览器 fetch receiver、开发身份、幂等键、基线事件适配和嵌套下载 URL；
- `event-view.test.ts` 验证 delta 与工具安全字段呈现；
- `state.test.ts` 验证 sequence 去重；
- `navigation.test.ts` 验证迟到命令不能跨 Thread 或跨选择代次写回；
- `config.test.ts` 验证 Vite 环境变量优先级；
- 执行 Web 的 typecheck、Vitest、Vite build 和 Biome 检查。

## 可逆性与回退

工作台仅位于 `apps/web`，没有数据迁移。可通过移除 `dev:web` 和该包恢复到空入口；在服务端推出 SSE 后可替换轮询 effect，仍保留 API client 的 sequence 兼容逻辑。

## 后续工作

- 当服务端发布稳定事件 DTO 后收紧客户端适配；
- 评估 SSE 的游标重放和认证模型；
- 在集成 README 中补充完整启动顺序。

## 实施记录

- 2026-07-28：实现 Vite/React 本地工作台、稳定轮询、事件适配与嵌套 Artifact 下载。
- 2026-07-28：以 navigation generation 隔离迟到命令响应，并用独立列表动作保留已提交的 Thread 创建与归档结果。
- 2026-07-28：默认 fetch 改由 `globalThis` receiver 包装调用，避免 Chrome 将实例方法调用判为 `Illegal invocation`。
