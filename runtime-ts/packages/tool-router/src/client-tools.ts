import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { externalToolSchemaToTypeBox } from "./external-tools.js";

export interface PlaygroundClientToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
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
        definition.inputSchema as Record<string, unknown>,
      );
      return {
        name: definition.name,
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
          const serialized = canonicalJson(value);
          await ports.recordReceipt(callId, definition.name, "succeeded", "playground_mock");
          return {
            content: [{ type: "text" as const, text: `[Playground Mock] ${serialized}` }],
            details: { executionMode: "mock", mockResult: value },
          };
        },
      } satisfies AgentTool<TSchema, unknown>;
    }),
  );
}
