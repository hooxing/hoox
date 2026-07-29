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

  it.each([72, 73])("模型前拒绝缺失根目录或模板额外文件（exit %i）", async (exitCode) => {
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
  });
});
