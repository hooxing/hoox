DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM better_auth_users)
     OR EXISTS (SELECT 1 FROM identity_auth_configuration)
     OR EXISTS (SELECT 1 FROM identity_auth_commands)
     OR EXISTS (SELECT 1 FROM identity_auth_audits)
     OR EXISTS (SELECT 1 FROM user_accounts WHERE better_auth_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Better Auth 已存在身份或配置数据，禁止破坏性回退';
  END IF;
END $$;

DROP TABLE identity_auth_commands;
DROP TABLE identity_auth_audits;
DROP TABLE identity_auth_configuration;
DROP TABLE better_auth_rate_limits;
DROP TABLE better_auth_verifications;
DROP TABLE better_auth_accounts;
DROP TABLE better_auth_sessions;
DROP TABLE better_auth_users;
DROP POLICY user_accounts_authentication_policy ON user_accounts;
ALTER TABLE user_accounts
  DROP CONSTRAINT user_accounts_password_shape,
  DROP COLUMN better_auth_user_id,
  ALTER COLUMN password_algorithm SET NOT NULL,
  ALTER COLUMN password_salt SET NOT NULL,
  ALTER COLUMN password_hash SET NOT NULL;
CREATE POLICY user_accounts_authentication_policy ON user_accounts
  USING (
    normalized_email = NULLIF(current_setting('app.auth_email', true), '')
    OR user_id = NULLIF(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    user_id = NULLIF(current_setting('app.user_id', true), '')
    AND personal_tenant_id = NULLIF(current_setting('app.tenant_id', true), '')
  );
