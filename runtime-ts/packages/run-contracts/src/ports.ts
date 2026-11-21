import type {
  AgentThreadId,
  ExecutionPhaseTimingObserver,
  IsoTimestamp,
  ResourceId,
  ResourceVersionId,
  Run,
  RunId,
  RunPersonalizationSnapshot,
  RunStatus,
  Sha256Digest,
  TenantId,
  ThreadId,
  TodoSnapshot,
  TodoWriteCommand,
  Workspace,
  WorkspaceId,
  WorkspaceRevisionId,
} from "@hoox/domain";
import type { RunSkillSnapshot } from "@hoox/skill";
import type { WorkspaceManifest } from "@hoox/workspace";
import type { ExternalToolSnapshotError } from "./external-tool.js";
import type { ControlledRolloutProjection } from "./rollout-projection.js";
import type { RunAgentSnapshot, RunAgentStopCode } from "./run-agent-snapshot.js";
import type { RuntimeAgentEvent } from "./runtime-agent-event.js";
import type { SandboxHandle, SandboxProviderKey, UncertainLifecycleEvent } from "./sandbox-port.js";
import type { ThreadActiveHistoryV1 } from "./thread-history.js";

export interface ExecutionScope {
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootRunId: RunId;
  readonly workspaceId: WorkspaceId;
  readonly baseRevisionId?: WorkspaceRevisionId;
}

export type AgentKind = "root" | "subagent";

export interface AgentExecutionIdentity {
  readonly agentThreadId: AgentThreadId;
  readonly agentTurnId: string;
  readonly agentKind: AgentKind;
}

export const DELEGABLE_AGENT_TOOL_NAMES = [
  "exec_command",
  "read",
  "edit",
  "write",
  "skill",
] as const;
export type DelegableAgentToolName = (typeof DELEGABLE_AGENT_TOOL_NAMES)[number];
export type AgentForkTurns = "none" | "all" | number;

export interface AgentSummary {
  readonly agentThreadId: AgentThreadId;
  readonly path: string;
  readonly initialTask: string;
  readonly currentTask: string;
  readonly status: "running" | "idle" | "interrupted" | "failed";
  readonly turnOrdinal: number;
  readonly startedAt?: string;
  readonly activeForMs?: number;
  readonly lastMailboxSequence: number;
  readonly tools: readonly DelegableAgentToolName[];
}

export type AgentMailboxUpdate =
  | {
      readonly sequence: number;
      readonly senderPath: string;
      readonly kind: "message";
      readonly payload: string;
    }
  | {
      readonly sequence: number;
      readonly senderPath: string;
      readonly kind: "final_answer";
      readonly status: "completed";
      readonly payload: string;
    }
  | {
      readonly sequence: number;
      readonly senderPath: string;
      readonly kind: "error";
      readonly status: "interrupted" | "failed";
      readonly errorCode: string;
      readonly payload: string;
    };

export interface AgentMailboxBatch {
  readonly updates: readonly AgentMailboxUpdate[];
  readonly nextAfterSequence: number;
  readonly timedOut: boolean;
}

