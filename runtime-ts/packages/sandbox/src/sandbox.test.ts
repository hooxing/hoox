import { describe, expect, it, vi } from "vitest";
import {
  CubeSandboxGateway,
  type CubeSdkFacade,
  type CubeSdkSandbox,
  usingSandbox,
} from "./cube-gateway.js";
import { SandboxRuntimeError, settledOperation } from "./errors.js";
import { FakeSandboxGateway } from "./fake.js";

describe("Sandbox 稳定适配契约", () => {
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

  it("不可取消写入会等待 settle，再在安全点返回 CANCELLED", async () => {
    const gateway = new FakeSandboxGateway(30);
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
  });

  it("create 响应丢失时先对账；无法确认则返回 UNKNOWN、短 TTL 并记录指标", async () => {
    const events: unknown[] = [];
    const sdk = fakeSdk({
      create: vi.fn(async () => {
        throw new Error("request timed out");
      }),
      listV2: vi.fn(async () => []),
    });
    const gateway = new CubeSandboxGateway(
      {
        apiUrl: "http://cube",
        maxCreateTtlSeconds: 10,
        onUncertainLifecycle: (event) => events.push(event),
      },
      sdk,
    );
    await expect(gateway.create({ templateId: "tpl" })).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(events).toHaveLength(1);
    expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ timeout: 10 }));
    expect(sdk.listV2).toHaveBeenCalledTimes(3);
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
        onUncertainLifecycle: (event) => events.push(event),
      },
      sdk,
    );
    await expect(gateway.create({ templateId: "tpl" })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(killed).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
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
