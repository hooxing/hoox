# TypeScript SDK

本文面向通过业务后端或浏览器代理接入 Hoox 的开发者，说明 `@hoox/sdk` 的调用方式、SSE 恢复及客户端工具边界。可嵌入聊天组件见[聊天组件参考](chat-embed.md)。服务端协议、权限与结果大小限制以[公开 API v1](public-api.md)为准。

## 环境与凭据

SDK 使用标准 `fetch`、Web Streams、`AbortController`，无运行时依赖，可用于 Node 20+ 与支持这些标准的现代浏览器。仓库构建使用根 `package.json` 固定的工具链。包的导出指向 `dist`，仓库内使用前运行 `corepack pnpm --filter @hoox/sdk build`。

API Key 只能保存在业务后端。**不得把 API Key 放入浏览器代码、公开构建变量或前端存储。** 浏览器实例不传 `apiKey`，将 `baseUrl` 指向同源业务代理的绝对地址，例如 `https://app.example.invalid/hoox`。代理在服务端认证用户、决定 `Hoox-End-User`、注入 API Key、转发 SDK 追加的 `/v1/...` 路径，并保持 SSE 流式响应与 `Last-Event-ID`。不得把浏览器传来的身份声明直接当作授权事实。

```ts
import { HooxClient } from "@hoox/sdk";

const client = new HooxClient({
  baseUrl: "http://127.0.0.1:3001",
  apiKey: "REPLACE_WITH_BACKEND_API_KEY",
  endUser: "Customer:42",
  timeoutMs: 60_000,
});
```

`baseUrl` 可包含业务代理路径前缀，不允许用户名、密码、查询或片段。`endUser` 原样成为 `Hoox-End-User`；未配置时不发送该头。一个实例绑定一个业务身份，不要跨用户共享实例。浏览器代理模式下身份由代理绑定。SDK 禁止自动跟随重定向，避免认证头跨目标传播；可通过 `fetch` 选项注入兼容的传输实现。

## Thread 与 Run

```ts
const thread = await client.createThread(
  { title: "天气查询", agentDefinitionId: "agent_REPLACE_WITH_PUBLISHED_ID" },
  { idempotencyKey: "thread-business-operation-0001" },
);
const run = await client.createRun(
  thread.id,
  { input: "查询上海天气" },
  { idempotencyKey: "run-business-operation-0001" },
);
const snapshot = await client.getRun(thread.id, run.id);
```

方法返回成功信封中的 `data`。查询方法还包括 `listAgents()`、`listThreads({cursor, limit})`、`getThread(threadId)`、`listThreadRuns(threadId, {limit})` 和 `listRunEvents(threadId, runId, {after, limit})`；`cancelRun(threadId, runId)` 请求服务端取消。创建 Thread/Run 必须显式提供幂等键，同一业务重试应保留原键与请求正文。SDK 不自动重试普通 HTTP 请求；网络失败不代表服务端没有接受写入。

Artifact 可通过 `listArtifacts(threadId, runId)` 查询；`previewArtifact(...)` 与 `downloadArtifact(...)` 返回公开 API 的交付数据（文本预览或短时效 URL）。需要在客户端读取有界原始内容时使用 `readArtifactContent(...)`，其返回 `Uint8Array`，不假设内容为 JSON。所有方法接受可选 `RequestOptions`，支持 `signal` 与 `timeoutMs`；失败沿用 `HooxError`，错误响应不回显 API Key 或终端用户 ID。

各请求可传 `signal`、`timeoutMs`；`timeoutMs` 是一次 HTTP 请求（含响应正文）或一次 SSE 连接的时限，默认 60000 毫秒，不是整个 Run 的截止时间。退出迭代器只关闭连接，不取消 Run；取消远端执行必须调用 `cancelRun`。

## 流式订阅与恢复

```ts
for await (const event of client.streamRunEvents(thread.id, run.id, {
  signal: AbortSignal.timeout(600_000),
  retry: { initialDelayMs: 250, maxDelayMs: 5_000, maxRetries: 8 },
})) {
  if (event.event === "run-events") {
    for (const item of event.data.page.items) {
      if (item.type === "message.delta") console.log(item.payload.delta);
    }
  }
}
```

