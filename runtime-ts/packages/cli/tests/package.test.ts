import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);

describe("hoox 发布产物", () => {
  it("独立目录中不依赖私有 workspace 包即可执行并离线校验", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hoox-cli-package-"));
    try {
      const executable = join(directory, "hoox.mjs");
      await copyFile(new URL("../dist/hoox.js", import.meta.url), executable);
      const result = await execute(process.execPath, [executable, "--help"], { cwd: directory });
      expect(result.stdout).toContain("hoox validate");
      expect(result.stderr).toBe("");
      const source = join(directory, "invalid.yaml");
      await writeFile(source, "schemaVersion: 2\n");
      const rejected = await execute(process.execPath, [executable, "validate", source, "--json"], {
        cwd: directory,
        env: { ...process.env, HOOX_URL: "invalid", HOOX_TOKEN: "placeholder-token-never-print" },
      }).catch((error: unknown) => error as { code: number; stdout: string; stderr: string });
      expect(rejected).toMatchObject({ code: 2, stderr: "" });
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        error: { errors: [{ path: "/schemaVersion" }] },
      });
      expect(rejected.stdout).not.toContain("placeholder-token-never-print");
      const manifest = JSON.parse(
        await readFile(new URL("../dist/package.json", import.meta.url), "utf8"),
      );
      expect(manifest).toMatchObject({ name: "@hoox/cli", bin: { hoox: "hoox.js" } });
      expect(manifest.dependencies).toBeUndefined();
      const licenses = await readFile(
        new URL("../dist/THIRD_PARTY_LICENSES", import.meta.url),
        "utf8",
      );
      expect(licenses).toContain("@sinclair/typebox");
      expect(licenses).toContain("The MIT License (MIT)");
      expect(licenses).toContain("yaml");
      expect(licenses).toContain("Copyright Eemeli Aro");
      expect(manifest.files).toContain("THIRD_PARTY_LICENSES");
      expect(manifest.license).toBe("Apache-2.0");
      expect(manifest.files).toContain("LICENSE");
      expect(await readFile(new URL("../dist/LICENSE", import.meta.url), "utf8")).toContain(
        "Apache License",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
