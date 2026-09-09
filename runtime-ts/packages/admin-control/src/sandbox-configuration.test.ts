import { describe, expect, it } from "vitest";
import {
  normalizeSandboxProviderProfile,
  normalizeSandboxRoutingConfiguration,
  type SandboxProviderProfile,
  type SandboxRoutingConfiguration,
  selectSandboxRoutingTarget,
} from "./sandbox-configuration.js";

const profile: SandboxProviderProfile = {
  providerKey: "tencent-ags",
  displayName: "腾讯云沙箱",
  endpoint: "ap-shanghai.tencentags.com",
  credentialConfigured: true,
  policy: {
    templateId: "example-template",
    sessionTtlSeconds: 3600,
    operationTimeoutMs: 60000,
    lifecycleTimeoutMs: 90000,
    pausedRetentionSeconds: 86400,
    idleAction: "pause",
  },
};
const routing = {
  mode: "weighted",
  targets: [
    { providerKey: "cube", profileRevision: 1, weight: 1 },
    { providerKey: "tencent-ags", profileRevision: 2, weight: 3 },
  ],
} as const satisfies SandboxRoutingConfiguration;

describe("后端沙箱配置", () => {
  it("保留各供应商独立策略并冻结投影", () => {
    const normalized = normalizeSandboxProviderProfile(profile);
    expect(normalized).toEqual(profile);
    expect(Object.isFrozen(normalized.policy)).toBe(true);
    expect(
      normalizeSandboxProviderProfile({
        ...profile,
        providerKey: "cube",
        endpoint: "http://sandbox.example.test:8080",
      }).endpoint,
    ).toBe("http://sandbox.example.test:8080");
  });
  it.each(["https://example.com", "key@example.com", "example.com/path", "example.com?key=secret"])(
    "拒绝混入域名的协议、路径或凭据：%s",
    (endpoint) => {
      expect(() => normalizeSandboxProviderProfile({ ...profile, endpoint })).toThrow();
    },
  );
  it("拒绝 Cube URL 内嵌凭据及无效策略", () => {
    expect(() =>
      normalizeSandboxProviderProfile({
        ...profile,
        providerKey: "cube",
        endpoint: "https://user:secret@example.com",
      }),
    ).toThrow();
    expect(() =>
      normalizeSandboxProviderProfile({
        ...profile,
        policy: { ...profile.policy, sessionTtlSeconds: 0 },
      }),
    ).toThrow();
    expect(() =>
      normalizeSandboxProviderProfile({
        ...profile,
        policy: { ...profile.policy, lifecycleTimeoutMs: Infinity },
      }),
    ).toThrow();
  });
  it("单供应商切换只选择明确目标", () => {
    const target = routing.targets[1];
    expect(selectSandboxRoutingTarget({ mode: "single", targets: [target] }, "allocation")).toEqual(
      target,
    );
    expect(() => normalizeSandboxRoutingConfiguration({ ...routing, mode: "single" })).toThrow();
  });
  it("拒绝零权重、重复供应商和空目标，不能隐式回退", () => {
    expect(() => normalizeSandboxRoutingConfiguration({ ...routing, targets: [] })).toThrow();
    expect(() =>
      normalizeSandboxRoutingConfiguration({
        ...routing,
        targets: [routing.targets[0], routing.targets[0]],
      }),
    ).toThrow();
    expect(() =>
      normalizeSandboxRoutingConfiguration({
        ...routing,
        targets: [{ ...routing.targets[0], weight: 0 }],
      }),
    ).toThrow();
  });
  it("跨进程重算保持相同选择，多个分配键按配置比例分担新实例", () => {
    let ags = 0;
    for (let i = 0; i < 10000; i++) {
      const selected = selectSandboxRoutingTarget(routing, `tenant/thread/registry-${i}`);
      expect(
        selectSandboxRoutingTarget(
          JSON.parse(JSON.stringify(routing)),
          `tenant/thread/registry-${i}`,
        ),
      ).toEqual(selected);
      if (selected.providerKey === "tencent-ags") ags++;
    }
    expect(ags).toBeGreaterThan(7200);
    expect(ags).toBeLessThan(7800);
  });
});
