import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import { withTransaction } from "./postgres.js";

export type AdminAccessTokenScope = "agent-config:read" | "agent-config:write";

export interface AdminAccessTokenSummary {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly AdminAccessTokenScope[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface AdminAccessTokenCredential {
  readonly id: string;
  readonly creatorUserId: string;
  readonly scopes: readonly AdminAccessTokenScope[];
  readonly auditId: string;
  readonly route: string;
}

interface TokenRow extends QueryResultRow {
  readonly id: string;
  readonly name: string;
  readonly scopes: AdminAccessTokenScope[];
  readonly created_by: string;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly revoked_at: Date | string | null;
  readonly last_used_at: Date | string | null;
}

const prefix = "hoox_at_";
const tokenPattern = /^hoox_at_[A-Za-z0-9_-]{43}$/u;
const day = 86_400_000;
export class AdminAccessTokenQuotaError extends Error {
  constructor() {
    super("ADMIN_ACCESS_TOKEN_QUOTA_EXCEEDED");
  }
}

export interface AdminAccessTokenQuotas {
  readonly perCreator: number;
  readonly global: number;
  readonly listLimit: number;
}

const defaultQuotas: AdminAccessTokenQuotas = { perCreator: 20, global: 1_000, listLimit: 200 };

export class PgAdminAccessTokenRepository {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
    private readonly quotas: AdminAccessTokenQuotas = defaultQuotas,
  ) {}

  async create(
    creatorUserId: string,
    input: {
      readonly name: string;
      readonly scopes: readonly AdminAccessTokenScope[];
      readonly expiresAt?: string;
    },
  ): Promise<{ readonly token: string; readonly accessToken: AdminAccessTokenSummary }> {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 120) throw new TypeError("INVALID_TOKEN_NAME");
    if (input.scopes.length < 1 || input.scopes.length > 2) throw new TypeError("INVALID_SCOPES");
    const scopes = [...new Set(input.scopes)];
    if (scopes.some((scope) => scope !== "agent-config:read" && scope !== "agent-config:write"))
      throw new TypeError("INVALID_SCOPES");
    if (scopes.includes("agent-config:write") && !scopes.includes("agent-config:read"))
      scopes.push("agent-config:read");
    const now = this.now();
    const expiresAt =
      input.expiresAt === undefined
        ? new Date(now.valueOf() + 90 * day)
        : new Date(input.expiresAt);
    if (
      Number.isNaN(expiresAt.valueOf()) ||
      expiresAt <= now ||
      expiresAt.valueOf() > now.valueOf() + 365 * day
    ) {
      throw new TypeError("INVALID_TOKEN_EXPIRATION");
    }
    const token = `${prefix}${randomBytes(32).toString("base64url")}`;
    const salt = randomBytes(16);
    const id = randomUUID();
    const result = await withTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('hoox_admin_access_token_quota',0))",
      );
      const counts = await client.query<{
        readonly creator_count: string;
        readonly global_count: string;
      }>(
        `SELECT count(*) FILTER (WHERE created_by=$1)::text AS creator_count,
                count(*)::text AS global_count
           FROM admin_access_tokens
          WHERE revoked_at IS NULL AND expires_at > $2`,
        [creatorUserId, now],
      );
      const creatorCount = Number(counts.rows[0]?.creator_count ?? 0);
      const globalCount = Number(counts.rows[0]?.global_count ?? 0);
      if (creatorCount >= this.quotas.perCreator || globalCount >= this.quotas.global) {
        throw new AdminAccessTokenQuotaError();
      }
      return await client.query<TokenRow>(
        `INSERT INTO admin_access_tokens
           (id,name,scopes,created_by,token_prefix,token_salt,token_hash,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id,name,scopes,created_by,created_at,expires_at,revoked_at,last_used_at`,
        [
          id,
          name,
          scopes,
          creatorUserId,
          token.slice(0, 16),
          salt,
          hashToken(salt, token),
          now,
          expiresAt,
        ],
      );
    });
    const row = result.rows[0];
    if (!row) throw new Error("ADMIN_ACCESS_TOKEN_CREATE_FAILED");
    return { token, accessToken: summarize(row) };
  }

  async list(): Promise<readonly AdminAccessTokenSummary[]> {
    const result = await this.pool.query<TokenRow>(
      `SELECT id,name,scopes,created_by,created_at,expires_at,revoked_at,last_used_at
         FROM admin_access_tokens ORDER BY created_at DESC,id LIMIT $1`,
      [this.quotas.listLimit],
    );
    return result.rows.map(summarize);
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE admin_access_tokens SET revoked_at=COALESCE(revoked_at,$2)
        WHERE id=$1 AND revoked_at IS NULL`,
      [id, this.now()],
    );
    return result.rowCount === 1;
  }

  async authenticate(
    token: string,
    route: string,
  ): Promise<AdminAccessTokenCredential | undefined> {
    if (!tokenPattern.test(token)) return undefined;
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<
        TokenRow & { readonly token_salt: Buffer; readonly token_hash: Buffer }
      >(
        `SELECT id,name,scopes,created_by,created_at,expires_at,revoked_at,last_used_at,
                token_salt,token_hash
           FROM admin_access_tokens WHERE token_prefix=$1`,
        [token.slice(0, 16)],
      );
      const row = result.rows.find((candidate) =>
        safeEqual(candidate.token_hash, hashToken(candidate.token_salt, token)),
      );
      if (!row) return undefined;
      const now = this.now();
      const usable = row.revoked_at === null && new Date(row.expires_at) > now;
      const auditId = randomUUID();
      if (!usable) {
        await client.query(
          `INSERT INTO admin_access_token_audits(audit_id,token_id,creator_user_id,route,result)
           VALUES($1,$2,$3,$4,'credential_rejected')`,
          [auditId, row.id, row.created_by, route.slice(0, 512)],
        );
      }
      if (usable) {
        await client.query(
          `UPDATE admin_access_tokens
              SET last_used_at=$2::timestamptz,last_use_audited_at=$2::timestamptz
            WHERE id=$1 AND (last_use_audited_at IS NULL OR
              last_use_audited_at < $2::timestamptz - interval '5 minutes')`,
          [row.id, now],
        );
      }
      if (!usable) return undefined;
      return {
        id: row.id,
        creatorUserId: row.created_by,
        scopes: row.scopes,
        auditId,
        route: route.slice(0, 512),
      };
    });
  }

  async finishUse(credential: AdminAccessTokenCredential, scopeAllowed: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_access_token_audits(audit_id,token_id,creator_user_id,route,result)
       VALUES($1,$2,$3,$4,$5)`,
      [
        credential.auditId,
        credential.id,
        credential.creatorUserId,
        credential.route,
        scopeAllowed ? "scope_allowed" : "scope_denied",
      ],
    );
  }
}

export function isAdminAccessToken(value: string): boolean {
  return tokenPattern.test(value);
}

function hashToken(salt: Uint8Array, token: string): Buffer {
  return createHash("sha256").update(salt).update(token, "utf8").digest();
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function summarize(row: TokenRow): AdminAccessTokenSummary {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  };
}
