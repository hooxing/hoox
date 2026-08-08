import { createHash, randomUUID } from "node:crypto";
import { isoTimestamp, type Run, rehydrateRun } from "@cube-runtime/domain";
import {
  historyFilesystemCollisionName,
  historyFilesystemDirectoryName,
  historyFilesystemEntryCollisionName,
  historyFilesystemEntryName,
  historyFilesystemTimestamp,
} from "@cube-runtime/resource";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import type {
  ThreadInputReceiptView,
  ThreadInputRoutingPort,
  ThreadInputSubmitResult,
} from "./ports.js";
import { TransactionCommitUnknownError, withTenantTransaction } from "./postgres.js";
import { createRunSkillSnapshot, SkillSnapshotUnavailableError } from "./pg-skill-runtime.js";
import {
  enqueuePersonalThreadTitleGeneration,
  pendingHistoryDirectoryName,
} from "./pg-thread-title-generation.js";
import {
  activateNextThreadRun,
  LegacyRunDrainRequiredError,
  lockOrCreateThreadExecutionHead,
} from "./pg-thread-run-queue.js";

const maxInputBytes = 1_048_576;
const attachmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function serializeAttachments(
  attachments: Parameters<ThreadInputRoutingPort["submit"]>[0]["attachments"],
): string {
  if (attachments.length > 20) throw new TypeError("Thread 输入附件数量无效");
  const seen = new Set<string>();
  const value: Record<string, Record<string, number>> = Object.create(null);
  attachments.forEach((attachment, ordinal) => {
    if (
      !attachmentIdPattern.test(attachment.resourceId) ||
      !attachmentIdPattern.test(attachment.versionId)
    ) {
      throw new TypeError("Thread 输入附件身份无效");
    }
    const identity = `${attachment.resourceId}\0${attachment.versionId}`;
    if (seen.has(identity)) throw new TypeError("Thread 输入附件不能重复");
    seen.add(identity);
    const versions = value[attachment.resourceId] ?? Object.create(null);
    versions[attachment.versionId] = ordinal;
    value[attachment.resourceId] = versions;
  });
  return JSON.stringify(value);
}

