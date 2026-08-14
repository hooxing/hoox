import { describe, expect, it } from "vitest";
import { e2bConfigFromEnv } from "./e2b-config.js";

describe("E2B 环境配置", () => {
  it("读取并裁剪真实冒烟所需配置", () => {
    expect(
      e2bConfigFromEnv({
        E2B_API_KEY: "  test-key  ",
        E2B_TEMPLATE_ID: "  agent-template  ",
        E2B_DOMAIN: "  e2b.example.invalid  ",
      }),
    ).toEqual({ apiKey: "test-key", templateId: "agent-template", domain: "e2b.example.invalid" });
  });

  it("缺少凭据或 Template 时只返回稳定错误且不回显值", () => {
    expect(() => e2bConfigFromEnv({ E2B_TEMPLATE_ID: "agent-template" })).toThrow(
      "缺少 E2B API Key",
    );
    expect(() => e2bConfigFromEnv({ E2B_API_KEY: "secret-value" })).toThrow("缺少 E2B Template ID");
  });
});
