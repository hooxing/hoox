import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  SandboxSessionIdentity,
  SandboxWorkspaceEntry,
  SandboxWorkspaceSnapshot,
  SandboxWorkspacePort as WorkspacePort,
  WorkspaceTrustedScope,
} from "@cube-runtime/workspace";
import {
  resolveWorkspaceTargetPath,
  SANDBOX_WORKSPACE_ROOT,
  WorkspaceDependencyError,
  workspaceRelativePath,
} from "@cube-runtime/workspace";
import type { CubeSdkSandbox } from "./cube-gateway.js";
import { mapSandboxError, SandboxRuntimeError, settledOperation } from "./errors.js";

const FILE_TYPE_FILE = "FILE_TYPE_FILE";
const FILE_TYPE_DIRECTORY = "FILE_TYPE_DIRECTORY";
const FILE_TYPE_SYMLINK = "FILE_TYPE_SYMLINK";
const READ_PROTOCOL = "CUBEWS1";

/** 由 Session registry / warm manager 提供；适配器不会接受裸 sessionId。 */
export interface TrustedSandboxSessionCapability {
  current(): Promise<SandboxSessionIdentity>;
}

export interface CubeWorkspaceAdapterOptions {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathUtf8Bytes: number;
  readonly maxCommandOutputBytes: number;
  readonly readChunkBytes: number;
  readonly maxSnapshots: number;
  readonly operationTimeoutMs: number;
}

interface AdapterOpenInput {
  readonly capability: TrustedSandboxSessionCapability;
  readonly identity: SandboxSessionIdentity;
  readonly sandbox: CubeSdkSandbox;
  readonly options: CubeWorkspaceAdapterOptions;
}

interface CapturedFile {
  readonly sha256: string;
  readonly fingerprint: string;
}

interface CapturedSnapshot {
  readonly identity: SandboxWorkspaceSnapshot;
  readonly operationKey: string;
  readonly scopeDigest: string;
  readonly entries: readonly SandboxWorkspaceEntry[];
  readonly files: ReadonlyMap<string, CapturedFile>;
}

interface LiveRead {
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
}

type AdapterConstructor = (input: AdapterOpenInput) => Promise<CubeSandboxWorkspacePort>;

// 测试入口需要绕过宿主平台判断，但不能因此公开可直接 new 的生产构造器。
let constructWorkspaceAdapter!: AdapterConstructor;

/**
 * CubeSandbox v0.6 的 `/workspace` 窄适配器。
 *
 * 生产入口固定检查 Linux；根目录、服务 URL 与宿主路径均不属于公开参数。所有调用在开始和
 * 结束时重验可信 session/generation，代际漂移时失败关闭。
 */
export class CubeSandboxWorkspacePort implements WorkspacePort {
  private readonly options: CubeWorkspaceAdapterOptions;
  private readonly snapshotsByOperation = new Map<string, CapturedSnapshot>();
  private readonly snapshotsByToken = new Map<string, CapturedSnapshot>();

  private constructor(
    private readonly capability: TrustedSandboxSessionCapability,
    private readonly bound: SandboxSessionIdentity,
    private readonly sandbox: CubeSdkSandbox,
    options: CubeWorkspaceAdapterOptions,
  ) {
    this.options = validateOptions(options);
  }

  static {
    constructWorkspaceAdapter = async (input) => {
      if (!validIdentity(input.identity)) throw known("INVALID_SANDBOX_IDENTITY");
      if (input.sandbox.sandboxId !== input.identity.sessionId) {
        throw known("SDK_SESSION_ID_MISMATCH");
      }
      const adapter = new CubeSandboxWorkspacePort(
        input.capability,
        Object.freeze({ ...input.identity }),
        input.sandbox,
        input.options,
      );
      await adapter.currentSession();
      await adapter.requireDirectory(SANDBOX_WORKSPACE_ROOT);
      return adapter;
    };
  }

  static async open(input: AdapterOpenInput): Promise<CubeSandboxWorkspacePort> {
    if (process.platform !== "linux") {
      throw new SandboxRuntimeError(
        "INVALID_ARGUMENT",
        "CubeSandbox Workspace 生产适配器只允许在 Linux Worker 启动",
      );
    }
    return openAdapter(input);
  }

  async currentSession(): Promise<SandboxSessionIdentity> {
    await this.assertBound("known");
    return Object.freeze({ ...this.bound });
  }

