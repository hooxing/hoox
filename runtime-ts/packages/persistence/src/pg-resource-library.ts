import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  isoTimestamp,
  type Resource,
  type ResourceId,
  type ResourceVersion,
  type ResourceVersionId,
  rehydrateResource,
  rehydrateResourceVersion,
  resourceId,
  resourceVersionId,
  sha256Digest,
  tenantId,
  userId,
} from "@hoox/domain";
import {
  type AuthorizedAgentResourceContext,
  assertResourceName,
  normalizeSearchQuery,
  normalizeWorkspaceRelativePath,
  type PromotionCapabilityVerifier,
  type ResourceCatalog,
  type ResourceCatalogItem,
  type ResourceCatalogPage,
  type TrustedResourceContext,
} from "@hoox/resource";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import { TransactionCommitUnknownError, withTenantTransaction } from "./postgres.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

interface ResourceRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly resource_id: string;
  readonly resource_name: string;
  readonly resource_origin: "upload" | "file_source" | "promoted_workspace" | "artifact";
  readonly resource_visibility: "pending_explicit_commit" | "searchable";
  readonly latest_version_number: number;
  readonly latest_version_id: string | null;
  readonly resource_created_at: Date;
  readonly resource_updated_at: Date;
  readonly version_id: string;
  readonly version_number: number;
  readonly parent_version_id: string | null;
  readonly physical_object_key: string;
  readonly digest: string;
  readonly media_type: string;
  readonly size: string;
  readonly version_created_at: Date;
}

interface AuthorizationRow extends QueryResultRow {
  readonly authorization_id: string;
  readonly user_id: string;
  readonly agent_thread_id: string;
  readonly thread_id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly revision_id: string;
  readonly writer_lease_epoch: string;
  readonly relative_path: string;
  readonly digest: string;
  readonly media_type: string;
  readonly size: string;
  readonly state: "active" | "consumed" | "revoked";
  readonly expires_at: Date;
}

interface PromotionExecutionBoundary {
  readonly threadId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly threadStatus: string;
  readonly run_status: string;
  readonly lease_root_run_id: string | null;
  readonly lease_epoch: string | null;
  readonly lease_expires_at: Date | null;
}

interface StableReferenceRow extends QueryResultRow {
  readonly reference_id: string;
  readonly state: "staged" | "stable";
  readonly purpose: string;
  readonly sha256: string;
  readonly size: string;
  readonly media_type: string;
  readonly lifecycle_id: string | null;
  readonly incarnation_id: string | null;
  readonly physical_object_key: string | null;
  readonly lifecycle_state: string | null;
  readonly current_incarnation_id: string | null;
  readonly incarnation_state: string | null;
}

interface IdempotencyRow extends QueryResultRow {
  readonly request_digest: string;
  readonly authorization_id: string;
  readonly resource_id: string;
  readonly resource_version_id: string;
}

export type ResourcePromotionCommitResult =
  | {
      readonly outcome: "committed" | "replayed";
      readonly resource: Resource;
      readonly version: ResourceVersion;
    }
  | {
      readonly outcome: "key_conflict" | "version_conflict" | "not_authorized" | "blob_unavailable";
    };

export interface ResourcePromotionCommitPort {
  commitPromotedVersion(input: {
    readonly context: TrustedResourceContext;
    readonly capability: unknown;
    readonly authorizationId: string;
    readonly idempotencyKey: string;
    readonly resourceId: ResourceId;
    readonly resourceVersionId: ResourceVersionId;
    readonly expectedLatestVersionNumber: number;
    readonly resourceName: string;
    readonly blobReferenceId: string;
  }): Promise<ResourcePromotionCommitResult>;
}

const resourceColumns = `
  r.tenant_id, r.id AS resource_id, r.name AS resource_name,
  r.origin AS resource_origin, r.visibility AS resource_visibility,
  r.latest_version_number, r.latest_version_id,
  r.created_at AS resource_created_at, r.updated_at AS resource_updated_at,
  v.id AS version_id, v.version_number, v.parent_version_id,
  v.physical_object_key, v.digest, v.media_type, v.size,
  v.created_at AS version_created_at`;

/**
 * Resource 目录只暴露应用核心需要的窄端口。Pool 保留在私有字段中，调用方不能取得
 * 任意 SQL 能力；每次查询仍在事务级可信 Tenant/User 上下文中由 RLS 二次隔离。
 */
export class PgResourceCatalog implements ResourceCatalog {
  constructor(private readonly pool: Pool) {}

