import type { Pool, PoolClient } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTenantTransaction, withTransaction } from "./postgres.js";

export type LocalAccountProfileRecord = {
  readonly userId: string;
  readonly personalTenantId: string;
  readonly email: string;
  readonly displayName: string;
};

export type LocalAccountPasswordRecord = LocalAccountProfileRecord & {
  readonly passwordAlgorithm: "scrypt-v1";
  readonly passwordSalt: Uint8Array;
  readonly passwordHash: Uint8Array;
};

export interface BetterAuthIdentityExchangeInput extends LocalAccountProfileRecord {
  readonly betterAuthUserId: string;
  readonly membershipId: string;
  readonly sessionTokenDigest: string;
  readonly createdAt: string;
  readonly sessionExpiresAt: string;
}

export interface RegisterLocalAccountInput extends LocalAccountPasswordRecord {
  readonly membershipId: string;
  readonly sessionTokenDigest: string;
  readonly createdAt: string;
  readonly sessionExpiresAt: string;
}

export interface LocalAccountRepository {
  register(input: RegisterLocalAccountInput): Promise<"created" | "conflict">;
  exchangeBetterAuthIdentity(
    input: BetterAuthIdentityExchangeInput,
  ): Promise<LocalAccountProfileRecord | "disabled" | "conflict">;
  findByNormalizedEmail(normalizedEmail: string): Promise<LocalAccountPasswordRecord | undefined>;
  createSession(input: {
    readonly tokenDigest: string;
    readonly userId: string;
    readonly personalTenantId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<void>;
  resolveSession(tokenDigest: string, now: string): Promise<LocalAccountProfileRecord | undefined>;
  findProfileByUserId(
    userId: string,
    personalTenantId: string,
  ): Promise<LocalAccountProfileRecord | undefined>;
  revokeSession(tokenDigest: string): Promise<void>;
}

type AccountRow = {
  readonly user_id: string;
  readonly personal_tenant_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly password_algorithm?: string | null;
  readonly password_salt?: Buffer | null;
  readonly password_hash?: Buffer | null;
  readonly better_auth_user_id?: string | null;
  readonly status?: "active" | "disabled";
};

function profile(row: AccountRow): LocalAccountProfileRecord {
  return {
    userId: row.user_id,
    personalTenantId: row.personal_tenant_id,
    email: row.email,
    displayName: row.display_name,
  };
}

function passwordRecord(row: AccountRow): LocalAccountPasswordRecord {
  if (
    row.password_algorithm !== "scrypt-v1" ||
    row.password_salt === undefined ||
    row.password_salt === null ||
    row.password_hash === undefined ||
    row.password_hash === null
  ) {
    throw new Error("LOCAL_ACCOUNT_PASSWORD_RECORD_INVALID");
  }
  return {
    ...profile(row),
    passwordAlgorithm: "scrypt-v1",
    passwordSalt: new Uint8Array(row.password_salt),
    passwordHash: new Uint8Array(row.password_hash),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

async function setAuthenticationCandidate(
  client: PoolClient,
  name: "app.auth_email" | "app.auth_session_digest" | "app.auth_better_auth_user_id",
  value: string,
): Promise<void> {
  await client.query("SELECT set_config($1, $2, true)", [name, value]);
}

export class PgLocalAccountRepository implements LocalAccountRepository {
  constructor(private readonly pool: Pool) {}

  async register(input: RegisterLocalAccountInput): Promise<"created" | "conflict"> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: input.personalTenantId, userId: input.userId },
        async (client) => {
          await client.query("INSERT INTO app_users(id,created_at) VALUES ($1,$2)", [
            input.userId,
            input.createdAt,
          ]);
          await client.query(
            `INSERT INTO tenants(id,kind,owner_user_id,created_at)
             VALUES ($1,'personal',$2,$3)`,
            [input.personalTenantId, input.userId, input.createdAt],
          );
          await client.query(
            `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
             VALUES ($1,$2,$3,'owner','active',$4)`,
            [input.personalTenantId, input.membershipId, input.userId, input.createdAt],
          );
          await client.query(
            `INSERT INTO user_accounts(
               user_id,personal_tenant_id,email,normalized_email,display_name,
               password_algorithm,password_salt,password_hash,created_at,updated_at
             ) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$8)`,
            [
              input.userId,
              input.personalTenantId,
              input.email,
              input.displayName,
              input.passwordAlgorithm,
              Buffer.from(input.passwordSalt),
              Buffer.from(input.passwordHash),
              input.createdAt,
            ],
          );
          await client.query(
            `INSERT INTO user_sessions(
               token_digest,user_id,personal_tenant_id,created_at,expires_at
             ) VALUES ($1,$2,$3,$4,$5)`,
            [
              input.sessionTokenDigest,
              input.userId,
              input.personalTenantId,
              input.createdAt,
              input.sessionExpiresAt,
            ],
          );
          return "created" as const;
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) return "conflict";
      throw mapPersistenceError(error, "注册本地账号");
    }
  }

  async exchangeBetterAuthIdentity(
    input: BetterAuthIdentityExchangeInput,
  ): Promise<LocalAccountProfileRecord | "disabled" | "conflict"> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await setAuthenticationCandidate(client, "app.auth_email", input.email);
        await setAuthenticationCandidate(
          client,
          "app.auth_better_auth_user_id",
          input.betterAuthUserId,
        );
        const existing = await client.query<AccountRow>(
          `SELECT user_id,personal_tenant_id,email,display_name,better_auth_user_id,status
             FROM user_accounts
            WHERE normalized_email=$1 OR better_auth_user_id=$2
            ORDER BY (better_auth_user_id=$2) DESC
            LIMIT 1`,
          [input.email, input.betterAuthUserId],
        );
        const row = existing.rows[0];
        if (row !== undefined) {
          if (row.status === "disabled") return "disabled" as const;
          if (
            row.better_auth_user_id !== null &&
            row.better_auth_user_id !== undefined &&
            row.better_auth_user_id !== input.betterAuthUserId
          ) {
            return "conflict" as const;
          }
          await client.query("SELECT set_config('app.user_id',$1,true)", [row.user_id]);
          await client.query("SELECT set_config('app.tenant_id',$1,true)", [
            row.personal_tenant_id,
          ]);
          await client.query(
            `UPDATE user_accounts
                SET better_auth_user_id=$3,display_name=$4,updated_at=$5
              WHERE user_id=$1 AND personal_tenant_id=$2`,
            [
              row.user_id,
              row.personal_tenant_id,
              input.betterAuthUserId,
              input.displayName,
              input.createdAt,
            ],
          );
          await client.query(
            `INSERT INTO user_sessions(token_digest,user_id,personal_tenant_id,created_at,expires_at)
             VALUES($1,$2,$3,$4,$5)`,
            [
              input.sessionTokenDigest,
              row.user_id,
              row.personal_tenant_id,
              input.createdAt,
              input.sessionExpiresAt,
            ],
          );
          return profile({ ...row, display_name: input.displayName });
        }
        await client.query("SELECT set_config('app.user_id',$1,true)", [input.userId]);
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [input.personalTenantId]);
        await client.query("INSERT INTO app_users(id,created_at) VALUES($1,$2)", [
          input.userId,
          input.createdAt,
        ]);
        await client.query(
          `INSERT INTO tenants(id,kind,owner_user_id,created_at) VALUES($1,'personal',$2,$3)`,
          [input.personalTenantId, input.userId, input.createdAt],
        );
        await client.query(
          `INSERT INTO memberships(tenant_id,id,user_id,role,status,created_at)
           VALUES($1,$2,$3,'owner','active',$4)`,
          [input.personalTenantId, input.membershipId, input.userId, input.createdAt],
        );
        await client.query(
          `INSERT INTO user_accounts(
             user_id,personal_tenant_id,email,normalized_email,display_name,better_auth_user_id,
             password_algorithm,password_salt,password_hash,created_at,updated_at
           ) VALUES($1,$2,$3,$3,$4,$5,NULL,NULL,NULL,$6,$6)`,
          [
            input.userId,
            input.personalTenantId,
            input.email,
            input.displayName,
            input.betterAuthUserId,
            input.createdAt,
          ],
        );
        await client.query(
          `INSERT INTO user_sessions(token_digest,user_id,personal_tenant_id,created_at,expires_at)
           VALUES($1,$2,$3,$4,$5)`,
          [
            input.sessionTokenDigest,
            input.userId,
            input.personalTenantId,
            input.createdAt,
            input.sessionExpiresAt,
          ],
        );
        return profile({
          user_id: input.userId,
          personal_tenant_id: input.personalTenantId,
          email: input.email,
          display_name: input.displayName,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return "conflict";
      throw mapPersistenceError(error, "交换 Better Auth 身份");
    }
  }
  async findByNormalizedEmail(
    normalizedEmail: string,
  ): Promise<LocalAccountPasswordRecord | undefined> {
    try {
      return await withTransaction(
        this.pool,
        async (client) => {
          await setAuthenticationCandidate(client, "app.auth_email", normalizedEmail);
          const result = await client.query<AccountRow>(
            `SELECT user_id,personal_tenant_id,email,display_name,
                    password_algorithm,password_salt,password_hash
               FROM user_accounts WHERE normalized_email=$1 AND status='active'`,
            [normalizedEmail],
          );
          const row = result.rows[0];
          return row === undefined || row.password_algorithm === null
            ? undefined
            : passwordRecord(row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取本地账号");
    }
  }

  async createSession(input: {
    readonly tokenDigest: string;
    readonly userId: string;
    readonly personalTenantId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<void> {
    try {
      await withTenantTransaction(
        this.pool,
        { tenantId: input.personalTenantId, userId: input.userId },
        async (client) => {
          // node-postgres 的参数化查询禁止一条 prepared statement 携带多个命令；
          // 清理与签发仍处于同一事务，但必须分别发送。
          await client.query("DELETE FROM user_sessions WHERE user_id=$1 AND expires_at <= $2", [
            input.userId,
            input.createdAt,
          ]);
          await client.query(
            `INSERT INTO user_sessions(
               token_digest,user_id,personal_tenant_id,created_at,expires_at
             ) VALUES ($1,$2,$3,$4,$5)`,
            [
              input.tokenDigest,
              input.userId,
              input.personalTenantId,
              input.createdAt,
              input.expiresAt,
            ],
          );
        },
      );
    } catch (error) {
      throw mapPersistenceError(error, "创建本地账号会话");
    }
  }

  async resolveSession(
    tokenDigest: string,
    now: string,
  ): Promise<LocalAccountProfileRecord | undefined> {
    try {
      return await withTransaction(
        this.pool,
        async (client) => {
          await setAuthenticationCandidate(client, "app.auth_session_digest", tokenDigest);
          const session = await client.query<{
            readonly user_id: string;
            readonly personal_tenant_id: string;
          }>(
            `SELECT user_id,personal_tenant_id FROM user_sessions
              WHERE token_digest=$1 AND expires_at>$2`,
            [tokenDigest, now],
          );
          const active = session.rows[0];
          if (active === undefined) return undefined;
          await client.query(
            "SELECT set_config('app.user_id',$1,true),set_config('app.tenant_id',$2,true)",
            [active.user_id, active.personal_tenant_id],
          );
          const account = await client.query<AccountRow>(
            `SELECT user_id,personal_tenant_id,email,display_name
               FROM user_accounts
              WHERE user_id=$1 AND personal_tenant_id=$2 AND status='active'`,
            [active.user_id, active.personal_tenant_id],
          );
          const row = account.rows[0];
          return row === undefined ? undefined : profile(row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "解析本地账号会话");
    }
  }

  async findProfileByUserId(
    userId: string,
    personalTenantId: string,
  ): Promise<LocalAccountProfileRecord | undefined> {
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: personalTenantId, userId },
        async (client) => {
          const result = await client.query<AccountRow>(
            `SELECT user_id,personal_tenant_id,email,display_name
               FROM user_accounts
              WHERE user_id=$1 AND personal_tenant_id=$2 AND status='active'`,
            [userId, personalTenantId],
          );
          const row = result.rows[0];
          return row === undefined ? undefined : profile(row);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取本地账号资料");
    }
  }

  async revokeSession(tokenDigest: string): Promise<void> {
    try {
      await withTransaction(this.pool, async (client) => {
        await setAuthenticationCandidate(client, "app.auth_session_digest", tokenDigest);
        await client.query("DELETE FROM user_sessions WHERE token_digest=$1", [tokenDigest]);
      });
    } catch (error) {
      throw mapPersistenceError(error, "注销本地账号会话");
    }
  }
}
