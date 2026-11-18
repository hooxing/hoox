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
    // 2026-11 基线压缩后版本从 0001 基线开始连续递增，新迁移只能向后追加。
    const contiguous = versions.every((version, index) => version === index + 1);
    if (versions[0] !== 1 || !strictlyIncreasing || !contiguous) {
      throw new Error("PostgreSQL 迁移版本必须从 1 开始连续递增");
    }
    return {
      versions,
      latestVersion,
      count: versions.length,
    };
  });
  return contractPromise;
}
