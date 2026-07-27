import type { PromotionCapabilityVerifier, ResourceCatalog } from "@cube-runtime/resource";
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
import { PgThreadCreation } from "./pg-thread-creation.js";
import { PgExecutionPersistence, PgRunExecutionSetup } from "./pg-run-worker-state.js";
import type { ArchiveThreadCommandPort, CoreRepositories } from "./ports.js";
import { createPostgresPool, type PostgresPoolOptions, probePostgres } from "./postgres.js";

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
    probe: () => probePostgres(pool),
    close: () => pool.end(),
  });
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
