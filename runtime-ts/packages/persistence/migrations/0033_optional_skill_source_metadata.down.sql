DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM skill_publication_submissions
    WHERE source_url='' OR source_revision=''
  ) THEN
    RAISE EXCEPTION '存在未声明上游来源的 Skill 发布事实，拒绝收紧来源约束';
  END IF;
END
$$;

ALTER TABLE skill_publication_submissions
  DROP CONSTRAINT skill_publication_submissions_source_url_check,
  ADD CONSTRAINT skill_publication_submissions_source_url_check
    CHECK (octet_length(source_url) BETWEEN 1 AND 2048),
  DROP CONSTRAINT skill_publication_submissions_source_revision_check,
  ADD CONSTRAINT skill_publication_submissions_source_revision_check CHECK (
    octet_length(source_revision) BETWEEN 1 AND 200
    AND source_revision=btrim(source_revision)
    AND source_revision !~ '[[:cntrl:]]'
  );
