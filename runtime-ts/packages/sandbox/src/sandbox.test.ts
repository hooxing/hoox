import { ApiError } from "@cubesandbox/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CubeSandboxGateway,
  type CubeSdkFacade,
  type CubeSdkSandbox,
  usingSandbox,
} from "./cube-gateway.js";
import { SandboxRuntimeError, settledOperation } from "./errors.js";
import { FakeSandboxGateway } from "./testing/fake.js";

describe("Sandbox 稳定适配契约", () => {
  it("阶段 5 create 显式透传 onTimeout=pause 与 autoResume，且不依赖 SDK 默认值", async () => {
    const create = vi.fn(fakeSdk().create);
    const gateway = new CubeSandboxGateway(
      { apiUrl: "http://cube", maxCreateTtlSeconds: 86_400 },
      fakeSdk({ create }),
    );

    await gateway.create({
      templateId: "thread-session-template",
      ttlSeconds: 86_400,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 86_400,
        lifecycle: { onTimeout: "pause", autoResume: true },
      }),
    );
  });

  it("创建 Sandbox 时只允许把 Cube Volume 挂到固定 /resources", async () => {
    const create = vi.fn(fakeSdk().create);
    const gateway = new CubeSandboxGateway({ apiUrl: "http://cube" }, fakeSdk({ create }));

    await gateway.create({
      templateId: "resource-volume-template",
      volumeMounts: [{ name: "tenant-resource-volume", path: "/resources" }],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: {
          volumeMounts: [{ name: "tenant-resource-volume", path: "/resources" }],
        },
      }),
    );
    await expect(
      gateway.create({
        templateId: "resource-volume-template",
        volumeMounts: [{ name: "tenant-resource-volume", path: "/workspace" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("Gateway 显式 API key/null 与代理路由不受 vendor ambient 环境覆盖", async () => {
    const keys = ["CUBE_API_KEY", "E2B_API_KEY", "CUBE_PROXY_NODE_IP"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.CUBE_API_KEY = "ambient-cube-attacker-key";
    process.env.E2B_API_KEY = "ambient-e2b-attacker-key";
    process.env.CUBE_PROXY_NODE_IP = "ambient-proxy.invalid";
    try {
      const declaredCreate = vi.fn(fakeSdk().create);
      const declaredSdk = fakeSdk({ create: declaredCreate });
      await new CubeSandboxGateway(
        {
          apiUrl: "http://cube",
          apiKey: "declared-production-key",
          proxyNodeIp: "declared-proxy.invalid",
        },
        declaredSdk,
      ).create({ templateId: "template-declared" });
      expect(declaredCreate.mock.calls[0]?.[0].config).toMatchObject({
        apiKey: "declared-production-key",
        proxyNodeIp: "declared-proxy.invalid",
      });

      const anonymousCreate = vi.fn(fakeSdk().create);
      const anonymousSdk = fakeSdk({ create: anonymousCreate });
      await new CubeSandboxGateway(
        { apiUrl: "http://cube", apiKey: null, proxyNodeIp: null },
        anonymousSdk,
      ).create({ templateId: "template-anonymous" });
      expect(anonymousCreate.mock.calls[0]?.[0].config).toMatchObject({
        apiKey: null,
        proxyNodeIp: null,
      });
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("无论业务是否失败都清理创建的 Sandbox", async () => {
    const gateway = new FakeSandboxGateway();
    await expect(
      usingSandbox(gateway, { templateId: "fake" }, async (sandbox) => {
        await sandbox.writeFile("/tmp/a.txt", "a");
        throw new Error("业务失败");
      }),
    ).rejects.toThrow("业务失败");
    expect([...gateway.sandboxes.values()][0]?.killed).toBe(true);
  });

  it("真实 Gateway 的不可取消写入会等待 SDK settle，再在安全点返回 CANCELLED", async () => {
    const sdkSandbox = fakeSdkSandbox();
    const originalWrite = sdkSandbox.files.write;
    sdkSandbox.files.write = async (path, data) => {
      await delay(30);
      await originalWrite(path, data);
    };
    const gateway = new CubeSandboxGateway(
      { apiUrl: "http://cube" },
      fakeSdk({ create: async () => sdkSandbox }),
    );
    const sandbox = await gateway.create({ templateId: "fake" });
    const abort = new AbortController();
    let settled = false;
    const writing = sandbox.writeFile("/tmp/late.txt", "late", { signal: abort.signal });
    void writing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    abort.abort();
    await delay(5);
    expect(settled).toBe(false);
    await expect(writing).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await sandbox.readFile("/tmp/late.txt")).toBe("late");
  });

  it("after-settle timeout 不会让迟到副作用覆盖调用结果", async () => {
    let mutated = false;
    const startedAt = Date.now();
    await expect(
      settledOperation(
        "迟到写入",
        async () => {
          await delay(20);
          mutated = true;
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(mutated).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  it("安全点固定采用 CANCELLED > TIMEOUT > UPSTREAM，且覆盖 action 失败", async () => {
    const cancelled = new AbortController();
    const cancelledOperation = settledOperation(
      "取消优先",
      async () => {
        await delay(20);
        throw new Error("remote failed");
      },
      { signal: cancelled.signal, timeoutMs: 5 },
    );
    await delay(2);
    cancelled.abort();
    await expect(cancelledOperation).rejects.toMatchObject({ code: "CANCELLED" });

    await expect(
      settledOperation(
        "超时优先",
        async () => {
          await delay(20);
          throw new Error("remote failed");
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    await expect(
      settledOperation("上游失败", async () => {
        throw new Error("remote failed");
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM" });
  });

  it("在调用 SDK 前拒绝 URL、timeout、TTL、env、命令、代码和路径非法值", async () => {
    expectInvalid(
      () => new CubeSandboxGateway({ apiUrl: "", defaultOperationTimeoutMs: 1 }, fakeSdk()),
    );
    expectInvalid(
      () =>
        new CubeSandboxGateway({ apiUrl: "ftp://cube", defaultOperationTimeoutMs: 1 }, fakeSdk()),
    );
    for (const timeout of [0, -1, Number.NaN]) {
      expectInvalid(
        () =>
          new CubeSandboxGateway(
            { apiUrl: "http://cube", defaultOperationTimeoutMs: timeout },
            fakeSdk(),
          ),
      );
    }

    const create = vi.fn(fakeSdk().create);
    const sdk = fakeSdk({ create });
    const gateway = new CubeSandboxGateway(
      { apiUrl: "http://cube", maxCreateTtlSeconds: 120 },
      sdk,
    );
    for (const ttlSeconds of [0, -1, Number.NaN, 121]) {
      await expect(gateway.create({ templateId: "tpl", ttlSeconds })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    await expect(gateway.create({ templateId: " ", ttlSeconds: 1 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      gateway.create({ templateId: "tpl", ttlSeconds: 1, env: { "": "x" } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      gateway.create({ templateId: "tpl", ttlSeconds: 1, env: { KEY: "" } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(create).not.toHaveBeenCalled();

    const sandbox = await gateway.create({ templateId: "tpl", ttlSeconds: 1 });
    await expect(sandbox.command(" ")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(sandbox.runCode(" ")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(sandbox.readFile("relative")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(sandbox.writeFile("/tmp/../escape", "x")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(sandbox.command("ok", { timeoutMs: 0 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expectInvalid(
      () => new CubeSandboxGateway({ apiUrl: "http://cube", maxCreateTtlSeconds: 86_401 }, sdk),
    );
    expectInvalid(
      () =>
        new CubeSandboxGateway(
          { apiUrl: "http://cube", maxCreateTtlSeconds: 10, timeout: 11 },
          sdk,
        ),
    );
  });

  it("Config/connect TTL 显式受限，UNKNOWN 异步事件记录请求实际 TTL", async () => {
    const events: unknown[] = [];
    const sdk = fakeSdk({
      create: vi.fn(async () => {
        throw new Error("request timed out");
      }),
      connect: vi.fn(async () => fakeSdkSandbox()),
      listV2: vi.fn(async () => []),
    });
    const gateway = new CubeSandboxGateway(
      {
        apiUrl: "http://cube",
        maxCreateTtlSeconds: 10,
        onUncertainLifecycle: async (event) => {
          await delay(10);
          events.push(event);
        },
      },
      sdk,
    );
    await expect(gateway.create({ templateId: "tpl", ttlSeconds: 7 })).rejects.toMatchObject({
      code: "UNKNOWN",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: "create_response",
      actualTtlSeconds: 7,
      requestId: expect.any(String),
    });
    const createOptions = vi.mocked(sdk.create).mock.calls[0]?.[0];
    expect(createOptions).toMatchObject({ timeout: 7 });
    expect(createOptions?.config).toMatchObject({ timeout: 10 });
    expect(sdk.listV2).toHaveBeenCalledTimes(3);
    for (const [config] of vi.mocked(sdk.listV2).mock.calls) {
      expect(config).toMatchObject({ timeout: 10 });
    }

    const connected = await new CubeSandboxGateway(
      { apiUrl: "http://cube", maxCreateTtlSeconds: 9 },
      sdk,
    ).connect("known");
    expect(connected.id).toBe("sdk-fake");
    expect(vi.mocked(sdk.connect).mock.calls.at(-1)?.[1].config).toMatchObject({ timeout: 9 });
  });

  it("create 超时但对账找到资源时执行 kill，并保留原始 TIMEOUT 语义", async () => {
    let requestId = "";
    const killed = vi.fn(async () => undefined);
    const reconciled = { ...fakeSdkSandbox(), sandboxId: "late-sandbox", kill: killed };
    const events: unknown[] = [];
    const sdk = fakeSdk({
      create: vi.fn(async (options) => {
        requestId = String(options.metadata?.agentRuntimeCreateRequestId);
        throw new Error("request timeout");
      }),
      listV2: vi.fn(async () => [
        {
          sandboxID: "late-sandbox",
          metadata: { agentRuntimeCreateRequestId: requestId },
        },
      ]),
      connect: vi.fn(async () => reconciled),
    });
    const gateway = new CubeSandboxGateway(
      {
        apiUrl: "http://cube",
        onUncertainLifecycle: (event) => {
          events.push(event);
        },
      },
      sdk,
    );
    await expect(gateway.create({ templateId: "tpl" })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(killed).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });

  it("ResourceFS Volume attach 被 CubeMaster 明确拒绝时不误报 UNKNOWN", async () => {
    const events: unknown[] = [];
    const sdk = fakeSdk({
      create: vi.fn(async () => {
        throw new ApiError(
          'CubeMaster returned error code 130545: plugin_volume "tenant-a" (driver=runtime-resourcefs): attach: {"error":"RESOURCEFS_VOLUME_PLUGIN_FAILED"}',
          500,
        );
      }),
      listV2: vi.fn(async () => []),
    });
    const gateway = new CubeSandboxGateway(
      {
        apiUrl: "http://cube",
        onUncertainLifecycle: (event) => {
          events.push(event);
        },
      },
      sdk,
    );

    await expect(
      gateway.create({
        templateId: "tpl",
        volumeMounts: [{ name: "tenant-a", path: "/resources" }],
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_VOLUME_FAILED" });
    expect(sdk.listV2).toHaveBeenCalledTimes(3);
    expect(events).toEqual([]);
  });

  it("create 已知 ID 后清理失败时分别记录 requestId、sandboxId、实际 TTL 和阶段", async () => {
    let requestId = "";
    const abort = new AbortController();
    const events: unknown[] = [];
    const sandbox = { ...fakeSdkSandbox(), sandboxId: "cleanup-failed" };
    sandbox.kill = vi.fn(async () => {
      throw new Error("kill failed");
    });
    const sdk = fakeSdk({
      create: vi.fn(async (options) => {
        requestId = String(options.metadata?.agentRuntimeCreateRequestId);
        await delay(20);
        return sandbox;
      }),
    });
    const gateway = new CubeSandboxGateway(
      {
        apiUrl: "http://cube",
        onUncertainLifecycle: async (event) => {
          await delay(5);
          events.push(event);
        },
      },
      sdk,
    );
    const creating = gateway.create({ templateId: "tpl", ttlSeconds: 8 }, { signal: abort.signal });
    await delay(2);
    abort.abort();
    await expect(creating).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stage: "cleanup_after_create",
      requestId,
      sandboxId: "cleanup-failed",
      actualTtlSeconds: 8,
    });
  });

  it("command/runCode 拒绝畸形 SDK 响应并只返回稳定 PROTOCOL", async () => {
    const sdkSandbox = fakeSdkSandbox();
    sdkSandbox.commands.run = async () => ({ stdout: [], stderr: "", exitCode: "0" });
    sdkSandbox.runCode = async () => ({
      text: 42,
      logs: { stdout: ["ok"], stderr: [] },
      error: null,
      privateAddress: "do-not-leak",
    });
    const sandbox = await new CubeSandboxGateway(
      { apiUrl: "http://cube" },
      fakeSdk({ create: async () => sdkSandbox }),
    ).create({ templateId: "tpl" });
    for (const operation of [sandbox.command("ok"), sandbox.runCode("1 + 1")]) {
      await expect(operation).rejects.toMatchObject({ code: "PROTOCOL" });
      await expect(operation).rejects.not.toThrow("do-not-leak");
    }
  });
});

function fakeSdk(overrides: Partial<CubeSdkFacade> = {}): CubeSdkFacade {
  const sandbox = fakeSdkSandbox();
  return {
    create: async () => sandbox,
    connect: async () => sandbox,
    listV2: async () => [],
    ...overrides,
  };
}

function fakeSdkSandbox(): CubeSdkSandbox {
  const files = new Map<string, string>();
  return {
    sandboxId: "sdk-fake",
    commands: { run: async (command) => ({ stdout: command, stderr: "", exitCode: 0 }) },
    runCode: async (code) => ({ text: code, logs: { stdout: [], stderr: [] }, error: null }),
    files: {
      read: async (path) => files.get(path) ?? "",
      write: async (path, data) => {
        files.set(path, String(data));
      },
      list: async () => [],
      stat: async () => ({ type: "FILE_TYPE_DIRECTORY" }),
      remove: async () => undefined,
      rename: async () => ({}),
      makeDir: async () => ({ type: "FILE_TYPE_DIRECTORY" }),
    },
    pause: async () => undefined,
    kill: async () => undefined,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function expectInvalid(action: () => unknown): void {
  try {
    action();
    throw new Error("预期抛出 INVALID_ARGUMENT");
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxRuntimeError);
    expect(error).toMatchObject({ code: "INVALID_ARGUMENT" });
  }
}