/** Root Pi 工具只依赖该进程内控制面；Workspace 与 Sandbox 所有权仍由 RunWorker 持有。 */
export interface AgentControlPort {
  spawn(input: {
    readonly callId: string;
    readonly task: string;
    readonly tools: readonly DelegableAgentToolName[];
    /** 精确版本授权；省略或空数组都不下放外部工具。 */
    readonly externalToolVersionIds?: readonly string[];
    readonly forkTurns: AgentForkTurns;
  }): Promise<AgentSummary>;
  sendMessage(input: {
    readonly callId: string;
    readonly target: string;
    readonly message: string;
  }): Promise<void>;
  followUp(input: {
    readonly callId: string;
    readonly target: string;
    readonly task: string;
  }): Promise<AgentSummary>;
  interrupt(input: { readonly callId: string; readonly target: string }): Promise<AgentSummary>;
  list(): Promise<readonly AgentSummary[]>;
  wait(input: {
    readonly afterSequence: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<AgentMailboxBatch>;
  /** Session Factory 在完成可信历史恢复后设置 fork 来源；它不进入模型工具协议。 */
  setParentHistory(history: ThreadActiveHistoryV1 | undefined): void;
}

export interface AgentThreadPersistenceSnapshot {
  readonly agentThreadId: AgentThreadId;
  readonly parentAgentThreadId: AgentThreadId;
  readonly canonicalPath: string;
  readonly task: string;
  readonly tools: readonly DelegableAgentToolName[];
  readonly externalToolVersionIds?: readonly string[];
  readonly toolManifestDigest: Sha256Digest;
  readonly forkTurns: AgentForkTurns;
  readonly turnId: string;
  readonly turnOrdinal: number;
  readonly history?: ThreadActiveHistoryV1;
}

/** 跟随主 Thread 持久化的子 Agent 对话；活动执行仍只属于当前 Root Run。 */
export interface SubAgentConversationSnapshot {
  readonly agentThreadId: AgentThreadId;
  readonly canonicalPath: string;
  readonly task: string;
  readonly currentTask: string;
  readonly tools: readonly DelegableAgentToolName[];
  readonly externalToolVersionIds?: readonly string[];
  readonly toolManifestDigest: Sha256Digest;
  readonly forkTurns: AgentForkTurns;
  readonly turnOrdinal: number;
  readonly history?: ThreadActiveHistoryV1;
}

/** AgentSupervisor 的 durable 窄端口；每个命令都必须在同一事务重验当前 Attempt 双栅栏。 */
export interface AgentControlPersistencePort {
  initializeRoot(input: {
    readonly fence: ExecutionFence;
    readonly attemptId: string;
    readonly rootAgentThreadId: AgentThreadId;
  }): Promise<
    | {
        readonly outcome: "ready";
        readonly conversations: readonly SubAgentConversationSnapshot[];
      }
    | { readonly outcome: "not_authorized" | "conflict" | "unavailable" }
  >;
  spawn(input: {
    readonly fence: ExecutionFence;
    readonly attemptId: string;
    readonly commandId: string;
    readonly argsDigest: Sha256Digest;
    readonly snapshot: AgentThreadPersistenceSnapshot;
    readonly maxThreads: number;
    readonly maxActiveSubagents: number;
  }): Promise<
    | {
        readonly outcome: "created" | "replayed";
        readonly snapshot: AgentThreadPersistenceSnapshot;
      }
    | { readonly outcome: "capacity" | "conflict" | "not_authorized" | "unavailable" }
  >;
  queueFollowUp(input: {
    readonly fence: ExecutionFence;
    readonly attemptId: string;
    readonly callerAgentThreadId: AgentThreadId;
    readonly commandId: string;
    readonly argsDigest: Sha256Digest;
    readonly agentThreadId: AgentThreadId;
    readonly turnId: string;
    readonly turnOrdinal: number;
    readonly task: string;
    readonly maxActiveSubagents: number;
  }): Promise<"created" | "replayed" | "busy" | "conflict" | "not_authorized" | "unavailable">;
  startTurn(input: {
    readonly fence: ExecutionFence;
    readonly attemptId: string;
    readonly agentThreadId: AgentThreadId;
    readonly turnId: string;
  }): Promise<"started" | "replayed" | "conflict" | "not_authorized" | "unavailable">;
  settleTurn(input: {
    readonly fence: ExecutionFence;
    readonly attemptId: string;
    readonly agentThreadId: AgentThreadId;
    readonly turnId: string;
    readonly status: "completed" | "interrupted" | "failed";
    readonly finalAnswer?: string;
    readonly errorCode?: string;
    /** 只有 completed turn 可以提交新的可复用对话历史。 */
    readonly history?: ThreadActiveHistoryV1;
  }): Promise<"settled" | "replayed" | "conflict" | "not_authorized" | "unavailable">;
  appendMailbox(input: {
    readonly fence: ExecutionFence;
    readonly attemptId: string;
    readonly commandId: string;
    readonly recipientAgentThreadId: AgentThreadId;
    readonly senderAgentThreadId: AgentThreadId;
    readonly kind: AgentMailboxUpdate["kind"];
    readonly terminalStatus?: "completed" | "interrupted" | "failed";
    readonly errorCode?: string;
    readonly payload: string;
  }): Promise<
    | { readonly outcome: "created" | "replayed"; readonly sequence: number }
    | { readonly outcome: "conflict" | "not_authorized" | "unavailable" }
  >;
  recordCommand(input: {
    readonly fence: ExecutionFence;
    readonly attemptId: string;
    readonly callerAgentThreadId: AgentThreadId;
    readonly commandId: string;
    readonly kind: "send_message" | "interrupt";
    readonly argsDigest: Sha256Digest;
    readonly result: Readonly<Record<string, unknown>>;
  }): Promise<"recorded" | "replayed" | "conflict" | "not_authorized" | "unavailable">;
}

/** 由 API 授权并持久化的当前 user turn 附件身份；文件内容永不进入调度表。 */
export interface UserInputAttachmentReference {
  readonly resourceId: ResourceId;
  readonly versionId: ResourceVersionId;
}

export interface AgentUserInput {
  readonly text: string;
  readonly attachments: readonly UserInputAttachmentReference[];
}

/** 仅存在于 Worker 内存；Base64 图片不得进入 Run/Thread 持久化事实。 */
export interface PreparedAgentUserInput {
  readonly text: string;
  readonly images: readonly Readonly<{
    type: "image";
    data: string;
    mimeType: string;
  }>[];
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
  readonly agent: RunAgentSnapshot | RunAgentStopCode;
  readonly run: Run;
  /** 由领取事务从可信 Tenant 事实投影；旧快照缺失时必须按未启用历史目录处理。 */
  readonly tenantKind?: "personal" | "team";
  /** 个人 Tenant 为 owner；团队 Tenant 仅作为审计主体，外部共享 scope 不使用该值。 */
  readonly memorySubjectUserId?: string;
  /** 创建或提交该 Run 的用户；旧 Run 缺失时由 Worker 使用历史任务创建者兼容。 */
  readonly requestedByUserId?: string;
  readonly workspace: Workspace;
  readonly attempt: ExecutionAttemptSnapshot;
  readonly input: string;
  readonly attachments?: readonly UserInputAttachmentReference[];
  readonly answer?: string;
  readonly rolloutProjection: ControlledRolloutProjection;
  /** 激活时冻结；当前 Run 自身输入不属于这段 predecessor history。 */
  readonly contextThroughSequence?: number;
  /** API 创建 Run 时冻结；Worker 不反查用户当前安装集合。 */
  readonly skills?: RunSkillSnapshot;
}

export type ThreadContextEntryKindV1 =
  | "run_started"
  | "user_message"
  | "assistant_message"
  | "tool_call"
  | "tool_result"
  | "workspace_committed"
  | "workspace_unchanged"
  | "run_terminal"
  | "compaction_checkpoint"
  | "legacy_history_gap"
  | "legacy_v2_anchor";

export type ThreadContextBodyV1 =
  | {
      readonly storage: "inline";
      readonly value: Readonly<Record<string, unknown>>;
      readonly sha256: Sha256Digest;
      readonly size: number;
    }
  | {
      readonly storage: "blob";
      readonly referenceId: string;
      readonly sha256: Sha256Digest;
      readonly size: number;
      readonly incarnationId: string;
      readonly physicalObjectKey: string;
    };

export interface ThreadContextAppendEntryV1 {
  readonly entryId: string;
  readonly kind: ThreadContextEntryKindV1;
  readonly body: ThreadContextBodyV1;
  /** result 必须指向同批或既有 assistant_message 中真实存在的 call。 */
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface ThreadContextAppendCommandV1 {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly entries: readonly ThreadContextAppendEntryV1[];
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
  readonly effect: "model_start" | "model_continue" | "agent_model_start" | "tool_execution";
  readonly callId: string;
  readonly toolName: string;
  readonly toolVersionId?: string;
  readonly argsDigest: Sha256Digest;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface ExternalEffectCall {
  readonly callId: string;
  readonly toolName: string;
  readonly toolVersionId?: string;
  readonly argsDigest: Sha256Digest;
}

/**
 * 首次 tool.started 必须和事件在同一事务中登记。
 * 存储层以 (scope, attemptId, callId) 建永久唯一约束；即使名称完全相同也禁止再次登记。
 */
export interface EffectInvocationRegistration {
  readonly callId: string;
  readonly toolName: string;
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
  | RunAgentStopCode
  | "AGENT_CONFIGURATION_UNSUPPORTED"
  | "EXTERNAL_TOOL_RESULT_UNKNOWN"
  | "EXTERNAL_TOOL_REVOKED"
  | "EXTERNAL_TOOL_SNAPSHOT_INVALID"
  | "CANCELLED"
  | "CONTEXT_TOO_LARGE"
  | "TIMEOUT"
  | "PROVIDER"
  | "PROTOCOL"
  | "EVENT_REJECTED"
  | "WORKER_SHUTDOWN"
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
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "sandbox_recovery_decided";
      readonly sequence: number;
      readonly payload:
        | {
            readonly decision: "sandbox_reused";
            readonly checkpointId: string;
            readonly registryId: string;
            readonly generation: number;
          }
        | {
            readonly decision: "sandbox_rebuilt";
            readonly checkpointId: string;
            readonly reason:
              | "missing"
              | "ttl_expired"
              | "generation_mismatch"
              | "scope_mismatch"
              | "base_revision_mismatch";
          };
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "artifact_correction_requested";
      readonly sequence: number;
      readonly payload: {
        readonly round: number;
        readonly maxRounds: number;
        readonly code: "ARTIFACT_NOT_READY";
        readonly feedback: string;
      };
    };

export type PersistedRuntimeEventV1 = RuntimeEventV1 & { readonly occurredAt: IsoTimestamp };

interface SandboxCleanupOutboxBase {
  readonly schemaVersion: 1;
  readonly kind: "sandbox_cleanup";
  readonly idempotencyKey: string;
  /** armed 是行级永久事实，进入 started/completed/unknown 后也不得撤销。 */
  readonly armed: true;
  readonly payload: {
    readonly registryId: string;
    readonly providerKey: SandboxProviderKey;
    readonly providerSandboxId: string;
  };
}

interface DecidedSandboxCleanupOutboxBase extends SandboxCleanupOutboxBase {
  readonly payload: SandboxCleanupOutboxBase["payload"] & {
    readonly disposition: "pause" | "close";
  };
}

/** cleanup Saga 使用判别状态；存储层必须强制 pending→started→completed/unknown。 */
export type RuntimeOutboxV1 =
  | (SandboxCleanupOutboxBase & {
      readonly state: "pending";
      readonly payload: SandboxCleanupOutboxBase["payload"] & {
        readonly retryCode?: StableWorkerErrorCode;
      };
    })
  | (DecidedSandboxCleanupOutboxBase & {
      readonly state: "started";
    })
  | (DecidedSandboxCleanupOutboxBase & {
      readonly state: "completed";
    })
  | (DecidedSandboxCleanupOutboxBase & {
      readonly state: "unknown";
      readonly payload: DecidedSandboxCleanupOutboxBase["payload"] & {
        readonly uncertainEvent: UncertainLifecycleEvent;
        readonly retryCode: "SANDBOX_UNKNOWN";
      };
    })
  | {
      readonly schemaVersion: 1;
      readonly kind: "sandbox_lifecycle_unknown";
      readonly idempotencyKey: string;
      readonly state: "unknown";
      readonly payload: {
        readonly requestId: string;
        readonly sandboxId?: string;
        readonly actualTtlSeconds: number;
        readonly stage: UncertainLifecycleEvent["stage"];
        readonly uncertainEvent: UncertainLifecycleEvent;
        readonly retryCode: "SANDBOX_UNKNOWN";
      };
    }
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

export type PersistedRuntimeOutboxV1 =
  | (Extract<RuntimeOutboxV1, { kind: "sandbox_cleanup" }> & {
      readonly armedAt: IsoTimestamp;
      readonly occurredAt: IsoTimestamp;
    })
  | (Exclude<RuntimeOutboxV1, { kind: "sandbox_cleanup" }> & {
      readonly occurredAt: IsoTimestamp;
    });

export interface RuntimeMutation {
  readonly schemaVersion: 1;
  readonly commandDigest: Sha256Digest;
  readonly idempotencyKey: string;
  readonly fence: ExecutionFence;
  readonly expectedAttemptVersion: number;
  readonly nextAttemptStatus?: ExecutionAttemptStatus;
  readonly nextStage?: ExecutionStage;
  readonly events: readonly RuntimeEventV1[];
  /** 与本事务中的唯一 tool.started 事件原子登记；登记过的 callId 在 Attempt 内永久不可复用。 */
  readonly effectInvocation?: EffectInvocationRegistration;
  /** 同一业务键以 upsert 推进 Saga 状态，禁止把 pending/started/completed 当成三条无关消息。 */
  readonly outbox: readonly RuntimeOutboxV1[];
  readonly rolloutProjection?: ControlledRolloutProjection;
  readonly expectedProjectionVersion?: number;
  /** 只携带验证内容；Revision、Workspace 及时间均由事务内单次 DB now 构造。 */
  readonly workspaceChange?: ValidatedWorkspaceChange;
  readonly nextRunStatus?: Extract<RunStatus, "waiting" | "succeeded" | "failed" | "cancelled">;
  readonly releaseFences?: boolean;
  /** 与 Attempt/Workspace/terminal 状态在同一 Thread writer 事务中追加。 */
  readonly threadContextAppend?: ThreadContextAppendCommandV1;
  /** 阶段 3：事务从 durable receipt 构造真实 user_message，调用方不能覆盖正文。 */
  readonly threadSteer?: {
    readonly receiptId: string;
    readonly targetTurnId: string;
    readonly bodyDigest: Sha256Digest;
  };
  /**
   * 阶段 5：仅在 releaseFences 的 Run terminal mutation 中使用。存储层在同一 Thread
   * writer 事务内决定 running handoff 或 pause intent；Worker 不能预先猜测队列是否为空。
   */
  readonly threadSandboxTerminal?: ThreadSandboxTerminalCommandV1;
}

export interface RuntimeMutationReceiptV1 {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly commandDigest: Sha256Digest;
  readonly previousAttemptVersion: number;
  readonly attemptVersion: number;
  readonly eventSequenceStart: number;
  readonly eventSequenceEnd: number;
  readonly outbox: readonly RuntimeOutboxReceiptV1[];
  /** 存储层返回已写入永久唯一表的原始身份，Worker 必须逐字段核对。 */
  readonly effectInvocation?: EffectInvocationRegistration;
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
  readonly threadContext?: {
    readonly schemaVersion: 1;
    readonly firstSequence: number;
    readonly lastSequence: number;
    readonly entryCount: number;
  };
  readonly threadSteer?: {
    readonly receiptId: string;
    readonly targetTurnId: string;
    readonly appliedContextSequence: number;
    readonly bodyDigest: Sha256Digest;
  };
  readonly threadSandbox?: ThreadSandboxTerminalReceiptV1;
}

export type RuntimeOutboxReceiptV1 =
  | {
      readonly kind: "sandbox_cleanup";
      readonly idempotencyKey: string;
      readonly payloadDigest: Sha256Digest;
      readonly state: Extract<RuntimeOutboxV1, { kind: "sandbox_cleanup" }>["state"];
      readonly armed: true;
      readonly armedAt: IsoTimestamp;
      readonly identity: {
        readonly registryId: string;
        readonly providerKey: SandboxProviderKey;
        readonly providerSandboxId: string;
      };
      readonly identityDigest: Sha256Digest;
      readonly disposition?: "pause" | "close";
    }
  | {
      readonly kind: "sandbox_lifecycle_unknown";
      readonly idempotencyKey: string;
      readonly payloadDigest: Sha256Digest;
      readonly state: "unknown";
    }
  | {
      readonly kind: "runtime_alert";
      readonly idempotencyKey: string;
      readonly payloadDigest: Sha256Digest;
      readonly state: "pending";
    };

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
        | "protocol_invalid"
        | "scope_mismatch";
    };

export type FenceInspectionResult =
  | {
      readonly outcome: "active";
      readonly fence: ExecutionFence;
      readonly databaseNow: IsoTimestamp;
      readonly run: Run;
      readonly workspace: Workspace;
      readonly agentRevisionRevoked?: true;
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
  /**
   * model_start 只能在首次模型 checkpoint 后签发；model_continue 只能引用已持久化的
   * Thread steer、Artifact 修正轮次或主模型 length 终态后的单次续跑；tool_execution 必须引用
   * 本 Attempt 已登记且尚未签发过许可的 EffectInvocation。同一 effect+callId 的重复签发必须返回 conflict。
   */
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
          | "agent_revision_revoked"
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
          | "agent_revision_revoked"
          | "external_tool_revoked"
          | "external_tool_snapshot_invalid"
          | "fence_lost"
          | "conflict"
          | "unavailable"
          | "scope_mismatch";
      }
  >;
  readPendingThreadSteers(input: { readonly fence: ExecutionFence }): Promise<
    | {
        readonly outcome: "pending";
        readonly items: readonly {
          readonly receiptId: string;
          readonly targetTurnId: string;
          readonly inputText: string;
          readonly attachments?: readonly UserInputAttachmentReference[];
          readonly bodyDigest: Sha256Digest;
        }[];
      }
    | {
        readonly outcome: "none" | "fence_lost" | "cancelled" | "unavailable" | "scope_mismatch";
      }
  >;
  mutate(command: RuntimeMutation): Promise<RuntimeMutationResult>;
  readMutation(input: {
    readonly scope: ExecutionScope;
    readonly idempotencyKey: string;
  }): Promise<RuntimeMutationResult | { readonly outcome: "not_found" }>;
  /** 只有 claim 返回 recovery_required 后的恢复入口可调用；running Run 不能直接重领。 */
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
  readonly candidateOperationKey: string;
  readonly candidateOperationDigest: Sha256Digest;
  /**
   * Revision 的唯一内容事实是逐文件 stable Blob 的不可变 manifest。它绝不能退化为单一
   * objectKey；物理对象键只保留在每个 entry 的 stable incarnation 身份中。
   */
  readonly manifest: WorkspaceManifest;
}

export type ValidatedWorkspaceChange = WorkspaceRevisionCandidate;

export interface WorkspaceRevisionVerifierPort {
  /**
   * 必须在 Session/模型调用前执行。实现从 revision manifest 物化当前 head；空 head 也要
   * 经 journal 记录，从而不能把依赖不可用误判成空 Workspace。
   */
  materialize(input: {
    readonly scope: ExecutionScope;
    readonly attemptId?: string;
    readonly expectedCurrentRevisionId?: WorkspaceRevisionId;
    readonly sandbox: SandboxSessionRef;
    readonly operationKey: string;
    readonly signal?: AbortSignal;
    /** 只用于诊断子阶段耗时；不得影响物化或发布结果。 */
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
  }): Promise<void>;
  /** 模型 settled 后发布 Sandbox snapshot，返回尚未提交的 manifest-aware revision 候选。 */
  verify(input: {
    readonly scope: ExecutionScope;
    readonly attemptId?: string;
    readonly expectedCurrentRevisionId?: WorkspaceRevisionId;
    readonly sandbox: SandboxSessionRef;
    readonly operationKey: string;
    readonly signal?: AbortSignal;
    /** 只用于诊断子阶段耗时；不得影响物化或发布结果。 */
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
  }): Promise<WorkspaceRevisionCandidate | undefined>;
}

/**
 * Workspace 的 Worker 边界。保留旧名称是为了避免拆分部署期间的二进制接口断裂；新装配必须
 * 使用该完整端口，不能仅注入一个“非空则失败”的 verifier。
 */
export type WorkspaceRuntimePort = WorkspaceRevisionVerifierPort;

export interface SandboxSessionRef {
  readonly registryId: string;
  readonly providerKey: SandboxProviderKey;
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
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
    /** 只有当前输入包含必须通过虚拟文件系统读取的附件时才挂载 `/resources`。 */
    readonly requiresResourceFilesystem: boolean;
  }): Promise<SandboxAcquireResult>;
  settle(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
    /** 必须引用已持久化 cleanup intent；只有失去栅栏后的 orphan best-effort 使用 registry 恢复键。 */
    readonly cleanupIntentId: string;
    readonly disposition: "pause" | "close";
  }): Promise<SandboxSettlementResult>;
}

