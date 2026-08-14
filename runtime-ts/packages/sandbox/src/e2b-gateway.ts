import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  FileType,
  Sandbox as E2BSandbox,
  type SandboxConnectOpts as E2BSandboxConnectOptions,
  type SandboxInfo as E2BSandboxInfo,
  type SandboxListOpts as E2BSandboxListOptions,
  type SandboxOpts as E2BSandboxCreateOptions,
} from "e2b";
import { mapE2BError } from "./e2b-errors.js";
import { SandboxRuntimeError, settledOperation } from "./errors.js";
import type {
  CodeOutput,
  OperationControl,
  SandboxCreateInput,
  SandboxGateway,
  SandboxHandle,
} from "./types.js";
import {
  validateAbsolutePath,
  validateEnvironment,
  validateSandboxId,
  validateTemplateId,
  validateText,
  validateTimeout,
  validateTtl,
} from "./validation.js";
import {
  SandboxWorkspacePort,
  type SandboxWorkspaceAdapterOptions,
  resolveTrustedSandboxWorkspaceBinding,
  type SandboxWorkspaceSdk,
  type TrustedSandboxSessionCapability,
} from "./workspace-adapter.js";
import type { UncertainLifecycleEvent } from "./lifecycle.js";

const CREATE_REQUEST_METADATA = "agentRuntimeCreateRequestId";
const DEFAULT_MAX_TTL_SECONDS = 3_600;
type EffectiveOperationControl = Omit<OperationControl, "timeoutMs"> & { timeoutMs: number };

export interface E2BSdkSandbox {
  readonly sandboxId: string;
  readonly commands: {
    run(
      command: string,
      options?: {
        timeoutMs?: number;
        requestTimeoutMs?: number;
        signal?: AbortSignal;
        envs?: Record<string, string>;
      },
    ): Promise<unknown>;
  };
  readonly files: {
    read(
      path: string,
      options?: { format?: "text" | "bytes"; requestTimeoutMs?: number; signal?: AbortSignal },
    ): Promise<string | Uint8Array>;
    write(
      path: string,
      data: string | ArrayBuffer,
      options?: { requestTimeoutMs?: number; signal?: AbortSignal },
    ): Promise<unknown>;
    list(path: string): Promise<readonly E2BFileEntry[]>;
    getInfo(path: string): Promise<E2BFileEntry>;
    remove(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<E2BFileEntry>;
    makeDir(path: string): Promise<boolean>;
  };
  pause(options?: {
    keepMemory?: boolean;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<boolean>;
  kill(options?: { requestTimeoutMs?: number; signal?: AbortSignal }): Promise<boolean>;
}

interface E2BFileEntry {
  readonly name: string;
  readonly path: string;
  readonly type?: FileType | "file" | "dir" | "symlink";
  readonly size?: number;
}

export interface E2BSdkFacade {
  create(templateId: string, options: E2BSandboxCreateOptions): Promise<E2BSdkSandbox>;
  connect(id: string, options: E2BSandboxConnectOptions): Promise<E2BSdkSandbox>;
  getInfo(id: string, options: E2BSandboxConnectOptions): Promise<E2BSandboxInfo>;
  list(options: E2BSandboxListOptions): Promise<readonly E2BSandboxInfo[]>;
}

const DEFAULT_SDK: E2BSdkFacade = {
  create: (templateId, options) => E2BSandbox.create(templateId, options),
  connect: (id, options) => E2BSandbox.connect(id, options),
  getInfo: (id, options) => E2BSandbox.getInfo(id, options),
  list: async (options) => E2BSandbox.list(options).nextItems(options),
};

export interface E2BGatewayOptions {
  readonly apiKey: string;
  readonly domain?: string;
  readonly defaultOperationTimeoutMs?: number;
  readonly maxCreateTtlSeconds?: number;
  readonly connectTtlSeconds?: number;
  readonly onUncertainLifecycle?: (event: UncertainLifecycleEvent) => void | Promise<void>;
}

export class E2BSandboxGateway implements SandboxGateway {
  private readonly apiKey: string;
  private readonly domain: string | undefined;
  private readonly defaultOperationTimeoutMs: number;
  private readonly maxCreateTtlSeconds: number;
  private readonly connectTtlSeconds: number;
  private readonly onUncertainLifecycle:
    | ((event: UncertainLifecycleEvent) => void | Promise<void>)
    | undefined;

  constructor(
    options: E2BGatewayOptions,
    private readonly sdk: E2BSdkFacade = DEFAULT_SDK,
  ) {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) throw new SandboxRuntimeError("INVALID_ARGUMENT", "E2B API Key 不能为空");
    if (options.domain !== undefined && !validDomain(options.domain)) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "E2B Domain 无效");
    }
    this.apiKey = apiKey;
    this.domain = options.domain;
    this.defaultOperationTimeoutMs = options.defaultOperationTimeoutMs ?? 60_000;
    this.maxCreateTtlSeconds = options.maxCreateTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
    this.connectTtlSeconds = options.connectTtlSeconds ?? this.maxCreateTtlSeconds;
    validateTimeout(this.defaultOperationTimeoutMs);
    validateTtl(this.maxCreateTtlSeconds, 86_400);
    validateTtl(this.connectTtlSeconds, this.maxCreateTtlSeconds);
    this.onUncertainLifecycle = options.onUncertainLifecycle;
  }

