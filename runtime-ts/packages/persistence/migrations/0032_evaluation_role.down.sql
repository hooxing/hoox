DROP POLICY normal_thread_source ON threads;
DROP POLICY normal_run_source ON runs;
DO $$
DECLARE target record;
BEGIN
  FOR target IN SELECT tablename,policyname FROM pg_policies
    WHERE schemaname=current_schema() AND policyname IN (
      'evaluation_thread_read','evaluation_thread_create','evaluation_thread_guard',
      'evaluation_run_read','evaluation_run_create','evaluation_run_guard',
      'evaluation_revision_read','evaluation_definition_read','evaluation_snapshot_create')
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I TO %I',target.policyname,target.tablename,current_setting('app.runtime_role'));
  END LOOP;
END $$;
