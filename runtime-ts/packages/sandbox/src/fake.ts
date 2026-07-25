import { SandboxRuntimeError } from "./errors.js";
import type {
  CodeOutput,
  CommandOutput,
  OperationControl,
  SandboxCreateInput,
  SandboxGateway,
  SandboxHandle,
} from "./types.js";

export class FakeSandboxGateway implements SandboxGateway {
  readonly sandboxes = new Map<string, FakeSandboxHandle>();
  private sequence = 0;

  async create(_input: SandboxCreateInput, control: OperationControl = {}): Promise<SandboxHandle> {
    assertNotAborted(control.signal);
    const handle = new FakeSandboxHandle(`fake-${++this.sequence}`);
    this.sandboxes.set(handle.id, handle);
    return handle;
  }

  async connect(id: string, control: OperationControl = {}): Promise<SandboxHandle> {
    assertNotAborted(control.signal);
    const handle = this.sandboxes.get(id);
    if (!handle || handle.killed)
      throw new SandboxRuntimeError("NOT_FOUND", "连接的 Fake Sandbox 不存在");
    handle.paused = false;
    return handle;
  }
}

export class FakeSandboxHandle implements SandboxHandle {
  readonly files = new Map<string, string>();
  paused = false;
  killed = false;

  constructor(readonly id: string) {}

  async command(command: string, control: OperationControl = {}): Promise<CommandOutput> {
    this.assertUsable(control);
    return { stdout: `${command}\n`, stderr: "", exitCode: 0 };
  }

  async runCode(code: string, control: OperationControl = {}): Promise<CodeOutput> {
    this.assertUsable(control);
    return { text: code, stdout: [], stderr: [] };
  }

  async readFile(path: string, control: OperationControl = {}): Promise<string> {
    this.assertUsable(control);
    const content = this.files.get(path);
    if (content === undefined) throw new SandboxRuntimeError("NOT_FOUND", "Fake 文件不存在");
    return content;
  }

  async writeFile(
    path: string,
    data: string | Uint8Array,
    control: OperationControl = {},
  ): Promise<void> {
    this.assertUsable(control);
    this.files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
  }

  async pause(control: OperationControl = {}): Promise<void> {
    this.assertUsable(control);
    this.paused = true;
  }

  async kill(control: OperationControl & { ignoreNotFound?: boolean } = {}): Promise<void> {
    assertNotAborted(control.signal);
    if (this.killed && !control.ignoreNotFound)
      throw new SandboxRuntimeError("NOT_FOUND", "Fake Sandbox 已销毁");
    this.killed = true;
  }

  private assertUsable(control: OperationControl): void {
    assertNotAborted(control.signal);
    if (this.killed) throw new SandboxRuntimeError("NOT_FOUND", "Fake Sandbox 已销毁");
    if (this.paused) throw new SandboxRuntimeError("UPSTREAM", "Fake Sandbox 已暂停");
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SandboxRuntimeError("CANCELLED", "Fake 操作已取消", signal.reason);
}
