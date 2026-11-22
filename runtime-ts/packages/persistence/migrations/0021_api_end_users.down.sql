DROP VIEW admin_user_directory;
ALTER TABLE admin_user_account_audits
  DROP CONSTRAINT admin_user_account_audits_target_user_id_fkey;
ALTER TABLE admin_user_account_audits
  ADD CONSTRAINT admin_user_account_audits_target_user_id_fkey
  FOREIGN KEY (target_user_id) REFERENCES user_accounts(user_id) ON DELETE RESTRICT;
CREATE VIEW admin_user_directory WITH (security_barrier=true) AS
SELECT account.user_id,account.email,account.display_name,account.status,account.created_at,
  GREATEST(conversation.last_active_at,session.last_active_at) AS last_active_at,
  COALESCE(session.active_sessions,0)::bigint AS active_sessions,
  COALESCE(conversation.conversation_count,0)::bigint AS conversation_count,
  COALESCE(conversation.run_count,0)::bigint AS run_count
FROM user_accounts account
LEFT JOIN LATERAL (
  SELECT max(thread.updated_at) AS last_active_at,
    count(DISTINCT (thread.tenant_id,thread.id))::bigint AS conversation_count,
    count(DISTINCT (run.tenant_id,run.id))::bigint AS run_count
  FROM threads thread LEFT JOIN runs run ON run.tenant_id=thread.tenant_id AND run.thread_id=thread.id
  WHERE thread.created_by_user_id=account.user_id
    AND NOT thread.is_playground
) conversation ON true
LEFT JOIN LATERAL (
  SELECT max(candidate.created_at) AS last_active_at,
    count(*) FILTER (WHERE candidate.expires_at>clock_timestamp())::bigint AS active_sessions
  FROM user_sessions candidate WHERE candidate.user_id=account.user_id
) session ON true
WHERE EXISTS (SELECT 1 FROM platform_control_operators actor
  WHERE actor.user_id=NULLIF(current_setting('app.user_id',true),'') AND actor.status='active' AND actor.role='admin');
DROP TABLE api_end_users;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (
  cardinality(scopes)>0 AND scopes <@ ARRAY['threads:read','runs:read','threads:create','runs:create','tool-results:submit','webhooks:manage']::text[]
);
