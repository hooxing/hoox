import type { MigrationDownOptions, MigrationRecord } from "./migrations.js";
import { migrateDown, migrateUp } from "./migrations.js";
import { PgCoreRepositories } from "./pg-core-repositories.js";
import type { CoreRepositories } from "./ports.js";
import { createPostgresPool, probePostgres, type PostgresPoolOptions } from "./postgres.js";

export interface PersistenceRuntime {
  readonly repositories: CoreRepositories;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export interface MigrationRuntime {
  up(): Promise<readonly MigrationRecord[]>;
  down(options: Omit<MigrationDownOptions, "directory">): Promise<readonly MigrationRecord[]>;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export function createPersistenceRuntime(options: PostgresPoolOptions): PersistenceRuntime {
  const pool = createPostgresPool(options);
  return {
    repositories: new PgCoreRepositories(pool),
    probe: () => probePostgres(pool),
    close: () => pool.end(),
  };
}

export function createMigrationRuntime(
  options: PostgresPoolOptions & { readonly runtimeRole: string },
): MigrationRuntime {
  const pool = createPostgresPool(options);
  return {
    up: () => migrateUp(pool, { runtimeRole: options.runtimeRole }),
    down: (downOptions) => migrateDown(pool, downOptions),
    probe: () => probePostgres(pool),
    close: () => pool.end(),
  };
}

export type { MigrationRecord, PostgresPoolOptions };
