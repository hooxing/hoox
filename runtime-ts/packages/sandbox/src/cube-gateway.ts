import { randomUUID } from "node:crypto";
import { Config, Sandbox, type ConfigOptions, type CreateOptions } from "@cubesandbox/sdk";
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

export interface CubeSdkSandbox {
  sandboxId: string;
  commands: {
    run(
      command: string,
      options?: { timeoutMs?: number },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  runCode(
    code: string,
    options?: { language?: string; timeoutMs?: number },
  ): Promise<{
    text: string | undefined;
    logs: { stdout: string[]; stderr: string[] };
    error: null | { name: string; value: string; traceback: string };
  }>;
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string | Uint8Array): Promise<void>;
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
  requestId: string;
  maxTtlSeconds: number;
  occurredAt: string;
}

export interface CubeGatewayOptions extends ConfigOptions {
  defaultOperationTimeoutMs?: number;
  maxCreateTtlSeconds?: number;
  onUncertainLifecycle?: (event: UncertainLifecycleEvent) => void;
}

const CREATE_REQUEST_METADATA = "agentRuntimeCreateRequestId";
type EffectiveOperationControl = Omit<OperationControl, "timeoutMs"> & { timeoutMs: number };

export class CubeSandboxGateway implements SandboxGateway {
  private readonly baseConfig: ConfigOptions;
  private readonly defaultOperationTimeoutMs: number;
  private readonly maxCreateTtlSeconds: number;
  private readonly onUncertainLifecycle: ((event: UncertainLifecycleEvent) => void) | undefined;

  constructor(
    options: CubeGatewayOptions,
    private readonly sdk: CubeSdkFacade = DEFAULT_SDK,
  ) {
    this.defaultOperationTimeoutMs = options.defaultOperationTimeoutMs ?? 60_000;
    this.maxCreateTtlSeconds = options.maxCreateTtlSeconds ?? 120;
    validateTimeout(this.defaultOperationTimeoutMs, "defaultOperationTimeoutMs");
    validateTtl(this.maxCreateTtlSeconds, 86_400);
    validateConfigOptions(options);
    this.onUncertainLifecycle = options.onUncertainLifecycle;
    this.baseConfig = copyConfigOptions(options, this.defaultOperationTimeoutMs);
  }

  async create(input: SandboxCreateInput, control: OperationControl = {}): Promise<SandboxHandle> {
    validateTemplateId(input.templateId);
    validateEnvironment(input.env);
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
      });
    } catch (error) {
      const mapped = mapSandboxError(error, "创建 Sandbox");
      if (mapped.code === "AUTHENTICATION" || mapped.code === "NOT_FOUND") throw mapped;
      if (await this.reconcileFailedCreate(requestId, effectiveControl.timeoutMs)) throw mapped;
      this.recordUnknownCreate(requestId);
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
      await this.cleanupCreatedSandbox(sandbox);
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
      "native",
    );
    return new CubeSandboxHandle(sandbox, this.defaultOperationTimeoutMs);
  }

  private async reconcileFailedCreate(
    requestId: string,
    timeoutMs: number | undefined,
  ): Promise<boolean> {
    // 请求超时可能发生在服务端已创建、客户端未收到响应之后。用 metadata 做有限轮询对账。
    for (const delayMs of [0, 100, 300]) {
      if (delayMs) await delay(delayMs);
      try {
        const entries = await this.sdk.listV2(this.config(timeoutMs));
        const match = entries.find(
          (entry) => metadataValue(entry, CREATE_REQUEST_METADATA) === requestId,
        );
        const id = match ? sandboxId(match) : undefined;
        if (!id) continue;
        const sandbox = await this.sdk.connect(id, { config: this.config(timeoutMs) });
        await sandbox.kill();
        return true;
      } catch {
        // 对账本身失败时继续有限重试；最终进入 UNKNOWN，由 TTL 和回收指标兜底。
      }
    }
    return false;
  }

  private async cleanupCreatedSandbox(sandbox: CubeSdkSandbox): Promise<void> {
    try {
      await sandbox.kill();
    } catch (error) {
      this.recordUnknownCreate(sandbox.sandboxId);
      throw new SandboxRuntimeError("UNKNOWN", "Sandbox 创建后清理失败，资源状态未知", error);
    }
  }

  private recordUnknownCreate(requestId: string): void {
    try {
      this.onUncertainLifecycle?.({
        kind: "sandbox_create_outcome_unknown",
        requestId,
        maxTtlSeconds: this.maxCreateTtlSeconds,
        occurredAt: new Date().toISOString(),
      });
    } catch {
      // 指标回调不能覆盖主要 UNKNOWN 错误；生产实现还应由统一日志兜底。
    }
  }

  private config(requestTimeoutMs = this.defaultOperationTimeoutMs): Config {
    return new Config({ ...this.baseConfig, requestTimeoutMs });
  }

  private control(control: OperationControl): EffectiveOperationControl {
    validateTimeout(control.timeoutMs);
    return { ...control, timeoutMs: control.timeoutMs ?? this.defaultOperationTimeoutMs };
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
    return settledOperation(
      "执行 Sandbox 命令",
      () => this.sandbox.commands.run(command, { timeoutMs: effective.timeoutMs }),
      effective,
      "native",
    );
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
      "native",
    );
    return {
      ...(execution.text === undefined ? {} : { text: execution.text }),
      stdout: [...execution.logs.stdout],
      stderr: [...execution.logs.stderr],
      ...(execution.error
        ? {
            error: {
              name: execution.error.name,
              value: execution.error.value,
              traceback: execution.error.traceback,
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
      "native",
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
  if (options.timeout !== undefined) validateTtl(options.timeout, 86_400);
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

function copyConfigOptions(options: CubeGatewayOptions, requestTimeoutMs: number): ConfigOptions {
  return {
    apiUrl: validateBaseUrl(options.apiUrl),
    requestTimeoutMs,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.templateId === undefined ? {} : { templateId: options.templateId }),
    ...(options.proxyNodeIp === undefined ? {} : { proxyNodeIp: options.proxyNodeIp }),
    ...(options.proxyPort === undefined ? {} : { proxyPort: options.proxyPort }),
    ...(options.proxyScheme === undefined ? {} : { proxyScheme: options.proxyScheme }),
    ...(options.sandboxDomain === undefined ? {} : { sandboxDomain: options.sandboxDomain }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  };
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
