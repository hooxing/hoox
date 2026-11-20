import { createHash } from "node:crypto";
import {
  tenantId,
  validateAgentRevisionContent,
  type AgentAvailability,
  type AgentRevisionContent,
} from "@hoox/domain";
import type { QueryResultRow } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import type {
  AgentDefinitionRepositoryPort,
  StoredAgentDefinition,
  StoredAgentRevision,
} from "./agent-definition-port.js";
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
  const content = validateAgentRevisionContent(row.content);
  if (digest(content) !== row.content_digest) throw new TypeError("AgentRevision 摘要不匹配");
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
async function admin<T>(
  pool: Pool,
  actorUserId: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [actorUserId]);
    const operator = await client.query(
      "SELECT 1 FROM platform_control_operators WHERE user_id=$1 AND status='active' AND role IN ('operator','admin')",
      [actorUserId],
    );
    if (operator.rowCount !== 1)
      throw new PersistenceError("CONSTRAINT_VIOLATION", "Agent 管理权限不足");
    return action(client);
  });
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
async function scopeIds(client: PoolClient, id: string): Promise<string[]> {
  const result = await client.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM agent_definition_tenants WHERE definition_id=$1 AND available ORDER BY tenant_id",
    [id],
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
export class PgAgentDefinitionRepository implements AgentDefinitionRepositoryPort {
  constructor(private readonly pool: Pool) {}

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
        const normalizedContent = validateAgentRevisionContent(input.content);
        const digestValue = digest(normalizedContent);
        const ids =
          input.availability.mode === "selected_tenants" ? input.availability.tenantIds : [];
        await client.query(
          "INSERT INTO agent_definitions(id,status,generation,availability_mode) VALUES($1,'draft',0,$2)",
          [input.id, input.availability.mode],
        );
        for (const tenantId of ids)
          await client.query(
            "INSERT INTO agent_definition_tenants(definition_id,tenant_id) VALUES($1,$2)",
            [input.id, tenantId],
          );
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
          !["published", "disabled"].includes(definition.status)
        ) {
          throw new PersistenceError("CONFLICT", "Agent generation 或状态已变化");
        }
        const content = validateAgentRevisionContent(input.content);
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
        const result = mapDefinition(row, await scopeIds(client, row.id));
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
        const result = mapDefinition(row, await scopeIds(client, row.id));
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
        const result = mapDefinition(row, await scopeIds(client, row.id));
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
