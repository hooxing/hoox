import type {
  AgentControlPersistencePort,
  AgentThreadPersistenceSnapshot,
  ExecutionFence,
} from "@cube-runtime/run-contracts";
import type { Pool, PoolClient } from "pg";
import { withRetriedSerializableTenantTransaction, withTenantTransaction } from "./postgres.js";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

function validIdentifier(value: string): boolean {
  return identifier.test(value);
}

function forkValue(value: AgentThreadPersistenceSnapshot["forkTurns"]): string {
  return typeof value === "number" ? String(value) : value;
}

async function lockActiveFence(
  client: PoolClient,
  fence: ExecutionFence,
  attemptId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM execution_attempts attempt
       JOIN run_claims claim
         ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
       JOIN workspace_write_leases lease
         ON lease.tenant_id=attempt.tenant_id
        AND lease.workspace_id=attempt.workspace_id
        AND lease.root_run_id=attempt.root_run_id
        AND lease.epoch=claim.workspace_lease_epoch
      WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$2
        AND attempt.thread_id=$3 AND attempt.run_id=$4 AND attempt.workspace_id=$5
        AND attempt.root_run_id=$6 AND attempt.base_revision_id IS NOT DISTINCT FROM $7
        AND attempt.status IN ('claimed','running','finalizing','waiting')
        AND claim.claim_token=$8 AND claim.claim_epoch=$9
        AND claim.released_at IS NULL AND claim.expires_at > clock_timestamp()
        AND lease.thread_id=attempt.thread_id AND lease.expires_at > clock_timestamp()
      FOR SHARE OF attempt,claim,lease`,
    [
      fence.scope.tenantId,
      attemptId,
      fence.scope.threadId,
      fence.scope.runId,
      fence.scope.workspaceId,
      fence.scope.rootRunId,
      fence.scope.baseRevisionId ?? null,
      fence.runClaim.token,
      fence.runClaim.epoch,
    ],
  );
  return result.rowCount === 1;
}

/** PostgreSQL 只保存控制面事实；模型 Session、等待器与 AbortController 仍属于当前 Worker。 */
export class PgAgentControlRepository implements AgentControlPersistencePort {
  constructor(private readonly pool: Pool) {}

  async initializeRoot(
    input: Parameters<AgentControlPersistencePort["initializeRoot"]>[0],
  ): ReturnType<AgentControlPersistencePort["initializeRoot"]> {
    if (!validIdentifier(input.rootAgentThreadId)) return "conflict";
    try {
      return await withRetriedSerializableTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return "not_authorized" as const;
          }
          const inserted = await client.query(
            `INSERT INTO runtime_agent_threads(
               tenant_id,thread_id,run_id,attempt_id,agent_thread_id,canonical_path,kind,status
             ) VALUES ($1,$2,$3,$4,$5,'/root','root','open')
             ON CONFLICT DO NOTHING`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              input.fence.scope.runId,
              input.attemptId,
              input.rootAgentThreadId,
            ],
          );
          if (inserted.rowCount === 1) return "ready" as const;
          const existing = await client.query<{ kind: string; canonical_path: string }>(
            `SELECT kind,canonical_path FROM runtime_agent_threads
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3`,
            [input.fence.scope.tenantId, input.attemptId, input.rootAgentThreadId],
          );
          return existing.rows[0]?.kind === "root" && existing.rows[0]?.canonical_path === "/root"
            ? ("ready" as const)
            : ("conflict" as const);
        },
      );
    } catch {
      return "unavailable";
    }
  }

  async spawn(
    input: Parameters<AgentControlPersistencePort["spawn"]>[0],
  ): ReturnType<AgentControlPersistencePort["spawn"]> {
    const snapshot = input.snapshot;
    if (
      !validIdentifier(input.commandId) ||
      !validIdentifier(snapshot.agentThreadId) ||
      !validIdentifier(snapshot.parentAgentThreadId) ||
      !validIdentifier(snapshot.turnId)
    ) {
      return { outcome: "conflict" };
    }
    try {
      return await withRetriedSerializableTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return { outcome: "not_authorized" } as const;
          }
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `${input.fence.scope.tenantId}:${input.attemptId}:agent-control`,
          ]);
          const replay = await client.query<{ args_digest: string; child_id: string }>(
            `SELECT args_digest,result->>'agentThreadId' AS child_id
               FROM runtime_agent_commands
              WHERE tenant_id=$1 AND attempt_id=$2 AND caller_agent_thread_id=$3 AND command_id=$4`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              snapshot.parentAgentThreadId,
              input.commandId,
            ],
          );
          if (replay.rows[0] !== undefined) {
            return replay.rows[0].args_digest === input.argsDigest &&
              replay.rows[0].child_id === snapshot.agentThreadId
              ? ({ outcome: "replayed", snapshot } as const)
              : ({ outcome: "conflict" } as const);
          }
          const capacity = await client.query<{ total: string; active: string }>(
            `SELECT count(*) FILTER (WHERE kind='subagent')::text AS total,
                    count(*) FILTER (WHERE kind='subagent' AND EXISTS (
                      SELECT 1 FROM runtime_agent_turns turn_state
                       WHERE turn_state.tenant_id=runtime_agent_threads.tenant_id
                         AND turn_state.attempt_id=runtime_agent_threads.attempt_id
                         AND turn_state.agent_thread_id=runtime_agent_threads.agent_thread_id
                         AND turn_state.status IN ('queued','running')
                    ))::text AS active
               FROM runtime_agent_threads
              WHERE tenant_id=$1 AND attempt_id=$2`,
            [input.fence.scope.tenantId, input.attemptId],
          );
          if (
            Number(capacity.rows[0]?.total) >= input.maxThreads ||
            Number(capacity.rows[0]?.active) >= input.maxActiveSubagents
          ) {
            return { outcome: "capacity" } as const;
          }
          await client.query(
            `INSERT INTO runtime_agent_threads(
               tenant_id,thread_id,run_id,attempt_id,agent_thread_id,parent_agent_thread_id,
               canonical_path,kind,status,task,enabled_tools,fork_turns
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,'subagent','open',$8,$9::jsonb,$10)`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              input.fence.scope.runId,
              input.attemptId,
              snapshot.agentThreadId,
              snapshot.parentAgentThreadId,
              snapshot.canonicalPath,
              snapshot.task,
              JSON.stringify(snapshot.tools),
              forkValue(snapshot.forkTurns),
            ],
          );
          await client.query(
            `INSERT INTO runtime_agent_turns(
               tenant_id,attempt_id,agent_thread_id,agent_turn_id,ordinal,trigger,status,prompt_text
             ) VALUES ($1,$2,$3,$4,$5,'spawn','queued',$6)`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              snapshot.agentThreadId,
              snapshot.turnId,
              snapshot.turnOrdinal,
              snapshot.task,
            ],
          );
          await client.query(
            `INSERT INTO runtime_agent_commands(
               tenant_id,attempt_id,caller_agent_thread_id,command_id,kind,args_digest,result
             ) VALUES ($1,$2,$3,$4,'spawn',$5,$6::jsonb)`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              snapshot.parentAgentThreadId,
              input.commandId,
              input.argsDigest,
              JSON.stringify({ agentThreadId: snapshot.agentThreadId }),
            ],
          );
          return { outcome: "created", snapshot } as const;
        },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async queueFollowUp(
    input: Parameters<AgentControlPersistencePort["queueFollowUp"]>[0],
  ): ReturnType<AgentControlPersistencePort["queueFollowUp"]> {
    if (!validIdentifier(input.commandId) || !validIdentifier(input.turnId)) return "conflict";
    try {
      return await withRetriedSerializableTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return "not_authorized" as const;
          }
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `${input.fence.scope.tenantId}:${input.attemptId}:agent-control`,
          ]);
          const replay = await client.query<{ args_digest: string }>(
            `SELECT args_digest FROM runtime_agent_commands
              WHERE tenant_id=$1 AND attempt_id=$2 AND caller_agent_thread_id=$3 AND command_id=$4`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.callerAgentThreadId,
              input.commandId,
            ],
          );
          if (replay.rows[0] !== undefined) {
            return replay.rows[0].args_digest === input.argsDigest ? "replayed" : "conflict";
          }
          const active = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM runtime_agent_turns
              WHERE tenant_id=$1 AND attempt_id=$2 AND status IN ('queued','running')`,
            [input.fence.scope.tenantId, input.attemptId],
          );
          if (Number(active.rows[0]?.count) >= input.maxActiveSubagents) {
            return "busy" as const;
          }
          const inserted = await client.query(
            `INSERT INTO runtime_agent_turns(
               tenant_id,attempt_id,agent_thread_id,agent_turn_id,ordinal,trigger,status,prompt_text
             ) VALUES ($1,$2,$3,$4,$5,'follow_up','queued',$6)
             ON CONFLICT DO NOTHING`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.agentThreadId,
              input.turnId,
              input.turnOrdinal,
              input.task,
            ],
          );
          if (inserted.rowCount !== 1) return "busy" as const;
          await client.query(
            `INSERT INTO runtime_agent_commands(
               tenant_id,attempt_id,caller_agent_thread_id,command_id,kind,args_digest,result
             ) VALUES ($1,$2,$3,$4,'follow_up',$5,'{"queued":true}'::jsonb)`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.callerAgentThreadId,
              input.commandId,
              input.argsDigest,
            ],
          );
          return "created" as const;
        },
      );
    } catch {
      return "unavailable";
    }
  }

  async startTurn(
    input: Parameters<AgentControlPersistencePort["startTurn"]>[0],
  ): ReturnType<AgentControlPersistencePort["startTurn"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return "not_authorized" as const;
          }
          const updated = await client.query(
            `UPDATE runtime_agent_turns SET status='running',started_at=clock_timestamp()
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND agent_turn_id=$4
                AND status='queued'`,
            [input.fence.scope.tenantId, input.attemptId, input.agentThreadId, input.turnId],
          );
          if (updated.rowCount === 1) return "started" as const;
          const existing = await client.query<{ status: string }>(
            `SELECT status FROM runtime_agent_turns
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND agent_turn_id=$4`,
            [input.fence.scope.tenantId, input.attemptId, input.agentThreadId, input.turnId],
          );
          return existing.rows[0]?.status === "running"
            ? ("replayed" as const)
            : ("conflict" as const);
        },
      );
    } catch {
      return "unavailable";
    }
  }

  async settleTurn(
    input: Parameters<AgentControlPersistencePort["settleTurn"]>[0],
  ): ReturnType<AgentControlPersistencePort["settleTurn"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return "not_authorized" as const;
          }
          const updated = await client.query(
            `UPDATE runtime_agent_turns
                SET status=$5,final_answer=$6,error_code=$7,completed_at=clock_timestamp()
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND agent_turn_id=$4
                AND status IN ('queued','running')`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.agentThreadId,
              input.turnId,
              input.status,
              input.finalAnswer ?? null,
              input.errorCode ?? null,
            ],
          );
          if (updated.rowCount === 1) return "settled" as const;
          const existing = await client.query<{ status: string }>(
            `SELECT status FROM runtime_agent_turns
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND agent_turn_id=$4`,
            [input.fence.scope.tenantId, input.attemptId, input.agentThreadId, input.turnId],
          );
          return existing.rows[0]?.status === input.status
            ? ("replayed" as const)
            : ("conflict" as const);
        },
      );
    } catch {
      return "unavailable";
    }
  }

  async appendMailbox(
    input: Parameters<AgentControlPersistencePort["appendMailbox"]>[0],
  ): ReturnType<AgentControlPersistencePort["appendMailbox"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return { outcome: "not_authorized" } as const;
          }
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `${input.fence.scope.tenantId}:${input.attemptId}:agent-mailbox`,
          ]);
          const replay = await client.query<{
            sequence: string;
            recipient_agent_thread_id: string;
            sender_agent_thread_id: string;
            kind: string;
            payload: string;
          }>(
            `SELECT sequence::text,recipient_agent_thread_id,sender_agent_thread_id,kind,payload
               FROM runtime_agent_mailbox_messages
              WHERE tenant_id=$1 AND attempt_id=$2 AND command_id=$3`,
            [input.fence.scope.tenantId, input.attemptId, input.commandId],
          );
          const replayRow = replay.rows[0];
          if (replayRow !== undefined) {
            return replayRow.recipient_agent_thread_id === input.recipientAgentThreadId &&
              replayRow.sender_agent_thread_id === input.senderAgentThreadId &&
              replayRow.kind === input.kind &&
              replayRow.payload === input.payload
              ? ({ outcome: "replayed", sequence: Number(replayRow.sequence) } as const)
              : ({ outcome: "conflict" } as const);
          }
          const inserted = await client.query<{ sequence: string }>(
            `INSERT INTO runtime_agent_mailbox_messages(
               tenant_id,attempt_id,sequence,recipient_agent_thread_id,sender_agent_thread_id,
               kind,payload,command_id
             ) SELECT $1,$2,COALESCE(max(sequence),0)+1,$3,$4,$5,$6,$7
                 FROM runtime_agent_mailbox_messages
                WHERE tenant_id=$1 AND attempt_id=$2
             RETURNING sequence::text`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.recipientAgentThreadId,
              input.senderAgentThreadId,
              input.kind,
              input.payload,
              input.commandId,
            ],
          );
          const row = inserted.rows[0];
          return row === undefined
            ? ({ outcome: "conflict" } as const)
            : ({ outcome: "created", sequence: Number(row.sequence) } as const);
        },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async recordCommand(
    input: Parameters<AgentControlPersistencePort["recordCommand"]>[0],
  ): ReturnType<AgentControlPersistencePort["recordCommand"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return "not_authorized" as const;
          }
          const inserted = await client.query(
            `INSERT INTO runtime_agent_commands(
               tenant_id,attempt_id,caller_agent_thread_id,command_id,kind,args_digest,result
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
             ON CONFLICT DO NOTHING`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.callerAgentThreadId,
              input.commandId,
              input.kind,
              input.argsDigest,
              JSON.stringify(input.result),
            ],
          );
          if (inserted.rowCount === 1) return "recorded" as const;
          const replay = await client.query<{
            args_digest: string;
            kind: string;
            result_matches: boolean;
          }>(
            `SELECT args_digest,kind,result = $5::jsonb AS result_matches
               FROM runtime_agent_commands
              WHERE tenant_id=$1 AND attempt_id=$2 AND caller_agent_thread_id=$3 AND command_id=$4`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.callerAgentThreadId,
              input.commandId,
              JSON.stringify(input.result),
            ],
          );
          const row = replay.rows[0];
          return row?.args_digest === input.argsDigest &&
            row.kind === input.kind &&
            row.result_matches
            ? ("replayed" as const)
            : ("conflict" as const);
        },
      );
    } catch {
      return "unavailable";
    }
  }
}
