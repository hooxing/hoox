import { createHash } from "node:crypto";
import {
  parseWorkspaceManifest,
  type WorkspaceCandidateHandoffPort,
  type WorkspaceCandidateIdentity,
  WorkspaceDependencyError,
  type WorkspaceExecutionPolicy,
  type WorkspaceManifest,
} from "@hoox/workspace";
import type { Pool, PoolClient } from "pg";
import { TransactionCommitUnknownError, withTenantTransaction } from "./postgres.js";

const DIGEST_VERSION = "workspace-candidate-handoff-v1";
const IDENTIFIER = /^[^\0]{1,200}$/u;
const OPERATION = /^[^\0]{1,256}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function workspaceCandidateOperationDigest(
  identity: Omit<WorkspaceCandidateIdentity, "operationDigest">,
): string {
  return createHash("sha256")
    .update(
      [
        DIGEST_VERSION,
        identity.tenantId,
        identity.workspaceId,
        identity.attemptId,
        identity.runId,
        identity.threadId,
        identity.rootRunId,
        identity.parentRevisionId ?? "",
        identity.revisionId,
        identity.operationKey,
      ].join("\0"),
    )
    .digest("hex");
}

/** Candidate 只在这里从 building 推进到 prepared；RuntimeMutation 独占 committed。 */
export class PgWorkspaceCandidateHandoff implements WorkspaceCandidateHandoffPort {
  constructor(
    private readonly pool: Pool,
    private readonly policy: WorkspaceExecutionPolicy,
  ) {}

  async begin(identity: WorkspaceCandidateIdentity): Promise<void> {
    assertIdentity(identity);
    await withTenantTransaction(
      this.pool,
      { tenantId: identity.tenantId },
      async (client) => {
        const active = await client.query<{
          readonly current_revision_id: string | null;
          readonly expires_at: Date;
        }>(
          `SELECT attempt.current_revision_id,
                  LEAST(claim.expires_at, lease.expires_at) AS expires_at
             FROM execution_attempts attempt
             JOIN run_claims claim
               ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
             JOIN workspace_write_leases lease
               ON lease.tenant_id=attempt.tenant_id AND lease.workspace_id=attempt.workspace_id
              AND lease.root_run_id=attempt.root_run_id
            WHERE attempt.tenant_id=$1 AND attempt.workspace_id=$2 AND attempt.attempt_id=$3
              AND attempt.run_id=$4 AND attempt.thread_id=$5 AND attempt.root_run_id=$6
              AND attempt.status IN ('claimed','running','finalizing')
              AND claim.released_at IS NULL AND claim.expires_at > clock_timestamp()
              AND lease.expires_at > clock_timestamp()
            FOR UPDATE OF attempt,claim,lease`,
          [
            identity.tenantId,
            identity.workspaceId,
            identity.attemptId,
            identity.runId,
            identity.threadId,
            identity.rootRunId,
          ],
        );
        const row = active.rows[0];
        if (
          row === undefined ||
          (row.current_revision_id ?? undefined) !== identity.parentRevisionId
        ) {
          throw new Error("Workspace candidate 执行身份或 parent 已失效");
        }
        await client.query(
          `INSERT INTO workspace_revision_candidates(
             tenant_id,workspace_id,attempt_id,run_id,thread_id,root_run_id,parent_revision_id,
             revision_id,operation_key,operation_digest,status,expires_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'building',$11)
           ON CONFLICT (tenant_id,workspace_id,attempt_id,operation_key) DO NOTHING`,
          [
            identity.tenantId,
            identity.workspaceId,
            identity.attemptId,
            identity.runId,
            identity.threadId,
            identity.rootRunId,
            identity.parentRevisionId ?? null,
            identity.revisionId,
            identity.operationKey,
            identity.operationDigest,
            row.expires_at,
          ],
        );
        await requireCandidate(client, identity, ["building", "prepared", "committed"]);
        // 修正轮次只保留最新 candidate；旧 uploaded 引用在同一事务退出 stable 可达集合。
        await releaseCandidates(client, identity, "superseded", true);
      },
      { isolationLevel: "SERIALIZABLE" },
    ).catch((error: unknown) =>
      rethrowWorkspaceCommitUnknown(error, "WORKSPACE_CANDIDATE_BEGIN_COMMIT_UNKNOWN"),
    );
  }

