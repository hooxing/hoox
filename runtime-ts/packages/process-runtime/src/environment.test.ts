import { describe, expect, it } from "vitest";
import {
  booleanEnvironmentField,
  EnvironmentConfigurationError,
  integerEnvironmentField,
  parseStrictEnvironment,
  stringEnvironmentField,
  urlEnvironmentField,
} from "./environment.js";

const schema = {
  DATABASE_URL: stringEnvironmentField({ secret: true }),
  DEV_AUTH_ENABLED: booleanEnvironmentField(),
  DEV_ONLY: stringEnvironmentField({ requiredIn: ["development", "test"] }),
  PORT: integerEnvironmentField({ minimum: 1, maximum: 65_535 }),
  PUBLIC_URL: urlEnvironmentField(),
} as const;

function validSource(environment: "development" | "test" | "production") {
  return {
    RUNTIME_ENV: environment,
    DATABASE_URL: "opaque-database-credential",
    DEV_AUTH_ENABLED: "false",
    ...(environment === "production" ? {} : { DEV_ONLY: "local" }),
    PORT: "3000",
    PUBLIC_URL: "https://service.example.invalid",
  };
}

describe("严格环境配置", () => {
  it.each(["development", "test", "production"] as const)("区分 %s 并返回冻结值", (environment) => {
    const parsed = parseStrictEnvironment(validSource(environment), schema);
    expect(parsed.runtimeEnvironment).toBe(environment);
    expect(parsed.values.PORT).toBe(3000);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.values)).toBe(true);
  });

  it("未知、缺失和无效配置 fail closed，错误不包含秘密值", () => {
    const secret = "credential-canary-never-print";
    let thrown: unknown;
    try {
      parseStrictEnvironment(
        {
          RUNTIME_ENV: "development",
          DATABASE_URL: secret,
          DEV_AUTH_ENABLED: "not-a-boolean",
          PORT: "70000",
          PUBLIC_URL: "https://user:password@example.invalid",
          UNKNOWN_SECRET: secret,
        },
        schema,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvironmentConfigurationError);
    const failure = thrown as EnvironmentConfigurationError;
    expect(failure.issues).toEqual(
      expect.arrayContaining([
        { code: "MISSING", key: "DEV_ONLY" },
        { code: "INVALID", key: "DEV_AUTH_ENABLED" },
        { code: "INVALID", key: "PORT" },
        { code: "INVALID", key: "PUBLIC_URL" },
        { code: "UNKNOWN", key: "UNKNOWN_SECRET" },
      ]),
    );
    expect(failure.message).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("production 即使配置完整也拒绝启用开发身份", () => {
    expect(() =>
      parseStrictEnvironment({ ...validSource("production"), DEV_AUTH_ENABLED: "true" }, schema),
    ).toThrow("FORBIDDEN_IN_PRODUCTION:DEV_AUTH_ENABLED");
  });

  it("缺失或错误 RUNTIME_ENV 不会回退到 development", () => {
    const { RUNTIME_ENV: _removed, ...withoutEnvironment } = validSource("development");
    expect(() => parseStrictEnvironment(withoutEnvironment, schema)).toThrow("MISSING:RUNTIME_ENV");
    expect(() =>
      parseStrictEnvironment({ ...validSource("development"), RUNTIME_ENV: "staging" }, schema),
    ).toThrow("INVALID:RUNTIME_ENV");
  });

  it("只有显式允许的数据库 URL 可以携带凭据", () => {
    const databaseUrlField = urlEnvironmentField({
      protocols: ["postgresql:"],
      allowCredentials: true,
    });
    expect(databaseUrlField.parse("postgresql://user:password@database/runtime")).toBe(
      "postgresql://user:password@database/runtime",
    );
    expect(() => urlEnvironmentField().parse("https://user:password@example.invalid")).toThrow();
  });
});
