# Node SDK 流式对话示例

本示例面向在业务后端接入 Hoox 的开发者，用真实公开 API 演示流式 Run 和客户端工具，不调用外部天气服务。SDK 的完整接口和失败语义见[TypeScript SDK](../../docs/reference/sdk-typescript.md)。示例需要 Node 20+；仓库安装和构建仍使用根 `package.json` 固定的工具链。

## 运行条件

- 本地 API 与 Worker 已启动，地址通过 `HOOX_API_ORIGIN` 指定。
- 平台管理员已发布一个允许当前空间使用的 Agent，启用 native 工具调用并声明客户端工具 `lookup_weather`，参数 Schema 为 `{ "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"], "additionalProperties": false }`；不要同时启用 PTC。
- API Key 有 `threads:read`、`threads:create`、`runs:read`、`runs:create`、`tool-results:submit`、`end-users:represent` 作用域。Key 只存在于运行此示例的后端环境，不得进入浏览器或源码。

在仓库根目录执行：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @hoox/sdk build
HOOX_API_ORIGIN=http://127.0.0.1:3001 \
HOOX_API_KEY=REPLACE_WITH_BACKEND_API_KEY \
HOOX_AGENT_ID=REPLACE_WITH_PUBLISHED_AGENT_ID \
node examples/sdk-node/main.mjs
```

以上变量只属于示例进程，不是 Hoox 服务端配置；占位值必须由部署方通过安全环境注入替换。示例拒绝占位 Key 与 Agent ID。`lookup_weather` 返回固定 JSON 文本，终端打印 `message.delta` 和最终 Run 状态。每次执行使用新幂等键并创建新 Thread；生产业务应保存幂等键与 Run ID，在重试时复用。
