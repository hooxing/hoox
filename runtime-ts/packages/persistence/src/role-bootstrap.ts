import type { Pool, PoolClient } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import { assertSafeSchemaName, withTransaction } from "./postgres.js";

const rolePattern = /^[a-z_][a-z0-9_]{0,62}$/;
const tablePrivileges = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;
const sequencePrivileges = ["USAGE", "SELECT", "UPDATE"] as const;
const migrationTable = "runtime_schema_migrations";
const runWorkerTables = new Set([
  "run_execution_inputs",
  "execution_attempts",
  "execution_workspace_fences",
  "run_claims",
  "rollout_projections",
  "run_events",
  "sandbox_registry",
  "cleanup_outbox",
  "sandbox_lifecycle_unknown",
  "runtime_alert_outbox",
  "effect_invocations",
  "external_effect_permits",
  "mutation_receipts",
]);
const runDispatchTables = new Set(["api_idempotency_records", "run_dispatch_outbox"]);
const workerTenantAssignmentTables = new Set(["worker_tenant_assignments"]);
const threadCreationTables = new Set(["api_thread_idempotency_records"]);
const threadHeadTables = new Set(["thread_execution_heads"]);
const threadInputQueueTables = new Set(["thread_input_receipts", "thread_follow_up_queue"]);
const threadInputRoutingTables = new Set(["thread_input_receipt_events"]);
const historyFilesystemTables = new Set([
  "thread_history_directories",
  "thread_history_file_entries",
]);
const threadTitleGenerationTables = new Set(["thread_title_generation_outbox"]);
const memoryIngestionTables = new Set(["memory_ingestion_outbox"]);
const runWorkspaceResultTables = new Set(["run_workspace_results"]);
const threadContextTables = new Set([
  "thread_context_streams",
  "thread_context_entries",
  "thread_context_append_commands",
]);
const threadContextCompactionTables = new Set([
  "thread_context_compaction_checkpoints",
  "thread_context_compaction_replacement_items",
]);
const threadContextAuditTables = new Set(["thread_context_history_audits"]);
const threadSandboxSessionTables = new Set([
  "thread_sandbox_sessions",
  "thread_sandbox_leases",
  "sandbox_lifecycle_effects",
]);
const threadContinuityRolloutTables = new Set([
  "tenant_thread_continuity_policies",
  "thread_context_legacy_anchors",
  "thread_context_legacy_backfill_items",
  "thread_continuity_profiles",
  "thread_continuity_metric_observations",
]);
const resourceLibraryTables = new Set([
  "resources",
  "resource_versions",
  "resource_promotion_authorizations",
  "resource_promotion_idempotency",
]);
const artifactDeliveryTables = new Set([
  "artifact_deliverable_commands",
  "artifact_deliverable_declarations",
  "artifact_publications",
  "artifact_publication_settlements",
  "artifact_publication_commands",
]);
const runtimeRolloutTables = new Set([
  "runtime_rollout_streams",
  "runtime_rollout_entries",
  "runtime_rollout_append_commands",
  "runtime_rollout_replacements",
  "runtime_rollout_checkpoints",
  "runtime_rollout_checkpoint_commands",
]);
const runtimePtcDispatchTables = new Set(["runtime_ptc_dispatches"]);
const runtimeAgentControlTables = new Set([
  "runtime_agent_threads",
  "runtime_agent_turns",
  "runtime_agent_mailbox_messages",
  "runtime_agent_commands",
]);
const runtimeSubagentConversationTables = new Set(["runtime_subagent_conversations"]);
const waitingRecoveryTables = new Set([
  "waiting_recovery_checkpoints",
  "waiting_recovery_effect_outbox",
]);
const workspaceRuntimeTables = new Set(["runtime_recovery_metrics"]);
const workspaceManifestTables = new Set([
  "workspace_revision_manifests",
  "workspace_revision_files",
  "workspace_operation_journal",
]);
const workspaceCandidateTables = new Set([
  "workspace_revision_candidates",
  "workspace_revision_candidate_files",
]);
const workspaceArtifactIntentTables = new Set(["workspace_artifact_publication_intents"]);
const modelWireTraceTables = new Set([
  "model_wire_trace_cleanup_commands",
  "model_wire_trace_cleanup_items",
  "model_wire_trace_expiry_tombstones",
  "model_wire_trace_records",
]);
const skillCenterTables = new Set([
  "skills",
  "skill_versions",
  "skill_version_files",
  "user_skill_installations",
  "user_skill_installation_commands",
  "user_skill_installation_audits",
]);
const legacySkillInstallationTables = new Set([
  "user_skill_installations",
  "user_skill_installation_commands",
  "user_skill_installation_audits",
]);
const skillRuntimeTables = new Set([
  "run_skill_snapshots",
  "run_skill_snapshot_items",
  "skill_invocations",
]);
const teamCollaborationTables = new Set([
  "team_member_directory",
  "thread_forks",
  "tenant_skill_installations",
  "tenant_skill_installation_commands",
  "tenant_skill_installation_audits",
]);
const personalizationSettingsTables = new Set([
  "user_personalization_settings",
  "team_personalization_settings",
]);
const localAccountTables = new Set(["user_accounts", "user_sessions"]);
const embeddedIdentityTables = new Set([
  "better_auth_users",
  "better_auth_sessions",
  "better_auth_accounts",
  "better_auth_verifications",
  "better_auth_rate_limits",
  "identity_auth_configuration",
  "identity_auth_audits",
  "identity_auth_commands",
]);
const scheduledTaskTables = new Set([
  "scheduled_tasks",
  "scheduled_task_revisions",
  "scheduled_task_occurrences",
  "scheduled_task_commands",
]);
const skillPublicationTables = new Set([
  "platform_skill_operators",
  "skill_publication_submissions",
  "skill_publication_files",
  "skill_publication_commands",
  "skill_publication_audits",
]);
const adminControlTables = new Set([
  "platform_control_operators",
  "admin_control_config_revisions",
  "admin_control_provider_probes",
  "admin_control_active_configs",
  "admin_control_activation_events",
  "admin_control_commands",
  "admin_control_audits",
  "admin_control_generation",
  "admin_user_account_audits",
  "run_runtime_config_snapshots",
  "external_tool_versions",
  "external_tool_credentials",
  "external_tool_revocations",
  "agent_definitions",
  "agent_definition_tenants",
  "agent_revisions",
  "agent_revision_revocations",
  "agent_definition_commands",
  "agent_definition_audits",
  "admin_run_content_access_audits",
]);

const runtimeTablePolicy = new Map<string, ReadonlySet<string>>([
  ["app_users", new Set(["SELECT", "INSERT"])],
  ["api_keys", new Set(["SELECT", "INSERT"])],
  // 订阅更新只走列级 ACL（见 runtimeColumnUpdatePolicy 的动态项）；Outbox 只允许入队。
  ["tenant_webhooks", new Set(["SELECT", "INSERT", "DELETE"])],
  ["webhook_outbox", new Set(["INSERT"])],
  ["user_accounts", new Set(["SELECT", "INSERT"])],
  ["user_sessions", new Set(["SELECT", "INSERT", "DELETE"])],
  ["tenants", new Set(["SELECT", "INSERT"])],
  ["memberships", new Set(["SELECT", "INSERT"])],
  ["user_personalization_settings", new Set(["SELECT", "INSERT"])],
  ["team_personalization_settings", new Set(["SELECT"])],
  ["threads", new Set(["SELECT", "INSERT"])],
  ["agent_definitions", new Set(["SELECT"])],
  ["agent_definition_tenants", new Set(["SELECT"])],
  ["agent_revisions", new Set(["SELECT"])],
  ["agent_revision_revocations", new Set(["SELECT"])],
  ["agent_definition_commands", new Set()],
  ["agent_definition_audits", new Set()],
  ["runs", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["workspaces", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["workspace_revisions", new Set(["SELECT", "INSERT"])],
  ["workspace_revision_manifests", new Set(["SELECT", "INSERT"])],
  ["workspace_revision_files", new Set(["SELECT", "INSERT"])],
  ["workspace_operation_journal", new Set(["SELECT", "INSERT"])],
  ["workspace_revision_candidates", new Set(["SELECT", "INSERT"])],
  ["workspace_revision_candidate_files", new Set(["SELECT", "INSERT"])],
  ["workspace_artifact_publication_intents", new Set(["SELECT", "INSERT"])],
  ["model_wire_trace_cleanup_commands", new Set(["SELECT", "INSERT"])],
  ["model_wire_trace_cleanup_items", new Set(["SELECT", "INSERT"])],
  ["model_wire_trace_expiry_tombstones", new Set(["SELECT", "INSERT"])],
  ["model_wire_trace_records", new Set(["SELECT", "INSERT", "DELETE"])],
  ["workspace_write_leases", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
  ["blob_lifecycles", new Set(["SELECT", "INSERT"])],
  ["blob_incarnations", new Set(["SELECT", "INSERT"])],
  ["blob_allocations", new Set(["SELECT", "INSERT"])],
  ["blob_commits", new Set(["SELECT", "INSERT"])],
  ["promotion_authorizations", new Set(["SELECT", "INSERT"])],
  ["promotion_executions", new Set(["SELECT", "INSERT"])],
  ["blob_gc_claims", new Set(["SELECT", "INSERT"])],
  ["retired_blob_tombstones", new Set(["SELECT", "INSERT"])],
  ["blob_references", new Set(["SELECT", "INSERT"])],
  ["run_execution_inputs", new Set(["SELECT", "INSERT"])],
  ["execution_attempts", new Set(["SELECT", "INSERT"])],
  ["execution_workspace_fences", new Set(["SELECT", "INSERT"])],
  ["run_claims", new Set(["SELECT", "INSERT"])],
  ["rollout_projections", new Set(["SELECT", "INSERT"])],
  ["run_events", new Set(["SELECT", "INSERT"])],
  ["sandbox_registry", new Set(["SELECT", "INSERT"])],
  ["cleanup_outbox", new Set(["SELECT", "INSERT"])],
  ["sandbox_lifecycle_unknown", new Set(["SELECT", "INSERT"])],
  ["runtime_alert_outbox", new Set(["SELECT", "INSERT"])],
  ["effect_invocations", new Set(["SELECT", "INSERT"])],
  ["external_effect_permits", new Set(["SELECT", "INSERT"])],
  ["mutation_receipts", new Set(["SELECT", "INSERT"])],
  ["api_idempotency_records", new Set(["SELECT", "INSERT"])],
  ["api_thread_idempotency_records", new Set(["SELECT", "INSERT"])],
  ["run_dispatch_outbox", new Set(["SELECT", "INSERT"])],
  ["worker_tenant_assignments", new Set(["SELECT", "INSERT"])],
  ["thread_execution_heads", new Set(["SELECT", "INSERT"])],
  ["thread_input_receipts", new Set(["SELECT", "INSERT"])],
  ["thread_follow_up_queue", new Set(["SELECT", "INSERT"])],
  ["thread_input_receipt_events", new Set(["SELECT", "INSERT"])],
  ["thread_history_directories", new Set(["SELECT", "INSERT"])],
  ["thread_history_file_entries", new Set(["SELECT", "INSERT"])],
  ["thread_title_generation_outbox", new Set(["SELECT", "INSERT"])],
  ["memory_ingestion_outbox", new Set(["SELECT", "INSERT"])],
  ["scheduled_tasks", new Set(["SELECT", "INSERT"])],
  ["scheduled_task_revisions", new Set(["SELECT", "INSERT"])],
  ["scheduled_task_occurrences", new Set(["SELECT", "INSERT"])],
  ["scheduled_task_commands", new Set(["SELECT", "INSERT"])],
  ["run_workspace_results", new Set(["SELECT", "INSERT"])],
  ["thread_context_streams", new Set(["SELECT", "INSERT"])],
  ["thread_context_entries", new Set(["SELECT", "INSERT"])],
  ["thread_context_append_commands", new Set(["SELECT", "INSERT"])],
  ["thread_context_compaction_checkpoints", new Set(["SELECT", "INSERT"])],
  ["thread_context_compaction_replacement_items", new Set(["SELECT", "INSERT"])],
  ["thread_context_history_audits", new Set(["SELECT", "INSERT"])],
  ["thread_sandbox_sessions", new Set(["SELECT", "INSERT"])],
  ["thread_sandbox_leases", new Set(["SELECT", "INSERT"])],
  ["sandbox_lifecycle_effects", new Set(["SELECT", "INSERT"])],
  ["tenant_thread_continuity_policies", new Set(["SELECT"])],
  ["thread_context_legacy_anchors", new Set(["SELECT", "INSERT"])],
  ["thread_context_legacy_backfill_items", new Set(["SELECT", "INSERT"])],
  ["thread_continuity_profiles", new Set(["SELECT", "INSERT"])],
  ["thread_continuity_metric_observations", new Set(["SELECT", "INSERT"])],
  ["resources", new Set(["SELECT", "INSERT"])],
  ["resource_versions", new Set(["SELECT", "INSERT"])],
  ["resource_promotion_authorizations", new Set(["SELECT", "INSERT"])],
  ["resource_promotion_idempotency", new Set(["SELECT", "INSERT"])],
  ["artifact_deliverable_commands", new Set(["SELECT", "INSERT"])],
  ["artifact_deliverable_declarations", new Set(["SELECT", "INSERT"])],
  ["artifact_publications", new Set(["SELECT", "INSERT"])],
  ["artifact_publication_settlements", new Set(["SELECT", "INSERT"])],
  ["artifact_publication_commands", new Set(["SELECT", "INSERT"])],
  ["runtime_ptc_dispatches", new Set(["SELECT", "INSERT"])],
  ["runtime_rollout_streams", new Set(["SELECT", "INSERT"])],
  ["runtime_rollout_entries", new Set(["SELECT", "INSERT"])],
  ["runtime_rollout_append_commands", new Set(["SELECT", "INSERT"])],
  ["runtime_rollout_replacements", new Set(["SELECT", "INSERT"])],
  ["runtime_rollout_checkpoints", new Set(["SELECT", "INSERT"])],
  ["runtime_rollout_checkpoint_commands", new Set(["SELECT", "INSERT"])],
  ["runtime_agent_threads", new Set(["SELECT", "INSERT"])],
  ["runtime_subagent_conversations", new Set(["SELECT", "INSERT"])],
  ["runtime_agent_turns", new Set(["SELECT", "INSERT"])],
  ["runtime_agent_mailbox_messages", new Set(["SELECT", "INSERT"])],
  ["runtime_agent_commands", new Set(["SELECT", "INSERT"])],
  ["waiting_recovery_checkpoints", new Set(["SELECT", "INSERT"])],
  ["waiting_recovery_effect_outbox", new Set(["SELECT", "INSERT"])],
  ["runtime_recovery_metrics", new Set(["SELECT", "INSERT"])],
  ["skills", new Set(["SELECT"])],
  ["skill_versions", new Set(["SELECT"])],
  ["skill_version_files", new Set(["SELECT"])],
  ["user_skill_installations", new Set(["SELECT", "INSERT"])],
  ["user_skill_installation_commands", new Set(["SELECT", "INSERT"])],
  ["user_skill_installation_audits", new Set(["SELECT", "INSERT"])],
  ["team_member_directory", new Set(["SELECT", "INSERT"])],
  ["thread_forks", new Set(["SELECT", "INSERT"])],
  ["tenant_skill_installations", new Set(["SELECT", "INSERT"])],
  ["tenant_skill_installation_commands", new Set(["SELECT", "INSERT"])],
  ["tenant_skill_installation_audits", new Set(["SELECT", "INSERT"])],
  ["run_skill_snapshots", new Set(["SELECT", "INSERT"])],
  ["run_skill_snapshot_items", new Set(["SELECT", "INSERT"])],
  ["skill_invocations", new Set(["SELECT", "INSERT"])],
  // 管理面事实只能由对应的独立数据库角色访问，Runtime 对审计与命令表保持零 ACL。
  ["platform_skill_operators", new Set()],
  ["skill_publication_submissions", new Set()],
  ["skill_publication_files", new Set()],
  ["skill_publication_commands", new Set()],
  ["skill_publication_audits", new Set()],
  ["platform_control_operators", new Set()],
  ["admin_control_config_revisions", new Set(["SELECT"])],
  ["admin_control_provider_probes", new Set()],
  ["admin_control_active_configs", new Set(["SELECT"])],
  ["admin_control_activation_events", new Set()],
  ["admin_control_commands", new Set()],
  ["admin_control_audits", new Set()],
  ["admin_control_generation", new Set(["SELECT"])],
  ["better_auth_users", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
  ["better_auth_sessions", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
  ["better_auth_accounts", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
  ["better_auth_verifications", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
  ["better_auth_rate_limits", new Set(["SELECT", "INSERT", "UPDATE", "DELETE"])],
  ["identity_auth_configuration", new Set(["SELECT"])],
  ["identity_auth_audits", new Set()],
  ["identity_auth_commands", new Set()],
  ["admin_user_account_audits", new Set()],
  ["run_runtime_config_snapshots", new Set(["SELECT", "INSERT"])],
  ["run_compaction_settings_snapshots", new Set(["SELECT", "INSERT"])],
  [migrationTable, new Set()],
]);

const runtimeColumnUpdatePolicy = new Map<string, ReadonlySet<string>>([
  ["api_keys", new Set(["last_used_at"])],
  // Agent 定义、Run 浏览器审计和外部工具版本均不得由 Runtime 执行列级更新。
  [
    "threads",
    new Set([
      "title",
      "status",
      "updated_at",
      "version",
      "title_source",
      "title_generated_at",
      "title_generation_version",
    ]),
  ],
  [
    "runtime_ptc_dispatches",
    new Set([
      "result_idempotency_key",
      "result_digest",
      "result_body",
      "is_truncated",
      "blob_reference_id",
      "blob_state",
      "blob_purpose",
      "blob_sha256",
      "blob_size",
      "completed_at",
    ]),
  ],
  [
    "user_personalization_settings",
    new Set(["content", "apply_to_team_tasks", "version", "updated_at"]),
  ],
  [
    "blob_lifecycles",
    new Set([
      "state",
      "current_incarnation_id",
      "generation",
      "current_claim_id",
      "lease_expires_at",
      "updated_at",
    ]),
  ],
  ["blob_incarnations", new Set(["state", "retired_at"])],
  ["blob_commits", new Set(["status", "version", "snapshot", "updated_at"])],
  [
    "promotion_authorizations",
    new Set(["state", "current_execution_id", "execution_generation", "updated_at"]),
  ],
  ["promotion_executions", new Set(["phase", "proof_status", "updated_at"])],
  ["blob_gc_claims", new Set(["phase", "updated_at"])],
  [
    "retired_blob_tombstones",
    new Set(["generation", "scrub_lease_expires_at", "next_scrub_at", "last_scrubbed_at"]),
  ],
  [
    "blob_references",
    new Set(["state", "lifecycle_id", "incarnation_id", "physical_object_key", "updated_at"]),
  ],
  [
    "workspace_revision_candidates",
    new Set(["status", "manifest_digest", "release_reason", "expires_at", "updated_at"]),
  ],
  ["workspace_revision_candidate_files", new Set(["manifest_digest"])],
  ["run_execution_inputs", new Set(["answer_text", "updated_at"])],
  ["skill_invocations", new Set(["status", "instruction_digest", "failure_code", "updated_at"])],
  ["runtime_agent_threads", new Set(["status", "updated_at"])],
  [
    "runtime_subagent_conversations",
    new Set(["turn_ordinal", "current_task", "history", "history_digest", "updated_at"]),
  ],
  [
    "runtime_agent_turns",
    new Set(["status", "final_answer", "error_code", "started_at", "completed_at"]),
  ],
  [
    "execution_attempts",
    new Set([
      "current_revision_id",
      "status",
      "stage",
      "version",
      "next_event_sequence",
      "projection_version",
      "model_execution_started",
      "updated_at",
      "finished_at",
    ]),
  ],
  ["run_claims", new Set(["expires_at", "updated_at", "released_at"])],
  [
    "thread_execution_heads",
    new Set([
      "active_run_id",
      "active_turn_id",
      "next_turn_ordinal",
      "next_queue_sequence",
      "next_input_sequence",
      "context_through_sequence",
      "writer_owner",
      "writer_token",
      "writer_epoch",
      "writer_expires_at",
      "version",
      "updated_at",
    ]),
  ],
  [
    "thread_context_streams",
    new Set([
      "next_sequence",
      "current_window_number",
      "current_checkpoint_id",
      "current_compatibility_digest",
      "updated_at",
    ]),
  ],
  [
    "thread_input_receipts",
    new Set([
      "state",
      "disposition",
      "queued_run_id",
      "queue_sequence",
      "target_run_id",
      "target_turn_id",
      "applied_context_sequence",
      "rejection_code",
      "updated_at",
      "consumed_at",
    ]),
  ],
  [
    "thread_follow_up_queue",
    new Set([
      "state",
      "claim_owner",
      "claim_token",
      "claim_epoch",
      "claim_expires_at",
      "consumption_receipt",
      "activated_at",
      "finished_at",
    ]),
  ],
  [
    "thread_history_directories",
    new Set([
      "directory_name",
      "naming_state",
      "first_file_at",
      "last_file_at",
      "file_count",
      "version",
      "updated_at",
    ]),
  ],
  ["thread_history_file_entries", new Set(["last_attached_at", "attachment_count", "updated_at"])],
  [
    "thread_title_generation_outbox",
    new Set([
      "state",
      "claim_token",
      "claim_generation",
      "claimed_by",
      "claim_expires_at",
      "attempt_count",
      "next_attempt_at",
      "last_error_code",
      "model_key",
      "prompt_tokens",
      "completion_tokens",
      "duration_ms",
      "completed_at",
      "updated_at",
    ]),
  ],
  [
    "scheduled_tasks",
    new Set([
      "name",
      "instruction",
      "timezone",
      "rrule",
      "status",
      "overlap_policy",
      "next_run_at",
      "last_run_at",
      "current_revision",
      "updated_at",
    ]),
  ],
  [
    "scheduled_task_occurrences",
    new Set([
      "state",
      "dispatch_attempts",
      "next_attempt_at",
      "run_id",
      "receipt_id",
      "failure_code",
      "updated_at",
    ]),
  ],
  [
    "memory_ingestion_outbox",
    new Set([
      "state",
      "provider_event_id",
      "claim_token",
      "claim_generation",
      "claimed_by",
      "claim_expires_at",
      "attempt_count",
      "next_attempt_at",
      "last_error_code",
      "submitted_at",
      "completed_at",
      "updated_at",
    ]),
  ],
  ["rollout_projections", new Set(["attempt_id", "version", "projection", "digest", "updated_at"])],
  ["sandbox_registry", new Set(["state", "actual_ttl_seconds", "updated_at"])],
  [
    "thread_sandbox_sessions",
    new Set([
      "state",
      "materialized_revision_id",
      "materialization_attested",
      "paused_at",
      "retention_expires_at",
      "current_effect_id",
      "updated_at",
      "terminated_at",
    ]),
  ],
  [
    "thread_sandbox_leases",
    new Set(["attempt_id", "owner", "expires_at", "released_at", "updated_at"]),
  ],
  [
    "sandbox_lifecycle_effects",
    new Set([
      "state",
      "provider_key",
      "provider_sandbox_id",
      "resulting_session_state",
      "provider_receipt_digest",
      "claim_token",
      "claimed_by",
      "claim_generation",
      "claim_expires_at",
      "remote_call_started_at",
      "updated_at",
      "completed_at",
    ]),
  ],
  [
    "cleanup_outbox",
    new Set([
      "state",
      "disposition",
      "payload",
      "payload_digest",
      "updated_at",
      "claim_token",
      "claim_generation",
      "claimed_by",
      "claim_lease_expires_at",
      "retry_at",
      "attempt_count",
      "remote_call_started_at",
    ]),
  ],
  ["external_effect_permits", new Set(["consumed_at"])],
  [
    "run_dispatch_outbox",
    new Set([
      "state",
      "generation",
      "claim_token",
      "claimed_by",
      "lease_expires_at",
      "next_attempt_at",
      "dispatch_attempts",
      "last_error_code",
      "updated_at",
    ]),
  ],
  [
    "worker_tenant_assignments",
    new Set([
      "state",
      "generation",
      "claim_token",
      "claimed_by",
      "lease_expires_at",
      "next_attempt_at",
      "updated_at",
    ]),
  ],
  [
    "resources",
    new Set(["visibility", "latest_version_number", "latest_version_id", "updated_at"]),
  ],
  ["resource_promotion_authorizations", new Set(["state", "consumed_at"])],
  [
    "workspace_operation_journal",
    new Set(["status", "result", "failure_phase", "failure_code", "unknown_fact", "updated_at"]),
  ],
  [
    "waiting_recovery_checkpoints",
    new Set([
      "state",
      "claim_owner",
      "claim_token",
      "claim_epoch",
      "claim_expires_at",
      "decision",
      "updated_at",
    ]),
  ],
  ["waiting_recovery_effect_outbox", new Set(["state", "payload", "updated_at"])],
  ["model_wire_trace_cleanup_commands", new Set(["status", "deleted_count", "completed_at"])],
  ["model_wire_trace_cleanup_items", new Set(["state", "outcome", "attempt_count", "updated_at"])],
  ["model_wire_trace_expiry_tombstones", new Set(["staging_swept_at"])],
  [
    "model_wire_trace_records",
    new Set([
      "persistence_status",
      "blob_reference_id",
      "blob_state",
      "blob_purpose",
      "blob_lifecycle_id",
      "blob_incarnation_id",
      "physical_object_key",
      "processing_token",
      "processing_lease_expires_at",
      "retention_recovery_at",
      "cleanup_command_id",
      "updated_at",
    ]),
  ],
  [
    "user_skill_installations",
    new Set([
      "skill_version",
      "invocation_name",
      "status",
      "version_token",
      "installed_at",
      "updated_at",
    ]),
  ],
  ["team_member_directory", new Set(["role", "status", "updated_at"])],
  [
    "tenant_skill_installations",
    new Set([
      "skill_version",
      "invocation_name",
      "status",
      "version_token",
      "installed_at",
      "updated_at",
    ]),
  ],
]);

async function hasRuntimeSubagentCurrentTaskState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid=to_regclass(format('%I.runtime_subagent_conversations',$1::text))
          AND attname='current_task' AND attnum>0 AND NOT attisdropped
     ) AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasWaitingRecoveryState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.waiting_recovery_checkpoints', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.waiting_recovery_effect_outbox', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasMembershipLockMarker(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass(format('%I.memberships', current_schema()))
          AND attname = 'lock_marker' AND attnum > 0 AND NOT attisdropped
     ) AS present`,
  );
  return result.rows[0]?.present === true;
}

async function hasWorkspaceRuntimeState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.runtime_recovery_metrics', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasWorkspaceManifestState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.workspace_revision_manifests', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.workspace_revision_files', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.workspace_operation_journal', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasWorkspaceCandidateState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.workspace_revision_candidates', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.workspace_revision_candidate_files', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasWorkspaceArtifactIntentState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.workspace_artifact_publication_intents', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasModelWireTraceState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.model_wire_trace_cleanup_commands', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.model_wire_trace_cleanup_items', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.model_wire_trace_expiry_tombstones', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.model_wire_trace_records', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasSkillCenterState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.skills', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.skill_versions', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.skill_version_files', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.user_skill_installations', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.user_skill_installation_commands', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.user_skill_installation_audits', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasTeamCollaborationState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.team_member_directory', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_forks', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.tenant_skill_installations', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.tenant_skill_installation_commands', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.tenant_skill_installation_audits', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasPersonalizationSettingsState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.user_personalization_settings', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.team_personalization_settings', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasLocalAccountState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.user_accounts', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.user_sessions', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasSkillRuntimeState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.run_skill_snapshots', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.run_skill_snapshot_items', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.skill_invocations', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasSkillPublicationState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.platform_skill_operators', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.skill_publication_submissions', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.skill_publication_files', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.skill_publication_commands', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.skill_publication_audits', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasRunWorkerState(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.run_execution_inputs', current_schema())) IS NOT NULL AS present",
  );
  return result.rows[0]?.present === true;
}

async function hasRunDispatchState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    // 允许迁移序号留孔，因此 ACL 以实际表及关键列为准，而不是“版本 >= 5”的猜测。
    `SELECT EXISTS (
       SELECT 1
         FROM pg_class relation
         JOIN pg_attribute column_state ON column_state.attrelid=relation.oid
        WHERE relation.relnamespace=$1::regnamespace
          AND relation.relname='run_dispatch_outbox' AND relation.relkind='r'
          AND column_state.attname='outbox_id' AND column_state.attnum > 0
          AND NOT column_state.attisdropped
     ) AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasWorkerTenantAssignmentState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.worker_tenant_assignments', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadCreationState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.api_thread_idempotency_records', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadHeadState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_execution_heads', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadInputQueueState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_input_receipts', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_follow_up_queue', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadInputRoutingState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_input_receipt_events', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasHistoryFilesystemState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_history_directories', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_history_file_entries', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}
async function hasThreadTitleGenerationState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_title_generation_outbox', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}
async function hasMemoryIngestionState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.memory_ingestion_outbox', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}
async function hasRunWorkspaceResultState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.run_workspace_results', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadContextState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_context_streams', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_context_entries', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_context_append_commands', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadContextAuditState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_context_history_audits', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadContextCompactionState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_context_compaction_checkpoints', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_context_compaction_replacement_items', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadSandboxSessionState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.thread_sandbox_sessions', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_sandbox_leases', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.sandbox_lifecycle_effects', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasSandboxProviderIdentityState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid=to_regclass(format('%I.sandbox_lifecycle_effects',$1::text))
          AND attname='provider_key' AND attnum>0 AND NOT attisdropped
     ) AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasThreadContinuityRolloutState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.tenant_thread_continuity_policies', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_context_legacy_anchors', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_context_legacy_backfill_items', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_continuity_profiles', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.thread_continuity_metric_observations', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasCleanupConsumerState(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='cleanup_outbox' AND column_name='claim_token') AS present",
  );
  return result.rows[0]?.present === true;
}

async function hasResourceLibraryState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.resources', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.resource_versions', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.resource_promotion_authorizations', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.resource_promotion_idempotency', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasArtifactDeliveryState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.artifact_publications', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.artifact_publication_commands', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.artifact_publication_settlements', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasRuntimeRolloutState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.runtime_rollout_streams', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.runtime_rollout_entries', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.runtime_rollout_replacements', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.runtime_rollout_checkpoints', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasRuntimePtcDispatchState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.runtime_ptc_dispatches', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasScheduledTaskState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.scheduled_tasks', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.scheduled_task_revisions', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.scheduled_task_occurrences', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.scheduled_task_commands', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasExternalToolState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.external_tool_versions',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_credentials',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_revocations',$1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasExternalToolAdminState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.external_tool_registration_drafts',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_draft_credentials',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_publish_batches',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_publish_batch_versions',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_admin_publish_claims',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_admin_commands',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_admin_audits',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_selectable_versions',$1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasEmbeddedIdentityState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.better_auth_users',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.better_auth_sessions',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.identity_auth_configuration',$1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}
async function hasInstallationState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.installation_state',$1::text)) IS NOT NULL AS present",
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasRunExternalToolSnapshotView(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.worker_run_external_tool_snapshots',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.runtime_external_tool_permit_gate',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.run_agent_snapshots',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_versions',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_credentials',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.external_tool_revocations',$1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasRunAgentSnapshotState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.run_agent_snapshots',$1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasRunPlaygroundMockState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.run_playground_mocks',$1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasAgentDefinitionState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.agent_definitions',$1::text)) IS NOT NULL
      AND to_regclass(format('%I.agent_revisions',$1::text)) IS NOT NULL
      AND to_regclass(format('%I.agent_revision_revocations',$1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasAdminControlState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.platform_control_operators',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.admin_control_config_revisions',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.admin_control_active_configs',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.run_runtime_config_snapshots',$1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasAdminUserOperationsState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.admin_user_account_audits',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.admin_user_directory',$1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

/** 后台 Run 浏览器的审计表与受限视图；只有它们齐备时才授予 Admin Control 访问。 */
async function hasAdminRunExplorerState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.admin_run_content_access_audits',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.admin_run_directory',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.admin_run_event_outline',$1::text)) IS NOT NULL
            AND to_regclass(format('%I.admin_run_event_content',$1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasAdminIntegrationTenantDirectoryState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.admin_integration_tenant_directory',$1::text)) IS NOT NULL AS present",
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasAdminRunInputProjectionPolicyState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename='run_execution_inputs'
       AND policyname='run_execution_inputs_admin_projection_read') AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

const adminRunExplorerViews = [
  "admin_run_directory",
  "admin_run_event_outline",
  "admin_run_event_content",
] as const;

async function hasRunCompactionSettingsState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.run_compaction_settings_snapshots',$1::text)) IS NOT NULL AS present",
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasRuntimeAgentControlState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.runtime_agent_threads', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.runtime_agent_turns', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.runtime_agent_mailbox_messages', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.runtime_agent_commands', $1::text)) IS NOT NULL
            AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasRuntimeSubagentConversationState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.runtime_subagent_conversations', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

const managedSandboxControlTables = [
  "sandbox_provider_profiles",
  "sandbox_routing_revisions",
  "sandbox_routing_targets",
  "sandbox_control_head",
  "sandbox_profile_probes",
  "sandbox_control_audits",
] as const;
const managedSandboxRuntimeTables = [
  "sandbox_provider_profiles",
  "sandbox_routing_revisions",
  "sandbox_routing_targets",
  "sandbox_control_head",
] as const;

async function hasApiKeyState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.api_keys',$1::text)) IS NOT NULL AS present",
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasApiKeyRevocationPolicyState(
  client: PoolClient,
  schema: string,
): Promise<boolean> {
  const result = await client.query<{ readonly policy_count: string }>(
    `SELECT count(*)::text AS policy_count
       FROM pg_policies
      WHERE schemaname = $1
        AND ((tablename = 'api_keys' AND policyname = 'api_key_revocation_guard')
          OR (tablename = 'memberships' AND policyname = 'api_key_integration_membership_revoke'))`,
    [schema],
  );
  const count = Number(result.rows[0]?.policy_count ?? "0");
  if (count !== 0 && count !== 2) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "API Key 撤销 RLS 策略状态不完整");
  }
  return count === 2;
}

async function hasManagedSandboxState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.sandbox_control_head',$1::text)) IS NOT NULL AS present",
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasApiEndUserState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.api_end_users',$1::text)) IS NOT NULL AS present",
    [schema],
  );
  return result.rows[0]?.present === true;
}

