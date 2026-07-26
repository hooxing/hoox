import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  WorkspaceCoreApplicationError as WorkspaceApplicationError,
  WorkspaceDependencyError,
} from "./application-errors.js";
import type {
  SandboxSessionIdentity,
  SandboxWorkspaceSnapshot,
  WorkspaceExecutionPolicy,
  WorkspaceKnownFailureDisposition,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceTrustedScope,
  WorkspaceUnknownFact,
} from "./application-ports.js";
import type { WorkspaceContentIdentity } from "./manifest.js";
import type { WorkspaceStableObjectIdentity } from "./manifest.js";

const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SCOPED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SNAPSHOT_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INCARNATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type UnknownMethod = (...args: unknown[]) => unknown;

export function validateOperationKey(value: string): string {
  if (!OPERATION_KEY_PATTERN.test(value)) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "operationKey 格式无效");
  }
  return value;
}

export function validateTrustedScope(value: WorkspaceTrustedScope): WorkspaceTrustedScope {
  const input = plainDataRecord(value, "WorkspaceTrustedScope");
  exactKeys(input, ["tenantId", "threadId", "workspaceId"], "WorkspaceTrustedScope");
  for (const name of ["tenantId", "threadId", "workspaceId"] as const) {
    if (typeof input[name] !== "string" || !SCOPED_ID_PATTERN.test(input[name])) {
      throw new WorkspaceApplicationError("INVALID_INPUT", `${name} 格式无效`);
    }
  }
  return Object.freeze({
    tenantId: input.tenantId as string,
    threadId: input.threadId as string,
    workspaceId: input.workspaceId as string,
  });
}

export function parseSandboxSession(value: unknown): SandboxSessionIdentity {
  const input = plainDataRecord(value, "SandboxSessionIdentity");
  exactKeys(input, ["sessionId", "generation"], "SandboxSessionIdentity");
  if (typeof input.sessionId !== "string" || !SESSION_ID_PATTERN.test(input.sessionId)) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "Sandbox sessionId 格式无效");
  }
  if (!Number.isSafeInteger(input.generation) || (input.generation as number) < 1) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "Sandbox generation 格式无效");
  }
  return Object.freeze({ sessionId: input.sessionId, generation: input.generation as number });
}

export function parseSandboxSnapshot(value: unknown): SandboxWorkspaceSnapshot {
  const input = plainDataRecord(value, "SandboxWorkspaceSnapshot");
  exactKeys(input, ["sessionId", "generation", "snapshotToken"], "SandboxWorkspaceSnapshot");
  const session = parseSandboxSession({
    sessionId: input.sessionId,
    generation: input.generation,
  });
  if (
    typeof input.snapshotToken !== "string" ||
    !SNAPSHOT_TOKEN_PATTERN.test(input.snapshotToken)
  ) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "Sandbox snapshotToken 格式无效");
  }
  return Object.freeze({ ...session, snapshotToken: input.snapshotToken });
}

export function validatePolicy(policy: WorkspaceExecutionPolicy): WorkspaceExecutionPolicy {
  const input = plainDataRecord(policy, "WorkspaceExecutionPolicy");
  exactKeys(
    input,
    [
      "maxEntries",
      "maxFiles",
      "maxTotalBytes",
      "maxSingleFileBytes",
      "maxChunkBytes",
      "maxPathUtf8Bytes",
      "historicalManifest",
    ],
    "WorkspaceExecutionPolicy",
  );
  for (const name of [
    "maxEntries",
    "maxFiles",
    "maxTotalBytes",
    "maxSingleFileBytes",
    "maxChunkBytes",
    "maxPathUtf8Bytes",
  ] as const) {
    const value = input[name];
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new WorkspaceApplicationError("INVALID_INPUT", `${name} 必须是正安全整数`);
    }
  }
  if ((input.maxFiles as number) > (input.maxEntries as number)) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "maxFiles 不能超过 maxEntries");
  }
  if ((input.maxSingleFileBytes as number) > (input.maxTotalBytes as number)) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "单文件配额不能超过总配额");
  }
  const historical = plainDataRecord(input.historicalManifest, "historicalManifest");
  const allowed = ["maxFiles", "maxTotalBytes", "maxSingleFileBytes", "maxPathUtf8Bytes"];
  if (
    !Object.hasOwn(historical, "maxFiles") ||
    !Object.hasOwn(historical, "maxTotalBytes") ||
    Object.keys(historical).some((key) => !allowed.includes(key))
  ) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "historicalManifest 策略字段无效");
  }
  for (const [name, value] of Object.entries(historical)) {
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new WorkspaceApplicationError("INVALID_INPUT", `historicalManifest.${name} 无效`);
    }
  }
  return Object.freeze({
    maxEntries: input.maxEntries as number,
    maxFiles: input.maxFiles as number,
    maxTotalBytes: input.maxTotalBytes as number,
    maxSingleFileBytes: input.maxSingleFileBytes as number,
    maxChunkBytes: input.maxChunkBytes as number,
    maxPathUtf8Bytes: input.maxPathUtf8Bytes as number,
    historicalManifest: Object.freeze({
      maxFiles: historical.maxFiles as number,
      maxTotalBytes: historical.maxTotalBytes as number,
      ...(historical.maxSingleFileBytes === undefined
        ? {}
        : { maxSingleFileBytes: historical.maxSingleFileBytes as number }),
      ...(historical.maxPathUtf8Bytes === undefined
        ? {}
        : { maxPathUtf8Bytes: historical.maxPathUtf8Bytes as number }),
    }),
  });
}

