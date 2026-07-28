import type { PromotionCapabilityVerifier, ResourceCatalog } from "@cube-runtime/resource";
import { PersistenceError } from "./errors.js";
import type { MigrationDownOptions, MigrationRecord } from "./migrations.js";
import { migrateDown, migrateUp } from "./migrations.js";
import { type PgBlobLifecycleOptions, PgBlobLifecycleRepository } from "./pg-blob-lifecycle.js";
import { PgArchiveThreadCommand, PgCoreRepositories } from "./pg-core-repositories.js";
import {
  PgResourceCatalog,
  PgResourcePromotionRepository,
  type ResourcePromotionCommitPort,
} from "./pg-resource-library.js";
import { PgRunDispatchCreation, PgRunDispatchOutbox } from "./pg-run-dispatch.js";
import { PgExecutionPersistence, PgRunExecutionSetup } from "./pg-run-worker-state.js";
import { PgThreadCreation } from "./pg-thread-creation.js";
import type { ArchiveThreadCommandPort, CoreRepositories, RunExperienceReadPort } from "./ports.js";
import {
  createPostgresPool,
  type Pool,
  type PostgresPoolOptions,
  probePostgres,
  withTenantTransaction,
} from "./postgres.js";

export interface PersistenceRuntime {
  readonly repositories: CoreRepositories;
  readonly blobLifecycle: PgBlobLifecycleRepository;
  readonly archiveThread: ArchiveThreadCommandPort;
  readonly execution: PgExecutionPersistence;
  readonly runSetup: PgRunExecutionSetup;
  readonly runDispatchCreation: PgRunDispatchCreation;
  readonly runDispatchOutbox: PgRunDispatchOutbox;
  readonly resourceCatalog: ResourceCatalog;
  readonly resourcePromotions: ResourcePromotionCommitPort;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export interface MigrationRuntime {
  up(): Promise<readonly MigrationRecord[]>;
  down(
    options: Omit<MigrationDownOptions, "directory" | "runtimeRole" | "migratorRole" | "schema">,
  ): Promise<readonly MigrationRecord[]>;
  probe(): Promise<void>;
  close(): Promise<void>;
}

/** API 常驻进程所需的最小 PostgreSQL 能力集合，不把连接池泄漏到应用装配层。 */
export interface ApiPersistenceRuntime {
  readonly repositories: CoreRepositories;
  readonly archiveThread: ArchiveThreadCommandPort;
  readonly threadCreation: PgThreadCreation;
  readonly runDispatchCreation: PgRunDispatchCreation;
  readonly experience: RunExperienceReadPort;
  readonly blobLifecycle: PgBlobLifecycleRepository;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export function createApiPersistenceRuntime(options: PostgresPoolOptions): ApiPersistenceRuntime {
  const pool = createPostgresPool(options);
  return Object.freeze({
    repositories: new PgCoreRepositories(pool),
    archiveThread: new PgArchiveThreadCommand(pool),
    threadCreation: new PgThreadCreation(pool),
    runDispatchCreation: new PgRunDispatchCreation(pool),
    experience: new PgRunExperienceReadRepository(pool),
    blobLifecycle: new PgBlobLifecycleRepository(pool),
    probe: () => probePostgres(pool),
    close: () => pool.end(),
  });
}

class PgRunExperienceReadRepository implements RunExperienceReadPort {
  constructor(private readonly pool: Pool) {}

