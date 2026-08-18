import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type {
  SandboxSessionIdentity,
  SandboxWorkspaceEntry,
  SandboxWorkspaceSnapshot,
  SandboxWorkspacePort as WorkspacePort,
  WorkspaceTrustedScope,
} from "@hoox/workspace";
import {
  SANDBOX_WORKSPACE_ROOT,
  WorkspaceDependencyError,
  workspaceRelativePath,
} from "@hoox/workspace";
import { mapSandboxError, SandboxRuntimeError, settledOperation } from "./errors.js";

const FILE_TYPE_FILE = "FILE_TYPE_FILE";
const FILE_TYPE_DIRECTORY = "FILE_TYPE_DIRECTORY";
const FILE_TYPE_SYMLINK = "FILE_TYPE_SYMLINK";
const READ_PROTOCOL = "CUBEWS1";

export interface SandboxWorkspaceSdk {
  readonly sandboxId: string;
  readonly commands: {
    run(
      command: string,
      options?: { timeoutMs?: number; envs?: Record<string, string> },
    ): Promise<unknown>;
  };
  readonly files: {
    read(path: string): Promise<string>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    list(path: string): Promise<Record<string, unknown>[]>;
    stat(path: string): Promise<Record<string, unknown>>;
    remove(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<Record<string, unknown>>;
    makeDir(path: string): Promise<Record<string, unknown>>;
  };
}

export type SandboxWorkspaceErrorMapper = (
  error: unknown,
  operation: string,
) => SandboxRuntimeError;

export interface TrustedSandboxWorkspaceBinding extends SandboxSessionIdentity {
  readonly scope: WorkspaceTrustedScope;
}

/** 由 Session registry / warm manager 提供；适配器不会接受裸 sessionId 或调用方 scope。 */
export interface TrustedSandboxSessionCapability {
  current(control?: { readonly signal?: AbortSignal }): Promise<TrustedSandboxWorkspaceBinding>;
}

export interface SandboxWorkspaceAdapterOptions {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathUtf8Bytes: number;
  readonly maxCommandOutputBytes: number;
  readonly readChunkBytes: number;
  readonly maxSnapshots: number;
  readonly operationTimeoutMs: number;
}

export type CubeWorkspaceAdapterOptions = SandboxWorkspaceAdapterOptions;

interface AdapterOpenInput {
  readonly capability: TrustedSandboxSessionCapability;
  readonly binding: TrustedSandboxWorkspaceBinding;
  readonly sandbox: SandboxWorkspaceSdk;
  readonly options: SandboxWorkspaceAdapterOptions;
  readonly errorMapper?: SandboxWorkspaceErrorMapper;
  readonly dependencyPrefix?: string;
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

interface SnapshotOperation {
  readonly scopeDigest: string;
  readonly promise: Promise<CapturedSnapshot>;
  releasePromise?: Promise<void>;
}

interface LiveRead {
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
}

type AdapterConstructor = (input: AdapterOpenInput) => Promise<SandboxWorkspacePort>;

// 测试入口需要绕过宿主平台判断，但不能因此公开可直接 new 的生产构造器。
let constructWorkspaceAdapter!: AdapterConstructor;

/**
 * Sandbox Provider 共用的 `/workspace` 窄适配器。
 *
 * 根目录、服务 URL 与宿主路径均不属于公开参数。所有文件和命令都经 Provider SDK 在远端 Sandbox
 * 执行，Worker 宿主平台不会参与路径解析；所有调用在开始和结束时重验可信 session/generation。
 */
export class SandboxWorkspacePort implements WorkspacePort {
  private readonly options: SandboxWorkspaceAdapterOptions;
  private readonly snapshotsByOperation = new Map<string, SnapshotOperation>();
  private readonly snapshotsByToken = new Map<string, CapturedSnapshot>();