  async search(input: {
    readonly context: TrustedResourceContext;
    readonly normalizedQuery: string;
    readonly limit: number;
    readonly after?: {
      readonly updatedAt: ReturnType<typeof isoTimestamp>;
      readonly resourceId: ResourceId;
    };
  }): Promise<ResourceCatalogPage> {
    const command = snapshotSearchCommand(input);
    const query = normalizeSearchQuery(command.normalizedQuery);
    if (query !== command.normalizedQuery) throw new TypeError("Resource 查询必须已经规范化");
    if (!Number.isSafeInteger(command.limit) || command.limit < 1 || command.limit > 1_000) {
      throw new TypeError("Resource 查询页大小无效");
    }
    const after = command.after;
    const escapedQuery = escapeLikePrefix(query);
    try {
      return await withTenantTransaction(
        this.pool,
        command.context,
        async (client) => {
          const result = await client.query<ResourceRow>(
            `SELECT ${resourceColumns}
               FROM resources r
               JOIN resource_versions v
                 ON v.tenant_id = r.tenant_id
                AND v.resource_id = r.id
                AND v.id = r.latest_version_id
              WHERE r.tenant_id = $1
                AND r.visibility = 'searchable'
                AND EXISTS (
                  SELECT 1 FROM memberships membership
                   WHERE membership.tenant_id = r.tenant_id
                     AND membership.user_id = $6
                     AND membership.status = 'active'
                )
                AND ($2::text = '' OR r.normalized_name LIKE ($2 || '%') ESCAPE E'\\\\')
                AND (
                  $3::timestamptz IS NULL
                  OR r.updated_at < $3::timestamptz
                  OR (r.updated_at = $3::timestamptz AND r.id < $4::text)
                )
              ORDER BY r.updated_at DESC, r.id DESC
              LIMIT $5`,
            [
              command.context.tenantId,
              escapedQuery,
              after?.updatedAt ?? null,
              after?.resourceId ?? null,
              command.limit,
              command.context.userId,
            ],
          );
          const items = Object.freeze(result.rows.map(mapCatalogItem));
          const last = items.at(-1);
          return Object.freeze({
            items,
            ...(last === undefined
              ? {}
              : {
                  nextPosition: Object.freeze({
                    updatedAt: last.updatedAt,
                    resourceId: last.resourceId,
                  }),
                }),
          });
        },
        { readOnly: true },
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPersistenceError(error, "查询 Resource 目录");
    }
  }

  async resolveVersion(input: {
    readonly context: TrustedResourceContext;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
  }): Promise<
    | { readonly status: "found"; readonly resource: Resource; readonly version: ResourceVersion }
    | { readonly status: "not_found" }
  > {
    const command = snapshotResolveCommand(input);
    try {
      return await withTenantTransaction(
        this.pool,
        command.context,
        async (client) => {
          const row = await findResourceVersion(
            client,
            command.context.tenantId,
            command.resourceId,
            command.versionId,
            true,
            command.context.userId,
          );
          if (row === undefined) return { status: "not_found" as const };
          const mapped = mapResourceAndVersion(row);
          return Object.freeze({ status: "found" as const, ...mapped });
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析 Resource 版本");
    }
  }
}

/**
 * 显式提升只消费 Workspace 事实源签发并持久化的窄授权。当前切片不提供授权写入 API；
 * 在逐文件 Workspace Manifest 尚未落库前，公开调用不能凭路径或摘要自行伪造授权。
 */
export class PgResourcePromotionRepository implements ResourcePromotionCommitPort {
  private readonly verifyCapability: PromotionCapabilityVerifier["verify"];

  constructor(
    private readonly pool: Pool,
    promotionCapabilities: PromotionCapabilityVerifier,
  ) {
    this.verifyCapability = snapshotPromotionCapabilityVerifier(promotionCapabilities);
  }

  async commitPromotedVersion(
    input: Parameters<ResourcePromotionCommitPort["commitPromotedVersion"]>[0],
  ): Promise<ResourcePromotionCommitResult> {
    const canonical = validatePromotionInput(input, this.verifyCapability);
    const requestDigest = promotionRequestDigest(canonical);
    try {
      return await withTenantTransaction(this.pool, canonical.scope, async (client) => {
        // 幂等键与 Resource ID 都用事务 advisory lock，覆盖“尚不存在行”的并发首写。
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `resource-idempotency|${canonical.scope.tenantId}|${canonical.scope.userId}|${canonical.idempotencyKey}`,
        ]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `resource-head|${canonical.scope.tenantId}|${canonical.resourceId}`,
        ]);
        const replay = await findIdempotency(client, canonical.scope, canonical.idempotencyKey);
        if (replay !== undefined) {
          return replayCommitted(client, canonical, requestDigest, replay);
        }

        if (!(await lockActiveMembership(client, canonical.scope))) {
          return { outcome: "not_authorized" as const };
        }
        const authorizationSnapshot = await findAuthorization(
          client,
          canonical.scope,
          canonical.authorizationId,
          false,
        );
        if (authorizationSnapshot === undefined) {
          return { outcome: "not_authorized" as const };
        }
        const boundary = await lockPromotionExecutionBoundary(
          client,
          canonical.scope.tenantId,
          authorizationSnapshot,
        );
        if (boundary === undefined) return { outcome: "not_authorized" as const };
        const authorization = await findAuthorization(
          client,
          canonical.scope,
          canonical.authorizationId,
          true,
        );
        if (!authorizationAllowsCommit(authorization, boundary, canonical.scope)) {
          return { outcome: "not_authorized" as const };
        }
        const stable = await findStableReferenceForUpdate(
          client,
          canonical.scope.tenantId,
          canonical.blobReferenceId,
        );
        if (!stableMatchesAuthorization(stable, authorization)) {
          return { outcome: "blob_unavailable" as const };
        }

        const existing = await client.query<{
          latest_version_number: number;
          name: string;
          origin: string;
          visibility: string;
        }>(
          `SELECT latest_version_number, name, origin, visibility
             FROM resources WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [canonical.scope.tenantId, canonical.resourceId],
        );
        const current = snapshotResourceHeadRow(existing.rows[0]);
        if (canonical.expectedLatestVersionNumber === 0) {
          if (current !== undefined) return { outcome: "version_conflict" as const };
        } else if (
          current === undefined ||
          current.latest_version_number !== canonical.expectedLatestVersionNumber ||
          current.name !== canonical.resourceName ||
          current.origin !== "promoted_workspace" ||
          current.visibility !== "searchable"
        ) {
          return { outcome: "version_conflict" as const };
        }

        // Resource head 是最后一个可能阻塞的业务锁。重新读取数据库时钟后，TTL 与 lease
        // 不能再使用锁等待前的快照；最终消费 UPDATE 还会在 SQL 内用更晚的时钟复核。
        const freshNow = await readDatabaseClock(client);
        if (!authorizationWithinFreshTime(authorization, boundary, freshNow)) {
          return { outcome: "not_authorized" as const };
        }
        const consumed = await consumePromotionAuthorization(
          client,
          canonical.scope,
          authorization,
        );
        if (!consumed) return { outcome: "not_authorized" as const };

        if (canonical.expectedLatestVersionNumber === 0) {
          await client.query(
            `INSERT INTO resources(
               tenant_id, id, name, normalized_name, origin, visibility,
               latest_version_number, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, 'promoted_workspace', 'pending_explicit_commit', 0,
                       clock_timestamp(), clock_timestamp())`,
            [
              canonical.scope.tenantId,
              canonical.resourceId,
              canonical.resourceName,
              normalizeSearchQuery(canonical.resourceName),
            ],
          );
        }

        const nextVersionNumber = canonical.expectedLatestVersionNumber + 1;
        const parentVersionId =
          canonical.expectedLatestVersionNumber === 0
            ? null
            : await currentHeadId(client, canonical.scope.tenantId, canonical.resourceId);
        if (canonical.expectedLatestVersionNumber > 0 && parentVersionId === undefined) {
          throw new Error("Resource head 不完整");
        }
        await client.query(
          `INSERT INTO resource_versions(
             tenant_id, resource_id, id, version_number, parent_version_id,
             blob_reference_id, blob_purpose, blob_lifecycle_id, blob_incarnation_id,
             physical_object_key, digest, media_type, size, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,'resource',$7,$8,$9,$10,$11,$12,clock_timestamp())`,
          [
            canonical.scope.tenantId,
            canonical.resourceId,
            canonical.resourceVersionId,
            nextVersionNumber,
            parentVersionId ?? null,
            stable.reference_id,
            stable.lifecycle_id,
            stable.incarnation_id,
            stable.physical_object_key,
            stable.sha256,
            normalizeMediaType(stable.media_type),
            stable.size,
          ],
        );
        const advanced = await client.query(
          `UPDATE resources
              SET latest_version_number = $3, latest_version_id = $4,
                  visibility = 'searchable', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND id = $2 AND latest_version_number = $5`,
          [
            canonical.scope.tenantId,
            canonical.resourceId,
            nextVersionNumber,
            canonical.resourceVersionId,
            canonical.expectedLatestVersionNumber,
          ],
        );
        // 前面已经持有 Resource 行锁；若 CAS 仍失败，事实源已不连续，必须回滚刚插入的版本。
        if (advanced.rowCount !== 1) throw new Error("Resource head CAS 未推进");
        await client.query(
          `INSERT INTO resource_promotion_idempotency(
             tenant_id, user_id, idempotency_key, request_digest,
             authorization_id, resource_id, resource_version_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            canonical.scope.tenantId,
            canonical.scope.userId,
            canonical.idempotencyKey,
            requestDigest,
            canonical.authorizationId,
            canonical.resourceId,
            canonical.resourceVersionId,
          ],
        );
        const stored = await findResourceVersion(
          client,
          canonical.scope.tenantId,
          canonical.resourceId,
          canonical.resourceVersionId,
          true,
        );
        if (stored === undefined) throw new Error("Resource 提交后无法读回");
        return Object.freeze({ outcome: "committed" as const, ...mapResourceAndVersion(stored) });
      });
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError) {
        return this.resolveCommitUnknown(canonical, requestDigest);
      }
      if (error instanceof TypeError) throw error;
      throw mapPersistenceError(error, "提交 Resource 提升");
    }
  }

  private async resolveCommitUnknown(
    input: CanonicalPromotionInput,
    requestDigest: string,
  ): Promise<ResourcePromotionCommitResult> {
    try {
      const resolved = await withTenantTransaction(this.pool, input.scope, async (client) => {
        const record = await findIdempotency(client, input.scope, input.idempotencyKey);
        if (record === undefined) return undefined;
        return replayCommitted(client, input, requestDigest, record);
      });
      if (resolved === undefined) {
        throw new PersistenceError("UNAVAILABLE", "Resource 提交结果仍未知");
      }
      return resolved;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw mapPersistenceError(error, "解析 Resource 提交结果");
    }
  }
}

