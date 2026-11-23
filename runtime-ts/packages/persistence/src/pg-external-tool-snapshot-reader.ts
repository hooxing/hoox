import type { ExternalToolVersion } from "@hoox/domain";
import {
  type ExternalToolRuntimeSnapshot,
  ExternalToolSnapshotError,
  type ExternalToolSnapshotReader,
} from "@hoox/run-contracts";
import type { Pool } from "pg";
import type { ExternalToolCredentialDecryptor } from "./external-tool-credential-reader.js";
import { withTenantTransaction } from "./postgres.js";

interface SnapshotRow {
  readonly tool_version_id: string;
  readonly revoked: boolean;
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

/** 专用连接提交双栅栏证明，凭据仅在 Worker 内解密。 */
export class PgExternalToolSnapshotReader implements ExternalToolSnapshotReader {
  constructor(
    private readonly pool: Pool,
    private readonly credentialDecryptor: Pick<ExternalToolCredentialDecryptor, "decrypt">,
  ) {}

  async read(
    input: Parameters<ExternalToolSnapshotReader["read"]>[0],
  ): Promise<readonly ExternalToolRuntimeSnapshot[]> {
    const requested = [...new Set(input.toolVersionIds)].sort();
    if (requested.length !== input.toolVersionIds.length)
      throw new ExternalToolSnapshotError("EXTERNAL_TOOL_SNAPSHOT_INVALID");
    if (requested.length === 0) return Object.freeze([]);
    const { scope, runClaim, workspaceLease } = input.fence;
    if (workspaceLease.rootRunId !== scope.rootRunId)
      throw new ExternalToolSnapshotError("EXTERNAL_TOOL_SNAPSHOT_INVALID");
    return withTenantTransaction(
      this.pool,
      { tenantId: scope.tenantId },
      async (client) => {
        await client.query(
          `SELECT set_config('app.external_claim_token',$1,true),
                  set_config('app.external_claim_epoch',$2,true),
                  set_config('app.external_lease_epoch',$3,true)`,
          [runClaim.token, String(runClaim.epoch), String(workspaceLease.epoch)],
        );
        const result = await client.query<SnapshotRow>(
          `SELECT tool_version_id,revoked,source,endpoint,model_tool_name,remote_tool_name,description,
                input_schema,input_schema_digest,timeout_ms,max_response_bytes,side_effect,
                idempotent,credential_ref,credential_configured,http_method,cipher_version,nonce,ciphertext,auth_tag
           FROM worker_run_external_tool_snapshots
          WHERE tenant_id=$1 AND run_id=$2 AND tool_version_id=ANY($3::text[])
            AND thread_id=$4 AND root_run_id=$5 AND workspace_id=$6 AND base_revision_id IS NOT DISTINCT FROM $7
          ORDER BY model_tool_name COLLATE "C",tool_version_id COLLATE "C"`,
          [
            scope.tenantId,
            scope.runId,
            requested,
            scope.threadId,
            scope.rootRunId,
            scope.workspaceId,
            scope.baseRevisionId ?? null,
          ],
        );
        if (result.rows.length !== requested.length)
          throw new ExternalToolSnapshotError("EXTERNAL_TOOL_SNAPSHOT_INVALID");
        if (result.rows.some((row) => row.revoked))
          throw new ExternalToolSnapshotError("EXTERNAL_TOOL_REVOKED");
        try {
          const snapshots = result.rows.map((row): ExternalToolRuntimeSnapshot => {
            if (row.source === "http" && row.http_method === null)
              throw new Error("EXTERNAL_TOOL_HTTP_METHOD_UNAVAILABLE");
            if (row.source === "mcp" && row.http_method !== null)
              throw new ExternalToolSnapshotError("EXTERNAL_TOOL_SNAPSHOT_INVALID");
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
        } catch {
          throw new ExternalToolSnapshotError("EXTERNAL_TOOL_SNAPSHOT_INVALID");
        }
      },
      { readOnly: true },
    ).catch((error: unknown) => {
      if (error instanceof ExternalToolSnapshotError) throw error;
      throw new ExternalToolSnapshotError("EXTERNAL_TOOL_SNAPSHOT_UNAVAILABLE");
    });
  }
}
