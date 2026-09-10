import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfiguredSandboxGateway, probeConfiguredSandbox } from "./configured-gateway.js";

const fixture = vi.hoisted(() => {
  const handle = {
    id: "probe-sandbox",
    command: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    pause: vi.fn(),
    kill: vi.fn(),
  };
  const gateway = { create: vi.fn(), connect: vi.fn(), inspect: vi.fn() };
  // biome-ignore lint/complexity/useArrowFunction: 模拟被 new 调用的 Gateway 构造函数。
  const factory = vi.fn(function () {
    return gateway;
  });
  return { handle, gateway, factory };
});
vi.mock("./cube-gateway.js", () => ({ CubeSandboxGateway: fixture.factory }));
vi.mock("./e2b-gateway.js", () => ({ E2BSandboxGateway: fixture.factory }));
vi.mock("./tencent-ags-gateway.js", () => ({ TencentAgsSandboxGateway: fixture.factory }));
const input = {
  providerKey: "tencent-ags" as const,
  endpoint: "sandbox.example.test",
  apiKey: "test-key",
  operationTimeoutMs: 60000,
  sessionTtlSeconds: 3600,
  lifecycleTimeoutMs: 90000,
  templateId: "test-template",
  idleAction: "pause" as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.gateway.create.mockResolvedValue(fixture.handle);
  fixture.gateway.connect.mockResolvedValue(fixture.handle);
  fixture.gateway.inspect.mockResolvedValue("not_found");
  fixture.handle.command.mockResolvedValue({ exitCode: 0, stdout: "python-ready node-ready" });
  fixture.handle.readFile.mockResolvedValue("hoox-sandbox-ready");
  fixture.handle.kill.mockResolvedValue(undefined);
});
describe("托管沙箱连接与探测", () => {
  it("Cube 代理属于配置版本，缺省时明确禁用进程代理继承", () => {
    createConfiguredSandboxGateway({ ...input, providerKey: "cube" });
    expect(fixture.factory).toHaveBeenLastCalledWith(
      expect.objectContaining({ proxyNodeIp: null, proxyPort: 80, proxyScheme: "http" }),
    );
    createConfiguredSandboxGateway({
      ...input,
      providerKey: "cube",
      cubeProxy: { host: "proxy.example.test", port: 8443, scheme: "https" },
    });
    expect(fixture.factory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        proxyNodeIp: "proxy.example.test",
        proxyPort: 8443,
        proxyScheme: "https",
      }),
    );
  });
  it("暂停策略验证恢复和文件保留，最后确认销毁", async () => {
    await probeConfiguredSandbox(input);
    expect(fixture.gateway.create).toHaveBeenCalledWith(
      { templateId: "test-template", ttlSeconds: 300 },
      { timeoutMs: 90000 },
    );
    expect(fixture.handle.pause).toHaveBeenCalledOnce();
    expect(fixture.gateway.connect).toHaveBeenCalledWith("probe-sandbox", { timeoutMs: 90000 });
    expect(fixture.handle.readFile).toHaveBeenCalledTimes(2);
    expect(fixture.handle.kill).toHaveBeenCalledOnce();
    expect(fixture.gateway.inspect).toHaveBeenCalledOnce();
  });
  it("销毁策略不要求暂停；执行失败仍清理，清理失败不能通过", async () => {
    await probeConfiguredSandbox({ ...input, idleAction: "kill" });
    expect(fixture.handle.pause).not.toHaveBeenCalled();
    fixture.handle.command.mockRejectedValueOnce(new Error("test execution failure"));
    await expect(probeConfiguredSandbox(input)).rejects.toThrow("test execution failure");
    expect(fixture.handle.kill).toHaveBeenCalledTimes(2);
    fixture.handle.kill.mockRejectedValueOnce(new Error("test cleanup failure"));
    await expect(probeConfiguredSandbox(input)).rejects.toThrow("test cleanup failure");
  });
});