  async captureSnapshot(input: {
    readonly operationKey: string;
    readonly scope: WorkspaceTrustedScope;
  }): Promise<SandboxWorkspaceSnapshot> {
    await this.assertBound("known");
    const operationKey = safeOperationKey(input.operationKey);
    const scopeDigest = digestScope(input.scope);
    const existing = this.snapshotsByOperation.get(operationKey);
    if (existing !== undefined) {
      if (existing.scopeDigest !== scopeDigest) throw known("SNAPSHOT_OPERATION_CONFLICT");
      return existing.identity;
    }
    if (this.snapshotsByOperation.size >= this.options.maxSnapshots) {
      throw known("SNAPSHOT_CAPACITY_EXCEEDED");
    }

    const entries = await this.scanWorkspace();
    const files = new Map<string, CapturedFile>();
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      totalBytes = addBounded(totalBytes, entry.size ?? 0, this.options.maxTotalBytes);
      const read = await this.readLiveRegularFile(entry.relativePath, entry.size ?? 0);
      files.set(
        entry.relativePath,
        Object.freeze({
          sha256: sha256(read.bytes),
          fingerprint: read.fingerprint,
        }),
      );
    }
    await this.assertBound("known");

    const token = snapshotDigest(this.bound, operationKey, scopeDigest, entries, files);
    const identity = Object.freeze({ ...this.bound, snapshotToken: token });
    const captured: CapturedSnapshot = Object.freeze({
      identity,
      operationKey,
      scopeDigest,
      entries,
      files,
    });
    this.snapshotsByOperation.set(operationKey, captured);
    this.snapshotsByToken.set(token, captured);
    return identity;
  }

  async inspectRegularFile(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<
    | { readonly status: "missing" }
    | { readonly status: "regular"; readonly body: AsyncIterable<Uint8Array> }
    | {
        readonly status: "unsafe";
        readonly kind: "directory" | "symlink" | "special";
      }
  > {
    await this.assertCall(sandbox, "known");
    const path = safeTarget(relativePath);
    let entry: Record<string, unknown>;
    try {
      entry = await this.readCall("inspect", () => this.sandbox.files.stat(path), control.signal);
    } catch (error) {
      if (isNotFound(error)) return Object.freeze({ status: "missing" });
      throw error;
    }
    const kind = entryKind(entry);
    if (kind !== "file") {
      return Object.freeze({ status: "unsafe", kind });
    }
    const size = entrySize(entry);
    if (size > this.options.maxFileBytes) throw known("FILE_LIMIT_EXCEEDED");
    const self = this;
    return Object.freeze({
      status: "regular",
      body: (async function* () {
        const read = await self.readLiveRegularFile(relativePath, size, control.signal);
        yield* chunks(read.bytes, self.options.readChunkBytes);
      })(),
    });
  }

  async removeFile(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.assertCall(sandbox, "known");
    await this.mutatingCommand(
      REMOVE_FILE_SCRIPT,
      { CUBE_WS_PATH_B64: encodePath(safeTarget(relativePath)) },
      "remove_file",
      control.signal,
      // 解码失败和目标类型不符均发生在删除前；rm 自身失败则可能已产生副作用。
      new Set([0, 40, 42]),
    );
    await this.assertBound("unknown");
  }

  async removeDirectory(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.assertCall(sandbox, "known");
    await this.mutatingCommand(
      REMOVE_DIRECTORY_SCRIPT,
      { CUBE_WS_PATH_B64: encodePath(safeTarget(relativePath)) },
      "remove_directory",
      control.signal,
      new Set([0, 40, 41, 42, 43]),
    );
    await this.assertBound("unknown");
  }

  async removeUnexpectedDirectory(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.assertCall(sandbox, "known");
    await this.mutatingCommand(
      REMOVE_TREE_SCRIPT,
      { CUBE_WS_PATH_B64: encodePath(safeTarget(relativePath)) },
      "remove_tree",
      control.signal,
      // rm -rf 失败可能只删掉部分目录，因此故意不把 42 归为已知结果。
      new Set([0, 40, 41, 43]),
    );
    await this.assertBound("unknown");
  }

  async ensureDirectory(
    sandbox: SandboxSessionIdentity,
    relativePath: string,
    control: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.assertCall(sandbox, "known");
    const relative = safeRelative(relativePath);
    let current: string = SANDBOX_WORKSPACE_ROOT;
    await this.requireDirectory(current, control.signal);
    for (const segment of relative.split("/")) {
      current = posix.join(current, segment);
      try {
        const entry = await this.readCall(
          "stat_directory",
          () => this.sandbox.files.stat(current),
          control.signal,
        );
        if (entryKind(entry) !== "directory") throw known("DIRECTORY_TYPE_DRIFT");
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await this.mutateCall(
          "make_directory",
          () => this.sandbox.files.makeDir(current),
          control.signal,
        );
        await this.requireDirectory(current, control.signal);
      }
    }
    await this.assertBound("unknown");
  }

  async writeFileAtomically(input: {
    readonly sandbox: SandboxSessionIdentity;
    readonly relativePath: string;
    readonly operationKey: string;
    readonly body: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    await this.assertCall(input.sandbox, "known");
    const relative = safeRelative(input.relativePath);
    const target = safeTarget(relative);
    const parent = posix.dirname(target);
    await this.requireDirectory(parent, input.signal);
    const body = await collectBody(input.body, this.options, input.signal);
    const suffix = createHash("sha256")
      .update(`${safeOperationKey(input.operationKey)}\0${relative}`)
      .digest("hex")
      .slice(0, 16);
    const temporary = posix.join(parent, `.cube-runtime-${suffix}-${randomUUID()}.tmp`);

    await this.mutateCall(
      "write_temporary_file",
      () => this.sandbox.files.write(temporary, body),
      input.signal,
    );
    await this.mutatingCommand(
      FINALIZE_WRITE_SCRIPT,
      {
        CUBE_WS_TEMP_B64: encodePath(temporary),
        CUBE_WS_TARGET_B64: encodePath(target),
        CUBE_WS_EXPECTED_SIZE: String(body.byteLength),
      },
      "finalize_atomic_write",
      input.signal,
      new Set([0, 40, 41, 42, 43, 44]),
    );
    await this.assertBound("unknown");
  }

  async *listWorkspace(
    snapshot: SandboxWorkspaceSnapshot,
    control: { readonly signal?: AbortSignal } = {},
  ): AsyncIterable<SandboxWorkspaceEntry> {
    const captured = await this.requireSnapshot(snapshot, "known");
    abortPoint(control.signal);
    for (const entry of captured.entries) {
      abortPoint(control.signal);
      yield entry;
    }
    await this.assertBound("known");
  }

  async *readRegularFile(
    snapshot: SandboxWorkspaceSnapshot,
    relativePath: string,
    control: { readonly signal?: AbortSignal } = {},
  ): AsyncIterable<Uint8Array> {
    const captured = await this.requireSnapshot(snapshot, "known");
    const relative = safeRelative(relativePath);
    const entry = captured.entries.find(
      (candidate) => candidate.relativePath === relative && candidate.kind === "file",
    );
    const expected = captured.files.get(relative);
    if (entry === undefined || expected === undefined) throw known("SNAPSHOT_FILE_NOT_FOUND");
    const read = await this.readLiveRegularFile(relative, entry.size ?? 0, control.signal);
    if (read.fingerprint !== expected.fingerprint || sha256(read.bytes) !== expected.sha256) {
      throw known("SNAPSHOT_CHANGED");
    }
    for (const chunk of chunks(read.bytes, this.options.readChunkBytes)) {
      abortPoint(control.signal);
      yield chunk;
    }
    await this.assertBound("known");
  }

  private async scanWorkspace(): Promise<readonly SandboxWorkspaceEntry[]> {
    await this.requireDirectory(SANDBOX_WORKSPACE_ROOT);
    const result: SandboxWorkspaceEntry[] = [];
    const pending = [""];
    let totalBytes = 0;
    while (pending.length > 0) {
      const parent = pending.shift() as string;
      const absoluteParent = parent ? safeTarget(parent) : SANDBOX_WORKSPACE_ROOT;
      const rawEntries = await this.readCall("list_workspace", () =>
        this.sandbox.files.list(absoluteParent),
      );
      if (!Array.isArray(rawEntries)) throw known("FILESYSTEM_PROTOCOL");
      for (const raw of rawEntries) {
        if (result.length >= this.options.maxEntries) throw known("ENTRY_LIMIT_EXCEEDED");
        const name = entryName(raw);
        const relative = safeRelative(parent ? `${parent}/${name}` : name);
        if (Buffer.byteLength(relative, "utf8") > this.options.maxPathUtf8Bytes) {
          throw known("PATH_LIMIT_EXCEEDED");
        }
        const listedKind = entryKind(raw);
        const absolute = safeTarget(relative);
        let kind = listedKind;
        let size: number | undefined;
        if (listedKind === "file" || listedKind === "directory") {
          const stat = await this.readCall("stat_workspace", () =>
            this.sandbox.files.stat(absolute),
          );
          kind = entryKind(stat);
          if (kind !== listedKind) throw known("FILESYSTEM_TYPE_DRIFT");
          if (kind === "file") {
            size = entrySize(stat);
            const listedSize = optionalEntrySize(raw);
            if (listedSize !== undefined && listedSize !== size) {
              throw known("FILESYSTEM_SIZE_DRIFT");
            }
            if (size > this.options.maxFileBytes) throw known("FILE_LIMIT_EXCEEDED");
            totalBytes = addBounded(totalBytes, size, this.options.maxTotalBytes);
          }
        }
        result.push(
          Object.freeze({
            relativePath: relative,
            kind,
            ...(size === undefined ? {} : { size }),
          }),
        );
        if (kind === "directory") pending.push(relative);
      }
    }
    result.sort((left, right) =>
      Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)),
    );
    return Object.freeze(result);
  }

  private async readLiveRegularFile(
    relativePath: string,
    expectedSize: number,
    signal?: AbortSignal,
  ): Promise<LiveRead> {
    if (expectedSize > this.options.maxFileBytes) throw known("FILE_LIMIT_EXCEEDED");
    const output = await this.command(
      READ_FILE_SCRIPT,
      {
        CUBE_WS_PATH_B64: encodePath(safeTarget(relativePath)),
        CUBE_WS_MAX_BYTES: String(this.options.maxFileBytes),
      },
      "read_regular_file",
      signal,
      this.options.maxCommandOutputBytes,
    );
    if (output.exitCode !== 0) {
      if ([40, 41, 42].includes(output.exitCode)) throw known("UNSAFE_OR_CHANGED_FILE");
      throw known("FILESYSTEM_COMMAND_FAILED");
    }
    const parsed = parseReadOutput(output.stdout, this.options.maxFileBytes);
    if (output.stderr !== "" || parsed.bytes.byteLength !== expectedSize) {
      throw known("FILESYSTEM_PROTOCOL");
    }
    return parsed;
  }

  private async requireDirectory(path: string, signal?: AbortSignal): Promise<void> {
    const entry = await this.readCall(
      "stat_directory",
      () => this.sandbox.files.stat(path),
      signal,
    );
    if (entryKind(entry) !== "directory") throw known("DIRECTORY_TYPE_DRIFT");
  }

  private async requireSnapshot(
    input: SandboxWorkspaceSnapshot,
    drift: "known" | "unknown",
  ): Promise<CapturedSnapshot> {
    await this.assertCall(input, drift);
    const captured = this.snapshotsByToken.get(input.snapshotToken);
    if (
      captured === undefined ||
      captured.identity.sessionId !== input.sessionId ||
      captured.identity.generation !== input.generation
    ) {
      throw known("SNAPSHOT_NOT_FOUND");
    }
    return captured;
  }

  private async assertCall(
    identity: SandboxSessionIdentity,
    drift: "known" | "unknown",
  ): Promise<void> {
    if (!sameSession(identity, this.bound)) throw known("SANDBOX_IDENTITY_MISMATCH");
    await this.assertBound(drift);
  }

  private async assertBound(result: "known" | "unknown"): Promise<void> {
    let current: SandboxSessionIdentity;
    try {
      current = await this.capability.current();
    } catch {
      throw new WorkspaceDependencyError(result, "SESSION_CAPABILITY_UNAVAILABLE");
    }
    if (!validIdentity(current) || !sameSession(current, this.bound)) {
      throw new WorkspaceDependencyError(result, "SANDBOX_GENERATION_CHANGED");
    }
  }

  private async readCall<T>(
    operation: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await settledOperation(operation, action, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.options.operationTimeoutMs,
      });
    } catch (error) {
      if (error instanceof WorkspaceDependencyError) throw error;
      throw classify(error, false, operation);
    }
  }

  private async mutateCall<T>(
    operation: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await settledOperation(operation, action, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: this.options.operationTimeoutMs,
      });
    } catch (error) {
      if (error instanceof WorkspaceDependencyError) throw error;
      throw classify(error, true, operation);
    }
  }

  private async command(
    script: string,
    envs: Record<string, string>,
    operation: string,
    signal: AbortSignal | undefined,
    outputLimit: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const raw = await this.readCall(
      operation,
      () =>
        this.sandbox.commands.run(script, {
          timeoutMs: this.options.operationTimeoutMs,
          envs,
        }),
      signal,
    );
    if (!plainRecord(raw)) throw known("COMMAND_PROTOCOL");
    const { stdout, stderr, exitCode } = raw;
    if (
      typeof stdout !== "string" ||
      typeof stderr !== "string" ||
      !Number.isInteger(exitCode) ||
      Buffer.byteLength(stdout) > outputLimit ||
      Buffer.byteLength(stderr) > 256
    ) {
      throw known("COMMAND_PROTOCOL");
    }
    return { stdout, stderr, exitCode: exitCode as number };
  }

  private async mutatingCommand(
    script: string,
    envs: Record<string, string>,
    operation: string,
    signal: AbortSignal | undefined,
    knownExitCodes: ReadonlySet<number>,
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = await settledOperation(
        operation,
        () =>
          this.sandbox.commands.run(script, {
            timeoutMs: this.options.operationTimeoutMs,
            envs,
          }),
        {
          ...(signal === undefined ? {} : { signal }),
          timeoutMs: this.options.operationTimeoutMs,
        },
      );
    } catch (error) {
      throw classify(error, true, operation);
    }
    if (!plainRecord(raw)) throw unknown("COMMAND_PROTOCOL_UNKNOWN");
    const { stdout, stderr, exitCode } = raw;
    if (
      typeof stdout !== "string" ||
      typeof stderr !== "string" ||
      !Number.isInteger(exitCode) ||
      Buffer.byteLength(stdout) > 64 ||
      Buffer.byteLength(stderr) > 256
    ) {
      throw unknown("COMMAND_PROTOCOL_UNKNOWN");
    }
    if (!knownExitCodes.has(exitCode as number)) throw unknown("MUTATION_RESULT_UNKNOWN");
    if (exitCode !== 0) {
      throw known(`MUTATION_REJECTED_${String(exitCode)}`);
    }
    // 成功退出却缺少完整确认帧时，不能推断远端是否已经完成变更。
    if (stdout !== "OK\n" || stderr !== "") throw unknown("MUTATION_ACK_UNKNOWN");
  }
}

