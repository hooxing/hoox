import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  type ApiKeyRecord,
  type ApiKeyScope,
  apiKeyScope,
  isoTimestamp,
  tenantId,
  userId,
} from "@hoox/domain";
import {
  type ApiKeyAuthenticationPort,
  type ApiKeyPrincipal,
  hashApiKey,
  isExternalEndUserId,
} from "@hoox/identity";
import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError } from "./errors.js";
import type { TenantScope } from "./ports.js";
import { type Pool as PgPool, TransactionCommitUnknownError, withTransaction } from "./postgres.js";

interface ApiKeyRow extends QueryResultRow {
  id: string;
  key_hash: Buffer;
  tenant_id: string;
  integration_user_id: string;
  key_prefix: string;
  name: string;
  note: string | null;
  scopes: string[];
  created_by_user_id: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

function iso(value: Date | null): string | undefined {
  return value?.toISOString();
}

function mapKey(row: ApiKeyRow): ApiKeyRecord {
  const expiresAt = iso(row.expires_at);
  const revokedAt = iso(row.revoked_at);
  const lastUsedAt = iso(row.last_used_at);
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    integrationUserId: row.integration_user_id,
    prefix: row.key_prefix,
    name: row.name,
    ...(row.note === null ? {} : { note: row.note }),
    scopes: Object.freeze(row.scopes.map(apiKeyScope)),
    createdBy: row.created_by_user_id,
    createdAt: isoTimestamp(row.created_at.toISOString()),
    ...(expiresAt === undefined ? {} : { expiresAt: isoTimestamp(expiresAt) }),
    ...(revokedAt === undefined ? {} : { revokedAt: isoTimestamp(revokedAt) }),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt: isoTimestamp(lastUsedAt) }),
  });
}

const columns = `id, key_hash, tenant_id, integration_user_id, key_prefix, name, note, scopes,
  created_by_user_id, created_at, expires_at, revoked_at, last_used_at`;

async function transaction<T>(
  pool: PgPool,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return await withTransaction(pool, callback);
}

async function setTenant(client: PoolClient, scope: TenantScope): Promise<void> {
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    [scope.tenantId, scope.userId],
  );
}

export class PgApiKeyRepository implements ApiKeyAuthenticationPort {
  constructor(
    private readonly pool: PgPool,
    private readonly transact: <T>(operation: (client: PoolClient) => Promise<T>) => Promise<T> = (
      operation,
    ) => transaction(pool, operation),
  ) {}

