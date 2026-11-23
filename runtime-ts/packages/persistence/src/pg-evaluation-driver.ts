import { randomUUID } from "node:crypto";
import { evaluateAssertion, type EvaluationEvidence } from "@hoox/admin-control";
import type { EvaluationCase, EvaluationCaseResult } from "@hoox/protocol";
import { refreshEvaluationBatch } from "./pg-evaluation.js";
import type { EvaluationCommand, EvaluationCommandResult } from "./pg-evaluation-command.js";
import { type Pool, type PoolClient, withTransaction } from "./postgres.js";

type Lease = EvaluationCommand & {
  batchId: string;
  caseId: string;
  assertions: EvaluationCase["assertions"];
};
type Settlement = Pick<EvaluationCaseResult, "outcome" | "reason"> & {
  assertionResults: ReadonlyArray<{ passed: boolean; reason: string }>;
};
async function bind(client: PoolClient, batch: string, actor: string) {
  await client.query(
    "SELECT set_config('app.evaluation_batch',$1,true),set_config('app.user_id',$2,true)",
    [batch, actor],
  );
}
export class PgEvaluationDriver {
  constructor(
    private readonly pool: Pool,
    private readonly command: (input: EvaluationCommand) => Promise<EvaluationCommandResult>,
    private readonly readEvidence: (
      user: string,
      tenant: string,
      run: string,
    ) => Promise<EvaluationEvidence>,
    private readonly options: { globalLimit: number; leaseMs: number; pollMs: number },
  ) {
    for (const value of Object.values(options))
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("评测调度参数无效");
  }
  async claim(): Promise<Lease | undefined> {
    return withTransaction(this.pool, async (client) => {
      // 数据库计数和占位同锁提交；过期的 starting/running 仍占并发槽，只允许接管。
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':evaluation-admission',0))",
      );
      const candidates = await client.query<{
        batch_id: string;
        case_id: string;
        created_by: string;
      }>(
        `WITH slots AS (
           SELECT q.*, count(*) FILTER (WHERE status <> 'queued') OVER () AS active,
                  count(*) FILTER (WHERE status <> 'queued') OVER (PARTITION BY batch_id) AS batch_active
             FROM admin_evaluation_queue q
         ) SELECT batch_id,case_id,created_by FROM slots
            WHERE (lease_until IS NULL OR lease_until <= statement_timestamp())
              AND (next_poll_at <= statement_timestamp() OR cancel_requested_at IS NOT NULL)
              AND (status <> 'queued' OR (active < $1 AND batch_active < max_concurrency AND cancel_requested_at IS NULL))
            ORDER BY updated_at,batch_id,case_id LIMIT 32`,
        [this.options.globalLimit],
      );
      for (const { batch_id: batchId, case_id: caseId, created_by: userId } of candidates.rows) {
        await bind(client, batchId, userId);
        const batch = await client.query(
          `SELECT 1 FROM agent_evaluation_runs WHERE id=$1 AND status IN ('queued','running') FOR UPDATE SKIP LOCKED`,
          [batchId],
        );
        if (!batch.rowCount) continue;
        const token = randomUUID();
        const job = (
          await client.query<{
            planned_run_id: string;
            generation: string;
            assertions: EvaluationCase["assertions"];
            tenant_id: string;
          }>(
            `WITH picked AS (
             SELECT case_id FROM agent_evaluation_case_jobs
              WHERE evaluation_run_id=$1 AND case_id=$2 AND status IN ('queued','starting','running')
                AND (lease_until IS NULL OR lease_until<=clock_timestamp()) FOR UPDATE SKIP LOCKED
           ) UPDATE agent_evaluation_case_jobs j
                SET status=CASE WHEN status='queued' THEN 'starting' ELSE status END,
                    claim_token=$3,generation=generation+1,updated_at=clock_timestamp(),
                    lease_until=clock_timestamp()+$4*interval '1 millisecond'
               FROM picked WHERE evaluation_run_id=$1 AND j.case_id=picked.case_id
          RETURNING j.planned_run_id,j.generation::text,j.assertions_snapshot AS assertions,j.tenant_id`,
            [batchId, caseId, token, this.options.leaseMs],
          )
        ).rows[0];
        if (!job) continue;
        await client.query("UPDATE agent_evaluation_runs SET status='running' WHERE id=$1", [
          batchId,
        ]);
        return {
          batchId,
          caseId,
          token,
          userId,
          tenantId: job.tenant_id,
          generation: job.generation,
          plannedRunId: job.planned_run_id,
          assertions: job.assertions,
        };
      }
      return undefined;
    });
  }
  async process(lease: Lease): Promise<void> {
    const { token, userId, tenantId, generation, plannedRunId } = lease;
    const status = await this.command({
      batchId: lease.batchId,
      token,
      userId,
      tenantId,
      generation,
      plannedRunId,
    });
    if (status === "stale") return;
    const hasRun = status !== "not_started" && status !== "unavailable";
    let result: Settlement | undefined;
    if (status === "succeeded") {
      try {
        const evidence = await this.readEvidence(userId, tenantId, plannedRunId);
        const assertionResults = [];
        for (const assertion of lease.assertions) {
          if (assertion.kind !== "model_score")
            assertionResults.push(await evaluateAssertion(assertion, evidence));
        }
        result =
          assertionResults.length !== lease.assertions.length
            ? { outcome: "unknown", assertionResults, reason: "模型评审未启用" }
            : {
                outcome: assertionResults.every((r) => r.passed) ? "passed" : "failed",
                assertionResults,
              };
      } catch {
        result = { outcome: "unknown", assertionResults: [], reason: "正文取证或断言计算失败" };
      }
    } else if (status !== "active") {
      result = {
        outcome:
          status === "failed" ? "failed" : status === "unavailable" ? "unknown" : "cancelled",
        assertionResults: [],
      };
    }
    await withTransaction(this.pool, async (client) => {
      await bind(client, lease.batchId, userId);
      // 先锁批次再 CAS 用例；并行结算不会用旧计数覆盖最后一个用例的汇总。
      await client.query("SELECT id FROM agent_evaluation_runs WHERE id=$1 FOR UPDATE", [
        lease.batchId,
      ]);
      const updated = await client.query(
        `UPDATE agent_evaluation_case_jobs
            SET status=$5,run_id=COALESCE($6,run_id),claim_token=NULL,lease_until=NULL,
                next_poll_at=clock_timestamp()+$7*interval '1 millisecond',updated_at=clock_timestamp()
          WHERE evaluation_run_id=$1 AND case_id=$2 AND claim_token=$3 AND generation=$4
            AND lease_until>clock_timestamp() RETURNING run_id`,
        [
          lease.batchId,
          lease.caseId,
          token,
          generation,
          result?.outcome === "passed" ? "completed" : (result?.outcome ?? "running"),
          hasRun ? plannedRunId : null,
          this.options.pollMs,
        ],
      );
      if (!updated.rowCount) return;
      if (result && updated.rows[0]?.run_id)
        await client.query(
          `INSERT INTO agent_evaluation_results(evaluation_run_id,suite_id,case_id,tenant_id,run_id,outcome,assertion_results,reason) SELECT evaluation_run_id,suite_id,case_id,tenant_id,run_id,$3,$4::jsonb,$5 FROM agent_evaluation_case_jobs WHERE evaluation_run_id=$1 AND case_id=$2`,
          [
            lease.batchId,
            lease.caseId,
            result.outcome,
            JSON.stringify(result.assertionResults),
            result.reason ?? null,
          ],
        );
      if (result) await refreshEvaluationBatch(client, lease.batchId);
    });
  }
  async tick() {
    const lease = await this.claim();
    if (lease) await this.process(lease);
    return !!lease;
  }
}
