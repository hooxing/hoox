import type { ExternalToolVersion } from "@hoox/domain";
import type { PoolClient } from "pg";
import type { ExternalToolCredentialCipher } from "./external-tool-credential.js";

/** Agent 引用校验持共享锁，所有撤销入口持排他锁，直至相应事务提交。 */
export const EXTERNAL_TOOL_REVOCATION_LOCK = "external-tool-revocation";

/** 调用方拥有事务；版本与绑定版本 ID 重新加密的凭据不可分开提交。 */
export async function insertExternalToolVersion(
  client: PoolClient,
  actorUserId: string,
  tool: ExternalToolVersion,
  credential: string | undefined,
  cipher: ExternalToolCredentialCipher,
): Promise<void> {
  await client.query(
    `INSERT INTO external_tool_versions(tool_version_id,source,endpoint,model_tool_name,remote_tool_name,description,input_schema,input_schema_digest,timeout_ms,max_response_bytes,side_effect,idempotent,credential_ref,credential_configured,published_by)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      tool.toolVersionId,
      tool.source,
      tool.endpoint,
      tool.modelToolName,
      tool.remoteToolName ?? null,
      tool.description,
      JSON.stringify(tool.inputSchema),
      tool.inputSchemaDigest,
      tool.timeoutMs,
      tool.maxResponseBytes,
      tool.sideEffect,
      tool.idempotent,
      tool.credentialRef,
      credential !== undefined,
      actorUserId,
    ],
  );
  if (credential !== undefined) {
    const encrypted = cipher.encrypt(tool.toolVersionId, credential);
    await client.query(
      `INSERT INTO external_tool_credentials(tool_version_id,cipher_version,nonce,ciphertext,auth_tag) VALUES($1,$2,$3,$4,$5)`,
      [
        tool.toolVersionId,
        encrypted.version,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
      ],
    );
  }
}
