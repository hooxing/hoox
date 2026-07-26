import {
  ProcessLifecycle,
  type ProcessSignalRegistration,
  type ProcessSignalSource,
  type ShutdownResource,
} from "./lifecycle.js";
import type { RuntimeEnvironment } from "./environment.js";

export interface ReadinessProbe {
  readonly name: string;
  probe(): Promise<void>;
}

export type LivenessStatus = { readonly status: "live" | "stopping" };
export type ReadinessStatus =
  | { readonly status: "ready" }
  | { readonly status: "not_ready"; readonly failedChecks: readonly string[] };

export interface ServiceAssembly {
  readonly stopAccepting: () => Promise<void>;
  readonly resources: readonly ShutdownResource[];
  readonly readiness: readonly ReadinessProbe[];
}

export interface ServiceAssemblyFactory<TConfiguration> {
  assemble(configuration: TConfiguration): Promise<ServiceAssembly>;
}

export class ServiceAssemblyError extends Error {
  constructor(
    readonly serviceName: string,
    readonly code: "ASSEMBLER_MISSING" | "ASSEMBLY_FAILED" | "PRODUCTION_ASSEMBLY_UNAVAILABLE",
  ) {
    super(`${code}:${serviceName}`);
    this.name = "ServiceAssemblyError";
  }
}

export interface RunningServiceProcess {
  readonly lifecycle: ProcessLifecycle;
  liveness(): LivenessStatus;
  readiness(): Promise<ReadinessStatus>;
  close(): Promise<void>;
}

const componentNamePattern = /^[a-z][a-z0-9_-]{0,63}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function validateAssembly(assembly: unknown): asserts assembly is ServiceAssembly {
  if (!isRecord(assembly) || typeof assembly.stopAccepting !== "function") {
    throw new TypeError("服务装配结果无效");
  }
  if (!Array.isArray(assembly.resources) || !Array.isArray(assembly.readiness)) {
    throw new TypeError("服务装配资源无效");
  }
  for (const resource of assembly.resources) {
    if (
      !isRecord(resource) ||
      typeof resource.name !== "string" ||
      typeof resource.close !== "function"
    ) {
      throw new TypeError("关闭资源无效");
    }
  }
  for (const probe of assembly.readiness) {
    if (!isRecord(probe) || typeof probe.name !== "string" || typeof probe.probe !== "function") {
      throw new TypeError("就绪探针无效");
    }
  }
}

function snapshotAssembly(assembly: ServiceAssembly): ServiceAssembly {
  return Object.freeze({
    stopAccepting: assembly.stopAccepting.bind(assembly),
    resources: Object.freeze(
      assembly.resources.map((resource) =>
        Object.freeze({ name: resource.name, close: resource.close.bind(resource) }),
      ),
    ),
    readiness: Object.freeze(
      assembly.readiness.map((probe) =>
        Object.freeze({ name: probe.name, probe: probe.probe.bind(probe) }),
      ),
    ),
  });
}

/**
 * 装配器可能已打开部分连接后才返回非法结果。只要仍可识别 close，就按声明顺序尽力释放，
 * 但绝不让清理异常覆盖稳定的装配失败错误码。
 */
async function closePartiallyAssembledResources(assembly: unknown): Promise<void> {
  if (!isRecord(assembly) || !Array.isArray(assembly.resources)) return;
  for (const resource of assembly.resources) {
    if (!isRecord(resource) || typeof resource.close !== "function") continue;
    try {
      await resource.close();
    } catch {
      // 装配失败路径不泄漏资源驱动的底层异常。
    }
  }
}

/**
 * 在异步装配开始前登记信号。若信号落在装配窗口，绑定 lifecycle 后立即开始关闭，
 * 这样启动方至多得到 draining 的对象，绝不会把该对象报告为 ready。
 */
