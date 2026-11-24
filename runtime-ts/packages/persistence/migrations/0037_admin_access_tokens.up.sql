CREATE TABLE admin_access_tokens (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  scopes text[] NOT NULL CHECK (
    cardinality(scopes) BETWEEN 1 AND 2
    AND scopes <@ ARRAY['agent-config:read','agent-config:write']::text[]
    AND ('agent-config:write' <> ALL(scopes) OR 'agent-config:read' = ANY(scopes))
  ),
  created_by text NOT NULL,
  token_prefix text NOT NULL CHECK (length(token_prefix) = 16),
  token_salt bytea NOT NULL CHECK (octet_length(token_salt) = 16),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  last_use_audited_at timestamptz
);

CREATE INDEX admin_access_tokens_creator_idx ON admin_access_tokens(created_by, created_at DESC);
CREATE INDEX admin_access_tokens_prefix_idx ON admin_access_tokens(token_prefix);

CREATE TABLE admin_access_token_audits (
  audit_id uuid PRIMARY KEY,
  token_id uuid NOT NULL,
  creator_user_id text NOT NULL,
  route text NOT NULL CHECK (length(route) <= 512),
  result text NOT NULL CHECK (result IN ('allowed', 'denied')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_access_token_audits_token_idx
  ON admin_access_token_audits(token_id, created_at DESC);

ALTER TABLE admin_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_access_tokens_migrator_policy ON admin_access_tokens
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY admin_access_tokens_admin_policy ON admin_access_tokens
  FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE admin_access_token_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_access_token_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_access_token_audits_migrator_policy ON admin_access_token_audits
  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY admin_access_token_audits_admin_policy ON admin_access_token_audits
  FOR ALL USING (true) WITH CHECK (true);
