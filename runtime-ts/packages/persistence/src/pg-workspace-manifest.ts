import { createHash } from "node:crypto";
import {
  createWorkspaceManifest,
  WorkspaceDependencyError,
  type WorkspaceExecutionPolicy,
  type WorkspaceManifest,
  type WorkspaceOperationIdentity,
  type WorkspaceOperationJournalPort,
  type WorkspaceOperationResult,
  type WorkspaceStableAuthorizationReceipt,
  type WorkspaceStableBlobReadPort,
  type WorkspaceTrustedScope,
  type WorkspaceUnknownFact,
} from "@hoox/workspace";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { BlobStore, StableBlobRef } from "./blob-store.js";
import { BlobStoreError } from "./blob-store.js";
import { TransactionCommitUnknownError, withTenantTransaction } from "./postgres.js";

interface ManifestRow extends QueryResultRow {
  readonly schema_version: number;
  readonly manifest_digest: string;
  readonly entry_count: number;
  readonly total_bytes: string;
}

interface FileRow extends QueryResultRow {
  readonly relative_path: string;
  readonly content_sha256: string;
  readonly size: string;
  readonly blob_incarnation_id: string;
  readonly physical_object_key: string;
}

interface JournalRow extends QueryResultRow {
  readonly input_digest: string;
  readonly status: "running" | "completed" | "retryable" | "terminal" | "unknown";
  readonly result: unknown | null;
  readonly same_identity: boolean;
}

/**
 * manifest 与文件引用均由 RuntimeMutation 在同一事务写入。本 Repository 只负责读取已提交
 * 事实和 operation journal，绝不接受调用方提供的 object key 或裸 Blob 引用。
 */
export class PgWorkspaceManifestRepository implements WorkspaceOperationJournalPort {
  constructor(
    private readonly pool: Pool,
    private readonly policy: WorkspaceExecutionPolicy,
  ) {}

  async loadManifest(input: {
    readonly scope: WorkspaceTrustedScope;
    readonly revisionId: string;
  }): Promise<WorkspaceManifest | undefined> {
    const { scope, revisionId } = input;
    return withTenantTransaction(this.pool, { tenantId: scope.tenantId }, async (client) => {
      const manifest = await client.query<ManifestRow>(
        `SELECT manifest.schema_version,manifest.manifest_digest,manifest.entry_count,manifest.total_bytes
           FROM workspace_revision_manifests manifest
           JOIN workspace_revisions revision
             ON revision.tenant_id=manifest.tenant_id
            AND revision.workspace_id=manifest.workspace_id
            AND revision.id=manifest.revision_id
          WHERE manifest.tenant_id=$1 AND manifest.workspace_id=$2 AND manifest.revision_id=$3
            AND revision.thread_id=$4`,
        [scope.tenantId, scope.workspaceId, revisionId, scope.threadId],
      );
      const head = manifest.rows[0];
      if (head === undefined || head.schema_version !== 1) return undefined;
      const files = await client.query<FileRow>(
        `SELECT relative_path,content_sha256,size::text,blob_incarnation_id::text,physical_object_key
           FROM workspace_revision_files
          WHERE tenant_id=$1 AND workspace_id=$2 AND revision_id=$3
          ORDER BY relative_path ASC`,
        [scope.tenantId, scope.workspaceId, revisionId],
      );
      if (files.rowCount !== head.entry_count) return undefined;
      const entries = files.rows.map((row) => ({
        type: "file" as const,
        path: row.relative_path,
        content: { sha256: row.content_sha256, size: Number(row.size) },
        object: {
          tenantId: scope.tenantId,
          purpose: "workspace" as const,
          incarnationId: row.blob_incarnation_id,
          physicalObjectKey: row.physical_object_key,
        },
      }));
      const parsed = createWorkspaceManifest(
        { tenantId: scope.tenantId, entries },
        this.policy.historicalManifest,
      );
      const total = parsed.entries.reduce((sum, entry) => sum + entry.content.size, 0);
      return parsed.digest === head.manifest_digest && total === Number(head.total_bytes)
        ? parsed
        : undefined;
    });
  }

