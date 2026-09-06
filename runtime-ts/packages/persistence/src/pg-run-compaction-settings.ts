import {
  normalizeRunCompactionSettings,
  type RunCompactionSettings,
  type RunCompactionSettingsPort,
} from "@hoox/admin-control";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

interface CompactionSettingsRow extends QueryResultRow {
  readonly soft_limit_percent: number;
  readonly target_percent: number;
  readonly recent_user_tokens: number;
  readonly max_output_tokens: number;
  readonly timeout_ms: number;
}

function fromRow(row: CompactionSettingsRow): RunCompactionSettings {
  return normalizeRunCompactionSettings({
    softLimitPercent: row.soft_limit_percent,
    targetPercent: row.target_percent,
    recentUserTokens: row.recent_user_tokens,
    maxOutputTokens: row.max_output_tokens,
    timeoutMs: row.timeout_ms,
  });
}

export class PgRunCompactionSettingsRepository implements RunCompactionSettingsPort {
  constructor(private readonly pool: Pool) {}

  async resolveForRun(input: Parameters<RunCompactionSettingsPort["resolveForRun"]>[0]) {
    try {
      return await withTenantTransaction(this.pool, input, async (client) => {
        const existing = await this.read(client, input);
        if (existing !== undefined) return existing;
        const legacy = await client.query<{ readonly configuration: Record<string, number> }>(
          `SELECT revision.configuration
             FROM run_runtime_config_snapshots snapshot
             JOIN admin_control_config_revisions revision
               ON revision.object_kind='runtime_settings'
              AND revision.object_key=snapshot.runtime_settings_object_key
              AND revision.revision=snapshot.runtime_settings_revision
            WHERE snapshot.tenant_id=$1 AND snapshot.run_id=$2`,
          [input.tenantId, input.runId],
        );
        let previous = legacy.rows[0]?.configuration;
        if (previous === undefined) {
          const active = await client.query<{ readonly configuration: Record<string, number> }>(
            `SELECT revision.configuration
               FROM admin_control_active_configs active
               JOIN admin_control_config_revisions revision
                 ON revision.object_kind=active.object_kind AND revision.object_key=active.object_key
                AND revision.revision=active.revision
              WHERE active.object_kind='runtime_settings' AND active.object_key='global'`,
          );
          previous = active.rows[0]?.configuration;
        }
        // 已固定的 Run 优先；首次解析采用后台当前设置，未配置时采用部署默认值。
        const selected = normalizeRunCompactionSettings(
          previous === undefined
            ? input.deploymentSettings
            : {
                softLimitPercent: previous.compactionSoftLimitPercent as number,
                targetPercent: previous.compactionTargetPercent as number,
                recentUserTokens: previous.compactionRecentUserTokens as number,
                maxOutputTokens: previous.compactionMaxOutputTokens as number,
                timeoutMs: previous.compactionTimeoutMs as number,
              },
        );
        const inserted = await client.query<CompactionSettingsRow>(
          `INSERT INTO run_compaction_settings_snapshots(
             tenant_id,run_id,soft_limit_percent,target_percent,recent_user_tokens,
             max_output_tokens,timeout_ms
           ) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(tenant_id,run_id) DO NOTHING
           RETURNING soft_limit_percent,target_percent,recent_user_tokens,max_output_tokens,timeout_ms`,
          [
            input.tenantId,
            input.runId,
            selected.softLimitPercent,
            selected.targetPercent,
            selected.recentUserTokens,
            selected.maxOutputTokens,
            selected.timeoutMs,
          ],
        );
        const row = inserted.rows[0];
        if (row !== undefined) return fromRow(row);
        // 并发首次解析只能采用胜出写入者的参数，不能返回本次未落库的部署值。
        const winner = await this.read(client, input);
        if (winner === undefined) throw new Error("Run 上下文压缩快照写入后不可见");
        return winner;
      });
    } catch (error) {
      throw mapPersistenceError(error, "解析 Run 固定上下文压缩参数");
    }
  }

  private async read(
    client: PoolClient,
    input: { readonly tenantId: string; readonly runId: string },
  ): Promise<RunCompactionSettings | undefined> {
    const result = await client.query<CompactionSettingsRow>(
      `SELECT soft_limit_percent,target_percent,recent_user_tokens,max_output_tokens,timeout_ms
         FROM run_compaction_settings_snapshots WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, input.runId],
    );
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }
}
