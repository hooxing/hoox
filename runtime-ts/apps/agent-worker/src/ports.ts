import type {
  RunId,
  TenantId,
  ThreadId,
  WorkspaceId,
  WorkspaceRevisionId,
} from "@cube-runtime/domain";
import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type { SandboxHandle, UncertainLifecycleEvent } from "@cube-runtime/sandbox";

export interface RunScope {
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootRunId: RunId;
}

export type WorkerRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunSnapshot extends RunScope {
  readonly workspaceId: WorkspaceId;
  readonly status: WorkerRunStatus;
  readonly input: string;
  readonly followUp?: string;
  readonly stateVersion: number;
  readonly nextEventSequence: number;
}

export interface RunClaim {
  readonly token: string;
  readonly epoch: number;
  readonly expiresAt: Date;
  readonly snapshot: RunSnapshot;
}

export type RunClaimResult =
  | { readonly outcome: "claimed"; readonly claim: RunClaim }
  | { readonly outcome: "busy" | "terminal" | "not_found" | "scope_mismatch" };

export interface PersistedRunEvent {
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export interface OutboxMessage {
  readonly idempotencyKey: string;
  readonly topic: "sandbox.lifecycle.unknown" | "sandbox.recovery.required";
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export interface RunCommitCommand {
  readonly scope: RunScope;
  readonly claimToken: string;
  readonly claimEpoch: number;
  readonly expectedStateVersion: number;
  readonly events: readonly PersistedRunEvent[];
  readonly outbox: readonly OutboxMessage[];
  readonly nextStatus?: WorkerRunStatus;
  readonly releaseClaim?: boolean;
}

export type RunCommitResult =
  | {
      readonly outcome: "committed" | "already_applied";
      readonly stateVersion: number;
      readonly nextEventSequence: number;
    }
  | { readonly outcome: "fence_lost" | "conflict" | "unavailable" };

/**
 * 该端口的生产实现必须在一个事务中检查 claim 栅栏、追加事件/Outbox、迁移状态并推进高水位。
 * 将这些动作拆到多个 Repository 会让“事件成功但状态失败”等半提交无法恢复。
 */
export interface RunPersistencePort {
  /**
   * 原子领取时必须同时校验 scope 和可执行性，并把状态迁移为 running。
   * waiting 只有已经持久化 followUp 时才可领取，否则应返回 busy。
   */
  claim(input: {
    readonly scope: RunScope;
    readonly workerId: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<RunClaimResult>;
  renewClaim(input: {
    readonly scope: RunScope;
    readonly claimToken: string;
    readonly claimEpoch: number;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<"renewed" | "fence_lost" | "unavailable">;
  commit(command: RunCommitCommand): Promise<RunCommitResult>;
}

export interface WorkspaceLease {
  readonly token: string;
  readonly epoch: number;
  readonly expiresAt: Date;
  readonly baseRevisionId?: WorkspaceRevisionId;
}

export type WorkspaceLeaseResult =
  | { readonly outcome: "acquired"; readonly lease: WorkspaceLease }
  | { readonly outcome: "busy" | "scope_mismatch" | "unavailable" };

export interface VerifiedWorkspaceRevision {
  readonly verified: true;
  readonly baseRevisionId?: WorkspaceRevisionId;
  readonly revisionId: WorkspaceRevisionId;
  readonly objectKey: string;
  readonly digest: string;
  readonly idempotencyKey: string;
}

export interface WorkspacePort {
  acquireLease(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<WorkspaceLeaseResult>;
  renewLease(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly lease: WorkspaceLease;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<"renewed" | "lease_lost" | "unavailable">;
  commitVerifiedRevision(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly lease: WorkspaceLease;
    readonly revision: VerifiedWorkspaceRevision;
  }): Promise<"committed" | "already_applied" | "lease_lost" | "revision_conflict" | "unavailable">;
  releaseLease(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly lease: WorkspaceLease;
  }): Promise<void>;
}

export interface WorkspaceRevisionVerifierPort {
  verify(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly baseRevisionId?: WorkspaceRevisionId;
    readonly sandbox: SandboxHandle;
  }): Promise<VerifiedWorkspaceRevision | undefined>;
}

export interface SandboxSessionRef {
  readonly registryId: string;
  readonly providerSandboxId: string;
  readonly mode: "created" | "connected";
  readonly sandbox: SandboxHandle;
}

export type SandboxAcquireResult =
  | { readonly outcome: "ready"; readonly session: SandboxSessionRef }
  | { readonly outcome: "unknown"; readonly event: UncertainLifecycleEvent }
  | { readonly outcome: "failed"; readonly code: string };

export type SandboxSettlementResult =
  | { readonly outcome: "settled" }
  | { readonly outcome: "unknown"; readonly event: UncertainLifecycleEvent };

export interface SandboxSessionRegistryPort {
  acquire(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly baseRevisionId?: WorkspaceRevisionId;
    readonly signal: AbortSignal;
  }): Promise<SandboxAcquireResult>;
  settle(input: {
    readonly scope: RunScope;
    readonly session: SandboxSessionRef;
    readonly disposition: "pause" | "close";
  }): Promise<SandboxSettlementResult>;
}

export type AgentTurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "waiting"; readonly question: string };

export interface WorkerAgentSessionPort {
  run(input: {
    readonly mode: "prompt" | "follow_up";
    readonly text: string;
  }): Promise<AgentTurnOutcome>;
  abort(): Promise<void>;
  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void;
  dispose(): void;
}

export interface AgentSessionFactoryPort {
  create(input: {
    readonly scope: RunScope;
    readonly sandbox: SandboxHandle;
  }): Promise<WorkerAgentSessionPort>;
}

export interface CancellationPort {
  signalFor(scope: RunScope): AbortSignal;
}

export interface ScheduledTask {
  cancel(): void;
}

export interface HeartbeatTask {
  stop(): Promise<void>;
}

export interface ClockPort {
  now(): Date;
  schedule(delayMs: number, callback: () => void): ScheduledTask;
  startHeartbeat(intervalMs: number, callback: () => Promise<void>): HeartbeatTask;
}

/** 本阶段只固定完成前置条件；真正的 Artifact 发布由后续 Artifact Service 实现。 */
export interface ArtifactPublicationPort {
  assertReadyForCompletion(input: {
    readonly scope: RunScope;
    readonly workspaceRevisionId?: WorkspaceRevisionId;
  }): Promise<void>;
}