interface CanonicalPromotionInput {
  readonly scope: AuthorizedAgentResourceContext;
  readonly authorizationId: string;
  readonly idempotencyKey: string;
  readonly resourceId: ResourceId;
  readonly resourceVersionId: ResourceVersionId;
  readonly expectedLatestVersionNumber: number;
  readonly resourceName: string;
  readonly blobReferenceId: string;
}

function validatePromotionInput(
  input: Parameters<ResourcePromotionCommitPort["commitPromotedVersion"]>[0],
  verifyCapability: PromotionCapabilityVerifier["verify"],
): CanonicalPromotionInput {
  const snapshot = snapshotPromotionCommand(input);
  const context = snapshotTrustedContext(snapshot.context);
  const verified = safelyVerifyCapability(verifyCapability, snapshot.capability);
  const scope = snapshotAuthorizedAgentContext(verified);
  if (scope.tenantId !== context.tenantId || scope.userId !== context.userId) {
    throw new TypeError("Resource 提升能力与认证上下文不一致");
  }
  resourceId(snapshot.resourceId);
  resourceVersionId(snapshot.resourceVersionId);
  if (!AUTHORIZATION_ID_PATTERN.test(snapshot.authorizationId)) {
    throw new TypeError("Resource 提升授权 ID 格式无效");
  }
  if (!OPERATION_KEY_PATTERN.test(snapshot.idempotencyKey)) {
    throw new TypeError("Resource 提升幂等键格式无效");
  }
  if (!ID_PATTERN.test(snapshot.blobReferenceId) && !isUuid(snapshot.blobReferenceId)) {
    throw new TypeError("Resource Blob 引用 ID 格式无效");
  }
  if (
    !Number.isSafeInteger(snapshot.expectedLatestVersionNumber) ||
    snapshot.expectedLatestVersionNumber < 0
  ) {
    throw new TypeError("Resource 预期版本号无效");
  }
  return Object.freeze({
    scope,
    authorizationId: snapshot.authorizationId,
    idempotencyKey: snapshot.idempotencyKey,
    resourceId: resourceId(snapshot.resourceId),
    resourceVersionId: resourceVersionId(snapshot.resourceVersionId),
    expectedLatestVersionNumber: snapshot.expectedLatestVersionNumber,
    resourceName: assertResourceName(snapshot.resourceName),
    blobReferenceId: snapshot.blobReferenceId,
  });
}