  /** scope 的 current head 与 Attempt checkpoint 必须一致；不一致一律拒绝而非物化旧版本。 */
  async loadCurrentManifest(input: {
    readonly scope: WorkspaceTrustedScope;
    readonly expectedRevisionId?: string;
  }): Promise<WorkspaceManifest | undefined> {
    const current = await withTenantTransaction(
      this.pool,
      { tenantId: input.scope.tenantId },
      async (client) => {
        const row = await client.query<{ readonly current_revision_id: string | null }>(
          `SELECT current_revision_id FROM workspaces
            WHERE tenant_id=$1 AND id=$2 AND thread_id=$3`,
          [input.scope.tenantId, input.scope.workspaceId, input.scope.threadId],
        );
        return row.rows[0]?.current_revision_id;
      },
    );
    if (current === undefined) throw new Error("Workspace head 不存在");
    if ((current ?? undefined) !== input.expectedRevisionId) {
      throw new Error("Workspace head 与 Attempt checkpoint 不一致");
    }
    if (current === null) return undefined;
    const manifest = await this.loadManifest({ scope: input.scope, revisionId: current });
    if (manifest === undefined) throw new Error("Workspace manifest 不可用");
    return manifest;
  }

  async lookupCompleted(input: Parameters<WorkspaceOperationJournalPort["lookupCompleted"]>[0]) {
    return withTenantTransaction(this.pool, { tenantId: input.scope.tenantId }, async (client) => {
      const row = await client.query<{ readonly result: unknown }>(
        `SELECT result FROM workspace_operation_journal
          WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 AND kind=$4 AND operation_key=$5
            AND status='completed'`,
        [
          input.scope.tenantId,
          input.scope.workspaceId,
          input.scope.threadId,
          input.kind,
          input.operationKey,
        ],
      );
      return row.rows[0] === undefined
        ? Object.freeze({ status: "not_found" })
        : Object.freeze({
            status: "completed",
            identity: await this.identityFor(client, input),
            result: row.rows[0].result,
          });
    });
  }

  async begin(identity: WorkspaceOperationIdentity): Promise<unknown> {
    return withTenantTransaction(this.pool, { tenantId: identity.tenantId }, async (client) => {
      const serialized = JSON.stringify(identity);
      await client.query(
        `INSERT INTO workspace_operation_journal(
           tenant_id,workspace_id,thread_id,kind,operation_key,input_digest,identity,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'running')
         ON CONFLICT (tenant_id,workspace_id,thread_id,kind,operation_key) DO NOTHING`,
        [
          identity.tenantId,
          identity.workspaceId,
          identity.threadId,
          identity.kind,
          identity.operationKey,
          identity.inputDigest,
          serialized,
        ],
      );
      const row = await this.lockJournal(client, identity, serialized);
      if (row === undefined || row.input_digest !== identity.inputDigest || !row.same_identity) {
        return Object.freeze({ status: "conflict" });
      }
      if (row.status === "completed")
        return Object.freeze({ status: "completed", result: row.result });
      if (row.status === "running") return Object.freeze({ status: "started" });
      if (row.status === "unknown") return Object.freeze({ status: "unknown" });
      if (row.status === "terminal") return Object.freeze({ status: "terminal" });
      const resumed = await client.query(
        `UPDATE workspace_operation_journal
            SET status='running',failure_phase=NULL,failure_code=NULL,unknown_fact=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 AND kind=$4 AND operation_key=$5
            AND status='retryable'`,
        [
          identity.tenantId,
          identity.workspaceId,
          identity.threadId,
          identity.kind,
          identity.operationKey,
        ],
      );
      return resumed.rowCount === 1
        ? Object.freeze({ status: "started" })
        : Object.freeze({ status: "in_progress" });
    }).catch((error: unknown) =>
      rethrowWorkspaceCommitUnknown(error, "WORKSPACE_JOURNAL_BEGIN_COMMIT_UNKNOWN"),
    );
  }

