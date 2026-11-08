-- Better Auth 1.7.3 起按 Provider 与账号标识定位身份，旧 issuer 保留为历史数据。
-- 相同账号键不能被自动合并；冲突时整批迁移回滚，且错误不暴露身份值。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM better_auth_accounts
    GROUP BY provider_id,account_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Better Auth Provider 账号键冲突，禁止自动合并身份';
  END IF;
END $$;

ALTER TABLE better_auth_accounts ALTER COLUMN issuer DROP NOT NULL;
ALTER TABLE better_auth_accounts DROP CONSTRAINT better_auth_accounts_issuer_account_id_key;
ALTER TABLE better_auth_accounts
  ADD CONSTRAINT better_auth_accounts_provider_id_account_id_key UNIQUE (provider_id,account_id);
