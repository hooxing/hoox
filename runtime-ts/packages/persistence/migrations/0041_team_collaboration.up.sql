CREATE TABLE team_member_directory (
  team_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  status text NOT NULL CHECK (status IN ('active','revoked')),
  joined_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (team_id,user_id)
);

CREATE INDEX team_member_directory_user_active_idx
  ON team_member_directory(user_id,status,display_name,team_id);

CREATE TABLE thread_forks (
  tenant_id text NOT NULL,
  child_thread_id text NOT NULL,
  source_tenant_id text NOT NULL,
  source_thread_id text NOT NULL,
  fork_kind text NOT NULL CHECK (fork_kind IN ('branch','team_publish')),
  created_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,child_thread_id),
  FOREIGN KEY (tenant_id,child_thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_user_id)
    REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT
);

CREATE INDEX thread_forks_source_idx
  ON thread_forks(source_tenant_id,source_thread_id,created_at,child_thread_id);

CREATE TABLE tenant_skill_installations (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  skill_version text NOT NULL,
  invocation_name text NOT NULL CHECK (
    octet_length(invocation_name) BETWEEN 1 AND 128
    AND invocation_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND lower(invocation_name) NOT IN ('clear','help','new','settings','skills')
  ),
  status text NOT NULL CHECK (status IN ('enabled','disabled','uninstalled')),
  version_token bigint NOT NULL DEFAULT 0 CHECK (version_token >= 0),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,skill_id),
  FOREIGN KEY (skill_id,skill_version)
    REFERENCES skill_versions(skill_id,version) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX tenant_skill_installations_invocation_active_unique
  ON tenant_skill_installations(tenant_id,invocation_name)
  WHERE status IN ('enabled','disabled');

CREATE TABLE tenant_skill_installation_commands (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
  ),
  operation text NOT NULL CHECK (operation IN ('install','configure','uninstall')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,idempotency_key)
);

CREATE TABLE tenant_skill_installation_audits (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 160),
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('install','configure','uninstall')),
  before_status text CHECK (before_status IN ('enabled','disabled','uninstalled')),
  after_status text NOT NULL CHECK (after_status IN ('enabled','disabled','uninstalled')),
  skill_version text NOT NULL,
  invocation_name text NOT NULL,
  version_token bigint NOT NULL CHECK (version_token >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,event_id),
  FOREIGN KEY (skill_id,skill_version)
    REFERENCES skill_versions(skill_id,version) ON DELETE RESTRICT
);

-- 个人 Skill 从“用户全局”迁移到个人 Tenant；团队从空策略开始，避免隐式继承个人能力。
INSERT INTO tenant_skill_installations(
  tenant_id,skill_id,skill_version,invocation_name,status,version_token,installed_at,updated_at
)
SELECT tenant.id,installation.skill_id,installation.skill_version,installation.invocation_name,
       installation.status,installation.version_token,installation.installed_at,installation.updated_at
  FROM user_skill_installations installation
  JOIN tenants tenant ON tenant.kind='personal' AND tenant.owner_user_id=installation.user_id;

INSERT INTO tenant_skill_installation_commands(
  tenant_id,idempotency_key,operation,request_digest,result,created_at
)
SELECT tenant.id,command.idempotency_key,command.operation,command.request_digest,
       command.result,command.created_at
  FROM user_skill_installation_commands command
  JOIN tenants tenant ON tenant.kind='personal' AND tenant.owner_user_id=command.user_id;

INSERT INTO tenant_skill_installation_audits(
  tenant_id,event_id,skill_id,operation,before_status,after_status,
  skill_version,invocation_name,version_token,created_at
)
SELECT tenant.id,audit.event_id,audit.skill_id,audit.operation,audit.before_status,
       audit.after_status,audit.skill_version,audit.invocation_name,audit.version_token,audit.created_at
  FROM user_skill_installation_audits audit
  JOIN tenants tenant ON tenant.kind='personal' AND tenant.owner_user_id=audit.user_id;

ALTER TABLE team_member_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_member_directory FORCE ROW LEVEL SECURITY;
CREATE POLICY team_member_directory_read_policy ON team_member_directory
  FOR SELECT
  USING (
    user_id=NULLIF(current_setting('app.user_id',true),'')
    OR (
      team_id=NULLIF(current_setting('app.tenant_id',true),'')
      AND EXISTS (
        SELECT 1 FROM memberships actor
         WHERE actor.tenant_id=team_member_directory.team_id
           AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
           AND actor.status='active'
      )
    )
  );
CREATE POLICY team_member_directory_manage_policy ON team_member_directory
  FOR ALL
  USING (
    team_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_member_directory.team_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    team_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=team_member_directory.team_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  );

ALTER TABLE thread_forks ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_forks FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_forks_tenant_policy ON thread_forks
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));

ALTER TABLE tenant_skill_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_skill_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_skill_installations_read_policy ON tenant_skill_installations
  FOR SELECT USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installations.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active'
    )
  );
CREATE POLICY tenant_skill_installations_manage_policy ON tenant_skill_installations
  FOR ALL USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installations.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  ) WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installations.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  );

ALTER TABLE tenant_skill_installation_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_skill_installation_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_skill_installation_commands_policy ON tenant_skill_installation_commands
  USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installation_commands.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installation_commands.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  );

ALTER TABLE tenant_skill_installation_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_skill_installation_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_skill_installation_audits_policy ON tenant_skill_installation_audits
  USING (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installation_audits.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    tenant_id=NULLIF(current_setting('app.tenant_id',true),'')
    AND EXISTS (
      SELECT 1 FROM memberships actor
       WHERE actor.tenant_id=tenant_skill_installation_audits.tenant_id
         AND actor.user_id=NULLIF(current_setting('app.user_id',true),'')
         AND actor.status='active' AND actor.role IN ('owner','admin')
    )
  );