export interface ThreadSandboxLeaseRefV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly leaseId: string;
  /** 只在 Runtime 内部传递；不得进入公开事件或日志。 */
  readonly leaseToken: string;
  readonly leaseEpoch: number;
}

export interface ThreadSandboxTerminalCommandV1 {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly leaseToken: string;
}

export type ThreadSandboxTerminalReceiptV1 =
  | {
      readonly schemaVersion: 1;
      readonly outcome: "handed_off";
      readonly sessionId: string;
      readonly generation: number;
      readonly nextRunId: RunId;
    }
  | {
      readonly schemaVersion: 1;
      readonly outcome: "effect_pending";
      readonly sessionId: string;
      readonly generation: number;
      readonly effectId: string;
      readonly effectKind: "pause" | "terminate";
    };

export type ThreadSandboxAcquireResult =
  | {
      readonly outcome: "ready";
      readonly session: SandboxSessionRef;
      readonly lease: ThreadSandboxLeaseRefV1;
      /** 当前 Session 是否已经挂载 Tenant ResourceFS；只能复用于不超过该能力的请求。 */
      readonly resourceFilesystemMounted: boolean;
      /** false 只在 revision/generation/lease attestation 全部成立时返回。 */
      readonly requiresMaterialization: boolean;
      readonly source: "cold_created" | "running_handoff" | "paused_resumed";
    }
  | { readonly outcome: "unknown" }
  | { readonly outcome: "failed"; readonly code: StableWorkerErrorCode };

