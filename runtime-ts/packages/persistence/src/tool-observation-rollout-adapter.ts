import type { ToolObservationRolloutPort } from "@cube-runtime/context-policy";
import { sha256Digest } from "@cube-runtime/domain";
import type { RolloutEntryDraft } from "./pg-runtime-rollout.js";
import type { PgRuntimeRolloutRepository, TrustedRolloutContext } from "./pg-runtime-rollout.js";

/**
 * 将 Observation 核心的窄端口接到 PostgreSQL Rollout 事实源。它不接受调用方自造
 * trace identity；PgRuntimeRolloutRepository 会在同一租户事务中再次验证 stable/trace 引用。
 */
export class PgToolObservationRolloutAdapter implements ToolObservationRolloutPort {
  constructor(
    private readonly repository: Pick<PgRuntimeRolloutRepository, "append">,
    private readonly context: TrustedRolloutContext,
  ) {}

  async appendToolResult(
    input: Parameters<ToolObservationRolloutPort["appendToolResult"]>[0],
  ): Promise<Awaited<ReturnType<ToolObservationRolloutPort["appendToolResult"]>>> {
    const draft: RolloutEntryDraft = {
      kind: "tool_result",
      toolCallId: input.toolCallId,
      body: input.body,
      isTruncated: input.isTruncated,
      blob: { ...input.blob, sha256: sha256Digest(input.blob.sha256) },
    };
    const result = await this.repository.append({
      context: this.context,
      idempotencyKey: input.idempotencyKey,
      entries: [draft],
    });
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
