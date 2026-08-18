import { createHash, randomUUID } from "node:crypto";
import {
  nextScheduledRunAt,
  normalizeRrule,
  normalizeRunAt,
  normalizeScheduledTaskInstruction,
  normalizeScheduledTaskName,
  normalizeTimeZone,
  type ScheduledTask,
  type ScheduledTaskManagementPort,
  type ScheduledTaskMutation,
  type ScheduledTaskMutationResult,
} from "@aisay/automation";
import {
  createRun,
  isoTimestamp,
  runId,
  tenantId as domainTenantId,
  threadId,
  userId,
} from "@aisay/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import { PgCoreRepositories } from "./pg-core-repositories.js";
import { PgThreadInputRouting, type PgThreadInputRoutingOptions } from "./pg-thread-input.js";
import { scheduleWorkerTenantAt, wakeWorkerTenant } from "./pg-worker-tenant-assignment.js";
import { withTenantTransaction } from "./postgres.js";

interface ScheduledTaskRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly owner_user_id: string;
  readonly source_thread_id: string;
  readonly target_thread_id: string;
  readonly name: string;
  readonly instruction: string;
  readonly timezone: string;
  readonly rrule: string | null;
  readonly status: ScheduledTask["status"];
  readonly overlap_policy: ScheduledTask["overlapPolicy"];
  readonly next_run_at: Date | string | null;
  readonly last_run_at: Date | string | null;
  readonly current_revision: number | string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function taskFromRow(row: ScheduledTaskRow): ScheduledTask {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    ownerUserId: row.owner_user_id,
    sourceThreadId: row.source_thread_id,
    targetThreadId: row.target_thread_id,
    name: row.name,
    instruction: row.instruction,
    timezone: row.timezone,
    ...(row.rrule === null ? {} : { rrule: row.rrule }),
    status: row.status,
    overlapPolicy: row.overlap_policy,
    ...(row.next_run_at === null ? {} : { nextRunAt: timestamp(row.next_run_at) }),
    ...(row.last_run_at === null ? {} : { lastRunAt: timestamp(row.last_run_at) }),
    currentRevision: Number(row.current_revision),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function digestMutation(mutation: ScheduledTaskMutation): string {
  return createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
}

function validDigest(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("定时任务请求摘要无效");
  return value;
}

function delayDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("定时任务执行时间无效");
  return parsed;
}

async function verifyActorAndThreads(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly threadIds: readonly string[];
  },
): Promise<boolean> {
  const membership = await client.query<{ readonly status: string }>(
    `SELECT status FROM memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`,
    [input.tenantId, input.userId],
  );
  if (membership.rows[0]?.status !== "active") return false;
  const unique = [...new Set(input.threadIds)];
  const threads = await client.query<{ readonly id: string; readonly status: string }>(
    `SELECT id,status FROM threads WHERE tenant_id=$1 AND id=ANY($2::text[]) FOR SHARE`,
    [input.tenantId, unique],
  );
  return threads.rowCount === unique.length && threads.rows.every((row) => row.status === "active");
}

export class PgScheduledTaskRepository implements ScheduledTaskManagementPort {
  constructor(private readonly pool: Pool) {}