function promotionRequestDigest(input: CanonicalPromotionInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        authorizationId: input.authorizationId,
        blobReferenceId: input.blobReferenceId,
        expectedLatestVersionNumber: input.expectedLatestVersionNumber,
        resourceId: input.resourceId,
        resourceName: input.resourceName,
        resourceVersionId: input.resourceVersionId,
        tenantId: input.scope.tenantId,
        userId: input.scope.userId,
        agentThreadId: input.scope.actor.agentThreadId,
        threadId: input.scope.actor.threadId,
        runId: input.scope.actor.runId,
      }),
      "utf8",
    )
    .digest("hex");
}

async function lockActiveMembership(
  client: PoolClient,
  scope: TrustedResourceContext,
): Promise<boolean> {
  const result = await client.query<{ lock_marker: boolean }>(
    `SELECT lock_marker FROM memberships
      WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
      FOR UPDATE`,
    [scope.tenantId, scope.userId],
  );
  return result.rows[0]?.lock_marker === false;
}

async function findAuthorization(
  client: PoolClient,
  scope: TrustedResourceContext,
  authorizationId: string,
  forUpdate: boolean,
): Promise<AuthorizationRow | undefined> {
  const result = await client.query<AuthorizationRow>(
    `SELECT a.authorization_id, a.user_id, a.agent_thread_id, a.thread_id,
            a.run_id, a.workspace_id, a.revision_id,
            a.writer_lease_epoch, a.relative_path, a.digest, a.media_type, a.size,
            a.state, a.expires_at
       FROM resource_promotion_authorizations a
      WHERE a.tenant_id = $1 AND a.authorization_id = $2 AND a.user_id = $3
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [scope.tenantId, authorizationId, scope.userId],
  );
  return snapshotAuthorizationRow(result.rows[0]);
}

async function lockPromotionExecutionBoundary(
  client: PoolClient,
  tenant: string,
  authorization: AuthorizationRow,
): Promise<PromotionExecutionBoundary | undefined> {
  // 与核心 Workspace 写路径一致：Thread → Run → Workspace → Lease。Revision 是不可变事实，
  // 只在父 Workspace 锁内重验存在性，避免归档、终态和 lease 变更穿过授权提交。
  const thread = await client.query<{ status: string }>(
    "SELECT status FROM threads WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [tenant, authorization.thread_id],
  );
  const run = await client.query<{ status: string }>(
    `SELECT status FROM runs
      WHERE tenant_id=$1 AND id=$2 AND thread_id=$3 FOR UPDATE`,
    [tenant, authorization.run_id, authorization.thread_id],
  );
  const workspace = await client.query<{ thread_id: string }>(
    `SELECT thread_id FROM workspaces
      WHERE tenant_id=$1 AND id=$2 AND thread_id=$3 FOR UPDATE`,
    [tenant, authorization.workspace_id, authorization.thread_id],
  );
  const revision = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM workspace_revisions
      WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND thread_id=$4`,
    [tenant, authorization.workspace_id, authorization.revision_id, authorization.thread_id],
  );
  const lease = await client.query<{
    root_run_id: string;
    epoch: string;
    expires_at: Date;
  }>(
    `SELECT root_run_id, epoch, expires_at
       FROM workspace_write_leases
      WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 FOR UPDATE`,
    [tenant, authorization.workspace_id, authorization.thread_id],
  );
  const threadRow = snapshotStatusRow(thread.rows[0]);
  const runRow = snapshotStatusRow(run.rows[0]);
  const workspaceRow = snapshotThreadRow(workspace.rows[0]);
  const revisionRow = snapshotExistenceRow(revision.rows[0]);
  const leaseRow = snapshotLeaseRow(lease.rows[0]);
  if (
    threadRow === undefined ||
    runRow === undefined ||
    workspaceRow === undefined ||
    revisionRow?.one !== 1 ||
    leaseRow === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    threadId: authorization.thread_id,
    runId: authorization.run_id,
    workspaceId: authorization.workspace_id,
    revisionId: authorization.revision_id,
    threadStatus: threadRow.status,
    run_status: runRow.status,
    lease_root_run_id: leaseRow.root_run_id,
    lease_epoch: leaseRow.epoch,
    lease_expires_at: leaseRow.expires_at,
  });
}

function authorizationAllowsCommit(
  row: AuthorizationRow | undefined,
  boundary: PromotionExecutionBoundary | undefined,
  scope: AuthorizedAgentResourceContext,
): row is AuthorizationRow {
  if (row === undefined || boundary === undefined) return false;
  const size = safeInteger(row.size, "授权大小");
  const epoch = safeInteger(row.writer_lease_epoch, "授权 lease epoch");
  const leaseEpoch =
    boundary.lease_epoch === null ? undefined : safeInteger(boundary.lease_epoch, "lease epoch");
  return (
    row.user_id === scope.userId &&
    row.agent_thread_id === scope.actor.agentThreadId &&
    row.thread_id === scope.actor.threadId &&
    row.run_id === scope.actor.runId &&
    row.thread_id === boundary.threadId &&
    row.run_id === boundary.runId &&
    row.workspace_id === boundary.workspaceId &&
    row.revision_id === boundary.revisionId &&
    row.state === "active" &&
    boundary.run_status === "running" &&
    boundary.threadStatus === "active" &&
    boundary.lease_root_run_id === row.run_id &&
    leaseEpoch === epoch &&
    normalizeWorkspaceRelativePath(row.relative_path) === row.relative_path &&
    /^[a-f0-9]{64}$/u.test(row.digest) &&
    size >= 0 &&
    normalizeMediaType(row.media_type) === row.media_type
  );
}

async function readDatabaseClock(client: PoolClient): Promise<Date> {
  const result = await client.query<{ database_now: Date }>(
    "SELECT clock_timestamp() AS database_now",
  );
  const row = snapshotDatabaseClockRow(result.rows[0]);
  if (row === undefined) throw new Error("数据库时钟读回为空");
  return row.databaseNow;
}

