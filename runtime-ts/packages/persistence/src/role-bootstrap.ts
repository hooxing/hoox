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
  "run_runtime_config_snapshots",
]);

const runtimeTablePolicy = new Map<string, ReadonlySet<string>>([
  ["app_users", new Set(["SELECT", "INSERT"])],
  ["user_accounts", new Set(["SELECT", "INSERT"])],
  ["user_sessions", new Set(["SELECT", "INSERT", "DELETE"])],
  ["tenants", new Set(["SELECT", "INSERT"])],
  ["memberships", new Set(["SELECT", "INSERT"])],
  ["user_personalization_settings", new Set(["SELECT", "INSERT"])],
  ["team_personalization_settings", new Set(["SELECT"])],
  ["threads", new Set(["SELECT", "INSERT", "UPDATE"])],
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
  // 管理发布只能由独立数据库角色访问，Runtime 对五张管理表保持零 ACL。
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
  ["run_runtime_config_snapshots", new Set(["SELECT", "INSERT"])],
  [migrationTable, new Set()],
]);

const runtimeColumnUpdatePolicy = new Map<string, ReadonlySet<string>>([
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

async function activeTablePolicy(
  client: PoolClient,
  schema: string,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const policy = new Map(runtimeTablePolicy);
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
  if (!(await hasSkillRuntimeState(client, schema))) {
    for (const table of skillRuntimeTables) policy.delete(table);
  }
  if (!(await hasSkillPublicationState(client, schema))) {
    for (const table of skillPublicationTables) policy.delete(table);
  }
  if (!(await hasAdminControlState(client, schema))) {
    for (const table of adminControlTables) policy.delete(table);
  }
  if ((await hasRunWorkerState(client)) && !(await hasCleanupConsumerState(client))) {
    policy.set("cleanup_outbox", new Set(["SELECT", "INSERT"]));
  }
  return policy;
}

async function activeColumnUpdatePolicy(
  client: PoolClient,
  schema: string,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const policy = new Map(runtimeColumnUpdatePolicy);
  // 0003 之前不存在该列；partial down 后 ACL 必须回到 0002 的真实 Schema，而不是引用未来列。
  const membershipUpdateColumns = new Set<string>();
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
  assertSafeSchemaName(context.schema);
  if (
    new Set([
      context.runtimeRole,
      context.migratorRole,
      context.skillPublisherRole,
      context.workerCoordinatorRole,
      context.teamCoordinatorRole,
      context.adminControlRole,
    ]).size !== 6
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
  readonly target_schema_has_routine: boolean;
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
         SELECT 1 FROM pg_proc routine
          WHERE routine.pronamespace = (SELECT oid FROM target_schema)
       ) AS target_schema_has_routine,
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
}

interface RoleDatabaseScopeRow {
  readonly role_name: string | null;
  readonly outside_database_count: number;
}

/**
 * PostgreSQL 登录角色和密码属于整个集群；不同数据库复用角色会让任一环境的密码轮换击穿其他环境。
 * 迁移与 ACL 修复都必须在任何 DDL/GRANT 前拒绝这种共享，迫使部署使用数据库专属角色。
 */
export async function assertDatabaseRolesCurrentDatabaseScoped(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const requestedRoles = [
    context.runtimeRole,
    context.migratorRole,
    context.skillPublisherRole,
    context.workerCoordinatorRole,
    context.teamCoordinatorRole,
    context.adminControlRole,
  ];
  const result = await client.query<RoleDatabaseScopeRow>(
    `SELECT role.rolname AS role_name,
            count(DISTINCT dependency.dbid) FILTER (
              WHERE dependency.dbid<>0
                AND dependency.dbid<>(SELECT oid FROM pg_database WHERE datname=current_database())
            )::int AS outside_database_count
       FROM unnest($1::text[]) requested(role_name)
       LEFT JOIN pg_roles role ON role.rolname=requested.role_name
       LEFT JOIN pg_shdepend dependency
         ON dependency.refclassid='pg_authid'::regclass AND dependency.refobjid=role.oid
      GROUP BY requested.role_name,role.rolname
      ORDER BY requested.role_name`,
    [requestedRoles],
  );
  if (
    result.rows.length !== requestedRoles.length ||
    result.rows.some((row) => row.role_name === null || row.outside_database_count !== 0)
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "数据库应用角色不得被其他数据库复用");
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
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Team Coordinator 表权限偏离白名单");
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
          "Team Coordinator 列级 UPDATE 权限偏离白名单",
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
  if (sequences.rows.some((row) => row.allowed)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Team Coordinator 不得持有 sequence 权限");
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
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Admin Control 表权限偏离白名单");
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
          "Admin Control 列级 UPDATE 权限偏离白名单",
        );
      }
    }
  }

  const viewPrivilege = await client.query<{ readonly allowed: boolean }>(
    `SELECT CASE WHEN to_regclass(format('%I.admin_runtime_statistics',$2::text)) IS NULL
                 THEN false
                 ELSE has_table_privilege(
                   $1,format('%I.admin_runtime_statistics',$2::text),'SELECT'
                 ) END AS allowed`,
    [context.adminControlRole, context.schema],
  );
  if (viewPrivilege.rows[0]?.allowed !== enabled) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Admin Control 统计视图权限偏离白名单");
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

