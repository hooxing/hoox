import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RuntimeEventV1 } from "@hoox/run-contracts";
import {
  combineDeepSeekTrajectoryProjections,
  type InternalTrajectoryEventV1,
  type ObservedRuntimeEvent,
  projectInternalTrajectory,
  projectTrajectory,
} from "@hoox/trajectory";
import { trajectoryHtml } from "./html.js";
import type { RunDisplayMetadata, RunMetadataProvider } from "./runtime-metadata.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const runtimeEventPattern = /^runtime-event-(\d{8})-([a-z_]+)\.json$/u;
const trajectoryEventPattern = /^trajectory-event-(\d{8})\.json$/u;
// 列表与正文读取共用白名单，历史 response 文件也不再由内部查看器暴露。
const wireFilePattern = /^model-turn-(\d+)-transport-(\d+)-(request)-([a-z_]+)\.(json|bin)$/u;
const phaseTimingPattern = /^phase-timing-(\d{8})\.json$/u;
const maximumTraceFileBytes = 4 * 1024 * 1024;

export interface TrajectoryServerOptions {
  readonly root: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly metadata?: RunMetadataProvider;
}

interface AttemptDirectory {
  readonly attemptId: string;
  readonly path: string;
  readonly updatedAt: string;
}

interface RunDirectory {
  readonly runId: string;
  readonly path: string;
  readonly updatedAt: string;
  readonly attempts: readonly AttemptDirectory[];
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function text(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(value),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(value);
}

function isRuntimeEvent(value: unknown): value is RuntimeEventV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record.schemaVersion === 1 &&
    Number.isSafeInteger(record.sequence) &&
    typeof record.kind === "string" &&
    [
      "agent_event",
      "attempt_state_changed",
      "run_waiting",
      "sandbox_recovery_decided",
      "artifact_correction_requested",
    ].includes(record.kind) &&
    typeof record.payload === "object" &&
    record.payload !== null &&
    !Array.isArray(record.payload)
  );
}

function isInternalTrajectoryEvent(value: unknown): value is InternalTrajectoryEventV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record.schemaVersion === 1 &&
    Number.isSafeInteger(record.sequence) &&
    typeof record.occurredAt === "string" &&
    Number.isFinite(Date.parse(record.occurredAt)) &&
    typeof record.monotonicOffsetMs === "number" &&
    Number.isFinite(record.monotonicOffsetMs) &&
    record.monotonicOffsetMs >= 0 &&
    (record.source === "pi" || record.source === "runtime") &&
    typeof record.type === "string" &&
    record.type.length > 0 &&
    "event" in record
  );
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function safeRootDirectory(rootInput: string): Promise<string | undefined> {
  const root = resolve(rootInput);
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    return await realpath(root);
  } catch {
    return undefined;
  }
}

async function safeChildDirectory(parent: string, name: string): Promise<string | undefined> {
  if (!identifierPattern.test(name)) return undefined;
  const candidate = join(parent, name);
  try {
    const metadata = await lstat(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    const parentReal = await realpath(parent);
    const childReal = await realpath(candidate);
    return isContained(parentReal, childReal) ? childReal : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverRuns(rootInput: string): Promise<readonly RunDirectory[]> {
  const rootReal = await safeRootDirectory(rootInput);
  if (rootReal === undefined) return [];
  const entries = await readdir(rootReal, { withFileTypes: true });
  const runs: RunDirectory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !identifierPattern.test(entry.name))
      continue;
    const runPath = await safeChildDirectory(rootReal, entry.name);
    if (runPath === undefined) continue;
    const attemptEntries = await readdir(runPath, { withFileTypes: true });
    const attempts: AttemptDirectory[] = [];
    for (const attemptEntry of attemptEntries) {
      if (!attemptEntry.isDirectory() || attemptEntry.isSymbolicLink()) continue;
      const attemptPath = await safeChildDirectory(runPath, attemptEntry.name);
      if (attemptPath === undefined) continue;
      const metadata = await stat(attemptPath);
      attempts.push({
        attemptId: attemptEntry.name,
        path: attemptPath,
        updatedAt: metadata.mtime.toISOString(),
      });
    }
    attempts.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const metadata = await stat(runPath);
    runs.push({
      runId: entry.name,
      path: runPath,
      updatedAt: attempts.at(-1)?.updatedAt ?? metadata.mtime.toISOString(),
      attempts,
    });
  }
  return runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 500);
}

