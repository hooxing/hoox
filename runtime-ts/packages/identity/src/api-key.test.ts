import { describe, expect, it } from "vitest";
import {
  apiKeyHashesMatch,
  createApiKeyToken,
  hashApiKey,
  isApiKeyToken,
  isExternalEndUserId,
} from "./api-key.js";

describe("API Key token", () => {
  it("终端用户 ID 区分大小写，拒绝空值、控制字符、分隔歧义与过长输入", () => {
    for (const value of ["a", "Customer:42", "acct/alice@example.test", "a".repeat(128)]) {
      expect(isExternalEndUserId(value)).toBe(true);
    }
    for (const value of [
      "",
      " alice",
      "alice ",
      "alice,bob",
      "a\nb",
      "a\n",
      "用户",
      "a".repeat(129),
    ]) {
      expect(isExternalEndUserId(value)).toBe(false);
    }
  });
  it("使用可识别前缀和 256 位随机秘密，只能验证哈希", () => {
    const token = createApiKeyToken();
    expect(isApiKeyToken(token)).toBe(true);
    expect(hashApiKey(token)).toHaveLength(32);
    expect(apiKeyHashesMatch(hashApiKey(token), hashApiKey(token))).toBe(true);
    expect(apiKeyHashesMatch(hashApiKey(token), hashApiKey(createApiKeyToken()))).toBe(false);
    expect(isApiKeyToken("hoox_sk_invalid")).toBe(false);
  });
});
