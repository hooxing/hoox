import { describe, expect, it } from "vitest";
import { startServiceProcess } from "./service-process.js";

describe("服务进程装配", () => {
  it("缺少生产 assembler 时拒绝启动，不创建空消费者", async () => {
    await expect(
      startServiceProcess({
        serviceName: "agent-worker",
        configuration: { runtimeEnvironment: "production" },
        shutdownTimeoutMilliseconds: 1_000,
      }),
    ).rejects.toMatchObject({ code: "ASSEMBLER_MISSING", serviceName: "agent-worker" });
  });

  it("liveness 不探测依赖，readiness 只暴露稳定检查名，drain 后立即不就绪", async () => {
    const process = await startServiceProcess({
      serviceName: "api",
      configuration: Object.freeze({ runtimeEnvironment: "test" }),
      shutdownTimeoutMilliseconds: 1_000,
      assembler: {
        assemble: async () => ({
          stopAccepting: async () => undefined,
          resources: [],
          readiness: [
            { name: "postgres", probe: async () => undefined },
            {
              name: "object-store",
              probe: async () => {
                throw new Error("credential-canary");
              },
            },
          ],
        }),
      },
    });
    expect(process.liveness()).toEqual({ status: "live" });
    const readiness = await process.readiness();
    expect(readiness).toEqual({ status: "not_ready", failedChecks: ["object-store"] });
    expect(JSON.stringify(readiness)).not.toContain("credential-canary");
    await process.close();
    expect(process.liveness()).toEqual({ status: "stopping" });
    expect(await process.readiness()).toEqual({ status: "not_ready", failedChecks: ["draining"] });
  });

  it("assembler 内部错误被归一化，不泄漏依赖细节", async () => {
    const failure = startServiceProcess({
      serviceName: "scheduler",
      configuration: {},
      shutdownTimeoutMilliseconds: 1_000,
      assembler: {
        assemble: async () => {
          throw new Error("postgres://credential-canary@internal");
        },
      },
    });
    await expect(failure).rejects.toMatchObject({ code: "ASSEMBLY_FAILED" });
    await expect(failure).rejects.not.toThrow("credential-canary");
  });
});
