import type {
  EvaluationCaseResult,
  EvaluationComparison,
  EvaluationRunDetail,
  EvaluationRunSummary,
  EvaluationSuite,
} from "@hoox/protocol";
import type { Pool, PoolClient } from "./postgres.js";
import { PersistenceError } from "./errors.js";
import { withTransaction } from "./postgres.js";

async function authorized(client: PoolClient, actorUserId: string): Promise<boolean> {
  await client.query("SELECT set_config('app.user_id',$1,true)", [actorUserId]);
  const result = await client.query<{ role: string }>(
    `SELECT actor.role FROM platform_control_operators actor
      WHERE actor.user_id=$1 AND actor.status='active' AND actor.role IN ('admin','operator')`,
    [actorUserId],
  );
  if (!result.rowCount) throw new PersistenceError("CONSTRAINT_VIOLATION", "评测管理权限不足");
  return result.rows[0]?.role === "admin";
}

export class PgEvaluationRepository {
  constructor(private readonly pool: Pool) {}

  async listSuites(actorUserId: string, definitionId: string): Promise<readonly EvaluationSuite[]> {
    return withTransaction(this.pool, async (client) => {
      const contentAccess = await authorized(client, actorUserId);
      const result = await client.query<{ suite: EvaluationSuite }>(
        `SELECT jsonb_strip_nulls(jsonb_build_object(
           'id',suite.id,'definitionId',suite.definition_id,'name',suite.name,
           'description',suite.description,
           'reviewerModel',suite.reviewer_model,
           'reviewerRubric',suite.reviewer_rubric,
           'cases',COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'id',test_case.id,'name',test_case.name,'inputText',CASE WHEN $2 THEN test_case.input_text ELSE '' END,
             'attachments',CASE WHEN $2 THEN test_case.attachments ELSE '[]'::jsonb END,'assertions',test_case.assertions
           ) ORDER BY test_case.created_at,test_case.id) FROM admin_evaluation_case_projection test_case
             WHERE test_case.suite_id=suite.id),'[]'::jsonb)
         )) AS suite FROM agent_evaluation_suites suite
          WHERE suite.definition_id=$1 ORDER BY suite.created_at,suite.id`,
        [definitionId, contentAccess],
      );
      return result.rows.map((row) => ({ ...row.suite, contentAccess }));
    });
  }

