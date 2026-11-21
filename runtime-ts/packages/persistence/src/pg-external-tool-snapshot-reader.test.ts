import { normalizeExternalToolSchema } from "@hoox/domain";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgExternalToolSnapshotReader } from "./pg-external-tool-snapshot-reader.js";

const schema = normalizeExternalToolSchema({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

function poolWithRows(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.startsWith("SELECT tool_version_id")) return { rows };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, query };
}

const row = {
  tool_version_id: "version-a",
  source: "http",
  endpoint: "https://tools.example.invalid/lookup",
  model_tool_name: "http__lookup",
  remote_tool_name: null,
  description: "查询记录",
  input_schema: schema.schema,
  input_schema_digest: schema.digest,
  timeout_ms: 1000,
  max_response_bytes: 512,
  side_effect: "read_only",
  idempotent: true,
  credential_ref: null,
  credential_configured: false,
  http_method: "GET",
  cipher_version: null,
  nonce: null,
  ciphertext: null,
  auth_tag: null,
};

describe("PgExternalToolSnapshotReader", () => {
  it("在 Tenant/Run 事务中读取受限视图中的精确版本", async () => {
    const { pool, query } = poolWithRows([row]);
    const reader = new PgExternalToolSnapshotReader(pool, { decrypt: vi.fn() } as never);
    const snapshots = await reader.read({
      tenantId: "tenant-a",
      runId: "run-a",
      toolVersionIds: ["version-a"],
    });
    expect(snapshots.map((snapshot) => snapshot.tool.toolVersionId)).toEqual(["version-a"]);
    expect(snapshots[0]?.tool.httpMethod).toBe("GET");
    expect(query).toHaveBeenCalledWith("SELECT set_config('app.external_tool_run_id',$1,true)", [
      "run-a",
    ]);
    expect(query.mock.calls.at(-2)?.[1]).toEqual(["tenant-a", "run-a", ["version-a"]]);
  });

  it("视图未返回快照授权版本时失败关闭", async () => {
    const { pool } = poolWithRows([]);
    const reader = new PgExternalToolSnapshotReader(pool, { decrypt: vi.fn() } as never);
    await expect(
      reader.read({ tenantId: "tenant-a", runId: "run-a", toolVersionIds: ["outside"] }),
    ).rejects.toThrow("EXTERNAL_TOOL_SNAPSHOT_UNAVAILABLE");
  });
});