  async list(
    input: Parameters<ScheduledTaskManagementPort["list"]>[0],
  ): Promise<readonly ScheduledTask[]> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const rows = await client.query<ScheduledTaskRow>(
            `SELECT * FROM scheduled_tasks
            WHERE tenant_id=$1 AND owner_user_id=$2 AND status<>'deleted'
            ORDER BY updated_at DESC,id`,
            [input.scope.tenantId, input.scope.userId],
          );
          return Object.freeze(rows.rows.map(taskFromRow));
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取定时任务");
    }
  }

  async mutate(
    input: Parameters<ScheduledTaskManagementPort["mutate"]>[0],
  ): Promise<ScheduledTaskMutationResult> {
    const requestDigest = validDigest(input.requestDigest);
    if (requestDigest !== digestMutation(input.mutation))
      throw new TypeError("定时任务请求摘要不匹配");
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [
          `${input.scope.tenantId}\u001f${input.scope.userId}\u001fautomation\u001f${input.commandId}`,
        ]);
        const replay = await client.query<{
          readonly request_digest: string;
          readonly response: ScheduledTask;
        }>(
          `SELECT request_digest,response FROM scheduled_task_commands
            WHERE tenant_id=$1 AND actor_user_id=$2 AND command_id=$3`,
          [input.scope.tenantId, input.scope.userId, input.commandId],
        );
        if (replay.rows[0] !== undefined) {
          return replay.rows[0].request_digest === requestDigest
            ? { outcome: "replayed", task: Object.freeze(replay.rows[0].response) }
            : { outcome: "key_conflict" };
        }
        const mutation = input.mutation;
        const result =
          mutation.action === "create"
            ? await this.create(client, { ...input, mutation })
            : await this.update(client, { ...input, mutation });
        if (result.outcome !== "applied") return result;
        await client.query(
          `INSERT INTO scheduled_task_commands(
             tenant_id,actor_user_id,command_id,request_digest,task_id,response
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [
            input.scope.tenantId,
            input.scope.userId,
            input.commandId,
            requestDigest,
            result.task.id,
            JSON.stringify(result.task),
          ],
        );
        return result;
      });
    } catch (error) {
      throw mapPersistenceError(error, "更新定时任务");
    }
  }

  async mutateFromRun(input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly commandId: string;
    readonly mutation: ScheduledTaskMutation;
  }): Promise<ScheduledTaskMutationResult> {
    const actor = await withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      async (client) => {
        const row = await client.query<{ readonly created_by_user_id: string }>(
          `SELECT thread.created_by_user_id
             FROM threads thread
             JOIN runs run ON run.tenant_id=thread.tenant_id AND run.thread_id=thread.id
            WHERE thread.tenant_id=$1 AND thread.id=$2 AND run.id=$3
              AND thread.status='active' AND run.status='running'`,
          [input.tenantId, input.threadId, input.runId],
        );
        return row.rows[0]?.created_by_user_id;
      },
      { readOnly: true },
    );
    if (actor === undefined) return { outcome: "not_authorized" };
    return this.mutate({
      scope: { tenantId: input.tenantId, userId: actor },
      commandId: input.commandId,
      requestDigest: digestMutation(input.mutation),
      mutation: input.mutation,
      createdByRunId: input.runId,
    });
  }
  private async create(
    client: PoolClient,
    input: Parameters<ScheduledTaskManagementPort["mutate"]>[0] & {
      readonly mutation: Extract<ScheduledTaskMutation, { readonly action: "create" }>;
    },
  ): Promise<ScheduledTaskMutationResult> {
    if (
      !(await verifyActorAndThreads(client, {
        tenantId: input.scope.tenantId,
        userId: input.scope.userId,
        threadIds: [input.mutation.sourceThreadId, input.mutation.targetThreadId],
      }))
    )
      return { outcome: "not_authorized" };
    const taskId = `automation-${randomUUID()}`;
    const name = normalizeScheduledTaskName(input.mutation.name);
    const instruction = normalizeScheduledTaskInstruction(input.mutation.instruction);
    const timezone = normalizeTimeZone(input.mutation.timezone);
    const firstRunAt = normalizeRunAt(input.mutation.firstRunAt);
    const rrule = normalizeRrule(input.mutation.rrule);
    const overlapPolicy = input.mutation.overlapPolicy ?? "coalesce";
    await client.query(
      `INSERT INTO scheduled_tasks(
         tenant_id,id,owner_user_id,source_thread_id,target_thread_id,name,instruction,
         timezone,rrule,status,overlap_policy,next_run_at,current_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,1)`,
      [
        input.scope.tenantId,
        taskId,
        input.scope.userId,
        input.mutation.sourceThreadId,
        input.mutation.targetThreadId,
        name,
        instruction,
        timezone,
        rrule ?? null,
        overlapPolicy,
        firstRunAt,
      ],
    );
    await client.query(
      `INSERT INTO scheduled_task_revisions(
         tenant_id,task_id,revision,name,instruction,timezone,rrule,first_run_at,
         overlap_policy,created_by_run_id
       ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.scope.tenantId,
        taskId,
        name,
        instruction,
        timezone,
        rrule ?? null,
        firstRunAt,
        overlapPolicy,
        input.createdByRunId ?? null,
      ],
    );
    await scheduleWorkerTenantAt(client, input.scope.tenantId, delayDate(firstRunAt));
    return {
      outcome: "applied",
      task: await this.requireTask(client, input.scope.tenantId, taskId),
    };
  }

  private async update(
    client: PoolClient,
    input: Parameters<ScheduledTaskManagementPort["mutate"]>[0] & {
      readonly mutation: Exclude<ScheduledTaskMutation, { readonly action: "create" }>;
    },
  ): Promise<ScheduledTaskMutationResult> {
    const selected = await client.query<ScheduledTaskRow>(
      `SELECT * FROM scheduled_tasks WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [input.scope.tenantId, input.mutation.taskId],
    );
    const currentRow = selected.rows[0];
    if (currentRow === undefined || currentRow.status === "deleted")
      return { outcome: "not_found" };
    if (currentRow.owner_user_id !== input.scope.userId) return { outcome: "not_authorized" };
    if (
      !(await verifyActorAndThreads(client, {
        tenantId: input.scope.tenantId,
        userId: input.scope.userId,
        threadIds: [currentRow.source_thread_id, currentRow.target_thread_id],
      }))
    )
      return { outcome: "not_authorized" };
    if (input.mutation.action === "pause") {
      if (currentRow.status !== "active") return { outcome: "invalid_state" };
      await client.query(
        `UPDATE scheduled_tasks SET status='paused',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
        [input.scope.tenantId, currentRow.id],
      );
    } else if (input.mutation.action === "resume") {
      if (currentRow.status !== "paused") return { outcome: "invalid_state" };
      await client.query(
        `UPDATE scheduled_tasks SET status='active',next_run_at=GREATEST(COALESCE(next_run_at,clock_timestamp()),clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
        [input.scope.tenantId, currentRow.id],
      );
      await wakeWorkerTenant(client, input.scope.tenantId);
    } else if (input.mutation.action === "delete") {
      await client.query(
        `UPDATE scheduled_tasks SET status='deleted',next_run_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
        [input.scope.tenantId, currentRow.id],
      );
    } else {
      const name =
        input.mutation.name === undefined
          ? currentRow.name
          : normalizeScheduledTaskName(input.mutation.name);
      const instruction =
        input.mutation.instruction === undefined
          ? currentRow.instruction
          : normalizeScheduledTaskInstruction(input.mutation.instruction);
      const timezone =
        input.mutation.timezone === undefined
          ? currentRow.timezone
          : normalizeTimeZone(input.mutation.timezone);
      const rrule =
        input.mutation.rrule === undefined
          ? (currentRow.rrule ?? undefined)
          : input.mutation.rrule === null
            ? undefined
            : normalizeRrule(input.mutation.rrule);
      const nextRunAt =
        input.mutation.firstRunAt === undefined
          ? timestamp(currentRow.next_run_at ?? new Date())
          : normalizeRunAt(input.mutation.firstRunAt);
      const overlapPolicy = input.mutation.overlapPolicy ?? currentRow.overlap_policy;
      const revision = Number(currentRow.current_revision) + 1;
      await client.query(
        `UPDATE scheduled_tasks SET name=$3,instruction=$4,timezone=$5,rrule=$6,
           overlap_policy=$7,next_run_at=$8,current_revision=$9,status='active',updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2`,
        [
          input.scope.tenantId,
          currentRow.id,
          name,
          instruction,
          timezone,
          rrule ?? null,
          overlapPolicy,
          nextRunAt,
          revision,
        ],
      );
      await client.query(
        `INSERT INTO scheduled_task_revisions(
           tenant_id,task_id,revision,name,instruction,timezone,rrule,first_run_at,
           overlap_policy,created_by_run_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          input.scope.tenantId,
          currentRow.id,
          revision,
          name,
          instruction,
          timezone,
          rrule ?? null,
          nextRunAt,
          overlapPolicy,
          input.createdByRunId ?? null,
        ],
      );
      await scheduleWorkerTenantAt(client, input.scope.tenantId, delayDate(nextRunAt));
    }
    return {
      outcome: "applied",
      task: await this.requireTask(client, input.scope.tenantId, currentRow.id),
    };
  }

  private async requireTask(
    client: PoolClient,
    tenantId: string,
    taskId: string,
  ): Promise<ScheduledTask> {
    const row = await client.query<ScheduledTaskRow>(
      `SELECT * FROM scheduled_tasks WHERE tenant_id=$1 AND id=$2`,
      [tenantId, taskId],
    );
    if (row.rows[0] === undefined) throw new TypeError("定时任务提交后不可见");
    return taskFromRow(row.rows[0]);
  }
}

interface ClaimedOccurrence {
  readonly tenantId: string;
  readonly occurrenceId: string;
  readonly taskId: string;
  readonly revision: number;
  readonly ownerUserId: string;
  readonly targetThreadId: string;
  readonly name: string;
  readonly instruction: string;
  readonly scheduledFor: string;
}

export function scheduledTaskInputText(input: {
  readonly name: string;
  readonly instruction: string;
}): string {
  return [
    "[定时任务触发]",
    `任务名称：${input.name}`,
    "请执行以下指令，并在结果中说明本次实际完成内容：",
    input.instruction,
  ].join("\n");
}

export class PgScheduledTaskDueConsumer {
  private readonly repositories: PgCoreRepositories;
  private readonly routing: PgThreadInputRouting;

  constructor(
    private readonly pool: Pool,
    routingOptions: PgThreadInputRoutingOptions = {},
  ) {
    this.repositories = new PgCoreRepositories(pool);
    this.routing = new PgThreadInputRouting(pool, routingOptions);
  }

  async drainTenant(tenantId: string): Promise<number> {
    const claim = await this.claimDue(tenantId);
    if (claim === undefined) return 0;
    const scope = {
      tenantId: domainTenantId(claim.tenantId),
      userId: userId(claim.ownerUserId),
    } as const;
    try {
      const thread = await this.repositories.threads.get(scope, threadId(claim.targetThreadId));
      if (thread === undefined || thread.entity.status !== "active") {
        await this.fail(claim, "TARGET_THREAD_UNAVAILABLE", false);
        return 1;
      }
      const fallbackRun = createRun({
        id: runId(`run-${randomUUID()}`),
        thread: thread.entity,
        now: isoTimestamp(new Date().toISOString()),
      });
      const inputText = scheduledTaskInputText({
        name: claim.name,
        instruction: claim.instruction,
      });
      const requestHash = createHash("sha256")
        .update(JSON.stringify([claim.taskId, claim.occurrenceId, inputText]))
        .digest("hex");
      const result = await this.routing.submit({
        scope,
        thread: thread.entity,
        fallbackRun,
        inputText,
        attachments: [],
        mode: "follow_up",
        fallbackToFollowUp: true,
        idempotency: { key: `automation.${claim.occurrenceId}`, requestHash },
      });
      if (result.outcome !== "accepted" && result.outcome !== "replayed") {
        await this.fail(claim, result.outcome, result.outcome === "key_conflict");
        return 1;
      }
      await withTenantTransaction(this.pool, { tenantId: claim.tenantId }, async (client) => {
        await client.query(
          `UPDATE scheduled_task_occurrences SET state='enqueued',run_id=$3,receipt_id=$4,
             failure_code=NULL,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2 AND state IN ('dispatching','failed')`,
          [
            claim.tenantId,
            claim.occurrenceId,
            result.receipt.queuedRunId ?? result.receipt.targetRunId ?? null,
            result.receipt.receiptId,
          ],
        );
        await wakeWorkerTenant(client, claim.tenantId);
      });
      return 1;
    } catch {
      await this.fail(claim, "DEPENDENCY_UNAVAILABLE", false);
      return 1;
    }
  }

  private async claimDue(tenantId: string): Promise<ClaimedOccurrence | undefined> {
    return withTenantTransaction(this.pool, { tenantId }, async (client) => {
      const retry = await client.query<{
        readonly occurrence_id: string;
        readonly task_id: string;
        readonly task_revision: number | string;
        readonly scheduled_for: Date | string;
        readonly dispatch_attempts: number | string;
        readonly owner_user_id: string;
        readonly target_thread_id: string;
        readonly name: string;
        readonly instruction: string;
      }>(
        `SELECT occurrence.id AS occurrence_id,occurrence.task_id,occurrence.task_revision,
                occurrence.scheduled_for,occurrence.dispatch_attempts,task.owner_user_id,
                task.target_thread_id,revision.name,revision.instruction
           FROM scheduled_task_occurrences occurrence
           JOIN scheduled_tasks task ON task.tenant_id=occurrence.tenant_id AND task.id=occurrence.task_id
           JOIN scheduled_task_revisions revision
             ON revision.tenant_id=occurrence.tenant_id AND revision.task_id=occurrence.task_id
            AND revision.revision=occurrence.task_revision
          WHERE occurrence.tenant_id=$1
            AND (
              (occurrence.state='failed' AND occurrence.next_attempt_at<=clock_timestamp())
              OR (occurrence.state='dispatching' AND occurrence.updated_at<=clock_timestamp()-interval '5 minutes')
            )
            AND task.status<>'deleted'
          ORDER BY occurrence.next_attempt_at,occurrence.created_at
          LIMIT 1 FOR UPDATE OF occurrence SKIP LOCKED`,
        [tenantId],
      );
      const retryRow = retry.rows[0];
      if (retryRow !== undefined) {
        const attempts = Number(retryRow.dispatch_attempts) + 1;
        if (attempts > 5) {
          await client.query(
            `UPDATE scheduled_task_occurrences SET state='skipped',failure_code='RETRY_EXHAUSTED',updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND id=$2`,
            [tenantId, retryRow.occurrence_id],
          );
          await client.query(
            `UPDATE scheduled_tasks SET status='paused',updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND id=$2 AND status='active'`,
            [tenantId, retryRow.task_id],
          );
          return undefined;
        }
        await client.query(
          `UPDATE scheduled_task_occurrences SET state='dispatching',dispatch_attempts=$3,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND id=$2`,
          [tenantId, retryRow.occurrence_id, attempts],
        );
        return Object.freeze({
          tenantId,
          occurrenceId: retryRow.occurrence_id,
          taskId: retryRow.task_id,
          revision: Number(retryRow.task_revision),
          ownerUserId: retryRow.owner_user_id,
          targetThreadId: retryRow.target_thread_id,
          name: retryRow.name,
          instruction: retryRow.instruction,
          scheduledFor: timestamp(retryRow.scheduled_for),
        });
      }
      const pending = await client.query<ScheduledTaskRow>(
        `SELECT * FROM scheduled_tasks
          WHERE tenant_id=$1 AND status='active' AND next_run_at<=clock_timestamp()
          ORDER BY next_run_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [tenantId],
      );
      const task = pending.rows[0];
      if (task === undefined) return undefined;
      const scheduledFor = timestamp(task.next_run_at ?? new Date());
      const occurrenceId = `occurrence-${randomUUID()}`;
      const inserted = await client.query<{ readonly id: string }>(
        `INSERT INTO scheduled_task_occurrences(
           tenant_id,id,task_id,task_revision,scheduled_for,state,dispatch_attempts
         ) VALUES ($1,$2,$3,$4,$5,'dispatching',1)
         ON CONFLICT (tenant_id,task_id,scheduled_for) DO NOTHING
         RETURNING id`,
        [tenantId, occurrenceId, task.id, Number(task.current_revision), scheduledFor],
      );
      const nextRunAt = nextScheduledRunAt(scheduledFor, task.rrule ?? undefined);
      await client.query(
        `UPDATE scheduled_tasks SET status=$3,next_run_at=$4,last_run_at=$5,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`,
        [
          tenantId,
          task.id,
          nextRunAt === undefined ? "completed" : "active",
          nextRunAt ?? null,
          scheduledFor,
        ],
      );
      if (nextRunAt !== undefined)
        await scheduleWorkerTenantAt(client, tenantId, new Date(nextRunAt));
      if (inserted.rowCount !== 1) return undefined;
      return Object.freeze({
        tenantId,
        occurrenceId,
        taskId: task.id,
        revision: Number(task.current_revision),
        ownerUserId: task.owner_user_id,
        targetThreadId: task.target_thread_id,
        name: task.name,
        instruction: task.instruction,
        scheduledFor,
      });
    });
  }

  private async fail(claim: ClaimedOccurrence, code: string, terminal: boolean): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: claim.tenantId }, async (client) => {
      await client.query(
        `UPDATE scheduled_task_occurrences SET state='failed',failure_code=$3,
           next_attempt_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2`,
        [claim.tenantId, claim.occurrenceId, code],
      );
      if (terminal) {
        await client.query(
          `UPDATE scheduled_tasks SET status='paused',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
          [claim.tenantId, claim.taskId],
        );
      } else {
        await scheduleWorkerTenantAt(client, claim.tenantId, new Date(Date.now() + 60_000));
      }
    });
  }
}
