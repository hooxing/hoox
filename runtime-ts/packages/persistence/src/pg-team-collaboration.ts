import { digestCanonical } from "@hoox/run-contracts/mutation-protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import type {
  TeamCollaborationPort,
  TeamMemberView,
  TeamMutationResult,
  TeamSummaryView,
  ThreadForkPort,
} from "./ports.js";
import { withTenantTransaction } from "./postgres.js";
import { cancelThreadQueuedRun, lockThreadExecutionHead } from "./pg-thread-run-queue.js";

interface TeamDirectoryRow extends QueryResultRow {
  readonly team_id: string;
  readonly display_name: string;
  readonly role: "owner" | "admin" | "member";
  readonly joined_at: Date | string;
}

interface TeamMemberRow extends QueryResultRow {
  readonly membership_id: string;
  readonly user_id: string;
  readonly role: "owner" | "admin" | "member";
  readonly joined_at: Date | string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapSummary(row: TeamDirectoryRow): TeamSummaryView {
  return Object.freeze({
    id: row.team_id as TeamSummaryView["id"],
    displayName: row.display_name,
    role: row.role,
    joinedAt: timestamp(row.joined_at),
  });
}

function mapMember(row: TeamMemberRow): TeamMemberView {
  return Object.freeze({
    membershipId: row.membership_id,
    userId: row.user_id as TeamMemberView["userId"],
    role: row.role,
    joinedAt: timestamp(row.joined_at),
  });
}

async function actorRole(
  client: PoolClient,
  tenantId: string,
  userId: string,
  options: Readonly<{ lock?: boolean }> = {},
) {
  const lockClause = options.lock === false ? "" : " FOR SHARE";
  const result = await client.query<{ readonly role: "owner" | "admin" | "member" }>(
    `SELECT role FROM memberships
      WHERE tenant_id=$1 AND user_id=$2 AND status='active'${lockClause}`,
    [tenantId, userId],
  );
  return result.rows[0]?.role;
}

/** 团队目录只承担用户可见索引；Membership 始终是授权事实源。 */
export class PgTeamCollaborationRepository implements TeamCollaborationPort {
  constructor(private readonly pool: Pool) {}

