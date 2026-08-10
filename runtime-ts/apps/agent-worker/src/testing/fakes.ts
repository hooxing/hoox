import {
  acquireWorkspaceLease,
  createPersonalTenant,
  createRun,
  createThread,
  createUser,
  createWorkspace,
  expireWorkspaceLease,
  type IsoTimestamp,
  isoTimestamp,
  membershipId,
  prepareWorkspaceRevision,
  type Run,
  releaseWorkspaceLease,
  renewWorkspaceLease,
  runId,
  type Sha256Digest,
  sha256Digest,
  tenantId,
  threadId,
  transitionRun,
  userId,
  type Workspace,
  type WorkspaceRevisionId,
  workspaceId,
  workspaceRevisionId,
} from "@cube-runtime/domain";
import type { ControlledRolloutProjection, RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import { FakeSandboxHandle } from "@cube-runtime/sandbox/testing";
import type { RunSkillSnapshot } from "@cube-runtime/skill";
import { createWorkspaceManifest } from "@cube-runtime/workspace";
import {
  digestCanonical,
  outboxPayloadDigest,
  rolloutProjectionDigest,
  runtimeMutationDigest,
  sandboxCleanupIdentityDigest,
  workspaceChangeDigest,
} from "../mutation-protocol.js";
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
  ExternalEffectPermit,
  FenceInspectionResult,
  HeartbeatTask,
  OrphanSandboxCleanupPort,
  PersistedRuntimeEventV1,
  PersistedRuntimeOutboxV1,
  RecoveryMetricsPort,
  RuntimeMutation,
  RuntimeMutationReceiptV1,
  RuntimeMutationResult,
  RuntimeOutboxReceiptV1,
  RuntimeOutboxV1,
  SandboxAcquireResult,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  SandboxSettlementResult,
  ScheduledTask,
  ThreadContextBodyPersistencePort,
  ThreadSandboxAcquireResult,
  ThreadSandboxLeaseRefV1,
  ThreadSandboxSessionLifecyclePort,
  UserInputAttachmentReference,
  WorkerAgentSessionPort,
  WorkspaceRevisionCandidate,
  WorkspaceRevisionVerifierPort,
} from "../ports.js";

interface FakeRecord {
  readonly scope: ExecutionScope;
  readonly tenantKind: "personal" | "team";
  run: Run;
  workspace: Workspace;
  readonly input: string;
  readonly attachments: readonly UserInputAttachmentReference[];
  answer?: string;
  rolloutProjection: ControlledRolloutProjection;
  readonly skills?: RunSkillSnapshot;
  projectionVersion: number;
  contextNextSequence: number;
  attempt: ExecutionAttemptSnapshot | undefined;
  fence: ExecutionFence | undefined;
  readonly events: PersistedRuntimeEventV1[];
  readonly outbox: PersistedRuntimeOutboxV1[];
  readonly mutations: Map<string, AppliedFakeMutation>;
  /** 模拟数据库永久唯一表；mutation receipt 读取也不能删除这条事实。 */
  readonly effectInvocations: Map<string, string>;
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
  /** 模拟数据库连接在事务是否提交前断开，readback 也找不到 receipt。 */
  responseUnknownWithoutCommitKeyIncludes: string | undefined;
  unavailableNextMutation = false;
  fenceLostMutationKeyIncludes: string | undefined;
  idempotencyConflictKeyIncludes: string | undefined;
  forceInspectUnavailable = false;
  rejectInspectNext = false;
  forceFenceLost = false;
  threadSandboxHandoffRunId: ReturnType<typeof runId> | undefined;
  rejectNextPermit = false;
  beforePermitIssueReturn?: (
    input: Parameters<ExecutionPersistencePort["issueExternalEffectPermit"]>[0],
  ) => void | Promise<void>;
  readonly durableOperations: string[] = [];
  readonly mutationCommands: RuntimeMutation[] = [];
  readonly permits: Array<{
    readonly attemptId: string;
    readonly permit: ExternalEffectPermit;
    consumed: boolean;
  }> = [];
  readonly revisionCreatedAt: IsoTimestamp[] = [];
  readonly pendingThreadSteers: Array<{
    readonly scope: ExecutionScope;
    readonly receiptId: string;
    readonly targetTurnId: string;
    readonly inputText: string;
    readonly attachments?: readonly UserInputAttachmentReference[];
    readonly bodyDigest: Sha256Digest;
  }> = [];
  rewriteNextCleanupReceiptDisposition:
    | {
        readonly state: "started" | "completed" | "unknown";
        readonly disposition: "pause" | "close";
      }
    | undefined;
  afterMutation?: (command: RuntimeMutation) => void;
  private databaseMillis = Date.parse("2026-07-26T00:00:00.000Z");
  private claimEpoch = 0;
  private attemptSequence = 0;

