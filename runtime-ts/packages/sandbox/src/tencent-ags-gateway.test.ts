import { type SandboxInfo, SandboxError } from "e2b";
import { describe, expect, it, vi } from "vitest";
import type { E2BSdkFacade, E2BSdkSandbox } from "./e2b-gateway.js";
import { TencentAgsSandboxGateway } from "./tencent-ags-gateway.js";

const options = { apiKey: "test-ags-key", domain: "ags.example.invalid" };

describe("腾讯云 AGS 兼容边界", () => {
  it("独立身份和显式凭据，不发送未经确认的生命周期扩展", async () => {
    const create = vi.fn(fakeFacade().create);
    const gateway = new TencentAgsSandboxGateway(options, fakeFacade({ create }));
    expect(gateway.providerKey).toBe("tencent-ags");
    await gateway.create({
      templateId: "hoox",
      ttlSeconds: 300,
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
    expect(create.mock.calls[0]?.[1]).toMatchObject({ ...options, timeoutMs: 300_000 });
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty("lifecycle");
    expect(create.mock.calls[0]?.[1].metadata?.agentRuntimeCreateRequestId).toBeTruthy();
    await expect(
      gateway.create({ templateId: "hoox", lifecycle: { onTimeout: "pause", autoResume: true } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      gateway.create({
        templateId: "hoox",
        volumeMounts: [{ name: "cube-volume", path: "/resources" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("AGS 域名必填且不接受 URL", () => {
    expect(() => new TencentAgsSandboxGateway({ ...options, domain: "" })).toThrow("Domain");
    expect(
      () => new TencentAgsSandboxGateway({ ...options, domain: "https://ags.example.invalid" }),
    ).toThrow("Domain");
  });

  it.each(["pausing", "resuming", "pause_failed", "resume_failed", "stopping", "new_state"])(
    "扩展状态 %s 阻止按兼容 running 复用实例",
    async (state) => {
      const connect = vi.fn(fakeFacade().connect);
      const getInfo = async () => ({
        ...info("running"),
        metadata: { "x-ags-sandbox-state": state },
      });
      const gateway = new TencentAgsSandboxGateway(options, fakeFacade({ getInfo, connect }));
      await expect(gateway.inspect("sbi-test")).resolves.toBe("unknown");
      await expect(gateway.connect("sbi-test")).rejects.toMatchObject({ code: "UNKNOWN" });
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it.each(["stopped", "failed", "starting_failed"])("确定终态 %s 归一化为不存在", async (state) => {
    const gateway = new TencentAgsSandboxGateway(
      options,
      fakeFacade({
        getInfo: async () => ({ ...info("running"), metadata: { "x-ags-sandbox-state": state } }),
      }),
    );
    await expect(gateway.inspect("sbi-test")).resolves.toBe("not_found");
    await expect(gateway.connect("sbi-test")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("暂停使用标准接口，恢复后必须确认 running", async () => {
    const sandbox = fakeSandbox();
    sandbox.pause = vi.fn(async () => true);
    const getInfo = vi
      .fn<E2BSdkFacade["getInfo"]>()
      .mockResolvedValueOnce(info("paused"))
      .mockResolvedValueOnce(info("running"));
    const gateway = new TencentAgsSandboxGateway(
      options,
      fakeFacade({ create: async () => sandbox, connect: async () => sandbox, getInfo }),
    );
    const handle = await gateway.create({ templateId: "hoox" });
    await handle.pause();
    expect(sandbox.pause).toHaveBeenCalledWith(expect.not.objectContaining({ keepMemory: true }));
    const resumed = await gateway.connect("sbi-test");
    await expect(resumed.command("ok")).resolves.toMatchObject({ stdout: "ok" });
  });

  it("Workspace 连接在过渡态时不调用远端 connect", async () => {
    const connect = vi.fn(fakeFacade().connect);
    const gateway = new TencentAgsSandboxGateway(
      options,
      fakeFacade({
        connect,
        getInfo: async () => ({
          ...info("running"),
          metadata: { "x-ags-sandbox-state": "pausing" },
        }),
      }),
    );
    await expect(
      gateway.connectWorkspace(
        {
          current: async () => ({
            sessionId: "sbi-test",
            generation: 1,
            scope: {
              tenantId: "tenant-test",
              threadId: "thread-test",
              workspaceId: "workspace-test",
            },
          }),
        },
        {
          maxEntries: 16,
          maxFileBytes: 1024,
          maxTotalBytes: 4096,
          maxPathUtf8Bytes: 256,
          maxCommandOutputBytes: 4096,
          readChunkBytes: 4,
          maxSnapshots: 4,
          operationTimeoutMs: 1000,
        },
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("连接返回但实例仍 paused 时不交付可用句柄", async () => {
    const gateway = new TencentAgsSandboxGateway(
      options,
      fakeFacade({ getInfo: async () => info("paused") }),
    );
    await expect(gateway.connect("sbi-test")).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("状态查询消耗连接总预算，不能延长远端操作租约", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const connect = vi.fn(fakeFacade().connect);
    const gateway = new TencentAgsSandboxGateway(
      options,
      fakeFacade({
        connect,
        getInfo: async () => {
          clock.mockReturnValue(1_101);
          return info("running");
        },
      }),
    );
    try {
      await expect(gateway.connect("sbi-test", { timeoutMs: 100 })).rejects.toMatchObject({
        code: "TIMEOUT",
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("创建响应丢失保留 AGS 对账身份，不能记成 E2B", async () => {
    const record = vi.fn();
    const gateway = new TencentAgsSandboxGateway(
      { ...options, onUncertainLifecycle: record },
      fakeFacade({
        create: async () => {
          throw new SandboxError("connection lost");
        },
      }),
    );
    await expect(gateway.create({ templateId: "hoox", ttlSeconds: 30 })).rejects.toMatchObject({
      code: "UNKNOWN",
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: "tencent-ags", actualTtlSeconds: 30 }),
    );
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
