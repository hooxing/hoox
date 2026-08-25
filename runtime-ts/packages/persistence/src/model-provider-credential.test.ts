import { describe, expect, it } from "vitest";
import { ModelProviderCredentialCipher } from "./model-provider-credential.js";

describe("模型 Provider 托管凭据", () => {
  it("密文不包含明文且只能由同一 Provider 解密", () => {
    const cipher = new ModelProviderCredentialCipher(
      "test-model-credential-root-secret-at-least-thirty-two-bytes",
    );
    const encrypted = cipher.encrypt("deepseek", "sk-sensitive-model-value");

    expect(JSON.stringify(encrypted)).not.toContain("sk-sensitive-model-value");
    expect(cipher.decrypt("deepseek", encrypted)).toBe("sk-sensitive-model-value");
    expect(() => cipher.decrypt("openrouter", encrypted)).toThrow();
  });

  it("相同密钥每次产生不同密文", () => {
    const cipher = new ModelProviderCredentialCipher(
      "test-model-credential-root-secret-at-least-thirty-two-bytes",
    );
    expect(cipher.encrypt("deepseek", "same-key").ciphertext).not.toBe(
      cipher.encrypt("deepseek", "same-key").ciphertext,
    );
  });
});