/** 仅由同包 testing 子路径调用；生产主入口不导出此平台旁路。 */
export async function openCubeWorkspaceAdapterForTesting(
  input: AdapterOpenInput,
): Promise<CubeSandboxWorkspacePort> {
  return openAdapter(input);
}

async function openAdapter(input: AdapterOpenInput): Promise<CubeSandboxWorkspacePort> {
  return constructWorkspaceAdapter(input);
}

function validateOptions(options: CubeWorkspaceAdapterOptions): CubeWorkspaceAdapterOptions {
  const values = Object.values(options);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "Workspace 适配器配额必须是正安全整数");
  }
  const minimumOutput = Math.ceil((options.maxFileBytes * 4) / 3) + 256;
  if (options.maxCommandOutputBytes < minimumOutput) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "命令输出上限不足以承载文件配额");
  }
  if (options.readChunkBytes > options.maxFileBytes) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "读取 chunk 上限不能超过单文件上限");
  }
  return Object.freeze({ ...options });
}

function safeRelative(value: string): string {
  try {
    return workspaceRelativePath(value);
  } catch {
    throw known("UNSAFE_WORKSPACE_PATH");
  }
}

function safeTarget(value: string): string {
  try {
    return resolveWorkspaceTargetPath(SANDBOX_WORKSPACE_ROOT, safeRelative(value));
  } catch {
    throw known("UNSAFE_WORKSPACE_PATH");
  }
}

