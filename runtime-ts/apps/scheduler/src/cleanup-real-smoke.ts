import { cubeConfigFromEnv, CubeSandboxGateway, SandboxRuntimeError, type SandboxHandle } from "@cube-runtime/sandbox";
import { CubeSandboxCleanupResolver } from "./sandbox-cleanup-consumer.js";

if (process.env.REAL_CUBE_CLEANUP_SMOKE !== "1") {
  throw new Error("真实 Cleanup 冒烟默认关闭；请显式设置 REAL_CUBE_CLEANUP_SMOKE=1");
}

const configuration = cubeConfigFromEnv(process.env);
const gateway = new CubeSandboxGateway({ ...configuration, defaultOperationTimeoutMs: 90_000 });
const resolver = new CubeSandboxCleanupResolver(gateway, 90_000);
let active: SandboxHandle | undefined;

try {
  console.log("[1/5] 创建真实 CubeSandbox");
  active = await gateway.create({ templateId: configuration.templateId, ttlSeconds: 120 });
  const id = active.id;

  console.log("[2/5] 通过 Cleanup resolver pause");
  assertSettled(await resolver.settle({ registryId: "smoke-pause", providerSandboxId: id, disposition: "pause" }));

  console.log("[3/5] 重新连接确认 pause 已实际生效且可恢复");
  active = await gateway.connect(id, { timeoutMs: 90_000 });
  if ((await active.command("printf cleanup-pause-resumed", { timeoutMs: 90_000 })).stdout !== "cleanup-pause-resumed") {
    throw new Error("暂停恢复后的 CubeSandbox 不可用");
  }

  console.log("[4/5] 通过 Cleanup resolver close");
  assertSettled(await resolver.settle({ registryId: "smoke-close", providerSandboxId: id, disposition: "close" }));
  active = undefined;

  console.log("[5/5] 验证 close 后无残留 Sandbox");
  try {
    await gateway.connect(id, { timeoutMs: 90_000 });
    throw new Error("Cleanup close 后仍可连接 Sandbox");
  } catch (error) {
    if (!(error instanceof SandboxRuntimeError) || error.code !== "NOT_FOUND") throw error;
  }
} finally {
  // 失败路径也只做幂等 close；不会留下本次冒烟创建的 Sandbox。
  if (active !== undefined) await active.kill({ ignoreNotFound: true, timeoutMs: 90_000 });
}

function assertSettled(result: "settled" | "unknown"): void {
  if (result !== "settled") throw new Error("Cleanup resolver 返回 unknown，不能把冒烟结果当成功");
}
