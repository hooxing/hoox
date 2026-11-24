DO $$
DECLARE
  runtime text := current_setting('app.runtime_role');
  evaluation text;
  target record;
BEGIN
  evaluation := CASE WHEN length(runtime)<=52 THEN runtime
    ELSE left(runtime,43)||'_'||left(md5(runtime),8) END || '_evaluation';
  FOR target IN SELECT tablename,policyname FROM pg_policies
    WHERE schemaname=current_schema() AND policyname IN (
      'evaluation_thread_read','evaluation_thread_create','evaluation_thread_guard',
      'evaluation_run_read','evaluation_run_create','evaluation_run_guard',
      'evaluation_revision_read','evaluation_definition_read','evaluation_snapshot_create')
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I TO %I',target.policyname,target.tablename,evaluation);
  END LOOP;
  EXECUTE format('CREATE POLICY normal_thread_source ON threads AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (NOT is_evaluation)',runtime);
  EXECUTE format('CREATE POLICY normal_run_source ON runs AS RESTRICTIVE FOR INSERT TO %I WITH CHECK (origin<>''evaluation'')',runtime);
END $$;
