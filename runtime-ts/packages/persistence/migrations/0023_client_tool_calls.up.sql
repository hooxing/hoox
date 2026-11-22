CREATE TABLE client_tool_calls (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  thread_id text NOT NULL,
  attempt_id text NOT NULL,
  call_id text NOT NULL CHECK (octet_length(call_id) BETWEEN 1 AND 200),
  tool_name text NOT NULL CHECK (octet_length(tool_name) BETWEEN 1 AND 128),
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments)='object' AND octet_length(arguments::text)<=65536),
  deadline timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('succeeded','failed','timeout')),
  result_digest text CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  response_text text CHECK (octet_length(response_text)<=8192),
  truncated boolean,
  PRIMARY KEY (tenant_id,run_id,call_id),
  FOREIGN KEY (tenant_id,attempt_id,run_id,thread_id)
    REFERENCES execution_attempts(tenant_id,attempt_id,run_id,thread_id),
  FOREIGN KEY (tenant_id,attempt_id,call_id,tool_name) REFERENCES effect_invocations(tenant_id,attempt_id,call_id,tool_name),
  CHECK ((outcome IS NULL OR outcome='timeout') = (result_digest IS NULL)),
  CHECK ((result_digest IS NULL) = (response_text IS NULL)),
  CHECK ((result_digest IS NULL) = (truncated IS NULL))
);
CREATE INDEX client_tool_deadlines ON client_tool_calls(tenant_id,deadline,run_id) WHERE outcome IS NULL;
ALTER TABLE client_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY client_tools_tenant ON client_tool_calls
  USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),''))
  WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),''));
