import { randomUUID } from "node:crypto";
import type { WorkspaceCandidateIdentity } from "@cube-runtime/workspace";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  assertBlobOperationId,
  type BlobCommitSnapshot,
  type BlobCommitStatePort,
  type BlobReferenceCommitPort,
  transitionBlobCommit,
} from "./blob-commit-protocol.js";
import {
  assertBlobRef,
  assertTenantScope,
  type BlobPurpose,
  BlobStoreError,
  type PromotionAuthorizationRef,
  type PromotionAuthorizationResolution,
  type PromotionExecutionClaim,
  type PromotionExecutionClaimResolution,
  type StableBlobGcClaim,
  type StableBlobGcClaimPort,
  type StableBlobLifecycleAllocation,
  type StableBlobLifecycleAllocationPort,
  type StableBlobPromotionAuthorization,
  type StableBlobPromotionAuthorizationPort,
  type StableBlobRef,
  type StableBlobRetiredTombstone,
  type StableBlobRetiredTombstonePort,
  type StagedBlobRef,
  type TenantBlobScope,
} from "./blob-store.js";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import { assertWorkspaceCandidateIdentity } from "./pg-workspace-candidate.js";
import { withTenantTransaction } from "./postgres.js";

export interface PgBlobLifecycleOptions {
  readonly objectPrefix?: string;
  readonly gcLeaseSeconds?: number;
  readonly promotionLeaseSeconds?: number;
  readonly scrubLeaseSeconds?: number;
  readonly scrubIntervalSeconds?: number;
}

interface LifecycleRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly lifecycle_id: string;
  readonly purpose: BlobPurpose;
  readonly sha256: string;
  readonly size: string;
  readonly state: "active" | "pre_delete" | "deleting" | "deleted";
  readonly current_incarnation_id: string | null;
  readonly generation: string;
  readonly current_claim_id: string | null;
  readonly lease_expires_at: Date | null;
}

interface AllocationRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly allocation_id: string;
  readonly operation_id: string;
  readonly reference_id: string;
  readonly lifecycle_id: string;
  readonly incarnation_id: string;
  readonly physical_object_key: string;
  readonly generation: string;
  readonly mode: "active_reuse" | "new_after_deleted";
  readonly staging_upload_id: string;
  readonly staging_media_type: string;
  readonly purpose: BlobPurpose;
  readonly sha256: string;
  readonly size: string;
}

interface AuthorizationRow extends AllocationRow {
  readonly authorization_id: string;
  readonly authorization_state: "started" | "succeeded" | "consumed_not_copied";
  readonly staging_object_key: string;
  readonly current_execution_id: string | null;
  readonly execution_generation: string;
  readonly incarnation_state: "allocated" | "active" | "retired";
  readonly lifecycle_state: "active" | "pre_delete" | "deleting" | "deleted";
}

interface ExecutionRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly authorization_id: string;
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly generation: string;
  readonly phase: "claimed" | "executing" | "unknown" | "succeeded" | "not_copied";
  readonly proof_status:
    | "pre_intent"
    | "copy_issued"
    | "not_copied"
    | "consumed_not_copied"
    | "succeeded";
  readonly incarnation_id: string;
  readonly physical_object_key: string;
  readonly lease_expires_at: Date;
}

interface CommitRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly operation_id: string;
  readonly status: BlobCommitSnapshot["status"];
  readonly version: string;
  readonly snapshot: unknown;
}

const authorizationColumns = `
  a.tenant_id, a.authorization_id, a.operation_id, a.reference_id,
  a.staging_object_key, a.state AS authorization_state,
  a.current_execution_id, a.execution_generation,
  allocation.allocation_id, allocation.lifecycle_id, allocation.incarnation_id,
  allocation.physical_object_key, allocation.generation, allocation.mode,
  allocation.staging_upload_id, allocation.staging_media_type,
  lifecycle.purpose, lifecycle.sha256, lifecycle.size,
  lifecycle.state AS lifecycle_state, incarnation.state AS incarnation_state`;

const allocationColumns = `
  allocation.tenant_id, allocation.allocation_id, allocation.operation_id,
  allocation.reference_id, allocation.lifecycle_id, allocation.incarnation_id,
  allocation.physical_object_key, allocation.generation, allocation.mode,
  allocation.staging_upload_id, allocation.staging_media_type,
  lifecycle.purpose, lifecycle.sha256, lifecycle.size`;

/**
 * PostgreSQL 是 stable 对象物理身份、远端副作用意图与 GC 不可逆状态的唯一事实源。
 * 所有会签发 S3 副作用的路径都在租户 RLS 事务内锁定 lifecycle 与审计行。
 */
