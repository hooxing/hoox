/**
 * 调度器只处理持久 Outbox 的领取与确认；execute 永远发生在领取事务之外。
 * 该端口要求每次调用携带可信 Tenant scope，不能用跨租户的裸 runId 扫描。
 */
export interface RunExecutionDispatchScope {
  readonly tenantId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly rootRunId: string;
  readonly baseRevisionId?: string;
}

export interface ClaimedRunDispatch {
  readonly outboxId: string;
  readonly generation: number;
  readonly claimToken: string;
  readonly scope: RunExecutionDispatchScope;
}

export type RunExecutionStartResult =
  | { readonly kind: "success" }
  | { readonly kind: "busy"; readonly retryAfterMilliseconds: number }
  | { readonly kind: "terminal" }
  | { readonly kind: "waiting"; readonly retryAfterMilliseconds: number }
  | { readonly kind: "retryable"; readonly retryAfterMilliseconds: number };

export interface RunExecutionStarterPort {
  execute(scope: RunExecutionDispatchScope): Promise<RunExecutionStartResult>;
}

export interface RunDispatchOutboxPort {
  /** 必须在短事务内以 SKIP LOCKED 领取；返回后不持有数据库事务或连接。 */
  claim(input: {
    readonly tenantId: string;
    readonly dispatcherId: string;
    readonly limit: number;
    readonly leaseMilliseconds: number;
  }): Promise<readonly ClaimedRunDispatch[]>;
  /** generation + claimToken 是迟到确认的双栅栏，过期领取者无权覆盖后来者。 */
  acknowledge(input: {
    readonly claim: ClaimedRunDispatch;
    readonly outcome: "dispatched" | "terminal" | "waiting" | "defer";
    readonly retryAfterMilliseconds?: number;
  }): Promise<void>;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

/** 一次 tick 可并行处理多个租户，但每个租户仍只使用自己的 RLS scope 领取。 */
export class RunDispatchScheduler {
  constructor(
    private readonly outbox: RunDispatchOutboxPort,
    private readonly starter: RunExecutionStarterPort,
  ) {}

  async tick(input: {
    readonly tenantId: string;
    readonly dispatcherId: string;
    readonly limit: number;
    readonly leaseMilliseconds: number;
  }): Promise<number> {
    boundedInteger(input.limit, "limit", 1, 100);
    boundedInteger(input.leaseMilliseconds, "leaseMilliseconds", 1_000, 300_000);
    const claimed = await this.outbox.claim(input);
    for (const claim of claimed) {
      // execute 位于 claim() 返回之后，契约禁止 Outbox 实现在此期间保留事务。
      const result = await this.executeSafely(claim);
      await this.outbox.acknowledge({
        claim,
        ...this.acknowledgement(result),
      });
    }
    return claimed.length;
  }

  private async executeSafely(claim: ClaimedRunDispatch): Promise<RunExecutionStartResult> {
    try {
      return await this.starter.execute(claim.scope);
    } catch {
      // 远端 Worker/网络异常一律可重试；原始错误不进入 Outbox 或日志载荷。
      return { kind: "retryable", retryAfterMilliseconds: 5_000 };
    }
  }

  private acknowledgement(result: RunExecutionStartResult): {
    readonly outcome: "dispatched" | "terminal" | "waiting" | "defer";
    readonly retryAfterMilliseconds?: number;
  } {
    switch (result.kind) {
      case "success":
        return { outcome: "dispatched" };
      case "terminal":
        return { outcome: "terminal" };
      case "busy":
      case "waiting":
      case "retryable":
        return {
          outcome: result.kind === "waiting" ? "waiting" : "defer",
          retryAfterMilliseconds: result.retryAfterMilliseconds,
        };
    }
  }
}
