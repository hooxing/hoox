import { createHash } from "node:crypto";
import {
  agentBuiltinToolLimit,
  agentDefinitionAccess,
  type ControlOperatorRole,
} from "@hoox/admin-control";
import {
  DomainError,
  tenantId,
  validateAgentRevisionContent,
  type AgentAvailability,
  type AgentRevisionContent,
} from "@hoox/domain";
import type { QueryResultRow } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import type {
  AgentDefinitionAdminRepositoryPort,
  AgentDefinitionRepositoryPort,
  SetAgentAvailabilityInput,
  StoredAgentDefinition,
  StoredAgentRevision,
  StoredAgentRevisionSummary,
} from "./agent-definition-port.js";
import { mapSavedModelProviderConfiguration } from "./pg-admin-control.js";
import type { Pool, PoolClient } from "./postgres.js";
import { withTenantTransaction, withTransaction } from "./postgres.js";

interface DefinitionRow extends QueryResultRow {
  id: string;
  status: StoredAgentDefinition["status"];
  generation: string;
  availability_mode: "all_tenants" | "selected_tenants";
  current_revision_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
interface RevisionRow extends QueryResultRow {
  id: string;
  definition_id: string;
  revision: string;
  status: StoredAgentRevision["status"];
  content: AgentRevisionContent;
  content_digest: string;
  created_by: string;
  created_at: Date | string;
}
function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function mapDefinition(
  row: DefinitionRow,
  tenantIds: readonly string[] = [],
): StoredAgentDefinition {
  const availability: AgentAvailability =
    row.availability_mode === "all_tenants"
      ? { mode: "all_tenants" }
      : { mode: "selected_tenants", tenantIds: Object.freeze(tenantIds.map(tenantId)) };
  return Object.freeze({
    id: row.id,
    status: row.status,
    generation: Number(row.generation),
    availability,
    ...(row.current_revision_id === null ? {} : { currentRevisionId: row.current_revision_id }),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}
function mapRevision(row: RevisionRow, revoked: boolean): StoredAgentRevision {
  if (digest(row.content) !== row.content_digest) throw new TypeError("AgentRevision 摘要不匹配");
  const { longTermMemoryEnabled, ...contentWithMemory } = row.content as AgentRevisionContent & {
    readonly longTermMemoryEnabled?: boolean;
  };
  // 初始种子只在读取时投影为当前协议，历史正文与摘要保持不变。
  const content = validateAgentRevisionContent(
    row.id === "agent_default_revision_1" && typeof longTermMemoryEnabled === "boolean"
      ? {
          ...contentWithMemory,
          memory: { mode: "configured", longTermEnabled: longTermMemoryEnabled },
        }
      : row.content,
  );
  return Object.freeze({
    id: row.id,
    definitionId: row.definition_id,
    revision: Number(row.revision),
    status: revoked ? "revoked" : row.status,
    content,
    digest: row.content_digest,
    createdAt: timestamp(row.created_at),
    createdBy: row.created_by,
  });
}
export class AgentDefinitionAccessError extends PersistenceError {
  constructor() {
    super("CONSTRAINT_VIOLATION", "Agent 管理权限不足");
  }
}

export class AgentDefinitionValidationError extends PersistenceError {
  constructor(message: string) {
    super("CONSTRAINT_VIOLATION", message);
  }
}

async function resolveAgentAccess(client: PoolClient, actorUserId: string) {
  await client.query("SELECT set_config('app.user_id',$1,true)", [actorUserId]);
  const result = await client.query<{ role: ControlOperatorRole }>(
    "SELECT role FROM platform_control_operators WHERE user_id=$1 AND status='active'",
    [actorUserId],
  );
  const access = agentDefinitionAccess(result.rows[0]?.role);
  if (!access) throw new AgentDefinitionAccessError();
  return access;
}

async function admin<T>(
  pool: Pool,
  actorUserId: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    if (!(await resolveAgentAccess(client, actorUserId)).canManage) {
      throw new AgentDefinitionAccessError();
    }
    return action(client);
  });
}

async function adminRead<T>(
  pool: Pool,
  actorUserId: string,
  action: (client: PoolClient, canManage: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await withTransaction(
      pool,
      async (client) => {
        const { canManage } = await resolveAgentAccess(client, actorUserId);
        return action(client, canManage);
      },
      { readOnly: true, isolationLevel: "REPEATABLE READ" },
    );
  } catch (error) {
    throw mapPersistenceError(error, "读取 Agent 管理数据");
  }
}

async function builtinToolLimit(client: PoolClient) {
  const result = await client.query<{ configuration: { enabledTools?: unknown } }>(`
    SELECT c.configuration
    FROM admin_control_active_configs a
    JOIN admin_control_config_revisions c USING (object_kind,object_key,revision)
    WHERE a.object_kind='runtime_settings' AND a.object_key='global'
  `);
  return agentBuiltinToolLimit(result.rows[0]?.configuration.enabledTools);
}

type PinnedModel = Extract<AgentRevisionContent["model"], { mode: "pinned" }>;

function selectableModels(
  objectKey: string,
  revision: string,
  configuration: unknown,
): PinnedModel[] {
  const provider = mapSavedModelProviderConfiguration(configuration);
  const providerRevision = Number(revision);
  if (
    !provider.credentialConfigured ||
    provider.providerKey !== objectKey ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(objectKey) ||
    !Number.isSafeInteger(providerRevision) ||
    providerRevision < 1
  )
    return [];
  return provider.models.flatMap((model) =>
    model.enabled && Buffer.byteLength(model.id, "utf8") <= 200
      ? [{ mode: "pinned", providerKey: objectKey, providerRevision, modelId: model.id }]
      : [],
  );
}

async function listPinnedModelOptions(client: PoolClient): Promise<PinnedModel[]> {
  const result = await client.query<{
    object_key: string;
    revision: string;
    configuration: unknown;
  }>(
    `SELECT object_key,revision::text,configuration FROM admin_control_config_revisions
      WHERE object_kind='model_provider' ORDER BY object_key,admin_control_config_revisions.revision DESC`,
  );
  return result.rows.flatMap((row) =>
    selectableModels(row.object_key, row.revision, row.configuration),
  );
}

async function validateDraft(client: PoolClient, value: AgentRevisionContent) {
  let content: AgentRevisionContent;
  try {
    content = validateAgentRevisionContent(value);
  } catch (error) {
    if (error instanceof DomainError) throw new AgentDefinitionValidationError(error.message);
    throw error;
  }
  if (content.model.mode === "pinned") {
    const { providerKey, providerRevision, modelId } = content.model;
    const result = await client.query<{ configuration: unknown }>(
      `SELECT configuration FROM admin_control_config_revisions
        WHERE object_kind='model_provider' AND object_key=$1 AND revision=$2`,
      [providerKey, providerRevision],
    );
    const row = result.rows[0];
    if (
      !row ||
      !selectableModels(providerKey, String(providerRevision), row.configuration).some(
        (model) => model.modelId === modelId,
      )
    )
      throw new AgentDefinitionValidationError("请选择已保存、已启用且绑定托管凭据的模型");
  }
  if (content.tools.mode === "configured") {
    // 平台运行设置使用同一行的排他锁激活，避免校验通过后按过期名单提交。
    await client.query(
      "SELECT generation FROM admin_control_generation WHERE singleton='global' FOR SHARE",
    );
    const allowed = await builtinToolLimit(client);
    const requested = content.tools.builtinTools;
    if (
      new Set(requested).size !== requested.length ||
      requested.some((name) => !allowed.includes(name))
    ) {
      throw new AgentDefinitionValidationError(
        "内置工具只能选择平台运行设置中启用的工具，且不得重复",
      );
    }
  }
  return content;
}

function availabilityIds(availability: AgentAvailability) {
  if (availability.mode === "all_tenants") return [];
  const ids = availability.tenantIds;
  if (ids.length < 1 || ids.length > 1000 || new Set(ids).size !== ids.length) {
    throw new AgentDefinitionValidationError("请提供 1 至 1000 个不重复的 Tenant ID");
  }
  return [...ids].sort();
}

async function insertScopes(
  client: PoolClient,
  id: string,
  ids: readonly string[],
  available: boolean,
) {
  if (ids.length === 0) return;
  await client.query(
    `INSERT INTO agent_definition_tenants(definition_id,tenant_id,available)
     SELECT $1,tenant_id,$3 FROM unnest($2::text[]) AS tenant_id`,
    [id, ids, available],
  );
}
async function lockIdempotency(
  client: PoolClient,
  key: string,
  request: unknown,
): Promise<unknown | undefined> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [
    `agent-definition:${key}`,
  ]);
  const found = await client.query<{ request_digest: string; response: unknown }>(
    "SELECT request_digest,response FROM agent_definition_commands WHERE idempotency_key=$1",
    [key],
  );
  const prior = found.rows[0];
  if (prior === undefined) return undefined;
  if (prior.request_digest !== digest(request))
    throw new PersistenceError("CONFLICT", "Agent 幂等键已用于不同请求");
  return prior.response;
}
async function recordCommand(
  client: PoolClient,
  key: string,
  request: unknown,
  response: unknown,
): Promise<void> {
  await client.query(
    "INSERT INTO agent_definition_commands(idempotency_key,request_digest,response) VALUES($1,$2,$3)",
    [key, digest(request), JSON.stringify(response)],
  );
}
async function readDefinition(
  client: PoolClient,
  id: string,
  lock = false,
): Promise<DefinitionRow | undefined> {
  const row = await client.query<DefinitionRow>(
    `SELECT id,status,generation::text,availability_mode,current_revision_id,created_at,updated_at FROM agent_definitions WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return row.rows[0];
}
async function scopeIds(
  client: PoolClient,
  id: string,
  includeInactive = false,
): Promise<string[]> {
  const result = await client.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM agent_definition_tenants WHERE definition_id=$1 AND ($2 OR available) ORDER BY tenant_id",
    [id, includeInactive],
  );
  return result.rows.map((row) => row.tenant_id);
}
async function readRevision(client: PoolClient, id: string): Promise<RevisionRow | undefined> {
  const result = await client.query<RevisionRow>(
    "SELECT id,definition_id,revision::text,status,content,content_digest,created_by,created_at FROM agent_revisions WHERE id=$1",
    [id],
  );
  return result.rows[0];
}
async function revocationExists(client: PoolClient, id: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM agent_revision_revocations WHERE revision_id=$1",
    [id],
  );
  return result.rowCount === 1;
}
interface RevisionSummaryRow extends Omit<RevisionRow, "content"> {
  display_name: string;
  revoked: boolean;
}
const revisionSummaryColumns = `r.id,r.definition_id,r.revision::text,r.status,r.content_digest,
  r.created_by,r.created_at,r.content->>'displayName' AS display_name,
  EXISTS(SELECT 1 FROM agent_revision_revocations v WHERE v.revision_id=r.id) AS revoked`;

function mapRevisionSummary(row: RevisionSummaryRow): StoredAgentRevisionSummary {
  return {
    id: row.id,
    definitionId: row.definition_id,
    revision: Number(row.revision),
    status: row.revoked ? "revoked" : row.status,
    displayName: row.display_name,
    digest: row.content_digest,
    createdBy: row.created_by,
    createdAt: timestamp(row.created_at),
  };
}

export class PgAgentDefinitionRepository
  implements AgentDefinitionRepositoryPort, AgentDefinitionAdminRepositoryPort
{
  constructor(private readonly pool: Pool) {}

  async listDefinitions(actorUserId: string) {
    return adminRead(this.pool, actorUserId, async (client, canManage) => {
      const result = await client.query<
        DefinitionRow & { tenant_ids: string[]; summary: RevisionSummaryRow | null }
      >(
        `SELECT d.id,d.status,d.generation::text,d.availability_mode,d.current_revision_id,
           d.created_at,d.updated_at,
           ARRAY(SELECT tenant_id FROM agent_definition_tenants s WHERE s.definition_id=d.id ORDER BY tenant_id) AS tenant_ids,
           row_to_json(summary) AS summary
         FROM agent_definitions d
         LEFT JOIN LATERAL (
           SELECT ${revisionSummaryColumns} FROM agent_revisions r WHERE r.definition_id=d.id
             AND ($1 OR r.status IN ('published','revoked'))
             AND (r.id=d.current_revision_id OR d.current_revision_id IS NULL)
           ORDER BY r.revision DESC LIMIT 1
         ) summary ON true
         WHERE $1 OR d.status<>'draft'
         ORDER BY d.is_builtin DESC,d.id`,
        [canManage],
      );
      return {
        canManage,
        builtinToolLimit: canManage ? await builtinToolLimit(client) : [],
        pinnedModelOptions: canManage ? await listPinnedModelOptions(client) : [],
        items: result.rows.map((row) => ({
          definition: mapDefinition(row, row.tenant_ids),
          ...(row.summary === null ? {} : { revision: mapRevisionSummary(row.summary) }),
        })),
      };
    });
  }

  async listRevisions(actorUserId: string, definitionId: string) {
    return adminRead(this.pool, actorUserId, async (client, canManage) => {
      const row = await readDefinition(client, definitionId);
      if (!row || (!canManage && row.status === "draft")) return undefined;
      const revisions = await client.query<RevisionSummaryRow>(
        `SELECT ${revisionSummaryColumns} FROM agent_revisions r WHERE r.definition_id=$1
           AND ($2 OR r.status IN ('published','revoked')) ORDER BY r.revision DESC`,
        [definitionId, canManage],
      );
      return {
        definition: mapDefinition(row, await scopeIds(client, definitionId, true)),
        items: revisions.rows.map(mapRevisionSummary),
      };
    });
  }

  async readAdminRevision(actorUserId: string, definitionId: string, revisionId: string) {
    return adminRead(this.pool, actorUserId, async (client, canManage) => {
      const row = await readRevision(client, revisionId);
      if (!row || row.definition_id !== definitionId || (!canManage && row.status === "draft")) {
        return undefined;
      }
      return mapRevision(row, await revocationExists(client, row.id));
    });
  }

  async createDraft(input: {
    actorUserId: string;
    id: string;
    availability: AgentAvailability;
    content: AgentRevisionContent;
    revisionId: string;
    idempotencyKey: string;
    expectedGeneration: number;
  }): Promise<{ definition: StoredAgentDefinition; revision: StoredAgentRevision }> {
    try {
      return await admin(this.pool, input.actorUserId, async (client) => {
        const request = { ...input };
        const replay = await lockIdempotency(client, input.idempotencyKey, request);
        if (replay !== undefined)
          return replay as { definition: StoredAgentDefinition; revision: StoredAgentRevision };
        if (input.expectedGeneration !== 0)
          throw new PersistenceError("CONFLICT", "Agent generation 已变化");
        const normalizedContent = await validateDraft(client, input.content);
        const digestValue = digest(normalizedContent);
        const ids = availabilityIds(input.availability);
        await client.query(
          "INSERT INTO agent_definitions(id,status,generation,availability_mode) VALUES($1,'draft',0,$2)",
          [input.id, input.availability.mode],
        );
        await insertScopes(client, input.id, ids, false);
        await client.query(
          "INSERT INTO agent_revisions(id,definition_id,revision,status,content,content_digest,created_by) VALUES($1,$2,1,'draft',$3,$4,$5)",
          [
            input.revisionId,
            input.id,
            JSON.stringify(normalizedContent),
            digestValue,
            input.actorUserId,
          ],
        );
        const row = await readDefinition(client, input.id);
        const revision = await readRevision(client, input.revisionId);
        if (!row || !revision) throw new TypeError("Agent 草稿写入后缺少记录");
        const result = {
          definition: mapDefinition(row, ids),
          revision: mapRevision(revision, false),
        };
        await client.query(
          "INSERT INTO agent_definition_audits(actor_user_id,definition_id,revision_id,action,generation,reason) VALUES($1,$2,$3,'created',0,'创建 Agent 草稿')",
          [input.actorUserId, input.id, input.revisionId],
        );
        await recordCommand(client, input.idempotencyKey, request, result);
        return result;
      });
    } catch (error) {
      throw mapPersistenceError(error, "创建 Agent 草稿");
    }
  }

  async createDraftRevision(input: {
    actorUserId: string;
    definitionId: string;
    revisionId: string;
    content: AgentRevisionContent;
    idempotencyKey: string;
    expectedGeneration: number;
  }): Promise<StoredAgentRevision> {
    try {
      return await admin(this.pool, input.actorUserId, async (client) => {
        const request = { ...input };
        const replay = await lockIdempotency(client, input.idempotencyKey, request);
        if (replay !== undefined) return replay as StoredAgentRevision;
        const definition = await readDefinition(client, input.definitionId, true);
        if (
          !definition ||
          Number(definition.generation) !== input.expectedGeneration ||
          definition.status === "revoked"
        ) {
          throw new PersistenceError("CONFLICT", "Agent generation 或状态已变化");
        }
        const content = await validateDraft(client, input.content);
        const latest = await client.query<{ next_revision: string }>(
          "SELECT (COALESCE(max(revision),0)+1)::text AS next_revision FROM agent_revisions WHERE definition_id=$1",
          [input.definitionId],
        );
        const revisionNumber = Number(latest.rows[0]?.next_revision);
        await client.query(
          "INSERT INTO agent_revisions(id,definition_id,revision,status,content,content_digest,created_by) VALUES($1,$2,$3,'draft',$4,$5,$6)",
          [
            input.revisionId,
            input.definitionId,
            revisionNumber,
            JSON.stringify(content),
            digest(content),
            input.actorUserId,
          ],
        );
        await client.query(
          "UPDATE agent_definitions SET generation=generation+1,updated_at=clock_timestamp() WHERE id=$1",
          [input.definitionId],
        );
        const revision = await readRevision(client, input.revisionId);
        const next = await readDefinition(client, input.definitionId);
        if (!revision || !next) throw new TypeError("Agent 草稿 Revision 写入后缺少记录");
        const result = mapRevision(revision, false);
        await client.query(
          "INSERT INTO agent_definition_audits(actor_user_id,definition_id,revision_id,action,generation,reason) VALUES($1,$2,$3,'created',$4,'创建 Agent 草稿 Revision')",
          [input.actorUserId, input.definitionId, input.revisionId, next.generation],
        );
        await recordCommand(client, input.idempotencyKey, request, result);
        return result;
      });
    } catch (error) {
      throw mapPersistenceError(error, "创建 Agent 草稿 Revision");
    }
  }

  async publish(input: {
    actorUserId: string;
    definitionId: string;
    revisionId: string;
    idempotencyKey: string;
    expectedGeneration: number;
  }): Promise<StoredAgentDefinition> {
    try {
      return await admin(this.pool, input.actorUserId, async (client) => {
        const request = { ...input };
        const replay = await lockIdempotency(client, input.idempotencyKey, request);
        if (replay !== undefined) return replay as StoredAgentDefinition;
        const definition = await readDefinition(client, input.definitionId, true);
        if (!definition || Number(definition.generation) !== input.expectedGeneration)
          throw new PersistenceError("CONFLICT", "Agent generation 已变化");
        if (!["draft", "published", "disabled"].includes(definition.status))
          throw new PersistenceError("CONSTRAINT_VIOLATION", "Agent 当前状态不能发布");
        const revision = await readRevision(client, input.revisionId);
        if (
          !revision ||
          revision.definition_id !== input.definitionId ||
          revision.status !== "draft"
        )
          throw new PersistenceError("CONSTRAINT_VIOLATION", "Agent 草稿 Revision 不存在");
        await validateDraft(client, revision.content);
        await client.query(
          "UPDATE agent_definition_tenants SET available=true WHERE definition_id=$1",
          [input.definitionId],
        );
        await client.query(
          "UPDATE agent_definitions SET status='published',generation=generation+1,current_revision_id=$2,updated_at=clock_timestamp() WHERE id=$1",
          [input.definitionId, input.revisionId],
        );
        await client.query("UPDATE agent_revisions SET status='published' WHERE id=$1", [
          input.revisionId,
        ]);
        const row = await readDefinition(client, input.definitionId);
        if (!row) throw new TypeError("Agent 发布后记录缺失");
        const result = mapDefinition(row, await scopeIds(client, row.id, true));
        await client.query(
          "INSERT INTO agent_definition_audits(actor_user_id,definition_id,revision_id,action,generation,reason) VALUES($1,$2,$3,'published',$4,'发布 Agent Revision')",
          [input.actorUserId, input.definitionId, input.revisionId, row.generation],
        );
        await recordCommand(client, input.idempotencyKey, request, result);
        return result;
      });
    } catch (error) {
      throw mapPersistenceError(error, "发布 Agent Revision");
    }
  }

  async setAvailability(input: SetAgentAvailabilityInput): Promise<StoredAgentDefinition> {
    try {
      return await admin(this.pool, input.actorUserId, async (client) => {
        const request = { action: "availability_changed", ...input };
        const replay = await lockIdempotency(client, input.idempotencyKey, request);
        if (replay !== undefined) return replay as StoredAgentDefinition;
        const def = await readDefinition(client, input.definitionId, true);
        if (!def || Number(def.generation) !== input.expectedGeneration)
          throw new PersistenceError("CONFLICT", "Agent generation 已变化");
        const ids = availabilityIds(input.availability);
        await client.query("DELETE FROM agent_definition_tenants WHERE definition_id=$1", [
          input.definitionId,
        ]);
        await insertScopes(client, input.definitionId, ids, def.status === "published");
        await client.query(
          "UPDATE agent_definitions SET availability_mode=$2,generation=generation+1,updated_at=clock_timestamp() WHERE id=$1",
          [input.definitionId, input.availability.mode],
        );
        const row = await readDefinition(client, input.definitionId);
        if (!row) throw new TypeError("Agent 可用范围更新后记录缺失");
        const result = mapDefinition(row, ids);
        await client.query(
          "INSERT INTO agent_definition_audits(actor_user_id,definition_id,action,generation,reason) VALUES($1,$2,'availability_changed',$3,$4)",
          [input.actorUserId, input.definitionId, row.generation, "设置 Agent 可用范围"],
        );
        await recordCommand(client, input.idempotencyKey, request, result);
        return result;
      });
    } catch (error) {
      throw mapPersistenceError(error, "设置 Agent 可用范围");
    }
  }

  async deactivate(input: {
    actorUserId: string;
    definitionId: string;
    idempotencyKey: string;
    expectedGeneration: number;
  }): Promise<StoredAgentDefinition> {
    return this.changeDefinition(input, "disabled", "disabled", "停用 Agent");
  }
  async revoke(input: {
    actorUserId: string;
    definitionId: string;
    revisionId: string;
    reason: string;
    idempotencyKey: string;
    expectedGeneration: number;
  }): Promise<StoredAgentDefinition> {
    try {
      return await admin(this.pool, input.actorUserId, async (client) => {
        const request = { ...input };
        const replay = await lockIdempotency(client, input.idempotencyKey, request);
        if (replay !== undefined) return replay as StoredAgentDefinition;
        const def = await readDefinition(client, input.definitionId, true);
        if (!def || Number(def.generation) !== input.expectedGeneration)
          throw new PersistenceError("CONFLICT", "Agent generation 已变化");
        const revision = await readRevision(client, input.revisionId);
        if (
          !revision ||
          revision.definition_id !== input.definitionId ||
          revision.status !== "published"
        )
          throw new PersistenceError("CONSTRAINT_VIOLATION", "已发布 Revision 不存在");
        await client.query("INSERT INTO agent_revision_revocations(revision_id) VALUES($1)", [
          input.revisionId,
        ]);
        const nextStatus = def.current_revision_id === input.revisionId ? "revoked" : def.status;
        if (def.current_revision_id === input.revisionId)
          await client.query(
            "UPDATE agent_definition_tenants SET available=false WHERE definition_id=$1",
            [input.definitionId],
          );
        await client.query(
          "UPDATE agent_definitions SET status=$2,generation=generation+1,updated_at=clock_timestamp() WHERE id=$1",
          [input.definitionId, nextStatus],
        );
        const row = await readDefinition(client, input.definitionId);
        if (!row) throw new TypeError("Agent 撤销后记录缺失");
        const result = mapDefinition(row, await scopeIds(client, row.id, true));
        await client.query(
          "INSERT INTO agent_definition_audits(actor_user_id,definition_id,revision_id,action,generation,reason) VALUES($1,$2,$3,'revoked',$4,$5)",
          [input.actorUserId, input.definitionId, input.revisionId, row.generation, input.reason],
        );
        await recordCommand(client, input.idempotencyKey, request, result);
        return result;
      });
    } catch (error) {
      throw mapPersistenceError(error, "撤销 Agent Revision");
    }
  }
  private async changeDefinition(
    input: {
      actorUserId: string;
      definitionId: string;
      idempotencyKey: string;
      expectedGeneration: number;
    },
    status: "disabled",
    action: "disabled",
    reason: string,
  ): Promise<StoredAgentDefinition> {
    try {
      return await admin(this.pool, input.actorUserId, async (client) => {
        const request = { ...input };
        const replay = await lockIdempotency(client, input.idempotencyKey, request);
        if (replay !== undefined) return replay as StoredAgentDefinition;
        const def = await readDefinition(client, input.definitionId, true);
        if (!def || Number(def.generation) !== input.expectedGeneration)
          throw new PersistenceError("CONFLICT", "Agent generation 已变化");
        if (def.status !== "published")
          throw new PersistenceError("CONSTRAINT_VIOLATION", "只有已发布 AgentDefinition 可以停用");
        // 默认 Agent 也可被停用；不可删除由管理连接不持有 DELETE ACL 保证。
        await client.query(
          "UPDATE agent_definition_tenants SET available=false WHERE definition_id=$1",
          [input.definitionId],
        );
        await client.query(
          "UPDATE agent_definitions SET status=$2,generation=generation+1,updated_at=clock_timestamp() WHERE id=$1",
          [input.definitionId, status],
        );
        const row = await readDefinition(client, input.definitionId);
        if (!row) throw new TypeError("Agent 状态变更后记录缺失");
        const result = mapDefinition(row, await scopeIds(client, row.id, true));
        await client.query(
          "INSERT INTO agent_definition_audits(actor_user_id,definition_id,action,generation,reason) VALUES($1,$2,$3,$4,$5)",
          [input.actorUserId, input.definitionId, action, row.generation, reason],
        );
        await recordCommand(client, input.idempotencyKey, request, result);
        return result;
      });
    } catch (error) {
      throw mapPersistenceError(error, "变更 Agent 状态");
    }
  }

  async readVisibleCurrent(
    tenantId: string,
    definitionId: string,
  ): Promise<
    | { readonly definition: StoredAgentDefinition; readonly revision?: StoredAgentRevision }
    | undefined
  > {
    return withTenantTransaction(
      this.pool,
      { tenantId },
      async (client) => {
        const result = await client.query<DefinitionRow>(
          `SELECT id,status,generation::text,availability_mode,current_revision_id,created_at,updated_at
             FROM agent_definitions WHERE id=$1`,
          [definitionId],
        );
        const row = result.rows[0];
        if (row === undefined) return undefined;
        if (row.current_revision_id === null) return { definition: mapDefinition(row) };
        const revision = await readRevision(client, row.current_revision_id);
        if (revision === undefined || (await revocationExists(client, revision.id))) {
          return { definition: mapDefinition(row) };
        }
        try {
          return {
            definition: mapDefinition(row),
            revision: mapRevision(revision, false),
          };
        } catch {
          return { definition: mapDefinition(row) };
        }
      },
      { readOnly: true },
    );
  }
  async listAvailable(
    tenantId: string,
  ): Promise<readonly { definition: StoredAgentDefinition; revision: StoredAgentRevision }[]> {
    return withTenantTransaction(
      this.pool,
      { tenantId },
      async (client) => {
        const result = await client.query<DefinitionRow>(
          `SELECT d.id,d.status,d.generation::text,d.availability_mode,d.current_revision_id,d.created_at,d.updated_at FROM agent_definitions d WHERE d.status='published' AND (d.availability_mode='all_tenants' OR EXISTS(SELECT 1 FROM agent_definition_tenants s WHERE s.definition_id=d.id AND s.tenant_id=$1 AND s.available)) ORDER BY d.id`,
          [tenantId],
        );
        const values = [];
        for (const row of result.rows) {
          if (!row.current_revision_id) continue;
          const rev = await readRevision(client, row.current_revision_id);
          if (!rev || (await revocationExists(client, rev.id))) continue;
          values.push(
            Object.freeze({
              definition: mapDefinition(row, await scopeIds(client, row.id)),
              revision: mapRevision(rev, false),
            }),
          );
        }
        return Object.freeze(values);
      },
      { readOnly: true },
    );
  }
  async readCurrentPublished(
    tenantId: string,
    definitionId: string,
  ): Promise<StoredAgentRevision | undefined> {
    return withTenantTransaction(
      this.pool,
      { tenantId },
      async (client) => {
        const row = await client.query<{ current_revision_id: string | null }>(
          "SELECT current_revision_id FROM agent_definitions WHERE id=$1 AND status='published'",
          [definitionId],
        );
        const id = row.rows[0]?.current_revision_id;
        if (!id) return undefined;
        const rev = await readRevision(client, id);
        return rev && !(await revocationExists(client, id)) ? mapRevision(rev, false) : undefined;
      },
      { readOnly: true },
    );
  }
  /** A3 按固定 Revision ID 读取完整不可变内容；撤销事实独立检查并失败关闭。 */
  async readRevisionById(
    tenantId: string,
    revisionId: string,
  ): Promise<StoredAgentRevision | undefined> {
    return withTenantTransaction(
      this.pool,
      { tenantId },
      async (client) => {
        const rev = await readRevision(client, revisionId);
        if (!rev) return undefined;
        const allowed = await client.query(
          "SELECT 1 FROM agent_definitions d WHERE d.id=$1 AND (d.availability_mode='all_tenants' OR EXISTS(SELECT 1 FROM agent_definition_tenants s WHERE s.definition_id=d.id AND s.tenant_id=$2 AND s.available))",
          [rev.definition_id, tenantId],
        );
        if (allowed.rowCount !== 1) return undefined;
        if (await revocationExists(client, revisionId))
          throw new PersistenceError("CONSTRAINT_VIOLATION", "Agent Revision 已撤销");
        return mapRevision(rev, false);
      },
      { readOnly: true },
    );
  }
}
