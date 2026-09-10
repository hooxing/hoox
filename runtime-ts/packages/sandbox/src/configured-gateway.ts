import { CubeSandboxGateway } from "./cube-gateway.js";
import { E2BSandboxGateway } from "./e2b-gateway.js";
import { TencentAgsSandboxGateway } from "./tencent-ags-gateway.js";
import type { SandboxProviderKey } from "./types.js";

export function createConfiguredSandboxGateway(input: {
  providerKey: SandboxProviderKey;
  endpoint: string;
  cubeProxy?: { readonly host: string; readonly port: number; readonly scheme: "http" | "https" };
  apiKey?: string;
  operationTimeoutMs: number;
  sessionTtlSeconds: number;
}) {
  if (input.providerKey === "cube")
    return new CubeSandboxGateway({
      apiUrl: input.endpoint,
      apiKey: input.apiKey ?? null,
      // 托管连接使用版本内代理配置，禁止继承 SDK 的进程级代理环境变量。
      proxyNodeIp: input.cubeProxy?.host ?? null,
      proxyPort: input.cubeProxy?.port ?? 80,
      proxyScheme: input.cubeProxy?.scheme ?? "http",
      defaultOperationTimeoutMs: input.operationTimeoutMs,
      maxCreateTtlSeconds: input.sessionTtlSeconds,
      timeout: input.sessionTtlSeconds,
    });
  if (!input.apiKey) throw new Error("托管沙箱凭据缺失");
  const options = {
    apiKey: input.apiKey,
    domain: input.endpoint,
    defaultOperationTimeoutMs: input.operationTimeoutMs,
    maxCreateTtlSeconds: input.sessionTtlSeconds,
    connectTtlSeconds: input.sessionTtlSeconds,
  };
  return input.providerKey === "e2b"
    ? new E2BSandboxGateway(options)
    : new TencentAgsSandboxGateway(options);
}

/** 后台发布前使用真实模板验证执行与所选空闲策略；清理失败也不能记为健康。 */
export async function probeConfiguredSandbox(
  input: Parameters<typeof createConfiguredSandboxGateway>[0] & {
    templateId: string;
    lifecycleTimeoutMs: number;
    idleAction: "pause" | "kill";
  },
) {
  const gateway = createConfiguredSandboxGateway(input);
  const control = { timeoutMs: Math.min(input.operationTimeoutMs, 30000) };
  const lifecycle = { timeoutMs: input.lifecycleTimeoutMs };
  const sandbox = await gateway.create(
    { templateId: input.templateId, ttlSeconds: Math.min(input.sessionTtlSeconds, 300) },
    lifecycle,
  );
  try {
    const command = await sandbox.command(
      `${input.providerKey === "cube" ? "" : "sudo -n true && "}python3 -c 'print("python-ready")' && node -e 'console.log("node-ready")'`,
      control,
    );
    if (
      command.exitCode !== 0 ||
      !command.stdout.includes("python-ready") ||
      !command.stdout.includes("node-ready")
    )
      throw new Error("沙箱模板执行依赖校验失败");
    const path = "/tmp/hoox-sandbox-probe.txt";
    await sandbox.writeFile(path, "hoox-sandbox-ready", control);
    if ((await sandbox.readFile(path, control)) !== "hoox-sandbox-ready")
      throw new Error("沙箱文件读写校验失败");
    if (input.idleAction === "pause") {
      await sandbox.pause(lifecycle);
      const resumed = await gateway.connect(sandbox.id, lifecycle);
      if ((await resumed.readFile(path, control)) !== "hoox-sandbox-ready")
        throw new Error("沙箱恢复文件校验失败");
    }
  } finally {
    await sandbox.kill({ ...lifecycle, ignoreNotFound: true });
  }
  if ((await gateway.inspect(sandbox.id, control)) !== "not_found")
    throw new Error("沙箱探测实例尚未清理");
}
