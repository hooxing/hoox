import type {
  PgClaimedRunDispatch,
  PgClaimedWorkerTenantAssignment,
} from "@cube-runtime/persistence";
import type { ExecutionScope, SandboxSessionRef } from "@cube-runtime/run-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AgentWorkerPollingLoop,
  CubeSandboxSessionRegistry,
  DatabaseRunCancellation,
  E2BSandboxSessionRegistry,
  FailClosedWorkspaceRevisionVerifier,
  ProcessShutdown,
  ProviderSandboxSessionRegistry,
} from "./production-worker-runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function claim(): PgClaimedRunDispatch {
  return {
    outboxId: "outbox-worker-loop",
    generation: 1,
    claimToken: "dispatch-claim-worker-loop",
    scope: {
      tenantId: "tenant-worker-loop",
      threadId: "thread-worker-loop",
      runId: "run-worker-loop",
      rootRunId: "run-worker-loop",
      workspaceId: "workspace-worker-loop",
    },
  };
}

function tenantAssignment(): PgClaimedWorkerTenantAssignment {
  return {
    tenantId: "tenant-worker-loop",
    generation: 1,
    claimToken: "tenant-claim-worker-loop",
    workerId: "worker-loop",
  };
}

describe("Agent Worker production polling loop", () => {
  it("领取 durable dispatch 后执行 RunWorker 并以同一 dispatch fence 确认终态", async () => {
    const acknowledged = deferred<void>();
    const expected = claim();
    let claimed = false;
    const acknowledgements: unknown[] = [];
    const settled: PgClaimedWorkerTenantAssignment[] = [];
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => (claimed ? undefined : tenantAssignment()),
        settle: async (assignment) => {
          settled.push(assignment);
          return true;
        },
      },
      {
        claim: async () => {
          if (claimed) return [];
          claimed = true;
          return [expected];
        },
        acknowledge: async (input) => {
          acknowledgements.push(input);
          acknowledged.resolve(undefined);
        },
      },
      { execute: async () => ({ outcome: "succeeded" }) },
      {
        workerId: "worker-loop",
        pollIntervalMs: 10,
        tenantAssignmentLeaseMs: 30_000,
        dispatchLeaseMs: 30_000,
      },
    );
    loop.start();
    await acknowledged.promise;
    await loop.close();
    expect(acknowledgements).toEqual([{ claim: expected, outcome: "terminal" }]);
    expect(settled).toEqual([tenantAssignment()]);
  });

  it("在模型执行前释放 Tenant 调度租约，避免同团队不同 Thread 被长任务串行化", async () => {
    const executionStarted = deferred<void>();
    const finishExecution = deferred<void>();
    const events: string[] = [];
    let assignmentClaimed = false;
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => {
          if (assignmentClaimed) return undefined;
          assignmentClaimed = true;
          return tenantAssignment();
        },
        settle: async () => {
          events.push("settle-assignment");
          return true;
        },
      },
      {
        claim: async () => {
          events.push("claim-dispatch");
          return [claim()];
        },
        acknowledge: async () => undefined,
      },
      {
        execute: async () => {
          events.push("execute-run");
          executionStarted.resolve();
          await finishExecution.promise;
          return { outcome: "succeeded" };
        },
      },
      {
        workerId: "worker-loop",
        pollIntervalMs: 10,
        tenantAssignmentLeaseMs: 30_000,
        dispatchLeaseMs: 30_000,
      },
    );

    loop.start();
    await executionStarted.promise;
    expect(events).toEqual(["claim-dispatch", "settle-assignment", "execute-run"]);
    finishExecution.resolve();
    await loop.close();
  });

  it("Tenant 控制面领取失败时不进入任何业务 Tenant 队列", async () => {
    const claimAttempted = deferred<void>();
    let dispatchClaims = 0;
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => {
          claimAttempted.resolve();
          throw new Error("控制面暂时不可用");
        },
        settle: async () => true,
      },
      {
        claim: async () => {
          dispatchClaims += 1;
          return [];
        },
        acknowledge: async () => undefined,
      },
      { execute: async () => ({ outcome: "succeeded" }) },
      {
        workerId: "worker-loop",
        pollIntervalMs: 10,
        tenantAssignmentLeaseMs: 30_000,
        dispatchLeaseMs: 30_000,
      },
    );

    loop.start();
    await claimAttempted.promise;
    await loop.close();
    expect(dispatchClaims).toBe(0);
  });

  it("Tenant settle 暂时失败不丢弃已经取得的 dispatch", async () => {
    const acknowledged = deferred<void>();
    let assignmentClaimed = false;
    let executions = 0;
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => {
          if (assignmentClaimed) return undefined;
          assignmentClaimed = true;
          return tenantAssignment();
        },
        settle: async () => {
          throw new Error("settle 暂时不可用");
        },
      },
      {
        claim: async () => [claim()],
        acknowledge: async () => acknowledged.resolve(),
      },
      {
        execute: async () => {
          executions += 1;
          return { outcome: "succeeded" };
        },
      },
      {
        workerId: "worker-loop",
        pollIntervalMs: 10,
        tenantAssignmentLeaseMs: 30_000,
        dispatchLeaseMs: 30_000,
      },
    );

    loop.start();
    await acknowledged.promise;
    await loop.close();
    expect(executions).toBe(1);
  });

  it("stopAccepting 停止新领取并等待在途 RunWorker 与 ack 完成", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const closed = deferred<void>();
    let claimCount = 0;
    let ackCount = 0;
    let assignmentClaimed = false;
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => {
          if (assignmentClaimed) return undefined;
          assignmentClaimed = true;
          return tenantAssignment();
        },
        settle: async () => true,
      },
      {
        claim: async () => {
          claimCount += 1;
          return claimCount === 1 ? [claim()] : [];
        },
        acknowledge: async () => {
          ackCount += 1;
        },
      },
      {
        execute: async () => {
          started.resolve();
          await finish.promise;
          return { outcome: "succeeded" };
        },
      },
      {
        workerId: "worker-loop",
        pollIntervalMs: 10,
        tenantAssignmentLeaseMs: 30_000,
        dispatchLeaseMs: 30_000,
      },
    );
    loop.start();
    await started.promise;
    let didClose = false;
    void loop.close().then(() => {
      didClose = true;
      closed.resolve();
    });
    await Promise.resolve();
    expect(didClose).toBe(false);
    finish.resolve();
    await closed.promise;
    expect(claimCount).toBe(1);
    expect(ackCount).toBe(1);
  });

  it("claim 在关闭后才返回时只 defer，不执行 RunWorker", async () => {
    const pendingClaim = deferred<readonly PgClaimedRunDispatch[]>();
    const claimStarted = deferred<void>();
    const acknowledged = deferred<void>();
    const expected = claim();
    let executions = 0;
    const acknowledgements: unknown[] = [];
    let assignmentClaimed = false;
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => {
          if (assignmentClaimed) return undefined;
          assignmentClaimed = true;
          return tenantAssignment();
        },
        settle: async () => true,
      },
      {
        claim: async () => {
          claimStarted.resolve();
          return pendingClaim.promise;
        },
        acknowledge: async (input) => {
          acknowledgements.push(input);
          acknowledged.resolve();
        },
      },
      {
        execute: async () => {
          executions += 1;
          return { outcome: "succeeded" };
        },
      },
      {
        workerId: "worker-loop",
        pollIntervalMs: 10,
        tenantAssignmentLeaseMs: 30_000,
        dispatchLeaseMs: 30_000,
      },
    );
    loop.start();
    await claimStarted.promise;
    const closing = loop.close();
    pendingClaim.resolve([expected]);
    await acknowledged.promise;
    await closing;
    expect(executions).toBe(0);
    expect(acknowledgements).toEqual([
      { claim: expected, outcome: "defer", retryAfterMilliseconds: 1_000 },
    ]);
  });

  it("durable maintenance 失败不阻塞 dispatch，并在下一 tick 重试", async () => {
    const recovered = deferred<void>();
    let maintenanceCalls = 0;
    let claimCalls = 0;
    const loop = new AgentWorkerPollingLoop(
      {
        claim: async () => tenantAssignment(),
        settle: async () => true,
      },
      {
        claim: async () => {
          claimCalls += 1;
          return [];
        },
        acknowledge: async () => undefined,
      },
      { execute: async () => ({ outcome: "succeeded" }) },
      {
        workerId: "worker-loop",
        pollIntervalMs: 10,
        tenantAssignmentLeaseMs: 30_000,
        dispatchLeaseMs: 30_000,
        maintenance: async (tenantId) => {
          expect(tenantId).toBe("tenant-worker-loop");
          maintenanceCalls += 1;
          if (maintenanceCalls === 1) throw new Error("维护依赖暂时不可用");
          recovered.resolve();
        },
      },
    );

    loop.start();
    await recovered.promise;
    await loop.close();
    expect(maintenanceCalls).toBeGreaterThanOrEqual(2);
    expect(claimCalls).toBeGreaterThanOrEqual(2);
  });

  it("进程停机信号与业务取消信号相互独立", () => {
    const shutdown = new ProcessShutdown();
    const cancellation = new DatabaseRunCancellation();
    const scope = claim().scope as ExecutionScope;
    const businessSignal = cancellation.signalFor(scope);

    shutdown.request();

    expect(shutdown.signal.aborted).toBe(true);
    expect(businessSignal.aborted).toBe(false);
    cancellation.release(scope);
  });

  it("轮询到数据库 Run cancelled 后实时中止业务信号并允许释放", async () => {
    let cancelled = false;
    const probe = vi.fn(async () => cancelled);
    const cancellation = new DatabaseRunCancellation(probe, 10);
    const scope = claim().scope as ExecutionScope;
    const businessSignal = cancellation.signalFor(scope);

    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    cancelled = true;
    await vi.waitFor(() => expect(businessSignal.aborted).toBe(true));

    cancellation.release(scope);
  });
});

