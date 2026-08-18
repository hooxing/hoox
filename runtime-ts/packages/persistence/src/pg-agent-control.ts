import { sha256Digest } from "@hoox/domain";
import {
  type AgentControlPersistencePort,
  type AgentThreadPersistenceSnapshot,
  DELEGABLE_AGENT_TOOL_NAMES,
  type DelegableAgentToolName,
  type ExecutionFence,
  type SubAgentConversationSnapshot,
} from "@hoox/run-contracts";
import type { Pool, PoolClient } from "pg";
import { withRetriedSerializableTenantTransaction, withTenantTransaction } from "./postgres.js";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

function validIdentifier(value: string): boolean {
  return identifier.test(value);
}

function forkValue(value: AgentThreadPersistenceSnapshot["forkTurns"]): string {
  return typeof value === "number" ? String(value) : value;
}

function parseForkValue(value: string): AgentThreadPersistenceSnapshot["forkTurns"] {
  if (value === "none" || value === "all") return value;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
    throw new TypeError("SubAgent fork_turns 持久化值无效");
  }
  return parsed;
}

function parseTools(value: unknown): readonly DelegableAgentToolName[] {
  if (!Array.isArray(value)) throw new TypeError("SubAgent 工具清单不是数组");
  const allowed = new Set<string>(DELEGABLE_AGENT_TOOL_NAMES);
  if (value.some((tool) => typeof tool !== "string" || !allowed.has(tool))) {
    throw new TypeError("SubAgent 工具清单含未知能力");
  }
  return Object.freeze([...new Set(value as DelegableAgentToolName[])]);
}

interface ConversationRow {
  readonly agent_thread_id: string;
  readonly canonical_path: string;
  readonly task: string;
  readonly current_task: string;
  readonly enabled_tools: unknown;
  readonly tool_manifest_digest: string;
  readonly fork_turns: string;
  readonly turn_ordinal: number;
  readonly history: unknown;
  readonly history_digest: string | null;
}

