import { randomUUID } from "node:crypto";
import { Config, type ConfigOptions, type CreateOptions, Sandbox } from "@cubesandbox/sdk";
import { mapSandboxError, SandboxRuntimeError, settledOperation } from "./errors.js";
import type {
  CodeOutput,
  OperationControl,
  SandboxCreateInput,
  SandboxGateway,
  SandboxHandle,
} from "./types.js";
import {
  validateAbsolutePath,
  validateBaseUrl,
  validateEnvironment,
  validateSandboxId,
  validateTemplateId,
  validateText,
  validateTimeout,
  validateTtl,
} from "./validation.js";
import {
  CubeSandboxWorkspacePort,
  type CubeWorkspaceAdapterOptions,
  resolveTrustedSandboxWorkspaceBinding,
  type TrustedSandboxSessionCapability,
} from "./workspace-adapter.js";

export interface CubeSdkSandbox {
  sandboxId: string;
  commands: {
    run(
      command: string,
      options?: { timeoutMs?: number; envs?: Record<string, string> },
    ): Promise<unknown>;
  };
  runCode(code: string, options?: { language?: string; timeoutMs?: number }): Promise<unknown>;
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    list(path: string): Promise<Record<string, unknown>[]>;
    stat(path: string): Promise<Record<string, unknown>>;
    remove(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<Record<string, unknown>>;
    makeDir(path: string): Promise<Record<string, unknown>>;
  };
  pause(options?: { timeoutMs?: number }): Promise<void>;
  kill(): Promise<void>;
}

export interface CubeSdkFacade {
  create(options: CreateOptions): Promise<CubeSdkSandbox>;
  connect(id: string, options: { config: Config }): Promise<CubeSdkSandbox>;
  listV2(config: Config): Promise<Record<string, unknown>[]>;
}

const DEFAULT_SDK: CubeSdkFacade = {
  create: (options) => Sandbox.create(options),
  connect: (id, options) => Sandbox.connect(id, options),
  listV2: (config) => Sandbox.listV2(config),
};

export interface UncertainLifecycleEvent {
  kind: "sandbox_create_outcome_unknown";
  stage: "create_response" | "cleanup_after_create" | "cleanup_after_reconcile";
  requestId: string;
  sandboxId?: string;
  actualTtlSeconds: number;
  occurredAt: string;
}

export interface CubeGatewayOptions extends ConfigOptions {
  defaultOperationTimeoutMs?: number;
  maxCreateTtlSeconds?: number;
  onUncertainLifecycle?: (event: UncertainLifecycleEvent) => void | Promise<void>;
}

const CREATE_REQUEST_METADATA = "agentRuntimeCreateRequestId";
// 86400 只表示当前真实 Spike 已接受的配置上界，不宣称是 Provider 永久最大值。
const MAX_CONFIGURABLE_SANDBOX_TTL_SECONDS = 86_400;
type EffectiveOperationControl = Omit<OperationControl, "timeoutMs"> & { timeoutMs: number };

export class CubeSandboxGateway implements SandboxGateway {
  private readonly baseConfig: ConfigOptions;
  private readonly defaultOperationTimeoutMs: number;
  private readonly maxCreateTtlSeconds: number;
  private readonly connectTtlSeconds: number;
  private readonly onUncertainLifecycle:
    | ((event: UncertainLifecycleEvent) => void | Promise<void>)
    | undefined;

  constructor(
    options: CubeGatewayOptions,
    private readonly sdk: CubeSdkFacade = DEFAULT_SDK,
  ) {
    this.defaultOperationTimeoutMs = options.defaultOperationTimeoutMs ?? 60_000;
    this.maxCreateTtlSeconds = options.maxCreateTtlSeconds ?? 120;
    validateTimeout(this.defaultOperationTimeoutMs, "defaultOperationTimeoutMs");
    validateTtl(this.maxCreateTtlSeconds, MAX_CONFIGURABLE_SANDBOX_TTL_SECONDS);
    this.connectTtlSeconds = validateTtl(
      options.timeout ?? this.maxCreateTtlSeconds,
      this.maxCreateTtlSeconds,
    );
    validateConfigOptions(options);
    this.onUncertainLifecycle = options.onUncertainLifecycle;
    this.baseConfig = copyConfigOptions(
      options,
      this.defaultOperationTimeoutMs,
      this.connectTtlSeconds,
    );
  }

