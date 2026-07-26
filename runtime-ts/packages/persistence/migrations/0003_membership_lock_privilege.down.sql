ALTER TABLE memberships
  DROP CONSTRAINT IF EXISTS memberships_lock_marker_constant,
  DROP COLUMN IF EXISTS lock_marker;
