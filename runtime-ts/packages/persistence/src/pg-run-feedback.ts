import type { Pool, QueryResultRow } from "pg";
import type { TenantScope } from "./ports.js";
import { withTenantTransaction } from "./postgres.js";

export interface RunFeedback {
  readonly runId: string;
  readonly revisionId: string;
  readonly userId: string;
  readonly rating: "up" | "down";
  readonly comment?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunFeedbackRow extends QueryResultRow {
  run_id: string;
  revision_id: string;
  user_id: string;
  rating: "up" | "down";
  comment: string | null;
  created_at: Date;
  updated_at: Date;
}

export function mapRunFeedback(row: RunFeedbackRow): RunFeedback {
  return {
    runId: row.run_id,
    revisionId: row.revision_id,
    userId: row.user_id,
    rating: row.rating,
    ...(row.comment === null ? {} : { comment: row.comment }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PgRunFeedbackRepository {
  constructor(private readonly pool: Pool) {}

  async execute(input: {
    readonly scope: TenantScope;
    readonly threadId: string;
    readonly runId: string;
    readonly operation: "get" | "put" | "delete";
    readonly feedback?: { readonly rating: "up" | "down"; readonly comment?: string };
  }): Promise<{ readonly feedback: RunFeedback | null } | "not_found" | "bad_request"> {
    const { scope, threadId, runId, operation, feedback } = input;
    if (
      operation === "put" &&
      (feedback === undefined ||
        !["up", "down"].includes(feedback.rating) ||
        (feedback.comment !== undefined &&
          (Array.from(feedback.comment).length > 2000 ||
            feedback.comment.includes("\0") ||
            !feedback.comment.isWellFormed())))
    )
      return "bad_request";
    return withTenantTransaction(this.pool, scope, async (client) => {
      const visible = await client.query<{ revision_id: string }>(
        `SELECT snapshot.revision_id FROM runs r
         JOIN threads t ON t.tenant_id=r.tenant_id AND t.id=r.thread_id
         JOIN run_agent_snapshots snapshot ON snapshot.tenant_id=r.tenant_id AND snapshot.run_id=r.id
         JOIN memberships m ON m.tenant_id=r.tenant_id AND m.user_id=$4 AND m.status='active'
         WHERE r.tenant_id=$1 AND r.id=$2 AND r.thread_id=$3
           AND t.created_by_user_id=$4
           AND r.origin IN ('normal','api') AND NOT t.is_playground`,
        [scope.tenantId, runId, threadId, scope.userId],
      );
      const revision = visible.rows[0];
      if (revision === undefined) return "not_found";
      const keys = [scope.tenantId, runId, scope.userId];
      if (operation === "delete") {
        await client.query(
          "DELETE FROM run_feedback WHERE tenant_id=$1 AND run_id=$2 AND user_id=$3",
          keys,
        );
        return { feedback: null };
      }
      if (operation === "put" && feedback !== undefined) {
        const result = await client.query<RunFeedbackRow>(
          `INSERT INTO run_feedback(tenant_id,run_id,user_id,revision_id,rating,comment)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id,run_id,user_id) DO UPDATE SET
             rating=EXCLUDED.rating,comment=EXCLUDED.comment,
             updated_at=CASE WHEN (run_feedback.rating,run_feedback.comment) IS DISTINCT FROM (EXCLUDED.rating,EXCLUDED.comment)
               THEN clock_timestamp() ELSE run_feedback.updated_at END
           RETURNING *`,
          [...keys, revision.revision_id, feedback.rating, feedback.comment ?? null],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("反馈写入未返回记录");
        return { feedback: mapRunFeedback(row) };
      }
      const result = await client.query<RunFeedbackRow>(
        "SELECT * FROM run_feedback WHERE tenant_id=$1 AND run_id=$2 AND user_id=$3",
        keys,
      );
      return { feedback: result.rows[0] === undefined ? null : mapRunFeedback(result.rows[0]) };
    });
  }
}