  async create(input: SandboxCreateInput, control: OperationControl = {}): Promise<SandboxHandle> {
    validateTemplateId(input.templateId);
    validateEnvironment(input.env);
    validateLifecycle(input.lifecycle);
    const ttlSeconds = validateTtl(input.ttlSeconds, this.maxCreateTtlSeconds);
    const effectiveControl = this.control(control);
    if (effectiveControl.signal?.aborted) {
      throw new SandboxRuntimeError("CANCELLED", "创建 Sandbox 未开始：已请求取消");
    }

    const requestId = randomUUID();
    let cancellationRequested = false;
    const onAbort = () => {
      cancellationRequested = true;
    };
    effectiveControl.signal?.addEventListener("abort", onAbort, { once: true });
    let sandbox: CubeSdkSandbox;
    try {
      sandbox = await this.sdk.create({
        config: this.config(effectiveControl.timeoutMs),
        templateId: input.templateId,
        timeout: ttlSeconds,
        metadata: { [CREATE_REQUEST_METADATA]: requestId },
        ...(input.env === undefined ? {} : { envVars: input.env }),
        ...(input.lifecycle === undefined ? {} : { lifecycle: { ...input.lifecycle } }),
      });
    } catch (error) {
      const mapped = mapSandboxError(error, "创建 Sandbox");
      if (mapped.code === "AUTHENTICATION" || mapped.code === "NOT_FOUND") throw mapped;
      if (await this.reconcileFailedCreate(requestId, ttlSeconds, effectiveControl.timeoutMs))
        throw mapped;
      await this.recordUnknownCreate({
        stage: "create_response",
        requestId,
        actualTtlSeconds: ttlSeconds,
      });
      throw new SandboxRuntimeError(
        "UNKNOWN",
        `创建 Sandbox 的结果未知；已登记泄漏指标，最长 TTL 为 ${ttlSeconds} 秒`,
        mapped,
      );
    } finally {
      effectiveControl.signal?.removeEventListener("abort", onAbort);
    }

    if (cancellationRequested) {
      // create 已获得确定 ID，先清理再在安全点返回取消；绝不丢弃迟到的成功结果。
      await this.cleanupCreatedSandbox(sandbox, requestId, ttlSeconds);
      throw new SandboxRuntimeError("CANCELLED", "创建 Sandbox 已完成并清理，执行期间收到取消请求");
    }
    return new CubeSandboxHandle(sandbox, this.defaultOperationTimeoutMs);
  }

  async connect(id: string, control: OperationControl = {}): Promise<SandboxHandle> {
    validateSandboxId(id);
    const effectiveControl = this.control(control);
    const sandbox = await settledOperation(
      "连接 Sandbox",
      () => this.sdk.connect(id, { config: this.config(effectiveControl.timeoutMs) }),
      effectiveControl,
    );
    return new CubeSandboxHandle(sandbox, this.defaultOperationTimeoutMs);
  }

  async inspect(
    id: string,
    control: OperationControl = {},
  ): Promise<"running" | "paused" | "not_found" | "unknown"> {
    validateSandboxId(id);
    const effectiveControl = this.control(control);
    const entries = await settledOperation(
      "查询 Sandbox 状态",
      () => this.sdk.listV2(this.config(effectiveControl.timeoutMs)),
      effectiveControl,
    );
    const entry = entries.find((candidate) => sandboxId(candidate) === id);
    if (entry === undefined) return "not_found";
    const state = entry.state ?? entry.status;
    return state === "paused" ? "paused" : state === "running" ? "running" : "unknown";
  }

  /** 生产 readiness 使用真实鉴权调用；不创建 Sandbox，也不返回上游响应正文。 */
  async probe(): Promise<void> {
    await settledOperation(
      "探测 CubeSandbox",
      () => this.sdk.listV2(this.config(this.defaultOperationTimeoutMs)),
      { timeoutMs: this.defaultOperationTimeoutMs },
    );
  }

  /**
   * 只有持有可信 Session capability 的装配层才能取得 Workspace 文件能力。
   * 调用方不能注入根目录、Sandbox URL 或宿主路径。
   */
  async connectWorkspace(
    capability: TrustedSandboxSessionCapability,
    options: CubeWorkspaceAdapterOptions,
    control: OperationControl = {},
  ): Promise<CubeSandboxWorkspacePort> {
    const effectiveControl = this.control(control);
    const binding = await resolveTrustedSandboxWorkspaceBinding(
      capability,
      effectiveControl.timeoutMs,
      effectiveControl.signal,
    );
    const sandbox = await settledOperation(
      "连接 Workspace Sandbox",
      () =>
        this.sdk.connect(binding.sessionId, {
          config: this.config(effectiveControl.timeoutMs),
        }),
      effectiveControl,
    );
    return CubeSandboxWorkspacePort.open({
      capability,
      binding,
      sandbox,
      options,
    });
  }