/** Provider 驱动不接触数据库；Thread lifecycle repository 独占 intent/receipt 与 lease。 */
export interface ThreadSandboxProviderPort {
  /** 未启用托管配置时使用部署级默认 Provider。 */
  readonly defaultProviderKey: SandboxProviderKey;
  /** 在远端 create intent 前固定新实例配置；不允许在远端调用后重新选择供应商。 */
  prepareCreate?(input: {
    readonly scope: ExecutionScope;
    readonly registryId: string;
  }): Promise<{ readonly providerKey: SandboxProviderKey; readonly lifecycleTimeoutMs?: number }>;
  create(input: {
    readonly scope: ExecutionScope;
    readonly registryId: string;
    readonly signal: AbortSignal;
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
    /** 只有当前输入包含必须通过虚拟文件系统读取的附件时才挂载 `/resources`。 */
    readonly requiresResourceFilesystem: boolean;
  }): Promise<SandboxAcquireResult>;
  connect(input: {
    readonly scope: ExecutionScope;
    readonly registryId: string;
    readonly providerKey: SandboxProviderKey;
    readonly providerSandboxId: string;
    readonly signal: AbortSignal;
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
  }): Promise<SandboxAcquireResult | { readonly outcome: "not_found" }>;
  settle(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
    readonly cleanupIntentId: string;
    readonly disposition: "pause" | "close";
  }): Promise<SandboxSettlementResult>;
}

