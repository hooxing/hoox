ALTER TABLE run_skill_snapshot_items
  ADD COLUMN source text NOT NULL DEFAULT 'tenant'
  CHECK (source IN ('agent', 'tenant'));
