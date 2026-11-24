CREATE POLICY skill_namespace_publishers_runtime_session_read_policy
  ON skill_namespace_publishers FOR SELECT
  USING (user_id=NULLIF(current_setting('app.user_id',true),''));