export interface ThreadSandboxSessionLifecyclePort {
  acquire(input: {
    readonly scope: ExecutionScope;
    readonly attemptId: string;
    readonly owner: string;
    readonly leaseDurationMs: number;
    readonly signal: AbortSignal;
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
    /** true 时不得复用未挂载 ResourceFS 的 Session。 */
    readonly requiresResourceFilesystem: boolean;
  }): Promise<ThreadSandboxAcquireResult>;
  renew(input: {
    readonly scope: ExecutionScope;
    readonly attemptId: string;
    readonly lease: ThreadSandboxLeaseRefV1;
    readonly leaseDurationMs: number;
  }): Promise<"renewed" | "lease_lost" | "unavailable">;
  attestMaterialized(input: {
    readonly scope: ExecutionScope;
    readonly attemptId: string;
    readonly lease: ThreadSandboxLeaseRefV1;
    readonly revisionId?: WorkspaceRevisionId;
  }): Promise<"attested" | "lease_lost" | "unavailable">;
  completeTerminalEffect(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
    readonly receipt: Extract<ThreadSandboxTerminalReceiptV1, { outcome: "effect_pending" }>;
  }): Promise<"settled" | "unknown" | "not_owner">;
  terminate(input: {
    readonly scope: ExecutionScope;
    readonly attemptId: string;
    readonly session: SandboxSessionRef;
    readonly lease: ThreadSandboxLeaseRefV1;
    readonly reason: string;
  }): Promise<"settled" | "unknown" | "lease_lost">;
  /**
   * Thread 是否有排队中（未取消）的 follow-up。为 true 时 Run 终态通常会把仍在运行的 Sandbox
   * 直接交接给下一个 Run，Worker 据此推迟 Workspace 快照到真正暂停或回收前。
   * 这只是性能提示：读取后队列仍可能变化，调用方不得据此改变任何持久事实的正确性。
   */
  hasQueuedFollowUp?(input: { readonly scope: ExecutionScope }): Promise<boolean>;
}

