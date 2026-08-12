DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_personalization_settings)
     OR EXISTS (SELECT 1 FROM team_personalization_settings) THEN
    RAISE EXCEPTION '个性化设置非空，拒绝破坏性回滚';
  END IF;
END
$$;

DROP TABLE team_personalization_settings;
DROP TABLE user_personalization_settings;
