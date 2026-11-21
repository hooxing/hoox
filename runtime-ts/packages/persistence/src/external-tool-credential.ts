import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

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

/**
 * 注册草稿凭据只在 Admin Control 进程内加解密：用于发布前探测，以及发布时按不可变版本重新加密。
 * 与版本密文使用不同 HKDF 用途与 AAD，草稿密文不能被搬用为任何版本的凭据。
 */
export class ExternalToolDraftCredentialCipher {
  private readonly key: Buffer;
  private readonly fingerprintKey: Buffer;
  constructor(rootSecret: string) {
    if (Buffer.byteLength(rootSecret, "utf8") < 32)
      throw new TypeError("EXTERNAL_TOOL_CREDENTIAL_KEY_TOO_SHORT");
    const derive = (info: string) =>
      Buffer.from(
        hkdfSync(
          "sha256",
          Buffer.from(rootSecret),
          Buffer.from("hoox-external-tool-draft-credential"),
          Buffer.from(info),
          32,
        ),
      );
    this.key = derive("aes-256-gcm-v1");
    this.fingerprintKey = derive("idempotency-fingerprint-v1");
  }
  encrypt(draftId: string, credential: string): EncryptedExternalToolCredential {
    if (Buffer.byteLength(credential, "utf8") < 1 || Buffer.byteLength(credential, "utf8") > 8192)
      throw new TypeError("EXTERNAL_TOOL_CREDENTIAL_INVALID");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`external-tool-draft:v1:${draftId}`));
    const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
    return Object.freeze({
      version: 1,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    });
  }
  decrypt(draftId: string, encrypted: EncryptedExternalToolCredential): string {
    if (encrypted.version !== 1) throw new Error("EXTERNAL_TOOL_CREDENTIAL_VERSION_UNSUPPORTED");
    const nonce = Buffer.from(encrypted.nonce, "base64url");
    const authTag = Buffer.from(encrypted.authTag, "base64url");
    if (nonce.byteLength !== 12 || authTag.byteLength !== 16)
      throw new Error("EXTERNAL_TOOL_CREDENTIAL_CIPHERTEXT_INVALID");
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`external-tool-draft:v1:${draftId}`));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
  /** 幂等请求摘要只保存带密钥的指纹，避免低熵凭据可被离线猜测。 */
  fingerprint(draftId: string, credential: string): string {
    return createHmac("sha256", this.fingerprintKey)
      .update(`${draftId}\u0000${credential}`)
      .digest("hex");
  }
}
