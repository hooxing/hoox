export type InternalTrajectoryScalar = null | boolean | number | string;

export type InternalTrajectoryValue =
  | InternalTrajectoryScalar
  | readonly InternalTrajectoryValue[]
  | { readonly [key: string]: InternalTrajectoryValue };

export interface InternalTrajectoryContext {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly agentThreadId?: string;
  readonly agentTurnId?: string;
}

export interface InternalTrajectoryEventV1 {
  readonly schemaVersion: 1;
  /** Attempt 或子 Agent Session 内严格递增；与公开 Runtime Event sequence 相互独立。 */
  readonly sequence: number;
  readonly occurredAt: string;
  /** 从当前 Session 记录器创建开始计算，便于重建短事件的真实耗时。 */
  readonly monotonicOffsetMs: number;
  readonly source: "pi" | "runtime";
  readonly type: string;
  /** 完整事件快照；特殊 JS 值使用 $cubeInternalType 标签编码，不做摘要或截断。 */
  readonly event: InternalTrajectoryValue;
}

export interface InternalTrajectoryDiagnosticRecord {
  readonly context: InternalTrajectoryContext;
  readonly event: InternalTrajectoryEventV1;
}

/** 敏感内部诊断端口；实现失败不得改变 Agent 或 durable Run 语义。 */
export interface InternalTrajectoryDiagnosticsPort {
  persist(record: InternalTrajectoryDiagnosticRecord): Promise<void>;
  onFailure?(failure: { readonly attemptId: string; readonly sequence: number }): void;
}

export interface InternalTrajectoryClock {
  now(): Date;
  monotonicNow(): number;
}

const systemClock: InternalTrajectoryClock = Object.freeze({
  now: () => new Date(),
  monotonicNow: () => performance.now(),
});

/**
 * 将任意 Pi 事件转换成 JSON 可持久化快照。普通对象保持原形；只有 JSON 本身无法表达的值
 * 才使用显式标签，避免 undefined、二进制、非有限数字、BigInt 或循环引用静默丢失。
 */
export function snapshotInternalTrajectoryValue(value: unknown): InternalTrajectoryValue {
  const seen = new Map<object, string>();
  return snapshotValue(value, "$", seen);
}

function snapshotValue(
  value: unknown,
  path: string,
  seen: Map<object, string>,
): InternalTrajectoryValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    return tagged("number", String(value));
  }
  if (typeof value === "undefined") return tagged("undefined");
  if (typeof value === "bigint") return tagged("bigint", value.toString(10));
  if (typeof value === "symbol") return tagged("symbol", value.description ?? "");
  if (typeof value === "function") return tagged("function", value.name);

  const object = value as object;
  const previous = seen.get(object);
  if (previous !== undefined) return tagged("reference", previous);
  seen.set(object, path);

  if (value instanceof Uint8Array) {
    return {
      $cubeInternalType: "bytes",
      encoding: "base64",
      value: Buffer.from(value).toString("base64"),
    };
  }
  if (value instanceof Date) return tagged("date", value.toISOString());
  if (value instanceof Error) {
    const properties: Record<string, InternalTrajectoryValue> = {};
    for (const key of Object.keys(value).sort()) {
      properties[key] = snapshotValue(
        (value as unknown as Record<string, unknown>)[key],
        propertyPath(path, key),
        seen,
      );
    }
    return {
      $cubeInternalType: "error",
      name: value.name,
      message: value.message,
      stack: value.stack ?? "",
      properties,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => snapshotValue(item, `${path}[${index}]`, seen));
  }
  if (value instanceof Map) {
    return {
      $cubeInternalType: "map",
      entries: [...value.entries()].map(([key, item], index) => [
        snapshotValue(key, `${path}.<key:${index}>`, seen),
        snapshotValue(item, `${path}.<value:${index}>`, seen),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      $cubeInternalType: "set",
      values: [...value.values()].map((item, index) =>
        snapshotValue(item, `${path}.<set:${index}>`, seen),
      ),
    };
  }

  const output: Record<string, InternalTrajectoryValue> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = snapshotValue(
      (value as Record<string, unknown>)[key],
      propertyPath(path, key),
      seen,
    );
  }
  return output;
}

function tagged(type: string, value?: string): InternalTrajectoryValue {
  return value === undefined ? { $cubeInternalType: type } : { $cubeInternalType: type, value };
}

const secretProperty =
  /(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|credential)/iu;

function redactSensitiveValues(value: InternalTrajectoryValue): InternalTrajectoryValue {
  if (Array.isArray(value)) return value.map(redactSensitiveValues);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).map(([key, item]) => {
    if (key.toLowerCase() === "headers") return [key, "[REDACTED]"] as const;
    if (secretProperty.test(key)) return [key, "[REDACTED]"] as const;
    return [key, redactSensitiveValues(item)] as const;
  });
  return Object.fromEntries(entries);
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

/**
 * 每个 Session 使用独立串行链：监听器不阻塞 Pi，但文件顺序与接收顺序一致；持久化失败
 * 被隔离在诊断面，drain 也不会向 Run 主流程抛出。
 */
export class InternalTrajectoryAttemptRecorder {
  readonly #context: InternalTrajectoryContext;
  readonly #diagnostics: InternalTrajectoryDiagnosticsPort;
  readonly #clock: InternalTrajectoryClock;
  readonly #startedAtMonotonicMs: number;
  #nextSequence = 1;
  #chain: Promise<void> = Promise.resolve();

  constructor(
    context: InternalTrajectoryContext,
    diagnostics: InternalTrajectoryDiagnosticsPort,
    clock: InternalTrajectoryClock = systemClock,
  ) {
    this.#context = Object.freeze({ ...context });
    this.#diagnostics = diagnostics;
    this.#clock = clock;
    this.#startedAtMonotonicMs = clock.monotonicNow();
  }

  record(source: InternalTrajectoryEventV1["source"], type: string, event: unknown): void {
    const record: InternalTrajectoryDiagnosticRecord = {
      context: this.#context,
      event: {
        schemaVersion: 1,
        sequence: this.#nextSequence++,
        occurredAt: this.#clock.now().toISOString(),
        monotonicOffsetMs: Math.max(0, this.#clock.monotonicNow() - this.#startedAtMonotonicMs),
        source,
        type,
        event: redactSensitiveValues(snapshotInternalTrajectoryValue(event)),
      },
    };
    this.#chain = this.#chain
      .catch(() => undefined)
      .then(() => this.#diagnostics.persist(record))
      .catch(() => {
        try {
          this.#diagnostics.onFailure?.({
            attemptId: record.context.attemptId,
            sequence: record.event.sequence,
          });
        } catch {
          return;
        }
      });
  }

  async drain(): Promise<void> {
    await this.#chain.catch(() => undefined);
  }
}
