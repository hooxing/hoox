import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { expect, it } from "vitest";
import { prepareDemoSandboxKey } from "../../scripts/prepare-demo-sandbox-key.mjs";

it("保留现有加密根并幂等补齐，冲突时不修改任何文件", () => {
  const directory = mkdtempSync(join(tmpdir(), "hoox-key-"));
  const root = "placeholder-key-for-test-only-1234567890";
  const admin = join(directory, "admin-control.env");
  const worker = join(directory, "worker.env");
  const scheduler = join(directory, "scheduler.env");
  try {
    writeFileSync(admin, `MODEL_CREDENTIAL_ENCRYPTION_KEY=${root}\n`);
    writeFileSync(worker, `MODEL_API_KEY=${root}\n`);
    writeFileSync(scheduler, "OTHER_SETTING=unchanged\n");
    prepareDemoSandboxKey(directory);
    const content = readFileSync(scheduler, "utf8");
    expect(parseEnv(content)).toEqual({
      OTHER_SETTING: "unchanged",
      MODEL_CREDENTIAL_ENCRYPTION_KEY: root,
    });
    prepareDemoSandboxKey(directory);
    expect(readFileSync(scheduler, "utf8")).toBe(content);
    writeFileSync(worker, "MODEL_CREDENTIAL_ENCRYPTION_KEY=different-placeholder-key-1234567890\n");
    const before = [admin, worker, scheduler].map((file) => readFileSync(file, "utf8"));
    expect(() => prepareDemoSandboxKey(directory)).toThrow();
    expect([admin, worker, scheduler].map((file) => readFileSync(file, "utf8"))).toEqual(before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
