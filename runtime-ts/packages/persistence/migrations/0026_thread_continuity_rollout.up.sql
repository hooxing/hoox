-- ADR-0070 / 阶段 6：旧 Thread 证据式 anchor、新 Thread 灰度档案与低基数指标。
ALTER TABLE thread_context_entries
  DROP CONSTRAINT thread_context_entries_kind_check,
  ADD CONSTRAINT thread_context_entries_kind_check CHECK (kind IN (
    'run_started','user_message','assistant_message','tool_call','tool_result',
    'workspace_committed','workspace_unchanged','run_terminal','compaction_checkpoint',
    'legacy_history_gap','legacy_v2_anchor'
  ));

CREATE TABLE tenant_thread_continuity_policies (
  tenant_id text NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version BETWEEN 1 AND 9007199254740991),
  v2_read_enabled boolean NOT NULL DEFAULT false,
  new_thread_rollout_basis_points integer NOT NULL DEFAULT 0 CHECK (
    new_thread_rollout_basis_points BETWEEN 0 AND 10000
  ),
  legacy_anchor_read_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);

CREATE TABLE thread_context_legacy_anchors (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  anchor_id text NOT NULL CHECK (octet_length(anchor_id) BETWEEN 8 AND 200),
  operation_id text NOT NULL CHECK (octet_length(operation_id) BETWEEN 8 AND 512),
  max_runs integer NOT NULL CHECK (max_runs BETWEEN 1 AND 10000),
  total_terminal_runs integer NOT NULL CHECK (total_terminal_runs >= 0),
  selected_runs integer NOT NULL CHECK (selected_runs BETWEEN 0 AND max_runs),
  backfilled_entries integer NOT NULL CHECK (backfilled_entries >= 0),
  gap_items integer NOT NULL CHECK (gap_items >= 0),
  first_context_sequence bigint NOT NULL CHECK (
    first_context_sequence BETWEEN 1 AND 9007199254740991
  ),
  anchor_context_sequence bigint NOT NULL CHECK (
    anchor_context_sequence BETWEEN first_context_sequence AND 9007199254740991
  ),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  gap_reasons jsonb NOT NULL CHECK (
    jsonb_typeof(gap_reasons)='array' AND octet_length(gap_reasons::text) <= 16384
  ),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id),
  UNIQUE (tenant_id,anchor_id),
  UNIQUE (tenant_id,operation_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,first_context_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,anchor_context_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT
);

CREATE TABLE thread_context_legacy_backfill_items (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  anchor_id text NOT NULL,
  item_ordinal integer NOT NULL CHECK (item_ordinal BETWEEN 0 AND 50000),
  source_run_id text,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'user_input','workspace_result','run_terminal','assistant_tool_history',
    'earlier_run_range','existing_v2_stream'
  )),
  outcome text NOT NULL CHECK (outcome IN ('backfilled','already_present','gap')),
  context_sequence bigint,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  reason_code text CHECK (
    reason_code IS NULL OR reason_code IN (
      'source_missing','not_provable','max_depth_exceeded','cannot_prepend_existing_stream'
    )
  ),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,anchor_id,item_ordinal),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,anchor_id)
    REFERENCES thread_context_legacy_anchors(tenant_id,anchor_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,source_run_id,thread_id)
    REFERENCES runs(tenant_id,id,thread_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,thread_id,context_sequence)
    REFERENCES thread_context_entries(tenant_id,thread_id,sequence) ON DELETE RESTRICT,
  CONSTRAINT thread_context_legacy_backfill_item_shape_check CHECK (
    (outcome='gap' AND context_sequence IS NULL AND reason_code IS NOT NULL)
    OR (outcome IN ('backfilled','already_present') AND context_sequence IS NOT NULL
      AND reason_code IS NULL)
  )
);

CREATE TABLE thread_continuity_profiles (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  rollout_source text NOT NULL CHECK (rollout_source IN ('new_thread','legacy_anchor','manual')),
  cohort_bucket integer NOT NULL CHECK (cohort_bucket BETWEEN 0 AND 9999),
  rollout_selected boolean NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version BETWEEN 0 AND 9007199254740991),
  anchor_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,thread_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,anchor_id)
    REFERENCES thread_context_legacy_anchors(tenant_id,anchor_id) ON DELETE RESTRICT,
  CONSTRAINT thread_continuity_profile_anchor_shape_check CHECK (
    (rollout_source='legacy_anchor' AND anchor_id IS NOT NULL AND rollout_selected)
    OR (rollout_source<>'legacy_anchor' AND anchor_id IS NULL)
  )
);

CREATE TABLE thread_continuity_metric_observations (
  tenant_id text NOT NULL,
  observation_id text NOT NULL CHECK (octet_length(observation_id) BETWEEN 8 AND 512),
  thread_id text NOT NULL,
  run_id text,
  metric_name text NOT NULL CHECK (metric_name IN (
    'thread_input_total','steer_apply_latency_ms','steer_to_follow_up_total',
    'follow_up_queue_depth','follow_up_wait_ms','thread_writer_conflict_total',
    'context_rebuild_latency_ms','context_visible_tokens','context_tokens_before_compaction',
    'context_tokens_after_compaction','compaction_latency_ms','compaction_total',
    'context_recovery_digest_mismatch_total','context_window_number',
    'sandbox_handoff_total','sandbox_resume_total','sandbox_resume_latency_ms',
    'sandbox_create_latency_ms','workspace_materialize_latency_ms','sandbox_paused_seconds',
    'sandbox_snapshot_bytes','sandbox_cold_rebuild_total','sandbox_unknown_total',
    'sandbox_revision_mismatch_total','sandbox_idle_running_seconds'
  )),
  value double precision NOT NULL CHECK (value BETWEEN 0 AND 1e308),
  unit text NOT NULL CHECK (unit IN ('count','milliseconds','seconds','tokens','items','bytes')),
  path text CHECK (path IS NULL OR path IN ('local','remote','resume','cold','handoff')),
  outcome text CHECK (outcome IS NULL OR octet_length(outcome) BETWEEN 1 AND 64),
  reason text CHECK (reason IS NULL OR octet_length(reason) BETWEEN 1 AND 64),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,observation_id),
  FOREIGN KEY (tenant_id,thread_id) REFERENCES threads(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,run_id,thread_id) REFERENCES runs(tenant_id,id,thread_id) ON DELETE RESTRICT
);
CREATE INDEX thread_continuity_metrics_query_idx
  ON thread_continuity_metric_observations(tenant_id,metric_name,observed_at DESC);

ALTER TABLE tenant_thread_continuity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_thread_continuity_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_thread_continuity_policies_tenant_policy
  ON tenant_thread_continuity_policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_legacy_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_legacy_anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_legacy_anchors_tenant_policy ON thread_context_legacy_anchors
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_context_legacy_backfill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_context_legacy_backfill_items FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_context_legacy_backfill_items_tenant_policy
  ON thread_context_legacy_backfill_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_continuity_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_continuity_profiles_tenant_policy ON thread_continuity_profiles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));

ALTER TABLE thread_continuity_metric_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_continuity_metric_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_continuity_metric_observations_tenant_policy
  ON thread_continuity_metric_observations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
