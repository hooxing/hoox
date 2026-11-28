import type { ToolObservationBinding, ToolObservationRolloutPort } from "@hoox/context-policy";
import { sha256Digest } from "@hoox/domain";
import { PersistenceError } from "./errors.js";
import type {
  PgRuntimeRolloutRepository,
  RolloutEntryDraft,
  TrustedRolloutContext,
} from "./pg-runtime-rollout.js";

const OBSERVATION_REPLAY_DELAYS_MS = Object.freeze([0, 25, 100, 250]);

/**
 * 将 Observation 核心的窄端口接到 PostgreSQL Rollout 事实源。它不接受调用方自造
 * trace identity；PgRuntimeRolloutRepository 会在同一租户事务中再次验证 stable/trace 引用。
 */
export class PgToolObservationRolloutAdapter implements ToolObservationRolloutPort {
  constructor(
    private readonly repository: Pick<PgRuntimeRolloutRepository, "append"> &
      Partial<Pick<PgRuntimeRolloutRepository, "appendPtcToolCall" | "appendPtcToolResult">>,
    private readonly context: TrustedRolloutContext,
  ) {}

  async appendToolCall(
    input: Parameters<ToolObservationRolloutPort["appendToolCall"]>[0],
  ): Promise<Awaited<ReturnType<ToolObservationRolloutPort["appendToolCall"]>>> {
    if (!sameBinding(input.binding, this.context)) return { outcome: "conflict" };
    return this.append(
      input.idempotencyKey,
      {
        kind: "tool_call",
        toolCallId: input.toolCallId,
        body: Object.freeze({ toolName: input.toolName }),
      },
      input.parentToolCallId,
    );
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
      ...(input.blob === undefined
        ? {}
        : { blob: { ...input.blob, sha256: sha256Digest(input.blob.sha256) } }),
    };
    return this.append(input.idempotencyKey, draft, input.parentToolCallId);
  }

  private async append(
    idempotencyKey: string,
    draft: RolloutEntryDraft,
    parentToolCallId?: string,
  ): Promise<Awaited<ReturnType<ToolObservationRolloutPort["appendToolResult"]>>> {
    // 克隆后递归冻结，避免第一次请求等待/UNKNOWN 期间调用方改写嵌套 body，确保重放逐字同义。
    const frozenDraft = deepFreeze(structuredClone(draft));
    // 有父调用时只能写独立 journal；旧版 repository 缺失该能力也不能退回模型历史。
    const ptcAppend =
      parentToolCallId === undefined
        ? undefined
        : draft.kind === "tool_call"
          ? this.repository.appendPtcToolCall
          : this.repository.appendPtcToolResult;
    if (parentToolCallId !== undefined && ptcAppend === undefined)
      return { outcome: "unavailable" };
    const command = Object.freeze({
      context: this.context,
      idempotencyKey,
      entries: Object.freeze([frozenDraft]),
    });
    const ptcCommand = Object.freeze({
      context: this.context,
      idempotencyKey,
      toolCallId: frozenDraft.toolCallId ?? "",
      parentToolCallId: parentToolCallId ?? "",
      toolName: frozenDraft.body.toolName as string,
      body: frozenDraft.body,
      isTruncated: frozenDraft.isTruncated ?? false,
      ...(frozenDraft.blob === undefined ? {} : { blob: frozenDraft.blob }),
    });
    let result: { readonly outcome: string } | undefined;
    let previousResponseUnknown = false;
    for (const [attempt, delayMs] of OBSERVATION_REPLAY_DELAYS_MS.entries()) {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      try {
        // 首次 committed-but-unknown 后必须用完全相同的幂等键与正文读回收敛，不能另造结果。
        if (parentToolCallId === undefined) {
          result = await this.repository.append(command);
        } else if (draft.kind === "tool_call") {
          const appendPtcToolCall = this.repository.appendPtcToolCall;
          if (appendPtcToolCall === undefined) return { outcome: "unavailable" };
          result = await appendPtcToolCall.call(this.repository, ptcCommand);
        } else {
          const appendPtcToolResult = this.repository.appendPtcToolResult;
          if (appendPtcToolResult === undefined) return { outcome: "unavailable" };
          result = await appendPtcToolResult.call(this.repository, ptcCommand);
        }
        break;
      } catch (error) {
        if (
          error instanceof PersistenceError &&
          (error.code === "CONFLICT" || error.code === "CONSTRAINT_VIOLATION")
        )
          return { outcome: "conflict" };
        previousResponseUnknown = true;
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
        // 已知提交响应未知时，拒绝读回不证明首次写入未提交；交由恢复流程核对。
        return previousResponseUnknown ? { outcome: "unknown" } : { outcome: "conflict" };
      case "parent_closed":
        // 开始事实已核实，但父程序已结束，不能把重放结果当作子工具 dispatch 许可。
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
