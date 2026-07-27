import {
  artifactId,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  type WorkspaceRevisionId,
} from "@cube-runtime/domain";
import {
  type StableBlobRef,
  TransactionCommitUnknownError,
  withTenantTransaction,
} from "@cube-runtime/persistence";
import type { ExecutionScope } from "@cube-runtime/run-contracts";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  ArtifactExecutionAuthorization,
  ArtifactExecutionAuthorizationVerifierPort,
} from "./authorization.js";
import type {
  ArtifactBlobBinding,
  ArtifactDeliveryRepositoryPort,
  ArtifactPublicationSnapshot,
  ArtifactUserAuthorization,
  AuthorizedArtifactDownload,
  BeginArtifactPublicationResult,
  CompletionInspectionResult,
  DeclareDeliverablesResult,
  FinishArtifactPublicationResult,
  ReadArtifactPublicationResult,
} from "./contracts.js";

interface PublicationRow extends QueryResultRow {
  tenant_id: string;
  id: string;
  thread_id: string;
  run_id: string;
  resource_version_id: string;
  replaces_artifact_id: string | null;
  name: string;
  purpose: "deliverable" | "diagnostic" | "trace";
  deliverable_key: string | null;
  status: "publishing" | "published" | "failed";
  blob_incarnation_id: string;
  physical_object_key: string;
  digest: string;
  media_type: string;
  size: string;
}

interface CommandRow extends PublicationRow {
  command_digest: string;
}

const publicationColumns = `
  publication.tenant_id, publication.id, publication.thread_id, publication.run_id,
  publication.resource_version_id, publication.replaces_artifact_id, publication.name,
  publication.purpose, publication.deliverable_key,
  coalesce(settlement.target, publication.status) AS status,
  publication.blob_incarnation_id, publication.physical_object_key,
  publication.digest, publication.media_type, publication.size`;

/**
 * Artifact 包已经依赖 Blob 持久化契约，因此生产 PG 适配器放在 Artifact 包中，避免让
 * persistence 反向依赖 Artifact 形成运行时依赖环。Pool 仍只通过窄 Repository 暴露。
 */