  async listEvents(
    input: Parameters<RunExperienceReadPort["listEvents"]>[0],
  ): ReturnType<RunExperienceReadPort["listEvents"]> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const run = await client.query<{ id: string }>(
            `SELECT run.id FROM runs run JOIN memberships membership
             ON membership.tenant_id=run.tenant_id AND membership.user_id=$2 AND membership.status='active'
           WHERE run.tenant_id=$1 AND run.id=$3`,
            [input.scope.tenantId, input.scope.userId, input.runId],
          );
          if (run.rowCount !== 1) return { outcome: "not_found" } as const;
          const attempt = await client.query<{ attempt_id: string }>(
            `SELECT attempt_id FROM execution_attempts
            WHERE tenant_id=$1 AND run_id=$2
            ORDER BY updated_at DESC, created_at DESC, attempt_id DESC LIMIT 1`,
            [input.scope.tenantId, input.runId],
          );
          const attemptId = attempt.rows[0]?.attempt_id;
          if (attemptId === undefined) return { outcome: "found", events: [] } as const;
          const events = await client.query<{
            sequence: string;
            kind: string;
            payload: Record<string, unknown>;
            occurred_at: Date | string;
          }>(
            `SELECT sequence,kind,payload,occurred_at FROM run_events
            WHERE tenant_id=$1 AND attempt_id=$2 AND sequence>$3
            ORDER BY sequence ASC LIMIT $4`,
            [input.scope.tenantId, attemptId, input.after, input.limit],
          );
          return {
            outcome: "found",
            attemptId,
            events: events.rows.map((event) => ({
              sequence: Number(event.sequence),
              kind: event.kind,
              payload: event.payload,
              occurredAt:
                event.occurred_at instanceof Date
                  ? event.occurred_at.toISOString()
                  : new Date(event.occurred_at).toISOString(),
            })),
          } as const;
        },
        { readOnly: true },
      );
    } catch {
      throw new PersistenceError("UNAVAILABLE", "读取 Run 体验事件暂时不可用");
    }
  }

  async listArtifacts(
    input: Parameters<RunExperienceReadPort["listArtifacts"]>[0],
  ): ReturnType<RunExperienceReadPort["listArtifacts"]> {
    const result = await this.findArtifacts(input);
    return result === undefined
      ? { outcome: "not_found" }
      : { outcome: "found", artifacts: result };
  }

  async getArtifact(
    input: Parameters<RunExperienceReadPort["getArtifact"]>[0],
  ): ReturnType<RunExperienceReadPort["getArtifact"]> {
    const artifacts = await this.findArtifacts(input);
    const artifact = artifacts?.find((candidate) => candidate.id === input.artifactId);
    return artifact === undefined ? { outcome: "not_found" } : { outcome: "found", artifact };
  }

  private async findArtifacts(input: {
    readonly scope: import("./ports.js").TenantScope;
    readonly runId: string;
  }): Promise<readonly import("./ports.js").RunExperienceArtifact[] | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        input.scope,
        async (client) => {
          const rows = await client.query<{
            id: string | null;
            run_id: string;
            thread_id: string;
            resource_version_id: string;
            name: string;
            media_type: string;
            size: string;
            created_at: Date | string;
            updated_at: Date | string;
            blob_incarnation_id: string;
            physical_object_key: string;
            digest: string;
          }>(
            `WITH authorized_run AS (
             SELECT run.id FROM runs run JOIN memberships membership
               ON membership.tenant_id=run.tenant_id AND membership.user_id=$2 AND membership.status='active'
              WHERE run.tenant_id=$1 AND run.id=$3
           )
           SELECT publication.id,publication.run_id,publication.thread_id,publication.resource_version_id,publication.name,publication.media_type,
                  publication.size,publication.created_at,publication.updated_at,publication.blob_incarnation_id,
                  publication.physical_object_key,publication.digest
             FROM authorized_run run LEFT JOIN artifact_publications publication
               ON publication.tenant_id=$1 AND publication.run_id=run.id AND publication.purpose='deliverable'
             LEFT JOIN artifact_publication_settlements settlement
               ON settlement.tenant_id=publication.tenant_id AND settlement.artifact_id=publication.id
                  AND settlement.target='published'
            WHERE publication.id IS NULL OR settlement.artifact_id IS NOT NULL
            ORDER BY publication.created_at,publication.id`,
            [input.scope.tenantId, input.scope.userId, input.runId],
          );
          if (rows.rowCount === 0) return undefined;
          return rows.rows
            .filter((row): row is typeof row & { id: string } => row.id !== null)
            .map((row) => ({
              id: row.id,
              runId: row.run_id as import("@cube-runtime/domain").RunId,
              threadId: row.thread_id as import("@cube-runtime/domain").ThreadId,
              resourceVersionId: row.resource_version_id,
              name: row.name,
              mediaType: row.media_type,
              sizeBytes: Number(row.size),
              createdAt:
                row.created_at instanceof Date
                  ? row.created_at.toISOString()
                  : new Date(row.created_at).toISOString(),
              updatedAt:
                row.updated_at instanceof Date
                  ? row.updated_at.toISOString()
                  : new Date(row.updated_at).toISOString(),
              blob: {
                kind: "stable" as const,
                tenantId: input.scope.tenantId,
                purpose: "resource" as const,
                sha256: row.digest,
                size: Number(row.size),
                mediaType: row.media_type,
                incarnationId: row.blob_incarnation_id,
                physicalObjectKey: row.physical_object_key,
              },
            }));
        },
        { readOnly: true },
      );
    } catch {
      throw new PersistenceError("UNAVAILABLE", "读取 Run Artifact 暂时不可用");
    }
  }
}

export function createPersistenceRuntime(
  options: PostgresPoolOptions & {
    readonly blobLifecycle?: PgBlobLifecycleOptions;
    readonly resourcePromotionCapabilities: PromotionCapabilityVerifier;
  },
): PersistenceRuntime {
  const pool = createPostgresPool(options);
  return {
    repositories: new PgCoreRepositories(pool),
    blobLifecycle: new PgBlobLifecycleRepository(pool, options.blobLifecycle),
    archiveThread: new PgArchiveThreadCommand(pool),
    execution: new PgExecutionPersistence(pool),
    runSetup: new PgRunExecutionSetup(pool),
    runDispatchCreation: new PgRunDispatchCreation(pool),
    runDispatchOutbox: new PgRunDispatchOutbox(pool),
    resourceCatalog: new PgResourceCatalog(pool),
    resourcePromotions: new PgResourcePromotionRepository(
      pool,
      options.resourcePromotionCapabilities,
    ),
    probe: () => probePostgres(pool),
    close: () => pool.end(),
  };
}

export function createMigrationRuntime(
  options: PostgresPoolOptions & {
    readonly runtimeRole: string;
    readonly migratorRole: string;
    readonly schema: string;
  },
): MigrationRuntime {
  const pool = createPostgresPool(options);
  const security = {
    runtimeRole: options.runtimeRole,
    migratorRole: options.migratorRole,
    schema: options.schema,
  } as const;
  return {
    up: async () => {
      return migrateUp(pool, security);
    },
    down: (downOptions) => migrateDown(pool, { ...downOptions, ...security }),
    probe: () => probePostgres(pool),
    close: () => pool.end(),
  };
}

export type { MigrationRecord, PostgresPoolOptions };
