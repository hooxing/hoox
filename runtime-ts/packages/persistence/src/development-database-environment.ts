import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export type DatabaseDevelopmentEnvironment = Readonly<Record<string, string | undefined>>;

/** 数据库开发命令必须让仓库根 .env 覆盖长驻终端中的旧连接，避免在多机环境操作错误数据库。 */
export async function loadDatabaseDevelopmentEnvironment(
  inherited: DatabaseDevelopmentEnvironment,
  environmentFile: string | URL,
): Promise<DatabaseDevelopmentEnvironment> {
  try {
    return Object.freeze({ ...inherited, ...parseEnv(await readFile(environmentFile, "utf8")) });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return Object.freeze({ ...inherited });
    }
    throw new Error("DATABASE_DEVELOPMENT_ENV_FILE_UNREADABLE", { cause: error });
  }
}