/**
 * 失去执行栅栏后的孤儿 Sandbox 只能通过独立端口关闭。实现必须把成功 acquire 返回的
 * session 对象身份当作进程内 capability，拒绝复制或伪造的 session。
 */
export interface OrphanSandboxCleanupPort {
  closeOrphan(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
  }): Promise<SandboxSettlementResult>;
}

export type AgentTurnOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "context_too_large"; readonly action: "rebuild_context" }
  | {
      /** Tool Observation 未形成可恢复的 durable 事实；本 Attempt 不能继续成功。 */
      readonly kind: "recovery_required";
      readonly code:
        | "PERSISTENCE_UNAVAILABLE"
        | "IDEMPOTENCY_CONFLICT"
        | "SANDBOX_FAILED"
        | "EXTERNAL_TOOL_RESULT_UNKNOWN"
        | "EXTERNAL_TOOL_REVOKED";
    }
  | {
      readonly kind: "waiting";
      readonly question: string;
      readonly rolloutProjection: ControlledRolloutProjection;
    };

export interface WorkerAgentSessionPort {
  /** 模型许可签发前完成按模型能力选择与图片字节读取，避免 S3 I/O 消耗短时许可。 */
  prepareInput(input: AgentUserInput): Promise<PreparedAgentUserInput>;
  /** 新 Session 无论首轮还是 waiting 恢复都用 prompt 启动模型；禁止对空 Session 调 followUp。 */
  runPrompt(
    input: PreparedAgentUserInput,
    authorization: ConsumedExternalEffectAuthorization,
  ): Promise<AgentTurnOutcome>;
  /**
   * 当前完整 assistant/tool turn 已持久化后，把 durable steer 放入 Pi 的原生 steering
   * 队列；它必须在同一次活跃 prompt 的下一次 Provider 采样前被消费。
   */
  steer(input: AgentUserInput): Promise<void>;
  abort(): Promise<void>;
  /** durable 工具拒绝回执在 abort 前完成；未声明能力的 Session 不得延迟拒绝中止。 */
  drainRejectedToolReceipts?(): Promise<void>;
  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void;
  dispose(): void;
}

