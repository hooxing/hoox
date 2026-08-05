ALTER TABLE skill_publication_submissions
  DROP CONSTRAINT skill_publication_submissions_source_url_check,
  ADD CONSTRAINT skill_publication_submissions_source_url_check
    CHECK (octet_length(source_url) BETWEEN 0 AND 2048),
  DROP CONSTRAINT skill_publication_submissions_source_revision_check,
  ADD CONSTRAINT skill_publication_submissions_source_revision_check CHECK (
    octet_length(source_revision) BETWEEN 0 AND 200
    AND source_revision=btrim(source_revision)
    AND source_revision !~ '[[:cntrl:]]'
  );