  private constructor(
    private readonly capability: TrustedSandboxSessionCapability,
    private readonly bound: TrustedSandboxWorkspaceBinding,
    private readonly sandbox: SandboxWorkspaceSdk,
    options: SandboxWorkspaceAdapterOptions,
    private readonly errorMapper: SandboxWorkspaceErrorMapper,
    private readonly dependencyPrefix: string,
  ) {
    this.options = validateOptions(options);
  }

  static {
    constructWorkspaceAdapter = async (input) => {
      if (!validBinding(input.binding)) throw known("INVALID_SANDBOX_BINDING");
      if (input.sandbox.sandboxId !== input.binding.sessionId) {
        throw known("SDK_SESSION_ID_MISMATCH");
      }
      const adapter = new SandboxWorkspacePort(
        input.capability,
        freezeBinding(input.binding),
        input.sandbox,
        input.options,
        input.errorMapper ?? mapSandboxError,
        validateDependencyPrefix(input.dependencyPrefix ?? "CUBE"),
      );
      await adapter.currentSession();
      await adapter.probeSecureFilesystem();
      await adapter.requireDirectory(SANDBOX_WORKSPACE_ROOT);
      return adapter;
    };
  }

  static async open(input: AdapterOpenInput): Promise<SandboxWorkspacePort> {
    return constructWorkspaceAdapter(input);
  }

  async currentSession(): Promise<SandboxSessionIdentity> {
    await this.assertBound("known");
    return Object.freeze({ sessionId: this.bound.sessionId, generation: this.bound.generation });
  }

  async captureSnapshot(input: {
    readonly operationKey: string;
    readonly scope: WorkspaceTrustedScope;
  }): Promise<SandboxWorkspaceSnapshot> {
    await this.assertBound("known");
    const operationKey = safeOperationKey(input.operationKey);
    const scopeDigest = digestScope(input.scope);
    if (scopeDigest !== digestScope(this.bound.scope)) throw known("WORKSPACE_SCOPE_MISMATCH");
    const existing = this.snapshotsByOperation.get(operationKey);
    if (existing !== undefined) {
      if (existing.releasePromise !== undefined) throw known("SNAPSHOT_RELEASING");
      if (existing.scopeDigest !== scopeDigest) throw known("SNAPSHOT_OPERATION_CONFLICT");
      return (await existing.promise).identity;
    }
    if (this.snapshotsByOperation.size >= this.options.maxSnapshots) {
      throw known("SNAPSHOT_CAPACITY_EXCEEDED");
    }

    const promise = this.captureSnapshotOnce(operationKey, scopeDigest);
    this.snapshotsByOperation.set(operationKey, { scopeDigest, promise });
    try {
      return (await promise).identity;
    } catch (error) {
      if (this.snapshotsByOperation.get(operationKey)?.promise === promise) {
        this.snapshotsByOperation.delete(operationKey);
      }
      throw error;
    }
  }

  /** 调用方在 operation 完成或终止后释放进程内快照，避免 warm Session 长期占用内存。 */
  async releaseSnapshot(snapshot: SandboxWorkspaceSnapshot): Promise<void> {
    if (!sameSession(snapshot, this.bound)) throw known("SANDBOX_IDENTITY_MISMATCH");
    const captured = this.snapshotsByToken.get(snapshot.snapshotToken);
    if (captured === undefined) return;
    await this.releaseSnapshots({ sandbox: snapshot, operationKey: captured.operationKey });
  }

  async releaseSnapshots(input: {
    readonly sandbox: SandboxSessionIdentity;
    readonly operationKey: string;
  }): Promise<void> {
    if (!sameSession(input.sandbox, this.bound)) throw known("SANDBOX_IDENTITY_MISMATCH");
    const operationKey = safeOperationKey(input.operationKey);
    const operation = this.snapshotsByOperation.get(operationKey);
    if (operation === undefined) return;
    if (operation.releasePromise === undefined) {
      operation.releasePromise = (async () => {
        try {
          const captured = await operation.promise;
          this.snapshotsByToken.delete(captured.identity.snapshotToken);
        } finally {
          if (this.snapshotsByOperation.get(operationKey) === operation) {
            this.snapshotsByOperation.delete(operationKey);
          }
        }
      })();
    }
    await operation.releasePromise;
  }

