import { resourceId, resourceVersionId, tenantId } from "@cube-runtime/domain";
import {
  type ResourceFilesystemCatalog,
  type ResourceFilesystemFile,
  resourceFilesystemPath,
} from "@cube-runtime/resource";
import type { Pool, PoolClient } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

interface ResourceFileRow {
  readonly resource_id: string;
  readonly version_id: string;
  readonly name: string;
  readonly media_type: string;
  readonly size: string;
  readonly digest: string;
  readonly blob_incarnation_id: string;
  readonly physical_object_key: string;
}

/** WebDAV 目录只读取 searchable 的不可变版本，并且永不向 Sandbox 暴露对象键。 */
export class PgResourceFilesystemCatalog implements ResourceFilesystemCatalog {
  constructor(private readonly pool: Pool) {}

  async list(
    input: Parameters<ResourceFilesystemCatalog["list"]>[0],
  ): Promise<readonly ResourceFilesystemFile[]> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          const result = await client.query<ResourceFileRow>(
            `${baseQuery}
              WHERE resource.tenant_id=$1 AND resource.visibility='searchable'
              ORDER BY resource.id,version.version_number,version.id`,
            [input.tenantId],
          );
          return Object.freeze(result.rows.map((row) => mapFile(input.tenantId, row)));
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "列出 Resource 文件系统");
    }
  }

  async resolve(
    input: Parameters<ResourceFilesystemCatalog["resolve"]>[0],
  ): Promise<ResourceFilesystemFile | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => findFile(client, input),
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析 Resource 文件系统路径");
    }
  }
}

const baseQuery = `SELECT resource.id AS resource_id,version.id AS version_id,resource.name,
                          version.media_type,version.size::text,version.digest,
                          version.blob_incarnation_id::text,version.physical_object_key
                     FROM resources resource
                     JOIN resource_versions version
                       ON version.tenant_id=resource.tenant_id
                      AND version.resource_id=resource.id
                     JOIN blob_references reference
                       ON reference.tenant_id=version.tenant_id
                      AND reference.reference_id=version.blob_reference_id
                      AND reference.state='stable' AND reference.purpose='resource'
                      AND reference.sha256=version.digest AND reference.size=version.size
                      AND reference.incarnation_id=version.blob_incarnation_id
                      AND reference.physical_object_key=version.physical_object_key`;

async function findFile(
  client: PoolClient,
  input: Parameters<ResourceFilesystemCatalog["resolve"]>[0],
): Promise<ResourceFilesystemFile | undefined> {
  const result = await client.query<ResourceFileRow>(
    `${baseQuery}
      WHERE resource.tenant_id=$1 AND resource.visibility='searchable'
        AND resource.id=$2 AND version.id=$3`,
    [input.tenantId, input.resourceId, input.versionId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapFile(input.tenantId, row);
}

function mapFile(rawTenantId: string, row: ResourceFileRow): ResourceFilesystemFile {
  const tenant = tenantId(rawTenantId);
  const resource = resourceId(row.resource_id);
  const version = resourceVersionId(row.version_id);
  const size = Number(row.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Resource 文件大小无效");
  return Object.freeze({
    resourceId: resource,
    versionId: version,
    name: row.name,
    path: resourceFilesystemPath(resource, version, row.name),
    mediaType: row.media_type,
    sizeBytes: size,
    object: Object.freeze({
      tenantId: tenant,
      purpose: "resource" as const,
      sha256: row.digest,
      size,
      mediaType: row.media_type,
      incarnationId: row.blob_incarnation_id,
      physicalObjectKey: row.physical_object_key,
    }),
  });
}