export function formatTableSetDifference(
  expectedTables: readonly string[],
  actualTables: readonly string[],
): string {
  const expected = new Set(expectedTables);
  const actual = new Set(actualTables);
  const missing = [...expected].filter((table) => !actual.has(table)).sort();
  const extra = [...actual].filter((table) => !expected.has(table)).sort();
  const format = (tables: readonly string[]): string => `[${tables.join(",")}]`;
  return `缺少 ${format(missing)}，多出 ${format(extra)}`;
}

export async function activeTablePolicy(
  client: PoolClient,
  schema: string,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const policy = new Map(runtimeTablePolicy);
  if (await hasApiEndUserState(client, schema))
    policy.set("api_end_users", new Set(["SELECT", "INSERT"]));
  if (!(await hasApiKeyState(client, schema))) policy.delete("api_keys");
  if (!(await hasWebhookState(client, schema))) {
    policy.delete("tenant_webhooks");
    if (policy.has("run_playground_mocks")) policy.set("run_playground_mocks", new Set());
    policy.delete("webhook_outbox");
  }
  if (await hasManagedSandboxState(client, schema)) {
    for (const table of managedSandboxControlTables) policy.set(table, new Set());
    for (const table of managedSandboxRuntimeTables) policy.set(table, new Set(["SELECT"]));
    policy.set("sandbox_configuration_bindings", new Set(["SELECT", "INSERT"]));
  }
  if (!(await hasRunWorkerState(client))) {
    for (const table of runWorkerTables) policy.delete(table);
  }
  if (!(await hasRunDispatchState(client, schema))) {
    for (const table of runDispatchTables) policy.delete(table);
  }
  if (!(await hasWorkerTenantAssignmentState(client, schema))) {
    for (const table of workerTenantAssignmentTables) policy.delete(table);
  }
  if (!(await hasThreadCreationState(client, schema))) {
    for (const table of threadCreationTables) policy.delete(table);
  }
  if (!(await hasThreadHeadState(client, schema))) {
    for (const table of threadHeadTables) policy.delete(table);
  }
  if (!(await hasThreadInputQueueState(client, schema))) {
    for (const table of threadInputQueueTables) policy.delete(table);
  }
  if (!(await hasThreadInputRoutingState(client, schema))) {
    for (const table of threadInputRoutingTables) policy.delete(table);
  }
  if (!(await hasHistoryFilesystemState(client, schema))) {
    for (const table of historyFilesystemTables) policy.delete(table);
  }
  if (!(await hasThreadTitleGenerationState(client, schema))) {
    for (const table of threadTitleGenerationTables) policy.delete(table);
  }
  if (!(await hasMemoryIngestionState(client, schema))) {
    for (const table of memoryIngestionTables) policy.delete(table);
  }
  if (!(await hasScheduledTaskState(client, schema))) {
    for (const table of scheduledTaskTables) policy.delete(table);
  }
  if (!(await hasRunWorkspaceResultState(client, schema))) {
    for (const table of runWorkspaceResultTables) policy.delete(table);
  }
  if (!(await hasThreadContextState(client, schema))) {
    for (const table of threadContextTables) policy.delete(table);
  }
  if (!(await hasThreadContextCompactionState(client, schema))) {
    for (const table of threadContextCompactionTables) policy.delete(table);
  }
  if (!(await hasThreadContextAuditState(client, schema))) {
    for (const table of threadContextAuditTables) policy.delete(table);
  }
  if (!(await hasThreadSandboxSessionState(client, schema))) {
    for (const table of threadSandboxSessionTables) policy.delete(table);
  }
  if (!(await hasThreadContinuityRolloutState(client, schema))) {
    for (const table of threadContinuityRolloutTables) policy.delete(table);
  }
  if (!(await hasResourceLibraryState(client, schema))) {
    for (const table of resourceLibraryTables) policy.delete(table);
  }
  if (!(await hasArtifactDeliveryState(client, schema))) {
    for (const table of artifactDeliveryTables) policy.delete(table);
  }
  if (!(await hasRuntimeRolloutState(client, schema))) {
    for (const table of runtimeRolloutTables) policy.delete(table);
  }
  if (!(await hasRuntimePtcDispatchState(client, schema))) {
    for (const table of runtimePtcDispatchTables) policy.delete(table);
  }
  if (!(await hasRuntimeAgentControlState(client, schema))) {
    for (const table of runtimeAgentControlTables) policy.delete(table);
  }
  if (!(await hasRuntimeSubagentConversationState(client, schema))) {
    for (const table of runtimeSubagentConversationTables) policy.delete(table);
  }
  if (!(await hasWaitingRecoveryState(client, schema))) {
    for (const table of waitingRecoveryTables) policy.delete(table);
  }
  if (!(await hasWorkspaceRuntimeState(client, schema))) {
    for (const table of workspaceRuntimeTables) policy.delete(table);
  }
  if (!(await hasWorkspaceManifestState(client, schema))) {
    for (const table of workspaceManifestTables) policy.delete(table);
  }
  if (!(await hasWorkspaceCandidateState(client, schema))) {
    for (const table of workspaceCandidateTables) policy.delete(table);
  }
  if (!(await hasWorkspaceArtifactIntentState(client, schema))) {
    for (const table of workspaceArtifactIntentTables) policy.delete(table);
  }
  if (!(await hasModelWireTraceState(client, schema))) {
    for (const table of modelWireTraceTables) policy.delete(table);
  } else {
    // DELETE 仍受 0017 的 purpose/完整身份/到期 RLS policy 约束，不能释放普通 Blob 引用。
    policy.set("blob_references", new Set(["SELECT", "INSERT", "DELETE"]));
  }
  if (!(await hasSkillCenterState(client, schema))) {
    for (const table of skillCenterTables) policy.delete(table);
  }
  if (!(await hasTeamCollaborationState(client, schema))) {
    for (const table of teamCollaborationTables) policy.delete(table);
  } else {
    // 0041 已完成 Tenant 级迁移后，旧用户级安装表仅保留为回滚数据，不再授予 Runtime。
    for (const table of legacySkillInstallationTables) policy.set(table, new Set());
    // 团队目录与 Membership 变更只向独立 Team Coordinator 开放。
    policy.set("team_member_directory", new Set());
  }
  if (!(await hasPersonalizationSettingsState(client, schema))) {
    for (const table of personalizationSettingsTables) policy.delete(table);
  }
  if (!(await hasLocalAccountState(client, schema))) {
    for (const table of localAccountTables) policy.delete(table);
  }
  if (!(await hasEmbeddedIdentityState(client, schema))) {
    for (const table of embeddedIdentityTables) policy.delete(table);
  }
  if (await hasExternalToolState(client, schema)) {
    for (const table of [
      "external_tool_versions",
      "external_tool_credentials",
      "external_tool_revocations",
    ])
      policy.set(table, new Set());
  }
  if (await hasExternalToolAdminState(client, schema)) {
    for (const table of externalToolAdminTables) policy.set(table, new Set());
  }
  if (await hasIntegrationAdminState(client, schema)) {
    policy.set("integration_admin_audits", new Set());
  }
  if (!(await hasSkillRuntimeState(client, schema))) {
    for (const table of skillRuntimeTables) policy.delete(table);
  }
  if (!(await hasSkillPublicationState(client, schema))) {
    for (const table of skillPublicationTables) policy.delete(table);
  }
  if (!(await hasAdminControlState(client, schema))) {
    for (const table of adminControlTables) policy.delete(table);
  }
  if (await hasRunAgentSnapshotState(client, schema)) {
    policy.set("run_agent_snapshots", new Set(["SELECT", "INSERT"]));
  }
  if (await hasRunPlaygroundMockState(client, schema)) {
    policy.set("run_playground_mocks", new Set(["SELECT", "INSERT"]));
    policy.set("runs", new Set(["SELECT", "INSERT"]));
  }
  if (!(await hasAgentDefinitionState(client, schema))) {
    for (const table of [
      "agent_definitions",
      "agent_definition_tenants",
      "agent_revisions",
      "agent_revision_revocations",
      "agent_definition_commands",
      "agent_definition_audits",
    ])
      policy.delete(table);
  }
  if (!(await hasRunCompactionSettingsState(client, schema))) {
    policy.delete("run_compaction_settings_snapshots");
  }
  // 正文访问审计只属于 Admin Control；Runtime 与 Team Coordinator 保持零 ACL。
  if (await hasAdminRunExplorerState(client, schema)) {
    policy.set("admin_run_content_access_audits", new Set());
  }
  if ((await hasRunWorkerState(client)) && !(await hasCleanupConsumerState(client))) {
    policy.set("cleanup_outbox", new Set(["SELECT", "INSERT"]));
  }
  if (await hasInstallationState(client, schema)) {
    policy.set("installation_state", new Set(["SELECT"]));
    const statusView = await client.query<{ present: boolean }>(
      "SELECT to_regclass(format('%I.installation_status',$1::text)) IS NOT NULL AS present",
      [schema],
    );
    if (statusView.rows[0]?.present)
      policy.set("platform_skill_operators", new Set(["SELECT", "INSERT"]));
    policy.set("platform_control_operators", new Set(["SELECT", "INSERT"]));
  }
  return policy;
}