  async prepare(input: {
    readonly identity: WorkspaceCandidateIdentity;
    readonly manifest: WorkspaceManifest;
  }): Promise<void> {
    const identity = input.identity;
    assertIdentity(identity);
    const manifest = parseWorkspaceManifest(input.manifest, identity.tenantId, {
      maxFiles: this.policy.maxFiles,
      maxTotalBytes: this.policy.maxTotalBytes,
      maxSingleFileBytes: this.policy.maxSingleFileBytes,
      maxPathUtf8Bytes: this.policy.maxPathUtf8Bytes,
    });
    await withTenantTransaction(
      this.pool,
      { tenantId: identity.tenantId },
      async (client) => {
        const candidate = await requireCandidate(client, identity, ["building", "prepared"]);
        if (candidate.status === "prepared") {
          if (candidate.manifest_digest !== manifest.digest) {
            throw new Error("Workspace candidate manifest 冲突");
          }
          return;
        }
        for (const entry of manifest.entries) {
          const uploaded = await client.query<{ readonly one: number }>(
            `SELECT 1 AS one
               FROM workspace_revision_candidate_files file
               JOIN blob_references reference
                 ON reference.tenant_id=file.tenant_id
                AND reference.reference_id=file.blob_reference_id
               JOIN blob_lifecycles lifecycle
                 ON lifecycle.tenant_id=file.tenant_id
                AND lifecycle.lifecycle_id=file.blob_lifecycle_id
               JOIN blob_incarnations incarnation
                 ON incarnation.tenant_id=file.tenant_id
                AND incarnation.lifecycle_id=file.blob_lifecycle_id
                AND incarnation.incarnation_id=file.blob_incarnation_id
                AND incarnation.physical_object_key=file.physical_object_key
              WHERE file.tenant_id=$1 AND file.workspace_id=$2 AND file.attempt_id=$3
                AND file.operation_key=$4 AND file.operation_digest=$5
                AND file.relative_path=$6 AND file.source='uploaded'
                AND file.content_sha256=$7 AND file.size=$8
                AND file.blob_incarnation_id=$9::uuid AND file.physical_object_key=$10
                AND reference.state='stable' AND reference.purpose='workspace'
                AND lifecycle.state='active' AND incarnation.state='active'`,
            [
              identity.tenantId,
              identity.workspaceId,
              identity.attemptId,
              identity.operationKey,
              identity.operationDigest,
              entry.path,
              entry.content.sha256,
              entry.content.size,
              entry.object.incarnationId,
              entry.object.physicalObjectKey,
            ],
          );
          if (uploaded.rows[0]?.one === 1) continue;
          const reused = await client.query(
            `INSERT INTO workspace_revision_candidate_files(
               tenant_id,workspace_id,attempt_id,run_id,thread_id,root_run_id,parent_revision_id,
               revision_id,operation_key,operation_digest,manifest_digest,relative_path,source,
               content_sha256,size,blob_lifecycle_id,blob_incarnation_id,physical_object_key
             )
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,base.relative_path,'base',
                    base.content_sha256,base.size,base.blob_lifecycle_id,
                    base.blob_incarnation_id,base.physical_object_key
               FROM workspace_revision_files base
              WHERE base.tenant_id=$1 AND base.workspace_id=$2 AND base.revision_id=$7
                AND base.relative_path=$11 AND base.content_sha256=$12 AND base.size=$13
                AND base.blob_incarnation_id=$14::uuid AND base.physical_object_key=$15
             ON CONFLICT (tenant_id,workspace_id,attempt_id,operation_key,relative_path) DO NOTHING`,
            [
              identity.tenantId,
              identity.workspaceId,
              identity.attemptId,
              identity.runId,
              identity.threadId,
              identity.rootRunId,
              identity.parentRevisionId ?? null,
              identity.revisionId,
              identity.operationKey,
              identity.operationDigest,
              entry.path,
              entry.content.sha256,
              entry.content.size,
              entry.object.incarnationId,
              entry.object.physicalObjectKey,
            ],
          );
          if (reused.rowCount !== 1) {
            throw new Error(
              "Workspace candidate 文件未绑定 uploaded 引用或同 path base incarnation",
            );
          }
        }
        const count = await client.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM workspace_revision_candidate_files
            WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4`,
          [identity.tenantId, identity.workspaceId, identity.attemptId, identity.operationKey],
        );
        if (count.rows[0]?.count !== String(manifest.entries.length)) {
          throw new Error("Workspace candidate 文件集合与 manifest 不一致");
        }
        await client.query(
          `UPDATE workspace_revision_candidate_files SET manifest_digest=$5
            WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4`,
          [
            identity.tenantId,
            identity.workspaceId,
            identity.attemptId,
            identity.operationKey,
            manifest.digest,
          ],
        );
        const prepared = await client.query(
          `UPDATE workspace_revision_candidates
              SET status='prepared',manifest_digest=$5,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND operation_key=$4
              AND status='building'`,
          [
            identity.tenantId,
            identity.workspaceId,
            identity.attemptId,
            identity.operationKey,
            manifest.digest,
          ],
        );
        if (prepared.rowCount !== 1) throw new Error("Workspace candidate 无法进入 prepared");
      },
      { isolationLevel: "SERIALIZABLE" },
    ).catch((error: unknown) =>
      rethrowWorkspaceCommitUnknown(error, "WORKSPACE_CANDIDATE_PREPARE_COMMIT_UNKNOWN"),
    );
  }

  async release(input: {
    readonly identity: WorkspaceCandidateIdentity;
    readonly reason: "publish_failed" | "manual_recovery" | "superseded";
  }): Promise<void> {
    assertIdentity(input.identity);
    await withTenantTransaction(
      this.pool,
      { tenantId: input.identity.tenantId },
      (client) => releaseCandidates(client, input.identity, input.reason, false),
      { isolationLevel: "SERIALIZABLE" },
    ).catch((error: unknown) =>
      rethrowWorkspaceCommitUnknown(error, "WORKSPACE_CANDIDATE_RELEASE_COMMIT_UNKNOWN"),
    );
  }
}

interface CandidateRow {
  readonly status: "building" | "prepared" | "committed" | "released";
  readonly manifest_digest: string | null;
}

async function requireCandidate(
  client: PoolClient,
  identity: WorkspaceCandidateIdentity,
  allowed: readonly CandidateRow["status"][],
): Promise<CandidateRow> {
  const row = await client.query<CandidateRow>(
    `SELECT status,manifest_digest FROM workspace_revision_candidates
      WHERE tenant_id=$1 AND workspace_id=$2 AND attempt_id=$3 AND run_id=$4 AND thread_id=$5
        AND root_run_id=$6 AND parent_revision_key=COALESCE($7,'') AND revision_id=$8
        AND operation_key=$9 AND operation_digest=$10
      FOR UPDATE`,
    [
      identity.tenantId,
      identity.workspaceId,
      identity.attemptId,
      identity.runId,
      identity.threadId,
      identity.rootRunId,
      identity.parentRevisionId ?? null,
      identity.revisionId,
      identity.operationKey,
      identity.operationDigest,
    ],
  );
  const candidate = row.rows[0];
  if (candidate === undefined || !allowed.includes(candidate.status)) {
    throw new Error("Workspace candidate identity 或状态冲突");
  }
  return candidate;
}

async function releaseCandidates(
  client: PoolClient,
  identity: WorkspaceCandidateIdentity,
  reason: "publish_failed" | "manual_recovery" | "superseded",
  excludeCurrent: boolean,
): Promise<void> {
  const parameters = [identity.tenantId, identity.workspaceId, identity.attemptId];
  const exclude = excludeCurrent
    ? "AND candidate.operation_key <> $4"
    : "AND candidate.operation_key = $4";
  if (excludeCurrent) parameters.push(identity.operationKey);
  else parameters.push(identity.operationKey);
  await client.query(
    `UPDATE blob_references reference SET state='released',updated_at=clock_timestamp()
       FROM workspace_revision_candidate_files file
       JOIN workspace_revision_candidates candidate
         ON candidate.tenant_id=file.tenant_id AND candidate.workspace_id=file.workspace_id
        AND candidate.attempt_id=file.attempt_id AND candidate.operation_key=file.operation_key
      WHERE candidate.tenant_id=$1 AND candidate.workspace_id=$2 AND candidate.attempt_id=$3
        ${exclude} AND candidate.status IN ('building','prepared')
        AND file.source='uploaded' AND reference.tenant_id=file.tenant_id
        AND reference.reference_id=file.blob_reference_id AND reference.state='stable'`,
    parameters,
  );
  await client.query(
    `UPDATE workspace_revision_candidates candidate
        SET status='released',release_reason=$5,updated_at=clock_timestamp()
      WHERE candidate.tenant_id=$1 AND candidate.workspace_id=$2 AND candidate.attempt_id=$3
        ${exclude} AND candidate.status IN ('building','prepared')`,
    [...parameters, reason],
  );
}

export function assertWorkspaceCandidateIdentity(identity: WorkspaceCandidateIdentity): void {
  assertIdentity(identity);
}

function assertIdentity(identity: WorkspaceCandidateIdentity): void {
  const values = [
    identity.tenantId,
    identity.workspaceId,
    identity.attemptId,
    identity.runId,
    identity.threadId,
    identity.rootRunId,
    identity.revisionId,
  ];
  if (
    !values.every((value) => IDENTIFIER.test(value)) ||
    (identity.parentRevisionId !== undefined && !IDENTIFIER.test(identity.parentRevisionId)) ||
    !OPERATION.test(identity.operationKey) ||
    !SHA256.test(identity.operationDigest)
  ) {
    throw new TypeError("Workspace candidate identity 格式无效");
  }
  const { operationDigest: _supplied, ...unsigned } = identity;
  if (workspaceCandidateOperationDigest(unsigned) !== identity.operationDigest) {
    throw new TypeError("Workspace candidate operation digest 不匹配");
  }
}

function rethrowWorkspaceCommitUnknown(error: unknown, dependencyCode: string): never {
  if (error instanceof TransactionCommitUnknownError) {
    throw new WorkspaceDependencyError("unknown", dependencyCode);
  }
  throw error;
}
