import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  InternalTrajectoryDiagnosticRecord,
  InternalTrajectoryDiagnosticsPort,
  InternalTrajectoryEventV1,
} from "@aisay/trajectory";
import {
  assertModelWireTraceContext,
  type ModelWireTracePort,
  type ModelWireTraceRecord,
} from "./model-wire-trace.js";
import type { RuntimeEventV1 } from "./ports.js";
import type { RunEventDiagnosticRecord, RunEventDiagnosticsPort } from "./run-event-diagnostics.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const PROJECT_MODEL_WIRE_TRACE_ROOT = join(PROJECT_ROOT, "model-wire-traces");
const captureStatuses = new Set(["complete", "truncated", "aborted", "failed"]);
const eventKinds = new Set(["agent_event", "attempt_state_changed", "run_waiting"]);

interface OpenMirrorDirectory {
  readonly path: string;
  readonly verify: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * 将开发诊断同步镜像到固定项目目录。目标文件只通过同目录 hard link 原子发布；相同字节
 * 可幂等重放，不同字节绝不覆盖已有排障证据。
 */
export class ProjectModelWireTraceMirror implements ModelWireTracePort {
  readonly #trustedBase: string;
  readonly #rootSegments: readonly string[];

  constructor(root = PROJECT_MODEL_WIRE_TRACE_ROOT, trustedBase = dirname(root)) {
    if (!isAbsolute(root) || !isAbsolute(trustedBase))
      throw new TypeError("模型网络本地镜像根目录必须是绝对路径");
    const lexicalBase = resolve(trustedBase);
    const lexicalRoot = resolve(root);
    const rootRelative = relative(lexicalBase, lexicalRoot);
    if (!isContainedRelative(rootRelative))
      throw new TypeError("模型网络本地镜像根目录越出受信边界");
    const segments = rootRelative.split(sep).filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
      throw new TypeError("模型网络本地镜像根目录无效");
    this.#trustedBase = lexicalBase;
    this.#rootSegments = Object.freeze(segments);
  }

  async persist(record: ModelWireTraceRecord): Promise<void> {
    assertMirrorRecord(record);
    const agentSegments =
      record.context.agentThreadId === undefined
        ? []
        : ["subagents", record.context.agentThreadId, record.context.agentTurnId as string];
    const directory = await openMirrorDirectory(this.#trustedBase, [
      ...this.#rootSegments,
      record.context.runId,
      record.context.attemptId,
      ...agentSegments,
    ]);
    try {
      const extension = record.part === "request" ? "json" : "sse";
      const turn = String(record.modelTurn).padStart(2, "0");
      const filename = `model-turn-${turn}-transport-${record.transportAttempt}-${record.part}-${record.status}.${extension}`;
      await writeOnceAtomically(directory, filename, record.body);
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  async captureFailed(): Promise<void> {
    // 没有成功读出的原始正文可供镜像；失败事实仍只进入权威 PG/MinIO 诊断面。
  }
}

/**
 * 将已经形成 durable mutation 的 Run 事件写成逐事件不可变文件。逐事件文件避免 append
 * 在进程退出或幂等重放时产生半行、重复行或覆盖既有证据。
 */
export class ProjectRunEventMirror implements RunEventDiagnosticsPort {
  readonly #trustedBase: string;
  readonly #rootSegments: readonly string[];

  constructor(root = PROJECT_MODEL_WIRE_TRACE_ROOT, trustedBase = dirname(root)) {
    if (!isAbsolute(root) || !isAbsolute(trustedBase))
      throw new TypeError("Run 事件本地镜像根目录必须是绝对路径");
    const lexicalBase = resolve(trustedBase);
    const lexicalRoot = resolve(root);
    const rootRelative = relative(lexicalBase, lexicalRoot);
    if (!isContainedRelative(rootRelative))
      throw new TypeError("Run 事件本地镜像根目录越出受信边界");
    const segments = rootRelative.split(sep).filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
      throw new TypeError("Run 事件本地镜像根目录无效");
    this.#trustedBase = lexicalBase;
    this.#rootSegments = Object.freeze(segments);
  }