export class PgBlobLifecycleRepository
  implements
    StableBlobLifecycleAllocationPort,
    BlobCommitStatePort,
    BlobReferenceCommitPort,
    StableBlobPromotionAuthorizationPort,
    StableBlobGcClaimPort,
    StableBlobRetiredTombstonePort
{
  private readonly prefix: string;
  private readonly gcLeaseSeconds: number;
  private readonly promotionLeaseSeconds: number;
  private readonly scrubLeaseSeconds: number;
  private readonly scrubIntervalSeconds: number;

  constructor(
    private readonly pool: Pool,
    options: PgBlobLifecycleOptions = {},
  ) {
    this.prefix = normalizePrefix(options.objectPrefix ?? "agent-runtime");
    this.gcLeaseSeconds = boundedSeconds(options.gcLeaseSeconds, 60, "gcLeaseSeconds");
    this.promotionLeaseSeconds = boundedSeconds(
      options.promotionLeaseSeconds,
      60,
      "promotionLeaseSeconds",
    );
    this.scrubLeaseSeconds = boundedSeconds(options.scrubLeaseSeconds, 60, "scrubLeaseSeconds");
    this.scrubIntervalSeconds = boundedSeconds(
      options.scrubIntervalSeconds,
      86_400,
      "scrubIntervalSeconds",
    );
  }

  /**
   * 只释放尚未被规范 ResourceVersion/Artifact 绑定的 resource reference。
   * 对引用行加锁后再检查规范表，使 COMMIT unknown 与清理事务严格串行化。
   */
  async releaseUnattachedResourceReference(input: {
    readonly scope: TenantBlobScope;
    readonly referenceId: string;
    readonly blob: StableBlobRef & { readonly purpose: "resource" };
  }): Promise<"released" | "still_referenced"> {
    assertTenantScope(input.scope);
    assertBlobRef(input.scope, input.blob);
    assertReferenceId(input.referenceId);
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const reference = await client.query<{
          readonly state: "stable" | "released";
          readonly purpose: BlobPurpose;
          readonly sha256: string;
          readonly size: string;
          readonly lifecycle_id: string;
          readonly incarnation_id: string;
          readonly physical_object_key: string;
        }>(
          `SELECT state,purpose,sha256,size::text,lifecycle_id::text,
                  incarnation_id::text,physical_object_key
             FROM blob_references
            WHERE tenant_id=$1 AND reference_id=$2
            FOR UPDATE`,
          [input.scope.tenantId, input.referenceId],
        );
        const row = reference.rows[0];
        if (
          row === undefined ||
          row.purpose !== "resource" ||
          row.sha256 !== input.blob.sha256 ||
          row.size !== String(input.blob.size) ||
          row.incarnation_id !== input.blob.incarnationId ||
          row.physical_object_key !== input.blob.physicalObjectKey
        ) {
          throw new Error("Resource Blob release 身份不连续");
        }
        if (row.state === "released") return "released";
        const attached = await client.query<{ readonly one: number }>(
          `SELECT 1 AS one
             WHERE EXISTS (
               SELECT 1 FROM resource_versions
                WHERE tenant_id=$1 AND blob_reference_id=$2
             ) OR EXISTS (
               SELECT 1 FROM artifact_publications
                WHERE tenant_id=$1 AND blob_reference_id=$2
             )`,
          [input.scope.tenantId, input.referenceId],
        );
        if (attached.rows[0] !== undefined) return "still_referenced";
        const released = await client.query(
          `UPDATE blob_references
              SET state='released',updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND reference_id=$2 AND state='stable'`,
          [input.scope.tenantId, input.referenceId],
        );
        if (released.rowCount !== 1) throw new Error("Resource Blob release 状态冲突");
        return "released";
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "释放未绑定的 Resource Blob 引用");
    }
  }

  async reserve(input: {
    readonly scope: TenantBlobScope;
    readonly staged: StagedBlobRef;
    readonly operationId: string;
    readonly referenceId: string;
  }): Promise<StableBlobLifecycleAllocation> {
    assertTenantScope(input.scope);
    assertBlobRef(input.scope, input.staged);
    assertBlobOperationId(input.operationId);
    assertReferenceId(input.referenceId);
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          // 先按 operation、再按逻辑内容固定加事务 advisory lock，避免唯一约束竞态和交叉死锁。
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `blob-operation|${input.scope.tenantId}|${input.operationId}`,
          ]);
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `blob-lifecycle|${input.scope.tenantId}|${input.staged.purpose}|${input.staged.sha256}|${input.staged.size}`,
          ]);
          const existing = await findAllocationByOperation(
            client,
            input.scope.tenantId,
            input.operationId,
            false,
          );
          if (existing !== undefined) {
            assertAllocationIdempotency(existing, input.staged, input.referenceId);
            return mapAllocation(existing);
          }

          let lifecycle = await findLifecycleForUpdate(client, input.scope.tenantId, input.staged);
          if (lifecycle === undefined) {
            const lifecycleId = randomUUID();
            await client.query(
              `INSERT INTO blob_lifecycles(
                 tenant_id, lifecycle_id, purpose, sha256, size, state
               ) VALUES ($1, $2, $3, $4, $5, 'deleted')`,
              [
                input.scope.tenantId,
                lifecycleId,
                input.staged.purpose,
                input.staged.sha256,
                input.staged.size,
              ],
            );
            lifecycle = await findLifecycleForUpdate(client, input.scope.tenantId, input.staged);
            if (lifecycle === undefined) throw new Error("创建 lifecycle 后无法读回");
          }
          if (lifecycle.state === "pre_delete" || lifecycle.state === "deleting") {
            throw new BlobStoreError("BLOB_PRECONDITION_FAILED", "stable 生命周期正在回收");
          }

          const generation = safeInteger(lifecycle.generation, "lifecycle generation") + 1;
          let incarnationId = lifecycle.current_incarnation_id;
          let physicalObjectKey: string;
          let mode: StableBlobLifecycleAllocation["mode"];
          if (lifecycle.state === "active") {
            if (incarnationId === null) throw new Error("active lifecycle 缺少 incarnation");
            const current = await findIncarnation(
              client,
              input.scope.tenantId,
              lifecycle.lifecycle_id,
              incarnationId,
            );
            if (current === undefined || current.state !== "active") {
              throw new Error("active lifecycle 与 incarnation 不连续");
            }
            physicalObjectKey = current.physical_object_key;
            mode = "active_reuse";
          } else {
            const allocated = await findLiveIncarnation(
              client,
              input.scope.tenantId,
              lifecycle.lifecycle_id,
            );
            if (allocated !== undefined) {
              incarnationId = allocated.incarnation_id;
              physicalObjectKey = allocated.physical_object_key;
            } else {
              incarnationId = randomUUID();
              physicalObjectKey = stableKey(
                this.prefix,
                input.scope.tenantId,
                input.staged.purpose,
                input.staged.sha256,
                incarnationId,
              );
              await client.query(
                `INSERT INTO blob_incarnations(
                   tenant_id, lifecycle_id, purpose, sha256, size,
                   incarnation_id, physical_object_key, state
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'allocated')`,
                [
                  input.scope.tenantId,
                  lifecycle.lifecycle_id,
                  input.staged.purpose,
                  input.staged.sha256,
                  input.staged.size,
                  incarnationId,
                  physicalObjectKey,
                ],
              );
              await client.query(
                `UPDATE blob_lifecycles
                    SET current_incarnation_id = $3, generation = $4, updated_at = clock_timestamp()
                  WHERE tenant_id = $1 AND lifecycle_id = $2`,
                [input.scope.tenantId, lifecycle.lifecycle_id, incarnationId, generation],
              );
            }
            mode = "new_after_deleted";
          }

          // generation 是 lifecycle 上的单调分配序号；即使复用当前 incarnation 也必须落库。
          await client.query(
            `UPDATE blob_lifecycles
                SET current_incarnation_id = $3, generation = $4, updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND lifecycle_id = $2`,
            [input.scope.tenantId, lifecycle.lifecycle_id, incarnationId, generation],
          );

          const allocationId = randomUUID();
          await client.query(
            `INSERT INTO blob_allocations(
               tenant_id, allocation_id, operation_id, reference_id,
               lifecycle_id, incarnation_id, physical_object_key, generation, mode,
               staging_upload_id, staging_media_type
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              input.scope.tenantId,
              allocationId,
              input.operationId,
              input.referenceId,
              lifecycle.lifecycle_id,
              incarnationId,
              physicalObjectKey,
              generation,
              mode,
              input.staged.uploadId,
              input.staged.mediaType,
            ],
          );
          const created = await findAllocationByOperation(
            client,
            input.scope.tenantId,
            input.operationId,
            false,
          );
          if (created === undefined) throw new Error("allocation 创建后无法读回");
          return mapAllocation(created);
        },
        { isolationLevel: "READ COMMITTED" },
      );
    } catch (error) {
      throw mapBlobPersistenceError(error, "预留 stable blob 生命周期");
    }
  }

  async load(scope: TenantBlobScope, operationId: string): Promise<BlobCommitSnapshot | undefined> {
    assertTenantScope(scope);
    assertBlobOperationId(operationId);
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const row = await findCommit(client, scope.tenantId, operationId, false);
        return row === undefined ? undefined : mapCommit(row);
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "读取 blob commit");
    }
  }

  async create(snapshot: BlobCommitSnapshot): Promise<void> {
    assertCommitSnapshot(snapshot);
    try {
      await withTenantTransaction(this.pool, snapshot.scope, async (client) => {
        await client.query(
          `INSERT INTO blob_commits(tenant_id, operation_id, status, version, snapshot)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            snapshot.scope.tenantId,
            snapshot.operationId,
            snapshot.status,
            snapshot.version,
            serializeSnapshot(snapshot),
          ],
        );
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "创建 blob commit");
    }
  }

  async compareAndSet(input: {
    readonly scope: TenantBlobScope;
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly next: BlobCommitSnapshot;
  }): Promise<boolean> {
    assertCommitSnapshot(input.next);
    assertCommitIdentity(input.scope, input.operationId, input.expectedVersion, input.next);
    if (input.next.status === "promotion_started") {
      throw new TypeError("promotion_started 只能由 startPromotion 原子签发");
    }
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const current = await findCommit(client, input.scope.tenantId, input.operationId, true);
        if (
          current === undefined ||
          safeInteger(current.version, "commit version") !== input.expectedVersion
        ) {
          return false;
        }
        if (current.status === "promotion_started" && input.next.status === "allocation_reserved") {
          throw new TypeError("promotion_started 回退只能由 provePromotionNotCopied 完成");
        }
        const result = await client.query(
          `UPDATE blob_commits
              SET status = $4, version = $5, snapshot = $6::jsonb, updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND operation_id = $2 AND version = $3`,
          [
            input.scope.tenantId,
            input.operationId,
            input.expectedVersion,
            input.next.status,
            input.next.version,
            serializeSnapshot(input.next),
          ],
        );
        return result.rowCount === 1;
      });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapBlobPersistenceError(error, "推进 blob commit");
    }
  }

  async startPromotion(input: {
    readonly scope: TenantBlobScope;
    readonly operationId: string;
    readonly expectedSnapshotVersion: number;
    readonly allocationId: string;
  }): Promise<
    | {
        readonly status: "started";
        readonly authorization: PromotionAuthorizationRef;
        readonly snapshotVersion: number;
      }
    | { readonly status: "version_conflict" | "invalid_state" | "allocation_unavailable" }
  > {
    assertTenantScope(input.scope);
    assertBlobOperationId(input.operationId);
    assertUuid(input.allocationId, "allocationId");
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const currentRow = await findCommit(client, input.scope.tenantId, input.operationId, true);
        if (currentRow === undefined) {
          return { status: "version_conflict" as const };
        }
        const current = mapCommit(currentRow);
        if (current.version !== input.expectedSnapshotVersion) {
          if (
            current.version === input.expectedSnapshotVersion + 1 &&
            current.status === "promotion_started" &&
            current.allocation?.allocationId === input.allocationId &&
            current.promotionAuthorization !== undefined
          ) {
            const readback = await findAuthorization(
              client,
              input.scope.tenantId,
              current.promotionAuthorization.authorizationId,
              false,
            );
            if (
              readback !== undefined &&
              readback.operation_id === input.operationId &&
              readback.allocation_id === input.allocationId
            ) {
              return {
                status: "started" as const,
                authorization: current.promotionAuthorization,
                snapshotVersion: current.version,
              };
            }
          }
          return { status: "version_conflict" as const };
        }
        if (current.status !== "allocation_reserved") return { status: "invalid_state" as const };
        const allocation = await findAllocationById(
          client,
          input.scope.tenantId,
          input.allocationId,
          false,
        );
        if (
          allocation === undefined ||
          allocation.operation_id !== input.operationId ||
          current.allocation?.allocationId !== allocation.allocation_id
        ) {
          return { status: "allocation_unavailable" as const };
        }
        const lifecycle = await findLifecycleById(
          client,
          input.scope.tenantId,
          allocation.lifecycle_id,
          true,
        );
        if (
          lifecycle === undefined ||
          lifecycle.current_incarnation_id !== allocation.incarnation_id ||
          lifecycle.state === "pre_delete" ||
          lifecycle.state === "deleting"
        ) {
          return { status: "allocation_unavailable" as const };
        }
        const incarnation = await findIncarnation(
          client,
          input.scope.tenantId,
          allocation.lifecycle_id,
          allocation.incarnation_id,
        );
        if (
          incarnation === undefined ||
          incarnation.state === "retired" ||
          incarnation.physical_object_key !== allocation.physical_object_key
        ) {
          return { status: "allocation_unavailable" as const };
        }
        const authorizationId = randomUUID();
        const authorization: PromotionAuthorizationRef = {
          tenantId: input.scope.tenantId,
          operationId: input.operationId,
          authorizationId,
        };
        const next = transitionBlobCommit(current, { type: "promotion_started", authorization });
        await client.query(
          `INSERT INTO promotion_authorizations(
             tenant_id, authorization_id, operation_id, reference_id, allocation_id,
             lifecycle_id, incarnation_id, physical_object_key,
             staging_upload_id, staging_object_key, state
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'started')`,
          [
            input.scope.tenantId,
            authorizationId,
            input.operationId,
            allocation.reference_id,
            allocation.allocation_id,
            allocation.lifecycle_id,
            allocation.incarnation_id,
            allocation.physical_object_key,
            allocation.staging_upload_id,
            stagingKey(
              this.prefix,
              input.scope.tenantId,
              allocation.purpose,
              allocation.staging_upload_id,
            ),
          ],
        );
        await client.query(
          `UPDATE blob_commits
              SET status = $4, version = $5, snapshot = $6::jsonb, updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND operation_id = $2 AND version = $3`,
          [
            input.scope.tenantId,
            input.operationId,
            input.expectedSnapshotVersion,
            next.status,
            next.version,
            serializeSnapshot(next),
          ],
        );
        return { status: "started" as const, authorization, snapshotVersion: next.version };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "签发 promotion 授权");
    }
  }

  async provePromotionNotCopied(input: {
    readonly scope: TenantBlobScope;
    readonly operationId: string;
    readonly expectedSnapshotVersion: number;
    readonly authorizationId: string;
  }): Promise<
    | { readonly status: "proven_not_copied"; readonly snapshotVersion: number }
    | {
        readonly status:
          | "version_conflict"
          | "invalid_state"
          | "authorization_mismatch"
          | "proof_unavailable"
          | "copy_may_have_been_issued";
      }
  > {
    assertTenantScope(input.scope);
    assertBlobOperationId(input.operationId);
    assertUuid(input.authorizationId, "authorizationId");
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        // Promotion 事务统一先锁 authorization，再锁其 current execution。
        const auth = await findAuthorization(
          client,
          input.scope.tenantId,
          input.authorizationId,
          true,
        );
        const execution =
          auth === undefined ? undefined : await findBoundCurrentExecution(client, auth, true);
        const commitRow = await findCommit(client, input.scope.tenantId, input.operationId, true);
        if (commitRow === undefined) {
          return { status: "version_conflict" as const };
        }
        const current = mapCommit(commitRow);
        if (current.version !== input.expectedSnapshotVersion) {
          if (
            current.version === input.expectedSnapshotVersion + 1 &&
            current.status === "allocation_reserved"
          ) {
            if (
              auth?.operation_id === input.operationId &&
              auth.authorization_state === "consumed_not_copied" &&
              execution?.proof_status === "consumed_not_copied"
            ) {
              return { status: "proven_not_copied" as const, snapshotVersion: current.version };
            }
          }
          return { status: "version_conflict" as const };
        }
        if (current.status !== "promotion_started") return { status: "invalid_state" as const };
        if (current.promotionAuthorization?.authorizationId !== input.authorizationId) {
          return { status: "authorization_mismatch" as const };
        }
        if (
          auth === undefined ||
          auth.operation_id !== input.operationId ||
          auth.authorization_state !== "started"
        ) {
          return { status: "authorization_mismatch" as const };
        }
        if (execution === undefined) return { status: "proof_unavailable" as const };
        if (["copy_issued", "succeeded"].includes(execution.proof_status)) {
          return { status: "copy_may_have_been_issued" as const };
        }
        if (execution.proof_status !== "pre_intent" && execution.proof_status !== "not_copied") {
          return { status: "proof_unavailable" as const };
        }
        const next = transitionBlobCommit(current, { type: "promotion_proven_not_copied" });
        await client.query(
          `UPDATE promotion_executions
              SET proof_status = 'consumed_not_copied', phase = 'not_copied', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND execution_id = $2`,
          [input.scope.tenantId, execution.execution_id],
        );
        await client.query(
          `UPDATE promotion_authorizations
              SET state = 'consumed_not_copied', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND authorization_id = $2`,
          [input.scope.tenantId, input.authorizationId],
        );
        await client.query(
          `UPDATE blob_commits
              SET status = $4, version = $5, snapshot = $6::jsonb, updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND operation_id = $2 AND version = $3`,
          [
            input.scope.tenantId,
            input.operationId,
            input.expectedSnapshotVersion,
            next.status,
            next.version,
            serializeSnapshot(next),
          ],
        );
        return { status: "proven_not_copied" as const, snapshotVersion: next.version };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "证明 promotion 未 COPY");
    }
  }

  async commitStagedReference(input: {
    readonly operationId: string;
    readonly scope: TenantBlobScope;
    readonly staged: StagedBlobRef;
  }): Promise<{ readonly referenceId: string }> {
    assertTenantScope(input.scope);
    assertBlobOperationId(input.operationId);
    assertBlobRef(input.scope, input.staged);
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const existing = await client.query(
          `SELECT * FROM blob_references WHERE tenant_id = $1 AND operation_id = $2 FOR UPDATE`,
          [input.scope.tenantId, input.operationId],
        );
        const row = existing.rows[0];
        if (row !== undefined) {
          assertReferenceMatchesStaged(row, input.staged);
          return { referenceId: String(row.reference_id) };
        }
        const commit = await findCommit(client, input.scope.tenantId, input.operationId, true);
        if (commit === undefined) throw new Error("blob commit 不存在");
        const referenceId = randomUUID();
        await client.query(
          `INSERT INTO blob_references(
             tenant_id, reference_id, operation_id, state, purpose, sha256, size,
             media_type, staging_upload_id
           ) VALUES ($1, $2, $3, 'staged', $4, $5, $6, $7, $8)`,
          [
            input.scope.tenantId,
            referenceId,
            input.operationId,
            input.staged.purpose,
            input.staged.sha256,
            input.staged.size,
            input.staged.mediaType,
            input.staged.uploadId,
          ],
        );
        return { referenceId };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "提交 staging 引用");
    }
  }

  async resolveReferenceCommit(
    scope: TenantBlobScope,
    operationId: string,
  ): Promise<
    { readonly status: "committed"; readonly referenceId: string } | { readonly status: "absent" }
  > {
    assertTenantScope(scope);
    assertBlobOperationId(operationId);
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const result = await client.query<{ reference_id: string }>(
          "SELECT reference_id FROM blob_references WHERE tenant_id = $1 AND operation_id = $2",
          [scope.tenantId, operationId],
        );
        const referenceId = result.rows[0]?.reference_id;
        return referenceId === undefined
          ? { status: "absent" as const }
          : { status: "committed" as const, referenceId };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "解析 staging 引用提交");
    }
  }

  async markReferenceStable(input: {
    readonly operationId: string;
    readonly scope: TenantBlobScope;
    readonly referenceId: string;
    readonly stable: StableBlobRef;
  }): Promise<"marked" | "gc_in_progress"> {
    assertTenantScope(input.scope);
    assertBlobOperationId(input.operationId);
    assertReferenceId(input.referenceId);
    assertBlobRef(input.scope, input.stable);
    try {
      return await withTenantTransaction(this.pool, input.scope, (client) =>
        this.markReferenceStableOnClient(client, input),
      );
    } catch (error) {
      throw mapBlobPersistenceError(error, "标记 stable 引用");
    }
  }

  /** stable 标记与 uploaded candidate file 必须同事务提交，消除进程崩溃产生的无主 stable 引用。 */
  async markWorkspaceCandidateReferenceStable(input: {
    readonly operationId: string;
    readonly scope: TenantBlobScope;
    readonly referenceId: string;
    readonly stable: StableBlobRef;
    readonly candidate: WorkspaceCandidateIdentity;
    readonly relativePath: string;
  }): Promise<"marked" | "gc_in_progress"> {
    assertTenantScope(input.scope);
    assertBlobOperationId(input.operationId);
    assertReferenceId(input.referenceId);
    assertBlobRef(input.scope, input.stable);
    assertWorkspaceCandidateIdentity(input.candidate);
    if (input.scope.tenantId !== input.candidate.tenantId) {
      throw new TypeError("Workspace candidate 与 Blob Tenant 不一致");
    }
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const marked = await this.markReferenceStableOnClient(client, input);
        if (marked !== "marked") return marked;
        const attached = await client.query(
          `INSERT INTO workspace_revision_candidate_files(
             tenant_id,workspace_id,attempt_id,run_id,thread_id,root_run_id,parent_revision_id,
             revision_id,operation_key,operation_digest,manifest_digest,relative_path,source,
             content_sha256,size,blob_lifecycle_id,blob_incarnation_id,physical_object_key,
             blob_reference_id
           )
           SELECT candidate.tenant_id,candidate.workspace_id,candidate.attempt_id,candidate.run_id,
                  candidate.thread_id,candidate.root_run_id,candidate.parent_revision_id,
                  candidate.revision_id,candidate.operation_key,candidate.operation_digest,NULL,
                  $11,'uploaded',reference.sha256,reference.size,reference.lifecycle_id,
                  reference.incarnation_id,reference.physical_object_key,reference.reference_id
             FROM workspace_revision_candidates candidate
             JOIN blob_references reference
               ON reference.tenant_id=candidate.tenant_id AND reference.reference_id=$10
            WHERE candidate.tenant_id=$1 AND candidate.workspace_id=$2 AND candidate.attempt_id=$3
              AND candidate.run_id=$4 AND candidate.thread_id=$5 AND candidate.root_run_id=$6
              AND candidate.parent_revision_key=COALESCE($7,'') AND candidate.revision_id=$8
              AND candidate.operation_key=$9 AND candidate.operation_digest=$12
              AND candidate.status='building' AND reference.state='stable'
              AND reference.purpose='workspace' AND reference.sha256=$13 AND reference.size=$14
              AND reference.incarnation_id=$15::uuid AND reference.physical_object_key=$16
           ON CONFLICT (tenant_id,workspace_id,attempt_id,operation_key,relative_path)
           DO NOTHING`,
          [
            input.candidate.tenantId,
            input.candidate.workspaceId,
            input.candidate.attemptId,
            input.candidate.runId,
            input.candidate.threadId,
            input.candidate.rootRunId,
            input.candidate.parentRevisionId ?? null,
            input.candidate.revisionId,
            input.candidate.operationKey,
            input.referenceId,
            input.relativePath,
            input.candidate.operationDigest,
            input.stable.sha256,
            input.stable.size,
            input.stable.incarnationId,
            input.stable.physicalObjectKey,
          ],
        );
        if (attached.rowCount !== 1) {
          const existing = await client.query<{ readonly one: number }>(
            `SELECT 1 AS one FROM workspace_revision_candidate_files
              WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4
                AND relative_path=$5 AND source='uploaded' AND blob_reference_id=$6
                AND content_sha256=$7 AND size=$8 AND blob_incarnation_id=$9::uuid
                AND physical_object_key=$10`,
            [
              input.candidate.tenantId,
              input.candidate.workspaceId,
              input.candidate.attemptId,
              input.candidate.operationKey,
              input.relativePath,
              input.referenceId,
              input.stable.sha256,
              input.stable.size,
              input.stable.incarnationId,
              input.stable.physicalObjectKey,
            ],
          );
          if (existing.rows[0]?.one !== 1) throw new Error("Workspace uploaded candidate 绑定冲突");
        }
        return "marked";
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "标记 Workspace candidate stable 引用");
    }
  }

  private async markReferenceStableOnClient(
    client: PoolClient,
    input: {
      readonly operationId: string;
      readonly scope: TenantBlobScope;
      readonly referenceId: string;
      readonly stable: StableBlobRef;
    },
  ): Promise<"marked" | "gc_in_progress"> {
    const referenceResult = await client.query(
      `SELECT * FROM blob_references
            WHERE tenant_id = $1 AND operation_id = $2 AND reference_id = $3
            FOR UPDATE`,
      [input.scope.tenantId, input.operationId, input.referenceId],
    );
    const reference = referenceResult.rows[0];
    if (reference === undefined) throw new Error("staging 引用不存在");
    if (reference.state === "stable") {
      assertReferenceMatchesStable(reference, input.stable);
      return "marked";
    }
    assertReferenceMatchesStaged(
      reference,
      stableToStagedView(input.stable, String(reference.staging_upload_id)),
    );
    const lifecycleResult = await client.query<LifecycleRow>(
      `SELECT * FROM blob_lifecycles
            WHERE tenant_id = $1 AND purpose = $2 AND sha256 = $3 AND size = $4
            FOR UPDATE`,
      [input.scope.tenantId, input.stable.purpose, input.stable.sha256, input.stable.size],
    );
    const lifecycle = lifecycleResult.rows[0];
    if (lifecycle === undefined) throw new Error("stable lifecycle 不存在");
    if (lifecycle.state === "pre_delete" || lifecycle.state === "deleting") return "gc_in_progress";
    if (lifecycle.current_incarnation_id !== input.stable.incarnationId) {
      throw new Error("stable 不是 lifecycle 当前 incarnation");
    }
    const incarnation = await findIncarnation(
      client,
      input.scope.tenantId,
      lifecycle.lifecycle_id,
      input.stable.incarnationId,
    );
    if (
      incarnation === undefined ||
      incarnation.state === "retired" ||
      incarnation.physical_object_key !== input.stable.physicalObjectKey
    ) {
      throw new Error("stable incarnation 已退休或身份不一致");
    }
    if (lifecycle.state === "deleted") {
      const proof = await client.query<{ one: number }>(
        `SELECT 1 AS one FROM promotion_authorizations
              WHERE tenant_id = $1 AND operation_id = $2 AND incarnation_id = $3
                AND physical_object_key = $4 AND state = 'succeeded'`,
        [
          input.scope.tenantId,
          input.operationId,
          input.stable.incarnationId,
          input.stable.physicalObjectKey,
        ],
      );
      if (proof.rows[0] === undefined) throw new Error("缺少已完成 promotion 证明");
      await client.query(
        `UPDATE blob_lifecycles
                SET state = 'active', updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND lifecycle_id = $2`,
        [input.scope.tenantId, lifecycle.lifecycle_id],
      );
      await client.query(
        `UPDATE blob_incarnations
                SET state = 'active'
              WHERE tenant_id = $1 AND lifecycle_id = $2 AND incarnation_id = $3 AND state = 'allocated'`,
        [input.scope.tenantId, lifecycle.lifecycle_id, input.stable.incarnationId],
      );
    }
    await client.query(
      `UPDATE blob_references
              SET state = 'stable', lifecycle_id = $4, incarnation_id = $5,
                  physical_object_key = $6, updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND operation_id = $2 AND reference_id = $3`,
      [
        input.scope.tenantId,
        input.operationId,
        input.referenceId,
        lifecycle.lifecycle_id,
        input.stable.incarnationId,
        input.stable.physicalObjectKey,
      ],
    );
    return "marked";
  }

  async resolveStableMark(
    scope: TenantBlobScope,
    operationId: string,
  ): Promise<"marked" | "not_marked" | "gc_in_progress"> {
    assertTenantScope(scope);
    assertBlobOperationId(operationId);
    try {
      return await withTenantTransaction(this.pool, scope, async (client) => {
        const result = await client.query<{
          state: "staged" | "stable";
          lifecycle_state: LifecycleRow["state"] | null;
        }>(
          `SELECT reference.state, lifecycle.state AS lifecycle_state
             FROM blob_references reference
             LEFT JOIN blob_lifecycles lifecycle
               ON lifecycle.tenant_id = reference.tenant_id
              AND lifecycle.lifecycle_id = reference.lifecycle_id
            WHERE reference.tenant_id = $1 AND reference.operation_id = $2`,
          [scope.tenantId, operationId],
        );
        const row = result.rows[0];
        if (row?.state === "stable") return "marked";
        if (row?.lifecycle_state === "pre_delete" || row?.lifecycle_state === "deleting") {
          return "gc_in_progress";
        }
        return "not_marked";
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "解析 stable 引用标记");
    }
  }

  async claimPromotionExecution(input: {
    readonly scope: TenantBlobScope;
    readonly authorization: PromotionAuthorizationRef;
    readonly attemptId: string;
  }): Promise<PromotionExecutionClaimResolution> {
    assertAuthorizationRef(input.scope, input.authorization);
    assertUuid(input.attemptId, "attemptId");
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const auth = await findAuthorization(
          client,
          input.scope.tenantId,
          input.authorization.authorizationId,
          true,
        );
        const unavailable = classifyAuthorization(auth, input.authorization.operationId);
        if (unavailable !== undefined) return { status: unavailable };
        if (auth === undefined) return { status: "not_found" };
        if (auth.authorization_state === "succeeded") {
          return { status: "completed", authorization: mapAuthorization(auth) };
        }
        const currentExecution = await findBoundCurrentExecution(client, auth, true);
        if (currentExecution !== undefined) {
          const execution = currentExecution;
          if (execution.phase === "succeeded") {
            return { status: "completed", authorization: mapAuthorization(auth) };
          }
          if (execution.phase === "executing" || execution.phase === "unknown") {
            return { status: "reconcile", execution: mapExecution(execution) };
          }
          if (execution.phase === "claimed" && execution.attempt_id === input.attemptId) {
            return { status: "copy_allowed", execution: mapExecution(execution) };
          }
          const lease = await databaseLeaseExpired(client, execution.lease_expires_at);
          if (!lease) return { status: "in_progress" };
          if (execution.proof_status !== "pre_intent") return { status: "in_progress" };
          await client.query(
            `UPDATE promotion_executions
                SET phase = 'not_copied', proof_status = 'not_copied', updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND execution_id = $2`,
            [input.scope.tenantId, execution.execution_id],
          );
        }
        const generation = safeInteger(auth.execution_generation, "execution generation") + 1;
        const executionId = randomUUID();
        await client.query(
          `INSERT INTO promotion_executions(
             tenant_id, execution_id, authorization_id, operation_id, attempt_id,
             generation, phase, proof_status, lifecycle_id, incarnation_id,
             physical_object_key, lease_expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'claimed', 'pre_intent', $7, $8, $9,
             clock_timestamp() + ($10 * interval '1 second'))`,
          [
            input.scope.tenantId,
            executionId,
            auth.authorization_id,
            auth.operation_id,
            input.attemptId,
            generation,
            auth.lifecycle_id,
            auth.incarnation_id,
            auth.physical_object_key,
            this.promotionLeaseSeconds,
          ],
        );
        await client.query(
          `UPDATE promotion_authorizations
              SET current_execution_id = $3, execution_generation = $4, updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND authorization_id = $2`,
          [input.scope.tenantId, auth.authorization_id, executionId, generation],
        );
        const execution = await findExecution(client, input.scope.tenantId, executionId, false);
        if (
          execution === undefined ||
          execution.authorization_id !== auth.authorization_id ||
          execution.operation_id !== auth.operation_id ||
          execution.execution_id !== executionId ||
          safeInteger(execution.generation, "execution generation") !== generation
        ) {
          throw executionBindingMismatch("新建 execution 与 authorization 身份不连续");
        }
        return { status: "copy_allowed", execution: mapExecution(execution) };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "取得 promotion execution");
    }
  }

  async resolveAuthorizedForCopy(input: {
    readonly scope: TenantBlobScope;
    readonly execution: PromotionExecutionClaim;
  }): Promise<PromotionAuthorizationResolution> {
    assertTenantScope(input.scope);
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const execution = await findExecution(
          client,
          input.scope.tenantId,
          input.execution.executionId,
          false,
        );
        if (execution === undefined) return { status: "not_found" };
        if (!executionMatches(execution, input.execution)) return { status: "wrong_operation" };
        const auth = await findAuthorization(
          client,
          input.scope.tenantId,
          execution.authorization_id,
          false,
        );
        const unavailable = classifyAuthorization(auth, execution.operation_id);
        if (unavailable === undefined && auth !== undefined) {
          assertExecutionBoundToAuthorization(auth, execution);
        }
        return unavailable === undefined && auth !== undefined
          ? { status: "authorized", authorization: mapAuthorization(auth) }
          : { status: unavailable ?? "not_found" };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "解析 promotion 授权");
    }
  }

  async markPromotionCopyIssued(input: {
    readonly scope: TenantBlobScope;
    readonly execution: PromotionExecutionClaim;
  }): Promise<
    | { readonly status: "marked"; readonly execution: PromotionExecutionClaim }
    | { readonly status: "claim_lost" }
  > {
    assertTenantScope(input.scope);
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const authorization = await findAuthorization(
          client,
          input.scope.tenantId,
          input.execution.authorizationId,
          true,
        );
        if (authorization === undefined || authorization.authorization_state !== "started") {
          return { status: "claim_lost" as const };
        }
        const execution = await findBoundCurrentExecution(client, authorization, true);
        if (execution === undefined || !executionMatches(execution, input.execution)) {
          return { status: "claim_lost" as const };
        }
        if (execution.phase === "executing" && execution.proof_status === "copy_issued") {
          return { status: "marked" as const, execution: mapExecution(execution) };
        }
        if (execution.phase !== "claimed" || execution.proof_status !== "pre_intent") {
          return { status: "claim_lost" as const };
        }
        const result = await client.query<ExecutionRow>(
          `UPDATE promotion_executions
              SET phase = 'executing', proof_status = 'copy_issued', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND execution_id = $2 AND authorization_id = $3
              AND operation_id = $4 AND attempt_id = $5 AND generation = $6
              AND incarnation_id = $7 AND physical_object_key = $8
              AND phase = 'claimed' AND proof_status = 'pre_intent'
            RETURNING *`,
          [
            input.scope.tenantId,
            input.execution.executionId,
            input.execution.authorizationId,
            input.execution.operationId,
            input.execution.attemptId,
            input.execution.generation,
            input.execution.incarnationId,
            input.execution.physicalObjectKey,
          ],
        );
        const row = result.rows[0];
        return row === undefined
          ? { status: "claim_lost" as const }
          : { status: "marked" as const, execution: mapExecution(row) };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "记录 promotion COPY 意图");
    }
  }

  async completePromotionExecution(input: {
    readonly scope: TenantBlobScope;
    readonly execution: PromotionExecutionClaim;
    readonly outcome: "succeeded" | "not_copied" | "unknown" | "reconcile";
  }): Promise<void> {
    assertTenantScope(input.scope);
    try {
      await withTenantTransaction(this.pool, input.scope, async (client) => {
        const authorization = await findAuthorization(
          client,
          input.scope.tenantId,
          input.execution.authorizationId,
          true,
        );
        if (authorization === undefined) throw casConflict("promotion authorization 已失效");
        const execution = await findBoundCurrentExecution(client, authorization, true);
        if (execution === undefined || !executionMatches(execution, input.execution)) {
          throw casConflict("promotion execution 已失效");
        }
        if (input.outcome === "succeeded") {
          if (execution.phase === "not_copied") {
            throw casConflict("not_copied execution 不能改写为 succeeded");
          }
          await client.query(
            `UPDATE promotion_executions
                SET phase = 'succeeded', proof_status = 'succeeded', updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND execution_id = $2`,
            [input.scope.tenantId, execution.execution_id],
          );
          await client.query(
            `UPDATE promotion_authorizations
                SET state = 'succeeded', updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND authorization_id = $2`,
            [input.scope.tenantId, execution.authorization_id],
          );
          return;
        }
        if (input.outcome === "not_copied") {
          if (execution.phase === "not_copied" && execution.proof_status === "not_copied") return;
          if (execution.phase !== "claimed" || execution.proof_status !== "pre_intent") {
            throw casConflict("COPY intent 后不能声明 not_copied");
          }
          await client.query(
            `UPDATE promotion_executions
                SET phase = 'not_copied', proof_status = 'not_copied', updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND execution_id = $2`,
            [input.scope.tenantId, execution.execution_id],
          );
          return;
        }
        // UNKNOWN/reconcile 不改写 copy-issued 证明；恢复只能 HEAD 同一固定 destination。
        await client.query(
          `UPDATE promotion_executions
              SET phase = 'unknown', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND execution_id = $2
              AND phase IN ('claimed', 'executing', 'unknown')`,
          [input.scope.tenantId, execution.execution_id],
        );
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "完成 promotion execution");
    }
  }

  async claimUnreachable(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
  }): Promise<
    | { readonly status: "claimed"; readonly claim: StableBlobGcClaim }
    | { readonly status: "still_referenced" }
    | { readonly status: "in_progress" }
    | { readonly status: "already_deleted" }
  > {
    assertTenantScope(input.scope);
    assertBlobRef(input.scope, input.blob);
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const lifecycle = await findLifecycleForUpdate(client, input.scope.tenantId, input.blob);
        if (lifecycle === undefined) return { status: "already_deleted" as const };
        if (lifecycle.current_incarnation_id !== input.blob.incarnationId) {
          const retired = await findIncarnationByPhysical(client, input.scope.tenantId, input.blob);
          return retired?.state === "retired"
            ? { status: "already_deleted" as const }
            : { status: "in_progress" as const };
        }
        if (lifecycle.state === "deleted") return { status: "already_deleted" as const };
        if (lifecycle.state === "active") {
          const reachable = await client.query<{ count: string }>(
            `SELECT (
                (SELECT count(*) FROM blob_references
                  WHERE tenant_id = $1 AND lifecycle_id = $2 AND incarnation_id = $3
                    AND state = 'stable')
                +
                (SELECT count(*) FROM workspace_revision_files
                  WHERE tenant_id = $1 AND blob_lifecycle_id = $2 AND blob_incarnation_id = $3)
              )::text AS count`,
            [input.scope.tenantId, lifecycle.lifecycle_id, input.blob.incarnationId],
          );
          const promotions = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM promotion_authorizations auth
               LEFT JOIN promotion_executions execution
                 ON execution.tenant_id = auth.tenant_id
                AND execution.execution_id = auth.current_execution_id
              WHERE auth.tenant_id = $1 AND auth.lifecycle_id = $2
                AND auth.incarnation_id = $3 AND auth.state = 'started'
                AND (execution.execution_id IS NULL OR execution.phase IN ('claimed', 'executing', 'unknown'))`,
            [input.scope.tenantId, lifecycle.lifecycle_id, input.blob.incarnationId],
          );
          if (reachable.rows[0]?.count !== "0" || promotions.rows[0]?.count !== "0") {
            return { status: "still_referenced" as const };
          }
        } else if (!(await databaseLeaseExpired(client, lifecycle.lease_expires_at))) {
          return { status: "in_progress" as const };
        }

        const incarnation = await findIncarnation(
          client,
          input.scope.tenantId,
          lifecycle.lifecycle_id,
          input.blob.incarnationId,
        );
        if (
          incarnation === undefined ||
          incarnation.physical_object_key !== input.blob.physicalObjectKey
        ) {
          throw new Error("GC blob 与 lifecycle incarnation 不一致");
        }
        const claimId = randomUUID();
        const generation = safeInteger(lifecycle.generation, "GC generation") + 1;
        const phase = lifecycle.state === "deleting" ? "deleting" : "pre_delete";
        const updated = await client.query<LifecycleRow>(
          `UPDATE blob_lifecycles
              SET state = $3, generation = $4, current_claim_id = $5,
                  lease_expires_at = clock_timestamp() + ($6 * interval '1 second'),
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND lifecycle_id = $2
            RETURNING *`,
          [
            input.scope.tenantId,
            lifecycle.lifecycle_id,
            phase,
            generation,
            claimId,
            this.gcLeaseSeconds,
          ],
        );
        const lease = updated.rows[0]?.lease_expires_at;
        if (lease === undefined || lease === null) throw new Error("GC claim 缺少数据库 lease");
        await client.query(
          `INSERT INTO blob_gc_claims(
             tenant_id, claim_id, lifecycle_id, incarnation_id, physical_object_key,
             generation, phase, lease_expires_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.scope.tenantId,
            claimId,
            lifecycle.lifecycle_id,
            input.blob.incarnationId,
            input.blob.physicalObjectKey,
            generation,
            phase,
            lease,
          ],
        );
        return {
          status: "claimed" as const,
          claim: gcClaim(input.blob, claimId, generation, phase, lease),
        };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "取得 stable GC claim");
    }
  }

  async beginDeletion(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }): Promise<
    | { readonly status: "started"; readonly claim: StableBlobGcClaim }
    | { readonly status: "claim_lost" }
  > {
    assertTenantScope(input.scope);
    assertBlobRef(input.scope, input.blob);
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const result = await client.query<LifecycleRow>(
          `UPDATE blob_lifecycles lifecycle
              SET state = 'deleting', updated_at = clock_timestamp()
            WHERE lifecycle.tenant_id = $1 AND lifecycle.purpose = $2
              AND lifecycle.sha256 = $3 AND lifecycle.size = $4
              AND lifecycle.current_incarnation_id = $5
              AND lifecycle.state = 'pre_delete' AND lifecycle.current_claim_id = $6
              AND lifecycle.generation = $7
              AND EXISTS (
                SELECT 1 FROM blob_gc_claims claim
                 WHERE claim.tenant_id = lifecycle.tenant_id
                   AND claim.lifecycle_id = lifecycle.lifecycle_id
                   AND claim.claim_id = $6 AND claim.generation = $7
                   AND claim.phase = 'pre_delete' AND claim.incarnation_id = $5
                   AND claim.physical_object_key = $8
              )
            RETURNING lifecycle.*`,
          [
            input.scope.tenantId,
            input.blob.purpose,
            input.blob.sha256,
            input.blob.size,
            input.claim.incarnationId,
            input.claim.claimId,
            input.claim.generation,
            input.claim.physicalObjectKey,
          ],
        );
        const lifecycle = result.rows[0];
        if (lifecycle === undefined) {
          const readback = await client.query<{ one: number }>(
            `SELECT 1 AS one
               FROM blob_lifecycles lifecycle
               JOIN blob_gc_claims claim
                 ON claim.tenant_id = lifecycle.tenant_id
                AND claim.lifecycle_id = lifecycle.lifecycle_id
              WHERE lifecycle.tenant_id = $1 AND lifecycle.purpose = $2
                AND lifecycle.sha256 = $3 AND lifecycle.size = $4
                AND lifecycle.state = 'deleting' AND lifecycle.current_incarnation_id = $5
                AND lifecycle.current_claim_id = $6 AND lifecycle.generation = $7
                AND claim.claim_id = $6 AND claim.generation = $7
                AND claim.phase = 'deleting' AND claim.incarnation_id = $5
                AND claim.physical_object_key = $8`,
            [
              input.scope.tenantId,
              input.blob.purpose,
              input.blob.sha256,
              input.blob.size,
              input.claim.incarnationId,
              input.claim.claimId,
              input.claim.generation,
              input.claim.physicalObjectKey,
            ],
          );
          return readback.rows[0] === undefined
            ? { status: "claim_lost" as const }
            : {
                status: "started" as const,
                claim: { ...input.claim, phase: "deleting" as const },
              };
        }
        await client.query(
          `UPDATE blob_gc_claims SET phase = 'deleting', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND claim_id = $2 AND generation = $3`,
          [input.scope.tenantId, input.claim.claimId, input.claim.generation],
        );
        return {
          status: "started" as const,
          claim: { ...input.claim, phase: "deleting" as const },
        };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "开始 stable 删除");
    }
  }

  async completeDeletion(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }): Promise<void> {
    assertTenantScope(input.scope);
    assertBlobRef(input.scope, input.blob);
    try {
      await withTenantTransaction(this.pool, input.scope, async (client) => {
        const lifecycle = await findLifecycleForUpdate(client, input.scope.tenantId, input.blob);
        if (lifecycle?.state === "deleted") {
          const completed = await client.query<{ one: number }>(
            `SELECT 1 AS one FROM blob_gc_claims
              WHERE tenant_id = $1 AND claim_id = $2 AND generation = $3
                AND phase = 'completed' AND incarnation_id = $4 AND physical_object_key = $5`,
            [
              input.scope.tenantId,
              input.claim.claimId,
              input.claim.generation,
              input.claim.incarnationId,
              input.claim.physicalObjectKey,
            ],
          );
          if (completed.rows[0] !== undefined) return;
          throw casConflict("GC complete claim 已失效");
        }
        if (
          lifecycle === undefined ||
          lifecycle.state !== "deleting" ||
          lifecycle.current_claim_id !== input.claim.claimId ||
          safeInteger(lifecycle.generation, "GC generation") !== input.claim.generation ||
          lifecycle.current_incarnation_id !== input.claim.incarnationId
        ) {
          throw casConflict("GC complete claim 已失效");
        }
        const claim = await client.query<{ physical_object_key: string; phase: string }>(
          `SELECT physical_object_key, phase FROM blob_gc_claims
            WHERE tenant_id = $1 AND claim_id = $2 AND generation = $3 FOR UPDATE`,
          [input.scope.tenantId, input.claim.claimId, input.claim.generation],
        );
        if (
          claim.rows[0]?.phase !== "deleting" ||
          claim.rows[0]?.physical_object_key !== input.claim.physicalObjectKey
        ) {
          throw casConflict("GC complete claim 身份不连续");
        }
        await client.query(
          `UPDATE blob_lifecycles
              SET state = 'deleted', current_claim_id = NULL, lease_expires_at = NULL,
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND lifecycle_id = $2`,
          [input.scope.tenantId, lifecycle.lifecycle_id],
        );
        await client.query(
          `UPDATE blob_incarnations
              SET state = 'retired', retired_at = clock_timestamp()
            WHERE tenant_id = $1 AND lifecycle_id = $2 AND incarnation_id = $3
              AND physical_object_key = $4 AND state <> 'retired'`,
          [
            input.scope.tenantId,
            lifecycle.lifecycle_id,
            input.claim.incarnationId,
            input.claim.physicalObjectKey,
          ],
        );
        await client.query(
          `UPDATE blob_gc_claims SET phase = 'completed', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND claim_id = $2 AND generation = $3`,
          [input.scope.tenantId, input.claim.claimId, input.claim.generation],
        );
        await client.query(
          `INSERT INTO retired_blob_tombstones(
             tenant_id, tombstone_id, lifecycle_id, purpose, sha256, size,
             incarnation_id, physical_object_key
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, lifecycle_id, incarnation_id) DO NOTHING`,
          [
            input.scope.tenantId,
            randomUUID(),
            lifecycle.lifecycle_id,
            input.blob.purpose,
            input.blob.sha256,
            input.blob.size,
            input.claim.incarnationId,
            input.claim.physicalObjectKey,
          ],
        );
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "完成 stable 删除");
    }
  }

  async releasePreDeleteClaim(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
    readonly claim: StableBlobGcClaim;
  }): Promise<void> {
    assertTenantScope(input.scope);
    assertBlobRef(input.scope, input.blob);
    try {
      await withTenantTransaction(this.pool, input.scope, async (client) => {
        const released = await client.query<{ lifecycle_id: string }>(
          `UPDATE blob_lifecycles lifecycle
              SET state = 'active', current_claim_id = NULL, lease_expires_at = NULL,
                  updated_at = clock_timestamp()
            WHERE lifecycle.tenant_id = $1 AND lifecycle.purpose = $2
              AND lifecycle.sha256 = $3 AND lifecycle.size = $4
              AND lifecycle.state = 'pre_delete' AND lifecycle.current_incarnation_id = $5
              AND lifecycle.current_claim_id = $6 AND lifecycle.generation = $7
              AND EXISTS (
                SELECT 1 FROM blob_gc_claims claim
                 WHERE claim.tenant_id = lifecycle.tenant_id
                   AND claim.lifecycle_id = lifecycle.lifecycle_id
                   AND claim.claim_id = $6 AND claim.generation = $7
                   AND claim.phase = 'pre_delete' AND claim.physical_object_key = $8
              )
            RETURNING lifecycle.lifecycle_id`,
          [
            input.scope.tenantId,
            input.blob.purpose,
            input.blob.sha256,
            input.blob.size,
            input.claim.incarnationId,
            input.claim.claimId,
            input.claim.generation,
            input.claim.physicalObjectKey,
          ],
        );
        if (released.rows[0] !== undefined) {
          await client.query(
            `UPDATE blob_gc_claims SET phase = 'released', updated_at = clock_timestamp()
              WHERE tenant_id = $1 AND claim_id = $2 AND generation = $3`,
            [input.scope.tenantId, input.claim.claimId, input.claim.generation],
          );
          return;
        }
        const readback = await client.query<{ one: number }>(
          `SELECT 1 AS one
             FROM blob_lifecycles lifecycle
             JOIN blob_gc_claims claim
               ON claim.tenant_id = lifecycle.tenant_id
              AND claim.lifecycle_id = lifecycle.lifecycle_id
            WHERE lifecycle.tenant_id = $1 AND lifecycle.purpose = $2
              AND lifecycle.sha256 = $3 AND lifecycle.size = $4
              AND lifecycle.state = 'active' AND lifecycle.current_incarnation_id = $5
              AND claim.claim_id = $6 AND claim.generation = $7
              AND claim.phase = 'released' AND claim.incarnation_id = $5
              AND claim.physical_object_key = $8`,
          [
            input.scope.tenantId,
            input.blob.purpose,
            input.blob.sha256,
            input.blob.size,
            input.claim.incarnationId,
            input.claim.claimId,
            input.claim.generation,
            input.claim.physicalObjectKey,
          ],
        );
        if (readback.rows[0] !== undefined) return;
        throw casConflict("pre-delete claim 已失效或已进入 deleting");
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "释放 stable pre-delete claim");
    }
  }

  async resolveLifecycle(input: {
    readonly scope: TenantBlobScope;
    readonly blob: StableBlobRef;
  }): Promise<
    | { readonly status: "active" | "pre_delete" | "deleting" }
    | {
        readonly status: "deleted";
        readonly retiredIncarnationId: string;
        readonly retiredPhysicalObjectKey: string;
      }
  > {
    assertTenantScope(input.scope);
    assertBlobRef(input.scope, input.blob);
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const lifecycle = await findLifecycleForUpdate(client, input.scope.tenantId, input.blob);
        const incarnation = await findIncarnationByPhysical(
          client,
          input.scope.tenantId,
          input.blob,
        );
        if (incarnation?.state === "retired" || lifecycle?.state === "deleted") {
          return {
            status: "deleted" as const,
            retiredIncarnationId: input.blob.incarnationId,
            retiredPhysicalObjectKey: input.blob.physicalObjectKey,
          };
        }
        if (
          lifecycle === undefined ||
          lifecycle.current_incarnation_id !== input.blob.incarnationId
        ) {
          throw new Error("无法解析 stable lifecycle");
        }
        return { status: lifecycle.state };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "解析 stable lifecycle");
    }
  }

  async claimForScrub(input: {
    readonly scope: TenantBlobScope;
  }): Promise<
    | { readonly status: "claimed"; readonly tombstone: StableBlobRetiredTombstone }
    | { readonly status: "none" | "in_progress" }
  > {
    assertTenantScope(input.scope);
    try {
      return await withTenantTransaction(this.pool, input.scope, async (client) => {
        const candidate = await client.query<{
          tombstone_id: string;
          lifecycle_id: string;
          purpose: BlobPurpose;
          sha256: string;
          size: string;
          incarnation_id: string;
          physical_object_key: string;
          generation: string;
        }>(
          `SELECT tombstone_id, lifecycle_id, purpose, sha256, size,
                  incarnation_id, physical_object_key, generation
             FROM retired_blob_tombstones
            WHERE tenant_id = $1 AND next_scrub_at <= clock_timestamp()
              AND (scrub_lease_expires_at IS NULL OR scrub_lease_expires_at <= clock_timestamp())
            ORDER BY next_scrub_at, tombstone_id
            LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [input.scope.tenantId],
        );
        const row = candidate.rows[0];
        if (row === undefined) {
          const leased = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM retired_blob_tombstones
              WHERE tenant_id = $1 AND next_scrub_at <= clock_timestamp()
                AND scrub_lease_expires_at > clock_timestamp()`,
            [input.scope.tenantId],
          );
          return leased.rows[0]?.count === "0"
            ? { status: "none" as const }
            : { status: "in_progress" as const };
        }
        const incarnation = await findIncarnation(
          client,
          input.scope.tenantId,
          row.lifecycle_id,
          row.incarnation_id,
        );
        if (
          incarnation?.state !== "retired" ||
          incarnation.physical_object_key !== row.physical_object_key
        ) {
          throw new Error("tombstone 未绑定永久 retired incarnation");
        }
        const generation = safeInteger(row.generation, "tombstone generation") + 1;
        await client.query(
          `UPDATE retired_blob_tombstones
              SET generation = $3,
                  scrub_lease_expires_at = clock_timestamp() + ($4 * interval '1 second')
            WHERE tenant_id = $1 AND tombstone_id = $2`,
          [input.scope.tenantId, row.tombstone_id, generation, this.scrubLeaseSeconds],
        );
        return {
          status: "claimed" as const,
          tombstone: {
            tombstoneId: row.tombstone_id,
            generation,
            tenantId: input.scope.tenantId,
            purpose: row.purpose,
            sha256: row.sha256,
            size: safeInteger(row.size, "tombstone size"),
            incarnationId: row.incarnation_id,
            physicalObjectKey: row.physical_object_key,
          },
        };
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "取得 retired tombstone scrub claim");
    }
  }

  async completeScrub(input: {
    readonly scope: TenantBlobScope;
    readonly tombstone: StableBlobRetiredTombstone;
  }): Promise<void> {
    assertTenantScope(input.scope);
    try {
      await withTenantTransaction(this.pool, input.scope, async (client) => {
        const completed = await client.query(
          `UPDATE retired_blob_tombstones
              SET scrub_lease_expires_at = NULL, last_scrubbed_at = clock_timestamp(),
                  next_scrub_at = clock_timestamp() + ($9 * interval '1 second')
            WHERE tenant_id = $1 AND tombstone_id = $2 AND generation = $3
              AND purpose = $4 AND sha256 = $5 AND size = $6
              AND incarnation_id = $7 AND physical_object_key = $8`,
          [
            input.scope.tenantId,
            input.tombstone.tombstoneId,
            input.tombstone.generation,
            input.tombstone.purpose,
            input.tombstone.sha256,
            input.tombstone.size,
            input.tombstone.incarnationId,
            input.tombstone.physicalObjectKey,
            this.scrubIntervalSeconds,
          ],
        );
        if (completed.rowCount !== 1) throw casConflict("tombstone scrub claim 已失效");
      });
    } catch (error) {
      throw mapBlobPersistenceError(error, "完成 retired tombstone scrub");
    }
  }
}

