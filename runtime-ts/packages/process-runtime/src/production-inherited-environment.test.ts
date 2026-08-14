import { describe, expect, it } from "vitest";
import { assertProductionInheritedEnvironment } from "./production-inherited-environment.js";

const forbiddenKeys = [
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_OPTIONS",
  "NODE_USE_ENV_PROXY",
  "NODE_USE_SYSTEM_CA",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
] as const;

describe("production 继承进程环境边界", () => {
  it.each(forbiddenKeys)("拒绝 production 非空 %s 且不回显其值", (key) => {
    const canary = "inherited-environment-secret-canary";
    try {
      assertProductionInheritedEnvironment({ RUNTIME_ENV: "production", [key]: canary });
      throw new Error("应拒绝继承环境覆盖");
    } catch (error) {
      expect(String(error)).toContain("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
      expect(String(error)).not.toContain(canary);
    }
  });

  it.each(forbiddenKeys)("按 ASCII 大小写不敏感方式拒绝 %s", (key) => {
    expect(() =>
      assertProductionInheritedEnvironment({
        RUNTIME_ENV: "production",
        [key.toLowerCase()]: "lowercase-canary",
      }),
    ).toThrow("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
  });

  it("不改变 development，允许 production 空值和显式 NODE_EXTRA_CA_CERTS", () => {
    expect(() =>
      assertProductionInheritedEnvironment({
        RUNTIME_ENV: "development",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionInheritedEnvironment({
        RUNTIME_ENV: "production",
        NODE_OPTIONS: "",
        NODE_ENV: "production",
        NODE_VERSION: "24.18.0",
        NODE_EXTRA_CA_CERTS: "/run/secrets/private-ca.pem",
      }),
    ).not.toThrow();
  });

  it("显式声明的 E2B_API_KEY 不作为 ambient SDK 回退通道拒绝", () => {
    expect(() =>
      assertProductionInheritedEnvironment({ RUNTIME_ENV: "production", E2B_API_KEY: "opaque" }),
    ).not.toThrow();
  });

  it("对未来未列出的 NODE_* 默认失败关闭", () => {
    expect(() =>
      assertProductionInheritedEnvironment({
        RUNTIME_ENV: "production",
        node_future_transport_override: "1",
      }),
    ).toThrow("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
  });

  it.each(["CUBE_API_KEY", "cube_api_url"])("拒绝 vendor 环境回退通道 %s", (key) => {
    expect(() =>
      assertProductionInheritedEnvironment({ RUNTIME_ENV: "production", [key]: "ambient" }),
    ).toThrow("PRODUCTION_INHERITED_ENVIRONMENT_FORBIDDEN");
  });
});
