import {
  acquireWorkspaceLease,
  createPersonalTenant,
  createRun,
  createThread,
  createUser,
  createWorkspace,
  expireWorkspaceLease,
  isoTimestamp,
  membershipId,
  prepareWorkspaceRevision,
  releaseWorkspaceLease,
  renewWorkspaceLease,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  transitionRun,
  userId,
  workspaceId,
  workspaceRevisionId,
  type IsoTimestamp,
  type Run,
  type Workspace,
  type WorkspaceRevisionId,
} from "@cube-runtime/domain";
import type { ControlledRolloutProjection, RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import { FakeSandboxHandle } from "@cube-runtime/sandbox";
import type {
  AgentSessionFactoryPort,
  AgentTurnOutcome,
  ArtifactPublicationPort,
  CancellationPort,
  ClaimExecutionResult,
  ClockPort,
  ExecutionAttemptSnapshot,
  ExecutionAttemptStatus,
  ExecutionFence,
  ExecutionPersistencePort,
  ExecutionScope,
  FenceInspectionResult,
  HeartbeatTask,
  PersistedRuntimeEventV1,
  PersistedRuntimeOutboxV1,
  RuntimeMutation,
  RuntimeMutationResult,
  SandboxAcquireResult,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  SandboxSettlementResult,
  ScheduledTask,
  WorkerAgentSessionPort,
  WorkspaceRevisionCandidate,
  WorkspaceRevisionVerifierPort,
} from "../ports.js";

interface FakeRecord {
  readonly scope: ExecutionScope;
  run: Run;
  workspace: Workspace;
  readonly input: string;
  answer?: string;
  rolloutProjection: ControlledRolloutProjection;
  attempt: ExecutionAttemptSnapshot | undefined;
  fence: ExecutionFence | undefined;
  readonly events: PersistedRuntimeEventV1[];
  readonly outbox: PersistedRuntimeOutboxV1[];
  readonly mutations: Map<string, AppliedFakeMutation>;
}

type AppliedFakeMutation = Extract<
  RuntimeMutationResult,
  { outcome: "applied" | "already_applied" }
>;

const attemptTransitions: Readonly<
  Record<ExecutionAttemptStatus, readonly ExecutionAttemptStatus[]>
> = {
  claimed: ["running", "cancelled", "failed", "recovery_required", "abandoned"],
  running: ["running", "waiting", "finalizing", "failed", "cancelled", "recovery_required"],
  waiting: [],
  finalizing: ["finalizing", "waiting", "succeeded", "failed", "cancelled", "recovery_required"],
  succeeded: [],
  failed: [],
  cancelled: [],
  recovery_required: ["abandoned", "failed"],
  abandoned: [],
};

/** 多记录、复合 scope、数据库时钟和严格栅栏都在同一个 Fake 事务中模拟。 */
export class FakeExecutionPersistence implements ExecutionPersistencePort {
  readonly records = new Map<string, FakeRecord>();
  responseUnknownNextMutation = false;
  responseUnknownKeyIncludes: string | undefined;
  unavailableNextMutation = false;
  forceInspectUnavailable = false;
  rejectInspectNext = false;
  forceFenceLost = false;
  rejectNextPermit = false;
  readonly permits: Array<{ readonly effect: "model_start" | "tool_execution" }> = [];
  readonly revisionCreatedAt: IsoTimestamp[] = [];
  afterMutation?: (command: RuntimeMutation) => void;
  private databaseMillis = Date.parse("2026-07-26T00:00:00.000Z");
  private claimEpoch = 0;
  private attemptSequence = 0;

  addSeed(seed: FakeSeed = fakeSeed()): ExecutionScope {
    const scope = scopeFrom(seed.run, seed.workspace);
    this.records.set(scopeKey(scope), {
      scope,
      run: seed.run,
      workspace: seed.workspace,
      input: seed.input,
      ...(seed.answer === undefined ? {} : { answer: seed.answer }),
      rolloutProjection: seed.rolloutProjection,
      attempt: undefined,
      fence: undefined,
      events: [],
      outbox: [],
      mutations: new Map(),
    });
    return scope;
  }

  async claim(input: {
    readonly scope: ExecutionScope;
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }): Promise<ClaimExecutionResult> {
    const record = this.find(input.scope);
    if (record === "scope_mismatch") return { outcome: "scope_mismatch" };
    if (!record) return { outcome: "not_found" };
    if (["succeeded", "failed", "cancelled"].includes(record.run.status)) {
      return { outcome: "terminal" };
    }
    if (record.run.status === "running") {
      return { outcome: this.isExpired(record) ? "recovery_required" : "busy" };
    }
    if (record.run.status === "waiting" && record.answer === undefined) {
      return { outcome: "waiting_for_answer" };
    }
    const now = this.databaseNow();
    const expiresAt = this.after(input.leaseDurationMs);
    record.run = transitionRun(record.run, "running", now);
    const leaseEpoch = record.workspace.leaseEpoch + 1;
    record.workspace = acquireWorkspaceLease({
      workspace: record.workspace,
      rootRun: record.run,
      epoch: leaseEpoch,
      expiresAt,
      now,
    });
    const attempt: ExecutionAttemptSnapshot = {
      attemptId: `attempt-${++this.attemptSequence}`,
      status: "claimed",
      stage: "claimed",
      version: 0,
      nextEventSequence: record.events.length,
      modelExecutionStarted: false,
      ...(record.workspace.currentRevisionId === undefined
        ? {}
        : { currentRevisionId: record.workspace.currentRevisionId }),
    };
    const epoch = ++this.claimEpoch;
    const fence: ExecutionFence = {
      scope: record.scope,
      runClaim: { token: `${input.workerId}-${epoch}`, epoch, expiresAt },
      workspaceLease: { rootRunId: input.scope.rootRunId, epoch: leaseEpoch, expiresAt },
    };
    record.attempt = attempt;
    record.fence = fence;
    return {
      outcome: "claimed",
      snapshot: {
        run: record.run,
        workspace: record.workspace,
        attempt,
        input: record.input,
        ...(record.answer === undefined ? {} : { answer: record.answer }),
        rolloutProjection: record.rolloutProjection,
      },
      fence,
      databaseNow: now,
    };
  }

  async inspectAndRenew(input: {
    readonly fence: ExecutionFence;
    readonly leaseDurationMs: number;
  }): Promise<FenceInspectionResult> {
    if (this.rejectInspectNext) {
      this.rejectInspectNext = false;
      throw new Error("模拟 heartbeat DB Promise reject");
    }
    if (this.forceInspectUnavailable) return { outcome: "unavailable" };
    const record = this.find(input.fence.scope);
    if (record === "scope_mismatch") return { outcome: "scope_mismatch" };
    if (!record || this.forceFenceLost || !this.validFence(record, input.fence)) {
      return { outcome: "fence_lost" };
    }
    const now = this.databaseNow();
    if (record.fence === undefined || expired(record.fence, now)) return { outcome: "fence_lost" };
    const expiresAt = this.after(input.leaseDurationMs);
    record.workspace = renewWorkspaceLease({
      workspace: record.workspace,
      rootRun: record.run,
      epoch: record.fence.workspaceLease.epoch,
      expiresAt,
      now,
    });
    record.fence = {
      ...record.fence,
      runClaim: { ...record.fence.runClaim, expiresAt },
      workspaceLease: { ...record.fence.workspaceLease, expiresAt },
    };
    return {
      outcome: "active",
      fence: record.fence,
      databaseNow: now,
      run: record.run,
      workspace: record.workspace,
    };
  }

  async issueExternalEffectPermit(
    input: Parameters<ExecutionPersistencePort["issueExternalEffectPermit"]>[0],
  ): ReturnType<ExecutionPersistencePort["issueExternalEffectPermit"]> {
    const record = this.find(input.fence.scope);
    if (record === "scope_mismatch") return { outcome: "scope_mismatch" };
    if (this.rejectNextPermit) {
      this.rejectNextPermit = false;
      return { outcome: "fence_lost" };
    }
    const now = this.databaseNow();
    if (!record?.attempt || !this.validFence(record, input.fence) || expired(input.fence, now)) {
      return { outcome: "fence_lost" };
    }
    if (record.attempt.version !== input.expectedAttemptVersion) return { outcome: "conflict" };
    const permit = {
      permitId: `${record.attempt.attemptId}/permit/${this.permits.length + 1}`,
      scope: record.scope,
      runClaimToken: input.fence.runClaim.token,
      runClaimEpoch: input.fence.runClaim.epoch,
      workspaceRootRunId: input.fence.workspaceLease.rootRunId,
      workspaceLeaseEpoch: input.fence.workspaceLease.epoch,
      attemptVersion: input.expectedAttemptVersion,
      effect: input.effect,
      expiresAt: this.after(input.permitDurationMs),
    } as const;
    this.permits.push({ effect: input.effect });
    return { outcome: "authorized", permit };
  }

  async mutate(command: RuntimeMutation): Promise<RuntimeMutationResult> {
    if (this.unavailableNextMutation) {
      this.unavailableNextMutation = false;
      return { outcome: "unavailable" };
    }
    const record = this.find(command.fence.scope);
    if (record === "scope_mismatch") return { outcome: "scope_mismatch" };
    if (!record || this.forceFenceLost || !this.validFence(record, command.fence)) {
      return { outcome: "fence_lost" };
    }
    const previous = record.mutations.get(command.idempotencyKey);
    if (previous) return { ...previous, outcome: "already_applied" };
    const now = this.databaseNow();
    if (record.fence === undefined || expired(record.fence, now)) return { outcome: "fence_lost" };
    const attempt = record.attempt;
    if (!attempt || attempt.version !== command.expectedAttemptVersion)
      return { outcome: "conflict" };
    if (command.nextAttemptStatus && command.nextAttemptStatus !== attempt.status) {
      if (!attemptTransitions[attempt.status].includes(command.nextAttemptStatus)) {
        return { outcome: "conflict" };
      }
    }
    for (const [index, event] of command.events.entries()) {
      if (event.sequence !== attempt.nextEventSequence + index) return { outcome: "conflict" };
    }
    if (command.workspaceChange) {
      const revision = command.workspaceChange;
      if (
        revision.workspaceId !== command.fence.scope.workspaceId ||
        revision.tenantId !== command.fence.scope.tenantId ||
        revision.threadId !== command.fence.scope.threadId ||
        revision.rootRunId !== command.fence.scope.rootRunId ||
        revision.parentRevisionId !== attempt.currentRevisionId ||
        record.workspace.currentRevisionId !== attempt.currentRevisionId
      ) {
        return { outcome: "conflict" };
      }
    }

    for (const item of command.outbox) {
      if (item.kind !== "sandbox_cleanup") continue;
      const existing = record.outbox.find(
        (candidate) =>
          candidate.kind === "sandbox_cleanup" && candidate.idempotencyKey === item.idempotencyKey,
      );
      if (!cleanupTransitionAllowed(existing?.state, item.state)) return { outcome: "conflict" };
    }

    record.events.push(...command.events.map((event) => ({ ...event, occurredAt: now })));
    for (const item of command.outbox) {
      const index = record.outbox.findIndex(
        (existing) => existing.idempotencyKey === item.idempotencyKey,
      );
      const persisted = { ...item, occurredAt: now } as PersistedRuntimeOutboxV1;
      if (index < 0) record.outbox.push(persisted);
      else record.outbox[index] = persisted;
    }
    if (command.workspaceChange) {
      const commit = prepareWorkspaceRevision({
        workspace: record.workspace,
        rootRun: record.run,
        leaseEpoch: command.fence.workspaceLease.epoch,
        revisionId: command.workspaceChange.revisionId,
        objectKey: command.workspaceChange.objectKey,
        digest: command.workspaceChange.digest,
        now,
      });
      record.workspace = commit.workspace;
      this.revisionCreatedAt.push(commit.revision.createdAt);
    }
    if (command.nextRunStatus) record.run = transitionRun(record.run, command.nextRunStatus, now);
    if (command.rolloutProjection) record.rolloutProjection = command.rolloutProjection;
    const nextAttempt: ExecutionAttemptSnapshot = {
      ...attempt,
      status: command.nextAttemptStatus ?? attempt.status,
      stage: command.nextStage ?? attempt.stage,
      version: attempt.version + 1,
      nextEventSequence: attempt.nextEventSequence + command.events.length,
      modelExecutionStarted:
        attempt.modelExecutionStarted || command.nextStage === "model_execution_started",
      ...(record.workspace.currentRevisionId === undefined
        ? {}
        : { currentRevisionId: record.workspace.currentRevisionId }),
    };
    record.attempt = nextAttempt;
    if (command.releaseFences) {
      record.workspace = releaseWorkspaceLease({
        workspace: record.workspace,
        rootRun: record.run,
        epoch: command.fence.workspaceLease.epoch,
        now,
      });
      record.fence = undefined;
    }
    const result: AppliedFakeMutation = {
      outcome: "applied",
      attemptVersion: nextAttempt.version,
      nextEventSequence: nextAttempt.nextEventSequence,
      databaseNow: now,
      scope: record.scope,
      attempt: nextAttempt,
      run: record.run,
      workspace: record.workspace,
    };
    record.mutations.set(command.idempotencyKey, result);
    this.afterMutation?.(command);
    if (
      this.responseUnknownNextMutation ||
      (this.responseUnknownKeyIncludes !== undefined &&
        command.idempotencyKey.includes(this.responseUnknownKeyIncludes))
    ) {
      this.responseUnknownNextMutation = false;
      this.responseUnknownKeyIncludes = undefined;
      return { outcome: "response_unknown" };
    }
    return result;
  }

  async readMutation(input: {
    readonly scope: ExecutionScope;
    readonly idempotencyKey: string;
  }): Promise<RuntimeMutationResult | { readonly outcome: "not_found" }> {
    const record = this.records.get(scopeKey(input.scope));
    if (!record) {
      return [...this.records.values()].some((candidate) => candidate.run.id === input.scope.runId)
        ? { outcome: "scope_mismatch" }
        : { outcome: "not_found" };
    }
    return record.mutations.get(input.idempotencyKey) ?? { outcome: "not_found" };
  }

  async recoverExpiredAttempt(input: {
    readonly scope: ExecutionScope;
    readonly decision: "safe_fail" | "require_manual_recovery" | "abandon";
  }): Promise<"recovered" | "not_expired" | "not_found" | "scope_mismatch" | "unavailable"> {
    const record = this.find(input.scope);
    if (record === "scope_mismatch") return "scope_mismatch";
    if (!record?.attempt || !record.fence) return "not_found";
    if (!this.isExpired(record)) return "not_expired";
    const now = this.databaseNow();
    if (input.decision === "require_manual_recovery" || record.attempt.modelExecutionStarted) {
      record.attempt = {
        ...record.attempt,
        status: "recovery_required",
        version: record.attempt.version + 1,
      };
    } else if (input.decision === "safe_fail") {
      record.run = transitionRun(record.run, "failed", now);
      record.attempt = { ...record.attempt, status: "failed", version: record.attempt.version + 1 };
    } else {
      record.attempt = {
        ...record.attempt,
        status: "abandoned",
        version: record.attempt.version + 1,
      };
    }
    record.workspace = expireWorkspaceLease({
      workspace: record.workspace,
      rootRun: record.run,
      epoch: record.fence.workspaceLease.epoch,
      now,
    });
    record.fence = undefined;
    return "recovered";
  }

  advanceDatabase(milliseconds: number): void {
    this.databaseMillis += milliseconds;
  }

  setAnswer(scope: ExecutionScope, answer: string): void {
    const record = this.requireRecord(scope);
    if (record.run.status !== "waiting") throw new Error("Run 不是 waiting");
    record.answer = answer;
  }

  scopeForRun(id: string): ExecutionScope {
    for (const record of this.records.values()) {
      if (record.run.id === id) return record.scope;
    }
    throw new Error("Fake Run 不存在");
  }

  expireRunLease(scope: ExecutionScope): void {
    const record = this.requireRecord(scope);
    if (!record.fence) throw new Error("没有活动栅栏");
    record.fence = {
      ...record.fence,
      runClaim: { ...record.fence.runClaim, expiresAt: this.databaseNow() },
    };
  }

  expireWorkspaceLease(scope: ExecutionScope): void {
    const record = this.requireRecord(scope);
    if (!record.fence) throw new Error("没有活动栅栏");
    record.fence = {
      ...record.fence,
      workspaceLease: { ...record.fence.workspaceLease, expiresAt: this.databaseNow() },
    };
  }

  record(scope: ExecutionScope): FakeRecord {
    return this.requireRecord(scope);
  }

  private databaseNow(): IsoTimestamp {
    return isoTimestamp(new Date(this.databaseMillis).toISOString());
  }

  private after(milliseconds: number): IsoTimestamp {
    return isoTimestamp(new Date(this.databaseMillis + milliseconds).toISOString());
  }

  private validFence(record: FakeRecord, fence: ExecutionFence): boolean {
    return (
      record.fence?.runClaim.token === fence.runClaim.token &&
      record.fence.runClaim.epoch === fence.runClaim.epoch &&
      record.fence.workspaceLease.rootRunId === fence.workspaceLease.rootRunId &&
      record.fence.workspaceLease.epoch === fence.workspaceLease.epoch &&
      sameScope(record.fence.scope, fence.scope)
    );
  }

  private isExpired(record: FakeRecord): boolean {
    return record.fence === undefined || expired(record.fence, this.databaseNow());
  }

  private find(scope: ExecutionScope): FakeRecord | "scope_mismatch" | undefined {
    const exact = this.records.get(scopeKey(scope));
    if (exact) return exact;
    return [...this.records.entries()].some(([, value]) => value.run.id === scope.runId)
      ? "scope_mismatch"
      : undefined;
  }

  private requireRecord(scope: ExecutionScope): FakeRecord {
    const record = this.find(scope);
    if (!record || record === "scope_mismatch") throw new Error("Fake record 不存在");
    return record;
  }
}

export class FakeRevisionVerifier implements WorkspaceRevisionVerifierPort {
  verifyCount = 0;
  nextRevisionId: WorkspaceRevisionId | undefined;
  beforeReturn?: () => void | Promise<void>;

  async verify(
    input: Parameters<WorkspaceRevisionVerifierPort["verify"]>[0],
  ): Promise<WorkspaceRevisionCandidate | undefined> {
    this.verifyCount += 1;
    await this.beforeReturn?.();
    const revisionId = this.nextRevisionId;
    this.nextRevisionId = undefined;
    return revisionId === undefined
      ? undefined
      : {
          tenantId: input.scope.tenantId,
          threadId: input.scope.threadId,
          workspaceId: input.scope.workspaceId,
          rootRunId: input.scope.rootRunId,
          ...(input.expectedCurrentRevisionId === undefined
            ? {}
            : { parentRevisionId: input.expectedCurrentRevisionId }),
          revisionId,
          objectKey: `workspace/${revisionId}.tar`,
          digest: sha256Digest("a".repeat(64)),
        };
  }
}

export class FakeSandboxRegistry implements SandboxSessionRegistryPort {
  acquireCount = 0;
  settleCount = 0;
  nextAcquire: SandboxAcquireResult | undefined;
  nextSettlement: SandboxSettlementResult | undefined;
  throwOnSettle = false;
  readonly cleanupIntentIds: string[] = [];
  beforeAcquireReturn?: () => void | Promise<void>;
  beforeSettleReturn?: () => void | Promise<void>;
  readonly handle = new FakeSandboxHandle("worker-fake");
  private known = false;

  async acquire(): Promise<SandboxAcquireResult> {
    this.acquireCount += 1;
    await this.beforeAcquireReturn?.();
    if (this.nextAcquire) {
      const result = this.nextAcquire;
      this.nextAcquire = undefined;
      return result;
    }
    const session: SandboxSessionRef = {
      registryId: "registry-test",
      providerSandboxId: this.handle.id,
      mode: this.known ? "connected" : "created",
      sandbox: this.handle,
    };
    this.known = true;
    return { outcome: "ready", session };
  }

  async settle(
    input: Parameters<SandboxSessionRegistryPort["settle"]>[0],
  ): Promise<SandboxSettlementResult> {
    this.settleCount += 1;
    this.cleanupIntentIds.push(input.cleanupIntentId);
    await this.beforeSettleReturn?.();
    if (this.throwOnSettle) throw new Error("上游私有 settle 失败");
    if (this.nextSettlement) {
      const result = this.nextSettlement;
      this.nextSettlement = undefined;
      return result;
    }
    return { outcome: "settled" };
  }
}

export class ScriptedAgentSession implements WorkerAgentSessionPort {
  readonly prompts: string[] = [];
  readonly modelPermits: string[] = [];
  abortCount = 0;
  abortCompleted = false;
  disposeCount = 0;
  beforeAbortReturn?: () => void | Promise<void>;
  private readonly listeners = new Set<(event: RuntimeAgentEvent) => void>();

  constructor(
    private readonly events: readonly RuntimeAgentEvent[],
    private readonly outcome: AgentTurnOutcome = { kind: "completed" },
  ) {}

  async runPrompt(
    text: string,
    permit: Parameters<WorkerAgentSessionPort["runPrompt"]>[1],
  ): Promise<AgentTurnOutcome> {
    this.prompts.push(text);
    this.modelPermits.push(permit.permitId);
    for (const event of this.events) for (const listener of this.listeners) listener(event);
    return this.outcome;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    await this.beforeAbortReturn?.();
    this.abortCompleted = true;
  }

  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

export class BlockingAgentSession implements WorkerAgentSessionPort {
  abortCount = 0;
  disposeCount = 0;
  private resolve: ((outcome: AgentTurnOutcome) => void) | undefined;

  runPrompt(): Promise<AgentTurnOutcome> {
    return new Promise((resolve) => (this.resolve = resolve));
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.resolve?.({ kind: "completed" });
  }

  subscribe(): () => void {
    return () => undefined;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

export class FakeSessionFactory implements AgentSessionFactoryPort {
  createCount = 0;
  readonly projections: ControlledRolloutProjection[] = [];
  readonly toolAuthorizers: Array<() => Promise<unknown>> = [];

  constructor(private readonly queue: WorkerAgentSessionPort[]) {}

  async create(
    input: Parameters<AgentSessionFactoryPort["create"]>[0],
  ): Promise<WorkerAgentSessionPort> {
    const session = this.queue.shift();
    if (!session) throw new Error("Fake Session 不存在");
    this.createCount += 1;
    this.projections.push(input.rolloutProjection);
    this.toolAuthorizers.push(input.authorizeToolEffect);
    return session;
  }
}

export class FakeCancellationPort implements CancellationPort {
  private readonly controllers = new Map<string, AbortController>();

  signalFor(scope: ExecutionScope): AbortSignal {
    return this.controller(scope.runId).signal;
  }

  cancel(scope: ExecutionScope): void {
    this.controller(scope.runId).abort("test_cancel");
  }

  private controller(run: string): AbortController {
    let controller = this.controllers.get(run);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(run, controller);
    }
    return controller;
  }
}

export class FakeClock implements ClockPort {
  private readonly heartbeats: Array<{ active: boolean; callback: () => Promise<void> }> = [];
  private readonly scheduled: Array<{ active: boolean; callback: () => void }> = [];

  schedule(_delayMs: number, callback: () => void): ScheduledTask {
    const task = { active: true, callback };
    this.scheduled.push(task);
    return { cancel: () => (task.active = false) };
  }

  startHeartbeat(_intervalMs: number, callback: () => Promise<void>): HeartbeatTask {
    const heartbeat = { active: true, callback };
    this.heartbeats.push(heartbeat);
    return {
      stop: async () => {
        heartbeat.active = false;
      },
    };
  }

  async tickHeartbeat(): Promise<void> {
    for (const heartbeat of this.heartbeats) if (heartbeat.active) await heartbeat.callback();
  }

  fireTimeout(): void {
    for (const task of this.scheduled) {
      if (task.active) {
        task.active = false;
        task.callback();
      }
    }
  }
}

export class FakeArtifactPublication implements ArtifactPublicationPort {
  calls = 0;
  beforeReturn?: () => void | Promise<void>;

  async assertReadyForCompletion(): Promise<void> {
    this.calls += 1;
    await this.beforeReturn?.();
  }
}

export interface FakeSeed {
  readonly run: Run;
  readonly workspace: Workspace;
  readonly input: string;
  readonly answer?: string;
  readonly rolloutProjection: ControlledRolloutProjection;
}

export function fakeSeed(prefix = "worker"): FakeSeed {
  const now = isoTimestamp("2026-07-26T00:00:00.000Z");
  const user = createUser(userId(`user-${prefix}`), now);
  const { tenant, ownerMembership } = createPersonalTenant({
    id: tenantId(`tenant-${prefix}`),
    ownerMembershipId: membershipId(`member-${prefix}`),
    owner: user,
    createdAt: now,
  });
  const thread = createThread({
    id: threadId(`thread-${prefix}`),
    tenant,
    user,
    membership: ownerMembership,
    title: "Worker 测试",
    now,
  });
  return {
    run: createRun({ id: runId(`run-${prefix}`), thread, now }),
    workspace: createWorkspace({ id: workspaceId(`workspace-${prefix}`), thread, now }),
    input: "执行任务",
    rolloutProjection: { schemaVersion: 1, checkpointId: `checkpoint-${prefix}`, turns: [] },
  };
}

export function fakeRevision(value = "revision-worker"): WorkspaceRevisionId {
  return workspaceRevisionId(value);
}

function scopeFrom(run: Run, workspace: Workspace): ExecutionScope {
  return {
    tenantId: run.tenantId,
    threadId: run.threadId,
    runId: run.id,
    rootRunId: run.id,
    workspaceId: workspace.id,
    ...(workspace.currentRevisionId === undefined
      ? {}
      : { baseRevisionId: workspace.currentRevisionId }),
  };
}

function scopeKey(scope: ExecutionScope): string {
  return [
    scope.tenantId,
    scope.threadId,
    scope.runId,
    scope.rootRunId,
    scope.workspaceId,
    scope.baseRevisionId ?? "none",
  ].join("|");
}

function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

function expired(fence: ExecutionFence, now: IsoTimestamp): boolean {
  const current = Date.parse(now);
  return (
    Date.parse(fence.runClaim.expiresAt) <= current ||
    Date.parse(fence.workspaceLease.expiresAt) <= current
  );
}

function cleanupTransitionAllowed(
  previous: "pending" | "started" | "completed" | "unknown" | undefined,
  next: "pending" | "started" | "completed" | "unknown",
): boolean {
  if (previous === undefined) return next === "pending" || next === "unknown";
  if (previous === "pending") return next === "pending" || next === "started";
  if (previous === "started")
    return next === "started" || next === "completed" || next === "unknown";
  return previous === next;
}
