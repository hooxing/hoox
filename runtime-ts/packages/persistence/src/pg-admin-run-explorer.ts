import {
  type ControlOperatorRole,
  RUN_EXPLORER_ORIGINS,
  RUN_EXPLORER_STATUSES,
  type RunExplorerAttempt,
  type RunExplorerEventRow,
  type RunExplorerOrigin,
  type RunExplorerRepository,
  type RunExplorerRunRecord,
  type RunExplorerStatus,
  type RunExplorerSummary,
} from "@hoox/admin-control";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTransaction } from "./postgres.js";
import { mapRunFeedback, type RunFeedbackRow } from "./pg-run-feedback.js";

interface DirectoryRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly thread_title: string;
  readonly user_input: string | null;
  readonly user_email: string | null;
  readonly user_display_name: string | null;
  readonly agent_display_name: string | null;
  readonly status: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly agent_definition_id: string | null;
  readonly agent_revision_id: string | null;
  readonly origin: string | null;
  readonly attempt_count: string;
  readonly attempts: unknown;
  readonly latest_attempt_id: string | null;
  readonly latest_attempt_status: string | null;
  readonly latest_attempt_started_at: Date | string | null;
  readonly latest_attempt_finished_at: Date | string | null;
  readonly model_calls: string;
  readonly input_tokens: string;
  readonly output_tokens: string;
  readonly cache_read_tokens: string;
  readonly generation_duration_ms: string;
  readonly tool_calls: string;
  readonly failed_tool_calls: string;
  readonly error_count: string;
}

interface EventRow extends QueryResultRow {
  readonly attempt_id: string;
  readonly sequence: string;
  readonly kind: string;
  readonly occurred_at: Date | string;
  readonly payload: unknown;
}

const directoryColumns = `tenant_id,run_id,thread_id,status,created_at,updated_at,
  thread_title,user_input,user_email,user_display_name,agent_display_name,
  agent_definition_id,agent_revision_id,origin,attempt_count::text,attempts,
  latest_attempt_id,latest_attempt_status,latest_attempt_started_at,latest_attempt_finished_at,
  model_calls::text,input_tokens,output_tokens,cache_read_tokens,generation_duration_ms,
  tool_calls::text,failed_tool_calls::text,error_count::text`;

const terminalStatuses = new Set<RunExplorerStatus>(["succeeded", "failed", "cancelled"]);

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function count(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} 无效`);
  return parsed;
}

function nonnegative(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} 无效`);
  return parsed;
}

function mapAttempts(value: unknown): readonly RunExplorerAttempt[] {
  if (!Array.isArray(value)) throw new Error("Run Attempt 投影损坏");
  return Object.freeze(
    value.map((item: unknown) => {
      const attempt = item as Readonly<Record<string, unknown>>;
      if (
        typeof attempt.attemptId !== "string" ||
        typeof attempt.status !== "string" ||
        typeof attempt.stage !== "string" ||
        typeof attempt.createdAt !== "string"
      ) {
        throw new Error("Run Attempt 投影损坏");
      }
      return Object.freeze({
        attemptId: attempt.attemptId,
        status: attempt.status,
        stage: attempt.stage,
        createdAt: timestamp(attempt.createdAt),
        ...(typeof attempt.finishedAt === "string"
          ? { finishedAt: timestamp(attempt.finishedAt) }
          : {}),
      });
    }),
  );
}