export async function activeColumnUpdatePolicy(
  client: PoolClient,
  schema: string,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const policy = new Map(runtimeColumnUpdatePolicy);
  if (await hasWebhookState(client, schema))
    policy.set("tenant_webhooks", new Set(webhookRuntimeUpdateColumns));
  const apiKeyState = await hasApiKeyState(client, schema);
  const apiKeyRevocationPolicyState =
    apiKeyState && (await hasApiKeyRevocationPolicyState(client, schema));
  if (!apiKeyState) policy.delete("api_keys");
  else
    policy.set(
      "api_keys",
      apiKeyRevocationPolicyState
        ? new Set(["last_used_at", "revoked_at"])
        : new Set(["last_used_at"]),
    );
  if (await hasInstallationState(client, schema)) {
    policy.set("installation_state", new Set(["administrator_user_id", "initialized_at"]));
  }
  if (await hasEmbeddedIdentityState(client, schema)) {
    policy.set("user_accounts", new Set(["better_auth_user_id", "display_name", "updated_at"]));
  }
  if (await hasRunAgentSnapshotState(client, schema)) {
    policy.set("run_agent_snapshots", new Set());
  }
  if (await hasRunPlaygroundMockState(client, schema)) {
    policy.set("run_playground_mocks", new Set());
    policy.set("runs", new Set(["version", "status", "updated_at"]));
  }
  if (await hasAgentDefinitionState(client, schema)) {
    for (const table of [
      "agent_definitions",
      "agent_definition_tenants",
      "agent_revisions",
      "agent_revision_revocations",
      "agent_definition_commands",
      "agent_definition_audits",
    ])
      policy.set(table, new Set());
  }
  if (await hasAdminRunExplorerState(client, schema)) {
    policy.set("admin_run_content_access_audits", new Set());
  }
  if (await hasExternalToolState(client, schema)) {
    for (const table of [
      "external_tool_versions",
      "external_tool_credentials",
      "external_tool_revocations",
    ])
      policy.set(table, new Set());
  }
  if (await hasExternalToolAdminState(client, schema)) {
    for (const table of externalToolAdminTables) policy.set(table, new Set());
  }
  // 0003 之前不存在该列；partial down 后 ACL 必须回到 0002 的真实 Schema，而不是引用未来列。
  const membershipUpdateColumns = new Set<string>();
  if (apiKeyRevocationPolicyState) membershipUpdateColumns.add("status");
  if (await hasMembershipLockMarker(client)) membershipUpdateColumns.add("lock_marker");
  policy.set("memberships", membershipUpdateColumns);
  if (!(await hasPersonalizationSettingsState(client, schema))) {
    for (const table of personalizationSettingsTables) policy.delete(table);
  }
  if (!(await hasRunWorkerState(client))) {
    for (const table of runWorkerTables) policy.delete(table);
  }
  if (!(await hasRunDispatchState(client, schema))) {
    for (const table of runDispatchTables) policy.delete(table);
  }
  if (!(await hasWorkerTenantAssignmentState(client, schema))) {
    for (const table of workerTenantAssignmentTables) policy.delete(table);
  }
  if (!(await hasThreadCreationState(client, schema))) {
    for (const table of threadCreationTables) policy.delete(table);
  }
  if (!(await hasThreadHeadState(client, schema))) {
    for (const table of threadHeadTables) policy.delete(table);
  }
  if (!(await hasThreadInputQueueState(client, schema))) {
    for (const table of threadInputQueueTables) policy.delete(table);
  }
  if (!(await hasThreadInputRoutingState(client, schema))) {
    for (const table of threadInputRoutingTables) policy.delete(table);
    if (policy.has("thread_execution_heads")) {
      policy.set(
        "thread_execution_heads",
        new Set(
          [...(policy.get("thread_execution_heads") ?? [])].filter(
            (column) => column !== "next_input_sequence",
          ),
        ),
      );
    }
    if (policy.has("thread_input_receipts")) {
      policy.set(
        "thread_input_receipts",
        new Set(
          [...(policy.get("thread_input_receipts") ?? [])].filter(
            (column) =>
              !new Set(["queued_run_id", "queue_sequence", "target_run_id", "target_turn_id"]).has(
                column,
              ),
          ),
        ),
      );
    }
  }
  if (!(await hasHistoryFilesystemState(client, schema))) {
    for (const table of historyFilesystemTables) policy.delete(table);
  }
  if (!(await hasThreadTitleGenerationState(client, schema))) {
    for (const table of threadTitleGenerationTables) policy.delete(table);
  }
  if (!(await hasMemoryIngestionState(client, schema))) {
    for (const table of memoryIngestionTables) policy.delete(table);
  }
  if (!(await hasScheduledTaskState(client, schema))) {
    for (const table of scheduledTaskTables) policy.delete(table);
  }
  if (!(await hasRunWorkspaceResultState(client, schema))) {
    for (const table of runWorkspaceResultTables) policy.delete(table);
  }
  if (!(await hasThreadContextState(client, schema))) {
    for (const table of threadContextTables) policy.delete(table);
  }
  if (!(await hasThreadContextCompactionState(client, schema))) {
    for (const table of threadContextCompactionTables) policy.delete(table);
    if (policy.has("thread_context_streams")) {
      policy.set(
        "thread_context_streams",
        new Set(
          [...(policy.get("thread_context_streams") ?? [])].filter(
            (column) =>
              !new Set([
                "current_window_number",
                "current_checkpoint_id",
                "current_compatibility_digest",
              ]).has(column),
          ),
        ),
      );
    }
  }
  if (!(await hasThreadContextAuditState(client, schema))) {
    for (const table of threadContextAuditTables) policy.delete(table);
  }
  if (!(await hasThreadSandboxSessionState(client, schema))) {
    for (const table of threadSandboxSessionTables) policy.delete(table);
  } else if (!(await hasSandboxProviderIdentityState(client, schema))) {
    policy.set(
      "sandbox_lifecycle_effects",
      new Set(
        [...(policy.get("sandbox_lifecycle_effects") ?? [])].filter(
          (column) => column !== "provider_key",
        ),
      ),
    );
  }
  if (!(await hasThreadContinuityRolloutState(client, schema))) {
    for (const table of threadContinuityRolloutTables) policy.delete(table);
  }
  if (!(await hasResourceLibraryState(client, schema))) {
    for (const table of resourceLibraryTables) policy.delete(table);
  }
  if (!(await hasArtifactDeliveryState(client, schema))) {
    for (const table of artifactDeliveryTables) policy.delete(table);
  }
  if (!(await hasRuntimeRolloutState(client, schema))) {
    for (const table of runtimeRolloutTables) policy.delete(table);
  }
  if (!(await hasRuntimePtcDispatchState(client, schema))) {
    for (const table of runtimePtcDispatchTables) policy.delete(table);
  }
  if (!(await hasRuntimeAgentControlState(client, schema))) {
    for (const table of runtimeAgentControlTables) policy.delete(table);
  }
  if (!(await hasRuntimeSubagentConversationState(client, schema))) {
    for (const table of runtimeSubagentConversationTables) policy.delete(table);
  } else if (!(await hasRuntimeSubagentCurrentTaskState(client, schema))) {
    policy.set(
      "runtime_subagent_conversations",
      new Set(
        [...(policy.get("runtime_subagent_conversations") ?? [])].filter(
          (column) => column !== "current_task",
        ),
      ),
    );
  }
  if (!(await hasWaitingRecoveryState(client, schema))) {
    for (const table of waitingRecoveryTables) policy.delete(table);
  }
  if (!(await hasWorkspaceRuntimeState(client, schema))) {
    for (const table of workspaceRuntimeTables) policy.delete(table);
  }
  if (!(await hasWorkspaceManifestState(client, schema))) {
    for (const table of workspaceManifestTables) policy.delete(table);
  }
  if (!(await hasWorkspaceCandidateState(client, schema))) {
    for (const table of workspaceCandidateTables) policy.delete(table);
  }
  if (!(await hasWorkspaceArtifactIntentState(client, schema))) {
    for (const table of workspaceArtifactIntentTables) policy.delete(table);
  }
  if (!(await hasModelWireTraceState(client, schema))) {
    for (const table of modelWireTraceTables) policy.delete(table);
  }
  if (!(await hasSkillCenterState(client, schema))) {
    for (const table of skillCenterTables) policy.delete(table);
  }
  if (!(await hasTeamCollaborationState(client, schema))) {
    for (const table of teamCollaborationTables) policy.delete(table);
  } else {
    // 物理表仍存在时保留零权限断言，不能把“未检查”误当成“无权限”。
    policy.set("user_skill_installations", new Set());
    policy.set("team_member_directory", new Set());
  }
  if (!(await hasSkillRuntimeState(client, schema))) {
    for (const table of skillRuntimeTables) policy.delete(table);
  }
  if ((await hasRunWorkerState(client)) && !(await hasCleanupConsumerState(client))) {
    policy.set(
      "cleanup_outbox",
      new Set(["state", "disposition", "payload", "payload_digest", "updated_at"]),
    );
  }
  return policy;
}

export interface MigrationSecurityContext {
  readonly runtimeRole: string;
  readonly migratorRole: string;
  readonly skillPublisherRole: string;
  readonly workerCoordinatorRole: string;
  readonly teamCoordinatorRole: string;
  readonly adminControlRole: string;
  readonly webhookDispatcherRole?: string;
  readonly schema: string;
}

function quoteIdentifier(value: string): string {
  if (!rolePattern.test(value)) throw new TypeError("数据库角色名称无效");
  return `"${value}"`;
}

function validateContext(context: MigrationSecurityContext): void {
  quoteIdentifier(context.runtimeRole);
  quoteIdentifier(context.migratorRole);
  quoteIdentifier(context.skillPublisherRole);
  quoteIdentifier(context.workerCoordinatorRole);
  quoteIdentifier(context.teamCoordinatorRole);
  quoteIdentifier(context.adminControlRole);
  if (context.webhookDispatcherRole !== undefined) quoteIdentifier(context.webhookDispatcherRole);
  assertSafeSchemaName(context.schema);
  if (
    new Set([
      context.runtimeRole,
      context.migratorRole,
      context.skillPublisherRole,
      context.workerCoordinatorRole,
      context.teamCoordinatorRole,
      context.adminControlRole,
      ...(context.webhookDispatcherRole === undefined ? [] : [context.webhookDispatcherRole]),
    ]).size !== (context.webhookDispatcherRole === undefined ? 6 : 7)
  ) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      "Runtime、Migrator、Skill Publisher、Worker Coordinator、Team Coordinator 与 Admin Control 必须使用不同角色",
    );
  }
}

interface WorkerCoordinatorSafetyRow {
  readonly coordinator_missing: boolean;
  readonly coordinator_cannot_login: boolean;
  readonly coordinator_has_parent: boolean;
  readonly coordinator_has_member: boolean;
  readonly coordinator_dangerous: boolean;
  readonly coordinator_inherits: boolean;
  readonly coordinator_owns_database: boolean;
  readonly coordinator_owns_schema: boolean;
  readonly coordinator_owns_relation: boolean;
  readonly coordinator_owns_routine: boolean;
  readonly coordinator_owns_object: boolean;
  readonly coordinator_can_create_database_object: boolean;
  readonly coordinator_can_create_schema_object: boolean;
  readonly coordinator_can_create_temporary_object: boolean;
}

async function inspectWorkerCoordinator(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<WorkerCoordinatorSafetyRow | undefined> {
  const result = await client.query<WorkerCoordinatorSafetyRow>(
    `WITH coordinator AS (SELECT * FROM pg_roles WHERE rolname=$1)
     SELECT
       NOT EXISTS (SELECT 1 FROM coordinator) AS coordinator_missing,
       EXISTS (SELECT 1 FROM coordinator WHERE NOT rolcanlogin) AS coordinator_cannot_login,
       EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM coordinator))
         AS coordinator_has_parent,
       EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid=(SELECT oid FROM coordinator))
         AS coordinator_has_member,
       EXISTS (
         SELECT 1 FROM coordinator
          WHERE rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
       ) AS coordinator_dangerous,
       EXISTS (SELECT 1 FROM coordinator WHERE rolinherit) AS coordinator_inherits,
       EXISTS (
         SELECT 1 FROM pg_database WHERE datdba=(SELECT oid FROM coordinator)
       ) AS coordinator_owns_database,
       EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM coordinator)
       ) AS coordinator_owns_schema,
       EXISTS (
         SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM coordinator)
       ) AS coordinator_owns_relation,
       EXISTS (
         SELECT 1 FROM pg_proc WHERE proowner=(SELECT oid FROM coordinator)
       ) AS coordinator_owns_routine,
       EXISTS (
         SELECT 1 FROM (
           SELECT typowner AS owner_oid FROM pg_type
           UNION ALL SELECT oprowner FROM pg_operator
           UNION ALL SELECT conowner FROM pg_conversion
           UNION ALL SELECT collowner FROM pg_collation
           UNION ALL SELECT cfgowner FROM pg_ts_config
           UNION ALL SELECT dictowner FROM pg_ts_dict
         ) owned_object WHERE owned_object.owner_oid=(SELECT oid FROM coordinator)
       ) AS coordinator_owns_object,
       COALESCE(has_database_privilege(
         (SELECT oid FROM coordinator),current_database(),'CREATE'
       ),false) AS coordinator_can_create_database_object,
       COALESCE(has_schema_privilege(
         (SELECT oid FROM coordinator),$2,'CREATE'
       ),false) AS coordinator_can_create_schema_object,
       COALESCE(has_database_privilege(
         (SELECT oid FROM coordinator),current_database(),'TEMP'
       ),false) AS coordinator_can_create_temporary_object`,
    [context.workerCoordinatorRole, context.schema],
  );
  return result.rows[0];
}

async function assertWorkerCoordinatorContextSafe(
  client: PoolClient,
  context: MigrationSecurityContext,
  allowSchemaCreate = false,
): Promise<void> {
  const state = await inspectWorkerCoordinator(client, context);
  if (
    state === undefined ||
    Object.entries(state).some(
      ([name, unsafe]) =>
        unsafe && !(allowSchemaCreate && name === "coordinator_can_create_schema_object"),
    )
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Worker Coordinator 数据库角色边界不安全");
  }
}

interface MigrationContextSafetyRow {
  readonly runtime_missing: boolean;
  readonly runtime_has_parent: boolean;
  readonly runtime_dangerous: boolean;
  readonly runtime_owns_database: boolean;
  readonly runtime_owns_schema: boolean;
  readonly runtime_owns_relation: boolean;
  readonly runtime_can_create_database_object: boolean;
  readonly runtime_can_create_schema_object: boolean;
  readonly runtime_can_create_temporary_object: boolean;
  readonly migrator_missing: boolean;
  readonly migrator_is_not_current_user: boolean;
  readonly migrator_has_parent: boolean;
  readonly migrator_dangerous: boolean;
  readonly migrator_owns_database: boolean;
  readonly migrator_can_create_database_object: boolean;
  readonly migrator_can_create_other_schema_object: boolean;
  readonly migrator_has_routine_default_acl: boolean;
  readonly migrator_owns_other_schema: boolean;
  readonly migrator_owns_cross_schema_relation: boolean;
  readonly target_schema_has_prohibited_owned_object: boolean;
  readonly migrator_owns_cross_schema_routine: boolean;
  readonly migrator_owns_cross_schema_object: boolean;
  readonly publisher_missing: boolean;
  readonly publisher_cannot_login: boolean;
  readonly publisher_has_parent: boolean;
  readonly publisher_has_member: boolean;
  readonly publisher_dangerous: boolean;
  readonly publisher_inherits: boolean;
  readonly publisher_owns_database: boolean;
  readonly publisher_owns_schema: boolean;
  readonly publisher_owns_relation: boolean;
  readonly publisher_owns_routine: boolean;
  readonly publisher_owns_object: boolean;
  readonly publisher_can_create_database_object: boolean;
  readonly publisher_can_create_schema_object: boolean;
  readonly publisher_can_create_temporary_object: boolean;
  readonly schema_missing: boolean;
  readonly migrator_is_not_schema_owner: boolean;
  readonly current_schema_mismatch: boolean;
  readonly search_path_mismatch: boolean;
}

/**
 * Runtime 禁止任何上游成员关系，包括 NOINHERIT 但仍可 SET ROLE 的成员关系。
 * Migrator 必须是当前专用 Schema 的直接 owner，且不能借成员关系或数据库权限扩大边界。
 */
async function inspectMigrationContext(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<MigrationContextSafetyRow | undefined> {
  validateContext(context);
  const result = await client.query<MigrationContextSafetyRow>(
    `WITH runtime AS (
       SELECT * FROM pg_roles WHERE rolname = $1
     ), migrator AS (
       SELECT * FROM pg_roles WHERE rolname = $2
     ), publisher AS (
       SELECT * FROM pg_roles WHERE rolname = $4
     ), target_schema AS (
       SELECT * FROM pg_namespace WHERE nspname = $3
     )
     SELECT
       NOT EXISTS (SELECT 1 FROM runtime) AS runtime_missing,
       EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM runtime))
         AS runtime_has_parent,
       EXISTS (
         SELECT 1 FROM runtime
          WHERE rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
       ) AS runtime_dangerous,
       EXISTS (
         SELECT 1 FROM pg_database
          WHERE datname = current_database() AND datdba = (SELECT oid FROM runtime)
       ) AS runtime_owns_database,
       EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspowner = (SELECT oid FROM runtime)
       ) AS runtime_owns_schema,
       EXISTS (
         SELECT 1 FROM pg_class
          WHERE relkind IN ('r', 'p', 'S', 'v', 'm')
            AND relowner = (SELECT oid FROM runtime)
       ) AS runtime_owns_relation,
       COALESCE(has_database_privilege(
         (SELECT oid FROM runtime), current_database(), 'CREATE'
       ), false) AS runtime_can_create_database_object,
       COALESCE(has_schema_privilege(
         (SELECT oid FROM runtime), $3, 'CREATE'
       ), false) AS runtime_can_create_schema_object,
       COALESCE(has_database_privilege(
         (SELECT oid FROM runtime), current_database(), 'TEMP'
       ), false) AS runtime_can_create_temporary_object,
       NOT EXISTS (SELECT 1 FROM migrator) AS migrator_missing,
       current_user <> $2 AS migrator_is_not_current_user,
       EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM migrator))
         AS migrator_has_parent,
       EXISTS (
         SELECT 1 FROM migrator
          WHERE rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
       ) AS migrator_dangerous,
       EXISTS (
         SELECT 1 FROM pg_database
          WHERE datname = current_database() AND datdba = (SELECT oid FROM migrator)
       ) AS migrator_owns_database,
       COALESCE(has_database_privilege(
         (SELECT oid FROM migrator), current_database(), 'CREATE'
       ), false) AS migrator_can_create_database_object,
       EXISTS (
         SELECT 1 FROM pg_namespace schema_state
          WHERE schema_state.nspname <> $3
            AND schema_state.nspname <> 'information_schema'
            AND schema_state.nspname !~ '^pg_'
            AND has_schema_privilege(
              (SELECT oid FROM migrator), schema_state.oid, 'CREATE'
            )
       ) AS migrator_can_create_other_schema_object,
       EXISTS (
         SELECT 1 FROM pg_default_acl defaults
          WHERE defaults.defaclrole = (SELECT oid FROM migrator)
            -- 不解析 grantee：首版连仅 owner 的 routine 默认 ACL 记录也不接受。
            AND defaults.defaclobjtype = 'f'
       ) AS migrator_has_routine_default_acl,
       EXISTS (
         SELECT 1 FROM pg_namespace
          WHERE nspowner = (SELECT oid FROM migrator) AND nspname <> $3
            AND nspname <> 'information_schema' AND nspname !~ '^pg_'
       ) AS migrator_owns_other_schema,
       EXISTS (
         SELECT 1 FROM pg_class relation
         JOIN pg_namespace schema_state ON schema_state.oid = relation.relnamespace
          WHERE relation.relowner = (SELECT oid FROM migrator)
            AND schema_state.nspname <> $3
            AND schema_state.nspname <> 'information_schema'
            AND schema_state.nspname !~ '^pg_'
       ) AS migrator_owns_cross_schema_relation,
       EXISTS (
         SELECT 1 FROM pg_type type_state
          WHERE type_state.typowner = (SELECT oid FROM migrator)
            AND type_state.typnamespace = (SELECT oid FROM target_schema)
            -- 表会自动生成复合类型及数组类型；它们是 relation 附属对象，不是独立 type。
            AND type_state.typrelid = 0
            AND NOT EXISTS (
              SELECT 1 FROM pg_type element_type
               WHERE element_type.oid = type_state.typelem
                 AND element_type.typrelid <> 0
                 AND element_type.typnamespace = (SELECT oid FROM target_schema)
            )
         UNION ALL
         SELECT 1
           FROM (
             SELECT oprnamespace AS namespace_oid, oprowner AS owner_oid FROM pg_operator
             UNION ALL
             SELECT connamespace, conowner FROM pg_conversion
             UNION ALL
             SELECT collnamespace, collowner FROM pg_collation
             UNION ALL
             SELECT cfgnamespace, cfgowner FROM pg_ts_config
             UNION ALL
             SELECT dictnamespace, dictowner FROM pg_ts_dict
           ) owned_object
          WHERE owned_object.owner_oid = (SELECT oid FROM migrator)
            AND owned_object.namespace_oid = (SELECT oid FROM target_schema)
       ) AS target_schema_has_prohibited_owned_object,
       EXISTS (
         SELECT 1 FROM pg_proc routine
         JOIN pg_namespace schema_state ON schema_state.oid = routine.pronamespace
          WHERE routine.proowner = (SELECT oid FROM migrator)
            AND schema_state.nspname <> $3
            AND schema_state.nspname <> 'information_schema'
            AND schema_state.nspname !~ '^pg_'
       ) AS migrator_owns_cross_schema_routine,
       EXISTS (
         SELECT 1
           FROM (
             SELECT typnamespace AS namespace_oid, typowner AS owner_oid FROM pg_type
             UNION ALL
             SELECT oprnamespace, oprowner FROM pg_operator
             UNION ALL
             SELECT connamespace, conowner FROM pg_conversion
             UNION ALL
             SELECT collnamespace, collowner FROM pg_collation
             UNION ALL
             SELECT cfgnamespace, cfgowner FROM pg_ts_config
             UNION ALL
             SELECT dictnamespace, dictowner FROM pg_ts_dict
           ) owned_object
           JOIN pg_namespace schema_state ON schema_state.oid = owned_object.namespace_oid
          WHERE owned_object.owner_oid = (SELECT oid FROM migrator)
            AND schema_state.nspname <> $3
            AND schema_state.nspname <> 'information_schema'
            AND schema_state.nspname !~ '^pg_'
       ) AS migrator_owns_cross_schema_object,
       NOT EXISTS (SELECT 1 FROM publisher) AS publisher_missing,
       EXISTS (SELECT 1 FROM publisher WHERE NOT rolcanlogin) AS publisher_cannot_login,
       EXISTS (SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM publisher))
         AS publisher_has_parent,
       EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = (SELECT oid FROM publisher))
         AS publisher_has_member,
       EXISTS (
         SELECT 1 FROM publisher
          WHERE rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication
       ) AS publisher_dangerous,
       EXISTS (SELECT 1 FROM publisher WHERE rolinherit) AS publisher_inherits,
       EXISTS (
         SELECT 1 FROM pg_database
          WHERE datdba = (SELECT oid FROM publisher)
       ) AS publisher_owns_database,
       EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspowner = (SELECT oid FROM publisher)
       ) AS publisher_owns_schema,
       EXISTS (
         SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM publisher)
       ) AS publisher_owns_relation,
       EXISTS (
         SELECT 1 FROM pg_proc WHERE proowner = (SELECT oid FROM publisher)
       ) AS publisher_owns_routine,
       EXISTS (
         SELECT 1
           FROM (
             SELECT typowner AS owner_oid FROM pg_type
             UNION ALL SELECT oprowner FROM pg_operator
             UNION ALL SELECT conowner FROM pg_conversion
             UNION ALL SELECT collowner FROM pg_collation
             UNION ALL SELECT cfgowner FROM pg_ts_config
             UNION ALL SELECT dictowner FROM pg_ts_dict
           ) owned_object
          WHERE owned_object.owner_oid = (SELECT oid FROM publisher)
       ) AS publisher_owns_object,
       COALESCE(has_database_privilege(
         (SELECT oid FROM publisher), current_database(), 'CREATE'
       ), false) AS publisher_can_create_database_object,
       EXISTS (
         SELECT 1
           FROM target_schema
           CROSS JOIN LATERAL aclexplode(
             COALESCE(target_schema.nspacl, acldefault('n'::"char", target_schema.nspowner))
           ) acl
          WHERE acl.grantee = (SELECT oid FROM publisher)
            AND acl.privilege_type = 'CREATE'
       ) AS publisher_can_create_schema_object,
       COALESCE(has_database_privilege(
         (SELECT oid FROM publisher), current_database(), 'TEMP'
       ), false) AS publisher_can_create_temporary_object,
       NOT EXISTS (SELECT 1 FROM target_schema) AS schema_missing,
       NOT EXISTS (
         SELECT 1 FROM target_schema WHERE nspowner = (SELECT oid FROM migrator)
       ) AS migrator_is_not_schema_owner,
       current_schema() IS DISTINCT FROM $3 AS current_schema_mismatch,
       current_setting('search_path') IS DISTINCT FROM $3 AS search_path_mismatch`,
    [context.runtimeRole, context.migratorRole, context.schema, context.skillPublisherRole],
  );
  return result.rows[0];
}

function assertInspectedContextSafe(
  state: MigrationContextSafetyRow | undefined,
  allowRuntimeSchemaCreate: boolean,
): void {
  if (
    state === undefined ||
    Object.entries(state).some(
      ([name, unsafe]) =>
        unsafe && !(allowRuntimeSchemaCreate && name === "runtime_can_create_schema_object"),
    )
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "数据库迁移角色或 Schema 边界不安全");
  }
}

export async function assertMigrationContextSafe(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  await assertDatabaseRolesCurrentDatabaseScoped(client, context);
  assertInspectedContextSafe(await inspectMigrationContext(client, context), false);
  await assertWorkerCoordinatorContextSafe(client, context);
  await assertWorkerCoordinatorContextSafe(client, {
    ...context,
    workerCoordinatorRole: context.teamCoordinatorRole,
  });
  await assertWorkerCoordinatorContextSafe(client, {
    ...context,
    workerCoordinatorRole: context.adminControlRole,
  });
  if (context.webhookDispatcherRole !== undefined)
    await assertWorkerCoordinatorContextSafe(client, {
      ...context,
      workerCoordinatorRole: context.webhookDispatcherRole,
    });
}

async function assertBootstrapContextSafe(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  await assertDatabaseRolesCurrentDatabaseScoped(client, context);
  // 独立修复 ACL 时允许先清理来自 PUBLIC/直接授权的目标 Schema CREATE；其余边界不放宽。
  assertInspectedContextSafe(await inspectMigrationContext(client, context), true);
  await assertWorkerCoordinatorContextSafe(client, context, true);
  await assertWorkerCoordinatorContextSafe(
    client,
    {
      ...context,
      workerCoordinatorRole: context.teamCoordinatorRole,
    },
    true,
  );
  await assertWorkerCoordinatorContextSafe(
    client,
    {
      ...context,
      workerCoordinatorRole: context.adminControlRole,
    },
    true,
  );
  if (context.webhookDispatcherRole !== undefined)
    await assertWorkerCoordinatorContextSafe(
      client,
      { ...context, workerCoordinatorRole: context.webhookDispatcherRole },
      true,
    );
}

interface RoleDatabaseScopeRow {
  readonly requested_role: string;
  readonly role_name: string | null;
  readonly outside_database_names_json: string;
}

export interface DatabaseRoleScopeInspection {
  readonly missingRoles: readonly string[];
  readonly reusedRoles: ReadonlyArray<{
    readonly role: string;
    readonly databases: readonly string[];
  }>;
}

export function databaseRoles(context: MigrationSecurityContext): readonly string[] {
  return [
    context.runtimeRole,
    context.migratorRole,
    context.skillPublisherRole,
    context.workerCoordinatorRole,
    context.teamCoordinatorRole,
    context.adminControlRole,
    ...(context.webhookDispatcherRole === undefined ? [] : [context.webhookDispatcherRole]),
  ];
}

/** 返回角色缺失与跨库依赖的可操作诊断；结果只包含角色名和数据库名，不包含连接凭据。 */
export async function inspectDatabaseRoleScope(
  client: PoolClient,
  requestedRoles: readonly string[],
): Promise<DatabaseRoleScopeInspection> {
  const result = await client.query<RoleDatabaseScopeRow>(
    `SELECT requested.role_name AS requested_role,
            role.rolname AS role_name,
            coalesce(
              jsonb_agg(DISTINCT database.datname ORDER BY database.datname) FILTER (
                WHERE dependency.dbid<>0
                  AND dependency.dbid<>(SELECT oid FROM pg_database WHERE datname=current_database())
                  AND database.datname IS NOT NULL
              ),
              '[]'::jsonb
            )::text AS outside_database_names_json
       FROM unnest($1::text[]) requested(role_name)
       LEFT JOIN pg_roles role ON role.rolname=requested.role_name
       LEFT JOIN pg_shdepend dependency
         ON dependency.refclassid='pg_authid'::regclass AND dependency.refobjid=role.oid
       LEFT JOIN pg_database database ON database.oid=dependency.dbid
      GROUP BY requested.role_name,role.rolname
      ORDER BY requested.role_name`,
    [requestedRoles],
  );
  if (result.rows.length !== requestedRoles.length) {
    throw new PersistenceError("UNEXPECTED", "数据库角色作用域检查结果不完整");
  }
  const inspectedRows = result.rows.map((row) => {
    let databases: unknown;
    try {
      databases = JSON.parse(row.outside_database_names_json);
    } catch {
      throw new PersistenceError("UNEXPECTED", "数据库角色作用域检查结果无法解析");
    }
    if (!Array.isArray(databases) || databases.some((database) => typeof database !== "string")) {
      throw new PersistenceError("UNEXPECTED", "数据库角色作用域检查结果无法解析");
    }
    return { row, databases };
  });
  return {
    missingRoles: inspectedRows
      .filter(({ row }) => row.role_name === null)
      .map(({ row }) => row.requested_role),
    reusedRoles: inspectedRows
      .filter(({ databases }) => databases.length > 0)
      .map(({ row, databases }) => ({ role: row.requested_role, databases })),
  };
}

/**
 * PostgreSQL 登录角色和密码属于整个集群；不同数据库复用角色会让任一环境的密码轮换击穿其他环境。
 * 迁移与 ACL 修复都必须在任何 DDL/GRANT 前拒绝这种共享，迫使部署使用数据库专属角色。
 */
export async function assertDatabaseRolesCurrentDatabaseScoped(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const inspection = await inspectDatabaseRoleScope(client, databaseRoles(context));
  if (inspection.missingRoles.length > 0) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `缺少数据库应用角色：${inspection.missingRoles.join(", ")}；请先运行 pnpm db:roles:bootstrap`,
    );
  }
  if (inspection.reusedRoles.length > 0) {
    const details = inspection.reusedRoles
      .map(({ role, databases }) => `${role} -> ${databases.join("/")}`)
      .join(", ");
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `数据库应用角色被其他数据库复用：${details}`,
    );
  }
}

