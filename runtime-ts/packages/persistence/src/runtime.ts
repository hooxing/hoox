import type { MigrationDownOptions, MigrationRecord } from "./migrations.js";
import { migrateDown, migrateUp } from "./migrations.js";
import { PgArchiveThreadCommand, PgCoreRepositories } from "./pg-core-repositories.js";
import { PgBlobLifecycleRepository, type PgBlobLifecycleOptions } from "./pg-blob-lifecycle.js";
import { PgExecutionPersistence, PgRunExecutionSetup } from "./pg-run-worker-state.js";
import type { ArchiveThreadCommandPort, CoreRepositories } from "./ports.js";
import { createPostgresPool, probePostgres, type PostgresPoolOptions } from "./postgres.js";

export interface PersistenceRuntime {
  readonly repositories: CoreRepositories;
  readonly blobLifecycle: PgBlobLifecycleRepository;
  readonly archiveThread: ArchiveThreadCommandPort;
  readonly execution: PgExecutionPersistence;
  readonly runSetup: PgRunExecutionSetup;
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