function mapRun(row: DirectoryRow): RunExplorerRunRecord {
  if (!RUN_EXPLORER_STATUSES.includes(row.status as RunExplorerStatus))
    throw new Error("Run 状态投影损坏");
  const status = row.status as RunExplorerStatus;
  const origin =
    row.origin !== null && RUN_EXPLORER_ORIGINS.includes(row.origin as RunExplorerOrigin)
      ? (row.origin as RunExplorerOrigin)
      : null;
  const createdAt = timestamp(row.created_at);
  const finishedAt =
    terminalStatuses.has(status) && row.latest_attempt_finished_at !== null
      ? timestamp(row.latest_attempt_finished_at)
      : undefined;
  return Object.freeze({
    tenantId: row.tenant_id,
    runId: row.run_id,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
    ...(row.user_input === null ? {} : { userInput: row.user_input }),
    ...(row.user_email === null ? {} : { userEmail: row.user_email }),
    ...(row.user_display_name === null ? {} : { userDisplayName: row.user_display_name }),
    ...(row.agent_display_name === null ? {} : { agentDisplayName: row.agent_display_name }),
    status,
    createdAt,
    updatedAt: timestamp(row.updated_at),
    agentDefinitionId: row.agent_definition_id,
    agentRevisionId: row.agent_revision_id,
    origin,
    attemptCount: count(row.attempt_count, "Attempt 数"),
    attempts: mapAttempts(row.attempts),
    ...(row.latest_attempt_id === null ? {} : { latestAttemptId: row.latest_attempt_id }),
    ...(row.latest_attempt_status === null
      ? {}
      : { latestAttemptStatus: row.latest_attempt_status }),
    ...(row.latest_attempt_started_at === null
      ? {}
      : { startedAt: timestamp(row.latest_attempt_started_at) }),
    ...(finishedAt === undefined
      ? {}
      : {
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(createdAt)),
        }),
    modelCalls: count(row.model_calls, "模型调用数"),
    toolCalls: count(row.tool_calls, "工具调用数"),
    failedToolCalls: count(row.failed_tool_calls, "失败工具调用数"),
    errorCount: count(row.error_count, "错误数"),
    usage: Object.freeze({
      inputTokens: count(row.input_tokens, "输入 Token"),
      outputTokens: count(row.output_tokens, "输出 Token"),
      cacheReadTokens: count(row.cache_read_tokens, "缓存读取 Token"),
      generationDurationMs: nonnegative(row.generation_duration_ms, "模型生成时长"),
    }),
  });
}

function summary(run: RunExplorerRunRecord): RunExplorerSummary {
  const { attempts: _attempts, ...rest } = run;
  return Object.freeze(rest);
}

function mapEvent(row: EventRow): RunExplorerEventRow {
  return Object.freeze({
    attemptId: row.attempt_id,
    sequence: count(row.sequence, "事件序号"),
    kind: row.kind,
    occurredAt: timestamp(row.occurred_at),
    payload: row.payload,
  });
}

/**
 * Admin Control 角色只读 Migrator 持有的 Run 受限视图；底表、Thread 标题与输入均不可读。
 * 每个事务都设置 app.user_id，视图与 RLS 据此确认有效控制面身份。
 */
export class PgAdminRunExplorerRepository implements RunExplorerRepository {
  constructor(private readonly pool: Pool) {}

  async resolveRole(userId: string): Promise<ControlOperatorRole | undefined> {
    return await this.read(userId, "解析后台控制面角色", async (client) => {
      const result = await client.query<{ readonly role: ControlOperatorRole }>(
        "SELECT role FROM platform_control_operators WHERE user_id=$1 AND status='active'",
        [userId],
      );
      return result.rows[0]?.role;
    });
  }

