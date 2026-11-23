import { randomUUID } from "node:crypto";
import type {
  EncryptedIdentitySecrets,
  IdentityConfiguration,
  IdentityConfigurationSecrets,
} from "@hoox/identity";
import {
  decryptIdentitySecrets,
  encryptIdentitySecrets,
  hydrateIdentityConfiguration,
} from "@hoox/identity";
import type { Pool, QueryResultRow } from "pg";
import { mapPersistenceError } from "./errors.js";
import { withTransaction } from "./postgres.js";

interface IdentityConfigurationRow extends QueryResultRow {
  readonly version_token: string;
  readonly configuration: unknown;
  readonly secrets_ciphertext: Buffer;
  readonly secrets_nonce: Buffer;
  readonly secrets_tag: Buffer;
  readonly updated_by: string;
  readonly updated_at: Date | string;
}

export interface PersistedIdentityConfiguration {
  readonly configuration: IdentityConfiguration;
  readonly secrets: IdentityConfigurationSecrets;
}

export interface IdentityConfigurationRepository {
  read(secret: string, actorUserId?: string): Promise<PersistedIdentityConfiguration | undefined>;
  save(input: {
    readonly actorUserId: string;
    readonly expectedVersionToken: number;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly reason: string;
    readonly configuration: IdentityConfiguration;
    readonly secrets: IdentityConfigurationSecrets;
    readonly secret: string;
  }): Promise<"saved" | "conflict" | "replayed">;
}

function configurationFromRow(row: IdentityConfigurationRow, secret: string) {
  const raw = row.configuration;
  if (typeof raw !== "object" || raw === null) throw new Error("IDENTITY_CONFIGURATION_INVALID");
  const value = hydrateIdentityConfiguration(
    raw as Partial<Omit<IdentityConfiguration, "updatedAt" | "updatedBy">>,
  );
  const versionToken = Number(row.version_token);
  if (
    !Number.isSafeInteger(versionToken) ||
    versionToken < 1 ||
    value.versionToken !== versionToken
  ) {
    throw new Error("IDENTITY_CONFIGURATION_VERSION_INVALID");
  }
  return Object.freeze({
    configuration: Object.freeze({
      ...value,
      updatedBy: row.updated_by,
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : new Date(row.updated_at).toISOString(),
    }),
    secrets: decryptIdentitySecrets(secret, {
      ciphertext: row.secrets_ciphertext,
      nonce: row.secrets_nonce,
      tag: row.secrets_tag,
    }),
  });
}

export class PgIdentityConfigurationRepository implements IdentityConfigurationRepository {
  constructor(private readonly pool: Pool) {}

  async read(
    secret: string,
    actorUserId?: string,
  ): Promise<PersistedIdentityConfiguration | undefined> {
    try {
      return await withTransaction(
        this.pool,
        async (client) => {
          if (actorUserId !== undefined) {
            await client.query("SELECT set_config('app.user_id',$1,true)", [actorUserId]);
          }
          const result = await client.query<IdentityConfigurationRow>(
            `SELECT version_token::text,configuration,secrets_ciphertext,secrets_nonce,secrets_tag,
                    updated_by,updated_at
               FROM identity_auth_configuration WHERE singleton='global'`,
          );
          const row = result.rows[0];
          return row === undefined ? undefined : configurationFromRow(row, secret);
        },
        { readOnly: true },
      );
    } catch (error) {
      throw mapPersistenceError(error, "读取身份配置");
    }
  }

  async save(input: {
    readonly actorUserId: string;
    readonly expectedVersionToken: number;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly reason: string;
    readonly configuration: IdentityConfiguration;
    readonly secrets: IdentityConfigurationSecrets;
    readonly secret: string;
  }): Promise<"saved" | "conflict" | "replayed"> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await client.query("SELECT set_config('app.user_id',$1,true)", [input.actorUserId]);
        const command = await client.query<{ readonly request_digest: string }>(
          `SELECT request_digest FROM identity_auth_commands
            WHERE actor_user_id=$1 AND idempotency_key=$2`,
          [input.actorUserId, input.idempotencyKey],
        );
        const existingCommand = command.rows[0];
        if (existingCommand !== undefined) {
          return existingCommand.request_digest === input.requestDigest ? "replayed" : "conflict";
        }
        const encrypted: EncryptedIdentitySecrets = encryptIdentitySecrets(
          input.secret,
          input.secrets,
        );
        const result = await client.query(
          `INSERT INTO identity_auth_configuration(
             singleton,version_token,configuration,secrets_ciphertext,secrets_nonce,secrets_tag,
             updated_by,updated_at
           ) VALUES('global',$1,$2,$3,$4,$5,$6,clock_timestamp())
           ON CONFLICT(singleton) DO UPDATE SET
             version_token=EXCLUDED.version_token,configuration=EXCLUDED.configuration,
             secrets_ciphertext=EXCLUDED.secrets_ciphertext,secrets_nonce=EXCLUDED.secrets_nonce,
             secrets_tag=EXCLUDED.secrets_tag,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
           WHERE identity_auth_configuration.version_token=$7`,
          [
            input.configuration.versionToken,
            JSON.stringify(input.configuration),
            Buffer.from(encrypted.ciphertext),
            Buffer.from(encrypted.nonce),
            Buffer.from(encrypted.tag),
            input.actorUserId,
            input.expectedVersionToken,
          ],
        );
        if (result.rowCount !== 1) return "conflict" as const;
        await client.query(
          `INSERT INTO identity_auth_audits(
             audit_id,actor_user_id,previous_version_token,version_token,reason
           ) VALUES($1,$2,$3,$4,$5)`,
          [
            `identity_audit_${randomUUID()}`,
            input.actorUserId,
            input.expectedVersionToken,
            input.configuration.versionToken,
            input.reason,
          ],
        );
        await client.query(
          `INSERT INTO identity_auth_commands(actor_user_id,idempotency_key,request_digest,response)
           VALUES($1,$2,$3,$4)`,
          [
            input.actorUserId,
            input.idempotencyKey,
            input.requestDigest,
            JSON.stringify({ versionToken: input.configuration.versionToken }),
          ],
        );
        return "saved" as const;
      });
    } catch (error) {
      throw mapPersistenceError(error, "保存身份配置");
    }
  }
}
