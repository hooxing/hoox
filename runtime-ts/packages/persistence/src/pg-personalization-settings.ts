import {
  assertRunPersonalizationSnapshot,
  normalizePersonalizationContent,
  type RunPersonalizationSnapshot,
} from "@aisay/domain";
import type { Pool, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import type {
  PersonalPersonalizationView,
  PersonalizationSettingsPort,
  PersonalizationUpdateResult,
  RunPersonalizationReadPort,
  TeamPersonalizationView,
  TenantScope,
} from "./ports.js";
import { withTenantTransaction } from "./postgres.js";

interface PersonalRow extends QueryResultRow {
  readonly content: string;
  readonly apply_to_team_tasks: boolean;
  readonly version: string;
  readonly updated_at: Date | string;
}

interface TeamRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly content: string | null;
  readonly version: string | null;
  readonly updated_at: Date | string | null;
  readonly role: "owner" | "admin" | "member";
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("个性化版本无效");
  return version;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPersonal(row: PersonalRow | undefined): PersonalPersonalizationView {
  if (row === undefined) {
    return Object.freeze({ content: "", applyToTeamTasks: true, version: 0 });
  }
  return Object.freeze({
    content: normalizePersonalizationContent(row.content),
    applyToTeamTasks: row.apply_to_team_tasks,
    version: safeVersion(row.version),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapTeam(row: TeamRow): TeamPersonalizationView {
  const canEdit = row.role === "owner" || row.role === "admin";
  if (row.content === null || row.version === null || row.updated_at === null) {
    return Object.freeze({
      teamId: row.tenant_id as TeamPersonalizationView["teamId"],
      content: "",
      version: 0,
      canEdit,
    });
  }
  return Object.freeze({
    teamId: row.tenant_id as TeamPersonalizationView["teamId"],
    content: normalizePersonalizationContent(row.content),
    version: safeVersion(row.version),
    canEdit,
    updatedAt: timestamp(row.updated_at),
  });
}

/**
 * 个人写入使用普通 Runtime；团队写入使用独立 Team Coordinator 连接。
 * Worker 只调用 resolveForRun，因此即使共享该实现也不会获得设置修改能力。
 */
export class PgPersonalizationSettingsRepository
  implements PersonalizationSettingsPort, RunPersonalizationReadPort
{
  constructor(
    private readonly runtimePool: Pool,
    private readonly teamMutationPool: Pool = runtimePool,
  ) {}

  async getPersonal(input: { readonly scope: TenantScope }): Promise<PersonalPersonalizationView> {
    try {
      return await withTenantTransaction(
        this.runtimePool,
        input.scope,
        async (client) => {
          const tenant = await client.query(
            `SELECT 1 FROM tenants
              WHERE id=$1 AND kind='personal' AND owner_user_id=$2`,
            [input.scope.tenantId, input.scope.userId],
          );
          if (tenant.rowCount === 0) throw new Error("个人 Tenant 不存在");
          const result = await client.query<PersonalRow>(
            `SELECT content,apply_to_team_tasks,version::text,updated_at
               FROM user_personalization_settings WHERE user_id=$1`,
            [input.scope.userId],
          );
          return mapPersonal(result.rows[0]);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取个人个性化设置");
    }
  }

  async updatePersonal(
    input: Parameters<PersonalizationSettingsPort["updatePersonal"]>[0],
  ): Promise<PersonalizationUpdateResult<PersonalPersonalizationView>> {
    const content = normalizePersonalizationContent(input.content);
    try {
      return await withTenantTransaction(this.runtimePool, input.scope, async (client) => {
        const result = await client.query<PersonalRow>(
          `INSERT INTO user_personalization_settings(
             user_id,content,apply_to_team_tasks,version,updated_at
           )
           SELECT $2,$3,$4,1,clock_timestamp()
             FROM tenants tenant
            WHERE tenant.id=$1 AND tenant.kind='personal' AND tenant.owner_user_id=$2
              AND $5::bigint=0
           ON CONFLICT(user_id) DO UPDATE SET
             content=EXCLUDED.content,
             apply_to_team_tasks=EXCLUDED.apply_to_team_tasks,
             version=user_personalization_settings.version+1,
             updated_at=clock_timestamp()
           WHERE user_personalization_settings.version=$5::bigint
           RETURNING content,apply_to_team_tasks,version::text,updated_at`,
          [
            input.scope.tenantId,
            input.scope.userId,
            content,
            input.applyToTeamTasks,
            input.expectedVersion,
          ],
        );
        const row = result.rows[0];
        if (row !== undefined) return { outcome: "succeeded", value: mapPersonal(row) } as const;
        const tenant = await client.query(
          `SELECT 1 FROM tenants
            WHERE id=$1 AND kind='personal' AND owner_user_id=$2`,
          [input.scope.tenantId, input.scope.userId],
        );
        return { outcome: tenant.rowCount === 0 ? "not_found" : "conflict" } as const;
      });
    } catch (error) {
      throw mapPersistenceError(error, "更新个人个性化设置");
    }
  }

  async getTeam(input: {
    readonly scope: TenantScope;
  }): Promise<TeamPersonalizationView | undefined> {
    try {
      return await withTenantTransaction(
        this.runtimePool,
        input.scope,
        async (client) => {
          const result = await client.query<TeamRow>(
            `SELECT tenant.id AS tenant_id,setting.content,setting.version::text,setting.updated_at,
                    actor.role
               FROM tenants tenant
               JOIN memberships actor ON actor.tenant_id=tenant.id
                AND actor.user_id=$2 AND actor.status='active'
               LEFT JOIN team_personalization_settings setting ON setting.tenant_id=tenant.id
              WHERE tenant.id=$1 AND tenant.kind='team'`,
            [input.scope.tenantId, input.scope.userId],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : mapTeam(row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取团队个性化设置");
    }
  }

  async updateTeam(
    input: Parameters<PersonalizationSettingsPort["updateTeam"]>[0],
  ): Promise<PersonalizationUpdateResult<TeamPersonalizationView>> {
    const content = normalizePersonalizationContent(input.content);
    try {
      return await withTenantTransaction(this.teamMutationPool, input.scope, async (client) => {
        const actor = await client.query<{ readonly role: "owner" | "admin" | "member" }>(
          `SELECT membership.role FROM tenants tenant
             JOIN memberships membership ON membership.tenant_id=tenant.id
              AND membership.user_id=$2 AND membership.status='active'
            WHERE tenant.id=$1 AND tenant.kind='team' FOR SHARE OF membership`,
          [input.scope.tenantId, input.scope.userId],
        );
        const role = actor.rows[0]?.role;
        if (role === undefined) return { outcome: "not_found" } as const;
        if (role === "member") return { outcome: "not_authorized" } as const;
        const result = await client.query<TeamRow>(
          `INSERT INTO team_personalization_settings(
             tenant_id,content,version,updated_by_user_id,updated_at
           ) VALUES ($1,$3,1,$2,clock_timestamp())
           ON CONFLICT(tenant_id) DO UPDATE SET
             content=EXCLUDED.content,
             version=team_personalization_settings.version+1,
             updated_by_user_id=EXCLUDED.updated_by_user_id,
             updated_at=clock_timestamp()
           WHERE team_personalization_settings.version=$4::bigint
           RETURNING tenant_id,content,version::text,updated_at,$5::text AS role`,
          [input.scope.tenantId, input.scope.userId, content, input.expectedVersion, role],
        );
        const row = result.rows[0];
        return row === undefined
          ? ({ outcome: "conflict" } as const)
          : ({ outcome: "succeeded", value: mapTeam(row) } as const);
      });
    } catch (error) {
      throw mapPersistenceError(error, "更新团队个性化设置");
    }
  }

  async resolveForRun(input: { readonly scope: TenantScope }): Promise<RunPersonalizationSnapshot> {
    try {
      return await withTenantTransaction(
        this.runtimePool,
        input.scope,
        async (client) => {
          const tenant = await client.query<{ readonly kind: "personal" | "team" }>(
            `SELECT tenant.kind FROM tenants tenant
               JOIN memberships membership ON membership.tenant_id=tenant.id
                AND membership.user_id=$2 AND membership.status='active'
              WHERE tenant.id=$1`,
            [input.scope.tenantId, input.scope.userId],
          );
          const kind = tenant.rows[0]?.kind;
          if (kind === undefined) throw new Error("Run 个性化作用域不存在");
          // 单个 PostgreSQL Client 上按序查询，避免把同一连接当作并行传输通道。
          const personal = await client.query<PersonalRow>(
            `SELECT content,apply_to_team_tasks,version::text,updated_at
               FROM user_personalization_settings WHERE user_id=$1`,
            [input.scope.userId],
          );
          const team =
            kind === "team"
              ? await client.query<TeamRow>(
                  `SELECT setting.tenant_id,setting.content,setting.version::text,setting.updated_at,
                          membership.role
                     FROM team_personalization_settings setting
                     JOIN memberships membership ON membership.tenant_id=setting.tenant_id
                      AND membership.user_id=$2 AND membership.status='active'
                    WHERE setting.tenant_id=$1`,
                  [input.scope.tenantId, input.scope.userId],
                )
              : { rows: [] as TeamRow[] };
          const personalView = mapPersonal(personal.rows[0]);
          const teamView = team.rows[0] === undefined ? undefined : mapTeam(team.rows[0]);
          return assertRunPersonalizationSnapshot({
            ...(teamView === undefined || teamView.content.length === 0
              ? {}
              : { team: { content: teamView.content, version: teamView.version } }),
            ...(personalView.content.length === 0 ||
            (kind === "team" && !personalView.applyToTeamTasks)
              ? {}
              : { user: { content: personalView.content, version: personalView.version } }),
          });
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取 Run 个性化快照");
    }
  }
}