async function assertRoutinePrivilegeBoundary(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const runtimePrivileges = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_proc routine
      WHERE routine.pronamespace = current_schema()::regnamespace
        AND (
          has_function_privilege($1, routine.oid, 'EXECUTE')
          OR has_function_privilege($2, routine.oid, 'EXECUTE')
          OR has_function_privilege($3, routine.oid, 'EXECUTE')
        )`,
    [context.runtimeRole, context.teamCoordinatorRole, context.adminControlRole],
  );
  const publicPrivileges = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_proc routine
       CROSS JOIN LATERAL aclexplode(
         COALESCE(routine.proacl, acldefault('f'::"char", routine.proowner))
       ) acl
      WHERE routine.pronamespace = current_schema()::regnamespace
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`,
  );
  if (runtimePrivileges.rows[0]?.count !== "0" || publicPrivileges.rows[0]?.count !== "0") {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Routine 执行权限偏离空白名单");
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
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Skill Publisher 表权限偏离白名单");
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
        "Skill Publisher 列级 UPDATE 权限偏离白名单",
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
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Worker Coordinator 表权限偏离白名单");
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
    throw new PersistenceError("CONSTRAINT_VIOLATION", "业务表集合与 Runtime 权限策略不一致");
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
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 表权限偏离白名单");
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
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 列级 UPDATE 权限偏离白名单");
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
  if (sequences.rows.some((row) => row.allowed)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Runtime 不得持有 sequence 权限");
  }
  await assertDatabaseAndSchemaBoundary(client, context, true);
  await assertNoPublicRelationPrivileges(client);
  await assertNoPublicSchemaPrivileges(client);
  await assertRoutinePrivilegeBoundary(client, context);
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
  if (
    JSON.stringify(relations.rows.map((row) => row.table_name)) !== JSON.stringify([migrationTable])
  ) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "down 后仍残留业务表");
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
  if (privileges.rows.some((row) => row.allowed)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "down 后 Runtime 仍持有表权限");
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
  if (sequences.rows.some((row) => row.allowed)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "down 后 Runtime 仍持有 sequence 权限");
  }
  await assertDatabaseAndSchemaBoundary(client, context, false);
  await assertNoPublicRelationPrivileges(client);
  await assertNoPublicSchemaPrivileges(client);
  await assertRoutinePrivilegeBoundary(client, context);
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

async function rebindRoleScopedPolicies(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  const schema = quoteIdentifier(context.schema);
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
}

/** 在既有迁移事务中收敛 ACL，供 down 保证 DDL 与权限回收原子提交。 */
export async function bootstrapRuntimeAccessOnClient(
  client: PoolClient,
  context: MigrationSecurityContext,
): Promise<void> {
  await assertBootstrapContextSafe(client, context);
  const role = quoteIdentifier(context.runtimeRole);
  const publisherRole = quoteIdentifier(context.skillPublisherRole);
  const coordinatorRole = quoteIdentifier(context.workerCoordinatorRole);
  const teamCoordinatorRole = quoteIdentifier(context.teamCoordinatorRole);
  const adminControlRole = quoteIdentifier(context.adminControlRole);
  const schema = quoteIdentifier(context.schema);
  await client.query(
    `REVOKE ALL PRIVILEGES ON SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}`,
  );
  await rebindRoleScopedPolicies(client, context);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(
    `GRANT SELECT, INSERT ON TABLE ${schema}.app_users, ${schema}.tenants, ${schema}.memberships TO ${role}`,
  );
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
       GRANT SELECT,INSERT,DELETE ON TABLE ${schema}.user_sessions TO ${role}`,
    );
  }
  await client.query(
    `GRANT SELECT, INSERT, UPDATE ON TABLE ${schema}.threads, ${schema}.runs, ${schema}.workspaces TO ${role}`,
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
  if (await hasAdminControlState(client, context.schema)) {
    await client.query(
      `GRANT SELECT ON TABLE
         ${schema}.admin_control_config_revisions,
         ${schema}.admin_control_active_configs,
         ${schema}.admin_control_generation TO ${role};
       GRANT SELECT,INSERT ON TABLE ${schema}.run_runtime_config_snapshots TO ${role}`,
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
  const schema = quoteIdentifier(context.schema);
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}`,
  );
  await client.query(
    `REVOKE ALL PRIVILEGES ON SCHEMA ${schema}
       FROM PUBLIC, ${role}, ${publisherRole}, ${coordinatorRole}, ${teamCoordinatorRole}, ${adminControlRole}`,
  );
  await assertRuntimeAccessRemoved(client, context);
}
