import type { MigrationDownOptions, MigrationRecord } from "./migrations.js";
import { migrateDown, migrateUp } from "./migrations.js";
import { PgArchiveThreadCommand, PgCoreRepositories } from "./pg-core-repositories.js";
import { PgBlobLifecycleRepository, type PgBlobLifecycleOptions } from "./pg-blob-lifecycle.js";
import { PgExecutionPersistence, PgRunExecutionSetup } from "./pg-run-worker-state.js";
import { PgRunDispatchCreation, PgRunDispatchOutbox } from "./pg-run-dispatch.js";
import {
  PgResourceCatalog,
  PgResourcePromotionRepository,
  type ResourcePromotionCommitPort,
} from "./pg-resource-library.js";
import type { ArchiveThreadCommandPort, CoreRepositories } from "./ports.js";
import { createPostgresPool, probePostgres, type PostgresPoolOptions } from "./postgres.js";
import type { ResourceCatalog } from "@cube-runtime/resource";

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

export function createPersistenceRuntime(
  options: PostgresPoolOptions & { readonly blobLifecycle?: PgBlobLifecycleOptions },
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
    resourcePromotions: new PgResourcePromotionRepository(pool),
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