  private async reconcileFailedCreate(
    requestId: string,
    actualTtlSeconds: number,
    timeoutMs: number | undefined,
  ): Promise<boolean> {
    // 请求超时可能发生在服务端已创建、客户端未收到响应之后。用 metadata 做有限轮询对账。
    for (const delayMs of [0, 100, 300]) {
      if (delayMs) await delay(delayMs);
      let entries: Record<string, unknown>[];
      try {
        entries = await this.sdk.listV2(this.config(timeoutMs));
      } catch {
        continue;
      }
      const match = entries.find(
        (entry) => metadataValue(entry, CREATE_REQUEST_METADATA) === requestId,
      );
      const id = match ? sandboxId(match) : undefined;
      if (!id) continue;
      try {
        const sandbox = await this.sdk.connect(id, { config: this.config(timeoutMs) });
        await sandbox.kill();
        return true;
      } catch (error) {
        await this.recordUnknownCreate({
          stage: "cleanup_after_reconcile",
          requestId,
          sandboxId: id,
          actualTtlSeconds,
        });
        throw new SandboxRuntimeError("UNKNOWN", "对账找到 Sandbox，但清理结果未知", error);
      }
    }
    return false;
  }

  private async cleanupCreatedSandbox(
    sandbox: CubeSdkSandbox,
    requestId: string,
    actualTtlSeconds: number,
  ): Promise<void> {
    try {
      await sandbox.kill();
    } catch (error) {
      await this.recordUnknownCreate({
        stage: "cleanup_after_create",
        requestId,
        sandboxId: sandbox.sandboxId,
        actualTtlSeconds,
      });
      throw new SandboxRuntimeError("UNKNOWN", "Sandbox 创建后清理失败，资源状态未知", error);
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
      // 指标回调不能覆盖主要 UNKNOWN 错误；生产实现还应由统一日志兜底。
    }
  }

  private config(requestTimeoutMs = this.defaultOperationTimeoutMs): Config {
    // 显式传递 timeout，禁止 SDK 从环境变量或 300 秒默认值恢复 Sandbox。
    return new Config({ ...this.baseConfig, timeout: this.connectTtlSeconds, requestTimeoutMs });
  }

  private control(control: OperationControl): EffectiveOperationControl {
    validateTimeout(control.timeoutMs);
    return { ...control, timeoutMs: control.timeoutMs ?? this.defaultOperationTimeoutMs };
  }
}

function validateLifecycle(input: SandboxCreateInput["lifecycle"]): void {
  if (input === undefined) return;
  if (input.onTimeout !== undefined && input.onTimeout !== "kill" && input.onTimeout !== "pause") {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "Sandbox lifecycle.onTimeout 无效");
  }
  if (input.autoResume !== undefined && typeof input.autoResume !== "boolean") {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "Sandbox lifecycle.autoResume 无效");
  }
}

class CubeSandboxHandle implements SandboxHandle {
  constructor(
    private readonly sandbox: CubeSdkSandbox,
    private readonly defaultTimeoutMs: number,
  ) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  async command(command: string, control: OperationControl = {}) {
    validateText(command, "命令");
    const effective = this.control(control);
    const response = await settledOperation(
      "执行 Sandbox 命令",
      () => this.sandbox.commands.run(command, { timeoutMs: effective.timeoutMs }),
      effective,
    );
    return validateCommandResponse(response);
  }

  async runCode(
    code: string,
    control: OperationControl & { language?: string } = {},
  ): Promise<CodeOutput> {
    validateText(code, "代码");
    if (control.language !== undefined) validateText(control.language, "language");
    const effective = this.control(control);
    const execution = await settledOperation(
      "执行 Sandbox 代码",
      () =>
        this.sandbox.runCode(code, {
          ...(control.language === undefined ? {} : { language: control.language }),
          timeoutMs: effective.timeoutMs,
        }),
      effective,
    );
    const validated = validateRunCodeResponse(execution);
    return {
      ...(validated.text === undefined ? {} : { text: validated.text }),
      stdout: [...validated.logs.stdout],
      stderr: [...validated.logs.stderr],
      ...(validated.error
        ? {
            error: {
              name: validated.error.name,
              value: validated.error.value,
              traceback: validated.error.traceback,
            },
          }
        : {}),
    };
  }

  async readFile(path: string, control: OperationControl = {}): Promise<string> {
    validateAbsolutePath(path);
    return settledOperation(
      "读取 Sandbox 文件",
      () => this.sandbox.files.read(path),
      this.control(control),
    );
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    control: OperationControl = {},
  ): Promise<void> {
    validateAbsolutePath(path);
    await settledOperation(
      "写入 Sandbox 文件",
      () => this.sandbox.files.write(path, data),
      this.control(control),
    );
  }

  async pause(control: OperationControl = {}): Promise<void> {
    const effective = this.control(control);
    await settledOperation(
      "暂停 Sandbox",
      () => this.sandbox.pause({ timeoutMs: effective.timeoutMs }),
      effective,
    );
  }