  async listForUser(input: Parameters<TeamCollaborationPort["listForUser"]>[0]) {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const result = await client.query<TeamDirectoryRow>(
            `SELECT team_id,display_name,role,joined_at
               FROM team_member_directory
              WHERE user_id=$1 AND status='active'
              ORDER BY lower(display_name),team_id`,
            [input.scope.userId],
          );
          return Object.freeze(result.rows.map(mapSummary));
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "列出用户团队");
    }
  }

  async create(
    input: Parameters<TeamCollaborationPort["create"]>[0],
  ): Promise<TeamMutationResult<TeamSummaryView>> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const source = await client.query<{ readonly kind: string }>(
            `SELECT tenant.kind FROM tenants tenant
               JOIN memberships membership ON membership.tenant_id=tenant.id
                AND membership.user_id=$2 AND membership.status='active'
              WHERE tenant.id=$1`,
            [input.scope.tenantId, input.scope.userId],
          );
          if (source.rows[0]?.kind !== "personal") return { outcome: "not_authorized" } as const;
          await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.teamId]);
          await client.query(
            `INSERT INTO tenants(id,kind,display_name,created_by_user_id,created_at)
             VALUES ($1,'team',$2,$3,$4)`,
            [input.teamId, input.displayName, input.scope.userId, input.createdAt],
          );
          await client.query(
            `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
             VALUES ($1,$2,$3,'owner','active',$4)`,
            [input.teamId, input.membershipId, input.scope.userId, input.createdAt],
          );
          await client.query(
            `INSERT INTO team_member_directory(
               team_id,user_id,display_name,role,status,joined_at,updated_at
             ) VALUES ($1,$2,$3,'owner','active',$4,$4)`,
            [input.teamId, input.scope.userId, input.displayName, input.createdAt],
          );
          return {
            outcome: "succeeded",
            value: Object.freeze({
              id: input.teamId,
              displayName: input.displayName,
              role: "owner" as const,
              joinedAt: input.createdAt,
            }),
          } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      if (isCode(error, "23505")) return { outcome: "conflict" };
      throw mapPersistenceError(error, "创建团队");
    }
  }

  async listMembers(input: Parameters<TeamCollaborationPort["listMembers"]>[0]) {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          // 只读事务不能获取 PostgreSQL 行锁；成员列表仅需验证当前快照中的活跃身份。
          if (
            (await actorRole(client, input.scope.tenantId, input.scope.userId, { lock: false })) ===
            undefined
          ) {
            return undefined;
          }
          const result = await client.query<TeamMemberRow>(
            `SELECT id AS membership_id,user_id,role,created_at AS joined_at
               FROM memberships
              WHERE tenant_id=$1 AND status='active'
              ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,created_at,user_id`,
            [input.scope.tenantId],
          );
          return Object.freeze(result.rows.map(mapMember));
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "列出团队成员");
    }
  }

  async addMember(
    input: Parameters<TeamCollaborationPort["addMember"]>[0],
  ): Promise<TeamMutationResult<TeamMemberView>> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const actor = await actorRole(client, input.scope.tenantId, input.scope.userId);
          if (actor !== "owner" && actor !== "admin") return { outcome: "not_authorized" } as const;
          const team = await client.query<{ readonly display_name: string }>(
            "SELECT display_name FROM tenants WHERE id=$1 AND kind='team'",
            [input.scope.tenantId],
          );
          const displayName = team.rows[0]?.display_name;
          if (displayName === undefined) return { outcome: "not_found" } as const;
          const inserted = await client.query<TeamMemberRow>(
            `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
             VALUES ($1,$2,$3,$4,'active',$5)
             ON CONFLICT (tenant_id,user_id) DO UPDATE
               SET role=EXCLUDED.role,status='active'
               WHERE memberships.status='revoked'
             RETURNING id AS membership_id,user_id,role,created_at AS joined_at`,
            [
              input.scope.tenantId,
              input.membershipId,
              input.targetUserId,
              input.role,
              input.createdAt,
            ],
          );
          const member = inserted.rows[0];
          if (member === undefined) return { outcome: "conflict" } as const;
          await client.query(
            `INSERT INTO team_member_directory(
               team_id,user_id,display_name,role,status,joined_at,updated_at
             ) VALUES ($1,$2,$3,$4,'active',$5,$5)
             ON CONFLICT (team_id,user_id) DO UPDATE
               SET role=EXCLUDED.role,status='active',updated_at=EXCLUDED.updated_at
               WHERE team_member_directory.status='revoked'`,
            [input.scope.tenantId, input.targetUserId, displayName, input.role, input.createdAt],
          );
          return { outcome: "succeeded", value: mapMember(member) } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      if (isCode(error, "23503")) return { outcome: "user_not_found" };
      if (isCode(error, "23505")) return { outcome: "conflict" };
      throw mapPersistenceError(error, "添加团队成员");
    }
  }

  async changeRole(
    input: Parameters<TeamCollaborationPort["changeRole"]>[0],
  ): Promise<TeamMutationResult<TeamMemberView>> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const actor = await actorRole(client, input.scope.tenantId, input.scope.userId);
          if (actor !== "owner" && actor !== "admin") return { outcome: "not_authorized" } as const;
          const target = await client.query<TeamMemberRow>(
            `SELECT id AS membership_id,user_id,role,created_at AS joined_at
               FROM memberships
              WHERE tenant_id=$1 AND user_id=$2 AND status='active' FOR UPDATE`,
            [input.scope.tenantId, input.targetUserId],
          );
          const current = target.rows[0];
          if (current === undefined) return { outcome: "not_found" } as const;
          if (actor === "admin" && (current.role !== "member" || input.role === "owner")) {
            return { outcome: "not_authorized" } as const;
          }
          if (current.role === "owner" && input.role !== "owner") {
            const owners = await activeOwnerCount(client, input.scope.tenantId);
            if (owners <= 1) return { outcome: "last_owner" } as const;
          }
          await client.query(
            `UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2 AND status='active'`,
            [input.scope.tenantId, input.targetUserId, input.role],
          );
          await client.query(
            `UPDATE team_member_directory SET role=$3,updated_at=clock_timestamp()
              WHERE team_id=$1 AND user_id=$2 AND status='active'`,
            [input.scope.tenantId, input.targetUserId, input.role],
          );
          return {
            outcome: "succeeded",
            value: mapMember({ ...current, role: input.role }),
          } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      throw mapPersistenceError(error, "修改团队成员角色");
    }
  }

  async removeMember(
    input: Parameters<TeamCollaborationPort["removeMember"]>[0],
  ): Promise<TeamMutationResult<undefined>> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const actor = await actorRole(client, input.scope.tenantId, input.scope.userId);
          if (actor !== "owner" && actor !== "admin") return { outcome: "not_authorized" } as const;
          const target = await client.query<{ readonly role: "owner" | "admin" | "member" }>(
            `SELECT role FROM memberships
              WHERE tenant_id=$1 AND user_id=$2 AND status='active' FOR UPDATE`,
            [input.scope.tenantId, input.targetUserId],
          );
          const targetRole = target.rows[0]?.role;
          if (targetRole === undefined) return { outcome: "not_found" } as const;
          if (actor === "admin" && targetRole !== "member") {
            return { outcome: "not_authorized" } as const;
          }
          if (
            targetRole === "owner" &&
            (await activeOwnerCount(client, input.scope.tenantId)) <= 1
          ) {
            return { outcome: "last_owner" } as const;
          }
          await client.query(
            `UPDATE team_member_directory SET status='revoked',updated_at=clock_timestamp()
              WHERE team_id=$1 AND user_id=$2 AND status='active'`,
            [input.scope.tenantId, input.targetUserId],
          );
          await client.query(
            `UPDATE memberships SET status='revoked'
              WHERE tenant_id=$1 AND user_id=$2 AND status='active'`,
            [input.scope.tenantId, input.targetUserId],
          );
          return { outcome: "succeeded", value: undefined } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      throw mapPersistenceError(error, "移除团队成员");
    }
  }

  async dissolve(
    input: Parameters<TeamCollaborationPort["dissolve"]>[0],
  ): Promise<TeamMutationResult<undefined>> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          if ((await actorRole(client, input.scope.tenantId, input.scope.userId)) !== "owner") {
            return { outcome: "not_authorized" } as const;
          }
          await cancelTeamPendingWork(client, input.scope.tenantId);
          await client.query(
            `UPDATE team_member_directory SET status='revoked',updated_at=clock_timestamp()
              WHERE team_id=$1 AND status='active'`,
            [input.scope.tenantId],
          );
          // 解散是唯一可同时撤销最后一名 Owner 的状态迁移。
          await client.query(
            "UPDATE memberships SET status='revoked' WHERE tenant_id=$1 AND status='active'",
            [input.scope.tenantId],
          );
          return { outcome: "succeeded", value: undefined } as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解散团队");
    }
  }
}