interface PrivilegeRow {
  readonly table_name: string;
  readonly privilege: string;
  readonly allowed: boolean;
}

interface EffectiveBoundaryRow {
  readonly schema_usage: boolean;
  readonly schema_create: boolean;
  readonly database_connect: boolean;
  readonly database_create: boolean;
  readonly database_temporary: boolean;
}

async function activeTeamCoordinatorTablePolicy(
  client: PoolClient,
  schema: string,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  if (!(await hasTeamCollaborationState(client, schema))) return new Map();
  const policy = new Map(await activeTablePolicy(client, schema));
  // Team Coordinator 只为解散时的批量取消入队：订阅表仅有列级 SELECT（见 grantWebhookAccess），
  // Outbox 只保留继承自 Runtime 的 INSERT。
  policy.delete("tenant_webhooks");
  for (const table of localAccountTables) policy.set(table, new Set());
  policy.set("team_member_directory", new Set(["SELECT", "INSERT"]));
  if (await hasPersonalizationSettingsState(client, schema)) {
    policy.set("team_personalization_settings", new Set(["SELECT", "INSERT"]));
  }
  return policy;
}

async function activeTeamCoordinatorColumnUpdatePolicy(
  client: PoolClient,
  schema: string,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  if (!(await hasTeamCollaborationState(client, schema))) return new Map();
  const policy = new Map(await activeColumnUpdatePolicy(client, schema));
  // 显式移除 Webhook 表：Team Coordinator 不得改写订阅密文、停用状态或任何 Outbox 列。
  policy.delete("tenant_webhooks");
  policy.delete("webhook_outbox");
  const membershipColumns = new Set(policy.get("memberships") ?? []);
  membershipColumns.add("role");
  membershipColumns.add("status");
  policy.set("memberships", membershipColumns);
  policy.set("team_member_directory", new Set(["role", "status", "updated_at"]));
  if (await hasPersonalizationSettingsState(client, schema)) {
    policy.set(
      "team_personalization_settings",
      new Set(["content", "version", "updated_by_user_id", "updated_at"]),
    );
  }
  return policy;
}

async function grantTeamCoordinatorAccess(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const tablePolicy = await activeTeamCoordinatorTablePolicy(client, context.schema);
  if (tablePolicy.size === 0) return;
  const role = quoteIdentifier(context.teamCoordinatorRole);
  const schema = quoteIdentifier(context.schema);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  for (const [table, privileges] of tablePolicy) {
    if (privileges.size === 0) continue;
    await client.query(
      `GRANT ${[...privileges].join(", ")} ON TABLE ${schema}.${quoteIdentifier(table)} TO ${role}`,
    );
  }
  const columnPolicy = await activeTeamCoordinatorColumnUpdatePolicy(client, context.schema);
  for (const [table, columns] of columnPolicy) {
    if (columns.size === 0) continue;
    await client.query(
      `GRANT UPDATE(${[...columns].map(quoteIdentifier).join(", ")}) ON TABLE ${schema}.${quoteIdentifier(table)} TO ${role}`,
    );
  }
}

async function assertTeamCoordinatorBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
  enabled: boolean,
): Promise<void> {
  const tablePolicy = enabled
    ? await activeTeamCoordinatorTablePolicy(client, context.schema)
    : new Map<string, ReadonlySet<string>>();
  const relations = await client.query<{ readonly table_name: string }>(
    `SELECT relname AS table_name FROM pg_class
      WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p')`,
  );
  const privileges = await client.query<PrivilegeRow>(
    `SELECT target.table_name,requested.privilege,
            has_table_privilege(
              $1,format('%I.%I',$2::text,target.table_name),requested.privilege
            ) AS allowed
       FROM unnest($3::text[]) AS target(table_name)
       CROSS JOIN unnest($4::text[]) AS requested(privilege)`,
    [
      context.teamCoordinatorRole,
      context.schema,
      relations.rows.map((row) => row.table_name),
      tablePrivileges,
    ],
  );
  for (const row of privileges.rows) {
    if (row.allowed !== (tablePolicy.get(row.table_name)?.has(row.privilege) ?? false)) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `Team Coordinator 表权限偏离白名单：${row.table_name}.${row.privilege}`,
      );
    }
  }

  const columnPolicy = enabled
    ? await activeTeamCoordinatorColumnUpdatePolicy(client, context.schema)
    : new Map<string, ReadonlySet<string>>();
  if (columnPolicy.size > 0) {
    const updates = await client.query<{
      readonly table_name: string;
      readonly column_name: string;
      readonly allowed: boolean;
    }>(
      `SELECT column_state.table_name,column_state.column_name,
              has_column_privilege(
                $1,format('%I.%I',$2::text,column_state.table_name),
                column_state.column_name,'UPDATE'
              ) AS allowed
         FROM information_schema.columns column_state
        WHERE column_state.table_schema=$2
          AND column_state.table_name=ANY($3::text[])`,
      [context.teamCoordinatorRole, context.schema, [...columnPolicy.keys()]],
    );
    for (const row of updates.rows) {
      if (row.allowed !== columnPolicy.get(row.table_name)?.has(row.column_name)) {
        throw new PersistenceError(
          "CONSTRAINT_VIOLATION",
          `Team Coordinator 列级 UPDATE 权限偏离白名单：${row.table_name}.${row.column_name}`,
        );
      }
    }
  }

  const sequences = await client.query<PrivilegeRow>(
    `SELECT relation.relname AS table_name,requested.privilege,
            has_sequence_privilege(
              $1,format('%I.%I',$2::text,relation.relname),requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) AS requested(privilege)
      WHERE relation.relnamespace=current_schema()::regnamespace AND relation.relkind='S'`,
    [context.teamCoordinatorRole, context.schema, sequencePrivileges],
  );
  const grantedSequences = sequences.rows.filter((row) => row.allowed).map((row) => row.table_name);
  if (grantedSequences.length > 0) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `Team Coordinator 不得持有 sequence 权限：${grantedSequences.sort().join(",")}`,
    );
  }
  await assertDatabaseAndSchemaBoundary(
    client,
    { ...context, runtimeRole: context.teamCoordinatorRole },
    enabled,
  );
}

async function assertAdminControlBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
  enabled: boolean,
): Promise<void> {
  const userOperationsEnabled =
    enabled && (await hasAdminUserOperationsState(client, context.schema));
  const runExplorerEnabled = enabled && (await hasAdminRunExplorerState(client, context.schema));
  const integrationTenantDirectoryEnabled =
    enabled && (await hasAdminIntegrationTenantDirectoryState(client, context.schema));
  const identityEnabled = enabled && (await hasEmbeddedIdentityState(client, context.schema));
  const externalToolsEnabled = enabled && (await hasExternalToolState(client, context.schema));
  const sandboxEnabled = enabled && (await hasManagedSandboxState(client, context.schema));
  const integrationsEnabled = enabled && (await hasIntegrationAdminState(client, context.schema));
  const endUsersEnabled = enabled && (await hasApiEndUserState(client, context.schema));
  const allowed = new Map<string, ReadonlySet<string>>(
    enabled
      ? [
          ["platform_control_operators", new Set(["SELECT"])],
          ["admin_control_config_revisions", new Set(["SELECT", "INSERT"])],
          ["admin_control_provider_probes", new Set(["SELECT", "INSERT"])],
          ["admin_control_active_configs", new Set(["SELECT", "INSERT"])],
          ["admin_control_activation_events", new Set(["SELECT", "INSERT"])],
          ["admin_control_commands", new Set(["SELECT", "INSERT"])],
          ["admin_control_audits", new Set(["SELECT", "INSERT"])],
          ["admin_control_generation", new Set(["SELECT"])],
        ]
      : [],
  );
  if (externalToolsEnabled) {
    allowed.set("external_tool_versions", new Set(["SELECT", "INSERT"]));
    allowed.set("external_tool_credentials", new Set(["INSERT"]));
    allowed.set("external_tool_revocations", new Set(["SELECT", "INSERT"]));
  }
  if (integrationsEnabled) {
    allowed.set("api_keys", new Set(["SELECT", "INSERT"]));
    allowed.set("app_users", new Set(["INSERT"]));
    allowed.set("memberships", new Set(["INSERT"]));
    allowed.set("tenant_webhooks", new Set(["INSERT"]));
    allowed.set("integration_admin_audits", new Set(["SELECT", "INSERT"]));
  }
  if (endUsersEnabled) allowed.set("api_end_users", new Set(["SELECT"]));
  const externalToolAdminEnabled =
    enabled && (await hasExternalToolAdminState(client, context.schema));
  if (externalToolAdminEnabled) {
    allowed.set("external_tool_registration_drafts", new Set(["SELECT", "INSERT"]));
    allowed.set("external_tool_draft_credentials", new Set(["SELECT", "INSERT", "DELETE"]));
    for (const table of [
      "external_tool_publish_batches",
      "external_tool_publish_batch_versions",
      "external_tool_admin_publish_claims",
      "external_tool_admin_commands",
      "external_tool_admin_audits",
    ])
      allowed.set(table, new Set(["SELECT", "INSERT"]));
  }
  const agentDefinitionsEnabled =
    enabled && (await hasAgentDefinitionState(client, context.schema));
  if (agentDefinitionsEnabled) {
    allowed.set("skills", new Set(["SELECT"]));
    allowed.set("skill_versions", new Set(["SELECT"]));
  }
  if (agentDefinitionsEnabled) {
    allowed.set("agent_definitions", new Set(["SELECT", "INSERT"]));
    allowed.set("agent_definition_tenants", new Set(["SELECT", "INSERT", "DELETE"]));
    allowed.set("agent_revisions", new Set(["SELECT", "INSERT"]));
    allowed.set("agent_revision_revocations", new Set(["SELECT", "INSERT"]));
    allowed.set("agent_definition_commands", new Set(["SELECT", "INSERT"]));
    allowed.set("agent_definition_audits", new Set(["SELECT", "INSERT"]));
  }
  if (sandboxEnabled) {
    for (const table of managedSandboxControlTables)
      allowed.set(table, new Set(["SELECT", "INSERT"]));
  }
  if (userOperationsEnabled) {
    allowed.set("admin_user_account_audits", new Set(["SELECT", "INSERT"]));
    allowed.set("user_sessions", new Set(["DELETE"]));
  }
  if (runExplorerEnabled) {
    allowed.set("admin_run_content_access_audits", new Set(["SELECT", "INSERT"]));
  }
  if (identityEnabled) {
    allowed.set("identity_auth_configuration", new Set(["SELECT", "INSERT", "UPDATE"]));
    allowed.set("identity_auth_audits", new Set(["SELECT", "INSERT"]));
    allowed.set("identity_auth_commands", new Set(["SELECT", "INSERT"]));
    allowed.set("better_auth_sessions", new Set(["DELETE"]));
  }
  const relations = await client.query<{ readonly table_name: string }>(
    `SELECT relname AS table_name FROM pg_class
      WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p')`,
  );
  const privileges = await client.query<PrivilegeRow>(
    `SELECT target.table_name,requested.privilege,
            has_table_privilege(
              $1,format('%I.%I',$2::text,target.table_name),requested.privilege
            ) AS allowed
       FROM unnest($3::text[]) AS target(table_name)
       CROSS JOIN unnest($4::text[]) AS requested(privilege)`,
    [
      context.adminControlRole,
      context.schema,
      relations.rows.map((row) => row.table_name),
      tablePrivileges,
    ],
  );
  for (const row of privileges.rows) {
    if (row.allowed !== (allowed.get(row.table_name)?.has(row.privilege) ?? false)) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `Admin Control 表权限偏离白名单：${row.table_name}.${row.privilege}`,
      );
    }
  }

  const updatePolicy = new Map<string, ReadonlySet<string>>(
    enabled
      ? [
          [
            "admin_control_active_configs",
            new Set([
              "object_key",
              "revision",
              "generation",
              "activated_by",
              "reason",
              "activated_at",
            ]),
          ],
          ["admin_control_generation", new Set(["generation", "updated_at"])],
        ]
      : [],
  );
  if (integrationsEnabled) {
    updatePolicy.set("api_keys", new Set(["key_hash", "key_prefix", "revoked_at"]));
    updatePolicy.set("memberships", new Set(["status"]));
    updatePolicy.set("tenant_webhooks", new Set(webhookRuntimeUpdateColumns));
  }
  if (sandboxEnabled)
    updatePolicy.set("sandbox_control_head", new Set(["generation", "routing_revision"]));
  if (agentDefinitionsEnabled)
    updatePolicy.set(
      "agent_definitions",
      new Set(["status", "generation", "availability_mode", "current_revision_id", "updated_at"]),
    );
  if (agentDefinitionsEnabled) updatePolicy.set("agent_definition_tenants", new Set(["available"]));
  if (agentDefinitionsEnabled) updatePolicy.set("agent_revisions", new Set(["status"]));
  if (externalToolAdminEnabled)
    updatePolicy.set("external_tool_registration_drafts", new Set(externalToolDraftUpdateColumns));
  if (externalToolAdminEnabled)
    updatePolicy.set(
      "external_tool_admin_publish_claims",
      new Set(["lease_owner", "lease_expires_at"]),
    );
  if (userOperationsEnabled) {
    updatePolicy.set("user_accounts", new Set(["status", "updated_at"]));
  }
  if (endUsersEnabled) updatePolicy.set("api_end_users", new Set(["status"]));
  if (updatePolicy.size > 0) {
    const updates = await client.query<{
      readonly table_name: string;
      readonly column_name: string;
      readonly allowed: boolean;
    }>(
      `SELECT column_state.table_name,column_state.column_name,
              has_column_privilege(
                $1,format('%I.%I',$2::text,column_state.table_name),
                column_state.column_name,'UPDATE'
              ) AS allowed
         FROM information_schema.columns column_state
        WHERE column_state.table_schema=$2
          AND column_state.table_name=ANY($3::text[])`,
      [context.adminControlRole, context.schema, [...updatePolicy.keys()]],
    );
    for (const row of updates.rows) {
      if (row.allowed !== updatePolicy.get(row.table_name)?.has(row.column_name)) {
        throw new PersistenceError(
          "CONSTRAINT_VIOLATION",
          `Admin Control 列级 UPDATE 权限偏离白名单：${row.table_name}.${row.column_name}`,
        );
      }
    }
  }

  const selectPolicy = new Map<string, ReadonlySet<string>>();
  if (integrationsEnabled) {
    selectPolicy.set("app_users", new Set(["id", "kind"]));
    selectPolicy.set("tenants", new Set(["id"]));
    selectPolicy.set("memberships", new Set(["tenant_id", "user_id", "role", "status"]));
    selectPolicy.set("tenant_webhooks", new Set(webhookAdminSelectColumns));
  }
  if (userOperationsEnabled) {
    selectPolicy.set(
      "user_accounts",
      new Set(identityEnabled ? ["user_id", "better_auth_user_id"] : ["user_id"]),
    );
    selectPolicy.set("user_sessions", new Set(["user_id"]));
  }
  if (selectPolicy.size > 0) {
    const selects = await client.query<{
      readonly table_name: string;
      readonly column_name: string;
      readonly allowed: boolean;
    }>(
      `SELECT column_state.table_name,column_state.column_name,
              has_column_privilege(
                $1,format('%I.%I',$2::text,column_state.table_name),
                column_state.column_name,'SELECT'
              ) AS allowed
         FROM information_schema.columns column_state
        WHERE column_state.table_schema=$2
          AND column_state.table_name=ANY($3::text[])`,
      [context.adminControlRole, context.schema, [...selectPolicy.keys()]],
    );
    for (const row of selects.rows) {
      if (row.allowed !== selectPolicy.get(row.table_name)?.has(row.column_name)) {
        throw new PersistenceError(
          "CONSTRAINT_VIOLATION",
          `Admin Control 列级 SELECT 权限偏离白名单：${row.table_name}.${row.column_name}`,
        );
      }
    }
  }

  const viewPrivileges = await client.query<{
    readonly view_name: string;
    readonly allowed: boolean;
  }>(
    `SELECT target.view_name,
            CASE WHEN to_regclass(format('%I.%I',$2::text,target.view_name)) IS NULL
                 THEN false
                 ELSE has_table_privilege(
                   $1,format('%I.%I',$2::text,target.view_name),'SELECT'
                 ) END AS allowed
       FROM unnest($3::text[]) AS target(view_name)`,
    [
      context.adminControlRole,
      context.schema,
      [
        "admin_runtime_statistics",
        "admin_user_directory",
        "external_tool_selectable_versions",
        ...adminRunExplorerViews,
        "admin_integration_tenant_directory",
      ],
    ],
  );
  for (const row of viewPrivileges.rows) {
    const expected =
      row.view_name === "admin_runtime_statistics"
        ? enabled
        : row.view_name === "admin_user_directory"
          ? userOperationsEnabled
          : row.view_name === "external_tool_selectable_versions"
            ? externalToolAdminEnabled
            : row.view_name === "admin_integration_tenant_directory"
              ? integrationTenantDirectoryEnabled
              : runExplorerEnabled;
    if (row.allowed !== expected) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `Admin Control 受限视图权限偏离白名单：${row.view_name}.SELECT`,
      );
    }
  }
  await assertDatabaseAndSchemaBoundary(
    client,
    { ...context, runtimeRole: context.adminControlRole },
    enabled,
  );
}

async function assertDatabaseAndSchemaBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
  schemaUsage: boolean,
): Promise<void> {
  const result = await client.query<EffectiveBoundaryRow>(
    `SELECT has_schema_privilege($1, $2, 'USAGE') AS schema_usage,
            has_schema_privilege($1, $2, 'CREATE') AS schema_create,
            has_database_privilege($1, current_database(), 'CONNECT') AS database_connect,
            has_database_privilege($1, current_database(), 'CREATE') AS database_create,
            has_database_privilege($1, current_database(), 'TEMP') AS database_temporary`,
    [context.runtimeRole, context.schema],
  );
  if (
    result.rows[0]?.schema_usage !== schemaUsage ||
    result.rows[0]?.schema_create !== false ||
    result.rows[0]?.database_connect !== true ||
    result.rows[0]?.database_create !== false ||
    result.rows[0]?.database_temporary !== false
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 数据库或 Schema 权限偏离白名单");
  }
}

async function assertNoPublicRelationPrivileges(client: PoolClient): Promise<void> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_class relation
       CROSS JOIN LATERAL aclexplode(
         COALESCE(relation.relacl, acldefault(
           CASE WHEN relation.relkind = 'S' THEN 'S'::"char" ELSE 'r'::"char" END,
           relation.relowner
         ))
       ) acl
      WHERE relation.relnamespace = current_schema()::regnamespace
        AND relation.relkind IN ('r', 'p', 'S')
        AND acl.grantee = 0`,
  );
  if (result.rows[0]?.count !== "0") {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "PUBLIC 仍持有业务对象权限");
  }
}

async function assertNoPublicSchemaPrivileges(client: PoolClient): Promise<void> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_namespace schema_state
       CROSS JOIN LATERAL aclexplode(
         COALESCE(schema_state.nspacl, acldefault('n'::"char", schema_state.nspowner))
       ) acl
      WHERE schema_state.oid = current_schema()::regnamespace
        AND acl.grantee = 0`,
  );
  if (result.rows[0]?.count !== "0") {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "PUBLIC 仍持有业务 Schema 权限");
  }
}

async function assertRoutinePrivilegeBoundary(client: PoolClient): Promise<void> {
  const routines = await client.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM pg_proc
      WHERE pronamespace = current_schema()::regnamespace`,
  );
  if (routines.rows[0]?.count !== "0") {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "业务 Schema 不得包含 Routine");
  }
}

async function assertSkillPublisherBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
  enabled: boolean,
): Promise<void> {
  const allowed = new Map<string, ReadonlySet<string>>(
    enabled
      ? [
          ["platform_skill_operators", new Set(["SELECT"])],
          ["skill_publication_submissions", new Set(["SELECT", "INSERT"])],
          ["skill_publication_files", new Set(["SELECT", "INSERT"])],
          ["skill_publication_commands", new Set(["SELECT", "INSERT"])],
          ["skill_publication_audits", new Set(["SELECT", "INSERT"])],
          ["skills", new Set(["INSERT", "SELECT"])],
          ["skill_versions", new Set(["SELECT", "INSERT"])],
          ["skill_version_files", new Set(["SELECT", "INSERT"])],
        ]
      : [],
  );
  const relations = await client.query<{ readonly table_name: string }>(
    `SELECT relname AS table_name FROM pg_class
      WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p')`,
  );
  const privileges = await client.query<PrivilegeRow>(
    `SELECT target.table_name, requested.privilege,
            has_table_privilege(
              $1, format('%I.%I', $2::text, target.table_name), requested.privilege
            ) AS allowed
       FROM unnest($3::text[]) AS target(table_name)
       CROSS JOIN unnest($4::text[]) AS requested(privilege)`,
    [
      context.skillPublisherRole,
      context.schema,
      relations.rows.map((row) => row.table_name),
      tablePrivileges,
    ],
  );
  for (const row of privileges.rows) {
    if (row.allowed !== (allowed.get(row.table_name)?.has(row.privilege) ?? false)) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `Skill Publisher 表权限偏离白名单：${row.table_name}.${row.privilege}`,
      );
    }
  }

  const updateColumns = new Map<string, ReadonlySet<string>>(
    enabled
      ? [
          [
            "skill_publication_submissions",
            new Set([
              "status",
              "version_token",
              "reviewed_by",
              "rejection_reason",
              "published_skill_id",
              "updated_at",
            ]),
          ],
          ["skills", new Set(["display_name", "recommended_version", "status", "updated_at"])],
          ["skill_versions", new Set(["status"])],
        ]
      : [],
  );
  const columns = await client.query<{
    readonly table_name: string;
    readonly column_name: string;
    readonly allowed: boolean;
  }>(
    `SELECT column_state.table_name,column_state.column_name,
            has_column_privilege(
              $1,format('%I.%I',$2::text,column_state.table_name),column_state.column_name,'UPDATE'
            ) AS allowed
       FROM information_schema.columns column_state
      WHERE column_state.table_schema=$2`,
    [context.skillPublisherRole, context.schema],
  );
  for (const row of columns.rows) {
    if (row.allowed !== (updateColumns.get(row.table_name)?.has(row.column_name) ?? false)) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `Skill Publisher 列级 UPDATE 权限偏离白名单：${row.table_name}.${row.column_name}`,
      );
    }
  }

  const sequences = await client.query<{ readonly allowed: boolean }>(
    `SELECT has_sequence_privilege(
              $1,format('%I.%I',$2::text,relation.relname),requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) requested(privilege)
      WHERE relation.relnamespace=current_schema()::regnamespace AND relation.relkind='S'`,
    [context.skillPublisherRole, context.schema, sequencePrivileges],
  );
  const boundary = await client.query<EffectiveBoundaryRow>(
    `SELECT has_schema_privilege($1,$2,'USAGE') AS schema_usage,
            has_schema_privilege($1,$2,'CREATE') AS schema_create,
            has_database_privilege($1,current_database(),'CONNECT') AS database_connect,
            has_database_privilege($1,current_database(),'CREATE') AS database_create,
            has_database_privilege($1,current_database(),'TEMP') AS database_temporary`,
    [context.skillPublisherRole, context.schema],
  );
  const state = boundary.rows[0];
  if (
    sequences.rows.some((row) => row.allowed) ||
    state?.schema_usage !== enabled ||
    state.schema_create !== false ||
    state.database_connect !== true ||
    state.database_create !== false ||
    state.database_temporary !== false
  ) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      "Skill Publisher 数据库或 Schema 权限偏离白名单",
    );
  }
}

async function assertWorkerCoordinatorBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
  enabled: boolean,
): Promise<void> {
  const relations = await client.query<{ readonly table_name: string }>(
    `SELECT relname AS table_name FROM pg_class
      WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p')`,
  );
  const tableNames = relations.rows.map((row) => row.table_name);
  const privileges = await client.query<PrivilegeRow>(
    `SELECT target.table_name,requested.privilege,
            has_table_privilege(
              $1,format('%I.%I',$2::text,target.table_name),requested.privilege
            ) AS allowed
       FROM unnest($3::text[]) AS target(table_name)
       CROSS JOIN unnest($4::text[]) AS requested(privilege)`,
    [context.workerCoordinatorRole, context.schema, tableNames, tablePrivileges],
  );
  for (const row of privileges.rows) {
    const expected =
      enabled && row.table_name === "worker_tenant_assignments" && row.privilege === "SELECT";
    if (row.allowed !== expected) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `Worker Coordinator 表权限偏离白名单：${row.table_name}.${row.privilege}`,
      );
    }
  }

  const allowedUpdateColumns = new Set([
    "state",
    "generation",
    "claim_token",
    "claimed_by",
    "lease_expires_at",
    "updated_at",
  ]);
  const columnUpdates = await client.query<{
    readonly column_name: string;
    readonly allowed: boolean;
  }>(
    `SELECT column_state.column_name,
            has_column_privilege(
              $1,format('%I.worker_tenant_assignments',$2::text),
              column_state.column_name,'UPDATE'
            ) AS allowed
       FROM information_schema.columns column_state
      WHERE column_state.table_schema=$2
        AND column_state.table_name='worker_tenant_assignments'
      ORDER BY column_state.ordinal_position`,
    [context.workerCoordinatorRole, context.schema],
  );
  for (const row of columnUpdates.rows) {
    if (row.allowed !== (enabled && allowedUpdateColumns.has(row.column_name))) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        "Worker Coordinator claim 列权限偏离白名单",
      );
    }
  }

  const sequences = await client.query<PrivilegeRow>(
    `SELECT relation.relname AS table_name,requested.privilege,
            has_sequence_privilege(
              $1,format('%I.%I',$2::text,relation.relname),requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) AS requested(privilege)
      WHERE relation.relnamespace=current_schema()::regnamespace AND relation.relkind='S'`,
    [context.workerCoordinatorRole, context.schema, sequencePrivileges],
  );
  const routines = await client.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM pg_proc routine
      WHERE routine.pronamespace=current_schema()::regnamespace
        AND has_function_privilege($1,routine.oid,'EXECUTE')`,
    [context.workerCoordinatorRole],
  );
  const boundary = await client.query<EffectiveBoundaryRow>(
    `SELECT has_schema_privilege($1,$2,'USAGE') AS schema_usage,
            has_schema_privilege($1,$2,'CREATE') AS schema_create,
            has_database_privilege($1,current_database(),'CONNECT') AS database_connect,
            has_database_privilege($1,current_database(),'CREATE') AS database_create,
            has_database_privilege($1,current_database(),'TEMP') AS database_temporary`,
    [context.workerCoordinatorRole, context.schema],
  );
  const state = boundary.rows[0];
  if (
    sequences.rows.some((row) => row.allowed) ||
    routines.rows[0]?.count !== "0" ||
    state?.schema_usage !== enabled ||
    state.schema_create !== false ||
    state.database_connect !== true ||
    state.database_create !== false ||
    state.database_temporary !== false
  ) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      "Worker Coordinator 数据库或 Schema 权限偏离白名单",
    );
  }
}

async function assertActiveRuntimeWhitelist(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const tablePolicy = await activeTablePolicy(client, context.schema);
  const columnUpdatePolicy = await activeColumnUpdatePolicy(client, context.schema);
  const relationResult = await client.query<{ table_name: string }>(
    `SELECT relname AS table_name
       FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p')
      ORDER BY relname`,
  );
  const actualTables = relationResult.rows.map((row) => row.table_name);
  const expectedTables = [...tablePolicy.keys()].sort();
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `业务表集合与 Runtime 权限策略不一致：${formatTableSetDifference(expectedTables, actualTables)}`,
    );
  }

  const privileges = await client.query<PrivilegeRow>(
    `SELECT target.table_name, requested.privilege,
            has_table_privilege(
              $1, format('%I.%I', $2::text, target.table_name), requested.privilege
            ) AS allowed
       FROM unnest($3::text[]) AS target(table_name)
       CROSS JOIN unnest($4::text[]) AS requested(privilege)`,
    [context.runtimeRole, context.schema, expectedTables, tablePrivileges],
  );
  for (const row of privileges.rows) {
    if (row.allowed !== tablePolicy.get(row.table_name)?.has(row.privilege)) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `Runtime 表权限偏离白名单：${row.table_name}.${row.privilege}`,
      );
    }
  }

  const columnUpdates = await client.query<{
    table_name: string;
    column_name: string;
    allowed: boolean;
  }>(
    `SELECT column_state.table_name, column_state.column_name,
            has_column_privilege(
              $1,
              format('%I.%I', $2::text, column_state.table_name),
              column_state.column_name,
              'UPDATE'
            ) AS allowed
       FROM information_schema.columns column_state
      WHERE column_state.table_schema = $2
        AND column_state.table_name = ANY($3::text[])
      ORDER BY column_state.table_name, column_state.ordinal_position`,
    [context.runtimeRole, context.schema, [...columnUpdatePolicy.keys()]],
  );
  for (const row of columnUpdates.rows) {
    if (row.allowed !== columnUpdatePolicy.get(row.table_name)?.has(row.column_name)) {
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `Runtime 列级 UPDATE 权限偏离白名单：${row.table_name}.${row.column_name}`,
      );
    }
  }

  const sequences = await client.query<PrivilegeRow>(
    `SELECT relation.relname AS table_name, requested.privilege,
            has_sequence_privilege(
              $1, format('%I.%I', $2::text, relation.relname), requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) AS requested(privilege)
      WHERE relation.relnamespace = current_schema()::regnamespace AND relation.relkind = 'S'`,
    [context.runtimeRole, context.schema, sequencePrivileges],
  );
  const grantedSequences = sequences.rows.filter((row) => row.allowed).map((row) => row.table_name);
  if (grantedSequences.length > 0) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `Runtime 不得持有 sequence 权限：${grantedSequences.sort().join(",")}`,
    );
  }
  const externalSnapshotView = await hasRunExternalToolSnapshotView(client, context.schema);
  if (externalSnapshotView) {
    const privileges = await client.query<{ valid: boolean }>(
      `SELECT NOT has_any_column_privilege($1,format('%I.worker_run_external_tool_snapshots',$3::text),'SELECT')
              AND has_table_privilege($2,format('%I.worker_run_external_tool_snapshots',$3::text),'SELECT')
              AND has_table_privilege($1,format('%I.runtime_external_tool_permit_gate',$3::text),'SELECT') AS valid`,
      [context.runtimeRole, context.workerCoordinatorRole, context.schema],
    );
    if (!privileges.rows[0]?.valid)
      throw new PersistenceError("CONSTRAINT_VIOLATION", "外部工具密文与许可视图权限偏离白名单");
  }
  await assertDatabaseAndSchemaBoundary(client, context, true);
  await assertNoPublicRelationPrivileges(client);
  await assertNoPublicSchemaPrivileges(client);
  await assertRoutinePrivilegeBoundary(client);
  await assertSkillPublisherBoundary(
    client,
    context,
    await hasSkillPublicationState(client, context.schema),
  );
  await assertWorkerCoordinatorBoundary(
    client,
    context,
    await hasWorkerTenantAssignmentState(client, context.schema),
  );
  await assertTeamCoordinatorBoundary(
    client,
    context,
    await hasTeamCollaborationState(client, context.schema),
  );
  await assertAdminControlBoundary(
    client,
    context,
    await hasAdminControlState(client, context.schema),
  );
}

async function assertRuntimeAccessRemoved(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const relations = await client.query<{ table_name: string }>(
    `SELECT relname AS table_name
       FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p')
      ORDER BY relname`,
  );
  const actualTables = relations.rows.map((row) => row.table_name);
  if (JSON.stringify(actualTables) !== JSON.stringify([migrationTable])) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `down 后业务表集合不符：${formatTableSetDifference([migrationTable], actualTables)}`,
    );
  }
  const privileges = await client.query<PrivilegeRow>(
    `SELECT relation.relname AS table_name, requested.privilege,
            has_table_privilege(
              $1, format('%I.%I', $2::text, relation.relname), requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) AS requested(privilege)
      WHERE relation.relnamespace = current_schema()::regnamespace
        AND relation.relkind IN ('r', 'p')`,
    [context.runtimeRole, context.schema, tablePrivileges],
  );
  const grantedTablePrivileges = privileges.rows
    .filter((row) => row.allowed)
    .map((row) => `${row.table_name}.${row.privilege}`)
    .sort();
  if (grantedTablePrivileges.length > 0) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `down 后 Runtime 仍持有表权限：${grantedTablePrivileges.join(",")}`,
    );
  }
  const sequences = await client.query<PrivilegeRow>(
    `SELECT relation.relname AS table_name, requested.privilege,
            has_sequence_privilege(
              $1, format('%I.%I', $2::text, relation.relname), requested.privilege
            ) AS allowed
       FROM pg_class relation
       CROSS JOIN unnest($3::text[]) AS requested(privilege)
      WHERE relation.relnamespace = current_schema()::regnamespace AND relation.relkind = 'S'`,
    [context.runtimeRole, context.schema, sequencePrivileges],
  );
  const remainingSequences = sequences.rows
    .filter((row) => row.allowed)
    .map((row) => row.table_name)
    .sort();
  if (remainingSequences.length > 0) {
    throw new PersistenceError(
      "CONSTRAINT_VIOLATION",
      `down 后 Runtime 仍持有 sequence 权限：${remainingSequences.join(",")}`,
    );
  }
  await assertDatabaseAndSchemaBoundary(client, context, false);
  await assertNoPublicRelationPrivileges(client);
  await assertNoPublicSchemaPrivileges(client);
  await assertRoutinePrivilegeBoundary(client);
  await assertSkillPublisherBoundary(client, context, false);
  await assertWorkerCoordinatorBoundary(client, context, false);
  await assertTeamCoordinatorBoundary(client, context, false);
  await assertAdminControlBoundary(client, context, false);
}

const skillPublisherPolicyBindings = Object.freeze([
  ["platform_skill_operators", "platform_skill_operators_migrator_policy", "migrator"],
  ["skill_publication_submissions", "skill_publication_submissions_migrator_policy", "migrator"],
  ["skill_publication_files", "skill_publication_files_migrator_policy", "migrator"],
  ["skill_publication_commands", "skill_publication_commands_migrator_policy", "migrator"],
  ["skill_publication_audits", "skill_publication_audits_migrator_policy", "migrator"],
  ["platform_skill_operators", "platform_skill_operators_publisher_read_policy", "publisher"],
  ["skill_publication_submissions", "skill_publication_submissions_publisher_policy", "publisher"],
  ["skill_publication_files", "skill_publication_files_publisher_policy", "publisher"],
  ["skill_publication_commands", "skill_publication_commands_publisher_policy", "publisher"],
  ["skill_publication_audits", "skill_publication_audits_publisher_policy", "publisher"],
  ["skills", "skills_admin_publisher_policy", "publisher"],
  ["skill_versions", "skill_versions_admin_publisher_policy", "publisher"],
  ["skill_version_files", "skill_version_files_admin_publisher_policy", "publisher"],
] as const);

const externalToolDraftUpdateColumns = Object.freeze([
  "display_name",
  "server_name",
  "endpoint",
  "timeout_ms",
  "max_response_bytes",
  "side_effect",
  "idempotent",
  "credential_configured",
  "generation",
  "updated_by",
  "updated_at",
] as const);

// 外部工具管理面表：Runtime 零 ACL，仅 Admin Control 按白名单持有权限。
const externalToolAdminTables = Object.freeze([
  "external_tool_registration_drafts",
  "external_tool_draft_credentials",
  "external_tool_publish_batches",
  "external_tool_publish_batch_versions",
  "external_tool_admin_publish_claims",
  "external_tool_admin_commands",
  "external_tool_admin_audits",
] as const);

const adminControlPolicyBindings = Object.freeze([
  ["platform_control_operators", "platform_control_operators_migrator_policy", "migrator"],
  ["admin_control_config_revisions", "admin_control_config_revisions_migrator_policy", "migrator"],
  ["admin_control_provider_probes", "admin_control_provider_probes_migrator_policy", "migrator"],
  ["admin_control_active_configs", "admin_control_active_configs_migrator_policy", "migrator"],
  [
    "admin_control_activation_events",
    "admin_control_activation_events_migrator_policy",
    "migrator",
  ],
  ["admin_control_commands", "admin_control_commands_migrator_policy", "migrator"],
  ["admin_control_audits", "admin_control_audits_migrator_policy", "migrator"],
  ["admin_control_generation", "admin_control_generation_migrator_policy", "migrator"],
  ["run_runtime_config_snapshots", "run_runtime_config_snapshots_migrator_policy", "migrator"],
  ["platform_control_operators", "platform_control_operators_self_policy", "control"],
  ["admin_control_config_revisions", "admin_control_revisions_read_policy", "control"],
  ["admin_control_config_revisions", "admin_control_revisions_insert_policy", "control"],
  ["admin_control_provider_probes", "admin_control_probes_policy", "control"],
  ["admin_control_active_configs", "admin_control_active_policy", "control"],
  ["admin_control_activation_events", "admin_control_activation_events_policy", "control"],
  ["admin_control_commands", "admin_control_commands_policy", "control"],
  ["admin_control_audits", "admin_control_audits_policy", "control"],
  ["admin_control_generation", "admin_control_generation_policy", "control"],
  ["admin_control_config_revisions", "runtime_control_revisions_read_policy", "runtime"],
  ["admin_control_active_configs", "runtime_control_active_read_policy", "runtime"],
  ["admin_control_generation", "runtime_control_generation_read_policy", "runtime"],
  ["run_runtime_config_snapshots", "run_runtime_config_snapshots_runtime_policy", "runtime"],
] as const);

const externalToolPolicyBindings = Object.freeze([
  ["external_tool_versions", "external_tool_versions_migrator_policy", "migrator"],
  ["external_tool_credentials", "external_tool_credentials_migrator_policy", "migrator"],
  ["external_tool_revocations", "external_tool_revocations_migrator_policy", "migrator"],
  ["external_tool_versions", "external_tool_versions_admin_policy", "control"],
  ["external_tool_credentials", "external_tool_credentials_admin_policy", "control"],
  ["external_tool_revocations", "external_tool_revocations_admin_policy", "control"],
] as const);

const embeddedIdentityPolicyBindings = Object.freeze([
  ["better_auth_users", "better_auth_users_migrator_policy", "migrator"],
  ["better_auth_sessions", "better_auth_sessions_migrator_policy", "migrator"],
  ["better_auth_accounts", "better_auth_accounts_migrator_policy", "migrator"],
  ["better_auth_verifications", "better_auth_verifications_migrator_policy", "migrator"],
  ["better_auth_rate_limits", "better_auth_rate_limits_migrator_policy", "migrator"],
  ["identity_auth_configuration", "identity_auth_configuration_migrator_policy", "migrator"],
  ["identity_auth_audits", "identity_auth_audits_migrator_policy", "migrator"],
  ["identity_auth_commands", "identity_auth_commands_migrator_policy", "migrator"],
  ["better_auth_users", "better_auth_users_runtime_policy", "runtime"],
  ["better_auth_sessions", "better_auth_sessions_runtime_policy", "runtime"],
  ["better_auth_accounts", "better_auth_accounts_runtime_policy", "runtime"],
  ["better_auth_verifications", "better_auth_verifications_runtime_policy", "runtime"],
  ["better_auth_rate_limits", "better_auth_rate_limits_runtime_policy", "runtime"],
  ["identity_auth_configuration", "identity_auth_configuration_runtime_policy", "runtime"],
  ["identity_auth_configuration", "identity_auth_configuration_control_policy", "control"],
  ["identity_auth_audits", "identity_auth_audits_control_policy", "control"],
  ["identity_auth_commands", "identity_auth_commands_control_policy", "control"],
  ["better_auth_sessions", "better_auth_sessions_control_delete_policy", "control"],
] as const);
const adminUserOperationsPolicyBindings = Object.freeze([
  ["admin_user_account_audits", "admin_user_account_audits_migrator_policy", "migrator"],
  ["admin_user_account_audits", "admin_user_account_audits_control_policy", "control"],
  ["user_accounts", "user_accounts_admin_control_update_policy", "control"],
  ["user_sessions", "user_sessions_admin_control_delete_policy", "control"],
] as const);

const adminRunExplorerPolicyBindings = Object.freeze([
  [
    "admin_run_content_access_audits",
    "admin_run_content_access_audits_migrator_policy",
    "migrator",
  ],
  [
    "admin_run_content_access_audits",
    "admin_run_content_access_audits_control_read_policy",
    "control",
  ],
  [
    "admin_run_content_access_audits",
    "admin_run_content_access_audits_control_insert_policy",
    "control",
  ],
  ["execution_attempts", "execution_attempts_admin_projection_read", "migrator"],
  ["run_events", "run_events_admin_projection_read", "migrator"],
] as const);

const adminIntegrationTenantDirectoryPolicyBindings = Object.freeze([
  ["tenants", "tenants_admin_integration_directory_read", "migrator"],
  ["user_accounts", "user_accounts_admin_integration_directory_read", "migrator"],
] as const);

async function rebindRoleScopedPolicies(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const schema = quoteIdentifier(context.schema);
  if (await hasApiEndUserState(client, context.schema)) {
    await client.query(
      `ALTER POLICY end_users_runtime ON ${schema}.api_end_users TO ${quoteIdentifier(context.runtimeRole)};
       ALTER POLICY end_users_migrator ON ${schema}.api_end_users TO ${quoteIdentifier(context.migratorRole)};
       ALTER POLICY end_users_control ON ${schema}.api_end_users TO ${quoteIdentifier(context.adminControlRole)}`,
    );
  }
  if (
    (await hasApiKeyState(client, context.schema)) &&
    (await hasApiKeyRevocationPolicyState(client, context.schema))
  ) {
    await client.query(
      `ALTER POLICY api_key_integration_membership_revoke ON ${schema}.memberships TO ${quoteIdentifier(context.runtimeRole)};
       ALTER POLICY api_key_revocation_guard ON ${schema}.api_keys TO ${quoteIdentifier(context.runtimeRole)}`,
    );
  }
  if (await hasManagedSandboxState(client, context.schema)) {
    for (const table of [...managedSandboxControlTables, "sandbox_configuration_bindings"]) {
      await client.query(
        `ALTER POLICY migrator_all ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(context.migratorRole)}`,
      );
    }
    for (const table of managedSandboxControlTables) {
      for (const policy of ["control_read", "control_insert"])
        await client.query(
          `ALTER POLICY ${policy} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(context.adminControlRole)}`,
        );
    }
    await client.query(
      `ALTER POLICY control_update ON ${schema}.sandbox_control_head TO ${quoteIdentifier(context.adminControlRole)}`,
    );
    for (const table of managedSandboxRuntimeTables.filter(
      (table) => table !== "sandbox_provider_profiles",
    ))
      await client.query(
        `ALTER POLICY runtime_read ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(context.runtimeRole)}`,
      );
    await client.query(`ALTER POLICY runtime_profile_read ON ${schema}.sandbox_provider_profiles TO ${quoteIdentifier(context.runtimeRole)};
      ALTER POLICY runtime_binding_read ON ${schema}.sandbox_configuration_bindings TO ${quoteIdentifier(context.runtimeRole)};
      ALTER POLICY runtime_binding_insert ON ${schema}.sandbox_configuration_bindings TO ${quoteIdentifier(context.runtimeRole)}`);
  }
  if (await hasRunCompactionSettingsState(client, context.schema)) {
    await client.query(
      `ALTER POLICY run_compaction_settings_migrator_policy
         ON ${schema}.run_compaction_settings_snapshots TO ${quoteIdentifier(context.migratorRole)};
       ALTER POLICY run_compaction_settings_runtime_policy
         ON ${schema}.run_compaction_settings_snapshots TO ${quoteIdentifier(context.runtimeRole)}`,
    );
  }
  const projectionPolicy = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename='threads'
       AND policyname='threads_admin_projection_read') AS present`,
    [context.schema],
  );
  if (projectionPolicy.rows[0]?.present) {
    // 导入 Schema 或轮换 Migrator 后，聚合读取策略不能继续绑定旧角色。
    for (const table of [
      "runs",
      "threads",
      "run_dispatch_outbox",
      "sandbox_registry",
      "cleanup_outbox",
      "memory_ingestion_outbox",
      "scheduled_tasks",
      "scheduled_task_occurrences",
      "tenant_skill_installations",
      "user_accounts",
      "thread_continuity_metric_observations",
      "user_sessions",
    ]) {
      const policyName = `${table}_admin_projection_read`;
      const policyExists = await client.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename=$2 AND policyname=$3) AS present",
        [context.schema, table, policyName],
      );
      if (policyExists.rows[0]?.present) {
        await client.query(`ALTER POLICY ${quoteIdentifier(policyName)}
          ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(context.migratorRole)}`);
      }
    }
  }
  if (await hasSkillPublicationState(client, context.schema)) {
    for (const [table, policy, target] of skillPublisherPolicyBindings) {
      const role = target === "migrator" ? context.migratorRole : context.skillPublisherRole;
      await client.query(
        `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
      );
    }
  }
  if (await hasWorkerTenantAssignmentState(client, context.schema)) {
    await client.query(
      `ALTER POLICY worker_tenant_assignments_runtime_policy
         ON ${schema}.worker_tenant_assignments TO ${quoteIdentifier(context.runtimeRole)};
       ALTER POLICY worker_tenant_assignments_coordinator_select_policy
         ON ${schema}.worker_tenant_assignments TO ${quoteIdentifier(context.workerCoordinatorRole)};
       ALTER POLICY worker_tenant_assignments_coordinator_claim_policy
         ON ${schema}.worker_tenant_assignments TO ${quoteIdentifier(context.workerCoordinatorRole)}`,
    );
  }
  if (await hasEmbeddedIdentityState(client, context.schema)) {
    for (const [table, policy, target] of embeddedIdentityPolicyBindings) {
      const role =
        target === "migrator"
          ? context.migratorRole
          : target === "runtime"
            ? context.runtimeRole
            : context.adminControlRole;
      await client.query(
        `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
      );
    }
  }
  if (await hasAdminControlState(client, context.schema)) {
    for (const [table, policy, target] of adminControlPolicyBindings) {
      const role =
        target === "migrator"
          ? context.migratorRole
          : target === "runtime"
            ? context.runtimeRole
            : context.adminControlRole;
      await client.query(
        `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
      );
    }
    if (await hasAdminUserOperationsState(client, context.schema)) {
      for (const [table, policy, target] of adminUserOperationsPolicyBindings) {
        const role = target === "migrator" ? context.migratorRole : context.adminControlRole;
        await client.query(
          `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
        );
      }
    }
    if (await hasAdminRunExplorerState(client, context.schema)) {
      for (const [table, policy, target] of adminRunExplorerPolicyBindings) {
        const role = target === "migrator" ? context.migratorRole : context.adminControlRole;
        await client.query(
          `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
        );
      }
    }
    if (await hasAdminRunInputProjectionPolicyState(client, context.schema)) {
      await client.query(
        `ALTER POLICY run_execution_inputs_admin_projection_read ON ${schema}.run_execution_inputs TO ${quoteIdentifier(context.migratorRole)}`,
      );
    }
    if (await hasAdminIntegrationTenantDirectoryState(client, context.schema)) {
      for (const [table, policy, target] of adminIntegrationTenantDirectoryPolicyBindings) {
        const role = target === "migrator" ? context.migratorRole : context.adminControlRole;
        await client.query(
          `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
        );
      }
    }
  }
  const pinnedModelPolicy = await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=$1
      AND tablename='admin_control_config_revisions' AND policyname='runtime_agent_pinned_model_read') AS present`,
    [context.schema],
  );
  if (pinnedModelPolicy.rows[0]?.present) {
    await client.query(`ALTER POLICY runtime_agent_pinned_model_read
      ON ${schema}.admin_control_config_revisions TO ${quoteIdentifier(context.runtimeRole)}`);
  }
  const agentControlPolicies = await client.query<{ tablename: string; policyname: string }>(
    `SELECT tablename,policyname FROM pg_policies p WHERE schemaname=$1
      AND (p.tablename,p.policyname) IN (
        ('agent_definitions','agent_control_read'), ('agent_definitions','agent_definitions_admin_manage'),
        ('agent_definition_tenants','agent_control_read'), ('agent_definition_tenants','agent_control_manage'),
        ('agent_revisions','agent_control_read'), ('agent_revisions','agent_revisions_admin_manage'),
        ('agent_revision_revocations','agent_control_read'), ('agent_revision_revocations','agent_revision_revocations_admin'),
        ('agent_definition_commands','agent_commands_admin'), ('agent_definition_audits','agent_audits_admin')
      )
      AND EXISTS (SELECT 1 FROM pg_policies gate WHERE gate.schemaname=$1
        AND gate.tablename='agent_definition_tenants' AND gate.policyname='agent_control_manage')`,
    [context.schema],
  );
  for (const { tablename, policyname } of agentControlPolicies.rows) {
    await client.query(
      `ALTER POLICY ${quoteIdentifier(policyname)} ON ${schema}.${quoteIdentifier(tablename)} TO ${quoteIdentifier(context.adminControlRole)}`,
    );
  }
  if (await hasExternalToolState(client, context.schema)) {
    for (const [table, policy, target] of externalToolPolicyBindings) {
      const role = target === "migrator" ? context.migratorRole : context.adminControlRole;
      await client.query(
        `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
      );
    }
  }
  if (await hasExternalToolAdminState(client, context.schema)) {
    for (const table of externalToolAdminTables) {
      await client.query(
        `ALTER POLICY ${quoteIdentifier(`${table}_migrator_policy`)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(context.migratorRole)};
         ALTER POLICY ${quoteIdentifier(`${table}_admin_policy`)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(context.adminControlRole)}`,
      );
    }
  }
}

