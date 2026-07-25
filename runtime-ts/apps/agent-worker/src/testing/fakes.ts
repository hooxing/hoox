import {
  type RunId,
  type WorkspaceId,
  type WorkspaceRevisionId,
  workspaceRevisionId,
} from "@cube-runtime/domain";
import type { RuntimeAgentEvent } from "@cube-runtime/pi-adapter";
import { FakeSandboxHandle } from "@cube-runtime/sandbox";
import type {
  AgentSessionFactoryPort,
  AgentTurnOutcome,
  ArtifactPublicationPort,
  CancellationPort,
  ClockPort,
  HeartbeatTask,
  OutboxMessage,
  PersistedRunEvent,
  RunClaim,
  RunClaimResult,
  RunCommitCommand,
  RunCommitResult,
  RunPersistencePort,
  RunScope,
  RunSnapshot,
  SandboxAcquireResult,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  SandboxSettlementResult,
  ScheduledTask,
  VerifiedWorkspaceRevision,
  WorkerAgentSessionPort,
  WorkspaceLease,
  WorkspaceLeaseResult,
  WorkspacePort,
  WorkspaceRevisionVerifierPort,
} from "../ports.js";

function sameScope(left: RunScope, right: RunScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId
  );
}

interface ActiveClaim {
  readonly token: string;
  readonly epoch: number;
  expiresAt: Date;
}

/** 事务型 Fake：故意把事件、Outbox、状态和 claim 栅栏放在同一个内存对象中。 */
export class FakeRunPersistence implements RunPersistencePort {
  snapshot: RunSnapshot;
  readonly events: PersistedRunEvent[] = [];
  readonly outbox: OutboxMessage[] = [];
  commitCount = 0;
  claimCount = 0;
  failNextCommit = false;
  forceFenceLost = false;
  private claimEpoch = 0;
  private activeClaim: ActiveClaim | undefined;

  constructor(snapshot: RunSnapshot) {
    this.snapshot = { ...snapshot };
  }

