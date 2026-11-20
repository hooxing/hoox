-- AgentDefinition 仅由平台管理；Thread 绑定列对 Runtime 仅授予 INSERT/SELECT，不授予 UPDATE。

CREATE TABLE agent_definitions (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'),
  status text NOT NULL CHECK (status IN ('draft','published','disabled','revoked')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 9007199254740991),
  availability_mode text NOT NULL CHECK (availability_mode IN ('all_tenants','selected_tenants')),
  is_builtin boolean NOT NULL DEFAULT false,
  current_revision_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='draft' AND current_revision_id IS NULL) OR status<>'draft'),
  CHECK (id <> 'agent_default' OR is_builtin)
);
CREATE UNIQUE INDEX agent_definitions_single_builtin_idx ON agent_definitions(is_builtin) WHERE is_builtin;

CREATE TABLE agent_definition_tenants (
  definition_id text NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  available boolean NOT NULL DEFAULT false,
  PRIMARY KEY (definition_id,tenant_id)
);

CREATE TABLE agent_revisions (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$'),
  definition_id text NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  status text NOT NULL CHECK (status IN ('draft','published','revoked')),
  content jsonb NOT NULL CHECK (jsonb_typeof(content)='object' AND octet_length(content::text) BETWEEN 2 AND 131072),
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (definition_id,revision),
  UNIQUE (definition_id,id)
);
ALTER TABLE agent_definitions ADD CONSTRAINT agent_definitions_current_revision_fk
  FOREIGN KEY (id,current_revision_id) REFERENCES agent_revisions(definition_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX agent_revisions_definition_idx ON agent_revisions(definition_id,revision DESC);
CREATE INDEX agent_definition_tenants_tenant_idx ON agent_definition_tenants(tenant_id,definition_id);

CREATE TABLE agent_definition_commands (
  idempotency_key text PRIMARY KEY CHECK (octet_length(idempotency_key) BETWEEN 1 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE agent_definition_audits (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  definition_id text NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
  revision_id text,
  action text NOT NULL CHECK (action IN ('created','published','disabled','revoked')),
  generation bigint NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (definition_id,revision_id) REFERENCES agent_revisions(definition_id,id) ON DELETE RESTRICT
);
CREATE INDEX agent_definition_audits_definition_idx ON agent_definition_audits(definition_id,audit_id DESC);

-- 默认 Agent 指令与 Prompt Builder 的 DEFAULT_AGENT_OPERATOR_INSTRUCTIONS 保持等价。
INSERT INTO agent_definitions(id,status,generation,availability_mode,is_builtin)
VALUES ('agent_default','published',1,'all_tenants',true);
INSERT INTO agent_revisions(id,definition_id,revision,status,content,content_digest,created_by)
VALUES ('agent_default_revision_1','agent_default',1,'published',
  '{"displayName":"Hoox 默认助手","description":"Hoox 默认 Agent","suggestedQuestions":[],"operatorInstructions":"你是 Hoox，由 Hoox 平台托管的受控 Agent。\n使用中文进行回答，除非用户明确要求使用其他语言。","replyLanguage":"zh-CN","model":{"mode":"platform_default"},"skillVersions":[],"includeTenantSkills":true,"sandboxIdleAction":"pause","longTermMemoryEnabled":false,"tools":{"mode":"platform_default"}}'::jsonb,
  '2797a0554a1733f1c0f48634fd0908b5e2e13bc66e480e15c61b21732547f302','system');
UPDATE agent_definitions SET current_revision_id='agent_default_revision_1' WHERE id='agent_default';
-- 先执行延迟的当前 Revision 外键检查，避免后续 ALTER TABLE 遇到待处理触发器事件。
SET CONSTRAINTS agent_definitions_current_revision_fk IMMEDIATE;
ALTER TABLE threads ADD COLUMN agent_definition_id text NOT NULL DEFAULT 'agent_default';
ALTER TABLE threads ADD CONSTRAINT threads_agent_definition_fk FOREIGN KEY(agent_definition_id) REFERENCES agent_definitions(id) ON DELETE RESTRICT;
CREATE INDEX threads_agent_definition_idx ON threads(agent_definition_id,tenant_id);
-- Revision 正文和身份列只允许 INSERT/SELECT；撤销是独立追加事实，避免修改已发布 Revision。
CREATE TABLE agent_revision_revocations (
  revision_id text PRIMARY KEY REFERENCES agent_revisions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE agent_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_definition_audits FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_definitions_runtime_read ON agent_definitions TO PUBLIC
  USING (status='published' AND (availability_mode='all_tenants' OR EXISTS(
    SELECT 1 FROM agent_definition_tenants scope WHERE scope.definition_id=id AND scope.tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND scope.available)))
  WITH CHECK (false);
CREATE POLICY agent_definitions_admin_manage ON agent_definitions TO PUBLIC
  USING (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')));
CREATE POLICY agent_definition_tenants_policy ON agent_definition_tenants TO PUBLIC
  USING ((tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND available) OR EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')));
CREATE POLICY agent_revisions_runtime_read ON agent_revisions TO PUBLIC
  USING (status='published' AND EXISTS (SELECT 1 FROM agent_definitions d WHERE d.id=definition_id AND d.status='published' AND (d.availability_mode='all_tenants' OR EXISTS (SELECT 1 FROM agent_definition_tenants s WHERE s.definition_id=d.id AND s.tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND s.available))))
  WITH CHECK (false);
CREATE POLICY agent_revisions_admin_manage ON agent_revisions TO PUBLIC
  USING (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')));
CREATE POLICY agent_commands_admin ON agent_definition_commands TO PUBLIC
  USING (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')));
CREATE POLICY agent_audits_admin ON agent_definition_audits TO PUBLIC
  USING (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')));

ALTER TABLE agent_revision_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_revision_revocations FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_revision_revocations_read ON agent_revision_revocations FOR SELECT
  USING (EXISTS (SELECT 1 FROM agent_revisions r JOIN agent_definitions d ON d.id=r.definition_id WHERE r.id=revision_id AND (d.availability_mode='all_tenants' OR EXISTS (SELECT 1 FROM agent_definition_tenants s WHERE s.definition_id=d.id AND s.tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND s.available)))) ;
CREATE POLICY agent_revision_revocations_admin ON agent_revision_revocations FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM platform_control_operators o WHERE o.user_id=NULLIF(current_setting('app.user_id',true),'') AND o.status='active' AND o.role IN ('operator','admin')));

DROP POLICY threads_isolation_policy ON threads;
CREATE POLICY threads_read_policy ON threads FOR SELECT
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
CREATE POLICY threads_insert_policy ON threads FOR INSERT
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND EXISTS (
    SELECT 1 FROM agent_definitions d WHERE d.id=agent_definition_id AND d.status='published'
      AND (d.availability_mode='all_tenants' OR EXISTS (
        SELECT 1 FROM agent_definition_tenants scope WHERE scope.definition_id=d.id
          AND scope.tenant_id=NULLIF(current_setting('app.tenant_id',true),'') AND scope.available))
  ));
CREATE POLICY threads_update_policy ON threads FOR UPDATE
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