interface PhaseTiming {
  readonly sequence: number;
  readonly phase: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: "succeeded" | "failed";
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly context: {
    readonly runId: string;
    readonly threadId: string;
    readonly attemptId: string;
  };
}

function isPhaseTiming(value: unknown): value is PhaseTiming {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const context = item.context as Record<string, unknown> | undefined;
  return (
    Number.isSafeInteger(item.sequence) &&
    (item.sequence as number) > 0 &&
    (item.toolCallId === undefined || typeof item.toolCallId === "string") &&
    (item.toolName === undefined || typeof item.toolName === "string") &&
    typeof item.phase === "string" &&
    typeof item.startedAt === "string" &&
    Number.isFinite(Date.parse(item.startedAt)) &&
    typeof item.durationMs === "number" &&
    Number.isFinite(item.durationMs) &&
    item.durationMs >= 0 &&
    (item.status === "succeeded" || item.status === "failed") &&
    typeof context === "object" &&
    context !== null &&
    [context.runId, context.threadId, context.attemptId].every(
      (value) => typeof value === "string" && identifierPattern.test(value),
    )
  );
}

async function localRunMetadata(run: RunDirectory): Promise<RunDisplayMetadata | undefined> {
  for (const attempt of run.attempts) {
    const entries = (await readdir(attempt.path, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          (phaseTimingPattern.test(entry.name) || entry.name === "startup-timings.json"),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries.slice(0, 8)) {
      try {
        const path = join(attempt.path, entry.name);
        if ((await stat(path)).size > 64 * 1024) continue;
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        const context = record.context as Record<string, unknown> | undefined;
        if (
          context === undefined ||
          context === null ||
          context.runId !== run.runId ||
          context.attemptId !== attempt.attemptId ||
          typeof context.threadId !== "string" ||
          !identifierPattern.test(context.threadId)
        )
          continue;
        if (entry.name !== "startup-timings.json" && !isPhaseTiming(value)) continue;
        // 只有创建至领取阶段的起点才是 Run 创建时间，其他阶段不能替代它。
        const createdAt =
          record.phase === "run_queue_wait" && typeof record.startedAt === "string"
            ? record.startedAt
            : undefined;
        return {
          runId: run.runId,
          threadId: context.threadId,
          title: context.threadId,
          ...(createdAt === undefined ? {} : { createdAt }),
        };
      } catch {
        // 元数据增强不可让损坏的可选诊断文件阻止列表读取。
      }
    }
  }
  return undefined;
}

async function resolveMetadata(runs: readonly RunDirectory[], provider?: RunMetadataProvider) {
  const remote = await resolveRunMetadata(
    provider,
    runs.map((run) => run.runId),
  );
  const result = new Map(remote);
  await Promise.all(
    runs.map(async (run) => {
      if (result.has(run.runId)) return;
      const local = await localRunMetadata(run);
      if (local !== undefined) result.set(run.runId, local);
    }),
  );
  return result;
}

async function readAttempt(attempt: AttemptDirectory) {
  const entries = await readdir(attempt.path, { withFileTypes: true });
  const events: ObservedRuntimeEvent[] = [];
  const internalEvents: InternalTrajectoryEventV1[] = [];
  const phaseTimings: PhaseTiming[] = [];
  const warnings: string[] = [];
  const wireFiles: Array<{
    name: string;
    modelTurn: number;
    transportAttempt: number;
    part: "request";
    status: string;
    size: number;
    updatedAt: string;
  }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const runtimeMatch = runtimeEventPattern.exec(entry.name);
    const trajectoryMatch = trajectoryEventPattern.exec(entry.name);
    const wireMatch = wireFilePattern.exec(entry.name);
    const path = join(attempt.path, entry.name);
    if (phaseTimingPattern.test(entry.name)) {
      try {
        if ((await stat(path)).size > 64 * 1024) throw new Error("PHASE_TIMING_TOO_LARGE");
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (
          !isPhaseTiming(value) ||
          value.context.attemptId !== attempt.attemptId ||
          value.context.runId !== basename(resolve(attempt.path, ".."))
        )
          throw new Error("INVALID_PHASE_TIMING");
        phaseTimings.push(value);
      } catch {
        warnings.push(`${entry.name}: 阶段计时格式无效或无法读取`);
      }
      continue;
    }
    if (runtimeMatch !== null) {
      try {
        const [body, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        const value: unknown = JSON.parse(body);
        if (!isRuntimeEvent(value)) {
          warnings.push(`${entry.name}: 事件格式无效`);
          continue;
        }
        events.push({ event: value, observedAt: metadata.mtime.toISOString() });
      } catch {
        warnings.push(`${entry.name}: 无法读取或解析`);
      }
      continue;
    }
    if (trajectoryMatch !== null) {
      try {
        const metadata = await stat(path);
        if (metadata.size > 64 * 1024 * 1024) {
          warnings.push(`${entry.name}: 轨迹事件超过 64 MiB 查看上限`);
          continue;
        }
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isInternalTrajectoryEvent(value)) {
          warnings.push(`${entry.name}: 内部轨迹格式无效`);
          continue;
        }
        internalEvents.push(value);
      } catch {
        warnings.push(`${entry.name}: 无法读取或解析`);
      }
      continue;
    }
    if (wireMatch !== null) {
      const metadata = await stat(path);
      wireFiles.push({
        name: entry.name,
        modelTurn: Number(wireMatch[1]),
        transportAttempt: Number(wireMatch[2]),
        part: "request",
        status: wireMatch[4] ?? "unknown",
        size: metadata.size,
        updatedAt: metadata.mtime.toISOString(),
      });
    }
  }
  events.sort((left, right) => left.event.sequence - right.event.sequence);
  internalEvents.sort((left, right) => left.sequence - right.sequence);
  wireFiles.sort(
    (left, right) =>
      left.modelTurn - right.modelTurn ||
      left.transportAttempt - right.transportAttempt ||
      left.part.localeCompare(right.part),
  );
  return {
    attemptId: attempt.attemptId,
    updatedAt: attempt.updatedAt,
    trajectory: projectTrajectory(events),
    internalTrajectory: projectInternalTrajectory(internalEvents),
    rawEvents: internalEvents,
    phaseTimings: phaseTimings.sort((a, b) => a.sequence - b.sequence),
    wireFiles,
    warnings,
  };
}

