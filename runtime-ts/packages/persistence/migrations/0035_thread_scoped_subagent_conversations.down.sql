DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM runtime_subagent_conversations LIMIT 1) THEN
    RAISE EXCEPTION '存在可复用 SubAgent 对话，不能无损回退 0035';
  END IF;
END $$;

DROP TABLE runtime_subagent_conversations;
