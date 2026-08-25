import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDatabaseDevelopmentEnvironment } from "./development-database-environment.js";

describe("数据库开发命令环境真源", () => {
  it("仓库 .env 覆盖长驻终端中的旧数据库配置", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoox-database-env-"));
    const file = join(directory, ".env");
    try {
      await writeFile(file, "DATABASE_URL=postgresql://file/current\nRUNTIME_ENV=development\n");
      await expect(
        loadDatabaseDevelopmentEnvironment(
          { DATABASE_URL: "postgresql://inherited/stale", KEEP: "value" },
          file,
        ),
      ).resolves.toEqual({
        DATABASE_URL: "postgresql://file/current",
        RUNTIME_ENV: "development",
        KEEP: "value",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it(".env 不存在时保留显式注入环境", async () => {
    await expect(
      loadDatabaseDevelopmentEnvironment(
        { DATABASE_URL: "postgresql://injected/runtime" },
        join(tmpdir(), "hoox-missing-database-env", ".env"),
      ),
    ).resolves.toEqual({ DATABASE_URL: "postgresql://injected/runtime" });
  });
});
