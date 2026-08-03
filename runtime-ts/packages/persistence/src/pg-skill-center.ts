import { isoTimestamp } from "@cube-runtime/domain";
import type {
  SkillCatalogItem,
  SkillCatalogPage,
  SkillCenterPort,
  SkillConfigureResult,
  SkillInstallResult,
  SkillInstallation,
  SkillUninstallResult,
  TrustedSkillContext,
} from "@cube-runtime/skill";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

const canonicalKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const invocationNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

interface CatalogRow extends QueryResultRow {
  readonly canonical_key: string;
  readonly display_name: string;
  readonly publisher: string;
  readonly description: string;
  readonly recommended_version: string;
  readonly compatibility: string;
  readonly security_status: "verified" | "restricted";
}

interface InstallationRow extends QueryResultRow {
  readonly canonical_key: string;
  readonly display_name: string;
  readonly publisher: string;
  readonly description: string;
  readonly skill_version: string;
  readonly invocation_name: string;
  readonly status: "enabled" | "disabled";
  readonly version_token: string;
  readonly installed_at: Date | string;
  readonly updated_at: Date | string;
}

interface CommandRow extends QueryResultRow {
  readonly operation: "install" | "configure" | "uninstall";
  readonly request_digest: string;
  readonly result: unknown;
}

interface SkillVersionTarget extends QueryResultRow {
  readonly skill_id: string;
  readonly skill_version: string;
}

interface MutableInstallationRow extends QueryResultRow {
  readonly skill_id: string;
  readonly skill_version: string;
  readonly invocation_name: string;
  readonly status: "enabled" | "disabled" | "uninstalled";
  readonly version_token: string;
}

const installationProjection = `
  skill.canonical_key, skill.display_name, skill.publisher,
  version.description, installation.skill_version, installation.invocation_name,
  installation.status, installation.version_token,
  installation.installed_at, installation.updated_at`;

/**
 * Skill 目录是全局只读数据，安装关系只属于当前认证用户。所有访问仍携带 Tenant/User
 * 事务上下文，让 PostgreSQL RLS 在 Repository 之外再执行一次用户隔离。
 */
export class PgSkillCenterRepository implements SkillCenterPort {
  constructor(private readonly pool: Pool) {}

