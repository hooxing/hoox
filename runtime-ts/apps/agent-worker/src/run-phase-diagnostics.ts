import type { ExecutionPhaseTiming, ExecutionPhaseTimingObserver } from "@hoox/domain";
import type { RunStartupTimingDiagnosticRecord } from "./run-startup-diagnostics.js";

export interface RunPhaseTimingDiagnosticRecord extends ExecutionPhaseTiming {
  readonly context: RunStartupTimingDiagnosticRecord["context"];
  readonly sequence: number;
}

export interface RunPhaseTimingDiagnosticsPort {
  persist(record: RunPhaseTimingDiagnosticRecord): Promise<void>;
}

/** 每个 Attempt 独立编号；持久化失败被隔离，且不会进入公开事件或模型上下文。 */
export class RunPhaseTimingCollector implements ExecutionPhaseTimingObserver {
  #sequence = 0;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: RunPhaseTimingDiagnosticRecord["context"],
    private readonly diagnostics: RunPhaseTimingDiagnosticsPort,
  ) {}

  record(span: ExecutionPhaseTiming): void {
    if (!Number.isFinite(span.durationMs) || span.durationMs < 0) return;
    const record = Object.freeze({ ...span, context: this.context, sequence: ++this.#sequence });
    this.#writes = this.#writes.then(() => this.diagnostics.persist(record)).catch(() => undefined);
  }

  async drain(): Promise<void> {
    await this.#writes;
  }
}