  addSeed(seed: FakeSeed = fakeSeed()): ExecutionScope {
    const scope = scopeFrom(seed.run, seed.workspace);
    this.records.set(scopeKey(scope), {
      scope,
      tenantKind: seed.tenantKind ?? "personal",
      run: seed.run,
      workspace: seed.workspace,
      input: seed.input,
      attachments: seed.attachments ?? [],
      ...(seed.answer === undefined ? {} : { answer: seed.answer }),
      rolloutProjection: seed.rolloutProjection,
      ...(seed.skills === undefined ? {} : { skills: seed.skills }),
      projectionVersion: 0,
      contextNextSequence: 1,
      attempt: undefined,
      fence: undefined,
      events: [],
      outbox: [],
      mutations: new Map(),
      effectInvocations: new Map(),
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
      projectionVersion: record.projectionVersion,
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
        tenantKind: record.tenantKind,
        workspace: record.workspace,
        attempt,
        input: record.input,
        ...(record.attachments.length === 0 ? {} : { attachments: record.attachments }),
        ...(record.answer === undefined ? {} : { answer: record.answer }),
        rolloutProjection: record.rolloutProjection,
        ...(record.skills === undefined ? {} : { skills: record.skills }),
      },
      fence,
      databaseNow: now,
    };
  }

  async readPendingThreadSteer(input: {
    readonly fence: ExecutionFence;
  }): ReturnType<ExecutionPersistencePort["readPendingThreadSteer"]> {
    this.durableOperations.push("steer:read");
    const record = this.find(input.fence.scope);
    if (record === "scope_mismatch") return { outcome: "scope_mismatch" };
    if (record === undefined || record.fence?.runClaim.token !== input.fence.runClaim.token) {
      return { outcome: "fence_lost" };
    }
    const pending = this.pendingThreadSteers.find(
      (candidate) => scopeKey(candidate.scope) === scopeKey(input.fence.scope),
    );
    return pending === undefined
      ? { outcome: "none" }
      : {
          outcome: "pending",
          receiptId: pending.receiptId,
          targetTurnId: pending.targetTurnId,
          inputText: pending.inputText,
          ...(pending.attachments === undefined ? {} : { attachments: pending.attachments }),
          bodyDigest: pending.bodyDigest,
        };
  }

  async inspectAndRenew(input: {
    readonly fence: ExecutionFence;
    readonly leaseDurationMs: number;
  }): Promise<FenceInspectionResult> {
    this.durableOperations.push("inspect");
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
    if (
      record.fence === undefined ||
      record.run.status !== "running" ||
      expired(record.fence, now) ||
      record.workspace.writerLease?.rootRunId !== record.fence.workspaceLease.rootRunId ||
      record.workspace.writerLease.epoch !== record.fence.workspaceLease.epoch ||
      record.workspace.writerLease.expiresAt !== record.fence.workspaceLease.expiresAt
    ) {
      return { outcome: "fence_lost" };
    }
    const expiresAt = this.nextExpiry(record.fence, input.leaseDurationMs);
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
    this.durableOperations.push(`permit:issue:${input.call.callId}`);
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
    if (
      this.permits.some(
        ({ attemptId, permit }) =>
          attemptId === record.attempt?.attemptId &&
          permit.effect === input.effect &&
          permit.callId === input.call.callId,
      )
    ) {
      return { outcome: "conflict" };
    }
    if (
      input.effect === "model_start" &&
      (record.attempt.stage !== "model_execution_started" ||
        this.permits.some(
          ({ attemptId, permit }) =>
            attemptId === record.attempt?.attemptId && permit.effect === "model_start",
        ))
    ) {
      return { outcome: "conflict" };
    }
    if (input.effect === "model_continue") {
      const correction = record.events.findLast(
        (event) =>
          event.kind === "artifact_correction_requested" &&
          input.call.callId ===
            `${record.attempt?.attemptId}/model/correction/${event.payload.round}`,
      );
      const steer = [...record.mutations.values()].find(
        (mutation) =>
          mutation.receipt.threadSteer !== undefined &&
          input.call.callId ===
            `${record.attempt?.attemptId}/model/steer/${mutation.receipt.threadSteer.receiptId}`,
      );
      if (
        !(
          (record.attempt.stage === "model_execution_started" && steer !== undefined) ||
          (record.attempt.stage === "workspace_verified" && correction !== undefined)
        )
      ) {
        return { outcome: "conflict" };
      }
    }
    if (
      input.effect === "tool_execution" &&
      (record.effectInvocations.get(invocationKey(record.attempt.attemptId, input.call.callId)) !==
        input.call.toolName ||
        this.permits.some(
          ({ attemptId, permit }) =>
            attemptId === record.attempt?.attemptId &&
            permit.effect === "tool_execution" &&
            permit.callId === input.call.callId,
        ))
    ) {
      return { outcome: "conflict" };
    }
    const permit = {
      permitId: `${record.attempt.attemptId}/permit/${this.permits.length + 1}`,
      scope: record.scope,
      runClaimToken: input.fence.runClaim.token,
      runClaimEpoch: input.fence.runClaim.epoch,
      workspaceRootRunId: input.fence.workspaceLease.rootRunId,
      workspaceLeaseEpoch: input.fence.workspaceLease.epoch,
      attemptVersion: input.expectedAttemptVersion,
      effect: input.effect,
      callId: input.call.callId,
      toolName: input.call.toolName,
      argsDigest: input.call.argsDigest,
      issuedAt: now,
      expiresAt: this.after(input.permitDurationMs),
    } as const;
    this.permits.push({ attemptId: record.attempt.attemptId, permit, consumed: false });
    await this.beforePermitIssueReturn?.(input);
    return { outcome: "authorized", permit };
  }