  async complete(
    identity: WorkspaceOperationIdentity,
    result: WorkspaceOperationResult,
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: identity.tenantId }, async (client) => {
      const row = await this.lockJournal(client, identity, JSON.stringify(identity));
      if (row === undefined || row.input_digest !== identity.inputDigest || !row.same_identity)
        throw new Error("Workspace journal identity conflict");
      if (row.status === "completed") return;
      const updated = await client.query(
        `UPDATE workspace_operation_journal
            SET status='completed',result=$6::jsonb,failure_phase=NULL,failure_code=NULL,unknown_fact=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 AND kind=$4 AND operation_key=$5
            AND status='running'`,
        [
          identity.tenantId,
          identity.workspaceId,
          identity.threadId,
          identity.kind,
          identity.operationKey,
          JSON.stringify(result),
        ],
      );
      if (updated.rowCount !== 1) throw new Error("Workspace journal cannot complete");
    }).catch((error: unknown) =>
      rethrowWorkspaceCommitUnknown(error, "WORKSPACE_JOURNAL_COMPLETE_COMMIT_UNKNOWN"),
    );
  }

  async failKnown(input: Parameters<WorkspaceOperationJournalPort["failKnown"]>[0]): Promise<void> {
    await withTenantTransaction(
      this.pool,
      { tenantId: input.identity.tenantId },
      async (client) => {
        const updated = await client.query(
          `UPDATE workspace_operation_journal
            SET status=$6,failure_phase=$7,failure_code=$8,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 AND kind=$4 AND operation_key=$5
            AND input_digest=$9 AND identity=$10::jsonb AND status='running'`,
          [
            input.identity.tenantId,
            input.identity.workspaceId,
            input.identity.threadId,
            input.identity.kind,
            input.identity.operationKey,
            input.disposition,
            input.phase,
            input.code,
            input.identity.inputDigest,
            JSON.stringify(input.identity),
          ],
        );
        if (updated.rowCount !== 1)
          throw new Error("Workspace journal cannot record known failure");
      },
    ).catch((error: unknown) =>
      rethrowWorkspaceCommitUnknown(error, "WORKSPACE_JOURNAL_FAIL_COMMIT_UNKNOWN"),
    );
  }

  async recordUnknown(
    identity: WorkspaceOperationIdentity,
    fact: WorkspaceUnknownFact,
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: identity.tenantId }, async (client) => {
      const updated = await client.query(
        `UPDATE workspace_operation_journal
            SET status='unknown',unknown_fact=$6::jsonb,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 AND kind=$4 AND operation_key=$5
            AND input_digest=$7 AND identity=$8::jsonb AND status='running'`,
        [
          identity.tenantId,
          identity.workspaceId,
          identity.threadId,
          identity.kind,
          identity.operationKey,
          JSON.stringify(fact),
          identity.inputDigest,
          JSON.stringify(identity),
        ],
      );
      if (updated.rowCount !== 1) {
        const row = await this.lockJournal(client, identity, JSON.stringify(identity));
        if (row?.status === "completed") return;
        throw new Error("Workspace journal cannot record unknown result");
      }
    }).catch((error: unknown) =>
      rethrowWorkspaceCommitUnknown(error, "WORKSPACE_JOURNAL_UNKNOWN_COMMIT_UNKNOWN"),
    );
  }

  private async lockJournal(
    client: PoolClient,
    identity: WorkspaceOperationIdentity,
    serialized: string,
  ): Promise<JournalRow | undefined> {
    const row = await client.query<JournalRow>(
      `SELECT input_digest,status,result,identity=$6::jsonb AS same_identity
         FROM workspace_operation_journal
        WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 AND kind=$4 AND operation_key=$5
        FOR UPDATE`,
      [
        identity.tenantId,
        identity.workspaceId,
        identity.threadId,
        identity.kind,
        identity.operationKey,
        serialized,
      ],
    );
    return row.rows[0];
  }

  private async identityFor(
    client: PoolClient,
    input: Parameters<WorkspaceOperationJournalPort["lookupCompleted"]>[0],
  ): Promise<unknown> {
    const row = await client.query<{ readonly identity: unknown }>(
      `SELECT identity FROM workspace_operation_journal
        WHERE tenant_id=$1 AND workspace_id=$2 AND thread_id=$3 AND kind=$4 AND operation_key=$5`,
      [
        input.scope.tenantId,
        input.scope.workspaceId,
        input.scope.threadId,
        input.kind,
        input.operationKey,
      ],
    );
    return row.rows[0]?.identity ?? {};
  }
}

function rethrowWorkspaceCommitUnknown(error: unknown, dependencyCode: string): never {
  if (error instanceof TransactionCommitUnknownError) {
    throw new WorkspaceDependencyError("unknown", dependencyCode);
  }
  throw error;
}