function safeOperationKey(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || value.includes("\0")) {
    throw known("INVALID_OPERATION_KEY");
  }
  return value;
}

function digestScope(scope: WorkspaceTrustedScope): string {
  if (
    !plainRecord(scope) ||
    ![scope.tenantId, scope.threadId, scope.workspaceId].every(
      (value) => typeof value === "string" && value.length > 0 && !value.includes("\0"),
    )
  ) {
    throw known("INVALID_WORKSPACE_SCOPE");
  }
  return createHash("sha256")
    .update(`${scope.tenantId}\0${scope.threadId}\0${scope.workspaceId}`)
    .digest("hex");
}

function validIdentity(value: SandboxSessionIdentity): boolean {
  return (
    plainRecord(value) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    !value.sessionId.includes("\0") &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0
  );
}

function sameSession(left: SandboxSessionIdentity, right: SandboxSessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.getOwnPropertySymbols(value).length === 0;
}

function entryName(value: unknown): string {
  if (!plainRecord(value)) throw known("FILESYSTEM_PROTOCOL");
  const descriptor = Object.getOwnPropertyDescriptor(value, "name");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string"
  ) {
    throw known("FILESYSTEM_PROTOCOL");
  }
  if (descriptor.value.includes("/") || descriptor.value.length === 0) {
    throw known("UNSAFE_WORKSPACE_PATH");
  }
  return descriptor.value;
}

