-- 回退只恢复 schema 默认值；不覆盖运维已经写入的 Tenant policy，也不抹除已产生的连续上下文事实。
ALTER TABLE tenant_thread_continuity_policies
  ALTER COLUMN v2_read_enabled SET DEFAULT false,
  ALTER COLUMN new_thread_rollout_basis_points SET DEFAULT 0,
  ALTER COLUMN legacy_anchor_read_enabled SET DEFAULT false;
