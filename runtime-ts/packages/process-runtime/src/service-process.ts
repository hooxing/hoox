import {
  installProcessSignalHandlers,
  ProcessLifecycle,
  type ProcessSignalRegistration,
  type ProcessSignalSource,
  type ShutdownResource,
} from "./lifecycle.js";

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
    readonly code: "ASSEMBLER_MISSING" | "ASSEMBLY_FAILED",
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

/**
 * 本函数只编排已经注入的生产依赖。没有 assembler 时始终拒绝启动，
 * 不会用内存 Fake、开发身份或空消费者伪装为可用生产进程。
 */
export async function startServiceProcess<TConfiguration>(input: {
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
  let assembly: ServiceAssembly;
  try {
    assembly = await input.assembler.assemble(input.configuration);
  } catch {
    throw new ServiceAssemblyError(input.serviceName, "ASSEMBLY_FAILED");
  }
  const probeNames = new Set<string>();
  for (const probe of assembly.readiness) {
    if (!componentNamePattern.test(probe.name) || probeNames.has(probe.name)) {
      throw new TypeError("就绪探针名称无效或重复");
    }
    probeNames.add(probe.name);
  }
  const lifecycle = new ProcessLifecycle({
    stopAccepting: assembly.stopAccepting,
    resources: assembly.resources,
    shutdownTimeoutMilliseconds: input.shutdownTimeoutMilliseconds,
  });
  let registration: ProcessSignalRegistration | undefined;
  registration = installProcessSignalHandlers(lifecycle, {
    ...(input.signalSource === undefined ? {} : { source: input.signalSource }),
    onFailure: (error) => input.onShutdownFailure?.(error),
  });

  return Object.freeze({
    lifecycle,
    liveness(): LivenessStatus {
      return { status: lifecycle.accepting ? "live" : "stopping" };
    },
    async readiness(): Promise<ReadinessStatus> {
      if (!lifecycle.accepting) return { status: "not_ready", failedChecks: ["draining"] };
      const failed: string[] = [];
      for (const probe of assembly.readiness) {
        try {
          await probe.probe();
        } catch {
          failed.push(probe.name);
        }
      }
      return failed.length === 0
        ? { status: "ready" }
        : { status: "not_ready", failedChecks: Object.freeze(failed) };
    },
    async close(): Promise<void> {
      try {
        await lifecycle.close();
      } finally {
        registration?.dispose();
        registration = undefined;
      }
    },
  });
}
