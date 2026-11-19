export const EXECUTION_TIMING_PHASES = [
  "run_queue_wait",
  "sandbox_acquire",
  "sandbox_create",
  "sandbox_connect",
  "sandbox_initialize",
  "sandbox_resource_prepare",
  "sandbox_resource_probe",
  "workspace_materialize",
  "workspace_history_prepare",
  "workspace_verify",
  // Workspace materialize/verify 的子阶段；同一阶段可多次出现，分析时按阶段求和。
  "workspace_open",
  "workspace_head_load",
  "workspace_snapshot",
  "workspace_journal",
  "workspace_candidate_persist",
  "workspace_candidate_upload",
  "workspace_stable_read",
  "workspace_file_write",
  "sandbox_settle",
  "tool_prepare",
  "tool_authorize",
  "tool_execute",
  "tool_call_persist",
  "tool_receipt_persist",
  "file_read",
  "file_upload",
  "file_metadata_commit",
  "runtime_persist",
] as const;

export type ExecutionTimingPhase = (typeof EXECUTION_TIMING_PHASES)[number];

export interface ExecutionPhaseTiming {
  readonly phase: ExecutionTimingPhase;
  readonly startedAt: string;
  readonly durationMs: number;
  /** 表示被测调用正常返回或抛出；业务结果仍以原始运行/工具日志为准。 */
  readonly status: "succeeded" | "failed";
  readonly toolCallId?: string;
  readonly toolName?: string;
}

/** 诊断只接收阶段与关联标识，不接收参数、正文、路径或凭据。 */
export interface ExecutionPhaseTimingObserver {
  record(span: ExecutionPhaseTiming): void;
}

/** 持续时间使用单调时钟；诊断失败不得改变被测操作的返回值或原始异常。 */
export async function measureExecutionPhase<T>(
  observer: ExecutionPhaseTimingObserver | undefined,
  phase: ExecutionTimingPhase,
  operation: () => Promise<T>,
  details: Pick<ExecutionPhaseTiming, "toolCallId" | "toolName"> = {},
): Promise<T> {
  if (observer === undefined) return operation();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let status: ExecutionPhaseTiming["status"] = "failed";
  try {
    const result = await operation();
    status = "succeeded";
    return result;
  } finally {
    try {
      observer.record({
        phase,
        startedAt,
        durationMs: Math.max(0, performance.now() - started),
        status,
        ...details,
      });
    } catch {
      // 诊断不是副作用许可或执行事实，不参与恢复决策。
    }
  }
}