export function stopPoint(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WorkspaceApplicationError("CANCELLED", "Workspace 操作已在安全停止点取消");
  }
}

export async function beginOperation(
  journal: WorkspaceOperationJournalPort,
  identity: WorkspaceOperationIdentity,
): Promise<
  { readonly status: "started" } | { readonly status: "completed"; readonly result: unknown }
> {
  let raw: unknown;
  try {
    raw = await journal.begin(identity);
  } catch (error) {
    throw journalError(error, "读取 Workspace operation journal 失败");
  }
  const state = plainDataRecord(raw, "WorkspaceOperationBeginResult");
  if (state.status === "started") {
    exactKeys(state, ["status"], "WorkspaceOperationBeginResult");
    return { status: "started" };
  }
  if (state.status === "completed") {
    exactKeys(state, ["status", "result"], "WorkspaceOperationBeginResult");
    return { status: "completed", result: state.result };
  }
  exactKeys(state, ["status"], "WorkspaceOperationBeginResult");
  if (state.status === "conflict") {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "operationKey 已永久绑定其他输入");
  }
  if (state.status === "in_progress") {
    throw new WorkspaceApplicationError("OPERATION_IN_PROGRESS", "Workspace 操作正在执行");
  }
  if (state.status === "unknown") {
    throw new WorkspaceApplicationError("RESULT_UNKNOWN", "Workspace 操作等待外部结果对账");
  }
  if (state.status === "terminal") {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "Workspace 操作已终态失败");
  }
  throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace journal 返回非法状态");
}

export async function mapDependencyFailure(
  error: unknown,
  input: {
    readonly journal: WorkspaceOperationJournalPort;
    readonly identity: WorkspaceOperationIdentity;
    readonly phase: string;
    readonly now: () => Date;
  },
): Promise<never> {
  if (error instanceof WorkspaceApplicationError) throw error;
  const dependencyCode = dependencyCodeFor(error);
  if (error instanceof WorkspaceDependencyError && error.result === "unknown") {
    const fact: WorkspaceUnknownFact = Object.freeze({
      operationKey: input.identity.operationKey,
      kind: input.identity.kind,
      inputDigest: input.identity.inputDigest,
      phase: input.phase,
      dependencyCode,
      occurredAt: input.now().toISOString(),
    });
    try {
      await input.journal.recordUnknown(input.identity, fact);
    } catch (journalFailure) {
      throw journalError(journalFailure, "Workspace UNKNOWN 事实写入失败");
    }
    throw new WorkspaceApplicationError("RESULT_UNKNOWN", "外部副作用结果未知，已登记等待对账");
  }
  throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace 外部依赖调用失败");
}

export async function recordKnownFailure(
  journal: WorkspaceOperationJournalPort,
  identity: WorkspaceOperationIdentity,
  phase: string,
  error: WorkspaceApplicationError,
): Promise<void> {
  const disposition: WorkspaceKnownFailureDisposition = isRetryable(error.code)
    ? "retryable"
    : "terminal";
  try {
    await journal.failKnown({
      identity,
      phase,
      code: error.code,
      disposition,
    });
  } catch (journalFailure) {
    throw journalError(journalFailure, "Workspace known failure 写入失败");
  }
}

function isRetryable(code: WorkspaceApplicationError["code"]): boolean {
  return code === "CANCELLED" || code === "DEPENDENCY_FAILED";
}

function dependencyCodeFor(error: unknown): string {
  return error instanceof WorkspaceDependencyError &&
    /^[A-Z0-9_]{1,64}$/u.test(error.dependencyCode)
    ? error.dependencyCode
    : "UNCLASSIFIED";
}

