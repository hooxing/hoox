import type { PgClaimedRunDispatch } from "@cube-runtime/persistence";
import type { ExecutionScope, SandboxSessionRef } from "@cube-runtime/run-contracts";
import { describe, expect, it } from "vitest";
import {
  AgentWorkerPollingLoop,
  CubeSandboxSessionRegistry,
  DatabaseRunCancellation,
  FailClosedWorkspaceRevisionVerifier,
  ProcessShutdown,
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

describe("Agent Worker production polling loop", () => {
  it("领取 durable dispatch 后执行 RunWorker 并以同一 dispatch fence 确认终态", async () => {
    const acknowledged = deferred<void>();
    const expected = claim();
    let claimed = false;
    const acknowledgements: unknown[] = [];
    const loop = new AgentWorkerPollingLoop(
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
        tenantId: expected.scope.tenantId,
        workerId: "worker-loop",
        pollIntervalMs: 10,
        dispatchLeaseMs: 30_000,
      },
    );
    loop.start();
    await acknowledged.promise;
    await loop.close();
    expect(acknowledgements).toEqual([{ claim: expected, outcome: "terminal" }]);
  });

  it("stopAccepting 停止新领取并等待在途 RunWorker 与 ack 完成", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const closed = deferred<void>();
    let claimCount = 0;
    let ackCount = 0;
    const loop = new AgentWorkerPollingLoop(
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
        tenantId: "tenant-worker-loop",
        workerId: "worker-loop",
        pollIntervalMs: 10,
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
    const loop = new AgentWorkerPollingLoop(
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
        tenantId: expected.scope.tenantId,
        workerId: "worker-loop",
        pollIntervalMs: 10,
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
        claim: async () => {
          claimCalls += 1;
          return [];
        },
        acknowledge: async () => undefined,
      },
      { execute: async () => ({ outcome: "succeeded" }) },
      {
        tenantId: "tenant-worker-loop",
        workerId: "worker-loop",
        pollIntervalMs: 10,
        dispatchLeaseMs: 30_000,
        maintenance: async () => {
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
    const businessSignal = cancellation.signalFor(claim().scope as ExecutionScope);

    shutdown.request();

    expect(shutdown.signal.aborted).toBe(true);
    expect(businessSignal.aborted).toBe(false);
  });
});

describe("生产 Workspace revision 安全下限", () => {
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
});
