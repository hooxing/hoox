CREATE TABLE tenant_webhooks (
  tenant_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  endpoint_url text NOT NULL CHECK (endpoint_url LIKE 'https://%'),
  event_types text[] NOT NULL CHECK (cardinality(event_types) > 0 AND event_types <@ ARRAY['run.waiting','run.requires_action','run.succeeded','run.failed','run.cancelled','artifact.published']::text[]),
  secret_ciphertext jsonb NOT NULL,
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  disabled_reason text,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);
ALTER TABLE tenant_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhooks FORCE ROW LEVEL SECURITY;
REVOKE ALL ON tenant_webhooks FROM PUBLIC;

-- Outbox 不保存目的地址或签名密钥：领取时读取当前地址，发送前复核订阅状态与密钥。
CREATE TABLE webhook_outbox (
  tenant_id text NOT NULL,
  id text NOT NULL,
  webhook_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('run.waiting','run.requires_action','run.succeeded','run.failed','run.cancelled','artifact.published')),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','delivered','disabled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_token text,
  claim_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,webhook_id,event_id),
  FOREIGN KEY (tenant_id,webhook_id) REFERENCES tenant_webhooks(tenant_id,id) ON DELETE CASCADE,
  CHECK ((state = 'claimed') = (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL))
);
CREATE INDEX webhook_outbox_due_idx ON webhook_outbox(next_attempt_at,created_at)
  WHERE state IN ('pending','claimed');
ALTER TABLE webhook_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON webhook_outbox FROM PUBLIC;

DO $$
DECLARE
  runtime_role name := NULLIF(current_setting('app.runtime_role', true), '');
BEGIN
  IF runtime_role IS NULL THEN
    RAISE EXCEPTION 'Runtime 数据库角色未配置';
  END IF;
  -- 完整的 Tenant 管理策略只绑定 Runtime；团队批量取消使用独立的只读及入队策略。
  EXECUTE format(
    'CREATE POLICY tenant_webhooks_tenant_policy ON tenant_webhooks TO %I
       USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), ''''))
       WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), ''''))',
    runtime_role
  );
  EXECUTE format(
    'CREATE POLICY webhook_outbox_tenant_policy ON webhook_outbox TO %I
       USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), ''''))
       WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), ''''))',
    runtime_role
  );
END
$$;

-- Team Coordinator 的每类操作单独绑定，Bootstrap 之前默认没有行可见或可写。
CREATE POLICY webhook_team_subscriptions ON tenant_webhooks FOR SELECT USING (false);
CREATE POLICY webhook_team_keys ON webhook_outbox FOR SELECT USING (false);
CREATE POLICY webhook_team_enqueue ON webhook_outbox FOR INSERT WITH CHECK (false);

-- Dispatcher 策略先以恒假占位，由 Bootstrap 绑定到当前配置的 Dispatcher 角色。
-- Dispatcher 只能把仍启用的订阅改为停用（WITH CHECK 拒绝恢复启用），可更新列由列级 ACL 限定。
CREATE POLICY tenant_webhooks_dispatcher_read ON tenant_webhooks FOR SELECT USING (false);
CREATE POLICY tenant_webhooks_dispatcher_disable ON tenant_webhooks FOR UPDATE
  USING (false) WITH CHECK (false);
CREATE POLICY webhook_outbox_dispatcher_policy ON webhook_outbox USING (false) WITH CHECK (false);