  async kill(control: OperationControl & { ignoreNotFound?: boolean } = {}): Promise<void> {
    try {
      await settledOperation("销毁 Sandbox", () => this.sandbox.kill(), this.control(control));
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
}

export async function usingSandbox<T>(
  gateway: SandboxGateway,
  input: SandboxCreateInput,
  action: (sandbox: SandboxHandle) => Promise<T>,
): Promise<T> {
  const sandbox = await gateway.create(input);
  try {
    return await action(sandbox);
  } finally {
    await sandbox.kill({ ignoreNotFound: true });
  }
}

function validateConfigOptions(options: CubeGatewayOptions): void {
  validateBaseUrl(options.apiUrl);
  validateTimeout(options.requestTimeoutMs, "requestTimeoutMs");
  if (
    options.proxyPort !== undefined &&
    (!Number.isInteger(options.proxyPort) || options.proxyPort <= 0 || options.proxyPort > 65_535)
  ) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "CubeProxy 端口必须是 1-65535 的整数");
  }
  if (
    options.proxyScheme !== undefined &&
    (typeof options.proxyScheme !== "string" || !["http", "https"].includes(options.proxyScheme))
  ) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "CubeProxy scheme 只能是 http 或 https");
  }
  if (
    options.proxyNodeIp !== undefined &&
    options.proxyNodeIp !== null &&
    (typeof options.proxyNodeIp !== "string" || !options.proxyNodeIp.trim())
  ) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "CubeProxy 节点地址不能为空");
  }
  if (options.templateId !== undefined && options.templateId !== null)
    validateTemplateId(options.templateId);
  if (
    options.apiKey !== undefined &&
    options.apiKey !== null &&
    (typeof options.apiKey !== "string" || !options.apiKey.trim())
  ) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "CubeSandbox API Key 不能为空字符串");
  }
  if (
    options.sandboxDomain !== undefined &&
    (typeof options.sandboxDomain !== "string" || !options.sandboxDomain.trim())
  ) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "Sandbox domain 不能为空");
  }
}

function copyConfigOptions(
  options: CubeGatewayOptions,
  requestTimeoutMs: number,
  timeout: number,
): ConfigOptions {
  return {
    apiUrl: validateBaseUrl(options.apiUrl),
    requestTimeoutMs,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.templateId === undefined ? {} : { templateId: options.templateId }),
    ...(options.proxyNodeIp === undefined ? {} : { proxyNodeIp: options.proxyNodeIp }),
    ...(options.proxyPort === undefined ? {} : { proxyPort: options.proxyPort }),
    ...(options.proxyScheme === undefined ? {} : { proxyScheme: options.proxyScheme }),
    ...(options.sandboxDomain === undefined ? {} : { sandboxDomain: options.sandboxDomain }),
    timeout,
  };
}

interface ValidCommandResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function validateCommandResponse(value: unknown): ValidCommandResponse {
  if (!isRecord(value)) throw protocolError("命令响应不是对象");
  if (
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    !Number.isInteger(value.exitCode)
  ) {
    throw protocolError("命令响应字段非法");
  }
  return { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode as number };
}

interface ValidRunCodeResponse {
  text: string | undefined;
  logs: { stdout: string[]; stderr: string[] };
  error: null | { name: string; value: string; traceback: string };
}

function validateRunCodeResponse(value: unknown): ValidRunCodeResponse {
  if (!isRecord(value) || !isRecord(value.logs)) throw protocolError("代码执行响应不是对象");
  if (value.text !== undefined && typeof value.text !== "string")
    throw protocolError("代码执行 text 字段非法");
  if (!isStringArray(value.logs.stdout) || !isStringArray(value.logs.stderr))
    throw protocolError("代码执行日志字段非法");
  if (value.error !== null) {
    if (
      !isRecord(value.error) ||
      typeof value.error.name !== "string" ||
      typeof value.error.value !== "string" ||
      typeof value.error.traceback !== "string"
    ) {
      throw protocolError("代码执行 error 字段非法");
    }
  }
  return {
    text: value.text as string | undefined,
    logs: { stdout: [...value.logs.stdout], stderr: [...value.logs.stderr] },
    error: value.error as ValidRunCodeResponse["error"],
  };
}

function protocolError(reason: string): SandboxRuntimeError {
  return new SandboxRuntimeError("PROTOCOL", `CubeSandbox ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function metadataValue(entry: Record<string, unknown>, key: string): unknown {
  const metadata = entry.metadata;
  return typeof metadata === "object" && metadata !== null
    ? (metadata as Record<string, unknown>)[key]
    : undefined;
}

function sandboxId(entry: Record<string, unknown>): string | undefined {
  const value = entry.sandboxID ?? entry.sandboxId;
  return typeof value === "string" && value ? value : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