  async persist(record: RunEventDiagnosticRecord): Promise<void> {
    assertModelWireTraceContext(record.context);
    assertRunEvent(record.event);
    const directory = await openMirrorDirectory(this.#trustedBase, [
      ...this.#rootSegments,
      record.context.runId,
      record.context.attemptId,
    ]);
    try {
      const sequence = String(record.event.sequence).padStart(8, "0");
      const filename = `runtime-event-${sequence}-${record.event.kind}.json`;
      const body = new TextEncoder().encode(`${canonicalJson(record.event)}\n`);
      await writeOnceAtomically(directory, filename, body);
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
}

/**
 * Pi 原始事件逐条不可变保存；正文已经由 trajectory 包转换为无截断、可逆的 JSON 快照。
 * root 与 subagent 使用独立目录，避免各 Session 的局部 sequence 冲突。
 */
export class ProjectInternalTrajectoryMirror implements InternalTrajectoryDiagnosticsPort {
  readonly #trustedBase: string;
  readonly #rootSegments: readonly string[];

  constructor(root = PROJECT_MODEL_WIRE_TRACE_ROOT, trustedBase = dirname(root)) {
    if (!isAbsolute(root) || !isAbsolute(trustedBase))
      throw new TypeError("内部轨迹本地镜像根目录必须是绝对路径");
    const lexicalBase = resolve(trustedBase);
    const lexicalRoot = resolve(root);
    const rootRelative = relative(lexicalBase, lexicalRoot);
    if (!isContainedRelative(rootRelative))
      throw new TypeError("内部轨迹本地镜像根目录越出受信边界");
    const segments = rootRelative.split(sep).filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".."))
      throw new TypeError("内部轨迹本地镜像根目录无效");
    this.#trustedBase = lexicalBase;
    this.#rootSegments = Object.freeze(segments);
  }

  async persist(record: InternalTrajectoryDiagnosticRecord): Promise<void> {
    assertModelWireTraceContext(record.context);
    assertInternalTrajectoryEvent(record.event);
    const agentSegments =
      record.context.agentThreadId === undefined
        ? []
        : ["subagents", record.context.agentThreadId, record.context.agentTurnId as string];
    const directory = await openMirrorDirectory(this.#trustedBase, [
      ...this.#rootSegments,
      record.context.runId,
      record.context.attemptId,
      ...agentSegments,
    ]);
    try {
      const sequence = String(record.event.sequence).padStart(8, "0");
      const filename = `trajectory-event-${sequence}.json`;
      const body = new TextEncoder().encode(`${canonicalJson(record.event)}\n`);
      await writeOnceAtomically(directory, filename, body);
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
}

/** 本地镜像永远是 best-effort；只有权威端口失败才能进入既有 durable 诊断失败语义。 */
class BestEffortMirroredModelWireTracePort implements ModelWireTracePort {
  constructor(
    private readonly authoritative: ModelWireTracePort,
    private readonly mirror: ModelWireTracePort,
  ) {}

  async persist(record: ModelWireTraceRecord): Promise<void> {
    const [authoritative] = await Promise.allSettled([
      this.authoritative.persist(record),
      this.mirror.persist(record),
    ]);
    if (authoritative.status === "rejected") throw authoritative.reason;
  }