function entryKind(value: unknown): SandboxWorkspaceEntry["kind"] {
  if (!plainRecord(value)) throw known("FILESYSTEM_PROTOCOL");
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (
    descriptor === undefined ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string"
  ) {
    throw known("FILESYSTEM_PROTOCOL");
  }
  if (descriptor.value === FILE_TYPE_FILE) return "file";
  if (descriptor.value === FILE_TYPE_DIRECTORY) return "directory";
  if (descriptor.value === FILE_TYPE_SYMLINK) return "symlink";
  return "special";
}

function optionalEntrySize(value: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(value, "size")) return undefined;
  return parseSize(value.size);
}

function entrySize(value: Record<string, unknown>): number {
  if (!Object.hasOwn(value, "size")) throw known("FILESYSTEM_PROTOCOL");
  return parseSize(value.size);
}

function parseSize(value: unknown): number {
  const parsed = typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw known("FILESYSTEM_PROTOCOL");
  }
  return parsed as number;
}

function encodePath(path: string): string {
  return Buffer.from(path, "utf8").toString("base64");
}

function parseReadOutput(stdout: string, maxBytes: number): LiveRead {
  if (!stdout.endsWith("\n")) {
    throw known("COMMAND_PROTOCOL");
  }
  const lines = stdout.slice(0, -1).split("\n");
  if (lines.length !== 3) throw known("COMMAND_PROTOCOL");
  const [first, encoded, last] = lines as [string, string, string];
  const prefix = `${READ_PROTOCOL}:`;
  if (!first.startsWith(prefix) || first !== last) throw known("FILE_CHANGED_DURING_READ");
  const fingerprint = first.slice(prefix.length);
  if (!/^[0-9]+:[0-9]+:[0-9]+:-?[0-9]+:-?[0-9]+:[0-9a-f]+$/u.test(fingerprint)) {
    throw known("COMMAND_PROTOCOL");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw known("COMMAND_PROTOCOL");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > maxBytes) throw known("FILE_LIMIT_EXCEEDED");
  const declared = Number(fingerprint.split(":", 1)[0]);
  if (declared !== bytes.byteLength) throw known("FILESYSTEM_PROTOCOL");
  return Object.freeze({ bytes, fingerprint });
}

