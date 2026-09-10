import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executableDownSql, loadMigrations } from "./migrations.js";

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");
}

describe("后台控制面迁移", () => {
  it("把配置、激活、审计和 Run 快照分表，并对 Runtime 只开放已发布读取", () => {
    const sql = migration("0050_admin_control_plane.up.sql");
    expect(sql).toContain("CREATE TABLE admin_control_config_revisions");
    expect(sql).toContain("CREATE TABLE admin_control_activation_events");
    expect(sql).toContain("CREATE TABLE run_runtime_config_snapshots");
    expect(sql).toContain("CREATE VIEW admin_runtime_statistics");
    expect(sql).toContain("runtime_control_revisions_read_policy");
    expect(sql).toContain("run_runtime_config_snapshots_runtime_policy");
    expect(sql).toContain(
      "snapshot.tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')",
    );
    expect(sql).not.toContain("run_runtime_config_snapshots_control_read_policy");
    expect(sql).toContain("admin_control_configuration_shape");
    expect(sql).toContain("configuration-ARRAY[");
    expect(sql).toContain("configuration->>'providerKey'=object_key");
    expect(sql).toContain("object_key='global'");
    expect(sql).not.toContain("MODEL_API_KEY");
    expect(sql).not.toContain("MEM0_API_KEY");
  });

  it("存在任何配置、审计或 Run 快照时拒绝破坏性回滚", () => {
    const sql = migration("0050_admin_control_plane.down.sql");
    expect(sql).toContain("后台控制面已有事实，禁止破坏性回退");
    expect(sql).toContain("run_runtime_config_snapshots");
    expect(sql).not.toContain("DROP POLICY runtime_control_revisions_read_policy");
  });

  it("后续迁移把模型配置收紧为 Provider 模型目录并保护不可逆降级", () => {
    const up = migration("0051_provider_model_catalog.up.sql");
    expect(up).toContain("'defaultModelId','models'");
    expect(up).toContain("jsonb_array_length(configuration->'models') BETWEEN 1 AND 100");
    expect(up).toContain("@.enabled == true && @.id == $.defaultModelId");
    expect(up).toContain("@.maxTokens <= @.contextWindow");
    expect(up).not.toContain("MODEL_API_KEY");

    const down = migration("0051_provider_model_catalog.down.sql");
    expect(down).toContain("已有模型目录配置事实，禁止降级为单模型结构");
    expect(down).toContain("object_kind='model_provider'");
  });

  it("托管模型密钥只以加密包进入 Revision，并阻止有事实时降级", () => {
    const up = migration("0056_managed_model_provider_credentials.up.sql");
    expect(up).toContain("'version','nonce','ciphertext','authTag'");
    expect(up).toContain("configuration->>'secretRef'='deployment:model'");
    expect(up).not.toContain("apiKey");
    expect(up).not.toContain("MODEL_API_KEY");

    const down = migration("0056_managed_model_provider_credentials.down.sql");
    expect(down).toContain("DOWN_MIGRATION_BLOCKED:managed_model_provider_credentials_exist");
  });

  it("运行设置迁移回填并发默认值并建立用户领取索引", () => {
    const up = migration("0057_user_run_concurrency.up.sql");
    expect(up).toContain("'workerMaxConcurrentRuns',20");
    expect(up).toContain("'userMaxConcurrentRunsPerTenant',2");
    expect(up).toContain("'workerMaxConcurrentRuns','userMaxConcurrentRunsPerTenant'");
    expect(up).toContain("BETWEEN 1 AND 100");
    expect(up).toContain("CREATE INDEX run_skill_snapshots_user_run_idx");
    expect(up).toContain("ON run_skill_snapshots(tenant_id,user_id,run_id)");

    const down = migration("0057_user_run_concurrency.down.sql");
    expect(down).toContain("DROP INDEX run_skill_snapshots_user_run_idx");
    expect(down).toContain("configuration-ARRAY[");
    expect(down).toContain("'workerMaxConcurrentRuns','userMaxConcurrentRunsPerTenant'");
  });

  it("用户治理通过受限目录、最小列权限和独立审计暴露", () => {
    const up = migration("0052_admin_user_operations.up.sql");
    const roleBootstrap = readFileSync(
      fileURLToPath(new URL("./role-bootstrap.ts", import.meta.url)),
      "utf8",
    );
    const schemaPlaceholder = "${" + "schema}";
    const controlPlaceholder = "${" + "control}";
    expect(up).toContain("CREATE VIEW admin_user_directory WITH (security_barrier=true)");
    expect(up).toContain("CREATE TABLE admin_user_account_audits");
    expect(up).toContain("user_accounts_admin_control_update_policy");
    expect(up).toContain("user_sessions_admin_control_delete_policy");
    expect(up).toContain("AS users_active_7d");
    expect(up).toContain("AS conversations_active_24h");
    expect(up).not.toContain("password_hash");
    expect(up).not.toContain("token_digest");
    expect(roleBootstrap).toContain("hasAdminUserOperationsState");
    expect(roleBootstrap).toContain('["admin_user_account_audits", new Set()]');
    expect(roleBootstrap).toContain(
      `GRANT UPDATE(status,updated_at) ON TABLE ${schemaPlaceholder}.user_accounts TO ${controlPlaceholder}`,
    );
    expect(roleBootstrap).toContain(
      `GRANT SELECT(user_id) ON TABLE ${schemaPlaceholder}.user_sessions TO ${controlPlaceholder}`,
    );
    expect(roleBootstrap).not.toContain(
      `GRANT SELECT ON TABLE ${schemaPlaceholder}.user_accounts TO ${controlPlaceholder}`,
    );

    const down = migration("0052_admin_user_operations.down.sql");
    expect(down).toContain("已有用户治理事实，禁止移除账号状态和审计");
    expect(down.indexOf("ALTER TABLE user_accounts DROP COLUMN status")).toBeLessThan(
      down.indexOf("DROP VIEW admin_runtime_statistics"),
    );
  });

  it("模型用量复用低基数指标账本并通过后台受限视图聚合", () => {
    const up = migration("0053_model_usage_metrics.up.sql");
    expect(up).toContain("'model_input_tokens'");
    expect(up).toContain("'model_output_tokens'");
    expect(up).toContain("'model_cache_read_tokens'");
    expect(up).toContain("'model_generation_duration_ms'");
    expect(up).toContain("observed_at>=clock_timestamp()-interval '24 hours'");
    expect(up).toContain("CREATE OR REPLACE VIEW admin_runtime_statistics");
    expect(up).not.toContain("request_body");
    expect(up).not.toContain("response_body");
    expect(up).not.toContain("provider_id");

    const down = migration("0053_model_usage_metrics.down.sql");
    expect(down).toContain("已有模型用量观测事实，禁止移除统计语义");
    expect(down).toContain("CREATE OR REPLACE VIEW admin_runtime_statistics");

    const index = migration("0054_model_usage_admin_index.up.sql");
    expect(index).toContain("CREATE INDEX model_usage_metrics_admin_query_idx");
    expect(index).toContain("metric_name,observed_at DESC");
  });

  it("保持已发布 checksum，并只在执行 down 时修复依赖顺序", async () => {
    const migrations = await loadMigrations();
    const byVersion = (version: number) => {
      const source = migrations.find((migration) => migration.version === version);
      if (source === undefined) throw new Error(`缺少迁移 ${version}`);
      return source;
    };

    const migration50 = byVersion(50);
    expect(migration50.checksum).toBe(
      "799aee36463d5520efd57b03de3619678387d92024ed6c85f46dae54f6d019f8",
    );
    const executable50 = executableDownSql(migration50);
    expect(executable50.indexOf("DROP POLICY runtime_control_revisions_read_policy")).toBeLessThan(
      executable50.indexOf("DROP TABLE run_runtime_config_snapshots"),
    );

    const migration52 = byVersion(52);
    expect(migration52.checksum).toBe(
      "80a8293017276bedb2eda063e3ecd0c33a635d46810245a02d8a249cdee5ac7a",
    );
    const executable52 = executableDownSql(migration52);
    expect(executable52.indexOf("DROP VIEW admin_runtime_statistics")).toBeLessThan(
      executable52.indexOf("ALTER TABLE user_accounts DROP COLUMN status"),
    );

    const migration53 = byVersion(53);
    expect(migration53.checksum).toBe(
      "93d9244d34e54403e187867916f4a4ecc3b7f5ab856e17a2e1b26060fdbe1f54",
    );
    const executable53 = executableDownSql(migration53);
    expect(executable53).toContain(
      "DROP VIEW admin_runtime_statistics;\nCREATE VIEW admin_runtime_statistics",
    );
    expect(executable53).not.toContain("CREATE OR REPLACE VIEW admin_runtime_statistics");

    const migration64 = byVersion(64);
    expect(migration64.checksum).toBe(
      "ef2616c64165552f3474af0453940fe34b3e9174e378770bf14e56a8f6f9900e",
    );
    const executable64 = executableDownSql(migration64);
    expect(executable64.indexOf("DROP POLICY runtime_profile_read")).toBeLessThan(
      executable64.indexOf("DROP TABLE sandbox_configuration_bindings"),
    );
  });
});