async function grantSkillPublisherAccess(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  if (!(await hasSkillPublicationState(client, context.schema))) return;
  const schema = quoteIdentifier(context.schema);
  const publisher = quoteIdentifier(context.skillPublisherRole);
  await client.query(
    `GRANT USAGE ON SCHEMA ${schema} TO ${publisher};
     GRANT SELECT ON TABLE ${schema}.platform_skill_operators TO ${publisher};
     GRANT SELECT,INSERT ON TABLE
       ${schema}.skill_publication_submissions,
       ${schema}.skill_publication_files,
       ${schema}.skill_publication_commands,
       ${schema}.skill_publication_audits TO ${publisher};
     GRANT UPDATE(status,version_token,reviewed_by,rejection_reason,published_skill_id,updated_at)
       ON TABLE ${schema}.skill_publication_submissions TO ${publisher};
     GRANT SELECT,INSERT ON TABLE
       ${schema}.skills,${schema}.skill_versions,${schema}.skill_version_files TO ${publisher};
     GRANT UPDATE(display_name,recommended_version,status,updated_at)
       ON TABLE ${schema}.skills TO ${publisher};
     GRANT UPDATE(status) ON TABLE ${schema}.skill_versions TO ${publisher}`,
  );
}

async function grantAdminControlAccess(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  if (!(await hasAdminControlState(client, context.schema))) return;
  const schema = quoteIdentifier(context.schema);
  const control = quoteIdentifier(context.adminControlRole);
  if (await hasIntegrationAdminState(client, context.schema)) {
    const isolatedUsers = await client.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=$1 AND tablename='app_users' AND policyname='integration_admin_users_manage') AS present",
      [context.schema],
    );
    if (isolatedUsers.rows[0]?.present) {
      await client.query(`ALTER POLICY app_users_tenant_policy ON ${schema}.app_users TO ${quoteIdentifier(context.runtimeRole)},${quoteIdentifier(context.teamCoordinatorRole)},${quoteIdentifier(context.migratorRole)};
        ALTER POLICY integration_admin_users_manage ON ${schema}.app_users TO ${control}`);
    }
    for (const [table, policy] of [
      ["platform_control_operators", "integration_admin_actor"],
      ["api_keys", "integration_admin_guard"],
      ["api_keys", "integration_admin_key_update"],
      ["memberships", "integration_admin_guard"],
      ["memberships", "integration_admin_membership_update"],
      ["app_users", "integration_admin_guard"],
      ["tenants", "integration_admin_guard"],
      ["tenant_webhooks", "integration_admin_manage"],
      ["integration_admin_audits", "integration_admin_audits_admin"],
    ] as const) {
      await client.query(
        `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${control}`,
      );
    }
    await client.query(`ALTER POLICY integration_admin_audits_migrator ON ${schema}.integration_admin_audits TO ${quoteIdentifier(context.migratorRole)};
      GRANT SELECT,INSERT ON ${schema}.api_keys,${schema}.integration_admin_audits TO ${control};
      GRANT INSERT ON ${schema}.tenant_webhooks TO ${control};
      GRANT SELECT(${webhookAdminSelectColumns.join(",")}) ON ${schema}.tenant_webhooks TO ${control};
      GRANT INSERT ON ${schema}.app_users,${schema}.memberships TO ${control};
      GRANT SELECT(id,kind) ON ${schema}.app_users TO ${control};
      GRANT SELECT(id) ON ${schema}.tenants TO ${control};
      GRANT SELECT(tenant_id,user_id,role,status) ON ${schema}.memberships TO ${control};
      GRANT UPDATE(key_hash,key_prefix,revoked_at) ON ${schema}.api_keys TO ${control};
      GRANT UPDATE(status) ON ${schema}.memberships TO ${control};
      GRANT UPDATE(secret_ciphertext,disabled_at,disabled_reason) ON ${schema}.tenant_webhooks TO ${control}`);
  }
  if (await hasInstallationState(client, context.schema)) {
    const runtime = quoteIdentifier(context.runtimeRole);
    await client.query(`
      ALTER POLICY installation_state_migrator_policy ON ${schema}.installation_state TO ${quoteIdentifier(context.migratorRole)};
      ALTER POLICY installation_state_read_policy ON ${schema}.installation_state TO ${runtime};
      ALTER POLICY installation_state_initialize_policy ON ${schema}.installation_state TO ${runtime};
      ALTER POLICY platform_control_operators_runtime_read_policy ON ${schema}.platform_control_operators TO ${runtime};
      ALTER POLICY platform_control_operators_initialize_policy ON ${schema}.platform_control_operators TO ${runtime};
      GRANT SELECT ON ${schema}.installation_state TO ${runtime};
      GRANT UPDATE(administrator_user_id,initialized_at) ON ${schema}.installation_state TO ${runtime};
      GRANT SELECT,INSERT ON ${schema}.platform_control_operators TO ${runtime};
    `);
    const statusView = await client.query<{ present: boolean }>(
      "SELECT to_regclass(format('%I.installation_status',$1::text)) IS NOT NULL AS present",
      [context.schema],
    );
    if (statusView.rows[0]?.present) {
      await client.query(`ALTER VIEW ${schema}.installation_status OWNER TO ${quoteIdentifier(context.migratorRole)};
        GRANT SELECT ON ${schema}.installation_status TO ${runtime};
        ALTER POLICY platform_skill_operators_runtime_read_policy ON ${schema}.platform_skill_operators TO ${runtime};
        ALTER POLICY platform_skill_operators_initialize_policy ON ${schema}.platform_skill_operators TO ${runtime};
        GRANT SELECT,INSERT ON ${schema}.platform_skill_operators TO ${runtime}`);
    }
  }
  const titleReference = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.runtime_title_model_reference',$1::text)) IS NOT NULL AS present",
    [context.schema],
  );
  if (titleReference.rows[0]?.present) {
    await client.query(`
      ALTER VIEW ${schema}.runtime_title_model_reference OWNER TO ${quoteIdentifier(context.migratorRole)};
      REVOKE ALL ON ${schema}.runtime_title_model_reference FROM PUBLIC;
      GRANT SELECT ON ${schema}.runtime_title_model_reference TO ${quoteIdentifier(context.runtimeRole)};
      ALTER POLICY runtime_title_model_revisions_read_policy ON ${schema}.admin_control_config_revisions TO ${quoteIdentifier(context.runtimeRole)};
    `);
  }
  if (await hasManagedSandboxState(client, context.schema)) {
    for (const table of managedSandboxControlTables)
      await client.query(
        `GRANT SELECT,INSERT ON ${schema}.${quoteIdentifier(table)} TO ${control}`,
      );
    await client.query(
      `GRANT UPDATE(generation,routing_revision) ON ${schema}.sandbox_control_head TO ${control}`,
    );
  }
  await client.query(
    `GRANT USAGE ON SCHEMA ${schema} TO ${control};
     GRANT SELECT ON TABLE ${schema}.platform_control_operators TO ${control};
     GRANT SELECT,INSERT ON TABLE
       ${schema}.admin_control_config_revisions,
       ${schema}.admin_control_provider_probes,
       ${schema}.admin_control_activation_events,
       ${schema}.admin_control_commands,
       ${schema}.admin_control_audits TO ${control};
     GRANT SELECT,INSERT ON TABLE ${schema}.admin_control_active_configs TO ${control};
     GRANT UPDATE(object_key,revision,generation,activated_by,reason,activated_at)
       ON TABLE ${schema}.admin_control_active_configs TO ${control};
     GRANT SELECT ON TABLE ${schema}.admin_control_generation TO ${control};
     GRANT UPDATE(generation,updated_at) ON TABLE ${schema}.admin_control_generation TO ${control};
     GRANT SELECT ON TABLE ${schema}.admin_runtime_statistics TO ${control}`,
  );
  if (await hasAgentDefinitionState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT ON TABLE ${schema}.agent_definitions TO ${control};
       GRANT SELECT,INSERT,DELETE ON TABLE ${schema}.agent_definition_tenants TO ${control};
       GRANT UPDATE(available) ON TABLE ${schema}.agent_definition_tenants TO ${control};
       GRANT SELECT,INSERT ON TABLE ${schema}.agent_revisions,${schema}.agent_revision_revocations,
         ${schema}.agent_definition_commands,${schema}.agent_definition_audits TO ${control};
       GRANT UPDATE(status,generation,availability_mode,current_revision_id,updated_at)
         ON TABLE ${schema}.agent_definitions TO ${control};
       GRANT UPDATE(status) ON TABLE ${schema}.agent_revisions TO ${control};
       GRANT USAGE ON SEQUENCE ${schema}.agent_definition_audits_audit_id_seq TO ${control}`,
    );
    await client.query(
      `GRANT SELECT ON TABLE ${schema}.skills,${schema}.skill_versions TO ${control}`,
    );
  }
  if (await hasAdminUserOperationsState(client, context.schema)) {
    if (await hasApiEndUserState(client, context.schema)) {
      await client.query(
        `GRANT SELECT ON TABLE ${schema}.api_end_users TO ${control}; GRANT UPDATE(status) ON TABLE ${schema}.api_end_users TO ${control}`,
      );
    }
    const identityEnabled = await hasEmbeddedIdentityState(client, context.schema);
    await client.query(
      `GRANT SELECT,INSERT ON TABLE ${schema}.admin_user_account_audits TO ${control};
       GRANT SELECT(user_id${identityEnabled ? ",better_auth_user_id" : ""}) ON TABLE ${schema}.user_accounts TO ${control};
       GRANT SELECT(user_id) ON TABLE ${schema}.user_sessions TO ${control};
       GRANT UPDATE(status,updated_at) ON TABLE ${schema}.user_accounts TO ${control};
       GRANT DELETE ON TABLE ${schema}.user_sessions TO ${control};
       GRANT SELECT ON TABLE ${schema}.admin_user_directory TO ${control}`,
    );
  }
  if (await hasAdminRunExplorerState(client, context.schema)) {
    // 只授予视图读取与审计写入；Run、Attempt、事件与指标底表仍对 Admin Control 零 ACL。
    await client.query(
      `GRANT SELECT,INSERT ON TABLE ${schema}.admin_run_content_access_audits TO ${control};
       GRANT SELECT ON TABLE ${adminRunExplorerViews.map((view) => `${schema}.${view}`).join(",")} TO ${control}`,
    );
  }
  if (await hasAdminIntegrationTenantDirectoryState(client, context.schema)) {
    await client.query(
      `GRANT SELECT ON TABLE ${schema}.admin_integration_tenant_directory TO ${control}`,
    );
  }
  if (await hasExternalToolAdminState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT ON TABLE ${schema}.external_tool_registration_drafts TO ${control};
       GRANT UPDATE(${externalToolDraftUpdateColumns.join(",")})
         ON TABLE ${schema}.external_tool_registration_drafts TO ${control};
       GRANT SELECT,INSERT,DELETE ON TABLE ${schema}.external_tool_draft_credentials TO ${control};
       GRANT SELECT,INSERT ON TABLE ${schema}.external_tool_admin_publish_claims TO ${control};
       GRANT UPDATE(lease_owner,lease_expires_at) ON TABLE ${schema}.external_tool_admin_publish_claims TO ${control};
       GRANT SELECT,INSERT ON TABLE ${schema}.external_tool_publish_batches,
         ${schema}.external_tool_publish_batch_versions,${schema}.external_tool_admin_commands,
         ${schema}.external_tool_admin_audits TO ${control};
       GRANT USAGE ON SEQUENCE ${schema}.external_tool_admin_audits_audit_id_seq TO ${control};
       GRANT SELECT ON TABLE ${schema}.external_tool_selectable_versions TO ${control}`,
    );
  }
  if (await hasExternalToolState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT ON TABLE ${schema}.external_tool_versions,${schema}.external_tool_revocations TO ${control};
       GRANT INSERT ON TABLE ${schema}.external_tool_credentials TO ${control}`,
    );
  }
  if (await hasEmbeddedIdentityState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT,UPDATE ON TABLE ${schema}.identity_auth_configuration TO ${control};
       GRANT SELECT,INSERT ON TABLE
         ${schema}.identity_auth_audits,${schema}.identity_auth_commands TO ${control};
       GRANT DELETE ON TABLE ${schema}.better_auth_sessions TO ${control}`,
    );
  }
}

