import {
  insertExternalToolVersion,
  EXTERNAL_TOOL_REVOCATION_LOCK,
} from "./external-tool-version-write.js";
import type { Pool, PoolClient } from "pg";
import type { ExternalToolVersion } from "@hoox/domain";
import { validateExternalToolVersion } from "@hoox/domain";
import { withTransaction } from "./postgres.js";
import type { ExternalToolCredentialCipher } from "./external-tool-credential.js";

export interface ExternalToolAdminProjection extends Omit<ExternalToolVersion, "credentialRef"> {
  readonly credentialRef: string | null;
  readonly credentialConfigured: boolean;
  readonly revoked: boolean;
}

async function withAdminUser<T>(
  pool: Pool,
  userId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    return run(client);
  });
}

/** 控制面仅写凭据并只投影 configured；不存在返回密文或明文的管理查询。 */
export class PgExternalToolRegistry {
  private readonly pool: Pool;
  private readonly cipher: ExternalToolCredentialCipher;

  constructor(pool: Pool, cipher: ExternalToolCredentialCipher) {
    this.pool = pool;
    this.cipher = cipher;
  }

  async publish(input: {
    readonly actorUserId: string;
    readonly tool: ExternalToolVersion;
    readonly credential?: string;
  }): Promise<void> {
    const tool = validateExternalToolVersion(input.tool);
    await withAdminUser(this.pool, input.actorUserId, async (client) => {
      await insertExternalToolVersion(
        client,
        input.actorUserId,
        tool,
        input.credential,
        this.cipher,
      );
    });
  }

  async revoke(input: {
    readonly actorUserId: string;
    readonly toolVersionId: string;
    readonly reason: string;
  }): Promise<void> {
    if (!input.reason.trim() || Buffer.byteLength(input.reason) > 1000)
      throw new TypeError("EXTERNAL_TOOL_REVOCATION_INVALID");
    await withAdminUser(this.pool, input.actorUserId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [
        EXTERNAL_TOOL_REVOCATION_LOCK,
      ]);
      await client.query(
        "INSERT INTO external_tool_revocations(tool_version_id,reason,actor_user_id) VALUES($1,$2,$3)",
        [input.toolVersionId, input.reason, input.actorUserId],
      );
    });
  }

  async getAdminProjection(input: {
    readonly actorUserId: string;
    readonly toolVersionId: string;
  }): Promise<ExternalToolAdminProjection | undefined> {
    return withAdminUser(this.pool, input.actorUserId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT version.tool_version_id,version.source,version.endpoint,version.model_tool_name,version.remote_tool_name,version.description,version.input_schema,version.input_schema_digest,version.timeout_ms,version.max_response_bytes,version.side_effect,version.idempotent,version.credential_ref,version.credential_configured,
                EXISTS(SELECT 1 FROM external_tool_revocations revoked WHERE revoked.tool_version_id=version.tool_version_id) AS revoked
           FROM external_tool_versions version WHERE version.tool_version_id=$1`,
        [input.toolVersionId],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return Object.freeze({
        toolVersionId: row.tool_version_id as string,
        source: row.source as ExternalToolVersion["source"],
        endpoint: row.endpoint as string,
        modelToolName: row.model_tool_name as string,
        remoteToolName: row.remote_tool_name as string | null,
        description: row.description as string,
        inputSchema: row.input_schema as ExternalToolVersion["inputSchema"],
        inputSchemaDigest: row.input_schema_digest as string,
        timeoutMs: row.timeout_ms as number,
        maxResponseBytes: row.max_response_bytes as number,
        sideEffect: row.side_effect as ExternalToolVersion["sideEffect"],
        idempotent: row.idempotent as boolean,
        credentialRef: row.credential_ref as string | null,
        credentialConfigured: row.credential_configured as boolean,
        revoked: row.revoked as boolean,
      });
    });
  }
}
