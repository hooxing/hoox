-- 已签发凭据与集成身份不能由结构回退静默销毁。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM api_keys) OR EXISTS (SELECT 1 FROM app_users WHERE kind = 'integration') THEN
    RAISE EXCEPTION 'API Key 或集成身份仍存在，拒绝破坏性回退';
  END IF;
END
$$;
DROP TABLE api_keys;
ALTER TABLE app_users DROP COLUMN kind;
