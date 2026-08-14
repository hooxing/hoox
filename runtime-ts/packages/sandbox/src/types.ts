export type SandboxProviderKey = "cube" | "e2b";

export interface OperationControl {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SandboxCreateInput {
  templateId: string;
  ttlSeconds?: number;
  env?: Record<string, string>;
  lifecycle?: {
    onTimeout?: "kill" | "pause";
    autoResume?: boolean;
  };
  /** Cube ≥ 0.6 Volume 挂载；Provider 之外的业务层不得注入任意 hostPath。 */
  volumeMounts?: readonly Readonly<{ readonly name: string; readonly path: string }>[];
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CodeOutput {
  text?: string;
  stdout: string[];
  stderr: string[];
  error?: { name: string; value: string; traceback: string };
}

export interface SandboxHandle {
  readonly id: string;
  command(command: string, control?: OperationControl): Promise<CommandOutput>;
  runCode(code: string, control?: OperationControl & { language?: string }): Promise<CodeOutput>;
  readFile(path: string, control?: OperationControl): Promise<string>;
  writeFile(path: string, data: string | Uint8Array, control?: OperationControl): Promise<void>;
  pause(control?: OperationControl): Promise<void>;
  kill(control?: OperationControl & { ignoreNotFound?: boolean }): Promise<void>;
}

export interface SandboxGateway {
  readonly providerKey: SandboxProviderKey;
  create(input: SandboxCreateInput, control?: OperationControl): Promise<SandboxHandle>;
  connect(id: string, control?: OperationControl): Promise<SandboxHandle>;
  inspect(
    id: string,
    control?: OperationControl,
  ): Promise<"running" | "paused" | "not_found" | "unknown">;
}
