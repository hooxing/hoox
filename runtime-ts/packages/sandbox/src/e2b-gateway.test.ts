import { describe, expect, it, vi } from "vitest";
import type { SandboxInfo, SandboxOpts } from "e2b";
import { E2BSandboxGateway, type E2BSdkFacade, type E2BSdkSandbox } from "./e2b-gateway.js";
import { SandboxRuntimeError } from "./errors.js";

const API_KEY = "test-e2b-api-key";

describe("E2B Sandbox Provider 适配", () => {
  it("create 显式透传凭据、TTL、生命周期、环境、Volume 与对账 metadata", async () => {
    const create = vi.fn(fakeFacade().create);
    const gateway = new E2BSandboxGateway(
      { apiKey: API_KEY, domain: "e2b.example.invalid", maxCreateTtlSeconds: 600 },
      fakeFacade({ create }),
    );

    await gateway.create({
      templateId: "agent-template",
      ttlSeconds: 300,
      env: { RUNTIME_MODE: "test" },
      lifecycle: { onTimeout: "pause", autoResume: true },
      volumeMounts: [{ name: "volume-a", path: "/resources" }],
    });

    const options = create.mock.calls[0]?.[1];
    expect(options).toMatchObject({
      apiKey: API_KEY,
      domain: "e2b.example.invalid",
      timeoutMs: 300_000,
      envs: { RUNTIME_MODE: "test" },
      lifecycle: { onTimeout: "pause", autoResume: true },
      volumeMounts: { "/resources": "volume-a" },
    });
    expect(options?.metadata?.agentRuntimeCreateRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("显式 API Key 不读取 ambient E2B_API_KEY", async () => {
    const previous = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = "ambient-attacker-key";
    try {
      const create = vi.fn(fakeFacade().create);
      await new E2BSandboxGateway({ apiKey: API_KEY }, fakeFacade({ create })).create({
        templateId: "agent-template",
      });
      expect(create.mock.calls[0]?.[1].apiKey).toBe(API_KEY);
    } finally {
      if (previous === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = previous;
    }
  });

  it("command、runCode 与 files 统一实现 SandboxHandle", async () => {
    const sdkSandbox = fakeSandbox();
    const sandbox = await new E2BSandboxGateway(
      { apiKey: API_KEY },
      fakeFacade({ create: async () => sdkSandbox }),
    ).create({ templateId: "agent-template" });

    expect(await sandbox.command("printf ok")).toEqual({
      stdout: "printf ok",
      stderr: "",
      exitCode: 0,
    });
    expect(await sandbox.runCode("print('ok')", { language: "python" })).toMatchObject({
      stdout: ["python-result"],
      text: "python-result",
    });
    await sandbox.writeFile("/tmp/a.txt", new TextEncoder().encode("hello"));
    expect(await sandbox.readFile("/tmp/a.txt")).toBe("hello");
  });

  it("inspect 保留 running、paused 与 not_found 稳定状态", async () => {
    const getInfo = vi
      .fn<E2BSdkFacade["getInfo"]>()
      .mockResolvedValueOnce(info("running"))
      .mockResolvedValueOnce(info("paused"))
      .mockRejectedValueOnce(new Error("sandbox not found"));
    const gateway = new E2BSandboxGateway({ apiKey: API_KEY }, fakeFacade({ getInfo }));

    await expect(gateway.inspect("sandbox-a")).resolves.toBe("running");
    await expect(gateway.inspect("sandbox-a")).resolves.toBe("paused");
    await expect(gateway.inspect("sandbox-a")).resolves.toBe("not_found");
  });

  it("create 返回后收到取消会等待并清理已创建实例", async () => {
    const abort = new AbortController();
    const sdkSandbox = fakeSandbox();
    const create = vi.fn(async () => {
      await delay(20);
      return sdkSandbox;
    });
    const gateway = new E2BSandboxGateway({ apiKey: API_KEY }, fakeFacade({ create }));
    const creating = gateway.create({ templateId: "agent-template" }, { signal: abort.signal });
    await delay(2);
    abort.abort();

    await expect(creating).rejects.toMatchObject({ code: "CANCELLED" });
    expect(sdkSandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("create 响应丢失时按 request metadata 对账并清理，避免双重创建", async () => {
    let requestId = "";
    const reconciled = fakeSandbox("reconciled-sandbox");
    const create = vi.fn(async (_template: string, options: SandboxOpts) => {
      requestId = String(options.metadata?.agentRuntimeCreateRequestId);
      throw new Error("request timeout");
    });
    const list = vi.fn(async () => [info("running", "reconciled-sandbox", requestId)]);
    const gateway = new E2BSandboxGateway(
      { apiKey: API_KEY },
      fakeFacade({ create, list, connect: async () => reconciled }),
    );

    await expect(gateway.create({ templateId: "agent-template" })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(reconciled.kill).toHaveBeenCalledTimes(1);
  });

  it("create 无法对账时记录 UNKNOWN，且告警中不包含 API Key", async () => {
    const events: unknown[] = [];
    const gateway = new E2BSandboxGateway(
      {
        apiKey: API_KEY,
        onUncertainLifecycle: (event) => {
          events.push(event);
        },
      },
      fakeFacade({
        create: async () => {
          throw new Error(`request failed with ${API_KEY}`);
        },
        list: async () => [],
      }),
    );

    const operation = gateway.create({ templateId: "agent-template", ttlSeconds: 9 });
    await expect(operation).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(operation).rejects.not.toThrow(API_KEY);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "sandbox_create_outcome_unknown",
      stage: "create_response",
      actualTtlSeconds: 9,
    });
    expect(JSON.stringify(events)).not.toContain(API_KEY);
  });

  it("拒绝畸形 command 响应且不透出上游私有字段", async () => {
    const sdkSandbox = fakeSandbox();
    sdkSandbox.commands.run = async () => ({
      stdout: [],
      stderr: "",
      exitCode: "0",
      privateAddress: "do-not-leak",
    });
    const sandbox = await new E2BSandboxGateway(
      { apiKey: API_KEY },
      fakeFacade({ create: async () => sdkSandbox }),
    ).create({ templateId: "agent-template" });
    const operation = sandbox.command("true");
    await expect(operation).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(operation).rejects.not.toThrow("do-not-leak");
  });
  it("拒绝空凭据、非法 Domain、生命周期与 TypeScript 伪兼容", async () => {
    expectInvalid(() => new E2BSandboxGateway({ apiKey: " " }));
    expectInvalid(() => new E2BSandboxGateway({ apiKey: API_KEY, domain: "https://e2b.dev" }));
    const gateway = new E2BSandboxGateway({ apiKey: API_KEY }, fakeFacade());
    await expect(
      gateway.create({
        templateId: "agent-template",
        lifecycle: { onTimeout: "kill", autoResume: true },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const sandbox = await gateway.create({ templateId: "agent-template" });
    await expect(
      sandbox.runCode("const value: number = 1", { language: "typescript" }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

function fakeFacade(overrides: Partial<E2BSdkFacade> = {}): E2BSdkFacade {
  const sandbox = fakeSandbox();
  return {
    create: async () => sandbox,
    connect: async () => sandbox,
    getInfo: async () => info("running"),
    list: async () => [],
    ...overrides,
  };
}

function fakeSandbox(
  sandboxId = "e2b-sandbox",
): E2BSdkSandbox & { kill: ReturnType<typeof vi.fn> } {
  const files = new Map<string, string>();
  const kill = vi.fn(async () => true);
  return {
    sandboxId,
    commands: {
      run: async (command) => ({
        stdout: command.startsWith("python3 -c") ? "python-result\n" : command,
        stderr: "",
        exitCode: 0,
      }),
    },
    files: {
      read: async (path) => files.get(path) ?? "",
      write: async (path, data) => {
        files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      list: async () => [],
      getInfo: async (path) => ({ name: path.split("/").at(-1) ?? "", path, type: "file" }),
      remove: async () => undefined,
      rename: async (_oldPath, newPath) => ({ name: newPath, path: newPath, type: "file" }),
      makeDir: async () => true,
    },
    pause: async () => true,
    kill,
  };
}

function info(
  state: "running" | "paused",
  sandboxId = "e2b-sandbox",
  requestId?: string,
): SandboxInfo {
  return {
    sandboxId,
    templateId: "agent-template",
    metadata: requestId === undefined ? {} : { agentRuntimeCreateRequestId: requestId },
    startedAt: new Date(0),
    endAt: new Date(60_000),
    state,
    cpuCount: 2,
    memoryMB: 512,
    envdVersion: "v1",
  };
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
