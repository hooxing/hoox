import { afterEach, describe, expect, it, vi } from "vitest";

type Callback = (error: NodeJS.ErrnoException | null, values?: string[]) => void;
const dns = vi.hoisted(() => ({
  instances: [] as { callbacks: Callback[]; cancel: ReturnType<typeof vi.fn> }[],
}));
vi.mock("node:dns", () => ({
  Resolver: class {
    callbacks: Callback[] = [];
    cancel = vi.fn();
    constructor() {
      dns.instances.push(this);
    }
    resolve4(_hostname: string, callback: Callback) {
      this.callbacks.push(callback);
    }
    resolve6(_hostname: string, callback: Callback) {
      this.callbacks.push(callback);
    }
  },
}));
import { resolveExternalAddresses, validateExternalHttpsTarget } from "./external-tools.js";

afterEach(() => {
  dns.instances.length = 0;
});
function finish(index: number, addresses = ["8.8.8.8"]): void {
  const instance = dns.instances[index];
  if (!instance) throw new Error("解析器缺失");
  instance.callbacks[0]?.(null, addresses);
  instance.callbacks[1]?.(Object.assign(new Error("无 AAAA 记录"), { code: "ENODATA" }));
}

describe("有界可取消 DNS 解析", () => {
  it("等待 A 与 AAAA 全部返回，任何一个私网结果都会拒绝目标", async () => {
    const pending = validateExternalHttpsTarget("https://mixed.example/hook");
    const rejected = expect(pending).rejects.toThrow("EXTERNAL_TARGET_REJECTED");
    dns.instances[0]?.callbacks[0]?.(null, ["8.8.8.8"]);
    dns.instances[0]?.callbacks[1]?.(null, ["::1"]);
    await rejected;
  });

  it("取消后仍等待底层两个回调才释放配额，且不接受迟到的公网结果", async () => {
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      resolveExternalAddresses("slow.example", controller.signal),
    );
    const rejected = pending.map((operation) =>
      expect(operation).rejects.toThrow("EXTERNAL_DNS_CANCELLED"),
    );
    for (const controller of controllers) controller.abort();
    expect(dns.instances.every((instance) => instance.cancel.mock.calls.length === 1)).toBe(true);
    await expect(resolveExternalAddresses("healthy.example")).rejects.toThrow(
      "EXTERNAL_DNS_CAPACITY_EXHAUSTED",
    );
    dns.instances[0]?.callbacks[0]?.(null, ["8.8.8.8"]);
    await expect(resolveExternalAddresses("healthy.example")).rejects.toThrow(
      "EXTERNAL_DNS_CAPACITY_EXHAUSTED",
    );
    dns.instances[0]?.callbacks[1]?.(null, ["2001:4860:4860::8888"]);
    const healthy = resolveExternalAddresses("healthy.example");
    finish(16);
    await expect(healthy).resolves.toEqual(["8.8.8.8"]);
    for (let index = 1; index < 16; index += 1) finish(index);
    await Promise.all(rejected);
  });

  it("一个查询失败不能提前释放另一个悬挂查询的配额", async () => {
    const pending = Array.from({ length: 16 }, () => resolveExternalAddresses("failed.example"));
    const rejected = pending.map((operation) => expect(operation).rejects.toThrow("解析失败"));
    for (const instance of dns.instances) instance.callbacks[0]?.(new Error("解析失败"));
    await Promise.all(rejected);
    await expect(resolveExternalAddresses("healthy.example")).rejects.toThrow(
      "EXTERNAL_DNS_CAPACITY_EXHAUSTED",
    );
    for (const instance of dns.instances) instance.callbacks[1]?.(null, []);
    const healthy = resolveExternalAddresses("healthy.example");
    finish(16);
    await expect(healthy).resolves.toEqual(["8.8.8.8"]);
  });

  it("预先取消的请求不占配额也不启动解析", async () => {
    await expect(
      resolveExternalAddresses("cancelled.example", AbortSignal.abort()),
    ).rejects.toThrow("EXTERNAL_DNS_CANCELLED");
    expect(dns.instances).toHaveLength(0);
  });
});
