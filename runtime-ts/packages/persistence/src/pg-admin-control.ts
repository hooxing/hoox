import { randomUUID } from "node:crypto";
import {
  type AdminControlRepository,
  type AdminControlStatisticsPort,
  type ControlAuditEvent,
  type ControlMutationContext,
  type ControlMutationResult,
  type ControlObjectKind,
  type ControlOperatorRole,
  type ControlRevision,
  defaultModelConfiguration,
  digestControlRequest,
  type MemoryProviderConfiguration,
  type ModelProviderConfiguration,
  normalizeStoredMemoryProviderConfiguration,
  normalizeStoredModelProviderConfiguration,
  normalizeRuntimeSettingsConfiguration,
  type RuntimeControlConfigurationPort,
  type RuntimeControlConfigurationSnapshot,
  type RuntimeSettingsConfiguration,
  type RuntimeStatistics,
  type PlatformUserPage,
  type PlatformUserStatus,
  type PlatformUserSummary,
} from "@hoox/admin-control";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import {
  isEncryptedModelProviderCredential,
  type EncryptedModelProviderCredential,
  type ModelProviderCredentialCipher,
} from "./model-provider-credential.js";
import { withTenantTransaction, withTransaction } from "./postgres.js";

type Configuration =
  | ModelProviderConfiguration
  | MemoryProviderConfiguration
  | RuntimeSettingsConfiguration;

interface RevisionRow extends QueryResultRow {
  readonly object_kind: ControlObjectKind;
  readonly object_key: string;
  readonly revision: string;
  readonly configuration: unknown;
  readonly created_by: string;
  readonly created_at: Date | string;
  readonly version_token: string;
  readonly projection_status: "draft" | "active" | "retired";
  readonly probe_status: "untested" | "healthy" | "failed";
  readonly updated_at: Date | string;
  readonly activated_at: Date | string | null;
}

interface CommandRow extends QueryResultRow {
  readonly request_digest: string;
  readonly response: unknown;
}

interface StatisticsRow extends QueryResultRow {
  readonly generated_at: Date | string;
  readonly users_total: string;
  readonly users_registered_24h: string;
  readonly users_active_7d: string;
  readonly users_disabled: string;
  readonly conversations_total: string;
  readonly conversations_created_24h: string;
  readonly conversations_active_24h: string;
  readonly conversations_archived: string;
  readonly runs_total: string;
  readonly runs_queued: string;
  readonly runs_running: string;
  readonly runs_succeeded_24h: string;
  readonly runs_failed_24h: string;
  readonly runs_cancelled_24h: string;
  readonly dispatch_pending: string;
  readonly dispatch_claimed: string;
  readonly sandboxes_active: string;
  readonly sandboxes_paused: string;
  readonly sandbox_cleanup_pending: string;
  readonly memory_pending: string;
  readonly memory_failed: string;
  readonly automations_active: string;
  readonly automation_failed_occurrences_24h: string;
  readonly skills_published: string;
  readonly skills_installed: string;
  readonly model_input_tokens_24h: string;
  readonly model_output_tokens_24h: string;
  readonly model_cache_read_tokens_24h: string;
  readonly model_generation_duration_ms_24h: string;
}

interface PlatformUserRow extends QueryResultRow {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly status: PlatformUserStatus;
  readonly created_at: Date | string;
  readonly last_active_at: Date | string | null;
  readonly active_sessions: string;
  readonly conversation_count: string;
  readonly run_count: string;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeInteger(value: string, name: string, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} 无效`);
  return parsed;
}

function safeNonnegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} 无效`);
  return parsed;
}

function mapConfiguration(kind: ControlObjectKind, value: unknown): Configuration {
  if (typeof value !== "object" || value === null) throw new Error("控制面配置损坏");
  if (kind === "model_provider") {
    const {
      credential,
      secretRef: _legacySecretRef,
      ...configuration
    } = value as Record<string, unknown>;
    return normalizeStoredModelProviderConfiguration({
      ...configuration,
      credentialConfigured: isEncryptedModelProviderCredential(credential),
    } as unknown as ModelProviderConfiguration);
  }
  if (kind === "memory_provider") {
    return normalizeStoredMemoryProviderConfiguration(value as MemoryProviderConfiguration);
  }
  return normalizeRuntimeSettingsConfiguration(value as RuntimeSettingsConfiguration);
}

function mapRevision<T extends Configuration>(row: RevisionRow): ControlRevision<T> {
  return Object.freeze({
    revision: safeInteger(row.revision, "配置 Revision", 1),
    versionToken: safeInteger(row.version_token, "配置版本令牌", 1),
    status: row.projection_status,
    configuration: mapConfiguration(row.object_kind, row.configuration) as T,
    probeStatus: row.probe_status,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    ...(row.activated_at === null ? {} : { activatedAt: timestamp(row.activated_at) }),
  });
}

function mapPlatformUser(row: PlatformUserRow): PlatformUserSummary {
  return Object.freeze({
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    createdAt: timestamp(row.created_at),
    ...(row.last_active_at === null ? {} : { lastActiveAt: timestamp(row.last_active_at) }),
    activeSessions: safeInteger(row.active_sessions, "活跃会话数"),
    conversationCount: safeInteger(row.conversation_count, "用户对话数"),
    runCount: safeInteger(row.run_count, "用户运行数"),
  });
}

