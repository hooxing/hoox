import { describe, expect, it } from "vitest";
import { apiKeyHashesMatch, createApiKeyToken, hashApiKey, isApiKeyToken } from "./api-key.js";

describe("API Key token", () => {
  it("使用可识别前缀和 256 位随机秘密，只能验证哈希", () => {
    const token = createApiKeyToken();
    expect(isApiKeyToken(token)).toBe(true);
    expect(hashApiKey(token)).toHaveLength(32);
    expect(apiKeyHashesMatch(hashApiKey(token), hashApiKey(token))).toBe(true);
    expect(apiKeyHashesMatch(hashApiKey(token), hashApiKey(createApiKeyToken()))).toBe(false);
    expect(isApiKeyToken("hoox_sk_invalid")).toBe(false);
  });
});