function journalError(error: unknown, message: string): WorkspaceApplicationError {
  return new WorkspaceJournalError(
    error instanceof WorkspaceDependencyError && error.result === "unknown"
      ? "RESULT_UNKNOWN"
      : "DEPENDENCY_FAILED",
    message,
  );
}

class WorkspaceJournalError extends WorkspaceApplicationError {}

export function isWorkspaceJournalError(error: WorkspaceApplicationError): boolean {
  return error instanceof WorkspaceJournalError;
}

export function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    utilTypes.isProxy(value) ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 必须是普通数据对象`);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 不可安全读取`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 必须是普通数据对象`);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 含非法字段`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 字段不符合契约`);
  }
}

export function parseContentIdentity(value: unknown): WorkspaceContentIdentity {
  const input = plainDataRecord(value, "WorkspaceContentIdentity");
  exactKeys(input, ["sha256", "size"], "WorkspaceContentIdentity");
  if (
    typeof input.sha256 !== "string" ||
    !SHA256_PATTERN.test(input.sha256) ||
    !Number.isSafeInteger(input.size) ||
    (input.size as number) < 0
  ) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace 内容身份字段无效");
  }
  return Object.freeze({ sha256: input.sha256, size: input.size as number });
}

export function parseStableObjectIdentity(value: unknown): WorkspaceStableObjectIdentity {
  const input = plainDataRecord(value, "WorkspaceStableObjectIdentity");
  exactKeys(
    input,
    ["tenantId", "purpose", "incarnationId", "physicalObjectKey"],
    "WorkspaceStableObjectIdentity",
  );
  if (
    typeof input.tenantId !== "string" ||
    !SCOPED_ID_PATTERN.test(input.tenantId) ||
    input.purpose !== "workspace" ||
    typeof input.incarnationId !== "string" ||
    !INCARNATION_ID_PATTERN.test(input.incarnationId) ||
    typeof input.physicalObjectKey !== "string"
  ) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace stable 对象身份字段无效");
  }
  return Object.freeze({
    tenantId: input.tenantId,
    purpose: "workspace",
    incarnationId: input.incarnationId,
    physicalObjectKey: input.physicalObjectKey,
  });
}

export function parseExternalAsyncIterable<T>(value: unknown, label: string): AsyncIterable<T> {
  if (
    utilTypes.isProxy(value) ||
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 必须是可信流对象`);
  }
  const source = value as object;
  // 只从属性描述符捕获一次协议函数。后续消费核心包装器时，不再读取适配器对象，
  // 既阻断 getter 切换，也避免 freeze 破坏有内部状态的 provider 流。
  const iteratorFactory = captureDataMethod(source, Symbol.asyncIterator, label, true);
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const externalIterator: unknown = Reflect.apply(iteratorFactory, source, []);
      if (
        utilTypes.isProxy(externalIterator) ||
        (typeof externalIterator !== "object" && typeof externalIterator !== "function") ||
        externalIterator === null
      ) {
        throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 返回了非法异步迭代器`);
      }
      const next = captureDataMethod(externalIterator, "next", `${label} 迭代器`, true);
      const returnMethod = captureDataMethod(externalIterator, "return", `${label} 迭代器`, false);
      const throwMethod = captureDataMethod(externalIterator, "throw", `${label} 迭代器`, false);

      const wrapper: AsyncIterableIterator<T> = {
        next: () => invokeExternalIteratorMethod<T>(externalIterator, next, [], label),
        return: (result?: unknown) =>
          returnMethod === undefined
            ? Promise.resolve(Object.freeze({ done: true, value: result as T }))
            : invokeExternalIteratorMethod<T>(externalIterator, returnMethod, [result], label),
        throw: (error?: unknown) =>
          throwMethod === undefined
            ? Promise.reject(error)
            : invokeExternalIteratorMethod<T>(externalIterator, throwMethod, [error], label),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return Object.freeze(wrapper);
    },
  });
}

function captureDataMethod(
  source: object,
  key: PropertyKey,
  label: string,
  required: true,
): UnknownMethod;
function captureDataMethod(
  source: object,
  key: PropertyKey,
  label: string,
  required: false,
): UnknownMethod | undefined;
function captureDataMethod(
  source: object,
  key: PropertyKey,
  label: string,
  required: boolean,
): UnknownMethod | undefined {
  let current: object | null = source;
  try {
    while (current !== null) {
      if (utilTypes.isProxy(current)) {
        throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 必须是可信流对象`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 协议方法不安全`);
        }
        return descriptor.value as UnknownMethod;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (error instanceof WorkspaceApplicationError) throw error;
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 不可安全读取`);
  }
  if (required) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 缺少异步迭代协议`);
  }
  return undefined;
}

function invokeExternalIteratorMethod<T>(
  iterator: object,
  method: UnknownMethod,
  args: readonly unknown[],
  label: string,
): Promise<IteratorResult<T>> {
  let pending: unknown;
  try {
    pending = Reflect.apply(method, iterator, args);
  } catch (error) {
    return Promise.reject(error);
  }
  if (utilTypes.isProxy(pending)) {
    return Promise.reject(
      new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 迭代结果不安全`),
    );
  }
  if (utilTypes.isPromise(pending)) {
    // 绕过外部 Promise 子类可能覆盖的 then 属性，直接使用原生内部槽完成解析。
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      try {
        Reflect.apply(Promise.prototype.then, pending, [
          (result: unknown) => {
            try {
              resolve(parseExternalIteratorResult<T>(result, label));
            } catch (error) {
              reject(error);
            }
          },
          reject,
        ]);
      } catch {
        reject(new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 迭代结果不安全`));
      }
    });
  }
  try {
    return Promise.resolve(parseExternalIteratorResult<T>(pending, label));
  } catch (error) {
    return Promise.reject(error);
  }
}

function parseExternalIteratorResult<T>(value: unknown, label: string): IteratorResult<T> {
  const input = plainDataRecord(value, `${label} 迭代结果`);
  const keys = Object.keys(input).sort();
  if (
    !Object.hasOwn(input, "done") ||
    typeof input.done !== "boolean" ||
    keys.some((key) => key !== "done" && key !== "value") ||
    keys.length > 2 ||
    (input.done === false && !Object.hasOwn(input, "value"))
  ) {
    throw new WorkspaceApplicationError("DEPENDENCY_FAILED", `${label} 迭代结果字段无效`);
  }
  return Object.freeze({ done: input.done, value: input.value as T }) as IteratorResult<T>;
}

export function parseExternalStream(value: unknown, label: string): AsyncIterable<Uint8Array> {
  return parseExternalAsyncIterable<Uint8Array>(value, label);
}

export interface StreamVerification {
  readonly body: AsyncIterable<Uint8Array>;
  readonly result: Promise<WorkspaceContentIdentity>;
  readonly status: () => "pending" | "completed" | "failed";
}

export function verifyingStream(input: {
  readonly source: AsyncIterable<Uint8Array>;
  readonly policy: WorkspaceExecutionPolicy;
  readonly signal?: AbortSignal;
  readonly expected?: WorkspaceContentIdentity;
}): StreamVerification {
  let resolveResult: (value: WorkspaceContentIdentity) => void = () => undefined;
  let rejectResult: (reason: unknown) => void = () => undefined;
  let status: "pending" | "completed" | "failed" = "pending";
  const result = new Promise<WorkspaceContentIdentity>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => undefined);
  const body = (async function* () {
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const rawChunk of input.source) {
        stopPoint(input.signal);
        if (!(rawChunk instanceof Uint8Array)) {
          throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "文件流包含非法数据块");
        }
        if (rawChunk.byteLength > input.policy.maxChunkBytes) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "单个文件流数据块超过内存策略");
        }
        if (size > input.policy.maxSingleFileBytes - rawChunk.byteLength) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "单文件超过 Workspace 配额");
        }
        const chunk = Uint8Array.from(rawChunk);
        size += chunk.byteLength;
        hash.update(chunk);
        yield chunk;
      }
      const identity = Object.freeze({ sha256: hash.digest("hex"), size });
      if (
        input.expected !== undefined &&
        (identity.sha256 !== input.expected.sha256 || identity.size !== input.expected.size)
      ) {
        throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "文件内容与声明身份不一致");
      }
      status = "completed";
      resolveResult(identity);
    } catch (error) {
      status = "failed";
      rejectResult(error);
      throw error;
    }
  })();
  return { body, result, status: () => status };
}

export async function digestStream(input: {
  readonly source: AsyncIterable<Uint8Array>;
  readonly policy: WorkspaceExecutionPolicy;
  readonly signal?: AbortSignal;
  readonly expected?: WorkspaceContentIdentity;
}): Promise<WorkspaceContentIdentity> {
  const verified = verifyingStream(input);
  for await (const _chunk of verified.body) {
    // 只做摘要和配额验证，不保留内容。
  }
  return verified.result;
}
