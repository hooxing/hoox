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
import { PiWorkerSessionFactory } from "./pi-session-factory.js";
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
  it.runIf(process.platform === "linux")(
    "内部工具循环预算拒绝映射为 Worker CONTEXT_TOO_LARGE/rebuild_context",
    async () => {
      const persistence = new FakeExecutionPersistence();
      const scope = persistence.addSeed(fakeSeed("pi-context-too-large"));
      const sandboxes = new FakeSandboxRegistry();
      sandboxes.handle.files.set("/tmp/huge.txt", "大".repeat(130_000));
      const faux = fauxProvider({
        api: `faux-worker-budget-${Date.now()}`,
        provider: `faux-worker-budget-${Date.now()}`,
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("sandbox_read_file", { path: "/tmp/huge.txt" }), {
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
          sessions: new PiWorkerSessionFactory(faux.getModel(), modelRuntime),
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
      const sessions = new PiWorkerSessionFactory(faux.getModel(), modelRuntime);
      persistence.beforePermitIssueReturn = (input) => {
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
      const sessions = new PiWorkerSessionFactory(
        faux.getModel(),
        modelRuntime,
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
    },
  );
});
