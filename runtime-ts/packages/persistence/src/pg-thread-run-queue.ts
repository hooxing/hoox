import { randomUUID } from "node:crypto";
import type { ControlledRolloutProjection } from "@cube-runtime/run-contracts";
import { rolloutProjectionDigest } from "@cube-runtime/run-contracts/mutation-protocol";
import type { PoolClient } from "pg";

export const legacyInitialProjection = Object.freeze({
  schemaVersion: 2 as const,
  checkpointId: "initial",
  items: Object.freeze([]),
}) satisfies ControlledRolloutProjection;
const legacyInitialProjectionDigest = rolloutProjectionDigest(legacyInitialProjection);

export interface ThreadExecutionHeadRow {
  readonly active_run_id: string | null;
  readonly active_turn_id: string | null;
  readonly context_through_sequence: string | null;
  readonly next_input_sequence: string;
  readonly next_queue_sequence: string;
  readonly next_turn_ordinal: string;
  readonly writer_owner: string | null;
  readonly writer_token: string | null;
  readonly writer_epoch: string;
  readonly writer_expires_at: Date | null;
}

function safeSequence(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${name} 无效`);
  return parsed;
}

/** 新 Thread 和由普通 Repository 构造的测试 Thread 都在第一次 V2 写入时补齐空 head。 */
export async function lockOrCreateThreadExecutionHead(
  client: PoolClient,
  tenantId: string,
  threadId: string,
): Promise<ThreadExecutionHeadRow> {
  await client.query(
    `INSERT INTO thread_execution_heads(tenant_id,thread_id)
     VALUES ($1,$2) ON CONFLICT (tenant_id,thread_id) DO NOTHING`,
    [tenantId, threadId],
  );
  const result = await client.query<ThreadExecutionHeadRow>(
    `SELECT active_run_id,active_turn_id,context_through_sequence,next_input_sequence::text,next_queue_sequence::text,
            next_turn_ordinal::text,writer_owner,writer_token,writer_epoch::text,
            writer_expires_at
       FROM thread_execution_heads
      WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
    [tenantId, threadId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new TypeError("Thread execution head 缺失");
  return row;
}

export async function lockThreadExecutionHead(
  client: PoolClient,
  tenantId: string,
  threadId: string,
): Promise<ThreadExecutionHeadRow | undefined> {
  const result = await client.query<ThreadExecutionHeadRow>(
    `SELECT active_run_id,active_turn_id,context_through_sequence,next_input_sequence::text,next_queue_sequence::text,
            next_turn_ordinal::text,writer_owner,writer_token,writer_epoch::text,
            writer_expires_at
       FROM thread_execution_heads
      WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
    [tenantId, threadId],
  );
  return result.rows[0];
}

export interface EnqueueThreadFollowUpInput {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly clientRequestId: string;
  readonly requestDigest: string;
  readonly inputText: string;
  readonly inputDigest: string;
}

/**
 * 调用方已经锁定 Thread 并插入 queued Run。本函数在同一事务分配不可变 receipt/FIFO，
 * 且只在 head 空闲时激活队首；queued 项不会提前产生 execution input 或 dispatch。
 */
export async function enqueueThreadFollowUp(
  client: PoolClient,
  input: EnqueueThreadFollowUpInput,
): Promise<void> {
  const head = await lockOrCreateThreadExecutionHead(client, input.tenantId, input.threadId);
  const inputSequence = safeSequence(head.next_input_sequence, "input sequence");
  // queue/turn 使用全局 input 顺序；steer 会留下合法空洞，terminal fallback 仍可回到原顺序。
  const queueSequence = inputSequence;
  const turnOrdinal = inputSequence;
  const receiptId = `input-${randomUUID()}`;
  await client.query(
    `UPDATE thread_execution_heads
        SET next_input_sequence=next_input_sequence+1,
            next_queue_sequence=GREATEST(next_queue_sequence,$3+1),
            next_turn_ordinal=GREATEST(next_turn_ordinal,$3+1),
            version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND thread_id=$2`,
    [input.tenantId, input.threadId, inputSequence],
  );
  await client.query(
    `INSERT INTO thread_input_receipts(
       tenant_id,thread_id,receipt_id,client_request_id,request_digest,requested_mode,
       state,disposition,queued_run_id,queue_sequence,input_sequence,input_text,body_digest,
       body_size_bytes
     ) VALUES ($1,$2,$3,$4,$5,'follow_up','pending','queued',$6,$7,$8,$9,$10,$11)`,
    [
      input.tenantId,
      input.threadId,
      receiptId,
      input.clientRequestId,
      input.requestDigest,
      input.runId,
      queueSequence,
      inputSequence,
      input.inputText,
      input.inputDigest,
      Buffer.byteLength(input.inputText, "utf8"),
    ],
  );
  await client.query(
    `INSERT INTO thread_follow_up_queue(
       tenant_id,thread_id,queue_sequence,turn_ordinal,receipt_id,run_id,state
     ) VALUES ($1,$2,$3,$4,$5,$6,'queued')`,
    [input.tenantId, input.threadId, queueSequence, turnOrdinal, receiptId, input.runId],
  );
  await client.query(
    `INSERT INTO thread_continuity_metric_observations(
       tenant_id,observation_id,thread_id,run_id,metric_name,value,unit,outcome,reason
     ) VALUES ($1,$2,$3,$4,'thread_input_total',1,'count','queued','follow_up')
     ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
    [input.tenantId, `${receiptId}:input-total`, input.threadId, input.runId],
  );

  // V2 只可在 legacy 非终态 Run 已排空后开启。这里以事务失败关闭防止切换失误制造双 active。
  const legacy = await client.query(
    `SELECT 1 FROM runs run
      WHERE run.tenant_id=$1 AND run.thread_id=$2
        AND run.status IN ('queued','running','waiting')
        AND NOT EXISTS (
          SELECT 1 FROM thread_follow_up_queue queue
           WHERE queue.tenant_id=run.tenant_id AND queue.thread_id=run.thread_id
             AND queue.run_id=run.id
        )
      LIMIT 1`,
    [input.tenantId, input.threadId],
  );
  if (legacy.rowCount !== 0) throw new LegacyRunDrainRequiredError();
  if (head.active_run_id === null) {
    await activateNextThreadRun(client, input.tenantId, input.threadId);
  }
}

export class LegacyRunDrainRequiredError extends Error {
  constructor() {
    super("THREAD_SERIAL_QUEUE_LEGACY_DRAIN_REQUIRED");
    this.name = "LegacyRunDrainRequiredError";
  }
}

/** 调用方必须已经锁定 execution head；本函数不实现 Context 读取、compaction 或 Sandbox handoff。 */
export async function activateNextThreadRun(
  client: PoolClient,
  tenantId: string,
  threadId: string,
): Promise<string | undefined> {
  const headResult = await client.query<ThreadExecutionHeadRow>(
    `SELECT active_run_id,active_turn_id,context_through_sequence,next_input_sequence::text,next_queue_sequence::text,
            next_turn_ordinal::text,writer_owner,writer_token,writer_epoch::text,
            writer_expires_at
       FROM thread_execution_heads
      WHERE tenant_id=$1 AND thread_id=$2`,
    [tenantId, threadId],
  );
  const head = headResult.rows[0];
  if (head === undefined) throw new TypeError("Thread execution head 缺失");
  if (head.active_run_id !== null) return undefined;

  // 取消永远保留队列事实，但不能阻塞后续 FIFO。
  await client.query(
    `UPDATE thread_follow_up_queue queue
        SET state='cancelled',finished_at=clock_timestamp(),
            consumption_receipt=jsonb_build_object('schemaVersion',1,'outcome','cancelled')
       FROM runs run
      WHERE queue.tenant_id=$1 AND queue.thread_id=$2 AND queue.state='queued'
        AND run.tenant_id=queue.tenant_id AND run.id=queue.run_id AND run.status='cancelled'`,
    [tenantId, threadId],
  );
  await client.query(
    `WITH cancelled AS (
       UPDATE thread_input_receipts receipt
          SET state='cancelled',disposition='cancelled',updated_at=clock_timestamp()
         FROM thread_follow_up_queue queue
        WHERE queue.tenant_id=$1 AND queue.thread_id=$2 AND queue.state='cancelled'
          AND receipt.tenant_id=queue.tenant_id AND receipt.thread_id=queue.thread_id
          AND receipt.receipt_id=queue.receipt_id AND receipt.state='pending'
        RETURNING receipt.tenant_id,receipt.thread_id,receipt.receipt_id,receipt.updated_at
     )
     INSERT INTO thread_input_receipt_events(
       tenant_id,thread_id,receipt_id,event_sequence,event_kind,disposition,created_at
     ) SELECT cancelled.tenant_id,cancelled.thread_id,cancelled.receipt_id,
              COALESCE((SELECT max(event_sequence)+1 FROM thread_input_receipt_events event
                         WHERE event.tenant_id=cancelled.tenant_id
                           AND event.thread_id=cancelled.thread_id
                           AND event.receipt_id=cancelled.receipt_id),1),
              'disposition_changed','cancelled',cancelled.updated_at
         FROM cancelled`,
    [tenantId, threadId],
  );

  const next = await client.query<{
    readonly queue_sequence: string;
    readonly turn_ordinal: string;
    readonly receipt_id: string;
    readonly run_id: string;
    readonly input_text: string;
    readonly body_digest: string;
  }>(
    `SELECT queue.queue_sequence::text,queue.turn_ordinal::text,queue.receipt_id,queue.run_id,
            receipt.input_text,receipt.body_digest
       FROM thread_follow_up_queue queue
       JOIN thread_input_receipts receipt
         ON receipt.tenant_id=queue.tenant_id AND receipt.thread_id=queue.thread_id
        AND receipt.receipt_id=queue.receipt_id
       JOIN runs run ON run.tenant_id=queue.tenant_id AND run.id=queue.run_id
      WHERE queue.tenant_id=$1 AND queue.thread_id=$2 AND queue.state='queued'
        AND receipt.state='pending' AND run.status='queued'
      ORDER BY queue.queue_sequence
      LIMIT 1 FOR UPDATE OF queue,receipt,run`,
    [tenantId, threadId],
  );
  const row = next.rows[0];
  if (row === undefined) return undefined;
  const workspace = await client.query<{
    readonly id: string;
    readonly current_revision_id: string | null;
  }>(
    `SELECT id,current_revision_id FROM workspaces
      WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
    [tenantId, threadId],
  );
  const workspaceRow = workspace.rows[0];
  if (workspaceRow === undefined) throw new TypeError("Thread Workspace 缺失");

  await client.query(
    `INSERT INTO run_execution_inputs(
       tenant_id,run_id,thread_id,workspace_id,root_run_id,base_revision_id,
       context_through_sequence,input_text,initial_projection,initial_projection_digest
     ) VALUES ($1,$2,$3,$4,$2,$5,$6,$7,$8::jsonb,$9)`,
    [
      tenantId,
      row.run_id,
      threadId,
      workspaceRow.id,
      workspaceRow.current_revision_id,
      head.context_through_sequence,
      row.input_text,
      JSON.stringify(legacyInitialProjection),
      legacyInitialProjectionDigest,
    ],
  );
  await client.query(
    `INSERT INTO run_dispatch_outbox(
       tenant_id,outbox_id,run_id,thread_id,workspace_id,root_run_id,input_digest,state
     ) VALUES ($1,$2,$3,$4,$5,$3,$6,'ready')`,
    [tenantId, randomUUID(), row.run_id, threadId, workspaceRow.id, row.body_digest],
  );
  const activatedQueue = await client.query(
    `UPDATE thread_follow_up_queue
        SET state='active',activated_at=clock_timestamp()
      WHERE tenant_id=$1 AND thread_id=$2 AND queue_sequence=$3 AND state='queued'`,
    [tenantId, threadId, row.queue_sequence],
  );
  const consumedReceipt = await client.query(
    `UPDATE thread_input_receipts
        SET state='consumed',consumed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND thread_id=$2 AND receipt_id=$3 AND state='pending'`,
    [tenantId, threadId, row.receipt_id],
  );
  const activatedHead = await client.query(
    `UPDATE thread_execution_heads
        SET active_run_id=$3,active_turn_id='turn-' || $4::text,
            version=version+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND thread_id=$2 AND active_run_id IS NULL`,
    [tenantId, threadId, row.run_id, row.turn_ordinal],
  );
  if (
    activatedQueue.rowCount !== 1 ||
    consumedReceipt.rowCount !== 1 ||
    activatedHead.rowCount !== 1
  ) {
    throw new TypeError("Thread queue 激活 CAS 冲突");
  }
  await client.query(
    `INSERT INTO thread_continuity_metric_observations(
       tenant_id,observation_id,thread_id,run_id,metric_name,value,unit,outcome
     ) SELECT $1,$2,$3,$4,'follow_up_wait_ms',
              GREATEST(0,EXTRACT(EPOCH FROM (activated_at-created_at))*1000),
              'milliseconds','activated'
         FROM thread_follow_up_queue
        WHERE tenant_id=$1 AND thread_id=$3 AND receipt_id=$5 AND state='active'
     ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
    [tenantId, `${row.receipt_id}:queue-wait`, threadId, row.run_id, row.receipt_id],
  );
  return row.run_id;
}

export async function settleActiveThreadRun(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly runStatus: "succeeded" | "failed" | "cancelled";
    readonly databaseNow: string;
  },
): Promise<boolean> {
  const head = await lockThreadExecutionHead(client, input.tenantId, input.threadId);
  if (head?.active_run_id !== input.runId) return false;
  const active = await client.query<{
    readonly workspace_id: string;
    readonly base_revision_id: string | null;
    readonly current_revision_id: string | null;
    readonly manifest_digest: string | null;
  }>(
    `SELECT execution.workspace_id,execution.base_revision_id,workspace.current_revision_id,
            COALESCE(manifest.manifest_digest,revision.digest) AS manifest_digest
       FROM thread_follow_up_queue queue
       JOIN run_execution_inputs execution
         ON execution.tenant_id=queue.tenant_id AND execution.run_id=queue.run_id
       JOIN workspaces workspace
         ON workspace.tenant_id=execution.tenant_id AND workspace.id=execution.workspace_id
       LEFT JOIN workspace_revisions revision
         ON revision.tenant_id=workspace.tenant_id AND revision.workspace_id=workspace.id
        AND revision.id=workspace.current_revision_id
       LEFT JOIN workspace_revision_manifests manifest
         ON manifest.tenant_id=revision.tenant_id AND manifest.workspace_id=revision.workspace_id
        AND manifest.revision_id=revision.id
      WHERE queue.tenant_id=$1 AND queue.thread_id=$2 AND queue.run_id=$3
        AND queue.state='active'
      FOR UPDATE OF queue,workspace`,
    [input.tenantId, input.threadId, input.runId],
  );
  const row = active.rows[0];
  if (row === undefined) throw new TypeError("active Run 与 Thread queue 不一致");
  const changed = row.current_revision_id !== row.base_revision_id;
  const outcome = changed
    ? "committed"
    : input.runStatus === "succeeded"
      ? "unchanged"
      : "failed_before_commit";
  await client.query(
    `INSERT INTO run_workspace_results(
       tenant_id,thread_id,run_id,workspace_id,base_revision_id,result_revision_id,
       outcome,manifest_digest,committed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.tenantId,
      input.threadId,
      input.runId,
      row.workspace_id,
      row.base_revision_id,
      outcome === "failed_before_commit" ? null : row.current_revision_id,
      outcome,
      outcome === "failed_before_commit" ? null : row.manifest_digest,
      outcome === "failed_before_commit" ? null : input.databaseNow,
    ],
  );
  const queueState =
    input.runStatus === "succeeded"
      ? "finished"
      : input.runStatus === "failed"
        ? "failed"
        : "cancelled";
  await convertTerminalPendingSteers(client, input);
  await client.query(
    `UPDATE thread_follow_up_queue
        SET state=$4,claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,
            consumption_receipt=jsonb_build_object(
              'schemaVersion',1,'outcome',$5::text,'workspaceOutcome',$6::text
            ),finished_at=$7
      WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND state='active'`,
    [
      input.tenantId,
      input.threadId,
      input.runId,
      queueState,
      input.runStatus,
      outcome,
      input.databaseNow,
    ],
  );
  await client.query(
    `UPDATE thread_execution_heads
        SET active_run_id=NULL,active_turn_id=NULL,writer_owner=NULL,writer_token=NULL,
            writer_expires_at=NULL,version=version+1,updated_at=$4
      WHERE tenant_id=$1 AND thread_id=$2 AND active_run_id=$3`,
    [input.tenantId, input.threadId, input.runId, input.databaseNow],
  );
  await activateNextThreadRun(client, input.tenantId, input.threadId);
  return true;
}

/**
 * 与 active Run terminal 共用 execution-head 行锁。结果只能是 steered 或 queued/rejected
 * 之一；auto 与显式 fallback 按原 input_sequence 回到 durable FIFO。
 */
async function convertTerminalPendingSteers(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly runId: string;
    readonly databaseNow: string;
  },
): Promise<void> {
  const pending = await client.query<{
    readonly receipt_id: string;
    readonly requested_mode: "auto" | "steer";
    readonly fallback_to_follow_up: boolean;
    readonly fallback_run_id: string | null;
    readonly input_sequence: string;
  }>(
    `SELECT receipt_id,requested_mode,fallback_to_follow_up,fallback_run_id,
            input_sequence::text
       FROM thread_input_receipts
      WHERE tenant_id=$1 AND thread_id=$2 AND target_run_id=$3
        AND state='pending' AND disposition='pending_steer'
      ORDER BY thread_input_receipts.input_sequence FOR UPDATE`,
    [input.tenantId, input.threadId, input.runId],
  );
  for (const receipt of pending.rows) {
    const inputSequence = safeSequence(receipt.input_sequence, "input sequence");
    const shouldQueue = receipt.requested_mode === "auto" || receipt.fallback_to_follow_up === true;
    if (!shouldQueue) {
      const rejected = await client.query(
        `UPDATE thread_input_receipts
            SET state='rejected',disposition='rejected',target_run_id=NULL,target_turn_id=NULL,
                rejection_code='target_run_finished',consumed_at=$4,updated_at=$4
          WHERE tenant_id=$1 AND thread_id=$2 AND receipt_id=$3
            AND state='pending' AND disposition='pending_steer'`,
        [input.tenantId, input.threadId, receipt.receipt_id, input.databaseNow],
      );
      if (rejected.rowCount !== 1) throw new TypeError("terminal steer reject CAS 冲突");
      await client.query(
        `INSERT INTO thread_input_receipt_events(
           tenant_id,thread_id,receipt_id,event_sequence,event_kind,disposition,
           rejection_code,created_at
         ) VALUES ($1,$2,$3,2,'disposition_changed','rejected','target_run_finished',$4)`,
        [input.tenantId, input.threadId, receipt.receipt_id, input.databaseNow],
      );
      continue;
    }
    if (receipt.fallback_run_id === null) throw new TypeError("terminal fallback Run ID 缺失");
    await client.query(
      `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at)
       VALUES ($1,$2,$3,'queued',$4,$4)`,
      [input.tenantId, receipt.fallback_run_id, input.threadId, input.databaseNow],
    );
    const queued = await client.query(
      `UPDATE thread_input_receipts
          SET disposition='queued',target_run_id=NULL,target_turn_id=NULL,
              queued_run_id=$4,queue_sequence=$5,updated_at=$6
        WHERE tenant_id=$1 AND thread_id=$2 AND receipt_id=$3
          AND state='pending' AND disposition='pending_steer'`,
      [
        input.tenantId,
        input.threadId,
        receipt.receipt_id,
        receipt.fallback_run_id,
        inputSequence,
        input.databaseNow,
      ],
    );
    if (queued.rowCount !== 1) throw new TypeError("terminal steer fallback CAS 冲突");
    await client.query(
      `INSERT INTO thread_follow_up_queue(
         tenant_id,thread_id,queue_sequence,turn_ordinal,receipt_id,run_id,state,created_at
       ) VALUES ($1,$2,$3,$3,$4,$5,'queued',$6)`,
      [
        input.tenantId,
        input.threadId,
        inputSequence,
        receipt.receipt_id,
        receipt.fallback_run_id,
        input.databaseNow,
      ],
    );
    await client.query(
      `UPDATE thread_execution_heads
          SET next_queue_sequence=GREATEST(next_queue_sequence,$3+1),
              next_turn_ordinal=GREATEST(next_turn_ordinal,$3+1),
              version=version+1,updated_at=$4
        WHERE tenant_id=$1 AND thread_id=$2`,
      [input.tenantId, input.threadId, inputSequence, input.databaseNow],
    );
    await client.query(
      `INSERT INTO thread_input_receipt_events(
         tenant_id,thread_id,receipt_id,event_sequence,event_kind,disposition,
         queued_run_id,queue_sequence,created_at
       ) VALUES ($1,$2,$3,2,'disposition_changed','queued',$4,$5,$6)`,
      [
        input.tenantId,
        input.threadId,
        receipt.receipt_id,
        receipt.fallback_run_id,
        inputSequence,
        input.databaseNow,
      ],
    );
    await client.query(
      `INSERT INTO thread_continuity_metric_observations(
         tenant_id,observation_id,thread_id,run_id,metric_name,value,unit,outcome,reason
       ) VALUES ($1,$2,$3,$4,'steer_to_follow_up_total',1,'count','queued','target_run_finished')
       ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
      [
        input.tenantId,
        `${receipt.receipt_id}:steer-fallback`,
        input.threadId,
        receipt.fallback_run_id,
      ],
    );
  }
}

