-- ADR-20260817181138：对话定时任务、不可变修订与动态 Tenant 唤醒。
CREATE TABLE scheduled_tasks (
  tenant_id text NOT NULL,
  id text NOT NULL,
  owner_user_id text NOT NULL,
  source_thread_id text NOT NULL,
  target_thread_id text NOT NULL,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 480),
  instruction text NOT NULL CHECK (octet_length(instruction) BETWEEN 1 AND 16384),
  timezone text NOT NULL CHECK (octet_length(timezone) BETWEEN 1 AND 100),
  rrule text CHECK (rrule IS NULL OR octet_length(rrule) BETWEEN 1 AND 300),
  status text NOT NULL CHECK (status IN ('active','paused','completed','deleted')),
  overlap_policy text NOT NULL CHECK (overlap_policy IN ('coalesce','skip')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  current_revision integer NOT NULL CHECK (current_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,owner_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,target_thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT scheduled_tasks_next_run_shape CHECK (
    (status='active' AND next_run_at IS NOT NULL)
    OR (status IN ('paused','completed','deleted'))
  )
);
CREATE INDEX scheduled_tasks_due_idx
  ON scheduled_tasks(tenant_id,next_run_at,id)
  WHERE status='active';
CREATE INDEX scheduled_tasks_owner_idx
  ON scheduled_tasks(tenant_id,owner_user_id,updated_at DESC,id);

CREATE TABLE scheduled_task_revisions (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 480),
  instruction text NOT NULL CHECK (octet_length(instruction) BETWEEN 1 AND 16384),
  timezone text NOT NULL CHECK (octet_length(timezone) BETWEEN 1 AND 100),
  rrule text CHECK (rrule IS NULL OR octet_length(rrule) BETWEEN 1 AND 300),
  first_run_at timestamptz NOT NULL,
  overlap_policy text NOT NULL CHECK (overlap_policy IN ('coalesce','skip')),
  created_by_run_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,task_id,revision),
  FOREIGN KEY (tenant_id,task_id) REFERENCES scheduled_tasks(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,created_by_run_id) REFERENCES runs(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE scheduled_task_occurrences (
  tenant_id text NOT NULL,
  id text NOT NULL,
  task_id text NOT NULL,
  task_revision integer NOT NULL,
  scheduled_for timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatching','enqueued','skipped','failed')),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  run_id text,
  receipt_id text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,task_id,scheduled_for),
  FOREIGN KEY (tenant_id,task_id,task_revision)
    REFERENCES scheduled_task_revisions(tenant_id,task_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id) REFERENCES runs(tenant_id,id) ON DELETE RESTRICT
);
CREATE INDEX scheduled_task_occurrences_dispatch_idx
  ON scheduled_task_occurrences(tenant_id,state,next_attempt_at,created_at)
  WHERE state IN ('dispatching','failed');

CREATE TABLE scheduled_task_commands (
  tenant_id text NOT NULL,
  actor_user_id text NOT NULL,
  command_id text NOT NULL CHECK (octet_length(command_id) BETWEEN 1 AND 300),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  task_id text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,actor_user_id,command_id),
  FOREIGN KEY (tenant_id,actor_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,task_id) REFERENCES scheduled_tasks(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_tasks_tenant_policy ON scheduled_tasks
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
ALTER TABLE scheduled_task_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_revisions_tenant_policy ON scheduled_task_revisions
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
ALTER TABLE scheduled_task_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_occurrences_tenant_policy ON scheduled_task_occurrences
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
ALTER TABLE scheduled_task_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_task_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY scheduled_task_commands_tenant_policy ON scheduled_task_commands
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
