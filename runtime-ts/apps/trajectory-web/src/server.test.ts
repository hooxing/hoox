import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trajectoryHtml } from "./html.js";
import { discoverRuns, internalTesting } from "./server.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hoox-trajectory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("轨迹查看器 HTTP 页面", () => {
  it("使用当前页面子路径请求 API，并只把同源 Hoox 会话用于网关鉴权", () => {
    expect(trajectoryHtml).toContain("new URL(path,window.location.href)");
    expect(trajectoryHtml).toContain("api('api/threads')");
    expect(trajectoryHtml).toContain("localStorage.getItem('hoox.auth-session.v2')");
    expect(trajectoryHtml).toContain("Authorization:'Bearer '+session.accessToken");
    expect(trajectoryHtml).not.toContain("api('/api/threads')");
  });
});

describe("trajectory diagnostics filesystem", () => {
  it("只列出请求报文并拒绝读取历史响应，仍保留轨迹中的思考和回复", async () => {
    const root = await temporaryRoot();
    const attemptPath = join(root, "run_1", "attempt-1");
    await mkdir(attemptPath, { recursive: true });
    const requestFiles = [
      "model-turn-00-transport-0-request-complete.json",
      "model-turn-01-transport-0-request-truncated.json",
    ];
    const responseFiles = [
      "model-turn-00-transport-0-response-complete.sse",
      "model-turn-00-transport-0-response-complete.json",
      "model-turn-01-transport-0-response-truncated.sse",
      "model-turn-02-transport-0-response-aborted.bin",
      "model-turn-03-transport-0-response-failed.sse",
    ];
    await Promise.all(
      [...requestFiles, ...responseFiles].map((name) => writeFile(join(attemptPath, name), "{}")),
    );
    await writeFile(
      join(attemptPath, "trajectory-event-00000001.json"),
      JSON.stringify({
        schemaVersion: 1,
        sequence: 1,
        occurredAt: "2026-09-04T00:00:00.000Z",
        monotonicOffsetMs: 0,
        source: "pi",
        type: "message_end",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "先核对工具结果" },
              { type: "text", text: "工具结果已核验" },
            ],
          },
        },
      }),
    );

    const attempt = await internalTesting.readAttempt({
      attemptId: "attempt-1",
      path: attemptPath,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
    expect(attempt.wireFiles.map((file) => file.name)).toEqual(requestFiles);
    expect(JSON.stringify(attempt.internalTrajectory.records)).toContain("先核对工具结果");
    expect(JSON.stringify(attempt.internalTrajectory.records)).toContain("工具结果已核验");
    for (const name of requestFiles) {
      await expect(internalTesting.safeTraceFile(root, "run_1", "attempt-1", name)).resolves.toBe(
        join(attemptPath, name),
      );
    }
    for (const name of responseFiles) {
      await expect(
        internalTesting.safeTraceFile(root, "run_1", "attempt-1", name),
      ).resolves.toBeUndefined();
      await expect(readFile(join(attemptPath, name), "utf8")).resolves.toBe("{}");
    }
  });

  it("只发现固定根下的普通 Run 和 Attempt 目录", async () => {
    const root = await temporaryRoot();
    const attempt = join(root, "run_1", "attempt-1");
    await mkdir(attempt, { recursive: true });
    await writeFile(
      join(attempt, "runtime-event-00000000-agent_event.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "agent_event",
        sequence: 0,
        payload: { type: "agent.started" },
      }),
    );
    const outside = await temporaryRoot();
    await symlink(
      outside,
      join(root, "run_link"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const runs = await discoverRuns(root);
    expect(runs.map((run) => run.runId)).toEqual(["run_1"]);
    expect(runs[0]?.attempts.map((item) => item.attemptId)).toEqual(["attempt-1"]);
  });

  it("从内部无损事件读取真实 Turn、工具参数、结果和耗时", async () => {
    const root = await temporaryRoot();
    const attemptPath = join(root, "run_1", "attempt-1");
    await mkdir(attemptPath, { recursive: true });
    const events = [
      {
        schemaVersion: 1,
        sequence: 1,
        occurredAt: "2026-08-15T10:00:00.000Z",
        monotonicOffsetMs: 0,
        source: "pi",
        type: "turn_start",
        event: { type: "turn_start" },
      },
      {
        schemaVersion: 1,
        sequence: 2,
        occurredAt: "2026-08-15T10:00:00.010Z",
        monotonicOffsetMs: 10,
        source: "pi",
        type: "tool_execution_start",
        event: {
          type: "tool_execution_start",
          toolCallId: "call_1",
          toolName: "read",
          args: { path: "/workspace/log.txt" },
        },
      },
      {
        schemaVersion: 1,
        sequence: 3,
        occurredAt: "2026-08-15T10:00:00.035Z",
        monotonicOffsetMs: 35,
        source: "pi",
        type: "tool_execution_end",
        event: {
          type: "tool_execution_end",
          toolCallId: "call_1",
          toolName: "read",
          result: { content: [{ type: "text", text: "完整正文" }] },
          isError: false,
        },
      },
    ];
    await Promise.all(
      events.map((event, index) =>
        writeFile(
          join(attemptPath, `trajectory-event-${String(index + 1).padStart(8, "0")}.json`),
          JSON.stringify(event),
        ),
      ),
    );

    const attempt = await internalTesting.readAttempt({
      attemptId: "attempt-1",
      path: attemptPath,
      updatedAt: "2026-08-15T10:00:00.035Z",
    });
    expect(attempt.internalTrajectory.stats).toMatchObject({
      events: 3,
      records: 1,
      turns: 1,
      calls: 1,
    });
    expect(attempt.internalTrajectory.records.at(-1)).toMatchObject({
      eventType: "tool_execution",
      sequence: 2,
      sequenceEnd: 3,
      rawEventCount: 2,
      durationMs: 25,
      detail: { end: { result: { content: [{ text: "完整正文", type: "text" }] } } },
    });
  });

  it("列表事件数优先使用内部无损轨迹，避免与 Runtime 镜像重复计数", async () => {
    const root = await temporaryRoot();
    const attemptPath = join(root, "run_1", "attempt-1");
    await mkdir(attemptPath, { recursive: true });
    await Promise.all([
      writeFile(
        join(attemptPath, "trajectory-event-00000001.json"),
        JSON.stringify({
          schemaVersion: 1,
          sequence: 1,
          occurredAt: "2026-08-15T10:00:00.000Z",
          monotonicOffsetMs: 0,
          source: "pi",
          type: "agent_start",
          event: { type: "agent_start" },
        }),
      ),
      writeFile(
        join(attemptPath, "runtime-event-00000000-agent_event.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "agent_event",
          sequence: 0,
          payload: { type: "agent.started" },
        }),
      ),
      writeFile(
        join(attemptPath, "runtime-event-00000001-agent_event.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "agent_event",
          sequence: 1,
          payload: { type: "agent.settled" },
        }),
      ),
    ]);

    await expect(
      internalTesting.summarizeAttempt({
        attemptId: "attempt-1",
        path: attemptPath,
        updatedAt: "2026-08-15T10:00:00.000Z",
      }),
    ).resolves.toEqual({ eventCount: 1, errorCount: 0 });
  });
  it("按 Thread 聚合多个 Run，并把每个 Run 的用户输入连续编号为 Turn", async () => {
    const root = await temporaryRoot();
    const writeRun = async (runId: string, text: string, occurredAt: string) => {
      const attemptPath = join(root, runId, "attempt-1");
      await mkdir(attemptPath, { recursive: true });
      const events = [
        {
          schemaVersion: 1,
          sequence: 1,
          occurredAt,
          monotonicOffsetMs: 0,
          source: "runtime",
          type: "prompt",
          event: { type: "prompt", text },
        },
        {
          schemaVersion: 1,
          sequence: 2,
          occurredAt,
          monotonicOffsetMs: 1,
          source: "pi",
          type: "turn_start",
          event: { type: "turn_start" },
        },
        {
          schemaVersion: 1,
          sequence: 3,
          occurredAt,
          monotonicOffsetMs: 5,
          source: "pi",
          type: "turn_end",
          event: { type: "turn_end" },
        },
      ];
      await Promise.all(
        events.map((event, index) =>
          writeFile(
            join(attemptPath, `trajectory-event-${String(index + 1).padStart(8, "0")}.json`),
            JSON.stringify(event),
          ),
        ),
      );
    };
    await writeRun("run_1", "第一条消息", "2026-08-16T12:00:00.000Z");
    await writeRun("run_2", "第二条消息", "2026-08-16T12:05:00.000Z");
    const runs = await discoverRuns(root);
    const metadata = {
      resolve: async () =>
        new Map([
          [
            "run_1",
            {
              runId: "run_1",
              threadId: "thread_1",
              title: "可用工具清单",
              createdAt: "2026-08-16T12:00:00.000Z",
            },
          ],
          [
            "run_2",
            {
              runId: "run_2",
              threadId: "thread_1",
              title: "可用工具清单",
              createdAt: "2026-08-16T12:05:00.000Z",
            },
          ],
        ]),
    };

    await expect(internalTesting.threadSummaries(runs, metadata)).resolves.toEqual([
      expect.objectContaining({
        id: "thread_1",
        title: "可用工具清单",
        runCount: 2,
        attemptCount: 2,
        eventCount: 6,
        runIds: expect.arrayContaining(["run_1", "run_2"]),
      }),
    ]);
    const details = await internalTesting.threadDetails("thread_1", runs, metadata);
    expect(details?.runs.map((run) => run.runId)).toEqual(["run_1", "run_2"]);
    expect(
      details?.internalTrajectory.records
        .filter((record) => record.eventType === "prompt")
        .map((record) => ({ turn: record.turn, summary: record.summary, source: record.source })),
    ).toEqual([
      {
        turn: 1,
        summary: "第一条消息",
        source: { runId: "run_1", attemptId: "attempt-1" },
      },
      {
        turn: 2,
        summary: "第二条消息",
        source: { runId: "run_2", attemptId: "attempt-1" },
      },
    ]);
  });

  it("列表和详情使用对话标题增强 Run 元数据，读取失败时退回 runId", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "run_1", "attempt-1"), { recursive: true });
    const runs = await discoverRuns(root);
    const metadata = {
      resolve: async () =>
        new Map([["run_1", { runId: "run_1", threadId: "thread_1", title: "轨迹性能诊断" }]]),
    };

    await expect(internalTesting.runSummaries(runs, metadata)).resolves.toEqual([
      expect.objectContaining({
        runId: "run_1",
        threadId: "thread_1",
        title: "轨迹性能诊断",
      }),
    ]);
    const run = runs[0];
    if (run === undefined) throw new Error("测试 Run 未被发现");
    await expect(internalTesting.runDetails(run, metadata)).resolves.toEqual(
      expect.objectContaining({
        runId: "run_1",
        threadId: "thread_1",
        title: "轨迹性能诊断",
      }),
    );

    const unavailable = {
      resolve: async () => {
        throw new Error("API unavailable");
      },
    };
    await expect(internalTesting.runSummaries(runs, unavailable)).resolves.toEqual([
      expect.not.objectContaining({ title: expect.anything() }),
    ]);
  });

  it("模型报文读取拒绝路径逃逸和非白名单文件", async () => {
    const root = await temporaryRoot();
    const attempt = join(root, "run_1", "attempt-1");
    await mkdir(attempt, { recursive: true });
    const allowed = "model-turn-01-transport-0-request-complete.json";
    await writeFile(join(attempt, allowed), "{}");
    await writeFile(join(attempt, "secret.txt"), "secret");

    await expect(internalTesting.safeTraceFile(root, "run_1", "attempt-1", allowed)).resolves.toBe(
      join(attempt, allowed),
    );
    await expect(
      internalTesting.safeTraceFile(root, "run_1", "attempt-1", "../secret.txt"),
    ).resolves.toBeUndefined();
    await expect(
      internalTesting.safeTraceFile(root, "run_1", "attempt-1", "secret.txt"),
    ).resolves.toBeUndefined();
  });
});
