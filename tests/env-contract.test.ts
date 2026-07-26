import { describe, expect, it } from "vitest";
import { expectedEnvironmentKeys, validateEnvironmentExample } from "../scripts/env-contract.mjs";

function validExample(): string {
  return expectedEnvironmentKeys
    .map((key) => {
      if (
        key === "DATABASE_URL" ||
        key === "DATABASE_BOOTSTRAP_URL" ||
        key === "MIGRATION_DATABASE_URL"
      ) {
        return `${key}=postgresql://user:replace-me@localhost/db`;
      }
      if (key === "DATABASE_DOCKER_URL") {
        return `${key}=postgresql://user:replace-me@database/db`;
      }
      if (key === "MODEL_BASE_URL") return `${key}=https://provider.example.invalid/v1`;
      if (
        key.endsWith("PASSWORD") ||
        key.endsWith("SECRET_ACCESS_KEY") ||
        key.endsWith("ACCESS_KEY_ID") ||
        key.endsWith("API_KEY") ||
        key.endsWith("SIGNING_KEYS") ||
        key.endsWith("TEMPLATE_ID") ||
        key === "MINIO_ROOT_USER" ||
        key === "MODEL_ID"
      ) {
        return `${key}=replace-with-value`;
      }
      return `${key}=example`;
    })
    .join("\n");
}

describe("环境变量示例契约", () => {
  it("接受完整且只包含占位凭据的示例", () => {
    expect(validateEnvironmentExample(validExample())).toEqual([]);
  });

  it("同时报告缺失项和未登记项", () => {
    const source = validExample()
      .split("\n")
      .filter((line) => !line.startsWith("MODEL_ID="))
      .concat("UNKNOWN_KEY=example")
      .join("\n");

    expect(validateEnvironmentExample(source)).toEqual([
      "缺少环境变量：MODEL_ID",
      "未登记的环境变量：UNKNOWN_KEY",
    ]);
  });

  it("拒绝疑似真实密钥且错误信息不泄漏配置值", () => {
    const liveLikeValue = "sk-live-like-value-for-test";
    const source = validExample().replace(
      "MODEL_API_KEY=replace-with-value",
      `MODEL_API_KEY=${liveLikeValue}`,
    );
    const issues = validateEnvironmentExample(source);

    expect(issues).toContain("示例配置疑似包含真实凭据：MODEL_API_KEY");
    expect(issues.join(" ")).not.toContain(liveLikeValue);
  });
});
