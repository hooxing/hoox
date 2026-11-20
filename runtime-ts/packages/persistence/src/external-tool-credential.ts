import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface EncryptedExternalToolCredential {
  readonly version: 1;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

/** 外部工具密文按用途单独派生，并将不可变工具版本绑定进 GCM AAD。 */
export class ExternalToolCredentialCipher {
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
  encrypt(toolVersionId: string, credential: string): EncryptedExternalToolCredential {
    if (Buffer.byteLength(credential, "utf8") < 1 || Buffer.byteLength(credential, "utf8") > 8192)
      throw new TypeError("EXTERNAL_TOOL_CREDENTIAL_INVALID");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`external-tool:v1:${toolVersionId}`));
    const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
    return Object.freeze({
      version: 1,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    });
  }
}
