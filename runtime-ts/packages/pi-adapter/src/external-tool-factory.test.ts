import { describe, expect, it } from "vitest";
import { normalizeExternalToolSchema, type ExternalToolVersion } from "@hoox/domain";
import { createExternalToolFactory } from "./external-tool-factory.js";
const s = normalizeExternalToolSchema({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});
const make = (name: string): ExternalToolVersion => ({
  toolVersionId: name,
  source: "http",
  httpMethod: "POST",
  endpoint: "https://8.8.8.8/api",
  modelToolName: name,
  description: "tool",
  inputSchema: s.schema,
  inputSchemaDigest: s.digest,
  timeoutMs: 1000,
  maxResponseBytes: 32,
  sideEffect: "read_only",
  idempotent: false,
  credentialRef: null,
});
describe("外部工具 Pi 工厂", () => {
  it("按快照名称排序，不接入 Session", () => {
    const create = createExternalToolFactory({
      getCallContext: () => ({
        tenantId: "tenant-fake",
        threadId: "thread-fake",
        runId: "run-fake",
      }),
      persistStarted: async () => {},
      authorizeAndConsume: async () => {},
      transport: { invoke: async () => ({ body: new Uint8Array(), contentType: "text/plain" }) },
      recordReceipt: async () => {},
      requireRecovery: async () => {},
    });
    const first = create([{ tool: make("http__z") }, { tool: make("http__a") }]);
    const reversed = create([{ tool: make("http__a") }, { tool: make("http__z") }]);
    expect(first.map((tool) => tool.name)).toEqual(["http__a", "http__z"]);
    expect(
      first.map((tool) =>
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      ),
    ).toEqual(
      reversed.map((tool) =>
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      ),
    );
  });
});
