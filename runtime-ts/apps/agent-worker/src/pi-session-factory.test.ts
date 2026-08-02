import {
  type AcceptWorkspaceArtifactIntentCommand,
  ArtifactCompletionGateAdapter,
  createArtifactExecutionAuthorizationAuthority,
  type PublishArtifactCommand,
} from "@cube-runtime/artifact";
import { artifactId, resourceId, resourceVersionId, sha256Digest } from "@cube-runtime/domain";
import {
  type ArtifactPublicationResourcePort,
  ArtifactToolRouterFactory,
  type ArtifactToolServicePort,
  DeliverFileToolRouterFactory,
} from "@cube-runtime/tool-router";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createDurableObservationRecorderFactory,
  PiWorkerSessionFactory,
} from "./pi-session-factory.js";
import { RunWorker } from "./run-worker.js";
import {
  FakeArtifactPublication,
  FakeCancellationPort,
  FakeClock,
  FakeExecutionPersistence,
  FakeRecoveryMetrics,
  FakeRevisionVerifier,
  FakeSandboxRegistry,
  fakeSeed,
} from "./testing/fakes.js";

describe("PiWorkerSessionFactory 持久操作门控", () => {
  it("视觉模型在当前 user turn 自动取得全部图片且读取发生在模型许可之前", async () => {
    const persistence = new FakeExecutionPersistence();
    const seed = fakeSeed("direct-vision");
    const attachment = {
      resourceId: resourceId("resource-direct-vision"),
      versionId: resourceVersionId("version-direct-vision"),
    };
    const scope = persistence.addSeed({ ...seed, attachments: [attachment] });
    const operations: string[] = [];
    persistence.beforePermitIssueReturn = async ({ effect }) => {
      if (effect === "model_start") operations.push("permit");
    };
    const faux = fauxProvider();
    faux.setResponses([
      (context) => {
        const user = context.messages.at(-1);
        expect(user).toMatchObject({
          role: "user",
          content: [
            { type: "text", text: "执行任务" },
            { type: "image", data: "AQID", mimeType: "image/png" },
          ],
        });
        return fauxAssistantMessage("已查看图片");
      },
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
    const sessions = new PiWorkerSessionFactory(
      faux.getModel(),
      modelRuntime,
      () => ({
        recordStarted: async () => "recorded" as const,
        record: async () => ({ outcome: "recorded" as const, observation: "", isTruncated: false }),
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        load: async ({ attachments }) => {
          operations.push("image");
          expect(attachments).toEqual([attachment]);
          return [{ type: "image", data: "AQID", mimeType: "image/png" }];
        },
      },
    );
    const sandboxes = new FakeSandboxRegistry();
    const worker = new RunWorker(
      {
        persistence,
        revisions: new FakeRevisionVerifier(),
        sandboxes,
        orphanSandboxes: sandboxes,
        sessions,
        cancellation: new FakeCancellationPort(),
        artifacts: new FakeArtifactPublication(),
        clock: new FakeClock(),
        metrics: new FakeRecoveryMetrics(),
      },
      { workerId: "direct-vision-worker", runTimeoutMs: 60_000 },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(operations).toEqual(["image", "permit"]);
  });

  it("纯文本模型保留附件路径但不读取图片 Blob", async () => {
    const persistence = new FakeExecutionPersistence();
    const seed = fakeSeed("non-vision");
    const scope = persistence.addSeed({
      ...seed,
      attachments: [
        {
          resourceId: resourceId("resource-non-vision"),
          versionId: resourceVersionId("version-non-vision"),
        },
      ],
    });
    const faux = fauxProvider({
      models: [{ id: "text-only", input: ["text"] }],
    });
    faux.setResponses([fauxAssistantMessage("按路径处理")]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
    const load = vi.fn();
    const sessions = new PiWorkerSessionFactory(
      faux.getModel(),
      modelRuntime,
      () => ({
        recordStarted: async () => "recorded" as const,
        record: async () => ({ outcome: "recorded" as const, observation: "", isTruncated: false }),
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { load },
    );
    const sandboxes = new FakeSandboxRegistry();
    const worker = new RunWorker(
      {
        persistence,
        revisions: new FakeRevisionVerifier(),
        sandboxes,
        orphanSandboxes: sandboxes,
        sessions,
        cancellation: new FakeCancellationPort(),
        artifacts: new FakeArtifactPublication(),
        clock: new FakeClock(),
        metrics: new FakeRecoveryMetrics(),
      },
      { workerId: "non-vision-worker", runTimeoutMs: 60_000 },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(load).not.toHaveBeenCalled();
  });

  it("durable Observation 工厂拒绝错接 Tenant、Run 或 Attempt 的端口", () => {
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(fakeSeed("observation-binding"));
    const otherScope = persistence.addSeed(fakeSeed("observation-binding-other"));
    const input = { scope, attemptId: "attempt-1" } as Parameters<
      Parameters<typeof createDurableObservationRecorderFactory>[0]
    >[0];
    const factory = createDurableObservationRecorderFactory((current) => ({
      binding: {
        scope: otherScope,
        attemptId: current.attemptId,
        agentThreadId: "agent_observation_other",
      },
      traces: { persistTrace: async () => ({ outcome: "unavailable" as const }) },
      rollout: {
        appendToolCall: async () => ({ outcome: "unavailable" as const }),
        appendToolResult: async () => ({ outcome: "unavailable" as const }),
      },
      policy: { maxModelObservationBytes: 100 },
    }));

    expect(() => factory(input, { readControlledReceipt: async () => "受控 Observation" })).toThrow(
      "ExecutionScope 不匹配",
    );
  });

  it.runIf(process.platform === "linux")(
    "内部工具循环预算拒绝映射为 Worker CONTEXT_TOO_LARGE/rebuild_context",
    async () => {
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(fakeSeed("pi-context-too-large"));
      const sandboxes = new FakeSandboxRegistry();
      sandboxes.handle.command = async () => ({
        stdout: "大".repeat(130_000),
        stderr: "",
        exitCode: 0,
      });
      const faux = fauxProvider({
        api: `faux-worker-budget-${Date.now()}`,
        provider: `faux-worker-budget-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("exec_command", { cmd: "cat /tmp/huge.txt" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("不应触达"),
      ]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const worker = new RunWorker(
        {
          persistence,
          revisions: new FakeRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions: new PiWorkerSessionFactory(faux.getModel(), modelRuntime, () => ({
            recordStarted: async () => "recorded" as const,
            record: async () => ({
              outcome: "recorded" as const,
              observation: "大".repeat(130_000),
              isTruncated: false,
            }),
          })),
          cancellation: new FakeCancellationPort(),
          artifacts: new FakeArtifactPublication(),
          clock: new FakeClock(),
          metrics: new FakeRecoveryMetrics(),
        },
        { workerId: "pi-budget-worker", runTimeoutMs: 60_000 },
      );

      await expect(worker.execute(scope)).resolves.toEqual({
        outcome: "recovery_required",
        code: "CONTEXT_TOO_LARGE",
      });
      expect(faux.state.callCount).toBe(1);
      expect(
        persistence
          .record(scope)
          .events.some(
            (event) =>
              event.kind === "agent_event" &&
              event.payload.type === "error" &&
              event.payload.code === "CONTEXT_TOO_LARGE",
          ),
      ).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "真实 Pi tool.started 先提交，issue/consume 不被 heartbeat 插入且文件成功写入",
    async () => {
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(fakeSeed("pi-lane"));
      const sandboxes = new FakeSandboxRegistry();
      sandboxes.handle.command = async () => {
        sandboxes.handle.files.set("/tmp/lane.txt", "durable-lane-ok");
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const clock = new FakeClock();
      const faux = fauxProvider({
        api: `faux-worker-lane-${Date.now()}`,
        provider: `faux-worker-lane-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("exec_command", { cmd: "printf durable-lane-ok > /tmp/lane.txt" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("完成"),
      ]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const observationOperations: string[] = [];
      const sessions = new PiWorkerSessionFactory(
        faux.getModel(),
        modelRuntime,
        (_input, outputs) => ({
          recordStarted: async (call) => {
            observationOperations.push(`call:${call.toolCallId}:${call.toolName}`);
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(
              persistence.permits.filter(({ permit }) => permit.effect === "tool_execution"),
            ).toHaveLength(0);
            return "recorded" as const;
          },
          record: async (call) => {
            observationOperations.push(`result:${call.toolCallId}:${call.toolName}`);
            const observation = await outputs.readControlledReceipt(call);
            return observation === undefined
              ? { outcome: "conflict" as const }
              : { outcome: "recorded" as const, observation, isTruncated: false };
          },
        }),
      );
      persistence.beforePermitIssueReturn = (input) => {
        if (input.effect === "tool_execution") {
          expect(observationOperations[0]).toMatch(/^call:/u);
        }
        if (input.effect === "tool_execution") void clock.tickHeartbeat();
      };
      const worker = new RunWorker(
        {
          persistence,
          revisions: new FakeRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions,
          cancellation: new FakeCancellationPort(),
          artifacts: new FakeArtifactPublication(),
          clock,
          metrics: new FakeRecoveryMetrics(),
        },
        {
          workerId: "pi-lane-worker",
          leaseDurationMs: 30_000,
          heartbeatMs: 10_000,
          runTimeoutMs: 60_000,
        },
      );

      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
      expect(sandboxes.handle.files.get("/tmp/lane.txt")).toBe("durable-lane-ok");
      const record = persistence.record(scope);
      const started = record.events.find(
        (event) => event.kind === "agent_event" && event.payload.type === "tool.started",
      );
      if (started?.kind !== "agent_event" || started.payload.type !== "tool.started") {
        throw new Error("测试未观察到 tool.started");
      }
      const eventIndex = persistence.durableOperations.indexOf(
        `mutate:attempt-1/event/${started.sequence}`,
      );
      const issueIndex = persistence.durableOperations.indexOf(
        `permit:issue:${started.payload.callId}`,
      );
      const consumeIndex = persistence.durableOperations.indexOf(
        `permit:consume:${started.payload.callId}`,
      );
      const inspectAfterIssue = persistence.durableOperations.findIndex(
        (operation, index) => index > issueIndex && operation === "inspect",
      );
      expect(eventIndex).toBeGreaterThanOrEqual(0);
      expect(eventIndex).toBeLessThan(issueIndex);
      expect(issueIndex).toBeLessThan(consumeIndex);
      expect(consumeIndex).toBeLessThan(inspectAfterIssue);
      expect(observationOperations).toHaveLength(2);
      expect(observationOperations[0]).toMatch(/^call:/u);
      expect(observationOperations[1]).toMatch(/^result:/u);
    },
  );

  it.runIf(process.platform === "linux")(
    "tool_call 前驱 UNKNOWN 时不签发也不消费一次性工具许可",
    async () => {
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(fakeSeed("pi-predecessor-unknown"));
      const sandboxes = new FakeSandboxRegistry();
      const faux = fauxProvider({
        api: `faux-worker-predecessor-unknown-${Date.now()}`,
        provider: `faux-worker-predecessor-unknown-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("exec_command", { cmd: "printf forbidden > /tmp/must-not-exist.txt" }),
          { stopReason: "toolUse" },
        ),
      ]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const sessions = new PiWorkerSessionFactory(faux.getModel(), modelRuntime, () => ({
        recordStarted: async () => "unknown" as const,
        record: async () => ({ outcome: "unknown" as const }),
      }));
      const worker = new RunWorker(
        {
          persistence,
          revisions: new FakeRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions,
          cancellation: new FakeCancellationPort(),
          artifacts: new FakeArtifactPublication(),
          clock: new FakeClock(),
          metrics: new FakeRecoveryMetrics(),
        },
        { workerId: "pi-predecessor-unknown-worker" },
      );

      await expect(worker.execute(scope)).resolves.toEqual({
        outcome: "recovery_required",
        code: "PERSISTENCE_UNAVAILABLE",
      });
      expect(
        persistence.permits.filter(({ permit }) => permit.effect === "tool_execution"),
      ).toHaveLength(0);
      expect(sandboxes.handle.files.has("/tmp/must-not-exist.txt")).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "exec_command schema 错误持久化相邻 call/result 且不消费 effect 许可，模型仍可修正",
    async () => {
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(fakeSeed("pi-exec-schema-correction"));
      const sandboxes = new FakeSandboxRegistry();
      let sandboxCalls = 0;
      sandboxes.handle.command = async () => {
        sandboxCalls += 1;
        return { stdout: "fixed\n", stderr: "", exitCode: 0 };
      };
      const faux = fauxProvider({
        api: `faux-worker-exec-schema-${Date.now()}`,
        provider: `faux-worker-exec-schema-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("exec_command", {}, { id: "call-exec-missing" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(
          fauxToolCall("exec_command", { cmd: 123 }, { id: "call-exec-wrong-type" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall(
            "exec_command",
            { cmd: "echo should-not-run", extra: true },
            { id: "call-exec-extra" },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall("exec_command", { cmd: "echo fixed" }, { id: "call-exec-fixed" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("完成"),
      ]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const operations: string[] = [];
      const sessions = new PiWorkerSessionFactory(
        faux.getModel(),
        modelRuntime,
        (_input, outputs) => ({
          recordStarted: async (call) => {
            operations.push(`call:${call.toolCallId}:${call.toolName}`);
            return "recorded" as const;
          },
          record: async (call) => {
            operations.push(`result:${call.toolCallId}:${call.toolName}`);
            const observation = await outputs.readControlledReceipt(call);
            return observation === undefined
              ? { outcome: "conflict" as const }
              : { outcome: "recorded" as const, observation, isTruncated: false };
          },
        }),
      );
      const worker = new RunWorker(
        {
          persistence,
          revisions: new FakeRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions,
          cancellation: new FakeCancellationPort(),
          artifacts: new FakeArtifactPublication(),
          clock: new FakeClock(),
          metrics: new FakeRecoveryMetrics(),
        },
        { workerId: "pi-exec-schema-worker", runTimeoutMs: 60_000 },
      );

      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
      expect(sandboxCalls).toBe(1);
      expect(
        persistence.permits.filter(({ permit }) => permit.effect === "tool_execution"),
      ).toHaveLength(1);
      expect(operations).toEqual([
        "call:call-exec-missing:exec_command",
        "result:call-exec-missing:exec_command",
        "call:call-exec-wrong-type:exec_command",
        "result:call-exec-wrong-type:exec_command",
        "call:call-exec-extra:exec_command",
        "result:call-exec-extra:exec_command",
        "call:call-exec-fixed:exec_command",
        "result:call-exec-fixed:exec_command",
      ]);
    },
    30_000,
  );

  it.runIf(process.platform === "linux")(
    "Tool result 持久化持续 UNKNOWN 时中止 Pi，Attempt 只能进入 recovery_required",
    async () => {
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(fakeSeed("pi-observation-unknown"));
      const sandboxes = new FakeSandboxRegistry();
      const faux = fauxProvider({
        api: `faux-worker-observation-unknown-${Date.now()}`,
        provider: `faux-worker-observation-unknown-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("exec_command", { cmd: "printf side-effect-issued > /tmp/unknown.txt" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("不得到达成功终态"),
      ]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const sessions = new PiWorkerSessionFactory(faux.getModel(), modelRuntime, () => ({
        recordStarted: async () => "recorded" as const,
        record: async () => ({ outcome: "unknown" as const }),
      }));
      const worker = new RunWorker(
        {
          persistence,
          revisions: new FakeRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions,
          cancellation: new FakeCancellationPort(),
          artifacts: new FakeArtifactPublication(),
          clock: new FakeClock(),
          metrics: new FakeRecoveryMetrics(),
        },
        {
          workerId: "pi-observation-unknown-worker",
          leaseDurationMs: 30_000,
          heartbeatMs: 10_000,
          runTimeoutMs: 60_000,
        },
      );

      await expect(worker.execute(scope)).resolves.toEqual({
        outcome: "recovery_required",
        code: "PERSISTENCE_UNAVAILABLE",
      });
      expect(persistence.record(scope).run.status).toBe("running");
      expect(persistence.record(scope).attempt?.status).toBe("recovery_required");
      expect(faux.state.callCount).toBe(1);
    },
  );

  it.skip("旧 Artifact 工具授权链路已由 deliver_file 纵向用例替代", async () => {
    let artifactCalls = 0;
    const artifacts: ArtifactToolServicePort = {
      declareDeliverables: async () => {
        artifactCalls += 1;
      },
      publishArtifact: async () => {
        artifactCalls += 1;
        throw new Error("授权拒绝时不得调用 Artifact 服务");
      },
      acceptWorkspaceArtifactIntent: async () => {
        artifactCalls += 1;
        throw new Error("授权拒绝时不得调用 Artifact 服务");
      },
    };
    const resources: ArtifactPublicationResourcePort = {
      prepareImmutableVersion: async () => {
        throw new Error("授权拒绝时不得准备 ResourceVersion");
      },
    };
    const authority = createArtifactExecutionAuthorizationAuthority();
    const routerFactory = new ArtifactToolRouterFactory({
      artifacts,
      resources,
      authorizationVerifier: authority.verifier,
    });
    void routerFactory;
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(fakeSeed("pi-artifact-authorization-rejected"));
    persistence.beforePermitIssueReturn = (input) => {
      if (input.effect === "model_start") persistence.rejectNextPermit = true;
    };
    const sandboxes = new FakeSandboxRegistry();
    const faux = fauxProvider({
      api: `faux-worker-artifact-rejected-${Date.now()}`,
      provider: `faux-worker-artifact-rejected-${Date.now()}`,
      tokensPerSecond: 10_000,
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "declare_deliverables",
          {
            idempotencyKey: "declare:rejected:report",
            declarations: [{ key: "report", name: "最终报告", requirement: "required" }],
          },
          { id: "call-artifact-rejected" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("授权拒绝后不得到达此轮"),
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
    const operations: string[] = [];
    const receipts: string[] = [];
    const sessions = new PiWorkerSessionFactory(
      faux.getModel(),
      modelRuntime,
      (_input, outputs) => ({
        recordStarted: async (call) => {
          operations.push(`call:${call.toolCallId}:${call.toolName}`);
          return "recorded" as const;
        },
        record: async (call) => {
          operations.push(`result:${call.toolCallId}:${call.toolName}`);
          const observation = await outputs.readControlledReceipt(call);
          if (observation === undefined) return { outcome: "conflict" as const };
          receipts.push(observation);
          return { outcome: "recorded" as const, observation, isTruncated: false };
        },
      }),
      authority.issuer,
    );
    const worker = new RunWorker(
      {
        persistence,
        revisions: new FakeRevisionVerifier(),
        sandboxes,
        orphanSandboxes: sandboxes,
        sessions,
        cancellation: new FakeCancellationPort(),
        artifacts: new FakeArtifactPublication(),
        clock: new FakeClock(),
        metrics: new FakeRecoveryMetrics(),
      },
      { workerId: "pi-artifact-rejected-worker", runTimeoutMs: 60_000 },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "fence_lost" });
    expect(faux.state.callCount).toBe(1);
    expect(artifactCalls).toBe(0);
    expect(operations).toEqual([
      "call:call-artifact-rejected:declare_deliverables",
      "result:call-artifact-rejected:declare_deliverables",
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toContain('"toolName":"declare_deliverables"');
    expect(receipts[0]).toContain('"outcome":"failed"');
  });

  it.skip("旧 Artifact 声明/发布链路已由 deliver_file 纵向用例替代", async () => {
    class StatefulArtifacts implements ArtifactToolServicePort {
      required = new Set<string>();
      published = new Set<string>();

      async declareDeliverables(
        input: Parameters<ArtifactToolServicePort["declareDeliverables"]>[0],
      ): Promise<void> {
        this.required = new Set(
          input.declarations
            .filter((declaration) => declaration.requirement === "required")
            .map((declaration) => declaration.key),
        );
      }

      async publishArtifact(command: PublishArtifactCommand) {
        if (command.deliverableKey) this.published.add(command.deliverableKey);
        return {
          artifactId: command.artifactId,
          tenantId: command.authorization.scope.tenantId,
          threadId: command.authorization.scope.threadId,
          runId: command.authorization.scope.runId,
          resourceVersionId: command.resourceVersionId,
          name: command.name,
          purpose: command.purpose,
          ...(command.deliverableKey === undefined
            ? {}
            : { deliverableKey: command.deliverableKey }),
          status: "published" as const,
        };
      }

      async acceptWorkspaceArtifactIntent(command: AcceptWorkspaceArtifactIntentCommand) {
        if (command.deliverableKey) this.published.add(command.deliverableKey);
        return {
          artifactId: command.requestedArtifactId,
          resourceVersionId: resourceVersionId("version_pi_workspace_intent"),
          sourceRelativePath: command.sourceRelativePath,
          status: "accepted" as const,
        };
      }

      async assertReadyForCompletion(): Promise<void> {
        if ([...this.required].some((key) => !this.published.has(key))) {
          throw new Error("required deliverable missing");
        }
      }
    }

    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(fakeSeed("pi-artifact-correction"));
    const sandboxes = new FakeSandboxRegistry();
    const artifacts = new StatefulArtifacts();
    const resources: ArtifactPublicationResourcePort = {
      prepareImmutableVersion: async () => ({
        outcome: "ready",
        resourceVersionId: resourceVersionId("version_pi_corrected"),
      }),
    };
    const authority = createArtifactExecutionAuthorizationAuthority();
    const routerFactory = new ArtifactToolRouterFactory({
      artifacts,
      resources,
      authorizationVerifier: authority.verifier,
    });
    void routerFactory;
    const faux = fauxProvider({
      api: `faux-worker-artifact-${Date.now()}`,
      provider: `faux-worker-artifact-${Date.now()}`,
      tokensPerSecond: 10_000,
    });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "declare_deliverables",
          {
            idempotencyKey: "declare:pi:report",
            declarations: [{ key: "report", name: "最终报告", requirement: "required" }],
          },
          { id: "call-pi-declare" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("已声明交付物"),
      fauxAssistantMessage(
        fauxToolCall(
          "publish_artifact",
          {
            idempotencyKey: "publish:pi:report",
            artifactId: "artifact_pi_report",
            name: "最终报告.md",
            purpose: "deliverable",
            deliverableKey: "report",
            source: {
              kind: "resource_version",
              resourceVersionId: "version_pi_source",
            },
          },
          { id: "call-pi-publish" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("交付物已经发布"),
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
    const artifactObservationOperations: string[] = [];
    const sessions = new PiWorkerSessionFactory(
      faux.getModel(),
      modelRuntime,
      (_input, outputs) => ({
        recordStarted: async (call) => {
          artifactObservationOperations.push(`call:${call.toolCallId}:${call.toolName}`);
          return "recorded" as const;
        },
        record: async (call) => {
          artifactObservationOperations.push(`result:${call.toolCallId}:${call.toolName}`);
          const observation = await outputs.readControlledReceipt(call);
          return observation === undefined
            ? { outcome: "conflict" as const }
            : { outcome: "recorded" as const, observation, isTruncated: false };
        },
      }),
      authority.issuer,
    );
    const worker = new RunWorker(
      {
        persistence,
        revisions: new FakeRevisionVerifier(),
        sandboxes,
        orphanSandboxes: sandboxes,
        sessions,
        cancellation: new FakeCancellationPort(),
        artifacts: new ArtifactCompletionGateAdapter(artifacts),
        clock: new FakeClock(),
        metrics: new FakeRecoveryMetrics(),
      },
      {
        workerId: "pi-artifact-correction-worker",
        leaseDurationMs: 30_000,
        heartbeatMs: 10_000,
        runTimeoutMs: 60_000,
      },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(artifacts.published).toEqual(new Set(["report"]));
    expect(
      persistence
        .record(scope)
        .events.filter((event) => event.kind === "artifact_correction_requested"),
    ).toHaveLength(1);
    expect(persistence.permits.map(({ permit }) => permit.effect)).toContain("model_continue");
    expect(artifactObservationOperations).toEqual([
      "call:call-pi-declare:declare_deliverables",
      "result:call-pi-declare:declare_deliverables",
      "call:call-pi-publish:publish_artifact",
      "result:call-pi-publish:publish_artifact",
    ]);
  });

  it.runIf(process.platform === "linux")(
    "deliver_file 业务参数失败也先形成 durable tool_call，并允许模型修正后交付",
    async () => {
      const authority = createArtifactExecutionAuthorizationAuthority();
      let sourceReads = 0;
      let publications = 0;
      const deliverFileTools = new DeliverFileToolRouterFactory({
        source: {
          read: async () => {
            sourceReads += 1;
            return {
              outcome: "found" as const,
              relativePath: "reports/final.pdf",
              body: new Uint8Array([1, 2, 3]),
            };
          },
        },
        publications: {
          publish: async (input) => {
            publications += 1;
            return {
              artifactId: artifactId("artifact_pi_deliver_file"),
              resourceVersionId: resourceVersionId("resource_version_pi_deliver_file"),
              name: input.name,
              size: input.body.byteLength,
              sha256: sha256Digest("a".repeat(64)),
              mediaType: "application/pdf",
            };
          },
        },
        authorizationVerifier: authority.verifier,
      });
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(fakeSeed("pi-deliver-file-correction"));
      const sandboxes = new FakeSandboxRegistry();
      const faux = fauxProvider({
        api: `faux-worker-deliver-file-${Date.now()}`,
        provider: `faux-worker-deliver-file-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("deliver_file", {}, { id: "call-pi-missing-path" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage(
          fauxToolCall(
            "deliver_file",
            { path: "/tmp/reports/final.pdf" },
            { id: "call-pi-invalid-path" },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          fauxToolCall(
            "deliver_file",
            { path: "/workspace/reports/final.pdf" },
            { id: "call-pi-valid-path" },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("文件已经交付"),
      ]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
      const operations: string[] = [];
      const sessions = new PiWorkerSessionFactory(
        faux.getModel(),
        modelRuntime,
        (_input, outputs) => ({
          recordStarted: async (call) => {
            operations.push(`call:${call.toolCallId}:${call.toolName}`);
            return "recorded" as const;
          },
          record: async (call) => {
            operations.push(`result:${call.toolCallId}:${call.toolName}`);
            const observation = await outputs.readControlledReceipt(call);
            return observation === undefined
              ? { outcome: "conflict" as const }
              : { outcome: "recorded" as const, observation, isTruncated: false };
          },
        }),
        authority.issuer,
        undefined,
        undefined,
        deliverFileTools,
      );
      const worker = new RunWorker(
        {
          persistence,
          revisions: new FakeRevisionVerifier(),
          sandboxes,
          orphanSandboxes: sandboxes,
          sessions,
          cancellation: new FakeCancellationPort(),
          artifacts: new FakeArtifactPublication(),
          clock: new FakeClock(),
          metrics: new FakeRecoveryMetrics(),
        },
        { workerId: "pi-deliver-file-worker", runTimeoutMs: 60_000 },
      );

      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
      expect(sourceReads).toBe(1);
      expect(publications).toBe(1);
      expect(
        persistence.permits.filter(({ permit }) => permit.effect === "tool_execution"),
      ).toHaveLength(1);
      expect(operations).toEqual([
        "call:call-pi-missing-path:deliver_file",
        "result:call-pi-missing-path:deliver_file",
        "call:call-pi-invalid-path:deliver_file",
        "result:call-pi-invalid-path:deliver_file",
        "call:call-pi-valid-path:deliver_file",
        "result:call-pi-valid-path:deliver_file",
      ]);
    },
  );
});
