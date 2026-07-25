import { Config, Sandbox, type ConfigOptions } from "@cubesandbox/sdk";
import { guardedOperation, mapSandboxError, SandboxRuntimeError } from "./errors.js";
import type {
  CodeOutput,
  OperationControl,
  SandboxCreateInput,
  SandboxGateway,
  SandboxHandle,
} from "./types.js";

export interface CubeGatewayOptions extends ConfigOptions {
  defaultOperationTimeoutMs?: number;
}

export class CubeSandboxGateway implements SandboxGateway {
  private readonly config: Config;
  private readonly defaultOperationTimeoutMs: number;

  constructor(options: CubeGatewayOptions) {
    this.defaultOperationTimeoutMs = options.defaultOperationTimeoutMs ?? 60_000;
    this.config = new Config({
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? this.defaultOperationTimeoutMs,
    });
  }

  async create(input: SandboxCreateInput, control: OperationControl = {}): Promise<SandboxHandle> {
    if (!input.templateId.trim()) {
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "创建 Sandbox 时 templateId 不能为空");
    }
    const effectiveControl = this.control(control);
    if (effectiveControl.signal?.aborted) {
      throw new SandboxRuntimeError(
        "CANCELLED",
        "创建 Sandbox 已取消",
        effectiveControl.signal.reason,
      );
    }
    const startedAt = Date.now();
    let sandbox: Sandbox;
    try {
      // create 会产生必须回收的新资源。上游暂不支持 AbortSignal，因此不能用 Promise.race
      // 丢弃迟到的成功结果；必须等到拿到 ID 后再根据取消/超时状态销毁。
      sandbox = await Sandbox.create({
        config: this.config,
        templateId: input.templateId,
        ...(input.ttlSeconds === undefined ? {} : { timeout: input.ttlSeconds }),
        ...(input.env === undefined ? {} : { envVars: input.env }),
      });
    } catch (error) {
      throw mapSandboxError(error, "创建 Sandbox");
    }
    const timedOut =
      effectiveControl.timeoutMs !== undefined &&
      Date.now() - startedAt >= effectiveControl.timeoutMs;
    if (effectiveControl.signal?.aborted || timedOut) {
      try {
        await sandbox.kill();
      } catch (cleanupError) {
        throw new SandboxRuntimeError(
          "UPSTREAM",
          "创建 Sandbox 后取消或超时，且资源清理失败",
          cleanupError,
        );
      }
      throw new SandboxRuntimeError(
        effectiveControl.signal?.aborted ? "CANCELLED" : "TIMEOUT",
        effectiveControl.signal?.aborted ? "创建 Sandbox 已取消" : "创建 Sandbox 超时",
        effectiveControl.signal?.reason,
      );
    }
    return new CubeSandboxHandle(sandbox, this.defaultOperationTimeoutMs);
  }

  async connect(id: string, control: OperationControl = {}): Promise<SandboxHandle> {
    if (!id.trim())
      throw new SandboxRuntimeError("INVALID_ARGUMENT", "连接 Sandbox 时 id 不能为空");
    const sandbox = await guardedOperation(
      "连接 Sandbox",
      () => Sandbox.connect(id, { config: this.config }),
      this.control(control),
    );
    return new CubeSandboxHandle(sandbox, this.defaultOperationTimeoutMs);
  }

  private control(control: OperationControl): OperationControl {
    return { ...control, timeoutMs: control.timeoutMs ?? this.defaultOperationTimeoutMs };
  }
}

class CubeSandboxHandle implements SandboxHandle {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly defaultTimeoutMs: number,
  ) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  async command(command: string, control: OperationControl = {}) {
    if (!command.trim()) throw new SandboxRuntimeError("INVALID_ARGUMENT", "命令不能为空");
    return guardedOperation(
      "执行 Sandbox 命令",
      () =>
        this.sandbox.commands.run(command, {
          timeoutMs: control.timeoutMs ?? this.defaultTimeoutMs,
        }),
      this.control(control),
    );
  }

  async runCode(
    code: string,
    control: OperationControl & { language?: string } = {},
  ): Promise<CodeOutput> {
    if (!code.trim()) throw new SandboxRuntimeError("INVALID_ARGUMENT", "代码不能为空");
    const execution = await guardedOperation(
      "执行 Sandbox 代码",
      () =>
        this.sandbox.runCode(code, {
          ...(control.language === undefined ? {} : { language: control.language }),
          timeoutMs: control.timeoutMs ?? this.defaultTimeoutMs,
        }),
      this.control(control),
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
    assertAbsolutePath(path);
    return guardedOperation(
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
    assertAbsolutePath(path);
    await guardedOperation(
      "写入 Sandbox 文件",
      () => this.sandbox.files.write(path, data),
      this.control(control),
    );
  }

  async pause(control: OperationControl = {}): Promise<void> {
    const timeoutMs = control.timeoutMs ?? this.defaultTimeoutMs;
    await guardedOperation(
      "暂停 Sandbox",
      () => this.sandbox.pause({ timeoutMs }),
      this.control(control),
    );
  }

  async kill(control: OperationControl & { ignoreNotFound?: boolean } = {}): Promise<void> {
    try {
      await guardedOperation("销毁 Sandbox", () => this.sandbox.kill(), this.control(control));
    } catch (error) {
      // finally 清理允许重复执行；其他 NOT_FOUND 调用仍保留稳定错误语义。
      if (
        control.ignoreNotFound &&
        error instanceof SandboxRuntimeError &&
        error.code === "NOT_FOUND"
      )
        return;
      throw error;
    }
  }

  private control(control: OperationControl): OperationControl {
    return { ...control, timeoutMs: control.timeoutMs ?? this.defaultTimeoutMs };
  }
}

function assertAbsolutePath(path: string): void {
  // 第一阶段只允许 Linux Sandbox 绝对路径，避免 cwd 不同导致写错位置。
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new SandboxRuntimeError(
      "INVALID_ARGUMENT",
      "Sandbox 文件路径必须是合法的 Linux 绝对路径",
    );
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
    // 生命周期所有权在创建方；无论业务成功、失败或取消都必须尝试销毁。
    await sandbox.kill({ ignoreNotFound: true });
  }
}