function conversationSnapshot(row: ConversationRow): SubAgentConversationSnapshot {
  const history =
    row.history === null || row.history === undefined
      ? undefined
      : (row.history as NonNullable<SubAgentConversationSnapshot["history"]>);
  if ((history?.digest ?? null) !== row.history_digest) {
    throw new TypeError("SubAgent 对话历史 digest 不匹配");
  }
  return Object.freeze({
    agentThreadId: row.agent_thread_id as SubAgentConversationSnapshot["agentThreadId"],
    canonicalPath: row.canonical_path,
    task: row.task,
    currentTask: row.current_task,
    tools: parseTools(row.enabled_tools),
    toolManifestDigest: sha256Digest(row.tool_manifest_digest),
    forkTurns: parseForkValue(row.fork_turns),
    turnOrdinal: row.turn_ordinal,
    ...(history === undefined ? {} : { history }),
  });
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
    if (!validIdentifier(input.rootAgentThreadId)) return { outcome: "conflict" };
    try {
      return await withRetriedSerializableTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return { outcome: "not_authorized" } as const;
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
          if (inserted.rowCount !== 1) {
            const existing = await client.query<{ kind: string; canonical_path: string }>(
              `SELECT kind,canonical_path FROM runtime_agent_threads
                WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3`,
              [input.fence.scope.tenantId, input.attemptId, input.rootAgentThreadId],
            );
            if (existing.rows[0]?.kind !== "root" || existing.rows[0]?.canonical_path !== "/root") {
              return { outcome: "conflict" } as const;
            }
          }
          const conversations = await client.query<ConversationRow>(
            `SELECT agent_thread_id,canonical_path,task,current_task,enabled_tools,tool_manifest_digest,
                    fork_turns,turn_ordinal,history,history_digest
               FROM runtime_subagent_conversations
              WHERE tenant_id=$1 AND thread_id=$2
              ORDER BY canonical_path`,
            [input.fence.scope.tenantId, input.fence.scope.threadId],
          );
          await client.query(
            `INSERT INTO runtime_agent_threads(
               tenant_id,thread_id,run_id,attempt_id,agent_thread_id,parent_agent_thread_id,
               canonical_path,kind,status,task,enabled_tools,fork_turns
             )
             SELECT conversation.tenant_id,conversation.thread_id,$3,$4,
                    conversation.agent_thread_id,$5,conversation.canonical_path,
                    'subagent','open',conversation.task,conversation.enabled_tools,
                    conversation.fork_turns
               FROM runtime_subagent_conversations conversation
              WHERE conversation.tenant_id=$1 AND conversation.thread_id=$2
             ON CONFLICT DO NOTHING`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              input.fence.scope.runId,
              input.attemptId,
              input.rootAgentThreadId,
            ],
          );
          return {
            outcome: "ready",
            conversations: Object.freeze(conversations.rows.map(conversationSnapshot)),
          } as const;
        },
      );
    } catch {
      return { outcome: "unavailable" };
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
            `${input.fence.scope.tenantId}:${input.fence.scope.threadId}:subagent-control`,
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
            `SELECT (
                      SELECT count(*)::text
                        FROM runtime_subagent_conversations
                       WHERE tenant_id=$1 AND thread_id=$2
                    ) AS total,
                    (
                      SELECT count(*)::text
                        FROM runtime_agent_turns
                       WHERE tenant_id=$1 AND attempt_id=$3
                         AND status IN ('queued','running')
                    ) AS active`,
            [input.fence.scope.tenantId, input.fence.scope.threadId, input.attemptId],
          );
          if (
            Number(capacity.rows[0]?.total) >= input.maxThreads ||
            Number(capacity.rows[0]?.active) >= input.maxActiveSubagents
          ) {
            return { outcome: "capacity" } as const;
          }
          const conversation = await client.query(
            `INSERT INTO runtime_subagent_conversations(
               tenant_id,thread_id,agent_thread_id,canonical_path,task,current_task,enabled_tools,
               tool_manifest_digest,fork_turns,turn_ordinal,history,history_digest
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12)
             ON CONFLICT DO NOTHING`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              snapshot.agentThreadId,
              snapshot.canonicalPath,
              snapshot.task,
              snapshot.task,
              JSON.stringify(snapshot.tools),
              snapshot.toolManifestDigest,
              forkValue(snapshot.forkTurns),
              snapshot.turnOrdinal,
              snapshot.history === undefined ? null : JSON.stringify(snapshot.history),
              snapshot.history?.digest ?? null,
            ],
          );
          if (conversation.rowCount !== 1) return { outcome: "conflict" } as const;
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
            `${input.fence.scope.tenantId}:${input.fence.scope.threadId}:subagent-control`,
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
          const conversation = await client.query<{ turn_ordinal: number }>(
            `SELECT turn_ordinal
               FROM runtime_subagent_conversations
              WHERE tenant_id=$1 AND thread_id=$2 AND agent_thread_id=$3
              FOR UPDATE`,
            [input.fence.scope.tenantId, input.fence.scope.threadId, input.agentThreadId],
          );
          if (conversation.rows[0]?.turn_ordinal !== input.turnOrdinal - 1) {
            return "conflict" as const;
          }
          const materialized = await client.query(
            `INSERT INTO runtime_agent_threads(
               tenant_id,thread_id,run_id,attempt_id,agent_thread_id,parent_agent_thread_id,
               canonical_path,kind,status,task,enabled_tools,fork_turns
             )
             SELECT conversation.tenant_id,conversation.thread_id,$4,$5,
                    conversation.agent_thread_id,$6,conversation.canonical_path,
                    'subagent','open',conversation.task,conversation.enabled_tools,
                    conversation.fork_turns
               FROM runtime_subagent_conversations conversation
              WHERE conversation.tenant_id=$1 AND conversation.thread_id=$2
                AND conversation.agent_thread_id=$3
             ON CONFLICT DO NOTHING`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              input.agentThreadId,
              input.fence.scope.runId,
              input.attemptId,
              input.callerAgentThreadId,
            ],
          );
          if (materialized.rowCount !== 1) {
            const existing = await client.query(
              `SELECT 1 FROM runtime_agent_threads
                WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND kind='subagent'`,
              [input.fence.scope.tenantId, input.attemptId, input.agentThreadId],
            );
            if (existing.rowCount !== 1) return "conflict" as const;
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
            `UPDATE runtime_subagent_conversations
                SET turn_ordinal=$4,current_task=$5,updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND thread_id=$2 AND agent_thread_id=$3`,
            [
              input.fence.scope.tenantId,
              input.fence.scope.threadId,
              input.agentThreadId,
              input.turnOrdinal,
              input.task,
            ],
          );
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
              WHERE turn_state.tenant_id=$1 AND turn_state.attempt_id=$2
                AND turn_state.agent_thread_id=$3 AND turn_state.agent_turn_id=$4`,
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
    if (
      (input.status === "completed" && input.history === undefined) ||
      (input.status !== "completed" && input.history !== undefined)
    ) {
      return "conflict";
    }
    try {
      return await withRetriedSerializableTenantTransaction(
        this.pool,
        { tenantId: input.fence.scope.tenantId },
        async (client) => {
          if (!(await lockActiveFence(client, input.fence, input.attemptId))) {
            return "not_authorized" as const;
          }
          if (input.status === "completed") {
            const conversation = await client.query(
              `SELECT 1 FROM runtime_subagent_conversations
                WHERE tenant_id=$1 AND thread_id=$2 AND agent_thread_id=$3
                FOR UPDATE`,
              [input.fence.scope.tenantId, input.fence.scope.threadId, input.agentThreadId],
            );
            if (conversation.rowCount !== 1) return "conflict" as const;
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
          if (updated.rowCount === 1) {
            if (input.status === "completed") {
              await client.query(
                `UPDATE runtime_subagent_conversations
                    SET history=$4::jsonb,history_digest=$5,updated_at=clock_timestamp()
                  WHERE tenant_id=$1 AND thread_id=$2 AND agent_thread_id=$3`,
                [
                  input.fence.scope.tenantId,
                  input.fence.scope.threadId,
                  input.agentThreadId,
                  JSON.stringify(input.history),
                  input.history?.digest,
                ],
              );
            }
            return "settled" as const;
          }
          const existing = await client.query<{ status: string; history_digest: string | null }>(
            `SELECT turn_state.status,conversation.history_digest
               FROM runtime_agent_turns turn_state
               LEFT JOIN runtime_subagent_conversations conversation
                 ON conversation.tenant_id=turn_state.tenant_id
                AND conversation.thread_id=$5
                AND conversation.agent_thread_id=turn_state.agent_thread_id
              WHERE tenant_id=$1 AND attempt_id=$2 AND agent_thread_id=$3 AND agent_turn_id=$4`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.agentThreadId,
              input.turnId,
              input.fence.scope.threadId,
            ],
          );
          return existing.rows[0]?.status === input.status &&
            (input.status !== "completed" ||
              existing.rows[0]?.history_digest === input.history?.digest)
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
            terminal_status: string | null;
            error_code: string | null;
            payload: string;
          }>(
            `SELECT sequence::text,recipient_agent_thread_id,sender_agent_thread_id,kind,
                    terminal_status,error_code,payload
               FROM runtime_agent_mailbox_messages
              WHERE tenant_id=$1 AND attempt_id=$2 AND command_id=$3`,
            [input.fence.scope.tenantId, input.attemptId, input.commandId],
          );
          const replayRow = replay.rows[0];
          if (replayRow !== undefined) {
            return replayRow.recipient_agent_thread_id === input.recipientAgentThreadId &&
              replayRow.sender_agent_thread_id === input.senderAgentThreadId &&
              replayRow.kind === input.kind &&
              replayRow.terminal_status === (input.terminalStatus ?? null) &&
              replayRow.error_code === (input.errorCode ?? null) &&
              replayRow.payload === input.payload
              ? ({ outcome: "replayed", sequence: Number(replayRow.sequence) } as const)
              : ({ outcome: "conflict" } as const);
          }
          const inserted = await client.query<{ sequence: string }>(
            `INSERT INTO runtime_agent_mailbox_messages(
               tenant_id,attempt_id,sequence,recipient_agent_thread_id,sender_agent_thread_id,
               kind,terminal_status,error_code,payload,command_id
             ) SELECT $1,$2,COALESCE(max(sequence),0)+1,$3,$4,$5,$6,$7,$8,$9
                 FROM runtime_agent_mailbox_messages
                WHERE tenant_id=$1 AND attempt_id=$2
             RETURNING sequence::text`,
            [
              input.fence.scope.tenantId,
              input.attemptId,
              input.recipientAgentThreadId,
              input.senderAgentThreadId,
              input.kind,
              input.terminalStatus ?? null,
              input.errorCode ?? null,
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
