import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { startServiceProcess } from "./service-process.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
      configuration: { runtimeEnvironment: "test" },
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

  it("readiness 探针执行期间进入 draining 时不能返回过期 ready", async () => {
    const probeStarted = deferred<void>();
    const probeFinished = deferred<void>();
    const process = await startServiceProcess({
      serviceName: "api",
      configuration: { runtimeEnvironment: "test" } as const,
      shutdownTimeoutMilliseconds: 1_000,
      assembler: {
        assemble: async () => ({
          stopAccepting: async () => undefined,
          resources: [],
          readiness: [
            {
              name: "postgres",
              probe: async () => {
                probeStarted.resolve();
                await probeFinished.promise;
              },
            },
          ],
        }),
      },
    });

    const status = process.readiness();
    await probeStarted.promise;
    const closing = process.close();
    probeFinished.resolve();
    await expect(status).resolves.toEqual({ status: "not_ready", failedChecks: ["draining"] });
    await closing;
  });

  it("装配结果校验失败后仍关闭已创建资源，且只暴露稳定错误", async () => {
    const closed: string[] = [];
    await expect(
      startServiceProcess({
        serviceName: "scheduler",
        configuration: { runtimeEnvironment: "test" } as const,
        shutdownTimeoutMilliseconds: 1_000,
        assembler: {
          assemble: async () =>
            ({
              stopAccepting: async () => undefined,
              resources: [{ name: "postgres", close: async () => closed.push("postgres") }],
              readiness: [{ name: "INVALID!", probe: async () => undefined }],
            }) as never,
        },
      }),
    ).rejects.toMatchObject({ code: "ASSEMBLY_FAILED" });
    expect(closed).toEqual(["postgres"]);
  });

  it("装配期间收到信号会在资源出现后立即进入 draining", async () => {
    const source = new EventEmitter();
    const assembled = deferred<{
      stopAccepting: () => Promise<void>;
      resources: [];
      readiness: [];
    }>();
    const starting = startServiceProcess({
      serviceName: "agent-worker",
      configuration: { runtimeEnvironment: "test" } as const,
      shutdownTimeoutMilliseconds: 1_000,
      signalSource: source,
      assembler: { assemble: async () => assembled.promise },
    });
    source.emit("SIGTERM");
    assembled.resolve({ stopAccepting: async () => undefined, resources: [], readiness: [] });
    const process = await starting;
    expect(process.liveness()).toEqual({ status: "stopping" });
    await expect(process.readiness()).resolves.toEqual({
      status: "not_ready",
      failedChecks: ["draining"],
    });
    await process.close();
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });

  it("生产环境拒绝注入的 Fake assembler，不能伪造 ready", async () => {
    let assembleCalls = 0;
    await expect(
      startServiceProcess({
        serviceName: "api",
        configuration: { runtimeEnvironment: "production" } as const,
        shutdownTimeoutMilliseconds: 1_000,
        assembler: {
          assemble: async () => {
            assembleCalls += 1;
            return { stopAccepting: async () => undefined, resources: [], readiness: [] };
          },
        },
      }),
    ).rejects.toMatchObject({ code: "PRODUCTION_ASSEMBLY_UNAVAILABLE" });
    expect(assembleCalls).toBe(0);
  });

  it("启动后替换 assembler 数组、名称或方法不会改变已冻结的关闭与探针计划", async () => {
    const calls: string[] = [];
    const resource = {
      name: "postgres",
      close: async () => {
        calls.push("original-close");
      },
    };
    const probe = {
      name: "postgres",
      probe: async () => {
        calls.push("original-probe");
      },
    };
    const resources = [resource];
    const readiness = [probe];
    const process = await startServiceProcess({
      serviceName: "api",
      configuration: { runtimeEnvironment: "test" } as const,
      shutdownTimeoutMilliseconds: 1_000,
      assembler: {
        assemble: async () => ({ stopAccepting: async () => undefined, resources, readiness }),
      },
    });

    resource.close = async () => {
      calls.push("replaced-close");
    };
    probe.probe = async () => {
      calls.push("replaced-probe");
    };
    resources.push({
      name: "malicious",
      close: async () => {
        calls.push("injected-close");
      },
    });
    readiness.push({
      name: "postgres",
      probe: async () => {
        calls.push("injected-probe");
      },
    });

    await expect(process.readiness()).resolves.toEqual({ status: "ready" });
    await process.close();
    expect(calls).toEqual(["original-probe", "original-close"]);
  });

  it("关闭失败回调只收到稳定错误，不能泄漏 configuration 中的秘密", async () => {
    const secret = "shutdown-configuration-secret-canary";
    const source = new EventEmitter();
    const reported: string[] = [];
    const process = await startServiceProcess({
      serviceName: "scheduler",
      configuration: { runtimeEnvironment: "test", secret } as const,
      shutdownTimeoutMilliseconds: 1_000,
      signalSource: source,
      onShutdownFailure: (error) => reported.push(String(error)),
      assembler: {
        assemble: async () => ({
          stopAccepting: async () => undefined,
          readiness: [],
          resources: [
            {
              name: "object-store",
              close: async () => {
                throw new Error(secret);
              },
            },
          ],
        }),
      },
    });
    source.emit("SIGTERM");
    await expect(process.close()).rejects.toMatchObject({ code: "RESOURCE_CLOSE_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toEqual(["ProcessLifecycleError: RESOURCE_CLOSE_FAILED:object-store"]);
    expect(reported.join(",")).not.toContain(secret);
  });

  it("异步失败回调被拒绝时也不会产生 unhandledRejection", async () => {
    const source = new EventEmitter();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const service = await startServiceProcess({
        serviceName: "scheduler",
        configuration: { runtimeEnvironment: "test" } as const,
        shutdownTimeoutMilliseconds: 1_000,
        signalSource: source,
        onShutdownFailure: async () => {
          throw new Error("async-callback-rejection");
        },
        assembler: {
          assemble: async () => ({
            stopAccepting: async () => undefined,
            readiness: [],
            resources: [
              {
                name: "object-store",
                close: async () => {
                  throw new Error("resource-failure");
                },
              },
            ],
          }),
        },
      });
      source.emit("SIGINT");
      await expect(service.close()).rejects.toMatchObject({ code: "RESOURCE_CLOSE_FAILED" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
