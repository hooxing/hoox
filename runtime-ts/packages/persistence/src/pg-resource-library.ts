import { createHash } from "node:crypto";
import {
  isoTimestamp,
  rehydrateResource,
  rehydrateResourceVersion,
  resourceId,
  resourceVersionId,
  sha256Digest,
  tenantId,
  userId,
  type Resource,
  type ResourceId,
  type ResourceVersion,
  type ResourceVersionId,
} from "@cube-runtime/domain";
import {
  assertResourceName,
  normalizeSearchQuery,
  normalizeWorkspaceRelativePath,
  type AuthorizedAgentResourceContext,
  type ResourceCatalog,
  type ResourceCatalogItem,
  type ResourceCatalogPage,
  type TrustedResourceContext,
} from "@cube-runtime/resource";
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
  readonly database_now: Date;
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
    readonly scope: AuthorizedAgentResourceContext;
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
    assertScope(input.context);
    const query = normalizeSearchQuery(input.normalizedQuery);
    if (query !== input.normalizedQuery) throw new TypeError("Resource 查询必须已经规范化");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new TypeError("Resource 查询页大小无效");
    }
    if (input.after !== undefined) {
      isoTimestamp(input.after.updatedAt);
      resourceId(input.after.resourceId);
    }
    try {
      return await withTenantTransaction(
        this.pool,
        input.context,
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
                AND ($2::text = '' OR strpos(r.normalized_name, $2) > 0)
                AND (
                  $3::timestamptz IS NULL
                  OR r.updated_at < $3::timestamptz
                  OR (r.updated_at = $3::timestamptz AND r.id < $4::text)
                )
              ORDER BY r.updated_at DESC, r.id DESC
              LIMIT $5`,
            [
              input.context.tenantId,
              query,
              input.after?.updatedAt ?? null,
              input.after?.resourceId ?? null,
              input.limit,
              input.context.userId,
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
    assertScope(input.context);
    resourceId(input.resourceId);
    resourceVersionId(input.versionId);
    try {
      return await withTenantTransaction(
        this.pool,
        input.context,
        async (client) => {
          const row = await findResourceVersion(
            client,
            input.context.tenantId,
            input.resourceId,
            input.versionId,
            true,
            input.context.userId,
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
  constructor(private readonly pool: Pool) {}

  async commitPromotedVersion(
    input: Parameters<ResourcePromotionCommitPort["commitPromotedVersion"]>[0],
  ): Promise<ResourcePromotionCommitResult> {
    const canonical = validatePromotionInput(input);
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
        const current = existing.rows[0];
        if (canonical.expectedLatestVersionNumber === 0) {
          if (current !== undefined) return { outcome: "version_conflict" as const };
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
        } else if (
          current === undefined ||
          current.latest_version_number !== canonical.expectedLatestVersionNumber ||
          current.name !== canonical.resourceName ||
          current.origin !== "promoted_workspace" ||
          current.visibility !== "searchable"
        ) {
          return { outcome: "version_conflict" as const };
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
        const consumed = await client.query(
          `UPDATE resource_promotion_authorizations
              SET state = 'consumed', consumed_at = clock_timestamp()
            WHERE tenant_id = $1 AND authorization_id = $2 AND state = 'active'`,
          [canonical.scope.tenantId, canonical.authorizationId],
        );
        if (consumed.rowCount !== 1) throw new Error("Resource 提升授权消费失败");
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
): CanonicalPromotionInput {
  assertScope(input.scope);
  assertAgentScope(input.scope);
  resourceId(input.resourceId);
  resourceVersionId(input.resourceVersionId);
  if (!AUTHORIZATION_ID_PATTERN.test(input.authorizationId)) {
    throw new TypeError("Resource 提升授权 ID 格式无效");
  }
  if (!OPERATION_KEY_PATTERN.test(input.idempotencyKey)) {
    throw new TypeError("Resource 提升幂等键格式无效");
  }
  if (!ID_PATTERN.test(input.blobReferenceId) && !isUuid(input.blobReferenceId)) {
    throw new TypeError("Resource Blob 引用 ID 格式无效");
  }
  if (
    !Number.isSafeInteger(input.expectedLatestVersionNumber) ||
    input.expectedLatestVersionNumber < 0
  ) {
    throw new TypeError("Resource 预期版本号无效");
  }
  return Object.freeze({ ...input, resourceName: assertResourceName(input.resourceName) });
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

function assertScope(scope: TrustedResourceContext): void {
  if (
    typeof scope !== "object" ||
    scope === null ||
    !ID_PATTERN.test(scope.tenantId) ||
    !ID_PATTERN.test(scope.userId)
  ) {
    throw new TypeError("Resource TenantScope 格式无效");
  }
  tenantId(scope.tenantId);
  userId(scope.userId);
}

function assertAgentScope(scope: AuthorizedAgentResourceContext): void {
  if (
    typeof scope.actor !== "object" ||
    scope.actor === null ||
    scope.actor.kind !== "agent" ||
    !ID_PATTERN.test(scope.actor.agentThreadId) ||
    !ID_PATTERN.test(scope.actor.threadId) ||
    !ID_PATTERN.test(scope.actor.runId)
  ) {
    throw new TypeError("Resource Agent 执行上下文格式无效");
  }
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
  return result.rows[0];
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
    database_now: Date;
  }>(
    `SELECT root_run_id, epoch, expires_at, clock_timestamp() AS database_now
       FROM workspace_write_leases
      WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 FOR UPDATE`,
    [tenant, authorization.workspace_id, authorization.thread_id],
  );
  const threadRow = thread.rows[0];
  const runRow = run.rows[0];
  const workspaceRow = workspace.rows[0];
  const leaseRow = lease.rows[0];
  if (
    threadRow === undefined ||
    runRow === undefined ||
    workspaceRow === undefined ||
    revision.rows[0]?.one !== 1 ||
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
    database_now: leaseRow.database_now,
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
    boundary.lease_expires_at !== null &&
    boundary.lease_expires_at.valueOf() > boundary.database_now.valueOf() &&
    row.expires_at.valueOf() > boundary.database_now.valueOf() &&
    normalizeWorkspaceRelativePath(row.relative_path) === row.relative_path &&
    /^[a-f0-9]{64}$/u.test(row.digest) &&
    size >= 0 &&
    normalizeMediaType(row.media_type) === row.media_type
  );
}

async function findStableReferenceForUpdate(
  client: PoolClient,
  tenant: string,
  referenceIdValue: string,
): Promise<StableReferenceRow | undefined> {
  const result = await client.query<StableReferenceRow>(
    `SELECT reference.reference_id, reference.state, reference.purpose,
            reference.sha256, reference.size, reference.media_type,
            reference.lifecycle_id, reference.incarnation_id, reference.physical_object_key,
            lifecycle.state AS lifecycle_state,
            lifecycle.current_incarnation_id,
            incarnation.state AS incarnation_state
       FROM blob_references reference
       JOIN blob_lifecycles lifecycle
         ON lifecycle.tenant_id = reference.tenant_id
        AND lifecycle.lifecycle_id = reference.lifecycle_id
       JOIN blob_incarnations incarnation
         ON incarnation.tenant_id = reference.tenant_id
        AND incarnation.lifecycle_id = reference.lifecycle_id
        AND incarnation.incarnation_id = reference.incarnation_id
        AND incarnation.physical_object_key = reference.physical_object_key
      WHERE reference.tenant_id = $1 AND reference.reference_id = $2
      FOR UPDATE OF reference, lifecycle, incarnation`,
    [tenant, referenceIdValue],
  );
  return result.rows[0];
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
  return result.rows[0];
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
  return result.rows[0]?.latest_version_id ?? undefined;
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
  return result.rows[0];
}

function mapCatalogItem(row: ResourceRow): ResourceCatalogItem {
  const versionNumber = safeInteger(row.version_number, "Resource 版本号");
  const size = safeInteger(row.size, "Resource 大小");
  return Object.freeze({
    tenantId: tenantId(row.tenant_id),
    visibility: row.resource_visibility,
    resourceId: resourceId(row.resource_id),
    versionId: resourceVersionId(row.version_id),
    versionNumber,
    name: row.resource_name,
    origin: row.resource_origin,
    mediaType: row.media_type,
    sizeBytes: size,
    updatedAt: isoTimestamp(row.resource_updated_at.toISOString()),
  });
}

function mapResourceAndVersion(row: ResourceRow): {
  readonly resource: Resource;
  readonly version: ResourceVersion;
} {
  const expectedTenantId = tenantId(row.tenant_id);
  const resource = rehydrateResource(
    {
      id: row.resource_id,
      tenantId: row.tenant_id,
      name: row.resource_name,
      origin: row.resource_origin,
      latestVersionNumber: safeInteger(row.latest_version_number, "Resource latest 版本号"),
      latestVersionId: row.latest_version_id ?? undefined,
      createdAt: row.resource_created_at.toISOString(),
      updatedAt: row.resource_updated_at.toISOString(),
    },
    expectedTenantId,
  );
  const version = rehydrateResourceVersion(
    {
      id: row.version_id,
      resourceId: row.resource_id,
      tenantId: row.tenant_id,
      versionNumber: safeInteger(row.version_number, "Resource 版本号"),
      parentVersionId: row.parent_version_id ?? undefined,
      objectKey: row.physical_object_key,
      digest: sha256Digest(row.digest),
      mediaType: row.media_type,
      sizeBytes: safeInteger(row.size, "Resource 大小"),
      createdAt: row.version_created_at.toISOString(),
    },
    resource,
  );
  return Object.freeze({ resource, version });
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
