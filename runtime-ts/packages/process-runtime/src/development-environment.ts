import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export type DevelopmentEnvironmentSource = Readonly<Record<string, string | undefined>>;

/** 本地 .env 是开发进程的显式配置真源，必须覆盖长驻终端中可能过期的同名变量。 */
export function mergeDevelopmentEnvironment(
  inherited: DevelopmentEnvironmentSource,
  fileContents: string,
): Readonly<Record<string, string | undefined>> {
  return Object.freeze({ ...inherited, ...parseEnv(fileContents) });
}

export async function loadDevelopmentEnvironment(
  inherited: DevelopmentEnvironmentSource,
  environmentFile: string | URL,
): Promise<Readonly<Record<string, string | undefined>>> {
  try {
    return mergeDevelopmentEnvironment(inherited, await readFile(environmentFile, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return Object.freeze({ ...inherited });
    }
    throw new Error("DEVELOPMENT_ENV_FILE_UNREADABLE", { cause: error });
  }
}