async function collectBody(
  source: AsyncIterable<Uint8Array>,
  options: CubeWorkspaceAdapterOptions,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (source === null || typeof source !== "object" || !(Symbol.asyncIterator in source)) {
    throw known("INVALID_BODY_STREAM");
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const raw of source) {
    abortPoint(signal);
    if (!(raw instanceof Uint8Array) || raw.byteLength > options.readChunkBytes) {
      throw known("INVALID_BODY_CHUNK");
    }
    size = addBounded(size, raw.byteLength, options.maxFileBytes);
    parts.push(Uint8Array.from(raw));
  }
  return Buffer.concat(parts, size);
}

function* chunks(bytes: Uint8Array, size: number): Iterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.slice(offset, Math.min(offset + size, bytes.byteLength));
  }
}

function snapshotDigest(
  session: SandboxSessionIdentity,
  operationKey: string,
  scopeDigest: string,
  entries: readonly SandboxWorkspaceEntry[],
  files: ReadonlyMap<string, CapturedFile>,
): string {
  const hash = createHash("sha256");
  hash.update("cube-workspace-snapshot-v1\0");
  hash.update(`${session.sessionId}\0${session.generation}\0${operationKey}\0${scopeDigest}\0`);
  for (const entry of entries) {
    const file = files.get(entry.relativePath);
    hash.update(
      `${entry.relativePath}\0${entry.kind}\0${entry.size ?? ""}\0${file?.sha256 ?? ""}\0${file?.fingerprint ?? ""}\0`,
    );
  }
  // 随机盐防止 token 反向泄露文件清单摘要，也把本次扫描实例与未来同内容扫描区分开。
  hash.update(randomUUID());
  return hash.digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function addBounded(current: number, next: number, maximum: number): number {
  if (next < 0 || current > maximum - next) throw known("TOTAL_LIMIT_EXCEEDED");
  return current + next;
}

function abortPoint(signal?: AbortSignal): void {
  if (signal?.aborted) throw known("CANCELLED");
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof WorkspaceDependencyError &&
    error.result === "known" &&
    error.dependencyCode === "NOT_FOUND"
  );
}