  private async captureSnapshotOnce(
    operationKey: string,
    scopeDigest: string,
  ): Promise<CapturedSnapshot> {
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
    const identity = Object.freeze({
      sessionId: this.bound.sessionId,
      generation: this.bound.generation,
      snapshotToken: token,
    });
    const captured: CapturedSnapshot = Object.freeze({
      identity,
      operationKey,
      scopeDigest,
      entries,
      files,
    });
    this.snapshotsByToken.set(token, captured);
    return captured;
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
    const relative = this.safeRelative(relativePath);
    let entry: Record<string, unknown>;
    try {
      entry = await this.secureStat(relative, control.signal);
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
        await self.assertCall(sandbox, "known", control.signal);
        const read = await self.readLiveRegularFile(relativePath, size, control.signal);
        yield* chunks(read.bytes, self.options.readChunkBytes);
        await self.assertCall(sandbox, "known", control.signal);
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
      SECURE_FS_SCRIPT,
      { CUBE_WS_OP: "remove_file", CUBE_WS_REL_B64: encodePath(this.safeRelative(relativePath)) },
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
      SECURE_FS_SCRIPT,
      {
        CUBE_WS_OP: "remove_directory",
        CUBE_WS_REL_B64: encodePath(this.safeRelative(relativePath)),
      },
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
      SECURE_FS_SCRIPT,
      { CUBE_WS_OP: "remove_tree", CUBE_WS_REL_B64: encodePath(this.safeRelative(relativePath)) },
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
    const relative = this.safeRelative(relativePath);
    await this.mutatingCommand(
      SECURE_FS_SCRIPT,
      { CUBE_WS_OP: "ensure_directory", CUBE_WS_REL_B64: encodePath(relative) },
      "ensure_directory",
      control.signal,
      new Set([0, 40, 41, 42]),
    );
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
    const relative = this.safeRelative(input.relativePath);
    const body = await collectBody(input.body, this.options, input.signal);
    const suffix = createHash("sha256")
      .update(`${safeOperationKey(input.operationKey)}\0${relative}`)
      .digest("hex")
      .slice(0, 16);
    const temporary = `/tmp/hoox-${suffix}-${randomUUID()}.tmp`;

    await this.mutateCall(
      "write_temporary_file",
      () => this.sandbox.files.write(temporary, body),
      input.signal,
    );
    await this.mutatingCommand(
      SECURE_FS_SCRIPT,
      {
        CUBE_WS_OP: "finalize_write",
        CUBE_WS_TEMP_B64: encodePath(temporary),
        CUBE_WS_REL_B64: encodePath(relative),
        CUBE_WS_EXPECTED_SIZE: String(body.byteLength),
        CUBE_WS_EXPECTED_SHA256: sha256(body),
      },
      "finalize_atomic_write",
      input.signal,
      new Set([0, 40, 41, 42, 43, 44]),
    ).catch(async (error: unknown) => {
      if (error instanceof WorkspaceDependencyError && error.result === "known") {
        await this.cleanupExternalTemporary(temporary, input.signal);
      }
      throw error;
    });
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
    const relative = this.safeRelative(relativePath);
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
    await this.assertBound("known", control.signal);
  }

  private async scanWorkspace(): Promise<readonly SandboxWorkspaceEntry[]> {
    const raw = await this.command(
      SECURE_FS_SCRIPT,
      {
        CUBE_WS_OP: "scan",
        CUBE_WS_MAX_ENTRIES: String(this.options.maxEntries),
        CUBE_WS_MAX_FILE_BYTES: String(this.options.maxFileBytes),
        CUBE_WS_MAX_TOTAL_BYTES: String(this.options.maxTotalBytes),
        CUBE_WS_MAX_PATH_BYTES: String(this.options.maxPathUtf8Bytes),
        CUBE_WS_MAX_OUTPUT_BYTES: String(this.options.maxCommandOutputBytes),
        CUBE_WS_EXCLUDED_DIRECTORY_NAMES: "node_modules",
      },
      "scan_workspace",
      undefined,
      this.options.maxCommandOutputBytes,
    );
    if (raw.exitCode !== 0 || raw.stderr !== "") throw known("FILESYSTEM_SCAN_FAILED");
    const parsed: unknown = JSON.parse(raw.stdout);
    if (!Array.isArray(parsed)) throw known("FILESYSTEM_PROTOCOL");
    const result: SandboxWorkspaceEntry[] = [];
    let totalBytes = 0;
    for (const rawEntry of parsed) {
      if (result.length >= this.options.maxEntries || !plainRecord(rawEntry)) {
        throw known("ENTRY_LIMIT_EXCEEDED");
      }
      const relative = this.safeRelative(decodePathField(rawEntry.relativePathB64));
      const kind = entryKind(rawEntry);
      const size = kind === "file" ? entrySize(rawEntry) : undefined;
      if (size !== undefined) {
        if (size > this.options.maxFileBytes) throw known("FILE_LIMIT_EXCEEDED");
        totalBytes = addBounded(totalBytes, size, this.options.maxTotalBytes);
      }
      result.push(
        Object.freeze({ relativePath: relative, kind, ...(size === undefined ? {} : { size }) }),
      );
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
      SECURE_FS_SCRIPT,
      {
        CUBE_WS_OP: "read",
        CUBE_WS_REL_B64: encodePath(this.safeRelative(relativePath)),
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

  private async requireDirectory(_path: string, signal?: AbortSignal): Promise<void> {
    const entry = await this.secureStat("", signal);
    if (entryKind(entry) !== "directory") throw known("DIRECTORY_TYPE_DRIFT");
  }

  private async secureStat(
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const output = await this.command(
      SECURE_FS_SCRIPT,
      { CUBE_WS_OP: "stat", CUBE_WS_REL_B64: encodePath(relativePath) },
      "stat_workspace",
      signal,
      512,
    );
    if (output.exitCode === 40) throw known("NOT_FOUND");
    if (output.exitCode !== 0 || output.stderr !== "") throw known("FILESYSTEM_STAT_FAILED");
    const parsed: unknown = JSON.parse(output.stdout);
    if (!plainRecord(parsed)) throw known("FILESYSTEM_PROTOCOL");
    return parsed;
  }

  private async probeSecureFilesystem(): Promise<void> {
    const output = await this.command(
      SECURE_FS_SCRIPT,
      { CUBE_WS_OP: "probe" },
      "probe_openat2",
      undefined,
      64,
    );
    if (output.exitCode !== 0 || output.stdout !== "OK\n" || output.stderr !== "") {
      throw known("OPENAT2_UNAVAILABLE");
    }
  }

  private async cleanupExternalTemporary(path: string, signal?: AbortSignal): Promise<void> {
    await this.mutatingCommand(
      SECURE_FS_SCRIPT,
      { CUBE_WS_OP: "cleanup_temporary", CUBE_WS_TEMP_B64: encodePath(path) },
      "cleanup_temporary",
      signal,
      new Set([0, 40, 41]),
    );
  }

  private safeRelative(value: string): string {
    const relative = safeRelative(value);
    if (Buffer.byteLength(relative, "utf8") > this.options.maxPathUtf8Bytes) {
      throw known("PATH_LIMIT_EXCEEDED");
    }
    return relative;
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
    signal?: AbortSignal,
  ): Promise<void> {
    if (!sameSession(identity, this.bound)) throw known("SANDBOX_IDENTITY_MISMATCH");
    await this.assertBound(drift, signal);
  }

  private async assertBound(result: "known" | "unknown", signal?: AbortSignal): Promise<void> {
    let current: TrustedSandboxWorkspaceBinding;
    try {
      current = await resolveTrustedSandboxWorkspaceBinding(
        this.capability,
        this.options.operationTimeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof WorkspaceDependencyError) {
        throw new WorkspaceDependencyError(result, error.dependencyCode);
      }
      throw new WorkspaceDependencyError(result, "SESSION_CAPABILITY_UNAVAILABLE");
    }
    if (!validBinding(current) || !sameSession(current, this.bound)) {
      throw new WorkspaceDependencyError(result, "SANDBOX_GENERATION_CHANGED");
    }
    if (digestScope(current.scope) !== digestScope(this.bound.scope)) {
      throw new WorkspaceDependencyError(result, "WORKSPACE_SCOPE_CHANGED");
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
      throw classify(error, false, operation, this.errorMapper, this.dependencyPrefix);
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
      throw classify(error, true, operation, this.errorMapper, this.dependencyPrefix);
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
      throw classify(error, true, operation, this.errorMapper, this.dependencyPrefix);
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

function validateOptions(options: SandboxWorkspaceAdapterOptions): SandboxWorkspaceAdapterOptions {
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

function validBinding(value: TrustedSandboxWorkspaceBinding): boolean {
  if (!validIdentity(value) || !plainRecord(value.scope)) return false;
  try {
    digestScope(value.scope);
    return true;
  } catch {
    return false;
  }
}

function freezeBinding(value: TrustedSandboxWorkspaceBinding): TrustedSandboxWorkspaceBinding {
  return Object.freeze({
    sessionId: value.sessionId,
    generation: value.generation,
    scope: Object.freeze({ ...value.scope }),
  });
}

function sameSession(left: SandboxSessionIdentity, right: SandboxSessionIdentity): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

/** 同包 Gateway 复用的只读 capability 硬期限；不从 package 主入口导出。 */
export async function resolveTrustedSandboxWorkspaceBinding(
  capability: TrustedSandboxSessionCapability,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TrustedSandboxWorkspaceBinding> {
  abortPoint(signal);
  const controller = new AbortController();
  let rejectAbort!: (error: WorkspaceDependencyError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    controller.abort(signal?.reason);
    rejectAbort(known("CANCELLED"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("capability timeout"));
      reject(known("SESSION_CAPABILITY_TIMEOUT"));
    }, timeoutMs);
  });
  const current = capability.current({ signal: controller.signal }).catch((error: unknown) => {
    throw error;
  });
  try {
    const resolved = await Promise.race([current, timeout, aborted]);
    if (!validBinding(resolved)) throw known("INVALID_SANDBOX_BINDING");
    return freezeBinding(resolved);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.getOwnPropertySymbols(value).length === 0;
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

function decodePathField(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw known("FILESYSTEM_PROTOCOL");
  }
  const bytes = Buffer.from(value, "base64");
  const decoded = bytes.toString("utf8");
  if (Buffer.from(decoded, "utf8").compare(bytes) !== 0) throw known("FILESYSTEM_PROTOCOL");
  return decoded;
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
  options: SandboxWorkspaceAdapterOptions,
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
  // 已持久化快照以该 CubeSandbox 适配域分隔；改名会让相同快照产生不同摘要。
  hash.update("cube-workspace-snapshot-v1\0");
  hash.update(`${session.sessionId}\0${session.generation}\0${operationKey}\0${scopeDigest}\0`);
  for (const entry of entries) {
    const file = files.get(entry.relativePath);
    hash.update(
      `${entry.relativePath}\0${entry.kind}\0${entry.size ?? ""}\0${file?.sha256 ?? ""}\0${file?.fingerprint ?? ""}\0`,
    );
  }
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

function classify(
  error: unknown,
  mutation: boolean,
  operation: string,
  errorMapper: SandboxWorkspaceErrorMapper,
  dependencyPrefix: string,
): WorkspaceDependencyError {
  const mapped = errorMapper(error, operation);
  if (mapped.code === "NOT_FOUND") return known("NOT_FOUND");
  if (mapped.code === "AUTHENTICATION" || mapped.code === "INVALID_ARGUMENT") {
    return known(mapped.code);
  }
  return new WorkspaceDependencyError(
    mutation ? "unknown" : "known",
    `${dependencyPrefix}_${mapped.code}`,
  );
}

function validateDependencyPrefix(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,31}$/u.test(value)) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "Workspace Provider 错误前缀无效");
  }
  return value;
}

function known(code: string): WorkspaceDependencyError {
  return new WorkspaceDependencyError("known", code);
}

function unknown(code: string): WorkspaceDependencyError {
  return new WorkspaceDependencyError("unknown", code);
}

/**
 * 固定的 Linux dirfd helper。每一级祖先都以 O_NOFOLLOW 相对已打开的父 dirfd 打开；后续
 * stat/read/unlink/mkdir/rename 也只使用 dirfd 相对原语，因此目录在检查后被替换成 symlink
 * 不能把操作重定向到 `/workspace` 外。模板必须提供 Python 3；缺失时适配器启动即失败关闭。
 */
const SECURE_FS_SCRIPT = String.raw`set -u
python3 - <<'PY'
import base64, ctypes, hashlib, json, os, secrets, stat, sys

ROOT = "/workspace"
OP = os.environ.get("CUBE_WS_OP", "")
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
RESOLVE_NO_XDEV = 0x01
RESOLVE_NO_MAGICLINKS = 0x02
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08
SYS_OPENAT2 = 437

class OpenHow(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint64), ("mode", ctypes.c_uint64), ("resolve", ctypes.c_uint64)]

LIBC = ctypes.CDLL(None, use_errno=True)

def open_beneath(root_fd, relative, flags, mode=0):
    if relative == "": return os.dup(root_fd)
    how = OpenHow(flags, mode, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
    path = ctypes.c_char_p(os.fsencode(relative))
    result = LIBC.syscall(SYS_OPENAT2, root_fd, path, ctypes.byref(how), ctypes.sizeof(how))
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), relative)
    return result

def fail(code):
    raise SystemExit(code)

def decode_env(name, allow_empty=False):
    try:
        raw = base64.b64decode(os.environ.get(name, ""), validate=True)
        value = raw.decode("utf-8", "strict")
    except Exception:
        fail(40)
    if not allow_empty and not value:
        fail(40)
    return value

def segments(value):
    if value == "":
        return []
    parts = value.split("/")
    if any(not part or part in (".", "..") or "/" in part or "\x00" in part for part in parts):
        fail(40)
    return parts

def open_root():
    try:
        return os.open(ROOT, DIR_FLAGS)
    except OSError:
        fail(41)

def open_parent(root_fd, parts):
    try:
        return open_beneath(root_fd, "/".join(parts[:-1]), DIR_FLAGS), (parts[-1] if parts else "")
    except OSError: fail(41)

def classify(mode):
    if stat.S_ISREG(mode): return "FILE_TYPE_FILE"
    if stat.S_ISDIR(mode): return "FILE_TYPE_DIRECTORY"
    if stat.S_ISLNK(mode): return "FILE_TYPE_SYMLINK"
    return "FILE_TYPE_SPECIAL"

def stat_at(root_fd, parts):
    if not parts:
        return os.fstat(root_fd)
    parent, name = open_parent(root_fd, parts)
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    finally:
        os.close(parent)

def emit_ok():
    sys.stdout.write("OK\n")

def remove_tree_at(parent_fd, name):
    child = open_beneath(parent_fd, name, DIR_FLAGS)
    try:
        with os.scandir(child) as entries:
            for entry in entries:
                item = os.stat(entry.name, dir_fd=child, follow_symlinks=False)
                if stat.S_ISDIR(item.st_mode):
                    remove_tree_at(child, entry.name)
                else:
                    os.unlink(entry.name, dir_fd=child)
    finally:
        os.close(child)
    os.rmdir(name, dir_fd=parent_fd)

try:
    root = open_root()
    try:
        if OP == "probe":
            probe = open_beneath(root, ".", DIR_FLAGS)
            os.close(probe)
            emit_ok()

        elif OP == "stat":
            rel = decode_env("CUBE_WS_REL_B64", allow_empty=True)
            try:
                value = stat_at(root, segments(rel))
            except FileNotFoundError:
                fail(40)
            result = {"type": classify(value.st_mode)}
            if stat.S_ISREG(value.st_mode): result["size"] = value.st_size
            sys.stdout.write(json.dumps(result, separators=(",", ":")))

        elif OP == "scan":
            max_entries = int(os.environ["CUBE_WS_MAX_ENTRIES"])
            max_file = int(os.environ["CUBE_WS_MAX_FILE_BYTES"])
            max_total = int(os.environ["CUBE_WS_MAX_TOTAL_BYTES"])
            max_path = int(os.environ["CUBE_WS_MAX_PATH_BYTES"])
            max_output = int(os.environ["CUBE_WS_MAX_OUTPUT_BYTES"])
            excluded_directories = set(filter(None, os.environ.get("CUBE_WS_EXCLUDED_DIRECTORY_NAMES", "").split(",")))
            found, total = [], 0
            def walk(fd, prefix):
                with os.scandir(fd) as entries:
                    names = sorted((entry.name for entry in entries), key=os.fsencode)
                for name in names:
                    try:
                        encoded_name = name.encode("utf-8", "strict")
                    except UnicodeError:
                        fail(46)
                    rel = name if not prefix else prefix + "/" + name
                    rel_bytes = rel.encode("utf-8", "strict")
                    if len(rel_bytes) > max_path: fail(46)
                    value = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    kind = classify(value.st_mode)
                    # node_modules 是可由锁文件重建的依赖缓存；不进入 Revision，也不消耗用户文件配额。
                    if kind == "FILE_TYPE_DIRECTORY" and name in excluded_directories:
                        continue
                    item = {"relativePathB64": base64.b64encode(rel_bytes).decode("ascii"), "type": kind}
                    if kind == "FILE_TYPE_FILE":
                        if value.st_size > max_file: fail(45)
                        item["size"] = value.st_size
                    found.append(item)
                    if len(found) > max_entries: fail(44)
                    if kind == "FILE_TYPE_DIRECTORY":
                        child = open_beneath(fd, name, DIR_FLAGS)
                        try: walk(child, rel)
                        finally: os.close(child)
            walk(root, "")
            total = sum(item.get("size", 0) for item in found)
            if total > max_total: fail(45)
            payload = json.dumps(found, separators=(",", ":"), sort_keys=True)
            if len(payload.encode("utf-8")) > max_output: fail(47)
            sys.stdout.write(payload)

        elif OP == "read":
            rel = decode_env("CUBE_WS_REL_B64")
            maximum = int(os.environ["CUBE_WS_MAX_BYTES"])
            try:
                fd = open_beneath(root, rel, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            except FileNotFoundError:
                fail(40)
            except OSError:
                fail(41)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode): fail(41)
                if before.st_size > maximum: fail(42)
                body = bytearray()
                while len(body) <= maximum:
                    chunk = os.read(fd, min(65536, maximum + 1 - len(body)))
                    if not chunk: break
                    body.extend(chunk)
                after = os.fstat(fd)
            finally:
                os.close(fd)
            def fingerprint(value):
                return f"{value.st_size}:{value.st_dev}:{value.st_ino}:{value.st_mtime_ns}:{value.st_ctime_ns}:{value.st_mode:x}"
            first, last = fingerprint(before), fingerprint(after)
            sys.stdout.write("CUBEWS1:" + first + "\n")
            sys.stdout.write(base64.b64encode(body).decode("ascii") + "\n")
            sys.stdout.write("CUBEWS1:" + last + "\n")

        elif OP == "ensure_directory":
            parts = segments(decode_env("CUBE_WS_REL_B64"))
            for index, part in enumerate(parts):
                prefix = "/".join(parts[:index + 1])
                try:
                    current = open_beneath(root, prefix, DIR_FLAGS)
                except FileNotFoundError:
                    parent = open_beneath(root, "/".join(parts[:index]), DIR_FLAGS)
                    try: os.mkdir(part, 0o700, dir_fd=parent)
                    finally: os.close(parent)
                    current = open_beneath(root, prefix, DIR_FLAGS)
                os.close(current)
            emit_ok()

        elif OP in ("remove_file", "remove_directory", "remove_tree"):
            parent, name = open_parent(root, segments(decode_env("CUBE_WS_REL_B64")))
            try:
                try: value = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError:
                    emit_ok(); raise SystemExit(0)
                if OP == "remove_file":
                    if not (stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode)): fail(42)
                    os.unlink(name, dir_fd=parent)
                elif OP == "remove_directory":
                    if stat.S_ISLNK(value.st_mode): fail(41)
                    if not stat.S_ISDIR(value.st_mode): fail(43)
                    os.rmdir(name, dir_fd=parent)
                else:
                    if stat.S_ISLNK(value.st_mode): fail(41)
                    if not stat.S_ISDIR(value.st_mode): fail(43)
                    remove_tree_at(parent, name)
            finally:
                os.close(parent)
            emit_ok()

        elif OP == "finalize_write":
            tmp = decode_env("CUBE_WS_TEMP_B64")
            if not tmp.startswith("/tmp/hoox-") or "/" in tmp[len("/tmp/"):]: fail(40)
            expected_size = int(os.environ["CUBE_WS_EXPECTED_SIZE"])
            expected_sha = os.environ["CUBE_WS_EXPECTED_SHA256"]
            try: source = os.open(tmp, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            except OSError: fail(41)
            try:
                source_stat = os.fstat(source)
                if not stat.S_ISREG(source_stat.st_mode): fail(41)
                body = bytearray()
                while True:
                    chunk = os.read(source, 65536)
                    if not chunk: break
                    body.extend(chunk)
                    if len(body) > expected_size: fail(42)
            finally:
                os.close(source)
            if len(body) != expected_size or hashlib.sha256(body).hexdigest() != expected_sha: fail(42)
            parent, name = open_parent(root, segments(decode_env("CUBE_WS_REL_B64")))
            inner = ".hoox-" + expected_sha[:16] + "-" + secrets.token_hex(8) + ".tmp"
            created = False
            try:
                try:
                    target = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if stat.S_ISDIR(target.st_mode): fail(44)
                except FileNotFoundError: pass
                output = os.open(inner, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
                created = True
                try:
                    offset = 0
                    while offset < len(body): offset += os.write(output, body[offset:])
                    os.fsync(output)
                finally: os.close(output)
                os.replace(inner, name, src_dir_fd=parent, dst_dir_fd=parent)
                created = False
                os.fsync(parent)
            finally:
                if created:
                    try: os.unlink(inner, dir_fd=parent)
                    except OSError: pass
                os.close(parent)
            os.unlink(tmp)
            emit_ok()

        elif OP == "cleanup_temporary":
            tmp = decode_env("CUBE_WS_TEMP_B64")
            if not tmp.startswith("/tmp/hoox-") or "/" in tmp[len("/tmp/"):]: fail(40)
            try: value = os.lstat(tmp)
            except FileNotFoundError:
                emit_ok(); raise SystemExit(0)
            if not (stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode)): fail(41)
            os.unlink(tmp)
            emit_ok()
        else:
            fail(40)
    finally:
        os.close(root)
except SystemExit:
    raise
except Exception:
    fail(70)
PY`;

/** @deprecated 使用 Provider 无关的 SandboxWorkspacePort。 */
export { SandboxWorkspacePort as CubeSandboxWorkspacePort };