export class PgArtifactDeliveryRepository implements ArtifactDeliveryRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly verifier: ArtifactExecutionAuthorizationVerifierPort,
  ) {
    if (typeof verifier?.assert !== "function") throw new TypeError("缺少 Artifact 授权验证器");
  }

  async declareDeliverables(
    input: Parameters<ArtifactDeliveryRepositoryPort["declareDeliverables"]>[0],
  ): Promise<DeclareDeliverablesResult> {
    if (!this.verify(input.authorization, "declare_deliverables"))
      return { outcome: "scope_mismatch" };
    try {
      return await withTenantTransaction(
        this.pool,
        authContext(input.authorization),
        async (client) => {
          const boundary = await lockExecutionBoundary(client, input.authorization);
          if (boundary === "not_running") return { outcome: "not_running" } as const;
          if (boundary !== "valid") return { outcome: "scope_mismatch" } as const;
          const existing = await client.query<{ command_digest: string }>(
            `SELECT command_digest FROM artifact_deliverable_commands
            WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3`,
            [
              input.authorization.scope.tenantId,
              input.authorization.attemptId,
              input.idempotencyKey,
            ],
          );
          const digest = existing.rows[0]?.command_digest;
          if (digest !== undefined) {
            return digest === input.commandDigest
              ? { outcome: "already_applied", commandDigest: sha256Digest(digest) }
              : { outcome: "conflict" };
          }
          const runDeclaration = await client.query<{ command_digest: string }>(
            `SELECT command_digest FROM artifact_deliverable_commands
            WHERE tenant_id=$1 AND run_id=$2`,
            [input.authorization.scope.tenantId, input.authorization.scope.runId],
          );
          if (runDeclaration.rowCount !== 0) return { outcome: "conflict" } as const;
          await client.query(
            `INSERT INTO artifact_deliverable_commands(
             tenant_id,attempt_id,run_id,thread_id,workspace_id,root_run_id,
             idempotency_key,command_digest
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              input.authorization.scope.tenantId,
              input.authorization.attemptId,
              input.authorization.scope.runId,
              input.authorization.scope.threadId,
              input.authorization.scope.workspaceId,
              input.authorization.scope.rootRunId,
              input.idempotencyKey,
              input.commandDigest,
            ],
          );
          for (const declaration of input.declarations) {
            await client.query(
              `INSERT INTO artifact_deliverable_declarations(
               tenant_id,run_id,deliverable_key,name,requirement
             ) VALUES($1,$2,$3,$4,$5)`,
              [
                input.authorization.scope.tenantId,
                input.authorization.scope.runId,
                declaration.key,
                declaration.name,
                declaration.requirement,
              ],
            );
          }
          return { outcome: "applied", commandDigest: input.commandDigest } as const;
        },
      );
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError) return { outcome: "response_unknown" };
      if (isUniqueViolation(error)) {
        const readback = await this.readDeliverableDeclarationCommand(input);
        if (
          (readback.outcome === "applied" || readback.outcome === "already_applied") &&
          readback.commandDigest === input.commandDigest
        ) {
          return { outcome: "already_applied", commandDigest: input.commandDigest };
        }
        return { outcome: "conflict" };
      }
      return { outcome: "unavailable" };
    }
  }

  async readDeliverableDeclarationCommand(
    input: Parameters<ArtifactDeliveryRepositoryPort["readDeliverableDeclarationCommand"]>[0],
  ): Promise<DeclareDeliverablesResult | { readonly outcome: "not_found" }> {
    if (!this.verify(input.authorization, "declare_deliverables"))
      return { outcome: "scope_mismatch" };
    try {
      return await withTenantTransaction(
        this.pool,
        authContext(input.authorization),
        async (client) => {
          if ((await readExecutionBoundary(client, input.authorization)) !== "valid") {
            return { outcome: "scope_mismatch" } as const;
          }
          const result = await client.query<{ command_digest: string }>(
            `SELECT command_digest FROM artifact_deliverable_commands
              WHERE tenant_id=$1 AND attempt_id=$2 AND idempotency_key=$3`,
            [
              input.authorization.scope.tenantId,
              input.authorization.attemptId,
              input.idempotencyKey,
            ],
          );
          const digest = result.rows[0]?.command_digest;
          return digest === undefined
            ? ({ outcome: "not_found" } as const)
            : ({ outcome: "already_applied", commandDigest: sha256Digest(digest) } as const);
        },
        { readOnly: true },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async beginPublication(
    input: Parameters<ArtifactDeliveryRepositoryPort["beginPublication"]>[0],
  ): Promise<BeginArtifactPublicationResult> {
    if (!this.verify(input.authorization, "publish_artifact")) return { outcome: "scope_mismatch" };
    try {
      return await withTenantTransaction(
        this.pool,
        authContext(input.authorization),
        async (client) => {
          const boundary = await lockExecutionBoundary(client, input.authorization);
          if (boundary === "not_running") return { outcome: "not_running" } as const;
          if (boundary !== "valid") return { outcome: "scope_mismatch" } as const;
          const previous = await readPublicationCommand(
            client,
            input.authorization,
            input.idempotencyKey,
          );
          if (previous !== undefined) {
            if (
              previous.command_digest !== input.commandDigest ||
              previous.id !== input.artifactId
            ) {
              return { outcome: "conflict" } as const;
            }
            return {
              outcome: previous.status === "publishing" ? "already_started" : "already_finished",
              publication: mapPublication(previous),
              binding: mapBinding(previous),
            } as const;
          }
          const artifactExists = await client.query<{ present: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM artifact_publications WHERE tenant_id=$1 AND id=$2) AS present`,
            [input.authorization.scope.tenantId, input.artifactId],
          );
          if (artifactExists.rows[0]?.present === true) return { outcome: "conflict" } as const;
          const source = await client.query<
            QueryResultRow & {
              resource_id: string;
              blob_reference_id: string;
              blob_lifecycle_id: string;
              blob_incarnation_id: string;
              physical_object_key: string;
              digest: string;
              media_type: string;
              size: string;
            }
          >(
            `SELECT version.resource_id, version.blob_reference_id,
                  version.blob_lifecycle_id::text, version.blob_incarnation_id::text,
                  version.physical_object_key, version.digest, version.media_type,
                  version.size::text
             FROM resource_versions version
             JOIN resources resource ON resource.tenant_id=version.tenant_id
                                    AND resource.id=version.resource_id
             JOIN blob_references reference ON reference.tenant_id=version.tenant_id
                                            AND reference.reference_id=version.blob_reference_id
             JOIN blob_lifecycles lifecycle ON lifecycle.tenant_id=version.tenant_id
                                           AND lifecycle.lifecycle_id=version.blob_lifecycle_id
             JOIN blob_incarnations incarnation ON incarnation.tenant_id=version.tenant_id
                                               AND incarnation.lifecycle_id=version.blob_lifecycle_id
                                               AND incarnation.incarnation_id=version.blob_incarnation_id
            WHERE version.tenant_id=$1 AND version.id=$2
              AND resource.visibility='searchable' AND reference.state='stable'
              AND lifecycle.state='active'
              AND lifecycle.current_incarnation_id=version.blob_incarnation_id
              AND incarnation.state='active'`,
            [input.authorization.scope.tenantId, input.resourceVersionId],
          );
          const binding = source.rows[0];
          if (binding === undefined) return { outcome: "resource_mismatch" } as const;
          if (input.replacesArtifactId !== undefined) {
            const replaced = await client.query<{ valid: boolean }>(
              `SELECT EXISTS(
               SELECT 1 FROM artifact_publications publication
               JOIN artifact_publication_settlements settlement
                 ON settlement.tenant_id=publication.tenant_id
                AND settlement.artifact_id=publication.id AND settlement.target='failed'
                WHERE publication.tenant_id=$1 AND publication.id=$2 AND publication.run_id=$3
                  AND publication.purpose=$4 AND publication.deliverable_key IS NOT DISTINCT FROM $5
             ) AS valid`,
              [
                input.authorization.scope.tenantId,
                input.replacesArtifactId,
                input.authorization.scope.runId,
                input.purpose,
                input.deliverableKey ?? null,
              ],
            );
            if (replaced.rows[0]?.valid !== true)
              return { outcome: "invalid_replacement" } as const;
          }
          const inserted = await client.query<PublicationRow>(
            `INSERT INTO artifact_publications(
             tenant_id,id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
             resource_id,resource_version_id,
             replaces_artifact_id,name,purpose,deliverable_key,status,blob_reference_id,
             blob_purpose,blob_lifecycle_id,blob_incarnation_id,physical_object_key,
             digest,media_type,size
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'publishing',$14,'resource',$15,$16,$17,$18,$19,$20)
           RETURNING tenant_id,id,thread_id,run_id,resource_version_id,replaces_artifact_id,
                     name,purpose,deliverable_key,status,blob_incarnation_id,
                     physical_object_key,digest,media_type,size`,
            [
              input.authorization.scope.tenantId,
              input.artifactId,
              input.authorization.scope.threadId,
              input.authorization.scope.runId,
              input.authorization.attemptId,
              input.authorization.scope.workspaceId,
              input.authorization.scope.rootRunId,
              binding.resource_id,
              input.resourceVersionId,
              input.replacesArtifactId ?? null,
              input.name,
              input.purpose,
              input.deliverableKey ?? null,
              binding.blob_reference_id,
              binding.blob_lifecycle_id,
              binding.blob_incarnation_id,
              binding.physical_object_key,
              binding.digest,
              binding.media_type,
              binding.size,
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
              input.artifactId,
            ],
          );
          const row = inserted.rows[0];
          if (row === undefined) return { outcome: "unavailable" } as const;
          return {
            outcome: "started",
            publication: mapPublication(row),
            binding: mapBinding(row),
          } as const;
        },
      );
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError) {
        const readback = await this.readPublicationCommand(input);
        if (readback.outcome === "found" && readback.commandDigest === input.commandDigest) {
          return {
            outcome:
              readback.publication.status === "publishing" ? "already_started" : "already_finished",
            publication: readback.publication,
            binding: readback.binding,
          };
        }
      }
      if (isUniqueViolation(error)) {
        const readback = await this.readPublicationCommand(input);
        if (readback.outcome === "found" && readback.commandDigest === input.commandDigest) {
          return {
            outcome:
              readback.publication.status === "publishing" ? "already_started" : "already_finished",
            publication: readback.publication,
            binding: readback.binding,
          };
        }
        return { outcome: "conflict" };
      }
      return { outcome: "unavailable" };
    }
  }

  async finishPublication(
    input: Parameters<ArtifactDeliveryRepositoryPort["finishPublication"]>[0],
  ): Promise<FinishArtifactPublicationResult> {
    if (!this.verify(input.authorization, "publish_artifact")) return { outcome: "scope_mismatch" };
    try {
      return await withTenantTransaction(
        this.pool,
        authContext(input.authorization),
        async (client) => {
          if ((await lockExecutionBoundary(client, input.authorization)) !== "valid") {
            return { outcome: "scope_mismatch" } as const;
          }
          const row = await readPublicationCommand(
            client,
            input.authorization,
            input.idempotencyKey,
          );
          if (row === undefined || row.id !== input.artifactId)
            return { outcome: "not_found" } as const;
          if (row.command_digest !== input.commandDigest) return { outcome: "conflict" } as const;
          if (row.status !== "publishing") {
            return row.status === input.target
              ? { outcome: "already_applied", publication: mapPublication(row) }
              : { outcome: "conflict" };
          }
          await client.query(
            `INSERT INTO artifact_publication_settlements(tenant_id,artifact_id,target)
           VALUES($1,$2,$3)`,
            [input.authorization.scope.tenantId, input.artifactId, input.target],
          );
          const updated = await readPublicationCommand(
            client,
            input.authorization,
            input.idempotencyKey,
          );
          return updated === undefined
            ? ({ outcome: "conflict" } as const)
            : ({ outcome: "applied", publication: mapPublication(updated) } as const);
        },
      );
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError) return { outcome: "response_unknown" };
      if (isUniqueViolation(error)) {
        const readback = await this.readPublicationCommand(input);
        if (readback.outcome === "found" && readback.commandDigest === input.commandDigest) {
          return readback.publication.status === input.target
            ? { outcome: "already_applied", publication: readback.publication }
            : { outcome: "conflict" };
        }
        return { outcome: "conflict" };
      }
      return { outcome: "unavailable" };
    }
  }

  async readPublicationCommand(
    input: Parameters<ArtifactDeliveryRepositoryPort["readPublicationCommand"]>[0],
  ): Promise<ReadArtifactPublicationResult> {
    if (!this.verify(input.authorization, "publish_artifact")) return { outcome: "scope_mismatch" };
    try {
      return await withTenantTransaction(
        this.pool,
        authContext(input.authorization),
        async (client) => {
          if ((await readExecutionBoundary(client, input.authorization)) !== "valid") {
            return { outcome: "scope_mismatch" } as const;
          }
          const row = await readPublicationCommand(
            client,
            input.authorization,
            input.idempotencyKey,
          );
          return row === undefined
            ? ({ outcome: "not_found" } as const)
            : ({
                outcome: "found",
                commandDigest: sha256Digest(row.command_digest),
                publication: mapPublication(row),
                binding: mapBinding(row),
              } as const);
        },
        { readOnly: true },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async inspectCompletion(input: {
    readonly scope: ExecutionScope;
    readonly workspaceRevisionId?: WorkspaceRevisionId;
  }): Promise<CompletionInspectionResult> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.scope.tenantId },
        async (client) => {
          const owned = await client.query<{ valid: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM runs run
              JOIN run_execution_inputs execution
                ON execution.tenant_id=run.tenant_id AND execution.run_id=run.id
              JOIN workspaces workspace ON workspace.tenant_id=run.tenant_id
                                       AND workspace.thread_id=run.thread_id
             WHERE run.tenant_id=$1 AND run.id=$2 AND run.thread_id=$3
               AND workspace.id=$4 AND execution.root_run_id=$5) AS valid`,
            [
              input.scope.tenantId,
              input.scope.runId,
              input.scope.threadId,
              input.scope.workspaceId,
              input.scope.rootRunId,
            ],
          );
          if (owned.rows[0]?.valid !== true) return { outcome: "scope_mismatch" } as const;
          const blockers = await client.query<{
            deliverable_key: string;
            status: "missing" | "publishing" | "failed";
          }>(
            `SELECT declaration.deliverable_key,
                    CASE
                      WHEN count(publication.id)=0 THEN 'missing'
                      WHEN bool_or(settlement.target IS NULL) THEN 'publishing'
                      ELSE 'failed'
                    END AS status
               FROM artifact_deliverable_declarations declaration
               LEFT JOIN artifact_publications publication
                 ON publication.tenant_id=declaration.tenant_id
                AND publication.run_id=declaration.run_id
                AND publication.deliverable_key=declaration.deliverable_key
                AND publication.purpose='deliverable'
               LEFT JOIN artifact_publication_settlements settlement
                 ON settlement.tenant_id=publication.tenant_id
                AND settlement.artifact_id=publication.id
              WHERE declaration.tenant_id=$1 AND declaration.run_id=$2
                AND declaration.requirement='required'
              GROUP BY declaration.deliverable_key
             HAVING NOT coalesce(bool_or(settlement.target='published'), false)
              ORDER BY declaration.deliverable_key`,
            [input.scope.tenantId, input.scope.runId],
          );
          return blockers.rowCount === 0
            ? ({ outcome: "ready" } as const)
            : ({
                outcome: "not_ready",
                blockers: blockers.rows.map((row) => ({
                  deliverableKey: row.deliverable_key,
                  status: row.status,
                })),
              } as const);
        },
        { readOnly: true },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async listAuthorizedArtifacts(
    input: Parameters<ArtifactDeliveryRepositoryPort["listAuthorizedArtifacts"]>[0],
  ): ReturnType<ArtifactDeliveryRepositoryPort["listAuthorizedArtifacts"]> {
    try {
      return await withTenantTransaction(this.pool, input.request, async (client) => {
        const rows = await client.query<PublicationRow & { id: string | null }>(
          `WITH locked_membership AS (
               UPDATE memberships
                  SET lock_marker=lock_marker
                WHERE tenant_id=$1 AND user_id=$3 AND status='active'
                RETURNING tenant_id,user_id
             ), authorized_run AS (
               SELECT run.tenant_id,run.id
                 FROM runs run
                 JOIN locked_membership membership ON membership.tenant_id=run.tenant_id
                                                  AND membership.user_id=$3
                WHERE run.tenant_id=$1 AND run.id=$2
             )
             SELECT ${publicationColumns}
               FROM authorized_run run
               LEFT JOIN artifact_publications publication
                 ON publication.tenant_id=run.tenant_id AND publication.run_id=run.id
                AND publication.purpose='deliverable'
               LEFT JOIN artifact_publication_settlements settlement
                 ON settlement.tenant_id=publication.tenant_id
                AND settlement.artifact_id=publication.id AND settlement.target='published'
              WHERE publication.id IS NULL OR settlement.artifact_id IS NOT NULL
              ORDER BY publication.created_at, publication.id`,
          [input.request.tenantId, input.runId, input.request.userId],
        );
        if (rows.rowCount === 0) return { outcome: "not_found" } as const;
        return {
          outcome: "authorized",
          artifacts: rows.rows
            .filter((row): row is PublicationRow => row.id !== null)
            .map(mapPublication),
        } as const;
      });
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async authorizeDownload(
    input: Parameters<ArtifactDeliveryRepositoryPort["authorizeDownload"]>[0],
  ): ReturnType<ArtifactDeliveryRepositoryPort["authorizeDownload"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.request,
        async (client) => {
          const result = await client.query<CommandRow & { authorization_revision: string }>(
            `SELECT ${publicationColumns},
                    membership.lock_marker::text || ':' || publication.updated_at::text AS authorization_revision,
                    ''::text AS command_digest
               FROM artifact_publications publication
               JOIN artifact_publication_settlements settlement
                 ON settlement.tenant_id=publication.tenant_id
                AND settlement.artifact_id=publication.id AND settlement.target='published'
               JOIN memberships membership ON membership.tenant_id=publication.tenant_id
                                           AND membership.user_id=$2
                                           AND membership.status='active'
              WHERE publication.tenant_id=$1 AND publication.id=$3
                AND publication.purpose='deliverable'`,
            [input.request.tenantId, input.request.userId, input.artifactId],
          );
          const row = result.rows[0];
          if (row === undefined) return { outcome: "not_found" } as const;
          const authorization: ArtifactUserAuthorization = Object.freeze({
            scope: input.request,
            authorizationRevision: row.authorization_revision,
          });
          return {
            outcome: "authorized",
            download: Object.freeze({
              authorization,
              publication: mapPublication(row),
              binding: mapBinding(row),
            }),
          } as const;
        },
        { readOnly: true },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async confirmDownloadAuthorization(
    input: AuthorizedArtifactDownload,
  ): ReturnType<ArtifactDeliveryRepositoryPort["confirmDownloadAuthorization"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.authorization.scope,
        async (client) => {
          const result = await this.authorizeRow(client, input);
          if (result === undefined) return { outcome: "not_found" } as const;
          return result.authorization_revision === input.authorization.authorizationRevision &&
            sameBinding(mapBinding(result), input.binding)
            ? ({ outcome: "confirmed" } as const)
            : ({ outcome: "changed" } as const);
        },
        { readOnly: true },
      );
    } catch {
      return { outcome: "unavailable" };
    }
  }

  private verify(authorization: ArtifactExecutionAuthorization, toolName: string): boolean {
    try {
      this.verifier.assert(authorization, { toolName, argsDigest: authorization.argsDigest });
      return true;
    } catch {
      return false;
    }
  }

  private async authorizeRow(
    client: PoolClient,
    input: AuthorizedArtifactDownload,
  ): Promise<(PublicationRow & { authorization_revision: string }) | undefined> {
    const result = await client.query<PublicationRow & { authorization_revision: string }>(
      `SELECT ${publicationColumns},
              membership.lock_marker::text || ':' || publication.updated_at::text AS authorization_revision
         FROM artifact_publications publication
         JOIN artifact_publication_settlements settlement
           ON settlement.tenant_id=publication.tenant_id
          AND settlement.artifact_id=publication.id AND settlement.target='published'
         JOIN memberships membership ON membership.tenant_id=publication.tenant_id
                                     AND membership.user_id=$2
                                     AND membership.status='active'
        WHERE publication.tenant_id=$1 AND publication.id=$3
          AND publication.purpose='deliverable'`,
      [
        input.authorization.scope.tenantId,
        input.authorization.scope.userId,
        input.publication.artifactId,
      ],
    );
    return result.rows[0];
  }
}

function authContext(authorization: ArtifactExecutionAuthorization): { tenantId: string } {
  return { tenantId: authorization.scope.tenantId };
}

async function lockExecutionBoundary(
  client: PoolClient,
  authorization: ArtifactExecutionAuthorization,
): Promise<"valid" | "not_running" | "scope_mismatch"> {
  return readExecutionBoundary(client, authorization, true);
}

async function readExecutionBoundary(
  client: PoolClient,
  authorization: ArtifactExecutionAuthorization,
  lock = false,
): Promise<"valid" | "not_running" | "scope_mismatch"> {
  const result = await client.query<{ run_status: string; valid: boolean }>(
    `SELECT run.status AS run_status,
            permit.consumed_at IS NOT NULL
            AND permit.expires_at>clock_timestamp()
            AND permit.consumed_at<=permit.expires_at
            AND permit.effect='tool_execution'
            AND permit.call_id=$16 AND permit.tool_name=$17 AND permit.args_digest=$18
            AND permit.attempt_version=$11
            AND claim.claim_token=$8 AND claim.claim_epoch=$9
            AND claim.released_at IS NULL AND claim.expires_at>clock_timestamp()
            AND fence.lease_epoch=$10
            AND lease.root_run_id=$6 AND lease.epoch=$10
            AND lease.expires_at>clock_timestamp()
            AND attempt.version=$11
            AND attempt.status IN ('running','finalizing') AS valid
       FROM execution_attempts attempt
       JOIN runs run ON run.tenant_id=attempt.tenant_id
                    AND run.id=attempt.run_id AND run.thread_id=attempt.thread_id
       JOIN external_effect_permits permit ON permit.tenant_id=attempt.tenant_id
                                           AND permit.attempt_id=attempt.attempt_id
                                           AND permit.permit_id=$7
       JOIN run_claims claim ON claim.tenant_id=attempt.tenant_id
                            AND claim.attempt_id=attempt.attempt_id
       JOIN execution_workspace_fences fence ON fence.tenant_id=attempt.tenant_id
                                             AND fence.attempt_id=attempt.attempt_id
       JOIN workspace_write_leases lease ON lease.tenant_id=attempt.tenant_id
                                         AND lease.workspace_id=attempt.workspace_id
      WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$2
        AND attempt.run_id=$3 AND attempt.thread_id=$4 AND attempt.workspace_id=$5
        AND attempt.root_run_id=$6
        AND attempt.base_revision_id IS NOT DISTINCT FROM $12
        AND claim.workspace_lease_epoch=$10
        AND permit.run_claim_token=$8 AND permit.run_claim_epoch=$9
        AND permit.workspace_root_run_id=$6 AND permit.workspace_lease_epoch=$10
        AND permit.issued_at=$13 AND permit.expires_at=$14 AND permit.consumed_at=$15
      ${lock ? "FOR UPDATE OF run, attempt, claim, lease, permit" : ""}`,
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
      authorization.toolName,
      authorization.argsDigest,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return "scope_mismatch";
  if (row.run_status !== "running") return "not_running";
  return row.valid ? "valid" : "scope_mismatch";
}

async function readPublicationCommand(
  client: PoolClient,
  authorization: ArtifactExecutionAuthorization,
  idempotencyKey: string,
): Promise<CommandRow | undefined> {
  const result = await client.query<CommandRow>(
    `SELECT command.command_digest, ${publicationColumns}
       FROM artifact_publication_commands command
       JOIN artifact_publications publication ON publication.tenant_id=command.tenant_id
                                             AND publication.id=command.artifact_id
       LEFT JOIN artifact_publication_settlements settlement
         ON settlement.tenant_id=publication.tenant_id
        AND settlement.artifact_id=publication.id
      WHERE command.tenant_id=$1 AND command.attempt_id=$2 AND command.idempotency_key=$3`,
    [authorization.scope.tenantId, authorization.attemptId, idempotencyKey],
  );
  return result.rows[0];
}

function mapPublication(row: PublicationRow): ArtifactPublicationSnapshot {
  return Object.freeze({
    artifactId: artifactId(row.id),
    tenantId: tenantId(row.tenant_id),
    threadId: threadId(row.thread_id),
    runId: runId(row.run_id),
    resourceVersionId: resourceVersionId(row.resource_version_id),
    ...(row.replaces_artifact_id === null
      ? {}
      : { replacesArtifactId: artifactId(row.replaces_artifact_id) }),
    name: row.name,
    purpose: row.purpose,
    ...(row.deliverable_key === null ? {} : { deliverableKey: row.deliverable_key }),
    status: row.status,
  });
}

function mapBinding(row: PublicationRow): ArtifactBlobBinding {
  const size = Number(row.size);
  if (!Number.isSafeInteger(size)) throw new TypeError("Artifact Blob 大小超出安全整数");
  const blob: StableBlobRef = Object.freeze({
    kind: "stable",
    tenantId: row.tenant_id,
    purpose: "resource",
    incarnationId: row.blob_incarnation_id,
    physicalObjectKey: row.physical_object_key,
    sha256: row.digest,
    size,
    mediaType: row.media_type,
  });
  return Object.freeze({
    resourceVersionId: resourceVersionId(row.resource_version_id),
    mediaType: row.media_type,
    blob,
  });
}

function sameBinding(left: ArtifactBlobBinding, right: ArtifactBlobBinding): boolean {
  return (
    left.resourceVersionId === right.resourceVersionId &&
    left.mediaType === right.mediaType &&
    left.blob.tenantId === right.blob.tenantId &&
    left.blob.incarnationId === right.blob.incarnationId &&
    left.blob.physicalObjectKey === right.blob.physicalObjectKey &&
    left.blob.sha256 === right.blob.sha256 &&
    left.blob.size === right.blob.size
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}