function classify(error: unknown, mutation: boolean, operation: string): WorkspaceDependencyError {
  const mapped = mapSandboxError(error, operation);
  if (mapped.code === "NOT_FOUND") return known("NOT_FOUND");
  if (mapped.code === "AUTHENTICATION" || mapped.code === "INVALID_ARGUMENT") {
    return known(mapped.code);
  }
  return new WorkspaceDependencyError(mutation ? "unknown" : "known", `CUBE_${mapped.code}`);
}

function known(code: string): WorkspaceDependencyError {
  return new WorkspaceDependencyError("known", code);
}

function unknown(code: string): WorkspaceDependencyError {
  return new WorkspaceDependencyError("unknown", code);
}

const READ_FILE_SCRIPT = String.raw`set -u
p="$(printf '%s' "$CUBE_WS_PATH_B64" | base64 -d)" || exit 40
max="$CUBE_WS_MAX_BYTES"
[ ! -L "$p" ] || exit 41
[ -f "$p" ] || exit 40
before="$(stat -Lc '%s:%d:%i:%Y:%Z:%f' -- "$p")" || exit 40
size="\${before%%:*}"
[ "$size" -le "$max" ] || exit 42
printf 'CUBEWS1:%s\n' "$before"
head -c "$((max + 1))" -- "$p" | base64 -w0 || exit 43
printf '\n'
[ ! -L "$p" ] || exit 41
after="$(stat -Lc '%s:%d:%i:%Y:%Z:%f' -- "$p")" || exit 40
printf 'CUBEWS1:%s\n' "$after"`;

const FINALIZE_WRITE_SCRIPT = String.raw`set -u
tmp="$(printf '%s' "$CUBE_WS_TEMP_B64" | base64 -d)" || exit 40
target="$(printf '%s' "$CUBE_WS_TARGET_B64" | base64 -d)" || exit 40
expected="$CUBE_WS_EXPECTED_SIZE"
[ ! -L "$tmp" ] && [ -f "$tmp" ] || exit 41
[ "$(stat -Lc '%s' -- "$tmp")" = "$expected" ] || exit 42
parent="\${target%/*}"
[ ! -L "$parent" ] && [ -d "$parent" ] || exit 43
[ ! -d "$target" ] || exit 44
chmod 600 -- "$tmp" || exit 45
sync -f -- "$tmp" || exit 45
mv -T -- "$tmp" "$target" || exit 45
sync -f -- "$parent" || exit 45
printf 'OK\n'`;

const REMOVE_FILE_SCRIPT = String.raw`set -u
p="$(printf '%s' "$CUBE_WS_PATH_B64" | base64 -d)" || exit 40
if [ -L "$p" ] || [ -f "$p" ]; then rm -f -- "$p" || exit 41
elif [ -e "$p" ]; then exit 42
fi
printf 'OK\n'`;

const REMOVE_DIRECTORY_SCRIPT = String.raw`set -u
p="$(printf '%s' "$CUBE_WS_PATH_B64" | base64 -d)" || exit 40
if [ -L "$p" ]; then exit 41
elif [ -d "$p" ]; then rmdir -- "$p" || exit 42
elif [ -e "$p" ]; then exit 43
fi
printf 'OK\n'`;

const REMOVE_TREE_SCRIPT = String.raw`set -u
p="$(printf '%s' "$CUBE_WS_PATH_B64" | base64 -d)" || exit 40
if [ -L "$p" ]; then exit 41
elif [ -d "$p" ]; then rm -rf --one-file-system -- "$p" || exit 42
elif [ -e "$p" ]; then exit 43
fi
printf 'OK\n'`;