function safeSequence(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${name} 无效`);
  return parsed;
}

function timestamp(value: unknown) {
  if (value instanceof Date) return isoTimestamp(value.toISOString());
  if (typeof value === "string") return isoTimestamp(new Date(value).toISOString());
  throw new TypeError("数据库时间无效");
}

function bodyDigest(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (value.trim().length === 0 || bytes < 1 || bytes > maxInputBytes) {
    throw new TypeError("Thread 输入 UTF-8 字节数无效");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function restoreRun(row: QueryResultRow, thread: Parameters<typeof rehydrateRun>[1]): Run {
  return rehydrateRun(
    {
      id: String(row.run_id),
      tenantId: String(row.tenant_id),
      threadId: String(row.thread_id),
      status: String(row.run_status),
      createdAt: timestamp(row.run_created_at),
      updatedAt: timestamp(row.run_updated_at),
    },
    thread,
  );
}

type RejectionCode = NonNullable<ThreadInputReceiptView["rejectionCode"]>;

export function decideThreadInputRoute(
  input: Readonly<{
    mode: "auto" | "steer" | "follow_up";
    expectedRunId?: string;
    expectedTurnId?: string;
    fallbackToFollowUp: boolean;
    activeRunId: string | null;
    activeTurnId: string | null;
    activeRunStatus?: string;
    activeAttemptStatus?: string | null;
    activeAttemptStage?: string | null;
  }>,
):
  | { readonly action: "steer" | "queue" }
  | { readonly action: "reject"; readonly rejectionCode: RejectionCode } {
  if (input.mode === "follow_up") return { action: "queue" };
  let mismatch: RejectionCode | undefined;
  if (
    input.mode === "steer" &&
    (input.expectedRunId === undefined || input.expectedTurnId === undefined)
  ) {
    mismatch = "no_active_turn";
  } else if (input.expectedRunId !== undefined && input.expectedRunId !== input.activeRunId) {
    mismatch = "expected_run_mismatch";
  } else if (input.expectedTurnId !== undefined && input.expectedTurnId !== input.activeTurnId) {
    mismatch = "expected_turn_mismatch";
  }
  if (mismatch !== undefined) {
    return input.mode === "steer" && input.fallbackToFollowUp
      ? { action: "queue" }
      : { action: "reject", rejectionCode: mismatch };
  }
  const steerable =
    input.activeRunId !== null &&
    input.activeTurnId !== null &&
    input.activeRunStatus === "running" &&
    input.activeAttemptStatus === "running" &&
    input.activeAttemptStage === "model_execution_started";
  if (steerable) return { action: "steer" };
  if (input.mode === "auto" || input.fallbackToFollowUp) return { action: "queue" };
  return {
    action: "reject",
    rejectionCode:
      input.activeRunId === null || input.activeTurnId === null
        ? "no_active_turn"
        : "unsupported_phase",
  };
}

export interface PgThreadInputRoutingOptions {
  readonly historyDirectoryTimeZone?: string;
  readonly historyFilesystemEnabled?: boolean;
  readonly historyTitleGenerationEnabled?: boolean;
}
/** 阶段 3 的统一输入入口；不实现 waiting resume、compaction 或 Sandbox 复用。 */
export class PgThreadInputRouting implements ThreadInputRoutingPort {
  private readonly historyDirectoryTimeZone: string;
  private readonly historyFilesystemEnabled: boolean;
  private readonly historyTitleGenerationEnabled: boolean;

  constructor(
    private readonly pool: Pool,
    options: PgThreadInputRoutingOptions = {},
  ) {
    this.historyDirectoryTimeZone = options.historyDirectoryTimeZone ?? "Asia/Shanghai";
    this.historyFilesystemEnabled = options.historyFilesystemEnabled ?? false;
    this.historyTitleGenerationEnabled = options.historyTitleGenerationEnabled ?? false;
    if (this.historyTitleGenerationEnabled && !this.historyFilesystemEnabled) {
      throw new TypeError("历史标题生成依赖个人历史文件系统");
    }
    historyFilesystemTimestamp(new Date(0), this.historyDirectoryTimeZone);
  }

  async submit(
    input: Parameters<ThreadInputRoutingPort["submit"]>[0],
  ): Promise<ThreadInputSubmitResult> {
    if (
      input.scope.tenantId !== input.thread.tenantId ||
      input.fallbackRun.tenantId !== input.scope.tenantId ||
      input.fallbackRun.threadId !== input.thread.id
    ) {
      return { outcome: "not_authorized" };
    }
    const digest = bodyDigest(input.inputText);
    const attachmentsJson = serializeAttachments(input.attachments);
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const membership = await client.query<{ readonly status: string }>(
            `SELECT status FROM memberships
              WHERE tenant_id=$1 AND user_id=$2 FOR SHARE`,
            [input.scope.tenantId, input.scope.userId],
          );
          if (membership.rows[0]?.status !== "active") {
            return { outcome: "not_authorized" } as const;
          }
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
            `${input.scope.tenantId}\u001f${input.thread.id}\u001finput\u001f${input.idempotency.key}`,
          ]);
          const replay = await this.readByClientRequest(client, input);
          if (replay !== undefined) return replay;

          const thread = await client.query<{ readonly status: string }>(
            `SELECT status FROM threads WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
            [input.scope.tenantId, input.thread.id],
          );
          if (thread.rows[0]?.status !== "active") return { outcome: "parent_inactive" } as const;
          const head = await lockOrCreateThreadExecutionHead(
            client,
            input.scope.tenantId,
            input.thread.id,
          );
          const legacy = await client.query(
            `SELECT 1 FROM runs run
              WHERE run.tenant_id=$1 AND run.thread_id=$2
                AND run.status IN ('queued','running','waiting')
                AND NOT EXISTS (
                  SELECT 1 FROM thread_follow_up_queue queue
                   WHERE queue.tenant_id=run.tenant_id AND queue.thread_id=run.thread_id
                     AND queue.run_id=run.id
                ) LIMIT 1`,
            [input.scope.tenantId, input.thread.id],
          );
          if (legacy.rowCount !== 0) throw new LegacyRunDrainRequiredError();

          const active =
            head.active_run_id === null
              ? undefined
              : (
                  await client.query<{
                    readonly run_status: string;
                    readonly attempt_status: string | null;
                    readonly attempt_stage: string | null;
                  }>(
                    `SELECT run.status AS run_status,attempt.status AS attempt_status,
                            attempt.stage AS attempt_stage
                       FROM runs run
                       LEFT JOIN LATERAL (
                         SELECT status,stage FROM execution_attempts
                          WHERE tenant_id=run.tenant_id AND run_id=run.id
                          ORDER BY created_at DESC LIMIT 1
                       ) attempt ON true
                      WHERE run.tenant_id=$1 AND run.id=$2`,
                    [input.scope.tenantId, head.active_run_id],
                  )
                ).rows[0];
          const decision = decideThreadInputRoute({
            mode: input.mode,
            ...(input.expectedRunId === undefined ? {} : { expectedRunId: input.expectedRunId }),
            ...(input.expectedTurnId === undefined ? {} : { expectedTurnId: input.expectedTurnId }),
            fallbackToFollowUp: input.fallbackToFollowUp,
            activeRunId: head.active_run_id,
            activeTurnId: head.active_turn_id,
            ...(active === undefined
              ? {}
              : {
                  activeRunStatus: active.run_status,
                  activeAttemptStatus: active.attempt_status,
                  activeAttemptStage: active.attempt_stage,
                }),
          });
          const action = decision.action;
          const rejectionCode = decision.action === "reject" ? decision.rejectionCode : undefined;

          const receiptId = `input-${randomUUID()}`;
          const inputSequence = safeSequence(head.next_input_sequence, "input sequence");
          let queuedRun: Run | undefined;
          if (action === "queue") {
            queuedRun = await this.insertQueued(client, input, {
              receiptId,
              inputSequence,
              digest,
              queueSequence: inputSequence,
              turnOrdinal: inputSequence,
            });
            if (head.active_run_id === null) {
              await activateNextThreadRun(client, input.scope.tenantId, input.thread.id);
            }
          } else {
            await client.query(
              `UPDATE thread_execution_heads
                  SET next_input_sequence=next_input_sequence+1,version=version+1,
                      updated_at=clock_timestamp()
                WHERE tenant_id=$1 AND thread_id=$2`,
              [input.scope.tenantId, input.thread.id],
            );
            if (action === "steer") {
              if (head.active_run_id === null || head.active_turn_id === null) {
                throw new TypeError("steer 决策缺少 active Run/Turn");
              }
              if (input.mode === "auto" || input.fallbackToFollowUp) {
                // fallback Run 尚未插入 runs，但其不可变身份与 Skill 快照在用户提交时已经固定；
                // terminal 转队列时只消费该候选，不能反查届时的安装集合。
                await createRunSkillSnapshot(client, {
                  tenantId: input.scope.tenantId,
                  runId: input.fallbackRun.id,
                  userId: input.scope.userId,
                });
              }
              await client.query(
                `INSERT INTO thread_input_receipts(
                   tenant_id,thread_id,receipt_id,client_request_id,request_digest,requested_mode,
                   state,disposition,input_sequence,input_text,input_attachments,body_digest,body_size_bytes,
                   expected_run_id,expected_turn_id,fallback_to_follow_up,target_run_id,
                   target_turn_id,fallback_run_id
                 ) VALUES ($1,$2,$3,$4,$5,$6,'pending','pending_steer',$7,$8,$9::jsonb,$10,$11,
                           $12,$13,$14,$15,$16,$17)`,
                [
                  input.scope.tenantId,
                  input.thread.id,
                  receiptId,
                  input.idempotency.key,
                  input.idempotency.requestHash,
                  input.mode,
                  inputSequence,
                  input.inputText,
                  attachmentsJson,
                  digest,
                  Buffer.byteLength(input.inputText, "utf8"),
                  input.expectedRunId ?? null,
                  input.expectedTurnId ?? null,
                  input.fallbackToFollowUp,
                  head.active_run_id,
                  head.active_turn_id,
                  input.mode === "auto" || input.fallbackToFollowUp ? input.fallbackRun.id : null,
                ],
              );
              await this.insertEvent(client, input, receiptId, 1, "accepted", {
                disposition: "pending_steer",
                targetRunId: head.active_run_id,
                targetTurnId: head.active_turn_id,
              });
            } else {
              if (rejectionCode === undefined) {
                throw new TypeError("reject 决策缺少 rejection code");
              }
              await client.query(
                `INSERT INTO thread_input_receipts(
                   tenant_id,thread_id,receipt_id,client_request_id,request_digest,requested_mode,
                   state,disposition,input_sequence,input_text,input_attachments,body_digest,body_size_bytes,
                   expected_run_id,expected_turn_id,fallback_to_follow_up,rejection_code,consumed_at
                 ) VALUES ($1,$2,$3,$4,$5,$6,'rejected','rejected',$7,$8,$9::jsonb,$10,$11,
                           $12,$13,$14,$15,clock_timestamp())`,
                [
                  input.scope.tenantId,
                  input.thread.id,
                  receiptId,
                  input.idempotency.key,
                  input.idempotency.requestHash,
                  input.mode,
                  inputSequence,
                  input.inputText,
                  attachmentsJson,
                  digest,
                  Buffer.byteLength(input.inputText, "utf8"),
                  input.expectedRunId ?? null,
                  input.expectedTurnId ?? null,
                  input.fallbackToFollowUp,
                  rejectionCode,
                ],
              );
              await this.insertEvent(client, input, receiptId, 1, "accepted", {
                disposition: "rejected",
                rejectionCode,
              });
            }
          }
          if (this.historyTitleGenerationEnabled && action !== "reject") {
            await enqueuePersonalThreadTitleGeneration(client, {
              tenantId: input.scope.tenantId,
              threadId: input.thread.id,
              receiptId,
            });
          }

          if (
            this.historyFilesystemEnabled &&
            action !== "reject" &&
            input.attachments.length > 0
          ) {
            await upsertPersonalHistoryFiles(client, {
              tenantId: input.scope.tenantId,
              threadId: input.thread.id,
              receiptId,
              attachments: input.attachments,
              timeZone: this.historyDirectoryTimeZone,
              titleGenerationEnabled: this.historyTitleGenerationEnabled,
            });
          }
          const receipt = await this.readReceipt(client, input.thread.id, receiptId);
          if (receipt === undefined) throw new TypeError("输入 receipt 写后不可见");
          await client.query(
            `INSERT INTO thread_continuity_metric_observations(
               tenant_id,observation_id,thread_id,run_id,metric_name,value,unit,outcome,reason
             ) VALUES ($1,$2,$3,$4,'thread_input_total',1,'count',$5,$6)
             ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
            [
              input.scope.tenantId,
              `${receiptId}:input-total`,
              input.thread.id,
              receipt.queuedRunId ?? receipt.targetRunId ?? null,
              receipt.disposition,
              input.mode,
            ],
          );
          if (receipt.disposition === "queued") {
            await client.query(
              `INSERT INTO thread_continuity_metric_observations(
                 tenant_id,observation_id,thread_id,run_id,metric_name,value,unit,outcome
               ) SELECT $1,$2,$3,$4,'follow_up_queue_depth',count(*)::double precision,
                        'items','accepted'
                   FROM thread_follow_up_queue
                  WHERE tenant_id=$1 AND thread_id=$3
                    AND state IN ('queued','active')
               ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
              [
                input.scope.tenantId,
                `${receiptId}:queue-depth`,
                input.thread.id,
                receipt.queuedRunId,
              ],
            );
          }
          return {
            outcome: "accepted",
            receipt,
            ...(queuedRun === undefined ? {} : { queuedRun }),
          } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      if (error instanceof SkillSnapshotUnavailableError) {
        return { outcome: "skill_not_available" };
      }
      if (error instanceof LegacyRunDrainRequiredError) {
        return { outcome: "legacy_drain_required" };
      }
      if (error instanceof TransactionCommitUnknownError) {
        try {
          const replay = await withTenantTransaction(this.pool, input.scope, async (client) => {
            const membership = await client.query<{ readonly status: string }>(
              `SELECT status FROM memberships
                WHERE tenant_id=$1 AND user_id=$2`,
              [input.scope.tenantId, input.scope.userId],
            );
            if (membership.rows[0]?.status !== "active") {
              return { outcome: "not_authorized" } as const;
            }
            return this.readByClientRequest(client, input);
          });
          if (replay !== undefined) return replay;
        } catch {
          // 原始 COMMIT 结果仍未知；下方统一映射，禁止重写或生成第二个 receipt。
        }
      }
      throw mapPersistenceError(error, "提交 Thread 统一输入");
    }
  }

  async get(
    input: Parameters<ThreadInputRoutingPort["get"]>[0],
  ): ReturnType<ThreadInputRoutingPort["get"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const authorized = await client.query(
            `SELECT 1 FROM threads thread JOIN memberships membership
               ON membership.tenant_id=thread.tenant_id AND membership.user_id=$2
              AND membership.status='active'
              WHERE thread.tenant_id=$1 AND thread.id=$3`,
            [input.scope.tenantId, input.scope.userId, input.threadId],
          );
          if (authorized.rowCount !== 1) return undefined;
          return this.readReceipt(client, input.threadId, input.receiptId);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取 Thread 输入 receipt");
    }
  }

  private async insertQueued(
    client: PoolClient,
    input: Parameters<ThreadInputRoutingPort["submit"]>[0],
    values: Readonly<{
      receiptId: string;
      inputSequence: number;
      digest: string;
      queueSequence: number;
      turnOrdinal: number;
    }>,
  ): Promise<Run> {
    await client.query(
      `UPDATE thread_execution_heads
          SET next_input_sequence=next_input_sequence+1,
              next_queue_sequence=GREATEST(next_queue_sequence,$3+1),
              next_turn_ordinal=GREATEST(next_turn_ordinal,$3+1),version=version+1,
              updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND thread_id=$2`,
      [input.scope.tenantId, input.thread.id, values.inputSequence],
    );
    const run = await client.query<QueryResultRow>(
      `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'queued',clock_timestamp(),clock_timestamp())
       RETURNING id AS run_id,tenant_id,thread_id,status AS run_status,
                 created_at AS run_created_at,updated_at AS run_updated_at`,
      [input.scope.tenantId, input.fallbackRun.id, input.thread.id],
    );
    await createRunSkillSnapshot(client, {
      tenantId: input.scope.tenantId,
      runId: input.fallbackRun.id,
      userId: input.scope.userId,
      ...(input.skillInvocation === undefined ? {} : { explicitInvocation: input.skillInvocation }),
    });
    await client.query(
      `INSERT INTO thread_input_receipts(
         tenant_id,thread_id,receipt_id,client_request_id,request_digest,requested_mode,
         state,disposition,queued_run_id,queue_sequence,input_sequence,input_text,input_attachments,body_digest,
         body_size_bytes,expected_run_id,expected_turn_id,fallback_to_follow_up,fallback_run_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'pending','queued',$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$7)`,
      [
        input.scope.tenantId,
        input.thread.id,
        values.receiptId,
        input.idempotency.key,
        input.idempotency.requestHash,
        input.mode,
        input.fallbackRun.id,
        values.queueSequence,
        values.inputSequence,
        input.inputText,
        serializeAttachments(input.attachments),
        values.digest,
        Buffer.byteLength(input.inputText, "utf8"),
        input.expectedRunId ?? null,
        input.expectedTurnId ?? null,
        input.fallbackToFollowUp,
      ],
    );
    await client.query(
      `INSERT INTO thread_follow_up_queue(
         tenant_id,thread_id,queue_sequence,turn_ordinal,receipt_id,run_id,state
       ) VALUES ($1,$2,$3,$4,$5,$6,'queued')`,
      [
        input.scope.tenantId,
        input.thread.id,
        values.queueSequence,
        values.turnOrdinal,
        values.receiptId,
        input.fallbackRun.id,
      ],
    );
    await this.insertEvent(client, input, values.receiptId, 1, "accepted", {
      disposition: "queued",
      queuedRunId: input.fallbackRun.id,
      queueSequence: values.queueSequence,
    });
    const row = run.rows[0];
    if (row === undefined) throw new TypeError("创建 follow-up Run 未返回数据");
    return restoreRun(row, input.thread);
  }

  private async insertEvent(
    client: PoolClient,
    input: Pick<Parameters<ThreadInputRoutingPort["submit"]>[0], "scope" | "thread">,
    receiptId: string,
    sequence: number,
    kind: "accepted" | "disposition_changed",
    value:
      | {
          readonly disposition: "pending_steer";
          readonly targetRunId: string;
          readonly targetTurnId: string;
        }
      | {
          readonly disposition: "queued";
          readonly queuedRunId: string;
          readonly queueSequence: number;
        }
      | { readonly disposition: "rejected"; readonly rejectionCode: RejectionCode },
  ): Promise<void> {
    await client.query(
      `INSERT INTO thread_input_receipt_events(
         tenant_id,thread_id,receipt_id,event_sequence,event_kind,disposition,
         target_run_id,target_turn_id,queued_run_id,queue_sequence,rejection_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.scope.tenantId,
        input.thread.id,
        receiptId,
        sequence,
        kind,
        value.disposition,
        "targetRunId" in value ? value.targetRunId : null,
        "targetTurnId" in value ? value.targetTurnId : null,
        "queuedRunId" in value ? value.queuedRunId : null,
        "queueSequence" in value ? value.queueSequence : null,
        "rejectionCode" in value ? value.rejectionCode : null,
      ],
    );
  }

  private async readByClientRequest(
    client: PoolClient,
    input: Parameters<ThreadInputRoutingPort["submit"]>[0],
  ): Promise<ThreadInputSubmitResult | undefined> {
    const record = await client.query<{
      readonly receipt_id: string;
      readonly request_digest: string;
      readonly queued_run_id: string | null;
    }>(
      `SELECT receipt_id,request_digest,queued_run_id FROM thread_input_receipts
        WHERE tenant_id=$1 AND thread_id=$2 AND client_request_id=$3`,
      [input.scope.tenantId, input.thread.id, input.idempotency.key],
    );
    const row = record.rows[0];
    if (row === undefined) return undefined;
    if (row.request_digest !== input.idempotency.requestHash) return { outcome: "key_conflict" };
    const receipt = await this.readReceipt(client, input.thread.id, row.receipt_id);
    if (receipt === undefined) throw new TypeError("幂等 receipt 缺失");
    let queuedRun: Run | undefined;
    if (row.queued_run_id !== null) {
      const run = await client.query<QueryResultRow>(
        `SELECT id AS run_id,tenant_id,thread_id,status AS run_status,
                created_at AS run_created_at,updated_at AS run_updated_at
           FROM runs WHERE tenant_id=$1 AND id=$2`,
        [input.scope.tenantId, row.queued_run_id],
      );
      const runRow = run.rows[0];
      if (runRow === undefined) throw new TypeError("receipt 的 queued Run 缺失");
      queuedRun = restoreRun(runRow, input.thread);
    }
    return { outcome: "replayed", receipt, ...(queuedRun === undefined ? {} : { queuedRun }) };
  }

  private async readReceipt(
    client: PoolClient,
    threadId: string,
    receiptId: string,
  ): Promise<ThreadInputReceiptView | undefined> {
    const result = await client.query<{
      readonly receipt_id: string;
      readonly input_sequence: string;
      readonly requested_mode: ThreadInputReceiptView["requestedMode"];
      readonly disposition: ThreadInputReceiptView["disposition"];
      readonly target_run_id: string | null;
      readonly target_turn_id: string | null;
      readonly queued_run_id: string | null;
      readonly queue_sequence: string | null;
      readonly applied_context_sequence: string | null;
      readonly rejection_code: NonNullable<ThreadInputReceiptView["rejectionCode"]> | null;
      readonly created_at: Date;
      readonly updated_at: Date;
    }>(
      `SELECT receipt_id,input_sequence::text,requested_mode,disposition,target_run_id,
              target_turn_id,queued_run_id,queue_sequence::text,applied_context_sequence::text,
              rejection_code,created_at,updated_at
         FROM thread_input_receipts
        WHERE tenant_id=current_setting('app.tenant_id') AND thread_id=$1 AND receipt_id=$2`,
      [threadId, receiptId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const events = await client.query<{
      readonly event_sequence: string;
      readonly event_kind: "accepted" | "disposition_changed";
      readonly disposition: ThreadInputReceiptView["disposition"];
      readonly target_run_id: string | null;
      readonly target_turn_id: string | null;
      readonly queued_run_id: string | null;
      readonly queue_sequence: string | null;
      readonly rejection_code: NonNullable<ThreadInputReceiptView["rejectionCode"]> | null;
      readonly created_at: Date;
    }>(
      `SELECT event_sequence::text,event_kind,disposition,target_run_id,target_turn_id,
              queued_run_id,queue_sequence::text,rejection_code,created_at
         FROM thread_input_receipt_events
        WHERE tenant_id=current_setting('app.tenant_id') AND thread_id=$1 AND receipt_id=$2
        ORDER BY thread_input_receipt_events.event_sequence`,
      [threadId, receiptId],
    );
    return {
      receiptId: row.receipt_id,
      inputSequence: safeSequence(row.input_sequence, "input sequence"),
      requestedMode: row.requested_mode,
      disposition: row.disposition,
      ...(row.target_run_id === null ? {} : { targetRunId: row.target_run_id }),
      ...(row.target_turn_id === null ? {} : { targetTurnId: row.target_turn_id }),
      ...(row.queued_run_id === null ? {} : { queuedRunId: row.queued_run_id }),
      ...(row.queue_sequence === null
        ? {}
        : { queueSequence: safeSequence(row.queue_sequence, "queue sequence") }),
      ...(row.applied_context_sequence === null
        ? {}
        : {
            appliedContextSequence: safeSequence(row.applied_context_sequence, "context sequence"),
          }),
      ...(row.rejection_code === null ? {} : { rejectionCode: row.rejection_code }),
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      events: events.rows.map((event) => ({
        sequence: safeSequence(event.event_sequence, "receipt event sequence"),
        kind: event.event_kind,
        disposition: event.disposition,
        ...(event.target_run_id === null ? {} : { targetRunId: event.target_run_id }),
        ...(event.target_turn_id === null ? {} : { targetTurnId: event.target_turn_id }),
        ...(event.queued_run_id === null ? {} : { queuedRunId: event.queued_run_id }),
        ...(event.queue_sequence === null
          ? {}
          : { queueSequence: safeSequence(event.queue_sequence, "event queue sequence") }),
        ...(event.rejection_code === null ? {} : { rejectionCode: event.rejection_code }),
        createdAt: timestamp(event.created_at),
      })),
    };
  }
}

interface PersonalHistoryInput {
  readonly tenantId: string;
  readonly threadId: string;
  readonly receiptId: string;
  readonly attachments: readonly { readonly resourceId: string; readonly versionId: string }[];
  readonly timeZone: string;
  readonly titleGenerationEnabled: boolean;
}

async function upsertPersonalHistoryFiles(
  client: PoolClient,
  input: PersonalHistoryInput,
): Promise<void> {
  const context = await client.query<{
    readonly kind: string;
    readonly title: string;
    readonly title_source: "deterministic" | "model" | "user";
    readonly thread_created_at: Date;
    readonly receipt_created_at: Date;
    readonly title_generation_state: string | null;
  }>(
    `SELECT tenant.kind,thread.title,thread.title_source,
            thread.created_at AS thread_created_at,receipt.created_at AS receipt_created_at,
            title_outbox.state AS title_generation_state
       FROM tenants tenant
       JOIN threads thread ON thread.tenant_id=tenant.id
       JOIN thread_input_receipts receipt
         ON receipt.tenant_id=thread.tenant_id AND receipt.thread_id=thread.id
       LEFT JOIN thread_title_generation_outbox title_outbox
         ON title_outbox.tenant_id=thread.tenant_id AND title_outbox.thread_id=thread.id
      WHERE tenant.id=$1 AND thread.id=$2 AND receipt.receipt_id=$3`,
    [input.tenantId, input.threadId, input.receiptId],
  );
  const row = context.rows[0];
  if (row === undefined || row.kind !== "personal") return;

  // 不同 Thread 可能在同一秒得到相同标题；Tenant 级命名锁只保护语义名称分配，
  // 文件关系仍由 Thread head 的行锁串行化。
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
    `${input.tenantId}\u001fpersonal-history-names`,
  ]);

  const existingDirectory = await client.query<{ readonly directory_name: string }>(
    `SELECT directory_name FROM thread_history_directories
      WHERE tenant_id=$1 AND thread_id=$2`,
    [input.tenantId, input.threadId],
  );
  let directoryName = existingDirectory.rows[0]?.directory_name;
  if (directoryName === undefined) {
    const titlePending =
      input.titleGenerationEnabled &&
      (row.title_generation_state === "pending" || row.title_generation_state === "claimed");
    const baseName = historyFilesystemDirectoryName({ title: row.title });
    directoryName = titlePending
      ? pendingHistoryDirectoryName(input.threadId)
      : await allocateHistoryName(client, {
          tenantId: input.tenantId,
          baseName,
          table: "directory",
        });
    await client.query(
      `INSERT INTO thread_history_directories(
         tenant_id,thread_id,directory_name,directory_timestamp,directory_time_zone,naming_state,
         first_file_at,last_file_at,file_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,0)`,
      [
        input.tenantId,
        input.threadId,
        directoryName,
        row.thread_created_at,
        input.timeZone,
        titlePending
          ? "pending"
          : row.title_source === "model" || row.title_source === "user"
            ? "ready"
            : "fallback",
        row.receipt_created_at,
      ],
    );
  }

  for (const attachment of input.attachments) {
    const existing = await client.query(
      `SELECT 1 FROM thread_history_file_entries
        WHERE tenant_id=$1 AND thread_id=$2 AND resource_id=$3
          AND resource_version_id=$4 AND relation_type='user_attachment'`,
      [input.tenantId, input.threadId, attachment.resourceId, attachment.versionId],
    );
    if (existing.rowCount === 1) {
      await client.query(
        `UPDATE thread_history_file_entries
            SET last_attached_at=GREATEST(last_attached_at,$5),
                attachment_count=attachment_count+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND thread_id=$2 AND resource_id=$3
            AND resource_version_id=$4 AND relation_type='user_attachment'`,
        [
          input.tenantId,
          input.threadId,
          attachment.resourceId,
          attachment.versionId,
          row.receipt_created_at,
        ],
      );
      continue;
    }
    const resource = await client.query<{ readonly name: string }>(
      `SELECT resource.name FROM resources resource
        JOIN resource_versions version
          ON version.tenant_id=resource.tenant_id AND version.resource_id=resource.id
       WHERE resource.tenant_id=$1 AND resource.id=$2 AND version.id=$3
         AND resource.visibility='searchable'`,
      [input.tenantId, attachment.resourceId, attachment.versionId],
    );
    const resourceName = resource.rows[0]?.name;
    if (resourceName === undefined) throw new TypeError("历史附件 ResourceVersion 不可见");
    const baseEntryName = historyFilesystemEntryName({ name: resourceName });
    const entryName = await allocateHistoryName(client, {
      tenantId: input.tenantId,
      threadId: input.threadId,
      baseName: baseEntryName,
      table: "entry",
    });
    await client.query(
      `INSERT INTO thread_history_file_entries(
         tenant_id,thread_id,resource_id,resource_version_id,relation_type,directory_entry_name,
         first_receipt_id,first_attached_at,last_attached_at,attachment_count
       ) VALUES ($1,$2,$3,$4,'user_attachment',$5,$6,$7,$7,1)`,
      [
        input.tenantId,
        input.threadId,
        attachment.resourceId,
        attachment.versionId,
        entryName,
        input.receiptId,
        row.receipt_created_at,
      ],
    );
  }

  await client.query(
    `UPDATE thread_history_directories directory
        SET first_file_at=summary.first_file_at,last_file_at=summary.last_file_at,
            file_count=summary.file_count,version=directory.version+1,updated_at=clock_timestamp()
       FROM (
         SELECT tenant_id,thread_id,min(first_attached_at) AS first_file_at,
                max(last_attached_at) AS last_file_at,count(*)::bigint AS file_count
           FROM thread_history_file_entries
          WHERE tenant_id=$1 AND thread_id=$2 GROUP BY tenant_id,thread_id
       ) summary
      WHERE directory.tenant_id=summary.tenant_id AND directory.thread_id=summary.thread_id`,
    [input.tenantId, input.threadId],
  );
}

async function allocateHistoryName(
  client: PoolClient,
  input:
    | { readonly table: "directory"; readonly tenantId: string; readonly baseName: string }
    | {
        readonly table: "entry";
        readonly tenantId: string;
        readonly threadId: string;
        readonly baseName: string;
      },
): Promise<string> {
  for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
    const candidate =
      input.table === "directory"
        ? historyFilesystemCollisionName(input.baseName, ordinal)
        : historyFilesystemEntryCollisionName(input.baseName, ordinal);
    const found =
      input.table === "directory"
        ? await client.query(
            `SELECT 1 FROM thread_history_directories
              WHERE tenant_id=$1 AND directory_name=$2`,
            [input.tenantId, candidate],
          )
        : await client.query(
            `SELECT 1 FROM thread_history_file_entries
              WHERE tenant_id=$1 AND thread_id=$2 AND directory_entry_name=$3`,
            [input.tenantId, input.threadId, candidate],
          );
    if (found.rowCount === 0) return candidate;
  }
  throw new TypeError("历史文件语义名称冲突过多");
}
