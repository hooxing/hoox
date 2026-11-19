// 单次 Run 的 development 计时采集装配；诊断失败不得阻塞模型请求或改变 Run 语义。
import type { RunStartupTimingPhase } from "./ports.js";
import type { ExecutionContext } from "./run-worker-context.js";
import {
  RunPhaseTimingCollector,
  type RunPhaseTimingDiagnosticsPort,
} from "./run-phase-diagnostics.js";
import {
  RunStartupTimingCollector,
  type RunStartupTimingDiagnosticsPort,
} from "./run-startup-diagnostics.js";

export interface RunTimings {
  readonly phase?: RunPhaseTimingCollector;
  readonly startup?: RunStartupTimingCollector;
  readonly startupObserver?: {
    record(phase: RunStartupTimingPhase, durationMs: number): void;
    modelInvocationStarting(): void;
  };
  measureStartup<T>(phase: RunStartupTimingPhase, operation: () => Promise<T>): Promise<T>;
}

export function createRunTimings(input: {
  readonly context: ExecutionContext;
  readonly claimedAt: string;
  readonly startupStartedAt: number;
  readonly phaseDiagnostics?: RunPhaseTimingDiagnosticsPort;
  readonly startupDiagnostics?: RunStartupTimingDiagnosticsPort;
}): RunTimings {
  const { context } = input;
  const identity = {
    tenantId: context.scope.tenantId,
    threadId: context.scope.threadId,
    runId: context.scope.runId,
    attemptId: context.attemptId,
  };
  const phase =
    input.phaseDiagnostics === undefined
      ? undefined
      : new RunPhaseTimingCollector(identity, input.phaseDiagnostics);
  if (phase !== undefined) {
    context.phaseTiming = phase;
    // 同一数据库时钟的创建到领取间隔，重试 Attempt 仍以 Run 创建为起点，不冒充 Broker 排队。
    phase.record({
      phase: "run_queue_wait",
      startedAt: context.run.createdAt,
      durationMs: Math.max(0, Date.parse(input.claimedAt) - Date.parse(context.run.createdAt)),
      status: "succeeded",
    });
  }
  const startup =
    input.startupDiagnostics === undefined
      ? undefined
      : new RunStartupTimingCollector(identity, input.startupDiagnostics, input.startupStartedAt);
  startup?.record("run_claim", performance.now() - input.startupStartedAt);
  return {
    ...(phase === undefined ? {} : { phase }),
    ...(startup === undefined
      ? {}
      : {
          startup,
          startupObserver: {
            record: (span: RunStartupTimingPhase, durationMs: number) =>
              startup.record(span, durationMs),
            modelInvocationStarting: () => startup.publish(),
          },
        }),
    measureStartup: (span, operation) =>
      startup === undefined ? operation() : startup.measure(span, operation),
  };
}
