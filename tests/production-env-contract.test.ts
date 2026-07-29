import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  expectedProductionEnvironmentKeys,
  validateProductionEnvironmentExample,
} from "../scripts/production-env-contract.mjs";

const example = readFileSync(new URL("../deploy/production.env.example", import.meta.url), "utf8");

describe("production 部署配置契约", () => {
  it("完整样例只使用占位凭据，且不包含 development 身份", () => {
    expect(expectedProductionEnvironmentKeys).not.toContain("DEV_AUTH_ENABLED");
    expect(validateProductionEnvironmentExample(example)).toEqual([]);
  });

  it("development 身份、明文端点和真实样式密钥都会失败且不回显其值", () => {
    const secret = "live-production-secret-canary";
    const source = `${example}\nDEV_AUTH_ENABLED=false`
      .replace("S3_ENDPOINT=https://s3.internal.example.invalid", "S3_ENDPOINT=http://s3.internal")
      .replace("MODEL_API_KEY=replace-with-production-model-api-key", `MODEL_API_KEY=${secret}`);
    const issues = validateProductionEnvironmentExample(source);
    expect(issues).toContain("未登记的生产环境变量：DEV_AUTH_ENABLED");
    expect(issues).toContain("生产配置禁止开发身份变量：DEV_AUTH_ENABLED");
    expect(issues).toContain("生产样例必须使用无凭据 HTTPS：S3_ENDPOINT");
    expect(issues).toContain("示例配置疑似包含真实凭据：MODEL_API_KEY");
    expect(issues.join(" ")).not.toContain(secret);
  });
});
