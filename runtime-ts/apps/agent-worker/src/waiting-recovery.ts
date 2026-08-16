import type { IsoTimestamp, WorkspaceRevisionId } from "@aisay/domain";
import type { ExecutionScope } from "./ports.js";

/**
 * waiting 安全点的持久事实。它必须能够只从 PostgreSQL 与 Stable Blob 重建；
 * Sandbox 中的进程、环境变量和网络连接都不属于恢复契约。
 */
export interface WaitingRecoveryCheckpoint {
  readonly attemptId: string;
  readonly attemptGeneration: number;
  readonly checkpointId: string;
  readonly scope: ExecutionScope;
  readonly workspaceHeadAtWait: Exclude<WorkspaceHeadObservation, { outcome: "unavailable" }>;
  readonly sandbox?: WarmSandboxCandidate;
}

export interface WarmSandboxCandidate {
  readonly registryId: string;
  readonly providerSandboxId: string;
  readonly tenantId: string;
  readonly threadId: string;
  readonly workspaceId: string;
  readonly baseRevisionId?: WorkspaceRevisionId;
  readonly generation: number;
  readonly expectedGeneration: number;
  readonly pausedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly lifecycle:
    | "paused"
    | "pause_unknown"
    | "connect_unknown"
    | "create_unknown"
    | "materialize_unknown";
}

export interface WaitingRecoveryObservation {
  readonly now: IsoTimestamp;
  readonly currentWorkspaceHead: WorkspaceHeadObservation;
  /** 用户提交与 waiting 基线是否可由上层重新计算计划；false 时必须暴露结构化冲突。 */
  readonly canReplanWorkspaceChange: boolean;
}

export type WorkspaceHeadObservation =
  | { readonly outcome: "found"; readonly revisionId: WorkspaceRevisionId }
  | { readonly outcome: "empty" }
  | { readonly outcome: "unavailable" };

export type SandboxRecoveryFact =
  | { readonly kind: "sandbox_reused"; readonly registryId: string; readonly generation: number }
  | {
      readonly kind: "sandbox_rebuilt";
      readonly reason:
        | "missing"
        | "ttl_expired"
        | "generation_mismatch"
        | "scope_mismatch"
        | "base_revision_mismatch";
    };

export type WaitingRecoveryDecision =
  | {
      readonly outcome: "resume";
      readonly workspace: "unchanged" | "replan";
      readonly sandbox: SandboxRecoveryFact;
    }
  | {
      readonly outcome: "workspace_conflict";
      readonly expectedHead?: WorkspaceRevisionId;
      readonly actualHead?: WorkspaceRevisionId;
    }
  | { readonly outcome: "workspace_head_unavailable"; readonly requestAutomaticRetry: false }
  | {
      readonly outcome: "external_effect_unknown";
      readonly effect: "pause" | "connect" | "create" | "materialize";
      readonly requestAutomaticRetry: false;
    };

export interface WaitingRecoveryClaim {
  readonly checkpoint: WaitingRecoveryCheckpoint;
  readonly claimToken: string;
  readonly claimEpoch: number;
  readonly databaseNow: IsoTimestamp;
}

/** PostgreSQL 实现必须用唯一键 + CAS 保证同一 checkpoint 只有一个恢复者。 */
export interface WaitingRecoveryStorePort {
  claim(input: {
    readonly scope: ExecutionScope;
    readonly checkpointId: string;
    readonly attemptId: string;
    readonly workerId: string;
  }): Promise<
    | { readonly outcome: "claimed"; readonly claim: WaitingRecoveryClaim }
    | { readonly outcome: "busy" | "resolved" | "not_found" }
  >;
  resolve(input: {
    readonly claim: WaitingRecoveryClaim;
    readonly decision: WaitingRecoveryDecision;
  }): Promise<"resolved" | "already_resolved" | "claim_lost">;
  beginEffect(input: {
    readonly claim: WaitingRecoveryClaim;
    readonly decision: Extract<WaitingRecoveryDecision, { outcome: "resume" }>;
    readonly effect: "connect" | "create" | "materialize";
  }): Promise<
    | {
        readonly outcome: "authorized";
        readonly intentId: string;
      }
    | { readonly outcome: "already_completed"; readonly proof: SandboxEffectProof }
    | { readonly outcome: "claim_lost" | "already_started" }
  >;
}