  async consumeExternalEffectPermit(
    input: Parameters<ExecutionPersistencePort["consumeExternalEffectPermit"]>[0],
  ): ReturnType<ExecutionPersistencePort["consumeExternalEffectPermit"]> {
    this.durableOperations.push(`permit:consume:${input.permit.callId}`);
    const record = this.find(input.fence.scope);
    if (record === "scope_mismatch") return { outcome: "scope_mismatch" };
    const now = this.databaseNow();
    const stored = this.permits.find(
      (candidate) => candidate.permit.permitId === input.permit.permitId,
    );
    if (!record?.attempt || !stored || !samePermit(stored.permit, input.permit)) {
      return { outcome: "fence_lost" };
    }
    if (stored.consumed) return { outcome: "already_consumed" };
    if (
      !this.validFence(record, input.fence) ||
      expired(input.fence, now) ||
      record.attempt.version !== input.expectedAttemptVersion ||
      input.permit.attemptVersion !== input.expectedAttemptVersion
    ) {
      return { outcome: "conflict" };
    }
    if (Date.parse(input.permit.expiresAt) <= Date.parse(now)) return { outcome: "expired" };
    stored.consumed = true;
    return { outcome: "consumed", databaseNow: now };
  }

  async mutate(command: RuntimeMutation): Promise<RuntimeMutationResult> {
    this.durableOperations.push(`mutate:${command.idempotencyKey}`);
    this.mutationCommands.push(command);
    if (this.unavailableNextMutation) {
      this.unavailableNextMutation = false;
      return { outcome: "unavailable" };
    }
    if (
      this.fenceLostMutationKeyIncludes !== undefined &&
      command.idempotencyKey.includes(this.fenceLostMutationKeyIncludes)
    ) {
      this.fenceLostMutationKeyIncludes = undefined;
      return { outcome: "fence_lost" };
    }
    if (
      this.idempotencyConflictKeyIncludes !== undefined &&
      command.idempotencyKey.includes(this.idempotencyConflictKeyIncludes)
    ) {
      this.idempotencyConflictKeyIncludes = undefined;
      return { outcome: "idempotency_conflict" };
    }
    const { commandDigest: suppliedDigest, ...unsigned } = command;
    if (command.schemaVersion !== 1 || runtimeMutationDigest(unsigned) !== suppliedDigest) {
      return { outcome: "idempotency_conflict" };
    }
    const record = this.find(command.fence.scope);
    if (record === "scope_mismatch") return { outcome: "scope_mismatch" };
    if (!record || this.forceFenceLost || !this.validFence(record, command.fence)) {
      return { outcome: "fence_lost" };
    }
    if (
      command.effectInvocation !== undefined &&
      record.attempt !== undefined &&
      record.effectInvocations.has(
        invocationKey(record.attempt.attemptId, command.effectInvocation.callId),
      )
    ) {
      return { outcome: "idempotency_conflict" };
    }
    const previous = record.mutations.get(command.idempotencyKey);
    if (previous) {
      return previous.receipt.commandDigest === command.commandDigest
        ? { ...previous, outcome: "already_applied" }
        : { outcome: "idempotency_conflict" };
    }
    if (
      this.responseUnknownWithoutCommitKeyIncludes !== undefined &&
      command.idempotencyKey.includes(this.responseUnknownWithoutCommitKeyIncludes)
    ) {
      this.responseUnknownWithoutCommitKeyIncludes = undefined;
      return { outcome: "response_unknown" };
    }
    const now = this.databaseNow();
    if (
      record.fence === undefined ||
      record.run.status !== "running" ||
      expired(record.fence, now) ||
      record.workspace.writerLease?.rootRunId !== record.fence.workspaceLease.rootRunId ||
      record.workspace.writerLease.epoch !== record.fence.workspaceLease.epoch
    ) {
      return { outcome: "fence_lost" };
    }
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
    if (command.effectInvocation !== undefined) {
      const matchingStarted = command.events.filter(
        (event) =>
          event.kind === "agent_event" &&
          event.payload.type === "tool.started" &&
          event.payload.callId === command.effectInvocation?.callId &&
          event.payload.name === command.effectInvocation.toolName,
      );
      if (matchingStarted.length !== 1) return { outcome: "conflict" };
      // 唯一键冲突永远不是 already_applied：callId 是一次性协议身份，不是可重放命令。
      if (
        record.effectInvocations.has(
          invocationKey(attempt.attemptId, command.effectInvocation.callId),
        )
      ) {
        return { outcome: "idempotency_conflict" };
      }
    } else if (
      command.events.some(
        (event) => event.kind === "agent_event" && event.payload.type === "tool.started",
      )
    ) {
      return { outcome: "conflict" };
    }
    if (
      command.rolloutProjection !== undefined
        ? command.expectedProjectionVersion !== record.projectionVersion
        : command.expectedProjectionVersion !== undefined
    ) {
      return { outcome: "conflict" };
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
      if (item.armed !== true) return { outcome: "conflict" };
      if ("armedAt" in item) return { outcome: "conflict" };
      if (item.state === "pending" && "disposition" in item.payload) {
        return { outcome: "conflict" };
      }
      const keyedExisting = record.outbox.find(
        (candidate) => candidate.idempotencyKey === item.idempotencyKey,
      );
      if (keyedExisting !== undefined && keyedExisting.kind !== "sandbox_cleanup") {
        return { outcome: "conflict" };
      }
      const existing = record.outbox.find(
        (candidate) =>
          candidate.kind === "sandbox_cleanup" && candidate.idempotencyKey === item.idempotencyKey,
      );
      if (!cleanupTransitionAllowed(existing?.state, item.state)) return { outcome: "conflict" };
      if (
        existing?.kind === "sandbox_cleanup" &&
        (existing.payload.registryId !== item.payload.registryId ||
          existing.payload.providerSandboxId !== item.payload.providerSandboxId)
      ) {
        return { outcome: "conflict" };
      }
      if (existing?.kind === "sandbox_cleanup") {
        if (existing.armed !== true) return { outcome: "conflict" };
        const previousDisposition =
          "disposition" in existing.payload ? existing.payload.disposition : undefined;
        const nextDisposition =
          "disposition" in item.payload ? item.payload.disposition : undefined;
        if (previousDisposition !== undefined && previousDisposition !== nextDisposition) {
          return { outcome: "conflict" };
        }
      }
    }

    const previousHead = record.workspace.currentRevisionId;
    const previousProjectionVersion = record.projectionVersion;
    record.events.push(...command.events.map((event) => ({ ...event, occurredAt: now })));
    if (command.effectInvocation !== undefined) {
      record.effectInvocations.set(
        invocationKey(attempt.attemptId, command.effectInvocation.callId),
        command.effectInvocation.toolName,
      );
    }
    for (const item of command.outbox) {
      const index = record.outbox.findIndex(
        (existing) => existing.idempotencyKey === item.idempotencyKey,
      );
      const previous = index < 0 ? undefined : record.outbox[index];
      const persisted: PersistedRuntimeOutboxV1 =
        item.kind === "sandbox_cleanup"
          ? {
              ...item,
              armedAt: previous?.kind === "sandbox_cleanup" ? previous.armedAt : now,
              occurredAt: now,
            }
          : { ...item, occurredAt: now };
      if (index < 0) record.outbox.push(persisted);
      else record.outbox[index] = persisted;
    }
    if (command.workspaceChange) {
      const commit = prepareWorkspaceRevision({
        workspace: record.workspace,
        rootRun: record.run,
        leaseEpoch: command.fence.workspaceLease.epoch,
        revisionId: command.workspaceChange.revisionId,
        objectKey: "legacy-manifest-not-used",
        digest: sha256Digest(command.workspaceChange.manifest.digest),
        now,
      });
      record.workspace = commit.workspace;
      this.revisionCreatedAt.push(commit.revision.createdAt);
    }
    if (command.nextRunStatus) record.run = transitionRun(record.run, command.nextRunStatus, now);
    if (command.rolloutProjection) {
      record.rolloutProjection = command.rolloutProjection;
      record.projectionVersion += 1;
    }
    const nextAttempt: ExecutionAttemptSnapshot = {
      ...attempt,
      status: command.nextAttemptStatus ?? attempt.status,
      stage: command.nextStage ?? attempt.stage,
      version: attempt.version + 1,
      nextEventSequence: attempt.nextEventSequence + command.events.length,
      modelExecutionStarted:
        attempt.modelExecutionStarted || command.nextStage === "model_execution_started",
      projectionVersion: record.projectionVersion,
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
    const contextEntryCount =
      command.threadSteer === undefined ? (command.threadContextAppend?.entries.length ?? 0) : 1;
    const receipt: RuntimeMutationReceiptV1 = {
      schemaVersion: 1,
      idempotencyKey: command.idempotencyKey,
      commandDigest: command.commandDigest,
      previousAttemptVersion: attempt.version,
      attemptVersion: nextAttempt.version,
      eventSequenceStart: attempt.nextEventSequence,
      eventSequenceEnd: nextAttempt.nextEventSequence,
      outbox: command.outbox.map((item) => {
        const receipt = fakeOutboxReceipt(record, item);
        if (
          receipt.kind === "sandbox_cleanup" &&
          receipt.disposition !== undefined &&
          this.rewriteNextCleanupReceiptDisposition?.state === receipt.state
        ) {
          const { disposition } = this.rewriteNextCleanupReceiptDisposition;
          this.rewriteNextCleanupReceiptDisposition = undefined;
          return { ...receipt, disposition };
        }
        return receipt;
      }),
      ...(command.effectInvocation === undefined
        ? {}
        : { effectInvocation: command.effectInvocation }),
      ...(command.rolloutProjection === undefined
        ? {}
        : {
            projection: {
              schemaVersion: 1,
              previousVersion: previousProjectionVersion,
              version: record.projectionVersion,
              digest: rolloutProjectionDigest(command.rolloutProjection),
            },
          }),
      ...(command.workspaceChange === undefined
        ? {}
        : {
            workspace: {
              changeDigest: workspaceChangeDigest(command.workspaceChange),
              ...(previousHead === undefined ? {} : { previousHead }),
              currentHead: command.workspaceChange.revisionId,
            },
          }),
      ...(command.threadContextAppend === undefined && command.threadSteer === undefined
        ? {}
        : {
            threadContext: {
              schemaVersion: 1,
              firstSequence: record.contextNextSequence,
              lastSequence: record.contextNextSequence + contextEntryCount - 1,
              entryCount: contextEntryCount,
            },
          }),
      ...(command.threadSteer === undefined
        ? {}
        : {
            threadSteer: {
              receiptId: command.threadSteer.receiptId,
              targetTurnId: command.threadSteer.targetTurnId,
              appliedContextSequence: record.contextNextSequence,
              bodyDigest: command.threadSteer.bodyDigest,
            },
          }),
      ...(command.threadSandboxTerminal === undefined
        ? {}
        : {
            threadSandbox:
              this.threadSandboxHandoffRunId === undefined
                ? ({
                    schemaVersion: 1,
                    outcome: "effect_pending",
                    sessionId: command.threadSandboxTerminal.sessionId,
                    generation: command.threadSandboxTerminal.generation,
                    effectId: `${attempt.attemptId}/sandbox/terminal-pause`,
                    effectKind: "pause",
                  } as const)
                : ({
                    schemaVersion: 1,
                    outcome: "handed_off",
                    sessionId: command.threadSandboxTerminal.sessionId,
                    generation: command.threadSandboxTerminal.generation,
                    nextRunId: this.threadSandboxHandoffRunId,
                  } as const),
          }),
    };
    if (command.threadContextAppend !== undefined || command.threadSteer !== undefined) {
      record.contextNextSequence += contextEntryCount;
    }
    if (command.threadSteer !== undefined) {
      const index = this.pendingThreadSteers.findIndex(
        (candidate) =>
          scopeKey(candidate.scope) === scopeKey(command.fence.scope) &&
          candidate.receiptId === command.threadSteer?.receiptId,
      );
      if (index >= 0) this.pendingThreadSteers.splice(index, 1);
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
      receipt,
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
    if (!record?.attempt) return "not_found";
    if (record.attempt.status === "recovery_required") return "recovered";
    if (!record.fence) return "not_found";
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

  private nextExpiry(fence: ExecutionFence, milliseconds: number): IsoTimestamp {
    const minimum = Math.max(
      this.databaseMillis + milliseconds,
      Date.parse(fence.runClaim.expiresAt) + 1,
      Date.parse(fence.workspaceLease.expiresAt) + 1,
    );
    return isoTimestamp(new Date(minimum).toISOString());
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
  materializeCount = 0;
  nextRevisionId: WorkspaceRevisionId | undefined;
  beforeReturn?: () => void | Promise<void>;
  beforeMaterializeReturn?: () => void | Promise<void>;
  throwOnMaterialize = false;

  async materialize(): Promise<void> {
    this.materializeCount += 1;
    await this.beforeMaterializeReturn?.();
    if (this.throwOnMaterialize) throw new Error("Workspace materialize failed");
  }

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
          candidateOperationKey: input.operationKey,
          candidateOperationDigest: "0".repeat(64) as ReturnType<typeof sha256Digest>,
          manifest: createWorkspaceManifest(
            { tenantId: input.scope.tenantId, entries: [] },
            { maxFiles: 1, maxTotalBytes: 1 },
          ),
        };
  }
}

export class FakeSandboxRegistry implements SandboxSessionRegistryPort, OrphanSandboxCleanupPort {
  acquireCount = 0;
  readonly acquireResourceFilesystemRequirements: boolean[] = [];
  settleCount = 0;
  nextAcquire: SandboxAcquireResult | undefined;
  nextSettlement: SandboxSettlementResult | undefined;
  throwOnSettle = false;
  readonly cleanupIntentIds: string[] = [];
  beforeAcquireReturn?: () => void | Promise<void>;
  beforeSettleReturn?: () => void | Promise<void>;
  readonly handle = new FakeSandboxHandle("worker-fake");
  private known = false;

  async acquire(
    input: Parameters<SandboxSessionRegistryPort["acquire"]>[0],
  ): Promise<SandboxAcquireResult> {
    this.acquireCount += 1;
    this.acquireResourceFilesystemRequirements.push(input.requiresResourceFilesystem);
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

  async closeOrphan(input: Parameters<OrphanSandboxCleanupPort["closeOrphan"]>[0]) {
    return this.settle({
      ...input,
      cleanupIntentId: `registry:${input.session.registryId}:orphan-cleanup`,
      disposition: "close",
    });
  }
}

export class FakeThreadSandboxLifecycle implements ThreadSandboxSessionLifecyclePort {
  acquireCount = 0;
  renewCount = 0;
  readonly resourceFilesystemRequirements: boolean[] = [];
  attestCount = 0;
  terminalEffectCount = 0;
  terminateCount = 0;
  nextAcquire: ThreadSandboxAcquireResult | undefined;
  nextRenew: "renewed" | "lease_lost" | "unavailable" | undefined;
  nextTerminalEffect: "settled" | "unknown" | "not_owner" | undefined;
  readonly handle = new FakeSandboxHandle("thread-worker-fake");
  readonly lease: ThreadSandboxLeaseRefV1 = {
    schemaVersion: 1,
    sessionId: "thread-session-test",
    generation: 1,
    leaseId: "sandbox-lease-test",
    leaseToken: "sandbox-token-test",
    leaseEpoch: 1,
  };

  async acquire(
    input: Parameters<ThreadSandboxSessionLifecyclePort["acquire"]>[0],
  ): Promise<ThreadSandboxAcquireResult> {
    this.acquireCount += 1;
    this.resourceFilesystemRequirements.push(input.requiresResourceFilesystem);
    if (this.nextAcquire !== undefined) {
      const result = this.nextAcquire;
      this.nextAcquire = undefined;
      return result;
    }
    return {
      outcome: "ready",
      session: {
        registryId: "thread-registry-test",
        providerSandboxId: this.handle.id,
        mode: "created",
        sandbox: this.handle,
      },
      lease: this.lease,
      resourceFilesystemMounted: input.requiresResourceFilesystem,
      requiresMaterialization: true,
      source: "cold_created",
    };
  }

  async attestMaterialized(): Promise<"attested"> {
    this.attestCount += 1;
    return "attested";
  }

  async renew(
    _input: Parameters<ThreadSandboxSessionLifecyclePort["renew"]>[0],
  ): Promise<"renewed" | "lease_lost" | "unavailable"> {
    this.renewCount += 1;
    const result = this.nextRenew ?? "renewed";
    this.nextRenew = undefined;
    return result;
  }

  async completeTerminalEffect(): Promise<"settled" | "unknown" | "not_owner"> {
    this.terminalEffectCount += 1;
    const result = this.nextTerminalEffect ?? "settled";
    this.nextTerminalEffect = undefined;
    return result;
  }

  async terminate(
    _input: Parameters<ThreadSandboxSessionLifecyclePort["terminate"]>[0],
  ): Promise<"settled"> {
    this.terminateCount += 1;
    return "settled";
  }
}

export class ScriptedAgentSession implements WorkerAgentSessionPort {
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
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

  async prepareInput(input: Parameters<WorkerAgentSessionPort["prepareInput"]>[0]) {
    return { text: input.text, images: [] } as const;
  }

  async runPrompt(
    input: Parameters<WorkerAgentSessionPort["runPrompt"]>[0],
    authorization: Parameters<WorkerAgentSessionPort["runPrompt"]>[1],
  ): Promise<AgentTurnOutcome> {
    this.prompts.push(input.text);
    this.modelPermits.push(authorization.permit.permitId);
    for (const event of this.events) for (const listener of this.listeners) listener(event);
    return this.outcome;
  }

  async steer(input: Parameters<WorkerAgentSessionPort["steer"]>[0]): Promise<void> {
    this.steers.push(input.text);
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
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  abortCount = 0;
  disposeCount = 0;
  private resolve: ((outcome: AgentTurnOutcome) => void) | undefined;
  private readonly listeners = new Set<(event: RuntimeAgentEvent) => void>();

  async prepareInput(input: Parameters<WorkerAgentSessionPort["prepareInput"]>[0]) {
    return { text: input.text, images: [] } as const;
  }

  runPrompt(input: Parameters<WorkerAgentSessionPort["runPrompt"]>[0]): Promise<AgentTurnOutcome> {
    this.prompts.push(input.text);
    return new Promise((resolve) => (this.resolve = resolve));
  }

  complete(outcome: AgentTurnOutcome = { kind: "completed" }): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(outcome);
  }

  async steer(input: Parameters<WorkerAgentSessionPort["steer"]>[0]): Promise<void> {
    this.steers.push(input.text);
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.complete();
  }

  emit(event: RuntimeAgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

export class FakeSessionFactory implements AgentSessionFactoryPort {
  createCount = 0;
  readonly projections: ControlledRolloutProjection[] = [];
  readonly toolAuthorizers: Array<
    Parameters<AgentSessionFactoryPort["create"]>[0]["authorizeToolEffect"]
  > = [];
  readonly todoWriters: Array<Parameters<AgentSessionFactoryPort["create"]>[0]["writeTodo"]> = [];
  readonly agentControls: Array<Parameters<AgentSessionFactoryPort["create"]>[0]["agentControl"]> =
    [];
  readonly agentIdentities: Array<Parameters<AgentSessionFactoryPort["create"]>[0]["agent"]> = [];
  readonly preparedSandboxes: SandboxSessionRef[] = [];

  constructor(
    private readonly queue: WorkerAgentSessionPort[],
    private readonly prepareSandboxBeforeInput:
      | boolean
      | ((ensure: () => Promise<SandboxSessionRef>) => Promise<void>) = false,
  ) {}

  async create(
    input: Parameters<AgentSessionFactoryPort["create"]>[0],
  ): Promise<WorkerAgentSessionPort> {
    const session = this.queue.shift();
    if (!session) throw new Error("Fake Session 不存在");
    this.createCount += 1;
    this.projections.push(input.rolloutProjection);
    this.toolAuthorizers.push(input.authorizeToolEffect);
    this.todoWriters.push(input.writeTodo);
    this.agentControls.push(input.agentControl);
    this.agentIdentities.push(input.agent);
    let safePointChain = Promise.resolve();
    const unsubscribe =
      input.onTurnSafePoint === undefined
        ? () => undefined
        : session.subscribe((event) => {
            if (event.type !== "turn.completed") return;
            safePointChain = safePointChain.then(async () => {
              const safePoint = await input.onTurnSafePoint?.(event);
              if (safePoint?.steer !== undefined) {
                await session.steer({
                  text: safePoint.steer.inputText,
                  attachments: safePoint.steer.attachments ?? [],
                });
              }
            });
          });
    const drainRejectedToolReceipts = session.drainRejectedToolReceipts?.bind(session);
    return {
      prepareInput: async (userInput) => {
        if (typeof this.prepareSandboxBeforeInput === "function") {
          await this.prepareSandboxBeforeInput(() =>
            input.ensureSandboxReady({ reason: "attachment" }),
          );
        } else if (this.prepareSandboxBeforeInput) {
          this.preparedSandboxes.push(await input.ensureSandboxReady({ reason: "attachment" }));
        }
        return await session.prepareInput(userInput);
      },
      runPrompt: async (prepared, authorization) => {
        const outcome = await session.runPrompt(prepared, authorization);
        await safePointChain;
        return outcome;
      },
      steer: (userInput) => session.steer(userInput),
      abort: () => session.abort(),
      ...(drainRejectedToolReceipts === undefined
        ? {}
        : { drainRejectedToolReceipts: () => drainRejectedToolReceipts() }),
      subscribe: (listener) => session.subscribe(listener),
      dispose: () => {
        unsubscribe();
        session.dispose();
      },
    };
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
  private readonly heartbeats: Array<{
    active: boolean;
    callback: () => Promise<void>;
    inFlight: Set<Promise<void>>;
  }> = [];
  private readonly scheduled: Array<{ active: boolean; callback: () => void }> = [];

  schedule(_delayMs: number, callback: () => void): ScheduledTask {
    const task = { active: true, callback };
    this.scheduled.push(task);
    return { cancel: () => (task.active = false) };
  }

  startHeartbeat(_intervalMs: number, callback: () => Promise<void>): HeartbeatTask {
    const heartbeat = { active: true, callback, inFlight: new Set<Promise<void>>() };
    this.heartbeats.push(heartbeat);
    return {
      stop: async () => {
        heartbeat.active = false;
        await Promise.allSettled([...heartbeat.inFlight]);
      },
    };
  }

  async tickHeartbeat(): Promise<void> {
    for (const heartbeat of this.heartbeats) {
      if (!heartbeat.active) continue;
      const task = heartbeat.callback();
      heartbeat.inFlight.add(task);
      try {
        await task;
      } finally {
        heartbeat.inFlight.delete(task);
      }
    }
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

export class FakeRecoveryMetrics implements RecoveryMetricsPort {
  readonly orphanCleanups: Array<Parameters<RecoveryMetricsPort["recordOrphanCleanup"]>[0]> = [];

  async recordOrphanCleanup(
    input: Parameters<RecoveryMetricsPort["recordOrphanCleanup"]>[0],
  ): Promise<void> {
    this.orphanCleanups.push(input);
  }
}

export class FakeThreadContextBodies implements ThreadContextBodyPersistencePort {
  readonly values: Readonly<Record<string, unknown>>[] = [];

  async persist(input: Parameters<ThreadContextBodyPersistencePort["persist"]>[0]) {
    this.values.push(input.value);
    return {
      storage: "inline" as const,
      value: input.value,
      sha256: digestCanonical(input.value),
      size: Buffer.byteLength(JSON.stringify(input.value), "utf8"),
    };
  }
}

export interface FakeSeed {
  readonly run: Run;
  readonly tenantKind?: "personal" | "team";
  readonly workspace: Workspace;
  readonly input: string;
  readonly attachments?: readonly UserInputAttachmentReference[];
  readonly answer?: string;
  readonly rolloutProjection: ControlledRolloutProjection;
  readonly skills?: RunSkillSnapshot;
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
    rolloutProjection: { schemaVersion: 2, checkpointId: `checkpoint-${prefix}`, items: [] },
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

function invocationKey(attemptId: string, callId: string): string {
  return `${attemptId}\u0000${callId}`;
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

function fakeOutboxReceipt(record: FakeRecord, item: RuntimeOutboxV1): RuntimeOutboxReceiptV1 {
  const persisted = record.outbox.find(
    (candidate) => candidate.idempotencyKey === item.idempotencyKey,
  );
  if (item.kind === "sandbox_cleanup") {
    if (persisted?.kind !== "sandbox_cleanup") throw new Error("cleanup receipt 缺少持久行");
    const disposition =
      "disposition" in persisted.payload ? persisted.payload.disposition : undefined;
    return {
      kind: item.kind,
      idempotencyKey: item.idempotencyKey,
      payloadDigest: outboxPayloadDigest(item, persisted.armedAt),
      state: item.state,
      armed: true,
      armedAt: persisted.armedAt,
      identity: {
        registryId: item.payload.registryId,
        providerSandboxId: item.payload.providerSandboxId,
      },
      identityDigest: sandboxCleanupIdentityDigest(item),
      ...(disposition === undefined ? {} : { disposition }),
    };
  }
  if (item.kind === "sandbox_lifecycle_unknown") {
    return {
      kind: item.kind,
      idempotencyKey: item.idempotencyKey,
      payloadDigest: outboxPayloadDigest(item),
      state: item.state,
    };
  }
  return {
    kind: item.kind,
    idempotencyKey: item.idempotencyKey,
    payloadDigest: outboxPayloadDigest(item),
    state: item.state,
  };
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

function samePermit(left: ExternalEffectPermit, right: ExternalEffectPermit): boolean {
  return (
    left.permitId === right.permitId &&
    sameScope(left.scope, right.scope) &&
    left.runClaimToken === right.runClaimToken &&
    left.runClaimEpoch === right.runClaimEpoch &&
    left.workspaceRootRunId === right.workspaceRootRunId &&
    left.workspaceLeaseEpoch === right.workspaceLeaseEpoch &&
    left.attemptVersion === right.attemptVersion &&
    left.effect === right.effect &&
    left.callId === right.callId &&
    left.toolName === right.toolName &&
    left.argsDigest === right.argsDigest &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt
  );
}