function authorizationWithinFreshTime(
  authorization: AuthorizationRow,
  boundary: PromotionExecutionBoundary,
  freshNow: Date,
): boolean {
  return (
    boundary.lease_expires_at !== null &&
    boundary.lease_expires_at.valueOf() > freshNow.valueOf() &&
    authorization.expires_at.valueOf() > freshNow.valueOf()
  );
}

async function consumePromotionAuthorization(
  client: PoolClient,
  scope: AuthorizedAgentResourceContext,
  authorization: AuthorizationRow,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE resource_promotion_authorizations AS auth
        SET state='consumed', consumed_at=clock_timestamp()
      WHERE auth.tenant_id=$1
        AND auth.authorization_id=$2
        AND auth.user_id=$3
        AND auth.agent_thread_id=$4
        AND auth.thread_id=$5
        AND auth.run_id=$6
        AND auth.workspace_id=$7
        AND auth.revision_id=$8
        AND auth.writer_lease_epoch=$9
        AND auth.state='active'
        AND auth.expires_at > clock_timestamp()
        AND EXISTS (
          SELECT 1 FROM workspace_write_leases lease
           WHERE lease.tenant_id=auth.tenant_id
             AND lease.workspace_id=auth.workspace_id
             AND lease.thread_id=auth.thread_id
             AND lease.root_run_id=auth.run_id
             AND lease.epoch=auth.writer_lease_epoch
             AND lease.expires_at > clock_timestamp()
        )`,
    [
      scope.tenantId,
      authorization.authorization_id,
      scope.userId,
      scope.actor.agentThreadId,
      scope.actor.threadId,
      scope.actor.runId,
      authorization.workspace_id,
      authorization.revision_id,
      authorization.writer_lease_epoch,
    ],
  );
  return result.rowCount === 1;
}

async function findStableReferenceForUpdate(
  client: PoolClient,
  tenant: string,
  referenceIdValue: string,
): Promise<StableReferenceRow | undefined> {
  // 与 Blob 生命周期 markReferenceStable 保持相同锁序：reference → lifecycle → incarnation。
  // GC 虽先锁 lifecycle，但只统计 reference 而不锁 reference，因此不会形成反向等待环。
  const referenceResult = await client.query<StableReferenceRow>(
    `SELECT reference.reference_id, reference.state, reference.purpose,
            reference.sha256, reference.size, reference.media_type,
            reference.lifecycle_id, reference.incarnation_id, reference.physical_object_key
       FROM blob_references reference
      WHERE reference.tenant_id = $1 AND reference.reference_id = $2
      FOR UPDATE`,
    [tenant, referenceIdValue],
  );
  const reference = snapshotStableReferenceRow(referenceResult.rows[0]);
  if (
    reference === undefined ||
    reference.lifecycle_id === null ||
    reference.incarnation_id === null ||
    reference.physical_object_key === null
  ) {
    return reference;
  }
  const lifecycleResult = await client.query<{
    state: string;
    current_incarnation_id: string | null;
  }>(
    `SELECT state, current_incarnation_id FROM blob_lifecycles
      WHERE tenant_id=$1 AND lifecycle_id=$2 AND purpose=$3 AND sha256=$4 AND size=$5
      FOR UPDATE`,
    [tenant, reference.lifecycle_id, reference.purpose, reference.sha256, reference.size],
  );
  const lifecycle = snapshotLifecycleRow(lifecycleResult.rows[0]);
  if (lifecycle === undefined) return reference;
  const incarnationResult = await client.query<{ state: string }>(
    `SELECT state FROM blob_incarnations
      WHERE tenant_id=$1 AND lifecycle_id=$2 AND incarnation_id=$3 AND physical_object_key=$4
      FOR UPDATE`,
    [tenant, reference.lifecycle_id, reference.incarnation_id, reference.physical_object_key],
  );
  const incarnation = snapshotIncarnationRow(incarnationResult.rows[0]);
  return Object.freeze({
    ...reference,
    lifecycle_state: lifecycle.state,
    current_incarnation_id: lifecycle.current_incarnation_id,
    incarnation_state: incarnation?.state ?? null,
  });
}

function stableMatchesAuthorization(
  stable: StableReferenceRow | undefined,
  authorization: AuthorizationRow,
): stable is StableReferenceRow & {
  readonly lifecycle_id: string;
  readonly incarnation_id: string;
  readonly physical_object_key: string;
} {
  if (stable === undefined) return false;
  return (
    stable.state === "stable" &&
    stable.purpose === "resource" &&
    stable.lifecycle_id !== null &&
    stable.incarnation_id !== null &&
    stable.physical_object_key !== null &&
    stable.lifecycle_state === "active" &&
    stable.current_incarnation_id === stable.incarnation_id &&
    stable.incarnation_state === "active" &&
    stable.sha256 === authorization.digest &&
    safeInteger(stable.size, "Blob 引用大小") === safeInteger(authorization.size, "授权大小") &&
    normalizeMediaType(stable.media_type) === normalizeMediaType(authorization.media_type)
  );
}

async function findIdempotency(
  client: PoolClient,
  scope: TrustedResourceContext,
  key: string,
): Promise<IdempotencyRow | undefined> {
  const result = await client.query<IdempotencyRow>(
    `SELECT request_digest, authorization_id, resource_id, resource_version_id
       FROM resource_promotion_idempotency
      WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3`,
    [scope.tenantId, scope.userId, key],
  );
  return snapshotIdempotencyRow(result.rows[0]);
}

async function replayCommitted(
  client: PoolClient,
  input: CanonicalPromotionInput,
  requestDigest: string,
  replay: IdempotencyRow,
): Promise<ResourcePromotionCommitResult> {
  if (replay.request_digest !== requestDigest) return { outcome: "key_conflict" };
  if (
    replay.authorization_id !== input.authorizationId ||
    replay.resource_id !== input.resourceId ||
    replay.resource_version_id !== input.resourceVersionId
  ) {
    throw new Error("Resource 幂等记录身份不连续");
  }
  const stored = await findResourceVersion(
    client,
    input.scope.tenantId,
    input.resourceId,
    input.resourceVersionId,
    true,
  );
  if (stored === undefined) throw new Error("Resource 幂等记录缺少已提交版本");
  return Object.freeze({ outcome: "replayed", ...mapResourceAndVersion(stored) });
}

async function currentHeadId(
  client: PoolClient,
  tenant: string,
  id: string,
): Promise<string | undefined> {
  const result = await client.query<{ latest_version_id: string | null }>(
    "SELECT latest_version_id FROM resources WHERE tenant_id = $1 AND id = $2",
    [tenant, id],
  );
  const row = snapshotCurrentHeadRow(result.rows[0]);
  return row?.latest_version_id ?? undefined;
}

async function findResourceVersion(
  client: PoolClient,
  tenant: string,
  id: string,
  versionIdValue: string,
  searchableOnly: boolean,
  authorizedUserId?: string,
): Promise<ResourceRow | undefined> {
  const result = await client.query<ResourceRow>(
    `SELECT ${resourceColumns}
       FROM resources r
       JOIN resource_versions v
         ON v.tenant_id = r.tenant_id AND v.resource_id = r.id
      WHERE r.tenant_id = $1 AND r.id = $2 AND v.id = $3
        AND ($4::boolean = false OR r.visibility = 'searchable')
        AND (
          $5::text IS NULL
          OR EXISTS (
            SELECT 1 FROM memberships membership
             WHERE membership.tenant_id = r.tenant_id
               AND membership.user_id = $5
               AND membership.status = 'active'
          )
        )`,
    [tenant, id, versionIdValue, searchableOnly, authorizedUserId ?? null],
  );
  return snapshotResourceRow(result.rows[0]);
}

function mapCatalogItem(row: ResourceRow): ResourceCatalogItem {
  const safe = snapshotResourceRow(row);
  if (safe === undefined) throw new DatabaseProtocolError();
  const versionNumber = safeInteger(safe.version_number, "Resource 版本号");
  const size = safeInteger(safe.size, "Resource 大小");
  return Object.freeze({
    tenantId: tenantId(safe.tenant_id),
    visibility: safe.resource_visibility,
    resourceId: resourceId(safe.resource_id),
    versionId: resourceVersionId(safe.version_id),
    versionNumber,
    name: safe.resource_name,
    origin: safe.resource_origin,
    mediaType: safe.media_type,
    sizeBytes: size,
    updatedAt: isoTimestamp(safe.resource_updated_at.toISOString()),
  });
}

function mapResourceAndVersion(row: ResourceRow): {
  readonly resource: Resource;
  readonly version: ResourceVersion;
} {
  const safe = snapshotResourceRow(row);
  if (safe === undefined) throw new DatabaseProtocolError();
  const expectedTenantId = tenantId(safe.tenant_id);
  const resource = rehydrateResource(
    {
      id: safe.resource_id,
      tenantId: safe.tenant_id,
      name: safe.resource_name,
      origin: safe.resource_origin,
      latestVersionNumber: safeInteger(safe.latest_version_number, "Resource latest 版本号"),
      latestVersionId: safe.latest_version_id ?? undefined,
      createdAt: safe.resource_created_at.toISOString(),
      updatedAt: safe.resource_updated_at.toISOString(),
    },
    expectedTenantId,
  );
  const version = rehydrateResourceVersion(
    {
      id: safe.version_id,
      resourceId: safe.resource_id,
      tenantId: safe.tenant_id,
      versionNumber: safeInteger(safe.version_number, "Resource 版本号"),
      parentVersionId: safe.parent_version_id ?? undefined,
      objectKey: safe.physical_object_key,
      digest: sha256Digest(safe.digest),
      mediaType: safe.media_type,
      sizeBytes: safeInteger(safe.size, "Resource 大小"),
      createdAt: safe.version_created_at.toISOString(),
    },
    resource,
  );
  return Object.freeze({ resource, version });
}

function databaseString(value: unknown): string {
  if (typeof value !== "string") throw new DatabaseProtocolError();
  return value;
}

function databaseNullableString(value: unknown): string | null {
  if (value === null) return null;
  return databaseString(value);
}

function databaseNumber(value: unknown): number {
  if (typeof value !== "number") throw new DatabaseProtocolError();
  return value;
}

function databaseDate(value: unknown): Date {
  if (!(value instanceof Date)) throw new DatabaseProtocolError();
  try {
    // 不调用未知对象可覆写的 valueOf；Date 内部槽不合法时统一转成稳定协议错误。
    const milliseconds = Date.prototype.getTime.call(value);
    if (Number.isNaN(milliseconds)) throw new DatabaseProtocolError();
    return new Date(milliseconds);
  } catch (error) {
    if (error instanceof DatabaseProtocolError) throw error;
    throw new DatabaseProtocolError();
  }
}

function snapshotIdempotencyRow(value: unknown): IdempotencyRow | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, [
    "request_digest",
    "authorization_id",
    "resource_id",
    "resource_version_id",
  ]);
  return Object.freeze({
    request_digest: databaseString(row.request_digest),
    authorization_id: databaseString(row.authorization_id),
    resource_id: databaseString(row.resource_id),
    resource_version_id: databaseString(row.resource_version_id),
  });
}

function snapshotStatusRow(value: unknown): { readonly status: string } | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["status"]);
  return Object.freeze({ status: databaseString(row.status) });
}

function snapshotThreadRow(value: unknown): { readonly thread_id: string } | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["thread_id"]);
  return Object.freeze({ thread_id: databaseString(row.thread_id) });
}

function snapshotExistenceRow(value: unknown): { readonly one: number } | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["one"]);
  return Object.freeze({ one: databaseNumber(row.one) });
}

function snapshotLeaseRow(value: unknown):
  | {
      readonly root_run_id: string;
      readonly epoch: string;
      readonly expires_at: Date;
    }
  | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["root_run_id", "epoch", "expires_at"]);
  return Object.freeze({
    root_run_id: databaseString(row.root_run_id),
    epoch: databaseString(row.epoch),
    expires_at: databaseDate(row.expires_at),
  });
}

function snapshotResourceHeadRow(value: unknown):
  | {
      readonly latest_version_number: number;
      readonly name: string;
      readonly origin: string;
      readonly visibility: string;
    }
  | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["latest_version_number", "name", "origin", "visibility"]);
  return Object.freeze({
    latest_version_number: databaseNumber(row.latest_version_number),
    name: databaseString(row.name),
    origin: databaseString(row.origin),
    visibility: databaseString(row.visibility),
  });
}

function snapshotCurrentHeadRow(
  value: unknown,
): { readonly latest_version_id: string | null } | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["latest_version_id"]);
  return Object.freeze({ latest_version_id: databaseNullableString(row.latest_version_id) });
}

function snapshotAuthorizationRow(value: unknown): AuthorizationRow | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, [
    "authorization_id",
    "user_id",
    "agent_thread_id",
    "thread_id",
    "run_id",
    "workspace_id",
    "revision_id",
    "writer_lease_epoch",
    "relative_path",
    "digest",
    "media_type",
    "size",
    "state",
    "expires_at",
  ]);
  return Object.freeze({
    authorization_id: databaseString(row.authorization_id),
    user_id: databaseString(row.user_id),
    agent_thread_id: databaseString(row.agent_thread_id),
    thread_id: databaseString(row.thread_id),
    run_id: databaseString(row.run_id),
    workspace_id: databaseString(row.workspace_id),
    revision_id: databaseString(row.revision_id),
    writer_lease_epoch: databaseString(row.writer_lease_epoch),
    relative_path: databaseString(row.relative_path),
    digest: databaseString(row.digest),
    media_type: databaseString(row.media_type),
    size: databaseString(row.size),
    state: databaseString(row.state) as AuthorizationRow["state"],
    expires_at: databaseDate(row.expires_at),
  });
}

function snapshotStableReferenceRow(value: unknown): StableReferenceRow | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, [
    "reference_id",
    "state",
    "purpose",
    "sha256",
    "size",
    "media_type",
    "lifecycle_id",
    "incarnation_id",
    "physical_object_key",
  ]);
  return Object.freeze({
    reference_id: databaseString(row.reference_id),
    state: databaseString(row.state) as StableReferenceRow["state"],
    purpose: databaseString(row.purpose),
    sha256: databaseString(row.sha256),
    size: databaseString(row.size),
    media_type: databaseString(row.media_type),
    lifecycle_id: databaseNullableString(row.lifecycle_id),
    incarnation_id: databaseNullableString(row.incarnation_id),
    physical_object_key: databaseNullableString(row.physical_object_key),
    lifecycle_state: null,
    current_incarnation_id: null,
    incarnation_state: null,
  });
}

function snapshotLifecycleRow(
  value: unknown,
): { readonly state: string; readonly current_incarnation_id: string | null } | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["state", "current_incarnation_id"]);
  return Object.freeze({
    state: databaseString(row.state),
    current_incarnation_id: databaseNullableString(row.current_incarnation_id),
  });
}

function snapshotIncarnationRow(value: unknown): { readonly state: string } | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["state"]);
  return Object.freeze({ state: databaseString(row.state) });
}

function snapshotDatabaseClockRow(value: unknown): { readonly databaseNow: Date } | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, ["database_now"]);
  return Object.freeze({ databaseNow: databaseDate(row.database_now) });
}

function snapshotResourceRow(value: unknown): ResourceRow | undefined {
  if (value === undefined) return undefined;
  const row = databaseRecord(value, [
    "tenant_id",
    "resource_id",
    "resource_name",
    "resource_origin",
    "resource_visibility",
    "latest_version_number",
    "latest_version_id",
    "resource_created_at",
    "resource_updated_at",
    "version_id",
    "version_number",
    "parent_version_id",
    "physical_object_key",
    "digest",
    "media_type",
    "size",
    "version_created_at",
  ]);
  return Object.freeze({
    tenant_id: databaseString(row.tenant_id),
    resource_id: databaseString(row.resource_id),
    resource_name: databaseString(row.resource_name),
    resource_origin: databaseString(row.resource_origin) as ResourceRow["resource_origin"],
    resource_visibility: databaseString(
      row.resource_visibility,
    ) as ResourceRow["resource_visibility"],
    latest_version_number: databaseNumber(row.latest_version_number),
    latest_version_id: databaseNullableString(row.latest_version_id),
    resource_created_at: databaseDate(row.resource_created_at),
    resource_updated_at: databaseDate(row.resource_updated_at),
    version_id: databaseString(row.version_id),
    version_number: databaseNumber(row.version_number),
    parent_version_id: databaseNullableString(row.parent_version_id),
    physical_object_key: databaseString(row.physical_object_key),
    digest: databaseString(row.digest),
    media_type: databaseString(row.media_type),
    size: databaseString(row.size),
    version_created_at: databaseDate(row.version_created_at),
  });
}

function normalizeMediaType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!MEDIA_TYPE_PATTERN.test(normalized)) throw new Error("Resource 媒体类型事实无效");
  return normalized;
}

function safeInteger(value: string | number, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label}事实无效`);
  return number;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