export type RunStartupTimingPhase =
  | "run_claim"
  | "personalization_resolve"
  | "memory_retrieve"
  | "pre_session_stop_point"
  | "agent_supervisor_initialize"
  | "skill_recovery"
  | "explicit_skill_load"
  | "observation_projection"
  | "observation_revalidation"
  | "thread_history_read"
  | "runtime_compaction"
  | "pi_session_create"
  | "agent_session_create"
  | "post_session_stop_point"
  | "model_checkpoint"
  | "pre_model_stop_point"
  | "prepare_input"
  | "model_authorization";

export interface RunStartupTimingObserver {
  record(phase: RunStartupTimingPhase, durationMs: number): void;
  /** 在真正进入 Provider 调用前发布当前快照；实现不得返回异步等待。 */
  modelInvocationStarting(): void;
}

export interface AgentSessionFactoryPort {
  /** 工具许可拒绝会先形成 durable 失败回执，并在下一 Provider 轮次前失败关闭。 */
  readonly toolRejectionReceiptBarrier?: "durable";
  create(input: {
    readonly scope: ExecutionScope;
    readonly attemptId: string;
    /** 当前 claim 的完整双栅栏；生产 Rollout 装配只从该能力回到 PG 推导 actor。 */
    readonly fence: ExecutionFence;
    /** 省略时为现有 root Session；子 Session 必须提供稳定的 Agent/Turn 身份。 */
    readonly agent?: AgentExecutionIdentity;
    /** 仅对子 Session 生效；工具集合已经由 AgentSupervisor 与父 Agent 能力取交集。 */
    readonly enabledToolNames?: readonly DelegableAgentToolName[];
    /** 子 Agent 只能获得父 Session 显式选中的 Run 快照版本。 */
    readonly enabledExternalToolVersionIds?: readonly string[];
    /** 只向 root Session 注册协作工具，子 Session 不得递归获得该能力。 */
    readonly agentControl?: AgentControlPort;
    /**
     * Session 创建不再隐式创建 Sandbox。附件可以通过这个窄能力提前启动准备，但不得阻塞
     * 首个模型请求；依赖文件系统的工具在执行前等待同一任务，Session 收口前也必须排空它。
     * 实现必须对并发调用 single-flight，并在准备失败时保持既有失败关闭语义。
     */
    readonly ensureSandboxReady: (
      input:
        | { readonly reason: "attachment" }
        | { readonly reason: "tool"; readonly call: ExternalEffectCall },
    ) => Promise<SandboxSessionRef>;
    /** 只记录首个模型请求前的低基数阶段耗时；诊断失败不得影响 Session。 */
    readonly startupTiming?: RunStartupTimingObserver;
    readonly phaseTiming?: ExecutionPhaseTimingObserver;
    readonly rolloutProjection: ControlledRolloutProjection;
    /** Session 创建前已知的首轮文本，只用于把即将追加的 user turn 计入自动压缩触发。 */
    readonly initialInputText?: string;
    readonly skillSnapshot?: RunSkillSnapshot;
    readonly agentSnapshot: RunAgentSnapshot;
    /** Worker 在领取 Run 后读取一次；Root 与所有子 Agent 共用该不可变快照。 */
    readonly personalizationSnapshot?: RunPersonalizationSnapshot;
    readonly contextThroughSequence?: number;
    readonly threadActiveHistory?: ThreadActiveHistoryV1;
    /**
     * Pi turn_end 后、下一次 Provider 请求前的 awaited 安全点。先提交完整 assistant/tool
     * 事实，再允许 Runtime 重建或压缩上下文；失败必须中止本 Attempt。
     */
    readonly onTurnSafePoint?: (
      event: Extract<RuntimeAgentEvent, { type: "turn.completed" }>,
    ) => Promise<{
      /** 只覆盖已经完成的 assistant/tool turn；steer user fact 由 Pi 队列在其后按序注入。 */
      readonly throughSequence: number;
      readonly steers?: readonly {
        readonly receiptId: string;
        readonly inputText: string;
        readonly attachments?: readonly UserInputAttachmentReference[];
      }[];
    }>;
    readonly onExternalToolSnapshotFailure?: (code: ExternalToolSnapshotError["code"]) => void;
    /** 根、子 Session 共用根 Attempt 的待对账边界；返回前必须停止后续副作用并持久化恢复事实。 */
    readonly onExternalToolResultUnknown?: () => Promise<void>;
    readonly authorizeToolEffect: (
      call: ExternalEffectCall,
    ) => Promise<ConsumedExternalEffectAuthorization>;
    /** 持久化 Agent 自主维护的 Run 级完整 Todo 快照；不授权或阻止其他工具。 */
    readonly writeTodo: (input: {
      readonly callId: string;
      readonly command: TodoWriteCommand;
    }) => Promise<TodoSnapshot>;
  }): Promise<WorkerAgentSessionPort>;
}