function normalizePrefix(prefix: string): string {
  const value = prefix.replace(/^\/+|\/+$/gu, "");
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "..")
  ) {
    throw new TypeError("objectPrefix 格式无效");
  }
  return value;
}

function boundedSeconds(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 604_800) {
    throw new TypeError(`${name} 必须是 1 到 604800 之间的整数`);
  }
  return resolved;
}

function casConflict(message: string): PersistenceError {
  return new PersistenceError("CONFLICT", message);
}

/** 把公开 Blob 契约错误收敛为 Persistence 稳定码，禁止误包成 UNEXPECTED。 */
function mapBlobPersistenceError(error: unknown, operation: string): PersistenceError {
  if (!(error instanceof BlobStoreError)) return mapPersistenceError(error, operation);
  switch (error.code) {
    case "BLOB_IDEMPOTENCY_CONFLICT":
    case "BLOB_PRECONDITION_FAILED":
    case "BLOB_NOT_FOUND":
      return new PersistenceError("CONFLICT", `${operation}发生幂等或状态冲突`);
    case "INVALID_BLOB_ARGUMENT":
    case "TENANT_SCOPE_MISMATCH":
      return new PersistenceError("CONSTRAINT_VIOLATION", `${operation}违反 Blob 身份约束`);
    case "BLOB_INTEGRITY_MISMATCH":
      return error.result === "unknown"
        ? new PersistenceError("UNAVAILABLE", `${operation}读取到无法确认的 Blob 身份连续性`)
        : new PersistenceError("CONSTRAINT_VIOLATION", `${operation}违反 Blob 身份约束`);
    case "BLOB_RESULT_UNKNOWN":
    case "BLOB_PROVIDER_ERROR":
      return new PersistenceError("UNAVAILABLE", `${operation}结果暂不可确认`);
  }
}