class InputSnapshotError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InputSnapshotError";
  }
}

class DatabaseProtocolError extends Error {
  constructor() {
    super("PostgreSQL Resource 结果格式无效");
    this.name = "DatabaseProtocolError";
  }
}

function dataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  failure: () => Error,
): Readonly<Record<string, unknown>> {
  try {
    if (utilTypes.isProxy(value) || typeof value !== "object" || value === null) throw failure();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw failure();
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (
      requiredKeys.some((key) => !Object.hasOwn(descriptors, key)) ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key))
    ) {
      throw failure();
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw failure();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof InputSnapshotError || error instanceof DatabaseProtocolError) throw error;
    throw failure();
  }
}

function inputRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return dataRecord(
    value,
    requiredKeys,
    optionalKeys,
    () => new InputSnapshotError("Resource 输入必须是无访问器的精确普通对象"),
  );
}

function databaseRecord(
  value: unknown,
  requiredKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  return dataRecord(value, requiredKeys, [], () => new DatabaseProtocolError());
}

function inputString(value: unknown): string {
  if (typeof value !== "string") throw new InputSnapshotError("Resource 输入字符串格式无效");
  return value;
}

function inputNumber(value: unknown): number {
  if (typeof value !== "number") throw new InputSnapshotError("Resource 输入数字格式无效");
  return value;
}

