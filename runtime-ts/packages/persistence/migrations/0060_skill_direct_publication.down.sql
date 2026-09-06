-- 已直接发布的包没有人工审核事实，不能通过伪造审核者恢复旧约束。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM skill_publication_submissions
    WHERE status IN ('published','revoked') AND reviewed_by IS NULL
  ) THEN
    RAISE EXCEPTION '存在未经人工审核的已发布 Skill，无法无损恢复旧审核约束';
  END IF;
END
$$;

ALTER TABLE skill_publication_submissions
  DROP CONSTRAINT skill_publication_review_shape_check,
  ADD CONSTRAINT skill_publication_review_shape_check CHECK (
    (status IN ('draft','submitted') AND reviewed_by IS NULL AND rejection_reason IS NULL)
    OR (status='rejected' AND reviewed_by IS NOT NULL AND rejection_reason IS NOT NULL)
    OR (status IN ('approved','published','revoked') AND reviewed_by IS NOT NULL AND rejection_reason IS NULL)
  );