  async mapEndUser(input: {
    readonly principal: ApiKeyPrincipal;
    readonly externalId: string;
    readonly now: string;
  }): Promise<
    | Readonly<{ userId: ReturnType<typeof userId>; tenantId: ReturnType<typeof tenantId> }>
    | "disabled"
    | undefined
  > {
    if (
      !input.principal.scopes.includes("end-users:represent") ||
      !isExternalEndUserId(input.externalId)
    )
      return undefined;
    return transaction(this.pool, async (client) => {
      await setTenant(client, input.principal);
      const credential = await client.query(
        `SELECT k.id FROM api_keys k JOIN memberships m
           ON m.tenant_id=k.tenant_id AND m.user_id=k.integration_user_id
         WHERE k.tenant_id=$1 AND k.id=$2 AND k.integration_user_id=$3
           AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
           AND 'end-users:represent'=ANY(k.scopes) AND m.status='active'
         FOR SHARE OF k,m`,
        [input.principal.tenantId, input.principal.apiKeyId, input.principal.userId],
      );
      if (credential.rowCount !== 1) return undefined;
      await client.query("SELECT set_config('app.end_user_integration_tenant',$1,true)", [
        input.principal.tenantId,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([input.principal.tenantId, input.externalId]),
      ]);
      const existing = await client.query<{
        user_id: string;
        personal_tenant_id: string;
        status: string;
      }>(
        `SELECT user_id,personal_tenant_id,status FROM api_end_users
         WHERE integration_tenant_id=$1 AND external_id=$2`,
        [input.principal.tenantId, input.externalId],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.status !== "active") return "disabled";
        return { userId: userId(row.user_id), tenantId: tenantId(row.personal_tenant_id) };
      }
      const mapped = {
        userId: userId(`usr_${randomUUID()}`),
        tenantId: tenantId(`tenant_${randomUUID()}`),
      };
      await setTenant(client, mapped);
      await client.query("INSERT INTO app_users(id,created_at) VALUES($1,$2)", [
        mapped.userId,
        input.now,
      ]);
      await client.query(
        "INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES($1,'personal',$2,$3)",
        [mapped.tenantId, mapped.userId, input.now],
      );
      await client.query(
        "INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at) VALUES($1,$2,$3,'owner','active',$4)",
        [mapped.tenantId, `mem_${randomUUID()}`, mapped.userId, input.now],
      );
      await client.query(
        `INSERT INTO api_end_users(integration_tenant_id,created_by_api_key_id,created_by_integration_user_id,external_id,user_id,personal_tenant_id,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.principal.tenantId,
          input.principal.apiKeyId,
          input.principal.userId,
          input.externalId,
          mapped.userId,
          mapped.tenantId,
          input.now,
        ],
      );
      return mapped;
    });
  }

  async create(input: {
    readonly scope: TenantScope;
    readonly createdBy: string;
    readonly keyHash: Uint8Array;
    readonly prefix: string;
    readonly name: string;
    readonly note?: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly expiresAt?: string;
    readonly now: string;
  }): Promise<ApiKeyRecord> {
    const id = `key_${randomUUID()}`;
    const integrationUserId = userId(`int_${randomUUID()}`);
    const membershipId = `mem_${randomUUID()}`;
    try {
      return await this.transact(async (client) => {
        await setTenant(client, { ...input.scope, userId: integrationUserId });
        await client.query(
          "INSERT INTO app_users(id, created_at, kind) VALUES ($1, $2, 'integration')",
          [integrationUserId, input.now],
        );
        await client.query(
          "INSERT INTO memberships(tenant_id, id, user_id, role, status, created_at) VALUES ($1, $2, $3, 'member', 'active', $4)",
          [input.scope.tenantId, membershipId, integrationUserId, input.now],
        );
        const result = await client.query<ApiKeyRow>(
          `INSERT INTO api_keys(tenant_id, id, integration_user_id, key_hash, key_prefix, name, note, scopes, created_by_user_id, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${columns}`,
          [
            input.scope.tenantId,
            id,
            integrationUserId,
            input.keyHash,
            input.prefix,
            input.name,
            input.note ?? null,
            input.scopes,
            input.createdBy,
            input.now,
            input.expiresAt ?? null,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("API_KEY_INSERT_RETURNED_NO_ROW");
        return mapKey(row);
      });
    } catch (error) {
      if (!(error instanceof TransactionCommitUnknownError)) throw error;
      // 创建响应含一次性明文；COMMIT 未知时只按新生成的高熵哈希精确读回，绝不重写。
      try {
        const committed = await this.findByHash(input.keyHash);
        if (committed !== undefined) return committed;
      } catch {
        // 精确读回也不可用时保留原始 COMMIT 未知错误，调用方不能盲目重试写入。
      }
      throw error;
    }
  }

  private async findByHash(keyHash: Uint8Array): Promise<ApiKeyRecord | undefined> {
    return this.transact(async (client) => {
      await client.query("SELECT set_config('app.api_key_hash', $1, true)", [
        Buffer.from(keyHash).toString("hex"),
      ]);
      const result = await client.query<ApiKeyRow>(
        `SELECT ${columns} FROM api_keys WHERE key_hash = $1 LIMIT 1`,
        [keyHash],
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        row.key_hash.length !== keyHash.byteLength ||
        !timingSafeEqual(row.key_hash, keyHash)
      ) {
        return undefined;
      }
      return mapKey(row);
    });
  }

  async list(scope: TenantScope): Promise<readonly ApiKeyRecord[]> {
    return this.transact(async (client) => {
      await setTenant(client, scope);
      const result = await client.query<ApiKeyRow>(
        `SELECT ${columns} FROM api_keys ORDER BY created_at DESC, id`,
      );
      return Object.freeze(result.rows.map(mapKey));
    });
  }

  async revoke(scope: TenantScope, id: string, now: string): Promise<ApiKeyRecord | undefined> {
    return this.transact(async (client) => {
      await setTenant(client, scope);
      const revoked = await client.query<{ readonly integration_user_id: string }>(
        `UPDATE api_keys SET revoked_at = $3
          WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
          RETURNING integration_user_id`,
        [scope.tenantId, id, now],
      );
      const integrationUserId = revoked.rows[0]?.integration_user_id;
      if (integrationUserId === undefined) return undefined;
      const membership = await client.query(
        `UPDATE memberships SET status = 'revoked'
          WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
            AND EXISTS (
              SELECT 1 FROM app_users
               WHERE app_users.id = memberships.user_id AND app_users.kind = 'integration'
            )
          RETURNING user_id`,
        [scope.tenantId, integrationUserId],
      );
      if (membership.rowCount !== 1) {
        throw new PersistenceError(
          "CONSTRAINT_VIOLATION",
          "API Key 集成身份 Membership 未能同步吊销",
        );
      }
      const result = await client.query<ApiKeyRow>(
        `SELECT ${columns} FROM api_keys WHERE tenant_id = $1 AND id = $2`,
        [scope.tenantId, id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("REVOKED_API_KEY_NOT_READABLE");
      return mapKey(row);
    });
  }

  async rotate(
    scope: TenantScope,
    id: string,
    keyHash: Uint8Array,
    prefix: string,
  ): Promise<ApiKeyRecord | undefined> {
    return this.transact(async (client) => {
      await setTenant(client, scope);
      const result = await client.query<ApiKeyRow>(
        `UPDATE api_keys SET key_hash=$3,key_prefix=$4
          WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at>clock_timestamp()) RETURNING ${columns}`,
        [scope.tenantId, id, keyHash, prefix],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : mapKey(row);
    });
  }

  async authenticateKey(input: {
    readonly token: string;
    readonly now: string;
  }): Promise<ApiKeyPrincipal | undefined> {
    const keyHash = hashApiKey(input.token);
    return transaction(this.pool, async (client) => {
      // Tenant 尚未由凭据解析；RLS 仅允许本事务按 SHA-256 哈希命中对应 Key。
      await client.query("SELECT set_config('app.api_key_hash', $1, true)", [
        keyHash.toString("hex"),
      ]);
      const result = await client.query<ApiKeyRow>(
        `SELECT ${columns} FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > clock_timestamp()) LIMIT 1`,
        [keyHash],
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        row.key_hash.length !== keyHash.length ||
        !timingSafeEqual(row.key_hash, keyHash)
      )
        return undefined;
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
        [row.tenant_id, row.integration_user_id],
      );
      const identity = await client.query<{ kind: string }>(
        "SELECT kind FROM app_users WHERE id = $1",
        [row.integration_user_id],
      );
      if (identity.rows[0]?.kind !== "integration") return undefined;
      await client.query(
        "UPDATE api_keys SET last_used_at = clock_timestamp() WHERE tenant_id = $1 AND id = $2 AND (last_used_at IS NULL OR last_used_at < clock_timestamp() - interval '5 minutes')",
        [row.tenant_id, row.id],
      );
      return Object.freeze({
        userId: userId(row.integration_user_id),
        tenantId: tenantId(row.tenant_id),
        apiKeyId: row.id,
        scopes: Object.freeze(row.scopes.map(apiKeyScope)),
      });
    });
  }
}