async function resolveRunMetadata(
  provider: RunMetadataProvider | undefined,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, RunDisplayMetadata>> {
  if (provider === undefined) return new Map();
  try {
    return await provider.resolve(runIds);
  } catch {
    // 元数据只增强诊断可读性，Runtime API 不可用时必须保留纯文件轨迹查看能力。
    return new Map();
  }
}

async function readRunDetails(run: RunDirectory, metadata?: RunDisplayMetadata) {
  return {
    runId: run.runId,
    ...(metadata === undefined
      ? {}
      : {
          threadId: metadata.threadId,
          title: metadata.title,
          ...(metadata.createdAt === undefined ? {} : { createdAt: metadata.createdAt }),
        }),
    updatedAt: run.updatedAt,
    attempts: await Promise.all(run.attempts.map(readAttempt)),
  };
}

async function runDetails(run: RunDirectory, provider?: RunMetadataProvider) {
  const metadata = (await resolveMetadata([run], provider)).get(run.runId);
  return readRunDetails(run, metadata);
}

async function summarizeAttempt(attempt: AttemptDirectory): Promise<{
  readonly eventCount: number;
  readonly errorCount: number;
}> {
  const entries = await readdir(attempt.path, { withFileTypes: true });
  const runtimeEventFiles = entries.filter(
    (entry) => entry.isFile() && !entry.isSymbolicLink() && runtimeEventPattern.test(entry.name),
  );
  const trajectoryEventFiles = entries.filter(
    (entry) => entry.isFile() && !entry.isSymbolicLink() && trajectoryEventPattern.test(entry.name),
  );
  let errorCount = 0;
  for (const entry of runtimeEventFiles) {
    if (!entry.name.endsWith("-attempt_state_changed.json")) continue;
    try {
      const value: unknown = JSON.parse(await readFile(join(attempt.path, entry.name), "utf8"));
      if (
        isRuntimeEvent(value) &&
        value.kind === "attempt_state_changed" &&
        (value.payload.code !== undefined ||
          ["failed", "cancelled", "abandoned", "recovery_required"].includes(value.payload.status))
      ) {
        errorCount = 1;
      }
    } catch {
      // 列表页只提供快速概览；损坏文件由选中 Run 的详情页报告 warning。
    }
  }
  return {
    eventCount:
      trajectoryEventFiles.length > 0 ? trajectoryEventFiles.length : runtimeEventFiles.length,
    errorCount,
  };
}

async function runSummaries(runs: readonly RunDirectory[], provider?: RunMetadataProvider) {
  const metadata = await resolveMetadata(runs, provider);
  return Promise.all(
    runs.map(async (run) => {
      const attempts = await Promise.all(run.attempts.map(summarizeAttempt));
      const display = metadata.get(run.runId);
      return {
        runId: run.runId,
        ...(display === undefined
          ? {}
          : {
              threadId: display.threadId,
              title: display.title,
              ...(display.createdAt === undefined ? {} : { createdAt: display.createdAt }),
            }),
        updatedAt: run.updatedAt,
        attemptCount: attempts.length,
        eventCount: attempts.reduce((sum, attempt) => sum + attempt.eventCount, 0),
        errorCount: attempts.reduce((sum, attempt) => sum + attempt.errorCount, 0),
      };
    }),
  );
}

interface MutableThreadSummary {
  readonly id: string;
  readonly threadId?: string;
  readonly title?: string;
  updatedAt: string;
  runCount: number;
  attemptCount: number;
  eventCount: number;
  errorCount: number;
  readonly runIds: string[];
}

async function threadSummaries(runs: readonly RunDirectory[], provider?: RunMetadataProvider) {
  const summaries = await runSummaries(runs, provider);
  const grouped = new Map<string, MutableThreadSummary>();
  for (const summary of summaries) {
    const id = summary.threadId ?? summary.runId;
    const existing = grouped.get(id);
    if (existing === undefined) {
      grouped.set(id, {
        id,
        ...(summary.threadId === undefined ? {} : { threadId: summary.threadId }),
        ...(summary.title === undefined ? {} : { title: summary.title }),
        updatedAt: summary.updatedAt,
        runCount: 1,
        attemptCount: summary.attemptCount,
        eventCount: summary.eventCount,
        errorCount: summary.errorCount,
        runIds: [summary.runId],
      });
      continue;
    }
    existing.updatedAt =
      existing.updatedAt.localeCompare(summary.updatedAt) >= 0
        ? existing.updatedAt
        : summary.updatedAt;
    existing.runCount += 1;
    existing.attemptCount += summary.attemptCount;
    existing.eventCount += summary.eventCount;
    existing.errorCount += summary.errorCount;
    existing.runIds.push(summary.runId);
  }
  return [...grouped.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function threadDetails(
  id: string,
  runs: readonly RunDirectory[],
  provider?: RunMetadataProvider,
) {
  const metadata = await resolveMetadata(runs, provider);
  const selected = runs
    .filter((run) => (metadata.get(run.runId)?.threadId ?? run.runId) === id)
    .sort((left, right) => {
      const leftTime = metadata.get(left.runId)?.createdAt ?? left.updatedAt;
      const rightTime = metadata.get(right.runId)?.createdAt ?? right.updatedAt;
      return leftTime.localeCompare(rightTime);
    });
  const first = selected[0];
  if (first === undefined) return undefined;
  const details = await Promise.all(
    selected.map((run) => readRunDetails(run, metadata.get(run.runId))),
  );
  const segments = details.flatMap((run) => {
    const attempt = run.attempts.at(-1);
    return attempt === undefined
      ? []
      : [
          {
            runId: run.runId,
            attemptId: attempt.attemptId,
            projection: attempt.internalTrajectory,
          },
        ];
  });
  const display = metadata.get(first.runId);
  return {
    id,
    ...(display === undefined ? {} : { threadId: display.threadId, title: display.title }),
    updatedAt: selected.at(-1)?.updatedAt ?? first.updatedAt,
    runs: details,
    internalTrajectory: combineDeepSeekTrajectoryProjections(segments),
  };
}

async function safeTraceFile(
  root: string,
  runId: string | null,
  attemptId: string | null,
  name: string | null,
): Promise<string | undefined> {
  if (
    runId === null ||
    attemptId === null ||
    name === null ||
    !identifierPattern.test(runId) ||
    !identifierPattern.test(attemptId) ||
    wireFilePattern.exec(name) === null ||
    basename(name) !== name
  ) {
    return undefined;
  }
  const runPath = await safeChildDirectory(root, runId);
  if (runPath === undefined) return undefined;
  const attemptPath = await safeChildDirectory(runPath, attemptId);
  if (attemptPath === undefined) return undefined;
  const filePath = join(attemptPath, name);
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumTraceFileBytes) {
      return undefined;
    }
    const actual = await realpath(filePath);
    return isContained(attemptPath, actual) ? actual : undefined;
  } catch {
    return undefined;
  }
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: TrajectoryServerOptions,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    text(response, 405, "Method Not Allowed");
    return;
  }
  const url = new URL(request.url ?? "/", `http://${options.host}:${options.port}`);
  if (url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(trajectoryHtml),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : trajectoryHtml);
    return;
  }
  const runs = await discoverRuns(options.root);
  if (url.pathname === "/api/threads") {
    json(response, 200, { items: await threadSummaries(runs, options.metadata) });
    return;
  }
  if (url.pathname.startsWith("/api/threads/")) {
    const threadId = decodeURIComponent(url.pathname.slice("/api/threads/".length));
    if (!identifierPattern.test(threadId)) {
      json(response, 404, { error: "THREAD_NOT_FOUND" });
      return;
    }
    const thread = await threadDetails(threadId, runs, options.metadata);
    if (thread === undefined) {
      json(response, 404, { error: "THREAD_NOT_FOUND" });
      return;
    }
    json(response, 200, thread);
    return;
  }
  if (url.pathname === "/api/runs") {
    json(response, 200, { items: await runSummaries(runs, options.metadata) });
    return;
  }
  if (url.pathname.startsWith("/api/runs/")) {
    const runId = decodeURIComponent(url.pathname.slice("/api/runs/".length));
    const run = runs.find((candidate) => candidate.runId === runId);
    if (run === undefined) {
      json(response, 404, { error: "RUN_NOT_FOUND" });
      return;
    }
    json(response, 200, await runDetails(run, options.metadata));
    return;
  }
  if (url.pathname === "/api/files") {
    const root = await safeRootDirectory(options.root);
    const path =
      root === undefined
        ? undefined
        : await safeTraceFile(
            root,
            url.searchParams.get("run"),
            url.searchParams.get("attempt"),
            url.searchParams.get("name"),
          );
    if (path === undefined) {
      text(response, 404, "TRACE_FILE_NOT_FOUND");
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": body.byteLength,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${basename(path)}"`,
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  json(response, 404, { error: "NOT_FOUND" });
}

export function startTrajectoryServer(options: TrajectoryServerOptions) {
  if (options.host !== "127.0.0.1" && options.host !== "::1") {
    throw new TypeError("轨迹服务只允许监听回环地址");
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65_535) {
    throw new TypeError("轨迹服务端口无效");
  }
  const server = createServer((request, response) => {
    handle(request, response, options).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "INTERNAL" });
      else response.destroy();
    });
  });
  return new Promise<{
    readonly url: string;
    close(): Promise<void>;
  }>((resolveStarted, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolveStarted({
        url: `http://${options.host}:${options.port}`,
        close: () =>
          new Promise<void>((resolveClosed, rejectClosed) =>
            server.close((error) => (error === undefined ? resolveClosed() : rejectClosed(error))),
          ),
      });
    });
  });
}

export const internalTesting = Object.freeze({
  safeTraceFile,
  readAttempt,
  summarizeAttempt,
  runDetails,
  runSummaries,
  threadDetails,
  threadSummaries,
});
