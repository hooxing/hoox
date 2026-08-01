-- 连续上下文已经成为产品默认路径；显式 Tenant policy 和环境开关仍保留紧急回退能力。
ALTER TABLE tenant_thread_continuity_policies
  ALTER COLUMN v2_read_enabled SET DEFAULT true,
  ALTER COLUMN new_thread_rollout_basis_points SET DEFAULT 10000,
  ALTER COLUMN legacy_anchor_read_enabled SET DEFAULT true;

-- Migrator 不持有 BYPASSRLS；数据修复在同一 DDL 事务和排他表锁内短暂关闭策略，提交前恢复。
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_thread_continuity_policies DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_profiles DISABLE ROW LEVEL SECURITY;

INSERT INTO tenant_thread_continuity_policies(
  tenant_id,policy_version,v2_read_enabled,new_thread_rollout_basis_points,
  legacy_anchor_read_enabled
)
SELECT id,1,true,10000,true FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- 0026 上线后、Tenant policy 尚未建立时产生的 profile 使用 policy_version=0；它们属于默认档案，
-- 不是显式灰度关闭，因此随产品默认值切换到全量。
UPDATE thread_continuity_profiles
   SET rollout_selected=true
 WHERE rollout_source='new_thread' AND policy_version=0 AND rollout_selected=false;

ALTER TABLE thread_continuity_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_thread_continuity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_thread_continuity_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