function stableKey(
  prefix: string,
  tenantId: string,
  purpose: BlobPurpose,
  sha256: string,
  incarnationId: string,
): string {
  return `${prefix}/stable/${tenantId}/${purpose}/sha256/${sha256}/incarnations/${incarnationId}`;
}

function stagingKey(
  prefix: string,
  tenantId: string,
  purpose: BlobPurpose,
  uploadId: string,
): string {
  return `${prefix}/tenants/${tenantId}/staging/${purpose}/${uploadId}`;
}

function safeInteger(value: string | number, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} 超出安全整数范围`);
  return parsed;
}

function assertUuid(value: string, name: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError(`${name} 必须是 UUID v4`);
  }
}

function assertReferenceId(value: string): void {
  if (value.length < 1 || value.length > 200) throw new TypeError("referenceId 格式无效");
}

function assertAuthorizationRef(scope: TenantBlobScope, ref: PromotionAuthorizationRef): void {
  assertTenantScope(scope);
  assertBlobOperationId(ref.operationId);
  assertUuid(ref.authorizationId, "authorizationId");
  if (scope.tenantId !== ref.tenantId)
    throw new BlobStoreError("TENANT_SCOPE_MISMATCH", "授权不属于当前 Tenant");
}

function assertCommitSnapshot(snapshot: BlobCommitSnapshot): void {
  assertTenantScope(snapshot.scope);
  assertBlobOperationId(snapshot.operationId);
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) {
    throw new TypeError("snapshot version 无效");
  }
}

function assertCommitIdentity(
  scope: TenantBlobScope,
  operationId: string,
  expectedVersion: number,
  next: BlobCommitSnapshot,
): void {
  if (
    next.scope.tenantId !== scope.tenantId ||
    next.operationId !== operationId ||
    next.version !== expectedVersion + 1
  ) {
    throw new TypeError("next snapshot 未保持 Tenant、operation 或 version 连续");
  }
}

function serializeSnapshot(snapshot: BlobCommitSnapshot): string {
  return JSON.stringify(snapshot);
}

function mapCommit(row: CommitRow): BlobCommitSnapshot {
  if (typeof row.snapshot !== "object" || row.snapshot === null || Array.isArray(row.snapshot)) {
    throw new Error("blob commit snapshot 结构无效");
  }
  const snapshot = row.snapshot as BlobCommitSnapshot;
  if (
    snapshot.operationId !== row.operation_id ||
    snapshot.scope?.tenantId !== row.tenant_id ||
    snapshot.status !== row.status ||
    snapshot.version !== safeInteger(row.version, "commit version")
  ) {
    throw new Error("blob commit 规范列与 snapshot 不一致");
  }
  return snapshot;
}

async function findCommit(
  client: PoolClient,
  tenantId: string,
  operationId: string,
  lock: boolean,
): Promise<CommitRow | undefined> {
  const result = await client.query<CommitRow>(
    `SELECT tenant_id, operation_id, status, version, snapshot
       FROM blob_commits WHERE tenant_id = $1 AND operation_id = $2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, operationId],
  );
  return result.rows[0];
}

