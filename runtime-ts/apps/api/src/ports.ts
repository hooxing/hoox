import type { IsoTimestamp, Run, TenantId, Thread, UserId, Workspace } from "@aisay/domain";
import type { ThreadListCursor } from "@aisay/persistence";
export type {
  ArchiveThreadCommandPort,
  EnqueueOutboxPort,
  IdempotentCommand,
  IdempotentCreateResult,
  ThreadCreationPort,
} from "@aisay/persistence";

export interface AuthPrincipal {
  readonly userId: UserId;
  /**
   * 固定开发 fixture 才携带已绑定的 tenant。生产 JWT principal 只有受验签保护的 sub，
   * 租户由请求选择器与 PostgreSQL Membership/RLS 二次授权后再构造 TenantScope。
   */
  readonly tenantId?: TenantId;
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

/** HTTP 层对 `X-Tenant-Id` 的单值快照；它只选择待验证租户，绝不是授权事实。 */
export type TenantSelector =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "invalid" }>
  | Readonly<{ readonly kind: "selected"; readonly value: string }>;

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
