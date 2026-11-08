-- 新版创建的账号没有 issuer；禁止伪造历史来源或删除账号来完成降级。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM better_auth_accounts WHERE issuer IS NULL) OR EXISTS (
    SELECT 1 FROM better_auth_accounts
    GROUP BY issuer,account_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Better Auth 已存在不兼容旧 issuer 键的账号，禁止自动回退';
  END IF;
END $$;

ALTER TABLE better_auth_accounts ALTER COLUMN issuer SET NOT NULL;
ALTER TABLE better_auth_accounts
  ADD CONSTRAINT better_auth_accounts_issuer_account_id_key UNIQUE (issuer,account_id);
ALTER TABLE better_auth_accounts DROP CONSTRAINT better_auth_accounts_provider_id_account_id_key;