async function findLifecycleForUpdate(
  client: PoolClient,
  tenantId: string,
  descriptor: Pick<StagedBlobRef, "purpose" | "sha256" | "size">,
): Promise<LifecycleRow | undefined> {
  const result = await client.query<LifecycleRow>(
    `SELECT * FROM blob_lifecycles
      WHERE tenant_id = $1 AND purpose = $2 AND sha256 = $3 AND size = $4 FOR UPDATE`,
    [tenantId, descriptor.purpose, descriptor.sha256, descriptor.size],
  );
  return result.rows[0];
}

async function findLifecycleById(
  client: PoolClient,
  tenantId: string,
  lifecycleId: string,
  lock: boolean,
): Promise<LifecycleRow | undefined> {
  const result = await client.query<LifecycleRow>(
    `SELECT * FROM blob_lifecycles WHERE tenant_id = $1 AND lifecycle_id = $2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, lifecycleId],
  );
  return result.rows[0];
}

interface IncarnationRow extends QueryResultRow {
  readonly incarnation_id: string;
  readonly physical_object_key: string;
  readonly state: "allocated" | "active" | "retired";
}

async function findIncarnation(
  client: PoolClient,
  tenantId: string,
  lifecycleId: string,
  incarnationId: string,
): Promise<IncarnationRow | undefined> {
  const result = await client.query<IncarnationRow>(
    `SELECT incarnation_id, physical_object_key, state FROM blob_incarnations
      WHERE tenant_id = $1 AND lifecycle_id = $2 AND incarnation_id = $3`,
    [tenantId, lifecycleId, incarnationId],
  );
  return result.rows[0];
}

async function findLiveIncarnation(
  client: PoolClient,
  tenantId: string,
  lifecycleId: string,
): Promise<IncarnationRow | undefined> {
  const result = await client.query<IncarnationRow>(
    `SELECT incarnation_id, physical_object_key, state FROM blob_incarnations
      WHERE tenant_id = $1 AND lifecycle_id = $2 AND state IN ('allocated', 'active')`,
    [tenantId, lifecycleId],
  );
  return result.rows[0];
}

async function findIncarnationByPhysical(
  client: PoolClient,
  tenantId: string,
  blob: StableBlobRef,
): Promise<IncarnationRow | undefined> {
  const result = await client.query<IncarnationRow>(
    `SELECT incarnation_id, physical_object_key, state FROM blob_incarnations
      WHERE tenant_id = $1 AND incarnation_id = $2 AND physical_object_key = $3`,
    [tenantId, blob.incarnationId, blob.physicalObjectKey],
  );
  return result.rows[0];
}

async function findAllocationByOperation(
  client: PoolClient,
  tenantId: string,
  operationId: string,
  lock: boolean,
): Promise<AllocationRow | undefined> {
  const result = await client.query<AllocationRow>(
    `SELECT ${allocationColumns}
       FROM blob_allocations allocation
       JOIN blob_lifecycles lifecycle
         ON lifecycle.tenant_id = allocation.tenant_id
        AND lifecycle.lifecycle_id = allocation.lifecycle_id
      WHERE allocation.tenant_id = $1 AND allocation.operation_id = $2${lock ? " FOR UPDATE OF allocation" : ""}`,
    [tenantId, operationId],
  );
  return result.rows[0];
}

async function findAllocationById(
  client: PoolClient,
  tenantId: string,
  allocationId: string,
  lock: boolean,
): Promise<AllocationRow | undefined> {
  const result = await client.query<AllocationRow>(
    `SELECT ${allocationColumns}
       FROM blob_allocations allocation
       JOIN blob_lifecycles lifecycle
         ON lifecycle.tenant_id = allocation.tenant_id
        AND lifecycle.lifecycle_id = allocation.lifecycle_id
      WHERE allocation.tenant_id = $1 AND allocation.allocation_id = $2${lock ? " FOR UPDATE OF allocation" : ""}`,
    [tenantId, allocationId],
  );
  return result.rows[0];
}

function mapAllocation(row: AllocationRow): StableBlobLifecycleAllocation {
  return {
    tenantId: row.tenant_id,
    purpose: row.purpose,
    sha256: row.sha256,
    size: safeInteger(row.size, "allocation size"),
    incarnationId: row.incarnation_id,
    physicalObjectKey: row.physical_object_key,
    lifecycleId: row.lifecycle_id,
    allocationId: row.allocation_id,
    generation: safeInteger(row.generation, "allocation generation"),
    mode: row.mode,
  };
}

function assertAllocationIdempotency(
  row: AllocationRow,
  staged: StagedBlobRef,
  referenceId: string,
): void {
  if (
    row.tenant_id !== staged.tenantId ||
    row.purpose !== staged.purpose ||
    row.sha256 !== staged.sha256 ||
    safeInteger(row.size, "allocation size") !== staged.size ||
    row.staging_upload_id !== staged.uploadId ||
    row.staging_media_type !== staged.mediaType ||
    row.reference_id !== referenceId
  ) {
    throw new BlobStoreError("BLOB_IDEMPOTENCY_CONFLICT", "operationId 已绑定不同 allocation 输入");
  }
}

async function findAuthorization(
  client: PoolClient,
  tenantId: string,
  authorizationId: string,
  lock: boolean,
): Promise<AuthorizationRow | undefined> {
  const result = await client.query<AuthorizationRow>(
    `SELECT ${authorizationColumns}
       FROM promotion_authorizations a
       JOIN blob_allocations allocation
         ON allocation.tenant_id = a.tenant_id AND allocation.allocation_id = a.allocation_id
       JOIN blob_lifecycles lifecycle
         ON lifecycle.tenant_id = a.tenant_id AND lifecycle.lifecycle_id = a.lifecycle_id
       JOIN blob_incarnations incarnation
         ON incarnation.tenant_id = a.tenant_id AND incarnation.lifecycle_id = a.lifecycle_id
        AND incarnation.incarnation_id = a.incarnation_id
      WHERE a.tenant_id = $1 AND a.authorization_id = $2${lock ? " FOR UPDATE OF a" : ""}`,
    [tenantId, authorizationId],
  );
  return result.rows[0];
}

function mapAuthorization(row: AuthorizationRow): StableBlobPromotionAuthorization {
  return {
    ...mapAllocation(row),
    authorizationId: row.authorization_id,
    operationId: row.operation_id,
    referenceId: row.reference_id,
    stagingUploadId: row.staging_upload_id,
    stagingObjectKey: row.staging_object_key,
  };
}

function classifyAuthorization(
  row: AuthorizationRow | undefined,
  operationId: string,
): Exclude<PromotionAuthorizationResolution["status"], "authorized"> | undefined {
  if (row === undefined) return "not_found";
  if (row.operation_id !== operationId) return "wrong_operation";
  if (row.authorization_state === "consumed_not_copied") return "consumed";
  if (row.incarnation_state === "retired") return "retired";
  if (row.lifecycle_state === "pre_delete" || row.lifecycle_state === "deleting") return "inactive";
  return undefined;
}

async function findExecution(
  client: PoolClient,
  tenantId: string,
  executionId: string,
  lock: boolean,
): Promise<ExecutionRow | undefined> {
  const result = await client.query<ExecutionRow>(
    `SELECT * FROM promotion_executions
      WHERE tenant_id = $1 AND execution_id = $2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, executionId],
  );
  return result.rows[0];
}

