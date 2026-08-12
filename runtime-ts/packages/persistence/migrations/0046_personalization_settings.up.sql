-- ADR-0168：个人与团队个性化分表持久化，Run 只读取当前版本的低信任偏好快照。
CREATE TABLE user_personalization_settings (
  user_id text PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  content text NOT NULL,
  apply_to_team_tasks boolean NOT NULL DEFAULT true,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_personalization_content_check CHECK (
    character_length(content) <= 2000 AND octet_length(content) <= 8192
  )
);

CREATE TABLE team_personalization_settings (
  tenant_id text PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  content text NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  updated_by_user_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,updated_by_user_id)
    REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  CONSTRAINT team_personalization_content_check CHECK (
    character_length(content) <= 2000 AND octet_length(content) <= 8192
  )
);

ALTER TABLE user_personalization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_personalization_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY user_personalization_self_policy ON user_personalization_settings
  USING (user_id=NULLIF(current_setting('app.user_id',true),''))
  WITH CHECK (user_id=NULLIF(current_setting('app.user_id',true),''));

ALTER TABLE team_personalization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_personalization_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY team_personalization_read_policy ON team_personalization_settings
  FOR SELECT USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_personalization_settings.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active'
    )
  );
CREATE POLICY team_personalization_manage_policy ON team_personalization_settings
  FOR ALL USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_personalization_settings.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active'
         AND actor.role IN ('owner','admin')
    )
  ) WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND updated_by_user_id=NULLIF(current_setting('app.user_id',true),'')
    AND EXISTS (
      SELECT 1 FROM tenants tenant
       WHERE tenant.id=team_personalization_settings.tenant_id AND tenant.kind='team'
    )
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_personalization_settings.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active'
         AND actor.role IN ('owner','admin')
    )
  );