function snapshotTrustedContext(value: unknown): TrustedResourceContext {
  const record = inputRecord(value, ["tenantId", "userId"]);
  const tenant = inputString(record.tenantId);
  const user = inputString(record.userId);
  if (!ID_PATTERN.test(tenant) || !ID_PATTERN.test(user)) {
    throw new InputSnapshotError("Resource 认证上下文格式无效");
  }
  return Object.freeze({ tenantId: tenantId(tenant), userId: userId(user) });
}

function snapshotAuthorizedAgentContext(value: unknown): AuthorizedAgentResourceContext {
  const record = inputRecord(value, ["tenantId", "userId", "actor"]);
  const context = snapshotTrustedContext({
    tenantId: record.tenantId,
    userId: record.userId,
  });
  const actor = inputRecord(record.actor, ["kind", "agentThreadId", "threadId", "runId"]);
  const kind = inputString(actor.kind);
  const agentThread = inputString(actor.agentThreadId);
  const thread = inputString(actor.threadId);
  const run = inputString(actor.runId);
  if (
    kind !== "agent" ||
    !ID_PATTERN.test(agentThread) ||
    !ID_PATTERN.test(thread) ||
    !ID_PATTERN.test(run)
  ) {
    throw new InputSnapshotError("Resource Agent 执行上下文格式无效");
  }
  return Object.freeze({
    ...context,
    actor: Object.freeze({
      kind: "agent",
      agentThreadId: agentThread as AuthorizedAgentResourceContext["actor"]["agentThreadId"],
      threadId: thread as AuthorizedAgentResourceContext["actor"]["threadId"],
      runId: run as AuthorizedAgentResourceContext["actor"]["runId"],
    }),
  });
}

