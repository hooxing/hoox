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
  create(input: SandboxCreateInput, control?: OperationControl): Promise<SandboxHandle>;
  connect(id: string, control?: OperationControl): Promise<SandboxHandle>;
  inspect(
    id: string,
    control?: OperationControl,
  ): Promise<"running" | "paused" | "not_found" | "unknown">;
}
