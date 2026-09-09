import { describe, expect, it } from "vitest";
import { tencentAgsConfigFromEnv } from "./tencent-ags-config.js";

describe("腾讯云 AGS 冒烟配置", () => {
  it("只使用 AGS 配置，不能回退到 E2B 凭据", () => {
    expect(() =>
      tencentAgsConfigFromEnv({
        E2B_API_KEY: "e2b-secret",
        E2B_DOMAIN: "e2b.example.invalid",
        E2B_TEMPLATE_ID: "base",
      }),
    ).toThrow("TENCENT_AGS_API_KEY");
    expect(
      tencentAgsConfigFromEnv({
        TENCENT_AGS_API_KEY: " test-ags ",
        TENCENT_AGS_DOMAIN: " ags.example.invalid ",
        TENCENT_AGS_TEMPLATE_ID: " hoox ",
      }),
    ).toEqual({ apiKey: "test-ags", domain: "ags.example.invalid", templateId: "hoox" });
  });
});