  async captureFailed(input: Parameters<ModelWireTracePort["captureFailed"]>[0]): Promise<void> {
    await this.authoritative.captureFailed(input);
  }
}

/**
 * 生产即使未来允许权威诊断采集，也不得创建项目目录镜像；当前仅 development enabled
 * 装配会调用此边界。
 */
export function withDevelopmentProjectModelWireTraceMirror(
  runtimeMode: "development" | "production",
  authoritative: ModelWireTracePort,
  createMirror: () => ModelWireTracePort = () =>
    new ProjectModelWireTraceMirror(PROJECT_MODEL_WIRE_TRACE_ROOT, PROJECT_ROOT),
): ModelWireTracePort {
  if (runtimeMode !== "development") return authoritative;
  return new BestEffortMirroredModelWireTracePort(authoritative, createMirror());
}

/** 与原始模型报文共用显式敏感诊断开关；production 永不创建宿主机文件镜像。 */
export function createDevelopmentProjectRunEventMirror(
  runtimeMode: "development" | "production",
  enabled: boolean,
  createMirror: () => RunEventDiagnosticsPort = () =>
    new ProjectRunEventMirror(PROJECT_MODEL_WIRE_TRACE_ROOT, PROJECT_ROOT),
): RunEventDiagnosticsPort | undefined {
  return runtimeMode === "development" && enabled ? createMirror() : undefined;
}

export function createDevelopmentProjectInternalTrajectoryMirror(
  runtimeMode: "development" | "production",
  enabled: boolean,
  createMirror: () => InternalTrajectoryDiagnosticsPort = () =>
    new ProjectInternalTrajectoryMirror(PROJECT_MODEL_WIRE_TRACE_ROOT, PROJECT_ROOT),
): InternalTrajectoryDiagnosticsPort | undefined {
  return runtimeMode === "development" && enabled ? createMirror() : undefined;
}

async function openMirrorDirectory(
  trustedBase: string,
  segments: readonly string[],
): Promise<OpenMirrorDirectory> {
  const realBase = await realpath(trustedBase);
  if (process.platform === "linux") return openLinuxMirrorDirectory(realBase, segments);
  return openPortableMirrorDirectory(realBase, segments);
}

/**
 * Node 尚未公开 openat；Linux 使用 O_NOFOLLOW 目录句柄和 /proc/self/fd 相对路径保持父目录
 * inode 打开，避免检查后的 root/run/attempt 被替换为链接。
 */
async function openLinuxMirrorDirectory(
  realBase: string,
  segments: readonly string[],
): Promise<OpenMirrorDirectory> {
  const noFollow = requiredFlag("O_NOFOLLOW");
  const directoryFlag = requiredFlag("O_DIRECTORY");
  let current = await open(realBase, constants.O_RDONLY | noFollow | directoryFlag);
  let expected = realBase;
  try {
    await assertOpenDirectory(current, realBase, realBase);
    for (const segment of segments) {
      const childPath = `/proc/self/fd/${current.fd}/${segment}`;
      const expectedChild = join(expected, segment);
      await createDirectory(childPath);
      await assertPlainDirectory(childPath);
      const child = await open(childPath, constants.O_RDONLY | noFollow | directoryFlag);
      try {
        await assertOpenDirectory(child, realBase, expectedChild);
      } catch (error) {
        await child.close().catch(() => undefined);
        throw error;
      }
      await current.close();
      current = child;
      expected = expectedChild;
    }
    const handle = current;
    const expectedDirectory = expected;
    return Object.freeze({
      path: `/proc/self/fd/${handle.fd}`,
      verify: async () => assertOpenDirectory(handle, realBase, expectedDirectory),
      close: async () => handle.close(),
    });
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function openPortableMirrorDirectory(
  realBase: string,
  segments: readonly string[],
): Promise<OpenMirrorDirectory> {
  const verify = async () => {
    let current = realBase;
    for (const segment of segments) {
      const child = join(current, segment);
      await assertPlainDirectory(child);
      const realChild = await realpath(child);
      assertContained(realBase, realChild);
      if (!samePath(child, realChild)) throw new Error("LOCAL_MODEL_WIRE_TRACE_LINK_FORBIDDEN");
      current = realChild;
    }
  };
  let current = realBase;
  for (const segment of segments) {
    const child = join(current, segment);
    await createDirectory(child);
    await assertPlainDirectory(child);
    const realChild = await realpath(child);
    assertContained(realBase, realChild);
    if (!samePath(child, realChild)) throw new Error("LOCAL_MODEL_WIRE_TRACE_LINK_FORBIDDEN");
    current = realChild;
  }
  await verify();
  return Object.freeze({ path: current, verify, close: async () => undefined });
}

async function writeOnceAtomically(
  directory: OpenMirrorDirectory,
  filename: string,
  body: Uint8Array,
): Promise<void> {
  await directory.verify();
  const target = join(directory.path, filename);
  const temporary = join(
    directory.path,
    `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    const noFollow = optionalFlag("O_NOFOLLOW");
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await directory.verify();
    try {
      await link(temporary, target);
    } catch (error) {
      if (!isAlreadyExists(error) || !(await sameBytes(target, body))) {
        throw new Error("LOCAL_MODEL_WIRE_TRACE_CONFLICT", { cause: error });
      }
    }
    await directory.verify();
    const realTarget = await realpath(target);
    const realDirectory = await realpath(directory.path);
    assertContained(realDirectory, realTarget);
    await directory.verify();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function sameBytes(target: string, expected: Uint8Array): Promise<boolean> {
  const noFollow = optionalFlag("O_NOFOLLOW");
  const targetStats = await lstat(target).catch(() => undefined);
  if (targetStats === undefined || targetStats.isSymbolicLink() || !targetStats.isFile())
    return false;
  const handle = await open(target, constants.O_RDONLY | noFollow).catch(() => undefined);
  if (handle === undefined) return false;
  try {
    const actual = await readFile(handle);
    return actual.byteLength === expected.byteLength && actual.equals(expected);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function createDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
}

async function assertPlainDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error("LOCAL_MODEL_WIRE_TRACE_LINK_FORBIDDEN");
}

async function assertOpenDirectory(
  handle: FileHandle,
  trustedRealBase: string,
  expectedPath?: string,
): Promise<void> {
  const stats = await handle.stat();
  if (!stats.isDirectory()) throw new Error("LOCAL_MODEL_WIRE_TRACE_LINK_FORBIDDEN");
  const actual = await realpath(`/proc/self/fd/${handle.fd}`);
  assertContained(trustedRealBase, actual);
  if (expectedPath !== undefined && !samePath(expectedPath, actual))
    throw new Error("LOCAL_MODEL_WIRE_TRACE_LINK_FORBIDDEN");
}

function assertContained(trustedRealBase: string, candidate: string): void {
  if (!isContainedRelative(relative(trustedRealBase, candidate)))
    throw new Error("LOCAL_MODEL_WIRE_TRACE_PATH_ESCAPE");
}

function isContainedRelative(value: string): boolean {
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function requiredFlag(name: "O_NOFOLLOW" | "O_DIRECTORY"): number {
  const value = constants[name];
  if (typeof value !== "number") throw new Error(`LOCAL_MODEL_WIRE_TRACE_${name}_UNAVAILABLE`);
  return value;
}

function optionalFlag(name: "O_NOFOLLOW"): number {
  const value = constants[name];
  return typeof value === "number" ? value : 0;
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function assertMirrorRecord(record: ModelWireTraceRecord): void {
  assertModelWireTraceContext(record.context);
  if (!Number.isSafeInteger(record.modelTurn) || record.modelTurn < 0)
    throw new TypeError("模型网络本地镜像轮次无效");
  if (!Number.isSafeInteger(record.transportAttempt) || record.transportAttempt < 0)
    throw new TypeError("模型网络本地镜像传输次数无效");
  if (record.part !== "request" && record.part !== "response")
    throw new TypeError("模型网络本地镜像 part 无效");
  if (!captureStatuses.has(record.status)) throw new TypeError("模型网络本地镜像状态无效");
  if (!(record.body instanceof Uint8Array) || record.size !== record.body.byteLength)
    throw new TypeError("模型网络本地镜像正文无效");
}

function assertRunEvent(event: RuntimeEventV1): void {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0)
    throw new TypeError("Run 事件本地镜像序号无效");
  if (event.schemaVersion !== 1 || !eventKinds.has(event.kind))
    throw new TypeError("Run 事件本地镜像协议无效");
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload))
    throw new TypeError("Run 事件本地镜像正文无效");
}

function assertInternalTrajectoryEvent(event: InternalTrajectoryEventV1): void {
  if (event.schemaVersion !== 1 || !Number.isSafeInteger(event.sequence) || event.sequence < 1)
    throw new TypeError("内部轨迹本地镜像序号无效");
  if (!Number.isFinite(Date.parse(event.occurredAt)) || event.monotonicOffsetMs < 0)
    throw new TypeError("内部轨迹本地镜像时间无效");
  if ((event.source !== "pi" && event.source !== "runtime") || event.type.trim().length === 0)
    throw new TypeError("内部轨迹本地镜像类型无效");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value), null, 2);
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}
