import type { IsoTimestamp, Run, TenantId, Thread, UserId, Workspace } from "@hoox/domain";
import type { ThreadListCursor } from "@hoox/persistence";
export type {
  ArchiveThreadCommandPort,
  EnqueueOutboxPort,
  IdempotentCommand,
  IdempotentCreateResult,
  RenamePersonalThreadCommandPort,
  ThreadCreationPort,
} from "@hoox/persistence";

// 认证端口由 @hoox/identity 拥有，供 API 与后台进程共同装配。
export type { AuthContextResolver, AuthPrincipal } from "@hoox/identity/auth";

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