  async create(input: SandboxCreateInput, control: OperationControl = {}): Promise<SandboxHandle> {
    validateTemplateId(input.templateId);
    validateEnvironment(input.env);
    validateLifecycle(input.lifecycle);
    validateVolumeMounts(input.volumeMounts);
    const ttlSeconds = validateTtl(input.ttlSeconds, this.maxCreateTtlSeconds);
    const effective = this.control(control);
    if (effective.signal?.aborted) {
      throw new SandboxRuntimeError("CANCELLED", "创建 E2B Sandbox 未开始：已请求取消");
    }

    const requestId = randomUUID();
    let cancellationRequested = false;
    const onAbort = () => {
      cancellationRequested = true;
    };
    effective.signal?.addEventListener("abort", onAbort, { once: true });
    let sandbox: E2BSdkSandbox;
    try {
      sandbox = await this.sdk.create(input.templateId, {
        ...this.connection(effective.timeoutMs, effective.signal),
        timeoutMs: ttlSeconds * 1_000,
        metadata: { [CREATE_REQUEST_METADATA]: requestId },
        ...(input.env === undefined ? {} : { envs: input.env }),
        ...(input.lifecycle === undefined
          ? {}
          : {
              lifecycle: {
                onTimeout: input.lifecycle.onTimeout ?? "kill",
                autoResume: input.lifecycle.autoResume ?? false,
              },
            }),
        ...(input.volumeMounts === undefined
          ? {}
          : {
              volumeMounts: Object.fromEntries(
                input.volumeMounts.map((mount) => [mount.path, mount.name]),
              ),
            }),
      });
    } catch (error) {
      const mapped = mapE2BError(error, "创建 E2B Sandbox");
      if (
        mapped.code === "AUTHENTICATION" ||
        mapped.code === "NOT_FOUND" ||
        mapped.code === "INVALID_ARGUMENT" ||
        mapped.code === "CREATE_UNAVAILABLE"
      ) {
        throw mapped;
      }
      if (await this.reconcileFailedCreate(requestId, ttlSeconds, effective)) throw mapped;
      await this.recordUnknownCreate({
        stage: "create_response",
        requestId,
        actualTtlSeconds: ttlSeconds,
      });
      throw new SandboxRuntimeError(
        "UNKNOWN",
        `创建 E2B Sandbox 的结果未知；最长 TTL 为 ${ttlSeconds} 秒`,
        mapped,
      );
    } finally {
      effective.signal?.removeEventListener("abort", onAbort);
    }

    if (cancellationRequested) {
      await this.cleanupCreatedSandbox(sandbox, requestId, ttlSeconds, effective);
      throw new SandboxRuntimeError(
        "CANCELLED",
        "创建 E2B Sandbox 已完成并清理，执行期间收到取消请求",
      );
    }
    return new E2BSandboxHandle(sandbox, this.defaultOperationTimeoutMs);
  }

  async connect(id: string, control: OperationControl = {}): Promise<SandboxHandle> {
    validateSandboxId(id);
    const effective = this.control(control);
    const sandbox = await this.call(
      "连接 E2B Sandbox",
      () =>
        this.sdk.connect(id, {
          ...this.connection(effective.timeoutMs, effective.signal),
          timeoutMs: this.connectTtlSeconds * 1_000,
        }),
      effective,
    );
    return new E2BSandboxHandle(sandbox, this.defaultOperationTimeoutMs);
  }

