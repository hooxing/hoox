import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRuns, internalTesting } from "./server.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cube-trajectory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("trajectory diagnostics filesystem", () => {
  it("只发现固定根下的普通 Run 和 Attempt 目录", async () => {
    const root = await temporaryRoot();
    const attempt = join(root, "run_1", "attempt-1");
    await mkdir(attempt, { recursive: true });
    await writeFile(
      join(attempt, "runtime-event-00000000-agent_event.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "agent_event",
        sequence: 0,
        payload: { type: "agent.started" },
      }),
    );
    const outside = await temporaryRoot();
    await symlink(
      outside,
      join(root, "run_link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const runs = await discoverRuns(root);
    expect(runs.map((run) => run.runId)).toEqual(["run_1"]);
    expect(runs[0]?.attempts.map((item) => item.attemptId)).toEqual(["attempt-1"]);
  });

  it("模型报文读取拒绝路径逃逸和非白名单文件", async () => {
    const root = await temporaryRoot();
    const attempt = join(root, "run_1", "attempt-1");
    await mkdir(attempt, { recursive: true });
    const allowed = "model-turn-01-transport-0-request-complete.json";
    await writeFile(join(attempt, allowed), "{}");
    await writeFile(join(attempt, "secret.txt"), "secret");

    await expect(internalTesting.safeTraceFile(root, "run_1", "attempt-1", allowed)).resolves.toBe(
      join(attempt, allowed),
    );
    await expect(
      internalTesting.safeTraceFile(root, "run_1", "attempt-1", "../secret.txt"),
    ).resolves.toBeUndefined();
    await expect(
      internalTesting.safeTraceFile(root, "run_1", "attempt-1", "secret.txt"),
    ).resolves.toBeUndefined();
  });
});
