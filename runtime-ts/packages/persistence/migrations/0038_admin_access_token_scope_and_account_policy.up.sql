ALTER TABLE admin_access_token_audits
  DROP CONSTRAINT admin_access_token_audits_result_check;

UPDATE admin_access_token_audits
   SET result=CASE result
     WHEN 'allowed' THEN 'scope_allowed'
     ELSE 'scope_denied'
   END;

ALTER TABLE admin_access_token_audits
  ADD CONSTRAINT admin_access_token_audits_result_check
  CHECK (result IN ('scope_allowed','scope_denied','credential_rejected'));

DO $$
DECLARE
  control_role text := current_setting('app.admin_control_role');
BEGIN
  EXECUTE format(
    'CREATE POLICY user_accounts_admin_control_read_policy ON user_accounts FOR SELECT TO %I USING (EXISTS (SELECT 1 FROM platform_control_operators actor WHERE actor.user_id=NULLIF(current_setting(''app.user_id'',true),'''') AND actor.status=''active'' AND actor.role=''admin''))',
    control_role
  );
END $$;