async function findBoundCurrentExecution(
  client: PoolClient,
  authorization: AuthorizationRow,
  lock: boolean,
): Promise<ExecutionRow | undefined> {
  if (authorization.current_execution_id === null) {
    if (safeInteger(authorization.execution_generation, "execution generation") !== 0) {
      throw executionBindingMismatch("authorization 缺少 current execution 但 generation 非零");
    }
    return undefined;
  }
  const execution = await findExecution(
    client,
    authorization.tenant_id,
    authorization.current_execution_id,
    lock,
  );
  if (execution === undefined) {
    throw executionBindingMismatch("authorization 的 current execution 不存在");
  }
  assertExecutionBoundToAuthorization(authorization, execution);
  return execution;
}

function assertExecutionBoundToAuthorization(
  authorization: AuthorizationRow,
  execution: ExecutionRow,
): void {
  if (
    execution.tenant_id !== authorization.tenant_id ||
    execution.authorization_id !== authorization.authorization_id ||
    execution.operation_id !== authorization.operation_id ||
    execution.execution_id !== authorization.current_execution_id ||
    safeInteger(execution.generation, "execution generation") !==
      safeInteger(authorization.execution_generation, "authorization execution generation")
  ) {
    throw executionBindingMismatch("authorization 与 current execution 完整身份不连续");
  }
}

