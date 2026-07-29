DROP TABLE IF EXISTS workspace_revision_candidate_files;
DROP TABLE IF EXISTS workspace_revision_candidates;

-- released 是不可逆的“引用已交接/释放”事实。FORCE RLS 下迁移不能越权逐租户改写它，
-- 更不能恢复成会阻止 GC 的 stable；回退仅停用 candidate 表，保留 lifecycle 安全语义。
