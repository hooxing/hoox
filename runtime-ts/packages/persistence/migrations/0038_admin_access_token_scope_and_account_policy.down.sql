ALTER TABLE admin_access_token_audits
  DROP CONSTRAINT admin_access_token_audits_result_check;

UPDATE admin_access_token_audits
   SET result=CASE result
     WHEN 'scope_allowed' THEN 'allowed'
     ELSE 'denied'
   END;

ALTER TABLE admin_access_token_audits
  ADD CONSTRAINT admin_access_token_audits_result_check
  CHECK (result IN ('allowed','denied'));

DROP POLICY user_accounts_admin_control_read_policy ON user_accounts;
