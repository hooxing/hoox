import type { SandboxHandle } from "@cube-runtime/sandbox";
import { SandboxRuntimeError } from "@cube-runtime/sandbox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SANDBOX_TOOL_NAMES = [
  "sandbox_command",
  "sandbox_run_code",
  "sandbox_read_file",
  "sandbox_write_file",
] as const;

export function createSandboxTools(sandbox: SandboxHandle) {
  return [
    defineTool({
      name: "sandbox_command",
      label: "Sandbox 命令",
      description: "只在隔离的 CubeSandbox 中执行命令，不访问 Agent Worker 宿主机。",
      parameters: Type.Object({ command: Type.String({ minLength: 1 }) }),
      execute: async (_id, params, signal) =>
        toolResult(() => sandbox.command(params.command, signalControl(signal))),
    }),
    defineTool({
      name: "sandbox_run_code",
      label: "Sandbox 代码",
      description: "只在隔离的 CubeSandbox Jupyter 环境中执行代码。",
      parameters: Type.Object({
        code: Type.String({ minLength: 1 }),
        language: Type.Optional(Type.String()),
      }),
      execute: async (_id, params, signal) =>
        toolResult(() =>
          sandbox.runCode(params.code, {
            ...signalControl(signal),
            ...(params.language ? { language: params.language } : {}),
          }),
        ),
    }),
    defineTool({
      name: "sandbox_read_file",
      label: "读取 Sandbox 文件",
      description: "读取 CubeSandbox 中的绝对路径文件；不能读取 Worker 宿主机。",
      parameters: Type.Object({ path: Type.String({ pattern: "^/" }) }),
      execute: async (_id, params, signal) =>
        toolResult(() => sandbox.readFile(params.path, signalControl(signal))),
    }),
    defineTool({
      name: "sandbox_write_file",
      label: "写入 Sandbox 文件",
      description: "写入 CubeSandbox 中的绝对路径文件；不能写入 Worker 宿主机。",
      parameters: Type.Object({
        path: Type.String({ pattern: "^/" }),
        content: Type.String(),
      }),
      execute: async (_id, params, signal) =>
        toolResult(async () => {
          await sandbox.writeFile(params.path, params.content, signalControl(signal));
          return { written: true };
        }),
    }),
  ];
}

function signalControl(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}

async function toolResult(action: () => Promise<unknown>) {
  try {
    const value = await action();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
  } catch (error) {
    // 工具结果不回传上游 cause，避免把网络地址、认证头或 SDK 内部响应泄漏给模型。
    const safe =
      error instanceof SandboxRuntimeError
        ? { code: error.code, message: error.message }
        : { code: "UPSTREAM", message: "Sandbox 工具执行失败" };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      details: {},
      isError: true,
    };
  }
}