function executionBindingMismatch(message: string): BlobStoreError {
  return new BlobStoreError("BLOB_INTEGRITY_MISMATCH", message, { result: "unknown" });
}

function mapExecution(row: ExecutionRow): PromotionExecutionClaim {
  return {
    tenantId: row.tenant_id,
    operationId: row.operation_id,
    authorizationId: row.authorization_id,
    executionId: row.execution_id,
    attemptId: row.attempt_id,
    generation: safeInteger(row.generation, "execution generation"),
    phase: row.phase === "not_copied" || row.phase === "succeeded" ? "unknown" : row.phase,
    incarnationId: row.incarnation_id,
    physicalObjectKey: row.physical_object_key,
  };
}

function executionMatches(row: ExecutionRow, execution: PromotionExecutionClaim): boolean {
  return (
    row.tenant_id === execution.tenantId &&
    row.operation_id === execution.operationId &&
    row.authorization_id === execution.authorizationId &&
    row.execution_id === execution.executionId &&
    row.attempt_id === execution.attemptId &&
    safeInteger(row.generation, "execution generation") === execution.generation &&
    row.incarnation_id === execution.incarnationId &&
    row.physical_object_key === execution.physicalObjectKey
  );
}

async function databaseLeaseExpired(client: PoolClient, expiresAt: Date | null): Promise<boolean> {
  if (expiresAt === null) return true;
  const result = await client.query<{ expired: boolean }>(
    "SELECT $1::timestamptz <= clock_timestamp() AS expired",
    [expiresAt],
  );
  return result.rows[0]?.expired === true;
}