  async listCatalog(
    input: Parameters<SkillCenterPort["listCatalog"]>[0],
  ): Promise<SkillCatalogPage> {
    const command = snapshotCatalogInput(input);
    try {
      return await withTenantTransaction(
        this.pool,
        command.context,
        async (client) => {
          const result = await client.query<CatalogRow>(
            `SELECT skill.canonical_key, skill.display_name, skill.publisher,
                    version.description, skill.recommended_version,
                    version.compatibility, version.security_status
               FROM skills skill
               JOIN skill_versions version
                 ON version.skill_id=skill.id AND version.version=skill.recommended_version
              WHERE skill.status='active' AND version.status='available'
                AND ($1::text='' OR skill.canonical_key LIKE ($1 || '%') ESCAPE E'\\\\'
                     OR lower(skill.display_name) LIKE ('%' || $1 || '%') ESCAPE E'\\\\')
                AND ($2::text IS NULL OR skill.canonical_key > $2)
              ORDER BY skill.canonical_key ASC
              LIMIT $3`,
            [
              escapeLike(command.normalizedQuery),
              command.afterCanonicalKey ?? null,
              command.limit + 1,
            ],
          );
          const hasMore = result.rows.length > command.limit;
          const items = Object.freeze(result.rows.slice(0, command.limit).map(mapCatalogItem));
          const next = hasMore ? items.at(-1) : undefined;
          return Object.freeze({
            items,
            ...(next === undefined ? {} : { nextCanonicalKey: next.canonicalKey }),
          });
        },
        { readOnly: true },
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPersistenceError(error, "查询 Skill Center 目录");
    }
  }

  async listInstallations(input: Parameters<SkillCenterPort["listInstallations"]>[0]) {
    const context = snapshotContext(input.context);
    try {
      return await withTenantTransaction(
        this.pool,
        context,
        async (client) => {
          const result = await client.query<InstallationRow>(
            `SELECT ${installationProjection}
               FROM user_skill_installations installation
               JOIN skills skill ON skill.id=installation.skill_id
               JOIN skill_versions version
                 ON version.skill_id=installation.skill_id
                AND version.version=installation.skill_version
              WHERE installation.user_id=$1
                AND installation.status IN ('enabled', 'disabled')
              ORDER BY installation.invocation_name ASC`,
            [context.userId],
          );
          return Object.freeze(result.rows.map(mapInstallation));
        },
        { readOnly: true },
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPersistenceError(error, "查询用户 Skill 安装");
    }
  }

  async install(input: Parameters<SkillCenterPort["install"]>[0]): Promise<SkillInstallResult> {
    const command = snapshotInstallInput(input);
    try {
      return await withTenantTransaction(
        this.pool,
        command.context,
        async (client) => {
          await lockUserCommands(client, command.context.userId, command.idempotencyKey);
          const replay = await readCommand(client, command.context.userId, command.idempotencyKey);
          if (replay !== undefined) {
            if (replay.operation !== "install" || replay.request_digest !== command.requestDigest) {
              return { outcome: "key_conflict" };
            }
            return { outcome: "replayed", installation: installationFromResult(replay.result) };
          }

          const target = await resolveVersionTarget(
            client,
            command.canonicalKey,
            command.versionSelector,
          );
          if (target === undefined) return { outcome: "not_found" };
          const current = await findMutableInstallation(
            client,
            command.context.userId,
            target.skill_id,
          );
          if (current !== undefined && current.status !== "uninstalled") {
            return { outcome: "already_installed" };
          }
          if (await invocationNameExists(client, command.context.userId, command.invocationName)) {
            return { outcome: "name_conflict" };
          }
          if ((await activeInstallationCount(client, command.context.userId)) >= 64) {
            return { outcome: "limit_exceeded" };
          }

          if (current === undefined) {
            await client.query(
              `INSERT INTO user_skill_installations(
                 user_id,skill_id,skill_version,invocation_name,status,
                 version_token,installed_at,updated_at
               ) VALUES ($1,$2,$3,$4,'enabled',0,clock_timestamp(),clock_timestamp())`,
              [
                command.context.userId,
                target.skill_id,
                target.skill_version,
                command.invocationName,
              ],
            );
          } else {
            await client.query(
              `UPDATE user_skill_installations
                  SET skill_version=$3,invocation_name=$4,status='enabled',
                      version_token=version_token+1,
                      installed_at=clock_timestamp(),updated_at=clock_timestamp()
                WHERE user_id=$1 AND skill_id=$2`,
              [
                command.context.userId,
                target.skill_id,
                target.skill_version,
                command.invocationName,
              ],
            );
          }
          const installation = await requireInstallation(
            client,
            command.context.userId,
            target.skill_id,
          );
          await recordSuccessfulCommand(client, {
            userId: command.context.userId,
            key: command.idempotencyKey,
            operation: "install",
            requestDigest: command.requestDigest,
            result: installation,
          });
          await recordAudit(client, {
            userId: command.context.userId,
            eventId: `install:${command.idempotencyKey}`,
            skillId: target.skill_id,
            operation: "install",
            ...(current === undefined ? {} : { beforeStatus: current.status }),
            installation,
          });
          return { outcome: "installed", installation };
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPersistenceError(error, "安装 Skill");
    }
  }

  async configure(
    input: Parameters<SkillCenterPort["configure"]>[0],
  ): Promise<SkillConfigureResult> {
    const command = snapshotConfigureInput(input);
    try {
      return await withTenantTransaction(
        this.pool,
        command.context,
        async (client) => {
          await lockUserCommands(client, command.context.userId, command.idempotencyKey);
          const replay = await readCommand(client, command.context.userId, command.idempotencyKey);
          if (replay !== undefined) {
            if (
              replay.operation !== "configure" ||
              replay.request_digest !== command.requestDigest
            ) {
              return { outcome: "key_conflict" };
            }
            return { outcome: "replayed", installation: installationFromResult(replay.result) };
          }
          const skill = await findSkillByCanonicalKey(client, command.canonicalKey);
          if (skill === undefined) return { outcome: "not_found" };
          const current = await findMutableInstallation(
            client,
            command.context.userId,
            skill.skill_id,
          );
          if (current === undefined || current.status === "uninstalled") {
            return { outcome: "not_found" };
          }
          if (Number(current.version_token) !== command.expectedVersionToken) {
            return { outcome: "version_conflict" };
          }

          const mustResolveAvailableVersion =
            command.versionSelector !== undefined || command.enabled === true;
          const target = mustResolveAvailableVersion
            ? await resolveVersionTarget(
                client,
                command.canonicalKey,
                command.versionSelector ?? current.skill_version,
              )
            : undefined;
          if (mustResolveAvailableVersion && target === undefined) {
            return { outcome: "not_found" };
          }
          const version = target?.skill_version ?? current.skill_version;
          const invocationName = command.invocationName ?? current.invocation_name;
          const status =
            command.enabled === undefined
              ? current.status
              : command.enabled
                ? "enabled"
                : "disabled";
          if (
            invocationName !== current.invocation_name &&
            (await invocationNameExists(client, command.context.userId, invocationName))
          ) {
            return { outcome: "name_conflict" };
          }

          const changed =
            version !== current.skill_version ||
            invocationName !== current.invocation_name ||
            status !== current.status;
          if (changed) {
            const updated = await client.query(
              `UPDATE user_skill_installations
                  SET skill_version=$4,invocation_name=$5,status=$6,
                      version_token=version_token+1,updated_at=clock_timestamp()
                WHERE user_id=$1 AND skill_id=$2 AND version_token=$3
                  AND status IN ('enabled','disabled')`,
              [
                command.context.userId,
                skill.skill_id,
                command.expectedVersionToken,
                version,
                invocationName,
                status,
              ],
            );
            if (updated.rowCount !== 1) return { outcome: "version_conflict" };
          }
          const installation = await requireInstallation(
            client,
            command.context.userId,
            skill.skill_id,
          );
          await recordSuccessfulCommand(client, {
            userId: command.context.userId,
            key: command.idempotencyKey,
            operation: "configure",
            requestDigest: command.requestDigest,
            result: installation,
          });
          if (changed) {
            await recordAudit(client, {
              userId: command.context.userId,
              eventId: `configure:${command.idempotencyKey}`,
              skillId: skill.skill_id,
              operation: "configure",
              beforeStatus: current.status,
              installation,
            });
          }
          return { outcome: "updated", installation };
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPersistenceError(error, "配置 Skill 安装");
    }
  }

  async uninstall(
    input: Parameters<SkillCenterPort["uninstall"]>[0],
  ): Promise<SkillUninstallResult> {
    const command = snapshotUninstallInput(input);
    try {
      return await withTenantTransaction(
        this.pool,
        command.context,
        async (client) => {
          await lockUserCommands(client, command.context.userId, command.idempotencyKey);
          const replay = await readCommand(client, command.context.userId, command.idempotencyKey);
          if (replay !== undefined) {
            return replay.operation === "uninstall" &&
              replay.request_digest === command.requestDigest
              ? { outcome: "replayed" }
              : { outcome: "key_conflict" };
          }
          const skill = await findSkillByCanonicalKey(client, command.canonicalKey);
          if (skill === undefined) return { outcome: "not_found" };
          const current = await findMutableInstallation(
            client,
            command.context.userId,
            skill.skill_id,
          );
          if (current === undefined || current.status === "uninstalled") {
            return { outcome: "not_found" };
          }
          if (Number(current.version_token) !== command.expectedVersionToken) {
            return { outcome: "version_conflict" };
          }
          const updated = await client.query<{ readonly version_token: string }>(
            `UPDATE user_skill_installations
                SET status='uninstalled',version_token=version_token+1,updated_at=clock_timestamp()
              WHERE user_id=$1 AND skill_id=$2 AND version_token=$3
                AND status IN ('enabled','disabled')
              RETURNING version_token`,
            [command.context.userId, skill.skill_id, command.expectedVersionToken],
          );
          const updatedRow = updated.rows[0];
          if (updatedRow === undefined) return { outcome: "version_conflict" };
          await recordSuccessfulCommand(client, {
            userId: command.context.userId,
            key: command.idempotencyKey,
            operation: "uninstall",
            requestDigest: command.requestDigest,
            result: {},
          });
          await client.query(
            `INSERT INTO user_skill_installation_audits(
               user_id,event_id,skill_id,operation,before_status,after_status,
               skill_version,invocation_name,version_token,created_at
             ) VALUES ($1,$2,$3,'uninstall',$4,'uninstalled',$5,$6,$7,clock_timestamp())`,
            [
              command.context.userId,
              `uninstall:${command.idempotencyKey}`,
              skill.skill_id,
              current.status,
              current.skill_version,
              current.invocation_name,
              Number(updatedRow.version_token),
            ],
          );
          return { outcome: "uninstalled" };
        },
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPersistenceError(error, "卸载 Skill");
    }
  }
}

function snapshotContext(context: TrustedSkillContext): TrustedSkillContext {
  if (context.tenantId.length < 3 || context.userId.length < 3) {
    throw new TypeError("Skill 事务上下文无效");
  }
  return Object.freeze({ tenantId: context.tenantId, userId: context.userId });
}

function snapshotCatalogInput(input: Parameters<SkillCenterPort["listCatalog"]>[0]) {
  if (
    input.normalizedQuery !== input.normalizedQuery.trim().toLowerCase() ||
    Buffer.byteLength(input.normalizedQuery, "utf8") > 256 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.afterCanonicalKey !== undefined && !canonicalKeyPattern.test(input.afterCanonicalKey))
  ) {
    throw new TypeError("Skill 目录查询无效");
  }
  return Object.freeze({
    context: snapshotContext(input.context),
    normalizedQuery: input.normalizedQuery,
    limit: input.limit,
    ...(input.afterCanonicalKey === undefined
      ? {}
      : { afterCanonicalKey: input.afterCanonicalKey }),
  });
}

function snapshotInstallInput(input: Parameters<SkillCenterPort["install"]>[0]) {
  assertCommandBase(input);
  assertVersionSelector(input.versionSelector);
  if (!invocationNamePattern.test(input.invocationName)) {
    throw new TypeError("Skill 调用名称无效");
  }
  return Object.freeze({ ...input, context: snapshotContext(input.context) });
}

function snapshotConfigureInput(input: Parameters<SkillCenterPort["configure"]>[0]) {
  assertCommandBase(input);
  if (!Number.isSafeInteger(input.expectedVersionToken) || input.expectedVersionToken < 0) {
    throw new TypeError("Skill 版本令牌无效");
  }
  if (input.versionSelector !== undefined) assertVersionSelector(input.versionSelector);
  if (input.invocationName !== undefined && !invocationNamePattern.test(input.invocationName)) {
    throw new TypeError("Skill 调用名称无效");
  }
  return Object.freeze({ ...input, context: snapshotContext(input.context) });
}

function snapshotUninstallInput(input: Parameters<SkillCenterPort["uninstall"]>[0]) {
  assertCommandBase(input);
  if (!Number.isSafeInteger(input.expectedVersionToken) || input.expectedVersionToken < 0) {
    throw new TypeError("Skill 版本令牌无效");
  }
  return Object.freeze({ ...input, context: snapshotContext(input.context) });
}

function assertCommandBase(input: {
  readonly canonicalKey: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}): void {
  if (
    !canonicalKeyPattern.test(input.canonicalKey) ||
    !idempotencyKeyPattern.test(input.idempotencyKey) ||
    !digestPattern.test(input.requestDigest)
  ) {
    throw new TypeError("Skill 安装命令无效");
  }
}

function assertVersionSelector(value: string): void {
  if (value !== "recommended" && !versionPattern.test(value)) {
    throw new TypeError("Skill 版本选择无效");
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (matched) => `\\${matched}`);
}

function mapCatalogItem(row: CatalogRow): SkillCatalogItem {
  return Object.freeze({
    canonicalKey: row.canonical_key,
    displayName: row.display_name,
    publisher: row.publisher,
    description: row.description,
    recommendedVersion: row.recommended_version,
    compatibility: row.compatibility,
    securityStatus: row.security_status,
  });
}

function mapInstallation(row: InstallationRow): SkillInstallation {
  return Object.freeze({
    canonicalKey: row.canonical_key,
    displayName: row.display_name,
    publisher: row.publisher,
    description: row.description,
    skillVersion: row.skill_version,
    invocationName: row.invocation_name,
    status: row.status,
    versionToken: Number(row.version_token),
    installedAt: toTimestamp(row.installed_at),
    updatedAt: toTimestamp(row.updated_at),
  });
}

function toTimestamp(value: Date | string): ReturnType<typeof isoTimestamp> {
  return isoTimestamp(value instanceof Date ? value.toISOString() : new Date(value).toISOString());
}

async function lockUserCommands(
  client: PoolClient,
  userId: string,
  idempotencyKey: string,
): Promise<void> {
  // 用户级锁覆盖安装上限与调用名称唯一性；命令锁使同幂等键只产生一条审计事实。
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `skill-user|${userId}`,
  ]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `skill-command|${userId}|${idempotencyKey}`,
  ]);
}

async function readCommand(
  client: PoolClient,
  userId: string,
  key: string,
): Promise<CommandRow | undefined> {
  const result = await client.query<CommandRow>(
    `SELECT operation,request_digest,result
       FROM user_skill_installation_commands
      WHERE user_id=$1 AND idempotency_key=$2`,
    [userId, key],
  );
  return result.rows[0];
}

async function resolveVersionTarget(
  client: PoolClient,
  canonicalKey: string,
  selector: string,
): Promise<SkillVersionTarget | undefined> {
  const result = await client.query<SkillVersionTarget>(
    `SELECT skill.id AS skill_id, version.version AS skill_version
       FROM skills skill
       JOIN skill_versions version
         ON version.skill_id=skill.id
        AND version.version=CASE WHEN $2='recommended' THEN skill.recommended_version ELSE $2 END
      WHERE skill.canonical_key=$1 AND skill.status='active' AND version.status='available'`,
    [canonicalKey, selector],
  );
  return result.rows[0];
}

async function findSkillByCanonicalKey(
  client: PoolClient,
  canonicalKey: string,
): Promise<{ readonly skill_id: string } | undefined> {
  const result = await client.query<{ readonly skill_id: string }>(
    "SELECT id AS skill_id FROM skills WHERE canonical_key=$1",
    [canonicalKey],
  );
  return result.rows[0];
}

async function findMutableInstallation(
  client: PoolClient,
  userId: string,
  skillId: string,
): Promise<MutableInstallationRow | undefined> {
  const result = await client.query<MutableInstallationRow>(
    `SELECT skill_id,skill_version,invocation_name,status,version_token
       FROM user_skill_installations
      WHERE user_id=$1 AND skill_id=$2
      FOR UPDATE`,
    [userId, skillId],
  );
  return result.rows[0];
}

async function invocationNameExists(
  client: PoolClient,
  userId: string,
  invocationName: string,
): Promise<boolean> {
  const result = await client.query<{ readonly present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM user_skill_installations
        WHERE user_id=$1 AND invocation_name=$2 AND status IN ('enabled','disabled')
     ) AS present`,
    [userId, invocationName],
  );
  return result.rows[0]?.present === true;
}

async function activeInstallationCount(client: PoolClient, userId: string): Promise<number> {
  const result = await client.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM user_skill_installations
      WHERE user_id=$1 AND status IN ('enabled','disabled')`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function requireInstallation(
  client: PoolClient,
  userId: string,
  skillId: string,
): Promise<SkillInstallation> {
  const result = await client.query<InstallationRow>(
    `SELECT ${installationProjection}
       FROM user_skill_installations installation
       JOIN skills skill ON skill.id=installation.skill_id
       JOIN skill_versions version
         ON version.skill_id=installation.skill_id
        AND version.version=installation.skill_version
      WHERE installation.user_id=$1 AND installation.skill_id=$2
        AND installation.status IN ('enabled','disabled')`,
    [userId, skillId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new TypeError("Skill 安装提交后不可见");
  return mapInstallation(row);
}

async function recordSuccessfulCommand(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly key: string;
    readonly operation: CommandRow["operation"];
    readonly requestDigest: string;
    readonly result: SkillInstallation | Record<string, never>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO user_skill_installation_commands(
       user_id,idempotency_key,operation,request_digest,result,created_at
     ) VALUES ($1,$2,$3,$4,$5::jsonb,clock_timestamp())`,
    [input.userId, input.key, input.operation, input.requestDigest, JSON.stringify(input.result)],
  );
}

async function recordAudit(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly eventId: string;
    readonly skillId: string;
    readonly operation: "install" | "configure";
    readonly beforeStatus?: MutableInstallationRow["status"];
    readonly installation: SkillInstallation;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO user_skill_installation_audits(
       user_id,event_id,skill_id,operation,before_status,after_status,
       skill_version,invocation_name,version_token,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())`,
    [
      input.userId,
      input.eventId,
      input.skillId,
      input.operation,
      input.beforeStatus ?? null,
      input.installation.status,
      input.installation.skillVersion,
      input.installation.invocationName,
      input.installation.versionToken,
    ],
  );
}

function installationFromResult(result: unknown): SkillInstallation {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new TypeError("Skill 幂等结果无效");
  }
  const value = result as Record<string, unknown>;
  if (
    typeof value.canonicalKey !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.publisher !== "string" ||
    typeof value.description !== "string" ||
    typeof value.skillVersion !== "string" ||
    typeof value.invocationName !== "string" ||
    (value.status !== "enabled" && value.status !== "disabled") ||
    typeof value.versionToken !== "number" ||
    typeof value.installedAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new TypeError("Skill 幂等结果字段无效");
  }
  return Object.freeze({
    canonicalKey: value.canonicalKey,
    displayName: value.displayName,
    publisher: value.publisher,
    description: value.description,
    skillVersion: value.skillVersion,
    invocationName: value.invocationName,
    status: value.status,
    versionToken: value.versionToken,
    installedAt: isoTimestamp(value.installedAt),
    updatedAt: isoTimestamp(value.updatedAt),
  });
}
