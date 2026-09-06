ALTER TABLE skill_publication_submissions
  DROP CONSTRAINT skill_publication_review_shape_check,
  ADD CONSTRAINT skill_publication_review_shape_check CHECK (
    (status IN ('draft','submitted') AND reviewed_by IS NULL AND rejection_reason IS NULL)
    OR (status='rejected' AND reviewed_by IS NOT NULL AND rejection_reason IS NOT NULL)
    OR (status='approved' AND reviewed_by IS NOT NULL AND rejection_reason IS NULL)
    OR (status IN ('published','revoked') AND rejection_reason IS NULL)
  );
