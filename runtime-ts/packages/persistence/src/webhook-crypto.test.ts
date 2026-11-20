import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, WebhookSecretCipher, signWebhook } from "./webhook-crypto.js";

describe("Webhook secret and request signatures", () => {
  it("encrypts secrets with tenant and webhook identity bound as AAD", () => {
    const cipher = new WebhookSecretCipher("x".repeat(48));
    const encrypted = cipher.encrypt("tenant_a", "wh_a", "one-time-secret");
    expect(cipher.decrypt("tenant_a", "wh_a", encrypted)).toBe("one-time-secret");
    expect(() => cipher.decrypt("tenant_b", "wh_a", encrypted)).toThrow();
    expect(() => cipher.decrypt("tenant_a", "wh_b", encrypted)).toThrow();
  });
  it("verifies an independently reproducible v1 HMAC over timestamp, ID and body digest", () => {
    const secret = "receiver-secret";
    const body = Buffer.from('{"id":"evt_1","type":"run.succeeded"}');
    const timestamp = "1795000000000";
    const signature = signWebhook(secret, timestamp, "evt_1", body);
    expect(verifyWebhookSignature(secret, timestamp, "evt_1", body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, timestamp, "evt_2", body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, timestamp, "evt_1", Buffer.from("{}"), signature)).toBe(
      false,
    );
  });
});
