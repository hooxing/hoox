import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelWireTracePort, ModelWireTraceRecord } from "./model-wire-trace.js";
import type { RuntimeEventV1 } from "./ports.js";
import {
  createDevelopmentProjectInternalTrajectoryMirror,
  createDevelopmentProjectRunEventMirror,
  createDevelopmentProjectRunStartupTimingMirror,
  ProjectInternalTrajectoryMirror,
  ProjectModelWireTraceMirror,
  ProjectRunEventMirror,
  ProjectRunStartupTimingMirror,
  ProjectRunPhaseTimingMirror,
  createDevelopmentProjectRunPhaseTimingMirror,
  withDevelopmentProjectModelWireTraceMirror,
} from "./project-model-wire-trace.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error("测试临时目录越界");
    await rm(root, { recursive: true, force: true });
  }
});

describe("项目模型报文本地镜像", () => {
  it("阶段耗时保留线程上下文，独立编号且遵守诊断开关", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectRunPhaseTimingMirror(root);
    const phase = {
      context: {
        tenantId: "tenant_1",
        threadId: "thread_1",
        runId: "run_1",
        attemptId: "attempt_1",
      },
      sequence: 1,
      phase: "tool_execute" as const,
      startedAt: "2026-09-07T00:00:00.000Z",
      durationMs: 7.5,
      status: "succeeded" as const,
    };
    await mirror.persist(phase);
    await mirror.persist(phase);
    expect(
      JSON.parse(
        await readFile(join(root, "run_1", "attempt_1", "phase-timing-00000001.json"), "utf8"),
      ),
    ).toEqual(phase);
    await expect(mirror.persist({ ...phase, durationMs: 8 })).rejects.toThrow(
      "LOCAL_MODEL_WIRE_TRACE_CONFLICT",
    );
    expect(
      createDevelopmentProjectRunPhaseTimingMirror("production", true, () => mirror),
    ).toBeUndefined();
    expect(
      createDevelopmentProjectRunPhaseTimingMirror("development", false, () => mirror),
    ).toBeUndefined();
    expect(createDevelopmentProjectRunPhaseTimingMirror("development", true, () => mirror)).toBe(
      mirror,
    );
  });

  it("按已校验 Run/Attempt 与明确 part/status 的稳定文件名保存原始字节", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectModelWireTraceMirror(root);
    const request = record({
      part: "request",
      status: "complete",
      body: new TextEncoder().encode('{ "message": "甲" }'),
    });
    const response = record({
      part: "response",
      status: "truncated",
      body: new TextEncoder().encode('data: {"delta":"乙"}\n\n'),
    });

    await mirror.persist(request);
    await mirror.persist(response);

    const directory = join(root, "run_dev_1", "attempt_dev_1");
    expect(await readdir(directory)).toEqual([
      "model-turn-03-transport-2-request-complete.json",
      "model-turn-03-transport-2-response-truncated.sse",
    ]);
    expect(
      await readFile(join(directory, "model-turn-03-transport-2-request-complete.json"), "utf8"),
    ).toBe('{ "message": "甲" }');
    expect(
      await readFile(join(directory, "model-turn-03-transport-2-response-truncated.sse"), "utf8"),
    ).toBe('data: {"delta":"乙"}\n\n');
  });

  it("相同正文幂等重放，不同正文拒绝覆盖且不留下半文件", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectModelWireTraceMirror(root);
    const first = record({ body: new TextEncoder().encode('{"first":true}') });
    await mirror.persist(first);
    await mirror.persist(first);

    await expect(
      mirror.persist(record({ body: new TextEncoder().encode('{"second":true}') })),
    ).rejects.toThrow("LOCAL_MODEL_WIRE_TRACE_CONFLICT");

    const directory = join(root, "run_dev_1", "attempt_dev_1");
    const files = await readdir(directory);
    expect(files).toEqual(["model-turn-03-transport-2-request-complete.json"]);
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(await readFile(join(directory, files[0] as string), "utf8")).toBe('{"first":true}');
  });

  it("将子 Agent 请求体保存到独立 Agent/Turn 目录", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectModelWireTraceMirror(root);
    await mirror.persist(
      record({
        context: {
          tenantId: "tenant_dev_1",
          threadId: "thread_dev_1",
          runId: "run_dev_1",
          attemptId: "attempt_dev_1",
          agentThreadId: "agent_child_1",
          agentTurnId: "turn_child_2",
        },
      }),
    );

    const directory = join(
      root,
      "run_dev_1",
      "attempt_dev_1",
      "subagents",
      "agent_child_1",
      "turn_child_2",
    );
    expect(await readdir(directory)).toEqual(["model-turn-03-transport-2-request-complete.json"]);
    expect(await readdir(join(root, "run_dev_1", "attempt_dev_1"))).toEqual(["subagents"]);
  });

  it("镜像失败不影响权威持久化，production 不创建本地镜像", async () => {
    const authoritativePersist = vi.fn(async () => undefined);
    const authoritativeCaptureFailed = vi.fn(async () => undefined);
    const authoritative: ModelWireTracePort = {
      persist: authoritativePersist,
      captureFailed: authoritativeCaptureFailed,
    };
    const mirrorFactory = vi.fn(
      (): ModelWireTracePort => ({
        persist: async () => Promise.reject(new Error("磁盘只读")),
        captureFailed: async () => undefined,
      }),
    );
    const development = withDevelopmentProjectModelWireTraceMirror(
      "development",
      authoritative,
      mirrorFactory,
    );

    await expect(development.persist(record())).resolves.toBeUndefined();
    expect(authoritativePersist).toHaveBeenCalledOnce();
    expect(mirrorFactory).toHaveBeenCalledOnce();

    const productionMirrorFactory = vi.fn(
      (): ModelWireTracePort => ({
        persist: async () => undefined,
        captureFailed: async () => undefined,
      }),
    );
    const production = withDevelopmentProjectModelWireTraceMirror(
      "production",
      authoritative,
      productionMirrorFactory,
    );
    expect(production).toBe(authoritative);
    expect(productionMirrorFactory).not.toHaveBeenCalled();
  });

  it("拒绝能逃逸固定根目录的未校验上下文", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectModelWireTraceMirror(root);
    const invalid = {
      ...record(),
      context: {
        tenantId: "tenant_dev",
        threadId: "thread_dev",
        runId: "../escape",
        attemptId: "a",
      },
    };
    await expect(mirror.persist(invalid)).rejects.toThrow("模型网络诊断作用域无效");
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("拒绝镜像 root 上的 Windows junction 或 WSL/Linux symlink", async () => {
    const trusted = await temporaryRoot();
    const outside = await temporaryRoot();
    const root = join(trusted, "model-wire-traces");
    await createDirectoryLink(outside, root);
    expect((await lstat(root)).isSymbolicLink()).toBe(true);

    const mirror = new ProjectModelWireTraceMirror(root, trusted);
    await expect(mirror.persist(record())).rejects.toThrow("LOCAL_MODEL_WIRE_TRACE_LINK_FORBIDDEN");
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it.each(["run", "attempt"] as const)(
    "拒绝中间 %s 目录上的 Windows junction 或 WSL/Linux symlink",
    async (level) => {
      const trusted = await temporaryRoot();
      const outside = await temporaryRoot();
      const root = join(trusted, "model-wire-traces");
      const run = join(root, "run_dev_1");
      await mkdir(root);
      const link = level === "run" ? run : join(run, "attempt_dev_1");
      if (level === "attempt") await mkdir(run);
      await createDirectoryLink(outside, link);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);

      const mirror = new ProjectModelWireTraceMirror(root, trusted);
      await expect(mirror.persist(record())).rejects.toThrow(
        "LOCAL_MODEL_WIRE_TRACE_LINK_FORBIDDEN",
      );
      await expect(readdir(outside)).resolves.toEqual([]);
    },
  );

  it("将 durable Run 事件按 sequence 写成可幂等重放的规范 JSON", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectRunEventMirror(root);
    const context = record().context;
    const event: RuntimeEventV1 = {
      schemaVersion: 1,
      kind: "agent_event",
      sequence: 3,
      payload: { type: "thinking.delta", delta: "先检查，再回答。" },
    };

    await mirror.persist({ context, event });
    await mirror.persist({ context, event });

    const directory = join(root, "run_dev_1", "attempt_dev_1");
    expect(await readdir(directory)).toEqual(["runtime-event-00000003-agent_event.json"]);
    expect(await readFile(join(directory, "runtime-event-00000003-agent_event.json"), "utf8")).toBe(
      `{\n  "kind": "agent_event",\n  "payload": {\n    "delta": "先检查，再回答。",\n    "type": "thinking.delta"\n  },\n  "schemaVersion": 1,\n  "sequence": 3\n}\n`,
    );

    await expect(
      mirror.persist({
        context,
        event: { ...event, payload: { type: "thinking.delta", delta: "不同正文" } },
      }),
    ).rejects.toThrow("LOCAL_MODEL_WIRE_TRACE_CONFLICT");
  });

  it("完整保存 Pi 原始事件并隔离 root 与 subagent sequence", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectInternalTrajectoryMirror(root);
    const event = {
      schemaVersion: 1 as const,
      sequence: 1,
      occurredAt: "2026-08-15T10:00:00.123Z",
      monotonicOffsetMs: 12.5,
      source: "pi" as const,
      type: "tool_execution_end",
      event: {
        type: "tool_execution_end",
        toolCallId: "call_1",
        result: { content: [{ type: "text", text: "完整 stdout" }], details: { exitCode: 0 } },
        isError: false,
      },
    };

    await mirror.persist({ context: record().context, event });
    await mirror.persist({
      context: {
        ...record().context,
        agentThreadId: "agent_thread_1",
        agentTurnId: "agent_turn_1",
      },
      event,
    });

    const rootFile = join(root, "run_dev_1", "attempt_dev_1", "trajectory-event-00000001.json");
    const subagentFile = join(
      root,
      "run_dev_1",
      "attempt_dev_1",
      "subagents",
      "agent_thread_1",
      "agent_turn_1",
      "trajectory-event-00000001.json",
    );
    expect(JSON.parse(await readFile(rootFile, "utf8"))).toEqual(event);
    expect(JSON.parse(await readFile(subagentFile, "utf8"))).toEqual(event);
  });

  it("将首模前分段耗时写成可幂等重放的规范 JSON", async () => {
    const root = await temporaryRoot();
    const mirror = new ProjectRunStartupTimingMirror(root);
    const timing = {
      context: record().context,
      observedAt: "2026-08-28T09:30:00.000Z",
      totalDurationMs: 18.75,
      spans: [
        { phase: "run_claim" as const, durationMs: 0.5 },
        { phase: "agent_session_create" as const, durationMs: 1.8 },
      ],
    };

    await mirror.persist(timing);
    await mirror.persist(timing);

    const path = join(root, "run_dev_1", "attempt_dev_1", "startup-timings.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(timing);
    await expect(mirror.persist({ ...timing, totalDurationMs: 19 })).rejects.toThrow(
      "LOCAL_MODEL_WIRE_TRACE_CONFLICT",
    );
  });

  it("启动耗时镜像只在 development 且显式敏感诊断开启时创建", () => {
    const factory = vi.fn(() => ({ persist: async () => undefined }));
    expect(
      createDevelopmentProjectRunStartupTimingMirror("development", true, factory),
    ).toBeDefined();
    expect(factory).toHaveBeenCalledOnce();
    expect(
      createDevelopmentProjectRunStartupTimingMirror("development", false, factory),
    ).toBeUndefined();
    expect(
      createDevelopmentProjectRunStartupTimingMirror("production", true, factory),
    ).toBeUndefined();
    expect(factory).toHaveBeenCalledOnce();
  });

  it("内部轨迹镜像只在 development 且显式敏感诊断开启时创建", () => {
    const factory = vi.fn(() => ({ persist: async () => undefined }));
    expect(
      createDevelopmentProjectInternalTrajectoryMirror("development", true, factory),
    ).toBeDefined();
    expect(factory).toHaveBeenCalledOnce();
    expect(
      createDevelopmentProjectInternalTrajectoryMirror("development", false, factory),
    ).toBeUndefined();
    expect(
      createDevelopmentProjectInternalTrajectoryMirror("production", true, factory),
    ).toBeUndefined();
    expect(factory).toHaveBeenCalledOnce();
  });

  it("Run 事件文件镜像只在 development 且显式诊断开启时创建", () => {
    const factory = vi.fn(() => ({ persist: async () => undefined }));
    expect(createDevelopmentProjectRunEventMirror("development", true, factory)).toBeDefined();
    expect(factory).toHaveBeenCalledOnce();

    expect(createDevelopmentProjectRunEventMirror("development", false, factory)).toBeUndefined();
    expect(createDevelopmentProjectRunEventMirror("production", true, factory)).toBeUndefined();
    expect(factory).toHaveBeenCalledOnce();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hoox-model-wire-traces-"));
  temporaryRoots.push(root);
  return root;
}

async function createDirectoryLink(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

function record(
  input: Partial<Pick<ModelWireTraceRecord, "context" | "part" | "status" | "body">> = {},
): ModelWireTraceRecord {
  const body = input.body ?? new TextEncoder().encode('{"ok":true}');
  return {
    context:
      input.context ??
      Object.freeze({
        tenantId: "tenant_dev_1",
        threadId: "thread_dev_1",
        runId: "run_dev_1",
        attemptId: "attempt_dev_1",
      }),
    modelTurn: 3,
    transportAttempt: 2,
    part: input.part ?? "request",
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
    size: body.byteLength,
    status: input.status ?? "complete",
  };
}
