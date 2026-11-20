import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  apiKeyScope,
  isoTimestamp,
  type ApiKeyRecord,
  type ApiKeyScope,
  tenantId,
  userId,
} from "@hoox/domain";
import { hashApiKey, type ApiKeyAuthenticationPort, type ApiKeyPrincipal } from "@hoox/identity";
import type { PoolClient, QueryResultRow } from "pg";
import type { TenantScope } from "./ports.js";
import { TransactionCommitUnknownError, withTransaction, type Pool as PgPool } from "./postgres.js";

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
  constructor(private readonly pool: PgPool) {}

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
      return await transaction(this.pool, async (client) => {
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
    return transaction(this.pool, async (client) => {
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
    return transaction(this.pool, async (client) => {
      await setTenant(client, scope);
      const result = await client.query<ApiKeyRow>(
        `SELECT ${columns} FROM api_keys ORDER BY created_at DESC, id`,
      );
      return Object.freeze(result.rows.map(mapKey));
    });
  }

  async revoke(scope: TenantScope, id: string, now: string): Promise<ApiKeyRecord | undefined> {
    return transaction(this.pool, async (client) => {
      await setTenant(client, scope);
      const result = await client.query<ApiKeyRow>(
        `UPDATE api_keys SET revoked_at = $3 WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING ${columns}`,
        [scope.tenantId, id, now],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      await client.query(
        "UPDATE memberships SET status = 'revoked' WHERE tenant_id = $1 AND user_id = $2",
        [scope.tenantId, row.integration_user_id],
      );
      return mapKey(row);
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
