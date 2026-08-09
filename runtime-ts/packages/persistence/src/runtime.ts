import type { PromotionCapabilityVerifier, ResourceCatalog } from "@cube-runtime/resource";
import type { BlobStore } from "./blob-store.js";
import { PersistenceError } from "./errors.js";
import type { MigrationDownOptions, MigrationRecord } from "./migrations.js";
import { migrateDown, migrateUp } from "./migrations.js";
import {
  type ModelWireTraceReadPort,
  PgModelWireTraceReadRepository,
} from "./model-wire-trace-read.js";
import { type PgBlobLifecycleOptions, PgBlobLifecycleRepository } from "./pg-blob-lifecycle.js";
import { PgArchiveThreadCommand, PgCoreRepositories } from "./pg-core-repositories.js";
import { PgResourceFilesystemCatalog } from "./pg-resource-filesystem.js";
import {
  PgResourceCatalog,
  PgResourcePromotionRepository,
  type ResourcePromotionCommitPort,
} from "./pg-resource-library.js";
import { PgResourceUploadRepository } from "./pg-resource-upload.js";
import { PgRunDispatchCreation, PgRunDispatchOutbox } from "./pg-run-dispatch.js";
import { PgExecutionPersistence, PgRunExecutionSetup } from "./pg-run-worker-state.js";
import { PgSkillCenterRepository } from "./pg-skill-center.js";
import { PgSkillFilesystemCatalog } from "./pg-skill-filesystem.js";
import { PgThreadCreation } from "./pg-thread-creation.js";
import { PgTeamCollaborationRepository, PgThreadForkRepository } from "./pg-team-collaboration.js";
import { PgThreadInputRouting } from "./pg-thread-input.js";
import type {
  ArchiveThreadCommandPort,
  CoreRepositories,
  RunExperienceReadPort,
  ThreadContextReadPort,
  ThreadContinuityReadPort,
} from "./ports.js";
import {
  createPostgresPool,
  type Pool,
  type PostgresPoolOptions,
  probePostgres,
  withTenantTransaction,
} from "./postgres.js";
import { PgThreadContextReadRepository } from "./thread-context.js";
import { PgThreadContinuityReadRepository } from "./thread-continuity-rollout.js";

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
    options: Omit<
      MigrationDownOptions,
      "directory" | "runtimeRole" | "migratorRole" | "skillPublisherRole" | "schema"
    >,
  ): Promise<readonly MigrationRecord[]>;
  probe(): Promise<void>;
  close(): Promise<void>;
}