/** 已由 Run Repository 把状态更新为 cancelled；这里只同步不可删除的 V2 queue 事实。 */
export async function cancelThreadQueuedRun(
  client: PoolClient,
  input: { readonly tenantId: string; readonly threadId: string; readonly runId: string },
): Promise<void> {
  const head = await lockThreadExecutionHead(client, input.tenantId, input.threadId);
  if (head?.active_run_id === input.runId) {
    const now = await client.query<{ readonly database_now: Date }>(
      "SELECT clock_timestamp() AS database_now",
    );
    const databaseNow = now.rows[0]?.database_now;
    if (databaseNow === undefined) throw new TypeError("数据库时钟缺失");
    await settleActiveThreadRun(client, {
      ...input,
      runStatus: "cancelled",
      databaseNow: databaseNow.toISOString(),
    });
    return;
  }
  await client.query(
    `UPDATE thread_follow_up_queue
        SET state='cancelled',finished_at=clock_timestamp(),
            consumption_receipt=jsonb_build_object('schemaVersion',1,'outcome','cancelled')
      WHERE tenant_id=$1 AND thread_id=$2 AND run_id=$3 AND state='queued'`,
    [input.tenantId, input.threadId, input.runId],
  );
  await client.query(
    `WITH cancelled AS (
       UPDATE thread_input_receipts receipt
          SET state='cancelled',disposition='cancelled',updated_at=clock_timestamp()
         FROM thread_follow_up_queue queue
        WHERE queue.tenant_id=$1 AND queue.thread_id=$2 AND queue.run_id=$3
          AND receipt.tenant_id=queue.tenant_id AND receipt.thread_id=queue.thread_id
          AND receipt.receipt_id=queue.receipt_id AND receipt.state='pending'
        RETURNING receipt.tenant_id,receipt.thread_id,receipt.receipt_id,receipt.updated_at
     )
     INSERT INTO thread_input_receipt_events(
       tenant_id,thread_id,receipt_id,event_sequence,event_kind,disposition,created_at
     ) SELECT cancelled.tenant_id,cancelled.thread_id,cancelled.receipt_id,
              COALESCE((SELECT max(event_sequence)+1 FROM thread_input_receipt_events event
                         WHERE event.tenant_id=cancelled.tenant_id
                           AND event.thread_id=cancelled.thread_id
                           AND event.receipt_id=cancelled.receipt_id),1),
              'disposition_changed','cancelled',cancelled.updated_at
         FROM cancelled`,
    [input.tenantId, input.threadId, input.runId],
  );
}