function snapshotPromotionCapabilityVerifier(
  value: PromotionCapabilityVerifier,
): PromotionCapabilityVerifier["verify"] {
  const record = inputRecord(value, ["verify"]);
  if (typeof record.verify !== "function") {
    throw new InputSnapshotError("Resource 提升能力 verifier 格式无效");
  }
  return record.verify as PromotionCapabilityVerifier["verify"];
}

function safelyVerifyCapability(
  verify: PromotionCapabilityVerifier["verify"],
  capability: unknown,
): AuthorizedAgentResourceContext | undefined {
  try {
    return Reflect.apply(verify, undefined, [capability]);
  } catch {
    throw new InputSnapshotError("Resource 提升能力验证失败");
  }
}

function snapshotSearchPosition(value: unknown): {
  readonly updatedAt: ReturnType<typeof isoTimestamp>;
  readonly resourceId: ResourceId;
} {
  const record = inputRecord(value, ["updatedAt", "resourceId"]);
  return Object.freeze({
    updatedAt: isoTimestamp(inputString(record.updatedAt)),
    resourceId: resourceId(inputString(record.resourceId)),
  });
}

function snapshotSearchCommand(value: unknown): {
  readonly context: TrustedResourceContext;
  readonly normalizedQuery: string;
  readonly limit: number;
  readonly after?: {
    readonly updatedAt: ReturnType<typeof isoTimestamp>;
    readonly resourceId: ResourceId;
  };
} {
  const record = inputRecord(value, ["context", "normalizedQuery", "limit"], ["after"]);
  const after = record.after;
  return Object.freeze({
    context: snapshotTrustedContext(record.context),
    normalizedQuery: inputString(record.normalizedQuery),
    limit: inputNumber(record.limit),
    ...(after === undefined ? {} : { after: snapshotSearchPosition(after) }),
  });
}

function snapshotResolveCommand(value: unknown): {
  readonly context: TrustedResourceContext;
  readonly resourceId: ResourceId;
  readonly versionId: ResourceVersionId;
} {
  const record = inputRecord(value, ["context", "resourceId", "versionId"]);
  return Object.freeze({
    context: snapshotTrustedContext(record.context),
    resourceId: resourceId(inputString(record.resourceId)),
    versionId: resourceVersionId(inputString(record.versionId)),
  });
}

function snapshotPromotionCommand(value: unknown): {
  readonly context: TrustedResourceContext;
  readonly capability: unknown;
  readonly authorizationId: string;
  readonly idempotencyKey: string;
  readonly resourceId: string;
  readonly resourceVersionId: string;
  readonly expectedLatestVersionNumber: number;
  readonly resourceName: string;
  readonly blobReferenceId: string;
} {
  const record = inputRecord(value, [
    "context",
    "capability",
    "authorizationId",
    "idempotencyKey",
    "resourceId",
    "resourceVersionId",
    "expectedLatestVersionNumber",
    "resourceName",
    "blobReferenceId",
  ]);
  return Object.freeze({
    context: snapshotTrustedContext(record.context),
    capability: record.capability,
    authorizationId: inputString(record.authorizationId),
    idempotencyKey: inputString(record.idempotencyKey),
    resourceId: inputString(record.resourceId),
    resourceVersionId: inputString(record.resourceVersionId),
    expectedLatestVersionNumber: inputNumber(record.expectedLatestVersionNumber),
    resourceName: inputString(record.resourceName),
    blobReferenceId: inputString(record.blobReferenceId),
  });
}

function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
