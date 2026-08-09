-- Worker 只通过这个无业务载荷的控制面动态选择 Tenant；Run/Thread 等事实继续受原表 FORCE RLS 隔离。
CREATE TABLE worker_tenant_assignments (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('idle','ready','claimed')),
  generation bigint NOT NULL DEFAULT 0
    CHECK (generation >= 0 AND generation <= 9007199254740991),
  claim_token text,
  claimed_by text CHECK (
    claimed_by IS NULL OR octet_length(claimed_by) BETWEEN 1 AND 200
  ),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT worker_tenant_assignments_claim_shape CHECK (
    (
      state='claimed'
      AND claim_token IS NOT NULL
      AND claimed_by IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR (
      state IN ('idle','ready')
      AND claim_token IS NULL
      AND claimed_by IS NULL
      AND lease_expires_at IS NULL
    )
  )
);

CREATE INDEX worker_tenant_assignments_ready_idx
  ON worker_tenant_assignments(next_attempt_at,updated_at,tenant_id)
  WHERE state='ready';
CREATE INDEX worker_tenant_assignments_expired_claim_idx
  ON worker_tenant_assignments(lease_expires_at,updated_at,tenant_id)
  WHERE state='claimed';

-- 已经排队的个人或团队任务必须在迁移后自动进入动态调度，不能依赖用户重新提交。
-- FORCE RLS 对表 Owner 同样生效；迁移事务持有排他锁并只在回填窗口内关闭，随后立即恢复。
LOCK TABLE run_dispatch_outbox IN ACCESS EXCLUSIVE MODE;
ALTER TABLE run_dispatch_outbox DISABLE ROW LEVEL SECURITY;
INSERT INTO worker_tenant_assignments(tenant_id,state,next_attempt_at)
SELECT outbox.tenant_id,'ready',
       min(
         CASE
           WHEN outbox.state='ready' THEN outbox.next_attempt_at
           ELSE outbox.lease_expires_at + interval '1 millisecond'
         END
       )
  FROM run_dispatch_outbox outbox
 WHERE outbox.state IN ('ready','claimed')
 GROUP BY outbox.tenant_id;
ALTER TABLE run_dispatch_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_dispatch_outbox FORCE ROW LEVEL SECURITY;

ALTER TABLE worker_tenant_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_tenant_assignments FORCE ROW LEVEL SECURITY;
-- 普通 Runtime 仍按 app.tenant_id 隔离；全局 claim 只向独立登录角色开放，不能由请求级 GUC 提权。
DO $$
DECLARE
  runtime_role text := NULLIF(current_setting('app.runtime_role',true),'');
  coordinator_role text := NULLIF(current_setting('app.worker_coordinator_role',true),'');
BEGIN
  IF runtime_role IS NULL OR runtime_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.runtime_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
  IF coordinator_role IS NULL OR coordinator_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'app.worker_coordinator_role 未设置或不是安全 PostgreSQL 标识符';
  END IF;
  IF runtime_role=coordinator_role THEN
    RAISE EXCEPTION 'Runtime 与 Worker Coordinator 必须使用不同角色';
  END IF;

  EXECUTE format(
    'CREATE POLICY worker_tenant_assignments_runtime_policy ON worker_tenant_assignments TO %I USING (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id=NULLIF(current_setting(''app.tenant_id'',true),''''))',
    runtime_role
  );
  EXECUTE format(
    'CREATE POLICY worker_tenant_assignments_coordinator_select_policy ON worker_tenant_assignments FOR SELECT TO %I USING (true)',
    coordinator_role
  );
  EXECUTE format(
    'CREATE POLICY worker_tenant_assignments_coordinator_claim_policy ON worker_tenant_assignments FOR UPDATE TO %I USING (true) WITH CHECK (true)',
    coordinator_role
  );
END $$;
