import { describe, expect, it, vi } from "vitest";
import {
  SandboxProviderRegistry,
  SandboxRuntimeError,
  type RuntimeSandboxGateway,
} from "./index.js";

function gateway(providerKey: "cube" | "e2b" | "tencent-ags"): RuntimeSandboxGateway {
  return {
    providerKey,
    probe: vi.fn(async () => undefined),
  } as unknown as RuntimeSandboxGateway;
}

describe("Sandbox Provider Registry", () => {
  it("空安装允许建立 Registry，但探针与实际创建保持未配置错误", async () => {
    const registry = new SandboxProviderRegistry("cube", []);
    expect(registry.keys()).toEqual([]);
    await expect(registry.probe()).rejects.toThrow("SANDBOX_CONFIGURATION_REQUIRED");
    expect(() => registry.default()).toThrow();
  });

  it("腾讯云与 E2B 同时注册时保持恢复路由隔离", () => {
    const e2b = gateway("e2b");
    const ags = gateway("tencent-ags");
    const registry = new SandboxProviderRegistry("tencent-ags", [e2b, ags]);
    expect(registry.default()).toBe(ags);
    expect(registry.require("e2b")).toBe(e2b);
    expect(registry.require("tencent-ags")).toBe(ags);
  });

  it("按部署默认值与显式 providerKey 返回同一个已注册 gateway", async () => {
    const cube = gateway("cube");
    const e2b = gateway("e2b");
    const registry = new SandboxProviderRegistry("e2b", [cube, e2b]);

    expect(registry.default()).toBe(e2b);
    expect(registry.require("cube")).toBe(cube);
    expect(registry.keys()).toEqual(["cube", "e2b"]);
    await registry.probe();
    expect(cube.probe).toHaveBeenCalledOnce();
    expect(e2b.probe).toHaveBeenCalledOnce();
  });

  it("默认 Provider 未启用、重复注册或请求未知 Provider 时失败关闭", () => {
    const cube = gateway("cube");
    expect(() => new SandboxProviderRegistry("e2b", [cube])).toThrow(SandboxRuntimeError);
    expect(() => new SandboxProviderRegistry("cube", [cube, cube])).toThrow(SandboxRuntimeError);
    const registry = new SandboxProviderRegistry("cube", [cube]);
    expect(() => registry.require("e2b")).toThrow("Sandbox Provider 未启用");
  });
});