  async listRuns(
    input: Parameters<RunExplorerRepository["listRuns"]>[0],
  ): Promise<readonly RunExplorerSummary[]> {
    const operation = async (client: PoolClient) => {
      const result = await client.query<DirectoryRow>(
        `SELECT ${directoryColumns}
           FROM admin_run_directory
          WHERE ($1::text IS NULL OR tenant_id=$1)
            AND ($2::text IS NULL OR status=$2)
            AND ($3::timestamptz IS NULL OR created_at>=$3)
            AND ($4::timestamptz IS NULL OR created_at<=$4)
            AND ($5::text IS NULL OR agent_definition_id=$5)
            AND ($6::text IS NULL OR agent_revision_id=$6)
            AND ($7::text IS NULL OR origin=$7)
            AND ($8::text IS NULL OR thread_title ILIKE '%'||$8||'%' OR user_input ILIKE '%'||$8||'%')
            AND ($9::timestamptz IS NULL
                 OR (created_at,tenant_id,run_id) < ($9::timestamptz,$10::text,$11::text))
          ORDER BY created_at DESC,tenant_id DESC,run_id DESC
          LIMIT $12`,
        [
          input.tenantId ?? null,
          input.status ?? null,
          input.createdFrom ?? null,
          input.createdTo ?? null,
          input.agentDefinitionId ?? null,
          input.agentRevisionId ?? null,
          input.origin ?? null,
          input.search ?? null,
          input.after?.createdAt ?? null,
          input.after?.tenantId ?? null,
          input.after?.runId ?? null,
          input.limit,
        ],
      );
      if (input.audit !== undefined) {
        await client.query(
          `INSERT INTO admin_run_content_access_audits(audit_id,actor_user_id,tenant_id,run_id,attempt_id,query_summary,returned_run_count)
           VALUES($1,$2,'*','*',NULL,$3::jsonb,$4)`,
          [
            input.audit.auditId,
            input.actorUserId,
            JSON.stringify(input.audit.querySummary),
            Math.min(result.rows.length, input.limit - 1),
          ],
        );
      }
      return Object.freeze(result.rows.map((row) => summary(mapRun(row))));
    };
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query("SELECT set_config('app.user_id',$1,true)", [input.actorUserId]);
        return operation(client);
      });
    } catch (error) {
      throw mapPersistenceError(error, "读取 Run 列表");
    }
  }

  async getRun(
    input: Parameters<RunExplorerRepository["getRun"]>[0],
  ): Promise<RunExplorerRunRecord | undefined> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query("SELECT set_config('app.user_id',$1,true)", [input.actorUserId]);
        const result = await client.query<DirectoryRow>(
          `SELECT ${directoryColumns} FROM admin_run_directory WHERE tenant_id=$1 AND run_id=$2`,
          [input.tenantId, input.runId],
        );
        const row = result.rows[0];
        if (row !== undefined && input.inputAuditId !== undefined) {
          await client.query(
            `INSERT INTO admin_run_content_access_audits(audit_id,actor_user_id,tenant_id,run_id,attempt_id,query_summary,returned_run_count)
             VALUES($1,$2,$3,$4,NULL,'{"type":"run_detail_input"}'::jsonb,1)`,
            [input.inputAuditId, input.actorUserId, input.tenantId, input.runId],
          );
          await client.query("SELECT set_config('app.run_content_audit_id',$1,true)", [
            input.inputAuditId,
          ]);
          const feedback = await client.query<RunFeedbackRow>(
            `SELECT run_id,revision_id,user_id,rating,comment,created_at,updated_at
             FROM admin_run_feedback_content WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,user_id`,
            [input.tenantId, input.runId],
          );
          return { ...mapRun(row), feedback: feedback.rows.map(mapRunFeedback) };
        }
        return row === undefined ? undefined : mapRun(row);
      });
    } catch (error) {
      throw mapPersistenceError(error, "读取 Run 摘要");
    }
  }

  async readOutline(
    input: Parameters<RunExplorerRepository["readOutline"]>[0],
  ): Promise<readonly RunExplorerEventRow[]> {
    return await this.read(input.actorUserId, "读取 Run 结构事件", async (client) => {
      const result = await client.query<EventRow>(
        `SELECT attempt_id,sequence::text,kind,occurred_at,payload
           FROM admin_run_event_outline
          WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3
          ORDER BY sequence`,
        [input.tenantId, input.runId, input.attemptId],
      );
      return Object.freeze(result.rows.map(mapEvent));
    });
  }

  async readContent(
    input: Parameters<RunExplorerRepository["readContent"]>[0],
  ): Promise<readonly RunExplorerEventRow[]> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query("SELECT set_config('app.user_id',$1,true)", [input.actorUserId]);
        // 审计与正文读取在同一事务：审计写入被 RLS 拒绝（非有效 admin）时整个读取失败；
        // 正文视图只认本事务写入、且号码与 app.run_content_audit_id 一致的审计。
        await client.query(
          `INSERT INTO admin_run_content_access_audits(
             audit_id,actor_user_id,tenant_id,run_id,attempt_id
           ) VALUES($1,$2,$3,$4,$5)`,
          [input.auditId, input.actorUserId, input.tenantId, input.runId, input.attemptId],
        );
        await client.query("SELECT set_config('app.run_content_audit_id',$1,true)", [
          input.auditId,
        ]);
        const result = await client.query<EventRow>(
          `SELECT attempt_id,sequence::text,kind,occurred_at,payload
             FROM admin_run_event_content
            WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3
            ORDER BY sequence`,
          [input.tenantId, input.runId, input.attemptId],
        );
        return Object.freeze(result.rows.map(mapEvent));
      });
    } catch (error) {
      throw mapPersistenceError(error, "读取 Run 正文");
    }
  }

  private async read<T>(
    userId: string,
    action: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withTransaction(
        this.pool,
        async (client) => {
          await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
          return await operation(client);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, action);
    }
  }
}
