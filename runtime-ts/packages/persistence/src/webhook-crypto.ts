import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface EncryptedWebhookSecret {
  readonly version: 1;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export class WebhookSecretCipher {
  readonly #key: Buffer;
  constructor(rootSecret: string) {
    if (Buffer.byteLength(rootSecret, "utf8") < 32)
      throw new TypeError("WEBHOOK_SECRET_ENCRYPTION_KEY_TOO_SHORT");
    this.#key = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(rootSecret),
        Buffer.from("hoox:webhook-secret-encryption:v1"),
        Buffer.from("aes-256-gcm"),
        32,
      ),
    );
  }
  encrypt(tenantId: string, webhookId: string, secret: string): EncryptedWebhookSecret {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`hoox-webhook:v1:${tenantId}:${webhookId}`));
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return {
      version: 1,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    };
  }
  decrypt(tenantId: string, webhookId: string, value: EncryptedWebhookSecret): string {
    if (value.version !== 1) throw new Error("WEBHOOK_SECRET_VERSION_UNSUPPORTED");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(value.nonce, "base64url"),
    );
    decipher.setAAD(Buffer.from(`hoox-webhook:v1:${tenantId}:${webhookId}`));
    decipher.setAuthTag(Buffer.from(value.authTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function signWebhook(
  secret: string,
  timestamp: string,
  eventId: string,
  body: Uint8Array,
): string {
  if (!/^\d{13}$/u.test(timestamp) || !/^[\x21-\x7e]{1,256}$/u.test(eventId))
    throw new TypeError("WEBHOOK_SIGNING_FIELDS_INVALID");
  const digest = Buffer.from(sha256Digest(body)).toString("hex");
  const mac = createHmac("sha256", secret)
    .update(`hoox-webhook-v1\n${timestamp}\n${eventId}\n${digest}`)
    .digest("hex");
  return `v1=${mac}`;
}
function sha256Digest(body: Uint8Array): Uint8Array {
  return createHash("sha256").update(body).digest();
}
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  eventId: string,
  body: Uint8Array,
  signature: string,
): boolean {
  const expected = Buffer.from(signWebhook(secret, timestamp, eventId, body));
  const provided = Buffer.from(signature);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
