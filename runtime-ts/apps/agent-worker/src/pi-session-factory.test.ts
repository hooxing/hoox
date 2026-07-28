import {
  ArtifactCompletionGateAdapter,
  createArtifactExecutionAuthorizationAuthority,
  type PublishArtifactCommand,
} from "@cube-runtime/artifact";
import { resourceVersionId } from "@cube-runtime/domain";
import {
  type ArtifactPublicationResourcePort,
  ArtifactToolRouterFactory,
  type ArtifactToolServicePort,
} from "@cube-runtime/tool-router";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
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
    "真实 Pi tool.started 先提交，issue/consume 不被 heartbeat 插入且文件成功写入",
    async () => {
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(fakeSeed("pi-lane"));
      const sandboxes = new FakeSandboxRegistry();
      const clock = new FakeClock();
      const faux = fauxProvider({
        api: `faux-worker-lane-${Date.now()}`,
        provider: `faux-worker-lane-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("sandbox_write_file", {
            path: "/tmp/lane.txt",
            content: "durable-lane-ok",
          }),
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
          fauxToolCall("sandbox_write_file", {
            path: "/tmp/must-not-exist.txt",
            content: "forbidden",
          }),
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
          fauxToolCall("sandbox_write_file", {
            path: "/tmp/unknown.txt",
            content: "side-effect-issued",
          }),
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
    },
  );

  it.runIf(process.platform === "linux")(
    "RunWorker 经 PiFactory、Router 接收完成门反馈并发布后，在同一 Attempt 完成",
    async () => {
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
        routerFactory,
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
    },
  );
});