const revisionProjectionSql = `
  SELECT revision.object_kind,revision.object_key,revision.revision::text,
         revision.configuration,revision.created_by,revision.created_at,
         (1+COALESCE(probe_count.total,0)+COALESCE(activation_count.total,0))::text AS version_token,
         CASE
           WHEN active.object_key=revision.object_key AND active.revision=revision.revision THEN 'active'
           WHEN EXISTS (
             SELECT 1 FROM admin_control_activation_events event
              WHERE event.object_kind=revision.object_kind
                AND event.object_key=revision.object_key AND event.revision=revision.revision
           ) THEN 'retired'
           ELSE 'draft'
         END AS projection_status,
         COALESCE(probe.status,'untested') AS probe_status,
         GREATEST(
           revision.created_at,
           COALESCE(probe.created_at,revision.created_at),
           COALESCE(activation_count.activated_at,revision.created_at)
         ) AS updated_at,
         activation_count.activated_at
    FROM admin_control_config_revisions revision
    LEFT JOIN admin_control_active_configs active
      ON active.object_kind=revision.object_kind
    LEFT JOIN LATERAL (
      SELECT candidate.sequence,candidate.status,candidate.created_at
        FROM admin_control_provider_probes candidate
       WHERE candidate.object_kind=revision.object_kind
         AND candidate.object_key=revision.object_key AND candidate.revision=revision.revision
       ORDER BY candidate.sequence DESC LIMIT 1
    ) probe ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS total
        FROM admin_control_provider_probes candidate
       WHERE candidate.object_kind=revision.object_kind
         AND candidate.object_key=revision.object_key AND candidate.revision=revision.revision
    ) probe_count ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::bigint AS total,max(event.created_at) AS activated_at
        FROM admin_control_activation_events event
       WHERE event.object_kind=revision.object_kind
         AND event.object_key=revision.object_key AND event.revision=revision.revision
    ) activation_count ON true`;

async function withControlTransaction<T>(
  pool: Pool,
  userId: string,
  operation: (client: PoolClient) => Promise<T>,
  options: {
    readonly readOnly?: boolean;
    readonly isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
  } = {},
): Promise<T> {
  return await withTransaction(
    pool,
    async (client) => {
      await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
      return await operation(client);
    },
    options,
  );
}

async function projectedRevision(
  client: PoolClient,
  kind: ControlObjectKind,
  key: string,
  revision: number,
): Promise<RevisionRow | undefined> {
  const result = await client.query<RevisionRow>(
    `${revisionProjectionSql}
      WHERE revision.object_kind=$1 AND revision.object_key=$2 AND revision.revision=$3`,
    [kind, key, revision],
  );
  return result.rows[0];
}

async function recordAudit(
  client: PoolClient,
  input: {
    readonly actorUserId: string;
    readonly kind: ControlObjectKind;
    readonly key: string;
    readonly revision: number;
    readonly action: ControlAuditEvent["action"];
    readonly reason: string;
    readonly outcome: ControlAuditEvent["outcome"];
  },
): Promise<void> {
  await client.query(
    `INSERT INTO admin_control_audits(
       audit_id,actor_user_id,object_kind,object_key,revision,action,reason,outcome
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      `audit_${randomUUID().replaceAll("-", "")}`,
      input.actorUserId,
      input.kind,
      input.key,
      input.revision,
      input.action,
      input.reason,
      input.outcome,
    ],
  );
}

async function idempotentMutation<T>(
  client: PoolClient,
  context: ControlMutationContext,
  operation: () => Promise<ControlMutationResult<T>>,
): Promise<ControlMutationResult<T>> {
  // 同一 actor/key 的并发请求必须先串行化，后到请求才能读到已提交响应并稳定重放。
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
    context.actorUserId,
    context.idempotencyKey,
  ]);
  const existing = await client.query<CommandRow>(
    `SELECT request_digest,response FROM admin_control_commands
      WHERE actor_user_id=$1 AND idempotency_key=$2`,
    [context.actorUserId, context.idempotencyKey],
  );
  const command = existing.rows[0];
  if (command !== undefined) {
    if (command.request_digest !== context.requestDigest) return { outcome: "key_conflict" };
    return { outcome: "replayed", value: command.response as T };
  }
  const result = await operation();
  if (result.outcome !== "applied") return result;
  await client.query(
    `INSERT INTO admin_control_commands(actor_user_id,idempotency_key,request_digest,response)
     VALUES($1,$2,$3,$4::jsonb)`,
    [
      context.actorUserId,
      context.idempotencyKey,
      context.requestDigest,
      JSON.stringify(result.value),
    ],
  );
  return result;
}

async function activateConfiguration(
  client: PoolClient,
  input: {
    readonly actorUserId: string;
    readonly kind: ControlObjectKind;
    readonly objectKey: string;
    readonly revision: number;
    readonly reason: string;
  },
  currentGeneration: number,
): Promise<void> {
  const previous = await client.query<{ readonly object_key: string; readonly revision: string }>(
    "SELECT object_key,revision::text FROM admin_control_active_configs WHERE object_kind=$1",
    [input.kind],
  );
  const previousActive = previous.rows[0];
  if (
    previousActive?.object_key === input.objectKey &&
    Number(previousActive.revision) === input.revision
  )
    return;
  const generation = currentGeneration + 1;
  const activatedBefore = await client.query(
    "SELECT 1 FROM admin_control_activation_events WHERE object_kind=$1 AND object_key=$2 AND revision=$3 LIMIT 1",
    [input.kind, input.objectKey, input.revision],
  );
  await client.query(
    `INSERT INTO admin_control_active_configs(object_kind,object_key,revision,generation,activated_by,reason)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(object_kind) DO UPDATE SET object_key=EXCLUDED.object_key,revision=EXCLUDED.revision,
       generation=EXCLUDED.generation,activated_by=EXCLUDED.activated_by,
       reason=EXCLUDED.reason,activated_at=clock_timestamp()`,
    [input.kind, input.objectKey, input.revision, generation, input.actorUserId, input.reason],
  );
  await client.query(
    `INSERT INTO admin_control_activation_events(generation,object_kind,object_key,revision,replaced_object_key,replaced_revision,actor_user_id,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      generation,
      input.kind,
      input.objectKey,
      input.revision,
      previousActive?.object_key ?? null,
      previousActive?.revision ?? null,
      input.actorUserId,
      input.reason,
    ],
  );
  await client.query(
    "UPDATE admin_control_generation SET generation=$1,updated_at=clock_timestamp() WHERE singleton='global'",
    [generation],
  );
  await recordAudit(client, {
    actorUserId: input.actorUserId,
    kind: input.kind,
    key: input.objectKey,
    revision: input.revision,
    action: activatedBefore.rowCount === 0 ? "publish" : "rollback",
    reason: input.reason,
    outcome: "succeeded",
  });
}