export interface ThreadContextHistoryPort {
  readActiveHistory(input: {
    readonly scope: ExecutionScope;
    readonly attemptId: string;
    readonly throughSequence: number;
    readonly compatibilityDigest: Sha256Digest;
    readonly mode: "shadow" | "read";
  }): Promise<
    | { readonly outcome: "ready"; readonly history: ThreadActiveHistoryV1 }
    | { readonly outcome: "legacy_gap" | "unsupported" | "unavailable" }
  >;
}

export interface ThreadContextCompactionCommitPort {
  commit(input: {
    readonly fence: ExecutionFence;
    readonly attemptId: string;
    readonly operationId: string;
    readonly checkpointId: string;
    readonly compatibilityDigest: Sha256Digest;
    readonly policyDigest: Sha256Digest;
    readonly tokenizerIdentity: string;
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    readonly path: "local" | "remote";
    readonly sourceFromSequence: number;
    readonly sourceThroughSequence: number;
    readonly sourceHistoryDigest: Sha256Digest;
    readonly replacement: ThreadActiveHistoryV1;
  }): Promise<
    | {
        readonly outcome: "applied" | "replayed";
        readonly checkpointId: string;
        readonly windowNumber: number;
        readonly checkpointFactSequence: number;
      }
    | { readonly outcome: "stale" | "fence_lost" | "conflict" | "unavailable" }
  >;
}

export interface ThreadContextBodyPersistencePort {
  persist(input: {
    readonly tenantId: TenantId;
    readonly idempotencyKey: string;
    readonly value: Readonly<Record<string, unknown>>;
  }): Promise<ThreadContextBodyV1>;
}

export interface RecoveryMetricsPort {
  recordOrphanCleanup(input: {
    readonly scope: ExecutionScope;
    readonly registryId: string;
    readonly reason:
      | RuntimeMutationResult["outcome"]
      | "cancelled"
      | "timeout"
      | "shutdown"
      | "external_tool_revoked"
      | "external_tool_snapshot_invalid"
      | "external_tool_result_unknown";
    readonly cleanupOutcome: "settled" | "unknown" | "failed";
  }): Promise<void>;
}

export type ThreadContinuityMetricName =
  | "thread_input_total"
  | "steer_apply_latency_ms"
  | "steer_to_follow_up_total"
  | "follow_up_queue_depth"
  | "follow_up_wait_ms"
  | "thread_writer_conflict_total"
  | "context_rebuild_latency_ms"
  | "context_visible_tokens"
  | "context_tokens_before_compaction"
  | "context_tokens_after_compaction"
  | "compaction_latency_ms"
  | "compaction_total"
  | "context_recovery_digest_mismatch_total"
  | "context_window_number"
  | "sandbox_handoff_total"
  | "sandbox_resume_total"
  | "sandbox_resume_latency_ms"
  | "sandbox_create_latency_ms"
  | "workspace_materialize_latency_ms"
  | "sandbox_paused_seconds"
  | "sandbox_snapshot_bytes"
  | "sandbox_cold_rebuild_total"
  | "sandbox_unknown_total"
  | "sandbox_revision_mismatch_total"
  | "sandbox_idle_running_seconds";

/** 只接受低基数维度和数值；用户正文、Provider ID、token 不属于指标协议。 */
export interface ThreadContinuityMetricsPort {
  record(input: {
    readonly tenantId: TenantId;
    readonly threadId: ThreadId;
    readonly runId?: RunId;
    readonly observationId: string;
    readonly metricName: ThreadContinuityMetricName;
    readonly value: number;
    readonly unit: "count" | "milliseconds" | "seconds" | "tokens" | "items" | "bytes";
    readonly path?: "local" | "remote" | "resume" | "cold" | "handoff";
    readonly outcome?: string;
    readonly reason?: string;
  }): Promise<void>;
}

/**
 * 模型用量观测只保存计数和生成时长，不接收 Provider 身份、请求正文或响应正文。
 * 同一次调用的四个数值必须由适配器原子写入，避免聚合比例读取到部分事实。
 */
export interface ModelUsageMetricsPort {
  recordModelUsage(input: {
    readonly tenantId: TenantId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly observationId: string;
    /** Provider 报告的未命中缓存输入量。 */
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    /** Assistant message_start 到 message_end 的本地单调时钟跨度。 */
    readonly generationDurationMs: number;
  }): Promise<void>;
}

export interface CancellationPort {
  signalFor(scope: ExecutionScope): AbortSignal;
  /** Run 执行结束后释放轮询、监听器等按 Run 分配的资源。 */
  release?(scope: ExecutionScope): void;
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

/**
 * 进程内 64KiB 只是一道传输/内存安全上限，而非持久化大小的事实来源。
 * JSON.stringify 的紧凑表示不能复刻 PostgreSQL jsonb::text 的键排序和空白；小于本阈值
 * 的值仍必须由 PgExecutionPersistence 在同一事务按 jsonb::text 实测，迁移 CHECK 最终兜底。
 */
export const MAX_RUNTIME_TRANSPORT_BYTES = 64 * 1024;

export function assertProtocolSize(value: RuntimeEventV1 | RuntimeOutboxV1): void {
  try {
    const encoded = JSON.stringify(value);
    if (
      typeof encoded !== "string" ||
      new TextEncoder().encode(encoded).byteLength > MAX_RUNTIME_TRANSPORT_BYTES
    ) {
      throw new Error("不可序列化或超过传输上限");
    }
  } catch {
    throw new Error("EVENT_REJECTED");
  }
}