function installStartupSafeSignalHandlers(input: {
  readonly source: ProcessSignalSource;
  readonly onFailure?: (error: Error) => void;
}): {
  readonly bind: (lifecycle: ProcessLifecycle) => void;
  readonly registration: ProcessSignalRegistration;
} {
  let lifecycle: ProcessLifecycle | undefined;
  let closeRequested = false;
  let disposed = false;

  const reportFailure = (error: unknown) => {
    try {
      // JS 调用方可能返回 rejected Promise；和同步异常一样在边界吸收。
      void Promise.resolve(
        input.onFailure?.(error instanceof Error ? error : new Error("进程关闭失败")),
      ).catch(() => undefined);
    } catch {
      // 日志回调失败不影响信号清理，也不能产生未处理 rejection。
    }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.source.off("SIGTERM", listener);
    input.source.off("SIGINT", listener);
  };
  const requestClose = () => {
    if (lifecycle === undefined) return;
    void lifecycle.close().then(dispose, (error: unknown) => {
      reportFailure(error);
      dispose();
    });
  };
  const listener = () => {
    closeRequested = true;
    requestClose();
  };
  input.source.on("SIGTERM", listener);
  input.source.on("SIGINT", listener);

  return Object.freeze({
    bind(nextLifecycle) {
      lifecycle = nextLifecycle;
      if (closeRequested) requestClose();
    },
    registration: Object.freeze({ dispose }),
  });
}

/**
 * 本函数只编排已经注入的生产依赖。没有 assembler 时始终拒绝启动，
 * 不会用内存 Fake、开发身份或空消费者伪装为可用生产进程。
 */
export async function startServiceProcess<
  TConfiguration extends Readonly<{ runtimeEnvironment: RuntimeEnvironment }>,
>(input: {
  readonly serviceName: string;
  readonly configuration: TConfiguration;
  readonly shutdownTimeoutMilliseconds: number;
  readonly assembler?: ServiceAssemblyFactory<TConfiguration>;
  readonly signalSource?: ProcessSignalSource;
  readonly onShutdownFailure?: (error: Error) => void;
}): Promise<RunningServiceProcess> {
  if (!componentNamePattern.test(input.serviceName)) throw new TypeError("服务名称无效");
  if (input.assembler === undefined) {
    throw new ServiceAssemblyError(input.serviceName, "ASSEMBLER_MISSING");
  }
  // 真实生产 assembler 尚不存在，故不接受任何测试 Fake 冒充生产服务。
  if (input.configuration.runtimeEnvironment === "production") {
    throw new ServiceAssemblyError(input.serviceName, "PRODUCTION_ASSEMBLY_UNAVAILABLE");
  }
  const startupSignals = installStartupSafeSignalHandlers({
    source: input.signalSource ?? process,
    ...(input.onShutdownFailure === undefined ? {} : { onFailure: input.onShutdownFailure }),
  });
  let assembly: unknown;
  let normalizedAssembly: ServiceAssembly;
  let lifecycle: ProcessLifecycle;
  try {
    assembly = await input.assembler.assemble(input.configuration);
    validateAssembly(assembly);
    // assembler/最外层日志只可记录稳定 serviceName 和错误码，禁止序列化 configuration。
    const probeNames = new Set<string>();
    for (const probe of assembly.readiness) {
      if (!componentNamePattern.test(probe.name) || probeNames.has(probe.name)) {
        throw new TypeError("就绪探针名称无效或重复");
      }
      probeNames.add(probe.name);
    }
    normalizedAssembly = snapshotAssembly(assembly);
    lifecycle = new ProcessLifecycle({
      stopAccepting: normalizedAssembly.stopAccepting,
      resources: normalizedAssembly.resources,
      shutdownTimeoutMilliseconds: input.shutdownTimeoutMilliseconds,
    });
  } catch {
    await closePartiallyAssembledResources(assembly);
    startupSignals.registration.dispose();
    throw new ServiceAssemblyError(input.serviceName, "ASSEMBLY_FAILED");
  }
  startupSignals.bind(lifecycle);

  return Object.freeze({
    lifecycle,
    liveness(): LivenessStatus {
      return { status: lifecycle.accepting ? "live" : "stopping" };
    },
    async readiness(): Promise<ReadinessStatus> {
      if (!lifecycle.accepting) return { status: "not_ready", failedChecks: ["draining"] };
      const failed: string[] = [];
      for (const probe of normalizedAssembly.readiness) {
        try {
          await probe.probe();
        } catch {
          failed.push(probe.name);
        }
      }
      // 探针可能执行很久；关闭开始后不能依据过期 accepting 快照报告 ready。
      if (!lifecycle.accepting) return { status: "not_ready", failedChecks: ["draining"] };
      return failed.length === 0
        ? { status: "ready" }
        : { status: "not_ready", failedChecks: Object.freeze(failed) };
    },
    async close(): Promise<void> {
      try {
        await lifecycle.close();
      } finally {
        startupSignals.registration.dispose();
      }
    },
  });
}