describe("Sandbox 开发执行预检", () => {
  it("覆盖管理面、模板创建、数据面命令并始终清理临时 Sandbox", async () => {
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080", defaultOperationTimeoutMs: 5_000 },
      "template-development-preflight",
      120,
      90_000,
      { ensure: vi.fn(), probe: vi.fn(async () => undefined) },
    );
    const probe = vi.spyOn(registry.gateway, "probe").mockResolvedValue();
    const command = vi.fn(async () => ({
      stdout: "cube-runtime-sandbox-ready",
      stderr: "",
      exitCode: 0,
    }));
    const kill = vi.fn(async () => undefined);
    const create = vi.spyOn(registry.gateway, "create").mockResolvedValue({
      id: "sandbox-development-preflight",
      command,
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill,
    });

    await expect(registry.probeExecution()).resolves.toBeUndefined();

    expect(probe).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      { templateId: "template-development-preflight", ttlSeconds: 30 },
      { timeoutMs: 90_000 },
    );
    expect(command).toHaveBeenCalledWith("printf cube-runtime-sandbox-ready", {
      timeoutMs: 5_000,
    });
    expect(kill).toHaveBeenCalledWith({ timeoutMs: 90_000, ignoreNotFound: true });
  });

  it("数据面返回异常时仍清理临时 Sandbox并使预检失败", async () => {
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080" },
      "template-development-preflight-failed",
    );
    vi.spyOn(registry.gateway, "probe").mockResolvedValue();
    const kill = vi.fn(async () => undefined);
    vi.spyOn(registry.gateway, "create").mockResolvedValue({
      id: "sandbox-development-preflight-failed",
      command: async () => ({ stdout: "wrong", stderr: "", exitCode: 0 }),
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill,
    });

    await expect(registry.probeExecution()).rejects.toMatchObject({ code: "PROTOCOL" });
    expect(kill).toHaveBeenCalledOnce();
  });
});

