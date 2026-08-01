import {
  appendResourceVersion,
  createResource,
  rehydrateResource,
  rehydrateResourceVersion,
  sha256Digest,
  tenantId,
} from "@cube-runtime/domain";
import {
  normalizeSearchQuery,
  type PersistedResourceUpload,
  type ResourceUploadCommitResult,
  type ResourceUploadRepository,
} from "@cube-runtime/resource";
import type { Pool, PoolClient } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import { TransactionCommitUnknownError, withTenantTransaction } from "./postgres.js";

interface UploadedResourceRow {
  readonly resource_id: string;
  readonly version_id: string;
  readonly name: string;
  readonly origin: string;
  readonly visibility: string;
  readonly digest: string;
  readonly media_type: string;
  readonly size: string;
  readonly blob_reference_id: string;
  readonly blob_incarnation_id: string;
  readonly physical_object_key: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/** 用户上传只创建一个不可变首版；稳定 Blob 与 ResourceVersion 的绑定在同一事务中提交。 */
export class PgResourceUploadRepository implements ResourceUploadRepository {
  constructor(private readonly pool: Pool) {}

  async commit(
    input: Parameters<ResourceUploadRepository["commit"]>[0],
  ): Promise<ResourceUploadCommitResult> {
    try {
      return await withTenantTransaction(this.pool, input.context, async (client) => {
        if (!(await hasActiveMembership(client, input.context.tenantId, input.context.userId))) {
          return { outcome: "not_authorized" as const };
        }
        const existing = await findUpload(client, input.context.tenantId, input.resourceId);
        if (existing !== undefined) return replay(input, existing);
        const lifecycle = await resolveStableBlob(client, input.context.tenantId, input.persisted);
        if (lifecycle === undefined) return { outcome: "blob_unavailable" as const };
        const initial = createResource({
          id: input.resourceId,
          tenantId: tenantId(input.context.tenantId),
          name: input.name,
          origin: "upload",
          now: input.now,
        });
        const aggregate = appendResourceVersion({
          resource: initial,
          tenantId: initial.tenantId,
          versionId: input.versionId,
          expectedLatestVersionNumber: 0,
          objectKey: input.persisted.object.physicalObjectKey,
          digest: sha256Digest(input.persisted.object.sha256),
          mediaType: input.mediaType,
          sizeBytes: input.persisted.object.size,
          now: input.now,
        });
        await client.query(
          `INSERT INTO resources(
             tenant_id,id,name,normalized_name,origin,visibility,
             latest_version_number,created_at,updated_at
           ) VALUES($1,$2,$3,$4,'upload','pending_explicit_commit',0,$5,$5)`,
          [
            input.context.tenantId,
            aggregate.resource.id,
            aggregate.resource.name,
            normalizeSearchQuery(aggregate.resource.name),
            input.now,
          ],
        );
        await client.query(
          `INSERT INTO resource_versions(
             tenant_id,resource_id,id,version_number,parent_version_id,
             blob_reference_id,blob_purpose,blob_lifecycle_id,blob_incarnation_id,
             physical_object_key,digest,media_type,size,created_at
           ) VALUES($1,$2,$3,1,NULL,$4,'resource',$5::uuid,$6::uuid,$7,$8,$9,$10,$11)`,
          [
            input.context.tenantId,
            aggregate.resource.id,
            aggregate.version.id,
            input.persisted.referenceId,
            lifecycle,
            input.persisted.object.incarnationId,
            input.persisted.object.physicalObjectKey,
            input.persisted.object.sha256,
            aggregate.version.mediaType,
            aggregate.version.sizeBytes,
            input.now,
          ],
        );
        const advanced = await client.query(
          `UPDATE resources
              SET latest_version_number=1,latest_version_id=$3,
                  visibility='searchable',updated_at=$4
            WHERE tenant_id=$1 AND id=$2 AND latest_version_number=0`,
          [input.context.tenantId, aggregate.resource.id, aggregate.version.id, input.now],
        );
        if (advanced.rowCount !== 1) throw new Error("上传 Resource head 未推进");
        return Object.freeze({ outcome: "committed" as const, ...aggregate });
      });
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError) {
        const resolved = await this.resolveUnknown(input);
        if (resolved !== undefined) return resolved;
        throw new PersistenceError("UNAVAILABLE", "上传 Resource 提交结果仍未知");
      }
      throw mapPersistenceError(error, "提交上传 Resource");
    }
  }

