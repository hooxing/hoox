import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertModelWireTraceContext,
  type ModelWireTracePort,
  type ModelWireTraceRecord,
} from "./model-wire-trace.js";

export const PROJECT_MODEL_WIRE_TRACE_ROOT = fileURLToPath(
  new URL("../../../../model-wire-traces/", import.meta.url),
);

/**
 * 将开发诊断同步镜像到固定项目目录。目标文件只通过同目录 hard link 原子发布；相同字节
 * 可幂等重放，不同字节绝不覆盖已有排障证据。
 */
export class ProjectModelWireTraceMirror implements ModelWireTracePort {
  readonly #root: string;

  constructor(root = PROJECT_MODEL_WIRE_TRACE_ROOT) {
    if (!isAbsolute(root)) throw new TypeError("模型网络本地镜像根目录必须是绝对路径");
    this.#root = resolve(root);
  }

  async persist(record: ModelWireTraceRecord): Promise<void> {
    assertMirrorRecord(record);
    const directory = join(this.#root, record.context.runId, record.context.attemptId);
    const extension = record.part === "request" ? "json" : "sse";
    const turn = String(record.modelTurn).padStart(2, "0");
    const filename = `model-turn-${turn}-transport-${record.transportAttempt}-${record.part}-${record.status}.${extension}`;
    await writeOnceAtomically(join(directory, filename), record.body);
  }

  async captureFailed(): Promise<void> {
    // 没有成功读出的原始正文可供镜像；失败事实仍只进入权威 PG/MinIO 诊断面。
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
  createMirror: () => ModelWireTracePort = () => new ProjectModelWireTraceMirror(),
): ModelWireTracePort {
  if (runtimeMode !== "development") return authoritative;
  return new BestEffortMirroredModelWireTracePort(authoritative, createMirror());
}

async function writeOnceAtomically(target: string, body: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
    } catch (error) {
      if (!isAlreadyExists(error) || !(await sameBytes(target, body))) {
        throw new Error("LOCAL_MODEL_WIRE_TRACE_CONFLICT", { cause: error });
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function sameBytes(target: string, expected: Uint8Array): Promise<boolean> {
  const actual = await readFile(target).catch(() => undefined);
  return (
    actual !== undefined && actual.byteLength === expected.byteLength && actual.equals(expected)
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
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
  if (!new Set(["complete", "truncated", "aborted", "failed"]).has(record.status))
    throw new TypeError("模型网络本地镜像状态无效");
  if (!(record.body instanceof Uint8Array) || record.size !== record.body.byteLength)
    throw new TypeError("模型网络本地镜像正文无效");
}
