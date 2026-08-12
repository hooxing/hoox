ALTER TABLE memory_ingestion_outbox NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM memory_ingestion_outbox) THEN
    RAISE EXCEPTION 'memory ingestion outbox down requires an empty table';
  END IF;
END
$$;

DROP TABLE memory_ingestion_outbox;
