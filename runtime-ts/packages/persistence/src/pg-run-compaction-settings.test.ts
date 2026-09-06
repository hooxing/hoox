import type { RunCompactionSettings } from "@hoox/admin-control";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgRunCompactionSettingsRepository } from "./pg-run-compaction-settings.js";

const deploymentSettings: RunCompactionSettings = {
  softLimitPercent: 80,
  targetPercent: 55,
  recentUserTokens: 4096,
  maxOutputTokens: 4096,
  timeoutMs: 60_000,
};
const input = { tenantId: "tenant-a", runId: "run-a", deploymentSettings };

function row(settings: RunCompactionSettings) {
  return {
    soft_limit_percent: settings.softLimitPercent,
    target_percent: settings.targetPercent,
    recent_user_tokens: settings.recentUserTokens,
    max_output_tokens: settings.maxOutputTokens,
    timeout_ms: settings.timeoutMs,
  };
}

function fixture(
  options: {
    readonly existing?: RunCompactionSettings;
    readonly legacy?: Record<string, unknown>;
    readonly active?: Record<string, unknown>;
    readonly concurrentWinner?: RunCompactionSettings;
  } = {},
) {
  let stored = options.existing;
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes("FROM run_compaction_settings_snapshots")) {
      return { rows: stored === undefined ? [] : [row(stored)] };
    }
    if (sql.includes("FROM run_runtime_config_snapshots")) {
      return { rows: options.legacy === undefined ? [] : [{ configuration: options.legacy }] };
    }
    if (sql.includes("FROM admin_control_active_configs")) {
      return { rows: options.active === undefined ? [] : [{ configuration: options.active }] };
    }
    if (sql.includes("INSERT INTO run_compaction_settings_snapshots")) {
      if (options.concurrentWinner !== undefined) {
        stored = options.concurrentWinner;
        return { rows: [] };
      }
      stored = {
        softLimitPercent: values?.[2] as number,
        targetPercent: values?.[3] as number,
        recentUserTokens: values?.[4] as number,
        maxOutputTokens: values?.[5] as number,
        timeoutMs: values?.[6] as number,
      };
      return { rows: [row(stored)] };
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, query, repository: new PgRunCompactionSettingsRepository(pool) };
}

describe("Run 压缩参数持久快照", () => {
  it("无后台模型时也采用在线设置，并在后续修改后保持 Run 首次选择", async () => {
    const active = {
      compactionSoftLimitPercent: 90,
      compactionTargetPercent: 65,
      compactionRecentUserTokens: 1234,
      compactionMaxOutputTokens: 2048,
      compactionTimeoutMs: 30000,
    };
    const { repository } = fixture({ active });
    const initial = await repository.resolveForRun(input);
    expect(initial).toEqual({
      softLimitPercent: 90,
      targetPercent: 65,
      recentUserTokens: 1234,
      maxOutputTokens: 2048,
      timeoutMs: 30000,
    });
    active.compactionTargetPercent = 70;
    await expect(repository.resolveForRun(input)).resolves.toEqual(initial);
  });
  it("无后台模型或旧引用也固定部署值，重建仓储后保持原值", async () => {
    const { pool, query, repository } = fixture();
    await expect(repository.resolveForRun(input)).resolves.toEqual(deploymentSettings);
    await expect(
      new PgRunCompactionSettingsRepository(pool).resolveForRun({
        ...input,
        deploymentSettings: { ...deploymentSettings, targetPercent: 60 },
      }),
    ).resolves.toEqual(deploymentSettings);
    expect(query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO"))).toHaveLength(1);
    expect(query.mock.calls.filter(([sql]) => sql.includes("set_config"))[0]?.[1]).toEqual([
      "tenant-a",
      "",
    ]);
    expect(query.mock.calls.some(([sql]) => sql.includes("admin_control_active_configs"))).toBe(
      true,
    );
  });

  it("升级恢复已有旧 Run 时继承固定 revision，不接受新的部署参数覆盖", async () => {
    const { repository } = fixture({
      legacy: {
        compactionSoftLimitPercent: 85,
        compactionTargetPercent: 60,
        compactionRecentUserTokens: 16_000,
        compactionMaxOutputTokens: 2048,
        compactionTimeoutMs: 30_000,
      },
    });
    await expect(repository.resolveForRun(input)).resolves.toEqual({
      softLimitPercent: 85,
      targetPercent: 60,
      recentUserTokens: 16_000,
      maxOutputTokens: 2048,
      timeoutMs: 30_000,
    });
  });

  it("已经保存的参数优先于旧后台引用，且不会重新写入", async () => {
    const existing = { ...deploymentSettings, maxOutputTokens: 1024 };
    const { repository, query } = fixture({ existing, legacy: {} });
    await expect(repository.resolveForRun(input)).resolves.toEqual(existing);
    expect(query.mock.calls.some(([sql]) => sql.includes("run_runtime_config_snapshots"))).toBe(
      false,
    );
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
  });

  it("并发首次写入冲突时返回已落库的胜出预算", async () => {
    const concurrentWinner = { ...deploymentSettings, maxOutputTokens: 1024 };
    const { repository } = fixture({ concurrentWinner });
    await expect(repository.resolveForRun(input)).resolves.toEqual(concurrentWinner);
  });

  it("旧快照损坏时失败关闭，不静默回退部署值", async () => {
    const { repository, query } = fixture({ legacy: { compactionSoftLimitPercent: 0 } });
    await expect(repository.resolveForRun(input)).rejects.toMatchObject({ code: "UNEXPECTED" });
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
  });
});