  private async resolveUnknown(
    input: Parameters<ResourceUploadRepository["commit"]>[0],
  ): Promise<ResourceUploadCommitResult | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.context,
        async (client) => {
          const existing = await findUpload(client, input.context.tenantId, input.resourceId);
          return existing === undefined ? undefined : replay(input, existing);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析上传 Resource 提交结果");
    }
  }
}

async function hasActiveMembership(
  client: PoolClient,
  tenant: string,
  user: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM memberships
      WHERE tenant_id=$1 AND user_id=$2 AND status='active'
      FOR UPDATE`,
    [tenant, user],
  );
  return result.rowCount === 1;
}

async function resolveStableBlob(
  client: PoolClient,
  tenant: string,
  persisted: PersistedResourceUpload,
): Promise<string | undefined> {
  const result = await client.query<{ readonly lifecycle_id: string }>(
    `SELECT lifecycle_id::text
       FROM blob_references
      WHERE tenant_id=$1 AND reference_id=$2 AND state='stable' AND purpose='resource'
        AND sha256=$3 AND size=$4 AND media_type=$5
        AND incarnation_id=$6::uuid AND physical_object_key=$7`,
    [
      tenant,
      persisted.referenceId,
      persisted.object.sha256,
      persisted.object.size,
      persisted.object.mediaType,
      persisted.object.incarnationId,
      persisted.object.physicalObjectKey,
    ],
  );
  return result.rows[0]?.lifecycle_id;
}

async function findUpload(
  client: PoolClient,
  tenant: string,
  id: string,
): Promise<UploadedResourceRow | undefined> {
  const result = await client.query<UploadedResourceRow>(
    `SELECT resource.id AS resource_id,version.id AS version_id,resource.name,
            resource.origin,resource.visibility,version.digest,version.media_type,
            version.size::text,version.blob_reference_id,
            version.blob_incarnation_id::text,version.physical_object_key,
            resource.created_at,resource.updated_at
       FROM resources resource
       JOIN resource_versions version
         ON version.tenant_id=resource.tenant_id
        AND version.resource_id=resource.id
        AND version.id=resource.latest_version_id
      WHERE resource.tenant_id=$1 AND resource.id=$2`,
    [tenant, id],
  );
  return result.rows[0];
}

function replay(
  input: Parameters<ResourceUploadRepository["commit"]>[0],
  row: UploadedResourceRow,
): ResourceUploadCommitResult {
  const size = Number(row.size);
  if (
    row.resource_id !== input.resourceId ||
    row.version_id !== input.versionId ||
    row.name !== input.name ||
    row.origin !== "upload" ||
    row.visibility !== "searchable" ||
    row.digest !== input.persisted.object.sha256 ||
    row.media_type !== input.mediaType ||
    size !== input.persisted.object.size ||
    row.blob_reference_id !== input.persisted.referenceId ||
    row.blob_incarnation_id !== input.persisted.object.incarnationId ||
    row.physical_object_key !== input.persisted.object.physicalObjectKey
  ) {
    return { outcome: "key_conflict" };
  }
  const createdAt = new Date(row.created_at).toISOString();
  const updatedAt = new Date(row.updated_at).toISOString();
  const resource = rehydrateResource(
    {
      id: row.resource_id,
      tenantId: input.context.tenantId,
      name: row.name,
      origin: "upload",
      latestVersionNumber: 1,
      latestVersionId: row.version_id,
      createdAt,
      updatedAt,
    },
    tenantId(input.context.tenantId),
  );
  const version = rehydrateResourceVersion(
    {
      id: row.version_id,
      resourceId: row.resource_id,
      tenantId: input.context.tenantId,
      versionNumber: 1,
      objectKey: row.physical_object_key,
      digest: row.digest,
      mediaType: row.media_type,
      sizeBytes: size,
      createdAt,
    },
    resource,
  );
  return Object.freeze({ outcome: "replayed" as const, resource, version });
}
