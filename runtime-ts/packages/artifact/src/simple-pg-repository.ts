import { artifactId, resourceVersionId, sha256Digest } from "@cube-runtime/domain";
import { TransactionCommitUnknownError, withTenantTransaction } from "@cube-runtime/persistence";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { ArtifactExecutionAuthorization } from "./authorization.js";
import type {
  SimpleDeliveredFileRepositoryPort,
  SimpleDeliveredFileSnapshot,
} from "./simple-delivery.js";

interface DeliveredRow extends QueryResultRow {
  command_digest: string;
  artifact_id: string;
  resource_version_id: string;
  name: string;
  digest: string;
  media_type: string;
  size: string;
  target: "published" | "failed" | null;
}

/** COMMIT 已发送，但规范读回本身不可用；调用方不得把 stable Blob 当作确定孤儿。 */
export class SimpleDeliveryCommitResultUnknownError extends Error {
  constructor() {
    super("DELIVER_FILE_COMMIT_RESULT_UNKNOWN");
    this.name = "SimpleDeliveryCommitResultUnknownError";
  }
}

/** deliver_file 的 PG 写侧；Resource、Version、Artifact 和 published settlement 同事务提交。 */
export class PgSimpleDeliveredFileRepository implements SimpleDeliveredFileRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async commit(
    input: Parameters<SimpleDeliveredFileRepositoryPort["commit"]>[0],
  ): Promise<SimpleDeliveredFileSnapshot> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.authorization.scope.tenantId },
        async (client) => {
          if ((await lockExecutionBoundary(client, input.authorization)) !== "valid") {
            throw new Error("DELIVER_FILE_BOUNDARY_MISMATCH");
          }
          const previous = await readDelivered(client, input.authorization, input.idempotencyKey);
          if (previous !== undefined) return mapPrevious(previous, input.commandDigest);

          const stable = await client.query<{
            lifecycle_id: string;
            incarnation_id: string;
            physical_object_key: string;
          }>(
            `SELECT lifecycle_id::text,incarnation_id::text,physical_object_key
               FROM blob_references
              WHERE tenant_id=$1 AND reference_id=$2 AND state='stable'
                AND purpose='resource' AND sha256=$3 AND size=$4 AND media_type=$5
                AND incarnation_id=$6::uuid AND physical_object_key=$7
              FOR SHARE`,
            [
              input.authorization.scope.tenantId,
              input.persisted.referenceId,
              input.persisted.blob.sha256,
              input.persisted.blob.size,
              input.mediaType,
              input.persisted.blob.incarnationId,
              input.persisted.blob.physicalObjectKey,
            ],
          );
          const binding = stable.rows[0];
          if (binding === undefined) throw new Error("DELIVER_FILE_BLOB_NOT_STABLE");

          await client.query(
            `INSERT INTO artifact_deliverable_declarations(
               tenant_id,run_id,deliverable_key,name,requirement
             ) VALUES($1,$2,$3,$4,'optional')`,
            [
              input.authorization.scope.tenantId,
              input.authorization.scope.runId,
              input.ids.deliverableKey,
              input.name,
            ],
          );
          await client.query(
            `INSERT INTO resources(
               tenant_id,id,name,normalized_name,origin,visibility,latest_version_number
             ) VALUES($1,$2,$3,$4,'artifact','pending_explicit_commit',0)`,
            [
              input.authorization.scope.tenantId,
              input.ids.resourceId,
              input.name,
              normalizeResourceName(input.name),
            ],
          );
          await client.query(
            `INSERT INTO resource_versions(
               tenant_id,resource_id,id,version_number,parent_version_id,blob_reference_id,
               blob_purpose,blob_lifecycle_id,blob_incarnation_id,physical_object_key,
               digest,media_type,size,source_workspace_id,source_workspace_revision_id,
               source_relative_path
             ) VALUES($1,$2,$3,1,NULL,$4,'resource',$5::uuid,$6::uuid,$7,$8,$9,$10,NULL,NULL,NULL)`,
            [
              input.authorization.scope.tenantId,
              input.ids.resourceId,
              input.ids.resourceVersionId,
              input.persisted.referenceId,
              binding.lifecycle_id,
              binding.incarnation_id,
              binding.physical_object_key,
              input.persisted.blob.sha256,
              input.mediaType,
              input.persisted.blob.size,
            ],
          );
          await client.query(
            `UPDATE resources
                SET latest_version_number=1,latest_version_id=$3,visibility='searchable',
                    updated_at=clock_timestamp()
              WHERE tenant_id=$1 AND id=$2`,
            [input.authorization.scope.tenantId, input.ids.resourceId, input.ids.resourceVersionId],
          );
          await client.query(
            `INSERT INTO artifact_publications(
               tenant_id,id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
               resource_id,resource_version_id,replaces_artifact_id,name,purpose,
               deliverable_key,status,blob_reference_id,blob_purpose,blob_lifecycle_id,
               blob_incarnation_id,physical_object_key,digest,media_type,size,
               source_workspace_id,workspace_revision_id,source_relative_path
             ) VALUES(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,'deliverable',$11,'publishing',
               $12,'resource',$13::uuid,$14::uuid,$15,$16,$17,$18,NULL,NULL,NULL
             )`,
            [
              input.authorization.scope.tenantId,
              input.ids.artifactId,
              input.authorization.scope.threadId,
              input.authorization.scope.runId,
              input.authorization.attemptId,
              input.authorization.scope.workspaceId,
              input.authorization.scope.rootRunId,
              input.ids.resourceId,
              input.ids.resourceVersionId,
              input.name,
              input.ids.deliverableKey,
              input.persisted.referenceId,
              binding.lifecycle_id,
              binding.incarnation_id,
              binding.physical_object_key,
              input.persisted.blob.sha256,
              input.mediaType,
              input.persisted.blob.size,
            ],
          );
          await client.query(
            `INSERT INTO artifact_publication_commands(
               tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
               idempotency_key,command_digest,artifact_id
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              input.authorization.scope.tenantId,
              input.authorization.attemptId,
              input.authorization.scope.runId,
              input.authorization.scope.threadId,
              input.authorization.scope.workspaceId,
              input.authorization.scope.rootRunId,
              input.idempotencyKey,
              input.commandDigest,
              input.ids.artifactId,
            ],
          );
          await client.query(
            `INSERT INTO artifact_publication_settlements(tenant_id,artifact_id,target)
             VALUES($1,$2,'published')`,
            [input.authorization.scope.tenantId, input.ids.artifactId],
          );
          const committed = await readDelivered(client, input.authorization, input.idempotencyKey);
          if (committed === undefined) throw new Error("DELIVER_FILE_READBACK_MISSING");
          return mapPrevious(committed, input.commandDigest);
        },
      );
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError) {
        const replay = await this.readback(input);
        if (replay.outcome === "found") return replay.value;
        if (replay.outcome === "unavailable") {
          throw new SimpleDeliveryCommitResultUnknownError();
        }
      } else if (isUniqueViolation(error)) {
        const replay = await this.readback(input);
        if (replay.outcome === "found") return replay.value;
      }
      throw new Error("DELIVER_FILE_COMMIT_FAILED");
    }
  }

  private async readback(
    input: Parameters<SimpleDeliveredFileRepositoryPort["commit"]>[0],
  ): Promise<
    | { readonly outcome: "found"; readonly value: SimpleDeliveredFileSnapshot }
    | { readonly outcome: "missing" | "unavailable" }
  > {
    let row: DeliveredRow | undefined;
    try {
      row = await withTenantTransaction(
        this.pool,
        { tenantId: input.authorization.scope.tenantId },
        (client) => readDelivered(client, input.authorization, input.idempotencyKey),
        { readOnly: true },
      );
    } catch {
      return { outcome: "unavailable" };
    }
    return row === undefined
      ? { outcome: "missing" }
      : { outcome: "found", value: mapPrevious(row, input.commandDigest) };
  }
}

async function readDelivered(
  client: PoolClient,
  authorization: ArtifactExecutionAuthorization,
  idempotencyKey: string,
): Promise<DeliveredRow | undefined> {
  const result = await client.query<DeliveredRow>(
    `SELECT command.command_digest,publication.id AS artifact_id,
            publication.resource_version_id,publication.name,publication.digest,
            publication.media_type,publication.size::text,settlement.target
       FROM artifact_publication_commands command
       JOIN artifact_publications publication
         ON publication.tenant_id=command.tenant_id AND publication.id=command.artifact_id
       JOIN artifact_publication_settlements settlement
         ON settlement.tenant_id=publication.tenant_id AND settlement.artifact_id=publication.id
      WHERE command.tenant_id=$1 AND command.attempt_id=$2 AND command.idempotency_key=$3`,
    [authorization.scope.tenantId, authorization.attemptId, idempotencyKey],
  );
  return result.rows[0];
}

function mapPrevious(row: DeliveredRow, expectedDigest: string): SimpleDeliveredFileSnapshot {
  const size = Number(row.size);
  if (
    row.command_digest !== expectedDigest ||
    row.target !== "published" ||
    !Number.isSafeInteger(size) ||
    size < 0
  ) {
    throw new Error("DELIVER_FILE_IDEMPOTENCY_CONFLICT");
  }
  return Object.freeze({
    artifactId: artifactId(row.artifact_id),
    resourceVersionId: resourceVersionId(row.resource_version_id),
    name: row.name,
    size,
    sha256: sha256Digest(row.digest),
    mediaType: row.media_type,
  });
}

async function lockExecutionBoundary(
  client: PoolClient,
  authorization: ArtifactExecutionAuthorization,
): Promise<"valid" | "scope_mismatch"> {
  const result = await client.query<{ valid: boolean }>(
    `SELECT run.status='running'
            AND permit.consumed_at IS NOT NULL
            AND permit.effect='tool_execution' AND permit.call_id=$16
            AND permit.tool_name='deliver_file' AND permit.args_digest=$17
            AND claim.claim_token=$8 AND claim.claim_epoch=$9 AND claim.released_at IS NULL
            AND claim.expires_at>clock_timestamp()
            AND lease.root_run_id=$6 AND lease.epoch=$10 AND lease.expires_at>clock_timestamp()
            AND attempt.version>=$11 AND attempt.status IN ('running','finalizing') AS valid
       FROM execution_attempts attempt
       JOIN runs run ON run.tenant_id=attempt.tenant_id AND run.id=attempt.run_id
       JOIN external_effect_permits permit ON permit.tenant_id=attempt.tenant_id
                                            AND permit.attempt_id=attempt.attempt_id
                                            AND permit.permit_id=$7
       JOIN run_claims claim ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
       JOIN workspace_write_leases lease ON lease.tenant_id=attempt.tenant_id
                                         AND lease.workspace_id=attempt.workspace_id
      WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$2 AND attempt.run_id=$3
        AND attempt.thread_id=$4 AND attempt.workspace_id=$5 AND attempt.root_run_id=$6
        AND attempt.base_revision_id IS NOT DISTINCT FROM $12
        AND claim.workspace_lease_epoch=$10
        AND permit.run_claim_token=$8 AND permit.run_claim_epoch=$9
        AND permit.workspace_root_run_id=$6 AND permit.workspace_lease_epoch=$10
        AND permit.issued_at=$13 AND permit.expires_at=$14 AND permit.consumed_at=$15
      FOR UPDATE OF run,attempt,claim,lease,permit`,
    [
      authorization.scope.tenantId,
      authorization.attemptId,
      authorization.scope.runId,
      authorization.scope.threadId,
      authorization.scope.workspaceId,
      authorization.scope.rootRunId,
      authorization.permitId,
      authorization.runClaimToken,
      authorization.runClaimEpoch,
      authorization.workspaceLeaseEpoch,
      authorization.attemptVersion,
      authorization.scope.baseRevisionId ?? null,
      authorization.issuedAt,
      authorization.expiresAt,
      authorization.consumedAt,
      authorization.callId,
      authorization.argsDigest,
    ],
  );
  return result.rows[0]?.valid === true ? "valid" : "scope_mismatch";
}

function normalizeResourceName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}
