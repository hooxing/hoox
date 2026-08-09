import { loadMigrations } from "../../runtime-ts/packages/persistence/src/migrations.js";

export interface PostgreSqlMigrationContract {
  readonly versions: readonly number[];
  readonly latestVersion: number;
  readonly count: number;
}

let contractPromise: Promise<PostgreSqlMigrationContract> | undefined;

/**
 * 集中从受测迁移文件推导“最新版本”契约，避免新增迁移时各集成套件继续维护散落常量。
 * 明确验证某个历史回退目标的测试仍应直接写出该历史版本及其期望序列。
 */
export function loadPostgreSqlMigrationContract(): Promise<PostgreSqlMigrationContract> {
  contractPromise ??= loadMigrations().then((migrations) => {
    const versions = migrations.map((migration) => migration.version);
    const latestVersion = versions.at(-1);
    if (latestVersion === undefined) throw new Error("PostgreSQL 迁移契约不能为空");
    const strictlyIncreasing = versions.every(
      (version, index) => index === 0 || version > (versions[index - 1] ?? 0),
    );
    const missingVersions = Array.from({ length: latestVersion }, (_, index) => index + 1).filter(
      (version) => !versions.includes(version),
    );
    // 0038 是已经发布并永久保留的版本号；新迁移只能继续向后追加，不能复用历史空号。
    const onlyReservedVersionIsMissing = missingVersions.length === 1 && missingVersions[0] === 38;
    if (versions[0] !== 1 || !strictlyIncreasing || !onlyReservedVersionIsMissing) {
      throw new Error("PostgreSQL 迁移版本必须严格递增，且仅允许保留版本 38");
    }
    return {
      versions,
      latestVersion,
      count: versions.length,
    };
  });
  return contractPromise;
}
