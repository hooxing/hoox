import { createHash, randomBytes } from "node:crypto";
import {
  type AcceptedMcpProbeTool,
  type AdminExternalToolBatchDto,
  type AdminExternalToolOverview,
  type AdminExternalToolVersionSummary,
  type AdminMcpDraftDto,
  type AdminMcpDraftSettings,
  type ControlOperatorRole,
  type ExternalToolAdminRepositoryPort,
  ExternalToolAdminError,
  type ExternalToolCommandContext,
  externalToolAccess,
} from "@hoox/admin-control";
import { validateExternalToolVersion, type ExternalToolVersion } from "@hoox/domain";
import type { QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import type {
  ExternalToolCredentialCipher,
  ExternalToolDraftCredentialCipher,
} from "./external-tool-credential.js";
import type { Pool, PoolClient } from "./postgres.js";
import { TransactionCommitUnknownError, withTransaction } from "./postgres.js";

import {
  insertExternalToolVersion,
  EXTERNAL_TOOL_REVOCATION_LOCK,
} from "./external-tool-version-write.js";

interface DraftRow extends QueryResultRow {
  draft_id: string;
  display_name: string;
  server_name: string;
  endpoint: string;
  timeout_ms: number;
  max_response_bytes: number;
  side_effect: AdminMcpDraftSettings["sideEffect"];
  idempotent: boolean;
  credential_configured: boolean;
  generation: string;
  batch_count: string;
  created_at: Date | string;
  updated_at: Date | string;
}
interface BatchRow extends QueryResultRow {
  batch_id: string;
  draft_id: string;
  sequence: number;
  draft_generation: string;
  display_name: string;
  source: "mcp" | "http";
  server_name: string;
  endpoint: string;
  created_by: string;
  created_at: Date | string;
}
interface VersionRow extends QueryResultRow {
  batch_id: string;
  tool_version_id: string;
  model_tool_name: string;
  remote_tool_name: string | null;
  description: string;
  input_schema_digest: string;
  timeout_ms: number;
  max_response_bytes: number;
  side_effect: AdminMcpDraftSettings["sideEffect"];
  idempotent: boolean;
  credential_configured: boolean;
  revoked_at: Date | string | null;
  revocation_reason: string | null;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function generatedId(prefix: "etb" | "etv"): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function mapDraft(row: DraftRow): AdminMcpDraftDto {
  return Object.freeze({
    draftId: row.draft_id,
    source: "mcp",
    displayName: row.display_name,
    serverName: row.server_name,
    endpoint: row.endpoint,
    timeoutMs: row.timeout_ms,
    maxResponseBytes: row.max_response_bytes,
    sideEffect: row.side_effect,
    idempotent: row.idempotent,
    credentialConfigured: row.credential_configured,
    generation: Number(row.generation),
    publishedBatchCount: Number(row.batch_count),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function mapBatch(row: BatchRow, versions: readonly VersionRow[]): AdminExternalToolBatchDto {
  const tools: AdminExternalToolVersionSummary[] = versions.map((version) => ({
    toolVersionId: version.tool_version_id,
    modelToolName: version.model_tool_name,
    remoteToolName: version.remote_tool_name,
    description: version.description,
    inputSchemaDigest: version.input_schema_digest,
    timeoutMs: version.timeout_ms,
    maxResponseBytes: version.max_response_bytes,
    sideEffect: version.side_effect,
    idempotent: version.idempotent,
    credentialConfigured: version.credential_configured,
    revoked: version.revoked_at !== null,
  }));
  const revocation = versions.find((version) => version.revoked_at !== null);
  return Object.freeze({
    batchId: row.batch_id,
    draftId: row.draft_id,
    sequence: row.sequence,
    displayName: row.display_name,
    source: row.source,
    serverName: row.server_name,
    endpoint: row.endpoint,
    draftGeneration: Number(row.draft_generation),
    createdAt: timestamp(row.created_at),
    createdBy: row.created_by,
    // 批次以整体为单位撤销；任一版本撤销都使整批在选择视图中不可见。
    revoked: revocation !== undefined,
    ...(revocation?.revoked_at ? { revokedAt: timestamp(revocation.revoked_at) } : {}),
    ...(revocation?.revocation_reason ? { revocationReason: revocation.revocation_reason } : {}),
    tools,
  });
}

const draftColumns = `d.draft_id,d.display_name,d.server_name,d.endpoint,d.timeout_ms,d.max_response_bytes,
  d.side_effect,d.idempotent,d.credential_configured,d.generation::text,d.created_at,d.updated_at,
  (SELECT count(*) FROM external_tool_publish_batches b WHERE b.draft_id=d.draft_id)::text AS batch_count`;

const versionSelect = `SELECT bv.batch_id,v.tool_version_id,v.model_tool_name,v.remote_tool_name,v.description,
    v.input_schema_digest,v.timeout_ms,v.max_response_bytes,v.side_effect,v.idempotent,v.credential_configured,
    r.revoked_at,r.reason AS revocation_reason
  FROM external_tool_publish_batch_versions bv
  JOIN external_tool_versions v USING(tool_version_id)
  LEFT JOIN external_tool_revocations r USING(tool_version_id)`;

async function resolveAdmin(client: PoolClient, actorUserId: string): Promise<void> {
  await client.query("SELECT set_config('app.user_id',$1,true)", [actorUserId]);
  const result = await client.query<{ role: ControlOperatorRole }>(
    "SELECT role FROM platform_control_operators WHERE user_id=$1 AND status='active'",
    [actorUserId],
  );
  if (!externalToolAccess(result.rows[0]?.role).canRegister)
    throw new ExternalToolAdminError("NOT_AUTHORIZED", "外部工具注册与发布仅限平台管理员");
}

function translate(error: unknown, action: string): Error {
  if (error instanceof ExternalToolAdminError) return error;
  if (error instanceof TransactionCommitUnknownError)
    return new ExternalToolAdminError(
      "PUBLISH_RESULT_UNKNOWN",
      "操作结果暂时无法确认；请使用相同幂等键查询或重试，不要创建新请求",
    );
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (code === "23505") return new ExternalToolAdminError("CONFLICT", "对象已存在或已被并发修改");
  if (code === "42501")
    return new ExternalToolAdminError("NOT_AUTHORIZED", "外部工具注册与发布仅限平台管理员");
  return mapPersistenceError(error, action);
}

async function readDraft(
  client: PoolClient,
  draftId: string,
  lock = false,
): Promise<DraftRow | undefined> {
  if (lock)
    await client.query(
      "SELECT draft_id FROM external_tool_registration_drafts WHERE draft_id=$1 FOR UPDATE",
      [draftId],
    );
  const result = await client.query<DraftRow>(
    `SELECT ${draftColumns} FROM external_tool_registration_drafts d WHERE d.draft_id=$1`,
    [draftId],
  );
  return result.rows[0];
}

async function requireDraft(
  client: PoolClient,
  draftId: string,
  expectedGeneration: number,
  lock: boolean,
): Promise<DraftRow> {
  const draft = await readDraft(client, draftId, lock);
  if (!draft) throw new ExternalToolAdminError("NOT_FOUND", "外部工具草稿不存在");
  if (Number(draft.generation) !== expectedGeneration)
    throw new ExternalToolAdminError("CONFLICT", "草稿已被更新，请刷新后重试");
  return draft;
}

async function readBatch(
  client: PoolClient,
  batchId: string,
): Promise<AdminExternalToolBatchDto | undefined> {
  const batch = await client.query<BatchRow>(
    "SELECT batch_id,draft_id,sequence,draft_generation::text,display_name,source,server_name,endpoint,created_by,created_at FROM external_tool_publish_batches WHERE batch_id=$1",
    [batchId],
  );
  const row = batch.rows[0];
  if (!row) return undefined;
  const versions = await client.query<VersionRow>(
    `${versionSelect} WHERE bv.batch_id=$1 ORDER BY v.model_tool_name`,
    [batchId],
  );
  return mapBatch(row, versions.rows);
}

async function lockCommand(
  client: PoolClient,
  context: ExternalToolCommandContext,
  request: unknown,
): Promise<unknown | undefined> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [
    `external-tool-admin:${context.actorUserId}:${context.idempotencyKey}`,
  ]);
  return readCommand(client, context, request);
}

async function readCommand(
  client: PoolClient,
  context: ExternalToolCommandContext,
  request: unknown,
): Promise<unknown | undefined> {
  const found = await client.query<{ request_digest: string; response: unknown }>(
    "SELECT request_digest,response FROM external_tool_admin_commands WHERE actor_user_id=$1 AND idempotency_key=$2",
    [context.actorUserId, context.idempotencyKey],
  );
  const prior = found.rows[0];
  if (prior === undefined) {
    const claim = await client.query<{ request_digest: string }>(
      "SELECT request_digest FROM external_tool_admin_publish_claims WHERE actor_user_id=$1 AND idempotency_key=$2",
      [context.actorUserId, context.idempotencyKey],
    );
    if (claim.rows[0] !== undefined && claim.rows[0].request_digest !== digest(request))
      throw new ExternalToolAdminError("CONFLICT", "幂等键已用于不同请求");
    return undefined;
  }
  if (prior.request_digest !== digest(request))
    throw new ExternalToolAdminError("CONFLICT", "幂等键已用于不同请求");
  return prior.response;
}

async function recordCommand(
  client: PoolClient,
  context: ExternalToolCommandContext,
  request: unknown,
  response: unknown,
): Promise<void> {
  await client.query(
    "INSERT INTO external_tool_admin_commands(actor_user_id,idempotency_key,request_digest,response) VALUES($1,$2,$3,$4)",
    [context.actorUserId, context.idempotencyKey, digest(request), JSON.stringify(response)],
  );
}

async function audit(
  client: PoolClient,
  input: {
    readonly actorUserId: string;
    readonly action: "draft_saved" | "credential_changed" | "probed" | "published" | "revoked";
    readonly objectId: string;
    readonly outcome: "succeeded" | "rejected" | "failed";
    readonly reason: string;
  },
): Promise<void> {
  await client.query(
    "INSERT INTO external_tool_admin_audits(actor_user_id,action,object_id,outcome,reason) VALUES($1,$2,$3,$4,$5)",
    [input.actorUserId, input.action, input.objectId, input.outcome, input.reason.slice(0, 500)],
  );
}

function batchDisplayName(displayName: string, sequence: number): string {
  const suffix = ` v${sequence}`;
  let base = displayName;
  while (Buffer.byteLength(base + suffix, "utf8") > 200) base = base.slice(0, -1);
  return base + suffix;
}

/**
 * 外部工具管理面写路径。凭据明文只在加解密边界短暂出现：投影、幂等响应、审计与错误只含
 * credentialConfigured；幂等摘要以带密钥指纹代替凭据。
 */
export class PgExternalToolAdminRepository implements ExternalToolAdminRepositoryPort {
  private readonly pool: Pool;
  private readonly versionCipher: ExternalToolCredentialCipher;
  private readonly draftCipher: ExternalToolDraftCredentialCipher;

  constructor(
    pool: Pool,
    versionCipher: ExternalToolCredentialCipher,
    draftCipher: ExternalToolDraftCredentialCipher,
  ) {
    this.pool = pool;
    this.versionCipher = versionCipher;
    this.draftCipher = draftCipher;
  }

  private async admin<T>(
    actorUserId: string,
    action: string,
    run: (client: PoolClient) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    try {
      return await withTransaction(
        this.pool,
        async (client) => {
          await resolveAdmin(client, actorUserId);
          return run(client);
        },
        readOnly ? { readOnly: true, isolationLevel: "REPEATABLE READ" } : {},
      );
    } catch (error) {
      throw translate(error, action);
    }
  }

  async requireAdmin(actorUserId: string): Promise<void> {
    await this.admin(actorUserId, "校验外部工具管理权限", async () => undefined, true);
  }

  async overview(actorUserId: string): Promise<AdminExternalToolOverview> {
    return this.admin(
      actorUserId,
      "读取外部工具注册",
      async (client) => {
        const drafts = await client.query<DraftRow>(
          `SELECT ${draftColumns} FROM external_tool_registration_drafts d ORDER BY d.updated_at DESC, d.draft_id`,
        );
        const batches = await client.query<BatchRow>(
          "SELECT batch_id,draft_id,sequence,draft_generation::text,display_name,source,server_name,endpoint,created_by,created_at FROM external_tool_publish_batches ORDER BY created_at DESC, batch_id",
        );
        const versions = await client.query<VersionRow>(
          `${versionSelect} ORDER BY v.model_tool_name`,
        );
        const byBatch = new Map<string, VersionRow[]>();
        for (const row of versions.rows) {
          const list = byBatch.get(row.batch_id) ?? [];
          list.push(row);
          byBatch.set(row.batch_id, list);
        }
        return {
          drafts: drafts.rows.map(mapDraft),
          batches: batches.rows.map((row) => mapBatch(row, byBatch.get(row.batch_id) ?? [])),
        };
      },
      true,
    );
  }

  async createMcpDraft(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly settings: AdminMcpDraftSettings;
      readonly credential?: string;
    },
  ): Promise<AdminMcpDraftDto> {
    const request = {
      operation: "create_mcp_draft",
      draftId: input.draftId,
      settings: input.settings,
      credential:
        input.credential === undefined
          ? null
          : this.draftCipher.fingerprint(input.draftId, input.credential),
    };
    return this.admin(input.actorUserId, "保存外部工具草稿", async (client) => {
      const replay = await lockCommand(client, input, request);
      if (replay !== undefined) return replay as AdminMcpDraftDto;
      const s = input.settings;
      await client.query(
        `INSERT INTO external_tool_registration_drafts(draft_id,source,display_name,server_name,endpoint,timeout_ms,max_response_bytes,side_effect,idempotent,credential_configured,generation,created_by,updated_by)
         VALUES($1,'mcp',$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$10)`,
        [
          input.draftId,
          s.displayName,
          s.serverName,
          s.endpoint,
          s.timeoutMs,
          s.maxResponseBytes,
          s.sideEffect,
          s.idempotent,
          input.credential !== undefined,
          input.actorUserId,
        ],
      );
      if (input.credential !== undefined) {
        await this.insertDraftCredential(client, input.draftId, input.credential);
        await audit(client, {
          actorUserId: input.actorUserId,
          action: "credential_changed",
          objectId: input.draftId,
          outcome: "succeeded",
          reason: "写入草稿凭据",
        });
      }
      await audit(client, {
        actorUserId: input.actorUserId,
        action: "draft_saved",
        objectId: input.draftId,
        outcome: "succeeded",
        reason: "创建 MCP Server 草稿",
      });
      const row = await readDraft(client, input.draftId);
      if (!row) throw new TypeError("外部工具草稿写入后缺失");
      const result = mapDraft(row);
      await recordCommand(client, input, request, result);
      return result;
    });
  }

  async updateMcpDraft(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
      readonly settings: AdminMcpDraftSettings;
    },
  ): Promise<AdminMcpDraftDto> {
    const request = {
      operation: "update_mcp_draft",
      draftId: input.draftId,
      expectedGeneration: input.expectedGeneration,
      settings: input.settings,
    };
    return this.admin(input.actorUserId, "更新外部工具草稿", async (client) => {
      const replay = await lockCommand(client, input, request);
      if (replay !== undefined) return replay as AdminMcpDraftDto;
      const previous = await requireDraft(client, input.draftId, input.expectedGeneration, true);
      const s = input.settings;
      // 探测会随请求发送凭据；改地址前必须先清除旧凭据，不允许跨端点转送。
      if (previous.credential_configured && previous.endpoint !== s.endpoint)
        throw new ExternalToolAdminError("CONFLICT", "请先清除草稿凭据，再修改 MCP Server 地址");
      await client.query(
        `UPDATE external_tool_registration_drafts SET display_name=$2,server_name=$3,endpoint=$4,timeout_ms=$5,
           max_response_bytes=$6,side_effect=$7,idempotent=$8,generation=generation+1,updated_by=$9,updated_at=clock_timestamp()
         WHERE draft_id=$1`,
        [
          input.draftId,
          s.displayName,
          s.serverName,
          s.endpoint,
          s.timeoutMs,
          s.maxResponseBytes,
          s.sideEffect,
          s.idempotent,
          input.actorUserId,
        ],
      );
      await audit(client, {
        actorUserId: input.actorUserId,
        action: "draft_saved",
        objectId: input.draftId,
        outcome: "succeeded",
        reason: "更新 MCP Server 草稿",
      });
      const row = await readDraft(client, input.draftId);
      if (!row) throw new TypeError("外部工具草稿更新后缺失");
      const result = mapDraft(row);
      await recordCommand(client, input, request, result);
      return result;
    });
  }

  async setDraftCredential(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
      readonly credential: string | null;
    },
  ): Promise<AdminMcpDraftDto> {
    const request = {
      operation: "set_draft_credential",
      draftId: input.draftId,
      expectedGeneration: input.expectedGeneration,
      credential:
        input.credential === null
          ? null
          : this.draftCipher.fingerprint(input.draftId, input.credential),
    };
    return this.admin(input.actorUserId, "写入外部工具草稿凭据", async (client) => {
      const replay = await lockCommand(client, input, request);
      if (replay !== undefined) return replay as AdminMcpDraftDto;
      await requireDraft(client, input.draftId, input.expectedGeneration, true);
      await client.query("DELETE FROM external_tool_draft_credentials WHERE draft_id=$1", [
        input.draftId,
      ]);
      if (input.credential !== null)
        await this.insertDraftCredential(client, input.draftId, input.credential);
      await client.query(
        "UPDATE external_tool_registration_drafts SET credential_configured=$2,generation=generation+1,updated_by=$3,updated_at=clock_timestamp() WHERE draft_id=$1",
        [input.draftId, input.credential !== null, input.actorUserId],
      );
      await audit(client, {
        actorUserId: input.actorUserId,
        action: "credential_changed",
        objectId: input.draftId,
        outcome: "succeeded",
        reason: input.credential === null ? "清除草稿凭据" : "写入草稿凭据",
      });
      const row = await readDraft(client, input.draftId);
      if (!row) throw new TypeError("外部工具草稿凭据更新后缺失");
      const result = mapDraft(row);
      await recordCommand(client, input, request, result);
      return result;
    });
  }

  async loadDraftForProbe(input: {
    readonly actorUserId: string;
    readonly draftId: string;
    readonly expectedGeneration: number;
  }): Promise<{ readonly draft: AdminMcpDraftDto; readonly credential?: string }> {
    return this.admin(
      input.actorUserId,
      "读取外部工具草稿",
      async (client) => {
        const row = await requireDraft(client, input.draftId, input.expectedGeneration, false);
        const draft = mapDraft(row);
        if (!row.credential_configured) return { draft };
        const credential = await this.readDraftCredential(client, input.draftId);
        return { draft, credential };
      },
      true,
    );
  }

  async withPublishClaim(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
    },
    execute: (leaseOwner: string) => Promise<AdminExternalToolBatchDto>,
  ): Promise<AdminExternalToolBatchDto> {
    const request = publishRequest(input);
    const requestDigest = digest(request);
    const owner = randomBytes(16).toString("hex");
    const waitUntil = Date.now() + 170_000;
    let acquired = false;

    while (!acquired) {
      const claim = await this.admin(input.actorUserId, "协调外部工具发布", async (client) => {
        const replay = await lockCommand(client, input, request);
        if (replay !== undefined)
          return { kind: "completed" as const, result: replay as AdminExternalToolBatchDto };
        const inserted = await client.query(
          `INSERT INTO external_tool_admin_publish_claims
             (actor_user_id,idempotency_key,request_digest,lease_owner,lease_expires_at)
           VALUES($1,$2,$3,$4,clock_timestamp()+interval '150 seconds')
           ON CONFLICT(actor_user_id,idempotency_key) DO NOTHING RETURNING lease_owner`,
          [input.actorUserId, input.idempotencyKey, requestDigest, owner],
        );
        if (inserted.rowCount === 1) return { kind: "acquired" as const };
        const current = await client.query<{
          request_digest: string;
          expired: boolean;
        }>(
          `SELECT request_digest,lease_expires_at <= clock_timestamp() AS expired FROM external_tool_admin_publish_claims
            WHERE actor_user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.actorUserId, input.idempotencyKey],
        );
        const row = current.rows[0];
        if (!row) return { kind: "retry" as const };
        if (row.request_digest !== requestDigest)
          throw new ExternalToolAdminError("CONFLICT", "幂等键已用于不同请求");
        if (row.expired) {
          await client.query(
            `UPDATE external_tool_admin_publish_claims
                SET lease_owner=$3,lease_expires_at=clock_timestamp()+interval '150 seconds'
              WHERE actor_user_id=$1 AND idempotency_key=$2`,
            [input.actorUserId, input.idempotencyKey, owner],
          );
          return { kind: "acquired" as const };
        }
        return { kind: "waiting" as const };
      });
      if (claim.kind === "completed") return claim.result;
      acquired = claim.kind === "acquired";
      if (!acquired) {
        if (Date.now() >= waitUntil)
          throw new ExternalToolAdminError(
            "PUBLISH_RESULT_UNKNOWN",
            "同一发布请求仍在处理中；请使用相同幂等键查询或重试",
          );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    let resultUnknown = false;
    try {
      return await execute(owner);
    } catch (error) {
      resultUnknown =
        error instanceof ExternalToolAdminError && error.code === "PUBLISH_RESULT_UNKNOWN";
      throw error;
    } finally {
      // 未知结果保留租约等待对账；明确失败只释放执行权，保留摘要以拒绝异请求复用键。
      try {
        if (!resultUnknown)
          await this.admin(input.actorUserId, "结算外部工具发布协调", async (client) => {
            await client.query(
              `UPDATE external_tool_admin_publish_claims SET lease_expires_at=clock_timestamp()
              WHERE actor_user_id=$1 AND idempotency_key=$2 AND lease_owner=$3`,
              [input.actorUserId, input.idempotencyKey, owner],
            );
          });
      } catch {
        // 保留租约作为崩溃恢复边界。
      }
    }
  }

  async replayPublish(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
    },
  ): Promise<AdminExternalToolBatchDto | undefined> {
    return this.admin(
      input.actorUserId,
      "读取外部工具发布结果",
      async (client) =>
        (await readCommand(client, input, publishRequest(input))) as
          | AdminExternalToolBatchDto
          | undefined,
      true,
    );
  }

  async recordProbeAudit(input: {
    readonly actorUserId: string;
    readonly draftId: string;
    readonly action: "probed" | "published";
    readonly outcome: "succeeded" | "rejected" | "failed";
    readonly reason: string;
  }): Promise<void> {
    await this.admin(input.actorUserId, "写入外部工具审计", async (client) => {
      await audit(client, { ...input, objectId: input.draftId });
    });
  }

  async publishMcpBatch(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
      readonly tools: readonly AcceptedMcpProbeTool[];
      readonly leaseOwner: string;
    },
  ): Promise<AdminExternalToolBatchDto> {
    const request = publishRequest(input);
    return this.admin(input.actorUserId, "发布外部工具批次", async (client) => {
      const replay = await lockCommand(client, input, request);
      if (replay !== undefined) return replay as AdminExternalToolBatchDto;
      // 租约被超时接管后，旧执行者不得提交；声明行锁与发布事务一起持有至 COMMIT。
      const claim = await client.query<{ lease_owner: string }>(
        `SELECT lease_owner FROM external_tool_admin_publish_claims
          WHERE actor_user_id=$1 AND idempotency_key=$2 AND request_digest=$3 FOR UPDATE`,
        [input.actorUserId, input.idempotencyKey, digest(request)],
      );
      if (claim.rows[0]?.lease_owner !== input.leaseOwner)
        throw new ExternalToolAdminError("CONFLICT", "发布已被接管，请使用原幂等键重试");
      // 锁住草稿并复核 generation：探测期间草稿或凭据被修改时整批放弃。
      const draft = await requireDraft(client, input.draftId, input.expectedGeneration, true);
      if (input.tools.length === 0 || input.tools.length > 64)
        throw new ExternalToolAdminError("PUBLISH_REJECTED", "工具数量必须在 1 到 64 之间");
      if (new Set(input.tools.map((tool) => tool.modelToolName)).size !== input.tools.length)
        throw new ExternalToolAdminError("PUBLISH_REJECTED", "多个工具转换后名称冲突，整批未发布");
      const credential = draft.credential_configured
        ? await this.readDraftCredential(client, input.draftId)
        : undefined;
      const batchId = generatedId("etb");
      // 先在内存中完成全部版本校验，任一不合规都不会写入任何行。
      const versions: ExternalToolVersion[] = input.tools.map((tool) => {
        try {
          return validateExternalToolVersion({
            toolVersionId: generatedId("etv"),
            source: "mcp",
            endpoint: draft.endpoint,
            modelToolName: tool.modelToolName,
            remoteToolName: tool.remoteToolName,
            description: tool.description,
            inputSchema: tool.inputSchema,
            inputSchemaDigest: tool.inputSchemaDigest,
            timeoutMs: draft.timeout_ms,
            maxResponseBytes: draft.max_response_bytes,
            sideEffect: draft.side_effect,
            idempotent: draft.idempotent,
            credentialRef: credential === undefined ? null : batchId,
          });
        } catch {
          throw new ExternalToolAdminError(
            "PUBLISH_REJECTED",
            "工具定义未通过平台校验，整批未发布",
          );
        }
      });
      const next = await client.query<{ sequence: number }>(
        "SELECT COALESCE(max(sequence),0)+1 AS sequence FROM external_tool_publish_batches WHERE draft_id=$1",
        [input.draftId],
      );
      const sequence = Number(next.rows[0]?.sequence ?? 1);
      await client.query(
        `INSERT INTO external_tool_publish_batches(batch_id,draft_id,sequence,draft_generation,display_name,source,server_name,endpoint,created_by)
         VALUES($1,$2,$3,$4,$5,'mcp',$6,$7,$8)`,
        [
          batchId,
          input.draftId,
          sequence,
          draft.generation,
          batchDisplayName(draft.display_name, sequence),
          draft.server_name,
          draft.endpoint,
          input.actorUserId,
        ],
      );
      for (const version of versions) {
        await insertExternalToolVersion(
          client,
          input.actorUserId,
          version,
          credential,
          this.versionCipher,
        );
        await client.query(
          "INSERT INTO external_tool_publish_batch_versions(batch_id,tool_version_id) VALUES($1,$2)",
          [batchId, version.toolVersionId],
        );
      }
      await audit(client, {
        actorUserId: input.actorUserId,
        action: "published",
        objectId: batchId,
        outcome: "succeeded",
        reason: `发布草稿 ${input.draftId} 的 ${versions.length} 个工具`,
      });
      const result = await readBatch(client, batchId);
      if (!result) throw new TypeError("外部工具批次写入后缺失");
      await recordCommand(client, input, request, result);
      return result;
    });
  }

  async revokeBatch(
    input: ExternalToolCommandContext & { readonly batchId: string; readonly reason: string },
  ): Promise<AdminExternalToolBatchDto> {
    const request = { operation: "revoke_batch", batchId: input.batchId, reason: input.reason };
    return this.admin(input.actorUserId, "撤销外部工具批次", async (client) => {
      const replay = await lockCommand(client, input, request);
      if (replay !== undefined) return replay as AdminExternalToolBatchDto;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [
        EXTERNAL_TOOL_REVOCATION_LOCK,
      ]);
      const current = await readBatch(client, input.batchId);
      if (!current) throw new ExternalToolAdminError("NOT_FOUND", "外部工具批次不存在");
      if (current.revoked) throw new ExternalToolAdminError("CONFLICT", "该批次已撤销");
      await client.query(
        `INSERT INTO external_tool_revocations(tool_version_id,reason,actor_user_id)
         SELECT tool_version_id,$2,$3 FROM external_tool_publish_batch_versions WHERE batch_id=$1`,
        [input.batchId, input.reason, input.actorUserId],
      );
      await audit(client, {
        actorUserId: input.actorUserId,
        action: "revoked",
        objectId: input.batchId,
        outcome: "succeeded",
        reason: input.reason,
      });
      const result = await readBatch(client, input.batchId);
      if (!result) throw new TypeError("外部工具批次撤销后缺失");
      await recordCommand(client, input, request, result);
      return result;
    });
  }

  private async insertDraftCredential(
    client: PoolClient,
    draftId: string,
    credential: string,
  ): Promise<void> {
    const encrypted = this.draftCipher.encrypt(draftId, credential);
    await client.query(
      "INSERT INTO external_tool_draft_credentials(draft_id,cipher_version,nonce,ciphertext,auth_tag) VALUES($1,$2,$3,$4,$5)",
      [draftId, encrypted.version, encrypted.nonce, encrypted.ciphertext, encrypted.authTag],
    );
  }

  private async readDraftCredential(client: PoolClient, draftId: string): Promise<string> {
    const result = await client.query<{
      cipher_version: number;
      nonce: string;
      ciphertext: string;
      auth_tag: string;
    }>(
      "SELECT cipher_version,nonce,ciphertext,auth_tag FROM external_tool_draft_credentials WHERE draft_id=$1",
      [draftId],
    );
    const row = result.rows[0];
    if (!row) throw new ExternalToolAdminError("PROBE_UNAVAILABLE", "草稿凭据缺失，请重新写入凭据");
    try {
      return this.draftCipher.decrypt(draftId, {
        version: row.cipher_version as 1,
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
      });
    } catch {
      // 解密失败只返回受控文案，不携带密文或底层异常。
      throw new ExternalToolAdminError("PROBE_UNAVAILABLE", "草稿凭据无法解密，请重新写入凭据");
    }
  }
}

function publishRequest(input: {
  readonly draftId: string;
  readonly expectedGeneration: number;
}): unknown {
  return {
    operation: "publish_mcp_batch",
    draftId: input.draftId,
    expectedGeneration: input.expectedGeneration,
  };
}
