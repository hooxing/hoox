import { randomUUID } from "node:crypto";
import { ClientTools, HooxClient, HooxError } from "../../runtime-ts/packages/sdk/dist/index.js";

const apiKey = process.env.HOOX_API_KEY;
const agentDefinitionId = process.env.HOOX_AGENT_ID;
if (
  !apiKey ||
  !agentDefinitionId ||
  apiKey.includes("REPLACE") ||
  agentDefinitionId.includes("REPLACE")
) {
  console.error("请配置示例所需的 HOOX_API_KEY 和 HOOX_AGENT_ID，不要把真实值写进源码。");
  process.exitCode = 1;
} else {
  const client = new HooxClient({
    baseUrl: process.env.HOOX_API_ORIGIN ?? "http://127.0.0.1:3001",
    apiKey,
    endUser: "Customer:example",
  });
  const tools = new ClientTools().register("lookup_weather", async (args, context) => {
    if (context.signal.aborted) throw new Error("操作已取消");
    if (typeof args.city !== "string") throw new Error("city 必须是字符串");
    return JSON.stringify({ city: args.city, weather: "晴", source: "示例固定数据" });
  });
  try {
    const thread = await client.createThread(
      { title: "SDK 客户端工具示例", agentDefinitionId },
      { idempotencyKey: `thread-${randomUUID()}` },
    );
    const run = await client.createRun(
      thread.id,
      { input: "请用 lookup_weather 查询上海天气，再告诉我结果。" },
      { idempotencyKey: `run-${randomUUID()}` },
    );
    for await (const event of tools.stream(client, thread.id, run.id, {
      signal: AbortSignal.timeout(600_000),
    })) {
      if (event.event !== "run-events") continue;
      for (const item of event.data.page.items) {
        if (item.type === "message.delta") {
          const delta = item.payload.delta;
          if (typeof delta === "string") process.stdout.write(delta);
        }
      }
    }
    console.log(`\nRun 状态：${(await client.getRun(thread.id, run.id)).status}`);
  } catch (error) {
    if (error instanceof HooxError) {
      console.error({ code: error.code, status: error.status, requestId: error.requestId });
    } else {
      console.error("示例运行失败");
    }
    process.exitCode = 1;
  }
}
