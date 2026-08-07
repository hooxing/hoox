import { resourceId, resourceVersionId, tenantId } from "@cube-runtime/domain";
import {
  type HistoryFilesystemCatalog,
  type HistoryFilesystemDirectory,
  type HistoryFilesystemFile,
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

interface HistoryDirectoryRow {
  readonly thread_id: string;
  readonly directory_name: string;
  readonly directory_timestamp: Date | string;
  readonly last_file_at: Date | string;
  readonly file_count: string;
}

interface HistoryFileRow extends ResourceFileRow {
  readonly thread_id: string;
  readonly directory_name: string;
  readonly directory_entry_name: string;
}

/** 宿主 ResourceFS 只读取 searchable 的不可变版本，并且永不向 Cube Volume/Sandbox 暴露对象键。 */
export class PgResourceFilesystemCatalog
  implements ResourceFilesystemCatalog, HistoryFilesystemCatalog
{
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

  async listRecentDirectories(
    input: Parameters<HistoryFilesystemCatalog["listRecentDirectories"]>[0],
  ): Promise<readonly HistoryFilesystemDirectory[] | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isPersonalTenant(client, input.tenantId))) return undefined;
          const result = await client.query<HistoryDirectoryRow>(
            `SELECT directory.thread_id,directory.directory_name,
                    directory.directory_timestamp,directory.last_file_at,
                    directory.file_count::text
               FROM thread_history_directories directory
              WHERE directory.tenant_id=$1
                AND directory.naming_state IN ('ready','fallback')
                AND directory.file_count > 0
                AND directory.last_file_at >= clock_timestamp() - interval '6 months'
              ORDER BY directory.directory_timestamp DESC,directory.thread_id`,
            [input.tenantId],
          );
          return Object.freeze(result.rows.map(mapDirectory));
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "列出个人历史目录");
    }
  }

  async listThreadFileThreadIds(
    input: Parameters<HistoryFilesystemCatalog["listThreadFileThreadIds"]>[0],
  ): Promise<readonly string[] | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isPersonalTenant(client, input.tenantId))) return undefined;
          // WebDAV/FUSE 必须能从父目录枚举到子目录，才能解析已知的隐藏 Thread 路径。
          // 这里只返回有文件的 Thread ID，不加载 ResourceVersion、Blob 或语义目录正文。
          const result = await client.query<{ readonly thread_id: string }>(
            `SELECT DISTINCT entry.thread_id
               FROM thread_history_file_entries entry
              WHERE entry.tenant_id=$1
              ORDER BY entry.thread_id`,
            [input.tenantId],
          );
          return Object.freeze(result.rows.map((row) => row.thread_id));
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "列出稳定任务文件入口");
    }
  }

  async resolveDirectory(
    input: Parameters<HistoryFilesystemCatalog["resolveDirectory"]>[0],
  ): Promise<HistoryFilesystemDirectory | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isPersonalTenant(client, input.tenantId))) return undefined;
          const result = await client.query<HistoryDirectoryRow>(
            `SELECT directory.thread_id,directory.directory_name,
                    directory.directory_timestamp,directory.last_file_at,
                    directory.file_count::text
               FROM thread_history_directories directory
              WHERE directory.tenant_id=$1 AND directory.directory_name=$2
                AND directory.naming_state IN ('ready','fallback')`,
            [input.tenantId, input.directoryName],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : mapDirectory(row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析个人历史目录");
    }
  }

  async listThreadFiles(
    input: Parameters<HistoryFilesystemCatalog["listThreadFiles"]>[0],
  ): Promise<readonly HistoryFilesystemFile[] | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isPersonalThread(client, input.tenantId, input.threadId))) return undefined;
          const result = await client.query<HistoryFileRow>(
            `${historyFileQuery}
              WHERE entry.tenant_id=$1 AND entry.thread_id=$2
              ORDER BY entry.first_attached_at,entry.directory_entry_name`,
            [input.tenantId, input.threadId],
          );
          return Object.freeze(result.rows.map((row) => mapHistoryFile(input.tenantId, row)));
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "列出任务历史文件");
    }
  }

  async resolveHistoryFile(
    input: Parameters<HistoryFilesystemCatalog["resolveHistoryFile"]>[0],
  ): Promise<HistoryFilesystemFile | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isPersonalTenant(client, input.tenantId))) return undefined;
          const result = await client.query<HistoryFileRow>(
            `${historyFileQuery}
              WHERE entry.tenant_id=$1 AND directory.directory_name=$2
                AND entry.directory_entry_name=$3`,
            [input.tenantId, input.directoryName, input.entryName],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : mapHistoryFile(input.tenantId, row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析个人历史文件");
    }
  }

  async resolveThreadFile(
    input: Parameters<HistoryFilesystemCatalog["resolveThreadFile"]>[0],
  ): Promise<HistoryFilesystemFile | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isPersonalThread(client, input.tenantId, input.threadId))) return undefined;
          const result = await client.query<HistoryFileRow>(
            `${historyFileQuery}
              WHERE entry.tenant_id=$1 AND entry.thread_id=$2
                AND entry.directory_entry_name=$3`,
            [input.tenantId, input.threadId, input.entryName],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : mapHistoryFile(input.tenantId, row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析当前任务历史文件");
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

const historyFileQuery = `SELECT entry.thread_id,directory.directory_name,
                                 entry.directory_entry_name,
                                 resource.id AS resource_id,version.id AS version_id,resource.name,
                                 version.media_type,version.size::text,version.digest,
                                 version.blob_incarnation_id::text,version.physical_object_key
                            FROM thread_history_file_entries entry
                            JOIN thread_history_directories directory
                              ON directory.tenant_id=entry.tenant_id
                             AND directory.thread_id=entry.thread_id
                            JOIN resources resource
                              ON resource.tenant_id=entry.tenant_id
                             AND resource.id=entry.resource_id
                             AND resource.visibility='searchable'
                            JOIN resource_versions version
                              ON version.tenant_id=entry.tenant_id
                             AND version.resource_id=entry.resource_id
                             AND version.id=entry.resource_version_id
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

async function isPersonalTenant(client: PoolClient, rawTenantId: string): Promise<boolean> {
  const result = await client.query<{ readonly kind: string }>(
    "SELECT kind FROM tenants WHERE id=$1",
    [rawTenantId],
  );
  return result.rows[0]?.kind === "personal";
}

async function isPersonalThread(
  client: PoolClient,
  rawTenantId: string,
  rawThreadId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM threads thread
       JOIN tenants tenant ON tenant.id=thread.tenant_id AND tenant.kind='personal'
      WHERE thread.tenant_id=$1 AND thread.id=$2`,
    [rawTenantId, rawThreadId],
  );
  return result.rowCount === 1;
}

function mapDirectory(row: HistoryDirectoryRow): HistoryFilesystemDirectory {
  const fileCount = Number(row.file_count);
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw new TypeError("历史目录文件数量无效");
  }
  return Object.freeze({
    threadId: row.thread_id,
    name: row.directory_name,
    createdAt: timestamp(row.directory_timestamp),
    lastFileAt: timestamp(row.last_file_at),
    fileCount,
  });
}

function mapHistoryFile(rawTenantId: string, row: HistoryFileRow): HistoryFilesystemFile {
  return Object.freeze({
    ...mapFile(rawTenantId, row),
    threadId: row.thread_id,
    directoryName: row.directory_name,
    entryName: row.directory_entry_name,
  });
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

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
