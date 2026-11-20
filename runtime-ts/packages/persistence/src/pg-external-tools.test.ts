import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { normalizeExternalToolSchema } from "@hoox/domain";
import { ExternalToolCredentialCipher } from "./external-tool-credential.js";
import { PgExternalToolRegistry } from "./pg-external-tools.js";

function poolFor(query: ReturnType<typeof vi.fn>): Pool {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}
const schema = normalizeExternalToolSchema({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});
const tool = {
  toolVersionId: "version-1",
  source: "mcp" as const,
  endpoint: "https://tools.example/mcp",
  modelToolName: "mcp__server__lookup",
  description: "lookup",
  inputSchema: schema.schema,
  inputSchemaDigest: schema.digest,
  timeoutMs: 5000,
  maxResponseBytes: 4096,
  sideEffect: "read_only" as const,
  idempotent: true,
  credentialRef: "credential-1",
};

describe("外部工具持久化适配器", () => {
  it("发布不可变版本并只写加密凭据", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 1 }));
    const registry = new PgExternalToolRegistry(
      poolFor(query),
      new ExternalToolCredentialCipher("m".repeat(48)),
    );
    await registry.publish({ actorUserId: "admin-user", tool, credential: "secret-value" });
    const sql = query.mock.calls.map(([statement]) => String(statement));
    expect(
      sql.some((statement) => statement.includes("INSERT INTO external_tool_credentials")),
    ).toBe(true);
    expect(
      sql.some(
        (statement) =>
          statement.includes("SELECT") && statement.includes("external_tool_credentials"),
      ),
    ).toBe(false);
    expect(JSON.stringify(query.mock.calls)).not.toContain("secret-value");
  });
  it("撤销追加不可变事实并绑定管理身份", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 1 }));
    const registry = new PgExternalToolRegistry(
      poolFor(query),
      new ExternalToolCredentialCipher("m".repeat(48)),
    );
    await registry.revoke({
      actorUserId: "admin-user",
      toolVersionId: tool.toolVersionId,
      reason: "停止使用",
    });
    const insert = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO external_tool_revocations"),
    );
    expect(insert?.[1]).toEqual([tool.toolVersionId, "停止使用", "admin-user"]);
  });
  it("凭据投影仅读取 configured 标记", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes("SELECT version")
        ? {
            rows: [
              {
                tool_version_id: tool.toolVersionId,
                source: "mcp",
                endpoint: "https://tools.example/mcp",
                model_tool_name: tool.modelToolName,
                description: "lookup",
                input_schema: schema.schema,
                input_schema_digest: schema.digest,
                timeout_ms: 5000,
                max_response_bytes: 4096,
                side_effect: "read_only",
                idempotent: true,
                credential_ref: "credential-1",
                credential_configured: true,
                revoked: false,
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 1 },
    );
    const registry = new PgExternalToolRegistry(
      poolFor(query),
      new ExternalToolCredentialCipher("m".repeat(48)),
    );
    const projection = await registry.getAdminProjection({
      actorUserId: "admin-user",
      toolVersionId: tool.toolVersionId,
    });
    expect(projection?.credentialConfigured).toBe(true);
    expect(JSON.stringify(projection)).not.toContain("ciphertext");
    expect(
      query.mock.calls
        .map(([sql]) => String(sql))
        .some((sql) => sql.includes("external_tool_credentials")),
    ).toBe(false);
  });
});