async function hasIntegrationAdminState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(format('%I.integration_admin_audits',$1::text)) IS NOT NULL AS present",
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function hasWebhookState(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass(format('%I.tenant_webhooks', $1::text)) IS NOT NULL
            AND to_regclass(format('%I.webhook_outbox', $1::text)) IS NOT NULL AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

const webhookTables = ["tenant_webhooks", "webhook_outbox"] as const;
const webhookColumnPrivileges = ["SELECT", "INSERT", "UPDATE", "REFERENCES"] as const;
const webhookRuntimeUpdateColumns = ["secret_ciphertext", "disabled_at", "disabled_reason"];
const webhookAdminSelectColumns = [
  "tenant_id",
  "id",
  "name",
  "endpoint_url",
  "event_types",
  "created_at",
  "disabled_at",
  "disabled_reason",
];
// Team Coordinator 只为解散时的批量取消入队，读取筛选订阅所需的最少列。
const webhookTeamSelectColumns = ["tenant_id", "id", "event_types", "disabled_at"];
// 入队使用 ON CONFLICT 去重，PostgreSQL 要求对仲裁唯一键列持有 SELECT；不开放其他 Outbox 列。
const webhookOutboxConflictColumns = ["tenant_id", "webhook_id", "event_id"];
// Dispatcher 只读取投递所需列；订阅名称、创建者和事件订阅集合都不可见。
type WebhookDispatcherColumns = Readonly<
  Record<
    (typeof webhookTables)[number],
    { readonly select: readonly string[]; readonly update: readonly string[] }
  >
>;

const webhookDispatcherColumnWhitelist: WebhookDispatcherColumns = {
  tenant_webhooks: {
    select: ["tenant_id", "id", "endpoint_url", "secret_ciphertext", "disabled_at"],
    update: ["disabled_at", "disabled_reason"],
  },
  webhook_outbox: {
    select: [
      "tenant_id",
      "id",
      "webhook_id",
      "event_id",
      "payload",
      "source_run_origin",
      "state",
      "attempts",
      "next_attempt_at",
      "claim_token",
      "claim_expires_at",
      "created_at",
    ],
    update: [
      "state",
      "attempts",
      "next_attempt_at",
      "claim_token",
      "claim_expires_at",
      "last_error_code",
      "delivered_at",
    ],
  },
};

/** Dispatcher ACL 白名单只包含当前迁移版本真实存在的列，Grant 和断言共用同一解析结果。 */
async function resolveWebhookDispatcherColumns(
  client: PoolClient,
  schema: string,
): Promise<WebhookDispatcherColumns> {
  const result = await client.query<{
    readonly table_name: (typeof webhookTables)[number];
    readonly column_name: string;
  }>(
    `SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=ANY($2::text[])`,
    [schema, [...webhookTables]],
  );
  const actual = new Map<(typeof webhookTables)[number], Set<string>>(
    webhookTables.map((table) => [table, new Set<string>()]),
  );
  for (const row of result.rows) actual.get(row.table_name)?.add(row.column_name);
  const resolve = (table: (typeof webhookTables)[number]) => {
    const columns = actual.get(table) ?? new Set<string>();
    const whitelist = webhookDispatcherColumnWhitelist[table];
    return {
      select: whitelist.select.filter((column) => columns.has(column)),
      update: whitelist.update.filter((column) => columns.has(column)),
    };
  };
  return {
    tenant_webhooks: resolve("tenant_webhooks"),
    webhook_outbox: resolve("webhook_outbox"),
  };
}

const webhookTenantPolicies = ["tenant_webhooks_tenant_policy", "webhook_outbox_tenant_policy"];

/**
 * 找出当前配置之外仍与 Webhook 表关联的角色：表/列 ACL 的被授予者，或任何 Webhook 策略绑定的角色。
 * 这些通常是更换前的 Dispatcher；表所有者与当前上下文中的角色不在结果内。
 */
async function findStaleWebhookRoles(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<readonly string[]> {
  if (!(await hasWebhookState(client, context.schema))) return [];
  const result = await client.query<{ readonly role_name: string }>(
    `WITH target AS (
       SELECT relation.oid,relation.relacl,relation.relowner FROM pg_class relation
        WHERE relation.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1)
          AND relation.relname = ANY($2::text[])
     ), linked AS (
       SELECT unnest(policy.polroles) AS role_oid
         FROM pg_policy policy JOIN target ON target.oid=policy.polrelid
       UNION
       SELECT (aclexplode(target.relacl)).grantee FROM target WHERE target.relacl IS NOT NULL
       UNION
       SELECT (aclexplode(attribute.attacl)).grantee
         FROM pg_attribute attribute JOIN target ON target.oid=attribute.attrelid
        WHERE attribute.attacl IS NOT NULL
     )
     SELECT DISTINCT role_state.rolname AS role_name
       FROM linked JOIN pg_roles role_state ON role_state.oid=linked.role_oid
      WHERE role_state.rolname <> ALL($3::text[])
        AND NOT EXISTS (SELECT 1 FROM target WHERE target.relowner=role_state.oid)
      ORDER BY 1`,
    [context.schema, [...webhookTables], [...databaseRoles(context)]],
  );
  return result.rows.map((row) => row.role_name);
}

async function grantWebhookAccess(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  if (!(await hasWebhookState(client, context.schema))) return;
  const schema = quoteIdentifier(context.schema);
  const runtime = quoteIdentifier(context.runtimeRole);
  const team = quoteIdentifier(context.teamCoordinatorRole);
  const columns = (names: readonly string[]) => names.map(quoteIdentifier).join(",");
  await client.query(
    `GRANT SELECT,INSERT,DELETE ON TABLE ${schema}.tenant_webhooks TO ${runtime};
     GRANT UPDATE(${columns(webhookRuntimeUpdateColumns)}) ON TABLE ${schema}.tenant_webhooks TO ${runtime};
     GRANT INSERT ON TABLE ${schema}.webhook_outbox TO ${runtime};
     GRANT SELECT(${columns(webhookOutboxConflictColumns)}) ON TABLE ${schema}.webhook_outbox TO ${runtime}`,
  );
  if (await hasTeamCollaborationState(client, context.schema))
    await client.query(
      `GRANT SELECT(${columns(webhookTeamSelectColumns)}) ON TABLE ${schema}.tenant_webhooks TO ${team};
       GRANT INSERT ON TABLE ${schema}.webhook_outbox TO ${team};
       GRANT SELECT(${columns(webhookOutboxConflictColumns)}) ON TABLE ${schema}.webhook_outbox TO ${team}`,
    );
  // 管理策略与批量取消的入队策略分开，即使团队角色获得额外 ACL 也不能更新这些行。
  for (const [policy, table] of [
    ["tenant_webhooks_tenant_policy", "tenant_webhooks"],
    ["webhook_outbox_tenant_policy", "webhook_outbox"],
  ] as const)
    await client.query(`ALTER POLICY ${policy} ON ${schema}.${table} TO ${runtime}`);
  const tenantMatch = "tenant_id = NULLIF(current_setting('app.tenant_id', true), '')";
  await client.query(
    `ALTER POLICY webhook_team_subscriptions ON ${schema}.tenant_webhooks TO ${team} USING (${tenantMatch});
     ALTER POLICY webhook_team_keys ON ${schema}.webhook_outbox TO ${team} USING (${tenantMatch});
     ALTER POLICY webhook_team_enqueue ON ${schema}.webhook_outbox TO ${team} WITH CHECK (${tenantMatch})`,
  );
  if (context.webhookDispatcherRole === undefined) {
    await client.query(
      `ALTER POLICY tenant_webhooks_dispatcher_read ON ${schema}.tenant_webhooks TO PUBLIC USING (false);
       ALTER POLICY tenant_webhooks_dispatcher_disable ON ${schema}.tenant_webhooks TO PUBLIC
         USING (false) WITH CHECK (false);
       ALTER POLICY webhook_outbox_dispatcher_policy ON ${schema}.webhook_outbox TO PUBLIC
         USING (false) WITH CHECK (false)`,
    );
    return;
  }
  const dispatcher = quoteIdentifier(context.webhookDispatcherRole);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${dispatcher}`);
  const dispatcherColumns = await resolveWebhookDispatcherColumns(client, context.schema);
  for (const table of webhookTables) {
    const allowed = dispatcherColumns[table];
    if (allowed.select.length > 0)
      await client.query(
        `GRANT SELECT(${columns(allowed.select)}) ON TABLE ${schema}.${table} TO ${dispatcher}`,
      );
    if (allowed.update.length > 0)
      await client.query(
        `GRANT UPDATE(${columns(allowed.update)}) ON TABLE ${schema}.${table} TO ${dispatcher}`,
      );
  }
  // Dispatcher 跨 Tenant 投递，但只能把仍启用的订阅改为停用，不能恢复启用。
  await client.query(
    `ALTER POLICY tenant_webhooks_dispatcher_read ON ${schema}.tenant_webhooks TO ${dispatcher}
       USING (true);
     ALTER POLICY tenant_webhooks_dispatcher_disable ON ${schema}.tenant_webhooks TO ${dispatcher}
       USING (disabled_at IS NULL) WITH CHECK (disabled_at IS NOT NULL AND disabled_reason IS NOT NULL);
     ALTER POLICY webhook_outbox_dispatcher_policy ON ${schema}.webhook_outbox TO ${dispatcher}
       USING (true) WITH CHECK (true)`,
  );
}

async function assertWebhookBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
  staleRoles: readonly string[],
): Promise<void> {
  const present = await hasWebhookState(client, context.schema);
  const teamEnabled = present && (await hasTeamCollaborationState(client, context.schema));
  const integrationsEnabled = present && (await hasIntegrationAdminState(client, context.schema));
  const dispatcherColumns =
    present && context.webhookDispatcherRole !== undefined
      ? await resolveWebhookDispatcherColumns(client, context.schema)
      : undefined;
  type Expected = (table: string, column: string, privilege: string) => boolean;
  const none: Expected = () => false;
  const checks: Array<readonly [string, Expected]> = [
    [
      context.runtimeRole,
      (table, column, privilege) =>
        table === "tenant_webhooks"
          ? privilege === "SELECT" ||
            privilege === "INSERT" ||
            (privilege === "UPDATE" && webhookRuntimeUpdateColumns.includes(column))
          : privilege === "INSERT" ||
            (privilege === "SELECT" && webhookOutboxConflictColumns.includes(column)),
    ],
    [
      context.teamCoordinatorRole,
      teamEnabled
        ? (table, column, privilege) =>
            table === "tenant_webhooks"
              ? privilege === "SELECT" && webhookTeamSelectColumns.includes(column)
              : privilege === "INSERT" ||
                (privilege === "SELECT" && webhookOutboxConflictColumns.includes(column))
        : none,
    ],
    ...staleRoles.map((role) => [role, none] as const),
  ];
  for (const role of [context.skillPublisherRole, context.workerCoordinatorRole])
    checks.push([role, none]);
  checks.push([
    context.adminControlRole,
    integrationsEnabled
      ? (table, column, privilege) =>
          table === "tenant_webhooks" &&
          ((privilege === "SELECT" && webhookAdminSelectColumns.includes(column)) ||
            privilege === "INSERT" ||
            (privilege === "UPDATE" && webhookRuntimeUpdateColumns.includes(column)))
      : none,
  ]);
  if (context.webhookDispatcherRole !== undefined)
    checks.push([
      context.webhookDispatcherRole,
      (table, column, privilege) => {
        const allowed = dispatcherColumns?.[table as (typeof webhookTables)[number]];
        if (allowed === undefined) return false;
        if (privilege === "SELECT") return allowed.select.includes(column);
        if (privilege === "UPDATE") return allowed.update.includes(column);
        return false;
      },
    ]);
  if (present) {
    for (const [role, expected] of checks) {
      const rows = await client.query<{
        readonly table_name: string;
        readonly column_name: string;
        readonly privilege: string;
        readonly allowed: boolean;
      }>(
        `SELECT column_state.table_name,column_state.column_name,requested.privilege,
                has_column_privilege($1,format('%I.%I',$2::text,column_state.table_name),
                  column_state.column_name,requested.privilege) AS allowed
           FROM information_schema.columns column_state
           CROSS JOIN unnest($3::text[]) AS requested(privilege)
          WHERE column_state.table_schema=$2 AND column_state.table_name = ANY($4::text[])`,
        [role, context.schema, [...webhookColumnPrivileges], [...webhookTables]],
      );
      for (const row of rows.rows)
        if (row.allowed !== expected(row.table_name, row.column_name, row.privilege))
          throw new PersistenceError(
            "CONSTRAINT_VIOLATION",
            `Webhook 列权限偏离白名单：${role} ${row.table_name}.${row.column_name}.${row.privilege}`,
          );
    }
    const bindings = await client.query<{
      readonly policy_name: string;
      readonly roles: string[];
    }>(
      `SELECT policy.polname AS policy_name,
              ARRAY(SELECT CASE WHEN member=0 THEN 'PUBLIC' ELSE pg_get_userbyid(member)::text END
                      FROM unnest(policy.polroles) AS member ORDER BY 1) AS roles
         FROM pg_policy policy JOIN pg_class relation ON relation.oid=policy.polrelid
        WHERE relation.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1)
          AND relation.relname = ANY($2::text[])`,
      [context.schema, [...webhookTables]],
    );
    const expectedBindings = new Map([
      ...webhookTenantPolicies.map((name) => [name, context.runtimeRole] as const),
      ...["webhook_team_subscriptions", "webhook_team_keys", "webhook_team_enqueue"].map(
        (name) => [name, context.teamCoordinatorRole] as const,
      ),
      ...[
        "tenant_webhooks_dispatcher_read",
        "tenant_webhooks_dispatcher_disable",
        "webhook_outbox_dispatcher_policy",
      ].map((name) => [name, context.webhookDispatcherRole ?? "PUBLIC"] as const),
    ]);
    if (integrationsEnabled)
      expectedBindings.set("integration_admin_manage", context.adminControlRole);
    if (bindings.rows.length !== expectedBindings.size)
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Webhook RLS 策略集合偏离白名单");
    for (const row of bindings.rows) {
      if (
        row.roles.length !== 1 ||
        !expectedBindings.has(row.policy_name) ||
        row.roles[0] !== expectedBindings.get(row.policy_name)
      )
        throw new PersistenceError(
          "CONSTRAINT_VIOLATION",
          `Webhook RLS 策略绑定偏离白名单：${row.policy_name}`,
        );
    }
  }
  // Dispatcher 与已撤销的旧角色在 Webhook 以外的表上不得持有任何表或列权限。
  const outsiders: Array<readonly [string, boolean]> = [
    ...staleRoles.map((role) => [role, false] as const),
    ...(context.webhookDispatcherRole === undefined
      ? []
      : [[context.webhookDispatcherRole, present] as const]),
  ];
  for (const [role, schemaUsage] of outsiders) {
    const leaked = await client.query<{ readonly table_name: string }>(
      `SELECT relation.relname AS table_name
         FROM pg_class relation CROSS JOIN unnest($3::text[]) AS requested(privilege)
        WHERE relation.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname=$2)
          AND relation.relkind IN ('r','p','S')
          AND ((relation.relkind <> 'S' AND (
                 has_table_privilege($1,relation.oid,requested.privilege)
                 OR (relation.relname <> ALL($4::text[])
                     AND requested.privilege IN ('SELECT','INSERT','UPDATE','REFERENCES')
                     AND has_any_column_privilege($1,relation.oid,requested.privilege))))
            OR (relation.relkind='S' AND requested.privilege IN ('SELECT','UPDATE')
                AND has_sequence_privilege($1,relation.oid,requested.privilege)))
        LIMIT 1`,
      [role, context.schema, tablePrivileges, [...webhookTables]],
    );
    if (leaked.rows.length > 0)
      throw new PersistenceError(
        "CONSTRAINT_VIOLATION",
        `${role} 持有 Webhook 白名单之外的表权限：${leaked.rows[0]?.table_name ?? ""}`,
      );
    const usage = await client.query<{ readonly usage: boolean; readonly create: boolean }>(
      `SELECT has_schema_privilege($1,$2,'USAGE') AS usage,has_schema_privilege($1,$2,'CREATE') AS create`,
      [role, context.schema],
    );
    if (usage.rows[0]?.usage !== schemaUsage || usage.rows[0]?.create !== false)
      throw new PersistenceError("CONSTRAINT_VIOLATION", `${role} 的 Schema 权限偏离白名单`);
  }
}

/** 在既有迁移事务中收敛 ACL，供 down 保证 DDL 与权限回收原子提交。 */
export async function bootstrapRuntimeAccessOnClient(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  await assertBootstrapContextSafe(client, context);
  const role = quoteIdentifier(context.runtimeRole);
  const coordinatorRole = quoteIdentifier(context.workerCoordinatorRole);
  const schema = quoteIdentifier(context.schema);
  // 更换 Dispatcher 等角色后，旧角色仍可能保留 Schema/表/列 ACL 或 Webhook 策略绑定；
  // 必须在重新授权前与当前角色一起撤销，否则旧凭据仍能访问投递记录。
  const staleWebhookRoles = await findStaleWebhookRoles(client, context);
  const revokedRoles = [
    "PUBLIC",
    ...[
      context.runtimeRole,
      context.skillPublisherRole,
      context.workerCoordinatorRole,
      context.teamCoordinatorRole,
      context.adminControlRole,
      ...(context.webhookDispatcherRole === undefined ? [] : [context.webhookDispatcherRole]),
      ...staleWebhookRoles,
    ].map(quoteIdentifier),
  ].join(", ");
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${revokedRoles}`);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${revokedRoles}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${revokedRoles}`,
  );
  await rebindRoleScopedPolicies(client, context);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  if (await hasApiEndUserState(client, context.schema)) {
    await client.query(`GRANT SELECT,INSERT ON TABLE ${schema}.api_end_users TO ${role}`);
  }
  await client.query(
    `GRANT SELECT, INSERT ON TABLE ${schema}.app_users, ${schema}.tenants, ${schema}.memberships TO ${role}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA ${schema} FROM ${revokedRoles}`,
  );
  await grantWebhookAccess(client, context);
  if (await hasApiKeyState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.api_keys TO ${role};
       GRANT UPDATE(last_used_at) ON TABLE ${schema}.api_keys TO ${role}`,
    );
    if (await hasApiKeyRevocationPolicyState(client, context.schema)) {
      await client.query(
        `GRANT UPDATE(revoked_at) ON TABLE ${schema}.api_keys TO ${role};
         GRANT UPDATE(status) ON TABLE ${schema}.memberships TO ${role}`,
      );
    }
  }
  if (await hasMembershipLockMarker(client)) {
    await client.query(`GRANT UPDATE(lock_marker) ON TABLE ${schema}.memberships TO ${role}`);
  }
  if (await hasTeamCollaborationState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT ON TABLE
         ${schema}.thread_forks,
         ${schema}.tenant_skill_installations,
         ${schema}.tenant_skill_installation_commands,
         ${schema}.tenant_skill_installation_audits
       TO ${role};
       GRANT UPDATE(
         skill_version,invocation_name,status,version_token,installed_at,updated_at
       ) ON TABLE ${schema}.tenant_skill_installations TO ${role}`,
    );
  }
  if (await hasPersonalizationSettingsState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT ON TABLE ${schema}.user_personalization_settings TO ${role};
       GRANT SELECT ON TABLE ${schema}.team_personalization_settings TO ${role};
       GRANT UPDATE(content,apply_to_team_tasks,version,updated_at)
         ON TABLE ${schema}.user_personalization_settings TO ${role}`,
    );
  }
  if (await hasLocalAccountState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT ON TABLE ${schema}.user_accounts TO ${role};
       ${
         (await hasEmbeddedIdentityState(client, context.schema))
           ? `GRANT UPDATE(better_auth_user_id,display_name,updated_at) ON TABLE ${schema}.user_accounts TO ${role};`
           : ""
}
       GRANT SELECT,INSERT,DELETE ON TABLE ${schema}.user_sessions TO ${role}`,
    );
  }
  if (await hasEmbeddedIdentityState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
         ${schema}.better_auth_users,${schema}.better_auth_sessions,
         ${schema}.better_auth_accounts,${schema}.better_auth_verifications,
         ${schema}.better_auth_rate_limits TO ${role};
       GRANT SELECT ON TABLE ${schema}.identity_auth_configuration TO ${role}`,
    );
  }
  await client.query(
    `GRANT SELECT, INSERT ON TABLE ${schema}.threads TO ${role};
     GRANT SELECT, INSERT, UPDATE ON TABLE ${schema}.runs, ${schema}.workspaces TO ${role}`,
  );
  await client.query(`GRANT SELECT, INSERT ON TABLE ${schema}.workspace_revisions TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.workspace_write_leases TO ${role}`,
  );
  // 生命周期历史与副作用证明只允许追加或状态推进，Runtime 永远不能物理删除审计事实。
  await client.query(
    `GRANT SELECT, INSERT ON TABLE
       ${schema}.blob_lifecycles,
       ${schema}.blob_incarnations,
       ${schema}.blob_commits,
       ${schema}.promotion_authorizations,
       ${schema}.promotion_executions,
       ${schema}.blob_gc_claims,
       ${schema}.retired_blob_tombstones,
       ${schema}.blob_references
     TO ${role}`,
  );
  await client.query(`GRANT SELECT, INSERT ON TABLE ${schema}.blob_allocations TO ${role}`);
  if (await hasRunWorkerState(client)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
       ${schema}.run_execution_inputs,
       ${schema}.execution_attempts,
       ${schema}.execution_workspace_fences,
       ${schema}.run_claims,
       ${schema}.rollout_projections,
       ${schema}.run_events,
       ${schema}.sandbox_registry,
       ${schema}.cleanup_outbox,
       ${schema}.sandbox_lifecycle_unknown,
       ${schema}.runtime_alert_outbox,
       ${schema}.effect_invocations,
       ${schema}.external_effect_permits,
       ${schema}.mutation_receipts
       TO ${role}`,
    );
    if (await hasCleanupConsumerState(client)) {
      await client.query(
        `GRANT UPDATE(claim_token, claim_generation, claimed_by, claim_lease_expires_at, retry_at, attempt_count, remote_call_started_at) ON TABLE ${schema}.cleanup_outbox TO ${role}`,
      );
    }
  }
  if (await hasRunDispatchState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.api_idempotency_records,
         ${schema}.run_dispatch_outbox
       TO ${role}`,
    );
  }
  if (await hasWorkerTenantAssignmentState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.worker_tenant_assignments TO ${role}`,
    );
    await client.query(
      `GRANT USAGE ON SCHEMA ${schema} TO ${coordinatorRole};
       GRANT SELECT ON TABLE ${schema}.worker_tenant_assignments TO ${coordinatorRole};
       GRANT UPDATE(
         state,generation,claim_token,claimed_by,lease_expires_at,updated_at
       ) ON TABLE ${schema}.worker_tenant_assignments TO ${coordinatorRole}`,
    );
  }
  if (await hasThreadCreationState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.api_thread_idempotency_records TO ${role}`,
    );
  }
  if (await hasThreadHeadState(client, context.schema)) {
    await client.query(`GRANT SELECT, INSERT ON TABLE ${schema}.thread_execution_heads TO ${role}`);
  }
  if (await hasThreadSandboxSessionState(client, context.schema)) {
    const providerIdentity = await hasSandboxProviderIdentityState(client, context.schema);
    await client.query(
      `GRANT UPDATE(
         state,materialized_revision_id,materialization_attested,paused_at,
         retention_expires_at,current_effect_id,updated_at,terminated_at
       ) ON TABLE ${schema}.thread_sandbox_sessions TO ${role};
       GRANT UPDATE(attempt_id,owner,expires_at,released_at,updated_at)
         ON TABLE ${schema}.thread_sandbox_leases TO ${role};
       GRANT UPDATE(
         state,${providerIdentity ? "provider_key," : ""}provider_sandbox_id,resulting_session_state,provider_receipt_digest,
         claim_token,claimed_by,claim_generation,claim_expires_at,
         remote_call_started_at,updated_at,completed_at
       ) ON TABLE ${schema}.sandbox_lifecycle_effects TO ${role}`,
    );
  }
  if (await hasThreadInputQueueState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.thread_input_receipts, ${schema}.thread_follow_up_queue TO ${role}`,
    );
  }
  if (await hasThreadInputRoutingState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.thread_input_receipt_events TO ${role}`,
    );
  }
  if (await hasHistoryFilesystemState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.thread_history_directories,
         ${schema}.thread_history_file_entries TO ${role};
       GRANT UPDATE(
         directory_name,naming_state,first_file_at,last_file_at,file_count,version,updated_at)
         ON TABLE ${schema}.thread_history_directories TO ${role};
       GRANT UPDATE(last_attached_at,attachment_count,updated_at)
         ON TABLE ${schema}.thread_history_file_entries TO ${role}`,
    );
  }
  if (await hasThreadTitleGenerationState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.thread_title_generation_outbox TO ${role};
       GRANT UPDATE(
         state,claim_token,claim_generation,claimed_by,claim_expires_at,attempt_count,
         next_attempt_at,last_error_code,model_key,prompt_tokens,completion_tokens,duration_ms,
         completed_at,updated_at
       ) ON TABLE ${schema}.thread_title_generation_outbox TO ${role}`,
    );
  }
  if (await hasMemoryIngestionState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.memory_ingestion_outbox TO ${role};
       GRANT UPDATE(
         state,provider_event_id,claim_token,claim_generation,claimed_by,claim_expires_at,
         attempt_count,next_attempt_at,last_error_code,submitted_at,completed_at,updated_at
       ) ON TABLE ${schema}.memory_ingestion_outbox TO ${role}`,
    );
  }
  if (await hasScheduledTaskState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.scheduled_tasks,
         ${schema}.scheduled_task_revisions,
         ${schema}.scheduled_task_occurrences,
         ${schema}.scheduled_task_commands TO ${role};
       GRANT UPDATE(
         name,instruction,timezone,rrule,status,overlap_policy,next_run_at,last_run_at,
         current_revision,updated_at
       ) ON TABLE ${schema}.scheduled_tasks TO ${role};
       GRANT UPDATE(
         state,dispatch_attempts,next_attempt_at,run_id,receipt_id,failure_code,updated_at
       ) ON TABLE ${schema}.scheduled_task_occurrences TO ${role}`,
    );
  }
  if (await hasEmbeddedIdentityState(client, context.schema)) {
    for (const [table, policy, target] of embeddedIdentityPolicyBindings) {
      const role =
        target === "migrator"
          ? context.migratorRole
          : target === "runtime"
            ? context.runtimeRole
            : context.adminControlRole;
      await client.query(
        `ALTER POLICY ${quoteIdentifier(policy)} ON ${schema}.${quoteIdentifier(table)} TO ${quoteIdentifier(role)}`,
      );
    }
  }
  if (await hasRunAgentSnapshotState(client, context.schema)) {
    await client.query(
      `ALTER POLICY agent_revision_revocations_snapshot_read ON ${schema}.agent_revision_revocations TO ${role};
       GRANT SELECT,INSERT ON TABLE ${schema}.run_agent_snapshots TO ${role}`,
    );
  }
  if (await hasRunPlaygroundMockState(client, context.schema)) {
    // Run 来源与父 Thread 在受理后不可改写，Worker 只推进状态、版本与时间。
    await client.query(`REVOKE UPDATE ON ${schema}.runs FROM ${role};
      GRANT UPDATE(status, version, updated_at) ON ${schema}.runs TO ${role};
      GRANT SELECT ON ${schema}.playground_acceptance_scope TO ${role};
      GRANT SELECT,INSERT ON TABLE ${schema}.run_playground_mocks TO ${role};
      ALTER POLICY playground_directory_read ON ${schema}.run_agent_snapshots TO ${quoteIdentifier(context.migratorRole)}`);
    for (const [table, policy] of [
      ["threads", "read"],
      ["threads", "insert"],
      ["runs", "read"],
      ["runs", "insert"],
      ["agent_definitions", "read"],
      ["agent_revisions", "read"],
      ["run_agent_snapshots", "insert"],
      ["run_playground_mocks", "read"],
      ["run_playground_mocks", "insert"],
    ]) {
      await client.query(`ALTER POLICY playground_${policy} ON ${schema}.${table} TO ${role}`);
    }
  }
  if (await hasRunExternalToolSnapshotView(client, context.schema)) {
    await client.query(
      `GRANT SELECT ON TABLE ${schema}.worker_run_external_tool_snapshots TO ${coordinatorRole};
       GRANT SELECT ON TABLE ${schema}.runtime_external_tool_permit_gate TO ${role}`,
    );
  }
  if (await hasAgentDefinitionState(client, context.schema)) {
    await client.query(
      `GRANT SELECT ON TABLE ${schema}.agent_definitions,${schema}.agent_definition_tenants,${schema}.agent_revisions,${schema}.agent_revision_revocations TO ${role}`,
    );
  }
  if (await hasAdminControlState(client, context.schema)) {
    await client.query(
      `GRANT SELECT ON TABLE
         ${schema}.admin_control_config_revisions,
         ${schema}.admin_control_active_configs,
         ${schema}.admin_control_generation TO ${role};
       GRANT SELECT,INSERT ON TABLE ${schema}.run_runtime_config_snapshots TO ${role}`,
    );
  }
  if (await hasManagedSandboxState(client, context.schema)) {
    for (const table of managedSandboxRuntimeTables)
      await client.query(`GRANT SELECT ON ${schema}.${quoteIdentifier(table)} TO ${role}`);
    await client.query(
      `GRANT SELECT,INSERT ON ${schema}.sandbox_configuration_bindings TO ${role}`,
    );
  }
  if (await hasRunCompactionSettingsState(client, context.schema)) {
    await client.query(
      `GRANT SELECT,INSERT ON TABLE ${schema}.run_compaction_settings_snapshots TO ${role}`,
    );
  }
  if (await hasRunWorkspaceResultState(client, context.schema)) {
    await client.query(`GRANT SELECT, INSERT ON TABLE ${schema}.run_workspace_results TO ${role}`);
  }
  if (await hasThreadContextState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.thread_context_streams,
         ${schema}.thread_context_entries,
         ${schema}.thread_context_append_commands TO ${role};
       GRANT UPDATE(next_sequence,updated_at)
         ON TABLE ${schema}.thread_context_streams TO ${role}`,
    );
  }
  if (await hasThreadContextCompactionState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.thread_context_compaction_checkpoints,
         ${schema}.thread_context_compaction_replacement_items TO ${role};
       GRANT UPDATE(current_window_number,current_checkpoint_id,current_compatibility_digest)
         ON TABLE ${schema}.thread_context_streams TO ${role}`,
    );
  }
  if (await hasThreadContextAuditState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.thread_context_history_audits TO ${role}`,
    );
  }
  if (await hasThreadSandboxSessionState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.thread_sandbox_sessions,
         ${schema}.thread_sandbox_leases,
         ${schema}.sandbox_lifecycle_effects TO ${role}`,
    );
  }
  if (await hasThreadContinuityRolloutState(client, context.schema)) {
    // Tenant rollout 策略只由运维/Migrator 修改；Runtime 只读策略并追加档案、审计和指标。
    await client.query(
      `GRANT SELECT ON TABLE ${schema}.tenant_thread_continuity_policies TO ${role};
       GRANT SELECT, INSERT ON TABLE
         ${schema}.thread_context_legacy_anchors,
         ${schema}.thread_context_legacy_backfill_items,
         ${schema}.thread_continuity_profiles,
         ${schema}.thread_continuity_metric_observations TO ${role}`,
    );
  }
  if (await hasResourceLibraryState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.resources,
         ${schema}.resource_versions,
         ${schema}.resource_promotion_authorizations,
         ${schema}.resource_promotion_idempotency
       TO ${role}`,
    );
  }
  if (await hasArtifactDeliveryState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.artifact_deliverable_commands,
         ${schema}.artifact_deliverable_declarations,
         ${schema}.artifact_publications,
         ${schema}.artifact_publication_settlements,
         ${schema}.artifact_publication_commands
       TO ${role}`,
    );
  }
  if (await hasRuntimeRolloutState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.runtime_rollout_streams,
         ${schema}.runtime_rollout_entries,
         ${schema}.runtime_rollout_append_commands,
         ${schema}.runtime_rollout_replacements,
         ${schema}.runtime_rollout_checkpoints,
         ${schema}.runtime_rollout_checkpoint_commands
       TO ${role}`,
    );
  }
  if (await hasRuntimePtcDispatchState(client, context.schema)) {
    // 开始身份不可更新；Runtime 只能补齐结果列，不能删除或截断审计日志。
    await client.query(`GRANT SELECT, INSERT ON TABLE ${schema}.runtime_ptc_dispatches TO ${role}`);
    await client.query(
      `GRANT UPDATE(result_idempotency_key,result_digest,result_body,is_truncated,
         blob_reference_id,blob_state,blob_purpose,blob_sha256,blob_size,completed_at)
         ON TABLE ${schema}.runtime_ptc_dispatches TO ${role}`,
    );
  }
  if (await hasRuntimeAgentControlState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.runtime_agent_threads,
         ${schema}.runtime_agent_turns,
         ${schema}.runtime_agent_mailbox_messages,
         ${schema}.runtime_agent_commands
       TO ${role}`,
    );
    await client.query(
      `GRANT UPDATE(status,updated_at) ON TABLE ${schema}.runtime_agent_threads TO ${role}`,
    );
    await client.query(
      `GRANT UPDATE(status,final_answer,error_code,started_at,completed_at)
         ON TABLE ${schema}.runtime_agent_turns TO ${role}`,
    );
  }
  if (await hasRuntimeSubagentConversationState(client, context.schema)) {
    const currentTask = await hasRuntimeSubagentCurrentTaskState(client, context.schema);
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.runtime_subagent_conversations TO ${role}`,
    );
    await client.query(
      `GRANT UPDATE(turn_ordinal,${currentTask ? "current_task," : ""}history,history_digest,updated_at)
         ON TABLE ${schema}.runtime_subagent_conversations TO ${role}`,
    );
  }
  if (await hasWaitingRecoveryState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.waiting_recovery_checkpoints,
         ${schema}.waiting_recovery_effect_outbox
       TO ${role}`,
    );
  }
  if (await hasWorkspaceRuntimeState(client, context.schema)) {
    // 恢复指标是只追加审计事实。
    await client.query(
      `GRANT SELECT, INSERT ON TABLE ${schema}.runtime_recovery_metrics TO ${role}`,
    );
  }
  if (await hasWorkspaceManifestState(client, context.schema)) {
    // Revision manifest 是只追加事实；journal 仅能沿单调状态机更新。
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.workspace_revision_manifests,
         ${schema}.workspace_revision_files,
         ${schema}.workspace_operation_journal
       TO ${role}`,
    );
    await client.query(
      `GRANT UPDATE(status, result, failure_phase, failure_code, unknown_fact, updated_at)
         ON TABLE ${schema}.workspace_operation_journal TO ${role}`,
    );
  }
  if (await hasWorkspaceCandidateState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.workspace_revision_candidates,
         ${schema}.workspace_revision_candidate_files
       TO ${role}`,
    );
    await client.query(
      `GRANT UPDATE(status, manifest_digest, release_reason, expires_at, updated_at)
         ON TABLE ${schema}.workspace_revision_candidates TO ${role};
       GRANT UPDATE(manifest_digest)
         ON TABLE ${schema}.workspace_revision_candidate_files TO ${role}`,
    );
  }
  if (await hasWorkspaceArtifactIntentState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.workspace_artifact_publication_intents
       TO ${role}`,
    );
  }
  if (await hasModelWireTraceState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.model_wire_trace_cleanup_commands,
         ${schema}.model_wire_trace_cleanup_items,
         ${schema}.model_wire_trace_expiry_tombstones
       TO ${role};
       GRANT SELECT, INSERT, DELETE ON TABLE ${schema}.model_wire_trace_records TO ${role};
       GRANT DELETE ON TABLE ${schema}.blob_references TO ${role};
       GRANT UPDATE(status, deleted_count, completed_at)
         ON TABLE ${schema}.model_wire_trace_cleanup_commands TO ${role};
       GRANT UPDATE(state, outcome, attempt_count, updated_at)
         ON TABLE ${schema}.model_wire_trace_cleanup_items TO ${role};
       GRANT UPDATE(staging_swept_at)
         ON TABLE ${schema}.model_wire_trace_expiry_tombstones TO ${role};
       GRANT UPDATE(
          persistence_status, blob_reference_id, blob_state, blob_purpose, blob_lifecycle_id,
          blob_incarnation_id, physical_object_key, processing_token, processing_lease_expires_at,
          retention_recovery_at, cleanup_command_id, updated_at
        ) ON TABLE ${schema}.model_wire_trace_records TO ${role}`,
    );
  }
  if (await hasSkillCenterState(client, context.schema)) {
    // Skill 内容由受信发布流程写入；安装事实由当前 Schema 版本决定是旧用户级还是 Tenant 级。
    await client.query(
      `GRANT SELECT ON TABLE
         ${schema}.skills,
         ${schema}.skill_versions,
         ${schema}.skill_version_files
       TO ${role}`,
    );
    if (!(await hasTeamCollaborationState(client, context.schema))) {
      await client.query(
        `GRANT SELECT, INSERT ON TABLE
           ${schema}.user_skill_installation_commands,
           ${schema}.user_skill_installation_audits
         TO ${role};
         GRANT SELECT, INSERT ON TABLE ${schema}.user_skill_installations TO ${role};
         GRANT UPDATE(
           skill_version,invocation_name,status,version_token,installed_at,updated_at
         ) ON TABLE ${schema}.user_skill_installations TO ${role}`,
      );
    }
  }
  if (await hasSkillRuntimeState(client, context.schema)) {
    await client.query(
      `GRANT SELECT, INSERT ON TABLE
         ${schema}.run_skill_snapshots,
         ${schema}.run_skill_snapshot_items,
         ${schema}.skill_invocations
       TO ${role};
       GRANT UPDATE(status,instruction_digest,failure_code,updated_at)
         ON TABLE ${schema}.skill_invocations TO ${role}`,
    );
  }
  await client.query(
    `GRANT UPDATE(state, current_incarnation_id, generation, current_claim_id, lease_expires_at, updated_at)
       ON TABLE ${schema}.blob_lifecycles TO ${role};
     GRANT UPDATE(state, retired_at)
       ON TABLE ${schema}.blob_incarnations TO ${role};
     GRANT UPDATE(status, version, snapshot, updated_at)
       ON TABLE ${schema}.blob_commits TO ${role};
     GRANT UPDATE(state, current_execution_id, execution_generation, updated_at)
       ON TABLE ${schema}.promotion_authorizations TO ${role};
     GRANT UPDATE(phase, proof_status, updated_at)
       ON TABLE ${schema}.promotion_executions TO ${role};
     GRANT UPDATE(phase, updated_at)
       ON TABLE ${schema}.blob_gc_claims TO ${role};
     GRANT UPDATE(generation, scrub_lease_expires_at, next_scrub_at, last_scrubbed_at)
       ON TABLE ${schema}.retired_blob_tombstones TO ${role};
     GRANT UPDATE(state, lifecycle_id, incarnation_id, physical_object_key, updated_at)
       ON TABLE ${schema}.blob_references TO ${role}`,
  );
  if (await hasRunWorkerState(client)) {
    await client.query(
      `GRANT UPDATE(answer_text, updated_at)
       ON TABLE ${schema}.run_execution_inputs TO ${role};
     GRANT UPDATE(
       current_revision_id, status, stage, version, next_event_sequence, projection_version,
       model_execution_started, updated_at, finished_at
     ) ON TABLE ${schema}.execution_attempts TO ${role};
     GRANT UPDATE(expires_at, updated_at, released_at)
       ON TABLE ${schema}.run_claims TO ${role};
     GRANT UPDATE(attempt_id, version, projection, digest, updated_at)
       ON TABLE ${schema}.rollout_projections TO ${role};
     GRANT UPDATE(state, actual_ttl_seconds, updated_at)
       ON TABLE ${schema}.sandbox_registry TO ${role};
     GRANT UPDATE(state, disposition, payload, payload_digest, updated_at)
       ON TABLE ${schema}.cleanup_outbox TO ${role};
       GRANT UPDATE(consumed_at)
         ON TABLE ${schema}.external_effect_permits TO ${role}`,
    );
  }
  if (await hasRunDispatchState(client, context.schema)) {
    await client.query(
      `GRANT UPDATE(
         state, generation, claim_token, claimed_by, lease_expires_at, next_attempt_at,
         dispatch_attempts, last_error_code, updated_at
       ) ON TABLE ${schema}.run_dispatch_outbox TO ${role}`,
    );
  }
  if (await hasWorkerTenantAssignmentState(client, context.schema)) {
    await client.query(
      `GRANT UPDATE(
         state,generation,claim_token,claimed_by,lease_expires_at,next_attempt_at,updated_at
       ) ON TABLE ${schema}.worker_tenant_assignments TO ${role}`,
    );
  }
  const threadUpdateColumns = (await activeColumnUpdatePolicy(client, context.schema)).get(
    "threads",
  );
  if (threadUpdateColumns !== undefined && threadUpdateColumns.size > 0) {
    await client.query(
      `GRANT UPDATE(${[...threadUpdateColumns].map(quoteIdentifier).join(",")}) ON TABLE ${schema}.threads TO ${role}`,
    );
  }
  if (await hasThreadHeadState(client, context.schema)) {
    const inputRouting = await hasThreadInputRoutingState(client, context.schema);
    await client.query(
      `GRANT UPDATE(
         active_run_id, active_turn_id, next_turn_ordinal, next_queue_sequence,
         ${inputRouting ? "next_input_sequence," : ""}
         context_through_sequence, writer_owner, writer_token, writer_epoch,
         writer_expires_at, version, updated_at
       ) ON TABLE ${schema}.thread_execution_heads TO ${role}`,
    );
  }
  if (await hasThreadInputQueueState(client, context.schema)) {
    const inputRouting = await hasThreadInputRoutingState(client, context.schema);
    await client.query(
      `GRANT UPDATE(
         state, disposition,
         ${inputRouting ? "queued_run_id, queue_sequence, target_run_id, target_turn_id," : ""}
         applied_context_sequence, rejection_code, updated_at, consumed_at
       ) ON TABLE ${schema}.thread_input_receipts TO ${role};
       GRANT UPDATE(
         state, claim_owner, claim_token, claim_epoch, claim_expires_at,
         consumption_receipt, activated_at, finished_at
       ) ON TABLE ${schema}.thread_follow_up_queue TO ${role}`,
    );
  }
  if (await hasWaitingRecoveryState(client, context.schema)) {
    await client.query(
      `GRANT UPDATE(state,claim_owner,claim_token,claim_epoch,claim_expires_at,decision,updated_at)
         ON TABLE ${schema}.waiting_recovery_checkpoints TO ${role};
       GRANT UPDATE(state,payload,updated_at)
         ON TABLE ${schema}.waiting_recovery_effect_outbox TO ${role}`,
    );
  }
  if (await hasResourceLibraryState(client, context.schema)) {
    await client.query(
      `GRANT UPDATE(visibility, latest_version_number, latest_version_id, updated_at)
         ON TABLE ${schema}.resources TO ${role};
       GRANT UPDATE(state, consumed_at)
         ON TABLE ${schema}.resource_promotion_authorizations TO ${role}`,
    );
  }
  await grantSkillPublisherAccess(client, context);
  await grantTeamCoordinatorAccess(client, context);
  await grantAdminControlAccess(client, context);
  await assertActiveRuntimeWhitelist(client, context);
  await assertWebhookBoundary(client, context, staleWebhookRoles);
}

