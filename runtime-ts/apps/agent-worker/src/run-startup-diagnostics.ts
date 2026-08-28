import type { RunStartupTimingPhase } from "./ports.js";

export interface RunStartupTimingDiagnosticRecord {
  readonly context: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly attemptId: string;
  };
  readonly observedAt: string;
  readonly totalDurationMs: number;
  readonly spans: readonly {
    readonly phase: RunStartupTimingPhase;
    readonly durationMs: number;
  }[];
}

/** 启动耗时只包含低基数阶段名与数值；失败不得改变模型调用和 durable Run 语义。 */
export interface RunStartupTimingDiagnosticsPort {
  persist(record: RunStartupTimingDiagnosticRecord): Promise<void>;
}

interface RunStartupTimingClock {
  now(): Date;
  monotonicNow(): number;
}

const systemClock: RunStartupTimingClock = Object.freeze({
  now: () => new Date(),
  monotonicNow: () => performance.now(),
});

export class RunStartupTimingCollector {
  readonly #context: RunStartupTimingDiagnosticRecord["context"];
  readonly #diagnostics: RunStartupTimingDiagnosticsPort;
  readonly #clock: RunStartupTimingClock;
  readonly #startedAt: number;
  readonly #spans: Array<RunStartupTimingDiagnosticRecord["spans"][number]> = [];
  #published = false;
  #write: Promise<void> = Promise.resolve();

  constructor(
    context: RunStartupTimingDiagnosticRecord["context"],
    diagnostics: RunStartupTimingDiagnosticsPort,
    startedAt = performance.now(),
    clock: RunStartupTimingClock = systemClock,
  ) {
    this.#context = Object.freeze({ ...context });
    this.#diagnostics = diagnostics;
    this.#startedAt = startedAt;
    this.#clock = clock;
  }

  record(phase: RunStartupTimingPhase, durationMs: number): void {
    if (this.#published || !Number.isFinite(durationMs) || durationMs < 0) return;
    this.#spans.push(Object.freeze({ phase, durationMs }));
  }

  async measure<T>(phase: RunStartupTimingPhase, operation: () => Promise<T>): Promise<T> {
    const startedAt = this.#clock.monotonicNow();
    try {
      return await operation();
    } finally {
      this.record(phase, Math.max(0, this.#clock.monotonicNow() - startedAt));
    }
  }

  publish(): void {
    if (this.#published) return;
    this.#published = true;
    const record: RunStartupTimingDiagnosticRecord = Object.freeze({
      context: this.#context,
      observedAt: this.#clock.now().toISOString(),
      totalDurationMs: Math.max(0, this.#clock.monotonicNow() - this.#startedAt),
      spans: Object.freeze([...this.#spans]),
    });
    this.#write = Promise.resolve()
      .then(() => this.#diagnostics.persist(record))
      .catch(() => undefined);
  }

  async drain(): Promise<void> {
    await this.#write;
  }
}
