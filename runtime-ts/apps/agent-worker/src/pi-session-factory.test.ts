import { createHash } from "node:crypto";
import {
  type AcceptWorkspaceArtifactIntentCommand,
  ArtifactCompletionGateAdapter,
  createArtifactExecutionAuthorizationAuthority,
  type PublishArtifactCommand,
} from "@aisay/artifact";
import {
  agentThreadId,
  artifactId,
  isoTimestamp,
  resourceId,
  resourceVersionId,
  sha256Digest,
} from "@aisay/domain";
import {
  type RuntimeAgentEvent,
  type ThreadActiveHistoryV1,
  threadActiveHistoryDigest,
} from "@aisay/pi-adapter";
import { SandboxRuntimeError } from "@aisay/sandbox";
import {
  digestRunSkillSnapshot,
  type SkillInvocationTarget,
  type SkillRuntimeRepository,
  SkillRuntimeService,
} from "@aisay/skill";
import {
  type ArtifactPublicationResourcePort,
  ArtifactToolRouterFactory,
  type ArtifactToolServicePort,
  DeliverFileToolRouterFactory,
} from "@aisay/tool-router";
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
import type {
  ConsumedExternalEffectAuthorization,
  ExternalEffectCall,
  SandboxSessionRef,
} from "./ports.js";
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
  it("Session 创建时把首轮 user 文本 token 投影传给 Runtime compaction", async () => {
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(fakeSeed("pi-initial-compaction-budget"));
    const claimed = await persistence.claim({
      scope,
      workerId: "pi-initial-compaction-budget-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试未取得 Attempt fence");
    const faux = fauxProvider({
      api: `faux-worker-initial-compaction-${Date.now()}`,
      provider: `faux-worker-initial-compaction-${Date.now()}`,
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");
    const messages: ThreadActiveHistoryV1["messages"] = [
      { sequence: 1, role: "user", text: "旧目标", timestamp: 1 },
      {
        sequence: 2,
        role: "assistant",
        content: [{ type: "text", text: "旧进展" }],
        api: "openai-completions",
        provider: "test",
        model: "test-model",
        stopReason: "stop",
        timestamp: 2,
      },
    ];
    const unsigned = {
      schemaVersion: 1 as const,
      projectionSchemaVersion: 1 as const,
      throughSequence: 2,
      messages,
    };
    const history = { ...unsigned, digest: threadActiveHistoryDigest(unsigned) };
    const prepareRuntimeCompaction = vi.fn(
      async (
        _input: unknown,
        _compatibility: unknown,
        current: ThreadActiveHistoryV1,
        _availableHistoryTokens: number,
        _additionalVisibleTokens: number,
      ) => current,
    );
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
      async () => history,
      prepareRuntimeCompaction,
    );
    const session = await sessions.create({
      scope,
      attemptId: claimed.snapshot.attempt.attemptId,
      fence: claimed.fence,
      ensureSandboxReady: async () => {
        throw new Error("纯文本 Session 不应准备 Sandbox");
      },
      rolloutProjection: {
        schemaVersion: 2,
        checkpointId: "checkpoint-initial-compaction-budget",
        items: [],
      },
      initialInputText: "这是即将发送的新用户输入🙂",
      authorizeToolEffect: async () => {
        throw new Error("测试不执行工具");
      },
      writeTodo: async () => {
        throw new Error("测试不写 Todo");
      },
    });
    try {
      expect(prepareRuntimeCompaction).toHaveBeenCalledOnce();
      expect(prepareRuntimeCompaction.mock.calls[0]?.[4]).toBeGreaterThan(0);
    } finally {
      session.dispose();
    }
  });

  it("SubAgent 工具事件和副作用许可使用稳定的 Agent/Turn callId namespace", async () => {
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(fakeSeed("pi-subagent-tool-call-id"));
    const claimed = await persistence.claim({
      scope,
      workerId: "pi-subagent-tool-call-id-worker",
      leaseDurationMs: 30_000,
    });
    if (claimed.outcome !== "claimed") throw new Error("测试未取得 Attempt fence");

    const faux = fauxProvider({
      api: `faux-worker-subagent-call-id-${Date.now()}`,
      provider: `faux-worker-subagent-call-id-${Date.now()}`,
      tokensPerSecond: 10_000,
    });
    const providerCallId = "call_child_command";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("exec_command", { cmd: "echo child" }, { id: providerCallId }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("子任务完成"),
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only-key");

    const observationOperations: string[] = [];
    const trajectoryRecords: Array<{ event: { type: string; event: unknown } }> = [];
    const prepareThreadHistory = vi.fn(async () => {
      throw new Error("fork_turns=none 不得回退读取 Thread Context");
    });
    const sessions = new PiWorkerSessionFactory(
      faux.getModel(),
      modelRuntime,
      (_input, outputs) => ({
        recordStarted: async (call) => {
          observationOperations.push(`call:${call.toolCallId}`);
          return "recorded" as const;
        },
        record: async (call) => {
          const observation = await outputs.readControlledReceipt(call);
          if (observation === undefined) return { outcome: "conflict" as const };
          observationOperations.push(`result:${call.toolCallId}`);
          return { outcome: "recorded" as const, observation, isTruncated: false };
        },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      prepareThreadHistory,
      undefined,
      undefined,
      undefined,
      undefined,
      { persist: async (record) => void trajectoryRecords.push(record) },
    );
    const sandboxes = new FakeSandboxRegistry();
    const sandbox: SandboxSessionRef = {
      registryId: "registry-subagent-call-id",
      providerKey: "cube",
      providerSandboxId: sandboxes.handle.id,
      mode: "created",
      sandbox: sandboxes.handle,
    };
    const identity = {
      agentThreadId: agentThreadId("agent-subagent-call-id"),
      agentTurnId: "turn-subagent-call-id",
      agentKind: "subagent" as const,
    };
    const consumedAt = isoTimestamp("2026-07-26T00:00:01.000Z");
    const authorize = (
      effect: ConsumedExternalEffectAuthorization["permit"]["effect"],
      call: ExternalEffectCall,
    ): ConsumedExternalEffectAuthorization => ({
      permit: {
        permitId: `permit-${call.callId}`,
        scope,
        runClaimToken: claimed.fence.runClaim.token,
        runClaimEpoch: claimed.fence.runClaim.epoch,
        workspaceRootRunId: claimed.fence.workspaceLease.rootRunId,
        workspaceLeaseEpoch: claimed.fence.workspaceLease.epoch,
        attemptVersion: claimed.snapshot.attempt.version,
        effect,
        callId: call.callId,
        toolName: call.toolName,
        argsDigest: call.argsDigest,
        issuedAt: consumedAt,
        expiresAt: claimed.fence.runClaim.expiresAt,
      },
      consumedAt,
      consumedAtMonotonicMs: performance.now(),
      maxContinuationDelayMs: 1_000,
    });
    const authorizedToolCalls: ExternalEffectCall[] = [];
    const session = await sessions.create({
      scope,
      attemptId: claimed.snapshot.attempt.attemptId,
      fence: claimed.fence,
      agent: identity,
      enabledToolNames: ["exec_command"],
      ensureSandboxReady: async () => sandbox,
      rolloutProjection: {
        schemaVersion: 2,
        checkpointId: "checkpoint-subagent-call-id",
        items: [],
      },
      authorizeToolEffect: async (call) => {
        authorizedToolCalls.push(call);
        return authorize("tool_execution", call);
      },
      writeTodo: async () => {
        throw new Error("SUBAGENT_TODO_FORBIDDEN");
      },
    });
    const events: RuntimeAgentEvent[] = [];
    const unsubscribe = session.subscribe((event) => events.push(event));
    try {
      const prepared = await session.prepareInput({ text: "执行子任务", attachments: [] });
      const modelCall: ExternalEffectCall = {
        callId: `${identity.agentThreadId}:${identity.agentTurnId}:model`,
        toolName: "pi_model",
        argsDigest: sha256Digest("a".repeat(64)),
      };
      await expect(
        session.runPrompt(prepared, authorize("agent_model_start", modelCall)),
      ).resolves.toEqual({ kind: "completed" });
    } finally {
      unsubscribe();
      session.dispose();
    }

    const expectedCallId = `${identity.agentThreadId}:${identity.agentTurnId}:${createHash("sha256")
      .update(providerCallId, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.started", callId: expectedCallId }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool.completed", callId: expectedCallId, isError: false }),
    );
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(authorizedToolCalls).toEqual([
      expect.objectContaining({ callId: expectedCallId, toolName: "exec_command" }),
    ]);
    expect(observationOperations).toEqual([`call:${providerCallId}`, `result:${providerCallId}`]);
    expect(prepareThreadHistory).not.toHaveBeenCalled();
    const rawToolStart = trajectoryRecords.find(
      (record) => record.event.type === "tool_execution_start",
    );
    const rawToolEnd = trajectoryRecords.find(
      (record) => record.event.type === "tool_execution_end",
    );
    expect(rawToolStart?.event.event).toMatchObject({
      type: "tool_execution_start",
      toolCallId: providerCallId,
      toolName: "exec_command",
      args: { cmd: "echo child" },
    });
    expect(rawToolEnd?.event.event).toMatchObject({
      type: "tool_execution_end",
      toolCallId: providerCallId,
      toolName: "exec_command",
      isError: false,
      result: { content: expect.any(Array), details: expect.any(Object) },
    });
  });

  it("显式 Skill 在首个模型请求前由后端注入，纯指令任务保持零 Sandbox", async () => {
    const body = new TextEncoder().encode("# Review\n按检查清单处理。\n");
    const entrypointDigest = createHash("sha256").update(body).digest("hex");
    const target: SkillInvocationTarget = {
      invocationId: "explicit",
      invocationName: "review",
      canonicalKey: "code-review",
      skillVersion: "1.0.0",
      entrypointDigest,
      entrypointSizeBytes: body.byteLength,
      entrypointBlobRef: "entrypoint-ref",
      packageDigest: "a".repeat(64),
      files: [
        {
          path: "SKILL.md",
          mediaType: "text/markdown",
          sizeBytes: body.byteLength,
          contentDigest: entrypointDigest,
          blobRef: "entrypoint-ref",
        },
      ],
    };
    const repository: SkillRuntimeRepository = {
      beginInvocation: vi.fn(async () => target),
      completeInvocation: vi.fn(async () => undefined),
      listLoadedPackages: vi.fn(async () => []),
    };
    const contents = { read: vi.fn(async () => body) };
    const skillRuntime = new SkillRuntimeService(repository, contents);
    const persistence = new FakeExecutionPersistence();
    const seed = fakeSeed("explicit-skill-no-sandbox");
    const skillItems = [
      {
        invocationName: "review",
        canonicalKey: "code-review",
        skillVersion: "1.0.0",
        description: "按检查清单审阅修改",
        entrypointDigest,
        packageDigest: "a".repeat(64),
      },
    ];
    const explicitInvocation = { invocationName: "review", args: "检查当前修改" };
    const scope = persistence.addSeed({
      ...seed,
      skills: {
        schemaVersion: 1,
        digest: digestRunSkillSnapshot({ items: skillItems, explicitInvocation }),
        items: skillItems,
        explicitInvocation,
      },
    });
    const faux = fauxProvider();
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("RUNTIME_SKILL_INSTRUCTION");
        expect(JSON.stringify(context.messages)).toContain("按检查清单处理");
        return fauxAssistantMessage("已完成检查");
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
      undefined,
      skillRuntime,
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
      { workerId: "explicit-skill-worker", runTimeoutMs: 60_000 },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(repository.beginInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ source: "explicit", invocationName: "review" }),
    );
    expect(contents.read).toHaveBeenCalledTimes(1);
    expect(repository.listLoadedPackages).toHaveBeenCalledTimes(1);
    expect(sandboxes.acquireCount).toBe(0);
    expect(sandboxes.settleCount).toBe(0);
  });

  it("skill 工具保持零 Sandbox，后续工具直接使用已挂载的市场虚拟目录", async () => {
    const instruction = new TextEncoder().encode("# Review\n按检查清单处理。\n");
    const resource = new TextEncoder().encode("security\ncorrectness\n");
    const entrypointDigest = createHash("sha256").update(instruction).digest("hex");
    const resourceDigest = createHash("sha256").update(resource).digest("hex");
    const target: SkillInvocationTarget = {
      invocationId: "tool:review",
      invocationName: "review",
      canonicalKey: "code-review",
      skillVersion: "1.0.0",
      entrypointDigest,
      entrypointSizeBytes: instruction.byteLength,
      entrypointBlobRef: "entrypoint-ref",
      packageDigest: "a".repeat(64),
      files: [
        {
          path: "SKILL.md",
          mediaType: "text/markdown",
          sizeBytes: instruction.byteLength,
          contentDigest: entrypointDigest,
          blobRef: "entrypoint-ref",
        },
        {
          path: "references/checklist.txt",
          mediaType: "text/plain",
          sizeBytes: resource.byteLength,
          contentDigest: resourceDigest,
          blobRef: "resource-ref",
        },
      ],
    };
    let loaded = false;
    const repository: SkillRuntimeRepository = {
      beginInvocation: vi.fn(async () => target),
      completeInvocation: vi.fn(async (input) => {
        loaded = input.status === "loaded";
      }),
      listLoadedPackages: vi.fn(async () => (loaded ? [target] : [])),
    };
    const contents = {
      read: vi.fn(async ({ blobRef }: { readonly blobRef: string }) =>
        blobRef === "entrypoint-ref" ? instruction : resource,
      ),
    };
    const skillRuntime = new SkillRuntimeService(repository, contents);
    const persistence = new FakeExecutionPersistence();
    const seed = fakeSeed("tool-skill-lazy-materialization");
    const skillItems = [
      {
        invocationName: "review",
        canonicalKey: "code-review",
        skillVersion: "1.0.0",
        description: "按检查清单审阅修改",
        entrypointDigest,
        packageDigest: "a".repeat(64),
      },
    ];
    const scope = persistence.addSeed({
      ...seed,
      skills: {
        schemaVersion: 1,
        digest: digestRunSkillSnapshot({ items: skillItems }),
        items: skillItems,
      },
    });
    const sandboxes = new FakeSandboxRegistry();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("skill", { skill: "review" }), {
        stopReason: "toolUse",
      }),
      () => {
        expect(sandboxes.acquireCount).toBe(0);
        return fauxAssistantMessage(fauxToolCall("exec_command", { cmd: "pwd" }), {
          stopReason: "toolUse",
        });
      },
      fauxAssistantMessage("审阅完成"),
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
      undefined,
      skillRuntime,
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
      { workerId: "tool-skill-worker", runTimeoutMs: 60_000 },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(repository.beginInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ source: "tool", invocationName: "review" }),
    );
    expect(contents.read).toHaveBeenCalledTimes(1);
    expect(sandboxes.acquireCount).toBe(1);
    expect(sandboxes.acquireResourceFilesystemRequirements).toEqual([true]);
  });

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
    expect(sandboxes.acquireCount).toBe(0);
    expect(sandboxes.settleCount).toBe(0);
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
    persistence.beforePermitIssueReturn = ({ effect }) => {
      if (effect !== "model_start") return;
      expect(sandboxes.acquireCount).toBe(1);
      expect(sandboxes.settleCount).toBe(0);
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
        clock: new FakeClock(),
        metrics: new FakeRecoveryMetrics(),
      },
      { workerId: "non-vision-worker", runTimeoutMs: 60_000 },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(load).not.toHaveBeenCalled();
    expect(sandboxes.acquireCount).toBe(1);
    expect(sandboxes.acquireResourceFilesystemRequirements).toEqual([true]);
    expect(sandboxes.settleCount).toBe(1);
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
    "内部工具循环预算拒绝收敛为 Worker failed/CONTEXT_TOO_LARGE",
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
        models: [{ id: "faux-budget", contextWindow: 120_000, maxTokens: 4_096 }],
        tokensPerSecond: 10_000,
      });
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("exec_command", { cmd: "cat /tmp/huge.txt", max_output_tokens: 20_000 }),
          {
            stopReason: "toolUse",
          },
        ),
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

      await expect(worker.execute(scope)).resolves.toEqual({ outcome: "failed" });
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

  it("同轮两个 Pi 工具调用按 durable call/result 对串行，不触发 observation conflict", async () => {
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(fakeSeed("pi-parallel-tool-rollout"));
    const sandboxes = new FakeSandboxRegistry();
    let activeSandboxCalls = 0;
    let maximumActiveSandboxCalls = 0;
    sandboxes.handle.command = async () => {
      activeSandboxCalls += 1;
      maximumActiveSandboxCalls = Math.max(maximumActiveSandboxCalls, activeSandboxCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeSandboxCalls -= 1;
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    };
    const faux = fauxProvider({
      api: `faux-worker-parallel-rollout-${Date.now()}`,
      provider: `faux-worker-parallel-rollout-${Date.now()}`,
      tokensPerSecond: 10_000,
    });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("exec_command", { cmd: "echo first" }, { id: "call-parallel-first" }),
          fauxToolCall("exec_command", { cmd: "echo second" }, { id: "call-parallel-second" }),
        ],
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
    let pendingCallId: string | undefined;
    const sessions = new PiWorkerSessionFactory(
      faux.getModel(),
      modelRuntime,
      (_input, outputs) => ({
        recordStarted: async (call) => {
          if (pendingCallId !== undefined) return "conflict" as const;
          pendingCallId = call.toolCallId;
          operations.push(`call:${call.toolCallId}`);
          return "recorded" as const;
        },
        record: async (call) => {
          if (pendingCallId !== call.toolCallId) return { outcome: "conflict" as const };
          const observation = await outputs.readControlledReceipt(call);
          if (observation === undefined) return { outcome: "conflict" as const };
          operations.push(`result:${call.toolCallId}`);
          pendingCallId = undefined;
          return { outcome: "recorded" as const, observation, isTruncated: false };
        },
      }),
    );
    persistence.beforePermitIssueReturn = ({ effect }) => {
      if (effect !== "tool_execution") return;
      expect(sandboxes.acquireCount).toBe(1);
      expect(sandboxes.settleCount).toBe(0);
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
        clock: new FakeClock(),
        metrics: new FakeRecoveryMetrics(),
      },
      { workerId: "pi-parallel-tool-rollout-worker", runTimeoutMs: 60_000 },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(sandboxes.acquireCount).toBe(1);
    expect(sandboxes.settleCount).toBe(1);
    expect(operations).toEqual([
      "call:call-parallel-first",
      "result:call-parallel-first",
      "call:call-parallel-second",
      "result:call-parallel-second",
    ]);
    expect(maximumActiveSandboxCalls).toBe(1);
    expect(
      persistence.permits.filter(({ permit }) => permit.effect === "tool_execution"),
    ).toHaveLength(2);
    expect(faux.state.callCount).toBe(2);
  }, 30_000);

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

  it("exec_command 数据面连续失败时熔断 Sandbox 调用但保留模型自适应与回复", async () => {
    const persistence = new FakeExecutionPersistence();
    const scope = persistence.addSeed(fakeSeed("pi-exec-infrastructure-circuit"));
    const sandboxes = new FakeSandboxRegistry();
    let commandCalls = 0;
    sandboxes.handle.command = async () => {
      commandCalls += 1;
      throw new SandboxRuntimeError("UPSTREAM", "private CubeProxy detail");
    };
    const faux = fauxProvider({
      api: `faux-worker-exec-circuit-${Date.now()}`,
      provider: `faux-worker-exec-circuit-${Date.now()}`,
      tokensPerSecond: 10_000,
    });
    const commandTurn = (suffix: string) =>
      fauxAssistantMessage(fauxToolCall("exec_command", { cmd: `echo ${suffix}` }), {
        stopReason: "toolUse",
      });
    faux.setResponses([
      commandTurn("one"),
      commandTurn("two"),
      commandTurn("three"),
      commandTurn("after-circuit"),
      fauxAssistantMessage("Sandbox 连续调用失败，本次任务无法继续。"),
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
      (_input, outputs) => ({
        recordStarted: async () => "recorded" as const,
        record: async (call) => {
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
      { workerId: "pi-exec-circuit-worker", runTimeoutMs: 60_000 },
    );

    await expect(worker.execute(scope)).resolves.toEqual({ outcome: "succeeded" });
    expect(commandCalls).toBe(3);
    expect(faux.state.callCount).toBe(5);
    expect(sandboxes.settleCount).toBe(1);
    expect(persistence.record(scope).run.status).toBe("succeeded");
    expect(persistence.record(scope).attempt?.status).toBe("succeeded");
    expect(
      persistence
        .record(scope)
        .events.some(
          (event) => event.kind === "agent_event" && event.payload.type === "runtime.notice",
        ),
    ).toBe(false);
    expect(
      persistence
        .record(scope)
        .events.filter(
          (event) => event.kind === "agent_event" && event.payload.type === "message.delta",
        )
        .map((event) =>
          event.kind === "agent_event" && event.payload.type === "message.delta"
            ? event.payload.delta
            : "",
        )
        .join(""),
    ).toContain("Sandbox 连续调用失败");
  });

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
        persistence.permits
          .filter(({ permit }) => permit.effect === "tool_execution")
          .map(({ permit }) => permit.callId),
      ).toEqual(["call-pi-invalid-path", "call-pi-valid-path"]);
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