export interface WaitingRecoveryEffectPort {
  /** unknown 只能在受控执行器已将 executing intent 持久收敛后返回。 */
  execute(input: {
    readonly intentId: string;
    readonly claim: WaitingRecoveryClaim;
    readonly effect: "connect" | "create" | "materialize";
  }): Promise<
    | { readonly outcome: "completed" }
    | { readonly outcome: "unknown"; readonly effect: "connect" | "create" | "materialize" }
    | { readonly outcome: "claim_lost" }
  >;
}

export interface SandboxEffectProof {
  readonly registryId: string;
  readonly providerSandboxId: string;
  readonly generation: number;
}

export type WaitingRecoveryCoordinatorResult =
  | { readonly outcome: "busy" | "resolved" | "not_found" | "claim_lost" }
  | { readonly outcome: "decided"; readonly decision: WaitingRecoveryDecision };

/**
 * 窄编排只负责 PG 恢复权、intent 和确定事实落库。真正的 connect/create/materialize 只能在
 * intent 提交后执行；因此进程崩溃后不会依赖本地变量判断副作用是否发生。
 */
export async function coordinateWaitingRecovery(input: {
  readonly store: WaitingRecoveryStorePort;
  readonly scope: ExecutionScope;
  readonly checkpointId: string;
  readonly attemptId: string;
  readonly workerId: string;
  readonly observation: WaitingRecoveryObservation;
  readonly effects: WaitingRecoveryEffectPort;
}): Promise<WaitingRecoveryCoordinatorResult> {
  const claimed = await input.store.claim(input);
  if (claimed.outcome !== "claimed") return { outcome: claimed.outcome };
  if (
    !sameScope(claimed.claim.checkpoint.scope, input.scope) ||
    claimed.claim.checkpoint.attemptId !== input.attemptId ||
    !Number.isSafeInteger(claimed.claim.checkpoint.attemptGeneration) ||
    claimed.claim.checkpoint.attemptGeneration < 1
  ) {
    return { outcome: "claim_lost" };
  }
  const decision = decideWaitingRecovery(claimed.claim.checkpoint, {
    ...input.observation,
    now: claimed.claim.databaseNow,
  });
  if (decision.outcome === "workspace_head_unavailable") {
    const resolved = await input.store.resolve({ claim: claimed.claim, decision });
    return resolved === "resolved"
      ? { outcome: "decided", decision }
      : { outcome: resolved === "already_resolved" ? "resolved" : "claim_lost" };
  }
  if (decision.outcome === "resume") {
    const effectPlan =
      decision.sandbox.kind === "sandbox_reused"
        ? decision.workspace === "replan"
          ? (["connect", "materialize"] as const)
          : (["connect"] as const)
        : (["create", "materialize"] as const);
    for (const effectKind of effectPlan) {
      // 每一个副作用都必须先有独立 intent；create 成功不能授权未持久化的 materialize。
      const started = await input.store.beginEffect({
        claim: claimed.claim,
        decision,
        effect: effectKind,
      });
      if (started.outcome !== "authorized") {
        if (started.outcome === "already_completed") continue;
        return { outcome: started.outcome === "claim_lost" ? "claim_lost" : "busy" };
      }
      const effect = await input.effects.execute({
        claim: claimed.claim,
        intentId: started.intentId,
        effect: effectKind,
      });
      if (effect.outcome === "unknown") {
        return {
          outcome: "decided",
          decision: {
            outcome: "external_effect_unknown",
            effect: effect.effect,
            requestAutomaticRetry: false,
          },
        };
      }
      if (effect.outcome === "claim_lost") return { outcome: "claim_lost" };
    }
  }
  const resolved = await input.store.resolve({
    claim: claimed.claim,
    decision,
  });
  return resolved === "resolved"
    ? { outcome: "decided", decision }
    : { outcome: resolved === "already_resolved" ? "resolved" : "claim_lost" };
}

function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.workspaceId === right.workspaceId &&
    left.baseRevisionId === right.baseRevisionId
  );
}

/**
 * 纯决策核心：不调用 CubeSandbox、不读取本机 Session 文件，也不隐式重试未知副作用。
 * 调用方先以 PG CAS 取得 checkpoint 的恢复权，再执行本函数给出的唯一动作。
 */
