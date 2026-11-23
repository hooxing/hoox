import { normalizeExternalToolSchema } from "@hoox/domain";
import type { ClientToolAction } from "@hoox/run-contracts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { externalToolSchemaToTypeBox } from "./external-tools.js";

export interface PlaygroundClientToolDefinition {
  readonly waitTimeoutMs?: number;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export function clientToolsForSession<T>(
  definitions: readonly T[],
  agentKind: "root" | "subagent",
): readonly T[] {
  return agentKind === "subagent" ? [] : definitions;
}

export interface PlaygroundClientToolPorts {
  readonly origin: "normal" | "playground" | "evaluation" | "api";
  readonly mocks: Readonly<Record<string, unknown>>;
  readonly persistStarted: (input: {
    readonly callId: string;
    readonly toolName: string;
  }) => Promise<void>;
  readonly recordReceipt: (
    callId: string,
    toolName: string,
    outcome: "succeeded" | "failed",
    executionMode?: "playground_mock",
  ) => Promise<unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("PLAYGROUND_MOCK_INVALID");
}

// jsonb 不接受 NUL 和未配对代理项；按解码后的字符串判断，不能把字面量 \u0000 当成 NUL。
function pgJsonStringsAllowed(value: unknown): boolean {
  if (typeof value === "string") return value.isWellFormed() && !value.includes("\0");
  if (value === null || typeof value !== "object") return true;
  return Object.entries(value).every(
    ([key, child]) => pgJsonStringsAllowed(key) && pgJsonStringsAllowed(child),
  );
}

export function createClientTools(
  definitions: readonly PlaygroundClientToolDefinition[],
  ports: Pick<PlaygroundClientToolPorts, "persistStarted" | "recordReceipt"> & {
    readonly stage: (action: ClientToolAction) => boolean;
  },
): readonly AgentTool<TSchema, unknown>[] {
  return definitions.map((definition) => {
    const parameters = externalToolSchemaToTypeBox(
      normalizeExternalToolSchema(definition.inputSchema).schema,
    );
    return {
      name: definition.name,
      // Rollout 的 tool_call / tool_result 必须先配对，再记录同轮下一个前驱。
      executionMode: "sequential",
      label: definition.name,
      description: definition.description,
      parameters,
      execute: async (callId: string, args: unknown) => {
        await ports.persistStarted({ callId, toolName: definition.name });
        const serialized = JSON.stringify(args);
        const staged =
          Value.Check(parameters, args) &&
          serialized !== undefined &&
          Buffer.byteLength(serialized) <= 16_384 &&
          pgJsonStringsAllowed(args) &&
          ports.stage({
            callId,
            toolName: definition.name,
            arguments: args as Record<string, unknown>,
            waitTimeoutMs: definition.waitTimeoutMs ?? 300_000,
          });
        // 成功只表示请求已暂存；业务回执随恢复输入返回，不在此处伪造客户端结果。
        await ports.recordReceipt(callId, definition.name, staged ? "succeeded" : "failed");
        return {
          content: [
            {
              type: "text" as const,
              text: staged ? "等待客户端回传工具结果。" : "客户端工具参数或本轮调用数超过限制。",
            },
          ],
          details: { pending: staged },
        };
      },
    };
  });
}

export function createPlaygroundClientToolMocks(
  definitions: readonly PlaygroundClientToolDefinition[],
  ports: PlaygroundClientToolPorts,
): readonly AgentTool<TSchema, unknown>[] {
  if (
    definitions.length > 64 ||
    new Set(definitions.map((item) => item.name)).size !== definitions.length
  )
    throw new TypeError("PLAYGROUND_CLIENT_TOOL_INVALID");
  return Object.freeze(
    definitions.map((definition) => {
      const parameters = externalToolSchemaToTypeBox(
        normalizeExternalToolSchema(definition.inputSchema).schema,
      );
      return {
        name: definition.name,
        executionMode: "sequential",
        label: definition.name,
        description: definition.description,
        parameters,
        execute: async (callId: string, args: unknown) => {
          await ports.persistStarted({ callId, toolName: definition.name });
          if (!Value.Check(parameters, args)) {
            await ports.recordReceipt(callId, definition.name, "failed");
            return {
              content: [{ type: "text" as const, text: "客户端工具参数不符合已发布的输入约束。" }],
              details: { error: "CLIENT_TOOL_INVALID_ARGUMENTS" },
            };
          }
          if (ports.origin !== "playground" || !Object.hasOwn(ports.mocks, definition.name)) {
            await ports.recordReceipt(callId, definition.name, "failed");
            return {
              content: [
                { type: "text" as const, text: "Playground 尚未为此客户端工具配置 Mock。" },
              ],
              details: { error: "PLAYGROUND_MOCK_NOT_CONFIGURED" },
            };
          }
          const value = ports.mocks[definition.name];
          const bytes = Buffer.from(`[Playground Mock] ${canonicalJson(value)}`);
          const truncated = bytes.length > 8192;
          const text = new TextDecoder().decode(bytes.subarray(0, 8192), { stream: truncated });
          await ports.recordReceipt(callId, definition.name, "succeeded", "playground_mock");
          return {
            content: [{ type: "text" as const, text }],
            details: {
              executionMode: "mock",
              ...(truncated ? { truncated: true } : { mockResult: value }),
            },
          };
        },
      } satisfies AgentTool<TSchema, unknown>;
    }),
  );
}