/** 独立、可重复的 ACL bootstrap；角色与 Schema preflight 始终先于任何 ACL 变更。 */
export async function bootstrapRuntimeAccess(
  pool: Pool,
  context: MigrationSecurityContext,
): Promise<void> {
  try {
    await withTransaction(pool, (client) => bootstrapRuntimeAccessOnClient(client, context));
  } catch (error) {
    throw mapPersistenceError(error, "配置 Runtime 最小权限");
  }
}

/** 仅在现有 down 事务内调用；数据库级角色 bootstrap 保持不变。 */
export async function teardownRuntimeSchemaAccessOnClient(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const role = quoteIdentifier(context.runtimeRole);
  const publisherRole = quoteIdentifier(context.skillPublisherRole);
  const coordinatorRole = quoteIdentifier(context.workerCoordinatorRole);
  const teamCoordinatorRole = quoteIdentifier(context.teamCoordinatorRole);
  const adminControlRole = quoteIdentifier(context.adminControlRole);
  const webhookDispatcherRole =
    context.webhookDispatcherRole === undefined
      ? undefined
      : quoteIdentifier(context.webhookDispatcherRole);
  const schema = quoteIdentifier(context.schema);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}${webhookDispatcherRole === undefined ? "" : `, ${webhookDispatcherRole}`}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}${webhookDispatcherRole === undefined ? "" : `, ${webhookDispatcherRole}`}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}${webhookDispatcherRole === undefined ? "" : `, ${webhookDispatcherRole}`}`,
  );
  await assertRuntimeAccessRemoved(client, context);
}