  async saveSuite(actorUserId: string, suite: EvaluationSuite): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const contentAccess = await authorized(client, actorUserId);
      await client.query(
        `INSERT INTO agent_evaluation_suites(id,definition_id,name,description,reviewer_model,reviewer_rubric,created_by)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,
           reviewer_model=EXCLUDED.reviewer_model,reviewer_rubric=EXCLUDED.reviewer_rubric,content_version=agent_evaluation_suites.content_version+1,updated_at=clock_timestamp()
         WHERE agent_evaluation_suites.definition_id=EXCLUDED.definition_id`,
        [
          suite.id,
          suite.definitionId,
          suite.name,
          suite.description,
          suite.reviewerModel === undefined ? null : JSON.stringify(suite.reviewerModel),
          suite.reviewerRubric ?? null,
          actorUserId,
        ],
      );
      const exists = await client.query(
        "SELECT 1 FROM agent_evaluation_suites WHERE id=$1 AND definition_id=$2 FOR UPDATE",
        [suite.id, suite.definitionId],
      );
      if (!exists.rowCount)
        throw new PersistenceError("CONSTRAINT_VIOLATION", "评测集不属于指定 Agent");
      const caseIds = suite.cases.map((item) => item.id);
      await client.query(
        "DELETE FROM agent_evaluation_cases WHERE suite_id=$1 AND NOT(id=ANY($2::text[]))",
        [suite.id, caseIds],
      );
      for (const item of suite.cases) {
        await client.query(
          contentAccess
            ? `INSERT INTO agent_evaluation_cases(id,suite_id,name,input_text,attachments,assertions)
                 VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)
                 ON CONFLICT(id) DO UPDATE SET name=$3,input_text=$4,
                   attachments=$5::jsonb,assertions=$6::jsonb,updated_at=clock_timestamp()
                 WHERE agent_evaluation_cases.suite_id=$2`
            : `INSERT INTO agent_evaluation_cases(id,suite_id,name,input_text,attachments,assertions)
                 VALUES($1,$2,$3,'','[]'::jsonb,$4::jsonb)
                 ON CONFLICT(id) DO UPDATE SET name=$3,assertions=$4::jsonb,
                   updated_at=clock_timestamp()
                 WHERE agent_evaluation_cases.suite_id=$2`,
          contentAccess
            ? [
                item.id,
                suite.id,
                item.name,
                item.inputText,
                JSON.stringify(item.attachments),
                JSON.stringify(item.assertions),
              ]
            : [item.id, suite.id, item.name, JSON.stringify(item.assertions)],
        );
      }
    });
  }

  async deleteSuite(actorUserId: string, definitionId: string, suiteId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      await authorized(client, actorUserId);
      const result = await client.query(
        "DELETE FROM agent_evaluation_suites WHERE id=$1 AND definition_id=$2",
        [suiteId, definitionId],
      );
      return Boolean(result.rowCount);
    });
  }

  async startRun(
    actorUserId: string,
    input: {
      readonly id: string;
      readonly definitionId: string;
      readonly suiteId: string;
      readonly revisionId: string;
      readonly maxConcurrency: number;
    },
  ): Promise<EvaluationRunSummary | undefined> {
    return withTransaction(this.pool, async (client) => {
      if (!(await authorized(client, actorUserId)))
        throw new PersistenceError("CONSTRAINT_VIOLATION", "执行评测需要正文权限");
      const executor = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM admin_evaluation_executor_scope WHERE user_id=$1",
        [actorUserId],
      );
      const tenantId = executor.rows[0]?.tenant_id;
      if (!tenantId) throw new PersistenceError("CONSTRAINT_VIOLATION", "评测执行空间不可用");
      const lockedSuite = await client.query(
        "SELECT id FROM agent_evaluation_suites WHERE id=$1 AND definition_id=$2 FOR SHARE",
        [input.suiteId, input.definitionId],
      );
      if (!lockedSuite.rowCount) return undefined;
      const target = await client.query<{
        definition_id: string;
        content_version: string;
        total_cases: number;
      }>(
        `SELECT suite.definition_id,suite.content_version,count(test_case.id)::int AS total_cases
           FROM agent_evaluation_suites suite
           JOIN agent_revisions revision ON revision.definition_id=suite.definition_id
             AND revision.id=$3 AND revision.status IN ('draft','published')
           LEFT JOIN admin_evaluation_case_projection test_case ON test_case.suite_id=suite.id
          WHERE suite.id=$1 AND suite.definition_id=$2
          GROUP BY suite.definition_id,suite.content_version`,
        [input.suiteId, input.definitionId, input.revisionId],
      );
      const row = target.rows[0];
      if (!row) throw new PersistenceError("CONSTRAINT_VIOLATION", "评测集或目标 Revision 不存在");
      const inserted = await client.query(
        `INSERT INTO agent_evaluation_runs(
           id,definition_id,suite_id,suite_version,revision_id,tenant_id,status,max_concurrency,total_cases,created_by,finished_at
         ) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $8::integer=0 THEN 'completed' ELSE 'queued' END,$7,$8,$9,CASE WHEN $8=0 THEN clock_timestamp() END)`,
        [
          input.id,
          row.definition_id,
          input.suiteId,
          row.content_version,
          input.revisionId,
          tenantId,
          input.maxConcurrency,
          row.total_cases,
          actorUserId,
        ],
      );
      if (!inserted.rowCount) throw new TypeError("评测运行未写入");
      await client.query(
        `INSERT INTO agent_evaluation_case_jobs(
           evaluation_run_id,suite_id,case_id,status,tenant_id,case_snapshot,case_name,assertions_snapshot
         ) SELECT $1,$2,id,'queued',$3,
                  jsonb_build_object('id',id,'name',name,'inputText',input_text,'attachments',attachments,'assertions',assertions),
                  name,assertions
             FROM admin_evaluation_case_projection WHERE suite_id=$2`,
        [input.id, input.suiteId, tenantId],
      );
      const result = await client.query(
        `SELECT id,definition_id,suite_id,revision_id,status,max_concurrency,total_cases,
                passed_cases,failed_cases,unknown_cases,created_at
           FROM agent_evaluation_runs WHERE id=$1`,
        [input.id],
      );
      return this.mapRun(result.rows[0], 0);
    });
  }

  async listRuns(
    actorUserId: string,
    definitionId: string,
  ): Promise<readonly EvaluationRunSummary[]> {
    return withTransaction(this.pool, async (client) => {
      await authorized(client, actorUserId);
      const result = await client.query(
        `SELECT run.id,run.definition_id,run.suite_id,run.revision_id,run.status,
                run.max_concurrency,run.total_cases,run.passed_cases,run.failed_cases,
                run.unknown_cases,run.created_at,
                count(*) FILTER (WHERE job.status='cancelled')::int AS cancelled_cases
           FROM agent_evaluation_runs run
           LEFT JOIN agent_evaluation_case_jobs job ON job.evaluation_run_id=run.id
          WHERE run.definition_id=$1
          GROUP BY run.id ORDER BY run.created_at DESC,run.id DESC LIMIT 200`,
        [definitionId],
      );
      return result.rows.map((row) => this.mapRun(row, Number(row.cancelled_cases)));
    });
  }

  async readRun(actorUserId: string, runId: string): Promise<EvaluationRunDetail | undefined> {
    return withTransaction(this.pool, async (client) => {
      await authorized(client, actorUserId);
      const runQuery = await client.query(
        `SELECT run.id,run.definition_id,run.suite_id,run.revision_id,run.status,
                run.max_concurrency,run.total_cases,run.passed_cases,run.failed_cases,
                run.unknown_cases,run.created_at,
                count(*) FILTER (WHERE job.status='cancelled')::int AS cancelled_cases
           FROM agent_evaluation_runs run
           LEFT JOIN agent_evaluation_case_jobs job ON job.evaluation_run_id=run.id
          WHERE run.id=$1 GROUP BY run.id`,
        [runId],
      );
      const rawRun = runQuery.rows[0];
      if (!rawRun) return undefined;
      const results = await client.query(
        `SELECT job.case_id,job.case_name,
                COALESCE(result.outcome,job.status) AS outcome,
                job.run_id,job.tenant_id,result.assertion_results,
                result.score,result.reason
           FROM agent_evaluation_case_jobs job
           LEFT JOIN agent_evaluation_results result
             ON result.evaluation_run_id=job.evaluation_run_id AND result.case_id=job.case_id
          WHERE job.evaluation_run_id=$1 ORDER BY job.case_id`,
        [runId],
      );
      return {
        run: this.mapRun(rawRun, Number(rawRun.cancelled_cases)),
        results: results.rows.map((row) => ({
          caseId: String(row.case_id),
          caseName: String(row.case_name),
          outcome: normalizeCaseOutcome(String(row.outcome)),
          ...(row.run_id == null
            ? {}
            : { runId: String(row.run_id), tenantId: String(row.tenant_id) }),
          assertionResults: Array.isArray(row.assertion_results) ? row.assertion_results : [],
          ...(row.score == null ? {} : { score: Number(row.score) }),
          ...(row.reason == null ? {} : { reason: String(row.reason) }),
        })) as EvaluationCaseResult[],
      };
    });
  }

  async cancelRun(actorUserId: string, runId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      await authorized(client, actorUserId);
      const result = await client.query(
        `UPDATE agent_evaluation_runs SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp())
          WHERE id=$1 AND status IN ('queued','running') RETURNING status`,
        [runId],
      );
      if (!result.rowCount) return false;
      await client.query(
        `UPDATE agent_evaluation_case_jobs SET status='cancelled',claim_token=NULL,lease_until=NULL,
                updated_at=clock_timestamp()
          WHERE evaluation_run_id=$1 AND status='queued'`,
        [runId],
      );
      await refreshEvaluationBatch(client, runId);
      return true;
    });
  }

  async compareRuns(
    actorUserId: string,
    leftRunId: string,
    rightRunId: string,
  ): Promise<EvaluationComparison | undefined> {
    const [left, right] = await Promise.all([
      this.readRun(actorUserId, leftRunId),
      this.readRun(actorUserId, rightRunId),
    ]);
    if (!left || !right || left.run.suiteId !== right.run.suiteId) return undefined;
    const leftByCase = new Map(left.results.map((item) => [item.caseId, item]));
    const rightByCase = new Map(right.results.map((item) => [item.caseId, item]));
    const caseIds = [...new Set([...leftByCase.keys(), ...rightByCase.keys()])].sort();
    return {
      suiteId: left.run.suiteId,
      left: left.run,
      right: right.run,
      leftPassRate: left.run.passRate,
      rightPassRate: right.run.passRate,
      cases: caseIds.map((caseId) => {
        const leftResult = leftByCase.get(caseId);
        const rightResult = rightByCase.get(caseId);
        return {
          caseId,
          caseName: leftResult?.caseName ?? rightResult?.caseName ?? caseId,
          ...(leftResult === undefined ? {} : { leftOutcome: leftResult.outcome }),
          ...(rightResult === undefined ? {} : { rightOutcome: rightResult.outcome }),
          changed: leftResult?.outcome !== rightResult?.outcome,
        };
      }),
    };
  }

  private mapRun(row: Record<string, unknown>, cancelledCases: number): EvaluationRunSummary {
    if (!row) throw new TypeError("评测运行不存在");
    const createdAt =
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    return {
      id: String(row.id),
      definitionId: String(row.definition_id),
      suiteId: String(row.suite_id),
      revisionId: String(row.revision_id),
      status: row.status as EvaluationRunSummary["status"],
      maxConcurrency: Number(row.max_concurrency),
      totalCases: Number(row.total_cases),
      passRate:
        Number(row.total_cases) === 0 ? 0 : Number(row.passed_cases) / Number(row.total_cases),
      passedCases: Number(row.passed_cases),
      failedCases: Number(row.failed_cases),
      unknownCases: Number(row.unknown_cases),
      cancelledCases,
      createdAt,
    };
  }
}

function normalizeCaseOutcome(value: string): EvaluationCaseResult["outcome"] {
  switch (value) {
    case "starting":
      return "running";
    case "passed":
    case "failed":
    case "unknown":
    case "cancelled":
    case "running":
    case "queued":
      return value;
    default:
      throw new TypeError("评测结果状态无效");
  }
}

export async function refreshEvaluationBatch(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE agent_evaluation_runs b SET passed_cases=s.passed,failed_cases=s.failed,unknown_cases=s.unknown,
   status=CASE WHEN s.pending>0 THEN 'running' WHEN b.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'completed' END,
   finished_at=CASE WHEN s.pending=0 THEN clock_timestamp() END,
   cancelled_at=CASE WHEN s.pending=0 THEN b.cancel_requested_at END
   FROM (SELECT count(*) FILTER(WHERE status='completed') AS passed,count(*) FILTER(WHERE status='failed') AS failed,
   count(*) FILTER(WHERE status='unknown') AS unknown,count(*) FILTER(WHERE status IN ('queued','starting','running')) AS pending
   FROM agent_evaluation_case_jobs WHERE evaluation_run_id=$1) s WHERE b.id=$1`,
    [id],
  );
}
