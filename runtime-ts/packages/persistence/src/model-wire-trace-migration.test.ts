import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const upUrl = new URL("../migrations/0017_model_wire_trace.up.sql", import.meta.url);
const downUrl = new URL("../migrations/0017_model_wire_trace.down.sql", import.meta.url);
const repositoryUrl = new URL("./pg-model-wire-trace.ts", import.meta.url);
const rolesUrl = new URL("./role-bootstrap.ts", import.meta.url);

describe("0017 模型网络诊断迁移契约", () => {
  it("以完整 stable 身份复合外键绑定引用，且不静默吞掉冲突", async () => {
    const sql = await readFile(upUrl, "utf8");
    expect(sql).toContain("blob_references_model_wire_identity_unique");
    expect(sql).toMatch(
      /blob_reference_id, blob_operation_id, blob_state, blob_purpose, sha256, size,[\s\S]*blob_lifecycle_id, blob_incarnation_id, physical_object_key[\s\S]*REFERENCES blob_references/u,
    );
    expect(sql).toContain("blob_state = 'stable'");
    expect(sql).toContain("blob_purpose = 'trace'");
    expect(sql).toMatch(
      /blob_references_expired_trace_delete_policy[\s\S]*EXISTS \([\s\S]*FROM model_wire_trace_cleanup_items item[\s\S]*item\.physical_object_key = blob_references\.physical_object_key/u,
    );
    expect(sql).not.toMatch(/ON\s+CONFLICT\s+DO\s+NOTHING/iu);
  });

  it("保留命令、processing lease、清理 outbox 与最小到期墓碑", async () => {
    const sql = await readFile(upUrl, "utf8");
    for (const fact of [
      "command_digest",
      "processing_token",
      "processing_lease_expires_at",
      "model_wire_trace_cleanup_commands",
      "model_wire_trace_cleanup_items",
      "model_wire_trace_expiry_tombstones",
      "FOR DELETE",
    ]) {
      expect(sql).toContain(fact);
    }
    expect(sql).toContain("capture_error_code");
    expect(sql).toContain("BODY_UNREADABLE");
  });

  it("down 先释放专属 trace 引用并恢复 0002 RLS policy，再撤销所有 0017 事实", async () => {
    const sql = await readFile(downUrl, "utf8");
    expect(sql.indexOf("DELETE FROM blob_references")).toBeLessThan(
      sql.indexOf("DROP TABLE model_wire_trace_records"),
    );
    expect(sql).toContain("CREATE POLICY blob_references_isolation_policy");
    expect(sql).toContain("DROP TABLE model_wire_trace_cleanup_items");
    expect(sql).toContain("DROP CONSTRAINT blob_references_model_wire_identity_unique");
  });

  it("永久墓碑 staging sweep 使用持久轮转游标，且 runtime 只能更新该游标", async () => {
    const [migration, repository, roles] = await Promise.all([
      readFile(upUrl, "utf8"),
      readFile(repositoryUrl, "utf8"),
      readFile(rolesUrl, "utf8"),
    ]);
    expect(migration).toContain("staging_swept_at timestamptz");
    expect(migration).toContain("model_wire_trace_tombstone_staging_sweep_idx");
    expect(migration).toContain("retention_recovery_at timestamptz");
    expect(migration).toContain("model_wire_trace_records_recovery_sweep_idx");
    expect(repository).toContain("staging_swept_at ASC NULLS FIRST");
    expect(repository).toContain("SET staging_swept_at=clock_timestamp()");
    expect(repository).toContain("record.retention_recovery_at ASC NULLS FIRST");
    expect(repository).toContain("SET retention_recovery_at=clock_timestamp()");
    expect(roles).toContain(
      '["model_wire_trace_expiry_tombstones", new Set(["staging_swept_at"])]',
    );
  });
});
