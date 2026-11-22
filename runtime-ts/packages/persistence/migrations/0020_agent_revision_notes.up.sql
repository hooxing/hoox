ALTER TABLE agent_revisions ADD COLUMN version_notes text
  CHECK (char_length(version_notes) <= 2000);
