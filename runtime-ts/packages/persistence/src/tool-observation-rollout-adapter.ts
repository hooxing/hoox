import type {
  ToolObservationBinding,
  ToolObservationRolloutPort,
} from "@cube-runtime/context-policy";
import { sha256Digest } from "@cube-runtime/domain";
import { PersistenceError } from "./errors.js";
import type { RolloutEntryDraft } from "./pg-runtime-rollout.js";
import type { PgRuntimeRolloutRepository, TrustedRolloutContext } from "./pg-runtime-rollout.js";

const OBSERVATION_REPLAY_DELAYS_MS = Object.freeze([0, 25, 100, 250]);

/**
 * 将 Observation 核心的窄端口接到 PostgreSQL Rollout 事实源。它不接受调用方自造
 * trace identity；PgRuntimeRolloutRepository 会在同一租户事务中再次验证 stable/trace 引用。
 */
export class PgToolObservationRolloutAdapter implements ToolObservationRolloutPort {
  constructor(
    private readonly repository: Pick<PgRuntimeRolloutRepository, "append">,
    private readonly context: TrustedRolloutContext,
  ) {}

  async appendToolCall(
    input: Parameters<ToolObservationRolloutPort["appendToolCall"]>[0],
  ): Promise<Awaited<ReturnType<ToolObservationRolloutPort["appendToolCall"]>>> {
    if (!sameBinding(input.binding, this.context)) return { outcome: "conflict" };
    return this.append(input.idempotencyKey, {
      kind: "tool_call",
      toolCallId: input.toolCallId,
      body: Object.freeze({ toolName: input.toolName }),
    });
  }

  async appendToolResult(
    input: Parameters<ToolObservationRolloutPort["appendToolResult"]>[0],
  ): Promise<Awaited<ReturnType<ToolObservationRolloutPort["appendToolResult"]>>> {
    if (!sameBinding(input.binding, this.context)) return { outcome: "conflict" };
    const draft: RolloutEntryDraft = {
      kind: "tool_result",
      toolCallId: input.toolCallId,
      body: input.body,
      isTruncated: input.isTruncated,
      blob: { ...input.blob, sha256: sha256Digest(input.blob.sha256) },
    };
    return this.append(input.idempotencyKey, draft);
  }

  private async append(
    idempotencyKey: string,
    draft: RolloutEntryDraft,
  ): Promise<Awaited<ReturnType<ToolObservationRolloutPort["appendToolResult"]>>> {
    // 克隆后递归冻结，避免第一次请求等待/UNKNOWN 期间调用方改写嵌套 body，确保重放逐字同义。
    const frozenDraft = deepFreeze(structuredClone(draft));
    const command = Object.freeze({
      context: this.context,
      idempotencyKey,
      entries: Object.freeze([frozenDraft]),
    });
    let result: Awaited<ReturnType<PgRuntimeRolloutRepository["append"]>> | undefined;
    for (const [attempt, delayMs] of OBSERVATION_REPLAY_DELAYS_MS.entries()) {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      try {
        // 首次 committed-but-unknown 后必须用完全相同的幂等键与正文读回收敛，不能另造结果。
        result = await this.repository.append(command);
        break;
      } catch (error) {
        if (
          error instanceof PersistenceError &&
          (error.code === "CONFLICT" || error.code === "CONSTRAINT_VIOLATION")
        )
          return { outcome: "conflict" };
        if (attempt === OBSERVATION_REPLAY_DELAYS_MS.length - 1) return { outcome: "unknown" };
      }
    }
    if (result === undefined) return { outcome: "unknown" };
    switch (result.outcome) {
      case "created":
      case "replayed":
      case "conflict":
        return { outcome: result.outcome };
      case "not_authorized":
      case "not_found":
        // 授权/所有权失效不能伪装成可恢复成功。
        return { outcome: "conflict" };
      default:
        return { outcome: "unavailable" };
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameBinding(binding: ToolObservationBinding, context: TrustedRolloutContext): boolean {
  const scope = context.scope;
  return (
    binding.tenantId === scope.tenantId &&
    binding.threadId === scope.threadId &&
    binding.runId === scope.runId &&
    binding.rootRunId === context.fence.scope.rootRunId &&
    binding.workspaceId === context.fence.scope.workspaceId &&
    binding.baseRevisionId === context.fence.scope.baseRevisionId &&
    binding.attemptId === scope.attemptId &&
    binding.agentThreadId === scope.agentThreadId &&
    binding.runClaimToken === context.fence.runClaim.token &&
    binding.runClaimEpoch === context.fence.runClaim.epoch &&
    binding.workspaceLeaseRootRunId === context.fence.workspaceLease.rootRunId &&
    binding.workspaceLeaseEpoch === context.fence.workspaceLease.epoch
  );
}