interface NonterminalTeamRunRow extends QueryResultRow {
  readonly id: string;
}

/**
 * 解散必须先让投递与 Run 收敛，再撤销最后一个 Membership；否则 Worker 已无法装载聚合，
 * claimed dispatch 会持续 defer。锁序与普通 Run 终态保持 Thread → execution head → Run。
 */
async function cancelTeamPendingWork(client: PoolClient, tenantId: string): Promise<void> {
  // 先封停 outbox，避免持有 Run 锁后再等待迟到 ack 当前持有的 outbox 锁而形成反向等待。
  // state 与 claim shape 在同一次 UPDATE 中改变；任何旧 token/generation 的 ack 提交后只会 no-op。
  await cancelTeamDispatches(client, tenantId);

  const threads = await client.query<{ readonly id: string }>(
    `SELECT thread.id
       FROM threads thread
      WHERE thread.tenant_id=$1
        AND EXISTS (
          SELECT 1 FROM runs run
           WHERE run.tenant_id=thread.tenant_id AND run.thread_id=thread.id
             AND run.status IN ('queued','running','waiting')
        )
      ORDER BY thread.id
      FOR UPDATE OF thread`,
    [tenantId],
  );
  for (const thread of threads.rows) {
    // active Run 的取消会把尚未落定的 steer 转成 fallback Run；循环直到这些新 Run 也进入终态。
    for (;;) {
      const head = await lockThreadExecutionHead(client, tenantId, thread.id);
      const runs = await client.query<NonterminalTeamRunRow>(
        `SELECT run.id
           FROM runs run
          WHERE run.tenant_id=$1 AND run.thread_id=$2
            AND run.status IN ('queued','running','waiting')
          ORDER BY run.created_at,run.id
          FOR UPDATE OF run`,
        [tenantId, thread.id],
      );
      if (runs.rows.length === 0) break;
      await client.query(
        `UPDATE runs
            SET status='cancelled',version=version+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND thread_id=$2
            AND status IN ('queued','running','waiting')`,
        [tenantId, thread.id],
      );

      const orderedRuns =
        head?.active_run_id === null || head?.active_run_id === undefined
          ? runs.rows
          : [
              ...runs.rows.filter((run) => run.id === head.active_run_id),
              ...runs.rows.filter((run) => run.id !== head.active_run_id),
            ];
      for (const run of orderedRuns) {
        await cancelThreadQueuedRun(client, {
          tenantId,
          threadId: thread.id,
          runId: run.id,
        });
      }
    }
  }

  // settleActiveThreadRun 可能曾短暂为 steer fallback 新建 outbox；成员撤销前再做一次封口。
  await cancelTeamDispatches(client, tenantId);
  await client.query(
    `UPDATE worker_tenant_assignments
        SET state='idle',
            generation=CASE
              WHEN generation < 9007199254740991 THEN generation+1
              ELSE generation
            END,
            claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,
            next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=$1`,
    [tenantId],
  );
}