  async inspect(
    id: string,
    control: OperationControl = {},
  ): Promise<"running" | "paused" | "not_found" | "unknown"> {
    validateSandboxId(id);
    const effective = this.control(control);
    try {
      const info = await this.call(
        "查询 E2B Sandbox 状态",
        () => this.sdk.getInfo(id, this.connection(effective.timeoutMs, effective.signal)),
        effective,
      );
      return info.state === "running" ? "running" : info.state === "paused" ? "paused" : "unknown";
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "NOT_FOUND") return "not_found";
      throw error;
    }
  }

  async probe(): Promise<void> {
    const effective = this.control({});
    await this.call(
      "探测 E2B",
      () =>
        this.sdk.list({
          ...this.connection(effective.timeoutMs),
          limit: 1,
          query: { state: ["running", "paused"] },
        }),
      effective,
    );
  }

  async connectWorkspace(
    capability: TrustedSandboxSessionCapability,
    options: SandboxWorkspaceAdapterOptions,
    control: OperationControl = {},
  ): Promise<SandboxWorkspacePort> {
    const effective = this.control(control);
    const binding = await resolveTrustedSandboxWorkspaceBinding(
      capability,
      effective.timeoutMs,
      effective.signal,
    );
    const sandbox = await this.call(
      "连接 E2B Workspace Sandbox",
      () =>
        this.sdk.connect(binding.sessionId, {
          ...this.connection(effective.timeoutMs, effective.signal),
          timeoutMs: this.connectTtlSeconds * 1_000,
        }),
      effective,
    );
    return SandboxWorkspacePort.open({
      capability,
      binding,
      sandbox: workspaceSdk(sandbox),
      options,
      errorMapper: mapE2BError,
      dependencyPrefix: "E2B",
    });
  }

  private async reconcileFailedCreate(
    requestId: string,
    actualTtlSeconds: number,
    control: EffectiveOperationControl,
  ): Promise<boolean> {
    for (const delayMs of [0, 100, 300]) {
      if (delayMs > 0) await delay(delayMs);
      let entries: readonly E2BSandboxInfo[];
      try {
        entries = await this.sdk.list({
          ...this.connection(control.timeoutMs, control.signal),
          limit: 10,
          query: {
            metadata: { [CREATE_REQUEST_METADATA]: requestId },
            state: ["running", "paused"],
          },
        });
      } catch {
        continue;
      }
      const match = entries.find((entry) => entry.metadata[CREATE_REQUEST_METADATA] === requestId);
      if (match === undefined) continue;
      try {
        await this.sdk
          .connect(match.sandboxId, {
            ...this.connection(control.timeoutMs, control.signal),
            timeoutMs: this.connectTtlSeconds * 1_000,
          })
          .then((sandbox) => sandbox.kill(this.connection(control.timeoutMs, control.signal)));
        return true;
      } catch (error) {
        await this.recordUnknownCreate({
          stage: "cleanup_after_reconcile",
          requestId,
          sandboxId: match.sandboxId,
          actualTtlSeconds,
        });
        throw new SandboxRuntimeError("UNKNOWN", "对账找到 E2B Sandbox，但清理结果未知", error);
      }
    }
    return false;
  }

  private async cleanupCreatedSandbox(
    sandbox: E2BSdkSandbox,
    requestId: string,
    actualTtlSeconds: number,
    control: EffectiveOperationControl,
  ): Promise<void> {
    try {
      await sandbox.kill(this.connection(control.timeoutMs, control.signal));
    } catch (error) {
      await this.recordUnknownCreate({
        stage: "cleanup_after_create",
        requestId,
        sandboxId: sandbox.sandboxId,
        actualTtlSeconds,
      });
      throw new SandboxRuntimeError("UNKNOWN", "E2B Sandbox 创建后清理失败", error);
    }
  }

  private async recordUnknownCreate(
    event: Omit<UncertainLifecycleEvent, "kind" | "occurredAt">,
  ): Promise<void> {
    try {
      await this.onUncertainLifecycle?.({
        kind: "sandbox_create_outcome_unknown",
        ...event,
        occurredAt: new Date().toISOString(),
      });
    } catch {
      // 告警回调不能覆盖主要 UNKNOWN 失败。
    }
  }

  private connection(requestTimeoutMs: number, signal?: AbortSignal): E2BSandboxConnectOptions {
    return {
      apiKey: this.apiKey,
      ...(this.domain === undefined ? {} : { domain: this.domain }),
      requestTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  private control(control: OperationControl): EffectiveOperationControl {
    validateTimeout(control.timeoutMs);
    return { ...control, timeoutMs: control.timeoutMs ?? this.defaultOperationTimeoutMs };
  }

  private async call<T>(
    operation: string,
    action: () => Promise<T>,
    control: EffectiveOperationControl,
  ): Promise<T> {
    try {
      return await settledOperation(
        operation,
        async () => {
          try {
            return await action();
          } catch (error) {
            throw mapE2BError(error, operation);
          }
        },
        control,
      );
    } catch (error) {
      throw mapE2BError(error, operation);
    }
  }
}

class E2BSandboxHandle implements SandboxHandle {
  constructor(
    private readonly sandbox: E2BSdkSandbox,
    private readonly defaultTimeoutMs: number,
  ) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  async command(command: string, control: OperationControl = {}) {
    validateText(command, "命令");
    const effective = this.control(control);
    const output = await this.call(
      "执行 E2B Sandbox 命令",
      () =>
        this.sandbox.commands.run(command, {
          timeoutMs: effective.timeoutMs,
          requestTimeoutMs: effective.timeoutMs,
          ...(effective.signal === undefined ? {} : { signal: effective.signal }),
        }),
      effective,
    );
    return parseCommandOutput(output);
  }

  async runCode(
    code: string,
    control: OperationControl & { language?: string } = {},
  ): Promise<CodeOutput> {
    validateText(code, "代码");
    const language = normalizedLanguage(control.language);
    const encoded = Buffer.from(code, "utf8").toString("base64");
    const command =
      language === "python"
        ? `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"`
        : `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
    const output = await this.command(command, control);
    const stdout = lines(output.stdout);
    const stderr = lines(output.stderr);
    const text = stdout.at(-1);
    return {
      stdout,
      stderr,
      ...(output.exitCode === 0
        ? text === undefined
          ? {}
          : { text }
        : {
            error: {
              name: "CommandExitError",
              value: `exit code ${output.exitCode}`,
              traceback: output.stderr,
            },
          }),
    };
  }

  async readFile(path: string, control: OperationControl = {}): Promise<string> {
    validateAbsolutePath(path);
    const effective = this.control(control);
    const result = await this.call(
      "读取 E2B Sandbox 文件",
      () =>
        this.sandbox.files.read(path, {
          format: "text",
          requestTimeoutMs: effective.timeoutMs,
          ...(effective.signal === undefined ? {} : { signal: effective.signal }),
        }),
      effective,
    );
    if (typeof result !== "string") {
      throw new SandboxRuntimeError("PROTOCOL", "E2B 文件读取返回了非文本响应");
    }
    return result;
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    control: OperationControl = {},
  ): Promise<void> {
    validateAbsolutePath(path);
    const effective = this.control(control);
    const body = typeof data === "string" ? data : exactArrayBuffer(data);
    await this.call(
      "写入 E2B Sandbox 文件",
      () =>
        this.sandbox.files.write(path, body, {
          requestTimeoutMs: effective.timeoutMs,
          ...(effective.signal === undefined ? {} : { signal: effective.signal }),
        }),
      effective,
    );
  }

  async pause(control: OperationControl = {}): Promise<void> {
    const effective = this.control(control);
    await this.call(
      "暂停 E2B Sandbox",
      () =>
        this.sandbox.pause({
          keepMemory: true,
          requestTimeoutMs: effective.timeoutMs,
          ...(effective.signal === undefined ? {} : { signal: effective.signal }),
        }),
      effective,
    );
  }

  async kill(control: OperationControl & { ignoreNotFound?: boolean } = {}): Promise<void> {
    const effective = this.control(control);
    try {
      await this.call(
        "销毁 E2B Sandbox",
        () =>
          this.sandbox.kill({
            requestTimeoutMs: effective.timeoutMs,
            ...(effective.signal === undefined ? {} : { signal: effective.signal }),
          }),
        effective,
      );
    } catch (error) {
      if (
        control.ignoreNotFound &&
        error instanceof SandboxRuntimeError &&
        error.code === "NOT_FOUND"
      )
        return;
      throw error;
    }
  }

  private control(control: OperationControl): EffectiveOperationControl {
    validateTimeout(control.timeoutMs);
    return { ...control, timeoutMs: control.timeoutMs ?? this.defaultTimeoutMs };
  }

  private async call<T>(
    operation: string,
    action: () => Promise<T>,
    control: EffectiveOperationControl,
  ): Promise<T> {
    try {
      return await settledOperation(
        operation,
        async () => {
          try {
            return await action();
          } catch (error) {
            throw mapE2BError(error, operation);
          }
        },
        control,
      );
    } catch (error) {
      throw mapE2BError(error, operation);
    }
  }
}

function workspaceSdk(sandbox: E2BSdkSandbox): SandboxWorkspaceSdk {
  return {
    sandboxId: sandbox.sandboxId,
    commands: {
      run: (command, options) =>
        sandbox.commands.run(command, {
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options?.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
          ...(options?.envs === undefined ? {} : { envs: options.envs }),
        }),
    },
    files: {
      read: async (path) => {
        const value = await sandbox.files.read(path, { format: "text" });
        if (typeof value !== "string") {
          throw new SandboxRuntimeError("PROTOCOL", "E2B Workspace 文件响应不是文本");
        }
        return value;
      },
      write: async (path, data) => {
        await sandbox.files.write(path, typeof data === "string" ? data : exactArrayBuffer(data));
      },
      list: async (path) => (await sandbox.files.list(path)).map(workspaceEntry),
      stat: async (path) => workspaceEntry(await sandbox.files.getInfo(path)),
      remove: (path) => sandbox.files.remove(path),
      rename: async (from, to) => workspaceEntry(await sandbox.files.rename(from, to)),
      makeDir: async (path) => {
        await sandbox.files.makeDir(path);
        return { path, type: "FILE_TYPE_DIRECTORY" };
      },
    },
  };
}

function workspaceEntry(entry: E2BFileEntry): Record<string, unknown> {
  const type =
    entry.type === FileType.FILE
      ? "FILE_TYPE_FILE"
      : entry.type === FileType.DIR
        ? "FILE_TYPE_DIRECTORY"
        : entry.type === FileType.SYMLINK
          ? "FILE_TYPE_SYMLINK"
          : "FILE_TYPE_UNSPECIFIED";
  return {
    name: entry.name,
    path: entry.path,
    type,
    ...(entry.size === undefined ? {} : { size: entry.size }),
  };
}

function validateLifecycle(input: SandboxCreateInput["lifecycle"]): void {
  if (input === undefined) return;
  if (
    (input.onTimeout !== undefined && input.onTimeout !== "kill" && input.onTimeout !== "pause") ||
    (input.autoResume !== undefined && typeof input.autoResume !== "boolean") ||
    (input.autoResume === true && input.onTimeout !== "pause")
  ) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "E2B Sandbox lifecycle 无效");
  }
}

function validateVolumeMounts(input: SandboxCreateInput["volumeMounts"]): void {
  if (input === undefined) return;
  const paths = new Set<string>();
  for (const mount of input) {
    if (!mount.name.trim() || mount.name.includes("\0")) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "E2B Volume 名称无效");
    }
    validateAbsolutePath(mount.path);
    if (paths.has(mount.path)) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "E2B Volume 挂载路径重复");
    }
    paths.add(mount.path);
  }
}

function parseCommandOutput(value: unknown): { stdout: string; stderr: string; exitCode: number } {
  if (
    value === null ||
    typeof value !== "object" ||
    !("stdout" in value) ||
    !("stderr" in value) ||
    !("exitCode" in value) ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    !Number.isSafeInteger(value.exitCode)
  ) {
    throw new SandboxRuntimeError("PROTOCOL", "E2B command 返回了无效响应");
  }
  return { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode as number };
}
function normalizedLanguage(language: string | undefined): "python" | "javascript" {
  if (language === undefined || language === "python" || language === "py") return "python";
  if (language === "javascript" || language === "js") {
    return "javascript";
  }
  throw new SandboxRuntimeError("INVALID_ARGUMENT", "E2B runCode 仅支持 python 或 javascript");
}

function lines(value: string): string[] {
  return value === "" ? [] : value.replace(/\n$/u, "").split("\n");
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function validDomain(value: string): boolean {
  return (
    value.length <= 253 &&
    !value.includes("\0") &&
    !value.includes("://") &&
    /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(
      value,
    )
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
