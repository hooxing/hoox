// RunWorker 单次执行的可变上下文；只在一次 execute 内共享，不是恢复事实源。
import type {
  ExecutionPhaseTimingObserver,
  IsoTimestamp,
  Run,
  Sha256Digest,
  TodoSnapshot,
  Workspace,
  WorkspaceRevisionId,
} from "@hoox/domain";
import type { DurableOperationLane } from "./durable-operation-lane.js";
import type {
  ExecutionAttemptStatus,
  ExecutionFence,
  ExecutionScope,
  ExecutionStage,
  RuntimeMutationResult,
  StableWorkerErrorCode,
  ThreadSandboxLeaseRefV1,
} from "./ports.js";

export interface ExecutionContext {
  phaseTiming?: ExecutionPhaseTimingObserver;
  readonly scope: ExecutionScope;
  fence: ExecutionFence;
  attemptVersion: number;
  nextEventSequence: number;
  databaseNow: IsoTimestamp;
  readonly attemptId: string;
  run: Run;
  workspace: Workspace;
  currentRevisionId?: WorkspaceRevisionId;
  actualCommittedStage: ExecutionStage;
  actualAttemptStatus: ExecutionAttemptStatus;
  projectionVersion: number;
  readonly durableLane: DurableOperationLane;
  readonly toolStartedGates: Map<string, ToolStartedGate>;
  readonly cleanupFacts: Map<string, CleanupReceiptFacts>;
  todo?: TodoSnapshot;
  stopped?: "cancelled" | "shutdown" | "timeout" | "fence_lost" | "unavailable" | "scope_mismatch";
  agentFailure?: StableWorkerErrorCode;
  modelCompleted: boolean;
  modelStopReason?: "stop" | "length" | "toolUse";
  eventAcceptanceOpen: boolean;
  adapterRejected: boolean;
  contextTurnOrdinal: number;
  finalization?: { readonly callId: string };
  abortPromise?: Promise<void>;
  abortSession?: () => Promise<void>;
  threadSandboxLease?: ThreadSandboxLeaseRefV1;
}

export interface ToolStartedGate {
  readonly name: string;
  readonly committed: Promise<void>;
  authorizationRequested: boolean;
  todoWriteRequested: boolean;
  resolve(): void;
}

export interface CleanupReceiptFacts {
  readonly armedAt: IsoTimestamp;
  readonly identityDigest: Sha256Digest;
  readonly disposition?: "pause" | "close";
}

export type AppliedMutation = Extract<
  RuntimeMutationResult,
  { outcome: "applied" | "already_applied" }
>;