async function cancelTeamDispatches(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(
    `UPDATE run_dispatch_outbox
        SET state='cancelled',
            generation=CASE
              WHEN generation < 9007199254740991 THEN generation+1
              ELSE generation
            END,
            claim_token=NULL,claimed_by=NULL,lease_expires_at=NULL,
            last_error_code='team_dissolved',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND state IN ('ready','claimed')`,
    [tenantId],
  );
}

export class PgThreadForkRepository implements ThreadForkPort {
  constructor(private readonly pool: Pool) {}

  async seed(input: Parameters<ThreadForkPort["seed"]>[0]) {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const authorized = await client.query(
            `SELECT 1 FROM threads thread
               JOIN memberships membership ON membership.tenant_id=thread.tenant_id
                AND membership.user_id=$2 AND membership.status='active'
              WHERE thread.tenant_id=$1 AND thread.id=$3 AND thread.created_by_user_id=$2`,
            [input.scope.tenantId, input.scope.userId, input.childThreadId],
          );
          if (authorized.rowCount !== 1) return "not_authorized" as const;
          const lineage = await client.query(
            `INSERT INTO thread_forks(
               tenant_id,child_thread_id,source_tenant_id,source_thread_id,fork_kind,created_by_user_id
             ) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [
              input.scope.tenantId,
              input.childThreadId,
              input.sourceTenantId,
              input.sourceThreadId,
              input.kind,
              input.scope.userId,
            ],
          );
          // seed 事务要么完整提交、要么整体回滚；同一 child 的重放可直接视为完成。
          if (lineage.rowCount !== 1) return "seeded" as const;
          if (input.messages.length === 0) return "seeded" as const;
          await client.query(
            `INSERT INTO thread_context_streams(tenant_id,thread_id,next_sequence)
             VALUES ($1,$2,$3)
             ON CONFLICT (tenant_id,thread_id) DO UPDATE
               SET next_sequence=GREATEST(thread_context_streams.next_sequence,EXCLUDED.next_sequence),
                   updated_at=clock_timestamp()`,
            [input.scope.tenantId, input.childThreadId, input.messages.length + 1],
          );
          for (const [index, message] of input.messages.entries()) {
            const body = Object.freeze({ text: message.text, source: "thread_fork_snapshot" });
            await client.query(
              `INSERT INTO thread_context_entries(
                 tenant_id,thread_id,sequence,entry_id,kind,body_inline,body_sha256,body_size,occurred_at
               ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
              [
                input.scope.tenantId,
                input.childThreadId,
                index + 1,
                `fork:${input.childThreadId}:${index + 1}`,
                message.role === "user" ? "user_message" : "assistant_message",
                JSON.stringify(body),
                digestCanonical(body),
                Buffer.byteLength(JSON.stringify(body), "utf8"),
                message.createdAt,
              ],
            );
          }
          return "seeded" as const;
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      if (isCode(error, "23503")) return "not_found";
      throw mapPersistenceError(error, "创建任务分支快照");
    }
  }
}

async function activeOwnerCount(client: PoolClient, teamId: string): Promise<number> {
  const result = await client.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM memberships
      WHERE tenant_id=$1 AND status='active' AND role='owner'`,
    [teamId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