function gcClaim(
  blob: StableBlobRef,
  claimId: string,
  generation: number,
  phase: "pre_delete" | "deleting",
  lease: Date,
): StableBlobGcClaim {
  return {
    claimId,
    generation,
    leaseExpiresAt: lease.toISOString(),
    phase,
    tenantId: blob.tenantId,
    purpose: blob.purpose,
    sha256: blob.sha256,
    size: blob.size,
    incarnationId: blob.incarnationId,
    physicalObjectKey: blob.physicalObjectKey,
  };
}

function stableToStagedView(stable: StableBlobRef, uploadId: string): StagedBlobRef {
  return {
    kind: "staging",
    tenantId: stable.tenantId,
    purpose: stable.purpose,
    sha256: stable.sha256,
    size: stable.size,
    mediaType: stable.mediaType,
    uploadId,
  };
}

function assertReferenceMatchesStaged(row: Record<string, unknown>, staged: StagedBlobRef): void {
  if (
    row.tenant_id !== staged.tenantId ||
    row.purpose !== staged.purpose ||
    row.sha256 !== staged.sha256 ||
    safeInteger(String(row.size), "reference size") !== staged.size ||
    row.media_type !== staged.mediaType ||
    row.staging_upload_id !== staged.uploadId
  ) {
    throw new BlobStoreError("BLOB_IDEMPOTENCY_CONFLICT", "reference 已绑定不同 staging");
  }
}

function assertReferenceMatchesStable(row: Record<string, unknown>, stable: StableBlobRef): void {
  if (
    row.tenant_id !== stable.tenantId ||
    row.purpose !== stable.purpose ||
    row.sha256 !== stable.sha256 ||
    safeInteger(String(row.size), "reference size") !== stable.size ||
    row.media_type !== stable.mediaType ||
    row.incarnation_id !== stable.incarnationId ||
    row.physical_object_key !== stable.physicalObjectKey
  ) {
    throw new BlobStoreError("BLOB_IDEMPOTENCY_CONFLICT", "reference 已绑定不同 stable");
  }
}