export class PgAdminControlRepository
  implements AdminControlRepository, AdminControlStatisticsPort
{
  constructor(
    private readonly pool: Pool,
    private readonly credentialCipher: ModelProviderCredentialCipher,
    private readonly legacyModelApiKey?: string,
  ) {}

  async resolveRole(userId: string): Promise<ControlOperatorRole | undefined> {
    try {
      return await withControlTransaction(
        this.pool,
        userId,
        async (client) => {
          const result = await client.query<{ readonly role: ControlOperatorRole }>(
            `SELECT role FROM platform_control_operators
              WHERE user_id=$1 AND status='active'`,
            [userId],
          );
          return result.rows[0]?.role;
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析后台控制面角色");
    }
  }

  async generation(userId: string): Promise<number> {
    return await this.readAs(userId, async (client) => {
      const result = await client.query<{ readonly generation: string }>(
        "SELECT generation::text FROM admin_control_generation WHERE singleton='global'",
      );
      return safeInteger(result.rows[0]?.generation ?? "", "控制面 Generation");
    });
  }

  async listModelProviders(userId: string) {
    return await this.listRevisions<ModelProviderConfiguration>(userId, "model_provider");
  }

  async listMemoryProviders(userId: string) {
    return await this.listRevisions<MemoryProviderConfiguration>(userId, "memory_provider");
  }

  async listRuntimeSettings(userId: string) {
    return await this.listRevisions<RuntimeSettingsConfiguration>(userId, "runtime_settings");
  }

  async getActiveRuntimeSettings(userId: string) {
    return (await this.listRuntimeSettings(userId)).find(
      (revision) => revision.status === "active",
    );
  }

  async saveModelConfiguration(
    input: Parameters<AdminControlRepository["saveModelConfiguration"]>[0],
  ) {
    return await this.saveProviderConfiguration<ModelProviderConfiguration>(
      input,
      "model_provider",
    );
  }

  async saveMemoryConfiguration(
    input: Parameters<AdminControlRepository["saveMemoryConfiguration"]>[0],
  ) {
    return await this.saveProviderConfiguration<MemoryProviderConfiguration>(
      input,
      "memory_provider",
    );
  }

  private async saveProviderConfiguration<
    T extends ModelProviderConfiguration | MemoryProviderConfiguration,
  >(
    input:
      | Parameters<AdminControlRepository["saveModelConfiguration"]>[0]
      | Parameters<AdminControlRepository["saveMemoryConfiguration"]>[0],
    kind: "model_provider" | "memory_provider",
  ): Promise<ControlMutationResult<ControlRevision<T>>> {
    try {
      return await withControlTransaction(this.pool, input.actorUserId, async (client) => {
        const role = await client.query<{ readonly role: string }>(
          "SELECT role FROM platform_control_operators WHERE user_id=$1 AND status='active'",
          [input.actorUserId],
        );
        if (role.rows[0]?.role !== "admin") return { outcome: "not_authorized" };
        return await idempotentMutation(client, input, async () => {
          // 一次保存同时写入不可变配置与当前指针；旧页面的并发保存不能覆盖新决定。
          const locked = await client.query<{ readonly generation: string }>(
            "SELECT generation::text FROM admin_control_generation WHERE singleton='global' FOR UPDATE",
          );
          const generation = safeInteger(locked.rows[0]?.generation ?? "", "配置更新状态");
          const { expectedGeneration, reason, ...command } = input.command;
          if (generation !== expectedGeneration) return { outcome: "conflict" };
          const key = command.providerKey;
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${kind}:${key}`]);
          let stored: object;
          let configurationDigest: string;
          if (kind === "model_provider") {
            const { apiKey, reuseCredentialFromRevision, ...configuration } = command as Omit<
              Parameters<AdminControlRepository["saveModelConfiguration"]>[0]["command"],
              "expectedGeneration" | "reason"
            >;
            let credential: EncryptedModelProviderCredential | undefined;
            if (apiKey !== undefined) {
              credential = this.credentialCipher.encrypt(key, apiKey);
            } else if (reuseCredentialFromRevision !== undefined) {
              const source = await client.query<{ readonly configuration: unknown }>(
                "SELECT configuration FROM admin_control_config_revisions WHERE object_kind='model_provider' AND object_key=$1 AND revision=$2",
                [key, reuseCredentialFromRevision],
              );
              const raw = source.rows[0]?.configuration;
              const candidate =
                typeof raw === "object" && raw !== null
                  ? (raw as Record<string, unknown>).credential
                  : undefined;
              if (isEncryptedModelProviderCredential(candidate)) credential = candidate;
            }
            if (credential === undefined) return { outcome: "conflict" };
            stored = { ...configuration, credential };
            configurationDigest = digestControlRequest({
              configuration,
              credentialFingerprint: credential.ciphertext,
            });
          } else {
            // 当前运行模型是记忆快照的接入前置；不能保存后仍悄悄使用部署回退记忆。
            if ((await activeConfiguration(client, "model_provider")) === undefined)
              return { outcome: "conflict" };
            stored = command;
            configurationDigest = digestControlRequest(command);
          }
          const duplicate = await client.query<{ readonly revision: string }>(
            "SELECT revision::text FROM admin_control_config_revisions WHERE object_kind=$1 AND object_key=$2 AND configuration_digest=$3",
            [kind, key, configurationDigest],
          );
          let revision = duplicate.rows[0]?.revision;
          if (revision === undefined) {
            const next = await client.query<{ readonly revision: string }>(
              "SELECT (COALESCE(max(revision),0)+1)::text AS revision FROM admin_control_config_revisions WHERE object_kind=$1 AND object_key=$2",
              [kind, key],
            );
            revision = String(safeInteger(next.rows[0]?.revision ?? "", "配置快照", 1));
            await client.query(
              `INSERT INTO admin_control_config_revisions(object_kind,object_key,revision,configuration,configuration_digest,created_by)
               VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
              [kind, key, revision, JSON.stringify(stored), configurationDigest, input.actorUserId],
            );
          }
          await activateConfiguration(
            client,
            {
              actorUserId: input.actorUserId,
              kind,
              objectKey: key,
              revision: safeInteger(revision, "配置快照", 1),
              reason,
            },
            generation,
          );
          const projected = await projectedRevision(client, kind, key, Number(revision));
          if (projected === undefined) throw new Error("保存后的配置投影缺失");
          return { outcome: "applied", value: mapRevision<T>(projected) };
        });
      });
    } catch (error) {
      throw mapPersistenceError(error, "保存并使用服务配置");
    }
  }

  async createModelDraft(input: Parameters<AdminControlRepository["createModelDraft"]>[0]) {
    const { reason, apiKey, reuseCredentialFromRevision, ...configuration } = input.command;
    const key = configuration.providerKey;
    try {
      return await withControlTransaction(
        this.pool,
        input.actorUserId,
        async (client) =>
          await idempotentMutation(client, input, async () => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
              `model_provider:${key}`,
            ]);
            let credential: EncryptedModelProviderCredential | undefined;
            if (apiKey !== undefined) {
              credential = this.credentialCipher.encrypt(key, apiKey);
            } else if (reuseCredentialFromRevision !== undefined) {
              const source = await client.query<{ readonly configuration: unknown }>(
                `SELECT configuration FROM admin_control_config_revisions
                  WHERE object_kind='model_provider' AND object_key=$1 AND revision=$2`,
                [key, reuseCredentialFromRevision],
              );
              const raw = source.rows[0]?.configuration;
              const candidate =
                typeof raw === "object" && raw !== null
                  ? (raw as Record<string, unknown>).credential
                  : undefined;
              if (!isEncryptedModelProviderCredential(candidate)) return { outcome: "conflict" };
              credential = candidate;
            }
            if (credential === undefined) return { outcome: "conflict" };
            const storedConfiguration = {
              ...configuration,
              credential,
            };
            const configurationDigest = digestControlRequest({
              configuration,
              credentialFingerprint: credential.ciphertext,
            });
            const duplicate = await client.query(
              `SELECT 1 FROM admin_control_config_revisions
                WHERE object_kind='model_provider' AND object_key=$1 AND configuration_digest=$2`,
              [key, configurationDigest],
            );
            if ((duplicate.rowCount ?? 0) > 0) return { outcome: "conflict" };
            const next = await client.query<{ readonly revision: string }>(
              `SELECT (COALESCE(max(revision),0)+1)::text AS revision
                 FROM admin_control_config_revisions
                WHERE object_kind='model_provider' AND object_key=$1`,
              [key],
            );
            const revision = safeInteger(next.rows[0]?.revision ?? "", "下一个 Revision", 1);
            await client.query(
              `INSERT INTO admin_control_config_revisions(
                 object_kind,object_key,revision,configuration,configuration_digest,created_by
               ) VALUES('model_provider',$1,$2,$3::jsonb,$4,$5)`,
              [
                key,
                revision,
                JSON.stringify(storedConfiguration),
                configurationDigest,
                input.actorUserId,
              ],
            );
            await recordAudit(client, {
              actorUserId: input.actorUserId,
              kind: "model_provider",
              key,
              revision,
              action: "create_draft",
              reason,
              outcome: "succeeded",
            });
            const projected = await projectedRevision(client, "model_provider", key, revision);
            if (projected === undefined) throw new Error("草稿配置投影缺失");
            return {
              outcome: "applied",
              value: mapRevision<ModelProviderConfiguration>(projected),
            };
          }),
      );
    } catch (error) {
      throw mapPersistenceError(error, "创建模型 Provider 草稿");
    }
  }

  async resolveModelCredential(userId: string, providerKey: string, revision: number) {
    return await this.readAs(userId, async (client) => {
      const result = await client.query<{ readonly configuration: unknown }>(
        `SELECT configuration FROM admin_control_config_revisions
          WHERE object_kind='model_provider' AND object_key=$1 AND revision=$2`,
        [providerKey, revision],
      );
      const raw = result.rows[0]?.configuration;
      const credential =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>).credential
          : undefined;
      return isEncryptedModelProviderCredential(credential)
        ? this.credentialCipher.decrypt(providerKey, credential)
        : this.legacyModelApiKey;
    });
  }

  async createMemoryDraft(input: Parameters<AdminControlRepository["createMemoryDraft"]>[0]) {
    const { reason, ...configuration } = input.command;
    return await this.createDraft<MemoryProviderConfiguration>(
      input,
      "memory_provider",
      configuration,
      reason,
    );
  }

  async createRuntimeSettingsDraft(
    input: Parameters<AdminControlRepository["createRuntimeSettingsDraft"]>[0],
  ) {
    const { reason, ...configuration } = input.command;
    return await this.createDraft<RuntimeSettingsConfiguration>(
      input,
      "runtime_settings",
      configuration,
      reason,
      "global",
    );
  }

  async recordProbe(
    input: Parameters<AdminControlRepository["recordProbe"]>[0],
  ): ReturnType<AdminControlRepository["recordProbe"]> {
    try {
      return await withControlTransaction(
        this.pool,
        input.actorUserId,
        async (client) =>
          await idempotentMutation<
            | ControlRevision<ModelProviderConfiguration>
            | ControlRevision<MemoryProviderConfiguration>
          >(client, input, async () => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
              `${input.kind}:${input.objectKey}:${input.revision}:probe`,
            ]);
            const current = await projectedRevision(
              client,
              input.kind,
              input.objectKey,
              input.revision,
            );
            if (current === undefined) return { outcome: "not_found" };
            if (safeInteger(current.version_token, "版本令牌", 1) !== input.expectedVersionToken) {
              return { outcome: "conflict" };
            }
            const latestProbe = await client.query<{ readonly sequence: string }>(
              `SELECT COALESCE(max(sequence),0)::text AS sequence
               FROM admin_control_provider_probes
              WHERE object_kind=$1 AND object_key=$2 AND revision=$3`,
              [input.kind, input.objectKey, input.revision],
            );
            const sequence = safeInteger(latestProbe.rows[0]?.sequence ?? "", "探针 Sequence") + 1;
            await client.query(
              `INSERT INTO admin_control_provider_probes(
               object_kind,object_key,revision,sequence,status,reason,actor_user_id
             ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [
                input.kind,
                input.objectKey,
                input.revision,
                sequence,
                input.status,
                input.reason,
                input.actorUserId,
              ],
            );
            await recordAudit(client, {
              actorUserId: input.actorUserId,
              kind: input.kind,
              key: input.objectKey,
              revision: input.revision,
              action: "probe",
              reason: input.reason,
              outcome: input.status === "healthy" ? "succeeded" : "failed",
            });
            const projected = await projectedRevision(
              client,
              input.kind,
              input.objectKey,
              input.revision,
            );
            if (projected === undefined) throw new Error("探针结果投影缺失");
            return {
              outcome: "applied",
              value: mapRevision(projected) as
                | ControlRevision<ModelProviderConfiguration>
                | ControlRevision<MemoryProviderConfiguration>,
            };
          }),
      );
    } catch (error) {
      throw mapPersistenceError(error, "记录 Provider 探针");
    }
  }

  async publish(
    input: Parameters<AdminControlRepository["publish"]>[0],
  ): ReturnType<AdminControlRepository["publish"]> {
    try {
      return await withControlTransaction(
        this.pool,
        input.actorUserId,
        async (client) =>
          await idempotentMutation<
            | ControlRevision<ModelProviderConfiguration>
            | ControlRevision<MemoryProviderConfiguration>
            | ControlRevision<RuntimeSettingsConfiguration>
          >(client, input, async () => {
            const generationResult = await client.query<{ readonly generation: string }>(
              `SELECT generation::text FROM admin_control_generation
                WHERE singleton='global' FOR UPDATE`,
            );
            const current = await projectedRevision(
              client,
              input.kind,
              input.objectKey,
              input.revision,
            );
            if (current === undefined) return { outcome: "not_found" };
            if (safeInteger(current.version_token, "版本令牌", 1) !== input.expectedVersionToken) {
              return { outcome: "conflict" };
            }
            if (!(await publishPairIsCompatible(client, input.kind, current))) {
              return { outcome: "conflict" };
            }
            await activateConfiguration(
              client,
              input,
              safeInteger(generationResult.rows[0]?.generation ?? "", "控制面 Generation"),
            );
            const projected = await projectedRevision(
              client,
              input.kind,
              input.objectKey,
              input.revision,
            );
            if (projected === undefined) throw new Error("发布配置投影缺失");
            return {
              outcome: "applied",
              value: mapRevision(projected) as
                | ControlRevision<ModelProviderConfiguration>
                | ControlRevision<MemoryProviderConfiguration>
                | ControlRevision<RuntimeSettingsConfiguration>,
            };
          }),
      );
    } catch (error) {
      throw mapPersistenceError(error, "发布后台控制面配置");
    }
  }

  async listAudits(userId: string, limit: number): Promise<readonly ControlAuditEvent[]> {
    return await this.readAs(userId, async (client) => {
      const result = await client.query<{
        readonly audit_id: string;
        readonly actor_user_id: string;
        readonly object_kind: ControlAuditEvent["objectKind"];
        readonly object_key: string;
        readonly revision: string;
        readonly action: ControlAuditEvent["action"];
        readonly reason: string;
        readonly outcome: ControlAuditEvent["outcome"];
        readonly created_at: Date | string;
      }>(
        `SELECT audit_id,actor_user_id,object_kind,object_key,revision::text,
                action,reason,outcome,created_at
           FROM admin_control_audits ORDER BY created_at DESC,audit_id DESC LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        auditId: row.audit_id,
        actorUserId: row.actor_user_id,
        objectKind: row.object_kind,
        objectKey: row.object_key,
        revision: safeInteger(row.revision, "审计 Revision", 1),
        action: row.action,
        reason: row.reason,
        outcome: row.outcome,
        createdAt: timestamp(row.created_at),
      }));
    });
  }

  async listUsers(input: {
    readonly actorUserId: string;
    readonly query?: string;
    readonly limit: number;
  }): Promise<PlatformUserPage> {
    return await this.readAs(input.actorUserId, async (client) => {
      const parameters: (string | null)[] = [input.query ?? null];
      const where = `WHERE $1::text IS NULL
        OR strpos(lower(user_id),lower($1))>0
        OR strpos(lower(email),lower($1))>0
        OR strpos(lower(display_name),lower($1))>0`;
      const [total, users] = await Promise.all([
        client.query<{ readonly total: string }>(
          `SELECT count(*)::text AS total FROM admin_user_directory ${where}`,
          parameters,
        ),
        client.query<PlatformUserRow>(
          `SELECT user_id,email,display_name,status,created_at,last_active_at,
                  active_sessions::text,conversation_count::text,run_count::text
             FROM admin_user_directory ${where}
            ORDER BY status,last_active_at DESC NULLS LAST,created_at DESC,user_id
            LIMIT $2`,
          [input.query ?? null, input.limit],
        ),
      ]);
      return Object.freeze({
        items: Object.freeze(users.rows.map(mapPlatformUser)),
        total: safeInteger(total.rows[0]?.total ?? "", "用户总数"),
      });
    });
  }

  async updateUserStatus(
    input: Parameters<AdminControlRepository["updateUserStatus"]>[0],
  ): ReturnType<AdminControlRepository["updateUserStatus"]> {
    try {
      return await withControlTransaction(
        this.pool,
        input.actorUserId,
        async (client) =>
          await idempotentMutation(client, input, async () => {
            const current = await this.readPlatformUser(client, input.targetUserId);
            if (current === undefined) return { outcome: "not_found" };
            if (current.status === input.status) return { outcome: "applied", value: current };
            await client.query(
              "UPDATE user_accounts SET status=$2,updated_at=clock_timestamp() WHERE user_id=$1",
              [input.targetUserId, input.status],
            );
            if (input.status === "disabled") {
              await client.query("DELETE FROM user_sessions WHERE user_id=$1", [
                input.targetUserId,
              ]);
              await client.query(
                `DELETE FROM better_auth_sessions
                  WHERE user_id=(
                    SELECT better_auth_user_id FROM user_accounts WHERE user_id=$1
                  )`,
                [input.targetUserId],
              );
            }
            await client.query(
              `INSERT INTO admin_user_account_audits(
                 audit_id,actor_user_id,target_user_id,previous_status,status,reason
               ) VALUES($1,$2,$3,$4,$5,$6)`,
              [
                `user_audit_${randomUUID().replaceAll("-", "")}`,
                input.actorUserId,
                input.targetUserId,
                current.status,
                input.status,
                input.reason,
              ],
            );
            const updated = await this.readPlatformUser(client, input.targetUserId);
            if (updated === undefined) throw new Error("用户状态更新后投影缺失");
            return { outcome: "applied", value: updated };
          }),
        { isolationLevel: "SERIALIZABLE" },
      );
    } catch (error) {
      throw mapPersistenceError(error, "更新后台用户状态");
    }
  }

  async read(userId: string): Promise<RuntimeStatistics> {
    return await this.readAs(userId, async (client) => {
      const result = await client.query<StatisticsRow>("SELECT * FROM admin_runtime_statistics");
      const row = result.rows[0];
      if (row === undefined) throw new Error("运行统计投影缺失");
      const count = (value: string) => safeInteger(value, "运行统计");
      const uncachedInputTokens = count(row.model_input_tokens_24h);
      const cacheReadTokens = count(row.model_cache_read_tokens_24h);
      const inputTokens = safeInteger(
        String(uncachedInputTokens + cacheReadTokens),
        "模型总输入 Token",
      );
      const outputTokens = count(row.model_output_tokens_24h);
      const generationDurationMs = safeNonnegativeNumber(
        row.model_generation_duration_ms_24h,
        "模型生成时长",
      );
      return Object.freeze({
        generatedAt: timestamp(row.generated_at),
        users: Object.freeze({
          total: count(row.users_total),
          registered24h: count(row.users_registered_24h),
          active7d: count(row.users_active_7d),
          disabled: count(row.users_disabled),
        }),
        conversations: Object.freeze({
          total: count(row.conversations_total),
          created24h: count(row.conversations_created_24h),
          active24h: count(row.conversations_active_24h),
          archived: count(row.conversations_archived),
        }),
        runs: Object.freeze({
          total: count(row.runs_total),
          queued: count(row.runs_queued),
          running: count(row.runs_running),
          succeeded24h: count(row.runs_succeeded_24h),
          failed24h: count(row.runs_failed_24h),
          cancelled24h: count(row.runs_cancelled_24h),
        }),
        dispatch: Object.freeze({
          pending: count(row.dispatch_pending),
          claimed: count(row.dispatch_claimed),
        }),
        sandboxes: Object.freeze({
          active: count(row.sandboxes_active),
          paused: count(row.sandboxes_paused),
          cleanupPending: count(row.sandbox_cleanup_pending),
        }),
        memory: Object.freeze({
          pending: count(row.memory_pending),
          failed: count(row.memory_failed),
        }),
        automations: Object.freeze({
          active: count(row.automations_active),
          failedOccurrences24h: count(row.automation_failed_occurrences_24h),
        }),
        skills: Object.freeze({
          published: count(row.skills_published),
          installed: count(row.skills_installed),
        }),
        modelUsage24h: Object.freeze({
          inputTokens,
          outputTokens,
          outputTokensPerSecond:
            generationDurationMs > 0 ? outputTokens / (generationDurationMs / 1_000) : null,
          cacheHitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : null,
        }),
      });
    });
  }

  private async readAs<T>(
    userId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await withControlTransaction(this.pool, userId, operation, { readOnly: true });
    } catch (error) {
      throw mapPersistenceError(error, "读取后台控制面");
    }
  }

  private async readPlatformUser(
    client: PoolClient,
    targetUserId: string,
  ): Promise<PlatformUserSummary | undefined> {
    const result = await client.query<PlatformUserRow>(
      `SELECT user_id,email,display_name,status,created_at,last_active_at,
              active_sessions::text,conversation_count::text,run_count::text
         FROM admin_user_directory WHERE user_id=$1`,
      [targetUserId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : mapPlatformUser(row);
  }

  private async listRevisions<T extends Configuration>(
    userId: string,
    kind: ControlObjectKind,
  ): Promise<readonly ControlRevision<T>[]> {
    return await this.readAs(userId, async (client) => {
      const result = await client.query<RevisionRow>(
        `${revisionProjectionSql}
          WHERE revision.object_kind=$1
          ORDER BY revision.object_key,revision.revision DESC`,
        [kind],
      );
      return result.rows.map((row) => mapRevision<T>(row));
    });
  }

  private async createDraft<T extends Configuration>(
    context: ControlMutationContext,
    kind: ControlObjectKind,
    configuration: T,
    reason: string,
    forcedKey?: string,
  ): Promise<ControlMutationResult<ControlRevision<T>>> {
    const key = forcedKey ?? (configuration as ModelProviderConfiguration).providerKey;
    try {
      return await withControlTransaction(
        this.pool,
        context.actorUserId,
        async (client) =>
          await idempotentMutation(client, context, async () => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${kind}:${key}`]);
            const configurationDigest = digestControlRequest(configuration);
            const duplicate = await client.query(
              `SELECT 1 FROM admin_control_config_revisions
              WHERE object_kind=$1 AND object_key=$2 AND configuration_digest=$3`,
              [kind, key, configurationDigest],
            );
            if ((duplicate.rowCount ?? 0) > 0) return { outcome: "conflict" };
            const next = await client.query<{ readonly revision: string }>(
              `SELECT (COALESCE(max(revision),0)+1)::text AS revision
               FROM admin_control_config_revisions WHERE object_kind=$1 AND object_key=$2`,
              [kind, key],
            );
            const revision = safeInteger(next.rows[0]?.revision ?? "", "下一个 Revision", 1);
            await client.query(
              `INSERT INTO admin_control_config_revisions(
               object_kind,object_key,revision,configuration,configuration_digest,created_by
             ) VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
              [
                kind,
                key,
                revision,
                JSON.stringify(configuration),
                configurationDigest,
                context.actorUserId,
              ],
            );
            await recordAudit(client, {
              actorUserId: context.actorUserId,
              kind,
              key,
              revision,
              action: "create_draft",
              reason,
              outcome: "succeeded",
            });
            const projected = await projectedRevision(client, kind, key, revision);
            if (projected === undefined) throw new Error("草稿配置投影缺失");
            return { outcome: "applied", value: mapRevision<T>(projected) };
          }),
      );
    } catch (error) {
      throw mapPersistenceError(error, "创建后台控制面草稿");
    }
  }
}

