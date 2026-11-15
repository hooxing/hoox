import { describe, expect, it } from "vitest";
import { installationAccessAllowed, InstallationAttemptLimiter } from "./installation.js";

const local = {
  runtimeEnvironment: "development",
  remoteAddress: "127.0.0.1",
  host: "127.0.0.1:4173",
  origin: "http://127.0.0.1:4173",
  forwarded: false,
};

describe("首次安装访问边界", () => {
  it("开发直连回环可初始化，远程、跨站与代理不能借用该能力", () => {
    expect(installationAccessAllowed(local)).toBe(true);
    expect(installationAccessAllowed({ ...local, remoteAddress: "10.0.0.2" })).toBe(false);
    expect(
      installationAccessAllowed({ ...local, origin: "https://attacker.example.invalid" }),
    ).toBe(false);
    expect(installationAccessAllowed({ ...local, host: "attacker.example.invalid" })).toBe(false);
    expect(installationAccessAllowed({ ...local, forwarded: true })).toBe(false);
    expect(installationAccessAllowed({ ...local, runtimeEnvironment: "production" })).toBe(false);
  });
  it("配置安装令牌后，即使本地访问也必须提供正确令牌", () => {
    const configuredToken = "installation-test-token-with-32-bytes";
    expect(installationAccessAllowed({ ...local, configuredToken })).toBe(false);
    expect(installationAccessAllowed({ ...local, configuredToken, suppliedToken: "wrong" })).toBe(
      false,
    );
    expect(
      installationAccessAllowed({
        ...local,
        runtimeEnvironment: "production",
        configuredToken,
        suppliedToken: configuredToken,
      }),
    ).toBe(true);
  });
  it("限制重复尝试且在窗口结束后恢复", () => {
    const limiter = new InstallationAttemptLimiter();
    for (let index = 0; index < 10; index += 1) expect(limiter.accept("local", 0)).toBe(true);
    expect(limiter.accept("local", 1)).toBe(false);
    expect(limiter.accept("other", 1)).toBe(true);
    expect(limiter.accept("local", 60_000)).toBe(true);
  });
});
