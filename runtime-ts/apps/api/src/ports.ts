import type { IsoTimestamp, Run, TenantId, Thread, UserId, Workspace } from "@cube-runtime/domain";
import type { TenantScope } from "@cube-runtime/persistence";

export interface AuthPrincipal {
  readonly userId: UserId;
  readonly tenantId: TenantId;
}

/**
 * 生产身份供应商的适配入口。实现必须先验证凭据，再返回可信 principal；
 * 不能从 x-tenant-id 等普通客户端 Header 直接构造租户身份。
 */
export interface AuthContextResolver {
  resolve(input: {
    readonly authorization: string | undefined;
    readonly requestId: string;
  }): Promise<AuthPrincipal | undefined>;
}

export interface IdempotentCommand {
  readonly key: string;
  readonly requestHash: string;
}

export type IdempotentCreateResult<T> =
  | { readonly outcome: "created" | "replayed"; readonly entity: T }
  | { readonly outcome: "key_conflict" }
  | { readonly outcome: "parent_inactive" };

/** Thread、空 Workspace 与幂等记录必须在同一个持久化事务中提交。 */
export interface ThreadCreationPort {
  createThread(input: {
    readonly scope: TenantScope;
    readonly thread: Thread;
    readonly workspace: Workspace;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Thread>>;
}

/**
 * Run、enqueue outbox 与幂等记录的原子边界。返回 created 前必须保证 Worker 最终可领取；
 * 当前 PostgreSQL Repository 尚未实现该事务，生产装配不得用顺序双写冒充。
 */
export interface EnqueueOutboxPort {
  createQueuedRun(input: {
    readonly scope: TenantScope;
    readonly run: Run;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Run>>;
}

export interface ApiClock {
  now(): IsoTimestamp;
}

export interface ApiIdGenerator {
  thread(): Thread["id"];
  run(): Run["id"];
  workspace(): Workspace["id"];
}

export interface ReadinessPort {
  probe(): Promise<void>;
}
