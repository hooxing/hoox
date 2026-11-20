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
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
ALTER TABLE tenant_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_webhooks_tenant_policy ON tenant_webhooks
  USING (tenant_id = current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id',true));
REVOKE ALL ON tenant_webhooks FROM PUBLIC;

CREATE TABLE webhook_outbox (
  tenant_id text NOT NULL,
  id text NOT NULL,
  webhook_id text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('run.waiting','run.requires_action','run.succeeded','run.failed','run.cancelled','artifact.published')),
  endpoint_url text NOT NULL CHECK (endpoint_url LIKE 'https://%'),
  secret_ciphertext jsonb NOT NULL,
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
  FOREIGN KEY (tenant_id,webhook_id) REFERENCES tenant_webhooks(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE webhook_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_outbox_tenant_policy ON webhook_outbox
  USING (tenant_id = current_setting('app.tenant_id',true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id',true));
CREATE POLICY webhook_outbox_dispatcher_policy ON webhook_outbox USING (false) WITH CHECK (false);
REVOKE ALL ON webhook_outbox FROM PUBLIC;
