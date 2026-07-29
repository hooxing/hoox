import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadProductionTlsCredentials,
  parseProductionApiTransport,
  productionTrustProxy,
} from "./production-transport.js";

// 仅用于文件边界回归的短期自签名测试材料，不是部署凭据。
const testCertificate = `-----BEGIN CERTIFICATE-----
MIICrzCCAZcCFATOdLVuKE6QbgpyDVhf3Nnc0t/NMA0GCSqGSIb3DQEBCwUAMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjA3MjkxODAzMzlaFw0yNjA3MzAxODAz
MzlaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEP
ADCCAQoCggEBANMepxVN6EArJlqkCCTUC48KmAyBBKmZU8F1aSSfwSvX67MVf839
JEIEneZbFXb9g8M1c3SzTkguPq+bY85QQzeeGI9G8psGiqYb3bVoVLro5MInRMES
ZHG8mZ3ihhkN1v78z3B3+PoO3RaSmh2LPUQXaYlI2xm+z5tV7O7ID6+QkBL0V8dW
tpbxuguY8EG+xDpEEHoAmC5gARA/2dq5Mbavr0nu5Drz6O3K5DTcNSTvvI22aZjY
InsBong4NO4Wsq8QMH7c9v+ZoHDtVYTrMvD8bKE+kqIa8qUipPEhzd9bUL0E/BwQ
iC3RG7EvPe4XzJthtF4RadoP9wDHVQ7QfbcCAwEAATANBgkqhkiG9w0BAQsFAAOC
AQEADPQtCvNKPgd8zLWUUcByzKhmBTudvuDsgMmL/mJ6nYZO6+RLcyRV6zEcm9+P
D2udCORJKYsNe8hZwdyHpJtaN7b7wjsrZ6d4Q8XCrn8BG3IIh+a7vlUMhcpLBieo
5FFYsa4XeUNbDzbBjWDQ48hYpxdpXWSYDtZWXp3spZkHe7m9GWLWL8KIKZqaYw37
k65HNU9GuyvNZsZgL5h11+V6GGd6zDlH+idAATOoLL06ebBwCdL/uBJki2yoVD0Y
VzkVehRAcfeL4x0avVIcxEpmw/awevL3feP0ws74zkshWaPG/xV/fmNzZoBQC7gO
iLViUpmElK3w94UZtjeq7yaRNw==
-----END CERTIFICATE-----
`;
const testPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQDTHqcVTehAKyZa
pAgk1AuPCpgMgQSpmVPBdWkkn8Er1+uzFX/N/SRCBJ3mWxV2/YPDNXN0s05ILj6v
m2POUEM3nhiPRvKbBoqmG921aFS66OTCJ0TBEmRxvJmd4oYZDdb+/M9wd/j6Dt0W
kpodiz1EF2mJSNsZvs+bVezuyA+vkJAS9FfHVraW8boLmPBBvsQ6RBB6AJguYAEQ
P9nauTG2r69J7uQ68+jtyuQ03DUk77yNtmmY2CJ7AaJ4ODTuFrKvEDB+3Pb/maBw
7VWE6zLw/GyhPpKiGvKlIqTxIc3fW1C9BPwcEIgt0RuxLz3uF8ybYbReEWnaD/cA
x1UO0H23AgMBAAECgf8B7Jrulscxzog1oJ5yYicOJrU8Epui8Bgoqz6fbCqr5kvq
VfJ+7iURH6RQyoO85z1MNNst38nW3pUJBLbkKoHHqqk5T8GQ/X5GBVBVVvNuwLCq
abE2u/QuaommkWn80HjP2ii0iGNnOWYfzouZDqvVnbZYifwf6p1PInlbs8xwzTGZ
+2i4CW+9x2XHaMXJAYW5Oz2DLgvY7oKvk2poD5wiKumBYU4cxrwwo1mS0kKktB2r
VxQnPkeEY3kW1ApJS/X2yW0Zj439kiJG1M6fvodS1UT4vyWT51c4OwOaJi0Wizqj
GND/nGNlREcSN4thmMFvcQS3/dM61x7rkI0HWbECgYEA9LYLhXXRRMWuWjHl4ekw
dqztJ6+z/qxlVI5/hBjwWDH87f0h6SPtwq3mYkkQWJOZCEltHW3Ksl70SJLp8Z+l
JnNRBmWNDCWzWOBKW22yNvJ8D0MSrxVZpubkRObnUy6sZ6OurTFfds5tW8fwF3/j
teMlls8VChRA3znYgwiF/skCgYEA3NvnqfwGrrmh2YEtZrn+2PF/cpwz36j3+wqQ
oNaiewrSUuOYoHvNvDuEs9kCqZVMi1tk8XVwQUB8JXsbf+BWb6CUWxq+94L9M7kH
fv9Mz/tj4ID6Uj4TYsi3BK8uPBiMHmNJH+BiEKnQv2nXCV63XFl4C/ucIuqEDXu7
IzWyWH8CgYBwFs7SM/RGPxIsyDxXLVwAkBcVHZsh5U+I2ri4BkBY9ZS4YkFdLBLl
IIitrm/pUro/HHr5hufYqjvU3k6AWbLpGNsdRfjEfqRW6m3E0UtXddyzlPKC9hGZ
rJsUoHuHE5Lu6f/B3yKuJcHbz4o/CVqBXulB2dr2Qe6xESsGYioWWQKBgEEhvNT9
VP8sEVXyaXA1A7n4piwncojP7Kmk+PfltC7zBwmYwwb427haGQ1svwNB2zvxrPgk
OQGVQcdP4dE5WGQ9B+NCJPUbNQ6Oz24dXgqryU2I28lrMw5bwNVp0Am6939yqjrz
Uhg17DC2xsqlmw9p9yQZhHcrj9vmFE8S49CDAoGBAMV6jkWQ3U2NpoNo3LzUhYbk
z5ggNKjqXTkiSDFvXiOUXqmEb2uyhvZZZZCaVZ5aAA69JpcN8LOQEAb7Dp8S7nlp
ac0e/NkGGLvwmBSiIjXeTpnMNSrNrdtubf7q/DY3jXuKMkdCZst3aEOoCS2mM2Ff
D377ZfNsiWmv8KLafaWa
-----END PRIVATE KEY-----
`;

function directTransport(certificatePath: string, privateKeyPath: string) {
  return parseProductionApiTransport({
    listenHost: "0.0.0.0",
    tlsMode: "direct",
    certificatePath,
    privateKeyPath,
  });
}

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

  it.runIf(process.platform !== "win32")(
    "私钥 group/world 任一权限位、符号链接与路径置换均失败关闭",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "api-tls-boundary-"));
      try {
        const certificatePath = join(directory, "certificate.pem");
        const privateKeyPath = join(directory, "private-key.pem");
        await writeFile(certificatePath, testCertificate, { mode: 0o644 });
        await writeFile(privateKeyPath, testPrivateKey, { mode: 0o600 });
        await expect(
          loadProductionTlsCredentials(directTransport(certificatePath, privateKeyPath)),
        ).resolves.toMatchObject({ minVersion: "TLSv1.2" });

        for (const mode of [0o640, 0o660]) {
          await chmod(privateKeyPath, mode);
          await expect(
            loadProductionTlsCredentials(directTransport(certificatePath, privateKeyPath)),
          ).rejects.toThrow("PRODUCTION_TLS_CREDENTIALS_UNAVAILABLE");
        }

        const linkPath = join(directory, "private-key-link.pem");
        await chmod(privateKeyPath, 0o600);
        await symlink(privateKeyPath, linkPath);
        await expect(
          loadProductionTlsCredentials(directTransport(certificatePath, linkPath)),
        ).rejects.toThrow("PRODUCTION_TLS_CREDENTIALS_UNAVAILABLE");

        const exchangedPath = join(directory, "exchanged-key.pem");
        const displacedPath = join(directory, "displaced-key.pem");
        await writeFile(exchangedPath, testPrivateKey, { mode: 0o600 });
        const exchangedTransport = directTransport(certificatePath, exchangedPath);
        await rename(exchangedPath, displacedPath);
        await symlink(displacedPath, exchangedPath);
        await expect(loadProductionTlsCredentials(exchangedTransport)).rejects.toThrow(
          "PRODUCTION_TLS_CREDENTIALS_UNAVAILABLE",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