  async claim(input: {
    readonly scope: RunScope;
    readonly workerId: string;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<RunClaimResult> {
    this.claimCount += 1;
    if (!sameScope(input.scope, this.snapshot)) return { outcome: "scope_mismatch" };
    if (["succeeded", "failed", "cancelled"].includes(this.snapshot.status)) {
      return { outcome: "terminal" };
    }
    if (this.snapshot.status === "waiting" && this.snapshot.followUp === undefined) {
      return { outcome: "busy" };
    }
    if (this.activeClaim && this.activeClaim.expiresAt > input.now) return { outcome: "busy" };
    const epoch = ++this.claimEpoch;
    const token = `${input.workerId}-${epoch}`;
    this.activeClaim = { token, epoch, expiresAt: input.leaseUntil };
    this.snapshot = {
      ...this.snapshot,
      status: "running",
      stateVersion: this.snapshot.stateVersion + 1,
    };
    return {
      outcome: "claimed",
      claim: {
        token,
        epoch,
        expiresAt: input.leaseUntil,
        snapshot: { ...this.snapshot },
      },
    };
  }

  async renewClaim(input: {
    readonly scope: RunScope;
    readonly claimToken: string;
    readonly claimEpoch: number;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<"renewed" | "fence_lost" | "unavailable"> {
    if (this.forceFenceLost || !sameScope(input.scope, this.snapshot)) return "fence_lost";
    const claim = this.activeClaim;
    if (
      !claim ||
      !this.matchesClaim(input.claimToken, input.claimEpoch) ||
      claim.expiresAt < input.now
    ) {
      return "fence_lost";
    }
    claim.expiresAt = input.leaseUntil;
    return "renewed";
  }

  async commit(command: RunCommitCommand): Promise<RunCommitResult> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      return { outcome: "unavailable" };
    }
    if (
      this.forceFenceLost ||
      !sameScope(command.scope, this.snapshot) ||
      !this.matchesClaim(command.claimToken, command.claimEpoch)
    ) {
      return { outcome: "fence_lost" };
    }
    if (command.expectedStateVersion !== this.snapshot.stateVersion) return { outcome: "conflict" };

    const newEvents = command.events.filter(
      (candidate) =>
        !this.events.some((event) => event.idempotencyKey === candidate.idempotencyKey),
    );
    const newOutbox = command.outbox.filter(
      (candidate) =>
        !this.outbox.some((event) => event.idempotencyKey === candidate.idempotencyKey),
    );
    for (const event of newEvents) {
      if (
        event.sequence !==
        this.snapshot.nextEventSequence + this.eventsSinceSnapshot(newEvents, event)
      ) {
        return { outcome: "conflict" };
      }
    }

    this.events.push(...newEvents);
    this.outbox.push(...newOutbox);
    this.commitCount += 1;
    this.snapshot = {
      ...this.snapshot,
      ...(command.nextStatus === undefined ? {} : { status: command.nextStatus }),
      stateVersion: this.snapshot.stateVersion + 1,
      nextEventSequence: this.snapshot.nextEventSequence + newEvents.length,
    };
    if (command.releaseClaim) this.activeClaim = undefined;
    return {
      outcome: newEvents.length === 0 && newOutbox.length === 0 ? "already_applied" : "committed",
      stateVersion: this.snapshot.stateVersion,
      nextEventSequence: this.snapshot.nextEventSequence,
    };
  }

  /** 模拟进程在提交部分事件后消失，调度器确认超时后才允许下一次领取。 */
  markInterruptedAfterCrash(): void {
    this.activeClaim = undefined;
    this.snapshot = {
      ...this.snapshot,
      status: "interrupted",
      stateVersion: this.snapshot.stateVersion + 1,
    };
  }

  resume(followUp: string): void {
    if (this.snapshot.status !== "waiting") throw new Error("只有 waiting Run 可以恢复");
    this.snapshot = {
      ...this.snapshot,
      followUp,
      status: "queued",
      stateVersion: this.snapshot.stateVersion + 1,
    };
  }

  activeClaimForTest(): RunClaim | undefined {
    if (!this.activeClaim) return undefined;
    return { ...this.activeClaim, snapshot: { ...this.snapshot } };
  }

  private matchesClaim(token: string, epoch: number): boolean {
    return this.activeClaim?.token === token && this.activeClaim.epoch === epoch;
  }

  private eventsSinceSnapshot(
    batch: readonly PersistedRunEvent[],
    candidate: PersistedRunEvent,
  ): number {
    return batch.indexOf(candidate);
  }
}

export class FakeWorkspacePort implements WorkspacePort {
  commitCount = 0;
  forceLeaseLost = false;
  forceCommitResult?: "lease_lost" | "revision_conflict" | "unavailable";
  currentRevisionId?: WorkspaceRevisionId;
  private epoch = 0;
  private activeLease: WorkspaceLease | undefined;
  private readonly committedKeys = new Set<string>();

  async acquireLease(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<WorkspaceLeaseResult> {
    if (this.activeLease && this.activeLease.expiresAt > input.now) return { outcome: "busy" };
    this.activeLease = {
      token: `workspace-${++this.epoch}`,
      epoch: this.epoch,
      expiresAt: input.leaseUntil,
      ...(this.currentRevisionId === undefined ? {} : { baseRevisionId: this.currentRevisionId }),
    };
    return { outcome: "acquired", lease: this.activeLease };
  }

  async renewLease(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly lease: WorkspaceLease;
    readonly now: Date;
    readonly leaseUntil: Date;
  }): Promise<"renewed" | "lease_lost" | "unavailable"> {
    const lease = this.activeLease;
    if (this.forceLeaseLost || !lease || !this.matches(input.lease)) return "lease_lost";
    this.activeLease = { ...lease, expiresAt: input.leaseUntil };
    return "renewed";
  }

  async commitVerifiedRevision(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly lease: WorkspaceLease;
    readonly revision: VerifiedWorkspaceRevision;
  }): Promise<
    "committed" | "already_applied" | "lease_lost" | "revision_conflict" | "unavailable"
  > {
    if (this.forceCommitResult) return this.forceCommitResult;
    if (this.forceLeaseLost || !this.matches(input.lease)) return "lease_lost";
    if (this.committedKeys.has(input.revision.idempotencyKey)) return "already_applied";
    if (input.revision.baseRevisionId !== this.currentRevisionId) return "revision_conflict";
    this.committedKeys.add(input.revision.idempotencyKey);
    this.currentRevisionId = input.revision.revisionId;
    this.commitCount += 1;
    return "committed";
  }

  async releaseLease(input: {
    readonly scope: RunScope;
    readonly workspaceId: WorkspaceId;
    readonly lease: WorkspaceLease;
  }): Promise<void> {
    if (this.matches(input.lease)) this.activeLease = undefined;
  }

  private matches(lease: WorkspaceLease): boolean {
    return this.activeLease?.token === lease.token && this.activeLease.epoch === lease.epoch;
  }
}

export class FakeRevisionVerifier implements WorkspaceRevisionVerifierPort {
  verifyCount = 0;
  nextRevisionId: WorkspaceRevisionId | undefined;

