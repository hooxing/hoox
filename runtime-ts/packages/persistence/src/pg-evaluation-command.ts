import { resourceId, resourceVersionId, runId, tenantId, threadId, userId } from "@hoox/domain";
import type { EvaluationCase } from "@hoox/protocol";
import { appendAttachmentsToLatestUserPrompt } from "@hoox/resource";
import { PersistenceError } from "./errors.js";
import { setLocalEvaluationRole } from "./evaluation-role.js";
import { createRevisionRun } from "./pg-playground.js";
import { findFile } from "./pg-resource-filesystem.js";
import { inputDigest } from "./pg-run-dispatch.js";
import { SkillSnapshotUnavailableError } from "./pg-skill-runtime.js";
import {
  cancelThreadQueuedRun,
  enqueueThreadFollowUp,
  lockThreadExecutionHead,
} from "./pg-thread-run-queue.js";
import { type Pool, withTenantTransaction } from "./postgres.js";

export interface EvaluationCommand {
  readonly batchId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly token: string;
  readonly generation: string;
  readonly plannedRunId: string;
}
export type EvaluationCommandResult =
  | "active"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_started"
  | "unavailable"
  | "stale";

export class PgEvaluationCommand {
  constructor(private readonly pool: Pool) {}
  async execute(command: EvaluationCommand): Promise<EvaluationCommandResult> {
    const scope = { tenantId: tenantId(command.tenantId), userId: userId(command.userId) };
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        await setLocalEvaluationRole(client);
        // 丢响应和换代可重放同一命令；锁和预留的 Run ID 跨所有 API 实例生效。
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `evaluation:${command.plannedRunId}`,
        ]);
        await client.query(
          "SELECT set_config('app.evaluation_token',$1,true),set_config('app.evaluation_generation',$2,true),set_config('app.evaluation_batch',$3,true)",
          [command.token, command.generation, command.batchId],
        );
        const {
          rows: [job],
        } = await client.query<{
          planned_run_id: string;
          definition_id: string;
          revision_id: string;
          case_snapshot: EvaluationCase | null;
          cancel_requested_at: Date | null;
          evaluation_run_id: string;
          member_active: boolean;
          account_active: boolean;
          actor_active: boolean;
        }>(
          `SELECT * FROM evaluation_run_command
            WHERE planned_run_id=$1 AND evaluation_run_id=$2`,
          [command.plannedRunId, command.batchId],
        );
        if (!job) return "stale";
        const id = job.planned_run_id;
        const {
          rows: [existing],
        } = await client.query<{ status: string }>(
          "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2 AND thread_id=$2 AND origin='evaluation'",
          [scope.tenantId, id],
        );
        if (
          existing?.status === "succeeded" ||
          existing?.status === "failed" ||
          existing?.status === "cancelled"
        )
          return existing.status;
        const executorActive = job.member_active && job.account_active && job.actor_active;
        if (job.cancel_requested_at !== null || !executorActive) {
          if (!existing) return job.cancel_requested_at === null ? "unavailable" : "not_started";
          const thread = await client.query(
            "SELECT 1 FROM threads WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [scope.tenantId, id],
          );
          if (!thread.rowCount) throw new Error("评测取消需要重试");
          await lockThreadExecutionHead(client, scope.tenantId, id);
          const cancelled = await client.query(
            `UPDATE runs target
                SET status='cancelled',updated_at=clock_timestamp(),version=version+1
              WHERE target.tenant_id=$1 AND target.id=$2 AND target.thread_id=$2
                AND target.origin='evaluation'
                AND target.status NOT IN ('succeeded','failed','cancelled')
                AND EXISTS (
                  SELECT 1 FROM evaluation_run_command current_command
                   WHERE current_command.planned_run_id=target.id
                     AND current_command.evaluation_run_id=$3
                     AND (current_command.cancel_requested_at IS NOT NULL
                       OR NOT current_command.member_active
                       OR NOT current_command.account_active
                       OR NOT current_command.actor_active)
                ) RETURNING target.id`,
            [scope.tenantId, id, command.batchId],
          );
          if (!cancelled.rowCount) {
            const latest = await client.query<{ status: string }>(
              "SELECT status FROM runs WHERE tenant_id=$1 AND id=$2 AND thread_id=$2 AND origin='evaluation'",
              [scope.tenantId, id],
            );
            if (latest.rows[0]?.status !== "cancelled") throw new Error("评测取消需要重试");
          } else {
            await cancelThreadQueuedRun(client, {
              tenantId: scope.tenantId,
              threadId: threadId(id),
              runId: runId(id),
            });
          }
          return "cancelled";
        }
        if (existing) return "active";
        if (!executorActive || !job.case_snapshot) return "unavailable";
        const files = [];
        for (const ref of job.case_snapshot.attachments) {
          const ids =
            ref.kind === "resource"
              ? ref
              : (
                  await client.query<{ resourceId: string; versionId: string }>(
                    `SELECT p.resource_id AS "resourceId",p.resource_version_id AS "versionId" FROM artifact_publications p JOIN artifact_publication_settlements s ON s.tenant_id=p.tenant_id AND s.artifact_id=p.id AND s.target='published' WHERE p.tenant_id=$1 AND p.id=$2`,
                    [scope.tenantId, ref.artifactId],
                  )
                ).rows[0];
          const file =
            ids &&
            (await findFile(client, {
              tenantId: scope.tenantId,
              resourceId: resourceId(ids.resourceId),
              versionId: resourceVersionId(ids.versionId),
            }));
          if (!file) return "unavailable";
          files.push(file);
        }
        const message = appendAttachmentsToLatestUserPrompt(job.case_snapshot.inputText, files);
        await createRevisionRun(client, {
          ...scope,
          threadId: id,
          runId: id,
          definitionId: job.definition_id,
          revisionId: job.revision_id,
          origin: "evaluation",
        });
        const digest = inputDigest(message);
        await enqueueThreadFollowUp(client, {
          ...scope,
          threadId: id,
          runId: id,
          clientRequestId: id,
          inputText: message,
          inputDigest: digest,
          requestDigest: digest,
        });
        return "active";
      });
    } catch (error) {
      if (
        (error instanceof PersistenceError && error.code === "AGENT_REVISION_UNAVAILABLE") ||
        error instanceof SkillSnapshotUnavailableError
      )
        return "unavailable";
      throw error;
    }
  }
}