async function activeConfiguration(
  client: PoolClient,
  kind: "model_provider" | "runtime_settings",
): Promise<Configuration | undefined> {
  const result = await client.query<{ readonly configuration: unknown }>(
    `SELECT revision.configuration
       FROM admin_control_active_configs active
       JOIN admin_control_config_revisions revision
         ON revision.object_kind=active.object_kind AND revision.object_key=active.object_key
        AND revision.revision=active.revision
      WHERE active.object_kind=$1`,
    [kind],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : mapConfiguration(kind, row.configuration);
}

async function publishPairIsCompatible(
  client: PoolClient,
  kind: ControlObjectKind,
  target: RevisionRow,
): Promise<boolean> {
  if (kind !== "runtime_settings") return true;
  const model = (await activeConfiguration(client, "model_provider")) as
    | ModelProviderConfiguration
    | undefined;
  const settings = mapConfiguration(kind, target.configuration) as RuntimeSettingsConfiguration;
  return (
    model === undefined ||
    settings === undefined ||
    settings.compactionMaxOutputTokens <= defaultModelConfiguration(model).maxTokens
  );
}

interface ActiveConfigurationRow extends QueryResultRow {
  readonly generation: string;
  readonly model_key: string;
  readonly model_revision: string;
  readonly model_configuration: unknown;
  readonly model_created_by: string;
  readonly model_created_at: Date | string;
  readonly memory_key: string | null;
  readonly memory_revision: string | null;
  readonly memory_configuration: unknown | null;
  readonly memory_created_by: string | null;
  readonly memory_created_at: Date | string | null;
  readonly settings_key: string | null;
  readonly settings_revision: string | null;
  readonly settings_configuration: unknown | null;
  readonly settings_created_by: string | null;
  readonly settings_created_at: Date | string | null;
}

const activeConfigurationSql = `
  SELECT generation.generation::text,
         model.object_key AS model_key,model.revision::text AS model_revision,
         model_revision.configuration AS model_configuration,
         model_revision.created_by AS model_created_by,model_revision.created_at AS model_created_at,
         memory.object_key AS memory_key,memory.revision::text AS memory_revision,
         memory_revision.configuration AS memory_configuration,
         memory_revision.created_by AS memory_created_by,memory_revision.created_at AS memory_created_at,
         NULL::text AS settings_key,NULL::text AS settings_revision,
         NULL::jsonb AS settings_configuration,
         NULL::text AS settings_created_by,NULL::timestamptz AS settings_created_at
    FROM admin_control_generation generation
    JOIN admin_control_active_configs model ON model.object_kind='model_provider'
    JOIN admin_control_config_revisions model_revision
      ON model_revision.object_kind=model.object_kind AND model_revision.object_key=model.object_key
     AND model_revision.revision=model.revision
    LEFT JOIN admin_control_active_configs memory ON memory.object_kind='memory_provider'
    LEFT JOIN admin_control_config_revisions memory_revision
      ON memory_revision.object_kind=memory.object_kind AND memory_revision.object_key=memory.object_key
     AND memory_revision.revision=memory.revision
   WHERE generation.singleton='global'`;

function snapshotRevision<T extends Configuration>(input: {
  readonly configuration: T;
  readonly revision: number;
  readonly createdBy: string;
  readonly createdAt: Date | string;
}): ControlRevision<T> {
  const createdAt = timestamp(input.createdAt);
  return Object.freeze({
    revision: input.revision,
    versionToken: 1,
    status: "active",
    configuration: input.configuration,
    probeStatus: "healthy",
    createdBy: input.createdBy,
    createdAt,
    updatedAt: createdAt,
  });
}

function mapRuntimeSnapshot(
  row: ActiveConfigurationRow,
  credentialCipher: ModelProviderCredentialCipher,
  legacyModelApiKey?: string,
): RuntimeControlConfigurationSnapshot {
  const modelConfiguration = mapConfiguration("model_provider", row.model_configuration);
  const memoryConfiguration =
    row.memory_configuration === null
      ? undefined
      : mapConfiguration("memory_provider", row.memory_configuration);
  const settingsConfiguration =
    row.settings_configuration === null
      ? undefined
      : mapConfiguration("runtime_settings", row.settings_configuration);
  const rawModel = row.model_configuration as Record<string, unknown>;
  const encryptedCredential = rawModel.credential;
  const modelApiKey = isEncryptedModelProviderCredential(encryptedCredential)
    ? credentialCipher.decrypt(row.model_key, encryptedCredential)
    : legacyModelApiKey;
  if (modelApiKey === undefined) throw new Error("MODEL_CREDENTIAL_UNAVAILABLE");
  return Object.freeze({
    generation: safeInteger(row.generation, "运行配置 Generation", 1),
    modelApiKey,
    model: snapshotRevision({
      configuration: modelConfiguration as ModelProviderConfiguration,
      revision: safeInteger(row.model_revision, "模型 Revision", 1),
      createdBy: row.model_created_by,
      createdAt: row.model_created_at,
    }),
    ...(memoryConfiguration === undefined ||
    row.memory_revision === null ||
    row.memory_created_by === null ||
    row.memory_created_at === null
      ? {}
      : {
          memory: snapshotRevision({
            configuration: memoryConfiguration as MemoryProviderConfiguration,
            revision: safeInteger(row.memory_revision, "记忆 Revision", 1),
            createdBy: row.memory_created_by,
            createdAt: row.memory_created_at,
          }),
        }),
    ...(settingsConfiguration === undefined ||
    row.settings_revision === null ||
    row.settings_created_by === null ||
    row.settings_created_at === null
      ? {}
      : {
          runtimeSettings: snapshotRevision({
            configuration: settingsConfiguration as RuntimeSettingsConfiguration,
            revision: safeInteger(row.settings_revision, "运行设置 Revision", 1),
            createdBy: row.settings_created_by,
            createdAt: row.settings_created_at,
          }),
        }),
  });
}

/** Runtime 只能读取已发布配置并为自己的 Tenant/Run 固定一次快照。 */
export class PgRuntimeControlConfigurationRepository implements RuntimeControlConfigurationPort {
  constructor(
    private readonly pool: Pool,
    private readonly credentialCipher: ModelProviderCredentialCipher,
    private readonly legacyModelApiKey?: string,
  ) {}

  async resolveActiveRuntimeSettings(): Promise<RuntimeSettingsConfiguration | undefined> {
    try {
      const result = await this.pool.query<{ readonly configuration: unknown }>(
        `SELECT revision.configuration
           FROM admin_control_active_configs active
           JOIN admin_control_config_revisions revision
             ON revision.object_kind=active.object_kind
            AND revision.object_key=active.object_key
            AND revision.revision=active.revision
          WHERE active.object_kind='runtime_settings' AND active.object_key='global'`,
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : (mapConfiguration("runtime_settings", row.configuration) as RuntimeSettingsConfiguration);
    } catch (error) {
      throw mapPersistenceError(error, "读取已发布运行设置");
    }
  }

  async resolveForRun(input: { readonly tenantId: string; readonly runId: string }) {
    try {
      return await withTenantTransaction(this.pool, input, async (client) => {
        const existing = await this.readSnapshot(client, input);
        if (existing !== undefined) return existing;
        const active = await client.query<ActiveConfigurationRow>(activeConfigurationSql);
        const row = active.rows[0];
        if (row === undefined) return undefined;
        await client.query(
          `INSERT INTO run_runtime_config_snapshots(
             tenant_id,run_id,generation,model_object_key,model_revision,
             memory_object_kind,memory_object_key,memory_revision,
             runtime_settings_object_kind,runtime_settings_object_key,runtime_settings_revision
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT(tenant_id,run_id) DO NOTHING`,
          [
            input.tenantId,
            input.runId,
            row.generation,
            row.model_key,
            row.model_revision,
            row.memory_key === null ? null : "memory_provider",
            row.memory_key,
            row.memory_revision,
            row.settings_key === null ? null : "runtime_settings",
            row.settings_key,
            row.settings_revision,
          ],
        );
        return (
          (await this.readSnapshot(client, input)) ??
          mapRuntimeSnapshot(row, this.credentialCipher, this.legacyModelApiKey)
        );
      });
    } catch (error) {
      throw mapPersistenceError(error, "解析 Run 固定运行配置");
    }
  }

  private async readSnapshot(
    client: PoolClient,
    input: { readonly tenantId: string; readonly runId: string },
  ): Promise<RuntimeControlConfigurationSnapshot | undefined> {
    const result = await client.query<ActiveConfigurationRow>(
      `SELECT snapshot.generation::text,
              snapshot.model_object_key AS model_key,snapshot.model_revision::text AS model_revision,
              model.configuration AS model_configuration,model.created_by AS model_created_by,
              model.created_at AS model_created_at,
              snapshot.memory_object_key AS memory_key,snapshot.memory_revision::text AS memory_revision,
              memory.configuration AS memory_configuration,memory.created_by AS memory_created_by,
              memory.created_at AS memory_created_at,
              snapshot.runtime_settings_object_key AS settings_key,
              snapshot.runtime_settings_revision::text AS settings_revision,
              settings.configuration AS settings_configuration,settings.created_by AS settings_created_by,
              settings.created_at AS settings_created_at
         FROM run_runtime_config_snapshots snapshot
         JOIN admin_control_config_revisions model
           ON model.object_kind='model_provider' AND model.object_key=snapshot.model_object_key
          AND model.revision=snapshot.model_revision
         LEFT JOIN admin_control_config_revisions memory
           ON memory.object_kind='memory_provider' AND memory.object_key=snapshot.memory_object_key
          AND memory.revision=snapshot.memory_revision
         LEFT JOIN admin_control_config_revisions settings
           ON settings.object_kind='runtime_settings'
          AND settings.object_key=snapshot.runtime_settings_object_key
          AND settings.revision=snapshot.runtime_settings_revision
        WHERE snapshot.tenant_id=$1 AND snapshot.run_id=$2`,
      [input.tenantId, input.runId],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : mapRuntimeSnapshot(row, this.credentialCipher, this.legacyModelApiKey);
  }
}
