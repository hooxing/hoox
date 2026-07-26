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
});
