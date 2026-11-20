import { createDecipheriv, hkdfSync } from "node:crypto";
import type { EncryptedExternalToolCredential } from "./external-tool-credential.js";

/** 此能力仅从 run-execution 子入口导出，调用方必须先通过 Run 快照授权版本读取。 */
export class ExternalToolCredentialDecryptor {
  private readonly key: Buffer;
  constructor(rootSecret: string) {
    if (Buffer.byteLength(rootSecret, "utf8") < 32)
      throw new TypeError("EXTERNAL_TOOL_CREDENTIAL_KEY_TOO_SHORT");
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(rootSecret),
        Buffer.from("hoox-external-tool-credential"),
        Buffer.from("aes-256-gcm-v1"),
        32,
      ),
    );
  }
  decrypt(toolVersionId: string, encrypted: EncryptedExternalToolCredential): string {
    if (encrypted.version !== 1) throw new Error("EXTERNAL_TOOL_CREDENTIAL_VERSION_UNSUPPORTED");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(encrypted.nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(`external-tool:v1:${toolVersionId}`));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
