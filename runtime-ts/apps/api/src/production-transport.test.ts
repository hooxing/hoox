import { describe, expect, it } from "vitest";
import {
  loadProductionTlsCredentials,
  parseProductionApiTransport,
  productionTrustProxy,
} from "./production-transport.js";

describe("生产 API TLS 与反向代理边界", () => {
  it("直连模式要求独立绝对证书/私钥路径，且永不信任转发头", () => {
    const transport = parseProductionApiTransport({
      listenHost: "0.0.0.0",
      tlsMode: "direct",
      certificatePath: "/run/secrets/api-cert.pem",
      privateKeyPath: "/run/secrets/api-key.pem",
    });
    expect(transport.mode).toBe("direct");
    expect(productionTrustProxy(transport)).toBe(false);
    expect(() =>
      parseProductionApiTransport({
        listenHost: "0.0.0.0",
        tlsMode: "direct",
        certificatePath: "relative-cert.pem",
        privateKeyPath: "/run/secrets/api-key.pem",
      }),
    ).toThrow("生产 API 直接 TLS 配置无效");
    expect(() =>
      parseProductionApiTransport({
        listenHost: "0.0.0.0",
        tlsMode: "direct",
        certificatePath: "/run/secrets/api.pem",
        privateKeyPath: "/run/secrets/api.pem",
      }),
    ).toThrow("生产 API 直接 TLS 配置无效");
  });

  it("反向代理模式只能绑定字面 loopback，并按规范 CIDR 信任连接对端", () => {
    const transport = parseProductionApiTransport({
      listenHost: "127.0.0.1",
      tlsMode: "proxy",
      trustedProxyCidrs: "127.0.0.1,10.20.0.0/16",
    });
    const matcher = productionTrustProxy(transport);
    expect(typeof matcher).toBe("function");
    if (typeof matcher !== "function") throw new Error("应当构造 proxy matcher");
    expect(matcher("127.0.0.1", 0)).toBe(true);
    expect(matcher("10.20.19.8", 1)).toBe(true);
    expect(matcher("10.21.19.8", 0)).toBe(false);
    expect(matcher("198.51.100.10", 0)).toBe(false);
    expect(() =>
      parseProductionApiTransport({
        listenHost: "0.0.0.0",
        tlsMode: "proxy",
        trustedProxyCidrs: "127.0.0.1",
      }),
    ).toThrow("生产 API 反向代理 TLS 配置无效");
    expect(() =>
      parseProductionApiTransport({
        listenHost: "127.0.0.1",
        tlsMode: "proxy",
        trustedProxyCidrs: "10.20.1.1/16",
      }),
    ).toThrow("生产反向代理信任边界无效");
  });

  it("拒绝不完整、混用或重复的 TLS/proxy 配置", () => {
    expect(() =>
      parseProductionApiTransport({ listenHost: "127.0.0.1", tlsMode: "proxy" }),
    ).toThrow("生产 API 反向代理 TLS 配置无效");
    expect(() =>
      parseProductionApiTransport({
        listenHost: "127.0.0.1",
        tlsMode: "proxy",
        trustedProxyCidrs: "127.0.0.1,127.0.0.1",
      }),
    ).toThrow("生产反向代理信任边界无效");
    expect(() =>
      parseProductionApiTransport({
        listenHost: "0.0.0.0",
        tlsMode: "direct",
        certificatePath: "/run/secrets/api-cert.pem",
        privateKeyPath: "/run/secrets/api-key.pem",
        trustedProxyCidrs: "127.0.0.1",
      }),
    ).toThrow("生产 API 直接 TLS 配置无效");
    expect(() =>
      parseProductionApiTransport({ listenHost: "127.0.0.1", tlsMode: "insecure" }),
    ).toThrow("API_TLS_MODE 只能是 direct 或 proxy");
  });

  it("直连 TLS 凭据不可读取或不可解析时失败关闭，绝不降级为明文 listener", async () => {
    const transport = parseProductionApiTransport({
      listenHost: "0.0.0.0",
      tlsMode: "direct",
      certificatePath: "/definitely-missing/api-cert.pem",
      privateKeyPath: "/definitely-missing/api-key.pem",
    });
    await expect(loadProductionTlsCredentials(transport)).rejects.toThrow(
      "PRODUCTION_TLS_CREDENTIALS_UNAVAILABLE",
    );
  });
});
