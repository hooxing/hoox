import { describe, expect, it } from "vitest";
import {
  ExternalToolCredentialCipher,
  ExternalToolDraftCredentialCipher,
} from "./external-tool-credential.js";
import { ExternalToolCredentialDecryptor } from "./external-tool-credential-reader.js";

describe("外部工具凭据托管", () => {
  it("密文不会包含凭据明文且每次加密使用新 nonce", () => {
    const cipher = new ExternalToolCredentialCipher("x".repeat(48));
    const first = cipher.encrypt("tool-v1", "very-secret-token");
    const second = cipher.encrypt("tool-v1", "very-secret-token");
    expect(JSON.stringify(first)).not.toContain("very-secret-token");
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.version).toBe(1);
    const decryptor = new ExternalToolCredentialDecryptor("x".repeat(48));
    expect(decryptor.decrypt("tool-v1", first)).toBe("very-secret-token");
    expect(() => decryptor.decrypt("other-tool", first)).toThrow();
    expect(() => decryptor.decrypt("tool-v1", { ...first, nonce: "AA" })).toThrow(
      "EXTERNAL_TOOL_CREDENTIAL_CIPHERTEXT_INVALID",
    );
    expect(() => decryptor.decrypt("tool-v1", { ...first, authTag: "AA" })).toThrow(
      "EXTERNAL_TOOL_CREDENTIAL_CIPHERTEXT_INVALID",
    );
  });
  it("草稿密文和幂等指纹绑定草稿身份且不能搬用为版本凭据", () => {
    const root = "placeholder-root".repeat(4);
    const draft = new ExternalToolDraftCredentialCipher(root);
    const value = "test-credential-placeholder";
    const sealed = draft.encrypt("draft-a", value);
    expect(draft.decrypt("draft-a", sealed) === value).toBe(true);
    expect(() => draft.decrypt("draft-b", sealed)).toThrow();
    expect(() => new ExternalToolCredentialDecryptor(root).decrypt("draft-a", sealed)).toThrow();
    const digest = draft.fingerprint("draft-a", value);
    expect(draft.fingerprint("draft-a", value)).toBe(digest);
    expect(draft.fingerprint("draft-b", value)).not.toBe(digest);
    expect(draft.fingerprint("draft-a", `${value}-changed`)).not.toBe(digest);
  });
  it("拒绝过短根密钥", () => expect(() => new ExternalToolCredentialCipher("short")).toThrow());
});
