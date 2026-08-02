import type { RuntimeEventV1 } from "./ports.js";

export interface RunEventDiagnosticRecord {
  readonly context: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly attemptId: string;
  };
  readonly event: RuntimeEventV1;
}

/** 诊断端口只能观察已提交事件；实现失败不得改变 Runtime 的 durable 语义。 */
export interface RunEventDiagnosticsPort {
  persist(record: RunEventDiagnosticRecord): Promise<void>;
}
