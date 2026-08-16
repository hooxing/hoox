import {
  historyFilesystemCollisionName,
  historyFilesystemDirectoryName,
  historyFilesystemEntryCollisionName,
  historyFilesystemEntryName,
} from "@aisay/resource";
import type { PoolClient } from "pg";
import { pendingHistoryDirectoryName } from "./pg-thread-title-generation.js";

export const DEFAULT_HISTORY_DIRECTORY_TIME_ZONE = "Asia/Shanghai";

export function shouldIndexArtifactInHistory(input: {
  readonly historyFilesystemEnabled: boolean;
  readonly purpose: "deliverable" | "diagnostic" | "trace";
}): boolean {
  return input.historyFilesystemEnabled && input.purpose === "deliverable";
}

interface HistoryDirectoryContext {
  readonly title: string;
  readonly title_source: "deterministic" | "model" | "user";
  readonly thread_created_at: Date;
  readonly title_generation_state: string | null;
}

export async function ensureHistoryDirectory(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly observedAt: Date | string;
    readonly timeZone: string;
  },
): Promise<boolean> {
  const context = await client.query<HistoryDirectoryContext>(
    `SELECT thread.title,thread.title_source,thread.created_at AS thread_created_at,
            title_outbox.state AS title_generation_state
       FROM threads thread
       JOIN tenants tenant ON tenant.id=thread.tenant_id AND tenant.kind IN ('personal','team')
       LEFT JOIN thread_title_generation_outbox title_outbox
         ON title_outbox.tenant_id=thread.tenant_id AND title_outbox.thread_id=thread.id
      WHERE thread.tenant_id=$1 AND thread.id=$2`,
    [input.tenantId, input.threadId],
  );
  const row = context.rows[0];
  if (row === undefined) return false;

  // 目录名在 Tenant 内唯一；附件接收与 Agent 交付可能并发，统一使用同一命名锁。
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
    `${input.tenantId}\u001fpersonal-history-names`,
  ]);
  const existing = await client.query(
    `SELECT 1 FROM thread_history_directories WHERE tenant_id=$1 AND thread_id=$2`,
    [input.tenantId, input.threadId],
  );
  if (existing.rowCount === 1) return true;

  const titlePending =
    row.title_generation_state === "pending" || row.title_generation_state === "claimed";
  const baseName = historyFilesystemDirectoryName({ title: row.title });
  const directoryName = titlePending
    ? pendingHistoryDirectoryName(input.threadId)
    : await allocateHistoryName(client, {
        tenantId: input.tenantId,
        baseName,
        table: "directory",
      });
  await client.query(
    `INSERT INTO thread_history_directories(
       tenant_id,thread_id,directory_name,directory_timestamp,directory_time_zone,naming_state,
       first_file_at,last_file_at,file_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,0)`,
    [
      input.tenantId,
      input.threadId,
      directoryName,
      row.thread_created_at,
      input.timeZone,
      titlePending
        ? "pending"
        : row.title_source === "model" || row.title_source === "user"
          ? "ready"
          : "fallback",
      input.observedAt,
    ],
  );
  return true;
}

export async function insertHistoryAgentDeliverable(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly artifactId: string;
    readonly resourceId: string;
    readonly resourceVersionId: string;
    readonly resourceName: string;
    readonly publishedAt: Date | string;
    readonly timeZone: string;
  },
): Promise<void> {
  const enabled = await ensureHistoryDirectory(client, {
    tenantId: input.tenantId,
    threadId: input.threadId,
    observedAt: input.publishedAt,
    timeZone: input.timeZone,
  });
  if (!enabled) return;

  const existing = await client.query(
    `SELECT 1 FROM thread_history_file_entries
      WHERE tenant_id=$1 AND thread_id=$2 AND resource_id=$3
        AND resource_version_id=$4 AND relation_type='agent_deliverable'`,
    [input.tenantId, input.threadId, input.resourceId, input.resourceVersionId],
  );
  if (existing.rowCount === 1) return;

  const entryName = await allocateHistoryName(client, {
    tenantId: input.tenantId,
    threadId: input.threadId,
    baseName: historyFilesystemEntryName({ name: input.resourceName }),
    table: "entry",
  });
  await client.query(
    `INSERT INTO thread_history_file_entries(
       tenant_id,thread_id,resource_id,resource_version_id,relation_type,directory_entry_name,
       first_receipt_id,source_artifact_id,first_attached_at,last_attached_at,attachment_count
     ) VALUES ($1,$2,$3,$4,'agent_deliverable',$5,NULL,$6,$7,$7,1)`,
    [
      input.tenantId,
      input.threadId,
      input.resourceId,
      input.resourceVersionId,
      entryName,
      input.artifactId,
      input.publishedAt,
    ],
  );
  await refreshHistoryDirectorySummary(client, input.tenantId, input.threadId);
}

export async function allocateHistoryName(
  client: PoolClient,
  input:
    | { readonly table: "directory"; readonly tenantId: string; readonly baseName: string }
    | {
        readonly table: "entry";
        readonly tenantId: string;
        readonly threadId: string;
        readonly baseName: string;
      },
): Promise<string> {
  for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
    const candidate =
      input.table === "directory"
        ? historyFilesystemCollisionName(input.baseName, ordinal)
        : historyFilesystemEntryCollisionName(input.baseName, ordinal);
    const found =
      input.table === "directory"
        ? await client.query(
            `SELECT 1 FROM thread_history_directories
              WHERE tenant_id=$1 AND directory_name=$2`,
            [input.tenantId, candidate],
          )
        : await client.query(
            `SELECT 1 FROM thread_history_file_entries
              WHERE tenant_id=$1 AND thread_id=$2 AND directory_entry_name=$3`,
            [input.tenantId, input.threadId, candidate],
          );
    if (found.rowCount === 0) return candidate;
  }
  throw new TypeError("历史文件语义名称冲突过多");
}

export async function refreshHistoryDirectorySummary(
  client: PoolClient,
  tenantId: string,
  threadId: string,
): Promise<void> {
  await client.query(
    `UPDATE thread_history_directories directory
        SET first_file_at=summary.first_file_at,last_file_at=summary.last_file_at,
            file_count=summary.file_count,version=directory.version+1,updated_at=clock_timestamp()
       FROM (
         SELECT tenant_id,thread_id,min(first_attached_at) AS first_file_at,
                max(last_attached_at) AS last_file_at,count(*)::bigint AS file_count
           FROM thread_history_file_entries
          WHERE tenant_id=$1 AND thread_id=$2 GROUP BY tenant_id,thread_id
       ) summary
      WHERE directory.tenant_id=summary.tenant_id AND directory.thread_id=summary.thread_id`,
    [tenantId, threadId],
  );
}
