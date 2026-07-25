import type {
  IsoTimestamp,
  Run,
  RunId,
  RunStatus,
  Sha256Digest,
  TenantId,
  ThreadId,
  Workspace,
  WorkspaceId,
  WorkspaceRevisionId,
} from "@cube-runtime/domain";
import type { ControlledRolloutProjection, RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import type { SandboxHandle, UncertainLifecycleEvent } from "@cube-runtime/sandbox";

export interface ExecutionScope {
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootRunId: RunId;
  readonly workspaceId: WorkspaceId;
  readonly baseRevisionId?: WorkspaceRevisionId;
}

export type ExecutionAttemptStatus =
  | "claimed"
  | "running"
  | "waiting"
  | "finalizing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "recovery_required"
  | "abandoned";

export type ExecutionStage =
  | "claimed"
  | "cleanup_intent_persisted"
  | "model_execution_started"
  | "model_settled"
  | "workspace_verified"
  | "finalizing"
  | "sandbox_settled"
  | "finished";

export interface ExecutionAttemptSnapshot {
  readonly attemptId: string;
  readonly status: ExecutionAttemptStatus;
  readonly stage: ExecutionStage;
  readonly version: number;
  readonly nextEventSequence: number;
  readonly modelExecutionStarted: boolean;
  readonly projectionVersion: number;
  /** Scope 的 baseRevisionId 永不改变；后续 head 只保存在 Attempt checkpoint。 */
  readonly currentRevisionId?: WorkspaceRevisionId;
}

export interface ClaimedExecutionSnapshot {
  readonly run: Run;
  readonly workspace: Workspace;
  readonly attempt: ExecutionAttemptSnapshot;
  readonly input: string;
  readonly answer?: string;
  readonly rolloutProjection: ControlledRolloutProjection;
}

export interface RunClaimFence {
  readonly token: string;
  readonly epoch: number;
  readonly expiresAt: IsoTimestamp;
}

export interface WorkspaceLeaseFence {
  readonly rootRunId: RunId;
  readonly epoch: number;
  readonly expiresAt: IsoTimestamp;
}

/** 每次持久副作用都必须携带完整双栅栏；单独一个 token 或 epoch 不构成写权限。 */
export interface ExecutionFence {
  readonly scope: ExecutionScope;
  readonly runClaim: RunClaimFence;
  readonly workspaceLease: WorkspaceLeaseFence;
}

/** 数据库依据完整双栅栏和 Attempt version 签发的短时外部副作用许可。 */
export interface ExternalEffectPermit {
  readonly permitId: string;
  readonly scope: ExecutionScope;
  readonly runClaimToken: string;
  readonly runClaimEpoch: number;
  readonly workspaceRootRunId: RunId;
  readonly workspaceLeaseEpoch: number;
  readonly attemptVersion: number;
  readonly effect: "model_start" | "tool_execution";
  readonly callId: string;
  readonly toolName: string;
  readonly argsDigest: Sha256Digest;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface ExternalEffectCall {
  readonly callId: string;
  readonly toolName: string;
  readonly argsDigest: Sha256Digest;
}

export interface ConsumedExternalEffectAuthorization {
  readonly permit: ExternalEffectPermit;
  readonly consumedAt: IsoTimestamp;
  /** 只用于限制 DB consume 返回后的本地 continuation 延迟，不代替 DB expiresAt。 */
  readonly consumedAtMonotonicMs: number;
  readonly maxContinuationDelayMs: number;
}

export type ClaimExecutionResult =
  | {
      readonly outcome: "claimed";
      readonly snapshot: ClaimedExecutionSnapshot;
      readonly fence: ExecutionFence;
      readonly databaseNow: IsoTimestamp;
    }
  | {
      readonly outcome:
        | "busy"
        | "terminal"
        | "waiting_for_answer"
        | "not_found"
        | "scope_mismatch"
        | "recovery_required"
        | "unavailable";
    };

export type StableWorkerErrorCode =
  | "CANCELLED"
  | "TIMEOUT"
  | "PROVIDER"
  | "PROTOCOL"
  | "EVENT_REJECTED"
  | "PERSISTENCE_UNAVAILABLE"
  | "FENCE_LOST"
  | "SANDBOX_UNKNOWN"
  | "SANDBOX_FAILED"
  | "WORKSPACE_CONFLICT"
  | "ARTIFACT_NOT_READY"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL";

export type RuntimeEventV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: "agent_event";
      readonly sequence: number;
      readonly payload: RuntimeAgentEvent;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "attempt_state_changed";
      readonly sequence: number;
      readonly payload: {
        readonly status: ExecutionAttemptStatus;
        readonly stage: ExecutionStage;
        readonly code?: StableWorkerErrorCode;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "run_waiting";
      readonly sequence: number;
      readonly payload: { readonly question: string; readonly checkpointId: string };
    };

export type PersistedRuntimeEventV1 = RuntimeEventV1 & { readonly occurredAt: IsoTimestamp };

interface SandboxCleanupOutboxBase {
  readonly schemaVersion: 1;
  readonly kind: "sandbox_cleanup";
  readonly idempotencyKey: string;
  readonly payload: {
    readonly registryId: string;
    readonly providerSandboxId: string;
    readonly disposition: "pause" | "close";
  };
}

/** cleanup Saga 使用判别状态；存储层必须强制 pending→started→completed/unknown。 */
export type RuntimeOutboxV1 =
  | (SandboxCleanupOutboxBase & {
      readonly state: "pending";
      readonly armed: true;
      readonly payload: SandboxCleanupOutboxBase["payload"] & {
        readonly retryCode?: StableWorkerErrorCode;
      };
    })
  | (SandboxCleanupOutboxBase & {
      readonly state: "started";
      readonly payload: SandboxCleanupOutboxBase["payload"];
    })
  | (SandboxCleanupOutboxBase & {
      readonly state: "completed";
      readonly payload: SandboxCleanupOutboxBase["payload"];
    })
  | (SandboxCleanupOutboxBase & {
      readonly state: "unknown";
      readonly payload: SandboxCleanupOutboxBase["payload"] & {
        readonly uncertainEvent: UncertainLifecycleEvent;
        readonly retryCode: "SANDBOX_UNKNOWN";
      };
    })
  | {
      readonly schemaVersion: 1;
      readonly kind: "runtime_alert";
      readonly idempotencyKey: string;
      readonly state: "pending";
      readonly payload: {
        readonly code: StableWorkerErrorCode;
        readonly attemptId: string;
      };
    };

export type PersistedRuntimeOutboxV1 = RuntimeOutboxV1 & { readonly occurredAt: IsoTimestamp };

export interface RuntimeMutation {
  readonly schemaVersion: 1;
  readonly commandDigest: Sha256Digest;
  readonly idempotencyKey: string;
  readonly fence: ExecutionFence;
  readonly expectedAttemptVersion: number;
  readonly nextAttemptStatus?: ExecutionAttemptStatus;
  readonly nextStage?: ExecutionStage;
  readonly events: readonly RuntimeEventV1[];
  /** 同一业务键以 upsert 推进 Saga 状态，禁止把 pending/started/completed 当成三条无关消息。 */
  readonly outbox: readonly RuntimeOutboxV1[];
  readonly rolloutProjection?: ControlledRolloutProjection;
  readonly expectedProjectionVersion?: number;
  /** 只携带验证内容；Revision、Workspace 及时间均由事务内单次 DB now 构造。 */
  readonly workspaceChange?: ValidatedWorkspaceChange;
  readonly nextRunStatus?: Extract<RunStatus, "waiting" | "succeeded" | "failed" | "cancelled">;
  readonly releaseFences?: boolean;
}

export interface RuntimeMutationReceiptV1 {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly commandDigest: Sha256Digest;
  readonly previousAttemptVersion: number;
  readonly attemptVersion: number;
  readonly eventSequenceStart: number;
  readonly eventSequenceEnd: number;
  readonly outbox: readonly {
    readonly idempotencyKey: string;
    readonly payloadDigest: Sha256Digest;
    readonly state: RuntimeOutboxV1["state"];
  }[];
  readonly projection?: {
    readonly schemaVersion: 1;
    readonly previousVersion: number;
    readonly version: number;
    readonly digest: Sha256Digest;
  };
  readonly workspace?: {
    readonly changeDigest: Sha256Digest;
    readonly previousHead?: WorkspaceRevisionId;
    readonly currentHead: WorkspaceRevisionId;
  };
}

export type RuntimeMutationResult =
  | {
      readonly outcome: "applied" | "already_applied";
      readonly attemptVersion: number;
      readonly nextEventSequence: number;
      readonly databaseNow: IsoTimestamp;
      readonly scope: ExecutionScope;
      readonly attempt: ExecutionAttemptSnapshot;
      readonly run: Run;
      readonly workspace: Workspace;
      readonly receipt: RuntimeMutationReceiptV1;
    }
  | {
      readonly outcome:
        | "fence_lost"
        | "conflict"
        | "unavailable"
        | "response_unknown"
        | "idempotency_conflict"
        | "scope_mismatch";
    };

export type FenceInspectionResult =
  | {
      readonly outcome: "active";
      readonly fence: ExecutionFence;
      readonly databaseNow: IsoTimestamp;
      readonly run: Run;
      readonly workspace: Workspace;
    }
  | { readonly outcome: "fence_lost" | "cancelled" | "unavailable" | "scope_mismatch" };

export interface ExecutionPersistencePort {
  /** DB 必须用自己的时钟原子创建 Attempt、queued/waiting→running、领取 claim 与 Workspace lease。 */
  claim(input: {
    readonly scope: ExecutionScope;
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }): Promise<ClaimExecutionResult>;
  inspectAndRenew(input: {
    readonly fence: ExecutionFence;
    readonly leaseDurationMs: number;
  }): Promise<FenceInspectionResult>;
  issueExternalEffectPermit(input: {
    readonly fence: ExecutionFence;
    readonly expectedAttemptVersion: number;
    readonly effect: ExternalEffectPermit["effect"];
    readonly call: ExternalEffectCall;
    readonly permitDurationMs: number;
  }): Promise<
    | { readonly outcome: "authorized"; readonly permit: ExternalEffectPermit }
    | {
        readonly outcome:
          | "cancelled"
          | "fence_lost"
          | "conflict"
          | "unavailable"
          | "scope_mismatch";
      }
  >;
  consumeExternalEffectPermit(input: {
    readonly fence: ExecutionFence;
    readonly expectedAttemptVersion: number;
    readonly permit: ExternalEffectPermit;
  }): Promise<
    | { readonly outcome: "consumed"; readonly databaseNow: IsoTimestamp }
    | {
        readonly outcome:
          | "already_consumed"
          | "expired"
          | "cancelled"
          | "fence_lost"
          | "conflict"
          | "unavailable"
          | "scope_mismatch";
      }
  >;
  mutate(command: RuntimeMutation): Promise<RuntimeMutationResult>;
  readMutation(input: {
    readonly scope: ExecutionScope;
    readonly idempotencyKey: string;
  }): Promise<RuntimeMutationResult | { readonly outcome: "not_found" }>;
  /** 只有恢复协调器可调用；running Run 不能由普通 Worker 直接重领。 */
  recoverExpiredAttempt(input: {
    readonly scope: ExecutionScope;
    readonly decision: "safe_fail" | "require_manual_recovery" | "abandon";
  }): Promise<"recovered" | "not_expired" | "not_found" | "scope_mismatch" | "unavailable">;
}

export interface WorkspaceRevisionCandidate {
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly rootRunId: RunId;
  readonly parentRevisionId?: WorkspaceRevisionId;
  readonly revisionId: WorkspaceRevisionId;
  readonly objectKey: string;
  readonly digest: Sha256Digest;
}

export type ValidatedWorkspaceChange = WorkspaceRevisionCandidate;

export interface WorkspaceRevisionVerifierPort {
  verify(input: {
    readonly scope: ExecutionScope;
    readonly expectedCurrentRevisionId?: WorkspaceRevisionId;
    readonly sandbox: SandboxHandle;
  }): Promise<WorkspaceRevisionCandidate | undefined>;
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
  | { readonly outcome: "failed"; readonly code: StableWorkerErrorCode };

export type SandboxSettlementResult =
  | { readonly outcome: "settled" }
  | { readonly outcome: "unknown"; readonly event: UncertainLifecycleEvent };

export interface SandboxSessionRegistryPort {
  acquire(input: {
    readonly scope: ExecutionScope;
    readonly signal: AbortSignal;
  }): Promise<SandboxAcquireResult>;
  settle(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
    /** 必须引用已持久化 cleanup intent；只有失去栅栏后的 orphan best-effort 使用 registry 恢复键。 */
    readonly cleanupIntentId: string;
    readonly disposition: "pause" | "close";
  }): Promise<SandboxSettlementResult>;
}

export type AgentTurnOutcome =
  | { readonly kind: "completed" }
  | {
      readonly kind: "waiting";
      readonly question: string;
      readonly rolloutProjection: ControlledRolloutProjection;
    };

export interface WorkerAgentSessionPort {
  /** 新 Session 无论首轮还是 waiting 恢复都用 prompt 启动模型；禁止对空 Session 调 followUp。 */
  runPrompt(
    text: string,
    authorization: ConsumedExternalEffectAuthorization,
  ): Promise<AgentTurnOutcome>;
  abort(): Promise<void>;
  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void;
  dispose(): void;
}

export interface AgentSessionFactoryPort {
  create(input: {
    readonly scope: ExecutionScope;
    readonly sandbox: SandboxHandle;
    readonly rolloutProjection: ControlledRolloutProjection;
    readonly authorizeToolEffect: (
      call: ExternalEffectCall,
    ) => Promise<ConsumedExternalEffectAuthorization>;
  }): Promise<WorkerAgentSessionPort>;
}

export interface RecoveryMetricsPort {
  recordOrphanCleanup(input: {
    readonly scope: ExecutionScope;
    readonly registryId: string;
    readonly reason: RuntimeMutationResult["outcome"] | "cancelled" | "timeout";
    readonly cleanupOutcome: "settled" | "unknown" | "failed";
  }): Promise<void>;
}

export interface CancellationPort {
  signalFor(scope: ExecutionScope): AbortSignal;
}

export interface ScheduledTask {
  cancel(): void;
}

export interface HeartbeatTask {
  stop(): Promise<void>;
}

export interface ClockPort {
  schedule(delayMs: number, callback: () => void): ScheduledTask;
  startHeartbeat(intervalMs: number, callback: () => Promise<void>): HeartbeatTask;
}

export interface ArtifactPublicationPort {
  assertReadyForCompletion(input: {
    readonly scope: ExecutionScope;
    readonly workspaceRevisionId?: WorkspaceRevisionId;
  }): Promise<void>;
}

export const MAX_RUNTIME_EVENT_BYTES = 64 * 1024;
export const MAX_RUNTIME_OUTBOX_BYTES = 64 * 1024;

export function assertProtocolSize(value: RuntimeEventV1 | RuntimeOutboxV1): void {
  const limit =
    value.kind === "sandbox_cleanup" || value.kind === "runtime_alert"
      ? MAX_RUNTIME_OUTBOX_BYTES
      : MAX_RUNTIME_EVENT_BYTES;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limit) {
    throw new Error("EVENT_REJECTED");
  }
}