/** 读取 stable Blob 前同时核验 Workspace manifest 文件引用与当前 incarnation。 */
export class PgWorkspaceStableBlobAccess implements WorkspaceStableBlobReadPort {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
  ) {}

  async authorize(input: Parameters<WorkspaceStableBlobReadPort["authorize"]>[0]) {
    const authorized = await withTenantTransaction(
      this.pool,
      { tenantId: input.scope.tenantId },
      async (client) => {
        const row = await client.query<{
          readonly revision_id: string;
          readonly relative_path: string;
        }>(
          `SELECT file.revision_id,file.relative_path
             FROM workspace_revision_files file
             JOIN workspace_revisions revision
               ON revision.tenant_id=file.tenant_id
              AND revision.workspace_id=file.workspace_id
              AND revision.id=file.revision_id
             JOIN blob_incarnations incarnation
               ON incarnation.tenant_id=file.tenant_id
              AND incarnation.lifecycle_id=file.blob_lifecycle_id
              AND incarnation.incarnation_id=file.blob_incarnation_id
              AND incarnation.physical_object_key=file.physical_object_key
             JOIN blob_lifecycles lifecycle
               ON lifecycle.tenant_id=incarnation.tenant_id AND lifecycle.lifecycle_id=incarnation.lifecycle_id
            WHERE file.tenant_id=$1 AND file.workspace_id=$2 AND revision.thread_id=$3
              AND file.revision_id=$8 AND file.relative_path=$9
              AND file.content_sha256=$4 AND file.size=$5
              AND file.blob_incarnation_id=$6::uuid AND file.physical_object_key=$7
              AND incarnation.state='active' AND lifecycle.state='active'
            LIMIT 1`,
          [
            input.scope.tenantId,
            input.scope.workspaceId,
            input.scope.threadId,
            input.content.sha256,
            input.content.size,
            input.object.incarnationId,
            input.object.physicalObjectKey,
            input.revisionId,
            input.relativePath,
          ],
        );
        return row.rows[0];
      },
    );
    if (authorized === undefined) return { status: "denied" as const };
    return {
      status: "authorized" as const,
      receipt: Object.freeze({
        authorizationId: `workspace-${createHash("sha256")
          .update(
            `${input.scope.threadId}\0${input.scope.workspaceId}\0${authorized.revision_id}\0${authorized.relative_path}`,
          )
          .digest("hex")}`,
        tenantId: input.scope.tenantId,
        threadId: input.scope.threadId,
        workspaceId: input.scope.workspaceId,
        revisionId: authorized.revision_id,
        relativePath: authorized.relative_path,
        purpose: "workspace" as const,
        content: Object.freeze({ ...input.content }),
        object: Object.freeze({ ...input.object }),
      }),
    };
  }

  async head(receipt: WorkspaceStableAuthorizationReceipt) {
    const exists = await this.hasLiveFile(receipt);
    return exists
      ? {
          status: "exists" as const,
          content: receipt.content,
          object: receipt.object,
        }
      : { status: "not_found" as const };
  }

  async *read(receipt: WorkspaceStableAuthorizationReceipt): AsyncIterable<Uint8Array> {
    if (!(await this.hasLiveFile(receipt)))
      throw new BlobStoreError("BLOB_NOT_FOUND", "Workspace Blob 不可读");
    const stable: StableBlobRef = {
      kind: "stable",
      tenantId: receipt.tenantId,
      purpose: "workspace",
      sha256: receipt.content.sha256,
      size: receipt.content.size,
      mediaType: "application/octet-stream",
      incarnationId: receipt.object.incarnationId,
      physicalObjectKey: receipt.object.physicalObjectKey,
    };
    yield* this.blobs.read({ tenantId: receipt.tenantId }, stable);
  }

  private async hasLiveFile(receipt: WorkspaceStableAuthorizationReceipt): Promise<boolean> {
    return withTenantTransaction(this.pool, { tenantId: receipt.tenantId }, async (client) => {
      const row = await client.query<{ readonly one: number }>(
        `SELECT 1 AS one
           FROM workspace_revision_files file
           JOIN workspace_revisions revision
             ON revision.tenant_id=file.tenant_id
            AND revision.workspace_id=file.workspace_id
            AND revision.id=file.revision_id
           JOIN blob_incarnations incarnation
             ON incarnation.tenant_id=file.tenant_id
            AND incarnation.lifecycle_id=file.blob_lifecycle_id
            AND incarnation.incarnation_id=file.blob_incarnation_id
            AND incarnation.physical_object_key=file.physical_object_key
           JOIN blob_lifecycles lifecycle
             ON lifecycle.tenant_id=incarnation.tenant_id AND lifecycle.lifecycle_id=incarnation.lifecycle_id
          WHERE file.tenant_id=$1 AND file.workspace_id=$2 AND revision.thread_id=$3
            AND file.revision_id=$4 AND file.relative_path=$5
            AND file.content_sha256=$6 AND file.size=$7
            AND file.blob_incarnation_id=$8::uuid AND file.physical_object_key=$9
            AND incarnation.state='active' AND lifecycle.state='active'
          LIMIT 1`,
        [
          receipt.tenantId,
          receipt.workspaceId,
          receipt.threadId,
          receipt.revisionId,
          receipt.relativePath,
          receipt.content.sha256,
          receipt.content.size,
          receipt.object.incarnationId,
          receipt.object.physicalObjectKey,
        ],
      );
      return row.rows[0]?.one === 1;
    });
  }
}
