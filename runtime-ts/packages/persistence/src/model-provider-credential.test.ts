import { describe, expect, it } from "vitest";
import { ModelProviderCredentialCipher } from "./model-provider-credential.js";

describe("模型 Provider 托管凭据", () => {
  it("记忆密钥与模型隔离，用户作用域密钥跨实例稳定且独立于 API Key", () => {
    const root = "unit-platform-root-at-least-thirty-two-bytes";
    const cipher = new ModelProviderCredentialCipher(root);
    const encrypted = cipher.encrypt("memory:mem0", "unit-memory-api-key");
    expect(cipher.decrypt("memory:mem0", encrypted)).toBe("unit-memory-api-key");
    expect(() => cipher.decrypt("mem0", encrypted)).toThrow();
    expect(() => cipher.decrypt("memory:another", encrypted)).toThrow();
    const scope = cipher.memoryScopeHmacKey();
    cipher.encrypt("memory:mem0", "replacement-key");
    expect(new ModelProviderCredentialCipher(root).memoryScopeHmacKey()).toBe(scope);
    expect(new ModelProviderCredentialCipher(`${root}-different`).memoryScopeHmacKey()).not.toBe(
      scope,
    );
  });
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