- 输出 `run-events` 批次（`data.run`、`data.page`）和最终 `end`。事件 payload 依照 OpenAPI 保留为开放对象，消费前需按事件类型检查字段。
- 为限制内存，单帧累计文本与未完成行缓冲上限为 8388608 个 UTF-16 码元，超限抛出 `INVALID_STREAM`。
- EOF、网络错误、连接超时及可重试 HTTP 错误会按指数退避续连，默认延时从 250 毫秒增长，最多 5000 毫秒，连续失败最多重试 8 次；收到新的持久事件后重置失败计数。认证、授权、参数及非法 SSE 不自动重试。
- 服务端 `end.reason: renew` 续连而不作为最终结束输出。`waiting` 的 `settled` 结束普通订阅；真正终态或 `recovery_required` 在事件补读完成后结束，不继续重连。
- SDK 按 Attempt 和递增 sequence 去重；续连使用最后交付事件的 `eventId` 作为 `Last-Event-ID`。Attempt 变化时接受新 Attempt 的起始序列。空批次仍可携带最新 Run 快照。
- 可持久化批次的 `id`，并在新订阅时传 `lastEventId`。业务应在处理完批次后保存游标；SDK 不替调用方持久化已消费位置。

## 客户端工具

```ts
import { ClientTools } from "@hoox/sdk";

const tools = new ClientTools().register("lookup_weather", async (args, context) => {
  if (context.signal.aborted) throw new Error("操作已取消");
  return JSON.stringify({ city: args.city, weather: "晴" });
});
for await (const event of tools.stream(client, thread.id, run.id)) {
  if (event.event === "run-events") console.log(event.data.run.status);
}
```

Agent 必须已声明同名客户端工具。辅助器只执行活跃 Run 的 `requires_action`，不把普通 `run_waiting` 当作调用指令；终态或 `recovery_required` 快照中的历史指令不会触发处理函数。执行前核对 Thread/Run 归属，同一批次中的调用并发处理。处理函数自行校验参数和业务授权，返回 UTF-8 文本；JSON 结果须自行序列化。未知工具、抛错或不合规结果按 `failed` 回传固定错误文字，不上传异常堆栈、内部错误或参数正文。

服务端 UTC `deadline` 是唯一工具等待截止时间。辅助器到期时中止传给处理函数的 `signal`，不提交迟到结果，让服务端生成超时回执；不能强制终止忽略 signal 的业务代码。外部取消同样不伪造工具失败。网络请求仍受 `timeoutMs` 限制，提交遇到可重试网络错误时有界重试相同 `callId`、`outcome` 和完整结果；409 不被当成成功，也不会以新结果覆盖服务端状态。

同一辅助器、同一客户端实例内按 Thread/Run/callId 缓存执行与回传事实，重复、并发处理或丢失回执不会重新执行处理函数。该缓存仅在内存中，不提供进程重启、跨实例或外部副作用的 exactly-once 保证；业务必须使用 callId 在自己的持久层去重。缓存随辅助器或客户端生命周期释放，不应无限复用一个辅助器处理所有历史 Run。

`tools.stream` 在 waiting 回传后续连原 Run，不创建新 Run。若长时间没有新事件且 Run 未恢复，达到重试上限后抛错。也可自行消费事件，再调用 `tools.handle(client, action, options)`；直接提交已计算的文本使用 `client.submitToolResult(threadId, runId, {callId, outcome, result})`。完整可运行例子见[Node 示例](../../examples/sdk-node/README.md)。

## 错误与契约检查

所有 SDK 请求错误使用 `HooxError`，包含 `status`（网络错误时为空）、`code`、`requestId` 和 `retryable`。HTTP 错误保留服务端错误码；本地错误包括 `ABORTED`、`TIMEOUT`、`NETWORK_ERROR`、`INVALID_CONFIG`、`INVALID_RESPONSE`、`INVALID_STREAM`、`RECONNECT_LIMIT`。错误不包含请求对象、认证头或底层异常，服务端错误中的当前 API Key 会被遮蔽。日志只记录错误码、状态和请求 ID，不记录工具参数、结果或凭据。

请求、响应、事件 DTO 与路由从 `docs/reference/openapi/public-v1.json` 生成，不在 SDK 复制服务端运行时依赖。SSE 批次结构与 `requires_action` payload 按公开 API 说明建模，并由真实 API 集成测试覆盖。协议更新后运行：

```sh
corepack pnpm api:openapi:check
corepack pnpm --filter @hoox/sdk types:generate
corepack pnpm --filter @hoox/sdk types:check
corepack pnpm --filter @hoox/sdk typecheck
corepack pnpm --filter @hoox/sdk test
```

SDK 单元测试包含以 OpenAPI 为输入的生成一致性检查。`tests/integration/sdk-public-api.integration.test.ts` 使用隔离 PostgreSQL Schema 和本地监听的真实 API，验证终端用户隔离、工具回传、断线游标；测试以受控持久事件代替真实模型执行。运行前按仓库集成测试要求准备数据库；连接本地 `agent_runtime_ci` 时必须持有 `/tmp/hoox-m4.lock`。
