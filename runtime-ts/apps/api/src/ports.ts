import type { IsoTimestamp, Run, TenantId, Thread, UserId, Workspace } from "@cube-runtime/domain";
import type { ThreadListCursor } from "@cube-runtime/persistence";
export type {
  ArchiveThreadCommandPort,
  EnqueueOutboxPort,
  IdempotentCommand,
  IdempotentCreateResult,
  ThreadCreationPort,
} from "@cube-runtime/persistence";

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

export interface ThreadCursorCodec {
  encode(
    scope: { readonly tenantId: TenantId; readonly userId: UserId },
    cursor: ThreadListCursor,
  ): string;
  decode(
    scope: { readonly tenantId: TenantId; readonly userId: UserId },
    value: string,
  ): ThreadListCursor;
}
