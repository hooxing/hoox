import type { MigrationDownOptions, MigrationRecord } from "./migrations.js";
import { migrateDown, migrateUp } from "./migrations.js";
import { PgCoreRepositories } from "./pg-core-repositories.js";
import type { CoreRepositories } from "./ports.js";
import { createPostgresPool, probePostgres, type PostgresPoolOptions } from "./postgres.js";
import { bootstrapRuntimeAccess } from "./role-bootstrap.js";

export interface PersistenceRuntime {
  readonly repositories: CoreRepositories;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export interface MigrationRuntime {
  up(): Promise<readonly MigrationRecord[]>;
  down(
    options: Omit<MigrationDownOptions, "directory" | "runtimeRole">,
  ): Promise<readonly MigrationRecord[]>;
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
    up: async () => {
      const records = await migrateUp(pool, { runtimeRole: options.runtimeRole });
      await bootstrapRuntimeAccess(pool, options.runtimeRole);
      return records;
    },
    down: (downOptions) => migrateDown(pool, { ...downOptions, runtimeRole: options.runtimeRole }),
    probe: () => probePostgres(pool),
    close: () => pool.end(),
  };
}

export type { MigrationRecord, PostgresPoolOptions };
