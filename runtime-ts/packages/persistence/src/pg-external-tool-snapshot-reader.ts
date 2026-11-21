import type { ExternalToolVersion } from "@hoox/domain";
import type { ExternalToolRuntimeSnapshot, ExternalToolSnapshotReader } from "@hoox/run-contracts";
import type { Pool } from "pg";
import type { ExternalToolCredentialDecryptor } from "./external-tool-credential-reader.js";
import { withTenantTransaction } from "./postgres.js";

interface SnapshotRow {
  readonly tool_version_id: string;
  readonly source: "mcp" | "http";
  readonly endpoint: string;
  readonly model_tool_name: string;
  readonly remote_tool_name: string | null;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
  readonly input_schema_digest: string;
  readonly timeout_ms: number;
  readonly max_response_bytes: number;
  readonly side_effect: "read_only" | "write" | "destructive";
  readonly idempotent: boolean;
  readonly credential_ref: string | null;
  readonly credential_configured: boolean;
  readonly http_method: "GET" | "POST" | null;
  readonly cipher_version: number | null;
  readonly nonce: string | null;
  readonly ciphertext: string | null;
  readonly auth_tag: string | null;
}

/** 只查询由受限视图按 Tenant/Run 快照授权的版本；凭据仅在此 Worker 进程内解密。 */
export class PgExternalToolSnapshotReader implements ExternalToolSnapshotReader {
  constructor(
    private readonly pool: Pool,
    private readonly credentialDecryptor: ExternalToolCredentialDecryptor,
  ) {}

  async read(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly toolVersionIds: readonly string[];
  }): Promise<readonly ExternalToolRuntimeSnapshot[]> {
    const requested = [...new Set(input.toolVersionIds)].sort();
    if (requested.length !== input.toolVersionIds.length)
      throw new Error("EXTERNAL_TOOL_SNAPSHOT_INVALID");
    if (requested.length === 0) return Object.freeze([]);
    return withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      async (client) => {
        await client.query("SELECT set_config('app.external_tool_run_id',$1,true)", [input.runId]);
        const result = await client.query<SnapshotRow>(
          `SELECT tool_version_id,source,endpoint,model_tool_name,remote_tool_name,description,
                input_schema,input_schema_digest,timeout_ms,max_response_bytes,side_effect,
                idempotent,credential_ref,credential_configured,http_method,cipher_version,nonce,ciphertext,auth_tag
           FROM runtime_run_external_tool_snapshots
          WHERE tenant_id=$1 AND run_id=$2 AND tool_version_id=ANY($3::text[])
          ORDER BY model_tool_name COLLATE "C",tool_version_id COLLATE "C"`,
          [input.tenantId, input.runId, requested],
        );
        if (result.rows.length !== requested.length)
          throw new Error("EXTERNAL_TOOL_SNAPSHOT_UNAVAILABLE");
        const snapshots = result.rows.map((row): ExternalToolRuntimeSnapshot => {
          if (row.source === "http" && row.http_method === null)
            throw new Error("EXTERNAL_TOOL_HTTP_METHOD_UNAVAILABLE");
          if (row.source === "mcp" && row.http_method !== null)
            throw new Error("EXTERNAL_TOOL_SNAPSHOT_INVALID");
          const tool: ExternalToolVersion = Object.freeze({
            toolVersionId: row.tool_version_id,
            source: row.source,
            endpoint: row.endpoint,
            modelToolName: row.model_tool_name,
            remoteToolName: row.remote_tool_name,
            ...(row.http_method === null ? {} : { httpMethod: row.http_method }),
            description: row.description,
            inputSchema: row.input_schema,
            inputSchemaDigest: row.input_schema_digest,
            timeoutMs: row.timeout_ms,
            maxResponseBytes: row.max_response_bytes,
            sideEffect: row.side_effect,
            idempotent: row.idempotent,
            credentialRef: row.credential_ref,
          });
          const encryptedParts = [row.cipher_version, row.nonce, row.ciphertext, row.auth_tag];
          const hasCiphertext = encryptedParts.every((part) => part !== null);
          if (
            (row.credential_configured && !hasCiphertext) ||
            (!row.credential_configured && encryptedParts.some((part) => part !== null))
          )
            throw new Error("EXTERNAL_TOOL_CREDENTIAL_CIPHERTEXT_INVALID");
          return Object.freeze({
            tool,
            ...(hasCiphertext
              ? {
                  credential: this.credentialDecryptor.decrypt(row.tool_version_id, {
                    version: row.cipher_version as 1,
                    nonce: row.nonce as string,
                    ciphertext: row.ciphertext as string,
                    authTag: row.auth_tag as string,
                  }),
                }
              : {}),
          });
        });
        return Object.freeze(snapshots);
      },
      { readOnly: true },
    );
  }
}