  async verify(
    input: Parameters<WorkspaceRevisionVerifierPort["verify"]>[0],
  ): Promise<VerifiedWorkspaceRevision | undefined> {
    this.verifyCount += 1;
    const revisionId = this.nextRevisionId;
    this.nextRevisionId = undefined;
    if (revisionId === undefined) return undefined;
    return {
      verified: true,
      ...(input.baseRevisionId === undefined ? {} : { baseRevisionId: input.baseRevisionId }),
      revisionId,
      objectKey: `workspaces/${input.workspaceId}/${revisionId}`,
      digest: `sha256:${revisionId}`,
      idempotencyKey: `${input.scope.runId}/revision/${revisionId}`,
    };
  }
}

export class FakeSandboxRegistry implements SandboxSessionRegistryPort {
  acquireCount = 0;
  settleCount = 0;
  nextAcquire: SandboxAcquireResult | undefined;
  nextSettlement: SandboxSettlementResult | undefined;
  readonly handle = new FakeSandboxHandle("worker-fake");
  private session: SandboxSessionRef | undefined;

  async acquire(): Promise<SandboxAcquireResult> {
    this.acquireCount += 1;
    if (this.nextAcquire) {
      const result = this.nextAcquire;
      this.nextAcquire = undefined;
      return result;
    }
    this.session = {
      registryId: "registry-1",
      providerSandboxId: this.handle.id,
      mode: this.session === undefined ? "created" : "connected",
      sandbox: this.handle,
    };
    return { outcome: "ready", session: this.session };
  }

  async settle(): Promise<SandboxSettlementResult> {
    this.settleCount += 1;
    if (this.nextSettlement) {
      const result = this.nextSettlement;
      this.nextSettlement = undefined;
      return result;
    }
    return { outcome: "settled" };
  }
}

export class ScriptedAgentSession implements WorkerAgentSessionPort {
  readonly turns: Array<{ readonly mode: "prompt" | "follow_up"; readonly text: string }> = [];
  abortCount = 0;
  disposeCount = 0;
  private readonly listeners = new Set<(event: RuntimeAgentEvent) => void>();

  constructor(
    private readonly events: readonly RuntimeAgentEvent[],
    private readonly outcome: AgentTurnOutcome = { kind: "completed" },
  ) {}

  async run(input: {
    readonly mode: "prompt" | "follow_up";
    readonly text: string;
  }): Promise<AgentTurnOutcome> {
    this.turns.push(input);
    for (const event of this.events) {
      for (const listener of this.listeners) listener(event);
    }
    return this.outcome;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
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
  private resolve?: (outcome: AgentTurnOutcome) => void;

  run(): Promise<AgentTurnOutcome> {
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.resolve?.({ kind: "completed" });
  }

  complete(outcome: AgentTurnOutcome = { kind: "completed" }): void {
    this.resolve?.(outcome);
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
  failNextCreate = false;
  readonly created: WorkerAgentSessionPort[] = [];

  constructor(private readonly queue: WorkerAgentSessionPort[]) {}

  async create(): Promise<WorkerAgentSessionPort> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("Fake Session 创建失败");
    }
    const session = this.queue.shift();
    if (!session) throw new Error("FakeSessionFactory 没有可用 Session");
    this.createCount += 1;
    this.created.push(session);
    return session;
  }
}

export class FakeCancellationPort implements CancellationPort {
  private readonly signals = new Map<RunId, AbortController>();

  signalFor(scope: RunScope): AbortSignal {
    return this.controller(scope.runId).signal;
  }

  cancel(runId: RunId): void {
    this.controller(runId).abort("test_cancelled");
  }

  private controller(runId: RunId): AbortController {
    let controller = this.signals.get(runId);
    if (!controller) {
      controller = new AbortController();
      this.signals.set(runId, controller);
    }
    return controller;
  }
}

interface FakeHeartbeat {
  active: boolean;
  readonly callback: () => Promise<void>;
}

interface FakeSchedule {
  active: boolean;
  readonly dueAt: number;
  readonly callback: () => void;
}

export class FakeClock implements ClockPort {
  private current: number;
  private readonly heartbeats: FakeHeartbeat[] = [];
  private readonly schedules: FakeSchedule[] = [];

  constructor(now = new Date("2026-07-26T00:00:00.000Z")) {
    this.current = now.valueOf();
  }

  now(): Date {
    return new Date(this.current);
  }

  schedule(delayMs: number, callback: () => void): ScheduledTask {
    const scheduled = { active: true, dueAt: this.current + delayMs, callback };
    this.schedules.push(scheduled);
    return { cancel: () => (scheduled.active = false) };
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

  async tickHeartbeats(): Promise<void> {
    for (const heartbeat of this.heartbeats) {
      if (heartbeat.active) await heartbeat.callback();
    }
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const scheduled of this.schedules) {
      if (scheduled.active && scheduled.dueAt <= this.current) {
        scheduled.active = false;
        scheduled.callback();
      }
    }
  }
}

export class FakeArtifactPublication implements ArtifactPublicationPort {
  calls = 0;
  onAssert?: () => void | Promise<void>;

  async assertReadyForCompletion(): Promise<void> {
    this.calls += 1;
    await this.onAssert?.();
  }
}

export function fakeVerifiedRevision(value = "revision-next"): WorkspaceRevisionId {
  return workspaceRevisionId(value);
}
