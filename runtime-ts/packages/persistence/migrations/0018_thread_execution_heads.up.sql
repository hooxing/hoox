-- ADR-0063：Thread execution head 是 Run 激活与 writer fencing 的唯一线性化点。
CREATE TABLE thread_execution_heads (
  tenant_id text NOT NULL,
  thread_id text NOT NULL,
  active_run_id text,
  active_turn_id text,
  next_turn_ordinal bigint NOT NULL DEFAULT 1 CHECK (
    next_turn_ordinal BETWEEN 1 AND 9007199254740991
  ),
  next_queue_sequence bigint NOT NULL DEFAULT 1 CHECK (
    next_queue_sequence BETWEEN 1 AND 9007199254740991
  ),
  -- 阶段 1 尚未创建 Thread Context 流；NULL 明确表示“没有可绑定的 Context fact”。
  -- 阶段 2 的 context append 必须在锁定本行时单调推进该 cursor。
  context_through_sequence bigint CHECK (
    context_through_sequence BETWEEN 0 AND 9007199254740991
  ),
  writer_owner text,
  writer_token text,
  writer_epoch bigint NOT NULL DEFAULT 0 CHECK (
    writer_epoch BETWEEN 0 AND 9007199254740991
  ),
  writer_expires_at timestamptz,
  version bigint NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 9007199254740991),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, thread_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES threads(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, active_run_id, thread_id)
    REFERENCES runs(tenant_id, id, thread_id) ON DELETE RESTRICT,
  CONSTRAINT thread_execution_head_writer_shape_check CHECK (
    (
      writer_owner IS NULL AND writer_token IS NULL AND writer_expires_at IS NULL
    ) OR (
      active_run_id IS NOT NULL
      AND octet_length(writer_owner) BETWEEN 1 AND 200
      AND octet_length(writer_token) BETWEEN 1 AND 200
      AND writer_expires_at IS NOT NULL
    )
  ),
  CONSTRAINT thread_execution_head_active_turn_shape_check CHECK (
    active_turn_id IS NULL OR active_run_id IS NOT NULL
  )
);
CREATE UNIQUE INDEX thread_execution_heads_active_run_idx
  ON thread_execution_heads(tenant_id, active_run_id) WHERE active_run_id IS NOT NULL;

-- 只建立空 head，不猜测迁移时既有非终态 Run 的先后关系。V2 新入口启用前必须先通过
-- legacy drain Gate；关闭开关时既有每 Run 路径继续工作。
INSERT INTO thread_execution_heads(tenant_id, thread_id)
SELECT tenant_id, id FROM threads;

ALTER TABLE thread_execution_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_execution_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY thread_execution_heads_tenant_policy ON thread_execution_heads
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
