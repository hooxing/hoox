import { describe, expect, it } from "vitest";
import { cubeConfigFromEnv, resolveCubeProxyRouting } from "./config.js";

describe("CubeSandbox Proxy 路由配置", () => {
  it("未显式配置时从 CubeAPI URL 推导同机数据面", () => {
    expect(resolveCubeProxyRouting({ apiUrl: "https://cube-api.internal:3000/" })).toEqual({
      proxyNodeIp: "cube-api.internal",
      proxyScheme: "http",
    });
  });

  it("显式数据面地址、端口和协议优先于默认推导", () => {
    expect(
      resolveCubeProxyRouting({
        apiUrl: "http://cube-api:3000",
        proxyNodeIp: "10.0.0.9",
        proxyPort: 8443,
        proxyScheme: "https",
      }),
    ).toEqual({ proxyNodeIp: "10.0.0.9", proxyPort: 8443, proxyScheme: "https" });
  });

  it("只显式配置 443 端口时沿用 SDK 的 https 推导，显式 scheme 仍优先", () => {
    expect(resolveCubeProxyRouting({ apiUrl: "http://cube-api:3000", proxyPort: 443 })).toEqual({
      proxyNodeIp: "cube-api",
      proxyPort: 443,
      proxyScheme: "https",
    });
    expect(
      resolveCubeProxyRouting({
        apiUrl: "http://cube-api:3000",
        proxyPort: 443,
        proxyScheme: "http",
      }),
    ).toEqual({ proxyNodeIp: "cube-api", proxyPort: 443, proxyScheme: "http" });
  });

  it("环境变量入口与 Worker 使用同一套默认规则", () => {
    expect(
      cubeConfigFromEnv({
        CUBESANDBOX_API_URL: "http://127.0.0.1:3000",
        CUBESANDBOX_TEMPLATE_ID: "template-test",
      }),
    ).toMatchObject({ proxyNodeIp: "127.0.0.1", proxyScheme: "http" });
  });
});
