import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export interface EncryptedModelProviderCredential {
  readonly version: 1;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

const encoding = "base64url" as const;

/**
 * Provider 密钥使用平台级主密钥派生出的独立 AES-256-GCM 密钥加密。
 * AAD 绑定 Provider，允许同一 Provider 的新 Revision 复用密文，但不能跨 Provider 搬用。
 */
export class ModelProviderCredentialCipher {
  private readonly key: Buffer;

  constructor(rootSecret: string) {
    if (Buffer.byteLength(rootSecret, "utf8") < 32) {
      throw new TypeError("MODEL_CREDENTIAL_ENCRYPTION_KEY_TOO_SHORT");
    }
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(rootSecret, "utf8"),
        Buffer.from("hoox-model-provider-credential", "utf8"),
        Buffer.from("aes-256-gcm-v1", "utf8"),
        32,
      ),
    );
  }

  encrypt(providerKey: string, apiKey: string): EncryptedModelProviderCredential {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(providerKey, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return Object.freeze({
      version: 1,
      nonce: nonce.toString(encoding),
      ciphertext: ciphertext.toString(encoding),
      authTag: cipher.getAuthTag().toString(encoding),
    });
  }

  decrypt(providerKey: string, encrypted: EncryptedModelProviderCredential): string {
    if (encrypted.version !== 1) throw new Error("MODEL_CREDENTIAL_VERSION_UNSUPPORTED");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(encrypted.nonce, encoding),
    );
    decipher.setAAD(Buffer.from(providerKey, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, encoding));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, encoding)),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function isEncryptedModelProviderCredential(
  value: unknown,
): value is EncryptedModelProviderCredential {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.nonce === "string" &&
    typeof candidate.ciphertext === "string" &&
    typeof candidate.authTag === "string"
  );
}
