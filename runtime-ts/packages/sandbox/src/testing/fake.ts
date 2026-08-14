import { SandboxRuntimeError, settledOperation } from "../errors.js";
import type {
  CodeOutput,
  CommandOutput,
  OperationControl,
  SandboxCreateInput,
  SandboxGateway,
  SandboxHandle,
} from "../types.js";
import {
  validateAbsolutePath,
  validateEnvironment,
  validateSandboxId,
  validateTemplateId,
  validateText,
  validateTtl,
} from "../validation.js";

export class FakeSandboxGateway implements SandboxGateway {
  readonly providerKey = "cube" as const;
  readonly sandboxes = new Map<string, FakeSandboxHandle>();
  private sequence = 0;

  constructor(private readonly operationDelayMs = 0) {}

  async create(
    input: SandboxCreateInput,
    control: OperationControl = {},
  ): Promise<FakeSandboxHandle> {
    validateTemplateId(input.templateId);
    validateTtl(input.ttlSeconds, 120);
    validateEnvironment(input.env);
    if (control.signal?.aborted) throw new SandboxRuntimeError("CANCELLED", "创建已取消");
    const handle = new FakeSandboxHandle(`fake-${++this.sequence}`, this.operationDelayMs);
    this.sandboxes.set(handle.id, handle);
    return handle;
  }

  async connect(id: string, control: OperationControl = {}): Promise<FakeSandboxHandle> {
    validateSandboxId(id);
    if (control.signal?.aborted) throw new SandboxRuntimeError("CANCELLED", "连接已取消");
    const handle = this.sandboxes.get(id);
    if (!handle || handle.killed)
      throw new SandboxRuntimeError("NOT_FOUND", "连接的 Fake Sandbox 不存在");
    handle.paused = false;
    return handle;
  }

  async inspect(id: string): Promise<"running" | "paused" | "not_found"> {
    validateSandboxId(id);
    const handle = this.sandboxes.get(id);
    if (handle === undefined || handle.killed) return "not_found";
    return handle.paused ? "paused" : "running";
  }
}

export class FakeSandboxHandle implements SandboxHandle {
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];
  paused = false;
  killed = false;

  constructor(
    readonly id: string,
    private readonly operationDelayMs = 0,
  ) {}

  async command(command: string, control: OperationControl = {}): Promise<CommandOutput> {
    validateText(command, "命令");
    this.commands.push(command);
    return this.execute("Fake 命令", control, async () => ({
      stdout: `${command}\n`,
      stderr: "",
      exitCode: 0,
    }));
  }

  async runCode(
    code: string,
    control: OperationControl & { language?: string } = {},
  ): Promise<CodeOutput> {
    validateText(code, "代码");
    if (control.language !== undefined) validateText(control.language, "language");
    return this.execute("Fake 代码", control, async () => ({ text: code, stdout: [], stderr: [] }));
  }

  async readFile(path: string, control: OperationControl = {}): Promise<string> {
    validateAbsolutePath(path);
    return this.execute("Fake 文件读取", control, async () => {
      const content = this.files.get(path);
      if (content === undefined) throw new SandboxRuntimeError("NOT_FOUND", "Fake 文件不存在");
      return content;
    });
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    control: OperationControl = {},
  ): Promise<void> {
    validateAbsolutePath(path);
    await this.execute("Fake 文件写入", control, async () => {
      this.files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
    });
  }

  async pause(control: OperationControl = {}): Promise<void> {
    await this.execute("Fake 暂停", control, async () => {
      this.paused = true;
    });
  }

  async kill(control: OperationControl & { ignoreNotFound?: boolean } = {}): Promise<void> {
    if (this.killed && !control.ignoreNotFound)
      throw new SandboxRuntimeError("NOT_FOUND", "Fake Sandbox 已销毁");
    this.killed = true;
  }

  private async execute<T>(
    operation: string,
    control: OperationControl,
    action: () => Promise<T>,
  ): Promise<T> {
    this.assertUsable();
    return settledOperation(
      operation,
      async () => {
        if (this.operationDelayMs) await delay(this.operationDelayMs);
        return action();
      },
      control,
    );
  }

  private assertUsable(): void {
    if (this.killed) throw new SandboxRuntimeError("NOT_FOUND", "Fake Sandbox 已销毁");
    if (this.paused) throw new SandboxRuntimeError("UPSTREAM", "Fake Sandbox 已暂停");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
