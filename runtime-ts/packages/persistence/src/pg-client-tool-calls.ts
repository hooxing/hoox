import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ClientToolAction, ExecutionScope } from "@hoox/run-contracts";
import { withTenantTransaction } from "./postgres.js";
import type { TenantScope } from "./ports.js";
import { enqueueClientActionWebhook } from "./pg-webhooks.js";
import { scheduleWorkerTenantAt } from "./pg-worker-tenant-assignment.js";

/** Run 行锁是 waiting、结果、超时和取消的共同线性化点。重排同一 dispatch 会清除旧 token，使迟到 ack 无效。 */
async function schedule(client: PoolClient, tenantId: string, runId: string, at: Date) {
  const updated = await client.query(
    `UPDATE run_dispatch_outbox SET state='ready',next_attempt_at=GREATEST($3,clock_timestamp()),
            claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,last_error_code=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND run_id=$2`,
    [tenantId, runId, at],
  );
  if (updated.rowCount !== 1) throw new Error("客户端调用缺少 Run 投递记录");
  await scheduleWorkerTenantAt(client, tenantId, at);
}

export async function persistClientAction(
  client: PoolClient,
  scope: ExecutionScope,
  attemptId: string,
  action: ClientToolAction,
  now: string,
) {
  const { callId, toolName, arguments: args, waitTimeoutMs } = action;
  const deadline = new Date(Date.parse(now) + waitTimeoutMs);
  await client.query(
    `INSERT INTO client_tool_calls(tenant_id,run_id,thread_id,attempt_id,call_id,tool_name,arguments,deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      scope.tenantId,
      scope.runId,
      scope.threadId,
      attemptId,
      callId,
      toolName,
      JSON.stringify(args),
      deadline,
    ],
  );
  const data = {
    threadId: scope.threadId,
    runId: scope.runId,
    callId,
    toolName,
    arguments: args,
    deadline: deadline.toISOString(),
  };
  await enqueueClientActionWebhook(client, scope.tenantId, data, now);
  return data;
}

export async function scheduleClientWait(client: PoolClient, tenantId: string, runId: string) {
  await client.query(
    `UPDATE run_execution_inputs SET answer_text=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND run_id=$2`,
    [tenantId, runId],
  );
  const due = await client.query<{ deadline: Date }>(
    `SELECT min(deadline) AS deadline FROM client_tool_calls WHERE tenant_id=$1 AND run_id=$2 AND outcome IS NULL`,
    [tenantId, runId],
  );
  const deadline = due.rows[0]?.deadline;
  if (!deadline) throw new Error("客户端等待缺少截止时间");
  await schedule(client, tenantId, runId, deadline);
}

async function advanceWait(client: PoolClient, tenantId: string, runId: string, attemptId: string) {
  const result = await client.query<{
    call_id: string;
    tool_name: string;
    deadline: Date;
    arguments: Record<string, unknown>;
    outcome: string | null;
    response_text: string | null;
    truncated: boolean | null;
  }>(
    `SELECT call_id,tool_name,deadline,arguments,outcome,response_text,truncated FROM client_tool_calls
      WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3 ORDER BY deadline,call_id`,
    [tenantId, runId, attemptId],
  );
  const pending = result.rows.find((r) => r.outcome === null);
  if (pending) {
    await schedule(client, tenantId, runId, pending.deadline);
    return;
  }
  const answer = JSON.stringify({
    type: "client_tool_results",
    trust: "untrusted_tool_output",
    results: result.rows.map((r) => ({
      callId: r.call_id,
      toolName: r.tool_name,
      arguments: r.arguments,
      outcome: r.outcome,
      ...(r.response_text === null ? {} : { result: r.response_text, truncated: r.truncated }),
    })),
  });
  await client.query(
    `UPDATE run_execution_inputs SET answer_text=$3,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND run_id=$2`,
    [tenantId, runId, answer],
  );
  await schedule(client, tenantId, runId, new Date(0));
}

export class PgClientToolCallHistoryReader {
  constructor(private readonly pool: Pool) {}

  async findMatches(input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly callIds: readonly string[];
  }): Promise<readonly string[]> {
    if (input.callIds.length === 0) return [];
    return await withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      const result = await client.query<{ call_id: string }>(
        `SELECT call_id FROM client_tool_calls
            WHERE tenant_id=$1 AND thread_id=$2 AND call_id=ANY($3::text[])`,
        [input.tenantId, input.threadId, [...new Set(input.callIds)]],
      );
      return result.rows.map(({ call_id }) => call_id);
    });
  }
}

export class PgClientToolResults {
  constructor(private readonly pool: Pool) {}
  async submit(input: {
    scope: TenantScope;
    threadId: string;
    runId: string;
    callId: string;
    outcome: "succeeded" | "failed";
    result: string;
  }): Promise<"accepted" | "bad_request" | "not_found" | "conflict"> {
    const { scope, runId, threadId, callId, outcome, result } = input;
    const bytes = Buffer.from(result, "utf8");
    if (
      !callId.isWellFormed() ||
      callId.includes("\0") ||
      Buffer.byteLength(callId) > 200 ||
      bytes.length > 1_048_576 ||
      !result.isWellFormed() ||
      result.includes("\0")
    )
      return "bad_request";
    const digest = createHash("sha256").update(outcome).update("\0").update(bytes).digest("hex");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, 8192), {
      stream: bytes.length > 8192,
    });
    return withTenantTransaction(this.pool, scope, async (client) => {
      const locked = await client.query<{ status: string }>(
        `SELECT r.status FROM runs r JOIN memberships m
             ON m.tenant_id=r.tenant_id AND m.user_id=$4 AND m.status='active'
          WHERE r.tenant_id=$1 AND r.id=$2 AND r.thread_id=$3
          FOR UPDATE OF r FOR SHARE OF m`,
        [scope.tenantId, runId, threadId, scope.userId],
      );
      if (!locked.rowCount) return "not_found";
      const keys = [scope.tenantId, runId, callId];
      const existing = await client.query<{ result_digest: string | null; attempt_id: string }>(
        `SELECT result_digest,attempt_id FROM client_tool_calls WHERE tenant_id=$1 AND run_id=$2 AND call_id=$3`,
        keys,
      );
      const call = existing.rows[0];
      if (!call) return "not_found";
      if (locked.rows[0]?.status === "cancelled") return "conflict";
      if (call.result_digest !== null)
        return call.result_digest === digest ? "accepted" : "conflict";
      if (locked.rows[0]?.status !== "waiting") return "conflict";
      const changed = await client.query(
        `UPDATE client_tool_calls SET outcome=$4,result_digest=$5,response_text=$6,truncated=$7
          WHERE tenant_id=$1 AND run_id=$2 AND call_id=$3 AND outcome IS NULL AND deadline>clock_timestamp()`,
        [...keys, outcome, digest, text, bytes.length > 8192],
      );
      if (!changed.rowCount) return "conflict";
      await advanceWait(client, scope.tenantId, runId, call.attempt_id);
      return "accepted";
    });
  }
}

export async function expireClientToolCalls(client: PoolClient, tenantId: string, limit: number) {
  const due = await client.query<{ id: string }>(
    `SELECT r.id FROM runs r
      WHERE r.tenant_id=$1 AND r.status='waiting' AND EXISTS (
        SELECT 1 FROM client_tool_calls c WHERE c.tenant_id=r.tenant_id AND c.run_id=r.id
          AND c.outcome IS NULL AND c.deadline<=statement_timestamp()
      ) ORDER BY r.id LIMIT $2 FOR UPDATE OF r SKIP LOCKED`,
    [tenantId, limit],
  );
  for (const { id } of due.rows) {
    const timedOut = await client.query<{ attempt_id: string }>(
      `UPDATE client_tool_calls SET outcome='timeout'
        WHERE tenant_id=$1 AND run_id=$2 AND outcome IS NULL AND deadline<=clock_timestamp() RETURNING attempt_id`,
      [tenantId, id],
    );
    if (timedOut.rows[0]) await advanceWait(client, tenantId, id, timedOut.rows[0].attempt_id);
  }
}
