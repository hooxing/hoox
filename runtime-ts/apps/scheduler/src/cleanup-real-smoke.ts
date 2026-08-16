import {
  cubeConfigFromEnv,
  CubeSandboxGateway,
  SandboxRuntimeError,
  type SandboxHandle,
} from "@aisay/sandbox";
import { CubeSandboxCleanupResolver } from "./sandbox-cleanup-consumer.js";

if (process.env.REAL_CUBE_CLEANUP_SMOKE !== "1") {
  throw new Error("真实 Cleanup 冒烟默认关闭；请显式设置 REAL_CUBE_CLEANUP_SMOKE=1");
}

const configuration = cubeConfigFromEnv(process.env);
const gateway = new CubeSandboxGateway({ ...configuration, defaultOperationTimeoutMs: 90_000 });
const resolver = new CubeSandboxCleanupResolver(gateway, 90_000);
let active: SandboxHandle | undefined;
let createdId: string | undefined;

try {
  console.log("[1/5] 创建真实 CubeSandbox");
  active = await gateway.create({ templateId: configuration.templateId, ttlSeconds: 120 });
  const id = active.id;
  createdId = id;

  console.log("[2/5] 通过 Cleanup resolver pause");
  assertSettled(
    await resolver.settle({
      registryId: "smoke-pause",
      providerKey: "cube",
      providerSandboxId: id,
      disposition: "pause",
    }),
  );

  console.log("[3/5] 重新连接确认 pause 已实际生效且可恢复");
  active = await gateway.connect(id, { timeoutMs: 90_000 });
  if (
    (await active.command("printf cleanup-pause-resumed", { timeoutMs: 90_000 })).stdout !==
    "cleanup-pause-resumed"
  ) {
    throw new Error("暂停恢复后的 CubeSandbox 不可用");
  }

  console.log("[4/5] 通过 Cleanup resolver close");
  assertSettled(
    await resolver.settle({
      registryId: "smoke-close",
      providerKey: "cube",
      providerSandboxId: id,
      disposition: "close",
    }),
  );

  console.log("[5/5] 验证 close 后无残留 Sandbox");
  try {
    // 若 close 实际失效，保存新句柄让 finally 无条件回收，不能因断言失败泄漏实例。
    active = await gateway.connect(id, { timeoutMs: 90_000 });
    throw new Error("Cleanup close 后仍可连接 Sandbox");
  } catch (error) {
    if (!(error instanceof SandboxRuntimeError) || error.code !== "NOT_FOUND") throw error;
    active = undefined;
  }
} finally {
  // 失败路径也只做幂等 close；不会留下本次冒烟创建的 Sandbox。
  if (active !== undefined) await active.kill({ ignoreNotFound: true, timeoutMs: 90_000 });
  else if (createdId !== undefined) {
    // close 后的 connect 验证或其他断言若提前中断，也再以 provider id 做一次最终幂等回收。
    await gateway
      .connect(createdId, { timeoutMs: 90_000 })
      .then((sandbox) => sandbox.kill({ ignoreNotFound: true, timeoutMs: 90_000 }))
      .catch((error: unknown) => {
        if (error instanceof SandboxRuntimeError && error.code === "NOT_FOUND") return;
        throw error;
      });
  }
}

function assertSettled(result: "settled" | "unknown"): void {
  if (result !== "settled") throw new Error("Cleanup resolver 返回 unknown，不能把冒烟结果当成功");
}
