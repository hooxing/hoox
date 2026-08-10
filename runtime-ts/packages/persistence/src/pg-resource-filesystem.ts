import { resourceId, resourceVersionId, tenantId } from "@cube-runtime/domain";
import {
  type HistoryFileLibraryCatalog,
  type HistoryFileLibraryFile,
  type HistoryFileLibraryPage,
  type HistoryFileLibraryTask,
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
  readonly blob_purpose: "resource" | "workspace";
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
  readonly last_attached_at: Date | string;
}

/** 宿主 ResourceFS 只读取 searchable 的不可变版本；Resource 与正式交付物复用原 Blob，不向 Sandbox 暴露对象键。 */
export class PgResourceFilesystemCatalog
  implements ResourceFilesystemCatalog, HistoryFilesystemCatalog, HistoryFileLibraryCatalog
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
          if (!(await isHistoryTenant(client, input.tenantId))) return undefined;
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
      throw mapPersistenceError(error, "列出历史目录");
    }
  }

  async listTaskPage(
    input: Parameters<HistoryFileLibraryCatalog["listTaskPage"]>[0],
  ): Promise<HistoryFileLibraryPage | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isHistoryTenant(client, input.tenantId))) return undefined;
          const rows = await client.query<HistoryDirectoryRow>(
            `SELECT directory.thread_id,directory.directory_name,
                    directory.directory_timestamp,directory.last_file_at,
                    directory.file_count::text
               FROM thread_history_directories directory
              WHERE directory.tenant_id=$1
                AND directory.naming_state IN ('ready','fallback')
                AND directory.file_count > 0
                AND ($2::timestamptz IS NULL OR directory.last_file_at >= $2::timestamptz)
                AND ($3::timestamptz IS NULL OR directory.last_file_at < $3::timestamptz)
                AND (
                  $4::timestamptz IS NULL
                  OR directory.last_file_at < $4::timestamptz
                  OR (directory.last_file_at = $4::timestamptz AND directory.thread_id < $5)
                )
                AND (
                  $6 = ''
                  OR position(lower($6) in lower(directory.directory_name)) > 0
                  OR EXISTS (
                    SELECT 1
                      FROM thread_history_file_entries matched_entry
                      JOIN resources matched_resource
                        ON matched_resource.tenant_id=matched_entry.tenant_id
                       AND matched_resource.id=matched_entry.resource_id
                       AND matched_resource.visibility='searchable'
                     WHERE matched_entry.tenant_id=directory.tenant_id
                       AND matched_entry.thread_id=directory.thread_id
                       AND (
                         position(lower($6) in lower(matched_entry.directory_entry_name)) > 0
                         OR position(lower($6) in lower(matched_resource.name)) > 0
                       )
                  )
                )
              ORDER BY directory.last_file_at DESC,directory.thread_id DESC
              LIMIT $7`,
            [
              input.tenantId,
              input.activeAfter ?? null,
              input.activeBefore ?? null,
              input.before?.lastFileAt ?? null,
              input.before?.threadId ?? null,
              input.query,
              input.limit + 1,
            ],
          );
          const hasMore = rows.rows.length > input.limit;
          const pageRows = rows.rows.slice(0, input.limit);
          const threadIds = pageRows.map((row) => row.thread_id);
          const filesByThread = new Map<string, HistoryFileLibraryFile[]>();
          if (threadIds.length > 0) {
            const files = await client.query<HistoryFileRow>(
              `${historyFileQuery}
                WHERE entry.tenant_id=$1 AND entry.thread_id=ANY($2::text[])
                  AND (
                    $3 = ''
                    OR position(lower($3) in lower(directory.directory_name)) > 0
                    OR position(lower($3) in lower(entry.directory_entry_name)) > 0
                    OR position(lower($3) in lower(resource.name)) > 0
                  )
                ORDER BY entry.thread_id,entry.last_attached_at DESC,entry.directory_entry_name`,
              [input.tenantId, threadIds, input.query],
            );
            for (const row of files.rows) {
              const mapped = mapHistoryLibraryFile(input.tenantId, row);
              const current = filesByThread.get(row.thread_id);
              if (current === undefined) filesByThread.set(row.thread_id, [mapped]);
              else current.push(mapped);
            }
          }
          let hasOlder = false;
          if (input.activeAfter !== undefined) {
            const older = await client.query<{ readonly present: boolean }>(
              `SELECT EXISTS (
                   SELECT 1
                     FROM thread_history_directories directory
                    WHERE directory.tenant_id=$1
                      AND directory.naming_state IN ('ready','fallback')
                      AND directory.file_count > 0
                      AND directory.last_file_at < $2::timestamptz
                      AND (
                        $3 = ''
                        OR position(lower($3) in lower(directory.directory_name)) > 0
                        OR EXISTS (
                          SELECT 1
                            FROM thread_history_file_entries matched_entry
                            JOIN resources matched_resource
                              ON matched_resource.tenant_id=matched_entry.tenant_id
                             AND matched_resource.id=matched_entry.resource_id
                             AND matched_resource.visibility='searchable'
                           WHERE matched_entry.tenant_id=directory.tenant_id
                             AND matched_entry.thread_id=directory.thread_id
                             AND (
                               position(lower($3) in lower(matched_entry.directory_entry_name)) > 0
                               OR position(lower($3) in lower(matched_resource.name)) > 0
                             )
                        )
                      )
                 ) AS present`,
              [input.tenantId, input.activeAfter, input.query],
            );
            hasOlder = older.rows[0]?.present === true;
          }
          const items: HistoryFileLibraryTask[] = pageRows.map((row) => {
            const directory = mapDirectory(row);
            return Object.freeze({
              threadId: directory.threadId,
              name: directory.name,
              createdAt: directory.createdAt,
              lastFileAt: directory.lastFileAt,
              fileCount: directory.fileCount,
              files: Object.freeze(filesByThread.get(directory.threadId) ?? []),
            });
          });
          const tail = pageRows.at(-1);
          return Object.freeze({
            items: Object.freeze(items),
            range: Object.freeze({
              ...(input.activeAfter === undefined ? {} : { activeAfter: input.activeAfter }),
              ...(input.activeBefore === undefined ? {} : { activeBefore: input.activeBefore }),
            }),
            hasMore,
            hasOlder,
            ...(hasMore && tail !== undefined
              ? {
                  next: Object.freeze({
                    lastFileAt: timestamp(tail.last_file_at),
                    threadId: tail.thread_id,
                  }),
                }
              : {}),
          });
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "浏览历史文件");
    }
  }

  async resolveLibraryFile(
    input: Parameters<HistoryFileLibraryCatalog["resolveLibraryFile"]>[0],
  ): Promise<HistoryFileLibraryFile | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isHistoryTenant(client, input.tenantId))) return undefined;
          const result = await client.query<HistoryFileRow>(
            `${historyFileQuery}
              WHERE entry.tenant_id=$1 AND entry.resource_id=$2 AND entry.resource_version_id=$3
              ORDER BY entry.last_attached_at DESC,entry.thread_id
              LIMIT 1`,
            [input.tenantId, input.resourceId, input.versionId],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : mapHistoryLibraryFile(input.tenantId, row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析历史文件下载");
    }
  }

  async listThreadIds(
    input: Parameters<HistoryFilesystemCatalog["listThreadIds"]>[0],
  ): Promise<readonly string[] | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input,
        async (client) => {
          if (!(await isHistoryTenant(client, input.tenantId))) return undefined;
          // WebDAV/FUSE 必须能从父目录枚举到子目录，才能解析已知的隐藏 Thread 路径。
          // 空 Thread 也必须预声明稳定目录，避免首个附件使持久 rclone mount 新增父目录并命中旧缓存。
          const result = await client.query<{ readonly thread_id: string }>(
            `SELECT thread.id AS thread_id
               FROM threads thread
              WHERE thread.tenant_id=$1
              ORDER BY thread.id`,
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
          if (!(await isHistoryTenant(client, input.tenantId))) return undefined;
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
      throw mapPersistenceError(error, "解析历史目录");
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
          if (!(await isHistoryThread(client, input.tenantId, input.threadId))) return undefined;
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
          if (!(await isHistoryTenant(client, input.tenantId))) return undefined;
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
      throw mapPersistenceError(error, "解析历史文件");
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
          if (!(await isHistoryThread(client, input.tenantId, input.threadId))) return undefined;
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
                          version.media_type,version.size::text,version.digest,version.blob_purpose,
                          version.blob_incarnation_id::text,version.physical_object_key
                     FROM resources resource
                     JOIN resource_versions version
                       ON version.tenant_id=resource.tenant_id
                      AND version.resource_id=resource.id
                     JOIN blob_references reference
                       ON reference.tenant_id=version.tenant_id
                      AND reference.reference_id=version.blob_reference_id
                      AND reference.state='stable' AND reference.purpose=version.blob_purpose
                      AND reference.sha256=version.digest AND reference.size=version.size
                      AND reference.incarnation_id=version.blob_incarnation_id
                      AND reference.physical_object_key=version.physical_object_key`;

const historyFileQuery = `SELECT entry.thread_id,directory.directory_name,
                                 entry.directory_entry_name,entry.last_attached_at,
                                 resource.id AS resource_id,version.id AS version_id,resource.name,
                                 version.media_type,version.size::text,version.digest,version.blob_purpose,
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
                             AND reference.state='stable' AND reference.purpose=version.blob_purpose
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

async function isHistoryTenant(client: PoolClient, rawTenantId: string): Promise<boolean> {
  const result = await client.query<{ readonly kind: string }>(
    "SELECT kind FROM tenants WHERE id=$1",
    [rawTenantId],
  );
  return result.rows[0]?.kind === "personal" || result.rows[0]?.kind === "team";
}

async function isHistoryThread(
  client: PoolClient,
  rawTenantId: string,
  rawThreadId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM threads thread
       JOIN tenants tenant ON tenant.id=thread.tenant_id AND tenant.kind IN ('personal','team')
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

function mapHistoryLibraryFile(rawTenantId: string, row: HistoryFileRow): HistoryFileLibraryFile {
  return Object.freeze({
    ...mapHistoryFile(rawTenantId, row),
    taskName: row.directory_name,
    attachedAt: timestamp(row.last_attached_at),
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
      purpose: row.blob_purpose,
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