export function decideWaitingRecovery(
  checkpoint: WaitingRecoveryCheckpoint,
  observation: WaitingRecoveryObservation,
): WaitingRecoveryDecision {
  assertCheckpoint(checkpoint);
  const currentHead = observation.currentWorkspaceHead;
  if (currentHead.outcome === "unavailable") {
    return { outcome: "workspace_head_unavailable", requestAutomaticRetry: false };
  }
  const baselineHead = checkpoint.workspaceHeadAtWait;
  const expectedHead = headRevision(baselineHead);
  const actualHead = headRevision(currentHead);
  const workspaceChanged = expectedHead !== actualHead;
  if (workspaceChanged && !observation.canReplanWorkspaceChange) {
    return {
      outcome: "workspace_conflict",
      ...(expectedHead === undefined ? {} : { expectedHead }),
      ...(actualHead === undefined ? {} : { actualHead }),
    };
  }
  const workspace = workspaceChanged ? "replan" : "unchanged";
  const candidate = checkpoint.sandbox;
  if (candidate === undefined) {
    return {
      outcome: "resume",
      workspace,
      sandbox: { kind: "sandbox_rebuilt", reason: "missing" },
    };
  }
  if (candidate.lifecycle !== "paused") {
    return {
      outcome: "external_effect_unknown",
      effect: candidate.lifecycle.replace("_unknown", "") as
        | "pause"
        | "connect"
        | "create"
        | "materialize",
      requestAutomaticRetry: false,
    };
  }
  const scope = checkpoint.scope;
  if (
    candidate.tenantId !== scope.tenantId ||
    candidate.threadId !== scope.threadId ||
    candidate.workspaceId !== scope.workspaceId
  ) {
    return {
      outcome: "resume",
      workspace,
      sandbox: { kind: "sandbox_rebuilt", reason: "scope_mismatch" },
    };
  }
  if (candidate.baseRevisionId !== scope.baseRevisionId) {
    return {
      outcome: "resume",
      workspace,
      sandbox: { kind: "sandbox_rebuilt", reason: "base_revision_mismatch" },
    };
  }
  if (candidate.generation !== candidate.expectedGeneration) {
    return {
      outcome: "resume",
      workspace,
      sandbox: { kind: "sandbox_rebuilt", reason: "generation_mismatch" },
    };
  }
  // expiresAt 是开区间上界；恰好到期也不复用，避免两个节点在边界得出不同答案。
  if (Date.parse(observation.now) >= Date.parse(candidate.expiresAt)) {
    return {
      outcome: "resume",
      workspace,
      sandbox: { kind: "sandbox_rebuilt", reason: "ttl_expired" },
    };
  }
  return {
    outcome: "resume",
    workspace,
    sandbox: {
      kind: "sandbox_reused",
      registryId: candidate.registryId,
      generation: candidate.generation,
    },
  };
}

function headRevision(
  head: Exclude<WorkspaceHeadObservation, { outcome: "unavailable" }>,
): WorkspaceRevisionId | undefined {
  return head.outcome === "found" ? head.revisionId : undefined;
}

function assertCheckpoint(checkpoint: WaitingRecoveryCheckpoint): void {
  if (!checkpoint.checkpointId.trim()) throw new TypeError("waiting checkpointId 不能为空");
  if (!checkpoint.attemptId.trim()) throw new TypeError("waiting attemptId 不能为空");
  if (!Number.isSafeInteger(checkpoint.attemptGeneration) || checkpoint.attemptGeneration < 1) {
    throw new TypeError("waiting attemptGeneration 无效");
  }
  const candidate = checkpoint.sandbox;
  if (candidate === undefined) return;
  if (!Number.isSafeInteger(candidate.generation) || candidate.generation < 1) {
    throw new TypeError("Sandbox generation 无效");
  }
  if (!Number.isSafeInteger(candidate.expectedGeneration) || candidate.expectedGeneration < 1) {
    throw new TypeError("Sandbox expectedGeneration 无效");
  }
  if (
    !Number.isFinite(Date.parse(candidate.pausedAt)) ||
    !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    Date.parse(candidate.expiresAt) <= Date.parse(candidate.pausedAt) ||
    Date.parse(candidate.expiresAt) - Date.parse(candidate.pausedAt) > 10 * 60_000
  ) {
    throw new TypeError("Sandbox warm TTL 必须为最多十分钟的有效时间窗");
  }
}