describe("生产 Workspace revision 安全下限", () => {
  it("Sandbox 只在附件要求 ResourceFS 时确保 Tenant Cube Volume 并绑定 /resources", async () => {
    const ensure = vi.fn(async () => ({
      name: "tenant-worker-loop",
      path: "/resources" as const,
    }));
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080" },
      "template-resource-volume",
      120,
      90_000,
      { ensure, probe: async () => undefined },
    );
    const sandbox = {
      id: "sandbox-resource-volume",
      command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill: async () => undefined,
    };
    const create = vi.spyOn(registry.gateway, "create").mockResolvedValue(sandbox);
    const scope = claim().scope as ExecutionScope;

    await expect(
      registry.acquire({
        scope,
        signal: new AbortController().signal,
        requiresResourceFilesystem: true,
      }),
    ).resolves.toMatchObject({ outcome: "ready" });

    expect(ensure).toHaveBeenCalledWith({ tenantId: scope.tenantId, signal: expect.anything() });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        volumeMounts: [{ name: "tenant-worker-loop", path: "/resources" }],
      }),
      expect.objectContaining({ timeoutMs: 90_000 }),
    );

    ensure.mockClear();
    create.mockClear();
    await expect(
      registry.acquire({
        scope,
        signal: new AbortController().signal,
        requiresResourceFilesystem: false,
      }),
    ).resolves.toMatchObject({ outcome: "ready" });
    expect(ensure).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ volumeMounts: expect.anything() }),
      expect.objectContaining({ timeoutMs: 90_000 }),
    );
  });

  it("Sandbox 创建显式使用 lifecycle 超时，不被 Gateway 的五秒普通操作上限截断", async () => {
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080", defaultOperationTimeoutMs: 5_000 },
      "template-create-lifecycle-timeout",
      120,
      90_000,
    );
    const create = vi.spyOn(registry.gateway, "create").mockResolvedValue({
      id: "sandbox-create-lifecycle-timeout",
      command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill: async () => undefined,
    });
    const signal = new AbortController().signal;

    await expect(
      registry.create({
        scope: claim().scope as ExecutionScope,
        registryId: "registry-create-lifecycle-timeout",
        signal,
        requiresResourceFilesystem: false,
      }),
    ).resolves.toMatchObject({ outcome: "ready" });

    expect(create).toHaveBeenCalledWith(expect.anything(), { signal, timeoutMs: 90_000 });
  });

  it("Thread Sandbox 仅按显式附件需求挂载 ResourceFS", async () => {
    const ensure = vi.fn(async () => ({
      name: "tenant-thread-resource",
      path: "/resources" as const,
    }));
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080" },
      "template-thread-resource",
      120,
      90_000,
      { ensure, probe: async () => undefined },
    );
    const create = vi.spyOn(registry.gateway, "create").mockImplementation(async () => ({
      id: `sandbox-thread-resource-${create.mock.calls.length}`,
      command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill: async () => undefined,
    }));
    const scope = claim().scope as ExecutionScope;
    const signal = new AbortController().signal;

    await expect(
      registry.create({
        scope,
        registryId: "thread-registry-without-resource",
        signal,
        requiresResourceFilesystem: false,
      }),
    ).resolves.toMatchObject({ outcome: "ready" });
    expect(ensure).not.toHaveBeenCalled();
    expect(create).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ volumeMounts: expect.anything() }),
      expect.anything(),
    );

    await expect(
      registry.create({
        scope,
        registryId: "thread-registry-with-resource",
        signal,
        requiresResourceFilesystem: true,
      }),
    ).resolves.toMatchObject({ outcome: "ready" });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        volumeMounts: [{ name: "tenant-thread-resource", path: "/resources" }],
      }),
      expect.anything(),
    );
  });

  it("附件要求 ResourceFS 但未配置 Volume provider 时失败关闭", async () => {
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080" },
      "template-resource-required",
    );
    const create = vi.spyOn(registry.gateway, "create");
    const scope = claim().scope as ExecutionScope;
    const signal = new AbortController().signal;

    await expect(
      registry.acquire({ scope, signal, requiresResourceFilesystem: true }),
    ).resolves.toEqual({ outcome: "failed", code: "SANDBOX_FAILED" });
    await expect(
      registry.create({
        scope,
        registryId: "thread-registry-resource-required",
        signal,
        requiresResourceFilesystem: true,
      }),
    ).resolves.toEqual({ outcome: "failed", code: "SANDBOX_FAILED" });
    expect(create).not.toHaveBeenCalled();
  });

  it("Sandbox 连接同样显式使用 lifecycle 超时", async () => {
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080", defaultOperationTimeoutMs: 5_000 },
      "template-connect-lifecycle-timeout",
      120,
      90_000,
    );
    const connect = vi.spyOn(registry.gateway, "connect").mockResolvedValue({
      id: "sandbox-connect-lifecycle-timeout",
      command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill: async () => undefined,
    });
    const signal = new AbortController().signal;

    await expect(
      registry.connect({
        scope: claim().scope as ExecutionScope,
        registryId: "registry-connect-lifecycle-timeout",
        providerKey: "cube",
        providerSandboxId: "sandbox-connect-lifecycle-timeout",
        signal,
      }),
    ).resolves.toMatchObject({ outcome: "ready" });

    expect(connect).toHaveBeenCalledWith("sandbox-connect-lifecycle-timeout", {
      signal,
      timeoutMs: 90_000,
    });
  });

  it("Sandbox 收尾使用 lifecycle 专用超时，不继承普通命令的短超时", async () => {
    const controls: unknown[] = [];
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080", defaultOperationTimeoutMs: 5_000 },
      "template-lifecycle-timeout",
      120,
      90_000,
    );
    const result = await registry.settle({
      scope: claim().scope as ExecutionScope,
      cleanupIntentId: "cleanup-lifecycle-timeout",
      disposition: "pause",
      session: {
        registryId: "registry-lifecycle-timeout",
        providerKey: "cube",
        providerSandboxId: "sandbox-lifecycle-timeout",
        mode: "created",
        sandbox: {
          id: "sandbox-lifecycle-timeout",
          command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          runCode: async () => ({ stdout: [], stderr: [] }),
          readFile: async () => "",
          writeFile: async () => undefined,
          pause: async (control) => {
            controls.push(control);
          },
          kill: async () => undefined,
        },
      },
    });

    expect(result).toEqual({ outcome: "settled" });
    expect(controls).toEqual([{ timeoutMs: 90_000 }]);
  });

  it("Workspace capability 逐字段绑定 acquire 时的 ExecutionScope，不能跨 tenant/thread/workspace 重放", async () => {
    const registry = new CubeSandboxSessionRegistry(
      { apiUrl: "http://127.0.0.1:18080" },
      "template-workspace-binding",
    );
    const scope = claim().scope as ExecutionScope;
    const session: SandboxSessionRef = Object.freeze({
      registryId: "registry-bound",
      providerKey: "cube",
      providerSandboxId: "sandbox-bound",
      mode: "created",
      sandbox: {
        id: "sandbox-bound",
        command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        runCode: async () => ({ stdout: [], stderr: [] }),
        readFile: async () => "",
        writeFile: async () => undefined,
        pause: async () => undefined,
        kill: async () => undefined,
      },
    });
    // acquire 的外部网络调用不属于本单元测试；仅以 registry 私有事实模拟其已完成绑定的结果。
    (
      registry as unknown as {
        readonly workspaceBindings: WeakMap<object, unknown>;
      }
    ).workspaceBindings.set(session, {
      registryId: session.registryId,
      providerKey: "cube",
      providerSandboxId: session.providerSandboxId,
      scope: { ...scope },
    });

    await expect(registry.workspaceCapability({ scope, session }).current()).resolves.toMatchObject(
      {
        sessionId: session.providerSandboxId,
        scope: {
          tenantId: scope.tenantId,
          threadId: scope.threadId,
          workspaceId: scope.workspaceId,
        },
      },
    );
    const alteredScopes: readonly ExecutionScope[] = [
      { ...scope, tenantId: "other-tenant" } as unknown as ExecutionScope,
      { ...scope, threadId: "other-thread" } as unknown as ExecutionScope,
      { ...scope, workspaceId: "other-workspace" } as unknown as ExecutionScope,
      { ...scope, runId: "other-run" } as unknown as ExecutionScope,
      { ...scope, rootRunId: "other-root-run" } as unknown as ExecutionScope,
    ];
    for (const altered of alteredScopes) {
      expect(() => registry.workspaceCapability({ scope: altered, session })).toThrow(
        "未授予 Sandbox Workspace capability",
      );
    }
  });

  it("非空 Workspace 失败关闭，避免成功丢失 Sandbox 文件", async () => {
    const verifier = new FailClosedWorkspaceRevisionVerifier();
    await expect(
      verifier.verify({
        scope: claim().scope as ExecutionScope,
        sandbox: {
          registryId: "registry-workspace",
          providerKey: "cube",
          providerSandboxId: "sandbox-workspace",
          mode: "created",
          sandbox: {
            id: "sandbox-workspace",
            command: async () => ({ stdout: "", stderr: "", exitCode: 73 }),
            runCode: async () => ({ stdout: [], stderr: [] }),
            readFile: async () => "",
            writeFile: async () => undefined,
            pause: async () => undefined,
            kill: async () => undefined,
          },
        },
        operationKey: "workspace-verify-test",
      }),
    ).rejects.toThrow("WORKSPACE_REVISION_PUBLICATION_REQUIRED");
  });

  it.each([72, 73, 74])(
    "模型前拒绝缺失/符号链接根目录、模板额外文件或 find 失败（exit %i）",
    async (exitCode) => {
      const verifier = new FailClosedWorkspaceRevisionVerifier();
      await expect(
        verifier.materialize({
          scope: claim().scope as ExecutionScope,
          sandbox: {
            registryId: "registry-workspace-preflight",
            providerKey: "cube",
            providerSandboxId: "sandbox-workspace-preflight",
            mode: "created",
            sandbox: {
              id: "sandbox-workspace-preflight",
              command: async () => ({ stdout: "", stderr: "", exitCode }),
              runCode: async () => ({ stdout: [], stderr: [] }),
              readFile: async () => "",
              writeFile: async () => undefined,
              pause: async () => undefined,
              kill: async () => undefined,
            },
          },
          operationKey: `workspace-materialize-${exitCode}`,
        }),
      ).rejects.toThrow("WORKSPACE_REVISION_PUBLICATION_REQUIRED");
    },
  );

  it("空目录 verifier 对已有 revision checkpoint 在调用 shell 前拒绝", async () => {
    const verifier = new FailClosedWorkspaceRevisionVerifier();
    let calls = 0;
    await expect(
      verifier.materialize({
        scope: claim().scope as ExecutionScope,
        expectedCurrentRevisionId: "revision-existing" as never,
        sandbox: {
          registryId: "registry-workspace-existing",
          providerKey: "cube",
          providerSandboxId: "sandbox-workspace-existing",
          mode: "created",
          sandbox: {
            id: "sandbox-workspace-existing",
            command: async () => {
              calls += 1;
              return { stdout: "", stderr: "", exitCode: 0 };
            },
            runCode: async () => ({ stdout: [], stderr: [] }),
            readFile: async () => "",
            writeFile: async () => undefined,
            pause: async () => undefined,
            kill: async () => undefined,
          },
        },
        operationKey: "workspace-materialize-existing",
      }),
    ).rejects.toThrow("WORKSPACE_REVISION_MATERIALIZATION_REQUIRED");
    expect(calls).toBe(0);
  });

  it("预检脚本拒绝根符号链接，并保留 find 失败状态而不使用管道", async () => {
    const verifier = new FailClosedWorkspaceRevisionVerifier();
    let command = "";
    await verifier.materialize({
      scope: claim().scope as ExecutionScope,
      sandbox: {
        registryId: "registry-workspace-command",
        providerKey: "cube",
        providerSandboxId: "sandbox-workspace-command",
        mode: "created",
        sandbox: {
          id: "sandbox-workspace-command",
          command: async (value) => {
            command = value;
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          runCode: async () => ({ stdout: [], stderr: [] }),
          readFile: async () => "",
          writeFile: async () => undefined,
          pause: async () => undefined,
          kill: async () => undefined,
        },
      },
      operationKey: "workspace-materialize-command",
    });
    expect(command).toContain("[ -L /workspace ]");
    expect(command).toContain("workspace_entry=$(find -P /workspace");
    expect(command).not.toContain("| grep");
  });
  it("E2B 创建后先建立安全 /workspace 根目录再返回 Session", async () => {
    const commands: string[] = [];
    const command = vi.fn(async (value: string) => {
      commands.push(value);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const kill = vi.fn(async () => undefined);
    const registry = new E2BSandboxSessionRegistry(
      { apiKey: "opaque-e2b-test-key" },
      "base",
      3_600,
      90_000,
    );
    vi.spyOn(registry.gateway, "create").mockResolvedValue({
      id: "sandbox-e2b-workspace-root",
      command,
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill,
    });

    await expect(
      registry.create({
        scope: claim().scope as ExecutionScope,
        registryId: "registry-e2b-workspace-root",
        signal: new AbortController().signal,
        requiresResourceFilesystem: false,
      }),
    ).resolves.toMatchObject({ outcome: "ready" });
    expect(command).toHaveBeenCalledOnce();
    expect(commands[0]).toContain('sudo install -d -o "$uid" -g "$gid" -m 0700 /workspace');
    expect(kill).not.toHaveBeenCalled();
  });

  it("Sandbox 初始化失败且清理未知时保留 providerSandboxId 供恢复清理路由", async () => {
    const sandbox = {
      id: "sandbox-e2b-prepare-unknown",
      command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill: async () => {
        throw new Error("cleanup unavailable");
      },
    };
    const registry = new ProviderSandboxSessionRegistry(
      { providerKey: "e2b", create: async () => sandbox } as never,
      "base",
      3_600,
      90_000,
      undefined,
      undefined,
      {
        initialize: async () => {
          throw new Error("prepare failed");
        },
      },
    );

    await expect(
      registry.acquire({
        scope: claim().scope as ExecutionScope,
        signal: new AbortController().signal,
        requiresResourceFilesystem: false,
      }),
    ).resolves.toMatchObject({
      outcome: "unknown",
      event: {
        providerKey: "e2b",
        stage: "cleanup_after_create",
        sandboxId: "sandbox-e2b-prepare-unknown",
      },
    });
  });

  it("E2B ResourceFS required 缺少受控物化器时仍在远端 create 前失败关闭", async () => {
    const create = vi.fn();
    const registry = new ProviderSandboxSessionRegistry(
      {
        providerKey: "e2b",
        create,
      } as never,
      "base",
    );

    await expect(
      registry.acquire({
        scope: claim().scope as ExecutionScope,
        signal: new AbortController().signal,
        requiresResourceFilesystem: true,
      }),
    ).resolves.toEqual({ outcome: "failed", code: "SANDBOX_FAILED" });
    expect(create).not.toHaveBeenCalled();
  });

  it("E2B ResourceFS required 在 create 后完成受控物化再返回 Session", async () => {
    const sandbox = {
      id: "sandbox-e2b-materialized",
      command: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      runCode: async () => ({ stdout: [], stderr: [] }),
      readFile: async () => "",
      writeFile: async () => undefined,
      pause: async () => undefined,
      kill: async () => undefined,
    };
    const create = vi.fn(async () => sandbox);
    const materialize = vi.fn(async () => undefined);
    const registry = new ProviderSandboxSessionRegistry(
      { providerKey: "e2b", create } as never,
      "base",
      120,
      90_000,
      undefined,
      { materialize },
    );
    const signal = new AbortController().signal;
    const runScope = claim().scope as ExecutionScope;

    await expect(
      registry.acquire({ scope: runScope, signal, requiresResourceFilesystem: true }),
    ).resolves.toMatchObject({ outcome: "ready" });
    expect(create).toHaveBeenCalledOnce();
    expect(materialize).toHaveBeenCalledWith({ scope: runScope, sandbox, signal });
  });
});
