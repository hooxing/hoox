import type { IsoTimestamp, WorkspaceRevisionId } from "@cube-runtime/domain";
import type { ExecutionScope } from "./ports.js";

/**
 * waiting 安全点的持久事实。它必须能够只从 PostgreSQL 与 Stable Blob 重建；
 * Sandbox 中的进程、环境变量和网络连接都不属于恢复契约。
 */
export interface WaitingRecoveryCheckpoint {
  readonly checkpointId: string;
  readonly scope: ExecutionScope;
  readonly workspaceHeadAtWait?: WorkspaceRevisionId;
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
  readonly currentWorkspaceHead?: WorkspaceRevisionId;
  /** 用户提交与 waiting 基线是否可由上层重新计算计划；false 时必须暴露结构化冲突。 */
  readonly canReplanWorkspaceChange: boolean;
}

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
  | {
      readonly outcome: "external_effect_unknown";
      readonly effect: "pause" | "connect" | "create" | "materialize";
      readonly requestAutomaticRetry: false;
    };

export interface WaitingRecoveryClaim {
  readonly checkpoint: WaitingRecoveryCheckpoint;
  readonly claimToken: string;
}

/** PostgreSQL 实现必须用唯一键 + CAS 保证同一 checkpoint 只有一个恢复者。 */
export interface WaitingRecoveryStorePort {
  claim(input: {
    readonly scope: ExecutionScope;
    readonly checkpointId: string;
    readonly workerId: string;
  }): Promise<
    | { readonly outcome: "claimed"; readonly claim: WaitingRecoveryClaim }
    | { readonly outcome: "busy" | "resolved" | "not_found" }
  >;
  resolve(input: {
    readonly claim: WaitingRecoveryClaim;
    readonly decision: WaitingRecoveryDecision;
    /** 与 Agent event / Runtime Rollout 共用的确定事实；UNKNOWN 不伪造该事件。 */
    readonly sandboxFact?: SandboxRecoveryFact;
  }): Promise<"resolved" | "already_resolved" | "claim_lost">;
}

export type WaitingRecoveryCoordinatorResult =
  | { readonly outcome: "busy" | "resolved" | "not_found" | "claim_lost" }
  | { readonly outcome: "decided"; readonly decision: WaitingRecoveryDecision };

/**
 * 窄编排只负责 PG 恢复权和确定事实落库。真正的 connect/create/materialize 由后续 Saga
 * 在事实提交之后执行；因此进程崩溃后不会依赖本地变量判断副作用是否发生。
 */
export async function coordinateWaitingRecovery(input: {
  readonly store: WaitingRecoveryStorePort;
  readonly scope: ExecutionScope;
  readonly checkpointId: string;
  readonly workerId: string;
  readonly observation: WaitingRecoveryObservation;
}): Promise<WaitingRecoveryCoordinatorResult> {
  const claimed = await input.store.claim(input);
  if (claimed.outcome !== "claimed") return { outcome: claimed.outcome };
  const decision = decideWaitingRecovery(claimed.claim.checkpoint, input.observation);
  const sandboxFact = decision.outcome === "resume" ? decision.sandbox : undefined;
  const resolved = await input.store.resolve({
    claim: claimed.claim,
    decision,
    ...(sandboxFact === undefined ? {} : { sandboxFact }),
  });
  return resolved === "resolved"
    ? { outcome: "decided", decision }
    : { outcome: resolved === "already_resolved" ? "resolved" : "claim_lost" };
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
  const workspaceChanged = checkpoint.workspaceHeadAtWait !== observation.currentWorkspaceHead;
  if (workspaceChanged && !observation.canReplanWorkspaceChange) {
    return {
      outcome: "workspace_conflict",
      ...(checkpoint.workspaceHeadAtWait === undefined
        ? {}
        : { expectedHead: checkpoint.workspaceHeadAtWait }),
      ...(observation.currentWorkspaceHead === undefined
        ? {}
        : { actualHead: observation.currentWorkspaceHead }),
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

function assertCheckpoint(checkpoint: WaitingRecoveryCheckpoint): void {
  if (!checkpoint.checkpointId.trim()) throw new TypeError("waiting checkpointId 不能为空");
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