/** API 常驻进程所需的最小 PostgreSQL 能力集合，不把连接池泄漏到应用装配层。 */
export interface ApiPersistenceRuntime {
  readonly repositories: CoreRepositories;
  readonly archiveThread: ArchiveThreadCommandPort;
  readonly threadCreation: PgThreadCreation;
  readonly teamCollaboration: PgTeamCollaborationRepository;
  readonly threadForks: PgThreadForkRepository;
  readonly runDispatchCreation: PgRunDispatchCreation;
  readonly threadInputs: PgThreadInputRouting;
  readonly experience: RunExperienceReadPort;
  readonly modelWireTraces: ModelWireTraceReadPort;
  readonly blobLifecycle: PgBlobLifecycleRepository;
  readonly resourceCatalog: PgResourceCatalog;
  readonly resourceUploads: PgResourceUploadRepository;
  readonly resourceFilesystem: PgResourceFilesystemCatalog;
  readonly threadContinuity: ThreadContinuityReadPort;
  readonly skillCenter: PgSkillCenterRepository;
  readonly skillFilesystem: PgSkillFilesystemCatalog;
  threadContext(blobs: BlobStore): ThreadContextReadPort;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export function createApiPersistenceRuntime(
  options: PostgresPoolOptions & {
    readonly serialQueueV2Enabled?: boolean;
    readonly blobLifecycle?: PgBlobLifecycleOptions;
    readonly historyDirectoryTimeZone?: string;
    readonly historyFilesystemEnabled?: boolean;
    readonly historyTitleGenerationEnabled?: boolean;
  },
): ApiPersistenceRuntime {
  const pool = createPostgresPool(options);
  return Object.freeze({
    repositories: new PgCoreRepositories(pool),
    archiveThread: new PgArchiveThreadCommand(pool),
    threadCreation: new PgThreadCreation(pool),
    teamCollaboration: new PgTeamCollaborationRepository(pool),
    threadForks: new PgThreadForkRepository(pool),
    runDispatchCreation: new PgRunDispatchCreation(pool, {
      serialQueueV2Enabled: options.serialQueueV2Enabled ?? false,
      historyTitleGenerationEnabled: options.historyTitleGenerationEnabled ?? false,
    }),
    threadInputs: new PgThreadInputRouting(pool, {
      ...(options.historyDirectoryTimeZone === undefined
        ? {}
        : { historyDirectoryTimeZone: options.historyDirectoryTimeZone }),
      ...(options.historyFilesystemEnabled === undefined
        ? {}
        : { historyFilesystemEnabled: options.historyFilesystemEnabled }),
      ...(options.historyTitleGenerationEnabled === undefined
        ? {}
        : { historyTitleGenerationEnabled: options.historyTitleGenerationEnabled }),
    }),
    experience: new PgRunExperienceReadRepository(pool),
    modelWireTraces: new PgModelWireTraceReadRepository(pool),
    blobLifecycle: new PgBlobLifecycleRepository(pool, options.blobLifecycle),
    resourceCatalog: new PgResourceCatalog(pool),
    resourceUploads: new PgResourceUploadRepository(pool),
    resourceFilesystem: new PgResourceFilesystemCatalog(pool),
    threadContinuity: new PgThreadContinuityReadRepository(pool),
    skillCenter: new PgSkillCenterRepository(pool),
    skillFilesystem: new PgSkillFilesystemCatalog(pool),
    threadContext: (blobs: BlobStore) => new PgThreadContextReadRepository(pool, blobs),
    probe: () => probePostgres(pool, options.expectedRuntimeRole),
    close: () => pool.end(),
  });
}

export class PgRunExperienceReadRepository implements RunExperienceReadPort {
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
          if (attemptId === undefined) {
            return { outcome: "found", events: [], hasMore: false } as const;
          }
          const events = await client.query<{
            sequence: string;
            kind: string;
            payload: Record<string, unknown>;
            occurred_at: Date | string;
          }>(
            `SELECT sequence,kind,payload,occurred_at FROM run_events
            WHERE tenant_id=$1 AND attempt_id=$2 AND sequence>$3
            ORDER BY sequence ASC LIMIT $4`,
            [input.scope.tenantId, attemptId, input.after, input.limit + 1],
          );
          const hasMore = events.rows.length > input.limit;
          return {
            outcome: "found",
            attemptId,
            // 只在固定的最新 Attempt 内判定 hasMore，绝不让 next cursor 跨 Attempt。
            hasMore,
            events: events.rows.slice(0, input.limit).map((event) => ({
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
        // 授权 Run、选定 latest Attempt、读取事件与 hasMore 必须共享一个 MVCC 快照；
        // READ COMMITTED 会让并发 Attempt 切换或旧 Attempt 追加落入后续语句的新快照。
        { readOnly: true, isolationLevel: "REPEATABLE READ" },
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
            authorization_revision: string;
            blob_purpose: "resource" | "workspace";
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
                  publication.blob_purpose,publication.physical_object_key,publication.digest,
                  publication.authorization_revision
             FROM authorized_run run
             LEFT JOIN LATERAL (
               SELECT candidate.*,
                      jsonb_build_array(
                        membership.id,membership.user_id,membership.role,membership.status,
                        extract(epoch FROM membership.created_at),
                        extract(epoch FROM candidate.updated_at),
                        settlement.target,extract(epoch FROM settlement.settled_at)
                      )::text AS authorization_revision
                 FROM artifact_publications candidate
                 JOIN artifact_publication_settlements settlement
                   ON settlement.tenant_id=candidate.tenant_id AND settlement.artifact_id=candidate.id
                      AND settlement.target='published'
                 JOIN memberships membership
                   ON membership.tenant_id=candidate.tenant_id AND membership.user_id=$2
                      AND membership.status='active'
                WHERE candidate.tenant_id=$1 AND candidate.run_id=run.id
                  AND candidate.purpose='deliverable'
                ORDER BY candidate.created_at,candidate.id
             ) publication ON true
            ORDER BY publication.created_at,publication.id`,
            [input.scope.tenantId, input.scope.userId, input.runId],
          );
          if (rows.rowCount === 0) return undefined;
          return rows.rows
            .filter((row): row is typeof row & { id: string } => row.id !== null)
            .map((row) => ({
              id: row.id,
              tenantId: input.scope.tenantId,
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
              authorizationRevision: row.authorization_revision,
              blob: {
                kind: "stable" as const,
                tenantId: input.scope.tenantId,
                purpose: row.blob_purpose,
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
    readonly skillPublisherRole: string;
    readonly schema: string;
  },
): MigrationRuntime {
  const pool = createPostgresPool(options);
  const security = {
    runtimeRole: options.runtimeRole,
    migratorRole: options.migratorRole,
    skillPublisherRole: options.skillPublisherRole,
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
