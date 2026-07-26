ALTER TABLE memberships
  ADD COLUMN lock_marker boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT memberships_lock_marker_constant CHECK (lock_marker = false);
